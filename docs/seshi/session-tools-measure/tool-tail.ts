// Aggregates only: lengths of tool output in local Claude Code and Codex transcripts. Prints
// counts and sums, never text. Answers: of tool results longer than 2,500 characters, how much
// would 4 and 8 KiB caps keep?
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME as string;
function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(dir, n);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (n.endsWith(".jsonl")) yield p;
  }
}

function textOf(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c.map((b) => (typeof b === "string" ? b : (b?.text ?? b?.content ?? ""))).map(textOf).join("\n");
  if (c && typeof c === "object") return textOf((c as { text?: unknown }).text ?? "");
  return "";
}

const lens: number[] = [];
for (const f of walk(join(home, ".claude/projects"))) {
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.includes('"tool_result"')) continue;
    try {
      const r = JSON.parse(line);
      const content = r?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) if (b?.type === "tool_result") lens.push(textOf(b.content).length);
    } catch {}
  }
}
const claude = lens.length;
for (const f of walk(join(home, ".codex/sessions"))) {
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.includes("function_call_output")) continue;
    try {
      const r = JSON.parse(line);
      const p = r?.payload ?? r;
      if (p?.type !== "function_call_output") continue;
      const o = p.output;
      lens.push((typeof o === "string" ? o : textOf(o?.content ?? o)).length);
    } catch {}
  }
}
const nonzero = lens.filter((n) => n > 0).sort((a, b) => a - b);
const pct = (a: number[], q: number) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
const sum = (a: number[], cap = Infinity) => a.reduce((s, n) => s + Math.min(n, cap), 0);
const tail = nonzero.filter((n) => n > 2500);
console.log({
  results: lens.length,
  claude,
  codex: lens.length - claude,
  with_text: nonzero.length,
  p50: pct(nonzero, 0.5),
  p90: pct(nonzero, 0.9),
  p99: pct(nonzero, 0.99),
  max: nonzero.at(-1),
  over_2500_share: tail.length / nonzero.length,
  tail_n: tail.length,
  tail_mean_capped_4k: sum(tail, 4096) / tail.length,
  tail_mean_capped_8k: sum(tail, 8192) / tail.length,
  tail_mean_capped_32k: sum(tail, 32768) / tail.length,
  kept_share_2k: sum(nonzero, 2048) / sum(nonzero),
  kept_share_4k: sum(nonzero, 4096) / sum(nonzero),
  kept_share_8k: sum(nonzero, 8192) / sum(nonzero),
});
