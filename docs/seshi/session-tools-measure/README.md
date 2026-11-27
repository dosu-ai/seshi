# Phase 2 measurements: every event in the search index

Phase 2 of [session-tools.md](../session-tools.md) indexes every event role, each cut to a cap
(decision T5). These are the measurements behind the cap and the rebuild times, taken on 25
November 2026. Nothing here is product code. The scripts are kept so the numbers can be checked
and run again.

| Script | What it does |
|---|---|
| `measure-roles.sql` | Per-role counts, length percentiles and characters kept at 2, 4, 8 and 32 KiB on Dosu's production sample (Supabase `memory.trace`). Aggregates only. |
| `tool-tail.ts` | The same for tool output in local Claude Code and Codex transcripts: how far tool results run past the 2,500 characters `memory.trace` keeps. Prints aggregates only. |
| `rebuild.ts` | Generates a synthetic store shaped like the sample, then times a full build of each backend, for the old default roles and for every role at the new caps. |
| `sql-views.ts` | Phase 4: writes a synthetic LanceDB index (folder or bucket), then times `sql`'s DuckDB views through the real worker pool, reading with only the credential under test. |

## The cap

The production sample has 5,036 sessions, one trace each (the largest). `memory.trace` cuts tool
results at about 2,500 characters, so the tail past that comes from 156k local tool results.
Locally, 24.2% of tool results run past 2,500 characters; in production, 24.4% do. Of those long
results, a 4 KiB cap keeps 3,788 characters on average and an 8 KiB cap keeps 5,598.

The table below shows the indexed text, against today's: user, assistant and tool_call, each
already cut at 32 KiB, 489.4M characters. Under the new rule, tool_result and observation are cut
to the cap and every other role to 32 KiB. At every cap the index has 1.77 times as many rows.

| Cap | Indexed text | Against today's |
|---|---|---|
| 2 KiB | 864.6M | 1.77× (exact) |
| 4 KiB | ~1,012M | ~2.07× |
| 8 KiB | ~1,162M | ~2.37× |

8 KiB is the largest cap under 2.5×, so it is the default.

## Rebuild time

The synthetic store is 1.0M records in 5,136 sessions, 846 MB, on a local folder. A rebuild here
means a full build from the change feeds, with the indexer's lag window off, timed until the
index is ready, its text indexes included. It ran on an Apple M2 Max (12 cores, 96 GB).

| Backend | Roles | Records | Time | Size on disk |
|---|---|---|---|---|
| SQLite | user, assistant, tool_call | 516k | 52 s | 656 MB |
| SQLite | every role, new caps | 1.0M | 104 s | 1.6 GB (2.4×) |
| LanceDB, folder | user, assistant, tool_call | 516k | 75 s | 1.6 GB compacted (2.7 GB as built) |
| LanceDB, folder | every role, new caps | 1.0M | 183 s | 1.9 GB compacted (8.4 GB as built) |

"As built" counts the table versions a build leaves behind. The worker's `optimize()` removes
them once its grace has passed. A rebuild of every role takes about twice as long as one of the
old three, in proportion to the records.

```bash
bun docs/seshi/session-tools-measure/rebuild.ts gen /tmp/m1 1000000
bun docs/seshi/session-tools-measure/rebuild.ts build /tmp/m1 sqlite all
bun docs/seshi/session-tools-measure/rebuild.ts build /tmp/m1 lance all
```

## Phase 4: sql's DuckDB views over a LanceDB index (26 November 2026)

Synthetic data only: 500 sessions, 100k events and 10k model calls across 20 owners, every fifth
session owner-only. Run from a MacBook through `SqlService` and one `seshi sql-worker`. Each
statement gets a fresh DuckDB database (the views, the lock-down, the check, `prepare`, the
run), so every one opens the Lance tables again. Times are in ms, three runs each.

| Statement | Folder | GCS (us-west1, from the laptop), admin | GCS, member |
|---|---|---|---|
| `count(*)` from sessions | 259, 121, 124 | 3,506, 3,065, 3,330 | 3,308, 3,260, 2,872 |
| `count(*)` from events | 127, 130, 128 | 5,456, 4,213, 5,387 | 7,011, 6,453, 6,768 |
| Example 1 (tokens per person and model) | 135, 119, 120 | 4,855, 4,877, 4,765 | 5,221, 5,708, 4,670 |
| Example 2 (tools that fail most) | 130, 137, 126 | 5,733, 6,465, 6,463 | 6,560, 7,438, 6,373 |
| Example 3 (many prompts, few tool calls) | 148, 150, 127 | 5,560, 5,502, 5,432 | 6,472, 5,915, 6,458 |

On GCS the time is mostly opening the datasets over a wide-area network: a count of 500
sessions takes 3 s. An `events` view reads `sessions` twice (its semi-join), so it costs more.
Phase 5 measures from inside the region at 1M and 10M records. If opening stays the larger part
there, the next step is to keep Lance's dataset cache across queries. That needs care: a
database must still never be reused after a caller's statement.

On GCS the workers read with a service-account key holding `roles/storage.objectViewer` under
the prefix condition in [search.md](../../search.md#sql-on-a-lancedb-index). With only that key
in its environment, the `lance` extension read the index. It was refused reading a Lance table
elsewhere in the bucket, writing a table inside the prefix and outside it, compacting a
six-fragment table (its version stayed 6) and cleaning up old versions. The bucket, key and
account were deleted after the run.

```bash
bun docs/seshi/session-tools-measure/sql-views.ts gen gs://<test bucket>/search/measure 500
SESHI_MEASURE_STORAGE='{"google_service_account_key": "<read-only key JSON>"}' \
  bun docs/seshi/session-tools-measure/sql-views.ts time gs://<test bucket>/search/measure 3
```


## Phase 5: the `-sql` image (27 November 2026)

Each image was built from this branch with `docker buildx build --platform linux/<arch>`
(`--build-arg VARIANT=sql` for the `-sql` one), the default one also from phase 4's branch to
check it did not grow. Sizes are `docker image inspect`'s, and `docker save | gzip -1` for what
a pull moves, in MB.

| Image | amd64 | amd64, gzip | arm64 | arm64, gzip |
|---|---|---|---|---|
| Default, phase 4 | 389.4 | 177.7 | 513.7 | 210.2 |
| Default, this branch | 389.8 | 177.7 | 516.6 | 210.2 |
| `-sql` | 782.3 | 311.3 | 891.3 | 333.0 |

The default image does not grow: its seshi layer is 0.9 MB smaller on both (304.4 against 305.3
MB on amd64), and the totals differ by the `apt-get upgrade` layer, which takes Debian's fixes of
the day. The `-sql` image adds about 390 MB (130 MB gzipped) on amd64 and 375 MB (123 MB) on
arm64, against the plan's estimate of about 800 MB and 340 MB gzipped:

| Part of the `-sql` image | amd64 | arm64 |
|---|---|---|
| The binary (the server build's, and DuckDB's 0.5 MB binding) | 305.8 | 407.9 |
| `duckdb/lib/libduckdb.so`, stripped (96.5 and 100.1 MB as npm ships it) | 74.3 | 69.3 |
| `duckdb/v2.0.1/<platform>/lance.duckdb_extension`, as published (signed) | 316.8 | 303.8 |

`bun build --compile` embeds DuckDB's `duckdb.node` but not `libduckdb.so`, which the binding
links from its own folder, so a compiled binary could not load DuckDB at all. The archive and
the image put the library in `duckdb/lib/` beside the binary, and the worker loads it from there
before the binding (`preloadLibduckdb` in `@seshi/sql`).
