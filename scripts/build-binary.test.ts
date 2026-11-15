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
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
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

  it("runs operator patterns under RE2 and the built-in pack inside the binary (F2.2)", async () => {
    await Bun.write(
      join(dir, "acme.toml"),
      'id = "acme"\n[[rules]]\nid = "acme-key"\npattern = \'ACME-(?P<secret>[0-9]{4})\'\ntests.match = ["ACME-1234"]\n',
    );
    const tested = await run(
      ["redact", "test", "-", "--pack", "acme.toml", "--text", "--print", "--json"],
      "key ACME-1234 and ghp_abcdefghijklmnopqrstuvwx0123456789\n",
    );
    expect(tested.code).toBe(0);
    const doc = JSON.parse(tested.out);
    expect(doc.output).toEqual(["key ACME-[redacted:acme-key] and [redacted:github-token]"]);
    expect(doc.tests.failed).toEqual([]);
    await Bun.write(
      join(dir, "bad.toml"),
      'id = "bad"\n[[rules]]\nid = "x"\npattern = "(a)\\\\1"\n',
    );
    const refused = await run(["redact", "test", "--pack", "bad.toml"]);
    expect(refused.code).toBe(3);
    expect(refused.err).toContain("RE2 has no backreferences");
  });

  it("reads neither the working folder's .env nor its bunfig.toml", async () => {
    // A repository an agent works in: its .env names a store, its bunfig preloads a script.
    await Bun.write(join(dir, ".env"), "SESHI_STORE__URL=file:///from-dotenv\n");
    await Bun.write(join(dir, "preload.ts"), 'console.log("PRELOADED");\n');
    await Bun.write(join(dir, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    const shown = await run(["config", "show", "--json"]);
    expect(shown.out + shown.err).not.toContain("from-dotenv");
    expect(shown.out + shown.err).not.toContain("PRELOADED");
    const version = await run(["--version"]);
    expect(version.out.trim()).toBe(`seshi ${VERSION}`);
  });
});
