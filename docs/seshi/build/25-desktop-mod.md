# 25 — The desktop Session Capture chip

F9.4–F9.6: the Claude desktop app's Code tab has no `statusLine` setting, so seshi's Claude Code
plugin carries a mod (a hooks module) that puts a clickable `Session Capture ◉/⏸` chip in the
prompt footer and adds `/session-capture`. Modelled on the Session Capture prototype
(dosu-ai/dosu PR 13997), whose UI it keeps and whose open question ("where does the flag live?")
seshi answers: in seshi's own state, through the CLI.

## What was built

- **`integrations/claude-code/plugin/hooks/register.tsx`**, named under `modules` in the
  plugin's `hooks/hooks.json` beside the command hooks (one plugin, as F9.6 says).
  - **Chip** (`ui.render` on `SessionMode`): one dim plain `Button`, label `Session Capture ◉`
    or `Session Capture ⏸`, then anything that needs action after ` · ` (B1.6), drawn ahead of
    the engine's mode labels (`await next(e)`). It shows nothing until seshi has answered once.
  - **What it shows** comes from `seshi statusline --json --agent claude-code`, with
    `{"session_id": <$.session.id()>}` on stdin and the session's folder as the working
    directory: the same `decide` the hooks, the sweep and the terminal's status line use, so
    the four never disagree. Asked at `session.start`, after each `turn.complete`, every 30
    seconds (a pause or a rule can change between turns), and after each toggle.
  - **Toggle** (a click, or `/session-capture` with no argument): the opposite of what the chip
    shows, by `seshi capture off|on --session <id> --agent claude-code --json`, exactly what the
    `/seshi` skill runs: the session's toggle in `state.json`, a retraction of what was uploaded
    when turned off (F9.7), the uploader woken.
  - **Banner** (`ui.render` on `AbovePrompt`): what the toggle did, for 5 seconds after the last
    one (`⏸ Session Capture is off · retracting what was uploaded`), yielding to a survey.
  - **`/session-capture [on|off|status]`**: `on` and `off` set it; `status` says why it is as it
    is (`Session Capture is OFF: turned off for this session.`); anything else answers the usage
    line and runs nothing. Replies say when a retraction started, when a session comes back
    whole as a new one or after a pause, and when a shared rule still keeps it off.
  - **No seshi**: the chip reads `Session Capture ⏸ · seshi not found`, and a toggle says to set
    the plugin's **seshi command** option (`userConfig.command`, default `seshi`) to the full
    path, since the desktop app does not always see the shell's `PATH`.
- **`types/index.d.ts`**: the `$.state` contract, `seshi.capture` (tagged `capture-1`) and
  `seshi.banner`.
- **`tests/register.test.tsx`**, run by `claude plugin test integrations/claude-code/plugin` (7
  tests, terminal and desktop surfaces): the chip from what seshi says; ⏸ with problems; no
  seshi; a click turning it off, retracting, the banner and its 5-second hide on the mock
  clock; the command's forms; a shared rule keeping it off; the 30-second refresh.
- **`tests/capture/capture.test.ts`**: the CLI answers the chip's two calls with the fields it
  reads (`capturing`, `reason`, `problems`; `retracting`, `fresh`, `unfrozen`), so a change to
  the CLI's JSON breaks a test here, not the chip.
- **`.claude-plugin/marketplace.json`** at the repository root, listing the plugin, so it
  installs with `/plugin install seshi --marketplace dosu-ai/sessiondb`. The plugin's README
  has the install lines and a section on the chip.

## Deviations from the prototype

1. **The flag is seshi's, not the mod's.** The prototype kept one boolean in `$.state`, default
   ON. Here the chip shows and sets seshi's own decision, so a new session starts from the
   capture rules (global, repo, folder, pause), and the terminal, the hooks and the chip agree.
2. **Problems after the glyph** (`· 3 queued`, `· sign in`, `· seshi not found`), as B1.6 and the
   terminal's status line have them; the prototype had none.
3. **`/session-capture status`**, beside `on` and `off`: the chip cannot say why it shows ⏸.
4. **Toggling on can leave it off.** A repo's `capture = false` or an org rule wins over a
   session toggle (F9.5); the reply and the banner say so instead of claiming it is on.
5. **No status line entry.** The prototype cleared one an earlier version pinned; this mod never
   pinned one.

## Not checked

- **In the desktop app itself.** Validated (`claude plugin validate`), type-checked against
  Claude Code 2.1.325's declarations, and tested with the engine's test kit, which cannot show
  the native drawing. Not yet seen: the chip in the footer, a real click toggling, the banner.
- **The desktop app's `PATH`.** Whether `seshi` resolves without the option set depends on how
  the app was started.
- **Cost.** One `seshi statusline` run per refresh (start, each turn, every 30 s, each toggle):
  about 50 ms for the compiled binary, more through `bun run`.
- **`$.session.id()` equals the hooks' `session_id`.** Assumed (one engine); the tests stand
  for it, a real session does not yet.
- **Icon.** The plugin directory asks for a square PNG (512–2048 px); the brand files are SVG.
