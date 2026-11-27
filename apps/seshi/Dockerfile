# The seshi server image, built from the one compiled binary (X2.2): the build stage compiles
# `seshi` with Bun for the target platform, and the final image holds that binary and nothing
# of Bun, Node or node_modules. It is the server build (`build-binary.ts --server`,
# apps/seshi/src/main-server.ts): the same seshi with the LanceDB search backend
# (`[search] backend = "lance"`, F10.6), whose native library (stripped by the build) adds
# about 180 MB on amd64 and 280 MB on arm64 that laptops' binaries do not carry. Build from
# the repository root, since the app depends on the workspace packages beside it:
#   docker build -f apps/seshi/Dockerfile -t seshi .
# Multi-platform builds (linux/amd64, linux/arm64) cross-compile on the build machine, so no
# emulation runs the build.
#
# Releases (ci.yml's image job) ship the GitHub release's own Linux server binaries
# (seshi-server-linux-*.tar.gz) instead of compiling again: they are unpacked to
# dist/docker/linux-<amd64|arm64>/ and the build is given `--build-arg BINARY=prebuilt`
# (BuildKit skips the stage it does not use).
#
# `--build-arg VARIANT=sql` builds the -sql image instead: the -sql server build
# (`build-binary.ts --sql`, apps/seshi/src/main-server-sql.ts), which carries DuckDB for `sql` on
# a LanceDB index, with DuckDB's library and its `lance` extension in /opt/seshi/duckdb/ beside
# the binary (docs/search.md). Prebuilt, it takes seshi-server-sql-linux-*.tar.gz unpacked to
# dist/docker/linux-<amd64|arm64>-sql/. The default image carries none of it.

# Where the binary comes from: `build` (compile it here) or `prebuilt` (dist/docker/).
ARG BINARY=build
# Which server build: empty (LanceDB) or `sql` (LanceDB and DuckDB).
ARG VARIANT=

FROM --platform=$BUILDPLATFORM oven/bun:1.4-slim AS build
ARG TARGETARCH
ARG VARIANT
WORKDIR /src
# Every workspace's package.json has to be present for a frozen install, so the workspaces are
# copied whole (.dockerignore leaves out tests, testdata and node_modules).
COPY package.json bun.lock ./
COPY patches ./patches
COPY apps ./apps
COPY packages ./packages
COPY integrations ./integrations
COPY scripts/build-binary.ts scripts/duckdb-extensions.json ./scripts/
COPY brand/glyph/seshi-glyph-badge.svg ./brand/glyph/
# x64 uses the baseline build, which runs on CPUs without AVX2 (and under emulation). The
# install takes LanceDB's (and DuckDB's) native package for the target, not the build machine
# (--os, --cpu), since the binary carries it. The -sql build downloads the `lance` extension
# and checks it against scripts/duckdb-extensions.json.
RUN case "$TARGETARCH" in \
      amd64) target=bun-linux-x64-baseline cpu=x64 ;; \
      arm64) target=bun-linux-arm64 cpu=arm64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && case "$VARIANT" in \
      "") build=--server ;; \
      sql) build=--sql ;; \
      *) echo "unknown VARIANT: $VARIANT (empty, or sql)" >&2; exit 1 ;; \
    esac \
 && bun install --frozen-lockfile --production --os=linux --cpu="$cpu" \
 && bun run scripts/build-binary.ts "$build" --target "$target" --outfile /out/seshi \
 && if [ "$TARGETARCH" = "$(dpkg --print-architecture)" ]; then /out/seshi --version; fi

FROM scratch AS prebuilt
ARG TARGETARCH
ARG VARIANT
COPY dist/docker/linux-$TARGETARCH${VARIANT:+-$VARIANT}/ /out/

FROM $BINARY AS binary

FROM debian:bookworm-slim
# Take the distro's security fixes at build time, and CA certificates for any tool that reads
# the system store. A non-root user owns /data, with uid 1000 like the earlier image's `bun`
# user, so an existing volume stays writable.
# The binary lives in /opt/seshi/, with anything it needs beside it (the -sql image's duckdb/),
# and is on PATH as /usr/local/bin/seshi; it finds duckdb/ beside its real path.
RUN apt-get update && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 1000 --home-dir /data --shell /usr/sbin/nologin seshi \
 && mkdir -p /data && chown seshi:seshi /data \
 && ln -s /opt/seshi/seshi /usr/local/bin/seshi
COPY --from=binary --chmod=755 /out/ /opt/seshi/

# Settings come from SESHI_* env or a mounted /etc/seshi/seshi.toml (docs/config.md); the
# server listens on :7200 unless server.listen says otherwise, and runs the api and worker
# roles unless --roles or server.roles says otherwise (X7.1).
# /data only matters for SESHI_STORE__URL=file:///data; a bucket needs no volume.
VOLUME ["/data"]
EXPOSE 7200
USER seshi
WORKDIR /data

# The image has no curl: the binary asks /healthz itself, on server.listen's port.
HEALTHCHECK --interval=30s --timeout=5s CMD ["seshi", "healthcheck"]

ENTRYPOINT ["seshi"]
CMD ["serve"]
