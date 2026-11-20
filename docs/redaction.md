# Redaction

seshi redacts every session before anything is written, and there is no switch to turn it off.
The server runs the rules on the normalized records of every upload, poll and span; the capture
uploader runs the same rules on the laptop before a byte leaves it
([capture.md](capture.md#redacting-before-upload-f24)), and the server redacts everything again
regardless. The raw transcript is never stored (X6.3), so the redacted trace is the only copy.

Rules come in rule packs: a built-in pack that ships in the binary, and packs of your own. This
page covers what the rules do, how to write a pack, how to try one, and how to apply new rules to
sessions already stored. For what regular expressions cannot catch (a password in prose,
personal data), add [model review](model-review.md).

## Rule packs

Redaction rules are rule packs (F2.1): the built-in pack, which ships in the binary
([`packages/ts/redact/packs/builtin.toml`](../packages/ts/redact/packs/builtin.toml)), and
your own, listed in `redaction.packs`. Every session's normalized records go through them
before anything is written, in this order. They run on the records, where tool calls, file
paths and results are already separate fields; the transcript itself is never stored.

1. **Sensitive tool calls.** When a call reads or writes a secrets file (`.env`, a private key,
   `~/.aws/credentials`, Terraform state and the like) or runs a command whose job is to print a
   secret (`printenv`, `gh auth token`, `kubectl get secret`, `aws configure get`, `vault kv get`,
   `op read`, …), the call is kept and its result becomes `[redacted:sensitive-file]` or
   `[redacted:secret-output]`, marked `withheld` in the trace. A file call's input keeps only
   what names the file. A file is recognized by a call's path arguments, a shell command's
   words, or a patch's file headers, not by text that only mentions it. A result in a later chunk
   than its call is caught too: the session's `metadata.json` keeps the withheld calls' ids.
2. **Your text rules**, in pack order, each where its `applies_to` says.
3. **The built-in secret patterns**: provider tokens, credential assignments, bearer headers,
   JWTs, connection URLs, private-key blocks, and the entropy pass.

A session from a place the org lists in `[capture] redact_tool_calls` (the server's list, with
a laptop's own `capture.redact_tool_calls`) goes through one pass more first: every string of
every tool call's input and result becomes `[redacted:tool-call]`, keeping the calls' names,
ids, order and failures ([capture.md](capture.md#tool-calls-redacted)). A laptop runs it on the
raw log before upload, per agent. The server runs it on the normalized records, before the
passes below, for its own sources' sessions (Cursor Cloud, span sets included) and any upload
whose `repo` the list names, as a backstop for a laptop that did not: tool calls' arguments and
results, command output and background tasks' results in what was said, and all of a subagent's
session. Records a laptop already redacted are left as they are, and what it replaced is
counted under `tool-call` in the session's `redaction.counts`. The passes above then run on what is left, as
for any session: a sensitive-file or secret-command call no longer has a path or command to
match, so its result is already `[redacted:tool-call]`, while the text rules and secret patterns
still catch what the prompts and replies say. The markers are:

| Marker | Written by |
| --- | --- |
| `[redacted:tool-call]` | the tool-call pass (`[capture] redact_tool_calls`) |
| `[redacted:sensitive-file]`, `[redacted:secret-output]` | pass 1 |
| `[redacted:<rule id>]` | passes 2 and 3 (or the rule's own `replacement`) |

Passes 2 and 3 skip the structural fields (ids, roles, timestamps, tool names, the source and
the branch). They also run, as `text`, over what an LLM call says in free text (its `error` and
string `parameters`), for sources that record calls (OTLP). The session's `metadata.json` records the rule set's hash and how often each rule
fired, by rule id (`redaction`, F2.3), never what matched.

A pack is a TOML file:

```toml
id = "acme"                      # the pack's id
version = "2026-11-01"           # optional
disable = ["entropy"]            # built-in rules to turn off, by id

[[rules]]                        # text rules
id = "acme-key"                  # names the rule in the counts; keep it stable
description = "Acme API keys"
pattern = 'ACME-[0-9A-F]{32}'    # RE2 syntax; or patterns = [...]
replacement = "[redacted:acme-key]"   # the default is [redacted:<id>]
applies_to = ["text", "tool_input", "tool_output"]   # the default is all three
tests.match = ["key ACME-0123456789ABCDEF0123456789ABCDEF"]
tests.no_match = ["ACME-1234"]

[[rules]]
id = "internal-key"
pattern = 'internal-key: (?P<secret>\S+)'   # only the `secret` group is replaced

[[sensitive_files]]
id = "acme-master-key"
globs = ["config/master.key", "secrets/**", "!secrets/README.md"]
tests.match = ["app/config/master.key"]

[[secret_commands]]
id = "acme-token"
pattern = 'acme-cli\s+token\b'
tests.match = ["acme-cli token --org x"]
```

- **Text rules** (`[[rules]]`) are regular expressions over every text field. `applies_to` picks
  where: `text` (what the user, the assistant and the system said), `tool_input` (a tool call's
  arguments) or `tool_output` (what a tool returned). With a named group `secret`, only that
  group is replaced, so `internal-key` above keeps `internal-key: `.
- **Your patterns run under RE2** (F2.2): matching takes time linear in the text, so no
  pattern can hang the server on a crafted session. RE2 has no backreferences and no
  lookahead or lookbehind; a pattern using them, one that matches empty text, or one too large
  is refused when the server starts. Named groups are `(?P<name>…)` or `(?<name>…)`,
  case-insensitive matching is `(?i)`. The built-in rules are reviewed JavaScript patterns.
- **`sensitive_files`** are `.gitignore`-style globs: without a `/` a file's name in any
  directory, with one the end of its path; `**` crosses directories; `!` makes an exception,
  which holds for every file rule, the built-in ones included.
- **`secret_commands`** are RE2 patterns matched at the start of each command in a shell line
  (after `;`, `&&`, `|`, `$(`, `sudo`, `VAR=value`).
- **`tests`** are strings the rule must redact (`match`) and leave alone (`no_match`). The server
  checks every rule against its own test strings at start-up and refuses to start if one fails,
  naming the file, the rule and the string.
- **`disable`** turns built-in rules off by id. The ids are in the built-in pack; `seshi redact
  test --json` lists every rule with its pack and whether it is on. Your rules cannot reuse a
  built-in id.
- Rule ids are lowercase words joined by `-`, unique across every pack: the counts are by id.
  A rule must not change what any rule replaces text with, so redacting twice changes nothing;
  the server refuses a rule set where one would.

Today's JSON rule file is still a pack: `redaction.packs` takes `.json` files with `patterns`,
`sensitive_files` and `secret_commands`, and loads them together as the pack `legacy`, whose
patterns count as `custom-pattern` (and become `[redacted:custom-pattern]`). This is the file
Dosu's CLI keeps for an org's rules, so an org's list can be pasted as it is; the CLI's
`excluded` and `names_only` lists are about the member's machine and are ignored. Its patterns
now run under RE2 too, so one that used lookaround has to be rewritten.

Rules apply to sessions stored after the server reloads (`SIGHUP`, `POST /v1/admin/reload`) or
restarts with them (F1.5, [config.md](config.md#reloading)); a pack that does not compile is
refused and the running rules stay. Try them first with
`seshi redact test`, and apply them to what is already stored with `seshi redact backfill`
([below](#trying-and-applying-rules)).

A client can redact before upload with the same rules (F2.4): `GET /v1/redaction/rules` serves
your packs to any signed-in caller, with an ETag. `seshi`'s capture uploader does this for every
piece it sends ([capture.md](capture.md#redacting-before-upload-f24)). The server redacts
everything again regardless.

## Trying and applying rules

`seshi redact test` tries rule packs ([above](#rule-packs)) without a server. The rule set is the built-in pack, the server's `[redaction] packs` when `--config`
names its config, and each `--pack` file. Without a file it checks every rule against its test
strings. With a file (or `-` for standard input) it also shows how often each rule fired and
where: by record for a transcript (its format is detected, or named with `--agent`; it is
normalized and redacted as the server would), by line for plain text (`--text`, or anything no
format reads; each line counts as `--field text`, `tool_input` or `tool_output`). It never shows
what matched; `--print` prints the redacted records or text on stdout (the report goes to
stderr then). `--json` gives one document: `rule_set`, `builtin`, `packs`, every rule with its
pack, engine and whether it is on, `tests`, and with a file `input`, `matches` and `output`.
Exit 1 when a test string fails, 3 for a pack it cannot use, 4 for a missing file.

`seshi redact backfill` applies the server's current rule set to stored sessions (F2.5): the
ones written `--since` a duration (`30d`) or time, or `--all`, optionally only `--owner <id>`
(repeatable), stopping after `--limit N` rewritten. A session an earlier rule set redacted is
redacted again; one the new rules change gets one new trace with the whole session, its old
trace objects are deleted, its counts grow, and a `published` change entry with `replace:
true` and `reason: "redacted"`, written as `--as <owner>` (default `admin`, source
`redaction`), tells readers to take the new trace. A session the rules do not change only has
its rule set recorded. An OTLP or poller session's span records (`spans/`) that an earlier
rule set redacted are redacted again in place, and the summary says how many; that includes
the span records of sessions not published (still waiting for quiet, or refused by the session
filter or model review), which have no session to list. The input messages those records share
(`spans/messages/`, stored once each) are redacted with them: a message the new rules change
is stored again redacted, and the old one deleted once no span record names it. Redaction cannot
be undone; `--dry-run` writes nothing and lists what would change. It is safe to stop and run
again: sessions already redacted with the current rules are skipped. Each stored trace records
the rule set it was written under, so a session that got a chunk under the new rules before the
backfill ran is still redone as a whole. Restart the server with the new packs first, or it
keeps writing with the old rules. Exit 8 when a session changed while it ran (run it again).
Each session it looks at is then swept (below), and the summary says how many trace objects
the sweep deleted (`sweep` in `--json`).

A backfill or a replace that stops partway (a crash, a failed delete) can leave trace objects
the session's metadata no longer names, holding what the new rules or the replacing write took
out. No reader is served them, and a sweep deletes them (F2.5): any trace object that no
metadata names (not the head, nor any continuation of a chunked session) and that is over an
hour old by the store's listing (S3's `LastModified`, a file's mtime). The age guard keeps it
off the object of a publish still in flight, which is written before the pointer names it.
Only trace objects are deleted. It runs on each session a backfill looks at, after every
replace on the replaced session, and once a day across the whole bucket on the worker (the
`sweep` job, whose last run `seshi workers status` shows). `seshi redact sweep [--owner
<id>]… [--dry-run] [--json]` runs it now, where the server config is: from cron on a
deployment with no worker, or to clear the bucket at once. It lists what it deletes; exit 1 when
a session could not be swept (the next sweep tries again).
