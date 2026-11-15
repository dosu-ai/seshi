<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/lockup/seshi-lockup-dark-outlined.svg">
  <img src="brand/lockup/seshi-lockup-light-outlined.svg" alt="seshi" width="272" height="80">
</picture>

*Every session has a thread.*

seshi captures your coding agents' sessions, redacts them, and keeps them, searchable, in a
bucket you own.

It is one binary. `seshi serve` is the server. `seshi capture install` hooks Claude Code, Codex
and Cursor so every session is captured as it happens. The rest of the CLI lists, exports and
searches what was captured.

## Why

Claude Code, Codex, Cursor, OpenCode, pi and Gemini CLI each write a log of what they did, in
their own format, on the machine they ran on. Those logs record how the work was done. They are
also full of secrets, scattered across laptops, and shaped six different ways.

seshi turns them into one archive. It normalizes every log to one format
([Letta trajectory-v1](https://github.com/letta-ai/trajectory) records), removes credentials,
and writes the result to S3, Cloudflare R2, any S3-compatible store or a folder, in a
[documented layout](spec/layout.md) anything can read. Three things follow:

- **The bucket never holds an unredacted byte.** Redaction runs before anything is written,
  and there is no switch to turn it off. The raw transcript is never stored.
- **In a team, laptops never hold a bucket credential.** Each machine holds a revocable seshi
  credential instead: with an identity provider, a device token that can only write its
  person's sessions; without one, the org key every member shares.
- **The archive does not depend on the server.** Traces are content-addressed files with a
  change feed beside them, so a reader can tail the bucket with a read-only key.

## Install

```sh
curl -fsSL https://github.com/dosu-ai/sessiondb/releases/latest/download/install.sh | sh   # macOS, Linux
npm i -g seshi                                                                             # or with npm
```

On Windows: `irm https://github.com/dosu-ai/sessiondb/releases/latest/download/install.ps1 | iex`.
Every channel installs the same binary; [docs/install.md](docs/install.md) has the platforms,
options and checksums.

## Quick start: just you

With no server, the CLI writes your own bucket directly. This is local mode: the same pipeline,
redaction included, running in the CLI.

Name the bucket in a server config, and point the CLI's config at it:

```toml
# ~/.config/seshi/seshi.toml
[store]
url = "file:///Users/alice/seshi"      # or s3://bucket/prefix (with region), r2://bucket/prefix (with account_id)
```

```toml
# ~/.config/seshi/config.toml (on Windows, %APPDATA%\seshi\config.toml)
[local]
config = "~/.config/seshi/seshi.toml"
```

Then capture, backfill, and search:

```sh
seshi whoami                       # alice in local mode: sessions go straight to file:///Users/alice/seshi
seshi capture install              # hooks into every agent found on this machine
seshi upload --since 30d           # the last 30 days of those agents' sessions
seshi sessions ls
seshi search flaky checkout test
```

From now on each agent session is uploaded as it goes. In Claude Code the status line says
`Session Capture ◉` while the session is captured and `Session Capture ⏸` when it is not.

## Quick start: a team

One server holds the bucket's keys; everyone's laptop talks to it.

On the server, write `seshi.toml`, then set up the first credentials and start it:

```toml
# seshi.toml
[store]
url = "s3://acme-sessions/seshi"
region = "us-east-1"                   # keys from store.credentials, or the usual AWS_* variables
```

```sh
seshi config check --config seshi.toml # every problem at once, with where each value came from
seshi admin init --config seshi.toml   # prints the first admin token and the org key, once each
seshi serve                            # reads ./seshi.toml; listens on :7200; put TLS in front
```

Or run the container image, `ghcr.io/dosu-ai/sessiondb`, with the same file mounted at
`/etc/seshi/seshi.toml` ([docs/server.md](docs/server.md#deploying)).

On each laptop:

```sh
seshi login --server https://seshi.acme.com   # asks for the org key, or signs in through your IdP
seshi capture install
```

Without an identity provider, members share the org key and state their username. With one
(Okta, Entra or another OIDC issuer), they sign in and each machine gets its own write-only
device token ([docs/server.md](docs/server.md#setting-up-who-may-call-it)).

## What it does

**Capture** ([docs/capture.md](docs/capture.md)). Hooks in Claude Code, Codex and Cursor hand
each turn to seshi in a few milliseconds. A background uploader sends only what each log gained,
and a sweep picks up whatever the hooks missed. Capture can be turned off for everything, a
folder, a repository (a committed `.seshi/config.toml`) or one session. A session turned off is
retracted from the server.

**Redaction rules** ([docs/redaction.md](docs/redaction.md)). The built-in pack removes
provider tokens, credential assignments, bearer headers, JWTs, connection URLs and private keys,
and catches long random strings by their entropy. It withholds what a tool call returned when the
call read a secrets file or ran a command that prints a secret. Add your own rule packs in TOML.
Their patterns run under RE2, so no pattern can hang the server. `seshi redact test` tries a pack
on a transcript, and `seshi redact backfill` applies new rules to sessions already stored. The
uploader redacts with the same rules before anything leaves the laptop.

**Model review** ([docs/model-review.md](docs/model-review.md)). An optional second stage for
what patterns miss, such as a password in prose, personal data or customer data. A decision model
labels each upload allow, redact or drop. For redact, a model points at the exact text and code
removes it. A model never rewrites the transcript. It runs on Anthropic's API or any
OpenAI-compatible endpoint, including a model on your own network.

**Search** ([docs/search.md](docs/search.md)). `seshi search` finds sessions by what was said and
done in them: prompts, answers, tool calls, file paths and commands. Each server keeps a SQLite
full-text index built from the change feed, and results follow the same read rules as
everything else.

**Access and visibility** ([docs/server.md](docs/server.md#who-sees-what)). Every caller has an
owner and writes only its own sessions. A session is visible to the whole org, or to its owner
only. Tokens are scoped, stored as hashes, and revocable one at a time or all of a person's at
once.

**OpenTelemetry** ([docs/otlp.md](docs/otlp.md)). The server is an OTLP/HTTP trace endpoint.
Point a Claude Console OpenTelemetry destination, or any exporter that follows the GenAI
conventions, at it, and each conversation becomes a session.

**Datadog** ([docs/datadog.md](docs/datadog.md)). A Datadog source polls LLM Observability and
rebuilds the sessions [Datadog Trajectory](https://github.com/datadog-labs/trajectory) published
there. Nothing runs on laptops.

**S3 sync** ([docs/s3-sync.md](docs/s3-sync.md)). An S3 source polls a bucket that eval
harnesses, ATIF exports or cloud sandboxes write transcripts to. It reads only what changed, and
only the new tail of a log that grew.

**Formats** ([docs/formats.md](docs/formats.md)). Every session is stored in one canonical trace
format and can be exported as Letta trajectory-v1, OpenTelemetry spans or ATIF:
`seshi sessions export claude-code <id> --format otlp`.

## How it works

![How a session moves through seshi: agent hooks and the uploader on the developer laptop, the seshi serve API, pipeline and worker, the bucket, and the readers](docs/architecture.svg)

Every upload goes through one pipeline in memory, and only its result is written. The log is
normalized to trajectory-v1 records and redacted. A session's first trace is kept only if it
holds a real exchange (by default, a prompt, a reply, and 2,000 characters of text and tool
traffic). Only what is new is written: a log that
grew adds its tail. Model review runs if a policy applies. Then the trace is written under its
content hash, an entry is appended to the change feed, and the session's pointer moves to it.

## Docs

[docs/README.md](docs/README.md) lists every page. The main ones:

- [install.md](docs/install.md), [capture.md](docs/capture.md), [cli.md](docs/cli.md) and
  [search.md](docs/search.md), for using seshi;
- [server.md](docs/server.md) and [config.md](docs/config.md), for running a server;
- [redaction.md](docs/redaction.md), [model-review.md](docs/model-review.md),
  [otlp.md](docs/otlp.md), [datadog.md](docs/datadog.md) and [s3-sync.md](docs/s3-sync.md),
  feature by feature;
- [formats.md](docs/formats.md), [client.md](docs/client.md),
  [`spec/openapi.yaml`](spec/openapi.yaml) and [`spec/layout.md`](spec/layout.md), for building
  on it;
- [SECURITY.md](SECURITY.md), before you expose a server.

## Development

```sh
bun install
bun run test
bun run typecheck
bun run check
bun run seshi -- --help     # the binary, from source
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the repository layout and what a change needs, and
[docs/releasing.md](docs/releasing.md) how releases are cut. The decisions behind the design are
in [docs/seshi/design-decisions.html](docs/seshi/design-decisions.html).

## License

[MIT](LICENSE).
