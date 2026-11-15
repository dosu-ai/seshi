# Model review test data

## `labelled/fixtures.json`: the eval set (F3.8)

Hand-written sessions, each labelled with what the decision model should answer (`allow`,
`redact` or `drop`) and the exact text (`sensitive`) that must not be stored. None of it is
real: names, addresses, passwords, phone numbers and the ID number are made up or are
well-known example values.

`seshi review eval` runs a configured policy over them (or over a folder of your own fixtures
with `--fixtures`) and reports:

- label accuracy: how often the decision model's label is the expected one;
- false drops: envelopes dropped that should have been stored, and missed drops;
- redactor recall: of the sensitive strings in fixtures the redactor saw, how many it removed;
- leaked: sensitive strings that would have been stored, whatever the step that missed them.

Run it before changing a policy's prompts, models or categories, and compare. It calls the
policy's real providers, so it sends these fixtures (and only these) to them.

The package's unit tests run the same fixtures through a fake provider (`KeywordModel`) to check
the scoring, never through a real API.

A fixture is `{ "name", "label", "sensitive": [..], "records": [..] }`; `records` are canonical
trace records without the meta record (`user`, `assistant` with optional `tool_calls`, `tool`).

## The fake provider server

`src/testing.ts` `fakeProviderServer` answers like the two APIs the providers call. Its response
bodies are hand-written from the vendors' documented shapes, not recorded from live traffic:

- Anthropic Messages API, `POST /v1/messages`: `{id, type: "message", role: "assistant", model,
  content: [{type: "text", text}], stop_reason, stop_sequence, usage: {input_tokens,
  output_tokens}}`; errors as `{type: "error", error: {type, message}}` with the HTTP status.
- OpenAI Chat Completions, `POST /v1/chat/completions`: `{id, object: "chat.completion",
  created, model, choices: [{index, message: {role, content}, finish_reason}], usage}`.
