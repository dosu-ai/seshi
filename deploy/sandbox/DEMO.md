# Demo: capturing agents in Docker Sandboxes

About ten minutes. It starts a seshi server, runs Claude Code and then Codex in sandboxes that
carry the seshi kit, and shows that each session arrives on the server with its secret redacted,
and that the sandbox reached only the model's API and seshi. Each step has the commands, then
what to say while they run.

Before you start, have these on the presenting machine:

- `sbx`, signed in (`sbx login`), with `sbx secret set anthropic` and `sbx secret set openai
  --oauth` done.
- `seshi` on the host ([docs/install.md](../../docs/install.md)).
- A checkout of the release tag, open at its root.
- Two terminals: the host, and one for the sandbox.

## 1. Start the server

```sh
cd deploy/docker
cp .env.example .env && chmod 600 .env
docker compose up -d --wait
docker compose exec seshi seshi admin init    # copy the admin token
cd ../..
```

> This is the team's session store: one container, with sessions on a Docker volume. Every
> agent in every sandbox will send its sessions here.

## 2. Make a token for the sandboxes

```sh
seshi login --server http://127.0.0.1:7200 --token -      # paste the admin token
seshi tokens create device --owner demo@example.com --expires 1d
sbx secret set seshi                                       # paste the device token
```

> This token can upload sessions and do nothing else: it can't read or search a thing. It
> goes into the host's credential store, not into the sandbox. Inside the sandbox there is only
> a placeholder, and the proxy on the host puts the real token on requests to the seshi server
> and nowhere else.

## 3. Show the whole definition

```sh
cat deploy/sandbox/examples/claude.sbxenv.yaml
```

> This is everything a sandbox needs to be captured: an agent, the seshi kit, and where the
> server is. The kit is one folder: a descriptor, a Dockerfile that downloads a checksummed
> seshi release, and a short script. Codex uses the same file with a different agent.

## 4. Run Claude Code

```sh
sbx env run deploy/sandbox/examples/claude.sbxenv.yaml
```

`sbx` shows the plan and asks you to approve it, including the `seshi` credential for
`localhost:7200`. Approve it.

In Claude Code, give it a task that touches a secret, for example:

```text
Create a .env file with GITHUB_TOKEN=ghp_<36 letters and digits you make up>, then write a
deploy.sh that reads it, and show me both files.
```

> When the sandbox was created, the kit hooked seshi into Claude Code, next to the hooks Docker's
> own kit adds. When it booted, the kit signed in with that placeholder token. Now each turn
> the agent finishes is handed to seshi, which redacts it inside the sandbox before anything
> leaves.

## 5. Watch the session arrive

On the host:

```sh
seshi sessions ls --owner demo@example.com
seshi sessions export claude-code <id> --owner demo@example.com | grep -o 'redacted:[a-z-]*' | sort -u
seshi sessions export claude-code <id> --owner demo@example.com | grep -c 'ghp_'     # 0
```

> Here it is, a few seconds after the turn ended. The token the agent wrote is stored as
> `[redacted:…]`. It was redacted in the sandbox before upload and checked again on the server,
> and the made-up value appears nowhere in what's stored.

## 6. Run Codex with the same kit

```sh
sbx env run deploy/sandbox/examples/codex.sbxenv.yaml
```

Give it a small task, then run `seshi sessions ls --owner demo@example.com` on the host again.

> Same kit, different agent. Codex's session shows up under `codex/` beside Claude's. Docker
> runs Codex without its own inner sandbox, since the microVM is the boundary, and seshi rides
> on Codex's notify hook, so there is nothing to configure.

## 7. Show what the sandbox could reach

```sh
sbx exec seshi-claude -- curl -sS -m 5 -o /dev/null -w '%{http_code}\n' https://example.com
sbx exec seshi-claude -- curl -sS -m 5 -o /dev/null -w '%{http_code}\n' http://host.docker.internal:7201
sbx policy log
```

Both curls print `403`. The log has them under BLOCKED REQUESTS ("No matching allow rule"), and
`localhost:7200` under ALLOWED REQUESTS beside the model's API and the package mirror the Claude
kit's startup uses.

> Everything is closed unless a rule opens it. The kit opened exactly one address, the seshi
> server, and only for sandboxes that carry the kit: even the next port on the same host is
> refused.

## 8. Remove it without losing anything

```sh
sbx exec seshi-claude -- seshi-sandbox flush && sbx env rm deploy/sandbox/examples/claude.sbxenv.yaml
sbx exec seshi-codex -- seshi-sandbox flush && sbx env rm deploy/sandbox/examples/codex.sbxenv.yaml
```

> Removing a sandbox deletes its disk, so we flush first. `seshi-sandbox flush` runs an upload
> pass of its own and only succeeds when nothing is left queued, and the `&&` means a failed
> flush keeps the sandbox. The sessions are on the server, and the sandboxes are gone.

## Cleaning up

```sh
seshi tokens revoke <device token id>      # seshi tokens ls shows it
cd deploy/docker && docker compose down -v
```

## If something goes wrong

- Nothing arrives: run `sbx exec seshi-claude -- seshi capture status` to see the queue, the
  server, and whether it is signed in. `sbx exec seshi-claude -- seshi doctor` checks each
  session end to end.
- Sign-in failed: `sbx policy log` shows whether the sandbox reached
  `localhost:7200`. If it was refused, add the rule by hand:
  `sbx policy allow network --sandbox seshi-claude localhost:7200`.
- A session under about 2,000 characters is not stored yet: give the agent one more turn.
