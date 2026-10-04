import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadKonsoleScheme,
  parseDbusProfileReply,
  parseKonsoleColorscheme,
  parseProfileColorScheme,
  readKonsoleScheme,
} from "../../../src/theme/konsoleScheme.ts"

const CLEANUP: string[] = []
afterAll(() => {
  for (const dir of CLEANUP) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

/** A temp KDE data home with a profile + scheme, laid out like Konsole's. */
function kdeHome(options: { kconsolercDefault?: string; omitScheme?: boolean } = {}): string {
  const home = mkdtempSync(join(tmpdir(), "sensus-konsole-"))
  CLEANUP.push(home)
  const konsole = join(home, ".local", "share", "konsole")
  const config = join(home, ".config")
  mkdirSync(konsole, { recursive: true })
  mkdirSync(config, { recursive: true })
  writeFileSync(
    join(konsole, "MyProfile.profile"),
    "[Appearance]\nColorScheme=Nord\n[General]\nName=MyProfile\nParent=FALLBACK/\n",
  )
  if (!options.omitScheme) {
    writeFileSync(
      join(konsole, "Nord.colorscheme"),
      [
        "[Background]",
        "Color=46,52,64",
        "[Foreground]",
        "Color=216,222,233",
        "[Color0]",
        "Color=59,66,82",
        "[Color0Intense]",
        "Color=76,86,106",
        "[Color1]",
        "Color=191,97,106",
        "[Color1Intense]",
        "Color=191,97,106",
        "[Color2]",
        "Color=163,190,140",
        "[Color2Intense]",
        "Color=163,190,140",
        "[Color3]",
        "Color=235,203,139",
        "[Color3Intense]",
        "Color=235,203,139",
        "[Color4]",
        "Color=129,161,193",
        "[Color4Intense]",
        "Color=129,161,193",
        "[Color5]",
        "Color=180,142,173",
        "[Color5Intense]",
        "Color=180,142,173",
        "[Color6]",
        "Color=136,192,208",
        "[Color6Intense]",
        "Color=143,188,187",
        "[Color7]",
        "Color=229,233,240",
        "[Color7Intense]",
        "Color=236,239,244",
        "[General]",
        "Description=Nord",
      ].join("\n"),
    )
  }
  if (options.kconsolercDefault !== undefined) {
    writeFileSync(join(config, "konsolerc"), `[Desktop Entry]\nDefaultProfile=${options.kconsolercDefault}\n`)
  }
  return home
}

describe("parseKonsoleColorscheme (the .colorscheme INI parser)", () => {
  test("maps Color0-7 normal + ColorNIntense bright 8-15 (Konsole's real format)", () => {
    const s = parseKonsoleColorscheme(
      [
        "[Background]",
        "Color=46, 52, 64", // spaces are tolerated
        "[Foreground]",
        "Color=216,222,233",
        "[Color0]",
        "Color=#3b4252", // hex is tolerated too
        ...Array.from({ length: 7 }, (_, i) => `[Color${i + 1}]\nColor=${i},${i},${i}`),
        ...Array.from({ length: 8 }, (_, i) => `[Color${i}Intense]\nColor=${i + 100},${i + 100},${i + 100}`),
        "[General]",
        "Description=Nord",
      ].join("\n"),
    )
    expect(s).not.toBeNull()
    expect(s?.palette).toHaveLength(16)
    expect(s?.palette[0]).toBe("#3b4252")
    expect(s?.palette[1]).toBe("#000000")
    expect(s?.palette[7]).toBe("#060606")
    // Bright 8-15 come from Color0Intense..Color7Intense.
    expect(s?.palette[8]).toBe("#646464")
    expect(s?.palette[15]).toBe("#6b6b6b")
    expect(s?.foreground).toBe("#d8dee9")
    expect(s?.background).toBe("#2e3440")
    expect(s?.name).toBe("Nord")
    // A missing Intense variant falls back to the normal entry.
    const noIntense = parseKonsoleColorscheme(
      Array.from({ length: 8 }, (_, i) => `[Color${i}]\nColor=1,2,3`).join("\n"),
    )
    expect(noIntense?.palette[8]).toBe("#010203")
    // Konsole writes `Color=r,g,b,a` when alpha < 255; the alpha is dropped.
    const alpha = parseKonsoleColorscheme(
      [
        "[Foreground]",
        "Color=216,222,233,255",
        ...Array.from({ length: 8 }, (_, i) => `[Color${i}]\nColor=1,2,3`),
      ].join("\n"),
    )
    expect(alpha?.foreground).toBe("#d8dee9")
    // Nonstandard explicit [Color8] is honored when Intense is absent.
    const explicit = parseKonsoleColorscheme(
      [
        ...Array.from({ length: 8 }, (_, i) => `[Color${i}]\nColor=1,2,3`),
        "[Color8]",
        "Color=9,8,7",
      ].join("\n"),
    )
    expect(explicit?.palette[8]).toBe("#090807")
  })

  test("a partial or malformed scheme is rejected (the caller keeps the fallback)", () => {
    // Missing Color7.
    const missing = Array.from({ length: 7 }, (_, i) => `[Color${i}]\nColor=1,2,3`).join("\n")
    expect(parseKonsoleColorscheme(missing)).toBeNull()
    expect(parseKonsoleColorscheme("")).toBeNull()
    // Color0 is present but garbage → reject.
    const junk = ["[Color0]", "Color=zzz", ...Array.from({ length: 7 }, (_, i) => `[Color${i + 1}]\nColor=1,2,3`)].join("\n")
    expect(parseKonsoleColorscheme(junk)).toBeNull()
    // Channels clamp to 0-255.
    const clamped = ["[Color0]", "Color=999,-4,12", ...Array.from({ length: 7 }, (_, i) => `[Color${i + 1}]\nColor=1,2,3`)].join("\n")
    expect(parseKonsoleColorscheme(clamped)?.palette[0]).toBe("#ff000c")
  })
})

describe("parseProfileColorScheme", () => {
  test("reads [Appearance] ColorScheme (Konsole's real location) + legacy keys", () => {
    expect(parseProfileColorScheme("[Appearance]\nColorScheme=Breeze\n")).toBe("Breeze")
    expect(parseProfileColorScheme("[Appearance]\nColorScheme= Solarized Dark \n")).toBe("Solarized Dark")
    // Legacy root (ungrouped) key and the old `colors=` spelling.
    expect(parseProfileColorScheme("colors=Nord\n[General]\nName=x\n")).toBe("Nord")
    expect(parseProfileColorScheme("ColorScheme=Nord\n")).toBe("Nord")
    // Forgiving fallback to [General] (not Konsole's location, but harmless).
    expect(parseProfileColorScheme("[General]\nColorScheme=Nord\n")).toBe("Nord")
    expect(parseProfileColorScheme("[General]\nName=x\n")).toBeNull()
    expect(parseProfileColorScheme("")).toBeNull()
  })
})

describe("readKonsoleScheme (profile → scheme on disk)", () => {
  test("resolves KONSOLE_PROFILE_NAME → profile → ColorScheme file", () => {
    const home = kdeHome()
    const s = readKonsoleScheme({ env: { HOME: home, KONSOLE_PROFILE_NAME: "MyProfile" } })
    expect(s?.name).toBe("Nord")
    expect(s?.palette[1]).toBe("#bf616a")
    // The bright row is the Intense variants (Color0Intense = ANSI 8).
    expect(s?.palette[8]).toBe("#4c566a")
    expect(s?.palette[15]).toBe("#eceff4")
    expect(s?.background).toBe("#2e3440")
  })

  test("falls back to konsolerc DefaultProfile when the env var is absent", () => {
    const home = kdeHome({ kconsolercDefault: "MyProfile" })
    const s = readKonsoleScheme({ env: { HOME: home } })
    expect(s?.name).toBe("Nord")
  })

  test("missing scheme file or a non-KDE environment → null (never throws)", () => {
    const missing = kdeHome({ omitScheme: true })
    expect(readKonsoleScheme({ env: { HOME: missing, KONSOLE_PROFILE_NAME: "MyProfile" } })).toBeNull()
    expect(readKonsoleScheme({ env: { HOME: missing } })).toBeNull()
    expect(readKonsoleScheme({ env: { HOME: "/nonexistent/sensus-test-home" } })).toBeNull()
  })

  test("modern Konsole: resolves the profile over D-Bus when the env var is gone", () => {
    const home = kdeHome()
    const calls: Array<[string, string]> = []
    const s = readKonsoleScheme({
      env: {
        HOME: home,
        KONSOLE_DBUS_SERVICE: "org.kde.konsole-1234",
        KONSOLE_DBUS_SESSION: "/Sessions/1",
      },
      runDbusProfile: (service, path) => {
        calls.push([service, path])
        return { name: "MyProfile", tool: "test", reason: null }
      },
    })
    expect(s?.name).toBe("Nord")
    expect(calls).toEqual([["org.kde.konsole-1234", "/Sessions/1"]])
    // The legacy env var short-circuits the D-Bus query entirely.
    let queried = false
    const direct = readKonsoleScheme({
      env: { HOME: home, KONSOLE_PROFILE_NAME: "MyProfile", KONSOLE_DBUS_SERVICE: "x", KONSOLE_DBUS_SESSION: "/Sessions/1" },
      runDbusProfile: () => {
        queried = true
        return { name: "Nope", tool: "test", reason: null }
      },
    })
    expect(direct?.name).toBe("Nord")
    expect(queried).toBe(false)
  })

  test("fingerprints the scheme from OSC 10/11 when no profile can be resolved", () => {
    const home = kdeHome()
    // No KONSOLE_PROFILE_NAME, no konsolerc, no D-Bus env.
    const byDefaults = readKonsoleScheme({
      env: { HOME: home },
      detected: { foreground: "#d8dee9", background: "#2e3440" },
    })
    expect(byDefaults?.name).toBe("Nord")
    expect(byDefaults?.palette[2]).toBe("#a3be8c")
    // Fg/bg that match no installed scheme leave the VT fallback.
    expect(
      readKonsoleScheme({
        env: { HOME: home },
        detected: { foreground: "#123456", background: "#654321" },
      }),
    ).toBeNull()
    // Only one of the two defaults is not enough to fingerprint.
    expect(
      readKonsoleScheme({ env: { HOME: home }, detected: { foreground: "#d8dee9" } }),
    ).toBeNull()
  })

  test("empty/relative XDG_* values fall back like Qt (don't lose scheme dirs)", () => {
    const home = kdeHome()
    const detected = { foreground: "#d8dee9", background: "#2e3440" }
    // XDG_DATA_HOME="" must NOT scan `/konsole` and drop ~/.local/share/konsole.
    expect(readKonsoleScheme({ env: { HOME: home, XDG_DATA_HOME: "" }, detected })?.name).toBe("Nord")
    // XDG_DATA_DIRS="" must NOT drop the /usr/* defaults (no throw either).
    expect(
      readKonsoleScheme({ env: { HOME: home, XDG_DATA_DIRS: "" }, detected })?.name,
    ).toBe("Nord")
    // A relative value is likewise ignored.
    expect(
      readKonsoleScheme({ env: { HOME: home, XDG_DATA_HOME: "relative/dir" }, detected })?.name,
    ).toBe("Nord")
  })
})

describe("parseDbusProfileReply (dbus-send output)", () => {
  test("reads `string \"...\"` (--print-reply) and a bare literal value", () => {
    // `dbus-send --print-reply` — the form the call actually uses.
    expect(
      parseDbusProfileReply('method return time=1 sender=:1.2 -> destination=:1.3\n   string "My Profile"\n'),
    ).toBe("My Profile")
    // `--print-reply=literal` — a bare value, optionally quoted.
    expect(parseDbusProfileReply("   MyProfile\n")).toBe("MyProfile")
    expect(parseDbusProfileReply('"Solarized Dark"')).toBe("Solarized Dark")
    // No usable payload.
    expect(parseDbusProfileReply("")).toBeNull()
    expect(parseDbusProfileReply("method return time=1 serial=9\n")).toBeNull()
  })
})

describe("loadKonsoleScheme (diagnostic reason for /status)", () => {
  test("names the failing step so a lookup miss is diagnosable", () => {
    const missingScheme = kdeHome({ omitScheme: true })
    expect(
      loadKonsoleScheme({ env: { HOME: missingScheme, KONSOLE_PROFILE_NAME: "MyProfile" } }).reason,
    ).toContain("Nord.colorscheme not found")
    expect(loadKonsoleScheme({ env: { HOME: missingScheme } }).reason).toContain(
      "KONSOLE_PROFILE_NAME unset",
    )

    const home = kdeHome()
    expect(
      loadKonsoleScheme({ env: { HOME: home, KONSOLE_PROFILE_NAME: "Nope" } }).reason,
    ).toContain("profile Nope.profile not found")
    // A profile without a ColorScheme key is reported too.
    const konsole = join(home, ".local", "share", "konsole")
    writeFileSync(join(konsole, "NoScheme.profile"), "[General]\nName=NoScheme\n")
    expect(
      loadKonsoleScheme({ env: { HOME: home, KONSOLE_PROFILE_NAME: "NoScheme" } }).reason,
    ).toContain("no ColorScheme")

    // A file that exists but is not a Konsole scheme reports its path.
    writeFileSync(join(konsole, "Broken.profile"), "[Appearance]\nColorScheme=Broken\n")
    writeFileSync(join(konsole, "Broken.colorscheme"), "[Color0]\nColor=1,2,3\n")
    const brokenReason = loadKonsoleScheme({ env: { HOME: home, KONSOLE_PROFILE_NAME: "Broken" } }).reason
    expect(brokenReason).toContain("has no Color0-Color7")
    expect(brokenReason).toContain("Broken.colorscheme")

    expect(loadKonsoleScheme({ env: { HOME: home, KONSOLE_PROFILE_NAME: "MyProfile" } }).reason).toBeNull()
  })

  test("surfaces the D-Bus failure when the session-bus env is present but the call fails", () => {
    const home = kdeHome({ omitScheme: true })
    const { reason } = loadKonsoleScheme({
      env: {
        HOME: home,
        KONSOLE_DBUS_SERVICE: ":1.234",
        KONSOLE_DBUS_SESSION: "/Sessions/1",
      },
      runDbusProfile: () => ({ name: null, tool: "busctl", reason: "ServiceUnknown" }),
    })
    expect(reason).toContain("KONSOLE_PROFILE_NAME unset")
    expect(reason).toContain("D-Bus profile lookup failed (busctl)")
    expect(reason).toContain("ServiceUnknown")
  })
})
