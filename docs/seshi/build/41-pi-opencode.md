# 41 — Live capture for pi and OpenCode

F9.2, F9.4, F9.6: Claude Code, Codex and Cursor are captured as they go, through their hooks.
pi and OpenCode were read only from files uploaded by hand. Neither runs shell hooks: pi loads
extensions and OpenCode loads plugins, code each imports at start-up. So for each, seshi installs
one small file that runs `seshi hook <agent> <event>` with a JSON payload on stdin, the way an
agent's hook does, and everything after it (rules, spool, uploader, retraction, the status line,
`capture off|on`) is what the other agents already use.

## Decisions before the build

Two questions were the user's, answered before anything was built:

- **Where an OpenCode session comes from.** OpenCode keeps sessions in SQLite
  (`opencode.db`), with no transcript file. Chosen: the plugin reads the session through
  OpenCode's own client once a turn is over and hands it to seshi whole. Not chosen: running
  `opencode export` from the uploader (a process per pass, about 0.5 s, and OpenCode's
  per-channel database names to follow), or reading the database (its schema is visibly
  mid-migration: a `session_message` table exists, empty).
- **pi's `/tree` branches.** pi keeps abandoned branches in the same file. Chosen: upload the
  file as it is, in chunks, as before; following only the active branch is adapter work, left
  for later.

## Spikes first

Against pi 0.99.2 and OpenCode 1.18.31 on macOS, with each agent pointed at a fake
OpenAI-compatible endpoint (`.claude/skills/verify-seshi/scripts/fake-model.ts`), so real
sessions ran with no model spend, and each agent's folders isolated:

- **pi.**
  - Extensions load in every mode, print mode included.
  - At `session_start` the session file does not exist yet; it does by `turn_end` and
    `agent_end`. The header (id, cwd, timestamp) is available from the start.
  - `session_shutdown` fires on quit and on SIGHUP (a closed terminal). Two Ctrl-Cs did not quit
    the TUI under `script`.
  - A fork (`--fork`) gets a new file whose header names its parent's file in `parentSession`.
  - `ctx.ui.setStatus` shows in the footer, and `pi.registerCommand("seshi")` takes `/seshi off`
    without the model.
  - seshi's existing pi format reads the files.
- **OpenCode.**
  - The server plugin loads in `opencode run` and in the TUI.
  - `session.created` fires on a session's first prompt, and a toast from it works.
  - `session.idle` follows every turn. `client.session.get` and `client.session.messages` there
    return the export shape in about 4 ms, the same shape as `opencode export --pure`, and seshi's
    OpenCode format reads it.
  - A command file (`command/seshi.md`) makes `/seshi` a command, and `command.execute.before`
    can replace its text before the model sees it. It cannot stop the turn: the model still
    answers once.
- **Both.** A pi or OpenCode started from a shell another agent started (here, Claude Code)
  inherits `SESHI_SESSION_ID` and `SESHI_AGENT`. The bridge must name its own session and
  ignore them.

## What was built

- **A transcript a hook hands over.** `HookCapture.transcript` (`@seshi/kit`) is a transcript
  passed whole in the payload. `runHook` writes it to
  `<capture dir>/transcripts/<agent>/<id>.json` (mode 0600, through a temporary file) and spools
  that path, **only when the session is captured**: a session turned off never reaches the disk.
  `captureDir` moved into `@seshi/kit` (re-exported from `@seshi/capture`) so an integration can
  name that folder for its sweep and `locate`.
- **pi** (`integrations/pi/src/capture.ts`, `extension.ts`).
  - Hook events:
    - `Stop` (from `agent_end`) and `SessionEnd` (from `session_shutdown`, final) carry
      `{session_id, transcript_path, cwd, parent_session?}`. The parent's id comes from the
      parent file's name.
    - `Command` takes `/seshi off|on|status`.
  - `identify` reads the header line. `locate` finds `*_<id>.jsonl`. The sweep covers
    `sessions/*/` and follows `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`, so
    `upload --since` backfills pi.
  - The installer writes `~/.pi/agent/extensions/seshi.ts`, plain JavaScript with seshi's program
    baked in and a marker line. It replaces only its own file and removes only its own.
  - The extension:
    - runs `seshi statusline --agent pi` into the footer (with `NO_COLOR`), at start (not
      awaited) and after each agent run;
    - shows `/seshi`'s answer as a notification;
    - strips `SESHI_SESSION_ID` and `SESHI_AGENT`;
    - uses a shell for a Windows `.cmd` shim;
    - gives up quietly when seshi is missing;
    - waits at most 3 s at shutdown.
- **OpenCode** (`integrations/opencode/src/capture.ts`, `plugin.ts`).
  - Hook events:
    - `SessionStart` announces a top-level session; the plugin toasts the notice.
    - `Stop` carries `{session_id, cwd, parent_session_id?, export}` and becomes a handed
      transcript.
    - `Command` takes the command's arguments.
  - The capture agent is `json`, not chunkable. Its sweep and `locate` read seshi's own
    `transcripts/opencode/`. `identify` reads `info` from the document's head.
  - The installer writes `plugins/seshi.js`, which exports only the plugin function because
    OpenCode calls every export, and `command/seshi.md`. Each has a marker; a foreign file stops
    the install for that agent.
  - The plugin runs seshi without setting a working directory, since the payload names the
    folder and a session's folder may be gone. For `/seshi` it puts seshi's answer, with a
    request for a one-line acknowledgement, in place of the command.
  - `OPENCODE_FORMAT` is now `chunkable: false`. It defaulted to true, and an S3 source would
    have cut a growing export at its last newline.
- **Wiring.** Both agents are in the capture registry, their integrations declare `capture`, the
  hook load check (`check:hook`) covers both new capture modules, and their tests run in
  `test:laptop` (Windows in CI).

## After the code review

- A session turned off keeps no local copy of what OpenCode handed over: the hook removes it
  when it skips the session, `capture off` removes it (and its subagents'), and `capture
  uninstall opencode` removes the folder.
- pi's `session_shutdown` with reason `reload` no longer ends the session.
- Hand-offs no longer hold the agent up: pi's `agent_end` and OpenCode's start toast are not
  awaited. The session's end (pi) and `session.idle` (OpenCode, whose `run` exits after it) still
  are.
- The OpenCode plugin stops reading and handing over a session seshi said it does not capture.
  Every turn of a captured session still goes whole: the export is one JSON document.
- `identify` no longer depends on the order of `info`'s keys: seshi writes `info` first itself,
  and checks the id by its value.
- `/seshi` with an argument it does not know says so (`HookResult.say`) instead of showing the
  status.
- pi's sessions are also found in the folder `sessionDir` in its settings names (an absolute one),
  where pi writes them flat, with no folder per project.
- The add-ons' process runner (`bridgeRuntime`) and the installers' marker-file handling
  (`installOwnedFiles`, `removeOwnedFiles`, `ownedFileState`) are shared in `@seshi/kit`.

## Where the build differs from the plan

- The plan had the OpenCode plugin write the export into seshi's folder itself. It hands it to
  `seshi hook` instead, so seshi alone decides where it lives and writes nothing for a session
  turned off. The plugin then needs no seshi paths.
- `/seshi` in OpenCode was planned for a later TUI plugin. The command file plus
  `command.execute.before` gives it now, at the cost of one short model reply.
- No `SessionStart` hook for pi: the footer's first refresh says the same, and pi has no
  separate notice to show.

## Checked

- `bun run check`, `bun run typecheck`, `bun run test`, `bun run test:laptop`,
  `bun run check:hook`.
- Unit tests for both agents:
  - the hook handlers, `identify` and `locate` against fixtures (`integrations/*/testdata`);
  - the installers (idempotent, out-of-date notes, a foreign file left alone);
  - the generated extension and plugin, imported and run against a stand-in for pi's API or
    OpenCode's client and a stand-in seshi that records each call.
- `runHook` writing a handed transcript for a captured session only, refusing an unusable id.
- By hand, with the verify-seshi skill against a served instance, real pi 0.99.2 and OpenCode
  1.18.31 and the fake model (recipe: `.claude/skills/verify-seshi/features/pi-opencode.md`):
  - **pi:** sessions stored, with a planted AWS key redacted. The footer showed `◉`, then `⏸`
    after `/seshi off`, and that session was never uploaded.
  - **OpenCode:** a session stored with a planted GitHub token redacted, and a second turn
    re-uploaded whole (3 then 5 records). `/seshi off` retracted it, and the model received
    seshi's answer in place of the command.

## Still to check

- Windows: the `.cmd` shim through the shell, and both agents' folders there.
- OpenCode's desktop app, and whether it loads `~/.config/opencode/plugins`.
- How long a very long OpenCode session takes to hand over after every turn. It goes whole each
  time, so a debounce may be needed.
- Oh My Pi and OpenClaw: whether they load pi's extensions from the same place.

## Follow-ups

- An OpenCode TUI plugin for a status that stays on screen, and `/seshi` without a model turn:
  built in 42 ([42-opencode-tui.md](42-opencode-tui.md)).
- Backfilling OpenCode sessions no plugin handed over: listing them needs OpenCode's database or
  its CLI.
- Adapter fidelity:
  - pi's `/tree` branches (only the active branch), its `!` bash commands and compaction
    summaries;
  - OpenCode's synthetic text parts;
  - Gemini CLI's format, which is a whole document but still defaults to chunkable.
- The verify-seshi helper's local mode no longer initialises the bucket that serverless mode now
  requires, so `$C up` without `--server` is not ready.
