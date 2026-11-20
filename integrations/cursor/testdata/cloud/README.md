# Cursor Cloud fixtures (`cursor-cloud-api`)

One JSONL line per run, as the poller writes it (`src/cloud/format.ts`). All synthetic: hand-built
in the shapes the Cloud Agents API sent during a trial against the real API, with made-up ids,
prompts, repositories and output.

- `followup.jsonl`: a short run and a follow-up run on the same agent 36 h later.
- `cancelled.jsonl`: a run cancelled while its shell call ran; the call ends with `spawnError`.
- `tools.jsonl`: a file read (no contents, only a `contentBlobId`), a search, an edit, shell output
  over 10 KB (only its tail), a failed shell call, and a Task subagent.
