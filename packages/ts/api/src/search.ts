import { labelPairs, type SearchRequest, type SearchSort } from "@seshi/model";
import { SearchQueryError } from "@seshi/search";

const STRINGS = ["q", "owner", "agent", "repo", "branch", "source", "since", "until", "cursor"];
const NUMBERS = ["limit", "matches"];
const KNOWN = new Set([...STRINGS, ...NUMBERS, "sort", "label"]);

export function searchRequestOf(url: URL): SearchRequest {
  const params = url.searchParams;
  for (const name of new Set(params.keys())) {
    if (!KNOWN.has(name)) throw new SearchQueryError(`unknown parameter ${name}`);
    if (name !== "label" && params.getAll(name).length > 1) {
      throw new SearchQueryError(`${name} is given twice`);
    }
  }
  const request: Record<string, unknown> = { q: params.get("q") ?? "" };
  for (const name of STRINGS) {
    const value = params.get(name);
    if (name !== "q" && value !== null && value !== "") request[name] = value;
  }
  for (const name of NUMBERS) {
    const value = params.get(name);
    if (value === null || value === "") continue;
    if (!/^\d+$/.test(value)) throw new SearchQueryError(`${name} must be a whole number`);
    request[name] = Number.parseInt(value, 10);
  }
  const labels = labelsOf(params.getAll("label"));
  if (labels) request.labels = labels;
  const sort = params.get("sort");
  if (sort !== null && sort !== "") request.sort = sort as SearchSort;
  return request as unknown as SearchRequest;
}

/** `label=key=value`, repeatable: a session must carry every one. */
export function labelsOf(given: readonly string[]): Record<string, string> | undefined {
  if (given.length === 0) return undefined;
  const parsed = labelPairs(given);
  if ("problem" in parsed) throw new SearchQueryError(`label: ${parsed.problem}`);
  return parsed.labels;
}
