# 07 · Redaction rules (F2)

Branch `seshi-07-redaction-rules`, on `seshi-06-instance`. Redaction rules are now TOML rule
packs: a built-in pack shipped in the repository and the operator's packs from `[redaction]
packs`, parsed and validated by one parser and one validator, compiled into one `RuleSet`.
Operator patterns run under RE2. Every stored session records the rule-set hash and counts by
rule id. The same code redacts a native transcript for the uploader's pre-redaction, a route
serves the org's packs to clients, and `seshi redact test|backfill` replace the stub.
Reference for operators: [docs/redaction.md](../../redaction.md).

## What was built

- **Rule packs (F2.1)**, `packages/ts/redact/src/pack.ts`.
  - A pack has top-level `id`, `version`, `description` and `disable` (built-in rule ids to turn
    off), and three lists:
    - `[[rules]]`: text rules with `id`, `description`, `pattern` or `patterns`,
      `replacement` (default `[redacted:<id>]`), `applies_to` (`text`, `tool_input`,
      `tool_output`; default all three) and `tests.match` / `tests.no_match`;
    - `[[sensitive_files]]`: `id`, `globs` (`.gitignore` style, `!` for an exception), `tests`;
    - `[[secret_commands]]`: `id`, `pattern(s)`, `tests`.
  - `validatePack(value, {source, builtin})` is the one validator. It takes parsed TOML, a
    converted JSON rule file, or the JSON a server sent. It reports every problem with its
    field (`acme.toml: rules[2].applies_to: …`), checks unknown keys, id syntax (lowercase words
    joined by `-`, up to 64), unique rule ids across the three kinds, and size caps (pattern
    4096, replacement 256, 1000 rules per list, 100 tests per rule). It does not compile
    patterns; the rule set does, because the engine depends on the pack.
  - `parsePackToml` uses `Bun.TOML.parse` and reports the line and column of a syntax error.
  - Today's JSON rule file loads as a pack (`readLegacyRules`, `legacyPack`). Every JSON file
    is merged into one pack, `legacy`:
    - its `patterns` become one text rule, `custom-pattern`, so they count and mark as
      before;
    - its files and commands become `custom-sensitive-files` and `custom-secret-commands`;
    - Dosu's `excluded`, `names_only` and `fetched_at` are ignored, as before.
  - `loadPacks(files)` returns `{pack, source}` in config order, the legacy pack where the
    first JSON file was listed.
- **The built-in pack**, `packages/ts/redact/packs/builtin.toml`, version `seshi/rules/3`.
  - The 25 secret rules from `secrets.ts` are listed by id (`private-key`, `credential`,
    `github-token`, …, `entropy`) as `implementation = "builtin"`: reviewed JavaScript, kept
    in code, as F2.2 allows. Each has a description and test strings.
  - The sensitive-file globs (rule `sensitive-file`) and secret commands (rule
    `secret-output`) are data in the TOML. `BUILTIN_SENSITIVE_FILES` and
    `BUILTIN_SECRET_COMMANDS` are gone; `builtinSensitiveFiles()` and `builtinSecretCommands()`
    read the pack.
  - `bun run packs` (`scripts/builtin-pack.ts`) writes `src/generated/builtin-pack.ts`, which
    holds the TOML's exact text, so the binary needs no file at run time.
    `scripts/builtin-pack.test.ts` fails when the generated file is stale.
  - Test strings that look like provider tokens spell their first character as a `\u` escape,
    so secret scanners do not flag the file. A test checks this.
  - `builtinPack()` parses the pack with the same validator, when a rule set is built (about
    0.25 ms), never at import.
- **RE2 for operator patterns (F2.2)**, `matcher.ts`.
  - Engine: `re2js` 2.10.0, pinned, pure JavaScript (a port of RE2/J), MIT. It loads under Bun
    and inside the compiled binary. `scripts/build-binary.test.ts` now runs an operator pack
    in the binary and checks that a backreference is refused there.
  - `compilePattern(source, "re2" | "js", {anchored})` gives one `PatternMatcher`: every
    non-empty match and the span of a `secret` group, in UTF-16 indices on both engines.
  - It refuses a pattern that does not compile, saying why: "RE2 has no lookahead or
    lookbehind" or "no backreferences". It also refuses one that matches empty text and one
    whose RE2 program is over 20,000 (`MAX_PROGRAM_SIZE`).
  - Every operator pattern is RE2: text rules, secret commands, and JSON rule files'
    patterns. Built-in rules stay JavaScript.
  - Sensitive-file globs (built-in and operator) are not regular expressions at all: since 17,
    `sensitive.ts` matches each with a linear state-set matcher (Thompson's construction), so a
    test takes time proportional to the path times the glob. They used to compile to a
    backtracking JavaScript `RegExp`, which an operator's `**/deploy/**/*.secret` and 14 KB of
    `deploy/` in a tool call's path held for about 21 s.
- **Rule set**, `ruleset.ts`. `compileRuleSet({packs, builtin?, runTests?, sources?})` checks
  what spans packs:
  - the built-in pack and `secrets.ts` implement the same ids;
  - pack ids and rule ids are unique (an operator rule cannot reuse a built-in id);
  - `disable` names only built-in rules;
  - every pattern compiles on its engine;
  - no text rule changes any rule's replacement, and no replacement looks like a secret to
    the built-ins, so redacting twice changes nothing;
  - with `runTests`, every operator rule passes its own test strings.
  It throws `RuleSetError` (a `RulePackError`) naming every problem, with the file when
  `sources` is given (`acme.toml (pack acme): acme-key: …`).
  - `RuleSet.hash` is sha256 of canonical JSON over what the rules do: ids, patterns,
    replacements, `applies_to`, globs, `disable`, order, and the built-in version and
    behaviour. Descriptions and tests are left out, so editing them does not make stored
    sessions look stale to backfill.
  - `RuleSet.redactString(text, field, counts)` runs the text rules that apply to `field` in
    order, then the built-in secrets minus the disabled ones. `"anywhere"` runs every text
    rule.
  - A region that already is a marker (`[redacted:…]`) or the rule's own replacement is left
    alone and not counted.
  - `RuleSet.withholdingRule(input, kind)` names the file or command rule a withheld call met.
  - `catalogue` lists every rule with its pack, engine (`re2`, `js`, `code`, `glob`), and
    whether it is on and what turned it off.
  - `runRuleTests(set)` checks each test string against its rule alone.
- **Records**, `redactor.ts`. `ruleRedactor(rules)` keeps 04's `Redactor` contract:
  deterministic, idempotent, carried withheld ids, counts. Strings are classified by where
  they sit: a tool record's are `tool_output`, an assistant's `tool_calls` are `tool_input`,
  everything else is `text`. A withheld call counts under the rule that matched
  (`acme-master` and not just `sensitive-file`). The new optional `redactText(text, field)`
  redacts one string outside the records.
- **Every stored session gets `metadata.redaction`.** 04 already passed each write's summary to
  `ingest`. The new pipeline test checks that a session with no matches records
  `{rule_set, counts: {}}`, that a chunk's counts are added, and that the hash is the rule
  set's. A JSON rule file's patterns still count as `custom-pattern`.
- **The Instance holds the rule set.** `buildInstance` reads `[redaction] packs` (TOML packs and
  JSON files), compiles them with `runTests: true`, and names the file in any error.
  - `Instance.redaction` is always a `RuleSet`: the built-in pack alone when there are no
    packs, and when a test builds an Instance without one.
  - `serve`'s banner names the packs, the built-in version and the rule set.
  - `seshi config check` loads the packs the same way and reports the same problems.
- **Client pre-redaction (F2.4)**, `transcript.ts`.
  `redactTranscript(rules, transcript, format, carried)` runs over a native transcript: the
  sensitive-call pass, then every string through `redactString(…, "anywhere")`.
  - A string's place is unknown before normalizing, so a text rule runs on every string
    there. That can only take out more than the server would.
  - Identifier and framing keys are skipped (`id`, `uuid`, `tool_use_id`, `call_id`,
    `toolCallId`, `sessionId`, `type`, `role`, `timestamp`, …), so tool results still link to
    their calls and the entropy rule does not eat long ids.
  - A line keeps its exact bytes when nothing in it changed. It returns
    `{text, withheld, summary}`.
  - `redactSensitive` gained a listener (`WithholdListener`), so calls are counted by rule id
    here too.
- **`GET /v1/redaction/rules`** (`packages/ts/api`): `rulesDocument(instance.redaction)`, a
  `seshi/redaction-rules/1` document `{rule_set, builtin, packs}`. It goes to any signed-in
  caller, a write-only device token included. The packs are not public (F2.4 Access).
  - `ETag` is the rule-set hash; `If-None-Match` gets 304.
  - `HttpSessionDB.redactionRules()` fetches it. `ruleSetFromDocument(doc)` validates the
    packs again with the one validator and compiles them on the client's own built-in pack.
    It returns `{rules, same}`, where `same` says whether the client's hash equals the
    server's.
  - `openapi.yaml` gains the path, a `redaction` tag, and the schemas `RedactionRules`,
    `RulePack`, `RuleId` and `RuleTests`. The openapi test covers 200, 304 and 401.
- **Backfill (F2.5)**, `packages/ts/pipeline/src/backfill.ts`, `backfillRedaction({store,
  redactor, writer, since?, owners?, dryRun?, limit?, signal?, onSession?})`. It looks at each
  stored session whose `redaction.rule_set` is not the current one:
  - its traces (head and continuations) are joined into one record list and redacted;
  - **unchanged**: only the rule set and any newly withheld call ids are recorded (not
    `updated_at`), so a result that arrives later is still withheld;
  - **rewritten**: one new trace holds the whole session (LLM calls redacted too, a fork's
    `continuation` kept), the pointer moves to it (If-Match, guarded on the head and traces it
    read), counts are added, `applied` is cleared, a `published` change entry with `replace:
    true` and `reason: "redacted"` is written, and then every old trace object is deleted. When only fields outside the hash changed (a meta
    record's `cwd`), the hash stays the same and the object under it is replaced;
  - **conflict**: the session changed meanwhile, or a trace object is missing. It is left for
    the next run, and the orphaned new object is deleted;
  - **failed**: the joined traces do not make a valid trace. Nothing is written;
  - **skipped**: tombstoned, no trace, or not written since `since` (`updated_at`);
  - **current**: already redacted with this rule set.
  It is idempotent and resumable. The report has outcomes, counts by rule, the sessions
  rewritten, in conflict or failed, and `more` (stopped at the limit or by the signal).
- **`seshi redact`** (`apps/seshi/src/commands/redact.ts`), replacing the stub. Usage is in
  [docs/redaction.md](../../redaction.md#trying-and-applying-rules).
  - `test`: the rule set from the built-in pack, `--pack` files and (with `--config`) the
    server's packs. It runs every test string. On a file or stdin it reports counts per rule
    and where they fired: record numbers for a transcript (detected or `--agent`, normalized
    and redacted per record with carried withheld ids), line numbers for text (`--text`,
    `--field`). It never shows what matched. `--print` prints the redacted output. `--json`
    gives one document.
  - `backfill`: `--since <30d|time>` or `--all` (one is required, since it is irreversible),
    `--owner`, `--dry-run`, `--limit`, `--as <owner>`. Change entries are written by
    `{kind: "admin", principal: --as or "admin", source_id: "redaction"}`. It opens the
    Instance with `initialize: false`, so a mistyped bucket is refused, not claimed. SIGINT
    stops it between sessions. Exit 8 on conflicts or failures.
- **Goldens.**
  - The transcript goldens now go through the built-in rule set's redactor:
    `normalizeTranscript` uses `ruleRedactor(rules)`, with optional `rules` and the built-in
    pack by default. They came out byte for byte the same, so they keep pinning real
    redaction.
  - New pack goldens in `packages/ts/redact/testdata/redaction/<case>/`: `builtin-only`,
    `operator-pack`, `legacy-and-pack` (a JSON file and a TOML pack with a cross-pack
    exception) and `transcript-preredaction` (F2.4). They are hand-written (README there).
    `bun run goldens` writes each `expected.json`.
  - `tests/redact/goldens.test.ts` checks every case, that its output redacts to itself with
    no counts, and the hash.
- **Contract.** The `change.schema.json` description covers `reason: "redacted"` on a
  replacing publish. There is a conformance example, `change.backfilled.json`, and the
  generated `change.ts` is regenerated.
- **Docs.** server.md (rule packs, RE2, JSON as legacy, backfill, the route), cli.md (the
  commands, a "Redaction rules" section), config.md, SECURITY.md, README and layout.md. The
  `[redaction] packs` description is regenerated into `spec/config.schema.json`.

## Extension points for later branches

- **The rule set:** `instance.redaction` (a `RuleSet`). For records,
  `ruleRedactor(instance.redaction)`. For one string outside records, `redactor.redactText(text,
  field)` or `rules.redactString(text, field, counts)`. Never build a second rule set from
  config.
- **A new built-in rule:** implement it in `secrets.ts`, add its id to `BUILTIN_SECRET_KINDS`
  and a `[[rules]]` entry with `implementation = "builtin"`, a description and test strings in
  `packs/builtin.toml`, run `bun run packs`, and bump `version` (and
  `BUILTIN_RULES_VERSION`; a test ties them). A built-in glob or command is a TOML edit plus
  `bun run packs`.
- **Packs from elsewhere** (a client, an admin API later): `validatePack(value, {source})` then
  `compileRuleSet({packs})`. Never compile an operator pattern on the JS engine.
- **Pre-redaction (14):** `ruleSetFromDocument(await client.redactionRules())` once per run.
  Then, per transcript or chunk, `redactTranscript(rules, text, format, carried)`; keep the
  returned `withheld` with the spool entry for the next chunk.
- **Reading counts:** `metadata.redaction.counts` keys are rule ids, which `RuleSet.catalogue`
  describes.

## Cross-branch wiring once the stack is linear

- **14 (capture):**
  - Wire pre-redaction into the uploader as above. Import `@seshi/redact` lazily from the
    hook path: it costs about 11 ms to import (re2js included), measured against the 250 ms
    hook budget.
  - Cache the rules document. The client sends no `If-None-Match` yet; the route supports it,
    so add the header to `HttpSessionDB` if polling matters.
  - Use `redactTranscript`, not `redactRaw`: `redactRaw` (kept for compatibility) still
    redacts ids, which can break the server's call/result linkage.
  - **Offsets.** The server counts the bytes it receives (`normalized.bytes` is offset plus the
    redacted chunk's length). Pre-redaction changes line lengths, so the uploader must keep two
    positions per session: where it has read to in the local file, and the redacted bytes it
    has sent (the `offset` it sends). Redaction is per line and deterministic, so the redacted
    position can be rebuilt by re-redacting the lines already sent. Redact and send only
    complete lines: a partial JSON line is redacted as plain text.
  - A rules change between two whole uploads of one session makes the second a 409
    `conflict`; resend with `replace`. A backfill does the same to the next whole upload.
- **09 (OTLP):** nothing required for redaction. `publishAssembled` redacts the records (in
  `whole`) and, since the review fixes, the LLM calls' `error` and string `parameters` (in
  `commit`, `redactLlmCalls`), counting both in `metadata.redaction`. An assembler that wants
  span attributes redacted before they sit in the span store can use
  `ruleRedactor(instance.redaction).redactText`.
- **12 (search):** a `published` entry with `replace: true` (with or without `reason:
  "redacted"`) means drop everything indexed for the session and index the new trace. A
  backfill also deletes the old trace objects, so an indexer that fetches late gets 404 for
  them and must use the entry's `content_hash`.
- **08 (review):** nothing to wire. Review sees regex-redacted records as before, and backfill
  re-redacts the stored, reviewed trace, so review redactions stay.
- **13 (CLI):** `HttpSessionDB.redactionRules()` was added to `packages/ts/client/src/http.ts`;
  keep it when merging 13's client changes. `seshi redact` runs where the server config is;
  13 may add a remote `redact test` that fetches the rules through the client.
- **Shared files touched**, all additive:
  - `spec/openapi.yaml`: a path, a tag, four schemas;
  - `tests/api/openapi.test.ts`: the route list, one test, and a `headers` option on
    `call()`;
  - `commands.test.ts`: `redact` removed from the stub list;
  - `package.json`: the `packs` script;
  - `tests/tooling/write-goldens.ts`: a loop at the end;
  - `packages/ts/api/package.json`: depends on `@seshi/redact`;
  - `serve.ts`: the banner line;
  - `config/server/redaction.ts`: the description only.
  `COMMANDS` is unchanged (the summary already fit).

## Review fixes (after the first implementation)

- **LLM calls were stored unredacted.** Only records went through the rule set; an assembled
  session's `llm_calls` (`error`, string `parameters`) were written as given, against X4.3.
  `redactLlmCalls(redactor, calls)` (`@seshi/redact`) runs them through `redactText`; the
  pipeline's `commit` applies it and adds the counts, and backfill applies it to stored calls.
- **Backfill dropped a fork's continuation.** A fork's first trace continues its parent's copied
  history (`from_record`, `prefix_sha256`). Backfill stripped it, so the rewritten trace either
  failed the conversation check (`failed`) or claimed to be a whole session that starts
  mid-conversation, with a content hash that no longer had `@from_record`. It is now kept on the
  trace, the pointer's trace ref and the change entry. Its `prefix_sha256` still describes the
  parent's prefix as the old rules redacted it (see Still to check).
- **A chunk racing a backfill re-wrote the old meta record.** The chunk's guard checked only the
  log position, which a backfill does not move, so a chunk planned before the backfill wrote the
  meta record of the old head (unredacted by the new rules, e.g. its `cwd`). The guard now plans
  again when the head or the rule set changed, and a head trace that vanished because the
  session moved plans again instead of writing a continuation with no meta record.
- **Backfill order and `updated_at`.** The change entry is appended before the old trace objects
  are deleted, so a stopped run leaves orphans at worst, never a rewritten session no reader was
  told of (the next run would find it current). Those orphans hold what the new rules take out
  and no later run deletes them; since 17 the trace routes and `getTrace` serve only a hash the
  session's `traces` name, so no reader gets them (deleting them is in 17's not-fixed list). A
  session with nothing new to take out keeps
  its `updated_at`: only the rule set is recorded.
- **Pre-redaction left fewer keys alone than the server.** `gitBranch`, `git_branch` and
  `source` are now structural in `redactTranscript`, as in the record redaction. Since 17 the
  skip stops at a tool call's input: the server redacts a call's `args` as one string, so
  `redactTranscript` serializes an input object, redacts it whole and reads it back (each
  string on its own, none exempt, when the result does not parse). An input's own `name`,
  `type` or `source`, and a value a rule finds only with its key, used to reach the server.
- **A client refused a newer server's rules.** `ruleSetFromDocument` threw when a pack disabled
  a built-in rule the client's (older) built-in pack lacks. Such disables are dropped on the
  client; `same` still reports the difference.
- Tests: fork continuation, a chunk continuing a backfilled session, a chunk racing a backfill,
  LLM calls in the pipeline and in backfill, `updated_at`, and the version-skew disable.

## Deviations and why

1. **The default replacement is `[redacted:<id>]`, not `[REDACTED:<id>]`.** Every stored
   trace, golden, client and test already uses the lowercase marker. Changing its case would
   change content hashes for the same conversation and turn every marker an earlier rule set
   left into text the new rules redact again. That breaks backfill idempotence and makes whole
   uploads conflict. The decision's capitalization reads as notation.
2. **Built-in secret rules stay in code**, listed in the TOML pack by id (`implementation =
   "builtin"`) with descriptions and test strings. F2.2 allows reviewed JavaScript for
   built-ins. Their passes depend on substring hints, sub-kind classification, quote-aware
   submatches, ordering and the entropy pass, which a list of patterns cannot express without
   changing what they match. Globs and commands, which are plain data, live in the TOML.
   "Reviewed" includes time: since 17, the `sk-` key and URL-credential rules find their
   matches in code (the same matches, linear time) instead of through expressions that
   backtracked quadratically on crafted strings, and `secrets.test.ts` times adversarial
   inputs for them as it already did for `jwt`.
3. **Built-in globs and commands are one rule each** (`sensitive-file`, `secret-output`), so
   existing counts stay the same. Turning one off turns off the whole list; to allow one file,
   use an exception glob in your own pack (`!.npmrc`), which holds across packs.
4. **Backfill is a one-shot command, not a worker job.** F2.5 names `seshi redact backfill
   --since 30d`, and the task allows "and/or". Rewriting stored traces is irreversible, and
   running it automatically on every restart with new packs would surprise operators. It is
   idempotent and resumable (sessions already current are skipped), so cron can run it
   (X7.1).
5. **Backfill joins a session's traces into one** and writes `replace: true` with `reason:
   "redacted"`, rather than rewriting each continuation. A replacing entry is the only change
   entry that tells readers to drop what they held (X4.6), and F2.5 wants the old objects
   deleted. `normalized` is left as it was (see Still to check).
6. **`reason: "redacted"` on a `published` entry.** The schema's `reason` enum already had the
   value and no per-kind restriction, so only the description changed (no type change).
7. **`GET /v1/redaction/rules` needs only a valid credential, not a scope.** The uploader's
   device token is write-only, and F2.4 says "signed-in clients".
8. **JSON rule files' patterns now run under RE2.** A Dosu-written pattern that used lookaround
   or a backreference used to load, and now stops start-up with a message saying why. F2.2
   puts every operator pattern on RE2.
9. **A built-in match whose secret is already a marker no longer counts.**
   `user:[redacted:url-credentials]@host` used to count `url-credentials` again on every
   re-redaction. The text was always unchanged; only counts change, so the built-in version
   was not bumped for this.
10. **The rule-set hash changed for every deployment.** The version is now `seshi/rules/3` and
    the hash covers packs. So the first `seshi redact backfill --all` looks at every session.
    Most come out `unchanged`, a metadata write only.

## Still to check

- **RE2 speed on large sessions.** Measured locally on a 6.9 MB record set: 116 ms with the
  built-in pack, 277 ms with five RE2 text rules on top. That is about 30 ms per RE2 rule per
  7 MB, roughly 40 to 60 times slower than V8 RegExp for the same pattern. A pack with dozens
  of rules adds seconds per large upload. A prefilter (literal prefixes) would help if that
  becomes real.
- **Backfill and the uploader's log state.** `normalized.prefix_sha256` describes the records
  as the old rules left them, so the next whole upload of a backfilled session is a 409
  `conflict` until the uploader resends with `replace` (14). Recomputing it from the
  backfilled trace would be wrong whenever model review changed records or an envelope was
  dropped, so it is left alone. Chunks continue normally.
- **A server still running old rules during a backfill** writes new sessions with the old rule
  set. Those sessions keep the old `rule_set` and are picked up by the next backfill. The docs
  say to restart with the new packs first. Resolved for the opposite order in 17: a chunk
  written under the new rules onto a session stored under the old ones used to give the whole
  session the new `rule_set`, so the backfill called it `current` and left the old head as it
  was. Each `traces[]` entry now records its own `rule_set`, and a session is current only when
  every trace was written under the current rules.
- **Backfill on a large bucket** lists every owner and reads every session's metadata, with no
  index and no saved progress beyond the per-session rule set. `--since` narrows the sessions
  it rewrites, not the listing.
- **Model-review findings** (`review/<n>.json`) name records by index. Backfill keeps the record
  count and order, so they still line up, but nothing checks it.
- **A fork's continuation after a backfill.** The kept `continuation.prefix_sha256` describes
  the parent's prefix as the old rules redacted it; once the parent is backfilled too, a reader
  that checks the fork's prefix against the parent's stored records finds a mismatch. Nothing in
  the stack checks it today; a reader that does should fall back to `from_record` alone.
- **In-place replacement.** When the new rules change only what the content hash leaves out
  (a meta record's `cwd`), the object under the same hash is replaced. Readers that cache trace
  objects by hash forever must honour the `replace` change entry and fetch again.
- **The applies_to classification** treats a `reasoning` or `observation` record as `text` and
  a meta record's strings as `text`. Revisit if operators need finer places.
- CI has not run (no PR).
