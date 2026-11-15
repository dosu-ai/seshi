# 05 · Identity and access (X5)

Branch `seshi-05-auth`, on `seshi-04-pipeline`. Every call now carries a credential from the X5
table, which `@seshi/auth` turns into a principal with a role and scopes. Owner IDs come from
identity (X5.8), sessions have a visibility the reads enforce (X5.10), and the pipeline's
authorize stage holds every write to its caller's own sessions. The shared HS256 secret is gone
(X5.2).

## What was built

- **`@seshi/auth`** (layer 2; depends on model, store, config and `jose` 6.2.14). Everything
  hangs off an `Auth` built from `AuthSettings` and a store (X1.2):
  - `scopes.ts`: the six scopes, the three roles, `CREDENTIAL_SCOPES` per credential, and
    `serviceScopesValid` (read or write, never both).
  - `owner.ts`: `ownerId` (a value that is not a valid id becomes `h-<20 hex of sha256>`),
    `usernameOwner` (org key: lowercased), `claimOwner` (IdP `owner_claim`; an email is
    lowercased), `serviceOwner` / `serviceIdentity` (`svc:<source-id>`), and `OwnerAliases`
    (`canonical`, `same`, `storedAs`; circles and bad ids refused).
  - `opaque.ts`: tokens are `seshi_<20 hex id>_<43 base64url secret>`. Only `sha256:<hex>` of the
    whole token is stored. Comparisons are constant time.
  - `tokens.ts` `TokenService`: `issue` (If-None-Match), `verify` (hash, revoked, expiry),
    a 30 s in-memory record cache (bounded at 10k entries, negative entries included), `list`,
    `revoke` (If-Match), `revokeOwner`.
  - `session-token.ts` `SessionTokens`: HS256 JWTs signed with `[auth.session_keys]`, `kid` in
    the header, 1 h, `iss: seshi`, `aud: seshi:<deployment_id>`. Old keys verify until removed.
  - `oidc.ts` `OidcVerifier`: discovery document, then jose's remote JWKS (or a given key set).
    It checks the signature (asymmetric algorithms only), issuer, audience, expiry (60 s skew)
    and the nonce.
  - `access.ts`: `canRead`, `requireScope`, `requireDelete` (session tokens must be under
    10 minutes old), `requireVisibilityChange`.
  - `authorizer.ts` `ownershipAuthorizer()`: the pipeline's stage 1 (see below).
  - `claims.ts`: `pickClaims` (the allowlist: email, name, username, git_email, git_name,
    account_ids, all bounded) and `idTokenClaims`.
  - `settings.ts` `authSettings(config)`: reveals secrets and checks static tokens, session keys
    and aliases.
  - `auth.ts` `Auth`: `authenticate(bearer, X-Seshi-User)`, `exchange`, `issue`, `modes`,
    `initAdmin`.
  - `@seshi/auth/testing` `FakeIdp`: an RS256 key pair, its JWKS, a discovery `fetch`, and
    `idToken()`. Tests use it; nothing calls a real IdP.
- **Credentials.**

  | Credential | Principal |
  |---|---|
  | Static token | `static`, verified, member, everything for its owner |
  | Org key + `X-Seshi-User` | `person`, `claimed`, member; write, read, search |
  | Session token | `person` or `admin`, verified; member: read, search, delete; admin: all |
  | Device token | `device`, verified, write only, 90 days |
  | Admin token | `admin`, all scopes |
  | Service token | `service`, `svc:<name>`; read and search, or write |

  `credential_id` is the record id, the session token's `jti`, or `static-<16 hex of
  sha256(token)>`.
- **Exchange (X5.2).** `POST /v1/auth/exchange {id_token, nonce?, machine?, visibility?}`
  returns a session token. With `machine` it also returns a device token; earlier device tokens
  for the same owner and machine are revoked. Admin comes from `admin_group` in `groups_claim`,
  or from a verified email on `admins` (X5.3). With `owner_claim = "email"`, an ID token whose
  email the IdP marks `email_verified: false` is refused (401): it could be anyone's address.
  `GET /v1/auth/config` returns `org_key`, `oidc`
  (issuer, client id, audience, scopes) and the token lifetimes.
- **Pipeline seam.**
  - `Authorization` and `Authorizer` moved to `@seshi/model` (`authz.ts`), so auth can implement
    them on the same layer. `@seshi/pipeline` re-exports them.
  - `ownershipAuthorizer`:
    - a service account writes only as itself;
    - a poller (not upload or hook) writes only as `svc:<its source_id>`;
    - `svc:` owners always have basis `service`, and only they do;
    - anyone else writes their own owner, unless an admin;
    - `claimed` belongs to `person` callers only.
  - A `claimed` caller (the org key) never writes to a session whose basis isn't `claimed`:
    no chunk, no extension, no replace (`Forbidden` in `Pipeline.planned`, before any plan).
    `mayReplace(auth, writer, basis)` holds the same rule for replaces.
  - `PipelineOptions.visibility` (`VisibilitySetting`) is the source and server fallback.
  - Change entries carry `owner_basis`.
  - `setVisibility()` writes a `visibility_changed` entry and refuses a redacted session.
  - `StoreSessionDB` takes `claims` and `visibility`. Credential claims win over upload claims.
- **HTTP** (`@seshi/api`). `createApp({ auth })`; without `auth`, an `Auth` with `tokens` as
  static tokens.
  - Scopes are checked per route. 401 means `Unauthorized`; 403 means `Forbidden`.
  - Reads take `?owner=`. `readable()` walks `aliases.storedAs(owner)` and answers 404 for a
    session the caller may not read.
  - `GET /v1/sessions` lists every alias folder (up to `limit` keys from each) and filters by
    `canRead`.
  - `GET /v1/changes` for another owner filters entries by each session's current visibility.
  - New routes:
    - `GET /v1/owners` (`listOwners` in `@seshi/store`);
    - `PATCH /v1/sessions/:agent/:session_id` (visibility);
    - `POST /v1/tokens`, `GET /v1/tokens`, `DELETE /v1/tokens/:id` and `POST /v1/tokens/revoke`,
      all needing `tokens:admin`.
  - Uploads take `claims`. A request's `visibility` beats the token's default, which beats the
    `visibility` option.
- **`seshi admin init`** (`apps/seshi/src/commands/admin.ts`, `COMMANDS.admin`). It loads the
  server config, opens the bucket, checks the marker (X1.4), then prints the first admin token
  and the org key, once each.
  - `--owner` (default `admin`).
  - `--force` makes another admin token.
  - `--rotate-org-key` revokes the live org keys and makes a new one.
  - A second plain run refuses.
- **`seshi serve`** builds `Auth` from `authSettings` after the marker, so it gets the
  deployment id and the configured source ids. It passes
  `visibility: (id) => visibilityFor(config, id)` and warns when no token can call the server.
- **Store.**
  - Owner ids now allow `@` and `+`, or `svc:<source-id>` (`isOwner`).
  - `listOwners` costs one list call per owner.
  - `TokenRecord` has a typed `kind` (`TokenKind`), `label`, `created_by`, `machine` and
    `claims`.
- **Config.**
  - `legacy_token_secret` removed.
  - `oidc.groups_claim` added (default `groups`).
  - `auth.oidc` needs a key in `session_keys` (schema refinement).
  - `visibilityFor(config, sourceId)` added.
- **Client.** `HttpClientOptions.user` sends `X-Seshi-User`. `ListSessionsOptions.owner` added.
- **Redaction.** The built-ins redact `seshi_…` tokens as `seshi-token`. Before, a bare token in
  prose passed the entropy pass. `BUILTIN_RULES_VERSION` is now `seshi/rules/2`.
- **Contract and docs.**
  - Schemas:
    - common: `legacy` dropped from `CallerKind`;
    - change: optional `owner_basis`.
  - New conformance example `change.visibility.json`. `openapi.yaml` covers every new route and
    status, and the openapi test exercises each.
  - Docs updated: layout.md, server.md (setup, credential table, who sees what), config.md,
    README, SECURITY, `.env.example` and `seshi.example.toml`.

## Extension points for later branches

- **Authenticate:** `auth.authenticate(bearer, userHeader)` returns a `Principal`. Then
  `requireScope(p, "search")` (12), `canRead(p, metadata, auth.aliases)` and
  `seesEverything(p)`. Search (12) must filter hits with `canRead` and fold old ids in with
  `auth.aliases.storedAs`.
- **Pollers and OTLP (09, 10, 11):** spread `serviceIdentity(sourceId)` into the envelope
  (`caller`, `owner`, `owner_basis`). `ownershipAuthorizer` refuses anything else for a non-upload
  source. Pass data claims through `pickClaims` (the pipeline does not filter envelope claims).
  Visibility comes from `visibilityFor(config, id)` through `PipelineOptions.visibility`.
  An OTLP destination's token is `POST /v1/tokens {kind: "service", service: <source id>,
  scopes: ["sessions:write"]}`. The source must be configured.
- **06 (Instance):** build one `Auth` per Instance with `new Auth(authSettings(config), { store,
  deployment, sources })`. Pass it to `createApp({ auth })`, and give the Pipeline
  `ownershipAuthorizer()`. `TokenService` caches per Auth.
- **13 (CLI):**
  - `seshi login` reads `GET /v1/auth/config`.
  - With an IdP: device flow or PKCE with `OIDC_SCOPES`, then `POST /v1/auth/exchange` with a
    nonce and `machine: {id}` (a stable random id the CLI keeps). The device token and the IdP
    refresh token go in `Bun.secrets`. Renew by exchanging again.
  - Without one: `--key` with the org key, and `HttpClientOptions.user` from SESHI_USER, CLI
    `user`, git email, then the OS user (X5.7).
  - `seshi tokens …` maps onto `/v1/tokens`.
  - The client still lacks `?owner=` on `getSession`, `getTrace` and `tombstone`, and has no
    `setVisibility`. Add them there.
- **14 (capture):** the uploader uses the device token or the org key plus user. An org-key
  machine gets 403 for any write to a session a verified writer started (the person moved to a
  device token mid-session); treat it as permanent for that session.
- **New scope users:** `sources:admin` exists and the admin role carries it, but no route checks
  it yet (06, 10, 11).
- **Tests:** `FakeIdp` from `@seshi/auth/testing`. Build an `Auth` with `oidcKeys: idp.keys`, or
  `fetch: idp.fetcher()` to exercise discovery.

## Deviations and why

1. **Nonce:** checked when either side has one. The device flow (X5.7) has no nonce, so an ID
   token without one is accepted when the request sends none.
2. **"First sign-in from a machine"** is when the CLI sends `machine`. The server can't tell a
   machine whose keychain was wiped from a new one. A `machine` exchange always issues a device
   token and revokes earlier ones for that owner and machine, so it is also the renewal X5.9
   describes.
3. **Session tokens use HS256** with server-held keys. They are not asymmetric: nothing else
   verifies them, and X5.9 asks only for a key id for rotation. The audience names the
   deployment (X1.4).
4. **`auth.oidc` without `session_keys` fails config validation.** The alternative, an
   ephemeral key, would break tokens across restarts and instances.
5. **Admins by email** need an email the IdP does not mark `email_verified: false`. Entra sends
   no such claim; use `admin_group` there.
6. **The org key's record owner is `*`.** It has no owner; its caller states one. `revokeOwner`
   never touches it. Rotation is `seshi admin init --rotate-org-key` or the token API.
7. **Org-key callers and owner visibility.** The normal read rules apply to the stated
   username. That is equivalent, since anyone can claim the owner, and other people's private
   sessions stay out of listings.
8. **The org key can't touch a verified session.** X5.12 says the key cannot replace other
   people's sessions. A `claimed` caller never writes to (extends, chunks or replaces) a
   session whose `owner_basis` is not `claimed`, so a session marked `verified` holds only what
   verified writers sent. Org-key sessions under one username stay writable by any org-key
   holder stating it: trust mode can't do better.
9. **Static tokens are members with every session scope, not admins.** They can't manage
   tokens; `seshi admin init` covers that.
10. **Visibility change needs `sessions:read` plus being the owner or an admin.** Device tokens
    can't change it. Org-key callers can change sessions whose basis is `claimed`, but not a
    verified one: in a mixed deployment, opening a person's `owner` session to the org would
    show it to members who hold no org key.
11. **No HS256 shared-secret tokens** (X5.2). `signed-token.ts` was removed; nothing in seshi
    needed it. Dosu's hosted setup mints such tokens (`SESSIONDB_TOKEN_SECRET`) and must move
    to the token API or service tokens before it runs a seshi image (open item).
12. **`HttpSessionDB` still throws `ServerError` for 401**, as before. `Unauthorized` is new in
    model but the client doesn't use it, to keep existing callers' `status` checks working.
13. **`GET /v1/changes` reads one owner folder.** Aliases fold folders into session reads and
    listings only. Feed consumers key on stored owners.
14. **Owner ids with `:`** (`svc:…`) don't fit a Windows folder store. The server targets S3, R2
    and Linux folders; local mode on Windows has no service accounts.
15. **Rule set bumped to `seshi/rules/2`** for the new `seshi-token` pattern. This changes
    `redaction.rule_set` for new writes; content hashes are unaffected.
16. **`config check` also warns in a mixed deployment.** With an IdP and the org key on,
    `owner` visibility is still not enforced against org-key holders, so the warning names
    that case too and goes away with `auth.org_key.enabled = false`.
17. **`POST /v1/tokens/revoke` takes an owner id only.** The org key's owner `*` is refused
    (400): the org key is rotated (`seshi admin init --rotate-org-key` or `DELETE
    /v1/tokens/:id`), not revoked by owner.

## Still to check

- The device flow with `openid email profile` on Okta, Entra and Google (X5.7 To check).
  Untested here: only the stand-in IdP.
- Token listing has no index. `revokeOwner`, the device renewal and `admin init` read every
  token record. That is fine for hundreds of tokens; revisit with an owner index if orgs grow
  large.
- The cache means a revocation reaches other instances within 30 s (X7.2 has one worker; API
  instances may be several).
- Change-entry keys collide in one millisecond: two tombstones or two visibility changes of one
  owner, or two sessions with identical content. This comes from 03's layout and is documented
  in layout.md now. A key with the archive id would fix it (layout change).
- `/v1/auth/exchange` and token verification have no rate limiting. Unknown token ids are
  negatively cached, but a flood of random ids still reads the bucket once each.
- `X-Seshi-User` must be ASCII (HTTP header). The CLI should refuse or transliterate a
  non-ASCII username.
- Nothing enforces `search` yet (12), and `sources:admin` has no route yet.
- An ID token with several audiences is accepted when one is ours; `azp` is not checked.
  Public CLI clients get a single audience from the IdPs in scope, so this is left as is.
- A service token that writes through `POST /v1/sessions` gets the `upload` source's
  visibility (`default_visibility`), not its source's own `visibility`: the envelope's
  `source_id` is `upload`. 09 (`/otlp/v1/traces`) should set the destination's source id.
