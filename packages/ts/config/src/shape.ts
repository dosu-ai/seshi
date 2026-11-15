/** A config schema's shape, read from its JSON Schema (the input side, as `z.toJSONSchema`
 * writes it). The loader uses it to place env and flag values (which key a `SESHI_…` name
 * means, whether a field takes a number, a list or a secret) and `config show` uses it to
 * print durations, sizes and secrets. Reading the generated JSON Schema rather than zod's
 * internals keeps this on a public, stable format. */

import { SECRET_KEY } from "./secret";
import { FORMAT_KEY } from "./units";

/** The part of JSON Schema that `z.toJSONSchema` writes for config schemas. */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  const?: unknown;
  enum?: unknown[];
  default?: unknown;
  description?: string;
  [SECRET_KEY]?: boolean;
  [FORMAT_KEY]?: "duration" | "bytes";
  [key: string]: unknown;
}

export type PlainObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function branches(node: JsonSchema): JsonSchema[] {
  return node.anyOf ?? node.oneOf ?? [];
}

function hasType(node: JsonSchema, type: string): boolean {
  return Array.isArray(node.type) ? node.type.includes(type) : node.type === type;
}

export function isSecret(node: JsonSchema | undefined): boolean {
  return node?.[SECRET_KEY] === true;
}

export function formatOf(node: JsonSchema | undefined): "duration" | "bytes" | undefined {
  return node?.[FORMAT_KEY];
}

/** A table with named fields. */
export function isTable(node: JsonSchema): boolean {
  return hasType(node, "object") && node.properties !== undefined;
}

/** A table whose keys are the user's (`[auth.tokens]`, `[auth.owner_aliases]`). */
export function isMap(node: JsonSchema): boolean {
  return (
    hasType(node, "object") &&
    node.properties === undefined &&
    typeof node.additionalProperties === "object"
  );
}

/** A list of tables (`[[sources]]`). */
export function isTableList(node: JsonSchema): boolean {
  if (!hasType(node, "array") || !node.items) return false;
  const items = node.items;
  if (isTable(items)) return true;
  const options = branches(items);
  return options.length > 0 && options.every(isTable);
}

/** A value the user sets as one thing: a scalar, a list of scalars, a secret reference, a
 * duration. Everything but tables, maps and lists of tables. */
export function isLeaf(node: JsonSchema | undefined): boolean {
  if (node === undefined) return true;
  if (isSecret(node) || formatOf(node)) return true;
  if (isTable(node) || isMap(node) || isTableList(node)) return false;
  const options = branches(node);
  if (options.length > 0) return !options.every((o) => isTable(o) || isMap(o));
  return true;
}

/** The schema of `key` inside a table or map node, given the value there so far (which picks
 * the branch of a union of tables). `undefined` when the key is not part of the schema. */
export function childOf(node: JsonSchema, key: string, value?: unknown): JsonSchema | undefined {
  if (isTable(node)) return node.properties?.[key];
  if (isMap(node)) return node.additionalProperties as JsonSchema;
  const options = branches(node).filter(isTable);
  if (options.length === 0) return undefined;
  const picked = pickBranch(options, value);
  if (picked) return picked.properties?.[key];
  for (const option of options) {
    const child = option.properties?.[key];
    if (child) return child;
  }
  return undefined;
}

/** The union branch a table value belongs to, by its constant field (`type = "datadog"`). */
export function pickBranch(options: JsonSchema[], value: unknown): JsonSchema | undefined {
  if (!isPlainObject(value)) return undefined;
  return options.find((option) =>
    Object.entries(option.properties ?? {}).some(
      ([field, schema]) => schema.const !== undefined && value[field] === schema.const,
    ),
  );
}

/** The element schema of a list of tables, for one element's value. */
export function elementOf(node: JsonSchema, value: unknown): JsonSchema | undefined {
  const items = node.items;
  if (!items) return undefined;
  if (isTable(items)) return items;
  return pickBranch(branches(items), value) ?? items;
}

/** The scalar types a leaf accepts, branches included. */
export function scalarTypes(node: JsonSchema): Set<string> {
  const types = new Set<string>();
  const visit = (n: JsonSchema): void => {
    if (Array.isArray(n.type)) for (const t of n.type) types.add(t);
    else if (n.type) types.add(n.type);
    else if (n.const !== undefined) types.add(typeof n.const);
    else if (n.enum) for (const v of n.enum) types.add(typeof v);
    for (const b of branches(n)) visit(b);
  };
  visit(node);
  return types;
}

/** The schema at a concrete path (`["sources", 0, "api_key"]`) of `tree`. */
export function nodeAt(
  shape: JsonSchema,
  tree: unknown,
  path: ReadonlyArray<string | number>,
): JsonSchema | undefined {
  let node: JsonSchema | undefined = shape;
  let value: unknown = tree;
  for (const segment of path) {
    if (node === undefined) return undefined;
    if (typeof segment === "number") {
      value = Array.isArray(value) ? value[segment] : undefined;
      node = isTableList(node) ? elementOf(node, value) : node.items;
      continue;
    }
    node = childOf(node, segment, value);
    value = isPlainObject(value) ? value[segment] : undefined;
  }
  return node;
}
