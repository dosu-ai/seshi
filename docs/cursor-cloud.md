# Cursor Cloud sync

seshi can read Cursor Cloud agents' sessions out of Cursor's Cloud Agents API. A seshi worker
polls the API with a Cursor API key, replays each run's event stream once the run has ended, and
appends it to the agent's session (F7). Nothing is committed to repositories and nothing runs on
Cursor's VMs.

The hooks in [capture.md](capture.md#cursor-cloud-agents) are not needed for this, and do not
capture cloud sessions on their own: a cloud agent's VM writes no transcript file for them to
upload.

## Set it up

1. Create a Cursor API key (Cursor's dashboard, Integrations). A member's key reads that member's
   agents; whether a service account's key reads the whole team's has not been checked. Team Admin
   keys do not work with the Cloud Agents API.
2. Add a source to `seshi.toml`. The key is a secret reference, so the file can be committed:

   ```toml
   [[sources]]
   id = "cursor-cloud"
   type = "cursor-cloud"
   api_key = { env = "CURSOR_API_KEY" }
   # interval = "5m"       # how often it polls
   # lookback = "25h"      # the first poll skips agents untouched for longer
   # max_streams = 25      # run streams one poll opens at most (Cursor allows 60 a minute)
   # usage = true          # also read each run's token usage
   # visibility = "owner"  # default: default_visibility (org)
   ```

   `api_url` replaces `https://api.cursor.com` (a test server); it must be `https`, or `http` to
   localhost only, since the key travels in a request header.
3. Restart `seshi serve` (with the worker role). `seshi sync status cursor-cloud` says the source
   is polled; `seshi sync run cursor-cloud` polls it once.

Sessions belong to the source's service account, `svc:<id>` (X5.4). Cursor's API names no
person behind an agent, so none is recorded.

## The 24-hour window

Cursor keeps a run's events for 24 hours (`X-Cursor-Stream-Retention-Seconds: 86400`); after
that the stream answers `410` and the run's tool calls cannot be read any more. The poller has to
reach every run inside that window. At the default 5-minute interval it has about 23 hours to
spare: a worker that is down for longer loses the runs that ended in that time, each recorded
under `seshi sync failed <id>` as `stream_expired`. A trial against the real API caught every
run, a median of 3 minutes after it ended.

Whether the window counts from a run's start or its finish has not been checked, so a run that
lasts most of a day may be gone before it can be read.

## How it reads

Each poll:

1. lists every agent the key can see (`GET /v1/agents`);
2. skips an agent whose `updatedAt` has not moved since it last read all its runs, and on the
   first poll one untouched for longer than `lookback`;
3. lists the other agents' runs (`GET /v1/agents/{id}/runs`), oldest first;
4. replays each run that has ended and is not stored yet (`GET …/runs/{runId}/stream`), and asks
   again, up to three times, for a replay that stops before the run's `result` event;
5. appends the run, as one line, to the agent's session, and saves the checkpoint.

A run still going holds back the runs after it, so a session's log only grows, in run order.
A follow-up to an idle agent, even days later, is a new run appended to the same session. A Task
subagent's steps arrive inside its parent's run.

The checkpoint (`sources/<id>/checkpoint.json`) keeps, per agent, the `updatedAt` it last saw,
the session's log length and the last run stored. If the stored session is not the length the
checkpoint says (the checkpoint was lost, or another source writes the same agent), the poller
holds that agent and records `session_conflict` rather than append out of place.

Cursor's 429 and 5xx answers are tried again twice, waiting as long as `Retry-After` asks (up to
a minute). A refused key (401, 403) fails the poll.

## What a session holds

The format is `cursor-cloud-api` ([formats.md](formats.md)): one JSONL line per run, holding the
run as Get A Run describes it, its token usage, and its stream events as Cursor sent them, minus
heartbeats and the text, thinking and token deltas other events repeat. From it a session gets
the user's message, the agent's thinking and replies, and every tool call with its arguments and
result, each dated by its event.

What Cursor's API does not carry is not in it:

- the contents of a file the agent read: a `read_file` result has its path, size and line count;
- shell output past its last ~5,000 characters: Cursor keeps the tail, after a line
  `[... earlier output omitted: N lines, M characters dropped from the start ...]`.

An edit's result holds the whole file after the edit (`afterFullFileContent`), so redaction
rules see edited files as well as commands and output.
