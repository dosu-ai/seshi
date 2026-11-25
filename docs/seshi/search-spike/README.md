# Search spike: LanceDB on GCS

Phase 0 of [lancedb-search.md](../lancedb-search.md). It measures that design on Linux with a real
bucket, using synthetic sessions shaped like the sample in the design's [sizes](../lancedb-search.md#sizes),
at 1M and 10M searchable records. It ran on 24 and 25 November 2026.

Nothing here is product code. The scripts are kept so the numbers can be checked and run again.

## Setup

- **Machine:** a GCE `e2-standard-8` (8 vCPU, 32 GB) in `us-west1-a`, Debian 12, linux-x64.
- **Bucket:** a GCS Standard bucket in `us-west1`. LanceDB and DuckDB both read credentials
  from the metadata server, with no storage options.
- **Versions:** Bun 1.4.2, `@lancedb/lancedb` 0.41.0, `apache-arrow` 21.2.0, and
  `@duckdb/node-api` 2.0.1-r.1 with the `lance` extension.
- **Data** (`common.ts`): the `events` and `sessions` schemas from the design. Records per
  session are log-normal (median 37, p90 about 194, capped at 16,000), and there are 889
  characters per record. Text is drawn from a 40,000-word vocabulary with a Zipf(1.07)
  frequency, plus tool calls with JSON arguments and paths. 50 owners, 120 days, 85% of
  sessions visible to the org, 20% labelled `dosu.project=app`. The query words sit at known
  ranks: `the` and `error` are very common, `rollback` and `deployer` are mid-frequency,
  `zeppelinx` is in about 1 record in 100,000, and "the flaky checkout test failed again" is
  appended to 0.5% of records. No customer data was used.

## Scripts

| Script | What it does |
|---|---|
| `gen.ts <uri> <records>` | Writes the tables in batches of 100k, builds every index from the design, runs `optimize()`, and prints the time for each step. |
| `bench.ts <uri> [runs] [--cap N] [--sort S]` | The search path from the design: one full-text search with the filter, grouping in TypeScript over Arrow, a page of 20, then the page's sessions and best three records. 8 query shapes × 3 filters × 2 sorts. Each case runs first on a new connection, then `runs` times. |
| `duck.ts <events.lance> [runs] [--no-shapes]` | Which query shapes `lance_fts` takes, then the relevance page grouped in DuckDB SQL. |
| `commit.ts <uri> [pages] [--split] [--scrub]` | Commits feed-shaped pages: 15 new sessions, 4 replaced, 1 removed and 30 continued per page. Then `optimize()`, whether deleted rows leave the files, and the scrub (copy the live rows to a new table and index it). `--split` commits differently; see [commits](#commits). |
| `optimize.ts <uri>` | Runs `optimize()` on `events` and reports fragments, deleted rows and rows not yet in the text index, before and after. |
| `and.ts <uri> [runs]` | Two words that must both match, as a `BooleanQuery` and as one `MatchQuery` with `Operator.And`, at two caps. |
| `addidx.ts <uri>` | Adds the btree on `events.id` to a table built before `gen.ts` had it. |
| `vm/` | The VM's startup script (`agent.sh`) runs each `jobs/*.sh` it finds in the bucket and uploads the log to `results/`. This avoided opening SSH in the staging project. `run.sh` is the full run for one size. |

Locally, against a folder:

```bash
bun install
bun gen.ts data/small 100000
bun bench.ts data/small 5
```

On GCE: create a VM with `vm/agent.sh` as its startup script and `spike-bucket` set in its
metadata, copy the scripts to `gs://<bucket>/harness/`, and put a job in `gs://<bucket>/jobs/`.
`results/` holds the raw logs of the runs below.

## Results

Times are milliseconds unless marked otherwise. "First" is the first query on a new
connection: it opens the table and reads index metadata from the bucket.

### Build

| | 1M | 10M |
|---|---|---|
| Sessions | 11,927 | 117,240 |
| Write (batches of 100k) | 71 s | 700 s |
| FTS index on `text` | 30 s | 207 s |
| FTS ngram index on `text_prefix` | 11 s | 71 s |
| Scalar indexes (btree, bitmap, labelList) | 5 s | 32 s |
| `optimize()` after the build | 65 s | 545 s |
| Total | 3 min | 26 min |
| Peak memory | 3.6 GB | 10.4 GB |
| `events` size (Lance stats) | 1.04 GB | 10.4 GB |
| `events.lance` in the bucket | 2.07 GB | 20.8 GB |

The bucket holds about twice the table's size: the indexes and the versions `optimize()` had
not yet removed.

### Search, grouped in TypeScript

The relevance page with the cap at 100,000 scored rows. Warm p50, with the first query in
brackets:

| Query | 1M, admin | 1M, member | 10M, admin | 10M, member | 10M, member + label + model |
|---|---|---|---|---|---|
| Rare word (`zeppelinx`) | 124 (1,183) | 124 | 225 (2,568) | 215 | 130 |
| One common word (`error`) | 749 (1,829) | 723 | 1,176 (2,814) | 1,423 | 1,043 |
| Two common words, AND | 991 (2,216) | 955 | 5,237 (11,863) | 5,055 | 1,725 |
| Phrase (`flaky checkout test`) | 189 | 175 | 562 | 529 | 646 |
| NOT (`deploy -staging`) | 665 | 648 | 1,545 | 1,564 | 1,213 |
| OR (`rollback OR deployer`) | 286 | 267 | 855 | 984 | 525 |
| Very common word (`the`) | 744 | 725 | 1,223 | 1,517 | 1,194 |
| Prefix (`deplo*`) | 634 | 642 | 7,124 (11,091) | 6,325 | 3,665 |

The recent page (windows of a day, a week, a month, then everything), warm p50:

| Query | 1M, admin | 10M, admin | 10M, member | 10M, member + label + model |
|---|---|---|---|---|
| Rare word | 234 | 337 | 421 | 304 |
| One common word | 150 | 623 | 609 | 239 |
| Two common words, AND | 228 | 1,427 | 1,416 | 887 |
| Phrase | 113 | 327 | 364 | 471 |
| NOT | 180 | 1,020 | 1,041 | 596 |
| OR | 126 | 499 | 489 | 255 |
| `the` | 153 | 664 | 632 | 225 |
| Prefix | 192 | 974 | 916 | 355 |

Where the time goes, for a query that reaches the cap (`error` at 10M, admin): 844 ms in
LanceDB's search, 203 ms grouping 100,000 rows in TypeScript, 107 ms fetching the page's
sessions and records. The fetch was about 200 ms until `events.id` had a btree index; with it,
50 to 150 ms.

#### After commits, before `optimize()`, and the cap

`commit.ts` added ten pages to the 10M table (18,188 rows not yet in the text index, in ten
new fragments, with 4,476 deleted rows). The relevance page, warm p50, admin unless marked:

| Query | Cap 100k, before `optimize()` | Cap 100k, after | Cap 10k, after |
|---|---|---|---|
| Rare word | 408 | 243 | 236 |
| One common word | 2,937 | 1,329 | 485 |
| Two common words, AND | 13,133 | 5,509 | 4,969 |
| Phrase | 1,578 | 567 | 401 |
| NOT | 5,380 | 1,509 | 670 |
| OR | 1,021 | 883 | 502 |
| `the` | 3,268 | 1,350 | 488 |
| Prefix | 17,760 | 6,673 | 4,558 |
| One common word, member + label + model | 5,290 | 1,037 | 877 |

`optimize()` took 502 s and brought every row into the indexes; the deleted rows stayed. A cap
of 10,000 halves most broad queries, because grouping 10,000 rows takes about 17 ms instead of
about 210 ms and the search returns fewer. It does not help AND of two common words or the
prefix, where LanceDB's search is the cost.

The AND case is the query's shape, not the index (`and.ts`, after `optimize()`, warm p50):

| Two common words (`error test`) | Cap 10k | Cap 100k |
|---|---|---|
| `BooleanQuery` of two `Must` `MatchQuery` clauses (what `bench.ts` runs) | 4,658 | 5,041 |
| One `MatchQuery("error test")` with `Operator.And` | 520 | 1,584 |

Both returned the same number of rows (10,000, 100,000, and 2,059 for two mid-frequency words,
where the shapes took about the same time). The row sets were not compared one by one.

The recent page with a cap of 10k ran only before `optimize()` (`results/10m-cap10k.raw.log`),
so it is not in the table. With the smaller cap, the day and week windows of a broad query
reach the cap and fall through to wider ones, so the recent page needs the larger cap or its
own.

### DuckDB

`lance_fts(path, 'text', query, k := …)` reads its query as words joined by OR. At 1M:

| Query string | Records `lance_fts` matched | What it means |
|---|---|---|
| `error` | 729,624 | |
| `error test` | 858,473 | OR, not AND |
| `error AND test`, `+error +test` | 858,473 | No syntax for AND |
| `"flaky checkout test"` | 608,391 | Not a phrase: LanceDB's `PhraseQuery` matched 5,050 |
| `deploy -staging` | 407,938 | No NOT |

Its `filter` argument works only for namespace-backed tables, so the filter here is an outer
`WHERE`, applied after the top `k`. That drops matches: at 1M, `error` for member `u1` found
8,794 sessions in DuckDB and 9,018 in TypeScript.

The relevance page grouped in SQL, warm p50, against the same steps in TypeScript (search plus
grouping in the last warm run, without the fetch). Both are admin, with no filter:

| Query | 1M DuckDB | 1M TypeScript | 10M DuckDB | 10M TypeScript |
|---|---|---|---|---|
| `zeppelinx` | 108 | 52 | 543 | 144 |
| `error` | 1,495 | 657 | 15,957 | 1,047 |
| `rollback deployer` (OR) | 839 | 209 | 15,224 | 735 |
| `the` | 1,535 | 665 | 16,023 | 1,114 |

At 10M, DuckDB was 10 to 20 times slower on broad queries, using 1.8 CPU cores for the whole
query. The filter after the top `k` also lost more: `error` for member `u1` found 38,642
sessions in DuckDB and 42,205 in TypeScript. The shape probes, which ask for every match
(`k := 10M`), failed at 10M: the first with an Arrow offset overflow (more than 2 GB of text in
one batch), the second killed for memory on the 32 GB machine.

DuckDB's `lance` extension and bindings add 93 MB on linux-x64 (glibc).

### Commits

Each page holds about 1,300 to 2,600 records: 15 new sessions, 4 replaced, 1 removed and 30
continued by 20 records.

| Way to commit `events` | 1M, p50 | 10M, p50 | 10M, max |
|---|---|---|---|
| One `mergeInsert("id")` with `whenNotMatchedBySourceDelete` (the design) | 1,337 | 8,614 | 10,361 |
| `--split`: `mergeInsert("id")` with no by-source clause, then `delete()` | | 790 | 1,543 |

With a by-source clause, LanceDB has to scan the whole target to find rows the page does not
hold, so the commit grows with the table. Without one, it finds matches through the btree on
`id`, and `delete(archive_id IN (…) AND content_hash NOT IN (…))` through the btree on
`archive_id`. In the split runs the merge took 450 to 1,000 ms and the delete 290 to 520 ms.
The `sessions` table's `mergeInsert` took about 300 ms at either size.

At 8.6 s a page, the single commit indexes about 200 records a second. A 50-person team adds
about one a second, but a first build of a year (about 32M records) would take two days. Split,
it is about 2,500 a second.

### Maintenance

| | 1M | 10M |
|---|---|---|
| `optimize()` after 5 pages | 58 s | 518 s |
| `optimize()` after 10 more pages (split) | | 502 s |
| Deleted rows in the files, before and after `optimize()` | 1,293 → 1,293 | 1,293 → 1,293 |
| Scrub: copy the live rows | 19 s | 182 s |
| Scrub: FTS on `text` | 38 s | 211 s |
| Scrub: ngram FTS on `text_prefix` | 11 s | 68 s |
| Scrub: scalar indexes | 4.5 s | 26 s |
| Scrub total | 73 s | 487 s (8 min) |
| Peak memory (commits, optimize and scrub) | 5.7 GB | 14.0 GB |

`optimize()` merged the five commits' fragments but left every deleted row in place, as the
scoping probe found locally. The copy had none.

### Image size (linux-x64)

| Package | glibc | musl |
|---|---|---|
| `@lancedb/lancedb` native binary | 205 MB | 171 MB |
| `@duckdb/node-bindings` | 93 MB | 89 MB |
| `apache-arrow` | 8.5 MB | |

Bun installs both the glibc and musl binaries; an image needs only one.

## Findings

1. **Group in TypeScript.** DuckDB was 2 to 4 times slower at 1M and 10 to 20 times at 10M,
   handles only OR of words, and filters after the top `k`.
2. **Commit `events` in two steps.** `whenNotMatchedBySourceDelete` scans the whole table: 8.6 s
   a page at 10M. An indexed `mergeInsert` and then a `delete()` took 0.8 s.
3. **Index `events.id`.** Without a btree on `id`, fetching a page's records took about 200 ms;
   with it, 50 to 150 ms.
4. **Words that must all match go in one `MatchQuery` with `Operator.And`,** not a
   `BooleanQuery` of `Must` clauses: 0.5 s against 4.7 s for two common words at 10M.
5. **Cap the scored rows at 10,000 for relevance.** Broad queries at 10M fall from 1.3 to 1.5 s
   to about 0.5 s. The recent page keeps a larger cap, because its windows fill from it.
6. **`optimize()` is the cost that grows.** It took 1 minute at 1M and 8 to 9 minutes at 10M,
   whatever had changed, and skipping it made broad searches two to three times slower. A
   scrub (copy and re-index) costs about the same and also removes deleted rows, which
   `optimize()` never did here.
7. **Prefix queries are slow at 10M:** 4.6 s at cap 10k, 6.7 s at 100k, and 2 to 3.5 s with a
   label filter. The ngram index matches all of a prefix's ngrams, so about half its candidates
   fail the check in TypeScript (57,298 of 100,000 kept for `deplo`).
8. **The first query on a new connection** takes 1 to 3 s at 10M (reading index metadata from
   the bucket); later ones do not. API instances should open the tables at start-up and keep
   them.
9. **Building is fast if batched.** Writing 100,000-row batches ran at 14,000 records a second;
   indexes for 10M records took 5 minutes. Peak memory was 10 GB for the build and 14 GB for
   the scrub at 10M.

## Re-measure of the shipped code, 25 November 2026

The numbers above measured the design with raw LanceDB calls. This section measures what phases
2 and 3 built: `LanceIndex` (`@seshi/lance`) and the `Indexer`, with their query compiler,
filters, caps, grouping, recent windows, the `text_prefix` prefix check, the two-step commit,
the build-time `optimize()`, `maintain()` and the scrub. It ran on 25 November 2026 against
`devstein/lance-image-size` (seshi 0.28.0, before the stack merged), on the same machine type,
zone, versions and data shapes as the spike: an `e2-standard-8` in `us-west1-a` and a new
bucket in `us-west1`, through the same `vm/agent.sh` job runner. No customer data was used.

### Scripts (`shipped/`)

| Script | What it does |
|---|---|
| `data.ts` | The spike's generator (`common.ts`) as `IndexedSession` and `IndexedEvent`, one owner at a time: same vocabulary, Zipf(1.07), record counts, placed words and phrase. |
| `build.ts <uri> <records>` | A first build through `LanceIndex.commit()`: each owner's sessions gathered into commits of `batchRecords()` (50,000), as the `Indexer` gathers them, with the build-time `optimize()` every 100,000 rows that `commit()` runs; then `passDone()`, which builds the full-text indexes. Times each commit, each `optimize()` and the index build. |
| `search.ts <uri> [runs] [--sort S] [--only Q]` | `LanceIndex.query()` on a read-only index, as an API instance runs it: the spike's 7 query shapes plus 8 prefix shapes, × 3 filters (admin; a member; a member with a label and a model) × 2 sorts. Each case first on a new index (the open and the first query timed apart), then `runs` times warm. |
| `steady.ts <uri> commit N \| optimize \| scrub \| maintain` | Feed-shaped pages as the spike's `commit.ts` (15 new sessions, 4 replaced, 1 removed, 30 continued by 20 records), each step of `commit()` timed through `beforeStep`; `maintain()` as the worker runs it (every table optimized); a page whose removal is a deletion, then `maintain()`, which scrubs. The scrub's index builds are timed one by one. |
| `store.ts <store-url> <records>` | A synthetic store: the same sessions written as Trajectory logs through `StoreSeshi.ingest`, for the end-to-end build. |
| `http.ts <base-url> <token>` | Searches through a running `seshi serve --roles api` (`GET /v1/search`). |
| `vm/job-1m.sh`, `vm/job-10m.sh`, `vm/job-10m-scrub.sh` | The runs below. `vm/setup.sh` unpacks the branch, installs it and builds the server binary (`scripts/build-binary.ts --server`, LanceDB's library stripped), which the 1M job runs end to end. |

Raw logs: `results/shipped-1m.raw.log`, `results/shipped-10m.raw.log` and
`results/shipped-10m-scrub.raw.log` (the API token is masked).

### Build

| | 1M | 10M | Spike, 1M / 10M |
|---|---|---|---|
| Records, sessions | 1,000,072, 11,695 | 10,000,054, 117,446 | |
| Commits | 50 (one per owner: 20,000 records never fill a 50,000 batch) | 246 | |
| Commits, including the build-time `optimize()` | 370 s | 4,728 s | |
| of which the build-time `optimize()` | 9 runs, 135 s | 99 runs, 2,743 s (46 min) | |
| `passDone()`: full-text indexes on `text` and `text_prefix` | 62 s | 413 s | 41 s / 278 s |
| Total | 7.2 min, 2,313 records/s | 85.7 min, 1,945 records/s | 3 min / 26 min |
| Peak memory | 3.2 GB | 13.2 GB | 3.6 / 10.4 GB |
| Index in the bucket, after the build | 7.4 GB | 43.5 GB | `events.lance` 2.1 / 20.8 GB |

A commit of 50,000 records took about 8 s without an `optimize()`. The build-time `optimize()`
grew with the table, from 8 s at 100,000 rows to 35 to 46 s past 9M, and it runs every 100,000
rows, so its total grows with the square of the build: 31% of the time at 1M, 53% at 10M.
Throughput fell from 2,750 records a second at 2M to 2,100 at 10M. By the same curve a year of
a 50-person team (32M records) would take about ten hours to build, eight of them in
`optimize()`.

**End to end at 1M, through the server binary.** `store.ts` wrote 11,695 sessions (1,000,072
records) to a store in the bucket in 4 minutes (622 MB). `seshi sync search --config` (the
stripped `seshi-server` binary, `Indexer` with `searchWriter`) then built the index in one pass:
**11.9 minutes, 1,394 records a second, 3.5 GB peak**, against 7.2 minutes driving
`LanceIndex` directly; the difference is reading the store's feeds, metadata and traces. The
store held change entries for 10,630 of the sessions (992,726 records), and the indexer indexed
every one; where the other 1,065 went in the synthetic writer was not looked into. The index
was 10.3 GB in the bucket.

### Search

Warm p50 in milliseconds, admin, relevance. The spike's column is its 10M run with the 10,000
cap after `optimize()`, the configuration that shipped (its prefix row used the ngram index that
missed most matches).

| Query | 1M | 10M | 10M, member + label + model | 10M, after 10 pages, before `optimize()` | Spike, 10M |
|---|---|---|---|---|---|
| Rare word (`zeppelinx`) | 164 | 335 | 200 | 431 | 236 |
| One common word (`error`) | 370 | 908 | 1,438 | 1,703 | 485 |
| Two common words (`error test`) | 367 | 807 | 1,201 | 1,544 | 520 |
| Phrase (`"flaky checkout test"`) | 346 | 689 | 916 | 1,470 | 401 |
| NOT (`deploy -staging`) | 438 | 1,302 | 1,245 | 4,201 | 670 |
| OR (`rollback OR deployer`) | 304 | 745 | 1,084 | 818 | 502 |
| Very common word (`the`) | 334 | 926 | 1,634 | 1,780 | 488 |
| Prefix, common (`deplo*`) | 1,127 | 6,049 | 3,768 | 7,049 | 4,558 |
| Prefix, 2 letters (`de*`) | 1,126 | 5,960 | 3,660 | 6,982 | |
| Prefix, mid-frequency (`rollb*`) | 1,479 | 5,830 | 2,404 | 7,170 | |
| Prefix, rare (`zeppel*`) | 139 | 346 | 197 | 525 | |
| Prefix past 8 letters (`deployment*`) | 1,237 | 6,095 | 3,615 | 7,166 | |
| Word and prefix (`error deplo*`) | 1,550 | 10,068 | 4,089 | 15,134 | |
| Phrase and prefix (`"checkout test fail"*`) | 1,507 | 6,047 | 2,522 | 6,002 | |
| NOT a prefix (`error -deplo*`) | 1,329 | 6,181 | 4,031 | 7,297 | |

The recent sort, warm p50, admin:

| Query | 1M | 10M | 10M, member + label + model | Spike, 10M |
|---|---|---|---|---|
| Rare word | 150 | 293 | 190 | 337 |
| One common word | 1,326 | 3,583 | 2,415 | 623 |
| Two common words | 1,232 | 2,435 | 1,815 | 1,427 |
| Phrase | 276 | 614 | 973 | 327 |
| NOT | 1,159 | 2,782 | 1,872 | 1,020 |
| OR | 403 | 1,447 | 975 | 499 |
| `the` | 1,406 | 3,719 | 2,656 | 664 |
| `deplo*` | 3,451 | 11,938 | 7,108 | 974 |
| `de*` | 3,197 | 12,523 | 6,931 | |
| `rollb*` | 1,601 | 12,773 | 2,485 | |
| `deployment*` | 4,976 | 10,812 | 7,393 | |
| `error deplo*` | 4,118 | 16,401 | 8,521 | |
| `error -deplo*` | 4,707 | 14,499 | 9,121 | |

- **Cold.** Opening a read-only index took 160 to 370 ms at either size. The first query on it
  took 1.2 to 3 s at 1M; at 10M, 1.7 to 3.8 s for words, 8 to 12.5 s for prefixes and 13 to 19
  s for recent prefixes.
- **Prefixes are the slow case, and grow with the table:** 1.1 to 1.5 s at 1M, 6 s at 10M, 10 s
  with a word beside them, 11 to 16 s sorted by recent. Their candidates are exact, but every
  candidate's `text` is read from the bucket and checked in TypeScript, up to the cap: 10,000
  records for relevance, 100,000 for each recent search. A filter that narrows the candidates
  helps (3.6 s for `deplo*` with a label and a model). The spike's ngram index, which missed
  most matches, took 4.6 s; the shipped design is slower, not "no worse".
- **The recent sort** first runs one search at the 100,000 cap; only when that is capped does it
  look back a day, a week, a month. A broad word so pays for a 100,000-row search and then a
  day's search: 3.6 s at 10M, six times the spike, which started with the windows. (The data
  spans 120 days, so a capped recent total counts only the last day's sessions: 885 where
  relevance counts 8,484.)
- **Words** are 1.4 to 2 times the spike's numbers at 10M (`error` 0.9 s against 0.5 s), on a
  table that also holds `text_prefix`.
- **After ten pages and before `optimize()`**, broad searches took about twice as long and NOT
  three times, as the spike found.
- **Through the API** (1M, `seshi serve --roles api` from the binary, warm p50): `zeppelinx`
  208, `error` 420, `deplo*` 1,160, `error deplo*` 1,402; recent `error` 1,732 and `deplo*`
  5,163 (every e2e session was written that day, so the day window holds all of them). The
  first request took 2.6 s. A cold `seshi-server search` from the CLI took 2.0 to 3.0 s and
  360 to 590 MB. These match the scripts' numbers: the server adds little.

### Steady state

Feed-shaped pages after the build (1,300 to 4,500 records each), `optimizeEvery` 0, p50:

| `commit()` step | 1M | 10M |
|---|---|---|
| Check continuations (`sessions()`) | 455 | 597 |
| `events` `mergeInsert` | 656 | 661 |
| `events` `delete` | 297 | 337 |
| `sessions` | 264 | 265 |
| `seen` | 504 | 497 |
| `cursors` | 347 | 343 |
| **Page** | **2,545** (p90 3,294) | **2,707** (p90 3,400) |

The two `events` steps took about 1 s, as in the spike's split commit. The whole page takes
2.7 s, because each of the other steps is a read or a commit to the bucket of 250 to 600 ms.
That indexes about 700 records a second, against a 50-person team's one.

| Maintenance | 1M | 10M | Spike, 1M / 10M |
|---|---|---|---|
| `maintain()`, optimizing every table | 135 s, 3.7 GB peak | **1,021 s (17 min)**, 13.2 GB | 58 s / 502 to 518 s |
| `maintain()`, scrubbing | 89 s, 4.7 GB | **failed** with LanceDB's default memory pool; 671 s (11 min), 10.9 GB with an 8 GB pool | 73 s / 487 s |

**The scrub fails at 10M.** It copied the 10M live rows into a new table, then failed building
the copy's first scalar index, the btree on `events.id`: LanceDB's sort ran out of its memory
pool (`Resources exhausted … fair(pool_size: 1200.0 MB)`), at 7.2 GB of process memory on a
32 GB machine, after 3.5 minutes. It failed the same way when run again. The build never meets
this, because it creates the scalar indexes on empty tables and lets `optimize()` extend them.
With `LANCE_MEM_POOL_SIZE` at 8 GB (`vm/job-10m-scrub.sh`) the same scrub finished in 671 s
(11 minutes) at 10.9 GB peak: copying the rows about 210 s, the nine scalar indexes 31 s (the
btree on `id` 6.5 s), the full-text index on `text` 156 s and on `text_prefix` 273 s. The prefix
column's index costs more than the text's. After the scrub and before the grace had passed,
the bucket held 79.2 GB: the old tables in the trash and the two failed attempts' copies.
Broad words searched after the scrub took 1.4 to 1.6 s warm (two runs), against 0.8 to 0.9 s
after the build; this was not looked into.

A failed scrub also leaves the worker stuck: `scrub_due` stays set and `scrubbed_at` is not
written, so every pass tries the scrub again instead of `optimize()`, and each attempt leaves a
copy of `events` that nothing drops (4.5 GB here; the bucket grew from 43.5 to 48.0 GB).

### What changed from the spike

1. **Maintenance doubled.** `optimize()` takes 2.3 times the spike's at 1M and twice at 10M (17
   minutes). Hourly, that is 28% of the worker's time at 10M, with indexing paused.
2. **The scrub does not finish at 10M** with LanceDB's default memory pool (it did in 11
   minutes with an 8 GB pool), and a failed scrub blocks `optimize()` from then on.
3. **Prefixes take 6 s at 10M, 10 to 16 s combined with a word or sorted by recent,** where
   the design expected them to do no worse than the spike's 4.6 s.
4. **Recent sort is 6 to 9 times the spike's** for one broad word (3.6 s at 10M), because the
   shipped path searches at the 100,000 cap before it windows.
5. **A first build is 3 times slower** (86 minutes at 10M, against 26) and grows faster than
   the table, because the build-time `optimize()` grows with it; through the `Indexer`, 1.7
   times slower again at 1M.
6. **The bucket holds 2 to 3.6 times the spike's `events.lance`** (43.5 GB at 10M).
7. **A steady page takes 2.7 s**, not 0.8 s: the design quoted the `events` steps alone.
8. **Words are 1.4 to 2 times slower at 10M** (0.7 to 1.3 s for broad queries); a rare word
   is 0.2 to 0.35 s.
