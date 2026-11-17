import { readFileSync } from "node:fs";
import {
  captureRules,
  currentSession,
  decide,
  otherFolders,
  placeOf,
  readRecent,
  readState,
  type StatusLine,
  sessionKey,
  sessionWord,
  spoolCount,
  stateFacts,
  statusLine,
} from "@seshi/capture/fast";
import { cliConfigPath } from "@seshi/config/paths";
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

/** Every value of a repeatable `--name <value>` flag. */
function values(rest: readonly string[], name: string): string[] {
  const out: string[] = [];
  rest.forEach((word, i) => {
    const next = rest[i + 1];
    if (word === name && next !== undefined) out.push(next);
  });
  return out;
}

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  const agentAt = rest.indexOf("--agent");
  const agent = agentAt === -1 ? "claude-code" : (rest[agentAt + 1] ?? "claude-code");
  const chainAt = rest.indexOf("--chain");
  const chainFile = chainAt === -1 ? undefined : rest[chainAt + 1];
  // An editor asking about its workspace (`--folder`, repeatable), with the conversation it says
  // has focus (`--session`) and those it says are open (`--selected a,b`), instead of an
  // agent's status line payload on stdin.
  const folders = values(rest, "--folder");
  const editor = folders.length > 0;
  const focused = values(rest, "--session")[0];
  const selected = values(rest, "--selected")
    .flatMap((v) => v.split(","))
    .filter(Boolean);
  const { host, paths } = pathsOf(ctx);
  const { text, payload } = editor ? { text: "", payload: {} } : await readPayload(ctx);
  const other = chainFile && !json ? chained(chainFile, text, host.platform) : Promise.resolve("");
  const workspace = payload.workspace as { current_dir?: unknown } | undefined;

  let state: ReturnType<typeof readState> | undefined;
  try {
    state = readState(paths);
  } catch {
    state = undefined;
  }
  const now = new Date();
  const current = editor
    ? currentSession({
        state,
        agent,
        folders,
        recent: readRecent(paths, agent, folders, host.platform),
        ...(focused ? { focused } : {}),
        selected,
        now,
        platform: host.platform,
      })
    : undefined;
  const session = editor
    ? current?.session?.session_id
    : typeof payload.session_id === "string"
      ? payload.session_id
      : undefined;
  const key = session ? sessionKey(agent, session) : undefined;
  const known = key ? state?.sessions[key] : undefined;
  const cwd = editor
    ? (known?.cwd ?? (folders[0] as string))
    : (typeof payload.cwd === "string" && payload.cwd) ||
      (typeof workspace?.current_dir === "string" && workspace.current_dir) ||
      process.cwd();

  const snapshot = await captureRules(host, paths);
  const decision = decide(
    {
      rules: snapshot.rules,
      ...(snapshot.error ? { rulesError: snapshot.error } : {}),
      place: placeOf(cwd),
      ...(state ? stateFacts(state, agent, known, now) : {}),
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
    const worst = line.problems.some((p) => p.kind === "error")
      ? "error"
      : line.problems.some((p) => p.kind === "warn")
        ? "warn"
        : null;
    ctx.stdout(
      JSON.stringify({
        capturing: line.capturing,
        level: decision.level,
        reason: decision.reason,
        ...(decision.frozen !== undefined ? { frozen_at: decision.frozen } : {}),
        problems: line.problems.map((p) => p.text),
        ...(editor && current
          ? {
              session: current.session
                ? {
                    ...current.session,
                    ...(known ? { state: sessionWord(known) } : {}),
                  }
                : null,
              candidates: current.candidates,
              attention: worst,
              installed: state?.agents[agent] !== undefined,
              watch: [
                paths.dir,
                paths.recent,
                cliConfigPath({ env: host.env, home: host.home, platform: host.platform }),
              ],
            }
          : {}),
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
