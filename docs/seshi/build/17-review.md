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
  object on both routes. Deleting the leftovers is in the list below.

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

## Not fixed

- **ingest, medium** (split vote, judged a documented deviation): a change entry is lost when
  the write fails after the pointer update (a resend is answered from `applied`; backfill's
  next run says `current`). spec/layout.md (publish steps 3-5) records exactly this, 04 lists
  it, and 12's indexer is built for it (each entry makes it read current metadata, so a
  session is right again at its next entry; search verifies hits against live metadata).
  Moving the entry before the pointer, or appending a missing entry on replay, is a change to
  the publish protocol, left for a decision. Only backfill's comment, which claimed the order
  prevents it, was corrected.
- **ingest, low** (split vote, reported medium): reading or exporting a chunked session returns
  only its head trace. That is the documented contract (`GET …/trace` "the head by default",
  `sessions show --trace` "adds its head trace"), inherited from sessiondb main; the trace
  carries `continuation`. A joined export is a feature, not a defect against any decision.
- **ingest, low** (split vote): tombstone and visibility change entries of one owner collide
  within a millisecond (keys have no archive id). Confirmed, but search checks every hit
  against live metadata (deleted or private sessions are never returned), layout.md documents
  the collision and 05's "Still to check" names the fix, which changes the change-key layout
  every feed reader parses. Left for that layout decision.

- **ops, low** (split vote): F8.4's "Windows in the CI test matrix" is read as Windows
  binaries with a smoke test and `install.ps1` under both PowerShells (15-distribution
  deviation 14); `bun run test` runs on Linux only. Running the full suite on Windows needs
  either sign-off on the narrowed reading or work to make the suite pass there (shell-script
  fixtures, POSIX paths, file modes), which cannot be checked without a Windows host. Left for
  a decision.
- **dataflow, medium** (split vote, confirmed): deleting the trace objects a stopped backfill
  (or replace) leaves behind. Since this review no reader is served them (above), but they stay
  in the bucket against F2.5's "deleted, not kept". A sweep of objects the metadata does not
  name races a concurrent publish (its object is written before the pointer names it), so it
  needs an age guard from the store's listing or a recorded list of pending deletions written
  before the pointer moves (a metadata schema change). Left for that decision.
- **dataflow, medium** (split vote, judged a documented deviation): a model-review drop of a
  session's first envelope stores nothing, so the uploader resends the whole log as it grows;
  each resend goes to the provider again and is reviewed whole, and a later `allow` or
  `redact` stores the text the first review dropped. 04's deviation 9 and 08's open items
  record this. F3.4 says the offset moves past a dropped envelope, but F3.1 says a drop writes
  nothing; moving past it needs session state for a session with no trace (which would also
  record that the dropped session exists), a choice between the two the decisions do not make.
  Left for that decision.
- **background, medium** (split vote, confirmed, not fixed): span records keep every chat
  span's whole input history and the assembler loads all of a session's records on each
  publish, so storage and worker memory grow with the square of the calls (400 calls: 341 MB
  of records, 355 MB of heap, for a 1.7 MB session), with no bound before the load. F4.4 and
  X6.3 store each span normalized on arrival and rebuild the whole trace each time; storing
  history once changes that model, and a per-session cap needs a value and refuses long
  sessions. 09's "Cost at scale" item holds it, with the measurement.
- **background, medium** (split vote, confirmed, not fixed): `/otlp/v1/traces` takes the
  upload's body cap, about 513 MiB raw and again after gunzip, and decodes it synchronously
  at about 47x the wire size, so a holder of an otlp source's token can stall or exhaust an
  API instance. 09 records the cap as open. An OTLP cap (raw, inflated, span count) needs a
  value and likely a `[limits]` key; Console batches of full-content spans (0.75 MB each) are
  unmeasured, so a small cap could refuse real exports. Left for that decision.
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
