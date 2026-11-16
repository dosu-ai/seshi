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

async function readPayload(ctx: CommandContext): Promise<Record<string, unknown>> {
  if (ctx.tty?.stdin || !ctx.stdin) return {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), STDIN_TIMEOUT_MS);
  });
  try {
    const text = await Promise.race([ctx.stdin(), timeout]);
    const parsed = text.trim() ? JSON.parse(text) : {};
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
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
  const { host, paths } = pathsOf(ctx);
  const payload = await readPayload(ctx);
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
  ctx.stdout(renderStatusLine(line, new Style(level, theme)));
  return EXIT.ok;
}
