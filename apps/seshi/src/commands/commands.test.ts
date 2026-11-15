/** The commands this branch builds (workers, sync, reprocess, normalize, healthcheck) and the
 * F8.1 conventions every command shares: the full command list, `--json` and stable exit
 * codes. */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Connector, defineIntegration, type Integration } from "@seshi/kit";
import { ENVELOPE_SCHEMA, type Envelope } from "@seshi/model";
import { Pipeline, SpanStore } from "@seshi/pipeline";
import {
  archiveId,
  ensureLayout,
  FsStore,
  readCheckpoint,
  readMetadata,
  readPending,
  writeCheckpoint,
  writeDropped,
  writeFailed,
  writeHeartbeat,
} from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../cli/exit";
import { buildFormats, INTEGRATIONS } from "../integrations";
import { main } from "../main";
import { healthUrl, listenSetting } from "./healthcheck";
import { COMMANDS } from "./index";

let dir: string;
let bucket: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "seshi-commands-"));
  bucket = `file://${join(dir, "bucket")}`;
  // A bucket a server has used: read-only commands refuse one with no layout marker.
  await ensureLayout(new FsStore(bucket), { createdBy: "test" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SOURCES = `
[[sources]]
id = "dd"
type = "datadog"
api_key = "k"
app_key = "a"

[[sources]]
id = "claude"
type = "otlp"
`;

/** One run submits a payload no adapter reads (recorded as a failure) and moves a page. */
const connector: Connector = {
  kind: "datadog",
  async run(ctx) {
    const page = ((ctx.checkpoint.read()?.page as number | undefined) ?? 0) + 1;
    const envelope: Envelope = {
      schema: "seshi/envelope/1",
      source: "datadog",
      source_id: ctx.source.id,
      format: "trajectory",
      session_key: `s${page}`,
      payload: { kind: "log", encoding: "jsonl", text: "not json\n", offset: 0 },
      caller: { kind: "service", principal: `svc:${ctx.source.id}` },
      owner: `svc:${ctx.source.id}`,
      owner_basis: "service",
      idempotency_key: `dd:${page}`,
      received_at: ctx.now().toISOString(),
    };
    await ctx.submit(envelope);
    await ctx.checkpoint.write({ page, from: "2026-11-14T00:00:00.000Z" });
    return undefined;
  },
  rewind: (cursor, since) => ({ ...cursor, from: since.toISOString() }),
};

/** The binary's integrations without its own Datadog poller, so a fake one can stand in. */
const NO_DATADOG_POLLER: Integration[] = INTEGRATIONS.map((integration) => ({
  ...integration,
  connectors: (integration.connectors ?? []).filter((c) => c.kind !== "datadog"),
}));

const WITH_CONNECTOR: Integration[] = [
  ...NO_DATADOG_POLLER,
  defineIntegration({ name: "fake-vendor", connectors: [connector] }),
];

async function seshi(
  argv: string[],
  options: { toml?: string; integrations?: Integration[]; stdin?: string } = {},
) {
  const file = join(dir, "seshi.toml");
  writeFileSync(file, `[store]\nurl = "${bucket}"\n${options.toml ?? ""}`, { mode: 0o600 });
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    env: { SESHI_CONFIG: file },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    integrations: async () => options.integrations ?? INTEGRATIONS,
    ...(options.stdin !== undefined ? { stdin: async () => options.stdin as string } : {}),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("the command groups (F8.1)", () => {
  it("registers every one, each in its own file", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(
      [
        "admin",
        "capture",
        "config",
        "daemon",
        "healthcheck",
        "hook",
        "login",
        "logout",
        "normalize",
        "redact",
        "reprocess",
        "review",
        "search",
        "serve",
        "sessions",
        "statusline",
        "sync",
        "tokens",
        "upload",
        "whoami",
        "workers",
      ].sort(),
    );
  });

  it("keeps the exit codes stable", () => {
    expect(EXIT).toEqual({
      ok: 0,
      failure: 1,
      usage: 2,
      config: 3,
      notFound: 4,
      auth: 5,
      conflict: 6,
      unavailable: 7,
      attention: 8,
      notImplemented: 9,
    });
  });
});

describe("seshi workers status", () => {
  it("shows a deployment no worker has run against, as text and JSON", async () => {
    const text = await seshi(["workers", "status"], { toml: SOURCES });
    expect(text.code).toBe(EXIT.ok);
    expect(text.out).toContain("worker: none has run against this bucket");
    expect(text.out).toContain("heartbeat");
    expect(text.out).toMatch(/claude\s+otlp, pushed to POST \/otlp\/v1\/traces/);
    const json = await seshi(["workers", "status", "--json"], { toml: SOURCES });
    const status = JSON.parse(json.out);
    expect(status.worker.state).toBe("never");
    // The datadog source is polled by the binary's own connector (F5).
    expect(status.jobs.map((j: { name: string }) => j.name)).toEqual([
      "heartbeat",
      "retention",
      "source:dd",
      "assembler",
    ]);
  });

  it("asks for attention when the worker stopped", async () => {
    const store = new FsStore(bucket);
    await writeHeartbeat(store, {
      instance: "w-1",
      version: "0.9.0",
      roles: ["worker"],
      started_at: "2026-01-01T00:00:00.000Z",
      at: "2026-01-01T00:00:00.000Z",
    });
    const result = await seshi(["workers", "status"]);
    expect(result.code).toBe(EXIT.attention);
    expect(result.out).toContain("worker: stopped, w-1");
    expect(result.out).toMatch(/warning: the worker \(w-1\) last wrote its heartbeat/);
  });

  it("refuses a bucket no server has used, and does not claim it", async () => {
    rmSync(join(dir, "bucket"), { recursive: true, force: true });
    for (const argv of [
      ["workers", "status"],
      ["sync", "status"],
      ["sync", "failed", "upload"],
      ["reprocess", "--source", "dd", "--dry-run"],
    ]) {
      const result = await seshi(argv, { toml: SOURCES, integrations: WITH_CONNECTOR });
      expect(result.code).toBe(EXIT.config);
      expect(result.err).toContain("no seshi deployment at");
    }
    expect(existsSync(join(dir, "bucket"))).toBe(false);
  });

  it("refuses a bad config with exit 3 and bad usage with exit 2", async () => {
    expect((await seshi(["workers", "status"], { toml: "[nope]\n" })).code).toBe(EXIT.config);
    expect((await seshi(["workers"])).code).toBe(EXIT.usage);
    expect((await seshi(["workers", "status", "extra"])).code).toBe(EXIT.usage);
    const json = await seshi(["workers", "status", "--json"], { toml: "[nope]\n" });
    expect(JSON.parse(json.err)).toMatchObject({ error: { code: "config" } });
  });
});

describe("seshi sync", () => {
  it("runs a source once and saves its checkpoint", async () => {
    const run = await seshi(["sync", "run", "dd", "--json"], {
      toml: SOURCES,
      integrations: WITH_CONNECTOR,
    });
    expect(run.code).toBe(EXIT.ok);
    expect(JSON.parse(run.out)).toMatchObject({
      source: "dd",
      outcome: "ok",
      submitted: 1,
      outcomes: { failed: 1 },
      checkpoint_saved: true,
    });
    const text = await seshi(["sync", "run", "dd"], {
      toml: SOURCES,
      integrations: WITH_CONNECTOR,
    });
    expect(text.out).toContain(
      "source dd: ok, 1 envelope(s) submitted (1 failed), checkpoint saved",
    );
    expect((await readCheckpoint(new FsStore(bucket), "dd"))?.value.cursor.page).toBe(2);
  });

  it("says why a source cannot run", async () => {
    const unknown = await seshi(["sync", "run", "nope"], { toml: SOURCES });
    expect(unknown.code).toBe(EXIT.notFound);
    expect(unknown.err).toContain("no source 'nope'");
    const pushed = await seshi(["sync", "run", "claude"], { toml: SOURCES });
    expect(pushed.code).toBe(EXIT.failure);
    expect(pushed.err).toContain("pushed to POST /otlp/v1/traces");
    const noConnector = await seshi(["sync", "run", "dd"], {
      toml: SOURCES,
      integrations: NO_DATADOG_POLLER,
    });
    expect(noConnector.err).toContain("no connector for type 'datadog'");
    expect((await seshi(["sync", "run"], { toml: SOURCES })).code).toBe(EXIT.usage);
    expect((await seshi(["sync", "bogus"])).code).toBe(EXIT.usage);
  });

  it("shows status, failures and drops", async () => {
    const store = new FsStore(bucket);
    await writeCheckpoint(store, "dd", { page: 4 }, null);
    await writeFailed(store, {
      at: "2026-11-14T09:00:00.000Z",
      source: "dd",
      session_key: "s1",
      idempotency_key: "k1",
      code: "invalid",
      message: "unknown role",
    });
    await writeDropped(store, {
      at: "2026-11-14T09:00:00.000Z",
      source: "upload",
      session_key: "s2",
      idempotency_key: "k2",
      reason: "review_drop",
      policy: "default",
      policy_hash: "h",
      decision_model: "m",
    });
    const status = await seshi(["sync", "status", "--json"], { toml: SOURCES });
    const sources = JSON.parse(status.out).sources;
    expect(sources.map((s: { id: string }) => s.id)).toEqual(["dd", "claude", "upload"]);
    expect(sources[0]).toMatchObject({ checkpoint: { cursor: { page: 4 } }, failed: 1 });
    expect(sources[2]).toMatchObject({ dropped: 1 });
    const one = await seshi(["sync", "status", "dd", "--days", "3"], { toml: SOURCES });
    expect(one.out).toContain("last 3 day(s):");
    expect((await seshi(["sync", "status", "--days", "0"], { toml: SOURCES })).code).toBe(
      EXIT.usage,
    );

    const failed = await seshi(["sync", "failed", "dd"], { toml: SOURCES });
    expect(failed.out).toBe("2026-11-14T09:00:00.000Z  s1  invalid: unknown role");
    const dropped = await seshi(["sync", "dropped", "upload", "--json"], { toml: SOURCES });
    expect(JSON.parse(dropped.out).records[0].record).toMatchObject({ reason: "review_drop" });
    const none = await seshi(["sync", "failed", "dd", "--since", "2026-11-15"], { toml: SOURCES });
    expect(none.out).toBe("no failed records for dd");
    expect((await seshi(["sync", "failed", "nope"], { toml: SOURCES })).code).toBe(EXIT.notFound);
    // A source taken out of [[sources]]: status lists its records, and they can be read.
    await writeFailed(store, {
      at: "2026-11-14T10:00:00.000Z",
      source: "retired",
      session_key: "s3",
      idempotency_key: "k3",
      code: "invalid",
      message: "gone",
    });
    const orphan = await seshi(["sync", "failed", "retired"], { toml: SOURCES });
    expect(orphan.code).toBe(EXIT.ok);
    expect(orphan.out).toContain("s3  invalid: gone");
    expect(
      (await seshi(["sync", "failed", "dd", "--since", "whenever"], { toml: SOURCES })).code,
    ).toBe(EXIT.usage);
  });
});

describe("seshi sync assemble (X7.1)", () => {
  const OWNER = "svc:claude";
  // The one-span sessions below are shorter than the filter's default min_chars.
  const UNFILTERED = `${SOURCES}\n[filter]\nenabled = false\n`;
  const messages = (role: string, text: string) =>
    JSON.stringify([{ role, parts: [{ type: "text", content: text }] }]);
  const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });

  /** A span batch for one Claude Platform session, stored as the api role stores it (span
   * records and a pending marker), `agoMs` before now. */
  async function storeSpans(session: string, agoMs: number) {
    const at = new Date(Date.now() - agoMs);
    const now = () => at;
    const store = new FsStore(bucket);
    const pipeline = new Pipeline({
      store,
      formats: buildFormats(INTEGRATIONS),
      now,
      assembler: new SpanStore({ store, now }),
    });
    const ns = (BigInt(at.getTime()) * 1_000_000n).toString();
    const envelope: Envelope = {
      schema: ENVELOPE_SCHEMA,
      source: "otlp",
      source_id: "claude",
      format: "otlp-genai",
      session_key: session,
      payload: {
        kind: "spans",
        spans: [
          {
            traceId: "ab".repeat(16),
            spanId: "0000000000000001",
            name: "chat m",
            startTimeUnixNano: ns,
            endTimeUnixNano: ns,
            attributes: [
              attr("gen_ai.operation.name", "chat"),
              attr("gen_ai.conversation.id", session),
              attr("gen_ai.input.messages", messages("user", "please summarise the release notes")),
              attr(
                "gen_ai.output.messages",
                messages("assistant", "the release adds sync assemble"),
              ),
            ],
          },
        ],
      },
      caller: { kind: "service", principal: OWNER, credential_id: "tok1" },
      owner: OWNER,
      owner_basis: "service",
      idempotency_key: `batch-${session}`,
      received_at: at.toISOString(),
    };
    expect(await pipeline.submit(envelope, { onFailure: "throw" })).toMatchObject({
      status: "accepted",
    });
    return archiveId(OWNER, "otlp-genai", session);
  }

  it("publishes the span sessions that went quiet, with no worker running", async () => {
    const quiet = await storeSpans("sesn_quiet", 60 * 60_000);
    const fresh = await storeSpans("sesn_fresh", 0);
    const store = new FsStore(bucket);

    const run = await seshi(["sync", "assemble", "--json"], { toml: UNFILTERED });
    expect(run.code).toBe(EXIT.ok);
    expect(JSON.parse(run.out)).toMatchObject({
      published: 1,
      waiting: 1,
      errors: 0,
      outcomes: { stored: 1 },
      more: false,
    });
    expect(await readMetadata(store, OWNER, quiet)).toMatchObject({ status: "stored" });
    expect(await readPending(store, quiet)).toBeNull();
    // Still inside its quiet period: kept for a later run.
    expect(await readMetadata(store, OWNER, fresh)).toBeNull();
    expect(await readPending(store, fresh)).not.toBeNull();

    const again = await seshi(["sync", "assemble"], { toml: UNFILTERED });
    expect(again.code).toBe(EXIT.ok);
    expect(again.out).toContain("assembler: 0 session(s) published, 1 waiting for quiet");
  });

  it("takes no source id and runs only where the server config is", async () => {
    expect((await seshi(["sync", "assemble", "claude"], { toml: SOURCES })).code).toBe(EXIT.usage);
    expect((await seshi(["sync", "assemble", "--force"], { toml: SOURCES })).code).toBe(EXIT.usage);
  });
});

describe("seshi sync prune (X7.1)", () => {
  it("removes drop and failure records past retention, with no worker running", async () => {
    const store = new FsStore(bucket);
    const failed = (at: string, key: string) =>
      writeFailed(store, {
        at,
        source: "dd",
        session_key: key,
        idempotency_key: key,
        code: "invalid",
        message: "unknown role",
      });
    const dropped = (at: string, key: string) =>
      writeDropped(store, {
        at,
        source: "upload",
        session_key: key,
        idempotency_key: key,
        reason: "review_drop",
        policy: "default",
        policy_hash: "h",
        decision_model: "m",
      });
    const now = new Date().toISOString();
    await failed("2020-01-01T00:00:00.000Z", "old-f");
    await failed(now, "new-f");
    await dropped("2020-01-01T00:00:00.000Z", "old-d");
    await dropped(now, "new-d");

    const run = await seshi(["sync", "prune", "--json"], { toml: SOURCES });
    expect(run.code).toBe(EXIT.ok);
    expect(JSON.parse(run.out)).toMatchObject({ dropped: 1, failed: 1 });
    const left = await seshi(["sync", "failed", "dd", "--json"], { toml: SOURCES });
    expect(JSON.stringify(JSON.parse(left.out))).toContain("new-f");
    expect(JSON.stringify(JSON.parse(left.out))).not.toContain("old-f");

    const again = await seshi(["sync", "prune"], { toml: SOURCES });
    expect(again.code).toBe(EXIT.ok);
    expect(again.out).toContain("retention: 0 drop record(s), 0 failure record(s)");
  });

  it("takes no source id", async () => {
    expect((await seshi(["sync", "prune", "dd"], { toml: SOURCES })).code).toBe(EXIT.usage);
  });
});

describe("seshi reprocess (X4.9)", () => {
  it("rewinds a source's checkpoint, to a time or to the start, and can run it at once", async () => {
    const store = new FsStore(bucket);
    await writeCheckpoint(store, "dd", { page: 4, from: "2026-11-14T00:00:00.000Z" }, null);
    const dry = await seshi(
      ["reprocess", "--source", "dd", "--since", "2026-11-01", "--dry-run", "--json"],
      { toml: SOURCES, integrations: WITH_CONNECTOR },
    );
    expect(dry.code).toBe(EXIT.ok);
    expect(JSON.parse(dry.out).rewind).toMatchObject({
      applied: false,
      after: { page: 4, from: "2026-11-01T00:00:00.000Z" },
    });
    expect((await readCheckpoint(store, "dd"))?.value.cursor.from).toBe("2026-11-14T00:00:00.000Z");

    const since = await seshi(["reprocess", "--source", "dd", "--since", "2026-11-01"], {
      toml: SOURCES,
      integrations: WITH_CONNECTOR,
    });
    expect(since.out).toContain("rewound source dd to 2026-11-01T00:00:00.000Z");
    expect((await readCheckpoint(store, "dd"))?.value.cursor.from).toBe("2026-11-01T00:00:00.000Z");

    const start = await seshi(["reprocess", "--source", "dd", "--run"], {
      toml: SOURCES,
      integrations: WITH_CONNECTOR,
    });
    expect(start.code).toBe(EXIT.ok);
    expect(start.out).toContain("ran once: ok, 1 envelope(s) submitted");
    // Rewound to the start, then one run: page 1 again.
    expect((await readCheckpoint(store, "dd"))?.value.cursor.page).toBe(1);
  });

  it("refuses uploads, unknown sources and bad usage", async () => {
    const upload = await seshi(["reprocess", "--source", "upload"], { toml: SOURCES });
    expect(upload.code).toBe(EXIT.failure);
    expect(upload.err).toContain("capture uploader");
    expect((await seshi(["reprocess", "--source", "nope"], { toml: SOURCES })).code).toBe(
      EXIT.notFound,
    );
    expect((await seshi(["reprocess"])).code).toBe(EXIT.usage);
    expect((await seshi(["reprocess", "--source", "dd", "--since", "never"])).code).toBe(
      EXIT.usage,
    );
    expect((await seshi(["reprocess", "--source", "dd", "--dry-run", "--run"])).code).toBe(
      EXIT.usage,
    );
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const ahead = await seshi(["reprocess", "--source", "dd", "--since", future], {
      toml: SOURCES,
    });
    expect(ahead.code).toBe(EXIT.usage);
    expect(ahead.err).toContain("is in the future");
  });

  it("never moves a Datadog checkpoint forward past spans it has not read", async () => {
    const store = new FsStore(bucket);
    const until = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const since = new Date(Date.now() - 86_400_000).toISOString();
    await writeCheckpoint(store, "dd", { v: 1, until }, null);
    const later = await seshi(["reprocess", "--source", "dd", "--since", since], {
      toml: SOURCES,
    });
    expect(later.code).toBe(EXIT.ok);
    expect(later.out).toContain(`checkpoint unchanged: the source has read nothing since ${since}`);
    expect((await readCheckpoint(store, "dd"))?.value.cursor).toEqual({ v: 1, until });
  });
});

describe("seshi normalize (X3.10)", () => {
  /** A two-turn Claude Code transcript. */
  const TRANSCRIPT = `${[
    {
      type: "user",
      uuid: "u1",
      timestamp: "2026-09-01T00:00:00.000Z",
      sessionId: "s",
      cwd: "/work",
      message: { role: "user", content: "How does the auth flow work?" },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      timestamp: "2026-09-01T00:00:05.000Z",
      sessionId: "s",
      message: {
        role: "assistant",
        model: "claude-x",
        content: [{ type: "text", text: "It signs a token." }],
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n")}\n`;
  let fixture: string;
  beforeEach(() => {
    fixture = join(dir, "session.jsonl");
    writeFileSync(fixture, TRANSCRIPT);
  });

  it("prints canonical records, one per line, detecting the format", async () => {
    const result = await seshi(["normalize", fixture]);
    expect(result.code).toBe(EXIT.ok);
    const records = result.out.split("\n").map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({ role: "meta" });
    expect(records.length).toBeGreaterThan(1);
  });

  it("reads standard input, names the format with --agent, and prints one document with --json", async () => {
    const result = await seshi(["normalize", "--agent", "claude-code", "--json", "-"], {
      stdin: TRANSCRIPT,
    });
    const doc = JSON.parse(result.out);
    expect(doc.agent).toBe("claude-code");
    expect(doc.records[0]).toMatchObject({ role: "meta" });
  });

  it("redacts what the pipeline would", async () => {
    const line = JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-09-01T00:00:00.000Z",
      sessionId: "s",
      message: { role: "user", content: "my key is AKIAIOSFODNN7EXAMPLE ok" },
    });
    const result = await seshi(["normalize", "--agent", "claude-code", "-"], {
      stdin: `${line}\n`,
    });
    expect(result.out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("refuses a missing file, an unknown format and one it cannot tell", async () => {
    expect((await seshi(["normalize", join(dir, "missing.jsonl")])).code).toBe(EXIT.notFound);
    expect((await seshi(["normalize", "--agent", "nope", fixture])).code).toBe(EXIT.usage);
    const unknown = await seshi(["normalize", "-"], { stdin: "hello\n" });
    expect(unknown.code).toBe(EXIT.failure);
    expect(unknown.err).toContain("--agent");
    expect((await seshi(["normalize", "a", "b"])).code).toBe(EXIT.usage);
  });
});

describe("seshi healthcheck", () => {
  it("is ok when /healthz answers ok, and unavailable otherwise", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (r) =>
        new URL(r.url).pathname === "/healthz"
          ? Response.json({ ok: true })
          : new Response("no", { status: 500 }),
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect((await seshi(["healthcheck", "--url", `${base}/healthz`])).code).toBe(EXIT.ok);
      expect((await seshi(["healthcheck", "--url", `${base}/other`])).code).toBe(EXIT.unavailable);
    } finally {
      server.stop(true);
    }
    expect((await seshi(["healthcheck", "--url", "http://127.0.0.1:1/healthz"])).code).toBe(
      EXIT.unavailable,
    );
    expect((await seshi(["healthcheck", "--bogus"])).code).toBe(EXIT.usage);
  });

  it("asks where serve listens: env, else the TOML file serve reads, else :7200", () => {
    const files: Record<string, string> = {
      "/etc/seshi/seshi.toml": '[server]\nlisten = "0.0.0.0:8080"\n',
      "/custom.toml": '[server]\nlisten = "10.0.0.5:9000"\n[store]\nurl = "file:///x"\n',
      "/broken.toml": "not = [toml",
    };
    const read = (path: string) => files[path];
    expect(listenSetting({ SESHI_SERVER__LISTEN: ":7300" }, undefined, read)).toBe(":7300");
    expect(listenSetting({}, undefined, read)).toBe("0.0.0.0:8080");
    expect(listenSetting({ SESHI_CONFIG: "/custom.toml" }, undefined, read)).toBe("10.0.0.5:9000");
    expect(listenSetting({}, "/custom.toml", read)).toBe("10.0.0.5:9000");
    expect(listenSetting({}, "/broken.toml", read)).toBe(":7200");
    expect(listenSetting({}, undefined, () => undefined)).toBe(":7200");

    expect(healthUrl(":7200")).toBe("http://127.0.0.1:7200/healthz");
    expect(healthUrl("0.0.0.0:8080")).toBe("http://127.0.0.1:8080/healthz");
    expect(healthUrl("[::]:8080")).toBe("http://127.0.0.1:8080/healthz");
    expect(healthUrl("10.0.0.5:9000")).toBe("http://10.0.0.5:9000/healthz");
    expect(healthUrl("[::1]:9000")).toBe("http://[::1]:9000/healthz");
  });
});
