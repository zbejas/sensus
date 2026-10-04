/**
 * Pane-state probe + delivery acknowledgement (docs/terminal-layer.md "Pane
 * state"): scenario fixtures for each visible-pane state, classified from the
 * live screen grid the embedded VT composes — never from scrollback. The probe
 * is pure and must classify an unrecognizable screen as `unknown` without
 * throwing (AGENTS.md rule 10).
 */

import { describe, expect, test } from "bun:test"
import {
  classifyPaneState,
  formatPaneEvidence,
  looksLikeShellPrompt,
  paneStateRefusal,
  paneStateSummary,
  sanitizePaneTail,
} from "../../../src/terminal/paneState.ts"
import { verifyPaneDelivery } from "../../../src/terminal/delivery.ts"

describe("classifyPaneState: shell prompt", () => {
  test("zsh/bash/root prompts classify as prompt", () => {
    expect(classifyPaneState({ lines: ["user@host ~ %"], commandRunning: false }).state).toBe("prompt")
    expect(classifyPaneState({ lines: ["output", "user@host:~$"] }).state).toBe("prompt")
    expect(classifyPaneState({ lines: ["# "] }).state).toBe("prompt")
    expect(classifyPaneState({ lines: ["~/p ❯ "] }).state).toBe("prompt")
  })

  test("a prompt with pending input still reads as a prompt (safe to append)", () => {
    const s = classifyPaneState({ lines: ["user@host ~ % ls -la"] })
    expect(s.state).toBe("prompt")
    expect(s.confidence).toBeGreaterThan(0)
  })

  test("OSC 133 idle with no recognizable prompt still reads as prompt (lower confidence)", () => {
    const s = classifyPaneState({ lines: ["some idle output"], commandRunning: false })
    expect(s.state).toBe("prompt")
    expect(s.confidence).toBeLessThan(0.8)
  })
})

describe("classifyPaneState: shell continuations (the 2026-09-28 swallow)", () => {
  test("dquote> classifies as a dquote continuation with the open quote visible", () => {
    const s = classifyPaneState({ lines: ['user@host ~ % echo "abc', "dquote> "] })
    expect(s.state).toBe("continuation")
    expect(s.continuationKind).toBe("dquote")
    expect(s.tail.join("\n")).toContain("dquote>")
    expect(s.lastCommand).toBeNull()
  })

  test("quote>/heredoc>/cmdsubst>/bquote> map to their kinds", () => {
    expect(classifyPaneState({ lines: ["quote>"] }).continuationKind).toBe("quote")
    expect(classifyPaneState({ lines: ["heredoc>"] }).continuationKind).toBe("heredoc")
    expect(classifyPaneState({ lines: ["cmdsubst>"] }).continuationKind).toBe("paren")
    expect(classifyPaneState({ lines: ["bquote>"] }).continuationKind).toBe("backtick")
    const pipe = classifyPaneState({ lines: ["pipe>"] })
    expect(pipe.state).toBe("continuation")
    expect(pipe.continuationKind).toBeUndefined()
  })

  test("a bare bash PS2 '> ' is a continuation (lower confidence)", () => {
    const s = classifyPaneState({ lines: ["> "] })
    expect(s.state).toBe("continuation")
    expect(s.confidence).toBeLessThan(0.9)
  })
})

describe("classifyPaneState: running / password / fullscreen", () => {
  test("OSC 133 command-running outranks the screen shape", () => {
    const s = classifyPaneState({ lines: ["% sleep 30"], commandRunning: true })
    expect(s.state).toBe("running")
    expect(s.confidence).toBeGreaterThan(0.5)
  })

  test("sudo and ssh password prompts classify as password-prompt", () => {
    expect(classifyPaneState({ lines: ["[sudo] password for alice:"] }).state).toBe("password-prompt")
    expect(classifyPaneState({ lines: ["alice@host's password:"] }).state).toBe("password-prompt")
    expect(classifyPaneState({ lines: ["Password:"] }).state).toBe("password-prompt")
    expect(classifyPaneState({ lines: ["Enter passphrase for key '/home/a/id_ed25519':"] }).state).toBe(
      "password-prompt",
    )
  })

  test("an ssh host-key confirmation also reads as waiting for input", () => {
    const s = classifyPaneState({
      lines: ["The authenticity of host 'x' can't be established.", "Are you sure you want to continue connecting (yes/no/[fingerprint])?"],
    })
    expect(s.state).toBe("password-prompt")
  })

  test("alternate screen (vim/htop/less) classifies as fullscreen", () => {
    const s = classifyPaneState({ lines: ["1 hello", "~", "~", '"file" 1L'], alternateOn: true })
    expect(s.state).toBe("fullscreen")
  })
})

describe("classifyPaneState: unknown and never-throw", () => {
  test("an unrecognizable screen is unknown, not an exception", () => {
    const s = classifyPaneState({ lines: ["total 0", "drwxr-xr-x 2 a a", "some inscrutable output"] })
    expect(s.state).toBe("unknown")
    expect(s.confidence).toBe(0)
    expect(paneStateRefusal(s)).toBeNull()
  })

  test("empty / malformed input never throws", () => {
    expect(() => classifyPaneState({ lines: [] })).not.toThrow()
    expect(classifyPaneState({ lines: [] }).state).toBe("unknown")
    // Defensive: a non-array leaking in from a native surprise must not crash.
    expect(classifyPaneState({ lines: null as unknown as string[] }).state).toBe("unknown")
  })
})

describe("paneStateRefusal / evidence / summary", () => {
  test("refuses only confident non-prompt states; unknown and prompt proceed", () => {
    expect(paneStateRefusal(classifyPaneState({ lines: ['% echo "x', "dquote>"] }))).toContain("dquote")
    expect(paneStateRefusal(classifyPaneState({ lines: ["% sleep 9"], commandRunning: true }))).toContain("running")
    expect(paneStateRefusal(classifyPaneState({ lines: ["[sudo] password for a:"] }))).toContain("password")
    expect(paneStateRefusal(classifyPaneState({ lines: ["x"], alternateOn: true }))).toContain("full-screen")
    expect(paneStateRefusal(classifyPaneState({ lines: ["% "] }))).toBeNull()
    expect(paneStateRefusal(classifyPaneState({ lines: ["inscrutable"] }))).toBeNull()
    expect(paneStateRefusal(null)).toBeNull()
  })

  test("evidence + summary render sanely; sanitize strips controls and caps length", () => {
    const s = classifyPaneState({ lines: ['% echo "abc', "dquote> "] })
    expect(formatPaneEvidence(s)).toContain("dquote>")
    expect(paneStateSummary(s)).toContain("dquote")
    const tail = sanitizePaneTail([`a\u0007b\tc${"x".repeat(500)}`], 3)
    expect(tail[0]?.startsWith("ab    c")).toBe(true)
    expect(tail[0]?.length).toBeLessThanOrEqual(201)
  })

  test("looksLikeShellPrompt distinguishes a prompt from output", () => {
    expect(looksLikeShellPrompt("user@host ~ %")).toBe(true)
    expect(looksLikeShellPrompt("ordinary output")).toBe(false)
  })
})

describe("verifyPaneDelivery: bounded echo/prompt-anchored acknowledgement", () => {
  test("delivered when the typed text appears and the screen changed", () => {
    expect(
      verifyPaneDelivery({
        text: "ls -la",
        before: ["user@host ~ %"],
        after: ["user@host ~ %", "% ls -la", "file.txt"],
        submitted: true,
      }),
    ).toBe("delivered")
  })

  test("unverified when the echo never appears (a silently swallowed write)", () => {
    expect(
      verifyPaneDelivery({
        text: "rm -rf build",
        before: ["user@host ~ %"],
        after: ["user@host ~ %"],
        submitted: true,
      }),
    ).toBe("unverified")
    // Text present in BEFORE only (nothing changed) is not evidence.
    expect(
      verifyPaneDelivery({
        text: "ls",
        before: ["% ls"],
        after: ["% ls"],
        submitted: true,
      }),
    ).toBe("unverified")
  })

  test("a keys-only call is delivered when the screen changed, unverified otherwise", () => {
    expect(verifyPaneDelivery({ text: "", before: ["% "], after: ["% ", "output"], submitted: true })).toBe("delivered")
    expect(verifyPaneDelivery({ text: "", before: ["% "], after: ["% "], submitted: true })).toBe("unverified")
  })

  test("a wrapped/long echo still matches on its normalized prefix; malformed input never throws", () => {
    const long = "echo " + "y".repeat(120)
    expect(
      verifyPaneDelivery({ text: long, before: [], after: [long], submitted: true }),
    ).toBe("delivered")
    expect(() => verifyPaneDelivery({ text: "x", before: null as unknown as string[], after: [], submitted: true })).not.toThrow()
  })
})
