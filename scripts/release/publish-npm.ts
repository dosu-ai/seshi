import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export type Exec = (argv: string[]) => Promise<{ code: number; out: string; err: string }>;

export interface PublishOptions {
  dir: string;
  provenance?: boolean;
  dryRun?: boolean;
  exec?: Exec;
  log?: (line: string) => void;
}

export interface Published {
  name: string;
  version: string;
  action: "published" | "skipped";
}

export const spawnNpm: Exec = async (argv) => {
  const proc = Bun.spawn(["npm", ...argv], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, out, err };
};

export function distTag(version: string): string {
  return version.includes("-") ? "next" : "latest";
}

/** Whether `name@version` is on the registry. `npm view` exits non-zero with E404 when not;
 * any other failure is an error, so a registry outage never reads as "not published". */
export async function isPublished(exec: Exec, name: string, version: string): Promise<boolean> {
  const { code, out, err } = await exec(["view", `${name}@${version}`, "version", "--json"]);
  if (code === 0) return out.trim() !== "";
  if (/E404|404 Not Found|is not in this registry/.test(err + out)) return false;
  throw new Error(`npm view ${name}@${version} failed (${code}): ${err.trim() || out.trim()}`);
}

export async function publishAll(options: PublishOptions): Promise<Published[]> {
  const exec = options.exec ?? spawnNpm;
  const log = options.log ?? (() => {});
  const order = JSON.parse(readFileSync(join(options.dir, "packages.json"), "utf8")) as {
    name: string;
    dir: string;
  }[];
  const results: Published[] = [];
  for (const entry of order) {
    const dir = resolve(options.dir, entry.dir);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (manifest.name !== entry.name) {
      throw new Error(`${dir}/package.json is ${manifest.name}, expected ${entry.name}`);
    }
    if (manifest.private) throw new Error(`${entry.name} is private; refusing to publish it`);
    const version = manifest.version as string;
    if (await isPublished(exec, entry.name, version)) {
      log(`${entry.name}@${version}: already published`);
      results.push({ name: entry.name, version, action: "skipped" });
      continue;
    }
    const argv = ["publish", dir, "--access", "public", "--tag", distTag(version)];
    if (options.provenance) argv.push("--provenance");
    if (options.dryRun) argv.push("--dry-run");
    const { code, out, err } = await exec(argv);
    if (code !== 0) {
      throw new Error(`npm publish ${entry.name}@${version} failed (${code}):\n${out}${err}`);
    }
    log(`${entry.name}@${version}: ${options.dryRun ? "dry run" : "published"}`);
    results.push({ name: entry.name, version, action: "published" });
  }
  return results;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      dir: { type: "string" },
      provenance: { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
    strict: true,
  });
  try {
    await publishAll({
      dir: resolve(values.dir ?? join(import.meta.dirname, "../../dist/npm")),
      provenance: values.provenance === true,
      dryRun: values["dry-run"] === true,
      log: (line) => console.log(`npm: ${line}`),
    });
  } catch (err) {
    console.error(`npm: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
