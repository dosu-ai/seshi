# Serverless mode (F11): spec

Status: built on `seshi-39-serverless`, on `seshi-mvp` (dosu-ai/sessiondb#20); the build note is
[`build/39-serverless.md`](build/39-serverless.md), which lists where the build differs from this
page and what is still open. The design sketch it came from is the "Serverless mode" artifact.

## What it is

A team runs seshi with no server. Each laptop's CLI runs the whole pipeline (normalize, redact,
filter, model review), writes its owner's sessions straight to one shared bucket, and reads and
searches the bucket the same way. The bucket keeps today's layout and stays the source of truth.

Serverless mode replaces local mode. One person with their own bucket is a serverless setup with
one owner; there is one code path for both.

**The trust model.** Laptops are trusted to redact and run model review as configured. Mistakes
are fixed afterwards by reprocessing (`seshi store check`, `seshi redact backfill`). Who may write
or read what is decided by the cloud account's permissions on the bucket, not by seshi. "Visible
only to its owner" is kept by the CLI and is not enforced unless the keys enforce it.

**Needs a server instead:** Datadog and S3 sources, OTLP intake, company sign-in (OIDC), redaction
a laptop cannot skip, enforced owner-only sessions with team sharing, one shared search index.

## Decisions

| | Decision |
|---|---|
| F11.1 | One mode. Local mode becomes serverless mode; `[local]` keeps working as an old name. |
| F11.2 | Laptops are trusted to redact and review. Safety comes from reprocessing, not prevention. |
| F11.3 | No sources, no OTLP intake, no OIDC in serverless mode. They need a server. |
| F11.4 | The bucket's permissions are the only roles. The CLI has no admin role of its own. |
| F11.5 | Reads apply the server's visibility rule in the CLI. `default_visibility` stays `"org"`. |
| F11.6 | Shared settings live in the bucket under `config/`, in the server config format, checked loosely. |
| F11.7 | The layout marker carries the mode and a minimum seshi version (layout schema 2). |
| F11.8 | A bucket may switch between server and serverless mode. We recommend one mode at a time. |
| F11.9 | Search stays on each laptop; each person turns it on or off in their own config. |
| F11.10 | Drop and failure records stay on the laptop that ran the pipeline. |
| F11.11 | Laptops write nothing outside `owners/<owner>/`. |

When this lands, these existing decisions change in `design-decisions.html`:

- **X3.5** (local mode is for one person who owns the bucket): local mode becomes serverless mode,
  for one person or a team.
- **X5.6** (only `seshi serve` holds bucket keys): in serverless mode every laptop holds a key, and
  the bucket's permissions decide what it can do.
- **F8.3** (team setups use the HTTP API): or serverless mode.

## Configuration

### The CLI config

A new `[serverless]` table replaces `[local]`. `server` and `serverless` are exclusive, as
`server` and `local` are today.

```toml
# ~/.config/seshi/config.toml
[serverless]
url = "s3://acme-seshi/seshi"        # SESHI_SERVERLESS__URL. s3://, r2:// or file://
region = "us-east-1"                 # as [store]: region, endpoint, account_id
owner = "alice"                      # SESHI_SERVERLESS__OWNER; else user, else the OS user
config = "~/.config/seshi/seshi.toml"  # optional: a local server config layered on top

[search]
enabled = true                       # this machine keeps a search index (F11.9)
scope = "visible"                    # "mine", "visible" or "all"
```

- `[local]` is read as `[serverless]`: `local.config` names a server config whose `[store]` gives
  the bucket, as today, and `local.owner` is `serverless.owner`. `seshi config check` says the
  name is old and prints the new table. No removal date.
- `url` (or `config` with a `[store]`) is required. With both, `url` wins and `doctor` warns.
- **The bucket key** is stored by `seshi init --serverless` in the keychain under a new
  credential purpose `bucket`, or in `credentials.json` with `keychain = false`. Without one, the
  store's usual fallbacks apply (`AWS_*`, `S3_*`, `R2_*`), as for a server.
- The CLI config schema (`spec/cli-config.schema.json`) gains `serverless` and `search`.

### Shared settings in the bucket (F11.6)

```
<prefix>/config/seshi.toml        server config format
<prefix>/config/packs/<name>.toml redaction rule packs it names
```

- **Precedence**, lowest first: built-in defaults, `config/seshi.toml`, the local file
  (`serverless.config`), `SESHI_*` env, `--set`.
- **Format.** Any server config key is accepted. Keys that need a server (`[[sources]]`,
  OTLP intake included, `[auth]`, `[server]`, `[worker]`) are ignored in serverless mode, with one warning
  from `doctor`, since a bucket that switches modes may keep them. `[store]` in the shared file
  is ignored: the laptop already knows where the bucket is. Secrets appear only as references
  (`{ env = "…" }`), never as values; `admin config push` refuses a literal secret. A key stored
  with `seshi review key set <provider>` fills a review policy's `{ env = "…" }` for that
  provider when the variable is unset.
- **Checking.** The same checks `seshi serve` runs at start (each pack's rules against its own
  test strings, review policy shapes). Not stricter. A shared config that fails them is reported
  by `doctor` and `capture status`, and the CLI keeps using the last good copy it cached.
- **Caching.** The CLI caches `config/` in its state folder with each object's ETag, and asks
  the bucket again at most every 5 minutes (the daemon's uploader reopens the bucket that
  often): it lists `config/` and downloads only when an ETag changed. When the
  bucket can't be reached it uses the cache; with no cache, commands that write fail and uploads
  wait in the spool.
- **Writing.** `seshi admin config push [<dir>] [--dry-run]` checks the files and uploads them
  with `If-Match` on the ETags it last read, so two admins can't overwrite each other unknowingly.
  `seshi admin config pull [<dir>]` downloads them. Writing `config/` needs a key that can write
  there.

## Layout changes

### Marker schema 2 (F11.7)

`seshi.json` gains two fields, as `seshi/layout/2`:

| Field | |
|---|---|
| `mode` | `"server"` or `"serverless"`: which mode the bucket is used in now |
| `min_version` | Optional. The oldest seshi that may write the bucket, as `0.10.0` |
| `mode_changed_at`, `mode_changed_by` | When and by which program the mode was last set |

- Readers accept schema 1 and 2. Schema 1 reads as `mode` unknown and no minimum version.
- Writers upgrade a schema 1 marker to 2 (with `If-Match`) when `seshi init --serverless`,
  `seshi admin mode` or `seshi admin layout` sets a field. `seshi serve` does not upgrade it on
  its own.
- A seshi built before this work checks the schema strictly and refuses schema 2 with its
  existing message (`seshi.json is "seshi/layout/2"; this seshi reads seshi/layout/1 (written by
  a newer seshi?)`). That is what keeps pre-F11 CLIs from writing a bucket with a minimum
  version, so the minimum version needs no other enforcement for them.
- `spec/schemas/layout.schema.json` gets a schema 2 definition; schema 1 stays for reading.

### What laptops write (F11.11)

Only `owners/<owner>/…`: sessions, traces, the change feed, review records, stubs, and the probe.
In particular, in serverless mode:

- Drop and failure records go to the laptop (F11.10), not `sources/upload/`.
- Source health is not written.
- The marker is never created by an ordinary command. A missing marker is an error that names
  `seshi init --serverless`.

`seshi store check` treats `config/` as a known part of the layout.

## Opening the bucket

Every command that opens the bucket in serverless mode:

1. Reads the marker. Missing: exit 3, "no seshi bucket at <url>: run seshi init --serverless".
2. Compares `min_version` with its own version. Older: writes are refused (exit 3, "this bucket
   needs seshi <min> or newer; you have <v>. Update seshi, then try again."); reads go on with a
   warning. The uploader holds uploads in the spool and the status line says `needs update`.
3. Compares `mode`. `"server"`: a warning that the bucket is in server mode and laptops should
   upload through the server (F11.8); nothing is refused.
4. Loads the shared settings (cache rules above).
5. Builds the instance with `initialize: false`, no health counters, and the laptop's records
   sink.
6. Runs the storage test when the cached result is older than a day (below).

## Identity and permissions (F11.4, F11.5)

- **Owner.** From the CLI config, as local mode does today. Stored sessions record
  `owner_basis: "claimed"`: nothing seshi controls checked the name. (Local mode records
  `verified` today; that changes.)
- **No in-process role.** The CLI acts as a member of its owner: it reads, writes and deletes its
  own sessions. For another owner's session (`--owner bob`) it tries what was asked, and the
  bucket decides. A refused request (`403 AccessDenied`) becomes exit 5 with "this key can't
  change owners/bob/…: that takes a key that can write every owner's folder."
- **The visibility rule.** List, show, export, search, explore and the change feed use the
  server's read rule (`viewerFor` with a member principal for the owner) instead of
  `LOCAL_VIEWER`: your own sessions and those visible to the org.
- **`--include-private`** on `sessions`, `search` and `explore` uses `LOCAL_VIEWER` instead. It
  isn't a permission: the docs say a key that can read the bucket can read every session.
- **Default visibility** stays `default_visibility = "org"`; a repo config's
  `visibility = "owner"` still narrows it.
- **Retraction** in serverless mode checks the session's retraction secret and tombstones it
  directly, as local mode does now (`capture.allow_retract` still applies).

## The storage test

Seshi relies on conditional writes. `seshi init --serverless` and `seshi doctor` test them, and
the daemon repeats the test daily. It runs on a fresh key beside the start-up probe
(`owners/<owner>/.probe-<random>`), so it needs no permission outside the owner's folder, and
deletes it at the end:

1. PUT with `If-None-Match: *` on the fresh key: must succeed.
2. The same again: must be refused with `412`.
3. PUT with `If-Match` on a made-up ETag: must be refused with `412`.
4. PUT with `If-Match` on the real ETag: must succeed.
5. DELETE with `If-Match` on a made-up ETag: the object must still be there.
6. DELETE with the real ETag: the object must be gone.

Steps 1–4 failing: `init` refuses the bucket and `doctor` fails, naming the missing feature
("this store ignores If-None-Match on upload; seshi can't use it"). Step 5 failing only turns off
the daemon's sweep (below), with a `doctor` warning. Results are cached per bucket in the state
folder.

## Model review without a key

- New setting `review.required` (default `false`).
- `true`, and a review policy's key can't be resolved on this machine: the uploader holds the
  session in the spool. The status line and desktop chip show `Session Capture ⏸ needs review
  key`; `capture status`, `upload` and `doctor` print:

  ```
  seshi: this team requires model review, and no key for anthropic is set.
  Sessions are kept on this machine until one is: nothing has been uploaded unreviewed.
    Set ANTHROPIC_API_KEY, or store a key with: seshi review key set anthropic
    Then check with: seshi doctor
  ```

  The env var name comes from the policy's `api_key = { env = "…" }`.
- `false`, and the key can't be resolved: the session is stored with regex redaction only and
  recorded as `skipped`, as `on_failure = "skip"` does today; `doctor` warns.
- `seshi review key set <provider>` stores a key in the keychain; it fills a policy's
  `api_key = { env = "…" }` for that provider when the variable is unset. New.

## Search (F11.9)

- `[search] enabled` in the CLI config decides whether this machine keeps an index.
  `seshi init --serverless` writes it from the shared config's `search.enabled`. Off: no index
  file, no downloads, no catch-up; `seshi search` exits 3 with "search is off on this machine:
  set [search] enabled = true in <path>". Turning it off deletes the index file.
- `[search] scope`: `"mine"` (only your sessions are downloaded and indexed), `"visible"` (the
  default: yours and the org's), `"all"` (also others' owner-only sessions; the same as
  `--include-private` on every search).
- The daemon catches up the index every `search.interval` while it runs. `seshi search` uses the
  index as it is when the last catch-up is within twice the interval, and catches up first
  otherwise. Results show how fresh the index is.
- The index file, its path and its rebuild rules are as today.

## Drop and failure records (F11.10)

- The pipeline's records sink becomes an instance option. In serverless mode it writes the same
  JSON records, per bucket, under
  `<state>/serverless/<bucket id>/records/sources/upload/{dropped,failed}/`.
- `capture status` and `explore` show them; `seshi sync dropped|failed` reads them in serverless
  mode.
- The daemon prunes them by `[records]` retention.
- Repeats are prevented as today, not by these records: a review-dropped first upload leaves a
  stub in the owner's folder; a dropped chunk moves the offset; a filtered session waits on the
  laptop until its log grows; a refused upload (`403`, `422`) waits until the transcript changes.

## The daemon in serverless mode

| Job | Every | |
|---|---|---|
| Uploads | as today | |
| Shared settings refresh | 5 minutes | `config/` with `If-None-Match` |
| Search catch-up | `search.interval` | Only with `[search] enabled` |
| Sweep of the owner's folder | 1 day | Trace objects nothing names, over an hour old. Only when the storage test confirmed conditional deletes |
| Record pruning | 6 hours | The laptop's drop and failure records |
| Storage test | 1 day | |

## Switching modes (F11.8)

- `seshi admin mode server|serverless` sets the marker's `mode`. Needs a key that can write
  `seshi.json`.
- `seshi serve` on a bucket marked `serverless` starts, and logs and reports in `workers status`
  that laptops may be writing it directly. Serverless laptops on a bucket marked `server` warn on
  every command and in `doctor`. Neither refuses.
- The docs give both procedures. To a server: start the server, `seshi admin mode server`, move
  laptops with `seshi login --server`, then remove their bucket keys. To serverless: stop the
  server, `seshi admin mode serverless`, `seshi init --serverless` on each laptop. Tokens and
  sources stay in the bucket, unused, while it is serverless.

## Commands

| Command | |
|---|---|
| `seshi init --serverless --url <url> [--owner <id>] [--key-from-env] [--admin]` | New. Tests the store, creates the marker (schema 2, `mode = "serverless"`) or checks it, stores the bucket key, writes `[serverless]` and `[search]` to the CLI config, runs `doctor`. `--admin` also pushes a starter `config/` when there is none |
| `seshi admin config push\|pull` | New (above) |
| `seshi admin mode server\|serverless` | New |
| `seshi admin layout --min-version <v>` | New. Sets or clears `min_version` |
| `seshi review key set <provider>` | New |
| `seshi sessions …`, `search`, `explore` | Apply the visibility rule; `--include-private` |
| `seshi whoami` | Prints mode `serverless`, the owner, the bucket |
| `seshi doctor` | New checks (below) |
| `seshi capture status`, status line, desktop chip | New states: `needs review key`, `needs update`, `bucket refused` |
| `seshi sync dropped\|failed` | Read the laptop's records in serverless mode |

## `seshi doctor` in serverless mode

- Mode and marker: schema, `mode`, `min_version` against this version.
- Owner: the owner name, and that the key can write `owners/<owner>/` (the probe).
- The storage test results.
- Read access: whether the key can list other owners' folders, which tells read-all from read-own.
- Shared settings: present, checked, cached copy age, ignored server-only keys.
- Model review: each policy's key resolves, and `review.required`.
- Search: enabled, scope, index freshness.
- Settings that need a server in the local config or flags (`[[sources]]`, including OTLP intake): an error,
  "needs a server".

## Docs

- New `docs/serverless.md`: setup, the trust model, credentials per store, example policies,
  owner names, switching modes, what needs a server.
- **Example policies (AWS S3):** member reading everything, member reading only their own folder,
  admin. Each one policy for everyone, with `${aws:username}`, and the
  `${aws:PrincipalTag/seshi-owner}` variant for when IAM user names and owners differ. Tried
  against a real account before publishing.
- **Owner names:** they're lowercased, and a name seshi can't use as a folder becomes a hashed
  `h-…` id; check with `seshi whoami` before naming keys.
- **Per store:** AWS S3 supports per-person folder keys. R2 tokens can be limited to buckets, not
  folders (only temporary credentials can be, and those need a trusted minter), so R2 gets a
  shared key or a bucket per person. Stores without conditional writes (Backblaze B2,
  DigitalOcean Spaces, Google Cloud Storage's S3 API) can't hold a seshi bucket; the storage test
  says so.
- Update README's quick start, `config.md` (`[serverless]`, `[search]`, `review.required`),
  `cli.md`, `server.md` (X5.6) and `capture.md` (status states).

## Tests

- **Unit:** marker schema 1 and 2 reading and upgrading; settings precedence; the member viewer
  on every read path; `--include-private`; `owner_basis: "claimed"`; the review-key hold;
  `min_version` refusing writes.
- **A permission-enforcing fake store:** wraps the in-memory store and refuses writes outside an
  allowed prefix with `403`, for every refusal path and message.
- **Scenarios** (`tests/scenarios/`): two laptops with different owners on one bucket; a laptop
  without a review key that gets one; `min_version` raised while a laptop is uploading; a mode
  switch; a shared settings change mid-run.
- **Live store test:** the storage test against RustFS in CI.
- `bun run check:hook` must not change: the hook still only spools.

## Before building

1. **Search cost.** Fill a local RustFS bucket with 50 and 500 fake owners and time a search's
   catch-up. Decides whether the daemon catch-up is in the first build or can follow.
2. **Download size.** One real person's sessions times the team size, for the first index build.

## Build order

Branches from `seshi-mvp`, each with its build note:

1. **Marker schema 2:** `mode`, `min_version`, reading 1 and 2, `admin mode`, `admin layout`.
2. **Serverless config:** `[serverless]`, `[local]` as its old name, the `bucket` credential,
   `seshi init --serverless`, the storage test, `owner_basis: "claimed"`.
3. **Permissions:** no in-process role, refusals as messages, the member viewer,
   `--include-private`.
4. **Laptop-only writes:** the records sink, no source health, no marker creation; `sync
   dropped|failed` from the laptop.
5. **Shared settings:** `config/`, precedence, caching, `admin config push|pull`, ignored
   server-only keys, `review.required` and `review key set`.
6. **Search:** `[search] enabled` and `scope`, daemon catch-up (if the measurement says so).
7. **Daemon upkeep:** own-folder sweep, record pruning, daily storage test.
8. **Docs and policies**, tried on a real AWS account.

## Out of scope

- Company sign-in (OIDC) in serverless mode: requires server mode.
- Per-person folder keys on R2.
- Sources, OTLP intake and a shared search index without a server.

## Still open

- Whether R2 honours `If-Match` on DELETE. Until tested, the storage test decides per bucket.
  This also affects the server's sweep on R2 today.
- Whether commands below `min_version` should refuse reads too, not only writes. This spec allows
  reads with a warning.
