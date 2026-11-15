# seshi's Claude Code plugin

The same hooks and `/seshi` skill `seshi capture install claude-code` writes into
`~/.claude/settings.json`, packaged as a Claude Code plugin (F9.6), for rolling out through a
plugin marketplace or managed settings instead of each person running the installer.

- `hooks/hooks.json`: `seshi hook claude-code <event>` on SessionStart, Stop, SubagentStop,
  PreCompact and SessionEnd. `seshi` must be on the PATH Claude Code runs hooks with.
- `skills/seshi/SKILL.md`: `/seshi capture off|on|status` for the current session.
- The status line is not part of a plugin; add `"statusLine": {"type": "command", "command":
  "seshi statusline"}` to the settings (managed settings can).

A hook that runs registers Claude Code as installed in seshi's capture state, so the sweep
covers it from then on. `integrations/claude-code/src/capture.test.ts` checks these files match
what the installer writes.
