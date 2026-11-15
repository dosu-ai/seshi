/** The scenario clock: one time every reader in the process sees. It starts at a fixed instant,
 * moves forward with real time (so a lock wait or a short backoff still runs out) and jumps
 * when a scenario says `clock: +2h`.
 *
 * Readers that take a clock (the uploader, the Instance and its auth, `checkStore`, the sweep)
 * are given `now`. The rest (the CLI's capture commands, the hook's spool entries, a pipeline
 * default) call `new Date()` or `Date.now()`, so while a scenario runs the global `Date` is
 * replaced by one that reads this clock. `restore` puts the real one back. Nothing in
 * production code changes for it. */

const RealDate = Date;

/** Where every scenario's clock starts: a fixed instant in the past, so file times the OS
 * writes (always later) never look older than the scenario's own. */
export const SCENARIO_EPOCH = RealDate.parse("2026-09-01T09:00:00.000Z");

export class ScenarioClock {
  private offset = 0;
  private readonly realStart = performance.now();
  private installed: DateConstructor | undefined;

  constructor(private readonly start = SCENARIO_EPOCH) {}

  /** Milliseconds since the epoch, as the scenario sees them. */
  ms(): number {
    return Math.floor(this.start + this.offset + (performance.now() - this.realStart));
  }

  now = (): Date => new RealDate(this.ms());

  /** Jump forward. */
  advance(ms: number): void {
    if (ms < 0) throw new Error("the clock only moves forward");
    this.offset += ms;
  }

  /** Jump to `at` when it is later than now. */
  advanceTo(at: number): void {
    const now = this.ms();
    if (at > now) this.offset += at - now;
  }

  /** Make the global `Date` read this clock. */
  install(): void {
    if (this.installed) return;
    const clock = this;
    // A subclass keeps every method and static (`parse`, `UTC`); only "now" changes. Dates made
    // before the swap are still instances of it.
    class ScenarioDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(clock.ms());
        else super(...(args as [string | number | Date]));
      }
      static override now(): number {
        return clock.ms();
      }
      static [Symbol.hasInstance](value: unknown): boolean {
        return value instanceof RealDate;
      }
    }
    this.installed = ScenarioDate as unknown as DateConstructor;
    globalThis.Date = this.installed;
  }

  restore(): void {
    if (!this.installed) return;
    globalThis.Date = RealDate;
    this.installed = undefined;
  }
}

/** A seeded generator in [0, 1) (mulberry32), so `random` is the same on every run. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
