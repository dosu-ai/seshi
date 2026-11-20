# Installing seshi

seshi is one binary (X2.2): the CLI, the hooks agents call and the server. Every channel ships
the same compiled file, built once per release (F8.4):

| Channel | Command | Updates |
|---|---|---|
| Install script (macOS, Linux) | `curl -fsSL https://github.com/dosu-ai/seshi/releases/latest/download/install.sh \| sh` | Run it again |
| Install script (Windows) | `irm https://github.com/dosu-ai/seshi/releases/latest/download/install.ps1 \| iex` | Run it again |
| npm | `npm i -g @dosu/seshi`, or `npx @dosu/seshi …` | `npm i -g @dosu/seshi@latest` |
| GitHub release | Download the archive for your platform and `SHA256SUMS` | By hand |
| Docker (the server) | `docker run ghcr.io/dosu-ai/seshi`, or the Compose kit in [`deploy/docker/`](../deploy/docker/README.md) ([server.md](server.md)) | New tag |
| Docker Sandboxes (agents in `sbx`) | `sbx run claude --kit ghcr.io/dosu-ai/seshi-sandbox-kit:X.Y.Z`, or the kit in [`deploy/sandbox/`](../deploy/sandbox/README.md) | New tag |

Homebrew, and signed or notarized binaries, come later.

## Platforms

| Platform | Archive | npm package |
|---|---|---|
| macOS, Apple silicon | `seshi-darwin-arm64.tar.gz` | `@dosu/seshi-darwin-arm64` |
| macOS, Intel | `seshi-darwin-x64.tar.gz` | `@dosu/seshi-darwin-x64` |
| Linux x64 (glibc) | `seshi-linux-x64.tar.gz` | `@dosu/seshi-linux-x64` |
| Linux arm64 (glibc) | `seshi-linux-arm64.tar.gz` | `@dosu/seshi-linux-arm64` |
| Windows x64 | `seshi-windows-x64.zip` | `@dosu/seshi-windows-x64` |
| Windows arm64 | `seshi-windows-arm64.zip` | `@dosu/seshi-windows-arm64` |

Each archive holds `seshi` (`seshi.exe` on Windows) and `LICENSE`. The x64 builds run on any
x64 CPU, including older ones without AVX2 and Intel builds under Rosetta 2, though the install
script picks the native build on Apple silicon.

Linux binaries need glibc. Alpine and other musl systems are not supported yet: the install
script and the npm launcher say so rather than install a binary that cannot start. Run the
Docker image there, or a glibc-based image.

## The install script (macOS and Linux)

```sh
curl -fsSL https://github.com/dosu-ai/seshi/releases/latest/download/install.sh | sh
```

It picks the archive for your machine, downloads it with `SHA256SUMS` from the same release,
refuses to install anything if the checksum does not match, puts `seshi` in `~/.local/bin`
(`$XDG_BIN_HOME` when set), runs `seshi --version`, and, when that folder is not on your
`PATH`, adds one line to your shell's startup file (`~/.zshrc`, `~/.bashrc`, `~/.bash_profile`
on macOS, fish's `config.fish`, else `~/.profile`). Running it again upgrades in place, even
while seshi is running.

Options go after `sh -s --`:

```sh
curl -fsSL …/install.sh | sh -s -- --version 1.2.3 --dir /usr/local/bin --no-modify-path
```

| Option | |
|---|---|
| `--version <X.Y.Z>` | A release; the latest by default |
| `--dir <folder>` | Where to put `seshi` |
| `--no-modify-path` | Never edit a startup file; just say when the folder is not on `PATH` |
| `--base-url <url>` | Where releases are, for a mirror: `<url>/latest/download/<asset>` and `<url>/download/v<X.Y.Z>/<asset>`. `https://github.com/dosu-ai/seshi/releases` by default |

It needs `curl` (or `wget`), `tar`, and one of `sha256sum`, `shasum` or `openssl`.

The scripts take flags rather than `SESHI_*` variables on purpose: seshi refuses `SESHI_*`
names it does not know ([config.md](config.md)), so an installer variable left exported in a
profile would break every seshi command.

## The install script (Windows)

In PowerShell (Windows PowerShell 5.1 or PowerShell 7):

```powershell
irm https://github.com/dosu-ai/seshi/releases/latest/download/install.ps1 | iex
```

It downloads `seshi-windows-x64.zip` (or `-arm64`), checks it against `SHA256SUMS`, puts
`seshi.exe` in `%LOCALAPPDATA%\Programs\seshi`, and adds that folder to your user `PATH`
(kept as an expandable registry value, so `%USERPROFILE%`-style entries survive). New
terminals see it; the current one does at once. A running `seshi.exe` is renamed aside rather
than overwritten, so upgrading works while seshi runs.

With options:

```powershell
& ([scriptblock]::Create((irm https://github.com/dosu-ai/seshi/releases/latest/download/install.ps1))) -Version 1.2.3 -NoModifyPath
```

Parameters: `-Version`, `-InstallDir`, `-NoModifyPath`, `-BaseUrl` (as the shell script's).

## npm

```sh
npm i -g @dosu/seshi
npx @dosu/seshi --help
```

The `@dosu/seshi` package is a small launcher; npm also installs the one optional dependency that
matches your machine (`@dosu/seshi-darwin-arm64` and so on, chosen by their `os`, `cpu` and
`libc` fields), which holds the binary. The launcher runs it with your arguments and passes its
exit status back. Node only starts it: hook commands that `seshi capture install` writes name
the binary itself, so agents do not start Node on every turn. Run `seshi capture install` from
an installed seshi, not `npx`: npx keeps the binary in a cache it may delete, and the hooks would
stop working (seshi warns when it sees that).

If npm was told to skip optional dependencies (`--omit=optional`), or a lock file was made on
another platform, the binary is missing and `seshi` says so; reinstall with optional
dependencies or use the install script.

The libraries `@dosu/seshi-client` (the typed HTTP client) and `@dosu/seshi-model` (the shared types,
canonical text and hashing) are published at the same version, as ES modules for Node 20+ and
Bun with TypeScript declarations.

## Checking a download by hand

Each release carries `SHA256SUMS`, in `sha256sum`'s format, covering every archive and both
install scripts:

```sh
curl -fsSLO https://github.com/dosu-ai/seshi/releases/latest/download/seshi-linux-x64.tar.gz
curl -fsSLO https://github.com/dosu-ai/seshi/releases/latest/download/SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS    # macOS: shasum -a 256 --ignore-missing -c SHA256SUMS
tar -xzf seshi-linux-x64.tar.gz
```

On Windows: `(Get-FileHash seshi-windows-x64.zip -Algorithm SHA256).Hash` against its line.

## Credentials on headless machines

`seshi login` keeps credentials in the OS keychain (macOS Keychain, Windows Credential
Manager, the Secret Service on Linux), falling back to `credentials.json` (mode 0600) where
there is none ([cli.md](cli.md#signing-in-f82)). On a CI runner or a container whose keychain
prompts or hangs instead of refusing, set `keychain = false` in the CLI config, or
`SESHI_KEYCHAIN=false`, to use the file directly.

## Uninstalling

Delete the binary (`~/.local/bin/seshi`, `%LOCALAPPDATA%\Programs\seshi`, or
`npm rm -g seshi`) and the `# seshi` line the install script added to your startup file (on
Windows, the folder in your user `PATH`). `seshi logout --all` first removes stored
credentials; the CLI config is in `~/.config/seshi/` (`%APPDATA%\seshi\` on Windows).
