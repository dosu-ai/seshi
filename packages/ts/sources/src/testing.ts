import { createHash } from "node:crypto";

export interface FakeObject {
  body: Uint8Array;
  etag: string;
  modified: Date;
  metadata: Record<string, string>;
  contentEncoding?: string;
}

export interface FakeRequest {
  method: string;
  url: URL;
  headers: Headers;
}

export interface FakeS3Options {
  bucket: string;
  /** The access key id requests must be signed with; any when unset. */
  accessKeyId?: string;
  ignoreRange?: boolean;
  writable?: boolean;
  now?: () => Date;
}

const encoder = new TextEncoder();

function md5(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

function xml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function error(status: number, code: string, message: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${xml(message)}</Message></Error>`,
    { status, headers: { "content-type": "application/xml" } },
  );
}

export class FakeS3 {
  readonly objects = new Map<string, FakeObject>();
  readonly requests: FakeRequest[] = [];
  /** Answers to give before any other, in order (a failing backend). */
  readonly queued: Response[] = [];
  private readonly now: () => Date;

  constructor(readonly options: FakeS3Options) {
    this.now = options.now ?? (() => new Date());
  }

  /** Write an object (replacing any), with optional user metadata (names without
   * `x-amz-meta-`). */
  put(
    key: string,
    body: string | Uint8Array,
    options: { metadata?: Record<string, string>; modified?: Date; contentEncoding?: string } = {},
  ): FakeObject {
    const bytes = typeof body === "string" ? encoder.encode(body) : body;
    const object: FakeObject = {
      body: bytes,
      etag: md5(bytes),
      modified: options.modified ?? this.now(),
      metadata: options.metadata ?? {},
      ...(options.contentEncoding ? { contentEncoding: options.contentEncoding } : {}),
    };
    this.objects.set(key, object);
    return object;
  }

  append(key: string, more: string | Uint8Array, options: { modified?: Date } = {}): FakeObject {
    const current = this.objects.get(key);
    const tail = typeof more === "string" ? encoder.encode(more) : more;
    const body = new Uint8Array((current?.body.length ?? 0) + tail.length);
    if (current) body.set(current.body);
    body.set(tail, current?.body.length ?? 0);
    return this.put(key, body, { metadata: current?.metadata ?? {}, ...options });
  }

  delete(key: string): void {
    this.objects.delete(key);
  }

  reads(): { key: string; range?: string }[] {
    return this.requests
      .filter((r) => r.method === "GET" && !r.url.searchParams.has("list-type"))
      .map((r) => {
        const range = r.headers.get("range");
        return { key: this.keyOf(r.url) ?? "", ...(range ? { range } : {}) };
      });
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    this.handle(new Request(input, init));

  listen(): { endpoint: string; stop(): void } {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => this.handle(req) });
    return { endpoint: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  }

  private keyOf(url: URL): string | undefined {
    const path = url.pathname.split("/").map(decodeURIComponent);
    if (url.hostname.startsWith(`${this.options.bucket}.`)) return path.slice(1).join("/");
    if (path[1] !== this.options.bucket) return undefined;
    return path.slice(2).join("/");
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.requests.push({ method: request.method, url, headers: request.headers });
    const queued = this.queued.shift();
    if (queued) return queued;
    const auth = request.headers.get("authorization") ?? "";
    if (!auth.startsWith("AWS4-HMAC-SHA256 Credential=")) {
      return error(403, "AccessDenied", "the request is not signed");
    }
    if (this.options.accessKeyId && !auth.includes(`Credential=${this.options.accessKeyId}/`)) {
      return error(403, "InvalidAccessKeyId", "unknown access key");
    }
    const key = this.keyOf(url);
    if (key === undefined) return error(404, "NoSuchBucket", "no such bucket");
    if (this.options.writable && key !== "") {
      if (request.method === "PUT") return this.write(key, request);
      if (request.method === "DELETE") return this.remove(key, request);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return error(403, "AccessDenied", "this fake bucket is read-only");
    }
    if (key === "" && url.searchParams.get("list-type") === "2") return this.list(url);
    return this.get(key, request);
  }

  private list(url: URL): Response {
    const prefix = url.searchParams.get("prefix") ?? "";
    const max = Number(url.searchParams.get("max-keys") ?? 1000);
    const token = url.searchParams.get("continuation-token");
    const after = token ? atob(token) : (url.searchParams.get("start-after") ?? "");
    const keys = [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix) && k > after)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const page = keys.slice(0, max);
    const truncated = keys.length > page.length;
    const contents = page
      .map((key) => {
        const o = this.objects.get(key) as FakeObject;
        return `<Contents><Key>${xml(key)}</Key><LastModified>${o.modified.toISOString()}</LastModified><ETag>&quot;${o.etag}&quot;</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
      })
      .join("");
    const next = truncated
      ? `<NextContinuationToken>${btoa(page.at(-1) as string)}</NextContinuationToken>`
      : "";
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xml(this.options.bucket)}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents}${next}</ListBucketResult>`,
      { headers: { "content-type": "application/xml" } },
    );
  }

  /** A PUT on a writable bucket: S3 answers a failed `If-None-Match: *` or `If-Match` with
   * 412, and `If-Match` on a key with no object with 404 `NoSuchKey`. */
  private async write(key: string, request: Request): Promise<Response> {
    const current = this.objects.get(key);
    const ifMatch = request.headers.get("if-match");
    if (request.headers.get("if-none-match") === "*" && current) {
      return error(
        412,
        "PreconditionFailed",
        "At least one of the pre-conditions you specified did not hold",
      );
    }
    if (ifMatch !== null) {
      if (!current) return error(404, "NoSuchKey", "The specified key does not exist.");
      if (ifMatch.replace(/^"|"$/g, "") !== current.etag) {
        return error(
          412,
          "PreconditionFailed",
          "At least one of the pre-conditions you specified did not hold",
        );
      }
    }
    const object = this.put(key, new Uint8Array(await request.arrayBuffer()));
    return new Response(null, { status: 200, headers: { etag: `"${object.etag}"` } });
  }

  private remove(key: string, request: Request): Response {
    const current = this.objects.get(key);
    const ifMatch = request.headers.get("if-match");
    if (ifMatch !== null && current && ifMatch.replace(/^"|"$/g, "") !== current.etag) {
      return error(
        412,
        "PreconditionFailed",
        "At least one of the pre-conditions you specified did not hold",
      );
    }
    this.objects.delete(key);
    return new Response(null, { status: 204 });
  }

  private get(key: string, request: Request): Response {
    const object = this.objects.get(key);
    if (!object) return error(404, "NoSuchKey", "The specified key does not exist.");
    if (request.method === "HEAD") {
      return new Response(null, {
        headers: {
          etag: `"${object.etag}"`,
          "content-length": String(object.body.length),
          "last-modified": object.modified.toUTCString(),
        },
      });
    }
    const ifMatch = request.headers.get("if-match");
    if (ifMatch !== null && ifMatch.replace(/^"|"$/g, "") !== object.etag) {
      return error(
        412,
        "PreconditionFailed",
        "At least one of the pre-conditions you specified did not hold",
      );
    }
    const headers: Record<string, string> = {
      etag: `"${object.etag}"`,
      "last-modified": object.modified.toUTCString(),
      "content-type": "application/octet-stream",
    };
    for (const [name, value] of Object.entries(object.metadata))
      headers[`x-amz-meta-${name}`] = value;
    if (object.contentEncoding) headers["content-encoding"] = object.contentEncoding;
    const range = /^bytes=(\d+)-$/.exec(request.headers.get("range") ?? "");
    if (range && !this.options.ignoreRange) {
      const start = Number(range[1]);
      if (start >= object.body.length) {
        return error(416, "InvalidRange", "The requested range is not satisfiable");
      }
      const body = object.body.subarray(start);
      return new Response(body as BodyInit, {
        status: 206,
        headers: {
          ...headers,
          "content-range": `bytes ${start}-${object.body.length - 1}/${object.body.length}`,
        },
      });
    }
    return new Response(object.body as BodyInit, { headers });
  }
}

export interface FakeStsOptions {
  roleArn: string;
  externalId?: string;
  issued: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
  lifetimeMs?: number;
  now?: () => Date;
}

export class FakeSts {
  readonly calls: URLSearchParams[] = [];

  constructor(readonly options: FakeStsOptions) {}

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const form = new URLSearchParams(await request.text());
    this.calls.push(form);
    const auth = request.headers.get("authorization") ?? "";
    if (!/\/sts\/aws4_request/.test(auth)) {
      return error(403, "SignatureDoesNotMatch", "not signed for sts");
    }
    if (form.get("Action") !== "AssumeRole" || form.get("RoleArn") !== this.options.roleArn) {
      return error(403, "AccessDenied", "not authorized to perform sts:AssumeRole");
    }
    if ((this.options.externalId ?? null) !== form.get("ExternalId")) {
      return error(403, "AccessDenied", "the external id does not match");
    }
    const now = (this.options.now ?? (() => new Date()))();
    const expires = new Date(now.getTime() + (this.options.lifetimeMs ?? 3_600_000));
    const { issued } = this.options;
    return new Response(
      `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><AssumedRoleUser><Arn>${xml(this.options.roleArn)}/${xml(form.get("RoleSessionName") ?? "")}</Arn><AssumedRoleId>AROA:${xml(form.get("RoleSessionName") ?? "")}</AssumedRoleId></AssumedRoleUser><Credentials><AccessKeyId>${issued.accessKeyId}</AccessKeyId><SecretAccessKey>${issued.secretAccessKey}</SecretAccessKey><SessionToken>${xml(issued.sessionToken)}</SessionToken><Expiration>${expires.toISOString()}</Expiration></Credentials></AssumeRoleResult><ResponseMetadata><RequestId>c6104cbe-af31-11e0-8154-cbc7ccf896c7</RequestId></ResponseMetadata></AssumeRoleResponse>`,
      { headers: { "content-type": "text/xml" } },
    );
  };
}
