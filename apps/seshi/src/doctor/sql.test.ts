/** `seshi doctor --config`'s sql checks and `seshi search --status`'s sql lines on a SQLite
 * index, in-process. LanceDB, the `lance` extension and the read-only credential are in
 * tests/search/sql-lance-deploy.test.ts. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureLayout, FsStore } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INTEGRATIONS } from "../integrations";
import { main } from "../main";
import { serverPoolCheck, sqlStatusLines } from "./sql";

let dir: string;
let home: string;
let toml: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "seshi-doctor-sql-"));
  home = join(dir, "home");
  mkdirSync(home);
  const bucket = pathToFileURL(join(dir, "bucket")).href;
  await ensureLayout(new FsStore(bucket), { createdBy: "test" });
  toml = join(dir, "seshi.toml");
  writeFileSync(
    toml,
    // JSON's escapes are TOML's: a Windows path's backslashes stay backslashes.
    `[store]\nurl = ${JSON.stringify(bucket)}\n[search]\npath = ${JSON.stringify(join(dir, "index.sqlite"))}\n`,
    { mode: 0o600 },
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function seshi(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    env: { HOME: home },
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    integrations: async () => INTEGRATIONS,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

// A server's own checks, which stay Linux-only like the server commands (vitest.laptop.config.ts
// runs this folder on Windows for the laptop doctor).
const server = process.platform === "win32" ? describe.skip : describe;

server("seshi doctor --config, sql", () => {
  it("runs a statement in a worker and reports the workers that ran it", async () => {
    // The index is built by the first search, as a SQLite server's own would be.
    expect((await seshi(["search", "anything", "--config", toml, "--json"])).code).toBe(0);
    const doctor = await seshi(["doctor", "--config", toml, "--json"]);
    expect(doctor.code, doctor.err).toBe(0);
    const checks = JSON.parse(doctor.out).server as { id: string; status: string }[];
    expect(checks.filter((c) => c.id.startsWith("sql"))).toEqual([
      expect.objectContaining({
        id: "sql",
        status: "ok",
        summary: expect.stringMatching(/^SQLite read the index in \d+ ms \(0 sessions\)$/),
      }),
      expect.objectContaining({
        id: "sql-workers",
        status: "ok",
        summary: "this check's: 2 started, 0 busy, 0 queued, 0 restarted",
      }),
    ]);
  }, 60_000);
});

server("seshi search --status, sql", () => {
  it("says what answers sql, and that a running server holds the workers", async () => {
    const status = await seshi(["search", "--status", "--config", toml, "--json"]);
    expect(status.code, status.err).toBe(0);
    expect(JSON.parse(status.out).sql).toEqual({ engine: "sqlite" });
    const text = await seshi(["search", "--status", "--config", toml]);
    expect(text.out).toContain("sql: SQLite, in worker processes");
    expect(text.out).toContain("sql workers: a running server holds them: add --server <url>");
  });

  it("says why it could not ask a server for its workers", async () => {
    const status = await seshi([
      "search",
      "--status",
      "--config",
      toml,
      "--server",
      "http://127.0.0.1:1",
      "--token",
      "seshi-not-a-token-0123456789",
      "--json",
    ]);
    expect(status.code, status.err).toBe(0);
    expect(JSON.parse(status.out).sql).toMatchObject({
      engine: "sqlite",
      server: "http://127.0.0.1:1",
      workers_error: expect.any(String),
    });
  });
});

describe("sqlStatusLines", () => {
  it("names DuckDB's credential, or the build that carries it", () => {
    expect(sqlStatusLines({ engine: "duckdb", credential: "read-only" })).toEqual([
      "sql: DuckDB over the Lance tables, in worker processes holding [search.sql.storage] (read-only)",
      "sql workers: a running server holds them: add --server <url> to ask it (seshi workers status --server <url> shows them too)",
    ]);
    expect(sqlStatusLines({ engine: "duckdb", credential: "index" })[0]).toContain(
      "the index's own credential, which can write",
    );
    expect(sqlStatusLines({ engine: "unavailable" })).toEqual([
      "sql: not in this build, which answers 501 (the seshi-server-sql build and the -sql image carry DuckDB)",
    ]);
  });

  it("gives a server's workers, none before its first statement, or why it could not ask", () => {
    const server = "https://seshi.example.com";
    const pool = { workers: 2, busy: 1, queued: 0, restarts: 3 };
    expect(sqlStatusLines({ engine: "sqlite", server, workers: pool })[1]).toBe(
      "sql workers on https://seshi.example.com: 2 started, 1 busy, 0 queued, 3 restarted",
    );
    expect(sqlStatusLines({ engine: "sqlite", server, workers: null })[1]).toBe(
      "sql workers on https://seshi.example.com: none started yet (a server starts them with its first statement)",
    );
    expect(sqlStatusLines({ engine: "sqlite", server, workers_error: "forbidden" })[1]).toBe(
      "sql workers on https://seshi.example.com: could not ask: forbidden",
    );
    // A laptop's processes each start their own: nothing to point at.
    expect(sqlStatusLines({ engine: "sqlite" }, "laptop")).toEqual([
      "sql: SQLite, in worker processes",
    ]);
  });
});

describe("serverPoolCheck", () => {
  const server = "https://seshi.example.com";
  it("is ok with the server's workers, and warns on restarts or when it could not ask", () => {
    expect(
      serverPoolCheck({ server, workers: { workers: 2, busy: 0, queued: 0, restarts: 0 } }),
    ).toMatchObject({
      id: "sql-server-workers",
      status: "ok",
      summary: "https://seshi.example.com: 2 started, 0 busy, 0 queued, 0 restarted",
    });
    expect(serverPoolCheck({ server, workers: null })).toMatchObject({ status: "ok" });
    expect(
      serverPoolCheck({ server, workers: { workers: 2, busy: 0, queued: 0, restarts: 1 } }),
    ).toMatchObject({ status: "warn", hint: expect.stringContaining("worker_memory") });
    expect(serverPoolCheck({ server, error: "forbidden" })).toMatchObject({
      status: "warn",
      summary: "could not ask https://seshi.example.com: forbidden",
    });
  });
});
