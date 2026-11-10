/**
 * Host-local pairing scopes. These are chosen on the Sensus host and read by
 * the separate cloud connector; the cloud can never write them.
 */

export const SCOPES = ["view", "chat", "control", "orchestrator"] as const
export type Scope = (typeof SCOPES)[number]

export const DEFAULT_SCOPE: Scope = "view"
export const MAX_STREAMS = 8

export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value)
}

/** Canonical, deduped scope list with the implied `view`. */
export function normalizeScopes(scopes: readonly Scope[]): Scope[] {
  const set = new Set<Scope>(scopes)
  if (set.size > 0) set.add("view")
  return SCOPES.filter((scope) => set.has(scope))
}

/** Parse one stored scope array; invalid entries are an error, not dropped. */
export function normalizeScopeArray(value: unknown): Scope[] | null {
  if (!Array.isArray(value)) return null
  const set = new Set<Scope>()
  for (const item of value) {
    if (!isScope(item)) return null
    set.add(item)
  }
  if (set.size > 0) set.add("view")
  return SCOPES.filter((scope) => set.has(scope))
}

export type ScopeParseResult = { ok: true; scopes: Scope[] } | { ok: false; error: string }

/** Parse `view,chat,control,orchestrator`; empty/missing means the safe default. */
export function parseScopeList(raw: string | readonly string[] | undefined | null): ScopeParseResult {
  if (raw === undefined || raw === null) return { ok: true, scopes: [DEFAULT_SCOPE] }
  const tokens = (typeof raw === "string" ? raw.split(",") : [...raw])
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0)
  if (tokens.length === 0) return { ok: true, scopes: [DEFAULT_SCOPE] }
  const set = new Set<Scope>()
  for (const token of tokens) {
    if (!isScope(token)) {
      return { ok: false, error: `unknown scope ${JSON.stringify(token)} (want ${SCOPES.join("|")})` }
    }
    set.add(token)
  }
  return { ok: true, scopes: normalizeScopes([...set]) }
}

/** True when the policy grants `scope` (an implied `view` counts). */
export function hasScope(scopes: readonly Scope[], scope: Scope): boolean {
  if (scope === "view") return scopes.length > 0
  return scopes.includes(scope)
}
