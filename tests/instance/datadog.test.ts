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
import { type FakeServer, fakeProviderServer, KeywordModel } from "@seshi/review/testing";
import {
  archiveId,
  listPending,
  listRecords,
  listReviews,
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
/** What the local Export API answers, by page cursor. */
let answers: Record<string, unknown>;

/** Boot the Instance: the datadog source's config, then `extra` (more tables). */
async function start(extra = "") {
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
      extra,
    ].join("\n"),
    {
      integrations: INTEGRATIONS,
      now: () => clock,
      roles: ["api", "worker"],
    },
  );
  instance = booted.instance;
  admin = (await instance.auth.initAdmin({ owner: "ops" })).admin?.token as string;
}

beforeEach(async () => {
  keys = [];
  // Page 1 → page 2 → the minimal-capture session, then nothing more.
  const page2 = fixture("trajectory-session.page2.json");
  page2.meta.page = { after: "minimal" };
  answers = {
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
  await start();
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

// A GitHub token, matched by the built-in `github-token` rule.
const GH = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"}`;

/** One span of the first page's answer, by Datadog span id. */
// biome-ignore lint/suspicious/noExplicitAny: fixtures are Export API answers, walked by path
function pageSpan(id: string): any {
  // biome-ignore lint/suspicious/noExplicitAny: as above
  return (answers.first as any).data.find((s: { id: string }) => s.id === id).attributes;
}

describe("a datadog session goes through the same redaction and review as OTLP (07, 08)", () => {
  it("is redacted by the rule set on arrival, and the session counts each match once", async () => {
    // The first turn's prompt, a tool's output and the turn's LLM call error carry the token.
    pageSpan("4823117000000000001").input.value += ` (the CI token is ${GH})`;
    pageSpan("4823117000000000003").output.value += ` while using ${GH}`;
    const usage = pageSpan("4823117000000000007");
    usage.status = "error";
    usage.metadata = { "error.type": "auth", "error.message": `401 for ${GH}` };

    expect(await instance.sources.run(SOURCE)).toMatchObject({ outcome: "ok", submitted: 3 });
    const archive = archiveId(OWNER, AGENT, SESSION);
    // The span records are the rule set's work already: nothing raw waits in the bucket.
    const spans = await listSpans(booted.store, OWNER, archive);
    expect(JSON.stringify(spans)).not.toContain(GH);
    for (const record of spans) expect(record.redaction?.rule_set).toBe(instance.redaction.hash);
    const counted = spans.filter((s) => (s.redaction?.counts["github-token"] ?? 0) > 0);
    expect(counted.map((s) => s.part.span_id).sort()).toEqual(
      // Datadog's decimal span ids, stored as OTLP hex.
      ["4823117000000000001", "4823117000000000003", "4823117000000000007"]
        .map((id) => BigInt(id).toString(16).padStart(16, "0"))
        .sort(),
    );

    clock = new Date(clock.getTime() + 10 * 60_000);
    expect(await assemble()).toMatchObject({ published: 2, stored: 1 });
    const metadata = await readMetadata(booted.store, OWNER, archive);
    expect(metadata?.redaction).toEqual({
      rule_set: instance.redaction.hash,
      counts: { "github-token": 3 },
    });
    const stored = await trace();
    expect(JSON.stringify(stored)).not.toContain(GH);
    expect(stored.records[1]).toMatchObject({
      role: "user",
      content: expect.stringContaining("(the CI token is [redacted:github-token])"),
    });
    expect(stored.llm_calls?.[0]?.error).toBe("auth: 401 for [redacted:github-token]");
  });

  /** Reboot with a review policy scoped to the datadog source, against a local provider. */
  async function withReview(): Promise<FakeServer> {
    const provider = fakeProviderServer({
      model: new KeywordModel({
        drop: ["CUSTOMER TABLE"],
        sensitive: [{ text: "Tangerine-Ladder-1987", category: "secret" }],
      }),
    });
    await booted.cleanup();
    await start(
      [
        "[[review.policies]]",
        'id = "default"',
        `decision = { api_key = "sk-test", base_url = "${provider.url}" }`,
        `sources = ["${SOURCE}"]`,
      ].join("\n"),
    );
    return provider;
  }

  it("is reviewed under a policy naming the datadog source, and the decision recorded", async () => {
    const provider = await withReview();
    try {
      pageSpan("4823117000000000001").input.value += " (log in with ops / Tangerine-Ladder-1987)";
      await instance.sources.run(SOURCE);
      clock = new Date(clock.getTime() + 10 * 60_000);
      expect(await assemble()).toMatchObject({ published: 2, stored: 1 });

      const archive = archiveId(OWNER, AGENT, SESSION);
      const metadata = await readMetadata(booted.store, OWNER, archive);
      expect(metadata?.status).toBe("stored");
      const stored = await trace();
      expect(JSON.stringify(stored)).not.toContain("Tangerine-Ladder-1987");
      expect(JSON.stringify(stored)).toContain("log in with ops / [redacted:secret]");
      expect(await listReviews(booted.store, OWNER, archive)).toEqual([
        expect.objectContaining({
          n: 0,
          content_hash: metadata?.head,
          decision: "redact",
          policy: "default",
        }),
      ]);
      expect(provider.requests.map((r) => r.api)).toContain("anthropic");
    } finally {
      await provider.close();
    }
  });

  it("is dropped when review drops it, under the datadog source", async () => {
    const provider = await withReview();
    try {
      pageSpan("4823117000000000001").input.value += " and here is the CUSTOMER TABLE: ana, 41 rua";
      await instance.sources.run(SOURCE);
      clock = new Date(clock.getTime() + 10 * 60_000);
      await assemble();

      expect(await readMetadata(booted.store, OWNER, archiveId(OWNER, AGENT, SESSION))).toBeNull();
      const { records } = await listRecords(booted.store, "dropped", SOURCE);
      expect(records.map((r) => r.record)).toContainEqual(
        expect.objectContaining({
          reason: "review_drop",
          policy: "default",
          source_kind: "datadog",
          session_key: SESSION,
        }),
      );
      // The drop counts in the datadog source's health, beside the filtered minimal session.
      await instance.health.flush();
      expect((await readHealth(booted.store, SOURCE)).map((d) => d.counts)).toEqual([
        expect.objectContaining({ dropped: 1, filtered: 1 }),
      ]);
    } finally {
      await provider.close();
    }
  });
});
