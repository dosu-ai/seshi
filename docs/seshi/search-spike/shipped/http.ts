// Searches through a running server build's API (`seshi serve --roles api`, which opens the
// index read-only): what a client waits for, including SearchService's check of each result
// against the session's live metadata in the store (F10.4).
// Usage: bun http.ts <base-url> <token> [runs]
import { ms, pct, time } from "./data";

const [base, token, runsArg] = process.argv.slice(2) as [string, string, string | undefined];
const runs = Number(runsArg ?? 5);
const QUERIES = ["zeppelinx", "error", "error test", '"flaky checkout test"', "deploy -staging", "rollback OR deployer", "the", "deplo*", "de*", "rollb*", "error deplo*"];
console.log("sort | query | first | warm p50 | warm p90 | total");
for (const sort of ["relevance", "recent"]) {
  for (const q of QUERIES) {
    const url = `${base}/v1/search?q=${encodeURIComponent(q)}&sort=${sort}&limit=20`;
    const get = async () => {
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      const body = (await res.json()) as { total?: number; capped?: boolean; error?: unknown };
      if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
      return body;
    };
    const [body, first] = await time(get);
    const times: number[] = [];
    for (let i = 0; i < runs; i++) times.push((await time(get))[1]);
    console.log(
      `${sort} | ${q} | ${ms(first)} | ${ms(pct(times, 50))} | ${ms(pct(times, 90))} | ${body.total}${body.capped ? " (capped)" : ""}`,
    );
  }
}
