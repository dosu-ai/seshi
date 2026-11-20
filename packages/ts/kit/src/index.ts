import type { Envelope, FormatAdapter, SourceLocation, StoreSessionResult } from "@seshi/model";

import type { CaptureAgent } from "./capture";

export type {
  AssembledSpans,
  Chunk,
  DocumentHead,
  FormatAdapter,
  FormatDetection,
  HeadValue,
  JsonObject,
  NormalizedTranscript,
  ReceivedSpan,
  SpanAdapter,
  SpanAttribute,
  SpanPart,
  SpanResource,
  SpanValue,
} from "@seshi/model";
export { bridgeRuntime } from "./bridge";
export {
  CAPTURE_COMMAND,
  type CaptureAgent,
  type CaptureHost,
  captureCommandPrompt,
  captureDir,
  expandTilde,
  type HookCapture,
  type HookHandler,
  type HookResult,
  type HookToolResult,
  handedTranscriptDir,
  handedTranscriptPath,
  hookHandler,
  type InstallContext,
  type Installer,
  type InstallReport,
  type InstallStatus,
  keptAgentDir,
  keptSessionDir,
  payloadObject,
  type StoredSession,
  type SweepPath,
  stringField,
  type TranscriptComposer,
  type TranscriptInfo,
} from "./capture";
export {
  abortableSleep,
  apiUrlOverride,
  secretValue,
  serviceEnvelopeIdentity,
} from "./connector";
export {
  commandLine,
  isSeshiHook,
  isSeshiStatusline,
  readJsonConfig,
  readTextFile,
  writeFileAtomic,
  writeJsonConfig,
} from "./files";
export {
  installOwnedFiles,
  type OwnedFile,
  type OwnedFileState,
  ownedFileNotes,
  ownedFileState,
  removeOwnedFiles,
} from "./owned";
export { normalizeRemote, repoLabel } from "./remote";
export {
  captureSkill,
  installSkill,
  isOurSkill,
  removeSkill,
  SKILL_MARKER,
  skillFile,
} from "./skill";
export {
  attachStatusLine,
  chainedNote,
  detachStatusLine,
  type StatusLineTarget,
  savedStatusLine,
  statusLineNotes,
} from "./statusline";
export {
  blankEncoded,
  blankResult,
  blankStrings,
  blankUnknown,
  byType,
  isJsonObject,
  type RecordShape,
  redactRecords,
  redactTagBodies,
  reshape,
  TOOL_CALL_MARKER,
} from "./tool-calls";

export type SubmitOutcome =
  | StoreSessionResult
  | { status: "failed"; code: string; message: string; record: string }
  | {
      status: "accepted";
      archive_id: string;
      spans: number;
      rejected?: number;
    };

export interface ConnectorLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type Cursor = Record<string, unknown>;

export interface CheckpointHandle {
  read(): Cursor | null;
  write(cursor: Cursor): Promise<void>;
}

export class CheckpointLost extends Error {
  constructor(readonly sourceId: string) {
    super(`the checkpoint of source '${sourceId}' was moved by another worker; run discarded`);
    this.name = "CheckpointLost";
  }
}

export interface ConnectorContext<C = Readonly<Record<string, unknown>>> {
  readonly source: { readonly id: string; readonly type: string; readonly config: C };
  submit(envelope: Envelope): Promise<SubmitOutcome>;
  readonly checkpoint: CheckpointHandle;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  readonly log: ConnectorLogger;
  readonly signal: AbortSignal;
  now(): Date;
  fail?(failure: ConnectorFailure): Promise<string>;
  /** The org's exclude list (`[capture] exclude`, as the server runs it now): the entry that
   * names any of `repos` (URLs or `host/path`, in any form), if one does. A connector asks
   * before it fetches anything of a session: an excluded one never enters seshi. Folder entries
   * never match here. Absent where there is no list to apply. */
  excludedBy?(repos: readonly string[]): string | undefined;
  /** Count a session (or the change to one) left out because the org excludes its repository,
   * in the source's health (`excluded`, shown by `seshi sync status`). */
  excluded?(): void;
}

export interface ConnectorFailure {
  code: string;
  message: string;
  session_key?: string;
  idempotency_key: string;
  provenance?: SourceLocation;
}

export interface ConnectorRunResult {
  more?: boolean;
  lag_ms?: number;
}

export interface Connector<C = Readonly<Record<string, unknown>>> {
  readonly kind: string;
  run(context: ConnectorContext<C>): Promise<ConnectorRunResult | undefined>;
  rewind?(cursor: Cursor | null, since: Date, config: C): Cursor | null;
}

export interface Integration {
  readonly name: string;
  readonly formats?: readonly FormatAdapter[];
  readonly connectors?: readonly Connector[];
  readonly capture?: CaptureAgent;
}

const INTEGRATION_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
