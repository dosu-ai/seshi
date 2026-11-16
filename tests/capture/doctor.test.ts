/** `seshi doctor` end to end (28): hooks spool, `seshi daemon --once` uploads to a seshi server
 * served on 127.0.0.1 over its own Instance and folder store (signed in with the org key), and
 * the doctor reads all three views of each session: the transcript, the capture state and what
 * the server stored. A captured session passes; one the server lost, one with a secret planted
 * in its stored trace fail; one turned off and retracted, and a stub review left, pass. Nothing
 * touches the real home folder, keychain or network; the model provider is a local fake. */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSession } from "@seshi/pipeline";
import { reviewerFromConfig } from "@seshi/review";
import { type FakeServer, fakeProviderServer, KeywordModel } from "@seshi/review/testing";
import { archiveId, gunzipJson, gzipJsonDeterministic, keys } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Machine, startServer, type TestServer } from "../tooling/cli";
import { serverConfig } from "../tooling/instance";
import { transcript } from "../tooling/testdata";

const OWNER = "alice@acme.com";
const SESSION = "5e1f0a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
/** A secret the built-in pack redacts (github-token), split so no scanner reads it here. */
const PLANTED = `${"gh"}p_${"abcdefghijklmnopqrstuvwx0123456789"}`;

const HEAD = `${transcript("claude-basic.claude-code.jsonl").trim()}\n${JSON.stringify({
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
const TAIL = `${JSON.stringify({
  type: "assistant",
  uuid: "a4",
  timestamp: "2026-09-01T00:00:09.000Z",
  sessionId: "sess1",
  message: {
    role: "assistant",
    model: "claude-x",
    content: [{ type: "text", text: "Done: refactored the tokenizer pipeline." }],
  },
})}\n`;

let server: TestServer;
let machine: Machine;
let project: string;
let file: string;

async function boot(review?: string) {
  const reviewer = review ? await reviewerFromConfig(serverConfig(review)) : undefined;
  server = await startServer(reviewer ? { reviewer } : {});
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
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await server?.stop();
  machine?.cleanup();
});

function hook(event = "Stop") {
  return machine.seshi(["hook", "claude-code", event], {
    stdin: JSON.stringify({
      session_id: SESSION,
      transcript_path: file,
      cwd: project,
      hook_event_name: event,
    }),
  });
}

async function daemon() {
  const run = await machine.seshi(["daemon", "--once", "--json"]);
  return run.out ? JSON.parse(run.out) : undefined;
}

interface Check {
  id: string;
  status: string;
  summary: string;
  detail?: string[];
}

async function doctor(extra: string[] = []) {
  const run = await machine.seshi(
    ["doctor", "--session", SESSION, "--agent", "claude-code", "--json", ...extra],
    { env: { NO_COLOR: "1" } },
  );
  const parsed = run.out ? JSON.parse(run.out) : { sessions: [] };
  const checks: Check[] = parsed.sessions[0]?.checks ?? [];
  const by = Object.fromEntries(checks.map((c) => [c.id, c]));
  return { ...run, parsed, checks, by };
}

const failures = (checks: Check[]) => checks.filter((c) => c.status === "fail");

describe("seshi doctor (28)", () => {
  beforeEach(async () => {
    await boot();
  });

  it("passes a captured session, chunks and all, and finds it by search", async () => {
    await hook();
    expect(await daemon()).toMatchObject({ uploaded: 1 });
    appendFileSync(file, TAIL);
    await hook();
    expect(await daemon()).toMatchObject({ uploaded: 1 });

    await server.instance.search?.catchUp();
    const run = await doctor(["--deep"]);
    expect(run.code, run.out).toBe(0);
    expect(failures(run.checks)).toEqual([]);
    for (const id of ["presence", "secret", "offsets", "records", "prefix", "chain", "residue"]) {
      expect(run.by[id]?.status, `${id}: ${run.by[id]?.summary}`).toBe("ok");
    }
    expect(run.by.chain?.summary).toContain("2 traces");
    expect(run.by.changes?.status).toBe("ok");
    expect(run.by.search?.status, run.by.search?.summary).toBe("ok");
    expect(run.by.search?.summary).toMatch(/found by '(tokenizer|refactored)'/);
    const evidence = run.parsed.sessions[0].evidence;
    expect(evidence.local.secret).toMatchObject({ present: true });
    expect(JSON.stringify(evidence)).not.toContain(
      JSON.parse(readFileSync(join(machine.dir, ".local", "state", "seshi", "state.json"), "utf8"))
        .sessions[`claude-code:${SESSION}`].secret,
    );
    // The stored records are left out of --json.
    expect(evidence.server.traces[0].records).toBeUndefined();

    // Human output: a word per check, no colour with NO_COLOR.
    const human = await machine.seshi(["doctor", "--session", SESSION], {
      env: { NO_COLOR: "1", SESHI_AGENT: "claude-code" },
    });
    expect(human.code, human.out).toBe(0);
    expect(human.out).toMatch(/ok {2,}Server presence/);
    expect(human.out).not.toContain("\x1b[");

    // Every session of the past day: one line each.
    const all = await machine.seshi(["doctor"], { env: { NO_COLOR: "1" } });
    expect(all.code, all.out).toBe(0);
    expect(all.out).toContain(`claude-code ${SESSION}`);
  });

  it("fails presence for a session the server lost", async () => {
    await hook();
    await daemon();
    const store = server.instance.store;
    await store.delete(keys.metadata(OWNER, archiveId(OWNER, "claude-code", SESSION)));

    const run = await doctor();
    expect(run.code).toBe(8);
    expect(run.by.presence).toMatchObject({ status: "fail" });
    expect(run.by.presence?.summary).toContain("holds nothing");

    const all = await machine.seshi(["doctor"], { env: { NO_COLOR: "1" } });
    expect(all.code).toBe(8);
    expect(all.out).toContain("Failed checks:");
    expect(all.out).toMatch(/fail {2}claude-code/);
  });

  it("fails residue for a secret planted in the stored trace, naming the rule, never the text", async () => {
    await hook();
    await daemon();
    const store = server.instance.store;
    const metadata = await getSession(store, OWNER, "claude-code", SESSION);
    const archive = archiveId(OWNER, "claude-code", SESSION);
    const key = keys.trace(OWNER, archive, metadata?.head as string);
    const bytes = await store.get(key);
    const trace = gunzipJson(bytes?.body as Uint8Array) as { records: { content?: unknown }[] };
    const index = trace.records.findIndex((r) => r && (r as { role?: string }).role === "user");
    trace.records[index] = { ...trace.records[index], content: `push with ${PLANTED}` };
    await store.put(key, gzipJsonDeterministic(trace));

    const run = await doctor();
    expect(run.code).toBe(8);
    expect(run.by.residue).toMatchObject({ status: "fail" });
    expect(run.by.residue?.summary).toContain(`record ${index}: github-token`);
    expect(run.out).not.toContain(PLANTED);
    const human = await machine.seshi(["doctor", "--session", SESSION, "--agent", "claude-code"]);
    expect(human.out).not.toContain(PLANTED);
  });

  it("passes a session turned off and retracted, and one turned on again", async () => {
    await hook();
    await daemon();
    const off = await machine.seshi(["capture", "off", "--session", SESSION]);
    expect(off.code, off.err).toBe(0);
    const before = await doctor();
    expect(before.by.queue?.status).toBe("warn"); // the retraction waits
    expect(await daemon()).toMatchObject({ retracted: 1 });

    await server.instance.search?.catchUp();
    const run = await doctor(["--deep"]);
    expect(run.code, JSON.stringify(failures(run.checks))).toBe(0);
    expect(run.by.presence).toMatchObject({ status: "ok" });
    expect(run.by.presence?.summary).toContain("retracted");
    expect(run.by.search?.status, run.by.search?.summary).toBe("ok");

    await machine.seshi(["capture", "on", "--session", SESSION]);
    await hook();
    await daemon();
    const again = await doctor();
    expect(again.code, JSON.stringify(failures(again.checks))).toBe(0);
    expect(again.parsed.sessions[0].evidence.server.upload_id).toBe(`${SESSION}~1`);
    expect(again.by.presence?.summary).toContain(`${SESSION}~1`);
  });

  it("does nothing: no uploads, state writes or spool entries", async () => {
    await hook();
    await daemon();
    appendFileSync(file, TAIL);
    await hook();
    const dir = join(machine.dir, ".local", "state", "seshi");
    const before = readFileSync(join(dir, "state.json"), "utf8");
    const spool = readdirSync(join(dir, "spool")).sort();
    const spawned = machine.spawned.length;
    const requests = server.requests.length;
    const run = await doctor(["--deep"]);
    expect(run.code, JSON.stringify(failures(run.checks))).toBe(0);
    expect(run.by.queue?.summary).toContain("1 hook entry waits for the uploader");
    expect(readFileSync(join(dir, "state.json"), "utf8")).toBe(before);
    expect(readdirSync(join(dir, "spool")).sort()).toEqual(spool);
    expect(machine.spawned).toHaveLength(spawned);
    const asked = server.requests.slice(requests);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((r) => r.method === "GET")).toBe(true);
  });

  it("refuses bad usage, and says when it cannot reach a server", async () => {
    expect((await machine.seshi(["doctor", "--bogus"])).code).toBe(2);
    expect((await machine.seshi(["doctor", "--since", "soon"])).code).toBe(2);
    const help = await machine.seshi(["doctor", "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("usage: seshi doctor");

    await hook();
    await daemon();
    await server.stop();
    const run = await doctor();
    expect(run.code).toBe(7);
    expect(run.by.presence?.status).toBe("skip");
    expect(run.by.decision?.status).toBe("ok");
    server = await startServer();
  });
});

describe("seshi doctor on a stub (F3.4)", () => {
  let provider: FakeServer;
  beforeEach(async () => {
    provider = fakeProviderServer({ model: new KeywordModel({ drop: ["CUSTOMER TABLE"] }) });
    cleanups.push(() => provider.close());
    await boot(
      `[[review.policies]]\nid = "default"\ndecision = { api_key = "sk-test", base_url = "${provider.url}" }\n`,
    );
  });

  it("passes a session whose first envelope review dropped", async () => {
    writeFileSync(
      file,
      HEAD.replace("The auth flow:", "Here is the CUSTOMER TABLE: ana, 41 rua. The auth flow:"),
    );
    await hook();
    expect(await daemon()).toMatchObject({ uploaded: 1 });
    const stub = await getSession(server.instance.store, OWNER, "claude-code", SESSION);
    expect(stub?.head).toBeUndefined();
    expect(stub?.status).toBe("stored");

    const run = await doctor();
    expect(run.code, JSON.stringify(failures(run.checks))).toBe(0);
    expect(run.by.presence).toMatchObject({ status: "ok" });
    expect(run.by.presence?.summary).toContain("stub");
  });
});

describe("seshi doctor in local mode (X3.5)", () => {
  beforeEach(async () => {
    await boot();
  });

  it("reads the bucket itself: pointer, traces and change feed", async () => {
    const local = new Machine();
    cleanups.push(() => local.cleanup());
    const toml = join(local.dir, "seshi.toml");
    writeFileSync(toml, `[store]\nurl = "file://${join(local.dir, "bucket")}"\n`, { mode: 0o600 });
    local.cliConfig(`[local]\nconfig = "${toml}"\nowner = "me"\n`);
    const code = join(local.dir, "code");
    mkdirSync(code);
    const localFile = join(local.dir, "l1.jsonl");
    writeFileSync(localFile, HEAD);
    await local.seshi(["hook", "claude-code", "Stop"], {
      stdin: JSON.stringify({ session_id: "l1", transcript_path: localFile, cwd: code }),
    });
    await local.seshi(["daemon", "--once"]);
    appendFileSync(localFile, TAIL);
    await local.seshi(["hook", "claude-code", "Stop"], {
      stdin: JSON.stringify({ session_id: "l1", transcript_path: localFile, cwd: code }),
    });
    await local.seshi(["daemon", "--once"]);

    const run = await local.seshi([
      "doctor",
      "--session",
      "l1",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(run.code, run.out).toBe(0);
    const [session] = JSON.parse(run.out).sessions;
    const by = Object.fromEntries(session.checks.map((c: Check) => [c.id, c]));
    expect(session.evidence.server).toMatchObject({ mode: "local", sees_stubs: true });
    for (const id of ["presence", "records", "prefix", "chain", "residue", "changes"]) {
      expect(by[id]?.status, `${id}: ${by[id]?.summary}`).toBe("ok");
    }
  });
});
