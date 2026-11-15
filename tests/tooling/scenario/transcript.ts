/** Synthetic Claude Code turns, in the shape `.claude/skills/verify-seshi/scripts/transcript.ts`
 * writes them: per turn a user message, an assistant message with a tool call, the tool result
 * and a closing assistant message, one JSON line each. Two turns pass the server's session filter
 * (about 2,000 characters); one does not. No model runs. */

/** The fake credentials `secret: true` plants, each split so no scanner reads it here. The
 * built-in pack redacts all three (aws-access-key, credential, github-token). */
export const SECRETS = [
  `${"AKIA"}IOSFODNN7EXAMPLE`,
  `${"hunter2"}secretvalue42`,
  `${"gh"}p_${"abcdefghijklmnopqrstuvwx0123456789"}`,
] as const;

export interface TurnOptions {
  sessionId: string;
  cwd: string;
  count: number;
  /** Plant `SECRETS` in the first new turn. */
  secret?: boolean;
  /** A word put in every new user message, for `bucket: { lacks: … }` and `reviewed`. */
  mark?: string;
  /** For subagents: the parent's session id, which Claude Code writes as `sessionId`. */
  parentId?: string;
  now: () => Date;
}

/** Turns numbered from `first`, as JSON lines. */
export function turnLines(first: number, options: TurnOptions): string {
  const { cwd, count, secret, mark } = options;
  const sessionId = options.parentId ?? options.sessionId;
  let tick = 0;
  const base = options.now().getTime();
  const stamp = () => new Date(base + 1000 * tick++).toISOString();
  const lines: unknown[] = [];
  for (let i = first; i < first + count; i++) {
    let ask = `Turn ${i}: refactor module ${i} and explain the change. ${"context ".repeat(80)}`;
    if (mark) ask += ` [${mark}]`;
    if (secret && i === first) {
      ask += ` my aws key is ${SECRETS[0]} and password: "${SECRETS[1]}"`;
    }
    lines.push({
      type: "user",
      uuid: `u${i}`,
      timestamp: stamp(),
      cwd,
      gitBranch: "main",
      sessionId,
      message: { role: "user", content: ask },
    });
    lines.push({
      type: "assistant",
      uuid: `a${i}`,
      timestamp: stamp(),
      sessionId,
      message: {
        role: "assistant",
        model: "claude-scenario",
        content: [
          {
            type: "text",
            text: `Reading module ${i}.${secret && i === first ? ` Token ${SECRETS[2]} found.` : ""}`,
          },
          {
            type: "tool_use",
            id: `toolu_${i}`,
            name: "Read",
            input: { file_path: `${cwd}/m${i}.ts` },
          },
        ],
      },
    });
    lines.push({
      type: "user",
      uuid: `r${i}`,
      timestamp: stamp(),
      sessionId,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `toolu_${i}`,
            content: `export const M${i} = ${i};\n`,
          },
        ],
      },
    });
    lines.push({
      type: "assistant",
      uuid: `b${i}`,
      timestamp: stamp(),
      sessionId,
      message: {
        role: "assistant",
        model: "claude-scenario",
        content: [
          {
            type: "text",
            text: `Module ${i} now exports a typed constant. ${"detail ".repeat(40)}`,
          },
        ],
      },
    });
  }
  return lines.map((l) => `${JSON.stringify(l)}\n`).join("");
}

/** Lines per turn. */
export const LINES_PER_TURN = 4;

/** A compaction summary, as Claude Code writes one after `/compact`: a user message marked as
 * the summary, then the assistant going on. */
export function summaryLines(sessionId: string, cwd: string, now: () => Date, n: number): string {
  const at = now().toISOString();
  return [
    {
      type: "user",
      uuid: `s${n}`,
      timestamp: at,
      cwd,
      gitBranch: "main",
      sessionId,
      isCompactSummary: true,
      message: {
        role: "user",
        content: `This session is being continued from a previous conversation. Summary ${n}: ${"summary ".repeat(60)}`,
      },
    },
    {
      type: "assistant",
      uuid: `sa${n}`,
      timestamp: at,
      sessionId,
      message: {
        role: "assistant",
        model: "claude-scenario",
        content: [{ type: "text", text: `Continuing after the summary. ${"detail ".repeat(20)}` }],
      },
    },
  ]
    .map((l) => `${JSON.stringify(l)}\n`)
    .join("");
}
