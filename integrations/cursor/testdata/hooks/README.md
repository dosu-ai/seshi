# Cursor hook payloads

Hand-written from Cursor's documented hooks (`~/.cursor/hooks.json`, a JSON object on stdin with
`conversation_id`, `generation_id`, `hook_event_name` and `workspace_roots`, plus
`transcript_path` in recent versions). `stop-first-prompt.json` has the empty
`transcript_path` Cursor sends on a conversation's first prompt (F9.2). Not recorded from a live
Cursor: ids and paths are made up.
