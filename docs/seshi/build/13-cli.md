# 13 · Session CLI and CLI colours (F8.1–F8.3, B1.4)

Branch `seshi-13-cli`, on `seshi-06-instance`. The CLI signs in to a server (the IdP's device
flow or the browser with PKCE, the org key, or a pasted token), keeps its credentials in the
OS keychain with a 0600 file as fallback, and reads, exports and deletes sessions and manages
tokens through `@seshi/client`, or in local mode through the Instance. Admins read the worker
and source status from a laptop. Colour is quiet, from the brand tokens, and never alone.
User docs: [docs/cli.md](../../cli.md) (conventions, commands, signing in), docs/server.md
(new routes), docs/config.md (what login writes).

## What was built

- **Brand colours (B1.1, B1.4).** `scripts/brand-tokens.ts` generates
  `apps/seshi/src/cli/brand-tokens.ts` from `brand/tokens.json`: each colour token with its hex,
  RGB, the nearest xterm 256-colour value (redmean distance over the cube and grey ramp,
  16–255; 0–15 are the theme's own) and a basic-sixteen stand-in (nearest in hue among the six
  chromatic colours, bright for a light token, near-greys by lightness). `bun run brand` writes
  it; `bun run check` runs `check:brand`, which fails when it is stale (also tested).
- **`cli/style.ts`** (imports only the generated tokens, so the status line may use it):
  - `colourLevel`: none off a terminal, with `NO_COLOR` (non-empty), `--no-color`, `--json` or
    `TERM=dumb`; truecolor for `COLORTERM=truecolor|24bit`; 256 when `TERM` says 256; else
    basic.
  - `detectTheme`: `SESHI_THEME`, the CLI config's `theme`, `COLORFGBG`, an OSC 11 query
    (`Terminal.background`, 100 ms), else dark.
  - `Style`: roles `success`/`brand` (mint; deep teal on light), `search`/`link` (lilac; the
    terminal's magenta on light), `warn`/`progress` (spark; the terminal's yellow on light),
    `error` (the terminal's red), plus `muted` (SGR dim) and `bold`. Only the foreground is set
    and reset (`39m`), never the background. `status(word, role)` always prints the word;
    `glyph(fancy, plain)`. `styleFor(ctx, {json, theme})` builds the one for a command's stdout
    and asks the terminal for its background only when colour is on and nothing else says.
- **Router (`main.ts`).** `--no-color` is taken out of argv (before a `--`) for every command,
  06's included, and passed as `ctx.noColor`. New optional `CommandContext` fields: `tty`
  (stdout/stdin terminals; this process's own unless the caller captures stdout), `noColor`,
  `terminal()` (lazy: `cli/terminal.ts`, loaded only when both are terminals) and `secrets`.
  `--help` names `--json` and `--no-color`.
- **`cli/terminal.ts`**: `ask` (with echo off for `hidden`, raw mode, Ctrl-C cancels),
  `background` (OSC 11, BEL or ST, 1–4 hex digits per channel, relative luminance), `openUrl`
  (`open`, `xdg-open`, `rundll32 url.dll,FileProtocolHandler`: never a shell).
- **`@seshi/client`** (05's and 06's gaps). The request code is one `send()`; `HttpSessionDB`
  gains `getSession/getTrace/tombstone(..., { owner })`, `setVisibility`, `owners`,
  `createToken`, `listTokens`, `revokeToken`, `revokeOwnerTokens`, `jobs`, `sources`, `source`,
  `records`; `authConfig(transport)` and `exchangeIdToken(transport, request)` need no token.
  Response types are in `client/src/types.ts`, written from openapi.yaml (the client may depend
  only on model).
- **API (06's gap)**: `GET /v1/admin/sources?days`, `/v1/admin/sources/{id}?days`,
  `/v1/admin/sources/{id}/{failed|dropped}?since&after&limit`, all `sources:admin`, 404
  `unknown_source`. openapi.yaml gains the paths and `SourceStatus`, `SourceRecord`,
  `RecordsPage`; the openapi test sees every documented status.
- **Credentials (`apps/seshi/src/account/`, exported as `seshi/account`)**:
  - `secrets.ts`: `SecretBackend`; `keychainSecrets()` (`Bun.secrets`, service `seshi`);
    `FileSecrets` (`credentials.json`, 0600, atomic temp-then-rename, removed when empty);
    `FallbackSecrets` (keychain first; a write the keychain refuses goes to the file and
    `fellBack` says why; reads look in both); `MemorySecrets` for tests.
  - `logins.ts`: `normalizeServer` (scheme, host, port, path; no query, user info or trailing
    slash); `Logins` keeps `logins.json` (0600, non-secret: mode, owner, role, scopes, the
    IdP's token endpoint, session and device token times, `stored_in`, and this machine's
    stable id) and one secret entry per kind (`org_key`, `token`, `session`, `refresh`,
    `device`) named `"<server> <kind>"`.
  - `oidc.ts`: discovery (issuer checked), `signInScopes` (the server's scopes plus
    `offline_access` when the IdP lists it), `deviceFlow` (RFC 8628: pending, `slow_down` +5 s,
    denied, expired; Google's `verification_url`), `browserFlow` (PKCE S256, state, nonce, a
    one-shot server on 127.0.0.1, a stray redirect ignored, 5-minute timeout),
    `refreshIdToken`, `peekClaims`.
  - `credential.ts` `credentialFor(options, server, purpose)`: org key with the username
    resolved now; a pasted token; with an IdP the session token for `read`, renewed (refresh
    token, then `/v1/auth/exchange` with the refreshed token's nonce) when it expires within a
    minute, or for `delete` when it is older than `delete_fresh_seconds` (from
    `/v1/auth/config`) less a minute; the device token for `upload`. `NotSignedIn` otherwise.
  - `user.ts` `resolveUser`: `SESHI_USER`, CLI `user`, `git config user.email` (2 s bound), OS
    user; refuses what is not printable ASCII (05's open item).
  - `cli-file.ts`: sets a top-level key in the CLI config, keeping the rest as written; the
    result is loaded before it is written.
  - `account.ts` `openAccount(ctx)`: the CLI config, its folder, `Logins`, the secret store.
- **`seshi login`**: `--server` (written to the CLI config), `--key <key>|-`, `--token
  <token>|-`, `--user` (written to the CLI config), `--browser|--device`, `--visibility`.
  Default: the IdP when the server has one (device flow, or the browser when the IdP has no
  device flow), else the org key (asked for without echo on a terminal). The exchange names
  this machine, so signing in again replaces its device token. Pasted credentials are checked
  with `/v1/me` first. Refuses local mode (exit 3).
- **`seshi logout`** (`--server`, `--all`): forgets the profile and every secret; names the
  device token that stays valid and the `tokens revoke` that ends it.
- **`seshi whoami`**: `/v1/me` with the stored credential (renewing it), or local mode's owner
  and bucket.
- **`backend.ts`** (F8.3): `Backend` with `ServerBackend` (HTTP client) and `LocalBackend`
  (Instance: the bucket's owner acts as admin; deletes and visibility changes are written as
  the local user; tokens issued by a `local` principal). `openBackend(ctx, account, {server,
  purpose})`: `--server`, else `[local]`, else `server`.
- **`seshi sessions`** `ls` (newest first within a page, `--all` pages through, a `--after`
  hint), `show` (`--trace`: a line per record), `export` (any render format, stdout or `-o`
  file or folder, named like the server's export), `rm` (`--yes`, or a terminal's yes; renews
  the session token first), `visibility org|owner`; `--owner` throughout.
- **`seshi tokens`** `ls` (`--owner`, `--kind`, `--all`; live/revoked/expired as words),
  `create <kind>` (`--expires 30d|date`, scopes checked, the token printed once), `revoke
  <id>`, `revoke --owner <id> [--kind]`.
- **Remote status** (06's gap): `workers status` and `sync status|failed|dropped` read the
  admin routes with `--server`, or with the CLI config's `server` when no server config is
  found (`commands/admin-target.ts`; `[local] config` is used as the server config). `sync run`
  stays local. Worker states and job outcomes are coloured with their words.
- **`cli/failures.ts`**: `classify`/`failWith` map the client commands' errors to the F8.1
  codes (not signed in, 401, 403 → 5; 404, 410 → 4; 400 → 2; unreachable, 5xx → 7; config → 3).

## Extension points

- **A client command**: `openAccount(ctx)`, `styleFor(ctx, { json, theme: account.cli.theme })`,
  `openBackend(ctx, account, { server, purpose })`, and `failWith(ctx, json, err)` in the catch.
  Throw `Refused(exit, code, message)` for a refusal with its own exit code.
- **Colour**: `Style` roles only; never a raw escape. Pad before painting. New roles go in
  `INKS` for both themes. A new colour comes from `brand/tokens.json` and `bun run brand`.
- **Someone else's text** (session content and fields, labels, records, IdP prompts): pass it
  through `printable()` from `cli/style.ts` before printing it in human output (12's search
  hits and snippets especially). JSON output needs nothing.
- **The uploader (14)**: `credentialFor({ logins, env, configuredUser }, server, "upload")`
  from `seshi/account` gives the device token, or the org key and the username to send; pass
  them to `HttpSessionDB` (or `connect({ token, user })`). `NotSignedIn` means "sign in" for the
  status line; a device token past `profile.device.expires_at` is refused before any request.
  `seshi/account` is in `apps/seshi` (layer 6): code in `ts/capture` (layer 5, X3.2) must not
  import it. `apps/seshi` calls `credentialFor` and hands the uploader the result, or a
  `() => Promise<Credential>` it calls before each batch (so a renewed device token is picked
  up); `check-layers` refuses the import otherwise.
- **Tests**: `tests/tooling/cli.ts`: `Machine` (a home folder, CLI config folder and
  `MemorySecrets`, `seshi(argv, { stdin, env, terminal, tty })`), `startServer({ settings, idp
  })`, `IdpServer` (a stand-in IdP on 127.0.0.1: discovery, device, authorize, token, refresh;
  `pendingPolls`, `device`, `claims`, `refreshTokens`), `fakeTerminal(answers)`. Never let a
  test reach `keychainSecrets()`: pass `secrets` to `main`.
- **`main(argv, { tty, terminal, secrets })`** for anything that drives commands.

## Deviations and why

1. **`sessions visibility`** is added to F8.1's `ls|show|export|rm`: X5.10 lets the owner or an
   admin change visibility, and the client's new `setVisibility` needs a CLI path.
2. **`login --token`** is added to F8.2: without an IdP, admins use admin tokens (X5.3) and
   `seshi tokens` needs one; services and static-token setups need a place for theirs too.
3. **One keychain entry per secret, plus a non-secret `logins.json`**, not one blob per server:
   Windows Credential Manager caps a credential at 2560 bytes, and an Entra refresh token next
   to a session JWT can pass that. A secret the keychain refuses goes to the file on its own.
4. **The org-key username is resolved on every use** (X5.7's order), not stored: so
   `SESHI_USER` applies at once, and the uploader (14) states the same name. `--user` at login
   writes the CLI config's `user`, which `SESHI_USER` still overrides.
5. **`offline_access`** is asked for when the IdP lists it, beyond the server's `openid email
   profile`: Okta and Entra give no refresh token without it, and F8.2 keeps one.
6. **A delete renews a session token older than the server's window less a minute** (rather
   than letting the server answer 403), so `sessions rm` works an hour into a session.
7. **New admin routes** (`/v1/admin/sources…`) back the remote `sync` commands; 06 noted there
   was no records route. `sync run` and `reprocess` stay local (X7.1: the worker polls).
8. **Basic-sixteen stand-ins are chosen by hue**, not RGB distance: the sixteen's real values
   are the user's theme's, so distance to any fixed palette says little, while "the cyan" or
   "the yellow" keeps its meaning under every theme. Light terminals in basic mode use deep
   teal's stand-in (cyan) for success.
9. **The router owns `--no-color`** for every command and adds four optional context fields;
   commands never see the flag.
10. **Local mode acts as admin**: `--owner` reads any folder, `rm` needs no fresh sign-in, and
    `tokens` work on the bucket's records (issued by a `local` principal). Local mode is one
    person who owns the bucket (X3.5).
11. **The device flow prints the URL and code and does not open a browser**, so it works over
    SSH; `--browser` opens one.
12. **`HttpSessionDB.source()` and `records()` are null only for 404 `unknown_source`**, so a
    server without the routes is an error, not "unknown source".
13. **A declined `rm` confirmation exits 1**; a server's 400 exits 2 (the command line asked for
    something the server reads as malformed).

## Review fixes

A review of this branch against F8, B1.4 and X5 changed:

- **Terminal control characters.** Human output printed stored text as it came: another
  member's transcript, a project or branch name, a token label or a failure message could carry
  escape sequences that move the cursor, hide lines, retitle the window or write the clipboard
  (OSC 52). `printable()` (in `cli/style.ts`) now replaces every C0, DEL and C1 character with
  U+FFFD in `sessions ls|show --trace`, `tokens ls`, `sync failed|dropped`, `workers status`'s
  last errors and the IdP's sign-in prompts. Tested with a hostile transcript.
- **`sessions rm` asks first, then renews.** It used to renew the session token for the delete
  before asking, so a declined delete still spent a refresh, and a slow answer could push the
  delete past the server's 10-minute window (X5.3). A declined delete now reports
  `cancelled` (also as JSON with `--json`) and calls nothing.
- **`login --visibility`** applies to the device token of an IdP sign-in only. It was silently
  ignored with `--key` or `--token`; it is now a usage error there.
- **`whoami`** showed the owner id (lowercased, or hashed) as the org-key username it states;
  it now shows the username actually sent.
- **Files it cannot read or write.** An export to a missing folder, or an unwritable CLI config,
  crashed with a stack trace; they now exit 1 with `io`. A `logins.json` or `credentials.json`
  that is not JSON is a config error (exit 3) naming the file and the fix.
- The cross-branch note for 14 now says `ts/capture` must not import `seshi/account`.

## Still to check

- The device flow and refresh against Okta, Entra and Google (05's X5.7 item): whether each
  returns a refresh token for these scopes, and an ID token on refresh (renewal needs one; with
  none the CLI asks for a sign-in after an hour). Only the stand-in IdP was used.
- `Bun.secrets` where there is no secret service (headless Linux, CI): the fallback relies on it
  throwing rather than hanging or prompting. Also in the compiled binary, and Windows Credential
  Manager's size limit with a real Entra refresh token.
- The OSC 11 query in real terminals and in tmux/screen: a terminal that never answers costs
  100 ms per coloured command unless `COLORFGBG` or `SESHI_THEME` is set, and an answer arriving
  after the timeout lands in the shell's input. Consider caching the answer per terminal.
- `credentials.json` permissions on Windows are not enforced (it is under the user's
  `%APPDATA%`).
- `sessions ls` costs one `/v1/me` for its heading when `--owner` is not given.
- CI has not run (no PR): `check:brand` is new in `bun run check`.

## Cross-branch wiring done after the rebase onto 12

Rebased onto `seshi-12-search` (07, 08, 09, 10, 11 and 12 below it). Shared lists were merged
as unions: the stub list in `commands.test.ts` (login, logout, whoami, sessions, tokens, search,
redact all gone), the openapi test's route list, `spec/openapi.yaml` (12's `/v1/search` and
07's, 08's and 09's paths, then this branch's `/v1/admin/sources…`; schemas appended),
`docs/server.md`'s route table and the root `check` line. `HttpSessionDB.redactionRules()` (07)
and `.search()` (12) are kept beside this branch's client calls, now using the module's
`refuse()`.

- **12 → 13, search through the account.** `Backend` gains `search(request, hooks)`:
  `ServerBackend` calls `HttpSessionDB.search` (`GET /v1/search`), `LocalBackend` catches the
  Instance's index up with the change feed and searches it as `LOCAL_VIEWER` (a turned-off
  index is `Refused` exit 3, `search_disabled`). `seshi search` now opens the account
  (`openAccount`), takes the server from `--server` or the CLI config and the credential
  `seshi login` stored (`openBackend`, so a session token is renewed like any other read);
  `--token` (with `--user`) overrides the stored credential for one search. `[local] config`
  goes through `LocalBackend` too. `--config` / `--set` and a server config found where `serve`
  looks still run in-process, and `--status` / `--rebuild` still need a local index. Errors
  the search command does not map itself go to `failWith`, so no stored credential is exit 5
  `not_signed_in`.
- **12 → 13, styled hits.** `styleFor(ctx, {json, theme})` styles the output: the session ref
  and the matched words (from `SearchMatch.highlights`, offsets taken before white space is
  folded, `highlighted()` in `commands/search.ts`) in `style.search`, the place, time, record
  labels and footer muted. Stored text (session ids, owners, projects, snippets, tool names)
  goes through `printable()`. `Style.plain()` is the default, so `searchLines` reads as before
  off a terminal, with `NO_COLOR`, `--no-color` or `--json`.
- **07 → 13.** `redact test` prints `Redacted: N rule(s) matched T time(s)` with "Redacted" in
  `style.status(…, "success")`, the passed/failed test counts in success/error, and failing
  rules with a `FAIL` word. It uses `styleFor(ctx, {json})`, so `--json`, `NO_COLOR` and
  `--no-color` stay plain; with `--print` the report goes to stderr and is plain.
- **08 → 13.** `HttpSessionDB.reviews(agent, id, {owner})` reads `GET …/reviews` (null for a
  session not stored; `ReviewDecision` in `@seshi/client`), and `Backend.reviews` reads it on a
  server or with `listReviews` in local mode. `sessions show` adds a `review` row with each
  stored write's decision (`#0 allow, #1 redact`, counts past eight writes) in success/warn
  colour; nothing when no policy covered a write. `--json` output is unchanged (the metadata,
  or `{metadata, trace}`); the decisions are on the reviews route.

Tests: `tests/cli/search.test.ts` (search with and without a login, `--token` over it, colour on
a terminal and none with `NO_COLOR` or `--json`), local-mode search and review rows in
`tests/cli/sessions.test.ts`, `highlighted()` offsets and hostile snippets in
`commands/search.test.ts`, the `Redacted` colour in `commands/redact.test.ts`, and the client's
`reviews()` in `client/src/routes.test.ts`.

## Cross-branch wiring still needed

- **14 (capture)**: the uploader takes its credential from `credentialFor(..., "upload")`,
  called in `apps/seshi` and injected into `ts/capture` (which may not import `seshi/account`,
  X3.2);
  the status line maps `NotSignedIn` to "sign in" (B1.6) and builds its colour with
  `colourLevel`/`new Style(level, theme)` (its stdout is not a terminal, so `styleFor` would
  turn colour off). F9.7's retraction needs `HttpSessionDB.tombstone` to send the retraction
  secret: extend the options object added here. 14 may add `CommandContext` fields next to
  `tty`, `noColor`, `terminal`, `secrets`.
- **15 (distribution)**: check `Bun.secrets` in the compiled binaries on macOS, Linux and
  Windows; `check:brand` joins `bun run check` in CI. Root `package.json`'s `check` line is
  edited here (`&& bun run check:brand`); keep every branch's additions.
- **Shared files touched**: `apps/seshi/package.json` exports `./main` and `./account`;
  `docs/cli.md` rows for login/sessions/tokens/workers/sync (other branches edit their own
  rows); `docs/server.md` route table (appended rows).
- **Optional, not done**: a remote `redact test` that checks a file against the server's packs
  through `HttpSessionDB.redactionRules()` (07); `sync status` showing an S3 source's manifest
  object count and `listed_at` (11). `sync failed` already prints 11's new failure codes
  (`unsupported_encoding`, `unreadable`) as they come.
