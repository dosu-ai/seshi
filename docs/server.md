# The sessiondb server

A client posts the transcript of a session, whole or in chunks as it grows; the server turns
it into an envelope and runs it through one pipeline, in memory (X4): it normalizes it to
trajectory-v1, redacts the records, decides whether the session is worth a trace and how much
of it is new, runs model review when a policy applies, and only then writes the trace to the
bucket, in the [layout](../spec/layout.md). The transcript itself is never stored (X6.3): the
redacted trace is the only copy, and a trace is rebuilt by sending the transcript again while
the client still has it. Anything that reads the layout reads the bucket directly: the server
is a writer and no reader's dependency.

The server (`seshi serve`, `apps/seshi/`) is the pipeline (`packages/ts/pipeline/`) behind HTTP and a token list:
each route is a call on the SDK's client, scoped to the owner the token names, and the SDK's
own HTTP backend (`connect({ server, token })`) speaks this API from the other side. A client
that holds a bucket credential can run the same SDK against the bucket directly and skip the
server; what the server adds is that the laptop holds no bucket credential and redaction is
not the laptop's to skip.

```
client ──POST /v1/sessions (transcript, bearer token)──▶ seshi server
                                    normalize · redact · filter · review · write the trace
                                                                    │
                                                                    ▼
                                                   the bucket (s3:// r2:// file://)
                                                                    ▲
                                                 readers tail changes/ (their own read-only key)
```

One server, one bucket, one list of tokens, from `seshi.toml` and `SESHI_*` env (see
[config.md](config.md)). Each token names a person; that person's sessions are filed under
`owners/<name>/` in the bucket, and the token can post sessions there and read them back, and
nothing of anyone else's. Nothing else is needed.

## Running it

```bash
cp .env.example .env     # a token, the bucket URL and its keys, as SESHI_* variables
bun start                # http://localhost:7200
```

Bun reads `.env` from the working directory on its own; `.env` is gitignored. The same file is
what `docker compose` hands the container (`docker compose up -d`). A TOML file works as well
(`./seshi.toml`, `/etc/seshi/seshi.toml`, or `--config`; start from
[`seshi.example.toml`](../seshi.example.toml)), with env over it and flags over env.
`seshi config check` validates either before you start. At boot the server writes the layout
marker and a probe object, so a wrong bucket or key fails there and not on the first session.

The settings most servers need ([config.md](config.md) has all of them):

| Setting | Env | Purpose |
|---|---|---|
| `auth.tokens.<name>` | `SESHI_AUTH__TOKENS__<NAME>` | One per person (`SESHI_AUTH__TOKENS__ALICE=…`). The name is the folder their sessions go under, so keep it stable; the token is 16+ characters (`openssl rand -hex 24`) and can be rotated alone. One person? `SESHI_AUTH__TOKENS__DEFAULT` files under `owners/default/` |
| `auth.legacy_token_secret` | `SESHI_AUTH__LEGACY_TOKEN_SECRET` | For a hosted server with a tenant per user: tokens signed with this secret are accepted too. An HS256 JWT whose `sub` is the owner and whose `exp` is required; whoever shares the secret (Dosu's backend, for its users) mints one per person, and the token list can be empty. 32+ characters (`openssl rand -hex 32`) |
| `store.url` | `SESHI_STORE__URL` | Required: `r2://bucket/prefix`, `s3://bucket/prefix`, or `file:///path` |
| `store.credentials.*`, `store.region`, `store.endpoint`, `store.account_id` | `SESHI_STORE__CREDENTIALS__ACCESS_KEY_ID`, … | The bucket's keys and where it is. Unset, the standard `AWS_*` / `S3_*` (and `R2_*` for `r2://`) variables apply |
| `redaction.packs` | `SESHI_REDACTION__PACKS` | JSON files of your own redaction rules, added to the built-in ones ([below](#your-own-redaction)). The server refuses to start if a pattern in one is not a usable regular expression |
| `store.deployment_id`, `store.org` | `SESHI_STORE__DEPLOYMENT_ID`, `SESHI_STORE__ORG` | Recorded in the bucket's layout marker (`seshi.json`); the server refuses to start against a bucket marked for another deployment or org (X1.4). See [the layout](../spec/layout.md) |
| `server.listen` | `SESHI_SERVER__LISTEN` | Default `:7200`; flag `--listen` |

Today's `SESSIONDB_*` names and `PORT` are no longer read.

Put TLS in front of it (a reverse proxy, Cloud Run, a load balancer): transcripts arrive
unredacted and the server is where that stops being true.

### Your own redaction

Every session's normalized records go through three passes before anything is written, in
this order. They run on the records, where tool calls, file paths and results are already
separate fields; the transcript itself is never stored.

1. **Sensitive tool calls.** When a call reads or writes a secrets file (`.env`, a private key,
   `~/.aws/credentials`, Terraform state and the like) or runs a command whose job is to print a
   secret (`printenv`, `gh auth token`, `kubectl get secret`, `aws configure get`, `vault kv get`,
   `op read`, …), the call is kept and its result becomes `[redacted:sensitive-file]` or
   `[redacted:secret-output]`, marked `withheld` in the trace. A file call's input keeps only
   what names the file. A file is recognized by a call's path arguments, a shell command's
   words, or a patch's file headers, not by text that only mentions it. A result in a later chunk
   than its call is caught too: the session's `metadata.json` keeps the withheld calls' ids.
2. **Your patterns**, if you have any: a match becomes `[redacted:custom-pattern]`.
3. **The built-in secret patterns**: provider tokens, credential assignments, bearer headers,
   JWTs, connection URLs, private-key blocks, and the entropy pass.

Passes 2 and 3 skip the structural fields (ids, roles, timestamps, tool names, the source and
the branch). The session's `metadata.json` records the rule set's hash and how often each rule
fired (`redaction`), never what matched.

The first and last always run. A pack in `redaction.packs` adds to them, and nothing in it
can take a built-in away:

```json
{
  "patterns": ["ACME-[0-9A-F]{32}", "internal-key: (?<secret>\\S+)"],
  "sensitive_files": ["config/master.key", "secrets/**", "!secrets/README.md"],
  "secret_commands": ["acme-cli\\s+token\\b"]
}
```

- `patterns` are JavaScript regular expressions, run over every text field of the records. With
  a named group `secret`, only that group is replaced, so the second one above keeps
  `internal-key: `.
- `sensitive_files` are `.gitignore`-style globs: without a `/` a file's name in any directory,
  with one the end of its path; `**` crosses directories; `!` makes an exception.
- `secret_commands` are regular expressions matched at the start of each command in a shell
  line (after `;`, `&&`, `|`, `$(`, `sudo`, `VAR=value`).

This is the file Dosu's CLI keeps for an org's rules, so an org's list can be pasted here as
it is; the CLI's `excluded` and `names_only` lists are about the member's machine and are
ignored. The rules apply to sessions stored after the server restarts with them; what is
already in the bucket is not rewritten.

### Deploying

Every release is published as a container image, `ghcr.io/dosu-ai/sessiondb:<version>`, built
from `apps/seshi/Dockerfile` in this repository (`docker build -f apps/seshi/Dockerfile .` from the
root). It listens on `server.listen` (default `:7200`), reports
`/healthz` for liveness, and needs only the settings above, from env or a mounted
`/etc/seshi/seshi.toml`: there is no database,
no volume (unless the store is `file://`), no background work, and no state outside the bucket,
so any platform that runs a container works, scaled to zero or to many instances alike. Keep
the request timeout at 120 seconds or more; a large transcript can take that long to normalize
and verify. Platforms that cap request bodies (Cloud Run's HTTP/1 limit is 32 MiB) are fine as
long as clients send `Content-Encoding: gzip`, which every route accepts.

### Who sees what

A token is bound to one name and the server scopes every call to `owners/<name>/`: the
session list, reads, deletes and the change log. Two people on one server
never see each other's transcripts; a token leaked from one laptop exposes one person's
sessions. A reader with its own bucket key sees every folder. That is the point: the team's
archive is the whole bucket, a person's view is their own folder.

Renaming a token's name is a move, not a rename: the old folder stays in the bucket (and a
bucket reader keeps seeing it) but the renamed token no longer does. Add a person, remove a
person, rotate a token; don't rename.

To host several teams, run one container per team, each with its own config and its own
bucket or prefix. Isolation between teams comes from the deployment, not the code.

To host many people without listing them, set `auth.legacy_token_secret` and let something that
knows who they are mint their tokens: a JWT signed with the secret, `sub` the owner's name,
`exp` when it stops working. The server checks the signature and the expiry and scopes the
call to `owners/<sub>/` exactly as it would a listed token; the owner's folder comes into
being with their first session. This is how Dosu's own sessiondb works: the Dosu backend
mints a token per user at setup, and reads the bucket with its own key. A leaked signed
token is good until its `exp`; there is no list to strike it from, so issuers should keep
them short enough to live with that.

## Readers

A reader never talks to the server. Give it a read-only credential on the bucket
(`s3:ListBucket` on the prefix, `s3:GetObject` under it) and it tails `changes/` with a cursor;
`GET /v1/me` tells a client which bucket that is so it can pass it on.

## API

The contract is [`spec/openapi.yaml`](../spec/openapi.yaml): every route, body and response,
with the schemas of the objects they carry. `tests/api/openapi.test.ts` holds the server to it
(every response validated, every documented status observed), so the document and the code
cannot drift apart. What follows is the same API in prose.

All bodies are JSON unless a route says otherwise. Errors are `{ "error": { "code", "message" } }`.
Request bodies may be `Content-Encoding: gzip` (any other encoding is a `415`). Every route but `/healthz` wants
`Authorization: Bearer <token>`.

| | |
|---|---|
| `GET /healthz` | `{ok, version}`, no auth |
| `GET /v1/me` | `{owner, storage: {url, region?, account_id?, endpoint?}}`: which bucket this server writes, so a client can point a reader at it. Never a secret |
| `POST /v1/sessions` | Store a session; see below |
| `GET /v1/sessions?limit&after` | List |
| `GET /v1/sessions/:agent/:session_id` | The session's `metadata.json` |
| `GET /v1/sessions/:agent/:session_id/trace?hash&format` | The head trace (or a specific one) as the stored canonical trace (`format=seshi`, the default) or rendered as `letta`, `otlp` or `atif`; `400 bad_query` for another format, `404` for a session not stored (a filtered one included), `410` once redacted |
| `DELETE /v1/sessions/:agent/:session_id` | Tombstone: drop the trace objects, append a tombstone change. Irreversible; a later upload of the same session is refused |
| `GET /v1/changes?after&since&limit` | The change feed |

### `POST /v1/sessions`

```jsonc
{
  "agent": "claude-code",          // the transcript format: claude-code, codex, cursor, opencode, pi, gemini-cli,
                                   // datadog-trajectory (a Trajectory session file, see below),
                                   // atif (an ATIF document, see below), or trajectory
                                   // (records already in trajectory-v1, see below)
  "session_id": "…",
  "transcript": "…",               // the native log, verbatim
  "format": "jsonl",               // or "json" (OpenCode exports, ATIF): how the log is encoded
  "project": "github.com/acme/widget",
  "branch": "main",                // the client's best guess; the transcript's own record wins
  "parent_session_id": "…",        // the session this one was resumed or forked from
  "fork_of": "…",                  // a fork: the parent whose history this log begins with
  "offset": 0,                     // where `transcript` starts in the log: 0 for the whole log
                                   // (the default), else a chunk from there; see "In chunks"
  "replace": false,                // rewrite a session this upload does not extend; see below
  "visibility": "org",             // or "owner", for a new session (X5.10)
  "idempotency_key": "…"           // optional; the Idempotency-Key header wins; see below
}
```

The server builds the envelope the upload stands for (source id `upload`) and runs it through
the pipeline. Nothing is written until every stage has run:

1. **Normalize** the transcript to trajectory-v1 records through the format's adapter.
2. **Redact** the records: the operator's patterns and the built-in secret patterns on every
   text field, and the sensitive-call rules on tool calls (a call that reads `.env` or runs
   `gh auth token` is kept; what it returned is withheld). See
   [your own redaction](#your-own-redaction).
3. **Worth a trace?** The session filter judges a session's first trace only. Under 2000
   characters of conversation (or no user turn, or nothing answering it) is a greeting, not an
   investigation: `200 { "status": "filtered", … }`, and nothing of the session is stored. The
   answer's `bytes_total` is 0, so the next upload is the whole log again, judged again.
4. **How much is new?** For a session that has a trace, the server compares the upload's
   records with what it stored (`normalized` in its `metadata.json`). A log that extends the
   session writes only the meta record plus the tail, marked as a continuation, and a tail is
   never filtered, however short and whoever wrote it (an agent-only tail included); nothing
   past what is stored writes nothing (`200 unchanged`). A log that does not extend the
   session (the harness rewrote history, the normalizer or the rules changed) is refused with
   `409 conflict`, unless it sets `replace`: then it rewrites the session, which only the
   session's original writer or an admin may (`403 forbidden` otherwise). A fork (`fork_of`)
   ships only what it added past the history it copied, when the parent is stored here; that
   is the fork's first trace, so it is judged. `shipped` (what an earlier answer said) is read
   only for a session without the server's own state.
5. **Model review**, when a review policy applies: allow, redact, or drop (`200 dropped`; a
   drop record says why, never what).
6. **Write** the trace, the session's `metadata.json` and the change entry.

**Which branch?** The one the transcript recorded as it began (Claude Code's `gitBranch`,
Codex's `session_meta`), else the client's `branch`.

`201` when a trace was written, `200` otherwise:

```json
{ "status": "stored", "archive_id": "…", "content_hash": "…", "session_id": "…",
  "records": 3, "events": 2, "records_total": 7, "prefix_sha256": "…", "bytes_total": 48213 }
```

`records` is what this upload wrote; `records_total` and `prefix_sha256` describe the whole
normalized session; `bytes_total` is how much of the log the server now holds, where the next
chunk starts. Every status returns them; a session the server holds nothing of (`filtered`,
or `dropped` before it had a trace) answers zeros. The statuses are `stored`, `duplicate`
(that trace was already stored), `unchanged`, `filtered` and `dropped`.

**Resends.** Every upload has an idempotency key: the `Idempotency-Key` header, else
`idempotency_key`, else one derived from the session, the offset and a digest of the
transcript. A session remembers the last 16 it applied with their answers, so an upload sent
again (the client lost the answer) gets the same answer, status code included, and nothing
runs twice.

`422` with a code is final for that upload (resending the same bytes cannot succeed), and
nothing is stored: `unsupported_agent`, `too_large` (over `limits.max_upload_bytes`, or a
trace over the record caps), `redacted`, `empty` (a blank transcript), `bad_chunk`,
`normalize_<code>`, `invalid`. A log the adapter reads but finds no conversation in yet (a
session that has only started) is `filtered`, not an error. `413 too_large` is a request
body that, decoded (gunzipped), is larger than any upload can need: twice
`limits.max_upload_bytes` plus 1 MiB. `502 storage_error` is the bucket failing and is
retryable.

#### In chunks

A session's log only grows while the session runs (every harness appends a line per event), and
a client need not send the whole of it each time: it sends the bytes past what the server has.

```jsonc
{ "agent": "claude-code", "session_id": "…",
  "transcript": "<the log from byte 48213 on, whole lines>",
  "offset": 48213 }                // the bytes_total of the last answer
```

`offset` must be the session's `bytes_total` (what the last answer said; the session's
`metadata.json` holds it as `normalized.bytes`), else `409 offset_mismatch` with `expected` in
the error and nothing stored: the client resends from `expected`, or from 0 (the whole log)
when it no longer has that. A chunk is whole lines of a `jsonl` log (it ends with a line
break; an OpenCode `json` export and an ATIF document cannot be chunked): `422 bad_chunk`
otherwise.

Until a session has a trace, the server stores nothing of it and takes only the whole log
(X6.3): the first upload of a session is the whole log (`offset` 0), and a chunk for a session
without a trace (never sent, or filtered so far) gets `409` with `expected: 0`. An uploader
resends the whole log from the start; once the session passes the filter, it sends chunks.

A chunk is normalized on its own (the records those lines stand for), redacted with the
session's withheld calls (a result can come in a later chunk than its call), and written as a
continuation of the session's trace: the meta record plus the chunk's records, marked with
where they start, exactly what a whole upload would have written for the same growth. The
server keeps what the continuation needs between chunks (bytes covered, records so far, the
prefix hash mid-stream, the withheld call ids), so a chunk sends nothing else; `records_total`
and `prefix_sha256` in the answer are still the whole session's. A chunk with no records in
it (progress and transport lines) moves `bytes_total` on and writes nothing (`200
unchanged`). A chunk is never judged by the session filter: the session's first trace was.

The cut between chunks is the client's: a line boundary, anywhere. A log that the harness
rewrote in place (Claude Code and Codex rewrite nothing; a harness that compacts its history
might) is the client's to notice, by keeping a hash of what it sent: the whole log is then
sent with `replace`, since it no longer extends what the server holds.

`agent` is part of the archive id (`sha256(owner, agent, session_id)`), which is why only the
trajectory source name is accepted (`claude-code`, not `claude`): one spelling, one archive.

### Datadog Trajectory's format

[Trajectory](https://github.com/datadog-labs/trajectory) is Datadog's capture daemon for coding
agents. It records each session it captures, from Claude Code, Codex, Cursor, Pi and the other
clients it supports, as one canonical event per line in a file of its own format, at
`~/.trajectory/trajectories/sessions/<date>/session-<id>.jsonl`. This server reads that format.
It has no dependency on the daemon or its CLI and no endpoint for it; `datadog-trajectory` is
one more transcript format, normalized to trajectory-v1 by the server's own adapter
(`@letta-ai/trajectory` has none for it) and stored like every other.

A file in that format gets in like any other transcript: `POST /v1/sessions` with
`agent: "datadog-trajectory"` and the file as `transcript`, whole or [in chunks](#in-chunks) as
the daemon appends to it. A file with no `session_end` is a session that is still running; it
normalizes to what it has so far, and the next chunk continues it.

The session is filed as `agent: datadog-trajectory` and its trace's `source` names the client
the daemon captured, `datadog-trajectory:claude-code`, so a session captured both ways (a
client posting the native log and the same session in Trajectory's format) is two archives,
each honest about what normalized it. `session_id`, `git_branch` and `parent_session_id` come
from the file's `session_start`; the branch is the one the daemon recorded.

What the adapter keeps: `user_prompt` / `input_prompt` as user records (as observations when
the daemon attributes them to something other than a person), `tool_use` with `phase: pre` as
tool calls under the client's own tool name, `phase: post` as results with `ok` from `success`,
and `agent_message` as reasoning and assistant records. Accounting and lifecycle events
(`llm_call`, `turn_end`, `inventory.snapshot`, permissions, subagent start and stop) carry no
conversation and are dropped; a subagent's answer arrives as the `Agent` tool's result, and its
own session as its own file. A file with no `session_start` gets `422
normalize_missing_session_start`.

A session the daemon imported from a client's own history (`trajectory session import`) is
thinner than one it captured live: no prose from the agent, and tool calls present only as
their results. The adapter reads those too, and most come out `filtered`, which is right: there
is no conversation in them.

### ATIF documents

[ATIF](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md) is
Harbor's Agent Trajectory Interchange Format: one JSON document per session, exported from
whichever harness ran it ([Decant](https://github.com/dosu-ai/decant) writes it). Post one with
`agent: "atif"` and `format: "json"`. `@letta-ai/trajectory`'s `atif` adapter normalizes it, and
the server applies these rules:

- **Whole documents only.** An ATIF document is one JSON value, so a chunk (`offset` > 0) gets
  `422 bad_chunk` whatever `format` says. A document that grew is sent whole again; its new
  steps are written as a continuation, and a document rewritten from the start is sent with
  `replace` by its original writer.
- **ATIF-v1.0 through ATIF-v1.8.** A later version is refused with
  `422 normalize_invalid_input`; the message names the version. The adapter reads up to v1.7;
  a v1.8 document is handed to it as v1.7, its `audio` content parts (the one v1.8 addition)
  turned into the text `[audio]`, as the adapter writes `[image]` for an image.
- **The harness comes from `agent.name`.** The session is filed under `agent: atif`, and the
  archive id derives from that. The trace's `source` is the document's `agent.name`
  (`claude-code`, `codex`, `copilot-cli`), or `atif` when the name is blank or holds control
  characters. The trace's `agent` field (`atif`) records that the session came in as ATIF.
- **Tool errors come from `extra.is_error`.** ATIF has no standard success field. A tool result
  whose `extra.is_error` is a boolean gets `ok` from it; one without gets no `ok`.
- **Subagents are sent separately.** The adapter does not normalize embedded
  `subagent_trajectories` into the parent. The parent keeps the subagent's tool result, a
  `subagent_trajectory_ref`, as JSON text. Post each subagent as its own session, with
  `parent_session_id` set to the parent's `session_id`.

The adapter also drops system steps (as it does for every source), metrics, costs, token ids,
logprobs and `extra` fields. The document's `cwd` and `git_branch` do not reach the trace, so
send `project` and `branch` with the upload.

### Trajectory-v1 records

A log that is already Letta trajectory-v1, one record per line, is posted as
`agent: "trajectory"`, whole or in chunks. Nothing normalizes it: each line is parsed and checked
(a line that is not JSON, or a record that is not trajectory-v1, gets `422
normalize_invalid_input`), then redacted like any other source's records. A chunk's `meta`
record is dropped, as for every other chunk. The trace's `source` is what the records' `meta`
says.

### Which agent wrote it

A caller that holds logs without knowing which agent wrote them (a bucket of them, say) can
ask the SDK: `detectSource(sample)` takes the start of one file (64 KiB is plenty; a last line
cut short is ignored, and an ATIF, OpenCode or Gemini CLI document is read from its opening
keys) and returns the `agent` to post it as, or `null` when the sample matches no format or more
than one. It tells apart every format above except that pi's session format is shared by its
forks (OMP, OpenClaw), which it reports as `pi`.
