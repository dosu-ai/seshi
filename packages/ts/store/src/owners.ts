import { assertOwner, isOwner, keys } from "./layout";
import type { Store } from "./store";

const PAST_FOLDER = "\u{10FFFF}";

export interface OwnersPage {
  owners: string[];
  cursor: string | undefined;
  truncated: boolean;
}

/** Owner ids in key order, up to `limit` (100 by default), after the owner `after`. A folder
 * whose name is not a valid owner id (written by hand) is skipped. */
export async function listOwners(
  store: Store,
  options: { after?: string; limit?: number } = {},
): Promise<OwnersPage> {
  const limit = options.limit ?? 100;
  const prefix = keys.owners();
  const owners: string[] = [];
  let startAfter =
    options.after === undefined
      ? undefined
      : `${keys.owner(assertOwner(options.after))}/${PAST_FOLDER}`;
  while (owners.length < limit) {
    const page = await store.list(prefix, { startAfter, limit: 1 });
    const key = page.keys[0];
    if (key === undefined) return { owners, cursor: owners.at(-1), truncated: false };
    const name = key.slice(prefix.length).split("/", 1)[0] as string;
    if (isOwner(name)) owners.push(name);
    startAfter = `${prefix}${name}/${PAST_FOLDER}`;
  }
  const more = await store.list(prefix, { startAfter, limit: 1 });
  return { owners, cursor: owners.at(-1), truncated: more.keys.length > 0 };
}
