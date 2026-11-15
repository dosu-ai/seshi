# OTLP ingest

seshi takes OpenTelemetry traces over OTLP/HTTP at `POST /otlp/v1/traces` and turns the spans
of each conversation into a seshi session. It is built for the Claude Console's OpenTelemetry
destinations, which send a trace of every Messages API request and Managed Agents session, and
it reads any producer that follows the OpenTelemetry GenAI conventions (`gen_ai.*`).

Only traces are taken. OTLP logs and metrics (Claude Code's own telemetry, for one) are not
(F4.6).

## Set up a Claude Console destination

1. Add a source for the destination to `seshi.toml`. Each destination is its own source, with
   its own service account (`svc:<id>`): separate destinations per workspace give separate
   service accounts.

   ```toml
   [[sources]]
   id = "console-prod"
   type = "otlp"
   # visibility = "owner"   # default: default_visibility (org)
   # quiet_period = "10m"   # publish a session once its spans have been quiet this long
   ```

2. Restart `seshi serve`, then mint a service token that writes for it (an admin token):

   ```sh
   curl -X POST https://seshi.example.com/v1/tokens \
     -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
     -d '{"kind":"service","service":"console-prod","scopes":["sessions:write"],"label":"Claude Console"}'
   ```

   The answer holds the token once; it is stored only as a hash.

3. In the Claude Console, open the organization's OpenTelemetry settings and add a destination:

   | Field | Value |
   |---|---|
   | Provider | Custom |
   | OTLP endpoint URL | `https://seshi.example.com/otlp` (the Console adds `/v1/traces`) |
   | Request headers | `authorization`: `Bearer seshi_…` |
   | Content mode | **Full content** |
   | Workspaces | The workspaces to trace |

The Console sends to port 443 over HTTPS with a hostname, so seshi needs TLS in front of it,
usually a load balancer. The endpoint is outside seshi's own `/v1` on purpose: the `/v1` in
`/otlp/v1/traces` is OTLP's version, and a later seshi `/v2` will not move a URL pasted into a
destination (F4.1).

Any other OTLP/HTTP exporter is set up the same way: endpoint `https://<seshi>/otlp` (or the
full `https://<seshi>/otlp/v1/traces` where the exporter wants the traces URL), header
`Authorization: Bearer <service token>`, protobuf or JSON, gzip or not.

### Batch size

A request body may be up to 64 MiB as sent (`limits.max_otlp_bytes`) and, when gzipped, up to
256 MiB once inflated (`limits.max_otlp_inflated_bytes`) (F4.1). A larger request is answered
`413` with a message naming the key it is over, and none of its spans are stored; inflating
stops at the cap, so a small body that would inflate to far more costs no more than the cap.

Keep batches small: a few hundred spans or a few MiB per request. A span with full content
carries the whole conversation so far, so a batch of a long session's spans grows quickly, and
the server decodes each request in memory. With the OpenTelemetry SDK's batch span processor,
lower `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` (512 by default) if requests come back `413`. Raise the
caps in `[limits]` only for a sender whose batches you cannot split.

## Metadata only is refused

seshi stores conversations. A batch in which no span carries prompt or response content, what
a destination in "Metadata only" mode sends, is answered with `partial_success` rejecting every
span, with a message saying to switch the destination to Full content, and nothing is stored
(F4.5). The Console may not show that message to anyone, so the source's health counts each
such batch as `rejected`: `seshi sync status console-prod` and `seshi workers status` show it.
Spans without content in a batch that has some (tool timing, model requests) are kept.

Organizations whose agreement with Anthropic restricts data handling (HIPAA, FERPA, K-12) get
metadata only from destinations whatever their content mode; seshi cannot store their sessions
this way.

## What happens to spans

1. **Grouped into sessions** (F4.3) by `anthropic.session.id`, else `gen_ai.conversation.id`,
   else the trace id. A Managed Agents session that spans several traces and threads is one
   seshi session; a Messages API request without a conversation id is one session per trace.
2. **Normalized and redacted on arrival** (X6.3). Each span becomes its part of the session
   (the messages it carried as records, the tool call it ran, the model request it stands for)
   and the redaction rules run on it. Only that is kept, under the session's `spans/` in the
   bucket, never the span as received, and never readable through the API. A span sent twice
   (exporters retry) is kept once. The request is answered as soon as its spans are stored.
   `seshi redact backfill` redacts kept span records again after the rules change, including
   those of sessions not published yet or refused by the filter or model review.
3. **Assembled and published** (F4.4) by the worker's `assembler` job (or, with no worker,
   `seshi sync assemble` from cron) once the session has had
   no new spans for the source's `quiet_period` (10 minutes by default), or about 15 seconds
   after a span that ends it (an archived or deleted Managed Agents session; the root span of a
   one-trace request). The assembler orders the spans, keeps each thing said once (a chat
   request repeats the conversation so far; the SDK and the API both report a request), and
   publishes the session through the pipeline: the session filter, model review if configured,
   and the write. The session belongs to `svc:<source-id>` with `owner_basis: service`.
4. **Late spans** wake the session again: once quiet, it is published again, as a continuation
   when it grew at the end, or as a replacement when a span landed earlier on.

Sessions are filed under the format `otlp-genai`:
`GET /v1/sessions/otlp-genai/<session id>?owner=svc:console-prod`.

### What a session holds

| From | Becomes |
|---|---|
| `gen_ai.system_instructions` | a `system` record, when it changes |
| `gen_ai.input.messages` | `user` records, `tool` results, and the history a request repeats dropped |
| `gen_ai.output.messages` | `assistant` records (text and tool calls), `reasoning`, `tool` results |
| a tool span (`anthropic.tool_use bash`, `execute_tool …`) | its duration and failure on the matching result; its own call and result when no message holds them (a client-side tool) |
| a model request (`chat`, `anthropic.model_request`) | an LLM call: model, provider, times, token usage, stop reason, request id, parameters, error |
| `anthropic.session.outcome_evaluation` | an `observation` with the grader's explanation |
| `anthropic.organization.id`, `anthropic.workspace.id`, `user.id` | claims (`account_ids`), recorded and never used for ownership |

Images and documents appear as their type (`[image]`), as the Console sends them.

### Counting tokens

Each request's usage is counted once: from the API's request span when there is one (its model
requests repeat it), from each model request of a Managed Agents turn otherwise. A compaction's
own usage inside a Messages API request is not counted separately yet.

## Troubleshooting

| What you see | Why |
|---|---|
| `401` | The token is unknown, revoked or expired |
| `403 … is not an otlp source in [[sources]]` | The token is not a service token for a configured `otlp` source, or it reads instead of writes |
| `403 … is disabled` | The source has `enabled = false` |
| `413 … limits.max_otlp_bytes` or `… limits.max_otlp_inflated_bytes` | The request is over the [batch size](#batch-size) caps: send smaller batches, or raise the key named |
| `415` | The exporter sent a `Content-Type` other than `application/x-protobuf` or `application/json` |
| `partial_success` with "Full content" | The destination is in Metadata only mode |
| Sessions appear after ten minutes | The quiet period; lower `quiet_period` for the source |
| No session, `filtered` in source health | The session filter judged it too short (`[filter]`, or the source's `filter`) |
| `seshi workers status` shows `pending_sessions` growing | No worker is running (run one, or cron `seshi sync assemble`), or the assembler fails: see its last error |
