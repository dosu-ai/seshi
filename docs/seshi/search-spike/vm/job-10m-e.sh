cd /spike/h && gcloud storage cp "gs://$BUCKET/harness/*.ts" . && bun and.ts "gs://$BUCKET/10m" 5
