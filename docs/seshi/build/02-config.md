# 02 · Config (F1)

Branch `seshi-02-config`, on `seshi-01-restructure`. `@seshi/config` loads the server's
`seshi.toml` and the CLI's own `config.toml` from flags, `SESHI_*` env, TOML and defaults
against one strict zod schema each, with provenance for every value and secret references.
`seshi serve` is configured by it (the pre-seshi env names are gone), and `seshi config
check|show` validate and print it. Reference: [docs/config.md](../../config.md).

## What was built

- **Loader** (`packages/ts/config/src/load.ts`, `loadConfig(schema, options)`). Precedence
  flags > env > file > defaults (F1.1). Unknown keys fail start-up, from the file or as a
  `SESHI_*` name, and every problem is reported at once with its origin (`store.urll: unknown
  key (in /etc/seshi/seshi.toml)`, `filter.min_chars: … (from env SESHI_FILTER__MIN_CHARS)`).
  TOML is read with `Bun.TOML.parse`. Pure: env, files (`ConfigFs`), platform and cwd are
  options; each call returns its own `Loaded { config, file, origins, warnings, shape }`.
- **Which file** (`paths.ts`): `findServerConfig` = `--config`, `SESHI_CONFIG`, `./seshi.toml`,
  `/etc/seshi/seshi.toml`; a named file must exist. `./seshi.toml` only with `trustCwdConfig`, which
  only `seshi serve` passes (a checkout's file could aim secret references at its own bucket);
  otherwise a `./seshi.toml` that is there comes back as `skipped`, and the command prints a
  hint to pass `--config ./seshi.toml` (`server-instance.ts` `cwdConfigHint`). `cliConfigPath` =
  `%APPDATA%\seshi\config.toml` on Windows, else `$XDG_CONFIG_HOME/seshi/config.toml`, else
  `~/.config/seshi/config.toml`. `loadServerConfig` / `loadCliConfig` (`configs.ts`) wrap both.
- **Env mapping** (`layers.ts`, F1.2): `SESHI_` + upper-cased path, `__` between levels. Values
  are coerced by the field's type (numbers, booleans, comma lists or JSON arrays, durations,
  sizes); empty values are unset. Map keys (`[auth.tokens]`) match the file's keys written the
  env way or are added lower-cased. `[[sources]]` are file-only; env overrides a field by id
  (`SESHI_SOURCES__DATADOG_PROD__API_KEY`; ids are words joined by single `-`, so the env
  form never holds `__`). A secret can be set as a reference from env
  (`…__API_KEY__FILE=/path`). The server skips names the CLI schema owns (`SESHI_USER`,
  `SESHI_THEME`, `SESHI_SERVER`) and the CLI skips the server's (`foreign` option);
  `SESHI_CONFIG` is never a setting.
- **Shape from JSON Schema** (`shape.ts`). The loader and `config show` read the schema's
  *input* JSON Schema (`z.toJSONSchema(…, { io: "input" })`) rather than zod internals: which
  keys exist, maps vs tables vs lists of tables, union branches by `type` const, and the
  `x-seshi-secret` / `x-seshi-format` (`duration` | `bytes`) markers set with `.meta()`.
- **Secrets** (`secret.ts`, F1.3): `secret()` accepts a literal, `{ env }` or `{ file }` and
  parses to a `Secret` (masked in `String`, JSON and `inspect`; `reveal()` to read). The loader
  resolves every reference at load (`resolveSecrets: false` for `show`) and warns when the file
  holds a literal secret and `mode & 0o077` (not on Windows).
- **Units** (`units.ts`): `duration()` (`"30d"` or ms) and `bytes()` (`"32MiB"` or bytes) parse
  to numbers; `formatDuration`/`formatBytes` print them back.
- **Server schema** (`src/server/`, one file per section, composed in `server/index.ts`):
  `server` (listen, public_url, roles), `store` (url, credentials, region, endpoint,
  account_id, format, deployment_id, org), `auth` (tokens, legacy_token_secret, org_key.enabled,
  oidc{issuer, client_id, audience, owner_claim, admin_group}, admins, owner_aliases,
  session_keys, session_key_id), `default_visibility`, `filter`, `limits`, `records`,
  `redaction.packs`, `review.policies`, `sources` (discriminated by `type`: otlp, datadog, s3),
  `search`, `worker`, `capture.allow_retract`. Cross-field checks: unique source and policy
  ids, `upload` reserved, an `s3` source may not overlap `store.url` (F6.4), `session_key_id`
  names a key (required with two or more), policy `sources` exist. Helpers: `filterFor(config,
  sourceId)`, `signingKeyId(config)`, `parseListen`.
- **CLI schema** (`cli.ts`): `server`, `user`, `theme` (auto|dark|light), `capture.enabled`,
  `[[capture.paths]] { path, capture }`.
- **Show / check** (`show.ts`, `check.ts`): `configEntries(loaded)` lists every value with its
  origin, secrets as `<secret: env NAME>`, durations and sizes in units; `displayTree` nests
  them. `checkServerConfig` warns about `owner` visibility without an IdP (X5.10), relaxed
  `require_user`/`require_reply`, review steps without a key, and names every provider review
  sends data to (F3.5).
- **JSON Schemas** (F1.4): `configJsonSchemas()`; `bun run schema` writes
  `spec/config.schema.json` and `spec/cli-config.schema.json`; `bun run check` runs
  `check:schema`, which fails when they are stale (also tested in
  `scripts/config-schema.test.ts`).
- **Pipeline and API.** Fixed limits and the worthiness rules became options with today's
  defaults, named as in the config: `DEFAULT_LIMITS` / `Limits` (`max_records`,
  `max_records_bytes`, `max_upload_bytes`; replaces `LIMITS`) and `DEFAULT_FILTER` /
  `FilterRules` (`enabled`, `min_chars`, `require_user`, `require_reply`), taken by `ingest`,
  `putRaw`, `storeSession` (`SessionOptions.filter`/`limits`), `StoreSeshi` and
  `createApp`. The filter judges a session's first trace only: chunks that continue a head,
  and (since review) a whole upload's tail past `shipped` when the session has a head, are
  never filtered; `shipped` is ignored until the session has a head, so a session that was
  `trivial` is judged whole again (tested in `session.test.ts`).
- **`seshi serve`**: `--config`, `--listen`, `--roles`, `--set path=value` (node `parseArgs`,
  strict). `serve-settings.ts` holds the pure checks (`serveSettings(config)`: owner names,
  16+ char tokens, no duplicate tokens, 32+ char legacy secret, at least one way in, `api` in
  roles) and `configFlags`. Errors print as `seshi: …`, exit 1; warnings as `seshi: warning: …`.
  Store region/endpoint/account/credentials come from `[store]`. `redaction.packs` merges any
  number of JSON packs. `maxRequestBodySize` is `max(256 MiB, limits.max_upload_bytes)`.
- **`seshi config check|show`** (`apps/seshi/src/commands/config.ts`), `--cli` for the CLI's
  config, `--json`, `--origin` (show), `--config`, `--set`.
- **Docs and deployment**: `docs/config.md` (every setting; a test checks every section and
  key is mentioned), `seshi.example.toml` (tested valid), `docs/server.md`, README, SECURITY,
  `spec/openapi.yaml` wording, `.env.example` (tested: every name is a setting, and the file
  loads), `compose.yaml` (`HOST_PORT`; service and volume names kept so volumes survive), the
  Dockerfile (no `PORT`), and the CI docker smoke test now use `SESHI_*`. The image was built
  and booted locally with `SESHI_*` env; `/healthz` answers.

## Extension points for later branches

- **A config section:** add or refine its file in `packages/ts/config/src/server/<section>.ts`
  and one line in `server/index.ts` (the schema index); then `bun run schema` and document it
  in `docs/config.md` (`tests/config/docs.test.ts` fails on an undocumented key). Use
  `secret()` for any credential, `duration()` / `bytes()` for times and sizes, `.prefault({})`
  on tables whose fields all have defaults (so defaults apply when the table is absent),
  `.describe()` on every field (it lands in the JSON Schema). Fields marked *later* in
  config.md are typed placeholders; the owning branch gives them effect and may tighten them.
- **Reading config:** build from `loadServerConfig({ configFlag, env, flags })` once and pass
  `loaded.config` (type `ServerConfig`) down, e.g. into the Instance (06). Never read
  `process.env` for a setting. Secrets are `Secret`; call `reveal()` where the value is used,
  and never log it. Per-source filter: `filterFor(config, sourceId)`; uploads use
  `UPLOAD_SOURCE_ID` (`"upload"`).
- **Flags:** a command maps its own flags to paths with `FlagValue { name, path, value }`;
  `configFlags` in `apps/seshi/src/commands/serve-settings.ts` handles `--listen`, `--roles`,
  `--set` for any server command.
- **CLI config (13, 14):** `loadCliConfig({ home, env, platform })`; `CliConfig` has `server`,
  `user`, `theme`, `capture.enabled`, `capture.paths` (paths kept as written; expand `~` where
  used). Add CLI keys in `src/cli.ts` and regenerate the schema.
- **Server-start checks:** add them to `serveSettings`, so `seshi config check` reports them too.
- **Pipeline:** `SessionOptions.filter` / `.limits`; 04 renames worthiness to the session filter
  and records filtered sessions in source health; `FilterRules` already uses the config's
  names, so `config.filter` (or `filterFor`) passes straight through.

## Deviations and why

- **`require_user = false` / `require_reply = false` have no effect yet.** Today's trace format
  (`parseTrajectory`) refuses a whole session without a user record or a reply as `invalid`
  (422). Honouring the flags would turn a quiet "not stored" into a final rejection, so such a
  session stays `trivial` whatever the rules say; `config check` warns. They take effect when
  the canonical format (03/04) accepts such sessions. `enabled = false` likewise keeps every
  session that *can* be a trace.
- **The bucket client still falls back to the standard `AWS_*` / `S3_*` / `R2_*` variables**
  (and `AWS_REGION`, `S3_ENDPOINT`, `R2_ACCOUNT_ID`) when `[store]` does not set them. These
  are the S3 tooling's ambient credentials, not seshi settings; F1.2's "only `SESHI_*`" is read
  as "no aliases for the pre-seshi env names". `[store]` values win.
- **`PORT` is not read.** Platforms that inject `PORT` (Cloud Run) need
  `SESHI_SERVER__LISTEN=:$PORT` or a container port of 7200.
- **`auth.legacy_token_secret`** keeps today's HS256 signed tokens working until 05 decides
  (X5.2 drops them). Static tokens moved from `name:token` pairs to a map,
  `[auth.tokens] owner = token` (`SESHI_AUTH__TOKENS__<OWNER>`); the old single token (owner
  `default`) is `SESHI_AUTH__TOKENS__DEFAULT`.
- **`store.format`** (letta|otlp) is kept, transitional, because the server still writes one of
  the two; 03 replaces it with the canonical format.
- **`redaction.packs` are today's JSON files** (any number, merged); TOML packs are F2.1 (07).
- **Unknown env names fail, except the other config's and secret targets.** A shared
  environment holds both the CLI's and the server's `SESHI_*` names, so each loader skips
  names only the other schema knows, rather than failing on them. A `SESHI_*` variable that a
  secret reads (`{ env = "SESHI_DD_KEY" }` in the file, or the value of a `…__ENV` variable)
  is skipped too; the CLI does not see the server file's references, so such a variable in a
  shared environment would still trip the CLI's loader.
- **`import * as z from "zod"`, not `import { z }`.** Under Vitest with the `bun` condition the
  named `z` export of zod 4.6 is `undefined`; the namespace import works everywhere.
- **The CLI config honours `XDG_CONFIG_HOME`** when set, beyond the decision's
  `~/.config/seshi/config.toml`.
- **Messages and banner say `seshi`** (`seshi: …`, `seshi <v> listening on …`); the layout
  marker's client keeps its pre-seshi name until 03 changes the layout.

## Still to check

- Dosu's deployment (in dosu-ai/dosu) sets the pre-seshi token, token-secret and R2
  variables; it must move to `SESHI_AUTH__TOKENS__*`,
  `SESHI_AUTH__LEGACY_TOKEN_SECRET`, `SESHI_STORE__URL` and a listen address before it runs a
  seshi image.
- Poller timing defaults (`interval`, `overlap`, `lag`, `backfill`, `quiet_period`) and the
  review provider list are provisional; 09–11 and 08 confirm or change them.
- `deployment_id`, `org`, `org_key`, `oidc`, `admins`, `owner_aliases`, `session_keys`,
  `default_visibility`, `records`, `review`, `sources`, `search`, `worker`, `capture` are
  validated but unused until their branches.
- CI has not run on this branch (no PR); the docker job's new env names were checked by
  building and booting the image locally.

## Review fixes

- Whole uploads with `shipped` filtered their fresh tail, so an agent-only or short tail past
  a stored head came back `trivial` while the answer said it shipped: lost for good (the team's
  known gotcha). Fixed in `wholeStored`; docs/server.md and spec/openapi.yaml say so.
- `{ env = "SESHI_…" }` secret references stopped start-up as unknown settings; now skipped.
- `--set` flags are named with their path (`--set store.url`) in errors and origins.
- Source ids with `--` or a leading/trailing `-` are refused (unreachable from env).
- docs/sdk.md suggested a `SESHI_TOKEN` variable, which is not a setting and would stop a
  server sharing that environment.
