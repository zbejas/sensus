import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCloud, type CloudDaemonStatus } from "../../../src/daemon/cloud/cli"
import {
  fetchConnectorConfig,
  intersectConnectorProfile,
  parseConnectorConfigProfile,
  type ConnectorConfigProfile,
} from "../../../src/daemon/cloud/pairing"
import { readCloudConnection } from "../../../src/daemon/cloud/state"
import type { DaemonInfoPayload, DiscoveryResult } from "../../../src/daemon/cloud/discovery"
import type { ServiceCommandOptions } from "../../../src/daemon/index"
import { SENSUS_VERSION } from "../../../src/version"

const dirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "sensus-cloud-test-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function capture() {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err }
}

function fakeFetch(options: { state?: "active" | "pending"; revoked?: boolean } = {}) {
  const calls: string[] = []
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith("/api/connector/pair")) {
      return new Response(
        JSON.stringify({ instanceId: "inst_test", deviceToken: "device-token", fingerprint: "abcd-efgh-ijkl-mnop" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    if (url.endsWith("/api/connector/whoami")) {
      if (options.revoked === true) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
      return new Response(
        JSON.stringify({ ok: true, instanceId: "inst_test", state: options.state ?? "active", scopes: ["view"] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    return new Response("not found", { status: 404 })
  }
  return { fetchImpl, calls }
}

const stopped: DiscoveryResult = { ok: false, code: "daemon_socket_missing", message: "no daemon", state: "stopped" }
const running: DiscoveryResult = {
  ok: true,
  discovery: {
    runtimeDir: "/tmp/runtime",
    token: "token",
    info: { ok: true, tcp: { host: "127.0.0.1", port: 1234 }, version: SENSUS_VERSION },
    wsUrl: "ws://127.0.0.1:1234/v1/ws",
    epoch: "inst:1",
  },
}

function runningWith(info: Partial<DaemonInfoPayload> = {}): DiscoveryResult {
  return {
    ok: true,
    discovery: {
      runtimeDir: "/tmp/runtime",
      token: "token",
      info: { ok: true, tcp: { host: "127.0.0.1", port: 1234 }, version: SENSUS_VERSION, ...info },
      wsUrl: "ws://127.0.0.1:1234/v1/ws",
      epoch: "inst:1",
    },
  }
}

/** A daemon whose tunnel is connected (the post-pair happy path). */
function readyDaemon(home: string, over: Partial<CloudDaemonStatus> = {}): CloudDaemonStatus {
  return {
    running: true,
    state: "ready",
    connected: true,
    lastError: null,
    version: SENSUS_VERSION,
    pid: 4242,
    home,
    unixUser: "tester",
    uid: 1000,
    probeError: null,
    profile: null,
    ...over,
  }
}

function baseOpts(home: string, uid: number, over: Record<string, unknown> = {}) {
  return {
    home,
    uid,
    env: { HOME: home, SENSUS_HOME: home, USER: "tester" },
    runtimeDir: join(home, "run"),
    interactive: false,
    discover: async () => stopped,
    // Pairing installs and starts the daemon by default, so every unrelated
    // test needs a no-op service seam rather than touching systemd/launchd.
    install: async () => 0,
    installSystem: async () => 0,
    systemInstalled: () => false,
    findDaemonConflicts: () => [],
    rootUserUnitInstalled: () => false,
    stopRootDaemon: async () => 0,
    start: async () => 0,
    linger: async () => ({
      applicable: false,
      enabled: null,
      user: "tester",
      enableCommand: null,
      detail: "not systemd (test)",
    }),
    enableLinger: async () => ({ ok: true, detail: null }),
    ...over,
  }
}

describe("sensus cloud pair", () => {
  test("creates identity/policy, pairs, and stores a 0600 connection", async () => {
    const home = tempHome()
    const { io, out } = capture()
    const { fetchImpl } = fakeFetch()
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--allow", "view,chat", "--no-wait"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, { fetchImpl }),
    )
    expect(code).toBe(0)
    expect(out.join("\n")).toContain("paired with https://cloud.example")
    const conn = readCloudConnection(home)
    expect(conn.ok).toBe(true)
    if (!conn.ok || conn.connection === null) return
    expect(conn.connection.cloud).toBe("https://cloud.example")
    expect(conn.connection.instanceId).toBe("inst_test")
    expect(conn.connection.scopes).toEqual(["view", "chat"])
    expect(conn.connection.unixUser).toBe("tester")
    expect(conn.connection.runsAsRoot).toBe(false)
    expect(conn.connection.clientKind).toBe("sensus-daemon")
    expect(existsSync(join(home, "auth", "identity.json"))).toBe(true)
    expect(existsSync(join(home, "auth", "policy.json"))).toBe(true)
    const raw = readFileSync(join(home, "cloud", "connection.json"), "utf8")
    expect(JSON.parse(raw).deviceToken).toBe("device-token")
  })

  test("interactive pairing without --allow asks which scopes to grant", async () => {
    const home = tempHome()
    const { io, err } = capture()
    const { fetchImpl } = fakeFetch()
    const prompts: string[] = []
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, {
        fetchImpl,
        interactive: true,
        confirm: async () => false,
        promptText: async (question: string) => {
          prompts.push(question)
          return ""
        },
      }),
    )
    expect(code).toBe(0)
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain("[view,chat,control]")
    expect(err.join("\n")).toContain("orchestrator")
    const conn = readCloudConnection(home)
    expect(conn.ok).toBe(true)
    if (!conn.ok || conn.connection === null) return
    expect(conn.connection.scopes).toEqual(["view", "chat", "control"])
  })

  test("interactive pairing accepts a custom scope list and re-asks on invalid input", async () => {
    const home = tempHome()
    const { io, err } = capture()
    const { fetchImpl } = fakeFetch()
    const answers = ["root", "view,chat"]
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, {
        fetchImpl,
        interactive: true,
        confirm: async () => false,
        promptText: async () => answers.shift() ?? "view",
      }),
    )
    expect(code).toBe(0)
    expect(err.join("\n")).toContain("unknown scope")
    const conn = readCloudConnection(home)
    expect(conn.ok).toBe(true)
    if (!conn.ok || conn.connection === null) return
    expect(conn.connection.scopes).toEqual(["view", "chat"])
  })

  test("non-interactive pairing without --allow keeps the view-only default", async () => {
    const home = tempHome()
    const { io } = capture()
    const { fetchImpl } = fakeFetch()
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, { fetchImpl }),
    )
    expect(code).toBe(0)
    const conn = readCloudConnection(home)
    expect(conn.ok).toBe(true)
    if (!conn.ok || conn.connection === null) return
    expect(conn.connection.scopes).toEqual(["view"])
  })

  test("refuses root without approval and accepts --allow-root", async () => {
    const home = tempHome()
    const denied = capture()
    const { fetchImpl } = fakeFetch()
    // --user forces the per-user service, which keeps the explicit root gate.
    const deniedCode = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait", "--user"],
      denied.io,
      { HOME: home, SENSUS_HOME: home, USER: "root" },
      baseOpts(home, 0, { fetchImpl }),
    )
    expect(deniedCode).toBe(1)
    expect(denied.err.join("\n")).toContain("--allow-root")
    expect(existsSync(join(home, "auth", "identity.json"))).toBe(false)

    const allowed = capture()
    const allowedCode = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--allow-root", "--no-wait", "--user"],
      allowed.io,
      { HOME: home, SENSUS_HOME: home, USER: "root" },
      baseOpts(home, 0, { fetchImpl }),
    )
    expect(allowedCode).toBe(0)
    expect(allowed.err.join("\n")).toContain("installing a root user service")
    expect(allowed.out.join("\n")).toContain("installed and enabled the Sensus daemon service")
    const conn = readCloudConnection(home)
    expect(conn.ok).toBe(true)
    if (conn.ok && conn.connection !== null) {
      expect(conn.connection.runsAsRoot).toBe(true)
      expect(conn.connection.unixUser).toBe("root")
    }
  })

  test("interactive root approval can decline without writing", async () => {
    const home = tempHome()
    const { io } = capture()
    const { fetchImpl } = fakeFetch()
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait", "--user"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "root" },
      baseOpts(home, 0, { fetchImpl, interactive: true, confirm: async () => false }),
    )
    expect(code).toBe(1)
    expect(existsSync(join(home, "auth", "identity.json"))).toBe(false)
  })

  test("root defaults to the system service without --allow-root", async () => {
    const home = tempHome()
    const { io, out } = capture()
    const { fetchImpl } = fakeFetch()
    const systems: Array<{ home: string; runtimeDir: string; startNow?: boolean }> = []
    let userInstalls = 0
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "root" },
      baseOpts(home, 0, {
        fetchImpl,
        installSystem: async (input: { home: string; runtimeDir: string; startNow?: boolean }) => {
          systems.push(input)
          return 0
        },
        install: async () => {
          userInstalls++
          return 0
        },
      }),
    )
    expect(code).toBe(0)
    expect(userInstalls).toBe(0)
    expect(systems).toHaveLength(1)
    expect(systems[0]?.startNow).toBe(true)
    expect(out.join("\n")).toContain("installing the root Sensus system service")
    expect(out.join("\n")).toContain("installed and enabled the root Sensus system service")
    const conn = readCloudConnection(home)
    expect(conn.ok && conn.connection?.serviceScope).toBe("system")
  })

  test("another account's daemon aborts the root switch before pairing", async () => {
    const home = tempHome()
    const { io, err } = capture()
    const { fetchImpl } = fakeFetch()
    let systems = 0
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "root" },
      baseOpts(home, 0, {
        fetchImpl,
        findDaemonConflicts: () => [{ runtimeDir: "/run/user/1000/sensus-1000", uid: 1000, pid: 123 }],
        installSystem: async () => {
          systems++
          return 0
        },
      }),
    )
    expect(code).toBe(1)
    expect(err.join("\n")).toContain("another account")
    expect(err.join("\n")).toContain("systemctl --user disable --now sensus")
    expect(systems).toBe(0)
    expect(existsSync(join(home, "auth", "identity.json"))).toBe(false)
  })

  test("a root user daemon is stopped after the switch prompt", async () => {
    const home = tempHome()
    const { io, out } = capture()
    const { fetchImpl } = fakeFetch()
    const stopped: string[] = []
    let systems = 0
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "root" },
      baseOpts(home, 0, {
        fetchImpl,
        interactive: true,
        confirm: async () => true,
        promptText: async () => "view",
        findDaemonConflicts: () => [{ runtimeDir: "/run/user/0/sensus-0", uid: 0, pid: 123 }],
        stopRootDaemon: async (runtimeDir: string) => {
          stopped.push(runtimeDir)
          return 0
        },
        installSystem: async () => {
          systems++
          return 0
        },
      }),
    )
    expect(code).toBe(0)
    expect(stopped).toEqual(["/run/user/0/sensus-0"])
    expect(systems).toBe(1)
    expect(out.join("\n")).toContain("installing the root Sensus system service")
  })

  test("declining the switch prompt leaves the existing root daemon alone", async () => {
    const home = tempHome()
    const { io, err } = capture()
    const { fetchImpl } = fakeFetch()
    let stopped = 0
    let systems = 0
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "root" },
      baseOpts(home, 0, {
        fetchImpl,
        interactive: true,
        confirm: async () => false,
        findDaemonConflicts: () => [{ runtimeDir: "/run/user/0/sensus-0", uid: 0, pid: 123 }],
        stopRootDaemon: async () => {
          stopped++
          return 0
        },
        installSystem: async () => {
          systems++
          return 0
        },
      }),
    )
    expect(code).toBe(1)
    expect(stopped).toBe(0)
    expect(systems).toBe(0)
    expect(err.join("\n")).toContain("cancelled")
  })

  test("non-interactive pairing installs the service automatically and waits for the tunnel", async () => {
    const home = tempHome()
    const { io, out, err } = capture()
    const { fetchImpl } = fakeFetch()
    const installs: Array<{ home: string; runtimeDir: string }> = []
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, {
        fetchImpl,
        cloudStatus: async () => readyDaemon(home),
        install: async (input: { home: string; runtimeDir: string }) => {
          installs.push(input)
          return 0
        },
      }),
    )
    expect(code).toBe(0)
    expect(err.join("\n")).not.toContain("could not")
    expect(out.join("\n")).toContain("no Sensus daemon is running for tester")
    expect(out.join("\n")).toContain("installing the Sensus daemon service")
    expect(installs).toHaveLength(1)
    expect(installs[0]?.home).toBe(home)
    expect(out.join("\n")).toContain("installed and enabled")
    expect(out.join("\n")).toContain("tunnel connected")
    const conn = readCloudConnection(home)
    expect(conn.ok && conn.connection?.serviceScope).toBe("user")
  })

  test("lingering is enabled automatically before the service install", async () => {
    const home = tempHome()
    const { io, out } = capture()
    const { fetchImpl } = fakeFetch()
    const enabled: string[] = []
    let installs = 0
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, {
        fetchImpl,
        linger: async () => ({
          applicable: true,
          enabled: false,
          user: "tester",
          enableCommand: "loginctl enable-linger tester",
          detail: null,
        }),
        enableLinger: async ({ user }: { user: string }) => {
          enabled.push(user)
          return { ok: true, detail: null }
        },
        install: async () => {
          installs++
          return 0
        },
      }),
    )
    expect(code).toBe(0)
    expect(enabled).toEqual(["tester"])
    expect(installs).toBe(1)
    expect(out.join("\n")).toContain("lingering enabled for tester")
  })

  test("a refused lingering command warns but does not fail the pairing", async () => {
    const home = tempHome()
    const { io, out, err } = capture()
    const { fetchImpl } = fakeFetch()
    let installs = 0
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, {
        fetchImpl,
        linger: async () => ({
          applicable: true,
          enabled: false,
          user: "tester",
          enableCommand: "loginctl enable-linger tester",
          detail: null,
        }),
        enableLinger: async () => ({ ok: false, detail: "Interactive authentication required" }),
        install: async () => {
          installs++
          return 0
        },
      }),
    )
    expect(code).toBe(0)
    expect(installs).toBe(1)
    expect(out.join("\n")).toContain("installed and enabled")
    expect(err.join("\n")).toContain("could not enable lingering for tester")
    expect(err.join("\n")).toContain("loginctl enable-linger tester")
  })

  test("--no-linger skips the lingering attempt", async () => {
    const home = tempHome()
    const { io, out } = capture()
    const { fetchImpl } = fakeFetch()
    let lingerEnabled = 0
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait", "--no-linger"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, {
        fetchImpl,
        linger: async () => ({
          applicable: true,
          enabled: false,
          user: "tester",
          enableCommand: "loginctl enable-linger tester",
          detail: null,
        }),
        enableLinger: async () => {
          lingerEnabled++
          return { ok: true, detail: null }
        },
      }),
    )
    expect(code).toBe(0)
    expect(lingerEnabled).toBe(0)
    expect(out.join("\n")).not.toContain("lingering enabled for tester")
  })

  test("a failed service install falls back to a detached daemon start", async () => {
    const home = tempHome()
    const { io, out, err } = capture()
    const { fetchImpl } = fakeFetch()
    let starts = 0
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, {
        fetchImpl,
        install: async () => 1,
        start: async () => {
          starts++
          return 0
        },
      }),
    )
    expect(code).toBe(0)
    expect(starts).toBe(1)
    expect(err.join("\n")).toContain("could not install the daemon service")
    expect(out.join("\n")).toContain("will not restart after a reboot")
  })

  test("--no-service starts the daemon for the session without installing a unit", async () => {
    const home = tempHome()
    const { io, out } = capture()
    const { fetchImpl } = fakeFetch()
    let installs = 0
    let starts = 0
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait", "--no-service"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, {
        fetchImpl,
        install: async () => {
          installs++
          return 0
        },
        start: async () => {
          starts++
          return 0
        },
      }),
    )
    expect(code).toBe(0)
    expect(installs).toBe(0)
    expect(starts).toBe(1)
    expect(out.join("\n")).toContain("--no-service set")
    const conn = readCloudConnection(home)
    expect(conn.ok && conn.connection?.serviceScope).toBe("none")
  })

  test("a running daemon is reloaded instead of prompting for a service", async () => {
    const home = tempHome()
    const { io, out } = capture()
    const { fetchImpl } = fakeFetch()
    let reloads = 0
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, {
        fetchImpl,
        discover: async () => running,
        cloudStatus: async () => readyDaemon(home),
        reload: async () => {
          reloads++
          return { ok: true }
        },
      }),
    )
    expect(code).toBe(0)
    expect(reloads).toBe(1)
    expect(out.join("\n")).toContain("daemon reloaded")
    expect(out.join("\n")).toContain("tunnel connected")
  })

  test("a running daemon also gets the missing service installed without a second start", async () => {
    const home = tempHome()
    const { io, out } = capture()
    const { fetchImpl } = fakeFetch()
    const installs: ServiceCommandOptions[] = []
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, {
        fetchImpl,
        discover: async () => running,
        reload: async () => ({ ok: true }),
        unitExists: () => false,
        systemdAvailable: () => true,
        linger: async () => ({
          applicable: true,
          enabled: true,
          user: "tester",
          enableCommand: "loginctl enable-linger tester",
          detail: null,
        }),
        install: async (input: unknown) => {
          installs.push(input as ServiceCommandOptions)
          return 0
        },
      }),
    )
    expect(code).toBe(0)
    expect(installs).toHaveLength(1)
    expect(installs[0]?.startNow).toBe(false)
    expect(out.join("\n")).toContain("installed and enabled the Sensus daemon service")
  })

  test("--no-service skips the unit even with a running daemon", async () => {
    const home = tempHome()
    const { io } = capture()
    const { fetchImpl } = fakeFetch()
    let installs = 0
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait", "--no-service"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, {
        fetchImpl,
        discover: async () => running,
        unitExists: () => false,
        systemdAvailable: () => true,
        install: async () => {
          installs++
          return 0
        },
      }),
    )
    expect(code).toBe(0)
    expect(installs).toBe(0)
  })

  test("the pair request advertises the embedded daemon and host user", async () => {
    const home = tempHome()
    const { io } = capture()
    let body: Record<string, unknown> | null = null
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.endsWith("/api/connector/pair")) {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ instanceId: "inst_test", deviceToken: "token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ ok: true, state: "active", scopes: ["view"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "alice" },
      baseOpts(home, 1000, { fetchImpl }),
    )
    expect(code).toBe(0)
    expect(body).not.toBeNull()
    const payload = body as Record<string, unknown> | null
    if (payload === null) return
    expect(payload["clientKind"]).toBe("sensus-daemon")
    expect(payload["clientVersion"]).toMatch(/^\d+\.\d+\.\d+/)
    expect(payload["connectorVersion"]).toBe(payload["clientVersion"])
    expect((payload["host"] as Record<string, unknown>)["unixUser"]).toBe("alice")
    expect((payload["host"] as Record<string, unknown>)["uid"]).toBe(1000)
    expect((payload["host"] as Record<string, unknown>)["runsAsRoot"]).toBe(false)
  })

  test("scopes shows and updates the host policy without re-pairing", async () => {
    const home = tempHome()
    const { io } = capture()
    const { fetchImpl } = fakeFetch()
    await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--allow", "view", "--no-wait"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, { fetchImpl }),
    )
    let reloads = 0
    const updated = capture()
    const code = await runCloud(
      ["scopes", "--allow", "control"],
      updated.io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, {
        discover: async () => running,
        reload: async () => {
          reloads++
          return { ok: true }
        },
      }),
    )
    expect(code).toBe(0)
    expect(reloads).toBe(1)
    const policy = JSON.parse(readFileSync(join(home, "auth", "policy.json"), "utf8"))
    expect(policy.scopes).toEqual(["view", "control"])
    expect(updated.out.join("\n")).toContain("view,control")

    const bad = capture()
    expect(await runCloud(["scopes", "--allow", "root"], bad.io, { HOME: home, SENSUS_HOME: home }, baseOpts(home, 1000))).toBe(1)
    expect(bad.err.join("\n")).toContain("unknown scope")
  })

  test("scopes --delete-transcripts toggles the destructive opt-in and warns about permanence", async () => {
    const home = tempHome()
    const { io } = capture()
    const { fetchImpl } = fakeFetch()
    await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--allow", "view,control", "--no-wait"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, { fetchImpl }),
    )

    const shown = capture()
    expect(await runCloud(["scopes"], shown.io, { HOME: home, SENSUS_HOME: home }, baseOpts(home, 1000))).toBe(0)
    expect(shown.out.join("\n")).toContain("delete transcripts off")

    const on = capture()
    expect(
      await runCloud(["scopes", "--delete-transcripts", "on"], on.io, { HOME: home, SENSUS_HOME: home }, baseOpts(home, 1000)),
    ).toBe(0)
    const enabled = JSON.parse(readFileSync(join(home, "auth", "policy.json"), "utf8"))
    expect(enabled.deleteTranscripts).toBe(true)
    expect(enabled.scopes).toEqual(["view", "control"])
    expect(on.out.join("\n")).toContain("delete transcripts on")
    expect(on.err.join("\n")).toContain("permanent")
    expect(on.err.join("\n")).toContain("no trash")

    const off = capture()
    expect(
      await runCloud(["scopes", "--delete-transcripts", "off"], off.io, { HOME: home, SENSUS_HOME: home }, baseOpts(home, 1000)),
    ).toBe(0)
    expect(JSON.parse(readFileSync(join(home, "auth", "policy.json"), "utf8")).deleteTranscripts).toBe(false)

    const bad = capture()
    expect(
      await runCloud(["scopes", "--delete-transcripts", "maybe"], bad.io, { HOME: home, SENSUS_HOME: home }, baseOpts(home, 1000)),
    ).toBe(1)
    expect(bad.err.join("\n")).toContain("on` or `off")
  })

  test("status is machine-readable when unpaired and after pairing", async () => {
    const home = tempHome()
    const unpaired = capture()
    expect(await runCloud(["status", "--json"], unpaired.io, { HOME: home, SENSUS_HOME: home }, baseOpts(home, 1000))).toBe(0)
    const unpairedJson = JSON.parse(unpaired.out.join("\n"))
    expect(unpairedJson.paired).toBe(false)
    expect(unpairedJson.daemon.state).toBe("stopped")
    expect(unpairedJson.daemon.connected).toBe(false)
    expect(unpairedJson.daemon.lastError).toBeNull()
    expect(unpairedJson.daemon.probeError).toBeNull()

    const { io } = capture()
    const { fetchImpl } = fakeFetch()
    await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, { fetchImpl }),
    )
    const paired = capture()
    expect(await runCloud(["status", "--json"], paired.io, { HOME: home, SENSUS_HOME: home }, baseOpts(home, 1000))).toBe(0)
    const parsed = JSON.parse(paired.out.join("\n"))
    expect(parsed.paired).toBe(true)
    expect(parsed.cloud).toBe("https://cloud.example")
    expect(parsed.daemon.running).toBe(false)
  })

  test("unpair removes the local token but keeps the identity", async () => {
    const home = tempHome()
    const { io } = capture()
    const { fetchImpl } = fakeFetch()
    await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, { fetchImpl }),
    )
    const off = capture()
    expect(await runCloud(["unpair"], off.io, { HOME: home, SENSUS_HOME: home }, baseOpts(home, 1000))).toBe(0)
    expect(existsSync(join(home, "cloud", "connection.json"))).toBe(false)
    expect(existsSync(join(home, "auth", "identity.json"))).toBe(true)
  })

  test("status reports a daemon API failure instead of leaving the tunnel unknown", async () => {
    const home = tempHome()
    const { fetchImpl } = fakeFetch()
    await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait"],
      capture().io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, { fetchImpl }),
    )
    const status = capture()
    const code = await runCloud(
      ["status", "--json"],
      status.io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, {
        cloudStatus: async () => ({
          running: true,
          state: "error",
          connected: false,
          lastError: "GET /v1/cloud/status returned HTTP 503",
          version: SENSUS_VERSION,
          pid: 4242,
          home,
          unixUser: "tester",
          uid: 1000,
          probeError: "GET /v1/cloud/status returned HTTP 503",
          profile: null,
        }),
      }),
    )
    expect(code).toBe(1)
    const parsed = JSON.parse(status.out.join("\n"))
    expect(parsed.home).toBe(home)
    expect(parsed.daemon.state).toBe("error")
    expect(parsed.daemon.connected).toBe(false)
    expect(parsed.daemon.lastError).toContain("HTTP 503")
    expect(parsed.daemon.version).toBe(SENSUS_VERSION)
    expect(parsed.daemon.probeError).toContain("HTTP 503")
  })

  test("status flags a daemon using another config home", async () => {
    const home = tempHome()
    const other = tempHome()
    const { fetchImpl } = fakeFetch()
    await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait"],
      capture().io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, { fetchImpl }),
    )
    const status = capture()
    const code = await runCloud(
      ["status", "--json"],
      status.io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, { cloudStatus: async () => readyDaemon(other) }),
    )
    expect(code).toBe(1)
    const parsed = JSON.parse(status.out.join("\n"))
    expect(parsed.homeMismatch).toBe(true)
    expect(parsed.daemon.home).toBe(other)
  })

  test("pair refuses a running daemon that reads another config home", async () => {
    const home = tempHome()
    const other = tempHome()
    const { io, err } = capture()
    const { fetchImpl } = fakeFetch()
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, { fetchImpl, discover: async () => runningWith({ home: other, uid: 1000 }) }),
    )
    expect(code).toBe(1)
    expect(err.join("\n")).toContain("SENSUS_HOME")
    expect(existsSync(join(home, "cloud", "connection.json"))).toBe(false)
    expect(existsSync(join(home, "auth", "identity.json"))).toBe(false)
  })

  test("pair exits non-zero when the tunnel never connects", async () => {
    const home = tempHome()
    const { io, out, err } = capture()
    const { fetchImpl } = fakeFetch()
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, {
        fetchImpl,
        discover: async () => runningWith({ home, uid: 1000 }),
        reload: async () => ({ ok: true }),
        waitTimeoutMs: 25,
        waitPollMs: 1,
        cloudStatus: async () =>
          readyDaemon(home, {
            connected: false,
            state: "reconnecting",
            lastError: "cloud tunnel upgrade failed: HTTP 403 text/html",
          }),
      }),
    )
    expect(code).toBe(1)
    expect(out.join("\n")).toContain("pairing saved")
    expect(err.join("\n")).toContain("HTTP 403")
  })

  test("doctor reports the pairing, tunnel and lingering state", async () => {
    const home = tempHome()
    const { fetchImpl } = fakeFetch()
    await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait"],
      capture().io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, { fetchImpl }),
    )
    const doctor = capture()
    const code = await runCloud(
      ["doctor", "--json"],
      doctor.io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, {
        fetchImpl,
        discover: async () => runningWith({ home, uid: 1000, unixUser: "tester" }),
        cloudStatus: async () => readyDaemon(home),
        linger: async ({ env }: { env: NodeJS.ProcessEnv }) => ({
          applicable: true,
          enabled: false,
          user: env["USER"] ?? "tester",
          enableCommand: "loginctl enable-linger tester",
          detail: null,
        }),
      }),
    )
    expect(code).toBe(0)
    const parsed = JSON.parse(doctor.out.join("\n"))
    expect(parsed.ok).toBe(true)
    const checks = parsed.checks as Array<{ id: string; status: string; message: string }>
    expect(checks.find((check) => check.id === "pairing")?.status).toBe("ok")
    expect(checks.find((check) => check.id === "tunnel")?.status).toBe("ok")
    expect(checks.find((check) => check.id === "linger")?.status).toBe("warn")
    expect(checks.find((check) => check.id === "linger")?.message).toContain("loginctl enable-linger")
  })

  test("a 401 whoami discards the newly stored token", async () => {
    const home = tempHome()
    const { io } = capture()
    const { fetchImpl } = fakeFetch({ revoked: true })
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, { fetchImpl }),
    )
    expect(code).toBe(1)
    expect(existsSync(join(home, "cloud", "connection.json"))).toBe(false)
  })

  test("status shows the assigned cloud profile pulled by the daemon", async () => {
    const home = tempHome()
    const { fetchImpl } = fakeFetch()
    await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--no-wait"],
      capture().io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, { fetchImpl }),
    )
    const profile: ConnectorConfigProfile = {
      id: "cfg_1",
      name: "EU production",
      updatedAt: 1_794_327_000_000,
      scopes: ["view", "chat"],
      deniedFeatures: ["memory.read"],
      chatApproval: "confirm",
      conductorApprovals: "off",
      maxStreams: 2,
    }
    const statusOpts = baseOpts(home, 1000, { cloudStatus: async () => readyDaemon(home, { profile }) })
    const json = capture()
    expect(await runCloud(["status", "--json"], json.io, { HOME: home, SENSUS_HOME: home, USER: "tester" }, statusOpts)).toBe(0)
    const parsed = JSON.parse(json.out.join("\n"))
    expect(parsed.daemon.profile).toMatchObject({
      id: "cfg_1",
      name: "EU production",
      updatedAt: 1_794_327_000_000,
      scopes: ["view", "chat"],
      deniedFeatures: ["memory.read"],
      chatApproval: "confirm",
      conductorApprovals: "off",
      maxStreams: 2,
    })
    const human = capture()
    expect(await runCloud(["status"], human.io, { HOME: home, SENSUS_HOME: home, USER: "tester" }, statusOpts)).toBe(0)
    const text = human.out.join("\n")
    expect(text).toContain("profile     EU production")
    expect(text).toContain("denied memory.read")
    expect(text).toContain("max streams 2")
  })
})

describe("cloud config profile pull", () => {
  const connection = { cloud: "https://cloud.example", instanceId: "inst_1", deviceToken: "device-token" }
  const valid: ConnectorConfigProfile = {
    id: "cfg_1",
    name: "EU production",
    updatedAt: 1_794_327_000_000,
    scopes: ["view", "chat"],
    deniedFeatures: ["memory.read"],
    chatApproval: "confirm",
    conductorApprovals: "off",
    maxStreams: 2,
  }

  test("fetches with device auth and intersects the profile with the local policy", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const result = await fetchConnectorConfig(connection, {
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
        })
        return Response.json({ version: 1, profile: valid, serverTime: Date.now() })
      },
    })
    expect(result.ok).toBe(true)
    expect(result.profile).toEqual(valid)
    expect(calls[0]?.url).toBe("https://cloud.example/api/connector/config")
    expect(calls[0]?.headers["x-sensus-instance"]).toBe("inst_1")
    expect(calls[0]?.headers["authorization"]).toBe("Bearer device-token")

    // The host policy grants view only: the cloud cannot widen it.
    const narrowed = intersectConnectorProfile(result.profile!, ["view"], 8)
    expect(narrowed.scopes).toEqual(["view"])
    expect(narrowed.maxStreams).toBe(2)
  })

  test("a malformed profile is rejected instead of falling back to a wider default", async () => {
    const malformed: unknown[] = [
      { ...valid, scopes: ["view", "bogus"] },
      { ...valid, scopes: "view" },
      { ...valid, deniedFeatures: ["not-a-feature"] },
      { ...valid, chatApproval: "full-auto" },
      { ...valid, conductorApprovals: "on" },
      { ...valid, updatedAt: "now" },
      { ...valid, maxStreams: 99 },
      { ...valid, maxStreams: "2" },
    ]
    for (const profile of malformed) {
      expect(parseConnectorConfigProfile(profile)).toBeNull()
    }
    expect(parseConnectorConfigProfile(valid)).toEqual(valid)
  })

  test("a bad response is reported as a failed pull, never as an empty profile", async () => {
    const bad = await fetchConnectorConfig(connection, {
      fetchImpl: async () => Response.json({ version: 1, profile: "not-an-object" }),
    })
    expect(bad.ok).toBe(false)
    expect(bad.profile).toBeNull()
    expect(bad.error).toContain("invalid config profile")

    const unsupported = await fetchConnectorConfig(connection, {
      fetchImpl: async () => Response.json({ version: 2, profile: null }),
    })
    expect(unsupported.ok).toBe(false)
    expect(unsupported.error).toContain("unsupported config pull version")

    const unauthorized = await fetchConnectorConfig(connection, {
      fetchImpl: async () => Response.json({ error: "unauthorized" }, { status: 401 }),
    })
    expect(unauthorized.ok).toBe(false)
    expect(unauthorized.status).toBe(401)
  })
})
