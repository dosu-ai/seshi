/** The stored-object contract (X3.10): what the pipeline writes validates against the JSON
 * Schemas in `spec/schemas/`, and the conformance objects in `spec/testdata/objects/` (which
 * every language's reader runs) validate too and reproduce their content hashes. It crosses
 * packages (model, pipeline, store) and reads spec/, so it lives in tests/ (X3.6). */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHANGE_SCHEMA,
  ENVELOPE_SCHEMA,
  LAYOUT_SCHEMA,
  METADATA_SCHEMA,
  parseTrace,
  type SchemaFile,
  schemaProblems,
  TRACE_SCHEMA,
  type Trace,
} from "@seshi/model";
import { StoreSessionDB } from "@seshi/pipeline";
import { FsStore, getBytes, gunzipJson, LAYOUT_KEY } from "@seshi/store";
import { Ajv2020 } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { buildFormats } from "seshi/integrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transcript } from "../tooling/testdata";

const SPEC = join(import.meta.dirname, "../../spec");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
addFormats(ajv);
const schemaFiles = readdirSync(join(SPEC, "schemas")).filter((f) => f.endsWith(".schema.json"));
for (const file of schemaFiles) ajv.addSchema(read(join(SPEC, "schemas", file)));

function check(schema: string, value: unknown): void {
  const validate = ajv.getSchema(schema);
  if (!validate) throw new Error(`no schema ${schema}`);
  const ok = validate(value);
  expect(ok, `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

describe("spec/schemas", () => {
  it("compile under strict JSON Schema 2020-12 and name the ids the model uses", () => {
    expect(schemaFiles.sort()).toEqual([
      "change.schema.json",
      "common.schema.json",
      "envelope.schema.json",
      "layout.schema.json",
      "metadata.schema.json",
      "trace.schema.json",
    ]);
    const id = (file: string) => read(join(SPEC, "schemas", file)).properties.schema.const;
    expect(id("trace.schema.json")).toBe(TRACE_SCHEMA);
    expect(id("metadata.schema.json")).toBe(METADATA_SCHEMA);
    expect(id("change.schema.json")).toBe(CHANGE_SCHEMA);
    expect(id("layout.schema.json")).toBe(LAYOUT_SCHEMA);
    expect(id("envelope.schema.json")).toBe(ENVELOPE_SCHEMA);
  });
});

describe("spec/testdata/objects", () => {
  const dir = join(SPEC, "testdata/objects");
  const objects = readdirSync(dir).filter((f) => f.endsWith(".json"));

  it.each(objects)("%s validates against its schema", (file) => {
    check(`${file.split(".")[0]}.schema.json`, read(join(dir, file)));
  });

  it("a trace's records reproduce its events and content hash", () => {
    const trace = read(join(dir, "trace.claude-code.json")) as Trace;
    const again = parseTrace(trace.records, {
      agent: trace.agent,
      session_id: trace.session_id ?? undefined,
      project: trace.project,
      branch: trace.branch,
      metadata: trace.metadata,
      llm_calls: trace.llm_calls,
      provenance: trace.provenance,
    });
    expect(again).toEqual(trace);
  });

  it("refuses objects that break the contract", () => {
    const trace = read(join(dir, "trace.claude-code.json"));
    const validate = ajv.getSchema("trace.schema.json");
    expect(validate?.({ ...trace, schema: "sessionstorage/trace/1" })).toBe(false);
    expect(validate?.({ ...trace, extra: 1 })).toBe(false);
    const metadata = read(join(dir, "metadata.stored.json"));
    const { writer: _writer, ...noWriter } = metadata;
    expect(ajv.getSchema("metadata.schema.json")?.(noWriter)).toBe(false);
    expect(ajv.getSchema("metadata.schema.json")?.({ ...metadata, visibility: "public" })).toBe(
      false,
    );
  });
});

describe("schemaProblems (@seshi/model) agrees with ajv", () => {
  const dir = join(SPEC, "testdata/objects");
  const objects = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const fileOf = (name: string) => `${name.split(".")[0]}.schema.json` as SchemaFile;

  it.each(objects)("finds nothing wrong with %s", (file) => {
    expect(schemaProblems(fileOf(file), read(join(dir, file)))).toEqual([]);
  });

  /** Every way of breaking an object one field at a time that the contract refuses or allows. */
  function mutations(value: Record<string, unknown>): Array<[string, unknown]> {
    const out: Array<[string, unknown]> = [
      ["no schema", { ...value, schema: undefined }],
      ["an extra field", { ...value, extra: 1 }],
      ["an array", [value]],
      ["null", null],
    ];
    for (const [key, field] of Object.entries(value)) {
      const { [key]: _gone, ...without } = value;
      out.push([`without ${key}`, without]);
      out.push([`${key} as a number`, { ...value, [key]: 7 }]);
      out.push([`${key} as -1`, { ...value, [key]: -1 }]);
      out.push([`${key} as text`, { ...value, [key]: "not-a-hash" }]);
      out.push([`${key} as a hash`, { ...value, [key]: "a".repeat(64) }]);
      out.push([`${key} as null`, { ...value, [key]: null }]);
      out.push([`${key} as a date`, { ...value, [key]: "2026-11-14T09:00:00.000Z" }]);
      out.push([`${key} as a bad date`, { ...value, [key]: "2026-13-45T99:00:00Z" }]);
      if (Array.isArray(field) && field.length > 0 && typeof field[0] === "object") {
        const first = field[0] as Record<string, unknown>;
        for (const inner of Object.keys(first)) {
          const { [inner]: _x, ...rest } = first;
          out.push([`${key}[0] without ${inner}`, { ...value, [key]: [rest, ...field.slice(1)] }]);
          out.push([`${key}[0].${inner} as -1`, { ...value, [key]: [{ ...first, [inner]: -1 }] }]);
        }
      } else if (field && typeof field === "object" && !Array.isArray(field)) {
        for (const inner of Object.keys(field)) {
          const { [inner]: _x, ...rest } = field as Record<string, unknown>;
          out.push([`${key} without ${inner}`, { ...value, [key]: rest }]);
          out.push([`${key}.${inner} as 7`, { ...value, [key]: { ...field, [inner]: 7 } }]);
          out.push([`${key}.extra`, { ...value, [key]: { ...field, extra: "x" } }]);
        }
      }
    }
    return out;
  }

  it.each(objects.filter((f) => !f.startsWith("trace.") && !f.startsWith("envelope.")))(
    "says the same as ajv of every one-field change to %s",
    (file) => {
      const schema = fileOf(file);
      const validate = ajv.getSchema(schema);
      if (!validate) throw new Error(`no schema ${schema}`);
      for (const [what, value] of mutations(read(join(dir, file)))) {
        const ours = schemaProblems(schema, JSON.parse(JSON.stringify(value) ?? "null"));
        const theirs = validate(JSON.parse(JSON.stringify(value) ?? "null"));
        expect(ours.length === 0, `${file}, ${what}: ${ours.join("; ")}`).toBe(theirs === true);
      }
    },
  );
});

describe("what the pipeline writes", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "seshi-conformance-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("is the contract: marker, metadata, trace and change entries", async () => {
    const store = new FsStore(root);
    const db = new StoreSessionDB({ store, owner: "acme", formats: buildFormats() });
    const claude = transcript("claude-basic.claude-code.jsonl");
    const long = `${claude.trim()}\n${JSON.stringify({
      type: "assistant",
      uuid: "a9",
      timestamp: "2026-09-01T00:09:00.000Z",
      sessionId: "sess1",
      message: {
        role: "assistant",
        model: "claude-x",
        content: [{ type: "text", text: "details ".repeat(400) }],
      },
    })}\n`;
    const result = await db.ingest({ agent: "claude-code", session_id: "sess1", transcript: long });
    if (!("content_hash" in result)) throw new Error("expected a trace");
    check(
      "layout.schema.json",
      JSON.parse(new TextDecoder().decode((await getBytes(store, LAYOUT_KEY)) as Uint8Array)),
    );
    check("metadata.schema.json", await db.getSession("claude-code", "sess1"));
    const files = (await store.list("owners/acme/")).keys;
    const traceKey = files.find((k) => k.endsWith(".json.gz") && k.includes("/trace.")) as string;
    check("trace.schema.json", gunzipJson((await getBytes(store, traceKey)) as Uint8Array));
    await db.tombstone("claude-code", "sess1");
    check("metadata.schema.json", await db.getSession("claude-code", "sess1"));
    const changes = (await db.changes()).entries.map((e) => e.entry);
    expect(changes.map((c) => c.kind)).toEqual(["published", "tombstone"]);
    for (const change of changes) check("change.schema.json", change);
  });
});
