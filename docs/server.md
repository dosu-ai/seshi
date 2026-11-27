# The seshi server

`seshi serve` is the server: one process, one config, one bucket. Members' capture uploaders
and other clients post transcripts to it; it runs each through one pipeline, in memory (X4):
normalize to trajectory-v1, redact, decide whether the session is worth a trace and how much
of it is new, run model review when a policy applies, and only then write the trace to the
bucket, in the [layout](../spec/layout.md). Its worker polls the sources you configure (OTLP
spans, Datadog, an S3 bucket) through the same pipeline. The transcript itself is never stored
(X6.3): the redacted trace is the only copy. Anything that reads the layout can read the bucket
directly: the server is a writer, and no reader depends on it.

The server is optional. In serverless mode ([serverless.md](serverless.md), F11) each
laptop's CLI builds the same pipeline in-process and writes its owner's folder of a shared
bucket, for one person or a team. Run a server when laptops should hold no bucket credential,
when redaction must not be a laptop's to skip, or for what only a server does: sources, OTLP
intake, sign-in through an IdP, enforced owner-only sessions and one shared search index.

```
capture uploader, seshi upload, any client ──POST /v1/sessions──▶ seshi serve
OTLP exporters ──POST /otlp/v1/traces──▶       normalize · redact · filter · review · write
worker: Datadog, S3 sources ──poll──▶                              │
                                                                   ▼
                                                  the bucket (s3:// r2:// az:// gs:// file://)
                                                                   ▲
                                      readers: the API with a service token, or changes/
```

Every caller has an owner ID (X5.8): the username an org-key caller states, the IdP subject
(or email) of a person who signed in, `svc:<source-id>` for a service account, or the name of a
static token. That owner's sessions are filed under `owners/<owner>/`. Who may read what is the
session's visibility (X5.10); see [Who sees what](#who-sees-what).

Inside, the server is an Instance (`packages/ts/instance/`, X1.2): the bucket, identity and
access (`packages/ts/auth/`, X5), the pipeline (`packages/ts/pipeline/`) and the background jobs
(X7), built from one config, with the HTTP routes (`packages/ts/api/`) over it.
[`@dosu/seshi-client`](client.md) speaks the API from the other side.

## Running it

Install `seshi` ([install.md](install.md)), write a config, check it, set up the first
credentials, and start it:

```sh
cat > seshi.toml <<'TOML'
[store]
url = "s3://acme-sessions/seshi"      # or r2://bucket/prefix, or file:///var/lib/seshi
region = "us-east-1"
TOML
seshi config check --config seshi.toml   # every problem at once, with where each value came from
seshi admin init --config seshi.toml     # prints the first admin token and the org key, once
seshi serve                              # http://localhost:7200
```

The config is `./seshi.toml` (read unasked by `seshi serve` only: every other command needs
`--config` or `SESHI_CONFIG` for it), `/etc/seshi/seshi.toml`, or the file `--config` names, with
`SESHI_*` env over it and flags over env; [`seshi.example.toml`](../seshi.example.toml) is a
commented example and [config.md](config.md) lists every setting. The compiled binary reads
nothing else: no `.env`, no `bunfig.toml`. From a checkout, `bun start` runs the server from
source and Bun reads `.env` (copy [`.env.example`](../.env.example)); `docker compose up -d`
hands the container the same `.env`.

At boot the server writes the layout marker and a probe object, so a wrong bucket or key fails
there and not on the first session. On a bucket whose marker says it is used in serverless mode
(F11.8), the server still starts: it logs, and `seshi workers status` reports, that laptops may
be writing the bucket directly. Run `seshi admin mode server` once they have moved to the server
([serverless.md](serverless.md#switching-modes)). Put TLS in front of it (a reverse proxy, a load balancer,
Cloud Run): transcripts arrive unredacted, and the server is where that stops being true.

The settings most servers need ([config.md](config.md) has all of them):

| Setting | Env | Purpose |
|---|---|---|
| `auth.tokens.<name>` | `SESHI_AUTH__TOKENS__<NAME>` | Static tokens, for one person and development: each is everything for its owner (`SESHI_AUTH__TOKENS__ALICE=…`, 16+ characters, `openssl rand -hex 24`). For a team, use `seshi admin init` and the org key or an IdP instead |
| `auth.oidc.*`, `auth.session_keys.*` | `SESHI_AUTH__OIDC__ISSUER`, `…__CLIENT_ID`, `SESHI_AUTH__SESSION_KEYS__K1` | Sign-in through your IdP (X5.2) and the key session tokens are signed with (32+ characters) |
| `auth.org_key.enabled` | `SESHI_AUTH__ORG_KEY__ENABLED` | Default `true`: members holding the org key write as the username they state (X5.12) |
| `store.url` | `SESHI_STORE__URL` | Required: `r2://bucket/prefix`, `s3://bucket/prefix`, `az://container/prefix` (Azure Blob Storage), `gs://bucket/prefix` (Google Cloud Storage), or `file:///path` |
| `store.credentials.*`, `store.region`, `store.endpoint`, `store.account_id`, `store.account_name` | `SESHI_STORE__CREDENTIALS__ACCESS_KEY_ID`, `SESHI_STORE__ACCOUNT_NAME`, … | The bucket's keys and where it is. Unset, the standard `AWS_*` / `S3_*` (and `R2_*` for `r2://`) variables apply, then for `s3://` an ECS task's or EC2 instance's role; for `az://`, `AZURE_STORAGE_*`, then workload identity ([config.md](config.md#azure-blob-storage-az)); for `gs://`, Application Default Credentials ([config.md](config.md#google-cloud-storage-gs)) |
| `redaction.packs` | `SESHI_REDACTION__PACKS` | Your own redaction rule packs (TOML, or today's JSON rule files), on top of the built-in pack ([redaction.md](redaction.md)). The server refuses to start on a pack it cannot use or a rule that fails its own test strings |
| `store.deployment_id`, `store.org` | `SESHI_STORE__DEPLOYMENT_ID`, `SESHI_STORE__ORG` | Recorded in the bucket's layout marker (`seshi.json`); the server refuses to start against a bucket marked for another deployment or org (X1.4). See [the layout](../spec/layout.md) |
| `server.listen` | `SESHI_SERVER__LISTEN` | Default `:7200`; flag `--listen` |

`PORT` is not read.

## Roles and background work

`seshi serve` runs two roles (X7.1), chosen with `--roles` or `server.roles`: `api` serves the
HTTP API, and `worker` runs the background jobs. The default runs both in one process, which is
what one container wants. Any number of instances can run `--roles api`; exactly one should run
the worker (X7.2). A second worker by mistake corrupts nothing (X7.3: checkpoints are saved
with `If-Match`, so the run that loses is discarded and anything it submitted is deduplicated),
and status says when it sees two. An instance without `api` answers `/healthz` only.

The worker's jobs:

| Job | Every | What it does |
|---|---|---|
| `heartbeat` | `worker.heartbeat_interval` (1m) | Writes `worker/heartbeat.json`: who runs, since when, and each job's last run and error (X7.5) |
| `retention` | 6h | Prunes drop and failure records and source health days past `[records]` retention |
| `source:<id>` | the source's `interval` | Polls a source through its connector (X3.11), from its checkpoint (X7.4): Datadog LLM Observability for `type = "datadog"` ([datadog.md](datadog.md)), a bucket for `type = "s3"` ([s3-sync.md](s3-sync.md)), Cursor's Cloud Agents API for `type = "cursor-cloud"` ([cursor-cloud.md](cursor-cloud.md)) |
| `assembler` | `worker.assembly_interval` (30s) | Publishes sessions whose spans (OTLP, F4; Datadog, F5) have been quiet for their source's `quiet_period`, from the pending markers (X7.4); its backlog is the sessions waiting |
| `sweep` | 1d, and when the worker starts | Deletes trace objects no session's metadata names that are over an hour old: what a redaction backfill, replace or publish that stopped partway left behind (F2.5, [redaction.md](redaction.md#trying-and-applying-rules)) |

One job runs on every instance with the `api` role instead, worker or not (with
`search.backend = "lance"`, on the worker instead):

| Job | Every | What it does |
|---|---|---|
| `search-index` | `search.interval` (15s) | Reads every owner's change feed into the search index ([search.md](search.md#how-the-index-works)), which also keeps the copy of the feeds `GET /v1/changes/all` serves. With SQLite, each API instance's own; with `search.backend = "lance"`, the one shared index, and only on the worker ([search.md](search.md#a-shared-index-lancedb)) |

A failed run is retried after 5 seconds, doubling per failure in a row up to the job's
interval. A poll whose envelope failed transiently (the bucket) never saves its checkpoint
past it, so the retry reads it again. A session the assembler could not publish (the bucket
failed) keeps its marker and is tried again. Each worker job is also a one-shot command for
cron: `seshi sync run <id>` polls a source, `seshi sync assemble` runs the span assembler,
`seshi sync prune` runs retention, `seshi redact sweep` runs the sweep. A deployment with no
worker needs all four: polling alone stores OTLP and Datadog spans but never publishes their
sessions, without `prune` drop and failure records are never removed, and without `sweep` the
trace objects a stopped write left stay in the bucket (no reader is served them). With
`search.backend = "lance"` it needs a fifth, `seshi sync search`, which indexes the shared
search index (a long first build spans several runs).

Where the config and bucket keys are:

- `seshi workers status [--json]`: the worker (`running`, `stopped`, `never`, or `several`),
  each job's last run (and what it did, such as the sweep's `deleted`), last error and backlog,
  and each source's drop and failure counts.
  Exit 8 when something needs a look. `GET /v1/admin/jobs` answers the same for admins.
- `seshi sync run <id>`, `sync assemble`, `sync prune`, `sync status [<id>]`,
  `sync failed <id>`, `sync dropped <id>`: poll once; publish the span sessions that went
  quiet; remove records past retention; checkpoints, record counts and health; the records of
  envelopes that were not stored and why, never their content.
- `seshi reprocess --source <id> [--since <time>] [--run]`: rewind a source so its sessions are
  read and written again (X4.9), while the source still has them. Uploads are not polled and
  the server keeps no raw logs: the machines that uploaded them resend them (`rebuild`, below).

From an admin's laptop, signed in with `seshi login`, `seshi workers status` and `seshi sync
status|failed|dropped` read the same through `/v1/admin/jobs` and `/v1/admin/sources` (add
`--server <url>`, or let them use the CLI config's `server` where no server config is). `sync
run` and `reprocess` stay where the config is.

The commands and their exit codes are in [cli.md](cli.md).

### Checking the bucket

`seshi store check [--owner <id>]… [--json]`, where the config and bucket keys are (or against
the CLI config's serverless bucket), reads the whole bucket and reports where it breaks the invariants of
[spec/layout.md](../spec/layout.md): a missing or foreign layout marker; metadata that does not
parse, match its schema or name its own key; a head or listed trace with no object, or an
object whose records do not hash to its key; a continuation chain that does not join up from
`dropped_prefix` to `normalized`; a stub holding traces or dropped content; a deleted session
with something left to read; change entries with bad keys, for sessions that do not exist, or
missing for a change the session shows; span records naming messages that are not stored; token
records that do not parse (never what they hold). Each finding is an `error` or a `warn`. A
warning is what the protocol allows for a while: an old trace object no session names (the
daily sweep deletes it), an entry for a write that failed between its entry and the pointer
(decision 7 of 18), records no trace holds that no drop explains, a session with no recorded
normalizer version (it counts as stale).

It only reads (list, get and stat; `s3:ListBucket` and `s3:GetObject` are enough), so it is
safe to run against a live bucket, from cron or CI after an upgrade, after a restore, or before
trusting a bucket another writer touched. Exit 0 with no errors, 8 with any, so a script can
alert on it. It reads every metadata object, change entry, span record and trace object, so on
a large bucket it takes as long as reading the bucket; `--owner` narrows it. The same check is
`checkStore` in `@seshi/store`, for tests and tools.

## Sources

A source is a way sessions reach the server other than `POST /v1/sessions` (whose source is
`upload`). Each is a `[[sources]]` entry with its own id, service account (`svc:<id>`),
visibility, checkpoint and health ([config.md](config.md#sources)):

| `type` | How sessions arrive | Guide |
|---|---|---|
| `otlp` | Pushed: OpenTelemetry GenAI spans to `POST /otlp/v1/traces` (a Claude Console destination, or any OTLP/HTTP exporter), assembled into sessions | [otlp.md](otlp.md) |
| `datadog` | Polled: Datadog LLM Observability's Export API, the turns Datadog Trajectory published | [datadog.md](datadog.md) |
| `s3` | Polled: transcripts other systems drop into a bucket (eval harnesses, ATIF exports, sandboxes) | [s3-sync.md](s3-sync.md) |
| `cursor-cloud` | Polled: Cursor's Cloud Agents API, each run of a Cursor Cloud agent | [cursor-cloud.md](cursor-cloud.md) |

Sources are added, changed and removed without a restart: edit the file (or a drop-in in
`seshi.d/`) and reload with `SIGHUP` or `POST /v1/admin/reload`
([config.md](config.md#reloading)). Unchanged sources keep running, and checkpoints are kept.

A source's `labels` table is put on every session it stores, whatever its type: say, which
member's key a Cursor Cloud source polls with.

```toml
[[sources]]
id = "cursor-alice"
type = "cursor-cloud"
api_key = { env = "CURSOR_API_KEY_ALICE" }
labels = { "dosu.member" = "alice" }
```

They win over labels the data carries, and follow the rules every session's labels do
([below](#labels)). A source's labels reach sessions it stores after they are set; a session
keeps the labels it was first stored with.

## Deploying

Every release is published as a container image, `ghcr.io/dosu-ai/seshi:<version>`, built
from `apps/seshi/Dockerfile` in this repository (`docker build -f apps/seshi/Dockerfile .` from the
root). The image is the compiled `seshi` binary (X2.2) on a slim Debian base, in its server
build (`bun run build --server`, `apps/seshi/src/main-server.ts`), which also carries the
LanceDB search backend (F10.6): a release's image holds the very Linux server binaries attached
to its GitHub release (`seshi-server-linux-*`, `--build-arg BINARY=prebuilt`,
[releasing.md](releasing.md)), while a build from a checkout compiles its own. Outside a container, install the same binary ([install.md](install.md)) and
run `seshi serve`. The image's entry point is `seshi` and its command `serve`. It listens on `server.listen` (default
`:7200`), reports `/healthz` for liveness (the image's health check is `seshi healthcheck`),
and needs only the settings above, from env or a mounted `/etc/seshi/seshi.toml`: there is no
database, no volume (unless the store is `file://`), and no state outside the bucket. API
instances scale to many alike; the worker role wants one instance that stays up (a minimum of
one, not scaled to zero), or run its jobs from cron with `seshi sync run <id>` for each
polled source, `seshi sync assemble` for OTLP and Datadog sessions, `seshi sync prune` for
retention and, with a shared search index, `seshi sync search`. Keep
the request timeout at 120 seconds or more; a large transcript can take that long to normalize
and verify. Platforms that cap request bodies (Cloud Run's HTTP/1 limit is 32 MiB) are fine as
long as clients send `Content-Encoding: gzip`, which every route accepts.

Each cloud's own object storage holds the bucket:

| Cloud | `store.url` | Keys |
|---|---|---|
| AWS | `s3://bucket/prefix` with `store.region` | The ECS task role (Fargate or EC2), EKS Pod Identity, or the EC2 instance profile: seshi asks for the role's keys itself and renews them ([config.md](config.md#amazon-s3-s3)). Or `store.credentials`, or the `AWS_*` variables |
| Google Cloud | `gs://bucket/prefix` | GKE Workload Identity: the pod's Kubernetes service account bound to a Google service account with **Storage Object User** on the bucket (seshi asks the metadata server for its token), or `store.credentials.service_account_key`, or `GOOGLE_APPLICATION_CREDENTIALS` |
| Azure | `az://container/prefix` with `store.account_name` | Workload identity on AKS (`AZURE_FEDERATED_TOKEN_FILE`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, set by AKS for a service account that names a managed identity with **Storage Blob Data Contributor** on the container), or `store.credentials.account_key` / `sas_token` |

On Azure and Google Cloud no S3 gateway is needed: seshi speaks the Blob service's and Cloud
Storage's own APIs ([config.md](config.md#azure-blob-storage-az),
[config.md](config.md#google-cloud-storage-gs)). Not GCS's S3-compatible XML API: it takes
`If-Match` and `If-None-Match` only on reads, so it cannot hold a seshi bucket. To try it locally, run Azurite
(`docker run -p 10000:10000 mcr.microsoft.com/azure-storage/azurite azurite-blob --blobHost 0.0.0.0`),
create a container, and set `store.endpoint = "http://127.0.0.1:10000/devstoreaccount1"`,
`store.account_name = "devstoreaccount1"` and Azurite's documented account key as
`AZURE_STORAGE_KEY`. For Google Cloud, run fake-gcs-server
(`docker run -p 4443:4443 fsouza/fake-gcs-server -scheme http -port 4443`), create a bucket,
and set `STORAGE_EMULATOR_HOST=http://127.0.0.1:4443`; it ignores generation preconditions on
deletes, so the storage test reports conditional deletes as not supported there.

## Setting up who may call it

Run `seshi admin init` once, where the config and the bucket keys are. It writes straight to
the bucket and prints, once each, the first admin token and (with `auth.org_key.enabled`) the
org key. Run again it refuses; `--force` makes another admin token, `--rotate-org-key`
revokes the org key and makes a new one. After that, admins manage tokens with `seshi tokens`
([cli.md](cli.md)) or over the API (`/v1/tokens`). Members sign in with `seshi login`: the org
key with `--key`, or through the IdP ([cli.md](cli.md#signing-in-f82)).

| Credential | Who holds it | What it can do |
|---|---|---|
| Org key (no IdP) | Every member's CLI and uploader, with `X-Seshi-User: <username>` | Write as that username (lowercased; owner basis `claimed`); read and search org-wide. No deletes; never writes to, replaces or changes the visibility of a session whose owner was verified; replaces a session it wrote only with that session's retraction secret |
| IdP ID token | The CLI, briefly | Nothing but `POST /v1/auth/exchange` |
| Session token | The CLI, after sign-in | Read, search; delete the person's own sessions within 10 minutes of being issued. One hour; signed, not stored. An admin's (IdP group `admin_group` or an email in `admins`) can do everything |
| Device token | The uploader on a laptop | Write the person's own sessions; read, list, export and search them (private ones too), and share or unshare them (`seshi share`), all by being their owner: it has no `sessions:read` or `search`, so it reads no one else's session, even an `org` one. 90 days; signing in again from the machine renews it |
| Admin token | Admins | Everything, including deletes and token management |
| Service token | A reader, or an OTLP destination | Read and search org-wide, or write as `svc:<source-id>` (and read only what it wrote there); never changes a session's visibility (its source's `visibility` decides it) |
| Static token | Config | Everything for one owner |

Every seshi token is `seshi_<id>_<secret>`, stored as a hash at `tokens/<id>.json`, revocable,
and cached by the server for 30 seconds: a revoked token stops at once on the instance that
revoked it and within 30 seconds on any other. `POST /v1/tokens/revoke {owner}` revokes all of
a person's tokens at once (X5.11); their sessions stay. Without an IdP the only cut-off is
rotating the org key, which every member then sets again.

## Who sees what

A session is `org` (the default) or `owner` (X5.10). Its visibility is the upload's
`visibility`, else the token's default, else the source's, else `default_visibility`, and the
owner or an admin can change it later (`PATCH /v1/sessions/:format/:session_id`; `seshi share`
and `seshi unshare` from the CLI), which writes a `visibility_changed` change entry. The owner
may with any credential of theirs that writes sessions or reads them, so the device token a
laptop uploads with shares that person's sessions; a service token that only writes may not
change any.

Being the owner is enough to read a session: every credential reads, lists, exports and
searches its own owner's sessions, private ones too, whatever its scopes. So the device token a
laptop uploads with (which has only `sessions:write`) reads that person's sessions, and a
service token that only writes reads what it wrote as `svc:<source-id>`. Another owner's
sessions need a scope that reads: `sessions:read` for the session routes, listings and change
feeds, `search` for search. Members read their own sessions and every `org` session; admins and
service readers read everything. Reads name another owner with `?owner=`; a session the caller
may not read answers `404`, as if it were not there, so a credential without `sessions:read`
gets `404` for every session not its own owner's, `org` ones included. A listing, change feed
or search that names another owner (`GET /v1/sessions?owner=`, `GET /v1/changes?owner=`,
`GET /v1/search?owner=`) from a credential without the scope is refused with `403`: it asks
for a whole owner, so there is nothing to hide by pretending it is empty. Search without
`search` is limited to the credential's own owner. Another owner's change feed shows only the
entries of sessions the caller may read. Every
owner's feed at once (`GET /v1/changes/all`) is only for callers that read everything, service
tokens and admins: anyone else gets `403`, never a filtered feed.

Without an IdP anyone with the org key can state any username, so `owner` visibility keeps
nothing from another member; `seshi config check` says so.

A service token writes as its source's service account, `svc:<source-id>`, whichever route it
uses: what it posts to `POST /v1/sessions` is filed under its own source, not `upload`, so that
source's `visibility`, `filter` and health apply (X5.4).

Every write records its writer (caller kind, owner ID, credential ID, source) and how the owner
was established, `verified`, `claimed` or `service`, on the session and on its change entries
(X5.5). A leaked token's writes can be found by its credential ID.

To host several teams, run one container per team, each with its own config and its own
bucket or prefix. Isolation between teams comes from the deployment, not the code (X1.1).

## Readers

A reader reads through the API with a service token (`seshi tokens create service --service
<name>`, or `POST /v1/tokens {kind: "service", service: "<name>"}`) and
[`@dosu/seshi-client`](client.md): it reads and searches every session, and tails each owner's
`/v1/changes`, or every owner's at once with `/v1/changes/all` (below). With a server, bucket
keys stay on the server (X5.6); in serverless mode each
laptop holds one, and the bucket's permissions decide what it may do
([serverless.md](serverless.md#credentials)). A read-only bucket credential
(`s3:ListBucket` on the prefix, `s3:GetObject` under it) still works for a reader that tails
`changes/` itself, but it skips every check, so it counts as org-wide read; `GET /v1/me` tells a
client which bucket that is.

### Every owner's change feed

A reader that follows every session can tail one feed instead of one per owner: `GET
/v1/changes/all` (`allChanges()` in [`@dosu/seshi-client`](client.md)) pages through every owner's
entries by stamp, then owner, then key, with one opaque cursor. Each entry names its `owner`
and its `key`, and the entry its session's `format`, so a reader can call
`/v1/sessions/:format/:session_id` from the entry alone; `tombstone` and `visibility_changed`
entries come through like `published` ones, from people, `svc:<source-id>` service accounts and
`h-…` owners alike. Entries written before seshi 0.16 carry no `format` in the bucket: both
feeds fill it in from the session's metadata (this one when the index reads the entry), and
leave out an entry whose session has no metadata to read it from (a first write that failed
after its entry), so every entry served has one.

It is served from this instance's search index, which keeps a copy of every entry it reads, so a
poll is one SQLite range read and no bucket request, however many owners there are. Search must
be on (`404 search_disabled` otherwise), and until the index has read every owner's feed once
the route answers `503 index_building` with `Retry-After`.

A page holds only entries stamped no later than its `through`: the least of how far each
owner's feed has been read (a feed read to its end, up to when it was listed; one a pass
stopped in for its budget, up to its cursor) and when the indexer's owner list was taken (an
owner not on it had written nothing yet). So an entry that turns up later is normally stamped
after `through` and lands ahead of any cursor issued so far, a new owner's first entries
included, and an owner that writes faster than a pass reads holds `through` back without
stopping it. "Normally" because stamps come from writers' clocks: a writer whose clock runs
behind can stamp an entry before `through`, behind a cursor, which only the lag-window re-read
below finds; keep that re-read for every owner, new ones included. `through` trails the bucket
by up to a minute and a half (the owner list is read again every minute, then a pass every
`search.interval`).

The cursor names a place in that order, not a row of the index, so it works after a restart, a
rebuild, and on another instance. The contract is otherwise the per-owner feed's: stamps come
from the clocks of the machines that wrote, so a reader re-reads a lag window (`since` a few
minutes before the last entry it processed, then `after` the cursors that follow) and dedupes by
key; and an entry may be read before its change is in the session, or name one that failed, so
the reader reads the session for what it is now.

## API

The contract is [`spec/openapi.yaml`](../spec/openapi.yaml): every route, body and response,
with the schemas of the objects they carry. `tests/api/openapi.test.ts` holds the server to it
(every response validated, every documented status observed), so the document and the code
cannot drift apart. What follows is the same API in prose.

All bodies are JSON unless a route says otherwise. Errors are `{ "error": { "code", "message" } }`.
Request bodies may be `Content-Encoding: gzip` (any other encoding is a `415`). Every route but `/healthz`,
`/v1/auth/config` and `/v1/auth/exchange` wants `Authorization: Bearer <token>` (and
`X-Seshi-User` with the org key): `401 unauthorized` without a credential the server accepts,
`403 forbidden` for a call the credential's scopes or the session's owner and visibility do not
allow. The org key without `X-Seshi-User` gets `403` on a route it cannot use with any username
(the admin routes), since adding the header would not help.

| | |
|---|---|
| `GET /healthz` | `{ok, version}`, no auth |
| `GET /v1/auth/config` | Which ways in the server takes (X5.7): `org_key`, `oidc` (`issuer`, `client_id`, `audience`, `scopes`) or null, and token lifetimes. No auth |
| `POST /v1/auth/exchange` | `{id_token, nonce?, machine?: {id, name?}, visibility?}`: an IdP ID token for a session token, and with `machine` a device token for it (earlier device tokens for that machine are revoked). `401` for an ID token that does not check out, `404 no_idp` without an IdP. No bearer |
| `GET /v1/me` | `{owner, storage, kind, role, scopes, owner_basis, credential_id, visibility?, expires_at?}`: who the credential is, and which bucket this server writes, so a client can point a reader at it. Never a secret |
| `GET /v1/owners?limit&after` | The owners the bucket holds sessions for (`sessions:read`) |
| `POST /v1/sessions` | Store a session (`sessions:write`); see below |
| `GET /v1/sessions?owner&limit&after` | List an owner's sessions (the caller's own by default), as far as visibility allows; never a stub (F3.4). Any credential lists its own owner's; another owner's need `sessions:read` (`403` without it) |
| `GET /v1/sessions/:format/:session_id?owner` | The session's `metadata.json`; `404` for a stub. Any credential reads its own owner's sessions; another owner's need `sessions:read` (`404` without it). So do its trace, export and reviews |
| `PATCH /v1/sessions/:format/:session_id?owner` | `{visibility}`: change who may read it. The owner (with `sessions:write` or `sessions:read`, so a device token too) or an admin |
| `GET /v1/sessions/:format/:session_id/trace?hash&render` | The head trace (or another of the session's `traces`, by hash; `404` for a hash it does not name) as the stored canonical trace (`render=seshi`, the default) or rendered as `letta`, `otlp` or `atif` (until 0.17 also read as `?format=`, its name before 0.16); `400 bad_query` for another render, `404` for a session not stored (a filtered one included), `410` once redacted |
| `GET /v1/sessions/:format/:session_id/export?hash&render` | The same trace as a download: `Content-Disposition: attachment; filename="<format>-<session>-<hash>.<render>.json"` |
| `DELETE /v1/sessions/:format/:session_id?owner` | Tombstone: drop the trace objects, append a tombstone change. Irreversible; a later upload of the same session is refused. Needs `sessions:delete`: the owner with a fresh session token or a static token, or an admin. With `X-Seshi-Retract` it is a [retraction](#retraction-f97) by the machine that uploaded the session |
| `GET /v1/owners/:owner/sessions/:archive_id`, `…/trace?hash&render`, `…/export?hash&render`, `…/reviews` | The same session, trace, download and reviews, by the owner and archive id a change entry, a search result or a listing names: that owner's folder exactly (no `[auth.owner_aliases]` folded in), no default owner. For readers that hold sessions the API gave them; `400 bad_query` for an owner or archive id that is not one, `404` as above |
| `GET /v1/changes?owner&after&since&limit` | An owner's change feed; another owner's shows the entries of sessions the caller may read, and needs `sessions:read` (`403` without it) |
| `GET /v1/changes/all?after&since&limit` | Every owner's change feed as one: `{entries: [{owner, key, entry}], cursor?, truncated, through}`, by stamp, then owner, then key ([above](#every-owners-change-feed)). Service tokens and admins only, `403` for anyone else; `400 bad_query`, `404 search_disabled`, `503 index_building` |
| `POST /v1/tokens` | `{kind: org\|admin\|device\|service, owner?, service?, scopes?, visibility?, expires_at?, label?}`: a new token, shown once (`tokens:admin`) |
| `GET /v1/tokens?owner&kind&all` | Token records without their hashes (`tokens:admin`) |
| `DELETE /v1/tokens/:id` | Revoke one (`tokens:admin`) |
| `POST /v1/tokens/revoke` | `{owner, kind?}`: revoke every live token of an owner (`tokens:admin`, X5.11) |
| `GET /v1/admin/jobs` | The worker, its jobs and every source, as `seshi workers status --json` prints them (`sources:admin`, X7.5) |
| `GET /v1/redaction/rules` | The operator's rule packs and the rule-set hash, for redacting before upload (F2.4). Any signed-in caller; `ETag` is the hash, `If-None-Match` gets `304` |
| `GET /v1/capture/rules` | The org's exclude list (`[capture] exclude`, every file's entries, as written, blanks and `#` comments left out) and its tool-call redaction list (`[capture] redact_tool_calls`, the same way): `{schema: "seshi/capture-rules/1", exclude: [...], redact_tool_calls: [...]}`, which laptops apply before upload ([config.md](config.md#the-orgs-exclude-list-capture-exclude), [capture.md](capture.md#the-orgs-exclude-list-on-a-laptop)). Any signed-in caller; `ETag` is a hash of the answer, `If-None-Match` gets `304`; a reload changes it at once. A server older than the route answers `404`, which a laptop reads as no list |
| `GET /v1/sessions/:format/:session_id/reviews?owner` | What model review decided for each stored write (F3.8; another owner's session needs `sessions:read`): the whole audit record for admins, only `n`, `at`, `content_hash` and `decision` for anyone else who may read the session |
| `POST /otlp/v1/traces` | OTLP/HTTP trace ingest (F4): `ExportTraceServiceRequest` as protobuf or JSON from an OTLP destination's service token. Outside `/v1`, and its errors are OTLP's (`google.rpc.Status`). See [otlp.md](otlp.md) |
| `GET /v1/search?q&owner&agent&repo&branch&source&since&until&sort&limit&matches&cursor` | Keyword search over what the caller may read (F10; [search.md](search.md)); without the `search` scope, over its own owner's sessions only (`403` for `owner=` anyone else): `{query, total, results: [{owner, format, session_id, …, score, hits, matches: [{content_hash, event_index, role, snippet, highlights}]}], cursor?, index}`. `400 bad_query`, `404 search_disabled`, `503 index_building` |
| `GET /v1/admin/sources?days` | Every configured source and `upload`: checkpoint, drop and failure counts, health over the last `days` (7) days, as `seshi sync status --json` prints them (`sources:admin`) |
| `GET /v1/admin/sources/:id?days` | One source's status; `404 unknown_source` for an id no source has (`sources:admin`) |
| `GET /v1/admin/sources/:id/failed`, `…/dropped` `?since&after&limit` | A source's failure or drop records, oldest first, as `seshi sync failed\|dropped --json` prints them; never content. A source no longer configured can still have its records read (`sources:admin`, X6.4) |
| `POST /v1/admin/reload` | Read the config file, its `seshi.d/` drop-ins and the rule packs again and apply them, all or nothing, as `SIGHUP` does ([config.md](config.md#reloading), F1.5): `{reload, config}`, `reload.outcome` `applied` or `unchanged`; `422 reload_rejected` with `reload.errors` when they do not load or check (the running config stays); `409 not_reloadable` for a server started with no config file (`sources:admin`) |
| `GET /v1/admin/reload` | The running config's `generation`, `config_hash`, `rule_set` and `review_set` (changes with a review prompt file), when it was loaded, `restart_required`, and the last reload (`sources:admin`) |

### Retraction (F9.7)

A person can turn capture off in the middle of a session (`seshi capture off --session`, the
`/session-capture` skill), and what was already uploaded must go too. The uploader's credentials cannot
delete (a device token cannot, the org key cannot delete at all), so each session carries
a retraction secret instead. Before a session's first upload, the uploading machine makes a
random secret and keeps it in its capture state file; every upload sends only its sha256 as
`retract_hash`, and the server keeps the hash the session's first upload carries in its
`metadata.json`. A later upload never sets one: a session first uploaded without a hash cannot
be retracted, or replaced with the org key.

To retract, the machine sends `DELETE /v1/sessions/:format/:session_id` with its normal upload
credential (`sessions:write`) and the secret in `X-Seshi-Retract`. The server compares the
secret's hash with the stored one (in constant time) and runs the normal delete: trace objects
removed, the session marked redacted, a tombstone with reason `retracted` and the caller as its
writer. It acts on the caller's own sessions only (`?owner` is ignored), including those stored
under an old owner id that `[auth.owner_aliases]` folds into the caller's (X5.8).

| Answer | When |
|---|---|
| `200 {removed}` | Retracted |
| `403 bad_retract_secret` | Not the secret the session was uploaded with, or it was uploaded with none (another machine, a lost state file: then `seshi sessions rm` with an IdP, or an admin) |
| `403 retract_disabled` | The server's `capture.allow_retract` is `false` |
| `404 not_found` | The caller has no such session |
| `410 redacted` | It was already removed |

A leaked org key or device token cannot delete anyone's sessions this way: the secret never
leaves the machine that uploaded them. A retracted session is never stored again under that
id; turning it back on uploads it as a new session (`<id>~1`).

### `POST /v1/sessions`

```jsonc
{
  "format": "claude-code",         // the transcript format: claude-code, codex, cursor, opencode, pi, gemini-cli,
                                   // datadog-trajectory (a Trajectory session file, see below),
                                   // atif (an ATIF document, see below), or trajectory
                                   // (records already in trajectory-v1, see below)
  "session_id": "…",
  "transcript": "…",               // the native log, verbatim
  "encoding": "jsonl",             // or "json" (OpenCode exports, ATIF): how the log is encoded
  "project": "github.com/acme/widget",
  "branch": "main",                // the client's best guess; the transcript's own record wins
  "labels": { "team": "platform" }, // the session's labels, see "Labels" below
  "parent_session_id": "…",        // the session this one was resumed or forked from
  "fork_of": "…",                  // a fork: the parent whose history this log begins with
  "offset": 0,                     // where `transcript` starts in the log: 0 for the whole log
                                   // (the default), else a chunk from there; see "In chunks"
  "replace": false,                // rewrite a session this upload does not extend; see below
  "rebuild": false,                // build the session again from this whole log; see below
  "visibility": "org",             // or "owner", for a new session (X5.10)
  "idempotency_key": "…",          // optional; the Idempotency-Key header wins; see below
  "retract_hash": "<sha256 hex>"   // optional: the uploading machine's retraction secret,
                                   // hashed (F9.7); see "Retraction" below
}
```

The server builds the envelope the upload stands for (source id `upload`) and runs it through
the pipeline. Nothing is written until every stage has run. Before any of them, a session whose
`repo` the org's exclude list names ([config.md](config.md#the-orgs-exclude-list-capture-exclude))
is refused with `403 excluded`, for every source and caller: nothing of it is read or stored,
the message names no entry, and the refusal counts as `excluded` in the source's health. A
laptop's uploader settles such a session as excluded and sends it no more.
A session whose `repo` the org's tool-call redaction list names
([config.md](config.md#the-orgs-tool-call-redaction-list-capture-redact_tool_calls)) is stored
with every tool call's input and output replaced by `[redacted:tool-call]` in its records,
before any other redaction runs.

1. **Normalize** the transcript to trajectory-v1 records through the format's adapter.
2. **Redact** the records: the operator's patterns and the built-in secret patterns on every
   text field, and the sensitive-call rules on tool calls (a call that reads `.env` or runs
   `gh auth token` is kept; what it returned is withheld). See
   [redaction.md](redaction.md).
3. **Worth a trace?** The session filter judges a session's first trace only. Under 2000
   characters of conversation (or no user turn, or nothing answering it) is a greeting, not an
   investigation: `200 { "status": "filtered", … }`, and nothing of the session is stored. The
   answer's `bytes_total` is 0, so the next upload is the whole log again, judged again.
4. **How much is new?** For a session that has a trace, the server compares the upload's
   records with what it stored (`normalized` in its `metadata.json`). A log that extends the
   session writes only the meta record plus the tail, marked as a continuation, and a tail is
   never filtered, however short and whoever wrote it (an agent-only tail included); nothing
   past what is stored writes nothing (`200 unchanged`). A log that does not extend the
   session (the harness rewrote history, the normalizer or the rules changed) is refused with
   `409 conflict`, unless it sets `replace`: then it rewrites the session, which only the
   session's original writer or an admin may (`403 forbidden` otherwise). With the org key a
   stated username proves nothing (anyone holding the key can state it), so the replace must
   also carry the session's [retraction secret](#retraction-f97) in `X-Seshi-Retract`: only
   the machine that uploaded the session can rewrite it, as only it can retract it. A fork (`fork_of`)
   ships only what it added past the history it copied, when the parent is stored here; that
   is the fork's first trace, so it is judged. `shipped` (what an earlier answer said) is read
   only for a session without the server's own state.
5. **Model review**, when a review policy applies: allow, redact, or drop (`200 dropped`; a
   drop record says why, never what). A drop moves the log past it, a chunk's, a tail's or a
   first upload's; a dropped `replace` leaves the session as stored and answers with its
   state, so the next upload of that history must replace again. A dropped first upload
   leaves a **stub** (F3.4): the session's pointer with no trace, holding who wrote it, where
   its log ends and a hash of the records before that, never their text. The next upload
   continues from there like any session's (a chunk from `bytes_total`, or a whole log that
   extends it, of which only the tail is reviewed and stored), so the stored trace starts after
   the dropped part. A stub is not listed or served (`404`), is not on another reader's change
   feed and is not searched; its owner or an admin can delete it or change its visibility, and
   the uploading machine can retract it. See [model-review.md](model-review.md).
6. **Write** the trace, the change entry, then the session's `metadata.json` (the entry goes
   first, so no change goes unannounced; a write that fails after it leaves an entry readers
   find already answered by the metadata).

**Rebuilding (X4.9).** `rebuild` builds the session again from the whole log and reviews it
again, even when the log only extends what is stored (where step 4 would answer `unchanged` or
write only the tail): it replaces the session as `replace` does, with the same permission, the
retraction secret included for the org key. It is never a chunk (`422 bad_chunk`). Without an
idempotency key of its own, each rebuild gets a fresh one, so it is never answered from an
earlier upload of the same log. A rebuild that builds the very trace already stored answers
`duplicate`.

Each session's `metadata.json` records the format version that built it
(`normalizer.format_version`: the oldest of its traces, since a chunk leaves the prefix as it
was built). When a format's adapter changes what a transcript normalizes to, its version is
raised, and sessions built by an older one are **stale**. The server cannot rebuild them
itself (it keeps no raw logs), so `GET /v1/sessions/stale` (`sessions:write`, the uploader's
credential) lists the caller's own stale sessions, paged by key like `GET /v1/sessions`:

```jsonc
{ "sessions": [ { "format": "claude-code", "session_id": "…",
                  "built_with": "1+trajectory.0.4.4", "current": "2+trajectory.0.4.4" } ],
  "cursor": "…", "truncated": false }
```

The uploader asks at most hourly and resends each stale session it still holds, whole, with
`rebuild` ([capture.md](capture.md#the-uploader)). A session with no version recorded is
stale; a release that changes no adapter makes nothing stale.

**Which branch?** The one the transcript recorded as it began (Claude Code's `gitBranch`,
Codex's `session_meta`), else the client's `branch`.

**Where and with what it ran.** seshi's uploader also sends `repo` (the origin remote, else the
first, normalized to lowercase without credentials or port: `github.com/acme/widget`, however it
was cloned), `commit` (the sha
`HEAD` named when the agent's hook last fired, so an upload that waited names the commit its
lines were written at), `path_in_repo` (the working folder relative to the repository's root, absent at
the root) and `client` (`seshi/0.15.0 darwin-arm64`), all read from `.git` without running git.
The session keeps the first `repo` it is sent, so a remote renamed mid-session does not move it;
`commit`, `path_in_repo` and `client` go on each upload's trace metadata. `project` stays the
client's own label (the repository's folder name). These are labels, never a reason to refuse
a session: one that is not fit to keep is left out and the session stored all the same (a `repo`
with user info or a scheme, an absolute `path_in_repo` or one with `..`, a `commit` that is not
a sha, anything over 1,024 characters). For a log that names no
harness version or model (Cursor's), the uploader sends what Cursor's hooks said as
`harness_version` and `model`: the server uses them only where the log has none. The session's
metadata then carries `agent_version` and `models` (every model its LLM
calls named, or its meta record's when none did); the harness is its `source`. For a log that
names its version (Claude Code, Codex), `agent_version` is the version the session started on:
a continuation keeps the meta record of the session's first upload, so the stored log stays a
prefix of itself, and a session resumed under a newer version keeps the older one. A hinted
version (Cursor's) is the one at the latest upload.

`201` when a trace was written, `200` otherwise:

```json
{ "status": "stored", "archive_id": "…", "content_hash": "…", "session_id": "…",
  "records": 3, "events": 2, "records_total": 7, "prefix_sha256": "…", "bytes_total": 48213 }
```

`records` is what this upload wrote; `records_total` and `prefix_sha256` describe the whole
normalized session; `bytes_total` is how much of the log the server now holds, where the next
chunk starts. Every status returns them; a session the server holds nothing of (`filtered`)
answers zeros, and a dropped first upload answers its stub's offset. The statuses are
`stored`, `duplicate`
(that trace was already stored), `unchanged`, `filtered` and `dropped`.

**Resends.** Every upload has an idempotency key: the `Idempotency-Key` header, else
`idempotency_key`, else one derived from the session, the offset and a digest of the
transcript (with a fresh suffix for a `rebuild`). A session remembers the last 16 it applied with their answers, so an upload sent
again (the client lost the answer) gets the same answer, status code included, and nothing
runs twice.

`422` with a code is final for that upload (resending the same bytes cannot succeed), and
nothing is stored: `unsupported_agent`, `too_large` (over `limits.max_upload_bytes`, or a
trace over the record caps), `redacted`, `empty` (a blank transcript), `bad_chunk`,
`normalize_<code>`, `invalid`. A log the adapter reads but finds no conversation in yet (a
session that has only started) is `filtered`, not an error. `413 too_large` is a request
body that, decoded (gunzipped), is larger than any upload can need: twice
`limits.max_upload_bytes` plus 1 MiB. `502 storage_error` is the bucket failing and is
retryable.

#### Labels

`labels` are small key/value strings the uploader resolved from its config
([config.md](config.md#labels)): keys `[a-z0-9][a-z0-9._-]{0,63}`, values 1 to 512 characters,
at most 32. An upload with labels out of those limits is refused with `400 bad_field`, saying
which. Label values are redacted with the session's rules, as its text is. A session's labels
are set by the first write that carries any and kept on its metadata
(`labels`); a later upload with other labels does not change them, and a `replace` (or a
`rebuild`) may. Each trace also records the labels its write carried (`metadata.labels`). A
source's own `labels` ([above](#sources)) win over the upload's. `GET /v1/search` filters by
them ([search.md](search.md)).

#### In chunks

A session's log only grows while the session runs (every harness appends a line per event), and
a client need not send the whole of it each time: it sends the bytes past what the server has.

```jsonc
{ "format": "claude-code", "session_id": "…",
  "transcript": "<the log from byte 48213 on, whole lines>",
  "offset": 48213 }                // the bytes_total of the last answer
```

`offset` must be the session's `bytes_total` (what the last answer said; the session's
`metadata.json` holds it as `normalized.bytes`), else `409 offset_mismatch` with `expected` in
the error and nothing stored: the client resends from `expected`, or from 0 (the whole log)
when it no longer has that. A chunk is whole lines of a `jsonl` log (it ends with a line
break; an OpenCode `json` export and an ATIF document cannot be chunked): `422 bad_chunk`
otherwise.

Until a session has a trace, the server stores nothing of it and takes only the whole log
(X6.3): the first upload of a session is the whole log (`offset` 0), and a chunk for a session
without a trace (never sent, or filtered so far) gets `409` with `expected: 0`. An uploader
resends the whole log from the start; once the session passes the filter, it sends chunks. A
session whose first upload model review dropped has a stub instead, and takes chunks from
the stub's offset as a session with a trace does.

A chunk is normalized on its own (the records those lines stand for), redacted with the
session's withheld calls (a result can come in a later chunk than its call), and written as a
continuation of the session's trace: the meta record plus the chunk's records, marked with
where they start, exactly what a whole upload would have written for the same growth. The
server keeps what the continuation needs between chunks (bytes covered, records so far, the
prefix hash mid-stream, the withheld call ids), so a chunk sends nothing else; `records_total`
and `prefix_sha256` in the answer are still the whole session's. A chunk with no records in
it (progress and transport lines) moves `bytes_total` on and writes nothing (`200
unchanged`). A chunk is never judged by the session filter: the session's first trace was.

The cut between chunks is the client's: a line boundary, anywhere. A log that the harness
rewrote in place (Claude Code and Codex rewrite nothing; a harness that compacts its history
might) is the client's to notice, by keeping a hash of what it sent: the whole log is then
sent with `replace`, since it no longer extends what the server holds.

`format` is part of the archive id (`sha256(owner, format, session_id)`), which is why only the
trajectory source name is accepted (`claude-code`, not `claude`): one spelling, one archive.
Before seshi 0.16 the body named the format `agent` and the encoding `format`; the server still
reads a body with `agent` that way, so uploaders installed before keep working.

