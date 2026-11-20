import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { httpSink, RetractRefused, SignInNeeded } from "./sink";
import { transcriptFiles } from "./sweep";

/** A stand-in server on 127.0.0.1 that answers each request with what `answer` says. */
let answer: (request: Request) => Response;
let seen: Request[] = [];
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      seen.push(request.clone());
      return answer(request);
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  seen = [];
});

const url = () => `http://127.0.0.1:${server.port}`;
const error = (status: number, code: string) =>
  Response.json({ error: { code, message: code } }, { status });

function sink(user?: string) {
  return httpSink({
    target: url(),
    credential: async () => ({ server: url(), token: "seshi_x", ...(user ? { user } : {}) }),
  });
}

describe("httpSink", () => {
  it("uploads with the credential, and the username for the org key", async () => {
    answer = () =>
      Response.json(
        { status: "filtered", records_total: 0, prefix_sha256: "e", bytes_total: 0 },
        { status: 200 },
      );
    const result = await sink("alice").ingest({
      format: "claude-code",
      session_id: "s",
      transcript: "x\n",
    });
    expect(result.status).toBe("filtered");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer seshi_x");
    expect(seen[0]?.headers.get("x-seshi-user")).toBe("alice");
  });

  it("turns a 401 into a sign-in", async () => {
    answer = () => error(401, "unauthorized");
    await expect(sink().ingest({ format: "a", session_id: "s", transcript: "" })).rejects.toThrow(
      SignInNeeded,
    );
    await expect(sink().retract("a", "s", "secret")).rejects.toThrow(SignInNeeded);
  });

  it("retracts with the secret in its header; nothing there is absent", async () => {
    answer = () => Response.json({ removed: 2 });
    expect(await sink().retract("claude-code", "s 1", "the-secret")).toBe("retracted");
    expect(seen[0]?.method).toBe("DELETE");
    expect(new URL(seen[0]?.url ?? "").pathname).toBe("/v1/sessions/claude-code/s%201");
    expect(seen[0]?.headers.get("x-seshi-retract")).toBe("the-secret");
    answer = () => error(404, "not_found");
    expect(await sink().retract("a", "s", "x")).toBe("absent");
    answer = () => error(410, "redacted");
    expect(await sink().retract("a", "s", "x")).toBe("gone");
  });

  it("says why a retraction was refused", async () => {
    answer = () => error(403, "bad_retract_secret");
    await expect(sink().retract("a", "s", "x")).rejects.toThrow(RetractRefused);
    answer = () => error(403, "retract_disabled");
    await expect(sink().retract("a", "s", "x")).rejects.toMatchObject({ code: "retract_disabled" });
  });

  it("reads every page of the stale listing (X4.9), and turns a 401 into a sign-in", async () => {
    answer = (request) => {
      const after = new URL(request.url).searchParams.get("after");
      return after === null
        ? Response.json({
            sessions: [{ agent: "claude-code", session_id: "a", current: "2" }],
            cursor: "k1",
            truncated: true,
          })
        : after === "k1"
          ? Response.json({ sessions: [], cursor: "k2", truncated: true })
          : Response.json({
              sessions: [{ agent: "codex", session_id: "b", built_with: "1", current: "2" }],
              truncated: false,
            });
    };
    expect(await sink().stale?.()).toEqual([
      { agent: "claude-code", session_id: "a", current: "2" },
      { agent: "codex", session_id: "b", built_with: "1", current: "2" },
    ]);
    expect(seen.map((r) => new URL(r.url).pathname)).toEqual([
      "/v1/sessions/stale",
      "/v1/sessions/stale",
      "/v1/sessions/stale",
    ]);
    answer = () => error(401, "unauthorized");
    await expect(sink().stale?.()).rejects.toThrow(SignInNeeded);
  });

  it("is ready only with a credential", async () => {
    await expect(sink().ready()).resolves.toBeUndefined();
    const none = httpSink({
      target: url(),
      credential: async () => {
        throw new SignInNeeded("sign in");
      },
    });
    await expect(none.ready()).rejects.toThrow("sign in");
  });
});

describe("transcriptFiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seshi-sweep-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds files at exactly the depths named, that match", () => {
    for (const file of [
      "p/a.jsonl",
      "p/a/subagents/agent-1.jsonl",
      "p/a/other/x.jsonl",
      "top.jsonl",
      "p/b.txt",
    ]) {
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), "{}\n");
    }
    const found = transcriptFiles(
      {
        root: dir,
        depths: [2, 4],
        match: (rel) => /^[^/]+\/[^/]+\.jsonl$/.test(rel) || /\/subagents\//.test(rel),
      },
      dir,
    );
    expect(found.map((f) => f.relative).sort()).toEqual([
      "p/a.jsonl",
      "p/a/subagents/agent-1.jsonl",
    ]);
    expect(
      transcriptFiles({ root: "x", depths: [1], match: () => true }, join(dir, "missing")),
    ).toEqual([]);
  });
});
