import { basename } from "node:path";

/** Whether a change seen in one of the watched folders matters. seshi replaces `state.json` by
 * renaming a temporary file (`state.json.<pid>-….tmp`) into place; `recent/` holds the last
 * conversation prompted per folder; the CLI config is one file. `rules.json` is ignored because
 * `seshi statusline` itself rewrites it, which would loop, and `uploader.json` is the
 * uploader's heartbeat. A change without a file name counts. */
export function relevantChange(
  watched: string,
  filename: string | null | undefined,
  configFile: string,
): boolean {
  if (!filename) return true;
  if (watched.endsWith("recent")) return true;
  if (filename === basename(configFile)) return true;
  return filename.startsWith("state.json");
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Calls `fn` once, `ms` after the last of a burst of `poke`s. */
export class Debouncer {
  private handle: unknown;
  constructor(
    private readonly fn: () => void,
    private readonly ms: number,
    private readonly timers: Timers = realTimers,
  ) {}

  poke(): void {
    if (this.handle !== undefined) this.timers.clear(this.handle);
    this.handle = this.timers.set(() => {
      this.handle = undefined;
      this.fn();
    }, this.ms);
  }

  dispose(): void {
    if (this.handle !== undefined) this.timers.clear(this.handle);
    this.handle = undefined;
  }
}
