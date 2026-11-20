# seshi with Docker Compose

This folder runs the seshi server from its published image, `ghcr.io/dosu-ai/seshi`, with
Docker Compose. One container runs both server roles (api and worker) and keeps sessions on a
Docker volume. Two add-on files swap in a bundled S3-compatible bucket or put Caddy in front
for HTTPS. The repository root's `compose.yaml` is different: it builds the image from a
checkout, for working on seshi itself.

You need Docker Engine with Compose v2.24 or later. [docs/server.md](../../docs/server.md)
covers what the server does, and [docs/config.md](../../docs/config.md) lists every setting.

## Quick start

```sh
git clone --depth 1 --branch vX.Y.Z https://github.com/dosu-ai/seshi   # a release tag
cd seshi/deploy/docker
cp .env.example .env && chmod 600 .env
docker compose run --rm seshi config check     # reads .env as the server will
docker compose up -d --wait
docker compose exec seshi seshi admin init     # prints the first admin token and the org key, once
```

The server answers on `http://127.0.0.1:7200`. Each release tag pins its own image version in
`compose.yaml`, so the tag you clone is the version you run. A release's image is published a
few minutes after its tag: if `up` or `pull` reports `manifest unknown` for a tag that is
minutes old, wait, or use the previous release. Keep the admin token and the org
key somewhere safe: `admin init` prints them once. Then, on each laptop:

```sh
seshi login --server https://seshi.example.com   # the org key, or sign in through your IdP
seshi capture install
```

Laptops need a URL they can reach, which is the next two sections.

## One `.env`, two readers

Compose reads `.env` for the kit's own variables (`IMAGE_TAG`, `HOST_PORT`, `SITE_ADDRESS` and
the rest, listed at the top of `.env.example`). The container reads the same file for its
`SESHI_*` settings. The server stops at boot on a `SESHI_*` name that is not a setting, so the
kit's variables never start with `SESHI_`, and you should not invent one.

Leave `SESHI_SERVER__LISTEN` unset. The container listens on 7200; `HOST_PORT` changes the port
on the host.

## Where sessions go

**The volume (default).** `SESHI_STORE__URL=file:///data` keeps sessions on the `seshi_data`
volume, which survives `docker compose down` and container recreation, but not `down -v`. Back
it up with:

```sh
docker run --rm -v seshi_data:/data:ro -v "$PWD":/backup debian:bookworm-slim \
  tar czf /backup/seshi-data.tgz -C /data .
```

**A bucket you already have.** Set `SESHI_STORE__URL` to `s3://bucket/prefix` or
`r2://bucket/prefix` in `.env`, with the region or account id and the credentials beside it.
`.env.example` shows the lines. The volume then only holds the search index, which the server
rebuilds from the bucket if it is lost.

**The bundled bucket.** `compose.bucket.yaml` adds RustFS, an S3-compatible server, and creates
the bucket on first start:

```sh
# in .env: BUCKET_ACCESS_KEY=$(openssl rand -hex 16), BUCKET_SECRET_KEY=$(openssl rand -hex 32)
docker compose -f compose.yaml -f compose.bucket.yaml up -d --wait
```

Its store settings override any `SESHI_STORE__*` lines in `.env`. All of its data sits on one
volume on one machine, so use it to try the bucket layout or on a host with no cloud bucket,
and back up the `seshi_bucket` volume as you would `seshi_data`.

## HTTPS

Transcripts reach the server before redaction, so put TLS in front of it before laptops send
anything over a network.

**Caddy, bundled.** Point a DNS name at the host, open ports 80 and 443, then:

```sh
# in .env: SITE_ADDRESS=seshi.example.com
docker compose -f compose.yaml -f compose.tls.yaml up -d --wait
```

With this add-on seshi publishes no port on the host at all, whatever `BIND_ADDRESS` says, so
nothing reaches it except through Caddy. Caddy gets a certificate for the name from a public CA (Let's Encrypt, or ZeroSSL as a
fallback) and renews it. Keep the
`seshi_caddy-data` volume, which holds the certificates. `SITE_ADDRESS=localhost` uses Caddy's
own CA instead, which is enough to try it. Caddy sets no response timeout and no body limit by
default, so long uploads go through.

**Your own proxy or load balancer.** Set `BIND_ADDRESS=0.0.0.0` (or the address your proxy
reaches) and give the proxy a request timeout of 120 seconds or more: a large transcript can
take that long to normalize.

To use an add-on every time without the `-f` flags, set it in `.env`:
`COMPOSE_FILE=compose.yaml:compose.tls.yaml` (separate the files with `;` on Windows).

## A config file

Settings that do not fit in env, such as sources, labels or rule packs, go in a `seshi.toml`:

```sh
mkdir config && cp ../../seshi.example.toml config/seshi.toml   # then edit it
```

Uncomment the `./config:/etc/seshi:ro` line in `compose.yaml` and recreate the container with
`docker compose up -d`. Env settings still win over the file. After editing the file, reload it
with `docker compose kill -s HUP seshi`; the server logs what the reload changed, or why it
refused the file. Mount
the directory, not the single file: many editors save by replacing the file, and a single-file
mount keeps showing the old one.

## Secrets as files

A secret setting (a token, a key, a bucket credential) can be read from a file by adding
`__FILE` to its name, such as
`SESHI_STORE__CREDENTIALS__SECRET_ACCESS_KEY__FILE=/run/secrets/bucket-secret-key`. Mount the
file into the container (a Compose `secrets:` entry or a read-only bind mount) and make it
readable by uid 1000, which the server runs as.

## Upgrading

Check out the newer release tag and run:

```sh
docker compose pull && docker compose up -d --wait
```

To pin a version without changing the checkout, set `IMAGE_TAG=X.Y.Z` in `.env`, or
`IMAGE_TAG=X.Y.Z@sha256:…` to pin the exact image. The release notes say when an upgrade needs
more than this.

## What the kit sets, and what it leaves alone

The `seshi` container runs as uid 1000 with a read-only root filesystem. `/data` (the volume)
and `/tmp` (in memory) are its only writable paths. It drops every Linux capability, cannot
gain new privileges, and publishes its port on loopback unless `BIND_ADDRESS` says otherwise. On Docker Engine
before 28.0, other Linux hosts on the same network segment can still reach a port published on
`127.0.0.1`: upgrade Docker, or firewall the host.
Third-party images are pinned by digest.

The kit sets no CPU or memory limits. One upload can be 256 MiB, and the server holds it in
memory while it works, so a guessed limit kills the server mid-upload. Watch what it uses, then
uncomment the `deploy.resources` block in `compose.yaml`. Log rotation belongs to the Docker
daemon (`log-opts` in `daemon.json`), not this file.

## Day two

```sh
docker compose logs -f seshi                       # the server's log
docker compose exec seshi seshi workers status     # background jobs and the worker heartbeat
docker compose exec seshi seshi store check        # the store answers, and is marked for this server
docker compose exec seshi seshi tokens list        # tokens, once you are signed in as an admin
```

## Moving from the root `compose.yaml`

The root file names its service `sessiondb` and its volume `sessiondb-data`, under a project
named after your checkout's folder. To keep a `file://` store from it, point this kit's `data`
volume at the old one with a `compose.override.yaml` beside `compose.yaml`:

```yaml
volumes:
  data:
    external: true
    name: sessiondb_sessiondb-data   # docker volume ls shows the real name
```

Compose reads `compose.override.yaml` on its own when you give no `-f` flags. With `-f` or
`COMPOSE_FILE`, add it to the list yourself.

## More than one instance

The server has two roles, `api` and `worker` (`seshi serve --roles`). API instances can scale
out, but each needs its own search index and a shared bucket, and exactly one worker may run.
That takes a load balancer and an orchestrator, which this kit does not try to be.
[docs/server.md](../../docs/server.md) explains the roles.
