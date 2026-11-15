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

## Not fixed

- **ops, low** (split vote): F8.4's "Windows in the CI test matrix" is read as Windows
  binaries with a smoke test and `install.ps1` under both PowerShells (15-distribution
  deviation 14); `bun run test` runs on Linux only. Running the full suite on Windows needs
  either sign-off on the narrowed reading or work to make the suite pass there (shell-script
  fixtures, POSIX paths, file modes), which cannot be checked without a Windows host. Left for
  a decision.
