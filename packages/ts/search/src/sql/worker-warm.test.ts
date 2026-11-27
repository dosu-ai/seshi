import { describe, expect, it } from "vitest";
import { provideSql, type SqlEngine } from "../backends";
import { runSqlWorker } from "./worker";

/** A worker in a build with DuckDB warms it only in a pool that serves a LanceDB index:
 * workers of a SQLite index never load it (or its extension, hundreds of MB). */
describe("a worker's DuckDB (runSqlWorker)", () => {
  let warmed = 0;
  provideSql({
    script: "unused",
    warm: async () => {
      warmed++;
    },
    run: async (request) => ({
      id: request.id,
      ok: false,
      error: { kind: "internal", message: "fake" },
    }),
  } satisfies SqlEngine);

  async function serve(env: NodeJS.ProcessEnv, lines: string[]): Promise<string[]> {
    const out: string[] = [];
    await runSqlWorker(
      (async function* () {
        for (const line of lines) yield `${line}\n`;
      })(),
      (line) => out.push(line),
      env,
    );
    return out;
  }

  it("does not warm DuckDB in a SQLite pool", async () => {
    warmed = 0;
    const out = await serve({}, ['{"id":"q1","engine":"postgres"}']);
    expect(out).toHaveLength(2);
    expect(warmed).toBe(0);
  });

  it("warms DuckDB before it is ready, and after each answer, in a DuckDB pool", async () => {
    warmed = 0;
    await serve({ SESHI_SQL_ENGINE: "duckdb" }, ['{"id":"q1","engine":"postgres"}']);
    expect(warmed).toBe(2);
  });
});
