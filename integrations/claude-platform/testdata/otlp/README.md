# Claude Platform OTLP fixtures

Hand-built OTLP/JSON `ExportTraceServiceRequest`s in the shape a Claude Console
OpenTelemetry destination (and the Anthropic SDK) sends. They are not recordings: no
request was made to Anthropic or any vendor to make them. Span names, kinds, parentage and
attributes follow Anthropic's published references ("OpenTelemetry tracing for the Claude
API" and "OpenTelemetry span reference" on platform.claude.com, beta, conventions at
semantic-conventions-genai commit `e57c543b`). Ids, times, text and token counts are made up.

| File | What it is |
|---|---|
| `managed-agents-session.otlp.json` | A Managed Agents session in Full content mode: `anthropic.sessions.create`, two `anthropic.sessions.events.send` requests each starting an `anthropic.session.turn` (system instructions, input and output messages), `anthropic.model_request` spans with usage, an `anthropic.tool_use bash` span with arguments and `anthropic.tool_result.content`, and a final `anthropic.sessions.archive`. Four traces, one `anthropic.session.id`. |
| `managed-agents-metadata-only.otlp.json` | The same session from a destination in Metadata only mode: no content attributes (F4.5). |
| `messages-tool-runner.otlp.json` | A Messages API tool-runner loop with SDK tracing and API tracing both on: the SDK's `anthropic.messages.tool_runner`, two `anthropic.messages.create` `CLIENT` spans and an `anthropic.custom_tool_use get_weather` span (resource `weather-app`), and under each client span the API's `anthropic.messages.create` `SERVER` span with its `anthropic.model_request` (resource `claude-platform`). One trace, no session or conversation id. |

To change them, edit the JSON by hand (or regenerate it from a script kept outside the
repository) and keep it to documented attributes.
