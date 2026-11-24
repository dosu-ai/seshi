# Search backend probes

The scripts behind the LanceDB and DuckDB findings in
[`../clickhouse-search.md`](../clickhouse-search.md#an-alternative-lancedb), with their raw
output. They are throwaway probes, not tests: this folder is outside the workspace, Biome and
the typecheck, and has its own pinned dependencies.

**Where it ran:** 23 November 2026, on one MacBook (macOS, arm64), with:

- Bun 1.4.2 (the repo's `.bun-version`);
- `@lancedb/lancedb` 0.41.0, `apache-arrow` 21.2.0, `@duckdb/node-api` 2.0.1-r.1 (DuckDB
  2.0.1, `lance` core extension);
- for S3, `rustfs/rustfs:1.0.5`, the image pinned in `.github/workflows/ci.yml`, on localhost;
- ClickHouse `clickhouse/clickhouse-server:26.3` (26.3.70.5) in Docker.

The S3 is local, so there is no network latency: cold reads from a real bucket will be slower.
The data is synthetic: 40 words per record from a skewed 20,000-word vocabulary. Read the
timings as orders of magnitude, not a benchmark. Linux, the server image's platform, was not
tried.

## Running them

```bash
cd docs/seshi/search-probe && bun install
```

A local S3, for the scripts that take an `s3://` URI:

```bash
docker run -d --rm --name lance-probe-s3 -p 19000:9000 -e RUSTFS_ACCESS_KEY=rustfsadmin -e RUSTFS_SECRET_KEY=rustfsadmin rustfs/rustfs:1.0.5@sha256:b81d16a90ee25bd9511280127ca1471788c6e874cf0f0da759645f46b2dc1d74
```

```bash
AWS_ACCESS_KEY_ID=rustfsadmin AWS_SECRET_ACCESS_KEY=rustfsadmin AWS_DEFAULT_REGION=us-east-1 aws --endpoint-url http://127.0.0.1:19000 s3 mb s3://lance-probe
```

The storage options the LanceDB scripts take as their second argument:

```json
{"aws_access_key_id":"rustfsadmin","aws_secret_access_key":"rustfsadmin","aws_endpoint":"http://127.0.0.1:19000","aws_region":"us-east-1","allow_http":"true"}
```

| Script | What it does |
|---|---|
| `probe.ts <uri> [options]` | Query features on six records: AND, OR, phrase, NOT, accents, case, a visibility filter, unindexed rows, delete, upsert, `optimize()`, a second connection |
| `cleanup.ts <uri> <options>` | After `probe.ts`: two more `optimize()` runs with version pruning and `deleteUnverified`, to see when deleted text leaves the data files |
| `scale.ts <uri> <options>` | 100k records: write, index build, query latency from a fresh connection |
| `count.ts` | 100k records in `./count-data`: `countRows(filter)`, and counting search matches and sessions in TypeScript |
| `gen.ts <uri> [options]` | 1M records with owner, model and token columns, an FTS index, then `optimize()` |
| `duck.ts <path to .lance> [setup SQL]` | DuckDB with the `lance` extension against `gen.ts`'s table: aggregations, `lance_fts` with grouping, a copy into memory. For S3, set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT`, `AWS_ALLOW_HTTP=true` and `AWS_REGION`: the extension did not take DuckDB's S3 secret for a custom endpoint. |
| `export.ts` | `./big/events.lance` to `./chfiles/events.parquet`, for ClickHouse |
| `clickhouse.sh` | Loads that Parquet file into ClickHouse 26.3 with a `text` index and runs the same queries as `duck.ts` |

## Results

### Query features (`probe.ts`), on S3

Scores are BM25 `_score`. The output on a local folder was the same.

```text
indices: [ "text_idx:FTS" ]
AND: flaky checkout: [ "b2:0 3.263", "a1:0 1.946" ]
OR (plain string): deploy production: [ "a2:0 2.332", "b1:0 2.187" ]
phrase: "git push force": [ "a1:1 4.621" ]
phrase via punctuation: "src/app.ts": [ "b1:1 3.746" ]
NOT: deploy -staging: [ "b1:0 1.094" ]
accents: cafe ferme: [ "b1:1 2.497" ]
case: CHECKOUT: [ "b2:0 1.723", "a1:0 0.973" ]
prefix deploy* (fuzzy is not prefix; plain match only): [ "a2:0 1.166", "b1:0 1.094" ]
visibility filter as viewer alice (org or own): [ "a2:0 1.166", "b1:0 1.094" ]
unindexed row, default search: [ "c1:0 1.993" ]
unindexed row, fastSearch(): []
after delete b1: deploy: [ "a2:0 1.166" ]
after upsert a2: rollback: [ "a2:0 2.264" ]
optimize: {"compaction":{"fragmentsRemoved":3,"fragmentsAdded":2,"filesRemoved":4,"filesAdded":2},"prune":{"bytesRemoved":6444,"oldVersionsRemoved":5}}
after optimize, fastSearch zeppelin: [ "c1:0 1.551" ]
version: 8
rows: 5
reader rows: 5
runtime: bun 1.4.2
```

### Deleted text in the bucket (`probe.ts`, then `cleanup.ts`)

The bucket was downloaded and searched byte for byte for the text of the deleted session (`b1`)
and the replaced one (`a2`).

- **After `probe.ts`**, whose one `optimize()` used `cleanupOlderThan: new Date()`: both texts were
  still in one data file, hidden by a `_deletions` file.
- **After `cleanup.ts`**, whose `optimize()` used `cleanupOlderThan: new Date()` and
  `deleteUnverified: true`: neither text was anywhere in the bucket, and no `_deletions` file was
  left.

```text
optimize 1: {"compaction":{"fragmentsRemoved":2,"fragmentsAdded":1,"filesRemoved":2,"filesAdded":1},"prune":{"bytesRemoved":21985,"oldVersionsRemoved":3}}
optimize 2: {"compaction":{"fragmentsRemoved":0,"fragmentsAdded":0,"filesRemoved":0,"filesAdded":0},"prune":{"bytesRemoved":13708,"oldVersionsRemoved":1}}
stats: {"totalBytes":11048,"numRows":5,"numIndices":1,"fragmentStats":{"numFragments":1,"numSmallFragments":1,"lengths":{"min":5,"max":5,"mean":5,"p25":5,"p50":5,"p75":5,"p99":5}},"numDeletedRows":0}
```

### 100k records (`scale.ts`), on S3

The first run, with `Index.fts()` left at its defaults, failed on the phrase query:
`position is not found but required for phrase queries`. In 0.41.0, `withPosition` defaults to
false, although the type docs say true. With `withPosition: true`:

```text
write 100000 rows: 383ms
build FTS index: 458ms
rare word: first 15ms, then 2/1/1/1ms (1 rows)
two common words AND: first 32ms, then 25/24/24/25ms (100 rows)
phrase: first 11ms, then 4/4/4/4ms (100 rows)
common + visibility filter: first 12ms, then 8/7/7/7ms (100 rows)
```

### Counting (`count.ts`), on a local folder

A search returns 10 rows unless `limit()` is set; the first run counted 10 matches for `error`.
With `.limit(1_000_000)`:

```text
countRows("visibility = 'org'") = 85714 in 3ms
FTS "w300": 1645 matching records, 1220 sessions, counted in TS in 13ms
FTS "error": 13161 matching records, 5414 sessions, counted in TS in 15ms
```

### 1M records: DuckDB with `lance` against ClickHouse

`gen.ts`, writing the table:

| | Local folder | S3 |
|---|---|---|
| Write 1M records | 5.9 s | 6.8 s |
| FTS index build | 3.2 s | 3.2 s |
| `optimize()` | 6.8 s | 7.2 s |
| Size | 389 MB | not measured |

Loading the same rows into ClickHouse took 1.7–1.8 s, and they take 189 MiB on disk.

The first `INSTALL lance` downloaded the extension in 6.1 s; after that, loading it took
100–260 ms. Each query ran three times, in milliseconds for DuckDB and seconds for ClickHouse.

`duck.ts` on a local folder:

```text
count(*): 4/0/0ms -> [{"n":"1000000"}]
count by visibility: 7/5/5ms -> [{"visibility":"org","n":"857142"},{"visibility":"owner","n":"142858"}]
tokens by model: 9/8/7ms -> [{"model":"gemini","i":492887718,"o":99415235},…]
tokens by owner per day (top): 36/31/32ms -> [{"owner":"u32","d":"2027-06-25 00:00:00","t":37615},…]
distinct sessions: 6/5/5ms -> [{"n":"62500"}]
text ILIKE scan (no index): 69/64/60ms -> [{"n":"29810"}]
lance_fts 'error' grouped by session: 107/92/89ms -> [{"records":"110069","sessions":"52205","best":3.0341358184814453}]
lance_fts 'w300', top sessions: 66/64/73ms -> [{"archive_id":"s6255","best":3.4875900745391846,"hits":"1"},…]
copy into memory (no text): 132ms
in-memory tokens by owner per day: 6/6/5ms
```

`duck.ts` on S3:

```text
count(*): 12/2/1ms
count by visibility: 32/7/7ms
tokens by model: 24/18/18ms
tokens by owner per day (top): 50/43/46ms
distinct sessions: 14/7/7ms
text ILIKE scan (no index): 113/102/85ms
lance_fts 'error' grouped by session: 184/332/138ms -> 110069 records, 52205 sessions
lance_fts 'w300', top sessions: 134/113/118ms
copy into memory (no text): 146ms
in-memory tokens by owner per day: 8/5/5ms
```

`clickhouse.sh` (seconds), from its second run:

```text
count(*)                                     0.001 0.001 0.001 -> 1000000
count by visibility                          0.004 0.003 0.004 -> org 857142
tokens by model                              0.005 0.004 0.004 -> gemini 492887718 99415235
tokens by owner per day (top)                0.025 0.014 0.014 -> u32 2027-06-25 37615
distinct sessions                            0.012 0.009 0.012 -> 62500
text ILIKE scan                              0.026 0.026 0.027 -> 29810
hasToken error: records, sessions            0.007 0.009 0.007 -> 110069 52205
BM25 in SQL: w300 top sessions               0.080 0.068 0.072 -> s33585 3.539341771762844 1
BM25 in SQL: error, all matches grouped      0.075 0.078 0.072 -> 110069 52205 3.0383413603733653
```

Both engines agree on every count. The BM25 scores differ slightly: ClickHouse's formula uses
length in characters, and Lance's uses words.

### Install sizes (macOS arm64)

| Package | Size |
|---|---|
| `@lancedb/lancedb-darwin-arm64` (native) | 250 MB |
| `onnxruntime-node` (optional, for embeddings) | 180 MB |
| `@duckdb/node-bindings-darwin-arm64` (native) | 63 MB |
| `apache-arrow` | 8.3 MB |
