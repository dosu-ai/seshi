/** The keyword syntax `seshi search` and `GET /v1/search` accept, turned into an SQLite FTS5
 * match expression. People type words, paths and commands, not FTS5: `src/app.ts`, `git
 * push --force` or a stray `"` must never be a syntax error or reach FTS5 as an operator, so
 * every word becomes a quoted FTS5 string, and only these forms mean anything:
 *
 * - words: all must appear, in any order (`flaky test`);
 * - `"a phrase"`: the words in that order;
 * - `word*`: words starting with `word`;
 * - `a OR b`: either (upper case `OR` between two words or phrases);
 * - `-word`, `-"a phrase"`, or `NOT word`: records without it (`--force` is a word).
 *
 * Case and accents are ignored (the index's tokenizer folds both). Punctuation separates words,
 * so `src/app.ts` finds the words `src`, `app`, `ts` next to each other. */

/** Something about the search request is wrong; the API answers 400 `bad_query`. */
export class SearchQueryError extends Error {
  readonly code = "bad_query";
  constructor(message: string) {
    super(message);
    this.name = "SearchQueryError";
  }
}

/** The longest query accepted, in characters. */
export const MAX_QUERY_LENGTH = 1000;
/** The most words and phrases one query may hold. */
export const MAX_QUERY_TERMS = 32;

interface Item {
  text: string;
  phrase: boolean;
  prefix: boolean;
  negated: boolean;
}

export interface ParsedQuery {
  /** The FTS5 match expression. */
  match: string;
  /** The words and phrases to find, as typed (negated ones left out). */
  terms: string[];
}

/** A word or phrase FTS5 can find: at least one letter or digit, which is what the tokenizer
 * keeps. Anything else (`--`, `/`, `"`) would be an empty phrase. */
const TOKEN_CHAR = /[\p{L}\p{N}]/u;

function quoted(item: Item): string {
  const body = `"${item.text.replaceAll('"', '""')}"`;
  return item.prefix ? `${body} *` : body;
}

/** Split `text` into items, honouring quotes, `-` and `*`, and the bare operators. */
function lex(text: string): (Item | "OR" | "NOT")[] {
  const out: (Item | "OR" | "NOT")[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (/\s/u.test(ch)) {
      i++;
      continue;
    }
    // `-word` and `-"phrase"` exclude; `--force` and `-` alone are words (a flag, a dash).
    let negated = false;
    const after = text[i + 1];
    if (ch === "-" && after !== undefined && (after === '"' || TOKEN_CHAR.test(after))) {
      negated = true;
      i++;
    }
    if (text[i] === '"') {
      const end = text.indexOf('"', i + 1);
      const body = end === -1 ? text.slice(i + 1) : text.slice(i + 1, end);
      i = end === -1 ? text.length : end + 1;
      let prefix = false;
      if (text[i] === "*") {
        prefix = true;
        i++;
      }
      out.push({ text: body, phrase: true, prefix, negated });
      continue;
    }
    let j = i;
    while (j < text.length && !/\s/u.test(text[j] as string)) j++;
    let word = text.slice(i, j);
    i = j;
    if (!negated && (word === "OR" || word === "NOT")) {
      out.push(word);
      continue;
    }
    if (!negated && word === "AND") continue;
    let prefix = false;
    if (word.endsWith("*")) {
      word = word.replace(/\*+$/, "");
      prefix = true;
    }
    out.push({ text: word, phrase: false, prefix, negated });
  }
  return out;
}

/** The FTS5 expression for `text`; `SearchQueryError` when it holds nothing to look for. */
export function parseQuery(text: string): ParsedQuery {
  if (text.length > MAX_QUERY_LENGTH) {
    throw new SearchQueryError(`the query is longer than ${MAX_QUERY_LENGTH} characters`);
  }
  const tokens = lex(text);
  // `NOT x` is `-x`; a NOT with nothing after it is dropped.
  const items: (Item | "OR")[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k] as Item | "OR" | "NOT";
    if (token === "NOT") {
      const next = tokens[k + 1];
      if (next !== undefined && next !== "OR" && next !== "NOT") {
        items.push({ ...next, negated: true });
        k++;
      }
      continue;
    }
    items.push(token);
  }
  const usable = items.filter((t) => t === "OR" || TOKEN_CHAR.test(t.text));
  const count = usable.filter((t) => t !== "OR").length;
  if (count > MAX_QUERY_TERMS) {
    throw new SearchQueryError(`the query has more than ${MAX_QUERY_TERMS} words and phrases`);
  }

  // Positive items grouped by OR; negated items apart.
  const groups: Item[][] = [];
  const negated: Item[] = [];
  let joinNext = false;
  for (const token of usable) {
    if (token === "OR") {
      joinNext = groups.length > 0;
      continue;
    }
    if (token.negated) {
      negated.push(token);
      joinNext = false;
      continue;
    }
    if (joinNext) (groups.at(-1) as Item[]).push(token);
    else groups.push([token]);
    joinNext = false;
  }
  if (groups.length === 0) {
    throw new SearchQueryError("the query needs at least one word to look for");
  }
  const positive = groups
    .map((g) => (g.length === 1 ? quoted(g[0] as Item) : `(${g.map(quoted).join(" OR ")})`))
    .join(" AND ");
  const match =
    negated.length === 0 ? positive : `(${positive}) NOT (${negated.map(quoted).join(" OR ")})`;
  return {
    match,
    terms: groups.flat().map((t) => (t.phrase ? `"${t.text}"` : t.text)),
  };
}
