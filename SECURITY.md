# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/dosu-ai/sessiondb/security/advisories/new)
on GitHub. Do not open a public issue for anything that could expose a session transcript or a
credential.

## What the server protects, and what it does not

**Transcripts arrive unredacted.** The client posts the native log verbatim; redaction happens
on the server before anything is written. The server process and the network path to it see
secrets. Run it behind TLS (a reverse proxy or a load balancer that terminates HTTPS) and keep
the host as locked down as anything else that handles credentials.

**Redaction is best-effort.** The pass (`packages/ts/redact/src/secrets.ts`) is biased toward
over-redaction and covers the shapes secrets usually take: provider token prefixes, key/value
credential assignments, bearer headers, JWTs, connection URLs, private-key blocks, and a
Shannon-entropy pass for anything long and random in a secret-shaped position. A secret in a
shape none of those recognise reaches the bucket. Before it, a pass withholds what tool calls
returned when they touched a secrets file or ran a command that prints a secret
(`packages/ts/redact/src/sensitive.ts`), since those are mostly values no pattern
recognises; an operator can add patterns, files and commands of their own
(`redaction.packs`), never remove a built-in one. Treat the bucket as sensitive data with a
narrow audience, not as a public artifact. If you find a secret shape the pass misses, report
it as a vulnerability.

**Every credential is scoped and revocable (X5).** A caller writes only its own sessions
(`owners/<owner>/`), and reads its own plus those whose visibility is `org`; admins and
service readers read everything. Seshi tokens (`seshi_…`: org key, admin, device, service) are
stored only as SHA-256 hashes in the bucket, revocable one by one or all of a person's at once,
and a revocation takes effect within the server's 30-second cache. Session tokens are signed
with a key only the server holds (`auth.session_keys`), last an hour, and name the deployment,
so a token from another deployment is refused. A delete needs an admin token or a session
token issued in the last 10 minutes. ID tokens from the IdP are checked (signature against
the IdP's published keys, issuer, audience, expiry, nonce) and used only to obtain a seshi
token. There is no shared HS256 secret: nothing outside the server can mint a token. Static
tokens from config are compared in constant time and must be at least 16 characters.

**The org key is trust, not identity.** Without an IdP, anyone holding the org key can write
as any username and read org-wide; such sessions are marked `owner_basis: claimed`. It cannot
delete, and it cannot replace a session whose owner was verified. Rotating it (`seshi admin
init --rotate-org-key`) is the only cut-off. Use an IdP where people must be verified.

**The bucket credential lives only on the server.** Clients never receive it. `GET /v1/me`
reports the bucket URL and region so a client can tell a reader where to look; it never
reports a key.

**Readers are outside this server's control.** Anything with a read key on the bucket reads
every owner's folder and skips visibility. Prefer a service token through the API; scope any
bucket reader credential to the prefix you intend to share.

**Tombstones delete objects, not history.** `DELETE /v1/sessions/…` removes the trace
objects (no raw transcript is stored) and appends a tombstone to the change feed; a reader that already copied the trace
still has it. Object versioning or replication on the bucket, if enabled, keeps the deleted
bytes under the bucket's own retention rules.
