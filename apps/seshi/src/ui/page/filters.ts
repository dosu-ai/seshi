/** The session list's state: the words searched for and the filters, kept in the page's
 * address (`#/?q=…&owner=…`) so a view can be shared and the back button works. */

export const TEXT_FILTERS = ["owner", "agent", "repo", "branch", "model"] as const;
export type TextFilter = (typeof TEXT_FILTERS)[number];

export const SINCE = { "1d": 1, "7d": 7, "30d": 30 } as const;
export type Since = keyof typeof SINCE;

export interface ListState {
  q: string;
  filters: Partial<Record<TextFilter, string>>;
  /** `key=value` labels a session must carry. */
  labels: string[];
  since?: Since;
}

export const EMPTY: ListState = { q: "", filters: {}, labels: [] };

const DAY_MS = 86_400_000;

export function parseState(query: URLSearchParams): ListState {
  const filters: ListState["filters"] = {};
  for (const name of TEXT_FILTERS) {
    const value = query.get(name)?.trim();
    if (value) filters[name] = value;
  }
  const since = query.get("since");
  return {
    q: query.get("q")?.trim() ?? "",
    filters,
    labels: query.getAll("label").filter((l) => /^[^=]+=.+$/.test(l)),
    ...(since !== null && since in SINCE ? { since: since as Since } : {}),
  };
}

/** The state as the page's own query string, without what is empty. */
export function stateQuery(state: ListState): URLSearchParams {
  const query = new URLSearchParams();
  if (state.q) query.set("q", state.q);
  for (const name of TEXT_FILTERS) {
    const value = state.filters[name];
    if (value) query.set(name, value);
  }
  for (const label of state.labels) query.append("label", label);
  if (state.since) query.set("since", state.since);
  return query;
}

/** The `GET /v1/search` query for the state: with no words it is a browse (newest first). */
export function searchQuery(
  state: ListState,
  options: { now: Date; limit: number; cursor?: string },
): URLSearchParams {
  const query = new URLSearchParams();
  if (state.q) {
    query.set("q", state.q);
    query.set("matches", "3");
  }
  for (const name of TEXT_FILTERS) {
    const value = state.filters[name];
    if (value) query.set(name, value);
  }
  for (const label of state.labels) query.append("label", label);
  if (state.since) {
    query.set("since", new Date(options.now.getTime() - SINCE[state.since] * DAY_MS).toISOString());
  }
  query.set("limit", String(options.limit));
  if (options.cursor) query.set("cursor", options.cursor);
  return query;
}

export function withFilter(state: ListState, name: TextFilter, value: string): ListState {
  return { ...state, filters: { ...state.filters, [name]: value } };
}

export function withLabel(state: ListState, label: string): ListState {
  return state.labels.includes(label) ? state : { ...state, labels: [...state.labels, label] };
}

export function isFiltered(state: ListState): boolean {
  return (
    state.q !== "" ||
    Object.keys(state.filters).length > 0 ||
    state.labels.length > 0 ||
    state.since !== undefined
  );
}
