import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "@seshi/model";
import { describe, expect, it } from "vitest";
import type { CommandContext, CommandSpec } from "./commands/index";
import { COMMANDS } from "./commands/index";
import { main, takeNoColor } from "./main";

/** Runs `main` with captured output and the given registry. */
async function run(argv: string[], commands?: Record<string, CommandSpec>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    env: { HOME: "/nowhere" },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    commands,
    integrations: async () => [],
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("seshi", () => {
  it("prints its version", async () => {
    for (const flag of ["--version", "-v", "version"]) {
      expect(await run([flag])).toEqual({ code: 0, out: `seshi ${VERSION}`, err: "" });
    }
  });

  it("lists the commands on --help, and on no command with exit 2", async () => {
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("usage: seshi <command>");
    expect(help.out).toMatch(/serve\s+run the server/);
    const none = await run([]);
    expect(none.code).toBe(2);
    expect(none.err).toContain("usage: seshi <command>");
  });

  it("refuses an unknown command with exit 2", async () => {
    const { code, err } = await run(["nope"]);
    expect(code).toBe(2);
    expect(err).toContain("seshi: unknown command 'nope'");
    expect((await run(["toString"])).code).toBe(2);
  });

  it("loads only the command that runs, and passes it the rest of argv", async () => {
    const loaded: string[] = [];
    let seen: CommandContext | undefined;
    const spec = (name: string, code: number): CommandSpec => ({
      summary: name,
      load: async () => {
        loaded.push(name);
        return {
          run: async (ctx) => {
            seen = ctx;
            return code;
          },
        };
      },
    });
    const result = await run(["two", "--flag", "x"], { one: spec("one", 1), two: spec("two", 3) });
    expect(result.code).toBe(3);
    expect(loaded).toEqual(["two"]);
    expect(seen?.argv).toEqual(["--flag", "x"]);
    expect(seen?.env).toEqual({ HOME: "/nowhere" });
    expect(await seen?.integrations()).toEqual([]);
  });

  it("takes --no-color out of argv for every command, and says so in the context", async () => {
    let seen: CommandContext | undefined;
    const spec: CommandSpec = {
      summary: "x",
      load: async () => ({
        run: async (ctx) => {
          seen = ctx;
          return 0;
        },
      }),
    };
    await run(["x", "a", "--no-color", "b", "--", "--no-color"], { x: spec });
    expect(seen?.argv).toEqual(["a", "b", "--", "--no-color"]);
    expect(seen?.noColor).toBe(true);
    // Output a caller captures is not a terminal: no colour, no questions.
    expect(seen?.tty).toEqual({ stdout: false, stdin: false });
    expect(seen?.terminal).toBeUndefined();
    await run(["x"], { x: spec });
    expect(seen?.noColor).toBeUndefined();
    expect(takeNoColor(["--no-color"])).toEqual({ noColor: true, rest: [] });
  });

  it("prints a command's usage on <command> --help, exit 0", async () => {
    // `hook` (called by agents, prints nothing) and `statusline` (reads the agent's payload)
    // take no command line to speak of.
    const names = Object.keys(COMMANDS).filter((n) => n !== "hook" && n !== "statusline");
    for (const name of names) {
      for (const flag of ["--help", "-h"]) {
        const result = await run([name, flag]);
        expect({ name, flag, code: result.code }).toEqual({ name, flag, code: 0 });
        expect(result.out).toContain(`seshi ${name}`);
        expect(result.out).toContain("usage:");
        expect(result.err).toBe("");
      }
    }
    const json = await run(["sessions", "--help", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out).usage).toContain("seshi sessions ls");
    // After `--` it is an argument, and a wrong command line is still exit 2.
    expect((await run(["sessions", "--", "--help"])).code).toBe(2);
    expect((await run(["sessions", "frobnicate"])).code).toBe(2);
  });

  // A shebang runs only on macOS and Linux; on Windows npm puts a .cmd shim in front instead.
  it.skipIf(process.platform === "win32")(
    "runs as the package's bin, with no `bun` in front",
    async () => {
      // `bin.seshi` points at main.ts, so the file itself must be executable by its shebang.
      const entry = join(import.meta.dirname, "main.ts");
      expect(readFileSync(entry, "utf8").startsWith("#!/usr/bin/env bun\n")).toBe(true);
      const proc = Bun.spawn([entry, "--version"], {
        env: { PATH: process.env.PATH ?? "" },
        stdout: "pipe",
      });
      expect(await proc.exited).toBe(0);
      expect((await new Response(proc.stdout).text()).trim()).toBe(`seshi ${VERSION}`);
    },
  );
});
