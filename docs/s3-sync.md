# Syncing an S3 bucket

Eval harnesses, ATIF exports and hook uploaders in cloud sandboxes often drop transcripts into
a bucket. An `s3` source polls one (F6); the poller is built into every binary, so the worker
polls it as soon as it is configured:

```toml
[[sources]]
id = "evals"
type = "s3"
url = "s3://eval-runs/harness"            # or r2://bucket/prefix, or file:///path on one machine
credentials = { access_key_id = { env = "EVALS_KEY_ID" }, secret_access_key = { env = "EVALS_SECRET" } }
# role = { arn = "arn:aws:iam::123456789012:role/seshi-read", external_id = { env = "EVALS_EXTERNAL_ID" } }
include = ["**/*.jsonl", "**/*.json"]
path = "{email}/{session}.jsonl"           # optional: what a key says about its session
interval = "5m"
```

A new or changed source applies without a restart: save the file (or a drop-in in
`seshi.d/`, one file per bucket) and send the server `SIGHUP` or `POST /v1/admin/reload`
([config.md](config.md#reloading)). Other sources keep polling and every checkpoint is kept.

Each run lists the prefix and compares every key's ETag and size with the manifest in the
source's checkpoint, so an unchanged object is never read again (F6.2).

- **A new object** is read whole. Its format is the source's `format`, else the object's
  `x-amz-meta-seshi-format`, else `{format}` in `path`, else what detection finds in its start
  (`format = "auto"`, the default). Its session is the object's `x-amz-meta-seshi-session`,
  else `{session}` in `path`, else its key under the prefix.
- **An append-only log that grew** (Claude Code, Codex and other JSONL formats) continues from
  where its session ends: only the tail is read, with a `Range` request, and submitted as a
  chunk (X4.4). The poller first checks that the up to 4 KiB before that point are unchanged.
  Only complete lines are sent; a line still being written waits for the next run.
- **A rewritten object**, a shrunk one, a whole document (ATIF, OpenCode) or a gzip object is
  read whole and sent with `replace`: the pipeline extends the session when the object starts
  with what it holds, and otherwise replaces it, since the poller is the session's original
  writer (F6.3, X4.6).
- **Ownership.** Every session belongs to the source's service account `svc:<id>` and is
  marked `owner_basis: service` (X5.4); the source's `visibility` applies. What the key or the
  object's metadata say about a person (`{email}`, `{username}`, `{name}`, `{git_email}`,
  `{git_name}`, or `x-amz-meta-seshi-email` and the like, `-` for `_`) is recorded as claims in
  the session's metadata (X5.5), never as its owner. `{project}` and `{branch}` (or
  `x-amz-meta-seshi-project`, `-branch`) fill the session's project and branch.
- **Provenance.** The session's metadata records where it came from: `s3://bucket/key` and
  the ETag read. Each envelope's idempotency key is that location and ETag (plus the offset
  for a chunk, X4.7), so a run repeated after a crash is answered from the session. A whole
  object's key also carries the manifest's epoch, which `seshi reprocess` moves on, so an
  object read again on purpose is normalized again rather than answered from the session.
- **Deletions are ignored** (F6.4). Deleting a source object never changes the session it
  produced; its key leaves the manifest at the next complete listing. To remove a session,
  delete it in seshi: the poller will not store it again, even when the object changes.
- **What is not stored** is recorded under `sources/<id>/failed/` with the object's location
  and a code, never its content, and not tried again until the object changes or
  `seshi reprocess` rewinds it (after fixing the source's `format` or `path`, say):
  `unknown_format`, `too_large` (over `limits.max_upload_bytes`, checked before reading, and
  for gzip after unzipping as far as the limit), `not_utf8`, `bad_gzip`,
  `unsupported_encoding` (a `Content-Encoding` other than gzip), `access_denied` (the bucket
  refused that one object with 403), `unreadable` (another final 4xx for that one object,
  such as an archived object), `duplicate_session` (two keys mapping to one session), or the
  pipeline's own codes. A failure to list, throttling, a 5xx, or a network error fails the
  run instead, and the worker retries it with backoff without moving the checkpoint (X4.8).
  A session the filter removed is only counted, and sent whole again once its object grows.
  `seshi sync failed evals` lists them.
- **Large buckets.** A run reads at most 200 changed objects, then hands over to the next run
  at once, resuming the listing after the last key it handled. Every run lists the whole
  prefix; when keys sort by time, `ordered_keys = true` lists only after the key before the
  newest one (which stays watched while it grows).
- **Credentials.** The poller needs `s3:ListBucket` on the prefix and `s3:GetObject`, nothing
  else; with `role` the given keys (or the `AWS_*` environment) need `sts:AssumeRole` on that
  role, and the role's keys are renewed before they expire. `role` applies to `s3://`. Without
  `credentials` the poller reads the standard `AWS_*` / `S3_*` (`R2_*` for `r2://`) variables,
  like the bucket client. A source may not point at seshi's own bucket and prefix, or its own
  folder.
- **Reprocessing.** `seshi reprocess --source evals --since 2026-11-01 --run` forgets the
  objects changed since then, so the next run reads them whole and normalizes them again: one
  whose records did not change answers `unchanged`, one the normalizer now reads differently
  is replaced. Without `--since` the manifest is removed and every object is read again. With
  `ordered_keys` a rewind to a time also lists from the start, since keys say nothing of
  time.

`seshi sync status evals` shows the source's checkpoint, counts and health, and
`seshi sync run evals` polls it once, for cron or to try a new source ([cli.md](cli.md)). Every
field of an `s3` source is in [config.md](config.md#sources).
