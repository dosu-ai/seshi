# Codex notify payloads

Hand-written from Codex's documented `notify` program contract: Codex runs the configured
program after each turn with one JSON argument (not on stdin), of `type` `agent-turn-complete`
with `thread-id`, `turn-id`, `cwd`, `input-messages` and `last-assistant-message`.
`notify-other.json` is a notification of another type, which seshi ignores. Not recorded from a
live Codex: ids and text are made up.
