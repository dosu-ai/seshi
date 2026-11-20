import { NormalizeError, type NormalizeInput } from "@seshi/formats";
import { normalizeTranscript as normalize } from "@seshi/pipeline";
import { buildFormats } from "seshi/integrations";
import { describe, expect, it } from "vitest";
import { transcript } from "../tooling/testdata";

/** This binary's formats, as `seshi serve` builds them, and redaction after: what the server
 * stores. */
const FORMATS = buildFormats();
const normalizeTranscript = (input: NormalizeInput) => normalize(FORMATS, input);
const read = transcript;

const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz012345";

describe("normalizeTranscript for Claude Code", () => {
  it("redacts every text that ships and keeps tool linkage intact", async () => {
    const { records } = normalizeTranscript({
      source: "claude-code",
      transcript: read("claude-basic.claude-code.jsonl"),
    });
    const shipped = JSON.stringify(records);
    expect(shipped).not.toContain(GITHUB_TOKEN);
    expect(shipped).not.toContain("hunter2secretvalue42");
    expect(shipped).toContain("[redacted:github-token]");
    expect(shipped).toContain("[redacted:credential]");
    const call = records.find((r) => "tool_calls" in r) as { tool_calls: { id: string }[] };
    const result = records.find((r) => r.role === "tool") as { tool_call_id: string };
    expect(call.tool_calls[0]?.id).toBe("toolu_01AbCdEfGhJkLmNpQr");
    expect(result.tool_call_id).toBe("toolu_01AbCdEfGhJkLmNpQr");
  });

  it("returns empty for an empty transcript", async () => {
    expect(normalizeTranscript({ source: "claude-code", transcript: "\n\n" })).toEqual({
      records: [],
      empty: true,
    });
  });

  it("returns empty for a transcript with no conversation in it", async () => {
    const transcript = `${JSON.stringify({ type: "summary", summary: "nothing" })}\n`;
    expect(normalizeTranscript({ source: "claude-code", transcript })).toEqual({
      records: [],
      empty: true,
    });
  });

  it("throws NormalizeError when the adapter fails for any other reason", () => {
    expect(() => normalizeTranscript({ source: "nope" as "codex", transcript: "{}\n" })).toThrow(
      NormalizeError,
    );
  });
});

describe("normalizeTranscript in chunks", () => {
  const LOGS: [string, "claude-code" | "codex" | "datadog-trajectory" | "pi"][] = [
    ["claude-basic.claude-code.jsonl", "claude-code"],
    ["claude-queued-input.claude-code.jsonl", "claude-code"],
    ["claude-task-notification.claude-code.jsonl", "claude-code"],
    ["claude-usage.claude-code.jsonl", "claude-code"],
    ["codex-subagent-report.codex.jsonl", "codex"],
    ["codex-forked-subagent.codex.jsonl", "codex"],
    ["datadog-claude-session.datadog-trajectory.jsonl", "datadog-trajectory"],
    ["datadog-backfilled-session.datadog-trajectory.jsonl", "datadog-trajectory"],
    ["pi-injected.pi.jsonl", "pi"],
  ];
  const sessionOf = (source: string, log: string): string => {
    const first = JSON.parse(log.slice(0, log.indexOf("\n"))) as Record<string, unknown>;
    if (source === "codex") return (first.payload as Record<string, string>).id;
    if (source === "pi") return first.id as string;
    return (first.sessionId ?? first.session_id) as string;
  };

  it.each(LOGS)(
    "%s: cut at any line, the head whole and the tail as a chunk normalize to what the whole does",
    (name, source) => {
      // One more turn of the subagent's own on the forked rollout, so a cut past its inherited
      // history and first turn exists.
      const log =
        read(name) +
        (name.startsWith("codex-forked")
          ? `${JSON.stringify({
              timestamp: "2026-10-02T10:00:01.000Z",
              ordinal: 6,
              type: "response_item",
              payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Then ran them." }],
              },
            })}\n`
          : "");
      const whole = normalizeTranscript({ source, transcript: log });
      expect(whole.empty).toBeFalsy();
      const session_id = sessionOf(source, log);
      const lines = log.split("\n");
      let cuts = 0;
      for (let i = 1; i < lines.length - 1; i++) {
        const head = `${lines.slice(0, i).join("\n")}\n`;
        const tail = lines.slice(i).join("\n");
        const rest = normalizeTranscript({
          source,
          transcript: tail,
          chunk: { offset: Buffer.byteLength(head), session_id },
        });
        // A chunk carries no meta record of its own.
        expect(rest.records.some((r) => r.role === "meta")).toBe(false);

        // The head as the whole log so far (the session's first upload), the tail as a chunk.
        const first = normalizeTranscript({ source, transcript: head });
        if (!first.empty) {
          expect([...first.records, ...rest.records]).toEqual(whole.records);
          cuts++;
        }
      }
      expect(cuts).toBeGreaterThan(0);
    },
  );

  it("is empty for a chunk with no records in it, not for one with any", () => {
    const noise = '{"type":"progress","uuid":"p","sessionId":"s","data":{}}\n';
    expect(
      normalizeTranscript({
        source: "claude-code",
        transcript: noise,
        chunk: { offset: 10, session_id: "s" },
      }),
    ).toEqual({ records: [], empty: true });
    const log = read("claude-basic.claude-code.jsonl");
    const last = log.trimEnd().split("\n").at(-1) as string;
    const chunk = normalizeTranscript({
      source: "claude-code",
      transcript: `${last}\n`,
      chunk: { offset: Buffer.byteLength(log) - Buffer.byteLength(last) - 1, session_id: "sess1" },
    });
    expect(chunk.empty).toBeFalsy();
    expect(chunk.records).toHaveLength(1);
  });

  it("names a Codex call the same whole or in chunks; a head cut before its count names none", () => {
    const log = read("codex-usage.codex.jsonl");
    const session_id = "01a0ff74-0000-7ad0-83ee-000000000001";
    const whole = normalizeTranscript({ source: "codex", transcript: log });
    const withoutCall = (record: object) => {
      const { llm_call: _, ...rest } = record as { llm_call?: string };
      return rest;
    };
    const calls = (records: readonly object[]) =>
      records.map((r) => (r as { llm_call?: string }).llm_call ?? null);
    const lines = log.split("\n");
    for (let i = 3; i < lines.length - 1; i++) {
      const head = `${lines.slice(0, i).join("\n")}\n`;
      const first = normalizeTranscript({ source: "codex", transcript: head });
      // A head with no conversation yet is not a session's first upload.
      if (first.empty) continue;
      const rest = normalizeTranscript({
        source: "codex",
        transcript: lines.slice(i).join("\n"),
        chunk: { offset: Buffer.byteLength(head), session_id },
      });
      const chunked = [...first.records, ...rest.records];
      // The text is the whole log's at any cut…
      expect(chunked.map(withoutCall)).toEqual(whole.records.map(withoutCall));
      // …and every call a chunk names is the whole log's, with the same usage (a chunk that
      // starts inside a turn has not seen the turn's model).
      for (const part of [first, rest]) {
        for (const call of part.empty ? [] : (part.llm_calls ?? [])) {
          const same = (whole.empty ? [] : (whole.llm_calls ?? [])).find((c) => c.id === call.id);
          expect(same).toMatchObject(call);
          expect(call.usage).toEqual(same?.usage);
        }
      }
      // Cut after a token count (between turns or calls): the same records exactly.
      if (lines[i - 1]?.includes('"token_count"') && !lines[i - 1]?.includes('"info":null')) {
        expect(chunked).toEqual(whole.records);
      }
      // Cut between a call's tool call and its count: the head cannot know the call yet.
      if (i === 6) {
        expect(calls(whole.records).slice(2, 4)).toEqual(["call@897", "call@897"]);
        expect(calls(first.records).slice(2, 4)).toEqual([null, null]);
      }
    }
  });
});
