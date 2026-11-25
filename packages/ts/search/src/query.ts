export class SearchQueryError extends Error {
  readonly code = "bad_query";
  constructor(message: string) {
    super(message);
    this.name = "SearchQueryError";
  }
}

/** The longest query accepted, in characters. */
export const MAX_QUERY_LENGTH = 1000;
export const MAX_QUERY_TERMS = 32;

interface Item {
  text: string;
  phrase: boolean;
  prefix: boolean;
  negated: boolean;
}

/** A word or phrase to look for. */
export interface MatchItem {
  /** As typed (a phrase without its quotes): for a backend that tokenizes queries itself, as
   * FTS5 does, so they are tokenized as the indexed text was. */
  text: string;
  /** `text`'s words, lower-cased; more than one is a phrase (`src/app.ts` → src, app, ts). */
  tokens: string[];
  /** `word*` or `"a phrase"*`: the last word is a prefix. */
  prefix: boolean;
}

/** A parsed query, which each backend compiles into its own. */
export interface MatchTree {
  /** Every group must match one record; within a group, any item will do. */
  all: MatchItem[][];
  /** A record holding any of these does not match. */
  none: MatchItem[];
}

export interface ParsedQuery {
  match: MatchTree;
  /** The words and phrases to find, as typed (negated ones left out). */
  terms: string[];
}

/** A word or phrase FTS5 can find: at least one letter or digit, which is what the tokenizer
 * keeps. Anything else (`--`, `/`, `"`) would be an empty phrase. */
const TOKEN_CHAR = /[\p{L}\p{N}]/u;

/** A word, as a backend's tokenizer splits text: on anything that is not a letter or digit (or
 * a mark on one). */
export const WORD = /[\p{L}\p{N}\p{M}]+/gu;

/** The words of `text`, lower-cased. */
export function tokensOf(text: string): string[] {
  return (text.match(WORD) ?? []).map((t) => t.toLowerCase());
}

function matchItem(item: Item): MatchItem {
  return { text: item.text, tokens: tokensOf(item.text), prefix: item.prefix };
}

function startsNegation(text: string, at: number): boolean {
  const after = text[at + 1];
  return text[at] === "-" && after !== undefined && (after === '"' || TOKEN_CHAR.test(after));
}

function lex(text: string): (Item | "OR" | "NOT")[] {
  const out: (Item | "OR" | "NOT")[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (/\s/u.test(ch)) {
      i++;
      continue;
    }
    const negated = startsNegation(text, i);
    if (negated) i++;
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

/** The match tree for `text`; `SearchQueryError` when it holds nothing to look for. */
export function parseQuery(text: string): ParsedQuery {
  if (text.length > MAX_QUERY_LENGTH) {
    throw new SearchQueryError(`the query is longer than ${MAX_QUERY_LENGTH} characters`);
  }
  const tokens = lex(text);
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
  return {
    match: { all: groups.map((g) => g.map(matchItem)), none: negated.map(matchItem) },
    terms: groups.flat().map((t) => (t.phrase ? `"${t.text}"` : t.text)),
  };
}
