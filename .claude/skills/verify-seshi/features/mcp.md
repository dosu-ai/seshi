# Agent tools (`seshi mcp`)

`seshi mcp` is an MCP server on stdio that gives a coding agent `list_sessions`, `read_session`,
`search` and, where the caller may use it, `sql`, with the CLI's login or a token. The `sql`
tool's description is written from the server's (or the laptop's) schema, in its dialect.

## Sub-features

- `mcp-list`: `tools/list` gives three tools to a member, four (with `sql`) to an admin or a
  laptop over its own index.
- `mcp-sql`: `sql` answers a pipe table under a header, the rows also in `structuredContent`.
- `mcp-sql-refused`: a refused statement is an error result with `at` and a caret.
- `mcp-sql-unlisted`: calling `sql` without the scope says why.
- `mcp-seq`: an `events` row's `seq` (or a search match's `#seq`) is `read_session`'s `around`.

## How to get to it (user POV)

- An agent's MCP config naming `seshi mcp` (`claude mcp add seshi -- seshi mcp`).
- `seshi mcp --server <url> --token <t>`, or `SESHI_TOKEN`, without a login.

## Driving it with control-seshi

Preconditions:

- A ready run with two sessions: `$C agent claude-code mcp-1 --turns 4`, then `mcp-2 --turns 5`.
- `M=.claude/skills/verify-seshi/scripts/mcp.ts`, an SDK client that spawns the run's
  `seshi mcp`. Run it inside `( eval "$($C env)"; … )`. In server mode the admin token is
  `admin.token` in the run folder's `admin.json`.

- **List as a member** (server mode). `bun $M list`: `list_sessions`, `read_session`, `search`.
- **List as an admin.** `bun $M list -- --token <admin>`: also `sql`, whose description starts
  `Write SQLite:` and holds the three `CREATE VIEW` blocks. A `--sql` run says `Write DuckDB:`.
- **Query.** `bun $M call sql '{"sql":"SELECT session_id, count(*) FROM events JOIN sessions USING (owner, archive_id) GROUP BY 1"}' -- --token <admin>`:
  a pipe table with both sessions, `isError: false`, and the same rows in `structuredContent`.
- **Refused.** `bun $M call sql '{"sql":"SELECT *\nFROM read_csv('/etc/passwd')"}' -- --token <admin>`:
  `error sql_refused (HTTP 400)`, `at character 14`, and a caret under `read_csv`; exit 1.
- **No scope.** `bun $M call sql '{"sql":"SELECT 1"}'` as the member: `sql is not available:
  this credential has no sql scope`.
- **seq.** Take a `seq` from an `events` row and `bun $M call read_session '{"session":"<owner/archive_id>","around":<seq>,"context":1}' -- --token <admin>`:
  the lines around `#<seq>`.
- **Laptop** (a local-mode run). `bun $M list` lists `sql` ("this machine's own search
  index"); the query above answers `as <you> (this machine's index: own + org)`.
- **Proof.** Save each output under the evidence folder (`mcp-*.txt`).

## Gotchas

- On a laptop the index catches up only when it last did more than twice `search.interval`
  ago, so a session uploaded seconds before may not be in `sql` or `search` yet. Wait, or
  query again.
- `seshi mcp` writes only protocol messages to stdout; its warnings are on stderr, which the
  helper passes through.
