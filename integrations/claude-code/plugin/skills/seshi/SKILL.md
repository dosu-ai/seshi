---
name: seshi
description: Turn Session Capture off or on for this Claude Code session, or show whether it is being captured. Use when the user runs /seshi, or asks to stop, pause, resume or check session capture or seshi.
---
<!-- written by seshi capture install; seshi capture uninstall removes it -->

# Session Capture

seshi uploads this session to the team's session store as it happens. The user controls it:

- `/seshi capture off`: run `seshi capture off --session`. Nothing more of this session is
  uploaded, and what was already uploaded is retracted from the session store.
- `/seshi capture on`: run `seshi capture on --session`. The session is uploaded again
  from its start.
- `/seshi capture status` or `/seshi`: run `seshi capture status --session` and tell the
  user what it says.

`--session` with no id means this session: seshi reads it from `SESHI_SESSION_ID`, which its
SessionStart hook sets. Report the command's output to the user in one or two sentences. Do not
run any other seshi command unless the user asks for it.
