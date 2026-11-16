# 35 · Test audit

Branch `seshi-35-test-audit`, on `seshi-34-scenario-proc` (b2ab2b1). An audit of every test in
the repository for tests that add nothing: ones whose behaviour another test already asserts,
ones that test a constant or a helper the behaviour tests run anyway, and ones that check how
code is called rather than what it does. The rule was to favour behaviour tests over
implementation tests: a removed test needed a named test, scenario or golden that fails when
the same behaviour breaks.

## How it was done

The repository was split three ways, each audited on a branch of its own from b2ab2b1:
`seshi-35a-audit-laptop` (capture, the CLI's doctor and account commands, the integrations),
`seshi-35b-audit-server` (pipeline, store, api, instance, search, sources, the server
integrations) and `seshi-35c-audit-core` (formats, the CLI's other commands, the remaining
packages). No file was touched by two branches. Each was cherry-picked onto 35 in turn.

Every removal names what covers it in its commit. The kinds removed:

1. **Constants and trivia.** A test that a format is named `anthropic`, that a default is 64
   MiB, that an empty bucket lists nothing. The config load tests and the behaviour tests that
   use the value already pin it.
2. **Duplicates.** A unit test that repeats, often word for word, a test one layer up: a
   `local-mode` refusal that `http-backend` asserts on the same backend, a `session.test` filter
   case that `pipeline.test` asserts with the same answer object, an ingest replace that
   `pipeline.test` asserts.
3. **Helpers the behaviour tests run.** A test of a private helper whose every branch the
   tests of its caller reach.
4. **Left to a scenario.** One test (`change-feed`: the entry left behind when the pointer write
   fails) is now covered only by scenario 07. It was proved by breaking the code: with
   `updateMetadataWithChange` writing the pointer before the entry, scenario 07, `publish.test`,
   the removed test and three kept change-feed tests all failed.

Four tests were rewritten instead of removed, to assert outcomes rather than calls: the
`normalize` adapter test (the adapter's output, redacted, not the fake's call log) and three in
the CLI's doctor and account tests.

Kept on purpose, though they overlap: every security test (auth, visibility, the body caps, the
retraction hash, `mayReplace`); every regression test that names the branch or scenario that
found its bug; the contract, layout and change-key tests; the format goldens; `check.test`; and
fakes that count calls where the count is the contract (the S3 token cache, the reviewer not
reviewing twice).

## Timing tests

The three ReDoS tests in `secrets.test.ts` had a fixed 1 s budget and failed under load (a
coverage run beside other work). They now time each input at `n` and `4n`, best of three after
a warm-up, and fail only when the ratio reaches 10: linear work is about 4, the backtracking
they guard against about 16. Under 50 ms at `4n` passes outright. The other timing tests
(`matcher.test` and `sensitive.test` at 2 s, `messages.test` at 500 ms) have not failed and were
left as they are.

## Result

| | Before | After |
|---|---|---|
| Tests (`bun run test`) | 2298 | 2238 (8 skipped in both) |
| Lines covered (istanbul) | 18298 / 19550 | 18298 / 19550 |
| Branches covered | 15754 / 18710 | 15753 / 18710 |

No source file lost a covered line. The one branch is the heartbeat job's "another worker"
path in `packages/ts/instance/src/builtin-jobs.ts`, which depends on timing: on unchanged
b2ab2b1 it is covered in some runs and not others.

`bun run check`, `typecheck`, `test`, `test:laptop` (344) and `scenarios:process` (9) pass.

## Still to check

- Generated scenario seed 33030 failed once during the audit, with ENOENT on an `FsStore`
  health-shard `.tmp` file while the machine was heavily loaded, and passed on rerun. It was not
  reproduced or explained.
