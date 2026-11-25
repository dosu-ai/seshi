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
