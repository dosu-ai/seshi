# Redaction

Secrets in a transcript never reach the store. The uploader pre-redacts on the laptop and the
pipeline redacts again with the rule packs, so stored records show `[redacted:<rule>]` where a
secret was. `seshi redact test` shows what each rule takes out of a file before anything is
uploaded.

## Sub-features

- `red-store`: planted credentials are absent from every stored and exported copy.
- `red-markers`: each removal is replaced by a `[redacted:<rule>]` marker naming the rule.
- `red-test`: `seshi redact test <file>` reports the rules that matched, without uploading.
- `red-residue`: `seshi doctor`'s residue check finds no rule match in the stored session.

## How to get to it (user POV)

- Use an agent normally; redaction happens on upload.
- Run `seshi redact test <file> --agent claude-code --print` to preview it.
- Run `seshi doctor --session <id>` to check a stored session.

## Driving it with control-seshi

Preconditions:

- A ready run, with no session `red-1` yet.

- **Upload with secrets.** Run `$C agent claude-code red-1 --turns 4 --secret`. The daemon
  output has `"uploaded": 1`.
- **Absent from the store.** Run `$C cli --name export -- sessions export claude-code red-1
  --format seshi`, then
  `grep -c 'AKIAIOSFODNN7EXAMPLE\|hunter2secretvalue42\|ghp_abcdefghij' .verify/seshi/$VERIFY_SESHI_RUN/*-export.out`.
  The count is `0`.
- **Markers present.** In the same export,
  `grep -o '\[redacted:[a-z-]*\]' .verify/seshi/$VERIFY_SESHI_RUN/*-export.out | sort | uniq -c`
  shows `aws-access-key`, `credential` and `github-token`.
- **Absent from the bucket files.** Run `grep -rl --include='*.json*' AKIAIOSFODNN7EXAMPLE
  "$TMPDIR/seshi-verify/$VERIFY_SESHI_RUN/bucket"`. It prints nothing. Traces are gzipped, so
  also run `find "$TMPDIR/seshi-verify/$VERIFY_SESHI_RUN/bucket" -name 'trace.*.json.gz' -exec
  gzip -dc {} + | grep -c AKIAIOSFODNN7EXAMPLE`, which prints `0`.
- **Preview.** Run `$C cli --name rtest -- redact test
  "$TMPDIR/seshi-verify/$VERIFY_SESHI_RUN/home/.claude/projects/-verify-app/red-1.jsonl" --agent
  claude-code --json`. Exit 0, and the counts name `aws-access-key`, `credential` and
  `github-token`.
- **Proof.** Run `$C cli --name doctor-red -- doctor --session red-1 --agent claude-code`. The
  Redaction residue check is `ok`.

## Gotchas

- Only fake credentials: use `--secret`'s known values. Never put a real key in a run.
- A check that greps only the `.out` of `sessions show` is not enough. Export the trace, and look
  in the bucket's gzipped trace objects too.
- `redact test` uses this machine's rules. In server mode the server's `[redaction]` config can
  add packs; residue in `doctor` compares against the local rules and says so.
