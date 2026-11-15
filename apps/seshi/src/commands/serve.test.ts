import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type ServerConfig, serverConfigSchema } from "@seshi/config";
import { VERSION } from "@seshi/model";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configFlags, ServeConfigError, serveSettings } from "./serve-settings";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-serve-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const MAIN = join(import.meta.dirname, "..", "main.ts");

function spawn(env: Record<string, string>, args: string[] = []) {
  return Bun.spawn(["bun", MAIN, "serve", ...args], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      SESHI_AUTH__TOKENS__DEFAULT: "sdb_test-token-0123456789abcdef",
      SESHI_STORE__URL: `file://${join(dir, "bucket")}`,
      SESHI_SERVER__LISTEN: "127.0.0.1:0",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Boot the server and give it a moment: what it printed, and its exit code if it stopped. */
async function boot(
  env: Record<string, string>,
  args: string[] = [],
): Promise<{ code: number | null; out: string }> {
  const proc = spawn(env, args);
  const exited = await Promise.race([proc.exited, Bun.sleep(3000).then(() => null)]);
  if (exited === null) proc.kill();
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { code: exited, out };
}

/** Start the server and wait until it says where it listens. */
async function listening(
  env: Record<string, string>,
  args: string[] = [],
): Promise<{ port: string; out: string; stop(): Promise<void> }> {
  const proc = spawn(env, args);
  const reader = proc.stdout.getReader();
  let out = "";
  while (!/localhost:(\d+)|127\.0\.0\.1:(\d+)/.test(out)) {
    const { value, done } = await reader.read();
    if (done) {
      proc.kill();
      throw new Error(`server stopped: ${out}${await new Response(proc.stderr).text()}`);
    }
    out += new TextDecoder().decode(value);
  }
  const match = /(?:localhost|127\.0\.0\.1):(\d+)/.exec(out) as RegExpExecArray;
  return {
    port: match[1] as string,
    out,
    async stop() {
      proc.kill();
      await proc.exited;
    },
  };
}

describe("redaction packs", () => {
  it("refuses to start on a pattern that cannot be used, naming the file", async () => {
    const file = join(dir, "redaction.json");
    writeFileSync(file, JSON.stringify({ patterns: ["("] }));
    const { code, out } = await boot({ SESHI_REDACTION__PACKS: file });
    expect(code).toBe(1);
    expect(out).toContain(`seshi: ${file}:`);
    expect(out).toContain("patterns '('");
  });

  it("starts with usable packs and says what they added", async () => {
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    writeFileSync(a, JSON.stringify({ patterns: ["ACME-\\d+"], sensitive_files: ["*.secret"] }));
    writeFileSync(b, JSON.stringify({ patterns: ["INTERNAL-\\d+"] }));
    const server = await listening({ SESHI_REDACTION__PACKS: `${a},${b}` });
    try {
      expect(server.out).toContain("2 pattern(s) on top of the built-in rules");
    } finally {
      await server.stop();
    }
  });

  it("refuses a pack it cannot read", async () => {
    const { code, out } = await boot({ SESHI_REDACTION__PACKS: join(dir, "missing.json") });
    expect(code).toBe(1);
    expect(out).toContain("cannot read redaction pack");
  });
});

describe("seshi serve", () => {
  it("serves /healthz with the release's version", async () => {
    const server = await listening({});
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(await response.json()).toEqual({ ok: true, version: VERSION });
      expect(server.out).toContain(`seshi ${VERSION} listening on http://127.0.0.1:`);
    } finally {
      await server.stop();
    }
  });

  it("reads seshi.toml from the working directory, with env over it and flags over env", async () => {
    writeFileSync(
      join(dir, "seshi.toml"),
      `[server]\nlisten = "127.0.0.1:1"\n[store]\nurl = "file://${join(dir, "from-file")}"\n[auth.tokens]\nalice = { env = "ALICE_TOKEN" }\n`,
    );
    const server = await listening(
      {
        ALICE_TOKEN: "alice-token-0123456789",
        SESHI_SERVER__LISTEN: "127.0.0.1:2",
        SESHI_STORE__URL: "",
      },
      ["--listen", "127.0.0.1:0"],
    );
    try {
      expect(server.out).toContain(`sessions in file://${join(dir, "from-file")}`);
      expect(server.out).toContain("for alice, default");
      expect(server.out).toContain(`(config ${join(realpathSync(dir), "seshi.toml")})`);
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/me`, {
        headers: { authorization: "Bearer alice-token-0123456789" },
      });
      expect((await response.json()).owner).toBe("alice");
    } finally {
      await server.stop();
    }
  });

  it("reads the file named by --config", async () => {
    const file = join(dir, "elsewhere.toml");
    writeFileSync(file, `[store]\nurl = "file://${join(dir, "named")}"\n`);
    const server = await listening({ SESHI_STORE__URL: "" }, ["--config", file]);
    try {
      expect(server.out).toContain(`sessions in file://${join(dir, "named")}`);
    } finally {
      await server.stop();
    }
  });

  it("warns about a literal secret in a file others can read", async () => {
    const file = join(dir, "seshi.toml");
    writeFileSync(file, `[auth.tokens]\nbob = "bob-token-0123456789"\n`);
    chmodSync(file, 0o644);
    const { out } = await boot({});
    expect(out).toContain("seshi: warning:");
    expect(out).toContain("auth.tokens.bob");
  });

  it("exits 1 with every config problem, and where each value came from", async () => {
    const { code, out } = await boot({ SESHI_FILTER__MIN_CHARS: "lots", SESHI_STORE__URLL: "x" });
    expect(code).toBe(1);
    expect(out).toContain("seshi: SESHI_STORE__URLL: not a setting");
    const second = await boot({ SESHI_FILTER__MIN_CHARS: "lots" });
    expect(second.code).toBe(1);
    expect(second.out).toContain("seshi: filter.min_chars:");
    expect(second.out).toContain("(from env SESHI_FILTER__MIN_CHARS)");
    // The per-bucket trace format is gone (X6.2): naming it is an unknown setting.
    const third = await boot({ SESHI_STORE__FORMAT: "otlp" });
    expect(third.code).toBe(1);
    expect(third.out).toContain("seshi: SESHI_STORE__FORMAT: not a setting");
  });

  it("records the deployment and org in the bucket's marker, and refuses another's bucket", async () => {
    const first = await listening({
      SESHI_STORE__DEPLOYMENT_ID: "prod-eu",
      SESHI_STORE__ORG: "acme",
    });
    try {
      expect(first.out).toContain("(deployment prod-eu)");
    } finally {
      await first.stop();
    }
    const marker = JSON.parse(readFileSync(join(dir, "bucket", "seshi.json"), "utf8"));
    expect(marker).toMatchObject({
      schema: "seshi/layout/1",
      trace_schema: "seshi/trace/1",
      deployment_id: "prod-eu",
      org: "acme",
      created_by: `seshi/${VERSION}`,
    });
    const staging = await boot({ SESHI_STORE__DEPLOYMENT_ID: "staging" });
    expect(staging.code).toBe(1);
    expect(staging.out).toContain('belongs to deployment "prod-eu", not "staging"');
    const globex = await boot({ SESHI_STORE__ORG: "globex" });
    expect(globex.code).toBe(1);
    expect(globex.out).toContain('belongs to org "acme", not "globex"');
  });

  it("refuses a bucket a sessiondb server wrote", async () => {
    mkdirSync(join(dir, "bucket"), { recursive: true });
    writeFileSync(
      join(dir, "bucket", "sessionstorage.json"),
      JSON.stringify({ schema: "sessionstorage/layout/1", created_at: "x", created_by: "y" }),
    );
    const { code, out } = await boot({});
    expect(code).toBe(1);
    expect(out).toContain("seshi: cannot use file://");
    expect(out).toContain("holds a sessiondb store");
  });

  it("exits 1 on an unknown flag", async () => {
    const { code, out } = await boot({}, ["--port", "1"]);
    expect(code).toBe(1);
    expect(out).toContain("seshi: Unknown option '--port'");
  });

  it("does not read the old SESSIONDB_* names", async () => {
    const { code, out } = await boot({
      SESHI_AUTH__TOKENS__DEFAULT: "",
      SESSIONDB_TOKEN: "sdb_test-token-0123456789abcdef",
    });
    expect(code).toBe(1);
    expect(out).toContain("no way to call the server");
  });
});

describe("serveSettings", () => {
  const config = (tree: Record<string, unknown>, env: Record<string, string> = {}): ServerConfig =>
    loadConfig(serverConfigSchema, {
      env: { SESHI_STORE__URL: "file:///tmp/x", ...env },
      flags: Object.entries(tree).map(([path, value]) => ({
        name: "--set",
        path,
        value: String(value),
      })),
    }).config;
  const error = (c: ServerConfig) => {
    try {
      serveSettings(c);
    } catch (err) {
      expect(err).toBeInstanceOf(ServeConfigError);
      return (err as Error).message;
    }
    throw new Error("expected a ServeConfigError");
  };

  it("maps tokens, the legacy secret, the store, the listen address, the filter and limits", () => {
    const settings = serveSettings(
      config(
        {
          "server.listen": "[::1]:8080",
          "store.region": "eu-west-1",
          "store.deployment_id": "prod-eu",
          "store.org": "acme",
          "redaction.packs": "/etc/rules.json",
          "filter.min_chars": 10,
          "limits.max_upload_bytes": "1MiB",
        },
        {
          SESHI_AUTH__TOKENS__ALICE: " alice-token-0123456789 ",
          SESHI_AUTH__TOKENS__BOB: "bob-token-0123456789",
          SESHI_AUTH__LEGACY_TOKEN_SECRET: "s".repeat(32),
          SESHI_STORE__CREDENTIALS__ACCESS_KEY_ID: "AKIA",
          SESHI_STORE__CREDENTIALS__SECRET_ACCESS_KEY: "shh",
        },
      ),
    );
    expect(settings).toEqual({
      tokens: [
        { token: "alice-token-0123456789", owner: "alice" },
        { token: "bob-token-0123456789", owner: "bob" },
      ],
      tokenSecret: "s".repeat(32),
      owners: ["alice", "bob"],
      url: "file:///tmp/x",
      store: { region: "eu-west-1", credentials: { accessKeyId: "AKIA", secretAccessKey: "shh" } },
      deploymentId: "prod-eu",
      org: "acme",
      redactionPacks: ["/etc/rules.json"],
      hostname: "::1",
      port: 8080,
      filter: { enabled: true, min_chars: 10, require_user: true, require_reply: true },
      limits: {
        max_records: 50_000,
        max_records_bytes: 32 * 1024 * 1024,
        max_upload_bytes: 1024 * 1024,
      },
    });
  });

  it("defaults to every interface, port 7200, no packs and no deployment or org to check", () => {
    const settings = serveSettings(
      config({}, { SESHI_AUTH__TOKENS__DEFAULT: "single-token-0123456789" }),
    );
    expect(settings).toMatchObject({
      deploymentId: undefined,
      org: undefined,
      hostname: "0.0.0.0",
      port: 7200,
      redactionPacks: [],
      owners: ["default"],
    });
  });

  it("refuses what the server always refused", () => {
    expect(error(config({}))).toContain("no way to call the server");
    expect(error(config({}, { SESHI_AUTH__TOKENS__ALICE: "short" }))).toContain(
      "auth.tokens.alice must be 16+ characters",
    );
    expect(error(config({}, { SESHI_AUTH__LEGACY_TOKEN_SECRET: "short" }))).toContain(
      "auth.legacy_token_secret must be 32+ characters",
    );
    expect(
      error(
        config(
          {},
          {
            SESHI_AUTH__TOKENS__A: "same-token-0123456789",
            SESHI_AUTH__TOKENS__B: "same-token-0123456789",
          },
        ),
      ),
    ).toBe("auth.tokens: the same token is given to two owners");
    expect(error(config({ "auth.tokens.a/b": "token-0123456789abcdef" }))).toContain(
      "'a/b' is not a valid owner name",
    );
    expect(
      error(
        config({ "server.roles": "worker" }, { SESHI_AUTH__TOKENS__A: "token-0123456789abcd" }),
      ),
    ).toContain("needs api");
  });
});

describe("configFlags", () => {
  it("maps --listen, --roles and --set to config paths", () => {
    expect(configFlags({ listen: ":1", roles: "api", set: ["store.url=s3://b/p=q"] })).toEqual([
      { name: "--set store.url", path: "store.url", value: "s3://b/p=q" },
      { name: "--listen", path: "server.listen", value: ":1" },
      { name: "--roles", path: "server.roles", value: "api" },
    ]);
  });

  it("refuses --set without a path", () => {
    expect(() => configFlags({ set: ["=x"] })).toThrow("--set takes path=value");
    expect(() => configFlags({ set: ["novalue"] })).toThrow("--set takes path=value");
  });
});
