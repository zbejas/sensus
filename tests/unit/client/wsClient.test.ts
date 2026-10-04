/**
 * wsClient — the daemon WebSocket transport (P4b; docs/daemon-api.md).
 *
 * Drives a real daemon: request/response correlation, typed event delivery,
 * the base64 byte helpers, the bounded drop-oldest queue, and reconnect after
 * the daemon is replaced on the same runtime dir/port. No UI, no mocks — the
 * same real loopback channel the daemon tests use.
 */

import { describe, expect, test } from "bun:test"
import { startDaemon } from "../../../src/daemon/index.ts"
import {
  BoundedQueue,
  WsClient,
  base64ToBytes,
  base64ToText,
  bytesToBase64,
  textToBase64,
  type DaemonEventMap,
  type DaemonEventName,
} from "../../../src/client/wsClient.ts"
import { startTestDaemon, waitUntil, type TestDaemon } from "./support.ts"

/** Resolve the next matching event, or reject after a timeout. */
function once<K extends DaemonEventName>(
  client: WsClient,
  event: K,
  pred?: (payload: DaemonEventMap[K]) => boolean,
  timeoutMs = 8000,
): Promise<DaemonEventMap[K]> {
  return new Promise<DaemonEventMap[K]>((resolve, reject) => {
    let unsubscribe: (() => void) | null = null
    const timer = setTimeout(() => {
      unsubscribe?.()
      reject(new Error(`timed out waiting for ${event}`))
    }, timeoutMs)
    unsubscribe = client.on(event, (payload) => {
      if (pred !== undefined && !pred(payload)) return
      clearTimeout(timer)
      unsubscribe?.()
      resolve(payload)
    })
  })
}

describe("wsClient: base64 helpers", () => {
  test("round-trip bytes and text", () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255])
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes))
    expect(base64ToText(textToBase64("hello — ünïcode\n"))).toBe("hello — ünïcode\n")
    expect(bytesToBase64(new Uint8Array())).toBe("")
    expect(base64ToBytes("").length).toBe(0)
  })
})

describe("wsClient: bounded queue", () => {
  test("drops oldest beyond the cap but always keeps the newest", () => {
    const q = new BoundedQueue<string>(10, (s) => s.length)
    expect(q.push("aaaa")).toBeNull()
    expect(q.push("bbbb")).toBeNull()
    expect(q.push("cccc")).toBe("aaaa") // 12 > 10 → drops (and returns) the oldest
    expect(q.length).toBe(2)
    expect(q.shift()).toBe("bbbb")
    expect(q.shift()).toBe("cccc")
    expect(q.shift()).toBeUndefined()
    // A single oversized item is kept (the newest must survive).
    const tiny = new BoundedQueue<string>(2, (s) => s.length)
    expect(tiny.push("oversized")).toBeNull()
    expect(tiny.shift()).toBe("oversized")
  })
})

describe("wsClient: real daemon", () => {
  test("handshake, request/response correlation, events, and byte round-trip", async () => {
    const daemon = await startTestDaemon()
    const client = new WsClient({
      runtimeDir: daemon.runtime,
      token: daemon.token,
      port: daemon.result.tcp.port,
      reconnect: false,
      requestTimeoutMs: 8000,
    })
    try {
      const hello = await client.waitForHello(8000)
      expect(hello.protocol).toBe("sensus-ws/1")
      expect(client.clientId).toBe(hello.clientId)
      expect(client.state).toBe("open")

      // Request/response: an op result is correlated to its own request id.
      const [listed, chats] = await Promise.all([client.terminal.list(), client.chat.list()])
      expect(listed.shells).toEqual([])
      expect(chats.chats).toEqual([])

      // A daemon error is a typed rejection, not a thrown frame.
      await expect(client.request("terminal.kill", { shellId: "missing" })).rejects.toMatchObject({
        code: "shell_not_found",
      })

      const opened = await client.terminal.open({ cols: 80, rows: 24 })
      const shellId = opened.shellId
      expect(shellId.length).toBeGreaterThan(0)

      // `terminal.attached` is delivered before the response, and its replay is
      // base64 (decode round-trip).
      const attachedPromise = once(client, "terminal.attached", (e) => e.shellId === shellId)
      const attachedRes = await client.terminal.attach({ shellId, cols: 80, rows: 24 })
      const attached = await attachedPromise
      expect(attachedRes.role).toBe("controller")
      expect(attached.role).toBe("controller")
      expect(base64ToText(attached.replay)).toBe("")
      expect(attached.status.cols).toBe(80)

      // A typed event carries the shell output; bytes decode back to the text
      // the shell echoed.
      const outputPromise = once(
        client,
        "terminal.output",
        (e) => e.shellId === shellId && base64ToText(e.data).includes("WS_MARKER_42"),
      )
      await client.terminal.input({ shellId, data: "echo WS_MARKER_42\n" })
      const output = await outputPromise
      expect(base64ToText(output.data)).toContain("WS_MARKER_42")

      // Resize is accepted (controller) and the shell can be killed.
      await client.terminal.resize({ shellId, cols: 100, rows: 30 })
      const exitPromise = once(client, "terminal.exit", (e) => e.shellId === shellId)
      await client.terminal.kill({ shellId })
      await exitPromise
      expect((await client.terminal.list()).shells).toEqual([])
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)

  test("reconnects after the daemon is replaced on the same port", async () => {
    const daemon1 = await startTestDaemon()
    const port = daemon1.result.tcp.port
    let daemon2: TestDaemon | null = null
    let reconnected = 0
    const client = new WsClient({
      runtimeDir: daemon1.runtime,
      token: daemon1.token,
      port,
      reconnect: true,
      reconnectBaseMs: 40,
      reconnectMaxMs: 200,
      onReconnect: () => {
        reconnected += 1
      },
    })
    try {
      const firstHello = await client.waitForHello(8000)

      daemon1.result.stop()
      // A replacement daemon on the same runtime dir + port (same token).
      const home2 = daemon1.home
      const result2 = await startDaemon({
        runtimeDir: daemon1.runtime,
        token: daemon1.token,
        home: home2,
        shell: "/bin/sh",
        config: () => ({}),
        graceMs: 60_000,
        port,
      })
      if (!result2.ok) throw new Error(result2.error)
      daemon2 = {
        runtime: daemon1.runtime,
        home: home2,
        token: daemon1.token,
        result: result2,
        cleanup: () => {
          try {
            result2.stop()
          } catch {
            // idempotent
          }
        },
      }

      await waitUntil(() => (reconnected > 0 ? true : null), 8000)
      // The replacement daemon issues a fresh client id and still serves ops.
      await waitUntil(() => (client.clientId !== firstHello.clientId ? true : null), 8000)
      expect(client.state).toBe("open")
      expect((await client.terminal.list()).shells).toEqual([])
    } finally {
      client.close()
      daemon2?.cleanup()
      daemon1.cleanup()
    }
  }, 30000)

  test("a throwing subscriber is contained and reported, not propagated", async () => {
    const errors: string[] = []
    const daemon = await startTestDaemon()
    const client = new WsClient({
      runtimeDir: daemon.runtime,
      token: daemon.token,
      port: daemon.result.tcp.port,
      reconnect: false,
      requestTimeoutMs: 8000,
      onError: (message) => errors.push(message),
    })
    try {
      await client.waitForHello(8000)
      const opened = await client.terminal.open({ cols: 60, rows: 20 })
      const shellId = opened.shellId
      const attached = once(client, "terminal.attached", (e) => e.shellId === shellId)
      await client.terminal.attach({ shellId })
      await attached

      // A throwing subscriber must not stop the other handlers for the event.
      const good = once(
        client,
        "terminal.output",
        (e) => e.shellId === shellId && base64ToText(e.data).includes("BOOM_OK"),
        8000,
      )
      client.on("terminal.output", () => {
        throw new Error("subscriber boom")
      })
      await client.terminal.input({ shellId, data: "echo BOOM_OK\n" })
      await good
      const reported = await waitUntil(() => (errors.some((e) => e.includes("subscriber boom")) ? true : null), 8000)
      expect(reported).toBe(true)
      await client.terminal.kill({ shellId })
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)
})

describe("wsClient: stale frames", () => {
  /** A controllable WebSocket stand-in (the `WebSocketImpl` test seam). */
  class FakeSocket extends EventTarget {
    static readonly OPEN = 1
    static readonly CLOSED = 3
    readyState = 0
    bufferedAmount = 0
    readonly url: string
    constructor(url: string, _opts?: unknown) {
      super()
      this.url = url
    }
    send(_frame: string): void {}
    close(): void {
      this.readyState = FakeSocket.CLOSED
    }
    open(): void {
      this.readyState = FakeSocket.OPEN
      this.dispatchEvent(new Event("open"))
    }
    message(frame: string): void {
      this.dispatchEvent(new MessageEvent("message", { data: frame }))
    }
    drop(): void {
      this.readyState = FakeSocket.CLOSED
      this.dispatchEvent(new Event("close"))
    }
  }

  test("frames queued from a closed socket are not drained after reconnect", async () => {
    const sockets: FakeSocket[] = []
    const client = new WsClient({
      url: "ws://fake/v1/ws",
      token: "t",
      reconnect: true,
      reconnectBaseMs: 5,
      reconnectMaxMs: 10,
      WebSocketImpl: (class extends FakeSocket {
        constructor(url: string, opts?: unknown) {
          super(url, opts)
          sockets.push(this)
        }
      }) as unknown as typeof WebSocket,
    })
    try {
      const events: string[] = []
      client.on("hello", () => events.push("hello"))
      client.on("terminal.output", () => events.push("out"))

      const first = sockets[0]
      if (first === undefined) throw new Error("expected a socket")
      first.open()
      first.message(JSON.stringify({ type: "evt", event: "hello", clientId: "c1", protocol: "sensus-ws/1" }))
      // A frame from the dead socket sits in the inbound queue when the socket
      // closes in the same tick; it must never be applied after the reconnect.
      first.message(JSON.stringify({ type: "evt", event: "terminal.output", shellId: "s1", data: "", cursor: 1 }))
      first.drop()
      await Promise.resolve()
      await Promise.resolve()
      // Both queued frames belonged to the dead socket and were dropped; the
      // reconnect re-handshakes from scratch.
      expect(events).toEqual([])

      await waitUntil(() => (sockets.length > 1 ? true : null), 2000)
      const second = sockets[1]
      if (second === undefined) throw new Error("expected a reconnected socket")
      second.open()
      second.message(JSON.stringify({ type: "evt", event: "hello", clientId: "c2", protocol: "sensus-ws/1" }))
      second.message(JSON.stringify({ type: "evt", event: "terminal.output", shellId: "s1", data: "", cursor: 2 }))
      await waitUntil(() => (events.includes("out") ? true : null), 2000)
      expect(events).toEqual(["hello", "out"])
    } finally {
      client.close()
    }
  })
})
