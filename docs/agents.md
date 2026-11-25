# Session tools for agents (`seshi mcp`)

`seshi mcp` lets a coding agent (Claude Code, Cursor, Codex, anything that speaks MCP) read
your team's sessions: what was asked, what the agent did, which tools it ran and what they
printed. It is an MCP server on stdin and stdout with three read-only tools:

| Tool | What it gives the agent |
|---|---|
| `list_sessions` | Sessions by who ran them, where (repo, branch) and when, newest first; no search words needed. The last 7 days by default |
| `search` | Full-text search over the sessions you may read, best first, with each session's best matches |
| `read_session` | Part of one session's events: a range, the events around one, or one long event in pieces |

The agent sees what you may see: the tools call the server with your credential, so a member
sees their own sessions and the org's, and never another member's owner-only sessions. The
design is [seshi/session-tools.md](seshi/session-tools.md); a `sql` tool comes later.

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
A session token is renewed through your sign-in as the CLI renews it, so a long agent session
keeps working. `--tools list_sessions,search` lists only those tools. In serverless mode the
tools read the bucket and this machine's search index directly (`--include-private` reads
others' owner-only sessions too, as the CLI's reads do).

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
matches as `#event@trace role tool: excerpt`:

```
  #13@1a2b3c4d tool_result Bash: FAIL src/lance.test.ts > scrub …
```

`read_session` with `trace: "1a2b3c4d"` and `around: 13` reads the events around that match.
It answers the session's header (agent, repo, branch, times, events, models, token totals),
then a line per event, numbered by `seq` (its place in the session, from 0 across its
traces):

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

## The same from the command line and the API

| Tool | CLI | HTTP |
|---|---|---|
| `list_sessions` | `seshi sessions recent [filters] [--since 7d]` | `GET /v1/search/sessions` |
| `search` | `seshi search <words…>` | `GET /v1/search` |
| `read_session` | `seshi sessions read <session> [--around N] [--full]…` | `GET /v1/sessions/{format}/{id}/events`, `GET /v1/owners/{owner}/sessions/{archive_id}/events` |

[cli.md](cli.md#commands) has the flags, [search.md](search.md#listing-and-reading-sessions)
the endpoints, and [`spec/openapi.yaml`](../spec/openapi.yaml) every parameter.
