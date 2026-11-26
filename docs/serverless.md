# Serverless mode (F11)

A team can run seshi with no server. Each laptop's CLI runs the whole pipeline (normalize,
redact, filter, model review) and writes its owner's sessions straight to one shared bucket,
under `owners/<owner>/`. It reads and searches the bucket the same way. The bucket keeps the
same [layout](../spec/layout.md) a server writes, and stays the source of truth.

One person with their own bucket is a serverless setup with one owner. Local mode, which was
that case, is now serverless mode; a CLI config with `[local]` keeps working
([below](#moving-from-local-mode)).

```
laptop: hook ─▶ spool ─▶ seshi daemon ─▶ normalize · redact · filter · review ─▶ owners/alice/…
laptop: hook ─▶ spool ─▶ seshi daemon ─▶ normalize · redact · filter · review ─▶ owners/bob/…
                                                                                      │
               the bucket (s3:// r2:// az:// gs:// …): seshi.json, config/, owners/ ◀─┘
```

## When to use it

Use serverless mode when a team wants seshi without running anything, and trusts its laptops.
Use a server ([server.md](server.md)) when you need any of these:

- Datadog and S3 sources, and OTLP intake;
- company sign-in through an IdP (OIDC);
- redaction a laptop cannot skip;
- owner-only sessions that other members really cannot read, with sharing between teams;
- one shared search index.

A bucket can move between the two modes ([below](#switching-modes)).

## The trust model

- **Laptops are trusted to redact and run model review as configured.** Nothing checks their
  work as it is written. Mistakes are fixed afterwards: `seshi store check` finds broken
  sessions, and `seshi redact backfill` applies new rules to stored ones. Both need a key that
  can read every owner's folder, and backfill one that can write them; backfill runs with
  `--config` naming a server config whose `[store]` is the bucket.
- **The bucket's permissions are the only roles.** seshi has no admin role of its own here. The
  CLI acts as a member of its owner: it reads, writes and deletes its own sessions. For anything
  else (another owner's session, the marker, the shared settings) it tries what was asked, and
  the bucket decides. A refusal is exit 5 with a message that says which key it takes, such as
  `this key can't change owners/bob/…: that takes a key that can write every owner's folder`.
- **Owners are claimed.** The owner comes from the CLI config, and nothing seshi controls checks
  it. Sessions record `owner_basis: "claimed"`. A per-person key (below) is what ties a laptop to
  its folder.
- **"Visible only to its owner" is kept by the CLI, not enforced.** Reads (`sessions ls`, `show`,
  `export`, `search`, `explore`, `doctor`) apply the server's rule: your own sessions and every
  `org` session. `--include-private` on `sessions`, `search` and `explore` shows owner-only
  sessions too. That flag is not a permission: a key that can read the bucket can read every
  session in it. `default_visibility` stays `"org"`, and a repo's `.seshi/config.toml` with
  `visibility = "owner"` still narrows it.

## Setting it up

### Just you

```sh
seshi init --serverless --url file:///Users/alice/seshi    # or s3://bucket/prefix, r2://, az://container/prefix, gs://bucket/prefix
seshi capture install
seshi upload --since 30d
seshi search flaky checkout test
```

For `s3://`, add `--region`; for `r2://`, `--account-id`; for `az://`, `--account-name` (the
Azure storage account); for another S3-compatible store, `--endpoint`. On a terminal, `init`
asks for the bucket's access key (for `az://`, the account key or a SAS token; for `gs://`, the
path of a service account's JSON key file; leave it empty to use the `AWS_*` or
`AZURE_STORAGE_*` variables, or for `gs://` Application Default Credentials, instead);
`--key-from-env` stores the one in the environment without asking (for `gs://`, the key file
`GOOGLE_APPLICATION_CREDENTIALS` names).

### A team

An admin sets up the bucket once, with a key that can write all of it:

```sh
seshi init --serverless --url s3://acme-seshi/seshi --region us-east-1 --admin
seshi admin config pull              # into ./seshi-config/
$EDITOR seshi-config/seshi.toml      # shared settings: redaction packs, review policies, search
seshi admin config push
```

`--admin` writes a starter `config/seshi.toml` when the bucket has none. `init` creates the
layout marker (`seshi.json`, schema `seshi/layout/2`, `mode = "serverless"`); a member's key
can't, so the admin goes first. The admin's laptop now writes with the admin key; to keep that
key off the laptop, run the `seshi admin` commands with `--config <file>` naming a server config
whose `[store]` has the admin key instead.

Then give each member a key (see [the policies](#example-aws-iam-policies)), and on each laptop:

```sh
seshi init --serverless --url s3://acme-seshi/seshi --region us-east-1 --owner alice
seshi capture install
seshi doctor
```

On each laptop, `init`:

1. runs the [storage test](#the-storage-test) in the owner's folder, and refuses a store that
   fails it;
2. checks the layout marker (or, with no marker, creates it, which only an admin key can);
3. stores the bucket key in the OS keychain, under the service `seshi` and the name
   `bucket <url>` (in `credentials.json` with `keychain = false`);
4. writes `[serverless]` and `[search]` to the CLI config, and removes `server` and `[local]`
   from it. `[search] enabled` is taken from the shared config's `search.enabled`, and
   `scope` is `"mine"` when the key can't list other owners' folders.

It does not run `doctor`; it ends by suggesting it. `seshi whoami` prints the mode, the owner
and the bucket.

## Owner names

The owner is `--owner` (`serverless.owner`), else `user` in the CLI config, else the OS user
name. seshi lowercases it. A name it can't use as a folder (one that does not start with a
letter or digit, or holds characters other than letters, digits and `. _ @ + -`, or is longer
than 128 characters) becomes a hashed id, `h-` and 20 hex digits.

The owner is the folder `owners/<owner>/`, and a per-person key names that folder. Run
`seshi whoami` on the laptop before you write a key's policy, and use the name it prints.

## The storage test

seshi relies on conditional writes. `seshi init --serverless` and `seshi doctor` test them, and
the daemon repeats the test daily. The test writes a fresh object beside the start-up probe,
`owners/<owner>/.probe-<random>`, so it needs no permission outside the owner's folder, and
deletes it at the end:

1. Upload with `If-None-Match: *` to the new key: must succeed.
2. The same again: must be refused (`412`).
3. Upload with `If-Match` on a made-up ETag: must be refused.
4. Upload with `If-Match` on the real ETag: must succeed.
5. Delete with `If-Match` on a made-up ETag: the object must still be there.
6. Delete with the real ETag: the object must be gone.

Steps 1–4 failing: `init` refuses the store, and `doctor` fails, naming the missing feature
(`this store ignores If-None-Match on upload`). Step 5 failing only turns off the daemon's sweep
of the owner's folder, with a `doctor` warning. The result is kept per bucket in the state
folder.

## Credentials

Each laptop holds a bucket key. The CLI uses, in order:

1. `[store].credentials` in the local server config `serverless.config` names, when it has them;
2. the key `seshi init --serverless` stored (keychain name `bucket <url>`);
3. the environment: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`, or the
   `S3_*` names, and `R2_*` for `r2://`, as for a server. For `az://`: `AZURE_STORAGE_KEY`,
   `AZURE_STORAGE_SAS_TOKEN`, `AZURE_STORAGE_CONNECTION_STRING`, then workload identity
   ([config.md](config.md#azure-blob-storage-az)). For `gs://`: Application Default
   Credentials, so `gcloud auth application-default login` is enough
   ([config.md](config.md#google-cloud-storage-gs)).

`init` stores a session token when the environment has one, but temporary credentials expire;
for those, store nothing and keep them in the environment.

What a key can be limited to depends on the store:

| Store | Per-person keys | Notes |
|---|---|---|
| AWS S3 (`s3://`) | Yes | IAM policies can limit a key to `owners/<owner>/`. See the examples below |
| Cloudflare R2 (`r2://`) | No | R2 API tokens are scoped to buckets, not folders. Only temporary credentials can be limited to a folder, and those need something trusted to mint them. Use one shared read and write key for the team (owners are then claimed and not enforced), or a bucket per person (each laptop then reads only its own bucket). Whether R2 honours `If-Match` on delete is untested; the storage test decides per bucket |
| Azure Blob Storage (`az://`) | Untested | A SAS is scoped to a container at most, not a folder. Azure role assignment conditions on the blob path might limit a person to `owners/<owner>/`, but seshi has not been tried that way. Use one account key or container SAS for the team (owners are then claimed and not enforced), or a container per person. Conditional writes and deletes pass the storage test |
| Google Cloud Storage (`gs://`) | Untested | IAM Conditions on `resource.name` starting with `projects/_/buckets/<bucket>/objects/<prefix>/owners/<owner>/` might limit a person's service account to their folder, but seshi has not been tried that way, and listing is granted per bucket. Use one service account for the team (owners are then claimed and not enforced), or a bucket per person. Conditional writes and deletes are generation preconditions, which Google documents for both; fake-gcs-server honours them only on uploads |
| MinIO, RustFS and other S3-compatible stores (`s3://` with `--endpoint`) | Depends on the store | They must pass the storage test |
| Backblaze B2, DigitalOcean Spaces, Google Cloud Storage's S3 API (`s3://` with `--endpoint https://storage.googleapis.com`) | | No conditional writes, so they can't hold a seshi bucket. The storage test says so and `init` refuses them. GCS's XML API takes `If-Match` and `If-None-Match` only on reads; use `gs://` for Cloud Storage |
| A folder (`file://`) | | For one machine. No key |

## Example AWS IAM policies

**These policies have not yet been tried against a real AWS account.** Check them on a test
bucket before you rely on them. When one is wrong, `seshi init --serverless` and `seshi doctor`
say which request the bucket refused and which kind of key it takes. One thing to know: S3
answers a read of an object that does not exist with `403` instead of `404` when the key's
`s3:ListBucket` does not cover the read, and a grant limited by an `s3:prefix` condition (as
below) never covers a GET, which carries no prefix. seshi reads missing objects as a matter of
course (a new session's metadata), so on a `403` it lists exactly that key: when the listing is
allowed and finds nothing, the object is missing; only when the listing is refused too is the
read a refusal. If `init` says a key can't read its own folder, check the `s3:ListBucket`
statement first.

The examples are for the bucket `acme-seshi` with the prefix `seshi`
(`s3://acme-seshi/seshi`); replace both. Each is one policy for everyone in a group:
`${aws:username}` is the IAM user's name, so it works only when IAM user names are the owners
`seshi whoami` prints (lowercase; S3 keys are case-sensitive). For other names, and for roles
and SSO, see [the tag variant](#owners-that-are-not-iam-user-names).

A laptop needs:

- to read `seshi/seshi.json` (the marker) and `seshi/config/*` (the shared settings), and to
  list `seshi/config/`;
- to read, write and delete under its own `seshi/owners/<owner>/`, and to list it;
- to read others' folders only if members may read each other's sessions.

### A member who reads everything and writes their own folder

What most teams want: everyone searches everyone's `org` sessions.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListSessionsAndSettings",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::acme-seshi",
      "Condition": {
        "StringLike": {
          "s3:prefix": ["seshi/owners/*", "seshi/config/*"]
        }
      }
    },
    {
      "Sid": "ReadMarkerSettingsAndSessions",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": [
        "arn:aws:s3:::acme-seshi/seshi/seshi.json",
        "arn:aws:s3:::acme-seshi/seshi/config/*",
        "arn:aws:s3:::acme-seshi/seshi/owners/*"
      ]
    },
    {
      "Sid": "WriteOwnFolder",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::acme-seshi/seshi/owners/${aws:username}/*"
    }
  ]
}
```

### A member who reads and writes only their own folder

Others' sessions are then out of reach of the key, not only hidden by the CLI. These laptops
need `[search] scope = "mine"`: the other scopes list every owner's folder, which this key may
not. `init` sets it when the key can't list `owners/`, and `doctor` reports the key as read-own.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListOwnFolderAndSettings",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::acme-seshi",
      "Condition": {
        "StringLike": {
          "s3:prefix": ["seshi/owners/${aws:username}/*", "seshi/config/*"]
        }
      }
    },
    {
      "Sid": "ReadMarkerAndSettings",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": [
        "arn:aws:s3:::acme-seshi/seshi/seshi.json",
        "arn:aws:s3:::acme-seshi/seshi/config/*"
      ]
    },
    {
      "Sid": "ReadAndWriteOwnFolder",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::acme-seshi/seshi/owners/${aws:username}/*"
    }
  ]
}
```

### An admin

Everything under the prefix: the marker (`seshi init --serverless --admin`, `seshi admin mode`,
`seshi admin layout`), the shared settings (`seshi admin config push`), every owner's folder
(`seshi sessions rm --owner`, `seshi redact backfill`), and listing all of it
(`seshi store check`).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListThePrefix",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::acme-seshi",
      "Condition": {
        "StringLike": {
          "s3:prefix": ["seshi/*"]
        }
      }
    },
    {
      "Sid": "ReadAndWriteThePrefix",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::acme-seshi/seshi/*"
    }
  ]
}
```

### Owners that are not IAM user names

When IAM user names are not the owners (mixed case, an email elsewhere), or members use roles or
IAM Identity Center rather than IAM users (`${aws:username}` is set only for IAM users), tag each
principal with `seshi-owner` set to the owner `seshi whoami` prints, and use
`${aws:PrincipalTag/seshi-owner}` wherever the policies above use `${aws:username}`. For the
member who reads everything, the write statement becomes:

```json
{
  "Sid": "WriteOwnFolder",
  "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:DeleteObject"],
  "Resource": "arn:aws:s3:::acme-seshi/seshi/owners/${aws:PrincipalTag/seshi-owner}/*"
}
```

Anyone who can change their own tags can change their folder, so keep `iam:TagUser` and
`iam:TagRole` (and session tags, for roles) with admins.

## Shared settings

The bucket holds the team's settings, in the server config format:

```
<prefix>/config/seshi.toml          read by every laptop
<prefix>/config/packs/<name>.toml   redaction rule packs it names, and any other file it names
```

Paths in `config/seshi.toml` (`redaction.packs`, a review policy's `prompt_file`) are relative to
`config/` and must stay inside it. Any server config key may be there. Laptops ignore `[store]`, `search.path`,
`search.backend` and `[search.lance]` in it (they know where the bucket is, and keep their own
SQLite index, never a server's shared one: [search.md](search.md#a-shared-index-lancedb)), and `[[sources]]` (OTLP intake
included), `[auth]`, `[server]` and `[worker]` wherever they are set, since those need a server; a bucket
that switches modes may keep them. `doctor` lists what was ignored.

Each laptop's settings, lowest first: built-in defaults, `config/seshi.toml`, the local file
`serverless.config` names, `SESHI_*` env, `--set`.

Secrets in the shared file are environment references only (`api_key = { env =
"ANTHROPIC_API_KEY" }`), so each laptop supplies its own. Because every laptop resolves them, the
shared file is held to more than a server's config:

- no literal secret, in any section (laptops ignore some sections, but every key that can read
  `config/` can read the file);
- no `{ file = "…" }` secret: that names a path on each laptop;
- a review policy with a key names no `base_url` but its provider's own
  (`https://api.anthropic.com`, `https://api.openai.com/v1`). Otherwise the shared file could send
  any variable on every laptop to an address of its choosing. A team that reviews through a proxy
  or its own model server sets that policy in each laptop's `serverless.config` instead (a
  `review.policies` list there replaces the shared one); a policy with no key may name any
  endpoint.

`seshi admin config push` refuses a file that breaks these, and a laptop does not use one.

**Changing them:**

```sh
seshi admin config pull [<dir>]              # default ./seshi-config
seshi admin config push [<dir>] [--dry-run]
```

`pull` downloads `config/` and records each file's ETag in `<dir>/.seshi-pulled.json`. `push`
runs the checks `seshi serve` runs at start (the config's shape, each pack's rules against its
own test strings), refuses literal secrets, and uploads what changed with `If-Match` on the
ETags `pull` recorded. When someone else pushed in between, it refuses with exit 6: pull again,
redo the change, push. `push` does not delete files you removed from the folder. Writing
`config/` takes a key that can write there.

**How laptops pick them up.** Each laptop caches `config/` in its state folder and asks the
bucket again at most every 5 minutes: it lists `config/`, compares ETags, and downloads only what
changed. The running uploader reopens the bucket that often, so a change reaches every laptop
within about 5 minutes. A copy that fails the checks is not used: the last good copy stays in
use, and `doctor` says why. With no good copy (the first copy fails, or the cache is gone),
uploads wait with the status word `bad shared settings`. A rejected copy is checked again when
the bucket's copy changes, when seshi is updated, or when this laptop's own settings change (the
`serverless.config` file, `SESHI_*`, `--set`). When the bucket can't be reached, the cache is
used; with no cache, commands that write fail and uploads wait. A key that may not read
`config/` holds uploads (`bucket refused`).

## Model review keys

A review policy in the shared settings names its key as an environment variable. On a laptop
without that variable, store a key once:

```sh
seshi review key set anthropic            # asks on a terminal
echo "$KEY" | seshi review key set anthropic --key -
```

It is kept in the keychain (or `credentials.json`) and fills the `{ env = "…" }` of every
policy step for that provider while the variable is unset, for steps that call the provider's
own endpoint only: a stored key is never sent to a `base_url` a config names.

What happens on a laptop with no key for a policy depends on `review.required` in the shared
settings ([config.md](config.md#review)):

- `true`: sessions wait on the laptop, and nothing is uploaded unreviewed. The status line says
  `needs review key`, and `capture status`, `upload` and `doctor` print how to set one.
- `false` (the default): sessions are stored with regex redaction only, and recorded as
  `skipped`, as `on_failure = "skip"` does. `doctor` warns.

## Search

Each laptop keeps its own index. `[search]` in the CLI config ([config.md](config.md#serverless-mode))
decides whether it does (`enabled`, by default the shared config's `search.enabled`) and what it
holds (`scope`): `"mine"` (only your sessions; the one scope a key that reads only its own
folder can use), `"visible"` (the default: yours and every `org` session) or `"all"` (owner-only
sessions too, as `--include-private` on every search).

The daemon catches the index up every `search.interval`. `seshi search` uses the index as it is
when it caught up within twice that interval, catches up first otherwise, and says
`Index caught up <time>.` The index records the scope and owner it was built for; when either
changes, it is emptied and built again, so it never holds sessions the new scope leaves out.
A result whose session the key may not read is left out. With search off, `seshi search` exits 3
and says how to turn it on. Turning it off does not delete the index file yet. See
[search.md](search.md).

`seshi sql` reads the same index, in a worker process this laptop starts for it
(`search.sql.workers`, 1 by default), as its own user: the views hold what `seshi search`
shows (your sessions and the org's, owner-only ones too with `--include-private`); the window
(`--since`, `--until`, the last 30 days by default) still applies
([search.md](search.md#sql)). A shared config's `search.sql.members` is a server setting, and
ignored here.

Every owner's change feed as one (`GET /v1/changes/all`) is a server route, so serverless mode
has none: there is no API to call, and each laptop's index is its own, often limited to its
scope. Writing an org-wide index at publish time instead would need every laptop to write
outside `owners/<owner>/`, and a member's key is limited to that folder
([Credentials](#credentials)). A reader with a key that reads
every folder tails each owner's `changes/` itself, as [layout.md](../spec/layout.md#reading)
describes.

## What a laptop writes and keeps

A laptop writes only under `owners/<owner>/`: sessions, traces, the change feed, review records,
stubs, the probe and the storage test's object. It never creates the layout marker: a bucket
without one is exit 3, `no seshi bucket at <url>: run seshi init --serverless`.

Drop and failure records (what review dropped, what failed) stay on the laptop that ran the
pipeline. `seshi sync dropped upload` and `seshi sync failed upload` list them, and
`seshi sync prune` removes those past `[records]` retention. The rest of `seshi sync` and
`seshi workers` need a server.

The state folder (`~/.local/state/seshi/`, [capture.md](capture.md#files)) holds, per bucket,
`serverless/<id>/`: the cached shared settings (`shared/`, `shared.json`), the storage test's
result, the drop and failure records (`records/`) and the daemon's upkeep times.

## The daemon

`seshi daemon` (started by hooks, or kept running with `seshi capture install --service`) does
the uploads and, in serverless mode, this upkeep:

| Job | Every | |
|---|---|---|
| Shared settings | 5 minutes | Reopens the bucket: settings, minimum version and mode |
| Search catch-up | `search.interval` | Only with `[search] enabled` |
| Sweep of the owner's folder | 1 day | Deletes trace objects no session names that are over an hour old. Only when the storage test confirmed conditional deletes |
| Record pruning | 6 hours | This laptop's drop and failure records, by `[records]` retention |
| Storage test | 1 day | |

## The bucket's marker

`seshi.json` records the mode the bucket is used in and, optionally, the oldest seshi that may
write it. Every command that opens the bucket checks it:

- **No marker:** exit 3, `no seshi bucket at <url>: run seshi init --serverless`.
- **Below `min_version`:** writes are refused (exit 3, `this bucket needs seshi <min> or newer;
  you have <v>. Update seshi, then try again.`), reads go on with a warning, and uploads wait
  with the status word `needs update`.
- **`mode = "server"`:** a warning that laptops should upload through the server. Nothing is
  refused.

```sh
seshi admin layout --min-version 0.12.0     # older seshi may read but not write
seshi admin layout --clear-min-version
seshi admin mode server|serverless
```

These take a key that can write `seshi.json`. Like `seshi admin config`, they work on the CLI
config's `[serverless]` bucket, or, with `--config <file>` and `--set`, on the `[store]` of a
server config. A seshi from before serverless mode refuses a schema 2 marker, so it can't write
a bucket with a minimum version either.

## Uploads that wait

In serverless mode an upload can wait on the laptop for four reasons, each with its own status
word: `needs review key`, `needs update`, `bad shared settings` (no usable copy of the shared
settings) and `bucket refused` (the key can't write its folder or read `config/`, the bucket
refused a write during an upload, the bucket has no marker, or the store fails the storage
test). See
[capture.md](capture.md#uploads-that-wait) for what to do about each. `seshi doctor` has a
**Serverless bucket** section that checks the marker, the owner (a probe write), the storage
test, read access (read-all or read-own), the shared settings, model review keys, search, and
settings in the local config that need a server.

## Switching modes

A bucket can switch between server and serverless mode. Run one mode at a time: while laptops
write a bucket directly, a server on it doesn't stop them, and the reverse. Neither mode refuses
the other. A server on a bucket marked serverless starts, and it and `seshi workers status` say
that laptops may be writing it. A laptop on a bucket marked server warns on every command and in
`doctor`.

**To a server:**

1. Start the server on the bucket ([server.md](server.md#running-it)), and set up its
   credentials (`seshi admin init`).
2. `seshi admin mode server`.
3. On each laptop, `seshi login --server <url>`. `login` refuses while the CLI config has
   `[serverless]`: remove that table first.
4. Remove the laptops' bucket keys from the cloud account.

**To serverless:**

1. Stop the server.
2. `seshi admin mode serverless`.
3. `seshi init --serverless --url <url>` on each laptop, with its own key.

Tokens and sources stay in the bucket, unused, while it is serverless.

## Moving from local mode

A CLI config with `[local]` is read as `[serverless]`: `local.config` names a server config whose
`[store]` gives the bucket, and `local.owner` is `serverless.owner`. `seshi config check --cli`
prints the new table. What changed:

- The CLI acts as a member of its owner, not as the bucket's admin. `sessions --owner bob` shows
  only bob's `org` sessions (`--include-private` for the rest), and `seshi tokens` needs a
  server.
- New sessions record `owner_basis: "claimed"`, not `verified`.
- The bucket must have a layout marker. One local mode wrote already has one.

`seshi init --serverless --url <url>` replaces `[local]` with `[serverless]`, with no `config`.
If the server config `[local]` named held settings or keys you still want, add
`config = "<path>"` to `[serverless]` again.
