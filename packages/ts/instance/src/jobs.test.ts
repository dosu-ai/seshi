import { describe, expect, it } from "vitest";
import { type Job, type JobResult, JobRunner } from "./jobs";

/** Resolves once `check` holds, polling; fails after `ms`. */
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

function job(
  name: string,
  run: (signal: AbortSignal) => Promise<JobResult | undefined>,
  extra: Partial<Job> = {},
): Job {
  return { name, kind: "test", placement: "worker", intervalMs: 20, run, ...extra };
}

describe("JobRunner", () => {
  it("refuses two jobs with one name and an interval of zero", () => {
    const runner = new JobRunner({ worker: true });
    runner.register(job("a", async () => undefined));
    expect(() => runner.register(job("a", async () => undefined))).toThrow(/already registered/);
    expect(() => runner.register(job("b", async () => undefined, { intervalMs: 0 }))).toThrow(
      /interval/,
    );
  });

  it("runs worker jobs only on the worker, and jobs placed on every instance everywhere", async () => {
    let worker = 0;
    let every = 0;
    const make = (isWorker: boolean) => {
      const runner = new JobRunner({ worker: isWorker });
      runner.register(job("w", async () => void worker++));
      runner.register(job("e", async () => void every++, { placement: "every" }));
      return runner;
    };
    const api = make(false);
    api.start();
    await until(() => every >= 1);
    await api.stop();
    expect(worker).toBe(0);
    const both = make(true);
    expect(both.runsHere(both.get("w") as Job)).toBe(true);
    both.start();
    await until(() => worker >= 2);
    await both.stop();
  });

  it("records each run: outcome, last ok, last error until a run succeeds, counts", async () => {
    let n = 0;
    const now = () => new Date("2026-11-14T12:00:00.000Z");
    const runner = new JobRunner({ worker: true, now });
    runner.register(
      job("flaky", async () => {
        n++;
        if (n === 1) throw new Error("boom");
        if (n === 2) return { outcome: "error", error: "connector said no" };
        if (n === 3) return { outcome: "discarded", error: "moved" };
        return { summary: { stored: 2 } };
      }),
    );
    expect(await runner.runNow("flaky")).toMatchObject({
      runs: 1,
      failures: 1,
      last_outcome: "error",
      last_error: { at: "2026-11-14T12:00:00.000Z", message: "boom" },
    });
    expect((await runner.runNow("flaky")).last_error?.message).toBe("connector said no");
    const discarded = await runner.runNow("flaky");
    expect(discarded).toMatchObject({ runs: 3, failures: 2, last_outcome: "discarded" });
    expect(discarded.last_error).toBeUndefined();
    expect(await runner.runNow("flaky")).toMatchObject({
      runs: 4,
      failures: 2,
      last_outcome: "ok",
      last_ok: "2026-11-14T12:00:00.000Z",
      last_summary: { stored: 2 },
    });
    expect(runner.snapshot().flaky?.runs).toBe(4);
    expect(() => runner.runNow("nope")).toThrow(/no job/);
  });

  it("runs again at once when a run says more is waiting", async () => {
    let runs = 0;
    const runner = new JobRunner({ worker: true });
    runner.register(job("pager", async () => ({ more: ++runs < 4 }), { intervalMs: 60_000 }));
    runner.start();
    await until(() => runs >= 4);
    await Bun.sleep(30);
    await runner.stop();
    // Three pages said more; the fourth did not, so the next run waits a minute.
    expect(runs).toBe(4);
  });

  it("retries a failed run with backoff, never past the interval (X4.8)", async () => {
    const runner = new JobRunner({ worker: true, retryBaseMs: 1_000 });
    let fail = true;
    const j = job(
      "flaky",
      async () => {
        if (fail) throw new Error("the store is down");
        return undefined;
      },
      { intervalMs: 5_000 },
    );
    runner.register(j);
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) delays.push(runner.delayAfter(j, await runner.runNow("flaky")));
    expect(delays).toEqual([1_000, 2_000, 4_000, 5_000, 5_000]);
    fail = false;
    expect(runner.delayAfter(j, await runner.runNow("flaky"))).toBe(5_000);
    fail = true;
    // A success resets the backoff.
    expect(runner.delayAfter(j, await runner.runNow("flaky"))).toBe(1_000);
  });

  it("retries soon after a failure when started", async () => {
    let runs = 0;
    const runner = new JobRunner({ worker: true, retryBaseMs: 10 });
    runner.register(
      job(
        "flaky",
        async () => {
          runs++;
          if (runs < 3) throw new Error("not yet");
          return undefined;
        },
        { intervalMs: 60_000 },
      ),
    );
    runner.start();
    await until(() => runs >= 3);
    await Bun.sleep(30);
    await runner.stop();
    // Two failures retried within milliseconds; the success waits the minute.
    expect(runs).toBe(3);
  });

  it("joins a run already in progress instead of starting another", async () => {
    let runs = 0;
    let release: () => void = () => {};
    const runner = new JobRunner({ worker: true });
    runner.register(
      job("slow", async () => {
        runs++;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return undefined;
      }),
    );
    const a = runner.runNow("slow");
    const b = runner.runNow("slow");
    release();
    await Promise.all([a, b]);
    expect(runs).toBe(1);
  });

  it("aborts running jobs on stop and waits for them, bounded", async () => {
    let aborted = false;
    const runner = new JobRunner({ worker: true });
    runner.register(
      job("long", (signal) => {
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve(undefined);
          });
        });
      }),
    );
    runner.register(job("stuck", () => new Promise(() => {})));
    runner.start();
    await until(() => runner.snapshot().long !== undefined);
    const started = Date.now();
    await runner.stop(100);
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(runner.running).toBe(false);
  });

  it("schedules a job registered after start", async () => {
    let ran = false;
    const runner = new JobRunner({ worker: true });
    runner.start();
    runner.register(
      job("late", async () => {
        ran = true;
        return undefined;
      }),
    );
    await until(() => ran);
    await runner.stop();
  });
});

describe("JobRunner.unregister", () => {
  it("stops scheduling a job, aborts its run and waits for it, and leaves the rest running", async () => {
    let aborted = false;
    let started = false;
    let other = 0;
    const runner = new JobRunner({ worker: true });
    runner.register(
      job(
        "slow",
        (signal) =>
          new Promise((resolve) => {
            started = true;
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve(undefined);
            });
          }),
        { intervalMs: 60_000 },
      ),
    );
    runner.register(job("other", async () => void other++));
    runner.start();
    await until(() => started && other > 0);
    expect(await runner.unregister("slow")).toBe(true);
    expect(aborted).toBe(true);
    expect(runner.get("slow")).toBeUndefined();
    expect(runner.snapshot().slow).toBeUndefined();
    const before = other;
    await until(() => other > before);
    expect(await runner.unregister("slow")).toBe(false);
    // The name can be used again.
    runner.register(job("slow", async () => undefined));
    await runner.stop();
  });

  it("gives up waiting after the timeout", async () => {
    const runner = new JobRunner({ worker: true });
    let started = false;
    runner.register(
      job("stuck", () => {
        started = true;
        return new Promise(() => {});
      }),
    );
    runner.start();
    await until(() => started);
    const at = Date.now();
    await runner.unregister("stuck", 50);
    expect(Date.now() - at).toBeLessThan(1000);
    await runner.stop(10);
  });
});
