# 17: whole-stack review fixes

Findings from the review of the whole stack (`seshi-01` to `seshi-16`), each re-checked at the
tip of `seshi-17-review` before it was fixed. One line per finding: severity, what was wrong,
what changed.

## Fixes

- **ops, high** (reported critical): the image could not be built from source. `.dockerignore`
  leaves out `**/testdata`, but `@seshi/review`'s `eval.ts` imported
  `testdata/labelled/fixtures.json`, so `bun build --compile` in the Dockerfile failed, the CI
  `docker` job went red and `release` never ran. The eval set moved to
  `packages/ts/review/src/labelled-fixtures.json`, and `scripts/docker-context.test.ts` bundles
  `apps/seshi/src/main.ts` and fails if any workspace file it imports is docker-ignored.
- **ops, high**: darwin-x64 binaries carried an invalid signature. Bun (1.3.11 and the pinned
  1.4.2, on Linux or macOS) keeps its own Developer ID signature on the x64 build, so
  `codesign --verify` failed in `darwin-cross-check` and blocked every release.
  `scripts/release/build.ts` now re-signs both darwin binaries ad hoc with
  `scripts/release/macho-sign.ts`, which needs no `codesign` and grows `__LINKEDIT` when the
  reserved space is too small. Bun 1.4.2 output from a linux/amd64 container and
  `release:build` for both darwin targets pass `codesign --verify --strict` on a Mac and run.
- **ops, medium**: the test suite was flaky. The uploader sent sessions with the same
  `last_seen` in spool-read order, which a random file-name suffix decided (the "beats between
  sessions" test failed about one run in three); ties now break on the session key, with a
  test that spools them out of order. The smoke test's 1 s timeout also bounded `--version`
  and `admin init`, which could be killed under load; a separate `readyTimeout` now bounds
  only the wait for `/healthz`, and the test's stand-in takes 1.5 s over `--version`.
- **ops, medium**: following `.env.example` with compose stored sessions in the container's
  `/tmp`, lost on recreate. It now sets `SESHI_STORE__URL=file:///data` (the compose volume)
  and says to name a writable folder for `bun start`; a docs test checks the example's
  file:// store lies on a volume `compose.yaml` mounts.
- **ops, medium** (split vote, confirmed): `.env.example`'s `replace-with-…` static tokens
  passed the length check, so an unedited copy served alice and bob with credentials anyone can
  read in the repository. `authSettings` (serve, `config check`) now refuses a static token
  starting with `replace-with`; the example still loads as a config.
- **ops, low**: `irm … | iex` left `install.ps1`'s strict mode, `Stop` error preference,
  hidden progress, variables and functions in the user's session. Everything after the param
  block now runs in an `& { }` child scope; a static test checks it, and a pwsh test (where
  pwsh exists) runs it through `Invoke-Expression` and checks the session.
- **ops, low**: `docs/config.md`, the `serve.ts` header and `.env.example` said seshi reads
  `.env`, but the compiled binary is built not to. They now say only `bun start` from a
  checkout and compose's `env_file` supply `.env`.
- **ingest, high**: a write under a new rule set gave the whole session that `rule_set`, so a
  chunk landing between a rules change and `seshi redact backfill` made the backfill report the
  session `current` and leave the head stored under the old rules (secret included). Each
  `traces[]` entry now records the `rule_set` it was written under (schema, generated types,
  layout.md); backfill takes a session as current only when every trace is under the current
  rules, and stamps the traces it checks or rewrites. Test: head under the old rules, a chunk
  under the new, backfill rewrites it.
- **ingest, high**: a replace (an uploader's resend after a 409, every span-assembler rebuild)
  whose trace kept its content hash left the old object in place, because `ingest` published
  `immutable`. The hash leaves out an assistant record's text beside tool calls, the meta
  record and LLM calls, so what new rules (or review) took out there stayed stored, while the
  pointer recorded the new rule set and backfill then skipped it. A replace now publishes in
  `replace` mode (as backfill does), its trace entry is the new write's, and the rewrite gets a
  `published` entry with `replace: true`. Test: secret in an assistant record with tool calls,
  pre-redacted resend, 409, replace rewrites the object.
- **ingest, medium**: a replace that model review dropped moved the session's log state to the
  dropped history B while the head stayed on A, so B plus a follow-up (a later whole upload, a
  span-assembler rebuild, or the uploader's next chunk) was written as a continuation of A: two
  histories spliced. A dropped replace now keeps the stored log state and answers with it
  (F3.4's "move past it" only for envelopes that extend what is stored), so the next upload of
  B does not extend and must replace again. The uploader marks such a session `replace_next`
  and, once the transcript grows, sends it whole with `replace` instead of chunking at the
  server's offset. Tests: pipeline (drop, conflict, reviewed replace) and uploader.
- **ingest, low** (split vote, reported medium; the tombstone part confirmed): span records of
  a session the filter refused or review dropped could not be deleted, because `tombstone`
  returned for a session without metadata before `deleteSpans`. It now removes their span
  records and pending marker (answering `removed: n`, with no change entry since nothing was
  indexed). That such records stay until deleted is X6.3 and 09's open retention item, not
  changed here. Test: a filtered OTLP session's spans deleted.
- **auth, low** (split vote, confirmed): a static token's `credential_id` was `static-` plus
  16 hex of an unsalted sha256 of the token, and it is stored in every write's `writer` and
  returned to anyone who reads the owner's sessions or changes, so a person-chosen token could
  be checked offline against guesses. It is now `static-<owner>` (one static token per owner
  in `[auth.tokens]`), never derived from the secret; 05's note says so. Test: `authenticate`
  names the static token `static-dev` and the id carries no part of the token's hash.
- **auth, medium** (split vote, confirmed): anyone holding the org key could replace another
  member's `claimed` session by stating that member's username: `mayReplace` compared only
  the stated principal and source, so the rewrite was accepted and the session's earlier
  trace objects deleted, though X5.12 says the key "cannot delete or replace other people's
  sessions" (X5.3's reason, "anyone could claim to be the owner", applies to replace too).
  05's deviation 8 ("trust mode can't do better") predates F9.7's retraction secret, which is
  exactly the proof only the uploading machine holds. A `claimed` caller now replaces a
  `claimed` session only with that secret: `POST /v1/sessions` reads `X-Seshi-Retract` with
  `replace` (never stored), `IngestOptions.retractSecret` carries it to the pipeline, and
  `mayReplace` takes `retractProven` (checked against `metadata.retract_hash` in constant
  time). `HttpSessionDB.ingest` sends it as the header, and the uploader sends it with every
  replace. Admins and verified writers are unchanged; extending a claimed session still works
  as before. openapi.yaml, server.md, 05 and 14 say so. Tests: API (a second org-key caller
  stating `alice` gets 403 with no, a wrong or the hashed secret, the head stays; the
  uploading machine's secret gets 201; a session with no `retract_hash` cannot be replaced
  with the key), pipeline, `mayReplace`, client header, uploader.

- **dataflow, high**: sensitive-file globs, built-in and operator alike, compiled to
  backtracking JavaScript `RegExp`s (`(?:.*/)?` and `.*` pieces), outside F2.2's linear-time
  guarantee, and every path value and command word of every upload was tested against them. An
  operator's `**/deploy/**/*.secret` and a 14 KB path of repeated `deploy/` held the event loop
  for about 21 s; the built-in gcloud glob took 4.4 s on a 240 KB command. `sensitive.ts` now
  matches a glob by stepping a set of states along the path (Thompson's construction, with a
  literal-suffix check first): time proportional to path times glob, same matches. Tests: the
  matcher agrees with the old expression on a glob-by-path table, and the crafted paths (70 KB
  and 240 KB) finish well under 2 s.
- **dataflow, medium**: two built-in secret patterns backtracked quadratically on every string
  of every upload (server and client uploader): `sk-[A-Za-z0-9_-]*[A-Za-z0-9]{20,}\b` (`sk-`
  and 20,000 `a` then `_`: 0.5 s; also `sk-` repeated) and the URL-credential expression,
  rescanned from every `://` (120 KB of `a://:b`: 1.6 s; a minified bundle full of URLs, too).
  `providerRE` now only finds where an `sk-` starts and `skKeyEnd` finds its end in one pass
  per token run; `replaceConnUrls` finds the URL matches in code, each stretch scanned once.
  Same matches (a differential fuzz of 400,000 strings against the old code found no
  difference). Tests: those inputs and larger ones under 1 s together, and cases pinning where
  a key ends and where credentials split.
- **dataflow, medium**: client pre-redaction (`redactTranscript`) left every string under a
  structural key (`name`, `type`, `id`, `source`, …) alone at any depth, tool inputs included,
  and redacted an input's other values one by one; the server redacts a call's `args` as one
  JSON string. So a tool input's `name: AKIA…` and `password: "…"` (found only with its key)
  were sent to the server unredacted, against F2.4. A tool call's input (an object under
  `input`, `arguments`, `args`, `parameters`) is now serialized, redacted whole and read back,
  or, when a match spans the JSON so it no longer parses, redacted string by string with no key
  exempt. Tests: the client's input equals what the server stores for the same call (same
  counts), and the fallback.
- **dataflow, medium** (split vote, confirmed in part): a backfill stopped after the pointer
  moved (a crash, or a transient error from `appendChange` or a delete) leaves the old trace
  objects, holding what the new rules take out, and no later run deletes them (the session is
  `current`). The ordering is the recorded trade-off, but the comment's "harmless, the pointer
  no longer names them" was false: `GET …/trace?hash=`, `…/export?hash=` and
  `SessionDB.getTrace` served any object in the session's folder, and old hashes were handed out
  in earlier `published` entries. They now serve only a hash the session's `traces` name (404,
  or null, otherwise), which also covers objects a stopped replace leaves. openapi.yaml,
  server.md and 07 say so. Tests: a backfill whose delete fails, then `getTrace` of the old hash
  is null though the object is there; the API serves the head by hash and 404s an unnamed
  object on both routes. Deleting the leftovers was left for a decision (F2.5, decided in
  [18](18-decisions.md)) and is built in [23](23-orphan-sweep.md).

- **background, medium**: X7.1's "each job is also a one-shot command" did not hold for the
  span assembler, and docs/server.md offered cron `seshi sync run` in place of a worker. With
  `--roles api` plus cron, OTLP and Datadog spans were stored with their pending markers and
  no session was ever published. The assembler's pass is now `assembleOnce` (the job and
  `Instance.assemble` share it), and `seshi sync assemble [--json]` runs passes until nothing
  more is ready (exit 1 when a session could not be assembled; its marker stays). server.md,
  cli.md, datadog.md and otlp.md name it. Test: two span sessions stored as the api role
  stores them, `sync assemble` publishes the quiet one and leaves the fresh one waiting.
- **background, low**: the Datadog connector's `rewind` ignored the checkpoint and returned
  `{v: 1, until: since}`, so `seshi reprocess --since` later than the checkpoint skipped the
  unread spans between them for good, and a future date stalled the source behind `lag_ms` 0.
  `rewind` now keeps a checkpoint already at or before `since` (an unreadable one is still
  replaced), `reprocess` refuses a `--since` in the future and says when the checkpoint stays.
  datadog.md and 10 say so. Tests: connector (back, forward, future, first window, bad cursor)
  and the command (future refused, checkpoint kept).

- **client, high** (reported critical): turning a session off did not cover its subagents.
  Claude Code's SubagentStop captures `agent-<id>` with `parent_session_id`, and the hook, the
  sweep, the uploader's pass, due check and in-flight stop, and `capture off` all read only the
  subagent's own toggle, so after `/seshi capture off` its transcripts (the parent's task
  prompt, their tool output) were still uploaded, and those uploaded before were never
  retracted, against F9.5's "nothing more of this session is uploaded". `sessionToggle` now
  gives a session its own toggle, else its parent's (up the chain), and every one of those
  places uses it; `capture off|on --session` also marks (or calls off) the retraction of the
  session's subagents with no toggle of their own (`subsessionKeys`). capture.md says so.
  Tests: hook (both captures skipped, a subagent's own `on` wins), uploader (spooled and swept
  subagents sent nothing), end to end (two retracted, a later subagent and a grown one not
  sent).
- **client, medium**: a session turned off between the uploader's unlocked read and its first
  upload stayed stored for good: `capture off` saw `sent` unset, set no retraction and said
  "Nothing of it was uploaded", then the uploader set `sent` and ingested, against F9.7. The
  locked write that marks a session sent now checks its toggle (its parent's too) and a pending
  retraction, and sends nothing when it is off. Test: a toggle applied from inside `identify`
  (after the read) leaves nothing uploaded and nothing to retract.
- **client, medium** (reported high): hooks judged the payload's current cwd and recorded
  nothing when they skipped, while the uploader judged a known session by its stored cwd, so a
  repo's `capture = false` could be bypassed by moving between folders (started in excluded B
  then a hook in A sent the whole log, B's work included; started in A then working in B kept
  every new byte going) and the status line said ⏸ while the uploader sent, against F9.3's
  one decision and F9.5's "always wins". A hook skipped by a shared rule now spools a `seen`
  entry (no work, no uploader start), the uploader keeps every folder a session was seen in
  (`folders`), and `decide` takes them as `seen`: an org or repo rule excluding any of them
  excludes the session, in the hook, the uploader, the status line, `capture status` and
  `seshi upload`. Personal folder rules still go by the current folder. Tests: rules, hook (the
  `seen` entry, a known session that left B), uploader (both cases), end to end.
- **client, high** (fixed in part: the promise, not the behaviour): `seshi capture pause` said
  "nothing is captured until …" and capture.md said a pause "stops everything personal", but a
  pause is only a gate on the decision: the first upload after it sends everything written
  meanwhile, and a session run entirely during it is swept up after. The command now says
  "nothing is uploaded until …", that what sessions write meanwhile is uploaded when the pause
  ends, and that `capture off --session` keeps a session out; capture.md, cli.md and the rules
  header say the same. Test: the message, and a session written during a pause uploaded by the
  first hook after resume. Making a pause keep content out is under "Not fixed".
- **client, low**: `seshi capture status` printed an expired pause ("paused until <a past
  time>" beside "capturing") and kept it in `--json` as `paused`, since only `resume` clears
  the record. Both now show the pause only while `isPaused` holds. Test: a pause whose `until`
  has passed is absent from both; an open-ended one is shown.
- **client, medium**: `seshi capture uninstall` stopped at the first agent whose config it
  could not read (a malformed `~/.cursor/hooks.json`): the plain error went past `failWith`
  as a stack trace (no JSON under `--json`), exit 1, and the state was never updated, so the
  agents whose hooks were already removed stayed in `state.agents` and the uploader kept
  sweeping their folders. Each agent is now uninstalled in its own `try`, as `install` does:
  failures are reported (`failed` in JSON, "not removed" in text), the others leave the state,
  the failed one stays, exit 1. 14 says so. Test: Claude Code, Codex and Cursor installed, Cursor
  broken; uninstall removes two, reports one, no stack trace.
- **client, high**: `commandLine` left a word with backslashes unquoted, so the absolute
  Windows path `capture install` writes (the default `%LOCALAPPDATA%\Programs\seshi\seshi.exe`)
  reached sh as `C:Users…seshi.exe`. Claude Code runs hooks and its Bash tool through Git Bash
  on Windows, so the hooks, the status line and the `/seshi` skill's `capture off --session`
  failed, against F9.1/F8.4 ("hook commands work in sh, PowerShell and cmd") and F9.5. A
  Windows path (`C:\`, `\\server\`) is now written with forward slashes, which cmd, PowerShell
  and sh all take, and any other word with a backslash is double-quoted, backslashes before a
  quote doubled. 14's Windows item says so. Test: `/bin/sh` splits Windows paths (with and
  without spaces, UNC) and quoted words back into the same words.
- **client, low** (reported medium): Codex's `isSeshiNotify` knew seshi's notify only by a first
  word named `seshi`, so with `--command "npx seshi"` (or a wrapper) a second install chained
  seshi to itself (each turn ran the hook twice), `status` said not installed and `uninstall`
  removed nothing, against capture.md's "twice is once" and F9.6. It now finds
  `hook codex notify` after the command words, which must hold a `seshi` binary or be the
  command the install was given, and `chainedNotify` unwinds a chain that is seshi's own
  notify again (repairing what older installs left). Claude Code's and Cursor's `isSeshiHook`
  already took `npx seshi`; it now also takes the install's own command line, for a wrapper,
  and `capture uninstall` takes `--command` (cli.md). Tests: `npx seshi` and a wrapper installed
  twice are one entry and uninstall cleanly; a doubled chain is unwound; `notseshi` is not ours.
- **client, medium** (split vote; confirmed): with no id and no `SESHI_SESSION_ID` (always for
  Codex and Cursor, and for Claude Code without `CLAUDE_ENV_FILE`), `--session` took the session
  seen last under the folder, so with two agent sessions in one repo `capture off --session` from
  one turned off and retracted the other, and a Claude Code subagent (same folder, same moment
  as its parent on SubagentStop) could be picked over its parent. 14's deviation 2 documented
  the fallback, not the ambiguity. It now picks only when exactly one top-level session ran
  there in the past day, and otherwise refuses (usage, exit 2) listing agent, id and last seen;
  subagents are never candidates. capture.md and 14 say so. Test: two sessions refused and
  named, a subagent left out, `--agent` narrowing to one.
- **client, low** (reported medium): the `--service` entries carried no environment, so with
  `XDG_STATE_HOME` or `XDG_CONFIG_HOME` set in the shell the service used another capture
  folder (its own lock, an empty spool, no `state.agents`, so it silently did nothing) and
  another CLI config; with `CLAUDE_CONFIG_DIR` or `CODEX_HOME` set its sweep looked in the
  default agent folders (they are read through `claudeDir`/`codexDir`); and `SESHI_*` settings
  such as `SESHI_USER` never reached it (with an org key, sessions it uploaded claimed another
  username than the hooks' uploader). The launchd and systemd entries now carry those four
  path variables (EnvironmentVariables, `Environment=` with `%` doubled); a Task Scheduler task
  carries none, so on Windows a moved agent folder is named as a note; `SESHI_*` settings are
  never written into an entry file (readable, and the namespace holds server secrets too), so
  `install --service` names each one set as a note, to move into the CLI config. capture.md
  says so. Test: plist and unit carry the paths, leave out `SESHI_USER` and note it; Windows
  notes the agent folder and the setting.

- **coverage, high** (reported high, verifiers split high/medium): log adapters dropped token
  usage and the model of each turn, and with raw not stored (X6.3) that was lost for good
  (X6.2). `@letta-ai/trajectory` keeps neither, and `FormatAdapter` returned records only, so a
  Claude Code session from hooks, an upload or S3 stored its text and one model in the meta
  record. The contract now also takes `{ records, llm_calls }` (the registry, the pipeline's
  whole and chunk paths and `seshi normalize --json` carry the calls; `commit` redacts them).
  `lettaAdapter` takes a `calls` reader and names each call on the assistant and reasoning
  records written at that moment (`attachCalls`; an ambiguous moment names none). Claude Code
  reads `message.model`, `message.usage`, `stop_reason` and `requestId` per request (made-up
  `<synthetic>` replies are no call); Codex reads each `token_count`'s `last_token_usage` and
  the turn's model, a call named `call@<byte offset>` so whole and chunked logs agree (a chunk
  cut between a response and its count leaves the head's records without a call). The OTLP
  and Datadog exports read as a log keep their calls too (09 deviation 14). Goldens:
  `claude-usage`, `codex-usage`, with `<name>.llm_calls.json`, and `goldens.test.ts` now checks
  every transcript still normalizes to its golden. Tests: the pipeline stores both sessions'
  calls whole and in chunks; Codex chunk cuts.
- **coverage, medium** (the assembler half was already fixed above as "background"): X7.1's
  one-shot commands still left out the `retention` job, so a deployment of `--roles api` plus
  cron never pruned drop and failure records or source health shards. `Instance.prune()` runs
  the job once and `seshi sync prune [--json]` prints what it removed (exit 1 when the bucket
  failed). The search indexer needs none: it runs on every api instance. cli.md, server.md and
  06 say so. Test: old and new drop and failure records, `sync prune` removes the old ones.
- **coverage, low**: `seshi admin init --json` and `seshi healthcheck --json` failed with
  "Unknown option '--json'" (exit 2), against F8.1's "--json on every command", so a
  deployment script had to scrape the admin token and org key, printed once, from text. Both
  now take it: `admin init` prints `{admin: {id, owner, token}, org_key: {id, token},
  revoked}` (errors as the JSON error object, a second run `conflict`), `healthcheck` prints
  `{ok, url, version}` or the `unavailable` error. `serve` and `hook` stay without it (a
  running server; a hook prints nothing by design), as cli.md now says. Tests: both commands
  with `--json`, success and failure.
- **coverage, medium** (split vote; confirmed, though 09 recorded it as open): `seshi redact
  backfill` walked sessions through their metadata, so the span records of sessions never
  published (pending, refused by the filter, dropped by review) kept what a new rule takes
  out, while otlp.md and redaction.md said backfill redacts kept span records. After each
  owner's sessions, backfill now walks the owner's session folders for `spans/` with no
  `metadata.json` (stepping over each archive's spans) and redacts those records again in
  place, counted in `spans`. otlp.md, redaction.md and 09 say so. Test: span records of a
  pending archive beside a stored session and of an owner with only spans, dry run and run.
- **coverage, low** (fixed in part): B1.3 (Agreed) maps seshi's states to the six expressions
  and their words, but no branch owned it and only `redact test` used a word ("Redacted").
  The search empty state now says `Exploring: no sessions match.` and `seshi upload` says
  `Collected N sessions` and `All done: nothing to upload`, coloured as B1.4 says and with the
  word always printed. The build README gives B1.3 to 17, in part: the other commands' lines
  (capture status, sync status, pause) and B1.5's poses in docs empty states (the docs are
  Markdown pages with no empty states) are not applied. Tests: search's empty lines, upload's
  success line.
- **coverage, test only** (found while fixing): `uploader.test.ts`'s "seen in a repo that
  turns capture off" spooled two entries in one millisecond, which the spool orders by a
  random suffix, so it failed about one run in six. Its entries are now spooled a millisecond
  apart.
- **tests, medium**: no test covered redaction on the whole path that extends a stored session
  (offset 0, no replace: `seshi upload`, S3 sync re-reading a grown object, a whole resend);
  its tail pass could let records through unredacted with the suite green, since every
  extension test used chunk offsets. `tests/pipeline/session-redaction.test.ts` now re-uploads
  a grown log whole with a sensitive-file result and an AWS key and checks the head trace, the
  whole bucket, `withheld_calls` and that only the tail's matches are counted. Test only.
- **tests, medium**: no test covered redaction on the replace path; the replace tests sent
  clean text, so its own redaction pass could store a whole rewrite unredacted. The same file
  now replaces a session with a transcript holding both and checks the trace, the bucket and
  counts started over. Both tests fail under the mutants the review used. Test only.
- **tests, low**: CLI capture tests ran git for claims (and the org key's username) with the
  process's environment, not the command's, so they sent the developer's real `~/.gitconfig`
  identity and "nothing touches the real home folder" did not hold. `gitIdentityIn(env)` and
  `gitUserEmail(env)` lay the command's environment over the process's (`captureRuntime` and
  `resolveUser` pass it; in production that is the same environment), and the test `Machine`
  sets `GIT_CONFIG_GLOBAL` to its own home and `GIT_CONFIG_NOSYSTEM`. Tests: claims carry the
  machine home's identity; `resolveUser` reads the command home's `user.email`.
- **tests, low**: "rejects an oversized record set" read and parsed a golden file 50,001 times
  (8-35 s against the 30 s timeout under load); it now reads the record once (milliseconds).
- **tests** (re-checked, already fixed above): the "beats between sessions" flake and the smoke
  test's 1 s step timeout are the "ops, medium" flaky-suite entry; transcripts dropping token
  usage and the per-turn model, with no fixture to notice, is the "coverage, high" entry
  (`claude-usage` and `codex-usage` goldens).
- **docs, low**: `seshi.example.toml`'s Datadog source filtered on `ml_app = "trajectory"`,
  which matches none of Trajectory's spans (`coding-agents`, as docs/datadog.md and the
  fixtures say), so a copied block polled "successfully" and imported nothing. It now says
  `coding-agents`.
- **docs, low**: docs/config.md said `config check` exits 1 on an unusable config; it exits 3
  (`config`), as docs/cli.md's table says. The text says 3.
- **docs, low**: the CLI and the capture uploader sent `User-Agent: @dosu/sessiondb/<version>`
  (no call site set `userAgent`), so seshi traffic looked like the old SDK. They now send
  `seshi/<version>` (`apps/seshi/src/user-agent.ts`), and `@seshi/client`'s default is
  `@seshi/client/<version>` (docs/client.md). Tests: `seshi login` and `sessions ls` requests,
  and the uploader's upload and rules fetch, carry `seshi/<version>`. The normalizer name
  `@dosu/sessiondb` is unchanged (16's note: pinned in goldens, a decision).
- **docs, low**: spec/openapi.yaml's Agent enum said `atif` takes ATIF-v1.0 to v1.7; the server
  reads v1.8 (renders stay v1.7). It says v1.8.
- **docs, low**: spec/openapi.yaml's 413 for `POST /otlp/v1/traces` named
  `limits.max_upload_bytes`; the receiver refuses only past twice that plus 1 MiB (decoded), the
  bound `POST /v1/sessions` documents. It now says so.
- **docs, low**: docs/config.md still marked `server.public_url` *later* (sign-in), but sign-in
  is built and nothing reads the field (the CLI goes to the IdP itself, X5.7). `config check`
  and `serve` now warn that it has no effect, the schema and docs say it is accepted but
  unused, and the "*later*" note is gone (no field carries it). Test: `checkServerConfig`.
- **docs, low**: spec/schemas/metadata.schema.json and spec/layout.md still called
  `retract_hash` "reserved for F9.7", though retraction is built and checks it. They describe
  it as live; generated types regenerated.
- **docs, low**: SECURITY.md said only admin and fresh session tokens can delete; a static
  token from config deletes its own owner's sessions with no freshness rule. It says so.
- **docs, low**: spec/openapi.yaml was titled `sessiondb` and described "a sessiondb server".
  It names seshi; the legacy Letta render's `sessionstorage/trace/1` mentions stay.
- **cli, low** (found in the final check): `seshi <command> --help` answered
  `Unknown option '--help'` with exit 2 for every command but `config`, and `seshi --help`
  listed `sessions (ls|show|export|rm)` without `visibility` (16's note). `usageError` now
  prints the usage on stdout with exit 0 when the command line holds `--help` or `-h` (before
  a `--`), `serve` reports its parse errors through it, and the summary names `visibility`.
  Test: `main.test.ts` runs `--help` and `-h` on every command but `hook` and `statusline`.

## Final check

Run at `seshi-17-review` after the fixes above:

- `bun run check` and `bun run typecheck` pass; every generator (`schema`, `types`, `packs`,
  `brand`, `fixtures`, `goldens`) leaves the tree clean. `bun run test` passed in six of seven
  full runs. In the other, on a machine at a load average of about 10, `tests/api/app.test.ts`
  "refuses a chunk that does not start where the log ends" hit vitest's 30 s timeout (the
  file normally runs in 0.3 s). It did not come back in five more full runs or 25 runs of the
  file alone; a hang in the in-process app over `FsStore` is not ruled out. Left open.
- `bun run build`, then `bun run scripts/release/smoke.ts dist/seshi --keychain off` passes on
  macOS arm64, and `bun run check:hook` passes from source and against `dist/seshi` (about
  20 ms against the 250 ms budget).
- `docker build -f apps/seshi/Dockerfile .` builds, and the image runs `--version`.
- The stack is linear: `origin/seshi` ← 01 ← … ← 16 ← 17, no merge commits, and `main` is
  inside `seshi`. `bun run check` and `bun run typecheck` pass at every tip, and so does
  `bun run test` at every tip but 14 and 16, where the uploader's "beats between sessions"
  test failed once each: the spool-order flake fixed above (ties now break on the session
  key), which only 17 carries.

## Not fixed

- **ingest, low** (split vote, reported medium): reading or exporting a chunked session returns
  only its head trace. That is the documented contract (`GET …/trace` "the head by default",
  `sessions show --trace` "adds its head trace"), inherited from sessiondb main; the trace
  carries `continuation`. A joined export is a feature, not a defect against any decision.

- **ops, low** (split vote): F8.4's "Windows in the CI test matrix" is read as Windows
  binaries with a smoke test and `install.ps1` under both PowerShells (15-distribution
  deviation 14); `bun run test` runs on Linux only. Running the full suite on Windows needs
  either sign-off on the narrowed reading or work to make the suite pass there (shell-script
  fixtures, POSIX paths, file modes), which cannot be checked without a Windows host. Left for
  a decision.
- **background, low** (split vote, judged a documented deviation): an S3 chunk at a stale
  manifest offset writes an `offset_mismatch` failure record before the poller resends the
  object whole, and `workers status` / `sync status` then warn about it. 11's deviation 10
  records exactly this ("harmless beyond the record"); X6.4 writes a record for every
  permanent failure. The stale manifest is somewhat less rare than the deviation says (the
  checkpoint is saved every 25 objects and not after a transient error), but no data is lost
  or processed twice; not recording it would carve an exception into X6.4.

- **client, high** (the behaviour of the pause finding above): making a pause keep what is
  written during it out of the store. The decisions say only "seshi capture pause 2h for
  everything" (F9.5) and decide capture per session when it is judged (turning a session back
  on uploads all of it again, F9.7), so excluding a span of time is a semantics they do not
  settle: turn every session seen or started during the pause off (which, by F9.7, also
  retracts what a session uploaded before the pause), or skip the paused bytes (the server log
  is contiguous, and a whole resend after a 409, a moved transcript or a replace would send
  them anyway), or keep "defer". Left for that decision; the CLI and docs now describe what
  a pause does.
- **client, low** (split vote, judged the agreed behaviour): the uploader counts a pass whose
  uploads or retractions all failed (or wait in backoff) as idle, so after 5 minutes of an
  outage it exits with work queued, and the last turns or a pending retraction wait for the
  next hook on the machine. F9.1 agrees an uploader that "exits after a few idle minutes" with
  `capture install --service` as the opt-in for uploads between agent sessions, F9.7 says "if
  the uploader is not running, the retraction waits in the spool", and 14 records the idle stop
  and backoff; nothing is lost (offsets, the pending retraction and the secret stay in the
  state) and the status line keeps saying "N queued". Lingering while retries are pending needs
  a cap value and changes that choice. Left for a decision.

- **coverage, medium**: the Claude desktop mod (F9.4–F9.6: the Session Capture chip, its
  toggle and `/session-capture`, shipped in the plugin) is not built. It is a mod for the
  desktop app's own extension surface, which nothing here targets and no test here can run;
  too large for this review. The `/seshi` skill covers toggling one session meanwhile.
  Recorded in 14's "Still to check", capture.md's "Not yet" and the build README.
- **coverage, medium**: the first-run notice for Cursor and Codex (F9.4) is not built. Hooks
  print nothing by design, Codex's notify cannot show anything and Cursor's hooks can only
  steer the agent, so the notice needs a channel the decisions do not choose (a desktop
  notification, the first `seshi` command, the MDM rollout's message). Recorded in 14's "Still
  to check", capture.md's "Not yet" and the build README.
