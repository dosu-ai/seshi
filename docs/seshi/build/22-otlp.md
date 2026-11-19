# 22 · OTLP body cap and span history stored once (F4.1, F4.4)

Branch `seshi-22-otlp`, on `seshi-18-decisions`. Builds decisions 4 and 5 of
[18](18-decisions.md), the two OTLP findings 17's review left open: the OTLP body cap (F4.1,
revised 15 Nov 2026) and span records growing with the square of the calls (F4.4, revised 15
Nov 2026). User docs: [docs/otlp.md](../../otlp.md) (batch size, what happens to spans),
[docs/config.md](../../config.md) (`[limits]`), [docs/redaction.md](../../redaction.md)
(backfill).

## What was built

### OTLP body cap (decision 4)

- **Config** (`[limits]`, `packages/ts/config/src/server/limits.ts`), named like the keys
  beside them:
  - `max_otlp_bytes`, `"64MiB"`: one `POST /otlp/v1/traces` body as sent, gzipped or not.
  - `max_otlp_inflated_bytes`, `"256MiB"`: a gzipped body once inflated.

  `bun run schema` regenerated `spec/config.schema.json`. `Limits` (`@seshi/pipeline`) gains
  both as optional fields with the defaults in `DEFAULT_LIMITS`, so an `InstanceParts.limits`
  that names only the old three still works.
- **`@seshi/api` `src/otlp/body.ts`**, `readOtlpBody(request, caps)`, used by the receiver in
  place of the upload route's `readBody`:
  - A `Content-Length` past `max_otlp_bytes` is refused before anything is read.
  - Otherwise the body is read as a stream and refused at the first chunk past the cap, so a
    chunked body is never held whole first.
  - A gzipped body is inflated with `node:zlib`'s `Gunzip` a chunk at a time while it is read:
    each chunk sent is counted against `max_otlp_bytes`, inflated, and its output counted
    against `max_otlp_inflated_bytes` before the next chunk is read. Past the inflated cap the
    inflater is destroyed and the rest of the body is never read, so a gzip bomb costs the cap,
    not what it would inflate to.
  - Past either cap: `OtlpBodyError` 413 `too_large`, "request body exceeds
    limits.max_otlp_bytes (N bytes); send smaller export batches" (or `… inflated request body
    exceeds limits.max_otlp_inflated_bytes …`), which the receiver answers as a
    `google.rpc.Status` in the request's encoding. Not gzip is 400; another
    `Content-Encoding` is 415, as before.
- **`seshi serve`**: Bun's `maxRequestBodySize` is `requestBodyCap(limits)`, the larger of the
  upload bound (`maxBodyBytes(max_upload_bytes)`) and `max_otlp_bytes`, so a raised OTLP cap is
  not cut by the listener with a 413 that names no key.
- **Docs**: config.md's `[limits]` table; otlp.md's new "Batch size" section (the caps, what
  413 means, keep batches small, `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`) and a troubleshooting row;
  `spec/openapi.yaml`'s 413 for the route.

### Span history stored once (decision 5)

- **Layout** (`@seshi/store` `layout.ts`, spec/layout.md):
  `owners/<o>/sessions/<a>/spans/messages/<sha256>.json`, `keys.spanMessages` and
  `keys.spanMessage` (the hash checked as 64 hex).
- **Span store** (`@seshi/store` `spans.ts`):
  - A message is one record of a span's input as redaction left it, with a string `timestamp`
    emptied (`""`), stored under the SHA-256 of those bytes. Records without a string time keep
    what they have and are not touched on read.
  - A span record no longer holds `part.input`. It holds `input: { at?, messages }`: the time of
    the input's records and the hashes in order, an entry `[hash, timestamp]` for a record whose
    time is not `at` (`storedInputOf`, `StoredInput`, `StoredMessageRef`). The schema id stays
    `seshi/span/1` (nothing is deployed; a record with an inline `part.input` still reads).
  - `putSpans` (and `putSpan`) write the messages the session does not hold yet, then the
    records, so no record names a message that is not there. What the session holds is one
    listing of `spans/messages/` per batch (`listSpanMessages`), or a set the caller keeps
    (`PutSpansOptions.stored`, which backfill passes).
  - `spanRecords` streams a session's records as stored, a listing page at a time with 16
    reads in flight. `SpanMessages` reads each message once and rebuilds an input with its
    times (`records(input)`), each read its own copies. `withInput(record, messages)` gives a
    record back with `part.input` as an accessor that rebuilds the input when read.
  - `listSpans` streams the records, keeps one string per hash, reads every message the
    records name once, and returns the records with those accessors: callers (the assembler,
    tests) see `SpanRecord`s as before, and no part holds a copy of the history.
  - `listSpanKeys` stops at `spans/messages/` (it sorts after every record: `m` after hex).
    `deleteSpans` deletes the records, then the messages, and returns how many records went.
  - A record naming a message that is gone throws `MissingSpanMessage`, a `StoreError`.
- **Assembler** (`@seshi/pipeline` `spans.ts`): unchanged code; it reads through `listSpans`,
  so it streams. `SpanAdapter.assemble` and both assemblers (`assembleSpanParts`, Datadog's
  `assembleDatadogParts`) are untouched: they read `part.input` as before and get the rebuilt
  records. A missing message fails the session's pass like any store error: the marker is kept
  and `onError` reports it.
- **Redaction**:
  - On arrival nothing changed: the pipeline redacts each span's input before the store splits
    it into messages, so the messages hold only what the rules left.
  - Backfill (`backfillSpans` in `backfill.ts`) streams a session's records. A record under an
    old rule set is rebuilt from the messages, redacted with `redactSpanPart`, and written back:
    a message the new rules change lands under its new hash and the record names it. After the
    pass, every message a rewritten record stopped naming and no record names is deleted; the
    records are read once more just before, so a span stored meanwhile by a server still on
    the old rules keeps its message (the next run redacts it and deletes it then).
- **Deletion**: messages live under `spans/`, so `tombstone` (delete, `redacted`, and F9.7's
  `retracted`, published or not) removes them with the records through `deleteSpans`, and
  `listSessions` and backfill's walk for unpublished sessions step over them with the rest of
  `spans/`.
- **Measurement**: `tests/tooling/span-cost.ts [calls] [message bytes]` (below).
- **Docs**: spec/layout.md (the folder, the record's `input`), otlp.md ("What happens to
  spans"), redaction.md (backfill), the module comments of the store, pipeline and backfill;
  09's two open items and 17's two "Not fixed" entries are closed.

## Measurement

09's "Cost at scale" measurement, repeated with `tests/tooling/span-cost.ts`: one OTLP session
of N chat calls, each its own batch through `Pipeline.submit` into a folder store; each call's
input repeats the whole conversation (messages of about 2 KB) plus a new question, and its
output is one answer. Then one assembler pass. "Span bytes" is everything under the session's
`spans/`; "peak heap" is the JS heap above the heap before the pass (after `Bun.gc(true)`),
sampled every 2 ms and at the publish. Before is the base commit (719727c) with the same
script; peak heap varies between runs, so ranges are of two or three runs.

| Calls | Span bytes before | after | Objects before | after | Peak heap before | after |
|---|---|---|---|---|---|---|
| 400 | 341.0 MB | 13.6 MB | 400 | 1,199 | 468–489 MB | 20–37 MB |
| 800 | 1,361.8 MB | 48.6 MB | 800 | 2,399 | 1,753 MB | 66 MB |

The session itself is 1.7 MB of records at 400 calls (3.4 MB at 800), and the published
records and LLM calls hash the same before and after (`trace_sha256` in the script's output:
`6474c80adb2fa227` at 400, `d1712c62aee9c266` at 800). The 400-call "before" reproduces 17's
341 MB; 17 reported 355 MB of heap by another sampling. The objects after are N span records
and 2N − 1 messages.

## Deviations and why

1. **The messages folder is `spans/messages/`, inside `spans/`**, not a sibling
   `messages/`. A sibling would sort before `metadata.json`, so `listSessions` and backfill's
   walk for unpublished sessions would walk every message before finding a session's metadata;
   inside `spans/` it is stepped over and deleted with the span records by the code that
   already handles `spans/`, and it sorts after every record, so listing the records stops at
   it.
2. **A message is stored without its time.** Each span stamps its input's records with its own
   start, so the same message has a different `timestamp` in every span that repeats it;
   keyed with its time, nothing would be stored once. The time moves to the span record (`at`,
   or per entry), and reading puts it back in the same place in the record, so the rebuilt
   input serializes byte for byte as before.
3. **Span records still list one hash per message they repeat**, so their size still grows
   with the square of the calls, at 64 hex characters (about 67 bytes) per message instead of
   the message: at 400 calls 10.7 MB of the 13.6 MB, at 800 about 43 MB of the 48.6 MB. That is
   what the decision says (records point at the hashes). Making it linear would need a chain
   (each history node naming its predecessor, a record naming only its last node), which the
   decision did not choose; see "Still to check".
4. **The assembler streams through `listSpans`, not a new `SpanAdapter` contract.** Parts keep
   `input` as an accessor that rebuilds it from the shared messages when read, so neither
   assembler changed and the output cannot drift. The assembler still holds every part (it
   sorts them all), but without their inputs; it holds each message once and each part's input
   only while it reads it. Datadog's pre-pass copies the inputs of the parts it keeps whole (a
   trace's root, a generic app's LLM spans), as it did before.
5. **Gzip is inflated with `node:zlib`, not `DecompressionStream`.** Under Bun, piping a stream
   through `DecompressionStream` read the whole compressed body ahead of the reader (the
   bomb test saw every byte pulled), so stopping at the inflated cap would not have stopped
   reading. `Gunzip` fed one chunk at a time stops after the chunk that crosses the cap.
6. **The listener's own body cap** (`seshi serve`) is the larger of the two routes' bounds, not
   the OTLP cap: the upload route still needs its 513 MiB by default. A request between the
   OTLP cap and the listener's is read up to the OTLP cap and answered by the route.
7. **The caps are `Limits` fields the pipeline does not read.** They sit with the other
   `[limits]` keys so `InstanceParts.limits` and `instance.limits` carry them to the API; making
   them optional kept every existing `limits` object valid.

## Still to check

- **Decoding is still synchronous and still large.** A body under the caps is decoded on the
  event loop into OTLP's JSON mapping; 17 measured about 47x the wire size in memory, so a
  body near the caps can still cost an API instance gigabytes and seconds of CPU. A span-count
  cap, or decoding in a worker, would bound it further; the decision chose byte caps only.
- **Whether 64 MiB fits the Console's real batches.** Still no real Console traffic (09). The
  Console's batch sizes with full content decide whether exporters ever see the 413.
- **Hash lists are still quadratic** (deviation 3). If sessions of thousands of calls are
  common, store history as a chain so a record names one node.
- **One listing of `spans/messages/` per batch.** A session with tens of thousands of messages
  lists tens of pages for each batch that carries input. Not measured against S3 or R2.
- **A message deleted under a record** (a backfill whose last re-read missed a span stored by
  a server on the old rules at that moment, or someone deleting objects by hand) leaves the
  session failing each assembler pass with `MissingSpanMessage`, marker kept, until its spans
  are sent again. Nothing repairs it.
- **Retention.** There is no retention of sessions or span records (09's "Span records are
  never pruned" is still open); the messages are under `spans/`, so whatever prunes `spans/`
  prunes them. The `retention` job prunes drop and failure records and health shards only.
- **S3 behaviour**, not run against a live bucket: the messages' unconditional PUTs (the same
  bytes for the same key), and listing `spans/messages/` in pages.

## Cross-branch wiring once the stack is linear

- **The orphaned trace object sweep (decision 6)** must delete only `trace.<hash>.json.gz`
  objects. If it walks session folders it should step over `spans/` as `listSessions` does
  (`…/spans0`), or it walks every span record and message.
- **The change-feed key change (decisions 7 and 8)** does not meet this branch: span records
  and messages are not published and have no change entries.
- **Shared files touched**: `spec/layout.md` (one line in the tree, one entry after the span
  records), `spec/openapi.yaml` (the 413's description of `/otlp/v1/traces`), the `[limits]`
  section and `spec/config.schema.json` (regenerated), `packages/ts/store/src/index.ts` (the
  span store's exports). Merge as unions; rerun `bun run schema` after a conflict in the config
  schema.
- `docs/seshi/build/17-review.md` loses its two OTLP entries from "Not fixed"; a branch that
  removes a neighbouring entry (decision 3 or 6) meets this hunk.
