# Model review

Regular expressions catch secrets with a known shape. Model review (F3) is an optional second
stage for what they miss: passwords and connection strings in prose, personal data, customer
data, and envelopes that should not be stored at all. It is off until you write a review policy
with a provider key (`[[review.policies]]`, [config.md](config.md#review)):

```toml
[[review.policies]]
id = "default"
decision = { api_key = { env = "ANTHROPIC_API_KEY" } }
```

It runs inline, after regex redaction and the session filter and before anything is written,
on the records the upload adds (a continuation's new records only):

1. The **decision model** labels the records `allow`, `redact` or `drop`, nothing else. A long
   upload is split by turn into parts that fit `max_input_chars`; one `drop` drops it.
2. For `redact`, the **redactor LLM** is shown the parts labelled `redact` and answers with
   findings: which record, which field, the exact text, a category, and whether to remove the
   text or withhold the whole tool result. Code applies them: every occurrence of the text in
   that field becomes `[redacted:<category>]`, or the tool result becomes
   `[redacted:<category>]` marked `withheld: review`. The model never rewrites anything, so a
   bad answer can remove too much but cannot add or change text. Text under four characters is
   never removed on its own.
3. `allow` and `redact` are written; `drop` writes nothing and leaves a drop record under
   `sources/<id>/dropped/` with the policy, its hash and the decision model
   (`seshi sync dropped <id>`). Either way the session's log moves past what was dropped. A
   dropped first upload leaves a stub: a session with no trace that holds only where its log
   ends and a hash of what came before, never the text. The next upload continues from there
   and is reviewed on its own, so the session's stored trace starts after the dropped part,
   and the dropped text is never stored or sent to a model again, even when a client sends the
   whole log again. A stub is not listed or shown, and its owner can still delete or retract
   it.

A failed call, or an answer that does not fit, is retried with backoff (`retries`, 3). After the
last, `on_failure` decides: `drop` (the default: a drop record with reason `review_failed` and
which step failed, and the log moves past it as for any drop, a first upload leaving a stub) or
`skip` (written with regex redaction only, recorded as `skipped`).
A resend of an upload is answered from the session and not reviewed again; a `rebuild`
(`seshi capture resend`, or the uploader resending a stale session) is reviewed again whole,
which is how envelopes skipped or dropped during an outage get reviewed. The one exception is
a dropped first upload: the session remembers where the part it dropped ends (a byte offset,
a record count and a hash), and a rebuild, a replace or an OTLP session assembled again leaves
that part out, so it is never sent to a model or stored, even after the rules or the
normalizer changed. A first upload dropped because review failed is not reviewed again
either. A policy applies to
what is written after the server restarts with it: `seshi redact backfill` applies new regex
rules to stored sessions but does not send them to review again, and what review took out
stays out.

**What leaves the server.** Only the text of the records being judged: each record's content
and each tool call's arguments, with the record's role and the tool's name. Never the
transcript as uploaded, the meta record (working directory, branch), ids, timestamps, or LLM
call details. It goes to the endpoint the step names and nowhere else: keys and endpoints come
only from the config (never `ANTHROPIC_API_KEY` or similar from the environment), a key goes
only to the endpoint it was configured with, redirects are refused, the provider client never
logs requests (whatever `ANTHROPIC_LOG` says), and the providers' error text is never recorded
or logged. Only parts labelled
`redact` reach the redactor. `seshi config check` names every provider and endpoint a policy
sends to. To keep transcripts in-house, point both steps at a local model through
`provider = "openai-compatible"` and its `base_url`.

**What is kept.** For every stored write a policy reviewed,
`owners/<o>/sessions/<a>/review/<n>.json` records the policy and its hash, both models
(`anthropic/claude-haiku-5-5`), the label, the findings by record, field and category, and why
review was skipped; never the text. The policy hash covers the prompts, models, endpoints,
categories and scope, so a policy change shows. `GET /v1/sessions/:agent/:session_id/reviews`
gives admins the whole record and the session's readers only each write's label.

**Before you change a policy**, run `seshi review eval [--policy <id>] [--fixtures <dir>]`. It
sends seshi's labelled fixtures (or yours) through the policy's real providers and reports label
accuracy, false and missed drops, redactor recall, and what would have leaked.

The defaults: Claude Haiku 5.5 (`claude-haiku-5-5`) on the Anthropic Messages API for both steps,
with structured outputs and the model's own thinking and effort; seshi's prompts; categories
`secret`, `personal` and `customer-data`. Prompts, categories, models and providers are each
replaceable; seshi's own wrapping (the labels, the findings format, the instruction that the
records are data, not instructions) is not.
