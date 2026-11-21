# 20 · A dropped first envelope leaves a stub (F3.4)

Branch `seshi-20-review-drop`, on `seshi-18-decisions` (719727c), built beside the other
branches that build 18's decisions. It builds decision 3: F3.4 wins over F3.1 for a session's
first envelope. A model review drop of a session that has nothing stored (review said `drop`,
or review failed with `on_failure = "drop"`) writes a content-free session stub beside the
drop record, so the log moves past the dropped envelope as it already did for later ones.
What follows is reviewed on its own, the stored trace starts after the dropped part, and the
dropped text is never stored or sent to review again. This closes 04's deviation 9, 08's
"Re-review of first uploads" and the dataflow item in 17's "Not fixed".

## What was built

- **The stub.** A session's `metadata.json` with `status: "stored"`, no `head`, `traces: []`,
  and only what is not content: `owner`, `session_id`, `agent`, `archive_id`, `writer`,
  `owner_basis`, `visibility`, `created_at`/`updated_at`, `retract_hash` (so the machine can
  retract it, F9.7), `normalized` (the byte offset past the dropped envelope, the record count,
  the prefix hash and its resumable state), `withheld_calls` (call ids only, so a sensitive
  call's result in the next chunk is still withheld) and `applied` (the drop's answer, X4.7).
  No `source`, `project`, `branch`, `claims`, `provenance` or `redaction`, no trace object, no
  review record and no change entry. `isStub(metadata)` in `@seshi/model` says whether a pointer
  is one (`stored` without `head`; a tombstoned session has no `head` either but is
  `redacted`).
- **One drop path.** `Pipeline.commit` no longer answers zeros for a session without a trace:
  every drop that is not a replace goes through `progress` → `recordProgress`, which moves the
  log to the plan's `normalized` state. `recordProgress` takes an optional `createStubIfMissing`
  (`StubInput`: session id, agent, writer, owner basis, visibility, retraction hash) and
  creates the pointer from it when the session has none; without it, a session with no
  pointer is still left alone. Drops of later envelopes already moved the offset (04); they
  take the same call, and so does a drop of a chunk sent to a stub (the stub moves on). A
  dropped replace is unchanged: the session's log stays the stored history's (17).
- **Continuing a stub.** The stub is handled like a stored prefix:
  - A chunk is taken from the stub's `normalized.bytes` (`409 offset_mismatch` with that
    offset otherwise), normalized and redacted with its state, reviewed alone, and written as
    the session's first trace.
  - A whole log (a resend from 0 after a 409, a moved transcript, an S3 object read whole, an
    assembled OTLP or Datadog session) whose first `normalized.records` records hash to the
    stub's prefix ships only its tail, reviewed alone. With no tail it answers `unchanged`
    (what a session with a trace answers for an already-applied prefix) and reviews nothing;
    the very same envelope again gets the recorded `dropped` answer (X4.7). One that does not
    extend the stub is `409 conflict`, unless it is a replace by the stub's writer or an admin
    (X4.6, `mayReplace` with the stub's `retract_hash` for the org key), which leaves the
    dropped start out as a rebuild does (21's "Meeting 20").
  - Either way the first trace is a `continuation` from the dropped records (`from_record` =
    the stub's record count, `prefix_sha256` = its prefix hash), as a fork's first trace is,
    so its content hash, the search indexer (`currentTraces`) and the backfill join all treat
    it as they treat a fork. Its meta record is `{ "role": "meta", "source": <agent> }` (see
    deviation 2), the same for a chunk and a whole log, so both write the same trace. Later
    chunks repeat that meta record from the head as usual. Extensions are never judged by the
    session filter (the dropped envelope already passed it; the filter runs before review).
- **Readers.**
  - HTTP API: `GET /v1/sessions` leaves stubs out; `GET /v1/sessions/:agent/:id`, `/trace`,
    `/export` and `/reviews` answer `404` (`readable` treats a stub as not found);
    `GET /v1/changes` read by someone other than the owner (or an admin) leaves out a stub's
    entries.
  - `PATCH` (visibility) and `DELETE` (tombstone) find a stub for its owner or an admin only
    (`readable(…, { stubs: true })`, checked as an owner-only session), so anyone else gets the
    same `404` as for a session that does not exist. The retraction route (`X-Seshi-Retract`)
    already read the pointer directly and works on a stub.
  - `StoreSeshi` (local mode, the CLI): `getSession` answers null for a stub (so
    `getTrace` and `reviews` do too), `listSessions` leaves stubs out. `tombstone` and
    `setVisibility` work on one.
  - Search already removed or skipped a session without a `head` (`Indexer.plan`, the live
    check in `SearchService.search`); a stub writes no change entry, so nothing indexes it.
  - The change feed: a stub writes no `published` entry; its first trace is its first.
- **Redaction backfill.** A stub is `skipped` (no trace), but the span records kept beside an
  assembled stub are redacted again, as they were when the session had no pointer (the walk
  for unpublished span folders skips any folder with a `metadata.json`).
- **Uploader and S3 poller.** No change in code: both already took `bytes_total` from any
  answer. The uploader's `stored = bytes_total > 0` now holds for a dropped first upload, so
  its offsets move past the drop and the next piece is a chunk; the S3 manifest's `offset`
  does the same, so a grown object goes as an append. The uploader's protocol comment says so.
- **Contract and docs.** `metadata.schema.json`: `head`'s description names the stub
  (regenerated `generated/metadata.ts`); a new conformance example,
  `spec/testdata/objects/metadata.stub.json`. `spec/layout.md` (the stub, continuing it, the
  drop rule), `spec/openapi.yaml` (upload, list, show, PATCH, DELETE, changes, reviews),
  `docs/server.md`, `docs/model-review.md`, `docs/capture.md`. 04's deviation 9 and the zeros
  in 04's "What was built" and deviation 2, 08's open item, and 17's "Not fixed" entry are
  updated or removed.
- **Tests.**
  - `packages/ts/pipeline/src/pipeline.test.ts`: a first drop stores only the pointer (no
    trace, change entry or review; nothing of the dropped text or its meta record's directory
    in the bucket); the next chunk is reviewed alone, with the stub's meta record, and stored as
    a continuation that is the first change entry; a chunk at another offset is told the stub's;
    a whole log from 0 answers `unchanged` or the recorded answer and reviews nothing, and a
    grown one reviews and stores only its tail, the same trace a chunk writes; a drop past a
    stub moves it on; replace and conflict on a stub; tombstone and visibility on a stub; the
    local session API neither lists nor serves one.
  - `tests/review/review.test.ts` (the real reviewer against the fake provider server, through
    the HTTP API): review drop and `review_failed` with `on_failure = "drop"` both leave a stub,
    the next append goes to the provider alone, and a whole-log resend sends nothing dropped to
    it; a stub is not listed, shown, exported, searched or on bob's view of alice's feed, and bob
    cannot find it to change or delete it; retraction with the secret (and refusal with another)
    and an owner's delete, after which appends are `422 redacted` and nothing more is reviewed;
    an assembled OTLP session's dropped first assembly leaves a stub the next call extends.
  - `tests/instance/datadog.test.ts`: a dropped Datadog session leaves a stub.
  - `packages/ts/pipeline/src/backfill.test.ts`: span records beside a stub are redacted again.
  - `packages/ts/capture/src/uploader.test.ts`: the uploader moves past a dropped first upload
    and sends only what follows. `packages/ts/sources/src/s3/connector.test.ts`: the poller
    appends to a log whose first version was dropped.

## Extension points

- `isStub(metadata)` (`@seshi/model`) for any reader of pointers: a stub is not a session to
  show.
- `recordProgress({ …, createStubIfMissing })` and `StubInput` (`@seshi/pipeline` `ingest.ts`) write one; the
  pipeline's `progress(…, createStubIfMissing)` is the only caller.

## Deviations and why

1. **No new schema field.** 18's notes expected the stub to add to the metadata schema. It
   needs nothing new: `head` was already optional ("absent before one is stored"), and
   `spec/layout.md` already told readers that no `head` means nothing to read. Only `head`'s
   description changed, with a conformance example. This also keeps the rebase with decision
   2's metadata change small. (Meeting 21 added one, `dropped_prefix`, so the session still
   knows its dropped start once it has a trace: see 21's "Meeting 20".)
2. **The stub's first trace has a minimal meta record**, `{ role: "meta", source: <agent> }`,
   not the log's. The meta record came from the dropped envelope; its working directory,
   branch, model and agent version are part of what review dropped (a policy may drop by
   repository), and the stub keeps no content to rebuild it from for a chunk. So the trace's
   `metadata` has no `cwd`, `git_branch` or `model`, and the session's `branch` is the
   envelope's, never the one the dropped meta record named. For the `trajectory` format the
   source is `trajectory`, not the agent the file names.
3. **A stub's extensions are not filtered.** The dropped envelope passed the session filter
   (it runs before review), and a tail is never judged, so an agent-only append is not lost.
4. **A stub is listed once tombstoned.** A tombstoned stub is `redacted`, not a stub, and is
   listed as deleted like any tombstoned session. Its tombstone and visibility change entries
   are written as for any session (with `content_hash: null`), because another branch is
   changing the change-feed keys and the order of entry and pointer, and that code is only
   called here; another reader's `/v1/changes` leaves out a live stub's entries, and search
   treats them as about a session it holds nothing of.
5. **A replace or conflict on a stub reviews a new history whole.** A whole log that does not
   extend the stub is a different history (or the rules or the normalizer changed, 04's
   deviation 4), and the server cannot tell which of its bytes were the dropped ones. The
   writer's replace reviews it whole, as for a stored session; any dropped text it still holds
   goes to review again. The uploader only replaces after a `409 conflict`. *Superseded when
   20 met 21:* a replace leaves out the log's first `normalized.bytes` bytes (or records), so
   the dropped text is not reviewed again; see 21's "Meeting 20".

## Still to check

- **Rule and normalizer changes** still make a whole resend of a stub session a conflict and
  then a replace (deviation 5). Since 20 met 21 the replace leaves the dropped bytes out
  (21's "Meeting 20"); the 409 round trip remains.
- **Change feed (decisions 7 and 8).** A stub writes no change entry, so the new key format
  and the entry-before-pointer order do not touch it; check after the rebase that a tombstone
  or visibility entry with `content_hash: null` for a session a reader never saw is still
  harmless to every feed reader.
- **Assembled sessions.** A stub's span records stay under `spans/` as any session's do
  (F4.4). A late span makes the assembler replace; since 20 met 21 the replace leaves the
  dropped records out, by count when a late span landed inside them, so the last dropped
  record is then reviewed again (21's "Meeting 20").
- 11's and 14's notes still describe a dropped first envelope answering zeros (what they were
  built against); their code needed no change.
- `seshi sessions show` of a stub says not found; its owner sees the drop in `seshi sync
  dropped upload` only.
- Not checked against a live provider (as for 08). A full `bun run test` once failed
  `packages/ts/kit/src/capture.test.ts` ("gives sh … the same words"), which spawns `/bin/sh`
  and passed when run again; it is unrelated to this branch.
