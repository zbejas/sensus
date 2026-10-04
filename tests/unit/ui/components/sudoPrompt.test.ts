/**
 * SudoPrompt pure helper: the modal wraps the agent's command instead of
 * truncating it (regression — a long command was cut to the card width, so the
 * user could not read what they were authorizing). No renderer, no tmux.
 */

import { describe, expect, test } from "bun:test"
import { sudoCardWidth, wrapCommand } from "../../../../src/ui/components/SudoPrompt.tsx"

describe("wrapCommand (sudo modal command rendering)", () => {
  test("a command that fits stays on one row", () => {
    expect(wrapCommand("sudo systemctl restart nginx", 40, 20)).toEqual(["sudo systemctl restart nginx"])
  })

  test("a long line wraps across rows and loses no characters", () => {
    const cmd = "sudo bash -c 'echo aaaaaaaa bbbbbbbb cccccccc dddddddd'"
    const rows = wrapCommand(cmd, 16, 20)
    expect(rows.every((r) => [...r].length <= 16)).toBe(true)
    expect(rows.join("")).toBe(cmd.replace(/\n/g, ""))
  })

  test("newlines split into separate logical lines and empty lines survive", () => {
    expect(wrapCommand("sudo a\n\nsudo b", 20, 20)).toEqual(["sudo a", "", "sudo b"])
  })

  test("rows are capped, marking the cut with an ellipsis", () => {
    const rows = wrapCommand("x".repeat(100), 10, 3)
    expect(rows).toEqual(["xxxxxxxxxx", "xxxxxxxxxx", "…"])
  })

  test("an empty command yields one empty row", () => {
    expect(wrapCommand("", 20, 5)).toEqual([""])
  })
})

describe("sudoCardWidth (sudo modal width)", () => {
  test("a short command keeps the base width", () => {
    expect(sudoCardWidth("sudo true", 200)).toBe(72)
  })

  test("a long command widens the card, clamped to the terminal", () => {
    expect(sudoCardWidth("x".repeat(90), 200)).toBe(94)
    // Wider than the terminal → clamped to width−margin.
    expect(sudoCardWidth("x".repeat(400), 100)).toBe(96)
  })

  test("the longest logical line drives the width, not total length", () => {
    expect(sudoCardWidth("sudo a\nsudo bb", 200)).toBe(72)
    expect(sudoCardWidth(`sudo a\n${"y".repeat(80)}`, 200)).toBe(84)
  })

  test("a tiny terminal still yields a drawable card", () => {
    expect(sudoCardWidth("sudo true", 10)).toBe(16)
  })
})
