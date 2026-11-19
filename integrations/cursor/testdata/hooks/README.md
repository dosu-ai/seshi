# Cursor hook payloads

Recorded on 19 Nov 2026 from the Cursor CLI (`agent`, 2026.11.13 and, after it updated itself,
2026.11.19) running against a throwaway repository whose `.cursor/hooks.json` logged every hook's
stdin. Conversation ids, tool ids, paths, the account's email and the file's API key were
changed; nothing else was, except where said below.

- `session-1/`: one agent turn that ran a shell command, read a file, read two files in
  parallel, edited one (a StrReplace), called an MCP tool (`probe_echo` on a local stdio
  server), ran `seq` with a large output, read a file too large for Cursor, and ran a command that
  failed. `hooks.jsonl` holds the hooks seshi installs, in the order they ran (`{event,
  payload}` per line); `transcript.jsonl` is Cursor's agent transcript of the same turn. The
  recorded command was `seq 1 200000` (1.4 MB of output, which Cursor passed whole); it is
  `seq 1 8000` here, with its output to match. The 100,000 characters `beforeReadFile` gave of
  the large file are cut to 40,000.
- `session-2/`: Glob, Grep, two shell commands in parallel (the slower one first in the
  transcript, its result second), Write of a new file, Delete and Task (both through
  `CallDynamicTool`), and `printenv HOME`. The Task ran a subagent: its hooks carry the
  subagent's own conversation id, and its transcript is `subagent.jsonl`.
- `sessionEnd.json`: session-1's `sessionEnd`.
- `beforeSubmitPrompt.json`: the first prompt of an interactive run; `transcript_path` is
  `null`, as on every hook before the transcript is written (F9.2).
- `stop.json`, `stop-first-prompt.json`: not recorded. `stop` did not fire in the CLI (`agent -p`
  fires `sessionEnd`; an interactive run under `script` never reached the model). They are
  session-1's `sessionEnd` with the fields Cursor's docs give `stop` (`status`, `loop_count`), and
  the first with the `null` transcript path the first prompt has.

What surprised: see `docs/capture.md#tool-results-in-cursor`.
