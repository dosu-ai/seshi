/** A Datadog Trajectory stream through this binary's formats and the pipeline. What a whole
 * stream normalizes to, redacted, is its golden (`tests/goldens.test.ts`). */

import type { NormalizeInput } from "@seshi/formats";
import { normalizeTranscript as normalize } from "@seshi/pipeline";
import { buildFormats } from "seshi/integrations";
import { describe, expect, it } from "vitest";

const FORMATS = buildFormats();
const normalizeTranscript = (input: NormalizeInput) => normalize(FORMATS, input);

const event = (type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ event_type: type, session_id: "s1", client_source: "pi", ...extra });

describe("normalizeTranscript for datadog-trajectory", () => {
  it("calls a stream with no conversation yet empty, not an error", () => {
    const outcome = normalizeTranscript({
      source: "datadog-trajectory",
      transcript: event("session_start", { timestamp: "2026-10-29T20:00:00Z" }),
    });
    expect(outcome).toEqual({ records: [], empty: true });
  });
});
