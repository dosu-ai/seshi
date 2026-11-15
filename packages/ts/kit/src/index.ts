/** `@seshi/kit`: the contract an integration implements (X3.11). Each integration exports one
 * `Integration` listing what it provides; `apps/seshi` puts every integration in a static
 * registry and hands what they provide to the parts that run it: the format registry, the
 * instance's connector scheduler (`@seshi/sources`) and, later, `@seshi/capture`.
 *
 * Integrations import only `@seshi/model`, `@seshi/kit` and `@seshi/formats` (X3.2). Layer 1:
 * this package imports only `@seshi/model`. */

import type { Envelope, FormatAdapter, StoreSessionResult } from "@seshi/model";

export type {
  Chunk,
  DocumentHead,
  FormatAdapter,
  FormatDetection,
  HeadValue,
  JsonObject,
} from "@seshi/model";

/** Handles one kind of agent hook payload (F9): parses what the agent sends on stdin and says
 * what to capture. Declared now so integrations have a place for it; `@seshi/capture` defines
 * how it is called. */
export interface HookHandler {
  /** The hook event this handles, in the agent's own naming (`Stop`, `SessionEnd`, `notify`). */
  readonly event: string;
  handle(payload: unknown): Promise<void> | void;
}

/** What a connector's `submit` answers: the pipeline's answer for the envelope (X4). A permanent
 * failure is recorded under `sources/<id>/failed/` and answered `failed` (X4.8); a transient one
 * (the store) is thrown, so the run fails and the checkpoint stays where it was. */
export type SubmitOutcome =
  | StoreSessionResult
  | { status: "failed"; code: string; message: string; record: string }
  | { status: "accepted"; archive_id: string; spans: number };

/** Where a log line from a connector goes; the instance prefixes it with the source id. */
export interface ConnectorLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** A poller's position in its source (X7.4): a time window, an API cursor or an S3 manifest,
 * in whatever shape the connector chooses. */
export type Cursor = Record<string, unknown>;

/** The run's view of its checkpoint. It is read once when the run starts; `write` saves over
 * that version with If-Match (X6.5). When another worker moved it in between, `write` throws
 * `CheckpointLost` and the scheduler discards the run (X7.3): whatever it submitted is
 * deduplicated by the envelopes' idempotency keys (X4.7). */
export interface CheckpointHandle {
  /** The cursor as the run started, or null before the source's first run (or after a
   * rewind to the start). */
  read(): Cursor | null;
  /** Save `cursor`. Write after the envelopes it covers were submitted, never before. */
  write(cursor: Cursor): Promise<void>;
}

/** Another worker moved the checkpoint since this run read it (X7.3): the run is discarded. */
export class CheckpointLost extends Error {
  constructor(readonly sourceId: string) {
    super(`the checkpoint of source '${sourceId}' was moved by another worker; run discarded`);
    this.name = "CheckpointLost";
  }
}

/** What a connector gets for one run (X3.11). It never touches the store or the pipeline: it
 * builds envelopes and submits them, keeps its checkpoint, and reaches its vendor's API through
 * `fetch`. Everything here comes from the instance, so a connector is tested with fakes and
 * recorded fixtures. */
export interface ConnectorContext<C = Readonly<Record<string, unknown>>> {
  /** The configured source: its id, its `type`, and its `[[sources]]` table as the config
   * parsed it (durations in milliseconds; secrets as objects with `reveal()`). */
  readonly source: { readonly id: string; readonly type: string; readonly config: C };
  /** Run one envelope through the pipeline. Its `source_id` must be this source's id. */
  submit(envelope: Envelope): Promise<SubmitOutcome>;
  readonly checkpoint: CheckpointHandle;
  /** HTTP for the vendor's API; aborted with `signal`. */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  readonly log: ConnectorLogger;
  /** Aborted when the instance shuts down: stop at the next envelope boundary. */
  readonly signal: AbortSignal;
  now(): Date;
}

/** What a run says about itself, beyond what the scheduler counts from `submit`. */
export interface ConnectorRunResult {
  /** More is waiting now (a page limit was hit): the scheduler runs again without waiting for
   * the interval. */
  more?: boolean;
  /** How far behind the source the checkpoint is, in milliseconds, when the connector knows
   * (status's checkpoint lag, X7.5). */
  lag_ms?: number;
}

/** A poller for one kind of source (X7): one run reads what is new since the checkpoint,
 * submits an envelope per session, and saves the checkpoint. The worker runs it on the
 * source's `interval`; `seshi sync run <id>` runs it once. */
export interface Connector<C = Readonly<Record<string, unknown>>> {
  /** The `[[sources]]` `type` it polls (`datadog`, `s3`). */
  readonly kind: string;
  run(context: ConnectorContext<C>): Promise<ConnectorRunResult | undefined>;
  /** For `seshi reprocess --since` (X4.9): the cursor from which a run reads everything since
   * `since` again. Without it a source can only be rewound to the start (its checkpoint is
   * removed, and its next run starts as its first did). */
  rewind?(cursor: Cursor | null, since: Date, config: C): Cursor | null;
}

/** Wires an agent to seshi on one machine (hooks, status line, plugin manifest). Declared now;
 * `seshi install` defines how it is called. */
export interface Installer {
  /** The agent this installs into (`claude-code`). */
  readonly agent: string;
  install(): Promise<void>;
  uninstall(): Promise<void>;
}

/** Everything one vendor or agent provides. Lists are optional: an integration provides what it
 * has. */
export interface Integration {
  /** The integration's name: its folder under `integrations/` (`claude-code`, `datadog-trajectory`). */
  readonly name: string;
  /** Transcript formats this integration reads. */
  readonly formats?: readonly FormatAdapter[];
  readonly hooks?: readonly HookHandler[];
  /** Where this agent keeps its transcripts on a machine, for the sweep (F9). */
  readonly sweepPaths?: readonly string[];
  readonly connectors?: readonly Connector[];
  readonly installers?: readonly Installer[];
}

const INTEGRATION_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** An integration, checked: its name is a lowercase slug, and the format names it lists are
 * unique. Returns it unchanged, typed. */
export function defineIntegration<T extends Integration>(integration: T): T {
  if (!INTEGRATION_NAME.test(integration.name)) {
    throw new Error(`integration name '${integration.name}' must be a lowercase slug`);
  }
  const seen = new Set<string>();
  for (const format of integration.formats ?? []) {
    if (seen.has(format.source)) {
      throw new Error(`integration '${integration.name}' lists format '${format.source}' twice`);
    }
    seen.add(format.source);
  }
  return integration;
}

/** Every format adapter the integrations provide, in registry order. Two integrations with one
 * name, or two adapters for one format, are refused: a session would be filed under whichever
 * came first. */
export function formatsOf(integrations: readonly Integration[]): FormatAdapter[] {
  const names = new Set<string>();
  const owners = new Map<string, string>();
  const formats: FormatAdapter[] = [];
  for (const integration of integrations) {
    if (names.has(integration.name)) {
      throw new Error(`integration '${integration.name}' is registered twice`);
    }
    names.add(integration.name);
    for (const format of integration.formats ?? []) {
      const owner = owners.get(format.source);
      if (owner !== undefined) {
        throw new Error(
          `format '${format.source}' is provided by both '${owner}' and '${integration.name}'`,
        );
      }
      owners.set(format.source, integration.name);
      formats.push(format);
    }
  }
  return formats;
}

/** Every connector the integrations provide, in registry order. Two connectors for one source
 * `type` are refused: a source would be polled by whichever came first. */
export function connectorsOf(integrations: readonly Integration[]): Connector[] {
  const owners = new Map<string, string>();
  const connectors: Connector[] = [];
  for (const integration of integrations) {
    for (const connector of integration.connectors ?? []) {
      const owner = owners.get(connector.kind);
      if (owner !== undefined) {
        throw new Error(
          `connector '${connector.kind}' is provided by both '${owner}' and '${integration.name}'`,
        );
      }
      owners.set(connector.kind, integration.name);
      connectors.push(connector);
    }
  }
  return connectors;
}
