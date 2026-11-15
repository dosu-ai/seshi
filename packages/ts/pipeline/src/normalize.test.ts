import { FormatRegistry, TRAJECTORY_FORMAT } from "@seshi/formats";
import type { FormatAdapter, NormalizedRecord } from "@seshi/model";
import { describe, expect, it } from "vitest";
import { normalizeTranscript } from "./normalize";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz012345";

const META: NormalizedRecord = { role: "meta", source: "fake" };
const user = (content: string): NormalizedRecord =>
  ({ role: "user", content, timestamp: "2026-09-01T00:00:00Z" }) as NormalizedRecord;

/** An adapter that returns what it is told to, and records how it was called. */
function fake(records: NormalizedRecord[]): FormatAdapter & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    source: "fake",
    chunkable: true,
    calls,
    normalize(transcript, chunk) {
      calls.push({ transcript, chunk });
      return records;
    },
  };
}

describe("normalizeTranscript", () => {
  it("runs the registry's adapter and redacts what it returns", () => {
    const adapter = fake([META, user(`token ${SECRET}`)]);
    const { records } = normalizeTranscript(new FormatRegistry([adapter]), {
      source: "fake",
      transcript: "anything",
    });
    expect(adapter.calls).toEqual([{ transcript: "anything", chunk: undefined }]);
    expect(JSON.stringify(records)).not.toContain(SECRET);
    expect(JSON.stringify(records)).toContain("[redacted:github-token]");
  });

  it("passes the chunk through to the adapter", () => {
    const adapter = fake([user("more")]);
    const chunk = { offset: 10, session_id: "s" };
    normalizeTranscript(new FormatRegistry([adapter]), {
      source: "fake",
      transcript: "x\n",
      chunk,
    });
    expect(adapter.calls).toEqual([{ transcript: "x\n", chunk }]);
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
