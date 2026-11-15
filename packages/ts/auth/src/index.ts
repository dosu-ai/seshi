/** `@seshi/auth`: credential verifiers. Today that is the HS256 signed token the server has
 * always accepted, kept as a legacy verifier until branch 05 builds seshi tokens, the org key
 * and the OIDC exchange (X5). Layer 2 (X3.2). */

export {
  MIN_SECRET_LENGTH,
  type SignedTokenClaims,
  signToken,
  verifyToken,
} from "./signed-token";
