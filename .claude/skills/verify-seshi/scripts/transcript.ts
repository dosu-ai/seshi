#!/usr/bin/env bun
/**
 * Append synthetic Claude Code turns to a transcript, as the agent writes them: one JSON line
 * per user message, assistant message, tool call and tool result. Each turn is long enough that
 * a few of them pass the server's session filter (about 2,000 characters).
 *
 *   bun transcript.ts <path> <session-id> <cwd> [--turns N] [--secret]
 *
 * Numbering continues from the lines already in the file, so calling it again extends the
 * session the way a later turn does. `--secret` puts known fake credentials in the first new
 * turn: AKIAIOSFODNN7EXAMPLE, password: "hunter2secretvalue42" and a ghp_ token.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const [path, session, cwd, ...rest] = process.argv.slice(2);
if (!path || !session || !cwd) {
  console.error("usage: bun transcript.ts <path> <session-id> <cwd> [--turns N] [--secret]");
  process.exit(2);
}
const at = rest.indexOf("--turns");
const turns = at === -1 ? 4 : Number(rest[at + 1]);
const secret = rest.includes("--secret");
if (!Number.isInteger(turns) || turns < 1) {
  console.error("--turns takes a positive whole number");
  process.exit(2);
}

mkdirSync(dirname(path), { recursive: true });
const existing = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
const first = Math.floor(existing.length / 4);
const start = Date.now() - 60_000;
let tick = existing.length;
const stamp = () => new Date(start + 1000 * tick++).toISOString();

const lines: unknown[] = [];
for (let i = first; i < first + turns; i++) {
  let ask = `Turn ${i}: refactor module ${i} and explain the change. ${"context ".repeat(40)}`;
  if (secret && i === first) {
    ask += ' my aws key is AKIAIOSFODNN7EXAMPLE and password: "hunter2secretvalue42"';
  }
  lines.push({
    type: "user",
    uuid: `u${i}`,
    timestamp: stamp(),
    cwd,
    gitBranch: "main",
    sessionId: session,
    message: { role: "user", content: ask },
  });
  lines.push({
    type: "assistant",
    uuid: `a${i}`,
    timestamp: stamp(),
    sessionId: session,
    message: {
      role: "assistant",
      model: "claude-verify",
      content: [
        {
          type: "text",
          text: `Reading module ${i}.${secret && i === first ? " Token ghp_abcdefghijklmnopqrstuvwxyz012345 found." : ""}`,
        },
        { type: "tool_use", id: `toolu_${i}`, name: "Read", input: { file_path: `${cwd}/m${i}.ts` } },
      ],
    },
  });
  lines.push({
    type: "user",
    uuid: `r${i}`,
    timestamp: stamp(),
    sessionId: session,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: `export const M${i} = ${i};\n` }],
    },
  });
  lines.push({
    type: "assistant",
    uuid: `b${i}`,
    timestamp: stamp(),
    sessionId: session,
    message: {
      role: "assistant",
      model: "claude-verify",
      content: [{ type: "text", text: `Module ${i} now exports a typed constant. ${"detail ".repeat(20)}` }],
    },
  });
}
appendFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
console.log(`${path}: ${existing.length + lines.length} lines (turns ${first}..${first + turns - 1})`);
