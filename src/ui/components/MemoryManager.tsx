/**
 * MemoryManager (Phase 1.4): a full-screen overlay to inspect and edit the
 * three agent memory stores (docs/memory.md) through `MemoryStore`.
 *
 * - Left rail: Memory (MEMORY.md) · Host map (HOST.md) · Journal (JOURNAL.md).
 *   Tab/Shift+Tab switches rail ⇄ detail; ↑/↓ (and j/k, PgUp/PgDn/Home/End)
 *   move the focused pane's selection; Enter on the rail focuses the detail.
 * - Detail: a usage line, one row per entry (with its char count) and a
 *   bounded preview of the selected entry's full text.
 * - Editing: `a` adds, Enter edits the selected entry, `d`/Delete removes it
 *   (inline `remove entry? y/N`), `r` re-reads from disk. Text is a single-line
 *   draft with SettingsScreen key semantics (Ctrl+U clears, ←/→/Home/End move,
 *   printable/Backspace/Delete edit, Enter commits, Esc cancels).
 * - Writes go through MemoryStore's public methods; the result message is
 *   toasted (errors keep the edit open). A cap error is surfaced, never thrown.
 *
 * Keys register through the store's single `overlayKeyHandler` dispatch (never
 * a second global listener). Every row sets an explicit `bg` via
 * `overlayRowStyle` and a fixed cell budget (opentui paint is additive).
 */

import { type JSX } from "@opentui/solid"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import type { MemoryTarget, MemoryUsage } from "../../engine/index.ts"
import type { RestClient } from "../../client/restClient.ts"
import { errorMessage, isEnterKey, keyChar, singleLinePaste } from "../../core/util.ts"
import { theme, type ThemeColor } from "../../theme/theme.ts"
import type { ToastLevel } from "../lib/toast.ts"
import type { OverlayKey, UiStore } from "../lib/store.ts"
import {
  MEMORY_RAIL,
  commitDraft,
  draftParts,
  editDraft,
  formatEntryRow,
  formatUsage,
  previewLines,
  startDraft,
  type MemoryDraftEdit,
  type MemoryPane,
  type MemoryRailItem,
} from "../chat/memoryManager.ts"
import { OverlayPanel, overlayRowStyle, overlayMetrics } from "./overlayKit.tsx"
import { overlayNavStep } from "./overlay/nav.ts"

export interface MemoryManagerProps {
  store: UiStore
  /** The daemon REST client (the daemon owns the memory stores; D13). */
  rest: RestClient
  toast(message: string, level?: ToastLevel, ttlMs?: number): void
  onClose(): void
}

/** In-progress single-line edit: add, or replace one existing entry. */
interface EditState {
  mode: "add" | "edit"
  /** The entry being replaced ("" for add); the store's unique-match key. */
  original: string
  draft: { text: string; cursor: number }
}

/** Inline destructive confirm (remove): y confirms, n/Esc cancels. */
interface ConfirmState {
  message: string
  onYes: () => void
}

/** Left rail width (columns), including its right border. */
const RAIL_WIDTH = 24
/** Bounded preview rows below the entry list. */
const PREVIEW_ROWS = 5

export function MemoryManager(props: MemoryManagerProps): JSX.Element {
  const t = () => theme()
  const dims = useTerminalDimensions()

  const [railIdx, setRailIdx] = createSignal(0)
  const [pane, setPane] = createSignal<MemoryPane>("rail")
  const [entries, setEntries] = createSignal<string[]>([])
  const [usage, setUsage] = createSignal<MemoryUsage | null>(null)
  const [sel, setSel] = createSignal(0)
  const [edit, setEdit] = createSignal<EditState | null>(null)
  const [confirm, setConfirm] = createSignal<ConfirmState | null>(null)
  const [hover, setHover] = createSignal<string | null>(null)

  const railItem = createMemo<MemoryRailItem>(() => MEMORY_RAIL[railIdx()] ?? MEMORY_RAIL[0]!)
  const target = (): MemoryTarget => railItem().target

  const clampedSel = createMemo(() => {
    const n = entries().length
    return n === 0 ? 0 : Math.max(0, Math.min(sel(), n - 1))
  })

  const metrics = () => overlayMetrics(dims())
  // Chrome inside the card: usage + (edit line) + spacer + preview label +
  // PREVIEW_ROWS preview + hint/confirm + dir → 10.
  const listRows = (): number => Math.max(1, metrics().innerHeight - 10)
  const railBudget = (): number => Math.max(10, RAIL_WIDTH - 4)
  const detailBudget = (): number => Math.max(12, metrics().innerWidth - RAIL_WIDTH - 4)

  const detailRows = createMemo(() => {
    const items = entries()
    const rows = listRows()
    const s = clampedSel()
    const start = Math.max(0, Math.min(s - Math.floor(rows / 2), Math.max(0, items.length - rows)))
    return items.slice(start, start + rows).map((entry, k) => ({ entry, idx: start + k }))
  })

  const preview = createMemo(() => previewLines(entries()[clampedSel()] ?? "", PREVIEW_ROWS, detailBudget()))

  const usageText = createMemo(() => {
    const u = usage()
    const prefix = `${railItem().file}  `
    const body = u === null ? "(reading…)" : formatUsage(u)
    const pad = " ".repeat(Math.max(0, detailBudget() - prefix.length - body.length))
    return { prefix, body, pad }
  })

  const editParts = createMemo(() => {
    const e = edit()
    if (e === null) return { mode: "add" as const, before: "", cursor: " ", after: "" }
    return { mode: e.mode, ...draftParts(e.draft) }
  })
  const editing = (): boolean => edit() !== null

  /** Trailing pad so a shrinking draft never leaves stale cells. */
  const editPad = createMemo(() => {
    const p = editParts()
    const used = 3 + [...p.before].length + [...p.cursor].length + [...p.after].length
    return " ".repeat(Math.max(0, detailBudget() - used))
  })

  /** Re-read the current store through the daemon REST API. */
  const refresh = async (): Promise<void> => {
    try {
      const res = await props.rest.memoryTarget(target())
      setEntries(res.entries ?? [])
      setUsage(res.usage)
    } catch (e) {
      setEntries([])
      setUsage(null)
      props.toast(`memory read failed: ${errorMessage(e)}`, "error", 5000)
    }
  }
  void refresh()

  const selectRail = (idx: number): void => {
    setRailIdx(idx)
    setSel(0)
    void refresh()
  }

  const startAdd = (): void => {
    setConfirm(null)
    setPane("detail")
    setEdit({ mode: "add", original: "", draft: startDraft("") })
  }

  const startEdit = (): void => {
    const entry = entries()[clampedSel()]
    if (entry === undefined) return
    setConfirm(null)
    setEdit({ mode: "edit", original: entry, draft: startDraft(entry) })
  }

  const commitEdit = (): void => {
    const e = edit()
    if (e === null) return
    const text = commitDraft(e.draft).trim()
    if (text.length === 0) {
      props.toast("nothing to write (empty entry)", "error", 4000)
      return
    }
    setEdit(null)
    void (async () => {
      try {
        const res =
          e.mode === "add"
            ? await props.rest.memoryWrite(target(), "add", { content: text })
            : await props.rest.memoryWrite(target(), "replace", { old_text: e.original, content: text })
        props.toast(res.message, res.ok ? "success" : "error", res.ok ? 2500 : 6500)
        // A failed write (e.g. a hard cap) re-opens the draft so nothing is lost.
        if (!res.ok) {
          setEdit({ mode: e.mode, original: e.original, draft: startDraft(text) })
          return
        }
        await refresh()
        if (e.mode === "add") setSel(Math.max(0, entries().length - 1))
      } catch (err) {
        props.toast(`memory write failed: ${errorMessage(err)}`, "error", 6000)
        setEdit({ mode: e.mode, original: e.original, draft: startDraft(text) })
      }
    })()
  }

  const requestRemove = (): void => {
    const entry = entries()[clampedSel()]
    if (entry === undefined) return
    setEdit(null)
    setConfirm({
      message: "remove entry? y/N",
      onYes: () => {
        void (async () => {
          try {
            const res = await props.rest.memoryWrite(target(), "remove", { old_text: entry })
            props.toast(res.message, res.ok ? "success" : "error", res.ok ? 2500 : 6500)
            await refresh()
            setSel((s) => Math.max(0, Math.min(s, entries().length - 1)))
          } catch (err) {
            props.toast(`memory remove failed: ${errorMessage(err)}`, "error", 6000)
            await refresh()
          }
        })()
      },
    })
  }

  const reload = (): void => {
    void (async () => {
      await refresh()
      const u = usage()
      props.toast(u === null ? "memory reloaded from the daemon" : `memory reloaded · ${formatUsage(u)}`, "info", 2500)
    })()
  }

  /** Prune the oldest entries down to half the cap (explicit y/N confirm). */
  const requestPrune = (): void => {
    setEdit(null)
    setConfirm({
      message: `prune oldest ${target()} entries to half the cap? y/N`,
      onYes: () => {
        void (async () => {
          try {
            const res = await props.rest.memoryWrite(target(), "prune")
            props.toast(res.message, res.ok ? "success" : "error", res.ok ? 2500 : 6500)
            await refresh()
            setSel(0)
          } catch (err) {
            props.toast(`memory prune failed: ${errorMessage(err)}`, "error", 6000)
          }
        })()
      },
    })
  }

  const applyDraft = (action: MemoryDraftEdit): void => {
    setEdit((e) => (e === null ? e : { ...e, draft: editDraft(e.draft, action) }))
  }

  const handleOverlayKey = (key: OverlayKey): void => {
    // 1. Single-line edit owns every key until Enter/Esc.
    if (edit() !== null) {
      if (isEnterKey(key) && !key.ctrl) {
        commitEdit()
        return
      }
      if (key.name === "escape") {
        setEdit(null)
        return
      }
      if (key.name === "backspace") {
        applyDraft({ type: "backspace" })
        return
      }
      if (key.ctrl && key.name === "u") {
        applyDraft({ type: "clear" })
        return
      }
      if (key.name === "delete") {
        applyDraft({ type: "delete" })
        return
      }
      if (key.name === "left") {
        applyDraft({ type: "left" })
        return
      }
      if (key.name === "right") {
        applyDraft({ type: "right" })
        return
      }
      if (key.name === "home") {
        applyDraft({ type: "home" })
        return
      }
      if (key.name === "end") {
        applyDraft({ type: "end" })
        return
      }
      const ch = keyChar(key)
      if (!key.ctrl && !key.meta && ch.length === 1) {
        applyDraft({ type: "insert", char: ch })
      }
      return
    }

    // 2. Destructive confirm: y confirms, n/Esc cancels, Enter does nothing.
    const c = confirm()
    if (c !== null) {
      const yes = !key.ctrl && !key.meta && (keyChar(key) === "y" || keyChar(key) === "Y")
      if (yes) {
        setConfirm(null)
        c.onYes()
        return
      }
      if (key.name === "escape" || keyChar(key).toLowerCase() === "n") setConfirm(null)
      return
    }

    // 3. Overlay-level keys.
    if (key.name === "escape") {
      props.onClose()
      return
    }
    if (key.name === "tab" || key.name === "BTab") {
      setPane((p) => (p === "rail" ? "detail" : "rail"))
      return
    }
    if (key.name === "left") {
      setPane("rail")
      return
    }
    if (key.name === "right") {
      setPane("detail")
      return
    }

    const onRail = pane() === "rail"
    const count = onRail ? MEMORY_RAIL.length : entries().length
    const index = onRail ? railIdx() : clampedSel()
    const step = overlayNavStep(key, { index, count, pageSize: listRows(), vim: true, wrap: false })
    if (step !== null) {
      if (onRail) selectRail(step)
      else setSel(step)
      return
    }

    if (isEnterKey(key) && !key.ctrl && !key.meta) {
      if (onRail) setPane("detail")
      else startEdit()
      return
    }
    if (key.name === "a" && !key.ctrl && !key.meta) {
      startAdd()
      return
    }
    if ((key.name === "d" || key.name === "delete") && !key.ctrl && !key.meta) {
      if (!onRail) requestRemove()
      return
    }
    if (key.name === "r" && !key.ctrl && !key.meta) {
      reload()
      return
    }
    if (key.name === "p" && !key.ctrl && !key.meta) {
      requestPrune()
      return
    }
  }
  props.store.overlayKeyHandler = handleOverlayKey
  // Paste into the single-line entry editor while one is open (and only then;
  // the manager has no filter).
  props.store.overlayPasteHandler = (raw: string) => {
    const text = singleLinePaste(raw)
    if (text.length === 0) return
    if (edit() === null) return
    applyDraft({ type: "insert", char: text })
  }

  const hint = createMemo(() => {
    let text: string
    if (editing()) text = " Enter commit · Esc cancel · Ctrl+U clear · ←/→ Home/End cursor"
    else if (pane() === "rail") text = " ↑/↓ or j/k choose a store · Enter detail · Tab detail · Esc close"
    else text = " a add · Enter edit · d/Del remove · p prune · r reload · Tab rail · Esc close"
    return text.padEnd(Math.max(10, metrics().innerWidth - 2))
  })

  const confirmText = createMemo(() => ` ${confirm()?.message ?? ""} `.padEnd(Math.max(10, metrics().innerWidth - 2)))
  const dirText = createMemo(() => ` memory is owned by the daemon · edits persist server-side `.padEnd(Math.max(10, metrics().innerWidth - 2)))

  const title = (): string => ` memory · ${railItem().label} (${railItem().file}) `

  return (
    <OverlayPanel title={title()} onClose={props.onClose}>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        <box
          style={{
            width: RAIL_WIDTH,
            flexShrink: 0,
            flexDirection: "column",
            border: ["right" as const],
            borderStyle: "single",
            borderColor: t().border,
          }}
        >
          <For each={MEMORY_RAIL}>
            {(item, i) => {
              const selected = () => pane() === "rail" && i() === railIdx()
              const hovered = () => hover() === `rail:${i()}`
              return (
                <text selectable={false}
                  style={{
                    ...overlayRowStyle(t(), selected(), t().fg, hovered()),
                  }}
                  onMouseOver={() => setHover(`rail:${i()}`)}
                  onMouseOut={() => setHover((h) => (h === `rail:${i()}` ? null : h))}
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    selectRail(i())
                    setPane("detail")
                  }}
                >
                  {` ${selected() ? "❯ " : "  "}${item.label}`.padEnd(railBudget())}
                </text>
              )
            }}
          </For>
        </box>

        <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 1 }}>
          <text selectable={false} style={{ fg: t().fg, bg: "transparent" }}>
            <span style={{ fg: t().muted, bg: "transparent" }}>{usageText().prefix}</span>
            <span style={{ fg: t().fg, bg: "transparent" }}>{usageText().body}</span>
            <span style={{ fg: t().muted, bg: "transparent" }}>{usageText().pad}</span>
          </text>

          <Show when={editing()}>
            <text selectable={false} style={{ fg: t().fg, bg: "transparent" }}>
              <span style={{ fg: t().accent, bg: "transparent" }}>{` ${editParts().mode === "add" ? "+" : "~"} `}</span>
              <span style={{ fg: t().fg, bg: "transparent" }}>{editParts().before}</span>
              <span style={{ fg: t().onAccent, bg: t().accent }}>{editParts().cursor}</span>
              <span style={{ fg: t().fg, bg: "transparent" }}>{editParts().after}</span>
              <span style={{ fg: t().muted, bg: "transparent" }}>{editPad()}</span>
            </text>
          </Show>

          <Show
            when={entries().length > 0}
            fallback={<text selectable={false} style={{ fg: t().muted, bg: "transparent" }}>{` (no entries — press a to add) `.padEnd(detailBudget())}</text>}
          >
            <For each={detailRows()}>
              {(row) => {
                const selected = () => pane() === "detail" && row.idx === clampedSel()
                const hovered = () => hover() === `detail:${row.idx}`
                const rs = (): Record<string, unknown> => overlayRowStyle(t(), selected(), t().fg, hovered())
                const bg = (): ThemeColor => rs().bg as ThemeColor
                const fg = (): ThemeColor => rs().fg as ThemeColor
                return (
                  <text selectable={false}
                    style={rs()}
                    onMouseOver={() => setHover(`detail:${row.idx}`)}
                    onMouseOut={() => setHover((h) => (h === `detail:${row.idx}` ? null : h))}
                    onMouseDown={(e) => {
                      e.stopPropagation()
                      setPane("detail")
                      setSel(row.idx)
                    }}
                  >
                    <span style={{ fg: fg(), bg: bg() }}>{formatEntryRow(row.entry, row.idx, selected(), detailBudget())}</span>
                  </text>
                )
              }}
            </For>
          </Show>

          <box style={{ height: 1 }} />
          <text selectable={false} style={{ fg: t().muted, bg: "transparent" }}>{` preview `.padEnd(detailBudget())}</text>
          <For each={preview()}>
            {(line, i) => (
              <text selectable={false} style={{ fg: i() === 0 ? t().fg : t().muted, bg: "transparent" }}>
                <span style={{ fg: i() === 0 ? t().fg : t().muted, bg: "transparent" }}>{line}</span>
              </text>
            )}
          </For>
        </box>
      </box>

      <Show
        when={confirm() !== null}
        fallback={<text selectable={false} style={{ fg: t().muted, bg: "transparent" }}>{hint()}</text>}
      >
        <text selectable={false} style={{ fg: t().danger, bg: "transparent" }}>{confirmText()}</text>
      </Show>
      <text selectable={false} style={{ fg: t().muted, bg: "transparent" }}>{dirText()}</text>
    </OverlayPanel>
  )
}
