/** A run-time check of a stored object against its JSON Schema in `spec/schemas/` (X3.10). The
 * schemas travel as data in the generated modules (`JSON_SCHEMA`, `bun run types`), so this
 * follows the contract as the generated types do, with no schema library in the binary.
 *
 * It covers the subset the contract uses: `type`, `const`, `enum`, `oneOf`, `anyOf`, `items`,
 * `properties`, `required`, `additionalProperties`, `pattern`, `format: date-time`,
 * `minLength`, `maxLength`, `minimum`, `maximum`, `minItems`, `maxItems`, and `$ref` to a
 * `$defs` entry in the same file or another. Anything else throws, as the generator does, so a
 * schema that grows a keyword is noticed here rather than checked loosely.
 * `tests/spec/schemas.test.ts` holds it to ajv's answers. */

import { JSON_SCHEMA as CHANGE } from "../generated/change";
import { JSON_SCHEMA as COMMON } from "../generated/common";
import { JSON_SCHEMA as ENVELOPE } from "../generated/envelope";
import { JSON_SCHEMA as LAYOUT } from "../generated/layout";
import { JSON_SCHEMA as METADATA } from "../generated/metadata";
import { JSON_SCHEMA as TRACE } from "../generated/trace";

interface Schema {
  $id?: string;
  $ref?: string;
  $defs?: Record<string, Schema>;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  pattern?: string;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

const KNOWN = new Set([
  "$id",
  "$ref",
  "$defs",
  "type",
  "const",
  "enum",
  "oneOf",
  "anyOf",
  "items",
  "properties",
  "required",
  "additionalProperties",
  "pattern",
  "format",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
]);

/** The schema files, by `$id`. */
const FILES: ReadonlyMap<string, Schema> = new Map(
  [CHANGE, COMMON, ENVELOPE, LAYOUT, METADATA, TRACE].map((s) => [s.$id, s as Schema]),
);

/** The schema files a stored object can be checked against. */
export type SchemaFile =
  | "change.schema.json"
  | "envelope.schema.json"
  | "layout.schema.json"
  | "metadata.schema.json"
  | "trace.schema.json";

/** How many problems are reported at most: enough to say what is wrong. */
const MAX_PROBLEMS = 20;

/** RFC 3339 date-time, as ajv-formats reads `date-time`. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return typeOf(value) === "object";
    default:
      return typeOf(value) === type;
  }
}

/** JSON equality, for `const` and `enum`. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b) || typeof a !== "object" || a === null) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((v, i) => same(v, other[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return (
    ka.length === kb.length &&
    ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

/** A JSON pointer segment. */
function segment(key: string | number): string {
  return `/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

class Checker {
  readonly problems: string[] = [];

  /** Resolve `$ref` against the file the schema is in; the file the target is in. */
  private resolve(ref: string, file: string): { schema: Schema; file: string } {
    const match = /^([a-z-]+\.schema\.json)?#\/\$defs\/([A-Za-z0-9]+)$/.exec(ref);
    const target = match?.[1] ?? file;
    const schema = match ? FILES.get(target)?.$defs?.[match[2] as string] : undefined;
    if (!schema) throw new Error(`${file}: unsupported or dangling $ref ${ref}`);
    return { schema, file: target };
  }

  private add(path: string, message: string): void {
    if (this.problems.length < MAX_PROBLEMS) this.problems.push(`${path || "/"}: ${message}`);
  }

  /** Whether `value` matches, without recording why not (for `oneOf` and `anyOf`). */
  private matches(value: unknown, schema: Schema, file: string): boolean {
    const probe = new Checker();
    probe.check(value, schema, file, "");
    return probe.problems.length === 0;
  }

  check(value: unknown, schema: Schema, file: string, path: string): void {
    for (const k of Object.keys(schema)) {
      if (!KNOWN.has(k)) throw new Error(`${file}: unsupported keyword ${k}`);
    }
    if (schema.$ref !== undefined) {
      const { schema: target, file: in_ } = this.resolve(schema.$ref, file);
      this.check(value, target, in_, path);
    }
    if (schema.const !== undefined && !same(value, schema.const)) {
      this.add(path, `must be ${JSON.stringify(schema.const)}`);
      return;
    }
    if (schema.enum !== undefined && !schema.enum.some((v) => same(value, v))) {
      this.add(path, `must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
      return;
    }
    if (schema.oneOf !== undefined) {
      const n = schema.oneOf.filter((s) => this.matches(value, s, file)).length;
      if (n !== 1) {
        this.add(path, n === 0 ? "matches none of its alternatives" : "matches more than one");
        return;
      }
    }
    if (schema.anyOf !== undefined && !schema.anyOf.some((s) => this.matches(value, s, file))) {
      this.add(path, "matches none of its alternatives");
      return;
    }
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((t) => hasType(value, t))) {
        this.add(path, `must be ${types.join(" or ")}, not ${typeOf(value)}`);
        return;
      }
    }
    if (typeof value === "string") this.string(value, schema, path);
    if (typeof value === "number") this.number(value, schema, path);
    if (Array.isArray(value)) this.array(value, schema, file, path);
    else if (typeOf(value) === "object") {
      this.object(value as Record<string, unknown>, schema, file, path);
    }
  }

  private string(value: string, schema: Schema, path: string): void {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      this.add(path, `must be at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      this.add(path, `must be at most ${schema.maxLength} characters`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      this.add(path, `must match ${schema.pattern}`);
    }
    if (
      schema.format === "date-time" &&
      (!DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))
    ) {
      this.add(path, "must be an RFC 3339 date-time");
    }
  }

  private number(value: number, schema: Schema, path: string): void {
    if (schema.minimum !== undefined && value < schema.minimum) {
      this.add(path, `must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      this.add(path, `must be <= ${schema.maximum}`);
    }
  }

  private array(value: unknown[], schema: Schema, file: string, path: string): void {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      this.add(path, `must have at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      this.add(path, `must have at most ${schema.maxItems} items`);
    }
    if (schema.items) {
      const items = schema.items;
      value.forEach((item, i) => {
        this.check(item, items, file, path + segment(i));
      });
    }
  }

  private object(value: Record<string, unknown>, schema: Schema, file: string, path: string): void {
    for (const name of schema.required ?? []) {
      if (!(name in value)) this.add(path, `is missing ${name}`);
    }
    const props = schema.properties ?? {};
    for (const [name, item] of Object.entries(value)) {
      const prop = props[name];
      if (prop) this.check(item, prop, file, path + segment(name));
      else if (schema.additionalProperties === false) {
        this.add(path + segment(name), "is not allowed");
      } else if (typeof schema.additionalProperties === "object") {
        this.check(item, schema.additionalProperties, file, path + segment(name));
      }
    }
  }
}

/** What is wrong with `value` as an object of `file` (`metadata.schema.json`): each problem as
 * a JSON pointer and what it must be, at most 20; none when it is valid. */
export function schemaProblems(file: SchemaFile, value: unknown): string[] {
  const schema = FILES.get(file);
  if (!schema) throw new Error(`no schema ${file}`);
  const checker = new Checker();
  checker.check(value, schema, file, "");
  return checker.problems;
}
