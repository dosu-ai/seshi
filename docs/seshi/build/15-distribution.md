# 15 · Distribution (F8.4, X3.8)

Branch `seshi-15-distribution`, on `seshi-13-cli`. A release now ships the one `seshi` binary
(X2.2) through three channels, all with the same compiled files: GitHub release archives with
`SHA256SUMS`, npm (`seshi` with per-platform `@seshi/cli-*` packages, plus the `@seshi/model`
and `@seshi/client` libraries), and install scripts for macOS/Linux (`install.sh`) and Windows
(`install.ps1`). The release image is built from the release's own Linux binaries. User docs:
[docs/install.md](../../install.md), [docs/releasing.md](../../releasing.md).

## What was built

- **Targets** (`scripts/release/targets.ts`): darwin-arm64, darwin-x64, linux-x64, linux-arm64
  (glibc), windows-x64, windows-arm64. Each has its Bun target (x64 uses `-baseline`), its
  archive name (`seshi-<id>.tar.gz`, `.zip` on Windows), its npm package (`@seshi/cli-<id>`) and
  Node's platform name. `REPOSITORY` (`dosu-ai/sessiondb`), `CHECKSUMS` (`SHA256SUMS`) and
  `INSTALL_SCRIPTS` live here too.
- **Archives** (`archive.ts`): a ustar `.tar.gz` writer and a deflate `.zip` writer, plus readers
  for both, with no dependency on the build machine's `tar` or `zip`. Output is deterministic for
  the same entries and time. Unix modes are kept (the binary is 0755, in the zip's external
  attributes too). `checksumFile`/`parseChecksums` read and write `sha256sum`'s format. The tests
  unpack with the system `tar` and `unzip -t` and check with `shasum -c`.
- **Release build** (`build.ts`, `bun run release:build [--target id|host]… [--version] [--out]`):
  compiles each target with `buildCommand` from `scripts/build-binary.ts` (same flags as `bun run
  build`, including the no-autoload ones), archives the binary with `LICENSE`, reads every
  archive back and compares the binary, runs the host's binary (`seshi <version>` or it fails),
  copies the install scripts, and writes `SHA256SUMS` over every asset. `--version` must equal
  `@seshi/model`'s package.json, since the binary embeds it.
- **npm packages** (`npm.ts`, `bun run release:npm --version X [--from] [--out]`), built from the
  release's archives after checking them against `SHA256SUMS`:
  - `@seshi/cli-<id>`: `bin/seshi[.exe]` (0755), `os`, `cpu`, `libc: ["glibc"]` on Linux,
    `preferUnplugged`, no `bin` field.
  - `seshi`: `bin/seshi.js`, the launcher (`launcher.ts` bundled to CommonJS for Node 18+),
    with every platform package as an optional dependency at the exact version.
  - `@seshi/model`, `@seshi/client`: an ESM bundle of the workspace sources (`packages:
    "external"`) plus tsc declarations; the client's declarations point at the built model's.
    Workspace dependencies become the exact release version (only published ones are allowed);
    others keep their range. Building them needs the repository at the release's version.
  - `packages.json` lists the publish order: platform packages, libraries, launcher last.
- **Launcher** (`launcher.ts`): picks the target from `process.platform`/`arch` and, on Linux, the
  libc from Node's report. It resolves `<pkg>/package.json` with the bundle's own CommonJS
  `require.resolve`, restores a dropped executable bit, and spawns the binary with
  `stdio: "inherit"`. A signal sent to the launcher alone is forwarded; when the binary dies of a
  signal, the launcher re-raises it, otherwise it exits with the binary's code. Each failure (no
  binary for this platform, musl, the optional package skipped) prints what to do.
- **Publishing** (`publish-npm.ts`, `bun run release:publish-npm [--provenance] [--dry-run]`):
  follows `packages.json`. It skips a version the registry already has (only E404 counts as
  absent, so an outage is an error, never "not published"), refuses a private package or a
  folder holding another name, publishes with `--access public`, and uses `--tag next` for a
  prerelease.
- **install.sh** (`scripts/install/`): POSIX sh, tested under `sh` and `dash`.
  - Options are flags only: `--version`, `--dir`, `--no-modify-path`, `--base-url`.
  - It detects OS and CPU, uses arm64 under Rosetta, refuses musl, 32-bit ARM userlands,
    Windows shells and unknown systems.
  - It downloads the archive and `SHA256SUMS` with curl (https only for https URLs) or wget,
    then checks the hash with sha256sum, shasum or openssl. A mismatch installs nothing.
  - It installs atomically (copy beside the target, then rename) into `$XDG_BIN_HOME` or
    `~/.local/bin`, and runs `--version`.
  - When the folder is not on `PATH`, it adds one line to the shell's startup file: zsh, bash
    (`.bash_profile` on macOS), fish (`fish_add_path`), else `.profile`. It never adds the line
    twice, and refuses folder names with shell metacharacters.
- **install.ps1**: works in PowerShell 5.1 and 7.
  - Parameters: `-Version`, `-InstallDir`, `-NoModifyPath`, `-BaseUrl`.
  - It turns on TLS 1.2 in 5.1, maps AMD64/ARM64 (also from 32-bit PowerShell), checks
    `SHA256SUMS` with `Get-FileHash`, and unpacks with `Expand-Archive`.
  - It installs to `%LOCALAPPDATA%\Programs\seshi`, renaming a running `seshi.exe` aside first.
  - It adds the folder to the user `PATH` through the registry as `REG_EXPAND_SZ`, so
    `%USERPROFILE%` entries survive, broadcasts the change, and updates the current session.
  - It throws rather than calling `exit`, so `irm | iex` never closes the user's window.
- **Smoke test** (`smoke.ts`, `bun run release:smoke <binary> [--keychain required|allowed|off]`):
  1. `--version`.
  2. `admin init` and `serve` on a temporary folder store on 127.0.0.1.
  3. `login --key -` with the org key, then a check of where it was stored.
  4. `whoami` reads it back; `logout`; `whoami` must then fail.

  Its environment carries none of the caller's `SESHI_*` settings or credentials, and the CLI
  config goes to a temporary folder. `required` is for macOS and Windows, `allowed` for Linux
  runners without a secret service. `off` sets `SESHI_KEYCHAIN=false` and is what the tests use.
- **`serve-dir.ts`**: a static server for 127.0.0.1, used by CI for install.ps1 (PowerShell 7
  cannot read file:// URLs) and by the tests. It refuses paths outside its folder.
- **CLI setting `keychain`** (`packages/ts/config/src/cli.ts`, `SESHI_KEYCHAIN`, default true):
  `false` makes `openAccount` use `FileSecrets` alone. `spec/cli-config.schema.json` and
  docs/config.md are updated.
- **Release config** (`release.config.js`): in prepare, `release-version.ts`, then
  `release/build.ts --version … --out dist/release` for every target. `@semantic-release/github`
  uploads the archives, both install scripts and `SHA256SUMS`; `@semantic-release/git` commits
  the version files only.
- **CI** (`.github/workflows/ci.yml`):
  - `binaries` (PRs and main): one native runner per target. It builds the host's release
    assets, smoke tests them (keychain required on macOS and Windows), then installs with
    install.sh, or with install.ps1 under both PowerShell 7 and 5.1 from `serve-dir`.
    `release` now needs it.
  - `npm` (after a release): downloads the release's archives, builds the packages and publishes
    them with provenance (`NPM_TOKEN`, `id-token: write`).
  - `image`: downloads and checks the two Linux archives, unpacks them to
    `dist/docker/linux-<arch>/`, and builds with `BINARY=prebuilt`.
  - `verify` (after `npm`): on all six platforms, installs the published release from GitHub
    with install.sh or install.ps1, smoke tests it, then `npm i -g seshi@X` and
    `npx seshi@X --version`.
- **Dockerfile**: `ARG BINARY=build` chooses the stage the binary comes from: `build` (compile
  here, as before) or `prebuilt` (`dist/docker/linux-$TARGETARCH/seshi`). `.dockerignore` lets
  `dist/docker` through. Both paths were built and run locally (`--version`).
- **Root scripts**: `release:build`, `release:npm`, `release:publish-npm`, `release:smoke`.
- **Tests** (92 new, 1007 passing in all; about 9 s of the run): archive formats against the system tools; the build with a
  stand-in compiler for all six targets; manifests; `buildNpm`'s checks; the launcher in a
  temporary `node_modules` run by Node (arguments, stdin, exit code, signal, a lost exec bit, a
  missing platform package); the libraries imported under Node and type-checked with
  `NodeNext`; publish order, skipping and refusals with a stand-in npm; install.sh (28 cases
  over file:// and local HTTP, with stand-in `uname`/`sysctl`/`ldd`); the install scripts'
  names against `targets.ts`; release.config.js and ci.yml against the scripts. Then the
  real host build is installed by install.sh from a local server, run through the npm
  launcher, and put through the smoke test. Nothing touches the network or the real keychain.

## Extension points

- **A new target** (musl, say): a `target(...)` line in `targets.ts`, a runner in the `binaries`
  and `verify` matrices, and detection in install.sh (and in the launcher's `chooseTarget` if
  it needs more than platform/arch/libc). The tests in `install.test.ts` and
  `release-config.test.ts` fail until the scripts and CI agree with the list.
- **A new published library**: an entry in `LIBRARIES` (`npm.ts`) in dependency order. Its
  workspace dependencies must be published libraries too.
- **A new asset**: write it in `buildRelease` (it lands in `SHA256SUMS`), and add its glob to
  `@semantic-release/github`'s assets; `release-config.test.ts` checks both directions.
- **Renaming the repository** (X3.8): `REPOSITORY` in `targets.ts`, and the same constant in
  both install scripts; a test keeps all three equal.
- **Running the binary in a test**: `smoke()` with `keychain: "off"`, and `standInCompile` /
  `installPackages` / `exec` from `scripts/release/testing.ts`.

## Deviations and why

1. **Windows arm64 is built.** F8.4 adds it "if Bun's compiler supports it"; `bun-windows-arm64`
   exists and cross-compiles (checked locally, a PE32+ Aarch64 binary).
2. **No musl builds.** F8.4 lists the six targets without musl. The Linux packages say
   `libc: ["glibc"]`, so npm skips them on musl. There, the launcher and install.sh both refuse
   with a message pointing at glibc images or the Docker image. Adding musl is one target line
   (Bun has `bun-linux-*-musl`).
3. **x64 builds use `-baseline`.** They run on CPUs without AVX2 and under Rosetta 2, which has no
   AVX. Bun 1.4 ships one x64 runtime for both names; the suffix protects older Bun versions.
4. **The install scripts take flags, not `SESHI_*` variables.** The config loader refuses unknown
   `SESHI_*` names (02), so an exported `SESHI_INSTALL_DIR` would break every seshi command. The
   PATH-change broadcast in install.ps1 uses the name `SeshiInstallerRefresh` for the same
   reason.
5. **New CLI setting `keychain`** (not in F8.2). The smoke test must run the compiled binary
   without touching the real keychain (the tests rule out using it), and 13 left headless
   machines whose keychain hangs rather than refuses as an open item. This is the escape hatch.
6. **Asset names carry no version** (`seshi-linux-x64.tar.gz`), so
   `…/releases/latest/download/<asset>` is stable for the install scripts. The tag gives the
   version.
7. **The install scripts are release assets too**, and are covered by `SHA256SUMS`, giving a
   stable `latest/download/install.sh` URL.
8. **npm packages are built and published in a CI job after the release, not by
   semantic-release.** They are built from the release's own archives, so npm ships the very
   bytes GitHub does ("the other two channels download from here"). The job can be re-run on its
   own, since published versions are skipped. `@semantic-release/npm` is not used.
9. **The release image uses the release's binaries** (`BINARY=prebuilt`) instead of compiling
   again: X2.2's "image built from it". PRs' docker job still compiles in the image.
10. **`@seshi/model` and `@seshi/client` are published as built copies** (bundled ESM and
    declarations, `engines.node >= 20`). The workspaces stay private and source-only (X3.4).
11. **The npm launcher is a Node shim with no `postinstall`.** Install scripts are often turned
    off (`--ignore-scripts`, pnpm), and a postinstall that swaps the shim for the binary breaks
    npm's Windows `.cmd` shims. The cost is one Node start for interactive commands. Hooks must
    call the binary directly (see the 14 wiring below).
12. **Install folders**: `~/.local/bin` (`$XDG_BIN_HOME`) on macOS and Linux, beside the
    XDG-style config and state folders F9.1 uses, and often already on `PATH`.
    `%LOCALAPPDATA%\Programs\seshi` on Windows, the per-user programs folder, kept apart from
    the capture state in `%LOCALAPPDATA%\seshi`.
13. **`@dosu/sessiondb`'s last release is a documented manual step** (docs/releasing.md), not
    automation. It is a one-off from the last sessiondb tag, and that package's sources are
    gone from `main`.
14. **"Windows in the CI test matrix" means Windows binaries, smoke tested, and both
    PowerShells running install.ps1.** The full `bun run test` on Windows is not added: the
    suite has never run there (shell-script fixtures, POSIX paths, file modes), and a red job no
    one can fix here would block every PR.

## Still to check

- **CI has not run** (no PR). That covers every new job and the runner labels
  `ubuntu-24.04-arm`, `windows-11-arm` (free for public repositories only) and `macos-15-intel`.
- **Bun.secrets in the compiled binary** (13's open item), which the `binaries` job is there to
  answer:
  - macOS and Windows runners must store the org key in the keychain (`--keychain required`).
    If the macOS runner's login keychain is locked, that step fails and needs a
    `security unlock-keychain` step, or `allowed`.
  - Linux runners should fall back to the file. If Bun.secrets hangs there instead of throwing,
    the smoke test's per-command timeout (60 s) shows it.
  - Windows Credential Manager's size limit with a real Entra refresh token remains unchecked.
- **install.ps1 has never run**: there is no `pwsh` here. Its parse test runs only where `pwsh`
  exists. CI runs it under PowerShell 7 and 5.1 (binaries job) and against the real release
  (verify job).
- **The smoke test on Windows** builds a `file:///C:/…` store URL with `pathToFileURL`. Whether
  the store accepts drive-letter URLs is first exercised in that job.
- **Rosetta**: the darwin-x64 binary cross-compiled with the local Bun 1.3.11 printed Bun's "CPU
  lacks AVX support" warning under Rosetta, then ran. CI uses Bun 1.4.2 (`.bun-version`), whose
  single x64 runtime should not warn. Check on the first release.
- **Binary sizes** (Bun 1.3.11): 65 to 120 MB uncompressed, 24 to 44 MB as archives. Fine for
  now; X2.2's revisit clause covers it.
- **Names and secrets**: register `seshi` and `@seshi` on npm and add `NPM_TOKEN`, or set up
  trusted publishing. `--provenance` needs a public repository.
- **Unsigned binaries**: Gatekeeper does not quarantine curl downloads, and SmartScreen may warn
  on `seshi.exe` downloaded through a browser. Signing is "later" in F8.4.
- **Bytecode**: `--bytecode` with cross-compilation worked locally for every target. Only the
  host's binary was run.

## Cross-branch wiring once the stack is linear

- **14 (capture)**:
  - Hook and status-line commands written by `seshi capture install` should name the binary's
    own path (`process.execPath` in the compiled binary), not `seshi`. Otherwise an npm install
    starts Node on every agent turn through the launcher. docs/install.md already says hooks
    do not start Node; make it true.
  - The uploader's credentials must honour the new `keychain` setting: build the secret store
    through `openAccount` (or the same `keychain ? defaultSecrets : FileSecrets` choice), not
    `defaultSecrets` directly.
  - `CliConfig` now has a required `keychain: boolean`. Object literals of that type (in tests)
    need `keychain: true`, as `tests/cli/sessions.test.ts` here.
- **07 (redaction)**: if RE2 comes as WebAssembly or a native module, it must embed in the
  compiled binary for all six targets. The `binaries` job runs each target's binary, but the
  smoke test only redacts if a session is uploaded; add an upload to `smoke.ts` once redaction
  is in.
- **Any branch adding a dependency to `@seshi/model` or `@seshi/client`**: the published
  libraries pick it up from the workspace package.json. A workspace dependency other than a
  published library makes `buildNpm` refuse; X3.2 keeps the client on the model alone.
- **16 (README, brand)**: README gained a short Install section here; keep its commands. The
  npm package READMEs are generated in `npm.ts` (`readme()`). B1.5's face-free glyph for npm
  pages goes there.
- **13's `check:brand` in CI**: already covered, since CI runs `bun run check`, which includes
  it. Nothing extra was needed.
- **Shared files touched**, all additively:
  - root `package.json`: four `release:*` scripts; the `check` line is unchanged;
  - `packages/ts/config/src/cli.ts`: one field; `spec/cli-config.schema.json` regenerated;
  - `apps/seshi/src/account/account.ts`: one expression;
  - `docs/config.md`, `docs/cli.md`, `docs/server.md`, `README.md`, `CONTRIBUTING.md`: a few
    lines each;
  - `.github/workflows/ci.yml`: new jobs, and `release.needs`;
  - `apps/seshi/Dockerfile`, `.dockerignore`.
