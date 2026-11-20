# Releasing seshi

Releases are automatic: every push to `main` with a Conventional Commit since the last
`vX.Y.Z` tag is one (`release.config.js`, `.github/workflows/ci.yml`). Nothing is released
from any other branch, and nothing is published by hand.

## What a release does

1. **Gates.** The `test`, `test-windows`, `python-client`, `docker`, `binaries` and
   `darwin-cross-check` jobs pass. `binaries` builds `seshi` natively
   on a runner for each of the six targets and runs `scripts/release/smoke.ts` on it: serve on a
   folder store, `admin init`, `login --key` (which stores the org key through `Bun.secrets` in
   the macOS Keychain or Windows Credential Manager, required there; the 0600 file is accepted on
   Linux runners, which have no secret service), `whoami`, an `upload` that the uploader must
   redact with an RE2 rule pack the server serves, `capture install` into a temporary home (every
   hook must name the binary's own path), `logout`. It also times a real `seshi hook` with that
   binary (`check:hook --binary`, 250 ms). It then installs the build
   with `install.sh`, or `install.ps1` under PowerShell 7 and Windows PowerShell 5.1, from a local
   copy of the release. `darwin-cross` builds the two macOS targets on Linux, as the release
   job does, and `darwin-cross-check` runs `codesign --verify` on them on a Mac. Bun's signer
   for macOS binaries has broken before, and its x64 build keeps Bun's own signature, which no
   longer matches, so `scripts/release/build.ts` gives both darwin binaries a fresh ad-hoc
   signature (`scripts/release/macho-sign.ts`, no `codesign` needed) before archiving them.
2. **`release`** runs semantic-release. It picks the version from the commits, writes it into
   `packages/ts/model/package.json`, `bun.lock` and the Python client's
   `packages/py/client/src/seshi/_version.py` (`scripts/release-version.ts`),
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
   (`scripts/release/publish-npm.ts`), in this order: `@dosu/seshi-<target>` for each target,
   `@dosu/seshi-model`, `@dosu/seshi-client`, then the `@dosu/seshi` launcher, so
   `npm i @dosu/seshi` never resolves a
   platform package that is not there yet. A version already on the registry is skipped, so
   the job can be re-run. Prereleases go under the `next` tag.
4. **`image`** downloads the two Linux archives, checks them, and builds
   `ghcr.io/<repo>` for linux/amd64 and linux/arm64 from those binaries
   (`--build-arg BINARY=prebuilt`), tagged `X.Y.Z`, `X.Y` and `latest`.
5. **`pypi`** builds the Python client from the release's tag and publishes it to PyPI as
   `seshi` ([below](#pypi)).
6. **`verify`** installs the published release on all six platforms with `install.sh` or
   `install.ps1` from GitHub, smoke tests it, then `npm i -g @dosu/seshi@X.Y.Z` and
   `npx @dosu/seshi@X.Y.Z --version`. Before installing it waits, for up to 15 minutes, until
   the registry serves X.Y.Z of the launcher and every platform package to `npm install`
   (`scripts/release/wait-npm.ts`): npm can take minutes to serve a new package's first
   versions after `npm publish` returns, and npm skips an optional dependency it cannot find,
   which would install a launcher with no binary.

## Targets

`scripts/release/targets.ts` is the one list: darwin-arm64, darwin-x64, linux-x64, linux-arm64
(glibc), windows-x64 and windows-arm64. x64 builds use Bun's `-baseline` target. The install
scripts and the npm launcher map machines onto the same ids, and tests keep them in step
(`scripts/install/install.test.ts`, `scripts/release/release-config.test.ts`). Adding a
target (musl, say) means a line there, a runner in the `binaries` and `verify` matrices, and
the install script's detection.

## The workflow's own security

`ci.yml` gives every job a read-only `GITHUB_TOKEN`; `release`, `image` (`packages: write`)
`npm` (`id-token: write`, for provenance) and `pypi` (`id-token: write`, for PyPI's trusted
publishing, in the `pypi` environment) grant themselves more. No checkout keeps its
credentials: semantic-release pushes the release commit and tag with the abbs-bot app token
it is handed. Every action is pinned to a commit SHA with its release in a trailing comment
(`uses: owner/action@<sha> # vX.Y.Z`), as are the S3 test service image (by digest) and
awscli. Dependabot (`.github/dependabot.yml`) proposes action updates weekly; to bump one by
hand, resolve the tag with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` (an annotated
tag's object is a tag: follow it through `git/tags/<sha>` to the commit) and update the
comment with the SHA.

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

## PyPI

The Python client (`packages/py/client`) is published as `seshi` by the `pypi` job, after
`release` and beside `npm`: it checks out the release's tag, builds the wheel and sdist with
`uv build` (their version is the one `scripts/release-version.ts` wrote into
`src/seshi/_version.py`) and uploads them with `uv publish`. A file already on PyPI is skipped,
so the job can be re-run. To publish a release that is already cut (one from before the job
existed, or one whose upload failed), run the workflow by hand on `main` with its version:

```sh
gh workflow run ci.yml --ref main -f pypi_version=0.11.0
```

That runs the `pypi` job for tag `v0.11.0`, beside the usual test jobs; no release is cut.

It holds no token. PyPI trusts the workflow through trusted publishing: a publisher for the
project `seshi`, repository `dosu-ai/seshi`, workflow `ci.yml`, environment `pypi`, registered
as a "pending" publisher until the first upload creates the project, and an ordinary one after.
The job proves itself with GitHub's OIDC token (`id-token: write`) in the repository's `pypi`
environment, which only `main` may deploy to. A pending publisher does not reserve the name:
until the first release uploads it, anyone can register `seshi`. If the repository, the
workflow file or the environment is renamed, update the publisher on PyPI (the project's
Publishing page) to match, or the upload is refused.

## Before the first release

- **Names.** Every package is published under the `@dosu` scope (`@dosu/seshi`,
  `@dosu/seshi-<target>`, `@dosu/seshi-model`, `@dosu/seshi-client`): the `@seshi` scope is
  taken on npm. The workspace keeps its `@seshi/*` names, which are never published;
  `scripts/release/npm.ts` renames them, and the libraries' imports of each other, as it builds
  the packages. CI's `NPM_TOKEN` secret must be able to publish new packages to the `@dosu`
  scope. npm trusted publishing is set up per package, so it can replace the token only once
  each package exists.
- **The bare `seshi` name.** The launcher is also published as `seshi`, last, so `npm i -g
  seshi` works: the same manifest and `bin/seshi.js`, depending on the same
  `@dosu/seshi-<target>` packages. It is marked optional in `packages.json`, so if npm refuses
  it (CI's `NPM_TOKEN` limited to `@dosu`, or npm judging the name too close to another),
  `publish-npm` logs why and the release goes on. For it to publish, the token must be allowed
  to publish new packages outside `@dosu` as well. Until `seshi` is out, the docs name
  `@dosu/seshi` only.
- **Repository name.** The repository was `dosu-ai/sessiondb` and is now `dosu-ai/seshi`.
  `REPOSITORY` in `scripts/release/targets.ts` and the two install scripts name it (a test
  keeps them equal); GitHub redirects the old URLs, including sessiondb's release downloads.
  The release job's app token is scoped to the repository by name, which `ci.yml` reads from
  the event, so a rename needs no change there. The image moves with it to
  `ghcr.io/dosu-ai/seshi`; the old `ghcr.io/dosu-ai/sessiondb` keeps sessiondb's tags.
- **The old package.** Give `@dosu/sessiondb` its last release pointing to seshi (X3.8): publish
  one more patch whose README says it moved to `@dosu/seshi` and `@dosu/seshi-client`, then
  `npm deprecate @dosu/sessiondb "moved to seshi: npm i -g @dosu/seshi; the client is @dosu/seshi-client"`.
  This is a one-off, done by hand from the last sessiondb tag.
- **Open VSX** (the Cursor extension). Create an Eclipse account, sign the Open VSX publisher
  agreement, create the `dosu` namespace (`bunx ovsx@1.3.0 create-namespace dosu -p <token>`)
  and claim it, and give CI an `OVSX_PAT` secret. Without it the `openvsx` job publishes
  nothing; the `.vsix` is still attached to each release, for installing by hand ("Install from
  VSIX…"). Cursor installs extensions from Open VSX through its own proxy, which scans new
  versions first, so a release can take a while to appear in Cursor. A verified publisher badge
  needs a homepage on the publisher's own domain that links the listing.
- **Runners.** The matrices use `ubuntu-24.04-arm` and `windows-11-arm`, which GitHub offers
  free to public repositories only, and `macos-15-intel` for Intel macOS.
