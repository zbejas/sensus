/**
 * mcpChip (docs/mcp.md "UI", docs/DESIGN.md "Status bar"): the pure
 * status-bar representation of the active MCP servers. Scenario-shaped —
 * hidden-unless-meaningful, name vs count, and the failure/partial tone.
 */

import { describe, expect, test } from "bun:test"
import { mcpChipPart } from "../../../../src/ui/lib/mcpChip.ts"
import { partText } from "../../../../src/ui/lib/bar.ts"
import type { McpServerStatus, McpServerStatusFact } from "../../../../src/agent/chat/chatMessages.ts"

const fact = (name: string, status: McpServerStatus, toolCount = 0): McpServerStatusFact => ({
  name,
  status,
  toolCount,
})

describe("mcpChipPart", () => {
  test("hidden only when the session toggle is off or no servers are configured", () => {
    expect(mcpChipPart(false, [fact("playwright", "connected", 3)])).toBeNull() // /mcp off
    expect(mcpChipPart(true, [])).toBeNull() // no servers configured
  })

  test("shown before the first message with the enabled count (clickable pre-send)", () => {
    const idle = mcpChipPart(true, [fact("a", "idle"), fact("b", "idle")])
    expect(idle).not.toBeNull()
    expect(partText(idle!)).toBe("mcp:2")
    expect(idle!.spans[1]).toMatchObject({ tone: "value", bold: false })

    // Disabled servers are ignored by the count.
    const mixed = mcpChipPart(true, [fact("a", "idle"), fact("b", "disabled"), fact("c", "idle")])
    expect(partText(mixed!)).toBe("mcp:2")

    // Every configured server deliberately off stays clickable as `mcp:0`.
    const allOff = mcpChipPart(true, [fact("a", "disabled"), fact("b", "disabled")])
    expect(partText(allOff!)).toBe("mcp:0")
  })

  test("one connected server shows its name (capped); several collapse to a count", () => {
    const one = mcpChipPart(true, [fact("playwright", "connected", 5)])
    expect(one).not.toBeNull()
    expect(one!.id).toBe("mcp")
    expect(partText(one!)).toBe("mcp:playwright")
    expect(one!.spans[0]).toMatchObject({ text: "mcp:", tone: "label" })
    expect(one!.spans[1]).toMatchObject({ tone: "value", bold: false })

    // A long name is capped so it cannot crowd the row.
    const long = mcpChipPart(true, [fact("a-very-long-server-name", "connected")])
    expect(partText(long!)).toBe("mcp:a-very-long-ser…")

    // Two or more connected: a count, never a comma-joined list.
    const many = mcpChipPart(true, [fact("a", "connected"), fact("b", "connected"), fact("c", "connected")])
    expect(partText(many!)).toBe("mcp:3")

    // Disabled servers are ignored by the count.
    const withDisabled = mcpChipPart(true, [fact("a", "connected"), fact("b", "disabled")])
    expect(partText(withDisabled!)).toBe("mcp:a")
  })

  test("failures and partial connections warn instead of hiding; starting reads as a plain value", () => {
    // All failed -> 0/1 warning.
    const allFailed = mcpChipPart(true, [fact("a", "failed")])
    expect(partText(allFailed!)).toBe("mcp:0/1")
    expect(allFailed!.spans[1]).toMatchObject({ tone: "warning", bold: true })

    // Some connected, one failed -> connected/total warning (a misconfiguration is visible).
    const partial = mcpChipPart(true, [fact("a", "connected", 2), fact("b", "connected"), fact("c", "failed")])
    expect(partText(partial!)).toBe("mcp:2/3")
    expect(partial!.spans[1]?.tone).toBe("warning")

    // Still starting -> not a warning; a mixed starting+connected set is a partial count.
    const starting = mcpChipPart(true, [fact("a", "starting")])
    expect(partText(starting!)).toBe("mcp:starting")
    expect(starting!.spans[1]?.tone).toBe("value")

    const mixed = mcpChipPart(true, [fact("a", "connected"), fact("b", "starting")])
    expect(partText(mixed!)).toBe("mcp:1/2")
    expect(mixed!.spans[1]?.tone).toBe("value")
  })
})
