/**
 * Terminal detection (extracted from App.tsx): the boot-time OSC probes for the
 * terminal's theme mode (OSC 10/11), palette (OSC 4 + defaults) and
 * capabilities (XTVERSION/DA1), plus the live re-detection events.
 *
 * MOVE-ONLY extraction: the exact probes, timeouts, retries, toasts,
 * `/status` summaries and live `palette`/`capabilities` subscriptions are
 * unchanged. App owns the mutable merged pane palette; it is updated through
 * `deps.onAppliedPalette(merged, override)`, which also pushes the palette to
 * every live session. The returned handle's `reapply()` is what App's single
 * config-change router calls after a config swap; `dispose()` stops the event
 * subscriptions and a late async detection.
 */

import type { CliRenderer } from "@opentui/core"
import { setTerminalMode, setTerminalPalette } from "../../theme/theme.ts"
import {
  isKonsoleDefaultPalette,
  isPaletteAnswered,
  KONSOLE_DEFAULT_NOTE,
  mergePaletteOverride,
  PALETTE_RETRY_DELAYS_MS,
  paletteStatusSummary,
  type PaletteColors,
  type PaletteOverride,
} from "../../theme/themePalette.ts"
import { loadKonsoleScheme, type KonsoleScheme } from "../../theme/konsoleScheme.ts"
import type { UiStore } from "../lib/store.ts"

/** opentui answers the FULL palette (we request 256 entries); the theme
 * derivation uses the entries it needs. */
const toPalette = (colors: PaletteColors): PaletteColors => colors

export interface TerminalDetectionDeps {
  store: UiStore
  renderer: CliRenderer
  /** Config `themePalette` override at call time. */
  themePaletteOverride(): PaletteOverride | null
  /** Set App's mutable pane palette from the merged detection and push it to
   * every live session. */
  onAppliedPalette(merged: PaletteColors | null, override: PaletteOverride | null): void
}

/** The detection bootstrap handle: `reapply` re-merges the config override over
 * the last detection (the single config-change router calls it on every config
 * swap); `dispose` stops the event subscriptions + late async detection. */
export interface TerminalDetectionHandle {
  reapply(): void
  dispose(): void
}

export function startTerminalDetection(deps: TerminalDetectionDeps): TerminalDetectionHandle {
  const { store, renderer } = deps
  let disposed = false
  /** One-shot: the no-color-capability warning must not repeat per event. */
  let warnedNoColor = false
  /** One-shot: Konsole's OSC-4 lie is worth explaining once per boot. */
  let warnedKonsole = false
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /** Last raw detection — /reload re-merges it with the (possibly edited)
   * themePalette override without re-probing the terminal. */
  let lastDetection: { colors: PaletteColors | null; attempts: number } | null = null

  /** Merge the config `themePalette` override (if any) over the detected
   * colors and publish: theme tokens + /status line. The embedded terminal
   * paints its own colors, so no pane paint map is derived here. */
  const applyDetected = (colors: PaletteColors | null, attempts: number): void => {
    lastDetection = { colors, attempts }
    const override = deps.themePaletteOverride()
    // KDE terminals (Konsole/Yakuake) answer OSC 4 with a compiled-in table,
    // not the active scheme. When that is the detection, read the real scheme
    // from KDE's on-disk profile chain and merge it OVER the detection (0-15 +
    // fg/bg; the standard 16-255 cube is kept from the detection) so the pane
    // and adaptive chrome match the terminal. A config pin still wins; a failed
    // read keeps the VT-palette fallback (sgr.ts drops the lying row).
    let scheme: KonsoleScheme | null = null
    let schemeReason: string | null = null
    let detected = colors
    if (isKonsoleDefaultPalette(colors)) {
      const load = loadKonsoleScheme({
        // OSC 10/11 are truthful even when Konsole's OSC 4 lies; they let the
        // reader fingerprint the active scheme when the profile chain fails.
        detected: {
          foreground: colors?.defaultForeground ?? null,
          background: colors?.defaultBackground ?? null,
        },
      })
      scheme = load.scheme
      schemeReason = load.reason
      if (scheme !== null) {
        const fromScheme: PaletteOverride = {
          palette: scheme.palette,
          ...(scheme.foreground !== null ? { foreground: scheme.foreground } : {}),
          ...(scheme.background !== null ? { background: scheme.background } : {}),
        }
        detected = mergePaletteOverride(colors, fromScheme)
      }
    }
    const merged = mergePaletteOverride(detected, override)
    setTerminalPalette(merged)
    // Pane palette for the SGR rewriter (embedded VT has no host hook).
    deps.onAppliedPalette(merged, override)
    const paletteSource =
      scheme !== null
        ? `KDE scheme${scheme.name !== "" ? ` "${scheme.name}"` : ""}`
        : schemeReason !== null
          ? `KDE scheme lookup: ${schemeReason}`
          : null
    store.setPaletteStatus(paletteStatusSummary(merged, attempts, paletteSource))
    // Read failed: Konsole's lying table is still in play, so the pane falls
    // back to the VT palette. Say so once and point at the pin.
    if (!warnedKonsole && isKonsoleDefaultPalette(merged)) {
      warnedKonsole = true
      store.showToast(KONSOLE_DEFAULT_NOTE, "warn", 6000)
    }
  }
  /**
   * The single config-change router (App) calls this on every successful config
   * swap, re-merging the (possibly edited) `themePalette` override without
   * re-probing the terminal. Previously a private setOnReloaded hook did this.
   */
  const reapply = (): void => {
    applyDetected(lastDetection?.colors ?? null, lastDetection?.attempts ?? 1)
  }
  void (async () => {
    try {
      const mode = await renderer.waitForThemeMode(800)
      if (mode !== null) setTerminalMode(mode)
    } catch {
      // detection is optional
    }
    try {
      let colors: PaletteColors = toPalette(await renderer.getPalette({ size: 256, timeout: 1500 }))
      let attempts = 1
      while (!isPaletteAnswered(colors) && attempts <= PALETTE_RETRY_DELAYS_MS.length) {
        await sleep(PALETTE_RETRY_DELAYS_MS[attempts - 1] ?? 1000)
        if (disposed) return
        renderer.clearPaletteCache()
        colors = toPalette(await renderer.getPalette({ size: 256, timeout: 1500 }))
        attempts++
      }
      if (disposed) return
      applyDetected(colors, attempts)
    } catch {
      // palette detection is optional (suspended renderer / unsupported terminal)
      store.setPaletteStatus(paletteStatusSummary(null, 1))
    }
  })()
  // opentui re-detects the palette on lifecycle events; a "palette"
  // emission carries the colors payload — apply it directly (live theme
  // changes in the terminal propagate without restart; the config-change
  // router re-applies the themePalette override via `reapply` above).
  const onPalette = (colors: PaletteColors): void => {
    try {
      applyDetected(toPalette(colors), 1)
    } catch {
      // never let a malformed palette payload take the TUI down
    }
  }
  try {
    renderer.on("palette", onPalette)
  } catch {
    // event subscription is optional (older renderer builds)
  }
  // Terminal-family detection (XTVERSION/DA1): shows in /status. Re-detected
  // on "capabilities" events (live).
  const applyCapabilities = (caps: unknown): void => {
    const obj =
      typeof caps === "object" && caps !== null
        ? (caps as {
            terminal?: { name?: string | null }
            rgb?: boolean
            ansi256?: boolean
          })
        : null
    store.setTerminalInfo({ name: obj?.terminal?.name ?? null })
    // Capability guard (src/core/colorMode.ts): when OpenTUI cannot confirm
    // 256/truecolor it substitutes a FIXED RGB snapshot for every indexed
    // color (`RGBA.fromIndex(1)` → `38;2;128;0;0`), so basic shell colors are
    // wrong in every terminal. The boot force prevents that for all non-
    // low-color TERMs; if it still happens (a genuine 8/16-color terminal, or
    // a future regression) say so once instead of failing silently.
    if (!warnedNoColor && obj && obj.rgb === false && obj.ansi256 === false) {
      warnedNoColor = true
      store.showToast(
        "terminal color capability not detected — pane colors are approximate; set themePalette.colorMode (see /status)",
        "warn",
        6000,
      )
    }
  }
  applyCapabilities(renderer.capabilities)
  const onCapabilities = (caps: unknown): void => {
    try {
      applyCapabilities(caps)
    } catch {
      // never let a malformed payload take the TUI down
    }
  }
  try {
    renderer.on("capabilities", onCapabilities)
  } catch {
    // event subscription is optional (older renderer builds)
  }

  return {
    reapply,
    dispose: () => {
      disposed = true
      try {
        renderer.off("palette", onPalette)
      } catch {
        // renderer may be mid-teardown on exit
      }
      try {
        renderer.off("capabilities", onCapabilities)
      } catch {
        // renderer may be mid-teardown on exit
      }
    },
  }
}
