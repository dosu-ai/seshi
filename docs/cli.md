# The seshi command line

One binary, `seshi` (X2.2), holds the CLI, the hooks agents call and the server. Each command
loads only its own code (X3.3), so `seshi hook`, which runs on every agent turn, starts in a
few milliseconds; `bun run check:hook` holds it to that in CI.

`seshi --help` lists the commands, `seshi <command> --help` prints that command's usage, and
`seshi --version` prints the release. Install it with the install script, npm
(`npm i -g seshi`) or a GitHub release binary ([install.md](install.md)); build it with
`bun run build` (`dist/seshi`); from a checkout, `bun run seshi <command>` runs the same thing
from source.

The compiled binary reads settings from `SESHI_*` env and the TOML files only. Unlike
`bun run`, it never reads the working folder's `.env` or `bunfig.toml`: `seshi hook` runs in
whatever repository the agent is in, and a `bunfig.toml` `preload` there would run that
repository's code.

## Conventions (F8.1)

- Output is readable lines by default. With `--json`, a command prints exactly one JSON
  document on stdout, and an error as `{"error": {"code", "message"}}` on stderr. Every
  command takes it but `serve` (a running server, which logs) and `hook` (called by agents,
  which prints nothing).
- Messages go to stderr as `seshi: …`, warnings as `seshi: warning: …`. Questions (a
  confirmation, a hidden org key) and sign-in instructions go to stderr too, so stdout stays the
  answer.
- Colour is quiet (B1.4): mint for success (deep teal on a light terminal), lilac for search
  results and links, spark for warnings and work in progress (the terminal's own magenta and
  yellow on a light one), the terminal's red for errors. Every coloured status is also a word,
  so nothing is said by colour alone. Truecolor when `COLORTERM` says so, the nearest
  256-colour value when `TERM` does, else the basic sixteen; the background is never set.
- No colour or glyphs when stdout is not a terminal, with `NO_COLOR`, with `--no-color` (any
  command, anywhere on the line), and always with `--json`.
- Text a command did not write itself (a transcript, a project name, a token label, a failure
  record) is printed with its control characters replaced by U+FFFD, so a stored session cannot
  move the cursor, retitle the window or write the clipboard. `--json` output keeps them,
  escaped.
- The background is dark unless `SESHI_THEME=light|dark` (or `theme` in the CLI config) says
  otherwise, `COLORFGBG` names a light one, or the terminal answers an OSC 11 query within
  100 ms. The colours come from `brand/tokens.json` through the generated
  `apps/seshi/src/cli/brand-tokens.ts` (`bun run brand`; `bun run check` fails when it is
  stale).
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
| 9 | `notImplemented` | Reserved for a command this binary does not have yet; nothing returns it today |

## Commands

| Command | |
|---|---|
| `serve [--config] [--listen] [--roles api,worker] [--set path=value]…` | Run the server: the HTTP API and the worker's jobs ([server.md](server.md#roles-and-background-work)) |
| `config check\|show [--cli] [--origin] [--json]` | Validate the config, or show every value and where it came from ([config.md](config.md)) |
| `admin init [--owner] [--force] [--rotate-org-key] [--json]` | The first admin token and the org key ([server.md](server.md#setting-up-who-may-call-it)); `--json`: `{admin: {id, owner, token}, org_key: {id, token}, revoked}`, for a deployment script |
| `workers status [--server <url>] [--json]` | The worker, its jobs' last runs, errors and backlog, each source's drop and failure counts (X7.5). Exit 8 when something needs a look |
| `sync run <id> [--force]` | Poll a source once, for cron (X7.1). Exit 6 when another worker moved the checkpoint |
| `sync assemble` | Run the span assembler once, for cron (X7.1): publish the OTLP and Datadog sessions whose spans went quiet. Exit 1 when a session could not be assembled (it is tried again next run) |
| `sync prune` | Run the retention job once, for cron (X7.1): remove drop and failure records and source health shards past `[records]` retention |
| `sync status [<id>] [--days N] [--server <url>]` | Checkpoints, record counts and source health |
| `sync failed <id>`, `sync dropped <id>` `[--since] [--limit] [--server <url>]` | Envelopes that failed or that model review dropped, and why; never their content (X6.4). `upload` is the source of hooks and uploads |
| `reprocess --source <id> [--since <time>] [--dry-run] [--run]` | Rewind a polled source so its sessions are read again (X4.9). Not for uploads (`upload`): the server keeps no raw logs, so the machines that uploaded them resend them: their uploaders resend stale sessions by themselves, and `capture resend` does it by hand |
| `review eval [--policy <id>] [--fixtures <file or folder>]` | Score a model review policy on labelled fixtures, through its real providers: label accuracy, false and missed drops, redactor recall, leaks (F3.8; [model-review.md](model-review.md)). Seshi's own fixtures by default. Exit 8 when any fixture came out other than labelled |
| `normalize [--agent <format>] [<file> \| -]` | A transcript as canonical, redacted records, one per line (`--json`: one document, with the `llm_calls` the records name: model and token usage per call). For tools in other languages (X3.10) |
| `healthcheck [--url] [--config] [--json]` | Ask a running server's `/healthz` where `server.listen` says it listens (the container's health check); `--json`: `{ok, url, version}` |
| `login [--server <url>] [--key <key>\|-] [--token <token>\|-] [--user <name>] [--browser\|--device] [--visibility org\|owner]` | Sign in to a server (F8.2), [below](#signing-in-f82) |
| `logout [--server <url>] [--all]` | Forget the stored credentials |
| `whoami [--server <url>]` | Who the CLI is signed in as, and whether the credential still works |
| `sessions ls [--owner] [--limit N] [--after] [--all]` | An owner's sessions, newest first |
| `sessions show <agent> <id> [--owner] [--trace]` | A session's metadata and, with model review on, each stored write's decision (`allow`, `redact`, `skipped`; F3.8); `--trace` adds its head trace, a line per record |
| `sessions export <agent> <id> [--format seshi\|letta\|otlp\|atif] [--hash] [-o <file\|dir>]` | The trace itself, on stdout or into a file |
| `sessions rm <agent> <id> [--owner] [--yes]` | Delete a session (a tombstone; it cannot be undone). Asks on a terminal, needs `--yes` elsewhere |
| `sessions visibility <agent> <id> org\|owner [--owner]` | Change who may read a session (X5.10) |
| `tokens ls [--owner] [--kind] [--all]`, `tokens create <kind> [--owner] [--service] [--scope]… [--visibility] [--expires 30d\|date] [--label]`, `tokens revoke <id>\|--owner <id> [--kind]` | Manage tokens (X5.9, X5.11; admins). A new token is printed once |
| `capture install [<agent>…] [--service] [--command <program>]` | Wire seshi into Claude Code, Codex and Cursor on this machine (F9.6); with no agent, every one found. Merges into each agent's own config and keeps every hook there ([capture.md](capture.md#installing)) |
| `capture uninstall [<agent>…] [--service] [--command <program>]` | Take out only seshi's entries (`--command`: the program an install was given, when it is not named `seshi`) |
| `capture status [--session [<id>]] [--agent <a>]` | Whether this folder (or session) is captured and which rule decided, where uploads go, the queue, problems, agents, recent sessions. Exit 8 when something needs action |
| `capture pause [<duration>]`, `capture resume` | Stop every session where it is for a while (`2h`), or until resumed: running sessions keep what they uploaded and send nothing more, even after the pause; sessions started during it are not captured; nothing is retracted. `capture on --session <id>` uploads a stopped session in full ([capture.md](capture.md#what-is-captured)) |
| `capture off\|on [--session [<id>]] [--agent <a>]`, `capture off\|on --path <folder>`, `capture off\|on` | Turn capture off or on for one session (off retracts what was uploaded, F9.7), a folder, or everything (F9.5) |
| `capture resend --all \| --session [<id>] [--agent <a>]` | Send sessions uploaded from this machine again, whole, to be rebuilt and reviewed again (X4.9), as the uploader does by itself for sessions an older normalizer built. Leaves out sessions turned off, never uploaded or whose transcript is gone; exit 6 when the one session named is one of them ([capture.md](capture.md#uploading-by-hand)) |
| `hook <agent> <event>` | Internal: agents call it on their events (F9.1). Reads the payload, applies the rules, spools, starts the uploader. Always exits 0 and prints nothing |
| `daemon [--keep-alive] [--once] [--idle <duration>]` | The background uploader and sweep (F9.1, F9.3); hooks start it. One per machine; `--keep-alive` (the service entry) waits for its turn instead of exiting |
| `upload <path>… \| --since <duration>` `[--agent <a>]` | Send transcripts by hand, or backfill the installed agents' recent sessions, through the same rules and state as hooks |
| `statusline [--agent <a>]` | One line for an agent's status bar: `Session Capture ◉` or `⏸`, problems after a separator (B1.6). Local state only, no network |
| `doctor [--session [<id>]] [--agent <a>] [--since <duration>] [--deep] [--server <url>]` | Check that sessions are captured right, end to end: each session's transcript, this machine's capture state and what the server (or local bucket) stored, as ok, warn, fail or skip per check. `--session`: one session (no id: the one this agent runs, else the one seen in this folder); without it, every session seen in the past day (`--since 7d` widens it), a line each, then the failed checks. `--deep` also searches for each session. `--json`: `{sessions: [{agent, session_id, evidence, checks}]}`. Changes nothing. Exit 8 when a check failed; 5 or 7 when the server could not be asked ([capture.md](capture.md#checking-a-session)) |
| `explore [--port <n>] [--no-open] [--server <url>] [--since <duration>]` | A local, read-only web page for the same three views as `doctor`, side by side: every session seen in the past 7 days (`--since`), and for one session its checks, the pipeline (transcript bytes → records → redacted → sent → stored), the local transcript (re-normalized and redacted with this machine's rules, never raw) beside the stored records, a timeline and the raw evidence. Serves on 127.0.0.1 only and prints the address with a one-time token (open it as printed); opens the browser unless `--no-open`; runs until Ctrl-C. Changes nothing ([capture.md](capture.md#exploring-sessions-in-a-browser)) |
| `search <words…> [filters] [--json]`, `search --status\|--rebuild` | Search what you may read (F10); see [search.md](search.md) |
| `redact test [<file> \| -] [--pack <file>]… [--config]` | Check rule packs' test strings, and show how often each rule fires on a transcript or text and where, never what matched ([redaction.md](redaction.md#trying-and-applying-rules)) |
| `redact backfill (--since <30d> \| --all) [--dry-run]` | Apply the server's current rules to stored sessions (F2.5, [redaction.md](redaction.md#trying-and-applying-rules)). Exit 8 when a session changed while it ran |
| `redact sweep [--owner <id>]… [--dry-run]` | Delete the trace objects no session names that are over an hour old, as the worker does daily (F2.5, [redaction.md](redaction.md#trying-and-applying-rules)). Exit 1 when a session could not be swept |
| `store check [--owner <id>]… [--config] [--set path=value]…` | Check the bucket against the layout's invariants ([server.md](server.md#checking-the-bucket)): the layout marker, every session's metadata, head, traces and continuation chain, stubs and deleted sessions, old trace objects no session names, the change feed, span records and their messages, token records. A summary line, then each finding (`error` or `warn`, its code, what is wrong and the key) grouped by session; `--json`: `{store, findings: [{severity, code, owner?, archive_id?, key?, message}], counts}`. Reads only. Exit 0 with no errors (warnings alone included), 8 with any |

`serve`, `admin`, `workers`, `sync`, `reprocess`, `redact backfill`, `redact sweep`, `store check` and `review` run where the
server's config and bucket keys are: they load the server config the way `serve` does
(`--config`, `SESHI_CONFIG`, `/etc/seshi/seshi.toml`, then `SESHI_*` env and `--set`), except
that only `serve` reads `./seshi.toml` without being told to. The folder may be a checkout
someone else wrote, whose secret references would send your env or files to its bucket, so
the others (and `config check`, and `search` with no server configured) say so in a one-line
hint instead: pass `--config ./seshi.toml`. `workers status` and `sync status|failed|dropped`
also run from an admin's laptop through the server's admin routes: with `--server <url>`, or,
when no server config is found, the CLI config's `server` (its `[local] config` is read as the
server config instead). `sync run` and `reprocess` stay where the config is. `store check` reads
the bucket itself, so it has no `--server`: with no server config found it checks local mode's
bucket (the CLI config's `[local] config`), else the one `SESHI_*` env names.

## Talking to a server, or to your own bucket (F8.3, X3.5)

The session commands and the uploader (14) talk to a seshi server over HTTP
(`@seshi/client`) when the CLI config sets `server`, with the credential `seshi login` stored;
or, in local mode, to an Instance built in-process from the server config `[local] config`
names, for one person who owns the bucket. `--server <url>` on any of them talks to that
server instead. Nothing else writes a bucket. See [config.md](config.md#the-clis-config).

In local mode the bucket's owner acts as its admin: `sessions --owner` reads any owner's
folder, `sessions rm` needs no fresh sign-in, and `tokens` work on the bucket's own token
records (for a server that will later serve it).

## Signing in (F8.2)

`seshi login --server https://seshi.acme.com` asks the server which ways in it takes
(`GET /v1/auth/config`), writes `server` to the CLI config, and signs in:

- **With an IdP** (X5.7): the device flow by default. It prints a URL and a code to enter in a
  browser, on any machine, and waits. `--browser` opens the IdP's sign-in page instead (PKCE
  with a redirect to `127.0.0.1`), and is used on its own when the IdP has no device flow. The
  ID token is exchanged once (`POST /v1/auth/exchange`) for a one-hour session token, which the
  interactive commands use, and a 90-day device token for this machine, which the uploader uses
  (it can only write). The IdP's refresh token renews the session token without signing in
  again; `offline_access` is asked for when the IdP lists it, which is how Okta and Entra give
  one. A delete needs a session token from the last 10 minutes (X5.3), so `sessions rm` renews
  it first. `--visibility owner` makes everything the device token uploads private. The IdP's
  authorization, token and device endpoints must be `https:` (or `http:` on `localhost` or
  `127.0.0.1`, for an IdP on the same machine): a discovery document that names any other
  scheme (`file:`, `smb:`, a custom one) is refused, and seshi never opens anything but an
  `http:` or `https:` page.
- **Without one** (X5.12): `--key -` reads the org key from stdin (on a terminal, plain
  `seshi login` asks for it without echo). The username stated with it is resolved on every
  call: `SESHI_USER`, then `user` in the CLI config (`--user` writes it), then `git config
  user.email`, then the OS user name. It must be printable ASCII.
- **A token** an admin issued (an admin or service token), or a static token: `--token -`.

Credentials go in the OS keychain through `Bun.secrets` (macOS Keychain, Windows Credential
Manager, libsecret), one entry per secret under the service `seshi`. Where there is no keychain
(a Linux machine without a secret service), they go to `credentials.json` next to the CLI
config, mode 0600, and login says so; `keychain = false` in the CLI config (`SESHI_KEYCHAIN=false`)
uses that file always, for a machine whose keychain prompts or hangs. `logins.json` in the same folder holds what is not secret:
the mode, who the server says you are, the IdP's token endpoint, expiry times, and this
machine's id (kept across logouts, so signing in again replaces this machine's device token
rather than adding one). Secrets are never passed in env.

`seshi logout` forgets the server's credentials (`--all`: every server's). It cannot revoke
anything on the server; it names the device token, which stays valid until it expires or an
admin runs `seshi tokens revoke <id>`. `seshi whoami` asks the server who the stored credential
is, so it also tells whether it still works.

## Search and redaction

`seshi search` has its own page, [search.md](search.md): the query syntax, the filters, and
where it searches (a server, or your own bucket's local index). `seshi redact test` and
`seshi redact backfill` are in [redaction.md](redaction.md#trying-and-applying-rules), with the
rule packs they try.
