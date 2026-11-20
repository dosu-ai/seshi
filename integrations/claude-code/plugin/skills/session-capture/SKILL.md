---
name: session-capture
description: Turn Session Capture off or on for this session, show whether it is being captured, or share it with the team (or unshare it). Use when the user runs /session-capture or $session-capture, or asks to stop, pause, resume or check session capture or seshi, or to share or unshare this session.
---
<!-- written by seshi capture install; seshi capture uninstall removes it -->

# Session Capture

seshi uploads this session to the team's session store as it happens. The user controls it.
In each command, `<agent>` is the agent you are: `claude-code` in Claude Code, `codex` in
Codex, `cursor` in Cursor.

- Off: run `seshi capture off --session --agent <agent>`. Nothing more of this session is
  uploaded, and what was already uploaded is retracted from the session store.
- On: run `seshi capture on --session --agent <agent>`. The session is uploaded again from
  its start.
- Status, or no word after the command: run `seshi capture status --session --agent <agent>`
  and tell the user what it says.
- Share (or "share this session"): run `seshi share --session --agent <agent>`. Every
  member of the team may then read the session, and its subagents'.
- Unshare: run `seshi unshare --session --agent <agent>`. Only its owner (and admins) may
  read it again.

`--session` with no id means this session. seshi knows it in Claude Code (`SESHI_SESSION_ID`,
which its SessionStart hook sets) and in Codex (`CODEX_THREAD_ID`). Elsewhere it is the one
session of that agent seen in the current folder in the past day, so in a session that has not
finished a turn yet seshi may not know it: say so. When seshi answers that more than one ran
here, show the user the sessions it lists and ask which, then run the command again with
`--session <id>`.

In Codex and Cursor, when the user's whole message is `$session-capture` with `off`, `on`,
`status`, `share` or `unshare` after it (`/session-capture …` in Cursor), seshi's own hook has
already done it before you see the message, and shown the user the result: do not run it again.
After off, on or status, run `seshi capture status --session --agent <agent>`, which only
reads, and confirm in one sentence; after share or unshare, run nothing: the user has seshi's
answer (shared, or why not), so say in one sentence that seshi's hook took the request, without
saying whether it worked.

Share and unshare change the session in the session store, so they need the network. Until its
first turn has finished, seshi has not uploaded the session and says so: tell the user to ask
again after this turn. Off and on write seshi's state folder (`~/.local/state/seshi`, outside
the workspace). A sandbox blocks both. In a sandbox, run the command with escalated permissions,
saying it changes Session Capture for this session (or who may read it), and let the user
approve it. If that is refused, tell the user to type the command as a message of its own
(`$session-capture off`, `$session-capture share`, … in Codex; `/session-capture off`, `/session-capture share`, … in
Cursor), or to run it in a terminal.

Report the command's output to the user in one or two sentences. Do not run any other seshi
command unless the user asks for it.
