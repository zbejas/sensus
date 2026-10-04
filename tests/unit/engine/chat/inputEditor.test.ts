import { describe, expect, test } from "bun:test"
import { InputEditor, visualToCursor, wrapEditorLine } from "../../../../src/engine/chat/inputEditor.ts"

describe("InputEditor editing", () => {
  test("insert splices at the cursor and splits on newlines; newline() splits the line at the cursor", () => {
    const e = new InputEditor()
    e.insert("hello")
    expect(e.getText()).toBe("hello")
    expect(e.cursor()).toEqual({ row: 0, col: 5 })
    // Newlines inside inserted text split logical lines.
    e.insert("ab\ncd")
    expect(e.getText()).toBe("helloab\ncd")
    expect(e.lineCount()).toBe(2)
    // Mid-line insert splices without moving surrounding text.
    const mid = new InputEditor("abcd")
    mid.home()
    mid.moveRight()
    mid.moveRight()
    mid.insert("XY")
    expect(mid.getText()).toBe("abXYcd")
    // newline() (Alt+Enter) splits at the cursor, cursor lands on the new line.
    const split = new InputEditor("abcd")
    split.moveLeft()
    split.moveLeft() // col 2
    split.newline()
    expect(split.getText()).toBe("ab\ncd")
    expect(split.cursor()).toEqual({ row: 1, col: 0 })
  })

  test("edits across line boundaries: backspace/deleteForward join lines; setText resets; isEmpty trims", () => {
    // Backspace at col 0 joins with the previous line.
    const x = new InputEditor("ab\ncd")
    expect(x.cursor()).toEqual({ row: 1, col: 2 })
    x.backspace() // row1 col1: removes "d"
    expect(x.getText()).toBe("ab\nc")
    x.home()
    x.backspace() // row1 col0, row>0 -> joins: "abc"
    expect(x.getText()).toBe("abc")
    expect(x.cursor()).toEqual({ row: 0, col: 2 })
    // deleteForward at a line end joins the NEXT line.
    const e = new InputEditor("ab\ncd")
    e.moveUp() // row0, end col2
    e.deleteForward()
    expect(e.getText()).toBe("abcd")
    expect(e.cursor()).toEqual({ row: 0, col: 2 })
    // setText replaces content and parks the cursor at the end.
    const s = new InputEditor("abc")
    s.insert("X")
    s.setText("fresh")
    expect(s.getText()).toBe("fresh")
    expect(s.cursor()).toEqual({ row: 0, col: 5 })
    // isEmpty is whitespace-trimmed (a lone space still counts as empty).
    expect(new InputEditor().isEmpty()).toBe(true)
    expect(new InputEditor(" ").isEmpty()).toBe(true)
    expect(new InputEditor("x").isEmpty()).toBe(false)
  })

  test("cursor movement: arrows cross logical lines with column clamping; home/end bind the row", () => {
    const e = new InputEditor("abc\nde")
    // From the end of "de": up clamps to the shorter line's length.
    expect(e.moveUp()).toBe(true)
    expect(e.cursor()).toEqual({ row: 0, col: 2 })
    expect(e.moveLeft()).toBe(true)
    expect(e.cursor()).toEqual({ row: 0, col: 1 })
    expect(e.moveUp()).toBe(false) // top edge
    expect(e.moveDown()).toBe(true) // back to row1, col clamped to 1
    expect(e.cursor()).toEqual({ row: 1, col: 1 })
    expect(e.moveRight()).toBe(true) // col2 = end of "de"
    expect(e.moveRight()).toBe(false) // bottom/right edge
    e.end()
    expect(e.cursor()).toEqual({ row: 1, col: 2 })
    e.home()
    expect(e.cursor()).toEqual({ row: 1, col: 0 })
  })

  test("word navigation: Ctrl+Left/Right jump by whitespace-delimited words across lines", () => {
    const e = new InputEditor("foo bar baz")
    // Backward-word lands on each word start, from the end.
    expect(e.moveWordLeft()).toBe(true)
    expect(e.cursor()).toEqual({ row: 0, col: 8 })
    expect(e.moveWordLeft()).toBe(true)
    expect(e.cursor()).toEqual({ row: 0, col: 4 })
    expect(e.moveWordLeft()).toBe(true)
    expect(e.cursor()).toEqual({ row: 0, col: 0 })
    expect(e.moveWordLeft()).toBe(false) // start of buffer
    // Forward-word walks to the END of the next word (readline semantics).
    expect(e.moveWordRight()).toBe(true)
    expect(e.cursor()).toEqual({ row: 0, col: 3 })
    expect(e.moveWordRight()).toBe(true)
    expect(e.cursor()).toEqual({ row: 0, col: 7 })
    expect(e.moveWordRight()).toBe(true)
    expect(e.cursor()).toEqual({ row: 0, col: 11 })
    expect(e.moveWordRight()).toBe(false) // end of buffer
    // A cursor inside a word jumps to that word's boundary.
    const mid = new InputEditor("hello world")
    mid.setCursor(0, 8) // inside "world"
    expect(mid.moveWordLeft()).toBe(true)
    expect(mid.cursor()).toEqual({ row: 0, col: 6 })
    expect(mid.moveWordRight()).toBe(true)
    expect(mid.cursor()).toEqual({ row: 0, col: 11 })
    // Both directions cross logical lines (including empty ones).
    const back = new InputEditor("ab\n\ncd ef")
    expect(back.moveWordLeft()).toBe(true)
    expect(back.cursor()).toEqual({ row: 2, col: 3 }) // "ef" start
    expect(back.moveWordLeft()).toBe(true)
    expect(back.cursor()).toEqual({ row: 2, col: 0 }) // "cd" start
    expect(back.moveWordLeft()).toBe(true)
    expect(back.cursor()).toEqual({ row: 0, col: 0 }) // "ab" start, empty line crossed
    expect(back.moveWordLeft()).toBe(false)
    const fwd = new InputEditor("ab\n\ncd")
    fwd.setCursor(0, 0)
    expect(fwd.moveWordRight()).toBe(true)
    expect(fwd.cursor()).toEqual({ row: 0, col: 2 }) // "ab" end
    expect(fwd.moveWordRight()).toBe(true)
    expect(fwd.cursor()).toEqual({ row: 2, col: 2 }) // "cd" end, empty line crossed
    expect(fwd.moveWordRight()).toBe(false)
  })
})

describe("InputEditor visual layout", () => {
  test("visual(width) hard-wraps logical lines and tracks the cursor, surrogate pairs kept whole", () => {
    const cases: Array<{
      why: string
      text: string
      width: number
      toEnd?: boolean
      rows: string[]
      cursorRow: number
      cursorCol: number
    }> = [
      { why: "short line is one row", text: "hi", width: 10, rows: ["hi"], cursorRow: 0, cursorCol: 2 },
      { why: "long line hard-wraps, characters preserved", text: "abcdefghij", width: 4, toEnd: true, rows: ["abcd", "efgh", "ij"], cursorRow: 2, cursorCol: 2 },
      { why: "cursor at the end of a full row maps to the end of that row", text: "abcd", width: 4, toEnd: true, rows: ["abcd"], cursorRow: 0, cursorCol: 4 },
      { why: "each logical line wraps on its own", text: "ab\ncdefgh", width: 4, toEnd: true, rows: ["ab", "cdef", "gh"], cursorRow: 2, cursorCol: 2 },
      { why: "surrogate pair is never split across rows", text: "😀x", width: 2, toEnd: true, rows: ["😀x"], cursorRow: 0, cursorCol: 2 },
    ]
    for (const c of cases) {
      const e = new InputEditor(c.text)
      if (c.toEnd) e.end()
      const v = e.visual(c.width)
      expect(v.rows).toEqual(c.rows)
      expect(v.cursorRow).toBe(c.cursorRow)
      expect(v.cursorCol).toBe(c.cursorCol)
    }
  })
})

describe("M7 click-to-position caret (visualToCursor / setCursorVisual)", () => {
  test("clicks map visual rows onto logical positions, round-tripping with visual()", () => {
    // Single line: clicking over a character puts the caret before it.
    const e = new InputEditor("HELLOWORLD")
    e.setCursorVisual(0, 5, 60) // clicked over the 'W' (index 5)
    expect(e.cursor()).toEqual({ row: 0, col: 5 })
    e.insert("X")
    expect(e.getText()).toBe("HELLOXWORLD")
    // Multiline: the visual row selects the logical line.
    const m = new InputEditor("one\ntwo\nthree")
    m.setCursorVisual(2, 1, 60) // third visual row = "three", col 1
    expect(m.cursor()).toEqual({ row: 2, col: 1 })
    m.setCursorVisual(0, 2, 60)
    expect(m.cursor()).toEqual({ row: 0, col: 2 })
    // Wrapped line: visual rows within one logical line map to offsets.
    const w = new InputEditor("ABCDEFGHIJKLMNOP") // width 10 -> "ABCDEFGHIJ" + "KLMNOP"
    w.setCursorVisual(1, 2, 10) // second visual row, col 2 -> logical col 12
    expect(w.cursor()).toEqual({ row: 0, col: 12 })
    // Round trip: visual() agrees where the click landed.
    expect(w.visual(10)).toMatchObject({ cursorRow: 1, cursorCol: 2 })
    // The pure helper mirrors the editor's mapping.
    expect(visualToCursor(["abc", "def"], 60, 1, 2)).toEqual({ row: 1, col: 2 })
  })

  test("click clamping: past-end lands at row end, empty drafts land at 0, out-of-range rows/cols clamp", () => {
    // Click past the end of the text lands at end-of-line.
    const e = new InputEditor("abc")
    e.setCursorVisual(0, 40, 60)
    expect(e.cursor()).toEqual({ row: 0, col: 3 })
    // Empty draft: any click lands at 0.
    const empty = new InputEditor("")
    empty.setCursorVisual(0, 12, 60)
    expect(empty.cursor()).toEqual({ row: 0, col: 0 })
    // visualRow past the last row clamps to the last row.
    const past = new InputEditor("one\ntwo")
    past.setCursorVisual(9, 0, 60)
    expect(past.cursor()).toEqual({ row: 1, col: 0 })
    // Negative columns floor to 0; an empty lines array has no position.
    expect(visualToCursor(["abc"], 60, 0, -3)).toEqual({ row: 0, col: 0 })
    expect(visualToCursor([], 60, 0, 0)).toBeNull()
  })
})

describe("word wrapping (whole words, no dropped characters)", () => {
  test("wrapEditorLine breaks at whitespace and hard-splits words wider than the row", () => {
    const rows = (line: string, w: number): string[] => wrapEditorLine(line, w).map((r) => r.text)
    // Break after the space so the space stays visible on the first row.
    expect(rows("hello world", 8)).toEqual(["hello ", "world"])
    // A word wider than the row is hard-split (URLs / identifiers).
    expect(rows("supercalifragilistic", 5)).toEqual(["super", "calif", "ragil", "istic"])
    // Multiple spaces are preserved verbatim across the break.
    expect(rows("a  b", 2)).toEqual(["a ", " b"])
    // Leading indentation rides with the word instead of stranding a blank row.
    expect(rows("    word", 6)).toEqual(["    wo", "rd"])
    // A short line is a single row; an empty line is one empty row.
    expect(rows("hi", 10)).toEqual(["hi"])
    expect(rows("", 10)).toEqual([""])
    // Fidelity: no character is ever dropped.
    for (const [line, w] of [["hello world", 8], ["a  b c", 3], ["日本語 テスト", 4]] as const) {
      expect(rows(line, w).join("")).toBe(line)
    }
  })

  test("visual() word-wraps and maps the cursor to the wrapped rows", () => {
    const e = new InputEditor("hello world")
    expect(e.visual(8).rows).toEqual(["hello ", "world"])
    // The caret at the start of "world" (col 6) lands at row 1, col 0.
    e.setCursor(0, 6)
    expect(e.visual(8)).toMatchObject({ cursorRow: 1, cursorCol: 0 })
    // The caret on the space (col 5) stays at the end of row 0.
    e.setCursor(0, 5)
    expect(e.visual(8)).toMatchObject({ cursorRow: 0, cursorCol: 5 })
    // End of the line maps to the end of the final row.
    e.end()
    expect(e.visual(8)).toMatchObject({ cursorRow: 1, cursorCol: 5 })
  })

  test("visualToCursor inverts word wrapping (round-trips with visual)", () => {
    // Click on the wrapped second row maps back to the logical offset.
    expect(visualToCursor(["hello world"], 8, 1, 2)).toEqual({ row: 0, col: 8 })
    // Clicks past the end of a row clamp to that row's boundary.
    expect(visualToCursor(["hello world"], 8, 1, 99)).toEqual({ row: 0, col: 11 })
    const e = new InputEditor("hello world")
    e.setCursorVisual(1, 2, 8)
    expect(e.cursor()).toEqual({ row: 0, col: 8 })
    expect(e.visual(8)).toMatchObject({ cursorRow: 1, cursorCol: 2 })
  })
})
