# pi capture fixtures

`hooks/` holds the payloads seshi's pi extension (`src/extension.ts`) sends to
`seshi hook pi <event>` on stdin: `session_id`, `transcript_path` and `cwd` from pi's session
manager, and `parent_session`, the parent's session file, for a fork. `sessions/` is a pi agent
folder's `sessions/` in pi 0.99's layout: one folder per working directory, one append-only
JSONL file per session named `<timestamp>_<id>.jsonl`, whose first line is the header
(`version` 3). The fork names its parent in `parentSession`. Hand-written in the shape of a
session recorded against a local fake model: ids, paths and text are made up.
