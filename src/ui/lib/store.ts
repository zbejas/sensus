/**
 * UI state store. Solid signals live here (not in components) per
 * docs/architecture.md: "All state lives in small stores."
 *
 * M1 adds: tab list (one tab = one embedded terminal session + its chat
 * session), sidebar width (per-session, not persisted yet), and the chat-input
 * draft (M2 ships the real input; the placeholder already accepts
 * typed/pasted text).
 *
 * The native PTY engine owns the screen, cursor and scrollback; the store only
 * keeps the terminal STATUS facts (cwd/alt-screen/dead) that the UI needs.
 */

import { createSignal, type Accessor } from "solid-js"
import type { TerminalStatus } from "../../terminal/ptySession.ts"
import type { RemoteTerminalSession } from "../../client/remoteTerminalSession.ts"
import type { RemoteChat } from "../../client/remoteChat.ts"
import type { LayoutMode } from "../../engine/index.ts"
import type { ContextBreakdown } from "../chat/contextInspector.ts"
import { defaultTtl, shouldPreemptToast, type Toast, type ToastLevel } from "./toast.ts"

export type Focus = "terminal" | "sidebar"
/** Lifecycle of the embedded terminal engine (replaces the tmux socket state). */
export type TerminalState = "starting" | "ok" | "dead"
/** Full-screen overlay kinds. "menu" is the Ctrl+P command menu; "sudo" is
 * the sudo-password prompt (opened mid-generation). "attach"/"resume" are the
 * boot re-attach / --resume pickers, presented as in-app windows over the live
 * layout (P4c; D4). */
export type OverlayKind = "settings" | "models" | "agents" | "themes" | "menu" | "sudo" | "memory" | "sessions" | "skills" | "usage" | "keymap" | "context" | "welcome" | "setup" | "mcp" | "attach" | "resume"

/** The pending sudo password request (masked sudo popup). */
export interface SudoRequest {
  /** The command that failed (shown masked/shortened in the prompt). */
  command: string
  /** Optional warning line shown by the popup to explain a re-prompt (e.g.
   * "wrong password — try again" after sudo refused the previous password). */
  hint?: string
  /** Resolve with the password, or null when declined/aborted. */
  resolve(password: string | null, remember: boolean): void
}

/** Structural subset of the opentui key event the overlays need. */
export interface OverlayKey {
  name: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  sequence: string
}

export interface TabView {
  id: number
  /** Fallback title (shell basename); the visible title is `tabTitle(tab)`,
   * which prefers the chat session's title (docs/sessions.md "Auto titles"). */
  title: string
  /** Remote PTY session (daemon-hosted; D1/D5). */
  session: RemoteTerminalSession
  /** Latest polled status; null until the first poll. */
  status: TerminalStatus | null
  /** This tab's remote chat session (M2). */
  chat: RemoteChat
}

export interface UiStore {
  focus: Accessor<Focus>
  toggleFocus(): void
  setFocus(f: Focus): void

  /**
   * Ephemeral chat-only view (Alt+Home / the palette's "Chat-only view"): the
   * terminal pane is hidden and the chat takes the full width, with the top tab
   * bar + status bar kept. Not persisted — the configured `layout` mode is left
   * untouched so toggling off restores it. Focus is forced to the chat while on.
   * `chatOnly()` is the EFFECTIVE state: the manual override if one was made,
   * else the runtime auto flag (narrow terminal + config `autoChatOnly`).
   */
  chatOnly: Accessor<boolean>
  setChatOnly(v: boolean): void
  toggleChatOnly(): void
  /** Runtime auto input set by App (narrow terminal + config on). */
  autoChatOnly: Accessor<boolean>
  setAutoChatOnly(v: boolean): void

  tabs: Accessor<TabView[]>
  activeTabId: Accessor<number | null>
  activeTab: Accessor<TabView | null>
  addTab(tab: TabView): void
  removeTab(id: number): void
  /** Swap a tab's contents in place, preserving its id, position and active
   * selection (used when a reconnect rebuilds a tab whose daemon shell died). */
  replaceTab(id: number, tab: TabView): void
  setActiveTab(id: number): void
  setTabTitle(id: number, title: string): void
  setTabStatus(id: number, status: TerminalStatus): void

  sidebarWidth: Accessor<number>
  setSidebarWidth(w: number): void

  /** Global layout: "topbar" (tab strip on row 0) or "sidebar" (vertical tab
   * rail on the left). Seeded from the resolved config; the settings screen
   * updates it live. docs/config.md "layout". */
  layoutMode: Accessor<LayoutMode>
  setLayoutMode(m: LayoutMode): void
  /** Vertical tab rail width in columns (when layout is "sidebar"). */
  tabRailWidth: Accessor<number>
  setTabRailWidth(w: number): void

  /**
   * The overlay VIEW TREE: a stack whose last entry is visible. Opening an
   * overlay pushes onto it, so Esc/click-outside walks BACK through the
   * history (Ctrl+P → Settings → Esc → Ctrl+P). `overlay()` is the top (null
   * when empty).
   */
  overlay: Accessor<OverlayKind | null>
  overlayStack: Accessor<readonly OverlayKind[]>
  /** Push `kind`, or pop the top when `null`. A pop that empties the stack
   * clears the registered key/paste handlers. */
  setOverlay(kind: OverlayKind | null): void
  /** Dismiss every overlay at once (commit actions, e.g. opening a session). */
  clearOverlays(): void
  /**
   * A read-only context snapshot for a SAVED session (set by /usage when a
   * `by session` row is clicked). When present while the `context` overlay is
   * open, the inspector renders it instead of the active tab's live session.
   */
  contextView: Accessor<{ title: string; breakdown: ContextBreakdown } | null>
  setContextView(view: { title: string; breakdown: ContextBreakdown } | null): void
  /** The open overlay registers its key/paste handlers here (App routes
   * ALL input through one dispatch point — multiple useKeyboard listeners
   * would double-handle). Cleared on overlay unmount. */
  overlayKeyHandler: ((key: OverlayKey) => void) | null
  overlayPasteHandler: ((text: string) => void) | null
  /** Temporarily take over overlay input (stacked popups, e.g. the sudo
   * prompt). Registers `key`/`paste`, and returns a restore function that puts
   * the previous handlers back — but only if this pair is still the registered
   * one (an overlay may have closed/reopened meanwhile). */
  pushOverlayInput(key: (key: OverlayKey) => void, paste: (text: string) => void): () => void
  /** True while an input-capturing surface owns the keyboard: a full-screen
   * overlay OR the stacked sudo prompt, which renders without one. App blurs
   * the pane/chat and routes keys/paste through the registered handlers on it. */
  inputCaptured(): boolean

  /** Bumped when the model catalog gains data (status bar ctx-limit refresh). */
  modelInfoVersion: Accessor<number>
  bumpModelInfo(): void

  /** Embedded terminal engine lifecycle (starting/ok/dead). */
  terminalState: Accessor<TerminalState>
  setTerminalState(s: TerminalState): void
  /** M6 prefix mode: true while the Ctrl+A prefix window is open (the
   * status bar shows a "prefix…" hint). */
  prefixPending: Accessor<boolean>
  setPrefixPending(v: boolean): void
  /** Newest toast (floating top-right panel) or null when none is showing. */
  toast: Accessor<Toast | null>
  /** Show a toast. Defaults to info level + the per-level TTL (ui/toast.ts).
   * One slot: the newest toast wins, EXCEPT that a lower-severity toast cannot
   * bury a higher-severity one still within its TTL — it is dropped
   * (ui/toast.ts shouldPreemptToast). */
  showToast(message: string, level?: ToastLevel, ttlMs?: number): void
  /** Terminal-size guard (M4): set while the terminal is below 20x5. */
  sizeWarning: Accessor<string | null>
  setSizeWarning(m: string | null): void
  /** Palette detection summary for /status (App updates on detection/retry). */
  paletteStatus: Accessor<string | null>
  setPaletteStatus(s: string | null): void
  /** Detected terminal identity (XTVERSION/DA1) for /status; null name =
   * unrecognized. */
  terminalInfo: Accessor<{ name: string | null }>
  setTerminalInfo(info: { name: string | null }): void
  /** Bumped by App's config-change router after every successful reload —
   * config-derived effects track this to re-run even when nothing else they
   * read changed (the merged palette can be identity-stable). */
  configVersion: Accessor<number>
  bumpConfigVersion(): void
  /** Pending sudo password request (sudo popup); the overlay renders
   * while set and the resolution clears it. */
  sudoRequest: Accessor<SudoRequest | null>
  setSudoRequest(r: SudoRequest | null): void
  /** Bumped to ask the active chat sidebar to jump its message list to the
   * newest message (Alt+End / the palette's "Jump to latest"). */
  chatBottomTick: Accessor<number>
  requestChatBottom(): void
  /** Bumped to ask the active chat sidebar to scroll its message list by
   * `chatScrollPages` viewport lengths (PgUp/PgDn, Ctrl+Home/End). */
  chatScrollTick: Accessor<number>
  chatScrollPages: Accessor<number>
  requestChatScroll(pages: number): void
}

export interface UiStoreOptions {
  sidebarWidth: number
  /** Optional so existing callers (tests) that pass only `sidebarWidth` keep
   * compiling; defaults match the built-in config. */
  layoutMode?: LayoutMode
  tabRailWidth?: number
  /** Optional seed for the ephemeral chat-only view (tests); default false. */
  chatOnly?: boolean
  /** Optional seed for the auto (narrow-terminal) chat-only input (tests). */
  autoChatOnly?: boolean
}

export function createUiStore(opts: UiStoreOptions): UiStore {
  // Chat-only has two inputs: a runtime `auto` flag (App sets it while the
  // configured `autoChatOnly` is on AND the terminal is narrow) and a manual
  // override (Alt+Home). The override is tri-state: null = follow auto, so the
  // first manual toggle pins the view until the session ends.
  const [autoChatOnly, setAutoChatOnlySignal] = createSignal(opts.autoChatOnly ?? false)
  const [chatOnlyOverride, setChatOnlyOverride] = createSignal<boolean | null>(opts.chatOnly ?? null)
  const chatOnly = (): boolean => chatOnlyOverride() ?? autoChatOnly()
  // Focus is forced to the chat while the terminal pane is hidden: a chat-only
  // view has exactly one focusable region, so a stale "terminal" focus would
  // route keys to a pane that is not rendered. Every focus write goes through
  // this clamp; the seed already honours it so a narrow mobile boot starts on
  // the chat input, not a hidden pane.
  const [focus, writeFocus] = createSignal<Focus>(chatOnly() ? "sidebar" : "terminal")
  const setFocus = (f: Focus): void => {
    writeFocus(chatOnly() ? "sidebar" : f)
  }
  const setChatOnly = (v: boolean): void => {
    setChatOnlyOverride(v)
    if (chatOnly()) writeFocus("sidebar")
  }
  const setAutoChatOnly = (v: boolean): void => {
    setAutoChatOnlySignal(v)
    if (chatOnly()) writeFocus("sidebar")
  }
  const [tabs, setTabs] = createSignal<TabView[]>([])
  const [activeTabId, setActiveTabId] = createSignal<number | null>(null)
  const [sidebarWidth, setSidebarWidth] = createSignal(opts.sidebarWidth)
  const [layoutMode, setLayoutMode] = createSignal<LayoutMode>(opts.layoutMode ?? "sidebar")
  const [tabRailWidth, setTabRailWidth] = createSignal(opts.tabRailWidth ?? 24)
  const [terminalState, setTerminalState] = createSignal<TerminalState>("starting")
  const [prefixPending, setPrefixPending] = createSignal(false)
  const [toast, setToast] = createSignal<Toast | null>(null)
  const [sizeWarning, setSizeWarning] = createSignal<string | null>(null)
  const [paletteStatus, setPaletteStatus] = createSignal<string | null>(null)
  const [terminalInfo, setTerminalInfo] = createSignal<{ name: string | null }>({ name: null })
  const [configVersion, setConfigVersion] = createSignal(0)
  const [sudoRequest, setSudoRequestSignal] = createSignal<SudoRequest | null>(null)
  const [chatBottomTick, setChatBottomTick] = createSignal(0)
  const [chatScrollTick, setChatScrollTick] = createSignal(0)
  const [chatScrollPages, setChatScrollPages] = createSignal(0)
  const [overlayStack, setOverlayStack] = createSignal<readonly OverlayKind[]>([])
  const overlay = (): OverlayKind | null => overlayStack()[overlayStack().length - 1] ?? null
  const [contextView, setContextView] = createSignal<{ title: string; breakdown: ContextBreakdown } | null>(null)
  const [modelInfoVersion, setModelInfoVersion] = createSignal(0)
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  let nextToastId = 1
  /** When the visible toast's TTL ends (0 = nothing visible). */
  let toastExpiresAt = 0

  /** Put a toast in the visible slot and (re)arm its TTL. */
  const presentToast = (message: string, level: ToastLevel, ttlMs: number): void => {
    setToast({ id: nextToastId++, message, level })
    toastExpiresAt = Date.now() + ttlMs
    if (toastTimer !== null) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toastTimer = null
      toastExpiresAt = 0
      setToast(null)
    }, ttlMs)
  }

  const patchTab = (id: number, patch: (t: TabView) => TabView): void => {
    setTabs((list) => list.map((t) => (t.id === id ? patch(t) : t)))
  }

  const store: UiStore = {
    focus,
    toggleFocus: () => setFocus(focus() === "terminal" ? "sidebar" : "terminal"),
    setFocus,

    chatOnly,
    setChatOnly,
    toggleChatOnly: () => setChatOnly(!chatOnly()),
    autoChatOnly,
    setAutoChatOnly,

    tabs,
    activeTabId,
    activeTab: () => {
      const id = activeTabId()
      const list = tabs()
      return list.find((t) => t.id === id) ?? null
    },
    addTab: (tab) => {
      setTabs((list) => [...list, tab])
      setActiveTabId(tab.id)
    },
    /** Remove a tab. Does NOT choose the next active tab — callers use
     * nextActiveOnClose (ui/tabs.ts) and setActiveTab explicitly. */
    removeTab: (id) => {
      const list = tabs()
      const remaining = list.filter((t) => t.id !== id)
      setTabs(remaining)
      if (activeTabId() === id) {
        const last = remaining[remaining.length - 1]
        setActiveTabId(last ? last.id : null)
      }
    },
    setActiveTab: (id) => {
      setFocus("terminal")
      setActiveTabId(id)
    },
    replaceTab: (id, tab) => {
      setTabs((list) => list.map((t) => (t.id === id ? tab : t)))
    },
    setTabTitle: (id, title) => patchTab(id, (t) => (t.title === title ? t : { ...t, title })),
    setTabStatus: (id, st) => patchTab(id, (t) => ({ ...t, status: st })),

    sidebarWidth,
    setSidebarWidth,
    layoutMode,
    setLayoutMode,
    tabRailWidth,
    setTabRailWidth,

    overlay,
    overlayStack,
    setOverlay: (kind) => {
      if (kind === null) {
        const next = overlayStack().slice(0, -1)
        setOverlayStack(next)
        if (next.length === 0) {
          store.overlayKeyHandler = null
          store.overlayPasteHandler = null
        }
        return
      }
      // Dedupe: re-opening the already-visible overlay is a no-op, so the
      // toggle-style hotkeys do not stack duplicates.
      if (kind === "context") setContextView(null)
      setOverlayStack((s) => (s[s.length - 1] === kind ? s : [...s, kind]))
    },
    clearOverlays: () => {
      setOverlayStack([])
      store.overlayKeyHandler = null
      store.overlayPasteHandler = null
    },
    contextView,
    setContextView,
    overlayKeyHandler: null,
    overlayPasteHandler: null,
    pushOverlayInput: (key, paste) => {
      const prevKey = store.overlayKeyHandler
      const prevPaste = store.overlayPasteHandler
      store.overlayKeyHandler = key
      store.overlayPasteHandler = paste
      return () => {
        // Only restore what we ourselves displaced: if another handler has
        // replaced ours, it is the current owner and must not be clobbered.
        if (store.overlayKeyHandler === key) store.overlayKeyHandler = prevKey
        if (store.overlayPasteHandler === paste) store.overlayPasteHandler = prevPaste
      }
    },
    // The sudo popup renders ABOVE whatever overlay is open (or none) and owns
    // input while pending; `overlay()` alone is not enough to detect it.
    inputCaptured: () => overlay() !== null || sudoRequest() !== null,

    modelInfoVersion,
    bumpModelInfo: () => setModelInfoVersion((v) => v + 1),

    terminalState,
    setTerminalState,
    prefixPending,
    setPrefixPending,
    toast,
    showToast: (message, level = "info", ttlMs) => {
      const ttl = ttlMs ?? defaultTtl(level)
      const current = toast()
      // Severity precedence: a lower-severity toast must not bury a
      // higher-severity one still within its TTL. It is DROPPED, not queued —
      // replaying it later would surface a stale message long after the action
      // it described (and could overlap unrelated UI).
      if (current !== null && !shouldPreemptToast(current.level, toastExpiresAt, Date.now(), level)) return
      presentToast(message, level, ttl)
    },

    terminalInfo,
    setTerminalInfo,
    sizeWarning,
    setSizeWarning,
    paletteStatus,
    setPaletteStatus,
    configVersion,
    bumpConfigVersion: () => setConfigVersion((v) => v + 1),

    sudoRequest,
    setSudoRequest: (r) => setSudoRequestSignal(r),

    chatBottomTick,
    requestChatBottom: () => setChatBottomTick((v) => v + 1),
    chatScrollTick,
    chatScrollPages,
    requestChatScroll: (pages) => {
      setChatScrollPages(pages)
      setChatScrollTick((v) => v + 1)
    },
  }
  return store
}