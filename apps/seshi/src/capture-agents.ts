/** The agents this binary captures (F9), each loaded on demand from its integration's own
 * capture module. `seshi hook <agent>` loads only the one it is called for, never the
 * integrations' format adapters (X3.3); the integration registry (`integrations.ts`) lists the
 * same objects as each integration's `capture`, which a test checks.
 *
 * A new agent adds one line here and its `capture` in its integration. */

import type { CaptureAgent } from "@seshi/kit";

export const CAPTURE_AGENTS: Readonly<Record<string, () => Promise<CaptureAgent>>> = {
  "claude-code": () =>
    import("@seshi/integration-claude-code/capture").then((m) => m.CLAUDE_CODE_CAPTURE),
  codex: () => import("@seshi/integration-codex/capture").then((m) => m.CODEX_CAPTURE),
  cursor: () => import("@seshi/integration-cursor/capture").then((m) => m.CURSOR_CAPTURE),
};

/** The agent named `name`, or undefined for one this binary does not capture. */
export function captureAgent(name: string): Promise<CaptureAgent> | undefined {
  return Object.hasOwn(CAPTURE_AGENTS, name) ? CAPTURE_AGENTS[name]?.() : undefined;
}

/** Every agent this binary captures. */
export function allCaptureAgents(): Promise<CaptureAgent[]> {
  return Promise.all(Object.values(CAPTURE_AGENTS).map((load) => load()));
}
