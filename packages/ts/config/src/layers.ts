import type { Origin, Origins, PathSegment } from "./origins";
import {
  childOf,
  elementOf,
  isLeaf,
  isMap,
  isPlainObject,
  isTable,
  isTableList,
  type JsonSchema,
  type PlainObject,
  scalarTypes,
} from "./shape";

export interface Assignment {
  name: string;
  source: "env" | "flag";
  segments: string[];
  value: string;
}

export const ENV_PREFIX = "SESHI_";

export function envKey(key: string): string {
  return key.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export class PlacementError extends Error {
  constructor(
    message: string,
    readonly unknown: boolean,
  ) {
    super(message);
    this.name = "PlacementError";
  }
}

export interface Placed {
  path: PathSegment[];
  setting: PathSegment[];
  node: JsonSchema;
}

export function place(
  shape: JsonSchema,
  tree: PlainObject,
  segments: readonly string[],
  source: "env" | "flag",
): Placed {
  const matches = (key: string, segment: string) =>
    source === "env" ? envKey(key) === segment : key === segment;
  const path: PathSegment[] = [];
  let setting: PathSegment[] | undefined;
  let node: JsonSchema = shape;
  let value: unknown = tree;

  for (const raw of segments) {
    const segment = source === "env" ? raw.toUpperCase() : raw;
    if (setting === undefined && isLeaf(node) && path.length > 0) setting = [...path];
    if (isTableList(node)) {
      const list = Array.isArray(value) ? value : [];
      const index = list.findIndex(
        (element) =>
          isPlainObject(element) && typeof element.id === "string" && matches(element.id, segment),
      );
      if (index < 0) {
        throw new PlacementError(
          `no entry with id matching '${raw}' under ${path.join(".")} in the config file (lists of tables are defined in the file only)`,
          false,
        );
      }
      path.push(index);
      value = list[index];
      const element = elementOf(node, value);
      if (!element) throw new PlacementError(`'${raw}' cannot be set`, true);
      node = element;
      continue;
    }
    let key: string | undefined;
    if (isMap(node)) {
      const existing = isPlainObject(value) ? Object.keys(value) : [];
      key =
        existing.find((k) => matches(k, segment)) ?? (source === "env" ? raw.toLowerCase() : raw);
    } else {
      key = source === "env" ? raw.toLowerCase() : raw;
    }
    const child = childOf(node, key, value);
    if (!child) throw new PlacementError(`'${raw}' is not a setting here`, true);
    path.push(key);
    value = isPlainObject(value) ? value[key] : undefined;
    node = child;
  }
  if (isTable(node) || isMap(node) || isTableList(node)) {
    throw new PlacementError(
      isTableList(node)
        ? `${path.join(".")} is a list of tables, defined in the config file only`
        : `${path.join(".")} is a table; set one of its keys`,
      false,
    );
  }
  return { path, setting: setting ?? path, node };
}

export function coerce(node: JsonSchema, value: string): unknown {
  const types = scalarTypes(node);
  if (types.has("array") && node.items) {
    const text = value.trim();
    if (text.startsWith("[")) {
      try {
        return JSON.parse(text);
      } catch {
        return value;
      }
    }
    return text === ""
      ? []
      : text
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item !== "")
          .map((item) => coerce(node.items as JsonSchema, item));
  }
  const trimmed = value.trim();
  if ((types.has("integer") || types.has("number")) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (types.has("boolean")) {
    const lower = trimmed.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return value;
}

function setAt(tree: PlainObject, path: readonly PathSegment[], value: unknown): void {
  let cursor: unknown = tree;
  path.forEach((segment, i) => {
    const last = i === path.length - 1;
    if (typeof segment === "number") {
      const list = cursor as unknown[];
      if (last) list[segment] = value;
      else cursor = list[segment];
      return;
    }
    const table = cursor as PlainObject;
    if (last) {
      table[segment] = value;
      return;
    }
    const next = table[segment];
    if (!isPlainObject(next) && !Array.isArray(next)) table[segment] = {};
    cursor = table[segment];
  });
}

export function recordFile(
  shape: JsonSchema,
  tree: PlainObject,
  origin: Origin,
  origins: Origins,
): void {
  const visit = (node: JsonSchema | undefined, value: unknown, path: PathSegment[]): void => {
    if (path.length > 0 && (node === undefined || isLeaf(node))) {
      origins.set(path, origin);
      return;
    }
    if (node && isTableList(node) && Array.isArray(value)) {
      value.forEach((element, i) => {
        visit(elementOf(node, element), element, [...path, i]);
      });
      return;
    }
    if (!isPlainObject(value)) {
      origins.set(path, origin);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      visit(node ? childOf(node, key, value) : undefined, child, [...path, key]);
    }
  };
  visit(shape, tree, []);
}

export function applyAssignment(
  shape: JsonSchema,
  tree: PlainObject,
  assignment: Assignment,
  origins: Origins,
): void {
  const placed = place(shape, tree, assignment.segments, assignment.source);
  const value = coerce(placed.node, assignment.value);
  if (placed.setting.length < placed.path.length) {
    setAt(tree, placed.setting, { [placed.path.at(-1) as string]: value });
  } else {
    setAt(tree, placed.path, value);
  }
  origins.set(placed.setting, { source: assignment.source, name: assignment.name });
}

export function envAssignments(
  env: Record<string, string | undefined>,
  ignore: ReadonlySet<string>,
): Assignment[] {
  return Object.keys(env)
    .filter((name) => name.startsWith(ENV_PREFIX) && !ignore.has(name))
    .filter((name) => (env[name] ?? "") !== "")
    .sort()
    .map((name) => ({
      name,
      source: "env" as const,
      segments: name.slice(ENV_PREFIX.length).split("__"),
      value: env[name] as string,
    }));
}

export function namesSetting(shape: JsonSchema, assignment: Assignment): boolean {
  if (assignment.segments.some((s) => s === "")) return false;
  try {
    place(shape, {}, assignment.segments, assignment.source);
    return true;
  } catch (err) {
    return !(err instanceof PlacementError && err.unknown);
  }
}

export function isSettingName(shape: JsonSchema, name: string): boolean {
  if (!name.startsWith(ENV_PREFIX)) return false;
  return namesSetting(shape, {
    name,
    source: "env",
    segments: name.slice(ENV_PREFIX.length).split("__"),
    value: "",
  });
}
