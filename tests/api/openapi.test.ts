/** The server against `spec/openapi.yaml`. Every request this test sends is validated against
 * the operation's request schema and every response against the schema the document gives
 * for that status; at the end, every documented status of every operation must have been
 * seen. A route that drifts from the document fails here, and so does a response the
 * document describes that the server never gives. */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, type AppOptions, createApp as createServer } from "@seshi/api";
import { Auth, CREDENTIAL_SCOPES } from "@seshi/auth";
import { FakeIdp } from "@seshi/auth/testing";
import { storeSession } from "@seshi/pipeline";
import { FsStore, type Store, StoreError } from "@seshi/store";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { buildFormats } from "seshi/integrations";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transcript } from "../tooling/testdata";

// --- the document -------------------------------------------------------------------------

const SPEC_PATH = join(import.meta.dirname, "../../spec/openapi.yaml");
const SCHEMAS = join(import.meta.dirname, "../../spec/schemas");

const FORMATS = buildFormats();
/** The server with this binary's formats, as `seshi serve` builds it. */
const createApp = (options: Omit<AppOptions, "formats">) =>
  createServer({ formats: FORMATS, ...options });

// biome-ignore lint/suspicious/noExplicitAny: a parsed document, walked by path
const spec: any = Bun.YAML.parse(readFileSync(SPEC_PATH, "utf8"));

/** The stored objects' JSON Schemas (`spec/schemas/`), which the document references as
 * `./schemas/<name>.schema.json`: each is registered under its `$id`, the file name. */
function linkSchemas(node: unknown): void {
  if (Array.isArray(node)) node.forEach(linkSchemas);
  else if (node && typeof node === "object") {
    const object = node as Record<string, unknown>;
    if (typeof object.$ref === "string" && object.$ref.startsWith("./schemas/")) {
      object.$ref = object.$ref.slice("./schemas/".length);
    }
    Object.values(object).forEach(linkSchemas);
  }
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const file of readdirSync(SCHEMAS).filter((f) => f.endsWith(".schema.json"))) {
  ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS, file), "utf8")));
}
linkSchemas(spec);
ajv.addSchema(spec, "spec");

/** A JSON pointer into the document, escaped. */
function pointer(...segments: (string | number)[]): string {
  return segments.map((s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
}

/** Follow a `$ref` within the document. */
function deref<T>(node: T): T {
  const ref = (node as { $ref?: string } | null)?.$ref;
  if (!ref) return node;
  if (!ref.startsWith("#/")) throw new Error(`external ref ${ref}`);
  // biome-ignore lint/suspicious/noExplicitAny: walking the parsed document
  let at: any = spec;
  for (const seg of ref.slice(2).split("/")) at = at[seg.replace(/~1/g, "/").replace(/~0/g, "~")];
  if (at === undefined) throw new Error(`dangling ref ${ref}`);
  return at;
}

const validators = new Map<string, ValidateFunction>();
function validator(...path: (string | number)[]): ValidateFunction {
  const key = pointer(...path);
  let v = validators.get(key);
  if (!v) {
    v = ajv.compile({ $ref: `spec#/${key}` });
    validators.set(key, v);
  }
  return v;
}

interface Operation {
  template: string;
  method: string;
  operationId: string;
  responses: Record<string, unknown>;
}

const operations: Operation[] = [];
for (const [template, item] of Object.entries<Record<string, unknown>>(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (method === "parameters") continue;
    const { operationId, responses } = op as {
      operationId: string;
      responses: Record<string, unknown>;
    };
    operations.push({ template, method: method.toUpperCase(), operationId, responses });
  }
}

function operationFor(method: string, path: string): Operation {
  for (const op of operations) {
    if (op.method !== method) continue;
    const pattern = new RegExp(`^${op.template.replace(/\{[^}]+\}/g, "[^/]+")}$`);
    if (pattern.test(path)) return op;
  }
  throw new Error(`no operation for ${method} ${path}`);
}

/** Which (operation, status) pairs the document describes, and which this test has seen. */
const documented = new Set(
  operations.flatMap((op) => Object.keys(op.responses).map((s) => `${op.operationId} ${s}`)),
);
const seen = new Set<string>();

// --- the server ---------------------------------------------------------------------------

const TOKEN = "sdb_test-token-0123456789abcdef";
const SMALL = transcript("claude-basic.claude-code.jsonl");
const CLAUDE = `${SMALL.trim()}\n${JSON.stringify({
  type: "assistant",
  uuid: "a3",
  timestamp: "2026-09-01T00:00:08.000Z",
  sessionId: "sess1",
  message: {
    role: "assistant",
    model: "claude-x",
    content: [{ type: "text", text: `The auth flow: ${"details ".repeat(400)}` }],
  },
})}\n`;
const PROGRESS = `${JSON.stringify({ type: "progress", uuid: "p1" })}\n`;

let dir: string;
let store: FsStore;
let app: App;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sessiondb-openapi-"));
  store = new FsStore(join(dir, "bucket"));
  app = createApp({
    store,
    storage: { url: store.url },
    tokens: [{ token: TOKEN, owner: "acme" }],
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Send a request through `app` and hold both it and the response to the document. */
async function call(
  method: string,
  path: string,
  options: {
    token?: string | null;
    user?: string;
    body?: unknown;
    raw?: string;
    encoding?: string;
    app?: App;
  } = {},
): Promise<{ status: number; body: unknown }> {
  const url = new URL(`http://sessiondb.test${path}`);
  const op = operationFor(method, url.pathname);
  const headers: Record<string, string> = {};
  if (options.encoding) headers["content-encoding"] = options.encoding;
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`;
  if (options.user !== undefined) headers["x-seshi-user"] = options.user;
  let body: string | undefined;
  if (options.raw !== undefined) {
    body = options.raw;
    headers["content-type"] = "application/json";
  } else if (options.body !== undefined) {
    const requestSchema = validator(
      "paths",
      op.template,
      op.method.toLowerCase(),
      "requestBody",
      "content",
      "application/json",
      "schema",
    );
    expect(requestSchema(options.body), JSON.stringify(requestSchema.errors)).toBe(true);
    body = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }
  const response = await (options.app ?? app).fetch(new Request(url, { method, headers, body }));
  const status = response.status;
  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : undefined;

  const documentedResponse = op.responses[String(status)] as
    | { $ref?: string; content?: Record<string, unknown> }
    | undefined;
  expect(documentedResponse, `${op.operationId} does not document ${status}`).toBeDefined();
  const content = deref(documentedResponse as { content?: Record<string, unknown> }).content;
  if (content) {
    expect(response.headers.get("content-type")).toContain("application/json");
    const responseRef = (documentedResponse as { $ref?: string }).$ref;
    const schema = responseRef
      ? validator(
          ...responseRef
            .slice(2)
            .split("/")
            .map((s) => s.replace(/~1/g, "/")),
          "content",
          "application/json",
          "schema",
        )
      : validator(
          "paths",
          op.template,
          op.method.toLowerCase(),
          "responses",
          String(status),
          "content",
          "application/json",
          "schema",
        );
    expect(
      schema(parsed),
      `${op.operationId} ${status}: ${JSON.stringify(schema.errors)}\n${text}`,
    ).toBe(true);
  }
  seen.add(`${op.operationId} ${status}`);
  return { status, body: parsed };
}

describe("the document itself", () => {
  it("compiles every schema", () => {
    for (const name of Object.keys(spec.components.schemas))
      validator("components", "schemas", name);
  });

  it("names every route the server has, and no other", () => {
    const routes = operations.map((op) => `${op.method} ${op.template}`).sort();
    expect(routes).toEqual(
      [
        "GET /healthz",
        "GET /v1/auth/config",
        "POST /v1/auth/exchange",
        "GET /v1/me",
        "GET /v1/owners",
        "PATCH /v1/sessions/{agent}/{session_id}",
        "POST /v1/tokens",
        "GET /v1/tokens",
        "POST /v1/tokens/revoke",
        "DELETE /v1/tokens/{id}",
        "POST /v1/sessions",
        "GET /v1/sessions",
        "GET /v1/sessions/{agent}/{session_id}",
        "DELETE /v1/sessions/{agent}/{session_id}",
        "GET /v1/sessions/{agent}/{session_id}/trace",
        "GET /v1/changes",
      ].sort(),
    );
  });
});

describe("the server honours it", () => {
  it("health and identity", async () => {
    expect((await call("GET", "/healthz", { token: null })).status).toBe(200);
    expect((await call("GET", "/v1/me")).status).toBe(200);
    expect((await call("GET", "/v1/me", { token: null })).status).toBe(401);
  });

  it("a session's life", async () => {
    const stored = await call("POST", "/v1/sessions", {
      body: {
        agent: "claude-code",
        session_id: "sess1",
        transcript: CLAUDE,
        project: "github.com/acme/widget",
        branch: "main",
      },
    });
    expect(stored.status).toBe(201);
    const { bytes_total, content_hash, records_total, prefix_sha256 } = stored.body as {
      bytes_total: number;
      content_hash: string;
      records_total: number;
      prefix_sha256: string;
    };

    // A resend; the log again with nothing new in it; a chunk with nothing in it; a wrong
    // offset.
    const again = await call("POST", "/v1/sessions", {
      body: { agent: "claude-code", session_id: "sess1", transcript: CLAUDE },
    });
    expect(again).toEqual(stored);
    const unchanged = await call("POST", "/v1/sessions", {
      body: {
        agent: "claude-code",
        session_id: "sess1",
        transcript: CLAUDE,
        shipped: { records: records_total, prefix_sha256 },
        idempotency_key: "resent-whole",
      },
    });
    expect(unchanged.status).toBe(200);
    expect(unchanged.body).toMatchObject({ status: "unchanged" });
    const chunk = await call("POST", "/v1/sessions", {
      body: {
        agent: "claude-code",
        session_id: "sess1",
        transcript: PROGRESS,
        offset: bytes_total,
      },
    });
    expect(chunk.body).toMatchObject({ status: "unchanged" });
    const wrong = await call("POST", "/v1/sessions", {
      body: { agent: "claude-code", session_id: "sess1", transcript: PROGRESS, offset: 5 },
    });
    expect(wrong.status).toBe(409);
    expect(wrong.body).toMatchObject({ error: { expected: bytes_total + PROGRESS.length } });

    // A whole upload that does not extend the session; its replace, by its writer only.
    const rewritten = CLAUDE.replace("The auth flow:", "Another answer:");
    const conflict = await call("POST", "/v1/sessions", {
      body: { agent: "claude-code", session_id: "sess1", transcript: rewritten },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: { code: "conflict" } });
    await storeSession(
      {
        owner: "acme",
        agent: "claude-code",
        session_id: "theirs",
        transcript: CLAUDE,
        format: "jsonl",
      },
      {
        store,
        formats: FORMATS,
        context: { writer: { kind: "service", principal: "svc-import", source_id: "upload" } },
      },
    );
    const forbidden = await call("POST", "/v1/sessions", {
      body: { agent: "claude-code", session_id: "theirs", transcript: rewritten, replace: true },
    });
    expect(forbidden.status).toBe(403);

    // Reads.
    expect((await call("GET", "/v1/sessions")).status).toBe(200);
    expect((await call("GET", "/v1/sessions?limit=5")).status).toBe(200);
    expect((await call("GET", "/v1/sessions?limit=0")).status).toBe(400);
    expect((await call("GET", "/v1/sessions/claude-code/sess1")).status).toBe(200);
    expect((await call("GET", "/v1/sessions/claude-code/sess1/trace")).status).toBe(200);
    expect(
      (await call("GET", `/v1/sessions/claude-code/sess1/trace?hash=${content_hash}`)).status,
    ).toBe(200);
    expect((await call("GET", "/v1/changes")).status).toBe(200);
    expect((await call("GET", "/v1/changes?since=2020-01-01T00:00:00Z&limit=10")).status).toBe(200);
    expect((await call("GET", "/v1/changes?limit=nope")).status).toBe(400);

    // Not there, no trace yet, gone.
    expect((await call("GET", "/v1/sessions/claude-code/nope")).status).toBe(404);
    expect((await call("GET", "/v1/sessions/claude-code/nope/trace")).status).toBe(404);
    expect((await call("DELETE", "/v1/sessions/claude-code/nope")).status).toBe(404);
    const tiny = await call("POST", "/v1/sessions", {
      body: { agent: "claude-code", session_id: "tiny", transcript: SMALL },
    });
    expect(tiny.body).toMatchObject({ status: "filtered" });
    expect((await call("GET", "/v1/sessions/claude-code/tiny/trace")).status).toBe(404);
    expect((await call("DELETE", "/v1/sessions/claude-code/sess1")).status).toBe(200);
    expect((await call("GET", "/v1/sessions/claude-code/sess1/trace")).status).toBe(410);
    expect(
      (
        await call("POST", "/v1/sessions", {
          body: { agent: "claude-code", session_id: "sess1", transcript: CLAUDE },
        })
      ).status,
    ).toBe(422);
  });

  it("refusals", async () => {
    expect(
      (
        await call("POST", "/v1/sessions", {
          token: null,
          body: { agent: "codex", session_id: "x", transcript: "x" },
        })
      ).status,
    ).toBe(401);
    expect((await call("POST", "/v1/sessions", { raw: "{not json" })).status).toBe(400);
    expect((await call("POST", "/v1/sessions", { raw: "{}", encoding: "gzip" })).status).toBe(400);
    expect((await call("POST", "/v1/sessions", { raw: "{}", encoding: "br" })).status).toBe(415);
    const tiny = createApp({
      store,
      storage: { url: store.url },
      tokens: [{ token: TOKEN, owner: "acme" }],
      limits: { max_records: 50_000, max_records_bytes: 32 << 20, max_upload_bytes: 16 },
    });
    expect(
      (await call("POST", "/v1/sessions", { raw: " ".repeat((1 << 20) + 64), app: tiny })).status,
    ).toBe(413);
    expect(
      (
        await call("POST", "/v1/sessions", {
          body: { agent: "claude-code", session_id: "blank", transcript: "  " },
        })
      ).status,
    ).toBe(422);
    for (const path of [
      "/v1/sessions",
      "/v1/sessions/claude-code/x",
      "/v1/sessions/claude-code/x/trace",
      "/v1/changes",
    ]) {
      expect((await call("GET", path, { token: null })).status).toBe(401);
    }
    expect((await call("DELETE", "/v1/sessions/claude-code/x", { token: null })).status).toBe(401);
  });

  it("every render format", async () => {
    const body = { agent: "claude-code", session_id: "render", transcript: CLAUDE };
    expect((await call("POST", "/v1/sessions", { body })).status).toBe(201);
    const path = "/v1/sessions/claude-code/render/trace";
    const seshi = await call("GET", path);
    expect(seshi.body).toMatchObject({ schema: "seshi/trace/1" });
    expect((await call("GET", `${path}?format=seshi`)).body).toEqual(seshi.body);
    const letta = await call("GET", `${path}?format=letta`);
    expect(letta.body).toMatchObject({
      schema: "sessionstorage/trace/1",
      content_hash: (seshi.body as { content_hash: string }).content_hash,
    });
    expect((await call("GET", `${path}?format=otlp`)).body).toHaveProperty("resourceSpans");
    expect((await call("GET", `${path}?format=atif`)).body).toMatchObject({
      schema_version: "ATIF-v1.7",
      agent: { name: "claude-code" },
    });
    const bad = await call("GET", `${path}?format=xml`);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("seshi, letta, otlp, atif");
  });

  it("a failing bucket", async () => {
    const broken: Store = {
      url: store.url,
      get: () => Promise.reject(new StoreError("down")),
      put: () => Promise.reject(new StoreError("down")),
      stat: () => Promise.reject(new StoreError("down")),
      delete: () => Promise.reject(new StoreError("down")),
      list: () => Promise.reject(new StoreError("down")),
    };
    // An admin's session token is checked without the bucket, so the token routes reach it.
    const downAuth = new Auth(
      {
        staticTokens: [{ token: TOKEN, owner: "acme" }],
        orgKey: true,
        admins: [],
        aliases: {},
        sessionKeys: { k1: "k".repeat(32) },
      },
      { store: broken, deployment: "test" },
    );
    const down = createApp({ store: broken, storage: { url: broken.url }, auth: downAuth });
    const signed = await downAuth.sessions?.sign({
      owner: "ops",
      role: "admin",
      scopes: CREDENTIAL_SCOPES.admin,
    });
    const admin = { app: down, token: signed?.token };
    expect((await call("GET", "/v1/owners", { app: down })).status).toBe(502);
    expect(
      (
        await call("PATCH", "/v1/sessions/claude-code/x", {
          app: down,
          body: { visibility: "owner" },
        })
      ).status,
    ).toBe(502);
    expect(
      (await call("POST", "/v1/tokens", { ...admin, body: { kind: "admin", owner: "x" } })).status,
    ).toBe(502);
    expect((await call("GET", "/v1/tokens", admin)).status).toBe(502);
    expect(
      (await call("POST", "/v1/tokens/revoke", { ...admin, body: { owner: "x" } })).status,
    ).toBe(502);
    expect((await call("DELETE", `/v1/tokens/${"0".repeat(20)}`, admin)).status).toBe(502);
    const body = { agent: "claude-code", session_id: "x", transcript: CLAUDE };
    // Who the token is needs no bucket.
    expect((await call("GET", "/v1/me", { app: down })).status).toBe(200);
    expect((await call("POST", "/v1/sessions", { body, app: down })).status).toBe(502);
    expect((await call("GET", "/v1/sessions", { app: down })).status).toBe(502);
    expect((await call("GET", "/v1/sessions/claude-code/x", { app: down })).status).toBe(502);
    expect((await call("GET", "/v1/sessions/claude-code/x/trace", { app: down })).status).toBe(502);
    expect((await call("DELETE", "/v1/sessions/claude-code/x", { app: down })).status).toBe(502);
    expect((await call("GET", "/v1/changes", { app: down })).status).toBe(502);
  });
});

describe("identity and access (X5)", () => {
  let idp: FakeIdp;
  let x5: App;
  let auth: Auth;

  beforeAll(async () => {
    idp = await FakeIdp.create();
  });

  beforeEach(() => {
    auth = new Auth(
      {
        staticTokens: [{ token: TOKEN, owner: "acme" }],
        orgKey: true,
        admins: [],
        aliases: {},
        sessionKeys: { k1: "k".repeat(32) },
        oidc: {
          issuer: idp.issuer,
          client_id: "seshi-cli",
          audience: idp.audience,
          owner_claim: "sub",
          groups_claim: "groups",
        },
      },
      { store, deployment: "test", oidcKeys: idp.keys },
    );
    x5 = createApp({ store, storage: { url: store.url }, auth });
  });

  it("the auth routes", async () => {
    expect((await call("GET", "/v1/auth/config", { token: null, app: x5 })).status).toBe(200);
    const signedIn = await call("POST", "/v1/auth/exchange", {
      token: null,
      app: x5,
      body: { id_token: await idp.idToken({ email: "a@acme.com" }), machine: { id: "mbp" } },
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body).toHaveProperty("device_token");
    expect(
      (await call("POST", "/v1/auth/exchange", { token: null, app: x5, raw: "{}" })).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/v1/auth/exchange", {
          token: null,
          app: x5,
          body: { id_token: await idp.idToken({ aud: "elsewhere" }) },
        })
      ).status,
    ).toBe(401);
    // The default server has no IdP.
    expect(
      (await call("POST", "/v1/auth/exchange", { token: null, body: { id_token: "x" } })).status,
    ).toBe(404);
  });

  it("owners, visibility and scopes", async () => {
    const { admin: first, org_key } = await auth.initAdmin({ owner: "ops" });
    const admin = { app: x5, token: first?.token };
    const alice = { app: x5, token: org_key?.token, user: "alice" };
    const created = await call("POST", "/v1/tokens", {
      ...admin,
      body: { kind: "device", owner: "alice", label: "laptop" },
    });
    expect(created.status).toBe(201);
    const device = { app: x5, token: (created.body as { token: string }).token };
    const body = { agent: "claude-code", session_id: "s1", transcript: CLAUDE };
    expect((await call("POST", "/v1/sessions", { ...device, body })).status).toBe(201);

    expect((await call("GET", "/v1/owners", alice)).status).toBe(200);
    expect((await call("GET", "/v1/owners?after=a/b", alice)).status).toBe(400);
    expect((await call("GET", "/v1/owners", { app: x5, token: null })).status).toBe(401);
    // A device token writes and reads nothing.
    expect((await call("GET", "/v1/owners", device)).status).toBe(403);
    expect((await call("GET", "/v1/sessions", device)).status).toBe(403);
    expect((await call("GET", "/v1/sessions/claude-code/s1", device)).status).toBe(403);
    expect((await call("GET", "/v1/sessions/claude-code/s1/trace", device)).status).toBe(403);
    expect((await call("GET", "/v1/changes", device)).status).toBe(403);
    expect((await call("DELETE", "/v1/sessions/claude-code/s1", alice)).status).toBe(403);

    const patch = (as: object, visibility: unknown, path = "/v1/sessions/claude-code/s1") =>
      call("PATCH", path, { ...as, body: { visibility } });
    expect((await patch(alice, "owner")).status).toBe(200);
    expect((await call("GET", "/v1/sessions/claude-code/s1?owner=alice", alice)).status).toBe(200);
    expect(
      (
        await call("PATCH", "/v1/sessions/claude-code/s1", {
          ...alice,
          raw: JSON.stringify({ visibility: "everyone" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("PATCH", "/v1/sessions/claude-code/s1", {
          app: x5,
          token: null,
          body: { visibility: "org" },
        })
      ).status,
    ).toBe(401);
    expect((await patch(device, "org")).status).toBe(403);
    expect((await patch(alice, "org", "/v1/sessions/claude-code/nope")).status).toBe(404);
    expect((await call("DELETE", "/v1/sessions/claude-code/s1?owner=alice", admin)).status).toBe(
      200,
    );
    expect(
      (await patch({ ...admin }, "org", "/v1/sessions/claude-code/s1?owner=alice")).status,
    ).toBe(410);
  });

  it("the token routes", async () => {
    const { admin: first } = await auth.initAdmin({ owner: "ops" });
    const admin = { app: x5, token: first?.token };
    const member = { app: x5, token: TOKEN };
    const created = await call("POST", "/v1/tokens", {
      ...admin,
      body: { kind: "service", service: "sync", scopes: ["sessions:read", "search"] },
    });
    expect(created.status).toBe(201);
    const id = (created.body as { record: { id: string } }).record.id;
    expect((await call("POST", "/v1/tokens", { ...admin, body: { kind: "device" } })).status).toBe(
      400,
    );
    expect(
      (await call("POST", "/v1/tokens", { app: x5, token: null, body: { kind: "org" } })).status,
    ).toBe(401);
    expect((await call("POST", "/v1/tokens", { ...member, body: { kind: "org" } })).status).toBe(
      403,
    );
    expect((await call("GET", "/v1/tokens?kind=service", admin)).status).toBe(200);
    expect((await call("GET", "/v1/tokens?all=maybe", admin)).status).toBe(400);
    expect((await call("GET", "/v1/tokens", { app: x5, token: null })).status).toBe(401);
    expect((await call("GET", "/v1/tokens", member)).status).toBe(403);
    expect((await call("DELETE", `/v1/tokens/${id}`, admin)).status).toBe(200);
    expect((await call("DELETE", `/v1/tokens/${"0".repeat(20)}`, admin)).status).toBe(404);
    expect((await call("DELETE", `/v1/tokens/${id}`, { app: x5, token: null })).status).toBe(401);
    expect((await call("DELETE", `/v1/tokens/${id}`, member)).status).toBe(403);
    expect(
      (await call("POST", "/v1/tokens/revoke", { ...admin, body: { owner: "svc:sync" } })).status,
    ).toBe(200);
    expect((await call("POST", "/v1/tokens/revoke", { ...admin, raw: "{}" })).status).toBe(400);
    expect(
      (await call("POST", "/v1/tokens/revoke", { app: x5, token: null, body: { owner: "x" } }))
        .status,
    ).toBe(401);
    expect(
      (await call("POST", "/v1/tokens/revoke", { ...member, body: { owner: "x" } })).status,
    ).toBe(403);
  });
});

afterAll(() => {
  // Every response the document describes, this test has seen the server give.
  const unseen = [...documented].filter((d) => !seen.has(d)).sort();
  expect(unseen, "documented but never observed").toEqual([]);
});
