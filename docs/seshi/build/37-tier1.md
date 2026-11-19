# 37 · Code that says what the comments said (tier 1)

Branch `seshi-37-tier1`, on `seshi-36-comments`. Branch 36 deleted the comments that explained
our own code; its auditors flagged each place where the code should now say it itself. This
branch does the mechanical part of that ("tier 1"): renames, types for placeholder values,
small named extractions, `try…` helpers for empty `catch {}` blocks, and one copy where there
were several. The structural part, where a comment was holding up an invariant, is tier 2
(branch 38).

## Rules it was held to

No behaviour change, and nothing persisted or crossing a process boundary changes form: bucket
keys and JSON, `state.json`, spool files, S3 manifests and checkpoints, HTTP, config keys, env
vars, CLI flags and output, hook payloads, the desktop mod's state. A stored placeholder could
gain a TypeScript type, never a new value.

It was done in four parts from 93b82e3, each on its own branch (`seshi-37a-tier1` capture and
the agent integrations, `37b` the CLI app, `37c` pipeline and store, `37d` the server packages,
formats, redaction, Datadog and scripts), then cherry-picked here.

## What changed, by kind

- **Names for conditions**: `isSingleTraceSessionRoot`, `isQuiet`, `retractHashIfCreating`,
  `mayAddToSession` and `orgKeyMayReplace` (the org-key write rules, beside `mayReplace`),
  `rewrittenByBackfill`, `shouldRelocate`, `mustSendWhole`, `whyNotSessionTranscript`,
  `startsNegation`, `isFinalRefusal`, `isSecondWorker`, `turnedOnSince` (now shared by `decide`
  and the uploader's spool reader), and the doctor's `heldAsStub`, `awaitingWholeReplace`,
  `droppedPrefixUnderOldRules`.
- **Types for placeholder values**: `OrgKeyOwner = "*"`, `SessionFeed` (`read` or
  `unreadable`, was `null`), `AppendResult = Handled | "rewritten"`, `ObjectFailure` with
  `SESSION_REDACTED`, `HOLD_BEFORE_ANY_KEY`, `EtagChangingNonce` for the pending marker's `touch`,
  `RedactionPoint`, `ConfiguredUser` (the user and where it came from), `SparseIndex` for the
  tool-call index that guards against crafted indexes, `Submitter.submit` returning
  `SubmitOutcome`.
- **Names that said the wrong thing**: `readUntrustedRepoFile`, `uploaderLock`, `envFileWritten`,
  `NO_WORK_SUFFIX`, `orphanCandidates`, `recordsBeforeCut`, `hasBucketSafeSpanIds`,
  `gzipJsonDeterministic`, `resetAgeSoSweepSkips`, `trustCwdConfig`, `claimUnmarkedBucket`,
  `helpOrUsageError`, `writeCliKeyIfValid`, `unredactedRecordsUpTo`, `SecretlessStateEntry`,
  `sessionsAsLocalOwner`, `RecentlyStoredCache` (the token cache: writes move an entry to the
  front, reads do not, so it is not an LRU), `checkpointSeen`, `synthesizesMissingCall`.
- **Empty catches** became helpers named for what they tolerate (`tryParseJson`, `tryChmod`,
  `tryRestrictToOwner`, `tryDecodeJson`, `tryIsDirectory`, `tryNormalize`, …).
- **One copy**: `PAST_FOLDER` (was in three files), the session-folder walker shared by
  `checkStore` and the orphan sweep, `keyPastSpansOf` (the `/spans0` key trick, in ingest and
  backfill), the redaction structural keys (split into identity keys and entropy-exempt keys,
  one definition for records and native transcripts), `isOrgKeyCaller`.
- The redaction char-code predicates use named constants built from char literals; all seven
  were compared with the old ones on every code point and are identical.

## Not done, and why

- Spool entry kinds `seen` and `paused`: written to disk.
- `AssembleRun.retouched` and `dropped`: `seshi sync assemble --json` prints them.
- The rules-cache key from the config loader's settings list: the hook may not import the
  loader, and the list drops empty values, which would change the cached key.
- `InstanceError` matched by `instanceof`: moving it changes `@seshi/instance`'s exports.
- `serviceEnvelopeIdentity` shared with auth: the two copies differ (auth validates the source
  id with `@seshi/store`, which integrations may not import).
- The search indexer sharing model's record-to-event mapping: model does not expose it.

## Checked

`bun run check`, `typecheck`, `test` (2231 passed, 8 skipped), `test:laptop` (345),
`check:hook` (26.6 ms), `scenarios:process` (9), `claude plugin test` on the desktop mod (7),
and 2,000 generated scenarios from seed 1, all pass. Coverage: 18416 of 19681 lines (93.57%,
was 93.59%), 15772 of 18726 branches (84.22%, was 84.20%). The 13 more uncovered lines are the
`return undefined` in the new `try…` helpers, paths that held only a comment before. Every
string literal removed from source is either re-added elsewhere or merged into one shared copy.
