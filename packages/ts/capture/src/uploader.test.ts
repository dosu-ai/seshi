import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerError } from "@seshi/client";
import type { CaptureAgent, CaptureHost } from "@seshi/kit";
import {
  Forbidden,
  OffsetMismatch,
  SessionConflict,
  SessionRejected,
  StoreError,
  type StoreSessionResult,
  type Upload,
} from "@seshi/model";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CapturePaths, capturePaths } from "./paths";
import { DEFAULT_RULES } from "./rules";
import type { RulesSnapshot } from "./rules-cache";
import { RetractRefused, type SessionSink, SignInNeeded } from "./sink";
import { appendSpool } from "./spool";
import { readState, type SessionState, updateState } from "./state";
import { type PreRedactor, retractHash, Uploader, type UploaderOptions } from "./uploader";

/** A server in memory that keeps the upload protocol (X6.3, X4.6): a session's whole log until
 * it holds one with `minLines` lines, then chunks at its offset; a whole log that does not
 * extend is a conflict unless it replaces; a retraction needs the secret. */
class FakeServer implements SessionSink {
  readonly target = "https://seshi.test";
  readonly uploads: Upload[] = [];
  readonly sessions = new Map<string, { text: string; hash?: string; gone?: boolean }>();
  readonly retractions: { id: string; secret: string }[] = [];
  minLines = 2;
  /** Errors the next calls throw, in order. */
  failNext: unknown[] = [];
  allowRetract = true;
  signedIn = true;

  async ready() {
    if (!this.signedIn) throw new SignInNeeded("not signed in");
  }

  private answer(status: StoreSessionResult["status"], text: string): StoreSessionResult {
    const lines = text.split("\n").filter(Boolean).length;
    const shipped = {
      records_total: lines,
      prefix_sha256: createHash("sha256").update(text).digest("hex"),
      bytes_total: Buffer.byteLength(text),
    };
    if (status === "filtered" || status === "dropped" || status === "unchanged") {
      return { status, ...shipped };
    }
    return {
      status,
      archive_id: "a",
      content_hash: "h",
      session_id: "s",
      records: lines,
      events: lines,
      ...shipped,
    };
  }

  async ingest(upload: Upload): Promise<StoreSessionResult> {
    this.uploads.push(upload);
    if (!this.signedIn) throw new SignInNeeded("not signed in");
    const next = this.failNext.shift();
    if (next) throw next;
    const session = this.sessions.get(upload.session_id);
    if (session?.gone) throw new SessionRejected("redacted", "session was redacted");
    const offset = upload.offset ?? 0;
    if (offset > 0) {
      if (!session) throw new OffsetMismatch(offset, 0);
      const end = Buffer.byteLength(session.text);
      if (offset !== end) throw new OffsetMismatch(offset, end);
      session.text += upload.transcript;
      return this.answer("stored", session.text);
    }
    if (session) {
      if (upload.transcript.startsWith(session.text)) {
        const grew = upload.transcript.length > session.text.length;
        session.text = upload.transcript;
        return this.answer(grew ? "stored" : "unchanged", session.text);
      }
      if (!upload.replace) throw new SessionConflict("does not extend");
      session.text = upload.transcript;
      return this.answer("stored", session.text);
    }
    if (upload.transcript.split("\n").filter(Boolean).length < this.minLines) {
      return { status: "filtered", records_total: 0, prefix_sha256: "e", bytes_total: 0 };
    }
    this.sessions.set(upload.session_id, {
      text: upload.transcript,
      ...(upload.retract_hash ? { hash: upload.retract_hash } : {}),
    });
    return this.answer("stored", upload.transcript);
  }

  async retract(_agent: string, id: string, secret: string): Promise<"retracted" | "absent"> {
    this.retractions.push({ id, secret });
    const next = this.failNext.shift();
    if (next) throw next;
    if (!this.allowRetract) throw new RetractRefused("retract_disabled", "off");
    const session = this.sessions.get(id);
    if (!session || session.gone) return "absent";
    if (session.hash !== retractHash(secret)) throw new RetractRefused("bad_retract_secret", "no");
    session.gone = true;
    return "retracted";
  }
}

let dir: string;
let host: CaptureHost;
let paths: CapturePaths;
let server: FakeServer;
let clock: Date;

const agent: CaptureAgent = {
  name: "fake",
  format: "claude-code",
  encoding: "jsonl",
  chunkable: true,
  hooks: [],
  sweep: [
    {
      root: "~/sessions",
      depths: [1],
      match: (rel) => rel.endsWith(".jsonl"),
    },
  ],
  identify: (_path, head) => {
    const first = head.split("\n")[0];
    if (!first) return null;
    const row = JSON.parse(first) as { id: string; cwd?: string; at?: string };
    return {
      session_id: row.id,
      ...(row.cwd ? { cwd: row.cwd } : {}),
      ...(row.at ? { started_at: row.at } : {}),
    };
  },
  accountIds: () => ({ anthropic: "acct-1" }),
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "seshi-uploader-")));
  host = { env: {}, home: dir, platform: "linux" };
  paths = capturePaths(host);
  server = new FakeServer();
  clock = new Date("2026-11-01T00:00:00Z");
  mkdirSync(join(dir, "sessions"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const line = (text: string) => `${JSON.stringify({ id: "s1", cwd: dir, text })}\n`;
const transcript = (name = "s1") => join(dir, "sessions", `${name}.jsonl`);

function uploader(options: Partial<UploaderOptions> = {}): Uploader {
  const rules: RulesSnapshot = { rules: DEFAULT_RULES };
  return new Uploader({
    paths,
    host,
    agents: [agent],
    sink: async () => server,
    rules: async () => rules,
    now: () => clock,
    log: () => {},
    git: async () => ({ email: "me@acme.com" }),
    retryBaseMs: 1000,
    ...options,
  });
}

/** What a hook would have spooled for session `id`. */
function hooked(id = "s1", path = transcript(id)): void {
  appendSpool(paths, {
    v: 1,
    kind: "capture",
    at: clock.toISOString(),
    agent: "fake",
    event: "Stop",
    session_id: id,
    transcript_path: path,
    cwd: dir,
  });
}

const session = (id = "s1"): SessionState =>
  readState(paths).sessions[`fake:${id}`] as SessionState;

describe("the upload protocol", () => {
  it("sends the whole log first, then only new complete lines at the server's offset", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    const first = await uploader().pass();
    expect(first).toMatchObject({ taken: 1, uploaded: 1, queued: 0 });
    expect(server.uploads[0]).toMatchObject({
      agent: "claude-code",
      session_id: "s1",
      offset: 0,
      format: "jsonl",
      project: dir.split("/").at(-1),
      claims: { git_email: "me@acme.com", account_ids: { anthropic: "acct-1" } },
    });
    const secret = session().secret as string;
    expect(server.uploads[0]?.retract_hash).toBe(retractHash(secret));

    // A partial line is not sent until it is complete.
    appendFileSync(transcript(), `${line("three")}{"id":"s1","te`);
    hooked();
    await uploader().pass();
    expect(server.uploads[1]).toMatchObject({
      offset: Buffer.byteLength(line("one") + line("two")),
      transcript: line("three"),
    });
    expect(server.sessions.get("s1")?.text).toBe(line("one") + line("two") + line("three"));
    // Nothing new: nothing sent.
    await uploader().pass();
    expect(server.uploads).toHaveLength(2);
  });

  it("keeps a filtered session's whole log until it grows (X4.10)", async () => {
    server.minLines = 3;
    writeFileSync(transcript(), line("one"));
    hooked();
    await uploader().pass();
    expect(session()).toMatchObject({
      stored: false,
      last_status: "filtered",
      held_at_size: Buffer.byteLength(line("one")),
    });
    await uploader().pass();
    expect(server.uploads).toHaveLength(1);
    appendFileSync(transcript(), line("two") + line("three"));
    await uploader().pass();
    expect(server.uploads.map((u) => u.offset)).toEqual([0, 0]);
    expect(session().stored).toBe(true);
  });

  it("resends from where the server says on offset_mismatch, and the whole log when it says 0", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    await uploader().pass();
    // The server lost track (a reinstall wiped the state, say): it holds nothing now.
    server.sessions.delete("s1");
    appendFileSync(transcript(), line("three"));
    await uploader().pass();
    expect(server.uploads.map((u) => u.offset)).toEqual([
      0,
      Buffer.byteLength(line("one") + line("two")),
      0,
    ]);
    expect(server.sessions.get("s1")?.text).toBe(line("one") + line("two") + line("three"));
    // The server is ahead of this machine (another uploader sent a line): resend from there.
    const stored = server.sessions.get("s1");
    if (stored) stored.text += line("four");
    appendFileSync(transcript(), line("four") + line("five"));
    await uploader().pass();
    expect(server.sessions.get("s1")?.text.endsWith(line("four") + line("five"))).toBe(true);
    expect(session().file_offset).toBe(session().server_offset);
  });

  it("replaces on conflict only a session this machine stored", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    await uploader().pass();
    // The transcript was rewritten from the start (shorter than what was sent).
    writeFileSync(transcript(), line("uno"));
    await uploader().pass();
    expect(server.uploads.at(-1)).toMatchObject({ offset: 0, replace: true });
    expect(server.sessions.get("s1")?.text).toBe(line("uno"));

    // A session someone else stored: a conflict is a refusal, kept until the transcript changes.
    server.sessions.set("s2", { text: "other\n" });
    writeFileSync(transcript("s2"), line("one") + line("two"));
    hooked("s2");
    const pass = await uploader().pass();
    expect(pass.failed).toBe(1);
    expect(session("s2").error).toMatchObject({ code: "conflict", permanent: true });
    const before = server.uploads.length;
    await uploader().pass();
    expect(server.uploads).toHaveLength(before);
  });

  it("treats forbidden and 422 as permanent, the network and 5xx as worth retrying", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    server.failNext = [new Forbidden("verified session")];
    await uploader().pass();
    expect(session().error).toMatchObject({ code: "forbidden", permanent: true });

    writeFileSync(transcript("s3"), line("one") + line("two"));
    hooked("s3");
    server.failNext = [new SessionRejected("too_large", "big")];
    await uploader().pass();
    expect(session("s3").error).toMatchObject({ code: "too_large", permanent: true });

    writeFileSync(transcript("s4"), line("one") + line("two"));
    hooked("s4");
    server.failNext = [new ServerError(503, "unavailable", "down")];
    await uploader().pass();
    expect(session("s4")).toMatchObject({ failures: 1, error: { permanent: false } });
    expect(session("s4").next_attempt_at).toBe(new Date(clock.getTime() + 1000).toISOString());
    // Not before its time; then it goes.
    await uploader().pass();
    expect(server.sessions.has("s4")).toBe(false);
    clock = new Date(clock.getTime() + 2000);
    await uploader().pass();
    expect(server.sessions.has("s4")).toBe(true);
    expect(session("s4").error).toBeUndefined();
  });

  it("says upload failing after three failing passes in a row, and clears it on success", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    for (let i = 0; i < 3; i++) {
      server.failNext = [new StoreError("cannot reach")];
      await uploader().pass();
      clock = new Date(clock.getTime() + 10 * 60_000);
    }
    expect(readState(paths).problems?.upload?.message).toBe("cannot reach");
    await uploader().pass();
    expect(readState(paths).problems).toBeUndefined();
  });

  it("stops at a sign-in, says so, and drops it once there is a credential", async () => {
    server.signedIn = false;
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    const pass = await uploader().pass();
    expect(pass.signIn).toBe("not signed in");
    expect(readState(paths).problems?.sign_in?.message).toBe("not signed in");
    expect(pass.queued).toBe(1);
    server.signedIn = true;
    // Nothing waiting now (say the transcript is gone for this pass): ready() still clears it.
    await updateState(paths, (s) => {
      delete (s.sessions["fake:s1"] as SessionState).path;
    });
    rmSync(transcript());
    await uploader().pass();
    expect(readState(paths).problems).toBeUndefined();
  });

  it("sends a long tail in chunks of at most maxChunkBytes", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    await uploader({ maxChunkBytes: 60 }).pass();
    appendFileSync(transcript(), line("three") + line("four") + line("five"));
    await uploader({ maxChunkBytes: 60 }).pass();
    expect(server.uploads.slice(1).map((u) => u.transcript)).toEqual([
      line("three"),
      line("four"),
      line("five"),
    ]);
  });

  it("passes every piece through the pre-redaction seam (F2.4)", async () => {
    const preRedact: PreRedactor = {
      redact: ({ text, carried }) => ({
        text: text.replace(/secret/g, "[REDACTED]"),
        carried: { n: ((carried?.n as number) ?? 0) + 1 },
      }),
    };
    writeFileSync(transcript(), line("my secret") + line("two"));
    hooked();
    await uploader({ preRedact }).pass();
    expect(server.uploads[0]?.transcript).toContain("[REDACTED]");
    expect(session()).toMatchObject({ aligned: false, carried: { n: 1 } });
    appendFileSync(transcript(), line("three secret"));
    await uploader({ preRedact }).pass();
    // A redacted length no longer maps back to the file: the chunk still goes at the server's
    // offset, and carries the last piece's state.
    expect(server.uploads[1]).toMatchObject({
      offset: (session().server_offset ?? 0) - Buffer.byteLength(line("three [REDACTED]")),
    });
    expect(server.sessions.get("s1")?.text).not.toContain("secret");
    expect(session().carried).toEqual({ n: 2 });
  });
});

describe("the rules apply to the uploader too (F9.3)", () => {
  it("sends nothing of a session turned off or while paused", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    await updateState(paths, (s) => {
      s.paused = { at: clock.toISOString() };
    });
    await uploader().pass();
    expect(server.uploads).toHaveLength(0);
    await updateState(paths, (s) => {
      delete s.paused;
      (s.sessions["fake:s1"] as SessionState).toggle = "off";
    });
    await uploader().pass();
    expect(server.uploads).toHaveLength(0);
  });
});

describe("retraction (F9.7)", () => {
  async function turnOff(id = "s1") {
    await updateState(paths, (s) => {
      const session = s.sessions[`fake:${id}`] as SessionState;
      session.toggle = "off";
      if (session.sent) session.retract = "pending";
    });
  }

  it("retracts with the session's secret, then uploads it again as a new session when turned on", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    await uploader().pass();
    const secret = session().secret;
    await turnOff();
    const pass = await uploader().pass();
    expect(pass.retracted).toBe(1);
    expect(server.retractions).toEqual([{ id: "s1", secret }]);
    expect(server.sessions.get("s1")?.gone).toBe(true);
    expect(session()).toMatchObject({ retract: "done", generation: 1, last_status: "retracted" });
    expect(session().secret).toBeUndefined();

    await updateState(paths, (s) => {
      (s.sessions["fake:s1"] as SessionState).toggle = "on";
    });
    await uploader().pass();
    expect(server.uploads.at(-1)).toMatchObject({ session_id: "s1~1", offset: 0 });
    expect(session().secret).not.toBe(secret);
  });

  it("asks nothing of the server for a session never sent", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    await updateState(paths, (s) => {
      s.sessions["fake:s1"] = {
        agent: "fake",
        session_id: "s1",
        first_seen: "x",
        toggle: "off",
        retract: "pending",
      };
    });
    await uploader().pass();
    expect(server.retractions).toEqual([]);
    expect(session()).toMatchObject({ retract: "done" });
    expect(session().generation).toBeUndefined();
  });

  it("records a refused retraction, and retries one that could not reach the server", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    await uploader().pass();
    await turnOff();
    server.failNext = [new StoreError("down")];
    await uploader().pass();
    expect(session()).toMatchObject({ retract: "pending", failures: 1 });
    clock = new Date(clock.getTime() + 60_000);
    server.allowRetract = false;
    await uploader().pass();
    expect(session()).toMatchObject({ retract: "failed", retract_error: "off" });
  });
});

describe("the spool and the sweep", () => {
  it("takes in hooks, registering the agent as installed from then", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    await uploader().pass();
    expect(readState(paths).agents.fake).toEqual({ installed_at: clock.toISOString() });
  });

  it("finds sessions started since install, never before, through the same rules", async () => {
    await updateState(paths, (s) => {
      s.agents.fake = { installed_at: "2026-10-15T00:00:00Z" };
    });
    const write = (id: string, at: string, cwd = dir) => {
      const file = transcript(id);
      writeFileSync(file, `${JSON.stringify({ id, cwd, at })}\n${JSON.stringify({ id })}\n`);
      return file;
    };
    write("new", "2026-10-20T00:00:00Z");
    const old = write("old", "2026-10-01T00:00:00Z");
    const before = new Date("2026-10-01T00:00:00Z");
    utimesSync(old, before, before);
    mkdirSync(join(dir, "excluded", ".git"), { recursive: true });
    mkdirSync(join(dir, "excluded", ".seshi"));
    writeFileSync(join(dir, "excluded", ".seshi", "config.toml"), "capture = false\n");
    write("repo-off", "2026-10-20T00:00:00Z", join(dir, "excluded"));
    const pass = await uploader().pass();
    expect(pass.found).toBe(1);
    expect(Object.keys(readState(paths).sessions)).toEqual(["fake:new"]);
    expect(server.sessions.has("new")).toBe(true);
    // A backfill on purpose reaches back.
    await uploader().pass({ sweep: true, sweepSince: new Date("2026-09-01T00:00:00Z") });
    expect(server.sessions.has("old")).toBe(true);
    expect(server.sessions.has("repo-off")).toBe(false);
  });

  it("forgets a session whose transcript is gone, unless a retraction waits", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    writeFileSync(transcript("s2"), line("one") + line("two"));
    hooked();
    hooked("s2");
    await uploader().pass();
    await updateState(paths, (s) => {
      const s2 = s.sessions["fake:s2"] as SessionState;
      s2.toggle = "off";
      s2.retract = "pending";
      s2.next_attempt_at = new Date(clock.getTime() + 3600_000).toISOString();
    });
    rmSync(transcript());
    rmSync(transcript("s2"));
    await uploader().pass({ sweep: true });
    expect(Object.keys(readState(paths).sessions)).toEqual(["fake:s2"]);
  });

  it("finds a transcript the hook did not name, through the agent", async () => {
    writeFileSync(
      transcript("late"),
      `${JSON.stringify({ id: "late" })}\n${JSON.stringify({ id: "late" })}\n`,
    );
    const locating = { ...agent, locate: (id: string) => transcript(id) };
    appendSpool(paths, {
      v: 1,
      kind: "capture",
      at: clock.toISOString(),
      agent: "fake",
      event: "stop",
      session_id: "late",
      cwd: dir,
    });
    await uploader({ agents: [locating] }).pass();
    expect(server.sessions.has("late")).toBe(true);
    expect(session("late").path).toBe(transcript("late"));
  });
});

describe("running", () => {
  it("writes nothing on a pass with nothing to do", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    await uploader().pass();
    const before = readFileSync(paths.state, "utf8");
    clock = new Date(clock.getTime() + 5000);
    await uploader().pass();
    expect(readFileSync(paths.state, "utf8")).toBe(before);
  });

  it("stops after being idle, and when the signal aborts", async () => {
    let t = 0;
    const idle = uploader({
      idleMs: 30,
      pollMs: 5,
      now: () => new Date(clock.getTime() + t++ * 10),
    });
    await idle.run();
    const stop = new AbortController();
    const running = uploader({ pollMs: 5 }).run({ signal: stop.signal, keepAlive: true });
    stop.abort();
    await running;
  });
});
