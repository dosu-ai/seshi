# The team UI

`seshi serve` serves a web page for the team at `/ui/`: browse the sessions the server keeps,
search them, and read one session's thread, its stored records and what model review decided.
Open the server's address in a browser; `/` sends you to `/ui/`.

The page reads the HTTP API with the credential of the person signed in, like any other client,
so it shows exactly what that credential may read ([server.md](server.md#who-sees-what)): your
own sessions and every `org` session, or everything for an admin. It never writes: no
visibility changes, no deletes, no token management. For "did my capture work?" on a laptop,
use `seshi explore` instead ([capture.md](capture.md#exploring-sessions-in-a-browser)).

## Turning it on and off

It is on by default on every instance with the `api` role. `server.ui = false` (or
`SESHI_SERVER__UI=false`) turns it off; a restart applies the change. An instance without the
`api` role never serves it. The page ships inside the binary, so the container image and a proxy
in front of the server (Caddy, nginx, a load balancer) need nothing extra: send `/ui/` to the
server along with `/v1/`.

## Signing in

The sign-in screen offers what `GET /v1/auth/config` says the server takes:

- **Through the IdP**, when `[auth.oidc]` is set. The page runs the same sign-in the CLI does
  (Authorization Code with PKCE, as the public client `auth.oidc.client_id`) and trades the ID
  token for a one-hour session token at `POST /v1/auth/exchange`. When the session token runs
  out, the page asks you to sign in again. It never gets a refresh token or a device token.
- **With a seshi token**: an admin, service or static token, pasted in.
- **With the org key and a username**, when `auth.org_key.enabled`. Anyone with the org key can
  claim any username, so on such a server owner-only sessions are not private from other
  members.

The credential stays in the browser tab (`sessionStorage`), is sent only in the
`Authorization` header, and is gone when the tab closes. There are no cookies.

### Setting up the IdP

The browser talks to the IdP directly, so the IdP must allow it:

1. Add the page's address, `https://<your server>/ui/`, as a redirect URI of the client named
   by `auth.oidc.client_id` (the one `seshi login` uses). The page always sends that address,
   however it was opened.
2. Allow the server's origin (`https://<your server>`) to call the IdP's discovery document
   and token endpoint from a browser (CORS). Okta, Auth0, Keycloak and Microsoft Entra ID do
   this for a client registered as a single-page app; with Entra, add the redirect URI under
   the single-page application platform.
3. The token endpoint must be on the issuer's own origin, the only one the page's policy lets
   it call. An IdP whose token endpoint is elsewhere, or that needs a client secret for this
   exchange (Google), cannot sign people in here: use a seshi token, or the CLI.

## What it shows

**The list** is every session you may read, the most recently active first, from the search
index (`GET /v1/search` without words, [search.md](search.md#browsing)). Type words to search
what was said and done; each result shows its best matching records, and a click on one opens
the session at that record. Filter by owner, agent, repository, branch, model, label and how
recently it was active; a click on a value in a row filters by it. The address keeps the words
and filters, so a view can be bookmarked or shared.

When search is off (`search.enabled = false`), the index is still being built after a start,
or the credential lacks the `search` scope (a reader's service token with `sessions:read`
alone), the list falls back to one owner's sessions (`GET /v1/sessions`), yours unless you set
Owner, and the other filters do not apply.

**A session** opens on its thread: each event (prompt, answer, tool call, tool result) in
order, with long text folded. **Records** shows each stored record as JSON. **Reviews** shows
model review's decision for each write ([model-review.md](model-review.md)), with the audit
detail for admins. **Details** shows the session's stored metadata and downloads its traces.

## What it never shows

Everything on the page comes from the API, which serves only what the server stored, and the
server redacts before it stores: the redacted trace is the only copy it keeps
([server.md](server.md)). The page never reads a transcript from anywhere else. Redaction
markers (`[redacted:<rule>]`) are set apart so you can see where something was removed.

Transcripts are untrusted text. The page builds its DOM from text nodes only (no HTML parsing,
no links made from text), and its content security policy allows only its own script and
style, connections to the server and the IdP's origin, and no frames, plugins or inline code,
with Trusted Types required so the browser refuses any string handed to an HTML sink.
