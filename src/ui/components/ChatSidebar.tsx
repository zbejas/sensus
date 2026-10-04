/**
 * ChatSidebar: message list with roles, streaming
 * markdown rendering, and the multiline chat input. Keystrokes are routed in
 * App (they must never reach the terminal); this component only renders the active
 * tab's RemoteChat.
 *
 * M9 phase 3: the message list is a native `<scrollbox>` (sticky bottom while
 * streaming, free wheel scroll, scrollbar) rendering one block per message —
 * Solid's reference-keyed `<For>` keeps every settled message's component
 * alive across stream deltas; only the streaming message re-renders. The old
 * hand-rolled computeWindow slicing + "↓ new messages" hint + RemoteChat
 * scroll offsets are gone (the scrollbox owns scroll state).
 *
 * M7: a clickable agent-mode chip (`mode:<name> ⇄`) sits above the input, and
 * a click inside the input places the caret at the clicked character (visual
 * row/col mapped back via inputEditor.setCursorVisual).
 *
 * Reactivity notes (Solid):
 * - props.* are only reactive when read inside a computation (memo/JSX
 *   expression) — never destructured into top-level consts.
 * - the input editor is a plain object, so every edit bumps
 *   chat.editorVersion; memos below read that signal first to recompute.
 * - InputRow computes its spans in a createMemo over ALL props (components
 *   run once; a body-level branch froze the caret — M7 fix).
 *
 * Theme (M5): all colors come from theme tokens; boxes/text paint NO
 * background when the active theme's bg is null (adaptive "terminal").
 */

import { type JSX } from "@opentui/solid"
import { MacOSScrollAccel, type MouseEvent, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, Show, For } from "solid-js"
import { bgProps, borderProps, theme } from "../../theme/theme.ts"
import { blinkActivity } from "../lib/blink.ts"
import type { RemoteChat } from "../../client/remoteChat.ts"
import type { SlashCommandInfo } from "../../engine/index.ts"
import { thinkingHeaderText } from "../chat/chatLayout.ts"
import { createEntranceTracker } from "../chat/entrance.ts"
import { menuWindow } from "../chat/slashComplete.ts"
import { spinnerChar } from "../lib/spinner.ts"
import { leftClickColumn } from "../lib/clickTarget.ts"
import { bgStyle } from "../chat/chatRowStyle.ts"
import { MessageBlock } from "./chat/MessageBlock.tsx"
import { AgentChip } from "./chat/Rows.tsx"
import { DraftImageRow, InputRow, SlashMenuRow } from "./chat/InputRows.tsx"

export interface ChatSidebarProps {
  chat: RemoteChat
  focused: boolean
  /** Outer sidebar width in columns. */
  width: number
  onMouseDown?: (e: MouseEvent) => void
  /** Card action click (accept/reject/allow/option/plan controls/expand
   * toggles) — wired by App. */
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
  /** Message label-row copy click: raw message text → system clipboard. */
  onCopyMessage?: (text: string) => void
  /** User-message label `↺ revert` click: rewind the chat to that message. */
  onRevertMessage?: (id: number) => void
  /** Agent chip click: cycle to the next agent (wired by App). */
  onCycleAgent?: () => void
  /** Bumped to jump the message list to the newest message (Alt+End /
   * the palette's "Jump to latest"); skipped on mount. */
  scrollBottomTick?: () => number
  /** Bumped to scroll the message list by `scrollPages` viewport lengths
   * (PgUp/PgDn, Ctrl+Home/End); skipped on mount. */
  scrollTick?: () => number
  scrollPages?: () => number
}

const INPUT_MAX_ROWS = 5
const PLACEHOLDER = " ask the agent… (Enter sends · Shift+Enter newline) "
/** Slash autocomplete: visible rows; the window slides around the selection. */
const SLASH_MENU_MAX_ROWS = 6

export function ChatSidebar(props: ChatSidebarProps): JSX.Element {
  const chat = props.chat
  const focused = createMemo(() => props.focused)
  const width = createMemo(() => Math.max(1, Math.floor(props.width)))
  // Both message rows and input rows render inside this many columns. The
  // outer body carries a 1-col padding on each side (the panels float inside
  // the chat card like the website example); the remaining 4 columns are the
  // card's border (2) and the scrollbar/slack (2), so a full-width assistant
  // card never clips when the scrollbar appears.
  const contentW = createMemo(() => Math.max(4, width() - 7))
  const t = () => theme()

  // Jump-to-latest (Alt+End / palette "Jump to latest"): the scrollbox owns
  // scroll state, so App bumps a store signal and this effect drives the
  // renderable to the bottom. While a generation keeps appending, a manual
  // scroll-up can be a long way back; this is the one-key return.
  let scrollBox: ScrollBoxRenderable | null = null
  const scrollToLatest = (): void => {
    const sb = scrollBox
    if (sb === null) return
    try {
      sb.scrollTo({ x: 0, y: Math.max(0, sb.scrollHeight - sb.viewport.height) })
    } catch {
      // best-effort: a renderable quirk must never take the TUI down
    }
  }
  let lastBottomTick = props.scrollBottomTick?.() ?? 0
  createEffect(() => {
    const tick = props.scrollBottomTick?.() ?? 0
    if (tick === lastBottomTick) return
    lastBottomTick = tick
    scrollToLatest()
  })
  // PgUp/PgDn / Ctrl+Home/End: scroll by viewport fractions (or a huge amount
  // to clamp to an edge) through the same store-bump pattern as jump-to-latest.
  let lastScrollTick = props.scrollTick?.() ?? 0
  createEffect(() => {
    const tick = props.scrollTick?.() ?? 0
    if (tick === lastScrollTick) return
    lastScrollTick = tick
    const sb = scrollBox
    const pages = props.scrollPages?.() ?? 0
    if (sb === null || pages === 0) return
    try {
      sb.scrollBy(pages, "viewport")
    } catch {
      // best-effort: a renderable quirk must never take the TUI down
    }
  })

  // Entrance-animation tracker: one per sidebar, so the streaming block's
  // per-delta remount never replays a message's entrance (ui/chat/entrance.ts).
  const entranceStart = createEntranceTracker()
  // Wheel acceleration: a quick wheel burst traverses long transcripts faster
  // while a slow gesture stays precise (macOS-style).
  const scrollAccel = new MacOSScrollAccel()
  // Scrollbar thumb: the theme scrollbar token when set, else the neutral
  // muted grey (the adaptive `terminal` theme leaves it null). Track stays
  // transparent so the zero-background invariant holds.
  const scrollbarColor = createMemo(() => t().scrollbar ?? t().muted)

  const editor = chat.editorState
  const version = chat.accessors.editorVersion
  const messages = chat.accessors.messages
  const draftImages = chat.accessors.draftImages
  const status = chat.accessors.status
  const compacting = chat.accessors.compacting
  const empty = createMemo(() => messages().length === 0)

  // Editor visual layout — recomputed on every keystroke (version bump).
  const vis = createMemo(() => {
    version()
    return editor.visual(contentW())
  })
  const inputInnerRows = createMemo(() => Math.min(INPUT_MAX_ROWS, Math.max(1, vis().rows.length)))
  /** One extra inner row when draft image chips are present. */
  const draftH = createMemo(() => (draftImages().length > 0 ? 1 : 0))
  const inputOuterH = createMemo(() => inputInnerRows() + draftH() + 2)
  const disabled = createMemo(() => status() === "disabled")

  // M8 slash autocomplete: re-derived on every editor bump (openness and the
  // match list are pure functions of the draft + cursor — chat.slashMenu()).
  // The selection index and the sliding window live here as memos; nothing is
  // stored, so the menu can never go stale across tab switches.
  const menuMatches = createMemo<readonly SlashCommandInfo[] | null>(() => {
    version()
    if (!focused()) return null
    const m = chat.slashMenu()
    return m === null ? null : m.matches
  })
  const selIdx = createMemo(() => {
    const matches = menuMatches()
    if (matches === null) return 0
    return Math.min(chat.accessors.slashSelection(), matches.length - 1)
  })
  const menuWin = createMemo(() => {
    const matches = menuMatches()
    return matches === null ? null : menuWindow(matches, selIdx(), SLASH_MENU_MAX_ROWS)
  })

  // Input window: rows around the cursor, bottom-anchored, capped height.
  const inWindow = createMemo(() => {
    const v = vis()
    const rows = v.rows
    const start = Math.max(0, Math.min(v.cursorRow, rows.length - inputInnerRows()))
    return { rows: rows.slice(start, start + inputInnerRows()), start, cursorRow: v.cursorRow, cursorCol: v.cursorCol }
  })
  const editorEmpty = createMemo(() => {
    version()
    return editor.isEmpty()
  })

  const sidebarBorder = createMemo(() => (focused() ? t().borderFocused : t().border))
  // Streaming caret + live label ride on the ACTIVE assistant bubble only. The
  // assistant bubble is created lazily (on its first delta), so before that —
  // while the model is thinking — there is no message to host the animation
  // (see waitingLabel below).
  const streamingId = createMemo(() => {
    if (status() !== "streaming") return null
    const last = messages().at(-1)
    return last?.role === "assistant" ? last.id : null
  })
  // Standalone animated indicator for the gaps with no assistant bubble yet:
  // right after a send (waiting for the model's first token) and between tool
  // turns. Without it the only cue was the bare streaming caret (a blue line).
  // It uses the active thinking header's exact text/style, so when the bubble
  // appears (with its own header or streaming label) the swap is seamless. No
  // elapsed here: the bubble measures per-bubble time, the status bar total, so
  // a duration would visibly reset at the handoff. Suppressed while a tool card
  // is pending/running — that is the user or the command being waited on, not
  // the model — and it reads the shared 80ms tick only while visible, so
  // settled sessions never subscribe.
  const waitingLabel = createMemo(() => {
    if (status() !== "streaming" || streamingId() !== null) return null
    // Compaction owns the cue while it runs (compactingLabel below).
    if (compacting()) return null
    const last = messages().at(-1)
    const tool = last?.tool
    if (tool !== undefined && (tool.status === "pending" || tool.status === "running")) return null
    // A pending approval-batch plan is the user's turn to act, not the model's.
    if (last?.plan !== undefined && last.plan.resolved !== true) return null
    return thinkingHeaderText(spinnerChar(chat.accessors.animations()))
  })

  // Compaction progress (docs/agent.md "Streaming display"): manual `/compact`
  // and the automatic preflight pass both set the flag. Shown as a standalone
  // row (a compaction has no assistant bubble to host it) and reads the shared
  // 80ms tick only while visible, so settled sessions never subscribe.
  const compactingLabel = createMemo(() => {
    if (!compacting()) return null
    return `${spinnerChar(chat.accessors.animations())} compacting context…`
  })

  // Busy-send indicator (docs/config.md `chat.busySend`): messages accepted
  // while the reply streams. A steer lands in the transcript at the next safe
  // boundary; a queued message sends once the reply settles. Shown so held
  // input is never invisible.
  const pendingLabel = createMemo(() => {
    const p = chat.accessors.busyPending()
    const parts: string[] = []
    if (p.steer > 0) parts.push(`⇢ steering ${p.steer}`)
    if (p.queue > 0) parts.push(`⧗ queued ${p.queue}`)
    return parts.length > 0 ? ` ${parts.join(" · ")} ` : null
  })

  /**
   * Click inside the input: place the caret at the clicked character
   * (visual row/col mapped back to the editor cursor — inputEditor.ts
   * setCursorVisual). The click also focuses the sidebar (the enclosing
   * boxes' onMouseDown fires via bubbling).
   */
  const handleInputClick = (visualRow: number, e: MouseEvent): void => {
    const col = leftClickColumn(e) // null on right-click = selection copy, not caret placement
    if (col === null) return
    editor.setCursorVisual(visualRow, col, contentW())
    chat.noteTextEdited()
    chat.bumpEditor()
    blinkActivity() // caret moved: hold it solid
  }

  return (
    <box
      title={focused() ? " chat ● " : " chat "}
      titleAlignment="left"
      titleColor={focused() ? t().accent : t().muted}
      onMouseDown={props.onMouseDown}
      style={{
        width: width(),
        flexDirection: "column",
        border: true,
        borderStyle: "rounded",
        // 1-col side padding: the message panels float inside the chat card
        // instead of gluing to its border (docs/DESIGN.md "Chat sidebar").
        paddingLeft: 1,
        paddingRight: 1,
        ...borderProps(sidebarBorder()),
        ...bgProps(t().bg),
      }}
    >
      <box
        style={{ flexGrow: 1, flexDirection: "column", width: "100%", minHeight: 0 }}
        onMouseDown={props.onMouseDown}
      >
        <Show
          when={empty()}
          fallback={
            <scrollbox
              ref={(el) => (scrollBox = el)}
              flexGrow={1}
              stickyScroll
              stickyStart="bottom"
              scrollY
              scrollAcceleration={scrollAccel}
              rootOptions={{ backgroundColor: "transparent" }}
              wrapperOptions={{ backgroundColor: "transparent" }}
              viewportOptions={{ backgroundColor: "transparent" }}
              contentOptions={{ backgroundColor: "transparent" }}
              verticalScrollbarOptions={{
                width: 1,
                showArrows: false,
                trackOptions: { backgroundColor: "transparent", foregroundColor: scrollbarColor() },
              }}
              style={{
                width: "100%",
                ...bgProps(t().bg),
              }}
              onMouseDown={props.onMouseDown}
            >
              <For each={messages()}>
                {(msg) => (
                  <MessageBlock
                    msg={msg}
                    contentWidth={contentW()}
                    streaming={msg.id === streamingId()}
                    thinkingOpen={chat.thinkingOpen(msg.id)}
                    thinkingActive={status() === "streaming" && msg.id === streamingId() && msg.content.length === 0}
                    toolOutput={msg.tool !== undefined && msg.tool !== null
                      ? chat.cardExpanded(msg.tool.callId)
                        ? "expanded"
                        : "collapsed"
                      : chat.accessors.toolDetails()}
                    animations={chat.accessors.animations()}
                    cardStyle={chat.accessors.cardStyle()}
                    agentName={chat.agentName()}
                    entranceStart={entranceStart}
                    revealContentCut={(id, content, settled) => chat.revealContentCut(id, content, settled)}
                    revealThinkingCut={(id, thinking, settled) => chat.revealThinkingCut(id, thinking, settled)}
                    onCardAction={(callId, kind, optionIndex) => props.onCardAction?.(callId, kind, optionIndex)}
                    onCodeClick={(code, run) => props.onCodeClick?.(code, run)}
                    onCopyMessage={(text) => props.onCopyMessage?.(text)}
                    onRevertMessage={(id) => props.onRevertMessage?.(id)}
                  />
                )}
              </For>
              {/* Waiting-for-the-model indicator (before the first delta of a
                  turn / between tool turns): the active thinking header's text
                  and style, so the handoff to a real block is seamless. */}
              <Show when={waitingLabel() !== null}>
                <text selectable={false} style={{ fg: t().fg, ...bgStyle(t()) }}>
                  <span style={{ fg: t().accent, italic: true }}>{waitingLabel()}</span>
                </text>
              </Show>
              {/* Compaction progress row (manual /compact + automatic
                  preflight): distinct from a normal turn, shown even before
                  any assistant bubble exists. */}
              <Show when={compactingLabel() !== null}>
                <text selectable={false} style={{ fg: t().fg, ...bgStyle(t()) }}>
                  <span style={{ fg: t().accent, italic: true }}>{compactingLabel()}</span>
                </text>
              </Show>
            </scrollbox>
          }
        >
          <text selectable={false} style={{ fg: t().muted }}>
            {` no messages yet — try "what is this machine?" · / for commands · ctrl+p palette `}
          </text>
        </Show>
      </box>

      <Show when={disabled()}>
        <text selectable={false} style={{ fg: t().danger }}> no API key — terminal keeps working (ctrl+o settings → endpoint → apiKey) </text>
      </Show>

      {/* Agent chip: click cycles to the next agent (the status-bar chip and
          Alt+M / /agent open the full picker). fg-only — no painted background
          in chrome. */}
      <box style={{ height: 1, flexDirection: "row", width: "100%" }} onMouseDown={props.onMouseDown}>
        <AgentChip name={chat.agentName()} onCycle={() => props.onCycleAgent?.()} />
      </box>

      {/* Busy-send pending row (steer/queue while a reply streams). */}
      <Show when={pendingLabel() !== null}>
        <box style={{ height: 1, flexDirection: "row", width: "100%" }} onMouseDown={props.onMouseDown}>
          <text selectable={false} style={{ fg: t().muted }}>{pendingLabel()}</text>
        </box>
      </Show>

      {/* M8 slash autocomplete: floats above the input (absolute — M9: a
          remounted flow sibling of the message scrollbox does not repaint
          reliably), one command + description per row, overlaying the bottom
          message rows. Opaque panel (theme cardBg — same overlay color as the
          toast/command menu: with a transparent bg the messages underneath
          bleed through and the menu is unreadable). Selected row = ❯ marker +
          accent fg; rows are clickable to accept. */}
      <Show when={menuWin() !== null}>
        <box
          style={{
            position: "absolute",
            // `left` is relative to the border box, so 1 lands on the body's
            // padding edge (matching the message cards and the input card).
            left: 1,
            bottom: inputOuterH() + 1,
            width: contentW() + 2,
            flexDirection: "column",
            ...bgProps(t().cardBg),
          }}
          onMouseDown={props.onMouseDown}
        >
          <For each={menuWin()?.rows ?? []}>
            {(cmd, i) => (
              <SlashMenuRow
                cmd={cmd}
                selected={i() + (menuWin()?.start ?? 0) === selIdx()}
                rowWidth={contentW() + 2}
                onPick={(name) => chat.acceptSlashNamed(name)}
              />
            )}
          </For>
        </box>
      </Show>

      <box
        title={focused() ? " input ● " : " input "}
        titleAlignment="left"
        titleColor={focused() ? t().accent : t().muted}
        onMouseDown={props.onMouseDown}
        style={{
          height: inputOuterH(),
          flexDirection: "column",
          width: "100%",
          border: true,
          borderStyle: "rounded",
          ...borderProps(sidebarBorder()),
          ...bgProps(t().bg),
        }}
      >
        <Show when={draftH() > 0}>
          <DraftImageRow images={draftImages()} rowWidth={contentW()} onRemove={(id) => chat.removeDraftImage(id)} />
        </Show>
        <For each={inWindow().rows}>
          {(rowText, i) => (
            <InputRow
              text={rowText}
              isCursor={inWindow().start + i() === inWindow().cursorRow}
              cursorCol={inWindow().cursorCol}
              focused={focused()}
              placeholder={
                editorEmpty() && i() === inWindow().rows.length - 1 ? PLACEHOLDER.slice(0, contentW() - 4) : ""
              }
              rowWidth={contentW()}
              onMouseDown={(e) => handleInputClick(inWindow().start + i(), e)}
            />
          )}
        </For>
      </box>
    </box>
  )
}
