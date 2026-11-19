import { relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { isIgnored, parseDockerignore, repositoryRules } from "./docker-context";

const ROOT = resolve(import.meta.dirname, "..");

describe("parseDockerignore / isIgnored", () => {
  const rules = parseDockerignore(
    [
      "# a comment",
      "**/node_modules",
      "**/testdata",
      "**/*.test.ts",
      "docs",
      "scripts/*",
      "!scripts/build-binary.ts",
      "*.md",
      "dist",
      "!dist/docker",
    ].join("\n"),
  );

  it("follows Docker's matching: folders, ** across segments, * within one, ! and last wins", () => {
    expect(isIgnored(rules, "packages/ts/review/testdata/labelled/fixtures.json")).toBe(true);
    expect(isIgnored(rules, "testdata/x.json")).toBe(true);
    expect(isIgnored(rules, "node_modules/zod/index.js")).toBe(true);
    expect(isIgnored(rules, "packages/ts/store/src/open.test.ts")).toBe(true);
    expect(isIgnored(rules, "docs/config.md")).toBe(true);
    expect(isIgnored(rules, "scripts/check-layers.ts")).toBe(true);
    expect(isIgnored(rules, "scripts/build-binary.ts")).toBe(false);
    expect(isIgnored(rules, "README.md")).toBe(true);
    // `*.md` is anchored at the root: one segment only.
    expect(isIgnored(rules, "packages/ts/review/README.md")).toBe(false);
    expect(isIgnored(rules, "dist/seshi")).toBe(true);
    expect(isIgnored(rules, "dist/docker/linux-amd64/seshi")).toBe(false);
    expect(isIgnored(rules, "packages/ts/review/src/eval.ts")).toBe(false);
    expect(isIgnored(rules, "packages/ts/review/src/labelled-fixtures.json")).toBe(false);
  });
});

describe("the image build context", () => {
  it("holds every workspace file the seshi binary imports", async () => {
    // The Dockerfile's build stage compiles apps/seshi/src/main.ts from the docker-ignored
    // context, with node_modules installed inside the image. Bundling here lists the same
    // inputs without compiling.
    const result = await Bun.build({
      entrypoints: [resolve(ROOT, "apps/seshi/src/main.ts")],
      target: "bun",
      conditions: ["bun"],
      metafile: true,
      throw: false,
    });
    expect(result.logs.filter((l) => l.level === "error").map(String)).toEqual([]);
    const inputs = Object.keys(result.metafile?.inputs ?? {})
      .map((p) => relative(ROOT, resolve(ROOT, p)).split(sep).join("/"))
      .filter((p) => !p.startsWith("node_modules/") && !p.includes("/node_modules/"));
    expect(inputs.length).toBeGreaterThan(50);
    expect(inputs).toContain("packages/ts/review/src/labelled-fixtures.json");
    const rules = repositoryRules(ROOT);
    expect(inputs.filter((p) => isIgnored(rules, p))).toEqual([]);
  });
});
