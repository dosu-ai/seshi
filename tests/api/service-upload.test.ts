/** A service token that writes through `POST /v1/sessions` files what it writes under its own
 * source (X5.4): the envelope's `source_id` is the service's source, so that source's
 * visibility, filter and health apply, and the writer says so. Uploads with any other
 * credential stay under `upload` (X6.4). */

import { createApp } from "@seshi/api";
import { archiveId, readHealth, readMetadata } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootInstance } from "../tooling/instance";
import { transcript } from "../tooling/testdata";

const TOKEN = "acme-token-0123456789abcdef";
const LONG = `${transcript("claude-basic.claude-code.jsonl").trim()}\n${JSON.stringify({
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

let booted: Awaited<ReturnType<typeof bootInstance>>;

beforeEach(async () => {
  booted = await bootInstance(
    [
      `[auth.tokens]\nacme = "${TOKEN}"`,
      '[[sources]]\nid = "private-bot"\ntype = "otlp"\nvisibility = "owner"',
      '[[sources]]\nid = "open-bot"\ntype = "otlp"',
    ].join("\n"),
  );
});
afterEach(() => booted.cleanup());

async function serviceToken(service: string): Promise<string> {
  const { instance } = booted;
  const { admin } = await instance.auth.initAdmin({ owner: "ops", force: true });
  const by = await instance.auth.authenticate(admin?.token, undefined);
  return (await instance.auth.issue({ kind: "service", service, scopes: ["sessions:write"] }, by))
    .token;
}

async function post(token: string, sessionId: string) {
  const app = createApp(booted.instance);
  return app.fetch(
    new Request("http://seshi.test/v1/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ format: "claude-code", session_id: sessionId, transcript: LONG }),
    }),
  );
}

describe("uploads with a service token", () => {
  it("are filed under the service's source: its visibility, its writer, its health", async () => {
    const token = await serviceToken("private-bot");
    expect((await post(token, "s1")).status).toBe(201);
    const owner = "svc:private-bot";
    const metadata = await readMetadata(booted.store, owner, archiveId(owner, "claude-code", "s1"));
    expect(metadata?.visibility).toBe("owner");
    expect(metadata?.owner_basis).toBe("service");
    expect(metadata?.writer).toMatchObject({ kind: "service", source_id: "private-bot" });
    expect(metadata?.provenance).toMatchObject({ source: "upload", source_id: "private-bot" });
    await booted.instance.health.flush();
    const health = await readHealth(booted.store, "private-bot");
    expect(health.map((d) => d.counts.stored)).toEqual([1]);
  });

  it("take the server default when the service's source names no visibility", async () => {
    const token = await serviceToken("open-bot");
    expect((await post(token, "s2")).status).toBe(201);
    const owner = "svc:open-bot";
    const metadata = await readMetadata(booted.store, owner, archiveId(owner, "claude-code", "s2"));
    expect(metadata?.visibility).toBe("org");
  });

  it("leave other credentials' uploads under upload", async () => {
    expect((await post(TOKEN, "s3")).status).toBe(201);
    const metadata = await readMetadata(
      booted.store,
      "acme",
      archiveId("acme", "claude-code", "s3"),
    );
    expect(metadata?.writer).toMatchObject({ kind: "static", source_id: "upload" });
  });
});
