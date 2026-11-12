/**
 * Embedded cloud client (docs/cloud.md): the daemon REST status/reload, the
 * unpaired = no egress invariant, and the tunnel's terminal 401 handling.
 */

import { describe, expect, test } from "bun:test"
import { NoopEventSink, MemoryStore } from "../../../src/engine/index.ts"
import { createDaemonApp, type DaemonInfo } from "../../../src/daemon/index.ts"
import { CloudTunnel, type TunnelBrokerLike } from "../../../src/daemon/cloud/tunnel.ts"
import { generateIdentity } from "../../../src/auth/identity.ts"
import { defaultPolicy } from "../../../src/auth/policy.ts"

const TOKEN = "0123456789abcdef0123456789abcdef"
const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

function makeInfo(): DaemonInfo {
  return {
    ok: true,
    name: "sensus-daemon",
    version: "9.9.9",
    pid: 4242,
    platform: "linux",
    startedAt: 1_000_000,
    uptimeMs: 1234,
    socket: "/run/user/1000/sensus-1000/daemon.sock",
    home: "/home/tester/.config/sensus",
    uid: 1000,
    unixUser: "tester",
    tcp: { host: "127.0.0.1", port: 54321 },
    shells: 0,
    persistent: false,
    instance: { instanceId: "test-instance", createdAt: 1, version: "9.9.9" },
  }
}

function makeApp(over: Partial<Parameters<typeof createDaemonApp>[0]> = {}) {
  return createDaemonApp({
    token: TOKEN,
    version: "9.9.9",
    info: makeInfo,
    memory: () => new MemoryStore({ dir: "/nonexistent-cloud-test", limits: { memory: 1, host: 1, journal: 1 } }),
    events: new NoopEventSink(),
    ...over,
  })
}

const unpaired = {
  paired: false,
  enabled: false,
  cloud: null,
  instanceId: null,
  fingerprint: null,
  unixUser: null,
  runsAsRoot: false,
  connected: false,
  state: "unpaired" as const,
  lastError: null,
}

describe("daemon cloud routes", () => {
  test("status is bearer-gated and secret-free", async () => {
    const app = makeApp({
      cloud: {
        status: () => ({
          paired: true,
          enabled: true,
          cloud: "https://cloud.example",
          instanceId: "inst_1",
          fingerprint: "abcd-efgh-ijkl-mnop",
          unixUser: "tester",
          runsAsRoot: false,
          connected: true,
          state: "ready",
          lastError: null,
        }),
        reload: async () => unpaired,
      },
    })
    const unauthorized = await app.handle(new Request("http://localhost/v1/cloud/status"))
    expect(unauthorized.status).toBe(401)
    const res = await app.handle(new Request("http://localhost/v1/cloud/status", { headers: auth(TOKEN) }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body["cloud"]).toBe("https://cloud.example")
    expect(body["unixUser"]).toBe("tester")
    expect(JSON.stringify(body)).not.toContain("deviceToken")
    expect(JSON.stringify(body)).not.toContain("privateKey")
  })

  test("reload calls the client and returns the new status", async () => {
    let reloads = 0
    const app = makeApp({
      cloud: {
        status: () => unpaired,
        reload: async () => {
          reloads++
          return { ...unpaired, state: "unpaired" }
        },
      },
    })
    const res = await app.handle(new Request("http://localhost/v1/cloud/reload", { method: "POST", headers: auth(TOKEN) }))
    expect(res.status).toBe(200)
    expect(reloads).toBe(1)
  })
})

function fakeBroker(): TunnelBrokerLike {
  return {
    rpc: async () => ({ ok: true, result: {} }),
    openStream: async () => ({ ok: false, code: "unused", message: "unused" }),
    streamSend: () => ({ ok: true }),
    closeStream: async () => false,
    closeAll: async () => {},
    daemonFacts: async () => ({ state: "running" }),
  }
}

/** A WebSocket that fails its upgrade before firing `open`. */
class FailedUpgradeSocket {
  bufferedAmount = 0
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor() {
    queueMicrotask(() => {
      for (const listener of this.listeners.get("error") ?? []) listener({})
      for (const listener of this.listeners.get("close") ?? []) listener({ code: 1006, reason: "" })
    })
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  close(): void {}
  send(): void {}
}

describe("cloud tunnel upgrade diagnostics", () => {
  test("a failed upgrade reports the HTTP status from the probe", async () => {
    const logs: string[] = []
    const tunnel = new CloudTunnel({
      cloudUrl: "https://cloud.example",
      instanceId: "inst_1",
      deviceToken: "token",
      identity: generateIdentity(),
      policy: defaultPolicy(),
      broker: fakeBroker(),
      connectorVersion: "9.9.9",
      host: { hostname: "box", platform: "linux", arch: "x64" },
      WebSocketImpl: FailedUpgradeSocket as unknown as typeof WebSocket,
      fetchImpl: async () =>
        new Response("<html>Forbidden</html>", {
          status: 403,
          headers: { "content-type": "text/html" },
        }),
      probeUpgrade: true,
      reconnectBaseMs: 60_000,
      reconnectMaxMs: 60_000,
      onLog: (level, message) => {
        if (level === "warn") logs.push(message)
      },
    })
    tunnel.start()
    await Bun.sleep(20)
    expect(tunnel.state).toBe("reconnecting")
    expect(logs.join("\n")).toContain("cloud tunnel upgrade failed: HTTP 403 text/html")
    await tunnel.stop()
  })
})

describe("cloud tunnel preflight", () => {
  test("a revoked/unauthorized whoami stops instead of reconnecting forever", async () => {
    const stopped: string[] = []
    const tunnel = new CloudTunnel({
      cloudUrl: "https://cloud.example",
      instanceId: "inst_1",
      deviceToken: "token",
      identity: generateIdentity(),
      policy: defaultPolicy(),
      broker: fakeBroker(),
      connectorVersion: "9.9.9",
      host: { hostname: "box", platform: "linux", arch: "x64" },
      preflight: true,
      fetchImpl: async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      WebSocketImpl: class {
        constructor() {
          throw new Error("must not open a socket after a 401")
        }
      } as unknown as typeof WebSocket,
      reconnectBaseMs: 1,
      reconnectMaxMs: 1,
      onStopped: (reason) => stopped.push(reason),
    })
    tunnel.start()
    await Bun.sleep(20)
    expect(tunnel.state).toBe("stopped")
    expect(stopped).toEqual(["unauthorized"])
  })
})
