/** Secrets are references, not values (F1.3). A secret field accepts a literal string,
 * `{ env = "NAME" }` (read from that environment variable) or `{ file = "/path" }` (read from
 * that file, trailing newline removed), so a TOML file can be committed. The loader resolves
 * every reference at start-up, so a missing variable or file stops the process there and not
 * on first use.
 *
 * The parsed value is a `Secret`: it never prints its value (`String`, JSON and `inspect` all
 * give `[secret]`), and code reads it with `reveal()`. */

import * as z from "zod";

export type SecretRef =
  | { kind: "literal"; value: string }
  | { kind: "env"; name: string }
  | { kind: "file"; path: string };

/** What resolving a reference reads: the environment and files, injectable for tests. */
export interface SecretSources {
  env: Record<string, string | undefined>;
  readFile(path: string): string;
}

const MASK = "[secret]";

export class Secret {
  #value: string | undefined;

  constructor(readonly ref: SecretRef) {
    if (ref.kind === "literal") this.#value = ref.value;
  }

  /** A secret with a known value (tests, and values set from env or flags). */
  static of(value: string): Secret {
    return new Secret({ kind: "literal", value });
  }

  get resolved(): boolean {
    return this.#value !== undefined;
  }

  /** Reads the reference. Throws an `Error` saying what is missing. */
  resolve(sources: SecretSources): void {
    const { ref } = this;
    if (ref.kind === "literal") return;
    if (ref.kind === "env") {
      const value = sources.env[ref.name];
      if (value === undefined || value === "") {
        throw new Error(`environment variable ${ref.name} is not set`);
      }
      this.#value = value;
      return;
    }
    let text: string;
    try {
      text = sources.readFile(ref.path);
    } catch (err) {
      throw new Error(`cannot read ${ref.path}: ${err instanceof Error ? err.message : err}`);
    }
    const value = text.replace(/\r?\n$/, "");
    if (value === "") throw new Error(`${ref.path} is empty`);
    this.#value = value;
  }

  /** The value. Throws when the reference was never resolved. */
  reveal(): string {
    if (this.#value === undefined) {
      throw new Error(`secret ${describeSecret(this)} was not resolved`);
    }
    return this.#value;
  }

  toString(): string {
    return MASK;
  }

  toJSON(): string {
    return MASK;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return MASK;
  }
}

/** Where a secret comes from, for messages and `config show`: never its value. */
export function describeSecret(secret: Secret): string {
  const { ref } = secret;
  if (ref.kind === "env") return `from env ${ref.name}`;
  if (ref.kind === "file") return `from file ${ref.path}`;
  return "literal";
}

/** Marks a secret field in the JSON Schema, so tools can mask it. */
export const SECRET_KEY = "x-seshi-secret";

/** A secret field: a literal, `{ env = "NAME" }` or `{ file = "/path" }`. */
export function secret() {
  return z
    .union([
      z.string().min(1),
      z.strictObject({ env: z.string().min(1).describe("the environment variable to read") }),
      z.strictObject({ file: z.string().min(1).describe("the file to read") }),
    ])
    .transform(
      (value) =>
        new Secret(
          typeof value === "string"
            ? { kind: "literal", value }
            : "env" in value
              ? { kind: "env", name: value.env }
              : { kind: "file", path: value.file },
        ),
    )
    .meta({
      [SECRET_KEY]: true,
      description: 'a secret: a literal, { env = "NAME" } or { file = "/path" }',
    });
}
