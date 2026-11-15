import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-cwd-config-"));
  // A checkout someone else wrote: its seshi.toml is not even TOML, so reading it shows.
  writeFileSync(join(dir, "seshi.toml"), "this is = = not toml\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const MAIN = join(import.meta.dirname, "..", "main.ts");

/** Run seshi in `dir`, with no CLI config and no SESHI_* settings: what it printed. */
async function run(args: string[], timeoutMs = 10_000): Promise<string> {
  const proc = Bun.spawn(["bun", MAIN, ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: dir, XDG_CONFIG_HOME: join(dir, "config") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exited = await Promise.race([proc.exited, Bun.sleep(timeoutMs).then(() => null)]);
  if (exited === null) proc.kill();
  return (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
}

describe("./seshi.toml is read unasked by seshi serve only", () => {
  it("is not read by workers status or sync status, which say how to use it", async () => {
    for (const args of [
      ["workers", "status"],
      ["sync", "status"],
    ]) {
      const out = await run(args);
      expect(out).not.toMatch(/not valid TOML/);
      expect(out).toContain("pass --config ./seshi.toml");
    }
  });

  it("is read by seshi serve", async () => {
    const out = await run(["serve"], 5000);
    expect(out).toMatch(/seshi\.toml: not valid TOML/);
    expect(out).not.toContain("pass --config");
  });
});
