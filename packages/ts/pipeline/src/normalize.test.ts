import { FormatRegistry, TRAJECTORY_FORMAT } from "@seshi/formats";
import type { FormatAdapter, NormalizedRecord } from "@seshi/model";
import { describe, expect, it } from "vitest";
import { normalizeTranscript } from "./normalize";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz012345";

const META: NormalizedRecord = { role: "meta", source: "fake" };
const user = (content: string): NormalizedRecord =>
  ({ role: "user", content, timestamp: "2026-09-01T00:00:00Z" }) as NormalizedRecord;

/** An adapter that answers with one user record quoting the transcript it was given. */
const echo: FormatAdapter = {
  source: "fake",
  chunkable: true,
  normalize: (transcript) => [META, user(`${transcript.trim()}: token ${SECRET}`)],
};

describe("normalizeTranscript", () => {
  it("runs the registry's adapter and redacts what it returns", () => {
    const { records } = normalizeTranscript(new FormatRegistry([echo]), {
      source: "fake",
      transcript: "anything",
    });
    expect(records[1]).toMatchObject({ content: "anything: token [redacted:github-token]" });
    expect(JSON.stringify(records)).not.toContain(SECRET);
  });

  it("works over the built-in formats alone", () => {
    const line = JSON.stringify(user(`key ${SECRET}`));
    const { records } = normalizeTranscript(new FormatRegistry([TRAJECTORY_FORMAT]), {
      source: "trajectory",
      transcript: `${JSON.stringify(META)}\n${line}\n`,
      chunk: { offset: 5, session_id: "s" },
    });
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain(SECRET);
  });
});
