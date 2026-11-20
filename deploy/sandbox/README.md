# seshi in Docker Sandboxes

This folder is a kit for [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) (`sbx`). Add
it to the stock `claude` or `codex` agent and every session the agent runs in the sandbox is
captured, redacted in the sandbox, and uploaded to your seshi server, the same way
`seshi capture install` does on a laptop.

```sh
sbx run claude --kit ./deploy/sandbox/seshi-sandbox-kit
```

`seshi-sandbox-kit/` is the kit, and `examples/` has an environment file for each agent.
[DEMO.md](DEMO.md) is a scripted walkthrough, and `demo.sh` runs and resets it. You need `sbx`, signed in with `sbx login`, on
macOS 14 or later on Apple silicon, Windows 11, or Ubuntu 24.04 with KVM. Docker Desktop is not
needed. You also need a seshi server. [deploy/docker/](../docker/README.md) runs one.

## Quick start

With the server kit running on this machine (it answers on `http://127.0.0.1:7200`), make a
device token for the person whose sessions these are. A device token can upload and nothing
else:

```sh
seshi login --server http://127.0.0.1:7200 --token -     # the admin token from `seshi admin init`
seshi tokens create device --owner you@example.com --expires 90d
```

Store it in `sbx`. It stays on the host and never enters a sandbox:

```sh
sbx secret set seshi    # paste the device token
```

Then start an agent with the kit, from a checkout of the release tag you run the server from:

```sh
sbx run claude --kit ./deploy/sandbox/seshi-sandbox-kit
sbx run codex --kit ./deploy/sandbox/seshi-sandbox-kit
```

The first time, `sbx` asks you to approve the `seshi` credential for `localhost:7200`. Without
that approval it starts the sandbox with the credential withheld, and sign-in fails with "does
not accept that credential". To approve it ahead of time, for a script or CI, add the binding to
`~/.config/sbx/credentials.yaml` before creating the sandbox:

```yaml
bindings:
  seshi:
    apiKey:
      domains: [localhost:7200]
```

The example environment files declare the same binding. A binding added after the sandbox was
created does not apply to it: create the sandbox again.

Or use an environment file, which also tries a last flush when the sandbox is removed:

```sh
sbx env run deploy/sandbox/examples/claude.sbxenv.yaml
```

Sessions show up on the host with `seshi sessions ls` as soon as the agent finishes a turn. In
the sandbox, `seshi capture status` shows what was sent, what is queued and why.

## What the kit does

The kit lays two programs over the agent's image: `seshi`, the release this kit's version
names (downloaded from the GitHub release and checked against its `SHA256SUMS` when the kit is
built), and `seshi-sandbox`, a small script that runs at three points:

- **When the sandbox is created**, `seshi-sandbox setup` runs `seshi capture install` for
  Claude Code and Codex, after the agent's own setup has written its settings. seshi's hooks go
  beside the hooks Docker's agent kits add for the desktop app, and Codex's `notify` program
  runs after seshi's. It also sets `keychain = false`, so credentials go in a 0600 file: a
  sandbox has no keychain.
- **Every time the sandbox boots**, `seshi-sandbox start` repeats the install (the agent's own
  setup rewrites its settings when the sandbox is recreated), signs in to the server with
  `SESHI_TOKEN`, and sends what an earlier run left queued. It runs in the background, so an
  unreachable server never holds up the agent: it keeps trying for 15 minutes, and sessions
  wait in the queue meanwhile. If the server refuses the credential, it stops and says so.
  `sbx exec <name> -- seshi-sandbox start --server=<url>` tries again by hand.
- **Before the sandbox is removed**, `seshi-sandbox flush` sends every session of the past
  30 days and exits 1 unless a full upload pass it ran itself left nothing queued or failed.
  See [Removing a sandbox](#removing-a-sandbox).

`setup` and `start` always exit 0: they print what went wrong, and the sandbox starts anyway.

## The kit's arguments

| Argument | Default | What it is |
| --- | --- | --- |
| `server` | `http://host.docker.internal:7200` | The server's URL, as the sandbox reaches it. `https://` for any server not on this machine |
| `host` | `localhost:7200` | The server as the sandbox's proxy sees it: the network rule and where the token goes |
| `user` | empty | With the org key as the secret, the username sessions are stored under |
| `version` | this release | The seshi release to install. It is a build argument, fixed when the kit is built |

Pass them with `--kit-arg`, or in an environment file's `kits[].args`:

```sh
sbx run claude --kit ./deploy/sandbox/seshi-sandbox-kit \
  --kit-arg server=https://seshi.example.com --kit-arg host=seshi.example.com
```

## Reaching the server

A sandbox's network is closed except for what a rule allows, and every connection goes through a
proxy on the host. The kit adds one rule, for `host`, so a sandbox with the kit can reach your
seshi server and a sandbox without it cannot.

- **A server on this machine.** Inside the sandbox, `localhost` is the sandbox itself, and the
  host is `host.docker.internal`. The proxy turns `host.docker.internal` into `localhost` before
  it connects, so the rule names `localhost:7200`. The server kit's default (port 7200 on
  127.0.0.1) works as it is, because the proxy connects from the host. For another port, set
  both `server` and `host`.
- **A server elsewhere.** Set `server=https://seshi.example.com` and `host=seshi.example.com`.
  The kit refuses plain `http://` for anything but `host.docker.internal`, because the proxy
  puts the real token on each request. [deploy/docker/](../docker/README.md#https) puts Caddy in
  front of the server for HTTPS.

Write rules for `localhost:<port>`, never `host.docker.internal`: the proxy matches the address
after it rewrites it, so a rule on `host.docker.internal` is listed but not applied
([docker/sbx-releases#546](https://github.com/docker/sbx-releases/issues/546)). If a sandbox was
made without the kit's rule, add it by hand: `sbx policy allow network --sandbox <name>
localhost:7200`. `sbx policy log` shows what a sandbox reached and what was refused.

## Credentials

The kit asks `sbx` for a credential named `seshi`. The sandbox sees a placeholder in
`SESHI_TOKEN`, and `seshi login` stores that placeholder. When seshi calls the server, the proxy
replaces the `Authorization` header with the real secret, and only for `host`.

| Secret | What someone in control of the sandbox can do |
| --- | --- |
| A device token (recommended) | Upload sessions as that one person, while the sandbox runs. Nothing to read, and nothing to copy out |
| The org key, with `user` | Anything the org key allows, through the proxy, while the sandbox runs: read and search the org's sessions, and upload as any username |

Either way the secret itself never enters the sandbox, so removing the sandbox ends what it can
do. Revoke a device token with `seshi tokens revoke <id>`. The credential is optional: without
it the kit still installs the hooks, sessions queue, and you can sign in by hand with
`sbx exec -it <name> -- seshi login --server <url>`. That stores a real credential in the
sandbox, so prefer a device token for that too.

## Removing a sandbox

The sandbox's disk survives `sbx stop` and a restart, and the startup hook sends what was
queued. `sbx rm` deletes it, with any session the uploader has not sent yet. Each finished turn
is uploaded within seconds, so what is at risk is the last turn, or everything while the server
is unreachable. Flush first, and remove the sandbox only if the flush succeeds:

```sh
sbx exec <name> -- seshi-sandbox flush && sbx rm <name>
```

`sbx exec` starts a sandbox that has stopped. The flush exits 1, and the `&&` keeps the
sandbox, when anything is still queued or the server cannot be reached.

The example environment files also run the flush as a `preRemove` step. That is a last try,
not a guard: `sbx env rm` runs it after you approve the removal, and if it fails, `sbx` warns
and removes the sandbox anyway. Flush with `sbx exec` before `sbx env rm` too. `sbx run --rm`
removes the sandbox when the agent exits, with no step in between, so don't use `--rm` for
sessions you want kept.

## Codex

Docker's `codex` agent runs Codex with its own sandbox off (`sandbox_mode =
"danger-full-access"`), because the Docker sandbox is the boundary. seshi captures Codex through
its `notify` program, which Codex runs outside any sandbox of its own, so nothing needs
configuring. If you turn Codex's sandbox back on, `seshi capture off` and `on` typed as a shell
command fail with EPERM, because they write seshi's state folder outside the workspace. Type
`$session-capture off` as a message of its own instead: seshi's hook does it before Codex sees
it.

## The published kit

Each release also publishes the kit as `ghcr.io/dosu-ai/seshi-sandbox-kit:X.Y.Z` (and `X.Y`,
`latest`), for both arm64 and amd64. `sbx` takes kits from Docker Hub only until you allow the
registry:

```sh
sbx settings set kit.allowedSources '["docker.io/","ghcr.io/dosu-ai/"]'
sbx run claude --kit ghcr.io/dosu-ai/seshi-sandbox-kit:X.Y.Z
```

The setting replaces the whole list, so keep any sources you already had.

## Building and testing it

```sh
docker buildx build -f deploy/sandbox/seshi-sandbox-kit/seshi-sandbox-kit.yaml \
  -t seshi-sandbox-kit:dev deploy/sandbox/seshi-sandbox-kit/
sh scripts/sandbox-kit-smoke.sh
```

The build runs the kit's own frontend (`docker/sandbox-kit:3`), which checks the descriptor.
The smoke test needs no `sbx`. It lays the kit over a stand-in agent image with the settings
Docker's agent kits write and the shared skills folders mounted read-only. Then it runs both
hooks against the server kit, plants a fake GitHub token in a Claude Code session, and checks
that the session arrives with the token already redacted in the sandbox. It also checks that
`flush` fails while the server is stopped and succeeds once it is back. CI runs it on every
change, with that change's seshi in place of the release.

Only a real sandbox can check the network rule, the credential proxy and the hooks' trimmed
environment. Check those by hand when the kit changes (with `sbx` 0.54 they all hold):

1. `sbx run claude --kit ./deploy/sandbox/seshi-sandbox-kit`, finish a turn, and see the
   session in `seshi sessions ls` on the host.
2. `sbx exec <name> -- printenv SESHI_TOKEN` prints a placeholder, not the token.
3. `sbx policy log` lists `localhost:7200` as allowed, and `sbx exec <name> -- curl -m 5
   https://example.com` is refused.
4. Do the same with `codex`.
5. `sbx stop <name>`, `sbx run <name>`, and `seshi capture status` in the sandbox shows nothing
   queued.
