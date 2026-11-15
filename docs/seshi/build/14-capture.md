# 14 · Capture integrations and the status line (F9, B1.6)

Branch `seshi-14-capture`, on `seshi-13-cli`. Coding-agent sessions are captured as they
happen: `seshi hook` (called by Claude Code, Codex and Cursor) applies the capture rules and
spools; the uploader (`seshi daemon`, started on demand) sends what is new with the offset and
continuation protocol and sweeps the agents' folders; `seshi capture` installs the hooks and
turns capture off or on for everything, a folder or one session; a session turned off is
retracted with a per-session secret (F9.7); `seshi statusline` says `Session Capture ◉/⏸`.
User docs: [docs/capture.md](../../capture.md) (new), docs/cli.md (rows), docs/config.md
(capture rules), docs/server.md (retraction).

## What was built

- **The capture contract in `@seshi/kit`** (`src/capture.ts`, replacing the placeholder
  `HookHandler` and `Installer`, X3.11): `CaptureAgent { name, format, encoding, chunkable,
  hooks, sweep, identify, locate?, accountIds?, installer? }`; `HookHandler.parse(payload,
  host) → { captures: HookCapture[], exportEnv? }`; `SweepPath { root, resolve?, depths, match
  }`; `Installer { detect, install, uninstall, status }` over an `InstallContext` (host plus the
  seshi command words); `capturesOf(integrations)`. `Integration` gains `capture` and loses the
  unused `hooks`, `sweepPaths`, `installers` placeholders. `src/files.ts`: `readJsonConfig`,
  `writeJsonConfig`, `writeFileAtomic`, `commandLine`, `isSeshiHook`, `isSeshiStatusline` (how
  installers tell their own entries apart).
- **Integrations' capture modules**, each its own export (`@seshi/integration-<x>/capture`)
  importing only kit and `node:`, so a hook never loads a format adapter:
  - Claude Code (`integrations/claude-code/src/capture.ts`): SessionStart (exports
    `SESHI_SESSION_ID`/`SESHI_AGENT` through `CLAUDE_ENV_FILE`), Stop, SubagentStop (the
    subagent's own transcript as session `agent-<id>`, child of the main one, when the payload
    names it), PreCompact, SessionEnd (final). Sweep of `projects/*/<session>.jsonl` and
    `projects/*/<session>/subagents/agent-*.jsonl`, `CLAUDE_CONFIG_DIR` honoured; locate by id;
    account id from `~/.claude.json` (`{anthropic: accountUuid}` only). Installer merges hooks,
    `statusLine` (kept when someone else's) and the `/seshi` skill into `settings.json` and
    `skills/seshi/SKILL.md`. `plugin/` holds the same hooks and skill as a Claude Code plugin
    (tested to match).
  - Codex: `notify` (payload is the last argument); sweep of `sessions/yyyy/mm/dd/rollout-*`;
    `identify` from the rollout's own `session_meta` (a fork's parent too); locate by thread id;
    installer edits `config.toml`'s top-level `notify`, chaining a program that was there
    (`["seshi","hook","codex","notify","--",<old>…]`, restored on uninstall), checked by parsing
    the result back.
  - Cursor: `stop`, `sessionEnd` keyed by `conversation_id`, cwd from `workspace_roots[0]`,
    transcript found later when the first prompt's `transcript_path` is empty; installer merges
    `~/.cursor/hooks.json`.
  - Hook payload fixtures in each `testdata/hooks/`, hand-written from the documented shapes (a
    README says so).
- **`@seshi/capture`** (layer 5):
  - `paths.ts`: `~/.local/state/seshi` (`XDG_STATE_HOME`), `%LOCALAPPDATA%\seshi` on Windows;
    `state.json`, `spool/`, `uploader.json`, `rules.json`, `capture.log`.
  - `state.ts`: the one state file (F9.5): installed agents with their install time (the
    sweep's floor), the pause, every session (path, cwd, toggle, retraction, secret, upload
    position, last answer, errors, backoff), the uploader summary and problems. Written under a
    lock (`files.ts` `withLock`: exclusive lock file, stale takeover by rename) through a
    temporary file and rename, 0600. An unreadable file is `StateUnreadable` (fail closed:
    nothing captured), never silently replaced.
  - `spool.ts`: one JSON file per entry (`capture`, `retract`, `wake`), temp-then-rename; paths
    and ids only.
  - `rules.ts`: the one decision function (`decide`) for hooks, the sweep, the status line,
    `seshi upload` and the uploader (F9.3). Order: CLI config unreadable → off; folder unknown →
    off; org rule (`capture.remotes`) → off; repo `.seshi/config.toml` unreadable or
    `capture = false` → off; pause → off; session toggle; longest folder rule; global.
    `normalizeRemote`, `remoteMatches`, `within` (segment-wise, case-insensitive on Windows).
  - `place.ts`: the repo around a folder from the files alone (no `git` process): `.git` dir or
    worktree file + `commondir`, remotes, branch, `.seshi/config.toml` (`capture`,
    `visibility`; unknown keys ignored, wrong types make it unreadable). Each of these files is
    read through `files.ts` `readBounded` (lstat, open non-blocking, fstat the descriptor,
    regular files only, at most 64 KiB); anything else makes the repo config invalid (capture
    off in that repo only), never a hang or a throw. A repo config only
    narrows: the uploader sends its `visibility` when it is `owner` and ignores `org`, since a
    request's visibility beats the token's default.
  - `rules-cache.ts`: the CLI config's capture rules through the real loader, cached in
    `rules.json` keyed by the file's path, size, mtime and every `SESHI_*` setting variable
    (not capture's own `NOT_SETTINGS_ENV`; a bad one is a loader error, cached only for that env), so a hook skips the schema library (~20 ms) unless the config changed.
  - `hook.ts` `runHook`: handler → decision per session → spool; exported env appended
    shell-quoted.
  - `uploader-lock.ts`: one uploader per machine: pid, host and a heartbeat in `uploader.json`;
    a dead pid or a beat older than 2 minutes is taken over, and the old holder stops at its
    next beat.
  - `sink.ts`: `SessionSink { target, ingest, retract, ready }`, `httpSink` over
    `HttpSessionDB` (401 → `SignInNeeded`; 403 `bad_retract_secret`/`retract_disabled` →
    `RetractRefused`; 404 on retract → `absent`, 410 → `gone`).
  - `uploader.ts` `Uploader`: `pass()` takes in the spool (registering an agent as installed on
    its first hook), sweeps when due (15 min), retracts sessions turned off, uploads every due
    session, and writes the summary (queued, target, problems: sign in; upload failing after 3
    failing passes in a row). Protocol as F9.1 and 04's notes: whole log until stored;
    `filtered`/`dropped` hold until the transcript grows; complete lines only; chunks capped at
    8 MiB; `offset_mismatch` resends from `expected` (whole at 0, or when pre-redaction changed
    lengths); `conflict` on a whole log → `replace` only for a session this machine stored,
    sent with its secret in `X-Seshi-Retract` (the org key needs it to replace, 17);
    `forbidden`/422/4xx permanent until the file size changes; others back off (5 s doubling to
    5 min). Before every piece, whole or chunk, the agent must identify the file as that
    session's transcript (a hook payload names the path; a file it does not recognise is refused
    `not_a_transcript` and never sent), and a transcript at another path than the one the
    offsets were taken in (`sent_path`) goes whole again. The secret is saved before its hash is first sent. A retraction resets the session
    and bumps its generation, so turning it on uploads `<id>~<n>` from the start. `run()` loops
    every 2 s, beats the lock before every session of a pass, stops when idle 5 minutes (not
    with `keepAlive`) or when the lock is taken over (also mid-pass). A retraction that finds
    nothing (404) for a session this machine stored is `retract: "failed"`, never reported done.
    An idle pass writes nothing. `preRedact` is the F2.4 seam (identity by default; the app
    wires 07's rule packs into it), called inside the upload's `try`, so a rules fetch that
    needs a sign-in or fails for now is handled like the upload failing.
  - `status.ts`: the status line's words (at most two problems: config error, sign in, upload
    failing, retraction refused, N queued) and `sessionWord`.
  - `fast.ts` (`@seshi/capture/fast`): what hook and statusline load; no client, no zod.
- **Retraction on the server (F9.7)**: `POST /v1/sessions` takes `retract_hash` (64 hex,
  400 otherwise) → `SessionUpload.retract_hash` → envelope (`checkEnvelope` checks it) →
  `ingest` keeps the hash of the write that creates the pointer (`metadata.retract_hash`,
  reserved by 03); a later write never sets one, or an org-key holder could plant their own.
  `DELETE /v1/sessions/:agent/:id` with `X-Seshi-Retract: <secret>` needs only
  `sessions:write`, acts on the caller's own folder, checks `capture.allow_retract` (403
  `retract_disabled`), the hash in constant time (403 `bad_retract_secret`), 404 / 410
  `redacted`, then `tombstone(reason: "retracted", writer: caller)`.
  `HttpSessionDB.tombstone(…, { retractSecret })`, `RETRACT_HEADER`. openapi.yaml documents the
  header, the field, 403 codes and 410; the openapi test exercises them.
- **Config**: CLI `capture.remotes` (the org rule); `@seshi/config/paths` export (no zod);
  `NOT_SETTINGS_ENV` (`SESHI_CONFIG`, `SESHI_SESSION_ID`, `SESHI_AGENT`, `SESHI_NO_UPLOADER`)
  passed over by both loaders, since Claude Code sets the first two for every command it runs.
  `spec/cli-config.schema.json` regenerated.
- **Commands** (`apps/seshi`):
  - `hook <agent> <event> [-- <program>…]`: payload from the last argument or stdin (5 s
    bound, never read from a terminal); runs a chained program detached; always exit 0, nothing
    printed, errors to `capture.log`; starts the uploader when one is not running, unless
    `SESHI_NO_UPLOADER=1`.
  - `statusline [--agent] [--json]`: stdin `{session_id, cwd, workspace.current_dir}` (1 s
    bound), else the current folder; colour on unless `NO_COLOR`/`--no-color`
    (`colourLevel({tty: true})`, theme from `SESHI_THEME`, the cached CLI `theme`, `COLORFGBG`);
    ◉ in success, ⏸ muted, problems in warn/error/progress; always exit 0.
  - `daemon [--keep-alive] [--once] [--idle]`: one per machine (a second exits 0; with
    `--keep-alive` it waits for the lock, and waits again after a takeover); `--once`
    makes one pass and prints the summary (exit 5 when a sign-in is needed).
  - `capture install|uninstall|status|pause|resume|off|on` with `--session [id]`, `--agent`,
    `--path`, `--service`, `--command`. `off --session` writes the toggle, marks a retraction
    when something was sent, spools it and starts the uploader; `on` cancels a pending
    retraction. `install` and `uninstall` report an agent whose config they cannot read and do
    the others (exit 1; `uninstall` keeps that agent in the state). `--path` and global edit
    the CLI config in place (`capture-config.ts`), loaded before writing. `status` exits 8 when
    something needs action.
  - `upload <path>… | --since <d>` `[--agent]`: identifies each file's agent, applies the same
    decision, records the sessions (clearing old refusals), then runs passes itself, or waits
    up to 2 minutes for a running uploader.
  - `capture-agents.ts`: `CAPTURE_AGENTS`, the lazy registry (tested equal to
    `capturesOf(INTEGRATIONS)`); `capture-runtime.ts`: sinks (`serverSink` with
    `credentialFor(…, "upload")`, NotSignedIn → SignInNeeded; `localSink` over local mode's
    Instance, checking the hash before the same tombstone); `capture-service.ts`: launchd plist,
    systemd user unit, Task Scheduler task through an injectable `exec`; `cli/spawn.ts`:
    `selfCommand`, `hookCommand` (the compiled binary's absolute path, else `seshi`),
    `spawnDetached`.
  - `CommandContext` gains `spawn(words, {self})` and `exec(words)`; `main` passes them
    through, and a self spawn starts in the home folder.
- **Hook budget**: `scripts/check-hook.ts` now times a real hook (temporary home, a Stop
  payload, rules judged, spool written, no uploader), adds the three capture modules to its
  entries, and forbids `zod`, `@seshi/client`, `@seshi/formats` and `@letta-ai/trajectory` at
  start-up. Measured: 22 ms against 60 ms to load serve (budget 250 ms). The compiled-binary
  test now runs a real hook.
- **Tests** (no network, no real home, keychain or service manager; git reads the test
  machine's own config, since commands pass their environment to git): kit contract; each
  integration's payloads, transcripts and installer in temporary homes; capture's rules, place,
  state, spool, locks, cache, sink (a stand-in server on 127.0.0.1), sweep and the uploader
  against an in-memory protocol server; pipeline/API retraction; `tests/capture/` end to end
  against a served Instance with the org key (hook → spool → daemon → stored with its hash; the
  agent-only tail stored as a continuation; filtered sessions held; retraction with the change
  feed's `retracted`; `allow_retract = false`; the status line; rules from the CLI; install,
  status, uninstall, service; `upload`; local mode) and real `bun main.ts hook` processes.

## Extension points

- **A new agent**: in its integration, a `src/capture.ts` exporting a `CaptureAgent` (import
  only `@seshi/kit` and `node:`), listed as the integration's `capture` and as a `./capture`
  export; then one line in `apps/seshi/src/capture-agents.ts` and its path in
  `scripts/check-hook.ts` `HOOK_ENTRIES`. Installers use kit's `readJsonConfig`,
  `writeJsonConfig`, `writeFileAtomic`, `isSeshiHook`.
- **Pre-redaction**: `preRedactor(account, {cacheFile, log})` in
  `apps/seshi/src/capture-runtime.ts` (07's rule packs, see the wiring below). The uploader calls
  `redact({agent, encoding, text, carried})` per piece and stores the returned `carried` per
  session; it must be deterministic and line-preserving. A test or embedder can pass its own
  `preRedact` in the uploader options.
- **Another sink**: implement `SessionSink`; `captureRuntime(ctx, options)` takes uploader
  options for tests and embedders.
- **More status-line problems**: add them in `status.ts` `statusLine` (keep at most two).
- **The desktop mod (F9.4)**: read `state.json` and call the same `decide`; toggling writes the
  session entry exactly as `seshi capture off|on --session` does (`toggle`, `retract:
  "pending"` when `sent`) plus a `retract` spool entry.

## Deviations and why

1. **A retracted session comes back as `<id>~<n>`.** The pipeline refuses any later ingest of a
   tombstoned archive id ("stays gone", 03/04), and F9.7 says turning it back on uploads it "as
   a new session". A new session id is the smallest change that keeps tombstones final;
   `native_session_id` therefore also carries the suffix.
2. **Claude Code's SessionStart is hooked**, beyond F9.2's list, to export `SESHI_SESSION_ID`
   through `CLAUDE_ENV_FILE`: the answer to F9.5's open "how the skill gets the session id".
   Without it, `--session` alone falls back to the one session seen in the current folder in the
   past day (17: more than one is refused with a list, never guessed; subagents never count).
3. **`capture.remotes`** is the org rule F9.5 gives as an example, as a CLI config field (one
   new field); "delivered with the CLI config" is left to managed config. It matches remotes as
   `host/path` patterns.
4. **Repo config is lenient on unknown keys, strict on types**: other branches or tools may add
   keys; a wrong type makes it unreadable, which turns capture off there (fail closed).
5. **The hook reads the CLI config through a cache**, not the loader every time: loading the
   schema library cost ~20 ms, which would break 06's "under half of serve" check. The cache is
   keyed so any edit or env change reloads.
6. **`SESHI_SESSION_ID`, `SESHI_AGENT`, `SESHI_NO_UPLOADER` are not settings**: the strict
   loaders would otherwise refuse every command run inside Claude Code (F1.4's "unknown keys
   fail"). Added to the loaders' ignore list beside `SESHI_CONFIG`.
7. **Rule changes do not retract.** Only a session toggle retracts (F9.5 "turning off
   mid-session"); a new folder rule or repo `capture = false` stops further uploads but leaves
   what was stored, so an edit cannot mass-delete.
8. **Cursor sessions are swept only after a hook saw them**: its transcripts do not say where
   they ran, and the rules need the folder.
9. **Retraction ignores `?owner`** and works on the caller's own folder: the secret proves the
   machine, the credential the owner. An org-key machine retracts under the username it states;
   old owner ids `[auth.owner_aliases]` folds into the caller's are searched too.
10. **Permanent refusals wait for the transcript to change**, and only transient failures count
    toward "upload failing": a single unsupported session should not light the status line for
    good. `seshi capture status` and `seshi upload` show refusals.
11. **The plugin cannot set the status line** (Claude Code plugins have no `statusLine`), so the
    plugin README says to set it in (managed) settings; `seshi capture install` sets it.
12. **Service activation runs the OS's own commands** (`launchctl`, `systemctl --user`,
    `schtasks`) and reports a failure instead of failing silently; uninstall removes the entry.
13. **Spool entries are files, not lines** in one file, so no two writers share a file and the
    uploader never reads half an entry (portable to Windows, no append races).

## Review fixes

A review of this branch against F9/B1.6 fixed, each with a test:

- **A hook payload could get an arbitrary file's tail sent.** `identify` ran only before a whole
  upload; a later payload naming another (longer) file for a stored session had the bytes past
  the stored offset sent as a chunk. Every piece is identified now, and a moved transcript goes
  whole.
- **A retraction that found nothing was reported done.** The server looked only in the caller's
  own folder, so a session uploaded under an owner id that `[auth.owner_aliases]` folds into the
  caller's (an org-key username before an IdP sign-in) answered 404, and the uploader marked it
  retracted. The route now searches the aliased folders (never another owner's), and a 404 for a
  session this machine stored is a refused retraction; 410 (already removed) is done.
- **A toggle set before any hook named the transcript was forgotten after a day** (hooks skip a
  session turned off, so none recorded its path), and the next hook or sweep captured it.
  `capture off|on --session` and the sweep now `locate` the transcript.
- **One shell's bad `SESHI_` variable turned capture off everywhere**: the rules cache stored the
  loader's error under a key without that variable.
- **The service entry exited when a hook-started uploader held the lock**; launchd restarted it
  every few seconds and systemd (`Restart=on-failure`) never did. `--keep-alive` waits now.
- **A long pass did not beat**, so a hook started a second uploader after two minutes; the pass
  beats per session and stops when taken over. `seshi upload` beats between passes. The poll's
  abort listener no longer accumulates in a process that never stops.

## Still to check

- **The Claude desktop mod (F9.4, F9.5, F9.6)** is built in [25](25-desktop-mod.md).
- **The first-run notice for Cursor and Codex (F9.4) is not built.** Only `seshi capture
  status` is. A hook prints nothing by design (speed, and an agent may treat output as
  input); Codex's `notify` has no way to show anything, and Cursor's hooks can only answer a
  prompt or add a follow-up message the agent would act on. A notice therefore needs another
  channel (a desktop notification on the first hook, the first `seshi` command after
  install, or the MDM rollout's own message), which the decisions do not choose. Left for that
  decision (17-review "Not fixed").
- Real agents: Claude Code's `agent_id`/`agent_transcript_path` on SubagentStop and
  `CLAUDE_ENV_FILE` on SessionStart; Cursor's payload fields and transcript location/format on
  current versions; Codex's notify argument and rollout layout. All were written from documented
  shapes; none was run against a live agent here.
- Windows: hook commands in PowerShell/cmd for program paths with spaces (`commandLine` writes
  Windows paths with forward slashes, so the default `%LOCALAPPDATA%\Programs\seshi` needs no
  quotes and sh (Git Bash) splits it right, which a test checks with `/bin/sh`; a path with a
  space is still double-quoted, and PowerShell needs `&` before a quoted program),
  `process.kill(pid, 0)` liveness, Task Scheduler flags, `%LOCALAPPDATA%` permissions (0600 is
  not enforced on Windows).
- launchd and systemd entries were checked only as files and recorded commands; not loaded on a
  real machine.
- PID reuse is covered by the heartbeat, but two uploaders can overlap for up to one beat after
  a takeover; uploads are idempotent and the state is locked, so the overlap is wasteful, not
  harmful.
- `state.json` grows with every session whose transcript still exists (Codex keeps rollouts
  forever). It is read whole by every status-line refresh; revisit (split toggles from upload
  positions, or prune by age) if it gets large.
- A transcript whose last line is never terminated is never sent past its last newline.
- The `/seshi` skill's wording and how reliably Claude Code runs it.
- Pre-redaction's cost on a very large whole log (every line is parsed and redacted in the
  uploader) was not measured. A client whose rule set differs from the server's (`same:
  false`, for example a newer server's built-in rule) only logs it; the server redacts again.

## Cross-branch wiring once the stack is linear

- **07 (redaction rules), done after the rebase**: `preRedactor(account)` in
  `apps/seshi/src/capture-runtime.ts` fetches the rules once per uploader run, on the first
  piece, with the upload credential (`HttpSessionDB.redactionRulesSince(etag)`, new: it sends
  If-None-Match and answers `null` on 304), builds them with `ruleSetFromDocument`, and calls
  `redactTranscript(rules, text, encoding, carried)` per piece, returning `{text, carried:
  withheld}` (no `carried` when nothing is withheld). The document and its ETag are kept in
  the capture folder (`redaction-rules.json`, `CapturePaths.redactionRules`), so an unchanged
  rule set costs a 304. A 404 (a server from before the route) or a document this client
  cannot use leaves the built-in pack; a server that cannot serve the rules leaves the
  document kept from before, and with none the piece waits (transient, backed off); 401 is
  "sign in". Local mode does nothing here: its Instance redacts before it writes. The uploader
  now calls `preRedact` inside the upload's `try`. `@seshi/redact` and the client are imported
  there only, with `import()`; `check-hook` now forbids `@seshi/redact` and `re2js`. Offsets:
  the uploader already kept the file offset and the server's (redacted-byte) offset apart and
  sends complete lines only. Tests: `tests/capture/capture.test.ts` "pre-redaction before
  upload (F2.4)" runs hooks and `seshi daemon --once` against a served Instance with an org
  pack, and checks the request bodies (nothing secret sent, a withheld `.env` result in the
  next chunk), the 200 then 304 fetch, the server's counts, the 404 and 503 fallbacks, and
  local mode. The 409 `conflict` after a rules change or backfill was already handled
  (`replace` when this machine stored the session).
- **12 (search), done after the rebase**: the stub list in `commands.test.ts` is gone with its
  last entries (07 built `redact`, 12 `search`), and so is `apps/seshi/src/cli/stub.ts`; exit 9
  stays reserved. `scripts/build-binary.test.ts` no longer runs `search` as a stub.
- **15 (distribution)**: run `check:hook` against `dist/seshi` in CI (the timed hook now uses a
  temporary home and a payload); verify the compiled binary's hook on Windows and the service
  entries on each OS; the npm-installed binary's `execPath` is what `capture install` writes
  into agents' configs, so a reinstall to another path needs `seshi capture install` again.
  Publish the Claude Code plugin (`integrations/claude-code/plugin/`) if a marketplace is used.
- **16 (README)**: link docs/capture.md; the status line strings are fixed by B1.6.
- **Shared files touched**: `packages/ts/kit/src/index.ts` (capture contract re-exports;
  `Integration.capture`), `apps/seshi/src/commands/index.ts` (`spawn`, `exec` on
  `CommandContext`), `apps/seshi/src/main.ts`, `apps/seshi/package.json` and root
  `package.json` (`@seshi/capture`), `packages/ts/config` (`cli.ts` field, `paths.ts`,
  `configs.ts`, `./paths` export), `spec/openapi.yaml`, `tests/tooling/cli.ts` (Machine records
  `spawned`, `executed`), `scripts/check-hook.ts`, docs/cli.md rows, docs/config.md,
  docs/server.md.
