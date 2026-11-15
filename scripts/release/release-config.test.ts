/** release.config.js and ci.yml against what the release scripts produce: every asset the
 * build writes is uploaded, every script they call exists, and the platforms CI tests are the
 * release's targets. */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECKSUMS, INSTALL_SCRIPTS, TARGETS } from "./targets";

const ROOT = resolve(import.meta.dirname, "../..");
const CI = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
// A JavaScript module TypeScript does not type: imported by path.
const config = (await import(join(ROOT, "release.config.js"))).default as { plugins: Plugin[] };

type Plugin = string | [string, Record<string, unknown>];
const plugins = config.plugins;
const options = (name: string) =>
  (plugins.find((p) => Array.isArray(p) && p[0] === name) as [string, Record<string, unknown>])[1];

function glob(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

describe("release.config.js", () => {
  it("uploads exactly the assets scripts/release/build.ts writes", () => {
    const patterns = (options("@semantic-release/github").assets as { path: string }[]).map((a) =>
      glob(a.path),
    );
    const written = [...TARGETS.map((t) => t.asset), ...INSTALL_SCRIPTS, CHECKSUMS].map(
      (name) => `dist/release/${name}`,
    );
    for (const file of written)
      expect(
        patterns.some((p) => p.test(file)),
        file,
      ).toBe(true);
    for (const p of patterns)
      expect(
        written.some((f) => p.test(f)),
        String(p),
      ).toBe(true);
    // The bare binaries under dist/release/bin/ are not uploaded.
    expect(patterns.some((p) => p.test("dist/release/bin/linux-x64/seshi"))).toBe(false);
  });

  it("sets the version before building, into the folder it uploads", () => {
    const prepare = options("@semantic-release/exec").prepareCmd as string;
    const [version, build] = prepare.split(" && ");
    // semantic-release fills in the placeholder.
    const next = ["$", "{nextRelease.version}"].join("");
    expect(version).toBe(`bun run scripts/release-version.ts ${next}`);
    expect(build).toBe(`bun run scripts/release/build.ts --version ${next} --out dist/release`);
    for (const script of prepare.match(/scripts\/[\w/.-]+\.ts/g) ?? []) {
      expect(existsSync(join(ROOT, script)), script).toBe(true);
    }
    // The version files are committed with the release; built files never are.
    expect(options("@semantic-release/git").assets).toEqual([
      "packages/ts/model/package.json",
      "bun.lock",
      "CHANGELOG.md",
    ]);
  });

  it("publishes nothing to npm itself: that is ci.yml's npm job, from the release's assets", () => {
    expect(plugins.some((p) => (Array.isArray(p) ? p[0] : p) === "@semantic-release/npm")).toBe(
      false,
    );
  });
});

describe("ci.yml", () => {
  it("tests a binary on a runner for every release target", () => {
    for (const target of TARGETS) expect(CI, target.id).toContain(`target: ${target.id}`);
  });

  it("calls only scripts that exist", () => {
    for (const script of new Set(CI.match(/scripts\/[\w/.-]+\.(ts|sh|ps1)/g) ?? [])) {
      expect(existsSync(join(ROOT, script)), script).toBe(true);
    }
    for (const name of CI.match(/bun run ([\w:-]+)/g) ?? []) {
      const script = name.replace("bun run ", "");
      if (script.includes(":") || ["build", "check", "typecheck", "test"].includes(script)) {
        const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
        expect(manifest.scripts, script).toHaveProperty(script);
      }
    }
  });

  it("publishes npm packages with provenance from the release's assets", () => {
    expect(CI).toContain("bun run release:npm --version");
    expect(CI).toContain("bun run release:publish-npm --provenance");
    expect(CI).toMatch(/gh release download "v\$\{\{ needs\.release\.outputs\.version \}\}"/);
  });
});
