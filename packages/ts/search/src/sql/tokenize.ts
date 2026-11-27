/** SQLite's own tokenizer (`tokenize.c`, `sqlite3GetToken`), ported so the statement check sees
 * the text the way SQLite will: which characters are a string, a quoted name, a comment or a
 * statement separator. The parser that builds the tree is a general one (sqlparser-rs), and a
 * place where its lexing differs from SQLite's could hide a table from the tree that SQLite then
 * reads; checks made on these tokens cannot be fooled that way. */

export type TokenKind =
  | "space"
  | "comment"
  | "string"
  | "id"
  | "variable"
  | "number"
  | "blob"
  | "semi"
  | "dot"
  | "lparen"
  | "rparen"
  | "comma"
  | "operator"
  | "illegal";

export interface Token {
  kind: TokenKind;
  /** Offset of the first character, in UTF-16 code units. */
  at: number;
  /** The token's text as written. */
  text: string;
  /** For `id`: the name, with its quotes removed and doubled quotes undone. */
  name?: string;
  /** For `id`: it was quoted (`"x"`, `` `x` `` or `[x]`), so it is never a keyword. */
  quoted?: boolean;
}

/** SQLite's whitespace: space, tab, newline, form feed, carriage return (not vertical tab). */
function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function isHex(c: number): boolean {
  return isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

/** A character that may continue an identifier: letters, digits, `_`, `$` and every character
 * at or above 0x80 (SQLite treats them all as identifier characters). */
function isIdChar(c: number): boolean {
  return (
    (c >= 0x61 && c <= 0x7a) ||
    (c >= 0x41 && c <= 0x5a) ||
    isDigit(c) ||
    c === 0x5f ||
    c === 0x24 ||
    c >= 0x80
  );
}

/** A character that may start an identifier: as above, without digits and `$`. */
function isIdStart(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || c >= 0x80;
}

/** One token at `i`. Never empty: an unrecognized character is one `illegal` token. */
function next(sql: string, i: number): Token {
  const c = sql.charCodeAt(i);
  const one = (kind: TokenKind, length = 1): Token => ({
    kind,
    at: i,
    text: sql.slice(i, i + length),
  });
  const at = (k: number) => sql.charCodeAt(k);
  if (isSpace(c)) {
    let j = i + 1;
    while (j < sql.length && isSpace(at(j))) j++;
    return one("space", j - i);
  }
  switch (c) {
    case 0x2d: // -
      if (at(i + 1) === 0x2d) {
        let j = i + 2;
        while (j < sql.length && at(j) !== 0x0a) j++;
        return one("comment", j - i);
      }
      if (at(i + 1) === 0x3e) return one("operator", at(i + 2) === 0x3e ? 3 : 2);
      return one("operator");
    case 0x28:
      return one("lparen");
    case 0x29:
      return one("rparen");
    case 0x3b:
      return one("semi");
    case 0x2c:
      return one("comma");
    case 0x2b: // +
    case 0x2a: // *
    case 0x25: // %
    case 0x26: // &
    case 0x7e: // ~
      return one("operator");
    case 0x2f: // /
      if (at(i + 1) === 0x2a) {
        // An unterminated comment runs to the end of the text, as SQLite reads it.
        const end = sql.indexOf("*/", i + 2);
        return one("comment", end === -1 ? sql.length - i : end + 2 - i);
      }
      return one("operator");
    case 0x3d: // =
      return one("operator", at(i + 1) === 0x3d ? 2 : 1);
    case 0x3c: // <
      return one(
        "operator",
        at(i + 1) === 0x3d || at(i + 1) === 0x3e || at(i + 1) === 0x3c ? 2 : 1,
      );
    case 0x3e: // >
      return one("operator", at(i + 1) === 0x3d || at(i + 1) === 0x3e ? 2 : 1);
    case 0x21: // !
      return at(i + 1) === 0x3d ? one("operator", 2) : one("illegal");
    case 0x7c: // |
      return one("operator", at(i + 1) === 0x7c ? 2 : 1);
    case 0x27: // '
    case 0x22: // "
    case 0x60: {
      // `
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) return one("illegal", sql.length - i);
        if (at(j) === c) {
          if (at(j + 1) === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      const text = sql.slice(i, j + 1);
      const quote = String.fromCharCode(c);
      const inner = text.slice(1, -1).replaceAll(quote + quote, quote);
      return c === 0x27
        ? { kind: "string", at: i, text }
        : { kind: "id", at: i, text, name: inner, quoted: true };
    }
    case 0x2e: // .
      if (!isDigit(at(i + 1))) return one("dot");
      return number(sql, i);
    case 0x5b: {
      // [name]
      const end = sql.indexOf("]", i + 1);
      if (end === -1) return one("illegal", sql.length - i);
      const text = sql.slice(i, end + 1);
      return { kind: "id", at: i, text, name: text.slice(1, -1), quoted: true };
    }
    case 0x3f: {
      // ?NNN
      let j = i + 1;
      while (j < sql.length && isDigit(at(j))) j++;
      return one("variable", j - i);
    }
    case 0x24: // $
    case 0x40: // @
    case 0x3a: // :
    case 0x23: {
      // # (a variable, or illegal when nothing follows)
      let j = i + 1;
      while (j < sql.length && isIdChar(at(j))) j++;
      return j === i + 1 ? one("illegal") : one("variable", j - i);
    }
  }
  if (isDigit(c)) return number(sql, i);
  if ((c === 0x78 || c === 0x58) && at(i + 1) === 0x27) {
    // x'hex'
    let j = i + 2;
    while (j < sql.length && isHex(at(j))) j++;
    if (at(j) !== 0x27 || (j - i - 2) % 2 !== 0) {
      while (j < sql.length && at(j) !== 0x27) j++;
      return one("illegal", Math.min(j + 1, sql.length) - i);
    }
    return one("blob", j + 1 - i);
  }
  if (isIdStart(c)) {
    let j = i + 1;
    while (j < sql.length && isIdChar(at(j))) j++;
    const text = sql.slice(i, j);
    return { kind: "id", at: i, text, name: text };
  }
  return one("illegal");
}

/** A number at `i`: decimal (with `_` between digits), a fraction, an exponent, or `0x` hex. A
 * number run into identifier characters (`12abc`) is illegal, as in SQLite. */
function number(sql: string, i: number): Token {
  const at = (k: number) => sql.charCodeAt(k);
  let j = i;
  const digits = (test: (c: number) => boolean) => {
    while (j < sql.length && (test(at(j)) || (at(j) === 0x5f && test(at(j + 1))))) j++;
  };
  if (at(j) === 0x30 && (at(j + 1) === 0x78 || at(j + 1) === 0x58) && isHex(at(j + 2))) {
    j += 2;
    digits(isHex);
  } else {
    digits(isDigit);
    if (at(j) === 0x2e) {
      j++;
      digits(isDigit);
    }
    if (
      (at(j) === 0x65 || at(j) === 0x45) &&
      (isDigit(at(j + 1)) || ((at(j + 1) === 0x2b || at(j + 1) === 0x2d) && isDigit(at(j + 2))))
    ) {
      j += 2;
      digits(isDigit);
    }
  }
  if (j < sql.length && isIdChar(at(j))) {
    while (j < sql.length && isIdChar(at(j))) j++;
    return { kind: "illegal", at: i, text: sql.slice(i, j) };
  }
  return { kind: "number", at: i, text: sql.slice(i, j) };
}

/** Every token of `sql`, whitespace and comments included. */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const token = next(sql, i);
    tokens.push(token);
    i += token.text.length;
  }
  return tokens;
}

/** The tokens that are not whitespace or comments. */
export function significant(tokens: readonly Token[]): Token[] {
  return tokens.filter((t) => t.kind !== "space" && t.kind !== "comment");
}

/** An identifier's name folded as SQLite folds names: ASCII letters only. */
export function foldName(name: string): string {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase());
}
