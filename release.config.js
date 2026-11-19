/** Every push to main that carries a Conventional Commit is a release (F8.4, X3.8).
 * semantic-release reads the commits since the last `vX.Y.Z` tag and picks the next version;
 * then, in this order:
 *
 * 1. prepare: scripts/release-version.ts writes it into packages/ts/model/package.json (the
 *    repository's one version: what traces record as their normalizer, what /healthz and
 *    `seshi --version` report), bun.lock and the Python client's `__version__`; scripts/release/build.ts cross-compiles `seshi`
 *    for every target (scripts/release/targets.ts) into dist/release/: one archive per target,
 *    install.sh, install.ps1, the Cursor extension's .vsix and SHA256SUMS. @semantic-release/git commits the version files.
 * 2. The tag `vX.Y.Z` is pushed, and the GitHub release is published with those assets. The
 *    install scripts download from it, and `…/releases/latest/download/install.sh` is a stable
 *    URL.
 * 3. ci.yml's later jobs take it from there, from the release's own assets: `npm` publishes
 *    the platform packages, @dosu/seshi-model, @dosu/seshi-client and the @dosu/seshi launcher; `image`
 *    builds ghcr.io/<repo> from the two Linux binaries; `pypi` publishes the Python client;
 *    `openvsx` publishes the Cursor extension; `verify` installs the release on every platform
 *    through each channel.
 *
 * @type {import('semantic-release').GlobalConfig} */
export default {
  branches: ["main"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    [
      "@semantic-release/exec",
      {
        prepareCmd:
          "bun run scripts/release-version.ts ${nextRelease.version} && bun run scripts/release/build.ts --version ${nextRelease.version} --out dist/release",
        successCmd:
          "echo 'released=true' >> $GITHUB_OUTPUT && echo 'version=${nextRelease.version}' >> $GITHUB_OUTPUT",
      },
    ],
    [
      "@semantic-release/github",
      {
        assets: [
          { path: "dist/release/seshi-*.tar.gz" },
          { path: "dist/release/seshi-*.zip" },
          { path: "dist/release/install.sh" },
          { path: "dist/release/install.ps1" },
          { path: "dist/release/seshi-cursor-*.vsix" },
          { path: "dist/release/SHA256SUMS" },
        ],
      },
    ],
    [
      "@semantic-release/git",
      {
        assets: [
          "packages/ts/model/package.json",
          "integrations/cursor/extension/package.json",
          "packages/py/client/src/seshi/_version.py",
          "bun.lock",
          "CHANGELOG.md",
        ],
        message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
  ],
};
