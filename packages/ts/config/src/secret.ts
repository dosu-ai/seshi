import * as z from "zod";

export type SecretRef =
  | { kind: "literal"; value: string }
  | { kind: "env"; name: string }
  | { kind: "file"; path: string };

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

  static of(value: string): Secret {
    return new Secret({ kind: "literal", value });
  }

  get resolved(): boolean {
    return this.#value !== undefined;
  }

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

export function describeSecret(secret: Secret): string {
  const { ref } = secret;
  if (ref.kind === "env") return `from env ${ref.name}`;
  if (ref.kind === "file") return `from file ${ref.path}`;
  return "literal";
}

export const SECRET_KEY = "x-seshi-secret";

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
