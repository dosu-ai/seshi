# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/dosu-ai/sessiondb/security/advisories/new)
on GitHub. Do not open a public issue for anything that could expose a session transcript or a
credential.

## What seshi protects, and what it does not

**Transcripts arrive unredacted, unless the client redacted them.** The capture uploader
redacts each piece with the server's rules before sending it (below), but any other client may
post the native log verbatim, and the server redacts everything again before anything is
written. The server process and the network path to it see
secrets. Run it behind TLS (a reverse proxy or a load balancer that terminates HTTPS) and keep
the host as locked down as anything else that handles credentials.

**Redaction is best-effort.** The built-in pack (`packages/ts/redact/packs/builtin.toml` and
`packages/ts/redact/src/secrets.ts`, [docs/redaction.md](docs/redaction.md)) is biased toward
over-redaction and covers the shapes secrets usually take: provider token prefixes, key/value
credential assignments, bearer headers, JWTs, connection URLs, private-key blocks, and a
Shannon-entropy pass for anything long and random in a secret-shaped position. A secret in a
shape none of those recognise reaches the bucket. Before it, a pass withholds what tool calls
returned when they touched a secrets file or ran a command that prints a secret
(`packages/ts/redact/src/sensitive.ts`), since those are mostly values no pattern
recognises. An operator adds rules of their own in rule packs (`redaction.packs`), whose
patterns run under RE2, so no operator pattern can make matching take more than linear time;
a pack can turn off a built-in rule by its id (`disable`), which `seshi redact test` lists, so
review packs like code. Matched values are never stored or logged, only counts by rule id. Treat the bucket as sensitive data with a
narrow audience, not as a public artifact. If you find a secret shape the pass misses, report
it as a vulnerability.

**Model review sends records to a model provider, when you turn it on (F3).** It is off until
a `[[review.policies]]` entry names a provider key. Then the regex-redacted text of each
upload's new records (content and tool call arguments, never the uploaded transcript, the meta
record, ids or timestamps) goes to the endpoint each step names, and nowhere else: keys and
endpoints come only from the config, redirects are refused, and provider error text is never
recorded. `seshi config check` names every endpoint. Model review is a second net, not a
guarantee: a model can miss text or remove too much, and the redactor's findings are applied
by exact match only. Point both steps at a local OpenAI-compatible model if transcripts may
not leave your network.

**Every credential is scoped and revocable (X5).** A caller writes only its own sessions
(`owners/<owner>/`), and reads its own plus those whose visibility is `org`; admins and
service readers read everything. Seshi tokens (`seshi_…`: org key, admin, device, service) are
stored only as SHA-256 hashes in the bucket, revocable one by one or all of a person's at once,
and a revocation takes effect within the server's 30-second cache. Session tokens are signed
with a key only the server holds (`auth.session_keys`), last an hour, and name the deployment,
so a token from another deployment is refused. A delete needs an admin token, a session
token issued in the last 10 minutes, or a static token from config for its own owner's
sessions. ID tokens from the IdP are checked (signature against
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

**The laptop keeps little, and only for its user (F9).** Hooks write one small file per agent
event to a spool: paths and ids, never transcript text. The capture folder (`~/.local/state/seshi`,
`%LOCALAPPDATA%\seshi` on Windows) is readable only by its user. Credentials from `seshi login`
go in the OS keychain, or a mode-0600 `credentials.json` where there is none, and never in
environment variables. Before each upload the uploader redacts with the server's rule packs and
the built-in pack, so nothing a rule knows leaves the machine; the server does not trust that
and redacts again. Each session has a random retraction secret that stays on the machine (only
its hash is sent), so a leaked device token or org key cannot delete anyone's sessions.

**Serverless mode puts a bucket key on every laptop.** A person or a team can skip the server
(`seshi init --serverless`, [docs/serverless.md](docs/serverless.md)). The pipeline, redaction
and model review included, then runs in each CLI, and each machine holds a bucket credential:
the bucket's permissions are the only roles. Redaction and review are trusted to the laptops,
and "visible only to its owner" is kept by the CLI, not enforced, unless the keys are limited
to each owner's folder. A team that needs redaction a laptop cannot skip, enforced owner-only
sessions, or company sign-in should run a server.

**Sources hold credentials of their own.** A Datadog source's API and application keys are
sent only to `https://api.<site>` (or an `https` `api_url`), and redirects are never followed.
An S3 source needs only `s3:ListBucket` and `s3:GetObject` on its prefix, and may not point at
seshi's own bucket. An OTLP destination writes with a service token of its own, which can write
only as that source's service account. Keys in `seshi.toml` can be secret references (`{ env =
… }`, `{ file = … }`), and `seshi config check` warns about a literal secret in a file others can
read.

**The search index holds session text.** Each API instance keeps an SQLite index of redacted
session text on local disk (`search.path`), created readable by its owner only. Treat it like
the bucket; deleting it costs only a rebuild.

**Tombstones delete objects, not history.** `DELETE /v1/sessions/…` removes the trace
objects (no raw transcript is stored) and appends a tombstone to the change feed; a reader that already copied the trace
still has it. Object versioning or replication on the bucket, if enabled, keeps the deleted
bytes under the bucket's own retention rules.
