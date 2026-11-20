# syntax=docker/dockerfile:1
# The kit's content: the seshi binary from a GitHub release, checked against the release's
# SHA256SUMS, and the seshi-sandbox helper, laid onto scratch so the overlay lands on any agent
# image. The fetch stage runs on the build platform and never runs the binary it downloads, so
# a multi-platform build needs no emulation.
FROM --platform=$BUILDPLATFORM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS fetch
ARG SESHI_VERSION
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    test -n "$SESHI_VERSION"; \
    case "$TARGETARCH" in \
      amd64) arch=x64 ;; \
      arm64) arch=arm64 ;; \
      *) echo "seshi ships no Linux binary for $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/dosu-ai/seshi/releases/download/v${SESHI_VERSION}"; \
    cd /tmp; \
    curl --proto '=https' --tlsv1.2 -fsSLO "$base/seshi-linux-$arch.tar.gz"; \
    curl --proto '=https' --tlsv1.2 -fsSLO "$base/SHA256SUMS"; \
    grep " seshi-linux-$arch\.tar\.gz\$" SHA256SUMS | sha256sum -c -; \
    mkdir -p /out/usr/local/bin; \
    tar -xzf "seshi-linux-$arch.tar.gz" -C /out/usr/local/bin seshi
COPY seshi-sandbox /out/usr/local/bin/seshi-sandbox
# The archive keeps the uid of the machine that packed it, and a file's owner can rewrite it
# whatever its mode: hand everything to root.
RUN chmod 0755 /out/usr/local/bin/seshi /out/usr/local/bin/seshi-sandbox && chown -R 0:0 /out

FROM scratch
COPY --from=fetch /out/ /
