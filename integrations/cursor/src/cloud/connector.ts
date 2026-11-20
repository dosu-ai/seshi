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
 * the next run is appended), the last run stored, and the runs the server kept nothing of yet
 * (a session filtered as too short), which are sent again ahead of the agent's next run while
 * Cursor still has them. An error reading one agent is logged and that agent read again next
 * poll; the others go on. */

import {
  abortableSleep,
  apiUrlOverride,
  type Connector,
  type ConnectorContext,
  type Cursor,
  normalizeRemote,
  repoLabel,
  secretValue,
  serviceEnvelopeIdentity,
} from "@seshi/kit";
import { ENVELOPE_SCHEMA, type Envelope } from "@seshi/model";
import {
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

const DAY = 86_400_000;
/** The run id an exclusion's cutoff names: after every real one, so `after` passes over each run
 * created at the cutoff's instant. */
const PASSED_OVER = "\uffff";
/** An agent nothing was stored of, untouched this long, leaves the checkpoint. One with a stored
 * session stays: its log length is where its next run goes. */
const PRUNE_AFTER_MS = 90 * DAY;
/** Most filtered runs an agent carries towards its next submission. */
const MAX_CARRIED = 20;

/** The fields of a `type = "cursor-cloud"` source this connector reads (`cursorCloudSource` in
 * `@seshi/config`; durations in milliseconds). */
export interface CursorCloudSourceConfig {
  api_key: string;
  api_url?: string;
  lookback: number;
  max_streams: number;
  usage: boolean;
}

interface RunRef {
  at: string;
  id: string;
}

interface AgentEntry {
  /** The agent's `updatedAt` when its runs were last all read. */
  updated?: string;
  /** Bytes of the session's log: where the next run's line is appended. */
  bytes: number;
  /** The last run handled (stored, filtered, refused or expired), by creation time and id. */
  through?: RunRef;
  /** Runs the server kept nothing of (filtered as too short), sent again ahead of the next run
   * while Cursor still has them, so a session that grows past the filter starts at its first. */
  carry?: RunRef[];
  /** Why the agent is held: its stored session is not what the checkpoint says. */
  conflict?: string;
  /** Where the stored session's log ends, from the refusal that held the agent. */
  expected?: number;
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
  /** How long a stream may send nothing before it counts as stalled (default 60 s). */
  readTimeoutMs?: number;
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
  const url = apiUrlOverride(raw.api_url, "cursor-cloud", "the key");
  return {
    api_key: secretValue(raw.api_key, "cursor-cloud", "api_key"),
    ...(url ? { api_url: url } : {}),
    lookback,
    max_streams: streams,
    usage: raw.usage !== false,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const runRef = (v: unknown): RunRef | undefined =>
  isObject(v) && typeof v.at === "string" && typeof v.id === "string"
    ? { at: v.at, id: v.id }
    : undefined;

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
    const through = runRef(value.through);
    if (through) entry.through = through;
    if (Array.isArray(value.carry)) {
      const carry = value.carry.map(runRef).filter((r): r is RunRef => r !== undefined);
      if (carry.length > 0) entry.carry = carry;
    }
    if (typeof value.conflict === "string") entry.conflict = value.conflict;
    if (typeof value.expected === "number" && value.expected >= 0) entry.expected = value.expected;
    agents[id] = entry;
  }
  return { v: 1, agents };
}

const after = (run: CursorRun, through: RunRef | undefined) =>
  !through ||
  (run.createdAt ?? "") > through.at ||
  ((run.createdAt ?? "") === through.at && run.id > through.id);

const refOf = (run: CursorRun): RunRef => ({ at: run.createdAt ?? "", id: run.id });

/** The repository URLs the agent works in (`repos[].url`), as Cursor names them: what the org's
 * exclude list is matched against (normalized there as a laptop's remotes are). */
export function repoUrls(agent: CursorAgent): string[] {
  return (agent.repos ?? [])
    .map((r) => r?.url)
    .filter((url): url is string => typeof url === "string" && url.trim() !== "");
}

/** The agent's repository, `host/owner/name`: the one it was started on, else the one its run's
 * branch is in. */
export function repoOf(agent: CursorAgent, run?: CursorRun): string | undefined {
  const url =
    agent.repos?.find((r) => typeof r?.url === "string" && r.url !== "")?.url ??
    runBranches(run).find((b) => typeof b.repoUrl === "string" && b.repoUrl !== "")?.repoUrl;
  return typeof url === "string" ? repoLabel(normalizeRemote(url)) : undefined;
}

/** The session's `project`: the repository's name, as a laptop names it after its folder. */
export function projectOf(repo: string | undefined): string | undefined {
  return repo?.split("/").at(-1) || undefined;
}

function runBranches(run: CursorRun | undefined): Record<string, unknown>[] {
  const git = isObject(run?.git) ? run.git : {};
  return (Array.isArray(git.branches) ? git.branches : []).filter(isObject);
}

/** The branch the run worked on, from its `git.branches`. */
export function branchOf(run: CursorRun): string | undefined {
  for (const b of runBranches(run)) {
    if (typeof b.branch === "string" && b.branch !== "") return b.branch;
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

/** Where a refused chunk's session log ends, from the pipeline's `offset_mismatch` message
 * (`chunk starts at byte N; the session's log ends at M`). */
export function expectedOffset(message: string): number | undefined {
  const match = /log ends at (\d+)/.exec(message);
  return match ? Number(match[1]) : undefined;
}

/** Release agents held by a session conflict (X4.9, `seshi reprocess --source <id> --since …`):
 * each goes on after where its stored session ends, and every agent's runs are listed again.
 * Runs already handled are not sent again: Cursor keeps their events for a day only, so
 * `since` cannot reach further back than the checkpoint already does. */
export function rewindCursorCloud(cursor: Cursor | null): Cursor {
  let current: CursorCloudCursor;
  try {
    current = readCursorCloudCursor(cursor);
  } catch {
    current = { v: 1, agents: {} };
  }
  for (const entry of Object.values(current.agents)) {
    if (entry.conflict !== undefined) {
      if (entry.expected !== undefined) entry.bytes = entry.expected;
      delete entry.conflict;
      delete entry.expected;
      delete entry.carry;
    }
    delete entry.updated;
  }
  return current as unknown as Cursor;
}

interface Tally {
  agents: number;
  excluded: number;
  stored: number;
  filtered: number;
  dropped: number;
  expired: number;
  refused: number;
  waiting: number;
  held: number;
  errors: number;
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
        ...(options.readTimeoutMs !== undefined ? { readTimeoutMs: options.readTimeoutMs } : {}),
      });
      const id = ctx.source.id;
      const now = ctx.now().getTime();
      const budget = { streams: config.max_streams, more: false };
      const tally: Tally = {
        agents: 0,
        excluded: 0,
        stored: 0,
        filtered: 0,
        dropped: 0,
        expired: 0,
        refused: 0,
        waiting: 0,
        held: 0,
        errors: 0,
      };

      /** One stream replay, asked again while it ends early; undefined once Cursor has none. */
      async function replay(
        agentId: string,
        runId: string,
      ): Promise<CursorStreamEvent[] | undefined> {
        let events: CursorStreamEvent[] = [];
        for (let attempt = 0; attempt < attempts && budget.streams > 0; attempt++) {
          budget.streams--;
          try {
            events = await api.stream(agentId, runId);
          } catch (err) {
            if (err instanceof StreamExpired) return undefined;
            throw err;
          }
          if (replayComplete(events)) break;
        }
        return events;
      }

      /** The run as one line of the log. */
      async function lineOf(agentId: string, listed: CursorRun, events: CursorStreamEvent[]) {
        // Both are extras: a refused key fails the poll, anything else leaves them out.
        const extra = <T>(err: unknown, fallback: T): T => {
          if (err instanceof CursorApiError && (err.status === 401 || err.status === 403)) {
            throw err;
          }
          return fallback;
        };
        const [run, usage] = await Promise.all([
          listed.git !== undefined && listed.durationMs !== undefined
            ? listed
            : api.getRun(agentId, listed.id).catch((err: unknown) => extra(err, listed)),
          config.usage
            ? api
                .runUsage(agentId, listed.id)
                .catch((err: unknown) => extra<Record<string, unknown> | undefined>(err, undefined))
            : undefined,
        ]);
        const line: CursorRunLine = {
          type: "cursor_cloud_run",
          agent_id: agentId,
          run_id: listed.id,
          run: run as Record<string, unknown>,
          ...(usage ? { usage } : {}),
          events: keptEvents(events),
        };
        return { run, text: `${JSON.stringify(line)}\n` };
      }

      async function recordExpired(agentId: string, runId: string) {
        tally.expired++;
        const where = `${agentId}/${runId}`;
        const message = `run ${runId} of agent ${agentId} ended more than Cursor keeps its events (24 h) before it was read; it is not in the session`;
        if (ctx.fail) {
          await ctx.fail({
            code: STREAM_EXPIRED,
            message,
            session_key: agentId,
            idempotency_key: `cursor-cloud:${where}~expired`,
            provenance: { cursor: where },
          });
        } else ctx.log.warn(message);
      }

      /** The carried runs' lines, read again, oldest first, or undefined when one Cursor still
       * has cannot be read whole this poll (out of streams, or a replay that ended early): the
       * agent then waits, carry and all. A run Cursor no longer has drops out, recorded as
       * expired. */
      async function carriedLines(agentId: string, carry: readonly RunRef[]) {
        const kept: RunRef[] = [];
        let text = "";
        for (const ref of carry) {
          const events =
            Date.parse(ref.at) < now - config.lookback
              ? undefined
              : await readable(agentId, ref.id);
          if (events === "wait") return undefined;
          if (events === undefined) {
            await recordExpired(agentId, ref.id);
            continue;
          }
          const line = await lineOf(agentId, { id: ref.id, createdAt: ref.at }, events);
          text += line.text;
          kept.push(ref);
        }
        return { kept, text };
      }

      /** A run's whole replay; undefined once Cursor no longer has it; "wait" when it cannot be
       * read whole this poll. */
      async function readable(
        agentId: string,
        runId: string,
      ): Promise<CursorStreamEvent[] | undefined | "wait"> {
        if (budget.streams <= 0) {
          budget.more = true;
          return "wait";
        }
        const events = await replay(agentId, runId);
        if (events === undefined) return undefined;
        if (!replayComplete(events)) {
          ctx.log.warn(
            `run ${runId} of agent ${agentId}: Cursor's replay ended before the run's result; asked again next poll`,
          );
          if (budget.streams <= 0) budget.more = true;
          return "wait";
        }
        return events;
      }

      /** Reads the agent's new runs into `entry`; true when every run listed was handled. */
      async function syncAgent(agent: CursorAgent, entry: AgentEntry): Promise<boolean> {
        // Any of the agent's repositories the org lists in [capture] redact_tool_calls: its runs
        // are stored with their tool calls redacted (the pipeline does it, before any store).
        const redactToolCalls = ctx.toolCallsRedactedBy?.(repoUrls(agent));
        const runs = (await api.listRuns(agent.id)).filter((run) => after(run, entry.through));
        for (const listed of runs) {
          ctx.signal.throwIfAborted();
          if (!TERMINAL_STATUSES.has(listed.status ?? "")) {
            tally.waiting++;
            return false;
          }
          // The carried runs first: a poll that cannot read them whole leaves this run for the
          // next one too, rather than store it without them.
          const carried =
            entry.bytes === 0 && entry.carry
              ? await carriedLines(agent.id, entry.carry)
              : { kept: [], text: "" };
          if (carried === undefined) return false;
          const events = await readable(agent.id, listed.id);
          if (events === "wait") return false;
          if (events === undefined) {
            await recordExpired(agent.id, listed.id);
            if (entry.carry) entry.carry = carried.kept;
            entry.through = refOf(listed);
            continue;
          }
          const { run, text: own } = await lineOf(agent.id, listed, events);
          const where = `${agent.id}/${listed.id}`;
          const branch = branchOf(run);
          // The Cloud Agents API names no commit for a run (Nov 2026), so none is sent.
          const repo = repoOf(agent, run);
          const project = projectOf(repo);
          const envelope: Envelope = {
            schema: ENVELOPE_SCHEMA,
            source: CURSOR_CLOUD_SOURCE,
            source_id: id,
            format: CURSOR_CLOUD_API,
            session_key: agent.id,
            payload: {
              kind: "log",
              encoding: "jsonl",
              text: carried.text + own,
              offset: entry.bytes,
            },
            ...serviceEnvelopeIdentity(id),
            idempotency_key: `cursor-cloud:${where}`,
            provenance: { cursor: where },
            received_at: ctx.now().toISOString(),
            ...(repo ? { repo } : {}),
            ...(project ? { project } : {}),
            ...(branch ? { branch } : {}),
          };
          const outcome = await ctx.submit(
            envelope,
            redactToolCalls !== undefined ? { redactToolCalls } : undefined,
          );
          if (outcome.status === "failed" && outcome.code === "offset_mismatch") {
            const expected = expectedOffset(outcome.message);
            const release = `its runs are held until seshi reprocess --source ${id} --since <time> releases them`;
            entry.conflict =
              expected !== undefined
                ? `the stored session's log is ${expected} bytes long, not ${entry.bytes} as the checkpoint says; ${release}`
                : `the stored session's log is not ${entry.bytes} bytes long, as the checkpoint says; ${release}`;
            if (expected !== undefined) entry.expected = expected;
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
            return false;
          }
          const total = "bytes_total" in outcome ? outcome.bytes_total : undefined;
          // A refusal is final (the pipeline throws what is worth trying again): the run is
          // recorded under sync failed and the agent goes on.
          if (outcome.status === "failed") {
            tally.refused++;
            delete entry.carry;
          } else if (outcome.status === "filtered") {
            tally.filtered++;
            entry.carry = [...carried.kept, refOf(listed)].slice(-MAX_CARRIED);
            entry.bytes = 0;
          } else {
            if (outcome.status === "dropped") tally.dropped++;
            else tally.stored++;
            delete entry.carry;
            // A resend the session already holds (after a release) is answered as it was then:
            // its length is no further than where the log ends now.
            if (typeof total === "number") entry.bytes = Math.max(entry.bytes, total);
          }
          entry.through = refOf(listed);
        }
        return true;
      }

      /** The org excludes the agent's repository: none of its runs is listed or read. Its runs
       * up to now are passed over for good, so one made while it was excluded is never read
       * after the entry goes; what was stored before the entry came stays. */
      async function exclude(agent: CursorAgent, known: AgentEntry | undefined, entry: string) {
        tally.excluded++;
        ctx.excluded?.();
        ctx.log.info(`agent ${agent.id}: not read, the org excludes ${entry} ([capture] exclude)`);
        const skipped: AgentEntry = known ? structuredClone(known) : { bytes: 0 };
        // On Cursor's clock, in Cursor's format, as runs' `createdAt` is: every run the agent has
        // so far is no later than its `updatedAt`. The id sorts after any run's, so a run created
        // in that same instant is passed over too.
        const at = agent.updatedAt ?? ctx.now().toISOString();
        if (!skipped.through || skipped.through.at < at) {
          skipped.through = { at, id: PASSED_OVER };
        }
        delete skipped.carry;
        if (agent.updatedAt) skipped.updated = agent.updatedAt;
        else delete skipped.updated;
        cursor.agents[agent.id] = skipped;
        await ctx.checkpoint.write(cursor as unknown as Cursor);
      }

      const agents = await api.listAgents();
      for (const agent of agents) {
        ctx.signal.throwIfAborted();
        const known = cursor.agents[agent.id];
        if (known && known.updated !== undefined && known.updated === agent.updatedAt) continue;
        const updated = agent.updatedAt ? Date.parse(agent.updatedAt) : Number.NaN;
        // Nothing of an agent untouched since before the lookback can be had any more.
        if (!known && !Number.isNaN(updated) && updated < now - config.lookback) continue;
        // Before anything of the agent is read: an excluded agent's runs never enter seshi.
        const excludedBy = ctx.excludedBy?.(repoUrls(agent));
        if (excludedBy !== undefined) {
          await exclude(agent, known, excludedBy);
          continue;
        }
        if (known?.conflict) {
          tally.held++;
          continue;
        }
        if (budget.streams <= 0) {
          budget.more = true;
          break;
        }
        tally.agents++;
        const entry: AgentEntry = known ? structuredClone(known) : { bytes: 0 };
        delete entry.updated;
        let settled = false;
        try {
          settled = await syncAgent(agent, entry);
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          if (err instanceof CursorApiError && (err.status === 401 || err.status === 403))
            throw err;
          tally.errors++;
          ctx.log.error(
            `agent ${agent.id}: ${(err as Error).message}; its runs are read again next poll`,
          );
        } finally {
          if (settled && agent.updatedAt) entry.updated = agent.updatedAt;
          cursor.agents[agent.id] = entry;
          // Saved per agent, not per run: a run sent again after a crash between the two carries
          // the same idempotency key, and the server answers it as before.
          await ctx.checkpoint.write(cursor as unknown as Cursor);
        }
      }

      let pruned = false;
      for (const [agentId, entry] of Object.entries(cursor.agents)) {
        const seen = entry.updated ? Date.parse(entry.updated) : Number.NaN;
        if (entry.bytes === 0 && !entry.conflict && !entry.carry && seen < now - PRUNE_AFTER_MS) {
          delete cursor.agents[agentId];
          pruned = true;
        }
      }
      if (pruned) await ctx.checkpoint.write(cursor as unknown as Cursor);

      const parts = [
        `looked at ${tally.agents} of ${agents.length} agent(s)`,
        `stored ${tally.stored} run(s)`,
      ];
      if (tally.filtered) parts.push(`${tally.filtered} too short to keep yet (carried)`);
      if (tally.dropped) parts.push(`${tally.dropped} dropped by review`);
      if (tally.waiting) parts.push(`${tally.waiting} still running`);
      if (tally.expired) {
        parts.push(`${tally.expired} expired before they were read (see sync failed)`);
      }
      if (tally.refused) parts.push(`${tally.refused} refused (see sync failed)`);
      if (tally.held) parts.push(`${tally.held} agent(s) held by a session conflict`);
      if (tally.excluded) {
        parts.push(`${tally.excluded} agent(s) not read: the org excludes their repository`);
      }
      if (tally.errors) parts.push(`${tally.errors} agent(s) failed, read again next poll`);
      if (budget.more) parts.push("more next poll");
      ctx.log.info(parts.join("; "));
      return budget.more ? { more: true } : {};
    },

    rewind: (cursor) => rewindCursorCloud(cursor),
  };
}

export const CURSOR_CLOUD_CONNECTOR: Connector = cursorCloudConnector();
