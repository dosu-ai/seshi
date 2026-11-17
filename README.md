<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/lockup/seshi-lockup-dark-outlined.svg">
  <img src="brand/lockup/seshi-lockup-light-outlined.svg" alt="seshi" width="272" height="80">
</picture>

**Seshi is a toolkit for teams to capture, redact, store, and analyze coding agent sessions.**

## Who is Seshi for?

Teams that want to get the most out of coding agents: to see how the work actually gets done,
find the session where a decision was made, and learn what works across everyone's agents.

And teams that are software factory curious: the sessions are the record of how your agents
work, kept in one format, ready for evals, reviews and the next generation of your agent
workflows.

## Why use Seshi?

- **Built-in integrations, and extensible.** Claude Code, Codex and Cursor are captured through
  their hooks; OpenCode, pi and Gemini CLI transcripts upload as they are. Each integration is a
  package in [`integrations/`](integrations); contributions are welcome
  ([CONTRIBUTING.md](CONTRIBUTING.md)).
- **Coding and cloud agents.** Laptop agents through hooks; cloud agents through OpenTelemetry
  (a Claude Console destination), Datadog LLM Observability, and an S3 source for sandboxes and
  eval harnesses.
- **Any S3-compatible storage.** AWS S3, Cloudflare R2, any store with conditional writes, or a
  folder. The bucket is the source of truth, in a [documented layout](spec/layout.md) anything
  can read.
- **Redaction and PII scrubbing.** Secrets are removed before anything is written, and there is
  no switch to turn it off. Add your own rule packs, and an optional model review for what
  patterns miss, such as personal or customer data.
- **Access and visibility controls.** Sessions are visible to the org or to their owner only.
  Anyone can turn capture off for a session, a folder or a repository, and a session turned off
  is retracted.
- **Agent agnostic.** Every agent's log is normalized to one format, and exported as Letta
  trajectory-v1, OpenTelemetry spans or ATIF.
- **Authentication built in.** Sign in through your identity provider (Okta, Entra or any OIDC
  issuer), or share an org key. Tokens are scoped, stored as hashes and revocable.
- **OpenTelemetry support.** The server is an OTLP/HTTP endpoint, and every session can be read
  back as OTLP spans.
- **Session search.** Find sessions by what was said and done in them: prompts, answers, tool
  calls, file paths and commands.

## How is this different from agent observability tools?

LLM observability tools trace the applications you build: the model calls your product makes in
production. Seshi keeps the sessions your developers run with coding agents.

- **It captures where the work happens.** Hooks in the agents on each laptop, not an SDK in your
  code.
- **The archive is yours.** Sessions live in your bucket, in an open layout that can be read
  without Seshi's server.
- **People are in control.** Redaction runs before anything is stored, the person at the
  keyboard can turn capture off for any session, and what they turn off is retracted.
- **It works alongside them.** Seshi reads OpenTelemetry and Datadog LLM Observability, and
  writes OpenTelemetry back out.

## Getting started

```sh
curl -fsSL https://github.com/dosu-ai/sessiondb/releases/latest/download/install.sh | sh   # macOS, Linux
npm i -g seshi                                                                             # or with npm
```

On Windows: `irm https://github.com/dosu-ai/sessiondb/releases/latest/download/install.ps1 | iex`.
[docs/install.md](docs/install.md) has the platforms, options and checksums.

### Run it locally

With no server, the CLI writes your own bucket directly:

```sh
seshi init --serverless --url file:///Users/alice/seshi   # or s3://bucket/prefix (with --region), r2://bucket/prefix (with --account-id)
seshi capture install              # hooks into every agent found on this machine
seshi upload --since 30d           # the last 30 days of those agents' sessions
seshi sessions ls
seshi search flaky checkout test
```

From then on each session is uploaded as it goes. Claude Code's status line says
`Session Capture ◉` while a session is captured; `/seshi` (`$seshi` in Codex) turns it off or on
for the session you are in.

### Run it for a team

There are two modes.

**1. Server (recommended).** One server holds the bucket's keys; laptops hold only a revocable
Seshi credential. It adds identity-provider sign-in, redaction a laptop cannot skip, one shared
search index, and the OpenTelemetry, Datadog and S3 sources.

```sh
# on the server, with a seshi.toml naming the bucket ([store] url = "s3://acme-sessions/seshi")
seshi config check --config seshi.toml   # every problem at once, with where each value came from
seshi admin init --config seshi.toml     # prints the first admin token and the org key, once each
seshi serve                              # listens on :7200; put TLS in front
```

```sh
# on each laptop
seshi login --server https://seshi.acme.com   # the org key, or sign in through your IdP
seshi capture install
```

The container image is `ghcr.io/dosu-ai/sessiondb` ([docs/server.md](docs/server.md#deploying)).

**2. Serverless.** Nothing to run: each laptop runs the pipeline and writes its own folder of a
shared bucket with its own key. Use it when the team trusts its laptops
([docs/serverless.md](docs/serverless.md) says what needs a server).

```sh
seshi init --serverless --url s3://acme-seshi/seshi --region us-east-1 --admin   # an admin, once
seshi init --serverless --url s3://acme-seshi/seshi --region us-east-1           # each member
seshi capture install
```

Everything else is in [docs/](docs/README.md).

## How it works

![How a session moves through seshi: agent hooks and the uploader on the developer laptop, the seshi serve API, pipeline and worker, the bucket, and the readers](docs/architecture.svg)

Every upload goes through one pipeline in memory, and only its result is written. The log is
normalized and redacted, model review runs if a policy applies, and only what is new is written:
a log that grew adds its tail. The trace is stored under its content hash, an entry is appended
to the bucket's change feed, and the session's pointer moves to it. Readers use the CLI, the HTTP
API, or the change feed directly.

## Roadmap

- Publishing the Cursor status bar extension on Open VSX (it is built and attached to each
  release).
- Cursor Cloud Agents sync.
- Datadog Trajectory's local session files.
- Proving the setups that have not met real services yet: per-person AWS IAM policies for
  serverless teams, Cloudflare R2, and Okta, Entra and Google sign-in.

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
