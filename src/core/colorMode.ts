/**
 * Renderer color-mode resolution (docs/DESIGN.md "Pane color fidelity",
 * docs/config.md `themePalette.colorMode`).
 *
 * OpenTUI's native renderer decides ONCE, around library load, whether the
 * terminal is truecolor, from the environment (`COLORTERM`/`TERM`). When it
 * thinks the terminal is 256-color it quantizes EVERY RGB color — pane
 * truecolor content AND the theme's RGB chrome — to a lossy `38;5;N` (verified
 * black-box: `#bf616a` -> `38;5;131`). SSH and some multiplexers strip
 * `COLORTERM`, so a 24-bit terminal silently degrades to 256 colors. That was
 * the first field report: "wrong colors in any tty, only inside sensus".
 *
 * Worse, when it thinks the terminal is LOW-color (no 256) it has no legacy-SGR
 * path at all: `RGBA.fromIndex(N)` is emitted as a FIXED `38;2` VGA snapshot
 * (`index 1` -> `38;2;128;0;0`, `7` -> `38;2;192;192;192`), never `30-37`. With
 * `TERM=xterm`/`xterm-color`/`screen`/`tmux`/empty and no `COLORTERM`, every
 * indexed shell color (the whole basic/oh-my-zsh palette) was therefore a
 * hardcoded RGB, wrong in every terminal. That was the second report.
 * `resolveColorMode` forces the index-capable mode for every non-low-color TERM
 * to prevent it.
 *
 * `core/colorModeBoot.ts` calls `applyColorMode()` before `@opentui/core` is
 * imported (it is the first import in `src/index.tsx`), setting `COLORTERM` so
 * the native renderer keeps truecolor (and the embedded PTY inherits it, so
 * inner apps emit truecolor too — see src/terminal/session.ts).
 *
 * This module is PURE (env in, decision out) except for `applyColorMode`/
 * `resolvedColorMode`, which touch `process.env` / module state. It imports no
 * runtime module (opentui, config, theme) so it is safe to evaluate first.
 *
 * Precedence:
 *   1. config `themePalette.colorMode` ("truecolor" | "ansi256") — restart-only
 *   2. env `SENSUS_COLORTERM` ("truecolor" | "ansi256")
 *   3. auto: force truecolor for any TERM that is not a known low-color one
 *      (`LOW_COLOR_TERMS`), leaving genuine 8/16-color terminals, an explicit
 *      truecolor `COLORTERM` (`truecolor`/`24bit`, the only values OpenTUI
 *      understands), and `NO_COLOR` alone. The force is what stops OpenTUI
 *      substituting its fixed RGB snapshot for indexed colors (see the
 *      `LOW_COLOR_TERMS` comment).
 */

import { readFileSync } from "node:fs"

/** Effective renderer color mode. `auto` = leave OpenTUI's own detection. */
export type ColorMode = "auto" | "truecolor" | "ansi256"

/**
 * TERMs that genuinely run in 8/16 colors (or no color): forcing 24-bit would
 * over-promise, so OpenTUI's own detection is left alone. Everything else is
 * forced truecolor — because OpenTUI's fallback for an unrecognized terminal is
 * NOT legacy SGR: it substitutes a fixed VGA snapshot RGB for every indexed
 * color (`RGBA.fromIndex(1)` → `38;2;128;0;0`), which is wrong in EVERY
 * terminal. The regression that motivated this list hit exactly the TERMs the
 * old allow-list left alone: `xterm`, `xterm-color`, `screen`, `tmux`, and an
 * empty `TERM` (bare/SSH, no outer multiplexer).
 *
 * The force does not weaken the existing protections: an explicit truecolor
 * `COLORTERM` (`truecolor`/`24bit`), `NO_COLOR`, or config
 * `themePalette.colorMode` still wins (see `resolveColorMode`).
 */
const LOW_COLOR_TERMS = new Set([
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
])

/**
 * Is this TERM known to be low-color (8/16)? Empty/unknown TERMs are NOT
 * low-color: leaving them to OpenTUI would bake the fixed RGB snapshot, so the
 * auto policy forces the index-capable mode instead.
 */
export function isLowColorTerm(term: string | undefined): boolean {
  const t = (term ?? "").trim().toLowerCase()
  if (t === "") return false
  return LOW_COLOR_TERMS.has(t)
}

/**
 * The color mode to apply, given the environment and the config value.
 * Pure — no side effects (unit-tested).
 */
export function resolveColorMode(env: NodeJS.ProcessEnv, configured?: ColorMode | null): ColorMode {
  if (configured === "truecolor" || configured === "ansi256") return configured
  const forced = env["SENSUS_COLORTERM"]
  if (forced === "truecolor" || forced === "ansi256") return forced
  // Honor the user's explicit opt-outs / declarations.
  if (env["NO_COLOR"]) return "auto"
  // Only a COLORTERM OpenTUI 0.5.11 actually understands (truecolor/24bit) is
  // truthful — leave its detection alone. Any other value (notably
  // `COLORTERM=256color`, which some terminals set) is NOT recognized by
  // OpenTUI: it degrades to the low-color snapshot. Fall through to the force
  // so those terminals keep index intent too.
  const colorterm = (env["COLORTERM"] ?? "").trim().toLowerCase()
  if (colorterm === "truecolor" || colorterm === "24bit") return "auto"
  if (isLowColorTerm(env["TERM"])) return "auto"
  return "truecolor"
}

/**
 * Read `themePalette.colorMode` straight from the config FILE. This module runs
 * before config.ts (which transitively imports opentui via theme.ts), so it
 * resolves the path itself — kept byte-identical to `sensusHomeFrom` in
 * config/config.ts (SENSUS_HOME redirects the location; invalid JSON is
 * ignored — config.ts owns the warnings).
 */
export function readConfiguredColorMode(env: NodeJS.ProcessEnv): ColorMode | null {
  const home = env["SENSUS_HOME"] ?? `${env["HOME"] ?? ""}/.config/sensus`
  try {
    const raw = JSON.parse(readFileSync(`${home}/config.json`, "utf8")) as {
      themePalette?: { colorMode?: unknown }
    }
    const mode = raw?.themePalette?.colorMode
    if (mode === "auto" || mode === "truecolor" || mode === "ansi256") return mode
  } catch {
    // missing/invalid config — config.ts surfaces the real error
  }
  return null
}

/** Module state: the mode applied at boot (shown in /status). */
let resolved: ColorMode = "auto"

/**
 * Resolve and apply the mode to `env` (default `process.env`). Sets
 * `COLORTERM=truecolor` to keep truecolor, deletes it to force 256. Returns the
 * effective mode. Idempotent.
 */
export function applyColorMode(env: NodeJS.ProcessEnv = process.env): ColorMode {
  const configured = readConfiguredColorMode(env)
  resolved = resolveColorMode(env, configured)
  if (resolved === "truecolor") env["COLORTERM"] = "truecolor"
  else if (resolved === "ansi256") delete env["COLORTERM"]
  return resolved
}

/** The mode applied at boot (`auto` when OpenTUI's detection was left alone). */
export function resolvedColorMode(): ColorMode {
  return resolved
}
