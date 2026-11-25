import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LOCAL_VIEWER } from "../viewer";
import { buildFixture, FIXTURE_NOW } from "./fixture";
import { residentBytes, SqlBusy, SqlPool, scriptWorkerCommand } from "./pool";
import type { SqlWorkerRequest } from "./protocol";
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

function request(sql: string, timeout = 2_000): Omit<SqlWorkerRequest, "id"> {
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
