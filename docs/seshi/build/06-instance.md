# 06 · Instance, worker roles, the binary (X1.2, X1.4, X7, X3.3, X3.5, X2.2)

Branch `seshi-06-instance`, on `seshi-05-auth`. Everything one deployment runs now hangs off an
`Instance` built from one config. The HTTP routes take an Instance. The server has worker
roles with a job runner, a heartbeat and job status. Connectors have a real contract and a
scheduler. Local mode replaces the direct-to-bucket client. `seshi` registers every F8.1
command. The Docker image is built from the compiled binary.

## What was built

- **`@seshi/instance`** (layer 4):
  - `buildInstance(config, options)` does the I/O, in this order: open the bucket
    (`storeOptions(config)`, or `options.store`); read `redaction.packs`
    (`readRedactionPacks`); check the layout marker with `ensureLayout` (X1.4: deployment, org,
    no sessiondb prefix); assemble the Instance; probe the static tokens' owners. Every failure
    is an `InstanceError` with an operator message.
  - `new Instance(parts)` assembles the rest with no I/O, so tests build Instances
    synchronously and in parallel (X1.2). Each Instance has its own:
    - `auth` (from `authSettings`);
    - `pipeline` (`ownershipAuthorizer`, `filterFor` and `visibilityFor` per source);
    - `health` (`StoreHealthCounters`, its shard named by the stable instance id);
    - `sources` (the scheduler) and `jobs` (the runner).
    The only module-level values are immutable: `BUILTIN_JOBS` and `quietLogger`.
  - Ids:
    - `id` is the stable instance id: `server.instance_id`, else the sanitized host name. It
      names the health shard, so a restart keeps it. This answers 04's open item.
    - `process` is `<id>-<8 hex>`, unique per run. The heartbeat uses it to tell two workers on
      one host apart.
  - `instance.sessions(identity)` is a `StoreSessionDB` over the shared pipeline; the routes
    build one per principal. `instance.localSessions(owner)` is local mode's: writer `local`,
    owner basis `verified`.
  - `close()` stops the jobs, then flushes source health. Each step is bounded.
- **Jobs (X7.1–X7.5)**, in `jobs.ts` and `builtin-jobs.ts`:
  - `JobRunner`:
    - `register(job)` adds a job. Every job is registered on every instance, whatever its
      roles, so status can list all of them.
    - `start()` runs the jobs this instance's roles call for. Placement `worker` runs on the
      worker only; `every` runs on all instances (for the indexer, 12).
    - A run that returns `more` runs again at once. A failed run is retried after 5 s
      (`RETRY_BASE_MS`), doubling per failure in a row up to the interval (X4.8: retries with
      backoff); a success resets it. Otherwise the next run waits for the interval.
    - It keeps a `JobRecord` per job: runs, failures, last start and finish, last outcome
      (`ok`, `error`, `discarded`), the last error until a later run succeeds, and the last
      summary.
    - `runNow(name)` runs a job immediately; if that job is already running, it waits for that
      run instead. `stop(timeout)` aborts running jobs and waits for them, bounded.
  - Built-in jobs:
    - `heartbeat`: writes `worker/heartbeat.json` every `worker.heartbeat_interval`, with
      `host`, `interval_ms` and every job's record (the `Heartbeat` type gained these fields).
      If it finds another process's heartbeat, written since this process started and still
      fresh, it names that process in `others` (X7.3). A predecessor's last beat after a
      restart does not count.
    - `retention`: every 6 h it runs `pruneRecords` on `dropped/` and `failed/`
      (`[records]`), and the new `pruneHealth` on health days older than the new
      `records.health_retention` (90 days).
    - `source:<id>`: one per polled source, on the source's `interval`. Its backlog is
      `checkpoint_age_ms`.
  - Status (`instanceStatus` / `instance.status()`):
    - `assessWorker` sets `state`: `running`, `stopped` (heartbeat older than 3 intervals),
      `never`, or `several`.
    - It lists every job with its record and a live backlog. A job that runs on the worker
      takes its record from the heartbeat; an `every` job takes it from this instance.
    - It lists every source with its checkpoint, drop and failure counts and 7 days of health:
      the configured ones, `upload`, and any source that has records but is no longer
      configured.
    - It returns warnings. `GET /v1/admin/jobs` (`sources:admin`) and `seshi workers status`
      print it.
- **Connectors (X3.11) in `@seshi/kit`.** This replaces the placeholder:
  - `Connector { kind, run(ctx), rewind?(cursor, since, config) }`.
  - `ConnectorContext { source {id, type, config}, submit(envelope), checkpoint {read, write},
    fetch, log, signal, now }`.
  - Also `CheckpointLost`, `SubmitOutcome`, `ConnectorRunResult { more, lag_ms }`, `Cursor`,
    and `connectorsOf(integrations)`, which refuses two connectors for one type.
- **`@seshi/sources`** (layer 3), the class `Sources`:
  - `list()` and `polled()`: a source is polled when it is enabled and a connector for its
    type is in the binary. Otherwise a `note` says why.
  - `run(id, {signal, force})`:
    - It reads the checkpoint once, at the start. `checkpoint.write` uses If-Match over that
      version.
    - A 412 throws `CheckpointLost`, and the run becomes `discarded` (X7.3). After that,
      nothing more is accepted from the run, even if the connector swallowed the error.
    - `submit` refuses an envelope for another `source_id`, submits with
      `onFailure: "record"`, and counts the outcomes.
    - A connector error, or a transient store error, makes the outcome `error` and leaves the
      checkpoint where it was. Once a `submit` has thrown (transient, X4.8), `checkpoint.write`
      refuses for the rest of the run and the outcome is `error`, even if the connector caught
      the error and went on.
    - When the run has been reported, its context refuses further submits and writes.
    - It refuses a disabled source (unless forced), a pushed source, and a second run of the
      same source in one process.
  - `status(id)`.
  - `rewind(id, {since, dryRun})` (X4.9): back to the start (the checkpoint is deleted with
    If-Match, using the new `deleteCheckpoint`), or to `since` through `connector.rewind`.
    Uploads are refused.
- **HTTP** (`@seshi/api`): `createApp(instance)`. `AppOptions` and `TokenGrant` are gone.
  - New: `GET /v1/sessions/:agent/:session_id/export?format&hash`, the trace with
    `Content-Disposition: attachment`.
  - New: `GET /v1/admin/jobs`, the first route that checks `sources:admin`.
  - An instance without the `api` role answers `/healthz` only.
  - `spec/openapi.yaml` gains both routes, the `JobsStatus` and `JobRecord` schemas, and an
    `admin` tag. The openapi test sees every new status.
- **Local mode (X3.5).** `connect()` and `ConnectOptions` are removed from `@seshi/pipeline`,
  and pipeline no longer depends on `@seshi/client`. `local.ts` became `session-db.ts`
  (`StoreSessionDB`, without `check()`).
  - `apps/seshi/src/connect.ts` (`seshi/connect`): `connect({cli, env, token, user,
    integrations})` returns a `Connection` with `db`, `mode`, `instance` and `close`. It talks
    HTTP when the CLI config sets `server`. With `[local] config = "<server toml>"` it builds an
    Instance (`roles: []`, probing the owner) and returns `localSessions(owner)`.
  - The owner is `local.owner`, then `user`, then the OS user, made into an owner id with
    `usernameOwner`.
  - CLI config: a new `local` section; `server` and `local` cannot both be set.
- **apps/seshi**:
  - `cli/exit.ts` holds the stable exit codes: 0 ok, 1 failure, 2 usage, 3 config,
    4 notFound, 5 auth, 6 conflict, 7 unavailable, 8 attention, 9 notImplemented.
  - `cli/output.ts` holds the `--json` conventions (`takeJson`, `emit`, `fail`,
    `usageError`). `cli/stub.ts` holds `notImplemented`.
  - The registry lists every F8.1 group, each command in its own file, plus `healthcheck`
    for the image.
  - Built here: `serve`, `config`, `admin`, `workers status`, `sync run|status|failed|dropped`
    (`sync assemble` and `sync prune` added in 17-review),
    `reprocess`, `normalize`, `healthcheck`.
  - Stubs exit 9 and name their branch: `login`, `logout`, `whoami`, `sessions` and `tokens`
    (13); `capture`, `hook`, `upload`, `daemon` and `statusline` (14); `search` (12); `redact`
    (07).
  - `commands/server-instance.ts` (`openServer`, `serverFailure`) is what every command that
    needs the server config uses. Read-only commands (`workers status`, `sync status|failed|
    dropped`, `reprocess --dry-run`) pass `initialize: false`: `buildInstance` then refuses a
    bucket with no layout marker (exit 3) instead of writing one, so a mistyped `store.url` is
    not claimed as a new deployment by a status check.
  - `sync failed|dropped` also read a source that is no longer in `[[sources]]` but still has
    records (status lists those sources).
  - `serve` builds one Instance, serves it, starts the jobs, prints
    `checkServerConfig` warnings at boot (02's open item), prints a `roles:` line, and closes
    the Instance on SIGINT and SIGTERM, letting requests in flight finish (bounded, 5 s). A
    taken address exits 3 with a message.
  - `main.ts` has no top-level await, for bytecode.
  - `CommandContext.stdin` is new.
- **Hook budget (X3.3):** `scripts/check-hook.ts`.
  - The static check walks the load-time import graph from `main.ts`, `commands/hook.ts` and
    `commands/statusline.ts`. It skips `import type` and `import()`, and fails on api,
    instance, sources, search, pipeline, auth, store, jose or protobuf, naming the chain of
    files.
  - The timed check takes the median of 7 runs of `seshi hook claude-code Stop`. The budget is
    250 ms, and from source the hook must also take under half of what loading `serve` takes.
  - `bun run check` runs the static part. CI runs `check:hook` from source, and from
    `dist/seshi` after `bun run build`.
  - Measured locally: 15 ms from source, against 57 ms to load serve; 13 ms compiled.
- **Build:** `bun run build` runs `scripts/build-binary.ts`: `bun build --compile --minify
  --bytecode --conditions bun --no-compile-autoload-dotenv --no-compile-autoload-bunfig`, with
  `--target` and `--outfile`. A test compiles the binary and runs it. The two `no-autoload`
  flags matter: `seshi hook` runs in whatever repository the agent is in, and by default a
  compiled Bun binary reads that folder's `.env` and `bunfig.toml`, whose `preload` would run
  the repository's code inside the hook (checked against the built binary).
- **Image:** `apps/seshi/Dockerfile` is multi-stage.
  - The build stage runs on `$BUILDPLATFORM` and cross-compiles: `bun-linux-x64-baseline` for
    amd64, `bun-linux-arm64` for arm64.
  - The final image is `debian:bookworm-slim` with `ca-certificates`, user `seshi` (uid 1000,
    as the old `bun` user, so existing volumes stay writable), `ENTRYPOINT ["seshi"]`,
    `CMD ["serve"]`, and `HEALTHCHECK seshi healthcheck`. `healthcheck` reads `server.listen`
    from `SESHI_SERVER__LISTEN`, else from the TOML file serve would read (only that key, no
    secrets), else `:7200`.
  - `.dockerignore` keeps `scripts/build-binary.ts`.
  - compose: `command: ["serve"]`, and a note on splitting the roles.
  - CI's docker job also checks `--version`, `seshi healthcheck`, and a `running` worker in
    `workers status`.
- **Config:** new `server.instance_id`, `records.health_retention` and `[local]`. The schema
  JSON is regenerated, and docs/config.md is updated (the worker role is real now).
- **Docs:** new docs/cli.md (commands and exit codes). docs/server.md gains roles and
  background work, deploying from the binary, and the new routes. spec/layout.md covers the
  heartbeat fields, health retention and reprocess. README and docs/sdk.md drop `connect()`.

## Extension points for later branches

- **A new background job (09 assembler, 12 indexer):** write a `JobFactory`,
  `(host: JobHost) => Job[]`, and add it to `BUILTIN_JOBS` in
  `packages/ts/instance/src/builtin-jobs.ts`. That is a one-line, additive edit. A `Job` has:
  - `name`, `kind`;
  - `placement`: `worker`, or `every` for the indexer;
  - `intervalMs`;
  - `run(signal)`, which returns `{ outcome?, error?, more?, summary? }`;
  - optional `backlog()`, for example pending markers for the assembler.
  Status, the heartbeat and `/v1/admin/jobs` pick it up. If a job needs more than `JobHost`,
  add the field to `JobHost` and set it in the Instance constructor.
- **09's assembler** goes in through `InstanceParts.assembler`, which feeds the pipeline. Its
  job is a factory as above.
- **A connector (10 Datadog, 11 S3):** implement `Connector` from `@seshi/kit`, with `kind`
  equal to the source `type`.
  - Datadog: list it in its integration's `connectors`; `buildInstance({ integrations })`
    schedules it.
  - The S3 poller is vendor-neutral: add it to the connectors `apps/seshi` passes, or put it in
    `@seshi/sources` and add it where `openServer` builds the Instance.
  - Read the cursor with `ctx.checkpoint.read()`. Submit envelopes with
    `serviceIdentity(source.id)` fields, an X4.7 idempotency key and provenance. Only then call
    `ctx.checkpoint.write(cursor)`.
  - Return `{ more: true }` to page on without waiting. Implement `rewind(cursor, since,
    config)` so `seshi reprocess --since` works.
  - Secrets in `ctx.source.config` are objects with `reveal()`.
  - Test with `new Sources({ store, pipeline: fake, sources, connectors })`, or
    `buildInstance(config, { connectors: [...] })` on a folder store. See
    `tests/instance/worker.test.ts`.
- **API routes:** take what they need from the Instance (`instance.store`, `auth`, `pipeline`,
  `sources`, `status()`, `sessions(identity)`). Keep openapi.yaml and its test in step.
- **Commands (07, 12, 13, 14):** replace the stub file `apps/seshi/src/commands/<name>.ts`, and
  its summary line in `commands/index.ts` if it changes.
  - Use `takeJson`, `emit` and `fail` from `cli/output.ts`, and `EXIT` from `cli/exit.ts`.
    Never invent a new number; add a code at the end if one is truly needed.
  - A command that runs where the server config is uses `openServer(ctx, values, { roles: [],
    probe: [] })` and `serverFailure`.
  - 13: the session commands get a `SessionDB` from `connect()` in `apps/seshi/src/connect.ts`,
    passing the token `seshi login` stored.
- **`hook` and `statusline` (14):** may import only what capture needs: model, kit, formats,
  redact, config, client and capture. `bun run check:hook` fails on anything in `FORBIDDEN`
  (`scripts/check-hook.ts`). Load anything else with `await import()`.
- **Tests (X3.6):**
  - `tests/tooling/instance.ts` has `serverConfig(toml)`; `testInstance` and `testApp` (a
    synchronous Instance over an open store, with the old `createApp` option names);
    `bootInstance(toml, options)` (the full `buildInstance` path on a temp folder store);
    and `tempStore()`.
  - Package-local tests build `new Instance({...})` with `new FormatRegistry([...BUILTIN_FORMATS])`.
- **Reprocessing uploads (14):** `Sources.rewind("upload")` refuses. The uploader resends,
  filtered by agent, normalizer version or date, from the machines that hold the transcripts.

## Deviations and why

1. **The branch is `seshi-06-instance`** (hyphen), as for 01–05.
2. **Exit codes changed for setting errors.** `serve`, `admin` and `config` now exit 3
   (`config`) for a config they cannot use, where 02 exited 1. An unknown serve flag is 2. A
   second `admin init` is 6 (`conflict`). This follows the one table (F8.1); nothing was
   released with the old codes. Tests and docs are updated.
3. **Job status lives in the heartbeat.** X7.5 names the heartbeat for liveness; the job
   records ride along in it, so any instance and the CLI read status from the bucket, and no
   new object is needed. Last writer wins, so with two workers status shows the jobs of
   whichever wrote last, and names the other in `others`.
4. **The second-worker check** counts another process's heartbeat only if it was written after
   this process started and is fresh (within 3 intervals). A restart is therefore not reported
   as two workers. A real second worker shows within one interval.
5. **A worker-only instance still listens**, for `/healthz` only (container liveness). X7.1
   does not say whether it should.
6. **`seshi reprocess` is plumbing.** It rewinds one polled source, to the start or to
   `--since` through the connector. The `--agent` and `--normalizer` filters (X4.9) belong to
   the uploader (14) and to pollers that can filter at their source. A rewind cannot pick
   sessions by normalizer from the checkpoint alone.
7. **`workers status`, `sync` and `reprocess` are local commands.** They run where the server
   config and bucket keys are, as `admin init` does. Over HTTP there is `/v1/admin/jobs`; 13
   may give the CLI remote variants (records listing has no route yet).
8. **Added `seshi healthcheck`.** The image is the compiled binary with no curl, and F8.1 does
   not list such a command. It is in the registry like any other.
9. **The binary is bytecode-compiled.** That needs an entry point without top-level await, so
   `main.ts` uses `.then` instead. In a compiled binary the bundle is parsed whole, so the hook
   check applies only the absolute budget there. The static graph check still guarantees the
   server code is not evaluated.
10. **The image runs as uid 1000** (as the old image's `bun` user did), not a fresh system uid,
    so a compose volume created by the old image stays writable.
11. **`normalize` is built here** (F8.1 lists it, and no later branch owns it). It prints
    records redacted with the built-in rules only, not the operator's packs, and stores
    nothing.

## Review fixes

A review of this branch added: the transient-failure guard on checkpoints and the end-of-run
guard (sources); job retries with backoff (X4.8); the build's `no-autoload` flags (security);
`healthcheck` reading a mounted `seshi.toml`; `initialize: false` for read-only commands; `sync
failed|dropped` for unconfigured sources with records; serve's message for a taken address and
its graceful stop; `admin init` closing its instance.

## Still to check

- CI has not run (no PR). The new steps are `check:hook` from source and compiled, the
  multi-platform image build (cross-compiled; amd64 was built locally under emulation and ran
  `--version`), and the docker smoke test's `workers status` grep.
- The hook budget (250 ms) and the ratio (half of loading serve) are guesses for GitHub's
  runners; locally the hook takes about 15 ms. Tighten them once CI timings are known.
- With `instance_id` unset, the host name names the health shard. On Kubernetes every pod
  replacement gets a new name, and so a new shard. Shards are summed per day and pruned after
  `health_retention`, so this is harmless, but a deployment that wants stable shards should set
  `server.instance_id`.
- The `retention` job lists every source with records or health on every run (every 6 h). That
  is fine at today's sizes.
- Status reads every configured source's records with a full listing (`countRecords`), on each
  call of `/v1/admin/jobs`. Revisit if record counts grow large.
- Read-only commands still let `ensureLayout` record `store.org` in a marker that has none
  (the first config to name an org claims the prefix, 02/03 behaviour).
- A worker that stops cleanly writes no final heartbeat, so status says `running` for up to
  three intervals after it stops.
- `local.config` in the CLI config is resolved against the working folder, not the CLI
  config's folder.
- `bun build --compile` cross-compilation downloads the target's Bun runtime at build time, so
  the image build needs network access. It always did, for `bun install`.
- Open items carried over:
  - Dosu's deploy (`deploy/sessiondb.go`) must move to `SESHI_*` names and the new image
    entry point (`seshi serve` is the default command).
  - The live S3 test still has never run.
