#!/bin/bash
# 1M records: a first build through LanceIndex, searches, steady-state commits, optimize() and
# the scrub; then the end-to-end build through the server binary's Indexer from a synthetic
# store, and searches through its API.
gcloud storage cp "gs://$BUCKET/harness/setup.sh" /spike/setup.sh && source /spike/setup.sh
U="gs://$BUCKET/b1m"
T bun $SH/build.ts "$U" 1000000
gcloud storage du -s "$U"
bun $SH/search.ts "$U" 5
T bun $SH/steady.ts "$U" commit 10
T bun $SH/steady.ts "$U" optimize
T bun $SH/steady.ts "$U" scrub
gcloud storage du -s "$U"

# End to end: a synthetic store in the bucket, indexed by the server binary (`seshi sync
# search`, the Indexer with gathered build commits), then searched through its API.
S="gs://$BUCKET/e2e"
T bun $SH/store.ts "$S" 1000000 32
gcloud storage du -s "$S"
# Entries newer than the feed lag (5 minutes) are read again on the next pass: wait it out.
sleep 330
cat > /spike/seshi.toml <<TOML
[store]
url = "$S"

[search]
backend = "lance"

[auth]
admins = ["bench"]

[auth.tokens]
bench = { env = "BENCH_TOKEN" }
TOML
export BENCH_TOKEN=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
start=$(date +%s)
for i in $(seq 1 20); do
  out=$(T /spike/seshi-server sync search --config /spike/seshi.toml)
  echo "$out"
  echo "$out" | grep -q "more to read" || break
done
echo "e2e sync search total $(( $(date +%s) - start ))s"
/spike/seshi-server search --status --config /spike/seshi.toml
gcloud storage du -s "$S/search"
/spike/seshi-server serve --roles api --listen 127.0.0.1:7200 --config /spike/seshi.toml > /spike/serve.log 2>&1 &
SERVE=$!
sleep 10
bun $SH/http.ts http://127.0.0.1:7200 "$BENCH_TOKEN" 5
for q in zeppelinx error 'deplo*'; do
  /usr/bin/time -f "binary CLI cold search [$q]: %e s, %M KB" /spike/seshi-server search --config /spike/seshi.toml "$q" > /dev/null
done
kill $SERVE; tail -3 /spike/serve.log
