/** Datadog LLM Observability sync end to end (F5): a `type = "datadog"` source polled by the
 * binary's own connector (the datadog-trajectory integration) from a local server that answers
 * like the Export API, its spans into the span store as the source's service account, then the
 * worker's assembler into sessions read back through the API. The pages are hand-built from
 * Datadog's and Trajectory's published shapes
 * (`integrations/datadog-trajectory/testdata/llmobs/README.md`); no request leaves the machine. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "@seshi/api";
import type { Instance } from "@seshi/instance";
import type { Trace } from "@seshi/model";
import {
  archiveId,
  listPending,
  listSpans,
  readCheckpoint,
  readHealth,
  readMetadata,
} from "@seshi/store";
import { INTEGRATIONS } from "seshi/integrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootInstance } from "../tooling/instance";
import { ROOT } from "../tooling/testdata";

const FIXTURES = join(ROOT, "integrations", "datadog-trajectory", "testdata", "llmobs");
// biome-ignore lint/suspicious/noExplicitAny: fixtures are Export API answers, walked by path
const fixture = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

const SOURCE = "dd-prod";
const OWNER = `svc:${SOURCE}`;
const SESSION = "8f14e45f-ceea-4e7a-9d1b-2b6a1f0c3d11";
const MINIMAL = "sess-minimal-01";
const AGENT = "datadog-llmobs";

let server: ReturnType<typeof Bun.serve>;
let booted: Awaited<ReturnType<typeof bootInstance>>;
let instance: Instance;
let clock: Date;
let admin: string;
let keys: { api: string | null; app: string | null }[];

beforeEach(async () => {
  keys = [];
  // Page 1 → page 2 → the minimal-capture session, then nothing more.
  const page2 = fixture("trajectory-session.page2.json");
  page2.meta.page = { after: "minimal" };
  const answers: Record<string, unknown> = {
    first: fixture("trajectory-session.page1.json"),
    eyJhZnRlciI6InBhZ2UtMiJ9: page2,
    minimal: fixture("trajectory-minimal.json"),
  };
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      keys.push({
        api: request.headers.get("dd-api-key"),
        app: request.headers.get("dd-application-key"),
      });
      const body = (await request.json()) as {
        data: { attributes: { page: { cursor?: string } } };
      };
      const answer = answers[body.data.attributes.page.cursor ?? "first"];
      return answer ? Response.json(answer) : Response.json({ errors: ["bad"] }, { status: 400 });
    },
  });
  clock = new Date("2026-11-14T10:07:00Z");
  booted = await bootInstance(
    [
      "[[sources]]",
      `id = "${SOURCE}"`,
      'type = "datadog"',
      `api_url = "http://127.0.0.1:${server.port}"`,
      'api_key = "dd-api-0123"',
      'app_key = "dd-app-4567"',
      'ml_app = "coding-agents"',
      'quiet_period = "5m"',
      'visibility = "owner"',
      // The fixtures are short conversations: the default filter (X4.10) would drop them.
      "filter = { min_chars = 50 }",
    ].join("\n"),
    {
      integrations: INTEGRATIONS,
      now: () => clock,
      roles: ["api", "worker"],
    },
  );
  instance = booted.instance;
  admin = (await instance.auth.initAdmin({ owner: "ops" })).admin?.token as string;
});

afterEach(async () => {
  server.stop(true);
  await booted.cleanup();
});

async function assemble() {
  const record = await instance.jobs.runNow("assembler");
  expect(record.last_error).toBeUndefined();
  return record.last_summary ?? {};
}

async function trace(sessionId = SESSION): Promise<Trace> {
  const response = await createApp(instance).fetch(
    new Request(
      `http://seshi.test/v1/sessions/${AGENT}/${sessionId}/trace?owner=${encodeURIComponent(OWNER)}`,
      { headers: { authorization: `Bearer ${admin}` } },
    ),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Trace;
}

describe("a datadog source", () => {
  it("is polled by the binary's connector", () => {
    expect(instance.sources.list().find((s) => s.id === SOURCE)).toMatchObject({
      polled: true,
      connector: "datadog",
    });
  });

  it("syncs a Trajectory session into the span store, then publishes it once quiet", async () => {
    const run = await instance.sources.run(SOURCE);
    expect(run).toMatchObject({ outcome: "ok", submitted: 3, outcomes: { accepted: 3 } });
    // The keys go on every page.
    expect(keys).toEqual(Array(3).fill({ api: "dd-api-0123", app: "dd-app-4567" }));
    expect((await readCheckpoint(booted.store, SOURCE))?.value.cursor).toMatchObject({
      v: 1,
      until: "2026-11-14T10:05:00.000Z",
    });

    const archive = archiveId(OWNER, AGENT, SESSION);
    expect(await listSpans(booted.store, OWNER, archive)).toHaveLength(15);
    // Not yet quiet for the source's quiet_period.
    clock = new Date(clock.getTime() + 60_000);
    expect(await assemble()).toMatchObject({ published: 0, waiting: 2 });

    clock = new Date(clock.getTime() + 5 * 60_000);
    expect(await assemble()).toMatchObject({ published: 2, stored: 1, filtered: 1 });

    const metadata = await readMetadata(booted.store, OWNER, archive);
    expect(metadata).toMatchObject({
      owner: OWNER,
      owner_basis: "service",
      visibility: "owner",
      origin_agent: AGENT,
      native_session_id: SESSION,
      project: "payments-api",
      writer: { kind: "service", principal: OWNER, source_id: SOURCE },
      claims: {
        email: "jdoe@example.com",
        git_email: "jdoe@users.noreply.example.com",
        username: "jdoe",
        account_ids: { github: "jdoe-dev" },
      },
      provenance: { source: "datadog", source_id: SOURCE, format: AGENT },
    });

    const stored = await trace();
    const roles = stored.records.map((r) => r.role);
    expect(roles.filter((r) => r === "user")).toHaveLength(2);
    expect(roles.filter((r) => r === "tool")).toHaveLength(4);
    expect(stored.records[0]).toMatchObject({ role: "meta", model: "claude-sonnet-4-5" });
    expect(stored.llm_calls?.map((c) => c.usage?.total_tokens)).toEqual([5610, 6320, 7030]);

    // The minimal-capture session is near empty: the filter drops it, and health says so
    // (F5.4), while its spans stay for later.
    expect(await readMetadata(booted.store, OWNER, archiveId(OWNER, AGENT, MINIMAL))).toBeNull();
    expect(await listSpans(booted.store, OWNER, archiveId(OWNER, AGENT, MINIMAL))).toHaveLength(7);
    await instance.health.flush();
    const health = await readHealth(booted.store, SOURCE);
    expect(health.map((d) => d.counts)).toEqual([
      expect.objectContaining({ stored: 1, filtered: 1 }),
    ]);
    expect((await listPending(booted.store, {})).archives).toEqual([]);
  });

  it("leaves out what it already submitted, and a rewind resubmits harmlessly (X4.7)", async () => {
    await instance.sources.run(SOURCE);
    clock = new Date(clock.getTime() + 10 * 60_000);
    await assemble();
    const before = await readMetadata(booted.store, OWNER, archiveId(OWNER, AGENT, SESSION));

    // The next window overlaps the last one: Datadog answers the same spans, which are left
    // out by span id, so nothing is submitted and no session waits to be assembled again.
    const again = await instance.sources.run(SOURCE);
    expect(again).toMatchObject({ outcome: "ok", submitted: 0 });
    expect((await readCheckpoint(booted.store, SOURCE))?.value.cursor).toMatchObject({
      until: "2026-11-14T10:15:00.000Z",
    });
    expect((await listPending(booted.store, {})).archives).toEqual([]);

    // A rewind (seshi reprocess) reads everything again; the session is not written twice.
    await instance.sources.rewind(SOURCE);
    const rerun = await instance.sources.run(SOURCE);
    expect(rerun).toMatchObject({ outcome: "ok", submitted: 3 });
    clock = new Date(clock.getTime() + 10 * 60_000);
    await assemble();
    const after = await readMetadata(booted.store, OWNER, archiveId(OWNER, AGENT, SESSION));
    expect(after?.traces).toEqual(before?.traces);
  });
});
