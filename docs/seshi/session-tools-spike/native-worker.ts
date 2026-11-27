// native.ts's runaway query, in a Worker so the main thread can try to stop it.
import { Database } from "bun:sqlite";

const db = new Database(process.argv.at(-1) as string, { readonly: true });
db.query(
  "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r WHERE i < 1000000) SELECT count(*) FROM r a, r b",
).get();
