import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@seshi/model";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readServeEnv, ServeConfigError } from "./serve";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sessiondb-main-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Boot the server with `env` and give it a moment: what it printed, and its exit code if it
 * stopped. */
async function boot(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  const proc = Bun.spawn(["bun", join(import.meta.dirname, "..", "main.ts"), "serve"], {
    env: {
      PATH: process.env.PATH ?? "",
      SESSIONDB_TOKEN: "sdb_test-token-0123456789abcdef",
      SESSIONDB_STORE_URL: `file://${join(dir, "bucket")}`,
      PORT: "0",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exited = await Promise.race([proc.exited, Bun.sleep(3000).then(() => null)]);
  if (exited === null) proc.kill();
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { code: exited, out };
}

describe("SESSIONDB_REDACTION_FILE", () => {
  it("refuses to start on a pattern that cannot be used", async () => {
    const file = join(dir, "redaction.json");
    writeFileSync(file, JSON.stringify({ patterns: ["("] }));
    const { code, out } = await boot({ SESSIONDB_REDACTION_FILE: file });
    expect(code).toBe(1);
    expect(out).toContain("patterns '('");
  });

  it("starts with a usable file and says what it added", async () => {
    const file = join(dir, "redaction.json");
    writeFileSync(file, JSON.stringify({ patterns: ["ACME-\\d+"], sensitive_files: ["*.secret"] }));
    const { code, out } = await boot({ SESSIONDB_REDACTION_FILE: file });
    expect(code).toBeNull();
    expect(out).toContain("1 pattern(s) on top of the built-in rules");
  });
});

describe("seshi serve", () => {
  it("serves /healthz with the release's version", async () => {
    const proc = Bun.spawn(["bun", join(import.meta.dirname, "..", "main.ts"), "serve"], {
      env: {
        PATH: process.env.PATH ?? "",
        SESSIONDB_TOKEN: "sdb_test-token-0123456789abcdef",
        SESSIONDB_STORE_URL: `file://${join(dir, "bucket")}`,
        PORT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = proc.stdout.getReader();
      let out = "";
      while (!/localhost:(\d+)/.test(out)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`server stopped: ${out}`);
        out += new TextDecoder().decode(value);
      }
      const port = (/localhost:(\d+)/.exec(out) as RegExpExecArray)[1];
      const response = await fetch(`http://localhost:${port}/healthz`);
      expect(await response.json()).toEqual({ ok: true, version: VERSION });
      expect(out).toContain(`sessiondb-server ${VERSION} listening on`);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  it("exits 1 with the setting that is wrong", async () => {
    const { code, out } = await boot({ SESSIONDB_FORMAT: "xml" });
    expect(code).toBe(1);
    expect(out).toContain("sessiondb: SESSIONDB_FORMAT must be one of letta, otlp, got 'xml'");
  });
});

describe("readServeEnv", () => {
  const base = { SESSIONDB_STORE_URL: "file:///tmp/x" };
  const error = (env: Record<string, string>) => {
    try {
      readServeEnv(env);
    } catch (err) {
      expect(err).toBeInstanceOf(ServeConfigError);
      return (err as Error).message;
    }
    throw new Error("expected a ServeConfigError");
  };

  it("reads tokens, the secret, the store, the format and the port", () => {
    expect(
      readServeEnv({
        ...base,
        SESSIONDB_TOKEN: " single-token-0123456789 ",
        SESSIONDB_TOKENS: "alice:alice-token-0123456789, bob:bob-token-0123456789",
        SESSIONDB_TOKEN_SECRET: "s".repeat(32),
        SESSIONDB_FORMAT: " OTLP ",
        SESSIONDB_REDACTION_FILE: " /etc/rules.json ",
        PORT: "8080",
      }),
    ).toEqual({
      tokens: [
        { token: "single-token-0123456789", owner: "default" },
        { token: "alice-token-0123456789", owner: "alice" },
        { token: "bob-token-0123456789", owner: "bob" },
      ],
      tokenSecret: "s".repeat(32),
      owners: ["default", "alice", "bob"],
      url: "file:///tmp/x",
      format: "otlp",
      redactionFile: "/etc/rules.json",
      port: 8080,
    });
  });

  it("defaults to letta traces on port 7200 with no redaction file", () => {
    const settings = readServeEnv({ ...base, SESSIONDB_TOKEN: "single-token-0123456789" });
    expect(settings).toMatchObject({ format: "letta", port: 7200, redactionFile: undefined });
  });

  it("refuses what the server always refused", () => {
    expect(error(base)).toContain("SESSIONDB_TOKENS (name:token,…), SESSIONDB_TOKEN or");
    expect(error({ ...base, SESSIONDB_TOKENS: "nocolon" })).toContain("entries are name:token");
    expect(error({ ...base, SESSIONDB_TOKENS: "a/b:token-0123456789abcdef" })).toContain(
      "'a/b' is not a valid name",
    );
    expect(error({ ...base, SESSIONDB_TOKEN: "short" })).toContain("16+ characters");
    expect(error({ ...base, SESSIONDB_TOKEN_SECRET: "short" })).toContain("32+ characters");
    expect(
      error({ ...base, SESSIONDB_TOKENS: "a:same-token-0123456789,b:same-token-0123456789" }),
    ).toBe("the same token is listed twice");
    expect(error({ SESSIONDB_TOKEN: "single-token-0123456789" })).toContain(
      "SESSIONDB_STORE_URL is required",
    );
  });
});
