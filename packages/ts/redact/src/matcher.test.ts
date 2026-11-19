import { describe, expect, it } from "vitest";
import { compilePattern, MAX_PROGRAM_SIZE, PatternError } from "./matcher";

describe("compilePattern on RE2", () => {
  it("finds every non-empty match, with the secret group's span, in UTF-16 indices", () => {
    const m = compilePattern("api-key: (?P<secret>\\S+)", "re2");
    const text = "héllo 😀 api-key: abc123 and api-key: zzz";
    const matches = m.matches(text);
    expect(matches.map((x) => text.slice(x.start, x.end))).toEqual([
      "api-key: abc123",
      "api-key: zzz",
    ]);
    expect(matches.map((x) => (x.secret ? text.slice(...x.secret) : null))).toEqual([
      "abc123",
      "zzz",
    ]);
    expect(m.engine).toBe("re2");
  });

  it("takes (?<name>…) for a named group too", () => {
    const [match] = compilePattern("(?<secret>x+)y", "re2").matches("..xxy");
    expect(match?.secret).toEqual([2, 4]);
  });

  it("gives no secret span when the group did not take part", () => {
    const [match] = compilePattern("a(?P<secret>b)?c|zz", "re2").matches("zz");
    expect(match).toEqual({ start: 0, end: 2 });
  });

  it("is case-insensitive with (?i)", () => {
    expect(compilePattern("(?i)secret", "re2").test("SeCrEt")).toBe(true);
  });

  it("refuses patterns RE2 cannot run, saying why", () => {
    const why = (source: string) => {
      try {
        compilePattern(source, "re2");
        return "compiled";
      } catch (err) {
        expect(err).toBeInstanceOf(PatternError);
        return (err as Error).message;
      }
    };
    expect(why("(?<=a)b")).toMatch(/no lookahead or lookbehind/);
    expect(why("a(?=b)")).toMatch(/no lookahead or lookbehind/);
    expect(why("(a)\\1")).toMatch(/no backreferences/);
    expect(why("(")).toMatch(/missing closing/);
    expect(why("a{1001}")).toMatch(/repeat count/);
    expect(why("x*")).toBe("matches empty text");
    expect(why("[a-z]{1000}".repeat(21))).toMatch(
      new RegExp(`too large for RE2 .* > ${MAX_PROGRAM_SIZE}`),
    );
  });

  it("matches in linear time where a backtracking engine would hang", () => {
    const m = compilePattern("(a+)+$", "re2");
    const started = performance.now();
    expect(m.test(`${"a".repeat(50_000)}!`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("anchors a command pattern at the start", () => {
    const m = compilePattern("acme\\s+token", "re2", { anchored: true });
    expect(m.test("acme token")).toBe(true);
    expect(m.test("echo acme token")).toBe(false);
    expect(() => compilePattern("x?", "re2", { anchored: true })).toThrow(
      "matches an empty command",
    );
  });
});

describe("compilePattern on JavaScript", () => {
  it("finds the same matches and secret spans, and steps past empty ones", () => {
    const m = compilePattern("key=(?<secret>\\w+)|(?=q)", "js");
    const text = "key=a1 q key=b2";
    expect(m.matches(text)).toEqual([
      { start: 0, end: 6, secret: [4, 6] },
      { start: 9, end: 15, secret: [13, 15] },
    ]);
    expect(m.engine).toBe("js");
    // `test` keeps no state between calls.
    expect([m.test(text), m.test(text), m.test(text)]).toEqual([true, true, true]);
  });

  it("allows lookbehind, for reviewed built-in patterns", () => {
    expect(compilePattern("(?<=k=)v+", "js").matches("k=vv")).toEqual([{ start: 2, end: 4 }]);
    expect(() => compilePattern("(", "js")).toThrow(PatternError);
    expect(() => compilePattern("a*", "js")).toThrow("matches empty text");
  });
});
