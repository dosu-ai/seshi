# seshi Helm chart

Runs the [seshi](https://github.com/dosu-ai/seshi) server, `seshi serve`, as one pod against an
S3-compatible bucket. The chart's version is the seshi release it runs.

```sh
helm install seshi ./charts/seshi -n seshi --create-namespace \
  --set store.url=s3://acme-sessions/seshi --set store.region=us-east-1 \
  --set store.credentials.existingSecret=seshi-store \
  --set persistence.enabled=true
kubectl -n seshi exec deploy/seshi -- seshi admin init --json
```

[docs/kubernetes.md](../../docs/kubernetes.md) covers the values, secrets, storage, drop-ins,
first tokens and ingress. `values.yaml` comments every value.
