# Doctor and explore

`seshi doctor` checks that a session was captured correctly, end to end: the transcript on this
machine, the capture state and queue, and what the store holds. `seshi explore` shows the same
evidence in a local, read-only web page: a session list, a view per session with its checks, a
pipeline strip, records side by side, a timeline and the raw evidence. Neither changes anything.

## Sub-features

- `doc-one`: `doctor --session <id>` checks one session; exit 0 when nothing fails.
- `doc-all`: `doctor` with no session checks every session seen in the last day.
- `doc-fail`: a broken session (its stored copy gone) fails with exit 8.
- `exp-list`: the explore page lists sessions with their worst check status.
- `exp-session`: the session view shows checks, pipeline counts, records and the timeline.
- `exp-guard`: the page's API refuses a missing token (401), a foreign Host (403) and a POST (405).

## How to get to it (user POV)

- Run `seshi doctor [--session <id>] [--json]` in a terminal.
- Run `seshi explore`, which opens the page in a browser.

## Driving it with control-seshi

Preconditions:

- A ready run with session `doc-1` stored: `$C agent claude-code doc-1 --turns 4 --secret`.

- **Doctor, one session.** Run `$C cli --name doc-one -- doctor --session doc-1 --agent
  claude-code`. Exit 0: every line is `ok` (Search is `skip` without `--deep`).
- **Doctor, JSON.** Run `$C cli --name doc-json -- doctor --session doc-1 --agent claude-code
  --json`. The JSON's `sessions[0].checks` has no `fail`.
- **Doctor, all.** Run `$C cli --name doc-all -- doctor`. One line per session seen today,
  `doc-1` with `ok`.
- **Doctor, failure.** Break the stored copy: delete the session's `metadata.json` under the
  run's `bucket/owners/<owner>/sessions/` (find it with `find "$TMPDIR/seshi-verify/$VERIFY_SESHI_RUN/bucket" -name metadata.json`).
  Then run `$C cli --name doc-fail -- doctor --session doc-1 --agent claude-code`. Exit 8, and
  Server presence is `fail`. This is the one recipe that writes the bucket by hand: it plays a
  store that lost data. Do it last in the run.
- **Explore starts.** Run `$C explore`. It prints `http://127.0.0.1:<port>/?token=<token>`, and
  `$C doctor` lists `explore running`.
- **Page: list.** Open the URL in the Browser pane (`preview_start` with that `url`). The page
  title is `seshi explore`, and the table has a row with the link `doc-1` and the agent
  `claude-code`.
- **Page: session.** Click the link `doc-1`. The view shows the heading `claude-code doc-1`, a
  `Checks` section with each check's status word, a `Pipeline` strip (`TRANSCRIPT`, `RECORDS`,
  `REDACTED`, `SENT`, `STORED`), and tabs `Records`, `Timeline` and `Raw`.
- **Page: records.** Click the button `Redacted`. Rows show `[redacted:aws-access-key]` and
  `[redacted:credential]` on both the local and the stored side.
- **Page: timeline.** Click the tab `Timeline`. The rows include `seen`, `upload` and `change`.
- **API guard.** With the port and token from the URL:
  - `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/api/sessions` gives `401`.
  - Adding `-H 'Host: evil.example:<port>' -H 'X-Seshi-Token: <token>'` gives `403`.
  - `-X POST -H 'X-Seshi-Token: <token>'` gives `405`.
  - `curl -s -H 'X-Seshi-Token: <token>' http://127.0.0.1:<port>/api/sessions/claude-code/doc-1/records?limit=500 | grep -c AKIAIOSFODNN7EXAMPLE` gives `0`.
- **Proof.** Save `get_page_text` of the session view and a screenshot to
  `.verify/seshi/<run-id>/explore-session.txt` and `.png`, and the curl codes to
  `explore-guard.txt`.

## Gotchas

- The page drops the token from the address bar after it loads. A browser reload then gets 401.
  Open the printed URL again.
- The list's check status starts as `pending` and fills in as the background pass reaches each
  session. Click `Check again` or wait; don't read `pending` as a failure.
- `doctor` with no `--session` covers only sessions seen in the last day (`--since 7d` widens it).
- Against a server, a review-dropped stub is inferred from the laptop's last answer. Only local
  mode reads the stored stub.
