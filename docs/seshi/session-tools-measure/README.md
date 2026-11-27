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
