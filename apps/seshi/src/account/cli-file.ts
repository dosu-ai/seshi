/** Setting one top-level key in the CLI's own config file (`server` after `seshi login
 * --server`, `user` after `--user`), leaving everything else in it (comments, tables, order) as
 * written. The result is loaded before it is written, so a change never leaves a config the
 * CLI cannot read. */

import { readFileSync } from "node:fs";
import { type CliConfig, loadCliConfig } from "@seshi/config";
import { writePrivateFile } from "./secrets";

/** `text` with `key = "value"` set at the top level: an existing assignment before the first
 * table is replaced; otherwise it is added before the first table. */
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

/** Set `key` in the CLI config file at `path` (created if missing). Throws the loader's
 * `ConfigError` when the result would not load, writing nothing. */
export function writeCliKey(
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
