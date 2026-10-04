/**
 * Extension seam tests (docs/extensions.md): the built-in event sink
 * (noop/uds), the never-throw policy consultation, and the bounded UDS writer
 * against a real Unix socket. The session-level emit order is covered in
 * tests/unit/agent/chat/chatSession.test.ts and the host `session-start` in
 * tests/unit/agent/chat/chatHost.test.ts.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  consultApprovalPolicy,
  createEventSink,
  NoopEventSink,
  UdsEventSink,
  type ApprovalPolicy,
  type ApprovalPolicyContext,
  type SensusEvent,
} from "../../../src/agent/extensions.ts"

const shellEvent = (n: number): SensusEvent => ({
  type: "command-ran",
  ts: n,
  session: "inst",
  tool: "shell_background",
  command: `echo ${n}`,
  approval: "confirm",
  agent: "copilot",
  cwd: "/tmp",
  shell: "/bin/bash",
  ok: true,
})

function makeCtx(): ApprovalPolicyContext {
  return {
    tool: "shell_background",
    args: { command: "ls" },
    decision: { gate: true },
    mode: "confirm",
    session: "inst",
    agent: "copilot",
    cwd: "/tmp",
    shell: "/bin/bash",
  }
}

describe("extensions: built-in event sink factory", () => {
  test("defaults to noop; an invalid uds config falls back to noop", () => {
    expect(createEventSink({ kind: "noop" })).toBeInstanceOf(NoopEventSink)
    expect(createEventSink({ kind: "uds" })).toBeInstanceOf(NoopEventSink) // no path
    expect(createEventSink({ kind: "uds", path: "" })).toBeInstanceOf(NoopEventSink)
    expect(createEventSink({ kind: "uds", path: "/run/sensus/events.sock" })).toBeInstanceOf(UdsEventSink)
  })

  test("the uds sink delivers newline-delimited JSON in order; a missing socket drops silently and stays bounded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sensus-ext-uds-"))
    const sock = join(dir, "events.sock")
    const received: string[] = []
    let buffer = ""
    const server = Bun.listen({
      unix: sock,
      socket: {
        data(_socket, data) {
          buffer += new TextDecoder().decode(data)
          let idx = buffer.indexOf("\n")
          while (idx >= 0) {
            received.push(buffer.slice(0, idx))
            buffer = buffer.slice(idx + 1)
            idx = buffer.indexOf("\n")
          }
        },
      },
    })
    try {
      const sink = new UdsEventSink(sock)
      sink.emit(shellEvent(1))
      sink.emit(shellEvent(2))
      const end = Date.now() + 3000
      while (received.length < 2 && Date.now() < end) await Bun.sleep(10)
      expect(received.map((l) => (JSON.parse(l) as SensusEvent).ts)).toEqual([1, 2])
    } finally {
      server.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }

    // A missing socket is a silent drop: emits never throw and the backlog is
    // bounded (drop oldest), so a stalled/absent receiver cannot grow memory.
    const missing = new UdsEventSink(join(dir, "absent.sock"), { maxQueue: 8 })
    for (let i = 0; i < 50; i++) missing.emit(shellEvent(i))
    expect(missing.pendingCount()).toBeLessThanOrEqual(8)
  })
})

describe("extensions: approval policy consultation", () => {
  test("a valid verdict passes through; null/malformed/throwing policies defer to the built-in decision", () => {
    expect(consultApprovalPolicy({ decide: () => ({ action: "deny", reason: "no" }) }, makeCtx())).toEqual({
      action: "deny",
      reason: "no",
    })
    expect(consultApprovalPolicy({ decide: () => ({ action: "allow" }) }, makeCtx())).toEqual({ action: "allow" })
    expect(consultApprovalPolicy({ decide: () => null }, makeCtx())).toBeNull()
    const malformed = { decide: () => ({ action: "wat" }) } as unknown as ApprovalPolicy
    expect(consultApprovalPolicy(malformed, makeCtx())).toBeNull()
    const throwing: ApprovalPolicy = {
      decide: () => {
        throw new Error("boom")
      },
    }
    expect(consultApprovalPolicy(throwing, makeCtx())).toBeNull()
  })
})
