import type { AllChangesPage, ReadChangesOptions } from "@seshi/model";
import { changeStamp, isOwner, keys, parseChangeKey } from "@seshi/store";
import type { FeedPosition, IndexStore } from "./backend";
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

/** Where `since` starts: before the first entry stamped at that time. */
function sincePosition(since: string): FeedPosition {
  if (!Number.isFinite(Date.parse(since))) {
    throw new SearchQueryError("since must be an RFC 3339 time");
  }
  return { stamp: changeStamp(since), owner: "", name: "" };
}

/** A page of every owner's change feed, read from the index's copy (`FeedState.feed`). */
export function readFeed(index: IndexStore, options: ReadChangesOptions = {}): AllChangesPage {
  const limit = options.limit ?? FEED_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new SearchQueryError("limit must be a whole number of at least 1");
  }
  const after =
    options.after !== undefined
      ? decodeFeedCursor(options.after)
      : options.since !== undefined
        ? sincePosition(options.since)
        : undefined;
  const through = index.feedThrough() as string;
  const page = index.feed(after, Math.min(limit, FEED_MAX_LIMIT));
  const last = page.entries.at(-1);
  return {
    entries: page.entries.map((row) => ({
      owner: row.owner,
      key: `${keys.changes(row.owner)}${row.name}`,
      entry: row.entry,
    })),
    ...(last !== undefined ? { cursor: encodeFeedCursor(last) } : {}),
    truncated: page.more,
    through,
  };
}
