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
| `healthcheck [--url] [--config]` | Ask a running server's `/healthz` where `server.listen` says it listens (the container's health check) | Built |
| `login`, `logout`, `whoami` | Sign in to a server (F8.2) | Branch 13 |
| `sessions ls\|show\|export\|rm`, `tokens` | Sessions and tokens through the API | Branch 13 |
| `capture install\|uninstall\|status\|pause\|resume\|off\|on`, `hook <agent> <event>`, `upload <path>`, `daemon`, `statusline` | Capture on this machine (F9) | Branch 14 |
| `search <query>` | Search what you may read (F10) | Branch 12 |
| `redact test [<file> \| -] [--pack <file>]… [--config]` | Check rule packs' test strings, and show how often each rule fires on a transcript or text and where, never what matched ([below](#redaction-rules)) | Built |
| `redact backfill (--since <30d> \| --all) [--dry-run]` | Apply the server's current rules to stored sessions (F2.5, [below](#redaction-rules)). Exit 8 when a session changed while it ran | Built |

`serve`, `admin`, `workers`, `sync`, `reprocess` and `redact backfill` run where the server's
config and bucket keys are: they load the server config the way `serve` does (`--config`, `SESHI_CONFIG`,
`./seshi.toml`, `/etc/seshi/seshi.toml`, then `SESHI_*` env and `--set`).

## Redaction rules

`seshi redact test` tries rule packs ([server.md](server.md#your-own-redaction)) without a
server. The rule set is the built-in pack, the server's `[redaction] packs` when `--config`
names its config, and each `--pack` file. Without a file it checks every rule against its test
strings. With a file (or `-` for standard input) it also shows how often each rule fired and
where: by record for a transcript (its format is detected, or named with `--agent`; it is
normalized and redacted as the server would), by line for plain text (`--text`, or anything no
format reads; each line counts as `--field text`, `tool_input` or `tool_output`). It never shows
what matched; `--print` prints the redacted records or text on stdout (the report goes to
stderr then). `--json` gives one document: `rule_set`, `builtin`, `packs`, every rule with its
pack, engine and whether it is on, `tests`, and with a file `input`, `matches` and `output`.
Exit 1 when a test string fails, 3 for a pack it cannot use, 4 for a missing file.

`seshi redact backfill` applies the server's current rule set to stored sessions (F2.5): the
ones written `--since` a duration (`30d`) or time, or `--all`, optionally only `--owner <id>`
(repeatable), stopping after `--limit N` rewritten. A session an earlier rule set redacted is
redacted again; one the new rules change gets one new trace with the whole session, its old
trace objects are deleted, its counts grow, and a `published` change entry with `replace:
true` and `reason: "redacted"`, written as `--as <owner>` (default `admin`, source
`redaction`), tells readers to take the new trace. A session the rules do not change only has
its rule set recorded. Redaction cannot be undone; `--dry-run` writes nothing and lists what
would change. It is safe to stop and run again: sessions already redacted with the current
rules are skipped. Restart the server with the new packs first, or it keeps writing with the
old rules. Exit 8 when a session changed while it ran (run it again).

## Talking to a server, or to your own bucket (F8.3, X3.5)

The session commands (branch 13) and the uploader (14) work against a `SessionDB`: a seshi
server over HTTP when the CLI config sets `server`, or, in local mode, an Instance built
in-process from the server config `[local] config` names, for one person who owns the bucket.
Nothing else writes a bucket. See [config.md](config.md#the-clis-config).
