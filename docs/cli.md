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
| 9 | `notImplemented` | Part of seshi, not built yet in this binary |

## Commands

| Command | | Status |
|---|---|---|
| `serve [--config] [--listen] [--roles api,worker] [--set path=value]…` | Run the server: the HTTP API and the worker's jobs ([server.md](server.md#roles-and-background-work)) | Built |
| `config check\|show [--cli] [--origin] [--json]` | Validate the config, or show every value and where it came from ([config.md](config.md)) | Built |
| `admin init [--owner] [--force] [--rotate-org-key]` | The first admin token and the org key ([server.md](server.md#setting-up-who-may-call-it)) | Built |
| `workers status [--server <url>] [--json]` | The worker, its jobs' last runs, errors and backlog, each source's drop and failure counts (X7.5). Exit 8 when something needs a look | Built |
| `sync run <id> [--force]` | Poll a source once, for cron (X7.1). Exit 6 when another worker moved the checkpoint | Built |
| `sync status [<id>] [--days N] [--server <url>]` | Checkpoints, record counts and source health | Built |
| `sync failed <id>`, `sync dropped <id>` `[--since] [--limit] [--server <url>]` | Envelopes that failed or that model review dropped, and why; never their content (X6.4). `upload` is the source of hooks and uploads | Built |
| `reprocess --source <id> [--since <time>] [--dry-run] [--run]` | Rewind a source so its sessions are read again (X4.9). Uploads are resent by the capture uploader (14) | Built |
| `review eval [--policy <id>] [--fixtures <file or folder>]` | Score a model review policy on labelled fixtures, through its real providers: label accuracy, false and missed drops, redactor recall, leaks (F3.8; [server.md](server.md#model-review)). Seshi's own fixtures by default. Exit 8 when any fixture came out other than labelled | Built |
| `normalize [--agent <format>] [<file> \| -]` | A transcript as canonical, redacted records, one per line (`--json`: one document). For tools in other languages (X3.10) | Built |
| `healthcheck [--url] [--config]` | Ask a running server's `/healthz` where `server.listen` says it listens (the container's health check) | Built |
| `login [--server <url>] [--key <key>\|-] [--token <token>\|-] [--user <name>] [--browser\|--device] [--visibility org\|owner]` | Sign in to a server (F8.2), [below](#signing-in-f82) | Built |
| `logout [--server <url>] [--all]` | Forget the stored credentials | Built |
| `whoami [--server <url>]` | Who the CLI is signed in as, and whether the credential still works | Built |
| `sessions ls [--owner] [--limit N] [--after] [--all]` | An owner's sessions, newest first | Built |
| `sessions show <agent> <id> [--owner] [--trace]` | A session's metadata; `--trace` adds its head trace, a line per record | Built |
| `sessions export <agent> <id> [--format seshi\|letta\|otlp\|atif] [--hash] [-o <file\|dir>]` | The trace itself, on stdout or into a file | Built |
| `sessions rm <agent> <id> [--owner] [--yes]` | Delete a session (a tombstone; it cannot be undone). Asks on a terminal, needs `--yes` elsewhere | Built |
| `sessions visibility <agent> <id> org\|owner [--owner]` | Change who may read a session (X5.10) | Built |
| `tokens ls [--owner] [--kind] [--all]`, `tokens create <kind> [--owner] [--service] [--scope]… [--visibility] [--expires 30d\|date] [--label]`, `tokens revoke <id>\|--owner <id> [--kind]` | Manage tokens (X5.9, X5.11; admins). A new token is printed once | Built |
| `capture install\|uninstall\|status\|pause\|resume\|off\|on`, `hook <agent> <event>`, `upload <path>`, `daemon`, `statusline` | Capture on this machine (F9) | Branch 14 |
| `search <words…> [filters] [--json]`, `search --status\|--rebuild` | Search what you may read (F10); see [below](#search) | Built |
| `redact test [<file> \| -] [--pack <file>]… [--config]` | Check rule packs' test strings, and show how often each rule fires on a transcript or text and where, never what matched ([below](#redaction-rules)) | Built |
| `redact backfill (--since <30d> \| --all) [--dry-run]` | Apply the server's current rules to stored sessions (F2.5, [below](#redaction-rules)). Exit 8 when a session changed while it ran | Built |

`serve`, `admin`, `workers`, `sync`, `reprocess`, `redact backfill` and `review` run where the
server's config and bucket keys are: they load the server config the way `serve` does
(`--config`, `SESHI_CONFIG`, `./seshi.toml`, `/etc/seshi/seshi.toml`, then `SESHI_*` env and
`--set`). `workers status` and `sync status|failed|dropped` also run from an admin's laptop through the server's admin routes:
with `--server <url>`, or, when no server config is found, the CLI config's `server` (its
`[local] config` is read as the server config instead). `sync run` and `reprocess` stay where
the config is.

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
its rule set recorded. An OTLP or poller session's span records (`spans/`) that an earlier
rule set redacted are redacted again in place, and the summary says how many. Redaction cannot
be undone; `--dry-run` writes nothing and lists what would change. It is safe to stop and run
again: sessions already redacted with the current rules are skipped. Restart the server with
the new packs first, or it keeps writing with the old rules. Exit 8 when a session changed while it ran (run it again).

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
  it first. `--visibility owner` makes everything the device token uploads private.
- **Without one** (X5.12): `--key -` reads the org key from stdin (on a terminal, plain
  `seshi login` asks for it without echo). The username stated with it is resolved on every
  call: `SESHI_USER`, then `user` in the CLI config (`--user` writes it), then `git config
  user.email`, then the OS user name. It must be printable ASCII.
- **A token** an admin issued (an admin or service token), or a static token: `--token -`.

Credentials go in the OS keychain through `Bun.secrets` (macOS Keychain, Windows Credential
Manager, libsecret), one entry per secret under the service `seshi`. Where there is no keychain
(a Linux machine without a secret service), they go to `credentials.json` next to the CLI
config, mode 0600, and login says so. `logins.json` in the same folder holds what is not secret:
the mode, who the server says you are, the IdP's token endpoint, expiry times, and this
machine's id (kept across logouts, so signing in again replaces this machine's device token
rather than adding one). Secrets are never passed in env.

`seshi logout` forgets the server's credentials (`--all`: every server's). It cannot revoke
anything on the server; it names the device token, which stays valid until it expires or an
admin runs `seshi tokens revoke <id>`. `seshi whoami` asks the server who the stored credential
is, so it also tells whether it still works.

## Search

```sh
seshi search flaky checkout test
seshi search '"git push --force"' --repo widget --since 7d
seshi search deploy -staging --owner alice@acme.com --sort recent --json
```

`seshi search` finds sessions by what was said and done in them: prompts, assistant text, and
tool calls (tool names and inputs, so file paths and commands). A record matches when all the
words appear in it, in any order (a prompt, an answer, one tool call: words spread over two
records of a session do not match); `"a phrase"` must appear as written; `word*` matches words starting with it; `a OR b`
matches either; `-word` (or `NOT word`) leaves out records with it. Case and accents are
ignored, and punctuation separates words, so `src/app.ts` finds those words in that order.

Each result is a session (agent and session id, owner, repository and branch, when it was last
active, how many records matched) followed by its best matching records with a short excerpt.
`seshi sessions show` (branch 13) opens one.

| Flag | |
|---|---|
| `--owner <id>` | Only this owner's sessions |
| `--agent <name>` | Only sessions of this format or agent (`claude-code`, `codex`, …) |
| `--repo <name>` | Only this repository: exactly, or its last path segments (`widget`, `acme/widget`) |
| `--branch <name>`, `--source <id>` | Only this branch; only sessions written through this source (`upload`, `datadog-prod`) |
| `--since`, `--until` | Only records in this time range: a date (`2026-11-01`), an RFC 3339 time, or an age (`7d`, `12h`) |
| `--sort relevance\|recent` | Best match first (the default), or most recently active first |
| `--limit <n>`, `--matches <n>`, `--cursor <c>` | Sessions per page (20, at most 100), records shown per session (3, at most 20), the next page |

Where it searches:

- **A server** (`server` in the CLI config, or `--server <url>`): through `GET /v1/search`, as
  the signed-in caller, so you find your own sessions and those visible to the org (admins and
  services find everything). Until `seshi login` (branch 13) stores a credential, pass it with
  `--token` (and `--user` with the org key).
- **In-process** (`[local] config` in the CLI config, `--config <seshi.toml>`, or where the
  server's own config is, as for `workers status`): the bucket's keys read everything, so
  nothing is filtered by owner. The local index is brought up to date with the change feed
  before each search, and built from scratch the first time (which reads every change entry
  once). `seshi search --status` says where the index file is and what it holds;
  `seshi search --rebuild` drops it and builds it again.

The output is plain text; `--json` prints the API's `SearchResults`. Exit 0 also when nothing
matches; 2 for a query with nothing to look for; 3 when nothing is configured or search is
turned off; 5 when not signed in or not allowed (the credential lacks the `search` scope); 7
when the server or bucket cannot answer, or the server's index is still being built.
