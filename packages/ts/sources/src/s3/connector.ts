import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { pickClaims, serviceIdentity } from "@seshi/auth";
import type { SourceConfig } from "@seshi/config";
import type { FormatRegistry } from "@seshi/formats";
import type {
  Connector,
  ConnectorContext,
  ConnectorFailure,
  ConnectorRunResult,
  Cursor,
  SubmitOutcome,
} from "@seshi/kit";
import { ENVELOPE_SCHEMA, type Envelope, type SourceLocation } from "@seshi/model";
import { type AssumedCredentials, parseS3Url } from "@seshi/store";
import {
  FolderSourceBucket,
  ObjectChanged,
  ObjectDenied,
  S3SourceBucket,
  type SourceBucket,
  type SourceObject,
  type SourceRead,
} from "./bucket";
import { type KeyFields, KeyFilter, metadataFields, PathTemplate } from "./keys";
import {
  HOLD_BEFORE_ANY_KEY,
  type Manifest,
  type ObjectEntry,
  readManifest,
  rewindManifest,
  SESSION_REDACTED,
} from "./manifest";

export type S3SourceConfig = Extract<SourceConfig, { type: "s3" }>;

/** How many bytes before a log's offset must be unchanged for it to continue. */
export const TAIL_WINDOW = 4096;
const SAMPLE_CHARS = 64 * 1024;
export const DEFAULT_BATCH = 200;
/** Keys per listing page (S3's maximum). */
export const DEFAULT_PAGE_SIZE = 1000;
export const DEFAULT_SAVE_EVERY = 25;

export interface S3ConnectorOptions {
  formats: FormatRegistry;
  /** The largest transcript the pipeline takes (`[limits] max_upload_bytes`): a bigger object
   * is recorded as `too_large` without being read. */
  maxBytes: number;
  env?: Readonly<Record<string, string | undefined>>;
  batch?: number;
  pageSize?: number;
  saveEvery?: number;
  stsEndpoint?: string;
  openBucket?: (config: S3SourceConfig, ctx: ConnectorContext) => SourceBucket;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

function tailOf(bytes: Uint8Array, offset: number): string | undefined {
  if (offset <= 0 || offset > bytes.length) return undefined;
  return digest(bytes.subarray(Math.max(0, offset - TAIL_WINDOW), offset));
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** A JSONL text cut after its last complete line. A last line without its newline is kept
 * when it is a whole JSON value (a log whose writer left off the final newline), and cut when
 * it is not (a line still being written). */
export function completeLines(text: string): string {
  if (text === "" || text.endsWith("\n")) return text;
  const cut = text.lastIndexOf("\n") + 1;
  const last = text.slice(cut).trim();
  if (last === "") return text;
  try {
    JSON.parse(last);
    return text;
  } catch {
    return text.slice(0, cut);
  }
}

export function sourcePrefix(config: Pick<S3SourceConfig, "url" | "prefix">): string {
  const fromUrl = /^(?:s3|r2):\/\//.test(config.url) ? parseS3Url(config.url).prefix : "";
  return [fromUrl, config.prefix ?? ""]
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter((p) => p !== "")
    .join("/");
}

type Handled = ObjectEntry | "changed" | "gone";
type AppendResult = Handled | "rewritten";

interface CompletedPass {
  listsEveryKey: boolean;
  from: string | undefined;
  seen: ReadonlySet<string>;
  beforeLast: string | undefined;
  last: string | undefined;
}

export class S3Connector implements Connector<S3SourceConfig> {
  readonly kind = "s3";
  private readonly roleCache = new Map<string, AssumedCredentials>();

  constructor(private readonly options: S3ConnectorOptions) {}

  async run(ctx: ConnectorContext<S3SourceConfig>): Promise<ConnectorRunResult> {
    return new S3Run(this.options, ctx, this.openBucket(ctx)).run();
  }

  rewind(cursor: Cursor | null, since: Date): Cursor | null {
    if (cursor === null) return null;
    const quiet = { info() {}, warn() {}, error() {} };
    return rewindManifest(readManifest(cursor, quiet), since) as unknown as Cursor;
  }

  private openBucket(ctx: ConnectorContext<S3SourceConfig>): SourceBucket {
    const config = ctx.source.config;
    if (this.options.openBucket) return this.options.openBucket(config, ctx);
    if (!/^(?:s3|r2):\/\//.test(config.url)) return new FolderSourceBucket(config.url);
    const credentials = config.credentials
      ? {
          accessKeyId: config.credentials.access_key_id.reveal(),
          secretAccessKey: config.credentials.secret_access_key.reveal(),
          ...(config.credentials.session_token
            ? { sessionToken: config.credentials.session_token.reveal() }
            : {}),
        }
      : undefined;
    return new S3SourceBucket({
      url: config.url,
      ...(config.region ? { region: config.region } : {}),
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.account_id ? { accountId: config.account_id } : {}),
      ...(credentials ? { credentials } : {}),
      ...(config.role
        ? {
            role: {
              arn: config.role.arn,
              sessionName: `seshi-${ctx.source.id}`,
              ...(config.role.external_id ? { externalId: config.role.external_id.reveal() } : {}),
            },
          }
        : {}),
      roleCache: this.roleCache,
      fetch: (input, init) => ctx.fetch(input, init),
      env: this.options.env ?? process.env,
      now: () => ctx.now(),
      ...(this.options.stsEndpoint ? { stsEndpoint: this.options.stsEndpoint } : {}),
    });
  }
}

class S3Run {
  private readonly config: S3SourceConfig;
  private readonly formats: FormatRegistry;
  private readonly manifest: Manifest;
  private readonly prefix: string;
  private readonly filter: KeyFilter;
  private readonly template: PathTemplate | undefined;
  private readonly batch: number;
  private readonly pageSize: number;
  private readonly saveEvery: number;
  private sessionHolders: Map<string, string> | undefined;
  private processed = 0;
  private unsaved = 0;
  private listed = 0;

  constructor(
    private readonly options: S3ConnectorOptions,
    private readonly ctx: ConnectorContext<S3SourceConfig>,
    private readonly bucket: SourceBucket,
  ) {
    this.config = ctx.source.config;
    this.formats = options.formats;
    this.manifest = readManifest(ctx.checkpoint.read(), ctx.log);
    this.manifest.epoch ??= ctx.now().getTime();
    const prefix = sourcePrefix(this.config);
    this.prefix = prefix === "" ? "" : `${prefix}/`;
    this.filter = new KeyFilter(this.config.include);
    this.template = this.config.path ? new PathTemplate(this.config.path) : undefined;
    this.batch = Math.max(1, options.batch ?? DEFAULT_BATCH);
    this.pageSize = Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE);
    this.saveEvery = Math.max(1, options.saveEvery ?? DEFAULT_SAVE_EVERY);
  }

  async run(): Promise<ConnectorRunResult> {
    const { config, manifest, ctx } = this;
    if (config.format !== "auto" && !this.formats.has(config.format)) {
      throw new Error(
        `format '${config.format}' is not one this binary reads (${this.formats.sources.join(", ")})`,
      );
    }
    const ordered = config.ordered_keys;
    const listsEveryKey = manifest.after === undefined;
    const from = manifest.after ?? (ordered ? manifest.watch_from : undefined);
    const seen = new Set<string>();
    let startAfter = from;
    let beforeLast: string | undefined;
    let last: string | undefined;

    for (;;) {
      const page = await this.bucket.list(this.prefix, {
        ...(startAfter !== undefined ? { startAfter } : {}),
        limit: this.pageSize,
      });
      for (const object of page.objects) {
        if (ctx.signal.aborted) return this.stop();
        if (!object.key.startsWith(this.prefix)) continue;
        const fields = this.wanted(object);
        if (fields !== null) {
          seen.add(object.key);
          const entry = manifest.objects[object.key];
          if (!entry || entry.etag !== object.etag || entry.size !== object.size) {
            if (this.processed >= this.batch) return this.stop({ more: true });
            const handled = await this.object(object, fields, entry);
            this.processed++;
            this.unsaved++;
            if (handled === "gone") delete manifest.objects[object.key];
            else if (handled === "changed") {
              if (ordered && manifest.hold === undefined) {
                manifest.hold = last ?? from ?? HOLD_BEFORE_ANY_KEY;
              }
            } else manifest.objects[object.key] = handled;
          }
        }
        this.listed++;
        beforeLast = last;
        last = object.key;
        manifest.after = object.key;
        if (this.unsaved >= this.saveEvery) await this.save();
      }
      if (!page.truncated || page.objects.length === 0) break;
      startAfter = page.objects.at(-1)?.key;
    }
    return this.complete({ listsEveryKey, from, seen, beforeLast, last });
  }

  private async complete(pass: CompletedPass): Promise<ConnectorRunResult> {
    const { manifest } = this;
    if (pass.listsEveryKey) {
      for (const key of Object.keys(manifest.objects)) {
        if ((pass.from === undefined || key > pass.from) && !pass.seen.has(key)) {
          delete manifest.objects[key];
        }
      }
    }
    if (this.config.ordered_keys) {
      const watch = this.watchFrom(pass);
      if (watch === undefined) delete manifest.watch_from;
      else {
        manifest.watch_from = watch;
        for (const key of Object.keys(manifest.objects)) {
          if (key <= watch) delete manifest.objects[key];
        }
      }
      delete manifest.hold;
    } else {
      delete manifest.watch_from;
      delete manifest.hold;
    }
    delete manifest.after;
    manifest.listed_at = this.ctx.now().toISOString();
    await this.save();
    if (this.processed > 0) {
      this.ctx.log.info(
        `listed ${this.listed} keys; read ${this.processed} new or changed objects`,
      );
    }
    return { lag_ms: 0 };
  }

  private watchFrom(pass: CompletedPass): string | undefined {
    const { manifest } = this;
    let watch = pass.last !== undefined ? (pass.beforeLast ?? pass.from) : manifest.watch_from;
    if (manifest.hold !== undefined) {
      const hold = manifest.hold === HOLD_BEFORE_ANY_KEY ? undefined : manifest.hold;
      watch = hold === undefined || (watch !== undefined && hold < watch) ? hold : watch;
    }
    return watch;
  }

  private async stop(result: ConnectorRunResult = {}): Promise<ConnectorRunResult> {
    await this.save();
    return result;
  }

  private async save(): Promise<void> {
    await this.ctx.checkpoint.write(this.manifest as unknown as Cursor);
    this.unsaved = 0;
  }

  private wanted(object: SourceObject): KeyFields | null {
    const rel = object.key.slice(this.prefix.length);
    if (rel === "" || rel.endsWith("/") || !this.filter.includes(rel)) return null;
    return this.template ? this.template.match(rel) : {};
  }

  private async object(
    object: SourceObject,
    fields: KeyFields,
    entry: ObjectEntry | undefined,
  ): Promise<Handled> {
    const base: ObjectEntry = {
      etag: object.etag,
      size: object.size,
      ...(object.last_modified ? { modified: object.last_modified } : {}),
      offset: entry?.offset ?? 0,
      ...(entry?.tail !== undefined ? { tail: entry.tail } : {}),
      ...(entry?.format !== undefined ? { format: entry.format } : {}),
      ...(entry?.session !== undefined ? { session: entry.session } : {}),
      ...(entry?.gz ? { gz: true } : {}),
    };
    if (entry?.failed === SESSION_REDACTED) return { ...base, failed: SESSION_REDACTED };
    if (object.size === 0) return base;
    const { format, session, tail } = entry ?? {};
    if (
      entry !== undefined &&
      format !== undefined &&
      session !== undefined &&
      tail !== undefined &&
      !entry.gz &&
      entry.offset > 0 &&
      object.size > entry.offset &&
      this.formats.isChunkable(format)
    ) {
      const appended = await this.append(object, { ...entry, format, session, tail }, base);
      if (appended !== "rewritten") return appended;
    }
    return this.whole(object, fields, entry, base);
  }

  private async append(
    object: SourceObject,
    entry: ObjectEntry & { format: string; session: string; tail: string },
    base: ObjectEntry,
  ): Promise<AppendResult> {
    const location = this.bucket.locate(object.key);
    const provenance: SourceLocation = { object_key: location, etag: object.etag };
    const idempotency = `${location}#${object.etag}@${entry.offset}`;
    if (object.size - entry.offset > this.options.maxBytes) {
      return this.failure(base, {
        code: "too_large",
        message: `the object grew by ${object.size - entry.offset} bytes, more than the ${this.options.maxBytes} a write takes`,
        session_key: entry.session,
        idempotency_key: idempotency,
        provenance,
      });
    }
    const window = Math.min(entry.offset, TAIL_WINDOW);
    const from = entry.offset - window;
    let read: SourceRead | null;
    try {
      read = await this.bucket.read(object.key, { etag: object.etag, start: from });
    } catch (err) {
      if (err instanceof ObjectChanged) return "changed";
      if (err instanceof ObjectDenied) {
        return this.failure(base, {
          ...refusal(err),
          session_key: entry.session,
          idempotency_key: idempotency,
          provenance,
        });
      }
      throw err;
    }
    if (read === null) return "gone";
    // A backend that ignores Range sends the whole object.
    const skip = from - read.start;
    if (skip < 0 || read.body.length < skip + window || isGzip(read.body)) return "rewritten";
    const known = read.body.subarray(skip, skip + window);
    if (digest(known) !== entry.tail) return "rewritten";
    const newBytes = read.body.subarray(skip + window);
    const cut = newBytes.lastIndexOf(0x0a) + 1;
    if (cut === 0) return base;
    const chunk = newBytes.subarray(0, cut);
    let text: string;
    try {
      text = decoder.decode(chunk);
    } catch {
      return this.failure(base, {
        code: "not_utf8",
        message: "the object's new bytes are not UTF-8 text",
        session_key: entry.session,
        idempotency_key: idempotency,
        provenance,
      });
    }
    const envelope = this.envelope({
      format: entry.format,
      session: entry.session,
      text,
      offset: entry.offset,
      idempotency,
      provenance,
      fields: {},
    });
    const result = await this.ctx.submit(envelope);
    if (result.status === "failed") {
      if (result.code === "offset_mismatch") return "rewritten";
      return { ...base, failed: result.code };
    }
    const offset = bytesOf(result);
    const end = entry.offset + cut;
    const tail =
      offset === end
        ? digest(
            read.body.subarray(Math.max(0, skip + window + cut - TAIL_WINDOW), skip + window + cut),
          )
        : undefined;
    const next: ObjectEntry = { ...base, offset };
    if (tail !== undefined) next.tail = tail;
    else delete next.tail;
    return next;
  }

  private async whole(
    object: SourceObject,
    fields: KeyFields,
    entry: ObjectEntry | undefined,
    base: ObjectEntry,
  ): Promise<Handled> {
    const location = this.bucket.locate(object.key);
    const provenance: SourceLocation = { object_key: location, etag: object.etag };
    const idempotency = `${location}#${object.etag}~${this.manifest.epoch}`;
    const rel = object.key.slice(this.prefix.length);
    const failing = (code: string, message: string, session?: string) =>
      this.failure(base, {
        code,
        message,
        ...(session !== undefined ? { session_key: session } : {}),
        idempotency_key: idempotency,
        provenance,
      });
    const max = this.options.maxBytes;
    if (object.size > max) {
      return failing(
        "too_large",
        `the object is ${object.size} bytes, more than the ${max} a write takes`,
        entry?.session ?? fields.session ?? rel,
      );
    }
    let read: SourceRead | null;
    try {
      read = await this.bucket.read(object.key, { etag: object.etag });
    } catch (err) {
      if (err instanceof ObjectChanged) return "changed";
      if (err instanceof ObjectDenied) {
        const { code, message } = refusal(err);
        return failing(code, message, entry?.session ?? fields.session ?? rel);
      }
      throw err;
    }
    if (read === null) return "gone";
    const said: KeyFields = { ...fields, ...metadataFields(read.metadata) };
    const session = entry?.session ?? said.session ?? rel;

    // Gzip, by its bytes. The bucket client asks fetch not to undo a `Content-Encoding` (that
    // would inflate without limit), so a gzip-encoded object arrives as gzip and is unzipped
    // below with a limit; a fetch that undid it anyway leaves text, read whole all the same.
    const encoding = (read.content_encoding ?? "").trim().toLowerCase();
    const encoded = encoding !== "" && encoding !== "identity";
    const gz = isGzip(read.body) || encoded;
    let bytes = read.body;
    if (isGzip(bytes)) {
      try {
        bytes = new Uint8Array(gunzipSync(bytes, { maxOutputLength: max }));
      } catch (err) {
        if (
          (err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" ||
          err instanceof RangeError
        ) {
          return failing(
            "too_large",
            `the object unzips to more than the ${max} bytes a write takes`,
            session,
          );
        }
        return failing("bad_gzip", "the object looks gzip-compressed but does not unzip", session);
      }
    }
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      if (encoded && !isGzip(read.body)) {
        return failing(
          "unsupported_encoding",
          `the object is stored with Content-Encoding ${encoding.slice(0, 40)}; only gzip is unzipped`,
          session,
        );
      }
      return failing("not_utf8", "the object is not UTF-8 text", session);
    }

    const format = this.formatOf(entry, said, text);
    if ("unknown" in format) return failing("unknown_format", format.unknown, session);
    const chunkable = this.formats.isChunkable(format.name) && !gz;
    const send = chunkable ? completeLines(text) : text;
    const named: ObjectEntry = {
      ...base,
      format: format.name,
      session,
      ...(gz ? { gz: true } : {}),
    };
    if (!gz) delete named.gz;
    if (send.trim() === "") return named;

    const owner = this.sessionHolder(format.name, session);
    if (owner !== undefined && owner !== object.key) {
      return failing(
        "duplicate_session",
        "another object of this source already feeds the same session; give each its own {session}",
        session,
      );
    }
    const envelope = this.envelope({
      format: format.name,
      session,
      text: send,
      offset: 0,
      idempotency,
      provenance,
      fields: said,
      replace: true,
    });
    const result = await this.ctx.submit(envelope);
    if (result.status === "failed") return { ...named, failed: result.code };
    this.sessionHolders?.set(`${format.name}\n${session}`, object.key);
    const offset = bytesOf(result);
    const next: ObjectEntry = { ...named, offset };
    delete next.failed;
    const tail = gz ? undefined : tailOf(bytes, offset);
    if (tail !== undefined) next.tail = tail;
    else delete next.tail;
    return next;
  }

  private formatOf(
    entry: ObjectEntry | undefined,
    said: KeyFields,
    text: string,
  ): { name: string } | { unknown: string } {
    if (entry?.format !== undefined && this.formats.has(entry.format))
      return { name: entry.format };
    if (this.config.format !== "auto") return { name: this.config.format };
    if (said.format !== undefined) {
      return this.formats.has(said.format)
        ? { name: said.format }
        : { unknown: "the object names a format this binary does not read" };
    }
    const detected = this.formats.detect(text.slice(0, SAMPLE_CHARS));
    return detected !== null
      ? { name: detected }
      : {
          unknown:
            "no format matches the object's start (set the source's format, or the object's x-amz-meta-seshi-format)",
        };
  }

  private sessionHolder(format: string, session: string): string | undefined {
    if (!this.sessionHolders) {
      this.sessionHolders = new Map();
      for (const [key, entry] of Object.entries(this.manifest.objects)) {
        if (entry.format !== undefined && entry.session !== undefined && entry.offset > 0) {
          this.sessionHolders.set(`${entry.format}\n${entry.session}`, key);
        }
      }
    }
    return this.sessionHolders.get(`${format}\n${session}`);
  }

  private envelope(input: {
    format: string;
    session: string;
    text: string;
    offset: number;
    idempotency: string;
    provenance: SourceLocation;
    fields: KeyFields;
    replace?: boolean;
  }): Envelope {
    const { fields } = input;
    const id = this.ctx.source.id;
    const claims = pickClaims({
      email: fields.email,
      name: fields.name,
      username: fields.username,
      git_email: fields.git_email,
      git_name: fields.git_name,
    });
    return {
      schema: ENVELOPE_SCHEMA,
      source: "s3",
      source_id: id,
      format: input.format,
      session_key: input.session,
      payload: {
        kind: "log",
        encoding: this.formats.isChunkable(input.format) ? "jsonl" : "json",
        text: input.text,
        offset: input.offset,
      },
      ...serviceIdentity(id),
      idempotency_key: input.idempotency,
      provenance: input.provenance,
      received_at: this.ctx.now().toISOString(),
      ...(claims ? { claims } : {}),
      ...(input.replace ? { replace: true } : {}),
      ...(fields.project !== undefined ? { project: fields.project } : {}),
      ...(fields.branch !== undefined ? { branch: fields.branch } : {}),
    };
  }

  private async failure(base: ObjectEntry, failure: ConnectorFailure): Promise<ObjectEntry> {
    if (this.ctx.fail) await this.ctx.fail(failure);
    else this.ctx.log.warn(`${failure.provenance?.object_key ?? "an object"}: ${failure.message}`);
    return { ...base, failed: failure.code };
  }
}

function refusal(err: ObjectDenied): { code: string; message: string } {
  if (err.status === 403) {
    return {
      code: "access_denied",
      message: "the bucket refused to let this source read the object",
    };
  }
  const code = err.code?.replace(/[^A-Za-z0-9.]/g, "").slice(0, 64);
  return {
    code: "unreadable",
    message: `the bucket answered ${err.status}${code ? ` ${code}` : ""} for this object`,
  };
}

function bytesOf(result: SubmitOutcome): number {
  const bytes = "bytes_total" in result ? result.bytes_total : undefined;
  return typeof bytes === "number" && bytes >= 0 ? bytes : 0;
}
