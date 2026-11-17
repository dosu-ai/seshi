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

import { bridgeRuntime } from "@seshi/kit";

export const PLUGIN_MARKER = "seshi:opencode-plugin";
export const COMMAND_MARKER = "seshi:opencode-command";
export const PLUGIN_VERSION = 2;

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
${bridgeRuntime()}

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
  // Sessions seshi said it does not capture (turned off, paused, excluded): their turns are not
  // read or handed over. /seshi on, or a new OpenCode, asks again.
  const notCaptured = new Set();
  const heard = (id, message) => {
    if (message.includes("⏸")) notCaptured.add(id);
    else if (message.includes("◉")) notCaptured.delete(id);
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
        // A subagent's session is captured with its parent's: no toast for it. Not awaited: the
        // session's first turn need not wait for seshi.
        if (!info?.id || info.parentID) return;
        void seshi(
          ["hook", AGENT, "SessionStart"],
          JSON.stringify({ session_id: info.id, cwd: info.directory }),
        ).then(async (run) => {
          for (const message of messages(run.stdout)) {
            heard(info.id, message);
            await toast(message);
          }
        });
        return;
      }
      if (event.type === "session.idle" && properties.sessionID) {
        // Awaited: \`opencode run\` exits once the turn is over, and seshi must have the session.
        const id = properties.sessionID;
        if (notCaptured.has(id)) return;
        const info = await session(id);
        if (!info || (info.parentID && notCaptured.has(info.parentID))) return;
        let list;
        try {
          list = (await client.session.messages({ path: { id } })).data;
        } catch {
          return;
        }
        if (!Array.isArray(list)) return;
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
      heard(input.sessionID, said);
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
