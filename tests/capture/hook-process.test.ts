/** `seshi hook` and `seshi statusline` as the agent runs them: a new process each time, input on
 * stdin, nothing on stdout or stderr from the hook, inside its time budget (X3.3). The CI budget
 * itself is `bun run check:hook` (250 ms, and under half of loading the server); this checks the
 * same path loosely, so a slow test machine does not make it flaky. No uploader is started. */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MAIN = resolve(import.meta.dirname, "../../apps/seshi/src/main.ts");

let home: string;
let env: Record<string, string>;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "seshi-hook-process-"));
  mkdirSync(join(home, "code"));
  writeFileSync(join(home, "s.jsonl"), "{}\n");
  env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
    XDG_CONFIG_HOME: join(home, "config"),
    SESHI_NO_UPLOADER: "1",
    NO_COLOR: "1",
  };
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

async function seshi(args: string[], stdin: string) {
  const started = performance.now();
  const proc = Bun.spawn(["bun", MAIN, ...args], {
    env,
    stdin: Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err, ms: performance.now() - started };
}

describe("the hook process", () => {
  const payload = () =>
    JSON.stringify({
      session_id: "s1",
      transcript_path: join(home, "s.jsonl"),
      cwd: join(home, "code"),
    });

  it("exits 0 silently and spools, quickly", async () => {
    // The first run loads the CLI config into capture's rules cache.
    expect(await seshi(["hook", "claude-code", "Stop"], payload())).toMatchObject({
      code: 0,
      out: "",
      err: "",
    });
    const times: number[] = [];
    for (let i = 0; i < 3; i++)
      times.push((await seshi(["hook", "claude-code", "Stop"], payload())).ms);
    times.sort((a, b) => a - b);
    expect(times[1]).toBeLessThan(1500);
    expect(readdirSync(join(home, "state", "seshi", "spool"))).toHaveLength(4);
  });

  it("prints one status line", async () => {
    const run = await seshi(
      ["statusline"],
      JSON.stringify({ session_id: "s1", cwd: join(home, "code") }),
    );
    expect(run).toMatchObject({ code: 0, out: "Session Capture ◉ · 4 queued\n", err: "" });
  });
});
