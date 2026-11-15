# Claude Code hook payloads

Hand-written from Claude Code's documented hook input (the JSON object each hook command gets on
stdin: `session_id`, `transcript_path`, `cwd`, `hook_event_name` and the event's own fields) and
its documented status line input. Not recorded from a live Claude Code: ids and paths are made
up. `SubagentStop.json` carries `agent_id` and `agent_transcript_path`, which recent versions
add; `SubagentStop-older.json` is the shape without them.
