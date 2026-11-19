import type { Loaded } from "./load";
import { formatPath, type Origin, type PathSegment } from "./origins";
import { describeSecret, Secret } from "./secret";
import { formatOf, isPlainObject, type JsonSchema, nodeAt } from "./shape";
import { formatBytes, formatDuration } from "./units";

export interface ConfigEntry {
  path: PathSegment[];
  name: string;
  value: unknown;
  origin: Origin;
}

function display(value: unknown, node: JsonSchema | undefined): unknown {
  if (value instanceof Secret) {
    const where = describeSecret(value);
    return where === "literal" ? "<secret>" : `<secret: ${where.replace(/^from /, "")}>`;
  }
  if (typeof value === "number") {
    const format = formatOf(node);
    if (format === "duration") return formatDuration(value);
    if (format === "bytes") return formatBytes(value);
  }
  return value;
}

export function configEntries<T>(loaded: Loaded<T>): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  const root = loaded.config as unknown;
  const idAt = (prefix: readonly PathSegment[]) => {
    let value: unknown = root;
    for (const segment of prefix) value = (value as Record<string | number, unknown>)?.[segment];
    return isPlainObject(value) && typeof value.id === "string" ? value.id : undefined;
  };
  const visit = (value: unknown, path: PathSegment[]): void => {
    if (value === undefined) return;
    const listOfTables =
      Array.isArray(value) && value.length > 0 && value.every((v) => isPlainObject(v));
    const table = isPlainObject(value) && !(value instanceof Secret);
    if ((table && Object.keys(value).length > 0) || listOfTables) {
      if (Array.isArray(value)) {
        value.forEach((item, i) => {
          visit(item, [...path, i]);
        });
      } else for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
      return;
    }
    entries.push({
      path,
      name: formatPath(path, idAt),
      value: display(value, nodeAt(loaded.shape, root, path)),
      origin: loaded.origins.get(path),
    });
  };
  visit(root, []);
  return entries;
}

export function displayTree<T>(loaded: Loaded<T>): unknown {
  const tree: Record<string, unknown> = {};
  for (const entry of configEntries(loaded)) {
    let cursor: Record<string | number, unknown> = tree;
    entry.path.forEach((segment, i) => {
      if (i === entry.path.length - 1) {
        cursor[segment] = entry.value;
        return;
      }
      const next = entry.path[i + 1];
      cursor[segment] ??= typeof next === "number" ? [] : {};
      cursor = cursor[segment] as Record<string | number, unknown>;
    });
  }
  return tree;
}
