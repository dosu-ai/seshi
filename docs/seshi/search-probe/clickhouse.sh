#!/usr/bin/env bash
# Load the 1M records (exported by export.ts to ./chfiles/events.parquet) into ClickHouse 26.3
# with a text index, and run the same queries as duck.ts. Each query runs three times; the
# numbers are seconds. Stops the container at the end.
set -euo pipefail
cd "$(dirname "$0")"

docker run -d --rm --name ch-probe -p 18123:8123 \
  -e CLICKHOUSE_USER=probe -e CLICKHOUSE_PASSWORD=probe -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \
  -v "$PWD/chfiles:/var/lib/clickhouse/user_files" clickhouse/clickhouse-server:26.3 >/dev/null
trap 'docker stop ch-probe >/dev/null' EXIT
for _ in $(seq 1 30); do
  curl -sf -u probe:probe 'http://127.0.0.1:18123/?query=SELECT%201' >/dev/null && break
  sleep 1
done

ch() { docker exec ch-probe clickhouse-client --user probe --password probe "$@"; }
ch -q "SELECT version()"
ch -q "CREATE TABLE events (id String, owner LowCardinality(String), archive_id String,
  visibility LowCardinality(String), model LowCardinality(String), ts Int64, input_tokens Int32,
  output_tokens Int32, text String, INDEX text_idx text TYPE text(tokenizer = splitByNonAlpha))
  ENGINE = MergeTree ORDER BY (owner, archive_id)"
ch --time -q "INSERT INTO events SELECT * FROM file('events.parquet')"
ch -q "OPTIMIZE TABLE events FINAL"
ch -q "SELECT count(), formatReadableSize(sum(bytes_on_disk)) FROM system.parts WHERE table = 'events' AND active"

run() {
  printf '%-44s ' "$1"
  for _ in 1 2 3; do ch --time --format Null -q "$2" 2>&1 | tr '\n' ' '; done
  echo "-> $(ch -q "$2" | head -1 | tr '\t' ' ')"
}

# BM25 written in SQL over the matching rows (k1 = 1.2, b = 0.75; length in characters).
bm25() {
  local term=$1
  echo "(SELECT count() FROM events) AS N, (SELECT avg(length(text)) FROM events) AS avgdl,
    (SELECT countIf(hasToken(text, '$term')) FROM events) AS df,
    log(1 + (N - df + 0.5) / (df + 0.5)) AS idf,
    countSubstrings(concat(' ', text, ' '), ' $term ') AS tf,
    idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * length(text) / avgdl)) AS score"
}

run "count(*)" "SELECT count() FROM events"
run "count by visibility" "SELECT visibility, count() FROM events GROUP BY 1 ORDER BY 1"
run "tokens by model" "SELECT model, sum(input_tokens), sum(output_tokens) FROM events GROUP BY 1 ORDER BY 1"
run "tokens by owner per day (top)" "SELECT owner, toDate(fromUnixTimestamp64Milli(ts)) d,
  sum(input_tokens + output_tokens) t FROM events GROUP BY ALL ORDER BY t DESC LIMIT 3"
run "distinct sessions" "SELECT uniqExact(archive_id) FROM events"
run "text ILIKE scan" "SELECT count() FROM events WHERE text ILIKE '%w300 %'"
run "hasToken error: records, sessions" "SELECT count(), uniqExact(archive_id) FROM events WHERE hasToken(text, 'error')"
run "BM25 in SQL: w300 top sessions" "WITH $(bm25 w300) SELECT archive_id, max(score) best, count() hits
  FROM events WHERE hasToken(text, 'w300') AND (visibility = 'org' OR owner = 'u1')
  GROUP BY archive_id ORDER BY best DESC LIMIT 3"
run "BM25 in SQL: error, all matches grouped" "WITH $(bm25 error) SELECT count(), uniqExact(archive_id), max(score)
  FROM events WHERE hasToken(text, 'error')"
