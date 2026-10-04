/**
 * `shell_session` delivery acknowledgement (docs/agent.md "shell_session",
 * docs/terminal-layer.md "Pane state").
 *
 * `shell_session` used to return `ok:true` when bytes were WRITTEN to the pane,
 * not when the command ran — a delivery into a pane that had just redrawn or
 * gone idle could silently no-op. This module is the bounded, echo/prompt-
 * anchored check that a typed line actually landed on the shell's input line.
 *
 * Contract: pure and NEVER throws. Missing evidence is `"unverified"`, never a
 * hard failure (the same idiom as `responseGuard.ts`). The caller owns the
 * bounded poll; this module only classifies.
 */

export type DeliveryVerdict = "delivered" | "unverified"

export interface DeliveryEvidenceInput {
  /** Literal text typed ("" for a keys-only call). */
  text: string
  /** Sanitized pane tail BEFORE typing. */
  before: readonly string[]
  /** Sanitized pane tail AFTER typing. */
  after: readonly string[]
  /** Whether a submit key (Enter) was sent. */
  submitted: boolean
}

/** Normalize a line for substring comparison (collapse runs of whitespace). */
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/** Whitespace-collapsed pane text, so wrapped/tabbed echoes still match. */
function normalizedText(lines: readonly string[]): string {
  if (!Array.isArray(lines)) return ""
  return lines.map((l) => normalize(typeof l === "string" ? l : "")).join("\n")
}

/**
 * Positive delivery evidence: the typed text appears on the pane AFTER typing
 * (echo/anchor) and the pane changed from before. A keys-only call has no text
 * to anchor on, so any observable screen change counts. Never throws.
 */
export function verifyPaneDelivery(input: DeliveryEvidenceInput): DeliveryVerdict {
  try {
    const beforeText = normalizedText(input.before)
    const afterText = normalizedText(input.after)
    const changed = beforeText.length === 0 ? afterText.length > 0 : beforeText !== afterText
    const probe = normalize(input.text)
    if (probe.length === 0) {
      // No literal text to anchor on (keys-only): a screen change is the only
      // evidence available.
      return changed && afterText.length > 0 ? "delivered" : "unverified"
    }
    const needle = probe.length > 60 ? probe.slice(0, 60) : probe
    const anchored = afterText.includes(needle)
    return anchored && changed ? "delivered" : "unverified"
  } catch {
    return "unverified"
  }
}
