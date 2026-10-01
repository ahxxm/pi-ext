/**
 * Writing style guard.
 *
 * On message_end (assistant, stopReason "stop"), rewrites the final message
 * when it violates the writing style rules from the system prompt:
 *   1. Regex gate. Fast, FP/FN tradeoffs, update over time.
 *   2. Judge call: same model, full session context, cached prefix.
 *   3. Rewrite call: replaces the text of the message in place, keeping its
 *      thinking blocks.
 *
 * Extra call usage is ignored.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai";

const STATUS_KEY = "writing-style";

const KEYWORD_PATTERNS: RegExp[] = [
	/\bcaveat\b/i,
	/\bconcede\b/i,
	/\bhonestly\b/i,
	/\bverdict\b/i,
	/\bhygiene\b/i,
	/\bload-bearing\b/i,
	/\byte-identical\b/i,
	/\bbyte-exact\b/i,
	/\bcaution\b/i,
	/\bchallenge\b/i,
	/\bsay the word\b/i,
	/\bwant me\b/i,
	/\bpush back\b/i,
	/\bcharacteriz\b/i,
	/\bseam\b/i,
	/\byour call\b/i,
	/\bgate\b/i,
	/\bimprecision\b/i,
	/\btell me if\b/i,
	/\b直白\b/i,
	/\b弄混\b/i,
	/\b给我\b/i,
	/\b炸\b/i,
	/\b坑\b/i,
	/\b—\b/i,
];

const ENDING_PATTERNS: RegExp[] = [
	/\bso\b/i,
	/\bworth\b/i,
	/\bnet\b/i,
	/\bone\b/i,
	/\bin short\b/i,
	/\b顺带\b/i,
	/\b所以\b/i,
	/\b你告诉\b/i,
	/\b要不要\b/i,
];

const PREFERENCE = `Language style, the user appreciates Orwell's writing style in <Politics and English Language>, Chekhov's in <The Bishop>(Архиерей), and 汪曾祺、王小波 in general, you should always respond in such restraint writing:
• Use plain, brief, conversational language. Choose concrete, specific words; make every sentence carry information; minimize metaphor.
• Each word must earn its place. Cut filler, padding and all mannered prose, for example, cut "So the short version is" so that it becomes a shorter version, replace almost all metaphors with plain language. Keep only the words that serve the user.
Say each point exactly once, in consistent wording. End immediately when the content is complete.
• Write in active voice: own statements, say who does what.
• Replace em dashes (—) with a comma, colon, or sentence restructure. 
• Use standard punctuation marks.
• Minimal formatting with careful restraint: plain text and links by default. Only consider bold, bullet points, and headings when partitioning long responses.`

const JUDGE_PROMPT = `Review last end_turn assistant message against the writing style rules.
Judge strictly: does it contain distracting nudges, forced unnatural caveats, unnecessary summary, completely removable last line that doesn't affect answer completeness, or any other violations of the required style, such that we should improve the writing accordingly?
Writing style full requirements:
"""
${PREFERENCE}
"""
Answer with exactly one word: YES / NO`;

const REWRITE_PROMPT = `The last end_turn assistant message above violates the writing style requirements.
Rewrite it, strictly follow writing style requirements: preserve fact and opinion, every word in response must earn its place.
Writing style full requirements:
"""
${PREFERENCE}
"""
Output only the rewritten message text, with no preamble or commentary.`;

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

/**
 * Rebuild the Context of pi's main request so the provider prompt cache covers
 * the shared prefix.
 *
 * Source of truth: `streamAssistantResponse` in agent-loop.ts (transformContext,
 * convertToLlm, normalizeContext) over `sessionManager.buildSessionProjection()`.
 * This skips transformContext's extension handlers and reproduces only its
 * forced-prompt projection.
 *
 * - messages: the projection's non-system messages, plus the message
 *   `message_end` is about to persist, converted as pi converts them.
 * - systemPrompt: `ctx.getSystemPrompt()`, the only place a forced prompt shows.
 * - tools: the transcript's own declarations, so constrained-sampling flags
 *   survive and the provider serializes them as it does for the main request.
 *
 * Fragile reconstruction: it holds only while that pipeline holds. After a pi
 * upgrade, compare this Context against a real request's payload.
 */
function buildRequestContext(ctx: ExtensionContext, msg: AssistantMessage): Context {
	const projection = ctx.sessionManager.buildSessionProjection();
	return {
		systemPrompt: ctx.getSystemPrompt(),
		messages: convertToLlm([...projection.messages.filter((m) => m.role !== "system"), msg]),
		tools: getCurrentTools(projection.messages),
	};
}

enum Violation {
	FAST = "fast",
	KEYWORD = "keyword",
}

function findViolation(text: string): Violation | undefined {
	// fast rewrite: common summary line, condescending opening, excessive bold markers
	// slower rewrite: keyword match
	const lastLine = text.trimEnd().split("\n").at(-1)?.trimStart() ?? "";
	const lower = text.toLowerCase();
	const fast =
		ENDING_PATTERNS.some((p) => p.test(lastLine))
		|| lower.startsWith("fair")
		|| lower.startsWith("correct")
		|| text.split("**").length - 1 >= 10; // >=5 bold pairs
	if (fast) return Violation.FAST;
	return KEYWORD_PATTERNS.some((p) => p.test(text)) ? Violation.KEYWORD : undefined;
}

function userMessage(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

const stats = { good: 0, fixed: 0 };

function updateCounter(ctx: ExtensionContext): void {
	const total = stats.good + stats.fixed;
	ctx.ui.setStatus("wtf", `WTF ${stats.fixed}/${total}`);
}

function countGood(ctx: ExtensionContext): void {
	stats.good += 1;
	updateCounter(ctx);
}

async function judge(
	ctx: ExtensionContext,
	model: NonNullable<ExtensionContext["model"]>,
	base: ReturnType<typeof buildRequestContext>,
): Promise<Message[] | undefined> {
	ctx.ui.setStatus(STATUS_KEY, "judging style");
	const judgeMessages = [...base.messages, userMessage(JUDGE_PROMPT)];
	const verdict = await ctx.modelRegistry.complete(
		model,
		{ systemPrompt: base.systemPrompt, messages: judgeMessages, tools: base.tools },
		{ signal: ctx.signal, sessionId: ctx.sessionManager.getSessionId() },
	);
	if (!/^YES\b/.test(extractText(verdict).trim().toUpperCase())) return undefined;
	return [...judgeMessages, verdict];
}

async function rewrite(
	ctx: ExtensionContext,
	model: NonNullable<ExtensionContext["model"]>,
	base: ReturnType<typeof buildRequestContext>,
	prefix: Message[],
): Promise<string | undefined> {
	ctx.ui.setStatus(STATUS_KEY, "rewriting");
	const response = await ctx.modelRegistry.complete(
		model,
		{ systemPrompt: base.systemPrompt, messages: [...prefix, userMessage(REWRITE_PROMPT)], tools: base.tools },
		{ signal: ctx.signal, sessionId: ctx.sessionManager.getSessionId() },
	);
	return extractText(response).trim() || undefined;
}

/**
 * Replace the message text, keeping every thinking block: their signatures are
 * the provider's replay data. The rewritten text takes over the first text
 * block's signature, which identifies the replayed message item.
 */
export function rewriteMessage(msg: AssistantMessage, text: string): AssistantMessage {
	const firstText = msg.content.find((c) => c.type === "text");
	return {
		...msg,
		content: [
			...msg.content.filter((c) => c.type !== "text"),
			{
				type: "text",
				text,
				...(firstText?.textSignature === undefined ? {} : { textSignature: firstText.textSignature }),
			},
		],
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		stats.good = 0;
		stats.fixed = 0;
		updateCounter(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (!ctx.model) return;
		const msg = event.message;
		if (msg.role !== "assistant" || msg.stopReason !== "stop") return;

		const text = extractText(msg);
		const violation = findViolation(text);
		if (!violation) {
			stats.good += 1;
			updateCounter(ctx);
			return;
		}

		const model = ctx.model;
		const base = buildRequestContext(ctx, msg);

		try {
			const prefix = violation === Violation.FAST ? base.messages : await judge(ctx, model, base);
			if (!prefix) {
				countGood(ctx);
				return;
			}

			const rewritten = await rewrite(ctx, model, base, prefix);
			if (!rewritten) {
				countGood(ctx);
				return;
			}

			stats.fixed += 1;
			updateCounter(ctx);

			ctx.ui.notify("writing-style: rewrote final message", "info");
			return { message: rewriteMessage(msg, rewritten) };
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			if (!ctx.signal?.aborted) {
				ctx.ui.notify(`writing-style: ${detail}`, "warning");
			}
			return;
		} finally {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});
}
