import { describe, expect, test } from "bun:test"
import { PanePainter, paintDefaultBackground } from "../../../src/terminal/paneBg.ts"
import type { PanePalette, Rgb } from "../../../src/terminal/sgr.ts"

type Cell = [number, number, number, number]

/** One frame-buffer cell's raw 4xUint16 channel entry (value in low byte). */
function cell(r: number, g: number, b: number, a = 255): Cell {
  return [r, g, b, a]
}

function channel(...cells: Cell[]): Uint16Array {
  return Uint16Array.from(cells.flat())
}

function cellAt(arr: Uint16Array, index: number): number[] {
  return Array.from(arr.slice(index * 4, index * 4 + 4))
}

describe("paintDefaultBackground", () => {
  test("repaints opaque-black default cells, leaves explicit colors alone", () => {
    // default black, explicit red bg, explicit truecolor bg, default black
    const bg = channel(cell(0, 0, 0), cell(204, 102, 102), cell(10, 20, 30), cell(0, 0, 0))
    paintDefaultBackground(bg, [40, 42, 54])
    expect(Array.from(bg)).toEqual([
      40, 42, 54, 255, 204, 102, 102, 255, 10, 20, 30, 255, 40, 42, 54, 255,
    ])
  })

  test("a black theme background is a no-op", () => {
    const bg = channel(cell(0, 0, 0), cell(0, 0, 0))
    paintDefaultBackground(bg, [0, 0, 0])
    expect(Array.from(bg)).toEqual([0, 0, 0, 255, 0, 0, 0, 255])
  })

  test("null background leaves the buffer untouched (VT default preserved)", () => {
    const bg = channel(cell(0, 0, 0), cell(1, 2, 3))
    paintDefaultBackground(bg, null)
    expect(Array.from(bg)).toEqual([0, 0, 0, 255, 1, 2, 3, 255])
  })

  test("respects the color-intent metadata byte (only plain RGB black is repainted)", () => {
    const bg = Uint16Array.from([0, 0x0200, 0, 0x00ff, 0, 0, 0, 0x00ff])
    paintDefaultBackground(bg, [9, 9, 9])
    expect(Array.from(bg)).toEqual([0, 0x0200, 0, 0x00ff, 9, 9, 9, 0x00ff])
  })
})

describe("PanePainter", () => {
  test("a theme switch remaps frozen fg/bg on existing cells", () => {
    const p = new PanePainter()
    p.setDefaults([212, 212, 212], [0, 0, 0]) // old theme: light-gray fg, black bg
    p.setDefaults([248, 248, 242], [40, 42, 54]) // new theme (dracula-ish)

    const fg = channel(cell(212, 212, 212), cell(1, 2, 3))
    const bg = channel(cell(0, 0, 0), cell(9, 9, 9))
    p.paint(fg, bg)

    expect(cellAt(fg, 0)).toEqual([248, 248, 242, 255]) // old fg → new fg
    expect(cellAt(fg, 1)).toEqual([1, 2, 3, 255]) // explicit fg untouched
    expect(cellAt(bg, 0)).toEqual([40, 42, 54, 255]) // old bg → new bg
    expect(cellAt(bg, 1)).toEqual([9, 9, 9, 255]) // explicit bg untouched
  })

  test("a VT-black default cell is repainted to the theme background", () => {
    const p = new PanePainter()
    p.setDefaults([212, 212, 212], [40, 42, 54])
    const bg = channel(cell(0, 0, 0), cell(0, 0, 0))
    p.paint(channel(), bg)
    expect(cellAt(bg, 0)).toEqual([40, 42, 54, 255])
    expect(cellAt(bg, 1)).toEqual([40, 42, 54, 255])
  })

  test("remaps compose across several theme switches", () => {
    const p = new PanePainter()
    p.setDefaults([10, 10, 10], [0, 0, 0]) // A
    p.setDefaults([20, 20, 20], [1, 1, 1]) // B
    p.setDefaults([30, 30, 30], [2, 2, 2]) // C
    // cells written under A (fg 10) and under B (fg 20) must both reach C
    const fg = channel(cell(10, 10, 10), cell(20, 20, 20), cell(30, 30, 30))
    p.paint(fg, channel())
    expect(cellAt(fg, 0)).toEqual([30, 30, 30, 255])
    expect(cellAt(fg, 1)).toEqual([30, 30, 30, 255])
    expect(cellAt(fg, 2)).toEqual([30, 30, 30, 255])
  })

  test("a palette change remaps indexed colors already on screen", () => {
    const pal1: PanePalette = [[1, 1, 1], [2, 2, 2], null]
    const pal2: PanePalette = [[10, 10, 10], [2, 2, 2], [3, 3, 3]]
    const p = new PanePainter()
    p.setPalette(pal1)
    p.setPalette(pal2)
    const fg = channel(cell(1, 1, 1), cell(2, 2, 2))
    p.paint(fg, channel())
    expect(cellAt(fg, 0)).toEqual([10, 10, 10, 255]) // index 0 changed
    expect(cellAt(fg, 1)).toEqual([2, 2, 2, 255]) // index 1 unchanged
  })

  test("remapping preserves the high (color-intent metadata) byte", () => {
    const p = new PanePainter()
    p.setDefaults([1, 2, 3], null)
    p.setDefaults([10, 20, 30], null)
    // g carries a metadata byte (0x02) in its high byte; only the low byte moves.
    const fg = Uint16Array.from([1, 0x0202, 3, 0x00ff])
    p.paint(fg, channel())
    expect(Array.from(fg)).toEqual([10, 0x0214, 30, 0x00ff])
  })
})
