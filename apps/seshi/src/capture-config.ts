/** Editing the capture rules in the CLI's own config (F9.5): `seshi capture off|on` with no
 * session turns the global level (`[capture] enabled`), and with `--path` sets a folder rule
 * (`[[capture.paths]]`). Everything else in the file (comments, order, other tables) is left as
 * written, and the result is loaded with the CLI config's own loader before it is written, so a
 * change never leaves a config the CLI cannot read. */

import { readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { type CliConfig, loadCliConfig } from "@seshi/config";
import { writePrivateFile } from "./account/secrets";

const HEADER = /^\s*\[/;

/** `text` with `key = <literal>` set in `[table]`: replaced where it is, added under the
 * table's header, or a new table added (before any `[[table.…]]`, so the file stays valid). */
export function setTableKey(text: string, table: string, key: string, literal: string): string {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const header = new RegExp(`^\\s*\\[\\s*${table.replace(/\./g, "\\.")}\\s*\\]\\s*(#.*)?$`);
  const assignment = `${key} = ${literal}`;
  const at = lines.findIndex((line) => header.test(line));
  if (at !== -1) {
    const pattern = new RegExp(`^\\s*${key}\\s*=`);
    let end = lines.findIndex((line, i) => i > at && HEADER.test(line));
    if (end === -1) end = lines.length;
    for (let i = at + 1; i < end; i++) {
      if (pattern.test(lines[i] as string)) {
        lines[i] = assignment;
        return `${lines.join("\n")}\n`;
      }
    }
    lines.splice(at + 1, 0, assignment);
    return `${lines.join("\n")}\n`;
  }
  const sub = lines.findIndex((line) =>
    new RegExp(`^\\s*\\[\\[?\\s*${table.replace(/\./g, "\\.")}\\.`).test(line),
  );
  const block = [`[${table}]`, assignment, ""];
  if (sub === -1) {
    if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
    lines.push(...block.slice(0, 2));
  } else {
    lines.splice(sub, 0, ...block);
  }
  return `${lines.join("\n")}\n`;
}

/** `path` as the rule writes it: `~/…` under the home folder (with `/`, which every platform
 * takes), else absolute. Folders are compared as the platform does: either slash and any case
 * on Windows. */
export function rulePath(
  path: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = platform === "win32" ? win32 : posix;
  const absolute = paths.resolve(path);
  const relative = paths.relative(paths.resolve(home), absolute);
  if (relative === "") return "~";
  if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) {
    return absolute;
  }
  return `~/${relative.split(paths.sep).join("/")}`;
}

/** `text` with the folder rule for `path` set to `capture`: the `[[capture.paths]]` entry for
 * the same folder is changed where it is, or a new one is added at the end. `same` compares two
 * rule paths as folders. */
export function setCapturePath(
  text: string,
  path: string,
  capture: boolean,
  same: (a: string, b: string) => boolean,
): string {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\[\[\s*capture\.paths\s*\]\]/.test(lines[i] as string)) continue;
    let end = lines.findIndex((line, j) => j > i && HEADER.test(line));
    if (end === -1) end = lines.length;
    let written: string | undefined;
    let captureLine = -1;
    let pathLine = i;
    for (let j = i + 1; j < end; j++) {
      const line = lines[j] as string;
      if (/^\s*path\s*=/.test(line)) {
        pathLine = j;
        try {
          written = (Bun.TOML.parse(line) as { path?: unknown }).path as string | undefined;
        } catch {}
      }
      if (/^\s*capture\s*=/.test(line)) captureLine = j;
    }
    if (written === undefined || !same(written, path)) continue;
    if (captureLine !== -1) lines[captureLine] = `capture = ${capture}`;
    else lines.splice(pathLine + 1, 0, `capture = ${capture}`);
    return `${lines.join("\n")}\n`;
  }
  if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
  lines.push("[[capture.paths]]", `path = ${JSON.stringify(path)}`, `capture = ${capture}`);
  return `${lines.join("\n")}\n`;
}

/** Write `next` as the CLI config at `file`, after loading it: throws the loader's
 * `ConfigError`, writing nothing, when it would not load. */
export function writeCliConfig(
  file: string,
  next: string,
  env: Record<string, string | undefined>,
): CliConfig {
  const loaded = loadCliConfig({
    file,
    env,
    fs: { readFile: () => next, mode: () => 0o100600 },
  });
  writePrivateFile(file, next);
  return loaded.config;
}

/** The CLI config's text; empty when the file does not exist yet. */
export function readCliText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}
