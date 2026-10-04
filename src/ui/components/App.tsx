/**
 * App: layout + focus model + global hotkeys + tabs + chat.
 * Exactly one focused region (terminal pane or chat sidebar). Reserved globals
 * (src/core/keymap.ts) are consumed by the OpenTUI keymap layer; every other
 * key goes to the focused region.
 *
 * Tabs (M1/M2): one tab = one native PTY session + one RemoteChat (sidebar
 * shows the active tab's chat). The embedded terminal renderable encodes and
 * sends its own keys/mouse while focused; App does not forward them. Chat
 * input keystrokes are handled HERE (they must never reach the terminal);
 * ChatSidebar only renders.
 */

import { MouseButton, type MouseEvent as OpentuiMouseEvent } from "@opentui/core"
import {
  useRenderer,
  useTerminalDimensions,
  useKeyboard,
  usePaste,
  useSelectionHandler,
  type JSX,
} from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import type { KeyActionId, KeySpec } from "../../core/keymap.ts"
import { findAction, resolveKeymap } from "../../core/keymap.ts"
import { installGlobalKeyLayer, installSelectionCopyLayer, type SensusKeymap } from "../../core/keymapRuntime.ts"
import { mapKeyEventToAction } from "../../terminal/keys.ts"
import { type PanePalette } from "../../terminal/sgr.ts"
import { theme, defaultBackgroundColor, bgProps } from "../../theme/theme.ts"
import { isThemeName, setTheme } from "../../theme/theme.ts"
import { currentThemeName } from "../../theme/themePersist.ts"
import { mergePaletteOverride } from "../../theme/themePalette.ts"
import { resolvedColorMode } from "../../core/colorMode.ts"
import { parseSelectedModel, type LayoutMode, type McpServerStatusFact, type CatalogModel, type RawConfigDoc, type WizardResult } from "../../engine/index.ts"
import { HostAdapter, type ConfigChangeKind } from "../../client/hostAdapter.ts"
import { type RemoteChat } from "../../client/remoteChat.ts"
import { isTooSmall, tooSmallMessage } from "../lib/layout.ts"
import { blinkActivity, reducedMotionEnv, setBlinkAnimations } from "../lib/blink.ts"
import { prefixKeyAction, PrefixMachine } from "../chat/prefix.ts"
import { handleChatKey as chatKeyHandler, routeChatScrollKey } from "../chat/chatKeys.ts"
import { createCommandDispatch } from "../chat/commands.ts"
import { createPasteController } from "../chat/paste.ts"
import { createTabEngine } from "../chat/tabEngine.ts"
import { startTerminalDetection, type TerminalDetectionHandle } from "../chat/terminalDetection.ts"
import { ArmGuard } from "../lib/armGuard.ts"
import {
  applyPaneDefaults,
  applyPanePalette,
  paneColorConfig,
  paneDefaultColors,
  panePaletteFor,
  type PaneColorConfig,
  type PaneDefaultColors,
} from "../lib/paneTheme.ts"
import { ChatSidebar } from "./ChatSidebar.tsx"
import { CommandMenu } from "./CommandMenu.tsx"
import { COMMAND_CATALOG, type CommandId } from "../../core/commandCatalog.ts"
import { lastCodeBlock, lastMessageText, lastUserMessageId } from "./chat/messageActions.ts"
import { decideNotification, notifySequence } from "../lib/notify.ts"
import { AgentPicker } from "./AgentPicker.tsx"
import { ThemePicker } from "./ThemePicker.tsx"
import { ModelPicker } from "./ModelPicker.tsx"
import type { PickerModel } from "./ModelPicker.tsx"
import { SettingsScreen } from "./SettingsScreen.tsx"
import { MemoryManager } from "./MemoryManager.tsx"
import { SkillsManager } from "./SkillsManager.tsx"
import { SessionsSearch } from "./SessionsSearch.tsx"
import { ContextInspector } from "./ContextInspector.tsx"
import type { ContextBreakdown } from "../chat/contextInspector.ts"
import { UsageDashboard } from "./UsageDashboard.tsx"
import { KeymapEditor } from "./KeymapEditor.tsx"
import { McpManager } from "./McpManager.tsx"
import { StatusBar } from "./StatusBar.tsx"
import { SudoPrompt } from "./SudoPrompt.tsx"
import { TabBar } from "./TabBar.tsx"
import { TabRail } from "./TabRail.tsx"
import { TerminalPane } from "./TerminalPane.tsx"
import { PaneDivider } from "./PaneDivider.tsx"
import { ToastPanel } from "./ToastPanel.tsx"
import { WelcomeModal } from "./WelcomeModal.tsx"
import { SetupWizard } from "./SetupWizard.tsx"
import { AttachPicker } from "./AttachPicker.tsx"
import { ResumePicker } from "./ResumePicker.tsx"
import type { AttachCandidate, AttachTarget } from "../../client/attachPicker.ts"
import { candidateTarget, loneAttachTarget, shouldAskAttach } from "../../client/bootPicker.ts"
import type { LoadedSession } from "../../session/store.ts"
import type { SudoRequest, TabView, UiStore, OverlayKind } from "../lib/store.ts"
import { canUseSidebarLayout, clampSidebarWidth, clampSidebarWidthInLayout, clampTabRailWidth, computePaneCells, PANE_DIVIDER_WIDTH, shouldAutoChatOnly } from "../lib/layout.ts"
import type { Toast } from "../lib/toast.ts"

export interface AppProps {
  store: UiStore
  shell: string
  /** Called when the last terminal exits or the last tab closes — sensus quits. */
  onExit: (reason?: string) => void
  /** Config keymap overrides (docs/keybindings.md). */
  keymapOverrides?: Partial<Record<KeyActionId, string>>
  /**
   * M9: the OpenTUI keymap (created in index.tsx over the renderer). Global
   * hotkeys dispatch through it, consuming matched keys before this
   * component's single useKeyboard fires. Optional only as a defensive
   * fallback — when absent dispatchKey keeps the legacy inline hotkey check.
   */
  sensusKeymap?: SensusKeymap
  /** REST/WS host facade (config, agents, skills, memory, sessions, MCP). */
  host: HostAdapter
  /**
   * Boot re-attach picker data (D4): the daemon's live shells/chats, fetched
   * before the app boots. The app presents the picker as an in-app window like
   * Settings; a lone candidate is auto-attached without asking (see
   * `bootPicker.loneAttachTarget`).
   */
  attachCandidates?: AttachCandidate[]
  /**
   * `--resume` picker data: the recent on-disk sessions to choose from. The app
   * presents the picker as an in-app window; the choice becomes tab 1's
   * session (or a fresh boot on Esc/q).
   */
  resumeSessions?: LoadedSession[]
  /**
   * Setup-modal intent (docs/operations.md "Setup flow"). Set by index.tsx:
   *   - "force" — `sensus init` asked for the setup flow explicitly;
   *   - "auto"  — a plain first run (no config / an untouched default) or a
   *     boot config error; the setup flow opens over the live UI so the user is
   *     guided instead of facing a chat with no endpoint.
   * Unset = a configured install; open it later with `` or Ctrl+P.
   */
  setup?: "auto" | "force"
  /** Boot config error (e.g. a bad baseURL) surfaced in the setup modal. */
  setupError?: string | null
}

export function App(props: AppProps): JSX.Element {
  const { store } = props
  const renderer = useRenderer()
  const dims = useTerminalDimensions()
  const keymap: Record<KeyActionId, KeySpec> = resolveKeymap(props.keymapOverrides)

  /** Streaming-close confirmation arm (Ctrl+W / the tab `×`): a second
   * confirmation within the 3s window forces the close. */
  const closeGuard = new ArmGuard({ windowMs: 3000 })
  /** Rewind confirmation arm (mirrors closeGuard): the user message whose
   * `↺ revert` was clicked while the agent was mid-work; a second click on the
   * SAME message within the window aborts the work and rewinds. */
  const revertGuard = new ArmGuard({ windowMs: 3500 })
  let statusTimer: ReturnType<typeof setInterval> | null = null

  // ---- M6 prefix mode (Ctrl+A ...) -------------------------------------
  // State + timer live in the pure machine (src/ui/chat/prefix.ts); the store
  // signal drives the status-bar hint. While armed the terminal renderable is
  // blurred (App passes focused=false), so the second key reaches dispatchKey
  // here — no extra useKeyboard listeners. The pass-through action is the
  // ACTUAL prefix key the user pressed (C-a with the default binding; a custom
  // keymap prefix sends itself through).
  const prefixSpec = keymap["prefix"]
  const prefixAction =
    mapKeyEventToAction({
      name: prefixSpec.name,
      ctrl: prefixSpec.ctrl ?? false,
      meta: prefixSpec.meta ?? false,
      shift: prefixSpec.shift ?? false,
      sequence: prefixSpec.sequence ?? "",
    }) ?? prefixKeyAction()
  const prefix = new PrefixMachine({
    onTimeout: (focus) => {
      // Window expired with no second key: terminal focus gets a plain
      // prefix; chat focus just cancels (the pane is not focused).
      store.setPrefixPending(false)
      if (focus !== "terminal") return
      const tab = store.activeTab()
      if (!tab) return
      void tab.session.sendKeys(prefixAction)
    },
    prefixAction,
  })
  const clearPrefixHint = (): void => {
    prefix.disarm()
    store.setPrefixPending(false)
  }

  // Mid-run shrink below the 20x5 minimum: show a clear notice (and a status
  // bar warning) instead of a broken layout. No crash; recovery is automatic.
  // The same derived guard hides every overlay so a modal can never clip past
  // the tiny frame (and reappears on resize).
  const tooSmall = createMemo(() => isTooSmall(dims().width, dims().height))
  createEffect(() => {
    store.setSizeWarning(tooSmall() ? tooSmallMessage(dims().width, dims().height) : null)
  })

  // Global layout (docs/DESIGN.md "Layout"): `"sidebar"` swaps the horizontal
  // top `TabBar` for a full-height vertical `TabRail` on the far left. The
  // terminal pane stays in the middle and the chat sidebar on the right either
  // way. The rail clamps to its bounds, and the layout silently falls back to
  // `"topbar"` when the rail would starve the pane (`canUseSidebarLayout`).
  const railWidth = (): number => clampTabRailWidth(store.tabRailWidth(), dims().width)
  // The rail's full footprint includes the one-column gap that separates it
  // from the terminal card (mirroring the divider before the chat), so the cell
  // math reserves it. The rendered card itself is `railWidth()`.
  const railFootprint = (): number => railWidth() + PANE_DIVIDER_WIDTH
  // The chat is clamped to its layout bounds only in sidebar mode, so the
  // rail never starves the pane; topbar mode keeps the configured width. In
  // sidebar mode the clamp reserves the rail's footprint too, so the chat and
  // rail together stay within half the terminal (docs/DESIGN.md "Chat sidebar")
  // instead of each independently claiming up to half.
  const layoutChatWidth = (): number => clampSidebarWidthInLayout(store.sidebarWidth(), dims().width, railFootprint())
  const sidebarLayout = (): boolean =>
    store.layoutMode() === "sidebar" && !tooSmall() &&
    canUseSidebarLayout(dims().width, railFootprint(), layoutChatWidth())
  // Chat-only view (Alt+Home, ephemeral): the terminal pane + divider + tab rail
  // are hidden, the chat takes the full terminal width, and the horizontal top
  // tab bar is forced on (mobile-friendly). The configured `layout` is left
  // alone, so toggling off restores it exactly.
  const chatOnly = (): boolean => store.chatOnly()
  const showTopBar = (): boolean => chatOnly() || !sidebarLayout()
  const showRail = (): boolean => !chatOnly() && sidebarLayout()
  // The chat keeps the configured width (sidebar/topbar math) unless chat-only,
  // where it spans the terminal.
  const configuredChatWidth = (): number => (sidebarLayout() ? layoutChatWidth() : store.sidebarWidth())
  const chatWidth = (): number => (chatOnly() ? dims().width : configuredChatWidth())
  const contentHeight = (): number => dims().height - 1 /* status bar */ - (showTopBar() ? 1 : 0) /* top bar */

  // The terminal pane keeps its normal layout cell size even while hidden, so
  // toggling chat-only never SIGWINCH-resizes the shell.
  const cells = (): { cols: number; rows: number } =>
    computePaneCells(dims().width, dims().height, configuredChatWidth(), {
      railWidth: sidebarLayout() ? railFootprint() : 0,
      topBar: !sidebarLayout(),
    })

  // Keep the active PTY/VT sized to the computed pane cells. OpenTUI's
  // layout-driven `onTerminalResize` is unreliable for an INNER layout change
  // (the Alt+./Alt+, sidebar resize, the divider drag): the card narrows but
  // the shell can keep its OLD width, so it wraps at the wrong column.
  // `cells()` is the same math the PTY is spawned with, so driving the active
  // session from it makes the resize deterministic. Skipped below the minimum:
  // the too-small notice replaces the layout, and a transient 1x1 PTY resize
  // would reflow the shell for nothing.
  createEffect(() => {
    if (tooSmall()) return
    const c = cells()
    const session = store.activeTab()?.session
    if (session !== undefined && (session.cols !== c.cols || session.rows !== c.rows)) {
      session.resize(c.cols, c.rows)
    }
  })

  // Auto chat-only (docs/config.md "autoChatOnly", default on): a narrow/mobile
  // terminal starts with the pane hidden — no need to press Alt+Home. The manual
  // toggle overrides it for the session; the config switch turns it off. Re-runs
  // on resize and on a live config reload (configVersion). Skipped below the
  // 20x5 minimum: the too-small notice replaces the whole layout, and applying
  // the view there would clamp focus to the chat and strand it after growing
  // back (the terminal should keep focus across a transient shrink).
  createEffect(() => {
    void store.configVersion()
    const enabled = props.host.getConfig().autoChatOnly
    store.setAutoChatOnly(enabled && !tooSmall() && shouldAutoChatOnly(dims().width))
  })

  /**
   * Pane palette: the embedded VT composes a FIXED palette and ignores the
   * host terminal, so indexed SGR is rewritten to truecolor from the detected
   * (or config-override) palette before it reaches the VT. `paneColors:
   * "index"` disables the rewrite (VT palette). Updated on every detection /
   * reload and pushed to every live session.
   */
  let panePalette: PanePalette | null = null
  const paneConfig = (): PaneColorConfig => paneColorConfig(props.host.getConfig().themePalette)
  const pushPanePalette = (): void => {
    const { mode, boldBright } = paneConfig()
    if (mode === "index") panePalette = null
    applyPanePalette(store.tabs(), panePalette, boldBright)
  }
  // Seed from the config override BEFORE any session spawns, so the pane
  // follows an explicit palette from the first frame (detection merges in
  // later and can only fill entries the override left open).
  {
    const override = props.host.getConfig().themePalette
    panePalette = panePaletteFor(override, mergePaletteOverride(null, override))
  }

  /**
   * Theme default fg/bg for the pane. The embedded VT's own default bg is
   * opaque black: the rewriter re-applies the fg on every reset/39, and
   * `PanePainter` paints the default bg in the composed frame, so the pane
   * background follows the selected theme's bg, or (adaptive theme, bg = null)
   * the terminal's real background from OSC 11.
   */
  const paneDefaults = (): PaneDefaultColors => {
    const t = theme()
    // Config override wins (it is explicit); then the active theme; then the
    // terminal's detected default bg (adaptive theme, bg = null) / constant.
    return paneDefaultColors(props.host.getConfig().themePalette, { fg: t.fg, bg: t.bg }, defaultBackgroundColor())
  }
  const pushPaneDefaults = (): void => {
    const { fg, bg } = paneDefaults()
    applyPaneDefaults(store.tabs(), fg, bg)
  }
  // Theme or palette detection changes → re-apply to every live session.
  createEffect(() => {
    void theme()
    pushPaneDefaults()
  })

  /**
   * Closing a tab whose agent is streaming needs a second confirmation within
   * the arm window (docs/keybindings.md). Closing DETACHES, so the turn is NOT
   * aborted — the notice says so — but the tab still disappears from view.
   * Returns true when the close may proceed; false while it has just armed it.
   */
  const confirmStreamingClose = (tab: TabView, via: "key" | "click"): boolean => {
    if (tab.chat.accessors.status() !== "streaming") return true
    if (closeGuard.isArmed(tab.id)) {
      closeGuard.clear()
      return true
    }
    closeGuard.arm(tab.id)
    store.showToast(
      via === "click"
        ? "agent is generating — click × again to close the tab (it keeps running)"
        : "agent is generating — press Ctrl+W again to close the tab (it keeps running)",
      "warn",
    )
    return false
  }

  /** Apply + persist a theme (live signal + REST config write). */
  const setThemePersisted = (name: string): string | null => {
    if (!isThemeName(name)) return `unknown theme "${name}"`
    setTheme(name)
    void props.host.putConfig({ theme: name }).then((err) => {
      if (err !== null) store.showToast(err, "error", 5000)
    })
    return null
  }

  /** A chat slash command opened an overlay (the overlay loads its own REST data). */
  const openChatOverlay = (kind: string): void => {
    store.setOverlay(kind as OverlayKind)
  }

  /** Client runtime facts for `/status` (pane size/terminal/theme). */
  const runtimeStatus = (): string | null => {
    const tab = store.activeTab()
    const s = tab === null ? null : tab.session.status()
    const palette = store.paletteStatus()
    const info = store.terminalInfo()
    const caps = renderer?.capabilities
    const colorDesc = caps === undefined || caps === null ? "?" : caps.rgb ? "truecolor" : caps.ansi256 ? "256" : "none"
    const parts: string[] = [
      `terminal: ${store.terminalState()}`,
      `focus: ${store.focus()}`,
      ...(s !== null
        ? [`pane size: ${s.cols}x${s.rows}`, `shell: ${s.dead ? `exited (${s.deadStatus ?? 0})` : "running"}`]
        : []),
      `theme: ${currentThemeName()}`,
      `terminal: ${info.name ?? "unrecognized"} · color: ${colorDesc} (${resolvedColorMode()})`,
      ...(palette !== null ? [palette] : []),
    ]
    return parts.join("\n")
  }

  const tabEngine = createTabEngine({
    store,
    ws: props.host.ws,
    shell: props.shell,
    onExit: (reason) => props.onExit(reason),
    renderer,
    cells,
    getPanePalette: () => panePalette,
    paneColorConfig: paneConfig,
    paneDefaults,
    displayForChat: () => ({
      thinking: props.host.getConfig().chat.thinking,
      toolOutput: props.host.getConfig().chat.toolOutput,
      animations: props.host.getConfig().chat.animations,
      cardStyle: props.host.getConfig().chat.cardStyle,
    }),
    runtimeStatus,
    setTheme: setThemePersisted,
    onOverlayOpened: openChatOverlay,
    toast: (message, level, ttl) => store.showToast(message, level, ttl),
    confirmStreamingClose,
  })
  const {
    createSession,
    makeTab,
    openNewTab,
    openSessionTab,
    attachTab,
    closeActiveTab,
    closeTabById,
    handleActiveDeath,
    switchTo,
    pollStatus,
  } = tabEngine

  /** Overlay render gate: hidden (state kept) while the terminal is too small. */
  const overlayShowing = (kind: OverlayKind): boolean => store.overlay() === kind && !tooSmall()

  // ---- Boot pickers (in-app windows) -----------------------------------
  // The re-attach / --resume choices are made over the live layout, exactly
  // like Settings — not in a separate fullscreen renderer. App holds the data
  // the render reads and the resolver the picker's onPick settles.
  const [attachPickerData, setAttachPickerData] = createSignal<AttachCandidate[]>([])
  const [resumePickerData, setResumePickerData] = createSignal<LoadedSession[]>([])
  let resolveAttachPick: ((c: AttachCandidate | null) => void) | null = null
  let resolveResumePick: ((path: string | null) => void) | null = null

  /** Settle the attach pick, closing its overlay. */
  const finishAttachPick = (choice: AttachCandidate | null): void => {
    store.setOverlay(null)
    const resolve = resolveAttachPick
    resolveAttachPick = null
    resolve?.(choice)
  }

  /** Settle the resume pick, closing its overlay. */
  const finishResumePick = (path: string | null): void => {
    store.setOverlay(null)
    const resolve = resolveResumePick
    resolveResumePick = null
    resolve?.(path)
  }

  /**
   * Open the boot picker windows (if any) and return tab 1's identity. The
   * re-attach picker appears only for a real choice (≥2 candidates); a lone
   * candidate is auto-attached, and none starts a fresh tab. `--resume` always
   * offers its recent-session list.
   */
  const resolveBootPickers = async (): Promise<{ attach?: AttachTarget; resumePath?: string }> => {
    let attach: AttachTarget | undefined
    let resumePath: string | undefined

    const candidates = props.attachCandidates
    if (candidates !== undefined && candidates.length > 0) {
      if (shouldAskAttach(candidates)) {
        // Present the picker; wait for the choice (or dismissal → fresh tab).
        const choice = await new Promise<AttachCandidate | null>((resolve) => {
          resolveAttachPick = resolve
          setAttachPickerData([...candidates])
          store.setOverlay("attach")
        })
        if (choice !== null) attach = candidateTarget(choice)
      } else {
        // A lone live pane is auto-attached without asking (the common case is
        // the user having detached one tab).
        const lone = loneAttachTarget(candidates)
        if (lone !== null) attach = lone
      }
    }

    const sessions = props.resumeSessions
    if (sessions !== undefined && sessions.length > 0) {
      const choice = await new Promise<string | null>((resolve) => {
        resolveResumePick = resolve
        setResumePickerData([...sessions])
        store.setOverlay("resume")
      })
      if (choice !== null) resumePath = choice
    }

    return { ...(attach !== undefined ? { attach } : {}), ...(resumePath !== undefined ? { resumePath } : {}) }
  }

  /** Set the sidebar width, clamped to the layout bounds (keyboard + drag). */
  const setSidebarWidth = (width: number): void => {
    store.setSidebarWidth(clampSidebarWidth(width, dims().width))
  }

  const adjustSidebar = (delta: number): void => {
    setSidebarWidth(store.sidebarWidth() + delta)
  }

  // ---- Mouse -----------------------------------------------------------
  // The embedded terminal renderable forwards mouse/wheel natively (including
  // click-to-focus); the renderer's "focused_renderable" event mirrors that
  // click-focus into the store (see onFocusedRenderable below). No manual
  // mouse encoding/forwarding exists.

  /** Card click: approve/reject/allow, answer an ask_user option, drive an
   * approval-batch plan, or toggle a tool card's output / a thinking block. */
  const onCardAction = (
    callId: string,
    kind:
      | "accept"
      | "reject"
      | "allow"
      | "option"
      | "toggle-card"
      | "toggle-thinking"
      | "plan-toggle"
      | "plan-trust"
      | "plan-approve-all"
      | "plan-deny-all"
      | "plan-confirm"
      | "plan-cancel",
    optionIndex?: number,
  ): void => {
    const chat = store.activeTab()?.chat
    if (!chat) return
    if (kind === "option") {
      const ask = chat.pendingAsk()
      const opt = ask?.options?.[optionIndex ?? -1]
      if (opt !== undefined) chat.answerAsk(callId, opt)
      return
    }
    if (kind === "toggle-card") {
      chat.toggleCardExpand(callId)
      return
    }
    if (kind === "toggle-thinking") {
      const id = Number(callId)
      if (Number.isFinite(id)) chat.toggleThinkingOpen(id)
      return
    }
    // Approval-batch plan controls (docs/agent.md "Approval-batch plan card").
    if (kind === "plan-toggle") {
      chat.planToggleLine(callId)
      return
    }
    if (kind === "plan-trust") {
      chat.planTrustLine(callId)
      return
    }
    if (kind === "plan-approve-all") {
      chat.planApproveAll()
      return
    }
    if (kind === "plan-deny-all") {
      chat.planDenyAll()
      return
    }
    if (kind === "plan-confirm") {
      chat.planCommit()
      return
    }
    if (kind === "plan-cancel") {
      chat.planCancel()
      return
    }
    chat.resolveCard(callId, kind)
  }

  /** Whole-block send (Alt+S / palette `send-code-block`): write the newest
   * fenced block to the visible terminal. Multi-line blocks still execute each
   * line, so the click path (below) is the per-command route. */
  const sendCodeBlockToTerminal = (code: string): void => {
    const tab = store.activeTab()
    if (!tab) return
    void tab.session
      .sendText(code)
      .then(() => store.showToast("code sent to terminal", "success", 1500))
      .catch(() => store.showToast("send failed — terminal unavailable", "error"))
  }

  /** Code-row click: a single click pastes the clicked command into the
   * visible terminal (no Enter, so nothing runs); the second click of a
   * double-click presses Enter to run what the first pasted. */
  const onCodeClick = (code: string, run: boolean): void => {
    const tab = store.activeTab()
    if (!tab) return
    void tab.session
      .sendText(run ? "\r" : code)
      .then(() => {
        if (!run) store.showToast("command pasted — double-click to run", "success", 2000)
      })
      .catch(() => store.showToast("send failed — terminal unavailable", "error"))
  }

  /** Copy text to the system clipboard via OSC52 (the drag-select channel)
   * with the standard "copied" toast. Returns success (callers decide the
   * failure note). */
  const copyTextToClipboard = (text: string): boolean => {
    try {
      renderer.copyToClipboardOSC52(text)
      store.showToast("copied to clipboard", "success", 2500)
      return true
    } catch {
      return false
    }
  }

  /** Message label-row `⧉ copy`: raw message text → system clipboard via
   * OSC52. Feedback via toast. */
  const onCopyMessage = (text: string): void => {
    if (text.length === 0) return
    if (!copyTextToClipboard(text)) store.showToast("copy failed — clipboard unavailable", "error", 2500)
  }

  /**
   * User label-row `↺ revert`: rewind the chat to just before that message and
   * reload it into the editor (docs/ui.md "Rewind"). A rewind aborts whatever
   * the agent is doing, so when the session is mid-work the first click only
   * ARMS it (the Ctrl+W pattern) and warns; a second click on the same message
   * within the window confirms. Otherwise it rewinds immediately.
   */
  const onRevertMessage = (id: number): void => {
    const chat = activeChat()
    if (!chat) return
    if (chat.isWorking()) {
      if (!revertGuard.isArmed(id)) {
        revertGuard.arm(id)
        store.showToast("agent is working — click revert again to abort and rewind", "warn", 3500)
        return
      }
      revertGuard.clear()
    }
    if (chat.revertToUserMessage(id)) {
      store.setFocus("sidebar")
      blinkActivity()
    }
  }

  // ---- M7 clickable chrome ---------------------------------------------

  /** Tab-bar click: select the tab; clicking the ACTIVE tab re-focuses the
   * terminal pane (docs/keybindings.md click targets). */
  const onTabClick = (index: number): void => {
    const tab = store.tabs()[index]
    if (!tab) return
    if (store.activeTabId() === tab.id) store.setFocus("terminal")
    else switchTo(tab.id)
  }

  /** Tab-bar `×` click: close that tab (same streaming guard as Ctrl+W). */
  const onTabCloseClick = (index: number): void => {
    const tab = store.tabs()[index]
    if (!tab) return
    if (!confirmStreamingClose(tab, "click")) return
    closeTabById(tab.id, `last tab (${tab.id}) closed by user`)
  }

  /** Status-bar agent chip click (same as Alt+M / /agent): open the picker. */
  const openAgents = (): void => store.setOverlay("agents")

  /** Input-row agent chip click: cycle to the next loaded agent (same
   * per-session + persisted-default semantics as the picker's Enter). */
  const cycleAgent = (): void => {
    const chat = activeChat()
    if (!chat) return
    const agents = props.host.getAgents().agents
    if (agents.length === 0) return
    const current = chat.agentName()
    const idx = agents.findIndex((a) => a.name === current)
    const next = agents[(idx + 1 + agents.length) % agents.length]
    if (next === undefined || next.name === current) return
    const err = props.host.setDefaultAgent(next.name)
    if (err === null) chat.setAgentSelection(next.name)
    if (err !== null) store.showToast(`agent save failed: ${err}`, "error", 4500)
    else store.showToast(`agent → ${next.name}`, "success", 2500)
  }

  /** Status-bar approval indicator click (same as Alt+Y / /yolo). */
  const cycleApproval = (): void => {
    const chat = activeChat()
    if (chat) chat.setApproval(chat.accessors.approval() === "confirm" ? "full-auto" : "confirm")
  }

  /** Copy the CURRENT selection (terminal or chat — opentui's selection is
   * global) to the system clipboard via OSC52, then toast. The selection is
   * deliberately KEPT (not cleared): right-click / ctrl+c can re-copy the
   * same text, and the next click or drag replaces it. Returns whether
   * something was copied. */
  const copySelectionToClipboard = (): boolean => {
    try {
      const selection = renderer.getSelection()
      if (selection === null) return false
      const text = selection.getSelectedText()
      if (text.length === 0) return false
      return copyTextToClipboard(text)
    } catch {
      return false
    }
  }

  /** Copy-on-select (a selection event is emitted once on drag release): ANY
   * non-empty selection in the TUI copies
   * to the clipboard, terminal pane and chat sidebar alike. A plain click
   * (press+release, no drag) yields empty text and is ignored. */
  useSelectionHandler((selection) => {
    try {
      const text = selection.getSelectedText()
      if (text.length === 0) return
      copyTextToClipboard(text)
    } catch {
      // Selection metadata surprises must never take the TUI down.
    }
  })

  /** Root-box mouse handler: right-click copies the current selection. */
  const onRootMouseDown = (e: OpentuiMouseEvent): void => {
    try {
      if (e.button === MouseButton.RIGHT) {
        copySelectionToClipboard()
        return
      }
    } catch {
      // must never take the TUI down
    }
  }

  // ---- Chat keyboard ---------------------------------------------------

  const activeChat = (): RemoteChat | null => store.activeTab()?.chat ?? null

  /**
   * Unified paste (Ctrl+Shift+V / Alt+V; docs/keybindings.md), plus the
   * bracketed `usePaste` route. The routing lives in src/ui/chat/paste.ts; App
   * keeps the `pasteClipboard` name its hotkey/menu call site uses and passes
   * its store + active-chat accessor.
   */
  const paste = createPasteController({ store, activeChat })
  const pasteClipboard = (): void => paste.pasteClipboard()

  // ONE dispatch path for hotkeys and the Ctrl+P palette (src/ui/chat/commands.ts).
  const commandDispatch = createCommandDispatch({
    store,
    activeChat,
    openNewTab,
    closeActiveTab,
    adjustSidebar,
    switchTo,
    paste: pasteClipboard,
    reloadConfig: () => props.host.reload("user"),
  })
  const { handleAction, runCommand } = commandDispatch

  /**
   * Keyboard parity for the mouse-only chat row actions (docs/keybindings.md
   * "Click targets"). App owns the side effects (OSC52 copy, rewind
   * confirmation, pane send); `messageActions.ts` only picks the target.
   * Returns true when the action was one of ours (else the caller delegates to
   * the shared command dispatcher).
   */
  const runMessageAction = (action: KeyActionId): boolean => {
    switch (action) {
      case "copy-message": {
        // "focused/selected message": a live selection wins, else the newest
        // message. Either way the user gets the expected clipboard payload.
        if (copySelectionToClipboard()) return true
        const text = lastMessageText(activeChat()?.accessors.messages() ?? [])
        if (text === null) {
          store.showToast("no message to copy", "warn")
          return true
        }
        onCopyMessage(text)
        return true
      }
      case "revert-message": {
        const id = lastUserMessageId(activeChat()?.accessors.messages() ?? [])
        if (id === null) {
          store.showToast("no user turn to revert", "warn")
          return true
        }
        onRevertMessage(id)
        return true
      }
      case "send-code-block": {
        const code = lastCodeBlock(activeChat()?.accessors.messages() ?? [])
        if (code === null) {
          store.showToast("no code block to send", "warn")
          return true
        }
        sendCodeBlockToTerminal(code)
        return true
      }
      default:
        return false
    }
  }

  /** Hotkey dispatch: our chat-row actions first, then the shared dispatcher. */
  const dispatchAction = (action: KeyActionId): void => {
    if (!runMessageAction(action)) handleAction(action)
  }

  /**
   * Palette dispatch: the new chat-row actions are plain (non-navigating)
   * commands, so a pick closes the palette exactly like the shared wrapper
   * does; everything else delegates to runCommand (which leaves the palette
   * underneath when the pick opens another view).
   */
  const dispatchCommand = (id: CommandId): void => {
    if (id === "copy-message" || id === "revert-message" || id === "send-code-block") {
      const fromMenu = store.overlay() === "menu"
      runMessageAction(id)
      if (fromMenu && store.overlay() === "menu") store.setOverlay(null)
      return
    }
    runCommand(id)
  }

  // Caret-blink gating (docs/DESIGN.md "Motion"): `chat.animations: false` or
  // `SENSUS_REDUCED_MOTION` keeps the input caret solid. The shared blink module
  // owns the paint decision; App just feeds the current preference.
  createEffect(() => {
    const enabled = !reducedMotionEnv() && (activeChat()?.accessors.animations() ?? true)
    setBlinkAnimations(enabled)
  })

  let pendingEscTimer: ReturnType<typeof setTimeout> | null = null
  const clearPendingEsc = (): void => {
    if (pendingEscTimer !== null) {
      clearTimeout(pendingEscTimer)
      pendingEscTimer = null
    }
  }

  /** Enter = send; Alt+Enter / Shift+Enter = newline; the rest edit — the
   * machine lives in chatKeys.ts; App owns only the Esc window (paste and
   * global keys clear it too) and forwards. Message-list scrolling is routed
   * first (chatKeys.routeChatScrollKey). */
  const handleChatKey = (key: {
    name: string
    ctrl: boolean
    meta: boolean
    shift: boolean
    sequence: string
  }): void => {
    const chat = activeChat()
    if (!chat) return
    if (routeChatScrollKey(key, chat, store)) return
    chatKeyHandler(key, chat, {
      clear: clearPendingEsc,
      arm: (fire) => {
        pendingEscTimer = setTimeout(() => {
          pendingEscTimer = null
          fire()
        }, 30)
      },
      pending: () => pendingEscTimer !== null,
    })
  }

  // ---- Keyboard / paste -------------------------------------------------

  /**
   * Single key dispatch point (overlays, global hotkeys, prefix mode, pane /
   * chat routing). `allowPrefix` is false only on the pass-through re-entry
   * from an armed prefix (the prefix hotkey must not re-arm itself then).
   */
  const dispatchKey = (key: {
    name: string
    ctrl: boolean
    meta: boolean
    shift: boolean
    sequence: string
    /** OpenTUI KeyEvent consumers (present on real key events). */
    stopPropagation?(): void
    preventDefault?(): void
  }, allowPrefix: boolean): void => {
    // Below the 20x5 minimum the layout shows only the notice and every overlay
    // is gated off; swallow keys here so a hidden overlay handler is never
    // dispatched (recovery is automatic on resize).
    if (tooSmall()) return
    // Full-screen overlays AND the stacked sudo popup swallow everything
    // (hotkeys + a pending prefix). The sudo popup renders without an overlay;
    // without this it was input-dead and the pane stayed focused.
    if (store.inputCaptured()) {
      // The overlay OWNS this key: consume it so it cannot ALSO reach the
      // embedded terminal. Closing an overlay re-focuses the renderable
      // synchronously, and OpenTUI dispatches global listeners before the
      // focused renderable — without this, the key that dismisses an overlay
      // (Esc) lands on the just-refocused shell as a lone ESC, and readline
      // then swallows the next keystroke as a meta prefix.
      key.stopPropagation?.()
      key.preventDefault?.()
      clearPrefixHint()
      const handler = store.overlayKeyHandler
      if (handler) handler(key)
      else store.setOverlay(null)
      return
    }
    // Any pane/chat key holds the focused caret solid (shared blink phase);
    // global hotkeys poking too is harmless.
    blinkActivity()
    // M6 prefix mode: a second key while armed is resolved by the pure
    // routing table (BEFORE global hotkeys — prefix+k goes to the terminal,
    // tmux-style, not to our keymap). The renderable is blurred while armed,
    // so this is the only path that sees the second key.
    if (allowPrefix && prefix.isArmed) {
      // The second key belongs to the prefix machine and is re-sent to the
      // pane programmatically below — consume it so it never reaches the
      // renderable as well (it is blurred while armed, but disarming
      // re-focuses synchronously within this same dispatch).
      key.stopPropagation?.()
      key.preventDefault?.()
      const decision = prefix.secondKey(key, store.focus())
      store.setPrefixPending(false)
      if (decision.action === "detach") {
        // prefix+d detaches: the daemon keeps the shells and any running turn alive.
        props.onExit("prefix detach")
        return
      }
      if (decision.action === "ignore") return
      if (decision.action === "pass-through") {
        dispatchKey(key, false)
        return
      }
      const tab = store.activeTab()
      if (!tab) return
      void tab.session.sendKeys(decision.prefix).then(() => {
        if (decision.followup !== null) return tab.session.sendKeys(decision.followup)
      })
      return
    }
    // Legacy inline hotkey check — only when no OpenTUI keymap was provided
    // (defensive; index.tsx always creates one). With the keymap, matched
    // hotkeys were consumed upstream and this stage is unreachable.
    if (props.sensusKeymap === undefined) {
      const action = findAction(key, keymap)
      if (action === "prefix") {
        if (!allowPrefix) return // pass-through: C-a behaves as a plain chat key (no-op)
        key.stopPropagation?.()
        key.preventDefault?.()
        prefix.arm(store.focus())
        store.setPrefixPending(true)
        return
      }
      if (action !== null) {
        key.stopPropagation?.()
        key.preventDefault?.()
        dispatchAction(action)
        return
      }
    }
    const tab = store.activeTab()
    if (!tab) return
    if (store.focus() === "terminal") {
      // The embedded renderable owns terminal key encoding and sending while
      // it is focused (global useKeyboard still fires, so we deliberately do
      // nothing here). Chat focus, overlays and the prefix window blur it, so
      // those paths never reach a focused renderable.
      return
    }
    // Chat focus: consume the key (the renderable is blurred, but a
    // focus transition must never let the same key hit both regions).
    key.stopPropagation?.()
    key.preventDefault?.()
    handleChatKey(key)
  }

  // M9: global hotkeys live in the OpenTUI keymap (keymapRuntime.ts). Its
  // listener is PREPENDED on renderer.keyInput, so a matched hotkey is
  // consumed before the useKeyboard dispatch point runs; the layer is gated
  // off while an overlay is open or the prefix window is armed so those keys
  // still reach dispatchKey's overlay/prefix stages. The prefix command
  // cannot fire on the no-re-arm pass-through re-entry: that recursion calls
  // dispatchKey directly (keymap not consulted), and while armed the gate
  // already deactivates the layer.
  const resolvedKeymap = (): Record<KeyActionId, KeySpec> => {
    void store.configVersion()
    return resolveKeymap(props.host.getConfig().keymap)
  }
  // The global hotkey layer is (re)installable so a remap in the keybinding
  // editor takes effect immediately: unregister the old layer, install the new.
  let offGlobalKeys: (() => void) | null = null
  const installHotkeys = (): void => {
    if (!props.sensusKeymap) return
    try {
      offGlobalKeys?.()
    } catch {
      // previous layer already gone
    }
    offGlobalKeys = installGlobalKeyLayer(props.sensusKeymap, {
      // Inert while input is captured, the prefix is armed, or the terminal is
      // below the minimum (keys are swallowed by dispatchKey there).
      gate: () => !store.inputCaptured() && !prefix.isArmed && !tooSmall(),
      catalog: COMMAND_CATALOG,
      onAction: (action) => {
        if (action === "prefix") {
          prefix.arm(store.focus())
          store.setPrefixPending(true)
          return
        }
        dispatchAction(action)
      },
      resolved: resolvedKeymap(),
    })
  }
  installHotkeys()
  onCleanup(() => {
    try {
      offGlobalKeys?.()
    } catch {
      // ignore
    }
  })

  // Selection copy: ctrl+c / ctrl+shift+c copy when a
  // selection exists and fall through otherwise — ctrl+c must keep
  // reaching the terminal pane as ^C when nothing is selected.
  if (props.sensusKeymap) {
    const offSelectionCopy = installSelectionCopyLayer(props.sensusKeymap, {
      gate: () => !tooSmall() && !store.inputCaptured() && !prefix.isArmed && renderer.hasSelection,
      onCopy: copySelectionToClipboard,
    })
    onCleanup(offSelectionCopy)
  }

  // Click-to-focus mirror: the embedded terminal focuses itself natively on a
  // left click; translate that into store focus so the keyboard model follows.
  // (CliRenderEvents.FOCUSED_RENDERABLE === "focused_renderable".)
  const onFocusedRenderable = (current: unknown): void => {
    const session = store.activeTab()?.session ?? null
    if (session !== null && current === session.renderable) store.setFocus("terminal")
  }
  try {
    renderer.on("focused_renderable", onFocusedRenderable)
  } catch {
    // event subscription is optional (older renderer builds)
  }
  onCleanup(() => {
    try {
      renderer.off("focused_renderable", onFocusedRenderable)
    } catch {
      // renderer may be mid-teardown on exit
    }
  })

  useKeyboard((key) => {
    if (key.eventType === "release") return
    dispatchKey(key, true)
  })

  usePaste((event) => {
    const text = new TextDecoder().decode(event.bytes)
    if (text.length === 0) return
    clearPrefixHint() // paste is never a prefix second key
    // The routing (overlay fields / terminal-focus no-op / chat draft) lives in
    // src/ui/chat/paste.ts; `consume` drives the event's propagation.
    const res = paste.handleBracketedPaste(text)
    if (res.consume) {
      event.stopPropagation?.()
      event.preventDefault?.()
    }
  })

  // M5 overlays: settings + model picker + agent picker. Rendered last → on
  // top; the backdrop handles click-outside-to-close.

  /** Settings persist path: write the doc (unknown keys preserved, atomic +
   * .bak via the config-file writer) then reload config live. Literal API keys are first
   * routed into the encrypted secrets store and replaced with `${NAME}` refs
   * (docs/config.md "Secrets"); the `"settings"` reload kind then tells the
   * config-change router to re-seed session display and the layout store
   * (docs/config.md "Live config reload"). */
  const persistSettingsDoc = (doc: RawConfigDoc): string | null => {
    void props.host.putConfigDoc(doc).then((err) => {
      if (err !== null) store.showToast(err, "error", 6000)
      else store.showToast("settings saved", "success", 2500)
    })
    return null
  }

  /**
   * Persist a config patch through the daemon (`PUT /v1/config`); the daemon
   * deep-merges it and captures literal secrets into its store. A failure is
   * toasted; the call returns before the round-trip (the UI's write signatures
   * are synchronous).
   */
  const saveConfig = (patch: Record<string, unknown>, success?: string): void => {
    void props.host.putConfig(patch).then((err) => {
      if (err !== null) store.showToast(err, "error", 6000)
      else if (success !== undefined) store.showToast(success, "success", 2500)
    })
  }

  /**
   * Setup modal completion (docs/operations.md "Setup flow"). The setup
   * writes config itself via the daemon; here we live-reload so the new
   * endpoint/model/theme apply at once, then hand the user to the first-run
   * welcome tour.
   */
  const onSetupDone = (result: WizardResult): void => {
    if (result.status !== "saved") {
      store.setOverlay(null)
      return
    }
    if (result.error !== undefined) {
      store.showToast(`setup: ${result.error}`, "error", 6000)
      return
    }
    props.host.reload()
    // The boot tab was created before setup wrote the model, and model
    // selection is per-session (a config-default change never yanks an open
    // session), so apply the model the user just configured to it explicitly.
    const setupChat = store.activeTab()?.chat
    const configured = parseSelectedModel(props.host.getConfig().model)
    if (setupChat !== undefined && configured !== null) {
      setupChat.setModelSelection(configured.endpoint, configured.model)
    }
    store.clearOverlays()
    if (result.hostSeeded && result.hostPath !== undefined) {
      store.showToast(`seeded ${result.hostPath}`, "success", 3000)
    }
    store.setOverlay("welcome")
  }

  /** Persist the selected model (picker + /model — docs/config.md). */
  const setSelectedModel = (endpoint: string, model: string): string | null => {
    saveConfig({ model: `${endpoint}@${model}` })
    store.bumpModelInfo()
    return null
  }

  /**
   * Persist the tab-strip layout the user picks in the first-run welcome tour
   * (docs/operations.md "Setup flow"). The modal already applied the pick to
   * the live store; this writes `layout` through the daemon so it survives a
   * relaunch.
   */
  const persistWelcomeLayout = (mode: LayoutMode): void => {
    saveConfig({ layout: mode })
  }

  /** Live per-server MCP facts for the manager overlay (reactive via the
   * adapter's status version; never throws). */
  const mcpServers = (): McpServerStatusFact[] => {
    try {
      props.host.mcp.statusVersion()
      return props.host.mcp.serverStatuses()
    } catch {
      return []
    }
  }

  /** Persist one MCP server's config `enabled` flag through the daemon. */
  const toggleMcpServer = (name: string, enabled: boolean): string | null => {
    void props.host.putConfig({ mcp: { servers: { [name]: { enabled } } } }).then((err) => {
      if (err !== null) {
        store.showToast(err, "error", 6000)
        return
      }
      // Re-read the live per-server facts so the manager/chip reflect the flip.
      void props.host.refreshMcp()
      setTimeout(() => void props.host.refreshMcp(), 400)
    })
    return null
  }

  /** Persist a hotkey remap into config `keymap` and hot-reinstall the layer. */
  const setKeyBinding = (action: KeyActionId, spec: string): string | null =>
    patchKeymap(action, spec)

  /** Remove a hotkey override (restore the default) and hot-reinstall. */
  const clearKeyBinding = (action: KeyActionId): string | null => patchKeymap(action, null)

  const patchKeymap = (action: KeyActionId, spec: string | null): string | null => {
    // `null` deletes the key (the daemon's deep-merge semantics).
    saveConfig({ keymap: { [action]: spec } })
    return null
  }

  // ---- Config-change surface list (docs/config.md "Live config reload") ------
  // THE one place that maps a config swap to the config-derived UI surfaces.
  // ChatHost fires `applyConfigChange` after every successful reload; the kind
  // decides which surfaces re-apply. A new config-derived surface is added
  // here — not wired through a new bespoke setter/hook.
  /** Terminal-detection handle (assigned in onMount; reapply = palette merge). */
  let detectionHandle: TerminalDetectionHandle | null = null
  /** Config snapshot the last router pass saw (settings-write layout diff). */
  let lastRoutedConfig = props.host.getConfig()
  const applyConfigChange = (kind: ConfigChangeKind): void => {
    const next = props.host.getConfig()
    const prev = lastRoutedConfig
    lastRoutedConfig = next
    // 1. Palette: re-merge the (possibly edited) themePalette override without
    //    re-probing the terminal, and re-push the pane palette + default fg/bg
    //    to every live session.
    detectionHandle?.reapply()
    pushPaneDefaults()
    // 2. Re-run config-derived reactive effects (autoChatOnly, resolvedKeymap).
    store.bumpConfigVersion()
    // 3. Hotkeys: a keymap edit re-installs the global layer.
    installHotkeys()
    // 4. Chat display: a user reload or a settings write re-seeds EVERY open
    //    tab, so already-rendered bubbles restyle live (Kaneo #25). Internal
    //    reloads (picker/MCP/setup) deliberately leave session-scoped
    //    overrides (`/cards`, `/thinking`, `/details`) alone.
    if (kind !== "internal") {
      for (const tab of store.tabs()) {
        tab.chat.setThinkingMode(next.chat.thinking)
        tab.chat.setToolDetails(next.chat.toolOutput)
        tab.chat.setCardStyle(next.chat.cardStyle)
        tab.chat.setAnimations(next.chat.animations)
      }
    }
    // 5. Settings-only layout fields (docs/config.md "sidebar and keymap"):
    //    applied live, but diffed so an unrelated settings write never clobbers
    //    a session-scoped hotkey resize, and `/reload` leaves them
    //    restart-only.
    if (kind === "settings") {
      if (next.sidebarWidth !== prev.sidebarWidth) setSidebarWidth(next.sidebarWidth)
      if (next.layout !== prev.layout) store.setLayoutMode(next.layout)
      if (next.tabRailWidth !== prev.tabRailWidth) store.setTabRailWidth(next.tabRailWidth)
    }
  }

  onMount(() => {
    // Terminal detection (theme mode / palette / capabilities) lives in
    // src/ui/chat/terminalDetection.ts; App owns the mutable pane palette it
    // updates through `onAppliedPalette`. `reapply()` is driven by the single
    // config-change router above.
    const detection = startTerminalDetection({
      store,
      renderer,
      themePaletteOverride: () => props.host.getConfig().themePalette,
      onAppliedPalette: (merged, override) => {
        // Pane palette for the SGR rewriter (embedded VT has no host hook).
        panePalette = panePaletteFor(override, merged)
        pushPanePalette()
      },
    })
    detectionHandle = detection
    // The single config-change seam: every reload path (chat `/reload`, the
    // agent's `reload` tool, Ctrl+P, settings writes, picker/MCP/keymap reloads)
    // reaches the UI through this one listener.
    const offConfigChange = props.host.onConfigChange(applyConfigChange)
    onCleanup(() => {
      offConfigChange()
      detection.dispose()
    })
  })

  // Renderer background follows the theme live (null → transparent).
  createEffect(() => {
    const bg = theme().bg
    try {
      renderer.setBackgroundColor(bg ?? "transparent")
    } catch {
      // renderer may be mid-teardown on exit
    }
  })

  // Desktop notifications (docs/config.md "notifications"): alert on a reply
  // that finished while the user was elsewhere, or a newly-pending approval.
  // A tab switch only resets the baseline — it never fires a stale alert.
  let prevNotify = { streaming: false, pendingApproval: false }
  let prevNotifyKey: number | null = null
  createEffect(() => {
    const chat = activeChat()
    const key = store.activeTabId()
    const ncfg = props.host.getConfig().notifications
    const next = {
      streaming: chat?.accessors.status() === "streaming",
      // A pending approval OR an unresolved approval-batch plan counts as
      // "the agent is waiting on you" (docs/agent.md "Approval-batch plan card").
      pendingApproval: chat !== null && (chat.pendingApproval() !== null || chat.pendingPlan() !== null),
    }
    const switched = key !== prevNotifyKey
    prevNotifyKey = key
    const reason = switched
      ? null
      : decideNotification(prevNotify, next, ncfg, { overlayOpen: store.inputCaptured() })
    prevNotify = next
    if (reason === null) return
    try {
      process.stdout.write(notifySequence(ncfg.mode, "sensus", reason === "finished" ? "reply finished" : "approval needed"))
    } catch {
      // a notification must never break the TUI
    }
  })

  onMount(() => {
    // Boot one tab: a daemon shell + its bound chat (resuming when --resume
    // chose a transcript). Both are async WS ops now. The boot pickers
    // (re-attach / --resume) are in-app windows over the live layout: this
    // effect opens one, awaits the user's choice, then boots tab 1 from it.
    void (async () => {
      const afterBoot = (): void => {
        pollStatus()
        statusTimer = setInterval(pollStatus, 1000)
        if (props.setup !== undefined) store.setOverlay("setup")
        if (props.setupError !== undefined && props.setupError !== null) {
          store.showToast(props.setupError, "warn", 8000)
        }
      }

      // Resolve tab 1's identity from the boot pickers (if any), then boot.
      const { attach, resumePath } = await resolveBootPickers()

      // Re-attach to an existing daemon shell/chat when the boot picker chose one.
      if (attach !== undefined) {
        if (await attachTab(attach)) {
          afterBoot()
          return
        }
        // fall through to a fresh tab if the attach failed
      }
      const session = await createSession()
      if (session === null) {
        props.onExit("boot without a terminal session")
        return
      }
      const tab = await makeTab(session, resumePath)
      if (tab === null) {
        session.kill()
        session.dispose()
        props.onExit("boot without a chat session")
        return
      }
      store.addTab(tab)
      session.onExit(() => handleActiveDeath(tab.id))
      afterBoot()
    })()
    onCleanup(() => {
      if (statusTimer !== null) clearInterval(statusTimer)
      // DETACH (D4): release the local objects; the daemon keeps every shell.
      for (const t of store.tabs()) {
        try {
          t.chat.dispose()
        } catch {
          // ignore
        }
        try {
          t.session.dispose()
        } catch {
          // ignore
        }
      }
      clearPrefixHint()
    })
  })

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        ...bgProps(theme().bg),
      }}
      onMouseDown={onRootMouseDown}
    >
      <Show
        when={!tooSmall()}
        fallback={<TooSmallNotice message={tooSmallMessage(dims().width, dims().height)} />}
      >
        <Show when={showTopBar()}>
          <TabBar
            tabs={store.tabs()}
            activeTabId={store.activeTabId()}
            width={dims().width}
            onSelectTab={onTabClick}
            onCloseTab={onTabCloseClick}
            onNewTab={openNewTab}
            onOpenMenu={() => store.setOverlay("menu")}
          />
        </Show>
        <box style={{ flexDirection: "row", flexGrow: 1 }}>
          <Show when={showRail()}>
            <TabRail
              tabs={store.tabs()}
              activeTabId={store.activeTabId()}
              width={railWidth()}
              height={contentHeight()}
              onSelectTab={onTabClick}
              onCloseTab={onTabCloseClick}
              onNewTab={openNewTab}
              onOpenMenu={() => store.setOverlay("menu")}
            />
            {/* The rail/terminal gap: a blank column, mirroring the pane
             * divider before the chat (reserved by `railFootprint`). */}
            <box style={{ width: PANE_DIVIDER_WIDTH, ...bgProps(theme().bg) }} />
          </Show>
          {/* Chat-only view: the pane and its divider are unmounted (the
           * renderable detaches on blur — its VT state is preserved). */}
          <Show when={!chatOnly()}>
            <TerminalPane
              session={store.activeTab()?.session ?? null}
              focused={store.focus() === "terminal" && !store.prefixPending() && !store.inputCaptured()}
            />
            <PaneDivider width={chatWidth()} onResize={setSidebarWidth} />
          </Show>
          <ShowChat
            chat={store.activeTab()?.chat ?? null}
            focused={store.focus() === "sidebar" && !store.inputCaptured()}
            width={chatWidth()}
            onMouseDown={() => store.setFocus("sidebar")}
            onCardAction={onCardAction}
            onCodeClick={onCodeClick}
            onCopyMessage={onCopyMessage}
            onRevertMessage={onRevertMessage}
            onCycleAgent={cycleAgent}
            scrollBottomTick={() => store.chatBottomTick()}
            scrollTick={() => store.chatScrollTick()}
            scrollPages={() => store.chatScrollPages()}
          />
        </box>
      </Show>
      <StatusBar
        store={store}
        width={dims().width}
        onOpenAgents={openAgents}
        onToggleApproval={cycleApproval}
        onOpenModels={() => store.setOverlay("models")}
        onOpenContext={() => {
          store.setContextView(null)
          store.setOverlay("context")
        }}
        onCycleThinking={() => {
          const chat = activeChat()
          if (chat) chat.cycleEffort()
        }}
        onCycleTab={() => handleAction("tab-next")}
        onOpenMcp={() => store.setOverlay("mcp")}
      />
      <Show when={overlayShowing("settings")}>
        <SettingsScreen
          store={store}
          config={props.host.getConfig()}
          rawConfig={props.host.getRawConfig()}
          agents={props.host.getAgents().agents}
          persistDoc={persistSettingsDoc}
          testConnection={async (draft) => {
            try {
              const res = await props.host.rest.probeModels({
                provider: draft.provider,
                baseURL: draft.baseURL,
                apiKey: draft.apiKey,
              })
              if (res.error !== null) return { ok: false, error: res.error }
              return { ok: true, models: res.models }
            } catch (e) {
              return { ok: false, error: e instanceof Error ? e.message : String(e) }
            }
          }}
          onSidebarWidth={setSidebarWidth}
          onLayoutMode={(mode) => store.setLayoutMode(mode)}
          onTabRailWidth={(cols) => store.setTabRailWidth(cols)}
          onPickTheme={() => store.setOverlay("themes")}
          onBrowseModels={(_endpointName) => {
            store.setOverlay("models")
          }}
          toast={(message, level, ttl) => store.showToast(message, level, ttl)}
          onClose={() => {
            store.setOverlay(null)
          }}
        />
      </Show>
      <Show when={overlayShowing("memory")}>
        <MemoryManager
          store={store}
          rest={props.host.rest}
          toast={(message, level, ttl) => store.showToast(message, level, ttl)}
          onClose={() => store.setOverlay(null)}
        />
      </Show>
      <Show when={overlayShowing("skills")}>
        <SkillsManager store={store} catalog={props.host.getSkills()} onClose={() => store.setOverlay(null)} />
      </Show>
      <Show when={overlayShowing("usage")}>
        <UsageDashboard
          store={store}
          rest={props.host.rest}
          onClose={() => store.setOverlay(null)}
          onOpenSessionContext={(path, title) => {
            void props.host.sessionContextBreakdown(path).then((view) => {
              if (view === null) {
                store.showToast("couldn't read that session's transcript", "warn", 4000)
                return
              }
              store.setOverlay("context")
              store.setContextView({ title: view.title.length > 0 ? view.title : title, breakdown: view.breakdown })
            })
          }}
        />
      </Show>
      <Show when={overlayShowing("keymap")}>
        <KeymapEditor
          store={store}
          keymap={resolvedKeymap()}
          onSet={setKeyBinding}
          onClear={clearKeyBinding}
          onClose={() => store.setOverlay(null)}
        />
      </Show>
      <Show when={overlayShowing("sessions")}>
        <SessionsSearch
          store={store}
          rest={props.host.rest}
          onAttach={(path) => {
            store.clearOverlays()
            openSessionTab(path)
          }}
          onClose={() => store.setOverlay(null)}
        />
      </Show>
      <Show when={overlayShowing("mcp")}>
        <McpManager
          store={store}
          servers={mcpServers}
          onToggle={toggleMcpServer}
          onClose={() => store.setOverlay(null)}
        />
      </Show>
      <Show when={overlayShowing("context")}>
        <Show
          keyed
          when={store.contextView()}
          fallback={
            <Show
              keyed
              when={store.activeTab()?.chat ?? null}
              fallback={
                <box
                  style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", ...bgProps(theme().bg) }}
                  onMouseDown={() => store.setOverlay(null)}
                >
                  <text selectable={false} style={{ fg: theme().danger, bg: "transparent" }}> no active chat session — Esc to close </text>
                </box>
              }
            >
              {(chat: RemoteChat) => (
                <ContextInspector store={store} chat={chat} onClose={() => store.setOverlay(null)} />
              )}
            </Show>
          }
        >
          {(view: { title: string; breakdown: ContextBreakdown }) => (
            <ContextInspector
              store={store}
              breakdown={view.breakdown}
              title={view.title}
              onClose={() => {
                store.setContextView(null)
                store.setOverlay(null)
              }}
            />
          )}
        </Show>
      </Show>
      <Show when={overlayShowing("models")}>
        <Show
          when={store.activeTab()?.chat ?? null}
          fallback={
            <box
              style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%" }}
              onMouseDown={() => store.setOverlay(null)}
            >
              <text selectable={false} style={{ fg: theme().danger }}> no active chat session — Esc to close </text>
            </box>
          }
        >
          {(chat: () => RemoteChat) => (
            <ModelPicker
              store={store}
              loadModels={async () => {
                try {
                  const res = await props.host.rest.models()
                  const models: PickerModel[] = []
                  for (const ep of res.endpoints as Array<{ name: string; models: CatalogModel[] }>) {
                    for (const m of ep.models) models.push({ ...m, endpoint: ep.name })
                  }
                  return { models, errors: res.errors }
                } catch (e) {
                  return { models: [], errors: [e instanceof Error ? e.message : String(e)] }
                }
              }}
              selectedModel={chat().selectedModel()}
              onPick={(endpoint, model) => {
                // Per-session semantics (docs/config.md): the pick applies to
                // THIS tab now and persists as the default for NEW sessions;
                // other tabs keep what they were using.
                const err = setSelectedModel(endpoint, model)
                if (err === null) chat().setModelSelection(endpoint, model)
                return err
              }}
              onClose={() => store.setOverlay(null)}
            />
          )}
        </Show>
      </Show>
      <Show when={overlayShowing("agents")}>
        <Show
          when={store.activeTab()?.chat ?? null}
          fallback={
            <box
              style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%" }}
              onMouseDown={() => store.setOverlay(null)}
            >
              <text selectable={false} style={{ fg: theme().danger }}> no active chat session — Esc to close </text>
            </box>
          }
        >
          {(chat: () => RemoteChat) => (
            <AgentPicker
              store={store}
              agents={props.host.getAgents().agents}
              activeName={chat().agentName()}
              onPick={(name) => {
                // Same per-session semantics as the model picker.
                const err = props.host.setDefaultAgent(name)
                if (err === null) chat().setAgentSelection(name)
                return err
              }}
              onClose={() => store.setOverlay(null)}
            />
          )}
        </Show>
      </Show>
      <Show when={overlayShowing("themes")}>
        <ThemePicker
          store={store}
          onPick={(name) => setThemePersisted(name)}
          onClose={() => store.setOverlay(null)}
        />
      </Show>
      {/* Sudo popup (docs/agent.md "Sudo"): rendered while a request is
       * pending, ABOVE other overlays (mounted after them). */}
      <Show when={!tooSmall() ? store.sudoRequest() : null}>
        {(req: () => SudoRequest) => <SudoPrompt store={store} request={req()} />}
      </Show>
      <Show when={overlayShowing("menu")}>
        <CommandMenu
          store={store}
          keymap={resolvedKeymap()}
          onRun={dispatchCommand}
          onClose={() => store.setOverlay(null)}
        />
      </Show>
      {/* Boot pickers (D4): presented as in-app windows over the live layout,
       * not their own fullscreen renderer. App opens one, awaits the choice in
       * resolveBootPickers above, then boots tab 1 from it. */}
      <Show when={overlayShowing("attach")}>
        <AttachPicker store={store} candidates={attachPickerData()} onPick={finishAttachPick} />
      </Show>
      <Show when={overlayShowing("resume")}>
        <ResumePicker store={store} sessions={resumePickerData()} onPick={finishResumePick} />
      </Show>
      {/* Setup flow (docs/operations.md): first run, `sensus init`, a boot
       * config error, ``, or Ctrl+P → Setup flow. It writes config.json
       * itself and App live-reloads on completion (onSetupDone above). */}
      <Show when={overlayShowing("setup")}>
        <SetupWizard
          store={store}
          rawConfig={props.host.getRawConfig()}
          hostContent={props.host.getHostMemory()}
          hostCharLimit={props.host.getConfig().memory.hostCharLimit}
          onSaveDoc={(doc) => props.host.putConfigDoc(doc)}
          onSeedHost={async (content) => {
            try {
              const res = await props.host.rest.memoryWrite("host", "rewrite", { content })
              return res.ok
            } catch {
              return false
            }
          }}
          testConnection={async (draft) => {
            try {
              const res = await props.host.rest.probeModels({
                provider: draft.provider,
                baseURL: draft.baseURL,
                apiKey: draft.apiKey,
              })
              if (res.error !== null) return { ok: false, error: res.error }
              return { ok: true, models: res.models }
            } catch (e) {
              return { ok: false, error: e instanceof Error ? e.message : String(e) }
            }
          }}
          onDone={onSetupDone}
        />
      </Show>
      {/* First-run onboarding (after a setup save): a modal over the live UI.
       * Ordinary overlay semantics — Esc/backdrop/last page dismisses it. */}
      <Show when={overlayShowing("welcome")}>
        <WelcomeModal store={store} onClose={() => store.setOverlay(null)} onLayoutPick={persistWelcomeLayout} />
      </Show>
      {/* Toasts float top-right, mounted LAST → above overlays (a settings
       * commit must be visible while the screen is open); hidden entirely
       * on the too-small notice. Keyed: fresh cells per toast. */}
      <Show keyed when={!tooSmall() ? store.toast() : null}>
        {(t: Toast) => <ToastPanel toast={t} screenWidth={dims().width} />}
      </Show>
    </box>
  )
}

/** Full-screen notice shown while the terminal is below the 20x5 minimum. */
function TooSmallNotice(props: { message: string }): JSX.Element {
  const t = () => theme()
  return (
    <box
      style={{
        flexGrow: 1,
        flexDirection: "column",
        paddingTop: 1,
        paddingLeft: 1,
        ...bgProps(t().bg),
      }}
    >
      <text selectable={false} style={{ fg: t().danger }}>{props.message}</text>
      <text selectable={false} style={{ fg: t().muted }}>resize your terminal to recover (minimum size)</text>
    </box>
  )
}

function ShowChat(props: {
  chat: RemoteChat | null
  focused: boolean
  width: number
  onMouseDown?: (e: OpentuiMouseEvent) => void
  onCardAction?: (
    callId: string,
    kind:
      | "accept"
      | "reject"
      | "allow"
      | "option"
      | "toggle-card"
      | "toggle-thinking"
      | "plan-toggle"
      | "plan-trust"
      | "plan-approve-all"
      | "plan-deny-all"
      | "plan-confirm"
      | "plan-cancel",
    optionIndex?: number,
  ) => void
  onCodeClick?: (code: string, run: boolean) => void
  onCopyMessage?: (text: string) => void
  /** User-message `↺ revert`: rewind the chat to that message. */
  onRevertMessage?: (id: number) => void
  onCycleAgent?: () => void
  /** Bumped (via the store) to jump the message list to the newest message. */
  scrollBottomTick?: () => number
  /** Bumped (via the store) to scroll the message list by `scrollPages`. */
  scrollTick?: () => number
  scrollPages?: () => number
}): JSX.Element {
  return (
    // keyed: ChatSidebar captures `props.chat` once (const chat = props.chat),
    // so a tab switch MUST re-create it with the new chat object — a
    // non-keyed Show would keep rendering the first tab's chat forever
    // (surfaced by M6: per-tab transcripts restore per tab).
    <Show keyed when={props.chat} fallback={<box style={{ width: props.width }} />}>
      {(chat: RemoteChat) => (
        <ChatSidebar
          chat={chat}
          focused={props.focused}
          width={props.width}
          onMouseDown={props.onMouseDown}
          onCardAction={props.onCardAction}
          onCodeClick={props.onCodeClick}
          onCopyMessage={props.onCopyMessage}
          onRevertMessage={props.onRevertMessage}
          onCycleAgent={props.onCycleAgent}
          scrollBottomTick={props.scrollBottomTick}
          scrollTick={props.scrollTick}
          scrollPages={props.scrollPages}
        />
      )}
    </Show>
  )
}
