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
# Needs docker compose, curl, jq and openssl. Each variant runs as its own Compose project in a
# copy of the kit, and is removed with its volumes afterwards, so a real `seshi` project on the
# same machine is never touched.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
VARIANTS=${VARIANTS:-file bucket tls}
WORK=$(mktemp -d)
PROJECT=""
PORT=17200
BASE="http://127.0.0.1:$PORT"

cp "$ROOT"/deploy/docker/compose*.yaml "$ROOT/deploy/docker/.env.example" "$WORK/"
cd "$WORK"

TOKEN=$(openssl rand -hex 24)
cp .env.example .env
{
  echo "SESHI_AUTH__TOKENS__CI=$TOKEN"
  echo "SESHI_WORKER__HEARTBEAT_INTERVAL=1s"
  echo "SESHI_SEARCH__INTERVAL=1s"
  echo "HOST_PORT=$PORT"
  echo "HTTP_PORT=18080"
  echo "HTTPS_PORT=18443"
  echo "SITE_ADDRESS=localhost"
  echo "BUCKET_ACCESS_KEY=$(openssl rand -hex 16)"
  echo "BUCKET_SECRET_KEY=$(openssl rand -hex 32)"
  if [ -n "${IMAGE_REPOSITORY:-}" ]; then echo "IMAGE_REPOSITORY=$IMAGE_REPOSITORY"; fi
  if [ -n "${IMAGE_TAG:-}" ]; then echo "IMAGE_TAG=$IMAGE_TAG"; fi
} >>.env

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

up() { compose up -d --wait --wait-timeout 180; }

check_health() {
  health=$(curl -fsS "$BASE/healthz") || fail "/healthz did not answer"
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
  if compose exec -T seshi sh -c 'touch /probe' 2>/dev/null; then
    fail "the root filesystem is writable"
  fi
}

check_recreate() {
  compose down
  up
  check_read
}

for variant in $VARIANTS; do
  PROJECT="seshi-kit-smoke-$$-$variant"
  case "$variant" in
    file) COMPOSE_FILE=compose.yaml ;;
    bucket) COMPOSE_FILE=compose.yaml:compose.bucket.yaml ;;
    tls) COMPOSE_FILE=compose.yaml:compose.tls.yaml ;;
    *) fail "unknown variant $variant" ;;
  esac
  export COMPOSE_FILE
  echo "== $variant ($COMPOSE_FILE)"
  compose config -q
  up
  check_health
  case "$variant" in
    file)
      check_upload
      check_read
      check_search
      check_worker
      check_hardening
      check_recreate
      ;;
    bucket)
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
      curl -kfsS https://localhost:18443/healthz >/dev/null || fail "Caddy does not serve /healthz over HTTPS"
      ;;
  esac
  compose down -v --remove-orphans >/dev/null
  PROJECT=""
  echo "ok $variant"
done
