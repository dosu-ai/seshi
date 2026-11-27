// Searches through the shipped `LanceIndex.query()`: the query compiler, filters, the caps,
// grouping, recent windows, the prefix check and the page's fetch, as an API instance runs
// them (read-only). The spike's query shapes, plus prefixes on the `text_prefix` design. Each
// case runs first on a new read-only index (cold: opening it and the first query are timed
// apart), then `runs` times warm.
// Usage: bun search.ts <uri> [runs] [--sort relevance|recent] [--only <substring>]
import { lanceIndex } from "@seshi/lance";
import { type BackendQuery, type IndexStore, parseQuery, type Viewer } from "@seshi/search";
import { DEPLOYMENT, EVENTS, ms, pct, time } from "./data";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const uri = args[0] as string;
const runs = Number(args[1] && !args[1].startsWith("--") ? args[1] : 5);
const sorts = flag("--sort") ? [flag("--sort") as "relevance" | "recent"] : (["relevance", "recent"] as const);
const only = flag("--only");

const QUERIES: [string, string][] = [
  ["rare word", "zeppelinx"],
  ["one common word", "error"],
  ["two common words, AND", "error test"],
  ["phrase", '"flaky checkout test"'],
  ["NOT", "deploy -staging"],
  ["OR", "rollback OR deployer"],
  ["very common word", "the"],
  ["prefix, common (deplo*)", "deplo*"],
  ["prefix, 2 letters (de*)", "de*"],
  ["prefix, mid-frequency (rollb*)", "rollb*"],
  ["prefix, rare (zeppel*)", "zeppel*"],
  ["prefix, past 8 letters (deployment*)", "deployment*"],
  ["word and prefix (error deplo*)", "error deplo*"],
  ["phrase and prefix (\"checkout test fail\"*)", '"checkout test fail"*'],
  ["NOT a prefix (error -deplo*)", "error -deplo*"],
];

const admin: Viewer = { everything: true, own: [], canRead: () => true };
const member: Viewer = { everything: false, own: ["u1"], canRead: () => true };
const FILTERS: [string, Partial<BackendQuery>][] = [
  ["admin", { viewer: admin }],
  ["member", { viewer: member }],
  ["member+label+model", { viewer: member, labels: { "dosu.project": "app" }, model: "claude-opus-5-5" }],
];

const open = () =>
  lanceIndex({ uri, readOnly: true })({ deployment: DEPLOYMENT, events: EVENTS, feed: true }) as Promise<IndexStore>;

const warm = await open();
console.log(`state ${JSON.stringify(await warm.state())}`);
console.log("sort | filter | query | open | first | warm p50 | warm p90 | min | total | capped");
for (const sort of sorts) {
  for (const [filterName, filter] of FILTERS) {
    for (const [name, text] of QUERIES) {
      if (only && !name.includes(only)) continue;
      const q: BackendQuery = {
        match: parseQuery(text).match,
        viewer: admin,
        ...filter,
        sort,
        limit: 20,
        offset: 0,
        matches: 3,
      };
      const [cold, opened] = await time(open);
      const [, first] = await time(() => cold.query(q));
      await cold.close();
      const times: number[] = [];
      let result = await warm.query(q);
      for (let i = 0; i < runs; i++) {
        const [r, t] = await time(() => warm.query(q));
        times.push(t);
        result = r;
      }
      console.log(
        [
          sort,
          filterName,
          `${name} [${text}]`,
          ms(opened),
          ms(first),
          ms(pct(times, 50)),
          ms(pct(times, 90)),
          ms(Math.min(...times)),
          `${result.total} sessions, ${result.hits.length} hits`,
          result.capped ? "capped" : "",
        ].join(" | "),
      );
    }
  }
}
await warm.close();
