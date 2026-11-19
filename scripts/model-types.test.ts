import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generate, generatedFiles, staleFiles } from "./model-types";

const root = join(import.meta.dirname, "..");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-types-"));
  mkdirSync(join(dir, "spec"), { recursive: true });
  cpSync(join(root, "spec/schemas"), join(dir, "spec/schemas"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("model types generated from spec/schemas (X3.10)", () => {
  it("are current in packages/ts/model (run `bun run types` after changing a schema)", () => {
    expect(staleFiles(root)).toEqual([]);
  });

  it("are found stale when missing, different, or left over", () => {
    const out = join(dir, "packages/ts/model/src/generated");
    expect(staleFiles(dir)).toContain("packages/ts/model/src/generated/trace.ts");
    mkdirSync(out, { recursive: true });
    for (const file of generatedFiles(dir)) writeFileSync(join(dir, file.path), file.text);
    expect(staleFiles(dir)).toEqual([]);
    writeFileSync(join(out, "trace.ts"), "// edited\n");
    writeFileSync(join(out, "old.ts"), "export {};\n");
    expect(staleFiles(dir)).toEqual([
      "packages/ts/model/src/generated/trace.ts",
      "packages/ts/model/src/generated/old.ts",
    ]);
  });

  it("generates one module per schema, with its schema id, types and cross-file imports", () => {
    const files = new Map(generate(root).map((f) => [f.path.split("/").at(-1), f.text]));
    expect([...files.keys()].sort()).toEqual([
      "change.ts",
      "common.ts",
      "envelope.ts",
      "layout.ts",
      "metadata.ts",
      "trace.ts",
    ]);
    const trace = files.get("trace.ts") as string;
    expect(trace).toContain('export const SCHEMA_ID = "seshi/trace/1" as const;');
    expect(trace).toContain("export interface Trace {");
    expect(trace).toContain("records: TraceRecord[];");
    expect(trace).toContain("llm_calls?: LlmCall[];");
    expect(trace).toMatch(/import type \{[^}]*Provenance[^}]*\} from "\.\/common";/);
    expect(trace).toContain("[key: string]: unknown;");
    expect(files.get("common.ts")).not.toContain("SCHEMA_ID");
    expect(files.get("envelope.ts")).toContain("export type Payload = LogPayload | SpanPayload;");
  });

  it("refuses a keyword it does not model, a dangling $ref, or a mismatched $id", () => {
    const schemas = join(dir, "spec/schemas");
    const write = (name: string, schema: unknown) =>
      writeFileSync(join(schemas, name), JSON.stringify(schema));
    write("x.schema.json", {
      $id: "x.schema.json",
      title: "X",
      type: "object",
      properties: { a: { type: "string", if: {} } },
    });
    expect(() => generate(dir)).toThrow(/unsupported if/);
    write("x.schema.json", {
      $id: "x.schema.json",
      title: "X",
      type: "object",
      properties: { a: { $ref: "#/$defs/Nope" } },
    });
    expect(() => generate(dir)).toThrow(/names nothing/);
    write("x.schema.json", { $id: "y.schema.json", title: "X", type: "object", properties: {} });
    expect(() => generate(dir)).toThrow(/\$id must be "x.schema.json"/);
  });
});
