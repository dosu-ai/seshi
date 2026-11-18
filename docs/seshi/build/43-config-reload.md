# 43 — Config reload

F1.5, revised 17 Nov 2026: ADX connects buckets and edits the org's redaction rules in its own
admin UI, and those edits have to reach a running seshi. Sources lived in `seshi.toml` and
rule packs were read once, so both waited for a restart. This branch keeps the files as the
source of truth and applies them without one.

## What it built

- **One reload path, three triggers.** `Instance.reload(trigger)` in `@seshi/instance`
  (`reload.ts` for the comparison and the report). `seshi serve` calls it on `SIGHUP`, the API
  on `POST /v1/admin/reload`, and `server.watch_config` (default off) on a change to the file,
  a drop-in or a rule pack, debounced by a second (`apps/seshi/src/commands/config-watch.ts`).
  Reloads are chained on one promise, so they run one at a time, in the order asked.
- **All or nothing.** The instance gets a `loadConfig` closure from `openServer`: the same
  file, drop-ins, env and flags as at start-up. A reload loads that, runs the cross-section
  checks (`serverConfigProblems`, extracted from the schema's `superRefine`) on the config it
  would run, compiles the rule packs (`readRedactionPacks`, test strings included) and builds
  the reviewer. Only then does anything change. A failure is the
  report's `errors`; the running config, rule set, jobs and generation stay.
- **Sources by id.** `diffSources` compares the canonical form of each source (secrets as a
  hash of their value, so a rotated key counts as a change). Removed and changed sources'
  pollers are unregistered first (`JobRunner.unregister`: each job now has its own abort
  controller; the run is aborted and waited for, up to 10s), then `Sources.update` takes the
  new list, `Auth.setSources` the new ids (a writing service token acts for a configured
  source, X5.4), and pollers are registered for added and changed sources that are polled.
  Checkpoints are the store's and nothing in the reload path writes or deletes one.
- **Rule packs.** `Pipeline.setRedaction` swaps the redactor. The redactor is taken once per
  write: `planned` puts it on the `Run`, and every redaction step of that write uses
  `run.redactor`, so a write that began before the swap is stored with the old rule set and
  its `redaction.rule_set` says so. Span batches take it once per batch. `instance.redaction`
  is a getter, so `GET /v1/redaction/rules` serves the new packs and `ETag` at once.
- **Review prompts.** The reviewer is built on every reload, which reads each policy's
  `prompt_file` again (it calls no model). It replaces the running one when `[review]` changed
  (a rotated key file counts: secrets compare by value) or when the policies' hashes differ;
  `policyHash` covers the prompt text, so an edited prompt file alone is a change and the new
  `policy_hash` shows in review decisions from then on. A reviewer handed to the instance
  that does not list its policies is replaced only when `[review]` changes. Prompt files are
  watched with `watch_config`.
- **Restart-only settings.** `RESTART_ONLY_SECTIONS`: `server`, `store`, `auth`, `limits`,
  `search`, `worker`. The config a reload applies is the file's with these sections taken from
  the running config (`effectiveConfig`); the leaf paths that differ are `restart_required`,
  logged as warnings and kept in the status until a later reload. Chosen over rejecting the
  whole reload so that ADX's source edits are not blocked by an operator's pending change to,
  say, `server.listen`. Live: `sources`, `redaction`, `review`, `filter`,
  `default_visibility`, `records`, `capture`. To make `records` and `quiet_period` live, the
  job host's `config` is a getter and the retention job reads `[records]` at each run.
- **Status.** `GET /v1/admin/reload` (`Instance.configStatus()`): `generation` (1 at start,
  +1 per applied reload), `config_hash` (sha256 of the canonical config), `rule_set`, `review_set` (sha256 of the
  review policies' `[id, hash]` pairs, so a prompt-file edit shows; null for an injected reviewer),
  `loaded_at`, `reloadable`, `restart_required`, `last_reload`. `POST` answers
  `{reload, config}`; 422 `reload_rejected` with the same body when rejected; 409
  `not_reloadable` when the server started with no config file. `/v1/admin/sources` stays
  read-only. `@seshi/client` has `reload()` and `configStatus()`.
- **Drop-ins.** `loadServerConfig` reads `seshi.d/*.toml` beside the file, in name order
  (`DropIns` in `LoadOptions`, `ConfigFs.list`). A drop-in may only append to `[[sources]]`
  and `redaction.packs` (`DROP_IN_LISTS`); anything else is a `ConfigError` naming the file.
  Origins point at the drop-in, so `config show --origin` and error messages name it, and the
  literal-secret permission warning covers drop-ins too.

## Why not a mutable sources API

`PUT /v1/admin/sources/:id` would make the server hold a second, writable copy of part of its
config (in memory or in the bucket), which F1.5's "the config is the operator's" exists to
avoid: the config holds connector credentials or references to them, `config check` and
`config show --origin` read files, and a restart must not lose or resurrect an API-made
change. Reload plus drop-ins gives ADX the same result (it writes `seshi.d/adx-<bucket>.toml`
and calls `POST /v1/admin/reload`, getting validation errors back synchronously) while the
operator can still read, version and override everything it wrote. Nothing in the code pushed
the other way: sources were already immutable values keyed by id with checkpoints in the
store, so swapping the list was enough.

## Watch off by default

`SIGHUP` and the endpoint apply a change when the writer says it is complete and tell it the
result. A watcher sees editors' partial saves and multi-file edits (a source and the pack it
needs) halfway; with all-or-nothing reloads that is a noisy rejection, or worse, a valid but
unintended intermediate state applied. It is there for deployments whose files are swapped
atomically (Kubernetes ConfigMaps) and nothing calls the API.

## Tests

- `packages/ts/instance/src/reload.test.ts`: add, change and remove sources with checkpoints
  kept (and read on from after a remove and re-add); a removed source's running poll aborted
  and waited for; enable/disable; a service token for a source added by reload; drop-ins;
  rejected reloads (bad TOML, duplicate ids, a pack that does not compile, a source reading
  the running bucket once restart-only sections are applied) keep generation, hash, rule set
  and pollers; an edited pack redacts the next write while a write held in review keeps the
  old rule set; an edited review prompt file alone swaps the reviewer, and a missing one is
  refused; restart-only settings listed and not applied; concurrent reloads serialized.
- `packages/ts/instance/src/jobs.test.ts`: `unregister`.
- `packages/ts/config/src/drop-ins.test.ts`: order, origins, refused keys, unique ids,
  literal-secret warnings.
- `apps/seshi/src/commands/reload.test.ts`: a real `seshi serve` process: `SIGHUP` after a
  pack edit changes `GET /v1/redaction/rules`' `ETag`; a drop-in source through
  `POST /v1/admin/reload`; a broken file refused with 422; the process never restarts.
- `apps/seshi/src/commands/config-watch.test.ts`: one call per burst of changes, none for
  other files, `seshi.d/` appearing, a drop-in renamed into place after re-arming. Re-arming
  keeps the folders already watched, so a change that lands while a reload re-arms is not lost
  (found by hand: closing and reopening every watcher dropped a pack edit made just before a
  `SIGHUP`).
- `tests/api/openapi.test.ts`: both routes against `spec/openapi.yaml`, every documented
  status.

## Checked by hand

A `seshi serve` from a scratch folder, one process throughout: a session with `ORG-1234`
stored as is; the pack edited and `SIGHUP` sent, so the next session stored `[redacted:org-key]`
while the first kept its text, and the `ETag` of `GET /v1/redaction/rules` changed; an `s3`
source pointing at a folder added as `seshi.d/adx-evals.toml` and applied with
`POST /v1/admin/reload`, which polled it and stored its object redacted with the new rule; with
`watch_config`, a pack edit applied with no signal, and a broken pack refused (logged, 422-style
errors in the status) while the next write still used the running rules; `server.listen`
changed and the drop-in removed, then `SIGHUP`: the source stopped, its checkpoint stayed in the
bucket, `restart_required` said `server.listen` and the server kept its port.

## Still open

- macOS may report a file written just before the watch began, so a server started with
  `watch_config` can do one "nothing changed" reload at start-up. Harmless; not filtered.
- A `seshi admin reload` command (for operators without signal access to the process) would
  be a small addition over `@seshi/client`'s `reload()`.
