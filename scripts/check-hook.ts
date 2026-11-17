import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript";

export const FORBIDDEN: readonly (string | RegExp)[] = [
  "@seshi/api",
  "@seshi/instance",
  "@seshi/sources",
  "@seshi/search",
  "@seshi/pipeline",
  "@seshi/auth",
  "@seshi/store",
  "jose",
  "@seshi/review",
  "@anthropic-ai/sdk",
  /protobuf|@bufbuild\//,
  "zod",
  "@seshi/client",
  "@seshi/formats",
  "@letta-ai/trajectory",
  "@seshi/redact",
  "re2js",
];

export const HOOK_ENTRIES = [
  "apps/seshi/src/main.ts",
  "apps/seshi/src/commands/hook.ts",
  "apps/seshi/src/commands/statusline.ts",
  "integrations/claude-code/src/capture.ts",
  "integrations/codex/src/capture.ts",
  "integrations/cursor/src/local/capture.ts",
  "integrations/opencode/src/capture.ts",
  "integrations/pi/src/capture.ts",
];

export function loadTimeImports(text: string, fileName = "x.ts"): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  const out: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.isTypeOnly) continue;
      out.push((statement.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      if (statement.isTypeOnly) continue;
      out.push((statement.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly) {
      const ref = statement.moduleReference;
      if (ts.isExternalModuleReference(ref) && ts.isStringLiteral(ref.expression)) {
        out.push(ref.expression.text);
      }
    }
  }
  return out;
}

function workspacePackages(root: string): Map<string, { dir: string; exports: unknown }> {
  const found = new Map<string, { dir: string; exports: unknown }>();
  const scan = (parent: string) => {
    if (!existsSync(parent)) return;
    for (const name of new Bun.Glob("*/package.json").scanSync({ cwd: parent })) {
      const dir = join(parent, dirname(name));
      const manifest = JSON.parse(readFileSync(join(parent, name), "utf8")) as {
        name?: string;
        exports?: unknown;
      };
      if (manifest.name) found.set(manifest.name, { dir, exports: manifest.exports });
    }
  };
  scan(join(root, "apps"));
  scan(join(root, "packages", "ts"));
  scan(join(root, "integrations"));
  return found;
}

function withExtension(path: string): string | undefined {
  for (const candidate of [path, `${path}.ts`, `${path}.tsx`, join(path, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return undefined;
}

export interface GraphResult {
  files: string[];
  external: string[];
  violations: { specifier: string; chain: string[] }[];
}

export function importGraph(
  root: string,
  entries: readonly string[] = HOOK_ENTRIES,
  forbidden: readonly (string | RegExp)[] = FORBIDDEN,
): GraphResult {
  const absolute = resolve(root);
  const packages = workspacePackages(absolute);
  const parent = new Map<string, string | undefined>();
  const external = new Set<string>();
  const violations: GraphResult["violations"] = [];
  const queue: string[] = [];

  const isForbidden = (specifier: string) =>
    forbidden.some((f) =>
      typeof f === "string" ? specifier === f || specifier.startsWith(`${f}/`) : f.test(specifier),
    );
  const chainOf = (file: string): string[] => {
    const chain: string[] = [];
    for (let at: string | undefined = file; at !== undefined; at = parent.get(at)) {
      chain.unshift(relative(absolute, at));
    }
    return chain;
  };
  const visit = (file: string, from: string | undefined) => {
    if (parent.has(file)) return;
    parent.set(file, from);
    queue.push(file);
  };

  for (const entry of entries) {
    if (existsSync(join(absolute, entry))) visit(join(absolute, entry), undefined);
  }
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const specifier of loadTimeImports(readFileSync(file, "utf8"), file)) {
      if (isForbidden(specifier)) {
        violations.push({ specifier, chain: chainOf(file) });
        continue;
      }
      if (specifier.startsWith(".")) {
        const target = withExtension(resolve(dirname(file), specifier));
        if (target) visit(target, file);
        continue;
      }
      const parts = specifier.split("/");
      const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
      const pkg = packages.get(name);
      if (!pkg) {
        external.add(specifier);
        continue;
      }
      const subpath = `.${specifier.slice(name.length)}` || ".";
      const exported = (pkg.exports as Record<string, { bun?: string } | string> | undefined)?.[
        subpath === "." ? "." : subpath
      ];
      const path = typeof exported === "string" ? exported : exported?.bun;
      if (path) visit(join(pkg.dir, path), file);
    }
  }
  return {
    files: [...parent.keys()].map((f) => relative(absolute, f)).sort(),
    external: [...external].sort(),
    violations,
  };
}

export function hookEnv(
  base: Record<string, string | undefined>,
  home: string,
): Record<string, string | undefined> {
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith("SESHI_")));
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_STATE_HOME: join(home, "state"),
    LOCALAPPDATA: join(home, "state"),
    XDG_CONFIG_HOME: join(home, "config"),
    APPDATA: join(home, "config"),
    SESHI_NO_UPLOADER: "1",
  };
}

export function spoolEntries(dir: string): number {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

export async function medianMs(
  command: string[],
  runs: number,
  cwd: string,
  options: { stdin?: string; env?: Record<string, string | undefined> } = {},
): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    const proc = Bun.spawn(command, {
      cwd,
      stdout: "ignore",
      stderr: "ignore",
      stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
      ...(options.env ? { env: options.env } : {}),
    });
    await proc.exited;
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)] as number;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "static-only": { type: "boolean" },
      binary: { type: "string" },
      "budget-ms": { type: "string" },
      runs: { type: "string" },
    },
    strict: true,
  });
  const root = resolve(import.meta.dir, "..");
  const graph = importGraph(root);
  for (const v of graph.violations) {
    console.error(`hook: '${v.specifier}' is loaded at start-up through ${v.chain.join(" → ")}`);
  }
  if (graph.violations.length > 0) {
    console.error(
      "hook: seshi hook must not load server, pipeline, store or search code (X3.3); import it lazily with await import()",
    );
    process.exit(1);
  }
  console.log(`hook: imports ok (${graph.files.length} files, ${graph.external.length} external)`);
  if (values["static-only"]) process.exit(0);

  const runs = Number(values.runs ?? 7);
  const budget = Number(values["budget-ms"] ?? process.env.SESHI_HOOK_BUDGET_MS ?? 250);
  const seshi = values.binary
    ? [resolve(values.binary)]
    : ["bun", join(root, "apps/seshi/src/main.ts")];
  const home = mkdtempSync(join(tmpdir(), "seshi-hook-budget-"));
  const transcript = join(home, "session.jsonl");
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: "user", uuid: "u1", sessionId: "s1", message: { role: "user", content: "hi" } })}\n`,
  );
  const payload = JSON.stringify({
    session_id: "s1",
    transcript_path: transcript,
    cwd: home,
    hook_event_name: "Stop",
  });
  const env = hookEnv(process.env, home);
  const hookRun = { stdin: payload, env };
  await medianMs([...seshi, "--version"], 1, root, { env });
  await medianMs([...seshi, "hook", "claude-code", "Stop"], 1, root, hookRun);
  const hook = await medianMs([...seshi, "hook", "claude-code", "Stop"], runs, root, hookRun);
  const spooled = spoolEntries(join(home, "state", "seshi", "spool"));
  const captureLog = join(home, "state", "seshi", "capture.log");
  const hookLog = existsSync(captureLog) ? readFileSync(captureLog, "utf8") : "";
  const serve = await medianMs([...seshi, "serve", "--bogus-flag"], runs, root, { env });
  rmSync(home, { recursive: true, force: true });
  console.log(
    `hook: seshi hook ${hook.toFixed(1)} ms (median of ${runs}); loading serve ${serve.toFixed(1)} ms; budget ${budget} ms`,
  );
  const problems: string[] = [];
  if (spooled === 0) {
    problems.push(
      `seshi hook spooled nothing, so it did not do a hook's work${hookLog ? `:\n${hookLog}` : ""}`,
    );
  }
  if (hook > budget)
    problems.push(`seshi hook took ${hook.toFixed(1)} ms, over the ${budget} ms budget`);
  if (!values.binary && hook > serve * 0.5) {
    problems.push(
      `seshi hook took ${hook.toFixed(1)} ms, more than half of loading serve (${serve.toFixed(1)} ms): something heavy is loaded at start-up`,
    );
  }
  for (const problem of problems) console.error(`hook: ${problem}`);
  process.exit(problems.length > 0 ? 1 : 0);
}
