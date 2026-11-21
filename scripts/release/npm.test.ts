import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tarGz } from "./archive";
import { buildRelease, repositoryVersion } from "./build";
import {
  addDeclarationExtensions,
  BARE_LAUNCHER,
  badgeUrl,
  buildNpm,
  LAUNCHER,
  LIBRARIES,
  launcherManifest,
  libraryDependencies,
  type NpmPackage,
  platformManifest,
  readme,
} from "./npm";
import { CHECKSUMS, hostTarget, REPOSITORY, TARGETS, targetById } from "./targets";
import { exec, installPackages, standInCompile } from "./testing";

const VERSION = repositoryVersion();
const posix = process.platform !== "win32";
const node = Bun.which("node");

describe("readme (B1.5)", () => {
  it("points at the badge in the repository at the release's tag", () => {
    expect(badgeUrl("1.2.3")).toBe(
      `https://raw.githubusercontent.com/${REPOSITORY}/v1.2.3/brand/glyph/seshi-glyph-badge.svg`,
    );
    // The file the URL names is in this checkout, so the tag a release makes from it has it.
    expect(existsSync(join(import.meta.dirname, "../../brand/glyph/seshi-glyph-badge.svg"))).toBe(
      true,
    );
    const text = readme("@seshi/model", "Types.", "1.2.3");
    expect(text).toContain("# @seshi/model\n\n*Every session has a thread.*\n\nTypes.\n");
    expect(text).toContain(`Docs: https://github.com/${REPOSITORY}#readme`);
  });
});

describe("addDeclarationExtensions", () => {
  it("gives relative declaration imports the extension Node's ESM resolution needs", () => {
    const types = mkdtempSync(join(tmpdir(), "seshi-dts-"));
    try {
      mkdirSync(join(types, "schemas"));
      writeFileSync(join(types, "api.d.ts"), "export type A = 1;\n");
      writeFileSync(join(types, "schemas/index.d.ts"), "export type S = 2;\n");
      writeFileSync(
        join(types, "schemas/store.d.ts"),
        'import type { A } from "../api";\nexport type T = A | import("./index").S;\n',
      );
      writeFileSync(
        join(types, "index.d.ts"),
        [
          'export type { A } from "./api";',
          "export * from './schemas';",
          'export type { T } from "./schemas/store";',
          'export { x } from "./already.js";',
          'export type { Ext } from "@dosu/seshi-model";',
          "",
        ].join("\n"),
      );
      addDeclarationExtensions(types);
      expect(readFileSync(join(types, "index.d.ts"), "utf8")).toBe(
        [
          'export type { A } from "./api.js";',
          "export * from './schemas/index.js';",
          'export type { T } from "./schemas/store.js";',
          'export { x } from "./already.js";',
          'export type { Ext } from "@dosu/seshi-model";',
          "",
        ].join("\n"),
      );
      expect(readFileSync(join(types, "schemas/store.d.ts"), "utf8")).toBe(
        'import type { A } from "../api.js";\nexport type T = A | import("./index.js").S;\n',
      );
      writeFileSync(join(types, "broken.d.ts"), 'export * from "./missing";\n');
      expect(() => addDeclarationExtensions(types)).toThrow(/\.\/missing matches no declaration/);
    } finally {
      rmSync(types, { recursive: true, force: true });
    }
  });
});

describe("manifests", () => {
  it("platform packages install only on their own os, cpu and libc", () => {
    expect(platformManifest(targetById("linux-arm64"), "1.2.3")).toMatchObject({
      name: "@dosu/seshi-linux-arm64",
      version: "1.2.3",
      os: ["linux"],
      cpu: ["arm64"],
      libc: ["glibc"],
      files: ["bin/"],
      license: "MIT",
    });
    const win = platformManifest(targetById("windows-x64"), "1.2.3");
    expect(win).toMatchObject({ os: ["win32"], cpu: ["x64"] });
    expect(win).not.toHaveProperty("libc");
    expect(win).not.toHaveProperty("bin");
  });

  it("the launcher pins every platform package at its own version", () => {
    const manifest = launcherManifest("1.2.3");
    expect(manifest).toMatchObject({ name: "@dosu/seshi", bin: { seshi: "bin/seshi.js" } });
    expect(manifest.optionalDependencies).toEqual(
      Object.fromEntries(TARGETS.map((t) => [t.npm, "1.2.3"])),
    );
    expect(manifest).not.toHaveProperty("private");
    expect(manifest).not.toHaveProperty("dependencies");
  });

  it("libraries depend on published workspace packages at the release's version", () => {
    expect(libraryDependencies({ "@seshi/model": "workspace:*" }, "1.2.3")).toEqual({
      "@dosu/seshi-model": "1.2.3",
    });
    expect(libraryDependencies({ "@letta-ai/trajectory": "^0.3.0" }, "1.2.3")).toEqual({
      "@letta-ai/trajectory": "^0.3.0",
    });
    expect(() => libraryDependencies({ "@seshi/store": "workspace:*" }, "1.2.3")).toThrow(
      /not published/,
    );
    expect(libraryDependencies(undefined, "1.2.3")).toEqual({});
  });
});

describe.skipIf(!posix)("buildNpm", () => {
  let release: string;
  let out: string;
  let packages: NpmPackage[];

  beforeAll(async () => {
    release = mkdtempSync(join(tmpdir(), "seshi-npm-release-"));
    out = mkdtempSync(join(tmpdir(), "seshi-npm-out-"));
    // The stand-in binary echoes its arguments, its stdin, and exits with $EXIT (or signals).
    const body = [
      `if [ "$1" = "--version" ]; then echo "seshi ${VERSION}"; exit 0; fi`,
      `if [ "$1" = "--signal" ]; then kill -TERM $$; fi`,
      `echo "args:$*"`,
      `if [ "$1" = "--stdin" ]; then cat; fi`,
      `exit "\${EXIT:-0}"`,
    ].join("\n");
    await buildRelease({ out: release, compile: standInCompile(VERSION, body).compile });
    packages = await buildNpm({ version: VERSION, from: release, out });
  }, 120_000);
  afterAll(() => {
    rmSync(release, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it("builds every package in publish order, the launchers last", () => {
    const names = [
      ...TARGETS.map((t) => t.npm),
      ...LIBRARIES.map((l) => l.name),
      LAUNCHER,
      BARE_LAUNCHER,
    ];
    expect(packages.map((p) => p.name)).toEqual(names);
    const listed = JSON.parse(readFileSync(join(out, "packages.json"), "utf8"));
    expect(listed.map((p: { name: string }) => p.name)).toEqual(names);
    for (const p of packages) {
      const manifest = JSON.parse(readFileSync(join(p.dir, "package.json"), "utf8"));
      expect(manifest.name).toBe(p.name);
      expect(manifest.version).toBe(VERSION);
      expect(manifest.private).toBeUndefined();
      expect(existsSync(join(p.dir, "LICENSE"))).toBe(true);
      expect(existsSync(join(p.dir, "README.md"))).toBe(true);
    }
  });

  it("heads every README with the face-free glyph from the release's tag (B1.5)", () => {
    for (const p of packages) {
      const text = readFileSync(join(p.dir, "README.md"), "utf8");
      expect(text.startsWith(`<img src="${badgeUrl(VERSION)}"`)).toBe(true);
      expect(text).toContain(`# ${p.name}\n`);
    }
  });

  it("publishes under @dosu, with no import of an unpublished workspace name left", () => {
    for (const p of packages) {
      if (p.name !== BARE_LAUNCHER) expect(p.name.startsWith("@dosu/seshi")).toBe(true);
    }
    const client = join(out, "client");
    const manifest = JSON.parse(readFileSync(join(client, "package.json"), "utf8"));
    expect(manifest.dependencies).toMatchObject({ "@dosu/seshi-model": VERSION });
    expect(manifest.dependencies).not.toHaveProperty("@seshi/model");
    const files = readdirSync(client, { recursive: true, encoding: "utf8" }).filter((f) =>
      /\.(?:js|d\.ts)$/.test(f),
    );
    for (const f of files) {
      expect(readFileSync(join(client, f), "utf8")).not.toMatch(/["']@seshi\/model["']/);
    }
    expect(readFileSync(join(client, "dist/index.js"), "utf8")).toContain('"@dosu/seshi-model"');
  });

  it("puts each release archive's binary, executable, in its platform package", () => {
    for (const target of TARGETS) {
      const bin = join(out, `cli-${target.id}`, "bin", target.binary);
      expect(readFileSync(bin, "utf8")).toContain(`# ${target.id}`);
      expect(statSync(bin).mode & 0o777).toBe(0o755);
    }
    const launcher = join(out, "seshi/bin/seshi.js");
    expect(readFileSync(launcher, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(readFileSync(launcher, "utf8")).not.toContain(process.cwd());
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
  });

  it("publishes the same launcher as `seshi`, last and optional", () => {
    const listed = JSON.parse(readFileSync(join(out, "packages.json"), "utf8"));
    expect(listed.at(-1)).toEqual({ name: BARE_LAUNCHER, dir: "launcher-seshi", optional: true });
    expect(listed.filter((p: { optional?: boolean }) => p.optional)).toHaveLength(1);
    const scoped = JSON.parse(readFileSync(join(out, "seshi/package.json"), "utf8"));
    const bare = JSON.parse(readFileSync(join(out, "launcher-seshi/package.json"), "utf8"));
    expect(bare).toEqual({ ...scoped, name: BARE_LAUNCHER });
    expect(readFileSync(join(out, "launcher-seshi/bin/seshi.js"))).toEqual(
      readFileSync(join(out, "seshi/bin/seshi.js")),
    );
    expect(readFileSync(join(out, "launcher-seshi/README.md"), "utf8")).toContain("npm i -g seshi");
  });

  it("refuses archives that do not match SHA256SUMS, or a missing line", async () => {
    const bad = mkdtempSync(join(tmpdir(), "seshi-npm-bad-"));
    try {
      await buildRelease({ out: bad, compile: standInCompile(VERSION).compile });
      const target = TARGETS[2];
      if (!target) throw new Error("no target");
      writeFileSync(join(bad, target.asset), tarGz([{ name: "seshi", data: new Uint8Array(3) }]));
      const opts = { version: VERSION, from: bad, out: join(bad, "npm"), libraries: false };
      await expect(buildNpm(opts)).rejects.toThrow(`${target.asset} does not match its checksum`);
      writeFileSync(join(bad, CHECKSUMS), "");
      await expect(buildNpm(opts)).rejects.toThrow(/has no line for/);
      await expect(buildNpm({ ...opts, version: "nope" })).rejects.toThrow(/not a version/);
      await expect(buildNpm({ ...opts, version: "99.0.0", libraries: true })).rejects.toThrow(
        /build from the release's tag/,
      );
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });

  describe.skipIf(!node)("installed as npm lays it out, run by Node", () => {
    let project: string;
    let lonely: string;
    beforeAll(() => {
      project = mkdtempSync(join(tmpdir(), "seshi-npm-project-"));
      lonely = mkdtempSync(join(tmpdir(), "seshi-npm-lonely-"));
      const host = hostTarget();
      const wanted = new Set([LAUNCHER, host.npm, ...LIBRARIES.map((l) => l.name)]);
      installPackages(
        project,
        packages.filter((p) => wanted.has(p.name)),
      );
      // The launcher alone, as with --omit=optional (a folder of its own, so Node's lookup
      // cannot climb into the project's node_modules).
      installPackages(
        lonely,
        packages.filter((p) => p.name === LAUNCHER),
      );
    });
    afterAll(() => {
      rmSync(project, { recursive: true, force: true });
      rmSync(lonely, { recursive: true, force: true });
    });

    const launcher = () => join(project, "node_modules/@dosu/seshi/bin/seshi.js");

    it("runs this machine's binary with the same arguments, stdin and exit status", async () => {
      const version = await exec([node as string, launcher(), "--version"]);
      expect(version).toMatchObject({ code: 0, out: `seshi ${VERSION}\n` });
      const echoed = await exec([node as string, launcher(), "--stdin", "a b", "c"], {
        stdin: "from stdin\n",
        env: { PATH: process.env.PATH ?? "", EXIT: "7" },
      });
      expect(echoed.out).toBe("args:--stdin a b c\nfrom stdin\n");
      expect(echoed.code).toBe(7);
    });

    it("ends the way the binary ended when a signal ends it", async () => {
      const killed = await exec([node as string, launcher(), "--signal"]);
      expect(killed.signal).toBe("SIGTERM");
    });

    it("repairs a platform binary whose executable bit was lost", async () => {
      const bin = join(project, "node_modules", hostTarget().npm, "bin/seshi");
      chmodSync(bin, 0o644);
      expect((await exec([node as string, launcher(), "--version"])).code).toBe(0);
      expect(statSync(bin).mode & 0o111).not.toBe(0);
    });

    it("says what to do when the platform package is missing", async () => {
      const alone = join(lonely, "node_modules/@dosu/seshi/bin/seshi.js");
      const ran = await exec([node as string, alone, "--version"]);
      expect(ran.code).toBe(1);
      expect(ran.err).toContain(`the package ${hostTarget().npm}`);
      expect(ran.err).toContain("--omit=optional");
    });

    it("imports @dosu/seshi-client and @dosu/seshi-model as ES modules", async () => {
      const script = join(project, "use.mjs");
      writeFileSync(
        script,
        [
          'import { HttpSeshi, SessionRejected, authConfig } from "@dosu/seshi-client";',
          'import { VERSION, canonicalText, parseTrace } from "@dosu/seshi-model";',
          "const db = new HttpSeshi({ server: 'http://127.0.0.1:1', token: 't' });",
          "console.log(JSON.stringify({ VERSION, db: typeof db.getSession, fns: [typeof authConfig, typeof canonicalText, typeof parseTrace], err: new SessionRejected('x', 'y') instanceof Error }));",
        ].join("\n"),
      );
      const ran = await exec([node as string, script], { cwd: project });
      expect(ran.err).toBe("");
      expect(JSON.parse(ran.out)).toEqual({
        VERSION,
        db: "function",
        fns: ["function", "function", "function"],
        err: true,
      });
    });

    it("gives TypeScript users the declarations", async () => {
      const file = join(project, "use.ts");
      writeFileSync(
        file,
        [
          'import { HttpSeshi, type StoredTrace } from "@dosu/seshi-client";',
          'import type { Visibility } from "@dosu/seshi-model";',
          "const db: HttpSeshi = new HttpSeshi({ server: 'http://x', token: 't' });",
          "const v: Visibility = 'org';",
          // Proves the types are real: an unresolved declaration import makes them `any`, and
          // then this line is no error and the directive itself fails.
          "// @ts-expect-error not a visibility",
          "export const wrong: Visibility = 'not-a-visibility';",
          "export async function f(): Promise<StoredTrace | null> { return db.getTrace('claude-code', 's'); }",
          "export { v };",
        ].join("\n"),
      );
      writeFileSync(
        join(project, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2023",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            // The published declarations are checked too, as a consumer's strict build would.
            skipLibCheck: false,
            lib: ["ES2023", "DOM"],
            types: [],
          },
          files: ["use.ts"],
        }),
      );
      const tsc = join(process.cwd(), "node_modules/typescript/bin/tsc");
      const ran = await exec([process.execPath, tsc, "-p", join(project, "tsconfig.json")]);
      expect(ran.out + ran.err).toBe("");
      expect(ran.code).toBe(0);
    });
  });
});
