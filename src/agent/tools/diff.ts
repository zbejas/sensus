import type { DiffLine } from "./types.ts"

// ---- Diff -------------------------------------------------------------------

/** Simple LCS line diff (inputs are capped, so memory stays bounded). */
export function diffLinesText(oldText: string, newText: string): DiffLine[] {
  const a = oldText === "" ? [] : oldText.split("\n")
  const b = newText === "" ? [] : newText.split("\n")
  if (a.length > 4000 || b.length > 4000) {
    return [{ kind: " ", text: `(large file: ${a.length} -> ${b.length} lines — not diffed)` }]
  }
  const n = a.length
  const m = b.length
  // dp[i][j] = LCS length of a[i..] vs b[j..]
  const dp: Uint32Array[] = []
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] as Uint32Array
    const below = dp[i + 1] as Uint32Array
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const row = dp[i] as Uint32Array
    if (a[i] === b[j]) {
      out.push({ kind: " ", text: a[i] ?? "" })
      i++
      j++
    } else if ((dp[i + 1]?.[j] ?? 0) >= (row[j + 1] ?? 0)) {
      out.push({ kind: "-", text: a[i] ?? "" })
      i++
    } else {
      out.push({ kind: "+", text: b[j] ?? "" })
      j++
    }
  }
  while (i < n) {
    out.push({ kind: "-", text: a[i] ?? "" })
    i++
  }
  while (j < m) {
    out.push({ kind: "+", text: b[j] ?? "" })
    j++
  }
  return out
}

/**
 * Compress a whole-file diff for card display: keep every +/- line with one
 * unchanged context line each side, collapse untouched runs, cap rows.
 */
export function compactDiff(lines: DiffLine[], maxRows = 24): DiffLine[] {
  const keep = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l && l.kind !== " ") {
      const lo = Math.max(0, i - 1)
      const hi = Math.min(lines.length - 1, i + 1)
      for (let k = lo; k <= hi; k++) keep.add(k)
    }
  }
  const idxs = [...keep].sort((a, b) => a - b)
  const out: DiffLine[] = []
  let last = -1
  for (const idx of idxs) {
    const l = lines[idx]
    if (!l) continue
    if (last >= 0 && idx > last + 1) {
      const gap = idx - last - 1
      out.push({ kind: " ", text: `… (${gap} unchanged line${gap === 1 ? "" : "s"})` })
    }
    out.push(l)
    last = idx
  }
  if (out.length > maxRows) {
    const kept = out.slice(0, maxRows)
    kept.push({ kind: " ", text: `… (${out.length - maxRows} more diff rows)` })
    return kept
  }
  return out
}
