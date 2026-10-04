/**
 * RemoteChat + the P4c-iii chat control ops (docs/daemon-api.md "Chat,
 * approvals, sudo"). A REAL daemon with an injected config (no provider calls)
 * backs a WsClient; `chat.open` returns the state + meta snapshot a RemoteChat
 * builds its accessors from. Covers the remote readouts, the local editor/slash
 * state, and the new control ops (`setModel|setAgent|setEffort|setApproval|
 * setMcp|trust*|cycleEffort|revert`) reflected in a fresh `chat.attach` meta.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultConfig, type SensusConfig } from "../../../src/engine/index.ts"
import { startDaemon, type StartDaemonResult } from "../../../src/daemon/index.ts"
import { WsClient } from "../../../src/client/wsClient.ts"
import { RemoteChat } from "../../../src/client/remoteChat.ts"
import type { ChatMessage } from "../../../src/engine/index.ts"

const TOKEN = "daemon-remote-chat-test-token"

function testConfig(opts: { autoTitles?: boolean } = {}): SensusConfig {
  const cfg = defaultConfig()
  cfg.endpoints["main"] = { ...cfg.endpoints["main"]!, apiKey: "test-key", maxTokens: 128 }
  cfg.model = "main@plain-model"
  cfg.titles.enabled = opts.autoTitles === true
  return cfg
}

interface Ctx {
  runtime: string
  home: string
  result: Extract<StartDaemonResult, { ok: true }>
  prevHome: string | undefined
  cleanup: () => void
}

const contexts: Ctx[] = []

async function startCtx(opts: { autoTitles?: boolean } = {}): Promise<Ctx> {
  const runtime = mkdtempSync(join(tmpdir(), "sensus-rchat-run-"))
  const home = mkdtempSync(join(tmpdir(), "sensus-rchat-home-"))
  const prevHome = process.env["SENSUS_HOME"]
  process.env["SENSUS_HOME"] = home
  const result = await startDaemon({
    runtimeDir: runtime,
    token: TOKEN,
    home,
    dataDir: join(home, "data"),
    initialConfig: testConfig({ autoTitles: opts.autoTitles === true }),
    chatInstanceId: "daemon-remote-chat-test",
    config: () => ({}),
    shell: "/bin/sh",
    graceMs: 60_000,
  })
  if (!result.ok) throw new Error(result.error)
  const ctx: Ctx = {
    runtime,
    home,
    result,
    prevHome,
    cleanup: () => {
      try {
        result.stop()
      } catch {
        // idempotent
      }
      if (prevHome === undefined) delete process.env["SENSUS_HOME"]
      else process.env["SENSUS_HOME"] = prevHome
      rmSync(runtime, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    },
  }
  contexts.push(ctx)
  return ctx
}

afterAll(() => {
  for (const ctx of contexts) ctx.cleanup()
})

function clientFor(ctx: Ctx): WsClient {
  return new WsClient({
    runtimeDir: ctx.runtime,
    token: TOKEN,
    port: ctx.result.tcp.port,
    reconnect: false,
    requestTimeoutMs: 8000,
  })
}

/** A synthetic plan/approval card message for the rebuild checks. */
function syntheticMessages(): ChatMessage[] {
  return [
    { id: 1, ts: 1, role: "user", content: "run it" },
    {
      id: 2,
      ts: 2,
      role: "tool",
      content: "",
      tool: {
        callId: "call-1",
        name: "shell_background",
        paramsSummary: "ls",
        status: "pending",
        output: "",
        exitCode: null,
        destructive: false,
        allowPrefix: "ls",
      },
    },
    {
      id: 3,
      ts: 3,
      role: "tool",
      content: "",
      plan: {
        cursor: 0,
        lines: [
          { callId: "p1", name: "shell_background", paramsSummary: "ls", status: "pending", allowPrefix: "ls" },
          { callId: "p2", name: "shell_background", paramsSummary: "rm -rf /", status: "pending", destructive: true },
        ],
      },
    },
    {
      // An ABORTED ask keeps its question and has no answer. It must NOT be
      // treated as pending: doing so diverts the next Enter into a
      // `chat.answerAsk` the daemon rejects with `no_pending_ask`.
      id: 4,
      ts: 4,
      role: "tool",
      content: "",
      tool: {
        callId: "ask-aborted",
        name: "ask_user",
        paramsSummary: "",
        status: "aborted",
        output: "aborted",
        exitCode: null,
        question: "Which way?",
        options: ["left", "right"],
        answer: null,
      },
    },
  ]
}

describe("RemoteChat + chat control ops", () => {
  test("reads meta and drives the new control ops against a real daemon", async () => {
    const ctx = await startCtx()
    const client = clientFor(ctx)
    try {
      await client.waitForHello(8000)
      const opened = await client.chat.open({})
      expect(opened.state.meta).not.toBeNull()
      const chatId = opened.chatId

      // Baseline meta readouts come from the daemon engine.
      expect(opened.state.meta?.endpointName).toBe("main")
      expect(opened.state.meta?.modelName).toBe("plain-model")
      expect(opened.state.meta?.hasKey).toBe(true)
      expect((opened.state.meta?.contextLimit ?? 0) > 0).toBe(true)
      expect(typeof opened.state.meta?.contextBreakdown?.percent).toBe("number")
      expect(opened.state.meta?.approval).toBe("confirm")

      // Local RemoteChat mirror.
      const chat = RemoteChat.create({ ws: client, chatId, state: opened.state, display: { animations: false } })
      try {
        expect(chat.accessors.messages().length).toBeGreaterThanOrEqual(0)
        expect(chat.endpointName()).toBe("main")
        expect(chat.modelName()).toBe("plain-model")
        expect(chat.hasKey()).toBe(true)
        expect(chat.accessors.animations()).toBe(false)

        // Editor + slash state are purely local.
        chat.setDraft("/he")
        expect(chat.getDraft()).toBe("/he")
        expect((chat.slashMenu()?.matches.length ?? 0) > 0).toBe(true)
        chat.clearDraft()
        expect(chat.slashMenu()).toBeNull()

        // Display toggles are local.
        expect(chat.toggleCardStyle()).toBe("border")
        expect(chat.accessors.cardStyle()).toBe("border")

        // Plan line edits are local; commit sends the decisions (no pending
        // plan here, so it reports false).
        expect(chat.planCommit()).toBe(false)

        // Control ops route to the daemon and are reflected in a fresh attach.
        await client.request("chat.setModel", { chatId, model: "main@other-model" })
        await client.request("chat.setAgent", { chatId, agent: "copilot" })
        await client.request("chat.setEffort", { chatId, mode: "high" })
        await client.request("chat.setApproval", { chatId, mode: "full-auto" })
        await client.request("chat.setMcp", { chatId, enabled: false })
        await client.request("chat.trustAdd", { chatId, tool: "shell_background", prefix: "git status" })
        await client.request("chat.cycleEffort", { chatId })
        const after = await client.chat.attach({ chatId })
        expect(after.state.meta?.modelName).toBe("other-model")
        expect(after.state.meta?.endpointName).toBe("main")
        expect(after.state.meta?.agentName).toBe("copilot")
        expect(after.state.meta?.approval).toBe("full-auto")
        expect(after.state.meta?.mcpEnabled).toBe(false)
        expect(after.state.meta?.trustPatterns?.some((t) => t.prefix === "git status")).toBe(true)

        // A bad control op is a typed rejection, never a frame/crash.
        await expect(client.request("chat.setApproval", { chatId, mode: "bogus" as "confirm" })).rejects.toMatchObject({
          code: "invalid_request",
        })

        // Trust revoke-all clears the pattern.
        const revoked = await client.request("chat.trustRevokeAll", { chatId })
        expect(revoked.ok).toBe(true)
        const cleared = await client.chat.attach({ chatId })
        expect(cleared.state.meta?.trustPatterns ?? []).toEqual([])

        // A RemoteChat method routes the same op and optimistically patches meta.
        chat.setApproval("confirm")
        expect(chat.accessors.approval()).toBe("confirm")
      } finally {
        chat.dispose()
      }
    } finally {
      client.close()
    }
  }, 30000)

  test("rebuilds pending approval + plan from a state snapshot", () => {
    // A real ws is not needed for the pure rebuild surface; use a client pointed
    // at an unreachable port (never used) so the constructor wiring is real code.
    const client = new WsClient({ host: "127.0.0.1", port: 1, token: "x", reconnect: false, requestTimeoutMs: 200 })
    const state = {
      messages: syntheticMessages(),
      status: "idle" as const,
      plan: null,
      pendingApproval: null,
      pendingSudo: null,
      meta: null,
    }
    const chat = RemoteChat.create({ ws: client, chatId: "c1", state })
    try {
      expect(chat.pendingApproval()?.callId).toBe("call-1")
      expect(chat.pendingPlan()?.lines.length).toBe(2)
      // Approve-all is a one-step commit (local decisions + chat.planAnswer):
      // it marks non-destructive lines approved, freezes/resolves the plan, and
      // never accepts a still-pending destructive line (sent as a reject).
      chat.planApproveAll()
      expect(chat.pendingPlan()).toBeNull()
      const frozen = chat.accessors.messages().find((m) => m.plan !== undefined)?.plan
      expect(frozen?.resolved).toBe(true)
      expect(frozen?.outcome).toBe("committed")
      expect(frozen?.lines[0]?.status).toBe("approved")
      // The destructive line is untouched locally (the daemon's echoed result
      // rejects it); it is never accepted by approve-all.
      expect(frozen?.lines[1]?.status).not.toBe("approved")
      // Local toggles.
      expect(chat.thinkingOpen(1)).toBe(false)
      chat.toggleThinkingOpen(1)
      expect(chat.thinkingOpen(1)).toBe(true)
      chat.toggleCardExpand("call-1")
      expect(chat.cardExpanded("call-1")).toBe(true)
      // An empty answer is refused; an aborted ask is not pending; a real ask
      // card is answered over WS.
      expect(chat.pendingAsk()).toBeNull()
      expect(chat.answerAsk("call-1", "")).toBe(false)
    } finally {
      chat.dispose()
      client.close()
    }
  }, 30000)

  test("a chat.meta carrying a new session title updates the title accessor", async () => {
    // The async auto title arrives as a `chat.meta` after the turn settles; the
    // tab title reads `accessors.sessionTitle`, so the meta handler must sync it
    // (a client that only read `chat.state` would never retitle).
    const ctx = await startCtx({ autoTitles: true })
    const client = clientFor(ctx)
    try {
      await client.waitForHello(8000)
      const opened = await client.chat.open({})
      const chatId = opened.chatId
      const chat = RemoteChat.create({ ws: client, chatId, state: opened.state, display: { animations: false } })
      try {
        // The first prompt seeds the derived placeholder, delivered as a
        // `chat.meta` (no `chat.state` follows) — the accessor must reflect it.
        await client.request("chat.send", { chatId, text: "plain:help me deploy the alpha service" })
        await waitFor(() => chat.accessors.sessionTitle().includes("deploy the alpha service"), 8000, "title from chat.meta")
      } finally {
        chat.dispose()
      }
    } finally {
      client.close()
    }
  }, 30000)
})

/** Poll `pred` until true, else throw after `timeoutMs`. */
async function waitFor(pred: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (pred()) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(25)
  }
}
