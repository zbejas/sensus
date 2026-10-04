/**
 * KDE (Konsole/Yakuake) color-scheme reader (docs/DESIGN.md "Pane color
 * fidelity", docs/config.md "themePalette").
 *
 * Konsole's OSC 4 reporter answers with its compiled-in default table, never
 * the active scheme (`isKonsoleDefaultPalette` fingerprints that lie), so the
 * pane cannot follow the terminal's real 0-15 palette from detection alone —
 * it would repaint the shell with saturated primaries. The active scheme IS,
 * however, on disk, and reachable three ways (tried in order):
 *
 * 1. `KONSOLE_PROFILE_NAME` → `<data>/konsole/<profile>.profile`
 *    (`[Appearance] ColorScheme=<name>` → `<name>.colorscheme`). LEGACY:
 *    modern Konsole (KDE Plasma 5/6) no longer exports this variable — the
 *    session env is only COLORFGBG/SHELL_SESSION_ID/WINDOWID/KONSOLE_DBUS_*.
 * 2. The session's D-Bus profile: `KONSOLE_DBUS_SERVICE` + `KONSOLE_DBUS_SESSION`
 *    are still exported, and `org.kde.konsole.Session.profile()` returns the
 *    name of THIS session's profile (not the default — a tab may use another).
 *    Read with `dbus-send` (injectable for tests); no-op when unavailable.
 * 3. `konsolerc` `[Desktop Entry] DefaultProfile` (older configs / no D-Bus).
 *    The hosting app's rc for konsolepart (yakuakerc/dolphinrc/katerc) is not
 *    consulted; the fingerprint below covers those.
 *
 * If the profile chain still fails, the ACTIVE SCHEME is fingerprinted from the
 * truthful OSC 10/11 defaults: every installed `*.colorscheme` whose
 * `[Foreground]`/`[Background]` match the terminal's reported defaults is a
 * candidate, and the first match is used. This catches modern Konsole, Yakuake
 * and any konsolepart host regardless of profile configuration, with no
 * subprocess. (The defaults are unique across the shipped schemes in practice;
 * a tie resolves to the first scheme in the search order.)
 *
 * (The property table in Konsole's `Profile.cpp` puts `ColorScheme` in the
 * `Appearance` group; older configs also wrote a root `colors=` key.)
 *
 * This module reads that chain best-effort. Any missing/garbage step returns
 * null plus a short reason for `/status`, and the caller keeps the VT-palette
 * fallback. The parsers are pure (unit-tested); the filesystem/D-Bus wrapper
 * never throws.
 *
 * Konsole only defines the normal 0-7 and bright 8-15 (as `ColorNIntense`) in a
 * scheme; 16-255 are the standard xterm cube (truthful), so the caller merges
 * these entries OVER the detection and keeps entries 16-255 from it.
 */

import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { rgbToHex } from "../core/util.ts"
import { parseHexColor } from "./themePalette.ts"

/** A parsed KDE color scheme: ANSI 0-15 plus the default fg/bg. */
export interface KonsoleScheme {
  /** 16 lowercase `#rrggbb` entries (ANSI 0-15). */
  readonly palette: readonly string[]
  readonly foreground: string | null
  readonly background: string | null
  /** The scheme's display name (`[General] Description`), `""` when absent. */
  readonly name: string
}

/** `r,g,b` (0-255, Konsole's `Color=` form) or any `parseHexColor` format. */
function parseKonsoleColor(value: string | undefined): string | null {
  if (typeof value !== "string") return null
  const v = value.trim()
  // Konsole writes `Color=r,g,b` and, when alpha < 255, `Color=r,g,b,a`.
  const m = /^(-?\d{1,3})\s*,\s*(-?\d{1,3})\s*,\s*(-?\d{1,3})(?:\s*,\s*-?\d{1,3})?$/.exec(v)
  if (m) {
    const ch = (s: string): number => Math.min(255, Math.max(0, Number(s)))
    return rgbToHex(ch(m[1] ?? "0"), ch(m[2] ?? "0"), ch(m[3] ?? "0"))
  }
  const rgb = parseHexColor(v)
  return rgb ? rgbToHex(rgb.r, rgb.g, rgb.b) : null
}

/** Parse a `.colorscheme` / `.profile` INI body into `[section] → {key: value}`. */
function parseIni(text: string): Map<string, Record<string, string>> {
  const sections = new Map<string, Record<string, string>>()
  let current = ""
  sections.set(current, {}) // root (ungrouped keys)
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue
    const section = /^\[(.+)\]$/.exec(line)
    if (section) {
      current = (section[1] ?? "").trim()
      if (!sections.has(current)) sections.set(current, {})
      continue
    }
    const eq = line.indexOf("=")
    if (eq <= 0) continue
    const bucket = sections.get(current)
    if (bucket) bucket[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return sections
}

/**
 * Parse a Konsole `.colorscheme` body. Konsole's file format defines the normal
 * ANSI 0-7 as `[Color0]`-`[Color7]` and the bright ANSI 8-15 as the *Intense*
 * variants `[Color0Intense]`-`[Color7Intense]` (there is no `[Color8]`; see
 * Konsole `ColorScheme::colorNameForIndex`). A nonstandard explicit `[Color8]`-
 * `[Color15]` is honored as a fallback, and a missing Intense entry falls back
 * to the normal. Returns null when any of `Color0`-`Color7` is missing (a
 * partial scheme is useless — the caller keeps the VT-palette fallback).
 */
export function parseKonsoleColorscheme(text: string): KonsoleScheme | null {
  const sections = parseIni(text)
  const colorOf = (section: string): string | null =>
    parseKonsoleColor(sections.get(section)?.["Color"])
  const normal: string[] = []
  for (let i = 0; i < 8; i++) {
    const c = colorOf(`Color${i}`)
    if (c === null) return null
    normal.push(c)
  }
  const bright: string[] = []
  for (let i = 0; i < 8; i++) {
    bright.push(colorOf(`Color${i}Intense`) ?? colorOf(`Color${i + 8}`) ?? normal[i] ?? "#000000")
  }
  return {
    palette: [...normal, ...bright],
    foreground: colorOf("Foreground"),
    background: colorOf("Background"),
    name: sections.get("General")?.["Description"]?.trim() ?? "",
  }
}

/**
 * The profile's scheme name. Konsole stores it as `ColorScheme` in the
 * `[Appearance]` group; legacy configs used a root (ungrouped) `colors=`.
 */
export function parseProfileColorScheme(text: string): string | null {
  const sections = parseIni(text)
  const appearance = sections.get("Appearance")
  const root = sections.get("")
  const general = sections.get("General")
  const candidate =
    appearance?.["ColorScheme"] ??
    root?.["ColorScheme"] ??
    root?.["colors"] ??
    appearance?.["colors"] ??
    general?.["ColorScheme"] ??
    general?.["colors"]
  return typeof candidate === "string" && candidate.trim() !== "" ? candidate.trim() : null
}

interface SearchPaths {
  /** Where `*.profile` live, in order. */
  readonly profileDirs: readonly string[]
  /** Where `*.colorscheme` live, in order. */
  readonly schemeDirs: readonly string[]
  /** `~/.config/konsolerc` (DefaultProfile fallback when the env is absent). */
  readonly konsolerc: string | null
}

function searchPaths(env: NodeJS.ProcessEnv): SearchPaths {
  const home = env["HOME"] ?? ""
  // Qt (QStandardPaths) treats an EMPTY or RELATIVE XDG_* value as unset and
  // falls back to the defaults — do the same, or `XDG_DATA_HOME=""` silently
  // scans `/konsole` and drops `~/.local/share/konsole` (and an empty
  // `XDG_DATA_DIRS` drops `/usr/share/konsole`, where distro schemes live).
  const dataHome = xdgDir(env["XDG_DATA_HOME"], `${home}/.local/share`)
  const configHome = xdgDir(env["XDG_CONFIG_HOME"], `${home}/.config`)
  const dataDirs = xdgDataDirs(env["XDG_DATA_DIRS"])
  return {
    // Konsole searches GenericDataLocation for profiles too (ProfileReader.cpp).
    profileDirs: [`${dataHome}/konsole`, `${home}/.konsole`, ...dataDirs.map((d) => `${d}/konsole`)],
    schemeDirs: [
      `${dataHome}/konsole`,
      `${dataHome}/color-schemes`,
      ...dataDirs.map((d) => `${d}/konsole`),
      ...dataDirs.map((d) => `${d}/color-schemes`),
    ],
    konsolerc: home !== "" ? `${configHome}/konsolerc` : null,
  }
}

/** Qt's XDG rule: an empty/relative value is ignored in favor of the default. */
function xdgDir(value: string | undefined, fallback: string): string {
  const v = (value ?? "").trim()
  return v === "" || !v.startsWith("/") ? fallback : v
}

/** `XDG_DATA_DIRS`: absolute entries only; none (or all relative) → the Qt default. */
function xdgDataDirs(value: string | undefined): string[] {
  const dirs = (value ?? "")
    .split(":")
    .map((d) => d.trim())
    .filter((d) => d.startsWith("/"))
  return dirs.length > 0 ? dirs : ["/usr/local/share", "/usr/share"]
}

/** First `dir/name` that exists as a readable file, or null. Never throws. */
function findPath(dirs: readonly string[], name: string): string | null {
  for (const dir of dirs) {
    const path = `${dir}/${name}`
    try {
      readFileSync(path, "utf8")
      return path
    } catch {
      // missing/unreadable — try the next root
    }
  }
  return null
}

/** Strip path separators so a hostile/odd env value cannot escape its dir. */
function fileSafe(name: string): string {
  return name.replace(/[/\\]/g, "").trim()
}

/** The terminal's truthful OSC 10/11 defaults, used to fingerprint the active
 * scheme when the profile chain cannot be resolved (modern Konsole). */
export interface SchemeFingerprint {
  readonly foreground?: string | null
  readonly background?: string | null
}

export interface ReadKonsoleSchemeOptions {
  /** Environment to resolve (defaults to `process.env`). Tests inject a temp HOME. */
  readonly env?: NodeJS.ProcessEnv
  /**
   * Detected OSC 10/11 defaults. When the profile chain fails, every installed
   * `*.colorscheme` with a matching fg+bg is a candidate (first wins). Absent →
   * no fingerprinting (pure profile lookup).
   */
  readonly detected?: SchemeFingerprint
  /**
   * D-Bus `org.kde.konsole.Session.profile()` runner (`KONSOLE_DBUS_SERVICE` +
   * `KONSOLE_DBUS_SESSION`). Defaults to trying the common session-bus CLIs
   * (`busctl`, `dbus-send`, `gdbus`, `qdbus6`/`qdbus`); tests inject a stub. It
   * is never called when the session-bus env is absent.
   */
  readonly runDbusProfile?: (service: string, objectPath: string) => DbusProfileResult
}

/** Outcome of the D-Bus profile query (the reason feeds `/status`). */
export interface DbusProfileResult {
  readonly name: string | null
  /** The CLI that answered, or null. */
  readonly tool: string | null
  /** Why it failed (null on success). */
  readonly reason: string | null
}

/** The lookup result: the scheme, plus why it failed (for `/status`). */
export interface KonsoleSchemeLoad {
  readonly scheme: KonsoleScheme | null
  /** Short human-readable failure trace; null on success. */
  readonly reason: string | null
}

interface ProfileResolution {
  readonly name: string | null
  readonly reason: string | null
}

/** Normalize one channel triple for comparison (`null` when unparseable). */
function rgbKey(hex: string | null | undefined): string | null {
  const c = parseHexColor(hex ?? null)
  return c ? `${c.r},${c.g},${c.b}` : null
}

/**
 * Legacy `KONSOLE_PROFILE_NAME`, then the session's D-Bus profile, then
 * `konsolerc` `[Desktop Entry] DefaultProfile`.
 */
function resolveProfileName(
  env: NodeJS.ProcessEnv,
  paths: SearchPaths,
  runDbus: (service: string, objectPath: string) => DbusProfileResult,
): ProfileResolution {
  const direct = fileSafe(env["KONSOLE_PROFILE_NAME"] ?? "")
  if (direct !== "") return { name: direct, reason: null }
  // Modern Konsole dropped KONSOLE_PROFILE_NAME but still exports the session
  // bus coordinates; ask THIS session for its profile (the default profile may
  // be a different one — a tab can override it).
  const service = (env["KONSOLE_DBUS_SERVICE"] ?? "").trim()
  const objectPath = (env["KONSOLE_DBUS_SESSION"] ?? "").trim()
  let dbusNote: string | null = null
  if (service !== "" && objectPath !== "") {
    const res = runDbus(service, objectPath)
    const name = fileSafe(res.name ?? "")
    if (name !== "") return { name, reason: null }
    dbusNote = `D-Bus profile lookup failed (${res.tool ?? "no tool"}): ${res.reason ?? "no name returned"}`
  }
  if (paths.konsolerc !== null) {
    try {
      const desktop = parseIni(readFileSync(paths.konsolerc, "utf8")).get("Desktop Entry")
      // Konsole's own default when the key is empty (ProfileManager.cpp).
      const name = fileSafe(desktop?.["DefaultProfile"] ?? "Shell.profile")
      if (name !== "") return { name: name.replace(/\.profile$/i, ""), reason: null }
    } catch {
      // no konsolerc — not a (configured) KDE terminal
    }
  }
  const base = "KONSOLE_PROFILE_NAME unset and no konsolerc DefaultProfile"
  return { name: null, reason: dbusNote !== null ? `${base}; ${dbusNote}` : base }
}

/** Load `<schemeName>.colorscheme` from the search dirs. Parse-and-continue: a
 * non-Konsole file with this name in one root must not shadow a valid scheme in
 * another (and the path is reported when none parse). */
function loadSchemeByName(
  dirs: readonly string[],
  schemeName: string,
): { scheme: KonsoleScheme | null; reason: string } {
  let firstFound: string | null = null
  for (const dir of dirs) {
    const schemePath = `${dir}/${schemeName}.colorscheme`
    let schemeText: string
    try {
      schemeText = readFileSync(schemePath, "utf8")
    } catch {
      continue
    }
    if (firstFound === null) firstFound = schemePath
    const scheme = parseKonsoleColorscheme(schemeText)
    if (scheme !== null) return { scheme, reason: "" }
  }
  return {
    scheme: null,
    reason:
      firstFound === null
        ? `${schemeName}.colorscheme not found`
        : `${schemeName}.colorscheme has no Color0-Color7 (${firstFound})`,
  }
}

/**
 * Fingerprint the active scheme from the truthful OSC 10/11 defaults: the first
 * installed `*.colorscheme` whose fg+bg both match. Returns the scheme (or null)
 * plus how many schemes were considered, so `/status` can say what was scanned.
 */
function fingerprintScheme(
  dirs: readonly string[],
  detected: SchemeFingerprint | undefined,
): { scheme: KonsoleScheme | null; considered: number } {
  const wantFg = rgbKey(detected?.foreground)
  const wantBg = rgbKey(detected?.background)
  if (wantFg === null || wantBg === null) return { scheme: null, considered: 0 }
  let considered = 0
  for (const dir of dirs) {
    let names: string[]
    try {
      names = readdirSync(dir).sort()
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith(".colorscheme")) continue
      let text: string
      try {
        text = readFileSync(`${dir}/${name}`, "utf8")
      } catch {
        continue
      }
      const scheme = parseKonsoleColorscheme(text)
      if (scheme === null) continue
      considered++
      if (rgbKey(scheme.foreground) === wantFg && rgbKey(scheme.background) === wantBg) {
        return { scheme, considered }
      }
    }
  }
  return { scheme: null, considered }
}

/**
 * Parse the profile name out of a `dbus-send` reply. `--print-reply` emits
 * `string "Nord"`; a literal reply emits a bare value. Tolerates both (plus a
 * quoted bare value) and returns null for anything unusable. Exported for
 * tests — the real call needs a session bus.
 */
export function parseDbusProfileReply(output: string): string | null {
  const quoted = /string\s+"([^"]*)"/.exec(output)
  if (quoted) return quoted[1]?.trim() || null
  // A method-return/error header without a string payload is not a value;
  // only a genuinely literal (bare) reply falls through to the value read.
  if (/method\s+(return|error)/i.test(output)) return null
  const last =
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .pop() ?? ""
  const bare = last.replace(/^["']|["']$/g, "").trim()
  return bare !== "" ? bare : null
}

interface DbusTool {
  readonly binary: string
  readonly args: (service: string, objectPath: string) => string[]
  /** Parse this tool's stdout into a profile name (null when unusable). */
  readonly parse: (stdout: string) => string | null
}

/** Minimal C-string unescape for the tools that C-escape their output. */
function unescapeC(value: string): string {
  return value.replace(/\\(["'\\nrt])/g, (_, c: string) => {
    if (c === "n") return "\n"
    if (c === "r") return "\r"
    if (c === "t") return "\t"
    return c
  })
}

/**
 * Session-bus CLIs in preference order. No single tool is guaranteed on a
 * minimal KDE install (`dbus-send` is in a separate package on several
 * distros), but systemd's `busctl` almost always is, and KDE ships
 * `qdbus6`/`qdbus`. Each has its own output format, hence per-tool parsing.
 */
const DBUS_TOOLS: readonly DbusTool[] = [
  {
    binary: "busctl",
    args: (s, p) => ["--user", "call", s, p, "org.kde.konsole.Session", "profile"],
    // `s "Name"` (C-escaped).
    parse: (out) => {
      const m = /^\s*s\s+"((?:[^"\\]|\\.)*)"\s*$/m.exec(out)
      return m?.[1] != null ? unescapeC(m[1]) : null
    },
  },
  {
    binary: "dbus-send",
    args: (s, p) => ["--session", "--print-reply", `--dest=${s}`, p, "org.kde.konsole.Session.profile"],
    parse: parseDbusProfileReply,
  },
  {
    binary: "gdbus",
    args: (s, p) => [
      "call",
      "--session",
      "--dest",
      s,
      "--object-path",
      p,
      "--method",
      "org.kde.konsole.Session.profile",
    ],
    // `('Name',)`
    parse: (out) => {
      const m = /^\s*\(\s*'((?:[^'\\]|\\.)*)'\s*,?\s*\)\s*$/m.exec(out)
      return m?.[1] != null ? unescapeC(m[1]) : null
    },
  },
  {
    binary: "qdbus6",
    args: (s, p) => [s, p, "org.kde.konsole.Session.profile"],
    parse: (out) => out.trim() || null,
  },
  {
    binary: "qdbus",
    args: (s, p) => [s, p, "org.kde.konsole.Session.profile"],
    parse: (out) => out.trim() || null,
  },
]

/** Try each session-bus CLI for `org.kde.konsole.Session.profile()`; never
 * throws. Returns the first profile name plus the tool, or a failure reason. */
function defaultDbusProfile(service: string, objectPath: string): DbusProfileResult {
  // Guard the arguments (spawnSync has no shell, but garbage values are useless).
  if (!/^[\w.:-]+$/.test(service) || !/^\/[\w./-]+$/.test(objectPath)) {
    return { name: null, tool: null, reason: "invalid service/object path" }
  }
  const missing: string[] = []
  let lastReason = ""
  for (const tool of DBUS_TOOLS) {
    const res = spawnSync(tool.binary, tool.args(service, objectPath), {
      timeout: 1000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    if (res.error) {
      if ((res.error as NodeJS.ErrnoException).code === "ENOENT") {
        missing.push(tool.binary)
        continue
      }
      lastReason = `${tool.binary}: ${res.error.message}`
      continue
    }
    const stdout = typeof res.stdout === "string" ? res.stdout : ""
    if (res.status !== 0) {
      const stderr = typeof res.stderr === "string" ? res.stderr : ""
      const line = stderr.trim().split(/\r?\n/).filter(Boolean).pop() ?? ""
      lastReason = `${tool.binary}: ${line || `exit ${res.status}`}`
      continue
    }
    const name = tool.parse(stdout)?.trim() ?? ""
    if (name !== "") return { name, tool: tool.binary, reason: null }
    lastReason = `${tool.binary}: unparseable reply "${stdout.trim().slice(0, 80)}"`
  }
  if (missing.length === DBUS_TOOLS.length) {
    return { name: null, tool: null, reason: `no D-Bus CLI installed (tried ${missing.join(", ")})` }
  }
  return { name: null, tool: null, reason: lastReason || "no D-Bus tool returned a profile" }
}

/**
 * Resolve the active KDE color scheme and (on failure) the step that failed.
 * Never throws. The reason is surfaced in `/status` so a lookup miss is
 * diagnosable without guesswork.
 */
export function loadKonsoleScheme(options: ReadKonsoleSchemeOptions = {}): KonsoleSchemeLoad {
  try {
    const env = options.env ?? process.env
    const paths = searchPaths(env)
    const profile = resolveProfileName(env, paths, options.runDbusProfile ?? defaultDbusProfile)
    if (profile.name !== null) {
      const profilePath = findPath(paths.profileDirs, `${profile.name}.profile`)
      if (profilePath === null) {
        return fingerprintOr(paths, options.detected, `profile ${profile.name}.profile not found`)
      }
      let profileText: string
      try {
        profileText = readFileSync(profilePath, "utf8")
      } catch {
        return fingerprintOr(paths, options.detected, `profile ${profile.name}.profile unreadable`)
      }
      const schemeName = fileSafe(parseProfileColorScheme(profileText) ?? "")
      if (schemeName === "") {
        return fingerprintOr(paths, options.detected, `no ColorScheme in ${profile.name}.profile`)
      }
      const loaded = loadSchemeByName(paths.schemeDirs, schemeName)
      if (loaded.scheme !== null) return { scheme: loaded.scheme, reason: null }
      return fingerprintOr(paths, options.detected, loaded.reason)
    }
    return fingerprintOr(paths, options.detected, profile.reason)
  } catch {
    return { scheme: null, reason: "KDE scheme lookup failed" }
  }
}

/** Fingerprint fallback: the matching scheme when one is found, else the
 * profile-chain failure reason appended with the fingerprint outcome, so
 * `/status` distinguishes "no profile found" from "no scheme matched". */
function fingerprintOr(
  paths: SearchPaths,
  detected: SchemeFingerprint | undefined,
  reason: string | null,
): KonsoleSchemeLoad {
  const { scheme, considered } = fingerprintScheme(paths.schemeDirs, detected)
  if (scheme !== null) return { scheme, reason: null }
  // Reached with fg/bg only when detection answered OSC 10/11.
  const attempted = detected?.foreground != null && detected?.background != null
  const note = attempted
    ? `; fg/bg matched no installed .colorscheme (${considered} scheme${considered === 1 ? "" : "s"} in ${new Set(paths.schemeDirs).size} dirs)`
    : ""
  return { scheme: null, reason: reason === null ? null : `${reason}${note}` }
}

/**
 * Read the active KDE color scheme. Returns null (never throws) when the
 * environment is not a KDE terminal, the profile/scheme is missing, or the
 * scheme is malformed — the caller then keeps the VT-palette fallback.
 */
export function readKonsoleScheme(options: ReadKonsoleSchemeOptions = {}): KonsoleScheme | null {
  return loadKonsoleScheme(options).scheme
}
