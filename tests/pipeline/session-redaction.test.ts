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

// Split so no scanner reads a key in this file; the redactor sees the joined value.
const awsKey = ["AKIA", "IOSFODNN7EXAMPLQ"].join("");
const keyLine = line({
  type: "user",
  uuid: "u3",
  parentUuid: "a2",
  timestamp: at(4),
  sessionId: sid,
  message: { role: "user", content: `Now use ${awsKey} for the deploy.` },
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

  it("redacts the tail of a whole re-upload that extends the stored session", async () => {
    // A first whole upload with the call, then the whole log again (no offset, no replace) with
    // its sensitive result and a secret: the tail goes through its own pass, carrying the
    // prefix's withheld call, as `seshi upload` or an uploader's whole resend send it.
    await storeSession(
      {
        owner,
        agent: "claude-code",
        session_id: sid,
        transcript: prompt + readEnv,
        format: "jsonl",
      },
      { store, formats },
    );
    // The withheld call counts once, when its call is written.
    expect((await getSession(store, owner, "claude-code", sid))?.redaction?.counts).toEqual({
      "sensitive-file": 1,
    });
    const result = await storeSession(
      {
        owner,
        agent: "claude-code",
        session_id: sid,
        transcript: prompt + readEnv + envResult + answer + keyLine,
        format: "jsonl",
      },
      { store, formats },
    );
    expect(result.status).toBe("stored");
    const trace = await headTrace();
    expect(trace).toContain("Done.");
    expect(trace).not.toContain("plainvalue");
    expect(trace).not.toContain(awsKey);
    expect(trace).toContain("[redacted:sensitive-file]");
    expect(everything(dir)).not.toContain("plainvalue");
    expect(everything(dir)).not.toContain(awsKey);
    // Only the tail's matches are added: the prefix was counted when it was written.
    const metadata = await getSession(store, owner, "claude-code", sid);
    expect(metadata?.withheld_calls).toEqual({ toolu_env: "sensitive-file" });
    expect(metadata?.redaction?.counts).toEqual({ "sensitive-file": 1, "aws-access-key": 1 });
  });

  it("redacts a replace that rewrites the stored session", async () => {
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
    // A rewrite whose records do not start with what is stored, so only `replace` takes it.
    const rewritten = line({
      type: "user",
      uuid: "u1",
      timestamp: at(0),
      sessionId: sid,
      message: { role: "user", content: "Check the env again." },
    });
    const result = await storeSession(
      {
        owner,
        agent: "claude-code",
        session_id: sid,
        transcript: rewritten + readEnv + envResult + answer + keyLine,
        format: "jsonl",
        replace: true,
      },
      { store, formats },
    );
    expect(result.status).toBe("stored");
    const trace = await headTrace();
    expect(trace).toContain("Check the env again.");
    expect(trace).not.toContain("plainvalue");
    expect(trace).not.toContain(awsKey);
    expect(trace).toContain("[redacted:sensitive-file]");
    expect(everything(dir)).not.toContain("plainvalue");
    expect(everything(dir)).not.toContain(awsKey);
    const metadata = await getSession(store, owner, "claude-code", sid);
    expect(metadata?.withheld_calls).toEqual({ toolu_env: "sensitive-file" });
    // The rewrite's own matches, counted over from nothing.
    expect(metadata?.redaction?.counts).toEqual({ "sensitive-file": 1, "aws-access-key": 1 });
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
