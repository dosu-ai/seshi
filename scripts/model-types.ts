import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

type Schema = {
  $id?: string;
  $ref?: string;
  $defs?: Record<string, Schema>;
  $schema?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  [key: string]: unknown;
};

const IGNORED = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "pattern",
  "format",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "examples",
  "default",
]);
const HANDLED = new Set([
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
]);

const ANNOTATIONS = new Set(["$schema", "title", "description", "examples", "default"]);

const SCHEMA_DIR = "spec/schemas";
const OUT_DIR = "packages/ts/model/src/generated";

function moduleOf(file: string): string {
  return basename(file).replace(/\.schema\.json$/, "");
}

function doc(text: string | undefined, indent = ""): string {
  if (!text) return "";
  const lines = text.replaceAll("*/", "*\\/").split("\n");
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`).join("\n")}\n${indent} */\n`;
}

function key(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

class Generator {
  readonly imports = new Map<string, Set<string>>();

  constructor(
    private readonly file: string,
    private readonly known: ReadonlyMap<string, Schema>,
  ) {}

  private ref(ref: string): string {
    const match = /^([a-z-]+\.schema\.json)?#\/\$defs\/([A-Za-z0-9]+)$/.exec(ref);
    if (!match) throw new Error(`${this.file}: unsupported $ref ${ref}`);
    const [, target, name] = match as unknown as [string, string | undefined, string];
    if (target && target !== this.file) {
      const other = this.known.get(target);
      if (!other?.$defs?.[name]) throw new Error(`${this.file}: $ref ${ref} names nothing`);
      const mod = moduleOf(target);
      if (!this.imports.has(mod)) this.imports.set(mod, new Set());
      this.imports.get(mod)?.add(name);
    } else if (!this.known.get(this.file)?.$defs?.[name]) {
      throw new Error(`${this.file}: $ref ${ref} names nothing`);
    }
    return name;
  }

  type(schema: Schema, indent: string): string {
    for (const k of Object.keys(schema)) {
      if (!IGNORED.has(k) && !HANDLED.has(k)) throw new Error(`${this.file}: unsupported ${k}`);
    }
    if (schema.$ref) return this.ref(schema.$ref);
    if (schema.const !== undefined) return JSON.stringify(schema.const);
    if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
    const union = schema.oneOf ?? schema.anyOf;
    if (union) return union.map((s) => this.type(s, indent)).join(" | ");
    const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
    if (types.length === 0) {
      if (schema.properties) return this.object(schema, indent);
      throw new Error(`${this.file}: a schema without a type`);
    }
    return types
      .map((t) => {
        switch (t) {
          case "string":
            return "string";
          case "integer":
          case "number":
            return "number";
          case "boolean":
            return "boolean";
          case "null":
            return "null";
          case "array": {
            const item = schema.items ? this.type(schema.items, indent) : "unknown";
            return /[|&]/.test(item) ? `(${item})[]` : `${item}[]`;
          }
          case "object":
            return this.object(schema, indent);
          default:
            throw new Error(`${this.file}: unsupported type ${t}`);
        }
      })
      .join(" | ");
  }

  object(schema: Schema, indent: string): string {
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const extra = schema.additionalProperties;
    const inner = `${indent}  `;
    const lines = Object.entries(props).map(
      ([name, prop]) =>
        `${doc(prop.description, inner)}${inner}${key(name)}${required.has(name) ? "" : "?"}: ${this.type(prop, inner)};`,
    );
    if (extra === true) lines.push(`${inner}[key: string]: unknown;`);
    else if (typeof extra === "object") {
      lines.push(`${inner}[key: string]: ${this.type(extra, inner)};`);
    } else if (extra === undefined && lines.length === 0) {
      return "Record<string, unknown>";
    }
    return `{\n${lines.join("\n")}\n${indent}}`;
  }

  declaration(name: string, schema: Schema): string {
    const isObject = schema.type === "object" && schema.properties !== undefined && !schema.oneOf;
    if (isObject) {
      return `${doc(schema.description)}export interface ${name} ${this.object(schema, "")}\n`;
    }
    return `${doc(schema.description)}export type ${name} = ${this.type(schema, "")};\n`;
  }
}

function stripped(schema: Schema): Schema {
  const out: Schema = {};
  for (const [k, v] of Object.entries(schema)) {
    if (ANNOTATIONS.has(k)) continue;
    if ((k === "properties" || k === "$defs") && v && typeof v === "object") {
      out[k] = Object.fromEntries(
        Object.entries(v as Record<string, Schema>).map(([name, s]) => [name, stripped(s)]),
      );
    } else if ((k === "items" || k === "additionalProperties") && v && typeof v === "object") {
      out[k] = stripped(v as Schema);
    } else if ((k === "oneOf" || k === "anyOf") && Array.isArray(v)) {
      out[k] = (v as Schema[]).map(stripped);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function generate(root: string): Array<{ path: string; text: string }> {
  const files = readdirSync(join(root, SCHEMA_DIR))
    .filter((f) => f.endsWith(".schema.json"))
    .sort();
  const known = new Map<string, Schema>(
    files.map((f) => [f, JSON.parse(readFileSync(join(root, SCHEMA_DIR, f), "utf8")) as Schema]),
  );
  const out: Array<{ path: string; text: string }> = [];
  for (const file of files) {
    const schema = known.get(file) as Schema;
    if (schema.$id !== file) throw new Error(`${file}: $id must be "${file}"`);
    const gen = new Generator(file, known);
    const body: string[] = [];
    const schemaId = schema.properties?.schema?.const;
    if (typeof schemaId === "string") {
      body.push(
        `/** The \`schema\` value of every ${schema.title} object. */\nexport const SCHEMA_ID = ${JSON.stringify(schemaId)} as const;\n`,
      );
    }
    if (schema.properties && schema.title) {
      body.push(gen.declaration(schema.title, schema));
    }
    for (const [name, def] of Object.entries(schema.$defs ?? {})) {
      body.push(gen.declaration(name, def));
    }
    body.push(
      `/** ${file} as data, without its annotations: what \`schemaProblems\` checks against. */\nexport const JSON_SCHEMA = ${JSON.stringify(stripped(schema))};\n`,
    );
    const imports = [...gen.imports.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([mod, names]) => `import type { ${[...names].sort().join(", ")} } from "./${mod}";\n`)
      .join("");
    const header = `/** Generated from spec/schemas/${file} by scripts/model-types.ts (\`bun run types\`). Do not edit: change the schema and regenerate. */\n\n`;
    out.push({
      path: `${OUT_DIR}/${moduleOf(file)}.ts`,
      text: `${header}${imports}${imports ? "\n" : ""}${body.join("\n")}`,
    });
  }
  return out;
}

const REPO = join(import.meta.dirname, "..");

function format(path: string, text: string): string {
  const result = Bun.spawnSync(["bunx", "biome", "format", `--stdin-file-path=${path}`], {
    cwd: REPO,
    stdin: new TextEncoder().encode(text),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`biome could not format ${path}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

export function generatedFiles(root: string): Array<{ path: string; text: string }> {
  return generate(root).map(({ path, text }) => ({ path, text: format(path, text) }));
}

function tryReadDir(path: string): string[] | undefined {
  try {
    return readdirSync(path);
  } catch {
    return undefined;
  }
}

export function staleFiles(root: string): string[] {
  const files = generatedFiles(root);
  const stale = files
    .filter(({ path, text }) => {
      try {
        return readFileSync(join(root, path), "utf8") !== text;
      } catch {
        return true;
      }
    })
    .map(({ path }) => path);
  const wanted = new Set(files.map((f) => f.path));
  const present = (tryReadDir(join(root, OUT_DIR)) ?? []).map((f) => `${OUT_DIR}/${f}`);
  return [...stale, ...present.filter((p) => !wanted.has(p))];
}

if (import.meta.main) {
  const root = REPO;
  if (process.argv.includes("--check")) {
    const stale = staleFiles(root);
    if (stale.length > 0) {
      console.error(`stale: ${stale.join(", ")}; run \`bun run types\``);
      process.exit(1);
    }
  } else {
    const files = generatedFiles(root);
    const wanted = new Set(files.map((f) => f.path));
    for (const f of readdirSync(join(root, OUT_DIR))) {
      if (!wanted.has(`${OUT_DIR}/${f}`)) rmSync(join(root, OUT_DIR, f));
    }
    for (const { path, text } of files) writeFileSync(join(root, path), text);
  }
}
