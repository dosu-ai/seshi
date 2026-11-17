/** The OpenCode plugin and command `seshi capture install opencode` writes to
 * `~/.config/opencode/plugins/seshi.js` and `~/.config/opencode/command/seshi.md`.
 *
 * OpenCode runs no shell hooks and keeps its sessions in a database, not in a transcript file.
 * The plugin, which OpenCode's server loads in the TUI, `opencode run`, `serve` and `web`, reads
 * each session through OpenCode's own client once a turn is over (`session.idle`) and hands it to
 * `seshi hook opencode Stop` whole, as an export (`{info, messages}`, the shape `opencode export`
 * prints), so seshi writes it to disk only for a captured session. It also tells the person, in a
 * toast, whether a new session is captured, and carries out `/seshi off|on|status`, a command
 * file, before OpenCode sends it to the model. The module exports nothing but the plugin function:
 * OpenCode calls every export. */

export const PLUGIN_MARKER = "seshi:opencode-plugin";
export const COMMAND_MARKER = "seshi:opencode-command";
export const PLUGIN_VERSION = 1;

export function opencodePlugin(command: readonly string[]): string {
  return `// ${PLUGIN_MARKER} v${PLUGIN_VERSION} -- written by "seshi capture install opencode", which
// rewrites it; "seshi capture uninstall opencode" removes it, so edits do not last.
//
// Session Capture for OpenCode: once each turn is over, the session is handed to seshi, which
// uploads it to your team's session store, or leaves it out as your capture rules say. A toast
// says whether a new session is captured, and /seshi off|on|status turns it off or on for this
// session. OpenCode started with --pure captures nothing.

import { spawn } from "node:child_process";

const SESHI = ${JSON.stringify(command)};
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
function seshi(args, input) {
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
      env: environment(),
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

export const SeshiCapture = async ({ client }) => {
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
