/** The server's capture rules on this machine: the org's exclude list (`[capture] exclude` in the
 * server's config, `GET /v1/capture/rules`), fetched by the uploader and kept in
 * `capture-rules.json` with its ETag. Hooks, the status line and `seshi capture status` read the
 * copy (`withServerExcludes`); only the uploader fetches.
 *
 * - Before this machine holds a copy from the server it uploads to, that server's uploads wait:
 *   nothing goes up that its list may exclude.
 * - A later fetch that fails keeps the copy in use.
 * - A server without the route (404, older than the list) has no list: uploads go as before. */

import { tryReadJson, tryWritePrivateFile } from "./files";
import type { CapturePaths } from "./paths";

const SCHEMA = "seshi/server-capture-rules/1";

export interface OrgRules {
  schema: typeof SCHEMA;
  /** The server it came from (the sink's target). */
  server: string;
  etag?: string;
  /** The server's exclude list; null when the server serves none (older than the route). */
  exclude: string[] | null;
  fetched_at: string;
}

/** What a sink's server answered for its capture rules. */
export type CaptureRulesAnswer =
  | { exclude: string[]; etag?: string }
  /** The copy whose ETag was sent is still current (304). */
  | "unchanged"
  /** The server has no such route (404): it serves no list. */
  | "none";

export function readOrgRules(paths: CapturePaths): OrgRules | undefined {
  const read = tryReadJson(paths.orgRules) as Partial<OrgRules> | null | undefined;
  if (
    read?.schema !== SCHEMA ||
    typeof read.server !== "string" ||
    !(read.exclude === null || (Array.isArray(read.exclude) && read.exclude.every(isString)))
  ) {
    return undefined;
  }
  return read as OrgRules;
}

const isString = (v: unknown): v is string => typeof v === "string";

export interface OrgRulesSource {
  readonly target: string;
  captureRules?(etag?: string): Promise<CaptureRulesAnswer>;
}

export interface OrgRulesOptions {
  paths: CapturePaths;
  now: () => Date;
  log: (line: string) => void;
  /** How long a fetched copy is used before it is asked about again. Default 5 minutes. */
  refreshMs?: number;
  /** The first wait after a failed fetch; it doubles per failure up to `retryMaxMs`. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Errors that are not a failed fetch but a hold of their own (sign in), thrown on. */
  rethrow?: (err: unknown) => boolean;
}

/** Keeps the copy of the server's capture rules fresh for one uploader. */
export class OrgRulesKeeper {
  private nextFetch = 0;
  private failures = 0;
  private waiting: string | undefined;
  private readonly refreshMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(private readonly options: OrgRulesOptions) {
    this.refreshMs = options.refreshMs ?? 5 * 60_000;
    this.retryBaseMs = options.retryBaseMs ?? 5_000;
    this.retryMaxMs = options.retryMaxMs ?? 5 * 60_000;
  }

  /** Whether uploads to `sink` may go, the copy fetched or confirmed when due: `held` says why
   * they wait (no copy from this server yet, and none could be had), `changed` that the list in
   * force changed, so decisions made with the old one are stale. Throws what `rethrow` names. */
  async ready(sink: OrgRulesSource): Promise<{ held?: string; changed: boolean }> {
    if (!sink.captureRules) return { changed: false };
    const { paths, log } = this.options;
    const cached = readOrgRules(paths);
    const ours = cached?.server === sink.target ? cached : undefined;
    const now = this.options.now();
    if (now.getTime() < this.nextFetch) {
      return ours ? { changed: false } : { held: this.waiting ?? "", changed: false };
    }
    let answer: CaptureRulesAnswer;
    try {
      answer = await sink.captureRules(ours?.etag);
    } catch (err) {
      if (this.options.rethrow?.(err)) throw err;
      this.failures++;
      const wait = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (this.failures - 1));
      this.nextFetch = now.getTime() + wait;
      const why = err instanceof Error ? err.message : String(err);
      if (ours) {
        if (this.failures === 1) {
          log(`could not fetch the server's capture rules, using the copy fetched before: ${why}`);
        }
        return { changed: false };
      }
      this.waiting = `uploads to ${sink.target} wait for its capture rules: ${why}`;
      if (this.failures === 1) log(this.waiting);
      return { held: this.waiting, changed: false };
    }
    this.failures = 0;
    this.waiting = undefined;
    this.nextFetch = now.getTime() + this.refreshMs;
    if (answer === "unchanged" && ours) return { changed: false };
    const next: OrgRules = {
      schema: SCHEMA,
      server: sink.target,
      ...(typeof answer === "object" && answer.etag ? { etag: answer.etag } : {}),
      exclude: typeof answer === "object" ? answer.exclude : null,
      fetched_at: now.toISOString(),
    };
    tryWritePrivateFile(paths.orgRules, JSON.stringify(next));
    const changed = !ours || JSON.stringify(ours.exclude) !== JSON.stringify(next.exclude);
    if (changed) {
      log(
        next.exclude === null
          ? `${sink.target} serves no capture rules; only this machine's capture.exclude applies`
          : `the server's exclude list has ${next.exclude.length} entr${next.exclude.length === 1 ? "y" : "ies"}`,
      );
    }
    return { changed };
  }
}
