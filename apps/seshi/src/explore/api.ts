/** What `seshi explore`'s endpoints answer, over the doctor's engine (`gatherEvidence`,
 * `runChecks`) and its loaders. Read-only: it never uploads, writes state, adds spool entries or
 * writes to a server.
 *
 * The session list is cheap: the state file and `decide` for each session, plus the worst check
 * status once a background pass (one session at a time, newest first) has run the full checks.
 * Opening one session gathers its evidence on demand (every trace fetched), kept for the few
 * sessions open most recently so the records view can page through it. */

import { type SessionState, sessionKey } from "@seshi/capture";
import { forJson } from "../commands/doctor";
import { CAPTURING, NOT_CAPTURING } from "../commands/statusline";
import { runChecks } from "../doctor/checks";
import type { DoctorDeps } from "../doctor/deps";
import { gatherEvidence } from "../doctor/evidence";
import {
  type CheckResult,
  type CheckStatus,
  SEVERITY,
  type SessionEvidence,
  worst,
} from "../doctor/types";
import { type Aligned, alignRecords, page } from "./records";
import { timelineOf } from "./timeline";
import type {
  ListStatus,
  RecordsView,
  RowFilter,
  SessionDetail,
  SessionList,
  SessionSummary,
} from "./types";

export interface ExploreApiOptions {
  /** How far back the list reaches, in ms. */
  sinceMs: number;
  /** How many sessions' full evidence is kept. */
  keep?: number;
}

interface Checked {
  worst: CheckStatus;
  worst_check?: SessionSummary["worst_check"];
  at: string;
}

interface Opened {
  evidence: SessionEvidence;
  checks: CheckResult[];
  aligned?: Aligned;
}

/** Checks, failures first, then warnings, passes and skips; in the doctor's order within each. */
export function failuresFirst(checks: readonly CheckResult[]): CheckResult[] {
  return checks
    .map((check, i) => ({ check, i }))
    .sort((a, b) => SEVERITY[b.check.status] - SEVERITY[a.check.status] || a.i - b.i)
    .map(({ check }) => check);
}

function summarize(checks: readonly CheckResult[], at: string): Checked {
  const status = worst(checks.map((c) => c.status));
  const first = checks.find((c) => c.status === status && status !== "ok" && status !== "skip");
  return {
    worst: status,
    at,
    ...(first ? { worst_check: { id: first.id, title: first.title, summary: first.summary } } : {}),
  };
}

const glyphOf = (capture: boolean | undefined) => (capture ? CAPTURING : NOT_CAPTURING);

export class ExploreApi {
  private readonly checked = new Map<string, Checked>();
  private readonly opened = new Map<string, Opened>();
  private readonly queue: SessionState[] = [];
  private readonly queued = new Set<string>();
  private running: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly deps: DoctorDeps,
    private readonly options: ExploreApiOptions,
  ) {}

  /** The sessions seen since `since`, newest first. */
  private sessions(): { sessions: SessionState[]; error?: string } {
    let state: ReturnType<DoctorDeps["state"]>;
    try {
      state = this.deps.state();
    } catch (err) {
      return { sessions: [], error: err instanceof Error ? err.message : String(err) };
    }
    const since = this.deps.now().getTime() - this.options.sinceMs;
    const sessions = Object.values(state.sessions)
      .filter((s) => Date.parse(s.last_seen ?? s.first_seen) >= since)
      .sort((a, b) => (b.last_seen ?? b.first_seen).localeCompare(a.last_seen ?? a.first_seen));
    return { sessions };
  }

  /** The state entry for a session this machine saw, or undefined. */
  private find(agent: string, id: string): SessionState | undefined {
    try {
      return this.deps.state().sessions[sessionKey(agent, id)];
    } catch {
      return undefined;
    }
  }

  list(options: { refresh?: boolean } = {}): SessionList {
    if (options.refresh) {
      this.checked.clear();
      this.opened.clear();
    }
    const now = this.deps.now();
    const { sessions, error } = this.sessions();
    let state: ReturnType<DoctorDeps["state"]> | undefined;
    try {
      state = this.deps.state();
    } catch {}
    const rows: SessionSummary[] = sessions.map((s) => {
      const key = sessionKey(s.agent, s.session_id);
      let decision: SessionSummary["decision"];
      try {
        const d = state ? this.deps.judge(state, s.agent, s) : undefined;
        decision = d
          ? { capture: d.capture, glyph: glyphOf(d.capture), level: d.level, reason: d.reason }
          : { capture: false, glyph: NOT_CAPTURING, reason: "the state file cannot be read" };
      } catch (err) {
        decision = {
          capture: false,
          glyph: NOT_CAPTURING,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      const checked = this.checked.get(key);
      if (!checked) this.enqueue(s);
      return {
        agent: s.agent,
        session_id: s.session_id,
        ...(s.cwd ? { folder: s.cwd } : {}),
        first_seen: s.first_seen,
        ...(s.last_seen ? { last_seen: s.last_seen } : {}),
        decision,
        ...(s.last_status ? { last_status: s.last_status } : {}),
        worst: (checked?.worst ?? "pending") as ListStatus,
        ...(checked?.worst_check ? { worst_check: checked.worst_check } : {}),
        ...(checked ? { checked_at: checked.at } : {}),
      };
    });
    const server = this.deps.server;
    return {
      since: new Date(now.getTime() - this.options.sinceMs).toISOString(),
      server: server
        ? { mode: server.mode, where: server.where }
        : {
            mode: "none",
            error: this.deps.serverError?.message ?? "no server to ask",
          },
      sessions: rows,
      pending: rows.filter((r) => r.worst === "pending").length,
      ...(error ? { state_error: error } : {}),
    };
  }

  private enqueue(s: SessionState): void {
    const key = sessionKey(s.agent, s.session_id);
    if (this.queued.has(key) || this.closed) return;
    this.queued.add(key);
    this.queue.push(s);
    this.running ??= this.drain().finally(() => {
      this.running = undefined;
    });
  }

  /** The background pass: the full checks, one session at a time. */
  private async drain(): Promise<void> {
    for (;;) {
      const s = this.queue.shift();
      if (!s || this.closed) return;
      const key = sessionKey(s.agent, s.session_id);
      try {
        await this.open(s.agent, s.session_id, { keep: false });
      } catch (err) {
        this.checked.set(key, {
          worst: "fail",
          at: this.deps.now().toISOString(),
          worst_check: {
            id: "explore",
            title: "Checks",
            summary: `the checks could not run: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      } finally {
        this.queued.delete(key);
      }
    }
  }

  /** Gather and check one session, and keep its evidence when asked. */
  private async open(agent: string, id: string, options: { keep: boolean }): Promise<Opened> {
    const key = sessionKey(agent, id);
    const evidence = await gatherEvidence({ agent, session_id: id }, this.deps);
    const checks = runChecks(evidence, this.deps);
    this.checked.set(key, summarize(checks, evidence.at));
    const opened: Opened = { evidence, checks };
    if (options.keep) {
      this.opened.delete(key);
      this.opened.set(key, opened);
      const keep = this.options.keep ?? 4;
      while (this.opened.size > keep) {
        const oldest = this.opened.keys().next().value as string;
        this.opened.delete(oldest);
      }
    }
    return opened;
  }

  private async lookup(agent: string, id: string, fresh: boolean): Promise<Opened | undefined> {
    if (!this.find(agent, id)) return undefined;
    const key = sessionKey(agent, id);
    const kept = fresh ? undefined : this.opened.get(key);
    return kept ?? this.open(agent, id, { keep: true });
  }

  /** One session's evidence and checks; undefined for a session this machine never saw. */
  async detail(agent: string, id: string, options: { fresh?: boolean } = {}) {
    const got = await this.lookup(agent, id, options.fresh === true);
    if (!got) return undefined;
    const detail: SessionDetail = {
      evidence: forJson(got.evidence),
      checks: failuresFirst(got.checks),
      worst: worst(got.checks.map((c) => c.status)),
      glyph: glyphOf(got.evidence.decision?.capture),
      timeline: timelineOf(got.evidence),
    };
    return detail;
  }

  /** A page of one session's records view. */
  async records(
    agent: string,
    id: string,
    options: { offset?: number; limit?: number; filter?: RowFilter; fresh?: boolean } = {},
  ): Promise<RecordsView | undefined> {
    const got = await this.lookup(agent, id, options.fresh === true);
    if (!got) return undefined;
    got.aligned ??= alignRecords(got.evidence, this.deps);
    return page(got.aligned, options);
  }

  /** Waits for the background pass (tests). */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
  }
}
