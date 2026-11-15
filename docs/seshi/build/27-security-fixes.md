# 27 — Security fixes from the stack review

A security review of everything from `main` to 26 (twelve reviewers by area, each finding then
checked by two independent skeptics) confirmed 15 weaknesses, 3 more on a split vote, and refuted
4. This branch fixes 13 of them, each with a regression test that fails without the fix.

## Fixed

| # | Weakness | Fix |
|---|---|---|
| 1 | An org-key holder could extend a teammate's claimed session that had no retraction hash, supply their own, then replace or retract it | The hash is set only when the session's pointer is created (`ingest.ts`); a later write never adds one |
| 2 | A committed `.seshi/config.toml` with `visibility = "org"` widened the sessions of members whose token keeps them `owner` | A repo's config may only narrow: the uploader sends a repo's visibility only when it is `owner` |
| 3 | Every JSON route, the unauthenticated `/v1/auth/exchange` included, buffered the whole body before its limit | `Content-Length` past the limit is refused before reading; bodies are read with a capped stream |
| 4 | The labeled-line redaction rule backtracked quadratically (label + 240k tabs: 54 s) | The separator is `[ \t]*(?::[ \t]*)?`; same matches, linear |
| 5 | An OTLP tool-call index like `4294967294` built a 2^32-long array (about 80 s a message) | Flattened calls are collected in a Map and sorted |
| 6 | A repo's `.seshi/config.toml` linked to `/dev/zero` (or a directory) hung the status line, hooks and uploader | Repo and git files are read with `readBounded`: regular files only, non-blocking open, 64 KiB (4 MiB for git's own `config`, which grows with branches and remotes: a real one over 64 KiB turned capture off for its repo, fixed in 29); anything else makes that folder's config invalid (capture off there) |
| 7 | `./seshi.toml` in any folder was loaded by admin, sync, search and config commands, and its secret references could send env vars or files to an attacker's endpoint | Only `seshi serve` reads `./seshi.toml` unasked; other commands print a hint to pass `--config` |
| 8 | Search snippets re-ran the FTS5 match per id (`rowid IN` pushed into FTS5) | `rowid+0 IN (...)`; the query plan is asserted in a test |
| 9 | Gzipped uploads were inflated synchronously up to about 513 MiB | Inflated as a capped stream, as the OTLP route does |
| 11 | The folder store wrote files 0644 and directories 0755 | Directories 0700, objects, temp files and locks 0600 (new ones; existing folders are not chmod'ed) |
| 13 | Subagents were judged without their parent's folders, so content from an excluded repo could upload through a subagent | `otherFolders` adds every ancestor's folders, in every caller of `decide` (the sweep passed none before) |
| 14 | The CLI opened the IdP's authorization URL whatever its scheme (`file://`, `smb://`) | `discover()` requires https (or http on loopback) for every endpoint; `openUrl` opens only http(s) |
| 15 | CI had no least-privilege token, checkouts kept credentials, and actions were on movable tags | Top-level `contents: read`, `persist-credentials: false` everywhere, every action pinned to a commit SHA, the S3 test image and awscli pinned, Dependabot for the pins |

## Changed behaviour

- A session first uploaded without a retraction hash (a script, another client) can never be
  retracted or replaced with the org key later.
- An unsupported `Content-Encoding` now gets 415 before the body is read.
- An OTLP tool-call index at or above 2^32−1 is kept; it used to be dropped silently.
- A dangling symlink at a repo's config or git file now makes that folder's config invalid; it
  used to count as absent. The reason reads "the repo's config cannot be read: …".
- Quickstarts say `seshi config check --config seshi.toml` and `seshi admin init --config
  seshi.toml`. `seshi healthcheck` still reads `./seshi.toml` for `server.listen` only, and never
  resolves secrets.

## Not fixed

- **#10** Listing and change-feed cursors reveal the keys of another owner's private sessions to
  a reader with `sessions:read`. Needs opaque cursors.
- **#12** A `file://` folder source follows symlinks out of the watched folder (a single-machine
  feature; the attacker already needs write access to that folder).
- **Device tokens** (split vote): IdP sign-in mints unlimited device tokens; goes with the rate
  limiting 05 records as open.
- **npm publish** (split vote): `publish-npm` skips a version already on the registry without
  comparing it. Register the `seshi` name and `@seshi` scope before the first release.
- **The release job's own token** keeps `contents: write`, `issues: write`, `pull-requests:
  write` and `id-token: write`, though it seems to use none of them (it pushes and comments with
  the bot's app token). Check on a real release run before cutting it to `contents: read`.

## Still to check

- The CI changes have not run in GitHub Actions.
- The pinned action SHAs were resolved on 15 Nov 2026; Dependabot keeps them current.
