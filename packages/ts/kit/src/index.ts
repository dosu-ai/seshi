/** `@seshi/kit`: the contract an integration implements (X3.11). Each integration exports one
 * `Integration` listing what it provides; `apps/seshi` puts every integration in a static
 * registry and hands what they provide to the parts that run it (the format registry today; the
 * instance's connector scheduler and `@seshi/capture` as they are built).
 *
 * Integrations import only `@seshi/model`, `@seshi/kit` and `@seshi/formats` (X3.2). Layer 1:
 * this package imports only `@seshi/model`. */

import type { FormatAdapter } from "@seshi/model";

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

/** A poller for one vendor's API (X7). It never touches the store or the pipeline: the
 * instance gives it a context to submit envelopes and keep its checkpoint. Declared now; the
 * context is defined with the scheduler. */
export interface Connector {
  /** The connector kind a source's config names (`datadog-llmobs`). */
  readonly kind: string;
  run(context: unknown): Promise<void>;
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
