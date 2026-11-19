# seshi's Claude Code plugin

The same hooks and `/session-capture` skill `seshi capture install claude-code` writes into
`~/.claude/settings.json`, packaged as a Claude Code plugin (F9.6), for rolling out through a
plugin marketplace or managed settings instead of each person running the installer.

- `hooks/hooks.json`: `seshi hook claude-code <event>` on SessionStart, Stop, SubagentStop,
  PreCompact and SessionEnd. `seshi` must be on the PATH Claude Code runs hooks with.
- `skills/session-capture/SKILL.md`: `/session-capture off|on|status` for the current session.
- `hooks/register.tsx`: the Session Capture chip and `/session-capture` for the Claude desktop
  app's Code tab, which has no status line (F9.4). See below.
- The status line is not part of a plugin; add `"statusLine": {"type": "command", "command":
  "seshi statusline"}` to the settings (managed settings can).

A hook that runs registers Claude Code as installed in seshi's capture state, so the sweep
covers it from then on. `integrations/claude-code/src/capture.test.ts` checks these files match
what the installer writes.

## Installing

At the prompt of a Claude Code terminal session:

```
/plugin install seshi --marketplace dosu-ai/seshi
```

From a shell: `claude plugin install seshi --marketplace dosu-ai/seshi`. In the desktop app,
where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with
`dosu-ai/seshi`, then Add plugin. A plugin installed from a terminal at the user scope loads
in the desktop app's sessions too.

## The desktop chip

The Code tab of the Claude desktop app has no `statusLine` setting, so the plugin's hooks module
puts a chip in the prompt footer, beside the mode labels:

- `Session Capture ◉` while this session is captured, `Session Capture ⏸` when it is not (turned
  off, paused, excluded by a rule), with anything that needs action after a separator
  (`Session Capture ◉ · 3 queued`, `· sign in`). It asks `seshi statusline --json`, so it says
  what the hooks will do, at the start of the session, after each turn and every 30 seconds.
- Clicking it turns capture off or on for this session: `seshi capture off|on --session <id>`,
  as the `/session-capture` skill does. Turning it off retracts what was uploaded (F9.7). A line above the
  prompt says what happened for five seconds.
- `/session-capture` flips it; `/session-capture on`, `off` and `status` set it or say why it is
  as it is.

The chip runs `seshi`. The desktop app does not always see your shell's `PATH`: when the chip says
`seshi not found`, set the plugin's **seshi command** option to the full path `which seshi`
prints. `tests/register.test.tsx` runs under `claude plugin test integrations/claude-code/plugin`;
`tests/capture/capture.test.ts` checks the CLI answers with the fields the chip reads.

