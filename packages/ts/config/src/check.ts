/** `seshi config check`'s own findings about a server config that loaded: settings that are
 * valid but do less than they say, and where data is sent. */

import type { ServerConfig } from "./server/index";

export interface CheckReport {
  /** Valid, but probably not what was meant. */
  warnings: string[];
  /** Worth knowing: every provider a review policy sends envelopes to (F3.5). */
  notices: string[];
}

export function checkServerConfig(config: ServerConfig): CheckReport {
  const warnings: string[] = [];
  const notices: string[] = [];

  // The org key reads org-wide, so `owner` keeps nothing from anyone holding it (X5.10,
  // X5.12): without an IdP that is every member; mixed with one, every member still on the key.
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

  // Today's trace format needs a user record and a reply, so these cannot let more through yet.
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

  for (const policy of config.review.policies) {
    const steps = [
      ["decision", policy.decision],
      ["redactor", policy.redactor],
    ] as const;
    for (const [step, model] of steps) {
      if (!model) continue;
      const where = model.base_url ? ` at ${model.base_url}` : "";
      notices.push(
        `review policy '${policy.id}' sends envelopes to ${model.provider}${where} (${step}: ${model.model})`,
      );
      if (
        model.api_key === undefined &&
        model.provider !== "bedrock" &&
        model.provider !== "vertex"
      ) {
        warnings.push(
          `review policy '${policy.id}' ${step} has no api_key: ${model.provider} will refuse its calls`,
        );
      }
    }
  }

  for (const source of config.sources) {
    if (!source.enabled) notices.push(`source '${source.id}' is disabled`);
  }
  return { warnings, notices };
}
