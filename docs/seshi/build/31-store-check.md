# 31 · seshi store check

Branch `seshi-31-store-check`, on `seshi-30-verify-skill` (bce4abc). One checker for the
invariants of a seshi bucket that 19–23 changed and every writer relies on: change entries
before the pointer with unique keys (19), stubs (20), `dropped_prefix` and
`normalizer.format_version` (21), span messages stored once (22), the orphan sweep's hour (23).
Two callers: a person or CI against a bucket (`seshi store check`), and the next branch's
scenario runner, which checks the bucket after every step. So the core is a library function
that prints nothing and exits nothing. User docs: docs/cli.md (the `store check` row),
[docs/server.md](../../server.md#checking-the-bucket); contract: spec/layout.md (the chain
rule, and the checker under Reading).

## What was built

- **`checkStore`**, `packages/ts/store/src/check.ts` (layer 1, `@seshi/store`):

  ```ts
  checkStore(store: Store, options?: CheckOptions): Promise<CheckReport>
  interface CheckOptions {
    owners?: readonly string[];
    sessions?: readonly { owner: string; archive_id: string }[];
    now?: () => Date;
    minAgeMs?: number;     // SWEEP_MIN_AGE_MS (1 hour) by default
    readTraces?: boolean;  // true by default
  }
  interface CheckReport { findings: Finding[]; counts: CheckCounts }
  interface Finding {
    severity: "error" | "warn"; code: FindingCode;
    owner?: string; archive_id?: string; key?: string; message: string;
  }
  ```

  `FINDINGS` maps each code to its severity (fixed per code) and a line saying what it means;
  `CheckCounts` is `{ owners, sessions, stubs, redacted, trace_objects, change_entries,
  span_records, span_messages, tokens, errors, warns }`. It calls only `list`, `get` and `stat`
  (a test wraps the store and sees no write or delete), pages through every listing (1,000 keys
  a call; an owner's `sessions/` is walked once, stepping over folders inside a session as the
  sweep does), reads 16 objects at a time, and turns any throw from the store into a
  `read_failed` finding for that part and goes on. It throws only for options that name no
  owner or archive id. Layer 1 is enough: it needs the layout, the sweep's `namedTraces` and age,
  the span store and `@seshi/model`'s `parseTrace`, `isStub` and the schema check below.
- **`schemaProblems(file, value)`**, `packages/ts/model/src/schemas/validate.ts` (layer 0):
  what is wrong with a value as an object of `metadata.schema.json` (or `change`, `layout`,
  `trace`, `envelope`), as JSON pointers, at most 20. The model package had no validator for
  the stored objects (only `parseTrace` for traces), so `scripts/model-types.ts` now also writes
  each schema as data into its generated module (`JSON_SCHEMA`, annotations left out), and
  `schemaProblems` interprets the subset of JSON Schema the contract uses. A keyword outside it
  throws, as in the generator. `tests/spec/schemas.test.ts` holds it to ajv: every conformance
  object passes, and for every one-field change to each metadata, change and layout example
  (dropped, made a number, -1, a hash, null, a date, a bad date, an extra field, nested ones)
  both say the same.
- **`seshi store check [--owner <id>]… [--json] [--config <file>] [--set path=value]…`**,
  `apps/seshi/src/commands/store.ts`, a new `store` group in the command registry. The config is
  found as `admin-target.ts` finds it, less the server: `--config`/`--set`; else `SESHI_CONFIG`
  or `/etc/seshi/seshi.toml`; else the CLI config's `[local] config` (local mode's bucket); else
  `SESHI_*` env. Never `./seshi.toml` unasked (the usual hint). A summary line (`checked <url>:
  2 owners, 6 sessions (1 stub, 1 deleted), …: 2 errors, 1 warning`, or `no problems`), then the
  findings grouped by session (`<owner> <archive_id>`, `<owner> (change feed)`, `the bucket`):
  the severity word padded then painted (B1.4), the code, the message and the key, everything
  from the bucket through `printable`. `--json`: `{ store, findings, counts }`. Exit 0 with no
  errors (warnings alone too), 8 (`attention`) with any error, 2 for usage, 3 for a config or
  store URL that cannot be used.

## Invariants and their codes

| Code | Severity | What it says |
|---|---|---|
| `read_failed` | error | The store failed a read, so that part was not checked |
| `marker_missing` | error | The bucket holds `owners/` but no `seshi.json` (an empty bucket is fine) |
| `marker_invalid` | error | `seshi.json` is not JSON or does not match `layout.schema.json` |
| `marker_version` | error | `seshi.json` names a layout or trace format this seshi does not read |
| `marker_legacy` | error | `sessionstorage.json` is there: a sessiondb prefix (X1.5) |
| `token_unreadable` | error | A `tokens/<id>.json` does not parse as `seshi/token/1` (only its key is reported) |
| `metadata_unreadable` | error | A `metadata.json` is not JSON |
| `metadata_invalid` | error | A `metadata.json` does not match `metadata.schema.json` |
| `metadata_identity` | error | Its `owner` or `archive_id` is not its key's, or `archive_id` ≠ sha256(owner, agent, session_id) |
| `head_not_in_traces` | error | A stored session's `head` is not one of its `traces` |
| `head_missing` | error | The head's trace object is not there |
| `trace_missing` | error | Another trace `traces` lists is not there |
| `trace_unreadable` | error | A named trace object is not gzipped JSON, does not match `trace.schema.json`, or its records are not a trace |
| `trace_mismatch` | error | Its `content_hash`, its records' hash, its record count or its continuation disagree with its key or its `traces` entry |
| `chain_start` | error | The first trace does not start at `dropped_prefix.records` |
| `chain_break` | error | A later trace is no continuation, or starts inside the traces before it |
| `chain_gap` | warn | Records between traces (or after the last, up to `normalized.records`) are in no trace, and no `dropped` entry in `applied` ends there |
| `chain_total` | error | The traces hold more records than `normalized.records` |
| `format_version_missing` | warn | A stored session has no `normalizer.format_version`, so it counts as stale (X4.9) |
| `publish_no_entry` | error | A trace in `traces` has no `published` entry naming it |
| `stub_traces` | error | A stub (stored, no head) lists traces |
| `stub_content` | error | A stub holds `source`, `project`, `branch`, `claims`, `provenance` or `redaction` |
| `stub_log_state` | error | A stub has no `normalized`, or `dropped_prefix` is not equal to it |
| `stub_trace_object` | error | A stub has a trace object older than the sweep age |
| `redacted_readable` | error | A tombstoned session still names a head or traces |
| `redacted_trace_object` | error | A tombstoned session has a trace object older than the sweep age |
| `redacted_spans` | error | A tombstoned session has span records or messages older than the sweep age |
| `tombstone_no_entry` | error | A tombstoned session has no `tombstone` entry |
| `orphan_trace` | warn | Elsewhere, a trace object no metadata names is older than the sweep age (the sweep has not run yet); younger ones are fine |
| `change_key` | error | A key under `changes/` is not `<stamp>-<archive_id>-<suffix>-<hash\|tombstone\|visibility>.json` |
| `change_unreadable` | error | A change entry is not JSON or does not match `change.schema.json` |
| `change_mismatch` | error | An entry's owner, archive id, kind, hash or `at` is not its key's, or its `session_id` is not its session's |
| `change_no_session` | error | A tombstone or visibility entry names a session with no metadata |
| `change_orphan` | warn | A published entry names a session with no metadata (a first publish that failed after its entry, 19) |
| `change_not_applied` | warn | An entry announces what the session does not show: a tombstone of a live session, a last visibility entry the session does not have, or a published hash it does not list and no later `replace` took off |
| `span_unreadable` | error | A span record does not parse as `seshi/span/1` |
| `span_message_missing` | error | Span records name a message hash not stored under `spans/messages/` |
| `span_message_unnamed` | warn | A stored message older than the sweep age is named by no span record |

The tests build a healthy bucket through the real pipeline (a publish and its chunk, a
visibility change, a tombstone, a stub, a stub continued by a chunk, an assembled OTLP session
whose spans share a stored message, a token) and corrupt one thing at a time, on the folder
store and on an `S3Store` over the writable `FakeS3`.

## Deviations and why

1. **A schema checker in `@seshi/model`, generated from spec/.** The brief expected the model
   package to have validators; it had none for metadata, changes or the marker. Hand-writing
   one would drift from the schemas; ajv is a dev dependency only and would put a schema
   library in the binary. Emitting the schemas as data from the existing generator keeps one
   source, and the ajv comparison keeps the interpreter honest.
2. **A `store` command, not a `redact` subcommand.** The registry is by group, and the command
   is `seshi store check`; `redact` is F2's (rules, backfill, and the sweep that deletes what
   they leave). A bucket check is about the layout, and a `store` group leaves room for others.
3. **The CLI opens the store itself, not through `openServer`.** `buildInstance` with
   `initialize: false` still runs `ensureLayout`, which records the config's org in a marker
   that has none (a write), refuses a bucket with no marker before anything is checked (the
   checker reports it as `marker_missing`), and reads the redaction packs and builds the
   reviewer, which a check needs neither of. It loads the server config the same way and opens
   the store with the same `storeOptions`.
4. **Change entries for a session that does not exist split by kind.** A published entry with no
   session is what 19's failed first publish leaves (entry written, pointer never created,
   object removed), so it is `change_orphan`, a warning. A tombstone or visibility entry is
   only written for a pointer that exists, and pointers are never deleted, so with no session it
   is `change_no_session`, an error.
5. **Kind disagreements are warnings; missing entries are errors.** Every way an entry can
   disagree with its session now is also what a write that failed between its entry and its
   pointer leaves, so `change_not_applied` is a warning. The converse cannot happen under 19
   (no change without its entry), so `publish_no_entry` and `tombstone_no_entry` are errors.
   "Were in `traces`" is judged by a later `replace` entry of the session (a replace or a
   backfill); within one millisecond keys sort by suffix, not write order.
6. **The total does not always match `normalized.records`.** A later envelope that model review
   dropped moves the log past its records without a trace (04, 20), so the next continuation
   starts past them and the last trace can end before `normalized.records`. Such a gap is no
   finding when `applied` has a `dropped` entry whose `records_total` is where the gap ends;
   otherwise it is `chain_gap`, a warning (the drop may have fallen out of the last 16). More
   records than `normalized` says is `chain_total`, an error. After a `chain_break` the rest of
   the chain is not judged, so one break is one finding. spec/layout.md now states this rule.
7. **Old trace objects in a stub or a tombstoned session are errors**, as the brief has it, while
   elsewhere they are `orphan_trace` warnings. A tombstone stopped mid-delete leaves them, which
   the sweep removes, but they are content of a session that should hold none.
8. **More than the brief listed**, from spec/layout.md: the pointer's identity against its key,
   each trace object's content hash recomputed with `parseTrace` (and its count and
   continuation), change entries against their keys, the inverse of entry-before-pointer
   (`publish_no_entry`, `tombstone_no_entry`), a stub's content and log state, a tombstoned
   session's span objects, span records that do not parse, the sessiondb marker. The age guard
   also applies to unnamed span messages (written before the record that names them) and to a
   tombstoned session's span objects.
9. **`format_version_missing` is a warning; it found a real gap, fixed here.** A stub continued
   by a chunk recorded no format version: the chunk kept the session's version (21) and a stub
   has none (20), so the session counted as stale for ever and its uploader resent it whole at
   every format bump. A chunk to a stub now takes the current normalizer (`pipeline.ts`, the
   chunk path), since review dropped everything before it. The healthy bucket in
   `tests/store/check.test.ts` checks with no findings at all, which guards the fix.
10. **`readTraces`** (default true) is an option the brief did not ask for: re-hashing every
    trace is the most expensive part, and a quick check of presence only is useful on a large
    bucket or between scenario steps. The CLI always reads them.

## Extension points

- **The scenario runner** calls `checkStore(store)` after each step and expects no `error`
  findings (and whichever warnings the step should leave); `sessions` scopes it to what a step
  touched, `now` and `minAgeMs` make the age guard deterministic.
- **A new invariant** is a code in `FINDINGS` (severity fixed per code), a check in `Check`, a
  row above and a corrupt-one-thing test in `tests/store/check.test.ts`.
- **A new stored object others read** gets `schemaProblems` for free once its schema is in
  `spec/schemas/` and `bun run types` has run.

## Still to check

- **Cost on a large bucket.** It reads every metadata object, change entry, span record and
  named trace object (gunzipped and re-hashed), and lists every session folder with details.
  Not measured on a real bucket. On the folder store each listing walks the folder below the
  prefix, as for every caller. `readTraces: false` and `--owner` narrow it; the CLI has no flag
  for the first.
- **Live S3.** Checked against the folder store and the S3 fake only; R2, MinIO and AWS listings
  (`LastModified`, the U+10FFFF step past a folder) are as unchecked as for 23's sweep.
- **Not checked yet:** `review/<n>.json` records; `assembly/pending/` markers (one for a session
  that is tombstoned or has no span records); `sources/` (checkpoints, drop and failure records,
  health shards), `worker/heartbeat.json`; that a span message's bytes hash to its key (only
  presence is checked); `applied` at most 16 entries; owner folders whose names are not owner ids
  (`listOwners` skips them, so they are not reported); the marker's deployment id and org
  against the config (the server refuses to start on a mismatch, so the CLI does not compare).
- **Clock skew.** Ages come from the store's clock and are compared with the checker's, as for
  the sweep: a checker clock far ahead turns young objects into old ones.
- CI has not run (no PR).

## Tests

- `tests/store/check.test.ts` (48: 24 on each store): the healthy bucket checks clean (but for
  deviation 9's warning) and the check writes nothing; a mid-session drop explained by `applied`
  is no gap; then one corruption each: head object deleted; a listed trace deleted and a head
  not in traces; a broken continuation; a chain not starting at the dropped prefix; a gap and a
  total past `normalized`; a stub with traces, content and no log state; old trace objects in a
  stub and a tombstoned head; an orphan old (warn) and young (nothing), and with no metadata;
  change entries for a session that does not exist (tombstone error, published warn); a bad
  change key, bad JSON entry and an entry naming another owner; a deleted published and
  tombstone entry; a tombstone entry for a live session (warn); a span naming a missing message,
  an old unnamed message and a span that is not one; a tombstoned session's old span object;
  metadata that is not JSON, off-schema, or naming another owner; a trace object that is not
  gzip and one whose records changed; no format version; marker missing, foreign, legacy,
  unreadable; an empty bucket; a bad token record whose content is not echoed; scoping by owner
  and session; a failing read becomes `read_failed` and the rest is checked.
- `apps/seshi/src/commands/store.test.ts` (6): clean bucket text and `--json`, exit 0; a missing
  head exits 8 with the finding under its session, `--json` too, and `--owner` narrows it;
  warnings alone exit 0; an unused bucket is not claimed (no marker written); local mode's bucket
  from the CLI config's `[local]`, and `--config` over it; `--help`, usage errors, an unusable
  store URL (exit 3).
- `tests/spec/schemas.test.ts` (+21): `schemaProblems` finds nothing wrong with the 12
  conformance objects and agrees with ajv on every one-field change to the 9 metadata, change and
  layout examples.
- `commands.test.ts`: the registry lists `store`.
