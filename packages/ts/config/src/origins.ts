/** Where every value came from (F1.4): a flag, an env variable, the config file, or the
 * schema's default. Kept by path; a value inside a list of tables is addressed by index. */

export type Origin =
  | { source: "default" }
  | { source: "file"; path: string }
  | { source: "env"; name: string }
  | { source: "flag"; name: string };

export type PathSegment = string | number;

const DEFAULT: Origin = { source: "default" };

function keyOf(path: readonly PathSegment[]): string {
  return JSON.stringify(path);
}

function startsWith(path: readonly PathSegment[], prefix: readonly PathSegment[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, i) => path[i] === segment);
}

export class Origins {
  readonly #entries = new Map<string, { path: PathSegment[]; origin: Origin }>();

  /** Records `origin` for the value at `path`, replacing what was recorded at or under it. */
  set(path: readonly PathSegment[], origin: Origin): void {
    for (const [key, entry] of this.#entries) {
      if (startsWith(entry.path, path)) this.#entries.delete(key);
    }
    this.#entries.set(keyOf(path), { path: [...path], origin });
  }

  /** Where the value at `path` came from: recorded there or on a table above it (a whole list
   * set at once), else the default. */
  get(path: readonly PathSegment[]): Origin {
    for (let end = path.length; end > 0; end--) {
      const entry = this.#entries.get(keyOf(path.slice(0, end)));
      if (entry) return entry.origin;
    }
    return DEFAULT;
  }

  /** Every recorded path and origin. */
  entries(): Array<{ path: PathSegment[]; origin: Origin }> {
    return [...this.#entries.values()].map((e) => ({ path: [...e.path], origin: e.origin }));
  }
}

/** `env SESHI_STORE__URL`, `file /etc/seshi/seshi.toml`, `flag --listen`, `default`. */
export function describeOrigin(origin: Origin): string {
  switch (origin.source) {
    case "env":
      return `env ${origin.name}`;
    case "file":
      return `file ${origin.path}`;
    case "flag":
      return `flag ${origin.name}`;
    default:
      return "default";
  }
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/** A path as people read it: `store.url`, `auth.tokens."alice@acme.com"`,
 * `sources[datadog-prod].api_key`. `ids` names the elements of lists of tables (their `id`);
 * without one an element is shown by index. */
export function formatPath(
  path: readonly PathSegment[],
  idAt?: (prefix: readonly PathSegment[]) => string | undefined,
): string {
  let out = "";
  path.forEach((segment, i) => {
    if (typeof segment === "number") {
      const id = idAt?.(path.slice(0, i + 1));
      out += `[${id ?? segment}]`;
      return;
    }
    const key = BARE_KEY.test(segment) ? segment : JSON.stringify(segment);
    out += out === "" ? key : `.${key}`;
  });
  return out;
}
