/** The Cursor Cloud poller (F7): a `type = "cursor-cloud"` source.
 *
 * Each poll lists the agents the source's Cursor API key can see and, for each agent whose
 * `updatedAt` moved since the last poll, its runs. Every run that has ended and is not stored
 * yet is replayed from Cursor's event stream and appended, as one line, to the agent's session
 * (`cursor-cloud-api`, one session per agent, X4.7). Runs go in order: a run still going holds
 * back the ones after it, so a session's log only grows.
 *
 * Cursor keeps a run's events for 24 hours (`X-Cursor-Stream-Retention-Seconds: 86400`), so the
 * poller has to reach each run inside that window; at a 5-minute interval it has about 23 hours
 * to spare. A run whose stream is gone (410) is recorded as a failure and skipped, so it does not
 * hold back the runs after it.
 *
 * The checkpoint keeps, per agent: the `updatedAt` it last saw, the session's log length (where
 * the next run is appended), and the last run stored. */

import type { Connector, ConnectorContext, Cursor } from "@seshi/kit";
import { ENVELOPE_SCHEMA, type Envelope } from "@seshi/model";
import {
  abortableSleep,
  type CursorAgent,
  CursorApi,
  CursorApiError,
  type CursorRun,
  StreamExpired,
  TERMINAL_STATUSES,
} from "./api";
import {
  CURSOR_CLOUD_API,
  type CursorRunLine,
  type CursorStreamEvent,
  REPEATED_UPDATES,
} from "./format";

export const CURSOR_CLOUD_SOURCE = "cursor-cloud";

/** The failure recorded for a run whose events Cursor no longer keeps. */
export const STREAM_EXPIRED = "stream_expired";
/** The failure recorded for an agent whose stored session is not the length the checkpoint says. */
export const SESSION_CONFLICT = "session_conflict";

/** The fields of a `type = "cursor-cloud"` source this connector reads (`cursorCloudSource` in
 * `@seshi/config`; durations in milliseconds). */
export interface CursorCloudSourceConfig {
  api_key: string;
  api_url?: string;
  lookback: number;
  max_streams: number;
  usage: boolean;
}

interface AgentEntry {
  /** The agent's `updatedAt` when its runs were last all stored. */
  updated?: string;
  /** Bytes of the session's log: where the next run's line is appended. */
  bytes: number;
  /** The last run stored (or skipped as expired), by creation time and id. */
  through?: { at: string; id: string };
  /** Why the agent is held: its stored session is not what the checkpoint says. */
  conflict?: string;
}

export interface CursorCloudCursor {
  v: 1;
  agents: Record<string, AgentEntry>;
}

export interface CursorCloudConnectorOptions {
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  backoffMs?: number;
  /** How many times an empty or unfinished replay is asked for again (default 3). */
  streamAttempts?: number;
}

type SecretLike = string | { reveal(): string };

function secretValue(value: unknown, field: string): string {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null && "reveal" in value
        ? (value as { reveal(): string }).reveal()
        : undefined;
  if (typeof text !== "string" || text === "") {
    throw new Error(`the cursor-cloud source needs ${field}`);
  }
  return text;
}

function apiUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("the cursor-cloud source's api_url is not a URL");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    throw new Error(
      "the cursor-cloud source's api_url must be https (plain http would send the key in clear); http is allowed for localhost only",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("the cursor-cloud source's api_url must be https");
  }
  return raw;
}

/** The source's config, checked: what the connector needs, the key revealed. */
export function readCursorCloudConfig(
  raw: Readonly<Record<string, unknown>>,
): CursorCloudSourceConfig {
  const lookback = raw.lookback ?? 25 * 3_600_000;
  if (typeof lookback !== "number" || !Number.isFinite(lookback) || lookback <= 0) {
    throw new Error("the cursor-cloud source's lookback is not a duration");
  }
  const streams = raw.max_streams ?? 25;
  if (typeof streams !== "number" || !Number.isInteger(streams) || streams < 1 || streams > 60) {
    throw new Error("the cursor-cloud source's max_streams must be 1 to 60");
  }
  const url = apiUrl(raw.api_url);
  return {
    api_key: secretValue(raw.api_key as SecretLike, "api_key"),
    ...(url ? { api_url: url } : {}),
    lookback,
    max_streams: streams,
    usage: raw.usage !== false,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The checkpoint as this connector wrote it; null before the first run. Another shape is
 * refused, so a source never silently starts over and appends runs twice. */
export function readCursorCloudCursor(raw: Cursor | null): CursorCloudCursor {
  if (raw === null) return { v: 1, agents: {} };
  const problem = (why: string) =>
    new Error(`the cursor-cloud checkpoint is not one this version wrote (${why})`);
  if (raw.v !== 1) throw problem(`version ${JSON.stringify(raw.v)}`);
  if (!isObject(raw.agents)) throw problem("agents");
  const agents: Record<string, AgentEntry> = {};
  for (const [id, value] of Object.entries(raw.agents)) {
    if (!isObject(value) || typeof value.bytes !== "number" || value.bytes < 0) {
      throw problem(`agent ${id}`);
    }
    const entry: AgentEntry = { bytes: value.bytes };
    if (typeof value.updated === "string") entry.updated = value.updated;
    if (
      isObject(value.through) &&
      typeof value.through.at === "string" &&
      typeof value.through.id === "string"
    ) {
      entry.through = { at: value.through.at, id: value.through.id };
    }
    if (typeof value.conflict === "string") entry.conflict = value.conflict;
    agents[id] = entry;
  }
  return { v: 1, agents };
}

const after = (run: CursorRun, through: AgentEntry["through"]) =>
  !through ||
  (run.createdAt ?? "") > through.at ||
  ((run.createdAt ?? "") === through.at && run.id > through.id);

/** The agent's repository as a project, `host/owner/name`. */
export function projectOf(agent: CursorAgent): string | undefined {
  const url = agent.repos?.find((r) => typeof r?.url === "string" && r.url !== "")?.url;
  if (!url) return undefined;
  return url
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]+@([^:]+):/, "$1/")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
}

/** The branch the run worked on, from its `git.branches`. */
export function branchOf(run: CursorRun): string | undefined {
  const git = isObject(run.git) ? run.git : {};
  const branches = Array.isArray(git.branches) ? git.branches : [];
  for (const b of branches) {
    if (isObject(b) && typeof b.branch === "string" && b.branch !== "") return b.branch;
  }
  return undefined;
}

/** Whether a replay reached the run's end: Cursor sends `result` once the run is over. */
export const replayComplete = (events: readonly CursorStreamEvent[]) =>
  events.some((e) => e.event === "result");

/** The events kept in the log: everything but heartbeats and the deltas other events repeat. */
export function keptEvents(events: readonly CursorStreamEvent[]): CursorStreamEvent[] {
  return events.filter(
    (e) =>
      e.event !== "heartbeat" &&
      !(e.event === "interaction_update" && REPEATED_UPDATES.has(String(e.data.type))),
  );
}

export function cursorCloudConnector(options: CursorCloudConnectorOptions = {}): Connector {
  const attempts = options.streamAttempts ?? 3;

  return {
    kind: CURSOR_CLOUD_SOURCE,

    async run(ctx: ConnectorContext) {
      const config = readCursorCloudConfig(ctx.source.config);
      const cursor = readCursorCloudCursor(ctx.checkpoint.read());
      const api = new CursorApi({
        apiKey: config.api_key,
        ...(config.api_url ? { baseUrl: config.api_url } : {}),
        fetch: (input, init) => ctx.fetch(input, init),
        signal: ctx.signal,
        sleep: options.sleep ?? abortableSleep,
        ...(options.backoffMs !== undefined ? { backoffMs: options.backoffMs } : {}),
      });
      const id = ctx.source.id;
      const now = ctx.now().getTime();
      let streams = config.max_streams;
      let more = false;
      const tally = { agents: 0, stored: 0, expired: 0, failed: 0, waiting: 0, held: 0 };
      const save = () => ctx.checkpoint.write(cursor as unknown as Cursor);

      const agents = await api.listAgents();
      for (const agent of agents) {
        ctx.signal.throwIfAborted();
        const known = cursor.agents[agent.id];
        if (known?.conflict) {
          tally.held++;
          continue;
        }
        if (known && known.updated !== undefined && known.updated === agent.updatedAt) continue;
        const updated = agent.updatedAt ? Date.parse(agent.updatedAt) : Number.NaN;
        // Nothing of an agent untouched since before the lookback can be had any more.
        if (!known && !Number.isNaN(updated) && updated < now - config.lookback) continue;
        if (streams <= 0) {
          more = true;
          break;
        }
        tally.agents++;
        const entry: AgentEntry = known ? { ...known } : { bytes: 0 };
        delete entry.updated;
        let settled = true;
        const runs = (await api.listRuns(agent.id)).filter((run) => after(run, entry.through));
        for (const listed of runs) {
          ctx.signal.throwIfAborted();
          if (!TERMINAL_STATUSES.has(listed.status ?? "")) {
            settled = false;
            tally.waiting++;
            break;
          }
          if (streams <= 0) {
            settled = false;
            more = true;
            break;
          }
          let events: CursorStreamEvent[] = [];
          let expired = false;
          for (let attempt = 0; attempt < attempts && streams > 0; attempt++) {
            streams--;
            try {
              events = await api.stream(agent.id, listed.id);
            } catch (err) {
              if (err instanceof StreamExpired) {
                expired = true;
                break;
              }
              throw err;
            }
            if (replayComplete(events)) break;
          }
          const where = `${agent.id}/${listed.id}`;
          if (expired) {
            tally.expired++;
            const message = `run ${listed.id} of agent ${agent.id} ended more than Cursor keeps its events (24 h) before it was read; it is not in the session`;
            if (ctx.fail) {
              await ctx.fail({
                code: STREAM_EXPIRED,
                message,
                session_key: agent.id,
                idempotency_key: `cursor-cloud:${where}~expired`,
                provenance: { cursor: where },
              });
            } else ctx.log.warn(message);
            entry.through = { at: listed.createdAt ?? "", id: listed.id };
            cursor.agents[agent.id] = { ...entry };
            await save();
            continue;
          }
          if (!replayComplete(events)) {
            ctx.log.warn(
              `run ${listed.id} of agent ${agent.id}: Cursor's replay ended before the run's result; asked again next poll`,
            );
            settled = false;
            more = streams <= 0 || more;
            break;
          }
          const run =
            listed.git !== undefined && listed.durationMs !== undefined
              ? listed
              : await api.getRun(agent.id, listed.id).catch(() => listed);
          let usage: Record<string, unknown> | undefined;
          if (config.usage) {
            usage = await api.runUsage(agent.id, listed.id).catch((err: unknown) => {
              if (err instanceof CursorApiError && (err.status === 401 || err.status === 403))
                throw err;
              return undefined;
            });
          }
          const line: CursorRunLine = {
            type: "cursor_cloud_run",
            agent_id: agent.id,
            run_id: listed.id,
            run: run as Record<string, unknown>,
            ...(usage ? { usage } : {}),
            events: keptEvents(events),
          };
          const project = projectOf(agent);
          const branch = branchOf(run);
          const envelope: Envelope = {
            schema: ENVELOPE_SCHEMA,
            source: CURSOR_CLOUD_SOURCE,
            source_id: id,
            format: CURSOR_CLOUD_API,
            session_key: agent.id,
            payload: {
              kind: "log",
              encoding: "jsonl",
              text: `${JSON.stringify(line)}\n`,
              offset: entry.bytes,
            },
            caller: { kind: "service", principal: `svc:${id}` },
            owner: `svc:${id}`,
            owner_basis: "service",
            idempotency_key: `cursor-cloud:${where}`,
            provenance: { cursor: where },
            received_at: ctx.now().toISOString(),
            ...(project ? { project } : {}),
            ...(branch ? { branch } : {}),
          };
          const outcome = await ctx.submit(envelope);
          if (outcome.status === "failed" && outcome.code === "offset_mismatch") {
            entry.conflict = `the stored session is not ${entry.bytes} bytes long, as the checkpoint says; its runs are held (${outcome.message.slice(0, 200)})`;
            ctx.log.error(`agent ${agent.id}: ${entry.conflict}`);
            if (ctx.fail) {
              await ctx.fail({
                code: SESSION_CONFLICT,
                message: entry.conflict,
                session_key: agent.id,
                idempotency_key: `cursor-cloud:${where}~conflict`,
                provenance: { cursor: where },
              });
            }
            settled = false;
            break;
          }
          if (outcome.status === "failed") {
            tally.failed++;
          } else {
            tally.stored++;
            if ("bytes_total" in outcome && typeof outcome.bytes_total === "number") {
              entry.bytes = outcome.bytes_total;
            }
          }
          entry.through = { at: listed.createdAt ?? "", id: listed.id };
          cursor.agents[agent.id] = { ...entry };
          await save();
        }
        if (settled && agent.updatedAt) entry.updated = agent.updatedAt;
        cursor.agents[agent.id] = entry;
        await save();
      }

      const parts = [
        `looked at ${tally.agents} of ${agents.length} agent(s)`,
        `stored ${tally.stored} run(s)`,
      ];
      if (tally.waiting) parts.push(`${tally.waiting} still running`);
      if (tally.expired)
        parts.push(`${tally.expired} expired before they were read (see sync failed)`);
      if (tally.failed) parts.push(`${tally.failed} failed (see sync failed)`);
      if (tally.held) parts.push(`${tally.held} agent(s) held by a session conflict`);
      if (more) parts.push("more next poll");
      ctx.log.info(parts.join("; "));
      return more ? { more: true } : {};
    },
  };
}

export const CURSOR_CLOUD_CONNECTOR: Connector = cursorCloudConnector();
