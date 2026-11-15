import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import { SessionRejected } from "@seshi/model";
import { FsStore } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeSession } from "./session";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-session-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("storeSession", () => {
  it("refuses an agent the registry has no format for, before writing anything", async () => {
    const upload = storeSession(
      {
        owner: "alice",
        agent: "claude",
        session_id: "s1",
        transcript: '{"role":"user","content":"hi"}\n',
        format: "jsonl",
      },
      { store: new FsStore(dir), formats: new FormatRegistry(BUILTIN_FORMATS) },
    );
    await expect(upload).rejects.toBeInstanceOf(SessionRejected);
    await expect(upload).rejects.toMatchObject({
      code: "unsupported_agent",
      message: "no normalizer for 'claude' (one of atif, trajectory)",
    });
    expect(readdirSync(dir)).toEqual([]);
  });
});
