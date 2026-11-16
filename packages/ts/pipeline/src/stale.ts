import type { FormatRegistry } from "@seshi/formats";
import type { SessionMetadata, StaleSession, StaleSessionsPage } from "@seshi/model";
import type { Store } from "@seshi/store";
import { listSessions } from "./ingest";

/** The session as a stale one, or undefined when it is current (or has nothing stored). */
export function staleSession(
  metadata: SessionMetadata,
  formats: FormatRegistry,
): StaleSession | undefined {
  if (metadata.status !== "stored" || !metadata.head) return undefined;
  const builtWith = metadata.normalizer?.format_version;
  if (!formats.isStale(metadata.agent, builtWith)) return undefined;
  return {
    agent: metadata.agent,
    session_id: metadata.session_id,
    ...(builtWith !== undefined ? { built_with: builtWith } : {}),
    current: formats.versionOf(metadata.agent) as string,
  };
}

/** One page of `owner`'s sessions, keeping the stale ones. Paged as `listSessions` is (by key),
 * so a page can hold none and still be `truncated`. */
export async function staleSessions(
  store: Store,
  owner: string,
  formats: FormatRegistry,
  options: { after?: string; limit?: number } = {},
): Promise<StaleSessionsPage> {
  const page = await listSessions(store, owner, {
    ...(options.after !== undefined ? { startAfter: options.after } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });
  const sessions = page.sessions
    .map((m) => staleSession(m, formats))
    .filter((s): s is StaleSession => s !== undefined);
  return { sessions, cursor: page.cursor, truncated: page.truncated };
}
