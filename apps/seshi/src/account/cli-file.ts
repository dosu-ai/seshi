import { readFileSync } from "node:fs";
import { type CliConfig, loadCliConfig } from "@seshi/config";
import { writePrivateFile } from "./secrets";

export function setTopLevelKey(text: string, key: string, value: string): string {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const assignment = `${key} = ${JSON.stringify(value)}`;
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = 0; i < end; i++) {
    if (pattern.test(lines[i] as string)) {
      lines[i] = assignment;
      return `${lines.join("\n")}\n`;
    }
  }
  if (firstTable === -1) {
    lines.push(assignment);
  } else {
    lines.splice(firstTable, 0, assignment, "");
  }
  return `${lines.join("\n")}\n`;
}

export function writeCliKeyIfValid(
  path: string,
  key: "server" | "user",
  value: string,
  env: Record<string, string | undefined>,
): CliConfig {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const next = setTopLevelKey(text, key, value);
  const loaded = loadCliConfig({
    file: path,
    env,
    fs: { readFile: () => next, mode: () => 0o100600 },
  });
  writePrivateFile(path, next);
  return loaded.config;
}

type TableValue = string | boolean;

/** Remove a top-level key and the named tables from a CLI config's text. */
function withoutKeyAndTables(text: string, key: string, tables: readonly string[]): string[] {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const keep: string[] = [];
  let inTable: string | undefined;
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      inTable = (header[1] as string).trim();
      skipping = tables.includes(inTable);
      if (skipping) continue;
    }
    if (skipping) continue;
    if (inTable === undefined && new RegExp(`^\\s*${key}\\s*=`).test(line)) continue;
    keep.push(line);
  }
  while (keep.length > 0 && keep.at(-1)?.trim() === "") keep.pop();
  return keep;
}

function tableText(name: string, values: Record<string, TableValue | undefined>): string[] {
  const out = [`[${name}]`];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) out.push(`${key} = ${JSON.stringify(value)}`);
  }
  return out;
}

/** Point the CLI config at a serverless bucket (`seshi init --serverless`): write
 * `[serverless]` and `[search]`, dropping `server` and the old `[local]`. Checked before it is
 * written, as `writeCliKeyIfValid` does. */
export function writeServerlessConfig(
  path: string,
  serverless: Record<string, string | undefined>,
  search: Record<string, TableValue | undefined>,
  env: Record<string, string | undefined>,
): { config: CliConfig; droppedServer?: string } {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const before = loadCliConfig({
    file: path,
    env: {},
    fs: { readFile: () => text, mode: () => 0o100600 },
  }).config;
  const kept = withoutKeyAndTables(text, "server", ["local", "serverless", "search"]);
  const next = [
    ...kept,
    ...(kept.length > 0 ? [""] : []),
    ...tableText("serverless", serverless),
    "",
    ...tableText("search", search),
  ].join("\n");
  const written = `${next}\n`;
  const loaded = loadCliConfig({
    file: path,
    env,
    fs: { readFile: () => written, mode: () => 0o100600 },
  });
  writePrivateFile(path, written);
  return {
    config: loaded.config,
    ...(before.server !== undefined ? { droppedServer: before.server } : {}),
  };
}
