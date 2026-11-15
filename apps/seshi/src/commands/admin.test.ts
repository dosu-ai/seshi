import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@seshi/api";
import { FsStore } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFormats } from "../integrations";
import { main } from "../main";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-admin-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function seshi(argv: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    env: { SESHI_STORE__URL: `file://${join(dir, "bucket")}`, ...env },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const tokensIn = (text: string) =>
  [...text.matchAll(/seshi_[0-9a-f]{20}_[A-Za-z0-9_-]{43}/g)].map((m) => m[0]);

describe("seshi admin init (X5.12)", () => {
  it("prints the first admin token and the org key once, and stores only their hashes", async () => {
    const first = await seshi(["admin", "init", "--owner", "ops@acme.com"]);
    expect(first.code).toBe(0);
    expect(first.out).toContain("admin token for ops@acme.com");
    expect(first.out).toContain("org key");
    const [admin, orgKey] = tokensIn(first.out);
    expect(admin).toBeDefined();
    expect(orgKey).toBeDefined();
    const stored = readdirSync(join(dir, "bucket", "tokens")).map((f) =>
      readFileSync(join(dir, "bucket", "tokens", f), "utf8"),
    );
    expect(stored).toHaveLength(2);
    for (const record of stored) {
      expect(record).not.toContain(admin);
      expect(record).not.toContain(orgKey);
    }
    // The server takes both.
    const store = new FsStore(`file://${join(dir, "bucket")}`);
    const app = createApp({ store, storage: { url: store.url }, formats: buildFormats() });
    const me = (token: string, user?: string) =>
      app.fetch(
        new Request("http://seshi.test/v1/me", {
          headers: { authorization: `Bearer ${token}`, ...(user ? { "x-seshi-user": user } : {}) },
        }),
      );
    expect(await (await me(admin as string)).json()).toMatchObject({
      owner: "ops@acme.com",
      role: "admin",
    });
    expect(await (await me(orgKey as string, "bob")).json()).toMatchObject({ owner: "bob" });
  });

  it("refuses to run twice, makes another admin with --force, and rotates the org key", async () => {
    expect((await seshi(["admin", "init"])).code).toBe(0);
    const again = await seshi(["admin", "init"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("already set up");
    const forced = await seshi(["admin", "init", "--force"]);
    expect(forced.code).toBe(0);
    expect(tokensIn(forced.out)).toHaveLength(1);
    const rotated = await seshi(["admin", "init", "--rotate-org-key"]);
    expect(rotated.code).toBe(0);
    expect(rotated.out).toContain("revoked the old org key");
    expect(rotated.out).toContain("org key");
  });

  it("makes no org key when it is turned off", async () => {
    const result = await seshi(["admin", "init"], { SESHI_AUTH__ORG_KEY__ENABLED: "false" });
    expect(result.code).toBe(0);
    expect(tokensIn(result.out)).toHaveLength(1);
    expect(result.out).not.toContain("org key");
  });

  it("explains its usage and stops on a bad config", async () => {
    expect((await seshi(["admin"])).code).toBe(2);
    expect((await seshi(["admin", "nope"])).err).toContain("unknown admin command");
    expect((await seshi(["admin", "init", "--bogus"])).code).toBe(2);
    expect((await seshi(["admin", "init", "--owner", "svc:x"])).err).toContain("--owner");
    const bad = await seshi(["admin", "init"], { SESHI_STORE__URLL: "x" });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("SESHI_STORE__URLL: not a setting");
  });

  it("refuses another deployment's bucket (X1.4)", async () => {
    expect((await seshi(["admin", "init"], { SESHI_STORE__DEPLOYMENT_ID: "prod" })).code).toBe(0);
    const other = await seshi(["admin", "init", "--force"], {
      SESHI_STORE__DEPLOYMENT_ID: "staging",
    });
    expect(other.code).toBe(1);
    expect(other.err).toContain("cannot use");
  });
});
