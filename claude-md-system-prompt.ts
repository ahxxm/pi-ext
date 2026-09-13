import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Use ~/.claude/CLAUDE.md as the effective system prompt, stripped of pi's
 * appended context (AGENTS.md, skills, cwd, pi-docs block).
 * - AGENTS.md: resource-loader.ts contains many variants, as well as the
 * project's, all replaced by single GLOBAL_RULES file.
 * - context files: wrapped as <project_context />
 * - cwd line: 'Current working directory: ...'
 * - tool description `promptGuidelines`: texts largely still exist in API
 * call, just no longer in the system prompt.
 *
 * The file is read fresh before every prompt, so editing it takes effect on
 * the next prompt (a `/reload` is not required to test changes).
 */
const GLOBAL_RULES = join(homedir(), ".claude", "CLAUDE.md");

export default function claudeMdSystemPrompt(pi: ExtensionAPI) {
        pi.on("before_agent_start", async () => {
                try {
                        const text = await readFile(GLOBAL_RULES, "utf-8");
                        return { systemPrompt: text };
                } catch {
                        // File missing or unreadable: keep pi's default system prompt.
                        return undefined;
                }
        });
}