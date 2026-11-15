# Sessions and search

Stored sessions can be listed, shown with their metadata, exported in several trace formats,
made private or visible to the org, and searched by their words. Everything shown is the
redacted, stored copy.

## Sub-features

- `ses-ls`: `sessions ls` lists sessions newest first, with record counts and visibility.
- `ses-show`: `sessions show` gives metadata and, with `--trace`, the head trace.
- `ses-export`: `sessions export --format seshi|letta|otlp|atif` writes the trace.
- `ses-visibility`: `sessions visibility org|owner` changes who may read it.
- `ses-search`: `seshi search <words>` finds sessions by their text.

## How to get to it (user POV)

- Run `seshi sessions ls|show|export|visibility` in a terminal.
- Run `seshi search <words>` in a terminal.
- In server mode, `GET /v1/sessions` and `GET /v1/search?q=` with a bearer token.

## Driving it with control-seshi

Preconditions:

- A ready run with session `ses-1` stored: `$C agent claude-code ses-1 --turns 4`.

- **List.** Run `$C cli --name ls -- sessions ls --json`. Exit 0. The JSON lists `ses-1` with
  `visibility` `org` and 21 records.
- **Show.** Run `$C cli --name show -- sessions show claude-code ses-1 --trace --json`. Exit 0.
  The JSON has the head trace whose first record has `role` `meta` and `source` `claude-code`.
- **Export.** Run `$C cli --name export -- sessions export claude-code ses-1 --format seshi`.
  Exit 0, and stdout is a `seshi/trace/1` document. Repeat with `--format otlp` and
  `--format atif`: each exits 0 with that format's document.
- **Visibility.** Run `$C cli --name priv -- sessions visibility claude-code ses-1 owner`, then
  `$C cli --name ls-priv -- sessions ls --json`. The session shows `visibility` `owner`.
- **Search.** Run `$C cli --name search -- search refactor module --json`, retrying up to about
  10 seconds until it returns. It lists `ses-1` with a matching snippet.
- **Search miss.** Run `$C cli --name search-miss -- search volcano --json`. Exit 0, and no
  results.
- **Proof.** The `ls`, `show`, `export` and `search` evidence files, taken together, name `ses-1`
  consistently.

## Gotchas

- Search is indexed in the background (the worker's search-index job in server mode, on demand
  in local mode). Retry for a few seconds before calling an empty answer a failure.
- `sessions rm` asks for confirmation unless `--yes` is given, and in server mode it needs a
  recent session token. Prefer `capture off` (see toggle-pause) to test removal through capture.
- In server mode the org key can't read sessions under another username unless they are `org`
  visibility.
