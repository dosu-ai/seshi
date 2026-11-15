/** `seshi config check`'s own findings about a server config that loaded: settings that are
 * valid but do less than they say, and where data is sent. */

import { resolveSteps, type ServerConfig } from "./server/index";

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

  // Sign-in is built without it: the CLI talks to the IdP itself (X5.7), so nothing reads it.
  if (config.server.public_url !== undefined) {
    warnings.push(
      "server.public_url has no effect: nothing in seshi reads it (sign-in goes from the CLI to the IdP directly)",
    );
  }

  // Every provider a policy sends envelopes to, as resolved: defaults and the redactor's
  // inheritance applied. A step without its key fails validation, so it needs no warning.
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
