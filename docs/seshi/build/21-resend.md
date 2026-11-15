# 21 · Resending stale sessions (X4.9, decision 2)

Branch `seshi-21-resend`, on `seshi-18-decisions`. The server keeps no raw logs, so it cannot
rebuild a session an older normalizer built; the machine that uploaded it sends it again. Each
session's metadata now records the format version that built it, the server lists a caller's
stale sessions, a new envelope field `rebuild` makes the server build and review a session
again from its whole log even when the log only extends what is stored, and the uploader
resends stale sessions by itself (`seshi capture resend` by hand). `seshi reprocess` points
there for uploads. User docs: docs/capture.md, docs/cli.md, docs/server.md, docs/client.md,
docs/model-review.md; contract: `spec/openapi.yaml`, `spec/layout.md`, the envelope and common
schemas.

## What was built

- **A normalizer version per format.** `FormatAdapter.version` (`@seshi/model`, optional,
  `1` when omitted): dotted numbers compared one by one. `lettaAdapter({ revision })` sets
  `<revision>+trajectory.<@letta-ai/trajectory version>` (revision 1 by default), so every
  Letta-based format (Claude Code, Codex, Cursor's, OpenCode, Pi, Gemini CLI, ATIF) goes stale
  when the library changes, and an integration raises `revision` when its own `prepare`,
  `finish` or `calls` change a stored transcript's records. `@seshi/formats`:
  `compareNormalizerVersions`, and on `FormatRegistry` `versionOf(format)`,
  `normalizerFor(format)` (the release `NORMALIZER` plus `format_version`) and
  `isStale(format, builtWith)`.
- **The version on every session.** `Normalizer` in `common.schema.json` gains an optional
  `format_version`, so traces and `metadata.json` both carry it. `Pipeline.commit` writes
  `formats.normalizerFor(envelope.format)`. A chunk keeps the session's older version (new
  `ingest` option `session_normalizer`): the tail is the new adapter's, the prefix still the
  old one's. A whole write (a first trace, a whole log that extends, a replace, a rebuild)
  sets the current one. A session with none recorded is stale; a format this deployment does
  not read is never stale.
- **Stale listing.** `@seshi/pipeline` `staleSession(metadata, formats)` and
  `staleSessions(store, owner, formats, { after, limit })`, paged by key like `listSessions`.
  `GET /v1/sessions/stale` (operation `staleSessions`, schema `StaleSessionsPage`): the
  caller's own stale sessions as `{ agent, session_id, built_with?, current }`, with
  `sessions:write`. `SessionDB.staleSessions` on both backends (`HttpSessionDB`,
  `StoreSessionDB`); `@seshi/model` `StaleSession`, `StaleSessionsPage`.
- **`rebuild` on the envelope** (`envelope.schema.json`), `SessionUpload.rebuild`, and the
  upload route's body field. In `Pipeline.whole` a rebuild skips the "does it extend" check and
  takes the replace path, with `mayReplace` and the retraction secret (`X-Seshi-Retract` is now
  read for a rebuild too); the refusal says "rebuild". A rebuild at `offset` > 0 is
  `bad_chunk`. A rebuild with no idempotency key gets the derived key plus
  `#rebuild-<uuid>`. Review runs on every record, so envelopes review skipped or dropped are
  reviewed again, except a dropped first envelope ("Meeting 20"). With nothing stored, a
  rebuild is a first upload (filter included).
- **The uploader.** `SessionState.rebuild { at, key, for? }` and `rebuilt_for`;
  `uploader.last_stale_check`. `SessionSink.stale?()` (optional, additive):
  `httpSink` reads every page through `allStale` (at most 100); local mode's sink lists the
  bucket. At the end of a pass (`checkStale`), at most every `staleIntervalMs` (1 hour), and
  only when some session was stored from here, the uploader asks; after a failure it waits
  `retryMaxMs`. It marks each stored session listed (matched by format and upload id, so
  `<id>~<n>` generations count) unless it is turned off, already marked, or already rebuilt for
  that `current` version. A marked session is pending; `sync` sends it whole with `rebuild`,
  its kept key and the retraction secret. Answered (any status), the mark is cleared and
  `rebuilt_for` set; a permanent refusal clears it too, so the session's chunks go on as
  before; a transient one keeps the key for the retry. A dropped rebuild sets `replace_next`,
  as a dropped replace does. Retraction clears both fields. `sessionWord` says `resending`.
- **`seshi capture resend --all | --session [<id>] [--agent <a>]`.** Marks sessions with a
  fresh key, clears a permanent refusal that would hold them, spools a wake and starts the
  uploader. Leaves out sessions turned off (or waiting for a retraction), never uploaded from
  here, or whose transcript is gone, and lists them. `--json`: `{ resending, skipped }`. Exit 2
  for bad usage, 4 for a session this machine has not seen, 6 when the one session named
  cannot be resent. The command registry's summary names it.
- **`seshi reprocess`.** The refusal for source `upload` (`Sources.rewind`), the command's
  header, its usage (what `--help` prints), its registry summary, docs/cli.md and
  docs/server.md now say the uploaders resend stale sessions and `seshi capture resend` does it
  by hand.
- **Tests.** Formats: version comparison, defaults, staleness, the Letta version. Pipeline: the
  version recorded and listed stale once the adapter is newer (not when older), a chunk
  keeping the old version and a rebuild making it current, no version counting as stale, a
  rebuild of a log that only repeats what is stored building and reviewing again (a skipped
  review redone) instead of `unchanged`, a dropped chunk reviewed again, rebuild needing the
  replace permission (another writer refused, an admin allowed) and never a chunk, a rebuild
  with nothing stored being a first upload. API: `openapi.test.ts` covers every status of the
  new route and the rebuild refusals. Uploader: a stale session resent once per version and not
  on every pass, chunks going on afterwards; sessions turned off never resent (before and after
  marking); no ask before anything was stored and a wait after a failure; a rebuild's key kept
  across a retry, and a refused rebuild given up; a hand-marked session the server holds
  nothing of. `httpSink.stale` paging and sign-in. End to end (`tests/capture`): a stale session
  found and rebuilt over HTTP with the org key and in local mode, `resend --session`, `resend
  --all` skipping a session turned off, and the refusals.

## Telling the uploader: an endpoint, not a field on upload answers

The task allowed either. A field on upload answers only reaches a session that is still being
uploaded, and stale sessions are mostly finished ones: their transcripts no longer grow, so
nothing would ever be uploaded to carry the news. A listing reaches every session the uploader
still holds, so it is the one channel; a field as well would be a second path to the same
state. The route takes `sessions:write` because a device token has only that, and it answers
only ids and versions of the caller's own sessions, never content. It reads the owner's
`metadata.json` files as `GET /v1/sessions` does, so the uploader asks at most hourly, and not
at all on a machine that stored nothing.

## Extension points for later branches

- **Adapter authors:** raise `version` on a `FormatAdapter` (or `revision` on
  `lettaAdapter`) with any change that alters the records of a transcript already stored.
  Every session of that format becomes stale, and its uploaders resend it within the hour.
- **Other resends:** set `rebuild: true` on an upload or envelope to rebuild and review a
  session from its whole log; it needs the replace permission.
- **Pollers:** `staleSession` works on any metadata; a poller that can fetch again could pick
  the sessions to rewind from it (not done: pollers rewind by checkpoint, 06).

## Deviations and why

1. **Stale is decided by the format's version, not the release.** `normalizer.version` is the
   release with the library as build metadata, and changes at every release; comparing it
   would make every session stale (and resent and reviewed again) at every release. The format
   version changes only when that format's output can.
2. **A session's version is the oldest of its traces.** A chunk normalized by a newer adapter
   does not make the stored prefix current. A whole log that extends the stored session does
   set the current version, since the whole log was normalized by the current adapter and its
   records matched what is stored.
3. **`rebuild` implies `replace`.** The uploader sends `rebuild` alone; the server treats it as
   a replace with the same permission, and a client need not send both.
4. **A rebuild that builds the trace already stored answers `duplicate`.** Rebuilt and
   reviewed, but the object is byte-identical, so there is no new change entry; the metadata
   (normalizer version, applied envelopes) is still updated, so the session stops being stale.
5. **`seshi capture resend` needs `--all` or `--session`.** The decision writes `[--all |
   --session <id>]`; with neither, it is a usage error rather than a guess, since resending
   everything sends every session to review again. `--session` without an id names the current
   session, as `capture off|on` do, and `--agent` works as there.
6. **Only sessions uploaded from this machine are resent** (`sent`). A session whose first
   envelope was filtered was sent, so it is resent (and reviewed again); one whose first
   envelope review dropped is resent, but the dropped part is left out ("Meeting 20"); one
   never sent has nothing on the server to rebuild.
7. **The stale check runs at the end of a pass,** so a session stored in that pass is asked
   about too, and what it marks goes on the next pass ("on its next pass", decision 2).
8. **Once per version.** A session the server still lists after its rebuild (review dropped
   it, or the rebuild was refused) is not marked again until a newer version is listed;
   `seshi capture resend` can still send it.
9. **The listing is not filtered by writer.** It lists all of the caller's stale sessions; the
   uploader matches them against its own state, and a session another machine wrote is not in
   it.

## Meeting 20

20 (a dropped first envelope leaves a stub, F3.4) and this branch met in one gap: a rebuild
takes `Pipeline.whole`'s replace path, which redacted, reviewed and wrote the whole log, the
records review dropped included. The same path is reached by a replace after a 409 (the rules
or the normalizer changed since the stub's prefix hash) and by an assembled OTLP session a late
span forces to replace. Once the stub's first trace is stored the session has a `head`, so
nothing remembered which part was dropped. F3.4 (revised 15 Nov 2026) says that part is never
stored or sent to review again.

- **`dropped_prefix` on the metadata** (`metadata.schema.json`, `DroppedPrefix`): `{ bytes,
  records, prefix_sha256 }`. `recordProgress` sets it to `normalized` whenever the session
  has no `head` (a stub: everything normalized so far was dropped or held no records); `ingest`
  keeps it through every later write (it spreads the stored pointer), replace included, and
  takes a new one from the write that left the dropped start out; a tombstone removes it.
  Counts and a hash, never content. Conformance example: `metadata.stub.json`.
- **The replace path leaves it out** (`Pipeline.pastDropped`). For a session with a
  `dropped_prefix` (or a stub written before the field existed, whose `normalized` is all
  dropped), the number of leading records to leave out is:
  1. `records`, when the first `records` records, regex-redacted, still hash to
     `prefix_sha256`;
  2. else, for an uploaded `jsonl` log of a chunkable format (`WholeOptions.recordsIn`, from
     the upload path, which has the text), what the current adapter makes of the log's first
     `bytes` bytes, cut at the line boundary at or past them (a cut inside a line takes the
     whole line: more left out rather than less). This covers a rebuild after an adapter
     change and a replace after a rules change;
  3. else (an assembled session, `bytes` 0, or a JSON document) `records`.
  What follows is redacted as the tail of the left-out part (it carries its withheld calls),
  reviewed alone (`commit` judges what follows the meta record) and written as
  `[{ role: "meta", source: <format> }, …what follows]`, a `continuation` from the left-out
  records with their prefix hash, the branch from the envelope (the log's meta record was
  dropped), `normalized` over all the records, and `dropped_prefix` refreshed to what was left
  out. Nothing left: `unchanged`, through `progress`. A session with a trace is replaced; a stub
  is not (it has no trace to replace): its first trace is published as any first trace is, and
  if review drops what follows, the stub moves on.
- **Tests.** `pipeline.test.ts` ("written whole again later"): rebuilds with and without a
  trace, after an adapter change, a replace after a rules change, an assembled replace, the
  field kept and tombstoned, and a plain session rebuilt whole as before.
  `tests/review/review.test.ts`: over HTTP, a rebuild and a replace send the provider nothing
  dropped.

Deviations from the design as given:

1. **A stub's rebuild or replace is not written as a replace.** The design wrote `replace:
   true` for every write past the dropped start. A stub has no trace to replace, so its first
   trace is published without `replace` (the change feed's first entry for it is a plain
   `published`), and a drop of what follows moves the stub on rather than leaving the stub's
   old state, as for any envelope sent to a stub.
2. **A dropped start with no records left out is rewritten whole.** When the dropped bytes
   normalize to no records (they held only transport lines), nothing is left out and the
   ordinary replace runs, rather than writing a second meta record before the log's own.

Limits: an assembled session (no bytes) whose late span lands inside the dropped part shifts
what follows by one record, so the last dropped record is reviewed again; a JSON document
(ATIF) after an adapter change is cut by its old record count. A first upload dropped because
review failed (`on_failure = "drop"`) is never reviewed again either: a rebuild cannot recover
it. Sessions that began as stubs before `dropped_prefix` existed and have a trace since carry no
record of their dropped start (none exist outside these branches).

## Still to check

- **Cost at scale.** A bump of `@letta-ai/trajectory`'s `NORMALIZER_VERSION` makes every
  session of the Letta-based formats stale at once. Spread in [26](26-resend-spread.md): each
  waits a random time within 24 hours, and a pass sends at most two.
- **Pipeline changes are not versioned.** Only adapters carry a version. A change in the
  pipeline that alters records (trace parsing, the call attachment in `@seshi/formats`) needs
  the affected adapters' versions raised by hand; regex rules have their own backfill.
- **The listing reads every metadata object of the owner** (paged by key, up to 1000 keys a
  page, at most 100 pages per ask). An owner with very many sessions makes each hourly ask
  expensive; an index from the change feed would avoid it.
- **For the branches in flight:** the capture-pause branch (decision 1) freezes a running
  session at an offset; a rebuild is a whole-log resend and must stop at that frozen offset too
  (`sync` builds the piece from 0 to the transcript's size). The dropped-first-envelope stub
  branch (decision 3): `staleSession` needs a `head`, so a stub is never listed. How a rebuild
  meets a stub is in "Meeting 20".
- Not run against a live server or real agents; checked with the in-process server and
  fixtures only.
