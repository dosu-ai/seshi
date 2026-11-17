/** The OpenCode plugins and command `seshi capture install opencode` writes to
 * `~/.config/opencode/plugins/seshi.js`, `~/.config/opencode/seshi/tui.js` and
 * `~/.config/opencode/command/seshi.md`.
 *
 * OpenCode runs no shell hooks and keeps its sessions in a database, not in a transcript file.
 * The plugin, which OpenCode's server loads in the TUI, `opencode run`, `serve` and `web`, reads
 * each session through OpenCode's own client once a turn is over (`session.idle`) and hands it to
 * `seshi hook opencode Stop` whole, as an export (`{info, messages}`, the shape `opencode export`
 * prints), so seshi writes it to disk only for a captured session. It also tells the person, in a
 * toast, whether a new session is captured, and carries out `/seshi off|on|status`, a command
 * file, before OpenCode sends it to the model (`opencode run --command seshi`, the web UI, and the
 * TUI's home screen; in a session, the TUI plugin takes `/seshi` first). The module exports
 * nothing but the plugin function: OpenCode calls every export. */

export const PLUGIN_MARKER = "seshi:opencode-plugin";
export const COMMAND_MARKER = "seshi:opencode-command";
export const PLUGIN_VERSION = 1;
export const TUI_PLUGIN_MARKER = "seshi:opencode-tui-plugin";
export const TUI_PLUGIN_VERSION = 1;

export function opencodePlugin(command: readonly string[]): string {
  return `// ${PLUGIN_MARKER} v${PLUGIN_VERSION} -- written by "seshi capture install opencode", which
// rewrites it; "seshi capture uninstall opencode" removes it, so edits do not last.
//
// Session Capture for OpenCode: once each turn is over, the session is handed to seshi, which
// uploads it to your team's session store, or leaves it out as your capture rules say. A toast
// says whether a new session is captured, and /seshi off|on|status turns it off or on for this
// session. OpenCode started with --pure captures nothing.

import { spawn } from "node:child_process";

${runner(command)}export const SeshiCapture = async ({ client }) => {
  const toast = async (message) => {
    try {
      await client.tui.showToast({
        body: {
          title: "Session Capture",
          message,
          variant: message.includes("◉") ? "info" : "warning",
          duration: 6000,
        },
      });
    } catch {}
  };
  const session = async (id) => {
    try {
      return (await client.session.get({ path: { id } })).data;
    } catch {
      return undefined;
    }
  };
  return {
    event: async ({ event }) => {
      const properties = event.properties ?? {};
      if (event.type === "session.created") {
        const info = properties.info;
        // A subagent's session is captured with its parent's: no toast for it.
        if (!info?.id || info.parentID) return;
        const run = await seshi(
          ["hook", AGENT, "SessionStart"],
          JSON.stringify({ session_id: info.id, cwd: info.directory }),
        );
        for (const message of messages(run.stdout)) await toast(message);
        return;
      }
      if (event.type === "session.idle" && properties.sessionID) {
        const id = properties.sessionID;
        let info;
        let list;
        try {
          [info, list] = await Promise.all([
            session(id),
            client.session.messages({ path: { id } }).then((r) => r.data),
          ]);
        } catch {
          return;
        }
        if (!info || !Array.isArray(list)) return;
        await seshi(
          ["hook", AGENT, "Stop"],
          JSON.stringify({
            session_id: id,
            cwd: info.directory,
            ...(info.parentID ? { parent_session_id: info.parentID } : {}),
            export: { info, messages: list },
          }),
        );
      }
    },
    // /seshi off|on|status: seshi does it here, and the model gets the result instead of the
    // command (OpenCode sends a command's text to the model; it cannot be stopped).
    "command.execute.before": async (input, output) => {
      if (input.command !== "seshi") return;
      const info = await session(input.sessionID);
      const run = await seshi(
        ["hook", AGENT, "Command"],
        JSON.stringify({
          session_id: input.sessionID,
          ...(info?.directory ? { cwd: info.directory } : {}),
          arguments: input.arguments ?? "",
        }),
      );
      const said =
        messages(run.stdout)[0] ??
        "Session Capture could not be changed: seshi did not answer (is it installed and on this machine's PATH?)";
      await toast(said);
      output.parts.splice(0, output.parts.length, {
        type: "text",
        text: \`\${said}\\n\\n(seshi's /seshi command already did this. Reply with one short sentence that says so, and do nothing else.)\`,
      });
    },
  };
};
`;
}

export function opencodeCommand(): string {
  return `---
description: "Session Capture: turn it off or on for this session, or show whether it is captured (off, on, status)"
---
<!-- ${COMMAND_MARKER}: written by "seshi capture install opencode"; seshi's plugin carries it out. -->
/seshi $ARGUMENTS
`;
}

/** The TUI plugin, at `~/.config/opencode/seshi/tui.js` and named in `tui.json`'s `plugin` list
 * (OpenCode's TUI loads no plugin folder of its own, and its server would load this file as a
 * server plugin from `plugins/`). It shows `Session Capture ◉/⏸` beside the prompt for the
 * session in view, from `seshi statusline --agent opencode`, refreshed when the session comes into
 * view and after each turn. And it takes `/seshi off|on|status` from the prompt itself, on the
 * keys that submit it, so the command never reaches the server and the model does not answer.
 * On the home screen, with no session yet, `/seshi` goes on to the server's command as before.
 *
 * Plain JavaScript, no JSX: OpenCode maps `@opentui/solid` and `solid-js` to its own copies. */
export function opencodeTuiPlugin(command: readonly string[]): string {
  return `// ${TUI_PLUGIN_MARKER} v${TUI_PLUGIN_VERSION} -- written by "seshi capture install opencode", which
// rewrites it; "seshi capture uninstall opencode" removes it, so edits do not last.
//
// Session Capture in OpenCode's TUI: beside the prompt, whether the session in view is captured
// (◉) or not (⏸); and /seshi off|on|status, typed in the prompt, carried out by seshi before
// OpenCode sends anything to the model. seshi's server plugin (plugins/seshi.js) does the
// capturing; tui.json's "plugin" list names this file.

import { spawn } from "node:child_process";
import { createElement, insert, setProp } from "@opentui/solid";
import { createEffect, createSignal } from "solid-js";

${runner(command)}
// Only these are taken from the prompt; anything else (an attachment's placeholder text, an
// unknown word) goes on to the server's /seshi command, attachments and all.
const SESHI_COMMAND = /^\\/seshi(?:\\s+(off|on|status))?$/i;

// seshi's status line up to its first " · ", so it fits beside the prompt.
function short(line) {
  const at = line.indexOf(" · ");
  return at === -1 ? line : line.slice(0, at);
}

export default {
  id: "seshi",
  tui: async (api) => {
    // The status line last read, for the session in view only, by id.
    const [statuses, setStatuses] = createSignal({});
    // Reads can finish out of order: only the latest one started is shown.
    let reads = 0;

    // The session /seshi and the status are about, with its folder: a subagent's session is
    // captured with its parent's.
    const which = (id) => {
      let top = id;
      for (let i = 0; i < 32; i++) {
        const parent = api.state.session.get(top)?.parentID;
        if (!parent) break;
        top = parent;
      }
      const cwd = api.state.session.get(top)?.directory || api.state.path.directory;
      return { session_id: top, ...(cwd ? { cwd } : {}) };
    };

    const refresh = async (id) => {
      const read = ++reads;
      const run = await seshi(["statusline", "--agent", AGENT], JSON.stringify(which(id)), {
        NO_COLOR: "1",
      });
      if (read !== reads) return;
      const line = run.code === 0 ? (run.stdout.trim().split("\\n")[0] ?? "") : "";
      setStatuses({ [id]: line });
    };

    // The session in view, when its own prompt is the one shown: not a subagent's (no prompt),
    // and none waiting on a permission or a question (their inputs replace the prompt).
    const prompting = () => {
      const route = api.route.current;
      const id = route.name === "session" ? route.params?.sessionID : undefined;
      if (typeof id !== "string" || api.ui.dialog.open) return undefined;
      if (api.state.session.get(id)?.parentID) return undefined;
      if (api.state.session.permission(id).length > 0) return undefined;
      if (api.state.session.question(id).length > 0) return undefined;
      return id;
    };

    const command = async (id, args) => {
      const run = await seshi(
        ["hook", AGENT, "Command"],
        JSON.stringify({ ...which(id), arguments: args }),
      );
      const said =
        messages(run.stdout)[0] ??
        "Session Capture could not be changed: seshi did not answer (is it installed and on this machine's PATH?)";
      api.ui.toast({
        title: "Session Capture",
        message: said,
        variant: said.includes("◉") ? "info" : "warning",
        duration: 6000,
      });
      await refresh(id);
    };

    api.slots.register({
      order: 1000,
      slots: {
        session_prompt_right(_ctx, props) {
          const node = createElement("text");
          createEffect(() => {
            void refresh(props.session_id);
          });
          createEffect(() => {
            const theme = api.theme.current;
            const line = statuses()[props.session_id] ?? "";
            setProp(node, "fg", line.includes("⏸") ? theme.warning : theme.textMuted);
          });
          insert(node, () => short(statuses()[props.session_id] ?? ""));
          return node;
        },
      },
    });

    // After each turn, the session in view, when the turn is its own or a subagent's of it.
    api.lifecycle.onDispose(
      api.event.on("session.idle", (event) => {
        const id = event.properties?.sessionID;
        const route = api.route.current;
        const shown = route.name === "session" ? route.params?.sessionID : undefined;
        if (!id || typeof shown !== "string") return;
        if (which(shown).session_id === which(id).session_id) void refresh(shown);
      }),
    );

    // /seshi off|on|status, on the keys that submit the prompt, before the prompt sends it. A
    // binding that returns false passes the key on to the prompt.
    // The textarea submits on input.submit ("return" by default); prompt.submit is unbound by
    // default.
    const keys = [];
    for (const name of ["input.submit", "prompt.submit"]) {
      try {
        for (const binding of api.tuiConfig.keybinds.get(name) ?? []) {
          if (binding?.key && !keys.includes(binding.key)) keys.push(binding.key);
        }
      } catch {}
    }
    if (keys.length === 0) keys.push("return");
    api.keymap.registerLayer({
      priority: 100,
      bindings: keys.map((key) => ({
        key,
        cmd: (ctx) => {
          const text = ctx.focused?.plainText;
          const id = prompting();
          if (typeof text !== "string" || !id) return false;
          const asked = SESHI_COMMAND.exec(text.trim());
          if (!asked) return false;
          // Taken only once the prompt is cleared; if it cannot be, the prompt sends it on.
          if (api.keymap.dispatchCommand("prompt.clear")?.ok !== true) return false;
          void command(id, (asked[1] ?? "").toLowerCase());
          return true;
        },
      })),
    });
  },
};
`;
}

/** What both plugins share, from the program seshi runs as down to reading what seshi said: run
 * seshi with a payload on stdin and its own variables cleared, never rejecting. */
function runner(command: readonly string[]): string {
  return `const SESHI = ${JSON.stringify(command)};
const AGENT = "opencode";
const HOOK_TIMEOUT_MS = 10000;

// seshi's own variables, inherited from a shell another agent started (a Claude Code session
// sets them), name that agent's session, not this one.
function environment() {
  const env = { ...process.env };
  delete env.SESHI_SESSION_ID;
  delete env.SESHI_AGENT;
  return env;
}

function quoted(word) {
  return /^[\\w@%+=:,./\\\\-]+$/.test(word) ? word : \`"\${word.replace(/"/g, '\\\\"')}"\`;
}

// Run seshi with input on stdin. Never rejects: a missing or failing seshi is an exit code. It
// runs where OpenCode does: the payload names the session's folder, which may be gone.
function seshi(args, input, extra = {}) {
  return new Promise((resolve) => {
    const [program, ...rest] = SESHI;
    // A .cmd or .bat shim (npm's, on Windows) runs only through the shell.
    const shell = process.platform === "win32" && !/\\.exe$/i.test(program);
    let stdout = "";
    let done = false;
    let child;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    };
    const timer = setTimeout(() => {
      child?.kill();
      finish(-1);
    }, HOOK_TIMEOUT_MS);
    const options = {
      env: { ...environment(), ...extra },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    };
    try {
      child = shell
        ? spawn([program, ...rest, ...args].map(quoted).join(" "), { ...options, shell: true })
        : spawn(program, [...rest, ...args], options);
    } catch {
      finish(-1);
      return;
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// What seshi asked to tell the person: one JSON object per line, with "message".
function messages(stdout) {
  const out = [];
  for (const line of stdout.split("\\n")) {
    try {
      const said = JSON.parse(line);
      if (said && typeof said.message === "string") out.push(said.message);
    } catch {}
  }
  return out;
}

`;
}
