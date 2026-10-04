/**
 * mcpManager (docs/mcp.md "UI", docs/ui.md "Overlays"): the pure row/state
 * helpers behind the MCP manager overlay. Scenario-shaped — enabled vs off,
 * the status label, the row mark/arrow, and the toggle key intent.
 */

import { describe, expect, test } from "bun:test"
import {
  mcpServerEnabled,
  mcpServerRow,
  mcpStatusLabel,
  mcpToggleIntent,
} from "../../../../src/ui/chat/mcpManager.ts"
import type { McpServerStatus, McpServerStatusFact } from "../../../../src/agent/chat/chatMessages.ts"

const fact = (name: string, status: McpServerStatus, toolCount = 0): McpServerStatusFact => ({
  name,
  status,
  toolCount,
})

describe("MCP manager helpers", () => {
  test("enabled is every status except a config-disabled entry", () => {
    expect(mcpServerEnabled(fact("a", "connected"))).toBe(true)
    expect(mcpServerEnabled(fact("a", "idle"))).toBe(true)
    expect(mcpServerEnabled(fact("a", "failed"))).toBe(true)
    expect(mcpServerEnabled(fact("a", "disabled"))).toBe(false)
  })

  test("status label reads connected tool counts, off, and the transient states", () => {
    expect(mcpStatusLabel(fact("a", "connected", 1))).toBe("connected · 1 tool")
    expect(mcpStatusLabel(fact("a", "connected", 5))).toBe("connected · 5 tools")
    expect(mcpStatusLabel(fact("a", "starting"))).toBe("starting…")
    expect(mcpStatusLabel(fact("a", "failed"))).toBe("failed")
    expect(mcpStatusLabel(fact("a", "idle"))).toBe("idle")
    expect(mcpStatusLabel(fact("a", "disabled"))).toBe("off")
  })

  test("row carries the checkbox mark, the name and the status, honouring selection + width", () => {
    const on = mcpServerRow(fact("playwright", "connected", 2), false, 80)
    expect(on).toContain("[x]")
    expect(on).toContain("playwright")
    expect(on).toContain("connected · 2 tools")
    expect(on.startsWith("  ")).toBe(true)

    const selected = mcpServerRow(fact("playwright", "idle"), true, 80)
    expect(selected).toContain("❯ ")
    expect(selected).toContain("[x]")

    const off = mcpServerRow(fact("firecrawl", "disabled"), false, 80)
    expect(off).toContain("[ ]")
    expect(off).toContain("off")

    // A shrinking row is truncated to its budget (opentui repaint rule).
    expect(mcpServerRow(fact("a-very-long-name", "connected", 9), false, 10)).toHaveLength(10)
  })

  test("toggle intent accepts every Enter spelling and Space, nothing else", () => {
    for (const name of ["return", "enter", "linefeed", "space"]) {
      expect(mcpToggleIntent({ name })).toBe(true)
    }
    expect(mcpToggleIntent({ name: "escape" })).toBe(false)
    expect(mcpToggleIntent({ name: "j" })).toBe(false)
  })
})
