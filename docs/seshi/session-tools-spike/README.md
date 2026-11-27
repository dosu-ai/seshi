# Spike: locking down DuckDB and SQLite for `sql`

For [session-tools.md](../session-tools.md), open question 5: do DuckDB's settings that turn off
external access hold for its `lance` and `sqlite` extensions, which read storage through their
own code? A second part, after `sql` on SQLite moved to SQLite itself, checks what a read-only
`bun:sqlite` connection allows. It also checks the parts of the third check the plan relies on: the parser output,
one statement per call, interrupting, the memory limit, reading a SQLite index while it is
written, and whether an error can quote a row the caller may not see.

It ran on 25 November 2026 on a MacBook (darwin-arm64), with Bun 1.4.2, `@duckdb/node-api`
2.0.1-r.1 (DuckDB v2.0.1), `@lancedb/lancedb` 0.41.0 and synthetic data: 2,000 sessions of 40
events across four owners, every fifth session owner-only. No customer data was used. Object
storage was not tested: the Lance tables were a local folder.

Nothing here is product code.

## Scripts

| Script | What it does |
|---|---|
| `gen.ts <root> [sessions]` | Writes Lance `events` and `sessions` tables, a SQLite file with the SQLite index's tables (WAL, text in FTS5), and a CSV, a Lance table and a SQLite file outside the index. |
| `probe.ts <ext dir> <root>` | Sets up a database as the endpoint would (extensions loaded, views with a member's scope), turns off external access, locks the configuration, then runs 32 statements an agent might send. Runs twice: `allowed_directories` naming the index's folder, then an unrelated folder. |
| `limits.ts <ext dir> <root>` | `json_serialize_sql` on statements of each kind, `prepare` of two statements, interrupting at 500 ms, a 256 MB memory limit, and 50 reads of the SQLite index while another connection writes it. |
| `leak.ts <ext dir> <root>` | Predicates that fail only on a row outside the caller's scope, to see whether DuckDB runs them before the view's filter. |
| `native.ts <root>` | The same questions for native SQLite: a read-only `bun:sqlite` connection with `TEMP` views and `query_only`, `ATTACH`, two statements in one `prepare`, `hard_heap_limit`, and a Worker running a runaway query stopped with `terminate()` (`native-worker.ts`). |
| `explain.ts <root>` | What SQLite's `EXPLAIN` shows of a statement: the tables it opens and the functions it calls. |

```bash
bun install
bun gen.ts data 2000
# Install the extensions once into a folder (needs the network); later runs load from it.
bun -e 'const {DuckDBInstance}=await import("@duckdb/node-api");const c=await(await DuckDBInstance.create(":memory:",{extension_directory:"ext"})).connect();await c.run("INSTALL lance; INSTALL sqlite;")'
bun probe.ts ext data
bun limits.ts ext data
bun leak.ts ext data
bun native.ts data
bun explain.ts data
```

`results/` holds the output of the last run, with local paths replaced by `<root>`, `<ext>`
and `<cwd>`.

## Results

### The `lance` extension ignores the lock-down; `sqlite` honours it

From [results/probe.md](results/probe.md). Both runs gave the same answers except for `COPY TO`:

| Statement | `lance` | `sqlite` |
|---|---|---|
| The scoped view, after the lock | Reads | Reads |
| The view, with `allowed_directories` naming an unrelated folder | **Still reads** | Still reads (attached before the lock) |
| A table outside the allowed folder, by quoted path | **Reads** (`'…/outside/secret.lance'`) | Refused: Permission Error |
| The same through the table function | **Reads** (`__lance_scan`), `lance_fts` runs | Refused (`sqlite_scan`, `ATTACH`) |
| The raw index table, bypassing the view | Reads (`'…/events.lance'`, `__lance_scan`) | Reads (`idx.sessions`, the attached name) |

The `lance` extension reads storage through its own Rust object store and never asks DuckDB's
file system, so `enable_external_access`, `allowed_directories` and `allowed_paths` do not
bind it. In production it reads the bucket with whatever credentials the process environment
holds. It also registers maintenance functions: `__lance_exec`, `__lance_cleanup_old_versions`,
`__lance_compact_files`, `__lance_optimize_index`, `__lance_set_auto_cleanup`.
`__lance_exec` took a string and failed only at validating it ("Failed to validate Lance exec
IR"); the other two refused the arguments tried. Their signatures were not explored.

The `sqlite` extension is bound: new scans and attaches outside the allowed folders are refused.
A database attached before the lock stays readable, under its attached name too.

What the lock-down did hold, for both:

- Locked settings: `SET enable_external_access`, `SET allowed_directories`, `SET memory_limit`
  and `RESET lock_configuration` were refused.
- `LOAD httpfs` ("loading external extensions is disabled") and `INSTALL` were refused, as were
  CSV and HTTP reads, `glob`, and `INSERT` into the read-only attached database.
- `getenv` does not exist in this build.

What it did not hold:

- `COPY … TO` a file inside an allowed folder succeeded. DuckDB also adds its temp directory
  (`<cwd>/.tmp/`) to `allowed_directories` by itself, as `current_setting` showed.
- `CREATE TABLE`, `CREATE OR REPLACE VIEW` over a seshi view, and `DETACH` succeeded: the lock
  covers settings, not the catalog.
- `current_setting(…)` and `duckdb_settings()` answered.

### One statement, the parser, interrupts and memory

From [results/limits.log](results/limits.log):

- **`json_serialize_sql`** serializes only `SELECT`: `COPY`, `ATTACH`, `SET`, `PRAGMA` and
  `CREATE VIEW` come back as `{"error": "Only SELECT statements can be serialized to json!"}`.
  It does serialize several statements (`SELECT 1; SELECT 2` gives two). A quoted path is a
  `BASE_TABLE` whose `table_name` is the path (`x.lance`); `idx.sessions` is a `BASE_TABLE`
  with `schema_name` `idx`; `read_csv(…)` is a `TABLE_FUNCTION`; a CTE's reference is a
  `BASE_TABLE` named after the CTE. A select node's keys are `type, modifiers, cte_map,
  select_list, from_table, where_clause, group_expressions, group_sets, aggregate_handling,
  having, sample, qualify`.
- **`prepare`** refuses two statements ("Cannot prepare multiple statements at once"), whatever
  the second is. `run` takes several.
- **`interrupt()`** stopped a cross join of 10¹² rows 501 to 503 ms after it started, at the
  500 ms timer, and the connection answered the next query in 1 ms.
- **`memory_limit = 256MB`** held: a `count(DISTINCT …)` over 50M strings failed with an
  out-of-memory error after 13 to 15 s, and a 50M-row `string_agg` after 27 to 29 ms. External access was
  off, so nothing spilled to disk.
- **SQLite while written:** 50 reads of the attached index while another connection inserted
  200 rows every 5 ms in WAL mode: no errors, and the count never went down (80,000 to
  110,000 in the run in `results/`).

### No error quoted a row out of scope

From [results/leak.md](results/leak.md). DuckDB has nothing like PostgreSQL's
`security_barrier`, so a caller's predicate could in principle run below the view's scope
filter and fail on a row the caller may not see, with the row's text in the message. Three
predicates that can fail only on bob's owner-only session `a5`, asked as alice
(`CASE WHEN archive_id = 'a5' THEN CAST(text AS INTEGER) END = 1`, the same with `error(…)`),
ran without error on both backends: the scope filter ran first. A predicate that fails on every
row quoted alice's own first row. This is one data shape and one plan; it is not a guarantee.

### Loading and size

- A new in-memory database with `lance` and `sqlite` loaded from a local folder: about 13 ms to
  open, 100 to 105 ms for `LOAD lance`, 20 ms for `LOAD sqlite`, 8 to 9 ms to create a view,
  lock and run the first count. A second database in the same process took 106 to 114 ms
  (`LOAD lance` again). Resident memory after the first: 108 MB.
- DuckDB v2.0.1 ships `lance` as a core extension (`INSTALL lance`; the community repository
  has none for v2.0.1). Sizes from `extensions.duckdb.org`:

| Extension | linux-x64 | linux-arm64 | darwin-arm64 |
|---|---|---|---|
| `lance` | 317 MB (93 MB gzipped) | 304 MB (88 MB) | 248 MB |
| `sqlite_scanner` | 54 MB (17 MB) | 51 MB (16 MB) | 43 MB |

The bindings (`@duckdb/node-bindings-<platform>`) were 63 MB on darwin-arm64 and 93 MB on
linux-x64 in the [search spike](../search-spike/README.md#image-size-linux-x64). Extensions are
signed; stripping one would break its signature, so it was not tried.
- SQLite's FTS5 text, read through the content table `events_text_content.c0`, arrives as
  `BLOB` and needs a cast to `VARCHAR`. The FTS5 table itself (`idx.events_text`) also reads.

### Native SQLite (`bun:sqlite`)

From [results/native-darwin.md](results/native-darwin.md) and
[results/explain-darwin.md](results/explain-darwin.md). On macOS `bun:sqlite` uses the system
SQLite (3.51.0, built with `OMIT_LOAD_EXTENSION`, `MAX_ATTACHED=10`, `TEMP_STORE=1`); on
Linux Bun embeds its own, which was not run here. `bun:sqlite` exposes `readonly`, `iterate()`
and `fileControl`, but no authorizer, progress handler, interrupt or `sqlite3_limit`.

| Probe | Result |
|---|---|
| `TEMP VIEW events` over `main.events` with alice's scope, queried as `events` | The view: 68,000 rows of 80,000. Unqualified names find `temp` first |
| `main.events`, `main.sessions`, bypassing the views | **Read**: 80,000 rows, 400 owner-only sessions |
| `ATTACH` a SQLite file outside, on a read-only connection | **Attached and read** |
| `ATTACH` after `PRAGMA query_only = 1` | **Attached** |
| `PRAGMA query_only = 0` sent as the caller's statement | **Ran**: the caller can turn it off |
| `CREATE TEMP TABLE`, `CREATE TEMP VIEW`, `DROP VIEW events` after `query_only` | Refused: "attempt to write a readonly database" |
| `load_extension()`, `readfile()` | Do not exist |
| `prepare("SELECT 1 AS a; DROP VIEW events")` | **Prepared and ran the first statement, silently dropping the rest** |
| `json_each(…)`, `pragma_database_list` | Both answer a `SELECT` (table-valued functions) |
| `PRAGMA hard_heap_limit = 64 MB` | **Ignored**: it reads back 0, and a 5M-row sort of 200-character strings finished |
| A Worker running a 10¹²-row cross join, `terminate()` at 500 ms | **Not closed 10 s later**; the main thread stayed responsive (206 ticks of 50 ms) |

`EXPLAIN` lists `OpenRead` with the database number (an attached file is database 2) and root
page, and `Function` and `AggStep` with the function's name. A table-valued function shows as
`VOpen` with a pointer, not a name. A read of the scoped view and a direct read of
`main.events` both open the index's `events` table, so `EXPLAIN` cannot see the scope. Of
`SELECT 1; DROP VIEW events` it shows only the first statement.

## Findings

1. **The third check does not cover `lance`.** Turning off external access binds DuckDB's own
   file system and the `sqlite` extension, not `lance`. On the LanceDB backend, the parser
   check is what keeps a statement away from paths and table functions, and the process
   boundary has to come from its credentials: the worker should hold a read-only credential for
   the index's prefix only, so a statement that got past the parser could not read session
   traces or write.
2. **Turn off external access with no allowed folders at all.** Views and the attached SQLite
   index keep working after it (the run with an unrelated folder), and `COPY TO` then has
   nowhere to write. Set `temp_directory` to the worker's own folder or turn spilling off,
   since DuckDB allows its temp directory by itself.
3. **The parser check must refuse by shape, not only by kind.** `json_serialize_sql` already
   refuses every non-`SELECT`. The walker must still refuse more than one statement, every
   `TABLE_FUNCTION`, every `BASE_TABLE` with a schema or catalog or a name that is not a view
   or an in-scope CTE (a quoted path is a table name), every function outside an allowlist
   (`current_setting`, `error`, the `__lance_*` and `duckdb_*` families), and a non-null
   `at_clause` (time travel).
4. **One statement per call through `prepare`,** and a database per query: the lock does not
   stop `CREATE OR REPLACE VIEW` or `DETACH`, so the worker must never run a caller's text
   with `run`, and never reuse a database after a caller's statement.
5. **Interrupt and memory limits work in-process.** A worker can keep a pre-warmed database
   (about 110 ms to open and load) ready for the next query.
6. **The SQLite index reads while the indexer writes**, read-only and attached before the lock.
7. **`lance` is the cost of shipping DuckDB:** 317 MB on linux-x64, more than LanceDB's own
   native library after stripping (179 MB).
8. **Native SQLite has no wall below the parser.** A read-only connection with `query_only`
   still runs `ATTACH` and reads the file, the caller can switch `query_only` off, `main.*`
   bypasses `TEMP` views, and `prepare` silently ignores a second statement. With no authorizer
   or attach limit in `bun:sqlite`, a JS parser has to refuse all of these, and `EXPLAIN` can
   back it up for attached files and functions, not for scope.
9. **A runaway native query can only be stopped by killing its process.** No interrupt, and
   a Worker does not stop. Memory has to be bounded the same way where `hard_heap_limit` is
   ignored, as on macOS.
