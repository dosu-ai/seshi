import type { AllChangesPage, ReadChangesOptions } from "@seshi/model";
import { changeStamp, isOwner, keys, parseChangeKey } from "@seshi/store";
import type { FeedPosition, IndexReader } from "./backend";
import { SearchQueryError } from "./query";

export const FEED_DEFAULT_LIMIT = 100;
export const FEED_MAX_LIMIT = 1000;

const CURSOR_VERSION = "1";

/** A cursor names a place in the order itself (stamp, owner, key), never a row of this
 * instance's file: it means the same after a restart, a rebuild or on another instance. */
export function encodeFeedCursor(at: FeedPosition): string {
  return Buffer.from([CURSOR_VERSION, at.stamp, at.owner, at.name].join("\n")).toString(
    "base64url",
  );
}

export function decodeFeedCursor(cursor: string): FeedPosition {
  const parts = Buffer.from(cursor, "base64url").toString("utf8").split("\n");
  const [version, stamp, owner, name] = parts;
  if (
    parts.length !== 4 ||
    version !== CURSOR_VERSION ||
    stamp === undefined ||
    owner === undefined ||
    name === undefined ||
    !isOwner(owner) ||
    !name.startsWith(`${stamp}-`) ||
    parseChangeKey(name) === null
  ) {
    throw new SearchQueryError("after is not a cursor this feed gave");
  }
  return { stamp, owner, name };
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** Where `since` starts: before the first entry stamped at that time. */
function sincePosition(since: string): FeedPosition {
  if (!RFC3339.test(since) || !Number.isFinite(Date.parse(since))) {
    throw new SearchQueryError("since must be an RFC 3339 time");
  }
  return { stamp: changeStamp(since), owner: "", name: "" };
}

/** A page of every owner's change feed, read from the index's copy (`IndexReader.feed`); null
 * until every owner's feed has been read once. `limit` is the caller's to check (the route's
 * `intParam`); it is only capped here. */
export async function readFeed(
  index: IndexReader,
  options: ReadChangesOptions = {},
): Promise<AllChangesPage | null> {
  const limit = Math.min(options.limit ?? FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT);
  const after =
    options.after !== undefined
      ? decodeFeedCursor(options.after)
      : options.since !== undefined
        ? sincePosition(options.since)
        : undefined;
  const page = await index.feed(after, limit);
  if (page === null) return null;
  const last = page.entries.at(-1);
  return {
    entries: page.entries.map((row) => ({
      owner: row.owner,
      key: `${keys.changes(row.owner)}${row.name}`,
      entry: row.entry,
    })),
    ...(last !== undefined ? { cursor: encodeFeedCursor(last) } : {}),
    truncated: page.more,
    through: page.through,
  };
}
