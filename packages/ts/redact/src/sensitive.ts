import type { RawFormat } from "@seshi/model";
import { builtinPack } from "./builtin";

export type WithheldKind = "sensitive-file" | "secret-output";

export type WithheldCalls = Record<string, WithheldKind>;

export interface SensitiveFiles {
  include: GlobTest[];
  exclude: GlobTest[];
}

export interface CommandTest {
  test(command: string): boolean;
}

export interface SensitiveRules {
  files: SensitiveFiles;
  commands: readonly CommandTest[];
}

export interface GlobTest {
  test(path: string): boolean;
}

type GlobToken =
  | { kind: "char"; char: string }
  | { kind: "one" }
  | { kind: "star" }
  | { kind: "any" }
  | { kind: "dirs" };

// Hand-matched, stepping the set of reachable glob positions: as a `RegExp` with `.*` pieces,
// JavaScript's backtracking engine took seconds on a few KB of repeated directory names.
class Glob implements GlobTest {
  private readonly tokens: GlobToken[] = [];
  private readonly suffix: string;

  constructor(raw: string) {
    const glob = raw.replace(/^\/+/, "").toLowerCase();
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i] as string;
      if (c === "*" && glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          this.tokens.push({ kind: "dirs" });
          i += 2;
        } else {
          this.tokens.push({ kind: "any" });
          i += 1;
        }
      } else if (c === "*") {
        this.tokens.push({ kind: "star" });
      } else if (c === "?") {
        this.tokens.push({ kind: "one" });
      } else {
        this.tokens.push({ kind: "char", char: c });
      }
    }
    let suffix = "";
    for (let i = this.tokens.length - 1; i >= 0; i--) {
      const token = this.tokens[i] as GlobToken;
      if (token.kind !== "char") break;
      suffix = token.char + suffix;
    }
    this.suffix = suffix;
  }

  test(path: string): boolean {
    const p = path.toLowerCase();
    if (!p.endsWith(this.suffix)) return false;
    const m = this.tokens.length;
    const size = 2 * m + 1;
    let current = new Uint8Array(size);
    let next = new Uint8Array(size);
    this.enter(current, 0);
    for (let at = 0; at < p.length; at++) {
      const c = p[at] as string;
      next.fill(0);
      for (let s = 0; s < size; s++) {
        if (!current[s] || s === m) continue;
        if (s > m) {
          next[s] = 1;
          if (c === "/") this.enter(next, s - m);
          continue;
        }
        const token = this.tokens[s] as GlobToken;
        if (token.kind === "char") {
          if (c === token.char) this.enter(next, s + 1);
        } else if (token.kind === "one") {
          if (c !== "/") this.enter(next, s + 1);
        } else if (token.kind === "star") {
          if (c !== "/") this.enter(next, s);
        } else if (token.kind === "any") {
          this.enter(next, s);
        }
      }
      if (c === "/") this.enter(next, 0);
      [current, next] = [next, current];
    }
    return current[m] === 1;
  }

  private enter(set: Uint8Array, state: number): void {
    const m = this.tokens.length;
    for (let s = state; s <= m && !set[s]; s++) {
      set[s] = 1;
      if (s === m) return;
      const token = this.tokens[s] as GlobToken;
      if (token.kind === "dirs") set[m + 1 + s] = 1;
      else if (token.kind !== "star" && token.kind !== "any") return;
    }
  }
}

export function globFiles(globs: readonly string[]): SensitiveFiles {
  const include: GlobTest[] = [];
  const exclude: GlobTest[] = [];
  for (const raw of globs) {
    const glob = raw.trim();
    if (!glob || glob.startsWith("#")) continue;
    if (glob.startsWith("!")) {
      if (glob.length > 1) exclude.push(new Glob(glob.slice(1)));
    } else {
      include.push(new Glob(glob));
    }
  }
  return { include, exclude };
}

export function builtinSensitiveFiles(): string[] {
  return builtinPack().sensitive_files.flatMap((rule) => rule.globs);
}

export function builtinSecretCommands(): string[] {
  return builtinPack().secret_commands.flatMap((rule) => rule.patterns);
}

export function sensitiveFiles(extra: readonly string[] = []): SensitiveFiles {
  return globFiles([...builtinSensitiveFiles(), ...extra]);
}

export interface CompiledCommands {
  commands: RegExp[];
  invalid: { pattern: string; reason: string }[];
}

export function secretCommands(extra: readonly string[] = []): CompiledCommands {
  const commands: RegExp[] = [];
  const invalid: CompiledCommands["invalid"] = [];
  for (const raw of [...builtinSecretCommands(), ...extra]) {
    const source = raw.trim();
    if (!source || source.startsWith("#")) continue;
    let re: RegExp;
    try {
      re = new RegExp(`^(?:${source})`);
    } catch (err) {
      invalid.push({ pattern: raw, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (re.test("")) {
      invalid.push({ pattern: raw, reason: "matches an empty command" });
      continue;
    }
    commands.push(re);
  }
  return { commands, invalid };
}

export function sensitiveRules(
  options: { files?: readonly string[]; commands?: readonly string[] } = {},
): SensitiveRules {
  const { commands, invalid } = secretCommands(options.commands);
  if (invalid.length > 0) {
    throw new Error(`secret command '${invalid[0].pattern}': ${invalid[0].reason}`);
  }
  return { files: sensitiveFiles(options.files), commands };
}

export function isSensitivePath(path: string, files: SensitiveFiles): boolean {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!p) return false;
  return files.include.some((re) => re.test(p)) && !files.exclude.some((re) => re.test(p));
}

function words(text: string): string[] {
  return text.split(/[\s'"`;|&<>(),=:]+/).filter((w) => w.length > 0);
}

export function namesSensitiveFile(text: string, files: SensitiveFiles): boolean {
  return words(text).some((w) => isSensitivePath(w, files));
}

const COMMAND_PREFIX =
  /^(?:sudo(?:\s+-\S+)*\s+|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+|(?:command|exec|time|nohup)\s+)/;

export function runsSecretCommand(text: string, commands: readonly CommandTest[]): boolean {
  if (commands.length === 0) return false;
  for (const raw of text.split(/\r?\n|;|&&|\|\||\||\$\(|`|\(|\)/)) {
    let segment = raw.trim();
    for (let m = COMMAND_PREFIX.exec(segment); m; m = COMMAND_PREFIX.exec(segment)) {
      segment = segment.slice(m[0].length).trimStart();
    }
    if (segment && commands.some((re) => re.test(segment))) return true;
  }
  return false;
}

type Json = unknown;
type JsonObject = Record<string, Json>;

const INPUT_KEYS = ["input", "arguments", "args", "parameters"];
const ID_KEYS = ["id", "call_id", "callID", "tool_call_id", "toolCallId", "tool_use_id"];
const REF_KEYS = ["tool_use_id", "call_id", "callID", "tool_call_id", "toolCallId"];
const COMMAND_KEYS = new Set(["command", "cmd", "script", "commands"]);
const PATH_KEYS = new Set([
  "file_path",
  "filePath",
  "path",
  "paths",
  "file",
  "files",
  "filename",
  "notebook_path",
  "target_file",
  "absolute_path",
  "absolutePath",
]);
const OUTPUT_KEYS = [
  "output",
  "result",
  "resultDisplay",
  "content",
  "stdout",
  "stderr",
  "aggregated_output",
];
const KEEP_KEYS = new Set([
  ...ID_KEYS,
  "type",
  "name",
  "toolName",
  "tool",
  "is_error",
  "isError",
  "status",
  "role",
]);

function isObject(value: Json): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The call's input: its own, or the one in its `state` (OpenCode). */
function inputOf(obj: JsonObject): { holder: JsonObject; key: string } | null {
  for (const key of INPUT_KEYS) if (key in obj) return { holder: obj, key };
  if (isObject(obj.state)) {
    for (const key of INPUT_KEYS) if (key in obj.state) return { holder: obj.state, key };
  }
  return null;
}

function strings(value: Json, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (isObject(value)) for (const v of Object.values(value)) strings(v, out);
  return out;
}

/** A patch (Codex's `apply_patch`) names its files in headers; the rest is code. */
const PATCH_START = "*** Begin Patch";
const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

function patchPaths(text: string): string[] {
  return [...text.matchAll(PATCH_FILE)].map((m) => m[1].trim());
}

function pathValues(value: Json, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.trimStart().startsWith(PATCH_START)) out.push(...patchPaths(value));
  } else if (Array.isArray(value)) {
    for (const v of value) pathValues(v, out);
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (PATH_KEYS.has(k)) {
        for (const s of strings(v)) out.push(s);
      } else {
        pathValues(v, out);
      }
    }
  }
  return out;
}

function commandLines(value: Json, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (!value.trimStart().startsWith(PATCH_START)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) commandLines(v, out);
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (COMMAND_KEYS.has(k)) strings(v, out);
      else if (isObject(v) || Array.isArray(v)) commandLines(v, out);
    }
  }
  return out;
}

function blank(value: Json, marker: string): Json {
  if (typeof value === "string") return value ? marker : value;
  if (Array.isArray(value)) return value.map((v) => blank(v, marker));
  if (isObject(value)) {
    const next: JsonObject = {};
    for (const [k, v] of Object.entries(value)) next[k] = KEEP_KEYS.has(k) ? v : blank(v, marker);
    return next;
  }
  return value;
}

const FILE_MARKER = "[redacted:sensitive-file]";

function trimInput(value: Json, files: SensitiveFiles): Json {
  if (typeof value === "string") {
    if (!value) return value;
    const lines = value.split("\n");
    if (lines.length === 1) {
      return namesSensitiveFile(value, files) ? value : FILE_MARKER;
    }
    const kept: string[] = [];
    for (const line of lines) {
      if (namesSensitiveFile(line, files)) kept.push(line);
      else if (kept.at(-1) !== FILE_MARKER) kept.push(FILE_MARKER);
    }
    return kept.join("\n");
  }
  if (Array.isArray(value)) return value.map((v) => trimInput(v, files));
  if (isObject(value)) {
    const next: JsonObject = {};
    for (const [k, v] of Object.entries(value)) next[k] = trimInput(v, files);
    return next;
  }
  return value;
}

/** A JSON-encoded input (Codex's `arguments`) is read as the object it encodes. */
function parsedInput(value: Json): Json {
  if (typeof value !== "string") return value;
  const t = value.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return value;
  try {
    return JSON.parse(t);
  } catch {
    return value;
  }
}

class Pass {
  readonly withheld: WithheldCalls;

  constructor(
    readonly rules: SensitiveRules,
    carried: Readonly<WithheldCalls>,
    private readonly onWithhold?: WithholdListener,
  ) {
    this.withheld = { ...carried };
  }

  private classify(input: Json): WithheldKind | null {
    return classifyCall(input, this.rules);
  }

  visit(value: Json): Json {
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((v) => {
        const r = this.visit(v);
        changed ||= r !== v;
        return r;
      });
      return changed ? next : value;
    }
    if (!isObject(value)) return value;

    const input = inputOf(value);
    if (input) {
      const parsed = parsedInput(input.holder[input.key]);
      const kind = this.classify(parsed);
      if (kind) {
        let known = false;
        for (const key of ID_KEYS) {
          const id = value[key];
          if (typeof id === "string" && id) {
            known ||= Object.hasOwn(this.withheld, id);
            this.withheld[id] = kind;
          }
        }
        if (!known) this.onWithhold?.(parsed, kind);
        return this.redactCall(value, input, kind);
      }
    } else {
      for (const key of REF_KEYS) {
        const ref = value[key];
        if (typeof ref === "string" && Object.hasOwn(this.withheld, ref)) {
          return blank(value, `[redacted:${this.withheld[ref]}]`);
        }
      }
    }

    let changed = false;
    const next: JsonObject = {};
    for (const [k, v] of Object.entries(value)) {
      const r = this.visit(v);
      changed ||= r !== v;
      next[k] = r;
    }
    if (!changed) return value;
    // Claude Code repeats a tool's result beside its message, in the row's `toolUseResult`.
    if ("toolUseResult" in next) {
      const marker = this.blankedMarkerIn(next);
      if (marker) next.toolUseResult = blank(next.toolUseResult, marker);
    }
    return next;
  }

  private blankedMarkerIn(row: JsonObject): string | null {
    const found = strings(row.message ?? {});
    for (const kind of ["sensitive-file", "secret-output"] as const) {
      if (found.includes(`[redacted:${kind}]`)) return `[redacted:${kind}]`;
    }
    return null;
  }

  private redactCall(
    call: JsonObject,
    input: { holder: JsonObject; key: string },
    kind: WithheldKind,
  ): JsonObject {
    const marker = `[redacted:${kind}]`;
    const raw = input.holder[input.key];
    let holder = input.holder;
    if (kind === "sensitive-file") {
      const parsed = parsedInput(raw);
      const trimmed = trimInput(parsed, this.rules.files);
      holder = { ...holder, [input.key]: parsed !== raw ? JSON.stringify(trimmed) : trimmed };
    } else {
      holder = { ...holder };
    }
    // A call that carries its own output (OpenCode's parts): that goes too.
    for (const key of OUTPUT_KEYS) {
      if (key in holder && key !== input.key) holder[key] = blank(holder[key], marker);
    }
    if (holder.metadata !== undefined && input.holder !== call) {
      holder.metadata = blank(holder.metadata, marker);
    }
    if (input.holder === call) return holder;
    return { ...call, state: holder };
  }
}

function redactDocument(text: string, pass: Pass): string {
  let parsed: Json;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const next = pass.visit(parsed);
  return next === parsed ? text : JSON.stringify(next);
}

export type WithholdListener = (input: unknown, kind: WithheldKind) => void;

export interface SensitiveResult {
  text: string;
  withheld: WithheldCalls;
}

export function redactSensitive(
  transcript: string,
  format: RawFormat,
  rules: SensitiveRules,
  carried: Readonly<WithheldCalls> = {},
  onWithhold?: WithholdListener,
): SensitiveResult {
  const pass = new Pass(rules, carried, onWithhold);
  const text =
    format === "json"
      ? redactDocument(transcript, pass)
      : transcript
          .split("\n")
          .map((line) => (line.trim() ? redactDocument(line, pass) : line))
          .join("\n");
  return { text, withheld: pass.withheld };
}

export function classifyCall(input: unknown, rules: SensitiveRules): WithheldKind | null {
  const value = parsedInput(input as Json);
  const { files } = rules;
  if (
    pathValues(value).some((p) => isSensitivePath(p, files)) ||
    commandLines(value).some((s) => namesSensitiveFile(s, files))
  ) {
    return "sensitive-file";
  }
  if (commandLines(value).some((s) => runsSecretCommand(s, rules.commands))) {
    return "secret-output";
  }
  return null;
}

export function trimSensitiveInput(input: string, files: SensitiveFiles): string {
  const parsed = parsedInput(input);
  const trimmed = trimInput(parsed, files);
  return parsed !== input ? JSON.stringify(trimmed) : (trimmed as string);
}
