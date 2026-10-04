/**
 * One chat message block: the rounded card holding a label row + body, as
 * rendered inside ChatSidebar's message scrollbox. Kept in its own module so
 * ChatSidebar owns only the scrollbox wiring and the render tree.
 */

import { type JSX } from "@opentui/solid"
import type { BorderCharacters } from "@opentui/core"
import { createEffect, createMemo, createSignal, Show, For } from "solid-js"
import { bgProps, borderProps, textBgProps, theme } from "../../../theme/theme.ts"
import type { ChatMessage } from "../../../engine/index.ts"
import { layoutMessage, layoutThinking, segmentAssistantSpans, liveAssistantLabel, cardTextWidth, cardOuterWidth, userBubbleTextWidth, reuseRows, type LayoutRow } from "../../chat/chatLayout.ts"
import { entranceActive, entranceFrame, entranceProgress, entranceSlide, type EntranceStart } from "../../chat/entrance.ts"
import { clampRevealCut } from "../../chat/streamReveal.ts"
import { markdownSyntaxStyle } from "../../../theme/markdownStyle.ts"
import { spinnerChar, spinnerFrame } from "../../lib/spinner.ts"
import { fenceRows, imageChipText } from "../../chat/messageText.ts"
import { RowText, CopyableRow, ActionRow, LabelRow } from "./Rows.tsx"

/**
 * Border glyphs for the `fill` panel: full-block edges with a quarter-cell
 * notch at each corner. The panel is a SOLID fill, so the rounded border
 * glyphs (`╭╮╰╯`) cannot show: `drawBox` paints the box background under the
 * border cells too, and a fill-colored corner glyph on a fill-colored cell is
 * a square. The notch is the closest a cell grid gets to the rounded panel in
 * the reference design (docs/DESIGN.md "Chat sidebar"). `border` mode keeps
 * the real rounded glyphs.
 */
const FILL_PANEL_BORDER: BorderCharacters = {
  topLeft: "▟",
  topRight: "▙",
  bottomLeft: "▜",
  bottomRight: "▛",
  horizontal: "█",
  vertical: "█",
  topT: "█",
  bottomT: "█",
  leftT: "█",
  rightT: "█",
  cross: "█",
}

/** Props for {@link MessageBlock}. */
export interface MessageBlockProps {
  msg: ChatMessage
  contentWidth: number
  streaming: boolean
  /** Session display state (docs/config.md "chat") — reactive props. */
  thinkingOpen: boolean
  thinkingActive: boolean
  toolOutput: "expanded" | "collapsed"
  animations: boolean
  /** Message card style: "fill" = borderless themed panel, "border" = bordered. */
  cardStyle: "fill" | "border"
  /** Active agent name for the assistant label (falls back to the model). */
  agentName: string
  /** Entrance-animation tracker (once per message id; see ui/chat/entrance.ts). */
  entranceStart: EntranceStart
  /** Stream-reveal pacing (docs/agent.md "Streaming display"): the session
   * delegates to its StreamReveal and returns the revealed-char cut; the
   * shared 80ms tick is read inside only while a backlog exists, so settled
   * text never subscribes. */
  revealContentCut: (id: number, content: string, settled: boolean) => number
  revealThinkingCut: (id: number, thinking: string, settled: boolean) => number
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
  /** Code-row click: single click pastes the clicked command into the visible
   * pane (no Enter); the second click of a double-click presses Enter. */
  onCodeClick?: (code: string, run: boolean) => void
  /** Label-row `⧉ copy` click: raw message text → clipboard (App: OSC52). */
  onCopyMessage?: (text: string) => void
  /** User label-row `↺ revert` click: rewind the chat to that message. */
  onRevertMessage?: (id: number) => void
}

/** One message block: a rounded card (theme fill / border-only in the adaptive
 * theme) holding a label row + body, rendered by the scrollbox's
 * reference-keyed `<For>` (settled messages never re-render; only the
 * streaming one does). Assistant prose renders through the NATIVE
 * <markdown> renderable (M9 phase 4 — proper wrapping, scoped styles); fenced
 * code and every non-assistant role stay on our row model (tool cards, click
 * extras, verbatim plain text). The reveal paces the text INSIDE each segment
 * boundary (ui/chat/streamReveal.ts) and hands <For> fresh objects every
 * step, so each segment node remounts — and repaints — per reveal step; the
 * in-place content-update path never paints on this opentui.
 *
 * M10 streaming display: the streaming assistant label is ANIMATED (spinner
 * frame + elapsed seconds); reasoning renders as a
 * collapsible "Thinking"/"Thought for" block above the content; tool-card
 * output collapses to a preview with click/`e` expansion; running tool cards
 * animate their status glyph. Tick reads (spinnerChar) are CONDITIONAL —
 * only blocks that are actually animating subscribe to the 80ms tick, so
 * settled messages never re-render. The streamed text itself is reveal-paced
 * (typewriter pour, ui/chat/streamReveal.ts): bursts unfurl instead of
 * popping, under the same conditional-tick invariant. */
export function MessageBlock(props: MessageBlockProps): JSX.Element {
  const t = () => theme()
  const isUser = props.msg.role === "user"
  // Card surface: fill mode paints the theme panel token in every theme,
  // so the adaptive `terminal` theme's overlays-derived
  // `cardBg` is used too; border mode paints nothing (transparent) and is
  // outlined instead. Every row inside the card paints this same surface so
  // fills match.
  const surface = createMemo(() => (props.cardStyle === "fill" ? (t().cardBg ?? t().bg) : null))
  // Assistant/tool/system fill the content width; a user bubble is capped at
  // 80% and shrink-wrapped to its longest line.
  const maxUserText = createMemo(() => cardTextWidth(props.contentWidth, "user"))
  const textWidth = createMemo(() =>
    isUser ? userBubbleTextWidth(props.msg.content, maxUserText()) : props.contentWidth,
  )
  const cardW = createMemo(() => cardOuterWidth(textWidth()))
  const layout = createMemo(() =>
    layoutMessage(props.msg, textWidth(), {
      toolOutput: props.toolOutput,
      runningGlyph: props.msg.tool?.status === "running" ? spinnerChar(props.animations) : undefined,
      agentName: props.agentName,
    }),
  )
  const copyText = createMemo(() => props.msg.content)
  // Reconcile against the PREVIOUS row list and reuse every object whose
  // semantic content did not change: the running tool card re-lays each 80ms
  // spinner tick, but only the status row carries the animated glyph, so only
  // it is rebuilt. `<For each={laid()}>` is reference-keyed — reusing the other
  // rows is what keeps their `InteractiveRow` instances (and hover/press
  // signals) alive instead of remounting them per tick (docs/DESIGN.md
  // "Motion"). `prevLaid` is per message block instance.
  let prevLaid: LayoutRow[] = []
  const laid = createMemo((): LayoutRow[] => {
    const { label, labelStyle, body } = layout()
    const rows: LayoutRow[] = []
    if (label.length > 0) rows.push({ segs: [{ text: label, style: labelStyle }], isLabel: true })
    // Image chips ride directly under the label so the user sees what they
    // sent (docs/agent.md "Images"); non-interactive (remove is draft-only).
    if (isUser && props.msg.images !== undefined && props.msg.images.length > 0) {
      rows.push({ segs: [{ text: imageChipText(props.msg.images, textWidth()), style: { dim: true } }] })
    }
    // Rows come fresh from layoutMessage on every recompute — reusable as-is
    // (only the streaming block recomputes per delta, and only ITS rows are
    // touched). The streaming caret is assistant-only (the assistant branch
    // below); non-assistant roles are never the active bubble. The inter-card
    // gap is the card's marginBottom (no in-body spacer).
    rows.push(...body)
    prevLaid = reuseRows(prevLaid, rows)
    return prevLaid
  })

  // Entrance animation (played once per message id; see ui/chat/entrance.ts).
  // entranceStart is a plain call (not a memo): it must fire exactly once per
  // component instance, and the tracker dedupes the streaming block's
  // per-delta remounts. The tick is read only while still animating.
  const entranceAt = props.entranceStart(props.msg.id, props.msg.ts, props.animations)
  const entrance = createMemo(() => {
    if (entranceAt === null) return 1
    const p = entranceProgress(entranceAt, Date.now(), props.animations)
    if (entranceActive(p)) entranceFrame()
    return p
  })
  const slide = createMemo(() => entranceSlide(entrance()))

  // Expand/collapse feedback: flash the card border when the collapsible
  // thinking / tool-output block toggles. Tick read only while flashing.
  const [flashAt, setFlashAt] = createSignal<number | null>(null)
  let prevOpen = props.thinkingOpen
  let prevToolOutput = props.toolOutput
  createEffect(() => {
    const open = props.thinkingOpen
    const toolOutput = props.toolOutput
    if (open !== prevOpen || toolOutput !== prevToolOutput) {
      prevOpen = open
      prevToolOutput = toolOutput
      if (props.animations) setFlashAt(Date.now())
    }
  })
  const flashing = createMemo(() => {
    const at = flashAt()
    if (at === null) return false
    const p = entranceProgress(at, Date.now(), props.animations)
    if (entranceActive(p)) entranceFrame()
    return p < 1
  })

  const cardBorder = createMemo(() => {
    if (flashing()) return t().accent
    if (props.msg.role === "error") return t().danger
    if (props.msg.role === "tool" && (props.msg.tool?.status === "pending" || (props.msg.plan !== undefined && props.msg.plan.resolved !== true))) {
      return t().accent
    }
    return t().border
  })
  // Message shell. The border element is ALWAYS present (never removed:
  // opentui styles are additive, so a dropped border would leave stale cells and
  // keep eating 2 content columns). Its color carries the mode:
  //   fill   → block border glyphs painted in the panel surface color, so the
  //            panel is one solid fill with notched corners (FILL_PANEL_BORDER)
  //            and the border cells read as the 2-col panel padding. The box
  //            background stays transparent and `cardBody` paints the fill: a
  //            box background would cover the corner cells and square them off.
  //   border → border painted in the border/accent color, no fill.
  // `customBorderChars` is ALWAYS set (undefined clears it) for the same
  // additive-style reason: a live `/cards` toggle must not leave block corners
  // on the bordered card.
  // User cards sit right; a 1-cell slide (margin, which never reflows the
  // wrapped text) plays on entrance. Both modes occupy `textWidth + 2` columns.
  const cardShell = createMemo(() => {
    const fill = props.cardStyle === "fill"
    return {
      flexDirection: "column" as const,
      width: cardW(),
      alignSelf: isUser ? ("flex-end" as const) : ("flex-start" as const),
      border: true,
      borderStyle: "rounded" as const,
      customBorderChars: fill ? FILL_PANEL_BORDER : undefined,
      paddingLeft: 0,
      paddingRight: 0,
      marginBottom: 1,
      marginLeft: isUser ? 0 : slide(),
      marginRight: isUser ? slide() : 0,
      ...borderProps(fill ? surface() : cardBorder()),
      // The panel fill lives on the inner body (fill mode only); a transparent
      // shell lets the notched corners show the chat background.
      ...bgProps(null),
    }
  })
  // Inner body: the solid panel surface behind every row (the rows paint it
  // themselves; markdown prose does not, so the box is the one fill).
  const cardBody = createMemo(() => ({
    flexDirection: "column" as const,
    width: "100%" as const,
    flexGrow: 1,
    ...bgProps(surface()),
  }))
  // Live streaming caret: a subtle pulse (accent ↔ muted) on the shared tick.
  // Reads spinnerFrame only while streaming, so a settled session never
  // subscribes (the conditional-tick invariant).
  const caretColor = createMemo(() => {
    if (!props.streaming || !props.animations) return t().accent
    return spinnerFrame() % 2 === 0 ? t().accent : t().muted
  })

  // The active thinking header is currently the live row: reasoning has
  // flushed and the answer has not started. While it is live the bubble's own
  // label is suppressed, so only ONE spinner animates — otherwise the animated
  // streaming label stacks its spinner directly above the `⠋ Thinking` header
  // (two spinners, same frame). The waiting row -> thinking header handoff
  // stays seamless and the label returns the moment content streams. (Reads the
  // flushed `thinking` field, so it is false in the sub-flush window before the
  // first reasoning delta lands, when the label is the only sensible cue.)
  const thinkingLive = createMemo(
    () => props.thinkingActive && (props.msg.thinking ?? "").trim().length > 0,
  )
  // Assistant: label row + segmented body (native markdown prose / fenced
  // code rows) + spacer. The label must render like the row model's label.
  // equals guard: streaming deltas recreate `msg` and the layout output every
  // chunk; the label only changes when its TEXT does, so keep the previous
  // object otherwise (the label row must not re-render per stream delta).
  const assistantLabel = createMemo(
    () => {
      if (props.msg.role !== "assistant") return null
      if (props.streaming && thinkingLive()) return null
      const { label, labelStyle } = layout()
      return label.length > 0 ? { text: label, style: labelStyle } : null
    },
    undefined,
    { equals: (a, b) => (a === null || b === null ? a === b : a.text === b.text) },
  )
  // Stream reveal — THE one call into the session's pacing per channel, so
  // the cut advances exactly once per render pass.
  const contentCut = createMemo(() =>
    props.msg.role === "assistant"
      ? props.revealContentCut(props.msg.id, props.msg.content, !props.streaming)
      : 0,
  )
  const segments = createMemo(() => {
    if (props.msg.role !== "assistant") return []
    const full = props.msg.content
    // Boundaries come from the FULL content (a fence that has not closed yet
    // still yields its segment); the reveal cut paces each segment's text.
    // Segments are ALWAYS fresh objects: opentui repaints a changed child by
    // REMOUNTING it (the M7 lesson — identical spans get reused without
    // repainting), so every reveal step must hand <For> new references.
    const cut = contentCut()
    return segmentAssistantSpans(full).map(({ seg, start, len }) => {
      const visible = Math.max(0, Math.min(len, cut - start))
      if (visible >= len) return { ...seg }
      if (seg.kind === "prose") {
        return { kind: "prose" as const, text: seg.text.slice(0, clampRevealCut(seg.text, visible)) }
      }
      return { kind: "fence" as const, lang: seg.lang, code: seg.code.slice(0, clampRevealCut(seg.code, visible)) }
    })
  })
  // Animated streaming label (spinner frame + elapsed seconds); the settled
  // label takes over on finish. The session HOLDS the streaming status while
  // the reveal drains (finishStreamingWhenCaught), so the animated label —
  // and the render passes that paint the pour — stay up until the reply has
  // visually landed. Tick read is conditional on streaming. Suppressed while
  // the thinking header is the live indicator (see thinkingLive) so the two
  // spinners never stack.
  const streamLabel = createMemo(() => {
    return liveAssistantLabel(
      props.streaming,
      thinkingLive(),
      () => spinnerChar(props.animations),
      props.agentName.length > 0 ? props.agentName : "assistant",
      Date.now() - props.msg.ts,
    )
  })
  // Reasoning block: animated "Thinking" header while the
  // model reasons (click it to reveal the live reasoning), `+ Thought for 2.3s`
  // once done (click / `Alt+T` to expand).
  // The paced body is requested only while the body is actually rendered —
  // a collapsed block must not hold a tick subscription (or advance).
  const thinking = createMemo(() => {
    const open = props.thinkingOpen
    const active = props.thinkingActive
    const raw = props.msg.thinking ?? ""
    const cut = open ? props.revealThinkingCut(props.msg.id, raw, !props.streaming) : raw.length
    return layoutThinking(props.msg, props.contentWidth, {
      open,
      active,
      glyph: active ? spinnerChar(props.animations) : undefined,
      bodyText: raw.slice(0, clampRevealCut(raw, cut)),
    })
  })

  if (props.msg.role === "assistant") {
    return (
      <box style={cardShell()}>
        <box style={cardBody()}>
          <Show
            when={streamLabel() !== null}
            fallback={
              <Show when={assistantLabel() !== null}>
                <LabelRow
                  text={assistantLabel()!.text}
                  style={assistantLabel()!.style}
                  contentWidth={textWidth()}
                  copyText={copyText()}
                  bg={surface()}
                  onCopy={props.onCopyMessage}
                />
              </Show>
            }
          >
            <LabelRow
              text={streamLabel() ?? ""}
              style={{ dim: true }}
              contentWidth={textWidth()}
              copyText={copyText()}
              bg={surface()}
              onCopy={props.onCopyMessage}
            />
          </Show>
          <Show when={thinking() !== null}>
            <ActionRow
              line={thinking()!.header}
              bg={surface()}
              actions={thinking()!.header.actions ?? []}
              onPick={(callId, kind) => props.onCardAction?.(callId, kind)}
            />
            <For each={thinking()!.body}>{(row) => <RowText line={row} bg={surface()} />}</For>
          </Show>
          <For each={segments()}>
            {(seg) =>
              seg.kind === "prose" ? (
                <markdown
                  content={seg.text}
                  syntaxStyle={markdownSyntaxStyle()}
                  style={{ width: textWidth(), flexDirection: "column" }}
                />
              ) : (
                <For each={fenceRows(seg, textWidth())}>
                  {(row) => {
                    if (row.copyLine !== undefined && row.copyLine.length > 0) {
                      return <CopyableRow line={row} bg={surface()} onCodeClick={(code, run) => props.onCodeClick?.(code, run)} />
                    }
                    return <RowText line={row} bg={surface()} />
                  }}
                </For>
              )
            }
          </For>
          <Show when={props.streaming}>
            <text style={{ fg: caretColor(), ...textBgProps(surface()) }}> ▌</text>
          </Show>
        </box>
      </box>
    )
  }

  return (
    <box style={cardShell()}>
      <box style={cardBody()}>
        <For each={laid()}>
          {(row) => {
            const actions = row.actions
            if (actions !== undefined && actions.length > 0) {
              return (
                <ActionRow
                  line={row}
                  bg={surface()}
                  actions={actions}
                  onPick={(callId, kind, optionIndex) => props.onCardAction?.(callId, kind, optionIndex)}
                />
              )
            }
            if (row.isLabel === true) {
              return (
                <LabelRow
                  text={row.segs.map((s) => s.text).join("")}
                  style={layout().labelStyle}
                  contentWidth={textWidth()}
                  copyText={copyText()}
                  bg={surface()}
                  onCopy={props.onCopyMessage}
                  onRevert={isUser && props.onRevertMessage !== undefined ? () => props.onRevertMessage?.(props.msg.id) : undefined}
                />
              )
            }
            if (row.copyLine !== undefined && row.copyLine.length > 0) {
              return <CopyableRow line={row} bg={surface()} onCodeClick={(code, run) => props.onCodeClick?.(code, run)} />
            }
            return <RowText line={row} bg={surface()} />
          }}
        </For>
      </box>
    </box>
  )
}
