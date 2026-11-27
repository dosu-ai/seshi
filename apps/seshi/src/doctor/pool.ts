/** A sql worker pool's numbers as the CLI shows them, and a running server's pool as its
 * `GET /v1/admin/jobs` reports it. Kept apart from `./sql` so `seshi workers status` does not
 * load the sql engine to print one line. */

import type { JobsStatus, SqlPoolStatus } from "@seshi/client";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The pool's numbers as a line: `2 started, 0 busy, 0 queued, 0 restarted`. */
export function poolLine(pool: SqlPoolStatus): string {
  return `${pool.workers} started, ${pool.busy} busy, ${pool.queued} queued, ${pool.restarts} restarted`;
}

/** A server process's pool: none until its first statement starts them. */
export function serverPoolText(pool: SqlPoolStatus | null): string {
  return pool ? poolLine(pool) : "none started yet (a server starts them with its first statement)";
}

/** What a running server said of its sql workers. */
export interface ServerPool {
  server: string;
  /** Its pool: null before its first statement. Absent when it could not be read. */
  workers?: SqlPoolStatus | null;
  /** Why it could not be read: refused, unreachable, or not reported. */
  error?: string;
}

/** Ask `server` for its sql workers (`GET /v1/admin/jobs`, an admin's). Each api process keeps
 * its own, so behind a load balancer this is the one that took the request. Never throws. */
export async function serverPool(
  server: string,
  ask: () => Promise<Pick<JobsStatus, "sql">>,
): Promise<ServerPool> {
  try {
    const status = await ask();
    if (status.sql === undefined) {
      return {
        server,
        error: "it does not report sql workers (search is off there, or it runs an older seshi)",
      };
    }
    return { server, workers: status.sql };
  } catch (err) {
    return { server, error: message(err) };
  }
}
