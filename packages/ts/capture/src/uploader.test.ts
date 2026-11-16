import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ServerError } from "@seshi/client";
import type { CaptureAgent, CaptureHost } from "@seshi/kit";
import {
  Forbidden,
  type IngestOptions,
  OffsetMismatch,
  SessionConflict,
  SessionRejected,
  type StaleSession,
  StoreError,
  type StoreSessionResult,
  type Upload,
} from "@seshi/model";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CapturePaths, capturePaths } from "./paths";
import { DEFAULT_RULES } from "./rules";
import type { RulesSnapshot } from "./rules-cache";
import { type RetractOutcome, RetractRefused, type SessionSink, SignInNeeded } from "./sink";
import { appendSpool } from "./spool";
import {
  endPause,
  freeze,
  readState,
  type SessionState,
  updateState,
  uploadedOffset,
} from "./state";
import { sessionWord } from "./status";
import { type PreRedactor, retractHash, Uploader, type UploaderOptions } from "./uploader";
import { acquireUploaderLock, type HeldUploaderLock } from "./uploader-lock";

/** A server in memory that keeps the upload protocol (X6.3, X4.6): a session's whole log until
 * it holds one with `minLines` lines, then chunks at its offset; a whole log that does not
 * extend is a conflict unless it replaces, and a replace, like a retraction, needs the secret
 * (as the org key does, X5.12). */
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
  /** Review drops every replace. */
  dropReplace = false;
  /** Review drops a session's first envelope: the server keeps a stub of where its log ends
   * (F3.4). */
  dropFirst = false;
  /** What `GET /v1/sessions/stale` lists (X4.9), how often it was asked, and how many asks
   * fail first. */
  staleList: StaleSession[] = [];
  staleCalls = 0;
  staleFails = 0;
  /** The retraction secrets rebuilds were sent with. */
  readonly rebuildSecrets: (string | undefined)[] = [];

  async stale(): Promise<StaleSession[]> {
    this.staleCalls++;
    if (this.staleFails > 0) {
      this.staleFails--;
      throw new StoreError("down");
    }
    return this.staleList;
  }

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

  async ingest(upload: Upload, options: IngestOptions = {}): Promise<StoreSessionResult> {
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
    if (session && upload.rebuild) {
      // A rebuild replaces whatever is stored, with the permission a replace needs.
      if (
        options.retractSecret === undefined ||
        session.hash !== retractHash(options.retractSecret)
      ) {
        throw new Forbidden("only the machine that uploaded a session may rebuild it");
      }
      this.rebuildSecrets.push(options.retractSecret);
      if (this.dropReplace) return this.answer("dropped", session.text);
      session.text = upload.transcript;
      return this.answer("stored", session.text);
    }
    if (session) {
      if (upload.transcript.startsWith(session.text)) {
        const grew = upload.transcript.length > session.text.length;
        session.text = upload.transcript;
        return this.answer(grew ? "stored" : "unchanged", session.text);
      }
      if (!upload.replace) throw new SessionConflict("does not extend");
      if (
        options.retractSecret === undefined ||
        session.hash !== retractHash(options.retractSecret)
      ) {
        throw new Forbidden("only the machine that uploaded a session may replace it");
      }
      // Model review dropped the replace: the session stays as stored.
      if (this.dropReplace) return this.answer("dropped", session.text);
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
    return this.answer(this.dropFirst ? "dropped" : "stored", upload.transcript);
  }

  async retract(_agent: string, id: string, secret: string): Promise<RetractOutcome> {
    this.retractions.push({ id, secret });
    const next = this.failNext.shift();
    if (next) throw next;
    if (!this.allowRetract) throw new RetractRefused("retract_disabled", "off");
    const session = this.sessions.get(id);
    if (!session) return "absent";
    if (session.gone) return "gone";
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
    const row = JSON.parse(first) as { id: string; cwd?: string; at?: string; parent?: string };
    return {
      session_id: row.id,
      ...(row.cwd ? { cwd: row.cwd } : {}),
      ...(row.at ? { started_at: row.at } : {}),
      ...(row.parent ? { parent_session_id: row.parent } : {}),
    };
  },
  accountIds: () => ({ anthropic: "acct-1" }),
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "seshi-uploader-")));
  host = { env: {}, home: dir, platform: process.platform };
  paths = capturePaths(host);
  server = new FakeServer();
  clock = new Date("2026-11-01T00:00:00Z");
  mkdirSync(join(dir, "sessions"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const line = (text: string, id = "s1") => `${JSON.stringify({ id, cwd: dir, text })}\n`;
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
    // A stale rebuild goes at once unless a test spreads it.
    random: () => 0,
    ...options,
  });
}

/** What a hook would have spooled for session `id`. */
/** A hook's spool entry, seen at `clock`. `spooledAt` names the spool file (the real time by
 * default, as the hook does), which orders entries that share a moment. */
function hooked(id = "s1", path = transcript(id), spooledAt?: Date): void {
  appendSpool(
    paths,
    {
      v: 1,
      kind: "capture",
      at: clock.toISOString(),
      agent: "fake",
      event: "Stop",
      session_id: id,
      transcript_path: path,
      cwd: dir,
    },
    spooledAt,
  );
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
      project: basename(dir),
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

  it("sends a repo's visibility only when it narrows to owner, never org (X5.10)", async () => {
    // The session's folder is a repo whose committed .seshi/config.toml names a visibility.
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(dir, ".seshi"));
    writeFileSync(join(dir, ".seshi", "config.toml"), 'visibility = "org"\n');
    writeFileSync(transcript("s1"), line("one") + line("two"));
    hooked("s1");
    await uploader().pass();
    expect(server.uploads[0]).toMatchObject({ session_id: "s1", branch: "main" });
    expect(server.uploads[0]).not.toHaveProperty("visibility");

    writeFileSync(join(dir, ".seshi", "config.toml"), 'visibility = "owner"\n');
    writeFileSync(transcript("s2"), line("one", "s2") + line("two", "s2"));
    hooked("s2");
    await uploader().pass();
    expect(server.uploads[1]).toMatchObject({ session_id: "s2", visibility: "owner" });
  });

  it("sends only a file the agent says is that session's transcript", async () => {
    writeFileSync(join(dir, "id_rsa"), "-----BEGIN KEY-----\n");
    hooked("s1", join(dir, "id_rsa"));
    await uploader().pass();
    expect(server.uploads).toHaveLength(0);
    expect(session().error).toMatchObject({ code: "not_a_transcript", permanent: true });
    writeFileSync(transcript("s5"), line("one") + line("two"));
    hooked("s6", transcript("s5"));
    await uploader().pass();
    expect(server.uploads).toHaveLength(0);
    expect(session("s6").error?.message).toContain("session s1's transcript");
  });

  it("never chunks from another file a later hook names for a stored session", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    await uploader().pass();
    expect(session().stored).toBe(true);
    // A payload naming a longer file that is not the transcript: nothing of it past the
    // stored offset may go as a chunk.
    const secret = join(dir, "id_rsa");
    writeFileSync(secret, `-----BEGIN KEY-----\n${"k".repeat(200)}\n-----END KEY-----\n`);
    hooked("s1", secret);
    await uploader().pass();
    expect(server.uploads).toHaveLength(1);
    expect(session().error).toMatchObject({ code: "not_a_transcript", permanent: true });

    // The same session's transcript at a new place goes whole; the server says it extends.
    const moved = join(dir, "sessions", "moved", "s1.jsonl");
    mkdirSync(join(moved, ".."));
    writeFileSync(moved, line("one") + line("two") + line("three"));
    hooked("s1", moved);
    await uploader().pass();
    expect(server.uploads.map((u) => u.offset)).toEqual([0, 0]);
    expect(session()).toMatchObject({ stored: true, sent_path: moved });
    expect(server.sessions.get("s1")?.text).toBe(line("one") + line("two") + line("three"));
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

  it("moves past a first envelope review dropped, and sends only what follows it (F3.4)", async () => {
    server.dropFirst = true;
    const first = line("one") + line("two");
    writeFileSync(transcript(), first);
    hooked();
    await uploader().pass();
    expect(session()).toMatchObject({
      stored: true,
      last_status: "dropped",
      file_offset: Buffer.byteLength(first),
      server_offset: Buffer.byteLength(first),
    });
    // Nothing new: nothing sent again.
    await uploader().pass();
    expect(server.uploads).toHaveLength(1);
    appendFileSync(transcript(), line("three"));
    await uploader().pass();
    expect(server.uploads.map((u) => u.offset)).toEqual([0, Buffer.byteLength(first)]);
    expect(server.uploads[1]?.transcript).toBe(line("three"));
  });

  it("forgets the last answer when offset_mismatch moves it to the end of the transcript", async () => {
    // Found by the scenario explorer (33): a chunk landed but its answer was lost; the retry was
    // told the server's offset, which is the transcript's end, so nothing more went and no
    // answer replaced the one before: the doctor compared the server with that stale answer.
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    await uploader().pass();
    expect(session().shipped?.records).toBe(2);
    const stored = server.sessions.get("s1");
    if (stored) stored.text += line("three");
    appendFileSync(transcript(), line("three"));
    await uploader().pass();
    const size = Buffer.byteLength(line("one") + line("two") + line("three"));
    expect(session()).toMatchObject({ file_offset: size, server_offset: size });
    expect(session().shipped).toBeUndefined();
    // The next answer sets it again.
    appendFileSync(transcript(), line("four"));
    await uploader().pass();
    expect(session().shipped?.records).toBe(4);
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
    writeFileSync(transcript("s2"), line("one", "s2") + line("two", "s2"));
    hooked("s2");
    const pass = await uploader().pass();
    expect(pass.failed).toBe(1);
    expect(session("s2").error).toMatchObject({ code: "conflict", permanent: true });
    const before = server.uploads.length;
    await uploader().pass();
    expect(server.uploads).toHaveLength(before);
  });

  it("replaces on conflict a session whose first answer was lost", async () => {
    // Found by the scenario explorer (33): the first upload landed but its answer was lost, so
    // `stored` was never set; the transcript was then compacted shorter, the retry (whole) was
    // a conflict, and the session was refused for good although this machine had stored it.
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    let lose = true;
    const losing: SessionSink = {
      target: server.target,
      ready: () => server.ready(),
      stale: () => server.stale(),
      retract: (agent, id, secret) => server.retract(agent, id, secret),
      async ingest(upload, options) {
        const result = await server.ingest(upload, options);
        if (lose) {
          lose = false;
          throw new TypeError("fetch failed: the connection closed before the response");
        }
        return result;
      },
    };
    await uploader({ sink: async () => losing }).pass();
    expect(server.sessions.get("s1")?.text).toBe(line("one") + line("two"));
    expect(session()).toMatchObject({ sent: true });
    expect(session().stored).toBeUndefined();
    writeFileSync(transcript(), line("uno"));
    clock = new Date(clock.getTime() + 60_000);
    const pass = await uploader().pass();
    expect(pass.failed).toBe(0);
    expect(server.uploads.at(-1)).toMatchObject({ offset: 0, replace: true });
    expect(server.sessions.get("s1")?.text).toBe(line("uno"));
    expect(session()).toMatchObject({ stored: true });

    // Sent before, but another machine's session (another secret): still a refusal for good.
    server.sessions.set("s2", { text: "other\n", hash: "not-ours" });
    writeFileSync(transcript("s2"), line("one", "s2") + line("two", "s2"));
    hooked("s2");
    await uploader().pass();
    appendFileSync(transcript("s2"), line("three", "s2"));
    await uploader().pass();
    expect(server.uploads.at(-1)).toMatchObject({ session_id: "s2", replace: true });
    expect(session("s2").error).toMatchObject({ permanent: true });
    expect(server.sessions.get("s2")?.text).toBe("other\n");
  });

  it("replaces again after review dropped a replace, never chunking onto the kept session", async () => {
    // Review finding: a dropped replace left the server holding the old session, and the next
    // chunk of this log went at the server's offset, splicing it onto that session.
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    await uploader().pass();
    writeFileSync(transcript(), line("uno"));
    server.dropReplace = true;
    await uploader().pass();
    expect(server.uploads.at(-1)).toMatchObject({ offset: 0, replace: true });
    expect(server.sessions.get("s1")?.text).toBe(line("one") + line("two"));
    expect(session().replace_next).toBe(true);
    // Nothing more until the transcript grows.
    const sent = server.uploads.length;
    await uploader().pass();
    expect(server.uploads).toHaveLength(sent);
    server.dropReplace = false;
    appendFileSync(transcript(), line("dos"));
    await uploader().pass();
    expect(server.uploads.at(-1)).toMatchObject({ offset: 0, replace: true });
    expect(server.sessions.get("s1")?.text).toBe(line("uno") + line("dos"));
    expect(session().replace_next).toBeUndefined();
    // Then chunks as usual.
    appendFileSync(transcript(), line("tres"));
    await uploader().pass();
    expect(server.uploads.at(-1)?.offset).toBe(Buffer.byteLength(line("uno") + line("dos")));
    expect(server.sessions.get("s1")?.text).toBe(line("uno") + line("dos") + line("tres"));
  });

  it("treats forbidden and 422 as permanent, the network and 5xx as worth retrying", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    server.failNext = [new Forbidden("verified session")];
    await uploader().pass();
    expect(session().error).toMatchObject({ code: "forbidden", permanent: true });

    writeFileSync(transcript("s3"), line("one", "s3") + line("two", "s3"));
    hooked("s3");
    server.failNext = [new SessionRejected("too_large", "big")];
    await uploader().pass();
    expect(session("s3").error).toMatchObject({ code: "too_large", permanent: true });

    writeFileSync(transcript("s4"), line("one", "s4") + line("two", "s4"));
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
  it("never reads a server offset as a file offset after a length-changing piece's answer is lost (33, seed 62372)", async () => {
    // Redaction that lengthens a line: the first piece keeps its length, the second does not.
    const preRedact: PreRedactor = {
      redact: ({ text }) => ({ text: text.replace(/secret/g, "[REDACTED]") }),
    };
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    await uploader({ preRedact }).pass();
    expect(session().aligned).toBe(true);
    // The server stores the next piece, and its answer is lost on the way back.
    const ingest = server.ingest.bind(server);
    let lose = true;
    server.ingest = async (upload, options) => {
      const answer = await ingest(upload, options);
      if (lose) {
        lose = false;
        throw new Error("connection reset after the server answered");
      }
      return answer;
    };
    appendFileSync(transcript(), line("three secret"));
    hooked();
    await uploader({ preRedact }).pass();
    expect(session().aligned).toBe(false);
    // The log grows before the retry; the server answers offset_mismatch at its own length.
    appendFileSync(transcript(), line("four"));
    hooked();
    clock = new Date(clock.getTime() + 60 * 60_000);
    await uploader({ preRedact }).pass();
    const whole = (line("one") + line("two") + line("three secret") + line("four")).replace(
      /secret/g,
      "[REDACTED]",
    );
    // Every line arrived whole: nothing was cut at a mapped-back offset.
    expect(server.sessions.get("s1")?.text).toBe(whole);
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

  it("sends nothing more of a session once it was seen in a repo that turns capture off", async () => {
    const repoAt = (name: string, config?: string) => {
      mkdirSync(join(dir, name, ".git"), { recursive: true });
      if (config) {
        mkdirSync(join(dir, name, ".seshi"));
        writeFileSync(join(dir, name, ".seshi", "config.toml"), config);
      }
      return join(dir, name);
    };
    const a = repoAt("a");
    const b = repoAt("b", "capture = false\n");
    // Each entry spooled a millisecond after the last, so the spool reads them in the order
    // written (two in one millisecond are ordered by a random suffix).
    let spooled = Date.parse("2026-11-01T00:00:00Z");
    const entry = (kind: "capture" | "seen", id: string, cwd: string) =>
      appendSpool(
        paths,
        {
          v: 1,
          kind,
          at: clock.toISOString(),
          agent: "fake",
          session_id: id,
          transcript_path: transcript(id),
          cwd,
          ...(kind === "capture" ? { event: "Stop" } : {}),
        } as Parameters<typeof appendSpool>[1],
        new Date(spooled++),
      );

    // Started in A and uploaded, then it works in B: the uploader stops sending its new bytes.
    writeFileSync(transcript("s1"), line("one") + line("two"));
    entry("capture", "s1", a);
    await uploader().pass();
    expect(server.uploads).toHaveLength(1);
    appendFileSync(transcript("s1"), line("secret B work"));
    entry("seen", "s1", b);
    const pass = await uploader().pass();
    expect(server.uploads).toHaveLength(1);
    expect(pass.queued).toBe(0);
    expect(session("s1")).toMatchObject({ cwd: b, folders: [a, b] });

    // Started in B (skipped), then a hook in A: the whole log, B's work in it, is not sent.
    writeFileSync(transcript("s2"), line("secret B work", "s2") + line("two", "s2"));
    entry("seen", "s2", b);
    entry("capture", "s2", a);
    await uploader().pass();
    expect(server.uploads).toHaveLength(1);
    expect(session("s2")).toMatchObject({ cwd: a, folders: [b, a] });
  });

  it("sends nothing of a subagent whose parent is turned off, by hook or sweep", async () => {
    await updateState(paths, (s) => {
      s.agents.fake = { installed_at: "2026-10-01T00:00:00Z" };
      s.sessions["fake:main1"] = {
        agent: "fake",
        session_id: "main1",
        first_seen: "x",
        toggle: "off",
      };
    });
    const sub = (id: string) =>
      `${JSON.stringify({ id, cwd: dir, parent: "main1" })}\n${JSON.stringify({ id })}\n`;
    // Spooled before the parent was turned off (or by an older hook): the uploader holds it.
    writeFileSync(transcript("agent-a"), sub("agent-a"));
    appendSpool(paths, {
      v: 1,
      kind: "capture",
      at: clock.toISOString(),
      agent: "fake",
      event: "SubagentStop",
      session_id: "agent-a",
      transcript_path: transcript("agent-a"),
      cwd: dir,
      parent_session_id: "main1",
    });
    // Found only by the sweep.
    writeFileSync(transcript("agent-b"), sub("agent-b"));
    const pass = await uploader().pass({ sweep: true });
    expect(server.uploads).toHaveLength(0);
    expect(pass.queued).toBe(0);
    expect(Object.keys(readState(paths).sessions).sort()).toEqual(["fake:agent-a", "fake:main1"]);

    // Its own toggle wins over the parent's.
    await updateState(paths, (s) => {
      (s.sessions["fake:agent-a"] as SessionState).toggle = "on";
    });
    await uploader().pass();
    expect(server.uploads.map((u) => u.session_id)).toEqual(["agent-a"]);
  });

  it("sends nothing of a subagent whose parent worked in an excluded repo, by hook or sweep", async () => {
    // The parent visited excluded repo A, then cd'd to B and started subagents there.
    mkdirSync(join(dir, "a", ".git"), { recursive: true });
    mkdirSync(join(dir, "a", ".seshi"));
    writeFileSync(join(dir, "a", ".seshi", "config.toml"), "capture = false\n");
    const b = join(dir, "b");
    mkdirSync(join(b, ".git"), { recursive: true });
    await updateState(paths, (s) => {
      s.agents.fake = { installed_at: "2026-10-01T00:00:00Z" };
      s.sessions["fake:main1"] = {
        agent: "fake",
        session_id: "main1",
        first_seen: "x",
        cwd: b,
        folders: [join(dir, "a"), b],
      };
    });
    const sub = (id: string) =>
      `${JSON.stringify({ id, cwd: b, parent: "main1" })}\n${JSON.stringify({ id })}\n`;
    // Spooled by a hook that did not know (or an older one): the uploader holds it.
    writeFileSync(transcript("agent-a"), sub("agent-a"));
    appendSpool(paths, {
      v: 1,
      kind: "capture",
      at: clock.toISOString(),
      agent: "fake",
      event: "SubagentStop",
      session_id: "agent-a",
      transcript_path: transcript("agent-a"),
      cwd: b,
      parent_session_id: "main1",
    });
    // Found only by the sweep.
    writeFileSync(transcript("agent-b"), sub("agent-b"));
    const pass = await uploader().pass({ sweep: true });
    expect(server.uploads).toHaveLength(0);
    expect(pass.queued).toBe(0);
    expect(Object.keys(readState(paths).sessions)).not.toContain("fake:agent-b");
  });
});

describe("a pause stops sessions where they are (F9.5, revised 15 Nov 2026)", () => {
  const pause = () =>
    updateState(paths, (s) => {
      s.paused = { at: clock.toISOString() };
    });
  /** `seshi capture pause` as it lands: in force, and every session stopped at what it uploaded. */
  const pauseNow = () =>
    updateState(paths, (s) => {
      s.paused = { at: clock.toISOString() };
      for (const one of Object.values(s.sessions)) {
        freeze(one, clock.toISOString(), uploadedOffset(one));
      }
    });
  const resume = () =>
    updateState(paths, (s) => {
      endPause(s, clock);
    });
  /** `seshi capture on --session`. */
  const turnOn = (id = "s1") =>
    updateState(paths, (s) => {
      const one = s.sessions[`fake:${id}`] as SessionState;
      delete one.frozen;
      one.toggle = "on";
      one.toggled_at = clock.toISOString();
    });
  const later = (minutes: number) => {
    clock = new Date(clock.getTime() + minutes * 60_000);
  };
  // Lines written with this test's folder (set in beforeEach), so every line is the same length.
  let head: string;
  beforeEach(() => {
    head = line("one") + line("two");
  });

  it("stops a running session at what it uploaded; later bytes are never sent", async () => {
    writeFileSync(transcript(), head);
    hooked();
    await uploader().pass();
    // Seen by the uploader while paused, with bytes it had not sent yet.
    appendFileSync(transcript(), line("three"));
    hooked();
    await pause();
    expect(await uploader().pass()).toMatchObject({ uploaded: 0, queued: 0 });
    expect(session().frozen).toEqual({
      at: clock.toISOString(),
      offset: Buffer.byteLength(head),
    });
    later(60);
    await resume();
    appendFileSync(transcript(), line("four"));
    hooked();
    await uploader().pass({ sweep: true });
    expect(server.uploads).toHaveLength(1);
    expect(server.sessions.get("s1")?.text).toBe(head);
    // Nothing was retracted.
    expect(server.retractions).toEqual([]);
    expect(session()).toMatchObject({ stored: true, frozen: { offset: Buffer.byteLength(head) } });
  });

  it("stops a session between pieces when the pause lands mid-upload, and a 409's whole resend stops there too", async () => {
    writeFileSync(transcript(), head);
    hooked();
    await uploader().pass();
    appendFileSync(transcript(), line("three") + line("four") + line("five"));
    hooked();
    const sink: SessionSink = Object.create(server);
    let calls = 0;
    sink.ingest = async (upload, options) => {
      if (calls++ === 0) {
        // `seshi capture pause` runs while this chunk is on its way, and the server has lost
        // the session (expected 0), so the uploader goes back to the whole log.
        await pauseNow();
        server.sessions.delete("s1");
      }
      return server.ingest(upload, options);
    };
    await uploader({ sink: async () => sink, maxChunkBytes: 60 }).pass();
    expect(server.uploads.slice(1).map((u) => [u.offset, u.transcript])).toEqual([
      [Buffer.byteLength(head), line("three")],
      [0, head],
    ]);
    expect(server.sessions.get("s1")?.text).toBe(head);
    expect(session()).toMatchObject({
      stored: true,
      file_offset: Buffer.byteLength(head),
      frozen: { offset: Buffer.byteLength(head) },
    });
    await resume();
    await uploader().pass();
    expect(server.uploads).toHaveLength(3);
  });

  it("sends a moved transcript and its replace only up to where the session stopped", async () => {
    writeFileSync(transcript(), head);
    hooked();
    await uploader().pass();
    // The transcript is rewritten elsewhere (the session moved); the pause lands as it goes up
    // whole, the server says it does not extend what is stored, and the replace is cut short.
    const moved = join(dir, "sessions", "s1-moved.jsonl");
    writeFileSync(moved, line("uno") + line("dos") + line("tres"));
    hooked("s1", moved);
    const sink: SessionSink = Object.create(server);
    let calls = 0;
    sink.ingest = async (upload, options) => {
      if (calls++ === 0) await pauseNow();
      return server.ingest(upload, options);
    };
    await uploader({ sink: async () => sink }).pass();
    const cut = Buffer.byteLength(head);
    expect(server.uploads.slice(1).map((u) => [u.offset, u.replace ?? false])).toEqual([
      [0, false],
      [0, true],
    ]);
    expect(server.uploads.at(-1)?.transcript).toBe(
      readFileSync(moved).subarray(0, cut).toString("utf8"),
    );
    expect(Buffer.byteLength(server.sessions.get("s1")?.text ?? "")).toBeLessThanOrEqual(cut);
  });

  it("keeps a session started during a pause off, by hook, by sweep or first seen after it", async () => {
    await updateState(paths, (s) => {
      s.agents.fake = { installed_at: "2026-10-01T00:00:00Z" };
    });
    const write = (id: string, at: string) =>
      writeFileSync(
        transcript(id),
        `${JSON.stringify({ id, cwd: dir, at })}\n${JSON.stringify({ id })}\n`,
      );
    await pause();
    const during = clock.toISOString();
    // A hook during the pause hands the session over to be stopped (`seshi hook` does this).
    write("hooked", during);
    appendSpool(paths, {
      v: 1,
      kind: "paused",
      at: during,
      agent: "fake",
      session_id: "hooked",
      cwd: dir,
      transcript_path: transcript("hooked"),
    });
    // The sweep finds another while the pause lasts.
    write("swept", during);
    await uploader().pass({ sweep: true });
    later(30);
    await resume();
    // One whose first hook comes only after the pause, though it started during it.
    write("late", during);
    hooked("late");
    later(1);
    write("after", clock.toISOString());
    hooked("after");
    await uploader().pass({ sweep: true });
    expect(server.uploads.map((u) => u.session_id)).toEqual(["after"]);
    for (const id of ["hooked", "swept", "late"]) {
      expect(session(id)).toMatchObject({ frozen: { offset: 0 } });
    }
    expect(server.retractions).toEqual([]);
    expect(readState(paths).uploader?.queued).toBe(0);
  });

  it("keeps a session turned off whose transcript moved, finding it where it went", async () => {
    // Found by the scenario explorer (33): a hook names no path for a session turned off, so
    // once its transcript moved the sweep found the old path gone and forgot the session, toggle
    // and all; the next hook captured it again and uploads met the tombstone (422 redacted).
    writeFileSync(transcript(), head);
    hooked();
    await uploader().pass();
    await updateState(paths, (s) => {
      const one = s.sessions["fake:s1"] as SessionState;
      one.toggle = "off";
      one.toggled_at = clock.toISOString();
      one.retract = "pending";
    });
    await uploader().pass();
    expect(session()).toMatchObject({ toggle: "off", retract: "done" });
    const moved = join(dir, "elsewhere", "s1.jsonl");
    mkdirSync(join(dir, "elsewhere"));
    renameSync(transcript(), moved);
    const locating: CaptureAgent = { ...agent, locate: (id) => (id === "s1" ? moved : undefined) };
    await uploader({ agents: [locating] }).pass({ sweep: true });
    expect(session()).toMatchObject({ toggle: "off", path: moved });
  });

  it("keeps any known session whose transcript moved with no hook naming it", async () => {
    // Found by the scenario explorer (33): a session seen in a repo that turns capture off
    // gets no path from its hooks; once its transcript moved it was forgotten, folders and
    // secret with it, and captured again as new, the excluded repo's part included.
    writeFileSync(transcript(), head);
    hooked();
    await uploader().pass();
    const secret = session().secret;
    const moved = join(dir, "elsewhere", "s1.jsonl");
    mkdirSync(join(dir, "elsewhere"));
    renameSync(transcript(), moved);
    const locating: CaptureAgent = {
      ...agent,
      locate: (id) => (id === "s1" && existsSync(moved) ? moved : undefined),
    };
    await uploader({ agents: [locating] }).pass({ sweep: true });
    expect(session()).toMatchObject({ path: moved, secret, stored: true });
    // A transcript gone for good (deleted, nowhere to find): the session is forgotten.
    rmSync(moved);
    await uploader({ agents: [locating] }).pass({ sweep: true });
    expect(session()).toBeUndefined();
  });

  it("follows a stopped session's transcript that moved, keeping its stop and its secret", async () => {
    // Found by the scenario explorer (33): during a pause the hook named the moved transcript
    // to nobody, and the sweep forgot the session (its old path gone), with its stop and the
    // secret that retracts what it uploaded.
    writeFileSync(transcript(), head);
    hooked();
    await uploader().pass();
    const secret = session().secret;
    await pauseNow();
    const moved = join(dir, "elsewhere", "s1.jsonl");
    mkdirSync(join(dir, "elsewhere"));
    renameSync(transcript(), moved);
    appendFileSync(moved, line("three"));
    // What `seshi hook` spools for a stopped session whose transcript moved.
    appendSpool(paths, {
      v: 1,
      kind: "paused",
      at: clock.toISOString(),
      agent: "fake",
      session_id: "s1",
      cwd: dir,
      transcript_path: moved,
    });
    await uploader().pass({ sweep: true });
    expect(session()).toMatchObject({
      path: moved,
      secret,
      frozen: { offset: Buffer.byteLength(head) },
    });
    expect(server.uploads).toHaveLength(1);
  });

  it("is not undone by resume; turning the session on uploads all of it", async () => {
    writeFileSync(transcript(), head);
    hooked();
    await uploader().pass();
    await pauseNow();
    appendFileSync(transcript(), line("three"));
    later(10);
    await resume();
    appendFileSync(transcript(), line("four"));
    hooked();
    await uploader().pass();
    expect(server.uploads).toHaveLength(1);
    await turnOn();
    await uploader().pass();
    expect(server.sessions.get("s1")?.text).toBe(head + line("three") + line("four"));
    expect(session().frozen).toBeUndefined();
  });

  it("captures a session turned on after the pause began, while it lasts", async () => {
    writeFileSync(transcript(), head);
    hooked();
    await pauseNow();
    await uploader().pass();
    expect(server.uploads).toHaveLength(0);
    later(1);
    await turnOn();
    await uploader().pass();
    expect(server.sessions.get("s1")?.text).toBe(head);
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

  it("sends nothing of a session turned off just before its first upload", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    // `capture off` lands after the uploader read the session and before it marked it sent:
    // it sees nothing sent, so it asks for no retraction (as toggleSession does).
    let toggled = false;
    const racing: CaptureAgent = {
      ...agent,
      identify: (path, head) => {
        if (!toggled) {
          toggled = true;
          const state = readState(paths);
          const s = state.sessions["fake:s1"] as SessionState;
          s.toggle = "off";
          if (s.sent) s.retract = "pending";
          writeFileSync(paths.state, JSON.stringify(state));
        }
        return agent.identify(path, head);
      },
    };
    await uploader({ agents: [racing] }).pass();
    expect(toggled).toBe(true);
    expect(server.uploads).toHaveLength(0);
    expect(session()).toMatchObject({ toggle: "off" });
    expect(session().sent).toBeUndefined();
    expect(session().retract).toBeUndefined();
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

  it("never reports as retracted a stored session the server cannot find for this owner", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    await uploader().pass();
    // Stored under another owner since (another username, a sign-in that changed the owner).
    server.sessions.delete("s1");
    await turnOff();
    await uploader().pass();
    expect(session()).toMatchObject({ retract: "failed", stored: true });
    expect(session().retract_error).toContain("no such session");
    expect(session().secret).toBeDefined();

    // Already removed (an admin's delete): that is done.
    writeFileSync(transcript("s2"), line("one", "s2") + line("two", "s2"));
    hooked("s2");
    await uploader().pass();
    (server.sessions.get("s2") as { gone?: boolean }).gone = true;
    await turnOff("s2");
    await uploader().pass();
    expect(session("s2")).toMatchObject({ retract: "done", generation: 1 });
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
    writeFileSync(transcript("s2"), line("one", "s2") + line("two", "s2"));
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

  it("keeps a toggle set before any hook named the transcript while the transcript exists", async () => {
    await updateState(paths, (s) => {
      s.agents.fake = { installed_at: "2026-10-01T00:00:00Z" };
      s.sessions["fake:early"] = {
        agent: "fake",
        session_id: "early",
        cwd: dir,
        first_seen: "2026-10-20T00:00:00Z",
        toggle: "off",
      };
    });
    writeFileSync(transcript("early"), line("one", "early") + line("two", "early"));
    const locating = {
      ...agent,
      locate: (id: string) => (existsSync(transcript(id)) ? transcript(id) : undefined),
    };
    await uploader({ agents: [locating] }).pass({ sweep: true });
    expect(session("early")).toMatchObject({ toggle: "off", path: transcript("early") });
    expect(server.uploads).toHaveLength(0);
    // Without a transcript to find it is forgotten after a day, as any session without one.
    await updateState(paths, (s) => {
      s.sessions["fake:gone"] = {
        agent: "fake",
        session_id: "gone",
        first_seen: "2026-10-20T00:00:00Z",
        toggle: "off",
      };
    });
    await uploader({ agents: [locating] }).pass({ sweep: true });
    expect(readState(paths).sessions["fake:gone"]).toBeUndefined();
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

  /** An uploader whose clock moves a minute every pass (the rules are read once per pass), on the
   * real defaults: 5 idle minutes, 30 minutes of retrying after the last success. */
  const timed = (sink: SessionSink = server) => {
    const start = clock.getTime();
    const minutes = () => (clock.getTime() - start) / 60_000;
    const run = uploader({
      sink: async () => sink,
      pollMs: 1,
      rules: async () => {
        clock = new Date(clock.getTime() + 60_000);
        return { rules: DEFAULT_RULES };
      },
    });
    return { run, minutes };
  };

  it("stops after 5 clean idle minutes, as before", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    const { run, minutes } = timed();
    await run.run();
    expect(server.sessions.has("s1")).toBe(true);
    // Worked on the first pass, then idle from there.
    expect(minutes()).toBe(6);
  });

  it("is idle after a refusal: nothing waits to retry", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    server.failNext = [new SessionRejected("too_large", "big")];
    const { run, minutes } = timed();
    await run.run();
    expect(session().error).toMatchObject({ permanent: true });
    expect(minutes()).toBe(6);
  });

  it("stays up while uploads wait to retry, for 30 minutes after its last success", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    writeFileSync(transcript("s2"), line("one", "s2") + line("two", "s2"));
    hooked();
    hooked("s2");
    const sink: SessionSink = Object.create(server);
    const start = clock.getTime();
    // An outage: nothing goes through, except s1 once ten minutes in; s2 never does.
    sink.ingest = async (upload, options) => {
      const minute = (clock.getTime() - start) / 60_000;
      if (upload.session_id === "s1" && minute >= 10) return server.ingest(upload, options);
      throw new ServerError(503, "unavailable", "down");
    };
    const { run, minutes } = timed(sink);
    await run.run();
    expect(server.sessions.has("s1")).toBe(true);
    expect(server.sessions.has("s2")).toBe(false);
    // s1 went up at minute 10 or a little after (its backoff); 30 minutes later it stopped.
    const success = Date.parse(session().uploaded_at as string);
    expect((clock.getTime() - success) / 60_000).toBe(30);
    expect(minutes()).toBeGreaterThan(35);
    expect(session("s2")).toMatchObject({ error: { permanent: false } });
    // Nothing is lost: s2 still waits for the next uploader.
    expect(readState(paths).uploader?.queued).toBe(1);
  });

  it("stays up at most 30 minutes when nothing has succeeded since it started", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    await updateState(paths, (s) => {
      s.sessions["fake:s2"] = {
        agent: "fake",
        session_id: "s2",
        first_seen: clock.toISOString(),
        toggle: "off",
        retract: "pending",
        secret: "x",
        sent: true,
      };
    });
    const sink: SessionSink = Object.create(server);
    sink.ingest = async () => {
      throw new StoreError("cannot reach");
    };
    sink.retract = async () => {
      throw new StoreError("cannot reach");
    };
    const { run, minutes } = timed(sink);
    await run.run();
    expect(minutes()).toBe(30);
    expect(session("s2").retract).toBe("pending");
  });

  it("sends sessions seen at the same moment in key order, whatever the spool order", async () => {
    // Two hooks in the same millisecond: the spool's random suffix, not the hook, decided
    // which entry was read first, and so which session went first.
    for (const [id, spooledAt] of [
      ["s2", new Date(1)],
      ["s1", new Date(2)],
    ] as const) {
      writeFileSync(transcript(id), line("one", id) + line("two", id));
      hooked(id, transcript(id), spooledAt);
    }
    await uploader().pass();
    expect(server.uploads.map((u) => u.session_id)).toEqual(["s1", "s2"]);
  });

  it("beats between sessions, and stops mid-pass once another uploader took over", async () => {
    for (const id of ["s1", "s2"]) {
      writeFileSync(transcript(id), line("one", id) + line("two", id));
      hooked(id);
    }
    const lock = acquireUploaderLock(paths, clock) as HeldUploaderLock;
    const beats: string[] = [];
    const sink: SessionSink = Object.create(server);
    sink.ingest = async (upload) => {
      beats.push(JSON.parse(readFileSync(paths.uploader, "utf8")).beat);
      const result = await server.ingest(upload);
      // Another uploader takes the lock over while this upload is in flight.
      writeFileSync(paths.uploader, JSON.stringify({ ...lock.lock, token: "theirs" }));
      return result;
    };
    await uploader({ sink: async () => sink, pollMs: 5 }).run({ lock, keepAlive: true });
    expect(server.uploads.map((u) => u.session_id)).toEqual(["s1"]);
    expect(beats).toHaveLength(1);
  });
});

describe("resending stale sessions (X4.9)", () => {
  const HOUR = 3600 * 1000;
  const later = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  const staleAt = (current: string) => {
    server.staleList = [{ agent: "claude-code", session_id: "s1", built_with: "1", current }];
  };
  const rebuilds = () => server.uploads.filter((u) => u.rebuild);

  it("spreads a stale rebuild over the day, chunks going on meanwhile", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    await uploader().pass();
    staleAt("2");
    later(HOUR);
    // Halfway through the 24-hour spread: twelve hours from the check.
    const spread = { random: () => 0.5 };
    await uploader(spread).pass();
    expect(session().rebuild?.not_before).toBe(new Date(clock.getTime() + 12 * HOUR).toISOString());
    // Waiting: no rebuild, but new turns still go as chunks.
    appendFileSync(transcript(), line("three"));
    hooked();
    await uploader(spread).pass();
    expect(rebuilds()).toHaveLength(0);
    expect(server.uploads.at(-1)).toMatchObject({ transcript: line("three") });
    later(11 * HOUR);
    await uploader(spread).pass();
    expect(rebuilds()).toHaveLength(0);
    // Its time has come: the whole log, once.
    later(HOUR);
    await uploader(spread).pass();
    expect(rebuilds()).toHaveLength(1);
    expect(rebuilds()[0]?.transcript).toBe(line("one") + line("two") + line("three"));
    expect(session().rebuild).toBeUndefined();
  });

  it("sends at most two rebuilds a pass; the rest go in the passes after", async () => {
    for (const id of ["s1", "s2", "s3"]) {
      writeFileSync(transcript(id), line("one", id));
      hooked(id);
    }
    await uploader().pass();
    await updateState(paths, (s) => {
      for (const id of ["s1", "s2", "s3"]) {
        (s.sessions[`fake:${id}`] as SessionState).rebuild = {
          at: clock.toISOString(),
          key: `k-${id}`,
        };
      }
    });
    await uploader().pass();
    expect(rebuilds()).toHaveLength(2);
    await uploader().pass();
    expect(
      rebuilds()
        .map((u) => u.session_id)
        .sort(),
    ).toEqual(["s1", "s2", "s3"]);
  });

  it("resends a session the server lists as stale, whole with rebuild, once per version", async () => {
    writeFileSync(transcript(), line("one") + line("two") + line("three"));
    hooked();
    await uploader().pass();
    expect(session().stored).toBe(true);
    // Asked right after the first session was stored, and then not again within the hour.
    expect(server.staleCalls).toBe(1);
    staleAt("2");
    later(5000);
    await uploader().pass();
    expect(server.staleCalls).toBe(1);

    later(HOUR);
    await uploader().pass();
    expect(server.staleCalls).toBe(2);
    expect(session().rebuild).toMatchObject({ for: "2", key: expect.stringMatching(/^rebuild-/) });
    expect(sessionWord(session())).toBe("resending");
    const key = session().rebuild?.key;

    // The next pass sends it whole, with its key, proving the machine with the secret.
    await uploader().pass();
    expect(rebuilds()).toHaveLength(1);
    expect(rebuilds()[0]).toMatchObject({
      offset: 0,
      transcript: line("one") + line("two") + line("three"),
      rebuild: true,
      idempotency_key: `${key}@${Buffer.byteLength(line("one") + line("two") + line("three"))}`,
    });
    expect(rebuilds()[0]?.replace).toBeUndefined();
    expect(server.rebuildSecrets).toEqual([session().secret]);
    expect(session().rebuild).toBeUndefined();
    expect(session().rebuilt_for).toBe("2");

    // Still listed (review dropped the rebuild, say): not sent again, pass after pass.
    later(HOUR);
    await uploader().pass();
    await uploader().pass();
    expect(server.staleCalls).toBe(3);
    expect(rebuilds()).toHaveLength(1);

    // A newer normalizer still: once more.
    staleAt("3");
    later(HOUR);
    await uploader().pass();
    await uploader().pass();
    expect(rebuilds()).toHaveLength(2);
    // Chunks go on as before afterwards.
    appendFileSync(transcript(), line("four"));
    hooked();
    await uploader().pass();
    expect(server.uploads.at(-1)).toMatchObject({ transcript: line("four") });
    expect(server.uploads.at(-1)?.rebuild).toBeUndefined();
  });

  it("never resends a session turned off, and stops one turned off while it waits", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    writeFileSync(transcript("s2"), line("one", "s2") + line("two", "s2"));
    hooked();
    hooked("s2");
    await uploader().pass();
    server.staleList = [
      { agent: "claude-code", session_id: "s1", current: "2" },
      { agent: "claude-code", session_id: "s2", current: "2" },
    ];
    await updateState(paths, (s) => {
      (s.sessions["fake:s1"] as SessionState).toggle = "off";
    });
    later(HOUR);
    await uploader().pass();
    expect(session().rebuild).toBeUndefined();
    expect(session("s2").rebuild).toBeDefined();
    // Turned off after it was marked: nothing of it goes.
    await updateState(paths, (s) => {
      (s.sessions["fake:s2"] as SessionState).toggle = "off";
    });
    await uploader().pass();
    expect(rebuilds()).toHaveLength(0);
  });

  it("does not ask before anything was stored, and asks again later after a failure", async () => {
    await uploader().pass();
    expect(server.staleCalls).toBe(0);
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    server.staleFails = 1;
    const up = uploader();
    await up.pass();
    expect(server.staleCalls).toBe(1);
    expect(readState(paths).uploader?.last_stale_check).toBeUndefined();
    // Not on every pass while the server cannot answer.
    later(5000);
    await up.pass();
    expect(server.staleCalls).toBe(1);
    later(10 * 60 * 1000);
    await up.pass();
    expect(server.staleCalls).toBe(2);
    expect(readState(paths).uploader?.last_stale_check).toBe(clock.toISOString());
  });

  it("keeps a rebuild's key across a retry, and gives up a rebuild the server refuses", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    await uploader().pass();
    staleAt("2");
    later(HOUR);
    await uploader().pass();
    const key = session().rebuild?.key;
    server.failNext = [new StoreError("down")];
    await uploader().pass();
    expect(session().rebuild?.key).toBe(key);
    later(HOUR);
    await uploader().pass();
    const end = Buffer.byteLength(line("one") + line("two"));
    expect(rebuilds().map((u) => u.idempotency_key)).toEqual([`${key}@${end}`, `${key}@${end}`]);
    expect(session().rebuild).toBeUndefined();

    // Refused for good (another machine wrote it): not tried again, and chunks go on.
    staleAt("3");
    later(HOUR);
    await uploader().pass();
    server.failNext = [
      new Forbidden("only the session's original writer or an admin may rebuild it"),
    ];
    await uploader().pass();
    expect(session().rebuild).toBeUndefined();
    expect(session().rebuilt_for).toBe("3");
    expect(session().error).toMatchObject({ code: "forbidden", permanent: true });
    appendFileSync(transcript(), line("three"));
    hooked();
    await uploader().pass();
    expect(server.uploads.at(-1)).toMatchObject({ transcript: line("three") });
  });

  it("names the piece in a rebuild's key, so a retry of a grown log is not answered as the first", async () => {
    // Found by the scenario explorer (33): a rebuild landed but answered 500 (a failed delete
    // of a replaced object); the transcript grew before the retry, which went with the same key
    // and was answered with the first attempt's result, leaving the offsets past what the
    // server held.
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    await uploader().pass();
    staleAt("2");
    later(HOUR);
    await uploader().pass();
    const key = session().rebuild?.key;
    server.failNext = [new StoreError("down")];
    await uploader().pass();
    appendFileSync(transcript(), line("three"));
    later(HOUR);
    await uploader().pass();
    const ends = [line("one") + line("two"), line("one") + line("two") + line("three")];
    expect(rebuilds().map((u) => u.idempotency_key)).toEqual(
      ends.map((text) => `${key}@${Buffer.byteLength(text)}`),
    );
  });

  it("sends a session marked by hand whole with rebuild, even one the server holds nothing of", async () => {
    // A first envelope review dropped leaves nothing on the server (F3.4).
    writeFileSync(transcript(), line("one"));
    hooked();
    await uploader().pass();
    expect(session()).toMatchObject({ sent: true, stored: false, last_status: "filtered" });
    await updateState(paths, (s) => {
      (s.sessions["fake:s1"] as SessionState).rebuild = { at: clock.toISOString(), key: "k1" };
    });
    await uploader().pass();
    expect(rebuilds()).toHaveLength(1);
    expect(rebuilds()[0]).toMatchObject({
      offset: 0,
      idempotency_key: `k1@${Buffer.byteLength(line("one"))}`,
    });
    expect(session().rebuild).toBeUndefined();
    expect(session().rebuilt_for).toBeUndefined();
  });

  it("rebuilds a session a pause stopped only up to where it stopped (F9.5 with X4.9)", async () => {
    writeFileSync(transcript(), line("one") + line("two"));
    hooked();
    await uploader().pass();
    const stoppedAt = Buffer.byteLength(line("one") + line("two"));
    await updateState(paths, (s) => {
      freeze(s.sessions["fake:s1"] as SessionState, clock.toISOString(), stoppedAt);
    });
    appendFileSync(transcript(), line("three"));
    await updateState(paths, (s) => {
      (s.sessions["fake:s1"] as SessionState).rebuild = { at: clock.toISOString(), key: "k2" };
    });
    await uploader().pass();
    expect(rebuilds()).toHaveLength(1);
    expect(rebuilds()[0]?.transcript).toBe(line("one") + line("two"));
    expect(server.uploads.map((u) => u.transcript).join("")).not.toContain("three");
    expect(session().rebuild).toBeUndefined();
  });
});
