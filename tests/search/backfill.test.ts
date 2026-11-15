/** Search after a redaction backfill (07 -> 12): `seshi redact backfill` rewrites a session with
 * new rules and writes a `published` change entry with `replace: true` and `reason: "redacted"`.
 * The indexer drops everything it held of the session and reads it again from the trace the
 * entry names, so what the new rules take out stops being searchable. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import type { StoreSessionResult, Writer } from "@seshi/model";
import { backfillRedaction, Pipeline, uploadEnvelope } from "@seshi/pipeline";
import { compileRuleSet, ruleRedactor, validatePack } from "@seshi/redact";
import { Indexer, LOCAL_VIEWER, MEMORY_INDEX, parseQuery, SqliteIndex } from "@seshi/search";
import { archiveId, FsStore, readChanges, readMetadata, type Store } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const formats = new FormatRegistry(BUILTIN_FORMATS);
const EVENTS = ["user", "assistant", "tool_call"] as const;
const ts = "2026-09-01T00:00:00Z";
const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const PAD = ` ${"context ".repeat(260)}`;
const OPERATOR: Writer = { kind: "admin", principal: "admin", source_id: "redaction" };
const acme = validatePack(
  { id: "acme", rules: [{ id: "acme-key", pattern: "ACME-\\d{4}" }] },
  { source: "acme.toml" },
);

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-search-backfill-"));
  store = new FsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Store through a pipeline with the built-in pack only (the old rules). */
async function upload(sessionId: string, transcript: string, offset = 0) {
  const pipeline = new Pipeline({ store, formats, redaction: compileRuleSet() });
  return (await pipeline.submit(
    uploadEnvelope(
      {
        owner: "alice",
        agent: "trajectory",
        session_id: sessionId,
        transcript,
        format: "jsonl",
        offset,
      },
      { caller: { kind: "static", principal: "alice" }, owner_basis: "verified" },
    ),
  )) as StoreSessionResult;
}

function searchable() {
  const index = new SqliteIndex({ path: MEMORY_INDEX, deployment: "d", events: EVENTS });
  const indexer = new Indexer({ store, index, events: EVENTS, ownerRefreshMs: 0 });
  const find = async (q: string) => {
    await indexer.catchUp();
    return index
      .query({
        match: parseQuery(q).match,
        viewer: LOCAL_VIEWER,
        sort: "relevance",
        limit: 50,
        offset: 0,
        matches: 5,
      })
      .hits.map((h) => `${h.session.owner}/${h.session.session_id}`);
  };
  return { index, find };
}

describe("search after a redaction backfill (07)", () => {
  it("forgets what the new rules took out, and indexes the rewritten trace", async () => {
    // A session in two traces (a whole upload, then a chunk), the key in both.
    const head =
      line({ role: "meta", source: "trajectory", cwd: "/work/widget" }) +
      line({ role: "user", content: `deploy with ACME-1234 please${PAD}`, timestamp: ts }) +
      line({ role: "assistant", content: "deployed", timestamp: ts });
    await upload("s1", head);
    await upload(
      "s1",
      line({ role: "user", content: "rotate ACME-5678 next", timestamp: ts }),
      Buffer.byteLength(head),
    );
    const archive = archiveId("alice", "trajectory", "s1");
    expect((await readMetadata(store, "alice", archive))?.traces).toHaveLength(2);

    const { index, find } = searchable();
    expect(await find("1234")).toEqual(["alice/s1"]);
    expect(await find("5678")).toEqual(["alice/s1"]);

    const report = await backfillRedaction({
      store,
      redactor: ruleRedactor(compileRuleSet({ packs: [acme] })),
      writer: OPERATOR,
    });
    expect(report.outcomes.rewritten).toBe(1);
    const rewritten = report.sessions[0]?.content_hash as string;
    const entries = (await readChanges(store, "alice")).entries.map((e) => e.entry);
    expect(entries.at(-1)).toMatchObject({
      kind: "published",
      content_hash: rewritten,
      replace: true,
      reason: "redacted",
    });

    expect(await find("1234")).toEqual([]);
    expect(await find("5678")).toEqual([]);
    // The rest of the session is still found, now from the one rewritten trace.
    expect(await find("deploy")).toEqual(["alice/s1"]);
    expect(await find("rotate")).toEqual(["alice/s1"]);
    expect(index.session("alice", archive)?.traces).toEqual([rewritten]);
  });
});
