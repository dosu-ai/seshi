# Session tools for agents (`seshi mcp`)

`seshi mcp` lets a coding agent (Claude Code, Cursor, Codex, anything that speaks MCP) read
your team's sessions: what was asked, what the agent did, which tools it ran and what they
printed. It is an MCP server on stdin and stdout with four read-only tools:

| Tool | What it gives the agent |
|---|---|
| `list_sessions` | Sessions by who ran them, where (repo, branch) and when, newest first; no search words needed. The last 7 days by default |
| `search` | Full-text search over the sessions you may read, best first, with each session's best matches |
| `read_session` | Part of one session's events: a range, the events around one, or one long event in pieces |
| `sql` | One read-only `SELECT` over the views `sessions`, `events` and `llm_calls`, for questions across sessions: who worked where, token use per model, which tools fail. Listed only where you may use it ([below](#sql)) |

The agent sees what you may see: the tools call the server with your credential, so a member
sees their own sessions and the org's, and never another member's owner-only sessions. The
design is [seshi/session-tools.md](seshi/session-tools.md).

## Setting it up

Sign in first (`seshi login`, [cli.md](cli.md#signing-in-f82)), or set up serverless mode
(`seshi init --serverless`). Then add the server to the agent. In Claude Code:

```bash
claude mcp add seshi -- seshi mcp
```

In Cursor, Codex or another client, the server is the command `seshi` with the argument `mcp`,
for example in an `mcp.json`:

```json
{ "mcpServers": { "seshi": { "command": "seshi", "args": ["mcp"] } } }
```

With no login on the machine (CI, Cursor Cloud), give it a token: `--token <token>`, or the
`SESHI_TOKEN` environment variable, with `--server <url>` when the CLI config names no server.
For `sql` from CI, create a service token with the scope:
`seshi tokens create service --service reports --scope search --scope sql`. A session token is
renewed through your sign-in as the CLI renews it, so a long agent session keeps working.
`--tools list_sessions,search` lists only those tools. In serverless mode the tools read the
bucket and this machine's search index directly (`--include-private` reads others' owner-only
sessions too, as the CLI's reads do).

`seshi mcp` starts even when the server cannot be reached or you are not signed in; every tool
call then answers with the error, so the agent can tell you what to fix. Nothing but protocol
messages goes to stdout; warnings go to stderr.

## What the tools answer

Every answer starts with a line saying when it was answered (UTC), whose sessions it covers,
the window, and how fresh the index is:

```
now 2026-11-25T12:00:00Z · as alice (member: own + org) · window 2026-11-18T12:00:00Z → now · index updated 40 s ago
```

`list_sessions` gives a line per session, then `after: <cursor>` (pass it as `after`) or `end`:

```
alice/9f3c…e1 · claude-code/4b1a… · github.com/acme/app@main · 2026-11-25T09:00:00Z → 10:02:41Z · claude-opus-5-5 · team=core
```

The first field, `owner/archive_id`, is what `read_session` takes as `session` (so is
`format/session_id`). `search` gives each session's line with its score, then its best
matches as `#seq role tool: excerpt`:

```
  #213 tool_result Bash: FAIL src/lance.test.ts > scrub …
```

`read_session` with `around: 213` reads the events around that match. It answers the
session's header (agent, repo, branch, times, events, models, token totals), then a line per
event, numbered by `seq` (its place in the session, from 0 across its traces):

```
#212 tool_call   Bash 2026-11-25T10:02:03Z  Bash {"command":"bun test packages/ts/search"}
#213 tool_result Bash ok=0 2026-11-25T10:02:41Z  FAIL src/lance.test.ts > scrub … [+18,422 chars]
next: 214
```

Condensed mode (the default) cuts each tool result to 200 characters, saying how much it left
out; `mode: "full"` gives them whole. A read stops at `max_chars` (30,000 at most) and says
`next: <seq>`; `event` and `offset` read one long event in pieces. Each answer stops at
30,000 characters on a line boundary and says so. Errors (a bad argument, a session that is
not there or was deleted, the server down) are tool results marked as errors, with the API's
code and message.

A `seq` is stable while the session's head is: a replace (a whole session uploaded again)
numbers its events again, and `head` (from an earlier read) makes `read_session` refuse rather
than read a session that changed.

## sql

`sql` runs one read-only statement ([search.md](search.md#sql) has what it may read, its
limits and who may use it). It is listed:

- **against a server**, when `GET /v1/sql/schema` answers: you hold the `sql` scope (admins
  do, and service tokens created with `--scope sql`; members do not yet) and the server can
  run it (any SQLite server; on LanceDB, the `seshi-server-sql` build). `seshi mcp` asks at
  the first `tools/list`, waits up to 5 seconds, and if the answer comes later lists `sql`
  then and tells the client the list changed. When the server says no (no scope, no `sql`
  there), `sql` stays unlisted, and calling it anyway answers why;
- **on a serverless laptop**, over the laptop's own search index, as its user.

Its description is written at start-up from the server's schema, so it is the DDL of this
seshi version, this engine and this caller: it says first which dialect to write (SQLite or
DuckDB, with the idioms that differ), what `sql` is for and what `search` and `read_session`
are for instead, the three views with their columns, types and comments, whose sessions they
hold, the window rule, the limits, and three examples in that dialect. About 4,500 characters.

Arguments: `sql` (the statement, at most 16 KiB), `since` and `until` (an ISO time or an age:
`30d`, `12h`; the views hold the sessions overlapping that window, the last 30 days by
default, at most 400 days) and `max_rows` (200 by default, at most 1,000). The answer is a pipe
table, `NULL` for nulls, each cell on one line and cut at 300 characters (`…[+n]`), then the
count and time, or `truncated at 200 rows: add LIMIT or aggregate`:

```
now 2026-11-25T12:00:00Z · as ops (admin: every session) · sqlite index, sqlite · window 2026-10-26T12:00:00Z → 2026-11-25T12:00:00Z · index updated 40 s ago
| owner | model | tokens |
| --- | --- | --- |
| alice | claude-opus-5-5 | 1840211 |
| bob | claude-haiku-5-5 | 220144 |
2 rows · 231 ms
```

The same rows go in the result's `structuredContent` (`columns`, `rows`, `truncated`) for
clients that read it, as far as they fit in the text. The `events` view's `seq` is
`read_session`'s, so a row (`owner || '/' || archive_id`, `seq`) leads straight to the events
around it.

A statement the check refuses comes back as an error that says where, so the agent can fix it:

```
now 2026-11-25T12:00:00Z · as ops (admin: every session)
error sql_refused (HTTP 400): table function read_csv is not allowed
at character 14 (from 0) of the statement:
  SELECT * FROM read_csv('/etc/passwd')
                ^
```

The other errors are the API's: `sql_error` (an unknown column, a syntax the engine does not
take), `sql_timeout` and `sql_memory` (a limit stopped it), `sql_runtime`, `sql_busy` (too many
statements at once: try again), and `sql_unavailable`.

## The same from the command line and the API

| Tool | CLI | HTTP |
|---|---|---|
| `list_sessions` | `seshi sessions recent [filters] [--since 7d]` | `GET /v1/search/sessions` |
| `search` | `seshi search <words…>` | `GET /v1/search` |
| `read_session` | `seshi sessions read <session> [--around N] [--full]…` | `GET /v1/sessions/{format}/{id}/events`, `GET /v1/owners/{owner}/sessions/{archive_id}/events` |
| `sql` | `seshi sql "<statement>"`, `seshi sql --schema` | `POST /v1/sql`, `GET /v1/sql/schema` |

[cli.md](cli.md#commands) has the flags, [search.md](search.md#listing-and-reading-sessions)
the endpoints, and [`spec/openapi.yaml`](../spec/openapi.yaml) every parameter.

## Checking it with a real agent

`bun run test:agent` (nightly in CI, and by hand before a release) starts a seshi server on a
fixture of four sessions, gives Claude Code in headless mode (`claude -p` with `seshi mcp` as
its only tools) four tasks with known answers (what someone worked on yesterday, the command
that failed in a session, the tool that failed most, tokens per model), and checks the tools it
called and its answers. It needs Claude Code on `PATH` and a model key, so it is not one of the
pull request checks.
