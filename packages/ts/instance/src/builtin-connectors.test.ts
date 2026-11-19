/** Every Instance polls `s3` sources with the built-in S3 poller (F6), unless the binary brings
 * its own connector for that type. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type ServerConfig, serverConfigSchema } from "@seshi/config";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import type { Connector } from "@seshi/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildInstance } from "./instance";

const formats = new FormatRegistry([...BUILTIN_FORMATS]);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-builtin-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function config(toml: string): ServerConfig {
  const text = `[store]\nurl = "file://${join(dir, "bucket")}"\n${toml}`;
  return loadConfig(serverConfigSchema, {
    file: "seshi.toml",
    fs: { readFile: () => text, mode: () => 0o100600 },
  }).config;
}

describe("the built-in S3 poller", () => {
  it("polls an s3 source without any integration", async () => {
    const drop = join(dir, "drop");
    mkdirSync(drop);
    writeFileSync(
      join(drop, "atif-1.json"),
      JSON.stringify({
        schema_version: "ATIF-v1.7",
        session_id: "atif-1",
        agent: { name: "x", version: "1" },
        steps: [
          { step_id: 1, source: "user", message: `Hello ${"there ".repeat(300)}` },
          { step_id: 2, source: "agent", message: `Hi ${"back ".repeat(300)}` },
        ],
      }),
    );
    const instance = await buildInstance(
      config(`[[sources]]\nid = "drop"\ntype = "s3"\nurl = "file://${drop}"\n`),
      { formats, env: {} },
    );
    try {
      expect(instance.sources.get("drop")).toMatchObject({ polled: true, connector: "s3" });
      const report = await instance.sources.run("drop");
      expect(report).toMatchObject({ outcome: "ok", outcomes: { stored: 1 } });
    } finally {
      await instance.close();
    }
  });

  it("gives way to a connector the binary brings for s3", async () => {
    let ran = 0;
    const own: Connector = {
      kind: "s3",
      async run() {
        ran++;
        return undefined;
      },
    };
    const instance = await buildInstance(
      config(`[[sources]]\nid = "drop"\ntype = "s3"\nurl = "s3://elsewhere/x"\n`),
      { formats, env: {}, connectors: [own] },
    );
    try {
      await instance.sources.run("drop");
      expect(ran).toBe(1);
    } finally {
      await instance.close();
    }
  });

  it("reads bucket keys from the env the instance was built with", async () => {
    const instance = await buildInstance(
      config(`[[sources]]\nid = "far"\ntype = "s3"\nurl = "s3://elsewhere/x"\n`),
      { formats, env: {} },
    );
    try {
      const report = await instance.sources.run("far");
      expect(report.outcome).toBe("error");
      expect(report.error).toContain("needs keys");
    } finally {
      await instance.close();
    }
  });
});
