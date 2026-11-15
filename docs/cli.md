# The seshi command line

One binary, `seshi` (X2.2), holds the CLI, the hooks agents call and the server. Each command
loads only its own code (X3.3), so `seshi hook`, which runs on every agent turn, starts in a
few milliseconds; `bun run check:hook` holds it to that in CI.

`seshi --help` lists the commands, `seshi --version` prints the release. Build the binary with
`bun run build` (`dist/seshi`); from a checkout, `bun run seshi <command>` runs the same thing
from source.

The compiled binary reads settings from `SESHI_*` env and the TOML files only. Unlike
`bun run`, it never reads the working folder's `.env` or `bunfig.toml`: `seshi hook` runs in
whatever repository the agent is in, and a `bunfig.toml` `preload` there would run that
repository's code.

## Conventions (F8.1)

- Output is readable lines by default. With `--json`, a command prints exactly one JSON
  document on stdout, and an error as `{"error": {"code", "message"}}` on stderr.
- Messages go to stderr as `seshi: …`, warnings as `seshi: warning: …`.
- Exit codes are stable; scripts may branch on them:

| Code | Name | Meaning |
|---|---|---|
| 0 | `ok` | It did what was asked |
| 1 | `failure` | Something failed that no other code covers |
| 2 | `usage` | The command line is wrong: an unknown command, option or argument |
| 3 | `config` | The config cannot be used, or the bucket or server it names cannot be |
| 4 | `notFound` | What was asked for does not exist (a source, a file, a session) |
| 5 | `auth` | Not signed in, or the credential may not do this |
| 6 | `conflict` | Refused because of the state it found (a checkpoint another worker moved; a second `admin init`). Later may succeed |
| 7 | `unavailable` | A server, bucket or vendor API could not be reached |
| 8 | `attention` | Worked, with something to look at (a stopped or second worker, a failed job) |
| 9 | `notImplemented` | Part of seshi, not built yet in this binary |

## Commands

| Command | | Status |
|---|---|---|
| `serve [--config] [--listen] [--roles api,worker] [--set path=value]…` | Run the server: the HTTP API and the worker's jobs ([server.md](server.md#roles-and-background-work)) | Built |
| `config check\|show [--cli] [--origin] [--json]` | Validate the config, or show every value and where it came from ([config.md](config.md)) | Built |
| `admin init [--owner] [--force] [--rotate-org-key]` | The first admin token and the org key ([server.md](server.md#setting-up-who-may-call-it)) | Built |
| `workers status [--json]` | The worker, its jobs' last runs, errors and backlog, each source's drop and failure counts (X7.5). Exit 8 when something needs a look | Built |
| `sync run <id> [--force]` | Poll a source once, for cron (X7.1). Exit 6 when another worker moved the checkpoint | Built |
| `sync status [<id>] [--days N]` | Checkpoints, record counts and source health | Built |
| `sync failed <id>`, `sync dropped <id>` `[--since] [--limit]` | Envelopes that failed or that model review dropped, and why; never their content (X6.4). `upload` is the source of hooks and uploads | Built |
| `reprocess --source <id> [--since <time>] [--dry-run] [--run]` | Rewind a source so its sessions are read again (X4.9). Uploads are resent by the capture uploader (14) | Built |
| `normalize [--agent <format>] [<file> \| -]` | A transcript as canonical, redacted records, one per line (`--json`: one document). For tools in other languages (X3.10) | Built |
| `healthcheck [--url]` | Ask a running server's `/healthz` (the container's health check) | Built |
| `login`, `logout`, `whoami` | Sign in to a server (F8.2) | Branch 13 |
| `sessions ls\|show\|export\|rm`, `tokens` | Sessions and tokens through the API | Branch 13 |
| `capture install\|uninstall\|status\|pause\|resume\|off\|on`, `hook <agent> <event>`, `upload <path>`, `daemon`, `statusline` | Capture on this machine (F9) | Branch 14 |
| `search <query>` | Search what you may read (F10) | Branch 12 |
| `redact test\|backfill` | Try rules on a file; apply new rules to stored sessions (F2) | Branch 07 |

`serve`, `admin`, `workers`, `sync` and `reprocess` run where the server's config and bucket
keys are: they load the server config the way `serve` does (`--config`, `SESHI_CONFIG`,
`./seshi.toml`, `/etc/seshi/seshi.toml`, then `SESHI_*` env and `--set`).

## Talking to a server, or to your own bucket (F8.3, X3.5)

The session commands (branch 13) and the uploader (14) work against a `SessionDB`: a seshi
server over HTTP when the CLI config sets `server`, or, in local mode, an Instance built
in-process from the server config `[local] config` names, for one person who owns the bucket.
Nothing else writes a bucket. See [config.md](config.md#the-clis-config).
