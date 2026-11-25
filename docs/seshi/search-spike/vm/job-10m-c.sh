# At 10M: the bench again with the cap on scored rows at 10k instead of 100k.
cd /spike/h && gcloud storage cp "gs://$BUCKET/harness/*.ts" . && bun bench.ts "gs://$BUCKET/10m" 10 --cap 10000
