import {
  type ChangeEntry,
  isStub,
  LAYOUT_SCHEMAS,
  parseTrace,
  type SessionMetadata,
  type SessionTraceRef,
  schemaProblems,
  TRACE_SCHEMA,
  type Trace,
} from "@seshi/model";
import { decodeJson } from "./json";
import {
  archiveId,
  type ChangeKeyParts,
  isOwner,
  keys,
  LAYOUT_KEY,
  LEGACY_LAYOUT_KEY,
  parseChangeKey,
} from "./layout";
import { TOKEN_SCHEMA } from "./objects";
import { listOwners } from "./owners";
import { decodeMetadata, decodeTrace } from "./publish";
import { SPAN_SCHEMA, type SpanRecord, storedHashes } from "./spans";
import type { ListedKey, Store } from "./store";
import { namedTraces, type SessionFolder, SWEEP_MIN_AGE_MS, sessionFolders } from "./sweep";

export type Severity = "error" | "warn";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const FINDINGS = {
  read_failed: { severity: "error", what: "the store failed a read, so part was not checked" },
  marker_missing: { severity: "error", what: "the bucket holds sessions but no seshi.json" },
  marker_invalid: { severity: "error", what: "seshi.json does not parse as seshi/layout/1" },
  marker_version: {
    severity: "error",
    what: "seshi.json names a layout or trace format this seshi does not read",
  },
  marker_legacy: { severity: "error", what: "the prefix holds sessiondb's sessionstorage.json" },
  token_unreadable: { severity: "error", what: "a token record does not parse" },
  metadata_unreadable: { severity: "error", what: "a metadata.json is not JSON" },
  metadata_invalid: { severity: "error", what: "a metadata.json does not match its schema" },
  metadata_identity: {
    severity: "error",
    what: "a metadata.json names another owner or archive id than its key",
  },
  head_not_in_traces: { severity: "error", what: "a session's head is not one of its traces" },
  head_missing: { severity: "error", what: "a session's head trace has no object" },
  trace_missing: { severity: "error", what: "a trace the session lists has no object" },
  trace_unreadable: { severity: "error", what: "a trace object does not parse as a trace" },
  trace_mismatch: {
    severity: "error",
    what: "a trace object disagrees with its key or with the session's traces entry",
  },
  chain_start: {
    severity: "error",
    what: "the first trace does not start where the dropped prefix ends",
  },
  chain_break: {
    severity: "error",
    what: "a later trace is no continuation, or starts inside the trace before it",
  },
  chain_gap: {
    severity: "warn",
    what: "records between traces (or after the last) are in no trace, and no drop explains it",
  },
  chain_total: { severity: "error", what: "the traces hold more records than normalized says" },
  format_version_missing: {
    severity: "warn",
    what: "a stored session records no normalizer format_version (it counts as stale)",
  },
  publish_no_entry: { severity: "error", what: "a trace the session lists has no change entry" },
  stub_traces: { severity: "error", what: "a stub (stored, no head) lists traces" },
  stub_content: { severity: "error", what: "a stub holds fields of the dropped content" },
  stub_log_state: {
    severity: "error",
    what: "a stub does not record where its log ends (normalized, dropped_prefix)",
  },
  stub_trace_object: {
    severity: "error",
    what: "a stub has a trace object older than the sweep age",
  },
  redacted_readable: { severity: "error", what: "a tombstoned session still has a head or traces" },
  redacted_trace_object: {
    severity: "error",
    what: "a tombstoned session has a trace object older than the sweep age",
  },
  redacted_spans: {
    severity: "error",
    what: "a tombstoned session has span records or messages older than the sweep age",
  },
  tombstone_no_entry: { severity: "error", what: "a tombstoned session has no tombstone entry" },
  orphan_trace: {
    severity: "warn",
    what: "a trace object no metadata names is older than the sweep age (the sweep has not run)",
  },
  change_key: { severity: "error", what: "a key under changes/ is not a change key" },
  change_unreadable: { severity: "error", what: "a change entry does not parse as seshi/change/1" },
  change_mismatch: {
    severity: "error",
    what: "a change entry disagrees with its key, its folder's owner or its session",
  },
  change_no_session: {
    severity: "error",
    what: "a tombstone or visibility entry names a session with no metadata",
  },
  change_orphan: {
    severity: "warn",
    what: "a published entry names a session with no metadata (a first publish that failed)",
  },
  change_not_applied: {
    severity: "warn",
    what: "an entry announces a change the session does not show (a write that failed)",
  },
  span_unreadable: { severity: "error", what: "a span record does not parse as seshi/span/1" },
  span_message_missing: {
    severity: "error",
    what: "a span record names a message that is not stored",
  },
  span_message_unnamed: {
    severity: "warn",
    what: "a stored span message older than the sweep age is named by no span record",
  },
} as const satisfies Record<string, { severity: Severity; what: string }>;

export type FindingCode = keyof typeof FINDINGS;

export interface Finding {
  severity: Severity;
  code: FindingCode;
  owner?: string;
  archive_id?: string;
  key?: string;
  message: string;
}

export interface CheckCounts {
  owners: number;
  /** Sessions with a `metadata.json`. */
  sessions: number;
  stubs: number;
  /** Tombstoned sessions. */
  redacted: number;
  trace_objects: number;
  change_entries: number;
  span_records: number;
  span_messages: number;
  tokens: number;
  errors: number;
  warns: number;
}

export interface CheckReport {
  findings: Finding[];
  counts: CheckCounts;
}

export interface CheckOptions {
  /** Only these owners' sessions and change feeds; every owner when neither this nor `sessions`
   * is given. Token records are checked only for the whole bucket. */
  owners?: readonly string[];
  /** Only these sessions, and the change entries that name them. */
  sessions?: readonly { owner: string; archive_id: string }[];
  now?: () => Date;
  /** How old an unnamed object must be to count (the sweep's age, 1 hour, by default). */
  minAgeMs?: number;
  /** Read every trace a session names and check its records (true by default). False checks
   * that each exists, and costs no reads of trace objects. */
  readTraces?: boolean;
}

const MESSAGE_NAME = /^([0-9a-f]{64})\.json$/;
const TOKEN_NAME = /^([A-Za-z0-9_-]{8,64})\.json$/;
const HEX64 = /^[0-9a-f]{64}$/;
const STUB_FORBIDDEN = ["source", "project", "branch", "claims", "provenance", "redaction"];
const TOKEN_KINDS = new Set(["org", "admin", "device", "service"]);
const CONCURRENCY = 16;
const MAX_LISTED_PER_FINDING = 3;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function short(hash: string): string {
  return `${hash.slice(0, 12)}…`;
}

function knownWriteTime(modified: string | undefined): number | undefined {
  const at = modified === undefined ? Number.NaN : Date.parse(modified);
  return Number.isFinite(at) ? at : undefined;
}

function continuationEnd(fromRecord: number, records: number): number {
  return fromRecord + Math.max(records - 1, 0);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

async function pool<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (;;) {
      const at = next++;
      if (at >= items.length) return;
      await work(items[at] as T);
    }
  });
  await Promise.all(lanes);
}

async function listAll(store: Store, prefix: string): Promise<ListedKey[]> {
  const out: ListedKey[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await store.list(prefix, { startAfter: after, limit: 1000, details: true });
    const listed: ListedKey[] = page.objects ?? page.keys.map((key) => ({ key }));
    out.push(...listed);
    if (!page.truncated || listed.length === 0) return out;
    after = listed.at(-1)?.key;
  }
}

interface FeedEntry {
  key: string;
  parts: ChangeKeyParts;
  entry: ChangeEntry | null;
}

type SessionFeed = { kind: "read"; entries: FeedEntry[] } | { kind: "unreadable" };

type SessionState =
  | { kind: "none" }
  | { kind: "unusable" }
  | { kind: "read"; metadata: SessionMetadata };

class Check {
  readonly findings: Finding[] = [];
  readonly counts: CheckCounts = {
    owners: 0,
    sessions: 0,
    stubs: 0,
    redacted: 0,
    trace_objects: 0,
    change_entries: 0,
    span_records: 0,
    span_messages: 0,
    tokens: 0,
    errors: 0,
    warns: 0,
  };
  private readonly cutoff: number;
  private readonly readTraces: boolean;

  constructor(
    private readonly store: Store,
    private readonly options: CheckOptions,
  ) {
    const now = (options.now ?? (() => new Date()))().getTime();
    this.cutoff = now - (options.minAgeMs ?? SWEEP_MIN_AGE_MS);
    this.readTraces = options.readTraces !== false;
  }

  add(
    code: FindingCode,
    text: string,
    where: { owner?: string; archive_id?: string; key?: string } = {},
  ): void {
    const { severity } = FINDINGS[code];
    if (severity === "error") this.counts.errors++;
    else this.counts.warns++;
    this.findings.push({ severity, code, ...where, message: text });
  }

  async guard(
    what: string,
    where: { owner?: string; archive_id?: string; key?: string },
    work: () => Promise<void>,
  ): Promise<void> {
    try {
      await work();
    } catch (err) {
      this.add("read_failed", `${what}: ${message(err)}`, where);
    }
  }

  private isKnownOld(modified: string | undefined): boolean {
    const at = knownWriteTime(modified);
    return at !== undefined && at < this.cutoff;
  }

  async run(): Promise<void> {
    const { owners, sessions } = this.options;
    for (const owner of owners ?? []) {
      if (!isOwner(owner)) throw new Error(`'${owner}' is not an owner id`);
    }
    for (const s of sessions ?? []) {
      if (!isOwner(s.owner)) throw new Error(`'${s.owner}' is not an owner id`);
      if (!HEX64.test(s.archive_id)) throw new Error(`'${s.archive_id}' is not an archive id`);
    }
    await this.guard("reading seshi.json", { key: LAYOUT_KEY }, () => this.marker());
    if (owners === undefined && sessions === undefined) {
      await this.guard("listing tokens/", { key: keys.tokens() }, () => this.tokens());
    }
    if (sessions !== undefined) {
      const byOwner = new Map<string, Set<string>>();
      for (const s of sessions) {
        const set = byOwner.get(s.owner) ?? new Set<string>();
        set.add(s.archive_id);
        byOwner.set(s.owner, set);
      }
      for (const [owner, only] of byOwner) await this.owner(owner, only);
      return;
    }
    if (owners !== undefined) {
      for (const owner of owners) await this.owner(owner);
      return;
    }
    let after: string | undefined;
    for (;;) {
      let page: Awaited<ReturnType<typeof listOwners>> | undefined;
      await this.guard("listing owners/", { key: keys.owners() }, async () => {
        page = await listOwners(this.store, { after, limit: 100 });
      });
      if (!page) return;
      for (const owner of page.owners) await this.owner(owner);
      if (!page.truncated || page.cursor === undefined) return;
      after = page.cursor;
    }
  }

  private async marker(): Promise<void> {
    if ((await this.store.get(LEGACY_LAYOUT_KEY)) !== null) {
      this.add(
        "marker_legacy",
        `${LEGACY_LAYOUT_KEY} is here: a sessiondb store, which seshi does not read (X1.5)`,
        { key: LEGACY_LAYOUT_KEY },
      );
    }
    const object = await this.store.get(LAYOUT_KEY);
    if (object === null) {
      const used = await this.store.list(keys.owners(), { limit: 1 });
      if (used.keys.length > 0) {
        this.add("marker_missing", `the bucket holds sessions but no ${LAYOUT_KEY}`, {
          key: LAYOUT_KEY,
        });
      }
      return;
    }
    let value: unknown;
    try {
      value = decodeJson(object.body);
    } catch {
      this.add("marker_invalid", `${LAYOUT_KEY} is not JSON`, { key: LAYOUT_KEY });
      return;
    }
    const marker = (value ?? {}) as { schema?: unknown; trace_schema?: unknown };
    if (
      typeof marker.schema !== "string" ||
      !LAYOUT_SCHEMAS.includes(marker.schema) ||
      marker.trace_schema !== TRACE_SCHEMA
    ) {
      this.add(
        "marker_version",
        `${LAYOUT_KEY} is ${JSON.stringify(marker.schema)} with traces ${JSON.stringify(marker.trace_schema)}; this seshi reads ${LAYOUT_SCHEMAS.join(" or ")} with ${TRACE_SCHEMA}`,
        { key: LAYOUT_KEY },
      );
      return;
    }
    const problems = schemaProblems("layout.schema.json", value);
    if (problems.length > 0) {
      this.add(
        "marker_invalid",
        `${LAYOUT_KEY}: ${problems.slice(0, MAX_LISTED_PER_FINDING).join("; ")}`,
        {
          key: LAYOUT_KEY,
        },
      );
    }
  }

  private async tokens(): Promise<void> {
    const prefix = keys.tokens();
    const listed = (await listAll(this.store, prefix)).filter((o) =>
      TOKEN_NAME.test(o.key.slice(prefix.length)),
    );
    this.counts.tokens += listed.length;
    await pool(listed, async ({ key }) => {
      await this.guard(`reading ${key}`, { key }, async () => {
        const object = await this.store.get(key);
        if (object === null) return;
        const id = TOKEN_NAME.exec(key.slice(prefix.length))?.[1];
        let ok = false;
        try {
          const t = decodeJson<Record<string, unknown>>(object.body);
          ok =
            t !== null &&
            typeof t === "object" &&
            t.schema === TOKEN_SCHEMA &&
            t.id === id &&
            typeof t.hash === "string" &&
            /^sha256:[0-9a-f]{64}$/.test(t.hash) &&
            TOKEN_KINDS.has(t.kind as string) &&
            typeof t.owner === "string" &&
            Array.isArray(t.scopes) &&
            typeof t.created_at === "string" &&
            typeof t.revoked === "boolean";
        } catch {
          ok = false;
        }
        if (!ok) this.add("token_unreadable", `${key} does not parse as ${TOKEN_SCHEMA}`, { key });
      });
    });
  }

  private async owner(owner: string, only?: Set<string>): Promise<void> {
    this.counts.owners++;
    let feed: Map<string, FeedEntry[]> | null = null;
    await this.guard(
      `reading ${keys.changes(owner)}`,
      { owner, key: keys.changes(owner) },
      async () => {
        feed = await this.feed(owner, only);
      },
    );
    const known = feed as Map<string, FeedEntry[]> | null;
    const seen = new Set<string>();
    const walk = async (prefix: string) => {
      for await (const folder of sessionFolders(this.store, owner, prefix)) {
        if (!HEX64.test(folder.archive)) continue;
        seen.add(folder.archive);
        const where = { owner, archive_id: folder.archive };
        await this.guard("checking the session", where, () =>
          this.session(
            owner,
            folder,
            known === null
              ? { kind: "unreadable" }
              : { kind: "read", entries: known.get(folder.archive) ?? [] },
          ),
        );
      }
    };
    const prefixes = only
      ? [...only].map((archive) => `${keys.session(owner, archive)}/`)
      : [keys.sessions(owner)];
    for (const prefix of prefixes) {
      await this.guard(`listing ${prefix}`, { owner, key: prefix }, () => walk(prefix));
    }
    for (const [archive, entries] of known ?? []) {
      if (!seen.has(archive)) this.entries(owner, archive, entries, { kind: "none" });
    }
  }

  private async feed(owner: string, only?: Set<string>): Promise<Map<string, FeedEntry[]>> {
    const prefix = keys.changes(owner);
    const listed: FeedEntry[] = [];
    for (const { key } of await listAll(this.store, prefix)) {
      const parts = parseChangeKey(key.slice(prefix.length));
      if (parts === null || key.slice(prefix.length).includes("/")) {
        if (!only) {
          this.add(
            "change_key",
            `not <stamp>-<archive_id>-<suffix>-<hash|tombstone|visibility>.json`,
            { owner, key },
          );
        }
        continue;
      }
      if (only && !only.has(parts.archive_id)) continue;
      listed.push({ key, parts, entry: null });
    }
    this.counts.change_entries += listed.length;
    await pool(listed, async (item) => {
      await this.guard(`reading ${item.key}`, { owner, key: item.key }, async () => {
        const object = await this.store.get(item.key);
        if (object === null) return;
        this.entry(owner, item, object.body);
      });
    });
    const out = new Map<string, FeedEntry[]>();
    for (const item of listed) {
      const list = out.get(item.parts.archive_id) ?? [];
      list.push(item);
      out.set(item.parts.archive_id, list);
    }
    return out;
  }

  private entry(owner: string, item: FeedEntry, body: Uint8Array): void {
    const where = { owner, archive_id: item.parts.archive_id, key: item.key };
    let value: unknown;
    try {
      value = decodeJson(body);
    } catch {
      this.add("change_unreadable", "not JSON", where);
      return;
    }
    // An entry written before seshi 0.16 has no `format` (readers fill it from the metadata);
    // that alone is not a problem.
    const legacy = isObject(value) && !("format" in value);
    const problems = schemaProblems(
      "change.schema.json",
      legacy ? { ...(value as object), format: "-" } : value,
    );
    if (problems.length > 0) {
      this.add("change_unreadable", problems.slice(0, MAX_LISTED_PER_FINDING).join("; "), where);
      return;
    }
    const entry = value as ChangeEntry;
    item.entry = entry;
    const wrong: string[] = [];
    if (entry.owner !== owner) wrong.push(`owner ${JSON.stringify(entry.owner)}`);
    if (entry.archive_id !== item.parts.archive_id)
      wrong.push(`archive_id ${short(entry.archive_id)}`);
    if (entry.kind !== item.parts.kind) wrong.push(`kind ${entry.kind}`);
    if (item.parts.kind === "published" && entry.content_hash !== item.parts.content_hash) {
      wrong.push(
        `content_hash ${entry.content_hash === null ? "null" : short(entry.content_hash)}`,
      );
    }
    if (Date.parse(entry.at) !== item.parts.at) wrong.push(`at ${entry.at}`);
    if (wrong.length > 0) {
      this.add("change_mismatch", `the entry says ${wrong.join(", ")}, unlike its key`, where);
    }
  }

  private async session(owner: string, folder: SessionFolder, feed: SessionFeed): Promise<void> {
    const archive = folder.archive;
    const where = { owner, archive_id: archive };
    this.counts.trace_objects += folder.traces.size;
    let state: SessionState = { kind: "none" };
    if (folder.metadata) state = await this.metadata(owner, archive);
    if (feed.kind === "read") this.entries(owner, archive, feed.entries, state);

    if (state.kind === "unusable") return;
    const metadata = state.kind === "read" ? state.metadata : null;
    const kind =
      metadata === null
        ? "none"
        : metadata.status === "redacted"
          ? "redacted"
          : isStub(metadata)
            ? "stub"
            : "stored";
    if (kind === "redacted") this.counts.redacted++;
    if (kind === "stub") this.counts.stubs++;

    const named = namedTraces(metadata);
    for (const [hash, modified] of folder.traces) {
      if (named.has(hash) || !this.isKnownOld(modified)) continue;
      const key = keys.trace(owner, archive, hash);
      const age = `written ${modified}`;
      if (kind === "redacted") {
        this.add("redacted_trace_object", `trace ${short(hash)} is still here (${age})`, {
          ...where,
          key,
        });
      } else if (kind === "stub") {
        this.add("stub_trace_object", `trace ${short(hash)} is here (${age})`, { ...where, key });
      } else {
        this.add("orphan_trace", `trace ${short(hash)} is named by no metadata (${age})`, {
          ...where,
          key,
        });
      }
    }

    if (metadata !== null && kind === "stored")
      await this.stored(owner, archive, metadata, folder, feed);
    if (metadata !== null && kind === "stub") this.stub(owner, archive, metadata);
    if (metadata !== null && kind === "redacted") {
      if (metadata.head !== undefined || metadata.traces.length > 0) {
        this.add(
          "redacted_readable",
          `tombstoned, yet it names ${metadata.head !== undefined ? `head ${short(metadata.head)}` : ""}${metadata.head !== undefined && metadata.traces.length > 0 ? " and " : ""}${metadata.traces.length > 0 ? plural(metadata.traces.length, "trace") : ""}`,
          { ...where, key: keys.metadata(owner, archive) },
        );
      }
      if (feed.kind === "read" && !feed.entries.some((e) => e.parts.kind === "tombstone")) {
        this.add("tombstone_no_entry", "tombstoned, but no tombstone entry names it", where);
      }
    }
    if (folder.folders.has("spans")) {
      if (kind === "redacted") await this.redactedSpans(owner, archive);
      else await this.spans(owner, archive);
    }
  }

  private async metadata(owner: string, archive: string): Promise<SessionState> {
    const key = keys.metadata(owner, archive);
    const where = { owner, archive_id: archive, key };
    const object = await this.store.get(key);
    if (object === null) return { kind: "none" };
    this.counts.sessions++;
    let value: unknown;
    try {
      value = decodeMetadata(object.body);
    } catch {
      this.add("metadata_unreadable", "metadata.json is not JSON", where);
      return { kind: "unusable" };
    }
    const problems = schemaProblems("metadata.schema.json", value);
    if (problems.length > 0) {
      this.add("metadata_invalid", problems.slice(0, MAX_LISTED_PER_FINDING).join("; "), where);
      return { kind: "unusable" };
    }
    const metadata = value as SessionMetadata;
    const wrong: string[] = [];
    if (metadata.owner !== owner) wrong.push(`owner ${JSON.stringify(metadata.owner)}`);
    if (metadata.archive_id !== archive) wrong.push(`archive_id ${short(metadata.archive_id)}`);
    else if (archiveId(metadata.owner, metadata.format, metadata.session_id) !== archive) {
      wrong.push("an archive_id that is not sha256(owner, format, session_id)");
    }
    if (wrong.length > 0) {
      this.add("metadata_identity", `it names ${wrong.join(", ")}, unlike its key`, where);
    }
    return { kind: "read", metadata };
  }

  private async stored(
    owner: string,
    archive: string,
    metadata: SessionMetadata,
    folder: SessionFolder,
    feed: SessionFeed,
  ): Promise<void> {
    const where = { owner, archive_id: archive };
    const head = metadata.head as string;
    const listed = new Set(metadata.traces.map((t) => t.content_hash));
    if (!listed.has(head)) {
      this.add("head_not_in_traces", `head ${short(head)} is not in its traces`, {
        ...where,
        key: keys.metadata(owner, archive),
      });
    }
    if (!folder.traces.has(head)) {
      this.add("head_missing", `head ${short(head)} has no object`, {
        ...where,
        key: keys.trace(owner, archive, head),
      });
    }
    const present = metadata.traces.filter((ref) => {
      if (folder.traces.has(ref.content_hash)) return true;
      if (ref.content_hash !== head) {
        this.add("trace_missing", `trace ${short(ref.content_hash)} has no object`, {
          ...where,
          key: keys.trace(owner, archive, ref.content_hash),
        });
      }
      return false;
    });
    if (this.readTraces) {
      await pool(present, (ref) =>
        this.guard(`reading trace ${short(ref.content_hash)}`, where, () =>
          this.trace(owner, archive, ref),
        ),
      );
    }
    this.chain(owner, archive, metadata);
    if (metadata.normalizer?.format_version === undefined) {
      this.add(
        "format_version_missing",
        "no normalizer.format_version: it counts as stale, and its uploader resends it (X4.9)",
        { ...where, key: keys.metadata(owner, archive) },
      );
    }
    if (feed.kind === "read") {
      const announced = new Set(
        feed.entries.filter((e) => e.parts.kind === "published").map((e) => e.parts.content_hash),
      );
      for (const ref of metadata.traces) {
        if (!announced.has(ref.content_hash)) {
          this.add(
            "publish_no_entry",
            `trace ${short(ref.content_hash)} has no published entry`,
            where,
          );
        }
      }
    }
  }

  private async trace(owner: string, archive: string, ref: SessionTraceRef): Promise<void> {
    const hash = ref.content_hash;
    const key = keys.trace(owner, archive, hash);
    const where = { owner, archive_id: archive, key };
    const object = await this.store.get(key);
    if (object === null) {
      this.add("trace_missing", `trace ${short(hash)} went while it was checked`, where);
      return;
    }
    let trace: Trace;
    try {
      trace = decodeTrace(object.body);
    } catch {
      this.add("trace_unreadable", "not gzipped JSON", where);
      return;
    }
    const problems = schemaProblems("trace.schema.json", trace);
    if (problems.length > 0) {
      this.add("trace_unreadable", problems.slice(0, MAX_LISTED_PER_FINDING).join("; "), where);
      return;
    }
    let again: string;
    try {
      again = parseTrace(trace.records, {
        metadata: trace.metadata,
        ...(trace.llm_calls ? { llm_calls: trace.llm_calls } : {}),
      }).content_hash;
    } catch (err) {
      this.add("trace_unreadable", `its records are not a trace: ${message(err)}`, where);
      return;
    }
    const wrong: string[] = [];
    if (trace.content_hash !== hash)
      wrong.push(`it says content_hash ${short(trace.content_hash)}`);
    if (again !== hash) wrong.push(`its records hash to ${short(again)}`);
    if (trace.records.length !== ref.records) {
      wrong.push(`it holds ${plural(trace.records.length, "record")}, traces says ${ref.records}`);
    }
    const a = trace.metadata.continuation;
    const b = ref.continuation;
    if (a?.from_record !== b?.from_record || a?.prefix_sha256 !== b?.prefix_sha256) {
      wrong.push("its continuation is not the one traces names");
    }
    if (wrong.length > 0) this.add("trace_mismatch", wrong.join("; "), where);
  }

  private chain(owner: string, archive: string, metadata: SessionMetadata): void {
    const where = { owner, archive_id: archive, key: keys.metadata(owner, archive) };
    const traces = metadata.traces;
    const first = traces[0];
    if (!first) return;
    const dropped = metadata.dropped_prefix;
    const explained = (end: number) =>
      (metadata.applied ?? []).some((a) => a.status === "dropped" && a.records_total === end);
    const start = first.continuation?.from_record ?? 0;
    if (dropped && start !== dropped.records) {
      this.add(
        "chain_start",
        `the first trace starts at record ${start}; the dropped prefix ends at ${dropped.records}`,
        where,
      );
    }
    let end = first.continuation ? continuationEnd(start, first.records) : first.records;
    let broken = false;
    traces.slice(1).forEach((ref, i) => {
      const n = i + 1;
      if (!ref.continuation) {
        broken = true;
        this.add(
          "chain_break",
          `trace ${n} (${short(ref.content_hash)}) is not a continuation`,
          where,
        );
        end = ref.records;
        return;
      }
      const from = ref.continuation.from_record;
      if (from < end) {
        broken = true;
        this.add(
          "chain_break",
          `trace ${n} (${short(ref.content_hash)}) starts at record ${from}, inside the traces before it (they end at ${end})`,
          where,
        );
      } else if (from > end && !broken && !explained(from)) {
        this.add(
          "chain_gap",
          `records ${end}–${from - 1} are in no trace (trace ${n} starts at ${from}), and no drop in applied explains it`,
          where,
        );
      }
      end = continuationEnd(from, ref.records);
    });
    const total = metadata.normalized?.records;
    if (total === undefined || broken) return;
    if (end > total) {
      this.add(
        "chain_total",
        `the traces hold records up to ${end}; normalized says ${total}`,
        where,
      );
    } else if (end < total && !explained(total)) {
      this.add(
        "chain_gap",
        `records ${end}–${total - 1} are in no trace (normalized says ${total}), and no drop in applied explains it`,
        where,
      );
    }
  }

  private stub(owner: string, archive: string, metadata: SessionMetadata): void {
    const where = { owner, archive_id: archive, key: keys.metadata(owner, archive) };
    if (metadata.traces.length > 0) {
      this.add(
        "stub_traces",
        `no head, yet it lists ${plural(metadata.traces.length, "trace")}`,
        where,
      );
    }
    const held = STUB_FORBIDDEN.filter((field) => field in metadata);
    if (held.length > 0) this.add("stub_content", `it holds ${held.join(", ")}`, where);
    const n = metadata.normalized;
    const d = metadata.dropped_prefix;
    if (!n) {
      this.add("stub_log_state", "no normalized: where its log ends is unknown", where);
    } else if (
      !d ||
      d.bytes !== n.bytes ||
      d.records !== n.records ||
      d.prefix_sha256 !== n.prefix_sha256
    ) {
      this.add(
        "stub_log_state",
        d ? "dropped_prefix is not where its log ends (normalized)" : "no dropped_prefix",
        where,
      );
    }
  }

  private async spans(owner: string, archive: string): Promise<void> {
    const where = { owner, archive_id: archive };
    const prefix = keys.spans(owner, archive);
    const messagesPrefix = keys.spanMessages(owner, archive);
    const listed = await listAll(this.store, prefix);
    const records = listed.filter(
      (o) => !o.key.startsWith(messagesPrefix) && o.key.endsWith(".json"),
    );
    const messages = new Map<string, string | undefined>();
    for (const o of listed) {
      const hash = o.key.startsWith(messagesPrefix)
        ? MESSAGE_NAME.exec(o.key.slice(messagesPrefix.length))?.[1]
        : undefined;
      if (hash) messages.set(hash, o.modified);
    }
    this.counts.span_records += records.length;
    this.counts.span_messages += messages.size;
    const named = new Map<string, string>();
    await pool(records, async ({ key }) => {
      await this.guard(`reading ${key}`, { ...where, key }, async () => {
        const object = await this.store.get(key);
        if (object === null) return;
        let record: SpanRecord | null = null;
        try {
          record = decodeJson<SpanRecord>(object.body);
        } catch {
          record = null;
        }
        if (
          record === null ||
          typeof record !== "object" ||
          record.schema !== SPAN_SCHEMA ||
          record.part === null ||
          typeof record.part !== "object"
        ) {
          this.add("span_unreadable", `does not parse as ${SPAN_SCHEMA}`, { ...where, key });
          return;
        }
        for (const hash of storedHashes(record.input)) if (!named.has(hash)) named.set(hash, key);
      });
    });
    const missing = [...named].filter(([hash]) => !messages.has(hash));
    if (missing.length > 0) {
      this.add(
        "span_message_missing",
        `span records name ${plural(missing.length, "message")} not stored: ${missing
          .slice(0, MAX_LISTED_PER_FINDING)
          .map(([h]) => short(h))
          .join(", ")}`,
        { ...where, key: missing[0]?.[1] },
      );
    }
    const unnamed = [...messages].filter(
      ([hash, modified]) => !named.has(hash) && this.isKnownOld(modified),
    );
    if (unnamed.length > 0) {
      this.add(
        "span_message_unnamed",
        `${plural(unnamed.length, "stored message")} no span record names: ${unnamed
          .slice(0, MAX_LISTED_PER_FINDING)
          .map(([h]) => short(h))
          .join(", ")}`,
        { ...where, key: keys.spanMessage(owner, archive, unnamed[0]?.[0] as string) },
      );
    }
  }

  private async redactedSpans(owner: string, archive: string): Promise<void> {
    const listed = await listAll(this.store, keys.spans(owner, archive));
    const old = listed.filter((o) => this.isKnownOld(o.modified));
    if (old.length > 0) {
      this.add(
        "redacted_spans",
        `${plural(old.length, "span object")} still here (the tombstone deletes them)`,
        { owner, archive_id: archive, key: old[0]?.key },
      );
    }
  }

  entries(owner: string, archive: string, entries: FeedEntry[], state: SessionState): void {
    const where = { owner, archive_id: archive };
    if (state.kind === "unusable") return;
    if (state.kind === "none") {
      for (const e of entries) {
        if (e.parts.kind === "published") {
          this.add(
            "change_orphan",
            `published ${short(e.parts.content_hash as string)}, but the session has no metadata`,
            { ...where, key: e.key },
          );
        } else {
          this.add(
            "change_no_session",
            `a ${e.parts.kind === "tombstone" ? "tombstone" : "visibility change"} of a session that has no metadata`,
            { ...where, key: e.key },
          );
        }
      }
      return;
    }
    const metadata = state.metadata;
    for (const e of entries) {
      if (e.entry && e.entry.session_id !== metadata.session_id) {
        this.add(
          "change_mismatch",
          `the entry names session ${JSON.stringify(e.entry.session_id)}; the metadata ${JSON.stringify(metadata.session_id)}`,
          { ...where, key: e.key },
        );
      }
    }
    if (metadata.status === "redacted") return;
    const listed = new Set(metadata.traces.map((t) => t.content_hash));
    const sorted = [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const lastVisibility = sorted.filter((e) => e.parts.kind === "visibility_changed").at(-1);
    sorted.forEach((e, i) => {
      const at = { ...where, key: e.key };
      if (e.parts.kind === "tombstone") {
        this.add("change_not_applied", "a tombstone entry, but the session is not tombstoned", at);
      } else if (e === lastVisibility && e.entry && e.entry.visibility !== metadata.visibility) {
        this.add(
          "change_not_applied",
          `the last visibility entry says ${e.entry.visibility}; the session is ${metadata.visibility}`,
          at,
        );
      } else if (e.parts.kind === "published" && !listed.has(e.parts.content_hash as string)) {
        const replacedLater = sorted
          .slice(i + 1)
          .some((later) => later.parts.kind === "published" && later.entry?.replace === true);
        if (!replacedLater) {
          this.add(
            "change_not_applied",
            `published ${short(e.parts.content_hash as string)}, which the session does not list and nothing later replaced`,
            at,
          );
        }
      }
    });
  }
}

/** Check `store` against the layout's invariants: every finding, and what was looked at. Reads
 * only; one bad object is a finding, never a throw. Throws only for options that name no owner or
 * archive id. */
export async function checkStore(store: Store, options: CheckOptions = {}): Promise<CheckReport> {
  const check = new Check(store, options);
  await check.run();
  return { findings: check.findings, counts: check.counts };
}
