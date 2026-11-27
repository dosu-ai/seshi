// What SQLite's EXPLAIN shows of a statement: the tables it opens (root page, database) and
// the functions it calls, as a second check on native SQLite `sql` that uses SQLite's compiler.
//
// Usage: bun explain.ts <root from gen.ts>
import { Database } from "bun:sqlite";
import { join } from "node:path";

const root = process.argv[2];
const db = new Database(join(root, "index/sqlite/search.db"), { readonly: true });
db.run(`ATTACH '${join(root, "outside/secret.db")}' AS s2`);
db.run(`CREATE TEMP VIEW events AS SELECT e.id, e.role, s.owner FROM main.events e JOIN main.sessions s ON s.id = e.session
  WHERE s.visibility = 'org' OR s.owner IN ('alice')`);
const roots = Object.fromEntries(
  (db.query("SELECT name, rootpage FROM main.sqlite_master WHERE rootpage > 0").all() as { name: string; rootpage: number }[]).map((r) => [r.rootpage, r.name]),
);
type Op = { opcode: string; p2: number; p3: number; p4: string | null };
for (const sql of [
  "SELECT count(*) FROM events WHERE lower(role) = 'user'",
  "SELECT count(*) FROM main.events",
  "SELECT * FROM s2.secret",
  "SELECT name FROM pragma_database_list",
  "SELECT count(*) FROM json_each('[1,2]')",
  "SELECT 1; DROP VIEW events",
]) {
  const ops = db.query(`EXPLAIN ${sql}`).all() as Op[];
  const opens = ops.filter((o) => o.opcode === "OpenRead" || o.opcode === "OpenWrite").map((o) => `${o.opcode} db${o.p3}:${o.p3 === 0 ? (roots[o.p2] ?? o.p2) : o.p2}`);
  const fns = ops.filter((o) => /Function|AggStep|VFilter|VOpen/.test(o.opcode)).map((o) => `${o.opcode}${o.p4 ? `(${String(o.p4).slice(0, 30)})` : ""}`);
  console.log(`| \`${sql}\` | ${[...new Set(opens)].join(", ") || "—"} | ${[...new Set(fns)].join(", ") || "—"} |`);
}
