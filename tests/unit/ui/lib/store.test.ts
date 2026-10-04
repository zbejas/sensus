import { describe, expect, test } from "bun:test"
import { createUiStore, type TabView } from "../../../../src/ui/lib/store.ts"

/** A minimal tab fake — only `id`/`title` are read by the list operations. */
function tab(id: number, title = `t${id}`): TabView {
  return { id, title, status: null, session: {} as never, chat: {} as never }
}

describe("tab list: replace keeps the slot (reconnect rebuild)", () => {
  test("replaceTab swaps contents in place, preserving id, order and active tab", () => {
    const store = createUiStore({ sidebarWidth: 20 })
    store.addTab(tab(1))
    store.addTab(tab(2))
    store.setActiveTab(2)
    const rebuilt = tab(2, "rebuilt")
    store.replaceTab(2, rebuilt)
    expect(store.tabs().map((t) => t.id)).toEqual([1, 2])
    expect(store.tabs()[1]).toBe(rebuilt)
    expect(store.activeTabId()).toBe(2)
  })
})

/**
 * `pushOverlayInput` backs stacked popups (the sudo prompt) that render ABOVE
 * an open overlay and must put its input handlers back when they close. The
 * overlay underneath registers handlers once (its component body does not
 * re-run), so without this a settings/picker screen goes input-dead after a
 * sudo round-trip.
 */
describe("pushOverlayInput (stacked popups vs the overlay underneath)", () => {
  test("puts the displaced handlers back when the popup closes", () => {
    const store = createUiStore({ sidebarWidth: 60 })
    const overlayKey = (): void => {}
    const overlayPaste = (): void => {}
    store.overlayKeyHandler = overlayKey
    store.overlayPasteHandler = overlayPaste

    const popupKey = (): void => {}
    const popupPaste = (): void => {}
    const restore = store.pushOverlayInput(popupKey, popupPaste)
    expect(store.overlayKeyHandler).toBe(popupKey)
    expect(store.overlayPasteHandler).toBe(popupPaste)

    restore()
    expect(store.overlayKeyHandler).toBe(overlayKey)
    expect(store.overlayPasteHandler).toBe(overlayPaste)
  })

  test("restores null when no overlay was open underneath", () => {
    const store = createUiStore({ sidebarWidth: 60 })
    const restore = store.pushOverlayInput(() => {}, () => {})
    restore()
    expect(store.overlayKeyHandler).toBeNull()
    expect(store.overlayPasteHandler).toBeNull()
  })

  test("does not clobber a handler that replaced the popup's own", () => {
    const store = createUiStore({ sidebarWidth: 60 })
    const restore = store.pushOverlayInput(() => {}, () => {})
    // An overlay closed + reopened while the popup was up and now owns input.
    const laterKey = (): void => {}
    const laterPaste = (): void => {}
    store.overlayKeyHandler = laterKey
    store.overlayPasteHandler = laterPaste
    restore()
    expect(store.overlayKeyHandler).toBe(laterKey)
    expect(store.overlayPasteHandler).toBe(laterPaste)
  })

  test("a stale restore is a no-op after setOverlay(null) cleared the handlers", () => {
    const store = createUiStore({ sidebarWidth: 60 })
    const restore = store.pushOverlayInput(() => {}, () => {})
    store.setOverlay(null) // the overlay closed while the popup was up
    restore()
    expect(store.overlayKeyHandler).toBeNull()
    expect(store.overlayPasteHandler).toBeNull()
  })
})

/**
 * `inputCaptured` is what App's dispatch gates on. The sudo popup renders
 * WITHOUT setting `overlay()`, so keying dispatch off `overlay() !== null`
 * left the popup input-dead and the pane focused (regression).
 */
describe("inputCaptured (overlay OR the stacked sudo popup)", () => {
  test("is true for an overlay and for the sudo popup, false otherwise", () => {
    const store = createUiStore({ sidebarWidth: 60 })
    expect(store.inputCaptured()).toBe(false)

    store.setOverlay("settings")
    expect(store.inputCaptured()).toBe(true)
    store.setOverlay(null)
    expect(store.inputCaptured()).toBe(false)

    // A pending sudo request captures input with no overlay open.
    store.setSudoRequest({ command: "sudo ls", resolve: () => {} })
    expect(store.inputCaptured()).toBe(true)
    store.setSudoRequest(null)
    expect(store.inputCaptured()).toBe(false)
  })
})

/**
 * The overlay VIEW TREE: opening a view pushes it; `setOverlay(null)` pops.
 * This is what makes "Ctrl+P → Settings → Esc" walk back to the palette
 * instead of closing everything.
 */
describe("overlay stack (view tree)", () => {
  test("push/pop walks back through the history", () => {
    const store = createUiStore({ sidebarWidth: 60 })
    store.setOverlay("menu")
    expect(store.overlay()).toBe("menu")
    store.setOverlay("settings")
    expect(store.overlay()).toBe("settings")
    expect(store.overlayStack()).toEqual(["menu", "settings"])

    store.setOverlay(null)
    expect(store.overlay()).toBe("menu")
    store.setOverlay(null)
    expect(store.overlay()).toBeNull()
    expect(store.overlayStack()).toEqual([])
  })

  test("re-opening the visible overlay does not stack a duplicate", () => {
    const store = createUiStore({ sidebarWidth: 60 })
    store.setOverlay("menu")
    store.setOverlay("menu")
    expect(store.overlayStack()).toEqual(["menu"])
  })

  test("handlers clear only when the last overlay pops", () => {
    const store = createUiStore({ sidebarWidth: 60 })
    store.setOverlay("menu")
    store.overlayKeyHandler = () => {}
    store.setOverlay("settings")
    store.overlayKeyHandler = () => {}
    store.setOverlay(null) // back to menu: not empty, handler stays
    expect(store.overlay()).toBe("menu")
    expect(store.overlayKeyHandler).not.toBeNull()
    store.setOverlay(null) // empty: cleared
    expect(store.overlayKeyHandler).toBeNull()
    expect(store.overlayPasteHandler).toBeNull()
  })

  test("clearOverlays dismisses the whole tree", () => {
    const store = createUiStore({ sidebarWidth: 60 })
    store.setOverlay("menu")
    store.setOverlay("sessions")
    store.clearOverlays()
    expect(store.overlay()).toBeNull()
    expect(store.overlayStack()).toEqual([])
    expect(store.inputCaptured()).toBe(false)
  })
})

/**
 * Toast severity precedence (docs/ui.md "Toasts"): one visible slot, but a
 * lower-severity toast must not bury a higher-severity one that is still within
 * its TTL — it is DROPPED (never replayed later, which would surface a stale
 * message after the fact).
 */
describe("showToast severity precedence", () => {
  test("a lower-severity toast cannot bury a live higher-severity one and is dropped, not replayed", async () => {
    const store = createUiStore({ sidebarWidth: 60 })
    store.showToast("boom", "error", 30)
    expect(store.toast()?.message).toBe("boom")
    expect(store.toast()?.level).toBe("error")

    store.showToast("ok", "success", 20)
    // Still the error — the success is dropped, not shown.
    expect(store.toast()?.message).toBe("boom")

    await new Promise((resolve) => setTimeout(resolve, 45))
    // The slot clears; the blocked success does NOT resurface.
    expect(store.toast()).toBeNull()
  })

  test("equal or higher severity replaces immediately", () => {
    const store = createUiStore({ sidebarWidth: 60 })
    store.showToast("warn one", "warn", 5000)
    store.showToast("error now", "error", 5000)
    expect(store.toast()?.message).toBe("error now")
    store.showToast("error again", "error", 5000)
    expect(store.toast()?.message).toBe("error again")
    store.showToast("warn later", "warn", 5000)
    expect(store.toast()?.message).toBe("error again") // warn cannot bury error
  })

  test("an expired toast no longer blocks a lower-severity one (boundary inclusive)", () => {
    const store = createUiStore({ sidebarWidth: 60 })
    store.showToast("boom", "error", 0) // expires immediately (same tick)
    store.showToast("ok", "success", 5000)
    expect(store.toast()?.message).toBe("ok")
  })
})

/**
 * The global layout mode + vertical tab-rail width. Options seed the signals
 * (index.tsx passes the resolved config); the settings screen's setters update
 * them live. Both fields are optional on the options object so existing test
 * callers keep compiling.
 */
describe("layout mode + tab rail width", () => {
  test("defaults to sidebar/24 and the setters update them", () => {
    const store = createUiStore({ sidebarWidth: 60 })
    expect(store.layoutMode()).toBe("sidebar")
    expect(store.tabRailWidth()).toBe(24)

    store.setLayoutMode("topbar")
    store.setTabRailWidth(30)
    expect(store.layoutMode()).toBe("topbar")
    expect(store.tabRailWidth()).toBe(30)
  })

  test("options seed the signals from the resolved config", () => {
    const store = createUiStore({ sidebarWidth: 60, layoutMode: "sidebar", tabRailWidth: 40 })
    expect(store.layoutMode()).toBe("sidebar")
    expect(store.tabRailWidth()).toBe(40)
  })
})

/**
 * Focus is a two-way terminal ⇄ chat swap (Shift+Tab). Clicking the vertical
 * rail deliberately does not add a third focus region.
 */
describe("focus cycle", () => {
  test("toggleFocus cycles terminal ⇄ sidebar only", () => {
    const store = createUiStore({ sidebarWidth: 65 })
    store.setFocus("terminal")
    store.toggleFocus()
    expect(store.focus()).toBe("sidebar")
    store.toggleFocus()
    expect(store.focus()).toBe("terminal")
  })
})

/**
 * The ephemeral chat-only view (Alt+Home): hiding the terminal leaves exactly
 * one focusable region, so focus is clamped to the chat while it is on and the
 * configured layout mode is never touched (toggling off restores it exactly).
 */
describe("chat-only view (ephemeral)", () => {
  test("toggle flips the flag and forces focus to the chat", () => {
    const store = createUiStore({ sidebarWidth: 60 })
    expect(store.chatOnly()).toBe(false)
    expect(store.focus()).toBe("terminal")

    store.toggleChatOnly()
    expect(store.chatOnly()).toBe(true)
    expect(store.focus()).toBe("sidebar")

    store.toggleChatOnly()
    expect(store.chatOnly()).toBe(false)
    // Focus stays on the chat after restoring (no surprise jump back).
    expect(store.focus()).toBe("sidebar")
  })

  test("focus writes and tab switches cannot focus the hidden pane", () => {
    const store = createUiStore({ sidebarWidth: 60, chatOnly: true })
    store.setFocus("terminal")
    expect(store.focus()).toBe("sidebar")
    // toggleFocus would flip to terminal — clamped back to the chat.
    store.toggleFocus()
    expect(store.focus()).toBe("sidebar")
    // Selecting a tab re-focuses the pane for the normal layouts; here it stays.
    store.setActiveTab(7)
    expect(store.focus()).toBe("sidebar")
  })

  test("the configured layout mode is untouched (toggle is not persisted)", () => {
    const store = createUiStore({ sidebarWidth: 60, layoutMode: "topbar" })
    store.toggleChatOnly()
    expect(store.layoutMode()).toBe("topbar")
    store.toggleChatOnly()
    expect(store.layoutMode()).toBe("topbar")
  })

  test("auto chat-only (narrow terminal) turns the view on and clamps focus", () => {
    const store = createUiStore({ sidebarWidth: 60, autoChatOnly: true })
    expect(store.autoChatOnly()).toBe(true)
    expect(store.chatOnly()).toBe(true)
    expect(store.focus()).toBe("sidebar")
    // App turning the auto input off (resize wider) clears the view.
    store.setAutoChatOnly(false)
    expect(store.chatOnly()).toBe(false)
  })

  test("a manual override pins the view against the auto input", () => {
    const store = createUiStore({ sidebarWidth: 60, autoChatOnly: true })
    // Force the terminal visible even on a narrow terminal.
    store.toggleChatOnly()
    expect(store.chatOnly()).toBe(false)
    // The auto input flapping does not undo the explicit choice.
    store.setAutoChatOnly(false)
    store.setAutoChatOnly(true)
    expect(store.chatOnly()).toBe(false)
    // Toggle again restores the chat-only view.
    store.toggleChatOnly()
    expect(store.chatOnly()).toBe(true)

    // On a wide terminal (auto off) the override turns it on by hand.
    const wide = createUiStore({ sidebarWidth: 60 })
    wide.toggleChatOnly()
    expect(wide.chatOnly()).toBe(true)
    expect(wide.focus()).toBe("sidebar")
  })
})
