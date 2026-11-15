/** Faults a scenario injects, without touching production code:
 *
 * - On the uploader-to-server path, a `fetch` wrapper handed to `httpSink` (its `fetch` option):
 *   a status code, a dropped response (the server commits, the client sees a connection error),
 *   a reset (nothing reaches the server) or latency (the scenario clock moves while the request
 *   is out). Other HTTP clients (the CLI, the uploader's rules fetch) are not faulted.
 * - In the bucket, a `Store` wrapper that fails the nth put or delete whose key matches, with a
 *   store error or `PreconditionFailed`, before the write or after it landed.
 *
 * Each fault counts the requests (or writes) that match it from the moment it is armed, fires
 * on the `nth` and keeps firing for `times` matches in a row (or for good with `always`, until a
 * `heal`). The store wrapper also keeps every object's last write in scenario time, so ages the
 * sweep and `checkStore` read follow the scenario clock rather than the file system's. */

import {
  type DeleteOptions,
  type ListOptions,
  type ListResult,
  type ObjectStat,
  PreconditionFailed,
  type PutOptions,
  type PutResult,
  type Store,
  type StoredObject,
  StoreError,
} from "@seshi/store";
import type { ScenarioClock } from "./clock";

/** `*` matches any run of characters, `/` included. */
export function globRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

interface Counting {
  /** Words for reports: what it matches and does. */
  label: string;
  nth: number;
  times: number | "always";
  seen: number;
  fired: number;
}

function fires(fault: Counting): boolean {
  fault.seen++;
  if (fault.seen < fault.nth) return false;
  if (fault.times !== "always" && fault.fired >= fault.times) return false;
  fault.fired++;
  return true;
}

function spent(fault: Counting): boolean {
  return fault.times !== "always" && fault.fired >= fault.times;
}

export type HttpAction =
  | { kind: "status"; status: number; code?: string; expected?: number }
  | { kind: "drop-response" }
  | { kind: "reset" }
  | { kind: "latency"; ms: number };

export interface HttpFault extends Counting {
  method?: string;
  path: RegExp;
  action: HttpAction;
}

export type StoreAction = "fail" | "precondition";

export interface StoreFault extends Counting {
  op: "put" | "delete";
  key: RegExp;
  error: StoreAction;
  /** The write lands, then the caller sees the error (a lost answer). */
  after: boolean;
}

/** Everything armed, and what fired. */
export class FaultPlan {
  readonly http: HttpFault[] = [];
  readonly store: StoreFault[] = [];
  /** One line per fault that fired, in order. */
  readonly log: string[] = [];

  /** Faults armed that have not fired as often as they were told to. `always` faults count as
   * pending until healed. */
  pending(): string[] {
    return [...this.http, ...this.store]
      .filter((f) => f.times === "always" || f.fired < (f.times as number))
      .map((f) => f.label);
  }

  /** Remove every fault: the outage is over. */
  heal(): void {
    this.http.length = 0;
    this.store.length = 0;
  }

  matchHttp(method: string, path: string): HttpFault | undefined {
    for (const fault of this.http) {
      if (fault.method && fault.method !== method) continue;
      if (!fault.path.test(path)) continue;
      if (!fires(fault)) continue;
      this.log.push(`http ${method} ${path}: ${fault.label}`);
      this.prune();
      return fault;
    }
    return undefined;
  }

  matchStore(op: "put" | "delete", key: string): StoreFault | undefined {
    for (const fault of this.store) {
      if (fault.op !== op || !fault.key.test(key)) continue;
      if (!fires(fault)) continue;
      this.log.push(`store ${op} ${key}: ${fault.label}`);
      this.prune();
      return fault;
    }
    return undefined;
  }

  private prune(): void {
    for (const list of [this.http, this.store] as Counting[][]) {
      for (let i = list.length - 1; i >= 0; i--) if (spent(list[i] as Counting)) list.splice(i, 1);
    }
  }
}

function methodAndUrl(input: RequestInfo | URL, init?: RequestInit): [string, URL] {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const url =
    typeof input === "string"
      ? new URL(input)
      : input instanceof URL
        ? input
        : new URL((input as Request).url);
  return [method, url];
}

/** A `fetch` that answers, drops or delays what `plan` says, and passes the rest to `inner`. */
export function faultFetch(
  plan: FaultPlan,
  clock: ScenarioClock,
  inner: typeof fetch = fetch,
): typeof fetch {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const [method, url] = methodAndUrl(input, init);
    const fault = plan.matchHttp(method, url.pathname);
    if (!fault) return inner(input, init);
    const action = fault.action;
    switch (action.kind) {
      case "status": {
        const code =
          action.code ??
          (action.status === 503 ? "unavailable" : action.status >= 500 ? "internal" : "injected");
        const error = {
          code,
          message: `injected ${action.status} ${code}`,
          ...(action.expected !== undefined ? { expected: action.expected } : {}),
        };
        return Response.json({ error }, { status: action.status });
      }
      case "reset":
        throw new TypeError("fetch failed: connection reset (injected)");
      case "drop-response": {
        const response = await inner(input, init);
        await response.arrayBuffer();
        throw new TypeError("fetch failed: the connection closed before the response (injected)");
      }
      case "latency":
        clock.advance(action.ms);
        return inner(input, init);
    }
  };
  return wrapped as typeof fetch;
}

/** A store that fails what `plan` says and keeps each object's last write in scenario time. */
export class ScenarioStore implements Store {
  private readonly written = new Map<string, string>();

  constructor(
    readonly inner: Store,
    private readonly plan: FaultPlan,
    private readonly clock: ScenarioClock,
  ) {}

  get url(): string {
    return this.inner.url;
  }

  get(key: string): Promise<StoredObject | null> {
    return this.inner.get(key);
  }

  private failure(fault: StoreFault, key: string): Error {
    return fault.error === "precondition"
      ? new PreconditionFailed(key, `injected (${fault.label})`)
      : new StoreError(`injected store failure for ${key} (${fault.label})`);
  }

  async put(key: string, body: Uint8Array, options?: PutOptions): Promise<PutResult> {
    const fault = this.plan.matchStore("put", key);
    if (fault && !fault.after) throw this.failure(fault, key);
    const result = await this.inner.put(key, body, options);
    this.written.set(key, this.clock.now().toISOString());
    if (fault) throw this.failure(fault, key);
    return result;
  }

  async delete(key: string, options?: DeleteOptions): Promise<void> {
    const fault = this.plan.matchStore("delete", key);
    if (fault && !fault.after) throw this.failure(fault, key);
    await this.inner.delete(key, options);
    this.written.delete(key);
    if (fault) throw this.failure(fault, key);
  }

  async stat(key: string): Promise<ObjectStat | null> {
    const stat = await this.inner.stat(key);
    if (!stat) return stat;
    const modified = this.written.get(key);
    return modified ? { ...stat, modified } : stat;
  }

  async list(prefix: string, options?: ListOptions): Promise<ListResult> {
    const result = await this.inner.list(prefix, options);
    if (!result.objects) return result;
    return {
      ...result,
      objects: result.objects.map((o) => {
        const modified = this.written.get(o.key);
        return modified ? { ...o, modified } : o;
      }),
    };
  }
}
