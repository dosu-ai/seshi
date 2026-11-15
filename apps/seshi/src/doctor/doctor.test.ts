/** The session checks engine with every loader faked: each check passing and failing, and the
 * evidence gathered from fakes with errors recorded rather than thrown. */

import { createHash } from "node:crypto";
import type { CaptureState, SessionState } from "@seshi/capture";
import {
  type NormalizedRecord,
  prefixSha256,
  type SessionMetadata,
  type StoredTrace,
} from "@seshi/model";
import { describe, expect, it } from "vitest";
import {
  type CheckResult,
  chainCheck,
  changesCheck,
  type DoctorDeps,
  decisionCheck,
  distinctiveTerm,
  gatherEvidence,
  offsetsCheck,
  prefixCheck,
  presenceCheck,
  queueCheck,
  recordsCheck,
  residueCheck,
  retractedUploadId,
  runChecks,
  type ServerView,
  type SessionEvidence,
  searchCheck,
  secretCheck,
  stalenessCheck,
  transcriptCheck,
  worst,
} from "./index";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const SID = "s1";
const KEY = `claude-code:${SID}`;
const PATH = "/home/me/.claude/projects/-app/s1.jsonl";
const SECRET = "machine-secret";
const HASH = createHash("sha256").update(SECRET).digest("hex");
const TEXT = "meta\nfirst\nsecond\nthirdly\n";
const SIZE = Buffer.byteLength(TEXT);

/** The fake adapter: one record per line, the first a meta record. */
const toRecords = (text: string): NormalizedRecord[] =>
  text
    .split("\n")
    .filter(Boolean)
    .map(
      (line, i) =>
        (i === 0
          ? { role: "meta", source: "claude-code" }
          : { role: "user", content: line }) as NormalizedRecord,
    );
const RECORDS = toRecords(TEXT);
const PREFIX = prefixSha256(RECORDS, RECORDS.length);
const T1 = "a".repeat(64);
const T2 = "b".repeat(64);
const TRACE1 = RECORDS.slice(0, 3);
const TRACE2 = [RECORDS[0] as NormalizedRecord, RECORDS[3] as NormalizedRecord];

function metadata(over: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    schema: "seshi/metadata/1",
    owner: "me",
    archive_id: "c".repeat(64),
    session_id: SID,
    agent: "claude-code",
    status: "stored",
    head: T2,
    traces: [
      { content_hash: T1, created_at: NOW.toISOString(), records: 3, rule_set: "rs1" },
      {
        content_hash: T2,
        created_at: NOW.toISOString(),
        records: 2,
        rule_set: "rs1",
        continuation: { from_record: 3, prefix_sha256: prefixSha256(RECORDS, 3) },
      },
    ],
    normalized: { bytes: SIZE, records: 4, prefix_sha256: PREFIX, hash_state: "x" },
    writer: { kind: "person", principal: "me" },
    owner_basis: "verified",
    visibility: "org",
    redaction: { rule_set: "rs1", counts: {} },
    normalizer: { name: "seshi", version: "0", format_version: "2" },
    retract_hash: HASH,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...over,
  } as SessionMetadata;
}

function entry(over: Partial<SessionState> = {}): SessionState {
  return {
    agent: "claude-code",
    session_id: SID,
    path: PATH,
    cwd: "/home/me/app",
    first_seen: NOW.toISOString(),
    last_seen: NOW.toISOString(),
    secret: SECRET,
    sent: true,
    stored: true,
    file_offset: SIZE,
    server_offset: SIZE,
    sent_path: PATH,
    aligned: true,
    shipped: { records: 4, prefix_sha256: PREFIX },
    last_status: "stored",
    ...over,
  };
}

/** A captured session that passes every check. */
function evidence(over: (ev: SessionEvidence) => void = () => {}): SessionEvidence {
  const ev: SessionEvidence = {
    schema: "seshi/doctor-evidence/1",
    at: NOW.toISOString(),
    agent: "claude-code",
    session_id: SID,
    key: KEY,
    machine: { uploader: { running: false } },
    local: { ...entry(), secret: { present: true, sha256: HASH } },
    decision: { capture: true, level: "global", reason: "capture is on" },
    transcript: {
      path: PATH,
      exists: true,
      size: SIZE,
      mtime: NOW.toISOString(),
      identified_as: SID,
    },
    spool: { entries: [] },
    log: { lines: [] },
    capture: { format: "claude-code", encoding: "jsonl", chunkable: true },
    server: {
      mode: "server",
      where: "https://seshi.test",
      sees_stubs: false,
      agent: "claude-code",
      upload_id: SID,
      metadata: metadata(),
      traces: [
        {
          content_hash: T1,
          listed_records: 3,
          rule_set: "rs1",
          fetched: true,
          record_count: 3,
          starts_with_meta: true,
          stored_hash: T1,
          records: TRACE1,
        },
        {
          content_hash: T2,
          listed_records: 2,
          rule_set: "rs1",
          continuation: { from_record: 3, prefix_sha256: prefixSha256(RECORDS, 3) },
          fetched: true,
          record_count: 2,
          starts_with_meta: true,
          stored_hash: T2,
          records: TRACE2,
        },
      ],
      changes: [change("published", T1), change("published", T2)],
    },
  };
  over(ev);
  return ev;
}

function change(kind: string, content_hash?: string) {
  return {
    key: `k-${kind}-${content_hash ?? ""}`,
    entry: {
      schema: "seshi/change/1",
      kind,
      at: NOW.toISOString(),
      owner: "me",
      archive_id: "c".repeat(64),
      session_id: SID,
      ...(content_hash ? { content_hash } : {}),
    },
  } as unknown as NonNullable<SessionEvidence["server"]["changes"]>[number];
}

function state(sessions: Record<string, SessionState> = { [KEY]: entry() }): CaptureState {
  return { schema: "seshi/capture-state/1", agents: {}, sessions };
}

function fakeServer(over: Partial<ServerView> = {}): ServerView {
  const traces: Record<string, NormalizedRecord[]> = { [T1]: TRACE1, [T2]: TRACE2 };
  return {
    mode: "server",
    where: "https://seshi.test",
    getSession: async (_agent, id) => (id === SID ? metadata() : null),
    getTrace: async (_agent, _id, hash) =>
      traces[hash]
        ? ({ content_hash: hash, records: traces[hash] } as unknown as StoredTrace)
        : null,
    reviews: async () => [],
    changes: async () => [change("published", T1), change("published", T2)],
    search: async (q) => ({
      query: q,
      total: 1,
      results: [{ agent: "claude-code", session_id: SID } as never],
      index: { ready_at: NOW.toISOString(), caught_up_at: NOW.toISOString(), sessions: 1 },
    }),
    ...over,
  };
}

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    now: () => NOW,
    state: () => state(),
    judge: () => ({ capture: true, level: "global", reason: "capture is on" }),
    agent: (name) =>
      name === "claude-code"
        ? {
            name,
            format: "claude-code",
            encoding: "jsonl",
            chunkable: true,
            identify: () => SID,
          }
        : undefined,
    files: {
      stat: (path) => (path === PATH ? { size: SIZE, mtimeMs: NOW.getTime() } : null),
      read: (_path, end) => Buffer.from(TEXT).subarray(0, end).toString("utf8"),
    },
    spool: () => [],
    log: () => [],
    uploaderRunning: () => false,
    server: fakeServer(),
    normalizer: {
      records: (_format, text) => toRecords(text),
      version: () => "2",
      stale: (_format, built) => built !== "2",
    },
    redaction: {
      rule_set: "rs1",
      origin: "the fake rules",
      transcript: (text) => text,
      records: (records) => [...records],
      residue: (records) =>
        records.flatMap((r, index) =>
          JSON.stringify(r).includes("TOPSECRET") ? [{ index, rules: ["fake-secret"] }] : [],
        ),
    },
    ...over,
  };
}

const expectStatus = (check: CheckResult | undefined, status: string) =>
  expect(check?.status, `${check?.id}: ${check?.summary}`).toBe(status);

describe("the checks on a captured session", () => {
  it("all pass", () => {
    const checks = runChecks(evidence(), deps());
    expect(checks.filter((c) => c.status !== "ok")).toEqual([]);
    expect(checks.map((c) => c.id)).toEqual([
      "decision",
      "transcript",
      "queue",
      "presence",
      "secret",
      "offsets",
      "records",
      "prefix",
      "chain",
      "residue",
      "staleness",
      "changes",
    ]);
    expect(worst(checks.map((c) => c.status))).toBe("ok");
  });
});

describe("decision", () => {
  it("is information: ok whatever it says", () => {
    expectStatus(decisionCheck(evidence()), "ok");
    const off = decisionCheck(
      evidence((ev) => {
        ev.decision = { capture: false, level: "pause", reason: "stopped by a pause", frozen: 10 };
      }),
    );
    expectStatus(off, "ok");
    expect(off.summary).toContain("stopped at 10 bytes");
  });

  it("fails when the state file cannot be read", () => {
    const check = decisionCheck(
      evidence((ev) => {
        ev.machine.state_error = { code: "StateUnreadable", message: "bad json" };
        delete ev.decision;
      }),
    );
    expectStatus(check, "fail");
  });
});

describe("transcript", () => {
  it("passes a readable file within its offsets", () => {
    expectStatus(transcriptCheck(evidence()), "ok");
  });

  it("warns when the file shrank or moved", () => {
    expectStatus(
      transcriptCheck(
        evidence((ev) => {
          ev.transcript.size = 5;
        }),
      ),
      "warn",
    );
    expectStatus(
      transcriptCheck(
        evidence((ev) => {
          (ev.local as SessionState).sent_path = "/elsewhere.jsonl";
        }),
      ),
      "warn",
    );
  });

  it("fails a file that is another session's, or gone before anything was stored", () => {
    expectStatus(
      transcriptCheck(
        evidence((ev) => {
          ev.transcript.identified_as = "other";
        }),
      ),
      "fail",
    );
    expectStatus(
      transcriptCheck(
        evidence((ev) => {
          ev.transcript = { path: PATH, exists: false };
          (ev.local as SessionState).stored = false;
        }),
      ),
      "fail",
    );
  });
});

describe("queue", () => {
  it("passes when nothing waits, and when bytes wait on a running uploader", () => {
    expectStatus(queueCheck(evidence()), "ok");
    const pending = queueCheck(
      evidence((ev) => {
        ev.transcript.size = SIZE + 10;
        ev.machine.uploader = { running: true };
      }),
    );
    expectStatus(pending, "ok");
    expect(pending.summary).toBe("10 bytes not uploaded yet");
    // Turned on again after a retraction: its bytes count again.
    const again = queueCheck(
      evidence((ev) => {
        Object.assign(ev.local as SessionState, { retract: "done", toggle: "on", generation: 1 });
        ev.transcript.size = SIZE + 10;
        ev.machine.uploader = { running: true };
      }),
    );
    expect(again.summary).toBe("10 bytes not uploaded yet");
  });

  it("warns on a retry in backoff, a pending retraction or stuck spool entries", () => {
    expectStatus(
      queueCheck(
        evidence((ev) => {
          (ev.local as SessionState).error = {
            code: "unavailable",
            message: "502",
            permanent: false,
            at: NOW.toISOString(),
          };
          (ev.local as SessionState).next_attempt_at = NOW.toISOString();
        }),
      ),
      "warn",
    );
    expectStatus(
      queueCheck(
        evidence((ev) => {
          (ev.local as SessionState).retract = "pending";
        }),
      ),
      "warn",
    );
    const stuck = queueCheck(
      evidence((ev) => {
        ev.spool.entries = [{ name: "1.json", kind: "capture", at: "2026-11-15T11:00:00.000Z" }];
      }),
    );
    expectStatus(stuck, "warn");
    expect(stuck.summary).toContain("1 hook entry waits for the uploader, and none runs");
  });

  it("fails a permanent refusal and a refused retraction", () => {
    expectStatus(
      queueCheck(
        evidence((ev) => {
          (ev.local as SessionState).error = {
            code: "forbidden",
            message: "no",
            permanent: true,
            at: NOW.toISOString(),
            size: SIZE,
          };
        }),
      ),
      "fail",
    );
    expectStatus(
      queueCheck(
        evidence((ev) => {
          (ev.local as SessionState).retract = "failed";
          (ev.local as SessionState).retract_error = "bad_retract_secret";
        }),
      ),
      "fail",
    );
  });

  it("names a waiting rebuild", () => {
    const check = queueCheck(
      evidence((ev) => {
        (ev.local as SessionState).rebuild = {
          at: NOW.toISOString(),
          key: "k",
          for: "3",
          not_before: "2026-11-16T00:00:00.000Z",
        };
      }),
    );
    expectStatus(check, "ok");
    expect(check.summary).toContain("waits until 2026-11-16");
  });
});

describe("server presence", () => {
  it("passes a stored session", () => {
    expectStatus(presenceCheck(evidence()), "ok");
  });

  it("fails a session the server lost", () => {
    const check = presenceCheck(
      evidence((ev) => {
        ev.server.metadata = null;
      }),
    );
    expectStatus(check, "fail");
    expect(check.summary).toContain("holds nothing");
  });

  it("passes a retracted session and fails one the server still holds", () => {
    const retracted = (held: SessionMetadata | null) =>
      evidence((ev) => {
        Object.assign(ev.local as SessionState, {
          toggle: "off",
          retract: "done",
          generation: 1,
          sent: undefined,
          stored: undefined,
        });
        ev.decision = { capture: false, level: "session", reason: "turned off for this session" };
        ev.server.upload_id = `${SID}~1`;
        ev.server.metadata = null;
        ev.server.retracted = { upload_id: SID, metadata: held };
      });
    expectStatus(presenceCheck(retracted(metadata({ status: "redacted", head: undefined }))), "ok");
    expectStatus(presenceCheck(retracted(null)), "ok");
    expectStatus(presenceCheck(retracted(metadata())), "fail");
  });

  it("passes a stub (seen in local mode, inferred from a server) and fails a missing one", () => {
    const dropped = (f: (ev: SessionEvidence) => void) =>
      evidence((ev) => {
        (ev.local as SessionState).last_status = "dropped";
        ev.server.metadata = null;
        f(ev);
      });
    expectStatus(presenceCheck(dropped(() => {})), "ok");
    expectStatus(
      presenceCheck(
        dropped((ev) => {
          ev.server.sees_stubs = true;
          ev.server.pointer = metadata({ head: undefined, traces: [] });
        }),
      ),
      "ok",
    );
    expectStatus(
      presenceCheck(
        dropped((ev) => {
          ev.server.sees_stubs = true;
          ev.server.pointer = null;
        }),
      ),
      "fail",
    );
  });

  it("passes a stub whose later whole send (a resend) answered unchanged", () => {
    // Found by the scenario explorer (33): `seshi capture resend` of a stub sends it whole, the
    // server adds nothing past the dropped start and answers `unchanged`; the doctor read only
    // `dropped` as a stub and failed "the server holds nothing of it".
    const unchanged = (f: (ev: SessionEvidence) => void) =>
      evidence((ev) => {
        (ev.local as SessionState).last_status = "unchanged";
        ev.server.metadata = null;
        f(ev);
      });
    const served = presenceCheck(unchanged(() => {}));
    expectStatus(served, "ok");
    expect(served.detail?.[0]).toContain("unchanged");
    const local = presenceCheck(
      unchanged((ev) => {
        ev.server.sees_stubs = true;
        ev.server.pointer = metadata({ head: undefined, traces: [] });
      }),
    );
    expectStatus(local, "ok");
    expect(local.summary).toContain("a later whole send added nothing");
    // Seen in local mode with no stub there: still lost.
    expectStatus(
      presenceCheck(
        unchanged((ev) => {
          ev.server.sees_stubs = true;
          ev.server.pointer = null;
        }),
      ),
      "fail",
    );
  });

  it("passes a filtered session with nothing stored, and fails one deleted on the server", () => {
    expectStatus(
      presenceCheck(
        evidence((ev) => {
          Object.assign(ev.local as SessionState, { stored: false, last_status: "filtered" });
          ev.server.metadata = null;
        }),
      ),
      "ok",
    );
    expectStatus(
      presenceCheck(
        evidence((ev) => {
          ev.server.metadata = metadata({ status: "redacted", head: undefined });
        }),
      ),
      "fail",
    );
  });

  it("warns, not fails, on a filtered session the server holds once it grew and an answer was lost", () => {
    // Found by the scenario explorer (33): filtered at one turn, sent again when it grew, that
    // answer lost, then stopped by a pause; the last answer heard is still "filtered".
    const filtered = (held: number) =>
      evidence((ev) => {
        Object.assign(ev.local as SessionState, {
          stored: false,
          last_status: "filtered",
          held_at_size: held,
        });
      });
    expectStatus(presenceCheck(filtered(SIZE - 5)), "warn");
    // Not grown since the filter judged it: the server should hold nothing.
    expectStatus(presenceCheck(filtered(SIZE)), "fail");
  });

  it("skips when the server cannot be asked", () => {
    expectStatus(
      presenceCheck(
        evidence((ev) => {
          ev.server.error = { code: "not_signed_in", message: "not signed in" };
        }),
      ),
      "skip",
    );
  });
});

describe("retraction secret", () => {
  it("passes the secret the session was stored with", () => {
    expectStatus(secretCheck(evidence()), "ok");
  });

  it("fails another secret, and warns when nothing can retract it", () => {
    expectStatus(
      secretCheck(
        evidence((ev) => {
          (ev.local as NonNullable<SessionEvidence["local"]>).secret = {
            present: true,
            sha256: "d".repeat(64),
          };
        }),
      ),
      "fail",
    );
    expectStatus(
      secretCheck(
        evidence((ev) => {
          ev.server.metadata = metadata({ retract_hash: undefined });
        }),
      ),
      "warn",
    );
  });
});

describe("offsets", () => {
  it("passes offsets that agree", () => {
    expectStatus(offsetsCheck(evidence()), "ok");
  });

  it("fails a server offset this machine does not know, or a send past a pause", () => {
    expectStatus(
      offsetsCheck(
        evidence((ev) => {
          ev.server.metadata = metadata({
            normalized: { bytes: SIZE - 4, records: 4, prefix_sha256: PREFIX, hash_state: "x" },
          });
        }),
      ),
      "fail",
    );
    expectStatus(
      offsetsCheck(
        evidence((ev) => {
          (ev.local as SessionState).frozen = { at: NOW.toISOString(), offset: 5 };
        }),
      ),
      "fail",
    );
  });
});

describe("offsets after a pause", () => {
  it("warn, not fail, when the server holds a piece sent before the pause whose answer was lost", () => {
    // Found by the scenario explorer (33): a chunk landed, its answer was lost, and a pause
    // stopped the session at what this machine had heard of; nothing more is ever sent.
    const half = Buffer.byteLength("meta\nfirst\n");
    const paused = (frozen: boolean) =>
      evidence((ev) => {
        Object.assign(ev.local as SessionState, {
          file_offset: half,
          server_offset: half,
          shipped: { records: 2, prefix_sha256: prefixSha256(RECORDS, 2) },
          ...(frozen ? { frozen: { at: NOW.toISOString(), offset: half } } : {}),
        });
      });
    const check = offsetsCheck(paused(true));
    expectStatus(check, "warn");
    expect(check.summary).toContain("before a pause stopped it");
    // Not paused, the same offsets are a fault: the next upload would be told the offset.
    expectStatus(offsetsCheck(paused(false)), "fail");
  });
});

describe("records and the prefix hash", () => {
  it("pass a transcript that normalizes to what the server holds", () => {
    expectStatus(recordsCheck(evidence(), deps()), "ok");
    expectStatus(prefixCheck(evidence(), deps()), "ok");
  });

  it("fail a different record count or prefix", () => {
    const fewer = evidence((ev) => {
      ev.server.metadata = metadata({
        normalized: { bytes: SIZE, records: 5, prefix_sha256: PREFIX, hash_state: "x" },
      });
    });
    expectStatus(recordsCheck(fewer, deps()), "fail");
    const other = evidence((ev) => {
      ev.server.metadata = metadata({
        normalized: { bytes: SIZE, records: 4, prefix_sha256: "e".repeat(64), hash_state: "x" },
      });
    });
    expectStatus(prefixCheck(other, deps()), "fail");
  });

  it("warn rather than fail when an older normalizer built the session", () => {
    const stale = evidence((ev) => {
      ev.server.metadata = metadata({
        normalizer: { name: "seshi", version: "0", format_version: "1" },
        normalized: { bytes: SIZE, records: 5, prefix_sha256: PREFIX, hash_state: "x" },
      });
    });
    expectStatus(recordsCheck(stale, deps()), "warn");
  });

  it("skip the prefix under another rule set, saying why", () => {
    const check = prefixCheck(
      evidence(),
      deps({ redaction: { ...deps().redaction, rule_set: "rs2" } }),
    );
    expectStatus(check, "skip");
    expect(check.summary).toContain("rule set");
  });

  it("skip a prefix a redaction backfill left behind, until a whole write computes it again", () => {
    // The backfill rewrote the traces under this machine's rules and left `normalized` as the
    // earlier rules made it (F2.5): the hashes cannot agree, and nothing is wrong.
    const backfill = {
      ...change("published", T1),
      entry: { ...change("published", T1).entry, replace: true, reason: "redacted" },
    } as ReturnType<typeof change>;
    const chunk = {
      ...change("published", T2),
      entry: {
        ...change("published", T2).entry,
        continuation: { from_record: 3, prefix_sha256: prefixSha256(RECORDS, 3) },
      },
    } as ReturnType<typeof change>;
    const after = (changes: ReturnType<typeof change>[]) =>
      evidence((ev) => {
        ev.server.metadata = metadata({
          normalized: { bytes: SIZE, records: 4, prefix_sha256: "e".repeat(64), hash_state: "x" },
        });
        ev.server.changes = changes;
      });
    const skipped = prefixCheck(after([change("published", T1), backfill]), deps());
    expectStatus(skipped, "skip");
    expect(skipped.summary).toContain("redaction backfill");
    // A chunk after the backfill continues the old hash: still not comparable.
    expectStatus(prefixCheck(after([change("published", T1), backfill, chunk]), deps()), "skip");
    // A whole write after it (a replace) computed the prefix afresh: a mismatch fails again.
    expectStatus(prefixCheck(after([backfill, change("published", T1)]), deps()), "fail");
  });

  it("warn, not fail, while a replace review dropped waits for the transcript to grow", () => {
    // Compacted shorter (3 records), replaced, and review dropped the replace: the server kept
    // its 4 records and answered with them (uploader.ts, `replace_next`).
    const shorter = Buffer.byteLength("meta\nfirst\nsecond\n");
    const dropped = (replace_next: boolean) =>
      evidence((ev) => {
        ev.local = {
          ...(ev.local as SessionState),
          file_offset: shorter,
          server_offset: SIZE,
          last_status: "dropped",
          ...(replace_next ? { replace_next } : {}),
        } as SessionEvidence["local"];
        ev.transcript.size = shorter;
      });
    for (const check of [offsetsCheck(dropped(true)), recordsCheck(dropped(true), deps())]) {
      expectStatus(check, "warn");
      expect(check.summary).toContain("review dropped the last replace");
    }
    // The same offsets and counts without the dropped replace still fail.
    expectStatus(offsetsCheck(dropped(false)), "fail");
    expectStatus(recordsCheck(dropped(false), deps()), "fail");
    // Same count, other records (a rewrite the length of the original): the prefix warns too.
    const rewritten = evidence((ev) => {
      ev.local = { ...(ev.local as SessionState), replace_next: true } as SessionEvidence["local"];
      ev.server.metadata = metadata({
        normalized: { bytes: SIZE, records: 4, prefix_sha256: "e".repeat(64), hash_state: "x" },
      });
    });
    expectStatus(prefixCheck(rewritten, deps()), "warn");
  });

  it("skip the prefix when the stored records keep markers of a rule this machine no longer has", () => {
    // Found by the scenario explorer (33): a rule was removed (or renamed); the backfill found
    // nothing more to redact and recorded the new rule set without rewriting, so the stored
    // records keep the old rule's markers, which this machine's rules cannot reproduce.
    const marked = (marker: string) =>
      evidence((ev) => {
        ev.server.metadata = metadata({
          normalized: { bytes: SIZE, records: 4, prefix_sha256: "e".repeat(64), hash_state: "x" },
        });
        const trace = ev.server.traces[0] as NonNullable<typeof ev.server.traces>[number];
        trace.records = [
          RECORDS[0] as NormalizedRecord,
          { role: "user", content: marker } as NormalizedRecord,
          ...RECORDS.slice(2, 3),
        ];
      });
    const check = prefixCheck(marked("[redacted:old-rule]"), deps());
    expectStatus(check, "skip");
    expect(check.summary).toContain("[redacted:old-rule]");
    // No foreign marker: a mismatch is still a fault.
    expectStatus(prefixCheck(marked("first"), deps()), "fail");
  });

  it("skip records and prefix when no answer ever came for what was sent", () => {
    // Found by the scenario explorer (33): the first upload was stored but its answer lost, and
    // a pause stopped the session; pre-redaction had shortened a secret, so mapping the
    // server's length onto the transcript counted the wrong records.
    const unanswered = evidence((ev) => {
      const local = ev.local as SessionState;
      for (const field of [
        "stored",
        "server_offset",
        "file_offset",
        "aligned",
        "shipped",
      ] as const) {
        delete local[field];
      }
      local.last_status = undefined as never;
      ev.server.metadata = metadata({
        normalized: { bytes: SIZE - 3, records: 4, prefix_sha256: PREFIX, hash_state: "x" },
      });
    });
    const records = recordsCheck(unanswered, deps());
    expectStatus(records, "skip");
    expect(records.summary).toContain("no answer came");
    expectStatus(prefixCheck(unanswered, deps()), "skip");
  });

  it("skip the prefix when a stub's dropped start no longer hashes as it did", () => {
    // Found by the scenario explorer (33): review dropped the first envelope, a rule added later
    // changes what was in it, and that part is not stored for a backfill to redo: the prefix
    // keeps the earlier rules' hash of it.
    const stub = (dropped: string) =>
      evidence((ev) => {
        ev.server.metadata = metadata({
          normalized: { bytes: SIZE, records: 4, prefix_sha256: "e".repeat(64), hash_state: "x" },
          dropped_prefix: { bytes: 5, records: 1, prefix_sha256: dropped },
        });
      });
    const check = prefixCheck(stub("f".repeat(64)), deps());
    expectStatus(check, "skip");
    expect(check.summary).toContain("review dropped the first 1 record");
    // The dropped start still hashes as recorded: the mismatch is elsewhere, a fault.
    expectStatus(prefixCheck(stub(prefixSha256(RECORDS, 1)), deps()), "fail");
  });

  it("skip records when the server holds a piece this machine heard no answer for", () => {
    const ahead = evidence((ev) => {
      Object.assign(ev.local as SessionState, {
        file_offset: SIZE - 8,
        server_offset: SIZE - 8,
        shipped: undefined,
      });
    });
    const check = recordsCheck(ahead, deps());
    expectStatus(check, "skip");
    expect(check.summary).toContain("past what this machine heard of");
  });

  it("count the records review dropped on both sides", () => {
    const check = recordsCheck(
      evidence((ev) => {
        ev.server.metadata = metadata({
          dropped_prefix: { bytes: 5, records: 1, prefix_sha256: "f".repeat(64) },
        });
      }),
      deps(),
    );
    expectStatus(check, "ok");
    expect(check.detail?.[0]).toContain("review dropped the first 1 record");
  });
});

describe("trace chain", () => {
  it("passes traces that chain to the metadata's count", () => {
    expectStatus(chainCheck(evidence()), "ok");
  });

  it("fails a trace that cannot be fetched, an overlap, or a head that is not last", () => {
    expectStatus(
      chainCheck(
        evidence((ev) => {
          const t = ev.server.traces[1] as SessionEvidence["server"]["traces"][number];
          ev.server.traces[1] = {
            ...t,
            fetched: false,
            error: { code: "not_found", message: "gone" },
          };
        }),
      ),
      "fail",
    );
    expectStatus(
      chainCheck(
        evidence((ev) => {
          const t = ev.server.traces[1] as SessionEvidence["server"]["traces"][number];
          ev.server.traces[1] = { ...t, continuation: { from_record: 2, prefix_sha256: "x" } };
        }),
      ),
      "fail",
    );
    expectStatus(
      chainCheck(
        evidence((ev) => {
          ev.server.metadata = metadata({ head: T1 });
        }),
      ),
      "fail",
    );
  });

  it("warns about records in no trace, and passes a stub", () => {
    expectStatus(
      chainCheck(
        evidence((ev) => {
          ev.server.metadata = metadata({
            normalized: { bytes: SIZE, records: 6, prefix_sha256: PREFIX, hash_state: "x" },
          });
        }),
      ),
      "warn",
    );
    expectStatus(
      chainCheck(
        evidence((ev) => {
          ev.server.metadata = null;
          ev.server.pointer = metadata({ head: undefined, traces: [] });
          ev.server.traces = [];
        }),
      ),
      "ok",
    );
  });
});

describe("redaction residue", () => {
  it("passes records no rule matches", () => {
    expectStatus(residueCheck(evidence(), deps()), "ok");
  });

  it("fails a stored secret, naming the rule and record, never the text", () => {
    const check = residueCheck(
      evidence((ev) => {
        const t = ev.server.traces[0] as SessionEvidence["server"]["traces"][number];
        t.records = [
          ...TRACE1.slice(0, 2),
          { role: "user", content: "TOPSECRET" } as NormalizedRecord,
        ];
      }),
      deps(),
    );
    expectStatus(check, "fail");
    expect(check.summary).toContain("record 2: fake-secret");
    expect(JSON.stringify(check)).not.toContain("TOPSECRET");
  });
});

describe("staleness", () => {
  it("passes a session built by the current adapter", () => {
    expectStatus(stalenessCheck(evidence(), deps()), "ok");
  });

  it("warns on an older one, with whether a rebuild waits", () => {
    const check = stalenessCheck(
      evidence((ev) => {
        ev.server.metadata = metadata({
          normalizer: { name: "s", version: "0", format_version: "1" },
        });
        (ev.local as SessionState).rebuild = {
          at: NOW.toISOString(),
          key: "k",
          not_before: "2026-11-16T00:00:00.000Z",
        };
      }),
      deps(),
    );
    expectStatus(check, "warn");
    expect(check.summary).toContain("a rebuild waits until");
  });
});

describe("change feed", () => {
  it("passes when the head's publish is in the feed", () => {
    expectStatus(changesCheck(evidence()), "ok");
  });

  it("fails when it is not, or a deleted session has no tombstone", () => {
    expectStatus(
      changesCheck(
        evidence((ev) => {
          ev.server.changes = [change("published", T1)];
        }),
      ),
      "fail",
    );
    expectStatus(
      changesCheck(
        evidence((ev) => {
          ev.server.metadata = metadata({ status: "redacted", head: undefined, traces: [] });
          ev.server.traces = [];
        }),
      ),
      "fail",
    );
  });
});

describe("search", () => {
  it("is left out without --deep", () => {
    expect(searchCheck(evidence())).toBeUndefined();
  });

  it("passes a session found and a deleted one not found", () => {
    expectStatus(
      searchCheck(
        evidence((ev) => {
          ev.server.search = {
            upload_id: SID,
            expect: "found",
            term: "second",
            term_from: "stored trace",
            found: true,
          };
        }),
      ),
      "ok",
    );
    expectStatus(
      searchCheck(
        evidence((ev) => {
          ev.server.search = {
            upload_id: SID,
            expect: "absent",
            term: "second",
            term_from: "transcript",
            found: false,
          };
        }),
      ),
      "ok",
    );
  });

  it("fails a session not found by a caught-up index, and a deleted one still found", () => {
    expectStatus(
      searchCheck(
        evidence((ev) => {
          ev.server.search = {
            upload_id: SID,
            expect: "found",
            term: "second",
            term_from: "stored trace",
            found: false,
            index_caught_up_at: "2026-11-15T13:00:00.000Z",
          };
        }),
      ),
      "fail",
    );
    expectStatus(
      searchCheck(
        evidence((ev) => {
          ev.server.search = {
            upload_id: SID,
            expect: "absent",
            term: "second",
            term_from: "transcript",
            found: true,
          };
        }),
      ),
      "fail",
    );
  });
});

describe("gatherEvidence", () => {
  it("gathers the three views from the loaders, the secret only as its hash", async () => {
    const ev = await gatherEvidence(
      { agent: "claude-code", session_id: SID },
      deps({
        log: () => [
          `2026 uploader: ${KEY}: will retry: 502`,
          "2026 uploader: claude-code:other: x",
        ],
        spool: () => [
          {
            name: "1.json",
            entry: {
              v: 1,
              kind: "capture",
              at: NOW.toISOString(),
              agent: "claude-code",
              event: "Stop",
              session_id: SID,
            },
          },
          {
            name: "2.json",
            entry: {
              v: 1,
              kind: "capture",
              at: NOW.toISOString(),
              agent: "claude-code",
              event: "Stop",
              session_id: "x",
            },
          },
        ],
      }),
      { deep: true },
    );
    expect(ev.local?.secret).toEqual({ present: true, sha256: HASH });
    expect(JSON.stringify(ev)).not.toContain(SECRET);
    expect(ev.transcript).toMatchObject({
      path: PATH,
      exists: true,
      size: SIZE,
      identified_as: SID,
    });
    expect(ev.log.lines).toHaveLength(1);
    expect(ev.spool.entries).toEqual([
      { name: "1.json", kind: "capture", at: NOW.toISOString(), event: "Stop" },
    ]);
    expect(ev.server.traces.map((t) => [t.content_hash, t.fetched, t.record_count])).toEqual([
      [T1, true, 3],
      [T2, true, 2],
    ]);
    expect(ev.server.changes).toHaveLength(2);
    expect(ev.server.search).toMatchObject({ expect: "found", term: "thirdly", found: true });
    expect(runChecks(ev, deps()).filter((c) => c.status !== "ok")).toEqual([]);
  });

  it("records what it could not fetch instead of throwing", async () => {
    const ev = await gatherEvidence(
      { agent: "claude-code", session_id: SID },
      deps({
        state: () => {
          throw new Error("state.json cannot be read");
        },
        server: fakeServer({
          getSession: async () => {
            throw new Error("boom");
          },
        }),
      }),
    );
    expect(ev.machine.state_error?.message).toContain("cannot be read");
    expect(ev.server.metadata_error?.message).toBe("boom");
    const checks = runChecks(ev, deps());
    expect(checks.find((c) => c.id === "presence")?.status).toBe("skip");
  });

  it("says why there is no server, and asks for the upload id before a retraction", async () => {
    const none = await gatherEvidence(
      { agent: "claude-code", session_id: SID },
      deps({ server: undefined, serverError: { code: "not_signed_in", message: "not signed in" } }),
    );
    expect(none.server).toMatchObject({ mode: "none", error: { code: "not_signed_in" } });

    const asked: string[] = [];
    const ev = await gatherEvidence(
      { agent: "claude-code", session_id: SID },
      deps({
        state: () => state({ [KEY]: entry({ generation: 2, toggle: "off", retract: "done" }) }),
        server: fakeServer({
          getSession: async (_a, id) => {
            asked.push(id);
            return null;
          },
        }),
      }),
    );
    expect(asked).toEqual([`${SID}~2`, `${SID}~1`]);
    expect(ev.server.retracted).toEqual({ upload_id: `${SID}~1`, metadata: null });
  });
});

describe("helpers", () => {
  it("names the upload id before the last retraction", () => {
    expect(retractedUploadId({ session_id: "s", generation: 0 })).toBeUndefined();
    expect(retractedUploadId({ session_id: "s", generation: 1 })).toBe("s");
    expect(retractedUploadId({ session_id: "s", generation: 3 })).toBe("s~2");
  });

  it("picks a distinctive word outside redaction markers", () => {
    expect(
      distinctiveTerm([
        { role: "user", content: "the tokenizer" } as NormalizedRecord,
        { role: "assistant", content: "[redacted:github-token] done reading" } as NormalizedRecord,
      ]),
    ).toBe("reading");
  });
});
