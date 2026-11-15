/** Every push to main that carries a Conventional Commit is a release: semantic-release reads
 * the commits since the last `vX.Y.Z` tag, picks the next version, writes it into
 * packages/ts/model/package.json (the repository's one version: what traces record as their
 * normalizer, what /healthz and `seshi --version` report) and bun.lock, and cuts the tag and a
 * GitHub release; the `image` job in ci.yml then builds ghcr.io/dosu-ai/sessiondb at the same
 * version.
 *
 * Nothing is published to npm: the packages are private workspaces since the seshi restructure
 * (X3.4). Branch 15 rewrites this to publish the seshi binary and @seshi/client (X3.8).
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
        // Write the version into the model's package.json and bun.lock. (@semantic-release/git
        // commits those files below.)
        prepareCmd: "bun run scripts/release-version.ts ${nextRelease.version}",
        successCmd:
          "echo 'released=true' >> $GITHUB_OUTPUT && echo 'version=${nextRelease.version}' >> $GITHUB_OUTPUT",
      },
    ],
    "@semantic-release/github",
    [
      "@semantic-release/git",
      {
        assets: ["packages/ts/model/package.json", "bun.lock", "CHANGELOG.md"],
        message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
  ],
};
