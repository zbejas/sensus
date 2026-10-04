/**
 * Subsequence/substring fuzzy scoring shared by filter-as-you-type UIs
 * (model catalog picker, command menu). Pure + unit-tested.
 */

/** Score for a query against a target; null = no match. Higher = better:
 * a substring hit ranks by position, a loose subsequence by length. */
export function fuzzyScore(query: string, target: string): number | null {
  if (query.length === 0) return 0
  const t = target.toLowerCase()
  const idx = t.indexOf(query)
  if (idx >= 0) return 1000 - Math.min(idx, 999)
  let ti = 0
  for (const ch of query) {
    const next = t.indexOf(ch, ti)
    if (next === -1) return null
    ti = next + 1
  }
  return 100 - Math.min(query.length, 99)
}

/**
 * Positions in `target` matched by `query`, case-insensitively — the same
 * match fuzzyScore ranks, but exposed so pickers can highlight the matched
 * characters. A whole substring hit (fuzzyScore's preferred match) returns
 * that contiguous run; otherwise the loose subsequence positions. null = no
 * match; `[]` for an empty query. Indices are UTF-16 offsets into `target`
 * (UI labels are effectively ASCII, so this is exact).
 */
export function matchIndices(query: string, target: string): number[] | null {
  if (query.length === 0) return []
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  const at = t.indexOf(q)
  if (at >= 0) return Array.from({ length: q.length }, (_, i) => at + i)
  const out: number[] = []
  let ti = 0
  for (const ch of q) {
    const next = t.indexOf(ch, ti)
    if (next === -1) return null
    out.push(next)
    ti = next + 1
  }
  return out
}

/** One run of `target` for rendering: matched chars vs. the rest. */
export interface MatchSegment {
  text: string
  match: boolean
}

/**
 * Split `target` into contiguous matched/unmatched runs for a highlighted
 * row render. A null match (or empty query) yields the whole string as one
 * unmatched run; an empty target yields no segments.
 */
export function matchSegments(query: string, target: string): MatchSegment[] {
  if (target.length === 0) return []
  const idx = matchIndices(query, target)
  if (idx === null || idx.length === 0) return [{ text: target, match: false }]
  const hit = new Set(idx)
  const out: MatchSegment[] = []
  let text = target[0] ?? ""
  let match = hit.has(0)
  for (let i = 1; i < target.length; i++) {
    const m = hit.has(i)
    if (m === match) {
      text += target[i]
    } else {
      out.push({ text, match })
      text = target[i] ?? ""
      match = m
    }
  }
  out.push({ text, match })
  return out
}