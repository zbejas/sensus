/**
 * SkillsManager: full-screen overlay listing the loaded skills (docs/skills.md)
 * with a bounded preview of the highlighted skill's procedure body. Read-only:
 * the agent loads bodies with the skill_view tool; authoring is `/learn`.
 * Keys: ↑/↓ or j/k pick · PgUp/PgDn/Home/End · Enter detail · Esc close.
 */

import { type JSX } from "@opentui/solid"
import { useTerminalDimensions } from "@opentui/solid"
import { type MouseEvent } from "@opentui/core"
import { createMemo, createSignal, For, Show } from "solid-js"
import { theme } from "../../theme/theme.ts"
import type { UiStore } from "../lib/store.ts"
import type { SkillsCatalog } from "../../engine/index.ts"
import { isEnterKey } from "../../core/util.ts"
import { OverlayPanel, overlayRowStyle, overlayMetrics } from "./overlayKit.tsx"
import { OverlayPreview } from "./overlay/PreviewPane.tsx"
import { overlayNavStep, type OverlayNavKey } from "./overlay/nav.ts"

export interface SkillsManagerProps {
  store: UiStore
  catalog: SkillsCatalog
  onClose: () => void
}

const PREVIEW_ROWS = 10

export function SkillsManager(props: SkillsManagerProps): JSX.Element {
  const t = () => theme()
  const dims = useTerminalDimensions()
  const [sel, setSel] = createSignal(0)
  const [hover, setHover] = createSignal<number | null>(null)

  const skills = (): SkillsCatalog["skills"] => props.catalog.skills
  const active = (): SkillsCatalog["skills"][number] | null => skills()[sel()] ?? null

  const metrics = () => overlayMetrics(dims())
  // Chrome inside the card: spacer + PREVIEW_ROWS preview + count + hint.
  const maxRows = () => Math.max(3, metrics().innerHeight - (PREVIEW_ROWS + 3))
  const win = createMemo(() => {
    const count = skills().length
    const rows = Math.max(1, maxRows())
    const start = Math.max(0, Math.min(sel() - Math.floor(rows / 2), Math.max(0, count - rows)))
    return { start, list: Math.min(rows, count - start) }
  })

  const previewLines = (): string[] => {
    const body = active()?.body ?? ""
    const width = Math.max(8, metrics().innerWidth - 2)
    const src = body.length > 0 ? body.split("\n") : ["(empty body)"]
    const out: string[] = []
    for (let i = 0; i < PREVIEW_ROWS; i++) out.push((src[i] ?? "").slice(0, width).padEnd(width))
    return out
  }

  props.store.overlayKeyHandler = (key) => {
    if (key.name === "escape") {
      props.onClose()
      return
    }
    if (isEnterKey(key) && !key.ctrl && !key.meta) return
    const next = overlayNavStep(key as OverlayNavKey, {
      index: sel(),
      count: skills().length,
      pageSize: maxRows(),
      vim: true,
      wrap: false,
    })
    if (next !== null) setSel(next)
  }

  const onWheel = (e: MouseEvent): void => {
    const dir = e.scroll?.direction
    if (dir !== "up" && dir !== "down") return
    e.stopPropagation()
    const next = overlayNavStep(
      { name: dir === "up" ? "up" : "down", ctrl: false, meta: false, shift: false },
      { index: sel(), count: skills().length, pageSize: maxRows(), vim: false, wrap: false },
    )
    if (next !== null) setSel(next)
  }

  const rowText = (s: SkillsCatalog["skills"][number], selected: boolean): string =>
    ` ${selected ? "❯ " : "  "}${s.name} — ${s.description || "(no description)"}`.slice(0, Math.max(8, metrics().innerWidth - 2))

  return (
    <OverlayPanel title=" skills " onClose={props.onClose}>
      <Show
        when={skills().length > 0}
        fallback={
          <text selectable={false} style={{ fg: t().muted, bg: "transparent" }}>
            {" no skills installed — add SKILL.md files under ~/.config/sensus/skills/ "}
          </text>
        }
      >
        <For each={skills().slice(win().start, win().start + win().list)}>
          {(s, i) => {
            const idx = () => win().start + i()
            const selected = () => idx() === sel()
            const hovered = () => hover() === idx()
            return (
              <text selectable={false}
                style={overlayRowStyle(t(), selected(), t().fg, hovered())}
                onMouseOver={() => setHover(idx())}
                onMouseOut={() => setHover((h) => (h === idx() ? null : h))}
                onMouseScroll={onWheel}
                onMouseDown={(e) => {
                  e.stopPropagation()
                  setSel(idx())
                }}
              >
                {rowText(s, selected())}
              </text>
            )
          }}
        </For>
      </Show>
      <box style={{ height: 1 }} />
      <OverlayPreview lines={previewLines()} rows={PREVIEW_ROWS} width={Math.max(8, metrics().innerWidth - 2)} fg={t().fg} muted={t().muted} />
      <text selectable={false} style={{ fg: t().accent }}> {` ${skills().length} skill(s) · ~/.config/sensus/skills/ `} </text>
      <text selectable={false} style={{ fg: t().muted }}> {" ↑/↓/j/k pick · PgUp/PgDn · Enter · Esc close "} </text>
    </OverlayPanel>
  )
}
