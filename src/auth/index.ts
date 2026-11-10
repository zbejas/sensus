/**
 * Host-local auth/pairing surface. The cloud connector lives in the separate
 * Sensus Cloud repository and reads these files; this module never opens a
 * socket or talks to the cloud.
 */

export { runAuth } from "./cli.ts"
export type { AuthCliOptions, AuthIo } from "./cli.ts"
export {
  challengeSigningInput,
  encodePrivateKey,
  encodePublicKey,
  fingerprintFromPublicKey,
  generateIdentity,
  loadOrCreateIdentity,
  normalizeIdentity,
  readIdentity,
  signChallenge,
  verifyChallenge,
  writeIdentity,
} from "./identity.ts"
export type { HostIdentity, IdentityResult } from "./identity.ts"
export {
  defaultPolicy,
  isCwdAllowed,
  normalizeExistingPath,
  normalizePolicy,
  readPolicy,
  scopeSummary,
  updatePolicyScopes,
  writePolicy,
} from "./policy.ts"
export type { AuthPolicy, PolicyReadResult } from "./policy.ts"
export { DEFAULT_SCOPE, MAX_STREAMS, SCOPES, hasScope, isScope, normalizeScopeArray, parseScopeList } from "./scopes.ts"
export type { Scope } from "./scopes.ts"
export { authDir, authIdentityPath, authPolicyPath, authHomeFrom, isRoot, safeUid } from "./paths.ts"
