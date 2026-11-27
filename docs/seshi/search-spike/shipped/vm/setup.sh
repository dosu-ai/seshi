#!/bin/bash
# Shared by the jobs: unpack the repository, install, and build the stripped server binary once.
# Sourced by job-*.sh, which agent.sh (../../vm/agent.sh) runs from gs://$BUCKET/jobs/.
set -x
command -v /usr/bin/time >/dev/null || apt-get install -y time >/dev/null 2>&1
export PATH=/root/.bun/bin:$PATH
if [ ! -x /spike/seshi-server ]; then
  rm -rf /spike/repo && mkdir -p /spike/repo && cd /spike/repo
  gcloud storage cp "gs://$BUCKET/harness/repo.tgz" . && tar xzf repo.tgz
  bun install --frozen-lockfile 2>&1 | tail -3
  # The server build: main-server.ts, LanceDB's library stripped in node_modules first, so the
  # Bun scripts below load the same stripped library the binary embeds.
  /usr/bin/time -v bun scripts/build-binary.ts --server --outfile /spike/seshi-server 2>&1 | grep -E "build|strip|Elapsed|Maximum"
fi
cd /spike/repo
bun --version; uname -a; nproc; free -g | head -2; df -h / | tail -1
ls -la /spike/seshi-server && /spike/seshi-server --version
du -sh node_modules/@lancedb/*/ packages/ts/search/lance/node_modules/@lancedb/*/ 2>/dev/null
SH=docs/seshi/search-spike/shipped
# /usr/bin/time -v, keeping elapsed time and peak memory.
T() { /usr/bin/time -v "$@" 2>&1 | grep -vE '^\s+(Average|Exit|Socket|Signals|Swaps|Page size|File system|Voluntary|Involuntary|Minor|Major|Percent|System time|User time|Command being)'; }
