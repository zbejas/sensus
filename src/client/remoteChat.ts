/**
 * RemoteChat — the client-side chat session (P4c-iii; D5/D13; docs/ui.md
 * "Chat"). It is the drop-in replacement for the in-process `ChatSession`
 * (`src/agent/chat/chatSession.ts`): the daemon owns the engine (transcript,
 * provider, approvals, sudo, compaction, context) and streams a `chat.state`
 * snapshot plus incremental events over `/v1/ws`; this class mirrors those
 * signals and keeps ONLY the purely-local UI state client-side (editor, slash
 * menu, history, draft images, reveal pacing, expand toggles, display prefs).
 *
 * Everything engine-derived (model/agent/context/trust/MCP/jobs) comes from
 * `ChatMeta` in `chat.state`/`chat.attach` and the streamed `chat.meta` event —
 * so no in-process engine is needed. Commands go back out as WS ops
 * (`chat.send` → honors its `mode`, `approvals.answer`, `sudo.answer`,
 * `chat.setModel|setAgent|setEffort|setApproval|setMcp`, trust ops, and
 * `chat.planAnswer`).
 *
 * Every handler is defensive (AGENTS.md rule 10): a malformed frame or a WS
 * error surfaces through `onToast`, never as an exception.
 */

import { createSignal, type Accessor } from "solid-js"
import { InputEditor } from "../engine/chat/inputEditor.ts"
import { acceptCompletion, slashMenuForLine, type SlashMenuState } from "../engine/chat/slashComplete.ts"
import { StreamReveal } from "../engine/chat/streamReveal.ts"
import { spinnerFrame } from "../engine/spinner.ts"
import { MAX_ATTACHMENTS, readImageAttachment, storeImageBytes, type ImageAttachment } from "../core/image.ts"
import { readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { tmpdir } from "node:os"
import type { ChatMessage, ChatStatus, PlanCardData, PlanLineStatus, ToolCardData } from "../engine/index.ts"
import type { ChatMeta, ChatPendingSudo, ChatState } from "../daemon/index.ts"
import type { WsClient } from "./wsClient.ts"

export type RemoteChatToastLevel = "info" | "success" | "warn" | "error"

/** The overlay kinds a UI-only slash command opens (client-side, no engine). */
export type RemoteOverlayKind =
  | "settings"
  | "models"
  | "agents"
  | "themes"
  | "memory"
  | "sessions"
  | "skills"
  | "context"
  | "usage"
  | "keymap"
  | "setup"

/**
 * Map a UI-only slash command (no engine work) to the overlay it opens. These
 * were `ChatHost.openOverlay` calls in the in-process build; the daemon has no
 * UI, so the CLIENT owns them (P4d). A command WITH an argument (e.g.
 * `/model gpt-5`, `/agent copilot`) is engine work and returns null.
 */
export function overlayCommandFor(raw: string): RemoteOverlayKind | null {
  const match = /^\/([a-z][a-z-]*)(?:\s+(.*))?$/.exec(raw.trim())
  if (match === null) return null
  const [, name = "", arg] = match
  const hasArg = arg !== undefined && arg.trim().length > 0
  if (name === "model") return hasArg ? null : "models"
  if (name === "agent") return hasArg ? null : "agents"
  if (name === "theme") return hasArg ? null : "themes"
  const table: Record<string, RemoteOverlayKind> = {
    models: "models",
    ctx: "context",
    settings: "settings",
    "init-wizard": "setup",
    memory: "memory",
    skills: "skills",
    usage: "usage",
    keys: "keymap",
    sessions: "sessions",
  }
  return table[name] ?? null
}

/** Local display preferences (config `chat`; the client owns these). */
export interface RemoteChatDisplay {
  thinking: "show" | "hide"
  toolOutput: "expanded" | "collapsed"
  animations: boolean
  cardStyle: "fill" | "border"
}

export interface RemoteChatOptions {
  /** The daemon transport. */
  ws: WsClient
  /** This chat's daemon id. */
  chatId: string
  /** The snapshot from `chat.open`/`chat.attach` (state + meta). */
  state?: ChatState
  /** Local display defaults (config `chat`). */
  display?: Partial<RemoteChatDisplay>
  /** Draft-image store (client-owned). Defaults to a temp dir. */
  imageDir?: string
  /** Resolve a pasted image path's relative base (the bound pane cwd). */
  paneCwd?: () => string | null
  /** User-facing note sink (send failures, busy refusals). */
  onToast?: (message: string, level?: RemoteChatToastLevel) => void
  /** UI-only slash commands open overlays here (client-owned, no engine). */
  onOpenOverlay?: (kind: RemoteOverlayKind) => void
  /**
   * Extra runtime facts the client owns (pane size/terminal/theme) appended to
   * `/status`; the daemon cannot see the client's terminal. Null = none.
   */
  runtimeStatus?: () => string | null
  /** `/theme <name>`: apply + persist the theme (returns an error string). */
  onSetTheme?: (name: string) => string | null
}

/** A `chat.meta` snapshot, or null before the first state arrives. */
type Meta = ChatMeta | null

function defaultImageDir(): string {
  return join(tmpdir(), "sensus-client-draft-images")
}

/** Resolve a user-supplied image path against the pane cwd (no agent deps). */
function resolveImagePath(pathArg: string, cwd: string | null): string {
  if (pathArg.startsWith("~/")) return join(process.env["HOME"] ?? "/", pathArg.slice(2))
  if (isAbsolute(pathArg)) return pathArg
  return join(cwd ?? process.cwd(), pathArg)
}

/**
 * A remote chat session: mirrors the daemon's chat over WS and keeps the local
 * editor/slash/draft/reveal state. Construct with `RemoteChat.create`.
 */
export class RemoteChat {
  readonly chatId: string

  private readonly ws: WsClient
  private readonly onToast: ((message: string, level?: RemoteChatToastLevel) => void) | undefined
  private readonly onOpenOverlay: ((kind: RemoteOverlayKind) => void) | undefined
  private readonly runtimeStatus: (() => string | null) | undefined
  private readonly onSetTheme: ((name: string) => string | null) | undefined
  private readonly imageDir: string
  private readonly paneCwd: (() => string | null) | undefined
  private readonly unsubscribers: Array<() => void> = []

  // -- remote mirror (from chat.state / chat.meta / events) -------------------
  private readonly sMessages = createSignal<ChatMessage[]>([])
  private readonly sStatus = createSignal<ChatStatus>("idle")
  private readonly sMeta = createSignal<Meta>(null)
  private readonly sPendingSudo = createSignal<ChatPendingSudo | null>(null)

  // -- purely-local UI state --------------------------------------------------
  private readonly editor = new InputEditor()
  private readonly reveal = new StreamReveal()
  private readonly history: string[] = []
  private histIdx: number | null = null

  private readonly sSessionTitle = createSignal("")
  private readonly sEditorVersion = createSignal(0)
  private readonly sDraftImages = createSignal<ImageAttachment[]>([])
  private readonly sSlashSelection = createSignal(0)
  private readonly sSlashDismissed = createSignal(false)
  private readonly sThinkingOpen = createSignal<Map<number, boolean>>(new Map())
  private readonly sCardExpand = createSignal<Map<string, boolean>>(new Map())
  private readonly sThinkingMode = createSignal<"show" | "hide">("hide")
  private readonly sToolDetails = createSignal<"expanded" | "collapsed">("collapsed")
  private readonly sAnimations = createSignal(true)
  private readonly sCardStyle = createSignal<"fill" | "border">("fill")
  private disposed = false
  /** Monotonic ids for client-local (non-persisted) system bubbles. */
  private localSeq = 0

  /** The signal surface the UI renders from (mirrors `ChatSession.accessors`). */
  readonly accessors: {
    messages: Accessor<ChatMessage[]>
    sessionTitle: Accessor<string>
    status: Accessor<ChatStatus>
    busyPending: Accessor<{ steer: number; queue: number }>
    totalTokens: Accessor<number>
    approval: Accessor<ChatMeta["approval"]>
    contextEnabled: Accessor<boolean>
    noTools: Accessor<boolean>
    mcpEnabled: Accessor<boolean>
    editorVersion: Accessor<number>
    draftImages: Accessor<ImageAttachment[]>
    slashSelection: Accessor<number>
    contextUsed: Accessor<number>
    cacheRead: Accessor<{ cached: number } | null>
    compactions: Accessor<number>
    pinned: Accessor<boolean>
    streamingSince: Accessor<number>
    thinkingMode: Accessor<"show" | "hide">
    toolDetails: Accessor<"expanded" | "collapsed">
    animations: Accessor<boolean>
    cardStyle: Accessor<"fill" | "border">
    compacting: Accessor<boolean>
  }

  private constructor(opts: RemoteChatOptions) {
    this.ws = opts.ws
    this.chatId = opts.chatId
    this.onToast = opts.onToast
    this.onOpenOverlay = opts.onOpenOverlay
    this.runtimeStatus = opts.runtimeStatus
    this.onSetTheme = opts.onSetTheme
    this.imageDir = opts.imageDir ?? defaultImageDir()
    this.paneCwd = opts.paneCwd
    this.sThinkingMode[1](opts.display?.thinking ?? "hide")
    this.sToolDetails[1](opts.display?.toolOutput ?? "collapsed")
    this.sAnimations[1](opts.display?.animations ?? true)
    this.sCardStyle[1](opts.display?.cardStyle ?? "fill")
    this.subscribe()
    if (opts.state !== undefined) this.applyState(opts.state)

    const meta = (): Meta => this.sMeta[0]()
    this.accessors = {
      messages: this.sMessages[0],
      sessionTitle: this.sSessionTitle[0],
      status: this.sStatus[0],
      busyPending: () => meta()?.busyPending ?? { steer: 0, queue: 0 },
      totalTokens: () => 0,
      approval: () => meta()?.approval ?? "confirm",
      contextEnabled: () => true,
      noTools: () => meta()?.noTools ?? false,
      mcpEnabled: () => meta()?.mcpEnabled ?? true,
      editorVersion: this.sEditorVersion[0],
      draftImages: this.sDraftImages[0],
      slashSelection: this.sSlashSelection[0],
      contextUsed: () => meta()?.contextUsed ?? 0,
      cacheRead: () => (meta() !== null ? { cached: meta()?.cacheRead ?? 0 } : null),
      compactions: () => 0,
      pinned: () => false,
      streamingSince: () => meta()?.streamingSince ?? 0,
      thinkingMode: this.sThinkingMode[0],
      toolDetails: this.sToolDetails[0],
      animations: this.sAnimations[0],
      cardStyle: this.sCardStyle[0],
      compacting: () => meta()?.compacting ?? false,
    }
  }

  /** Build a RemoteChat; the caller has already opened/attached the daemon chat. */
  static create(opts: RemoteChatOptions): RemoteChat {
    return new RemoteChat(opts)
  }

  // -- transport --------------------------------------------------------------

  private subscribe(): void {
    const match = <T extends { chatId: string }>(fn: (payload: T) => void) => (payload: T): void => {
      if (payload.chatId === this.chatId) fn(payload)
    }
    this.unsubscribers.push(
      this.ws.on("chat.state", match((e) => this.applyState(e.state))),
      this.ws.on("chat.meta", match((e) => {
        this.sMeta[1](e.meta)
        // Keep the title accessor live: the auto title lands as a `chat.meta`
        // after the turn settles, with no `chat.state` to follow it.
        this.applySessionTitle(e.meta)
      })),
      this.ws.on("chat.message", match((e) => this.upsertMessage(e.message))),
      this.ws.on("chat.plan", match((e) => this.upsertMessage(e.message))),
      this.ws.on("chat.delta", match((e) => this.applyDelta(e.messageId, e.kind, e.text))),
      this.ws.on("chat.status", match((e) => this.sStatus[1](e.status))),
      this.ws.on("sudo.request", match((e) => this.sPendingSudo[1]({ requestId: e.requestId, command: e.command, prompt: e.prompt }))),
      this.ws.on("sudo.resolved", match((e) => {
        if (this.sPendingSudo[0]()?.requestId === e.requestId) this.sPendingSudo[1](null)
      })),
      this.ws.on("chat.error", match((e) => this.toast(e.message, "error"))),
      // Engine toasts are global (no chatId): relay them so `/clear` etc. show.
      this.ws.on("chat.toast", (e) => this.toast(e.message, (e.level as RemoteChatToastLevel | undefined) ?? "info")),
    )
  }

  private applyState(state: ChatState): void {
    this.sMessages[1]([...state.messages])
    this.sStatus[1](state.status)
    this.sMeta[1](state.meta)
    this.sPendingSudo[1](state.pendingSudo)
    this.applySessionTitle(state.meta)
    this.reveal.reset()
  }

  /**
   * Mirror `meta.sessionTitle` onto the title accessor (the tab reads it).
   * Empty is ignored so a meta that omits the title never clears an existing
   * one (the engine signal is authoritative and only changes deliberately).
   */
  private applySessionTitle(meta: ChatMeta | null | undefined): void {
    const title = meta?.sessionTitle ?? ""
    if (title.length > 0) this.sSessionTitle[1](title)
  }

  private upsertMessage(message: ChatMessage): void {
    this.sMessages[1]((list) => {
      const idx = list.findIndex((m) => m.id === message.id)
      if (idx === -1) return [...list, message]
      const next = list.slice()
      next[idx] = message
      return next
    })
  }

  private applyDelta(messageId: number, kind: "content" | "thinking", text: string): void {
    this.sMessages[1]((list) =>
      list.map((m) =>
        m.id === messageId
          ? kind === "content"
            ? { ...m, content: m.content + text }
            : { ...m, thinking: (m.thinking ?? "") + text }
          : m,
      ),
    )
  }

  /** Append a client-local system bubble (not persisted on the daemon). */
  private appendLocalSystem(text: string): void {
    this.localSeq += 1
    this.sMessages[1]((list) => [
      ...list,
      { id: -this.localSeq, ts: Date.now(), role: "system", content: text, local: true },
    ])
  }

  /** Release WS subscriptions (does not close the daemon chat). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try {
        unsubscribe()
      } catch {
        // ignore
      }
    }
  }

  // -- editor / draft ---------------------------------------------------------

  get editorState(): InputEditor {
    return this.editor
  }

  bumpEditor(): void {
    this.sEditorVersion[1]((v) => v + 1)
  }

  noteTextEdited(): void {
    this.histIdx = null
    this.sSlashDismissed[1](false)
    this.sSlashSelection[1](0)
  }

  setDraft(text: string): void {
    this.editor.setText(text)
    this.noteTextEdited()
    this.bumpEditor()
  }

  getDraft(): string {
    return this.editor.getText()
  }

  clearDraft(): void {
    this.editor.clear()
    this.noteTextEdited()
    this.bumpEditor()
  }

  private pushHistory(text: string): void {
    this.history.push(text)
    if (this.history.length > 50) this.history.shift()
    this.histIdx = null
  }

  historyOlder(): string | null {
    if (this.history.length === 0) return null
    this.histIdx = this.histIdx === null ? this.history.length - 1 : Math.max(0, this.histIdx - 1)
    return this.history[this.histIdx] ?? null
  }

  historyNewer(): string | null {
    if (this.histIdx === null) return null
    this.histIdx++
    if (this.histIdx >= this.history.length) {
      this.histIdx = null
      return ""
    }
    return this.history[this.histIdx] ?? null
  }

  isBrowsingHistory(): boolean {
    return this.histIdx !== null
  }

  // -- slash autocomplete -----------------------------------------------------

  slashMenu(): SlashMenuState | null {
    if (this.sSlashDismissed[0]()) return null
    const cur = this.editor.cursor()
    const first = this.editor.getText().split("\n")[0] ?? ""
    return slashMenuForLine(first, cur.row === 0)
  }

  slashSelect(delta: number, count: number): void {
    if (count <= 0) return
    const cur = this.sSlashSelection[0]()
    this.sSlashSelection[1]((((cur + delta) % count) + count) % count)
  }

  slashDismiss(): void {
    this.sSlashDismissed[1](true)
  }

  acceptSlashCompletion(): boolean {
    const menu = this.slashMenu()
    if (menu === null) return false
    const sel = Math.min(this.sSlashSelection[0](), menu.matches.length - 1)
    const match = menu.matches[sel] ?? menu.matches[0]
    return match !== undefined && this.completeWith(match.name)
  }

  acceptSlashNamed(name: string): boolean {
    const menu = this.slashMenu()
    if (menu === null || !menu.matches.some((m) => m.name === name)) return false
    return this.completeWith(name)
  }

  private completeWith(name: string): boolean {
    if (this.slashMenu() === null) return false
    const res = acceptCompletion(this.getDraft(), name)
    this.editor.setText(res.text)
    this.editor.setCursor(res.cursorRow, res.cursorCol)
    this.histIdx = null
    this.sSlashDismissed[1](false)
    this.sSlashSelection[1](0)
    this.bumpEditor()
    return true
  }

  // -- draft images (client-owned; see the module note) -----------------------

  modelSupportsVision(): boolean {
    return this.sMeta[0]()?.modelSupportsVision ?? false
  }

  private pushDraftImage(att: ImageAttachment): { ok: true } | { ok: false; error: string } {
    const existing = this.sDraftImages[0]()
    if (existing.some((a) => a.id === att.id && a.path === att.path)) return { ok: true }
    if (existing.length >= MAX_ATTACHMENTS) return { ok: false, error: `at most ${MAX_ATTACHMENTS} images per message` }
    this.sDraftImages[1]([...existing, att])
    return { ok: true }
  }

  addDraftImage(bytes: Uint8Array, name: string, mediaTypeHint?: string): { ok: true } | { ok: false; error: string } {
    const stored = storeImageBytes(this.imageDir, bytes, name, mediaTypeHint)
    if (!stored.ok) return { ok: false, error: stored.error }
    return this.pushDraftImage(stored.attachment)
  }

  addDraftImageFromPath(pathArg: string): { ok: true; name: string; bytes: number } | { ok: false; error: string } {
    const full = resolveImagePath(pathArg, this.paneCwd?.() ?? null)
    const att = readImageAttachment(full)
    if (att === null) return { ok: false, error: `not a readable image (png, jpeg, webp, gif): ${full}` }
    const pushed = this.pushDraftImage(att)
    return pushed.ok ? { ok: true, name: att.name, bytes: att.bytes } : pushed
  }

  removeDraftImage(id: string): void {
    this.sDraftImages[1]((list) => list.filter((a) => a.id !== id))
  }

  clearDraftImages(): void {
    if (this.sDraftImages[0]().length > 0) this.sDraftImages[1]([])
  }

  /** Base64 bytes of the draft attachments for `chat.send` (unreadable skipped). */
  private draftImagesForSend(): Array<{ name: string; mediaType: string; data: string }> {
    const out: Array<{ name: string; mediaType: string; data: string }> = []
    for (const att of this.sDraftImages[0]()) {
      try {
        out.push({ name: att.name, mediaType: att.mediaType, data: readFileSync(att.path).toString("base64") })
      } catch {
        // skip an attachment whose file vanished
      }
    }
    return out
  }

  // -- display prefs (local) --------------------------------------------------

  setThinkingMode(mode: "show" | "hide"): void {
    this.sThinkingMode[1](mode)
  }

  toggleThinkingMode(): "show" | "hide" {
    const next = this.sThinkingMode[0]() === "show" ? "hide" : "show"
    this.sThinkingMode[1](next)
    return next
  }

  setToolDetails(mode: "expanded" | "collapsed"): void {
    this.sToolDetails[1](mode)
  }

  toggleToolDetails(): "expanded" | "collapsed" {
    const next = this.sToolDetails[0]() === "expanded" ? "collapsed" : "expanded"
    this.sToolDetails[1](next)
    return next
  }

  setAnimations(enabled: boolean): void {
    this.sAnimations[1](enabled)
  }

  setCardStyle(style: "fill" | "border"): void {
    this.sCardStyle[1](style)
  }

  toggleCardStyle(): "fill" | "border" {
    const next = this.sCardStyle[0]() === "fill" ? "border" : "fill"
    this.sCardStyle[1](next)
    return next
  }

  // -- stream reveal ----------------------------------------------------------

  revealContentCut(id: number, content: string, settled: boolean): number {
    if (!this.sAnimations[0]()) return content.length
    return this.reveal.content(id, content, spinnerFrame, Date.now(), settled)
  }

  revealThinkingCut(id: number, thinking: string, settled: boolean): number {
    if (!this.sAnimations[0]()) return thinking.length
    return this.reveal.thinking(id, thinking, spinnerFrame, Date.now(), settled)
  }

  // -- expand toggles (local) -------------------------------------------------

  thinkingOpen(msgId: number): boolean {
    const override = this.sThinkingOpen[0]().get(msgId)
    if (override !== undefined) return override
    return this.sThinkingMode[0]() === "show"
  }

  toggleThinkingOpen(msgId: number): boolean {
    const map = new Map(this.sThinkingOpen[0]())
    map.set(msgId, !this.thinkingOpen(msgId))
    this.sThinkingOpen[1](map)
    return true
  }

  toggleLastThinkingOpen(): boolean {
    const m = this.findLastMessage((msg) => msg.role === "assistant" && (msg.thinking?.length ?? 0) > 0)
    return m !== null ? this.toggleThinkingOpen(m.id) : false
  }

  cardExpanded(callId: string): boolean {
    const override = this.sCardExpand[0]().get(callId)
    if (override !== undefined) return override
    return this.sToolDetails[0]() === "expanded"
  }

  toggleCardExpand(callId: string): boolean {
    const map = new Map(this.sCardExpand[0]())
    map.set(callId, !this.cardExpanded(callId))
    this.sCardExpand[1](map)
    return true
  }

  toggleLastCardExpand(): boolean {
    const card = this.findLastMessage((m) => m.tool !== undefined)?.tool?.callId ?? null
    return card !== null ? this.toggleCardExpand(card) : false
  }

  // -- meta-derived readouts (from chat.meta) ---------------------------------

  private meta(): Meta {
    return this.sMeta[0]()
  }

  selectedModel(): string {
    return this.meta()?.selectedModel ?? ""
  }

  endpointName(): string {
    return this.meta()?.endpointName ?? ""
  }

  modelName(): string {
    return this.meta()?.modelName ?? ""
  }

  endpoint(): Record<string, unknown> | null {
    return this.meta()?.endpoint ?? null
  }

  modelMeta(): ChatMeta["modelMeta"] {
    return this.meta()?.modelMeta ?? null
  }

  hasKey(): boolean {
    return this.meta()?.hasKey ?? false
  }

  effortOverride(): string | null {
    const setting = this.meta()?.effortSetting
    return setting !== undefined && setting !== "default" ? setting : null
  }

  effortSetting(): string {
    return this.meta()?.effortSetting ?? "default"
  }

  contextLimit(): number {
    return this.meta()?.contextLimit ?? 0
  }

  contextBreakdown(): ChatMeta["contextBreakdown"] {
    const bd = this.meta()?.contextBreakdown
    if (bd !== undefined) return bd
    return {
      percent: 0,
      history: [],
      messages: 0,
      note: "context unavailable for this session",
    } as unknown as ChatMeta["contextBreakdown"]
  }

  agentName(): string {
    return this.meta()?.agentName ?? ""
  }

  agentDef(): ChatMeta["agentDef"] {
    return this.meta()?.agentDef ?? ({} as ChatMeta["agentDef"])
  }

  isWorking(): boolean {
    return this.meta()?.isWorking ?? false
  }

  isBusy(): boolean {
    return this.accessors.status() === "streaming"
  }

  busySendMode(): "steer" | "queue" {
    return "queue"
  }

  activeJobCount(): number {
    return this.meta()?.activeJobCount ?? 0
  }

  mcpStatusFacts(): ChatMeta["mcpStatusFacts"] {
    return this.meta()?.mcpStatusFacts ?? []
  }

  trustPatterns(): ChatMeta["trustPatterns"] {
    return this.meta()?.trustPatterns ?? []
  }

  get sessionFilePath(): string | null {
    return this.meta()?.sessionFilePath ?? null
  }

  // -- remote engine controls -------------------------------------------------

  /** Persist a local title mirror (the daemon owns the real title). */
  setSessionTitle(title: string): void {
    this.sSessionTitle[1](title.trim())
  }

  setApproval(mode: ChatMeta["approval"]): void {
    this.patchMeta({ approval: mode })
    void this.ws.request("chat.setApproval", { chatId: this.chatId, mode }).catch((e: unknown) => this.report(e))
  }

  setMcpEnabled(on: boolean): void {
    this.patchMeta({ mcpEnabled: on })
    void this.ws.request("chat.setMcp", { chatId: this.chatId, enabled: on }).catch((e: unknown) => this.report(e))
  }

  setModelSelection(endpoint: string, model: string): void {
    void this.ws.request("chat.setModel", { chatId: this.chatId, model: `${endpoint}@${model}` }).catch((e: unknown) => this.report(e))
  }

  setAgentSelection(name: string): void {
    void this.ws.request("chat.setAgent", { chatId: this.chatId, agent: name }).catch((e: unknown) => this.report(e))
  }

  setEffortOverride(mode: string): void {
    void this.ws.request("chat.setEffort", { chatId: this.chatId, mode }).catch((e: unknown) => this.report(e))
  }

  cycleEffort(): void {
    void this.ws.request("chat.cycleEffort", { chatId: this.chatId }).catch((e: unknown) => this.report(e))
  }

  grantTrust(tool: string, prefix: string): boolean {
    void this.ws.request("chat.trustAdd", { chatId: this.chatId, tool, prefix }).catch((e: unknown) => this.report(e))
    return true
  }

  revokeTrust(tool: string, prefix: string): boolean {
    void this.ws.request("chat.trustRevoke", { chatId: this.chatId, tool, prefix }).catch((e: unknown) => this.report(e))
    return true
  }

  revokeAllTrust(): number {
    const n = this.trustPatterns().length
    void this.ws.request("chat.trustRevokeAll", { chatId: this.chatId }).catch((e: unknown) => this.report(e))
    return n
  }

  /** Route a line into the chat. The daemon's `chat.send` mode corrects the
   * provisional local mode asynchronously (a busy refusal restores the draft). */
  handleInput(raw: string, _opts: { alternate?: boolean } = {}): "sent" | "empty" | "busy" | "steered" | "queued" {
    const text = raw.trim()
    if (text.length === 0) return "empty"
    // UI-only slash commands open overlays locally (the daemon has no UI).
    if (text.startsWith("/")) {
      const themeArg = /^\/theme\s+(.+)$/.exec(text)
      if (themeArg !== null) {
        const wanted = themeArg[1]!.trim()
        const err = this.onSetTheme?.(wanted) ?? null
        if (err !== null) this.toast(err, "error")
        else this.toast(`theme → ${wanted} (live; persisted to config)`, "success")
        return "sent"
      }
      // Draft images are CLIENT-owned (the daemon cannot see the client disk):
      // `/image <path>` and `/image clear` are handled locally.
      const imageMatch = /^\/image(?:\s+(.*))?$/.exec(text)
      if (imageMatch !== null) {
        const arg = (imageMatch[1] ?? "").trim()
        if (arg === "clear") {
          const n = this.sDraftImages[0]().length
          this.clearDraftImages()
          this.toast(n > 0 ? "attachments cleared" : "no attachments to clear", "info")
          return "sent"
        }
        if (arg.length === 0) {
          this.toast("usage: /image <path> attaches an image file · /image clear removes them", "warn")
          return "sent"
        }
        const res = this.addDraftImageFromPath(arg)
        if (!res.ok) this.toast(`/image: ${res.error}`, "error")
        else this.toast(`attached ${res.name}`, "success")
        return "sent"
      }
      // Display preferences are CLIENT-owned (the daemon's display signals are
      // irrelevant): `/cards`, `/thinking`, `/details` are handled locally.
      const cardsMatch = /^\/cards(?:\s+(\S+))?$/.exec(text)
      if (cardsMatch !== null) {
        const arg = (cardsMatch[1] ?? "").trim()
        if (arg === "fill" || arg === "border") {
          this.setCardStyle(arg)
          this.toast(`card style ${arg}`)
        } else if (arg.length === 0) {
          this.toast(`card style → ${this.toggleCardStyle()}`)
        } else {
          this.toast("usage: /cards [fill|border]", "error")
        }
        return "sent"
      }
      const thinkingMatch = /^\/thinking(?:\s+(\S+))?$/.exec(text)
      if (thinkingMatch !== null) {
        const arg = (thinkingMatch[1] ?? "").trim()
        if (arg === "show" || arg === "hide") {
          this.setThinkingMode(arg)
          this.toast(`thinking display → ${arg}`)
        } else if (arg.length === 0) {
          this.toast(`thinking display → ${this.toggleThinkingMode()}`)
        } else {
          this.toast("usage: /thinking [show|hide]", "error")
        }
        return "sent"
      }
      const detailsMatch = /^\/details(?:\s+(\S+))?$/.exec(text)
      if (detailsMatch !== null) {
        const arg = (detailsMatch[1] ?? "").trim()
        if (arg === "on" || arg === "off") {
          this.setToolDetails(arg === "on" ? "expanded" : "collapsed")
          this.toast(`tool output details ${arg}`)
        } else if (arg.length === 0) {
          const next = this.toggleToolDetails()
          this.toast(next === "expanded" ? "tool output details → on (full output)" : "tool output details → off (preview)")
        } else {
          this.toast("usage: /details [on|off]", "error")
        }
        return "sent"
      }
      const overlay = overlayCommandFor(text)
      if (overlay !== null) {
        try {
          this.onOpenOverlay?.(overlay)
        } catch (e) {
          this.report(e)
        }
        return "sent"
      }
    }
    const provisional: "sent" | "queued" = this.isBusy() ? "queued" : "sent"
    // `/status` also carries the CLIENT's runtime facts (pane size/theme), which
    // the daemon cannot see; append them as a local system bubble.
    if (text === "/status") {
      const extra = this.runtimeStatus?.() ?? null
      if (extra !== null && extra.length > 0) this.appendLocalSystem(extra)
    }
    this.pushHistory(raw)
    const images = this.draftImagesForSend()
    void this.ws
      .request("chat.send", {
        chatId: this.chatId,
        text: raw,
        ...(images.length > 0 ? { images } : {}),
      })
      .then((res) => {
        if (res.mode === "busy") {
          if (this.editor.getText().length === 0) this.setDraft(raw)
          this.toast("busy — try again when the reply settles", "warn")
        } else if (res.accepted) {
          // The daemon staged the attachments; drop the local draft copies.
          this.clearDraftImages()
        }
      })
      .catch((e: unknown) => {
        if (this.editor.getText().length === 0) this.setDraft(raw)
        this.report(e)
      })
    return provisional
  }

  abort(): void {
    void this.ws.request("chat.abort", { chatId: this.chatId }).catch((e: unknown) => this.report(e))
  }

  /** Rewind to just before a user message; the daemon pushes the new state and
   * the local editor is reloaded with the message for editing + resend. */
  revertToUserMessage(id: number): boolean {
    const target = this.sMessages[0]().find((m) => m.id === id && m.role === "user")
    if (target === undefined) return false
    void this.ws
      .request("chat.revert", { chatId: this.chatId, messageId: id })
      .then(() => {
        this.setDraft(target.content)
        this.sDraftImages[1](target.images !== undefined && target.images.length > 0 ? [...target.images] : [])
        this.reveal.reset()
      })
      .catch((e: unknown) => this.report(e))
    return true
  }

  // -- approvals / sudo / plan ------------------------------------------------

  private findLastMessage(pred: (m: ChatMessage) => boolean): ChatMessage | null {
    const list = this.sMessages[0]()
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      if (m !== undefined && pred(m)) return m
    }
    return null
  }

  pendingApproval(): ToolCardData | null {
    return (
      this.findLastMessage(
        (m) => m.tool !== undefined && m.tool.status === "pending" && (m.tool.question ?? "").length === 0,
      )?.tool ?? null
    )
  }

  /** The latest pending ask_user card (a question, not yet answered). Mirrors
   * the engine's `ToolCardBook.pendingAsk` predicate: only a card still
   * `running` is pending. An aborted ask keeps its question with no answer, so
   * a looser check would keep treating it as pending after Esc and divert the
   * next Enter into a `chat.answerAsk` that the daemon rejects with
   * `no_pending_ask` (the real bug this predicate fixes). */
  pendingAsk(): ToolCardData | null {
    return (
      this.findLastMessage(
        (m) =>
          m.tool !== undefined &&
          m.tool.status === "running" &&
          (m.tool.question ?? "").length > 0 &&
          (m.tool.answer ?? null) === null,
      )?.tool ?? null
    )
  }

  pendingSudo(): ChatPendingSudo | null {
    return this.sPendingSudo[0]()
  }

  resolveCard(callId: string, action: "accept" | "reject" | "allow"): boolean {
    const params = {
      chatId: this.chatId,
      callId,
      action: (action === "allow" ? "accept" : action) as "accept" | "reject",
      ...(action === "allow" ? { trust: true } : {}),
    }
    void this.ws.request("approvals.answer", params).catch((e: unknown) => this.report(e))
    return true
  }

  answerAsk(callId: string, answer: string): boolean {
    if (callId.length === 0 || answer.length === 0) return false
    void this.ws.request("chat.answerAsk", { chatId: this.chatId, callId, answer }).catch((e: unknown) => this.report(e))
    return true
  }

  answerSudo(requestId: string, password: string, remember = false): boolean {
    void this.ws.request("sudo.answer", { chatId: this.chatId, requestId, password, remember }).catch((e: unknown) => this.report(e))
    return true
  }

  // -- approval-batch plan (local line state; commit is a remote op) ----------

  private pendingPlanMessage(): ChatMessage | null {
    return this.findLastMessage((m) => m.plan !== undefined && m.plan.resolved !== true)
  }

  pendingPlan(): PlanCardData | null {
    return this.pendingPlanMessage()?.plan ?? null
  }

  private patchPlan(messageId: number, plan: PlanCardData): void {
    this.sMessages[1]((list) => list.map((m) => (m.id === messageId ? { ...m, plan } : m)))
  }

  planMove(delta: number): void {
    const msg = this.pendingPlanMessage()
    const plan = msg?.plan
    if (!msg || !plan) return
    const cursor = Math.max(0, Math.min(plan.lines.length - 1, plan.cursor + delta))
    if (cursor !== plan.cursor) this.patchPlan(msg.id, { ...plan, cursor })
  }

  planToggle(): void {
    const msg = this.pendingPlanMessage()
    const plan = msg?.plan
    if (!msg || !plan) return
    const line = plan.lines[plan.cursor]
    if (!line) return
    this.planSetLine(msg.id, plan, plan.cursor, line.status === "approved" ? "rejected" : "approved")
  }

  planToggleLine(callId: string): void {
    const msg = this.pendingPlanMessage()
    const plan = msg?.plan
    if (!msg || !plan) return
    const idx = plan.lines.findIndex((l) => l.callId === callId)
    const line = idx >= 0 ? plan.lines[idx] : undefined
    if (!line) return
    this.planSetLine(msg.id, plan, idx, line.status === "approved" ? "rejected" : "approved")
  }

  private planSetLine(messageId: number, plan: PlanCardData, idx: number, status: PlanLineStatus): void {
    this.patchPlan(messageId, { ...plan, lines: plan.lines.map((l, i) => (i === idx ? { ...l, status } : l)) })
  }

  planSetHighlighted(status: PlanLineStatus): void {
    const msg = this.pendingPlanMessage()
    const plan = msg?.plan
    if (!msg || !plan) return
    this.planSetLine(msg.id, plan, plan.cursor, status)
  }

  planApproveAll(): void {
    const msg = this.pendingPlanMessage()
    const plan = msg?.plan
    if (!msg || !plan) return
    // Mark non-destructive lines approved, then commit in one step (the
    // "approve the task" intent). Still-pending destructive lines are sent as
    // rejects by planCommit — approve-all never runs them locally or remotely.
    this.patchPlan(msg.id, {
      ...plan,
      lines: plan.lines.map((l) => (l.destructive === true ? l : { ...l, status: "approved" })),
    })
    this.planCommit()
  }

  planDenyAll(): void {
    const msg = this.pendingPlanMessage()
    const plan = msg?.plan
    if (!msg || !plan) return
    this.patchPlan(msg.id, { ...plan, lines: plan.lines.map((l) => ({ ...l, status: "rejected" })) })
  }

  planTrustLine(callId: string): void {
    const msg = this.pendingPlanMessage()
    const plan = msg?.plan
    if (!msg || !plan) return
    const idx = plan.lines.findIndex((l) => l.callId === callId)
    const line = idx >= 0 ? plan.lines[idx] : undefined
    if (!line || line.destructive === true || !line.allowPrefix) return
    this.grantTrust(line.name, line.allowPrefix)
    this.planSetLine(msg.id, plan, idx, "approved")
  }

  planCommit(): boolean {
    const msg = this.pendingPlanMessage()
    const plan = msg?.plan
    if (!msg || !plan) return false
    const decisions = plan.lines.map((l) => ({ callId: l.callId, accept: l.status === "approved" }))
    this.patchPlan(msg.id, { ...plan, resolved: true, outcome: "committed" })
    void this.ws
      .request("chat.planAnswer", { chatId: this.chatId, messageId: msg.id, decisions })
      .catch((e: unknown) => this.report(e))
    return true
  }

  planCancel(): boolean {
    if (this.pendingPlanMessage() === null) return false
    this.abort()
    return true
  }

  // -- internals --------------------------------------------------------------

  private patchMeta(patch: Partial<ChatMeta>): void {
    this.sMeta[1]((m) => (m !== null ? { ...m, ...patch } : m))
  }

  private toast(message: string, level: RemoteChatToastLevel = "info"): void {
    try {
      this.onToast?.(message, level)
    } catch {
      // the toast sink must never throw back into the chat
    }
  }

  private report(e: unknown): void {
    this.toast(e instanceof Error ? e.message : String(e), "error")
  }
}
