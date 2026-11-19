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

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

const DEBOUNCE = 250;

/** Waits until `count()` has not moved for a few debounce periods: the watcher's events for
 * what happened so far, including late ones from macOS, have all been delivered. */
async function settle(count: () => number): Promise<void> {
  let last = count();
  let quietSince = Date.now();
  while (Date.now() - quietSince < DEBOUNCE * 3) {
    await Bun.sleep(25);
    if (count() !== last) {
      last = count();
      quietSince = Date.now();
    }
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
    const count = () => calls;
    const watcher = watchConfig({
      files: () => [file, pack],
      dirs: () => [dropIns],
      onChange: () => calls++,
      debounceMs: DEBOUNCE,
    });
    stop = watcher.close;
    // macOS may report the writes made just before the watch began; let them pass.
    await settle(count);
    calls = 0;

    writeFileSync(join(dir, "notes.txt"), "x");
    await settle(count);
    expect(calls).toBe(0);

    writeFileSync(file, "a");
    writeFileSync(pack, "b");
    await until(() => calls >= 1);
    await settle(count);
    expect(calls).toBe(1);

    // seshi.d/ appearing is a change. macOS may report it more than once, so this counts
    // only that it was seen.
    mkdirSync(dropIns);
    await until(() => calls > 1);
    await settle(count);

    // Once re-armed, a drop-in renamed into seshi.d/ is a change too. A new watch can miss
    // what happens while it starts, so the write waits for it.
    watcher.rearm();
    await settle(count);
    const before = calls;
    writeFileSync(join(dropIns, ".adx.tmp"), "c");
    renameSync(join(dropIns, ".adx.tmp"), join(dropIns, "adx.toml"));
    await until(() => calls > before);
  });
});
