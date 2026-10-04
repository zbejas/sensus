/**
 * ToolCardBook — the approval/ask wait maps + tool-card bookkeeping seam
 * extracted from ChatSession (MOVE-ONLY). Owns the pending approval/ask_user
 * resolvers, the session-only trust patterns, and the card ↔ JSONL helpers
 * so the UI-facing waits and the durable tool events always move together.
 *
 * ChatSession keeps thin delegates for the public wait answers (pendingApproval,
 * pendingAsk, resolveCard, answerAsk, lastToolCard) and forwards the card
 * helpers through its single `book` instance. This module is not imported by UI
 * code.
 */

import { parseToolArguments, toolApprovalDetail, toolParamsSummary } from "../tools.ts"
import type { TrustPattern } from "../tools/approval.ts"
import type { CompletedToolCall } from "../provider/provider.ts"
import type { SessionFile } from "../../session/store.ts"
import type { ChatMessage, ToolCardData, ToolCardStatus } from "./chatMessages.ts"
import type { ToastLevel } from "../../engine/toast.ts"

/** The live ChatSession state the book reads/writes (all calls are lazy, so
 * signal reads and transcript patches stay in sync with the session). */
export interface ToolCardBookHost {
  getMessages(): readonly ChatMessage[]
  patchMessage(id: number, patch: Partial<ChatMessage>): void
  /** ChatSession.patchToolCard — newest matching card wins. */
  patchToolCard(callId: string, patch: Partial<ToolCardData>): number | null
  /** ChatSession.pushMessage — assign an id + timestamp and append. */
  addMessage(m: Omit<ChatMessage, "id" | "ts">): ChatMessage
  getFile(): SessionFile
  toast(message: string, level?: ToastLevel, ttlMs?: number): void
}

/** Resolved outcome of an approval-batch plan wait: the per-line decisions, or
 * an abort (Esc / rewind). */
export type PlanResolution = { decisions: Map<string, "accept" | "reject"> } | { aborted: true }

export class ToolCardBook {
  /** Session-only trust patterns ("approve and don't ask again this session")
   * for shell operation classes. Consulted at gate time AFTER the destructive
   * floor; never persisted (dies with the process — locked decision 6). */
  private readonly sessionTrust: TrustPattern[] = []
  /** Pending approval resolvers by tool call id. */
  private readonly approvalWaits = new Map<string, (d: "accept" | "reject" | "allow" | "aborted") => void>()
  /** Pending ask_user resolvers by tool call id. */
  private readonly askWaits = new Map<string, (answer: string | null) => void>()
  /**
   * Pending approval-BATCH plan resolvers by plan id (docs/agent.md
   * "Approval-batch plan card"). A plan blocks the whole turn once for its
   * pre-collected per-line decisions; an abort resolves it as `{aborted:true}`.
   */
  private readonly planWaits = new Map<string, (r: PlanResolution) => void>()

  constructor(private readonly host: ToolCardBookHost) {}

  /** Backwards message scan (cards/labels resolve against the LATEST match,
   * so every lookup here walks newest-first). Null when nothing matches. */
  private findLastMessage(pred: (m: ChatMessage) => boolean): ChatMessage | null {
    const list = this.host.getMessages()
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      if (m && pred(m)) return m
    }
    return null
  }

  /** Call id of the most recent non-pending tool card (the `e`-key target). */
  lastToolCardId(): string | null {
    return this.findLastMessage((m) => m.tool !== undefined && m.tool.status !== "pending")?.tool?.callId ?? null
  }

  /** The latest pending approval card, if any (y/n/a keys + card clicks). */
  pendingApproval(): ToolCardData | null {
    return this.findLastMessage((m) => m.tool?.status === "pending")?.tool ?? null
  }

  /** The latest pending ask_user card, if any. */
  pendingAsk(): ToolCardData | null {
    return this.findLastMessage((m) => m.tool?.status === "running" && m.tool.question !== undefined)?.tool ?? null
  }

  findCard(callId: string): ToolCardData | null {
    return this.findLastMessage((m) => m.tool?.callId === callId)?.tool ?? null
  }

  /**
   * Record a session trust pattern (idempotent). Used by the single card's
   * "allow" and the plan's per-line trust affordance.
   */
  grantTrust(tool: string, prefix: string): boolean {
    if (prefix.length === 0 || tool.length === 0) return false
    if (this.sessionTrust.some((t) => t.tool === tool && t.prefix === prefix)) return true
    this.sessionTrust.push({ tool, prefix })
    this.host.toast(`commands starting with "${prefix}" auto-approved for this session`, "success")
    return true
  }

  /**
   * Resolve a pending approval card. "allow" records the card's operation-class
   * pattern as session trust (never persisted). Returns false when no card with
   * that id is pending.
   */
  resolveCard(callId: string, action: "accept" | "reject" | "allow"): boolean {
    const wait = this.approvalWaits.get(callId)
    if (!wait) return false
    this.approvalWaits.delete(callId)
    if (action === "allow") {
      const card = this.findCard(callId)
      this.grantTrust(card?.name ?? "", card?.allowPrefix ?? "")
      wait("allow")
    } else {
      wait(action)
    }
    return true
  }

  /** Answer a pending ask_user card (Enter with a draft, or an option pick). */
  answerAsk(callId: string, answer: string): boolean {
    const wait = this.askWaits.get(callId)
    if (!wait) return false
    this.askWaits.delete(callId)
    wait(answer)
    return true
  }

  pushToolCard(call: CompletedToolCall, initial: Partial<ToolCardData>): void {
    const args = parseToolArguments(call.arguments)
    this.host.addMessage({
      role: "tool",
      content: "",
      local: true,
      tool: {
        callId: call.id,
        name: call.name,
        paramsSummary: toolParamsSummary(call.name, args),
        detail: toolApprovalDetail(call.name, args),
        status: "pending",
        ...initial,
      },
    })
  }

  /** Persist one tool event to the session JSONL (never throws — store guards).
   * The raw streamed arguments always ride along; `result` is the
   * boundary-capped model-facing result, written on the FINAL event for a call
   * so `--resume` can replay the tool turn (docs/agent.md "Context management &
   * compaction"). */
  appendToolEvent(
    call: CompletedToolCall,
    status: ToolCardStatus,
    output: string | null,
    exitCode?: number | null,
    result?: string | null,
  ): void {
    this.host.getFile().append({
      ts: Date.now(),
      type: "tool_call",
      callId: call.id,
      name: call.name,
      paramsSummary: toolParamsSummary(call.name, parseToolArguments(call.arguments)),
      status,
      output,
      exitCode: exitCode ?? null,
      arguments: call.arguments,
      ...(typeof result === "string" ? { result } : {}),
    })
  }

  /**
   * Card patch + matching JSONL tool event in one step — the two ALWAYS move
   * together (the card is the live display, the event is the transcript).
   * `eventOutput` is the transcript's output (null = nothing persisted);
   * `cardPatch` layers extra/final display fields over it (e.g. an ask_user
   * answer, or the friendlier "aborted by user" card text). `result` is the
   * boundary-capped result to persist for `--resume` replay.
   */
  updateCard(
    call: CompletedToolCall,
    status: ToolCardStatus,
    eventOutput: string | null,
    cardPatch: Partial<ToolCardData> = {},
    exitCode?: number | null,
    result?: string | null,
  ): void {
    this.host.patchToolCard(call.id, {
      status,
      ...(eventOutput !== null ? { output: eventOutput } : {}),
      ...cardPatch,
    })
    this.appendToolEvent(call, status, eventOutput, exitCode, result)
  }

  /**
   * Register the approval resolver, THEN resolve immediately when the signal is
   * already aborted. The register-then-check order is the wait race: an abort
   * that lands between the two still resolves the promise.
   */
  awaitApproval(callId: string, signal: AbortSignal): Promise<"accept" | "reject" | "allow" | "aborted"> {
    return new Promise((resolve) => {
      this.approvalWaits.set(callId, resolve)
      if (signal.aborted) resolve("aborted")
    })
  }

  /** Register the ask_user resolver, then resolve null when already aborted. */
  awaitAsk(callId: string, signal: AbortSignal): Promise<string | null> {
    return new Promise((resolve) => {
      this.askWaits.set(callId, resolve)
      if (signal.aborted) resolve(null)
    })
  }

  // ---- approval-batch plan wait (docs/agent.md "Approval-batch plan card") --

  /** Register the plan resolver, then resolve aborted when the signal is
   * already aborted (same register-then-check race as awaitApproval). */
  awaitPlan(planId: string, signal: AbortSignal): Promise<PlanResolution> {
    return new Promise((resolve) => {
      this.planWaits.set(planId, resolve)
      if (signal.aborted) resolve({ aborted: true })
    })
  }

  /** Commit/cancel a pending plan. False when no plan with that id is pending. */
  resolvePlan(planId: string, resolution: PlanResolution): boolean {
    const wait = this.planWaits.get(planId)
    if (!wait) return false
    this.planWaits.delete(planId)
    wait(resolution)
    return true
  }

  /** Resolve every pending wait as aborted (Esc). */
  abortWaits(): void {
    for (const [, wait] of this.approvalWaits) wait("aborted")
    this.approvalWaits.clear()
    for (const [, wait] of this.askWaits) wait(null)
    this.askWaits.clear()
    for (const [, wait] of this.planWaits) wait({ aborted: true })
    this.planWaits.clear()
  }

  /** Drop pending waits WITHOUT resolving them (/clear, rewind). Distinct from
   * abortWaits on purpose: clearing must not wake a tool call into appending
   * cards/events to a transcript that is being discarded. */
  clearWaits(): void {
    this.approvalWaits.clear()
    this.askWaits.clear()
    this.planWaits.clear()
  }

  /** Pending approval + ask_user + plan wait count (the UI's "mid-work" gate). */
  pendingWaits(): number {
    return this.approvalWaits.size + this.askWaits.size + this.planWaits.size
  }

  /** The session trust patterns (status-bar chip + gate-time exemption). */
  trustPatterns(): readonly TrustPattern[] {
    return this.sessionTrust
  }

  /** Revoke one trusted pattern (the status-bar chip / API). False when absent. */
  revokeTrust(tool: string, prefix: string): boolean {
    const idx = this.sessionTrust.findIndex((t) => t.tool === tool && t.prefix === prefix)
    if (idx === -1) return false
    this.sessionTrust.splice(idx, 1)
    return true
  }

  /** Revoke every trusted pattern (chip click / `/clear`). Returns the count. */
  revokeAllTrust(): number {
    const n = this.sessionTrust.length
    this.sessionTrust.length = 0
    return n
  }

  clearTrust(): void {
    this.sessionTrust.length = 0
  }
}
