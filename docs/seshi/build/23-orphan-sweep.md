# 23 · Orphan sweep (F2.5, decision 6 of 18)

Branch `seshi-23-orphan-sweep`, on `seshi-18-decisions`. It builds decision 6 of
[18](18-decisions.md), recorded under F2.5 on [../design-decisions.html](../design-decisions.html)
as "Revised 15 Nov 2026": a sweep deletes the trace objects no metadata names that are over an
hour old, so what a backfill or replace that stopped partway leaves is "deleted, not kept". It
closes the dataflow item 17 left in "Not fixed" (since 17 no reader is served those objects; now
they go too). No schema or config change.

## What was built

- **Listings with ages**, `packages/ts/store/src/store.ts`. `ListOptions.details` asks for each
  key's last change; `ListResult.objects` (`ListedKey`: `key`, `modified` ISO 8601, `size`)
  comes back in the order of `keys`. `S3Store` reads it from ListObjectsV2 (`LastModified`,
  `Size`, through the existing `FetchS3Client.listObjects`); `FsStore` stats each listed file
  for its mtime. Without `details` both list exactly as before. Additive: every wrapping test
  store that delegates `list` passes it on.
- **The sweep**, `packages/ts/store/src/sweep.ts`, `sweepTraces(store, { sessions?, owners?,
  minAgeMs?, now?, dryRun?, signal?, onSwept? })`:
  - **Named** (`namedTraces`): every `traces[].content_hash` of the session's `metadata.json`
    (the head and each continuation of a chunked session) plus `head`. A session folder with no
    metadata (a first publish that died before its pointer) names nothing. These are the hashes
    the trace routes and `getTrace` serve (17).
  - **Deleted**: a `trace.<hash>.json.gz` that is not named and whose listing time is more than
    `SWEEP_MIN_AGE_MS` (1 hour) before `now`. An object the listing gives no time for is kept.
    Nothing else in a session's folder is looked at: span records, reviews, metadata, and any
    folder a later branch adds are stepped over, never deleted.
  - **Order**: list, then read the metadata, then read it again just before deleting. A publish
    writes its object before the pointer names it (layout.md steps 1-3), so a young unnamed
    object may be in flight; the age guard keeps it. The second read covers a publish that found
    its object already there (an old leftover of the same content), named it without writing
    it, and so left it looking old.
  - **Scope**: `sessions` (what a backfill or replace touched), `owners`, or every owner. The
    whole-bucket walk lists each owner's `sessions/` once with details and steps over folders
    inside a session (`…/spans/` + U+10FFFF, as `listOwners` skips owner folders), so a session
    with thousands of span records costs one more listing, not thousands of keys.
  - **Report** (`SweepReport`): `sessions` and `traces` looked at, `deleted` (or would be, in a
    dry run), `young` (unnamed, kept by the age guard), `errors` with the first `error`, the
    first 100 objects in `swept`, `more` when the signal stopped it. A session that fails
    (the bucket, metadata that does not parse) is counted and skipped, never deleted from after
    the failure; the sweep goes on and never throws for one.
- **After a backfill**, `packages/ts/pipeline/src/backfill.ts`. Every session the backfill looks
  at (any outcome but `skipped`: `current`, `unchanged`, `rewritten`, `conflict`, `failed`) is
  swept right after it is done, with the backfill's `now` and `dryRun`. `BackfillReport.sweep`
  sums `{deleted, young, errors, error?}`; `BackfillSession.swept` counts a session's. A rerun
  after a stopped run finds the stopped session `current` and its sweep deletes the old objects
  the stopped run could not (their age is that of their first publish, so they are past the
  hour at once unless that was within the hour). A run stopped by the signal skips it.
- **After a replace**, `packages/ts/pipeline/src/ingest.ts`. An `ingest` with `replace` (an
  upload's replace, an S3 rewrite, an assembled session that changed earlier on) sweeps its
  session last, after its change entry, with the write's `now`. Best effort: the write stands
  whatever the sweep finds, and a failed sweep is left for the daily one.
- **Daily**, `packages/ts/instance/src/builtin-jobs.ts`: the `sweep` job (kind `sweep`,
  placement `worker`, `SWEEP_INTERVAL_MS` = 1 day) sweeps every owner. The existing scheduler
  holds it: a job runs at worker start and then every interval, a failed run is retried with the
  usual backoff. Its summary (`sessions`, `deleted`, `young`, `errors`) is the job record's
  `last_summary`, so the heartbeat, `GET /v1/admin/jobs` and `seshi workers status --json`
  carry it; a run with an unswept session is an `error` outcome naming the first failure. No
  new worker role. It is appended to `BUILTIN_JOBS`, so job lists end in `sweep`.
- **`seshi workers status`** (text) prints a job's last run under its line when it did anything:
  `last run: sessions 4, deleted 2` (counts that are 0 are left out, and a run that did nothing
  adds no line).
- **`seshi redact sweep [--owner <id>]… [--dry-run] [--json]`**, `apps/seshi/src/commands/
  redact.ts`: the job as a one-shot where the server config is (X7.1), for a deployment with no
  worker or to clear the bucket at once. It prints each object it deletes (owner, archive and
  hash prefixes, when it was written) and a summary; exit 1 when a session could not be swept.
  `seshi redact backfill` prints what its sweep deleted, kept young or could not sweep, and has
  `sweep` in `--json`. The `redact` summary in the command registry says `test|backfill|sweep`.
- **`FakeS3` writes**, `packages/ts/sources/src/testing.ts`: an opt-in `writable` option takes
  PUT (with `If-None-Match: *` and `If-Match`, 412 and 404 `NoSuchKey` as S3 answers) and DELETE
  (with `If-Match`), and HEAD now answers headers only with `Content-Length`, so an `S3Store`
  can run on it over signed requests with no network. Read-only by default, as before.
- **Tests**:
  - `tests/store/sweep.test.ts`, on the folder store (ages by `utimes`) and on an `S3Store`
    over the writable `FakeS3` (ages by `LastModified`): listings with ages; an orphan over an
    hour deleted and one under kept; a named head and a named continuation chunk kept a year
    old; an object with no metadata beside it deleted; scoping by session and by owner; dry
    run; span records, reviews and other files kept; a session with unreadable metadata
    counted and skipped while the next is swept; the age guard as given.
  - `backfill.test.ts`: a run whose old-object delete fails, then the next run's sweep deletes
    it (`sweep.deleted` 1, `swept` on the session) and keeps the head; the age guard and dry run
    in a backfill, and a session the backfill does not look at is not swept by it; a replace
    deletes an old leftover and keeps a young one; a write that is not a replace sweeps nothing.
  - `instance.test.ts`: the `sweep` job is registered daily on the worker, runs when the worker
    starts, deletes the old orphan and keeps the young one, its next run is a day later, and
    status shows its summary.
  - `redact.test.ts`: `redact sweep` dry run and real run, text and JSON, exit 1 on an unswept
    session, usage errors; `redact backfill` says what its sweep deleted.
  - `commands.test.ts`: `workers status` shows a job's last run when it did anything.
  - The job-name lists in `instance.test.ts`, `commands.test.ts`, `serve.test.ts`,
    `otlp.test.ts`, `datadog.test.ts` and `end-to-end.test.ts` end in `sweep`.
- **Docs**: redaction.md (the sweep, after the backfill), server.md (the `sweep` job, the
  one-shot, status), cli.md (`redact sweep`), spec/layout.md (the sweep in the publish
  protocol: a writer names its object within the hour; `s3:DeleteObject` for the sweep). 07's
  note and 17's fix no longer say nothing deletes the leftovers, and 17's "Not fixed" item is
  gone.

## Extension points for later branches

- **A new folder inside a session** (the per-session messages folder for OTLP span history,
  decision 5): nothing to do. The whole-bucket walk steps over any folder inside a session's
  folder, and the sweep deletes only keys named `trace.<64 hex>.json.gz` directly in it.
- **Change keys and the order of entry and pointer** (decisions 7 and 8): the sweep reads no
  change entry and writes none. The replace sweep is the last thing `ingest` does; if the publish
  path is reordered, keep it after the pointer update and the deletes of what the replace
  replaced.
- **Another writer of the layout** must name a trace object in `metadata.json` within an hour of
  writing it, or write it again (layout.md says so).
- **`ListOptions.details`** is there for anything else that needs an object's age from a listing.

## Deviations and why

1. **Swept session by session during a backfill, not once at its end.** The decision says the
   sweep runs "when a backfill ends", scoped to what it touched. Collecting every touched session
   for one sweep at the end holds a list as large as the bucket; sweeping each as it is done
   needs none, and the age guard, not the moment, is what keeps a publish in flight safe. A run
   stopped by the signal (Ctrl-C) does not sweep the session it stopped in.
2. **"Touched" is every session the backfill looked at**, `current` ones included, not only the
   ones it rewrote. The leftovers of a stopped run sit in sessions the next run finds `current`;
   sweeping only rewritten sessions would leave them to the daily sweep. A session the backfill
   skips (tombstoned, not written since `--since`) is not swept by it; the daily sweep covers it.
3. **The daily job also runs when the worker starts.** The scheduler runs every job at start and
   then on its interval (as `retention` does); a worker that restarts often sweeps more often.
   Harmless beyond the listing cost.
4. **`seshi redact sweep`** rather than a `seshi sync` subcommand. X7.1 makes each worker job a
   one-shot, and the sweep is F2.5's, next to `redact backfill`, whose leftovers it deletes and
   whose server-config handling it shares; `sync` is about sources. Adding a subcommand changed
   only the `redact` summary in the command registry.
5. **`workers status` shows every job's last run counts, not only the sweep's.** Per-job results
   were in `--json` only (`last_summary`); printing them for the sweep alone would special-case
   one job. Counts that are 0 are left out, so idle jobs add no line.
6. **`head` counts as named** besides `traces`. It is always one of `traces` when written by this
   binary; naming it too costs nothing and keeps a hand-edited or partial pointer's head.
7. **No config keys.** One hour and one day are the decision's values; making them settings would
   change the config schema, which the decision says it does not.
8. **The replace sweep uses the write's `now`** (as the backfill's uses the backfill's), so tests
   and embedders that inject a clock get one clock.

## Still to check

- **A reused object, closed at integration.** A publish whose trace object already exists (an
  earlier publish of the same content stopped before its pointer) now writes it again with its
  own bytes (`publishObject`, conditional on the version it read), so its age says a publish is
  in flight. The sweep also stats each object just before deleting it and keeps any that is
  young by then. What is left is the time between that stat and the DELETE: a publish would have
  to rewrite the object, append its change entry and move the pointer inside it. Tests:
  `tests/store/sweep.test.ts` ("a publish that reuses an object…", "…between the listing and
  the delete").
- **Clock skew.** Ages come from the store's clock (S3's `LastModified`, the file's mtime) and are
  compared with the worker's clock. A worker clock ahead of the store's by most of an hour eats
  the guard. Not checked against a real bucket.
- **Cost on a large bucket.** The daily walk lists every owner's sessions with details (one
  listing per 1,000 keys, plus one per session with `spans/` or `review/`), reads the metadata
  of every session with a trace object, and reads it once more for a session with something to
  delete. A backfill adds one listing per session it looks at. Not measured on a real bucket. On the folder store each listing still walks the
  whole folder (as before) and now stats each listed file.
- **Live S3.** `LastModified` parsing, the U+10FFFF `start-after` that steps over a session's
  folders (already used by `listOwners`), and `s3:DeleteObject` for the worker were checked only
  against the fake; `tests/store/s3-live.test.ts` was not extended (no endpoint here). R2, MinIO
  and the others are unchecked.
- **Tombstones stopped mid-delete** leave objects in a session with no `traces`; the daily sweep
  deletes them (they are unnamed), a backfill does not (it skips tombstoned sessions).
- **Rebase**: decisions 7 and 8 touch `ingest`'s publish path and decision 5 adds a session
  folder; see Extension points. 17's "Not fixed" list loses one item here, as other branches of
  18 remove theirs; their hunks sit next to each other.
- CI has not run (no PR).
