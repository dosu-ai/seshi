/** What LanceIndex runs for a query, built without LanceDB: the filter as SQL text, the
 * full-text query as a plain tree (turned into LanceDB's classes by `lance.ts`), and the check
 * prefix queries need. Kept apart so the escaping can be tested on its own, with hostile
 * values. */
import type { BackendQuery } from "@seshi/search";
import { type MatchItem, type MatchTree, SearchQueryError, WORD } from "@seshi/search";

/** A prefix must have at least this many letters (`de*`, not `d*`). */
export const PREFIX_MIN = 2;
/** `text_prefix` holds each word's first 2 to `PREFIX_MAX` letters. A longer prefix finds its
 * candidates by its first `PREFIX_MAX` letters, and the check does the rest. */
export const PREFIX_MAX = 8;

/** A control character: U+0000 to U+001F, or U+007F. */
function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A string literal for LanceDB's SQL filter, which takes no bound parameters: quotes doubled,
 * control characters refused. Every value that reaches a filter goes through here. */
export function sqlString(value: string): string {
  if (hasControl(value)) throw new SearchQueryError("a filter value holds a control character");
  return `'${value.replaceAll("'", "''")}'`;
}

/** A `LIKE` pattern's literal part: `\`, `%` and `_` escaped with `\` (the filter says
 * `ESCAPE '\'`). */
export function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function sqlList(values: readonly string[]): string {
  return values.map(sqlString).join(", ");
}

/** An epoch-ms time for a filter; anything but a whole number is refused. */
export function sqlTime(ms: number): string {
  if (!Number.isSafeInteger(ms)) throw new SearchQueryError("a time filter is not a time");
  return `to_timestamp_millis(${ms})`;
}

/** The `where` for a query on `events`, or null when nothing can match (no owners, or an
 * own-only viewer who owns nothing). */
export function filterSql(
  q: Omit<BackendQuery, "match" | "sort" | "limit" | "offset" | "matches">,
): string | null {
  const where: string[] = [];
  const { viewer } = q;
  if (viewer.ownOnly) {
    if (viewer.own.length === 0) return null;
    where.push(`owner IN (${sqlList(viewer.own)})`);
  } else if (!viewer.everything) {
    where.push(
      viewer.own.length > 0
        ? `(visibility = 'org' OR owner IN (${sqlList(viewer.own)}))`
        : "visibility = 'org'",
    );
  }
  if (q.owners !== undefined) {
    if (q.owners.length === 0) return null;
    where.push(`owner IN (${sqlList(q.owners)})`);
  }
  if (q.agent !== undefined) {
    where.push(`(format = ${sqlString(q.agent)} OR origin_agent = ${sqlString(q.agent)})`);
  }
  if (q.repo !== undefined) {
    // As SQLite matches it: the normalized remote, or its owner/name ending, any case.
    where.push(
      `(lower(repo) = lower(${sqlString(q.repo)}) OR lower(repo) LIKE lower(${sqlString(
        `%/${likeLiteral(q.repo)}`,
      )}) ESCAPE '\\')`,
    );
  }
  if (q.branch !== undefined) where.push(`branch = ${sqlString(q.branch)}`);
  if (q.harness !== undefined) where.push(`harness = ${sqlString(q.harness)}`);
  if (q.agent_version !== undefined) where.push(`agent_version = ${sqlString(q.agent_version)}`);
  if (q.model !== undefined) where.push(`array_has_any(models, [${sqlString(q.model)}])`);
  const labels = Object.entries(q.labels ?? {}).map(([k, v]) => `${k}=${v}`);
  if (labels.length > 0) where.push(`array_has_all(labels, [${sqlList(labels)}])`);
  if (q.source !== undefined) where.push(`source_id = ${sqlString(q.source)}`);
  if (q.roles !== undefined) {
    if (q.roles.length === 0) return null;
    where.push(`role IN (${sqlList(q.roles)})`);
  }
  if (q.since !== undefined) where.push(`coalesce(ts, session_updated) >= ${sqlTime(q.since)}`);
  if (q.until !== undefined) where.push(`coalesce(ts, session_updated) <= ${sqlTime(q.until)}`);
  return where.join(" AND ");
}

/** A full-text query, as LanceDB's classes take it. */
export type FtsQuery =
  | { match: string; column: "text" | "text_prefix"; and?: boolean }
  | { phrase: string; column: "text" }
  | { bool: [Occur, FtsQuery][] };
export type Occur = "must" | "should" | "must_not";

/** A word as compared: lower-cased, accents removed. `excerpt()` folds the same way. */
export function fold(word: string): string {
  return word.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** A record's words, folded. */
export function foldedWords(text: string): string[] {
  return (text.match(WORD) ?? []).map(fold).filter((w) => w !== "");
}

/** What `text_prefix` holds for a record: each distinct word's first 2 to `PREFIX_MAX` letters,
 * folded, as space-separated tokens. LanceDB 0.41.0's ngram tokenizer with `prefixOnly`
 * indexes only the prefixes of the whole value (its first word), so the prefixes are written
 * out here and indexed with the plain tokenizer. */
export function prefixesOf(text: string): string {
  const out = new Set<string>();
  for (const word of foldedWords(text)) {
    for (let n = PREFIX_MIN; n <= Math.min(PREFIX_MAX, word.length); n++) out.add(word.slice(0, n));
  }
  return [...out].join(" ");
}

function prefixToken(item: MatchItem): string {
  const last = fold(item.tokens.at(-1) ?? "");
  if (last.length < PREFIX_MIN) {
    throw new SearchQueryError(`a prefix needs at least ${PREFIX_MIN} letters: ${item.text}*`);
  }
  return last.slice(0, PREFIX_MAX);
}

function itemQuery(item: MatchItem): FtsQuery {
  const words = item.tokens;
  if (!item.prefix) {
    return words.length === 1
      ? { match: words[0] as string, column: "text" }
      : { phrase: words.join(" "), column: "text" };
  }
  const candidates: FtsQuery = { match: prefixToken(item), column: "text_prefix" };
  if (words.length === 1) return candidates;
  const whole = words.slice(0, -1);
  return {
    bool: [
      [
        "must",
        whole.length === 1
          ? { match: whole[0] as string, column: "text" }
          : { phrase: whole.join(" "), column: "text" },
      ],
      ["must", candidates],
    ],
  };
}

/** Whether the tree holds a prefix, so the full-text query only finds candidates and
 * `matchesTree` decides. */
export function needsCheck(tree: MatchTree): boolean {
  return [...tree.all.flat(), ...tree.none].some((item) => item.prefix);
}

/** The full-text query for `tree`. Plain words go in one `MatchQuery` with `Operator.And` (far
 * faster than one clause per word); phrases, OR groups and NOT make it a `BooleanQuery`. A
 * negated prefix is left to `matchesTree`: its candidate clause would also drop records that
 * only share a prefix token's letters with another word. */
export function compileMatch(tree: MatchTree): FtsQuery {
  const words: string[] = [];
  const clauses: [Occur, FtsQuery][] = [];
  for (const group of tree.all) {
    if (group.length === 1) {
      const item = group[0] as MatchItem;
      if (!item.prefix && item.tokens.length === 1) words.push(item.tokens[0] as string);
      else clauses.push(["must", itemQuery(item)]);
    } else {
      clauses.push(["must", { bool: group.map((item) => ["should", itemQuery(item)]) }]);
    }
  }
  if (words.length > 0) {
    clauses.unshift(["must", { match: words.join(" "), column: "text", and: true }]);
  }
  for (const item of tree.none) if (!item.prefix) clauses.push(["must_not", itemQuery(item)]);
  if (clauses.length === 1 && clauses[0]?.[0] === "must") return clauses[0][1];
  return { bool: clauses };
}

function holds(words: readonly string[], item: MatchItem): boolean {
  const tokens = item.tokens.map(fold);
  if (tokens.length === 0) return false;
  for (let i = 0; i + tokens.length <= words.length; i++) {
    let hit = true;
    for (let k = 0; k < tokens.length; k++) {
      const word = words[i + k] as string;
      const token = tokens[k] as string;
      if (item.prefix && k === tokens.length - 1 ? !word.startsWith(token) : word !== token) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/** Whether a record's text matches `tree`, word by word after folding: what a prefix query's
 * candidates are checked with. */
export function matchesTree(text: string, tree: MatchTree): boolean {
  const words = foldedWords(text);
  return (
    tree.all.every((group) => group.some((item) => holds(words, item))) &&
    !tree.none.some((item) => holds(words, item))
  );
}
