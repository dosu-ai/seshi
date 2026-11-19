# Redaction goldens

Each folder is one case: operator rule packs in `packs/` (applied in file-name order; none
means the built-in pack alone), an input, and `expected.json`, what the rules made of it.

- `input.records.json`: normalized records, redacted as the pipeline's redaction stage does
  (`ruleRedactor`).
- `input.jsonl` / `input.json`: a native transcript, redacted as the uploader's pre-redaction
  does (`redactTranscript`, F2.4).

`tests/redact/goldens.test.ts` checks every case, and that the output redacts to itself with
nothing counted. `bun run goldens` rewrites `expected.json`; review the diff, since it is a
change in what the rules do. The cases are written by hand. The credentials in them are
made up, in the shapes the rules look for; none is real.
