/**
 * ChatSession tool-loop tests (docs/agent.md "Tool loop") — a scripted fake
 * provider drives the loop while the REAL tool implementations run (real
 * bash spawns + real files under a temp SENSUS_HOME; no PTY, no network).
 *
 * Covers: sequencing, transcript/provider-history shape, approval
 * accept/reject/allowlist, max-turns cap, edit_file diff application and
 * not-found/not-unique errors, shell_background truncation + timeout kill, Esc
 * abort killing a running command, ask_user, context injection and the
 * no-tools latch.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyChatDisplayConfig, ChatSession, recordsToMessages, type ChatMessage } from "../../../../src/agent/chat/chatSession.ts"
import type { FirstPromptInfo, McpServerStatusFact } from "../../../../src/agent/chat/chatMessages.ts"
import type { ToastLevel } from "../../../../src/ui/lib/toast.ts"
import type { ChatProvider, StreamRequest, StreamResult, UsageInfo } from "../../../../src/agent/provider/provider.ts"
import type { ToolSpec } from "../../../../src/agent/tools.ts"
import type { McpConfig } from "../../../../src/config/config.ts"
import { resolveConfig } from "../../../../src/config/config.ts"
import type { ModelOverride } from "../../../../src/config/config.ts"
import { ONE_SHOT_MAX_TOKENS } from "../../../../src/agent/chat/compaction.ts"
import type { MemorySnapshot, MemoryToolBridge } from "../../../../src/agent/memory/types.ts"
import { MemoryStore } from "../../../../src/agent/memory/store.ts"
import type { ApprovalPolicy, EventSink, SensusEvent } from "../../../../src/agent/extensions.ts"
import type { AuditBridge, AuditEntry } from "../../../../src/agent/audit.ts"
import { loadSessionFile, SessionFile } from "../../../../src/session/store.ts"
import { configureLogger, parseLogLine, type LogRecord } from "../../../../src/core/log.ts"
import { reconstructHistoryEntries } from "../../../../src/agent/chat/contextHistory.ts"
import { TOOL_SPEC_TOKENS } from "../../../../src/agent/chat/compaction.ts"
import { renameSession } from "../../../../src/session/meta.ts"
import { layoutText } from "../../../../src/ui/chat/chatLayout.ts"

const USAGE: UsageInfo = { promptTokens: 5, completionTokens: 3, totalTokens: 8 }

type Step =
  | {
      kind: "stop"
      text: string
      noTools?: boolean
      reasoning?: string[]
      gate?: Promise<void>
      /** Override the finish reason (e.g. "length", "error") — defaults "stop". */
      finish?: StreamResult["finish"]
      /** Emit no delta at all (an empty completion with a real finish). */
      empty?: boolean
      /** Completed tool calls returned with a NON-tool_calls finish (the
       * dropped-call shape some OpenAI-compatible servers emit). */
      calls?: Array<{ id: string; name: string; arguments: string }>
    }
  | { kind: "tool_calls"; calls: Array<{ id: string; name: string; arguments: string }>; reasoning?: string[] }
  | { kind: "error"; error: string }
  /** Compaction summarizer step: streams `text` with an optional finish reason
   * (default "stop") and optional gate. */
  | { kind: "summary"; text: string; finish?: StreamResult["finish"]; gate?: Promise<void> }
  /**
   * A provider-internal retry (docs/agent.md "Streaming display"): streams the
   * failed attempt's reasoning, optionally waits (so the coalescer lands it),
   * announces the restart, then streams the successful attempt. Mirrors what
   * AiSdkProvider does across two wire attempts inside ONE stream() call —
   * the session never sees the failure itself.
   */
  | {
      kind: "retry"
      failedReasoning: string[]
      gate?: Promise<void>
      reasoning?: string[]
      text: string
    }

/** Scripted ChatProvider: pops one step per stream() call. */
class ScriptedProvider implements ChatProvider {
  readonly name = "scripted"
  readonly requests: StreamRequest[] = []
  private readonly steps: Step[]
  private readonly usage: UsageInfo
  constructor(steps: Step[], usage: UsageInfo = USAGE) {
    this.steps = steps
    this.usage = usage
  }
  async stream(req: StreamRequest, h: import("../../../../src/agent/provider/provider.ts").StreamHandlers, signal: AbortSignal): Promise<StreamResult> {
    this.requests.push(req)
    const step = this.steps.shift()
    if (signal.aborted) return { finish: "aborted", usage: null, error: null }
    if (step === undefined) return { finish: "error", usage: null, error: "script exhausted" }
    if (step.kind === "stop") {
      // Busy-send tests hold the first stream open so handleInput runs while
      // status is "streaming" (the gate resolves when the test releases it).
      if (step.gate !== undefined) await step.gate
      if (signal.aborted) return { finish: "aborted", usage: null, error: null }
      if (step.noTools) h.onNoTools?.()
      for (const r of step.reasoning ?? []) h.onReasoning?.(r)
      if (step.empty !== true) h.onDelta(step.text)
      h.onUsage?.(this.usage)
      return {
        finish: step.finish ?? "stop",
        usage: this.usage,
        error: null,
        ...(step.calls !== undefined ? { toolCalls: step.calls } : {}),
      }
    }
    if (step.kind === "summary") {
      if (step.gate !== undefined) await step.gate
      if (signal.aborted) return { finish: "aborted", usage: null, error: null }
      h.onDelta(step.text)
      h.onUsage?.(this.usage)
      return { finish: step.finish ?? "stop", usage: this.usage, error: null }
    }
    if (step.kind === "retry") {
      for (const r of step.failedReasoning) h.onReasoning?.(r)
      if (step.gate !== undefined) await step.gate
      if (signal.aborted) return { finish: "aborted", usage: null, error: null }
      // The real provider announces the restart before re-streaming; the
      // consumer must discard what the failed attempt showed.
      h.onStreamRestart?.()
      for (const r of step.reasoning ?? []) h.onReasoning?.(r)
      h.onDelta(step.text)
      h.onUsage?.(this.usage)
      return { finish: "stop", usage: this.usage, error: null }
    }
    if (step.kind === "error") return { finish: "error", usage: null, error: step.error }
    for (const r of step.reasoning ?? []) h.onReasoning?.(r)
    h.onUsage?.(this.usage)
    return { finish: "tool_calls", usage: this.usage, error: null, toolCalls: step.calls }
  }
}

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sensus-chatloop-"))
})

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

interface Harness {
  chat: ChatSession
  provider: ScriptedProvider
  home: string
  file: SessionFile
  toasts: Array<{ message: string; level: ToastLevel }>
  config: ReturnType<typeof resolveConfig>
}

interface HarnessOpts {
  pane?: PaneStub
  instructions?: string | null
  /** Memory wiring for the frozen-snapshot prompt tests (docs/memory.md). */
  memory?: { getSnapshot: () => MemorySnapshot | null; bridge?: MemoryToolBridge }
  /** Audit/undo bridge for the /undo + /audit tests. */
  audit?: AuditBridge
  /** Auto-title hook (docs/sessions.md "Auto titles") — tests capture calls. */
  onFirstPrompt?: (info: FirstPromptInfo) => void
  /** Sudo seams (docs/agent.md "Sudo"). */
  requestSudo?: (command: string) => Promise<string | null>
  hasSudoPassword?: () => boolean
  clearSudoPassword?: () => void
  /** Catalog generation for the model-metadata memo (models.dev prefetch). */
  catalogVersion?: () => number
  /** Provider-reported usage per stream (default `USAGE`) — lets a test drive
   * the usage anchor to a realistic prompt size. */
  usage?: UsageInfo
  /** Config reload seam for the `reload` tool (the /reload action). */
  reloadConfig?: () => string | null
  /** Extensions seam (docs/extensions.md). */
  sessionId?: string
  approvalPolicy?: () => ApprovalPolicy | null
  eventSink?: () => EventSink | undefined
}

function makeSession(steps: Step[], opts: HarnessOpts = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), "sensus-chatloop-home-"))
  const config = resolveConfig([], {
    HOME: home,
    SENSUS_HOME: home,
    SHELL: "/bin/bash",
    PATH: process.env["PATH"] ?? "/usr/bin",
  })
  config.endpoints["main"]!.apiKey = "unit-test-key"
  config.context.enabled = true
  const file = SessionFile.create(join(home, "sessions", "inst", "tab-1.jsonl"), { endpoint: "main", model: "test-model" })
  const toasts: Array<{ message: string; level: ToastLevel }> = []
  const provider = new ScriptedProvider(steps, opts.usage ?? USAGE)
  const chat = new ChatSession({
    getConfig: () => config,
    provider: () => provider,
    file: () => file,
    rotateFile: () => file,
    toast: (m, level = "info") => toasts.push({ message: m, level }),
    getInstructions: () => opts.instructions ?? null,
    getMemorySnapshot: opts.memory ? () => opts.memory!.getSnapshot() : undefined,
    memory: opts.memory?.bridge,
    audit: opts.audit,
    onFirstPrompt: opts.onFirstPrompt,
    requestSudo: opts.requestSudo,
    hasSudoPassword: opts.hasSudoPassword,
    clearSudoPassword: opts.clearSudoPassword,
    catalogVersion: opts.catalogVersion,
    reloadConfig: opts.reloadConfig,
    sessionId: opts.sessionId,
    approvalPolicy: opts.approvalPolicy,
    eventSink: opts.eventSink,
  })
  chat.attachTerminal(() => ({
    pane: opts.pane ?? null,
    cwd: home,
    shell: "zsh",
    currentCommand: "zsh",
    alternateOn: false,
    tailLines: ["PANE-TAIL-1", "", "", "PANE-TAIL-2"],
  }))
  return { chat, provider, home, file, toasts, config }
}

type PaneStub = {
  sendKeys(action: { kind: "literal"; text: string } | { kind: "keys"; names: string[] }): Promise<void>
  captureScrollbackRaw(lines: number): Promise<string>
}

async function until(f: () => boolean, ms = 5000, label = "condition"): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (f()) return
    await Bun.sleep(15)
  }
  throw new Error(`until(${label}) timed out`)
}

const status = (h: Harness): string => h.chat.accessors.status()
const messages = (h: Harness): ChatMessage[] => h.chat.accessors.messages()
const cards = (h: Harness): ChatMessage[] => messages(h).filter((m) => m.role === "tool")

/**
 * Capture the process-wide structured log for the duration of one test
 * (docs/logging.md). `restore` must run in a `finally`; the logger is global.
 */
function captureLogs(): { records: () => LogRecord[]; restore: () => void } {
  const lines: string[] = []
  configureLogger({ level: "debug", sink: (line) => lines.push(line) })
  return {
    records: () => lines.map((l) => parseLogLine(l)).filter((r): r is LogRecord => r !== null),
    restore: () => configureLogger({ level: "error", sink: () => {} }),
  }
}

const call = (name: string, args: unknown, id = `call_${name}`): { id: string; name: string; arguments: string } => ({
  id,
  name,
  arguments: JSON.stringify(args),
})

describe("ChatSession tool loop", () => {
  test("plain stop: transcript + provider history + JSONL + tokens", async () => {
    const h = makeSession([{ kind: "stop", text: "hello world" }])
    expect(h.chat.handleInput("hi there")).toBe("sent")
    await until(() => status(h) === "idle", 5000, "idle")
    const msgs = messages(h)
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(msgs[0]?.content).toBe("hi there")
    expect(msgs[1]?.content).toBe("hello world")
    expect(msgs[1]?.usage?.totalTokens).toBe(8)
    expect(h.chat.accessors.totalTokens()).toBe(8)
    const jsonl = readFileSync(h.file.filePath, "utf8")
    expect(jsonl).toContain('"type":"user_message"')
    expect(jsonl).toContain('"type":"assistant_message"')
  })

  test("revert: rewinds the transcript, durable history and JSONL, and reloads the draft", async () => {
    const h = makeSession([
      { kind: "stop", text: "first reply" },
      { kind: "stop", text: "second reply" },
      { kind: "stop", text: "third reply" },
    ])
    h.chat.handleInput("first question")
    await until(() => status(h) === "idle", 5000, "idle first")
    h.chat.handleInput("second question")
    await until(() => status(h) === "idle", 5000, "idle second")
    expect(messages(h).map((m) => m.content)).toEqual([
      "first question",
      "first reply",
      "second question",
      "second reply",
    ])

    const secondUser = messages(h).find((m) => m.role === "user" && m.content === "second question")!
    expect(h.chat.revertToUserMessage(secondUser.id)).toBe(true)
    // The reverted turn is gone; its text is back in the editor for resend.
    expect(messages(h).map((m) => m.content)).toEqual(["first question", "first reply"])
    expect(h.chat.getDraft()).toBe("second question")

    // A --resume must not resurrect the reverted turn (revert marker in JSONL).
    const loaded = loadSessionFile(h.file.filePath)
    expect(loaded.messages.map((m) => m.content)).toEqual(["first question", "first reply"])
    expect(loaded.firstUser).toBe("first question")

    // Resend carries the retained prefix but NOT the reverted turn, and the
    // re-sent question appears exactly once.
    h.chat.handleInput(h.chat.getDraft())
    await until(() => status(h) === "idle", 5000, "idle third")
    const req = h.provider.requests.at(-1)!
    expect(req.messages.filter((m) => m.role === "user" && m.content.includes("second question"))).toHaveLength(1)
    expect(req.messages.some((m) => m.role === "assistant" && m.content.includes("second reply"))).toBe(false)
    expect(req.messages.some((m) => m.role === "assistant" && m.content.includes("first reply"))).toBe(true)
    // An unknown id is a no-op.
    expect(h.chat.revertToUserMessage(999999)).toBe(false)
  })

  test("failed turn with no output leaves no phantom assistant record; a later revert stays exact", async () => {
    const h = makeSession([
      { kind: "error", error: "connection reset" },
      { kind: "stop", text: "second reply" },
    ])
    h.chat.handleInput("first question")
    await until(() => status(h) === "idle", 5000, "idle error")
    // The failure shows as a local error bubble only — no assistant record is
    // persisted, so the display transcript stays 1:1 with the JSONL.
    expect(messages(h).filter((m) => m.role === "assistant")).toHaveLength(0)
    expect(messages(h).some((m) => m.role === "error")).toBe(true)
    expect(loadSessionFile(h.file.filePath).messages.map((m) => m.content)).toEqual(["first question"])

    // A later turn persists normally; rewinding to it keeps exactly the records
    // before it (the failed turn contributed none).
    h.chat.handleInput("second question")
    await until(() => status(h) === "idle", 5000, "idle second")
    const secondUser = messages(h).find((m) => m.role === "user" && m.content === "second question")!
    expect(h.chat.revertToUserMessage(secondUser.id)).toBe(true)
    const loaded = loadSessionFile(h.file.filePath)
    expect(loaded.messages.map((m) => m.content)).toEqual(["first question"])
    expect(loaded.firstUser).toBe("first question")
  })

  test("auto-title hook fires on the first prompt only and never over a manual title", async () => {
    const calls: FirstPromptInfo[] = []
    const h = makeSession(
      [
        { kind: "stop", text: "first reply" },
        { kind: "stop", text: "second reply" },
      ],
      { onFirstPrompt: (info) => calls.push(info) },
    )
    const titleEvents: string[] = []
    h.chat.subscribe((e) => {
      if (e.kind === "title") titleEvents.push(e.title)
    })
    expect(h.chat.handleInput("first question")).toBe("sent")
    // The first prompt immediately seeds the tab title with the derived
    // first-message placeholder while the model title is in flight.
    expect(h.chat.accessors.sessionTitle()).toBe("first question")
    // The change is observable as an event too, so a remote host can fold it
    // into `meta.sessionTitle` (daemon chat meta).
    expect(titleEvents).toEqual(["first question"])
    await until(() => status(h) === "idle", 5000, "idle first")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.text).toBe("first question")
    expect(calls[0]?.path).toBe(h.file.filePath)
    expect(calls[0]?.endpoint).toBe("main")
    expect(calls[0]?.model).toBe("gpt-5")
    // The host-applied generated title replaces the placeholder.
    h.chat.setSessionTitle("Deploy the alpha service")
    expect(h.chat.accessors.sessionTitle()).toBe("Deploy the alpha service")
    expect(titleEvents).toEqual(["first question", "Deploy the alpha service"])
    // A later prompt never re-titles the session.
    expect(h.chat.handleInput("second question")).toBe("sent")
    await until(() => status(h) === "idle", 5000, "idle second")
    expect(calls).toHaveLength(1)
    expect(h.chat.accessors.sessionTitle()).toBe("Deploy the alpha service")
    // /clear rotates to a fresh session and drops the stale tab title.
    h.chat.handleInput("/clear")
    expect(h.chat.accessors.sessionTitle()).toBe("")

    // An explicit sidecar title (manual rename) is never overwritten.
    const manual: FirstPromptInfo[] = []
    const h2 = makeSession([{ kind: "stop", text: "reply" }], { onFirstPrompt: (info) => manual.push(info) })
    renameSession(h2.file.filePath, "My manual title")
    h2.chat.handleInput("hello there")
    await until(() => status(h2) === "idle", 5000, "idle manual")
    expect(manual).toHaveLength(0)
  })

  test("tool loop with shell_background (full-auto): executes, cites, persists tool events", async () => {
    const h = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "echo SENSUS-TOOL-1" })] },
      { kind: "stop", text: "done, the tool said SENSUS-TOOL-1" },
    ])
    h.chat.handleInput("/yolo")
    h.chat.handleInput("what does the tool say?")
    await until(() => status(h) === "idle", 8000, "idle after tool loop")
    const card = cards(h).find((m) => m.tool?.name === "shell_background")
    expect(card?.tool?.status).toBe("done")
    expect(card?.tool?.output).toContain("SENSUS-TOOL-1")
    expect(card?.tool?.exitCode).toBe(0)
    // 2nd request carried the tool result + assistant tool_calls.
    const second = h.provider.requests[1]
    const toolMsg = second?.messages.find((m) => m.role === "tool")
    expect(toolMsg?.content).toContain("SENSUS-TOOL-1")
    expect(second?.messages.some((m) => m.role === "assistant" && m.toolCalls?.length === 1)).toBe(true)
    const jsonl = readFileSync(h.file.filePath, "utf8")
    expect(jsonl).toContain('"type":"tool_call"')
    expect(jsonl).toContain("SENSUS-TOOL-1")
  })

  test("reload tool: routes to the config-reload seam (the /reload action) and returns its message", async () => {
    let reloads = 0
    const h = makeSession(
      [
        { kind: "tool_calls", calls: [call("reload", {}, "rl1")] },
        { kind: "stop", text: "reloaded" },
      ],
      {
        reloadConfig: () => {
          reloads++
          return "config reloaded (1 endpoint(s) · 1 agent(s))"
        },
      },
    )
    h.chat.setApproval("full-auto") // read-only tool, but confirm mode now gates every call
    h.chat.handleInput("apply the config edit")
    await until(() => status(h) === "idle", 8000, "idle after reload tool")
    expect(reloads).toBe(1)
    // full-auto: it auto-runs (no approval wait) and the card reports done.
    const card = cards(h).find((m) => m.tool?.name === "reload")
    expect(card?.tool?.status).toBe("done")
    expect(card?.tool?.output).toContain("config reloaded")
    // The model sees the reload result on the next request.
    const toolMsg = h.provider.requests[1]?.messages.find((m) => m.role === "tool")
    expect(toolMsg?.content).toContain("config reloaded")
  })

  test("tool-name repair: a mis-cased name executes and the canonical name lands on the assistant call + tool result", async () => {
    const h = makeSession([
      { kind: "tool_calls", calls: [call("Shell_Background", { command: "echo REPAIR-1" }, "rep1")] },
      { kind: "stop", text: "repaired" },
    ])
    h.chat.handleInput("/yolo")
    h.chat.handleInput("run it")
    await until(() => status(h) === "idle", 8000, "idle after repair")
    // The card and the execution used the canonical name.
    const card = cards(h).find((m) => m.tool?.name === "shell_background")
    expect(card?.tool?.status).toBe("done")
    expect(card?.tool?.output).toContain("REPAIR-1")
    // The stored assistant call + tool result must BOTH be canonical, so the
    // next request is wire-valid (repairing after the push would mismatch).
    const second = h.provider.requests[1]
    const assistant = second?.messages.find((m) => m.role === "assistant" && m.toolCalls?.length === 1)
    expect(assistant?.toolCalls?.[0]?.name).toBe("shell_background")
    const toolMsg = second?.messages.find((m) => m.role === "tool")
    expect(toolMsg?.toolName).toBe("shell_background")
    expect(toolMsg?.content).toContain("REPAIR-1")
  })

  test("approval gate: accept runs the command, reject reports rejection, allow-prefix exempts the rest of the session", async () => {
    // Accept: the command runs, the card reaches done.
    const accept = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "echo APPROVED-1" })] },
      { kind: "stop", text: "ran it" },
    ])
    accept.chat.handleInput("run echo APPROVED-1")
    await until(() => accept.chat.pendingApproval() !== null, 5000, "pending approval")
    const pending = accept.chat.pendingApproval()
    expect(pending?.status).toBe("pending")
    expect(pending?.allowPrefix).toBe("echo ")
    expect(accept.chat.resolveCard(pending!.callId, "accept")).toBe(true)
    await until(() => status(accept) === "idle", 8000, "idle accept")
    const done = cards(accept).find((m) => m.tool?.name === "shell_background")
    expect(done?.tool?.status).toBe("done")
    expect(done?.tool?.output).toContain("APPROVED-1")
    // Reject: nothing runs; the model sees the rejection as the tool result.
    const reject = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "echo NEVER-RAN" })] },
      { kind: "stop", text: "okay, skipped" },
    ])
    reject.chat.handleInput("please run")
    await until(() => reject.chat.pendingApproval() !== null, 5000, "pending reject")
    reject.chat.resolveCard(reject.chat.pendingApproval()!.callId, "reject")
    await until(() => status(reject) === "idle", 8000, "idle reject")
    const rejected = cards(reject).find((m) => m.tool?.name === "shell_background")
    expect(rejected?.tool?.status).toBe("rejected")
    const toolMsg = reject.provider.requests[1]?.messages.find((m) => m.role === "tool")
    expect(toolMsg?.content).toBe("User rejected")
    expect(readFileSync(reject.file.filePath, "utf8")).toContain("NEVER-RAN") // never in output
    expect(readFileSync(reject.file.filePath, "utf8")).not.toContain('"status":"done"')
    // Allow-for-session: the first allow approves later same-prefix commands
    // straight through (no pending card).
    const allow = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "echo ALLOW-A" })] },
      { kind: "stop", text: "first done" },
      { kind: "tool_calls", calls: [call("shell_background", { command: "echo ALLOW-B" })] },
      { kind: "stop", text: "second done" },
    ])
    allow.chat.handleInput("first")
    await until(() => allow.chat.pendingApproval() !== null, 5000, "pending 1")
    allow.chat.resolveCard(allow.chat.pendingApproval()!.callId, "allow")
    await until(() => status(allow) === "idle", 8000, "idle 1")
    expect(cards(allow)[0]?.tool?.status).toBe("done")
    allow.chat.handleInput("second")
    await until(() => cards(allow).length === 2 && cards(allow)[1]?.tool?.status === "done", 8000, "card 2 done")
    await until(() => status(allow) === "idle", 8000, "idle 2")
    expect(allow.chat.pendingApproval()).toBeNull()
  })

  test("session trust: 'a' grants an operation class; a same-class command skips the card; revoking restores it", async () => {
    const h = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "git status --short" }, "g1")] },
      { kind: "stop", text: "first" },
      { kind: "tool_calls", calls: [call("shell_background", { command: "git status --porcelain" }, "g2")] },
      { kind: "stop", text: "second" },
      { kind: "tool_calls", calls: [call("shell_background", { command: "git status" }, "g3")] },
      { kind: "stop", text: "third" },
    ])
    h.chat.handleInput("first")
    await until(() => h.chat.pendingApproval() !== null, 5000, "pending 1")
    // The offered pattern is the OPERATION CLASS, not the literal string.
    expect(h.chat.pendingApproval()?.allowPrefix).toBe("git status ")
    h.chat.resolveCard(h.chat.pendingApproval()!.callId, "allow")
    await until(() => status(h) === "idle", 8000, "idle 1")
    expect(h.chat.trustPatterns()).toEqual([{ tool: "shell_background", prefix: "git status " }])
    // A second, differently-worded command of the same class: no card.
    h.chat.handleInput("second")
    await until(() => cards(h).length === 2 && cards(h)[1]?.tool?.status === "done", 8000, "card 2 done")
    expect(h.chat.pendingApproval()).toBeNull()
    // Revoke: the third same-class command gates again.
    expect(h.chat.revokeTrust("shell_background", "git status ")).toBe(true)
    expect(h.chat.trustPatterns()).toHaveLength(0)
    h.chat.handleInput("third")
    await until(() => h.chat.pendingApproval() !== null, 5000, "pending 3")
    expect(h.chat.pendingApproval()?.allowPrefix).toBe("git status ")
    h.chat.resolveCard(h.chat.pendingApproval()!.callId, "reject")
    await until(() => status(h) === "idle", 8000, "idle 3")
  })

  test("a destructive command never offers the trust affordance (confirm and full-auto)", async () => {
    const confirm = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "rm -rf /" }, "r1")] },
      { kind: "stop", text: "blocked" },
    ])
    confirm.chat.handleInput("go")
    await until(() => confirm.chat.pendingApproval() !== null, 5000, "pending floor")
    expect(confirm.chat.pendingApproval()?.destructive).toBe(true)
    expect(confirm.chat.pendingApproval()?.allowPrefix ?? null).toBeNull()
    const text = layoutText(messages(confirm), 60)
    expect(text).toContain("destructive — allow disabled")
    expect(text).not.toContain("[a ")
    confirm.chat.resolveCard(confirm.chat.pendingApproval()!.callId, "reject")
    await until(() => status(confirm) === "idle", 8000, "idle confirm")

    // full-auto: still gated, still no affordance.
    const full = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "mkfs.ext4 /dev/sdb" }, "m1")] },
      { kind: "stop", text: "blocked" },
    ])
    full.chat.handleInput("/yolo")
    full.chat.handleInput("go")
    await until(() => full.chat.pendingApproval() !== null, 5000, "pending full-auto floor")
    expect(full.chat.pendingApproval()?.destructive).toBe(true)
    expect(full.chat.pendingApproval()?.allowPrefix ?? null).toBeNull()
    full.chat.resolveCard(full.chat.pendingApproval()!.callId, "reject")
    await until(() => status(full) === "idle", 8000, "idle full")
  })

  test("session trust is in-memory only: a different session starts with none", async () => {
    const a = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "echo TRUST-A" }, "a1")] },
      { kind: "stop", text: "a" },
    ])
    a.chat.handleInput("go")
    await until(() => a.chat.pendingApproval() !== null, 5000, "pending a")
    a.chat.resolveCard(a.chat.pendingApproval()!.callId, "allow")
    await until(() => status(a) === "idle", 8000, "idle a")
    expect(a.chat.trustPatterns()).toHaveLength(1)

    const b = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "echo TRUST-A" }, "b1")] },
      { kind: "stop", text: "b" },
    ])
    b.chat.handleInput("go")
    await until(() => b.chat.pendingApproval() !== null, 5000, "pending b")
    expect(b.chat.pendingApproval()).not.toBeNull()
    b.chat.resolveCard(b.chat.pendingApproval()!.callId, "reject")
    await until(() => status(b) === "idle", 8000, "idle b")
  })

  test("background jobs: the live count is visible and the context line gives the agent a cheap ask", async () => {
    const h = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "sleep 30", background: true }, "j1")] },
      { kind: "stop", text: "started" },
      { kind: "stop", text: "nothing new" },
    ])
    h.chat.handleInput("/yolo")
    h.chat.handleInput("start a job")
    await until(() => status(h) === "idle", 8000, "idle start")
    expect(h.chat.activeJobCount()).toBeGreaterThanOrEqual(1)
    // Turn-end visibility: the warning names the live count.
    expect(h.toasts.some((t) => t.message.includes("background job") && t.message.includes("still running"))).toBe(true)
    // The next generation's context message carries the agent's cheap ask.
    h.chat.handleInput("anything running?")
    await until(() => status(h) === "idle", 8000, "idle second")
    const ctx = h.provider.requests
      .at(-1)
      ?.messages.find((m) => m.role === "user" && m.content.includes("background jobs"))
    expect(ctx?.content ?? "").toContain("[agent] background jobs: 1 running")
    // /clear kills this session's jobs; the chip count drops to zero.
    h.chat.handleInput("/clear")
    await until(() => h.chat.activeJobCount() === 0, 5000, "cleared jobs")
  }, 15000)

  test("permission deny rule blocks execution with no approval card and a policy message", async () => {
    const h = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "echo DENIED-NEVER-RAN" })] },
      { kind: "stop", text: "understood" },
    ])
    // Rule-based deny (docs/config.md "permission"): terminal, even though
    // confirm mode would normally gate this into an approval card.
    h.config.permission = [{ tool: "shell_background", action: "deny" }]
    h.chat.handleInput("run the denied command")
    await until(() => status(h) === "idle", 8000, "idle deny")
    expect(h.chat.pendingApproval()).toBeNull()
    const card = cards(h).find((m) => m.tool?.name === "shell_background")
    expect(card?.tool?.status).toBe("error")
    const toolMsg = h.provider.requests[1]?.messages.find((m) => m.role === "tool")
    expect(toolMsg?.content).toBe("Denied by permission policy: shell_background")
    // Nothing executed: no done card/event was written.
    expect(readFileSync(h.file.filePath, "utf8")).not.toContain('"status":"done"')
  })

  test("extensions: a policy deny refuses through the normal path (no card, no execution) and emits command-denied(policy)", async () => {
    const events: SensusEvent[] = []
    const h = makeSession(
      [
        { kind: "tool_calls", calls: [call("shell_background", { command: "echo POLICY-NEVER-RAN" })] },
        { kind: "stop", text: "noted" },
      ],
      {
        sessionId: "inst-policy",
        approvalPolicy: () => ({ decide: () => ({ action: "deny", reason: "not permitted" }) }),
        eventSink: () => ({ emit: (e) => events.push(e) }),
      },
    )
    h.chat.handleInput("run it")
    await until(() => status(h) === "idle", 8000, "idle policy deny")
    expect(h.chat.pendingApproval()).toBeNull()
    const card = cards(h).find((m) => m.tool?.name === "shell_background")
    expect(card?.tool?.status).toBe("error")
    const toolMsg = h.provider.requests[1]?.messages.find((m) => m.role === "tool")
    expect(toolMsg?.content).toContain("Denied by approval policy: shell_background")
    expect(toolMsg?.content).toContain("not permitted")
    expect(readFileSync(h.file.filePath, "utf8")).not.toContain('"status":"done"')
    const denied = events.find((e) => e.type === "command-denied")
    expect(denied?.type === "command-denied" ? denied.source : null).toBe("policy")
    expect(denied?.type === "command-denied" ? denied.reason : null).toBe("not permitted")
    expect(denied?.session).toBe("inst-policy")
    expect(events.some((e) => e.type === "command-ran")).toBe(false)
  })

  test("extensions: a policy allow skips the confirm card (approved:policy → ran); the destructive floor still gates", async () => {
    const events: SensusEvent[] = []
    const h = makeSession(
      [
        { kind: "tool_calls", calls: [call("shell_background", { command: "echo POLICY-ALLOWED" })] },
        { kind: "stop", text: "done" },
      ],
      {
        sessionId: "inst-allow",
        approvalPolicy: () => ({ decide: () => ({ action: "allow" }) }),
        eventSink: () => ({ emit: (e) => events.push(e) }),
      },
    )
    h.chat.handleInput("go")
    await until(() => status(h) === "idle", 8000, "idle allow")
    expect(h.chat.pendingApproval()).toBeNull()
    const card = cards(h).find((m) => m.tool?.name === "shell_background")
    expect(card?.tool?.status).toBe("done")
    expect(card?.tool?.output).toContain("POLICY-ALLOWED")
    const approved = events.find((e) => e.type === "command-approved")
    expect(approved?.type === "command-approved" ? approved.source : null).toBe("policy")
    const ran = events.find((e) => e.type === "command-ran")
    expect(ran?.type === "command-ran" ? ran.ok : null).toBe(true)

    // The destructive floor is a hard invariant: `allow` cannot un-gate it.
    const floor = makeSession(
      [
        { kind: "tool_calls", calls: [call("shell_background", { command: "rm -rf /" }, "floor")] },
        { kind: "stop", text: "blocked" },
      ],
      { approvalPolicy: () => ({ decide: () => ({ action: "allow" }) }) },
    )
    floor.chat.handleInput("go")
    await until(() => floor.chat.pendingApproval() !== null, 5000, "pending floor")
    expect(floor.chat.pendingApproval()?.destructive).toBe(true)
    floor.chat.resolveCard(floor.chat.pendingApproval()!.callId, "reject")
    await until(() => status(floor) === "idle", 8000, "idle floor")
  })

  test("extensions: a memory write emits approved → ran → memory-write with the store's char delta", async () => {
    const home = mkdtempSync(join(tmpdir(), "sensus-ext-mem-"))
    try {
      const store = new MemoryStore({
        dir: join(home, "memory"),
        limits: { memory: 2200, host: 4000, journal: 8000 },
        redactSecrets: true,
      })
      store.ensure()
      const events: SensusEvent[] = []
      const h = makeSession(
        [
          { kind: "tool_calls", calls: [call("memory", { action: "add", target: "memory", content: "policy seam works" }, "m1")] },
          { kind: "stop", text: "noted" },
        ],
        {
          sessionId: "inst-mem",
          memory: { getSnapshot: () => null, bridge: store },
          eventSink: () => ({ emit: (e) => events.push(e) }),
        },
      )
      // full-auto so the memory write runs without an approval card.
      h.chat.handleInput("/yolo")
      h.chat.handleInput("remember this")
      await until(() => status(h) === "idle", 8000, "idle memory")
      const commandEvents = events
        .map((e) => e.type)
        .filter((t) => t === "command-approved" || t === "command-ran" || t === "memory-write")
      expect(commandEvents).toEqual(["command-approved", "command-ran", "memory-write"])
      const mw = events.find((e) => e.type === "memory-write")
      if (mw?.type === "memory-write") {
        expect(mw.target).toBe("memory")
        expect(mw.action).toBe("add")
        expect(mw.delta).toBeGreaterThan(0)
        expect(mw.afterChars).toBe(mw.beforeChars + mw.delta)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("approval batch: a 3-call turn renders ONE plan; approve-all runs all three in order", async () => {
    const h = makeSession([
      {
        kind: "tool_calls",
        calls: [
          call("shell_background", { command: "echo BATCH-A" }, "ba"),
          call("shell_background", { command: "echo BATCH-B" }, "bb"),
          call("shell_background", { command: "echo BATCH-C" }, "bc"),
        ],
      },
      { kind: "stop", text: "all done" },
    ])
    h.chat.handleInput("run the batch")
    await until(() => h.chat.pendingPlan() !== null, 5000, "pending plan")
    const plan = h.chat.pendingPlan()!
    expect(plan.lines.map((l) => l.callId)).toEqual(["ba", "bb", "bc"])
    expect(plan.lines.every((l) => l.status === "approved")).toBe(true)
    // The plan is the SINGLE gate: no individual card is separately pending.
    expect(h.chat.pendingApproval()).toBeNull()
    const text = layoutText(messages(h), 64)
    expect(text).toContain("▸ plan · 3 approvals")
    expect(text).toContain("[1/3] shell_background")
    expect(text).toContain("[2/3] shell_background")
    expect(text).toContain("[3/3] shell_background")
    expect(text).toContain("[A approve all]")
    expect(text).toContain("[↵ confirm]")
    // Approve-all is a one-step commit: it runs all three in original order
    // without a separate `planCommit()` (which would now find no pending plan).
    h.chat.planApproveAll()
    await until(() => status(h) === "idle", 8000, "idle batch")
    const done = cards(h).filter((m) => m.tool?.name === "shell_background")
    expect(done.map((m) => m.tool?.status)).toEqual(["done", "done", "done"])
    const results = h.provider.requests.at(-1)?.messages.filter((m) => m.role === "tool") ?? []
    expect(results.map((r) => r.toolCallId)).toEqual(["ba", "bb", "bc"])
    expect(h.chat.pendingPlan()).toBeNull()
    const frozen = messages(h).find((m) => m.plan !== undefined)?.plan
    expect(frozen?.resolved).toBe(true)
    expect(frozen?.outcome).toBe("committed")
  })

  test("approval batch: a multi-write turn shows each planned diff in the plan and applies both on commit", async () => {
    const f1 = join(dir, "batch-edit-1.txt")
    const f2 = join(dir, "batch-edit-2.txt")
    writeFileSync(f1, "alpha\n")
    writeFileSync(f2, "beta\n")
    const h = makeSession([
      {
        kind: "tool_calls",
        calls: [
          call("edit_file", { path: f1, old_string: "alpha", new_string: "ALPHA" }, "w1"),
          call("edit_file", { path: f2, old_string: "beta", new_string: "BETA" }, "w2"),
        ],
      },
      { kind: "stop", text: "done" },
    ])
    h.chat.handleInput("edit both")
    await until(() => h.chat.pendingPlan() !== null, 5000, "pending plan")
    const plan = h.chat.pendingPlan()!
    // Each line carries its planned diff (reusing the filePlan machinery).
    expect(plan.lines.every((l) => (l.diff?.length ?? 0) > 0)).toBe(true)
    const text = layoutText(messages(h), 64)
    expect(text).toContain("+ ALPHA")
    expect(text).toContain("+ BETA")
    h.chat.planCommit()
    await until(() => status(h) === "idle", 8000, "idle")
    expect(readFileSync(f1, "utf8")).toBe("ALPHA\n")
    expect(readFileSync(f2, "utf8")).toBe("BETA\n")
  })

  test("approval batch: denying one line runs the others and reports 'User rejected'", async () => {
    const h = makeSession([
      {
        kind: "tool_calls",
        calls: [
          call("shell_background", { command: "echo KEEP-1" }, "k1"),
          call("shell_background", { command: "echo DROP-2" }, "k2"),
          call("shell_background", { command: "echo KEEP-3" }, "k3"),
        ],
      },
      { kind: "stop", text: "done" },
    ])
    h.chat.handleInput("go")
    await until(() => h.chat.pendingPlan() !== null, 5000, "pending plan")
    // Reject only the middle line (cursor starts at 0).
    h.chat.planMove(1)
    h.chat.planSetHighlighted("rejected")
    h.chat.planCommit()
    await until(() => status(h) === "idle", 8000, "idle")
    const byId = new Map(cards(h).filter((m) => m.tool !== undefined).map((m) => [m.tool!.callId, m.tool!]))
    expect(byId.get("k1")?.status).toBe("done")
    expect(byId.get("k2")?.status).toBe("rejected")
    expect(byId.get("k3")?.status).toBe("done")
    expect(byId.get("k1")?.output).toContain("KEEP-1")
    const results = h.provider.requests.at(-1)?.messages.filter((m) => m.role === "tool") ?? []
    expect(results.find((r) => r.toolCallId === "k2")?.content).toBe("User rejected")
  })

  test("approval batch: approve-all never covers a destructive line (explicit only, else rejected)", async () => {
    const h = makeSession([
      {
        kind: "tool_calls",
        calls: [
          call("shell_background", { command: "echo SAFE-1" }, "s1"),
          call("shell_background", { command: "dd if=/dev/zero of=/dev/stdout count=0" }, "d1"),
        ],
      },
      { kind: "stop", text: "done" },
    ])
    h.chat.handleInput("go")
    await until(() => h.chat.pendingPlan() !== null, 5000, "pending plan")
    const plan = h.chat.pendingPlan()!
    expect(plan.lines[0]?.status).toBe("approved")
    expect(plan.lines[1]?.destructive).toBe(true)
    expect(plan.lines[1]?.status).toBe("pending")
    // Approve-all skips the destructive line — and now COMMITS the plan in one
    // step: the safe line runs, the still-pending destructive line is rejected
    // (never runs), with the usual warn toast.
    h.chat.planApproveAll()
    await until(() => status(h) === "idle", 8000, "idle")
    const byId = new Map(cards(h).filter((m) => m.tool !== undefined).map((m) => [m.tool!.callId, m.tool!]))
    expect(byId.get("s1")?.status).toBe("done")
    expect(byId.get("d1")?.status).toBe("rejected")
    expect(h.toasts.some((t) => t.message.includes("destructive"))).toBe(true)

    // Explicit per-line approval DOES run it (the same safe destructive-class
    // command: dd to /dev/stdout with count=0).
    const explicit = makeSession([
      {
        kind: "tool_calls",
        calls: [
          call("shell_background", { command: "echo SAFE-A" }, "sa"),
          call("shell_background", { command: "dd if=/dev/zero of=/dev/stdout count=0" }, "dx"),
        ],
      },
      { kind: "stop", text: "done" },
    ])
    explicit.chat.handleInput("go")
    await until(() => explicit.chat.pendingPlan() !== null, 5000, "pending plan 2")
    explicit.chat.planMove(1)
    explicit.chat.planSetHighlighted("approved")
    explicit.chat.planCommit()
    await until(() => status(explicit) === "idle", 8000, "idle explicit")
    const exById = new Map(cards(explicit).filter((m) => m.tool !== undefined).map((m) => [m.tool!.callId, m.tool!]))
    expect(exById.get("dx")?.status).toBe("done")
  })

  test("a single gated call keeps today's plain card (no plan card)", async () => {
    const h = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "echo SINGLE" }, "one")] },
      { kind: "stop", text: "done" },
    ])
    h.chat.handleInput("go")
    await until(() => h.chat.pendingApproval() !== null, 5000, "pending card")
    expect(h.chat.pendingPlan()).toBeNull()
    const text = layoutText(messages(h), 52)
    expect(text).toContain("▸ shell_background")
    expect(text).not.toContain("▸ plan")
    h.chat.resolveCard(h.chat.pendingApproval()!.callId, "accept")
    await until(() => status(h) === "idle", 8000, "idle")
  })

  test("aborting a pending plan aborts the turn like today", async () => {
    const h = makeSession([
      {
        kind: "tool_calls",
        calls: [
          call("shell_background", { command: "echo ABORT-A" }, "a1"),
          call("shell_background", { command: "echo ABORT-B" }, "a2"),
        ],
      },
      { kind: "stop", text: "never" },
    ])
    h.chat.handleInput("go")
    await until(() => h.chat.pendingPlan() !== null, 5000, "pending plan")
    h.chat.abort()
    await until(() => status(h) === "idle", 8000, "idle abort")
    const planMsg = messages(h).find((m) => m.plan !== undefined)
    expect(planMsg?.plan?.resolved).toBe(true)
    expect(planMsg?.plan?.outcome).toBe("aborted")
    expect(cards(h).filter((m) => m.tool?.status === "done")).toHaveLength(0)
  })

  test("rewinding while a plan is pending discards the turn cleanly", async () => {
    const h = makeSession([
      {
        kind: "tool_calls",
        calls: [
          call("shell_background", { command: "echo RW-A" }, "r1"),
          call("shell_background", { command: "echo RW-B" }, "r2"),
        ],
      },
      { kind: "stop", text: "never" },
    ])
    h.chat.handleInput("go")
    await until(() => h.chat.pendingPlan() !== null, 5000, "pending plan")
    const userId = messages(h).find((m) => m.role === "user")!.id
    expect(h.chat.revertToUserMessage(userId)).toBe(true)
    await until(() => status(h) === "idle", 8000, "idle rewind")
    // The plan card was part of the discarded turn; nothing executed.
    expect(messages(h).some((m) => m.plan !== undefined)).toBe(false)
    expect(cards(h).filter((m) => m.tool?.status === "done")).toHaveLength(0)
  })

  test("doom-loop guard: the 4th consecutive identical call is blocked, the first 3 run", async () => {
    const h = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "echo DOOM" }, "d1")] },
      { kind: "tool_calls", calls: [call("shell_background", { command: "echo DOOM" }, "d2")] },
      { kind: "tool_calls", calls: [call("shell_background", { command: "echo DOOM" }, "d3")] },
      { kind: "tool_calls", calls: [call("shell_background", { command: "echo DOOM" }, "d4")] },
      { kind: "stop", text: "stopping" },
    ])
    h.chat.handleInput("/yolo")
    h.chat.handleInput("go")
    await until(() => status(h) === "idle", 15000, "idle doom")
    const toolCards = cards(h).filter((m) => m.tool?.name === "shell_background")
    expect(toolCards).toHaveLength(4)
    expect(toolCards.slice(0, 3).map((m) => m.tool?.status)).toEqual(["done", "done", "done"])
    expect(toolCards[3]?.tool?.status).toBe("error")
    expect(toolCards[3]?.tool?.output).toContain("Repeated identical tool call detected")
    expect(h.toasts.some((t) => t.message.includes("doom loop guard"))).toBe(true)
    const blocked = h.provider.requests[4]?.messages.find((m) => m.role === "tool" && m.toolCallId === "d4")
    expect(blocked?.content).toContain("Repeated identical tool call detected")
  })

  test("cached sudo password is reused silently in confirm mode — one entry covers all commands", async () => {
    // A shim that fails tty-less (no -A) but succeeds with -A by invoking the
    // askpass helper the app created — hermetic, no real sudo.
    const shimDir = join(dir, "sudo-cache-shim")
    mkdirSync(shimDir, { recursive: true })
    writeFileSync(
      join(shimDir, "sudo"),
      '#!/bin/sh\nfor a in "$@"; do [ "$a" = "-A" ] && { pw=$("$SUDO_ASKPASS"); echo "ran-with=$pw"; exit 0; }; done\n' +
        'echo "sudo: a password is required" >&2\nexit 1\n',
      { mode: 0o755 },
    )
    const prompts: string[] = []
    const h = makeSession(
      [
        { kind: "tool_calls", calls: [call("shell_background", { command: `export PATH="${shimDir}:$PATH"; sudo true` })] },
        { kind: "stop", text: "done" },
      ],
      {
        // Confirm/ask posture, but a password is already cached: the seam is
        // wired so the failure retries silently (no new popup).
        hasSudoPassword: () => true,
        requestSudo: async (command) => {
          prompts.push(command)
          return "cached-pw"
        },
      },
    )
    h.chat.handleInput("go")
    await until(() => h.chat.pendingApproval() !== null, 5000, "pending")
    h.chat.resolveCard(h.chat.pendingApproval()!.callId, "accept")
    await until(() => status(h) === "idle", 8000, "idle")
    expect(prompts).toHaveLength(1)
    const done = cards(h).find((m) => m.tool?.name === "shell_background")
    expect(done?.tool?.status).toBe("done")
    expect(done?.tool?.output).toContain("ran-with=cached-pw")
  })

  test("a rejected cached sudo password drops the vault (onSudoRejected) so it can ask again", async () => {
    const shimDir = join(dir, "sudo-reject-shim")
    mkdirSync(shimDir, { recursive: true })
    writeFileSync(join(shimDir, "sudo"), '#!/bin/sh\necho "Sorry, try again." >&2\necho "sudo: 3 incorrect password attempts" >&2\nexit 1\n', { mode: 0o755 })
    let cleared = 0
    let prompts = 0
    const h = makeSession(
      [
        { kind: "tool_calls", calls: [call("shell_background", { command: `export PATH="${shimDir}:$PATH"; sudo true` })] },
        { kind: "stop", text: "done" },
      ],
      {
        hasSudoPassword: () => true,
        requestSudo: async () => {
          prompts++
          return "wrong-pw"
        },
        clearSudoPassword: () => {
          cleared++
        },
      },
    )
    h.chat.handleInput("go")
    await until(() => h.chat.pendingApproval() !== null, 5000, "pending")
    h.chat.resolveCard(h.chat.pendingApproval()!.callId, "accept")
    await until(() => status(h) === "idle", 8000, "idle")
    // The cached (wrong) password was tried, refused, then re-prompted up to
    // the bound — each refusal drops the vault.
    expect(cleared).toBeGreaterThanOrEqual(1)
    expect(prompts).toBeGreaterThanOrEqual(2)
    const done = cards(h).find((m) => m.tool?.name === "shell_background")
    expect(done?.tool?.output).toContain("not accepted")
    expect(done?.tool?.output).toContain("incorrect")
    expect(done?.tool?.output?.toLowerCase()).toContain("not a cancellation")
  })

  test("parallel tool calls execute SEQUENTIALLY and report results in call order", async () => {
    const h = makeSession([
      {
        kind: "tool_calls",
        calls: [
          call("shell_background", { command: "sleep 0.2; touch SEQ-MARK; echo first-done", cwd: dir }, "call_1"),
          call("shell_background", { command: "test -f SEQ-MARK && echo seq-ok || echo parallel-race", cwd: dir }, "call_2"),
        ],
      },
      { kind: "stop", text: "both done" },
    ])
    h.chat.handleInput("/yolo")
    h.chat.handleInput("run both")
    await until(() => status(h) === "idle", 8000, "idle")
    const cardsNow = cards(h)
    expect(cardsNow).toHaveLength(2)
    expect(cardsNow[0]?.tool?.output).toContain("first-done")
    expect(cardsNow[1]?.tool?.output).toContain("seq-ok")
    // The follow-up request's tool results keep the call order.
    const toolMsgs = h.provider.requests[1]?.messages.filter((m) => m.role === "tool") ?? []
    expect(toolMsgs[0]?.toolCallId).toBe("call_1")
    expect(toolMsgs[1]?.toolCallId).toBe("call_2")
  })

  test("max turns cap is config-driven (chat.maxToolTurns) and stops the loop with a system note", async () => {
    const steps: Step[] = []
    for (let i = 0; i < 5; i++) {
      steps.push({ kind: "tool_calls", calls: [call("shell_background", { command: "echo cap" }, `cap_${i}`)] })
    }
    const h = makeSession(steps)
    h.config.chat.maxToolTurns = 2
    h.chat.handleInput("/yolo")
    h.chat.handleInput("loop forever")
    await until(() => status(h) === "idle", 15000, "cap idle")
    const text = messages(h).map((m) => m.content).join("\n")
    expect(text).toContain("stopped after 2 tool turns")
  }, 20000)

  test("edit_file through the loop: applies the diff on accept with -/+ rows; not-found/not-unique errors reach the model", async () => {
    // Success path: accept applies the diff; the card shows it.
    const f = join(dir, "edit-me.txt")
    writeFileSync(f, "alpha\nbeta\ngamma\n")
    const h = makeSession([
      { kind: "tool_calls", calls: [call("edit_file", { path: f, old_string: "beta", new_string: "BETA-EDITED" })] },
      { kind: "stop", text: "edited" },
    ])
    h.chat.handleInput("edit it")
    await until(() => h.chat.pendingApproval() !== null, 5000, "pending")
    h.chat.resolveCard(h.chat.pendingApproval()!.callId, "accept")
    await until(() => status(h) === "idle", 8000, "idle")
    expect(readFileSync(f, "utf8")).toBe("alpha\nBETA-EDITED\ngamma\n")
    const card = cards(h).find((m) => m.tool?.name === "edit_file")
    expect(card?.tool?.diff?.some((d) => d.kind === "-" && d.text === "beta")).toBe(true)
    expect(card?.tool?.diff?.some((d) => d.kind === "+" && d.text === "BETA-EDITED")).toBe(true)
    expect(card?.tool?.status).toBe("done")
    // Error paths: both failures reach the model, the file stays untouched.
    const dup = join(dir, "dup.txt")
    writeFileSync(dup, "same\nsame\n")
    const errs = makeSession([
      { kind: "tool_calls", calls: [call("edit_file", { path: dup, old_string: "nope", new_string: "x" }, "e1"), call("edit_file", { path: dup, old_string: "same", new_string: "x" }, "e2")] },
      { kind: "stop", text: "understood" },
    ])
    errs.chat.handleInput("/yolo")
    errs.chat.handleInput("try editing")
    await until(() => status(errs) === "idle", 8000, "idle errors")
    const results = errs.provider.requests[1]?.messages.filter((m) => m.role === "tool") ?? []
    expect(results[0]?.content).toContain("not found")
    expect(results[1]?.content).toContain("not unique")
    expect(readFileSync(dup, "utf8")).toBe("same\nsame\n")
  })

  test("write_file through the loop: creates on accept and diffs on overwrite", async () => {
    const f = join(dir, "write-me.txt")
    const h = makeSession([
      { kind: "tool_calls", calls: [call("write_file", { path: f, content: "one\n" })] },
      { kind: "stop", text: "created" },
      { kind: "tool_calls", calls: [call("write_file", { path: f, content: "two\n" })] },
      { kind: "stop", text: "overwritten" },
    ])
    h.chat.handleInput("create it")
    await until(() => h.chat.pendingApproval() !== null, 5000, "pending create")
    h.chat.resolveCard(h.chat.pendingApproval()!.callId, "accept")
    await until(() => status(h) === "idle", 8000, "idle create")
    expect(readFileSync(f, "utf8")).toBe("one\n")
    h.chat.handleInput("overwrite it")
    await until(() => h.chat.pendingApproval() !== null, 5000, "pending overwrite")
    h.chat.resolveCard(h.chat.pendingApproval()!.callId, "accept")
    await until(() => status(h) === "idle", 8000, "idle overwrite")
    expect(readFileSync(f, "utf8")).toBe("two\n")
    expect(cards(h)[1]?.tool?.diff?.some((d) => d.kind === "-" && d.text === "one")).toBe(true)
    expect(cards(h)[0]?.tool?.created).toBe(true)
  })

  test("shell_background safety rails: huge output truncates to ~2k lines; a timed-out command is killed", async () => {
    // Truncation: ~2k-line tail model-facing text (~12k), ~1.2k card preview.
    const h = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "seq 1 20000" })] },
      { kind: "stop", text: "big output seen" },
    ])
    h.chat.handleInput("/yolo")
    h.chat.handleInput("generate")
    await until(() => status(h) === "idle", 8000, "idle truncate")
    const toolMsg = h.provider.requests[1]?.messages.find((m) => m.role === "tool")
    expect((toolMsg?.content ?? "").length).toBeLessThan(13_000)
    expect(toolMsg?.content).toContain("truncated")
    const card = cards(h).find((m) => m.tool?.name === "shell_background")
    expect((card?.tool?.output ?? "").length).toBeLessThan(1400)
    // Timeout: the child is killed, partial output + no exit code.
    const t = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "echo TIMEOUT-MARK; sleep 30", timeout_s: 1 })] },
      { kind: "stop", text: "it timed out" },
    ])
    t.chat.handleInput("/yolo")
    t.chat.handleInput("sleep forever")
    await until(() => status(t) === "idle", 10000, "idle after timeout")
    const timeoutMsg = t.provider.requests[1]?.messages.find((m) => m.role === "tool")
    expect(timeoutMsg?.content).toContain("timed out")
    expect(timeoutMsg?.content).toContain("TIMEOUT-MARK")
    expect(cards(t).find((m) => m.tool?.name === "shell_background")?.tool?.exitCode).toBeNull()
  }, 20000)

  test("Esc aborts: kills a running command (no stray process) and cancels a pending approval", async () => {
    // Mid-command: child killed, card aborted, no follow-up request.
    const h = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "sleep 30; echo LATE" })] },
      { kind: "stop", text: "unreachable" },
    ])
    h.chat.handleInput("/yolo")
    h.chat.handleInput("start a long command")
    await until(() => cards(h).some((m) => m.tool?.status === "running"), 8000, "running card")
    h.chat.abort()
    await until(() => status(h) === "idle", 8000, "idle after abort")
    const card = cards(h).find((m) => m.tool?.name === "shell_background")
    expect(card?.tool?.status).toBe("aborted")
    expect(h.provider.requests.length).toBe(1)
    // No stray sleep 30 left behind (group kill). [s]leep avoids pgrep
    // matching its own command line.
    await Bun.sleep(300)
    const check = Bun.spawnSync(["sh", "-c", "pgrep -f '[s]leep 30; echo LATE' | wc -l"])
    expect(Number(check.stdout.toString().trim())).toBe(0)
    // Pending approval: abort resolves the card as aborted.
    const p = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "echo PENDING-ABORT" })] },
      { kind: "stop", text: "never reached" },
    ])
    p.chat.handleInput("run something")
    await until(() => p.chat.pendingApproval() !== null, 5000, "pending")
    p.chat.abort()
    await until(() => status(p) === "idle", 8000, "idle pending-abort")
    expect(cards(p).find((m) => m.tool?.name === "shell_background")?.tool?.status).toBe("aborted")
    expect(p.chat.pendingApproval()).toBeNull()
  }, 15000)

  test("activity records: tool executed + turn completed carry status, duration and the abort reason", async () => {
    const capture = captureLogs()
    try {
      // A normal turn: the tool execution and the settled outcome are recorded.
      const h = makeSession(
        [
          { kind: "tool_calls", calls: [call("shell_background", { command: "echo LOGGED-TOOL" }, "lg1")] },
          { kind: "stop", text: "done" },
        ],
        { sessionId: "inst-activity" },
      )
      h.chat.handleInput("/yolo")
      h.chat.handleInput("run it")
      await until(() => status(h) === "idle", 8000, "idle activity")
      const recs = capture.records()
      const ran = recs.find((r) => r.msg === "tool executed")
      expect(ran?.level).toBe("info")
      expect(ran?.component).toBe("agent.chat")
      expect(ran?.attributes?.["session"]).toBe("inst-activity")
      expect(ran?.attributes?.["tool"]).toBe("shell_background")
      expect(ran?.attributes?.["target"]).toBe("echo LOGGED-TOOL")
      expect(ran?.attributes?.["ok"]).toBe(true)
      expect(ran?.attributes?.["aborted"]).toBe(false)
      expect(ran?.attributes?.["exitCode"]).toBe(0)
      expect(typeof ran?.attributes?.["durationMs"]).toBe("number")
      const turn = recs.find((r) => r.msg === "turn completed")
      expect(turn?.level).toBe("info")
      expect(turn?.attributes?.["outcome"]).toBe("ok")
      expect(turn?.attributes?.["reason"]).toBeUndefined()
      expect(typeof turn?.attributes?.["durationMs"]).toBe("number")
      expect(typeof turn?.attributes?.["model"]).toBe("string")

      // An aborted turn names WHY on both the record and the seam event; the
      // killed tool execution is recorded aborted.
      const events: SensusEvent[] = []
      const a = makeSession(
        [
          { kind: "tool_calls", calls: [call("shell_background", { command: "sleep 30" }, "ab1")] },
          { kind: "stop", text: "never" },
        ],
        { sessionId: "inst-abort-reason", eventSink: () => ({ emit: (e) => events.push(e) }) },
      )
      a.chat.handleInput("/yolo")
      a.chat.handleInput("start long")
      await until(() => cards(a).some((m) => m.tool?.status === "running"), 8000, "running card")
      a.chat.abort("rewind")
      await until(() => status(a) === "idle", 8000, "idle abort reason")
      const abortedRec = capture
        .records()
        .find((r) => r.msg === "turn completed" && r.attributes?.["outcome"] === "aborted")
      expect(abortedRec?.attributes?.["reason"]).toBe("rewind")
      const killed = capture
        .records()
        .find(
          (r) =>
            r.msg === "tool executed" &&
            r.attributes?.["session"] === "inst-abort-reason" &&
            r.attributes?.["aborted"] === true,
        )
      expect(killed).toBeDefined()
      expect(killed?.attributes?.["ok"]).toBe(false)
      const turnEvent = events.find((e) => e.type === "turn-complete")
      expect(turnEvent?.type === "turn-complete" ? turnEvent.reason : undefined).toBe("rewind")
    } finally {
      capture.restore()
    }
  }, 20000)

  test("interaction tools: ask_user blocks for an answer; shell_session types through the pane handle", async () => {
    // ask_user: loop parks until answered; the answer feeds back as the tool result.
    const h = makeSession([
      { kind: "tool_calls", calls: [call("ask_user", { question: "Which way?", options: ["left", "right"] })] },
      { kind: "stop", text: "going that way" },
    ])
    h.chat.handleInput("decide for me")
    await until(() => h.chat.pendingAsk() !== null, 5000, "pending ask")
    expect(h.chat.pendingAsk()?.options).toEqual(["left", "right"])
    h.chat.answerAsk(h.chat.pendingAsk()!.callId, "right")
    await until(() => status(h) === "idle", 8000, "idle ask")
    const toolMsg = h.provider.requests[1]?.messages.find((m) => m.role === "tool")
    expect(toolMsg?.content).toBe("user answered: right")
    expect(cards(h).find((m) => m.tool?.name === "ask_user")?.tool?.answer).toBe("right")
    // shell_session: text then Enter through the pane stub.
    const sent: Array<{ kind: string; text?: string; names?: string[] }> = []
    const pane: PaneStub = {
      sendKeys: async (a) => {
        sent.push(a)
      },
      captureScrollbackRaw: async () => "",
    }
    const s = makeSession([
      { kind: "tool_calls", calls: [call("shell_session", { text: "echo HI", enter: true })] },
      { kind: "stop", text: "typed it" },
    ], { pane })
    s.chat.handleInput("type for me")
    // A submission (Enter over typed content) gates in confirm mode: approve
    // it, then the keystrokes land and the turn finishes.
    await until(() => s.chat.pendingApproval() !== null, 5000, "pending shell_session submission")
    expect(s.chat.pendingApproval()?.detail).toBe("echo HI")
    s.chat.resolveCard(s.chat.pendingApproval()!.callId, "accept")
    await until(() => status(s) === "idle", 8000, "idle shell_session")
    expect(sent).toHaveLength(2)
    expect(sent[0]?.kind).toBe("literal")
    expect(sent[0]?.text).toBe("echo HI")
    expect(sent[1]?.kind).toBe("keys")
  })

  test("shell_session sudo: the pane asks via the seam and types the askpass form (no bare sudo to retry around)", async () => {
    const sent: Array<{ kind: string; text?: string; names?: string[] }> = []
    const pane: PaneStub = {
      sendKeys: async (a) => {
        sent.push(a)
      },
      captureScrollbackRaw: async () => "",
    }
    let asked = 0
    const s = makeSession(
      [
        { kind: "tool_calls", calls: [call("shell_session", { text: "sudo whoami", enter: true })] },
        { kind: "stop", text: "done" },
      ],
      {
        pane,
        requestSudo: async (cmd) => {
          asked++
          expect(cmd).toContain("whoami")
          return "pw"
        },
      },
    )
    s.chat.handleInput("run sudo for me")
    // The submission itself gates first (confirm mode), then the sudo seam runs.
    await until(() => s.chat.pendingApproval() !== null, 5000, "pending sudo submission")
    s.chat.resolveCard(s.chat.pendingApproval()!.callId, "accept")
    await until(() => status(s) === "idle", 8000, "idle shell_session sudo")
    expect(asked).toBe(1)
    expect(sent[0]?.kind).toBe("literal")
    // Rewritten so sudo reads the helper, not a pane prompt the model retries around.
    expect(sent[0]?.text).toBe("sudo -A whoami")
  })
})

describe("ChatSession context injection", () => {
  test("provider sees the durable context message + the raw user text (UI shows raw text); /context off suppresses; alt-screen replaces the tail; system prompt carries env + instructions", async () => {
    // Block present, blank spam collapsed, bubble keeps raw text.
    const h = makeSession([{ kind: "stop", text: "noted" }], { instructions: "CUSTOM-INSTRUCTION-MARK" })
    h.chat.handleInput("what do you see?")
    await until(() => status(h) === "idle", 8000, "idle")
    const users = (h.provider.requests[0]?.messages ?? []).filter((m) => m.role === "user")
    const ctxMsg = users[0]
    expect(ctxMsg?.content.startsWith("[terminal] cwd:")).toBe(true)
    expect(ctxMsg?.content).toContain("· shell: zsh · cmd: zsh")
    expect(ctxMsg?.content).toContain("PANE-TAIL-1")
    expect(ctxMsg?.content).toContain("PANE-TAIL-2")
    expect(ctxMsg?.content).toContain("[agent] approval: confirm")
    // The user's text rides VERBATIM in its own message after the block.
    expect(users.at(-1)?.content).toBe("what do you see?")
    // Blank spam collapsed: exactly ONE blank line inside the block.
    expect((ctxMsg?.content ?? "").split("\n").filter((l) => l === "")).toHaveLength(1)
    expect(messages(h)[0]?.content).toBe("what do you see?")
    // System prompt: environment + custom instructions. Volatile facts
    // (approval, cwd) do NOT live here — prompt-cache invariant.
    const sys = h.provider.requests[0]?.messages.find((m) => m.role === "system")
    expect(sys?.content).toContain("Sensus agent")
    expect(sys?.content).not.toContain("approval:")
    expect(sys?.content).toContain("CUSTOM-INSTRUCTION-MARK")
    // /context off: the provider gets the bare text.
    const off = makeSession([{ kind: "stop", text: "ok" }])
    off.chat.handleInput("/context off")
    off.chat.handleInput("no context please")
    await until(() => status(off) === "idle", 8000, "idle off")
    expect(off.provider.requests[0]?.messages.find((m) => m.role === "user")?.content).toBe("no context please")
    // Alt-screen: the tail is replaced by a note naming the app.
    const home = mkdtempSync(join(tmpdir(), "sensus-chatloop-alt-"))
    const config = resolveConfig([], { HOME: home, SENSUS_HOME: home, PATH: process.env["PATH"] ?? "/usr/bin" })
    config.endpoints["main"]!.apiKey = "k"
    const file = SessionFile.create(join(home, "s.jsonl"), { endpoint: "main", model: "m" })
    const provider = new ScriptedProvider([{ kind: "stop", text: "ok" }])
    const alt = new ChatSession({
      getConfig: () => config,
      provider: () => provider,
      file: () => file,
      rotateFile: () => file,
      toast: () => {},
    })
    alt.attachTerminal(() => ({
      pane: null,
      cwd: home,
      shell: "zsh",
      currentCommand: "vim",
      alternateOn: true,
      tailLines: ["SECRET"],
    }))
    alt.handleInput("hello")
    await until(() => alt.accessors.status() === "idle", 8000, "idle alt")
    const altMsg = provider.requests[0]?.messages.find((m) => m.role === "user")
    expect(altMsg?.content).toContain("user is in alt-screen app (vim)")
    expect(altMsg?.content).not.toContain("SECRET")
    rmSync(home, { recursive: true, force: true })
  })

  test("no-tools latch: tools omitted after onNoTools, prompt switches to copy-paste mode", async () => {
    const h = makeSession([
      { kind: "stop", text: "plain answer", noTools: true },
      { kind: "stop", text: "second plain answer" },
    ])
    h.chat.handleInput("first")
    await until(() => status(h) === "idle", 8000, "idle 1")
    expect(h.chat.accessors.noTools()).toBe(true)
    h.chat.handleInput("second")
    await until(() => status(h) === "idle", 8000, "idle 2")
    expect(h.provider.requests[1]?.tools).toBeUndefined()
    const sys2 = h.provider.requests[1]?.messages.find((m) => m.role === "system")
    expect(sys2?.content).toContain("Tool use is UNAVAILABLE")
  })

  test("tool cards render in the chat layout with actions while pending", async () => {
    const h = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "git status --short" })] },
      { kind: "stop", text: "done" },
    ])
    h.chat.handleInput("check git")
    await until(() => h.chat.pendingApproval() !== null, 5000, "pending")
    const text = layoutText(messages(h), 52)
    expect(text).toContain("▸ shell_background")
    expect(text).toContain("awaiting approval")
    expect(text).toContain("[y accept]")
    expect(text).toContain("[n reject]")
    expect(text).toContain("[a allow git status*]")
    h.chat.resolveCard(h.chat.pendingApproval()!.callId, "accept")
    await until(() => status(h) === "idle", 8000, "idle")
    const after = layoutText(messages(h), 52)
    expect(after).toContain("● done")
    expect(after).toContain("git")
  })

  test("a pending card renders the FULL command, wrapped, so it is never approved unseen", async () => {
    const cmd = `cd /tmp/proj && git commit -m ${"z".repeat(90)}`
    const h = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: cmd })] },
      { kind: "stop", text: "done" },
    ])
    h.chat.handleInput("check it")
    await until(() => h.chat.pendingApproval() !== null, 5000, "pending")
    // The card data carries the untruncated detail...
    expect(h.chat.pendingApproval()?.detail).toBe(cmd)
    // ...and the layout renders every character (strip the wrap breaks).
    const text = layoutText(messages(h), 52)
    expect(text.replace(/\s/g, "")).toContain(cmd.replace(/\s/g, ""))
    h.chat.resolveCard(h.chat.pendingApproval()!.callId, "reject")
    await until(() => status(h) === "idle", 8000, "idle")
  })
})

describe("ChatSession MCP integration (M11, docs/mcp.md)", () => {
  const sysPrompt = (h: Harness, n = 0): string =>
    h.provider.requests[n]?.messages.find((m) => m.role === "system")?.content ?? ""

  interface StubMcp {
    currentSpecs(): ToolSpec[]
    ensureReady(cfg: McpConfig | undefined, signal: AbortSignal): Promise<string[]>
    call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ ok: boolean; result: string }>
    statusLines(): string[]
    connectedServerFacts(): Array<{ name: string; tools: string[] }>
    statusVersion(): number
    serverStatuses(): McpServerStatusFact[]
    calls: Array<{ name: string; args: Record<string, unknown> }>
    ensureCalls: number
  }

  const stubMcp = (result = "PONG:mcp__mock__ping", failures: string[] = []): StubMcp => {
    const spec: ToolSpec = {
      type: "function",
      function: {
        name: "mcp__mock__ping",
        description: "MCP ping",
        parameters: { type: "object", properties: { text: { type: "string" } } },
      },
    }
    const self: StubMcp = {
      calls: [],
      ensureCalls: 0,
      currentSpecs: () => [spec],
      ensureReady: async () => {
        self.ensureCalls++
        return failures
      },
      call: async (name, args) => {
        self.calls.push({ name, args })
        return { ok: true, result }
      },
      statusLines: () => ["mock: connected — 1 tool(s) (stdio: echo)"],
      connectedServerFacts: () => [{ name: "mock", tools: ["ping"] }],
      statusVersion: () => 1,
      serverStatuses: () => [{ name: "mock", status: "connected", toolCount: 1 }],
    }
    return self
  }

  const makeMcpSession = (steps: Step[], mcp: StubMcp): Harness => {
    const h = makeSession(steps)
    // Rebuild the session with the same config/file but deps.mcp wired.
    const config = h.config
    const file = h.file
    const toasts: Array<{ message: string; level: ToastLevel }> = []
    const chat = new ChatSession({
      getConfig: () => config,
      provider: () => h.provider,
      file: () => file,
      rotateFile: () => file,
      toast: (m, level = "info") => toasts.push({ message: m, level }),
      getInstructions: () => null,
      mcp,
    })
    chat.attachTerminal(() => ({
      pane: null,
      cwd: h.home,
      shell: "zsh",
      currentCommand: "zsh",
      alternateOn: false,
      tailLines: [],
    }))
    return { ...h, chat, toasts }
  }

  const toolNames = (h: Harness, n: number): Array<string | undefined> =>
    ((h.provider.requests[n]?.tools ?? []) as Array<{ function?: { name?: string } }>).map((t) => t.function?.name)

  test("MCP specs merge into the request and mcp__* executes through the registry; /mcp off removes the specs (skips ensureReady), /mcp on restores", async () => {
    // Wiring + execution.
    const mcp = stubMcp()
    const h = makeMcpSession(
      [
        { kind: "tool_calls", calls: [call("mcp__mock__ping", { text: "hi" }, "mcp1")] },
        { kind: "stop", text: "the mcp tool said PONG" },
        { kind: "stop", text: "off request" },
        { kind: "stop", text: "on request" },
      ],
      mcp,
    )
    h.chat.handleInput("/yolo") // auto-run the mcp call
    h.chat.handleInput("use the mcp tool please")
    await until(() => status(h) === "idle", 8000, "idle wiring")
    expect(mcp.ensureCalls).toBe(1) // ran exactly once before the first request
    for (const req of h.provider.requests.slice(0, 2)) {
      const names = ((req.tools ?? []) as Array<{ function?: { name?: string } }>).map((t) => t.function?.name)
      expect(names).toContain("shell_background")
      expect(names).toContain("mcp__mock__ping")
    }
    expect(mcp.calls).toEqual([{ name: "mcp__mock__ping", args: { text: "hi" } }])
    const toolMsg = h.provider.requests[1]?.messages.find((m) => m.role === "tool")
    expect(toolMsg?.content).toContain("PONG:mcp__mock__ping")
    const card = cards(h).find((m) => m.tool?.name === "mcp__mock__ping")
    expect(card?.tool?.status).toBe("done")
    expect(card?.tool?.output).toContain("PONG")
    expect(card?.tool?.paramsSummary).toContain('"text"')
    // System prompt lists the server + its tools.
    expect(sysPrompt(h, 0)).toContain("MCP servers")
    expect(sysPrompt(h, 0)).toContain("mock: 1 tool(s) (ping)")
    expect(sysPrompt(h, 0)).toContain("mcp__<server>__<tool>")
    // /mcp off: specs dropped, no new ensureReady; /mcp on: restored.
    h.chat.handleInput("/mcp off")
    h.chat.handleInput("off request")
    await until(() => h.provider.requests.length === 3 && status(h) === "idle", 8000, "idle off")
    expect(toolNames(h, 2)).not.toContain("mcp__mock__ping")
    expect(toolNames(h, 2)).toContain("shell_background")
    expect(mcp.ensureCalls).toBe(1)
    h.chat.handleInput("/mcp on")
    h.chat.handleInput("on request")
    await until(() => h.provider.requests.length === 4 && status(h) === "idle", 8000, "idle on")
    expect(toolNames(h, 3)).toContain("mcp__mock__ping")
    expect(mcp.ensureCalls).toBe(2)
  })

  test("confirm mode gates mcp__* calls (accept path)", async () => {
    const mcp = stubMcp()
    const h = makeMcpSession(
      [
        { kind: "tool_calls", calls: [call("mcp__mock__ping", {}, "mcp2")] },
        { kind: "stop", text: "done" },
      ],
      mcp,
    )
    h.chat.handleInput("gated please")
    await until(() => h.chat.pendingApproval() !== null, 5000, "mcp pending")
    expect(mcp.calls.length).toBe(0) // nothing ran yet
    h.chat.resolveCard(h.chat.pendingApproval()!.callId, "accept")
    await until(() => status(h) === "idle", 8000, "idle")
    expect(mcp.calls.length).toBe(1)
  })

  test("ensureReady failures toast + system note; /mcp renders the server list; /status carries the mcp summary", async () => {
    // Failure path: chat continues without MCP.
    const failing = stubMcp("PONG", ["srv1: timed out"])
    const f = makeMcpSession([{ kind: "stop", text: "recovered" }], failing)
    f.chat.handleInput("go")
    await until(() => status(f) === "idle", 5000, "idle failing")
    expect(f.toasts.some((t) => t.level === "warn" && t.message.startsWith("mcp: srv1: timed out"))).toBe(true)
    expect(messages(f).some((m) => m.role === "system" && m.content.includes("mcp server error"))).toBe(true)
    // Status surfaces: /mcp list + /status summary.
    const h = makeMcpSession([{ kind: "stop", text: "x" }, { kind: "stop", text: "ok" }], stubMcp())
    h.chat.handleInput("/mcp")
    await until(() => messages(h).some((m) => m.role === "system" && m.content.includes("mcp servers")), 3000, "mcp list")
    const line = messages(h).find((m) => m.role === "system" && m.content.includes("mock: connected"))
    expect(line?.content).toContain("(stdio: echo)")
    expect(line?.content).toContain("1 tool(s) merged into requests")
    h.chat.handleInput("ok")
    await until(() => status(h) === "idle", 5000, "idle")
    h.chat.handleInput("/status")
    await until(() => messages(h).some((m) => m.content.includes("runtime status")), 3000, "status")
    expect(messages(h).find((m) => m.content.includes("runtime status"))?.content).toContain("mcp: 1 server(s) connected")
    // The status-bar seam reads the same per-server facts reactively.
    expect(h.chat.mcpStatusFacts()).toEqual([{ name: "mock", status: "connected", toolCount: 1 }])
  })
})

describe("agents (docs/agents.md — copilot/autopilot definitions)", () => {
  const systemPrompt = (h: Harness, n = 0): string =>
    h.provider.requests[n]?.messages.find((m) => m.role === "system")?.content ?? ""

  test("agent resolution: defaults to copilot; a config agent seeds new sessions (built-in fallback without a dir); unknown config agents fall back to copilot", async () => {
    // Default: copilot, and the request's system prompt carries the body.
    const h = makeSession([{ kind: "stop", text: "ok" }])
    expect(h.chat.agentName()).toBe("copilot")
    h.chat.handleInput("hi")
    await until(() => status(h) === "idle", 8000, "idle")
    expect(systemPrompt(h)).toContain("Active agent: copilot")
    expect(systemPrompt(h)).toContain("operating as COPILOT")
    expect(systemPrompt(h)).toContain("Keep moving")
    expect(systemPrompt(h)).not.toContain("WAIT for acceptance")
    expect(systemPrompt(h)).not.toContain("operating as AUTOPILOT")
    // An unknown config agent falls back to the built-in copilot.
    h.config.defaultAgent = "ghost"
    expect(h.chat.agentName()).toBe("copilot")
    // Autopilot was merged into copilot: naming it as the config default now
    // resolves to the single built-in copilot.
    h.config.defaultAgent = "autopilot"
    expect(h.chat.agentName()).toBe("copilot")
  })

  test("a custom agent (loaded via getAgents) reaches the prompt and gates its tools", async () => {
    const h = makeSession([{ kind: "tool_calls", calls: [] }, { kind: "stop", text: "ok" }])
    // getAgents returns a minimal custom agent with a restricted tool list.
    const custom = {
      agents: [],
      byName: {
        scout: {
          name: "scout",
          description: "reads only",
          tools: ["read_file", "get_scrollback", "ask_user"],
          skills: null,
          sudoPrompt: "ask" as const,
          shell: "auto" as const,
          prompt: "You are SCOUT. Report, never touch.",
          path: "scout.md",
        },
      },
      warnings: [],
    }
    const chat = new ChatSession({
      getConfig: () => h.config,
      provider: () => h.provider,
      file: () => h.file,
      rotateFile: () => h.file,
      toast: () => {},
      getAgents: () => custom,
    })
    chat.attachTerminal(() => null)
    h.config.defaultAgent = "scout"
    chat.handleInput("hi")
    await until(() => chat.accessors.status() === "idle", 8000, "idle")
    const req = h.provider.requests[0]
    expect(req).toBeDefined()
    const sys = req?.messages.find((m) => m.role === "system")
    expect(sys?.content).toContain("Active agent: scout")
    expect(sys?.content).toContain("You are SCOUT")
    // The tools list is the AGENT'S subset — shell tools are filtered out.
    const names = ((req?.tools as Array<{ function: { name: string } }> | undefined) ?? []).map((t) => t.function.name)
    expect(names).toContain("read_file")
    expect(names).toContain("get_scrollback")
    expect(names).toContain("ask_user")
    expect(names).not.toContain("shell_background")
    expect(names).not.toContain("shell_session")
  })

  test("a readonly agent hard-denies mutations and drops mutating tools, even with tools:[\"*\"]", async () => {
    const h = makeSession([{ kind: "stop", text: "ok" }])
    const custom = {
      agents: [],
      byName: {
        scout: {
          name: "scout",
          description: "read-only",
          tools: null, // "*": the guard, not the list, is the enforcement
          skills: null,
          sudoPrompt: "ask" as const,
          shell: "background" as const,
          readonly: true,
          prompt: "You are SCOUT.",
          path: "scout.md",
        },
      },
      warnings: [],
    }
    const chat = new ChatSession({
      getConfig: () => h.config,
      provider: () => h.provider,
      file: () => h.file,
      rotateFile: () => h.file,
      toast: () => {},
      getAgents: () => custom,
    })
    chat.attachTerminal(() => null)
    h.config.defaultAgent = "scout"
    const gate = (name: string, args: Record<string, unknown>): { gate: boolean; action?: string; denySource?: string } =>
      (
        chat as unknown as {
          gateDecision: (
            c: { name: string; arguments: string; id: string },
            a: Record<string, unknown>,
          ) => { gate: boolean; action?: string; denySource?: string }
        }
      ).gateDecision({ name, arguments: JSON.stringify(args), id: "c1" }, args)

    // Mutating tools and pane input: terminal guard denies.
    for (const [name, args] of [
      ["edit_file", { path: "/tmp/x", old_string: "a", new_string: "b" }],
      ["write_file", { path: "/tmp/x", content: "y" }],
      ["memory", { action: "add", content: "x" }],
      ["shell_session", { text: "ls" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const d = gate(name, args)
      expect({ name, action: d.action, source: d.denySource }).toEqual({ name, action: "deny", source: "guard" })
    }
    // A mutating shell command is denied; a read-only one still passes the guard.
    expect(gate("shell_background", { command: "ls -la > /tmp/x" })).toMatchObject({ action: "deny", denySource: "guard" })
    expect(gate("shell_background", { command: "git status" }).action).toBeUndefined()
    expect(gate("read_file", { path: "/tmp/x" }).action).toBeUndefined()

    // The request tool list drops the mutating tools the guard would deny.
    chat.handleInput("hi")
    await until(() => chat.accessors.status() === "idle", 8000, "idle")
    const req = h.provider.requests[0]
    const names = ((req?.tools as Array<{ function: { name: string } }> | undefined) ?? []).map((t) => t.function.name)
    for (const n of ["edit_file", "write_file", "memory", "shell_session"]) expect(names).not.toContain(n)
    expect(names).toContain("read_file")
    expect(names).toContain("shell_background")
  })

  test("selection is PER-SESSION: model/agent picks don't leak between sessions; /agent persists via deps with toasts (unknown errors)", () => {
    const h = makeSession([{ kind: "stop", text: "ok" }, { kind: "stop", text: "ok2" }])
    const chat2 = new ChatSession({
      getConfig: () => h.config,
      provider: () => h.provider,
      file: () => h.file,
      rotateFile: () => h.file,
      toast: () => {},
    })
    // Model picks: setModelSelection only touches the picking session.
    h.config.endpoints["alt"] = {
      name: "alt",
      baseURL: "http://alt.local/v1",
      apiKey: "k",
      temperature: 1.0,
      maxTokens: 8192,
      provider: "openai-compatible",
      models: {},
    }
    const persisted: string[] = []
    const pick = new ChatSession({
      getConfig: () => h.config,
      provider: () => h.provider,
      file: () => h.file,
      rotateFile: () => h.file,
      toast: () => {},
      setSelectedModel: (endpoint, model) => {
        persisted.push(`${endpoint}@${model}`)
        return null
      },
    })
    pick.setModelSelection("alt", "alt-model")
    expect(persisted).toEqual([])
    expect(pick.selectedModel()).toBe("alt@alt-model")
    expect(pick.endpointName()).toBe("alt")
    expect(pick.modelName()).toBe("alt-model")
    expect(h.chat.selectedModel()).toBe(h.config.model)
    expect(h.chat.endpointName()).toBe("main")
    expect(chat2.selectedModel()).toBe(h.config.model)
    // A config-default change (another tab's pick, a settings write, /reload)
    // persists for NEW sessions but must NOT yank an already-open one: every
    // session latched the default when it was created.
    const previousDefault = h.config.model
    h.config.model = "alt@alt-model"
    expect(h.chat.selectedModel()).toBe(previousDefault)
    expect(h.chat.endpointName()).toBe("main")
    expect(chat2.selectedModel()).toBe(previousDefault)
    const fresh = new ChatSession({
      getConfig: () => h.config,
      provider: () => h.provider,
      file: () => h.file,
      rotateFile: () => h.file,
      toast: () => {},
    })
    expect(fresh.selectedModel()).toBe("alt@alt-model")
    expect(fresh.endpointName()).toBe("alt")
    expect(fresh.modelName()).toBe("alt-model")
    // Agent picks are per-session too (an unpicked session follows the live
    // config default, unlike the latched model — docs/agents.md).
    const agentPick = new ChatSession({
      getConfig: () => h.config,
      provider: () => h.provider,
      file: () => h.file,
      rotateFile: () => h.file,
      toast: () => {},
      getAgents: () => ({
        agents: [],
        byName: {
          copilot: { name: "copilot", description: "", tools: null, skills: null, sudoPrompt: "ask", shell: "auto", prompt: "", path: "copilot.md" },
          autopilot: { name: "autopilot", description: "", tools: null, skills: null, sudoPrompt: "popup", shell: "auto", prompt: "", path: "autopilot.md" },
        },
        warnings: [],
      }),
    })
    agentPick.setAgentSelection("autopilot")
    expect(agentPick.agentName()).toBe("autopilot")
    expect(h.chat.agentName()).toBe("copilot")
    expect(chat2.agentName()).toBe("copilot")
    // /agent switches through the setDefaultAgent dep, toasts, and rejects
    // unknown names without switching. (Mutates the shared config default,
    // hence last.)
    const picks: string[] = []
    const switcher = new ChatSession({
      getConfig: () => h.config,
      provider: () => h.provider,
      file: () => h.file,
      rotateFile: () => h.file,
      toast: (m, level = "info") => h.toasts.push({ message: m, level: level as ToastLevel }),
      getAgents: () => ({
        agents: [],
        byName: {
          copilot: { name: "copilot", description: "", tools: null, skills: null, sudoPrompt: "ask", shell: "auto", prompt: "", path: "copilot.md" },
          autopilot: { name: "autopilot", description: "", tools: null, skills: null, sudoPrompt: "popup", shell: "auto", prompt: "", path: "autopilot.md" },
        },
        warnings: [],
      }),
      setDefaultAgent: (name) => {
        picks.push(name)
        h.config.defaultAgent = name
        return null
      },
    })
    switcher.handleInput("/agent autopilot")
    expect(picks).toEqual(["autopilot"])
    expect(h.config.defaultAgent).toBe("autopilot")
    expect(switcher.agentName()).toBe("autopilot")
    const note = h.toasts.findLast((t) => t.message.includes("agent → autopilot"))
    expect(note?.level).toBe("success")
    switcher.handleInput("/agent nope")
    expect(picks).toEqual(["autopilot"])
    expect(h.toasts.findLast((t) => t.message.includes("unknown agent"))?.level).toBe("error")
  })

  test("setApproval (status-bar chip / Alt+Y path) switches + toasts like /yolo", () => {
    const h = makeSession([])
    h.chat.setApproval("full-auto")
    expect(h.chat.accessors.approval()).toBe("full-auto")
    h.chat.setApproval("confirm")
    expect(h.chat.accessors.approval()).toBe("confirm")
    const notes = h.toasts.filter((t) => t.message.includes("approval →"))
    expect(notes.length).toBe(2)
    expect(notes[0]?.level).toBe("info")
    // Toasted, not transcribed.
    expect(messages(h).some((m) => m.role === "system" && m.content.includes("approval →"))).toBe(false)
  })
})

describe("context management (docs/agent.md compaction)", () => {
  const lastUser = (req: StreamRequest): string => {
    const users = req.messages.filter((m) => m.role === "user")
    return users.at(-1)?.content ?? ""
  }

  test("context is durable: each generation appends its own context message, earlier requests stay byte-identical, unchanged tails collapse, contextUsed tracks the last prompt", async () => {
    const h = makeSession([{ kind: "stop", text: "one" }, { kind: "stop", text: "two" }])
    expect(h.chat.accessors.contextUsed()).toBe(0)
    h.chat.handleInput("hi there")
    await until(() => status(h) === "idle", 8000, "idle 1")
    const req0 = h.provider.requests[0]!
    const users0 = req0.messages.filter((m) => m.role === "user")
    expect(users0[0]?.content.startsWith("[terminal] cwd:")).toBe(true)
    expect(users0.at(-1)?.content).toBe("hi there")
    expect(users0[0]?.content).toContain("PANE-TAIL-1") // first look: full tail
    expect(users0[0]?.content).not.toContain("unchanged")
    expect(h.chat.accessors.contextUsed()).toBe(USAGE.promptTokens)
    h.chat.handleInput("second message")
    await until(() => h.provider.requests.length === 2 && status(h) === "idle", 8000, "idle 2")
    // Prompt-cache invariant: gen 1's messages are a byte-identical PREFIX of
    // gen 2's request — nothing is ever re-derived or rewritten.
    const req1 = h.provider.requests[1]!
    expect(req1.messages.slice(0, req0.messages.length)).toEqual(req0.messages)
    const users1 = req1.messages.filter((m) => m.role === "user")
    expect(users1.at(-1)?.content).toBe("second message")
    // The identical tail collapses to an "unchanged" note in the NEW block.
    const freshCtx = users1.at(-2)
    expect(freshCtx?.content).toContain("unchanged (3 lines since your last look)")
    expect(freshCtx?.content).not.toContain("PANE-TAIL-1")
  })

  test("tool results are capped at the boundary: the live loop and later generations all see the same bytes (append-only)", async () => {
    const h = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "seq 1 20000" })] },
      { kind: "stop", text: "gen1 done" },
      { kind: "stop", text: "gen2 done" },
    ])
    h.chat.handleInput("/yolo")
    h.chat.handleInput("generate")
    await until(() => status(h) === "idle", 8000, "idle 1")
    // Capped at the tool boundary: the FIRST request carrying the result sees
    // the ~2k-line (~12k char) tail, not a 2k write-time clip.
    const liveTool = h.provider.requests[1]?.messages.find((m) => m.role === "tool")
    const liveLen = (liveTool?.content ?? "").length
    expect(liveLen).toBeGreaterThan(1000)
    expect(liveLen).toBeLessThan(13_000)
    expect(liveTool?.content).toContain("truncated")
    h.chat.handleInput("next")
    await until(() => h.provider.requests.length === 3 && status(h) === "idle", 8000, "idle 2")
    // Gen 2's request: the old tool output is IDENTICAL — no retro rewrite.
    const oldTool = h.provider.requests[2]?.messages.find((m) => m.role === "tool")
    expect(oldTool?.content).toBe(liveTool?.content)
  })

  test("compaction.prune: an enabled pass clears old tool outputs, records an audit entry + toast, and resets the estimate; disabled is a no-op", async () => {
    // 50000 chars -> ~12500 tokens each. Six results exceed the 40k protected
    // window after the newest four, so the two oldest are reclaimable
    // (~25k tokens >= the 20k minimum). Each command is DISTINCT (a trailing
    // comment) so the doom-loop guard does not block the 4th+ identical call.
    const CMD = "head -c 50000 /dev/zero | tr '\\000' 'X'"
    const six = Array.from({ length: 6 }, (_, i) => ({
      kind: "tool_calls" as const,
      calls: [call("shell_background", { command: `${CMD} #${i}` }, `prune_${i}`)],
    }))
    const buildSteps = (): Step[] => [...six, { kind: "stop", text: "gen1 done" }, { kind: "stop", text: "gen2 done" }]
    const CLEARED = "[Old tool result content cleared]"
    const audited: AuditEntry[] = []
    const audit: AuditBridge = {
      record: (e) => audited.push({ ...e, session: "s" }),
      lastUndoable: () => null,
      markUndone: () => {},
      recent: (n = 20) => audited.slice(Math.max(0, audited.length - n)),
    }

    const h = makeSession(buildSteps(), { audit })
    h.config.compaction.prune = true
    h.chat.handleInput("/yolo")
    h.chat.handleInput("first")
    await until(() => status(h) === "idle" && h.provider.requests.length >= 7, 20000, "gen1")
    // The live generation never prunes (generation start only): all six results
    // are intact in gen1's final request.
    const gen1Tools = h.provider.requests.at(-1)!.messages.filter((m) => m.role === "tool")
    expect(gen1Tools.length).toBe(6)
    expect(gen1Tools.every((m) => m.content !== CLEARED)).toBe(true)

    h.chat.handleInput("second")
    await until(() => status(h) === "idle" && h.provider.requests.length >= 8, 20000, "gen2")
    const gen2Tools = h.provider.requests.at(-1)!.messages.filter((m) => m.role === "tool")
    expect(gen2Tools.length).toBe(6)
    const cleared = gen2Tools.filter((m) => m.content === CLEARED)
    expect(cleared.length).toBe(2)
    // role/toolCallId/toolName survive the rewrite.
    expect(cleared[0]?.toolName).toBe("shell_background")
    expect(typeof cleared[0]?.toolCallId).toBe("string")
    // Never silent: an audit entry + a toast record the cache-invalidating pass.
    expect(
      audited.some((e) => e.kind === "other" && e.tool === "prune" && e.summary.includes("pruned 2 tool output(s)")),
    ).toBe(true)
    expect(h.toasts.some((t) => t.message.includes("pruned 2 old tool output(s)"))).toBe(true)

    // Disabled (the default): the identical script leaves the bytes untouched.
    const off = makeSession(buildSteps())
    off.chat.handleInput("/yolo")
    off.chat.handleInput("first")
    await until(() => status(off) === "idle" && off.provider.requests.length >= 7, 20000, "off gen1")
    off.chat.handleInput("second")
    await until(() => status(off) === "idle" && off.provider.requests.length >= 8, 20000, "off gen2")
    const offTools = off.provider.requests.at(-1)!.messages.filter((m) => m.role === "tool")
    expect(offTools.some((m) => m.content === CLEARED)).toBe(false)
  }, 60000)

  test("compaction triggers: preflight folds history into a checkpoint near the limit; provider overflow compacts once and retries the same step", async () => {
    // Preflight: a big first reply so the 50-token tail cannot cover history.
    const h = makeSession([
      { kind: "stop", text: "r".repeat(4000) },
      { kind: "summary", text: "## Objective\nfinish the work\n## Next steps\nship it" },
      { kind: "stop", text: "second reply" },
    ])
    h.config.context.contextLimit = 6000
    // Pin the output cap so the reserve is deterministic (auto would resolve the
    // model's advertised limit — cache-dependent in tests).
    h.config.endpoints["main"]!.maxTokens = 8192
    h.config.context.bufferTokens = 0 // reserve = maxTokens(8192) -> always compact when eligible
    h.config.context.autoCompact = true
    h.config.context.keepTokens = 50
    // Gen1 turn1: single small message -> ineligible, no compaction.
    h.chat.handleInput("first message")
    await until(() => status(h) === "idle", 8000, "idle 1")
    expect(h.chat.accessors.compactions()).toBe(0)
    // Gen2: the preflight estimate crosses the (tiny) limit -> compact first.
    h.chat.handleInput("second message")
    await until(() => status(h) === "idle", 10000, "idle 2")
    // requests: [gen1, summary, gen2]
    expect(h.provider.requests.length).toBe(3)
    const sumReq = h.provider.requests[1]!
    expect(sumReq.messages[0]?.role).toBe("system")
    expect(sumReq.messages[1]?.content).toContain("[user]")
    expect(sumReq.messages[1]?.content).toContain("first message")
    expect(sumReq.messages[1]?.content).toContain("## Next steps")
    expect(sumReq.tools).toBeUndefined()
    // gen2's request is built on the CHECKPOINT + retained tail; the fresh
    // terminal block rides in its own message ahead of the user text.
    // gen2's request: compaction ran BEFORE the fresh context message was
    // appended, so the rewrite kept the retained tail, then the new block +
    // user text landed after it (append-only tail).
    const req2 = h.provider.requests[2]!
    expect(req2.messages[1]?.content.startsWith("<conversation-checkpoint>")).toBe(true)
    expect(req2.messages[2]?.content).toBe("r".repeat(4000)) // retained newest tail message
    expect(req2.messages[3]?.content.startsWith("[terminal] cwd:")).toBe(true)
    expect(req2.messages[3]?.content).toContain("[agent] approval: confirm")
    expect(req2.messages[4]?.content).toBe("second message")
    expect(h.chat.accessors.compactions()).toBe(1)
    expect(messages(h).some((m) => m.role === "system" && m.content.includes("context compacted"))).toBe(true)
    expect(readFileSync(h.file.filePath, "utf8")).toContain('"type":"compaction"')
    expect(readFileSync(h.file.filePath, "utf8")).toContain("conversation-checkpoint")
    // Overflow: a provider 400 about context compacts ONCE and retries the
    // same step — no error bubble, the recovered reply lands.
    const o = makeSession([
      { kind: "stop", text: "r".repeat(4000) },
      { kind: "error", error: "HTTP 400: This model's maximum context length is 8192 tokens, request has 9500" },
      { kind: "summary", text: "## Objective\nrecover the work\n## Next steps\ncontinue" },
      { kind: "stop", text: "recovered reply" },
    ])
    o.config.context.keepTokens = 50
    o.chat.handleInput("first message")
    await until(() => status(o) === "idle", 8000, "idle overflow 1")
    o.chat.handleInput("second message")
    await until(() => status(o) === "idle", 10000, "idle overflow 2")
    // requests: [gen1, gen2(ERROR), summary, gen2-retry]
    expect(o.provider.requests.length).toBe(4)
    const sum = o.provider.requests[2]!
    expect(sum.messages[1]?.content).toContain("[user]")
    const retry = o.provider.requests[3]!
    expect(retry.messages[1]?.content.startsWith("<conversation-checkpoint>")).toBe(true)
    expect(messages(o).some((m) => m.role === "error" && m.content.includes("reply failed"))).toBe(false)
    expect(messages(o).find((m) => m.role === "assistant" && m.content.includes("recovered reply"))).toBeDefined()
  }, 20000)

  test("/compact runs manually (empty session just toasts) and the stored checkpoint resumes cleanly", async () => {
    const h = makeSession([
      { kind: "stop", text: "r".repeat(4000) },
      { kind: "summary", text: "## Objective\nmanual run\n## Next steps\ndone" },
      { kind: "stop", text: "after compact" },
      { kind: "stop", text: "ok" },
    ])
    // Empty session: just a toast, no provider request.
    const empty = makeSession([])
    empty.chat.handleInput("/compact")
    await until(() => empty.toasts.length > 0, 2000, "empty toast")
    expect(empty.toasts[0]?.message).toContain("nothing to compact")
    expect(empty.provider.requests.length).toBe(0)
    // Manual run.
    h.config.context.keepTokens = 50
    h.chat.handleInput("first message")
    await until(() => status(h) === "idle", 8000, "idle 1")
    h.chat.handleInput("/compact")
    await until(() => h.provider.requests.length === 2, 8000, "summary request")
    await until(() => status(h) === "idle" && h.chat.accessors.compactions() === 1, 8000, "compaction done")
    expect(h.provider.requests[1]?.tools).toBeUndefined() // no tools on the summary request
    expect(messages(h).some((m) => m.role === "system" && m.content.includes("context compacted"))).toBe(true)
    expect(h.toasts.some((t) => t.message.includes("compacted"))).toBe(true)
    // History starts with the checkpoint; the next message works normally.
    h.chat.handleInput("next message")
    await until(() => status(h) === "idle", 8000, "idle 2")
    expect(h.provider.requests[2]?.messages[1]?.content.startsWith("<conversation-checkpoint>")).toBe(true)
    // Reload the file like a --resume boot and restore a fresh session.
    const loaded = loadSessionFile(h.file.filePath)
    expect(loaded.checkpoint).not.toBeNull()
    expect(loaded.checkpoint!.startsWith("<conversation-checkpoint>")).toBe(true)
    expect(loaded.checkpointIndex).toBe(2) // user + assistant recorded before the compaction
    const provider2 = new ScriptedProvider([{ kind: "stop", text: "ok" }])
    const restored = new ChatSession({
      getConfig: () => h.config,
      provider: () => provider2,
      file: () => h.file,
      rotateFile: () => h.file,
      toast: () => {},
    })
    restored.attachTerminal(() => ({
      pane: null,
      cwd: h.home,
      shell: "zsh",
      currentCommand: "zsh",
      alternateOn: false,
      tailLines: ["RESUMED-TAIL"],
    }))
    restored.restore(recordsToMessages(loaded.messages), {
      checkpoint: loaded.checkpoint,
      checkpointIndex: loaded.checkpointIndex,
    })
    restored.handleInput("after resume")
    await until(() => restored.accessors.status() === "idle", 8000, "idle 3")
    // The resumed session's first provider message is the CHECKPOINT; only
    // post-checkpoint records are replayed; the fresh terminal block rides in
    // its own message ahead of the new user text.
    const req = provider2.requests[0]!
    expect(req.messages[1]?.content.startsWith("<conversation-checkpoint>")).toBe(true)
    expect(req.messages.some((m) => m.role === "user" && m.content === "next message")).toBe(true)
    expect(req.messages.some((m) => m.content.includes("first message"))).toBe(false)
    const resumedUsers = req.messages.filter((m) => m.role === "user")
    expect(resumedUsers.at(-1)?.content).toBe("after resume")
    expect(resumedUsers.at(-2)?.content.startsWith("[terminal] cwd:")).toBe(true)
  }, 25000)

  test("resume reconstructs persisted tool calls for the Context inspector (display), invalidated by /clear", () => {
    const h = makeSession([{ kind: "stop", text: "fresh" }])
    // A saved transcript with a dropped assistant bubble (reasoning only) that
    // carried two tool calls, then a final answer — the shape --resume loads.
    const path = join(h.home, "sessions", "inst", "resume.jsonl")
    const lines = [
      { ts: 1, type: "session_start", sensus: "sensus", endpoint: "main", model: "test-model" },
      { ts: 2, type: "user_message", content: "clean /tmp" },
      { ts: 3, type: "assistant_message", content: "", thinking: "reasoning", model: "test-model", usage: null, aborted: false },
      { ts: 4, type: "tool_call", callId: "c1", name: "run_command", paramsSummary: "du -sh /tmp", status: "done", output: null, exitCode: 0 },
      { ts: 5, type: "tool_call", callId: "c2", name: "run_command", paramsSummary: "rm -rf x", status: "done", output: null, exitCode: 0 },
      { ts: 6, type: "assistant_message", content: "Done.", model: "test-model", usage: { promptTokens: 1234, completionTokens: 10, totalTokens: 1244, cachedTokens: 1000 }, aborted: false },
    ]
    mkdirSync(join(h.home, "sessions", "inst"), { recursive: true })
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
    const loaded = loadSessionFile(path)
    h.chat.restore(recordsToMessages(loaded.messages), {
      checkpoint: loaded.checkpoint,
      checkpointIndex: loaded.checkpointIndex,
      history: reconstructHistoryEntries(loaded),
    })
    const bd = h.chat.contextBreakdown()
    // The inspector shows the tool-call turn even though the model resumes
    // text-only (v1); the row count/tokens include the persisted calls.
    expect(bd.history.map((e) => e.preview)).toEqual(["clean /tmp", "→ run_command ×2", "Done."])
    expect(bd.messages).toBe(3)
    expect(bd.history.find((e) => e.preview.includes("→ run_command"))?.tokens).toBeGreaterThan(4)
    expect(bd.historyTokens).toBe(bd.history.reduce((s, e) => s + e.tokens, 0))
    // The display sums the reconstructed decomposition (not the tiny text-only
    // anchored request), so a resumed tab no longer reads as ~0%.
    expect(bd.used).toBeGreaterThan(bd.historyTokens)
    expect(bd.note).toContain("resumed from a saved transcript")
    // The status bar's last-response figures are seeded from the transcript.
    expect(h.chat.accessors.contextUsed()).toBe(1234)
    // /clear drops the reconstruction: the inspector reverts to the live history.
    h.chat.clearAll()
    const cleared = h.chat.contextBreakdown()
    expect(cleared.history).toHaveLength(0)
    expect(cleared.note).toContain("empty context")
  })

  test("resume replays persisted tool results + raw args into the provider history", async () => {
    const h = makeSession([{ kind: "stop", text: "ok" }])
    const path = h.file.filePath
    mkdirSync(join(h.home, "sessions", "inst"), { recursive: true })
    const lines = [
      { ts: 1, type: "session_start", sensus: "sensus", endpoint: "main", model: "test-model" },
      { ts: 2, type: "user_message", content: "clean /tmp" },
      // The pre-tool assistant bubble was dropped (empty text), so its calls
      // attach to the user record.
      { ts: 3, type: "assistant_message", content: "", model: "test-model", usage: null, aborted: false },
      {
        ts: 4,
        type: "tool_call",
        callId: "c1",
        name: "shell_background",
        paramsSummary: "du -sh /tmp",
        status: "done",
        output: "preview…",
        exitCode: 0,
        arguments: '{"command":"du -sh /tmp"}',
        result: "14G\t/tmp\nsome longer boundary-capped output",
      },
      { ts: 5, type: "assistant_message", content: "Done.", model: "test-model", usage: null, aborted: false },
    ]
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")

    const loaded = loadSessionFile(path)
    h.chat.restore(recordsToMessages(loaded.messages), {
      checkpoint: loaded.checkpoint,
      checkpointIndex: loaded.checkpointIndex,
      history: reconstructHistoryEntries(loaded),
    })
    h.chat.handleInput("after resume")
    await until(() => status(h) === "idle", 8000, "idle replay")
    const sent = h.provider.requests[0]!.messages
    // The assistant turn carries the replayed tool call (raw args), followed
    // immediately by the persisted boundary-capped result.
    const callMsg = sent.find((m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0)
    expect(callMsg?.toolCalls?.[0]).toEqual({
      id: "c1",
      name: "shell_background",
      arguments: '{"command":"du -sh /tmp"}',
    })
    const callIdx = sent.indexOf(callMsg!)
    expect(sent[callIdx + 1]).toEqual({
      role: "tool",
      toolCallId: "c1",
      toolName: "shell_background",
      content: "14G\t/tmp\nsome longer boundary-capped output",
    })
  })

  test("resume replays old transcripts without tool result fields as plain text (forward compat)", async () => {
    const h = makeSession([{ kind: "stop", text: "ok" }])
    const path = h.file.filePath
    mkdirSync(join(h.home, "sessions", "inst"), { recursive: true })
    const lines = [
      { ts: 1, type: "user_message", content: "old question" },
      { ts: 2, type: "tool_call", callId: "c9", name: "read_file", paramsSummary: "/tmp/x", status: "done", output: null, exitCode: null },
      { ts: 3, type: "assistant_message", content: "old answer", model: "test-model", usage: null, aborted: false },
    ]
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
    const loaded = loadSessionFile(path)
    h.chat.restore(recordsToMessages(loaded.messages), { checkpoint: null, checkpointIndex: 0 })
    h.chat.handleInput("after")
    await until(() => status(h) === "idle", 8000, "idle legacy")
    const sent = h.provider.requests[0]!.messages
    expect(sent.some((m) => m.role === "tool")).toBe(false)
    expect(sent.some((m) => m.role === "assistant" && m.content === "old answer")).toBe(true)
  })

  test("contextBreakdown() is a plain serializable snapshot from the existing estimators + live signals; empty/disabled degrade with a note", async () => {
    const h = makeSession([{ kind: "stop", text: "the answer" }])
    h.config.context.contextLimit = 0
    h.chat.handleInput("what is in context?")
    await until(() => status(h) === "idle", 8000, "idle")
    const bd = h.chat.contextBreakdown()
    // Snapshot identity: plain JSON survives a round-trip (the inspector can
    // render it without touching the session again).
    expect(JSON.parse(JSON.stringify(bd))).toEqual(bd)
    expect(bd.enabled).toBe(true)
    expect(bd.note).toBeNull()
    expect(bd.model).toBe(h.chat.selectedModel())
    expect(bd.limit).toBeGreaterThan(0)
    // Durable history: context block + user text + assistant reply.
    expect(bd.messages).toBe(3)
    expect(bd.history).toHaveLength(3)
    expect(bd.history[0]?.role).toBe("user")
    expect(bd.history[0]?.preview).toContain("[terminal]")
    expect(bd.history.at(-1)?.role).toBe("assistant")
    // Decomposition mirrors the existing estimators.
    expect(bd.systemTokens).toBeGreaterThan(0)
    expect(bd.historyTokens).toBeGreaterThan(0)
    expect(bd.toolSpecTokens).toBe(TOOL_SPEC_TOKENS)
    // The real spec set is far larger than the old 1500 placeholder.
    expect(bd.toolSpecTokens).toBeGreaterThan(1500)
    expect(bd.mcpSpecTokens).toBe(0)
    expect(bd.used).toBeGreaterThan(0)
    expect(bd.percent).toBeGreaterThanOrEqual(0)
    expect(bd.compactions).toBe(0)
    // The scripted usage reports no cached tokens -> cache rows stay empty.
    expect(bd.cachePrompt).toBe(0)
    expect(bd.cacheRead).toBe(0)
    expect(bd.cacheWrite).toBe(0)

    // Empty session: no crash, a helpful note, no history rows.
    const fresh = makeSession([])
    const empty = fresh.chat.contextBreakdown()
    expect(empty.messages).toBe(0)
    expect(empty.history).toEqual([])
    expect(empty.note).toContain("empty context")

    // Disabled session (no key): occupancy is zeroed and the note explains why.
    h.config.endpoints["main"]!.apiKey = ""
    const disabled = h.chat.contextBreakdown()
    expect(disabled.enabled).toBe(false)
    expect(disabled.used).toBe(0)
    expect(disabled.percent).toBe(0)
    expect(disabled.pinned).toBe(false)
    expect(disabled.note).toContain("no API key")
  })

  test("contextBreakdown(): history rows show tool calls instead of (empty); per-row tokens include tool overhead", async () => {
    const h = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "echo CTX-TOOL" })] },
      { kind: "stop", text: "done" },
    ])
    h.chat.handleInput("/yolo")
    h.chat.handleInput("run it")
    await until(() => status(h) === "idle", 8000, "idle after tool ctx")
    const bd = h.chat.contextBreakdown()
    // The assistant tool-call turn is labeled by its tool, not "(empty)".
    const callEntry = bd.history.find((e) => e.role === "assistant" && e.preview.includes("→ shell_background"))
    expect(callEntry).toBeDefined()
    expect(callEntry?.tokens).toBeGreaterThan(4)
    expect(bd.history.some((e) => e.preview === "(empty)")).toBe(false)
    // The tool result stays its own row with real content.
    expect(bd.history.some((e) => e.role === "tool" && e.preview.length > 0)).toBe(true)
    // Every row's per-entry estimate sums to the header's history total.
    expect(bd.history.reduce((s, e) => s + e.tokens, 0)).toBe(bd.historyTokens)
  })

  test("contextLimit(): explicit setting > models.dev metadata > 128k; a catalog bump replaces a pre-fetch fallback", () => {
    const prevCache = process.env["SENSUS_CACHE_DIR"]
    const cacheDir = mkdtempSync(join(tmpdir(), "sensus-chat-modelsdev-"))
    process.env["SENSUS_CACHE_DIR"] = cacheDir
    try {
      let version = 0
      const h = makeSession([], { catalogVersion: () => version })
      // No models.dev cache yet -> the 128k fallback.
      expect(h.chat.contextLimit()).toBe(128_000)
      // The boot prefetch lands: cache written + catalog version bumped.
      writeFileSync(
        join(cacheDir, "models-dev.json"),
        JSON.stringify({
          fetchedAt: Date.now(),
          providers: {
            mock: { models: { "gpt-5": { name: "GPT-5", limit: { context: 262_144, output: 128_000 }, tool_call: true } } },
          },
        }),
      )
      version++
      expect(h.chat.contextLimit()).toBe(262_144)
      // An explicit settings value wins over metadata; 0 = auto again.
      h.config.context.contextLimit = 300_000
      expect(h.chat.contextLimit()).toBe(300_000)
      h.config.context.contextLimit = 0
      expect(h.chat.contextLimit()).toBe(262_144)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
      if (prevCache === undefined) delete process.env["SENSUS_CACHE_DIR"]
      else process.env["SENSUS_CACHE_DIR"] = prevCache
    }
  })

  test("gpt-5-shaped limit (context 400k, input 272k): the input cap is the effective ceiling and preflight fires at input - reserve", async () => {
    const prevCache = process.env["SENSUS_CACHE_DIR"]
    const configure = (h: Harness): void => {
      // The config-per-model override machinery injects the gpt-5 shape that
      // models.dev reports (context 400k, input 272k).
      h.config.endpoints["main"]!.models[h.chat.modelName()] = {
        contextLimit: 400_000,
        inputLimit: 272_000,
        reasoning: null,
        reasoningEfforts: null,
        reasoningBudgetMin: null,
        reasoningBudgetMax: null,
        toolCall: null,
        temperatureSupported: null,
        vision: null,
      }
      // Pin the output cap so the reserve is deterministic: min(128k, 32k) = 32k.
      h.config.endpoints["main"]!.maxTokens = 128_000
      h.config.context.bufferTokens = 0
      h.config.context.keepTokens = 50
      h.config.context.autoCompact = true
    }
    const steps = (): Step[] => [
      { kind: "stop", text: "first reply" },
      { kind: "summary", text: "## Objective\ncontinue the work\n## Next steps\nship it" },
      { kind: "stop", text: "second reply" },
    ]
    const h = makeSession(steps(), { usage: { promptTokens: 260_000, completionTokens: 5, totalTokens: 260_005 } })
    const below = makeSession(steps(), { usage: { promptTokens: 230_000, completionTokens: 5, totalTokens: 230_005 } })
    process.env["SENSUS_CACHE_DIR"] = join(h.home, "cache")
    try {
      configure(h)
      // The API's 272k input ceiling, not the 400k context window.
      expect(h.chat.contextLimit()).toBe(272_000)
      h.chat.handleInput("first message")
      await until(() => status(h) === "idle", 8000, "idle 1")
      expect(h.chat.accessors.compactions()).toBe(0)
      // The anchor (~260k) is past 272k - 32k = 240k but FAR below the old
      // context-only threshold (400k - 32k = 368k): the input cap must fire.
      h.chat.handleInput("second message")
      await until(() => status(h) === "idle", 10000, "idle 2")
      expect(h.chat.accessors.compactions()).toBe(1)
      expect(h.provider.requests.length).toBe(3) // gen1, summary, gen2
      expect(h.provider.requests[1]?.messages[1]?.content).toContain("## Next steps")
      expect(h.chat.contextLimit()).toBe(272_000)
      // Below the input-relative threshold (~230k < 240k): no compaction.
      configure(below)
      expect(below.chat.contextLimit()).toBe(272_000)
      below.chat.handleInput("first message")
      await until(() => status(below) === "idle", 8000, "below idle 1")
      below.chat.handleInput("second message")
      await until(() => status(below) === "idle", 8000, "below idle 2")
      expect(below.chat.accessors.compactions()).toBe(0)
      expect(below.provider.requests.length).toBe(2)
    } finally {
      if (prevCache === undefined) delete process.env["SENSUS_CACHE_DIR"]
      else process.env["SENSUS_CACHE_DIR"] = prevCache
    }
  })

  test("maxTokens: auto sends the model's advertised output; explicit wins; unknown omits the field", async () => {
    const prevCache = process.env["SENSUS_CACHE_DIR"]
    const cacheDir = mkdtempSync(join(tmpdir(), "sensus-chat-output-"))
    process.env["SENSUS_CACHE_DIR"] = cacheDir
    try {
      let version = 0
      const h = makeSession([{ kind: "stop", text: "one" }, { kind: "stop", text: "two" }], { catalogVersion: () => version })
      // The endpoint default has no maxTokens -> auto; unknown model -> omitted.
      expect(h.config.endpoints["main"]!.maxTokens).toBeUndefined()
      h.chat.handleInput("hi")
      await until(() => status(h) === "idle", 8000, "idle 1")
      expect(h.provider.requests[0]?.maxTokens).toBeUndefined()
      // The model's advertised output limit arrives -> auto resolves to it.
      writeFileSync(
        join(cacheDir, "models-dev.json"),
        JSON.stringify({
          fetchedAt: Date.now(),
          providers: { mock: { models: { "gpt-5": { limit: { context: 262_144, output: 64_000 } } } } },
        }),
      )
      version++ // the boot prefetch landed: the metadata memo re-reads
      h.chat.handleInput("again")
      await until(() => status(h) === "idle", 8000, "idle 2")
      expect(h.provider.requests[1]?.maxTokens).toBe(64_000)
      // An explicit endpoint value always wins over the metadata.
      h.config.endpoints["main"]!.maxTokens = 8192
      expect(h.chat.outputTokensForRequest()).toBe(8192)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
      if (prevCache === undefined) delete process.env["SENSUS_CACHE_DIR"]
      else process.env["SENSUS_CACHE_DIR"] = prevCache
    }
  })
})

describe("M10 streaming display (thinking, coalescing, collapsible cards)", () => {
  test("reasoning deltas land in msg.thinking (never content, never provider history) and flush fully by idle", async () => {
    const h = makeSession([
      { kind: "stop", text: "the answer", reasoning: ["I should greet the user.", " Keep it short."] },
    ])
    h.chat.handleInput("hi")
    await until(() => status(h) === "idle", 8000, "idle")
    const assistant = messages(h).find((m) => m.role === "assistant")
    expect(assistant?.content).toBe("the answer")
    expect(assistant?.thinking).toBe("I should greet the user. Keep it short.")
    expect(typeof assistant?.thinkingMs).toBe("number")
    expect((assistant?.thinkingMs ?? 0) >= 0).toBe(true)
    // display-only: reasoning never enters the provider history
    expect(h.provider.requests[0]?.messages.some((m) => m.content.includes("greet"))).toBe(false)
    expect(readFileSync(h.file.filePath, "utf8")).toContain('"thinking":"I should greet the user. Keep it short."')
    // A thinking-only TOOL turn keeps its thinking bubble (cards are not the
    // whole story).
    const t = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "echo M10-THINK" })], reasoning: ["I need to run the tool."] },
      { kind: "stop", text: "done" },
    ])
    t.chat.handleInput("/yolo")
    t.chat.handleInput("run it")
    await until(() => status(t) === "idle", 8000, "idle tool turn")
    const thinkingBubbles = messages(t).filter((m) => m.role === "assistant" && (m.thinking?.length ?? 0) > 0)
    expect(thinkingBubbles.length).toBe(1)
    expect(thinkingBubbles[0]?.thinking).toBe("I need to run the tool.")
    // Coalesced deltas always flush the FULL content by idle.
    const c = makeSession([{ kind: "stop", text: "abcdefghij" }])
    c.chat.handleInput("hi")
    await until(() => status(c) === "idle", 8000, "idle coalesce")
    expect(messages(c).find((m) => m.role === "assistant")?.content).toBe("abcdefghij")
  })

  test("a capped (finish=length) reply and an empty completion are surfaced, not silent", async () => {
    // Truncation: the endpoint hit its output cap mid-answer. The partial text
    // survives, but the turn is NOT a clean stop — a system note + toast + a
    // provider `error-raised` explain why the agent went quiet, and the turn
    // outcome folds to `error` so the event log (frozen v1) records it.
    const events: SensusEvent[] = []
    const h = makeSession([{ kind: "stop", text: "half a thought…", finish: "length" }], {
      sessionId: "inst-trunc",
      eventSink: () => ({ emit: (e) => events.push(e) }),
    })
    h.config.endpoints["main"]!.maxTokens = 8192
    h.chat.handleInput("think about it")
    await until(() => status(h) === "idle", 8000, "idle truncated")
    // The partial answer is kept (it is real output).
    expect(messages(h).find((m) => m.role === "assistant")?.content).toBe("half a thought…")
    // The user is told what happened, in the transcript and as a toast.
    const note = messages(h).find((m) => m.role === "system")
    expect(note?.content).toContain("output cap")
    expect(note?.content).toContain("8192")
    expect(note?.content).toContain("continue")
    expect(h.toasts.some((t) => t.level === "warn" && t.message.includes("output cap"))).toBe(true)
    // A capped reply is an incomplete turn: `error-raised` + `turn-complete(error)`.
    const raised = events.find((e) => e.type === "error-raised")
    expect(raised?.type === "error-raised" ? raised.source : null).toBe("provider")
    expect(raised?.type === "error-raised" ? raised.message : "").toContain("truncated")
    const turn = events.find((e) => e.type === "turn-complete")
    expect(turn?.type === "turn-complete" ? turn.outcome : null).toBe("error")

    // Empty completion: no delta at all, but the model reported a real stop.
    // Nothing renders (display ↔ JSONL stay 1:1), so a note is the only signal.
    const empty = makeSession([{ kind: "stop", text: "", empty: true }], {
      sessionId: "inst-empty",
      eventSink: () => ({ emit: (e) => events.push(e) }),
    })
    empty.chat.handleInput("say something")
    await until(() => status(empty) === "idle", 8000, "idle empty")
    expect(messages(empty).some((m) => m.role === "assistant")).toBe(false)
    expect(messages(empty).find((m) => m.role === "system")?.content).toContain("empty reply")
    expect(empty.toasts.every((t) => !t.message.includes("empty reply"))).toBe(true)
  })

  test("tool calls returned with a non-tool_calls finish are dropped unexecuted and surfaced, never silent", async () => {
    // Some OpenAI-compatible servers emit completed tool calls with a plain
    // `stop` finish. The tool branch requires finish:"tool_calls", so the calls
    // are never executed — a contentless turn that must not settle silently as
    // a clean stop (regression: the answerless guard skipped it).
    const events: SensusEvent[] = []
    const h = makeSession(
      [{ kind: "stop", text: "", calls: [call("shell_background", { command: "echo DROPPED" })] }],
      { sessionId: "inst-dropped-calls", eventSink: () => ({ emit: (e) => events.push(e) }) },
    )
    h.chat.handleInput("run it")
    await until(() => status(h) === "idle", 8000, "idle dropped calls")
    // Nothing was executed: no tool card / tool result message.
    expect(messages(h).some((m) => m.role === "tool")).toBe(false)
    // The user is told the calls were dropped and nothing answered.
    const note = messages(h).find((m) => m.role === "system")
    expect(note?.content).toContain("empty reply")
    expect(note?.content).toContain("not executed")
    const raised = events.find((e) => e.type === "error-raised")
    expect(raised?.type === "error-raised" ? raised.source : null).toBe("provider")
    const turn = events.find((e) => e.type === "turn-complete")
    expect(turn?.type === "turn-complete" ? turn.outcome : null).toBe("error")
  })

  test("a stream restart discards the failed attempt's reasoning; the retry's answer settles", async () => {
    // The provider retries internally when only reasoning was streamed and
    // announces the restart: the session must clear the partial reasoning
    // before the retry re-streams (docs/agent.md "Streaming display").
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const h = makeSession([
      {
        kind: "retry",
        failedReasoning: ["STALE-REASONING"],
        gate,
        reasoning: ["fresh reasoning "],
        text: "the retry answer",
      },
    ])
    h.chat.handleInput("hi")
    // Wait until the stale reasoning has coalesced onto the bubble (a real
    // retry is preceded by a backoff long enough for a flush).
    await until(() => messages(h).some((m) => (m.thinking ?? "").includes("STALE")), 8000, "stale landed")
    release()
    await until(() => status(h) === "idle", 8000, "idle")
    const assistants = messages(h).filter((m) => m.role === "assistant")
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.content).toBe("the retry answer")
    expect(assistants[0]?.thinking).toBe("fresh reasoning ")
    expect(assistants[0]?.thinking ?? "").not.toContain("STALE")
    expect(messages(h).some((m) => m.role === "error")).toBe(false)
  })

  test("a reasoning-only stop is surfaced as an empty reply and settles the turn error", async () => {
    // Regression: reasoning deltas create a bubble, so the old
    // `assistantId === null` guard never fired and the turn settled `ok` with
    // only a thinking block — no answer, no note, no error.
    const events: SensusEvent[] = []
    const h = makeSession(
      [
        {
          kind: "stop",
          text: "",
          empty: true,
          reasoning: ["I reasoned for a long time and then produced no visible answer."],
        },
      ],
      { sessionId: "inst-answerless", eventSink: () => ({ emit: (e) => events.push(e) }) },
    )
    h.chat.handleInput("think hard")
    await until(() => status(h) === "idle", 8000, "idle answerless")
    const assistant = messages(h).find((m) => m.role === "assistant")
    // The reasoning bubble survives (it is real output); the answer is empty.
    expect(assistant?.content).toBe("")
    expect(assistant?.thinking).toContain("reasoned for a long time")
    const note = messages(h).find((m) => m.role === "system")
    expect(note?.content).toContain("empty reply")
    expect(note?.content).toContain("no visible answer after reasoning")
    const raised = events.find((e) => e.type === "error-raised")
    expect(raised?.type === "error-raised" ? raised.source : null).toBe("provider")
    const turn = events.find((e) => e.type === "turn-complete")
    expect(turn?.type === "turn-complete" ? turn.outcome : null).toBe("error")
  })

  test("thinking default: an unset mode sends the model's HIGHEST advertised effort; /effort overrides it", async () => {
    const h = makeSession([{ kind: "stop", text: "ok" }, { kind: "stop", text: "again" }])
    // Hermetic: the models.dev cache lives under this harness's temp home, so an
    // ambient ~/.cache never leaks in (the source of the CI/local divergence).
    const prevCacheDir = process.env["SENSUS_CACHE_DIR"]
    process.env["SENSUS_CACHE_DIR"] = join(h.home, "cache")
    try {
      // Models.dev metadata via the config's per-model override, keyed on the
      // model THIS session actually resolves (config default, not the file's id).
      h.config.endpoints["main"]!.models[h.chat.modelName()] = {
        contextLimit: null,
        inputLimit: null,
        reasoning: true,
        reasoningEfforts: ["low", "high"],
        reasoningBudgetMin: null,
        reasoningBudgetMax: null,
        toolCall: null,
        temperatureSupported: null,
        vision: null,
      }
      // No explicit mode -> the highest advertised effort (was: omit the knob).
      expect(h.chat.effortSetting()).toBe("high")
      h.chat.handleInput("hi")
      await until(() => status(h) === "idle", 8000, "idle")
      expect(h.provider.requests[0]?.thinking).toEqual({ reasoningEffort: "high" })
      // An explicit /effort still wins.
      h.chat.handleInput("/effort low")
      expect(h.chat.effortSetting()).toBe("low")
      h.chat.handleInput("again")
      await until(() => status(h) === "idle", 8000, "idle 2")
      expect(h.provider.requests[1]?.thinking).toEqual({ reasoningEffort: "low" })
    } finally {
      if (prevCacheDir === undefined) delete process.env["SENSUS_CACHE_DIR"]
      else process.env["SENSUS_CACHE_DIR"] = prevCacheDir
    }
  })

  test("display toggles (/thinking, /details, /cards, approval chip) flip session state with a toast and config seeds them", () => {
    const h = makeSession([{ kind: "stop", text: "ok" }])
    expect(h.chat.accessors.thinkingMode()).toBe("hide")
    expect(h.chat.accessors.toolDetails()).toBe("collapsed")
    expect(h.chat.accessors.cardStyle()).toBe("border")
    h.chat.handleInput("/thinking")
    expect(h.chat.accessors.thinkingMode()).toBe("show")
    h.chat.handleInput("/thinking hide")
    expect(h.chat.accessors.thinkingMode()).toBe("hide")
    h.chat.handleInput("/details")
    expect(h.chat.accessors.toolDetails()).toBe("expanded")
    h.chat.handleInput("/details off")
    expect(h.chat.accessors.toolDetails()).toBe("collapsed")
    h.chat.handleInput("/cards")
    expect(h.chat.accessors.cardStyle()).toBe("fill")
    h.chat.handleInput("/cards border")
    expect(h.chat.accessors.cardStyle()).toBe("border")
    const notes = h.toasts.map((t) => t.message)
    expect(notes.some((n) => n.includes("thinking display → show"))).toBe(true)
    expect(notes.some((n) => n.includes("tool output details → on"))).toBe(true)
    expect(notes.some((n) => n.includes("card style → fill"))).toBe(true)
    // Toggles toast — they never enter the transcript.
    expect(messages(h).some((m) => m.role === "system" && m.content.includes("thinking display →"))).toBe(false)
    // Config chat section seeds a new session's display state.
    h.config.chat.thinking = "show"
    h.config.chat.toolOutput = "expanded"
    h.config.chat.animations = false
    h.config.chat.cardStyle = "fill"
    const seeded = new ChatSession({
      getConfig: () => h.config,
      provider: () => h.provider,
      file: () => h.file,
      rotateFile: () => h.file,
      toast: () => {},
    })
    expect(seeded.accessors.thinkingMode()).toBe("show")
    expect(seeded.accessors.toolDetails()).toBe("expanded")
    expect(seeded.accessors.animations()).toBe(false)
    expect(seeded.accessors.cardStyle()).toBe("fill")
    // A LIVE session re-seeded from a config change: a Settings save or
    // `/reload` runs applyChatDisplayConfig against every open tab, so an
    // already-rendered bubble rebuilds without a restart (Kaneo #25).
    applyChatDisplayConfig(h.chat, { thinking: "show", toolOutput: "expanded", animations: false, cardStyle: "border" })
    expect(h.chat.accessors.thinkingMode()).toBe("show")
    expect(h.chat.accessors.toolDetails()).toBe("expanded")
    expect(h.chat.accessors.animations()).toBe(false)
    expect(h.chat.accessors.cardStyle()).toBe("border")
    // The live slash toggles still work after a re-seed (no regression).
    h.chat.handleInput("/cards fill")
    expect(h.chat.accessors.cardStyle()).toBe("fill")
    // The re-seed helper is the single primitive App's config-change router
    // runs for user/settings swaps (#27). An internal reload calls nothing, so
    // session-scoped overrides survive; a re-seed restores every field at once.
    h.config.chat.thinking = "hide"
    h.config.chat.toolOutput = "collapsed"
    h.config.chat.animations = true
    h.config.chat.cardStyle = "border"
    h.chat.setThinkingMode("show")
    h.chat.setToolDetails("expanded")
    h.chat.setCardStyle("fill")
    h.chat.setAnimations(false)
    // Internal reload: the router does NOT re-seed, so the overrides stand.
    expect(h.chat.accessors.thinkingMode()).toBe("show")
    expect(h.chat.accessors.toolDetails()).toBe("expanded")
    expect(h.chat.accessors.cardStyle()).toBe("fill")
    expect(h.chat.accessors.animations()).toBe(false)
    // User /reload or a settings write: the router re-seeds from config.
    applyChatDisplayConfig(h.chat, h.config.chat)
    expect(h.chat.accessors.thinkingMode()).toBe("hide")
    expect(h.chat.accessors.toolDetails()).toBe("collapsed")
    expect(h.chat.accessors.cardStyle()).toBe("border")
    expect(h.chat.accessors.animations()).toBe(true)
  })

  test("collapsible output: per-card override, last-card toggle, no-card fallback, thinking toggle", async () => {
    const h = makeSession([
      { kind: "tool_calls", calls: [call("shell_background", { command: "echo M10-CARD" })] },
      { kind: "stop", text: "done" },
    ])
    h.chat.handleInput("/yolo")
    h.chat.handleInput("run it")
    await until(() => status(h) === "idle", 8000, "idle")
    const card = cards(h).find((m) => m.tool?.name === "shell_background")
    expect(card?.tool?.callId).toBeDefined()
    const callId = card!.tool!.callId
    // collapsed session default -> cardExpanded false; toggle flips it only
    expect(h.chat.accessors.toolDetails()).toBe("collapsed")
    expect(h.chat.cardExpanded(callId)).toBe(false)
    expect(h.chat.toggleCardExpand(callId)).toBe(true)
    expect(h.chat.cardExpanded(callId)).toBe(true)
    expect(h.chat.cardExpanded("nonexistent")).toBe(false)
    // `e` key path: toggles the most recent non-pending card
    expect(h.chat.toggleLastCardExpand()).toBe(true)
    expect(h.chat.cardExpanded(callId)).toBe(false)
    // no cards at all -> false (the key falls through to the editor)
    const empty = makeSession([{ kind: "stop", text: "ok" }])
    expect(empty.chat.toggleLastCardExpand()).toBe(false)
    expect(empty.chat.toggleLastThinkingOpen()).toBe(false)
    // Thinking toggle flips the latest thinking block.
    const th = makeSession([{ kind: "stop", text: "answer", reasoning: ["why?"] }])
    th.chat.handleInput("hi")
    await until(() => status(th) === "idle", 8000, "idle thinking")
    const id = messages(th).find((m) => m.role === "assistant")!.id
    expect(th.chat.thinkingOpen(id)).toBe(false) // hide default
    expect(th.chat.toggleLastThinkingOpen()).toBe(true)
    expect(th.chat.thinkingOpen(id)).toBe(true)
  })

  test("restore maps thinking through the records round-trip", async () => {
    const restored = makeSession([{ kind: "stop", text: "fresh" }])
    restored.chat.restore(
      recordsToMessages([{ role: "assistant", content: "old answer", thinking: "old reasoning" }]),
    )
    const msg = restored.chat.accessors.messages().find((m) => m.role === "assistant")
    expect(msg?.thinking).toBe("old reasoning")
  })
})

describe("stream reveal pacing (docs/agent.md 'Streaming display')", () => {
  const TEXT = "hello streamed reply"

  test("fresh bubbles pour, settled tails drain, first sight snaps, animations off pass through, /clear resets pacing", async () => {
    // Fresh bubble: content starts "" (hidden), the first burst shows a
    // bounded cut — never the whole chunk at once.
    const h = makeSession([{ kind: "stop", text: "ok" }])
    expect(h.chat.revealContentCut(1, "", false)).toBe(0)
    const cut = h.chat.revealContentCut(1, TEXT, false)
    expect(cut).toBeGreaterThan(0)
    expect(cut).toBeLessThan(TEXT.length)
    // Settled + real time passing -> the tail drains and stays complete.
    await Bun.sleep(90)
    expect(h.chat.revealContentCut(1, TEXT, true)).toBe(TEXT.length)
    expect(h.chat.revealThinkingCut(1, "thought stream", true)).toBe("thought stream".length)
    // First sight of content that already exists snaps (resume / restore).
    expect(h.chat.revealContentCut(3, "restored answer body", true)).toBe("restored answer body".length)
    // Animations off: pure passthrough, no pacing state.
    h.config.chat.animations = false
    const chat2 = new ChatSession({
      getConfig: () => h.config,
      provider: () => h.provider,
      file: () => h.file,
      rotateFile: () => h.file,
      toast: () => {},
    })
    expect(chat2.revealContentCut(1, "", false)).toBe(0)
    expect(chat2.revealContentCut(1, TEXT, false)).toBe(TEXT.length)
    expect(chat2.revealThinkingCut(1, "reasoning", false)).toBe("reasoning".length)
    // /clear resets the pacing state (the next sight snaps).
    h.config.chat.animations = true
    const clearable = makeSession([{ kind: "stop", text: "ok" }])
    clearable.chat.revealContentCut(1, "", false)
    expect(clearable.chat.revealContentCut(1, TEXT, false)).toBeLessThan(TEXT.length)
    clearable.chat.clearAll()
    expect(clearable.chat.revealContentCut(1, TEXT, false)).toBe(TEXT.length)
  })
})

describe("memory prompt injection (docs/memory.md)", () => {
  test("frozen MEMORY snapshot is injected; a later write does NOT change the live prompt (cache invariant); disabled memory drops the tools", async () => {
    const holder: { snapshot: MemorySnapshot | null } = {
      snapshot: { text: "the ssh port is 2222", used: 21, limit: 2200 },
    }
    const bridge: MemoryToolBridge = {
      read: () => "",
      list: () => ({ ok: true, message: "" }),
      readResult: () => ({ ok: true, message: "" }),
      add: () => ({ ok: true, message: "added" }),
      replace: () => ({ ok: true, message: "" }),
      remove: () => ({ ok: true, message: "" }),
      rewrite: () => ({ ok: true, message: "rewritten" }),
      usage: () => ({ target: "memory", used: 0, limit: 0, percent: 0, entries: 0 }),
    }
    const h = makeSession([{ kind: "stop", text: "one" }, { kind: "stop", text: "two" }], {
      memory: { getSnapshot: () => holder.snapshot, bridge },
    })
    h.chat.handleInput("first")
    await until(() => status(h) === "idle", 5000, "idle one")
    const sys = (i: number): string => (h.provider.requests[i]?.messages.find((m) => m.role === "system")?.content ?? "")
    const p1 = sys(0)
    expect(p1).toContain("the ssh port is 2222")
    expect(p1).toContain("MEMORY [21/2200 chars]")
    expect(p1).toContain('ALWAYS consult HOST.md')

    // A write changes the store, but the captured snapshot (and the live prompt)
    // must not move — it appears in the NEXT session.
    holder.snapshot = { text: "the ssh port is 9999", used: 21, limit: 2200 }
    h.chat.handleInput("second")
    await until(() => status(h) === "idle", 5000, "idle two")
    const p2 = sys(1)
    expect(p2).toBe(p1)
    expect(p2).not.toContain("9999")

    // Disabled memory: no prompt block and the memory/host_scan specs are dropped.
    const h2 = makeSession([{ kind: "stop", text: "x" }], { memory: { getSnapshot: () => holder.snapshot, bridge } })
    h2.config.memory.enabled = false
    h2.chat.handleInput("no memory")
    await until(() => status(h2) === "idle", 5000, "idle disabled")
    const req = h2.provider.requests[0]
    const prompt = req?.messages.find((m) => m.role === "system")?.content ?? ""
    expect(prompt).not.toContain("Memory (your notes")
    const names = ((req?.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name)
    expect(names).not.toContain("memory")
    expect(names).not.toContain("host_scan")
  })
})

describe("compaction progress (docs/agent.md 'Streaming display')", () => {
  test("/compact exposes the reactive compacting flag and accepts a truncated summary", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const h = makeSession([
      { kind: "stop", text: "first answer" },
      { kind: "summary", text: "## Objective\nDo the thing\n\n## Next steps\n- go", finish: "length", gate },
    ])
    h.chat.handleInput("hello")
    await until(() => status(h) === "idle", 5000, "idle first")
    expect(h.chat.accessors.compacting()).toBe(false)

    expect(h.chat.handleInput("/compact")).toBe("sent")
    // The UI can see the phase while it runs (the whole point of the flag).
    await until(() => h.chat.accessors.compacting(), 3000, "compacting visible")
    expect(h.chat.isWorking()).toBe(true)
    // A send is blocked with a note while compacting (unchanged behavior).
    expect(h.chat.handleInput("while compacting")).toBe("busy")

    release()
    await until(() => h.chat.accessors.compactions() === 1, 5000, "compacted")
    await until(() => !h.chat.accessors.compacting(), 3000, "compacting cleared")
    expect(h.chat.isWorking()).toBe(false)
    // The summary request got the raised output budget (bounded).
    const summaryMax = h.provider.requests.at(-1)?.maxTokens ?? 0
    expect(summaryMax).toBeGreaterThanOrEqual(8192)
    expect(summaryMax).toBeLessThanOrEqual(ONE_SHOT_MAX_TOKENS)
    // A finish=length summary was still applied (context was checkpointed).
    expect(
      h.chat.accessors.messages().some((m) => m.role === "system" && m.content.includes("context compacted")),
    ).toBe(true)
  })

  test("/compact names reasoning starvation when the summary is empty and truncated", async () => {
    const h = makeSession([
      { kind: "stop", text: "first answer" },
      { kind: "summary", text: "", finish: "length" },
      { kind: "summary", text: "", finish: "length" },
    ])
    h.chat.handleInput("hello")
    await until(() => status(h) === "idle", 5000, "idle first")

    expect(h.chat.handleInput("/compact")).toBe("sent")
    await until(() => h.toasts.some((t) => t.level === "error" && t.message.includes("reasoning")), 5000, "starvation toast")
    // Nothing was checkpointed.
    expect(h.chat.accessors.compactions()).toBe(0)
  })
})

describe("undo + audit (docs/agent.md)", () => {
  test("/undo restores the last recorded file write; /audit lists recent entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "sensus-undo-"))
    try {
      const target = join(dir, "f.txt")
      writeFileSync(target, "NEW", "utf8")
      const entries: AuditEntry[] = [
        { ts: 1, session: "s", kind: "file", tool: "write_file", summary: target, ok: true, path: target, before: "OLD" },
      ]
      const state: { undone: number | null } = { undone: null }
      const audit: AuditBridge = {
        record: (e) => entries.push({ ...e, session: "s" }),
        lastUndoable: () => entries.filter((e) => e.kind === "file" && e.undone !== true).at(-1) ?? null,
        markUndone: (ts) => {
          state.undone = ts
        },
        recent: (n = 20) => entries.slice(Math.max(0, entries.length - n)),
      }
      const h = makeSession([], { audit })
      h.chat.handleInput("/undo")
      expect(readFileSync(target, "utf8")).toBe("OLD")
      expect(state.undone).toBe(1)
      h.chat.handleInput("/audit 5")
      expect(messages(h).some((m) => m.role === "system" && m.content.includes("audit (last"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("image attachments (docs/agent.md \"Images\")", () => {
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  )
  const override = (vision: boolean): ModelOverride => ({
    contextLimit: null,
    inputLimit: null,
    reasoning: null,
    reasoningEfforts: null,
    reasoningBudgetMin: null,
    reasoningBudgetMax: null,
    toolCall: null,
    temperatureSupported: null,
    vision,
  })

  test("clipboard image: draft -> display bubble -> provider history + JSONL; view_image lifts pixels after its tool result", async () => {
    const h = makeSession([
      { kind: "tool_calls", calls: [call("view_image", { path: "pic.png" })] },
      { kind: "stop", text: "I can see it" },
    ])
    writeFileSync(join(h.home, "pic.png"), PNG)
    h.chat.setApproval("full-auto") // confirm mode now gates view_image too
    // User attachment via the clipboard seam.
    expect(h.chat.addDraftImage(PNG, "clipboard.png", "image/png").ok).toBe(true)
    expect(h.chat.accessors.draftImages().length).toBe(1)
    expect(h.chat.handleInput("look at this")).toBe("sent")
    expect(h.chat.accessors.draftImages().length).toBe(0) // consumed by the send
    await until(() => status(h) === "idle", 8000, "idle")

    // Display bubble carries the attachment; the request carries its asset path.
    const userMsg = messages(h).find((m) => m.role === "user")
    expect(userMsg?.images?.[0]?.name).toBe("clipboard.png")
    const first = h.provider.requests[0]!
    const userReq = first.messages.filter((m) => m.role === "user").at(-1)
    expect(userReq?.images?.[0]?.mediaType).toBe("image/png")
    expect(userReq?.images?.[0]?.path.endsWith(".png")).toBe(true)
    // view_image: the tool result is followed by a synthetic user message with pixels.
    const second = h.provider.requests[1]!
    expect(second.messages.some((m) => m.role === "tool" && m.toolName === "view_image")).toBe(true)
    expect(second.messages.some((m) => m.role === "user" && (m.images?.length ?? 0) > 0)).toBe(true)
    expect(cards(h).find((m) => m.tool?.name === "view_image")?.tool?.status).toBe("done")
    expect(readFileSync(h.file.filePath, "utf8")).toContain('"images"')
  }, 15000)

  test("vision gating: an image-incompatible model refuses the send (draft kept); a vision model gets the view_image spec", async () => {
    const noVision = makeSession([{ kind: "stop", text: "n/a" }])
    const endpoint = noVision.chat.endpointName()
    const model = noVision.chat.modelName()
    noVision.config.endpoints[endpoint]!.models[model] = override(false)
    noVision.chat.setModelSelection(endpoint, model)
    expect(noVision.chat.modelSupportsVision()).toBe(false)
    noVision.chat.addDraftImage(PNG, "x.png", "image/png")
    expect(noVision.chat.handleInput("send it")).toBe("empty")
    expect(noVision.provider.requests.length).toBe(0)
    expect(noVision.toasts.some((t) => t.level === "error" && t.message.includes("does not accept image"))).toBe(true)
    expect(noVision.chat.accessors.draftImages().length).toBe(1) // kept so the model can be switched

    const vision = makeSession([{ kind: "stop", text: "ok" }])
    const ep = vision.chat.endpointName()
    const m = vision.chat.modelName()
    vision.config.endpoints[ep]!.models[m] = override(true)
    vision.chat.setModelSelection(ep, m)
    expect(vision.chat.modelSupportsVision()).toBe(true)
    vision.chat.addDraftImage(PNG, "y.png", "image/png")
    expect(vision.chat.handleInput("send it")).toBe("sent")
    await until(() => status(vision) === "idle", 5000, "idle")
    const tools = (vision.provider.requests[0]?.tools ?? []) as Array<{ function?: { name?: string } }>
    expect(tools.some((t) => t.function?.name === "view_image")).toBe(true)
  }, 15000)
})

describe("nearest AGENTS.md attach on read (docs/agent.md 'System prompt')", () => {
  const projects = (h: Harness, n: number) =>
    (h.provider.requests[n]?.messages ?? []).filter(
      (m) => m.role === "user" && m.content.startsWith("Project instructions (from "),
    )

  test("a read_file whose ancestor has an AGENTS.md appends it once; a sibling read does not duplicate it", async () => {
    const h = makeSession([
      { kind: "tool_calls", calls: [call("read_file", { path: "sub/a.txt" }, "r1")] },
      { kind: "tool_calls", calls: [call("read_file", { path: "sub/b.txt" }, "r2")] },
      { kind: "stop", text: "done" },
    ])
    mkdirSync(join(h.home, "sub"), { recursive: true })
    writeFileSync(join(h.home, "sub", "a.txt"), "AAA")
    writeFileSync(join(h.home, "sub", "b.txt"), "BBB")
    writeFileSync(join(h.home, "sub", "AGENTS.md"), "PROJECT-INSTRUCTION-MARK")

    h.chat.setApproval("full-auto") // confirm mode now gates read_file too
    h.chat.handleInput("read both files")
    await until(() => status(h) === "idle", 8000, "idle")

    // The nearest file's body lands as its OWN durable user message, after the
    // tool results (cache-safe append; docs/agent.md "Prompt caching").
    const first = projects(h, 1)
    expect(first).toHaveLength(1)
    expect(first[0]?.content).toContain("PROJECT-INSTRUCTION-MARK")
    expect(first[0]?.content).toContain(join(h.home, "sub", "AGENTS.md"))
    // The sibling read in the same tree does not re-attach it.
    expect(projects(h, 2)).toHaveLength(1)
  })

  test("a read with no AGENTS.md ancestor in its tree appends no project-instructions message from that tree", async () => {
    const n = makeSession([
      { kind: "tool_calls", calls: [call("read_file", { path: "plain/x.txt" }, "n1")] },
      { kind: "stop", text: "done" },
    ])
    mkdirSync(join(n.home, "plain"), { recursive: true })
    writeFileSync(join(n.home, "plain", "x.txt"), "XXX")

    n.chat.setApproval("full-auto") // confirm mode now gates read_file too
    n.chat.handleInput("read it")
    await until(() => status(n) === "idle", 8000, "idle")

    // No AGENTS.md in this tree: nothing attributed to it is attached. (A
    // stray AGENTS.md in an environmental ancestor such as /tmp is a real
    // nearest file and out of this tree's scope — the pure resolver test
    // covers the true null walk.)
    const fromTree = projects(n, 1).filter((m) => m.content.includes(n.home))
    expect(fromTree).toHaveLength(0)
  })
})

describe("ChatSession busy sends (steer / queue)", () => {
  test("steer (default): a message sent while streaming is injected into the running turn", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const h = makeSession([
      { kind: "stop", text: "first reply", gate },
      { kind: "stop", text: "steered reply" },
    ])
    expect(h.chat.handleInput("first question")).toBe("sent")
    await until(() => h.provider.requests.length >= 1 && status(h) === "streaming", 5000, "streaming")

    // Default chat.busySend is "steer": Enter injects into the running turn.
    expect(h.chat.handleInput("steer this")).toBe("steered")
    expect(h.chat.accessors.busyPending()).toEqual({ steer: 1, queue: 0 })

    release()
    await until(() => status(h) === "idle", 5000, "idle")

    // Ordering: the steer bubble lands AFTER the reply it interrupted, and the
    // model gets one more turn to answer it.
    expect(messages(h).map((m) => m.content)).toEqual([
      "first question",
      "first reply",
      "steer this",
      "steered reply",
    ])
    expect(h.provider.requests).toHaveLength(2)
    expect(h.provider.requests[1]?.messages.some((m) => m.content === "steer this")).toBe(true)
    expect(readFileSync(h.file.filePath, "utf8")).toContain('"content":"steer this"')
    expect(h.chat.accessors.busyPending()).toEqual({ steer: 0, queue: 0 })
    expect(h.toasts.some((t) => t.message.includes("steering"))).toBe(true)
  })

  test("queue (Alt+Enter alternate): the message runs as the next generation after the reply settles", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const h = makeSession([
      { kind: "stop", text: "first reply", gate },
      { kind: "stop", text: "queued reply" },
    ])
    h.chat.handleInput("first question")
    await until(() => h.provider.requests.length >= 1 && status(h) === "streaming", 5000, "streaming")

    // Default steer → Alt+Enter applies the OTHER mode = queue.
    expect(h.chat.handleInput("queued one", { alternate: true })).toBe("queued")
    expect(h.chat.accessors.busyPending()).toEqual({ steer: 0, queue: 1 })

    release()
    await until(() => status(h) === "idle", 5000, "idle")
    // The queue auto-started a SECOND generation (its own request).
    await until(() => h.provider.requests.length === 2, 5000, "second request")
    await until(() => status(h) === "idle", 5000, "idle after queue")

    expect(messages(h).map((m) => m.content)).toEqual([
      "first question",
      "first reply",
      "queued one",
      "queued reply",
    ])
    expect(h.chat.accessors.busyPending()).toEqual({ steer: 0, queue: 0 })
    expect(h.toasts.some((t) => t.message.includes("queued"))).toBe(true)
  })

  test("chat.busySend=queue makes plain Enter hold the message and Alt+Enter steer", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const h = makeSession([
      { kind: "stop", text: "first reply", gate },
      { kind: "stop", text: "queued reply" },
    ])
    h.config.chat.busySend = "queue"
    h.chat.handleInput("first question")
    await until(() => h.provider.requests.length >= 1 && status(h) === "streaming", 5000, "streaming")

    // Enter now queues; the alternate flips to steer.
    expect(h.chat.busySendMode()).toBe("queue")
    expect(h.chat.handleInput("queued one")).toBe("queued")
    expect(h.chat.handleInput("steer this", { alternate: true })).toBe("steered")
    expect(h.chat.accessors.busyPending()).toEqual({ steer: 1, queue: 1 })

    release()
    await until(() => status(h) === "idle", 8000, "idle")
    expect(h.provider.requests.length).toBeGreaterThanOrEqual(2)
    // Both the steer and the queued turn landed.
    expect(messages(h).some((m) => m.content === "steer this")).toBe(true)
    expect(messages(h).some((m) => m.content === "queued one")).toBe(true)
  })

  test("a slash command is never steered/queued while streaming", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const h = makeSession([{ kind: "stop", text: "reply", gate }])
    h.chat.handleInput("go")
    await until(() => h.provider.requests.length >= 1 && status(h) === "streaming", 5000, "streaming")
    expect(h.chat.handleInput("/status")).toBe("busy")
    expect(h.chat.accessors.busyPending()).toEqual({ steer: 0, queue: 0 })
    release()
    await until(() => status(h) === "idle", 5000, "idle")
  })

  test("a message sent while the settled reply's reveal drains is a fresh turn, not a stranded steer", async () => {
    // Regression: `finishStreamingWhenCaught` holds status "streaming" while
    // the settled reply's typewriter reveal pours, after the loop's controller
    // is already null. A steer accepted in that window had no running turn to
    // inject into, so the user never got an answer. Seed reveal state for the
    // assistant bubble this send creates (id 2 in a fresh transcript) so the
    // hold is deterministic: the pour stays behind and `contentSettled` false
    // until the drain failsafe (docs/agent.md "Streaming display").
    const h = makeSession([
      { kind: "stop", text: "first reply" },
      { kind: "stop", text: "follow-up reply" },
    ])
    h.chat.revealContentCut(2, "", false)
    h.chat.revealContentCut(2, "pouring ".repeat(200), false)

    expect(h.chat.handleInput("first question")).toBe("sent")
    // The loop finishes (its reply is in the transcript) but the reveal drain
    // keeps the status "streaming" with no live controller.
    await until(
      () => h.provider.requests.length === 1 && messages(h).some((m) => m.content === "first reply"),
      5000,
      "loop settled",
    )
    await Bun.sleep(60)
    expect(status(h)).toBe("streaming")
    expect(h.chat.isBusy()).toBe(false) // status held by the reveal, not a live turn

    // The late message must start its own generation instead of being stranded.
    expect(h.chat.handleInput("follow up")).toBe("sent")
    expect(h.chat.accessors.busyPending()).toEqual({ steer: 0, queue: 0 })
    await until(() => h.provider.requests.length === 2, 5000, "follow-up request")
    await until(() => status(h) === "idle", 5000, "idle")
    expect(messages(h).map((m) => m.content)).toEqual([
      "first question",
      "first reply",
      "follow up",
      "follow-up reply",
    ])
  })

  test("an abort with a pending steer re-prompts the agent instead of stranding the message", async () => {
    // Regression: a steer accepted while the turn is live, then an Esc abort,
    // left the message in the transcript with no running turn to answer it —
    // the user saw their bubble but no reply. The abort path must re-dispatch
    // the steer as a fresh generation (docs/agent.md "Busy sends").
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const h = makeSession([
      { kind: "stop", text: "first reply", gate },
      { kind: "stop", text: "steered reply" },
    ])
    expect(h.chat.handleInput("first question")).toBe("sent")
    await until(() => h.provider.requests.length >= 1 && status(h) === "streaming", 5000, "streaming")

    expect(h.chat.handleInput("steer this")).toBe("steered")
    expect(h.chat.accessors.busyPending()).toEqual({ steer: 1, queue: 0 })

    h.chat.abort()
    release()
    // The steer starts its OWN generation (a second request) and is answered.
    await until(() => h.provider.requests.length === 2, 5000, "steer request")
    await until(() => status(h) === "idle", 5000, "idle after steer")

    expect(messages(h).map((m) => m.content)).toEqual([
      "first question",
      "⏹ aborted before any output",
      "steer this",
      "steered reply",
    ])
    expect(h.chat.accessors.busyPending()).toEqual({ steer: 0, queue: 0 })
  })
})
