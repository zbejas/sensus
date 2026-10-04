/**
 * Memory safety scans (docs/memory.md). Load-bearing, not nice-to-have:
 *
 *   - `containsSecret`/`redactSecrets` keep API keys, tokens and private keys
 *     out of a store the model both reads and writes (and out of `host_scan`
 *     output).
 *   - `containsInjection` blocks prompt-injection/exfiltration phrasing and
 *     invisible-Unicode smuggling, because memory text is injected into the
 *     system prompt.
 *
 * Heuristic by design — documented residual risk in docs/memory.md.
 * Pure + unit-tested.
 */

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/, // OpenAI-style
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}\b/, // Google API key
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, // JWT
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9_+/=-]{16,}/i,
]

const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore (?:all )?(?:previous|prior|above|earlier) instructions/i,
  /disregard (?:all )?(?:previous|prior|the) (?:instructions|prompt|rules)/i,
  /(?:reveal|print|show|repeat|expose|dump) (?:your )?(?:system )?(?:prompt|instructions|rules)/i,
  /<\/?(?:system|assistant|user)>/i,
  /\b(?:new|updated|override) (?:system )?(?:instructions|prompt|rules)\b/i,
]

/** Zero-width + bidi-control code points used to hide injected text. */
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text))
}

/** Replace secret-looking spans with `[redacted]` (host_scan output, logs). */
export function redactSecrets(text: string): string {
  let out = text
  for (const re of SECRET_PATTERNS) out = out.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`), "[redacted]")
  return out
}

export function containsInjection(text: string): boolean {
  INVISIBLE_RE.lastIndex = 0
  if (INVISIBLE_RE.test(text)) return true
  return INJECTION_PATTERNS.some((re) => re.test(text))
}

/** Replace invisible/bidi-control code points so stored text is auditable. */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_RE, "")
}
