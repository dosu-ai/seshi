/** Model review inside a whole Instance (F3, X4.3): `[review]` in the config, the real
 * providers, a local server imitating the provider APIs, and a temporary folder store. No test
 * reaches a real API. */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "@seshi/api";
import { InstanceError } from "@seshi/instance";
import type { StoreSessionResult } from "@seshi/model";
import { type FakeServer, fakeProviderServer, KeywordModel } from "@seshi/review/testing";
import { listRecords, listReviews, readMetadata } from "@seshi/store";
import { afterEach, describe, expect, it } from "vitest";
import { bootInstance } from "../tooling/instance";

const ts = "2026-11-01T00:00:00Z";
const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const META = line({ role: "meta", source: "trajectory", cwd: "/home/alice/acme-checkout" });
const user = (content: string) => line({ role: "user", content, timestamp: ts });
const reply = (content: string) => line({ role: "assistant", content, timestamp: ts });

const SECRET = "Tangerine-Ladder-1987";
const ALICE_TOKEN = "alice-token-0123456789";
const MODEL = new KeywordModel({
  drop: ["CUSTOMER TABLE"],
  sensitive: [{ text: SECRET, category: "secret" }],
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function server(options: Parameters<typeof fakeProviderServer>[0] = { model: MODEL }): FakeServer {
  const s = fakeProviderServer(options);
  cleanups.push(() => s.close());
  return s;
}

async function boot(policy: string) {
  const booted = await bootInstance(
    `[filter]\nenabled = false\n[auth.tokens]\nalice = "${ALICE_TOKEN}"\n[[review.policies]]\n${policy}`,
  );
  cleanups.push(() => booted.cleanup());
  const db = booted.instance.localSessions("alice");
  const ingest = (transcript: string, extra: { session_id?: string } = {}) =>
    db.ingest({ agent: "trajectory", session_id: extra.session_id ?? "s1", transcript });
  return { ...booted, db, ingest };
}

const anthropic = (s: FakeServer, extra = "") =>
  `id = "default"\ndecision = { api_key = "sk-test", base_url = "${s.url}" }\n${extra}`;

/** Every file in the bucket, as text. */
function bucketText(dir: string): string {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(readFileSync(path).toString("latin1"));
    }
  };
  walk(join(dir, "bucket"));
  return out.join("\n");
}

function stored(result: StoreSessionResult) {
  if (!("content_hash" in result)) throw new Error(`expected a trace, got ${result.status}`);
  return result;
}

describe("model review in the pipeline", () => {
  it("redacts what the redactor finds before anything is written, and records the decision", async () => {
    const s = server();
    const { ingest, db, store, dir, instance } = await boot(anthropic(s));
    const result = stored(await ingest(META + user(`log in with ops / ${SECRET}`) + reply("done")));

    const trace = await db.getTrace("trajectory", "s1");
    expect(JSON.stringify(trace)).toContain("log in with ops / [redacted:secret]");
    const reviews = await listReviews(store, "alice", result.archive_id);
    expect(reviews).toEqual([
      expect.objectContaining({
        n: 0,
        content_hash: result.content_hash,
        decision: "redact",
        policy: "default",
        decision_model: "anthropic/claude-haiku-5-5",
        redactor_model: "anthropic/claude-haiku-5-5",
        findings: [{ record: 1, field: "content", category: "secret", action: "redact" }],
        parts: 1,
      }),
    ]);
    expect(reviews[0]?.policy_hash).toMatch(/^[0-9a-f]{64}$/);
    // Unredacted text never reaches the bucket: not the trace, the metadata or the review.
    expect(bucketText(dir)).not.toContain(SECRET);

    // The decision model, then the redactor, each through the Messages API.
    expect(s.requests.map((r) => r.api)).toEqual(["anthropic", "anthropic"]);
    // What left the server: the judged records' text only, never the meta record or the raw log.
    for (const request of s.requests) {
      const body = JSON.stringify(request.body);
      expect(body).not.toContain("acme-checkout");
      expect(body).not.toContain(ts);
    }
    expect(instance.config.review.policies).toHaveLength(1);
  });

  it("allows, and records the allow", async () => {
    const s = server();
    const { ingest, store } = await boot(anthropic(s));
    const result = stored(await ingest(META + user("fix the build") + reply("done")));
    const [review] = await listReviews(store, "alice", result.archive_id);
    expect(review).toMatchObject({ decision: "allow", findings: [] });
    expect(review).not.toHaveProperty("redactor_model");
    expect(s.requests).toHaveLength(1);
  });

  it("drops: nothing in the session, a drop record with the policy hash (X6.4)", async () => {
    const s = server();
    const { ingest, store, dir } = await boot(anthropic(s));
    const answer = await ingest(
      META + user("here is the CUSTOMER TABLE: ana, 41 rua") + reply("ok"),
    );
    expect(answer).toMatchObject({ status: "dropped", bytes_total: 0 });
    const { records } = await listRecords(store, "dropped", "upload");
    expect(records).toHaveLength(1);
    expect(records[0]?.record).toMatchObject({
      reason: "review_drop",
      policy: "default",
      decision_model: "anthropic/claude-haiku-5-5",
      session_key: "s1",
    });
    expect(bucketText(dir)).not.toContain("CUSTOMER TABLE");
    expect(await listReviews(store, "alice", "0".repeat(64))).toEqual([]);
  });

  it("drops with review_failed when the provider keeps failing and on_failure = drop (F3.4)", async () => {
    const s = server({ reply: () => ({ status: 500 }) });
    const { ingest, store } = await boot(anthropic(s, "retries = 0\n"));
    const answer = await ingest(META + user("hello") + reply("hi"));
    expect(answer.status).toBe("dropped");
    const { records } = await listRecords(store, "dropped", "upload");
    expect(records[0]?.record).toMatchObject({
      reason: "review_failed",
      failure: { step: "decision", code: "http_500", attempts: 1 },
    });
  });

  it("stores with regex redaction only, marked skipped, when on_failure = skip", async () => {
    const s = server({ reply: () => ({ status: 503 }) });
    const { ingest, store } = await boot(anthropic(s, 'retries = 0\non_failure = "skip"\n'));
    const result = stored(await ingest(META + user("hello") + reply("hi")));
    const [review] = await listReviews(store, "alice", result.archive_id);
    expect(review).toMatchObject({
      decision: "skipped",
      failure: { step: "decision", code: "http_503", attempts: 1 },
    });
  });

  it("reviews only what a write adds, and a resend not again (F3.6, F3.7)", async () => {
    const s = server();
    const { ingest, store } = await boot(anthropic(s));
    const first = META + user("start the work") + reply("started");
    const head = stored(await ingest(first));
    expect(s.requests).toHaveLength(1);

    const grown = first + user(`now use ${SECRET}`) + reply("used");
    const tail = stored(await ingest(grown));
    // The second decision call saw only the new records.
    const sent = JSON.stringify(s.requests[1]?.body);
    expect(sent).toContain("now use");
    expect(sent).not.toContain("start the work");
    const reviews = await listReviews(store, "alice", head.archive_id);
    expect(reviews.map((r) => [r.n, r.decision, r.content_hash])).toEqual([
      [0, "allow", head.content_hash],
      [1, "redact", tail.content_hash],
    ]);
    // Indexes are the written trace's: the continuation's meta record, then its two records.
    expect(reviews[1]?.findings).toEqual([
      { record: 1, field: "content", category: "secret", action: "redact" },
    ]);

    const calls = s.requests.length;
    await ingest(grown);
    expect(s.requests).toHaveLength(calls);
    const metadata = await readMetadata(store, "alice", head.archive_id);
    expect(metadata?.head).toBe(tail.content_hash);
  });

  it("can send the redactor's step to a local OpenAI-compatible model without a key", async () => {
    const s = server();
    const { ingest } = await boot(
      `${anthropic(s)}redactor = { provider = "openai-compatible", model = "local-guard", base_url = "${s.url}/v1" }\n`,
    );
    stored(await ingest(META + user(`password ${SECRET}`) + reply("ok")));
    expect(s.requests.map((r) => r.api)).toEqual(["anthropic", "openai"]);
    expect(s.requests[1]?.headers).not.toHaveProperty("authorization");
    expect(s.requests[1]?.body).toMatchObject({ model: "local-guard" });
  });

  it("refuses to start with a prompt file it cannot read", async () => {
    await expect(
      bootInstance(
        `[[review.policies]]\nid = "p"\ndecision = { api_key = "k", prompt_file = "/nonexistent/prompt.md" }\n`,
      ),
    ).rejects.toThrow(InstanceError);
  });

  it("shows admins the audit record and owners only the decision (F3 access)", async () => {
    const s = server();
    const { ingest, instance } = await boot(anthropic(s));
    stored(await ingest(META + user(`password ${SECRET}`) + reply("ok")));
    const app = createApp(instance);
    const { admin } = await instance.auth.initAdmin({ owner: "ops" });
    const get = async (token: string, path: string) => {
      const response = await app.fetch(
        new Request(`http://seshi.test${path}`, { headers: { authorization: `Bearer ${token}` } }),
      );
      return { status: response.status, body: (await response.json()) as { reviews: object[] } };
    };

    const asOwner = await get(ALICE_TOKEN, "/v1/sessions/trajectory/s1/reviews");
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.reviews).toEqual([
      {
        schema: "seshi/review/1",
        n: 0,
        at: expect.any(String),
        content_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        decision: "redact",
      },
    ]);

    const asAdmin = await get(
      admin?.token as string,
      "/v1/sessions/trajectory/s1/reviews?owner=alice",
    );
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.reviews[0]).toMatchObject({
      decision: "redact",
      policy: "default",
      redactor_model: "anthropic/claude-haiku-5-5",
      findings: [{ record: 1, field: "content", category: "secret", action: "redact" }],
    });
  });
});
