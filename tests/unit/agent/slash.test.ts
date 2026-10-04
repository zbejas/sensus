import { describe, expect, test } from "bun:test"
import { isSlashInput, parseSlash, SLASH_COMMANDS, SLASH_NAMES } from "../../../src/agent/slash.ts"

describe("slash parsing", () => {
  test("non-slash input (even trimmed) is not a command; isSlashInput agrees", () => {
    for (const input of ["hello", "  hello /model", "", "a/b"]) {
      expect(parseSlash(input)).toBeNull()
    }
    expect(isSlashInput("/help")).toBe(true)
    expect(isSlashInput("  /help")).toBe(true)
    expect(isSlashInput("a/b")).toBe(false)
    expect(isSlashInput("")).toBe(false)
  })

  test("parses commands: known/unknown, case-insensitive, trimmed, args with spaces, raw retained", () => {
    // Known command with an argument.
    const c = parseSlash("/model gpt-x")
    expect(c?.name).toBe("model")
    expect(c?.known).toBe(true)
    expect(c?.arg).toBe("gpt-x")
    // Case-insensitive + trimmed name.
    expect(parseSlash("  /YOLO off  ")).toMatchObject({ name: "yolo", arg: "off" })
    // Argument may be empty or contain spaces.
    expect(parseSlash("/clear")?.arg).toBe("")
    expect(parseSlash("/model my org/model v2")?.arg).toBe("my org/model v2")
    // Unknown commands still parse, flagged not-known; bare "/" is an empty name.
    expect(parseSlash("/frobnicate the widget")).toMatchObject({ name: "frobnicate", known: false, arg: "the widget" })
    expect(parseSlash("/")).toMatchObject({ name: "", known: false })
    // Raw input is retained for persistence.
    expect(parseSlash("  /model gpt-4")?.raw).toBe("  /model gpt-4")
  })

  test("SLASH_COMMANDS is the single source of truth: derived names, unique + parseable, self-documented", () => {
    expect(SLASH_NAMES).toEqual(SLASH_COMMANDS.map((c) => c.name))
    expect(new Set(SLASH_NAMES).size).toBe(SLASH_NAMES.length)
    for (const name of SLASH_NAMES) expect(name).toMatch(/^[a-z][a-z0-9-]*$/)
    for (const c of SLASH_COMMANDS) {
      expect(c.description.length).toBeGreaterThan(0)
      expect(c.description.length).toBeLessThanOrEqual(40)
      expect(c.usage).toMatch(/^[()[\]a-z|<>@/]*$/)
    }
  })
})
