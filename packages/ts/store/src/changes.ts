import type { ChangeEntry, ChangesPage, ReadChangesOptions } from "@seshi/model";
import { decodeJson } from "./json";
import { changeStamp, keys } from "./layout";
import { readMetadata } from "./publish";
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
  await fillFormats(store, owner, present);
  return { entries: present, cursor: page.keys.at(-1), truncated: page.truncated };
}

/** Give each entry written before seshi 0.15, which has no `format`, its session's format from
 * the session's metadata: one read per session. An entry whose session has no metadata (an
 * entry for a first write that failed) is left without one. */
async function fillFormats(
  store: Store,
  owner: string,
  items: { entry: ChangeEntry }[],
): Promise<void> {
  const missing = new Set<string>();
  for (const { entry } of items) {
    if (entry.format === undefined) missing.add(entry.archive_id);
  }
  if (missing.size === 0) return;
  const formats = new Map<string, string>();
  await Promise.all(
    [...missing].map(async (archive) => {
      const metadata = await readMetadata(store, owner, archive);
      if (metadata?.format) formats.set(archive, metadata.format);
    }),
  );
  for (const item of items) {
    const format = item.entry.format ?? formats.get(item.entry.archive_id);
    if (format !== undefined) item.entry = withFormat(item.entry, format);
  }
}

/** The entry with `format` beside the session it names, as entries are written now. */
export function withFormat(entry: ChangeEntry, format: string): ChangeEntry {
  if (entry.format !== undefined) return entry;
  const { schema, kind, at, owner, archive_id, session_id, format: _none, ...rest } = entry;
  return { schema, kind, at, owner, archive_id, session_id, format, ...rest };
}
