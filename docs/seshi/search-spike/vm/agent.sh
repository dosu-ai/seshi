#!/bin/bash
# The VM's startup script: no inbound SSH is needed. It installs Bun, then runs each job
# script put in gs://$BUCKET/jobs/, and copies its log to gs://$BUCKET/results/ every 30 s.
BUCKET=$(curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/attributes/spike-bucket)
export HOME=/root
apt-get update -y && apt-get install -y unzip curl
[ -x /root/.bun/bin/bun ] || curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"
mkdir -p /spike
while true; do
  for job in $(gcloud storage ls "gs://$BUCKET/jobs/" 2>/dev/null | grep '\.sh$'); do
    name=$(basename "$job" .sh)
    gcloud storage cp "$job" "/spike/$name.sh" && gcloud storage rm "$job"
    (
      BUCKET=$BUCKET PATH=/root/.bun/bin:$PATH bash "/spike/$name.sh" > "/spike/$name.log" 2>&1
      echo "exit $?" >> "/spike/$name.log"
      gcloud storage cp "/spike/$name.log" "gs://$BUCKET/results/$name.log"
    ) &
    pid=$!
    while kill -0 $pid 2>/dev/null; do
      sleep 30
      gcloud storage cp "/spike/$name.log" "gs://$BUCKET/results/$name.log" >/dev/null 2>&1
    done
  done
  sleep 10
done
