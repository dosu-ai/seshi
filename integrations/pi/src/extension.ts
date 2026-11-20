/** The pi extension `seshi capture install pi` writes to `~/.pi/agent/extensions/seshi.ts`.
 *
 * pi runs no shell hooks: it loads extensions, TypeScript modules it imports (through jiti) at
 * start-up, in every mode (interactive, print, JSON, RPC). This one hands pi's lifecycle events
 * to `seshi hook pi <event>` with a JSON payload on stdin, the way an agent's own hooks do, so
 * capture works as it does for Claude Code: the rules, the spool and the uploader are seshi's.
 * It is plain JavaScript (no type annotations), so it loads whatever pi does with types. */

import { bridgeRuntime, CAPTURE_COMMAND } from "@seshi/kit";

export const EXTENSION_MARKER = "seshi:pi-extension";
export const EXTENSION_VERSION = 4;

export function piExtension(command: readonly string[]): string {
  return `// ${EXTENSION_MARKER} v${EXTENSION_VERSION} -- written by "seshi capture install pi", which rewrites
// it; "seshi capture uninstall pi" removes it, so edits do not last.
//
// Session Capture for pi: when an agent run ends and when the session ends, pi's session file is
// handed to seshi, which uploads it to your team's session store, or leaves it out as your
// capture rules say. The footer shows whether this session is captured;
// /session-capture off|on|status turns it off or on for this session, and /session-capture
// share|unshare lets your team read it (or not). pi started with --no-extensions or --no-session
// captures nothing.

import { spawn } from "node:child_process";

const SESHI = ${JSON.stringify(command)};
const AGENT = "pi";
const STATUS_KEY = "seshi";
// How long quitting pi waits for seshi to take the session that ended.
const SHUTDOWN_TIMEOUT_MS = 3000;

${bridgeRuntime()}

// The session pi is in; undefined when it keeps no session file (--no-session).
function session(ctx) {
  const manager = ctx.sessionManager;
  const file = manager.getSessionFile();
  if (!file) return undefined;
  const header = manager.getHeader();
  return {
    session_id: manager.getSessionId(),
    transcript_path: file,
    cwd: ctx.cwd,
    ...(header && header.parentSession ? { parent_session: header.parentSession } : {}),
  };
}

async function hook(event, ctx, extra, timeoutMs) {
  const which = session(ctx);
  if (!which) return;
  const run = await seshi(["hook", AGENT, event], JSON.stringify({ ...which, ...extra }), {
    cwd: ctx.cwd,
    timeoutMs,
  });
  if (!ctx.hasUI) return;
  for (const message of messages(run.stdout)) ctx.ui.notify(message, "info");
}

async function refresh(ctx) {
  if (!ctx.hasUI) return;
  const which = session(ctx);
  if (!which) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  const run = await seshi(
    ["statusline", "--agent", AGENT],
    JSON.stringify({ session_id: which.session_id, cwd: which.cwd }),
    { cwd: ctx.cwd, env: { NO_COLOR: "1" } },
  );
  const text = run.code === 0 ? run.stdout.trim().split("\\n")[0] : "";
  ctx.ui.setStatus(STATUS_KEY, text || undefined);
}

export default function (pi) {
  // Not awaited: the footer can fill in after pi has started.
  pi.on("session_start", (_event, ctx) => {
    void refresh(ctx);
  });
  // Not awaited either: the next prompt need not wait for seshi. In print mode the session's
  // end, which is awaited, hands it over again before pi exits.
  pi.on("agent_end", (_event, ctx) => {
    void hook("Stop", ctx, {}).then(() => refresh(ctx));
  });
  pi.on("session_shutdown", async (event, ctx) => {
    // /reload restarts the extensions, not the session: it carries on.
    if (event && event.reason === "reload") return;
    await hook("SessionEnd", ctx, {}, SHUTDOWN_TIMEOUT_MS);
  });
  pi.registerCommand("${CAPTURE_COMMAND}", {
    description:
      "Session Capture: turn it off or on for this session, show whether it is captured, or share it with your team (off, on, status, share, unshare)",
    handler: async (args, ctx) => {
      await hook("Command", ctx, { prompt: \`/${CAPTURE_COMMAND} \${args || ""}\`.trim() });
      await refresh(ctx);
    },
  });
}
`;
}
