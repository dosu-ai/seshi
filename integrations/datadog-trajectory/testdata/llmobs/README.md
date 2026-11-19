# Datadog LLM Observability fixtures

Hand-built Export API answers (`POST /api/v2/llm-obs/v1/spans/events/search`) in the shape
Datadog documents. They are not recordings: no request was made to Datadog, Trajectory or any
vendor to make them. The answer's shape (`data[].attributes` with `span_id`, `trace_id`,
`parent_id`, `tags`, `name`, `status`, `start_ns`, `duration`, `span_kind`, `model_name`,
`model_provider`, `input`/`output` with `value` and `messages`, `metadata`, `metrics`; and
`meta.page.after`) follows Datadog's "Export API" page in the LLM Observability docs and the
"Search LLM Observability spans" API reference, as published in November 2026. The tags and
the structure of each turn (turn root, `agent_message` steps, tool spans, real LLM calls or the
synthetic turn-usage carrier, compaction spans, oversight traces) follow Trajectory's
`docs/LLM-OBS-SPAN-TAGS.md` and `docs/PUBLISH.md` (github.com/datadog-labs/trajectory). Ids,
times, text and token counts are made up.

| File | What it is |
|---|---|
| `trajectory-session.page1.json` | The first page of a window: a Trajectory session's first turn (turn root, three agent messages, `Bash` and `Edit` tool spans, and the synthetic span carrying the turn's token totals), the start of its second turn, and an automated oversight trace that names the session but belongs to none. `meta.page.after` points at page 2. |
| `trajectory-session.page2.json` | The last page: the rest of the second turn (two real LLM calls Trajectory captured, a `Write` tool span and a failed `Bash`, a compaction span tagged only with `trajectory.trace_correlation.session_id`), a repeat of a page 1 span, and a span of another app with no session. |
| `trajectory-minimal.json` | A session's turn at Trajectory's `minimal` level: ids, times and token counts, no content (F5.4: the session filter drops it). Its own trace and span ids. |
| `generic-app.json` | Another LLM Observability app (no Trajectory tags): two traces of one `session_id` tag, LLM spans whose input messages repeat the conversation, a tool span, and `start_ns` in milliseconds as in the docs' example answer. |

Things the docs leave open, and which these fixtures guess: whether `start_ns` is nanoseconds
(the docs say so; their example answers milliseconds, so both are read), whether span ids are
decimal (the docs' examples are) and trace ids 32 hex digits, that a root's `parent_id` is the
string `undefined` (as in the docs' example), which span kind Trajectory gives agent messages,
and where a tool span keeps the model's tool call id (`metadata.tool_use_id` here).

To change them, edit the JSON by hand (or regenerate it from a script kept outside the
repository) and keep it to documented fields.
