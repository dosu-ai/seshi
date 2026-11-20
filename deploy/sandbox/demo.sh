#!/bin/sh
# Runs the Docker Sandboxes demo (DEMO.md) the same way every time, from any directory.
#
#   demo.sh start     wipe everything, then start a fresh server and store a fresh upload token
#   demo.sh prompt    print the prompt to paste into Claude, with a new fake GitHub token
#   demo.sh watch     a live view of the sessions arriving on the server (leave it running)
#   demo.sh proof     the agent's file in the sandbox beside the server's copy, the token the
#                     sandbox holds, and what the sandbox may reach
#   demo.sh finish    flush the sandbox, remove it, and show the sessions are still there
#   demo.sh stop      remove the sandbox, the server and its data, and the stored token
#
# The host's seshi runs with its own config in $DEMO_STATE (default ~/.seshi-demo), so the
# demo never touches your own seshi login. Your sbx sign-in and Claude sign-in are kept.
set -eu

KIT_DIR=$(cd "$(dirname "$0")" && pwd)
DOCKER_DIR=$(cd "$KIT_DIR/../docker" && pwd)
ENV_FILE="$KIT_DIR/examples/claude.sbxenv.yaml"
BOX=seshi-claude
OWNER=demo@example.com
SERVER=http://127.0.0.1:7200
STATE=${DEMO_STATE:-$HOME/.seshi-demo}

for tool in docker sbx seshi jq openssl; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "demo.sh: $tool is not on PATH" >&2
    exit 1
  }
done

# The host's seshi, with the demo's own config and no keychain (an SSH session cannot open it).
s() {
  XDG_CONFIG_HOME="$STATE/config" XDG_STATE_HOME="$STATE/state" SESHI_KEYCHAIN=false seshi "$@"
}
compose() { docker compose -f "$DOCKER_DIR/compose.yaml" --project-directory "$DOCKER_DIR" "$@"; }
heading() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
token() { cat "$STATE/fake-token" 2>/dev/null || true; }
latest() { s sessions ls --owner "$OWNER" --json 2>/dev/null | jq -r '.sessions[0].session_id // empty'; }
box_exists() { sbx ls 2>/dev/null | awk 'NR > 1 {print $1}' | grep -qx "$BOX"; }

stop() {
  if box_exists; then sbx rm --force "$BOX" >/dev/null && echo "removed sandbox $BOX"; fi
  compose down -v --remove-orphans 2>/dev/null && echo "removed the server and its sessions"
  if sbx secret ls 2>/dev/null | grep -q ' seshi '; then
    sbx secret rm seshi --force >/dev/null 2>&1 || sbx secret rm seshi >/dev/null
    echo "removed the stored seshi token"
  fi
  rm -rf "$STATE"
}

start() {
  heading "Clearing the last run"
  stop
  mkdir -p "$STATE" && chmod 700 "$STATE"
  heading "Starting a fresh seshi server on $SERVER"
  [ -e "$DOCKER_DIR/.env" ] || { cp "$DOCKER_DIR/.env.example" "$DOCKER_DIR/.env" && chmod 600 "$DOCKER_DIR/.env"; }
  compose up -d --wait
  compose exec -T seshi seshi admin init --json | jq -r .admin.token |
    s login --server "$SERVER" --token - >/dev/null
  heading "Storing an upload-only token for $OWNER in sbx"
  s tokens create device --owner "$OWNER" --expires 1d --json | jq -r .token |
    sbx secret set seshi >/dev/null
  sbx secret ls
  heading "Ready"
  cat <<EOF
Next:
  pane 2:  $0 watch
  pane 3:  sbx env run $ENV_FILE
  pane 1:  $0 prompt
EOF
}

prompt() {
  mkdir -p "$STATE"
  fake="ghp_$(openssl rand -hex 18)"
  printf '%s' "$fake" >"$STATE/fake-token"
  heading "Paste this into Claude"
  cat <<EOF
Create a file named .env in the current folder containing exactly one line:
GITHUB_TOKEN=$fake
Then write deploy.sh that loads .env and prints "deploying as" followed by the first 8
characters of the token. Run deploy.sh, then show me both files.
EOF
}

render() {
  printf 'seshi server %s · sessions uploaded by %s · %s\n\n' "$SERVER" "$OWNER" "$(date +%T)"
  list=$(s sessions ls --owner "$OWNER" --json 2>/dev/null) || {
    echo "the server is not answering: run $0 start"
    return
  }
  if [ "$(echo "$list" | jq '.sessions | length')" = 0 ]; then
    echo "No sessions yet. They arrive a second or two after Claude finishes a turn."
    return
  fi
  fake=$(token)
  # Fields come from what a sandbox uploaded: strip control characters before they reach the
  # terminal, so an agent cannot plant escape sequences in the presenter's screen.
  echo "$list" | jq -r '.sessions[:5][] | [.session_id, (.normalized.records|tostring), ((.models // [])[0] // "-"), .active_at] | map(gsub("[[:cntrl:]]"; "")) | @tsv' |
    while IFS="$(printf '\t')" read -r id records model at; do
      export_text=$(s sessions export claude-code "$id" --owner "$OWNER" 2>/dev/null || true)
      redacted=$(printf '%s' "$export_text" | grep -o '\[redacted:[a-z-]*\]' | wc -l | tr -d ' ')
      line="$(echo "$at" | cut -c12-19)  claude-code/$(echo "$id" | cut -c1-8)  $records records  $model  · $redacted redacted"
      if [ -n "$fake" ]; then
        line="$line · fake token on the server: $(printf '%s' "$export_text" | grep -c "$fake" || true)"
      fi
      echo "$line"
    done
}

watch_sessions() {
  while :; do
    frame=$(render 2>&1)
    clear
    printf '%s\n' "$frame"
    sleep 2
  done
}

proof() {
  fake=$(token)
  id=$(latest)
  [ -n "$id" ] || { echo "No session on the server yet: finish a turn in Claude first."; exit 1; }
  heading "1. In the sandbox: the file the agent wrote"
  if [ -n "$fake" ]; then
    sbx exec "$BOX" -- sh -c "grep -rIl --exclude-dir=.claude --exclude-dir=.local '$fake' /home/agent 2>/dev/null | while read -r f; do echo \"\$f:\"; grep -h '$fake' \"\$f\"; done" |
      tr -d '\000-\010\013-\037\177' || true
  else
    echo "(run '$0 prompt' to plant a fake token)"
  fi
  heading "2. On the seshi server: the same session, claude-code/$id"
  export_text=$(s sessions export claude-code "$id" --owner "$OWNER")
  found=$(printf '%s' "$export_text" | grep -o '[A-Za-z_]*=\[redacted:[a-z-]*\]' | sort | uniq -c)
  [ -n "$found" ] || found=$(printf '%s' "$export_text" | grep -o '.\{0,24\}\[redacted:[a-z-]*\]' | sort -u | head -5)
  printf '%s\n' "${found:-(nothing redacted in this session)}"
  if [ -n "$fake" ]; then
    echo "the fake token appears on the server $(printf '%s' "$export_text" | grep -c "$fake" || true) times"
  fi
  heading "3. The upload token inside the sandbox"
  # shellcheck disable=SC2016 # expanded in the sandbox, not here
  sbx exec "$BOX" -- sh -c 'echo "SESHI_TOKEN=$(printenv SESHI_TOKEN | cut -c1-20)…"; seshi whoami | head -1'
  echo "(a placeholder: the proxy on the host swaps in the real token, only for localhost:7200)"
  heading "4. What the sandbox may reach"
  for url in https://example.com http://host.docker.internal:7201 http://host.docker.internal:7200/healthz; do
    code=$(sbx exec "$BOX" -- curl -s -m 5 -o /dev/null -w '%{http_code}' "$url" || true)
    echo "$code  $url"
  done
  echo "sbx policy log, this sandbox only:"
  sbx policy log 2>/dev/null | awk -v box="$BOX" '
    /BLOCKED REQUESTS/ { verdict = "blocked" }
    /ALLOWED REQUESTS/ { verdict = "allowed" }
    $1 == box { print "  " verdict "  " $3 }' | sort -u
}

finish() {
  box_exists || { echo "No sandbox $BOX to remove."; exit 1; }
  heading "Flushing $BOX, then removing it"
  sbx exec "$BOX" -- seshi-sandbox flush
  sbx rm --force "$BOX"
  heading "The sessions outlive the sandbox"
  s sessions ls --owner "$OWNER"
}

case "${1:-}" in
  start) start ;;
  prompt) prompt ;;
  watch) watch_sessions ;;
  proof) proof ;;
  finish) finish ;;
  stop) stop ;;
  *)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
