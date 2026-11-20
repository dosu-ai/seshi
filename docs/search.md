# Search

`seshi search` and `GET /v1/search` find sessions by what was said and done in them (F10). The
first half of this page is for people searching; the second is for whoever runs the server.

## Searching

```sh
seshi search flaky checkout test
seshi search '"git push --force"' --repo widget --since 7d
seshi search deploy NOT staging --owner alice@acme.com --sort recent --json
```

`seshi search` finds sessions by what was said and done in them: prompts, assistant text, and
tool calls (tool names and inputs, so file paths and commands). A record matches when all the
words appear in it, in any order (a prompt, an answer, one tool call: words spread over two
records of a session do not match); `"a phrase"` must appear as written; `word*` matches words
starting with it; `a OR b` matches either; `-word` (or `NOT word`) leaves out records with it
(on the command line, write `NOT word`, or put `-word` after `--`: `seshi search deploy --
-staging`, since a leading `-` reads as an option). Case and accents are ignored, and
punctuation separates words, so `src/app.ts` finds those words in that order.

Each result is a session (format and session id, owner, repository and branch, when it was last
active, how many records matched) followed by its best matching records with a short excerpt.
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
  `seshi search --rebuild` drops it and builds it again.

The output is plain text; `--json` prints the API's `SearchResults`. Exit 0 also when nothing
matches; 2 for a query with nothing to look for; 3 when nothing is configured or search is
turned off; 5 when not signed in or not allowed (the credential lacks the `search` scope); 7
when the server or bucket cannot answer, or the server's index is still being built.

## How the index works

`GET /v1/search` and `seshi search` find sessions by what was said and done in them (F10):
prompts, assistant text, and tool calls (names and inputs, so file paths and commands); add
`tool_result` to `search.events` to search tool output too. Results are sessions, best match
first (bm25), each with its best matching records: the trace and event each is in, and a short
excerpt with the matched words marked by offsets. Filters: owner, agent, repository, branch,
labels, source and time. `GET /v1/search` takes each label as `label=key=value`, repeated for
more; results carry the session's `labels`.

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
`search.events`, or pointing the instance at another deployment's bucket, rebuilds it too. The
index holds session text (redacted, but the org's): the file is created readable by its owner
only.

Who finds what follows the read rules (F10.4): a member finds their own sessions and those
visible to the org; admins and services find everything. The server builds that filter from
the credential, the index applies it, and each result is checked against the session's live
metadata before it is returned, so a session made private or deleted after it was indexed is
never shown. The `search` scope is needed: the org key, member session tokens, static tokens,
admins and service readers have it; device tokens and writing services do not.
