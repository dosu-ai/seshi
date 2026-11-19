# 40 — The Cursor status bar extension

F9.4, F9.6: Claude Code shows `Session Capture ◉/⏸` in its status line, the Claude desktop app
in a chip (25), the Cursor CLI in its status line, and Codex in a notice when a session starts.
Cursor's editor windows have nothing an agent's hook can draw on, so this is a VS Code extension
for Cursor, in `integrations/cursor/extension`, built on `seshi statusline` the way the desktop
chip is.

## Two spikes first

A throwaway extension, installed in Cursor 3.21 (VS Code API 1.128), answered what the plan
could not:

- **Status bar items show in Cursor's editor windows, not in the Agents Window.** The Agents
  Window has its own bottom bar and no extension surface.
- **`composer.getOrderedSelectedComposerIds` exists** (undocumented) and returns the open
  chats' ids. They are the `conversation_id` Cursor's hooks send, so seshi knows them. A new
  chat's id appears before its first message.
- **It does not say which chat has focus**: with two chats open it returns both, in tab order,
  and clicking between them does not reorder it. `composer.getComposerHandleById` returned null
  and `composer.desktopBridge.listThreads` an empty list.
- **Cursor shows each chat as an editor tab**, in the same order as those ids, in one tab
  group, labelled with the chat's title and with no input the API can describe. So the active
  tab's position names the focused chat. This is what the extension relies on, checked each
  time: when the number of tabs and ids differ (a new chat's tab comes first), it does not guess.
- **Cursor 3 nests its transcripts**, `agent-transcripts/<id>/<id>.jsonl`. seshi's sweep and
  `locate` looked one folder deep, so the sweep and `seshi upload --since` found no Cursor
  transcript (0 of 22 on the machine tested). Fixed separately: both layouts are read.

## What was built

- **The prompt record.** Cursor's beforeSubmitPrompt hook, which already answers `/seshi`,
  records on every prompt the conversation last prompted in the folder,
  `<capture dir>/recent/cursor-<sha256(folder)>.json` (agent, id, folder, time; no prompt text),
  written atomically. It is the fallback when Cursor's own answer is missing.
- **`seshi statusline --folder`** (`apps/seshi/src/commands/statusline.ts`,
  `packages/ts/capture/src/current.ts`): `--folder` (repeatable), `--session` (the chat the
  editor says has focus) and `--selected` (the open chats). The conversation is the focused
  one, else the only one open, else the last prompted of those open (or at all), else the one
  seen most recently in those folders in the past day. The JSON adds `session` (id, how it was
  chosen, its state word) or null, the other `candidates`, `attention` (the worst problem
  kind), `installed`, and `watch`, the folders and file the editor should watch, so it never
  works out seshi's paths itself. Without `--folder` nothing changes, and it stays on the hook's
  fast path (`check:hook`).
- **The extension.** `src/extension.ts` is the only part that touches the `vscode` API; the
  rest is plain TypeScript tested with vitest, also on Windows (`LAPTOP_TESTS`):
  - `focus.ts`: the focused chat from the open ids and the tab groups.
  - `binary.ts`: the seshi program: the `seshi.command` setting, else the one seshi's own hook
    in `~/.cursor/hooks.json` runs (its absolute path, which works when Cursor does not see the
    shell's PATH), else `seshi`.
  - `seshi.ts`: runs seshi and parses its one JSON document, its JSON errors and a missing
    program.
  - `refresh.ts`: which changes count (seshi's state, including the temporary file it renames
    into place; a recorded prompt; the CLI config; not `rules.json`, which `statusline` itself
    rewrites, nor the uploader's heartbeat) and a debouncer.
  - `view.ts`: seshi's answer as text, tooltip, colour and what a click does: toggle (asking
    which chat first when seshi had to guess), explain a team's rule, show the status, offer
    `seshi capture install cursor`, or point at the setting and install docs.
- **When it refreshes.** File watches on the folders seshi names (debounced 300 ms), tab and
  window changes, the open chats every 2 seconds while the window has focus (Cursor sends no
  event for them), a repo's `.seshi/config.toml`, and every 30 seconds.
- **Only in Cursor.** It activates on start-up and stays inactive outside Cursor.
- **`seshi capture install cursor`** suggests the extension (by id) until
  `~/.cursor/extensions/` holds it. It does not install it: `cursor --install-extension` needs
  the `cursor` command, goes over the network, and is reported to ignore the active profile.
- **Release.** `scripts/release/build.ts` packages it into
  `dist/release/seshi-cursor-<version>.vsix` (vsce 3.7.1), checksums and uploads it with the
  rest; `scripts/release-version.ts` versions its manifest with the repository. CI's test job
  packages it (`bun run ext:package`). A new `openvsx` job publishes the release's `.vsix`, after
  checking it against SHA256SUMS, as `dosu.seshi-cursor` with ovsx 1.3.0, when the `OVSX_PAT`
  secret is set and the version is not already there.

## Where the build differs from the plan

- The plan recorded the last prompt as the main signal and Cursor's command as a bonus. The
  spike made the tab order the main signal, with the prompt record as the fallback.
- No `sessionStart` hook: a new chat's id is available from Cursor straight away.
- No extension-host test: it would download VS Code (not Cursor) from the network. Checked by
  hand in Cursor instead (below).
- No icon yet: `brand/` has SVGs, and a PNG needs a converter the repository does not have.

## Checked

- `bun run check`, `bun run typecheck` (with the extension's own tsconfig), `bun run test`,
  `bun run test:laptop`, `bun run check:hook`, the release script tests.
- The sweep fix against a real Cursor 3.21 machine: 22 of 22 transcripts found.
- The spikes, in Cursor 3.21 on macOS (above).
- The extension itself, by hand in Cursor 3.21 on macOS, installed from the `.vsix`: the item in
  the editor window, following the chat in view, and toggling it.

## Still to check

- The extension with a team's rule in force, and with seshi missing.
- Windows: the program path from `hooks.json`, `.cmd` shims, and file watching.
- Publishing: the Open VSX account and namespace, the `OVSX_PAT` secret, and how long Cursor's
  proxy takes to offer a new version.
- That the undocumented command and the tab order hold across Cursor updates. The extension
  turns the command off after its first error and falls back to the prompt record.
