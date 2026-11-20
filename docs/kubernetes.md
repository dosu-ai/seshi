# seshi on Kubernetes

The Helm chart in [`charts/seshi`](../charts/seshi) runs `seshi serve` on Kubernetes. It runs
one pod with both roles (api and worker) against a bucket, from the release's image
`ghcr.io/dosu-ai/seshi`. The chart's version is the seshi release it ships: chart 0.22.0 runs
seshi 0.22.0. [server.md](server.md) covers what the server does; this page covers running it
from the chart.

## Quick start

seshi needs a bucket, as everywhere else ([server.md](server.md#deploying)). Put its keys in a
Secret, then install the chart from a checkout:

```sh
kubectl create namespace seshi
kubectl -n seshi create secret generic seshi-store \
  --from-literal=access-key-id=AKIA… --from-literal=secret-access-key=…
helm install seshi ./charts/seshi -n seshi \
  --set store.url=s3://acme-sessions/seshi --set store.region=us-east-1 \
  --set store.credentials.existingSecret=seshi-store \
  --set persistence.enabled=true
```

Then make the first tokens ([below](#first-tokens)) and point members at the server.

## Values

[`charts/seshi/values.yaml`](../charts/seshi/values.yaml) lists every value with a comment, and
`values.schema.json` refuses unknown keys. The ones most installs set:

| Value | What it sets |
|---|---|
| `store.url` | `[store] url`. Required. `s3://bucket/prefix`, `r2://bucket/prefix`, or `file:///data/store` with `persistence.enabled` |
| `store.region`, `store.endpoint`, `store.accountId`, `store.deploymentId`, `store.org` | The rest of `[store]` ([config.md](config.md)) |
| `store.credentials.existingSecret` | A Secret with the bucket's keys, given to seshi as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. `store.credentials.keys` names its keys |
| `config` | The rest of `seshi.toml`, written as YAML: `auth`, `filter`, `limits`, `redaction`, `review`, `sources`, `search`, `worker`, `capture` and the others in [config.md](config.md) |
| `dropIns` | Files for `seshi.d/`, by name ([below](#drop-ins-and-rule-packs)) |
| `redactionPacks` | Rule packs, by file name ([redaction.md](redaction.md)) |
| `persistence.enabled` | `/data` on a PersistentVolumeClaim instead of an emptyDir ([below](#storage)) |
| `ingress.*`, `networkPolicy.*`, `resources`, `probes` | The usual Kubernetes settings |

The chart writes `seshi.toml` into a ConfigMap mounted at `/etc/seshi`, and sets
`SESHI_CONFIG=/etc/seshi/seshi.toml`, so `kubectl exec` commands find the config without a
flag. A change to the config restarts the pod. The chart sets `[store]`, `server.listen`
(`:7200`) and, unless `config.search.path` says otherwise, `search.path`
(`/data/search/index.sqlite`). It refuses `config.store`, `config.server.listen` and
`config.server.roles`.

### Secrets

Keep secrets out of `config`. seshi reads a secret setting from a variable or a file
([config.md](config.md)), so give the container one with `extraEnv`, `envFrom` or
`extraVolumes`/`extraVolumeMounts`, and name it in `config`:

```yaml
extraEnv:
  - name: OIDC_SESSION_KEY
    valueFrom: { secretKeyRef: { name: seshi-auth, key: session-key } }
config:
  auth:
    oidc: { issuer: https://acme.okta.com, client_id: seshi }
    session_keys: { k1: { env: OIDC_SESSION_KEY } }
```

A variable whose name starts with `SESHI_` must be a real setting (`SESHI_AUTH__ORG_KEY__ENABLED`),
because seshi refuses to start on one it does not know. For the same reason the chart turns
Kubernetes' service links off (`enableServiceLinks: false`). Otherwise a Service named `seshi`
in the namespace would give the pod `SESHI_SERVICE_HOST`, and seshi would not start.

## Storage

Sessions live in the bucket. `/data` holds the search index, and the sessions themselves only
for a `file://` store.

- `persistence.enabled: false` (the default) puts `/data` on an emptyDir. Each new pod
  rebuilds the search index from the bucket's change feed. Until it has caught up,
  `GET /v1/search` and `GET /v1/changes/all` answer `503 index_building`; uploads and reads are
  unaffected.
- `persistence.enabled: true` puts `/data` on a claim (`persistence.size`, `storageClass`,
  `existingClaim`). The index survives restarts. Recommended for production, and for readers of
  `/v1/changes/all` such as Dosu's ADX.

The chart keeps the claim when the release is uninstalled or persistence is turned off
(`helm.sh/resource-policy: keep`). Delete it by hand when you mean to.

## Drop-ins and rule packs

`dropIns` writes each entry to `seshi.d/<name>.toml` beside `seshi.toml`, loaded in name
order. A drop-in may add sources, `redaction.packs`, `capture.exclude` and
`capture.redact_tool_calls` ([config.md](config.md)):

```yaml
dropIns:
  10-org:
    capture:
      exclude: [acme/secret-repo]
redactionPacks:
  acme.toml: |
    id = "acme"
    [[rules]]
    id = "acme-key"
    pattern = 'ACME-[0-9A-F]{32}'
```

Each pack is mounted at `/etc/seshi/packs/<file>` and added to `redaction.packs`. Both come
from the ConfigMap, so a change is a `helm upgrade` and a restart. The chart has no writable
config directory for another workload to write drop-ins into and reload; that is a planned
addition.

## First tokens

The chart does not make tokens. After the first install, run `seshi admin init` once in the
pod. It writes to the bucket and prints the first admin token and the org key:

```sh
kubectl -n seshi exec deploy/seshi -- seshi admin init --json
```

Keep both in a Secret or a password manager; seshi never shows them again. Run again, it exits 6
because the bucket already has an admin ([server.md](server.md#setting-up-who-may-call-it)).
Members then sign in with `seshi login --key <org key>`; admins make service tokens with
`seshi tokens` or `POST /v1/tokens`.

## One pod

The chart runs one replica with both roles and replaces it with the `Recreate` strategy, so
two workers never run at once. Uploaders retry through the few seconds between the old pod
stopping and the new one answering. There is no `replicas` value. `POST /v1/admin/reload`
reloads only the instance that answers it, and each API instance builds its own search index,
so more replicas would answer differently until both are handled.

## Ingress

`ingress.enabled` routes a host to the Service. Set the controller's request timeout to 120
seconds or more and allow large bodies: a long transcript takes that long to normalize, and
clients send it gzipped ([server.md](server.md#deploying)). For ingress-nginx:

```yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "120"
    nginx.ingress.kubernetes.io/proxy-body-size: 64m
  hosts:
    - host: seshi.example.com
      paths: [{ path: / }]
  tls:
    - hosts: [seshi.example.com]
      secretName: seshi-tls
```

## Checking the chart

`bun run check:chart` lints the chart and renders every values file in `charts/seshi/ci/`. It
checks each rendered `seshi.toml`, with its drop-ins and packs, with this checkout's
`seshi config check`, and confirms the chart refuses the values it must. With `kubeconform` on
`PATH` it also validates the manifests. It needs `helm`. CI runs it under Helm 3 and Helm 4
before every release. `helm test <release>` runs `seshi healthcheck` against the installed
Service.
