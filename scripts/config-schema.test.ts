import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { schemaFiles, staleFiles } from "./config-schema";

const root = join(import.meta.dirname, "..");

describe("config JSON Schemas", () => {
  it("are current in spec/ (run `bun run schema` after changing the config schema)", () => {
    expect(staleFiles(root)).toEqual([]);
  });

  it("are found stale when missing or different", () => {
    const dir = mkdtempSync(join(tmpdir(), "seshi-schema-"));
    try {
      mkdirSync(join(dir, "spec"));
      const [server] = schemaFiles();
      writeFileSync(join(dir, "spec/config.schema.json"), `${server?.text.slice(0, -2)}\n`);
      expect(staleFiles(dir)).toEqual(["spec/config.schema.json", "spec/cli-config.schema.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("describe the TOML editors complete: strict tables, secrets, defaults", () => {
    const server = JSON.parse(schemaFiles()[0]?.text ?? "{}");
    expect(server.$id).toContain("spec/config.schema.json");
    expect(server.additionalProperties).toBe(false);
    expect(server.required).toEqual(["store"]);
    expect(server.properties.store.properties.url.type).toBe("string");
    expect(server.properties.auth.properties.tokens.additionalProperties["x-seshi-secret"]).toBe(
      true,
    );
    expect(server.properties.filter.properties.min_chars.default).toBe(2000);
    expect(server.properties.records.properties.dropped_retention.default).toBe("30d");
    expect(server.properties.sources.items.oneOf).toHaveLength(4);
  });
});
