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
