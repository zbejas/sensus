/**
 * Chat input editor: multiline, code-point safe.
 * Pure logic + unit tests (no Solid/opentui imports).
 *
 * Editing model: a list of LOGICAL lines plus a cursor (row, col in code
 * points). Enter=send lives in the caller; newline() here is Alt+Enter.
 *
 * Display: logical lines are hard-wrapped to the input box width so every
 * character is shown faithfully (an input editor must not drop spaces).
 * visual(width) returns all display rows and the cursor's position within
 * them; the UI shows a window ending near the cursor.
 */

export const cps = (s: string): string[] => [...s]

/** One visual row of a word-wrapped logical line. */
export interface EditorRow {
  text: string
  /** Code-point index of this row's first char within the logical line. */
  start: number
}

/**
 * Word-wrap a logical line to `width` code points, preserving EVERY character
 * (the editor's fidelity contract: no space is dropped). Break after the last
 * whitespace that fits (the space stays visible at the row end); a word wider
 * than the row is hard-split at `width`. A break that would leave an
 * all-whitespace row is rejected (leading indentation rides with the word).
 *
 * Shared by `InputEditor.visual` and `visualToCursor` so the forward and
 * inverse visual↔logical maps can never drift. Pure.
 */
export function wrapEditorLine(line: string, width: number): EditorRow[] {
  const w = Math.max(1, Math.floor(width))
  const chars = cps(line)
  if (chars.length === 0) return [{ text: "", start: 0 }]
  const rows: EditorRow[] = []
  let start = 0
  while (start < chars.length) {
    const end = Math.min(start + w, chars.length)
    if (end >= chars.length) {
      rows.push({ text: chars.slice(start, end).join(""), start })
      break
    }
    let breakAt = end
    for (let p = end - 1; p > start; p--) {
      if (/\s/.test(chars[p] ?? "")) {
        // Only break here if the row carries real text (not just indentation).
        if (chars.slice(start, p).some((c) => !/\s/.test(c))) breakAt = p + 1
        break
      }
    }
    rows.push({ text: chars.slice(start, breakAt).join(""), start })
    start = breakAt
  }
  return rows
}

/** Cursor (row, col) within word-wrapped rows for logical column `col`. The
 * caret at a row boundary lands at col 0 of the following row. Pure. */
function cursorPosInRows(rows: readonly EditorRow[], col: number): { row: number; col: number } {
  let idx = 0
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i]?.start ?? 0) <= col) idx = i
  }
  const start = rows[idx]?.start ?? 0
  return { row: idx, col: Math.max(0, col - start) }
}

export class InputEditor {
  private lines: string[] = [""]
  private row = 0
  private col = 0

  constructor(text = "") {
    if (text.length > 0) this.setText(text)
  }

  getText(): string {
    return this.lines.join("\n")
  }

  isEmpty(): boolean {
    return this.getText().trim() === ""
  }

  setText(text: string): void {
    this.lines = text.split("\n")
    if (this.lines.length === 0) this.lines = [""]
    // Place the cursor at the end (loaded history is ready to edit).
    this.row = this.lines.length - 1
    this.col = cps(this.lineAt()).length
    this.clamp()
  }

  clear(): void {
    this.lines = [""]
    this.row = 0
    this.col = 0
  }

  cursor(): { row: number; col: number } {
    return { row: this.row, col: this.col }
  }

  lineCount(): number {
    return this.lines.length
  }

  private lineAt(row = this.row): string {
    return this.lines[row] ?? ""
  }

  private clamp(): void {
    if (this.row >= this.lines.length) this.row = this.lines.length - 1
    if (this.row < 0) this.row = 0
    const len = cps(this.lineAt()).length
    if (this.col > len) this.col = len
    if (this.col < 0) this.col = 0
  }

  /** Insert text at the cursor. "\n" splits the line. */
  insert(text: string): void {
    const parts = text.split("\n")
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] ?? ""
      if (i > 0) this.newline()
      if (part.length === 0) continue
      const chars = cps(this.lineAt())
      chars.splice(this.col, 0, ...cps(part))
      this.lines[this.row] = chars.join("")
      this.col += cps(part).length
    }
  }

  /** Split the current logical line at the cursor (Alt+Enter / Shift+Enter). */
  newline(): void {
    const chars = cps(this.lineAt())
    const before = chars.slice(0, this.col).join("")
    const after = chars.slice(this.col).join("")
    this.lines[this.row] = before
    this.lines.splice(this.row + 1, 0, after)
    this.row++
    this.col = 0
  }

  backspace(): void {
    if (this.col > 0) {
      const chars = cps(this.lineAt())
      chars.splice(this.col - 1, 1)
      this.lines[this.row] = chars.join("")
      this.col--
      return
    }
    if (this.row > 0) {
      const prev = cps(this.lineAt(this.row - 1))
      const cur = this.lineAt()
      this.lines[this.row - 1] = prev.join("") + cur
      this.lines.splice(this.row, 1)
      this.row--
      this.col = prev.length
    }
  }

  deleteForward(): void {
    const chars = cps(this.lineAt())
    if (this.col < chars.length) {
      chars.splice(this.col, 1)
      this.lines[this.row] = chars.join("")
      return
    }
    if (this.row < this.lines.length - 1) {
      const next = this.lineAt(this.row + 1)
      this.lines[this.row] = this.lineAt() + next
      this.lines.splice(this.row + 1, 1)
    }
  }

  moveLeft(): boolean {
    if (this.col > 0) {
      this.col--
      return true
    }
    if (this.row > 0) {
      this.row--
      this.col = cps(this.lineAt()).length
      return true
    }
    return false
  }

  moveRight(): boolean {
    if (this.col < cps(this.lineAt()).length) {
      this.col++
      return true
    }
    if (this.row < this.lines.length - 1) {
      this.row++
      this.col = 0
      return true
    }
    return false
  }

  /**
   * Jump to the start of the previous word (Ctrl+Left). Readline
   * backward-word semantics over whitespace-delimited words, crossing logical
   * lines; a cursor already at the start of the buffer does not move.
   * Returns whether the cursor moved.
   */
  moveWordLeft(): boolean {
    const startRow = this.row
    const startCol = this.col
    // Skip whitespace (and line breaks) before the cursor.
    for (;;) {
      if (this.col > 0) {
        if (!/\s/.test(cps(this.lineAt())[this.col - 1] ?? "")) break
        this.col--
        continue
      }
      if (this.row === 0) break
      this.row--
      this.col = cps(this.lineAt()).length
    }
    // Walk back to the start of that word.
    while (this.col > 0 && !/\s/.test(cps(this.lineAt())[this.col - 1] ?? "")) this.col--
    return this.row !== startRow || this.col !== startCol
  }

  /**
   * Jump to the end of the next word (Ctrl+Right). Readline forward-word
   * semantics: skip whitespace, then the word, crossing logical lines; a
   * cursor already at the end of the buffer does not move. Returns whether the
   * cursor moved.
   */
  moveWordRight(): boolean {
    const startRow = this.row
    const startCol = this.col
    // Skip whitespace (and line breaks) up to the next word.
    for (;;) {
      const chars = cps(this.lineAt())
      if (this.col < chars.length && /\s/.test(chars[this.col] ?? "")) {
        this.col++
        continue
      }
      if (this.col >= chars.length && this.row < this.lines.length - 1) {
        this.row++
        this.col = 0
        continue
      }
      break
    }
    // Walk to the end of that word.
    for (;;) {
      const chars = cps(this.lineAt())
      if (this.col >= chars.length || /\s/.test(chars[this.col] ?? "")) break
      this.col++
    }
    return this.row !== startRow || this.col !== startCol
  }

  /** Move up one logical line. Returns false at the top edge. */
  moveUp(): boolean {
    if (this.row <= 0) return false
    const target = cps(this.lineAt(this.row - 1)).length
    this.row--
    this.col = Math.min(this.col, target)
    return true
  }

  /** Move down one logical line. Returns false at the bottom edge. */
  moveDown(): boolean {
    if (this.row >= this.lines.length - 1) return false
    const target = cps(this.lineAt(this.row + 1)).length
    this.row++
    this.col = Math.min(this.col, target)
    return true
  }

  home(): void {
    this.col = 0
  }

  end(): void {
    this.col = cps(this.lineAt()).length
  }

  /** Jump the cursor to a logical position (clamped). Used by input clicks. */
  setCursor(row: number, col: number): void {
    this.row = Math.max(0, Math.min(row, this.lines.length - 1))
    this.col = Math.max(0, Math.min(col, cps(this.lineAt()).length))
  }

  /**
   * Place the cursor from a CLICK on the rendered input: (visualRow, visualCol)
   * are coordinates within visual(width) rows. Pure mapping (visualToCursor)
   * + clamping; out-of-range rows/cols land on the nearest valid position.
   */
  setCursorVisual(visualRow: number, visualCol: number, width: number): void {
    const hit = visualToCursor(this.lines, width, visualRow, visualCol)
    if (hit === null) return
    this.setCursor(hit.row, hit.col)
  }

  /**
   * Visual layout: word-wrap each logical line to `width` code points (a word
   * is kept whole unless it is wider than the row, then hard-split). Returns
   * all display rows plus the cursor's visual row/col (row indexes into
   * `rows`). width < 1 clamps to 1 (still exact for the editor).
   */
  visual(width: number): { rows: string[]; cursorRow: number; cursorCol: number } {
    const w = Math.max(1, Math.floor(width))
    const rows: string[] = []
    let cursorRow = 0
    let cursorCol = 0
    for (let r = 0; r < this.lines.length; r++) {
      const lineRows = wrapEditorLine(this.lines[r] ?? "", w)
      if (r === this.row) {
        const at = cursorPosInRows(lineRows, this.col)
        cursorRow = rows.length + at.row
        cursorCol = at.col
      }
      for (const lr of lineRows) rows.push(lr.text)
    }
    return { rows, cursorRow, cursorCol }
  }
}

/**
 * Inverse of the visual layout: which LOGICAL (row, col) does a click at
 * (visualRow, visualCol) land on? Mirrors visual()'s word-wrapping exactly via
 * the shared `wrapEditorLine` (a visual row's own text length bounds the
 * column; clicks past the end land at the row boundary); visualRow past the
 * last row clamps to the last row. Returns null only for an empty lines array.
 */
export function visualToCursor(
  lines: readonly string[],
  width: number,
  visualRow: number,
  visualCol: number,
): { row: number; col: number } | null {
  if (lines.length === 0) return null
  const w = Math.max(1, Math.floor(width))
  const vRow = Math.max(0, Math.floor(visualRow))
  let base = 0
  let lineIdx = lines.length - 1
  let rowsIntoLine = 0
  for (let li = 0; li < lines.length; li++) {
    const lineRows = wrapEditorLine(lines[li] ?? "", w)
    if (vRow < base + lineRows.length) {
      lineIdx = li
      rowsIntoLine = vRow - base
      break
    }
    base += lineRows.length
  }
  const lineRows = wrapEditorLine(lines[lineIdx] ?? "", w)
  const rowInLine = Math.min(rowsIntoLine, lineRows.length - 1)
  const row = lineRows[rowInLine] ?? { text: "", start: 0 }
  const rowLen = cps(row.text).length
  const inRowCol = Math.max(0, Math.min(Math.floor(visualCol), rowLen))
  return { row: lineIdx, col: row.start + inRowCol }
}
