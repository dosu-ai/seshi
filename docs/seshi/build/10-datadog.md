# 10 · Datadog sync (F5)

Branch `seshi-10-datadog`, on `seshi-09-otlp`. A `[[sources]]` `type = "datadog"` source is now
polled by the binary: a connector in `integrations/datadog-trajectory` reads Datadog LLM
Observability's Export API on the source's interval, from a checkpoint, and submits each
session's spans to 09's span assembler as the source's service account. A new span format,
`datadog-llmobs`, rebuilds a Trajectory session from its turn traces. User docs:
[docs/datadog.md](../../datadog.md).

## What was built

- **Config** (`packages/ts/config/src/server/sources.ts`, `datadogSource`), refined:
  - `site` must look like a host (`datadoghq.com`, `us5.datadoghq.com`);
  - `api_url` (optional, http(s)) replaces `https://api.<site>`: a proxy, or a test server;
  - `tags` must each be `key:value` (they become the search filter's tag map);
  - `page_size` (1–5000, default 500);
  - `quiet_period` (default `10m`), which 09's assembler job already reads from any source.

  `spec/config.schema.json` is regenerated; `server.test.ts` covers the new fields.
- **Export API client** (`integrations/datadog-trajectory/src/llmobs/api.ts`, types in
  `api-types.ts`), F5.1:
  - `searchPage` posts `POST /api/v2/llm-obs/v1/spans/events/search` with `DD-API-KEY` and
    `DD-APPLICATION-KEY`, a body of `filter {from, to, ml_app?, tags?}`, `page {limit, cursor?}`,
    `sort: "timestamp"` and `options.include_attachments: true`.
  - `readSearchResponse` pins the documented answer: `data` a list, `meta.page.after` a string
    or null, each item an `attributes` object with `span_id`, `trace_id`, `start_ns`, and
    `tags`/`input`/`output`/`metadata`/`metrics`/`duration` of the right types. An answer that
    does not fit, or a page where no item fits, throws `DatadogShapeError` ("the Datadog Export
    API answer changed shape: …"); single odd items are skipped and counted.
  - 429: waits `Retry-After` (seconds or a date), else `X-RateLimit-Reset`, else exponential
    backoff, inside the run, up to 6 times; a wait over 5 minutes fails the run instead. 5xx,
    `meta.status: "timeout"` and network failures: 4 attempts with backoff. Anything else
    (401, 403, 400) is a `DatadogApiError` with Datadog's own `errors` text (bounded) and, for
    401/403, a hint about the keys. No message holds a key. Waits are abortable.
  - `apiBase(site, api_url)`: `https://api.<site>`, dropping an `app.` or scheme in front.
- **Span conversion** (`spans.ts`): `toReceivedSpan` turns a Datadog span into OTLP's JSON
  mapping (`ReceivedSpan`), with Datadog's fields as `datadog.*` attributes (`span_kind`,
  `model_name`, `input.value`, `input.messages` as JSON, `metadata` as JSON, `metrics.<name>`,
  `tags` as a string array, the original ids):
  - `idHex`: decimal ids (Datadog's span ids) to 16 hex digits, 32-hex trace ids kept, a
    short decimal trace id converted, anything else a stable SHA-256 prefix; `undefined`, `0`
    and empty mean no id (a root's `parent_id` is the string `undefined`).
  - `startNanos`: `start_ns` by magnitude (ns, µs, ms or s), because the docs say nanoseconds
    and their example answers milliseconds. `duration` is read as nanoseconds, per the docs.
  - `sessionOf` (F5.3): `trajectory.session_id`, else `trajectory.trace_correlation.session_id`,
    else a `session_id` tag or field; none for Trajectory's oversight traces.
- **`datadog-llmobs` format** (`format.ts`), `DATADOG_LLMOBS_FORMAT` with a `SpanAdapter`:
  - `datadogPart` normalizes one span: what it stands for in `operation` (Trajectory's
    `turn`, `agent_message`, `compaction`, `permission_wait`, `llm` for
    `trajectory.llm_call:true`, `llm_placeholder` for the synthetic turn-usage span, else the
    Datadog span kind), input/output records (Datadog messages mapped onto the GenAI message
    reader: text, `tool_calls` with `tool_id`, `tool_results`, thinking as reasoning; else
    `value` as a user or assistant record), a tool call for tool spans (id from
    `metadata.tool_use_id|tool_call_id|tool_id|call_id`), a compaction's output as an
    `observation`, an LLM call for LLM spans and any span with token metrics (usage incl. cache
    read/write and reasoning, stop reason, request id, parameters, error from `error.*`
    metadata), and meta (model, `trajectory.client_version`, an absolute `cwd`/`project_dir`).
  - `assembleDatadogParts`: per trace, a Trajectory turn (it has a `turn` or `agent_message`
    part) is written from one source each, then 09's `assembleSpanParts` orders and joins:
    the prompt from the root (or, when the root has none, the trailing user messages of the
    first captured request), the assistant's words from the agent messages (the root's output
    only when none spoke), calls and results from tool spans (a message's own copy of them is
    dropped when tool spans exist), compactions as observations. Each turn is its own thread.
    Its LLM calls come from one tier only, preferring tiers that count tokens: real calls,
    else the agent messages' own, else the synthetic carrier, else the root, else any. Real
    calls are named by the agent message they sit under, then in order, extras merged into
    the last; a totals tier (carrier, root) is named by the turn's last words.
  - Any other LLM Observability app's trace is read by span kind: LLM spans' messages (history
    matched session-wide), else the trace root's input and output; tool spans unless messages
    name calls and not theirs; LLM calls from LLM spans only (an agent's aggregate is not
    counted again).
  - `datadogClaims`: `trajectory.user_email` → `email`, `git.email` → `git_email`,
    `trajectory.user` → `username`, `github.username` → `account_ids.github`, bounded as
    `pickClaims` bounds them.
  - As a log (`seshi normalize`, a POST, an S3 object), a saved Export API answer
    (`{data, meta}`, detected by those two keys) of one session normalizes whole; spans of no
    session are left out, an answer of several sessions is refused (`invalid_input`), LLM call
    references are removed as for `otlp-genai`.
- **The poller** (`connector.ts`), `DATADOG_CONNECTOR` (`kind: "datadog"`), listed in the
  integration's `connectors`, so `buildInstance({ integrations })` schedules every enabled
  `datadog` source as `source:<id>`:
  - Window (F5.2): from the checkpoint's `until` minus `overlap` (first run: now minus
    `backfill`) to now minus `lag`; nothing is asked when no window is due.
  - Pages oldest first; per page, spans are converted, ones already submitted are left out by
    span id, the rest grouped by `sessionOf` (no session: skipped and counted), and each group is
    one envelope: `source: "datadog"`, `format: "datadog-llmobs"`, the session as
    `session_key`, `payload: {kind: "spans", spans}`, the service identity (`svc:<id>`,
    `owner_basis: service`), `idempotency_key` = `datadog:` + SHA-256 of the sorted
    `trace:span` ids (X4.7), `provenance.cursor` = the window, claims, and `project` from
    `project_dir`.
  - The checkpoint (`{v: 1, until?, window?: {from, to, page?}, seen?}`) is written after each
    page's envelopes were submitted. `seen` keeps the submitted span ids (with start ms) that a
    window may read again: inside the next window's overlap, and while a window is read, inside
    the overlap it starts with; capped at 50,000, newest kept. The run itself remembers every
    id it saw.
  - 20 pages a run, then `{ more: true }`; the next run resumes the saved window and page
    cursor. A finished window opened by an earlier run also returns `more`, so the next window
    opens at once. A saved page cursor Datadog refuses (400) restarts the window once.
  - `lag_ms` is now minus `until`. `rewind(cursor, since)` returns `{v: 1, until: since}`
    (X4.9).
  - Config is read with `readDatadogConfig` (keys revealed from `Secret`), the checkpoint with
    `readDatadogCursor`, which refuses a cursor of another shape and says to rewind.
- **Fixtures** (`integrations/datadog-trajectory/testdata/llmobs/`, README says how they were
  made): a two-page Trajectory session (a turn with only the synthetic carrier, a turn with two
  real calls, a failed tool, a compaction, an oversight trace, a repeat across pages, a span of
  no session), the same session's turn at `minimal` level, and a generic LLM Observability app
  with `start_ns` in milliseconds.
- **Tests**: `spans.test.ts`, `format.test.ts`, `api.test.ts` (a local `Bun.serve` for
  Datadog), `connector.test.ts` (a local server serving the fixture pages, a fake context), and
  `tests/instance/datadog.test.ts`: `bootInstance` with the binary's integrations, a datadog
  source pointed at a local server, `sources.run`, the assembler job, sessions read back
  through the API (owner, basis, visibility, claims, project, provenance, LLM calls), the
  minimal session filtered and counted in health, the overlap's repeats left out, and a rewind
  resubmitting without writing the session twice. `apps/seshi` tests list `datadog-llmobs` and
  the connector.
- **Docs**: new `docs/datadog.md`; `docs/config.md` (datadog fields), `docs/server.md` (jobs),
  `spec/layout.md` (the datadog cursor), README.

## Extension points

- **Another span-reading poller** (a vendor with spans): convert to `ReceivedSpan` the way
  `toReceivedSpan` does (vendor fields as `<vendor>.*` attributes), write a `SpanAdapter` whose
  `assemble` pre-shapes parts and hands them to `assembleSpanParts`, and submit through
  `ctx.submit` with `serviceEnvelopeIdentity(id)`.
- **More Trajectory semantics**: `OPERATION` and `operationOf` in `format.ts` map tags to what a
  part stands for; `turnParts` decides what a turn writes from each.
- **Export API retries**: `ExportApiOptions` (`attempts`, `rateLimitAttempts`,
  `maxRateLimitWaitMs`, `backoffMs`, `sleep`); `datadogConnector(options)` passes `sleep`,
  `backoffMs`, `maxPagesPerRun` and `maxSeen`.
- **A shape change in the preview API**: `readSearchResponse` / `spanProblem` in `api.ts` and the
  types in `api-types.ts`; the fixtures' README lists what the docs leave open.

## Deviations and why

1. **The session key is `trajectory.session_id` first**, not `trajectory.trace_correlation.
   session_id` as F5.3 and X4.5 say. Trajectory's published tag reference
   (`docs/LLM-OBS-SPAN-TAGS.md`) puts `trajectory.session_id` on every span of a turn and
   `trajectory.trace_correlation.session_id` only on compaction and correlation spans; keying on
   the latter alone would drop almost every span. Both are read (the latter second), then
   LLM Observability's own `session_id`, so the decision's intent (turns of one session are one
   session) holds.
2. **Oversight traces and spans with no session are skipped**, not filed one session per
   trace. They summarize or belong to no conversation; the run's log line counts them.
3. **The poller cannot import `@seshi/auth`** (integrations may use model, kit and formats
   only, X3.2), so `serviceEnvelopeIdentity` repeats `serviceIdentity`'s three fields. The
   ownership authorizer refuses anything else, and the instance test checks the stored writer.
4. **`seen` is a list of span ids in the checkpoint** (F5.2's "removes repeats by span ID"),
   bounded to what an overlap can read again and to 50,000 ids. Past the cap a repeat is
   resubmitted, which the span store absorbs (same key). A span Datadog changes under the same
   id inside the overlap is not read again.
5. **Rate limits wait inside the run** (up to 5 minutes a wait) because the job runner's own
   retry (5 s doubling) would not honour `Retry-After`.
6. **`start_ns` unit by magnitude.** The docs call it nanoseconds; their example answer holds
   milliseconds. JSON numbers of nanosecond size lose precision past 2^53 (about 256 ns), which
   only affects ordering inside a quarter microsecond. `duration` is read as nanoseconds.
7. **No metadata-only check for Datadog** (F4.5 is the OTLP receiver's); minimal capture is the
   session filter's to drop and source health's to report (F5.4).
8. **Turn LLM calls are approximate where Trajectory gives only totals**: the synthetic carrier
   (or the root) is one call named by the turn's last assistant record. Real captured calls are
   named by the agent message they sit under.
9. **The fixtures are hand-built, not recorded**: no Datadog account was used. The README in
   `testdata/llmobs/` lists what the docs leave open (see Still to check).
10. **`commands.test.ts` now lets its fake datadog connector stand in for the real one** (two
    connectors for one type are refused), and its `workers status` job list gains `source:dd`,
    since the binary now polls the datadog source in its config.

## Still to check

- **No real Datadog traffic has been seen.** Point a test source at a Datadog org with
  Trajectory publishing and compare: whether `start_ns` is nanoseconds or milliseconds and what
  unit `duration` uses; whether span ids come decimal and trace ids as 32 hex; which span kind
  agent messages have and whether they carry token metrics; whether a tool span names the
  model's tool call id (and under which metadata key); whether agent-message spans enclose their
  tool spans (assistant text is placed at the span's end); what a turn root's output holds; what
  compaction spans carry; whether `session_id` appears as a tag or a field for other apps.
- **Filter semantics**: which timestamp `filter.from/to` compares (start or index time), and
  whether `filter.tags` with several pairs means all of them. The overlap covers late indexing
  only if Datadog filters by start.
- **Cursor lifetime**: how long a `meta.page.after` cursor stays valid; a stale one restarts the
  window (tested with a 400; Datadog might answer otherwise).
- **Rate limits** of the Export API (not documented): `page_size` 500 and 20 pages a run are
  guesses; a 5000-span page with full content may hit the 50 MB answer cap.
- **Application key scopes**: whether an application key can be limited to LLM Observability
  read (F5 Access).
- **X4.5 duplicates**: a session uploaded from the daemon's file (`datadog-trajectory`) and
  polled (`datadog-llmobs`) is two archives under different owners. `native_session_id` matches;
  `origin_agent` is the format name in both (`datadog-llmobs` here), not the client
  (`trajectory.client_source`). Recording the client in the meta record's `source` (as the
  daemon adapter does, `datadog-trajectory:claude-code`) needs a field on `SpanPart` or the
  meta.
- Span records of datadog sessions are never pruned (09's open item applies).

## Cross-branch wiring once the stack is linear

- **07 (redaction rules)**: Datadog span records are under `owners/svc:<id>/sessions/*/spans/`
  like OTLP's; the backfill note in 09 applies to them too.
- **08 (model review)**: assembled Datadog sessions reach the reviewer through
  `publishAssembled` with the marker's envelope (`source: "datadog"`, no payload). Review
  policies naming a datadog source id apply.
- **11 (S3 sync)**: `[[sources]]` edits are in `datadogSource` only; merge `sources.ts` by
  taking both sides' fields, then `bun run schema`. If 11 adds a second built-in connector list
  in `openServer`, the datadog connector stays in its integration (`connectorsOf(INTEGRATIONS)`).
- **12 (search)**: merge the job lists. `apps/seshi/src/commands/commands.test.ts` now expects
  `heartbeat, retention, source:dd, assembler` for its `SOURCES` config; 12 appends its
  indexer. Never index `spans/`. Datadog sessions are ordinary sessions (`agent:
  datadog-llmobs`, owner `svc:<id>`).
- **13 (CLI)**: `seshi sessions` for Datadog sessions uses agent `datadog-llmobs` and owner
  `svc:<source-id>`. `seshi sync run|status|failed` and `seshi reprocess --source <id>
  [--since]` already work for datadog sources.
- **Integration registry**: no new integration; `datadogTrajectory` now lists the
  `datadog-llmobs` format and the connector. `apps/seshi/src/integrations.test.ts` lists
  `datadog-llmobs` and checks `connectorsOf(INTEGRATIONS)` is `["datadog"]` (an S3 connector
  added to an integration would extend that list).
