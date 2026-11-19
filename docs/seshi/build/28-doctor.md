# 28 · The session doctor

Branch `seshi-28-doctor`, on `seshi-27-security-fixes` (2228fd5). A developer tool that checks
that agent sessions are captured right, end to end, and the engine a later branch's local web
UI (`seshi explore`) will use. User docs: docs/cli.md (the `doctor` row) and
[docs/capture.md](../../capture.md#checking-a-session).

A session has three views: (a) the raw transcript on the laptop; (b) the laptop's capture state
(the state file's entry, the decision and why, offsets, a pause's stop, the toggle and
retraction, a rebuild, the spool, errors and retries, the uploader's log); (c) what the server
or bucket stored (metadata with `normalized`, `dropped_prefix`, the `traces` chain, head,
status, normalizer and redaction, the retraction hash, visibility; review decisions, change
entries and search). Only the laptop holds all three, so the doctor runs there.

## What was built

- **The engine, `apps/seshi/src/doctor/`.** Two steps, both pure apart from the loaders they
  are handed:
  - `gatherEvidence(target, deps, { deep }) → SessionEvidence` (`evidence.ts`): everything known
    about one session, as plain JSON. Anything it cannot fetch is recorded where that part
    would be (`machine.state_error`, `transcript.error`, `server.error`, `metadata_error`, a
    trace's `error`, `reviews_error`, `changes_error`, `search.error`), never thrown.
  - `runChecks(evidence, deps) → CheckResult[]` (`checks.ts`), each check also exported on its
    own. `CheckResult` is `{ id, title, status: "ok" | "warn" | "fail" | "skip", summary,
    detail?, hint? }`; `worst()` and `SEVERITY` order statuses.
  - `DoctorDeps` (`deps.ts`): `now`, `state` (the state file), `judge` (`decide` with
    `stateFacts`, `otherFolders`, the CLI config's rules and the folders' repos, as every caller
    builds it), `agent` (format, encoding, chunkable, `identify`, `locate`), `files` (`stat`,
    `read`), `spool`, `log`, `uploaderRunning`, `server` (a `ServerView`) or `serverError`,
    `normalizer` (`records`, `version`, `stale`) and `redaction` (`rule_set`, `origin`,
    `transcript` for the uploader's pre-redaction, `records` for the server's redaction stage,
    `residue`). Tests fake every one.
  - `server.ts` `serverView(backend)`: the read-only view over 13's `Backend`, so the doctor
    works against a server (`ServerBackend`) and in local mode (`LocalBackend`). Beyond the
    `Backend` interface (left unchanged) it reads the change feed (the HTTP client's
    `changes`, or the bucket's) and, in local mode only, the stored pointer itself, so a stub
    can be seen.
  - `real.ts` `realDeps(ctx, { paths, backend?, backendError? })`: the loaders on this machine.
    The redaction rules are the ones the uploader last fetched from that server
    (`redaction-rules.json`), else the built-in pack, with pre-redaction as the uploader does
    it; in local mode, the Instance's own rules and no pre-redaction (its sink has none).
    `residueOf(rules, records)` runs the rules record by record, carrying withheld calls as the
    pipeline does, and reports a record the rules would still change, with the rules that
    fired and never what they matched. The rules are idempotent on what they wrote, so a
    stored record that changes holds something they redact now.
- **`seshi doctor [--session [<id>]] [--agent <a>] [--since <duration>] [--deep] [--server
  <url>] [--json]`** (`apps/seshi/src/commands/doctor.ts`, registered in the command
  registry, `--help` through `helpOrUsageError`). `--session` resolves as `seshi capture` does
  (`resolveSession`: the id, `SESHI_SESSION_ID`, else the one session seen in this folder in
  the past day). Without it, every session the state file saw since `--since` (1 day), newest
  first: one line each with its worst status and the first check at that status, then
  "Failed checks:" with their detail and hints. One session prints a line per check: a status
  word padded before painting (B1.4: the word carries the meaning, colour follows `NO_COLOR`,
  `--no-color`, a terminal), the title, the summary, and for warn and fail the detail and
  hint. Everything it did not write goes through `printable`. `--json`: `{ sessions: [{
  agent, session_id, evidence, checks }] }`, the stored traces' records left out (`forJson`).
- **Tests** (vitest; no external service): `apps/seshi/src/doctor/doctor.test.ts` (42: every
  check passing and failing, with fakes for every loader; `gatherEvidence` gathering the three
  views, the secret only as a hash, errors recorded, the upload id before a retraction),
  `apps/seshi/src/doctor/real.test.ts` (6: `residueOf` over the built-in pack, withheld
  results included; pre-redaction only where the uploader does it; the flags; `forJson`), and
  `tests/capture/doctor.test.ts` (8, end to end against a served Instance with the org key):
  a captured session with a continuation passes every check and is found by `--deep`
  search; a session whose metadata was deleted from the bucket fails presence (exit 8, and in
  the overview); a secret planted in the stored trace fails residue, naming
  `github-token` and the record, the secret appearing in no output; a session turned off and
  retracted passes (and is not found by search), and again once turned on as `<id>~1`; a stub
  left by a review drop (a fake provider through a real `ModelReviewer`) passes; the doctor
  writes no state, adds no spool entry, starts no uploader and only sends GETs; bad usage,
  `--help`, and a server gone (exit 7, presence skipped, local checks still run); local mode
  reads pointer, traces and change feed from the bucket. The doctor's unit tests are in the
  laptop selection (`vitest.laptop.config.ts`).

## The evidence model (for `seshi explore`)

`SessionEvidence` (`types.ts`, schema `seshi/doctor-evidence/1`):

| Field | What |
|---|---|
| `at`, `agent`, `session_id`, `key` | When it was gathered; the capture agent, its id, the state file's key |
| `machine` | `state_error`, the pause in force, `problems` (sign in, upload failing), `uploader` (the state's summary plus `running`) |
| `local` | The state entry as it is (offsets, `frozen`, toggle, `retract`, `generation`, `rebuild`, `error`, `next_attempt_at`, `held_at_size`, `shipped`, …) with `secret` replaced by `{ present, sha256 }` |
| `parent` | A subagent's parent id and whether the state knows it |
| `decision` | `decide`'s answer now: `capture`, `level`, `reason`, `frozen` |
| `capture` | The agent's `format`, `encoding`, `chunkable` |
| `transcript` | `path`, `exists`, `size`, `mtime`, `identified_as` (who the agent says the file belongs to), `error` |
| `spool.entries` | This session's spool entries: `name`, `kind`, `at`, `event` |
| `log.lines` | The capture log's lines (rotated file first) naming the session, last 50 |
| `server` | `mode` (`server`, `local`, `none`), `where`, `error`; `agent` and `upload_id` asked for; `metadata` (null: nothing shown), `pointer` (local mode, stubs included), `sees_stubs`; `retracted` (the upload id before the last retraction and its metadata); `traces[]` (`content_hash`, `listed_records`, `rule_set`, `continuation`, `fetched`, `record_count`, `starts_with_meta`, `stored_hash`, `records`, `error`); `reviews`; `changes` (this archive's entries since its creation); `search` (`--deep`: `upload_id`, `expect` found or absent, `term`, `term_from`, `found`, `results`, `index_caught_up_at`) |

A UI can render every field as it is, call `runChecks` for the verdicts, and re-gather one
session cheaply; nothing in the evidence is derived from another field except `decision`.

## The checks

| Check | ok | warn | fail |
|---|---|---|---|
| `decision` | Always, with the level and reason (capturing, off, paused, stopped at N, excluded by which rule) | | The state file cannot be read |
| `transcript` | There, readable, the agent says it is this session's, offsets and a pause's stop within its size | Shrank below what was sent or held, a pause's stop past its end, moved from where offsets were taken, gone after it was stored, no path named yet | Another session's (or not recognised: the uploader refuses it), unreadable, gone before anything was stored |
| `queue` | Nothing waiting; bytes waiting on a running uploader; a rebuild due or waiting (with `not_before`); held as too small | Hook entries older than 10 minutes with no uploader; bytes unsent 30 minutes after the last change with no uploader; a retry in backoff; a retraction pending; machine problems (sign in, uploads failing); a permanent refusal for an older size | A permanent refusal for this size; a refused retraction |
| `presence` | Sent and stored → head present; turned off or retracted → absent or tombstoned (the previous upload id); filtered → nothing; review-dropped first envelope → a stub (seen in local mode, inferred from a server, which serves none); nothing sent → nothing stored | The server holds a session this machine never sent, or one no answer reported | Stored here but absent there; turned off or retracted but a trace still there; tombstoned there but not retracted here; filtered here yet stored; no stub where local mode should see one |
| `secret` | The local secret's hash is the stored `retract_hash` | Stored without a retraction hash | Another hash (a retraction would be refused); sent with no secret kept |
| `offsets` | `normalized.bytes` = the laptop's `server_offset`; aligned offsets equal; nothing sent past the pause's stop | | Any of those disagree; `dropped_prefix` longer than the log; the last answer's records or prefix differ from the stored ones |
| `records` | The transcript up to the server's offset (mapped back through the laptop's offsets when pre-redaction changed lengths), pre-redacted and normalized by the current adapter, has `normalized.records` records (the meta record and any dropped prefix count on both sides) | The counts differ and the session is stale | The counts differ under the current adapter; the adapter cannot read the transcript; a dropped prefix longer than the log |
| `prefix` | The same records, through the server's redaction stage, hash to `normalized.prefix_sha256` | The hash differs and the session is stale | The hash differs under the current adapter |
| `chain` | The head is the last trace, every trace is fetched with its listed record count and hash, continuations follow on (the first from `dropped_prefix.records`), the total is `normalized.records`; a stub has none | Records in no trace that no dropped envelope explains | A trace not fetched, a hash or count that differs, an overlap, a head missing or not last, more records than the metadata counts, a stored session with no trace |
| `residue` | No rule matches a stored record | | Any match: the rule and the trace and record index, never the text |
| `staleness` | Built with the current `format_version` | Stale, saying whether a rebuild is due, waits until `not_before`, was already sent for this version, or the uploader will ask | |
| `changes` | A `published` entry for the head (a tombstone for a deleted session) | | Missing |
| `search` (`--deep`) | Found by the longest word of the last stored record; a deleted session not found by a word of its transcript | Not found, and the index has not caught up with the session's last change | Not found by a caught-up index; a deleted session still found |

`skip` always says why: no server (with the reason), nothing stored, a stub a server does not
show, a different rule set (the prefix), the record counts already differ (the prefix), no
transcript, the server's offset cannot be mapped back, a search with no term or a 503 while
the index builds.

## Deviations and why

1. **The engine lives in `apps/seshi/src/doctor/`, not a package.** It needs the `Backend`
   (server or local mode), the capture-agent registry and the format registry this binary is
   built with, all of which live in the app; a package would have needed them passed in from
   above anyway, and `seshi explore` will be a command of the same app. No layer changes.
2. **`Backend` is unchanged.** `serverView` reaches past it where a `Backend` hides what the
   doctor needs: the change feed (`HttpSessionDB.changes`, `readChanges` on the bucket) and,
   in local mode, the raw pointer.
3. **A stub cannot be seen through a server.** `GET /v1/sessions/:agent/:id` answers 404 for a
   stub (20), and the only routes that find one change something. Against a server, presence
   accepts a stub from the laptop's side (stored with a last answer of `dropped`); local mode
   checks the pointer. No new route was added.
4. **Records and the prefix hash are two checks.** A UI can show the count agreeing while the
   hash is not comparable. The prefix is compared only when the session's `redaction.rule_set`
   and every trace's `rule_set` equal the local rule set; a session written across a rules
   change is skipped. Both warn instead of fail when the session is stale.
5. **Added checks:** `secret` (the local secret against `retract_hash`: a mismatch means a
   retraction would be refused) and `changes` (the head's publish or the tombstone is in the
   feed search and readers follow). Review decisions are gathered but nothing checks them yet.
6. **Residue fails even when the stored rule set differs from the local one.** A secret stored
   is a secret stored; the detail says the sets differ, and the hint points at backfill.
7. **Machine problems** (sign in, uploads failing) warn in every session's `queue` check rather
   than fail: they are not the session's own.
8. **`decision` fails when the state file cannot be read** (the task said always ok): nothing is
   captured then. The command itself exits 3 before checking in that case.
9. **Exit order:** not being able to ask the server (not signed in 5, config 3, unreachable 7, a
   refused credential 5) comes before 8, since the result is incomplete; the local checks still
   run and print. `--since` with `--session` is a usage error.
10. **`--json` leaves out the stored traces' records**, which `seshi sessions export` prints; the
    evidence the engine returns keeps them for the UI.
11. **"Changes nothing"** holds for capture's state, the spool and the server: the doctor sends
    only GETs. Opening the backend does what `seshi sessions` does (a credential refresh; in
    local mode, opening the Instance), and `--deep` in local mode brings the local search index
    up to date before searching, as `seshi search` does.
12. **Test tooling:** `startServer` (tests/tooling/cli.ts) takes a `reviewer`, so an end-to-end
    test can make a real review drop with the fake provider.

## Still to check

- Not run against a real server, real agents or Windows. Codex and Cursor sessions go through
  the same code, but only Claude Code transcripts were checked end to end.
- `records` assumes the adapter normalizes a log whole to the same records as chunk by chunk
  (held for Claude Code here). A format where it does not would fail `records` on chunked
  sessions; that would be a pipeline finding as much as a doctor one.
- `prefix` emulates pre-redaction with the cached rules; a withheld tool result whose call is in
  an earlier chunk was not exercised through the doctor end to end (the residue unit test covers
  withheld results).
- `chain` treats a continuation trace's leading meta record as a repeat (true for a session that
  grew and for a stub's first trace); a fork's first trace was not exercised.
- Cost: the doctor reads each transcript up to the server's offset, fetches every trace, and
  reads up to 5000 change entries since the session's creation. Fine for a day's sessions;
  `--since 30d` over many large sessions is slow.
- Not checked yet: visibility against a repo's `.seshi/config.toml`, review decisions against
  `applied`, subagents against their parent's toggle beyond what `decide` says, and the
  status line's words against the doctor's.
