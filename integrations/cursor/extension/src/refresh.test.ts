import { describe, expect, it } from "vitest";
import { Debouncer, relevantChange } from "./refresh";

describe("what change refreshes the indicator", () => {
  const config = "/home/me/.config/seshi/config.toml";
  it("is the state file (also as its temporary file), a recorded prompt, or the CLI config", () => {
    expect(relevantChange("/s/seshi", "state.json", config)).toBe(true);
    expect(relevantChange("/s/seshi", "state.json.123-ab.tmp", config)).toBe(true);
    expect(relevantChange("/s/seshi/recent", "cursor-1.json", config)).toBe(true);
    expect(relevantChange("/home/me/.config/seshi", "config.toml", config)).toBe(true);
    expect(relevantChange("/s/seshi", null, config)).toBe(true);
  });

  it("is not seshi's rules cache, which statusline itself writes, nor the uploader's heartbeat", () => {
    expect(relevantChange("/s/seshi", "rules.json", config)).toBe(false);
    expect(relevantChange("/s/seshi", "uploader.json", config)).toBe(false);
    expect(relevantChange("/s/seshi", "capture.log", config)).toBe(false);
  });
});

describe("Debouncer", () => {
  it("runs once after the last of a burst", () => {
    const pending = new Map<number, () => void>();
    let next = 0;
    const timers = {
      set: (fn: () => void) => {
        pending.set(++next, fn);
        return next;
      },
      clear: (h: unknown) => pending.delete(h as number),
    };
    let runs = 0;
    const d = new Debouncer(() => runs++, 300, timers);
    d.poke();
    d.poke();
    d.poke();
    expect(pending.size).toBe(1);
    for (const [h, fn] of pending) {
      pending.delete(h);
      fn();
    }
    expect(runs).toBe(1);
    d.poke();
    d.dispose();
    expect(pending.size).toBe(0);
  });
});
