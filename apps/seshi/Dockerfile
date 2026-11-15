# The seshi server: Bun runs the TypeScript directly, no build step (branch 15 builds the image
# from the compiled binary). Build from the repository root, since the app depends on the
# workspace packages beside it:
#   docker build -f apps/seshi/Dockerfile -t seshi .
FROM oven/bun:1.4-slim

# The base image is rebuilt on Bun's schedule, not Debian's, so take the distro's security
# fixes at build time: otherwise a release ships packages Debian has already patched.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Every workspace's package.json has to be present for a frozen install, so the workspaces are
# copied whole (.dockerignore leaves out tests, testdata and node_modules).
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
COPY integrations ./integrations
RUN bun install --frozen-lockfile --production

ENV PORT=7200
# Only for SESSIONDB_STORE_URL=file:///data; a bucket needs no volume.
RUN mkdir -p /data && chown bun:bun /data
VOLUME ["/data"]
EXPOSE 7200
USER bun

HEALTHCHECK --interval=30s --timeout=3s CMD bun -e "fetch('http://localhost:7200/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["bun", "run", "apps/seshi/src/main.ts", "serve"]
