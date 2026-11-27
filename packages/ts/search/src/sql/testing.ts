/** What `sql`'s tests share across engines (not product code): the fixture sessions and their
 * decoys, the hostile-statement suite's harness and the example conformance answers. SQLite's
 * tests import them from here; `@seshi/sql`'s, which run the same over a Lance index, through
 * `@seshi/search/sql-testing`. Nothing else imports it, so no binary carries it. */
export * from "./conformance";
export * from "./fixture";
export * from "./hostile";
