import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCloud } from "../../../src/daemon/cloud/cli"
import { readCloudConnection } from "../../../src/daemon/cloud/state"
import type { DiscoveryResult } from "../../../src/daemon/cloud/discovery"

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
    info: { ok: true, tcp: { host: "127.0.0.1", port: 1234 }, version: "1.0.0" },
    wsUrl: "ws://127.0.0.1:1234/v1/ws",
    epoch: "inst:1",
  },
}

function baseOpts(home: string, uid: number, over: Record<string, unknown> = {}) {
  return {
    home,
    uid,
    env: { HOME: home, SENSUS_HOME: home, USER: "tester" },
    runtimeDir: join(home, "run"),
    interactive: false,
    discover: async () => stopped,
    ...over,
  }
}

describe("sensus cloud pair", () => {
  test("creates identity/policy, pairs, and stores a 0600 connection", async () => {
    const home = tempHome()
    const { io, out } = capture()
    const { fetchImpl } = fakeFetch()
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--allow", "view,chat"],
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

  test("refuses root without approval and accepts --allow-root", async () => {
    const home = tempHome()
    const denied = capture()
    const { fetchImpl } = fakeFetch()
    const deniedCode = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH"],
      denied.io,
      { HOME: home, SENSUS_HOME: home, USER: "root" },
      baseOpts(home, 0, { fetchImpl }),
    )
    expect(deniedCode).toBe(1)
    expect(denied.err.join("\n")).toContain("--allow-root")
    expect(existsSync(join(home, "auth", "identity.json"))).toBe(false)

    const allowed = capture()
    const allowedCode = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--allow-root"],
      allowed.io,
      { HOME: home, SENSUS_HOME: home, USER: "root" },
      baseOpts(home, 0, { fetchImpl }),
    )
    expect(allowedCode).toBe(0)
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
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "root" },
      baseOpts(home, 0, { fetchImpl, interactive: true, confirm: async () => false }),
    )
    expect(code).toBe(1)
    expect(existsSync(join(home, "auth", "identity.json"))).toBe(false)
  })

  test("no daemon: asks to install the per-user service and starts it", async () => {
    const home = tempHome()
    const { io, out } = capture()
    const { fetchImpl } = fakeFetch()
    const installs: Array<{ home: string; runtimeDir: string }> = []
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, {
        fetchImpl,
        interactive: true,
        confirm: async () => true,
        install: async (input: { home: string; runtimeDir: string }) => {
          installs.push(input)
          return 0
        },
      }),
    )
    expect(code).toBe(0)
    expect(out.join("\n")).toContain("no Sensus daemon is running for tester")
    expect(installs).toHaveLength(1)
    expect(out.join("\n")).toContain("installed and enabled")
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
        reload: async () => {
          reloads++
          return { ok: true }
        },
      }),
    )
    expect(code).toBe(0)
    expect(reloads).toBe(1)
    expect(out.join("\n")).toContain("daemon reloaded")
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
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH"],
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
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH", "--allow", "view"],
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

  test("status is machine-readable when unpaired and after pairing", async () => {
    const home = tempHome()
    const unpaired = capture()
    expect(await runCloud(["status", "--json"], unpaired.io, { HOME: home, SENSUS_HOME: home }, baseOpts(home, 1000))).toBe(0)
    expect(JSON.parse(unpaired.out.join("\n")).paired).toBe(false)

    const { io } = capture()
    const { fetchImpl } = fakeFetch()
    await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH"],
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
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, { fetchImpl }),
    )
    const off = capture()
    expect(await runCloud(["unpair"], off.io, { HOME: home, SENSUS_HOME: home }, baseOpts(home, 1000))).toBe(0)
    expect(existsSync(join(home, "cloud", "connection.json"))).toBe(false)
    expect(existsSync(join(home, "auth", "identity.json"))).toBe(true)
  })

  test("a 401 whoami discards the newly stored token", async () => {
    const home = tempHome()
    const { io } = capture()
    const { fetchImpl } = fakeFetch({ revoked: true })
    const code = await runCloud(
      ["pair", "--cloud", "https://cloud.example", "--code", "ABCD-EFGH"],
      io,
      { HOME: home, SENSUS_HOME: home, USER: "tester" },
      baseOpts(home, 1000, { fetchImpl }),
    )
    expect(code).toBe(1)
    expect(existsSync(join(home, "cloud", "connection.json"))).toBe(false)
  })
})
