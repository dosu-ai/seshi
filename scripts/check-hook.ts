/** The hook budget (X3.3), run by `bun run check:hook` in CI. `seshi hook` runs on every agent
 * turn, so it must start fast and must never evaluate the server, protobuf or search code. Two
 * checks:
 *
 * 1. The static import graph. From the binary's entry point and the `hook` and `statusline`
 *    command modules, every import that runs at load time is followed (`import type` and
 *    `import()` are not: types are erased and dynamic imports are lazy). Reaching a package on
 *    the forbidden list fails, with the chain of files that got there.
 * 2. The time. `seshi hook claude-code Stop` runs several times, with a Stop payload on stdin in
 *    a temporary home (rules judged, spool written, no uploader started), and its median must
 *    stay under
 *    a fixed budget (`--budget-ms`, `SESHI_HOOK_BUDGET_MS`, 250 ms by default). Run from source
 *    it must also take under half of what loading `seshi serve` takes, measured the same way,
 *    so a slow CI machine moves both. `--binary dist/seshi` times the compiled binary instead;
 *    there the bundle is loaded whole, so only the budget applies (the graph check still
 *    guarantees the server code is not evaluated).
 *
 *   bun run scripts/check-hook.ts [--static-only] [--binary <path>] [--budget-ms <n>] [--runs <n>] */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript";

/** What `seshi hook` and `seshi statusline` may never load at start-up. */
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
  // Capture's fast path (14): the config schema library, the HTTP client and the transcript
  // adapters stay out of a hook; the rules come from capture's cache.
  "zod",
  "@seshi/client",
  "@seshi/formats",
  "@letta-ai/trajectory",
  // Pre-redaction (07 wired in 14) runs in the uploader only: rule packs and RE2 never load in
  // a hook.
  "@seshi/redact",
  "re2js",
];

/** The modules a hook evaluates first: the router, the two fast commands, and the agents'
 * capture modules (a hook loads the one it is called for, with `import()`). */
export const HOOK_ENTRIES = [
  "apps/seshi/src/main.ts",
  "apps/seshi/src/commands/hook.ts",
  "apps/seshi/src/commands/statusline.ts",
  "integrations/claude-code/src/capture.ts",
  "integrations/codex/src/capture.ts",
  "integrations/cursor/src/local/capture.ts",
];

/** The specifiers a file imports at load time: static imports and re-exports, never
 * `import type`, `export type` or `import()`. */
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

/** Workspace packages by name: their folder and their `exports` map. */
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

/** The file a relative import names: as written, with `.ts`, or its folder's `index.ts`. */
function withExtension(path: string): string | undefined {
  for (const candidate of [path, `${path}.ts`, `${path}.tsx`, join(path, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return undefined;
}

export interface GraphResult {
  /** Files reached, relative to the root. */
  files: string[];
  /** Bare specifiers reached that are not workspace packages (npm packages, `node:` modules). */
  external: string[];
  /** Forbidden packages reached, each with the chain of files that imports it. */
  violations: { specifier: string; chain: string[] }[];
}

/** Walk the load-time import graph from `entries` (relative to `root`). */
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

/** The median wall time of `runs` runs of `command`, in milliseconds, with `stdin` as its input
 * and `env` as its environment when given. */
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
  // A real hook's work: a temporary home with a transcript, a Stop payload on stdin, the rules
  // judged and the spool written; no uploader is started.
  const home = mkdtempSync(join(tmpdir(), "seshi-hook-budget-"));
  const transcript = join(home, "session.jsonl");
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: "user", uuid: "u1", sessionId: "s1", message: { role: "user", content: "hi" } })}\n`,
  );
  const hookEnv = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
    XDG_CONFIG_HOME: join(home, "config"),
    SESHI_NO_UPLOADER: "1",
  };
  const payload = JSON.stringify({
    session_id: "s1",
    transcript_path: transcript,
    cwd: home,
    hook_event_name: "Stop",
  });
  const hookRun = { stdin: payload, env: hookEnv };
  // Warm the file cache and capture's rules cache once, so the first measured run is neither
  // the disk's nor the config loader's.
  await medianMs([...seshi, "--version"], 1, root);
  await medianMs([...seshi, "hook", "claude-code", "Stop"], 1, root, hookRun);
  const hook = await medianMs([...seshi, "hook", "claude-code", "Stop"], runs, root, hookRun);
  rmSync(home, { recursive: true, force: true });
  // `serve --bogus` loads the whole server, then stops at the flag.
  const serve = await medianMs([...seshi, "serve", "--bogus-flag"], runs, root);
  console.log(
    `hook: seshi hook ${hook.toFixed(1)} ms (median of ${runs}); loading serve ${serve.toFixed(1)} ms; budget ${budget} ms`,
  );
  const problems: string[] = [];
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
