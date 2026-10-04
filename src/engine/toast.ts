/**
 * Toast notifications — pure logic (no Solid/opentui imports, unit-tested).
 *
 * Severity levels (info/success/warn/error) carry a theme token + glyph; the
 * store carries one toast at a time (newest wins, but a higher-severity toast
 * is never buried by a lower one within its TTL — see shouldPreemptToast).
 * Rendering is the floating
 * top-right panel in ui/ToastPanel.tsx (App mounts it last → topmost). UI
 * feedback that used to spam the chat transcript (agent/approval/model
 * switches, allow-prefix, theme, config reload) surfaces here instead
 * (docs/ui.md "Toasts").
 */

export type ToastLevel = "info" | "success" | "warn" | "error"

/** One toast: the store keeps the newest until its TTL expires. */
export interface Toast {
  id: number
  message: string
  level: ToastLevel
}

/** Per-level default TTL (ms): confirmations are snappy, problems linger. */
export function defaultTtl(level: ToastLevel): number {
  switch (level) {
    case "success":
      return 2000
    case "warn":
      return 4000
    case "error":
      return 5000
    default:
      return 2500
  }
}

/** Level glyph: color carries the level; the glyph keeps it scannable on
 * monochrome-ish palettes and for colorblind users. */
export function toastGlyph(level: ToastLevel): string {
  switch (level) {
    case "success":
      return "✓"
    case "warn":
      return "⚠"
    case "error":
      return "✗"
    default:
      return "·"
  }
}

/** Theme token per level (docs/config.md): info keeps the legacy toast hue. */
export function toastToken(level: ToastLevel): "toast" | "success" | "warning" | "danger" {
  switch (level) {
    case "success":
      return "success"
    case "warn":
      return "warning"
    case "error":
      return "danger"
    default:
      return "toast"
  }
}

/** Severity rank: a higher rank owns the single visible slot. */
export function toastSeverity(level: ToastLevel): number {
  switch (level) {
    case "error":
      return 3
    case "warn":
      return 2
    case "success":
      return 1
    default:
      return 0
  }
}

/**
 * Single-slot replacement policy (store.showToast). The newest toast normally
 * wins, but a live `error` must not be buried by a lower-severity one — a 5s
 * error can no longer be wiped by a 2s success (the original bug). Only `error`
 * is protected: `warn`/`info`/`success` all stay newest-wins, so a routine
 * confirmation is never silently swallowed by a lingering warning. A blocked
 * toast is DROPPED by the store (not queued): replaying it later would surface
 * a stale message after the fact.
 */
export function shouldPreemptToast(
  currentLevel: ToastLevel,
  currentExpiresAt: number,
  now: number,
  nextLevel: ToastLevel,
): boolean {
  if (now >= currentExpiresAt) return true
  const current = toastSeverity(currentLevel)
  // Only an error owns the slot; everything else yields to the newest toast.
  if (current < toastSeverity("error")) return true
  return toastSeverity(nextLevel) >= current
}

/** Floating-panel geometry: text columns cap, row cap, and the card chrome. */
export const TOAST_MAX_WIDTH = 60
export const TOAST_MAX_LINES = 4

/** Card inset: internal padding, and the drop from the screen's top-right. */
export const TOAST_PAD_X = 2
export const TOAST_PAD_Y = 1
export const TOAST_MARGIN_TOP = 2
export const TOAST_MARGIN_RIGHT = 2

/** The glyph + space every line reserves before its text. */
export const TOAST_GLYPH_COLS = 2
/** Text-independent card chrome: glyph column + horizontal padding. */
export const TOAST_CHROME_X = TOAST_GLYPH_COLS + TOAST_PAD_X * 2

/**
 * Wrap a toast message into display lines: word-wrap on spaces at `maxWidth`
 * codepoints (hard-splitting overlong words), honoring embedded \n as hard
 * breaks, capped at TOAST_MAX_LINES with an ellipsis when content was cut.
 * Pure.
 */
export function toastLines(message: string, maxWidth: number = TOAST_MAX_WIDTH): string[] {
  const w = Math.max(8, Math.floor(maxWidth))
  const out: string[] = []
  let truncated = false
  for (const raw of message.split("\n")) {
    if (out.length >= TOAST_MAX_LINES) {
      truncated = true
      break
    }
    if (raw.length === 0) {
      out.push("")
      continue
    }
    let line = ""
    for (const word of raw.split(/ +/)) {
      if (out.length >= TOAST_MAX_LINES) {
        truncated = true
        break
      }
      if ([...word].length > w) {
        // Overlong word: flush the line, then hard-split into w-char chunks.
        if (line.length > 0) {
          out.push(line)
          line = ""
        }
        const chars = [...word]
        for (let i = 0; i < chars.length; i += w) {
          if (out.length >= TOAST_MAX_LINES) {
            truncated = true
            break
          }
          const chunk = chars.slice(i, i + w).join("")
          if (i + w >= chars.length) line = chunk // tail keeps folding words
          else out.push(chunk)
        }
        continue
      }
      const candidate = line.length === 0 ? word : `${line} ${word}`
      if ([...candidate].length > w) {
        out.push(line)
        line = word
      } else {
        line = candidate
      }
    }
    if (out.length < TOAST_MAX_LINES) out.push(line)
  }
  while (out.length > 1 && (out.at(-1) ?? "").length === 0) out.pop() // trailing blanks
  if (out.length === 0) return [""]
  if (truncated && out.length === TOAST_MAX_LINES) {
    const last = out[TOAST_MAX_LINES - 1] ?? ""
    out[TOAST_MAX_LINES - 1] = [...last].slice(0, Math.max(1, w - 1)).join("") + "…"
  }
  return out
}

/** Panel width: the widest line + the glyph column + box padding, clamped to
 * [10, maxWidth + chrome]. Border-box (Yoga), so `width` includes the padding. */
export function toastPanelWidth(lines: readonly string[], maxWidth: number = TOAST_MAX_WIDTH): number {
  const widest = lines.reduce((n, l) => Math.max(n, [...l].length), 0)
  const min = TOAST_CHROME_X + 4
  return Math.min(Math.max(widest + TOAST_CHROME_X, min), Math.max(min, Math.floor(maxWidth) + TOAST_CHROME_X))
}