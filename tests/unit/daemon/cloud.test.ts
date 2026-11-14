/**
 * Embedded cloud client (docs/cloud.md): the daemon REST status/reload, the
 * unpaired = no egress invariant, and the tunnel's terminal 401 handling.
 */

import { describe, expect, test } from "bun:test"
import { NoopEventSink, MemoryStore } from "../../../src/engine/index.ts"
import { createDaemonApp, type DaemonInfo } from "../../../src/daemon/index.ts"
import {
  CLOUD_CHAT_IMAGE_MAX_BYTES,
  CLOUD_CHAT_IMAGE_MAX_COUNT,
  RelayBroker,
} from "../../../src/daemon/cloud/broker.ts"
import type { ConnectorToCloud } from "../../../src/daemon/cloud/protocol.ts"
import type { DaemonFrame, LocalDaemonLike } from "../../../src/daemon/cloud/daemonClient.ts"
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
  profile: null,
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
          profile: null,
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

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64")

/** A local daemon stand-in that records requests and replays chat events. */
class FakeLocalDaemon implements LocalDaemonLike {
  readonly clientId = "local_1"
  readonly connected = true
  readonly sent: string[] = []
  readonly requests: Array<{ op: string; params: Record<string, unknown> | undefined; timeoutMs: number | undefined }> = []
  private frameHandler: ((raw: string, frame: DaemonFrame) => void) | null = null

  async connect(): Promise<{ clientId: string; protocol: string; version: string }> {
    return { clientId: this.clientId, protocol: "v1", version: "9.9.9" }
  }

  async request(op: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    this.requests.push({ op, params, timeoutMs })
    if (op === "terminal.open") return { shellId: "shell_1" }
    if (op === "chat.attach" || op === "chat.open") return { chatId: "chat_1", state: { messages: [] } }
    if (op === "chat.send") return { accepted: true, mode: "sent" }
    return {}
  }

  sendRaw(raw: string): void {
    this.sent.push(raw)
  }

  onFrame(handler: (raw: string, frame: DaemonFrame) => void): () => void {
    this.frameHandler = handler
    return () => {
      this.frameHandler = null
    }
  }

  onEvent(): () => void {
    return () => {}
  }

  onClose(): () => void {
    return () => {}
  }

  close(): void {}

  emit(frame: DaemonFrame): void {
    this.frameHandler?.(JSON.stringify(frame), frame)
  }
}

async function chatImageHarness(): Promise<{ broker: RelayBroker; client: FakeLocalDaemon; emitted: ConnectorToCloud[] }> {
  const client = new FakeLocalDaemon()
  const emitted: ConnectorToCloud[] = []
  const broker = new RelayBroker({
    policy: { ...defaultPolicy(), scopes: ["view", "chat"] },
    discover: async () => ({ ok: false, code: "daemon_socket_missing", message: "not running", state: "stopped" }),
    dataDir: "/nonexistent-cloud-images",
    clientFactory: () => client,
  })
  const opened = await broker.openStream("stream-1", "chat", { chatId: "chat_1" }, (frame) => emitted.push(frame))
  expect(opened.ok).toBe(true)
  return { broker, client, emitted }
}

function runHarness(): { broker: RelayBroker; client: FakeLocalDaemon } {
  const client = new FakeLocalDaemon()
  const broker = new RelayBroker({
    policy: { ...defaultPolicy(), scopes: ["view", "orchestrator"] },
    discover: async () => ({ ok: false, code: "daemon_socket_missing", message: "not running", state: "stopped" }),
    dataDir: "/nonexistent-cloud-runs",
    clientFactory: () => client,
  })
  return { broker, client }
}

function sendImages(broker: RelayBroker, images: unknown, text = "look"): ReturnType<RelayBroker["streamSend"]> {
  return broker.streamSend(
    "stream-1",
    JSON.stringify({ type: "req", id: "r1", op: "chat.send", chatId: "chat_1", text, images }),
  )
}

function forwarded(broker: RelayBroker, client: FakeLocalDaemon): Record<string, unknown> {
  const sent = client.sent.at(-1)
  expect(sent).toBeDefined()
  return JSON.parse(sent!) as Record<string, unknown>
}

describe("cloud chat images", () => {
  test("validates and forwards png/jpeg images to the local daemon", async () => {
    const { broker, client } = await chatImageHarness()
    const images = [
      { name: "a.png", mediaType: "image/png", data: base64(PNG) },
      { name: "b.jpg", mediaType: "image/jpeg", data: base64(JPEG) },
    ]
    expect(sendImages(broker, images)).toEqual({ ok: true })
    const frame = forwarded(broker, client)
    expect(frame).toMatchObject({ type: "req", id: "r1", op: "chat.send", chatId: "chat_1", text: "look" })
    expect(frame["images"]).toEqual(images)
  })

  test("omits an empty images array and still accepts a text-only send", async () => {
    const { broker, client } = await chatImageHarness()
    expect(sendImages(broker, [])).toEqual({ ok: true })
    expect(Object.hasOwn(forwarded(broker, client), "images")).toBe(false)
  })

  test("rejects malformed, oversized, and mismatched images without forwarding", async () => {
    const { broker, client } = await chatImageHarness()
    const png = base64(PNG)
    const tooMany = Array.from({ length: CLOUD_CHAT_IMAGE_MAX_COUNT + 1 }, (_, i) => ({
      name: `${i}.png`,
      mediaType: "image/png",
      data: png,
    }))
    const oversized = Buffer.alloc(CLOUD_CHAT_IMAGE_MAX_BYTES + 1)
    oversized.set(PNG)
    const cases: unknown[] = [
      "not-an-array",
      tooMany,
      [{ name: "", mediaType: "image/png", data: png }],
      [{ name: "a.png", mediaType: "image/svg+xml", data: png }],
      [{ name: "a.png", mediaType: "image/png", data: "not base64" }],
      [{ name: "a.png", mediaType: "image/png", data: "AAAA" }],
      [{ name: "a.png", mediaType: "image/png", data: base64(JPEG) }],
      [{ name: "big.png", mediaType: "image/png", data: Buffer.from(oversized).toString("base64") }],
    ]
    for (const images of cases) {
      expect(sendImages(broker, images)).toMatchObject({ ok: false, code: "invalid_request" })
    }
    expect(client.sent).toHaveLength(0)
  })

  test("strips host paths from chat.message and chat.state image records", async () => {
    const { client, emitted } = await chatImageHarness()
    const images = [
      {
        id: "abc123",
        name: "shot.png",
        mediaType: "image/png",
        bytes: 8,
        path: "/home/tester/.config/sensus/assets/abc123.png",
        width: 640,
        height: 480,
        private: "drop-me",
      },
    ]
    client.emit({
      type: "evt",
      event: "chat.message",
      chatId: "chat_1",
      message: { id: 1, role: "user", content: "hi", ts: 1, images },
    })
    client.emit({
      type: "evt",
      event: "chat.state",
      chatId: "chat_1",
      state: { messages: [{ id: 1, role: "user", content: "hi", ts: 1, images }], status: "idle" },
    })
    // A non-image path (tool args) must survive: only image records are bounded.
    client.emit({
      type: "evt",
      event: "chat.message",
      chatId: "chat_1",
      message: { id: 2, role: "tool", content: "", ts: 2, tool: { name: "read_file", args: { path: "/tmp/notes.md" } } },
    })
    const frames = emitted.filter((frame) => frame.t === "stream.frame") as Array<Extract<ConnectorToCloud, { t: "stream.frame" }>>
    const payloads = frames.map((frame) => JSON.parse(frame.data) as Record<string, unknown>)
    const message = payloads[0]?.["message"] as Record<string, unknown>
    expect(message["images"]).toEqual([{ id: "abc123", name: "shot.png", mediaType: "image/png", bytes: 8, width: 640, height: 480 }])
    const state = payloads[1]?.["state"] as { messages: Array<Record<string, unknown>> }
    expect(state.messages[0]?.["images"]).toEqual([{ id: "abc123", name: "shot.png", mediaType: "image/png", bytes: 8, width: 640, height: 480 }])
    const tool = payloads[2]?.["message"] as { tool: { args: { path: string } } }
    expect(tool.tool.args.path).toBe("/tmp/notes.md")
    expect(JSON.stringify(payloads)).not.toContain("/home/tester")
  })
})

describe("cloud run approval", () => {
  test("applies full-auto and confirm with the host slash command before the prompt", async () => {
    const fullAuto = runHarness()
    const opened = await fullAuto.broker.openStream(
      "run-1",
      "run",
      { prompt: "do the work", approval: "full-auto" },
      () => {},
    )
    expect(opened.ok).toBe(true)
    const fullAutoSends = fullAuto.client.requests.filter((entry) => entry.op === "chat.send")
    expect(fullAutoSends.map((entry) => entry.params?.["text"])).toEqual(["/yolo", "do the work"])
    expect(fullAutoSends.map((entry) => entry.params?.["chatId"])).toEqual(["chat_1", "chat_1"])
    await fullAuto.broker.closeStream("run-1", "test_done")

    const confirm = runHarness()
    const openedConfirm = await confirm.broker.openStream(
      "run-2",
      "run",
      { prompt: "review only", approval: "confirm" },
      () => {},
    )
    expect(openedConfirm.ok).toBe(true)
    const confirmSends = confirm.client.requests.filter((entry) => entry.op === "chat.send")
    expect(confirmSends.map((entry) => entry.params?.["text"])).toEqual(["/yolo off", "review only"])
    await confirm.broker.closeStream("run-2", "test_done")
  })

  test("leaves the host default alone when approval is absent", async () => {
    const { broker, client } = runHarness()
    const opened = await broker.openStream("run-3", "run", { prompt: "no override" }, () => {})
    expect(opened.ok).toBe(true)
    const sends = client.requests.filter((entry) => entry.op === "chat.send")
    expect(sends.map((entry) => entry.params?.["text"])).toEqual(["no override"])
    await broker.closeStream("run-3", "test_done")
  })

  test("rejects an unknown approval value before opening a shell or chat", async () => {
    const { broker, client } = runHarness()
    const opened = await broker.openStream("run-4", "run", { prompt: "x", approval: "inherit" }, () => {})
    expect(opened).toMatchObject({ ok: false, code: "invalid_request" })
    expect(client.requests).toHaveLength(0)
  })
})
