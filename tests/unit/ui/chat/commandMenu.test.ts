import { describe, expect, test } from "bun:test"
import { defaultKeymap, parseKeySpec, resolveKeymap, specLabel } from "../../../../src/core/keymap.ts"
import { SLASH_NAMES } from "../../../../src/agent/slash.ts"
import {
  CATEGORY_LABELS,
  COMMAND_CATALOG,
  commandById,
  commandForAction,
  paletteCommands,
  type CommandDef,
} from "../../../../src/core/commandCatalog.ts"
import { filterCommands, groupedRenderRows, hintFor, menuWindow, menuRows, renderIndexOf } from "../../../../src/ui/chat/commandMenu.ts"

const MENU: readonly CommandDef[] = menuRows()

describe("command registry (commandCatalog.ts)", () => {
  test("integrity: unique complete rows, working lookups, and ONE source for the palette", () => {
    expect(new Set(COMMAND_CATALOG.map((c) => c.id)).size).toBe(COMMAND_CATALOG.length)
    for (const c of COMMAND_CATALOG) {
      expect(c.label.length).toBeGreaterThan(0)
      expect(c.description.length).toBeGreaterThan(0)
      expect(c.category.length).toBeGreaterThan(0)
    }
    expect(commandById("open-models")?.label).toBe("Model catalog")
    expect(commandById("nope")).toBeUndefined()
    expect(commandForAction("new-tab")?.id).toBe("new-tab")
    expect(commandForAction("focus-sidebar")?.id).toBe("focus-sidebar")
    // Chat-row keyboard parity actions are registered and palette-visible.
    for (const id of ["copy-message", "revert-message", "send-code-block"] as const) {
      const def = commandForAction(id)
      expect(def?.id).toBe(id)
      expect(def?.hidden).not.toBe(true)
    }
    // paletteCommands and menuRows are the same list, not two derivations.
    expect(paletteCommands()).toEqual([...MENU])
  })

  test("DRIFT KILLER: keymap actions and catalog rows are exactly 1:1 (cross-module invariant)", () => {
    // Every row with a backing action names a real keymap action; rows
    // without one exist only as commands and carry a slash hint.
    for (const c of COMMAND_CATALOG) {
      if (c.action !== undefined) expect(c.action in defaultKeymap).toBe(true)
      else expect(c.slash).toBeDefined()
    }
    // And every default keymap action has exactly one catalog row — a hotkey
    // can never drift away from (or double-register in) the palette.
    const actions = COMMAND_CATALOG.map((c) => c.action).filter((a) => a !== undefined)
    expect(new Set(actions).size).toBe(actions.length)
    for (const id of Object.keys(defaultKeymap) as Array<keyof typeof defaultKeymap>) {
      expect(commandForAction(id)).toBeDefined()
    }
    expect(actions.length).toBe(Object.keys(defaultKeymap).length)
  })

  test("slash hints always exist in the slash table (palette hints cannot drift)", () => {
    for (const c of COMMAND_CATALOG) {
      if (c.slash === undefined) continue
      expect(SLASH_NAMES as readonly string[]).toContain(c.slash.replace(/^\//, ""))
    }
  })

  test("palette order: settings + models lead, categories stay contiguous (the 1,2,3,5,4 bug), hidden commands stay out", () => {
    // groupedRenderRows makes categories contiguous; if the catalog itself
    // interleaved categories, the palette would visually reshuffle rows when
    // arrowing down. The table must stay pre-grouped and in registry order.
    const rows = groupedRenderRows(MENU, (c) => c.category)
    const displayIds = rows
      .filter((r) => r.kind === "command")
      .map((r) => (r.kind === "command" ? MENU[r.index]?.id : ""))
    expect(displayIds).toEqual(MENU.map((c) => c.id))
    const seen = new Set<string>()
    let last = ""
    for (const cat of MENU.map((c) => c.category)) {
      if (cat !== last) {
        expect(seen.has(cat)).toBe(false) // a finished category never re-appears
        if (last !== "") seen.add(last)
        last = cat
      }
    }
    // Settings and model catalog lead the palette.
    expect(MENU[0]?.id).toBe("open-settings")
    expect(MENU[1]?.id).toBe("open-models")
    // The prefix and per-tab jump hotkeys are actions, not palette rows.
    const ids = MENU.map((c) => c.id)
    expect(ids).not.toContain("prefix")
    expect(ids).not.toContain("open-menu")
    expect(ids).not.toContain("tab-1")
    expect(commandById("prefix")?.hidden).toBe(true)
  })
})

describe("palette helpers", () => {
  test("filterCommands: empty query returns everything; fuzzy label/description matches rank; misses return none", () => {
    expect(filterCommands(MENU, "")).toEqual([...MENU])
    // Substring on the description matches and ranks above non-matches
    // ("theme" ⊂ open-settings' "endpoints, keys, themes, globals").
    const theme = filterCommands(MENU, "theme").map((c) => c.id)
    expect(theme).toContain("open-settings")
    expect(theme).not.toContain("close-tab")
    // Subsequence matching reaches the description too ("agnt" ⊂ "Agent picker").
    expect(filterCommands(MENU, "agnt").map((c) => c.id)).toContain("open-agents")
    expect(filterCommands(MENU, "zzzzzz")).toEqual([])
  })

  test("hintFor: the RESOLVED keymap binding (rebind-aware) or the command's slash spelling", () => {
    const km = resolveKeymap()
    expect(hintFor(commandById("open-settings")!, km)).toBe("ctrl+o")
    // A user remap shows in the hint — never hardcoded.
    expect(hintFor(commandById("open-settings")!, resolveKeymap({ "open-settings": "ctrl+g" }))).toBe("ctrl+g")
    // Command-only entries spell their slash form.
    expect(hintFor(commandById("open-models")!, km)).toBe("/models")
    expect(hintFor(commandById("show-help")!, km)).toBe("/help")
  })

  test("menuWindow: clamped selection, a window that slides to keep the selection visible, safe degenerate lists", () => {
    expect(menuWindow(5, 99, 3).selIdx).toBe(4)
    expect(menuWindow(5, -3, 3).selIdx).toBe(0)
    // 20 rows visible 3 at a time: selecting the end slides the window.
    const end = menuWindow(20, 19, 3)
    expect(end.start).toBe(17)
    expect(end.list).toBe(3)
    const mid = menuWindow(20, 2, 3)
    expect(mid.start).toBe(1)
    expect(mid.list).toBe(3)
    // Small lists render whole; an empty list is safe.
    expect(menuWindow(2, 0, 8)).toEqual({ start: 0, list: 2, selIdx: 0 })
    expect(menuWindow(0, 0, 8)).toEqual({ start: 0, list: 0, selIdx: 0 })
  })

  test("groupedRenderRows + renderIndexOf: headers in first-appearance order, each command once under its category", () => {
    const rows = groupedRenderRows(MENU, (c) => c.category)
    const headers = rows.filter((r) => r.kind === "header").map((r) => (r.kind === "header" ? r.label : ""))
    expect(headers).toEqual(["Settings", "Chat", "Help", "Tabs", "Layout"])
    expect(rows[0]?.kind).toBe("header")
    // Every command appears exactly once, under its own category's header.
    const commandRows = rows.filter((r) => r.kind === "command")
    expect(commandRows.length).toBe(MENU.length)
    let last = ""
    let seen = 0
    for (const r of rows) {
      if (r.kind === "header") {
        last = r.label
      } else {
        const def = MENU[r.kind === "command" ? r.index : -1]
        expect(def).toBeDefined()
        expect(last).toBe(def ? CATEGORY_LABELS[def.category] : "")
        seen++
      }
    }
    expect(seen).toBe(MENU.length)
    // renderIndexOf maps command positions onto render rows; out-of-range
    // clamps to the LAST command row, and an empty list yields 0.
    expect(rows[renderIndexOf(rows, 0)]?.kind === "command" && MENU[0]?.id).toBe("open-settings")
    const oob = rows[renderIndexOf(rows, 9999)]
    expect(oob?.kind).toBe("command")
    expect(oob?.kind === "command" ? oob.index : -1).toBe(MENU.length - 1)
    expect(renderIndexOf([], 0)).toBe(0)
  })

  test("specLabel round-trips parseKeySpec (the hint renderer depends on the symmetry)", () => {
    for (const spec of ["ctrl+o", "shift+tab", "alt+,", "ctrl+p"]) {
      expect(specLabel(parseKeySpec(spec))).toBe(spec)
    }
  })
})
