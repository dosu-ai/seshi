import type { Labels } from "./labels";
import type { EventRole } from "./schemas/trace";

/** How results are ordered: best match first (bm25 over the matching records, the default),
 * or the sessions most recently updated first. */
export type SearchSort = "relevance" | "recent";

export const SEARCH_SORTS: readonly SearchSort[] = ["relevance", "recent"];

/** A search (F10.1): keywords plus filters. Every filter narrows; none widens what the caller
 * may read, which the server decides (F10.4). */
export interface SearchRequest {
  /** The keywords, matched per record (a prompt, an answer, one tool call). Words must all
   * appear in one record (in any order); `"a phrase"` must appear as written;
   * `word*` matches words that start with it; `a OR b` matches either; `-word` excludes
   * records with it. Case and accents are ignored. Empty or left out, the search is a browse:
   * the filters alone, the most recently active sessions first, with no matches. */
  q?: string;
  /** Only this owner's sessions (`[auth.owner_aliases]` folded in). */
  owner?: string;
  /** Only sessions filed under this format or run by this agent (`origin_agent`). */
  agent?: string;
  /** Only sessions of this repository: the session's `repo` (its normalized remote), exactly
   * or as its last path segments (`widget` and `acme/widget` match `github.com/acme/widget`). A
   * session that has no `repo` (no remote) never matches. */
  repo?: string;
  branch?: string;
  /** Only sessions run by this harness: the meta record's `source` (`claude-code`, `cursor`). */
  harness?: string;
  /** Only sessions with this `agent_version`: the version of their harness they started on
   * (for Cursor, whose version comes from its hooks, the version at their latest upload). */
  agent_version?: string;
  /** Only sessions that used this model, among any they used. */
  model?: string;
  /** Only sessions carrying every one of these labels (`{ "dosu.project": "github.com/acme/app" }`):
   * keys and values exactly. `GET /v1/search` takes each as `label=key=value`. */
  labels?: Labels;
  /** Only sessions written through this source (`upload`, or a configured source id). */
  source?: string;
  /** Only records at or after this time (RFC 3339). Records without a timestamp use their
   * session's last update. */
  since?: string;
  /** Only records at or before this time (RFC 3339). */
  until?: string;
  sort?: SearchSort;
  /** Sessions per page: 1 to 100, 20 by default. */
  limit?: number;
  /** Matching records shown per session: 0 to 20, 3 by default. */
  matches?: number;
  /** The `cursor` of the previous page. */
  cursor?: string;
}

/** One matching record of a session: which trace and which of its events (`GET
 * /v1/sessions/{format}/{session_id}/trace?hash=` holds it at `events[event_index]`), and a short
 * excerpt around what matched. */
export interface SearchMatch {
  content_hash: string;
  event_index: number;
  role: EventRole;
  tool_name?: string;
  timestamp?: string;
  /** Up to a few dozen words of the record around the match; `…` marks text left out. */
  snippet: string;
  /** Where the matched words are in `snippet`: `[start, end)` offsets in UTF-16 code units, as
   * JavaScript strings count them. */
  highlights: [number, number][];
}

/** A session with records that match. */
export interface SearchResult {
  owner: string;
  /** The format the session is filed under. */
  format: string;
  session_id: string;
  archive_id: string;
  origin_agent?: string;
  native_session_id?: string;
  project?: string;
  branch?: string;
  /** The repository's normalized remote (`github.com/acme/app`). */
  repo?: string;
  /** What ran the session: its meta record's `source`. */
  harness?: string;
  agent_version?: string;
  /** Every model the session used. */
  models?: string[];
  labels?: Labels;
  source_id?: string;
  visibility: "org" | "owner";
  started_at?: string;
  ended_at?: string;
  updated_at: string;
  /** How well the session matched: higher is better, comparable within one answer only. */
  score: number;
  /** How many of its records matched. */
  hits: number;
  matches: SearchMatch[];
}

/** The index a search was answered from. */
export interface SearchIndexState {
  /** When the index first caught up with the change feed. */
  ready_at: string;
  /** When it last finished reading the change feed. */
  caught_up_at?: string;
  /** Sessions it holds. */
  sessions: number;
}

export interface SearchResults {
  query: string;
  /** Sessions that match, as the index holds them (the page may hold fewer: a session whose
   * owner or visibility changed since it was indexed is left out). */
  total: number;
  results: SearchResult[];
  /** Pass as `cursor` for the next page; absent on the last. */
  cursor?: string;
  index: SearchIndexState;
}
