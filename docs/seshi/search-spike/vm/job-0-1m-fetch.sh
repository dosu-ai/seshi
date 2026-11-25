cd /spike/h && gcloud storage cp "gs://$BUCKET/harness/*.ts" . && bun addidx.ts "gs://$BUCKET/1m" && bun bench.ts "gs://$BUCKET/1m" 10
