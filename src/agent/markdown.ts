/**
 * Terminal markdown renderer. Pure module — no opentui
 * imports — so it is unit-testable. Renders the subset used by chat replies:
 * headings, bold/italic, inline code, fenced code blocks (language label +
 * copy hint), bullet/ordered lists (2 levels), links shown as text, blockquote,
 * horizontal rules.
 *
 * Output is a list of LOGICAL lines; each line is a list of styled segments.
 * The UI wraps them to the sidebar width (wrapLines -> visual rows) and maps
 * style flags to terminal colours.
 *
 * Defensive contract: NEVER throws on odd input. Any parse surprise falls back
 * to rendering the raw text; unclosed fenced blocks are flushed at EOF.
 */

import { componentLogger } from "./log.ts"

const log = componentLogger("agent.markdown")

export interface SegStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  /** Inline or block code: accent colour. */
  code?: boolean
  /** Heading: bold + accent. */
  heading?: boolean
  /** Links (rendered as text; `href` makes them clickable OSC-8 hyperlinks). */
  link?: boolean
  /** Target URL for a link segment (OSC-8 hyperlink via the row renderer). */
  href?: string
  /** Dim text (quotes, hints, separators, markers). */
  dim?: boolean
  /** Error/fallback styling. */
  error?: boolean
  /** Accent colour (user labels, focused hints). */
  accent?: boolean
}

export interface Seg {
  text: string
  style: SegStyle
}

export interface MdLine {
  segs: Seg[]
  /** M3: when set, clicking this row pastes its OWN code line into the visible
   * pane (no-tools copy-paste behavior, docs/agent.md). A single click pastes
   * the line without Enter; a double click presses Enter (docs/ui.md
   * "Prose vs. code"). The whole-block send is the `send-code-block` key
   * action (Alt+S), not a row click. */
  copyLine?: string
}

export const plain = (text: string, style: SegStyle = {}): Seg => ({ text, style })

export const textLine = (text: string, style: SegStyle = {}): MdLine => ({ segs: [plain(text, style)] })

export const EMPTY_LINE: MdLine = { segs: [] }

/** Concatenate rendered blocks back to text (tests + diagnostics). */
export function mdText(lines: readonly MdLine[]): string {
  return lines.map((l) => l.segs.map((s) => s.text).join("")).join("\n")
}

const CODE_TICK = "`"

/** Public entry: block pass with a full defensive fallback. Never throws. */
export function renderMarkdown(src: unknown): MdLine[] {
  try {
    if (typeof src !== "string") return []
    return renderFenced(src)
  } catch (e) {
    log.debug("markdown render failed; falling back to raw text", { err: e })
    const s = typeof src === "string" ? src : ""
    return s.split("\n").map((l) => textLine(l, { error: true }))
  }
}

/** Split the source on fenced code blocks; inline-parse everything else. */
function renderFenced(src: string): MdLine[] {
  const out: MdLine[] = []
  const rawLines = src.split("\n")
  let i = 0
  while (i < rawLines.length) {
    const line = rawLines[i]
    if (line === undefined) break
    const fence = /^\s*(```+|~~~+)\s*([A-Za-z0-9_+#.-]*)\s*$/.exec(line)
    if (fence) {
      const marker = fence[1] ?? "```"
      const lang = (fence[2] ?? "").trim() || "text"
      i++
      const body: string[] = []
      while (i < rawLines.length) {
        const l = rawLines[i]
        if (l !== undefined && l.trimStart().startsWith(marker)) break
        body.push(l ?? "")
        i++
      }
      i++ // closing fence (or EOF — defensive flush)
      out.push(textLine(` ${lang} `, { dim: true }))
      for (const codeLine of body) {
        const l = textLine(codeLine.length === 0 ? " " : codeLine, { code: true })
        // Click payload is the row's own line, verbatim (a wrapped row still
        // carries its whole source line); blank lines are not clickable. A
        // trailing CR (CRLF content) would press Enter by itself — strip it.
        const command = codeLine.replace(/\r$/, "")
        if (command.trim().length > 0) l.copyLine = command
        out.push(l)
      }
      out.push(textLine(" ↳ click to paste · double-click to run", { dim: true }))
      continue
    }
    out.push(...renderInline(line))
    i++
  }
  return out
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const RULE_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/
const QUOTE_RE = /^>\s?(.*)$/
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/

function renderInline(line: string): MdLine[] {
  if (line === "") return [EMPTY_LINE]
  const heading = HEADING_RE.exec(line)
  if (heading) {
    const level = Math.min(heading[1]?.length ?? 1, 3)
    const marker = level === 1 ? "█ " : level === 2 ? "▌ " : "· "
    return [{ segs: [plain(marker + (heading[2] ?? ""), { heading: true })] }]
  }
  if (RULE_RE.test(line)) {
    return [textLine("─".repeat(Math.max(1, Math.min(line.replace(/\s/g, "").length, 40))), { dim: true })]
  }
  const quote = QUOTE_RE.exec(line)
  if (quote) {
    return [{ segs: [plain("│ ", { dim: true }), ...parseInline(quote[1] ?? "", [])] }]
  }
  const list = LIST_RE.exec(line)
  if (list) {
    const indent = Math.min(Math.floor(((list[1] ?? "").length) / 2), 2)
    const rawMarker = list[2] ?? "•"
    const marker = /^\d/.test(rawMarker) ? rawMarker : "•"
    const pad = indent > 0 ? " ".repeat(indent * 2) : ""
    return [{ segs: [plain(pad + marker + " ", { dim: true, bold: /^\d/.test(rawMarker) }), ...parseInline(list[3] ?? "", [])] }]
  }
  return [{ segs: parseInline(line, []) }]
}

/**
 * Inline tokenizer: `code`, **bold**, __bold__, *italic*, _italic_,
 * [text](url), ~~strike~~, backslash escapes. Iterative with explicit index
 * advance; unterminated delimiters stay literal. Never throws.
 */
export function parseInline(line: string, acc: Seg[] = []): Seg[] {
  let i = 0
  let buf = ""
  const flush = (): void => {
    if (buf.length > 0) {
      acc.push(plain(buf))
      buf = ""
    }
  }
  const push = (text: string, style: SegStyle): void => {
    flush()
    if (text.length > 0) acc.push(plain(text, style))
  }
  const tryDelim = (delim: string, style: SegStyle): boolean => {
    if (line.startsWith(delim, i)) {
      const close = line.indexOf(delim, i + delim.length)
      if (close === -1) return false
      push(line.slice(i + delim.length, close), style)
      i = close + delim.length
      return true
    }
    return false
  }
  while (i < line.length) {
    const ch = line[i] ?? ""
    if (ch === "\\" && i + 1 < line.length) {
      buf += line[i + 1] ?? ""
      i += 2
      continue
    }
    if (ch === CODE_TICK) {
      const close = line.indexOf(CODE_TICK, i + 1)
      if (close !== -1) {
        push(line.slice(i + 1, close), { code: true })
        i = close + 1
        continue
      }
      buf += ch
      i++
      continue
    }
    if (ch === "[" ) {
      const cb = line.indexOf("]", i)
      if (cb !== -1 && line[cb + 1] === "(") {
        const cp = line.indexOf(")", cb + 2)
        if (cp !== -1) {
          const label = line.slice(i + 1, cb)
          const url = line.slice(cb + 2, cp).trim()
          push(label, { link: true, href: url })
          if (url.length > 0) push(` (${url})`, { dim: true })
          i = cp + 1
          continue
        }
      }
      buf += ch
      i++
      continue
    }
    if (ch === "*") {
      if (line.startsWith("**", i)) {
        if (tryDelim("**", { bold: true })) continue
      } else if (tryDelim("*", { italic: true })) continue
      buf += ch
      i++
      continue
    }
    if (ch === "_") {
      const prev = line[i - 1] ?? ""
      const next = line[i + 1] ?? ""
      const wordy = (c: string): boolean => /[\p{L}\p{N}]/u.test(c)
      if (line.startsWith("__", i)) {
        if ((!prev || !wordy(prev) || !wordy(next)) && tryDelim("__", { bold: true })) continue
      } else if ((!prev || !wordy(prev)) && next && wordy(next) && tryDelim("_", { italic: true })) continue
      buf += ch
      i++
      continue
    }
    if (ch === "~" && line.startsWith("~~", i)) {
      if (tryDelim("~~", { dim: true })) continue
      buf += ch
      i++
      continue
    }
    buf += ch
    i++
  }
  flush()
  return acc
}

// ---- Link-only inline pass (ask_user questions) --------------------------

/** `[label](url)` or a bare http(s) URL. The markdown form comes first so a
 * link label containing a URL stays one token. */
const LINK_TOKEN_RE = /\[([^\]]*)\]\(\s*([^()\s]+)\s*\)|(https?:\/\/[^\s<>"']+)/g
/** Trailing punctuation that belongs to the sentence, not the URL. */
const URL_TRAIL_RE = /[.,;:!?]+$/

/**
 * Link-aware inline pass for the `ask_user` QUESTION row. Only `[label](url)`
 * and bare http(s) URLs are recognized; every other character stays verbatim,
 * so a shell glob in a question (`rm *.log`) is never reinterpreted as
 * markdown emphasis. Pure — never throws.
 */
export function linkifyLine(line: string): Seg[] {
  if (line === "") return []
  const segs: Seg[] = []
  let last = 0
  const re = new RegExp(LINK_TOKEN_RE.source, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++
      continue
    }
    if (m.index > last) segs.push(plain(line.slice(last, m.index)))
    if (m[1] !== undefined) {
      const url = m[2] ?? ""
      if (m[1].length > 0) segs.push(plain(m[1], { link: true, href: url }))
      if (url.length > 0) segs.push(plain(` (${url})`, { dim: true }))
    } else {
      const raw = m[3] ?? ""
      const trail = URL_TRAIL_RE.exec(raw)?.[0] ?? ""
      const url = trail.length > 0 ? raw.slice(0, raw.length - trail.length) : raw
      if (url.length > 0) segs.push(plain(url, { link: true, href: url }))
      if (trail.length > 0) segs.push(plain(trail))
    }
    last = m.index + m[0].length
  }
  if (last < line.length) segs.push(plain(line.slice(last)))
  return segs
}

/** `linkifyLine` per source line (a raw newline is a hard break, never
 * collapsed). Pure. */
export function linkifyLines(text: string): MdLine[] {
  return text.split("\n").map((l) => ({ segs: linkifyLine(l) }))
}

// ---- Word wrapping -------------------------------------------------------

interface Cell {
  ch: string
  st: SegStyle
}

/** Style of a whitespace run: follow the next non-space cell's style. */
function wordWrapOne(line: MdLine, width: number): MdLine[] {
  // Expand to per-char cells (code points; wide chars count as one col here —
  // the sidebar never renders CJK-heavy replies in practice).
  const cells: Cell[] = []
  for (const seg of line.segs) {
    for (const ch of [...seg.text]) cells.push({ ch, st: seg.style })
  }
  if (cells.length === 0) return [EMPTY_LINE]

  // Split into words; each word remembers the space run before it (leading
  // indentation attaches to the first word as its gap).
  interface Word {
    cells: Cell[]
    gap: number
  }
  const words: Word[] = []
  let curWord: Cell[] = []
  let pendingGap = 0
  for (const c of cells) {
    if (/\s/.test(c.ch)) {
      if (curWord.length > 0) {
        words.push({ cells: curWord, gap: pendingGap })
        curWord = []
        pendingGap = 0
      } else {
        pendingGap++
      }
    } else {
      curWord.push(c)
    }
  }
  if (curWord.length > 0) words.push({ cells: curWord, gap: pendingGap })
  if (words.length === 0) return [EMPTY_LINE]

  const rows: Cell[][] = []
  let cur: Cell[] = []
  const flushCur = (): void => {
    if (cur.length > 0) {
      rows.push(cur)
      cur = []
    }
  }
  const spaceCell = (st: SegStyle): Cell => ({ ch: " ", st })

  /** Place a word onto the current row; hard-split words wider than `width`.
   * `lead` spaces are prepended only while the row is still empty. */
  const placeWord = (cells: Cell[], lead: number): void => {
    let rest = cells
    let firstPass = true
    while (rest.length > 0) {
      if (cur.length === 0 && firstPass && lead > 0) {
        const leadN = Math.min(lead, Math.max(0, width - rest.length))
        const st = rest[0]?.st ?? {}
        for (let k = 0; k < leadN; k++) cur.push(spaceCell(st))
      }
      const avail = width - cur.length
      if (avail <= 0) {
        flushCur()
        continue
      }
      const take = rest.slice(0, avail)
      cur.push(...take)
      rest = rest.slice(avail)
      if (rest.length > 0) flushCur()
      firstPass = false
    }
  }

  words.forEach((word, idx) => {
    const wordW = word.cells.length
    if (cur.length === 0) {
      const isFirstRow = rows.length === 0
      placeWord(word.cells, idx === 0 && isFirstRow ? word.gap : 0)
      return
    }
    if (cur.length + 1 + wordW <= width) {
      cur.push(spaceCell(word.cells[0]?.st ?? {}))
      placeWord(word.cells, 0)
    } else {
      flushCur()
      placeWord(word.cells, 0)
    }
  })
  flushCur()
  return rows.map((cells) => ({ segs: coalesce(cells.map((c) => plain(c.ch, c.st))) }))
}

/** Fold adjacent segments that share an identical style into one segment
 * (word wrapping splits words across style boundaries at the cell level). */
function coalesce(segs: Seg[]): Seg[] {
  const out: Seg[] = []
  for (const seg of segs) {
    const prev = out[out.length - 1]
    if (prev && sameStyle(prev.style, seg.style)) prev.text += seg.text
    else out.push({ text: seg.text, style: { ...seg.style } })
  }
  return out
}

function sameStyle(a: SegStyle, b: SegStyle): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.code === b.code &&
    a.heading === b.heading &&
    a.link === b.link &&
    a.href === b.href &&
    a.dim === b.dim &&
    a.error === b.error &&
    a.accent === b.accent
  )
}

/**
 * Greedy word-wrap logical lines to `width` visual columns. Leading
 * indentation is kept on the first row; interior whitespace collapses to one
 * space; continuation rows lose indentation (terminal standard). Words longer
 * than the width are hard-split.
 */
export function wrapLines(lines: readonly MdLine[], width: number): MdLine[] {
  if (!Number.isFinite(width)) width = 40
  const w = Math.max(1, Math.floor(width))
  const out: MdLine[] = []
  for (const line of lines) {
    const rows = wordWrapOne(line, w)
    if (line.copyLine !== undefined) {
      for (const r of rows) r.copyLine = line.copyLine
    }
    out.push(...rows)
  }
  return out
}

/** Wrap raw text to width (helper for tests + the input editor). */
export function wrapTextToWidth(src: string, width: number): string[] {
  const rows = wrapLines(renderMarkdown(src), width)
  return rows.map((l) => l.segs.map((s) => s.text).join(""))
}
