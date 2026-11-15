/** The layers above the file (F1.1, F1.2): env variables and flags, each a path and a string,
 * placed into the file's tree by the schema's shape.
 *
 * Env names are `SESHI_` plus the TOML path in upper case with `__` between levels:
 * `[store] url` is `SESHI_STORE__URL`, `[auth.oidc] issuer` is `SESHI_AUTH__OIDC__ISSUER`. A
 * key of a map (`[auth.tokens] alice`) is matched against the keys the file already has
 * (upper-cased, anything but letters and digits as `_`), else added in lower case. Lists of
 * tables (`[[sources]]`) are defined in the file only; env names a field of one by its `id`
 * (`SESHI_SOURCES__DATADOG_PROD__API_KEY` for `id = "datadog-prod"`). A secret can also be set
 * as a reference (`SESHI_AUTH__ORG_KEY__SECRET__FILE=/run/secrets/key`).
 *
 * Flags use the TOML path as written (`--set store.url=…`, `--set sources.datadog-prod.lag=2m`)
 * or a command's named flag (`--listen`), mapped to a path by the command. */

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

/** One value from above the file. */
export interface Assignment {
  /** The env variable or flag, for messages and provenance. */
  name: string;
  source: "env" | "flag";
  /** The path's segments as given: `["STORE", "URL"]` from env, `["store", "url"]` from a flag. */
  segments: string[];
  value: string;
}

export const ENV_PREFIX = "SESHI_";

/** An env name's form of a key: `datadog-prod` → `DATADOG_PROD`. */
export function envKey(key: string): string {
  return key.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export class PlacementError extends Error {
  constructor(
    message: string,
    /** The name is not a setting at all (as opposed to a setting given a bad shape). */
    readonly unknown: boolean,
  ) {
    super(message);
    this.name = "PlacementError";
  }
}

export interface Placed {
  /** Where the value goes in the tree. */
  path: PathSegment[];
  /** The setting it belongs to: `path` itself, or the secret above it when a reference field
   * (`…__FILE`) was set. Provenance is recorded here. */
  setting: PathSegment[];
  /** The schema of where it goes. */
  node: JsonSchema;
}

/** Finds where `segments` lead in `tree` by `shape`. `source` decides how keys match: env names
 * are upper case, flags are exact. */
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

/** An env or flag string as the type the field takes: a number, a boolean, a comma-separated
 * list. What does not fit stays a string, for the schema to refuse with its own message. */
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

/** Records `origin` for every setting in the file's tree. */
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

/** Applies one assignment onto `tree` and records its origin. Throws `PlacementError` when it
 * does not fit the shape. */
export function applyAssignment(
  shape: JsonSchema,
  tree: PlainObject,
  assignment: Assignment,
  origins: Origins,
): void {
  const placed = place(shape, tree, assignment.segments, assignment.source);
  const value = coerce(placed.node, assignment.value);
  if (placed.setting.length < placed.path.length) {
    // A reference field (`…__FILE`) replaces whatever the secret was before, rather than
    // merging into it: `{ env, file }` is not a reference.
    setAt(tree, placed.setting, { [placed.path.at(-1) as string]: value });
  } else {
    setAt(tree, placed.path, value);
  }
  origins.set(placed.setting, { source: assignment.source, name: assignment.name });
}

/** The `SESHI_*` variables of `env` as assignments, sorted by name. Empty values count as
 * unset. `ignore` names variables that are not settings (`SESHI_CONFIG`). */
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

/** Whether `assignment` names a setting of `shape` (used to skip, silently, env variables that
 * belong to the other config: the CLI's `SESHI_USER` when the server loads). */
export function namesSetting(shape: JsonSchema, assignment: Assignment): boolean {
  if (assignment.segments.some((s) => s === "")) return false;
  try {
    place(shape, {}, assignment.segments, assignment.source);
    return true;
  } catch (err) {
    return !(err instanceof PlacementError && err.unknown);
  }
}

/** Whether `name` (`SESHI_STORE__URL`) is a setting of `shape`: the check `.env.example` and the
 * docs are tested with. A field of a `[[sources]]` entry counts, whatever its id. */
export function isSettingName(shape: JsonSchema, name: string): boolean {
  if (!name.startsWith(ENV_PREFIX)) return false;
  return namesSetting(shape, {
    name,
    source: "env",
    segments: name.slice(ENV_PREFIX.length).split("__"),
    value: "",
  });
}
