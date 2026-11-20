/** Every API route the page calls, as `spec/openapi.yaml` names it. `ui.test.ts` checks each
 * against the spec, so a route the API drops or renames fails the build, not the page. */
export const ROUTES = {
  authConfig: "GET /v1/auth/config",
  exchange: "POST /v1/auth/exchange",
  me: "GET /v1/me",
  owners: "GET /v1/owners",
  sessions: "GET /v1/sessions",
  search: "GET /v1/search",
  session: "GET /v1/owners/{owner}/sessions/{archive_id}",
  trace: "GET /v1/owners/{owner}/sessions/{archive_id}/trace",
  export: "GET /v1/owners/{owner}/sessions/{archive_id}/export",
  reviews: "GET /v1/owners/{owner}/sessions/{archive_id}/reviews",
  adminSources: "GET /v1/admin/sources",
  adminJobs: "GET /v1/admin/jobs",
} as const;

export type RouteName = keyof typeof ROUTES;

/** A route's method and its path with `params` filled in (each one URL-encoded). */
export function resolve(
  name: RouteName,
  params: Record<string, string> = {},
): { method: string; path: string } {
  const [method, template] = ROUTES[name].split(" ") as [string, string];
  const path = template.replace(/\{([a-z_]+)\}/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error(`${name}: no value for {${key}}`);
    return encodeURIComponent(value);
  });
  return { method, path };
}
