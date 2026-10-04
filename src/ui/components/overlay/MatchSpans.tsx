/**
 * MatchSpans: render a picker row's primary label with the characters matched
 * by the fuzzy query highlighted. Split by `matchSegments` (the same match
 * `fuzzyScore` ranks), each run rendered as its own `<span>`.
 *
 * opentui styles are ADDITIVE: a key omitted from a span never resets a
 * previously painted color, so EVERY span sets an explicit `bg` (the caller's
 * row fill, or "transparent" when the card shows through). `bold` is a
 * span-only style prop — never put it on `<text>`.
 *
 * `text` is rendered verbatim: the caller pads it to its fixed cell budget
 * (the stale-paint rule) before passing it in.
 */

import { type JSX } from "@opentui/solid"
import { For } from "solid-js"
import { matchSegments } from "../../lib/fuzzy.ts"
import type { ThemeColor } from "../../../theme/theme.ts"

export interface MatchSpansProps {
  query: string
  /** The label to render (already padded to the caller's cell budget). */
  text: string
  /** Foreground for matched runs (usually the accent token). */
  matchedFg: ThemeColor
  /** Foreground for the rest of the label. */
  plainFg: ThemeColor
  /** Explicit background for EVERY span (the row fill, or "transparent"). */
  bg: ThemeColor
  /** Bold is span-only; applies to every run when set. */
  bold?: boolean
}

export function MatchSpans(props: MatchSpansProps): JSX.Element {
  return (
    <For each={matchSegments(props.query, props.text)}>
      {(seg) => (
        <span
          style={{
            fg: seg.match ? props.matchedFg : props.plainFg,
            bg: props.bg,
            bold: props.bold ?? false,
          }}
        >
          {seg.text}
        </span>
      )}
    </For>
  )
}
