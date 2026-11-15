import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { getSession, storeSession } from "@seshi/pipeline";
import { redactionRules } from "@seshi/redact";
import { archiveId, FsStore, getBytes, keys } from "@seshi/store";
import { buildFormats } from "seshi/integrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const formats = buildFormats();

let dir: string;
let store: FsStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sessiondb-redaction-"));
  store = new FsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const owner = "acme";
const sid = "sess-r";
const line = (row: object) => `${JSON.stringify(row)}\n`;
const at = (s: number) => new Date(Date.UTC(2026, 10, 11, 12, 0, s)).toISOString();

const prompt = line({
  type: "user",
  uuid: "u1",
  timestamp: at(0),
  sessionId: sid,
  message: {
    role: "user",
    content: `Check the env and the customer cust_abc123. ${"x".repeat(2100)}`,
  },
});
const readEnv = line({
  type: "assistant",
  uuid: "a1",
  parentUuid: "u1",
  timestamp: at(1),
  sessionId: sid,
  message: {
    role: "assistant",
    model: "claude-x",
    content: [
      { type: "tool_use", id: "toolu_env", name: "Read", input: { file_path: "/repo/.env" } },
    ],
  },
});
const envResult = line({
  type: "user",
  uuid: "u2",
  parentUuid: "a1",
  timestamp: at(2),
  sessionId: sid,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_env", content: "STRIPE_PW=plainvalue" }],
  },
  toolUseResult: { file: { filePath: "/repo/.env", content: "STRIPE_PW=plainvalue" } },
});
const answer = line({
  type: "assistant",
  uuid: "a2",
  parentUuid: "u2",
  timestamp: at(3),
  sessionId: sid,
  message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "Done." }] },
});

/** The head trace as stored, as text. */
async function headTrace(): Promise<string> {
  const metadata = await getSession(store, owner, "claude-code", sid);
  const bytes = await getBytes(
    store,
    keys.trace(owner, archiveId(owner, "claude-code", sid), metadata?.head as string),
  );
  return new TextDecoder().decode(gunzipSync(bytes as Uint8Array));
}

/** Everything in the store, as text (gzipped objects unzipped). */
function everything(root: string): string {
  let out = "";
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const bytes = readFileSync(join(entry.parentPath, entry.name));
    out += entry.name.endsWith(".gz") ? gunzipSync(bytes).toString() : bytes.toString();
  }
  return out;
}

describe("storeSession redaction", () => {
  it("withholds a sensitive result that arrives in a later chunk than its call", async () => {
    // The call and its result in one whole upload first, so the session has a trace…
    const first = prompt + readEnv;
    const one = await storeSession(
      { owner, agent: "claude-code", session_id: sid, transcript: first, format: "jsonl" },
      { store, formats },
    );
    expect((await getSession(store, owner, "claude-code", sid))?.withheld_calls).toEqual({
      toolu_env: "sensitive-file",
    });

    await storeSession(
      {
        owner,
        agent: "claude-code",
        session_id: sid,
        transcript: envResult + answer,
        format: "jsonl",
        offset: one.bytes_total,
      },
      { store, formats },
    );
    // …then the result in a chunk of its own: withheld from the ids the session carries.
    const trace = await headTrace();
    expect(trace).not.toContain("plainvalue");
    expect(trace).toContain("[redacted:sensitive-file]");
    expect(trace).toContain('"withheld":"sensitive-file"');
    expect(everything(dir)).not.toContain("plainvalue");
    expect((await getSession(store, owner, "claude-code", sid))?.withheld_calls).toEqual({
      toolu_env: "sensitive-file",
    });
  });

  it("applies the operator's patterns to the trace, and stores nothing else of the transcript", async () => {
    const redaction = redactionRules({ patterns: ["cust_[a-z0-9]{6}"] });
    const result = await storeSession(
      {
        owner,
        agent: "claude-code",
        session_id: sid,
        transcript: prompt + readEnv + envResult + answer,
        format: "jsonl",
      },
      { store, formats, redaction },
    );
    expect(result.status).toBe("stored");
    const text = await headTrace();
    expect(text).not.toContain("cust_abc123");
    expect(text).toContain("[redacted:custom-pattern]");
    expect(text).not.toContain("plainvalue");
    expect(everything(dir)).not.toContain("cust_abc123");
    expect(everything(dir)).not.toContain("plainvalue");
    // What ran is recorded, never what it matched (F2.3).
    const metadata = await getSession(store, owner, "claude-code", sid);
    expect(metadata?.redaction?.counts).toMatchObject({
      "custom-pattern": 1,
      "sensitive-file": 1,
    });
  });

  it("keeps no withheld_calls on a session that has none", async () => {
    await storeSession(
      {
        owner,
        agent: "claude-code",
        session_id: sid,
        transcript: prompt + answer,
        format: "jsonl",
      },
      { store, formats },
    );
    const metadata = await getSession(store, owner, "claude-code", sid);
    expect(metadata && "withheld_calls" in metadata).toBe(false);
  });
});
