/**
 * Color-fidelity smoke (embedded VT, docs/DESIGN.md "Pane color fidelity",
 * docs/terminal-layer.md "Colors"): the real app runs in an OUTER tmux, the
 * pane's shell `printf`s known SGR probes, and the outer capture
 * (`capture-pane -e`) shows exactly what sensus PAINTED.
 *
 * The embedded Ghostty VT composes a FIXED built-in palette (libghostty
 * "Tomorrow Night") and has no remap hook — BUT `src/terminal/sgr.ts`
 * rewrites indexed SGR to truecolor from the palette the host terminal reports
 * (OSC 4) or the config `themePalette.palette` override, re-applies the theme's
 * default fg, and lets `PanePainter` paint the default bg (so the pane
 * background follows the theme instead of the VT's black), before the bytes
 * reach the VT. With no detected palette and
 * no defaults the indexed rewriter is a no-op (VT palette). Cases below:
 *
 * - Detected/override index 1 (`31m`) → that palette's truecolor.
 * - With no palette (this test's default `SENSUS_MOCK=1` sandbox) index 1 keeps
 *   the VT's #CC6666; index 9 → #D54E53; truecolor passes through.
 * - Bold basic fg promotes to the bright entry (`boldBright`, default on).
 * - `paneColors: "index"` disables the rewrite (VT palette).
 * - 256-color `38;5;N` maps through the palette when N is known, else stays.
 * - Truecolor `38;2;r;g;b` always passes through unchanged.
 *
 * The renderer forces truecolor for any non-low-color TERM
 * (`core/colorMode.ts`), so the captured stream above is RGB. With ansi256
 * forced (`SENSUS_COLORTERM=ansi256`) every color is quantized to `38;5;N` /
 * `48;5;N` instead. In neither mode may OpenTUI's fixed low-color VGA snapshot
 * (`38;2;128;0;0` / `38;2;192;192;192`) appear — that is the old
 * "wrong colors in any tty" regression guard.
 *
 * Four boots total; each gets its own SENSUS_HOME sandbox and outer session.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appBootCommand, bootSessionArgv, createHarness, stopSandboxDaemon, writeSmokeConfig, type Harness } from "../helpers.ts"

const h: Harness = createHarness({
  sock: `/tmp/sensus/sensus-colorfidelity-${process.pid}.sock`,
  tag: "color-fidelity",
})

afterAll(async () => {
  await h.killServer()
  try {
    rmSync(h.sock, { force: true })
  } catch {
    // tmux leaves socket files behind on some versions
  }
})

/** Basic, bright, bold-basic, 256-cube, bg, truecolor probes (one line). */
const PROBE =
  "printf 'A:\\033[31mRED\\033[0m B:\\033[91mBRIGHT\\033[0m C:\\033[1;31mBOLDRED\\033[0m D:\\033[38;5;196mCUBE\\033[0m E:\\033[41mREDBG\\033[0m F:\\033[38;2;12;34;56mTRUE\\033[0m\\n'"

/**
 * Boot one app with its own sandbox + outer session, run the probe, wait until
 * `rendered(cap)` holds (a marker that can only exist once the VT painted the
 * output — the shell's typed echo carries no escapes), and return the `-e`
 * capture.
 */
async function runProbe(
  session: string,
  env: string,
  rendered: (cap: string) => boolean,
  config?: Record<string, unknown>,
): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "sensus-colorfidelity-"))
  const sensusHome = join(home, "home")
  mkdirSync(sensusHome, { recursive: true })
  // Pin the topbar layout so the probe pane geometry is stable regardless of
  // the layout default.
  writeSmokeConfig(sensusHome, { layout: "topbar", ...(config ?? {}) })
  const capET = (): Promise<string> => h.capET(`${session}:0`)
  try {
    const start = await h.outer(
      bootSessionArgv(
        session,
        appBootCommand({
          sensusHome,
          bootLog: `/tmp/sensus/colorfidelity-${session}-${process.pid}.stderr.log`,
          env,
        }),
      ),
    )
    expect(start.code).toBe(0)
    await h.waitFor(async () => (await h.capT(`${session}:0`)).includes("no messages yet"), "boot", {
      timeoutMs: 20000,
      dump: () => h.capT(`${session}:0`),
    })
    await h.typeTo(`${session}:0`, PROBE)
    await h.keyTo(`${session}:0`, "Enter")
    await h.waitFor(async () => rendered(await capET()), "probe output rendered", {
      timeoutMs: 15000,
      dump: capET,
    })
    return await capET()
  } finally {
    await h.outer(["kill-session", "-t", session]).catch(() => {})
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

describe("color fidelity: embedded VT fixed palette (in-tmux smoke)", () => {
  test(
    "default truecolor: fixed indices → RGB, 256/truecolor unchanged, bold never brightens",
    async () => {
      const painted = await runProbe("cftrue", "SENSUS_MOCK=1", (cap) => cap.includes("\x1b[38;2;12;34;56mTRUE"))

      // The fixed palette: index 1 #CC6666, index 9 #D54E53.
      expect(painted).toContain("\x1b[38;2;204;102;102mRED")
      expect(painted).toContain("\x1b[38;2;213;78;83mBRIGHT")
      // Bold is preserved as SGR 1 but the base color is NOT promoted to 9.
      expect(painted).toContain("\x1b[1m\x1b[38;2;204;102;102mBOLDRED")
      expect(painted).not.toContain("\x1b[38;2;213;78;83mBOLDRED")
      // Background index 1 resolves through the same fixed palette.
      expect(painted).toContain("\x1b[48;2;204;102;102m")
      // 256-color 196 keeps its value, emitted as RGB.
      expect(painted).toContain("\x1b[38;2;255;0;0mCUBE")
      // Truecolor passes through untouched.
      expect(painted).toContain("\x1b[38;2;12;34;56mTRUE")
      // OpenTUI's fixed low-color VGA snapshot must NEVER appear.
      expect(painted).not.toContain("38;2;128;0;0")
      expect(painted).not.toContain("38;2;192;192;192")
      console.log("[color-fidelity] fixed palette verified (1→204;102;102, 9→213;78;83, bold kept, 256→RGB, truecolor)")
    },
    45_000,
  )

  test(
    "ansi256 renderer mode: pane colors quantize to index SGRs, never the VGA snapshot",
    async () => {
      const painted = await runProbe("cf256", "SENSUS_MOCK=1 SENSUS_COLORTERM=ansi256", (cap) =>
        /\x1b\[38;5;\d+mRED/.test(cap),
      )

      // The typed shell echo wraps and does NOT carry escapes; the rendered row
      // is the one with an index SGR directly on RED.
      const probeLine = painted.split("\n").find((l) => /\x1b\[38;5;\d+mRED/.test(l) && l.includes("TRUE"))
      expect(probeLine).toBeDefined()
      // Every probe is index-based; even truecolor is quantized in this mode.
      expect(probeLine!).toMatch(/\x1b\[38;5;\d+mRED/)
      expect(probeLine!).toMatch(/\x1b\[1m\x1b\[38;5;\d+mBOLDRED/)
      expect(probeLine!).toMatch(/\x1b\[48;5;\d+m/)
      expect(probeLine!).not.toContain("38;2;")
      // The VGA snapshot RGBs must never appear, in either mode.
      expect(painted).not.toContain("38;2;128;0;0")
      expect(painted).not.toContain("38;2;192;192;192")
      console.log("[color-fidelity] ansi256 quantization verified (index SGRs, no VGA snapshot)")
    },
    45_000,
  )

  test(
    "config palette override: indexed pane colors are rewritten to the terminal's palette",
    async () => {
      const painted = await runProbe(
        "cfovr",
        "SENSUS_MOCK=1",
        (cap) => cap.includes("\x1b[38;2;12;34;56mTRUE"),
        // Override indices 0-3 only; other indices stay the VT palette.
        { themePalette: { palette: ["#000000", "#123456", "#00aa00", "#aaaa00"] } },
      )

      // Index 1 (RED / BOLDRED / REDBG) now follows the override, not #CC6666.
      expect(painted).toContain("\x1b[38;2;18;52;86mRED")
      expect(painted).toContain("\x1b[1m\x1b[38;2;18;52;86mBOLDRED")
      expect(painted).toContain("\x1b[48;2;18;52;86m")
      expect(painted).not.toContain("38;2;204;102;102")
      // Truecolor still passes through.
      expect(painted).toContain("\x1b[38;2;12;34;56mTRUE")
      console.log("[color-fidelity] palette override honored (index 1 → 18;52;86)")
    },
    45_000,
  )

  test(
    "theme background: default cells follow the theme, across a live resize",
    async () => {
      // Regression: the VT composes its own default background as opaque black,
      // so blank/redrawn cells used to revert to black on resize and a theme
      // switch. `paintDefaultBackground` repaints them every frame; the override
      // makes the expected background deterministic (#202020 = 32;32;32).
      const home = mkdtempSync(join(tmpdir(), "sensus-colorfidelity-"))
      const sensusHome = join(home, "home")
      mkdirSync(sensusHome, { recursive: true })
      writeSmokeConfig(sensusHome, { layout: "topbar", themePalette: { background: "#202020" } })
      const session = "cfbg"
      const capET = (): Promise<string> => h.capET(`${session}:0`)
      try {
        await h.outer(
          bootSessionArgv(
            session,
            appBootCommand({
              sensusHome,
              bootLog: `/tmp/sensus/colorfidelity-${session}-${process.pid}.stderr.log`,
              env: "SENSUS_MOCK=1",
            }),
          ),
        )
        await h.waitFor(async () => (await h.capT(`${session}:0`)).includes("no messages yet"), "boot", {
          timeoutMs: 20000,
          dump: () => h.capT(`${session}:0`),
        })
        // A wide listing leaves rows of blank cells for the VT to default-fill.
        await h.typeTo(`${session}:0`, "ls -la /")
        await h.keyTo(`${session}:0`, "Enter")
        await h.waitFor(async () => (await capET()).includes("48;2;32;32;32"), "themed pane background", {
          timeoutMs: 15000,
          dump: capET,
        })
        // No cell may carry the VT's opaque black default.
        expect(await capET()).not.toContain("48;2;0;0;0")

        // Resize: the VT recomposes the whole grid; every blank/redrawn cell
        // must come back themed, not black.
        await h.outer(["resize-window", "-t", session, "-x", "96", "-y", "34"])
        await h.waitFor(
          async () => {
            const width = (await h.capT(`${session}:0`)).split("\n")[0]?.length ?? 0
            return width >= 90 && width <= 96
          },
          "resized",
          { timeoutMs: 10000, dump: () => h.capT(`${session}:0`) },
        )
        const after = await capET()
        expect(after).toContain("48;2;32;32;32")
        expect(after).not.toContain("48;2;0;0;0")
        console.log("[color-fidelity] theme background survives resize (32;32;32, no VT black)")
      } finally {
        await h.outer(["kill-session", "-t", session]).catch(() => {})
        // The app detaches (D4): stop the sandbox daemon so it cannot leak.
        await stopSandboxDaemon(sensusHome).catch(() => {})
        try {
          rmSync(home, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    },
    60_000,
  )
})
