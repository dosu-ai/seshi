# 29 · seshi explore

Branch `seshi-29-explore`, on `seshi-28-doctor` (dd0cd38). A local, read-only web page for
exploring and debugging captured sessions: the visual front end to 28's checks engine. User docs:
docs/cli.md (the `explore` row) and
[docs/capture.md](../../capture.md#exploring-sessions-in-a-browser).

Its job is to let a developer see that a session was captured right by putting the three views
side by side: the transcript on the laptop, the laptop's capture state (the decision and why,
offsets, a pause's stop, the spool, retries, the uploader's log), and what the server or the
local bucket stored (metadata, the trace chain, review decisions, change entries).

## What was built

- **`seshi explore [--port <n>] [--no-open] [--server <url>] [--since <duration>]`**
  (`apps/seshi/src/commands/explore.ts`, registered in the command registry, `--help` through
  `helpOrUsageError`). It opens the backend as `seshi doctor` does (`openBackend`, `purpose: "read"`),
  builds the doctor's `realDeps`, starts the server on 127.0.0.1 (port 0 unless `--port`), prints
  `seshi explore: http://127.0.0.1:<port>/?token=<token>`, opens it with the terminal's existing
  `openUrl` (http(s) only, `cli/terminal.ts`) unless `--no-open`, and runs until SIGINT or SIGTERM
  (exit 0). Not being signed in or a server that cannot be reached is not an error: the page shows
  where stored sessions could not be read from, and the local views still work. `startExplore`
  (exported, also as `seshi/explore`) is everything but the browser and the signals; the tests call
  it.
- **The server, `apps/seshi/src/explore/`:**
  - `server.ts`: `startExploreServer` / `exploreHandler`. The checks and headers below; routes:
    `GET /` (the page), `GET /<file>` (its files), and the API.
  - `api.ts`: `ExploreApi` over `DoctorDeps`. The list reads the state file and `decide` only, and
    queues every unchecked session for a background pass that runs `gatherEvidence` and
    `runChecks` one session at a time (newest first) and keeps only the worst status. Opening a
    session gathers its evidence (every trace fetched) and keeps the four most recent, so the
    records view pages through it without fetching again.
  - `records.ts`: `alignRecords` builds the records view (below); `page` slices it.
  - `timeline.ts`: every timed fact in the evidence, merged and sorted.
  - `assets.ts`: the page's files (below).
  - `types.ts`: the API's shapes, imported by both sides (type-only on the page).
- **The page, `apps/seshi/src/explore/page/`:** vanilla TypeScript (no framework, no new
  dependency), bundled by Bun from `index.html`: `app.ts` (token, hash router), `api.ts` (GET with
  the token header), `dom.ts` (a small `h()` builder that only makes text nodes), `list.ts`,
  `session.ts` (header, checks, pipeline strip, tabs), `records.ts`, `timeline.ts`, `raw.ts` (a
  JSON tree that builds a level when it is opened), `text.ts` (pure helpers), `style.css`
  (system font stack; brand tokens, deep teal on paper and mint on night ink by
  `prefers-color-scheme`; every status a word plus an icon). The favicon is the brand badge glyph.
  About 16 KB of script.

## The API

All `GET`, JSON, the token in the `X-Seshi-Token` header.

| Path | Answer |
|---|---|
| `/api/sessions[?refresh=1]` | `{ since, server: { mode, where?, error? }, sessions: [{ agent, session_id, folder, first_seen, last_seen, decision: { capture, glyph, level, reason }, last_status, worst, worst_check?, checked_at? }], pending, state_error? }`. `worst` is `pending` until the background pass reaches the session. `refresh=1` forgets what was checked and kept. |
| `/api/sessions/:agent/:id[?fresh=1]` | `{ evidence, checks, worst, glyph, timeline }`: the evidence as `seshi doctor --json` prints it (the stored records left out), the checks failures first. `fresh=1` gathers again. 404 for a session the state file does not hold. |
| `/api/sessions/:agent/:id/records?offset&limit&filter[&fresh=1]` | `{ pipeline, marks: { dropped_until?, frozen_at?, sent_until?, stub }, total, matching, offset, rows, states }`. `limit` up to 500 (default 100); `filter` is `all`, `mismatch` (differs, not stored, stored only), `redacted` (a marker or a withheld result), `local`, `stored`. |

**The records view.** Local: the transcript, whole, through `Redaction.transcript` (the
uploader's pre-redaction; identity in local mode) and the current adapter, then through
`Redaction.records` (the server's redaction stage with the local rules) before anything is kept;
a redaction shows as the marker the redactor writes, `[redacted:<rule>]`. Stored: each trace's
records placed by the chain, the first trace from 0 (or the dropped prefix's end), each
continuation from its `from_record`, a continuation's leading meta record as a repeat of record 0.
Each row is `same` or `differs` (canonical JSON), `stored-only`, or, with no stored record,
`dropped` (inside `dropped_prefix`), `frozen` (past the record a pause's offset falls at), `unsent`
(past the server's log end, found as the doctor's records check finds it), `missing` (sent but in
no trace) or `local` (nothing to compare: no server, filtered). The pipeline strip's counts come
with it: transcript bytes, sent bytes, the server's offset and a frozen offset; local records;
records with a marker, markers by rule and withheld results; records up to the server's offset,
the last answer and whether the session was kept back; stored records, traces, the dropped
prefix, a stub, withheld calls.

## The security model

Transcripts are sensitive, so:

1. **127.0.0.1 only.** `Bun.serve({ hostname: "127.0.0.1" })`; the port is random unless given.
2. **A token on every request.** 32 random bytes, base64url, new for each run. The page gets it
   once in the query string, takes it out of the address bar (`history.replaceState`, so it is not
   on screen when sharing, nor in history), keeps it in memory and sends it as `X-Seshi-Token` on
   API calls. The API takes it only from that header. The page's files take it in the query
   string: the served HTML links each local file with it, so the bundle's script, stylesheet and
   icon are gated too. Compared in constant time (`timingSafeEqual` over sha256 digests). 401
   without it.
3. **DNS rebinding.** A `Host` that is not `127.0.0.1:<port>` or `localhost:<port>` gets 403; so
   does an `Origin` that is not one of those.
4. **GET only** (405 with `Allow: GET`; HEAD included).
5. **Headers on every response:** `Content-Security-Policy: default-src 'self'; script-src 'self';
   style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'none'; object-src 'none';
   base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, `X-Content-Type-Options:
   nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`,
   COOP and CORP `same-origin`. No CORS headers. The page has no inline script or style and loads
   nothing remote (a test asserts it of the bundle); it builds every element from text nodes,
   never `innerHTML`.
6. **No secrets out.** The evidence is the doctor's, with the retraction secret replaced by its
   hash. The local transcript is shown only after local redaction (unredacted records are used
   only for counts and never leave the process). Stored records are shown as the server stored
   them. Only sessions the state file holds can be asked for.
7. **Read-only.** No uploads, state writes, spool entries or server writes: the doctor's loaders
   only read, and the end-to-end test checks the state file and spool are unchanged and that every
   request to the server was a GET.

## How the page is served

The page is an HTML import (`import("./page/index.html")` in `assets.ts`), so `bun build
--compile` bundles it into the binary. It is not handed to `Bun.serve`'s `routes` (a native
HTMLBundle route would bypass the token and Host checks and the headers): `loadAssets` reads the
bundle itself. In the compiled binary the import's `files` are the built files under
`/$bunfs/root/`, which the HTML links from `/`; run from source, the import names only the source
HTML, which is bundled once with `Bun.build({ target: "browser", publicPath: "/" })` into memory.
`development: false`, so no dev script is injected and the CSP can forbid inline script.

## Tests

- `apps/seshi/src/explore/explore.test.ts` (19, every loader faked; in the laptop selection):
  wrong Host 403 (three kinds), a foreign Origin 403, every method but GET 405, a missing or wrong
  token 401 on the page, a file and the API (and the API refusing a query-string token), the page
  with tokenized links under the CSP and without CORS headers, the token helpers; the list cheap
  (synchronous, no trace fetched) then checked in the background, `--since`; one session (no
  records in the evidence, checks failures first, the timeline sorted); the records view (pages,
  filters, markers with their rule, the pipeline's counts), a mismatch, a pause's stop, a stub with
  a dropped prefix, no server; a planted token and the retraction secret in no response of any
  endpoint; 404 and 400; the real server on 127.0.0.1 at a random port; the page's bundle (no
  inline script or style, nothing remote, no `innerHTML`); the helpers.
- `tests/capture/explore.test.ts` (5, end to end against a served Instance with the org key): a
  session captured in two chunks with a token planted in its transcript and a line not yet sent:
  the list (◉, then `ok` from the background pass), the detail (no failure), every records filter
  (every sent row `same`, the last `unsent` at `sent_until`, the marker on both sides), the page;
  the planted token and the retraction secret in no response; state and spool unchanged, no
  uploader started, only GETs. The server gone: the local views still answer. Local mode reads
  the bucket. Bad usage and `--help`. The command as a process (`bun apps/seshi/src/main.ts
  explore --no-open`): it prints its address, serves the page (401 without the token), and exits 0
  on SIGINT.
- **The compiled binary, by hand:** `bun run build`, then `dist/seshi explore --no-open` in an
  empty home printed `seshi explore: http://127.0.0.1:58761/?token=…`; `curl` of that address
  answered the page with the bundle's links carrying the token, the script answered 200
  (`text/javascript`, 16 050 bytes) and 401 without the token, `/api/sessions` answered with the
  header, and SIGINT stopped it. `bun run check:hook --binary dist/seshi`: the hook still 23 ms
  (the page is in a lazily loaded command). **`scripts/release/smoke.ts`** now runs the same steps
  (`smokeExplore`, after the upload step) and passed against that binary (`--keychain off`).
- Seen in a browser (the desktop app's pane) against a served Instance with a 408-record session:
  list, header, checks, pipeline, records paging to 408 rows, timeline and raw, light and dark,
  with no console errors (so no CSP violation).

## Deviations and why

1. **No Preact.** Vanilla TypeScript with a 40-line `h()` was enough for five screens, adds no
   dependency, and keeps every DOM write a text node by construction.
2. **The token leaves the address bar after load** (the brief says the page keeps it in memory).
   Reloading the page then needs the printed address again (the 401 page says so); the hash routes
   (`#/s/<agent>/<id>/<tab>`) are kept.
3. **The page's files take the token in the query string**, since the browser sends no custom
   header for `<script src>`; the served HTML adds it to each local link. The API never accepts it
   that way.
4. **`Origin` is checked as well as `Host`**, and HEAD is refused with the other methods.
5. **The local view normalizes the whole transcript** (so lines not yet sent show as `unsent`),
   and the records up to the server's offset and up to a pause's stop are counted by normalizing
   those prefixes again (three passes for a paused session). Records are compared by canonical
   JSON, so a row differs on any field.
6. **No DOM lib change.** The root tsconfig names no `lib`, so TypeScript's default for ES2023
   already includes the DOM for every file; making the rest of the repo DOM-free (setting `lib`)
   breaks existing tests that rely on DOM `fetch` types, which is outside this branch. Biome
   needed no change either.
7. **Vitest cannot load an HTML import** (Vite parses it as JS), so the in-process tests hand
   `startExplore` the page built with `buildAssets`; the process test and the compiled binary go
   through the HTML import itself.
8. **`.dockerignore` lets in `brand/glyph/seshi-glyph-badge.svg`**, the page's favicon, since
   the image compiles the binary from the docker-ignored context (`scripts/docker-context.test.ts`
   checks every input is there). The Docker build itself was not run.
9. **`forJson`** (28's `seshi doctor --json` shape) is reused for the detail; the records come from
   the records endpoint only.

## Still to check

- Not run against a real server, real agents or Windows; the page was looked at in one Chromium
  (the desktop app's pane), not Firefox or Safari. `color-mix()` needs a 2023 browser.
- **Whole-log normalization differs from chunked in one case seen while testing:** two assistant
  lines with the same timestamp, sent in different chunks, normalize to different `llm_call`
  fields than the whole log does, which fails the doctor's prefix check and shows `differs` here.
  The tests use distinct timestamps (as real transcripts have). Whether real Claude Code
  transcripts can split such lines across chunks was not checked; 28's note already flags the
  assumption.
- The background pass checks every session in the window once; a large `--since` over many big
  sessions takes as long as `seshi doctor --since` does. It does not re-check on its own (Refresh
  does).
- Stored records are shown as stored, so a secret the server stored unredacted (what the residue
  check fails on) is shown to the person at this machine; the residue check names the record.
- A divider for the end of the server's log is drawn only before a row, so it does not show when
  everything was sent.
- `--deep` (search) is not offered; the evidence has no search part here.
