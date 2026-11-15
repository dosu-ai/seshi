/** `@seshi/kit`: the contract an integration implements (X3.11). Each integration exports one
 * `Integration` listing what it provides; `apps/seshi` puts every integration in a static
 * registry and hands what they provide to the parts that run it: the format registry, the
 * instance's connector scheduler (`@seshi/sources`) and `@seshi/capture`.
 *
 * Integrations import only `@seshi/model`, `@seshi/kit` and `@seshi/formats` (X3.2). Layer 1:
 * this package imports only `@seshi/model`. */

import type { Envelope, FormatAdapter, SourceLocation, StoreSessionResult } from "@seshi/model";

import type { CaptureAgent } from "./capture";

/** Span sets (X4.2): what a connector that submits spans builds, and the adapter a span format
 * implements. */
export type {
  AssembledSpans,
  Chunk,
  DocumentHead,
  FormatAdapter,
  FormatDetection,
  HeadValue,
  JsonObject,
  ReceivedSpan,
  SpanAdapter,
  SpanAttribute,
  SpanPart,
  SpanResource,
  SpanValue,
} from "@seshi/model";
export {
  type CaptureAgent,
  type CaptureHost,
  expandTilde,
  type HookCapture,
  type HookHandler,
  type HookResult,
  hookHandler,
  type InstallContext,
  type Installer,
  type InstallReport,
  type InstallStatus,
  payloadObject,
  type SweepPath,
  stringField,
  type TranscriptInfo,
} from "./capture";
export {
  commandLine,
  isSeshiHook,
  isSeshiStatusline,
  readJsonConfig,
  readTextFile,
  writeFileAtomic,
  writeJsonConfig,
} from "./files";

/** What a connector's `submit` answers: the pipeline's answer for the envelope (X4). A permanent
 * failure is recorded under `sources/<id>/failed/` and answered `failed` (X4.8); a transient one
 * (the store) is thrown, so the run fails and the checkpoint stays where it was. */
export type SubmitOutcome =
  | StoreSessionResult
  | { status: "failed"; code: string; message: string; record: string }
  | {
      status: "accepted";
      archive_id: string;
      /** Spans in the span store; the assembler publishes the session later (X4.4). */
      spans: number;
      /** Spans of the envelope the format could not read (no start time, ids that are not
       * OTLP hex), left out. */
      rejected?: number;
    };

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
  /** Save `cursor`. Write after the envelopes it covers were submitted, never before. Once a
   * `submit` in this run has thrown (a transient failure, X4.8), `write` refuses, so the
   * checkpoint never moves past an envelope that was not handled. */
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
  /** Record a permanent failure of something that never became an envelope (X4.8): an object
   * whose format nothing detects, one over the size limit, bytes that are not text. It is
   * written under `sources/<id>/failed/` like the pipeline's own failure records, counts as
   * `failed` in source health, and returns the record's key. Optional so contexts built by
   * hand (tests) need not provide it; the instance's scheduler always does. */
  fail?(failure: ConnectorFailure): Promise<string>;
}

/** What `ConnectorContext.fail` records: where and why, never content. */
export interface ConnectorFailure {
  /** A stable code (`unknown_format`, `too_large`, `not_utf8`). */
  code: string;
  /** What went wrong, in words, without quoting the data. */
  message: string;
  /** The session the item would have been, when known. */
  session_key?: string;
  /** The key the envelope would have carried (X4.7): what `seshi reprocess` asks for again. */
  idempotency_key: string;
  /** Where in the source the item is (object key and ETag, API cursor). */
  provenance?: SourceLocation;
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

/** Everything one vendor or agent provides. Lists are optional: an integration provides what it
 * has. */
export interface Integration {
  /** The integration's name: its folder under `integrations/` (`claude-code`, `datadog-trajectory`). */
  readonly name: string;
  /** Transcript formats this integration reads. */
  readonly formats?: readonly FormatAdapter[];
  readonly connectors?: readonly Connector[];
  /** How a coding agent's sessions are captured on a machine (F9): its hook handlers, sweep
   * folders and installer. Its own module, loaded alone by `seshi hook` (X3.3). */
  readonly capture?: CaptureAgent;
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

/** Every agent the integrations capture, in registry order. Two integrations capturing under
 * one agent name are refused: `seshi hook <agent>` would reach whichever came first. */
export function capturesOf(integrations: readonly Integration[]): CaptureAgent[] {
  const owners = new Map<string, string>();
  const agents: CaptureAgent[] = [];
  for (const integration of integrations) {
    const agent = integration.capture;
    if (!agent) continue;
    const owner = owners.get(agent.name);
    if (owner !== undefined) {
      throw new Error(
        `capture agent '${agent.name}' is provided by both '${owner}' and '${integration.name}'`,
      );
    }
    owners.set(agent.name, integration.name);
    agents.push(agent);
  }
  return agents;
}
