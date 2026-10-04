import { describe, expect, test } from "bun:test"
import { acceptCompletion, isExactCommandQuery, menuWindow, slashMenuForLine } from "../../../../src/engine/chat/slashComplete.ts"
import { SLASH_COMMANDS } from "../../../../src/agent/slash.ts"

describe("slashMenuForLine", () => {
  test("openness: closed off the first line, for non-slash lines, in argument regions, and with no matches", () => {
    const closed: Array<[string, boolean]> = [
      ["/clear", false], // cursor on another logical line
      ["", true], // non-slash first line
      ["hello", true],
      ["a /clear", true], // slash not at the line start
      ["/clear ", true], // a space opens the argument region — menu closes
      ["/yolo off", true],
      ["/frobnicate", true], // unknown command: the menu stays closed, the send reports the error
    ]
    for (const [line, onFirst] of closed) {
      expect(slashMenuForLine(line, onFirst)).toBeNull()
    }
  })

  test("open menu: bare '/' lists the whole table, prefix matching is case-insensitive and keeps table order, the original query is kept", () => {
    const all = slashMenuForLine("/", true)
    expect(all).not.toBeNull()
    expect(all?.query).toBe("")
    expect(all?.matches.map((c) => c.name)).toEqual(SLASH_COMMANDS.map((c) => c.name))
    expect(slashMenuForLine("/CL", true)).toMatchObject({ query: "CL" })
    expect(slashMenuForLine("/CL", true)?.matches.map((c) => c.name)).toEqual(["clear"])
    expect(slashMenuForLine("/m", true)?.matches.map((c) => c.name)).toEqual(["model", "models", "memory", "map", "mcp"])
    expect(slashMenuForLine("/mo", true)?.matches.map((c) => c.name)).toEqual(["model", "models"])
    expect(slashMenuForLine("/mod", true)?.matches.map((c) => c.name)).toEqual(["model", "models"])
    expect(slashMenuForLine("/ag", true)?.matches.map((c) => c.name)).toEqual(["agent"])
  })
})

describe("acceptCompletion", () => {
  test("replaces the token with '/<name> ' (trailing space invites an argument), preserving following lines", () => {
    expect(acceptCompletion("/cl", "clear")).toEqual({ text: "/clear ", cursorRow: 0, cursorCol: 7 })
    const mode = acceptCompletion("/mo", "mode")
    expect(mode.text).toBe("/mode ")
    expect(mode.cursorCol).toBe("/mode ".length)
    // The rest of the draft is untouched; the caret stays on the first line.
    const multi = acceptCompletion("/cl\nsecond line", "clear")
    expect(multi.text).toBe("/clear \nsecond line")
    expect(multi.cursorRow).toBe(0)
    // A bare '/' completes too.
    expect(acceptCompletion("/", "help")).toEqual({ text: "/help ", cursorRow: 0, cursorCol: 6 })
  })
})

describe("isExactCommandQuery (hybrid Enter)", () => {
  test("true only for complete known command names (any case); prefixes, unknowns, and empty send/complete instead", () => {
    for (const q of ["clear", "HELP"]) expect(isExactCommandQuery(q)).toBe(true)
    for (const q of ["cl", "modem", ""]) expect(isExactCommandQuery(q)).toBe(false)
  })
})

describe("menuWindow (match-list windowing)", () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

  test("shows everything when it fits, slides only when the selection leaves, keeps the selection inside, clamps input", () => {
    const fit = menuWindow([1, 2, 3], 0, 6)
    expect(fit.rows).toEqual([1, 2, 3])
    expect(fit.start).toBe(0)
    // The window starts at the top and slides only once the selection pushes past it.
    expect(menuWindow(items, 0, 6).start).toBe(0)
    expect(menuWindow(items, 5, 6).start).toBe(0)
    expect(menuWindow(items, 6, 6).start).toBe(1)
    expect(menuWindow(items, 10, 6).start).toBe(5)
    // The selection is always visible within the returned rows.
    for (const sel of [0, 3, 6, 9, 10]) {
      const w = menuWindow(items, sel, 6)
      expect(sel).toBeGreaterThanOrEqual(w.start)
      expect(sel).toBeLessThan(w.start + w.rows.length)
    }
    // An out-of-range selection clamps to the list's end.
    const clamped = menuWindow([1, 2, 3], 99, 2)
    expect(clamped.rows).toEqual([2, 3])
  })
})
