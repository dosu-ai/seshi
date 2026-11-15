/** Model review inside a whole Instance (F3, X4.3): `[review]` in the config, the real
 * providers, a local server imitating the provider APIs, and a temporary folder store. No test
 * reaches a real API. */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "@seshi/api";
import { InstanceError } from "@seshi/instance";
import type { StoreSessionResult } from "@seshi/model";
import { backfillRedaction, getTrace } from "@seshi/pipeline";
import { compileRuleSet, ruleRedactor, validatePack } from "@seshi/redact";
import { type FakeServer, fakeProviderServer, KeywordModel } from "@seshi/review/testing";
import { archiveId, listRecords, listReviews, readMetadata } from "@seshi/store";
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

  it("drops: nothing in the session but a stub, a drop record with the policy hash (X6.4)", async () => {
    const s = server();
    const { ingest, store, dir } = await boot(anthropic(s));
    const dumped = META + user("here is the CUSTOMER TABLE: ana, 41 rua") + reply("ok");
    const answer = await ingest(dumped);
    // The log moves past the drop (F3.4): the stub holds where it ends.
    expect(answer).toMatchObject({ status: "dropped", bytes_total: Buffer.byteLength(dumped) });
    const { records } = await listRecords(store, "dropped", "upload");
    expect(records).toHaveLength(1);
    expect(records[0]?.record).toMatchObject({
      reason: "review_drop",
      policy: "default",
      decision_model: "anthropic/claude-haiku-5-5",
      session_key: "s1",
    });
    expect(bucketText(dir)).not.toContain("CUSTOMER TABLE");
    expect(bucketText(dir)).not.toContain("acme-checkout");
    const archive = archiveId("alice", "trajectory", "s1");
    expect(await readMetadata(store, "alice", archive)).toMatchObject({ traces: [] });
    expect(await listReviews(store, "alice", archive)).toEqual([]);
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

  it("sends the models only what regex redaction left (X4.3)", async () => {
    const s = server();
    const { ingest } = await boot(anthropic(s));
    const token = "ghp_abcdefghijklmnopqrstuvwxyz012345";
    stored(await ingest(META + user(`push with ${token} please`) + reply("pushed")));
    expect(s.requests.length).toBeGreaterThan(0);
    for (const request of s.requests) {
      const body = JSON.stringify(request.body);
      expect(body).toContain("push with");
      expect(body).not.toContain(token);
    }
  });

  it("moves the log past a dropped continuation, so later writes go on (F3.4)", async () => {
    const s = server();
    const { ingest, db, store, dir } = await boot(anthropic(s));
    const first = META + user("start the work") + reply("started");
    const head = stored(await ingest(first));

    const dropped = first + user("paste of the CUSTOMER TABLE: ana, 41 rua") + reply("noted");
    expect((await ingest(dropped)).status).toBe("dropped");
    const { records } = await listRecords(store, "dropped", "upload");
    expect(records.map((r) => r.record.reason)).toEqual(["review_drop"]);

    // The next upload is the whole log again; only what follows the dropped records is new.
    const later = dropped + user("carry on") + reply("done");
    const tail = stored(await ingest(later));
    expect(JSON.stringify(s.requests.at(-1)?.body)).not.toContain("CUSTOMER TABLE");
    // The new trace continues after the dropped records (meta, two, then the two dropped).
    const trace = await db.getTrace("trajectory", "s1");
    expect(trace).toMatchObject({ metadata: { continuation: { from_record: 5 } } });
    expect(JSON.stringify(trace)).toContain("carry on");
    expect(JSON.stringify(trace)).not.toContain("CUSTOMER TABLE");
    expect(bucketText(dir)).not.toContain("CUSTOMER TABLE");
    const reviews = await listReviews(store, "alice", head.archive_id);
    expect(reviews.map((r) => [r.decision, r.content_hash])).toEqual([
      ["allow", head.content_hash],
      ["allow", tail.content_hash],
    ]);
  });

  it("keeps what review took out through a redaction backfill, and asks no model again (07)", async () => {
    // `seshi redact backfill` re-redacts the stored, reviewed trace with the new rules only:
    // review's markers and withheld results are already in it, and no session text is sent to
    // a provider again (see docs/seshi/build/08-model-review.md).
    const DUMP = "vault dump: hunter2-prod-root";
    const s = server({
      model: new KeywordModel({
        sensitive: [
          { text: SECRET, category: "secret" },
          { text: DUMP, category: "secret", action: "withhold" },
        ],
      }),
    });
    const { ingest, db, store, dir } = await boot(anthropic(s));
    const call = line({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", name: "Read", args: JSON.stringify({ path: "notes.txt" }) }],
      timestamp: ts,
    });
    const result = line({ role: "tool", tool_call_id: "c1", content: DUMP, timestamp: ts });
    const head = stored(
      await ingest(
        META + user(`log in with ops / ${SECRET}`) + call + result + reply("use ACME-1234 next"),
      ),
    );
    const calls = s.requests.length;
    expect(calls).toBe(2);

    const acme = validatePack(
      { id: "acme", rules: [{ id: "acme-key", pattern: "ACME-\\d{4}" }] },
      { source: "acme.toml" },
    );
    const report = await backfillRedaction({
      store,
      redactor: ruleRedactor(compileRuleSet({ packs: [acme] })),
      writer: { kind: "admin", principal: "admin", source_id: "redaction" },
    });
    expect(report.outcomes.rewritten).toBe(1);
    expect(report.counts).toEqual({ "acme-key": 1 });
    expect(s.requests).toHaveLength(calls);

    const trace = await db.getTrace("trajectory", "s1");
    const text = JSON.stringify(trace);
    expect(text).toContain("log in with ops / [redacted:secret]");
    expect(text).toContain("use [redacted:acme-key] next");
    const records = trace && "records" in trace ? trace.records : [];
    expect(records.find((r) => r.role === "tool")).toMatchObject({
      content: "[redacted:secret]",
      withheld: "review",
    });
    for (const gone of [SECRET, DUMP, "ACME-1234"]) expect(bucketText(dir)).not.toContain(gone);

    // The review record stays, naming the trace the write produced (now replaced).
    const metadata = await readMetadata(store, "alice", head.archive_id);
    expect(metadata?.head).not.toBe(head.content_hash);
    const reviews = await listReviews(store, "alice", head.archive_id);
    expect(reviews.map((r) => [r.decision, r.content_hash])).toEqual([
      ["redact", head.content_hash],
    ]);
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

describe("model review of assembled OTLP sessions (08 with 09)", () => {
  const CONVERSATION = "conv-review";
  const OWNER = "svc:console";
  const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
  const messages = (role: string, text: string) =>
    JSON.stringify([{ role, parts: [{ type: "text", content: text }] }]);
  const ns = (at: Date) => (BigInt(at.getTime()) * 1_000_000n).toString();

  /** One GenAI chat span in OTLP's JSON mapping. */
  const request = (input: string, output: string, at: Date, spanId = "00000000000000a1") => ({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: "cd".repeat(16),
                spanId,
                name: "chat m",
                startTimeUnixNano: ns(at),
                endTimeUnixNano: ns(new Date(at.getTime() + 1000)),
                attributes: [
                  attr("gen_ai.operation.name", "chat"),
                  attr("gen_ai.conversation.id", CONVERSATION),
                  attr("gen_ai.input.messages", messages("user", input)),
                  attr("gen_ai.output.messages", messages("assistant", output)),
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  async function bootOtlp(policy: string) {
    let clock = new Date("2026-11-01T10:00:00Z");
    const booted = await bootInstance(
      [
        "[filter]\nenabled = false",
        '[[sources]]\nid = "console"\ntype = "otlp"\nquiet_period = "1m"',
        `[[review.policies]]\n${policy}sources = ["console"]`,
      ].join("\n"),
      { now: () => clock, roles: ["api", "worker"] },
    );
    cleanups.push(() => booted.cleanup());
    const app = createApp(booted.instance);
    const init = await booted.instance.auth.initAdmin({ owner: "ops" });
    const issued = await app.fetch(
      new Request("http://seshi.test/v1/tokens", {
        method: "POST",
        headers: {
          authorization: `Bearer ${init.admin?.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ kind: "service", service: "console", scopes: ["sessions:write"] }),
      }),
    );
    const token = ((await issued.json()) as { token: string }).token;
    /** Send one chat span, wait out the quiet period, and run the assembler. */
    const publish = async (input: string, output: string, spanId?: string) => {
      const response = await app.fetch(
        new Request("http://seshi.test/otlp/v1/traces", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(request(input, output, clock, spanId)),
        }),
      );
      expect(response.status).toBe(200);
      clock = new Date(clock.getTime() + 2 * 60_000);
      const record = await booted.instance.jobs.runNow("assembler");
      expect(record.last_error).toBeUndefined();
      return record.last_summary;
    };
    return { ...booted, publish, archive: archiveId(OWNER, "otlp-genai", CONVERSATION) };
  }

  it("reviews the assembled session before it is written and records the decision", async () => {
    const s = server();
    const { publish, store, archive } = await bootOtlp(anthropic(s));
    expect(await publish(`log in with ops / ${SECRET}`, "done")).toMatchObject({ published: 1 });
    const metadata = await readMetadata(store, OWNER, archive);
    expect(metadata?.status).toBe("stored");
    const trace = await getTrace(store, OWNER, archive, metadata?.head as string);
    expect(JSON.stringify(trace)).not.toContain(SECRET);
    expect(JSON.stringify(trace)).toContain("log in with ops / [redacted:secret]");
    expect(await listReviews(store, OWNER, archive)).toEqual([
      expect.objectContaining({
        n: 0,
        content_hash: metadata?.head,
        decision: "redact",
        policy: "default",
        findings: [expect.objectContaining({ category: "secret", action: "redact" })],
      }),
    ]);
    expect(s.requests.map((r) => r.api)).toEqual(["anthropic", "anthropic"]);
  });

  it("drops an assembled session that review drops, under the OTLP source", async () => {
    const s = server();
    const { publish, store, archive } = await bootOtlp(anthropic(s));
    expect(await publish("here is the CUSTOMER TABLE: ana, 41 rua", "ok")).toMatchObject({
      published: 1,
    });
    // A stub (F3.4): where the assembled session ends, no trace.
    const stub = await readMetadata(store, OWNER, archive);
    expect(stub).toMatchObject({ status: "stored", traces: [], normalized: { records: 3 } });
    expect(stub?.head).toBeUndefined();
    const { records } = await listRecords(store, "dropped", "console");
    expect(records).toHaveLength(1);
    expect(records[0]?.record).toMatchObject({
      reason: "review_drop",
      policy: "default",
      source_kind: "otlp",
      session_key: CONVERSATION,
    });

    // The next call extends the stub: the assembler publishes the whole session again, and only
    // what is new is reviewed and stored.
    const calls = s.requests.length;
    expect(await publish("now fix the build", "fixed", "00000000000000a2")).toMatchObject({
      published: 1,
    });
    expect(s.requests.length).toBe(calls + 1);
    const sent = JSON.stringify(s.requests.at(-1)?.body);
    expect(sent).toContain("now fix the build");
    expect(sent).not.toContain("CUSTOMER TABLE");
    const metadata = await readMetadata(store, OWNER, archive);
    expect(metadata?.traces).toEqual([
      expect.objectContaining({ continuation: expect.objectContaining({ from_record: 3 }) }),
    ]);
    const trace = await getTrace(store, OWNER, archive, metadata?.head as string);
    expect(JSON.stringify(trace?.records)).toContain("now fix the build");
    expect(JSON.stringify(trace)).not.toContain("CUSTOMER TABLE");
  });
});

describe("a dropped first envelope leaves a stub (F3.4, revised 15 Nov 2026)", () => {
  const BOB_TOKEN = "bob-token-0123456789";
  const DUMPED = META + user("here is the CUSTOMER TABLE: ana, 41 rua") + reply("ok");
  const NEXT = user("now fix the build") + reply("fixed it");
  const bytes = (text: string) => Buffer.byteLength(text);
  const RETRACT_SECRET = "machine-secret-0123456789";
  const retract_hash = createHash("sha256").update(RETRACT_SECRET).digest("hex");

  /** An instance with alice's and bob's tokens and a review policy, and its HTTP API. */
  async function bootStub(policy: string) {
    const booted = await bootInstance(
      `[filter]\nenabled = false\n[auth.tokens]\nalice = "${ALICE_TOKEN}"\nbob = "${BOB_TOKEN}"\n[[review.policies]]\n${policy}`,
    );
    cleanups.push(() => booted.cleanup());
    const db = booted.instance.localSessions("alice");
    const app = createApp(booted.instance);
    const call = async (
      method: string,
      path: string,
      options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
    ) => {
      const response = await app.fetch(
        new Request(`http://seshi.test${path}`, {
          method,
          headers: {
            authorization: `Bearer ${options.token ?? ALICE_TOKEN}`,
            ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
            ...options.headers,
          },
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        }),
      );
      const text = await response.text();
      // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the route answered
      return { status: response.status, body: (text ? JSON.parse(text) : null) as any };
    };
    const upload = (transcript: string, offset = 0) =>
      call("POST", "/v1/sessions", {
        body: { agent: "trajectory", session_id: "s1", transcript, offset, retract_hash },
      });
    return { ...booted, db, call, upload };
  }

  /** What the provider was sent from request `from` on, as text. */
  const sent = (s: FakeServer, from = 0) =>
    s.requests
      .slice(from)
      .map((r) => JSON.stringify(r.body))
      .join("\n");

  it("moves the upload past a drop, reviews the next append alone, and never the dropped part again", async () => {
    const s = server();
    const { upload, dir } = await bootStub(anthropic(s));
    const dropped = await upload(DUMPED);
    expect(dropped).toMatchObject({
      status: 200,
      body: { status: "dropped", records_total: 3, bytes_total: bytes(DUMPED) },
    });
    expect(s.requests).toHaveLength(1);
    expect(bucketText(dir)).not.toContain("CUSTOMER TABLE");
    expect(bucketText(dir)).not.toContain("acme-checkout");

    // The uploader's next piece is a chunk from the server's offset.
    const next = await upload(NEXT, dropped.body.bytes_total);
    expect(next).toMatchObject({ status: 201, body: { status: "stored", records_total: 5 } });
    expect(s.requests).toHaveLength(2);
    expect(sent(s, 1)).toContain("now fix the build");
    expect(sent(s, 1)).not.toContain("CUSTOMER TABLE");

    // A whole-log resend from 0 (after a 409, a moved transcript): only what is past what the
    // session holds is reviewed and stored.
    const grown = DUMPED + NEXT + user("and the tests") + reply("green");
    const resent = await upload(grown);
    expect(resent).toMatchObject({ status: 201, body: { status: "stored", records_total: 7 } });
    expect(s.requests).toHaveLength(3);
    expect(sent(s, 2)).toContain("and the tests");
    expect(sent(s, 2)).not.toContain("CUSTOMER TABLE");
    expect(sent(s, 2)).not.toContain("now fix the build");
    // The same log again: the recorded answer, and nothing reviewed.
    expect((await upload(grown)).body).toEqual(resent.body);
    expect(s.requests).toHaveLength(3);
    expect(bucketText(dir)).not.toContain("CUSTOMER TABLE");
  });

  it("does the same when review failed and on_failure = drop", async () => {
    let failing = true;
    const s = server({
      reply: (_request, schema, text) =>
        failing ? { status: 500 } : { answer: MODEL.answer(schema, text) },
    });
    const { upload, store, dir } = await bootStub(anthropic(s, "retries = 0\n"));
    const first = META + user("hello there") + reply("hi");
    const dropped = await upload(first);
    expect(dropped.body).toMatchObject({ status: "dropped", bytes_total: bytes(first) });
    const { records } = await listRecords(store, "dropped", "upload");
    expect(records[0]?.record).toMatchObject({ reason: "review_failed" });
    const stub = await readMetadata(store, "alice", archiveId("alice", "trajectory", "s1"));
    expect(stub).toMatchObject({ traces: [], normalized: { bytes: bytes(first) } });
    expect(stub?.head).toBeUndefined();

    failing = false;
    const calls = s.requests.length;
    const next = await upload(NEXT, dropped.body.bytes_total);
    expect(next.body).toMatchObject({ status: "stored", records_total: 5 });
    expect(sent(s, calls)).toContain("now fix the build");
    expect(sent(s, calls)).not.toContain("hello there");
    const resent = await upload(first + NEXT + user("more") + reply("ok"));
    expect(resent.body).toMatchObject({ status: "stored", records_total: 7 });
    expect(sent(s, calls)).not.toContain("hello there");
    expect(bucketText(dir)).not.toContain("hello there");
  });

  it("is not listed, served, searched or on another reader's change feed until it has a trace", async () => {
    const s = server();
    const { upload, call, db, instance } = await bootStub(anthropic(s));
    expect((await upload(DUMPED)).body.status).toBe("dropped");

    expect((await call("GET", "/v1/sessions")).body.sessions).toEqual([]);
    for (const path of ["", "/trace", "/export", "/reviews"]) {
      expect((await call("GET", `/v1/sessions/trajectory/s1${path}`)).status).toBe(404);
    }
    expect((await call("GET", "/v1/changes")).body.entries).toEqual([]);
    await instance.search?.catchUp();
    expect((await call("GET", "/v1/search?q=table")).body.results).toEqual([]);
    expect(await db.getSession("trajectory", "s1")).toBeNull();
    expect((await db.listSessions()).sessions).toEqual([]);
    // Its owner can set who will read it; another reader of the feed does not see that.
    expect(
      (await call("PATCH", "/v1/sessions/trajectory/s1", { body: { visibility: "org" } })).status,
    ).toBe(200);
    expect(
      (await call("GET", "/v1/changes?owner=alice", { token: BOB_TOKEN })).body.entries,
    ).toEqual([]);
    // Nobody else finds it to change or delete it.
    expect(
      (
        await call("PATCH", "/v1/sessions/trajectory/s1?owner=alice", {
          token: BOB_TOKEN,
          body: { visibility: "owner" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call("DELETE", "/v1/sessions/trajectory/s1?owner=alice", { token: BOB_TOKEN })).status,
    ).toBe(404);

    // Once the next append is stored, the session is a session like any other.
    await upload(NEXT, bytes(DUMPED));
    expect((await call("GET", "/v1/sessions")).body.sessions).toHaveLength(1);
    const trace = await call("GET", "/v1/sessions/trajectory/s1/trace");
    expect(trace.status).toBe(200);
    expect(JSON.stringify(trace.body)).not.toContain("CUSTOMER TABLE");
    await instance.search?.catchUp();
    expect((await call("GET", "/v1/search?q=build")).body.results).toHaveLength(1);
    expect((await call("GET", "/v1/search?q=table")).body.results).toEqual([]);
  });

  it("is retracted with the uploading machine's secret, after which nothing extends it", async () => {
    const s = server();
    const { upload, call, store } = await bootStub(anthropic(s));
    const dropped = await upload(DUMPED);
    const retract = (secret: string) =>
      call("DELETE", "/v1/sessions/trajectory/s1", { headers: { "x-seshi-retract": secret } });
    expect((await retract("not-the-secret")).status).toBe(403);
    expect(await retract(RETRACT_SECRET)).toMatchObject({ status: 200, body: { removed: 0 } });
    const gone = await readMetadata(store, "alice", archiveId("alice", "trajectory", "s1"));
    expect(gone).toMatchObject({ status: "redacted", traces: [] });
    expect(gone).not.toHaveProperty("normalized");
    const calls = s.requests.length;
    expect(await upload(NEXT, dropped.body.bytes_total)).toMatchObject({
      status: 422,
      body: { error: { code: "redacted" } },
    });
    expect((await upload(DUMPED + NEXT)).status).toBe(422);
    expect(s.requests).toHaveLength(calls);
    expect((await retract(RETRACT_SECRET)).status).toBe(410);
  });

  it("is deleted by its owner like any session", async () => {
    const s = server();
    const { upload, call, store } = await bootStub(anthropic(s));
    await upload(DUMPED);
    expect(await call("DELETE", "/v1/sessions/trajectory/s1")).toMatchObject({
      status: 200,
      body: { removed: 0 },
    });
    const gone = await readMetadata(store, "alice", archiveId("alice", "trajectory", "s1"));
    expect(gone?.status).toBe("redacted");
  });
});
