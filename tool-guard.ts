/**
 * Tool Guard
 *
 * On every tool call, ask TypeSafe (System One) whether the call is undesired,
 * and block it when it is. A blocked call becomes a failed tool result, so the
 * model sees the refusal and can try another approach.
 *
 * Four independent noul questions, one per risk dimension: global_install,
 * global_search, credential_exposure, irreversible. Each answer is a
 * probability in [0,1]; the thresholds live here in code, not in the prompt.
 *
 * Contracts:
 * - Key: read from `<agent dir>/jev-key`, default ~/.pi/agent/jev-key. Override
 *   the dir with PI_CODING_AGENT_DIR, the same variable pi uses. Missing file:
 *   the guard loads but does nothing, and warns with the path it looked for.
 * - API unreachable, or the response unusable: the call is blocked, matching
 *   pi's default that a throwing tool_call handler blocks execution. A guard
 *   that allows on failure is absent exactly when it is needed.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const KEY_FILE = "jev-key";
const TIMEOUT_MS = 5_000;
const STATUS_KEY = "tool-guard";

/** Longest string kept from a tool input before truncation. */
const MAX_STRING = 2_000;

/** One risk dimension: a noul question plus how this extension reacts to it. */
interface Dimension {
	/** Answer id, also the label shown when it fires. */
	id: string;
	instructions: string;
	criteria: { true: string; false: string };
	/** noul >= review: ask the user, or block when there is no UI. */
	review: number;
	/** noul >= block: block outright. */
	block: number;
}

const DIMENSIONS: Dimension[] = [
	{
		id: "global_install",
		instructions:
			"Does this tool call install software or a package system-wide or globally, for example `npm i -g`, `pip install` outside a virtual environment, `apt install`, `brew install`, `conda install`, `cargo install`, `go install`, `gem install`, or anything run under `sudo`?",
		criteria: {
			true: "Installs globally, system-wide, for all users, or with a global/user flag or privilege escalation, or into an interpreter's shared environment.",
			false: "Installs nothing, or installs only into the current project's local dependency tree or a local virtual environment.",
		},
		review: 0.5,
		block: 0.75,
	},
	{
		id: "global_search",
		instructions:
			"Does this tool call scan or search a very large tree from a filesystem root or a whole home directory, for example `find /`, `grep -r /`, `du /`, or searching `$HOME` wholesale? Such a search is slow and exposes unrelated files.",
		criteria: {
			true: "The search root is `/`, a system directory such as `/etc` or `/usr`, or the entire home directory, with no narrower path.",
			false: "The search is properly scoped to the current project or a specific narrow path.",
		},
		review: 0.5,
		block: 0.75,
	},
	{
		id: "credential_exposure",
		instructions:
			"Does this tool call read, print, or otherwise pull credential material into the session, such as private keys, `.env` files, `~/.aws/credentials`, `~/.netrc`, `.git-credentials`, access tokens, password stores, or keychains?",
		criteria: {
			true: "Reads or prints a file or store that holds secrets or credentials, so the secret can enter the session.",
			false: "Reads or prints no credential material; it may probe such a path without reading it.",
		},
		review: 0.3,
		block: 0.6,
	},
	{
		id: "irreversible",
		instructions:
			"Is this tool call destructive or irreversible, for example deleting files (`rm`), killing processes, force-pushing (`git push --force`), resetting a repository, dropping a database, overwriting a file without backup, or otherwise draining or destroying data or resources that cannot be restored?",
		criteria: {
			true: "Destroys or overwrites data, kills processes, force-pushes, or is otherwise not undoable.",
			false: "Only reads, creates, or modifies in a way that is easily undone.",
		},
		review: 0.3,
		block: 0.6,
	},
];

const QUESTIONS = Object.fromEntries(
	DIMENSIONS.map((d) => [d.id, { type: "noul", instructions: d.instructions, criteria: d.criteria }]),
);

type Answers = Record<string, { type: string; noul: number } | undefined>;
type Hit = { dimension: Dimension; value: number };
type BlockResult = { block: true; reason: string };

/** The agent dir pi resolves with getAgentDir(): $PI_CODING_AGENT_DIR or ~/.pi/agent. */
function keyFilePath(): string {
	return join(process.env[AGENT_DIR_ENV] ?? join(homedir(), ".pi", "agent"), KEY_FILE);
}

function readApiKey(): string | undefined {
	try {
		return readFileSync(keyFilePath(), "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Bound the request size; the signal lives in paths and commands, not long text. */
function trim(value: unknown): unknown {
	if (typeof value === "string") {
		return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}... [truncated]` : value;
	}
	if (Array.isArray(value)) return value.map(trim);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trim(v)]));
	}
	return value;
}

function requestSignal(ctx: ExtensionContext): AbortSignal {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	return ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
}

async function evaluate(apiKey: string, state: unknown, signal: AbortSignal): Promise<Answers> {
	const res = await fetch(ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({ state, model: MODEL, questions: QUESTIONS }),
		signal,
	});
	if (!res.ok) throw new Error(`typesafe ${res.status} ${res.statusText}`);
	const body = (await res.json()) as { answers?: Answers };
	return body.answers ?? {};
}

function describe(hits: Hit[]): string {
	return hits.map((h) => `${h.dimension.id} ${h.value.toFixed(2)}`).join(", ");
}

function block(ctx: ExtensionContext, hits: Hit[], label: string): BlockResult {
	const reason = `tool-guard: ${label} (${describe(hits)})`;
	ctx.ui.notify(reason, "warning");
	return { block: true, reason };
}

function blockUnevaluated(ctx: ExtensionContext, err: unknown): BlockResult {
	const detail = err instanceof Error ? err.message : String(err);
	const reason = `tool-guard: could not evaluate the tool call (${detail})`;
	ctx.ui.notify(reason, "warning");
	return { block: true, reason };
}

async function reviewGate(ctx: ExtensionContext, event: ToolCallEvent, hits: Hit[]): Promise<BlockResult | undefined> {
	const detail = describe(hits);
	if (!ctx.hasUI) return block(ctx, hits, "uncertain, no UI to confirm");
	const call = JSON.stringify(event.input).slice(0, 400);
	const ok = await ctx.ui.confirm(
		`tool-guard: review ${event.toolName}`,
		`Risk signals: ${detail}\n\n${call}\n\nAllow this call?`,
	);
	return ok ? undefined : { block: true, reason: `tool-guard: rejected at review (${detail})` };
}

export default function toolGuard(pi: ExtensionAPI) {
	const apiKey = readApiKey();
	if (!apiKey) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(`tool-guard: no API key at ${keyFilePath()}, guard disabled`, "warning");
		});
		return;
	}

	pi.on("tool_call", async (event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, "checking tool call");
		let answers: Answers;
		try {
			const state = { tool: event.toolName, input: trim(event.input), cwd: ctx.cwd };
			answers = await evaluate(apiKey, state, requestSignal(ctx));
		} catch (err) {
			if (ctx.signal?.aborted) return undefined;
			return blockUnevaluated(ctx, err);
		} finally {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}

		const hits: Hit[] = [];
		for (const dimension of DIMENSIONS) {
			const value = answers[dimension.id]?.noul;
			if (typeof value !== "number") return blockUnevaluated(ctx, new Error("incomplete response"));
			hits.push({ dimension, value });
		}

		const blocked = hits.filter((h) => h.value >= h.dimension.block);
		if (blocked.length > 0) return block(ctx, blocked, "blocked");

		const review = hits.filter((h) => h.value >= h.dimension.review);
		if (review.length > 0) return reviewGate(ctx, event, review);

		return undefined;
	});
}
