/**
 * Headless full-turn test (IF1; docs/architecture.md "engine/"): drive a
 * complete agent turn — user message → a tool call → an approval decision →
 * completion — against the REAL scripted mock OpenAI server, with ZERO
 * renderer/UI imports. This proves the engine is hostable by a daemon (P3).
 *
 * The only imports are the engine barrel (`src/engine/index.ts`), config,
 * sessions and the mock server. No `src/ui/**` is touched; the import-graph
 * guard (`importGraph.test.ts`) enforces that statically for the whole layer.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChatHost } from "../../../src/engine/index.ts"
import { defaultConfig, type SensusConfig } from "../../../src/engine/index.ts"
import { startMockOpenai, type MockOpenaiServer } from "../../mocks/mockOpenai.ts"

async function until(f: () => boolean, ms = 8000, label = "condition"): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (f()) return
    await Bun.sleep(15)
  }
  throw new Error(`until(${label}) timed out`)
}

let server: MockOpenaiServer

beforeAll(async () => {
  server = await startMockOpenai()
})

afterAll(async () => {
  await server.close()
})

/** A ChatHost wired to the mock endpoint, sandboxed under a temp SENSUS_HOME. */
function makeHeadlessHost(home: string): ChatHost {
  const cfg: SensusConfig = defaultConfig()
  cfg.endpoints["main"] = { ...cfg.endpoints["main"]!, baseURL: server.url, apiKey: "headless-key", maxTokens: 128 }
  cfg.model = "main@plain-model"
  // Auto-title issues an extra request; keep the turn deterministic.
  cfg.titles.enabled = false
  return new ChatHost({
    dataDir: join(home, "data"),
    instanceId: "headless",
    initialConfig: cfg,
    argv: [],
    toast: () => {},
  })
}

describe("headless engine turn (no renderer)", () => {
  test("message → gated tool call → approve → completion, persisted to JSONL", async () => {
    const home = mkdtempSync(join(tmpdir(), "sensus-headless-turn-"))
    const prevHome = process.env["SENSUS_HOME"]
    process.env["SENSUS_HOME"] = home
    try {
      const host = makeHeadlessHost(home)
      const chat = host.createTabChat(1)

      // "cmd:<shell>" scripts a shell_background tool call; in the default
      // confirm mode it must gate into a pending approval card.
      expect(chat.handleInput("cmd:echo HEADLESS-TOOL-OK")).toBe("sent")
      await until(() => chat.pendingApproval() !== null, 8000, "pending approval")

      const pending = chat.pendingApproval()
      expect(pending?.name).toBe("shell_background")
      // The approval decision is the single gate point the daemon answers.
      const gate = (chat as unknown as { gateDecision: (c: { name: string; arguments: string; id: string }, a: Record<string, unknown>) => { gate: boolean; action?: string } }).gateDecision(
        { id: pending!.callId, name: "shell_background", arguments: JSON.stringify({ command: "echo HEADLESS-TOOL-OK" }) },
        { command: "echo HEADLESS-TOOL-OK" },
      )
      expect(gate.gate).toBe(true)

      expect(chat.resolveCard(pending!.callId, "accept")).toBe(true)
      await until(() => chat.accessors.status() === "idle", 8000, "idle after tool")

      // The tool ran for real and the model's follow-up turn completed.
      const cards = chat.accessors.messages().filter((m) => m.role === "tool")
      const card = cards.find((m) => m.tool?.name === "shell_background")
      expect(card?.tool?.status).toBe("done")
      expect(card?.tool?.output).toContain("HEADLESS-TOOL-OK")

      const assistant = chat.accessors.messages().filter((m) => m.role === "assistant")
      expect(assistant.at(-1)?.content).toContain("TOOLDONE-OK")

      // The full turn is persisted without any UI involvement.
      const jsonl = readFileSync(chat.sessionFilePath ?? "", "utf8")
      expect(jsonl).toContain('"type":"tool_call"')
      expect(jsonl).toContain("HEADLESS-TOOL-OK")
      expect(jsonl).toContain("TOOLDONE-OK")
    } finally {
      if (prevHome === undefined) delete process.env["SENSUS_HOME"]
      else process.env["SENSUS_HOME"] = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("message → gated tool call → deny → completion (nothing executes)", async () => {
    const home = mkdtempSync(join(tmpdir(), "sensus-headless-deny-"))
    const prevHome = process.env["SENSUS_HOME"]
    process.env["SENSUS_HOME"] = home
    try {
      const host = makeHeadlessHost(home)
      const chat = host.createTabChat(1)
      chat.handleInput("cmd:echo NEVER-HEADLESS")
      await until(() => chat.pendingApproval() !== null, 8000, "pending deny")
      expect(chat.resolveCard(chat.pendingApproval()!.callId, "reject")).toBe(true)
      await until(() => chat.accessors.status() === "idle", 8000, "idle after reject")

      const card = chat.accessors.messages().find((m) => m.role === "tool" && m.tool?.name === "shell_background")
      expect(card?.tool?.status).toBe("rejected")
      // The denial reached the model as the tool result; the command never ran
      // (the rejected card carries only the rejection marker, not command output).
      expect(card?.tool?.output ?? "").not.toContain("echo")
      expect(card?.tool?.exitCode ?? null).toBeNull()
      expect(chat.accessors.messages().at(-1)?.content).toContain("TOOLDONE-OK")
      const jsonl = readFileSync(chat.sessionFilePath ?? "", "utf8")
      expect(jsonl).not.toContain('"status":"done"')
      expect(jsonl).not.toContain('"output":"')
    } finally {
      if (prevHome === undefined) delete process.env["SENSUS_HOME"]
      else process.env["SENSUS_HOME"] = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})
