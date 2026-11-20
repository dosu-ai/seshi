import type { ChangeEntry, ChangesPage, ReadChangesOptions, SessionMetadata } from "@seshi/model";
import { decodeJson } from "./json";
import { changeStamp, keys } from "./layout";
import { readMetadata } from "./publish";
import { getBytes, type Store } from "./store";

export type { ChangesPage, ReadChangesOptions };

/** The owner's sessions' metadata read so far, by archive id (null: none stored). */
export type MetadataRead = Map<string, SessionMetadata | null>;

/** A page of the owner's change feed. An entry written before seshi 0.16 has no `format`; it
 * gets its session's, from the session's metadata (one read per session, kept in `metadata`
 * for a caller that reads it too). One whose session has no metadata names a write that never
 * landed (its entry is written first), so there is nothing to read, and it is left out. */
export async function readChanges(
  store: Store,
  owner: string,
  options: ReadChangesOptions = {},
  metadata: MetadataRead = new Map(),
): Promise<ChangesPage> {
  const prefix = keys.changes(owner);
  const startAfter =
    options.after ??
    (options.since !== undefined ? `${prefix}${changeStamp(options.since)}` : undefined);
  const page = await store.list(prefix, { startAfter, limit: options.limit });
  const read = await Promise.all(
    page.keys.map(async (key) => {
      const bytes = await getBytes(store, key);
      if (bytes === null) return null;
      return { key, entry: decodeJson<ChangeEntry>(bytes) };
    }),
  );
  const present = read.filter((e): e is { key: string; entry: ChangeEntry } => e !== null);
  const unnamed = new Set(
    present.filter(({ entry }) => entry.format === undefined).map(({ entry }) => entry.archive_id),
  );
  await Promise.all(
    [...unnamed]
      .filter((archive) => !metadata.has(archive))
      .map(async (archive) => metadata.set(archive, await readMetadata(store, owner, archive))),
  );
  const entries = present.flatMap((item) => {
    if (item.entry.format !== undefined) return [item];
    const format = metadata.get(item.entry.archive_id)?.format;
    return format ? [{ key: item.key, entry: entryWithFormat(item.entry, format) }] : [];
  });
  return { entries, cursor: page.keys.at(-1), truncated: page.truncated };
}

/** An entry written without `format` (before seshi 0.16), with its session's beside the
 * session it names, as entries are written now. */
export function entryWithFormat(entry: ChangeEntry, format: string): ChangeEntry {
  const { schema, kind, at, owner, archive_id, session_id, format: _absent, ...rest } = entry;
  return { schema, kind, at, owner, archive_id, session_id, format, ...rest };
}
