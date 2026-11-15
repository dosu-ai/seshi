# sessiondb

A small server that turns coding-agent sessions into a durable, redacted, content-addressed
archive in your own bucket.

Claude Code, Codex, Cursor, OpenCode, pi and Gemini CLI each write a log of what they did, in
their own format, on the machine they ran on. Those logs are the record of how the work was
done, and they are also full of secrets, scattered across laptops, and shaped six different
ways. sessiondb takes a log over HTTP, normalizes it to one format
([Letta trajectory-v1](https://github.com/letta-ai/trajectory)), scrubs credentials out of it,
decides whether it is worth keeping, and writes it to S3, Cloudflare R2, any S3-compatible
store, or a folder, under a documented layout that anything can read.

```
client ──POST /v1/sessions (transcript, bearer token)──▶ seshi
                                    normalize · redact · filter · review · write the trace
                                                                    │
                                                                    ▼
                                                   your bucket (s3:// r2:// file://)
                                                                    ▲
                                                 readers tail changes/ with their own key
```

Three properties follow from that shape:

- The machine running the agent never holds a bucket credential. It holds a scoped, revocable
  seshi token (or the org key) that writes that person's sessions, and nothing else.
- The bucket never holds an unredacted byte. Redaction happens on the server, before anything
  is written, and there is no switch to turn it off.
- Readers never talk to the server. A read-only key on the bucket is enough to tail the change
  feed, so the archive outlives any particular deployment of this code.

## Install

```sh
curl -fsSL https://github.com/dosu-ai/sessiondb/releases/latest/download/install.sh | sh   # macOS, Linux
npm i -g seshi                                                                             # or with npm
```

On Windows: `irm https://github.com/dosu-ai/sessiondb/releases/latest/download/install.ps1 | iex`.
Every channel installs the same binary; [docs/install.md](docs/install.md) has the platforms,
options and checksums.

## Quick start

```sh
git clone https://github.com/dosu-ai/sessiondb && cd sessiondb
cp .env.example .env        # SESHI_* settings: tokens, the bucket URL and its keys
bun install
bun start                   # http://localhost:7200
```

Or in a container, with the same `.env`:

```sh
docker compose up -d
```

At boot the server writes a layout marker and a probe object, so a wrong bucket or key fails
immediately rather than on the first upload. Then post a session:

```sh
jq -n --rawfile transcript ~/.claude/projects/-repo-app/8f1c….jsonl \
  '{agent: "claude-code", session_id: "8f1c…", transcript: $transcript,
    project: "github.com/acme/widget", branch: "main"}' |
curl -sS http://localhost:7200/v1/sessions \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data-binary @-
```

```json
{ "status": "stored", "archive_id": "…", "content_hash": "…", "session_id": "8f1c…",
  "records": 41, "events": 38, "records_total": 41, "prefix_sha256": "…", "bytes_total": 48213 }
```

As the session goes on, send only what the log gained since, as a chunk from `bytes_total`:

```sh
tail -c +48214 ~/.claude/projects/-repo-app/8f1c….jsonl |
jq -Rs '{agent: "claude-code", session_id: "8f1c…", transcript: ., offset: 48213}' |
curl -sS http://localhost:7200/v1/sessions \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data-binary @-
```

The chunk is normalized on its own and stored as a continuation of the session's trace; the
server keeps where the log stands, so a large session costs each time only what was appended.

The full API and the rules for chunks, continuations and forks are in
[`docs/server.md`](docs/server.md); every setting (TOML, `SESHI_*` env, flags) is in
[`docs/config.md`](docs/config.md); the API as a document is
[`spec/openapi.yaml`](spec/openapi.yaml).

### Datadog Trajectory's format

[Datadog Trajectory](https://github.com/datadog-labs/trajectory) records coding-agent sessions
in a format of its own, one file per session under `~/.trajectory/trajectories/sessions/`.
sessiondb reads that format: post the file as `agent: "datadog-trajectory"`, whole or in chunks
as the daemon appends to it, and it is normalized to Letta trajectory-v1 like any other
transcript. Nothing in sessiondb depends on the Trajectory daemon or CLI; it is one more input
format.

### ATIF documents

[ATIF](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md),
Harbor's Agent Trajectory Interchange Format, is one JSON document per session from any harness.
Post it as `agent: "atif"` with `format: "json"`, whole (never in chunks). The trace's `source`
is the harness the document names in `agent.name`, and each embedded subagent is posted as its
own session with `parent_session_id`. The rules are in
[`docs/server.md`](docs/server.md#atif-documents).

### OpenTelemetry traces

The server is also an OTLP/HTTP trace endpoint: point a Claude Console OpenTelemetry
destination (or any exporter that follows the GenAI conventions) at `https://<server>/otlp`
with a service token, and each Messages API request or Managed Agents session becomes a session
of that destination's service account. Setup and what is kept: [`docs/otlp.md`](docs/otlp.md).

### Datadog LLM Observability

A `type = "datadog"` source polls Datadog LLM Observability's Export API with an API and an
application key, and rebuilds each session Datadog Trajectory published there (one trace per
turn) as a session of the source's service account. Nothing runs on laptops. Setup and what is
kept: [`docs/datadog.md`](docs/datadog.md).

## What the server does with a session

Every upload becomes an envelope that goes through one pipeline, in memory; only the trace is
written, at the end, and never the transcript itself (a trace is rebuilt by sending the
transcript again while the client still has it).

1. **Normalize.** The log becomes trajectory-v1 records via
   [`@letta-ai/trajectory`](https://github.com/letta-ai/trajectory), plus the fixups its
   adapters need (Claude Code's queued and background-task input, Codex's inherited history and
   subagent reports, an ATIF document's harness name and tool errors). `agent` is the adapter
   name, one of `claude-code`, `codex`, `cursor`, `opencode`, `pi`, `gemini-cli`, `atif`,
   `datadog-trajectory`, the server's own adapter that turns a Trajectory session file into the
   same Letta records as everything else, or `trajectory`, records already in trajectory-v1
   that pass through checked. A chunk is normalized on its own, with the little state the
   session keeps.
2. **Redact.** What a tool call returned is withheld when the call read a secrets file
   (`.env`, keys, cloud credentials) or ran a command that prints one (`printenv`, `gh auth
   token`); then your own rule packs, if you set any (TOML, run under RE2); then the built-in
   pack (provider tokens, key/value credentials in several languages, bearer headers, JWTs,
   connection URLs, PEM blocks, and a Shannon-entropy pass for what no pattern knows), with
   identifiers that link a tool call to its result left alone. Each session records which rule
   set ran and how often each rule fired; `seshi redact backfill` applies new rules to what is
   already stored.
3. **Filter.** A session's first trace under 2000 characters of conversation, or with no user
   turn, or with nothing answering it, is `filtered`: nothing of it is stored. Whatever extends
   a stored session (a chunk, the tail of a grown log) is never filtered.
4. **Decide what is new.** A grown log writes only its tail; a fork writes only what it added
   past the history it copied. A log that no longer extends the stored session is refused
   (`409 conflict`) unless its original writer sends it with `replace`.
5. **Review** (when a review policy applies): a decision model allows, redacts or drops; for
   redact, a redactor LLM finds the text and code removes it ([model review](docs/server.md#model-review)).
6. **Hash and publish.** `content_hash` is a hash of what was said, independent of timestamps,
   so re-exporting the same conversation writes nothing. The trace is written under its hash,
   the session's pointer gets it as head, and an entry is appended to the change feed.

The layout is the contract, documented in [`spec/layout.md`](spec/layout.md): immutable
content-addressed traces, one mutable pointer per session, and an append-only change feed.

## Storage

`store.url` (`SESHI_STORE__URL`) selects the store:

| URL | Credentials |
|---|---|
| `r2://bucket/prefix` | `store.account_id` and `store.credentials`, or `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` |
| `s3://bucket/prefix` | `store.region` and `store.credentials`, or `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| `s3://bucket/prefix` + `store.endpoint` | MinIO, RustFS, Backblaze B2, Wasabi, and other S3-compatible services |
| `file:///path` | None. A folder on the server's disk, for development or a single box |

Every write is verified (ETag against MD5 where the service reports one, a read-back otherwise)
before the pointer and change feed are updated, so a reader never sees a change entry for an
object that is not there.

## Trace format

Every input is normalized the same way and stored in one canonical format, `seshi/trace/1`
([`spec/schemas/trace.schema.json`](spec/schemas/trace.schema.json)): the
[Letta trajectory-v1](https://github.com/letta-ai/trajectory) records, their events and hash,
plus what the raw transcript used to keep: the model and token usage per LLM call, record ids,
tool call ids and timings, and where the data came from. Other formats are rendered on read:

| `?format=` | What `GET /v1/sessions/:agent/:id/trace` returns |
|---|---|
| `seshi` (default) | The stored canonical trace |
| `letta` | `sessionstorage/trace/1`: plain trajectory-v1 records, events and hash, as sessiondb stored them |
| `otlp` | An OTLP/HTTP JSON `ExportTraceServiceRequest`: OpenTelemetry GenAI spans (`invoke_agent`, a `chat` span per model turn with its `gen_ai.usage.*`, an `execute_tool` span per tool call), ready to post to a collector. Lossless: `fromOtlp` gives back the canonical trace |
| `atif` | An ATIF-v1.7 document, with token usage as step metrics |

```ts
const trace = await db.getTrace("claude-code", sessionId, undefined, "otlp");
```

Content hashes are computed from the records exactly as before, so they do not change. See
[`spec/layout.md`](spec/layout.md).

## Access model

Every caller has an owner ID and writes only its own sessions, under `owners/<owner>/` (X5).
Without an IdP, members share an org key and state their username; with one, they sign in and
get a one-hour session token and a 90-day device token for the uploader. Org-level sources write
as service accounts (`svc:<source-id>`). A session is visible to the whole org by default, or
to its owner only; admins and service readers see everything. `seshi admin init` creates the
first admin token and the org key. See [docs/server.md](docs/server.md#setting-up-who-may-call-it).

The server sees transcripts before redaction. Run it behind TLS, and read [`SECURITY.md`](SECURITY.md)
before exposing it.

## Development

```sh
bun install
bun run test          # the S3 store test needs SESSIONDB_TEST_S3_* and skips without them
bun run typecheck
bun run check         # biome lint + format, the package layer check, schemas, the hook's imports
bun run build         # the compiled seshi binary, dist/seshi (X2.2)
bun run check:hook    # time seshi hook against its budget (X3.3)
bun run goldens       # regenerate the goldens after a deliberate change to hashing or events
```

The repository is a Bun workspace: `apps/seshi/` is the one binary (`seshi serve` runs the
server; [docs/cli.md](docs/cli.md) lists every command), `packages/ts/` holds its packages
(redact, normalize, store, the pipeline, auth, the instance and its worker jobs, the HTTP
routes and client), `integrations/` holds what is specific to each agent, and `spec/` is the
contract they honour, the layout and the cross-language goldens. `CONTRIBUTING.md` has the
layout.

A push to `main` with a [Conventional Commit](https://www.conventionalcommits.org/) in it is a
release: CI picks the version from the commits, publishes `ghcr.io/dosu-ai/sessiondb` at that
version, and tags `vX.Y.Z`. The repository has one version; it is what every trace records as
its normalizer and what `/healthz` reports.

The goldens (in `spec/testdata/` and each integration's `testdata/`) pin the normalized records
of every fixture transcript and the `content_hash` and events each parses to. The goldens test
fails on any change to the hash derivation, so such a change is a reviewed diff and never an
accident. Fixture transcripts are generated by `tests/tooling/fixtures.ts`, so they contain no
real sessions.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how changes are reviewed.

## License

[MIT](LICENSE).
