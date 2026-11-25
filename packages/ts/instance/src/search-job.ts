import type { JobHost } from "./builtin-jobs";
import type { Job } from "./jobs";

export const SEARCH_JOB = "search-index";

/** The indexer (F10.2). With SQLite every API instance keeps its own index, so it runs on
 * each of them. With LanceDB one index serves every instance, and only the worker writes it
 * (F10.8): it runs there, with or without the api role. */
export function searchIndexJobs(host: JobHost): Job[] {
  const search = host.search;
  if (search === undefined) return [];
  const shared = search.shared;
  if (!host.roles.includes(shared ? "worker" : "api")) return [];
  return [
    {
      name: SEARCH_JOB,
      kind: "indexer",
      placement: shared ? "worker" : "every",
      intervalMs: host.config.search.interval,
      async run(signal) {
        const run = await search.run(signal);
        return {
          more: run.more,
          summary: {
            owners: run.owners,
            entries: run.entries,
            indexed: run.indexed,
            removed: run.removed,
          },
        };
      },
      async backlog() {
        const status = await search.status();
        const caughtUp = status.caught_up_at ? Date.parse(status.caught_up_at) : Number.NaN;
        return {
          ready: status.ready ? 1 : 0,
          sessions: status.sessions,
          events: status.events,
          ...(shared ? { building: status.building ? 1 : 0 } : {}),
          ...(Number.isFinite(caughtUp)
            ? { caught_up_age_ms: Math.max(0, host.now().getTime() - caughtUp) }
            : {}),
        };
      },
    },
  ];
}
