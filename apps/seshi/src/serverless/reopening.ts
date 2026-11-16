/** Something opened that must be closed: a bucket and the instance built on it. */
export interface Closable {
  close(): Promise<void>;
}

/** One opened thing, opened again once it is older than `maxAgeMs`, shared by every job that
 * uses it. One open runs at a time, and a replaced one is closed only when the last job that
 * was using it ends (F11: the serverless sink reopens the bucket to read the shared settings,
 * the minimum version and the mode again). */
export class Reopening<T extends Closable> {
  private current: T | undefined;
  private openedAt = 0;
  private opening: Promise<T> | undefined;
  private readonly users = new Map<T, number>();
  private readonly retired = new Set<T>();

  constructor(
    private readonly openFresh: () => Promise<T>,
    private readonly maxAgeMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The current one, opened (again) when there is none or it is too old. */
  open(): Promise<T> {
    if (this.current && this.now() - this.openedAt < this.maxAgeMs) {
      return Promise.resolve(this.current);
    }
    this.opening ??= (async () => {
      try {
        const next = await this.openFresh();
        const old = this.current;
        this.current = next;
        this.openedAt = this.now();
        if (old) await this.retire(old);
        return next;
      } finally {
        this.opening = undefined;
      }
    })();
    return this.opening;
  }

  /** Open again at the next use (a refusal may mean a new key or settings). */
  expire(): void {
    this.openedAt = Number.NEGATIVE_INFINITY;
  }

  /** Run `work` on the current one, which stays open until `work` ends. */
  async use<R>(work: (opened: T) => Promise<R>): Promise<R> {
    let opened = await this.open();
    // A newer one may have replaced it between the open and now: use that.
    while (opened !== this.current) opened = await this.open();
    this.users.set(opened, (this.users.get(opened) ?? 0) + 1);
    try {
      return await work(opened);
    } finally {
      const left = (this.users.get(opened) ?? 1) - 1;
      if (left > 0) this.users.set(opened, left);
      else {
        this.users.delete(opened);
        if (this.retired.delete(opened)) await opened.close();
      }
    }
  }

  async close(): Promise<void> {
    await this.opening?.catch(() => undefined);
    for (const old of this.retired) await old.close();
    this.retired.clear();
    await this.current?.close();
    this.current = undefined;
  }

  private async retire(old: T): Promise<void> {
    if ((this.users.get(old) ?? 0) > 0) this.retired.add(old);
    else await old.close();
  }
}
