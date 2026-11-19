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
5. **`verify`** installs the published release on all six platforms with `install.sh` or
   `install.ps1` from GitHub, smoke tests it, then `npm i -g @dosu/seshi@X.Y.Z` and
   `npx @dosu/seshi@X.Y.Z --version`.

## Targets

`scripts/release/targets.ts` is the one list: darwin-arm64, darwin-x64, linux-x64, linux-arm64
(glibc), windows-x64 and windows-arm64. x64 builds use Bun's `-baseline` target. The install
scripts and the npm launcher map machines onto the same ids, and tests keep them in step
(`scripts/install/install.test.ts`, `scripts/release/release-config.test.ts`). Adding a
target (musl, say) means a line there, a runner in the `binaries` and `verify` matrices, and
the install script's detection.

## The workflow's own security

`ci.yml` gives every job a read-only `GITHUB_TOKEN`; `release`, `image` (`packages: write`)
and `npm` (`id-token: write`, for provenance) grant themselves more. No checkout keeps its
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

The Python client (`packages/py/client`) is versioned with every release but not published yet.
The name `seshi` was free on PyPI when the client was added (unlike npm's); register it with the
first upload, or with a pending trusted publisher (below), before someone else takes it. To
publish it from the release, as the `npm` job publishes the npm packages:

1. **A trusted publisher.** On PyPI, add a pending publisher for the project `seshi`: owner
   `dosu-ai`, repository `seshi`, workflow `ci.yml`,
   environment `pypi`. No token is stored anywhere: the job proves itself with GitHub's OIDC
   token, which needs `id-token: write`.
2. **A `pypi` environment** in the repository's settings, limited to `main`, so only the
   release run can use the publisher.
3. **A `pypi` job** in `ci.yml`, after `release` and on the same condition as `npm`:
   `permissions: {contents: read, id-token: write}`, `environment: pypi`, a checkout of
   `v<version>`, `astral-sh/setup-uv` (pinned like every action), then
   `uv build --project packages/py/client --out-dir dist/py` and
   `uv publish --trusted-publishing always dist/py/*` (or `pypa/gh-action-pypi-publish`, which
   also attests the files). A version already on PyPI is refused, so a re-run should skip it
   (`uv publish --check-url https://pypi.org/simple/`).
4. **`verify`** can then `pip install seshi==<version>` and import it.

`scripts/release-version.ts` already writes the version, and `tests/test_version.py` keeps it
equal to `packages/ts/model/package.json`'s, so the published wheel's version is the release's.

## Before the first release

- **Names.** Every package is published under the `@dosu` scope (`@dosu/seshi`,
  `@dosu/seshi-<target>`, `@dosu/seshi-model`, `@dosu/seshi-client`): the `seshi` name and
  the `@seshi` scope are taken on npm. The workspace keeps its `@seshi/*` names, which are
  never published; `scripts/release/npm.ts` renames them, and the libraries' imports of each
  other, as it builds the packages. CI's `NPM_TOKEN` secret must be able to publish new
  packages to the `@dosu` scope. npm trusted publishing is set up per package, so it can
  replace the token only once each package exists.
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
