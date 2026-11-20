#!/bin/sh
# Boots the Docker kit (deploy/docker/) in each of its variants and checks it the way a user
# would: health, an upload, a read, search, the worker, the hardening, and that the store
# survives a recreate. CI's docker job runs it against the image it just built; verify-kit runs
# it against the published image after a release.
#
#   sh scripts/docker-kit-smoke.sh
#
# Env: IMAGE_REPOSITORY and IMAGE_TAG (default: the image compose.yaml pins), EXPECT_VERSION
# (the version /healthz must report), VARIANTS (default "file bucket tls").
# Needs docker compose, curl, jq and openssl. Each variant runs as its own Compose project (a
# random name) in a copy of the kit, on host ports Docker picks, and is removed with its volumes
# afterwards: a real `seshi` project or server on the same machine is never touched.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
VARIANTS=${VARIANTS:-file bucket tls}
WORK=$(mktemp -d)
RUN="$$-$(openssl rand -hex 4)"
PROJECT=""
BASE=""

cp "$ROOT"/deploy/docker/compose*.yaml "$ROOT/deploy/docker/.env.example" "$WORK/"
cd "$WORK"

TOKEN=$(openssl rand -hex 24)
cp .env.example .env
{
  echo "SESHI_AUTH__TOKENS__CI=$TOKEN"
  echo "SESHI_WORKER__HEARTBEAT_INTERVAL=1s"
  echo "SESHI_SEARCH__INTERVAL=1s"
} >>.env

# The kit's own variables are exported rather than written to .env: Compose takes the shell's
# value over .env's, so a HOST_PORT or BIND_ADDRESS the caller happens to have set must not leak
# in. Port 0 lets Docker pick a free port, read back with `docker compose port` after each up.
# IMAGE_REPOSITORY and IMAGE_TAG are the script's inputs and pass through as given.
export HOST_PORT=0 HTTP_PORT=0 HTTPS_PORT=0 SITE_ADDRESS=localhost
BUCKET_ACCESS_KEY=$(openssl rand -hex 16)
BUCKET_SECRET_KEY=$(openssl rand -hex 32)
export BUCKET_ACCESS_KEY BUCKET_SECRET_KEY

# A Claude Code transcript with more assistant text than the session filter's 2000-character
# floor (docs/config.md, [filter]), so the server stores it.
STEPS=$(printf 'The steps, in order. %.0s' $(seq 1 120))
jq -nc --arg text "Deploying now. $STEPS" '
  {type: "user", uuid: "u1", timestamp: "2026-09-01T00:00:00.000Z", cwd: "/work",
   sessionId: "kit-smoke", message: {role: "user", content: "Deploy it, please."}},
  {type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-09-01T00:00:05.000Z",
   sessionId: "kit-smoke",
   message: {role: "assistant", model: "claude-x", content: [{type: "text", text: $text}]}}
' >transcript.jsonl
jq -n --rawfile t transcript.jsonl \
  '{format: "claude-code", session_id: "kit-smoke", transcript: $t}' >upload.json

compose() { docker compose --progress quiet -p "$PROJECT" "$@"; }

cleanup() {
  status=$?
  if [ -n "$PROJECT" ]; then
    if [ "$status" -ne 0 ]; then compose logs --no-color || true; fi
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  cd / && rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

fail() {
  echo "FAIL ($PROJECT): $*" >&2
  exit 1
}

api() { curl -fsS -H "Authorization: Bearer $TOKEN" "$@"; }

up() {
  compose up -d --wait --wait-timeout 180
  BASE=""
  # An unpublished port prints as ":0" (or nothing).
  published=$(compose port seshi 7200 2>/dev/null || true)
  if [ -n "$published" ] && [ "${published##*:}" != 0 ]; then
    BASE="http://127.0.0.1:${published##*:}"
    # Without the TLS add-on, seshi is published on loopback only.
    if [ "$BIND_ADDRESS" = 127.0.0.1 ] && [ "${published%:*}" != 127.0.0.1 ]; then
      fail "seshi is published on ${published%:*}, not loopback"
    fi
  fi
}

# check_health <base URL> [curl options]
check_health() {
  url=$1
  shift
  health=$(curl -fsS "$@" "$url/healthz") || fail "$url/healthz did not answer"
  [ "$(echo "$health" | jq -r .ok)" = true ] || fail "/healthz: $health"
  if [ -n "${EXPECT_VERSION:-}" ]; then
    [ "$(echo "$health" | jq -r .version)" = "$EXPECT_VERSION" ] ||
      fail "/healthz reports $(echo "$health" | jq -r .version), expected $EXPECT_VERSION"
  fi
}

check_upload() {
  out=$(curl -sS -o upload.out -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' --data-binary @upload.json "$BASE/v1/sessions")
  [ "$out" = 201 ] || fail "upload returned HTTP $out: $(cat upload.out)"
  [ "$(jq -r .status upload.out)" = stored ] || fail "upload: $(cat upload.out)"
}

check_read() {
  api -o /dev/null "$BASE/v1/sessions/claude-code/kit-smoke" || fail "the stored session is not readable"
}

check_search() {
  i=0
  until [ "$(api "$BASE/v1/search?q=Deploying" | jq -r '.total // 0')" -ge 1 ]; do
    i=$((i + 1))
    [ "$i" -ge 30 ] && fail "search did not find the session in 30 s"
    sleep 1
  done
}

check_worker() {
  compose exec -T seshi seshi workers status --json | grep -q '"state": "running"' ||
    fail "the worker role is not running"
}

check_hardening() {
  compose exec -T seshi sh -c 'test "$(id -u)" = 1000' || fail "the server does not run as uid 1000"
  # Asked of Docker: uid 1000 cannot write / anyway, so a failed write would prove nothing.
  container=$(compose ps -q seshi)
  [ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$container")" = true ] ||
    fail "the root filesystem is writable"
  [ "$(docker inspect -f '{{json .HostConfig.CapDrop}}' "$container")" = '["ALL"]' ] ||
    fail "capabilities are not all dropped"
  # A cap_add entry is granted even beside CapDrop ALL.
  case "$(docker inspect -f '{{json .HostConfig.CapAdd}}' "$container")" in
    null | "[]") ;;
    *) fail "capabilities are added back" ;;
  esac
}

check_recreate() {
  compose down
  up
  check_read
}

for variant in $VARIANTS; do
  PROJECT="seshi-kit-smoke-$RUN-$variant"
  BIND_ADDRESS=127.0.0.1
  case "$variant" in
    file) COMPOSE_FILE=compose.yaml ;;
    bucket) COMPOSE_FILE=compose.yaml:compose.bucket.yaml ;;
    # With seshi on every interface, as a deployment that adds Caddy later may have it: the
    # overlay must still publish nothing for seshi.
    tls) COMPOSE_FILE=compose.yaml:compose.tls.yaml BIND_ADDRESS=0.0.0.0 ;;
    *) fail "unknown variant $variant" ;;
  esac
  export COMPOSE_FILE BIND_ADDRESS
  echo "== $variant ($COMPOSE_FILE)"
  compose config -q
  up
  case "$variant" in
    file)
      check_health "$BASE"
      check_upload
      check_read
      check_search
      check_worker
      check_hardening
      check_recreate
      ;;
    bucket)
      check_health "$BASE"
      check_upload
      check_read
      compose logs --no-color seshi | grep -q 'storing sessions in s3://seshi/sessions' ||
        fail "the server is not on the bundled bucket"
      compose exec -T seshi seshi store check >/dev/null || fail "seshi store check failed"
      check_recreate
      # A second up with the bucket already there: bucket-init must succeed again.
      up
      ;;
    tls)
      # Only Caddy is published: plain HTTP to seshi must not be reachable from the host.
      [ -z "$BASE" ] || fail "seshi publishes $BASE beside Caddy"
      [ "$(compose config --format json | jq '.services.seshi.ports // [] | length')" = 0 ] ||
        fail "the merged config publishes a seshi port"
      # Through Caddy, with the same checks (ok, and the version); -k for Caddy's local CA.
      https=$(compose port caddy 443)
      check_health "https://localhost:${https##*:}" -k
      ;;
  esac
  compose down -v --remove-orphans >/dev/null
  PROJECT=""
  echo "ok $variant"
done
