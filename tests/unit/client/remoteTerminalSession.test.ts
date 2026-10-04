/**
 * RemoteTerminalSession — the client VT fed by the daemon's WS terminal channel
 * (P4c; D1/D2/D11/D12). Drives a REAL daemon with an injected fake renderable
 * (no native renderer in unit tests): attach/replay, live output through the SGR
 * rewriter, input round-trip, resize, facts publishing, scanner ring, and death.
 */

import { describe, expect, test } from "bun:test"
import type { EmbeddedTerminalRenderable } from "@opentui/core"
import { RemoteTerminalSession } from "../../../src/client/remoteTerminalSession.ts"
import { WsClient } from "../../../src/client/wsClient.ts"
import { startTestDaemon, waitUntil } from "./support.ts"

/** A renderable stand-in: records written bytes and returns a configurable grid. */
class FakeRenderable {
  width: number
  height: number
  onData: ((data: Uint8Array) => void) | undefined = undefined
  onTerminalResize: ((cols: number, rows: number) => void) | undefined = undefined
  readonly chunks: Uint8Array[] = []
  lines: string[] = []
  cursor = { x: 0, y: 0, visible: false }
  /** When set, the next `write` throws (an apply failure). */
  failNextWrite = false

  constructor(cols: number, rows: number) {
    this.width = cols
    this.height = rows
  }

  write(data: string | Uint8Array): void {
    if (this.failNextWrite) {
      this.failNextWrite = false
      throw new Error("renderable write failed")
    }
    this.chunks.push(typeof data === "string" ? new TextEncoder().encode(data) : data)
  }
  screen(): { text: string; lines: string[]; columns: number; rows: number; cursor: { x: number; y: number; visible: boolean } } {
    return { text: this.lines.join("\n"), lines: this.lines, columns: this.width, rows: this.height, cursor: this.cursor }
  }
  focus(): void {}
  blur(): void {}
  handlePaste(): void {}
  invalidate(): void {}
  text(): string {
    return Buffer.concat(this.chunks.map((c) => Buffer.from(c))).toString("utf8")
  }
}

function wsFor(daemon: { runtime: string; token: string; result: { tcp: { port: number } } }): WsClient {
  return new WsClient({
    runtimeDir: daemon.runtime,
    token: daemon.token,
    port: daemon.result.tcp.port,
    reconnect: false,
    requestTimeoutMs: 8000,
  })
}

describe("RemoteTerminalSession", () => {
  test("attach → echo → facts → resize → kill against a real daemon", async () => {
    const daemon = await startTestDaemon()
    const client = wsFor(daemon)
    try {
      await client.waitForHello(8000)

      // Count facts publishes without changing transport behavior.
      const factsCalls: Array<{ lines: string[]; cursor: { x: number; y: number; visible: boolean } }> = []
      const originalFacts = client.terminal.facts.bind(client.terminal)
      client.terminal.facts = (params) => {
        factsCalls.push({ lines: params.lines, cursor: params.cursor })
        return originalFacts(params)
      }

      const opened = await client.terminal.open({ cols: 80, rows: 24 })
      const shellId = opened.shellId
      const fake = new FakeRenderable(80, 24)
      fake.lines = ["prompt> "]
      fake.cursor = { x: 8, y: 0, visible: true }
      const errors: string[] = []
      const session = RemoteTerminalSession.create({
        ws: client,
        shellId,
        cols: 80,
        rows: 24,
        createRenderable: () => fake as unknown as EmbeddedTerminalRenderable,
        factsDebounceMs: 20,
        onError: (m) => errors.push(m),
      })

      try {
        await waitUntil(() => (session.attached ? true : null), 8000)
        expect(session.status().cols).toBe(80)

        // Input round-trip: the shell echoes, the bytes reach the fake renderable.
        await session.sendText("echo REMOTE_MARKER_7\n")
        await waitUntil(() => (fake.text().includes("REMOTE_MARKER_7") ? true : null), 8000)
        expect(session.recentLines(50).join("\n")).toContain("REMOTE_MARKER_7")

        // D2: the local grid is published as terminal.facts (debounced).
        await waitUntil(() => (factsCalls.length > 0 ? true : null), 8000)
        expect(factsCalls[0]?.lines).toContain("prompt> ")
        expect(factsCalls[0]?.cursor.x).toBe(8)

        session.resize(100, 30)
        expect(session.status().cols).toBe(100)
        await waitUntil(() => (session.status().alternateOn === false ? true : null), 2000)

        // Death: kill → the daemon emits terminal.exit → onExit fires.
        const exit = new Promise<number | null>((resolve) => session.onExit(resolve))
        session.kill()
        await exit
        expect(session.status().dead).toBe(true)
        expect(errors).toEqual([])
      } finally {
        session.dispose()
      }
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)

  test("a reconnect resumes from the applied cursor without replaying (D12)", async () => {
    const daemon = await startTestDaemon()
    const client = wsFor(daemon)
    try {
      await client.waitForHello(8000)
      const opened = await client.terminal.open({ cols: 60, rows: 20 })
      const shellId = opened.shellId

      const fake = new FakeRenderable(60, 20)
      const session = RemoteTerminalSession.create({
        ws: client,
        shellId,
        cols: 60,
        rows: 20,
        createRenderable: () => fake as unknown as EmbeddedTerminalRenderable,
        factsDebounceMs: 50,
      })
      try {
        await waitUntil(() => (session.attached ? true : null), 8000)
        // Produce output through the attached (controller) session.
        await session.sendText("echo REPLAY_MARKER_9\n")
        await waitUntil(() => (fake.text().includes("REPLAY_MARKER_9") ? true : null), 8000)

        // A re-attach with no missed output replays nothing: the cursor is the
        // daemon's end, so the applied bytes are already complete.
        const chunksBefore = fake.chunks.length
        const cursorBefore = session.outputCursor
        await session.reattach()
        await Bun.sleep(50)
        expect(fake.chunks.length).toBe(chunksBefore)
        expect(session.outputCursor).toBe(cursorBefore)

        // Output after the resume arrives exactly once (no duplicated replay).
        // The shell echoes the typed command, so use expansion to make the
        // output marker distinct from the echoed input.
        await session.sendText("echo RESUME_$((10+1))_MARK\n")
        await waitUntil(() => (fake.text().includes("RESUME_11_MARK") ? true : null), 8000)
        const tail = Buffer.concat(fake.chunks.slice(chunksBefore).map((c) => Buffer.from(c))).toString("utf8")
        expect(tail.match(/RESUME_11_MARK/g)?.length).toBe(1)
      } finally {
        session.dispose()
        await client.terminal.kill({ shellId }).catch(() => {})
      }
    } finally {
      client.close()
      daemon.cleanup()
    }
  }, 30000)

  test("frame cursors make reattach idempotent and heal a dropped frame (D12)", async () => {
    // A controllable transport: no real daemon, exact event ordering.
    interface Listener {
      (payload: Record<string, unknown>): void
    }
    const handlers = new Map<string, Set<Listener>>()
    const attachCalls: Array<{ shellId: string; cols: number; rows: number; cursor?: number }> = []
    const transport = {
      on(event: string, handler: Listener) {
        let set = handlers.get(event)
        if (set === undefined) {
          set = new Set()
          handlers.set(event, set)
        }
        set.add(handler)
        return () => set.delete(handler)
      },
      terminal: {
        attach(params: { shellId: string; cols: number; rows: number; cursor?: number }) {
          attachCalls.push(params)
          return Promise.resolve({ shellId: params.shellId, role: "controller" })
        },
        input: () => Promise.resolve({}),
        resize: () => Promise.resolve({}),
        facts: () => Promise.resolve({}),
      },
    }
    const emit = (event: string, payload: Record<string, unknown>): void => {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(payload)
    }
    const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64")
    const status = {
      dead: false,
      deadStatus: null,
      cols: 60,
      rows: 20,
      cwd: null,
      currentCommand: "",
      alternateOn: false,
      cursorX: null,
      cursorY: null,
      cursorVisible: false,
    }
    const attached = (replay: string, replayFrom: number, cursor: number, resetAlt = false, truncated = false) =>
      emit("terminal.attached", {
        shellId: "s1",
        role: "controller",
        replay: b64(replay),
        replayFrom,
        cursor,
        truncated,
        resetAlt,
        cols: 60,
        rows: 20,
        status,
      })

    const fake = new FakeRenderable(60, 20)
    const session = RemoteTerminalSession.create({
      ws: transport as unknown as WsClient,
      shellId: "s1",
      cols: 60,
      rows: 20,
      createRenderable: () => fake as unknown as EmbeddedTerminalRenderable,
      factsDebounceMs: 10,
    })
    try {
      expect(attachCalls).toEqual([{ shellId: "s1", cols: 60, rows: 20 }])
      attached("abc", 0, 3)
      expect(fake.text()).toBe("abc")
      expect(session.outputCursor).toBe(3)

      // A dropped frame (start 5 > applied 3): do not apply; resync from 3.
      emit("terminal.output", { shellId: "s1", data: b64("fgh"), cursor: 8 })
      expect(fake.text()).toBe("abc")
      await Bun.sleep(120)
      expect(attachCalls[1]).toEqual({ shellId: "s1", cols: 60, rows: 20, cursor: 3 })

      // The replay covers the gap; then the missed frame is applied in full.
      attached("defgh", 3, 8)
      expect(fake.text()).toBe("abcdefgh")
      expect(session.outputCursor).toBe(8)

      // A duplicate frame is ignored; a stale partial replay is skipped.
      emit("terminal.output", { shellId: "s1", data: b64("abc"), cursor: 3 })
      attached("defgh", 3, 8)
      expect(fake.text()).toBe("abcdefgh")

      // A live frame past the cursor still applies.
      emit("terminal.output", { shellId: "s1", data: b64("i"), cursor: 9 })
      expect(fake.text()).toBe("abcdefghi")
      expect(session.outputCursor).toBe(9)

      // A truncated replay resets and is written whole (no prefix skip).
      attached("xyz", 9, 12, true, true)
      expect(fake.text().endsWith("xyz")).toBe(true)
      expect(session.outputCursor).toBe(12)

      // A partially overlapping frame applies only its suffix: [10,14) overlaps
      // the applied [0,12); only "jk" is new.
      emit("terminal.output", { shellId: "s1", data: b64("yzjk"), cursor: 14 })
      expect(fake.text().endsWith("xyzjk")).toBe(true)
      expect(session.outputCursor).toBe(14)

      // A renderable failure invalidates the cursor: it does not advance, and
      // the next attach asks for a full replay, which still skips the applied
      // prefix (everything before `appliedCursor` is known-good).
      fake.failNextWrite = true
      emit("terminal.output", { shellId: "s1", data: b64("l"), cursor: 15 })
      expect(session.outputCursor).toBe(14)
      const beforeReattach = attachCalls.length
      await session.reattach()
      expect(attachCalls[beforeReattach]).toEqual({ shellId: "s1", cols: 60, rows: 20 })
      attached("abcdefghixyzjkl", 0, 15)
      expect(fake.text().endsWith("xyzjkl")).toBe(true)
      expect(session.outputCursor).toBe(15)
    } finally {
      session.dispose()
    }
  })
})
