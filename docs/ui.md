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
index (`GET /v1/search` without words, [search.md](search.md#browsing)). Each row leads with what
the person asked (the session's first prompt, without the blocks their agent's harness added),
then whose it is, the agent, repository and branch, and how long it ran with how many events,
tool calls and redactions.

Search runs as you type: the words find what was said and done (prompts, answers and tool
inputs; tool output too when the server indexes it, below), each result shows its best matching
records, and a click on one opens the session at that record. Filters can be typed in the same
box, as `repo:widget`, `owner:alice`, `agent:codex`, `branch:main`, `model:…`,
`label:team=web` or `since:7d` (quote a value with spaces: `branch:"fix x"`), or set under
Filters; a click on a value in a row filters by it too. `/` anywhere puts the cursor in the box.
The address keeps the words and filters, so a view can be bookmarked or shared.

To search what tools returned (test failures, command output, file contents), add
`tool_result` to `search.events` ([config.md](config.md#search-worker-capture)). The index grows, and is built
again once.

When search is off (`search.enabled = false`), the index is still being built after a start,
or the credential lacks the `search` scope (a reader's service token with `sessions:read`
alone), the list falls back to one owner's sessions (`GET /v1/sessions`), yours unless you set
Owner, and the other filters do not apply.

**A session** opens on its thread. Prompts and answers read as Markdown, built as text (no HTML
from a transcript, and links stay text). What the agent's harness put before a prompt
(AGENTS.md, environment context, command wrappers) is folded away. Each tool call and its result
are one step: the tool and a line saying what it did, with the input and the output closed until
opened. The find bar over the thread searches the whole session (`/` puts the cursor there):
each match draws its step if it is past "Show more", opens its input and output, and marks the
words; Enter and Shift+Enter move between matches, Escape clears them. Beside the thread, the
session at a glance: how long it ran, its prompts, answers and tool
calls, the tools it used, the files it touched, and the models and tokens its calls record.
**Records** shows each stored record as JSON. **Reviews** shows
model review's decision for each write ([model-review.md](model-review.md)), with the audit
detail for admins. **Details** shows the session's stored metadata and downloads its traces.

**The overview** is the team over the last 24 hours, 7 days or 30 days, laid out as an
engineering panel:

- **Metrics**: sessions, active people, tokens, tool calls, the tool error rate, the median
  session, events stored and the share of sessions redaction changed. Each has a sparkline over
  the span and its change against the span before (in points for a rate).
- **Activity**: sessions, people, tokens and tool errors per hour (24 hours) or per day, as
  small multiples on one time axis, each labelled with its total and its tallest bar.
- **Breakdown**: one table by agent, model, repository or person, with each one's
  sessions, tokens, tool calls, error rate and trend (a session that used several models counts
  toward its first). A name opens the list filtered to it.
- **Tools**, **Redaction** (matches and sessions by rule) and **Ingest health**: the capture
  delay from a session's last event to its stored copy (median and p95; a backfill counts from
  its upload), the share stored within 15 minutes, and when the search index caught up. For
  admins (`sources:admin`), ingest health adds each source's stored, filtered, failed and
  dropped writes, the worker, and its jobs' last runs.

Tokens are what each session's model calls record (Claude Code and Codex record them); the
tool error rate counts failed results over results whose outcome the agent records (Codex
records none). The overview reads the same browse as the list, so it counts only what you may
read, up to the 4,000 most recent sessions across the span and the one before it.

## What it never shows

Everything on the page comes from the API, which serves only what the server stored, and the
server redacts before it stores: the redacted trace is the only copy it keeps
([server.md](server.md)). The page never reads a transcript from anywhere else. Redaction
markers (`[redacted:<rule>]`) are set apart so you can see where something was removed.

Transcripts are untrusted text. The page builds its DOM from text nodes only (no HTML parsing,
no links made from text), and its content security policy allows only its own script and
style, connections to the server and the IdP's origin, and no frames, plugins or inline code,
with Trusted Types required so the browser refuses any string handed to an HTML sink.
