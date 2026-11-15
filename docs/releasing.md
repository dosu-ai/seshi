# Releasing seshi

Releases are automatic: every push to `main` with a Conventional Commit since the last
`vX.Y.Z` tag is one (`release.config.js`, `.github/workflows/ci.yml`). Nothing is released
from any other branch, and nothing is published by hand.

## What a release does

1. **Gates.** The `test`, `docker`, `binaries` and `darwin-cross-check` jobs pass. `binaries` builds `seshi` natively
   on a runner for each of the six targets and runs `scripts/release/smoke.ts` on it: serve on a
   folder store, `admin init`, `login --key` (which stores the org key through `Bun.secrets` in
   the macOS Keychain or Windows Credential Manager, required there; the 0600 file is accepted on
   Linux runners, which have no secret service), `whoami`, an `upload` that the uploader must
   redact with an RE2 rule pack the server serves, `capture install` into a temporary home (every
   hook must name the binary's own path), `logout`. It also times a real `seshi hook` with that
   binary (`check:hook --binary`, 250 ms). It then installs the build
   with `install.sh`, or `install.ps1` under PowerShell 7 and Windows PowerShell 5.1, from a local
   copy of the release. `darwin-cross` builds the two macOS targets on Linux, as the release
   job does, and `darwin-cross-check` runs `codesign --verify` on them on a Mac (Bun's signer
   for cross-compiled macOS binaries has broken before, and macOS kills such a binary at launch).
2. **`release`** runs semantic-release. It picks the version from the commits, writes it into
   `packages/ts/model/package.json` and `bun.lock` (`scripts/release-version.ts`),
   cross-compiles every target with `scripts/release/build.ts` into `dist/release/`, commits the
   version, pushes the tag, and publishes the GitHub release with these assets:

   | Asset | |
   |---|---|
   | `seshi-<os>-<cpu>.tar.gz` | macOS and Linux: `seshi` and `LICENSE` |
   | `seshi-windows-<cpu>.zip` | Windows: `seshi.exe` and `LICENSE` |
   | `install.sh`, `install.ps1` | The install scripts (stable at `…/releases/latest/download/`) |
   | `SHA256SUMS` | `sha256sum` format, over every asset above |

3. **`npm`** downloads that release's archives, checks them against `SHA256SUMS`, builds the npm
   packages from them (`scripts/release/npm.ts`) and publishes them with provenance
   (`scripts/release/publish-npm.ts`), in this order: `@seshi/cli-<target>` for each target,
   `@seshi/model`, `@seshi/client`, then the `seshi` launcher, so `npm i seshi` never resolves a
   platform package that is not there yet. A version already on the registry is skipped, so
   the job can be re-run. Prereleases go under the `next` tag.
4. **`image`** downloads the two Linux archives, checks them, and builds
   `ghcr.io/<repo>` for linux/amd64 and linux/arm64 from those binaries
   (`--build-arg BINARY=prebuilt`), tagged `X.Y.Z`, `X.Y` and `latest`.
5. **`verify`** installs the published release on all six platforms with `install.sh` or
   `install.ps1` from GitHub, smoke tests it, then `npm i -g seshi@X.Y.Z` and
   `npx seshi@X.Y.Z --version`.

## Targets

`scripts/release/targets.ts` is the one list: darwin-arm64, darwin-x64, linux-x64, linux-arm64
(glibc), windows-x64 and windows-arm64. x64 builds use Bun's `-baseline` target. The install
scripts and the npm launcher map machines onto the same ids, and tests keep them in step
(`scripts/install/install.test.ts`, `scripts/release/release-config.test.ts`). Adding a
target (musl, say) means a line there, a runner in the `binaries` and `verify` matrices, and
the install script's detection.

## Trying it locally

```sh
bun run release:build --target host            # dist/release/: this machine's archive, scripts, SHA256SUMS
bun run release:build                          # every target (downloads each target's Bun runtime)
bun run release:smoke dist/release/bin/darwin-arm64/seshi --keychain off
bun run release:npm --version "$(jq -r .version packages/ts/model/package.json)"   # dist/npm/
bun run release:publish-npm --dry-run
```

`--keychain off` keeps the smoke test away from your real keychain. To try an install script,
serve a release folder laid out as GitHub's (`latest/download/<asset>`):

```sh
bun run release:build --target host --out /tmp/site/latest/download
sh scripts/install/install.sh --base-url file:///tmp/site --dir /tmp/seshi-bin --no-modify-path
bun run scripts/release/serve-dir.ts /tmp/site 8765   # for install.ps1: -BaseUrl http://127.0.0.1:8765
```

`bun run test` covers all of this without the network: archives, checksums, every install
script path against file:// and local HTTP fixtures, the npm packages installed into a
temporary `node_modules` and run with Node, the libraries imported and type-checked, and the
host's real binary built, installed and smoke tested.

## Before the first release

- **Names.** Register the `seshi` package and the `@seshi` scope on npm (X3.8), and give CI an
  `NPM_TOKEN` secret that can publish both, or set up npm trusted publishing for this
  workflow and drop the token.
- **Repository name.** `REPOSITORY` in `scripts/release/targets.ts` and the two install scripts
  name `dosu-ai/sessiondb`; if the repository is renamed (X3.8's open question), change all
  three (a test keeps them equal). GitHub redirects old release URLs after a rename.
- **The old package.** Give `@dosu/sessiondb` its last release pointing to seshi (X3.8): publish
  one more patch whose README says it moved to `seshi` and `@seshi/client`, then
  `npm deprecate @dosu/sessiondb "moved to seshi: npm i -g seshi; the client is @seshi/client"`.
  This is a one-off, done by hand from the last sessiondb tag.
- **Runners.** The matrices use `ubuntu-24.04-arm` and `windows-11-arm`, which GitHub offers
  free to public repositories only, and `macos-15-intel` for Intel macOS.
