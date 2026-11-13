import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reconcileCloudService } from "../../../src/daemon/cloud/reconcile"
import { writeCloudConnection, type CloudConnection } from "../../../src/daemon/cloud/state"
import type { ServiceCommandOptions } from "../../../src/daemon/index"

const dirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "sensus-reconcile-test-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function connection(overrides: Partial<CloudConnection> = {}): CloudConnection {
  return {
    version: 1,
    cloud: "https://cloud.example",
    instanceId: "inst_test",
    deviceToken: "device-token",
    fingerprint: "abcd-efgh",
    name: null,
    pairedAt: 1,
    scopes: ["view"],
    clientKind: "sensus-daemon",
    clientVersion: "1.0.0",
    unixUser: "tester",
    uid: 1000,
    runsAsRoot: false,
    enabled: true,
    ...overrides,
  }
}

function pair(home: string, overrides: Partial<CloudConnection> = {}): void {
  const written = writeCloudConnection(home, connection(overrides), { uid: 1000 })
  expect(written.ok).toBe(true)
}

const systemdUnit = (home: string) => join(home, ".config", "systemd", "user", "sensus.service")

describe("cloud service reconciliation", () => {
  test("does nothing when the host is not paired or the tunnel is disabled", async () => {
    const home = tempHome()
    let installs = 0
    const install = async () => {
      installs++
      return 0
    }
    const unpaired = await reconcileCloudService({
      home,
      env: { HOME: home, USER: "tester" },
      platform: "linux",
      install,
    })
    expect(unpaired.status).toBe("unpaired")

    pair(home, { enabled: false })
    const disabled = await reconcileCloudService({
      home,
      env: { HOME: home, USER: "tester" },
      platform: "linux",
      install,
    })
    expect(disabled.status).toBe("disabled")
    expect(installs).toBe(0)
  })

  test("leaves an existing unit alone", async () => {
    const home = tempHome()
    pair(home)
    let installs = 0
    const result = await reconcileCloudService({
      home,
      env: { HOME: home, USER: "tester" },
      platform: "linux",
      unitExists: (path) => path === systemdUnit(home),
      install: async () => {
        installs++
        return 0
      },
    })
    expect(result.status).toBe("present")
    expect(result.detail).toBe(systemdUnit(home))
    expect(installs).toBe(0)
  })

  test("installs a missing unit without starting a second daemon, and enables lingering", async () => {
    const home = tempHome()
    pair(home)
    const seen: { opts: ServiceCommandOptions | null } = { opts: null }
    const enabledFor: string[] = []
    const result = await reconcileCloudService({
      home,
      env: { HOME: home, USER: "tester" },
      platform: "linux",
      unitExists: () => false,
      systemdAvailable: () => true,
      linger: async () => ({
        applicable: true,
        enabled: false,
        user: "tester",
        enableCommand: "loginctl enable-linger tester",
        detail: null,
      }),
      enableLinger: async ({ user }) => {
        enabledFor.push(user ?? "")
        return { ok: true, detail: null }
      },
      install: async (opts) => {
        seen.opts = opts
        return 0
      },
    })
    expect(result.status).toBe("installed")
    expect(result.detail).toBe(systemdUnit(home))
    expect(result.linger).toBe("enabled")
    expect(enabledFor).toEqual(["tester"])
    expect(seen.opts?.startNow).toBe(false)
    expect(seen.opts?.sensusHome).toBe(home)
    expect(seen.opts?.home).toBe(home)
  })

  test("a failed install is a value, not a throw", async () => {
    const home = tempHome()
    pair(home)
    const result = await reconcileCloudService({
      home,
      env: { HOME: home, USER: "tester" },
      platform: "linux",
      unitExists: () => false,
      systemdAvailable: () => true,
      linger: async () => ({
        applicable: false,
        enabled: null,
        user: "tester",
        enableCommand: null,
        detail: "not systemd",
      }),
      install: async () => 1,
    })
    expect(result.status).toBe("failed")
    expect(result.detail).toContain("service install exited 1")
  })

  test("a malformed pairing and an unsupported platform are reported without installing", async () => {
    const home = tempHome()
    expect(
      (
        await reconcileCloudService({
          home,
          env: { HOME: home, USER: "tester" },
          platform: "linux",
          install: async () => {
            throw new Error("should not install")
          },
        })
      ).status,
    ).toBe("unpaired")

    const broken = tempHome()
    mkdirSync(join(broken, "cloud"), { recursive: true })
    writeFileSync(join(broken, "cloud", "connection.json"), "{not json")
    expect(
      (
        await reconcileCloudService({
          home: broken,
          env: { HOME: broken, USER: "tester" },
          platform: "linux",
          install: async () => {
            throw new Error("should not install")
          },
        })
      ).status,
    ).toBe("failed")

    pair(home)
    let installs = 0
    const unsupported = await reconcileCloudService({
      home,
      env: { HOME: home, USER: "tester" },
      platform: "win32",
      install: async () => {
        installs++
        return 0
      },
    })
    expect(unsupported.status).toBe("unsupported")
    expect(installs).toBe(0)

    const noSystemd = await reconcileCloudService({
      home,
      env: { HOME: home, USER: "tester" },
      platform: "linux",
      unitExists: () => false,
      systemdAvailable: () => false,
      install: async () => {
        installs++
        return 0
      },
    })
    expect(noSystemd.status).toBe("unsupported")
    expect(noSystemd.detail).toBe("systemd is not running")
    expect(installs).toBe(0)
  })
})
