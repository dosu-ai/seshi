/** `seshi explore` end to end (29): hooks spool, `seshi daemon --once` uploads to a seshi server
 * served on 127.0.0.1 over its own Instance and folder store (signed in with the org key), and
 * explore serves the three views of each session on 127.0.0.1. A secret planted in the transcript
 * never appears in any response (the local view is redacted with the local rules, the stored
 * one was redacted before it was stored), nor does the retraction secret; explore only sends GETs
 * and writes nothing. Also in local mode, and the command itself started as a process: it prints
 * its address, serves the page and stops on SIGINT. */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Assets, buildAssets, startExplore } from "seshi/explore";
import { INTEGRATIONS } from "seshi/integrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Machine, startServer, type TestServer } from "../tooling/cli";
import { transcript } from "../tooling/testdata";

const OWNER = "alice@acme.com";
const SESSION = "5e1f0a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
/** A secret the built-in pack redacts (github-token), split so no scanner reads it here. */
const PLANTED = `${"gh"}p_${"abcdefghijklmnopqrstuvwx0123456789"}`;
const ROOT = resolve(import.meta.dirname, "../..");

const line = (uuid: string, second: number, text: string) =>
  `${JSON.stringify({
    type: "assistant",
    uuid,
    timestamp: `2026-09-01T00:00:${String(second).padStart(2, "0")}.000Z`,
    sessionId: "sess1",
    message: { role: "assistant", model: "claude-x", content: [{ type: "text", text }] },
  })}\n`;
const HEAD = `${transcript("claude-basic.claude-code.jsonl").trim()}\n${line(
  "a3",
  8,
  `Pushed with ${PLANTED}. The auth flow: ${"details ".repeat(400)}`,
)}`;
const TAIL = line("a4", 9, "Done: refactored the tokenizer pipeline.");

let built: Promise<Assets> | undefined;
const assets = () => {
  built ??= buildAssets(join(ROOT, "apps/seshi/src/explore/page/index.html"));
  return built;
};

interface Explore {
  url: string;
  port: number;
  token: string;
  get(path: string): Promise<Response>;
  json<T = unknown>(path: string): Promise<T>;
  bodies: string[];
  close(): Promise<void>;
  settled(): Promise<void>;
}

/** `startExplore` in this process, with `machine`'s home, config and secrets. */
async function explore(machine: Machine, args: { server?: string } = {}): Promise<Explore> {
  const out: string[] = [];
  const running = await startExplore(
    {
      argv: [],
      env: machine.env,
      stdout: (l) => out.push(l),
      stderr: (l) => out.push(l),
      integrations: async () => INTEGRATIONS,
      secrets: machine.secrets,
    },
    args,
    // Vite cannot load an HTML import; the page is bundled as a source run does it.
    { assets: await assets() },
  );
  const { server } = running;
  const bodies: string[] = [];
  const get = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      headers: { "x-seshi-token": server.token },
    });
    bodies.push(await res.clone().text());
    return res;
  };
  return {
    url: server.url,
    port: server.port,
    token: server.token,
    get,
    json: async <T>(path: string) => {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      return (await res.json()) as T;
    },
    bodies,
    close: () => running.close(),
    settled: () => running.api.settled(),
  };
}

let server: TestServer;
let machine: Machine;
let project: string;
let file: string;
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await server?.stop();
  machine?.cleanup();
});

function hook(m: Machine, path: string, cwd: string, id = SESSION) {
  return m.seshi(["hook", "claude-code", "Stop"], {
    stdin: JSON.stringify({
      session_id: id,
      transcript_path: path,
      cwd,
      hook_event_name: "Stop",
    }),
  });
}

interface Row {
  index: number;
  state: string;
  local?: unknown;
  stored?: unknown;
  markers?: Record<string, number>;
}

describe("seshi explore (29)", () => {
  beforeEach(async () => {
    server = await startServer();
    const orgKey = (await server.auth.initAdmin({ owner: "ops" })).org_key?.token as string;
    machine = new Machine();
    const login = await machine.seshi(
      ["login", "--server", server.url, "--key", "-", "--user", OWNER],
      { stdin: orgKey },
    );
    expect(login.code, login.err).toBe(0);
    project = join(machine.dir, "code", "app");
    mkdirSync(project, { recursive: true });
    file = join(machine.dir, ".claude", "projects", "-code-app", `${SESSION}.jsonl`);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, HEAD);
  });

  it("serves the three views of a captured session, and never a secret", async () => {
    await hook(machine, file, project);
    await machine.seshi(["daemon", "--once"]);
    appendFileSync(file, TAIL);
    await hook(machine, file, project);
    await machine.seshi(["daemon", "--once"]);
    appendFileSync(file, line("a5", 10, "One more line, not sent yet."));

    const dir = join(machine.dir, ".local", "state", "seshi");
    const state = readFileSync(join(dir, "state.json"), "utf8");
    const secret = JSON.parse(state).sessions[`claude-code:${SESSION}`].secret as string;
    const spool = readdirSync(join(dir, "spool")).sort();
    const requests = server.requests.length;

    const x = await explore(machine);
    cleanups.push(() => x.close());

    // The list, cheap first, then checked in the background.
    const list = await x.json<{
      sessions: { session_id: string; worst: string; decision: { glyph: string } }[];
    }>("/api/sessions");
    expect(list.sessions.map((s) => s.session_id)).toEqual([SESSION]);
    expect(list.sessions[0]?.decision.glyph).toBe("◉");
    await x.settled();
    const checked = await x.json<{ sessions: { worst: string }[]; pending: number }>(
      "/api/sessions",
    );
    expect(checked.pending).toBe(0);
    expect(checked.sessions[0]?.worst, JSON.stringify(checked.sessions[0])).toBe("ok");

    // One session: evidence and checks.
    const detail = await x.json<{
      evidence: { local: { secret: unknown }; server: { traces: { records?: unknown }[] } };
      checks: { id: string; status: string; summary: string }[];
      timeline: { kind: string }[];
    }>(`/api/sessions/claude-code/${SESSION}`);
    expect(detail.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(detail.evidence.local.secret).toMatchObject({ present: true });
    expect(detail.evidence.server.traces).toHaveLength(2);
    expect(detail.evidence.server.traces[0]?.records).toBeUndefined();
    expect(detail.timeline.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["seen", "upload", "change"]),
    );

    // The records view: local (redacted) beside stored, aligned.
    const view = await x.json<{
      rows: Row[];
      marks: { sent_until?: number; stub: boolean };
      states: Record<string, number>;
      pipeline: { redacted: { markers: Record<string, number> }; stored: { traces: number } };
    }>(`/api/sessions/claude-code/${SESSION}/records?limit=500`);
    const last = view.rows.at(-1) as Row;
    expect(last.state).toBe("unsent");
    expect(view.marks.sent_until).toBe(last.index);
    expect(view.rows.slice(0, -1).every((r) => r.state === "same")).toBe(true);
    expect(view.pipeline.redacted.markers["github-token"]).toBeGreaterThan(0);
    expect(view.pipeline.stored.traces).toBe(2);
    const marked = view.rows.find((r) => r.markers?.["github-token"]) as Row;
    expect(JSON.stringify(marked.local)).toContain("[redacted:github-token]");
    expect(JSON.stringify(marked.stored)).toContain("[redacted:github-token]");
    for (const filter of ["mismatch", "redacted", "local", "stored"]) {
      await x.json(`/api/sessions/claude-code/${SESSION}/records?filter=${filter}&limit=500`);
    }
    await x.json(`/api/sessions/claude-code/${SESSION}?fresh=1`);
    const page = await fetch(x.url);
    expect(page.status).toBe(200);
    x.bodies.push(await page.text());

    for (const body of x.bodies) {
      expect(body).not.toContain(PLANTED);
      expect(body).not.toContain(secret);
    }

    // Read-only: no state written, no spool entry, no uploader started, only GETs.
    expect(readFileSync(join(dir, "state.json"), "utf8")).toBe(state);
    expect(readdirSync(join(dir, "spool")).sort()).toEqual(spool);
    expect(machine.spawned.filter((s) => s.words.includes("daemon"))).toHaveLength(2);
    const asked = server.requests.slice(requests);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((r) => r.method === "GET")).toBe(true);
  });

  it("shows the local views when the server is gone", async () => {
    await hook(machine, file, project);
    await machine.seshi(["daemon", "--once"]);
    await server.stop();
    const x = await explore(machine);
    cleanups.push(() => x.close());
    const view = await x.json<{ rows: Row[]; pipeline: { records: { count: number } } }>(
      `/api/sessions/claude-code/${SESSION}/records`,
    );
    expect(view.pipeline.records.count).toBeGreaterThan(0);
    expect(view.rows.every((r) => r.stored === undefined)).toBe(true);
    for (const body of x.bodies) expect(body).not.toContain(PLANTED);
    server = await startServer();
  });
});

describe("seshi explore in local mode (X3.5)", () => {
  beforeEach(async () => {
    server = await startServer();
  });

  it("reads the bucket itself", async () => {
    machine = new Machine();
    const toml = join(machine.dir, "seshi.toml");
    writeFileSync(toml, `[store]\nurl = "file://${join(machine.dir, "bucket")}"\n`, {
      mode: 0o600,
    });
    machine.cliConfig(`[local]\nconfig = "${toml}"\nowner = "me"\n`);
    const code = join(machine.dir, "code");
    mkdirSync(code);
    const localFile = join(machine.dir, "l1.jsonl");
    writeFileSync(localFile, HEAD);
    await hook(machine, localFile, code, "l1");
    await machine.seshi(["daemon", "--once"]);

    const x = await explore(machine);
    cleanups.push(() => x.close());
    const list = await x.json<{ server: { mode: string } }>("/api/sessions");
    expect(list.server.mode).toBe("local");
    const view = await x.json<{ rows: Row[] }>("/api/sessions/claude-code/l1/records?limit=500");
    expect(view.rows.length).toBeGreaterThan(1);
    expect(view.rows.every((r) => r.state === "same")).toBe(true);
    for (const body of x.bodies) expect(body).not.toContain(PLANTED);
  });
});

describe("the explore command", () => {
  beforeEach(async () => {
    server = await startServer();
  });

  it("refuses bad usage and prints its help", async () => {
    machine = new Machine();
    expect((await machine.seshi(["explore", "--bogus"])).code).toBe(2);
    expect((await machine.seshi(["explore", "--port", "x"])).code).toBe(2);
    expect((await machine.seshi(["explore", "--since", "soon"])).code).toBe(2);
    const help = await machine.seshi(["explore", "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("usage: seshi explore");
  });

  it("starts as a process, prints its address, serves the page and stops on SIGINT", async () => {
    machine = new Machine();
    const proc = Bun.spawn(
      [process.execPath, join(ROOT, "apps/seshi/src/main.ts"), "explore", "--no-open"],
      {
        cwd: machine.dir,
        env: { ...machine.env, PATH: process.env.PATH ?? "", SESHI_KEYCHAIN: "false" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    cleanups.push(() => {
      if (proc.exitCode === null) proc.kill();
    });
    const reader = proc.stdout.getReader();
    let printed = "";
    while (!printed.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      printed += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const url = /seshi explore: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/.exec(
      printed,
    )?.[1];
    expect(url, printed).toBeDefined();
    const page = await fetch(url as string);
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/<script type="module" crossorigin src="\/chunk-/);
    expect((await fetch(new URL(url as string).origin)).status).toBe(401);
    proc.kill("SIGINT");
    expect(await proc.exited).toBe(0);
  });
});
