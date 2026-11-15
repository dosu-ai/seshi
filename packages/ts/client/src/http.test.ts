import { gunzipSync } from "node:zlib";
import { OffsetMismatch, SessionRejected, StoreError, VERSION } from "@seshi/model";
import { describe, expect, it } from "vitest";
import { HttpSessionDB, ServerError } from "./http";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | undefined;
}

/** A client over a fake server that answers every request with `status` and `body`. */
function client(
  status: number,
  body: unknown,
  options: { gzipFrom?: number; headers?: Record<string, string> } = {},
) {
  const seen: Seen[] = [];
  const db = new HttpSessionDB({
    server: "https://seshi.example.com/",
    token: "tok",
    gzipFrom: options.gzipFrom,
    fetch: async (url, init) => {
      seen.push({
        url,
        method: init?.method ?? "GET",
        headers: init?.headers as Record<string, string>,
        body: init?.body as Uint8Array | undefined,
      });
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return new Response(status === 304 ? null : text, {
        status,
        ...(options.headers ? { headers: options.headers } : {}),
      });
    },
  });
  return { db, seen };
}

describe("HttpSessionDB", () => {
  it("sends the token and its user agent, and reads the answer", async () => {
    const { db, seen } = client(200, { owner: "acme", storage: { url: "s3://b" } });
    expect(await db.me()).toEqual({ owner: "acme", storage: { url: "s3://b" } });
    expect(seen[0]?.url).toBe("https://seshi.example.com/v1/me");
    expect(seen[0]?.headers.authorization).toBe("Bearer tok");
    expect(seen[0]?.headers["user-agent"]).toBe(`@dosu/sessiondb/${VERSION}`);
  });

  it("fetches the org's redaction rules", async () => {
    const doc = { schema: "seshi/redaction-rules/1", rule_set: "h", builtin: "b", packs: [] };
    const { db, seen } = client(200, doc);
    expect(await db.redactionRules()).toEqual(doc);
    expect(seen[0]?.url).toBe("https://seshi.example.com/v1/redaction/rules");
    await expect(
      client(401, { error: { code: "unauthorized" } }).db.redactionRules(),
    ).rejects.toThrow(ServerError);
  });

  it("fetches them again only when they changed (If-None-Match)", async () => {
    const doc = { schema: "seshi/redaction-rules/1", rule_set: "h", builtin: "b", packs: [] };
    const fresh = client(200, doc, { headers: { etag: '"h"' } });
    expect(await fresh.db.redactionRulesSince()).toEqual({ document: doc, etag: '"h"' });
    expect(fresh.seen[0]?.headers["if-none-match"]).toBeUndefined();
    const same = client(304, null, { headers: { etag: '"h"' } });
    expect(await same.db.redactionRulesSince('"h"')).toBeNull();
    expect(same.seen[0]?.headers["if-none-match"]).toBe('"h"');
    await expect(client(304, null).db.redactionRulesSince()).rejects.toThrow(ServerError);
  });

  it("gzips a body past gzipFrom", async () => {
    const { db, seen } = client(201, { status: "trivial" }, { gzipFrom: 10 });
    await db.ingest({ agent: "claude-code", session_id: "s", transcript: "x".repeat(100) });
    const sent = seen[0] as Seen;
    expect(sent.headers["content-encoding"]).toBe("gzip");
    const body = JSON.parse(new TextDecoder().decode(gunzipSync(sent.body as Uint8Array)));
    expect(body).toMatchObject({ agent: "claude-code", session_id: "s" });
  });

  it("encodes the session path and leaves out absent query values", async () => {
    const { db, seen } = client(200, { content_hash: "h" });
    await db.getTrace("claude-code", "a/b c");
    expect(seen[0]?.url).toBe("https://seshi.example.com/v1/sessions/claude-code/a%2Fb%20c/trace");
  });

  it("sends a replace's retraction secret in X-Seshi-Retract, never the body", async () => {
    const { db, seen } = client(201, { status: "stored" });
    const upload = { agent: "claude-code", session_id: "s1", transcript: "{}\n", replace: true };
    await db.ingest(upload, { retractSecret: "s3cret" });
    expect(seen[0]?.headers["x-seshi-retract"]).toBe("s3cret");
    expect(new TextDecoder().decode(seen[0]?.body)).not.toContain("s3cret");
    await db.ingest(upload);
    expect(seen[1]?.headers["x-seshi-retract"]).toBeUndefined();
  });

  it("turns the server's refusals back into the pipeline's errors", async () => {
    const mismatch = client(409, { error: { code: "offset_mismatch", expected: 12 } }).db;
    const err = await mismatch
      .ingest({ agent: "claude-code", session_id: "s", transcript: "x\n", offset: 30 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OffsetMismatch);
    expect(err).toMatchObject({ offset: 30, expected: 12 });

    const rejected = client(422, { error: { code: "empty", message: "transcript is empty" } }).db;
    await expect(rejected.listSessions()).rejects.toBeInstanceOf(SessionRejected);
    await expect(client(502, { error: { message: "down" } }).db.me()).rejects.toBeInstanceOf(
      StoreError,
    );
    await expect(client(401, { error: { code: "unauthorized" } }).db.me()).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
    await expect(client(500, "<html>proxy</html>").db.me()).rejects.toBeInstanceOf(ServerError);
  });

  it("is null for a session that is not there", async () => {
    expect(await client(404, { error: { code: "not_found" } }).db.getSession("a", "b")).toBeNull();
    expect(await client(410, { error: { code: "gone" } }).db.getTrace("a", "b")).toBeNull();
    expect(await client(404, { error: { code: "not_found" } }).db.tombstone("a", "b")).toBeNull();
  });

  it("refuses a 2xx that is not JSON, and reports an unreachable server as StoreError", async () => {
    await expect(client(200, "not json").db.me()).rejects.toMatchObject({ code: "bad_response" });
    const down = new HttpSessionDB({
      server: "https://seshi.example.com",
      token: "tok",
      fetch: async () => {
        throw new Error("connection refused");
      },
    });
    await expect(down.me()).rejects.toThrow(/cannot reach https:\/\/seshi.example.com/);
  });
});
