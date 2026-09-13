/**
 * Writing style guard.
 *
 * On message_end (assistant, stopReason "stop"), rewrites the final message
 * when it violates the writing style rules from the system prompt:
 *   1. Regex gate. Fast, FP/FN tradeoffs, update over time.
 *   2. Judge call: same model, full session context, cached prefix.
 *   3. Rewrite call: replaces the message in place.
 *
 * Extra call usage is ignored.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message, Tool } from "@earendil-works/pi-ai";

const STATUS_KEY = "writing-style";

const KEYWORD_PATTERNS: RegExp[] = [
	/\bcaveat\b/i,
	/\bhygiene\b/i,
	/\bload-bearing\b/i,
	/\bcaution\b/i,
	/\bsay the word\b/i,
	/\bwant me to\b/i,
	/\bpush back\b/i,
	/\btell me if you want\b/i,
	/\b顺带\b/i,
	/\b弄混\b/i,
	/\b给我\b/i,
	/\b—\b/i,
];

const ENDING_PATTERNS: RegExp[] = [
	/\bso\b/i,
	/\bworth\b/i,
	/\bnet\b/i,
	/\bone\b/i,
	/\bin short\b/i,
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

/** The subset of a tool definition that providers serialize. */
interface ToolScaffold {
	name: string;
	description: string;
	parameters: Tool["parameters"];
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

/**
 * Rebuild the Context of pi's main request so the provider prompt cache
 * covers the shared prefix: same system prompt, tools in agent state order
 * with registry schemas, and the branch converted like the agent converts it.
 * Source of truth(Fragile reconstruction): pi repo `agent-loop.ts`, llmContext.
 */
function buildRequestContext(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): { systemPrompt: string; messages: Message[]; tools: ToolScaffold[] } {
	const allTools = pi.getAllTools();
	const tools: ToolScaffold[] = pi
		.getActiveTools()
		.map((name) => allTools.find((t) => t.name === name))
		.filter((t) => t !== undefined)
		.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

	const messages = convertToLlm(
		ctx.sessionManager
			.getBranch()
			.filter((e) => e.type === "message")
			.map((e) => e.message),
	);

	return { systemPrompt: ctx.getSystemPrompt(), messages, tools };
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
	msg: AssistantMessage,
): Promise<Message[] | undefined> {
	ctx.ui.setStatus(STATUS_KEY, "judging style");
	const judgeMessages = [...base.messages, msg, userMessage(JUDGE_PROMPT)];
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

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		stats.good = 0;
		stats.fixed = 0;
		updateCounter(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		const msg = event.message;
		if (msg.role !== "assistant" || msg.stopReason !== "stop") return;

		const text = extractText(msg);
		// Model self-signals a violation: "net/so" marker on the last line skips
		// the regex gate and the judge call.
		const lastLine = text.trimEnd().split("\n").at(-1)?.trimStart() ?? "";
		const fastYes = ENDING_PATTERNS.find((p) => p.test(lastLine))?.source || text.toLowerCase().startsWith("fair") || text.toLowerCase().startsWith("correct");
		const keywordHit = KEYWORD_PATTERNS.find((p) => p.test(text))?.source;
		if (!fastYes && !keywordHit) {
			stats.good += 1;
			updateCounter(ctx);
			return;
		}
		if (!ctx.model) return;

		const model = ctx.model;
		const base = buildRequestContext(pi, ctx);

		try {
			const prefix = fastYes ? [...base.messages, msg] : await judge(ctx, model, base, msg);
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
			return {
				message: {
					...msg,
					content: [{ type: "text" as const, text: rewritten }],
				},
			};
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
