/** The pi extension `seshi capture install pi` writes to `~/.pi/agent/extensions/seshi.ts`.
 *
 * pi runs no shell hooks: it loads extensions, TypeScript modules it imports (through jiti) at
 * start-up, in every mode (interactive, print, JSON, RPC). This one hands pi's lifecycle events
 * to `seshi hook pi <event>` with a JSON payload on stdin, the way an agent's own hooks do, so
 * capture works as it does for Claude Code: the rules, the spool and the uploader are seshi's.
 * It is plain JavaScript (no type annotations), so it loads whatever pi does with types. */

export const EXTENSION_MARKER = "seshi:pi-extension";
export const EXTENSION_VERSION = 1;

export function piExtension(command: readonly string[]): string {
  return `// ${EXTENSION_MARKER} v${EXTENSION_VERSION} -- written by "seshi capture install pi", which rewrites
// it; "seshi capture uninstall pi" removes it, so edits do not last.
//
// Session Capture for pi: when an agent run ends and when the session ends, pi's session file is
// handed to seshi, which uploads it to your team's session store, or leaves it out as your
// capture rules say. The footer shows whether this session is captured, and
// /seshi off|on|status turns it off or on for this session. pi started with --no-extensions or
// --no-session captures nothing.

import { spawn } from "node:child_process";

const SESHI = ${JSON.stringify(command)};
const AGENT = "pi";
const STATUS_KEY = "seshi";
const HOOK_TIMEOUT_MS = 10000;
// How long quitting pi waits for seshi to take the session that ended.
const SHUTDOWN_TIMEOUT_MS = 3000;

// seshi's own variables, inherited from a shell another agent started (a Claude Code session
// sets them), name that agent's session, not this one.
function environment(extra) {
  const env = { ...process.env, ...extra };
  delete env.SESHI_SESSION_ID;
  delete env.SESHI_AGENT;
  return env;
}

function quoted(word) {
  return /^[\\w@%+=:,./\\\\-]+$/.test(word) ? word : \`"\${word.replace(/"/g, '\\\\"')}"\`;
}

// Run seshi with input on stdin. Never rejects: a missing or failing seshi is an exit code.
function seshi(args, input, options) {
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
    }, options.timeoutMs ?? HOOK_TIMEOUT_MS);
    try {
      child = shell
        ? spawn([program, ...rest, ...args].map(quoted).join(" "), {
            cwd: options.cwd,
            env: environment(options.env),
            shell: true,
            stdio: ["pipe", "pipe", "ignore"],
            windowsHide: true,
          })
        : spawn(program, [...rest, ...args], {
            cwd: options.cwd,
            env: environment(options.env),
            stdio: ["pipe", "pipe", "ignore"],
            windowsHide: true,
          });
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
  pi.on("agent_end", async (_event, ctx) => {
    await hook("Stop", ctx, {});
    void refresh(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    await hook("SessionEnd", ctx, {}, SHUTDOWN_TIMEOUT_MS);
  });
  pi.registerCommand("seshi", {
    description: "Session Capture: turn it off or on for this session, or show whether it is captured",
    handler: async (args, ctx) => {
      await hook("Command", ctx, { prompt: \`/seshi \${args || ""}\`.trim() });
      await refresh(ctx);
    },
  });
}
`;
}
