import { readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { type CliConfig, loadCliConfig } from "@seshi/config";
import { writePrivateFile } from "./account/secrets";

const HEADER = /^\s*\[/;

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

export function readCliText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}
