# The TypeScript libraries

Two libraries are published to npm at every release, at the same version as the binary
([install.md](install.md#npm)), as ES modules for Node 20+ and Bun with TypeScript
declarations:

| Package | What it is |
|---|---|
| `@seshi/client` | The typed HTTP client for a seshi server. Depends only on `@seshi/model` |
| `@seshi/model` | The types every part of seshi shares (the canonical trace, the stored objects, the session API), canonical text and hashing, and trace validation |

They are for programs that talk to a server: an uploader of your own, a reader that tails the
change feed, a tool that searches. To capture sessions on a laptop, use the `seshi` binary
([capture.md](capture.md)); to write your own bucket without a server, use the CLI's local mode
([config.md](config.md#the-clis-config)). There is no library that writes a bucket directly
(X3.5): the server, or the in-process Instance local mode builds, is the only writer, so
redaction always runs.

## `@seshi/client`

```sh
npm i @seshi/client      # or bun add @seshi/client
```

```ts
import { HttpSessionDB, OffsetMismatch } from "@seshi/client";

const db = new HttpSessionDB({
  server: "https://seshi.acme.internal",
  token: process.env.ACME_SESHI_TOKEN!,   // a device, service, admin or static token, or the org key
  user: "alice@acme.com",            // with the org key only: the username to write as
});

const answer = await db.ingest({
  agent: "claude-code",
  session_id: "8f1c…",
  transcript: await Bun.file("8f1c….jsonl").text(),
  project: "github.com/acme/widget",
});
// { status: "stored", content_hash: "…", records_total: 41, bytes_total: 48213, … }

// As the log grows, send only what it gained, from where the last answer ended.
await db.ingest({ agent: "claude-code", session_id: "8f1c…", transcript: tail, offset: answer.bytes_total });

const session = await db.getSession("claude-code", "8f1c…");
const trace = await db.getTrace("claude-code", "8f1c…", undefined, "otlp");
const page = await db.listSessions({ limit: 50 });
const feed = await db.changes({ after: cursor });
const found = await db.search({ q: "flaky checkout test", repo: "widget", sort: "recent" });
```

Keep your program's own variables out of the `SESHI_` namespace (the example reads
`ACME_SESHI_TOKEN`): the `seshi` CLI and server read every `SESHI_*` variable as a setting,
and refuse to start on one that is not ([config.md](config.md)).

The rules for whole uploads, chunks, continuations, forks and resends are the server's
([server.md](server.md#post-v1sessions)); the client sends what you give it and maps the
answer back.

### Calls

| Call | Route |
|---|---|
| `ingest(upload)` | `POST /v1/sessions` |
| `getSession(agent, id, {owner})` | `GET /v1/sessions/:agent/:id`; null when not stored or not readable |
| `getTrace(agent, id, hash?, format?, {owner})` | `GET …/trace`, as `seshi` (default), `letta`, `otlp` or `atif` ([formats.md](formats.md#what-seshi-writes)); null when not stored or redacted |
| `listSessions({owner, limit, after})` | `GET /v1/sessions` |
| `staleSessions({limit, after})` | `GET /v1/sessions/stale`: the caller's sessions an older normalizer built, to resend with `rebuild` |
| `tombstone(agent, id, {owner, retractSecret})` | `DELETE /v1/sessions/:agent/:id`, or a retraction with the uploading machine's secret |
| `setVisibility(agent, id, visibility, {owner})` | `PATCH /v1/sessions/:agent/:id` |
| `reviews(agent, id, {owner})` | `GET …/reviews`: what model review decided for each write |
| `changes({after, since, limit})` | `GET /v1/changes`: the caller's change feed |
| `search(request)` | `GET /v1/search` ([search.md](search.md)) |
| `me()` | `GET /v1/me`: who the credential is, and which bucket the server writes |
| `owners({after, limit})` | `GET /v1/owners` |
| `redactionRules()`, `redactionRulesSince(etag)` | `GET /v1/redaction/rules`, for redacting before upload |
| `createToken`, `listTokens`, `revokeToken`, `revokeOwnerTokens` | `/v1/tokens` (admins) |
| `jobs()`, `sources({days})`, `source(id)`, `records(kind, id, …)` | `/v1/admin/jobs` and `/v1/admin/sources` (admins) |

`authConfig({server})` and `exchangeIdToken({server}, request)` are the two calls made before
there is a token: which ways in the server takes, and an IdP ID token for a seshi session token
(X5.7).

### Options

`HttpSessionDB` takes `server`, `token`, and:

| Option | |
|---|---|
| `user` | With the org key: the username to write as, sent as `X-Seshi-User` |
| `timeoutMs` | Per request; default 120 s, the server's own idle timeout; 0 disables |
| `gzipFrom` | Bodies larger than this many bytes are sent gzipped; default 8 KiB |
| `userAgent` | Sent as `User-Agent`, so the server's logs name your program (default `@seshi/client/<version>`) |
| `fetch` | A `fetch` of your own, for tests and custom transports |

### Errors

A refusal the server maps to a status comes back as the error the pipeline would have thrown:

| Error | When |
|---|---|
| `SessionRejected` (`code`) | A transcript that cannot be stored: `unsupported_agent`, `too_large`, `bad_chunk`, `normalize_<code>`… Resending the same bytes cannot succeed |
| `OffsetMismatch` (`expected`) | A chunk that does not start where the server's copy of the log ends; resend from `expected` |
| `SessionConflict` | A whole upload that does not extend the stored session; send it with `replace` if you are its original writer |
| `Forbidden` | The credential may not do this |
| `StoreError` | The server's bucket failed; retry |
| `ServerError` (`status`, `code`) | Any other answer |

## `@seshi/model`

The shared types (`SessionMetadata`, `ChangeEntry`, `StoredTrace`, the envelope, the search
types), and the functions every implementation must agree on: `canonicalText` and
`canonicalJson`, `prefixSha256` and `PrefixHash` (the hash of a session's records so far), and
`parseTrace`, which checks a canonical trace. A reader that tails the change feed and reads
traces uses these to understand what it reads.

## Other languages

The contract is in [`spec/`](../spec): the object layout ([`layout.md`](../spec/layout.md)), the
HTTP API ([`openapi.yaml`](../spec/openapi.yaml)), the JSON Schemas of the trace, the envelope
and the stored objects ([`schemas/`](../spec/schemas)), and the record sets and goldens every
implementation must reproduce ([`testdata/`](../spec/testdata)). `seshi normalize` turns any
transcript the binary reads into canonical, redacted records on stdout, for tools that want
seshi's normalizer without linking it (X3.10).
