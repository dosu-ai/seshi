import { resolveSteps, type ServerConfig } from "./server/index";

export interface CheckReport {
  warnings: string[];
  notices: string[];
}

export function checkServerConfig(config: ServerConfig): CheckReport {
  const warnings: string[] = [];
  const notices: string[] = [];

  if (config.auth.org_key.enabled) {
    const owners = [
      ...(config.default_visibility === "owner" ? ["default_visibility"] : []),
      ...config.sources
        .filter((s) => s.visibility === "owner")
        .map((s) => `sources[${s.id}].visibility`),
    ];
    if (owners.length > 0) {
      warnings.push(
        config.auth.oidc === undefined
          ? `${owners.join(", ")} = "owner" is not enforced without an IdP: the org key reads every session (X5.10)`
          : `${owners.join(", ")} = "owner" is not enforced against org-key holders: they can state any username; set auth.org_key.enabled = false once everyone signs in (X5.10, X5.12)`,
      );
    }
  }

  const relaxed = [
    ...(["require_user", "require_reply"] as const)
      .filter((rule) => config.filter[rule] === false)
      .map((rule) => `filter.${rule}`),
    ...config.sources.flatMap((s) =>
      (["require_user", "require_reply"] as const)
        .filter((rule) => s.filter?.[rule] === false)
        .map((rule) => `sources[${s.id}].filter.${rule}`),
    ),
  ];
  if (relaxed.length > 0) {
    warnings.push(
      `${relaxed.join(", ")} = false has no effect yet: a session without a user record or a reply cannot be stored as a trace`,
    );
  }

  if (config.server.public_url !== undefined) {
    warnings.push(
      "server.public_url has no effect: nothing in seshi reads it (sign-in goes from the CLI to the IdP directly)",
    );
  }

  if (config.search.backend === "lance" && config.search.path !== undefined) {
    warnings.push(
      'search.path is not read with search.backend = "lance": the index is in object storage (search.lance.uri)',
    );
  }

  for (const policy of config.review.policies) {
    const steps = resolveSteps(policy);
    for (const step of ["decision", "redactor"] as const) {
      const model = steps[step];
      const where = model.base_url ? ` at ${model.base_url}` : "";
      notices.push(
        `review policy '${policy.id}' sends envelopes to ${model.provider}${where} (${step}: ${model.model})`,
      );
    }
  }

  for (const source of config.sources) {
    if (!source.enabled) notices.push(`source '${source.id}' is disabled`);
  }
  return { warnings, notices };
}
