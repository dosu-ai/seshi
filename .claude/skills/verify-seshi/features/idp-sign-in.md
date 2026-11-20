# IdP sign-in

With `[auth.oidc]` set, a person signs in to a seshi server through the org's identity provider
(`seshi login`, by the device flow or a browser). The server checks the IdP's ID token and hands
back a session token, good for an hour, plus a device token the uploader sends with. When the
session token runs out, the CLI renews it with the IdP's refresh token. When the IdP no longer
renews it (the person left, the session was revoked) or can't be reached, commands that need the
sign-in say why and ask the person to sign in again, while uploads keep going on the device
token.

## Sub-features

- `idp-login`: `seshi login --device` signs in through the IdP; `whoami` shows a person
  credential (an IdP sign-in) with `sessions:read`, owned by the email in the ID token.
- `idp-upload`: uploads after an IdP sign-in go out on the device token and are stored under
  that owner.
- `idp-renew`: an expired session token is renewed through the refresh token, once, unseen.
- `idp-refused`: when the IdP refuses renewal, commands that need the sign-in answer
  `not_signed_in` and name `seshi login`.
- `idp-relogin`: signing in again after a refusal brings those commands back.
- `idp-unreachable`: when the IdP is down, they answer `idp_unreachable`.

## How to get to it (user POV)

- Run `seshi login --server <url>` (a browser) or `seshi login --server <url> --device` (a code
  to enter on another device), then `seshi whoami`.
- Use seshi for an hour or more: any command that reads sessions (`sessions ls`, `search`,
  `share`) renews the sign-in on its own, or asks to sign in again.
- In the agents, capture uploads with the device token whatever the sign-in's state.

## Driving it with control-seshi

Preconditions:

- A run started with `$C up --idp` (server mode behind a stand-in IdP; see Gotchas for what it
  sets up), and `$C doctor` ending with `ready` and an `idp running at http://127.0.0.1:<port>`
  line. `up` has already signed in as `alice@acme.com` through the device flow.
- `URL` is the server `up` printed: `URL=http://127.0.0.1:<port>`.

- **Sign in.** Run `$C cli --name login -- login --server $URL --device`. Exit 0, and stdout
  says `Signed in to <url> as alice@acme.com (member, through the IdP)` and `Uploads use a device
  token that expires <date>`. `$C idp calls` shows discovery, `POST /device`, and
  `POST /token grant=…device_code -> 200` (the first sign-in, in `up`, also shows one
  `-> 400 authorization_pending` poll before it), then `GET /jwks (https) -> 200` once, when
  the server first checks an ID token.
- **Who.** Run `$C cli --name whoami -- whoami --json`. `identity.kind` is `person`,
  `identity.owner` is `alice@acme.com` with `owner_basis` `verified`, `identity.scopes` holds
  `sessions:read`, `identity.expires_at` is about an hour out, and `login.mode` is `oidc`.
- **Upload.** Run `$C agent claude-code idp-1 --turns 4`, then
  `$C cli --name ls -- sessions ls --json`. The daemon reports `uploaded` 1, and `idp-1` is
  listed with `owner` `alice@acme.com`.
- **Renew.** Run `$C idp expire` (stands in for the hour passing), then
  `$C cli --name ls-renewed -- sessions ls --json`. Exit 0 with `idp-1` listed, and
  `$C idp calls | grep -c 'grant=refresh_token -> 200'` is 1. `whoami` shows a new
  `expires` an hour out.
- **Refused.** Run `$C idp refuse`, then `$C idp expire`, then
  `$C cli --name ls-refused -- sessions ls --json`. Exit 5 with error code `not_signed_in`:
  "the IdP no longer renews the session for <url>: run seshi login --server <url>".
  `$C idp calls` ends with `POST /token grant=refresh_token -> 400 invalid_grant`. On a seshi
  where device tokens read their owner's own sessions (dosu-ai/seshi#66, after 0.23), the same
  command instead lists `idp-1` and warns on stderr that it fell back to the device token;
  record which of the two the run showed.
- **Uploads go on.** After the refusal, run `$C agent claude-code idp-2 --turns 4`. The daemon
  reports `uploaded` 1, `failed` 0: the uploader never needed the IdP.
- **Sign in again.** Run `$C cli --name relogin -- login --server $URL --device`, then
  `$C cli --name ls-relogin -- sessions ls --json`. Both exit 0, and `idp-1` and `idp-2` are
  listed: a new sign-in gets new refresh tokens, which the IdP honours.
- **Unreachable.** Run `$C stop idp`, then `$C idp expire` (a fresh session token needs no
  IdP), then `$C cli --name ls-idp-down -- sessions ls --json`. Exit 7 with error code
  `idp_unreachable`: "cannot reach the IdP at <issuer>". `$C doctor` now says
  `idp stopped by stop idp` and, with the sign-in expired, `NOT READY`.
- **Proof.** The `login`, `whoami`, `ls*` and `daemon-*` evidence files, plus `$C idp calls >
  .verify/seshi/$VERIFY_SESHI_RUN/idp-calls.log` saved before `down` (the run folder, and the
  IdP's log with it, goes at `down`).

## Gotchas

- What `up --idp` sets up: the repository's stand-in IdP (`IdpServer` in
  `tests/tooling/cli.ts`, run by `scripts/idp.ts`) on a free port, signing ID tokens with claims
  `email = alice@acme.com`, `email_verified = true`; `[auth.oidc]` with that issuer,
  `client_id = "seshi-cli"`, `owner_claim = "email"`; and `[auth.session_keys] k1` with a
  random key. The IdP's process is tracked like serve's: `stop idp` and `down` stop it.
- `seshi serve` takes the IdP's keys only from an https `jwks_uri` ("has no https jwks_uri"),
  and there is no setting to relax that. So the IdP serves its keys a second time over TLS with
  a self-signed certificate for 127.0.0.1 made in the run's `idp/` folder, discovery names that
  URL, and only the run's serve trusts it, through `NODE_EXTRA_CA_CERTS`. The private key is
  deleted as soon as the IdP has loaded it. Never point `NODE_EXTRA_CA_CERTS` at it outside the
  run.
- The stand-in answers the device flow's first poll with `authorization_pending` and every
  later one with tokens, so sign-ins need no browser; the `activate` URL `login` prints leads
  nowhere. The browser flow (`login --browser`) is not scripted.
- `idp expire` rewrites `session.expires_at` in the run's `logins.json`: it is the one hand edit
  in this recipe, standing in for an hour passing. The server's session token itself stays
  valid; the CLI decides to renew from that time.
- `idp refuse` makes the IdP forget every refresh token it has issued so far; tokens from a
  later sign-in work again. It can't be undone otherwise; sign in again.
- `doctor` fails a run whose IdP exited without `stop idp` (a crash); its log is the run's
  `logs/idp.log`.
- Stopping the IdP is for good in a run: a new one would have a new issuer and keys. `down`
  and start again.
- The org key still works on an `--idp` run (`admin.json` has it), but signing in with it
  replaces the IdP sign-in for that server.
