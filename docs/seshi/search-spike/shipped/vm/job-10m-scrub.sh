#!/usr/bin/env bash
# The 10M scrub again, after job-10m.sh's failed in LanceDB's memory pool: maintain() with the
# scrub still due, each index build timed, first with the default pool, then with an 8 GB one.
gcloud storage cp "gs://$BUCKET/harness/setup.sh" /spike/setup.sh && source /spike/setup.sh
gcloud storage cp "gs://$BUCKET/harness/steady.ts" "$SH/steady.ts"
U="gs://$BUCKET/b10m"
T bun $SH/steady.ts "$U" maintain
LANCE_MEM_POOL_SIZE=$((8 * 1024 * 1024 * 1024)) T bun $SH/steady.ts "$U" maintain
gcloud storage du -s "$U"
bun $SH/search.ts "$U" 2 --sort relevance --only "word"
