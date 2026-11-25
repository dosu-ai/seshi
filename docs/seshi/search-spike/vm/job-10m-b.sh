# At 10M: DuckDB's grouped queries without the shape probes, then both commit modes on the same table.
cd /spike/h && gcloud storage cp "gs://$BUCKET/harness/*.ts" . && U="gs://$BUCKET/10m" \
  && (/usr/bin/time -v bun duck.ts "$U/events.lance" 10 --no-shapes || echo "duck failed: $?") \
  && bun commit.ts "$U" 5 --split --no-optimize --offset 1000 \
  && bun commit.ts "$U" 5 --no-optimize --offset 2000
