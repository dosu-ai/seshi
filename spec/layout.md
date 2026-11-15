# The seshi layout

The object layout is the contract. Anything that can read objects under a prefix (seshi's
own routes, another service, `aws s3 sync`, a reader in another language) can read a seshi
store. The stored objects other languages read are defined by JSON Schemas in
[`schemas/`](schemas/) (X3.10); ts/model's types are generated from them
(`bun run types`), and [`testdata/objects/`](testdata/objects/) holds conformance examples
every reader should parse. The writer is the `seshi` binary (`seshi serve`, or local mode);
any other writer must follow the rules below.

```
<prefix>/
  seshi.json                                              layout marker (X1.4), written once
  tokens/<id>.json                                        hashed seshi tokens (X5.9)
  sources/<source_id>/
    checkpoint.json                                       a poller's cursor (X7)
    dropped/<stamp>-<key_hash>.json                       an envelope model review dropped (X6.4)
    failed/<stamp>-<key_hash>.json                        an envelope that failed (X4.8)
  worker/heartbeat.json                                   the worker's last run (X7.5)
  assembly/pending/<archive_id>                           a session with spans to assemble (X7.4)
  owners/<owner>/
    .probe                                                a writer's write check
    sessions/<archive_id>/
      metadata.json                                       the session's pointer (mutable)
      trace.<content_hash>.json.gz                        seshi/trace/1, one per distinct content
      raw.<n>.<jsonl|json>.gz                             the redacted transcript (until 04, X6.3)
      spans/<trace_id>-<span_id>.json                     normalized, redacted span records (F4)
      review/<n>.json                                     model review decisions (F3)
    changes/
      <stamp>-<content_hash>.json                         a publish
      <stamp>-tombstone.json                              a tombstone
      <stamp>-visibility.json                             a visibility change
```

The layout's own objects are exactly the keys named above; a reader ignores anything else
under the prefix, and a writer never puts anything under these folders that is not. Readers
of sessions need only `owners/`; the other folders are the server's working state, read
through the API (X5.6).

## Identifiers

- **owner** is one path segment (`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`): the name a credential
  is bound to, usually a person. One owner's objects never reference another's.
- **archive_id** = `sha256(owner + "\n" + agent + "\n" + session_id)` (hex). Deterministic, so
  every upload of one session lands in one directory; derived, so no native id or path
  appears in a key.
- **content_hash** = `sha256(source + "\n" + body)` where `body` joins the trace's events as
  `role + "\x1f" + text` with `"\x1e"`. Timestamps are outside the hash, so a re-export of the
  same conversation dedupes. A continuation hashes `source + "@" + from_record` in place of
  `source`. Events are derived from each record's role, text and tool fields only, never from
  the fields `seshi/trace/1` added to trajectory-v1, so hashes are what sessiondb computed.
  The derivation is in [`packages/ts/model/src/parse.ts`](../packages/ts/model/src/parse.ts),
  pinned by the goldens in [`testdata/goldens/`](testdata/goldens/).
- **stamp** in a change or record key is RFC 3339 UTC to the millisecond with `-` and `:`
  removed (`20261021T210405.123Z`), so keys sort by time and are valid file names everywhere.
- **source_id** is a configured source's id, or `upload` for hooks and the CLI: words of
  lowercase letters and digits joined by single `-`.
- **key_hash** is the first 24 hex characters of `sha256(idempotency_key)`: the idempotency key
  may hold object keys or session ids, so it never appears in a key itself.

## Conditional writes (X6.5)

Mutable objects are written conditionally, so two writers (API instances, a worker, a second
worker by mistake) never silently lose each other's update:

| Object | Write |
|---|---|
| `seshi.json` | Created with `If-None-Match: *`; a later org claim with `If-Match` |
| `metadata.json` | `If-None-Match: *` for a new session, else `If-Match` the ETag read; on `412` re-read and retry |
| `sources/<id>/checkpoint.json` | `If-Match` (first one `If-None-Match`); on `412` the worker discards its run (X7.3) |
| `tokens/<id>.json` | Created with `If-None-Match: *`; changes (revoke) with `If-Match` |
| `assembly/pending/<archive_id>` | Touched unconditionally; deleted with `If-Match`, so a batch that arrived meanwhile keeps it |
| `review/<n>.json`, drop and failure records | Created with `If-None-Match: *` |
| trace objects | Content-addressed; created with `If-None-Match: *`, so the first object for a hash wins |
| change entries, raw parts | Time-keyed or part-numbered; written plainly |

S3 and R2 honour `If-Match` and `If-None-Match` on PUT. The folder store (`file://`) emulates
them with a lock file per key, taken with an exclusive create; that is safe between processes
on one machine only, and its ETag is the MD5 of the object, as S3's single-part ETag is.

## Objects

### `seshi.json` — `seshi/layout/1` ([schema](schemas/layout.schema.json))

Written once, by the first writer to use the prefix.

```json
{ "schema": "seshi/layout/1", "trace_schema": "seshi/trace/1",
  "deployment_id": "prod-eu", "org": "acme",
  "created_at": "2026-11-14T09:00:00.000Z", "created_by": "seshi/0.9.0" }
```

`trace_schema` is the canonical format of every trace under the prefix. `deployment_id` is
config's `store.deployment_id`, or one the first writer generated; `org` is recorded the first
time a config names one. A server whose config names another deployment or org refuses to
start (X1.4), as does one that finds a marker schema or trace format it cannot read.

A prefix that holds sessiondb's marker, `sessionstorage.json` (`sessionstorage/layout/1`),
is refused: its traces are `letta` or `otlp` objects beside raw parts, and there is no
migration (X1.5). Point seshi at a new prefix.

### `trace.<content_hash>.json.gz` — `seshi/trace/1` ([schema](schemas/trace.schema.json))

The one canonical stored trace (X6.2). Immutable and content-addressed: if the key exists, a
later publish does not overwrite it, whatever differs outside the hash. Evolved from
trajectory-v1: its records are trajectory-v1 records with optional fields for what raw used to
keep (X6.3), and the trace adds the session's LLM calls and where it came from.

```jsonc
{
  "schema": "seshi/trace/1",
  "content_hash": "…",
  "source": "claude-code",          // what normalized it (the meta record's source)
  "agent": "claude-code",           // the format it was filed under; the archive id derives from it
  "project": "github.com/acme/widget",
  "branch": "main",
  "session_id": "…",
  "started_at": "2026-09-01T00:00:00.000Z",
  "ended_at": "2026-09-01T00:00:07.000Z",
  "records": [
    { "role": "meta", "source": "claude-code", "cwd": "/repo/app", "agent_version": "2.1.0" },
    { "role": "user", "content": "…", "timestamp": "…", "id": "u1" },
    { "role": "assistant", "content": null, "timestamp": "…", "id": "msg_01…",
      "llm_call": "call_1",
      "tool_calls": [{ "id": "toolu_…", "name": "Read", "args": "{\"file_path\":…}" }] },
    { "role": "tool", "tool_call_id": "toolu_…", "content": "…", "ok": true, "timestamp": "…",
      "duration_ms": 31, "withheld": "sensitive-file" }
  ],
  "events": [
    { "index": 0, "role": "user", "text": "…", "timestamp": "…" },
    { "index": 1, "role": "tool_call", "text": "Read {\"file_path\":…}", "timestamp": "…",
      "tool_name": "Read", "tool_call_id": "toolu_…" }
  ],
  "metadata": {
    "cwd": "/repo/app", "git_branch": "main", "model": "…",
    "parent_session_id": "…",
    "continuation": { "from_record": 6, "prefix_sha256": "…" },
    "normalizer": { "name": "@dosu/sessiondb", "version": "0.9.0+trajectory.0.3.0" }
  },
  "llm_calls": [
    { "id": "call_1", "model": "claude-sonnet-4-5", "provider": "anthropic",
      "started_at": "…", "ended_at": "…",
      "usage": { "input_tokens": 1200, "output_tokens": 80, "cache_read_input_tokens": 9000 },
      "stop_reason": "tool_use", "request_id": "msg_01…" }
  ],
  "provenance": { "source": "hook", "source_id": "upload", "format": "claude-code",
                  "location": { "object_key": "…", "etag": "…" } }
}
```

Records may carry `id` (the record's id in its source), `llm_call` (the call in `llm_calls`
that produced it), and on tool results `withheld` and `duration_ms`; the meta record may carry
`agent_version`. Every `llm_call` must name an entry of `llm_calls`. `events[i].index` is
stable for the object's lifetime; anything that addresses a span of a session does so by event
index range.

Other formats are rendered from it on read, never stored (`GET …/trace?format=`):

- `letta`: the `sessionstorage/trace/1` object sessiondb stored: plain trajectory-v1 records,
  no `llm_calls` or `provenance`, the same events and `content_hash`.
- `otlp`: one OTLP/HTTP JSON `ExportTraceServiceRequest` (schema attribute
  `seshi/trace-otlp/1`) with GenAI spans: an `invoke_agent` root, a `chat` span per assistant
  record (its LLM call's model, response id and `gen_ai.usage.*` on the call's first span), an
  `execute_tool` span per tool call. Lossless: spans carry the canonical records as
  `seshi.records`, the resource the meta record, metadata, `llm_calls` and `provenance`, so
  `fromOtlp` gives back the canonical trace.
- `atif`: an ATIF-v1.7 document; token usage as step `metrics` and `final_metrics`.

### `metadata.json` — `seshi/metadata/1` ([schema](schemas/metadata.schema.json))

The live pointer, written with `If-Match` on every change. A session exists from its first
write: one whose transcript normalized to nothing worth a trace has an empty `traces` and no
`head` or `source`, and never appears in `changes/`.

```jsonc
{
  "schema": "seshi/metadata/1",
  "owner": "alice", "archive_id": "…", "session_id": "…",
  "agent": "claude-code", "source": "claude-code",
  "project": "github.com/acme/widget", "branch": "main", "parent_session_id": "…",
  "status": "stored",                 // or "redacted"
  "head": "<content_hash>",           // absent before a trace is stored, and once redacted
  "traces": [
    { "content_hash": "…", "created_at": "…", "records": 10 },
    { "content_hash": "…", "created_at": "…", "records": 5,
      "continuation": { "from_record": 6, "prefix_sha256": "…" } }
  ],
  "raw": [ { "part": 0, "format": "jsonl", "size": 1234, "sha256": "…", "created_at": "…",
             "offset": 0, "length": 48213 } ],   // until 04 stops storing raw (X6.3)
  "raw_format": "jsonl",
  "normalized": { "bytes": 57333, "records": 15, "prefix_sha256": "…", "hash_state": "…" },
  "withheld_calls": { "toolu_01…": "sensitive-file" },
  "writer": { "kind": "device", "principal": "alice", "credential_id": "tok_…",
              "source_id": "upload" },        // the original writer (X4.6, X5.5)
  "owner_basis": "verified",          // verified | claimed | service
  "visibility": "org",                // org | owner (X5.10)
  "claims": { "git_email": "alice@example.com", "account_ids": { "anthropic": "acct_…" } },
  "redaction": { "rule_set": "<sha256>", "counts": { "github-token": 1 } },
  "provenance": { "source": "hook", "source_id": "upload", "format": "claude-code" },
  "origin_agent": "claude-code",      // with native_session_id, collapses a session that
  "native_session_id": "…",           // arrived by two routes (X4.5)
  "normalizer": { "name": "…", "version": "…" },
  "retract_hash": "<sha256>",         // reserved for F9.7
  "created_at": "…", "updated_at": "…"
}
```

`writer` and `owner_basis` are the first write's; each later write's writer is on its change
entry. `claims` merge over writes from a fixed allowlist (X5.5). `redaction.counts` sum over
writes. A session that grew gets a second trace with a `continuation`; a reader that wants
the whole session concatenates in `traces` order.

### `raw.<n>.<format>.gz`

Transitional: the redacted native transcript, which today's pipeline normalizes from. 04
stops storing it (X6.3); the trace is then the only copy of the content.

### `changes/<stamp>-<hash|tombstone|visibility>.json` — `seshi/change/1` ([schema](schemas/change.schema.json))

One per publish, tombstone or visibility change, append-only. The feed a consumer tails with a
cursor (the last key processed) and a lag window.

```json
{ "schema": "seshi/change/1", "kind": "tombstone", "at": "…",
  "owner": "alice", "archive_id": "…", "session_id": "…", "content_hash": "…",
  "writer": { "kind": "device", "principal": "alice", "source_id": "upload" },
  "reason": "retracted" }
```

`kind` is `published`, `tombstone` (with `reason`: `deleted`, `retracted` or `redacted`) or
`visibility_changed` (with the new `visibility`). Every entry names its `writer`, never content.

### Server state

Read and written by the binary only, so their types are code-first in `@seshi/store`
(`objects.ts`, `records.ts`) rather than JSON Schemas:

- `tokens/<id>.json` (`seshi/token/1`): a token's hash, kind, owner, scopes, default
  visibility, expiry and revoked flag. Never the token itself.
- `sources/<id>/checkpoint.json` (`seshi/checkpoint/1`): the source id, when it was saved,
  and the poller's own `cursor` object.
- `worker/heartbeat.json` (`seshi/heartbeat/1`): instance id, version, roles, start and last
  run. Last writer wins; status reads a changing instance id as a second worker.
- `assembly/pending/<archive_id>` (`seshi/pending/1`): owner, archive id and when the last
  span batch arrived.
- `owners/<o>/sessions/<a>/spans/<trace_id>-<span_id>.json`: one normalized, redacted span
  record each, for the assembler (F4); never readable through the API.
- `owners/<o>/sessions/<a>/review/<n>.json` (`seshi/review/1`): for the `n`th stored write,
  the policy and its hash, the decision (`allow`, `redact`, `skipped`), both models, and the
  findings by record, field and category, never the matched text (F3.8). `n` is zero-padded to
  8 digits so a listing is in order.
- `sources/<id>/dropped/` (`seshi/dropped/1`) and `sources/<id>/failed/` (`seshi/failed/1`):
  one record per envelope that was not stored, with the base fields `at`, `source`,
  `source_kind`, `owner`, `session_key`, `idempotency_key`, `provenance`; drops add `reason`
  (`review_drop`, `review_failed`), `policy`, `policy_hash`, `decision_model`; failures add
  `code` and `message`. Never content. Kept 30 days by default (`[records]
  dropped_retention`, `failed_retention`); keys are in time order, so pruning stops at the
  first record to keep.

## The publish protocol

1. Write the trace object with `If-None-Match: *`; skip if the key exists (a `412` means another
   writer published the same content first).
2. Verify: compare the backend's ETag to the body's MD5 when the ETag is a plain MD5
   (single-part PUT on S3, R2, MinIO, and the folder store); otherwise read it back.
3. Update `metadata.json` with `If-Match` (retrying on `412` from a fresh read).
4. Append the change entry.

A writer that dies between steps leaves either nothing visible (before 3) or an object without
a change entry (between 3 and 4); the next publish of the same content completes it. Two
writers publishing different content for one session both land in `traces`; the head is
whichever updated the pointer last.

## Reading

- One session: `metadata.json`, then `trace.<head>.json.gz`; no `head` means nothing to read
  yet.
- Everything new since a cursor: list `changes/` with `StartAfter`, fetch what the entries
  point at.
- A full scan: list `sessions/`, read each `metadata.json`, skip those with no `head`.

A reader needs `s3:ListBucket` on the prefix and `s3:GetObject` under it. A writer
additionally needs `s3:PutObject`; tombstoning and pruning need `s3:DeleteObject`.
