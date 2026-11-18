/** Content an agent or a plugin added to a user turn: kept and labelled `synthetic`, or left out
 * when its integrator flags it (`session_capture.omit`), only ever on user-side input. Through
 * this binary's formats and redaction, as the server stores it. */

import {
  fromOtlp,
  type NormalizeInput,
  OMITTED_TEXT,
  omitRequested,
  renderTrace,
  SESSION_CAPTURE_KEY,
  toOtlp,
} from "@seshi/formats";
import { parseTrace, TrajectoryError } from "@seshi/model";
import { normalizeTranscript as normalize } from "@seshi/pipeline";
import { buildFormats } from "seshi/integrations";
import { describe, expect, it } from "vitest";
import { transcript } from "../tooling/testdata";

const FORMATS = buildFormats();
const normalizeTranscript = (input: NormalizeInput) => normalize(FORMATS, input);

interface Labelled {
  role: string;
  content?: string | null;
  timestamp?: string;
  synthetic?: true;
  omitted?: number;
}

const DIGEST = "Team knowledge: KEY comes from the vault";

function stored(source: "opencode" | "pi", file: string): Labelled[] {
  const outcome = normalizeTranscript({ source, transcript: transcript(file) });
  expect(outcome.empty).toBeFalsy();
  return parseTrace(outcome.records).records as unknown as Labelled[];
}

describe("the omit flag", () => {
  it("is `session_capture.omit` set to true, and nothing else", () => {
    expect(SESSION_CAPTURE_KEY).toBe("session_capture");
    expect(omitRequested({ session_capture: { omit: true } })).toBe(true);
    expect(omitRequested({ dosu_memory: true, session_capture: { omit: true } })).toBe(true);
    for (const metadata of [
      undefined,
      null,
      "omit",
      [],
      {},
      { omit: true },
      { session_capture: true },
      { session_capture: { omit: "true" } },
      { session_capture: { omit: 1 } },
      { session_capture: { omit: false } },
      { session_capture: [{ omit: true }] },
    ]) {
      expect(omitRequested(metadata)).toBe(false);
    }
  });
});

describe.each([
  ["opencode", "opencode-injected.opencode.json"],
  ["pi", "pi-injected.pi.jsonl"],
] as const)("%s injected content", (source, file) => {
  it("stores none of a flagged item's text, and counts it on its record", () => {
    const records = stored(source, file);
    const text = JSON.stringify(records);
    expect(text).not.toContain(DIGEST);
    expect(text).not.toContain(OMITTED_TEXT);
    const omitted = records.filter((r) => r.omitted !== undefined);
    expect(omitted).toEqual([
      expect.objectContaining({ role: "user", content: "", synthetic: true, omitted: 1 }),
    ]);
  });

  it("keeps an unflagged synthetic item's text as it was, labelled synthetic", () => {
    const records = stored(source, file);
    const synthetic = records.filter((r) => r.synthetic && r.omitted === undefined);
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0]).toMatchObject({ role: "user" });
    expect(synthetic[0]?.content).toBe(
      source === "opencode"
        ? 'Called the Read tool with the following input: {"filePath":"/repo/app/src/auth.ts"}'
        : "Repository rule: never edit generated files.",
    );
  });

  it("leaves what the member typed unlabelled", () => {
    const typed = stored(source, file).find((r) => r.role === "user");
    expect(typed?.content).toMatch(/^Why does/);
    expect(typed).not.toHaveProperty("synthetic");
    expect(typed).not.toHaveProperty("omitted");
  });

  it("ignores the flag on what the model wrote and on a tool's result", () => {
    const records = stored(source, file);
    // Both carry the flag in the fixture: the assistant's text in OpenCode, the tool part in
    // OpenCode and the tool result's `details` in pi.
    expect(records).toContainEqual(
      expect.objectContaining({ role: "assistant", content: "Checking where KEY is set." }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({ role: "tool", content: "src/auth.ts:1:export const KEY = 1;" }),
    );
    for (const record of records.filter((r) => r.role !== "user")) {
      expect(record).not.toHaveProperty("synthetic");
      expect(record).not.toHaveProperty("omitted");
    }
  });

  it("drops the labels from a Letta render, which hashes the same", () => {
    const trace = parseTrace(normalizeTranscript({ source, transcript: transcript(file) }).records);
    const letta = renderTrace(trace, "letta");
    const text = JSON.stringify(letta.records);
    expect(text).not.toContain('"synthetic"');
    expect(text).not.toContain('"omitted"');
    expect(letta.content_hash).toBe(trace.content_hash);
  });

  it("keeps the labels through an OTLP render and back", () => {
    const trace = parseTrace(normalizeTranscript({ source, transcript: transcript(file) }).records);
    expect(fromOtlp(JSON.parse(JSON.stringify(toOtlp(trace))))).toEqual(trace);
  });
});

describe("pi custom messages", () => {
  it("are stored as the user messages the model saw, where it saw them", () => {
    const users = stored("pi", "pi-injected.pi.jsonl").filter((r) => r.role === "user");
    expect(users.map((r) => r.timestamp)).toEqual([
      "2026-11-17T10:00:01.000Z",
      "2026-11-17T10:00:01.100Z",
      "2026-11-17T10:00:01.200Z",
    ]);
  });
});

describe("a stored record's labels", () => {
  const base = [
    { role: "meta", source: "opencode" },
    { role: "user", content: "hi", timestamp: "2026-01-01T00:00:00.000Z" },
    { role: "assistant", content: "hello", timestamp: "2026-01-01T00:00:01.000Z" },
  ];
  const withUser = (extra: Record<string, unknown>) => [base[0], { ...base[1], ...extra }, base[2]];

  it("are kept on user records", () => {
    const trace = parseTrace(withUser({ synthetic: true, omitted: 2 }));
    expect(trace.records[1]).toMatchObject({ synthetic: true, omitted: 2 });
  });

  it("are dropped from any other record", () => {
    const trace = parseTrace([
      base[0],
      base[1],
      { ...base[2], synthetic: true, omitted: 1 },
      { role: "reasoning", content: "hm", timestamp: "2026-01-01T00:00:02.000Z", synthetic: true },
    ]);
    for (const record of trace.records.slice(2)) {
      expect(record).not.toHaveProperty("synthetic");
      expect(record).not.toHaveProperty("omitted");
    }
  });

  it.each([
    [{ synthetic: false }, "synthetic must be true"],
    [{ synthetic: "yes" }, "synthetic must be true"],
    [{ omitted: 0 }, "omitted must be an integer"],
    [{ omitted: 1.5 }, "omitted must be an integer"],
    [{ omitted: "1" }, "omitted must be an integer"],
  ])("refuse %j", (extra, message) => {
    expect(() => parseTrace(withUser(extra))).toThrow(TrajectoryError);
    expect(() => parseTrace(withUser(extra))).toThrow(message);
  });
});
