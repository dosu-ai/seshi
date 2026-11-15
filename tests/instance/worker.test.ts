/** The worker role end to end (X7, X3.11): a connector registered through an integration, run
 * by the instance's scheduler, its envelopes through the real pipeline and into the bucket as
 * its source's service account, and its status through `GET /v1/admin/jobs`. */

import { createApp } from "@seshi/api";
import { type Connector, defineIntegration } from "@seshi/kit";
import type { Envelope } from "@seshi/model";
import { readCheckpoint } from "@seshi/store";
import { afterEach, describe, expect, it } from "vitest";
import { bootInstance } from "../tooling/instance";
import { transcript } from "../tooling/testdata";

const SMALL = transcript("claude-basic.claude-code.jsonl");
const session = (id: string) =>
  `${SMALL.trim()}\n${JSON.stringify({
    type: "assistant",
    uuid: "a3",
    timestamp: "2026-09-01T00:00:08.000Z",
    sessionId: id,
    message: {
      role: "assistant",
      model: "claude-x",
      content: [{ type: "text", text: `The auth flow: ${"details ".repeat(400)}` }],
    },
  })}\n`;

/** A vendor's sessions, as a fake API would page them: one per run. */
const VENDOR = ["v1", "v2", "v3"];

const connector: Connector = {
  kind: "datadog",
  async run(ctx) {
    const next = (ctx.checkpoint.read()?.next as number | undefined) ?? 0;
    const id = VENDOR[next];
    if (id === undefined) return { lag_ms: 0 };
    const envelope: Envelope = {
      schema: "seshi/envelope/1",
      source: "datadog",
      source_id: ctx.source.id,
      format: "claude-code",
      session_key: id,
      payload: { kind: "log", encoding: "jsonl", text: session(id), offset: 0 },
      caller: { kind: "service", principal: `svc:${ctx.source.id}` },
      owner: `svc:${ctx.source.id}`,
      owner_basis: "service",
      idempotency_key: `${ctx.source.id}:${id}`,
      provenance: { cursor: String(next) },
      received_at: ctx.now().toISOString(),
    };
    await ctx.submit(envelope);
    await ctx.checkpoint.write({ next: next + 1 });
    return { more: next + 1 < VENDOR.length };
  },
};

const integration = defineIntegration({ name: "fake-vendor", connectors: [connector] });

const TOML = `
[[sources]]
id = "dd-prod"
type = "datadog"
api_key = "k"
app_key = "a"
interval = "1h"
visibility = "owner"

[worker]
heartbeat_interval = 200
`;

let booted: Awaited<ReturnType<typeof bootInstance>> | undefined;
afterEach(async () => {
  await booted?.cleanup();
  booted = undefined;
});

async function until(check: () => Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

describe("the worker role", () => {
  it("polls through the integration's connector into the bucket, and reports it", async () => {
    booted = await bootInstance(TOML, { integrations: [integration] });
    const { instance } = booted;
    instance.start();
    // `more` makes it page on without waiting for the hour.
    await until(
      async () => (await readCheckpoint(instance.store, "dd-prod"))?.value.cursor.next === 3,
    );

    const { admin } = await instance.auth.initAdmin({ owner: "ops" });
    const app = createApp(instance);
    const get = (path: string) =>
      app.fetch(
        new Request(`http://seshi.test${path}`, {
          headers: { authorization: `Bearer ${admin?.token}` },
        }),
      );
    const listed = await (await get("/v1/sessions?owner=svc:dd-prod")).json();
    expect(listed.sessions.map((s: { session_id: string }) => s.session_id).sort()).toEqual(VENDOR);
    expect(listed.sessions[0]).toMatchObject({
      owner: "svc:dd-prod",
      owner_basis: "service",
      visibility: "owner",
      writer: { kind: "service", principal: "svc:dd-prod", source_id: "dd-prod" },
    });

    await until(async () => {
      const status = await (await get("/v1/admin/jobs")).json();
      return (
        status.jobs.find((j: { name: string }) => j.name === "source:dd-prod")?.last?.runs >= 3
      );
    });
    const status = await (await get("/v1/admin/jobs")).json();
    expect(status.worker).toMatchObject({ state: "running", instance: instance.process });
    expect(status.jobs.find((j: { name: string }) => j.name === "source:dd-prod")).toMatchObject({
      kind: "poller",
      last: { last_outcome: "ok", failures: 0 },
      dropped: 0,
      failed: 0,
    });
    expect(status.sources.find((s: { id: string }) => s.id === "dd-prod")).toMatchObject({
      polled: true,
      connector: "datadog",
      checkpoint: { cursor: { next: 3 } },
    });
  });

  it("runs a source once for `seshi sync run`, and resending is harmless (X4.7)", async () => {
    booted = await bootInstance(TOML, { integrations: [integration], roles: [] });
    const { instance } = booted;
    const first = await instance.sources.run("dd-prod");
    expect(first).toMatchObject({
      outcome: "ok",
      submitted: 1,
      outcomes: { stored: 1 },
      more: true,
    });
    // Rewind and run again: the same envelope, answered from the session's applied keys.
    await instance.sources.rewind("dd-prod");
    const again = await instance.sources.run("dd-prod");
    expect(again.outcomes).toEqual({ stored: 1 });
    const metadata = await instance.localSessions("svc:dd-prod").getSession("claude-code", "v1");
    expect(metadata?.traces).toHaveLength(1);
  });
});
