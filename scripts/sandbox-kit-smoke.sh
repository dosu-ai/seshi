#!/bin/sh
# Builds the Docker Sandboxes kit (deploy/sandbox/seshi-sandbox-kit) through its real build
# frontend, lays it over a stand-in agent image the way a sandbox composes a mixin, and checks
# it the way a sandbox would run it, against the Docker kit's server (deploy/docker/):
#
# - the install hook adds seshi's hooks beside the ones the stock claude and codex kits write,
#   twice without duplicates, with the shared skills folders mounted read-only;
# - the startup hook signs in with a device token, and with the org key and a username;
# - a Claude Code session with a planted secret reaches the server already redacted, so the
#   server finds nothing left to redact;
# - `seshi-sandbox flush` leaves nothing queued, and fails while the server is down;
# - neither hook fails when the server cannot be reached;
# - a published kit (KIT_IMAGE) carries its descriptor in each platform's manifest.
#
# It needs no `sbx`, so it cannot check what only a sandbox does: the network rule, the
# credential proxy, or the hooks' environment. deploy/sandbox/README.md lists those checks.
#
#   sh scripts/sandbox-kit-smoke.sh
#
# Env: IMAGE_REPOSITORY and IMAGE_TAG pick the server image (default: the one
# deploy/docker/compose.yaml pins). SESHI_IMAGE, when set, is an image whose
# /usr/local/bin/seshi replaces the kit's (CI tests this checkout's seshi with it). KIT_IMAGE,
# when set, is a kit image to test instead of building one (verify-sandbox-kit pulls the
# published kit).
# Needs docker with buildx, docker compose, jq and openssl. Everything it starts has a random
# name and is removed afterwards.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
RUN="$$-$(openssl rand -hex 4)"
PROJECT="seshi-sandbox-smoke-$RUN"
BOX="seshi-sandbox-smoke-$RUN"
TEST_IMAGE="seshi-sandbox-smoke:$RUN"
BUILT_KIT=""
SERVER="http://seshi:7200"
OWNER=sandbox-smoke@example.com

cp "$ROOT"/deploy/docker/compose.yaml "$ROOT/deploy/docker/.env.example" "$WORK/"
cd "$WORK"
cp .env.example .env
{
  echo "HOST_PORT=0"
  echo "SESHI_SEARCH__INTERVAL=1s"
  if [ -n "${IMAGE_REPOSITORY:-}" ]; then echo "IMAGE_REPOSITORY=$IMAGE_REPOSITORY"; fi
  if [ -n "${IMAGE_TAG:-}" ]; then echo "IMAGE_TAG=$IMAGE_TAG"; fi
} >>.env

compose() { docker compose --progress quiet -p "$PROJECT" "$@"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    compose logs --no-color seshi 2>/dev/null | tail -40 || true
  fi
  docker rm -f "$BOX" >/dev/null 2>&1 || true
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm -f "$TEST_IMAGE" >/dev/null 2>&1 || true
  if [ -n "$BUILT_KIT" ]; then docker image rm -f "$BUILT_KIT" >/dev/null 2>&1 || true; fi
  cd / && rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# As the agent, with only what a lifecycle hook gets: PATH, HOME and what the kit declares.
as_agent() {
  docker exec -i -u agent -w /home/agent "$BOX" \
    env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/agent "$@"
}

echo "== build the kit"
KIT=${KIT_IMAGE:-}
if [ -z "$KIT" ]; then
  KIT="seshi-sandbox-kit:smoke-$RUN"
  BUILT_KIT=$KIT
  docker buildx build --load --progress quiet -t "$KIT" \
    -f "$ROOT/deploy/sandbox/seshi-sandbox-kit/seshi-sandbox-kit.yaml" \
    "$ROOT/deploy/sandbox/seshi-sandbox-kit" >/dev/null
fi
if [ -n "${KIT_IMAGE:-}" ]; then
  # sbx reads a published kit's descriptor from its manifest annotations, per platform.
  INDEX=$(docker buildx imagetools inspect --raw "$KIT")
  for digest in $(echo "$INDEX" | jq -r '.manifests[] | select(.platform.os == "linux") | .digest'); do
    docker buildx imagetools inspect --raw "${KIT%%:*}@$digest" |
      jq -er '.annotations["vnd.docker.sandbox.kit.descriptor"] | fromjson | .schemaVersion == "3"' \
        >/dev/null || fail "$KIT@$digest has no kit descriptor annotation"
  done
  [ "$(echo "$INDEX" | jq '[.manifests[] | select(.platform.os == "linux")] | length')" -ge 2 ] ||
    fail "$KIT is not published for both amd64 and arm64"
fi
docker image inspect "$KIT" >/dev/null 2>&1 || docker pull -q "$KIT" >/dev/null
docker create --name "$BOX-kit" "$KIT" true >/dev/null
docker cp "$BOX-kit:/usr/share/sandbox/kit/seshi-sandbox-kit" kit-meta >/dev/null 2>&1 ||
  { docker rm -f "$BOX-kit" >/dev/null; fail "the kit image carries no descriptor under /usr/share/sandbox/kit"; }
docker rm -f "$BOX-kit" >/dev/null

# A stand-in for the claude and codex workloads: Debian with the `agent` user, the kit's
# content laid over it, and the settings the workloads' own install hooks write (their
# desktop-app hooks, status line and Codex notify program).
OVERLAY=""
if [ -n "${SESHI_IMAGE:-}" ]; then
  OVERLAY="COPY --from=seshi /usr/local/bin/seshi /usr/local/bin/seshi"
fi
cat >Dockerfile <<EOF
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN useradd --uid 1000 --create-home --shell /bin/bash agent \\
 && printf '#!/bin/sh\\necho "\$*" >>/tmp/sbx-hook.log\\n' >/usr/local/bin/sbx-claude-hook \\
 && cp /usr/local/bin/sbx-claude-hook /usr/local/bin/sbx-codex-hook \\
 && chmod 755 /usr/local/bin/sbx-claude-hook /usr/local/bin/sbx-codex-hook
COPY --from=kit / /
$OVERLAY
USER agent
RUN mkdir -p /home/agent/.claude /home/agent/.codex /home/agent/.agents /home/agent/work \\
 && printf '%s\\n' '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/usr/local/bin/sbx-claude-hook claude","timeout":10,"async":true}]}]},"statusLine":{"type":"command","command":"/usr/local/bin/sbx-claude-hook claude-status"},"permissions":{"defaultMode":"bypassPermissions"}}' >/home/agent/.claude/settings.json \\
 && printf '%s\\n' 'sandbox_mode = "danger-full-access"' 'notify = ["/usr/local/bin/sbx-codex-hook", "codex"]' >/home/agent/.codex/config.toml
EOF
set -- --build-context "kit=docker-image://$KIT"
if [ -n "${SESHI_IMAGE:-}" ]; then set -- "$@" --build-context "seshi=docker-image://$SESHI_IMAGE"; fi
docker buildx build --load --progress quiet -t "$TEST_IMAGE" "$@" . >/dev/null

echo "== start the server"
compose up -d --wait --wait-timeout 180
INIT=$(compose exec -T seshi seshi admin init --json)
ADMIN_TOKEN=$(echo "$INIT" | jq -r .admin.token)
ORG_KEY=$(echo "$INIT" | jq -r .org_key.token)

# The shared skills store, as sbx mounts it by default: read-only.
docker run -d --name "$BOX" --network "${PROJECT}_default" \
  --tmpfs /home/agent/.claude/skills:ro --tmpfs /home/agent/.agents/skills:ro \
  "$TEST_IMAGE" sleep infinity >/dev/null
docker exec "$BOX" seshi --version || fail "seshi does not run in the sandbox image"

# An admin, in a HOME of its own, mints the device token a person would put in `sbx secret`.
admin() {
  docker exec -i -u agent "$BOX" env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp/admin \
    SESHI_KEYCHAIN=false seshi "$@"
}
printf '%s' "$ADMIN_TOKEN" | admin login --server "$SERVER" --token - >/dev/null
DEVICE_TOKEN=$(admin tokens create device --owner "$OWNER" --expires 1d --json |
  jq -r .token)
[ -n "$DEVICE_TOKEN" ] && [ "$DEVICE_TOKEN" != null ] || fail "no device token"

echo "== install hook"
as_agent seshi-sandbox setup
as_agent cat .claude/settings.json >settings.first
as_agent cat .codex/config.toml >config.first
as_agent seshi-sandbox setup >/dev/null
as_agent cat .claude/settings.json | cmp -s - settings.first ||
  fail "a second setup changed settings.json"
as_agent cat .codex/config.toml | cmp -s - config.first || fail "a second setup changed config.toml"
grep -q 'keychain = false' <<EOF || fail "setup did not turn the keychain off"
$(as_agent cat .config/seshi/config.toml)
EOF
STOP=$(jq -r '[.hooks.Stop[].hooks[].command | select(test("seshi"))] | .[0] // empty' settings.first)
[ -n "$STOP" ] || fail "settings.json has no seshi Stop hook: $(cat settings.first)"
jq -e '[.hooks.Stop[].hooks[].command] | index("/usr/local/bin/sbx-claude-hook claude")' \
  settings.first >/dev/null || fail "seshi dropped the claude kit's Stop hook"
[ "$(jq '[.hooks[][].hooks[].command | select(test("seshi"))] | length' settings.first)" -ge 1 ] ||
  fail "no seshi hooks"
grep -q '/usr/local/bin/seshi' config.first || fail "Codex's notify does not run seshi"
grep -q 'sbx-codex-hook' config.first || fail "seshi dropped the codex kit's notify program"
as_agent seshi capture status | grep -Eq 'claude-code +installed' ||
  fail "claude-code is not installed: $(as_agent seshi capture status)"
as_agent seshi capture status | grep -Eq 'codex +installed' || fail "codex is not installed"

echo "== startup hook, device token"
as_agent SESHI_TOKEN="$DEVICE_TOKEN" seshi-sandbox start --server="$SERVER" --user=
as_agent seshi whoami | grep -qF "$OWNER" ||
  fail "not signed in as the token's owner: $(as_agent seshi whoami 2>&1)"

echo "== a session with a secret"
SESSION=5e551e00-0000-4000-8000-$(openssl rand -hex 6)
SECRET="ghp_$(openssl rand -hex 18)"
STEPS=$(printf 'The steps, in order. %.0s' $(seq 1 120))
jq -nc --arg s "$SESSION" --arg secret "$SECRET" --arg text "Deploying now. $STEPS" '
  {type: "user", uuid: "u1", timestamp: "2026-09-01T00:00:00.000Z", cwd: "/home/agent/work",
   sessionId: $s, message: {role: "user", content: ("Use the token " + $secret + " to deploy.")}},
  {type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-09-01T00:00:05.000Z",
   sessionId: $s,
   message: {role: "assistant", model: "claude-x", content: [{type: "text", text: $text}]}}
' >transcript.jsonl
TRANSCRIPT="/home/agent/.claude/projects/-home-agent-work/$SESSION.jsonl"
as_agent sh -c "mkdir -p '${TRANSCRIPT%/*}' && cat >'$TRANSCRIPT'" <transcript.jsonl
# Claude Code runs the Stop hook through sh with the event on stdin.
jq -nc --arg s "$SESSION" --arg t "$TRANSCRIPT" \
  '{session_id: $s, transcript_path: $t, cwd: "/home/agent/work", hook_event_name: "Stop"}' |
  as_agent sh -c "cd /home/agent/work && $STOP"

echo "== flush"
as_agent seshi-sandbox flush || fail "flush left uploads queued"

# The server stores an upload a moment after it accepts it.
i=0
until EXPORT=$(admin sessions export claude-code "$SESSION" --owner "$OWNER" 2>&1); do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    admin sessions ls --owner "$OWNER" >&2 || true
    as_agent seshi doctor --session "$SESSION" --agent claude-code >&2 || true
    fail "the session is not on the server after 30 s: $EXPORT"
  fi
  sleep 1
done
echo "$EXPORT" | grep -q 'Deploying now' || fail "the export is not the session: $EXPORT"
echo "$EXPORT" | grep -q "$SECRET" && fail "the planted secret reached the server"
echo "$EXPORT" | grep -q '\[redacted:' || fail "nothing in the stored session is redacted"
# The server counts what it replaced itself. Zero means the token arrived already redacted: the
# sandbox's seshi redacted it before upload.
SERVER_COUNT=$(admin sessions show claude-code "$SESSION" --owner "$OWNER" --json |
  jq '.redaction.counts["github-token"] // 0')
[ "$SERVER_COUNT" = 0 ] || fail "the token reached the server unredacted ($SERVER_COUNT found there)"
echo "stored with $(echo "$EXPORT" | grep -o 'redacted:[a-z-]*' | sort -u | tr '\n' ' ')"

echo "== flush with the server down"
SESSION2=5e551e00-0000-4000-8000-$(openssl rand -hex 6)
TRANSCRIPT2="/home/agent/.claude/projects/-home-agent-work/$SESSION2.jsonl"
sed "s/$SESSION/$SESSION2/g" transcript.jsonl | as_agent sh -c "cat >'$TRANSCRIPT2'"
compose stop seshi >/dev/null
jq -nc --arg s "$SESSION2" --arg t "$TRANSCRIPT2" \
  '{session_id: $s, transcript_path: $t, cwd: "/home/agent/work", hook_event_name: "Stop"}' |
  as_agent sh -c "cd /home/agent/work && $STOP"
if as_agent FLUSH_TRIES=15 seshi-sandbox flush >flush.out 2>&1; then
  cat flush.out
  fail "flush reported success while the server was down"
fi
compose up -d --wait --wait-timeout 180
as_agent seshi-sandbox flush || fail "flush did not send the queued session once the server was back"
i=0
until admin sessions show claude-code "$SESSION2" --owner "$OWNER" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge 30 ] && fail "the session queued while the server was down never arrived"
  sleep 1
done

echo "== startup hook, org key and username"
as_agent HOME=/tmp/orgkey SESHI_TOKEN="$ORG_KEY" seshi-sandbox start --server="$SERVER" \
  --user=orgkey-smoke
as_agent HOME=/tmp/orgkey seshi whoami | grep -q 'orgkey-smoke' ||
  fail "the org key login does not state the username: $(as_agent HOME=/tmp/orgkey seshi whoami 2>&1)"

echo "== an unreachable server fails nothing"
as_agent HOME=/tmp/offline LOGIN_TRIES=2 LOGIN_WAIT=1 SESHI_TOKEN="$DEVICE_TOKEN" \
  seshi-sandbox start --server=http://unreachable.invalid:7200 ||
  fail "start failed with the server unreachable"
as_agent HOME=/tmp/offline seshi-sandbox setup || fail "setup failed with the server unreachable"

echo "ok"
