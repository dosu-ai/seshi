/** The two regex engines a rule runs on (F2.2).
 *
 * - **RE2** for every pattern an operator writes (text rules and secret commands in their
 *   packs, and today's JSON rule files). Matching takes time linear in the input: there is no
 *   backtracking, so no pattern can hang the server on crafted input, which matters because a
 *   synchronous regex cannot be interrupted. RE2 refuses backreferences and lookaround. The
 *   engine is `re2js`, a pure-JavaScript port of RE2/J: it loads under Bun and inside the
 *   compiled binary with nothing native or WebAssembly to ship (the native `re2` addon does not
 *   load in a compiled Bun binary). Named groups are written `(?P<name>…)` or `(?<name>…)`.
 * - **JavaScript** `RegExp` for the built-in pack's reviewed patterns, which F2.2 allows; they
 *   are faster, and some need lookbehind.
 *
 * Both give the same `PatternMatcher`: every non-empty match, with the span of a `secret`
 * group when the pattern has one. Indices are UTF-16 code units in both. */

import { RE2JS } from "re2js";

export type Engine = "re2" | "js";

/** One match: the whole span, and the `secret` group's when it took part. */
export interface Match {
  start: number;
  end: number;
  secret?: [number, number];
}

export interface PatternMatcher {
  readonly source: string;
  readonly engine: Engine;
  /** Every non-empty match in `text`, left to right, not overlapping. */
  matches(text: string): Match[];
  /** Whether the pattern matches somewhere in `text`. */
  test(text: string): boolean;
}

/** A pattern that does not compile, with why. */
export class PatternError extends Error {
  constructor(
    readonly pattern: string,
    reason: string,
  ) {
    super(reason);
    this.name = "PatternError";
  }
}

/** RE2's program size past which a pattern is refused: a bound on the memory and per-character
 * work one pattern costs (`a{1000}` style blow-ups). Generous for any secret pattern. */
export const MAX_PROGRAM_SIZE = 20_000;

function re2Message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/\(\?[=!]|\(\?<[=!]|invalid named capture: `\(\?<[=!]/.test(text)) {
    return `${text} (RE2 has no lookahead or lookbehind)`;
  }
  if (/invalid escape sequence: `\\[1-9]/.test(text)) {
    return `${text} (RE2 has no backreferences)`;
  }
  return text;
}

class Re2Matcher implements PatternMatcher {
  readonly engine = "re2";
  private readonly hasSecret: boolean;
  constructor(
    readonly source: string,
    private readonly re: RE2JS,
  ) {
    this.hasSecret = Object.hasOwn(re.namedGroups(), "secret");
  }

  matches(text: string): Match[] {
    const out: Match[] = [];
    const m = this.re.matcher(text);
    while (m.find()) {
      const start = m.start();
      const end = m.end();
      if (start === end) continue;
      const match: Match = { start, end };
      if (this.hasSecret) {
        const s = m.start("secret");
        const e = m.end("secret");
        if (s >= 0 && e >= 0) match.secret = [s, e];
      }
      out.push(match);
    }
    return out;
  }

  test(text: string): boolean {
    return this.re.test(text);
  }
}

class JsMatcher implements PatternMatcher {
  readonly engine = "js";
  /** Without `g`, so `test` keeps no state between calls. */
  private readonly plain: RegExp;
  constructor(
    readonly source: string,
    private readonly re: RegExp,
  ) {
    this.plain = new RegExp(re.source, re.flags.replace(/[gd]/g, ""));
  }

  matches(text: string): Match[] {
    const out: Match[] = [];
    // A fresh copy each time: a global RegExp keeps state between calls.
    const re = new RegExp(this.re.source, this.re.flags);
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const whole = m.indices?.[0];
      if (!whole || whole[0] === whole[1]) {
        re.lastIndex = m.index + 1;
        continue;
      }
      const match: Match = { start: whole[0], end: whole[1] };
      const secret = m.indices?.groups?.secret;
      if (secret) match.secret = [secret[0], secret[1]];
      out.push(match);
    }
    return out;
  }

  test(text: string): boolean {
    return this.plain.test(text);
  }
}

export interface CompileOptions {
  /** Anchor the pattern at the start of the text (secret commands match a command's start). */
  anchored?: boolean;
}

/** Compile `source` on `engine`. Throws `PatternError` for a pattern that does not compile,
 * that matches empty text (it would mark every position of every string), or, on RE2, whose
 * program is too large. */
export function compilePattern(
  source: string,
  engine: Engine,
  options: CompileOptions = {},
): PatternMatcher {
  const body = options.anchored ? `^(?:${source})` : source;
  let matcher: PatternMatcher;
  if (engine === "re2") {
    let re: RE2JS;
    try {
      re = RE2JS.compile(body);
    } catch (err) {
      throw new PatternError(source, re2Message(err));
    }
    if (re.programSize() > MAX_PROGRAM_SIZE) {
      throw new PatternError(
        source,
        `is too large for RE2 (program size ${re.programSize()} > ${MAX_PROGRAM_SIZE})`,
      );
    }
    matcher = new Re2Matcher(source, re);
  } else {
    let re: RegExp;
    try {
      // `d`: where the `secret` group matched; `g`: every match.
      re = new RegExp(body, "dg");
    } catch (err) {
      throw new PatternError(source, err instanceof Error ? err.message : String(err));
    }
    matcher = new JsMatcher(source, re);
  }
  if (matcher.test("")) {
    throw new PatternError(
      source,
      options.anchored ? "matches an empty command" : "matches empty text",
    );
  }
  return matcher;
}
