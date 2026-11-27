#!/bin/bash
# Phase 5: sql's DuckDB views over a LanceDB index in GCS, from inside us-west1. Synthetic data.
# Run by docs/seshi/search-spike/vm/agent.sh as a job: it needs the repository at
# gs://$BUCKET/harness/repo.tar.gz (git archive) and the read-only key at secrets/ro.json, a
# service account with storage.objectViewer on idx/ only (the condition in docs/search.md).
set -x
command -v /usr/bin/time >/dev/null || apt-get install -y time >/dev/null 2>&1
cd /spike && rm -rf repo && mkdir repo && gcloud storage cp "gs://$BUCKET/harness/repo.tar.gz" . && tar -xzf repo.tar.gz -C repo && cd repo
bun install --frozen-lockfile 2>&1 | tail -3
uname -a; nproc; free -g | head -2
gcloud storage cp "gs://$BUCKET/secrets/ro.json" /spike/ro.json
# Not traced: the key would land in the log.
set +x
RO=$(python3 -c 'import json;print(json.dumps({"google_service_account_key":open("/spike/ro.json").read()}))')
set -x
for size in 1m:5000 10m:50000; do
  name=${size%%:*}; n=${size##*:}
  U="gs://$BUCKET/idx/$name"
  /usr/bin/time -v bun docs/seshi/session-tools-measure/sql-views.ts gen "$U" "$n" 2>&1 | grep -E '^\{|Elapsed|Maximum resident'
  gcloud storage du -s "$U"
  for pass in 1 2; do
    echo "== $name time pass $pass"
    { set +x; } 2>/dev/null
    SESHI_MEASURE_STORAGE="$RO" bun docs/seshi/session-tools-measure/sql-views.ts time "$U" 4
    set -x
  done
done
