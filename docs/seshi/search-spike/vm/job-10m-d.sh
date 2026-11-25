# At 10M, after 20 commits with no optimize(): relevance at cap 100k, then optimize(), then cap 10k.
cd /spike/h && gcloud storage cp "gs://$BUCKET/harness/*.ts" . && U="gs://$BUCKET/10m" \
  && echo "== cap 100k, not optimized" && bun bench.ts "$U" 5 --sort relevance \
  && bun optimize.ts "$U" \
  && echo "== cap 10k, optimized" && bun bench.ts "$U" 5 --cap 10000 --sort relevance \
  && echo "== cap 100k, optimized" && bun bench.ts "$U" 5 --sort relevance
