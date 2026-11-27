#!/usr/bin/env bun

// The `-sql` server build's entry point (docs/seshi/session-tools.md, T9): the server build,
// with DuckDB for `sql` on a LanceDB index. Importing `@seshi/sql` here, and nowhere that
// main.ts or main-server.ts reaches, keeps DuckDB's native library out of every other binary.
// Its `seshi sql-worker` gets DuckDB the same way; the API process never loads it.
import { lanceIndex, provideLance } from "@seshi/lance";
import { duckdbSql, provideSql } from "@seshi/sql";
import { start } from "./main";

provideLance(lanceIndex);
provideSql(duckdbSql);
start();
