/** `seshi explore`'s server with every loader faked: the token, Host, Origin and method checks;
 * each endpoint; the records alignment (the review-dropped prefix, a pause's stop, the end of the
 * server's log, a stub, a mismatch); the timeline; and that no response ever carries the
 * retraction secret or a transcript line before local redaction. */

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { CaptureState, SessionState } from "@seshi/capture";
import type { NormalizedRecord, SessionMetadata, StoredTrace } from "@seshi/model";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DoctorDeps, ServerView } from "../doctor/deps";
import { ExploreApi, failuresFirst } from "./api";
import { type Assets, buildAssets } from "./assets";
import { fold, splitMarkers } from "./page/text";
import { alignRecords, markersIn } from "./records";
import {
  CSP,
  type ExploreServer,
  exploreHandler,
  newToken,
  sameToken,
  startExploreServer,
  TOKEN_HEADER,
  withToken,
} from "./server";
import { splitLogLine } from "./timeline";
import type { RecordsView, SessionDetail, SessionList } from "./types";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const SID = "s1";
const PATH = "/home/me/.claude/projects/-app/s1.jsonl";
/** The retraction secret: never in a response. */
const SECRET = "machine-retraction-secret-0123456789";
const HASH = createHash("sha256").update(SECRET).digest("hex");
/** A token the fake rules redact, split so no scanner reads it here. */
const PLANTED = `${"gh"}p_${"abcdefghijklmnopqrstuvwx0123456789"}`;
const MARK = "[redacted:github-token]";
const LINES = ["meta", "hello", `push with ${PLANTED}`, "fourth", "fifth, not sent"];
const TEXT = `${LINES.join("\n")}\n`;
const SIZE = Buffer.byteLength(TEXT);
/** Where the server's log ends: after the fourth line. */
const SENT = Buffer.byteLength(`${LINES.slice(0, 4).join("\n")}\n`);
const T1 = "a".repeat(64);
const T2 = "b".repeat(64);

const toRecords = (text: string): NormalizedRecord[] =>
  text
    .split("\n")
    .filter(Boolean)
    .map(
      (line, i) =>
        (i === 0
          ? { role: "meta", source: "claude-code" }
          : { role: "user", content: line }) as NormalizedRecord,
    );
const redactText = (s: string) => s.split(PLANTED).join(MARK);
const redactRecords = (records: readonly NormalizedRecord[]) =>
  records.map((r) => JSON.parse(redactText(JSON.stringify(r))) as NormalizedRecord);
const STORED = redactRecords(toRecords(TEXT.slice(0, SENT)));

function metadata(over: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    schema: "seshi/metadata/1",
    owner: "me",
    archive_id: "c".repeat(64),
    session_id: SID,
    agent: "claude-code",
    status: "stored",
    head: T2,
    traces: [
      { content_hash: T1, created_at: NOW.toISOString(), records: 3, rule_set: "rs1" },
      {
        content_hash: T2,
        created_at: NOW.toISOString(),
        records: 2,
        rule_set: "rs1",
        continuation: { from_record: 3, prefix_sha256: "d".repeat(64) },
      },
    ],
    normalized: { bytes: SENT, records: 4, prefix_sha256: "e".repeat(64), hash_state: "x" },
    writer: { kind: "person", principal: "me" },
    owner_basis: "verified",
    visibility: "org",
    redaction: { rule_set: "rs1", counts: {} },
    normalizer: { name: "seshi", version: "0", format_version: "2" },
    retract_hash: HASH,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...over,
  } as SessionMetadata;
}

function entry(over: Partial<SessionState> = {}): SessionState {
  return {
    agent: "claude-code",
    session_id: SID,
    path: PATH,
    cwd: "/home/me/app",
    first_seen: "2026-11-15T11:00:00.000Z",
    last_seen: "2026-11-15T11:30:00.000Z",
    secret: SECRET,
    sent: true,
    stored: true,
    file_offset: SENT,
    server_offset: SENT,
    sent_path: PATH,
    aligned: true,
    uploaded_at: "2026-11-15T11:30:01.000Z",
    last_status: "stored",
    ...over,
  };
}

interface Fake {
  entry: SessionState;
  meta: SessionMetadata | null;
  traces: Record<string, NormalizedRecord[]>;
  getTraceCalls: number;
}

function fake(over: Partial<Omit<Fake, "getTraceCalls">> = {}): Fake {
  return {
    entry: entry(),
    meta: metadata(),
    traces: { [T1]: STORED.slice(0, 3), [T2]: [STORED[0], STORED[3]] as NormalizedRecord[] },
    getTraceCalls: 0,
    ...over,
  };
}

function deps(f: Fake, over: Partial<DoctorDeps> = {}): DoctorDeps {
  const server: ServerView = {
    mode: "server",
    where: "https://seshi.test",
    getSession: async () => f.meta,
    getTrace: async (_agent, _id, hash) => {
      f.getTraceCalls++;
      const records = f.traces[hash];
      return records ? ({ content_hash: hash, records } as unknown as StoredTrace) : null;
    },
    reviews: async () => [],
    changes: async () => [],
    search: async () => ({ results: [], index: {} }) as never,
  };
  const state = (): CaptureState =>
    ({
      schema: "seshi/capture-state/1",
      agents: {},
      sessions: { [`claude-code:${SID}`]: f.entry },
      uploader: {},
    }) as unknown as CaptureState;
  return {
    now: () => NOW,
    state,
    judge: () => ({ capture: true, level: "global", reason: "capture is on" }),
    agent: (name) =>
      name === "claude-code"
        ? { name, format: "claude-code", encoding: "jsonl", chunkable: true, identify: () => SID }
        : undefined,
    files: {
      stat: (path) => (path === PATH ? { size: SIZE, mtimeMs: NOW.getTime() } : null),
      read: (_path, end) => Buffer.from(TEXT).subarray(0, end).toString("utf8"),
    },
    spool: () => [],
    log: () => [
      `2026-11-15T11:30:00.500Z uploader: sent ${SID}`,
      "2026-11-15T11:29:00.000Z uploader: unrelated",
    ],
    uploaderRunning: () => false,
    server,
    normalizer: {
      records: (_format, text) => toRecords(text),
      version: () => "2",
      stale: (_format, built) => built !== "2",
    },
    redaction: {
      rule_set: "rs1",
      origin: "the fake rules",
      // As the uploader pre-redacts before sending.
      transcript: (text) => redactText(text),
      records: (records) => redactRecords(records),
      residue: () => [],
    },
    ...over,
  };
}

const ASSETS: Assets = {
  index: '<html><head><script type="module" src="/chunk-1.js"></script></head></html>',
  files: new Map([
    ["/chunk-1.js", { body: new TextEncoder().encode("1"), type: "text/javascript" }],
  ]),
};
const TOKEN = "t".repeat(43);
const PORT = 4321;
const HOST = `127.0.0.1:${PORT}`;

function handler(api: ConstructorParameters<typeof ExploreApi>[0] | ExploreApi = deps(fake())) {
  const real = api instanceof ExploreApi ? api : new ExploreApi(api, { sinceMs: 86_400_000 });
  return exploreHandler({ api: real, assets: ASSETS, token: TOKEN }, () => PORT);
}

function request(
  path: string,
  init: { host?: string; token?: string; method?: string; origin?: string } = {},
) {
  const headers: Record<string, string> = { host: init.host ?? HOST };
  if (init.token !== undefined) headers[TOKEN_HEADER] = init.token;
  if (init.origin !== undefined) headers.origin = init.origin;
  return new Request(`http://${HOST}${path}`, { method: init.method ?? "GET", headers });
}

describe("the token and Host checks", () => {
  const serve = handler();

  it("refuses a request whose Host is not 127.0.0.1 or localhost on this port (403)", async () => {
    for (const host of ["evil.example:4321", "127.0.0.1:9999", "attacker.localhost:4321"]) {
      const res = await serve(request(`/?token=${TOKEN}`, { host }));
      expect(res.status, host).toBe(403);
    }
    expect((await serve(request(`/?token=${TOKEN}`, { host: `localhost:${PORT}` }))).status).toBe(
      200,
    );
  });

  it("refuses a cross-origin request (403)", async () => {
    const res = await serve(
      request("/api/sessions", { token: TOKEN, origin: "http://evil.example" }),
    );
    expect(res.status).toBe(403);
    const same = await serve(request("/api/sessions", { token: TOKEN, origin: `http://${HOST}` }));
    expect(same.status).toBe(200);
  });

  it("answers GET only (405)", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD"]) {
      const res = await serve(request(`/api/sessions?token=${TOKEN}`, { method, token: TOKEN }));
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    }
  });

  it("asks for the token on the page, its files and the API (401)", async () => {
    expect((await serve(request("/"))).status).toBe(401);
    expect((await serve(request("/?token=wrong"))).status).toBe(401);
    expect((await serve(request("/chunk-1.js"))).status).toBe(401);
    expect((await serve(request("/api/sessions"))).status).toBe(401);
    expect((await serve(request("/api/sessions", { token: "wrong" }))).status).toBe(401);
    // The API takes the token only as a header, never in the query string.
    expect((await serve(request(`/api/sessions?token=${TOKEN}`))).status).toBe(401);
    expect((await serve(request(`/chunk-1.js?token=${TOKEN}`))).status).toBe(200);
  });

  it("serves the page with each file it links carrying the token, under a strict CSP", async () => {
    const res = await serve(request(`/?token=${TOKEN}`));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`src="/chunk-1.js?token=${TOKEN}"`);
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(CSP).toContain("default-src 'self'");
    expect(CSP).not.toContain("unsafe-inline");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    for (const [name] of res.headers) expect(name).not.toMatch(/^access-control-/);
  });

  it("compares tokens in constant time and makes new ones at random", () => {
    expect(sameToken(TOKEN, TOKEN)).toBe(true);
    expect(sameToken(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(sameToken(null, TOKEN)).toBe(false);
    expect(sameToken("", TOKEN)).toBe(false);
    const a = newToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(a);
    expect(withToken('<a href="/x.css"></a><a href="//cdn/x"></a><a href="#/"></a>', "T")).toBe(
      '<a href="/x.css?token=T"></a><a href="//cdn/x"></a><a href="#/"></a>',
    );
  });
});

describe("the API", () => {
  it("lists the sessions seen within --since cheaply, then checks them in the background", async () => {
    const f = fake();
    const api = new ExploreApi(deps(f), { sinceMs: 86_400_000 });
    const list = api.list();
    // Synchronous, from the state file and decide alone: no trace was fetched for it.
    expect(f.getTraceCalls).toBe(0);
    expect(list.sessions).toEqual([
      expect.objectContaining({
        agent: "claude-code",
        session_id: SID,
        folder: "/home/me/app",
        decision: { capture: true, glyph: "◉", level: "global", reason: "capture is on" },
        last_status: "stored",
        worst: "pending",
      }),
    ]);
    expect(list.pending).toBe(1);
    expect(list.server).toEqual({ mode: "server", where: "https://seshi.test" });
    await api.settled();
    const after = api.list();
    expect(after.pending).toBe(0);
    expect(after.sessions[0]?.worst).not.toBe("pending");
    expect(after.sessions[0]?.checked_at).toBe(NOW.toISOString());
  });

  it("leaves out sessions last seen before --since", () => {
    const f = fake({
      entry: entry({ first_seen: "2026-11-01T00:00:00.000Z", last_seen: undefined }),
    });
    expect(new ExploreApi(deps(f), { sinceMs: 86_400_000 }).list().sessions).toEqual([]);
  });

  it("answers one session: evidence without records, checks failures first, a timeline", async () => {
    const api = new ExploreApi(deps(fake()), { sinceMs: 86_400_000 });
    const d = (await api.detail("claude-code", SID)) as SessionDetail;
    expect(d.evidence.session_id).toBe(SID);
    expect(d.evidence.local?.secret).toEqual({ present: true, sha256: HASH });
    expect(d.evidence.server.traces.map((t) => t.records)).toEqual([undefined, undefined]);
    expect(d.glyph).toBe("◉");
    const severity = { fail: 3, warn: 2, ok: 1, skip: 0 };
    const order = d.checks.map((c) => severity[c.status]);
    expect(order).toEqual([...order].sort((a, b) => b - a));
    expect(d.timeline.map((e) => e.at)).toEqual([...d.timeline.map((e) => e.at)].sort());
    expect(d.timeline.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["seen", "log", "upload"]),
    );
    expect(await api.detail("claude-code", "nobody")).toBeUndefined();
  });

  it("aligns local (redacted) and stored records by index, marking what was not sent", async () => {
    const api = new ExploreApi(deps(fake()), { sinceMs: 86_400_000 });
    const view = (await api.records("claude-code", SID)) as RecordsView;
    expect(view.total).toBe(5);
    expect(view.rows.map((r) => r.state)).toEqual(["same", "same", "same", "same", "unsent"]);
    expect(view.marks).toEqual({ sent_until: 4, stub: false });
    expect(view.rows[2]?.local).toEqual({ role: "user", content: `push with ${MARK}` });
    expect(view.rows[2]?.markers).toEqual({ "github-token": 1 });
    expect(view.rows[3]?.trace).toBe(1);
    expect(view.pipeline).toMatchObject({
      transcript: { bytes: SIZE, sent_bytes: SENT, server_offset: SENT },
      records: { count: 5 },
      redacted: { records: 1, markers: { "github-token": 1 }, withheld: 0, rule_set: "rs1" },
      sent: { records: 4, last_status: "stored" },
      stored: { records: 4, traces: 2, stub: false, status: "stored" },
    });
    const paged = (await api.records("claude-code", SID, { offset: 1, limit: 2 })) as RecordsView;
    expect(paged.rows.map((r) => r.index)).toEqual([1, 2]);
    expect(paged.matching).toBe(5);
    const redacted = (await api.records("claude-code", SID, { filter: "redacted" })) as RecordsView;
    expect(redacted.rows.map((r) => r.index)).toEqual([2]);
    expect(await api.records("claude-code", "nobody")).toBeUndefined();
  });

  it("marks a mismatch, the pause's stop, the review-dropped prefix and a stub", async () => {
    const changed = fake();
    changed.traces[T1] = [
      STORED[0],
      { role: "user", content: "something else" },
      STORED[2],
    ] as NormalizedRecord[];
    const mismatch = (await new ExploreApi(deps(changed), { sinceMs: 86_400_000 }).records(
      "claude-code",
      SID,
      { filter: "mismatch" },
    )) as RecordsView;
    expect(mismatch.rows.map((r) => [r.index, r.state])).toEqual([[1, "differs"]]);

    const frozenAt = Buffer.byteLength(`${LINES.slice(0, 3).join("\n")}\n`);
    const paused = fake({ entry: entry({ frozen: { at: NOW.toISOString(), offset: frozenAt } }) });
    const p = alignRecords(await gather(paused), deps(paused));
    expect(p.marks.frozen_at).toBe(3);
    expect(p.rows[4]?.state).toBe("frozen");
    expect(p.pipeline.transcript.frozen_offset).toBe(frozenAt);

    const stub = fake({
      meta: metadata({
        head: undefined,
        traces: [],
        normalized: { bytes: SENT, records: 4, prefix_sha256: "e".repeat(64), hash_state: "x" },
        dropped_prefix: { bytes: SENT, records: 4, prefix_sha256: "e".repeat(64) },
      } as Partial<SessionMetadata>),
      traces: {},
    });
    const s = (await new ExploreApi(deps(stub), { sinceMs: 86_400_000 }).records(
      "claude-code",
      SID,
    )) as RecordsView;
    expect(s.marks).toMatchObject({ dropped_until: 4, stub: true });
    expect(s.rows.map((r) => r.state)).toEqual([
      "dropped",
      "dropped",
      "dropped",
      "dropped",
      "unsent",
    ]);
    expect(s.pipeline.stored).toMatchObject({ stub: true, dropped_prefix: 4, traces: 0 });
  });

  it("shows only local records when nothing can be asked of a server", async () => {
    const f = fake();
    const d = deps(f, {
      server: undefined,
      serverError: { code: "not_signed_in", message: "not signed in" },
    });
    const api = new ExploreApi(d, { sinceMs: 86_400_000 });
    expect(api.list().server).toEqual({ mode: "none", error: "not signed in" });
    const view = (await api.records("claude-code", SID)) as RecordsView;
    expect(view.rows.map((r) => r.state)).toEqual(["local", "local", "local", "local", "local"]);
    expect(view.rows[2]?.local).toEqual({ role: "user", content: `push with ${MARK}` });
  });
});

async function gather(f: Fake) {
  const { gatherEvidence } = await import("../doctor/evidence");
  return gatherEvidence({ agent: "claude-code", session_id: SID }, deps(f));
}

describe("never a secret", () => {
  it("no endpoint returns the retraction secret or the planted token", async () => {
    const api = new ExploreApi(deps(fake()), { sinceMs: 86_400_000 });
    const serve = handler(api);
    const paths = [
      "/api/sessions",
      `/api/sessions/claude-code/${SID}`,
      `/api/sessions/claude-code/${SID}?fresh=1`,
      ...["all", "mismatch", "redacted", "local", "stored"].map(
        (f) => `/api/sessions/claude-code/${SID}/records?filter=${f}&limit=500`,
      ),
    ];
    const bodies: string[] = [];
    for (const path of paths) {
      const res = await serve(request(path, { token: TOKEN }));
      expect(res.status, path).toBe(200);
      bodies.push(await res.text());
    }
    await api.settled();
    bodies.push(await (await serve(request("/api/sessions", { token: TOKEN }))).text());
    bodies.push(await (await serve(request(`/?token=${TOKEN}`))).text());
    for (const body of bodies) {
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain(PLANTED);
    }
    expect(bodies.join("")).toContain(MARK);
    expect(bodies.join("")).toContain(HASH);
  });

  it("answers 404 for a session this machine never saw, and 400 for a bad filter", async () => {
    const serve = handler();
    expect((await serve(request("/api/sessions/claude-code/other", { token: TOKEN }))).status).toBe(
      404,
    );
    expect(
      (await serve(request(`/api/sessions/claude-code/${SID}/records?filter=x`, { token: TOKEN })))
        .status,
    ).toBe(400);
    expect((await serve(request("/api/nothing", { token: TOKEN }))).status).toBe(404);
    expect((await serve(request(`/nothing?token=${TOKEN}`))).status).toBe(404);
  });
});

describe("the server", () => {
  let server: ExploreServer | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it("listens on 127.0.0.1 at a random port and prints an address with the token", async () => {
    server = startExploreServer({
      api: new ExploreApi(deps(fake()), { sinceMs: 86_400_000 }),
      assets: ASSETS,
    });
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/?token=${server.token}`);
    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    const list = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
      headers: { [TOKEN_HEADER]: server.token },
    });
    expect(((await list.json()) as SessionList).sessions).toHaveLength(1);
    const rebound = await fetch(server.url, { headers: { host: `evil.example:${server.port}` } });
    expect(rebound.status).toBe(403);
  });
});

describe("the page's files", () => {
  let assets: Assets;
  beforeAll(async () => {
    assets = await buildAssets(fileURLToPath(new URL("./page/index.html", import.meta.url)));
  });

  it("bundle to an HTML page with no inline script or style and nothing remote", () => {
    expect(assets.index).toMatch(/<script type="module" crossorigin src="\/chunk-[a-z0-9]+\.js">/);
    expect(assets.index).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(assets.index).not.toMatch(/<style|\sstyle="/);
    expect(assets.index).not.toMatch(/https?:\/\//);
    const types = [...assets.files.values()].map((f) => f.type.split(";")[0]);
    expect(types).toEqual(expect.arrayContaining(["text/javascript", "text/css", "image/svg+xml"]));
    for (const [path, file] of assets.files) {
      const text = new TextDecoder().decode(file.body);
      expect(text, path).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
      expect(text, path).not.toContain("innerHTML");
    }
  });
});

describe("helpers", () => {
  it("find redaction markers with their rule", () => {
    expect(
      markersIn({ a: "x [redacted:github-token] y [redacted:entropy] [redacted:entropy]" }),
    ).toEqual({
      "github-token": 1,
      entropy: 2,
    });
    expect(splitMarkers("a [redacted:aws-secret] b")).toEqual([
      { text: "a " },
      { text: "[redacted:aws-secret]", rule: "aws-secret" },
      { text: " b" },
    ]);
    expect(fold("1\n2\n3", 2)).toEqual({ head: "1\n2", lines: 3, folded: true });
    expect(fold("1\n2", 2)).toEqual({ head: "1\n2", lines: 2, folded: false });
  });

  it("split log lines at their timestamp and sort the timeline", () => {
    expect(splitLogLine("2026-11-15T11:30:00.500Z uploader: sent")).toEqual({
      at: "2026-11-15T11:30:00.500Z",
      text: "uploader: sent",
    });
    expect(splitLogLine("no time here")).toEqual({ text: "no time here" });
  });

  it("orders checks failures first", () => {
    const c = (id: string, status: "ok" | "warn" | "fail" | "skip") => ({
      id,
      title: id,
      status,
      summary: "",
    });
    expect(
      failuresFirst([
        c("a", "ok"),
        c("b", "fail"),
        c("c", "skip"),
        c("d", "warn"),
        c("e", "fail"),
      ]).map((x) => x.id),
    ).toEqual(["b", "e", "d", "a", "c"]);
  });
});
