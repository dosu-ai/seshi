import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { watchConfig } from "./config-watch";

let dir: string;
let stop: (() => void) | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-watch-"));
});
afterEach(() => {
  stop?.();
  rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

describe("watchConfig", () => {
  it("calls once per burst of changes to the files and drop-ins, and not for other files", async () => {
    const file = join(dir, "seshi.toml");
    const pack = join(dir, "packs", "org.toml");
    const dropIns = join(dir, "seshi.d");
    mkdirSync(join(dir, "packs"));
    writeFileSync(file, "");
    writeFileSync(pack, "");
    let calls = 0;
    const watcher = watchConfig({
      files: () => [file, pack],
      dirs: () => [dropIns],
      onChange: () => calls++,
      debounceMs: 100,
    });
    stop = watcher.close;
    // macOS may report the writes made just before the watch began; let them pass.
    await Bun.sleep(400);
    calls = 0;

    writeFileSync(join(dir, "notes.txt"), "x");
    await Bun.sleep(300);
    expect(calls).toBe(0);

    writeFileSync(file, "a");
    writeFileSync(pack, "b");
    await until(() => calls === 1);
    await Bun.sleep(200);
    expect(calls).toBe(1);

    // seshi.d/ appearing is a change; once re-armed, a drop-in renamed into it is one too.
    mkdirSync(dropIns);
    await until(() => calls === 2);
    watcher.rearm();
    writeFileSync(join(dropIns, ".adx.tmp"), "c");
    renameSync(join(dropIns, ".adx.tmp"), join(dropIns, "adx.toml"));
    await until(() => calls === 3);
  });
});
