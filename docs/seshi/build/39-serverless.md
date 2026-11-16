# 39 · Serverless mode (F11)

Branch `seshi-39-serverless`, on `seshi-mvp`. The spec is [`../serverless.md`](../serverless.md);
this note says what was built, where the build differs from the spec, what was checked and what
is still open. The spec's eight build steps landed as commits on this one branch, not as eight
branches.

## What was built

**One mode (F11.1).** Local mode is serverless mode. The CLI config's `[serverless]` table
(`url`, `region`, `endpoint`, `account_id`, `owner`, `config`) replaces `[local]`, which is read as
its old name; `seshi config check --cli` prints the new table. `[search]` (`enabled`, `scope`)
is per machine. Every command that used local mode goes through `openServerless`
(`apps/seshi/src/serverless/open.ts`), which:

1. loads the laptop's config (the local file, `SESHI_*`, `--set`; `serverless.url` wins over
   the file's `[store]`),
2. opens the bucket with the key from `[store].credentials`, else the one `seshi init
   --serverless` stored (keychain name `bucket <url>`), else the environment,
3. reads the marker: none is exit 3 `no seshi bucket at <url>: run seshi init --serverless`;
   below `min_version` writes are refused and reads warn; a bucket in server mode warns,
4. loads the shared settings (`config/`, cached, checked),
5. builds the instance with `initialize: false`, `createLayout: false`, no source health and the
   laptop's records store, and
6. for writes, probes the owner's folder and runs the storage test when the cached result is
   over a day old.

**Marker schema 2 (F11.7).** `seshi/layout/2` adds `mode`, `min_version`, `mode_changed_at` and
`mode_changed_by`. Readers accept 1 and 2; a new prefix still gets schema 1 unless a mode is
given, so a server that only ever creates its bucket stays readable by older seshi. `setLayout`
upgrades 1 to 2 with `If-Match`. `spec/schemas/layout.schema.json` takes either schema value.

**Permissions (F11.4, F11.5).** `LocalBackend` (an in-process admin) is gone. `ServerlessBackend`
acts as a member of its owner: list, show, export, reviews and search apply the server's read
rule (`viewerFor` a member principal); `--include-private` on `sessions`, `search` and `explore`
uses `LOCAL_VIEWER`. A bucket `403` is `AccessDenied` in the store (`s3.ts` maps it on every
operation) and becomes exit 5 with a message that says which key it takes
(`serverless/refusal.ts`). Sessions record `owner_basis: "claimed"`; the ownership authorizer
now lets a `local` caller claim its owner, as an org-key caller could. Token commands say tokens
need a server.

**Laptop-only writes (F11.10, F11.11).** `Pipeline` and `Instance` take `records` (where drop and
failure records go) and `createLayout`. A laptop writes nothing outside `owners/<owner>/`; the
test `what a laptop writes` lists the bucket after an upload. `sync dropped|failed|prune` read
the laptop's records; `sync run|assemble|status` and `workers status` say they need a server.
Tombstones delete the span-assembly marker in `assembly/pending/` best-effort: a key limited to
its owner's folder may not touch `assembly/`, and without this a member could not delete their
own session on a per-folder key.

**Shared settings (F11.6).** `loadServerlessConfig` (config package) layers a parsed base below
the file (`LoadOptions.base`) and drops `[[sources]]` (OTLP intake included), `[auth]`, `[server]` and
`[worker]` from every layer and `[store]` from the shared one, reporting where.
`serverless/shared.ts` caches `config/` per bucket and refreshes at most every 5 minutes; a copy
that fails the checks (`readRedactionPacks` and the config's shape) is not used, and the last
good one stays with `problem` set. `seshi admin config pull|push` round-trips the folder;
push checks the files, refuses literal secrets, and writes with `If-Match` on the ETags pull
recorded in `.seshi-pulled.json` (exit 6 when the bucket's copy changed).

**Model review without a key.** `review.required` (default false). Required and a policy's key
cannot be resolved: opening for a write is refused with the spec's message, which the uploader
turns into a hold. Not required: the policy's model calls fail at once (`no_key`), with
`on_failure = "skip"` and no retries, so the session is stored and recorded as `skipped`.
`seshi review key set <provider>` stores a key that fills the provider's `{ env = "…" }`.

**Held uploads.** `SignInNeeded` carries a status word: `needs review key`, `needs update` or
`bucket refused` (no bucket, a key that cannot write its folder, a store that fails the storage
test). The status line, the desktop chip (through the status line), `capture status`, `upload`
(exit 3 for the first two) and `doctor` show it. The serverless sink reopens the bucket every 5
minutes, so a new shared config, minimum version or mode reaches a running daemon.

**The storage test** (`packages/ts/store/src/storage-test.ts`): the spec's six steps on
`owners/<owner>/.probe-<random>`, deleted at the end. `init` refuses a store that fails 1–4;
step 5 failing turns the sweep off.

**Daemon upkeep** (`serverless/upkeep.ts`, ticked every minute by `seshi daemon`, once by
`daemon --once`): search catch-up every `search.interval`, the owner's-folder sweep daily (only
when conditional deletes passed), record pruning every 6 hours, the storage test daily. Last runs
are kept in the bucket's state folder.

**Search (F11.9).** The indexer takes `owners` (scope `mine`) and `admit` (scope `visible`:
others' owner-only sessions are left out, and removed if one turns private). `seshi search`
reuses an index caught up within twice `search.interval` and says how fresh it is.

**Commands.** New: `seshi init --serverless`, `seshi admin mode|layout|config`, `seshi review key
set`. Changed: `sessions|search|explore --include-private`, `whoami`, `doctor` (a "Serverless
bucket" section: marker, owner, storage test, read access, shared settings, model review, search,
server-only settings), `capture status`, `sync`, `workers`, `store check` (opens the serverless
bucket), `login` (refuses in serverless mode). `seshi serve` and `workers status` warn on a
bucket marked serverless.

**Docs.** `docs/serverless.md` (setup, trust model, credentials per store, example AWS
policies, owner names, switching modes, what needs a server); `config.md`, `cli.md`,
`server.md`, `capture.md` and the README's quick start. X3.5, X5.6 and F8.3 in
`design-decisions.html` carry a "Revised (F11)" line.

## After an independent review

A review of the whole change found twelve problems; each is fixed, most with a test:

- A shared config this machine could not use (failed checks, no good copy before, or a lost
  cache) let uploads go out without the team's review and redaction settings. Writes now hold
  (`bad shared settings`), and a rejected copy is checked again after seshi is updated.
- `admin config push` missed literal secrets in sections laptops ignore (`[store.credentials]`,
  `[auth]`, sources); it now checks the whole file as a server reads it. `pull` refuses names
  with `..`.
- A shared config can no longer name paths outside `config/`, read a secret from a laptop's
  file, or receive a stored review key at an endpoint it names (the key goes only to the
  provider's own endpoint).
- `buildInstance` could record `store.org` in the marker from a laptop; serverless opens pass
  `claimOrg: false`.
- A `403` during an upload refused the session for good; it now holds uploads (`bucket
  refused`), as a refusal at open does.
- The storage test threw when a store answered a conditional delete with an error; it records
  the step as failed and goes on.
- A key that cannot read `config/` now holds writes instead of retrying as "unavailable".
- The sink's open is shared between the uploader and the upkeep timer; retraction opens the
  bucket on its own, so it does not wait on a review key or a newer seshi.
- `init` sets `scope = "mine"` for a key that reads only its folder, and `doctor` says so when
  the scope needs every owner's folder.
- `[otlp]` is not a server config section (OTLP intake is a source); the ignored sections are
  `[[sources]]`, `[auth]`, `[server]` and `[worker]`.

Known from the review and not changed: any S3 `403` counts as a refusal (an expired key or a
skewed clock holds uploads as `bucket refused`, which is the right outcome, with a less precise
message); a shared key still sends a harmless delete to `assembly/pending/` on tombstone.

## After a code review of the PR

A second review found ten more; each is fixed:

- **A `403` for an object that is not there.** S3 answers a GET or HEAD of a missing object with
  `403` when the key's `s3:ListBucket` does not cover it, and a grant limited by `s3:prefix` (as
  in the example policies) never covers a GET. On a `403` the S3 store now lists exactly that
  key: allowed and not found reads as missing; only a refused listing is a refusal.
- **Keys sent where a shared config says.** A shared review policy with a key may name no
  endpoint but its provider's; a laptop's own `serverless.config` still may. Before, any
  environment variable on a laptop could be sent to any URL.
- **A rejected shared copy** is remembered with a fingerprint of this machine's local file,
  `SESHI_*` settings and `--set`, and checked again when they change.
- **The serverless sink** keeps a replaced bucket open until the last job using it ends
  (`serverless/reopening.ts`), and the uploader and the upkeep timer share one sink.
- **Search** wipes an index built under another scope (the scope and owner are recorded in the
  index), and leaves out a hit whose live metadata the key may not read.
- **`sessions ls`** reads listings until a page holds `limit` readable sessions.
- **Model review without a key** marks the policy by id (`ProviderFactory` gets the policy's
  id), not with a made-up endpoint.
- **Shared settings refresh** takes ETags from the listing (S3 gives them) and sends a HEAD only
  when it does not; `admin config pull` uses the same listing and name check.

## Where the build differs from the spec

- **Review key references.** The spec allowed "a keychain name" as a secret reference. Built:
  references stay `{ env = "…" }`, and a key stored with `review key set` fills the variable.
  No new reference kind in the config package.
- **Shared settings refresh** lists `config/` and compares ETags, then downloads what changed; it
  does not send `If-None-Match` on GET (the store interface has no conditional GET).
- **Records path** is per bucket: `<state>/serverless/<bucket id>/records/sources/upload/…`.
- **`seshi init`** asks for `--owner` when it cannot name one from `user` or the OS user, rather
  than falling back to `local` as opening the bucket does.
- **Turning search off** does not delete the index file yet.
- **Scenarios** are vitest tests over a permission-enforcing store
  (`apps/seshi/src/serverless/team.test.ts`) and the CLI (`tests/cli/serverless.test.ts`), not
  YAML scenarios in `tests/scenarios/`. A minimum version raised while a daemon runs is covered by
  the 5-minute reopen, not by a test of a running daemon.

## Checked

- `bun run check` and `bun run typecheck`.
- The full `bun run test` (see the PR for the count at the tip).
- New tests: marker schema 1/2, `setLayout`, `NoLayout`, versions (`marker.test.ts`); the storage
  test against stores that ignore each condition (`storage-test.test.ts`); two laptops on one
  bucket with member, read-own and admin keys, the visibility rule on every read path,
  `--include-private`, refusals as messages, `min_version`, server mode, settings precedence,
  ignored server-only sections, a bad shared copy, the review-key hold, `review key set`, skipped
  review, and laptop-only writes (`team.test.ts`); `init --serverless`, `admin mode|layout|config`,
  held uploads, doctor's bucket section, `sync` and `workers` (`tests/cli/serverless.test.ts`);
  the existing local-mode tests moved to serverless (`tests/instance/serverless-mode.test.ts`,
  the capture, doctor and explore suites).
- By hand, with a `file://` bucket and a throwaway home: `init`, `whoami`, `admin mode|layout`,
  `config pull|push`, `upload` held by `min_version` and by a missing review key, `doctor`.
- `bun run check:hook` is unchanged: the hook still only spools.

## Still to check

- **Real stores.** The storage test runs against RustFS in CI (`tests/store/s3-live.test.ts`);
  nothing ran against AWS S3 or R2. R2's `If-Match` on DELETE is still untested; the storage test
  decides per bucket.
- **The example IAM policies** in `docs/serverless.md` have not been tried against a real AWS
  account (the spec asked for that before publishing).
- **The two measurements** the spec asked for before building (search catch-up at 50 and 500
  owners; first-build download size) were not run. The daemon's catch-up is built regardless.
- **Whether reads below `min_version` should be refused too**: still reads with a warning.
- **The desktop chip** shows the new words through the status line; not looked at in the app.
