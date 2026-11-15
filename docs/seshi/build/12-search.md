# 12 · Search (F10)

Branch `seshi-12-search`, on `seshi-06-instance`. Keyword search over sessions (F10.1–F10.5):
an indexer per instance tails every owner's change feed into a local SQLite FTS5 file, `GET
/v1/search` answers from it with the caller's permission filter added by the server, and
`seshi search` asks a server or searches in-process. No embeddings (F10.5: later).

## What was built

- **`@seshi/search`** (layer 3; depends on model, store, auth, and pipeline for tests only;
  nothing new from npm: `bun:sqlite`).
  - `backend.ts`: the narrow backend interface F10.3 asks for, `SearchBackend` (`session`,
    `apply` a session update, `remove`, `query` with filters and a viewer, `counts`), and
    `FeedState` (per-owner cursor, the keys seen in the lag window, readiness, `transaction`,
    `reset`). `IndexStore` is both.
  - `sqlite.ts` `SqliteIndex`: one file (or `:memory:`), WAL, `busy_timeout` 5 s, created in an
    owner-only folder and chmod 0600 (it holds the org's redacted session text). Tables
    `sessions`, `events` and the FTS5 table `events_text` (`unicode61 remove_diacritics 2`,
    rowid = `events.id`), plus `feeds`, `seen`, `meta`. Ranking is bm25 (`rank`); a session's
    score is its best record's; `sort=recent` orders by the metadata's `updated_at`. Snippets
    are FTS5 `snippet()` with `\x01`/`\x02` markers, turned into plain text plus `[start, end)`
    offsets (`snippet.ts`); FTS5 refuses `snippet()` next to a window function, so the best
    records per session are picked first and their snippets read in a second query. Every
    write is a transaction. Every update carries its read stamp (`read_at`: when the indexer
    started reading the session's metadata, on this host's clock); an update read before what
    the file holds is refused, and so is a continuation whose `base` traces are not what the
    file holds, so two processes sharing a file (a server and a local `seshi search`, same host,
    same clock) never put back older content or duplicate events. The metadata's `updated_at`
    is deliberately not used for this: writers stamp it with clocks that disagree. A removal
    keeps (or adds, for a session never held) a `removed` row with its stamp, so a late update
    read earlier is refused. `reset` bumps a `generation`; a run that started before it writes
    nothing. The file records its format (`seshi/search-index/2`), deployment and indexed
    roles; any mismatch wipes it.
  - `indexer.ts` `Indexer` (F10.2): lists owners (`listOwners`, refreshed every minute, every
    run while there are none), and per owner lists `changes/` from its cursor minus a 5 min lag
    window (`FEED_LAG_MS`), skips keys already seen, reads the new entries, and for each session
    they name reads its **metadata** and indexes the session as it is now: removed when
    missing, `redacted` or headless; otherwise its traces from the last one without
    `continuation` to the head (`currentTraces`). When the file already holds the first traces
    of that list, only the new ones are read and appended (a continuation); otherwise (a replace,
    a session read for the first time) it is read again in full. A `published` entry with
    `replace: true` (an upload's replace, or a redaction backfill's `reason: "redacted"`) always
    drops what the file held of the session and reads it again from the trace the entry names
    (`tracesFrom`, falling back to `currentTraces` once a later replace dropped that trace). Visibility always comes from
    the metadata. The entries, the session changes and the cursor commit in one transaction per
    page. A run reads up to `RUN_BUDGET` (5000) entries and reports `more`; a run that read
    every owner to the end marks the index caught up, and the first such run makes it ready.
    Concurrent `run()` calls share one run. A metadata or trace object that cannot be decoded
    is skipped with a warning (an undecodable metadata drops the session from the index); store
    errors fail the run, which the job retries.
  - What is indexed (`searchableEvents`): trace events whose role is in `search.events`
    (`user`, `assistant`, `tool_call` by default: prompts, assistant text, tool names and
    inputs, so paths and commands). The trace's events leave out what the assistant said
    alongside tool calls; that text is indexed too, as an `assistant` document pointing at the
    record's first `tool_call` event. At most 32 KiB of an event is indexed.
  - `query.ts` `parseQuery`: words (all), `"phrase"`, `word*`, `a OR b`, `-word` / `NOT word`;
    everything else (paths, `--force`, `NEAR(`, `col:x`, stray quotes) is a quoted FTS5 string,
    so no input is an FTS5 syntax error or operator. Up to 1000 characters and 32 terms.
  - `service.ts` `SearchService`: per Instance, opened lazily (building an Instance touches no
    disk). `run`, `catchUp`, `rebuild` (reset, then catch up), `status`, `ready`, `close`, and
    `search(viewer, request)`: `checkRequest` (defaults, caps: limit 20/100, matches 3/20,
    offset ≤ 10 000; owner aliases folded via `storedAs`), `SearchUnavailable` until ready,
    then the index query, then **every result re-checked against the session's live
    metadata** (gone, redacted or no longer readable by the viewer: dropped; visibility taken
    from the live metadata). Offset cursors.
  - `viewer.ts`: `viewerFor(principal, aliases)` (`everything` for admins and services, the
    owner folders `storedAs(owner)`, and `canRead` from `@seshi/auth`), `LOCAL_VIEWER`.
  - `paths.ts` `defaultIndexPath`: `<cache>/seshi/search/<deployment>.sqlite`
    (`$XDG_CACHE_HOME` or `~/.cache`; macOS `~/Library/Caches` unless `XDG_CACHE_HOME`;
    Windows `%LOCALAPPDATA%\seshi\cache`).
- **Instance** (`@seshi/instance`): `instance.search` (`SearchService | undefined`), built
  from `[search]` unless `InstanceParts.search` overrides it (`null` for none); closed by
  `close()` after the jobs stop. `JobHost.search` and `JobHost.config.search.interval`.
  `search-job.ts` `searchIndexJobs`: the `search-index` job (`kind: indexer`, placement
  `every`, interval `search.interval`, summary owners/entries/indexed/removed, backlog
  ready/sessions/events/caught_up_age_ms), registered only on instances with the `api` role.
  One line in `BUILTIN_JOBS`.
- **API**: `GET /v1/search` in `app.ts` (one route block); query-string parsing in
  `api/src/search.ts` (unknown or repeated parameters are 400). Scope `search` enforced (05's
  open item). 400 `bad_query`, 401, 403, 404 `search_disabled`, 502, 503 `index_building` with
  `Retry-After: 5`. `spec/openapi.yaml`: the path, a `search` tag, `SearchResults`,
  `SearchResult`, `SearchMatch` (appended). Types in `@seshi/model` (`search.ts`:
  `SearchRequest`, `SearchResults`, …).
- **Client**: `HttpSessionDB.search(request)`; non-2xx as `ServerError` (`Forbidden` for 403).
- **`seshi search`** (replaces the stub): words plus `--owner --agent --repo --branch --source
  --since --until` (dates, RFC 3339 or ages like `7d`) `--sort --limit --matches --cursor
  --json`; `--status` and `--rebuild` for the local index. Picks, in order: `--config`/`--set`
  (in-process, as the server commands), `--server` or CLI `server` (HTTP with `--token`, and
  `--user` for the org key), CLI `[local] config` (local mode via `connect()`), then a server
  config where `serve` would find one (`SESHI_CONFIG`, `./seshi.toml`, `/etc/seshi/seshi.toml`,
  or `SESHI_STORE__URL`). In-process uses `LOCAL_VIEWER` (bucket keys read everything, X5.6) and
  catches the index up before each query. Plain output (`resultLines`, `searchLines`). Exit
  codes 0/2/3/5/7 as in docs/cli.md.
- **Config**: `[search]` gains `interval` (`"15s"`, > 0) and `events` (roles, default
  `["user", "assistant", "tool_call"]`); `path` documented. `spec/config.schema.json`
  regenerated.
- **Docs**: docs/server.md (search section, the job, the route), docs/cli.md (search section),
  docs/config.md (`[search]` rows), spec/layout.md (an index as a reader of the feed).
- **Tests**: `packages/ts/search/src/*.test.ts` (query syntax against real FTS5, snippets,
  SQLite backend incl. permission filter, filters, paging, stale and base refusals, two
  connections on one file, file wipe on mismatch, feed state; indexer over a folder store with
  real pipeline writes: continuations read only the new trace, replace, tombstone, visibility,
  lag window with a skewed clock, a continuation from a clock behind, a lost change entry,
  budgets and paging, bad entries, undecodable objects, a reset during a run, abort, owner
  refresh; service: 503 until ready, viewers, live re-check after visibility change and
  delete, aliases, cursors, persistence and rebuild, request checks; default paths; viewer).
  `tests/api/search.test.ts` (org-key members, admin, service reader, filters, trace/event
  pointers, live hiding, 503/400/404, the job on an api instance through status, no job on
  worker-only/local). `tests/api/openapi.test.ts` sees every documented `/v1/search` status.
  `apps/seshi/src/commands/search.test.ts` (in-process, local mode, over a `Bun.serve` of the
  real routes, exit codes). Checked by hand: the compiled binary (`bun run build`) runs
  `seshi search` and `--status` with FTS5 on macOS.

## Extension points

- **Another backend (ClickHouse, later):** implement `SearchBackend` (+ `FeedState`, or keep
  cursors elsewhere) and choose it in `SearchService.open()` from `search.backend`; the indexer
  and the API do not change. The indexer only calls `session`, `apply`, `remove`, the feed
  state and `transaction`.
- **Semantic search (later):** add documents per turn from `searchableEvents`' output; the
  `SearchRequest`/`SearchResults` shapes are additive-friendly (`score` is per answer).
- **Styled CLI output (13):** `searchLines` / `resultLines` in `commands/search.ts` produce the
  plain lines; each `SearchMatch` carries `highlights` offsets into `snippet` for colouring
  (B1.4: lilac for search results), and `match.role`/`tool_name` for labels.
- **CLI credentials (13):** `overHttp` takes `--token`/`--user`; once `seshi login` stores a
  credential, read it there (or in `connect()`) and keep `--token` as an override.
- **An MCP tool (later, F10.5):** call `SearchService.search(viewerFor(principal, aliases), …)`.
- **Other processes that need an index of the feed:** `Indexer` takes any `IndexStore`.

## Deviations and why

1. **The indexer runs on every instance with the `api` role, not on the worker.** The task text
   said "on the worker role", but the agreed decisions (F10.3, the X7 table: "Every instance,
   for its own local index") say each instance that serves search keeps its own index and
   cursor; a worker-only instance answers only `/healthz`, so an index there would serve
   nobody. Local mode (no roles) catches up inline before a query. Consequence for shared
   tests: `--roles api` now prints `jobs: search-index` (serve.test updated), and job lists in
   instance.test and end-to-end.test include `search-index`.
2. **The change feed says which session changed; the metadata says what to index.** F10.2 says
   a published entry indexes the new head and a tombstone removes the session. Reading the
   session's metadata for every entry (and the new traces only) makes the indexer idempotent
   and order-free, follows visibility changes, and copes with 04's open item (a crash between
   the pointer update and the change entry loses that entry): the session is right again at
   its next entry of any kind. It costs one metadata read per changed session per page.
3. **Results are re-checked against live metadata.** F10.4 puts the filter in the query layer;
   it is there (SQL), and in addition each returned session's metadata is read so a session
   deleted or made private after it was indexed is never shown (one GET per result). A page
   may hold fewer results than `limit`; `total` counts what the index holds.
4. **Readiness is "caught up once".** After a restart the file is ready at once (possibly a few
   seconds stale) instead of 503 again; only a new or wiped file waits (F10.3 wording).
5. **Assistant text said alongside tool calls is indexed**, though the canonical events leave it
   out; its match points at the record's first `tool_call` event (documented in openapi).
6. **Query syntax is ours, not FTS5's**, so user input can never be an FTS5 error (see above).
7. **Search response fields**: matches name `content_hash` + `event_index` (the event in that
   trace object), not a record index, because events are what excerpts are validated against.
8. **`GET /v1/search` refuses unknown query parameters** (400), unlike other routes that
   ignore them, so a misspelt filter does not silently widen a search.
9. **Tests isolate the default index path**: `vitest.config.ts` sets `XDG_CACHE_HOME` to a temp
   folder, `tests/tooling/instance.ts` `serverConfig` defaults `SESHI_SEARCH__PATH=":memory:"`
   (a test's env overrides it), and serve.test's spawned servers get a temp `search.path`.

## Still to check

- **FTS5 in the Linux binary and image.** Bun's bundled SQLite on Linux is expected to have FTS5
  (macOS uses the system library, checked). CI's docker job does not exercise search yet; run
  `seshi search --status --config …` in the image once.
- **List cost.** Each indexer run lists every owner's `changes/` (one LIST per owner per
  `search.interval`), plus one LIST per owner a minute for the owner list, on every API
  instance. With hundreds of owners on S3 that is a few dollars a month per instance at 15 s;
  raise `search.interval` for big orgs. A global feed (one prefix) would fix it but is a layout
  change.
- **New owners** are found within a minute (`OWNER_REFRESH_MS`), not within the interval.
- **Clock skew beyond 5 minutes** (a laptop in local mode) can leave an entry behind the
  cursor; the session is fixed at its next entry, or by `seshi search --rebuild`.
- **Query cost.** Ranking groups every matching record; a very common word or a short prefix
  over a large index scans many rows. No timeout or rate limit on `/v1/search` yet.
- **Offset paging** is not stable while the index changes between pages, and stops at 10 000.
- **`--token` on the command line** is visible in shell history and `ps`; it is interim until
  13 stores credentials.
- **Matching is per record.** All the words of a query must appear in one record (a prompt, an
  answer, one tool call); `flaky app.ts` does not find a session that says `flaky` in a prompt
  and touches `app.ts` in a tool call. That is the documented behaviour (cli.md, openapi), and
  keeps multi-word queries like `git push --force` precise. If people expect session-level AND,
  `parseQuery` would return its OR groups and the query would intersect the sessions matching
  each group (one `IN (… MATCH ?)` per group); ranking and snippets need not change.
- `search()` calls `counts()` on every query for `index.sessions`, a count over `sessions` and
  `events`. Cheap at today's sizes; cache it if indexes reach millions of records.
- Read stamps order updates between processes sharing a file. Two overlapping metadata reads
  around a write can still, in theory, apply in the wrong order (a read that started earlier
  may return the newer version); the session is right again at its next change. Within one
  process there is no such case: runs are serialized and a refused update is planned again.

## Review fixes

A review of the branch added these on top of the implementation:

- **Clock skew lost continuations.** The index refused any update whose metadata `updated_at`
  was older than what it held. `updated_at` is stamped by the writer's clock (API instances
  behind a load balancer, the worker, a laptop in local mode), so a chunk written a few hundred
  ms "earlier" by a machine whose clock is behind was never indexed until the session changed
  again; a session's last chunk could stay unsearchable for good. Updates are now ordered by
  the reader's own read stamp (`SessionUpdate.read_at`, index column `read_ms`), which is what
  the two-processes-one-file guard needs, since such processes share a host clock. Index format
  bumped to `seshi/search-index/2`, so older files are rebuilt. New tests: an indexer test with
  a continuation written by a clock 400 ms behind, and backend tests for read-stamp refusals.
- **One bad object stopped indexing.** A corrupt metadata or trace object (bad JSON or gzip)
  threw out of the run. The job retried forever without moving that owner's cursor, and on a
  new instance the index never became ready, so search answered 503 for good. Undecodable
  objects are now skipped with a warning; the live re-check of results treats undecodable
  metadata as gone instead of failing the query (500). New test.
- **A rebuild in another process could be undone.** `seshi search --rebuild` sharing the
  server's file reset the cursors while the server's job had a page in flight; that page then
  set the cursor past everything before it, and the rebuilt index silently missed sessions.
  `reset` now bumps a generation, and a run that sees it change writes nothing, does not mark
  the index caught up, and asks to run again. New test.
- A session removed before it was ever indexed now gets a `removed` row too (it was an open
  item), so a slower process sharing the file cannot index its last state.
- `vitest.config.ts` uses a fresh cache folder per run and removes it at exit. The fixed
  folder accumulated index files across runs, and `deployment: "d"` instances in instance.test
  reopened the previous run's file.
- Docs (cli.md, openapi, the model's `SearchRequest`) now say that all words must appear in one
  record.

## Cross-branch wiring

Done after the rebase onto 11 (07, 09 and 10 are below this branch now):

- **07 (redaction backfill):** a `published` entry with `replace: true` (with or without
  `reason: "redacted"`) now makes the indexer drop everything it held of the session and read
  it again from the entry's `content_hash` on, whatever the metadata's trace list looks like.
  The metadata alone missed one case: a backfill whose new trace keeps an old hash (only what
  the hash leaves out changed) rewrites that object in place, so the trace list looked
  unchanged and the stale text stayed. Tested with a hand-written in-place rewrite
  (indexer.test.ts) and with a real `backfillRedaction` over a two-trace session
  (tests/search/backfill.test.ts): what the new rules take out stops being found, the rest is
  found from the one rewritten trace.
- **09 (OTLP assembler) and 10 (Datadog):** `BUILTIN_JOBS` runs the assembler, then the
  indexer, so one pass of the jobs indexes what was just published. The job-name lists in
  instance.test, end-to-end.test, serve.test, otlp.test and datadog.test say so; commands.test's
  `workers status` list stays without `search-index` (no `api` role there). OTLP and Datadog
  sessions are searchable as ordinary sessions: agent `otlp-genai` / `datadog-llmobs`, owner
  `svc:<source-id>` (`listOwners` returns `svc:` folders), `--source` from
  `metadata.provenance.source_id`, and a member finds an org-visible service session.
  `spans/` is never read: tests/api/otlp.test.ts and tests/instance/datadog.test.ts check that
  stored, unpublished spans are not found, and that a session the filter dropped (its spans
  kept) is not in the index.
- **11 (S3 poller):** nothing in the indexer: its sessions are `svc:<source-id>` sessions with
  `provenance.source_id`. tests/instance/s3-sync.test.ts checks it end to end: a polled object
  is found under `svc:evals` with the `source` and `owner` filters (not under `source=upload`),
  what the pipeline redacted is not, and a rewritten object (F6.3, a whole send with
  `replace`) drops the old text from the index and makes the new text findable.

Still to wire:

- **13 (CLI):** wire the styled output (B1.4 lilac, highlights from `SearchMatch.highlights`)
  into `searchLines`/`resultLines`, passing hit text through `printable()`; read the stored
  credential in `overHttp` (or `connect()`), and consider `seshi sessions show` taking a search
  result (`agent/session_id`, `owner`). 13's colour helper must respect `--json` (no change
  needed: JSON is printed raw). Add `search()` to 13's Backend (ServerBackend: the client's
  `search`; LocalBackend: the Instance's index).
- **14 (capture):** retractions are tombstones (`reason: retracted`), removed from the index
  like deletes; nothing to wire.
- **openapi.test route list / commands.test stub list:** this branch added `GET /v1/search` and
  removed `search` from the stubs; 13 and 14 edit the same lists, keep the union.
