import { VERSION } from "@seshi/model";
import { describe, expect, it } from "vitest";
import type { CommandContext, CommandSpec } from "./commands/index";
import { COMMANDS } from "./commands/index";
import { main } from "./main";

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

  it("registers every command lazily", () => {
    expect(Object.keys(COMMANDS)).toContain("serve");
    for (const spec of Object.values(COMMANDS)) expect(typeof spec.load).toBe("function");
  });
});
