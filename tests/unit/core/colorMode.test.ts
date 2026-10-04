import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applyColorMode,
  isLowColorTerm,
  readConfiguredColorMode,
  resolveColorMode,
} from "../../../src/core/colorMode.ts"

const base = (extra: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  ({ ...extra }) as NodeJS.ProcessEnv

describe("isLowColorTerm", () => {
  test("known 8/16-color terminfo is low-color (case/whitespace normalized)", () => {
    for (const term of [
      "dumb",
      "unknown",
      "linux",
      "cons25",
      "cons50",
      "cons60",
      "vt100",
      "vt101",
      "vt102",
      "vt220",
      "vt320",
      "vt52",
      "ansi",
      "sun",
      "hpterm",
      "pcansi",
      "ibm",
      "mach",
      "nsterm-16color",
      "eterm-color",
      " LINUX ",
      "VT100",
    ]) {
      expect(isLowColorTerm(term), term).toBe(true)
    }
  })

  test("everything else — including bare xterm/screen/tmux and unknown TERMs — is not", () => {
    for (const term of ["xterm", "xterm-color", "screen", "tmux", "xterm-256color", ""]) {
      expect(isLowColorTerm(term), term).toBe(false)
    }
    expect(isLowColorTerm(undefined)).toBe(false)
  })
})

describe("resolveColorMode", () => {
  test("explicit config wins over everything", () => {
    expect(resolveColorMode(base({ TERM: "linux" }), "truecolor")).toBe("truecolor")
    expect(resolveColorMode(base({ TERM: "xterm-256color" }), "ansi256")).toBe("ansi256")
    expect(resolveColorMode(base({ COLORTERM: "truecolor" }), "ansi256")).toBe("ansi256")
  })

  test("SENSUS_COLORTERM env is the next fallback", () => {
    expect(resolveColorMode(base({ TERM: "linux", SENSUS_COLORTERM: "truecolor" }))).toBe("truecolor")
    expect(resolveColorMode(base({ TERM: "xterm-256color", SENSUS_COLORTERM: "ansi256" }))).toBe("ansi256")
  })

  test("forced truecolor when a 24-bit TERM drops COLORTERM (the SSH bug)", () => {
    expect(resolveColorMode(base({ TERM: "xterm-256color" }))).toBe("truecolor")
    expect(resolveColorMode(base({ TERM: "tmux-256color" }))).toBe("truecolor")
    expect(resolveColorMode(base({ TERM: "xterm-kitty" }))).toBe("truecolor")
  })

  test("regression: bare xterm/screen/tmux/empty TERM (no COLORTERM) force truecolor", () => {
    // The old allow-list left these to OpenTUI, which then substituted a fixed
    // RGB VGA snapshot (`38;2;128;0;0`) for every indexed color instead of SGR.
    for (const term of ["xterm", "xterm-color", "screen", "tmux"]) {
      expect(resolveColorMode(base({ TERM: term })), term).toBe("truecolor")
    }
    expect(resolveColorMode(base({}))).toBe("truecolor")
  })

  test("auto only for a COLORTERM OpenTUI understands, NO_COLOR, or a known low-color TERM", () => {
    // Already declared (truecolor/24bit) — never second-guess a truthful value.
    expect(resolveColorMode(base({ TERM: "xterm-256color", COLORTERM: "truecolor" }))).toBe("auto")
    expect(resolveColorMode(base({ TERM: "xterm-256color", COLORTERM: "24bit" }))).toBe("auto")
    // `COLORTERM=256color` is NOT understood by OpenTUI 0.5.11 (it would
    // snapshot every indexed color), so it must NOT opt out of the force.
    expect(resolveColorMode(base({ TERM: "xterm", COLORTERM: "256color" }))).toBe("truecolor")
    // Explicit opt-out.
    expect(resolveColorMode(base({ TERM: "xterm-256color", NO_COLOR: "1" }))).toBe("auto")
    expect(resolveColorMode(base({ TERM: "xterm", NO_COLOR: "1" }))).toBe("auto")
    // Genuinely low-color terminals are left alone.
    expect(resolveColorMode(base({ TERM: "linux" }))).toBe("auto")
    expect(resolveColorMode(base({ TERM: "dumb" }))).toBe("auto")
    expect(resolveColorMode(base({ TERM: "vt100" }))).toBe("auto")
  })
})

describe("applyColorMode", () => {
  test("auto + bare xterm sets COLORTERM=truecolor", () => {
    const env = base({ TERM: "xterm" })
    expect(applyColorMode(env)).toBe("truecolor")
    expect(env["COLORTERM"]).toBe("truecolor")
  })

  test("ansi256 deletes COLORTERM so OpenTUI quantizes to 256", () => {
    const env = base({ TERM: "xterm-256color", COLORTERM: "truecolor", SENSUS_COLORTERM: "ansi256" })
    expect(applyColorMode(env)).toBe("ansi256")
    expect(env["COLORTERM"]).toBeUndefined()
  })

  test("leaves the environment untouched in auto", () => {
    const env = base({ TERM: "linux" })
    expect(applyColorMode(env)).toBe("auto")
    expect(env["COLORTERM"]).toBeUndefined()
  })
})

describe("readConfiguredColorMode", () => {
  test("reads themePalette.colorMode from the SENSUS_HOME config file", () => {
    const home = mkdtempSync(join(tmpdir(), "sensus-colormode-"))
    try {
      writeFileSync(join(home, "config.json"), JSON.stringify({ themePalette: { colorMode: "ansi256" } }))
      expect(readConfiguredColorMode(base({ SENSUS_HOME: home }))).toBe("ansi256")
      writeFileSync(join(home, "config.json"), JSON.stringify({ themePalette: { colorMode: "bogus" } }))
      expect(readConfiguredColorMode(base({ SENSUS_HOME: home }))).toBeNull()
      writeFileSync(join(home, "config.json"), "{ not json")
      expect(readConfiguredColorMode(base({ SENSUS_HOME: home }))).toBeNull()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("bootstrap wiring", () => {
  // The fix is only effective if the bootstrap module evaluates BEFORE
  // @opentui/core: OpenTUI reads the color capability around library load.
  // (The tmux-based smoke suite cannot observe this — it boots under tmux,
  // where RGB already passes through — so guard the import order here.)
  test("src/index.tsx imports colorModeBoot before @opentui/core", () => {
    const src = readFileSync(new URL("../../../src/index.tsx", import.meta.url), "utf8")
    const bootAt = src.indexOf('"./core/colorModeBoot.ts"')
    const opentuiAt = src.indexOf('"@opentui/core"')
    expect(bootAt).toBeGreaterThan(-1)
    expect(opentuiAt).toBeGreaterThan(-1)
    expect(bootAt).toBeLessThan(opentuiAt)
  })

  // Over SSH, OpenTUI treats the session as a remote renderer with forwarded
  // env and early-returns before applying COLORTERM/TERM (terminal.zig
  // checkEnvironmentOverrides), so the forced color mode never reaches the
  // native renderer and indexed colors fall back to the VGA snapshot. Every
  // createCliRenderer call must therefore opt out with `remote: false`.
  test("every createCliRenderer call pins remote: false (SSH capability guard)", () => {
    const src = readFileSync(new URL("../../../src/index.tsx", import.meta.url), "utf8")
    const calls = src.split("createCliRenderer({").slice(1)
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.slice(0, 200)).toContain("remote: false")
    }
  })
})
