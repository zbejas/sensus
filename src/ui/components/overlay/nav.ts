/**
 * Picker/overlay navigation resolver (M12 phase 0.4): the ONE place the
 * command menu, model picker and agent picker decide how a key moves the
 * highlighted row. Pure + unit-tested so the three overlays cannot drift.
 *
 * Rules (shared across the pickers):
 *   - ctrl/meta are ignored (the modifiers do not change the intent); `shift`
 *     only matters for the vim `G` spelling.
 *   - `up`/`down` step ±1; `pageup`/`pagedown` step ±pageSize;
 *     `home`/`end` jump to the first/last row.
 *   - while `vim` is true (the caller passes `vim = filter === ""`):
 *     `k`/`j` step ±1, plain `g` jumps to the first row, `G` (name "G" or
 *     name "g" with shift) jumps to the last. While `vim` is false these are
 *     ordinary printable filter characters and return null.
 *   - `wrap` wraps around modulo `count`; otherwise the result clamps to
 *     [0, count-1]. An empty list (count 0) resolves to 0 for a navigation key.
 *
 * Returns the next index, or null when the key is not a navigation key.
 */

export interface OverlayNavKey {
  name: string
  ctrl: boolean
  meta: boolean
  shift: boolean
}

export interface OverlayNavState {
  index: number
  count: number
  pageSize: number
  vim: boolean
  wrap: boolean
}

export function overlayNavStep(key: OverlayNavKey, s: OverlayNavState): number | null {
  // Modifier keys are ignored, not rejected: Ctrl+Down still means "down".
  const name = key.name

  let delta: number | null = null
  let absolute: number | null = null

  switch (name) {
    case "up":
      delta = -1
      break
    case "down":
      delta = 1
      break
    case "pageup":
      delta = -s.pageSize
      break
    case "pagedown":
      delta = s.pageSize
      break
    case "home":
      absolute = 0
      break
    case "end":
      absolute = s.count - 1
      break
    default:
      if (!s.vim) return null
      if (name === "k") delta = -1
      else if (name === "j") delta = 1
      else if (name === "g") absolute = key.shift ? s.count - 1 : 0
      else if (name === "G") absolute = s.count - 1
      else return null
  }

  if (s.count <= 0) return 0

  const next = absolute ?? s.index + (delta ?? 0)
  if (s.wrap) return ((next % s.count) + s.count) % s.count
  return Math.max(0, Math.min(next, s.count - 1))
}
