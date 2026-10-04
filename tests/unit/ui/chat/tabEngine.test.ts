/**
 * Tab engine close/detach semantics (D4): closing a tab (Ctrl+W / `×`) or a
 * pane death must NOT kill the daemon shell or abort its agent turn — the
 * client only detaches. Only `exit` in the pane ends a shell (the daemon then
 * releases its chat). These tests drive the engine over a fake store + fake
 * sessions so the "did we kill/abort?" question is observable directly.
 */

import { describe, expect, test } from "bun:test"
import { createTabEngine } from "../../../../src/ui/chat/tabEngine.ts"
import { configureLogger, parseLogLine } from "../../../../src/core/log.ts"
import type { TabView, UiStore } from "../../../../src/ui/lib/store.ts"
import type { WsClient } from "../../../../src/client/wsClient.ts"

interface Spies {
  kill: number
  abort: number
  dispose: number
  /** Optional: count reattach calls during recovery tests. */
  reattach?: () => void
}

function makeTab(id: number, spies: Spies): TabView {
  return {
    id,
    title: "bash",
    status: null,
    session: {
      shellId: `s${id}`,
      kill: () => {
        spies.kill += 1
      },
      dispose: () => {
        spies.dispose += 1
      },
      reattach: () => {
        spies.reattach?.()
        return Promise.resolve()
      },
    },
    chat: {
      chatId: `chat-${id}`,
      abort: () => {
        spies.abort += 1
      },
      dispose: () => {
        spies.dispose += 1
      },
      accessors: { sessionTitle: () => "" },
    },
  } as unknown as TabView
}

function makeStore(initial: TabView[], activeId: number): UiStore {
  let tabs = [...initial]
  let active: number | null = activeId
  return {
    tabs: () => tabs,
    activeTabId: () => active,
    activeTab: () => tabs.find((t) => t.id === active) ?? null,
    removeTab: (id: number) => {
      tabs = tabs.filter((t) => t.id !== id)
      if (active === id) active = tabs[tabs.length - 1]?.id ?? null
    },
    setActiveTab: (id: number) => {
      active = id
    },
  } as unknown as UiStore
}

function makeEngine(store: UiStore): { closeTabById: (id: number, reason: string) => void; handleActiveDeath: (id: number) => void; exits: string[] } {
  const exits: string[] = []
  const engine = createTabEngine({
    store,
    ws: { on: () => () => {} } as unknown as WsClient,
    shell: "/bin/bash",
    onExit: (reason) => exits.push(reason ?? ""),
    renderer: {} as never,
    cells: () => ({ cols: 80, rows: 24 }),
    getPanePalette: () => null,
    paneColorConfig: () => ({ mode: "exact", boldBright: true }),
    paneDefaults: () => ({ fg: null, bg: null }),
    displayForChat: () => ({ thinking: "hide", toolOutput: "collapsed", animations: false, cardStyle: "border" }),
    runtimeStatus: () => null,
    setTheme: () => null,
    onOverlayOpened: () => {},
    confirmStreamingClose: () => true,
    toast: () => {},
  })
  return { closeTabById: engine.closeTabById, handleActiveDeath: engine.handleActiveDeath, exits }
}

/** A tab engine over a fake transport + toast sink (reconnect-recovery tests). */
function makeRecoveryEngine(store: UiStore, ws: Partial<WsClient>, toast: (message: string) => void) {
  return createTabEngine({
    store,
    ws: ws as WsClient,
    shell: "/bin/bash",
    onExit: () => {},
    renderer: {} as never,
    cells: () => ({ cols: 80, rows: 24 }),
    getPanePalette: () => null,
    paneColorConfig: () => ({ mode: "exact", boldBright: true }),
    paneDefaults: () => ({ fg: null, bg: null }),
    displayForChat: () => ({ thinking: "hide", toolOutput: "collapsed", animations: false, cardStyle: "border" }),
    runtimeStatus: () => null,
    setTheme: () => null,
    onOverlayOpened: () => {},
    confirmStreamingClose: () => true,
    toast,
  })
}

describe("tab engine: closing detaches, never kills or aborts", () => {
  test("closing a non-last tab detaches and focuses the left neighbor", () => {
    const spies: Spies = { kill: 0, abort: 0, dispose: 0 }
    const store = makeStore([makeTab(1, spies), makeTab(2, spies)], 2)
    const engine = makeEngine(store)
    engine.closeTabById(2, "closed")
    expect(store.tabs().map((t) => t.id)).toEqual([1])
    expect(store.activeTabId()).toBe(1)
    expect(spies.kill).toBe(0)
    expect(spies.abort).toBe(0)
    expect(spies.dispose).toBe(2) // session + chat mirrors released
    expect(engine.exits).toEqual([])
  })

  test("closing the last tab detaches, then the client exits", () => {
    const spies: Spies = { kill: 0, abort: 0, dispose: 0 }
    const store = makeStore([makeTab(1, spies)], 1)
    const engine = makeEngine(store)
    engine.closeTabById(1, "last tab closed")
    expect(store.tabs()).toEqual([])
    expect(spies.kill).toBe(0)
    expect(spies.abort).toBe(0)
    expect(engine.exits).toEqual(["last tab closed"])
  })

  test("a pane death (exit) detaches without killing an already-dead shell", () => {
    const spies: Spies = { kill: 0, abort: 0, dispose: 0 }
    const store = makeStore([makeTab(1, spies), makeTab(2, spies)], 2)
    const engine = makeEngine(store)
    engine.handleActiveDeath(2)
    expect(store.tabs().map((t) => t.id)).toEqual([1])
    expect(store.activeTabId()).toBe(1)
    expect(spies.kill).toBe(0)
    expect(spies.abort).toBe(0)
    expect(engine.exits).toEqual([])
  })

  test("the last pane dying exits the client (no kill)", () => {
    const spies: Spies = { kill: 0, abort: 0, dispose: 0 }
    const store = makeStore([makeTab(1, spies)], 1)
    const engine = makeEngine(store)
    engine.handleActiveDeath(1)
    expect(spies.kill).toBe(0)
    expect(engine.exits).toHaveLength(1)
  })
})

describe("tab engine: recovery failures are logged, never crash (rule 10)", () => {
  test("a failed terminal.list during recovery logs a warn and still re-attaches", async () => {
    const lines: string[] = []
    configureLogger({ sink: (l) => lines.push(l), level: "debug" })
    try {
      const store = makeStore([makeTab(1, { kill: 0, abort: 0, dispose: 0 })], 1)
      const hellos: Array<() => void> = []
      const engine = createTabEngine({
        store,
        ws: {
          on: (event: string, cb: () => void) => {
            if (event === "hello") hellos.push(cb)
            return () => {}
          },
          terminal: { list: () => Promise.reject(new Error("socket down")) },
        } as unknown as WsClient,
        shell: "/bin/bash",
        onExit: () => {},
        renderer: {} as never,
        cells: () => ({ cols: 80, rows: 24 }),
        getPanePalette: () => null,
        paneColorConfig: () => ({ mode: "exact", boldBright: true }),
        paneDefaults: () => ({ fg: null, bg: null }),
        displayForChat: () => ({ thinking: "hide", toolOutput: "collapsed", animations: false, cardStyle: "border" }),
        runtimeStatus: () => null,
        setTheme: () => null,
        onOverlayOpened: () => {},
        confirmStreamingClose: () => true,
        toast: () => {},
      })
      void engine
      const onHello = hellos[0]
      if (onHello === undefined) throw new Error("expected a hello handler")
      onHello()
      await new Promise((r) => setTimeout(r, 10))
      const rec = lines.map(parseLogLine).find((r) => r?.component === "ui.tabs")
      expect(rec?.level).toBe("warn")
      expect(rec?.msg).toContain("terminal list failed")
      expect(rec?.err?.message).toBe("socket down")
    } finally {
      configureLogger({ sink: () => {}, level: "info" })
    }
  })

  test("an overlapping reconnect only runs the newest recovery pass", async () => {
    const spies: Spies = { kill: 0, abort: 0, dispose: 0 }
    let reattaches = 0
    spies.reattach = () => {
      reattaches += 1
    }
    const store = makeStore([makeTab(1, spies)], 1)
    const hellos: Array<() => void> = []
    let listCalls = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ws = {
      on: (event: string, cb: () => void) => {
        if (event === "hello") hellos.push(cb)
        return () => {}
      },
      terminal: {
        list: () => {
          listCalls += 1
          return gate.then(() => ({ shells: [{ shellId: "s1" }] }))
        },
      },
      chat: { attach: async () => ({}) },
    } as unknown as WsClient
    makeRecoveryEngine(store, ws, () => {})
    const onHello = hellos[0]
    if (onHello === undefined) throw new Error("expected a hello handler")
    onHello()
    onHello() // supersedes the in-flight pass
    release()
    await new Promise((r) => setTimeout(r, 20))
    expect(listCalls).toBe(2)
    expect(reattaches).toBe(1)
  })

  test("a shell missing from the listing is rebuilt in place", async () => {
    const spies: Spies = { kill: 0, abort: 0, dispose: 0 }
    const store = makeStore([makeTab(1, spies)], 1)
    const hellos: Array<() => void> = []
    const opens: string[] = []
    const toasts: string[] = []
    const ws = {
      on: (event: string, cb: () => void) => {
        if (event === "hello") hellos.push(cb)
        return () => {}
      },
      terminal: {
        list: async () => ({ shells: [] }),
        open: async () => {
          opens.push("open")
          throw new Error("daemon gone")
        },
      },
      chat: { attach: async () => ({}) },
    } as unknown as WsClient
    makeRecoveryEngine(store, ws, (m) => toasts.push(m))
    const onHello = hellos[0]
    if (onHello === undefined) throw new Error("expected a hello handler")
    onHello()
    await new Promise((r) => setTimeout(r, 20))
    expect(opens).toEqual(["open"])
    expect(toasts.some((m) => m.includes("terminal open failed"))).toBe(true)
  })

  test("a second recovery does not double-open a rebuild already in flight", async () => {
    const spies: Spies = { kill: 0, abort: 0, dispose: 0 }
    const store = makeStore([makeTab(1, spies)], 1)
    const hellos: Array<() => void> = []
    let openCalls = 0
    let releaseOpen: () => void = () => {}
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve
    })
    const ws = {
      on: (event: string, cb: () => void) => {
        if (event === "hello") hellos.push(cb)
        return () => {}
      },
      terminal: {
        list: async () => ({ shells: [] }),
        open: () => {
          openCalls += 1
          return openGate.then(() => {
            throw new Error("daemon gone")
          })
        },
      },
      chat: { attach: async () => ({}) },
    } as unknown as WsClient
    makeRecoveryEngine(store, ws, () => {})
    const onHello = hellos[0]
    if (onHello === undefined) throw new Error("expected a hello handler")
    onHello()
    await new Promise((r) => setTimeout(r, 10)) // let the first rebuild reach terminal.open
    onHello() // supersedes; its rebuild must see the in-flight guard
    await new Promise((r) => setTimeout(r, 10))
    expect(openCalls).toBe(1)
    releaseOpen()
    await new Promise((r) => setTimeout(r, 10))
    expect(openCalls).toBe(1)
  })
})
