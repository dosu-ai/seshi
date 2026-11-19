# 19 · The change feed: entries first, unique keys (X6.4)

Branch `seshi-19-change-feed`, on `seshi-18-decisions`. Builds decisions 7 and 8 of
[18](18-decisions.md) ("Revised 15 Nov 2026" under X6.4): every write under `changes/` appends
its entry before the session pointer moves, and change keys are unique.

## What was built

- **Unique change keys (decision 8)**, `packages/ts/store/src/layout.ts`:
  `owners/<owner>/changes/<stamp>-<archive_id>-<suffix>-<content_hash|tombstone|visibility>.json`.
  - `keys.change(owner, at, archive, suffix, kind, hash)` validates every segment (64-hex archive
    id, 8-hex suffix, the hash for a publish). `changeSuffix()` draws the suffix (4 random
    bytes, hex). `appendChange` draws one per entry, so an entry written twice is two entries.
  - `parseChangeKey(key)` reads a key (or its name under `changes/`) back into `{ at,
    archive_id, suffix, kind, content_hash }`; null for anything else, including the old
    `<stamp>-<hash|tombstone|visibility>.json` keys.
  - The stamp still leads, so keys sort by time and `StartAfter` cursors (a key, or a bare
    stamp for `since`) work as before. Within one millisecond keys sort by archive id and
    suffix, not by write order.
- **Entries before the pointer (decision 7)**, `packages/ts/store/src/publish.ts`:
  `updateMetadataWithChange(store, owner, archive, step, { expected?, retries?, sleep? })`.
  `step(current)` returns `{ next, change }`. The entry is appended before the conditional
  update; if a run of `step` inside the update wants an entry and none was written yet, the
  update throws out, appends it, and runs again from a fresh read. At most one entry per call.
  `expected` (the pointer the caller already read) lets it write the entry before the first
  read. Every path that writes under `changes/` uses it:
  - publish (`ingest`, so uploads, chunks, replaces, the OTLP/Datadog assembler and pollers),
    with `expected: before`; a duplicate (trace listed, object there, nothing replaced) still
    writes no entry;
  - `tombstone` (delete, retract, admin redact): entry, then `status: redacted`, then the
    objects go;
  - `setVisibility`;
  - redaction backfill (`backfill.ts`): new trace, `replace` entry, pointer, then the old
    objects go.
  `appendChange` has no other callers outside tests.
- **The indexer tolerates early and orphaned entries**, `packages/ts/search/src/indexer.ts`.
  It lists only keys `parseChangeKey` accepts. `shows(metadata, entry)` says whether the
  session's metadata has the change: a tombstone when the session is gone or redacted, a
  visibility change when the visibility matches, a publish when its trace is listed (first in
  the list for `replace`), anything once the session is redacted. An entry whose change is not
  shown is indexed as the session is now but not marked seen, so the next run (within the lag
  window behind the cursor) reads it again; once its stamp is `lagMs` behind the indexer's
  clock it is marked seen whatever the metadata says. `Plan` now carries the metadata it was
  made from.
- **Other feed readers.** `readChanges`, `GET /v1/changes` and `HttpSessionDB.changes` pass keys
  through and never parse them; the route's visibility filter reads metadata and drops entries
  of sessions with none. Search's live re-check reads metadata too. Nothing else lists
  `changes/`.
- **Contract and docs**: `spec/layout.md` (the key list, `suffix` under identifiers, the
  conditional-writes row, the `changes/` section, the publish protocol with every path's order,
  Reading); the change schema's description (`bun run types` regenerated
  `generated/change.ts`); `spec/openapi.yaml` (`/v1/changes` and `ChangeEntry` descriptions);
  README, docs/server.md, docs/search.md. Removed the lost-entry and collision items from 04's
  and 05's "Still to check" and from 17's "Not fixed".
- **Tests.**
  - `store/src/layout.test.ts`: key shape, validation, sort order across sessions and suffixes,
    a bare-stamp cursor, fresh suffixes, `parseChangeKey` (and old keys refused).
  - `store/src/publish.test.ts`: entry then pointer, no entry when nothing changes, the entry a
    retry finds it needs, one entry across a 412 retry.
  - `pipeline/src/change-feed.test.ts`: a failure injected after the entry and before the
    pointer, for a chunk (entry left, pointer unchanged, the resend lands with its own entry),
    a first publish (entry left, no session, trace object removed), a tombstone and a
    visibility change; two tombstones and two visibility changes of one owner in one injected
    millisecond (one session changed twice) all kept with distinct keys; a cursor taken before
    the changes pages through the new keys in stamp order, and `since` finds the same.
  - `pipeline/src/backfill.test.ts`: a run stopped between its entry and its pointer leaves the
    session as it was, and the next run rewrites it.
  - `search/src/indexer.test.ts`: the indexer run between each write's entry and pointer
    (continuation, new session, tombstone, visibility) does not lose the change; a failed
    continuation and a failed first publish leave the index right, the entry is read again
    until it ages out, and the resends are indexed; two tombstones and two visibility changes
    in one millisecond are all applied.
  - Adjusted: tests that took the last key as the last write while several writes shared a
    fixed clock (`visibility.test.ts`, `tests/api/auth.test.ts`) now find the entry by kind;
    `tests/api/http-backend.test.ts` compares the two backends' feeds with the suffix masked
    and gives each its own cursor.

## Deviations and why

1. **The key holds the archive id, not the native session id.** The decision writes
   `<stamp>-<session_id>-<suffix>-<kind>`. A native id is not key-safe (any string an agent
   chose) and layout.md keeps native ids and paths out of keys; the archive id is the
   session's key-safe id (`sha256(owner, agent, session_id)`, already its folder name) and
   identifies it within the owner's feed. Keys are longer (about 165 characters under
   `changes/`), well within S3's 1024.
2. **The suffix is random, not derived.** A suffix from the entry's content would let two
   identical changes in one millisecond (private, public, private) collide again. 32 random
   bits make a clash between two changes of one session in one millisecond about one in four
   billion.
3. **A publish that turns out to be a duplicate may still leave an entry**, and one that turns
   out not to be gets its entry on a retry of the update. Whether a publish is a duplicate is
   decided against the pointer as read; it can change between that read and the conditional
   write. Both are at-least-once.
4. **The indexer re-reads unshown entries** rather than only reading current metadata as
   before. Entry-first means an indexer can read an entry before the pointer moves, mark it
   seen, and never index the change; "readers already tolerate it" held for a failed write,
   not for one in flight.

## Still to check

- An entry whose writer failed is read again on every indexer run until it is `lagMs` (5 min)
  behind the indexer's clock: one entry GET and one metadata GET per run. A writer whose clock
  is more than the lag window behind has its in-flight entry settled on first read, so its
  change waits for the session's next entry (as 12's clock-skew item already says).
- `shows` errs towards reading again: a publish whose trace a later replace removed, or a
  visibility change flipped back, is re-read until it ages out. Harmless, but it costs reads in
  a feed with many such entries.
- External readers of `changes/` (Dosu's backend, if it tails the bucket) must parse the new
  keys and read entries as notices, re-reading metadata (layout.md, Reading).
