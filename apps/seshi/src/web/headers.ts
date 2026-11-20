/** The headers every seshi page answers with. The policy allows only the page's own files:
 * no inline script or style, nothing remote, no frames, no plugins. `connect` adds origins the
 * page may call besides its own (the IdP, for the team UI's sign-in). `trustedTypes` makes the
 * browser refuse any string handed to an HTML or script sink, which the pages never use. */
export function contentSecurityPolicy(
  options: { connect?: readonly string[]; trustedTypes?: boolean } = {},
): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    ["connect-src 'self'", ...(options.connect ?? [])].join(" "),
    "font-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    ...(options.trustedTypes ? ["require-trusted-types-for 'script'", "trusted-types 'none'"] : []),
  ].join("; ");
}

export function securityHeaders(csp: string): Record<string, string> {
  return {
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
  };
}
