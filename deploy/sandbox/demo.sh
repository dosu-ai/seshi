#!/bin/sh
# The Docker Sandboxes demo (DEMO.md) in one terminal, the same way every time, from any directory.
#
#   demo.sh           the whole demo: starts from scratch, then runs each scene and waits for Enter
#   demo.sh reset     remove the sandbox, the server and its sessions, and the stored token
#   demo.sh watch     a live list of the sessions on the server, for a second terminal (optional)
#
# DEMO_AUTO=1 runs it without waiting for Enter, to rehearse. The host's seshi uses its own config
# in $DEMO_STATE (default ~/.seshi-demo), so the demo never touches your own seshi login. Your sbx
# sign-in and Claude's sign-in are kept.
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
# Anything the sandbox prints is the agent's to control: keep tab, newline and printable ASCII
# only, so nothing in it can drive the presenter's terminal.
clean() { LC_ALL=C tr -cd '\11\12\40-\176'; }
in_box() { sbx exec "$BOX" -- "$@" 2>/dev/null; }
scene() { printf '\n\033[1;36m━━ %s\033[0m\n' "$*"; }
caption() { printf '\033[2m%s\033[0m\n\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() {
  printf '  \033[31m✗\033[0m %s\n' "$*" >&2
  exit 1
}
pause() {
  [ "${DEMO_AUTO:-}" = 1 ] && return 0
  printf '\n\033[2m[Enter] %s\033[0m' "$1"
  read -r _ </dev/tty || true
}
fake_token() { cat "$STATE/fake-token" 2>/dev/null || true; }
# What reaches the screen never shows the fake token: not whole, and not the 8 characters
# deploy.sh prints. [redacted:...] markers are shown in yellow. Line by line, so a stream stays live.
show() {
  awk -v full="$(fake_token)" -v esc="$(printf '\033')" '{
    if (full != "") { gsub(full, "ghp_********"); gsub(substr(full, 1, 8), "ghp_****") }
    gsub(/\[redacted:[a-z-]+\]/, esc "[33m&" esc "[0m")
    print
    fflush()
  }'
}
# The newest session's ID. A sandbox chose it, so anything but a plain ID is dropped.
latest() {
  s sessions ls --owner "$OWNER" --json 2>/dev/null |
    jq -r '.sessions[0].session_id // empty | select(test("\\A[A-Za-z0-9._-]+\\z"))'
}
box_exists() { sbx ls 2>/dev/null | awk 'NR > 1 {print $1}' | grep -qx "$BOX"; }
# Waits up to $2 seconds for the command after it to succeed, printing a dot every 2 seconds.
wait_for() {
  what=$1 limit=$2
  shift 2
  printf '  waiting for %s ' "$what"
  waited=0
  until "$@" >/dev/null 2>&1; do
    waited=$((waited + 2))
    [ "$waited" -le "$limit" ] || { echo; return 1; }
    printf '.'
    sleep 2
  done
  echo
}

reset() {
  if box_exists; then sbx rm --force "$BOX" >/dev/null 2>&1 && ok "removed sandbox $BOX"; fi
  running=$(compose ps -aq 2>/dev/null || true)
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  [ -z "$running" ] || ok "removed the seshi server and its sessions"
  if sbx secret ls 2>/dev/null | grep -q ' seshi '; then
    sbx secret rm seshi --force >/dev/null 2>&1 || sbx secret rm seshi >/dev/null
    ok "removed the seshi token stored in sbx"
  fi
  rm -rf "$STATE"
}

# One line per session on the server: when, which, how big, the model, what was redacted, and
# how often the fake token appears in the server's copy.
render() {
  list=$(s sessions ls --owner "$OWNER" --json 2>/dev/null) || {
    echo "the server is not answering: run $0"
    return
  }
  if [ "$(echo "$list" | jq '.sessions | length')" = 0 ]; then
    echo "No sessions yet. They arrive a second or two after Claude finishes a turn."
    return
  fi
  fake=$(fake_token)
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
    printf 'seshi server %s · sessions uploaded by %s · %s\n\n%s\n' "$SERVER" "$OWNER" "$(date +%T)" "$frame"
    sleep 2
  done
}

# Claude's stream-json events as a transcript: what it says, each tool it runs, and the first
# lines of what each tool returned.
RENDER_CLAUDE='
def clean: split("\n") | map(gsub("[[:cntrl:]]"; "")) | join("\n");
def indent: split("\n") | .[:6] | map("      " + .) | join("\n");
if .type == "assistant" then
  .message.content[]? |
  if .type == "text" then "\n" + (.text | clean)
  elif .type == "tool_use" then
    "  > \(.name | tostring | clean) \((.input.file_path // .input.command // "") | tostring | split("\n")[0] | clean)"
  else empty end
elif .type == "user" then
  .message.content[]? | select(.type? == "tool_result") |
  (.content | if type == "array" then map(.text? // "") | join("\n") else tostring end) | clean | indent
elif .type == "result" and .is_error then "Claude failed: \(.result | tostring | clean)"
else empty end'

# A session as the server stores it (seshi/trace/1), as a transcript: who spoke, each tool call
# and its result, the first lines of each. $n is a jq variable.
# shellcheck disable=SC2016
RENDER_SESSION='
def lines($n): tostring | split("\n") | map(gsub("[[:cntrl:]]"; "")) | map(select(length > 0)) |
  (.[:$n] + (if length > $n then ["…"] else [] end)) | map("    │ " + .) | .[];
def call: if type == "string" then (try fromjson catch .) else . end |
  if type == "object" then (.command // .file_path // .content // tojson) else . end;
.records[] |
if .role == "meta" then "  model \(.model // "-" | tostring | gsub("[[:cntrl:]]"; "")), working in \(.cwd // "-" | tostring | gsub("[[:cntrl:]]"; ""))\n"
elif .role == "user" then "  you asked", (.content | lines(8)), ""
elif .role == "assistant" then
  (if .content then "  Claude said", (.content | lines(8)), "" else empty end),
  (.tool_calls[]? | "  Claude ran \(.name | tostring | gsub("[[:cntrl:]]"; ""))", (.args | call | lines(10)), "")
elif .role == "tool" then
  "  the tool returned" + (if .withheld then " (withheld whole: \(.withheld | tostring | gsub("[[:cntrl:]]"; "")))" else "" end),
  (.content | lines(4)), ""
else empty end'

run() {
  scene "0. Starting from scratch"
  caption "Last run's sandbox, server, sessions and token go; a fresh server and token take their place."
  reset
  mkdir -p "$STATE" && chmod 700 "$STATE"
  [ -e "$DOCKER_DIR/.env" ] || { cp "$DOCKER_DIR/.env.example" "$DOCKER_DIR/.env" && chmod 600 "$DOCKER_DIR/.env"; }
  compose up -d --wait >"$STATE/compose.log" 2>&1 || { cat "$STATE/compose.log"; fail "the seshi server did not start"; }
  compose exec -T seshi seshi admin init --json | jq -r .admin.token |
    s login --server "$SERVER" --token - >/dev/null
  ok "seshi server running on $SERVER"
  s tokens create device --owner "$OWNER" --expires 1d --json | jq -r .token |
    sbx secret set seshi >/dev/null 2>&1
  ok "upload-only token for $OWNER stored in sbx as the secret 'seshi'"
  pause "show the environment file"

  scene "1. The definition"
  caption "One file: an agent, the seshi kit, and where the server is."
  grep -v '^ *#' "$ENV_FILE" | sed '/^$/d; s/^/  /'
  pause "ask Docker what this sandbox will get"
  echo
  sbx env plan "$ENV_FILE" 2>&1 | sed "s#$KIT_DIR/##g" | sed '/^$/d'
  echo
  caption "Before the sandbox exists: the kit, a credential the proxy adds only for the seshi server, and a flush before removal."
  pause "create the sandbox"

  scene "2. Create the sandbox"
  caption "Creating it installs seshi's capture hooks in Claude Code. Booting it signs seshi in, in the background."
  sbx env run --detach --force "$ENV_FILE" >"$STATE/create.log" 2>&1 ||
    { clean <"$STATE/create.log"; fail "sbx could not create the sandbox"; }
  ok "created sandbox $BOX from docker.io/sbx/claude and the seshi kit"
  ok "seshi's capture hooks added to Claude Code"
  wait_for "seshi to sign in inside the sandbox" 120 in_box seshi whoami ||
    fail "seshi did not sign in: sbx exec $BOX -- seshi capture status"
  in_box seshi whoami | clean | sed 's/^/  /'
  in_box seshi capture status | clean | sed -n '1,4p' | sed 's/^/  /'
  pause "give Claude a secret"

  scene "3. Claude handles a secret"
  fake="ghp_$(openssl rand -hex 18)"
  printf '%s' "$fake" >"$STATE/fake-token"
  prompt="Create a file named .env in the current folder containing exactly one line:
GITHUB_TOKEN=$fake
Then write deploy.sh that loads .env, stops if the token is empty, and prints \"deploying as\"
followed by the first 8 characters of the token, and a README.md with setup steps for a new
teammate. Run deploy.sh. Finish with a short review, about 200 words, of how safely this setup
handles the token."
  caption "Claude Code runs in the sandbox with this prompt and a GitHub token made up for this run (hidden on screen):"
  printf '%s\n' "$prompt" | sed 's/^/  │ /' | show
  echo
  in_box claude -p "$prompt" --dangerously-skip-permissions --output-format stream-json --verbose |
    jq --unbuffered -r "$RENDER_CLAUDE" | show
  echo
  caption "The token is in a file in the sandbox and in Claude's session transcript."
  pause "look at the seshi server"

  scene "4. The session arrives on the server"
  caption "The turn's Stop hook queued the session. seshi redacted it inside the sandbox, then uploaded it."
  # seshi keeps back a session under 2,000 characters once redacted; the prompt's review keeps
  # this one over that however Claude splits its tool calls.
  wait_for "the session to reach the server" 60 latest_present ||
    fail "no session on the server: sbx exec $BOX -- seshi capture status"
  render | sed 's/^/  /'
  pause "open the session seshi captured"

  id=$(latest)
  export_text=$(s sessions export claude-code "$id" --owner "$OWNER")
  scene "5. The session seshi captured"
  caption "claude-code/$id, read back from the seshi server, as the team sees it:"
  printf '%s' "$export_text" | jq -r "$RENDER_SESSION" | show
  caption "Every [redacted:...] was replaced inside the sandbox, before the upload."
  pause "compare it with the sandbox"

  scene "6. The secret stayed in the sandbox"
  caption "In the sandbox, the file Claude wrote (the token is hidden on screen; the file holds all of it):"
  # shellcheck disable=SC2016 # expanded in the sandbox, not here
  in_box sh -c 'grep -rIl --exclude-dir=.claude --exclude-dir=.local "$1" /home/agent | while read -r f; do echo "$f:"; grep -h "$1" "$f"; done' sh "$fake" |
    clean | sed 's/^/  /' | show || true
  echo
  caption "On the seshi server, the same session:"
  found=$(printf '%s' "$export_text" | grep -o '\[redacted:[a-z-]*\]' | sort | uniq -c | sort -rn || true)
  printf '%s\n' "${found:-(nothing redacted in this session)}" | clean | sed 's/^ */  /' | show
  echo "  the token appears on the server $(printf '%s' "$export_text" | grep -c "$fake" || true) times"
  echo
  caption "credential is the token itself. sensitive-file is each tool call that read or wrote .env, withheld whole."
  pause "show the token the sandbox holds"

  scene "7. The sandbox never sees the upload token"
  # shellcheck disable=SC2016 # expanded in the sandbox, not here
  in_box sh -c 'echo "SESHI_TOKEN=$(printenv SESHI_TOKEN | cut -c1-20)..."' | clean | sed 's/^/  /'
  echo
  caption "A placeholder. The proxy on the host adds the real token, and only to requests to localhost:7200."
  pause "try to reach other hosts from the sandbox"

  scene "8. The sandbox's network is closed by default"
  for url in https://example.com http://host.docker.internal:7201 http://host.docker.internal:7200/healthz; do
    code=$(in_box curl -s -m 5 -o /dev/null -w '%{http_code}' "$url" | clean || true)
    echo "  ${code:-???}  $url"
  done
  echo
  caption "A site and the next port on the same host are refused. The seshi server answers because the kit's network rule names it."
  pause "remove the sandbox"

  scene "9. Remove the sandbox, keep the sessions"
  caption "Removing a sandbox deletes its disk, so seshi first sends anything still queued, and fails if it can't."
  sbx exec "$BOX" -- seshi-sandbox flush 2>&1 | clean | sed 's/^/  /'
  sbx rm --force "$BOX" >/dev/null 2>&1
  ok "removed sandbox $BOX"
  echo
  caption "On the server:"
  s sessions ls --owner "$OWNER" | clean | sed 's/^/  /'

  printf '\n\033[1mDone.\033[0m Run it again: %s    Clear everything: %s reset\n' "$0" "$0"
}
latest_present() { [ -n "$(latest)" ]; }

case "${1:-run}" in
  run) run ;;
  reset) reset ;;
  watch) watch_sessions ;;
  *)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
