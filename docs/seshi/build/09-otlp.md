# 09 · OTLP ingest (F4, X4.2)

Branch `seshi-09-otlp`, on `seshi-06-instance`. seshi is now an OTLP/HTTP trace endpoint:
`POST /otlp/v1/traces` takes a Claude Console destination's spans (protobuf or JSON), the
pipeline normalizes and redacts each span into a span store, and a worker job assembles each
session once its spans go quiet and publishes it through the pipeline as the destination's
service account. User docs: [docs/otlp.md](../../otlp.md).

## What was built

- **Span set contract** (`@seshi/model` `spans.ts`, re-exported by `@seshi/kit`):
  - `ReceivedSpan`, `SpanAttribute`, `SpanValue`, `SpanEvent`, `SpanLink`, `SpanStatus`: one span
    in OTLP's JSON mapping (hex ids, nanosecond strings). `scope` (the `ScopeSpans` scope) is
    carried onto each span.
  - `SpanPart`: one span normalized. Ids, times (ISO and exact nanoseconds), status, operation,
    thread (`gen_ai.conversation.id`), `input`/`output` as trajectory-v1 records, `tool`
    (`SpanTool`), `llm_call`, `response_id`, `content`, `final`, `meta` (model, cwd,
    agent_version).
  - `SpanAdapter`: `sessionKey`, `hasContent`, `claims?`, `normalize`, `assemble`. A format takes
    span sets when its `FormatAdapter` has `spans` (new optional field).
- **`otlp-genai` format** (`@seshi/formats` `src/spans/`):
  - `request.ts`: `readExportRequest` reads an `ExportTraceServiceRequest` (camelCase or
    snake_case names, hex or base64 ids, enum names or numbers, int64 as string or number,
    `instrumentationLibrarySpans`). A span without valid ids or a start time is counted in
    `rejected`, with the first reason.
  - `messages.ts`: GenAI messages to records. It reads the conventions' parts (`text`,
    `tool_call`, `tool_call_response`, `reasoning`, other types as `[type]`), OpenAI-style and
    Anthropic-style messages, system instructions, and the flattened legacy
    `gen_ai.prompt.<i>.*` / `gen_ai.completion.<i>.*`.
  - `genai.ts`: `genAiPart(span, resource, mappers)`.
    - Content comes from attributes or from events (the conventions' event form).
    - An `execute_tool` span becomes a tool call (with result and failure).
    - A model operation, or any span reporting `gen_ai.usage.*`, becomes an LLM call: model,
      provider, times, usage (incl. cache read/write, reasoning), finish reason, response id,
      request parameters, and `error.type` plus status message.
    - `genAiSessionKey` is F4.3: each mapper's key, then `gen_ai.conversation.id`, then the
      trace id.
    - `SpanAttributeMapper` is the vendor hook: `sessionKey`, `hasContent`, `claims`, `refine`.
  - `assemble.ts`: `assembleSpanParts(parts, {source})`.
    1. One part per trace and span id. One per `response_id`, preferring a `SERVER` span over
       an internal one over a `CLIENT` one.
    2. Parts are ordered by start, with input at start and output at end.
    3. Per thread, the longest start of a chat input that the thread's history already ends
       with is dropped (`newInput`, which also handles inputs whose earliest messages were cut;
       reasoning is ignored when matching). System instructions are kept when they change.
    4. A tool span adds records only when no message holds its call id; otherwise it adds
       `duration_ms` and `ok: false` to the matching result.
    5. An LLM call nested under a part that already reports usage is not counted twice. A
       chat part's call names its own output records. A turn's (`invoke_agent`) assistant
       records are named in order by the model requests the turn owns; extra requests are
       merged into the last.
    6. Calls are listed in the order records first name them, and ids are unique across
       traces. A meta record (format, model, cwd) comes first.
  - `format.ts`: `otlpGenAiFormat({name, mappers})` returns a `FormatAdapter` (`chunkable:
    false`, detected by a `resourceSpans` key). It has a `spans` adapter and also normalizes a
    whole OTLP/JSON export as one session (`seshi normalize`, S3 objects). `genAiSpanAdapter`,
    `OTLP_GENAI`.
- **`integrations/claude-platform`** registers `otlp-genai` with `anthropicAttributes`:
  - the session key `anthropic.session.id`;
  - tool span names (`anthropic.tool_use|mcp_tool_use|custom_tool_use <tool>`) and
    `anthropic.tool_result.content`;
  - outcome evaluations, as an observation;
  - `anthropic.message.stop_reason`, `anthropic.request.id`, thinking type and budget, service
    tiers, and cache writes by tier when the GenAI total is missing;
  - `anthropic.sessions.archive` and `anthropic.sessions.delete` as final spans;
  - org, workspace and `user.id` as `account_ids` claims.

  Fixtures in `testdata/otlp/` (with a README) are hand-built from Anthropic's published span
  reference: a Managed Agents session, the same session metadata-only, and a Messages API
  tool-runner loop with both SDK and API spans.
- **Span store** (`@seshi/store` `spans.ts`): `seshi/span/1` records at `keys.span(...)`
  (`received_at`, `source_id`, `format`, `part`, `redaction`), and `putSpan(s)`,
  `listSpanKeys`, `listSpans` (paged, 16 reads at once), `deleteSpans`. `PendingMarker` gains
  `source_id`, `envelope` (the batch's envelope without payload, `PendingEnvelope`) and `final`.
  `touchPending(..., details)`.
- **Pipeline** (`@seshi/pipeline`):
  - `Pipeline.submit` with a span envelope needs a format with `spans`; otherwise it is
    `unsupported_payload`. It normalizes each span (unreadable ones are counted as `rejected`;
    none readable is `bad_spans`, no spans is `empty`). Then `redactSpanPart` runs: records,
    the tool call as a call and result pair (so sensitive-file and secret-command rules
    apply), and the LLM call. The parts go to the assembler. `SpanBatch` now carries `parts`
    and the envelope without payload; `SpanBatchResult` has `rejected`.
  - `SpanStore` (the `SpanAssembler`): refuses a redacted session, writes the span records,
    then touches the marker. `final` is set when a part ends the session (a final span, or the
    root span of a session keyed by its own trace id), and an earlier batch's `final` is kept.
  - `assemblePending(options)`, one pass:
    - It lists the markers. A session is ready after its source's quiet period, or after
      `FINAL_GRACE_MS` (15 s) when final. It is published with the format's `assemble`
      through `publish` (`Pipeline.publishAssembled`), and then the marker is cleared with
      If-Match.
    - It reports published, waiting, failed, retouched, errors, dropped, the pipeline's
      outcomes, and `more` (at most `ASSEMBLE_BATCH` = 50 sessions a pass).
    - A marker without an envelope is dropped. So is a redacted session, whose spans are also
      deleted.
    - A missing span adapter or a thrown publish keeps the marker.
  - `publishAssembled` hands the LLM calls to `commit`, which redacts them for every write
    (07's `redactLlmCalls` from `@seshi/redact`: `error` and string `parameters` through
    `redactText`, 04's open item) and counts them. It counts what the spans' arrival redacted
    (`AssembledSession.redaction`): all of it for a first trace or a replace, and only what
    the stored counts lack for a tail.
  - `tombstone` deletes the session's span records and pending marker.
- **Instance and config**: every Instance builds a `SpanStore` (unless `InstanceParts.assembler`
  is given) and registers the `assembler` job (`BUILTIN_JOBS`, worker placement) every
  `worker.assembly_interval` (new, `30s`). Its backlog is `pending_sessions`. `JobHost` gains
  `pipeline`, `formats`, `config.sources` (for `quiet_period`) and
  `config.worker.assembly_interval`. (17-review: the job's pass is `assembleOnce`, also run
  by `Instance.assemble` and `seshi sync assemble`, the one-shot X7.1 asks for, so a
  deployment with no worker can publish span sessions from cron.)
- **API** (`@seshi/api` `src/otlp/`):
  - `protobuf.ts`: a hand-written decoder for the trace proto subset
    (`ExportTraceServiceRequest` into the JSON mapping; unknown fields skipped; depth, length
    and varint checks throw `ProtobufError`). Encoders for `ExportTraceServiceResponse`,
    `google.rpc.Status`, and (for tests and tools) the request.
  - `receiver.ts` `otlpTraces(instance, deps)`, registered as `POST /otlp/v1/traces`:
    - It authenticates (401), needs `sessions:write`, a service principal and an enabled `otlp`
      source of that id (403), and an OTLP content type (415).
    - It reads the body (gzip; 413 past the body cap; 400 when unreadable) and checks F4.5:
      no content anywhere means `partial_success` rejecting every span plus a "Full content"
      message, and health `rejected`.
    - It groups spans by session key and resource, with claims through `pickClaims`, the
      token's default visibility, and an idempotency key that digests the span ids.
    - It submits with `onFailure: "throw"`. A refused session's spans are added to
      `rejected_spans`; a store failure is 503.
    - It answers in the request's encoding.
  - `spec/openapi.yaml` gains the path (tag `otlp`) and the `OtlpExportResponse` and
    `OtlpStatus` schemas.
- **05's gap**: a service token's `POST /v1/sessions` is filed under its own source.
  `writerFor` gives a service principal `source_id = <id>` (`serviceSourceId` in
  `@seshi/auth`), `uploadEnvelope` takes `source_id`, and `StoreSessionDB` passes its writer's
  source. The source's visibility, filter and health now apply.
- **Docs**: new docs/otlp.md. Updated: docs/server.md (assembler job, route, service tokens),
  docs/config.md (`assembly_interval`, `quiet_period`), spec/layout.md (span records, marker
  fields, span sets in the pipeline), README.

## Extension points

- **A connector that submits spans (10, Datadog).** Build envelopes like this and call
  `ctx.submit(envelope)`:
  `{ schema: ENVELOPE_SCHEMA, source: "datadog", source_id, format, session_key, payload: { kind: "spans", spans, resource? }, ...serviceIdentity(source_id), idempotency_key, received_at, provenance?, claims? }`.
  - `spans` are `ReceivedSpan`s: OTLP's JSON mapping with lowercase hex ids (32 and 16 chars)
    and `startTimeUnixNano` as a decimal string. The pipeline leaves out (counts in
    `rejected`) a span the format cannot normalize or whose ids are not that hex, and checks
    nothing more, so build them with care, or run them through `readSpan` from
    `@seshi/formats`.
  - `format` names a format whose `FormatAdapter` has `spans`:
    - either `otlpGenAiFormat({ name: "datadog-llmobs", mappers: [datadogMapper] })`, when
      the poller maps Datadog fields to `gen_ai.*` attributes;
    - or a custom `SpanAdapter` whose `assemble` reuses `assembleSpanParts`.

    List it in the integration's `formats`.
  - `session_key` is `trajectory.trace_correlation.session_id` (F5.3).
  - `idempotency_key`: a digest of the span ids (X4.7). The answer is
    `{status: "accepted", archive_id, spans, rejected?}`. The publish happens later and is
    counted in the source's health then.
  - `quiet_period`: the assembler reads `quiet_period` from any `[[sources]]` entry that has
    one, and uses 10 minutes otherwise. Add the field to `datadogSource` to make it
    configurable.
  - A span part is final when its `final` is set (a mapper's `refine`), or when it is the
    ended root span of a session keyed by its own trace id.
- **Another vendor's attributes on OTLP**: write a `SpanAttributeMapper` and add it to the
  `mappers` of `OTLP_GENAI_FORMAT` in `integrations/claude-platform` (or move the format's
  registration to a place that collects mappers from several integrations, if a second vendor
  needs it).
- **Another span format on the receiver**: today the receiver always uses `otlp-genai`.
  Choosing a format per source would be a field on `otlpSource`.
- **Assembler knobs**: `assemblePending` takes `finalGraceMs`, `limit`, `quietMs`, `signal`,
  `onError`; the job wires `quietMs` from config. Lowering `FINAL_GRACE_MS` or making it
  config is one line.
- **Redaction of spans**: anything with the `Redactor` contract works (07). `redactSpanPart`
  uses `redact(records, carried)` for records and tool calls, and `redactLlmCalls`
  (`@seshi/redact`) for the LLM call, which uses `redactText` and falls back to `redact` with a
  `system` record for a redactor without it.

## Deviations and why

1. **Protobuf is decoded by hand**, in `@seshi/api` (not a dependency). Six messages need
   decoding; a protobuf runtime would be a large dependency. Keeping it in the API keeps it out
   of `seshi hook`'s import graph (`check:hook` still passes). Encoding the request is there only
   for tests and tools.
2. **`otlp-genai` is registered by the Claude Platform integration**, not as a built-in format.
   The GenAI mapping and the assembler are vendor-neutral and live in `@seshi/formats`; the
   `anthropic.*` mapper lives in `integrations/claude-platform` (X3 layout). A binary built
   without that integration has no `otlp-genai`, and the receiver answers 503.
3. **The metadata-only check is per HTTP request, in the receiver** (F4.5 says "batch"), so a
   request with content in one session and none in another stores both. Pollers are not
   subject to it: minimal Datadog capture is the session filter's to report (F5.4).
4. **What "a final span" is** (F4.4 names none):
   - for Claude, archiving or deleting a session;
   - generically, the ended root span of a session keyed by its own trace id.

   The session is then published after a 15 s grace, not at once, for spans of the same trace
   in later export batches. Two batches racing can lose the final mark; then the session waits
   the whole quiet period.
5. **LLM calls of a Managed Agents turn are approximate.** A turn's output has no per-message
   times, so its assistant records are named by its model requests in order. Extra requests are
   merged into the last call (summed usage, latest end), so no tokens are lost. A compaction's
   own usage inside a Messages API request is dropped, since it is nested under the request's
   call. An outcome evaluation's usage is not referenced by a record, so the pipeline's
   `callsFor` drops it.
6. **Redaction counts of assembled sessions** add the spans' arrival counts (all of them for a
   whole write, the part the stored counts lack for a tail) to what the publish pass finds.
   Counts can be slightly off when cross-span withholding was counted at publish.
7. **LLM call free text is redacted through `Redactor.redact`** as synthetic `system` records,
   not through a new method, so 07's pack-based redactor works without changing the contract.
8. **A disabled `otlp` source answers 403**, not 200-and-drop: a push source that is idle
   should say so to its sender.
9. **Visibility of OTLP sessions**: the token's default visibility beats the source's (X5.10's
   order), as on the upload route.
10. **The assembler job is registered on every instance**, even with no `otlp` source, so
    markers left by a removed source still get published. It costs one listing per interval.
11. **`ReceivedSpan.scope`** is a seshi addition to the JSON mapping: the span carries its
    `ScopeSpans` scope. The envelope schema's span items are free objects, so the schema is
    unchanged. Nothing reads it yet.
12. **Unreadable spans are rejected through `partial_success`**, with the first reason, and
    the rest are stored. A session the pipeline refuses (deleted, nothing readable) is also
    counted in `rejected_spans`, while the other sessions in the request go in.
13. **Each span is its own object** (no batching into one object per batch). This is simple,
    and repeats overwrite. It costs one PUT per span on arrival and one GET per span per
    publish.
14. **An OTLP/JSON export sent as a log** (`POST /v1/sessions` with `agent: otlp-genai`, an S3
    object, `seshi normalize`) is one session. Until 17 it had no LLM calls, since the
    `FormatAdapter` contract returned records only; the contract now takes
    `{ records, llm_calls }` and the export keeps the calls the span path keeps.

## Still to check

- **No real Console traffic has been seen.** The fixtures follow Anthropic's beta span
  reference; names and attributes can change in the beta. Point a test destination at a dev
  seshi and compare:
  - the roles used for tool results in turn output;
  - whether turn inputs repeat history;
  - whether the Console gzips;
  - the `user.id` and workspace attributes;
  - span sizes with large contexts.
- **Cost at scale.** Each pass lists all markers and reads each one (every 30 s). Each publish
  reads every span record of the session. A long Managed Agents session (thousands of spans)
  pays that on every republish. (17-review measured it: each chat span keeps the whole input
  history, so span records grow with the square of the calls; 400 calls of about 2 KB per
  message made 341 MB of span records for a 1.7 MB session, all loaded on each publish. Nothing
  bounds the load, so a worker under a tight memory limit could crash on one session and retry
  it after each restart. Storing history once, or a per-session span cap with a permanent
  failure, changes F4.4's storage model or refuses long sessions: left for this item.)
- **Span records are never pruned** while their session lives: they duplicate the trace's
  content at rest (regex-redacted, not model-reviewed: X6.3 says so). A retention for published
  sessions' spans may be wanted. The same holds for a session the filter refused or model
  review dropped: nothing of it is published (X4.10), but its span records stay so that later
  spans can make it pass. A retention would cover those too. (17: `tombstone` now removes
  such a session's span records and pending marker even though it has no metadata, so local
  `seshi sessions rm` can delete them; the API's DELETE still answers 404 for a session it
  cannot read, and retention is still open.)
- **Size limits.** `limits.max_records_bytes` (32 MiB) can refuse a long session with
  full-content spans (0.75 MB each by default); the refusal is a failure record and the spans
  stay. The OTLP body cap is the upload's (`maxBodyBytes(max_upload_bytes)`, about 513 MiB);
  an OTLP-specific cap may be better. (17-review: the cap applies after gunzip too, and the
  protobuf is decoded on the event loop at about 47x its size in memory, so a holder of an
  otlp source's token can stall or exhaust an API instance with a few MB of gzip. The cap's
  value waits on the Console's real batch sizes above.)
- **`anthropic.content.truncated`** is not recorded anywhere; truncated inputs are handled by
  the history matching.
- **S3 behaviour**, not run against a live bucket: listing `spans/` in pages, unconditional
  overwrite of span keys, and conditional delete of markers (03's open item).
- **Whether workspace or API-key ids are worth more than a claim** (F4 Access): org and
  workspace ids are now recorded as `account_ids`.
- **06's timing test** "spots a second worker from the heartbeat" was racy: it read the worker
  state and the warning from two status calls, and a heartbeat rewritten in between flips the
  state back. Review made it read both from one call (it failed in the review's first run).

## Review fixes

A review of the branch against F4, X4.2 and the build rules found and fixed:

1. **A connector's span with ids that are not OTLP hex failed the whole batch as a store
   error.** The ids name the span's record (`keys.span` refuses them with `StoreError`), and a
   `StoreError` is transient, so a poller (10) would have retried the batch forever. The
   pipeline now leaves such a span out and counts it in `rejected`, like a span the format
   cannot read. The receiver never hit this (`readSpan` checks ids), a connector could.
2. **`GET /v1/sessions` paged through span records.** They live under each session's folder
   and `listSessions` walked every key, so a service account with a long OTLP session answered
   page after empty page (5000 spans at `limit=100`: fifty round trips before the next
   session). `listSessions` (`@seshi/pipeline` `ingest.ts`) now steps over a session's
   `spans/` and resumes just past it (`…/spans0`); the cursor says so. Behaviour without span
   records is unchanged.
3. **`SubmitOutcome` (kit)** gains `rejected?` on its `accepted` variant, which the pipeline
   already answered.
4. **The partial_success message** for left-out spans names both reasons (no start time, ids).
5. **06's racy heartbeat test**, as above.

## Cross-branch wiring done on the linear stack

Rebased onto 08 (with 07 below it). `feat(pipeline): wire span and LLM call redaction, and
review of assembled sessions, now that 07 and 08 are in the stack`:

- **07 (redaction rules)**:
  - One `redactLlmCalls`: 09's own copy in `spans.ts` (synthetic `system` records through
    `redact`) is gone. `redactSpanPart` uses 07's `redactLlmCalls` from `@seshi/redact`
    (`redactText` on the Instance's rule set, `instance.redaction` via `ruleRedactor`). It now
    falls back to `redact` with a `system` record for a `Redactor` without `redactText`, so no
    redactor lets an LLM call through. `@seshi/pipeline` no longer exports `redactLlmCalls`.
  - `publishAssembled` no longer redacts LLM calls itself (and `WholeOptions.extra` is gone):
    `commit` redacts and counts them for every write, as 07 made it. A span's LLM call is
    redacted and counted on arrival (its record's `redaction`), and those counts reach the
    session through `arrived`; the publish pass finds the marker, not the secret, so nothing
    is counted twice (test in `spans.test.ts`).
  - `seshi redact backfill` also redacts span records again (`backfillSpans` in
    `backfill.ts`): for every session it looks at that is not `skipped`, each span record
    whose `redaction.rule_set` is not the current one is redacted with `redactSpanPart` and
    rewritten in place with the current rule set and its counts added. This runs even for a
    `current` session, since the assembler may have published it after the rules changed.
    Span counts stay on the records (they repeat the traces), so they are not added to the
    session's or the report's counts; the report and `BackfillSession` gain `spans`, and the
    CLI prints how many span records it redacted. Stored LLM calls were already backfilled by
    07. Test in `backfill.test.ts`.
  - 07's assembled-session test looked the session up under the `trajectory` format; it now
    uses `otlp-genai` (a separate `test(pipeline)` commit).
- **08 (model review)**: two tests in `tests/review/review.test.ts` send a GenAI span through
  `POST /otlp/v1/traces` of an Instance with a review policy scoped to the `otlp` source, run
  the `assembler` job, and check that review redacts the assembled trace and records its
  decision, and that a drop leaves no session and a drop record under `sources/console/`.

## Cross-branch wiring once the stack is linear

- **07 (redaction rules)**, still open:
  - If the `Redactor` interface changes, `redactSpanPart` in `packages/ts/pipeline/src/spans.ts`
    must follow.
  - ~~Backfill does not reach span records of sessions with no metadata~~ (resolved in 17):
    after an owner's sessions, backfill walks the owner's session folders for `spans/` with no
    `metadata.json` beside them (pending, filtered or review-dropped sessions) and redacts them
    again in place.
  - A span arriving while backfill rewrites the same span record can be overwritten by the
    backfill's copy (both are redacted; the backfill's with the current rules).
  - A rules change makes the next assembled publish a replace (the prefix no longer hashes the
    same), which is expected.
- **08 (model review)**:
  - A drop writes a drop record and leaves the span records, so later spans re-assemble and
    re-review the session. Span records keep text that review would have redacted (they are
    regex-redacted only, X6.3); see "Span records are never pruned".
- **10 (Datadog)**: see Extension points. `SubmitOutcome` in kit already includes `accepted`.
  Add `quiet_period` to `datadogSource` if wanted (the job reads it generically). Register the
  `datadog-llmobs` format with `spans` in the integration.
- **12 (search)**:
  - The `assembler` job joins `BUILTIN_JOBS` before the indexer. Merge the two one-line
    additions and the job-name lists in `instance.test.ts`, `commands.test.ts` and
    `tests/instance/end-to-end.test.ts`.
  - Never index `spans/` objects. OTLP sessions are ordinary sessions (`agent: otlp-genai`,
    owner `svc:<id>`) with change entries.
- **13 (CLI)**: OTLP sessions are `otlp-genai` sessions of `svc:<source-id>`. `seshi tokens
  create --kind service --service <id> --scope sessions:write` is the destination's token.
- **Any branch touching `listSessions`** (`packages/ts/pipeline/src/ingest.ts`, e.g. 12 or 13
  listing sessions): keep the `spans/` step-over (`listSessionKeys`), or span records fill the
  pages again.
- **Any branch adding routes or config**: these lists conflict on rebase and should be merged
  as unions:
  - the route list in `tests/api/openapi.test.ts` ("names every route");
  - the `paths` and `tags` in `spec/openapi.yaml`;
  - the `[worker]` section (`assembly_interval`), after which `bun run schema` is rerun.
- **The integration registry** gains `claudePlatform` at the end of `INTEGRATIONS`, and
  `apps/seshi/src/integrations.test.ts` lists `otlp-genai`.
