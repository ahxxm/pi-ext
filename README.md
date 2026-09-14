## Pi extensions

Experimental, to address my own needs:
- `claude-md-system-prompt.ts`: use user-global `~/.claude/CLAUDE.md` as THE system prompt. *Only* enable when these aren't useful: cwd, skills, and project AGENTS.md.
- `writing-style.ts`: remove nudge, summary, etc, the so called "mannered prose" by reusing session context and examine end_turn message. This adds `WTF M/N`("writing to fix") status line, where M is rewritten count, and N is total end_turn messages count.
Known limit: 1. model prior too strong, the rewrite still starts with "Fair" and ends with a redundant summary line; 2. model justifies itself; 3. prefix stability see TODOs 

To install, link to global extension dir, e.g.

```bash
ln -s /home/gentoo/dev/pi-ext/writing-style.ts ~/.pi/agent/extensions/writing-style.ts
```