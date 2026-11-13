/**
 * End-to-end embedded tunnel: a real Sensus daemon pairs with a fake cloud,
 * signs the challenge, sends `hello` with host/user metadata, and brokers a
 * `daemon.info` RPC back to the local daemon.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { loadOrCreateIdentity, verifyChallenge } from "../../../src/auth/identity"
import { defaultPolicy, writePolicy } from "../../../src/auth/policy"
import { writeCloudConnection } from "../../../src/daemon/cloud/state"
import { startDaemon } from "../../../src/daemon/serve"
import { defaultConfig } from "../../../src/engine/index.ts"
import { sessionFilePath } from "../../../src/session/store.ts"
import { SENSUS_VERSION } from "../../../src/version.ts"

const cleanup: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

function waitFor<T>(read: () => T | null, timeoutMs = 8000): Promise<T> {
  const start = Date.now()
  return new Promise<T>((resolve, reject) => {
    const tick = (): void => {
      const value = read()
      if (value !== null) {
        resolve(value)
        return
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("timed out waiting for the cloud frame"))
        return
      }
      setTimeout(tick, 10)
    }
    tick()
  })
}

describe("embedded cloud tunnel", () => {
  test("pairs, signs the challenge, sends host metadata, and brokers daemon.info", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sensus-cloud-e2e-"))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const home = join(dir, "config")
    const runtimeDir = join(dir, "run")

    const identity = loadOrCreateIdentity(home, { uid: 1000, allowRoot: true })
    expect(identity.ok).toBe(true)
    if (!identity.ok) return
    expect(writePolicy(home, { ...defaultPolicy(), scopes: ["view"] }, { uid: 1000, allowRoot: true }).ok).toBe(true)

    const nonce = "nonce-cloud-e2e"
    const instanceId = "inst_cloud_e2e"
    const profileUpdatedAt = 1_794_327_000_000
    let hello: Record<string, unknown> | null = null
    const rpcById = new Map<string, Record<string, unknown>>()
    let signatureOk = false

    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url)
        if (url.pathname === "/api/connector/whoami") {
          return Response.json({ ok: true, instanceId, state: "active", scopes: ["view"] })
        }
        if (url.pathname === "/api/connector/config") {
          return Response.json({
            version: 1,
            profile: {
              id: "cfg_e2e",
              name: "EU production",
              updatedAt: profileUpdatedAt,
              scopes: ["view", "chat"],
              deniedFeatures: ["memory.read"],
              chatApproval: "confirm",
              conductorApprovals: "off",
              maxStreams: 2,
            },
            serverTime: Date.now(),
          })
        }
        if (url.pathname === "/api/connector" && srv.upgrade(req)) return
        return new Response("not found", { status: 404 })
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ t: "challenge", nonce, exp: Date.now() + 10_000 }))
        },
        message(ws, raw) {
          let frame: Record<string, unknown>
          try {
            frame = JSON.parse(String(raw)) as Record<string, unknown>
          } catch {
            return
          }
          if (frame["t"] === "auth") {
            signatureOk = verifyChallenge(identity.identity.publicKey, nonce, instanceId, String(frame["signature"]))
            if (!signatureOk) {
              ws.close(4401, "bad signature")
              return
            }
            ws.send(JSON.stringify({ t: "auth.ok" }))
            return
          }
          if (frame["t"] === "hello") {
            hello = frame
            ws.send(
              JSON.stringify({
                t: "hello.ok",
                connectionId: "conn_e2e",
                heartbeatMs: 15_000,
                maxFrameBytes: 4 * 1024 * 1024,
                maxStreams: 8,
                serverTime: Date.now(),
                scopes: ["view"],
              }),
            )
            setTimeout(() => {
              ws.send(JSON.stringify({ t: "rpc", id: "r1", op: "daemon.info" }))
              ws.send(JSON.stringify({ t: "rpc", id: "r2", op: "transcript.list", params: {} }))
              ws.send(JSON.stringify({ t: "rpc", id: "r3", op: "memory.list" }))
            }, 30)
            return
          }
          if (frame["t"] === "rpc.res" && typeof frame["id"] === "string") rpcById.set(frame["id"], frame)
          if (frame["t"] === "rpc.err" && typeof frame["id"] === "string") rpcById.set(frame["id"], frame)
        },
      },
    })
    cleanup.push(() => server.stop(true))

    const cloud = `http://127.0.0.1:${server.port}`
    const conn = writeCloudConnection(
      home,
      {
        version: 1,
        cloud,
        instanceId,
        deviceToken: "device-token",
        fingerprint: identity.identity.fingerprint,
        name: null,
        pairedAt: Date.now(),
        scopes: ["view"],
        clientKind: "sensus-daemon",
        clientVersion: "9.9.9",
        unixUser: "tester",
        uid: 1000,
        runsAsRoot: false,
        enabled: true,
      },
      { uid: 1000, allowRoot: true },
    )
    expect(conn.ok).toBe(true)

    const cfg = defaultConfig()
    cfg.endpoints["main"] = { ...cfg.endpoints["main"]!, provider: "mock", apiKey: "", maxTokens: 64 }
    cfg.model = "main@mock-model"
    cfg.titles.enabled = false

    // A real transcript in the daemon's data dir: the cloud-facing list must
    // see it and must NOT carry the absolute path.
    const dataDir = join(dir, "data")
    const transcript = sessionFilePath(dataDir, "instE2E", 1, 0)
    mkdirSync(dirname(transcript), { recursive: true })
    writeFileSync(transcript, `${JSON.stringify({ ts: 1, type: "user_message", content: "e2e hello" })}\n`, "utf8")

    const daemon = await startDaemon({
      runtimeDir,
      home,
      dataDir,
      initialConfig: cfg,
      persistent: true,
      startCloud: true,
    })
    expect(daemon.ok).toBe(true)
    if (!daemon.ok) return
    cleanup.push(() => daemon.stop("test"))

    const gotHello = await waitFor(() => hello)
    expect(gotHello["protocol"]).toBe("sensus-cloud/1")
    expect(gotHello["client"]).toMatchObject({ kind: "sensus-daemon", version: SENSUS_VERSION })
    expect(gotHello["host"]).toMatchObject({ unixUser: "tester", uid: 1000, runsAsRoot: false })
    const features = gotHello["features"] as string[]
    expect(features).toContain("transcript.read")
    expect(features).toContain("memory.read")
    expect(features).toContain("memory.write")
    expect(features).toContain("chat.images")
    expect(features).not.toContain("transcript.delete")

    const pulled = await waitFor(() => (daemon.cloud.status().profile !== null ? daemon.cloud.status() : null))
    expect(pulled.profile).toMatchObject({
      id: "cfg_e2e",
      name: "EU production",
      updatedAt: profileUpdatedAt,
      // The host policy grants view only: the cloud profile cannot widen it.
      scopes: ["view"],
      deniedFeatures: ["memory.read"],
      chatApproval: "confirm",
      conductorApprovals: "off",
      maxStreams: 2,
    })

    const gotRpc = await waitFor(() => rpcById.get("r1") ?? null)
    expect(gotRpc["t"]).toBe("rpc.res")
    const result = gotRpc["result"] as Record<string, unknown>
    expect(result["state"]).toBe("running")

    const list = await waitFor(() => rpcById.get("r2") ?? null)
    expect(list["t"]).toBe("rpc.res")
    const sessions = ((list["result"] as Record<string, unknown>)["sessions"] as Array<Record<string, unknown>>) ?? []
    expect(sessions.map((s) => s["id"])).toEqual(["instE2E/tab-1"])
    expect(JSON.stringify(sessions)).not.toContain(dataDir)
    expect(Object.hasOwn(sessions[0]!, "path")).toBe(false)

    const memory = await waitFor(() => rpcById.get("r3") ?? null)
    expect(memory["t"]).toBe("rpc.res")
    expect(((memory["result"] as Record<string, unknown>)["targets"] as unknown[]).length).toBe(3)
    expect(signatureOk).toBe(true)
  })
})
