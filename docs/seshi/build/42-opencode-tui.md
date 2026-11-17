# 42 — OpenCode TUI plugin

F9.4, F9.6: after 41, OpenCode showed whether a session is captured only in a toast when it
started, and `/seshi` was a command file that the server plugin rewrote, so the model still
answered once. This branch adds a TUI plugin that keeps `Session Capture ◉/⏸` beside the prompt
for the session in view, and takes `/seshi off|on|status` from the prompt before anything is
sent, so the model never runs.

## Spikes first

Against OpenCode 1.18.31 (its source at tag `v1.18.31`, and the real TUI under `script`) with the
fake model (`.claude/skills/verify-seshi/scripts/fake-model.ts`) and the agent's folders isolated:

- **Loading.** The TUI loads only the plugins listed in `tui.json`'s (or `tui.jsonc`'s) `plugin`
  list, global then project, the lists merged. No folder is scanned for TUI plugins. A path spec
  is resolved against the file that lists it. A file plugin must default-export
  `{id, tui}`, and may not also export `server` (`readV1Plugin`).
- **Where the file lives.** Not in `plugins/`: OpenCode's server loads every `plugins/*.{js,ts}`
  as a server plugin and would fail on a TUI one. seshi uses `seshi/tui.js` in the config folder.
- **Imports.** OpenCode calls `ensureRuntimePluginSupport` (`@opentui/solid`), a Bun plugin that
  maps a plugin's `solid-js`, `solid-js/store`, `@opentui/solid` and `@opentui/core` imports to
  its own copies and runs Solid's transform on files outside `node_modules`. A plain JavaScript
  file using `createElement`, `insert` and `setProp` from `@opentui/solid` and `createSignal` from
  `solid-js` renders, with no JSX and nothing installed.
- **The session in view.** The `session_prompt_right` slot gets `session_id`, and is drawn on the
  right of the prompt's agent and model line. `api.route.current` is
  `{name: "session", params: {sessionID}}` in a session and `{name: "home"}` before one.
  `api.event.on("session.idle")` follows each turn.
- **`/seshi` without the model.**
  - A command registered with `api.keymap.registerLayer` (or the deprecated `api.command`) and a
    `slashName` runs only when picked from the autocomplete, with no arguments. Typed
    `/seshi off` goes to the server as a command when a command file of that name exists, and to
    the model as a prompt otherwise.
  - A server plugin cannot stop a command: `command.execute.before` runs inside
    `Effect.promise`, so throwing there is a defect, not a cancelled turn.
  - A keymap binding on the submit key, in a layer with a higher `priority` than the prompt's
    (0), sees the prompt first: `ctx.focused` is the prompt's textarea, with `plainText`. A
    binding whose command returns `false` is "rejected" and the key goes on to the prompt's own
    `prompt.submit`. `api.keymap.dispatchCommand("prompt.clear")` clears the prompt (text, parts
    and its store), so the next Enter sends nothing.

## What was built

- **The TUI plugin** (`opencodeTuiPlugin` in `integrations/opencode/src/plugin.ts`), written to
  `~/.config/opencode/seshi/tui.js` with a marker, plain JavaScript with seshi's program baked
  in, sharing the server plugin's runner (environment without `SESHI_SESSION_ID`/`SESHI_AGENT`,
  a shell for a Windows `.cmd` shim, a 10 s limit, never rejecting):
  - fills `session_prompt_right` with `seshi statusline --agent opencode` (with `NO_COLOR`) up to
    its first ` · `, in the theme's muted colour, or its warning colour for `⏸`; read when the
    session comes into view and after each `session.idle` of that session or its subagents';
  - binds the keys `prompt.submit` is bound to (`api.tuiConfig.keybinds`, else `return`) at
    priority 100. In a session, with no dialog open, a prompt that is `/seshi` with optional
    arguments is cleared and handed to `seshi hook opencode Command`; seshi's answer is a toast
    and the status is read again. Anything else, and `/seshi` on the home screen, passes on;
  - names the top-level session for a subagent's (its `parentID`, followed), as capture does.
- **The installer** writes the TUI plugin beside the other two files, and adds its absolute path
  to `tui.json`'s `plugin` list, keeping every other entry and key; a missing `tui.json` is
  created with OpenCode's `$schema`. It finds its entry as the path or its `file://` URL, alone
  or with options, so an entry added by hand is not doubled. `uninstall` takes out only that
  entry, removes `tui.json` when nothing but its `$schema` is left, and removes `seshi/` once
  empty. `status` lists `tui.json` and reports when the entry is missing.
- **The server plugin** is unchanged but for its runner taking extra variables. Its command file
  and `command.execute.before` stay for `opencode run --command seshi`, the web UI, and the TUI's
  home screen; its start toast stays.

## Where the build differs from the plan

- The plan (41's follow-ups) had `api.command.register` for `/seshi`. That API is deprecated, and
  neither it nor `keymap.registerLayer` passes typed arguments to a slash command, so seshi
  takes the prompt on its submit key instead and registers no slash command; the command file's
  autocomplete entry still offers `/seshi`.
- `tui.json` is plain JSON to seshi. OpenCode reads it as JSONC, but rewriting one with comments
  would drop them, so such a file is left alone and `install` says what to add by hand. seshi
  never writes `tui.jsonc`.

## Checked

- `bun run check`, `bun run typecheck`, `bun run test:laptop`, `bun run check:hook`.
- Unit tests (`integrations/opencode/src/capture.test.ts`):
  - the installer: the three files and the `tui.json` entry written once; a `tui.json` with the
    person's theme, keybinds and plugins (one with options) merged and restored exactly; an entry
    listed by hand as a `file://` URL found and removed; a `tui.json` with comments, or a
    `plugin` that is not a list, left alone with a note; a foreign `seshi/tui.js` stopping the
    install;
  - the TUI plugin, imported with stand-ins for `@opentui/solid` and `solid-js` in a
    `node_modules` beside it, a stand-in for the TUI's plugin API and a stand-in seshi: the
    status of the session in view and of a subagent's (its parent's), the refresh after a turn,
    `/seshi off` cleared and carried out with its toast and new status, and every other prompt,
    `/seshi` on the home screen or under a dialog passed on; the configured submit keys bound.
- By hand, with the verify-seshi skill against a served instance, real OpenCode 1.18.31 TUI and
  the fake model (recipe: `.claude/skills/verify-seshi/features/pi-opencode.md`, `po-oc-tui`):
  - `capture install opencode` added the entry to a `tui.json` holding a theme and a setting;
    `uninstall` left it exactly as before.
  - The prompt line showed `Session Capture ◉` after the first turn. `/seshi off` cleared the
    prompt, toasted `Session Capture ⏸ · turned off for this session; …`, and the status turned
    to `⏸`; an empty Enter and `/seshi status` sent nothing. `opencode export` held only the first
    turn, and the session was never uploaded.
  - Reopened with `opencode -s`, the status was `⏸`; `/seshi on` turned it to `◉`, and the next
    turn uploaded the session (5 records).

## Still to check

- Windows: the TUI plugin's path in `tui.json` (`C:\…`, which OpenCode takes as absolute) and the
  `.cmd` shim.
- OpenCode's desktop app and web UI, which load no TUI plugins: `/seshi` there is the command
  file's, with one model reply.
- A theme whose `warning` colour is hard to read beside the prompt.

## Follow-ups

- A status on OpenCode's home screen (`home_prompt_right`), from the folder's rules, before a
  session exists.
