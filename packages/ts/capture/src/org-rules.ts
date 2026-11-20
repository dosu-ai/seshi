/** The server's capture rules on this machine: the org's exclude list (`[capture] exclude` in the
 * server's config, `GET /v1/capture/rules`) and its tool-call redaction list
 * (`[capture] redact_tool_calls`), fetched by the uploader and kept in
 * `capture-rules.json` with its ETag. Hooks, the status line and `seshi capture status` read the
 * copy (`withServerLists`); only the uploader fetches.
 *
 * - Before this machine holds a copy from the server it uploads to, that server's uploads wait:
 *   nothing goes up that its list may exclude.
 * - A later fetch that fails keeps the copy in use.
 * - A server without the route (404, older than the list) has no list: uploads go as before. */

import { tryReadJson, tryWritePrivateFile } from "./files";
import type { CapturePaths } from "./paths";
import type { ExcludeRule } from "./rules";

const SCHEMA = "seshi/server-capture-rules/1";

export interface OrgRules {
  schema: typeof SCHEMA;
  /** The server it came from (the sink's target). */
  server: string;
  etag?: string;
  /** The server's exclude list; null when the server serves none (older than the route). */
  exclude: string[] | null;
  /** The server's tool-call redaction list; absent when it serves none (older than the list). */
  redact_tool_calls?: string[];
  fetched_at: string;
  /** The lists read for this machine when they were fetched (`~` expanded under `home`,
   * folders' symbolic links resolved), so a hook does not read them again on every call. */
  compiled?: CompiledOrgRules;
}

export interface CompiledOrgRules {
  home: string;
  /** `exclude`, read. */
  rules: ExcludeRule[];
  /** `redact_tool_calls`, read. */
  redact?: ExcludeRule[];
}

/** What a sink's server answered for its capture rules. */
export type CaptureRulesAnswer =
  | { exclude: string[]; redact_tool_calls?: string[]; etag?: string }
  /** The copy whose ETag was sent is still current (304). */
  | "unchanged"
  /** The server has no such route (404): it serves no list. */
  | "none";

export function readOrgRules(paths: CapturePaths): OrgRules | undefined {
  const read = tryReadJson(paths.orgRules) as Partial<OrgRules> | null | undefined;
  if (
    read?.schema !== SCHEMA ||
    typeof read.server !== "string" ||
    !(read.exclude === null || (Array.isArray(read.exclude) && read.exclude.every(isString))) ||
    !(
      read.redact_tool_calls === undefined ||
      (Array.isArray(read.redact_tool_calls) && read.redact_tool_calls.every(isString))
    )
  ) {
    return undefined;
  }
  const compiled = read.compiled;
  if (
    compiled !== undefined &&
    (typeof compiled?.home !== "string" ||
      !Array.isArray(compiled.rules) ||
      !compiled.rules.every((r) => typeof r?.entry === "string") ||
      !(
        compiled.redact === undefined ||
        (Array.isArray(compiled.redact) &&
          compiled.redact.every((r) => typeof r?.entry === "string"))
      ))
  ) {
    const { compiled: _dropped, ...rest } = read;
    return rest as OrgRules;
  }
  return read as OrgRules;
}

const isString = (v: unknown): v is string => typeof v === "string";

/** Whether two copies hold the same lists. */
function sameLists(a: OrgRules, b: OrgRules): boolean {
  return (
    JSON.stringify(a.exclude) === JSON.stringify(b.exclude) &&
    JSON.stringify(a.redact_tool_calls ?? []) === JSON.stringify(b.redact_tool_calls ?? [])
  );
}

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
  /** Reads the fetched lists for this machine, kept with the copy (`OrgRules.compiled`). */
  compile?: (exclude: string[], redactToolCalls: string[]) => CompiledOrgRules;
}

/** Keeps the copy of the server's capture rules fresh for one uploader. */
export class OrgRulesKeeper {
  private nextFetch = 0;
  private failures = 0;
  private waiting: string | undefined;
  /** The copy on disk is not the list the server last served (it could not be written over). */
  private stale = false;
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
    const ours = cached?.server === sink.target && !this.stale ? cached : undefined;
    const now = this.options.now();
    // Not due, with a copy in force or a reason to wait. A copy gone since (removed, unreadable)
    // is fetched again at once rather than hold uploads with no reason given.
    if (now.getTime() < this.nextFetch && (ours || this.waiting !== undefined)) {
      return ours ? { changed: false } : { held: this.waiting as string, changed: false };
    }
    const failed = (why: string): { held?: string; changed: boolean } => {
      this.failures++;
      const wait = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (this.failures - 1));
      this.nextFetch = now.getTime() + wait;
      if (ours) {
        if (this.failures === 1) {
          log(`could not fetch the server's capture rules, using the copy fetched before: ${why}`);
        }
        return { changed: false };
      }
      this.waiting = `uploads to ${sink.target} wait for its capture rules: ${why}`;
      if (this.failures === 1) log(this.waiting);
      return { held: this.waiting, changed: false };
    };
    let answer: CaptureRulesAnswer;
    try {
      answer = await sink.captureRules(ours?.etag);
    } catch (err) {
      if (this.options.rethrow?.(err)) throw err;
      return failed(err instanceof Error ? err.message : String(err));
    }
    if (answer === "unchanged") {
      if (ours) {
        this.succeeded(now);
        return { changed: false };
      }
      // A 304 to a request that named no copy (a cache between here and the server): nothing to
      // go on, so it is no answer, never "no list".
      return failed("the server answered 304 with no copy held here");
    }
    const exclude = answer === "none" ? null : answer.exclude;
    const redact = answer === "none" ? undefined : answer.redact_tool_calls;
    const next: OrgRules = {
      schema: SCHEMA,
      server: sink.target,
      ...(answer !== "none" && answer.etag ? { etag: answer.etag } : {}),
      exclude,
      ...(redact !== undefined ? { redact_tool_calls: redact } : {}),
      fetched_at: now.toISOString(),
      ...(exclude && this.options.compile
        ? { compiled: this.options.compile(exclude, redact ?? []) }
        : {}),
    };
    // Decisions read the copy on disk, so one that cannot be written is no copy: unless it already
    // holds this list, the uploads wait (a list kept in memory alone would not reach the hooks).
    if (!tryWritePrivateFile(paths.orgRules, JSON.stringify(next))) {
      const why = `cannot write ${paths.orgRules}`;
      if (ours && sameLists(ours, next)) return failed(why);
      this.stale = true;
      this.failures++;
      const wait = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (this.failures - 1));
      this.nextFetch = now.getTime() + wait;
      this.waiting = `uploads to ${sink.target} wait for its capture rules: ${why}`;
      if (this.failures === 1) log(this.waiting);
      return { held: this.waiting, changed: false };
    }
    this.stale = false;
    this.succeeded(now);
    const changed = !ours || !sameLists(ours, next);
    if (changed) {
      const entries = (n: number) => `${n} entr${n === 1 ? "y" : "ies"}`;
      log(
        exclude === null
          ? `${sink.target} serves no capture rules; only this machine's capture.exclude applies`
          : `the server's exclude list has ${entries(exclude.length)}, its tool-call redaction list ${entries(redact?.length ?? 0)}`,
      );
    }
    return { changed };
  }

  private succeeded(now: Date): void {
    this.failures = 0;
    this.waiting = undefined;
    this.nextFetch = now.getTime() + this.refreshMs;
  }
}
