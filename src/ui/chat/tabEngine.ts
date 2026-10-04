/**
 * Tab engine (P4c-iii; D1/D4/D5): the tab / session lifecycle over the CLIENT.
 * One tab = one daemon-owned shell (`terminal.open`) + one daemon chat
 * (`chat.open` bound to that shell). The client owns the VT (`RemoteTerminalSession`)
 * and mirrors the chat (`RemoteChat`); the daemon owns the PTY, engine state and
 * transcript.
 *
 * Close semantics (D4): closing a tab (`Ctrl+W` / the `×`, or the shell
 * exiting) DETACHES it — the daemon shell + chat (and any running agent turn)
 * stay alive and are re-attachable on the next boot. Only typing `exit` in the
 * pane ends that shell (the daemon then releases its bound chat);
 * `sensus daemon stop` is the full teardown.
 */

import type { CliRenderer } from "@opentui/core"
import type { PanePalette, Rgb } from "../../terminal/sgr.ts"
import { errorMessage } from "../../core/util.ts"
import { getLogger } from "../../core/log.ts"
import type { WsClient } from "../../client/wsClient.ts"
import { RemoteTerminalSession } from "../../client/remoteTerminalSession.ts"
import { RemoteChat, type RemoteChatDisplay } from "../../client/remoteChat.ts"
import { partitionReattachTabs, reattachTabs } from "../../client/reattach.ts"
import { nextActiveOnClose } from "../lib/tabs.ts"
import type { TabView, UiStore } from "../lib/store.ts"

export interface TabEngineDeps {
  store: UiStore
  /** The daemon transport (booted by index.tsx). */
  ws: WsClient
  /** The configured shell (tab-title fallback). */
  shell: string
  /** Called when the last tab goes away — the client detaches. */
  onExit(reason?: string): void
  renderer: CliRenderer
  /** Current pane size (initial shell spawn). */
  cells(): { cols: number; rows: number }
  /** Mutable merged pane palette owned by App (updated by detection). */
  getPanePalette(): PanePalette | null
  /** Config-derived pane color mode + bold-bright. */
  paneColorConfig(): { mode: "exact" | "index"; boldBright: boolean }
  /** Theme-derived pane default fg/bg. */
  paneDefaults(): { fg: Rgb | null; bg: Rgb | null }
  /** Local display defaults for a new chat (config `chat`). */
  displayForChat(): RemoteChatDisplay
  /** Client runtime facts appended to `/status` (pane size/theme). */
  runtimeStatus(): string | null
  /** `/theme <name>`: apply + persist; returns an error string or null. */
  setTheme(name: string): string | null
  /** A chat slash command opened an overlay: refresh its data, then show it. */
  onOverlayOpened(kind: string): void
  /** Gate closing a STREAMING tab (arm/confirm); true = proceed. */
  confirmStreamingClose(tab: TabView, via: "key" | "click"): boolean
  /** Note sink for boot/close failures (store.showToast). */
  toast(message: string, level?: "info" | "success" | "warn" | "error", ttlMs?: number): void
}

export interface TabEngine {
  createSession(): Promise<RemoteTerminalSession | null>
  makeTab(session: RemoteTerminalSession, resumePath?: string): Promise<TabView | null>
  openNewTab(): Promise<void>
  openSessionTab(resumePath: string): Promise<void>
  /** Re-attach to an existing daemon shell/chat (boot picker; D4). */
  attachTab(target: { shellId: string; chatId: string | null; title?: string }): Promise<boolean>
  closeActiveTab(): void
  closeTabById(id: number, lastReason: string): void
  handleActiveDeath(id: number): void
  switchTo(id: number): void
  pollStatus(): void
}

export function createTabEngine(deps: TabEngineDeps): TabEngine {
  const { store } = deps
  let nextTabId = 1
  /** Tab-title fallback: the shell's basename (the daemon exposes no foreground command). */
  const shellBase = deps.shell.split("/").pop() ?? "shell"

  const titleFor = (st: { currentCommand: string }): string =>
    st.currentCommand.length > 0 ? st.currentCommand : shellBase

  /** Open a daemon shell and wrap it in a client VT. Null (with a toast) on failure. */
  const createSession = async (): Promise<RemoteTerminalSession | null> => {
    const c = deps.cells()
    try {
      const opened = await deps.ws.terminal.open({ cols: c.cols, rows: c.rows })
      const { mode, boldBright } = deps.paneColorConfig()
      const defaults = deps.paneDefaults()
      return RemoteTerminalSession.create({
        ws: deps.ws,
        shellId: opened.shellId,
        cols: c.cols,
        rows: c.rows,
        renderer: deps.renderer,
        palette: mode === "index" ? null : deps.getPanePalette(),
        boldBright,
        defaultFg: defaults.fg,
        defaultBg: defaults.bg,
        onError: (m) => deps.toast(m, "warn", 3000),
      })
    } catch (e) {
      deps.toast(`terminal open failed: ${errorMessage(e)}`, "error")
      return null
    }
  }

  /** Create the remote chat bound to a shell (resuming a transcript when given). */
  const makeTab = async (session: RemoteTerminalSession, resumePath?: string): Promise<TabView | null> => {
    let opened
    try {
      opened = await deps.ws.chat.open({
        shellId: session.shellId,
        ...(resumePath !== undefined && resumePath.length > 0 ? { resume: resumePath } : {}),
      })
    } catch (e) {
      deps.toast(`chat open failed: ${errorMessage(e)}`, "error")
      return null
    }
    return makeTabFrom(session, opened.chatId, opened.state)
  }

  /** Wrap an existing shell + chat snapshot into a TabView (fresh or attach). */
  const makeTabFrom = (
    session: RemoteTerminalSession,
    chatId: string,
    state: Parameters<typeof RemoteChat.create>[0]["state"],
  ): TabView => {
    const chat = RemoteChat.create({
      ws: deps.ws,
      chatId,
      state,
      display: deps.displayForChat(),
      paneCwd: () => session.status().cwd,
      onToast: (m, level) => deps.toast(m, level, 4000),
      onOpenOverlay: (kind) => deps.onOverlayOpened(kind),
      runtimeStatus: deps.runtimeStatus,
      onSetTheme: deps.setTheme,
    })
    return { id: nextTabId++, title: shellBase, status: null, session, chat }
  }

  /** Release a tab's local objects, leaving the daemon shell + chat alive (D4).
   * Used by both an explicit close and a pane death: the client owns only its
   * mirror, so disposal never stops the daemon-side session or an agent turn. */
  const detachTabEngine = (id: number): void => {
    const tab = store.tabs().find((t) => t.id === id)
    if (tab) {
      tab.chat.dispose()
      tab.session.dispose()
    }
    store.removeTab(id)
  }

  /** A tab's terminal exited: close it, focus a neighbor, or detach on the last. */
  const handleActiveDeath = (id: number): void => {
    const ids = store.tabs().map((t) => t.id)
    if (!ids.includes(id)) return // already closed
    if (ids.length <= 1) {
      deps.onExit(`last terminal (${id}) exited`)
      return
    }
    const wasActive = store.activeTabId() === id
    const nextId = nextActiveOnClose(ids, id)
    detachTabEngine(id)
    if (wasActive && nextId !== null) store.setActiveTab(nextId)
  }

  /**
   * Close a SPECIFIC tab by id (a user action — `×` or Ctrl+W). Always
   * DETACHES: the daemon keeps the shell + chat (and any streaming turn) alive
   * and re-attachable. Closing the LAST tab detaches too, then the client exits.
   * Only `exit` in the pane (or `sensus daemon stop`) ends a shell.
   */
  const closeTabById = (id: number, lastReason: string): void => {
    const ids = store.tabs().map((t) => t.id)
    if (!ids.includes(id)) return // already closed
    const wasActive = store.activeTabId() === id
    const nextId = wasActive ? nextActiveOnClose(ids, id) : null
    detachTabEngine(id)
    if (ids.length <= 1) {
      deps.onExit(lastReason)
      return
    }
    if (wasActive && nextId !== null) store.setActiveTab(nextId)
  }

  /**
   * Light poll: refresh the active tab's status (cwd / alternate screen / dead)
   * so the tab bar and status bar stay current. Status is primarily event-driven
   * (the daemon streams `terminal.status`); this is a safety net.
   */
  const pollStatus = (): void => {
    const tab = store.activeTab()
    if (!tab) return
    const st = tab.session.status()
    store.setTabStatus(tab.id, st)
    store.setTabTitle(tab.id, titleFor(st))
    if (store.terminalState() !== "ok") store.setTerminalState("ok")
    if (st.dead) handleActiveDeath(tab.id)
  }

  const switchTo = (id: number): void => {
    if (store.activeTabId() === id) return
    store.setActiveTab(id)
  }

  /** Open a fresh tab (new daemon shell + fresh chat). */
  const openNewTab = async (): Promise<void> => {    const session = await createSession()
    if (session === null) return
    const tab = await makeTab(session)
    if (tab === null) {
      session.kill()
      session.dispose()
      return
    }
    store.addTab(tab)
    session.onExit(() => handleActiveDeath(tab.id))
  }

  /** Open a past transcript in a NEW tab (resumes it on the daemon). */
  const openSessionTab = async (resumePath: string): Promise<void> => {
    const session = await createSession()
    if (session === null) return
    const tab = await makeTab(session, resumePath)
    if (tab === null) {
      session.kill()
      session.dispose()
      return
    }
    store.addTab(tab)
    session.onExit(() => handleActiveDeath(tab.id))
  }

  /** Re-attach to an existing daemon shell (and its chat, if bound). */
  const attachTab = async (target: { shellId: string; chatId: string | null; title?: string }): Promise<boolean> => {
    const c = deps.cells()
    const { mode, boldBright } = deps.paneColorConfig()
    const defaults = deps.paneDefaults()
    let session: RemoteTerminalSession
    try {
      session = RemoteTerminalSession.create({
        ws: deps.ws,
        shellId: target.shellId,
        cols: c.cols,
        rows: c.rows,
        renderer: deps.renderer,
        palette: mode === "index" ? null : deps.getPanePalette(),
        boldBright,
        defaultFg: defaults.fg,
        defaultBg: defaults.bg,
        onError: (m) => deps.toast(m, "warn", 3000),
      })
    } catch (e) {
      deps.toast(`attach failed: ${errorMessage(e)}`, "error")
      return false
    }
    try {
      let chatId = target.chatId
      let state: Parameters<typeof RemoteChat.create>[0]["state"]
      if (chatId !== null) {
        const attached = await deps.ws.chat.attach({ chatId })
        state = attached.state
      } else {
        const opened = await deps.ws.chat.open({ shellId: target.shellId })
        chatId = opened.chatId
        state = opened.state
      }
      const tab = makeTabFrom(session, chatId, state)
      if (target.title !== undefined && target.title.length > 0) tab.title = target.title
      store.addTab(tab)
      session.onExit(() => handleActiveDeath(tab.id))
      return true
    } catch (e) {
      deps.toast(`attach failed: ${errorMessage(e)}`, "error")
      session.dispose()
      return false
    }
  }

  /** Tab ids with a rebuild in flight: a second recovery pass must not open a
   * second shell for the same tab (the losing session would leak as controller). */
  const rebuilding = new Set<number>()

  /**
   * Rebuild a tab whose daemon shell no longer exists (a daemon restart): open
   * a fresh shell + chat, resume the tab's transcript when it had one, and swap
   * it in place. The stale local mirror is only disposed — nothing is killed,
   * because the daemon-side shell/chat are already gone (D4; docs/daemon-api.md
   * "Lifecycle").
   */
  const recreateTab = async (id: number): Promise<void> => {
    if (rebuilding.has(id)) return
    rebuilding.add(id)
    try {
      await doRecreateTab(id)
    } finally {
      rebuilding.delete(id)
    }
  }

  const doRecreateTab = async (id: number): Promise<void> => {
    const tab = store.tabs().find((t) => t.id === id)
    if (tab === undefined) return
    const resumePath = tab.chat.sessionFilePath ?? undefined
    const title = tab.title
    const session = await createSession()
    if (session === null) return
    let opened
    try {
      opened = await deps.ws.chat.open({
        shellId: session.shellId,
        ...(resumePath !== undefined && resumePath.length > 0 ? { resume: resumePath } : {}),
      })
    } catch (e) {
      deps.toast(`reconnect: could not rebuild a tab: ${errorMessage(e)}`, "warn", 4000)
      try {
        session.kill()
      } catch {
        // the fresh shell may already be gone
      }
      session.dispose()
      return
    }
    // The tab may have been closed (or rebuilt) while the open was in flight.
    if (!store.tabs().some((t) => t.id === id)) {
      try {
        session.kill()
      } catch {
        // already gone
      }
      session.dispose()
      return
    }
    tab.chat.dispose()
    tab.session.dispose()
    const next = makeTabFrom(session, opened.chatId, opened.state)
    next.id = id
    next.title = title
    store.replaceTab(id, next)
    session.onExit(() => handleActiveDeath(next.id))
  }

  /**
   * Reconnect recovery (D5/D12): the daemon drops a socket's shell/chat
   * subscriptions on close, so a `hello` after the initial handshake means the
   * transport reconnected and every open tab must re-attach or the UI freezes on
   * its last state (a spinner that never settles). Each recovery pass takes an
   * epoch: a newer reconnect supersedes an in-flight one, so a flapping socket
   * cannot double-attach. A tab whose shell no longer exists (e.g. the daemon
   * was restarted) is rebuilt in place instead of being orphaned. At boot the
   * first `hello` precedes any tab (openTab awaits its requests), so this is
   * inert then. Lifetime: the engine lives for the app's, so the subscription
   * is not removed.
   */
  let recoveryEpoch = 0
  const recoverTabs = async (): Promise<void> => {
    const epoch = recoveryEpoch + 1
    recoveryEpoch = epoch
    const tabs = [...store.tabs()]
    if (tabs.length === 0) return
    let live: Set<string> | null = null
    try {
      const listed = await deps.ws.terminal.list()
      live = new Set(listed.shells.map((s) => s.shellId))
    } catch (e) {
      // The TUI must never crash on a failed reconnect listing (rule 10): fall
      // back to a best-effort re-attach, but record why it degraded.
      getLogger().child({ component: "ui.tabs" }).warn("terminal list failed during tab recovery", { err: e })
      live = null // listing unavailable: fall back to a best-effort re-attach
    }
    if (epoch !== recoveryEpoch) return
    const { present, missing } = partitionReattachTabs(tabs, live)
    const report = await reattachTabs(deps.ws, present, (m) => deps.toast(`reconnect: ${m}`, "warn", 4000))
    if (epoch !== recoveryEpoch) return
    // Rebuild shells the daemon no longer has: ones the listing already marked
    // missing, plus attaches that failed with `shell_not_found` (the listing was
    // unavailable or raced the daemon). Transient transport failures only toast.
    const rebuild = [...missing, ...report.terminalFailed.filter((f) => f.code === "shell_not_found").map((f) => f.tab)]
    for (const tab of rebuild) {
      if (epoch !== recoveryEpoch) return
      // Only rebuild a tab that is still open.
      if (!store.tabs().some((t) => t.id === tab.id)) continue
      await recreateTab(tab.id)
    }
  }

  deps.ws.on("hello", () => {
    void recoverTabs().catch((e) => {
      // recovery must never crash the tab engine (rule 10) — log and move on
      getLogger().child({ component: "ui.tabs" }).error("tab recovery failed", { err: e })
    })
  })

  const closeActiveTab = (): void => {
    const tab = store.activeTab()
    if (!tab) {
      deps.onExit("close-tab with no active tab")
      return
    }
    if (!deps.confirmStreamingClose(tab, "key")) return
    closeTabById(tab.id, `last tab (${tab.id}) closed by user`)
  }

  return {
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
  }
}
