# A shared search index on LanceDB: design

Status: proposed design. Nothing here is built. It follows the scoping work in
[dosu-ai/seshi#43](https://github.com/dosu-ai/seshi/pull/43), which compared ClickHouse, LanceDB
and DuckLake with Moraine, and ran the probes this design relies on
([`search-probe/`](https://github.com/dosu-ai/seshi/blob/8b7d3f9/docs/seshi/search-probe/README.md)).
It is written against `main` at seshi 0.27.0, with `@lancedb/lancedb` 0.41.0 and Bun 1.4.2. The
checks added for this document ran on 24 November 2026, on macOS arm64.

## Summary

Today every API instance keeps its own search index, an SQLite file built from the change feed
(F10.3). This design adds a second backend for teams that run the server: **one index for all
instances, kept in object storage with LanceDB, written by the worker and read by every API
instance.** SQLite stays the default and the only backend in serverless mode.

- **LanceDB** is an embedded library, like SQLite. It has an inverted index with BM25 ranking,
  and it stores tables and indexes as files on a local folder, S3, R2, GCS or Azure. No new
  service runs.
- **One writer.** The worker (X7.2) runs the indexer and commits to the index. API instances
  only query, and pick up new versions within a few seconds.
- **It stays derived** (X6.1). The index can be deleted at any time and is rebuilt from the
  change feeds. Nothing reads it as a store of record.
- **The seam comes first.** `IndexStore` changes into an async `IndexReader` and `IndexWriter`,
  the indexer writes one feed page per `commit()`, and queries carry a parsed tree instead of an
  FTS5 string. SQLite moves onto the new seam first, with no change in behaviour.

What this does not include: analytics (tokens and spend), semantic search, and ClickHouse. The
first two can build on this index later; see [later](#later-analytics-and-semantic-search).

The size is about four weeks for one person: a short spike, the seam, the backend, then
deployment. See the [plan](#plan).

## Decisions

| | Decision |
|---|---|
| F10.6 | `[search] backend = "lance"` is a server-only option. SQLite stays the default. Serverless mode always uses SQLite, and laptops ignore the shared config's backend. |
| F10.7 | `IndexStore` splits into an async `IndexReader` (queries, state, the cross-owner feed) and `IndexWriter` (the indexer). The indexer writes one feed page per `commit()`, every writer call names its generation, and queries take a parsed `MatchTree`. SQLite's behaviour does not change. |
| F10.8 | With LanceDB, the worker writes the index and every API instance reads it. The search job's placement is `worker` for this backend, `every` for SQLite. |
| F10.9 | The index lives under `search/` in the store's bucket by default, or at `search.lance.uri`. It is derived (X6.1), holds session text, and is written only by the indexer. spec/layout.md lists it. |
| F10.10 | A feed page is one `mergeInsert` per table, content tables first and the cursor last. Writes are idempotent, so a crash part-way is repaired by reading the page again. |
| F10.11 | A rebuild writes a new generation beside the live one and switches when it has caught up. Search keeps answering from the old one. Only the first build answers 503. |
| F10.12 | Retracted and redacted text is hidden at the next commit, and leaves the bucket within `search.lance.scrub` (a day by default), when the worker rewrites tables that hold deleted rows. |

## How it runs

```text
              change feeds, metadata, traces (the bucket: the store of record)
                                    │ read
                                    ▼
        worker ── Indexer ── LanceIndex (IndexWriter) ──commit──▶  search/<deployment>/
                                                                     meta.lance
                                                                     <gen>/events.lance
                                                                     <gen>/sessions.lance
                                                                     <gen>/cursors.lance, seen.lance, changes.lance
                                                                         ▲
        API instance ── SearchService ── LanceIndex (IndexReader) ───────┘ read
        API instance ── SearchService ── LanceIndex (IndexReader) ───────┘ read
```

- The **worker** runs the `search-index` job. It reads every owner's change feed as today, plans
  each page with the same `Indexer`, and calls `commit()`. After a pass it runs maintenance
  (`optimize()`, and the scrub when due).
- **API instances** open the tables read-only with `readConsistencyInterval` set (5 seconds by
  default), so they see new versions within that time. LanceDB's default is to never check,
  which would freeze a reader on the version it opened.
- `GET /v1/changes/all` is served from the index's copy of the feed, as today. Every instance
  can serve it, because the copy is in the shared index.
- A deployment without a worker (cron-only, X7.1) runs the job from cron. Progress is in the
  index's cursors, so a long first build spans several runs.

## The seam

`backend.ts` today defines `SearchBackend & FeedState`, implemented by `SqliteIndex`. It is
shaped for an embedded database where every call is cheap:

- `transaction(fn)` takes a callback. LanceDB has no transaction across tables, and reads made
  inside `fn` would not see the writes buffered in it.
- `apply()` and `remove()` work one session at a time. In LanceDB that would be one commit, and
  so one table version, per session.
- The indexer reads the index during a page: the held session for a continuation's `base`, and,
  since 0.16, the held session's `format` for feed entries that lack one (`Indexer.named()`).
- A search makes four calls: `readyAt()`, `query()`, `caughtUpAt()` and `counts()`.
- `SearchService.open()` constructs `SqliteIndex` directly.

The new seam replaces `SearchBackend`, `FeedState` and `transaction()`. `IndexedSession`,
`IndexedEvent`, `SessionUpdate`, `BackendMatch`, `BackendHit`, `BackendResults`, `FeedPosition`
and `FeedRow` stay as they are.

```ts
// query.ts: parseQuery returns this, and each backend compiles it.
export interface MatchItem {
  /** Words as typed, lower-cased; more than one is a phrase (`src/app.ts` → src, app, ts). */
  tokens: string[];
  /** `word*` or `"a phrase"*`: the last word is a prefix. */
  prefix: boolean;
}

export interface MatchTree {
  /** Every group must match one record; within a group, any item will do. */
  all: MatchItem[][];
  /** A record holding any of these does not match. */
  none: MatchItem[];
}

// backend.ts
export interface BackendQuery {
  match: MatchTree; // was the FTS5 string
  viewer: Viewer;
  owners?: readonly string[];
  agent?: string;
  repo?: string;
  branch?: string;
  harness?: string;
  agent_version?: string;
  model?: string;
  labels?: Labels;
  source?: string;
  since?: number;
  until?: number;
  sort: SearchSort;
  limit: number;
  offset: number;
  matches: number;
}

/** What a search reports about the index, read in one go. */
export interface IndexState {
  /** When the live generation first caught up; undefined before any has. */
  ready_at?: string;
  caught_up_at?: string;
  sessions: number;
  events: number;
  generation: string;
  /** A rebuild in progress: the generation being built and how far it has read. */
  building?: { generation: string; read_through?: string };
}

/** The API's side: SearchService.search, status and changes. Reads the live generation. */
export interface IndexReader {
  /** A file path, or a bucket URI. Never credentials. */
  location(): string;
  /** One read; the backend may cache it for a few seconds. */
  state(): Promise<IndexState>;
  query(query: BackendQuery): Promise<BackendResults>;
  /** The cross-owner feed (`GET /v1/changes/all`); null until every feed has been read once. */
  feed(
    after: FeedPosition | undefined,
    limit: number,
  ): Promise<{ entries: FeedRow[]; more: boolean; through: string } | null>;
  close(): Promise<void>;
}

/** The indexer's side. Every call names the generation it reads or writes, so a run that
 * started before a reset never writes into a rebuild. */
export interface IndexWriter {
  /** The generation writes go to: the live one, or the one being built. */
  generation(): Promise<string>;
  /** Every owner's cursor, once a pass. */
  cursors(gen: string): Promise<Map<string, string>>;
  /** Which of `keys` were already processed (within the lag window). */
  seen(gen: string, owner: string, keys: readonly string[]): Promise<Set<string>>;
  /** What the index holds of these sessions; missing and removed ones are absent. */
  sessions(
    gen: string,
    owner: string,
    archives: readonly string[],
  ): Promise<Map<string, IndexedSession>>;
  /** One feed page. Writing a page twice changes nothing. */
  commit(page: PageCommit): Promise<CommitResult>;
  /** Every owner's feed has been read after `through` (for the cross-owner feed). */
  readThrough(gen: string, through: string): Promise<void>;
  /** A full pass ended at `at`. The first for a generation being built makes it live. False
   * when `gen` is no longer the one writes go to. */
  passDone(gen: string, at: string): Promise<boolean>;
  /** Start a new generation and return it. SQLite empties its file (searches answer 503 until
   * it catches up); LanceDB builds beside the live generation. */
  reset(): Promise<string>;
  /** Housekeeping after a pass: LanceDB's optimize() and scrub; nothing for SQLite. */
  maintain(signal: AbortSignal): Promise<void>;
}

export interface PageCommit {
  generation: string;
  owner: string;
  /** Sessions to index: a replace, or a continuation checked against its `base`. */
  updates: SessionUpdate[];
  /** Tombstones, and sessions no longer admitted. `scrub` when the reason was a deletion,
   * retraction or redaction, so the text must leave the bucket. */
  removals: { archive: string; read_at: number; scrub: boolean }[];
  /** For the cross-owner feed. */
  feed: { name: string; entry: ChangeEntry }[];
  seen: { key: string; at: number }[];
  cursor: string | undefined;
  /** Forget processed keys stamped before this (epoch ms). */
  forgetBefore: number;
}

export interface CommitResult {
  /** `generation` is no longer the one writes go to; nothing that matters was written. */
  stale: boolean;
  /** Continuations whose `base` was not what the index held: plan these again. */
  refused: string[];
  removed: number;
}

export type IndexStore = IndexReader & IndexWriter;

/** What SearchService calls in place of `new SqliteIndex(...)`. */
export type OpenIndex = (options: IndexOptions) => Promise<IndexStore>;
// sqliteIndex({ path }) and lanceIndex(config.search.lance, store)

/** The index cannot be reached, or timed out: the API answers 503, the CLI exits 7. */
export class IndexUnavailable extends Error {
  readonly code = "index_unavailable";
}
```

How the indexer uses it:

- **A pass** reads `generation()` and `cursors(gen)` once.
- **Each page** reads `seen()` and `sessions()` for the archives the page names, plans, then
  calls `commit()`. `Indexer.named()` takes the held `format` from what `sessions()` returned
  instead of reading the index again. A `refused` continuation is planned again and sent in a
  second `commit()`, as `drain()` does today. `stale` ends the pass.
- **After a pass** it calls `readThrough()`, `passDone()` and `maintain()`.

`SqliteIndex.commit()` is today's transaction body. The other changes are mechanical but touch
many call sites, because they become async: `Indexer.pass`, `drain` and `plan`;
`SearchService.status`, `ready`, `search` and `changes`; `readFeed`; the job's `backlog()`; and
`seshi search --status`. `SearchStatus.path` becomes `location`.

Excerpts move out of the backend. SQLite fills `BackendMatch.marked` from FTS5's `snippet()`,
as today. LanceDB returns each matched record's text, and a shared `excerpt(text, tree)` in
`snippet.ts` marks it: it finds the query's words in the text and takes a window of about 24
words with the most of them. `highlights()` reads its output, so the API's offsets keep their
meaning.

## Where the index lives

By default the index is under the store's bucket, at `search/<deployment>/`. Everything else in
the bucket is either the store of record or a server's own files (`config/`, `runtime/`,
`worker/`). `search/` is a third kind: derived, rebuildable, and safe to delete. spec/layout.md
gets an entry saying so, and that it holds redacted session text, so the same people may read it
as may read traces.

Using the bucket means no new storage or credentials: `lanceIndex()` derives LanceDB's
`storageOptions` from `[store]` (endpoint, region, keys, the Azure account or SAS, GCS
credentials). Every store URL seshi accepts maps onto one LanceDB supports: `file://` to a
folder, `s3://` and `r2://` to S3 with an endpoint, `gs://` and `az://` to their own schemes.

`search.lance.uri` overrides the location, for a separate bucket or a local folder on a
single-host deployment. It then takes its own credentials in `[search.lance]`.

Inside the location:

```text
search/<deployment>/
  meta.lance                         key/value: schema, deployment, events, live and building generation, …
  <gen>/events.lance                 one row per searchable record
  <gen>/sessions.lance               one row per session
  <gen>/cursors.lance                owner → cursor
  <gen>/seen.lance                   the lag window's processed keys
  <gen>/changes.lance                the copy of every change entry, for GET /v1/changes/all
```

`<gen>` is a short random id, new on every rebuild.

## Tables

**`events`**: one row per searchable record. Session fields used as filters are copied onto
every row, because LanceDB has no joins.

| Column | Type | Notes |
|---|---|---|
| `id` | string | `owner/archive_id/content_hash/event_index`; the `mergeInsert` key |
| `owner`, `archive_id` | string | |
| `content_hash` | string | The trace the record is in |
| `event_index` | int32 | |
| `role` | string | `user`, `assistant`, `tool_call`, … |
| `tool_name` | string, nullable | |
| `ts` | timestamp(ms), nullable | The event's own time |
| `text` | string | Redacted, as stored; at most `MAX_INDEXED_CHARS` (32 KiB) |
| `text_prefix` | string | The same text, for the prefix index |
| `format`, `origin_agent` | string | Copied from the session, for `agent` |
| `repo`, `branch`, `harness`, `agent_version`, `source_id` | string, nullable | Copied from the session |
| `models` | list\<string\> | Copied from the session |
| `labels` | list\<string\> | Copied from the session as `key=value`. Label keys cannot hold `=`, so the first `=` splits them. |
| `visibility` | string | `org` or `owner` |
| `session_updated` | timestamp(ms) | For `since`, `until` and `sort = recent` |

Indexes on `events`:

- full text on `text`: the default `simple` tokenizer, `lowercase` and `asciiFolding` on,
  `stem: false`, `removeStopWords: false`, and **`withPosition: true`**, which phrases need and
  which 0.41.0 does not default to;
- full text on `text_prefix`: `baseTokenizer: "ngram"`, `prefixOnly: true`, lengths 2 to 12
  (see [prefixes](#query-semantics));
- `labelList` on `models` and `labels`; `bitmap` on `visibility`, `role` and `format`; `btree`
  on `owner`, `archive_id` and `session_updated`.

A session's visibility change, a new branch name or new labels rewrite that session's `events`
rows in the next page's `mergeInsert`. That is rare, and costs one commit like any other page.

**`sessions`**: one row per session. It answers `sessions()` for the indexer, the session fields
of each result, and the counts in `state()`.

| Column | Type | Notes |
|---|---|---|
| `owner`, `archive_id` | string | The key (`id` = `owner/archive_id`) |
| `format`, `session_id`, `origin_agent`, `native_session_id` | string | |
| `project`, `branch`, `repo`, `harness`, `agent_version`, `source_id`, `visibility` | string | |
| `models` | list\<string\> | |
| `labels` | string | JSON, as SQLite keeps it |
| `started_at`, `ended_at` | timestamp(ms), nullable | |
| `updated_at` | string | As the metadata says |
| `updated_ms` | int64 | |
| `traces` | list\<string\> | The traces held; checked when a session is continued |
| `read_at` | int64 | When the indexer read the metadata; an older read is refused |
| `removed` | bool | A tombstone, so a late update read earlier is refused |

**Feed state**: `cursors (owner, cursor)`, `seen (owner, key, at)` and
`changes (stamp, owner, name, entry)`, with `entry` as JSON. `meta (key, value)` sits outside
the generations and holds the schema (`seshi/search-lance/1`), the deployment, `search.events`,
the live and building generations, `ready_at`, `caught_up_at`, `feed_through`, the session and
event counts, and `scrub_due`.

## Query semantics

`lanceIndex()` compiles the `MatchTree` into one LanceDB full-text query:

| Feature | SQLite (FTS5) | LanceDB |
|---|---|---|
| Words in one record | `"a" AND "b"` | `BooleanQuery` of `Must` `MatchQuery` clauses on `text` |
| `"a phrase"`, `src/app.ts` | phrase | `PhraseQuery` on `text` |
| `a OR b` | `OR` | A `Must` clause holding a `BooleanQuery` of `Should` clauses |
| `-word`, `NOT word` | `NOT` | `MustNot` clause |
| Case and accents | `unicode61 remove_diacritics 2` | `lowercase` and `asciiFolding` |
| `word*` | prefix | A candidate clause on `text_prefix`, then a check in TypeScript (below) |

**Tokenizing.** LanceDB tokenizes the query with the index's tokenizer, so documents and
queries agree. Its `simple` tokenizer splits on anything that is not a letter or digit, as
`unicode61` does. `asciiFolding` folds to ASCII where FTS5 only removes accents, so a few
characters (`ß`, `æ`) compare differently. The conformance suite lists them; it is not worth a
normalizer of our own.

**Prefixes.** LanceDB has no prefix query. The `text_prefix` index holds each word's first 2 to
12 characters. A check on 24 November found it over-matches: `dep` also found `delta pepper`,
with either operator. So the prefix clause only narrows the candidates. Each candidate's text is
then read and checked in TypeScript against the word prefix, after the same folding. Prefixes
must be at least 2 characters, and a prefix longer than 12 is checked in full in TypeScript.
`"a phrase"*` uses the phrase of the complete words plus the prefix clause, and the same check.
Prefix queries cost more than others, because they read text; the spike measures how much.

**Filters** are one SQL `where` string on `events`, applied before the search:

- owner: `owner IN (…)`, with aliases folded in;
- visibility: nothing for `viewer.everything`; `owner IN (own)` for `viewer.ownOnly` (X5.10);
  otherwise `visibility = 'org' OR owner IN (own)`;
- agent: `format = … OR origin_agent = …`;
- repo: `lower(repo) = lower(…) OR repo LIKE '%/…'`, as SQLite matches it;
- branch, harness, agent version and source: equality;
- model: `array_has_any(models, […])`; labels: `array_has_all(labels, ['k=v', …])`. Both were
  checked on 0.41.0, with a search, using the `labelList` indexes;
- since and until: `coalesce(ts, session_updated)` in the range, as today.

LanceDB takes the filter as SQL text, with no bound parameters. Every value goes through one
`sqlString()` that doubles quotes and refuses control characters, and `LIKE` values also escape
`%` and `_`. Request values are checked before they get there (`checkRequest`), and the
conformance suite searches with quotes, backslashes and `%` in every filter.

`SearchService` still checks each result against the session's live metadata before it returns
it (F10.4), so the filter only needs to be fast, not authoritative.

**Grouping and paging** happen in TypeScript, without DuckDB:

1. One search selects `owner`, `archive_id`, `id`, `session_updated` and `_score` for every
   matching record, up to `search.lance.max_scored_rows` (100,000 by default). LanceDB returns
   10 rows unless a limit is set, so the limit is always set.
2. Records are grouped by session: `best` is the top `_score`, `hits` the number of records.
   `total` is the number of sessions. When the cap was reached, `total` is a lower bound and the
   response says so.
3. Sessions are sorted by `best` or by `session_updated`, and `offset` and `limit` applied.
   Cursors stay offsets capped at `MAX_OFFSET`.
4. One read of `sessions` for the page, and one read of `events` by `id` for the best
   `matches` records of each session, with their text, role, tool name and time. `excerpt()`
   marks them.

In the probe, counting 13,161 matches in 5,414 sessions this way took 15 ms at 100k records,
and DuckDB's grouped search took about 90 ms at 1M. The spike measures step 1 at 1M records on
real S3. DuckDB is not needed for search; it comes with analytics.

Searches include rows not yet in the index (LanceDB scans them), so a record is searchable as
soon as its page is committed. `fastSearch()` is not used.

**Scores** are BM25 `_score`, higher is better. SQLite's are FTS5's. Both are documented as
comparable within one answer only.

## Ingest

The indexer is the same class, reading the same feeds. What changes is what one write is.

**One writer.** For this backend the `search-index` job's placement is `worker`. API instances
never write. X7.3 still holds: a second worker by mistake is harmless, because writes are
idempotent, `sessions` rows are versioned by `read_at`, and a refused continuation is planned
again. Two writers committing at once to one table conflict, and LanceDB retries or fails the
later commit; the job reports a failure and the next pass reads the page again.

**One page, in order.** `commit(page)` writes into the tables of the generation it names:

1. Check, with no write: each continuation's `base` against what `sessions()` read. Refused
   ones are left out of the page and returned.
2. `events`: one `mergeInsert("id")` with the page's records, `whenMatchedUpdateAll`,
   `whenNotMatchedInsertAll`, and `whenNotMatchedBySourceDelete` limited to the sessions the
   page replaces or removes. One commit inserts, updates and deletes. The scoping probe checked
   this on 0.41.0: a replaced session lost its extra record, a removed one lost all of them, a
   continued one kept its old records, and an untouched one did not change.
3. `sessions`: one `mergeInsert` of the page's sessions, including tombstones.
4. `changes`: the page's feed entries, by `mergeInsert` on `(stamp, owner, name)`.
5. `seen`, then `cursors`.

A crash anywhere leaves the cursor behind the content. The next run reads the same entries and
indexes each session from its metadata as it is now, which is idempotent (spec/layout.md,
"Reading"). `events` comes before `sessions`, so a session row never names traces whose records
are missing. The feed copy is safe for the same reason as today: `feed_through` moves only after
the rows up to it are written.

Each commit makes a table version, so a page costs five or six commits. At the default
`search.interval` that is fine. A first build of a large bucket writes many pages in a row; the
worker runs `optimize()` every 50 pages during a build, not only at the end of a pass.

## Maintenance

`maintain()` runs after each pass, on the worker:

- **`optimize()`** compacts small fragments, adds new rows to the indexes and prunes old
  versions. It runs when more than 10,000 rows are unindexed or every `search.lance.optimize`
  (10 minutes). `cleanupOlderThan` is now minus 15 minutes, so a reader on an older version
  finishes its query. `deleteUnverified` stays off, as LanceDB advises while other processes may
  read.
- **The scrub** is how deleted text leaves the bucket. A check on 24 November deleted one
  session (10 rows) from a 20,000-row table and ran `optimize()` twice: the deleted rows were
  still in the data file, hidden by a deletion file. LanceDB compacts a fragment only when
  enough of it is deleted, and 0.41.0's TypeScript API has no option to force it. So when a
  page removes or replaces a session with `scrub: true`, the worker sets `scrub_due` in `meta`.
  Once a day (`search.lance.scrub`), if a scrub is due, it rewrites each table that holds
  deleted rows: it copies the live rows into a new table in the same generation, builds its
  indexes, switches `meta` to it, and deletes the old table after the 15-minute grace. Indexing
  pauses during the scrub. At 1M records, writing took about 6 s and the index build 3 s in the
  probe.

The bound for deleted text is therefore `search.lance.scrub` plus the grace: a day and a quarter
of an hour by default. That is weaker than SQLite, where the delete is in the transaction, and
`docs/search.md` says so, as it already says the SQLite file holds session text. An operator who
needs it sooner runs `seshi search --scrub`, which asks the worker to scrub on its next pass.

## Rebuild

`reset()` starts a new generation beside the live one:

1. It writes `building_gen` to `meta` and creates the new generation's tables.
2. `generation()` now names the new one. The worker builds it from every feed's start, as a
   first build does. The live generation stops being updated, so search answers from an index
   that is as old as the rebuild. Rebuilds are rare; keeping both current would double the work.
3. The first `passDone()` for the new generation sets `active_gen` to it and clears
   `building_gen`. API instances switch on their next `state()` read. The old generation's
   prefix is deleted after the grace.

Every writer call names its generation, so a run that started before the reset writes only to
the old one, and `commit()` returns `stale`. A new `INDEX_SCHEMA` or a change to
`search.events` starts a rebuild the same way. A different `deployment` in `meta` is an error at
start-up, and nothing is deleted: a shared location is not something to wipe on a config typo.

**`seshi search --status`**, with a server config: the location (no credentials), the live
generation, `ready_at`, `caught_up_at`, counts, and, during a rebuild, the building generation
and how far it has read. The job's `backlog()` reports the same, so `seshi workers status` and
`GET /v1/admin/jobs` show it.

**`seshi search --rebuild`**, with a server config: with SQLite it rebuilds this instance's
file, as today. With LanceDB it writes `building_gen` and returns; the worker does the build,
so there is never a second writer and the build survives the CLI exiting. `--wait` follows
`--status` until the switch.

## Config and deployment

```toml
[search]
enabled = true
backend = "lance"               # "sqlite" (the default) or "lance"
interval = "15s"
events = ["user", "assistant", "tool_call"]

[search.lance]                  # all optional
# uri = "s3://other-bucket/seshi-search"   # default: search/<deployment>/ in the store's bucket
read_consistency = "5s"         # how soon API instances see a commit
optimize = "10m"
scrub = "24h"
max_scored_rows = 100000
# Credentials only when uri is set and differs from [store]: the same fields as [store],
# secrets as { env } or { file }.
```

- `backend` already exists as `z.enum(["sqlite"])` in `config/src/server/search.ts`. It gains
  `"lance"`, and `searchSection` gains `lance`. `path` is ignored for LanceDB, and the config
  check says so.
- **Server-only.** In serverless mode, laptops ignore `search.backend` and `[search.lance]` in
  the shared config, as they ignore `search.path`. Each laptop's index is limited to its own
  scope (F11.9), and laptops must not write a shared index.
- **Dependencies.** `@lancedb/lancedb` and `apache-arrow`, pinned exactly, as server-only
  dependencies of `@seshi/search`, imported lazily by `lanceIndex()`. The hook's import check
  (X3.3) keeps them off the capture path. The native binary is about 250 MB on macOS arm64;
  LanceDB's optional embedding dependencies (`onnxruntime-node`, 180 MB) are left out.
- **Platforms.** The probes ran on macOS arm64. The server image is Linux; the spike checks
  linux-x64 and linux-arm64 under Bun, and the image size.
- **`seshi doctor`** with a server config checks that the location is reachable and writable by
  the worker, that `meta` names this deployment and schema, and how old `caught_up_at` is.

**Tests.**

- A **conformance suite** written once against `IndexStore`: today's `sqlite.test.ts`, the
  relevant parts of `indexer.test.ts`, `service.test.ts` and `feed.test.ts`. It runs against
  SQLite and against LanceDB on a temporary folder in every CI run. It checks matches, phrases,
  prefixes, NOT, filters (with quotes and `%` in the values), visibility and `ownOnly`, grouping
  and paging, order by recency, continuation, replace, retraction, the scrub, the feed copy,
  rebuild and `stale`. Tests of FTS5-specific output (excerpt text, scores) stay SQLite-only.
- **Crash tests** inject a failure between each step of `commit()` and check that reading the
  page again gives the same index.
- **S3**: the same suite against rustfs when `SESHI_TEST_S3_ENDPOINT` is set, as the store's live
  S3 test is gated. CI already runs rustfs (pinned by digest), so no new service is needed.

## Later: analytics and semantic search

Neither is in the first version. Two choices now keep them open:

- The indexer's pass gets a list of sinks, so a later `llm_calls` table (model, provider, times,
  token counts, `stop_reason`, failures, one row per call in a trace) is a second sink, not a
  second indexer. It uses the same keys, generations and scrub, so a retracted session leaves
  spend reports too. Prices are a separate table applied at query time, because traces record
  tokens, not money.
- Aggregation goes through DuckDB's `lance` extension, in-process. In the probe it answered
  counts and group-bys over 1M rows in 5 to 50 ms. A `usage_daily` rollup kept by the indexer
  would keep reports small at any team size seshi expects.

Semantic search (F10.5) can add a vector column and index to `events`, and LanceDB's hybrid
search combines it with BM25.

ClickHouse stays the answer if analytics outgrows an in-process engine: over about a billion
raw rows queried ad hoc, many concurrent dashboard users, or rollups that must update as rows
arrive. The scoping PR has the comparison and the thresholds.

## Alternatives considered

- **ClickHouse** ([scoping](https://github.com/dosu-ai/seshi/blob/8b7d3f9/docs/seshi/clickhouse-search.md)).
  Its `text` index is GA from 26.2 and it was the fastest at aggregation in the probe. But it
  is a service to run, it has no BM25 (a formula in SQL would stand in), and without
  transactions a replace needs per-session epochs and a separate delete. For search at seshi's
  scale it costs more than it gives.
- **DuckLake with Moraine.** Parquet and a catalog in the bucket, queried by DuckDB. It is an
  analytics store with no text index or BM25, so it does not serve search.
- **Keeping per-instance SQLite.** It stays the default. Its cost is that every instance reads
  every feed and holds a full copy, which a shared index removes.

## Risks

- **Pre-1.0 library.** LanceDB's full-text index is its own and recent, and 0.41.0 differs from
  its docs (`withPosition`). Pin exact versions, run the conformance suite on every upgrade, and
  keep SQLite as the default.
- **Deleted text stays up to a day.** Stated above, bounded by the scrub, and on demand with
  `--scrub`. If LanceDB's TypeScript API gains a way to force deletion materialization, the
  scrub becomes an `optimize()` option.
- **The scrub's cost grows with the table.** It rewrites whole tables. At 200M records that may
  take tens of minutes with indexing paused. The spike estimates it; if it is too slow, the
  scrub rewrites by generation in the background, as a rebuild does.
- **Prefix queries read text** to check candidates. If the spike finds them too slow, raise the
  minimum length to 3 or cap the candidates checked.
- **Cold reads from object storage.** The probes used a local S3. Real S3 adds latency to each
  read an API instance makes after a new version, and costs a request per read. The spike
  measures p50 and p95 on a real bucket.
- **Image size.** About 250 MB more in the server image.
- **SQL text in filters.** No bound parameters, so escaping is the only defence. One function
  does it, and the suite tests it with hostile values.

## Open questions

1. **May analytics totals include owner-only sessions,** and for whom? F10.4 covers search
   results, not totals. Not needed until analytics.
2. **How many records and LLM calls does a real session have?** The scale estimates assume about
   150 records and 50 to 100 calls. A count over an existing bucket would replace the guess and
   size the scrub.
3. **Is a lower bound on `total` acceptable** when `max_scored_rows` is reached, or should a
   relevance sort fall back to recent order above it?

## Plan

| Phase | What | Size |
|---|---|---|
| 0. Spike | On Linux and a real S3 bucket, with about 1M real-shaped records: cold and warm latency for 10 representative queries, grouping in TypeScript, prefix checks, a page commit's time, `optimize()` and scrub times, and the image size. | 2–3 days |
| 1. Seam | `IndexReader` and `IndexWriter`, `drain()` onto `commit()`, `MatchTree`, `state()`, `IndexUnavailable`, the `OpenIndex` factory, `SearchStatus.location`, `excerpt()`. SQLite only, with no change in behaviour; existing tests keep their assertions. | 4–6 days |
| 2. Backend | `LanceIndex`: tables and `meta`, `commit()`, the query compiler, filters and escaping, grouping, prefixes, `maintain()` with the scrub, generations. The conformance suite on folder and S3, and the crash tests. | 1.5 weeks |
| 3. Deploy | The config schema, `worker` placement for this backend, `--status`, `--rebuild`, `--wait` and `--scrub`, `doctor` checks, spec/layout.md's `search/` entry, and docs (`docs/search.md`, `docs/config.md`, F10.6–F10.12 in `design-decisions.html`). | 1 week |
| Later | `llm_calls` and DuckDB analytics; semantic search. | Separate decisions |

Phase 1 is worth doing on its own: it makes the indexer's writes explicit and removes the
`transaction(fn)` callback, whichever backend follows.
