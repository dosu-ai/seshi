# OpenCode capture payloads

What seshi's OpenCode plugin (`src/plugin.ts`) sends to `seshi hook opencode <event>` on stdin:
`SessionStart` when a top-level session is created (`session_id`, `cwd`), and `Command` for
`/seshi` (`arguments` as OpenCode passes them). `Stop` carries the whole session as `export`,
`{info, messages}` read through OpenCode's client, the shape `opencode export` prints; its tests
build it from `../transcripts/opencode-export.opencode.json`. Hand-written in the shape OpenCode
1.18 sends: ids and paths are made up.
