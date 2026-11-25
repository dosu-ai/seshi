import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import { MAX_QUERY_LENGTH, MAX_QUERY_TERMS, parseQuery, SearchQueryError, tokensOf } from "./query";
import { fts5Match } from "./sqlite";

describe("parseQuery", () => {
  it("quotes every word, so all must appear in any order", () => {
    expect(fts5Match(parseQuery("flaky test").match)).toBe('"flaky" AND "test"');
    expect(parseQuery("  flaky\t test \n").terms).toEqual(["flaky", "test"]);
  });

  it("keeps phrases, prefixes, OR groups and exclusions", () => {
    expect(fts5Match(parseQuery('"auth flow"').match)).toBe('"auth flow"');
    expect(fts5Match(parseQuery("deploy*").match)).toBe('"deploy" *');
    expect(fts5Match(parseQuery("redis OR memcached cache").match)).toBe(
      '("redis" OR "memcached") AND "cache"',
    );
    expect(fts5Match(parseQuery("a OR b OR c").match)).toBe('("a" OR "b" OR "c")');
    expect(fts5Match(parseQuery("deploy -staging").match)).toBe('("deploy") NOT ("staging")');
    expect(fts5Match(parseQuery('deploy -"dry run" NOT canary').match)).toBe(
      '("deploy") NOT ("dry run" OR "canary")',
    );
    expect(fts5Match(parseQuery('"half open phrase').match)).toBe('"half open phrase"');
  });

  it("treats paths, flags and FTS5 operators people type as plain words", () => {
    expect(fts5Match(parseQuery("src/app.ts").match)).toBe('"src/app.ts"');
    expect(fts5Match(parseQuery("git push --force").match)).toBe('"git" AND "push" AND "--force"');
    expect(fts5Match(parseQuery('say "it""s" NEAR(a b) col:x').match)).toBe(
      '"say" AND "it" AND "s" AND "NEAR(a" AND "b)" AND "col:x"',
    );
    expect(fts5Match(parseQuery("and or not AND").match)).toBe('"and" AND "or" AND "not"');
    // A dangling OR, a leading OR and a lone dash are not operators.
    expect(fts5Match(parseQuery("OR deploy OR").match)).toBe('"deploy"');
    expect(fts5Match(parseQuery("- deploy").match)).toBe('"deploy"');
  });

  it("drops what has nothing to find, and refuses a query left with nothing", () => {
    expect(fts5Match(parseQuery("deploy -- / *").match)).toBe('"deploy"');
    expect(() => parseQuery("")).toThrow(SearchQueryError);
    expect(() => parseQuery('-- / ** ""')).toThrow(/at least one word/);
    expect(() => parseQuery("-staging")).toThrow(/at least one word/);
  });

  it("gives a tree of groups and exclusions, each item as typed and as words", () => {
    expect(parseQuery('Redis OR memcached "src/App.ts"* -staging').match).toEqual({
      all: [
        [
          { text: "Redis", tokens: ["redis"], prefix: false },
          { text: "memcached", tokens: ["memcached"], prefix: false },
        ],
        [{ text: "src/App.ts", tokens: ["src", "app", "ts"], prefix: true }],
      ],
      none: [{ text: "staging", tokens: ["staging"], prefix: false }],
    });
    expect(tokensOf("git push --force; déjà-vu 2x")).toEqual([
      "git",
      "push",
      "force",
      "déjà",
      "vu",
      "2x",
    ]);
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
      const match = fts5Match(parseQuery(q).match);
      expect(() => db.query("SELECT rowid FROM t WHERE t MATCH ?").all(match), q).not.toThrow();
    }
    const found = (q: string) =>
      (
        db
          .query("SELECT rowid FROM t WHERE t MATCH ?")
          .all(fts5Match(parseQuery(q).match)) as unknown[]
      ).length;
    expect(found("src/app.ts")).toBe(1);
    expect(found("app.ts")).toBe(1);
    expect(found("fla*")).toBe(1);
    expect(found("push -main")).toBe(0);
    expect(found("flaky OR force")).toBe(2);
    expect(found('"test flaky"')).toBe(0);
  });
});
