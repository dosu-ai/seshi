# Demo: capturing agents in Docker Sandboxes

About ten minutes, and the same every time. A seshi server runs on this machine, Claude Code runs
in a sandbox that carries the seshi kit, and the audience watches the session arrive on the server
with the agent's secret redacted, while the sandbox can reach nothing but the model and seshi.

`demo.sh` beside this file does the setup, the evidence and the reset. It runs from any directory.

## Once per machine

You need `sbx` signed in (`sbx login`), Docker, `seshi` (`curl -fsSL
https://github.com/dosu-ai/seshi/releases/latest/download/install.sh | sh`), and `jq`. Sign
Claude in once in any sandbox (`sbx run claude`, then `/login`): `sbx` keeps that sign-in on the
host, and every later sandbox starts signed in.

Lay out three terminals, or three tmux panes, and in each:

```sh
eval "$(/opt/homebrew/bin/brew shellenv)"        # Homebrew's sbx and jq, on macOS
export PATH="$HOME/.local/bin:$PATH"              # where install.sh puts seshi
DEMO=~/seshi-demo/deploy/sandbox/demo.sh          # wherever the checkout is
```

Pane 1 is where you talk, pane 2 is the live view, pane 3 is Claude.

## Each run

### 0. Reset (before the audience, about 20 seconds)

```sh
$DEMO start        # pane 1
$DEMO watch        # pane 2: leave it running
```

`start` removes the last run's sandbox, server, sessions and token, starts a fresh server on
`127.0.0.1:7200`, and stores a fresh upload-only token as the `seshi` secret in `sbx`. Pane 2 says
"No sessions yet".

### 1. The definition

```sh
cat ~/seshi-demo/deploy/sandbox/examples/claude.sbxenv.yaml        # pane 1
```

> This file is everything a sandbox needs to be captured: an agent, the seshi kit, and where the
> server is. The kit is one folder: a descriptor, a Dockerfile that downloads a checksummed seshi
> release, and a short script.

### 2. Start Claude in a sandbox

```sh
sbx env run ~/seshi-demo/deploy/sandbox/examples/claude.sbxenv.yaml   # pane 3
```

Approve the plan. Point out the `seshi` credential for `localhost:7200` in it.

> Docker shows what this sandbox will get before it exists: the kit, one network rule for the
> seshi server, and a credential the proxy will put on requests to that server only. When the
> sandbox was created, the kit hooked seshi into Claude Code. When it booted, it signed in.

### 3. The agent handles a secret

```sh
$DEMO prompt       # pane 1: copy the prompt, paste it into Claude in pane 3
```

The prompt asks Claude to write a `.env` with a freshly made-up GitHub token, a script that reads
it, and to show both files. The token is visible on screen in pane 3.

> The agent just put a GitHub token in a file and printed it. That is in the session transcript
> now.

### 4. Watch it arrive

When Claude finishes the turn, pane 2 shows the session within a couple of seconds, for example:

```text
08:31:02  claude-code/4b1e9c2a  14 records  claude-opus-5-5  · 3 redacted · fake token on the server: 0
```

> Each finished turn is captured and uploaded. seshi redacted it inside the sandbox before
> anything left: the token appeared in several places, and the server holds none of them.

### 5. The proof

```sh
$DEMO proof        # pane 1
```

It prints four short sections:

1. The `.env` in the sandbox, with the token in the clear.
2. The same session on the server: `GITHUB_TOKEN=[redacted:github-token]`, and the token found
   0 times.
3. `SESHI_TOKEN` in the sandbox: `proxy-managed…`, a placeholder. The real upload token stays on
   the host, and the proxy adds it only to requests to `localhost:7200`.
4. `403` for `https://example.com` and for port 7201 on the host, `200` for seshi, then each
   host the sandbox tried, allowed or blocked, from `sbx policy log`.

> The secret is still in the sandbox, where the agent put it. It never reached the team's store.
> The sandbox can't read the upload token, and it can reach the model and seshi, nothing else:
> even the next port on the same host is refused.

### 6. Remove it without losing anything

Exit Claude in pane 3 (`/exit`), then:

```sh
$DEMO finish       # pane 1
```

`finish` runs `seshi-sandbox flush` in the sandbox, removes the sandbox only if the flush
succeeds, and lists the sessions on the server.

> Removing a sandbox deletes its disk. The flush sends anything still queued and fails if it
> can't, and only then does the sandbox go. The sandbox is gone; its sessions are not.

### Run it again

`$DEMO start` in pane 1 resets everything, and pane 2 keeps watching. `$DEMO stop` clears it all
when you're done. Neither touches your `sbx` sign-in, Claude's sign-in, or your own seshi login:
the demo's seshi config lives in `~/.seshi-demo`.

## Codex

The same with `examples/codex.sbxenv.yaml` (sandbox `seshi-codex`), after `sbx secret set openai
--oauth`. `demo.sh` drives the Claude sandbox only.

## If something goes wrong

- Pane 2 stays empty after a turn: `sbx exec seshi-claude -- seshi capture status` shows the queue,
  the server and whether it is signed in. "Not signed in" right after boot clears in a few
  seconds; the startup hook signs in in the background.
- "does not accept that credential": the `seshi` credential was not approved. `$DEMO start`, then
  step 2 again, and approve the credential.
- `sbx secret set` or `seshi` hangs over SSH: a keychain prompt is waiting. `security
  unlock-keychain ~/Library/Keychains/login.keychain-db`, then retry.
- A session under about 2,000 characters is not stored yet: give Claude one more turn.
