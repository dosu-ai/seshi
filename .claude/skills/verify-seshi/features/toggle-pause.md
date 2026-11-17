# Turn capture off, on or pause it

A person controls capture per session and for everything at once. Turning a session off stops
its uploads and retracts what was already stored. Turning it back on uploads all of it again as a
new session. A pause stops every session running at that moment where it is, and keeps sessions
started during the pause off. Resume doesn't restart stopped sessions; only `capture on
--session` does.

## Sub-features

- `tog-off`: `capture off --session` stops uploads and retracts the stored session.
- `tog-on`: `capture on --session` uploads the session again from its start, under a new id.
- `tog-pause`: `capture pause` stops a running session at the point reached so far.
- `tog-resume`: `capture resume` lets new sessions capture; stopped ones stay stopped.
- `tog-status`: `seshi statusline --json` and `capture status` say which applies and why.

## How to get to it (user POV)

- Run `seshi capture off|on --session <id>` (or `/session-capture off` in Claude Code, or click the
  desktop chip).
- Run `seshi capture pause 2h`, then `seshi capture resume`.
- Read `seshi capture status --session <id>`, or the status line.

## Driving it with control-seshi

Preconditions:

- A ready run with no pause in force (`$C cli -- capture status` shows no pause).
- Session `tog-1` stored: run `$C agent claude-code tog-1 --turns 4` and confirm `sessions ls`
  lists it.

- **Turn off.** Run `$C cli --name off -- capture off --session tog-1 --agent claude-code --json`.
  Exit 0, with `"capture": false` and `"retracting": true`.
- **Retraction lands.** Flush the uploader: `$C cli --name flush -- daemon --once --json`. Its
  output has `"retracted": 1`. Then `$C cli --name ls-off -- sessions ls` no longer lists `tog-1`.
- **Status says off.** Run `echo '{"session_id":"tog-1"}' | $C cli --name sl -- statusline
  --json --agent claude-code`. The output has `"capturing": false` and the reason `turned off
  for this session`.
- **No more uploads.** Add turns: `$C agent claude-code tog-1 --turns 2`. The daemon output has
  `"uploaded": 0`, and `sessions ls` still doesn't list `tog-1`.
- **Turn on.** Run `$C cli --name on -- capture on --session tog-1 --agent claude-code --json`,
  then `$C cli --name flush2 -- daemon --once --json`. `on` has `"fresh": true` and the flush
  has `"uploaded": 1`. `sessions ls` lists the session again under `tog-1~1` with all six turns.
- **Pause stops a running session.** Store `tog-2` with `$C agent claude-code tog-2 --turns 4`.
  Then run `$C cli --name pause -- capture pause 1h` and `$C agent claude-code tog-2 --turns 2`.
  The daemon output has `"uploaded": 0`, and `$C cli --name st2 -- capture status --session tog-2
  --agent claude-code` says it is stopped at its earlier offset.
- **Resume keeps it stopped.** Run `$C cli --name resume -- capture resume`, then
  `$C agent claude-code tog-2 --turns 1`. Still `"uploaded": 0`. A new session,
  `$C agent claude-code tog-3 --turns 4`, uploads (`"uploaded": 1`).
- **Proof.** Run `$C cli --name doctor-tog -- doctor --session tog-1~1 --agent claude-code` and
  `$C cli --name doctor-tog2 -- doctor --session tog-2 --agent claude-code`. Exit 0 for both:
  presence agrees with the decision, and offsets stop at the frozen point.

## Gotchas

- A retraction only reaches the store when the uploader runs. With `SESHI_NO_UPLOADER=1`, flush
  with `daemon --once` before asserting the session is gone.
- A session turned back on is a new session: its id gets a `~1` suffix.
- `capture pause` with no duration pauses until `capture resume`. Always resume, or the rest of
  the run's recipes start paused. `$C down` discards it anyway.
- The statusline reads stdin. Pipe the JSON payload in, or it judges the current folder instead
  of the session.
