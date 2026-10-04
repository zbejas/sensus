/**
 * OverlayPreview: a bounded, stale-paint-safe detail area shared by the
 * pickers. Renders exactly `rows` text lines (missing lines become blank),
 * each padded/truncated to a fixed `width` so a shrinking preview never
 * leaves glyphs from the previous render behind (the opentui stale-paint
 * rule). The first line uses `fg`; the rest use `muted`.
 */

import { type JSX } from "@opentui/solid"
import { For } from "solid-js"
import type { ThemeColor } from "../../../theme/theme.ts"

export interface OverlayPreviewProps {
  lines: readonly string[]
  rows: number
  /** Fixed cell budget for every line (truncate + pad). */
  width: number
  fg: ThemeColor
  muted: ThemeColor
}

export function OverlayPreview(props: OverlayPreviewProps): JSX.Element {
  const padded = (): string[] => {
    const width = Math.max(0, props.width)
    const out: string[] = []
    for (let i = 0; i < props.rows; i++) {
      const raw = props.lines[i] ?? ""
      out.push([...raw].slice(0, width).join("").padEnd(width))
    }
    return out
  }
  return (
    <For each={padded()}>
      {(line, i) => <text selectable={false} style={{ fg: i() === 0 ? props.fg : props.muted }}>{line}</text>}
    </For>
  )
}
