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

  set(path: readonly PathSegment[], origin: Origin): void {
    for (const [key, entry] of this.#entries) {
      if (startsWith(entry.path, path)) this.#entries.delete(key);
    }
    this.#entries.set(keyOf(path), { path: [...path], origin });
  }

  get(path: readonly PathSegment[]): Origin {
    for (let end = path.length; end > 0; end--) {
      const entry = this.#entries.get(keyOf(path.slice(0, end)));
      if (entry) return entry.origin;
    }
    return DEFAULT;
  }

  entries(): Array<{ path: PathSegment[]; origin: Origin }> {
    return [...this.#entries.values()].map((e) => ({ path: [...e.path], origin: e.origin }));
  }
}

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
