# seshi Session Capture for Cursor

Shows in Cursor's status bar whether [seshi](https://github.com/dosu-ai/sessiondb) captures the
chat you have open: `Session Capture ◉` while it does, `Session Capture ⏸` when it does not,
with anything that needs action after it (`sign in`, `upload failing`). Click it to turn capture
off or on for that chat.

It needs seshi, with Cursor's capture installed (`seshi capture install cursor`). It finds the
seshi program in Cursor's hooks; set **seshi.command** if it cannot.

**Which chat.** Cursor has no API for the chat in view. The extension asks Cursor, through an
undocumented command, which chats are open, and matches the active chat tab to them. When that
is not possible it shows the chat you last sent a message in, and asks which chat before a click
changes anything. Turn **seshi.useCursorInternals** off to use only the last chat.

**Where.** Cursor's editor windows. The Agents Window does not show extensions' status bar
items. In the Cursor CLI, seshi sets the CLI's own status line instead, and `/session-capture off`,
`/session-capture on` and `/session-capture` work in any Cursor chat.

MIT licensed.
