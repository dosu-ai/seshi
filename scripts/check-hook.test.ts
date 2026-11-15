import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importGraph, loadTimeImports, spoolEntries } from "./check-hook";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "seshi-hook-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function pkg(dir: string, name: string): void {
  write(
    `${dir}/package.json`,
    JSON.stringify({ name, exports: { ".": { bun: "./src/index.ts" } } }),
  );
}

describe("loadTimeImports", () => {
  it("follows static imports and re-exports, not types or dynamic imports", () => {
    const text = `
      import { a } from "./a";
      import type { B } from "./b";
      import "./side";
      export { c } from "./c";
      export type { D } from "./d";
      export * from "./e";
      const lazy = () => import("./lazy");
    `;
    expect(loadTimeImports(text)).toEqual(["./a", "./side", "./c", "./e"]);
  });
});

describe("the hook's import graph (X3.3)", () => {
  it("reaches no server, pipeline, store or search code in this repository", () => {
    const graph = importGraph(resolve(import.meta.dirname, ".."));
    expect(graph.violations).toEqual([]);
    expect(graph.files).toContain("apps/seshi/src/commands/hook.ts");
    expect(graph.files).toContain("apps/seshi/src/main.ts");
    expect(graph.files.some((f) => f.startsWith("packages/ts/api/"))).toBe(false);
    expect(graph.files.some((f) => f.startsWith("packages/ts/instance/"))).toBe(false);
  });

  it("names the chain that brings a forbidden package in", () => {
    pkg("packages/ts/store", "@seshi/store");
    write("packages/ts/store/src/index.ts", "export const x = 1;\n");
    pkg("packages/ts/capture", "@seshi/capture");
    write("packages/ts/capture/src/index.ts", 'import { x } from "@seshi/store";\nexport { x };\n');
    write("apps/seshi/package.json", JSON.stringify({ name: "seshi" }));
    write(
      "apps/seshi/src/main.ts",
      'import { COMMANDS } from "./commands/index";\nconst serve = () => import("@seshi/api");\n',
    );
    write("apps/seshi/src/commands/index.ts", "export const COMMANDS = {};\n");
    write(
      "apps/seshi/src/commands/hook.ts",
      'import { x } from "@seshi/capture";\nimport type { Y } from "@seshi/pipeline";\n',
    );
    write("apps/seshi/src/commands/statusline.ts", "export {};\n");
    const graph = importGraph(root);
    expect(graph.violations).toEqual([
      {
        specifier: "@seshi/store",
        chain: ["apps/seshi/src/commands/hook.ts", "packages/ts/capture/src/index.ts"],
      },
    ]);
  });

  it("records npm and node modules without following them, and catches protobuf", () => {
    write("apps/seshi/package.json", JSON.stringify({ name: "seshi" }));
    write("apps/seshi/src/main.ts", 'import "node:fs";\nimport "left-pad";\n');
    write("apps/seshi/src/commands/hook.ts", 'import "@bufbuild/protobuf";\nimport "zod";\n');
    write("apps/seshi/src/commands/statusline.ts", "export {};\n");
    const graph = importGraph(root);
    expect(graph.external).toEqual(["left-pad", "node:fs"]);
    // The config schema library stays out of a hook too: capture reads its rules from a cache.
    expect(graph.violations.map((v) => v.specifier)).toEqual(["@bufbuild/protobuf", "zod"]);
  });
});

describe("spoolEntries", () => {
  it("counts a spool's entries, and none when there is no spool", () => {
    expect(spoolEntries(join(root, "missing"))).toBe(0);
    write("spool/1.json", "{}");
    write("spool/2.json.tmp", "{");
    expect(spoolEntries(join(root, "spool"))).toBe(1);
  });
});
