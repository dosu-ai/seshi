# Capture and upload

An agent session is captured as the agent writes it. A hook spools the agent's events, the
uploader sends the transcript (first whole, then only the new lines as continuation chunks), and
the store holds one session with its records. It works the same in local mode (the CLI writes
the bucket) and server mode (`seshi serve` stores it).

## Sub-features

- `cap-first`: the first upload of a session stores it whole.
- `cap-chunk`: later turns go as a continuation chunk at the server's offset; the record count grows.
- `cap-filter`: a session below the filter's size is not stored yet (`too small yet`).
- `cap-server`: the same through `seshi serve`, signed in with the org key.
- `cap-upload`: `seshi upload` sends sessions the hooks missed (backfill).

## How to get to it (user POV)

- Use a coding agent with capture installed: its hooks fire on SessionStart and Stop.
- Run `seshi upload --since 7d` to backfill sessions the hooks missed.
- Watch it with `seshi capture status --session <id>` and `seshi sessions ls`.

## Driving it with control-seshi

Preconditions:

- A ready run (`$C doctor` says `ready`). Do every step once in local mode, then again in a
  `--server` run for `cap-server`.
- No session `cap-1` or `cap-small` in the run.

- **First upload.** Simulate four turns. Run `$C agent claude-code cap-1 --turns 4`. The daemon
  output (`NN-daemon-cap-1.out`) has `"uploaded": 1` and `"failed": 0`.
- **Stored.** List sessions. Run `$C cli --name ls -- sessions ls`. One line reads
  `claude-code/cap-1` with 21 records. That's 4 turns of 5 records each, plus the session's
  meta record.
- **Continuation chunk.** Simulate two more turns. Run `$C agent claude-code cap-1 --turns 2`.
  The daemon output has `"uploaded": 1`. Then `$C cli --name ls2 -- sessions ls` shows 31
  records (21 + 2 × 5), still one session.
- **Server view.** Run `$C cli --name show -- sessions show claude-code cap-1 --json`. Exit 0.
  The JSON's `normalized.bytes` equals the transcript's size in bytes (`wc -c` of the run's
  `home/.claude/projects/-verify-app/cap-1.jsonl`), and `traces` has two entries, the second
  with a `continuation`.
- **Too small.** Simulate one short turn. Run `$C agent claude-code cap-small --turns 1`. The
  daemon output still has `"uploaded": 1` (the server answered, and the answer was that the
  session is too small). Then `$C cli --name ls3 -- sessions ls` does not list `cap-small`, and
  `$C cli --name status -- capture status --session cap-small --agent claude-code` says
  `too small yet`.
- **Backfill.** Write a transcript without firing hooks: run `bun
  .claude/skills/verify-seshi/scripts/transcript.ts "$TMPDIR/seshi-verify/$VERIFY_SESHI_RUN/home/.claude/projects/-verify-app/cap-bf.jsonl"
  cap-bf "$TMPDIR/seshi-verify/$VERIFY_SESHI_RUN/app" --turns 4`. Then run
  `$C cli --name upload -- upload --since 1d`. Its output has the line
  `uploaded claude-code:cap-bf` (and `too small yet claude-code:cap-small`), and `sessions ls`
  lists `cap-bf` with 21 records.
- **Proof.** Run `$C cli --name doctor -- doctor --session cap-1 --agent claude-code`. Exit 0,
  with every check `ok`; the Trace chain line reads `2 traces hold records 0–30 of 31`.

## Gotchas

- A too-small session counts as uploaded in the daemon's summary even though nothing is stored.
  Assert storage with `sessions ls`, not with the daemon's counts. Seed at least four turns for a
  session you expect stored.
- The transcript must live under the run's `~/.claude/projects/`, or the uploader refuses it as
  not the session's transcript (the doctor's Transcript check says so).
- `SESHI_NO_UPLOADER=1` is set in the run, so nothing uploads until a `daemon --once` (which
  `agent` runs) or `seshi upload`.
- In server mode the owner is `verifier` (a claimed username with the org key). In local mode
  it's your OS username (`verifier` when `USER` is unset).
