import { readFileSync } from "node:fs";
import {
  captureRules,
  decide,
  otherFolders,
  placeOf,
  readState,
  type StatusLine,
  sessionKey,
  spoolCount,
  stateFacts,
  statusLine,
} from "@seshi/capture/fast";
import { EXIT } from "../cli/exit";
import { takeJson } from "../cli/output";
import { colourLevel, detectTheme, Style } from "../cli/style";
import { pathsOf } from "./capture-host";
import type { CommandContext } from "./index";

export const LABEL = "Session Capture";
export const CAPTURING = "◉";
export const NOT_CAPTURING = "⏸";

const STDIN_TIMEOUT_MS = 1000;

const CHAINED_TIMEOUT_MS = 1500;

async function readPayload(
  ctx: CommandContext,
): Promise<{ text: string; payload: Record<string, unknown> }> {
  if (ctx.tty?.stdin || !ctx.stdin) return { text: "", payload: {} };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), STDIN_TIMEOUT_MS);
  });
  let text = "";
  try {
    text = await Promise.race([ctx.stdin(), timeout]);
    const parsed = text.trim() ? JSON.parse(text) : {};
    const payload =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    return { text, payload };
  } catch {
    return { text, payload: {} };
  } finally {
    clearTimeout(timer);
  }
}

/** The status line someone else set up, which `seshi capture install` moved into `file` so
 * seshi's runs after it (`--chain <file>`): run with the same payload, its output kept. Nothing
 * when the file is gone or unreadable, the command fails, or it is slower than Claude Code
 * waits. */
async function chained(file: string, payload: string, platform: NodeJS.Platform) {
  let command: unknown;
  try {
    command = (JSON.parse(readFileSync(file, "utf8")) as { statusLine?: { command?: unknown } })
      .statusLine?.command;
  } catch {
    return "";
  }
  if (typeof command !== "string" || command.trim() === "") return "";
  const shell =
    platform === "win32"
      ? [process.env.CLAUDE_CODE_GIT_BASH_PATH || "bash", "-c"]
      : ["/bin/sh", "-c"];
  try {
    const proc = Bun.spawn([...shell, command], {
      stdin: new Blob([payload]),
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => proc.kill(), CHAINED_TIMEOUT_MS);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    return (await proc.exited) === 0 ? out.replace(/\s+$/, "") : "";
  } catch {
    return "";
  }
}

/** Another status line's output and seshi's: on one line when the other is one line, else
 * seshi's below it. */
export function joinStatusLines(other: string, ours: string): string {
  if (other === "") return ours;
  return other.includes("\n") ? `${other}\n${ours}` : `${other} · ${ours}`;
}

export function renderStatusLine(line: StatusLine, style: Style): string {
  const glyph = line.capturing ? style.success(CAPTURING) : style.muted(NOT_CAPTURING);
  const problems = line.problems.map((p) => ` · ${style.paint(p.kind, p.text)}`).join("");
  return `${LABEL} ${glyph}${problems}`;
}

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  const agentAt = rest.indexOf("--agent");
  const agent = agentAt === -1 ? "claude-code" : (rest[agentAt + 1] ?? "claude-code");
  const chainAt = rest.indexOf("--chain");
  const chainFile = chainAt === -1 ? undefined : rest[chainAt + 1];
  const { host, paths } = pathsOf(ctx);
  const { text, payload } = await readPayload(ctx);
  const other = chainFile && !json ? chained(chainFile, text, host.platform) : Promise.resolve("");
  const workspace = payload.workspace as { current_dir?: unknown } | undefined;
  const cwd =
    (typeof payload.cwd === "string" && payload.cwd) ||
    (typeof workspace?.current_dir === "string" && workspace.current_dir) ||
    process.cwd();
  const session = typeof payload.session_id === "string" ? payload.session_id : undefined;
  const key = session ? sessionKey(agent, session) : undefined;

  let state: ReturnType<typeof readState> | undefined;
  try {
    state = readState(paths);
  } catch {
    state = undefined;
  }
  const snapshot = await captureRules(host, paths);
  const known = key ? state?.sessions[key] : undefined;
  const decision = decide(
    {
      rules: snapshot.rules,
      ...(snapshot.error ? { rulesError: snapshot.error } : {}),
      place: placeOf(cwd),
      ...(state ? stateFacts(state, agent, known, new Date()) : {}),
      seen: otherFolders(state, agent, known, cwd).map(placeOf),
    },
    host.platform,
  );
  const line = statusLine({
    state,
    decision,
    spooled: spoolCount(paths),
    ...(key ? { session: key } : {}),
  });
  if (json) {
    ctx.stdout(
      JSON.stringify({
        capturing: line.capturing,
        level: decision.level,
        reason: decision.reason,
        ...(decision.frozen !== undefined ? { frozen_at: decision.frozen } : {}),
        problems: line.problems.map((p) => p.text),
      }),
    );
    return EXIT.ok;
  }
  const level = colourLevel({ env: ctx.env, tty: true, noColor: ctx.noColor });
  const theme =
    level === "none"
      ? "dark"
      : await detectTheme({ env: ctx.env, ...(snapshot.theme ? { setting: snapshot.theme } : {}) });
  ctx.stdout(joinStatusLines(await other, renderStatusLine(line, new Style(level, theme))));
  return EXIT.ok;
}
