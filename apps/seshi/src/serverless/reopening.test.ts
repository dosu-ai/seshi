import { describe, expect, it } from "vitest";
import { Reopening } from "./reopening";

function opener() {
  const made: { n: number; closed: boolean; close(): Promise<void> }[] = [];
  const open = async () => {
    const one = {
      n: made.length,
      closed: false,
      async close() {
        one.closed = true;
      },
    };
    made.push(one);
    return one;
  };
  return { made, open };
}

describe("Reopening (the serverless sink's bucket)", () => {
  it("shares one open between concurrent callers, and reopens once too old", async () => {
    const { made, open } = opener();
    let now = 0;
    const r = new Reopening(open, 100, () => now);
    const [a, b] = await Promise.all([r.open(), r.open()]);
    expect(a).toBe(b);
    expect(made).toHaveLength(1);
    now = 150;
    const c = await r.open();
    expect(c.n).toBe(1);
    expect(made[0]?.closed).toBe(true);
  });

  it("keeps a replaced one open until the job using it ends", async () => {
    const { made, open } = opener();
    let now = 0;
    const r = new Reopening(open, 100, () => now);
    let finish = () => {};
    const job = r.use(
      (opened) =>
        new Promise<number>((resolve) => {
          finish = () => resolve(opened.n);
        }),
    );
    await Promise.resolve();
    await Promise.resolve();
    now = 150;
    await r.open();
    expect(made[0]?.closed).toBe(false);
    finish();
    expect(await job).toBe(0);
    expect(made[0]?.closed).toBe(true);
    expect(made[1]?.closed).toBe(false);
    await r.close();
    expect(made[1]?.closed).toBe(true);
  });

  it("opens again after expire, and again after a failed open", async () => {
    const { made, open } = opener();
    let fail = true;
    const r = new Reopening(async () => {
      if (fail) throw new Error("no");
      return open();
    }, 1000);
    await expect(r.open()).rejects.toThrow("no");
    fail = false;
    await r.open();
    r.expire();
    await r.open();
    expect(made.map((m) => m.closed)).toEqual([true, false]);
  });
});
