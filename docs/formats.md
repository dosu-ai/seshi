# Formats

What seshi reads, and what it writes. Every input, whatever its format, is normalized to the
same records and stored in one canonical trace format; other formats are rendered from it on
read.

## What seshi reads

A transcript is posted with its `format` (`POST /v1/sessions`,
[server.md](server.md#post-v1sessions)); `seshi upload` and the capture uploader detect it.
Each is normalized to [Letta trajectory-v1](https://github.com/letta-ai/trajectory) records,
through `@letta-ai/trajectory`'s adapters plus the fixups they need, or through seshi's own
adapter where there is none.

| `format` | What it is | Chunks |
|---|---|---|
| `claude-code` | Claude Code's session log (`~/.claude/projects/…/<session>.jsonl`) | Yes |
| `codex` | Codex's rollout log (`~/.codex/sessions/…`) | Yes |
| `cursor` | Cursor's agent transcript (IDE and CLI) | Yes |
| `cursor-cloud-api` | A Cursor Cloud agent's runs as the Cloud Agents API streams them, one JSONL line per run; what the [Cursor Cloud poller](cursor-cloud.md) writes | Yes, at run boundaries |
| `opencode` | An OpenCode session export, `format: "json"` | No: whole documents |
| `pi` | pi's session log (also its forks, OMP and OpenClaw) | Yes |
| `gemini-cli` | A Gemini CLI session document (JSON) | No: whole documents |
| `datadog-trajectory` | A [Datadog Trajectory](#datadog-trajectorys-format) session file | Yes |
| `atif` | An [ATIF](#atif-documents) document, `format: "json"` | No: whole documents |
| `trajectory` | [Records already in trajectory-v1](#trajectory-v1-records) | Yes |

Two more ways in produce sessions without a transcript: OTLP spans
([otlp.md](otlp.md)), stored as `otlp-genai`, and Datadog LLM Observability
([datadog.md](datadog.md)), stored as `datadog-llmobs`. An S3 source reads any of the formats
above from a bucket ([s3-sync.md](s3-sync.md)).

## Datadog Trajectory's format

[Trajectory](https://github.com/datadog-labs/trajectory) is Datadog's capture daemon for coding
agents. It records each session it captures, from Claude Code, Codex, Cursor, Pi and the other
clients it supports, as one canonical event per line in a file of its own format, at
`~/.trajectory/trajectories/sessions/<date>/session-<id>.jsonl`. This server reads that format.
It has no dependency on the daemon or its CLI and no endpoint for it; `datadog-trajectory` is
one more transcript format, normalized to trajectory-v1 by the server's own adapter
(`@letta-ai/trajectory` has none for it) and stored like every other.

A file in that format gets in like any other transcript: `POST /v1/sessions` with
`agent: "datadog-trajectory"` and the file as `transcript`, whole or [in chunks](server.md#in-chunks) as
the daemon appends to it. A file with no `session_end` is a session that is still running; it
normalizes to what it has so far, and the next chunk continues it.

The session is filed as `agent: datadog-trajectory` and its trace's `source` names the client
the daemon captured, `datadog-trajectory:claude-code`, so a session captured both ways (a
client posting the native log and the same session in Trajectory's format) is two archives,
each honest about what normalized it. `session_id`, `git_branch` and `parent_session_id` come
from the file's `session_start`; the branch is the one the daemon recorded.

What the adapter keeps: `user_prompt` / `input_prompt` as user records (as observations when
the daemon attributes them to something other than a person), `tool_use` with `phase: pre` as
tool calls under the client's own tool name, `phase: post` as results with `ok` from `success`,
and `agent_message` as reasoning and assistant records. Accounting and lifecycle events
(`llm_call`, `turn_end`, `inventory.snapshot`, permissions, subagent start and stop) carry no
conversation and are dropped; a subagent's answer arrives as the `Agent` tool's result, and its
own session as its own file. A file with no `session_start` gets `422
normalize_missing_session_start`.

A session the daemon imported from a client's own history (`trajectory session import`) is
thinner than one it captured live: no prose from the agent, and tool calls present only as
their results. The adapter reads those too, and most come out `filtered`, which is right: there
is no conversation in them.

## ATIF documents

[ATIF](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md) is
Harbor's Agent Trajectory Interchange Format: one JSON document per session, exported from
whichever harness ran it ([Decant](https://github.com/dosu-ai/decant) writes it). Post one with
`agent: "atif"` and `format: "json"`. `@letta-ai/trajectory`'s `atif` adapter normalizes it, and
the server applies these rules:

- **Whole documents only.** An ATIF document is one JSON value, so a chunk (`offset` > 0) gets
  `422 bad_chunk` whatever `format` says. A document that grew is sent whole again; its new
  steps are written as a continuation, and a document rewritten from the start is sent with
  `replace` by its original writer.
- **ATIF-v1.0 through ATIF-v1.8.** A later version is refused with
  `422 normalize_invalid_input`; the message names the version. The adapter reads up to v1.7;
  a v1.8 document is handed to it as v1.7, its `audio` content parts (the one v1.8 addition)
  turned into the text `[audio]`, as the adapter writes `[image]` for an image.
- **The harness comes from `agent.name`.** The session is filed under `format: atif`, and the
  archive id derives from that. The trace's `source` is the document's `agent.name`
  (`claude-code`, `codex`, `copilot-cli`), or `atif` when the name is blank or holds control
  characters. The trace's `format` field (`atif`) records that the session came in as ATIF.
- **Tool errors come from `extra.is_error`.** ATIF has no standard success field. A tool result
  whose `extra.is_error` is a boolean gets `ok` from it; one without gets no `ok`.
- **Subagents are sent separately.** The adapter does not normalize embedded
  `subagent_trajectories` into the parent. The parent keeps the subagent's tool result, a
  `subagent_trajectory_ref`, as JSON text. Post each subagent as its own session, with
  `parent_session_id` set to the parent's `session_id`.

The adapter also drops system steps (as it does for every source), metrics, costs, token ids,
logprobs and `extra` fields. The document's `cwd` and `git_branch` do not reach the trace, so
send `project` and `branch` with the upload.

## Trajectory-v1 records

A log that is already Letta trajectory-v1, one record per line, is posted as
`agent: "trajectory"`, whole or in chunks. Nothing normalizes it: each line is parsed and checked
(a line that is not JSON, or a record that is not trajectory-v1, gets `422
normalize_invalid_input`), then redacted like any other source's records. A chunk's `meta`
record is dropped, as for every other chunk. The trace's `source` is what the records' `meta`
says.

## Which agent wrote it

A caller that holds logs without knowing which agent wrote them (a bucket of them, say) can ask
seshi: `seshi normalize --json <file>` prints the format it detected (as `agent`) with the records, and
fails when no format reads the file. `seshi upload` and an S3 source with `format = "auto"`
detect the same way. Detection reads the start of the file (a last line cut short is ignored;
an ATIF, OpenCode or Gemini CLI document is read from its opening keys) and refuses a sample
that more than one format would read. It tells apart every format above, except that pi's
session format is shared by its forks (OMP, OpenClaw), which it reports as `pi`.

## Content an agent or a plugin adds

Some agents keep text the person never typed in the user's turn: what the agent or a plugin
added, which the model saw. seshi stores it on a user record of its own, labelled
`synthetic: true`, with its text as it was. An integrator that adds content it does not want
stored flags it with `session_capture.omit = true` in the metadata the agent keeps beside the
content (the key is `SESSION_CAPTURE_KEY` in `@seshi/formats`). The flag counts only when it is
exactly `true`. seshi then replaces the content's text before anything reads it, so it never
reaches redaction or the store, and stores a user record in its place with empty content,
`synthetic: true` (when the agent marked it so) and `omitted: 1`.

| `format` | Labelled `synthetic` | Where the flag goes | Ignored on |
|---|---|---|---|
| `opencode` | A user message's text part with `synthetic: true` (a file read for an `@` mention, a plugin's context) | The part's `metadata` | An assistant message's parts: its text, reasoning, tool calls and their results |
| `pi` | A `custom_message` entry: what an extension added to the context (`pi.sendMessage`, a `before_agent_start` message), stored as the user message the model saw | The entry's `details` | `message` entries: the user's prompts, the assistant's messages and tool results (a tool result's own `details` included) |

Labels are matched to records by the item's id (an OpenCode part's `id`, a pi entry's `id`), so
an item without one cannot be labelled: a flagged OpenCode part without an id is dropped
without a record, and a pi `custom_message` without an id is not stored, as before. Nothing else
about synthetic content changes: no kind of it is rewritten, reclassified or dropped unless
flagged. The other formats keep no per-item metadata, so the flag does not apply
to them. The labels are part of the canonical trace only: the `letta` render drops them, and
they are outside the content hash.

## What seshi writes

Every input is stored in one canonical format, `seshi/trace/1`
([`spec/schemas/trace.schema.json`](../spec/schemas/trace.schema.json), X6.2): the
trajectory-v1 records, their events and content hash, plus what a raw transcript used to keep:
the model and token usage per LLM call, record ids, tool call ids and timings, which user
records an agent or a plugin added (`synthetic`, `omitted`), and where the data came from. The model and token usage come from what each source records: a Claude Code
transcript's `message.model` and `message.usage` per request, a Codex rollout's `turn_context`
model and `token_count` per model response, an OTLP or Datadog span's usage attributes. A
Codex chunk cut between a response and its `token_count` leaves that response's records
without a call. The layout it is stored in (immutable content-addressed traces, one pointer per
session, an append-only change feed) is [`spec/layout.md`](../spec/layout.md).

Other formats are rendered on read, by `GET /v1/sessions/:format/:id/trace?render=` and
`seshi sessions export --format`:

| Format | What you get |
|---|---|
| `seshi` (default) | The stored canonical trace |
| `letta` | `sessionstorage/trace/1`: plain trajectory-v1 records, events and hash, as sessiondb stored them |
| `otlp` | An OTLP/HTTP JSON `ExportTraceServiceRequest`: OpenTelemetry GenAI spans (`invoke_agent`, a `chat` span per model turn with its `gen_ai.usage.*`, an `execute_tool` span per tool call), ready to post to a collector. Lossless: the canonical trace can be read back from it |
| `atif` | An ATIF-v1.7 document, with token usage as step metrics |

`content_hash` is computed from the records alone, never from timestamps, so re-exporting the
same conversation writes nothing new. The goldens in `spec/testdata/` and each integration's
`testdata/` pin it.
