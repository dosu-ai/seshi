# 38 · Invariants the comments held up (tier 2)

Branch `seshi-38-tier2`, on `seshi-37-tier1`. Branch 36 deleted comments; 37 renamed and typed so
the code says what they said. This branch is the structural part: places where a deleted comment
was holding up an **invariant** the code relies on for correctness. Each one is now enforced by
the code's shape, or pinned by a test, and each change was proved by breaking the invariant on
purpose and recording what failed (in the commit body), then restoring it.

It was done in three parts from 0b80cec (`seshi-38a-tier2` capture, `38b` the write path, `38c`
search, the CLI app, Datadog and redaction), then cherry-picked here. Observable behaviour,
stored formats and write and delete order are unchanged, with the three lock differences noted
below.

## Capture

- **`decide` is an ordered list** of named levels (`unreadableConfig`, `unknownFolder`,
  `sharedRulesHere`, `sharedRulesSeen`, `sessionOff`, `frozenByPause`, `pausedNow`,
  `startedInPause`, `sessionToggle`, `folderLevel`, then `globalLevel`); the first with an
  opinion decides. Only 2 of the 10 adjacent pairs had a test; now each has one, and swapping any
  pair fails it.
- **One local lock.** `LocalLock` (exclusive create holding a token, stale clearing by rename
  aside, release only while holding the token) is used by `withLock` and by the uploader lock,
  whose branch-34 takeover guard is now a `LocalLock` under which the lock is judged again before
  it is replaced. File names and contents on disk are unchanged. Off the normal path it differs
  in three ways, each safer: a dead taker's stale guard is cleared by rename aside (as `withLock`
  always did) rather than removed directly; a taker releases the guard only while it holds it;
  a lock file whose token write fails is removed rather than left empty. Re-introducing the
  branch-34 race fails `state.test` every time and process scenario 07 about 3 runs in 10.
- **The uploader's `sync` is one handler per server answer.** `prepare` makes the saves that must
  precede a send (the not-a-transcript refusal, the secret and `sent`), `send` pre-redacts, saves
  the misaligned mark if a piece changed length and calls ingest, and `onAccepted`,
  `onOffsetMismatch`, `onConflictReplaceOwn`, `onTransient` and `onRefused` each return the saves
  to make after the answer. No save moved relative to a network call. Each save was broken in
  turn and each failure named; two saves had no test and now do.
- **`pass` is four named steps** (`retractPending`, `uploadPending`, `clearSignInWhenReady`,
  `checkStale`), in the old order; three of the four orders had no test and now do.

## Write path

- **Store orderings are pinned by tests**: `messages/` sorts after every span id (lowest,
  highest, every leading hex digit, with a two-key page size); `since` includes an entry stamped
  exactly then and not one a millisecond earlier, in records and the change feed; `messageOf`'s
  hash ignores the timestamp and is pinned byte for byte; a `deleteSpans` that fails between
  records and messages leaves nothing a reader or `checkStore` treats as live, and the reverse
  order would.
- **`ingest` and tombstone steps return values.** `updateMetadataWithChange` returns the result
  of the attempt that stood and every attempt's result. Ingest reads the one that stood; tombstone
  deletes the traces every attempt read, as before (only the last attempt's brings back the bug
  generated seed 10852 found in 33). New tests race a replace and a tombstone against another
  writer.
- **Change entry, then pointer, without `ChangeFirst`**: a typed pass result and a loop in place
  of an exception. Writing the pointer first fails `publish.test`, nine scenarios and seven
  `found/` files.
- **One "young enough to keep" rule** for the sweep's listing and its re-check before a delete,
  and `makeYoungEnoughToKeep` (was `resetAgeSoSweepSkips`); `sweepSession` is named steps. A new
  test has the pointer name an old object right after the sweep's first read.
- **One place that splits a whole log where its kept part starts** (`keptPartFrom`, used by the
  extend path and `pastDropped`), with the three fallbacks for finding where the dropped start
  ends kept, in order, each now caught by exactly one test: the hash match (rules and adapter
  unchanged), the byte cut (a jsonl log after a rules or adapter change), the record count (an
  assembled session or a JSON document); and a stub without `dropped_prefix`, which only stubs
  written between branches 20 and 21 have. The "dropped" answer for an empty kept part and
  `commit`'s dropped-replace branch stay separate: merging them would change what is written.
- **Backfill's second read of span records** is named (`namedByNoRecordNow`); without it the race
  test from 22 fails.

## Elsewhere

- **Search**: the read stamp and the metadata read are one call (`stampedMetadata`), so the stamp
  cannot come after the read. A new test, where a slow indexer stalls while a fast one indexes
  an append, fails with them swapped.
- **Deleting a session** needs a `DeleteConfirmation` that only `confirmDelete` makes:
  `openBackend(…, { purpose: "delete" })` without one does not type-check.
- **Explore page**: `api.open` returns the session's detail and a reader for its records, so
  records cannot be read before the session is opened. The page's requests are unchanged.
- **Datadog `turnParts`** is named steps; one step (naming a call by its parent message) had no
  test and now does.
- **Redaction scanners**: two-line comments on `labeledLineRE`, `jwtRE`, `skKeyEnd`,
  `replaceConnUrls` and `Glob` saying the obvious regex backtracks in JavaScript's engine. A
  comment, because it is behaviour of something we cannot change; the code is as it was.

## Checked

`bun run check`, `typecheck`, `test` (2261 passed, 8 skipped; 30 tests added, none rewritten or
removed), `test:laptop` (360), `check:hook` (37 ms), `scenarios:process` three times (9 each),
`claude plugin test` on the desktop mod, and 2,000 generated scenarios from each of seeds 1,
38211, 48213, 70001 and 91001, all pass with no new findings. Coverage: 18450 of 19712 lines
(93.59%), 15807 of 18744 branches (84.33%), both up from 37.

## Not done

`withInput`'s getter, `FsStore.takeOver`, and the trade-offs (`final` lost in a race costs a
quiet period; `content_hash` not covering all stored content; `addRedaction`'s `rule_set`;
search's `Replaced` and `shows`) are left as they are.
