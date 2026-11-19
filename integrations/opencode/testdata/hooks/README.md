# OpenCode capture payloads

What seshi's OpenCode plugin (`src/plugin.ts`) sends to `seshi hook opencode <event>` on stdin:
`SessionStart` when a top-level session is created (`session_id`, `cwd`), and `Command` for
`/session-capture` (`arguments` as OpenCode passes them). On OpenCode 1.x, `Stop` carries the whole
session as `export`, `{info, messages}` read through OpenCode's client, the shape `opencode export`
prints; its tests build it from `../transcripts/opencode-export.opencode.json`. On OpenCode 2.x,
whose plugins cannot read a whole session, `Stop` has no `export`: `session_id`, `cwd`,
`parent_session_id` for a subagent's, and `opencode_channel`, and seshi reads the session from
OpenCode's database. Hand-written in the shape OpenCode
1.18 sends: ids and paths are made up.
