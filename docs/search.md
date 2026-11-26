# Search

`seshi search` and `GET /v1/search` find sessions by what was said and done in them (F10), and
`seshi sql` answers questions across them ([below](#sql)). The first half of this page is for
people searching; the second is for whoever runs the server.

## Searching

```sh
seshi search flaky checkout test
seshi search '"git push --force"' --repo widget --since 7d
seshi search deploy NOT staging --owner alice@acme.com --sort recent --json
```

`seshi search` finds sessions by what was said and done in them: prompts, assistant text and
reasoning, tool calls (tool names and inputs, so file paths and commands), and what the tools
gave back, each record cut to its role's [cap](#how-much-of-each-record-is-indexed) (the first
8 KiB of tool output). A record matches when all the words appear in it, in any order (a prompt,
an answer, one tool call, one tool's output: words spread over two records of a session do not
match); `"a phrase"` must appear as written; `word*` matches words
starting with it; `a OR b` matches either; `-word` (or `NOT word`) leaves out records with it
(on the command line, write `NOT word`, or put `-word` after `--`: `seshi search deploy --
-staging`, since a leading `-` reads as an option). Case and accents are ignored, and
punctuation separates words, so `src/app.ts` finds those words in that order.

Each result is a session (format and session id, owner, repository and branch, when it was last
active, how many records matched) followed by its best matching records with a short excerpt,
each led by `#<seq>`: the record's place in the session, counting its events from 0 across its
traces, which is where to read around it.
On a terminal the session and the matched words are in the search colour (lilac; magenta on a
light background), plain with `NO_COLOR`, `--no-color` or `--json`. `seshi sessions show
<format>/<session-id> --owner <owner>` opens one.

| Flag | |
|---|---|
| `--owner <id>` | Only this owner's sessions |
| `--agent <name>` | Only sessions of this format or agent (`claude-code`, `codex`, …) |
| `--repo <name>` | Only this repository (the session's `repo`, its normalized remote): exactly, or its last path segments (`widget`, `acme/widget`) |
| `--branch <name>`, `--source <id>` | Only this branch; only sessions written through this source (`upload`, `datadog-prod`) |
| `--harness <name>`, `--harness-version <v>` | Only sessions run by this harness (the meta record's `source`: `claude-code`, `codex`, `cursor`); only those whose `agent_version` is this: the version the session started on (Cursor: at its latest upload) |
| `--model <name>` | Only sessions that used this model, among every model they used |
| `--role <role,…>` | Only records of these roles: `user`, `assistant`, `reasoning`, `tool_call`, `tool_result`, `system`, `observation` (`--role tool_result` searches tool output alone) |
| `--label <key>=<value>` | Only sessions carrying this [label](config.md#labels), key and value exactly (`--label dosu.project=github.com/acme/app`); repeat it for more, and a session must carry every one |
| `--since`, `--until` | Only records in this time range: a date (`2026-11-01`), an RFC 3339 time, or an age (`7d`, `12h`) |
| `--sort relevance\|recent` | Best match first (the default), or most recently active first |
| `--limit <n>`, `--matches <n>`, `--cursor <c>` | Sessions per page (20, at most 100), records shown per session (3, at most 20), the next page |

Where it searches:

- **A server** (`server` in the CLI config, or `--server <url>`): through `GET /v1/search`, as
  the signed-in caller, so you find your own sessions and those visible to the org (admins and
  services find everything), with the credential `seshi login` stored. `--token` (and `--user`
  with the org key) uses that token for this one search instead.
- **In-process** (`[serverless]` in the CLI config, which reads as its owner with the
  visibility rule unless `--include-private` is given; [serverless.md](serverless.md)); or with a
  server config (`--config <seshi.toml>`, or where the
  server's own config is, as for `workers status`: `SESHI_CONFIG` or `/etc/seshi/seshi.toml`,
  never a `./seshi.toml` it is not told about): the bucket's keys read everything, so
  nothing is filtered by owner. The local index is brought up to date with the change feed
  before each search, and built from scratch the first time (which reads every change entry
  once). In serverless mode the index holds what `[search] scope` lets in, the daemon keeps it
  caught up, and a search reuses it when it caught up within twice `search.interval`; a change
  of scope or owner empties it and builds it again
  ([serverless.md](serverless.md#search)). `seshi search --status` says where the index file is and what it holds;
  `seshi search --rebuild` drops it and builds it again. With a server whose index is shared
  (`search.backend = "lance"`, [below](#a-shared-index-lancedb)), the CLI only reads it, as an
  API instance does: the worker keeps it current.

The output is plain text; `--json` prints the API's `SearchResults`. When the index stopped
counting at its cap (LanceDB's `search.lance.max_scored_rows`), the total is a lower bound:
`"capped": true` in the response, "at least N" in the text. Exit 0 also when nothing
matches; 2 for a query with nothing to look for; 3 when nothing is configured or search is
turned off; 5 when not signed in or not allowed (`--owner` naming someone else, with a credential that
lacks the `search` scope); 7
when the server or bucket cannot answer, or the server's index is still being built.

## SQL

```sh
seshi sql "SELECT owner, count(*) AS sessions FROM sessions GROUP BY 1 ORDER BY 2 DESC"
seshi sql --schema
seshi sql "SELECT tool_name, count(*) FROM events WHERE role = 'tool_result' AND NOT ok GROUP BY 1" --since 7d --json
```

`seshi sql` and `POST /v1/sql` answer questions across sessions with one read-only `SELECT`
over three views of the search index: `sessions` (one row per session), `events` (its indexed
records, with `seq`, `role`, `tool_name`, `tool_call_id`, `ok`, `chars` and `text`) and
`llm_calls` (every model request, with its tokens). `seshi sql --schema` and `GET
/v1/sql/schema` give their columns, with types and comments, the dialect and three examples.
Use `search` to find words and `seshi sessions show` to read a session; `sql` is for counting,
grouping and joining.

On a SQLite index the statement runs in SQLite itself, so it is written in SQLite's dialect:

- times are UTC text, `YYYY-MM-DD HH:MM:SS.SSS`, so `ts > datetime('now', '-30 days')` and
  `strftime('%Y-%m', started_at)` work, and text order is time order;
- `models` is a JSON array and `labels` a JSON object: `EXISTS (SELECT 1 FROM json_each(models)
  WHERE value = 'claude-opus-5-5')`, `labels ->> '$.team'`;
- `ok` is `0` or `1` (`NULL` for a record that does not say), and there is no `GROUP BY ALL`:
  `GROUP BY 1, 2`;
- `text` is the indexed text, cut to its role's [cap](#how-much-of-each-record-is-indexed);
  `chars` is the record's full length.

```sql
-- Tokens per person and model, last 30 days
SELECT s.owner, c.model, sum(c.input_tokens + c.output_tokens) AS tokens
FROM llm_calls c JOIN sessions s USING (owner, archive_id)
WHERE c.started_at > datetime('now', '-30 days') GROUP BY 1, 2 ORDER BY tokens DESC;
```

**The window.** The views hold the sessions that overlap `--since` and `--until` (`since` and
`until` in the request): a date, an RFC 3339 time or an age (`7d`), the last 30 days by default,
at most 400 days. A statement cannot widen it: the views are built for each statement, with the
window and who is asking written in.

**What a statement may be.** One `SELECT`: set operations, CTEs and `WITH RECURSIVE`,
subqueries, `VALUES`, every kind of join, window functions and `FILTER`. It reads only the
three views and its own CTEs, by their plain names (`main.events` is refused), calls only the
[functions SQLite's list allows](../packages/ts/search/src/sql/functions.ts) (aggregates,
window functions, text, time, JSON and numbers; not `load_extension`, `randomblob`, FTS5's
`snippet` or anything that reads files or settings), and is at most 16 KiB. Anything else is
refused before it runs, saying what and where: `seshi sql` prints the line with a caret under
it, and the API gives `at`, the character's offset.

| Limit | Default | Setting |
|---|---|---|
| Time | 15 s: the worker running it is killed and replaced | `search.sql.timeout` |
| Memory | 1 GiB inside SQLite (held on Linux, where Bun carries its own SQLite; macOS's system SQLite ignores it), and the worker is killed above 2 GiB resident | `search.sql.memory`, `search.sql.worker_memory` |
| Rows | 1,000 and 1 MB of them, then `truncated` (`--max-rows` asks for fewer) | `search.sql.max_rows` |
| Concurrency | 2 workers, 8 statements waiting, 2 running per caller; then `429 sql_busy` | `search.sql.workers` |

**Who may.** `sql` needs the `sql` scope. Admins have it; a service token can be given it
(`seshi tokens create service --service reports --scope search --scope sql`); members do not.
On a serverless laptop `seshi sql` reads the laptop's own index as its user, with the
visibility rule `seshi search` follows (your sessions and the org's; `--include-private` for
owner-only ones too) and the window still applied; the answer says `as <you> (local index)`. Other places are as for `seshi search`
([above](#searching)): a server (`--server`, `--token`), or in-process with its config
(`--config`).

**SQLite `sql` is not for production use with members.** `bun:sqlite` has no authorizer, no
interrupt and no limit on attached databases, so what keeps a statement to the views is the
statement check alone: SQLite's own tokens (a port of its tokenizer), a parser's tree
(sqlparser-rs, in its SQLite dialect) and then SQLite's `EXPLAIN` of the statement (every table
it opens must be one the views read, nothing written, every function on the list). That is
enough for admins and service tokens, who can read every session anyway; it is not a wall to
put between members and each other's owner-only sessions. A SQLite server refuses to start with
`[search.sql] members = true`, naming the LanceDB backend, where members' `sql` will come with
DuckDB and its own gates ([design](seshi/session-tools.md#who-may-use-it)). On a LanceDB index
`sql` answers `501 sql_unavailable` for now.

**How it runs.** Each statement runs in a worker process, `seshi sql-worker`, which every seshi
binary has: the server keeps `search.sql.workers` of them (2; 1 on a laptop), started with the
first statement, each running one at a time. A worker opens the index file read-only, creates
the three views as `TEMP` views with the caller's scope, turns on `query_only`, checks the
statement, and reads at most `max_rows` rows. A query in SQLite cannot be stopped from inside,
so the server kills a worker that runs past the timeout or whose memory passes
`search.sql.worker_memory`, answers `sql_timeout` or `sql_memory`, and starts another. Workers
get an environment of their own (a private `HOME` and `TMPDIR`, `PATH`): no seshi settings,
tokens or keys. A worker that dies mid-statement answers `500`, and the next statement runs on a
new one. An index kept in memory (`search.path = ":memory:"`) has no file for a worker to read:
`501 sql_unavailable`.

| `POST /v1/sql` answers | |
|---|---|
| `200` | `{now, scope: {as, role, since, until}, index: {backend, dialect, updated_at}, columns: [{name, type}], rows: [[…]], truncated, elapsed_ms}` |
| `400 sql_refused` | The statement check refused it: `message` says what, `at` where |
| `400 sql_error` | SQLite could not compile it: an unknown column, a syntax it does not take |
| `400 sql_timeout`, `sql_memory` | A limit stopped it |
| `400 sql_runtime` | It failed while running (malformed JSON, an integer overflow). A member would get no message, which could quote a row |
| `400 bad_field` | The body: an unknown field, a window that is not one or longer than 400 days |
| `403 forbidden` | No `sql` scope |
| `429 sql_busy` | Two of the caller's statements are running, or eight are waiting |
| `501 sql_unavailable` | A LanceDB index (for now), or a SQLite index in memory |
| `503 index_unavailable` | The index has not caught up with the change feed yet |

`seshi sql` exits 0 with an answer, 1 when the worker running it failed, 2 for a statement
refused or that SQLite cannot run, 3 when nothing is configured, 5 without the scope or a
sign-in, 7 when the server, the index or the workers cannot answer, and 9 where `sql` is not
available.

## How the index works

`GET /v1/search` and `seshi search` find sessions by what was said and done in them (F10):
every event of every role by default (`search.events`), each cut to its role's cap
(`search.max_chars`, [below](#how-much-of-each-record-is-indexed)). Results are sessions, best
match first (bm25), each with its best matching records: the trace and event each is in, its
`seq` (its place in the session, from 0 across its traces), and a short excerpt with the
matched words marked by offsets. Filters: owner, agent, repository, branch, labels, source,
role and time. `GET /v1/search` takes each label as `label=key=value`, repeated for more, and
roles comma-separated (`role=tool_result,observation`); results carry the session's `labels`.

### How much of each record is indexed

Tool output is most of a session's text, and its first few KiB hold what a search needs: the
command's error, the file's head. So each role's text is cut before it is indexed:
`tool_result` and `observation` to 8 KiB, every other role to 32 KiB (`search.max_chars`).
Words past the cut are not found; the session itself keeps every event whole. Beside its text,
the index keeps each event's full length, its tool call id and whether a tool reported success,
and every model call the session's traces record (model, times, token counts, stop reason,
error), for questions across sessions.

8 KiB is measured: on Dosu's own sessions (5,036 of them, aggregates only), an index of every
role at these caps is about 2.4 times one of prompts, answers and tool calls alone, the earlier
default, against 2.1 times at 4 KiB and 1.8 times at 2 KiB. A quarter of tool results run past
2,500 characters; 8 KiB keeps about three quarters of their text.

Every instance that serves the API keeps its own index, an SQLite file on local disk
(`search.path`, by default in the user cache folder; FTS5 through Bun's built-in SQLite, so
there is no service to run), and its own cursors in each owner's change feed (F10.3). The
`search-index` job reads the feeds: a published entry indexes the session's new traces (only
the new ones for a continuation), a replacing one (`replace: true`, including `seshi redact
backfill`'s `reason: "redacted"`) drops everything indexed for the session and reads it again
from the trace it names, a tombstone removes the session, a visibility change updates it
(F10.2). It indexes each session as its metadata says it is now, so entries read twice, out
of order or lost leave nothing behind. Writers append an entry before they move the session's
pointer, so an entry whose change the metadata does not show yet is read again on the next
run, until it is the lag window (5 minutes) old. OTLP and poller sessions (`otlp-genai`,
`datadog-llmobs`, owned by `svc:<source-id>`) are indexed once the assembler publishes them;
span records under `spans/` are never read. A new session is searchable within `search.interval`
of being stored; a new owner's first session within a minute (the list of owners is read
again every minute). Sessions model review dropped never reach the feed, so they are never
indexed.

The index also keeps a copy of every change entry it reads, which is what `GET
/v1/changes/all` serves: every owner's feed as one, to service tokens and admins
([server.md](server.md#every-owners-change-feed)). The feed serves entries up to
how far every owner's feed has been read, and no further than when the list of owners was
taken, so an owner it has not read yet, or one that is new, has no entries behind a reader's
cursor (up to the skew of writers' clocks, which readers' lag window covers). The copy is kept
only on a server; a laptop's index keeps none.

A new or wiped instance builds its index from the feeds before it answers: until then search
answers `503 index_building` with `Retry-After`. The file survives restarts, and deleting it
only costs a rebuild; so does `seshi search --rebuild` where the config is. Changing
`search.events` or `search.max_chars`, a seshi upgrade that changes the index's layout, or
pointing the instance at another deployment's bucket, rebuilds it too. The
index holds session text (redacted, but the org's): the file is created readable by its owner
only.

Who finds what follows the read rules (F10.4): a member finds their own sessions and those
visible to the org; admins and services find everything. The server builds that filter from
the credential, the index applies it, and each result is checked against the session's live
metadata before it is returned, so a session made private or deleted after it was indexed is
never shown. Anyone else's sessions need the `search` scope: the org key, member session
tokens, static tokens, admins and service readers have it. Device tokens and writing services
do not, so they search only their own owner's sessions (X5.10): the server sets the owner
filter to theirs, and refuses (`403`) an `owner` naming anyone else.

## A shared index (LanceDB)

With `search.backend = "lance"`, a server keeps **one index for every instance**, in object
storage, instead of an SQLite file on each (F10.6). The worker (X7.2) runs the `search-index`
job and is the only writer; every API instance only reads, and sees what the worker committed
within `search.lance.read_consistency` (5 s). Nothing else changes for people searching: the
same queries, filters, read rules (F10.4) and `GET /v1/changes/all`, which every instance can
serve because the feed's copy is in the shared index too. It is for teams that run more than one
API instance, or do not want each one to read every feed and hold a full copy.

```toml
[search]
backend = "lance"

[search.lance]                      # all optional
# uri = "s3://other-bucket/seshi-search"
read_consistency = "5s"
optimize = "1h"
scrub = "24h"
```

- **Where it lives.** Under `search/<deployment>/` in the store's bucket, reached with
  `[store]`'s keys, which LanceDB is given as options and never in the URL
  ([spec/layout.md](../spec/layout.md)). `search.lance.uri` puts it in another bucket (with
  keys of its own in `[search.lance]`) or a folder on a single host. It is derived data: it can
  be deleted at any time and is rebuilt from the change feeds. It holds session text, so the
  same people may read it as may read traces. On `gs://` it must be Google's own Cloud
  Storage: LanceDB cannot reach a GCS emulator or another endpoint, so a `gs://` store with
  one (or `STORAGE_EMULATOR_HOST`) needs `search.lance.uri` set to a folder or another
  bucket.
- **Which binary.** LanceDB's native library is about 180 MB (280 MB on Linux arm64), so it is
  only in the **server build**: the container image (`ghcr.io/dosu-ai/seshi`) and the
  `seshi-server-linux-x64` and `-arm64` release archives. The binaries laptops install (the
  install scripts, npm) do not carry it, and a server started from one with `backend = "lance"`
  refuses to start, saying so. The server build strips LanceDB's symbol table to save that
  much, so a crash or panic inside LanceDB shows its frames without function names; the
  unstripped library on npm, at the pinned version, names them
  ([how](seshi/lancedb-search.md#the-binary-the-server-build)).
- **Who writes.** Only an instance with the worker role indexes; give exactly one instance that
  role (X7.2). API-only instances open the index read-only and never write it, not even its
  bookkeeping. A deployment without a worker runs `seshi sync search` from cron instead, which
  refuses while a worker is running. A second worker by mistake is
  harmless (writes are idempotent), only wasteful.
- **Serverless laptops** ignore `search.backend` and `[search.lance]` in the shared config:
  each keeps its own SQLite index, limited to its scope (F11.9).
- **The first build** answers `503 index_building` until the worker has read every feed once,
  as with SQLite. Later rebuilds do not: `seshi search --rebuild` (with the server's config)
  asks the worker to build a new generation **beside** the live one, which keeps answering
  until the new one has caught up and takes its place (F10.11). It only records the request,
  and returns at once: the worker starts the rebuild after its next pass, so it stays the one
  writer. `--wait` follows the request and the build until the switch, and gives up, pointing
  to `seshi workers status`, when nothing has moved for 15 minutes and no worker is running. Changing `search.events` to index more roles,
  or `search.max_chars`, rebuilds the same way; indexing fewer roles stops the old generation
  answering at once, since it holds records the new config leaves out. A seshi upgrade that
  changes the index's layout (`seshi search --status` names the old one as `stale schema`)
  also builds beside it, but the new code cannot read the old generation, so searches answer
  `503 index_building` until the new one has caught up, as on a first build.
- **Deleted text.** A retracted, deleted or redacted session leaves search results at the next
  commit. Its text leaves the index's files when the worker next scrubs: at most once every
  `search.lance.scrub` (a day), plus 15 minutes for readers still on the old files (F10.12).
  That is weaker than SQLite, which removes it from its file at once. `seshi search --scrub`
  asks the worker to scrub on its next pass.
- **Upkeep.** After a pass that committed something, at most every `search.lance.optimize` (an
  hour), the worker compacts the tables and adds new rows to their indexes. That rewrites the
  indexes, so it takes longer as the index grows: about 1 minute at 1M records and 8 to 9 at
  10M. The design fits up to roughly 10 to 30M records (about a year of a 50-person team);
  `seshi doctor --config` warns past 20M
  ([design](seshi/lancedb-search.md#risks)).
- **Counts.** A relevance search scores at most `search.lance.max_scored_rows` records (10,000);
  past it the total is a lower bound (`capped`, "at least N"). Results are the best-scored ones
  either way.
- **Prefixes** (`word*`) need at least 2 letters with LanceDB; SQLite takes one.

`seshi search --status --config <seshi.toml>` shows the backend, the location (never its
keys), the live generation, when it was ready and last caught up, and a rebuild in progress;
`seshi workers status` and `GET /v1/admin/jobs` show the job's `building` flag.
`seshi doctor --config <seshi.toml>` checks that the index can be read, that the worker's keys
can write its location, that it caught up recently, and its size.
