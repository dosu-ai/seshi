import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkLayers, importsOf, PACKAGE_LAYERS } from "./check-layers";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "seshi-layers-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A workspace unit with a package.json declaring `deps`. */
function unit(id: string, name: string, deps: string[] = []): void {
  write(
    `${id}/package.json`,
    JSON.stringify({ name, dependencies: Object.fromEntries(deps.map((d) => [d, "workspace:*"])) }),
  );
  write(`${id}/src/index.ts`, "export {};\n");
}

/** The smallest repository with every packages/ts folder, so none is reported unlayered. */
function repo(): void {
  write("package.json", JSON.stringify({ name: "root", devDependencies: {} }));
  for (const name of Object.keys(PACKAGE_LAYERS)) {
    const deps = name === "model" ? [] : ["@seshi/model"];
    unit(`packages/ts/${name}`, `@seshi/${name.split("/").pop()}`, deps);
  }
}

const messages = () => checkLayers(root).violations.map((v) => `${v.file}: ${v.message}`);

describe("importsOf", () => {
  it("finds static, type-only, re-exported, dynamic and side-effect imports", () => {
    const text = [
      'import { a } from "@seshi/a";',
      'import type { B } from "@seshi/b";',
      'export { c } from "@seshi/c";',
      'export type { D } from "@seshi/d";',
      'export * from "./e";',
      'import "./f";',
      'const g = await import("@seshi/g");',
      '// import { h } from "@seshi/h";',
      'const s = "import { i } from \\"@seshi/i\\"";',
    ].join("\n");
    expect(importsOf(text)).toEqual([
      "@seshi/a",
      "@seshi/b",
      "@seshi/c",
      "@seshi/d",
      "./e",
      "./f",
      "@seshi/g",
    ]);
  });
});

describe("checkLayers", () => {
  it("passes the repository itself", () => {
    const result = checkLayers(resolve(import.meta.dirname, ".."));
    expect(result.problems).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(result.files).toBeGreaterThan(50);
  });

  it("passes imports from lower layers that are declared", () => {
    repo();
    write(
      "packages/ts/pipeline/package.json",
      JSON.stringify({
        name: "@seshi/pipeline",
        dependencies: { "@seshi/model": "workspace:*", "@seshi/store": "workspace:*" },
      }),
    );
    write(
      "packages/ts/pipeline/src/x.ts",
      'import type { T } from "@seshi/model";\nimport { s } from "@seshi/store";\nimport { y } from "./y";\n',
    );
    expect(checkLayers(root)).toMatchObject({ violations: [], problems: [] });
  });

  it("refuses an import from the same or a higher layer", () => {
    repo();
    write("packages/ts/store/src/x.ts", 'import { r } from "@seshi/redact";\n');
    write("packages/ts/model/src/x.ts", 'import { p } from "@seshi/pipeline";\n');
    expect(messages()).toEqual([
      "packages/ts/model/src/x.ts: layer 0 may import only from lower layers; packages/ts/pipeline is layer 2 (X3.2)",
      "packages/ts/store/src/x.ts: layer 1 may import only from lower layers; packages/ts/redact is layer 1 (X3.2)",
    ]);
  });

  it("keeps integrations to model, kit and formats, and out of every package", () => {
    repo();
    unit("integrations/acme", "@seshi/integration-acme", ["@seshi/store"]);
    write("integrations/acme/src/x.ts", 'import { s } from "@seshi/store";\n');
    write("packages/ts/api/src/x.ts", 'import { acme } from "@seshi/integration-acme";\n');
    expect(messages()).toEqual([
      "packages/ts/api/src/x.ts: only apps import integrations; pass what they provide down instead (X3.11)",
      "integrations/acme/src/x.ts: an integration imports only ts/model, ts/kit and ts/formats (X3.2)",
    ]);
  });

  it("lets an app import an integration, and refuses one integration importing another", () => {
    repo();
    unit("integrations/acme", "@seshi/integration-acme", ["@seshi/integration-other"]);
    unit("integrations/other", "@seshi/integration-other");
    unit("apps/seshi", "seshi", ["@seshi/integration-acme"]);
    write("apps/seshi/src/x.ts", 'import { acme } from "@seshi/integration-acme";\n');
    write("integrations/acme/src/x.ts", 'import { o } from "@seshi/integration-other";\n');
    expect(messages()).toEqual([
      "integrations/acme/src/x.ts: only apps import integrations; pass what they provide down instead (X3.11)",
    ]);
  });

  it("keeps ts/client to ts/model and ts/capture off ts/instance", () => {
    repo();
    write("packages/ts/client/src/x.ts", 'import { k } from "@seshi/kit";\n');
    write("packages/ts/capture/src/x.ts", 'import { i } from "@seshi/instance";\n');
    expect(messages()).toEqual([
      "packages/ts/capture/src/x.ts: packages/ts/capture imports only packages/ts/model, packages/ts/kit, packages/ts/redact, packages/ts/config, packages/ts/client (X3.2)",
      "packages/ts/client/src/x.ts: packages/ts/client imports only packages/ts/model (X3.2)",
    ]);
  });

  it("refuses a relative import into another package, and any import of tests/", () => {
    repo();
    write("tests/tooling/x.ts", "export const x = 1;\n");
    write("packages/ts/store/src/x.ts", 'import { m } from "../../model/src/index";\n');
    write("packages/ts/redact/src/x.ts", 'import { x } from "../../../../tests/tooling/x";\n');
    expect(messages()).toEqual([
      "packages/ts/redact/src/x.ts: a relative import reaches into tests; import it by its package name",
      "packages/ts/store/src/x.ts: a relative import reaches into packages/ts/model; import it by its package name",
    ]);
  });

  it("refuses a workspace import the importer does not declare", () => {
    repo();
    write("packages/ts/pipeline/src/x.ts", 'import { s } from "@seshi/store";\n');
    expect(messages()).toEqual([
      "packages/ts/pipeline/src/x.ts: @seshi/store is not declared in packages/ts/pipeline/package.json",
    ]);
  });

  it("lets tests and scripts import any package declared at the root, by name only", () => {
    repo();
    write("package.json", JSON.stringify({ devDependencies: { "@seshi/api": "workspace:*" } }));
    write(
      "tests/a.test.ts",
      'import { api } from "@seshi/api";\nimport { s } from "@seshi/store";\n',
    );
    write("scripts/b.ts", 'import { m } from "../packages/ts/model/src/index";\n');
    expect(messages()).toEqual([
      "tests/a.test.ts: @seshi/store is not declared in the root package.json",
      "scripts/b.ts: import packages/ts/model by its package name (@seshi/model), not a path",
    ]);
  });

  it("reports a package with no layer, and a unit with no package.json", () => {
    repo();
    write("packages/ts/extra/src/index.ts", "export {};\n");
    write("integrations/bare/src/index.ts", "export {};\n");
    expect(checkLayers(root).problems).toEqual([
      "packages/ts/extra: has no layer; add it to scripts/check-layers.ts",
      "integrations/bare: has no package.json",
    ]);
  });

  it("treats a package nested in another's folder as its own unit, at its own layer", () => {
    repo();
    unit("packages/ts/search/lance", "@seshi/lance", ["@seshi/model", "@seshi/search"]);
    write("packages/ts/search/lance/src/x.ts", 'import { s } from "@seshi/search";\n');
    // Its files are not ts/search's: ts/search importing it reaches up a layer.
    write("packages/ts/search/src/y.ts", 'import { l } from "@seshi/lance";\n');
    write("packages/ts/instance/src/z.ts", 'import { l } from "@seshi/lance";\n');
    expect(messages()).toEqual([
      "packages/ts/instance/src/z.ts: layer 4 may import only from lower layers; packages/ts/search/lance is layer 4 (X3.2)",
      "packages/ts/search/src/y.ts: layer 3 may import only from lower layers; packages/ts/search/lance is layer 4 (X3.2)",
    ]);
  });

  it("ignores external packages and testdata", () => {
    repo();
    write("packages/ts/model/src/x.ts", 'import { z } from "zod";\nimport ts from "typescript";\n');
    write("packages/ts/model/testdata/x.ts", 'import { p } from "@seshi/pipeline";\n');
    expect(messages()).toEqual([]);
  });
});
