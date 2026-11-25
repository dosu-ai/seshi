#!/bin/bash
# One spike run at a size: generate, bench, DuckDB, commit and scrub. Run by agent.sh.
# Usage (as a job): SIZE=1m RECORDS=1000000 bash run.sh
set -x
command -v /usr/bin/time >/dev/null || apt-get install -y time >/dev/null 2>&1
cd /spike && rm -rf h && mkdir h && gcloud storage cp -r "gs://$BUCKET/harness/*" h/ && cd h
bun install 2>&1 | tail -3
uname -a; nproc; free -g | head -2
du -sh node_modules/@lancedb/* node_modules/@duckdb/* node_modules/apache-arrow 2>/dev/null
U="gs://$BUCKET/$SIZE"
/usr/bin/time -v bun gen.ts "$U" "$RECORDS" 2>&1 | grep -vE '^\s+(Average|Exit|Socket|Signals|Swaps|Page size|File system|Voluntary|Involuntary|Minor|Major|Percent|System time|User time)'
gcloud storage du -s "$U/events.lance" "$U/sessions.lance"
for i in 1 2; do bun bench.ts "$U" 10; done
bun duck.ts "$U/events.lance" 10
/usr/bin/time -v bun commit.ts "$U" 5 --scrub 2>&1 | grep -vE '^\s+(Average|Exit|Socket|Signals|Swaps|Page size|File system|Voluntary|Involuntary|Minor|Major|Percent|System time|User time)'
