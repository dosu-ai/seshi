import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import { MAX_QUERY_LENGTH, MAX_QUERY_TERMS, parseQuery, SearchQueryError } from "./query";

describe("parseQuery", () => {
  it("quotes every word, so all must appear in any order", () => {
    expect(parseQuery("flaky test").match).toBe('"flaky" AND "test"');
    expect(parseQuery("  flaky\t test \n").terms).toEqual(["flaky", "test"]);
  });

  it("keeps phrases, prefixes, OR groups and exclusions", () => {
    expect(parseQuery('"auth flow"').match).toBe('"auth flow"');
    expect(parseQuery("deploy*").match).toBe('"deploy" *');
    expect(parseQuery("redis OR memcached cache").match).toBe(
      '("redis" OR "memcached") AND "cache"',
    );
    expect(parseQuery("a OR b OR c").match).toBe('("a" OR "b" OR "c")');
    expect(parseQuery("deploy -staging").match).toBe('("deploy") NOT ("staging")');
    expect(parseQuery('deploy -"dry run" NOT canary').match).toBe(
      '("deploy") NOT ("dry run" OR "canary")',
    );
    expect(parseQuery('"half open phrase').match).toBe('"half open phrase"');
  });

  it("treats paths, flags and FTS5 operators people type as plain words", () => {
    expect(parseQuery("src/app.ts").match).toBe('"src/app.ts"');
    expect(parseQuery("git push --force").match).toBe('"git" AND "push" AND "--force"');
    expect(parseQuery('say "it""s" NEAR(a b) col:x').match).toBe(
      '"say" AND "it" AND "s" AND "NEAR(a" AND "b)" AND "col:x"',
    );
    expect(parseQuery("and or not AND").match).toBe('"and" AND "or" AND "not"');
    // A dangling OR, a leading OR and a lone dash are not operators.
    expect(parseQuery("OR deploy OR").match).toBe('"deploy"');
    expect(parseQuery("- deploy").match).toBe('"deploy"');
  });

  it("drops what has nothing to find, and refuses a query left with nothing", () => {
    expect(parseQuery("deploy -- / *").match).toBe('"deploy"');
    expect(() => parseQuery("")).toThrow(SearchQueryError);
    expect(() => parseQuery('-- / ** ""')).toThrow(/at least one word/);
    expect(() => parseQuery("-staging")).toThrow(/at least one word/);
  });

  it("bounds the query", () => {
    expect(() => parseQuery("x".repeat(MAX_QUERY_LENGTH + 1))).toThrow(/longer than/);
    const many = Array.from({ length: MAX_QUERY_TERMS + 1 }, (_, i) => `w${i}`).join(" ");
    expect(() => parseQuery(many)).toThrow(/more than/);
  });

  it("always gives an expression FTS5 accepts", () => {
    const db = new Database(":memory:");
    db.run("CREATE VIRTUAL TABLE t USING fts5 (text)");
    db.run(
      "INSERT INTO t (text) VALUES ('fix the flaky test in src/app.ts'), ('git push --force to main')",
    );
    const queries = [
      "flaky test",
      '"flaky test"',
      "src/app.ts",
      "git push --force",
      'a"b',
      "NEAR(x y)",
      "col:x OR y*",
      "fl* -main",
      "((( x",
      "émoji 🎉 test",
      "AND OR word NOT other",
    ];
    for (const q of queries) {
      const { match } = parseQuery(q);
      expect(() => db.query("SELECT rowid FROM t WHERE t MATCH ?").all(match), q).not.toThrow();
    }
    const found = (q: string) =>
      (db.query("SELECT rowid FROM t WHERE t MATCH ?").all(parseQuery(q).match) as unknown[])
        .length;
    expect(found("src/app.ts")).toBe(1);
    expect(found("app.ts")).toBe(1);
    expect(found("fla*")).toBe(1);
    expect(found("push -main")).toBe(0);
    expect(found("flaky OR force")).toBe(2);
    expect(found('"test flaky"')).toBe(0);
  });
});
