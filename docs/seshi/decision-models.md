# Decision models for model review: scope

Status: scoping only, nothing built. This page covers whether and how the **decision step** of
model review (F3, [model-review.md](../model-review.md)) can call purpose-built decision models
instead of a general LLM. It looks at two: **Jev** from TypeSafe and OpenAI's **Decisions API**.
The redactor is out of scope and stays an LLM.

Sources were read on 2026-11-19. TypeSafe: [docs.typesafe.ai](https://docs.typesafe.ai/introduction)
(the [`/v1/systemone` reference](https://docs.typesafe.ai/api/system-one),
[models and pricing](https://docs.typesafe.ai/models),
[confidence](https://docs.typesafe.ai/confidence),
[errors](https://docs.typesafe.ai/api/errors),
[model jaggedness](https://docs.typesafe.ai/model-jaggedness),
[legal](https://docs.typesafe.ai/legal)). OpenAI: the
[Decisions guide](https://developers.openai.com/api/docs/guides/decisions), the
[create decision reference](https://developers.openai.com/api/reference/resources/decisions/methods/create),
the [`gpt-6-luna` model page](https://developers.openai.com/api/docs/models/gpt-6-luna) and
[data controls](https://developers.openai.com/api/docs/guides/your-data). All of these pages
were public. Where the docs say nothing, this page says so and does not guess.

## Summary

- Both APIs do the same thing: you send text and a typed question, and you get back one
  label from a fixed set plus a probability for each label. Neither writes any text, and
  neither gives a reason. seshi's decision step already asks for one label and no
  explanation, so it maps onto either API directly.
- **Neither provider stores anything on its side.** There is no hosted decision, policy id or
  per-account tuned model. The whole policy (the instructions and what each label means) is
  sent with every request. So the policy hash can stay entirely local, and "training" a
  provider comes down to calibrating seshi's thresholds and wording against labelled data.
- **The smallest seam:** add a `decide()` interface used only by the decision step, wrap
  today's LLM providers in an adapter behind it, and add two `provider` values that are
  valid only on `decision`. The redactor and `complete()` stay as they are.
- **Users write one prompt, as today.** seshi owns what `allow`, `redact` and `drop` mean,
  because their meaning is the pipeline's. The user's prompt says what counts as sensitive in
  their organization. The only new key is `thresholds` on the label probabilities, for
  example "drop only above 0.9, otherwise redact". The review record gains each part's three
  probabilities. That is numbers only, never text.
- **Both providers keep every "what leaves the server" guarantee** through their own SDKs,
  configured the way `anthropic.ts` configures Anthropic's: explicit key and endpoint, the
  SDK's retries and logging off, redirects refused. Retention and training terms are between
  the user and the provider they choose, under the user's own contract; seshi's part is to
  send only record text, only to the endpoint configured.
- **Recommendation:** build the seam and **OpenAI Decisions first**, then **Jev**. It is
  close. OpenAI's context fits seshi's default part size, so the first eval compares a
  decision model with today's LLM on exactly the same parts. Jev's default context (32k
  tokens per question) needs a smaller part size, which is its own measurement. Jev is cheaper
  per token and publishes latency figures. Once the seam exists, it is a small follow-up, and
  the order can swap if Jev matters more to the first users.

## 1. What these APIs are

| | Jev (TypeSafe) | Decisions API (OpenAI) |
|---|---|---|
| Endpoint | `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer` | `POST https://api.openai.com/v1/decisions`, `Authorization: Bearer` |
| Status | Generally usable; launched as "early access" ([blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)). Current model `jev-1.14.0` (2026-10-14) | Generally available (was public beta). Only model: `gpt-6-luna` |
| Request | `model`, `state` (string, object or array: the content), `questions` (an object keyed by question name) | `model`, `input` (string, or messages with tool calls and outputs), `questions` (an array, 1–400, each with a `name`) |
| Question types | `choice` (up to 255 options), `score` (up to 10 ordered levels), `noul` (yes/no), `box` (images) | `choice` (2–255), `score` (2–10 levels), `predicate` (yes/no) |
| How you define the decision | `instructions` plus `criteria`: `{option: description}` for a choice, `{true, false}` for a noul | `instructions` plus `choices: [{value, description}]`, or `levels` for a score |
| Choice answer | `choice`, `probabilities` `{option: p}`, `confidence` | `choice`, `probabilities` `[{value, probability}]`, `confidence` |
| Yes/no answer | `noul`: P(yes) | `probability`: P(true) |
| Reason / explanation | None | None. An answer can instead be a `refusal` |
| Examples or training data | None. There is no fine-tuning, and every account is served the same weights ([models](https://docs.typesafe.ai/models#customizing-jev)). Examples go into the criteria text | None documented, and fine-tuning is listed as unsupported for `gpt-6-luna`. Examples go into the descriptions |
| Response also has | `model` (the versioned id that answered, even when an alias was sent), `usage` | `model`, `usage` (with cache read and write counts) |
| Context | 64k tokens per request and 32k per question by default. 262k with the `TypeSafe-Danger-Zone-Long-Context` header, which the docs call slower and less accurate | 1.05M-token window, 922k max input |
| Price | $0.042 per million input tokens. Output is free | $0.10 per million input tokens. Output is not charged. Cache reads cost $0.01/M and cache writes $0.125/M |
| Latency (published) | "Most calls complete in about 100 ms" ([how to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)), and 70–500 ms end to end ([launch blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)) | "About 10x faster than the Responses API". No absolute figure |
| Rate limits | Set per organization and shown in the console (behind a login, so not read) | `gpt-6-luna` tiers start at 5,000 RPM and 2M TPM. The docs don't say whether `/v1/decisions` shares those limits |
| Training on your data | "Will not train or fine tune ... on Input" ([privacy policy](https://typesafe.ai/legal/privacy-policy)) | Not used for training ([data controls](https://developers.openai.com/api/docs/guides/your-data)) |
| Retention | Set by the [DPA](https://typesafe.ai/legal/data-processing) ("as long as necessary"); no period is published. Zero data retention (ZDR) is available for enterprise customers on request | Abuse-monitoring logs are kept for 30 days. No application state is kept, apart from the prompt cache. ZDR is available to eligible organizations. Regional processing in the US and EU, and Private Link |

**Compared with today.** Today's decision step sends a system prompt that defines the three
labels, plus the records as JSON. It constrains the answer with a JSON schema
(`{"label": "allow" | "redact" | "drop"}`) and gets back one label with no probability. The
model may think first, which is why `max_tokens` is 4096, and output and thinking tokens are
billed. A decision model differs in four ways:

- **It returns a distribution.** Code decides how much risk to take, instead of the prompt
  ("when unsure between allow and redact, choose redact"). This is where thresholds come in.
- **The question is split into parts.** The instructions and the meaning of each label are
  separate fields, not one prompt. seshi fills the label fields itself (section 3).
- **It is cheaper and faster.** A full 100,000-character part is roughly 25–35k tokens. That
  costs about $0.0013 on Jev and $0.003 on OpenAI, with nothing billed for output.
- **It does no extended reasoning.** Both vendors say these models suit "gut-check"
  judgments, and that broad judgments should be split into narrow ones.

Jev's [jaggedness page](https://docs.typesafe.ai/model-jaggedness) lists failure modes that
matter for coding-agent sessions:

- It reads instructions literally.
- Accuracy falls when the state is large and mostly irrelevant.
- **Adversarial content in the state "can move the answer"**: a session can contain text that
  argues for its own classification.
- Choice option order can matter.

The LLM decision step faces the same prompt-injection risk. The eval needs a fixture for it
either way (section 5).

## 2. Where they fit

**Decision step only.** Neither API can return findings (record, field, exact text,
category), because neither generates text. So the redactor stays an LLM on `complete()`.

**`complete()` is the wrong interface.** `CompletionRequest` is `{system, user, schema,
schemaName, maxTokens}`: a prompt and a schema to fill. A decision model needs instructions,
named labels with descriptions, and the content, and it answers with probabilities. Forcing it
through `complete()` would mean parsing seshi's schema back into questions and throwing away
the probabilities. The smallest seam is a second interface, used only by the decision step:

```ts
// packages/ts/review/src/provider.ts
export interface DecisionRequest {
  instructions: string; // the policy's prompt, with seshi's data note
  records: Entry[]; // one part, as partsOf() makes it today
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface DecisionAnswer {
  probabilities?: Readonly<Record<Label, number>>; // absent for an LLM
  label?: Label; // an LLM's own label; absent when probabilities are given
  model?: string; // the version that answered, when the provider says
}

export interface DecisionProvider {
  readonly kind: string;
  readonly model: string;
  readonly endpoint: string;
  decide(request: DecisionRequest): Promise<DecisionAnswer>;
}
```

- **`LlmDecision`** wraps any `ModelProvider`. It builds today's `decisionSystem(prompt)`,
  `recordsMessage(part)` and `DECISION_SCHEMA`, and runs `checkLabel`. An LLM policy behaves
  and hashes exactly as it does now. `thresholds` is refused on LLM providers: they return no
  probabilities.
- **`OpenAiDecisions`** and **`TypeSafe`** use the vendors' SDKs (`openai`,
  `@typesafe-ai/sdk`), configured as in section 4. They send one `choice` question named
  `label`, with the three labels in a fixed order (allow, redact, drop) and seshi's own
  description of each (`LABEL_DESCRIPTIONS` in `prompts.ts`, section 3).
  - **Jev:** `state` is `{records: [...]}` as a JSON object, Jev's native form.
  - **OpenAI:** `input` is one user message whose `input_text` is `recordsMessage(part)`. Its
    `input_json` part caps at 256 KiB and 10,000 values, which a large part can pass.
- **`ModelReviewer.call`** calls `decide()` for the decision step and `complete()` for the
  redactor. Thresholds are applied in the reviewer (`labelOf(answer, thresholds)`), not in each
  provider, so they mean the same thing for both.
- **Unchanged:** retries, backoff and `on_failure`. Providers throw `ProviderError` with the
  same codes as today. New mappings:
  - A refusal (OpenAI's `refusal` answer) is `refusal`, not retried.
  - Jev's `529` is `http_529`, retried like any status of 500 or above.
  - Jev's `400` with `max_tokens_exceeded` becomes a new code, `too_long`, not retried.
  - Anything other than one well-formed answer for `label` is `invalid_answer`, retried.

**`max_input_chars` and splitting.** Splitting stays as it is. One `drop` drops the upload,
and only parts labelled `redact` reach the redactor. Jev's 32k tokens per question is below
what a 100,000-character part of JSON-escaped code can reach. Two options:

- Use a provider default of **60,000** for `typesafe` (to be measured: see open questions).
- Have `seshi config check` refuse a larger `max_input_chars` on `typesafe`.

Smaller parts also help Jev's accuracy, and cost about the same, since only input tokens are
billed. OpenAI needs no change.

## 3. Config

Two new `provider` values, valid on `decision` only:

- **`typesafe`** (the model is Jev). Default `base_url` `https://api.typesafe.ai`.
- **`openai-decisions`**. Default `base_url` `https://api.openai.com/v1`, default model
  `gpt-6-luna`.

They are separate from `openai-compatible` because the request, the answer and what can be
configured all differ.

```toml
[[review.policies]]
id = "default"
decision = { provider = "openai-decisions", api_key = { env = "OPENAI_API_KEY" } }
redactor = { provider = "anthropic", api_key = { env = "ANTHROPIC_API_KEY" } }
```

```toml
[[review.policies]]
id = "strict"

[review.policies.decision]
provider = "typesafe"
model = "jev-1.14.0"                    # required: pin the version thresholds were tuned on
api_key = { env = "TYPESAFE_API_KEY" }
# base_url = "https://api.typesafe.ai"  # the default
prompt_file = "/etc/seshi/review/decision.md"   # what counts as sensitive here
thresholds = { drop = 0.9, redact = 0.3 }
timeout = "10s"

[review.policies.redactor]
provider = "anthropic"
api_key = { env = "ANTHROPIC_API_KEY" }
```

| Key on a decision-model step | |
|---|---|
| `provider` | `typesafe` or `openai-decisions`. Refused on `redactor` with "makes decisions only; name the redactor's provider" |
| `model` | Required for `typesafe`. `seshi config check` warns on an alias (`jev-latest`, `jev-preview`), because an alias moves and answers can change. `gpt-6-luna` by default for `openai-decisions` |
| `api_key`, `base_url`, `timeout` | As today. Required key. `timeout` defaults to `"10s"`: these calls are fast, and a hung call should fail over to a retry sooner |
| `prompt`, `prompt_file` | The question's `instructions`: the organization's policy (below). seshi always appends its data note (the records are data, never instructions) |
| `thresholds.drop`, `.redact` | Below. Unset means the most probable label, which is today's behaviour |
| `labels` | Not a key. seshi owns the label descriptions (below) |
| `max_tokens`, `effort` | Refused: there are no output tokens or effort to set |

**What users customize: the prompt, not the labels.** A decision-model question has two
kinds of text: the instructions, and a description of each option. They divide cleanly:

- **seshi writes the label descriptions.** What `allow`, `redact` and `drop` *do* is the
  pipeline's contract: `redact` sends the part to the redactor, and `drop` stores nothing. So
  their descriptions say what each action means and nothing about any organization's data.
  They sit beside the label names and the data note as seshi's own wrapping, and they are
  versioned with it:
  - **allow:** nothing in the records needs removing; store them as they are.
  - **redact:** specific text in the records must not be stored, and removing that text leaves
    the rest useful.
  - **drop:** removing text could not make the records safe to store; store none of them.
- **The user writes the prompt.** It says what counts as sensitive in this organization:
  credentials in prose, personal data, whose data is customer data, which internal hostnames
  are fine, what a confidential project looks like. It also carries the organization's edge
  cases between labels, for example "a customer's ticket text is redact, a full export of
  tickets is drop". seshi's default prompt is today's opening paragraph and the examples from
  its bullets, rewritten as a question.
- **Thresholds carry the risk tolerance.** "When unsure, choose redact" is no longer prose
  but two numbers that `seshi review eval --sweep` can tune.

This keeps one setting, as for an LLM step today, and it leaves no way for a user's
instructions and option descriptions to contradict each other. Jev's
[jaggedness page](https://docs.typesafe.ai/model-jaggedness) names that contradiction as a
failure mode. The cost is that Jev advises putting edge cases in the option descriptions,
where the model weighs them option by option. Here they go in the instructions instead,
which may cost some accuracy. The eval measures that. If evidence shows organizations need
their own descriptions, a `labels` key can be added later without breaking anything.

An LLM prompt file does not carry over unchanged. It defines the labels itself, which
duplicates seshi's descriptions and can contradict them. Moving a policy to a decision model
means deleting the label definitions from the prompt and keeping the policy.

**The redactor no longer inherits.** Today a redactor that names no provider inherits the
decision step's. With a decision model, there is nothing for it to inherit, so the policy must
name the redactor's provider and key. That makes the smallest policy two lines instead of
one. That is the honest cost: two vendors see the text (one sees all of it, one sees only the
parts labelled `redact`), and `config check` already lists both.

**Mapping seshi's labels and categories.** The three labels map to one `choice` with options
`allow`, `redact` and `drop`. The redactor categories (`secret`, `personal`, `customer-data`)
do not need to reach the decision model at all: they are the redactor's to apply. A later
option (phase 4) asks one yes/no question per category plus one for "inseparable", and
derives the label in code. That follows both vendors' "decompose the judgment" advice, and
records which category triggered `redact`. It is a second request shape, so it waits for eval
evidence that it beats the single choice.

**Thresholds.** The vendors advise putting a threshold on the probability of the action you
will take, not on `confidence`. Jev's [confidence page](https://docs.typesafe.ai/confidence)
says so directly, and OpenAI says to "set thresholds ... based on the cost of false
positives and false negatives". For one part with probabilities `p`:

1. **Drop.** When `thresholds.drop` is set, drop only if `p.drop >= drop`. A drop below the
   threshold becomes **redact**, never allow: "drop only above 0.9, otherwise redact".
2. **Redact.** When `thresholds.redact` is set, redact if `p.redact + p.drop >= redact`
   (the chance that something needs removing), else allow.
3. **Unset.** A threshold that is not set falls back to the most probable label.

Both thresholds are in `(0, 1]` and refused on LLM providers. This moves "when unsure,
redact" out of the prompt and into code, where `seshi review eval` can measure it.

**The policy hash.** Nothing lives at the provider, so the hash stays local and complete. For a
decision-model step it covers the same fields as now: provider, model, base_url, prompt and
timeout. It adds the thresholds, and the wrapper version, which covers seshi's label
descriptions, its data note and the question shape. `thresholds` enter the identity only when
set, so every existing policy keeps its hash. The configured model is hashed. The
version that actually answered (Jev returns it even for an alias) goes in the review record
instead (below), because it is not config.

**What the review record gains** at `owners/<o>/sessions/<a>/review/<n>.json`, and in the drop
record:

- `decision_model` names the version that answered when the provider reports one
  (`typesafe/jev-1.14.0`), not the alias that was sent.
- `scores`: each part's `{allow, redact, drop}` probabilities, in part order, up to the part
  that decided.

These are numbers, not text, so the record still holds "labels and findings, never text".
`GET /v1/sessions/:agent/:session_id/reviews` gives admins the scores and readers only the
label, as it does today.

## 4. Guarantees seshi must keep

Both SDKs fall back to environment variables only for options left unset, so seshi sets
every one of them explicitly, as `anthropic.ts` does for Anthropic's SDK.

| Guarantee ([model-review.md](../model-review.md)) | Jev (`@typesafe-ai/sdk`) | OpenAI Decisions (`openai`) |
|---|---|---|
| Only record text leaves, and only to the configured endpoint | Kept. seshi sends the same entries an LLM gets, and never sends `assets` or the `TypeSafe-Danger-Zone-*` headers, so no image placeholder is ever expanded | Kept. seshi never sends `input_image` (a URL there is fetched by OpenAI), `safety_identifier` (an id) or `prompt_cache_key` |
| No implicit environment keys; redirects refused | Kept. Set `apiKey`, `baseURL` and `defaultModel`, so `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL` and `TYPESAFE_DEFAULT_MODEL` are never read. The SDK has no fetch options, so pass a `fetch` that sets `redirect: "error"` | Kept. Set `apiKey` and `baseURL`, and `organization: null` and `project: null` (else `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` become headers). Set `fetchOptions: { redirect: "error" }` |
| The SDK's own retries off (the reviewer's retries are F3.4's) | `retry: { maxRetries: 0 }` | `maxRetries: 0` |
| The client never logs requests | `logLevel: "off"`. Otherwise `TYPESAFE_LOG_LEVEL=debug` logs request bodies, which "are not" redacted | `logLevel: "off"`, so `OPENAI_LOG` is never read |
| Provider error text never logged | Kept. The SDK's error messages carry the provider's text, so errors are mapped to codes from their class and status only, as `mapError` in `anthropic.ts` does. This matters here: a `422` body echoes "a text preview of the rejected input". `max_tokens_exceeded` is read from the error to set the code, and never recorded | Kept the same way. A `refusal` answer carries no text |
| Review record stores labels and findings, never text | Kept. Probabilities are added, never text | Kept |

**Prompt caching (OpenAI).** Caching is on by default: OpenAI places a cache breakpoint at
the end of the shared `input`, which is the records, whenever they reach 1,024 tokens. That
stores the records as cache state on OpenAI's GPUs until the cache expires: `ttl` is 30
minutes, and data controls says it is gone within 24 hours. It also bills a cache write
($0.125/M) above the normal input rate, for a prefix that is never reused. seshi should send
`prompt_cache_options: {mode: "explicit"}` with no breakpoints, which turns caching off.

**Retention and training are the user's contract.** seshi assumes users have contracts with
the providers they choose, as it already does for Anthropic and OpenAI-compatible endpoints.
Retention, training and residency terms come from that contract, not from seshi. seshi's part
is unchanged: only record text, only to the endpoint configured, and `seshi config check`
names that endpoint. For reference, the published defaults:

- **OpenAI:** abuse-monitoring logs kept 30 days, no training, ZDR for eligible
  organizations, regional processing in the US and EU.
- **TypeSafe:** no training on input. Retention follows its DPA. ZDR is offered to enterprise
  customers.

Neither decision model runs locally. Users who must keep transcripts in-house stay on a local
model through `openai-compatible`.

**Serverless mode.**

- Laptops need the decision key too, through `seshi review key set typesafe` or
  `seshi review key set openai-decisions`, alongside the redactor's key.
- The shared-config rule still applies: a policy in `config/seshi.toml` that carries a key may
  not name a `base_url` other than its provider's own.

## 5. Evaluation and calibration

**`seshi review eval` measures these providers as is.** It builds a reviewer from the policy
and runs labelled fixtures through the real providers. Once the decision step goes through
`decide()`, label accuracy, false and missed drops, redactor recall and leaks all work
unchanged. It needs four additions:

- Each fixture's probabilities in the report.
- Latency per call (median and p95), and tokens and cost, since these providers are chosen
  for speed and price.
- **A threshold sweep** (`--sweep`): from the probabilities it already has, recompute the
  labels at each pair of thresholds, with no new calls. Report the pairs with zero missed
  drops and zero leaks, and the fewest false drops. This is how an operator sets
  `thresholds`.
- Fixtures that test the risks above: a record that argues for its own label (injection), and
  each fixture with its records reordered.

**The built-in fixtures are too few to calibrate.** There are ten (3 allow, 5 redact,
2 drop), enough to catch a broken policy but not to pick a threshold. A threshold sweep needs
an operator's own few hundred labelled fixtures (`--fixtures <dir>`). seshi can help build
them without text leaving the server:

- **`seshi review fixture add <agent> <session> --records a..b --label redact`** writes a
  slice of a stored session as a local fixture file for the operator to label. Stored text has
  already been redacted, so these fixtures are good for false-positive cases (allow, redact)
  but under-represent leaks. Leak fixtures still have to be written by hand, as the built-ins
  were.
- **Export past decisions, without text** (`seshi review export`). This exports `policy_hash`,
  `decision_model`, label, per-part `scores`, finding categories and counts, plus what
  happened afterwards (retracted, deleted). It shows how labels and scores are distributed on
  real traffic, and how many writes a threshold change would flip. It gives no ground truth,
  because it has no text to label.

**Training a provider: not possible, and not needed.** Neither provider offers per-account
training: Jev serves every account the same weights, and `gpt-6-luna` lists fine-tuning as
unsupported. Calibration therefore happens in seshi. The user tunes the prompt and the
thresholds, both local config, covered by the hash and measured by eval. seshi tunes its own
label descriptions and the part size, versioned in the wrapper.
**seshi should not build a way to send session text to a vendor for training.** If a vendor
asks for labelled data, the operator's fixtures are files the operator owns and can share
under their own agreement.

## 6. Recommendation, open questions and plan

**Recommendation.** Build the `decide()` seam with thresholds and recorded scores, then
**OpenAI Decisions**, then **Jev**. The two APIs are nearly the same shape (one choice,
probabilities, no text), so most of the work is the seam, not the providers. OpenAI goes
first, narrowly:

- Its context fits seshi's default part size, so the first eval isolates the model: same
  parts, same fixtures, LLM against decision model.
- It is generally available, with one model to target.

Jev follows as a small change. It is cheaper per token, publishes latency figures, and
documents its calibration. The order can swap if the first users want Jev; the seam is the
same either way.

**Open questions**

1. **Prompt injection.** How well each model resists records that argue for their own label.
   TypeSafe's guidance is "test edge cases"; the eval's injection fixture should measure both.
2. **Jev's part size.** How many tokens a 100,000-character part of JSON-escaped session text
   comes to, and so what `max_input_chars` default fits 32k per question. Measure on the
   built-in fixtures.
3. **Rate limits.** Whether OpenAI's `/v1/decisions` shares the `gpt-6-luna` tier limits.
   Jev's limits are only visible in its console.
4. **Default thresholds.** Should seshi ship with thresholds set, for example
   `{drop = 0.9, redact = 0.3}`, or with none (the most probable label, today's behaviour)
   until an operator runs a sweep? This page leans to none, because a number nobody measured
   looks calibrated when it isn't.
5. **Mixed versions.** Should the record keep a served model per part? With an alias, the
   parts of one upload could in principle be answered by two versions. Pinning makes this
   moot, which is why `typesafe` requires a model.
6. **Edge cases in the prompt.** Do organization-specific edge cases between labels work as
   well in the instructions as they would in the option descriptions? If not, add a `labels`
   key.
7. **Category questions (phase 4).** Do per-category yes/no questions beat one choice on
   operators' fixtures, and should the categories that triggered `redact` narrow what the
   redactor is asked to look for?

**Plan** (S = up to a day, M = two to four days)

| Phase | Work | Size |
|---|---|---|
| 0 | Get keys for both. No code | S |
| 1 | The seam: `DecisionProvider`, the `LlmDecision` adapter, seshi's label descriptions and default decision-model prompt, `thresholds` in the schema and the hash (existing hashes unchanged), `scores` and the served model in the review and drop records, the eval's probabilities, latency, cost and `--sweep`, the new fixtures. No behaviour change for existing policies | M |
| 2 | `openai-decisions`: the `openai` SDK client (section 4), caching off, refusal and status mapping, fake-fetch tests, `config check` output, serverless key name, [config.md](../config.md#review) and [model-review.md](../model-review.md) | S–M |
| 3 | `typesafe`: the `@typesafe-ai/sdk` client (section 4), `too_long`, the part-size default from open question 2, required pinned `model` and the alias warning, tests, docs | S |
| 4 | Optional, on evidence: per-category questions, `seshi review fixture add`, `seshi review export` | M |
