import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LOCAL_VIEWER } from "../viewer";
import { buildFixture, FIXTURE_NOW } from "./fixture";
import { residentBytes, SqlBusy, SqlPool, scriptWorkerCommand } from "./pool";
import type { SqliteJob } from "./protocol";
import { sqlViews } from "./views";

let dir: string;
let index: string;
const pools: SqlPool[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "seshi-sql-pool-"));
  index = await buildFixture(join(dir, "index"));
});

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A fake worker: says it is ready, then runs `onRequest` (JavaScript, with `request` and
 * `answer(response)` in scope) for each line. */
function fake(name: string, onRequest: string): string[] {
  const file = join(dir, `${name}.ts`);
  writeFileSync(
    file,
    `const answer = (r: unknown) => process.stdout.write(JSON.stringify(r) + "\\n");
answer({ ready: true, pid: process.pid });
let buffered = "";
for await (const chunk of process.stdin) {
  buffered += new TextDecoder().decode(chunk);
  let nl = buffered.indexOf("\\n");
  while (nl !== -1) {
    const request = JSON.parse(buffered.slice(0, nl));
    buffered = buffered.slice(nl + 1);
    nl = buffered.indexOf("\\n");
    ${onRequest}
  }
}
`,
  );
  return [process.execPath, file];
}

function pool(options: Partial<ConstructorParameters<typeof SqlPool>[0]> = {}): SqlPool {
  const made = new SqlPool({
    command: scriptWorkerCommand(),
    workers: 1,
    workerMemory: 2 * 1024 ** 3,
    ...options,
  });
  pools.push(made);
  return made;
}

function request(sql: string, timeout = 2_000): SqliteJob {
  return {
    engine: "sqlite",
    setup: {
      file: index,
      views: sqlViews("sqlite", LOCAL_VIEWER, { since: 0, until: FIXTURE_NOW }),
    },
    sql,
    limits: { timeout_ms: timeout, max_rows: 1000, max_bytes: 1024 * 1024 },
  };
}

const FOREVER =
  "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n";

describe("the sql workers (SqlPool)", () => {
  it("run a statement in a worker process and answer its rows", async () => {
    const workers = pool();
    // Every session not removed: the window here starts at 0.
    const answer = await workers.run("ops", request("SELECT count(*) AS n FROM sessions"));
    expect(answer).toMatchObject({
      ok: true,
      columns: [{ name: "n", type: "INTEGER" }],
      rows: [[6]],
    });
  });

  it("kill a worker at the timeout, answer timeout, and run the next statement on a new one", async () => {
    const workers = pool();
    const started = Date.now();
    const answer = await workers.run("ops", request(FOREVER, 500));
    expect(answer).toMatchObject({ ok: false, error: { kind: "timeout" } });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await workers.run("ops", request("SELECT 1"))).toMatchObject({ ok: true, rows: [[1]] });
    expect(workers.status().restarts).toBe(1);
  });

  it("kill a worker past its memory limit and answer memory", async () => {
    // Any worker is past 1 MiB: the first reading kills it.
    const workers = pool({ workerMemory: 1024 ** 2, pollMs: 50 });
    const answer = await workers.run("ops", request(FOREVER, 10_000));
    expect(answer).toMatchObject({ ok: false, error: { kind: "memory" } });
    expect(await workers.run("ops", request("SELECT 1"))).toMatchObject({ ok: true });
  });

  it("answer internal when the worker dies mid-statement, then carry on", async () => {
    const workers = pool({
      command: fake(
        "dies",
        `if (request.sql === "die") process.exit(3);
         answer({ id: request.id, ok: true, columns: [], rows: [], truncated: false, elapsed_ms: 0 });`,
      ),
    });
    expect(await workers.run("ops", request("die"))).toMatchObject({
      ok: false,
      error: { kind: "internal", message: expect.stringContaining("exited (3)") },
    });
    expect(await workers.run("ops", request("fine"))).toMatchObject({ ok: true });
  });

  it("kill a hung worker that never answers (the watchdog)", async () => {
    const workers = pool({ command: fake("hangs", "// never answers") });
    expect(await workers.run("ops", request("anything", 300))).toMatchObject({
      ok: false,
      error: { kind: "timeout" },
    });
  });

  it("let a principal have two statements in flight, and queue a few, then refuse", async () => {
    const workers = pool({ command: fake("slow", "// never answers"), workers: 1, maxQueue: 2 });
    const held = [
      workers.run("alice", request("a", 1_000)),
      workers.run("alice", request("b", 1_000)),
    ];
    await expect(workers.run("alice", request("c", 1_000))).rejects.toBeInstanceOf(SqlBusy);
    // alice's first goes to the worker (once it has started), her second waits, then bob's: the
    // queue (2) is full for carol.
    held.push(workers.run("bob", request("d", 1_000)));
    await expect(workers.run("carol", request("e", 1_000))).rejects.toThrow(/busy/);
    await Promise.all(held);
  });

  it("keep a queue deeper than the workers waiting while they are busy", async () => {
    // Each answer takes 300 ms, so the fourth waits about 900 ms: past startMs, which only
    // counts while no worker is up.
    const workers = pool({
      command: fake(
        "slow-answers",
        `const id = request.id;
         setTimeout(() => answer({ id, ok: true, columns: [], rows: [[request.sql]], truncated: false, elapsed_ms: 300 }), 300);`,
      ),
      startMs: 200,
    });
    const answers = await Promise.all(
      ["a", "b", "c", "d"].map((who) => workers.run(who, request(who, 1_000))),
    );
    expect(answers.map((a) => (a.ok ? a.rows[0]?.[0] : a.error.message))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("answer internal when no worker comes up within startMs", async () => {
    const file = join(dir, "never-ready.ts");
    writeFileSync(file, "await new Promise(() => setInterval(() => {}, 1_000));\n");
    const workers = pool({ command: [process.execPath, file], startMs: 200 });
    const started = Date.now();
    expect(await workers.run("ops", request("SELECT 1", 5_000))).toMatchObject({
      ok: false,
      error: { kind: "internal", message: expect.stringContaining("could start") },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("keep reading a worker's answers when handling one throws", async () => {
    const logged: string[] = [];
    const workers = pool({ log: (l) => logged.push(l) });
    // Handling the first answer throws once, after settling it (as a write to a dead
    // worker's pipe did, in the pump that follows).
    const inside = workers as unknown as {
      pump: () => void;
      settle: (...args: unknown[]) => void;
    };
    const pump = inside.pump.bind(workers);
    const settle = inside.settle.bind(workers);
    let settled = false;
    let thrown = false;
    inside.settle = (...args) => {
      settled = true;
      settle(...args);
    };
    inside.pump = () => {
      if (settled && !thrown) {
        thrown = true;
        throw new Error("EPIPE");
      }
      pump();
    };
    const first = workers.run("ops", request("SELECT 1"));
    expect(await first).toMatchObject({ ok: true });
    expect(thrown).toBe(true);
    expect(logged.join("\n")).toContain("EPIPE");
    // The same worker's next answer still arrives.
    expect(await workers.run("ops", request("SELECT 2", 1_000))).toMatchObject({
      ok: true,
      rows: [[2]],
    });
    expect(workers.status().restarts).toBe(0);
  });

  it("hand a query to another worker when writing to one fails", async () => {
    const logged: string[] = [];
    const workers = pool({ workers: 2, log: (l) => logged.push(l) });
    const inside = workers as unknown as { slots: { ready: boolean; proc: object }[] };
    while (!inside.slots.every((s) => s.ready)) await Bun.sleep(20);
    // The first worker's pipe is closed: writing to it throws.
    const broken = inside.slots[0] as (typeof inside.slots)[number];
    const closed = {
      write: () => {
        throw new Error("EPIPE");
      },
      flush: () => 0,
    };
    broken.proc = new Proxy(broken.proc, {
      get(target, key) {
        if (key === "stdin") return closed;
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(await workers.run("ops", request("SELECT 3", 1_000))).toMatchObject({
      ok: true,
      rows: [[3]],
    });
    expect(logged.join("\n")).toMatch(/could not take a query \(EPIPE\); replacing it/);
    while (workers.status().restarts === 0) await Bun.sleep(20);
    expect(await workers.run("ops", request("SELECT 4", 1_000))).toMatchObject({ ok: true });
  });

  it("give workers a built environment: no seshi settings, tokens or keys", async () => {
    process.env.SESHI_SQL_TEST_SECRET = "s3cr3t";
    try {
      const workers = pool({
        command: fake(
          "env",
          `answer({ id: request.id, ok: true, columns: [{ name: "env", type: "TEXT" }], rows: [[JSON.stringify(process.env)]], truncated: false, elapsed_ms: 0 });`,
        ),
      });
      const answer = await workers.run("ops", request("env"));
      expect(answer.ok).toBe(true);
      const env = JSON.parse((answer as { rows: string[][] }).rows[0]?.[0] as string);
      expect(JSON.stringify(env)).not.toContain("s3cr3t");
      expect(Object.keys(env).filter((k) => k.startsWith("SESHI") || k.startsWith("AWS"))).toEqual(
        [],
      );
      expect(env.HOME).toBe(env.TMPDIR);
      expect(env.HOME).toContain("seshi-sql-");
    } finally {
      delete process.env.SESHI_SQL_TEST_SECRET;
    }
  });

  it("read a process's resident memory", async () => {
    if (process.platform === "win32") return;
    const bytes = await residentBytes(process.pid);
    expect(bytes).toBeGreaterThan(1024 * 1024);
  });
});
