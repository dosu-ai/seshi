/** A Datadog Trajectory stream through this binary's formats and the pipeline's redaction. */

import type { NormalizeInput } from "@seshi/formats";
import { normalizeTranscript as normalize } from "@seshi/pipeline";
import { buildFormats } from "seshi/integrations";
import { describe, expect, it } from "vitest";
import { transcript } from "../tooling/testdata";

const FORMATS = buildFormats();
const normalizeTranscript = (input: NormalizeInput) => normalize(FORMATS, input);

/** A session file as Trajectory writes it for a session it captured live. */
const STREAM = transcript("datadog-claude-session.datadog-trajectory.jsonl");

const event = (type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ event_type: type, session_id: "s1", client_source: "pi", ...extra });

describe("normalizeTranscript for datadog-trajectory", () => {
  it("redacts, and keeps tool linkage", () => {
    const { records } = normalizeTranscript({ source: "datadog-trajectory", transcript: STREAM });
    const shipped = JSON.stringify(records);
    expect(shipped).not.toContain("hunter2secretvalue42");
    expect(shipped).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
    expect(shipped).toContain("[redacted:github-token]");
    expect(shipped).toContain("toolu_01AbCdEfGhJkLmNpQr");
  });

  it("calls a stream with no conversation yet empty, not an error", () => {
    const outcome = normalizeTranscript({
      source: "datadog-trajectory",
      transcript: event("session_start", { timestamp: "2026-10-29T20:00:00Z" }),
    });
    expect(outcome).toEqual({ records: [], empty: true });
  });
});
