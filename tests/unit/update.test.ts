/**
 * `sensus update` / `sensus upgrade` + the launch update alert
 * (docs/operations.md "Update").
 *
 * Scenario-shaped: version comparison, the check cache, and the full command
 * decision tree (up-to-date, --check, install-in-place, source checkout,
 * pinned tag, dry-run, installer failure) with fetch/installer injected — no
 * network and no spawns.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  checkForUpdate,
  installerPrefixFor,
  isNewerVersion,
  normalizeTag,
  parseUpdateArgs,
  parseVersion,
  readUpdateCache,
  runUpdate,
  updateAlertMessage,
  updateCachePath,
  writeUpdateCache,
  type UpdateIo,
} from "../../src/update.ts"
import { SENSUS_VERSION } from "../../src/version.ts"

function captureIo(): { lines: string[]; errors: string[]; io: UpdateIo } {
  const lines: string[] = []
  const errors: string[] = []
  return {
    lines,
    errors,
    io: {
      out: (s) => lines.push(s),
      err: (s) => errors.push(s),
    },
  }
}

const tempDir = (): { dir: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "sensus-update-test-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A fake release host: the latest-release JSON plus the installer script. */
function fakeRelease(tag: string, script = "#!/usr/bin/env bash\nexit 0\n"): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    urls.push(url)
    if (url.includes("releases/latest") || url.endsWith("/latest")) {
      return new Response(JSON.stringify({ tag_name: tag }), { status: 200 })
    }
    return new Response(script, { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, urls }
}

/** A failing fetch with the right shape (tests the silent-error paths). */
function failingFetch(): typeof fetch {
  return (async () => {
    throw new Error("offline")
  }) as unknown as typeof fetch
}

describe("update version comparison", () => {
  test("parse/isNewer handle v-prefixes, dotted triples, suffixes, and junk", () => {
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 })
    expect(parseVersion("1.2")).toEqual({ major: 1, minor: 2, patch: 0 })
    expect(parseVersion("1.2.3-rc.1+build")).toEqual({ major: 1, minor: 2, patch: 3 })
    expect(parseVersion("nightly")).toBeNull()
    expect(isNewerVersion("v0.2.0", "0.1.9")).toBe(true)
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true)
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false)
    expect(isNewerVersion("0.1.0", "0.2.0")).toBe(false)
    expect(isNewerVersion("garbage", "0.1.0")).toBe(false)
    expect(normalizeTag("v1.2.3")).toBe("1.2.3")
  })

  test("the alert names both versions and the command to run", () => {
    const message = updateAlertMessage("0.1.0", "v0.2.0")
    expect(message).toContain("v0.2.0")
    expect(message).toContain("0.1.0")
    expect(message).toContain("sensus update")
  })
})

describe("update check cache", () => {
  test("fresh cache reads, stale/missing/corrupt fall through, writes never throw", () => {
    const { dir, cleanup } = tempDir()
    try {
      const path = updateCachePath(dir)
      writeUpdateCache(path, { latest: "0.2.0", checkedAt: 1000 })
      expect(readUpdateCache(path, 2000, 5000)).toEqual({ latest: "0.2.0", checkedAt: 1000 })
      expect(readUpdateCache(path, 9000, 5000)).toBeNull()
      expect(readUpdateCache(join(dir, "missing.json"), 1000)).toBeNull()
      writeFileSync(path, "not json")
      expect(readUpdateCache(path, 1000)).toBeNull()

      // Nested dirs are created; a bad path is absorbed (best-effort).
      const nested = updateCachePath(join(dir, "a/b"))
      writeUpdateCache(nested, { latest: "1.0.0", checkedAt: 5 })
      expect((JSON.parse(readFileSync(nested, "utf8")) as { latest: string }).latest).toBe("1.0.0")
      expect(() => writeUpdateCache("/proc/nope/update.json", { latest: "x", checkedAt: 1 })).not.toThrow()
    } finally {
      cleanup()
    }
  })

  test("checkForUpdate: cache avoids the network, stale refetches, failures stay silent", async () => {
    const { dir, cleanup } = tempDir()
    try {
      const stateDir = join(dir, "state")
      let calls = 0
      const fetchImpl = (async () => {
        calls++
        return new Response(JSON.stringify({ tag_name: "v0.2.0" }), { status: 200 })
      }) as unknown as typeof fetch

      const first = await checkForUpdate({ stateDir, env: {}, currentVersion: "0.1.0", now: () => 1000, fetchImpl })
      expect(first).toMatchObject({ status: "ok", latest: "0.2.0", updateAvailable: true, source: "network" })
      expect(calls).toBe(1)
      expect(readUpdateCache(updateCachePath(stateDir), 1000)).not.toBeNull()

      const cached = await checkForUpdate({ stateDir, env: {}, currentVersion: "0.1.0", now: () => 2000, fetchImpl })
      expect(cached).toMatchObject({ status: "ok", source: "cache", updateAvailable: true })
      expect(calls).toBe(1)

      const stale = await checkForUpdate({
        stateDir,
        env: {},
        currentVersion: "0.1.0",
        now: () => 1000 + 25 * 60 * 60 * 1000,
        fetchImpl,
      })
      expect(stale.source).toBe("network")
      expect(calls).toBe(2)

      const disabled = await checkForUpdate({
        stateDir,
        env: { SENSUS_UPDATE_CHECK: "0" },
        currentVersion: "0.1.0",
        fetchImpl,
      })
      expect(disabled.status).toBe("disabled")
      expect(calls).toBe(2)

      const failing = failingFetch()
      const error = await checkForUpdate({ stateDir: join(dir, "other"), env: {}, fetchImpl: failing })
      expect(error.status).toBe("error")
      expect(error.updateAvailable).toBe(false)

      const empty = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch
      const noTag = await checkForUpdate({ stateDir: join(dir, "empty"), env: {}, fetchImpl: empty })
      expect(noTag.status).toBe("error")
    } finally {
      cleanup()
    }
  })
})

describe("sensus update command", () => {
  test("parseUpdateArgs accepts check/dry-run/version/help and rejects junk", () => {
    const parsed = parseUpdateArgs(["--check", "--version", "v0.2.0"])
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.options).toMatchObject({ check: true, version: "0.2.0", dryRun: false })
    const eq = parseUpdateArgs(["--version=v1.0.0"])
    if (eq.ok) expect(eq.options.version).toBe("1.0.0")
    const latest = parseUpdateArgs(["--version", "latest"])
    if (latest.ok) expect(latest.options.version).toBeNull()
    const help = parseUpdateArgs(["--help"])
    if (help.ok) expect(help.options.help).toBe(true)
    expect(parseUpdateArgs(["--nope"]).ok).toBe(false)
    expect(parseUpdateArgs(["--version"]).ok).toBe(false)
    expect(parseUpdateArgs(["extra"]).ok).toBe(false)
  })

  test("installerPrefixFor only targets a canonical <prefix>/bin/sensus install", () => {
    expect(installerPrefixFor("/home/u/.local/bin/sensus")).toBe("/home/u/.local")
    expect(installerPrefixFor("/usr/local/bin/sensus")).toBe("/usr/local")
    expect(installerPrefixFor("/repo/dist/sensus")).toBeNull()
    expect(installerPrefixFor("/home/u/.local/bin/sensus-next")).toBeNull()
  })

  test("an up-to-date install reports it and runs nothing", async () => {
    const { lines, io } = captureIo()
    const release = fakeRelease(`v${SENSUS_VERSION}`)
    let installs = 0
    const code = await runUpdate([], io, {}, {
      fetchImpl: release.fetchImpl,
      compiled: true,
      execPath: "/home/u/.local/bin/sensus",
      runInstaller: async () => {
        installs++
        return 0
      },
    })
    expect(code).toBe(0)
    expect(lines.join("\n")).toContain("up to date")
    expect(installs).toBe(0)
  })

  test("--check reports a newer release without installing it", async () => {
    const { lines, io } = captureIo()
    const release = fakeRelease("v9.9.9")
    let installs = 0
    const code = await runUpdate(["--check"], io, {}, {
      fetchImpl: release.fetchImpl,
      compiled: true,
      execPath: "/home/u/.local/bin/sensus",
      runInstaller: async () => {
        installs++
        return 0
      },
    })
    expect(code).toBe(0)
    expect(lines.join("\n")).toContain("v9.9.9")
    expect(lines.join("\n")).toContain("available")
    expect(installs).toBe(0)
  })

  test("installing downloads the installer and runs it against the running prefix", async () => {
    const { dir, cleanup } = tempDir()
    try {
      const { lines, io } = captureIo()
      const release = fakeRelease("v9.9.9")
      const stateDir = join(dir, "state")
      const runs: Array<{ script: string; args: string[]; env: Record<string, string> }> = []
      const code = await runUpdate([], io, { SENSUS_RELEASES_BASE_URL: "http://127.0.0.1:1", SENSUS_STATE: stateDir }, {
        fetchImpl: release.fetchImpl,
        compiled: true,
        execPath: "/home/u/.local/bin/sensus",
        runInstaller: async (script, args, env) => {
          runs.push({ script, args, env })
          return 0
        },
      })
      expect(code).toBe(0)
      expect(lines.join("\n")).toContain("updating")
      const run = runs[0]
      expect(run?.script).toContain("#!/usr/bin/env bash")
      expect(run?.env["PREFIX"]).toBe("/home/u/.local")
      expect(run?.env["SENSUS_RELEASES_BASE_URL"]).toBe("http://127.0.0.1:1")
      expect(run?.env["SENSUS_RELEASE_VERSION"]).toBeUndefined()
      // The explicit check refreshes the launch-alert cache.
      expect(readUpdateCache(updateCachePath(stateDir), Date.now())?.latest).toBe("9.9.9")
    } finally {
      cleanup()
    }
  })

  test("a source checkout refuses to self-update and points at git", async () => {
    const { errors, io } = captureIo()
    const release = fakeRelease("v9.9.9")
    const code = await runUpdate([], io, {}, {
      fetchImpl: release.fetchImpl,
      compiled: false,
      execPath: "/usr/bin/bun",
    })
    expect(code).toBe(1)
    expect(errors.join("\n")).toContain("git pull")
  })

  test("--version pins the installer and skips the latest-release lookup", async () => {
    const { io } = captureIo()
    const release = fakeRelease("v0.0.1")
    const runs: Array<{ env: Record<string, string> }> = []
    const code = await runUpdate(["--version", "v9.9.9"], io, {}, {
      fetchImpl: release.fetchImpl,
      compiled: true,
      execPath: "/home/u/.local/bin/sensus",
      runInstaller: async (_script, _args, env) => {
        runs.push({ env })
        return 0
      },
    })
    expect(code).toBe(0)
    expect(release.urls.some((u) => u.includes("releases/latest"))).toBe(false)
    expect(runs[0]?.env["SENSUS_RELEASE_VERSION"]).toBe("9.9.9")
  })

  test("--dry-run plans without downloading the installer", async () => {
    const { lines, io } = captureIo()
    const release = fakeRelease("v9.9.9")
    let installs = 0
    const code = await runUpdate(["--dry-run"], io, {}, {
      fetchImpl: release.fetchImpl,
      compiled: true,
      execPath: "/home/u/.local/bin/sensus",
      runInstaller: async () => {
        installs++
        return 0
      },
    })
    expect(code).toBe(0)
    expect(lines.join("\n")).toContain("would install")
    expect(installs).toBe(0)
    expect(release.urls).toHaveLength(1) // only the latest-release lookup
  })

  test("an installer failure surfaces a non-zero exit", async () => {
    const { errors, io } = captureIo()
    const release = fakeRelease("v9.9.9")
    const code = await runUpdate([], io, {}, {
      fetchImpl: release.fetchImpl,
      compiled: true,
      execPath: "/home/u/.local/bin/sensus",
      runInstaller: async () => 3,
    })
    expect(code).toBe(1)
    expect(errors.join("\n")).toContain("exited with code 3")
  })

  test("a failed check exits non-zero with a clear message", async () => {
    const { errors, io } = captureIo()
    const code = await runUpdate([], io, {}, { fetchImpl: failingFetch() })
    expect(code).toBe(1)
    expect(errors.join("\n")).toContain("could not check for updates")
  })

  test("unknown flags print usage and exit non-zero", async () => {
    const { errors, io } = captureIo()
    const code = await runUpdate(["--nope"], io, {})
    expect(code).toBe(1)
    expect(errors.join("\n")).toContain("usage: sensus update")
  })
})
