import type { CaptureAgent } from "@seshi/kit";

export const CAPTURE_AGENTS: Readonly<Record<string, () => Promise<CaptureAgent>>> = {
  "claude-code": () =>
    import("@seshi/integration-claude-code/capture").then((m) => m.CLAUDE_CODE_CAPTURE),
  codex: () => import("@seshi/integration-codex/capture").then((m) => m.CODEX_CAPTURE),
  cursor: () => import("@seshi/integration-cursor/capture").then((m) => m.CURSOR_CAPTURE),
};

export function captureAgent(name: string): Promise<CaptureAgent> | undefined {
  return Object.hasOwn(CAPTURE_AGENTS, name) ? CAPTURE_AGENTS[name]?.() : undefined;
}

export function allCaptureAgents(): Promise<CaptureAgent[]> {
  return Promise.all(Object.values(CAPTURE_AGENTS).map((load) => load()));
}
