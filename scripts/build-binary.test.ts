import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VERSION } from "@seshi/model";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCommand } from "./build-binary";

const ROOT = resolve(import.meta.dirname, "..");

describe("buildCommand", () => {
  it("compiles main.ts to dist/seshi with bytecode and the bun condition", () => {
    const { argv, outfile } = buildCommand({ root: "/repo" });
    expect(outfile).toBe(
      process.platform === "win32" ? "/repo/dist/seshi.exe" : "/repo/dist/seshi",
    );
    expect(argv.slice(1)).toEqual([
      "build",
      "/repo/apps/seshi/src/main.ts",
      "--compile",
      "--minify",
      "--bytecode",
      "--conditions",
      "bun",
      "--outfile",
      outfile,
    ]);
  });

  it("takes a target and names a Windows binary .exe", () => {
    const { argv, outfile } = buildCommand({ root: "/repo", target: "bun-windows-x64" });
    expect(outfile).toBe("/repo/dist/seshi.exe");
    expect(argv).toContain("bun-windows-x64");
    expect(buildCommand({ root: "/repo", outfile: "out/x" }).outfile).toBe("/repo/out/x");
  });
});

describe("the compiled binary (X2.2)", () => {
  let dir: string;
  let binary: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "seshi-binary-"));
    const built = buildCommand({ root: ROOT, outfile: join(dir, "seshi") });
    binary = built.outfile;
    const proc = Bun.spawn(built.argv, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function run(args: string[], stdin?: string) {
    const proc = Bun.spawn([binary, ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: dir },
      stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    return {
      code,
      out: await new Response(proc.stdout).text(),
      err: await new Response(proc.stderr).text(),
    };
  }

  it("runs without Bun's sources: version, a stub, a lazy command reading stdin", async () => {
    expect((await run(["--version"])).out.trim()).toBe(`seshi ${VERSION}`);
    const hook = await run(["hook", "claude-code", "Stop"]);
    expect(hook.code).toBe(9);
    const lines = [
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-09-01T00:00:00.000Z",
        sessionId: "s",
        message: { role: "user", content: "hello" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp: "2026-09-01T00:00:01.000Z",
        sessionId: "s",
        message: { role: "assistant", model: "m", content: [{ type: "text", text: "hi" }] },
      },
    ].map((l) => JSON.stringify(l));
    const normalized = await run(
      ["normalize", "--agent", "claude-code", "-"],
      `${lines.join("\n")}\n`,
    );
    expect(normalized.code).toBe(0);
    expect(JSON.parse(normalized.out.split("\n")[0] as string)).toMatchObject({ role: "meta" });
  });
});
