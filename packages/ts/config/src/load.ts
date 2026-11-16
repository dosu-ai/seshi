import { readFileSync, statSync } from "node:fs";
import * as z from "zod";
import {
  type Assignment,
  applyAssignment,
  ENV_PREFIX,
  envAssignments,
  namesSetting,
  PlacementError,
  recordFile,
} from "./layers";
import { describeOrigin, formatPath, type Origin, Origins, type PathSegment } from "./origins";
import { Secret } from "./secret";
import {
  formatOf,
  isPlainObject,
  isSecret,
  isTable,
  type JsonSchema,
  nodeAt,
  type PlainObject,
} from "./shape";

export interface ConfigFs {
  readFile(path: string): string;
  mode(path: string): number | undefined;
}

export const nodeFs: ConfigFs = {
  readFile: (path) => readFileSync(path, "utf8"),
  mode(path) {
    try {
      return statSync(path).mode;
    } catch {
      return undefined;
    }
  },
};

export interface FlagValue {
  name: string;
  path: string;
  value: string;
}

export interface LoadOptions {
  file?: string;
  env?: Record<string, string | undefined>;
  flags?: readonly FlagValue[];
  ignoreEnv?: readonly string[];
  foreign?: readonly JsonSchema[];
  resolveSecrets?: boolean;
  platform?: NodeJS.Platform;
  fs?: ConfigFs;
}

export interface Loaded<T> {
  config: T;
  file?: string;
  origins: Origins;
  warnings: string[];
  shape: JsonSchema;
}

export class ConfigError extends Error {
  file?: string;

  constructor(readonly issues: string[]) {
    super(issues.length === 1 ? issues[0] : `${issues.length} problems:\n  ${issues.join("\n  ")}`);
    this.name = "ConfigError";
  }
}

export function shapeOf(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
}

function suffix(origin: Origin): string {
  switch (origin.source) {
    case "env":
      return ` (from env ${origin.name})`;
    case "flag":
      return ` (from flag ${origin.name})`;
    case "file":
      return ` (in ${origin.path})`;
    default:
      return "";
  }
}

function idLookup(tree: unknown) {
  return (prefix: readonly PathSegment[]): string | undefined => {
    let value: unknown = tree;
    for (const segment of prefix) {
      if (Array.isArray(value) && typeof segment === "number") value = value[segment];
      else if (isPlainObject(value) && typeof segment === "string") value = value[segment];
      else return undefined;
    }
    return isPlainObject(value) && typeof value.id === "string" ? value.id : undefined;
  };
}

function valueAt(tree: unknown, path: readonly PathSegment[]): unknown {
  let value = tree;
  for (const segment of path) {
    if (Array.isArray(value) && typeof segment === "number") value = value[segment];
    else if (isPlainObject(value) && typeof segment === "string") value = value[segment];
    else return undefined;
  }
  return value;
}

function describeIssue(
  issue: z.core.$ZodIssue,
  shape: JsonSchema,
  tree: PlainObject,
  origins: Origins,
): string[] {
  const path = issue.path as PathSegment[];
  const ids = idLookup(tree);
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => {
      const at = [...path, key];
      return `${formatPath(at, ids)}: unknown key${suffix(origins.get(at))}`;
    });
  }
  const node = nodeAt(shape, tree, path);
  let message = issue.message.replace(/^Invalid input: /, "");
  const options = (issue as { options?: unknown[] }).options;
  if (
    (issue.code === "invalid_type" || issue.code === "invalid_union") &&
    valueAt(tree, path) === undefined
  ) {
    message = "required";
  } else if (issue.code === "invalid_union" && "discriminator" in issue && options) {
    message = `must be one of ${options.join(", ")}`;
  } else if (isSecret(node)) {
    message = 'expected a string, { env = "NAME" } or { file = "/path" }';
  } else if (formatOf(node) === "duration") {
    message = 'expected a duration such as "90s", "10m", "1h", "30d", or milliseconds';
  } else if (formatOf(node) === "bytes") {
    message = 'expected a size such as "512KiB", "32MiB", "1GiB", or bytes';
  }
  const required = node && isTable(node) && Array.isArray(node.required) ? node.required : [];
  if (message === "required" && required.length > 0) {
    return required.map(
      (key) => `${formatPath([...path, String(key)], ids)}: required${suffix(origins.get(path))}`,
    );
  }
  const where = path.length === 0 ? "config" : formatPath(path, ids);
  return [`${where}: ${message}${suffix(origins.get(path))}`];
}

export function secretsIn(value: unknown): Array<{ path: PathSegment[]; secret: Secret }> {
  const found: Array<{ path: PathSegment[]; secret: Secret }> = [];
  const visit = (v: unknown, path: PathSegment[]): void => {
    if (v instanceof Secret) found.push({ path, secret: v });
    else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        visit(item, [...path, i]);
      });
    } else if (isPlainObject(v))
      for (const [k, child] of Object.entries(v)) visit(child, [...path, k]);
  };
  visit(value, []);
  return found;
}

function parseToml(file: string, text: string): PlainObject {
  try {
    const parsed: unknown = Bun.TOML.parse(text);
    return isPlainObject(parsed) ? parsed : {};
  } catch (err) {
    throw new ConfigError([`${file}: not valid TOML: ${err instanceof Error ? err.message : err}`]);
  }
}

function referencedEnv(
  shape: JsonSchema,
  tree: PlainObject,
  env: Record<string, string | undefined>,
): string[] {
  const names: string[] = [];
  const visit = (value: unknown, path: PathSegment[]): void => {
    if (isPlainObject(value)) {
      if (typeof value.env === "string" && isSecret(nodeAt(shape, tree, path))) {
        names.push(value.env);
        return;
      }
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    } else if (Array.isArray(value)) {
      value.forEach((child, i) => {
        visit(child, [...path, i]);
      });
    }
  };
  visit(tree, []);
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith(ENV_PREFIX) && name.endsWith("__ENV") && value) names.push(value);
  }
  return names;
}

export function loadConfig<S extends z.ZodType>(
  schema: S,
  options: LoadOptions = {},
): Loaded<z.output<S>> {
  try {
    return load(schema, options);
  } catch (err) {
    if (err instanceof ConfigError) err.file = options.file;
    throw err;
  }
}

function load<S extends z.ZodType>(schema: S, options: LoadOptions): Loaded<z.output<S>> {
  const fs = options.fs ?? nodeFs;
  const env = options.env ?? {};
  const shape = shapeOf(schema);
  const origins = new Origins();
  const issues: string[] = [];
  const warnings: string[] = [];

  let tree: PlainObject = {};
  if (options.file !== undefined) {
    let text: string;
    try {
      text = fs.readFile(options.file);
    } catch (err) {
      throw new ConfigError([
        `cannot read ${options.file}: ${err instanceof Error ? err.message : err}`,
      ]);
    }
    tree = parseToml(options.file, text);
    recordFile(shape, tree, { source: "file", path: options.file }, origins);
  }

  const ignore = new Set([...(options.ignoreEnv ?? []), ...referencedEnv(shape, tree, env)]);
  const assignments: Assignment[] = [
    ...envAssignments(env, ignore),
    ...(options.flags ?? []).map((flag) => ({
      name: flag.name,
      source: "flag" as const,
      segments: flag.path.split("."),
      value: flag.value,
    })),
  ];
  for (const assignment of assignments) {
    if (assignment.segments.some((s) => s === "")) {
      issues.push(`${assignment.name}: not a setting (empty key)`);
      continue;
    }
    try {
      applyAssignment(shape, tree, assignment, origins);
    } catch (err) {
      if (!(err instanceof PlacementError)) throw err;
      const foreign =
        assignment.source === "env" &&
        (options.foreign ?? []).some((other) => namesSetting(other, assignment));
      if (foreign) continue;
      issues.push(
        err.unknown
          ? `${assignment.name}: not a setting (${err.message})`
          : `${assignment.name}: ${err.message}`,
      );
    }
  }
  if (issues.length > 0) throw new ConfigError(issues);

  const parsed = schema.safeParse(tree);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(...describeIssue(issue, shape, tree, origins));
    }
    throw new ConfigError(issues);
  }
  const config = parsed.data;
  const ids = idLookup(config);

  const secrets = secretsIn(config);
  if (options.resolveSecrets ?? true) {
    for (const { path, secret } of secrets) {
      try {
        secret.resolve({ env, readFile: fs.readFile });
      } catch (err) {
        issues.push(
          `${formatPath(path, ids)}: ${err instanceof Error ? err.message : err}${suffix(origins.get(path))}`,
        );
      }
    }
    if (issues.length > 0) throw new ConfigError(issues);
  }

  if (options.file !== undefined && (options.platform ?? process.platform) !== "win32") {
    const literal = secrets.filter(({ path, secret }) => {
      const origin = origins.get(path);
      return secret.ref.kind === "literal" && origin.source === "file";
    });
    const mode = fs.mode(options.file);
    if (literal.length > 0 && mode !== undefined && (mode & 0o077) !== 0) {
      warnings.push(
        `${options.file} holds literal secrets (${literal
          .map(({ path }) => formatPath(path, ids))
          .join(
            ", ",
          )}) and group or others can read it: use { env = "NAME" } or { file = "/path" } references, or chmod 600 ${options.file}`,
      );
    }
  }

  return { config, file: options.file, origins, warnings, shape };
}

export function originOf<T>(loaded: Loaded<T>, path: readonly PathSegment[]): string {
  return describeOrigin(loaded.origins.get(path));
}
