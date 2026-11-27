#!/bin/bash
# 10M records: a first build through LanceIndex, searches, steady-state commits, searches again
# before optimize(), then optimize() and the scrub.
gcloud storage cp "gs://$BUCKET/harness/setup.sh" /spike/setup.sh && source /spike/setup.sh
U="gs://$BUCKET/b10m"
T bun $SH/build.ts "$U" 10000000
gcloud storage du -s "$U"
bun $SH/search.ts "$U" 3
T bun $SH/steady.ts "$U" commit 10
bun $SH/search.ts "$U" 2 --sort relevance
T bun $SH/steady.ts "$U" optimize
T bun $SH/steady.ts "$U" scrub
gcloud storage du -s "$U"
