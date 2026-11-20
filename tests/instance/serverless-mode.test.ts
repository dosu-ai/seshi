/** Serverless mode (F11, which local mode became): the CLI builds an Instance in-process over
 * a bucket that was set up for it, and gets the same session API the HTTP client gives. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpSessionDB } from "@seshi/client";
import { cliConfigSchema } from "@seshi/config";
import { InstanceError } from "@seshi/instance";
import {
  IngestRejected,
  type SessionDB,
  SessionRejected,
  type StoreSessionResult,
  type Trace,
} from "@seshi/model";
import { StoreSessionDB } from "@seshi/pipeline";
import { ensureLayout, FsStore, getBytes, LAYOUT_KEY } from "@seshi/store";
import { type Connection, connect, expandHome, localOwner, NotConnected } from "seshi/connect";
import { INTEGRATIONS } from "seshi/integrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transcript } from "../tooling/testdata";

const SMALL = transcript("claude-basic.claude-code.jsonl");
/** The greeting-sized fixture with an answer long enough to be worth a trace. */
const CLAUDE = `${SMALL.trim()}\n${JSON.stringify({
  type: "assistant",
  uuid: "a3",
  timestamp: "2026-09-01T00:00:08.000Z",
  sessionId: "sess1",
  message: {
    role: "assistant",
    model: "claude-x",
    content: [{ type: "text", text: `The auth flow: ${"details ".repeat(400)}` }],
  },
})}\n`;

/** The result of an upload that wrote a trace; the test fails on any other. */
function stored(result: StoreSessionResult): Extract<StoreSessionResult, { content_hash: string }> {
  if (!("content_hash" in result)) throw new Error(`expected a trace, got ${result.status}`);
  return result;
}

let dir: string;
let connection: Connection;
let db: SessionDB;

/** The CLI config, as the loader parses it. */
const cli = (tree: unknown) => cliConfigSchema.parse(tree);

/** A server config naming a folder bucket, written where local mode reads it. */
function serverToml(extra = ""): string {
  const file = join(dir, "seshi.toml");
  writeFileSync(file, `[store]\nurl = "file://${join(dir, "bucket")}"\n${extra}`, { mode: 0o600 });
  return file;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "seshi-local-"));
  await ensureLayout(new FsStore(join(dir, "bucket")), { createdBy: "test", mode: "serverless" });
  connection = await connect({
    cli: cli({ local: { config: serverToml(), owner: "acme" } }),
    env: {},
    home: dir,
    integrations: INTEGRATIONS,
  });
  db = connection.db;
});

afterEach(async () => {
  await connection.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("connect", () => {
  it("builds an instance from the local config, scoped to the owner", async () => {
    expect(connection.mode).toBe("serverless");
    expect(db).toBeInstanceOf(StoreSessionDB);
    expect(connection.instance?.roles).toEqual([]);
    const me = await db.me();
    expect(me.owner).toBe("acme");
    expect(me.storage.url).toMatch(/^file:\/\//);
  });

  it("writes as the owner, a local writer with a claimed owner (F11.4)", async () => {
    await db.ingest({ format: "claude-code", session_id: "sess1", transcript: CLAUDE });
    expect(await db.getSession("claude-code", "sess1")).toMatchObject({
      owner: "acme",
      owner_basis: "claimed",
      writer: { kind: "local", principal: "acme", source_id: "upload" },
    });
  });

  it("names the owner from local.owner, then user, then the OS user, as an owner id", () => {
    const config = (tree: unknown) => cli({ local: { config: "x" }, ...(tree as object) });
    expect(localOwner(config({ local: { config: "x", owner: "Ops@Acme.com" } }), {})).toBe(
      "ops@acme.com",
    );
    expect(localOwner(config({ user: "Bob" }), { USER: "os" })).toBe("bob");
    expect(localOwner(config({}), { USER: "os" })).toBe("os");
    expect(localOwner(config({}), {})).toBe("local");
    expect(localOwner(config({}), { USER: "no/slashes" })).toMatch(/^h-[0-9a-f]{20}$/);
  });

  it("expands ~ in the local config path", () => {
    expect(expandHome("~/.config/seshi/seshi.toml", "/home/a")).toBe(
      "/home/a/.config/seshi/seshi.toml",
    );
    expect(expandHome("~", "/home/a")).toBe("/home/a");
    expect(expandHome("/etc/seshi.toml", "/home/a")).toBe("/etc/seshi.toml");
  });

  it("refuses another deployment's bucket (X1.4)", async () => {
    const file = serverToml('deployment_id = "staging"\n');
    await expect(
      connect({
        cli: cli({ local: { config: file } }),
        env: {},
        home: dir,
        integrations: INTEGRATIONS,
      }),
    ).rejects.toBeInstanceOf(InstanceError);
  });

  it("refuses a bucket nobody set up, and never writes its marker (F11.11)", async () => {
    const empty = join(dir, "empty");
    await expect(
      connect({
        cli: cli({ serverless: { url: `file://${empty}`, owner: "acme" } }),
        env: {},
        home: dir,
        integrations: INTEGRATIONS,
        write: true,
      }),
    ).rejects.toThrow(/no seshi bucket at .*: run seshi init --serverless/);
    expect(await getBytes(new FsStore(empty), LAYOUT_KEY)).toBeNull();
  });

  it("talks to a server over HTTP when the config names one", async () => {
    const remote = await connect({
      cli: cli({ server: "https://seshi.example" }),
      env: {},
      token: "t",
      integrations: INTEGRATIONS,
    });
    expect(remote.mode).toBe("server");
    expect(remote.db).toBeInstanceOf(HttpSessionDB);
    await expect(
      connect({ cli: cli({ server: "https://seshi.example" }), env: {}, integrations: [] }),
    ).rejects.toThrow(/run seshi login/);
    await expect(connect({ cli: cli({}), env: {}, integrations: [] })).rejects.toBeInstanceOf(
      NotConnected,
    );
  });

  it("refuses a CLI config that names both a server and a local bucket", () => {
    expect(() =>
      cli({ server: "https://seshi.example", local: { config: "~/seshi.toml" } }),
    ).toThrow(/not both/);
  });
});

describe("over a store", () => {
  it("stores, reads back, lists, and feeds changes", async () => {
    const result = stored(
      await db.ingest({
        format: "claude-code",
        session_id: "sess1",
        transcript: CLAUDE,
        project: "github.com/acme/widget",
      }),
    );
    expect(result.status).toBe("stored");
    expect(result).not.toHaveProperty("raw");

    const metadata = await db.getSession("claude-code", "sess1");
    expect(metadata).toMatchObject({
      owner: "acme",
      session_id: "sess1",
      head: result.content_hash,
      project: "github.com/acme/widget",
    });

    const trace = (await db.getTrace("claude-code", "sess1")) as Trace | null;
    expect(trace?.content_hash).toBe(result.content_hash);
    expect(trace?.metadata.normalizer?.name).toBe("@dosu/sessiondb");
    expect(await db.getTrace("claude-code", "sess1", result.content_hash)).toEqual(trace);

    const page = await db.listSessions();
    expect(page.sessions.map((s) => s.session_id)).toEqual(["sess1"]);
    expect(page.truncated).toBe(false);

    const changes = await db.changes();
    expect(changes.entries).toHaveLength(1);
    expect(changes.entries[0]?.entry).toMatchObject({
      kind: "published",
      owner: "acme",
      content_hash: result.content_hash,
    });
    expect(await db.changes({ after: changes.cursor })).toMatchObject({ entries: [] });
  });

  it("tombstones, and refuses the session after", async () => {
    await db.ingest({ format: "claude-code", session_id: "sess1", transcript: CLAUDE });
    expect(await db.tombstone("claude-code", "sess1")).toEqual({ removed: 1 });
    expect(await db.getTrace("claude-code", "sess1")).toBeNull();
    expect(await db.getSession("claude-code", "sess1")).toMatchObject({ status: "redacted" });

    const again = db.ingest({ format: "claude-code", session_id: "sess1", transcript: CLAUDE });
    await expect(again).rejects.toBeInstanceOf(IngestRejected);
    // One vocabulary: the store's refusals are SessionRejected too, with their code.
    await expect(again).rejects.toBeInstanceOf(SessionRejected);
    await expect(again).rejects.toMatchObject({ code: "redacted" });

    const changes = await db.changes();
    expect(changes.entries.map((e) => e.entry.kind)).toEqual(["published", "tombstone"]);
  });
});
