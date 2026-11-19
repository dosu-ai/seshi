import type { ChangeEntry, ChangesPage, ReadChangesOptions } from "@seshi/model";
import { decodeJson } from "./json";
import { changeStamp, keys } from "./layout";
import { getBytes, type Store } from "./store";

export type { ChangesPage, ReadChangesOptions };

export async function readChanges(
  store: Store,
  owner: string,
  options: ReadChangesOptions = {},
): Promise<ChangesPage> {
  const prefix = keys.changes(owner);
  const startAfter =
    options.after ??
    (options.since !== undefined ? `${prefix}${changeStamp(options.since)}` : undefined);
  const page = await store.list(prefix, { startAfter, limit: options.limit });
  const entries = await Promise.all(
    page.keys.map(async (key) => {
      const bytes = await getBytes(store, key);
      if (bytes === null) return null;
      return { key, entry: decodeJson<ChangeEntry>(bytes) };
    }),
  );
  const present = entries.filter((e): e is { key: string; entry: ChangeEntry } => e !== null);
  return { entries: present, cursor: page.keys.at(-1), truncated: page.truncated };
}
