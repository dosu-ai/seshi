# Team UI

`seshi serve` serves a web page at `/ui/` (and redirects `/` there) on instances with the `api`
role. A person signs in with a seshi token, the org key and a username, or the server's IdP,
then browses every session they may read (most recently active first), searches them, and opens
one: its thread, stored records, reviews and metadata. It reads only the API, with that
person's credential, and never writes.

## Sub-features

- `ui-serve`: `/` redirects to `/ui/`; the page and its script answer 200 with a content security policy.
- `ui-signin`: the org key plus a username (or a token) signs in; a wrong one is refused on the page.
- `ui-list`: the list shows every readable session, most recently active first; owner-only sessions of others are absent.
- `ui-search`: words find sessions, with highlighted excerpts that open the session at that event.
- `ui-filter`: a click on a row's owner, agent, repository, model or label filters by it; the address keeps it.
- `ui-session`: the thread shows each event with redaction markers set apart; Records, Reviews and Details load.
- `ui-guard`: a POST to `/ui/` is 405; `server.ui = false` serves no page.

## How to get to it (user POV)

- Open the server's address in a browser (`http://127.0.0.1:<port>/`).
- Over HTTP: `curl -i http://127.0.0.1:<port>/ui/`.

## Driving it with control-seshi

Preconditions:

- A ready server-mode run (`$C up --server`) with sessions from two people. Capture one with
  `$C agent claude-code ui-1 --turns 6 --secret`. For other owners, `POST /v1/sessions` with
  the org key from `admin.json` and `X-Seshi-User: alice` (or `bob`), one of them with
  `"visibility": "owner"`. Each transcript needs about 2,000 characters to be stored.
- Wait for the index: `GET /v1/search` with the admin token answers the full `total`.

- **Serve.** Run `curl -si http://127.0.0.1:<port>/ | head -5`: `302`, `location: /ui/`. Run
  `curl -si http://127.0.0.1:<port>/ui/`: `200`, a `content-security-policy` with
  `require-trusted-types-for 'script'`, and a `/ui/chunk-*.js` script that also answers 200.
- **Sign in.** Open `http://127.0.0.1:<port>/` in the Browser pane. Fill "Token or org key"
  with the org key and "Username" with `alice`, then press "Sign in". The bar shows `alice`. A
  wrong key shows "The server does not accept that key and username."
- **List.** The list says "N sessions, most recent first" and holds alice's sessions, the
  `verifier` session and every `org` session. Sign out, sign in as `bob`: alice's owner-only
  session is not listed.
- **Search.** Type a word from a seeded prompt and press "Search". Each result shows excerpts
  with the word highlighted; a click opens the session with that event marked.
- **Filter.** Click a row's owner. The address gains `owner=<id>` and only that owner's
  sessions remain; "Clear all" drops it.
- **Session.** Open the `--secret` session. The thread shows `[redacted:…]` markers and none of
  the planted values (`AKIAIOSFODNN7EXAMPLE`, `hunter2secretvalue42`, `ghp_…`); check with
  the page text. Records, Reviews and Details each load; Details downloads the trace.
- **Guard.** `curl -si -X POST http://127.0.0.1:<port>/ui/`: `405`, `allow: GET, HEAD`.

Save a screenshot and a text snapshot of the list, a search and the session in the run's
evidence folder.

## Gotchas

- Search indexes in the background: right after an upload the list can be short. Poll
  `GET /v1/search` until `total` counts every session before you screenshot.
- The credential lives in the tab's `sessionStorage`, per origin: another port is another
  sign-in.
- Run from source, `seshi serve` builds the page once at start; restart it to see a page edit.
  `$C up --binary` exercises the page as the compiled binary carries it.
- IdP sign-in is not mapped: it needs an IdP that allows the page's origin. The PKCE flow and
  the exchange are covered by `tests/api/ui.test.ts`.
