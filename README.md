<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/lockup/seshi-lockup-dark-outlined.svg">
  <img src="brand/lockup/seshi-lockup-light-outlined.svg" alt="seshi" width="272" height="80">
</picture>

**Seshi is an open-source toolkit for capturing, redacting, storing, and analyzing coding agent sessions.** It works across agents and environments within your infrastructure.

## Who is Seshi for?

Teams that want to get the most out of coding agents. Agent sessions are incredibly rich with information. In many ways they are the new PR. They tell you how work was done, what decisions were made, what went wrong, etc.

Seshi is the easiest way for teams to create a secure shared session store for building downstream applications like

- Token usage and spend insights
- Shared memory layer
- Team decision log
- Measuring agent friction
- and much much more.

## Why Seshi?

- **One format for every coding agent.** Capture sessions from Claude Code, Codex, Cursor,
  OpenCode, pi, Gemini CLI, and Datadog Trajectory ([supported agents](#supported-agents)). Normalize everything into a common format and
  export as OpenTelemetry spans or ATIF. Extend support with
  [your own integrations](integrations).
- **Local and cloud agents.** Collect sessions from developer machines, cloud sandboxes, and eval
  harnesses through native integrations, OpenTelemetry, Datadog LLM Observability, or S3.
- **Your data, your storage.** Store sessions in AWS S3, Cloudflare R2, any compatible object
  store with conditional writes, or a local folder. Your storage is the source of truth, with an
  open, [documented layout](spec/layout.md) that any tool can read.
- **Redaction by default.** Remove secrets before they're stored. Customize redaction rules and
  LLM-based redaction to fit your needs.
- **Privacy and control.** Keep sessions private or share them with your organization. Disable
  capture for individual sessions, folders, or repositories, with automatic retraction of
  disabled sessions.
- **Your identity provider.** Authenticate with Okta, Microsoft Entra, any OIDC provider, or a
  shared organization key. Tokens are scoped, hashed, and revocable.
- **Search across sessions.** Find exactly what agents said and did, including prompts,
  responses, tool calls, file paths, and commands.

## How is this different from agent observability tools?

LLM observability tools trace the agents you build. Seshi keeps the sessions of the agents you
build with.

- **A different audience.** Observability is for teams shipping LLM products and debugging them
  in production. Seshi is for teams using coding agents to get work done.
- **Built for coding agents.** Hooks in the agents on each laptop and syncs from cloud agents with skills to allow developers to toggle capture on/off whenever they want.
- **You own the data.** Sessions live in your bucket, in an open layout that can be read without
  Seshi.
- **Kept as long as you want.** Observability tools keep traces for a retention window, often a
  few weeks. Seshi keeps sessions until you delete them.
- **Works alongside them.** Seshi reads OpenTelemetry and syncs Datadog LLM Observability, and
  writes sessions back out as OpenTelemetry spans.

## Getting started

```sh
curl -fsSL https://github.com/dosu-ai/sessiondb/releases/latest/download/install.sh | sh   # macOS, Linux
npm i -g @dosu/seshi                                                                       # or with npm
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
`Session Capture ◉` while a session is captured; `/session-capture` (`$session-capture` in Codex) turns it off or on
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

## Supported agents

| Client | Live capture | Capture state shown in | Turn off or on in the session | Upload its session files |
|---|:-:|---|---|:-:|
| Claude Code, including the Claude desktop app | ✓ | Status line; a chip in the desktop app | `/session-capture` | ✓ |
| Codex CLI | ✓ | A notice when the session starts | `$session-capture` | ✓ |
| Cursor (editor) | ✓ | Status bar extension | `/session-capture`, or a click on the status bar | ✓ |
| Cursor CLI | ✓ | Status line | `/session-capture` | ✓ |
| OpenCode (1.x and 2.x) | ✓ | Beside the prompt; a notice when the session starts | `/session-capture` | ✓ |
| pi | ✓ | Footer | `/session-capture` | ✓ |
| Oh My Pi, OpenClaw | — | — | — | ✓ |
| Gemini CLI | — | — | — | ✓ |
| Devin | — | — | — | — |
| Factory Droid | — | — | — | — |

### Cloud and managed agents

| Agent | Supported | How |
|---|:-:|---|
| Claude Managed Agents, and Messages API calls | ✓ | A Claude Console [OpenTelemetry destination](docs/otlp.md) |
| Claude Code, Codex or Cursor CLI in your own sandboxes, CI or eval harnesses | ✓ | `seshi capture install` in the sandbox, or transcripts written to a bucket an [S3 source](docs/s3-sync.md) polls |
| Any agent that writes OpenTelemetry GenAI spans | ✓ | The [OTLP endpoint](docs/otlp.md) |
| Cursor Cloud Agents | ✓ | Hooks committed to the repository, and seshi installed and signed in by its environment setup: `seshi capture install cursor --project` ([capture.md](docs/capture.md#cursor-cloud-agents)). Tool results are not captured yet |
| Codex cloud, GitHub Copilot coding agent | — | |

A new agent is an [integration](integrations).

## Roadmap

- [x] Cursor Cloud Agents through hooks committed to the repository
- [ ] Cursor Cloud Agents through Cursor's API, for runs whose repository has no hooks (F7)
- [ ] Tool results in Cursor transcripts (from `postToolUse`)
- [ ] Devin Cloud sync: a source that pulls Devin cloud sessions through Devin's API
- [x] A Python SDK for the seshi API ([`packages/py/client`](packages/py/client), [docs](docs/client.md#python-seshi))
- [ ] Publishing the Python SDK to PyPI as `seshi`, next to `@dosu/seshi-client`
- [ ] Publishing the Cursor status bar extension on Open VSX (it is built and attached to each
      release)

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
