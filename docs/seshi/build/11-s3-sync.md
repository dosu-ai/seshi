# 11 · S3 sync (F6)

Branch `seshi-11-s3-sync`, on `seshi-06-instance`. Every binary now polls `[[sources]] type =
"s3"` with a built-in connector: it lists a bucket prefix (S3, R2, anything S3-compatible, or a
local folder), finds new and grown objects from a manifest in its checkpoint, and submits them
to the pipeline as the source's service account. Append-only logs continue by byte offset,
reading only their tail; rewritten objects and whole documents are replaced by their original
writer. Source deletions are ignored. User docs: [server.md](../../server.md#syncing-an-s3-bucket)
and [config.md](../../config.md).

## What was built

- **The poller**, `packages/ts/sources/src/s3/` (layer 3, as X3.11 places it):
  - `connector.ts` `S3Connector` (`kind = "s3"`), one per Instance, stateless between runs
    except assumed role keys. A run (`S3Run`):
    1. refuses a `format` the binary does not read (run error, nothing listed);
    2. lists `<url prefix>/<prefix>/` page by page (1000 keys) from where the manifest says;
    3. skips keys outside `include` globs (Bun's glob) or the `path` template, and directory
       markers;
    4. skips an object whose ETag and size match the manifest without reading it (F6.2);
    5. reads and submits a new or changed one (below), at most 200 per run (`DEFAULT_BATCH`),
       then returns `more: true` with `after` = the last key handled;
    6. saves the checkpoint every 25 objects handled and at the end (If-Match through the
       scheduler, X7.3);
    7. at the end of a complete listing: drops manifest keys a pass that started in this run
       did not see (F6.4), settles `watch_from` for `ordered_keys`, sets `listed_at`, and
       returns `lag_ms: 0`.
  - **Per object** (`object` → `append` or `whole`):
    - *Append* when the manifest knows the object's format and session, the format is
      chunkable, it is not gzip, the session holds `offset > 0` bytes and the object grew past
      them. A `Range: bytes=<offset − 4 KiB>-` GET with `If-Match` on the listed ETag reads the
      tail; the 4 KiB before `offset` must hash to the manifest's `tail`. Only complete lines
      go, as a chunk at `offset` without `replace` (X4.4). A backend that ignores `Range`
      (200, whole body) works the same way.
    - *Whole* otherwise: GET with `If-Match`, gunzip when the bytes are gzip (by magic number,
      bounded by `max_upload_bytes`), strict UTF-8 (BOM kept, so byte offsets match the
      pipeline's), format and session worked out (below), complete lines only for chunkable
      formats (a final line without `\n` is kept when it parses as JSON), submitted at offset
      0 with `replace: true`. The pipeline extends, answers `unchanged`, or replaces (the
      poller is the session's original writer, F6.3/X4.6).
    - The manifest entry then records `offset` = the answer's `bytes_total` (0 after
      `filtered` or a first `dropped`, so the next version goes whole again: the "retain the
      shipped prefix on trivial" lesson), and `tail` over the bytes before it.
    - Format: the manifest's (keeps the archive id stable), else the source's `format`, else
      `x-amz-meta-seshi-format`, else `{format}` in `path`, else `FormatRegistry.detect` on
      the first 64 KiB. Session: the manifest's, else `x-amz-meta-seshi-session`, else
      `{session}`, else the key under the prefix.
    - Envelope: `source: "s3"`, `serviceIdentity(id)` (owner `svc:<id>`, basis `service`,
      X5.4), claims from `{email}`, `{name}`, `{username}`, `{git_email}`, `{git_name}` and the
      `x-amz-meta-seshi-*` equivalents through `pickClaims` (X5.5), `project` and `branch`,
      provenance `{object_key: "s3://bucket/key", etag}`, idempotency key
      `s3://bucket/key#<etag>~<epoch>` (whole) or `…#<etag>@<offset>` (chunk) (X4.7; the
      epoch is deviation 14). Encoding `jsonl` for chunkable formats, `json` otherwise.
    - Outcomes: an object changed between listing and reading (412/416) is skipped and read
      next run (with `ordered_keys` the watch stays before it: `hold`); one gone (404) leaves
      the manifest. A pipeline `failed` answer marks the version (`failed: <code>`) so it is
      not retried until it changes; `offset_mismatch` on a chunk falls back to a whole send at
      once; `redacted` (an admin deleted the session) is never sent again, whatever the object
      does (F6.4).
    - Failures before an envelope go to `ctx.fail` (below) and mark the version:
      `unknown_format`, `too_large` (checked from the listing's size, before reading; for a
      chunk, the growth), `not_utf8`, `bad_gzip`, `unsupported_encoding` (a
      `Content-Encoding` other than gzip), `access_denied` (403 on that object), `unreadable`
      (another final 4xx on that object, not 408/429), `duplicate_session` (a second key
      mapping to a session another key already feeds).
  - `manifest.ts`: the cursor (`Manifest`, `ObjectEntry`; `spec/layout.md` documents it),
    `readManifest` (a cursor of another shape starts over with a warning), `rewindManifest`
    (X4.9: forget entries modified at or after `since`, or of unknown time; keep `redacted`
    ones; `ordered_keys` lists from the start again). The object map has no prototype, so a
    key named `__proto__` is a key.
  - `keys.ts`: `PathTemplate` (`{placeholder}` one segment, `*`, `**/`, `?`), `KeyFilter`,
    `metadataFields` (`x-amz-meta-seshi-<field>`, `-` for `_`).
  - `bucket.ts`: `SourceBucket` (`list`, `read(key, {etag, start})`, `locate`).
    `S3SourceBucket` (path-style with an endpoint, virtual-hosted on AWS; R2 via
    `account_id`; static keys, else `AWS_*`/`S3_*`/`R2_*` from the env the Instance was built
    with; `role` through STS, cached per connector and renewed 5 minutes before expiry).
    `FolderSourceBucket` for `file://` (ETag = mtime and size). `ObjectChanged`,
    `ObjectDenied`.
- **`@seshi/store` additions** (additive): `FetchS3Client.listObjects` (ListObjectsV2 with
  `Size`, `ETag`, `LastModified`, continuation token) and `getObject` (`Range`, `If-Match`,
  `Content-Range`, `x-amz-meta-*`, `Content-Encoding`); `FetchS3Client`, `S3HttpError` and their
  types exported; `sts.ts` `assumeRole` (signed form POST, regional or global endpoint);
  `signRequest` takes `service` (default `s3`).
- **`ConnectorContext.fail`** (`@seshi/kit`, optional) and its implementation in `Sources`:
  writes a failure record under `sources/<id>/failed/` (owner `svc:<id>`, `source_kind`,
  message capped at 300), counts `failed` in the run report and in source health
  (`Submitter.health`, optional, which `Pipeline.health` satisfies). Guarded like `submit`:
  refused after the run ended or the checkpoint was lost; a store error writing it is
  transient (the checkpoint then refuses to move).
- **Instance**: `builtinConnectors({ formats, maxBytes: limits.max_upload_bytes, env })` is
  added to the integrations' connectors unless one of them already polls `s3`.
  `InstanceParts.env` is new; `buildInstance` now passes its `env` through (it used to drop
  it), so `seshi serve` and `sync run` read source keys from the command's env, tests from `{}`.
- **Config**: `s3` sources gain `path` (template, placeholders checked at load:
  `S3_PATH_PLACEHOLDERS`); the F6.4 overlap check now also refuses a folder source inside
  seshi's own folder store. `spec/config.schema.json` regenerated.
- **Testing support**: `@seshi/sources/testing` exports `FakeS3` (ListObjectsV2, GetObject
  with Range/If-Match/416/404/metadata, signed-request check, queued failures, `listen()` on a
  local port) and `FakeSts`. `packages/ts/sources/testdata/s3/` holds a ListObjectsV2 and an
  AssumeRole answer hand-written from AWS's documented shapes (its README says so).
- **Tests** (all offline): `s3/connector.test.ts` (45 cases against a pipeline fake that keeps
  the log protocol), `s3/bucket.test.ts`, `s3/keys.test.ts`, `s3/manifest.test.ts`,
  `fail.test.ts`, store `s3-read.test.ts` and `sts.test.ts`, config `s3-source.test.ts`,
  instance `builtin-connectors.test.ts`, and `tests/instance/s3-sync.test.ts`: a booted
  Instance polling `FakeS3` over real HTTP through the real pipeline, formats and filter
  (claims and provenance in metadata, a Range read of a long log, a small agent-only
  continuation stored under a filter that would refuse it as a first trace, filtered-then-
  grown, replace on rewrite, ATIF detection and growth, tombstone respected, deletion ignored,
  failure records in status, and the worker's `source:<id>` job).

## Extension points

- **Another bucket-like source** (GCS, Azure Blob): implement `SourceBucket` and pass
  `openBucket` in `S3ConnectorOptions`, or add a scheme in `S3Connector.openBucket`.
- **Any connector** can record what never became an envelope with `ctx.fail?.(…)`; the
  Datadog poller (10) should use it for pages it cannot parse.
- **Tests** that need a bucket: `FakeS3` / `FakeSts` from `@seshi/sources/testing`
  (`fetch` in-process, or `listen()` for an `endpoint`).
- **More built-in connectors**: add them to `builtinConnectors` in `@seshi/sources`; the
  Instance picks them up.
- **Tuning**: `S3ConnectorOptions.batch`, `pageSize`, `saveEvery` (not in config yet).

## Deviations and why

1. **Owner mapping is claims only.** The task mentions "owner mapping (path templates or
   metadata)"; X5.4 (Agreed) says claims never decide ownership. So `path` and
   `x-amz-meta-seshi-*` fill claims, session id, format, project and branch, and the owner is
   always `svc:<id>`.
2. **Continuation is checked with a 4 KiB tail digest, not the whole prefix.** Hashing the
   whole prefix would mean downloading the whole object on every growth, which `Range` exists
   to avoid. A rewrite that leaves the 4 KiB before the old end byte-identical would be taken
   as an append; for real rewrites (compaction, regenerated exports) that does not happen. The
   pipeline's own checks still apply to what is sent.
3. **The checkpoint is saved every 25 objects and at the end, not after every object.** The
   manifest holds every object, so a save per object would rewrite it O(n) times per run.
   Each entry still records the object's own ETag, size and offset, and a crash between saves
   only resubmits, deduplicated by the idempotency keys (X4.7).
4. **Pruning (F6.4) only after a listing that started and finished in one run.** A pass that
   resumed mid-listing does not know which earlier keys it saw; such keys are dropped on the
   next pass from the start. Nothing but manifest size depends on it.
5. **Default session key is the key under the prefix** (with its extension), since an S3
   object has no session id of its own and the adapter's native id is only known after
   normalizing. `path` `{session}` or `x-amz-meta-seshi-session` give a cleaner one.
6. **Folder sources (`file://`).** The config already accepted them; the poller reads them
   for one-machine setups and tests, with an mtime/size ETag.
7. **gzip objects** are read (bounded gunzip) and always sent whole. So is an object served
   with any `Content-Encoding`. `getObject` asks fetch not to decode (`decompress: false`,
   Bun's option), so a gzip-encoded object arrives as stored and goes through the bounded
   gunzip; a fetch that decodes anyway leaves text, which is read whole.
8. **`role` is AWS STS only** (`s3://`); R2 has no STS. The STS endpoint is regional when
   `region` is set, global otherwise; there is no setting for a custom STS endpoint.
9. **`access_denied` / `unreadable` on one object are permanent for that version**, not a
   transient run failure: a single unreadable object would otherwise stop the source forever.
   Any final 4xx on one object counts (403 is `access_denied`; 400, an archived object's
   `InvalidObjectState`… are `unreadable`), not 408 or 429. A 4xx on the listing still fails
   the run.
10. **A stale chunk writes a failure record.** When the session moved without the manifest (a
    crash between submit and save, then more growth), the chunk gets `offset_mismatch`; the
    pipeline records permanent failures before answering, so one `offset_mismatch` record is
    written before the poller resends whole. Rare, and harmless beyond the record.
11. **`ordered_keys` + `reprocess --since`** lists from the start again, since keys say
    nothing of time; objects outside the window are normalized again too and answer
    `unchanged` unless the normalizer now reads them differently.
12. **Batch size is a constant** (200 objects per run, then `more`), not a setting, to keep
    the config edit to one field.
13. **`ConnectorContext.fail` is optional** in the type so hand-built contexts (other
    branches' tests) still typecheck; the scheduler always provides it.
14. **A whole object's idempotency key carries the manifest's `epoch`** (X4.7 says bucket,
    key and ETag). Without it, `seshi reprocess` resubmitted each rewound object with the key
    it was first stored under, and the pipeline answered it from `metadata.applied` without
    running any stage, so nothing was rebuilt (X4.9). The epoch is set when a manifest starts
    (first run, rewind to the start, a cursor it could not read) and bumped by every rewind to
    a time. Within one epoch a resend after a crash is still answered from `applied`; a crash
    before the first save of a new manifest resubmits under a new epoch, which the pipeline
    answers `unchanged` (no stage writes, no review: nothing is new). Chunk keys carry no
    epoch, since a rewound object is always read whole.
15. **`prefix` names a folder.** The URL's prefix and `prefix` are joined and get a `/`, so
    `prefix = "runs/2026-"` lists `runs/2026-/`, not keys starting `runs/2026-`. `include`
    does partial names. The F6.4 overlap check is per folder segment too.

## Review fixes

A review of the branch added these commits on top of the implementation:

- **Reprocess rebuilt nothing** (X4.9). A rewound object went whole with the idempotency key
  it was stored under, so the pipeline replayed the recorded answer and ran no stage. Whole
  keys now carry the manifest's epoch (deviation 14). Tested end to end: after a rewind to a
  time, a second rewind to the same time, and a rewind to the start, the object is
  normalized again (`unchanged`, not a replay).
- **gzip bomb** (security). Bun's fetch inflated `Content-Encoding: gzip` bodies with no
  limit before the poller checked any size (the listing's size is the compressed one), so a
  small object in a source bucket could exhaust memory. `FetchS3Client.getObject` now asks
  for the stored bytes and the poller's bounded gunzip applies. Other encodings are recorded
  as `unsupported_encoding`. Tested over real HTTP with a 4 MiB-of-spaces object under a
  1 MiB limit.
- **One unreadable object stalled the source.** Only 403 was recorded; any other 4xx on one
  object (archived, SSE-C) failed every run forever, since the checkpoint cannot pass it.
  Now `unreadable` (deviation 9).
- **The F6.4 folder check** compared paths as written; `.`/`..` segments are now resolved.
- Docs: server.md and config.md (failure codes, epoch, reprocess, `prefix` as a folder),
  spec/layout.md (`epoch`).

## Still to check

- Never run against real S3, R2 or MinIO: `start-after` paging, `Range` with `If-Match`
  (and 416 when an object shrank), user metadata casing, and STS AssumeRole with an external
  id. The live S3 test (`tests/store/s3-live.test.ts`) does not cover the poller.
- Bun's `fetch` does decode `Content-Encoding: gzip` by default, without a size limit, and
  `decompress: false` stops it (checked against a local `Bun.serve`, and the end-to-end test
  covers it over HTTP). Not observed against real S3.
- Manifest size: about 200 bytes per object, rewritten at least once per run. Fine for tens
  of thousands of objects; a very large bucket wants `ordered_keys` or S3 event
  notifications through SQS (F6.2 "later").
- S3 lists keys in UTF-8 byte order; the poller compares keys with JavaScript string order
  for pruning and `watch_from`. They differ only for characters above U+FFFF against
  U+E000–U+FFFF.
- Detection reads the first 64 KiB; a JSONL whose distinctive record comes later is
  `unknown_format` unless the source or the object names its format.
- `packages/ts/instance/src/instance.test.ts` "spots a second worker from the heartbeat" was
  seen failing once in five runs here (a timing test, untouched by this branch).

## Cross-branch wiring once the stack is linear

- **10 (Datadog)** also implements a connector against the same `ConnectorContext` and
  `Sources`: keep both sides' additions to `@seshi/kit` and `sources.ts` when rebasing.
  If 10 added its own way to record connector failures, fold it into `ctx.fail`. Its tests
  that build a `ConnectorContext` by hand need nothing (`fail` is optional).
- **docs/config.md**'s `[[sources]]` paragraph still says connectors "come with their
  branches (10, 11)"; once 10 and 11 are both in, say every binary polls `s3` and `datadog`.
  `seshi.example.toml` could gain an `s3` source next to the Datadog one.
- **07 (rule packs)**: changing rules makes a whole re-send not extend the stored prefix
  (04 deviation 4). The poller always sends whole objects with `replace`, so a rule change
  turns into a replace (by the original writer) rather than a conflict; chunks are
  unaffected.
- **08 (model review)**: a review `dropped` answer is handled: the manifest takes its
  `bytes_total` (0 for a first envelope, so the next version is sent whole and reviewed
  again).
- **13 (CLI)**: `seshi sync failed <id>` shows the new codes (`unknown_format`,
  `too_large`, `not_utf8`, `bad_gzip`, `unsupported_encoding`, `access_denied`,
  `unreadable`, `duplicate_session`); `sync status`
  could show the manifest's object count and `listed_at` from the checkpoint cursor.
- **16 (docs)**: the README's feature list can mention S3 sync.
