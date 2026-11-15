# Datadog sync

seshi can read coding-agent sessions out of Datadog LLM Observability. [Datadog
Trajectory](https://github.com/datadog-labs/trajectory) publishes each session it captures
there, one trace per turn, and LLM Observability has no push export, so a seshi worker polls
its Export API (`POST /api/v2/llm-obs/v1/spans/events/search`) and rebuilds each session from
its turns (F5). Nothing is installed on laptops (F5.4).

The Export API is marked preview by Datadog. seshi is pinned to the answer shape it was tested
against and fails a run loudly (`the Datadog Export API answer changed shape: …`) rather than
read a changed answer as nothing.

## Set it up

1. Create a Datadog API key and an application key. The application key needs to read LLM
   Observability: create it as a scoped application key with only the `llm_observability_read`
   permission where your Datadog org allows scoped keys.
2. Add a source to `seshi.toml`. Keys are secret references, so the file can be committed:

   ```toml
   [[sources]]
   id = "datadog-prod"
   type = "datadog"
   site = "datadoghq.com"          # datadoghq.eu, us5.datadoghq.com, ap1.datadoghq.com…
   api_key = { env = "DD_API_KEY" }
   app_key = { env = "DD_APP_KEY" }
   ml_app = "coding-agents"        # Trajectory's default ml_app
   # tags = ["env:prod"]           # key:value; a span must carry all of them
   # visibility = "owner"          # default: default_visibility (org)
   # interval = "5m"               # how often it polls
   # overlap = "10m"               # how far back of the checkpoint each run reads again
   # lag = "2m"                    # how far behind now each run stops
   # backfill = "7d"               # how far back the first run reads
   # page_size = 500               # spans per page (Datadog allows up to 5000, 50 MB)
   # quiet_period = "10m"          # publish a session once no new spans came for it this long
   ```

   Every field is in [config.md](config.md#sources). `api_url` replaces
   `https://api.<site>` (a proxy). It must be `https`, since the keys travel in request headers;
   plain `http` is accepted for `localhost` only.
3. Restart `seshi serve` (with the worker role). `seshi sync status datadog-prod` says the
   source is polled; `seshi sync run datadog-prod` polls it once, for cron or to try it. Without
   a worker, cron `seshi sync assemble` too: polling stores spans, and the assembler publishes
   their sessions.

## How it reads

Each run reads one time window, oldest spans first, a page at a time (F5.1, F5.2):

- from the checkpoint minus `overlap` (spans Datadog indexes late) to now minus `lag`;
- the first run reaches back `backfill`;
- spans already submitted in the overlap are left out by span id;
- the checkpoint (`sources/<id>/checkpoint.json`) is saved after each page, once that page's
  spans are in the span store. A run that reads 20 pages hands over to the next at once, which
  carries on from the saved page cursor; a stale cursor Datadog refuses makes it read the window
  again from its start.

Datadog's 429 answers are honoured: the run waits as long as `Retry-After` (or
`X-RateLimit-Reset`) asks, up to five minutes, and then fails so the job's backoff takes over.
5xx answers, network failures and a request with no answer within two minutes are retried; a
refused key (401, 403) fails the run with the reason. A redirect is never followed (the keys
would go along to the other host): it fails the run, naming the status. A failed run leaves the checkpoint where it was, so the next one reads the same spans
(X4.8).

## Sessions

1. **Grouped** by the session each span names (F5.3): `trajectory.session_id` (on every span of
   a Trajectory turn), else `trajectory.trace_correlation.session_id` (compaction and correlation
   spans), else a `session_id` tag (LLM Observability's own sessions, for apps that are not
   Trajectory). Spans that name no session, and Trajectory's automated oversight traces, are
   skipped and counted in the run's log line. Items of a page that are not readable spans (no
   span id, trace id or start time) are skipped too, and leave one `unreadable_spans` record
   per page read under `sources/<source-id>/failed/` (`seshi sync failed <source-id>`, counted
   as `failed` in health); the rest of the page is stored. Records are not deduplicated: an
   item that the next window's `overlap` (or a restart of the window) reads again is recorded
   again.
2. **Normalized and redacted on arrival** into the span store, as for OTLP
   ([otlp.md](otlp.md#what-happens-to-spans)): the server's rule set (built-in and operator
   packs) runs over each span's text, tool calls and LLM call error, and each span record keeps
   its rule counts. Nothing unredacted is stored.
3. **Assembled and published** by the worker's `assembler` job once the session has had no new
   spans for the source's `quiet_period`. It belongs to `svc:<source-id>` (X5.4) with
   `owner_basis: service`, and takes the source's `visibility`. The session's
   `metadata.redaction` counts each match once, and model review runs before the write: a
   `[[review.policies]]` entry whose `sources` names the datadog source applies, and a session
   review drops is recorded under `sources/<source-id>/dropped/`.

Sessions are filed under the format `datadog-llmobs`:
`GET /v1/sessions/datadog-llmobs/<session id>?owner=svc:datadog-prod`.

### What a session holds

A Trajectory turn repeats itself (the turn's output is its last message, an LLM span's input is
the conversation so far), so each thing is taken from one place:

| From | Becomes |
|---|---|
| the turn root's input (`trajectory.semantic_type:turn`) | the `user` record |
| each agent message's output (`agent_message`, `inference-N`) | an `assistant` record (and `reasoning`) |
| the turn root's output | the `assistant` record, only when no agent message has one |
| a tool span | the tool call and its result, with its duration and failure |
| a compaction span | an `observation` |
| LLM spans | the turn's LLM calls (model, provider, times, token usage, stop reason, parameters, error): the real calls Trajectory captured (`trajectory.llm_call:true`), named by the agent messages that made them; else the synthetic span carrying the turn's totals (`trajectory.placeholder_llm_span:true`), named by the turn's last message. Each turn's tokens are counted once |
| `trajectory.user_email`, `git.email`, `trajectory.user`, `github.username` | claims, recorded and never used for ownership |
| `project_dir` | the session's `project` |

Spans of other LLM Observability apps are read by span kind: the LLM spans' messages (the
history each request repeats is dropped), else the trace root's input and output, and tool
spans.

## Capture level

What a session holds depends on the destination's Trajectory capture level. At `minimal`,
Trajectory sends ids, times and token counts but no text: such sessions are near empty, the
session filter drops them (X4.10), and the source's health counts them as `filtered`. If
`seshi sync status <id>` shows mostly `filtered`, raise Trajectory's level to `standard` or
`full` for this destination.

## Reprocessing

`seshi reprocess --source datadog-prod --since 2026-11-01` makes the next run read everything
from that time again (X4.9); without `--since` the source starts over with its backfill. This
works while Datadog still holds the spans (its LLM Observability retention). A `--since` later
than what the source has read so far leaves the checkpoint where it is (spans after it are
still unread, so they are read anyway); one in the future is refused.

## Troubleshooting

| What you see | Why |
|---|---|
| `Datadog answered 403 … (check api_key and app_key…)` | A wrong key, a key for another site, or an application key that cannot read LLM Observability |
| `the Datadog Export API answer changed shape` | The preview API changed; the poller needs updating. The checkpoint did not move |
| `Datadog answered 30x (a redirect, not followed…)` | `site` or `api_url` names a host that redirects (often `app.` instead of `api.`, or a proxy); point it at the API host |
| `Datadog rate-limited the search for …s` | Datadog asked for a wait over five minutes; the job tries again later |
| Sessions appear late | `lag`, `interval` and `quiet_period` add up: a turn shows up after about all three |
| No session, `filtered` in health | Minimal capture, or the session filter judged the session too short (`[filter]`, or the source's `filter`) |
| `unreadable_spans` in `seshi sync failed` | Some items of a page were not readable spans and were skipped; the rest was stored. Datadog's answer may be drifting from the documented shape |
| `… without a session tag, skipped` in the log | Spans of an app that sets no session; filter them out with `ml_app` or `tags` |
| A session also exists as `datadog-trajectory` | The same session uploaded from the daemon's file too. Both are kept (X4.5); `native_session_id` matches |
