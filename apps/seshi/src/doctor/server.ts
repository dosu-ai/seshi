import type { ChangeEntry } from "@seshi/model";
import { type Backend, LocalBackend, ServerBackend } from "../backend";
import type { ServerView } from "./deps";

const CHANGE_PAGE = 1000;

export function serverView(backend: Backend): ServerView {
  const view: ServerView = {
    mode: backend.mode,
    where: backend.where,
    getSession: (agent, id) => backend.getSession(agent, id),
    getTrace: (agent, id, hash) => backend.getTrace(agent, id, { hash }),
    reviews: (agent, id) => backend.reviews(agent, id),
    search: (q, agent) => backend.search({ q, agent, limit: 50 }),
  };
  if (backend instanceof ServerBackend) {
    view.changes = (since, limit) =>
      readAll(
        (after) =>
          backend.db.changes(after ? { after, limit: CHANGE_PAGE } : { since, limit: CHANGE_PAGE }),
        limit,
      );
  }
  if (backend instanceof LocalBackend) {
    const { instance, owner } = backend;
    view.pointer = async (agent, id) => {
      const { getSession } = await import("@seshi/pipeline");
      return getSession(instance.store, owner, agent, id);
    };
    view.changes = async (since, limit) => {
      const { readChanges } = await import("@seshi/store");
      return readAll(
        (after) =>
          readChanges(
            instance.store,
            owner,
            after ? { after, limit: CHANGE_PAGE } : { since, limit: CHANGE_PAGE },
          ),
        limit,
      );
    };
  }
  return view;
}

async function readAll(
  page: (after?: string) => Promise<{
    entries: { key: string; entry: ChangeEntry }[];
    cursor: string | undefined;
    truncated: boolean;
  }>,
  limit: number,
): Promise<{ key: string; entry: ChangeEntry }[]> {
  const all: { key: string; entry: ChangeEntry }[] = [];
  let after: string | undefined;
  for (;;) {
    const got = await page(after);
    all.push(...got.entries);
    if (!got.truncated || got.cursor === undefined || all.length >= limit)
      return all.slice(0, limit);
    after = got.cursor;
  }
}
