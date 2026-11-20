# Demo: capturing agents in Docker Sandboxes

About ten minutes in one terminal, the same every time. A seshi server runs on this machine, and
Claude Code runs in a sandbox that carries the seshi kit. The audience sees the agent's session
arrive on the server with its secret redacted, while the sandbox can reach only the model and seshi.

`demo.sh` beside this file runs the whole thing. It starts from scratch, drives Claude for you,
and waits for Enter between scenes so you can talk.

## Once per machine

You need `sbx` signed in (`sbx login`), Docker, `jq`, and `seshi` (`curl -fsSL
https://github.com/dosu-ai/seshi/releases/latest/download/install.sh | sh`). Sign Claude in once
in any sandbox (`sbx run claude`, then `/login`, then `/exit`). `sbx` keeps that sign-in, and
every later sandbox starts signed in.

In the terminal you will present from:

```sh
eval "$(/opt/homebrew/bin/brew shellenv)"        # Homebrew's sbx and jq, on macOS
export PATH="$HOME/.local/bin:$PATH"              # where install.sh puts seshi
```

## Run it

```sh
~/seshi-demo/deploy/sandbox/demo.sh               # wherever the checkout is
```

Press Enter to move to the next scene.

| Scene | On screen | Say |
| --- | --- | --- |
| 0. Starting from scratch | Last run cleared; a fresh server on `127.0.0.1:7200` and an upload-only token stored in `sbx` | Nothing is left over from a previous run. |
| 1. The definition | The environment file, then `sbx env plan` | One file: an agent, the seshi kit, and the server. Docker shows what the sandbox gets before it exists, including a credential the proxy adds only for the seshi server. |
| 2. Create the sandbox | The sandbox is created, then `seshi whoami` from inside it | Creating it hooked seshi into Claude Code. Booting it signed seshi in. |
| 3. Claude handles a secret | The prompt with a fake GitHub token made for this run, then Claude's tool calls and reply | The agent put a GitHub token in a file and in its transcript. |
| 4. The session arrives | One line per session on the server, with its redaction count | Each finished turn is captured, redacted inside the sandbox, then uploaded. |
| 5. The session seshi captured | The session read back from the server as a transcript, each `[redacted:...]` in yellow | This is what the team gets: the whole session, without the secret. |
| 6. The secret stayed in the sandbox | `.env` in the sandbox beside the server's redaction counts; the token found 0 times | The secret is where the agent put it. It never reached the team's store. |
| 7. The upload token | `SESHI_TOKEN=proxy-managed...` | The sandbox holds a placeholder. The proxy on the host adds the real token. |
| 8. The network | `403` for example.com and port 7201, `200` for seshi | Other hosts are refused, even the next port on the same host. |
| 9. Remove the sandbox | The flush, the removal, and the session still listed on the server | Removing a sandbox deletes its disk, so seshi sends what is queued first. The sandbox is gone; its sessions are not. |

The fake token never appears on screen, whole or in part; the sandbox and the server checks use
it, the display shows `ghp_********`.

## Again, and after

Run `demo.sh` again for the next audience: it clears the last run first. `demo.sh reset` clears
everything when you're done. Neither touches your `sbx` sign-in, Claude's sign-in, or your own
seshi login, because the demo's seshi config lives in `~/.seshi-demo`.

To rehearse without pressing Enter: `DEMO_AUTO=1 demo.sh`.

A second terminal can show the server live during the run: `demo.sh watch`.

## Codex

The same kit works with `examples/codex.sbxenv.yaml` (sandbox `seshi-codex`), after `sbx secret
set openai --oauth`. `demo.sh` drives the Claude sandbox only.

## If something goes wrong

- Scene 2 never signs in: `sbx exec seshi-claude -- seshi capture status` shows the server and the
  sign-in state.
- Scene 3 prints "Claude failed": sign Claude in again (`sbx exec -it seshi-claude claude`, then
  `/login`), then run `demo.sh` again.
- Scene 4 times out: `sbx exec seshi-claude -- seshi capture status`. "Too small yet" means the
  session held under 2,000 characters after redaction, and seshi kept it back.
- `sbx secret set` or `seshi` hangs over SSH: a keychain prompt is waiting. Run `security
  unlock-keychain ~/Library/Keychains/login.keychain-db`, then run `demo.sh` again.
