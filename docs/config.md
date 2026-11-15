# Configuration

`seshi serve` reads one config, built from four layers (F1.1). A higher layer wins:

1. **Flags**: `--listen`, `--roles`, and `--set path=value` for any setting.
2. **Environment**: `SESHI_*` variables (Bun also reads `.env` from the working directory).
3. **The TOML file**: `--config <file>`, else `SESHI_CONFIG`, else `./seshi.toml`, else
   `/etc/seshi/seshi.toml`. A file named by `--config` or `SESHI_CONFIG` must exist; the
   other two are used when present. With no file, the config is env and defaults.
4. **Defaults**: today's values, listed below.

The schema is strict: an unknown key, in the file or as a `SESHI_*` name, stops the server
from starting, and every problem is reported at once with where its value came from. Changes
apply on restart (F1.5). The config is the operator's: nothing in it can be set over the API,
and it is not stored in the bucket.

[`seshi.example.toml`](../seshi.example.toml) is a commented example.
`spec/config.schema.json` is the JSON Schema for editors (Taplo / Even Better TOML: add
`#:schema ./spec/config.schema.json` at the top of the file, or map it in the editor's
settings).

## Checking and showing it

```sh
seshi config check                 # validate, read every secret reference, print warnings
seshi config show                  # every value, secrets masked
seshi config show --origin         # ... and where each came from: flag, env, file, default
seshi config show --json [--origin]
```

`check` exits 0 when `seshi serve` could start with the config, 1 when not. It runs the same
checks `serve` does (tokens long enough, a way to call the server), warns about settings that
do less than they say (a literal secret in a file others can read, `owner` visibility without
an IdP), and names every provider a review policy sends data to. `show` does not read secret
references, so it works where those files or variables are not present. Both take `--config`
and `--set`, and `--cli` for the CLI's own config (below).

## Environment names

`SESHI_` plus the TOML path in upper case, with `__` between levels (F1.2):

| TOML | Env |
|---|---|
| `[store] url` | `SESHI_STORE__URL` |
| `[auth.oidc] issuer` | `SESHI_AUTH__OIDC__ISSUER` |
| `[auth.tokens] alice` | `SESHI_AUTH__TOKENS__ALICE` |
| `[[sources]] id = "datadog-prod"`, `api_key` | `SESHI_SOURCES__DATADOG_PROD__API_KEY` |

- Values are read as the field's type: numbers, `true`/`false`, durations (`30d`), sizes
  (`32MiB`), and lists as comma-separated text (`SESHI_SERVER__ROLES=api,worker`) or JSON.
- An empty value counts as unset.
- A key in a table of your own names (`[auth.tokens]`, `[auth.owner_aliases]`,
  `[auth.session_keys]`) matches the file's key written the env way (upper case, anything but
  letters and digits as `_`: `alice.smith@acme.com` is `ALICE_SMITH_ACME_COM`), or is added in
  lower case.
- `[[sources]]` are defined in the file only, each with an `id`; env can override a field of
  one by its id (upper case, `-` as `_`).
- A secret can be given as a reference from env too: `SESHI_AUTH__LEGACY_TOKEN_SECRET__FILE=/run/secrets/jwt`.
- Only `SESHI_*` names are read. Today's `SESSIONDB_*` names are not.
- A `SESHI_*` name that is not a setting stops the server, except the ones below and a
  variable a secret reads (`{ env = "SESHI_DD_KEY" }`, or the value of a `…__ENV` variable),
  which holds a value, not a setting.
- `SESHI_CONFIG` names the file and is not a setting. Names that belong to the CLI's config
  (`SESHI_USER`, `SESHI_THEME`, `SESHI_SERVER`) are skipped by the server, and the server's by
  the CLI.

## Secrets

Any secret field takes a literal, `{ env = "NAME" }`, or `{ file = "/path" }` (F1.3), so the
file can be committed:

```toml
[store.credentials]
access_key_id = { env = "AWS_ACCESS_KEY_ID" }
secret_access_key = { file = "/run/secrets/bucket-key" }
```

References are read at start-up: a missing variable or file stops the server and names the
setting. A file's trailing newline is dropped. The server warns when the config file holds a
literal secret and group or others can read it. `config show` prints secrets as
`<secret: env NAME>`, `<secret: file /path>` or `<secret>`, never their values. The config file
and the environment hold connector credentials: protect them like the bucket keys.

## Durations and sizes

Durations are `<n><unit>` with `ms`, `s`, `m`, `h`, `d` or `w` (`"30d"`), or an integer of
milliseconds. Sizes are `<n><unit>` with `B`, `KB`, `MB`, `GB`, `KiB`, `MiB` or `GiB`
(`"32MiB"`), or an integer of bytes.

## Settings

Fields marked *later* are typed and validated now, so a config can be written ahead; the
branch that builds the feature gives them their effect.

### `[server]`

| Key | Default | |
|---|---|---|
| `listen` | `":7200"` | `host:port`, `:port` (every interface) or `port`; `[::1]:7200` for IPv6. Flag `--listen` |
| `public_url` | | The URL clients reach the server at, behind any proxy. *Later* (sign-in) |
| `roles` | `["api", "worker"]` | What this instance runs (X7.1). Flag `--roles`. The worker role has no jobs yet, so `api` is required |

### `[store]`

| Key | Default | |
|---|---|---|
| `url` | required | `s3://bucket/prefix`, `r2://bucket/prefix`, or `file:///path` for one machine |
| `credentials` | | `access_key_id`, `secret_access_key`, `session_token` (secrets). Without them the bucket client falls back to the standard `AWS_*` / `S3_*` variables (`R2_*` for `r2://`), like any S3 tool |
| `region` | | `s3://`. Falls back to `AWS_REGION` |
| `endpoint` | | S3-compatible services (MinIO, Backblaze, Wasabi). Falls back to `S3_ENDPOINT` |
| `account_id` | | Cloudflare account for `r2://`. Falls back to `R2_ACCOUNT_ID` |
| `deployment_id` | generated | This deployment's id, recorded in the layout marker `seshi.json` the first time a server uses the bucket. A server whose `deployment_id` differs from the marker's refuses to start (X1.4). Without it, the first server generates one and later servers accept whatever the marker says |
| `org` | | The organization the deployment serves (X1.1). Recorded in the marker the first time a config names it; a server naming another org refuses to start (X1.4) |

Traces are always stored in seshi's one canonical format (`seshi/trace/1`, X6.2) and rendered as Letta, OTLP or ATIF on read (`GET …/trace?format=`). A bucket written by sessiondb (`sessionstorage.json`) is refused: there is no migration (X1.5), so point `url` at a new prefix.

### `[auth]`

| Key | Default | |
|---|---|---|
| `tokens` | `{}` | Static tokens: `owner = token` (secrets, 16+ characters), each everything for that owner. For one person and development (X5.12). `owners/<owner>/` is where their sessions go |
| `legacy_token_secret` | | Also accept HS256 JWTs signed with this secret (`sub` the owner, `exp` required), 32+ characters. Kept from sessiondb until seshi tokens replace it (X5.2) |
| `org_key.enabled` | `true` | The trusted org key (X5.12). *Later* |
| `oidc` | | `issuer`, `client_id`, `audience`, `owner_claim` (default `"sub"`), `admin_group`. *Later* |
| `admins` | `[]` | Admin emails with an IdP (X5.3). *Later* |
| `owner_aliases` | `{}` | `old = "new"` owner IDs (X5.8). *Later* |
| `session_keys`, `session_key_id` | `{}` | Keys that sign session tokens, by id (secrets), and which one signs (required with more than one). *Later* |

`seshi serve` needs at least one of `tokens` and `legacy_token_secret` today.

### `default_visibility`

`"org"` (default) or `"owner"` (X5.10). *Later*. Without an IdP the org key reads every
session, so `config check` warns that `owner` is not enforced.

### `[filter]`

The session filter (X4.10), once called worthiness. It judges a session's first trace only:
once a session has a trace, every chunk and every whole-upload tail that continues it is
stored. A filtered session is not stored at all (the upload answers `filtered`); it is only
counted in the source's health counters, so a source that sends too little shows up there.

| Key | Default | |
|---|---|---|
| `enabled` | `true` | `false` stores every session that can be a trace |
| `min_chars` | `2000` | Characters of text, tool arguments and tool results, the meta record aside |
| `require_user` | `true` | At least one user record |
| `require_reply` | `true` | At least one assistant or tool record |

A source can override any rule in `[sources.filter]`; uploads use `[filter]` itself. Today's trace format needs a user record
and a reply, so `require_user = false` and `require_reply = false` have no effect yet (and
`config check` says so); a session without them is not stored either way.

### `[limits]`

| Key | Default | |
|---|---|---|
| `max_records` | `50000` | Records in one trace |
| `max_records_bytes` | `"32MiB"` | JSON bytes of one trace's records |
| `max_upload_bytes` | `"256MiB"` | Bytes of one upload's transcript as sent (before any gzip of the request); nothing of it is stored. A request body, decoded, is refused (`413`) past twice this plus 1 MiB |

Past a limit the session is refused with 422 `too_large`.

### `[records]`

`dropped_retention` and `failed_retention`, both `"30d"`: how long drop and failure records
are kept (X6.4). *Later*.

### `[redaction]`

`packs`, default `[]`: rule pack files applied on top of the built-in rules, which always run.
Today a pack is the JSON file sessiondb took (`patterns`, `sensitive_files`,
`secret_commands`; see [server.md](server.md#your-own-redaction)); TOML packs come with F2.1.
The server refuses to start on a pattern that is not usable, naming the file.

### `[review]`

`[[review.policies]]` (F3), none by default, so nothing is sent anywhere. *Later*. Each has
`id`, scope lists `sources`, `agents`, `repos` (empty is all), `on_failure` (`"drop"` or
`"skip"`), `retries` (`3`), and `decision` and `redactor` steps: `provider` (`anthropic`,
`bedrock`, `vertex`, `openai-compatible`), `model`, `prompt` or `prompt_file`, `api_key`
(secret), `base_url`; the redactor also takes `categories` (`name`, `description`, `examples`).

### `[[sources]]`

What the server ingests from on its own (F4–F6). Each has an `id` (lower-case letters and
digits, words joined by single `-`; not `upload`, which uploads use), a `type`, `enabled` (`true`), `visibility`, and `filter`
overrides. Each writes as its service account `svc:<id>` (X5.4). *Later*; the poller timings
are provisional until their branches confirm them.

| Type | Fields |
|---|---|
| `otlp` | `quiet_period` (`"10m"`) |
| `datadog` | `site` (`"datadoghq.com"`), `api_key`, `app_key` (secrets), `ml_app`, `tags`, `interval` (`"5m"`), `overlap` (`"10m"`), `lag` (`"2m"`), `backfill` (`"7d"`) |
| `s3` | `url`, `prefix`, `credentials` or `role` (`arn`, `external_id`), `region`, `endpoint`, `account_id`, `include` globs, `format` (`"auto"`), `ordered_keys` (`false`), `interval` (`"5m"`) |

Ids are unique, and an `s3` source may not read seshi's own bucket and prefix (F6.4).

### `[search]`, `[worker]`, `[capture]`

| Key | Default | |
|---|---|---|
| `search.enabled` | `true` | *Later* (F10) |
| `search.backend` | `"sqlite"` | |
| `search.path` | | The index file on local disk |
| `worker.heartbeat_interval` | `"1m"` | *Later* (X7.5) |
| `capture.allow_retract` | `true` | Let the uploading machine retract a session (F9.7). *Later* |

## The CLI's config

The CLI keeps its own file, `~/.config/seshi/config.toml` (`$XDG_CONFIG_HOME/seshi/config.toml`
when set, `%APPDATA%\seshi\config.toml` on Windows), loaded the same way with its own strict
schema (`spec/cli-config.schema.json`). `seshi config check --cli` and `seshi config show --cli`
read it.

```toml
server = "https://seshi.acme.internal"   # SESHI_SERVER
user = "alice@acme.com"                  # SESHI_USER: the username stated with the org key
theme = "auto"                           # SESHI_THEME: auto, dark or light

[capture]
enabled = true                           # SESHI_CAPTURE__ENABLED

[[capture.paths]]                        # personal rules by folder, longest match wins (F9.5)
path = "~/clients/acme"
capture = false
```
