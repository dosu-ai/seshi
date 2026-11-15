# 04 · Pipeline (X4, X6.3)

Branch `seshi-04-pipeline`, on `seshi-03-store`. Every write of a session is now one envelope
through one pipeline: authorize, normalize in memory, regex redaction on the normalized
records, the session filter, model review, then the write. Nothing is written before every
stage has run, and no raw transcript is stored any more: a session is its `metadata.json`, its
trace objects and its change entries.

## What was built

- **Envelope (X4.1)**, `spec/schemas/envelope.schema.json` → generated `Envelope` in
  `@seshi/model`. Added `shipped`, `SpanPayload.resource`, a `ShippedPrefix` def, and
  `LogEncoding` in `common` (the model's `RawFormat` is now an alias of it).
  `packages/ts/pipeline/src/envelope.ts`: `uploadEnvelope(upload, { caller, owner_basis,
  source?, claims?, now? })`, `checkEnvelope` (refuses a malformed envelope as permanent
  `bad_envelope`), `hasCaller` (`upload`/`hook` answer the caller; every other source records),
  `writerOf`, `uploadIdempotencyKey`.
- **`Pipeline`** (`pipeline.ts`), built from options (no singletons): `submit(envelope,
  { onFailure })` and `publishAssembled(...)`. The stages are in X4.3's order:
  1. `Authorizer` (stage seam, `stages.ts`). `permissiveAuthorizer()` trusts the envelope's
     owner and basis, writes as its caller, and treats `caller.kind === "admin"` as admin.
  2. Normalize through the format registry: a whole log, or a chunk in the adapter's partial
     mode, using the session's small state (`metadata.normalized`, `withheld_calls`). A chunk's
     meta record is the head's.
  3. `Redactor` (`@seshi/redact` `ruleRedactor`, below).
  4. The session filter, on the first trace only.
  5. `Reviewer` (`noReview()` by default). It can allow, redact (one record out for one record
     in), skip (`skipped`) or drop. It gets the envelope without its payload: it judges the
     regex-redacted records, never the raw transcript.
  6. `ingest`: trace, pointer, change entry. A `ReviewNote` goes to `review/<n>.json`.
- **No raw (X6.3).** `putRaw`, `keys.raw`, `RawPart`, `metadata.raw` and `raw_format` are gone,
  and so is `raw` in the session API's result. Until a session has a trace, nothing of it is
  stored. A chunk (`offset` > 0) for such a session is `OffsetMismatch` with `expected: 0`. A
  filtered session answers zeros (`bytes_total: 0`, `EMPTY_PREFIX_SHA256`), so the next upload
  is the whole log. (A dropped first envelope did too until [20](20-review-drop.md), which
  keeps a stub for it.)
- **Extend or replace (X4.6).** A whole upload for a session that has a trace is checked
  against the server's own `normalized` state. If its records start with the stored prefix,
  its tail ships as a continuation and is never filtered; with no tail the answer is
  `unchanged`. Otherwise the upload gets `SessionConflict` (409 `conflict`), unless
  `replace` is set. `replace` needs `mayReplace`: the same principal and source as the stored
  `writer`, or an admin. Anyone else gets `Forbidden` (403). A replace leaves one trace in
  `traces`, deletes the other trace objects, starts `applied` and `redaction` over from the
  replacing write, and writes `replace: true` on the change entry (`change.schema.json`). Whole documents (ATIF, OpenCode) that grew still extend; one
  rewritten from the start is replaced by its writer.
- **Idempotency (X4.7).** `metadata.applied` keeps the last 16 envelopes (`APPLIED_KEPT`) with
  their answers (`AppliedEnvelope` in `metadata.schema.json`). A resend gets the recorded
  answer and runs no stage, including review (F3.7), and the health counters count it as
  `duplicate`. Uploads take the `Idempotency-Key` header, then `idempotency_key`, then
  `<session>@<offset>#<sha256(text)[:32]>`. A key is at most 2048 characters
  (`MAX_IDEMPOTENCY_KEY_LENGTH`): longer is `bad_envelope`, or 400 on the upload route.
- **Writers racing.** `ingest` takes a `guard`, which runs on the stored pointer before the
  object is written and again inside the If-Match update. A chunk that lost the race gets
  `OffsetMismatch` with the new end. A whole upload that lost is planned again, up to 3 times
  (`StalePlan`), and its orphaned trace object is deleted.
- **Failures (X4.8).** A permanent failure (`SessionRejected`, `OffsetMismatch`,
  `SessionConflict`, `Forbidden`) is thrown to a caller who waits. For other sources it goes to
  `writeFailed` under `sources/<id>/failed/` (provenance, code and message, never content), and
  `submit` answers `{ status: "failed", code, message, record }`. The message goes through
  `recordedMessage`, which elides double-quoted text (adapters quote what they could not read)
  and caps it at 300 characters. A transient failure
  (`StoreError`, a reviewer that throws) is always thrown. A review drop goes to `writeDropped`.
  For a session with a trace, a drop also moves the log past the envelope (`recordProgress`),
  so later chunks continue. A dropped replace does not (17): the log state stays the stored
  history's and the answer says so, so the next upload of the dropped history must replace
  again and is reviewed again (the uploader sends it whole with `replace`, 14).
- **Source health** (`@seshi/store` `health.ts`). Each process writes its own shard,
  `sources/<id>/health/<yyyy-mm-dd>/<instance>.json` (`seshi/source-health/1`). The outcomes
  are `stored`, `duplicate`, `unchanged`, `filtered`, `dropped`, `failed` and `rejected`.
  `addHealth` uses If-Match; `readHealth` sums the shards per day; `sourcesWithHealth` lists
  sources. The pipeline counts through the `HealthCounters` interface:
  - `StoreHealthCounters` coalesces counts in memory and flushes in the background. It never
    fails an upload. `flush()` waits for the writes.
  - `MemoryHealthCounters` keeps counts in memory.
  - `noHealth()` is the library default. `seshi serve` wires `StoreHealthCounters` with
    `serve-<random>` and flushes it on SIGINT/SIGTERM (bounded at 5 s).
- **Session filter (X4.10).** `worthiness.ts` became `filter.ts`: `isFiltered`, `FilterRules`,
  `DEFAULT_FILTER`, and `FilterSetting` (rules, or `(sourceId) => rules`). `serve` passes
  `(id) => filterFor(config, id)`. The outcome is `filtered`, not `trivial`.
- **X4.5.** `origin_agent` and `native_session_id` are written on every session, as in 03.
  Provenance is `{ source, source_id, format, location: envelope.provenance }`.
- **Span sets (X4.2).** `SpanAssembler.accept(SpanBatch)` returns `SpanBatchResult` (accepted).
  Without an assembler, a span batch is permanent `unsupported_payload`.
  `Pipeline.publishAssembled({ envelope, records, llm_calls })` runs filter, review and write on
  a session the assembler rebuilt. It always replaces when the session no longer extends, and
  its idempotency key is `assembled#<records digest>`, not the batch's key. A permanent
  failure is recorded under `failed/`, not thrown.
- **Record redaction (F2 seam)**, `packages/ts/redact/src/redactor.ts`. `Redactor { rule_set;
  redact(records, carried) → { records, withheld, summary } }`, and `ruleRedactor(rules)`:
  - the sensitive-call rules on `tool_calls`, via `classifyCall` and `trimSensitiveInput`,
    now exported from `sensitive.ts`; a withheld result gets the marker text and
    `withheld: <kind>`;
  - then the operator's patterns and the built-in secrets, on every non-structural string.
  `summary` is `{ rule_set: ruleSetHash(rules), counts }` (F2.3). For a whole upload that
  extends a session, the stored prefix and the tail are redacted as two passes of one. Only the
  tail's matches are counted, because only the tail is written.
- **HTTP and client.** `createApp` builds one `Pipeline`. Its new options are `reviewer`,
  `health`, and `filter` as a `FilterSetting`. `POST /v1/sessions` takes `replace`,
  `visibility`, `idempotency_key` and the `Idempotency-Key` header, and answers 409 `conflict`
  and 403 `forbidden`. `HttpSessionDB` maps them back to `SessionConflict` and `Forbidden`.
  The request body is capped at `maxBodyBytes(max_upload_bytes)` (twice the transcript cap
  plus 1 MiB), on the wire (serve's `maxRequestBodySize`) and once gunzipped; past it, 413
  `too_large`.
  `StoreSessionDB` submits envelopes to a pipeline it is given or builds. `storeSession` is a
  thin wrapper.
- **Contract and docs.**
  - Updated: `metadata`, `change`, `envelope` and `common` schemas; regenerated types; the
    conformance examples, plus the new `change.replaced.json`; `spec/openapi.yaml`.
  - `spec/layout.md` has a new "ingest pipeline" section and covers health shards and replace.
  - `docs/server.md`, `docs/config.md`, README and SECURITY are updated.

## Extension points for later branches

- **Submitting data (06, 09, 10, 11, 14):** build an `Envelope` and call `pipeline.submit`.
  - Pollers set `source`, their `source_id`, `provenance` (object key / ETag / cursor) and an
    idempotency key from X4.7. Permanent failures are recorded for them automatically.
  - The S3 poller (F6.3) sends a rewritten object with `replace: true`; its service account is
    the session's original writer.
  - The HTTP route goes through `StoreSessionDB.ingest`, which calls `uploadEnvelope`.
- **05 (auth):**
  - Implement `Authorizer` (stages.ts). It resolves the owner, `owner_basis` and `writer` from
    the verified caller, sets `admin` from roles, and throws `Forbidden`.
  - Build the envelope's `caller` from the token record (with `credential_id`).
  - `mayReplace` holds the X4.6 rule.
  - `checkEnvelope` still validates owners with `assertOwner`, so `svc:` and `@` owners need it
    widened.
- **06 (instance):**
  - The Instance owns one `Pipeline`, `StoreHealthCounters` with a stable instance id, and its
    `flush()` on shutdown.
  - `readHealth` / `sourcesWithHealth` back `seshi status` / source health.
  - Prune `failed/`, `dropped/` and old health days (`pruneRecords`, `config.records.*`).
- **07 (rule packs):** replace `ruleRedactor` with a pack-based `Redactor`, keeping the
  contract: deterministic, idempotent, carried withheld ids, counts. Bump
  `BUILTIN_RULES_VERSION` when built-ins change.
- **08 (model review):** implement `Reviewer`. `ReviewInput.envelope` has no payload; keep it
  that way, so nothing unredacted reaches the provider. Return `ReviewDecision`, put findings in
  `ReviewNote` (it is written to `review/<n>.json`), and set `drop` fields for the drop record.
  Retries and `on_failure` are the reviewer's; a throw is transient.
- **09 (OTLP):** implement `SpanAssembler`. Store spans, touch the pending marker, then call
  `publishAssembled` with the assembled records and `llm_calls`.
- **14 (capture):** the uploader handles:
  - `filtered`: resend the whole log later (`bytes_total` is 0);
  - 409 `offset_mismatch`;
  - 409 `conflict`: resend with `replace` if this machine wrote the session;
  - resends with the same idempotency key.
- **Lower-level writes:** `ingest` options `guard`, `replace`, `applied`, `withheld_calls` and
  `layout_checked`, plus `recordProgress`.

## Deviations and why

1. **Upload idempotency keys include a digest of the text.** X4.7 says session and byte
   offset. But a whole log is resent at offset 0 every time it grows, so the offset alone would
   replay an old answer for new content.
2. **New statuses `unchanged` and `dropped`, beside `filtered`.** "Nothing new for a session
   with a trace" is not "filtered", so it gets its own status. Filtered answers carry zeros,
   telling the client to send the whole log again (first-dropped ones did until 20).
3. **The server's own state decides extension, not the client's `shipped`.** `shipped` is
   still accepted and is read only for a session without `normalized`. Without raw, the server
   knows exactly what it holds.
4. **A rules or normalizer change makes the next whole upload a conflict.** The records no
   longer hash to the stored prefix. Chunks are unaffected, since they never re-normalize the
   prefix. Before, this silently wrote a full new head; X4.6 now requires `replace`. 07 and 14
   should know.
5. **A replace is not filtered.** The session already passed the filter. A replace removes the
   earlier trace objects, and readers learn from `replace: true` on the change entry (a new
   optional schema field).
6. **Log state counts records before model review.** `normalized`, `records_total`,
   `prefix_sha256` and `continuation` are in the uploader's log terms: records as regex
   redaction left them, dropped envelopes included. A later whole upload therefore still
   extends after model review redacted something. When review redacted, a continuation's
   `prefix_sha256` names the pre-review records, not the stored ones.
7. **"Original writer" means the same principal and source id.** The caller kind is ignored,
   so the same person through a static or legacy token counts. Admin is `caller.kind ===
   "admin"` until 05.
8. **`limits.max_upload_bytes` now measures the uncompressed transcript**, with nothing
   gzipped to store. The default went from 64MiB (gzipped) to 256MiB (uncompressed) to stay
   roughly equivalent; config tests, the schema and docs are updated.
9. *(Removed: a review drop of a session's first envelope now moves the offset past it, by
   writing a content-free stub. Decided in [18](18-decisions.md) (3), built in
   [20](20-review-drop.md).)*
10. **Health counters are per-process shards and best-effort** (a failed write is reported,
    not retried). This avoids a hot object every upload would contend on. OffsetMismatch is not
    counted, since it is the protocol working. `rejected` was added for refusals answered to a
    caller.
11. **Review can run twice on a rare race.** A whole upload that loses a race is planned and
    reviewed again (F3.7 says once).
12. **`require_user` / `require_reply = false` still have no effect** (from 02): `parseTrace`
    needs both on a first trace.

## Review fixes

A review of the branch added these commits on top of the implementation:

- Idempotency keys are bounded (2048 characters); an uploader-chosen key used to be kept
  unbounded in `metadata.applied`.
- Failure records no longer quote data: `recordedMessage` (above). Before, a trajectory record
  with an odd role was recorded as `unknown role "<the value>"`.
- A replace starts `applied` and `redaction` over. Before, a resend of a pre-replace upload was
  answered with a content hash whose object the replace had deleted, and the counts kept
  counting matches in content no longer stored.
- The reviewer gets the envelope without its payload.
- The upload route bounds the gunzipped body (a small gzip could inflate without limit), and
  serve's request cap follows `max_upload_bytes`, which now measures the uncompressed
  transcript.
- serve flushes the health counters on shutdown.
- New test: a whole log's short agent-only tail is stored under a filter that refuses
  everything (the known gotcha, on the whole-upload path).
- `spec/layout.md` no longer says the next publish completes a missing change entry: a resend
  is answered from `applied`, so a crash between the pointer update and the change entry leaves
  that entry missing until the session's next published entry.

## Still to check

- The live S3 test still has not run. New for 04: `ingest` deletes a trace object after a
  guard refusal, and replace deletes old traces. Both are plain DELETEs and need
  `s3:DeleteObject` for the writer (layout.md says so).
- Health shards are never pruned, and serve's instance id is random per process, so every
  restart starts new shards. 06 should use a stable id and prune old days.
- Dosu's CLI uploader expects `trivial` and `raw` in answers. It already handles 409 with
  `expected: 0`, but `filtered`, `unchanged` and 409 `conflict` are new to it (14, or a
  compatibility note for the Dosu side).
- The layout marker is now read once per `Pipeline`, which fixes 03's three reads per upload.
  `ingest` called directly still checks it each time.
- Prefixes written by 03 (raw parts, `raw` in metadata) no longer validate. 03 was never
  released, so there is no migration.
- `llm_calls` handed to `publishAssembled` are not run through the redactor (only records
  are). `LlmCall.error` and `parameters` are free text; 09 should redact them when it builds
  them, or the `Redactor` contract should grow to cover them.
- `recordedMessage` is a heuristic: it removes double-quoted text only. A Letta adapter error
  that echoes data unquoted would still be recorded; 10/11 should check their adapters'
  messages.
