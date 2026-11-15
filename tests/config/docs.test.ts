/** The example config and the config reference stay in step with the schema. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  configJsonSchemas,
  isSettingName,
  loadConfig,
  serverConfigSchema,
  shapeOf,
} from "@seshi/config";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");

describe("seshi.example.toml", () => {
  it("is a valid server config", () => {
    const loaded = loadConfig(serverConfigSchema, {
      file: join(root, "seshi.example.toml"),
      resolveSecrets: false,
    });
    expect(loaded.config.store.url).toBe("s3://acme-sessions/prod");
    expect(loaded.config.sources.map((s) => s.id)).toEqual(["datadog-prod", "eval-logs"]);
  });
});

describe("docs/config.md", () => {
  const doc = readFileSync(join(root, "docs", "config.md"), "utf8");
  const { server } = configJsonSchemas() as {
    server: { properties: Record<string, { properties?: Record<string, unknown> }> };
  };

  it("documents every section and every key of every table", () => {
    const missing: string[] = [];
    for (const [section, node] of Object.entries(server.properties)) {
      if (!doc.includes(section)) missing.push(section);
      for (const key of Object.keys(node.properties ?? {})) {
        if (!doc.includes(`\`${key}`) && !doc.includes(`${section}.${key}`)) {
          missing.push(`${section}.${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe(".env.example", () => {
  const lines = readFileSync(join(root, ".env.example"), "utf8").split("\n");
  const settings = lines
    .map((line) => /^(#\s*)?(SESHI_[A-Z0-9_]+)=(\S*)/.exec(line))
    .filter((match) => match !== null);

  it("names only settings, set or commented out", () => {
    const shape = shapeOf(serverConfigSchema);
    expect(settings.length).toBeGreaterThan(5);
    expect(
      settings.map((m) => m[2]).filter((name) => !isSettingName(shape, name as string)),
    ).toEqual([]);
  });

  it("is a config the server loads as it is", () => {
    const env = Object.fromEntries(
      settings.filter((m) => m[1] === undefined).map((m) => [m[2], m[3]]),
    );
    const { config } = loadConfig(serverConfigSchema, { env });
    expect(config.store.url).toBe("file:///tmp/seshi");
    expect(Object.keys(config.auth.tokens)).toEqual(["alice", "bob"]);
  });
});
