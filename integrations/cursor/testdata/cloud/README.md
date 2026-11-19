# Cursor Cloud fixtures (`cursor-cloud-api`)

One JSONL line per run, as the poller writes it (`src/cloud/format.ts`).

- `followup.jsonl`: a short run and a follow-up run on the same agent ~36 h later, captured from the
  Cloud Agents API during the polling trial (18–19 Nov 2026). Stream deltas the format leaves out are
  already dropped.
- `cancelled.jsonl`: a run cancelled about a minute in; its shell call ends with `spawnError`.
- `tools.jsonl`: hand-written, in the shapes seen on a real cloud agent: a file read (no contents,
  only a `contentBlobId`), a search, an edit, shell output over 10 KB (only its tail), a failed shell
  call, and a Task subagent.
