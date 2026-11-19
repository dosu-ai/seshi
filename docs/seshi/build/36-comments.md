# 36 · Comment audit

Branch `seshi-36-comments`, on `seshi-35-test-audit`. A `/no-comments` pass over every source
file outside the tests: a comment stays only when it says something the code cannot, about
something we cannot change. Module essays, banners, spec-tag and roadmap narration, history,
and docs that repeat a name went. What stayed: vendor, platform and protocol behaviour (S3 and
R2 answers, Bun's `fetch`, SQLite FTS5, OTLP and protobuf wire rules, Datadog's API, RFC
references), and doc comments that define a package's public contract (what it throws, what
null or a default means, units, ordering).

It was done in three parts from b2ab2b1 (`seshi-36a-comments`: capture, the CLI, the agent
integrations; `seshi-36b-comments`: pipeline, store, api, auth, instance, search, sources,
Datadog; `seshi-36c-comments`: formats, redact, review, config, client, kit, model, scripts),
with no file in two parts, then cherry-picked onto 35.

## Checked

- **Comments only.** Each changed file was parsed with the TypeScript compiler and printed
  without comments, at b2ab2b1 and after; all 301 print the same (an empty `catch {}` block
  aside, which prints differently once its comment is gone). The two shell install scripts lost
  `#` lines only. No test file changed.
- `bun run check`, `typecheck`, `test` (2230 passed, 8 skipped), `test:laptop` (344) and
  `check:hook` pass.
- Two deleted comments were put back, as behaviour outside seshi: each secret is its own
  keychain entry because of keychains' size limits, and `seshi hook … -- <program>` exists
  because Codex runs only one `notify` program.
- Three deleted docs were wrong about the code: `credential_id` in `principal.ts` (said a hash,
  is `static-<owner>`), `defaultIndexPath` (the Windows path lacked `cache`), and
  `JobResult.error` (ignored unless `outcome` is `"error"`).

## Not done

The audit flagged about 150 places where a deleted comment was explaining code that should say
it itself: conditions to name (`isQuiet`, `isStub`, `startsNegation`), sentinels to type (`""`
for "no key", `"*"` for "no owner", `"rewritten"`, `"redacted"`), functions that pass results
out through outer variables (`ingest`'s `nextPointer` and `step`), empty `catch {}` blocks to
turn into `tryX` helpers that return undefined, and copies to share (`PAST_FOLDER` in three
files, the session-folder walker in `check.ts` and `sweep.ts`, `serviceEnvelopeIdentity`).
None of them is applied here: this branch changes comments only.

One flag was rejected: `require_user` and `require_reply` doing nothing is intended (the trace
format cannot hold such a session), and `seshi config check` warns when either is false.
