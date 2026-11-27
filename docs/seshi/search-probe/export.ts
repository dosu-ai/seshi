import { DuckDBInstance } from "@duckdb/node-api";
const c = await (await DuckDBInstance.create(":memory:")).connect();
await c.run("LOAD lance;");
await c.run(`COPY (SELECT id, owner, archive_id, visibility, model, CAST(ts AS BIGINT) ts, CAST(input_tokens AS INTEGER) input_tokens, CAST(output_tokens AS INTEGER) output_tokens, text FROM './big/events.lance') TO './chfiles/events.parquet' (FORMAT parquet)`);
console.log("exported");
