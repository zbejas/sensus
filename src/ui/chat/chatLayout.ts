/**
 * Pure layout for the chat message list (docs/agent.md
 * M3): converts chat messages into visual rows (labels + wrapped body) ready
 * for the sidebar. No Solid/opentui imports — unit-testable.
 *
 * - user/system/error content is shown verbatim (plain wrap; never parsed as
 *   markdown — a user pasting "rm **" must see it unchanged)
 * - assistant content goes through the terminal markdown renderer
 * - every message gets a one-row label (role + agent) so the transcript is
 *   scannable and smoke tests have stable strings to assert
 * - tool calls render as cards: name + params, status, output preview and a
 *   diff (edit/write); pending cards carry clickable action rows
 */

import { type ChatMessage, type PlanCardData, type PlanLineStatus, type ToolCardData, type ToolCardStatus } from "../../engine/index.ts"
import { renderMarkdown, wrapLines, plain, textLine, linkifyLines, type MdLine, type Seg, type SegStyle } from "../../engine/index.ts"
import { cps, truncateWithEllipsis } from "../../core/util.ts"

export interface LayoutMessage {
  /** Role label row text (e.g. "❯ you", "✱ copilot"). */
  label: string
  labelStyle: SegStyle
  body: MdLine[]
}

/** A clickable action on a card row (approval buttons, plan controls,
 * ask_user options, expand/collapse toggles). */
export interface CardAction {
  label: string
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
    | "plan-cancel"
  callId: string
  optionIndex?: number
}

/** Display options (docs/config.md "chat"; session overrides via /details).
 * Pure defaults preserve the legacy (pre-M10) fully-expanded rendering. */
export interface LayoutOptions {
  /** Tool-call output: "collapsed" shows a ~6-line preview + expand hint. */
  toolOutput?: "expanded" | "collapsed"
  /** Animated glyph replacing "◐" on running tool cards (undefined = static). */
  runningGlyph?: string
  /** Assistant label name (the active agent). Falls back to the message's model
   * when absent/empty — the sidebar passes the session agent's name. */
  agentName?: string
}

const STATUS_GLYPH: Record<ToolCardStatus, string> = {
  pending: "○ awaiting approval",
  approved: "◐ approved",
  running: "◐ running",
  done: "● done",
  error: "✗ error",
  rejected: "⊘ rejected",
  aborted: "⏹ aborted",
}

/** Collapsed tool-output preview height (lines shown before the hint row). */
const OUTPUT_PREVIEW_LINES = 6
/** Hard cap for an EXPANDED output preview (defensive — model-facing output
 * is already truncated at ~8k chars, but be safe against pathological cards). */
const OUTPUT_EXPAND_CAP = 400

/** "2.3s" / "12s" / "1m04s" — thinking + assistant label durations. Pure. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  if (ms < 1000) return "<1s"
  if (ms < 60_000) return `${(Math.round(ms) / 1000).toFixed(1)}s`
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`
}

/** "12s" / "1m04s" / "<1s" — streaming elapsed label. Pure. */
export function elapsedText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s"
  if (ms < 1000) return "<1s"
  const total = Math.floor(ms / 1000)
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`
}

/** Animated streaming label (`⠙ gpt-5 · 3s`) — the assistant bubble's live label.
 * Per-bubble elapsed (from the bubble's `ts`). Pure. */
export function streamingLabelText(glyph: string, name: string, elapsedMs: number): string {
  return `${glyph} ${name} · ${elapsedText(elapsedMs)}`
}

/** Active reasoning header (`⠙ Thinking`). Shared by the in-bubble thinking
 * block and the standalone waiting row shown before the bubble exists (and
 * between tool turns), so the swap is seamless. Pure. */
export function thinkingHeaderText(glyph: string): string {
  return `${glyph} Thinking`
}

/** The assistant bubble's live label: the animated streaming label while the
 * answer streams, or null while the active thinking header is the bubble's only
 * live row (otherwise its spinner stacks directly above the `⠋ Thinking`
 * header — two spinners on the same frame). Returns null when not streaming —
 * the settled label takes over. `thinkingLive` is the flushed-reasoning signal
 * (a sub-flush window before the first reasoning delta shows the label, its
 * only sensible cue). `glyph` is a thunk so the shared spinner tick is read
 * only when the label actually renders — settled/non-streaming blocks must
 * never subscribe (docs/DESIGN.md "Motion"). Pure — unit-tested. */
export function liveAssistantLabel(
  streaming: boolean,
  thinkingLive: boolean,
  glyph: () => string,
  name: string,
  elapsedMs: number,
): string | null {
  if (!streaming || thinkingLive) return null
  return streamingLabelText(glyph(), name, elapsedMs)
}

/** Render one chat message into label + wrapped body rows. */
export function layoutMessage(msg: ChatMessage, width: number, opts: LayoutOptions = {}): LayoutMessage {
  const w = Math.max(4, Math.floor(width))
  switch (msg.role) {
    case "user":
      return {
        label: "❯ you",
        labelStyle: { bold: true, accent: true },
        body: wrapPlain(msg.content, {}, w),
      }
    case "assistant": {
      const tag = msg.aborted ? " (aborted)" : ""
      const dur = typeof msg.finishedTs === "number" ? ` · ${formatDuration(msg.finishedTs - msg.ts)}` : ""
      // The label names the AGENT (docs/ui.md "Chat rendering"); the message's
      // model is only the fallback when no agent name is supplied.
      const who = (opts.agentName !== undefined && opts.agentName.length > 0 ? opts.agentName : msg.model) ?? ""
      const modelTag = who.length > 0 ? `✱ ${who}${dur}${tag}` : tag.length > 0 ? `✱${tag}` : "✱"
      const md = renderMarkdown(msg.content)
      return { label: modelTag, labelStyle: { dim: true }, body: wrapLines(md, w) }
    }
    case "system":
      return { label: "", labelStyle: { dim: true }, body: wrapPlain(msg.content, {}, w) }
    case "error":
      return {
        label: "⚠ error",
        labelStyle: { error: true },
        body: wrapPlain(msg.content, { error: true }, w),
      }
    case "tool":
      return msg.plan !== undefined ? layoutPlanCard(msg.plan, w) : layoutToolCard(msg, w, opts)
  }
}

/** One line's status glyph inside an approval plan. */
const PLAN_LINE_GLYPH: Record<PlanLineStatus, string> = {
  pending: "○",
  approved: "✓",
  rejected: "⊘",
}

/**
 * Approval-batch plan card (docs/agent.md "Approval-batch plan card"): an
 * ordered list of the gated calls of ONE assistant turn, each with its own
 * decision, plus approve-all / deny-all / confirm controls. The plan is the
 * single gate for the turn; each line's full command/detail and pending diff
 * render here (a destructive line is marked and never pre-approved). Once
 * committed/cancelled the card freezes to its outcome. Pure — unit-tested.
 */
function layoutPlanCard(plan: PlanCardData, w: number): LayoutMessage {
  const body: MdLine[] = []
  const total = plan.lines.length
  const approved = plan.lines.filter((l) => l.status === "approved").length
  const pending = plan.resolved !== true
  body.push(
    textLine(`▸ plan · ${total} approval${total === 1 ? "" : "s"}`, { bold: true, accent: pending }),
  )
  plan.lines.forEach((line, i) => {
    const cursor = pending && i === plan.cursor ? "❯" : " "
    const dest = line.destructive === true ? "  ⚠ destructive" : ""
    const summary = line.paramsSummary.length > 0 ? `  ${truncateToWidth(line.paramsSummary, Math.max(8, w - 24))}` : ""
    const style =
      line.status === "rejected"
        ? { dim: true }
        : line.status === "pending" && line.destructive === true
          ? { error: true }
          : {}
    const row = textLine(`${cursor} ${PLAN_LINE_GLYPH[line.status]} [${i + 1}/${total}] ${line.name}${summary}${dest}`, style)
    // The whole line toggles its own decision on click (mouse parity with space).
    if (pending) (row as LayoutRow).actions = [{ label: `toggle ${line.name}`, kind: "plan-toggle", callId: line.callId }]
    body.push(row)
    // Full, untruncated approval detail (the complete command / MCP args blob).
    if (typeof line.detail === "string" && line.detail.length > 0) {
      for (const dl of line.detail.split("\n")) body.push(...wrapPlain(`    ${dl}`, {}, w))
    }
    // Pending file diff (edit_file / write_file), capped like a single card.
    if (line.diff && line.diff.length > 0) {
      for (const d of line.diff.slice(0, 20)) {
        const ds = d.kind === "+" ? { accent: true } : d.kind === "-" ? { error: true } : { dim: true }
        body.push(...wrapPlain(`    ${d.kind} ${d.text}`, ds, w))
      }
      if (line.diff.length > 20) body.push(textLine(`    … (+${line.diff.length - 20} diff rows)`, { dim: true }))
    }
  })

  if (!pending) {
    body.push(
      textLine(
        plan.outcome === "aborted" ? "  plan aborted — nothing ran" : `  plan committed — ${approved}/${total} approved`,
        { dim: true },
      ),
    )
    return { label: "", labelStyle: {}, body }
  }

  // Controls: per-line decisions were collected above; one step commits them.
  const current = plan.lines[plan.cursor]
  const controls: CardAction[] = [
    { label: "A approve all", kind: "plan-approve-all", callId: "" },
    { label: "N deny all", kind: "plan-deny-all", callId: "" },
    { label: "↵ confirm", kind: "plan-confirm", callId: "" },
    { label: "esc cancel", kind: "plan-cancel", callId: "" },
  ]
  // Session trust for the highlighted line's operation class, when it has one
  // (never for a destructive line) — parity with the single card's `a`.
  if (current !== undefined && current.destructive !== true && current.allowPrefix) {
    controls.unshift({ label: `a trust ${current.allowPrefix.trim()}*`, kind: "plan-trust", callId: current.callId })
  }
  for (const a of controls) {
    const row = textLine(`  [${a.label}]`, { accent: true })
    ;(row as LayoutRow).actions = [a]
    body.push(row)
  }
  if (plan.lines.some((l) => l.destructive === true && l.status === "pending")) {
    body.push(textLine("  ⚠ destructive lines need explicit approval — otherwise they are rejected", { dim: true, error: true }))
  }
  return { label: "", labelStyle: {}, body }
}

/** Tool call card: name + params, status, diff (when present), output preview.
 * Collapsed mode (docs/config.md "chat.toolOutput") shows a preview + hint and
 * makes the header/hint rows clickable expand toggles. */
function layoutToolCard(msg: ChatMessage, w: number, opts: LayoutOptions = {}): LayoutMessage {
  const tool = msg.tool
  if (!tool) return { label: "", labelStyle: {}, body: [] }
  // A pending card renders its FULL command/args in the body (never clipped) —
  // the header peek is suppressed then, since it would duplicate a truncated
  // copy of the same text directly above the full one (docs/ui.md "Tool cards").
  const showDetail = tool.status === "pending" && hasFullerDetail(tool)
  const head = `▸ ${tool.name}${!showDetail && tool.paramsSummary.length > 0 ? `  ${truncateToWidth(tool.paramsSummary, w - 4)}` : ""}`
  // The header toggles output expansion — but only when there is output to
  // expand and the card is not awaiting action rows (mis-click hazard).
  const toggleAction: CardAction[] =
    tool.status === "pending" || !hasOutput(tool)
      ? []
      : [{ label: "toggle output", kind: "toggle-card", callId: tool.callId }]
  const headLine = textLine(head, { bold: true, accent: tool.status === "pending" })
  if (toggleAction.length > 0) (headLine as LayoutRow).actions = toggleAction
  const body: MdLine[] = [headLine]
  // Full approval detail, wrapped and never truncated: a long or multi-line
  // command (or MCP args blob) is exactly what the user is being asked to
  // accept, so it must be fully visible (docs/agent.md "Approval modes").
  if (showDetail && typeof tool.detail === "string") {
    for (const line of tool.detail.split("\n")) body.push(...wrapPlain(`  ${line}`, {}, w))
  }
  const runningGlyph = opts.runningGlyph ?? STATUS_GLYPH["running"].slice(0, 1)
  const statusNote =
    tool.status === "done" && typeof tool.exitCode === "number"
      ? `${STATUS_GLYPH[tool.status]} · exit ${tool.exitCode}`
      : tool.status === "running"
        ? `${runningGlyph} running`
        : STATUS_GLYPH[tool.status]
  body.push(textLine(`  ${statusNote}`, { dim: tool.status !== "pending", error: tool.status === "error" }))

  // Diff rows (edit_file / write_file) styled +/-.
  if (tool.diff && tool.diff.length > 0) {
    for (const d of tool.diff.slice(0, 30)) {
      const style = d.kind === "+" ? { accent: true } : d.kind === "-" ? { error: true } : { dim: true }
      body.push(...wrapPlain(`${d.kind} ${d.text}`, style, w))
    }
    if (tool.diff.length > 30) body.push(textLine(`  … (+${tool.diff.length - 30} diff rows)`, { dim: true }))
  }

  // ask_user question + numbered options (each option row is clickable).
  // The question renders IN FULL — wrapped, never truncated — with markdown
  // and bare URLs as clickable OSC-8 links. A final "type your own answer"
  // entry is always appended: it is NOT a real option (its index is one past
  // the list, so picking it never sends the label as the answer — the user
  // types their reply into the chat input instead).
  if (typeof tool.question === "string" && tool.status === "running") {
    for (const line of linkifyLines(tool.question)) {
      body.push(...wrapLines([{ segs: [plain("  ", {}), ...line.segs] }], w))
    }
    const options = tool.options ?? []
    options.forEach((opt, i) => {
      // An option IS a candidate answer, so it renders in FULL like the
      // question — wrapped, never truncated (docs/ui.md "Tool cards"). The
      // hanging indent aligns continuation rows under the option text, and
      // EVERY wrapped row carries the same click action so any part of the
      // option is a target.
      const prefix = `  [${i + 1}] `
      const rows = wrapPlain(opt, { accent: true }, Math.max(4, w - prefix.length))
      rows.forEach((r, k) => {
        const row: LayoutRow = {
          segs: [plain(k === 0 ? prefix : " ".repeat(prefix.length), { accent: true }), ...r.segs],
          actions: [{ label: opt, kind: "option", callId: tool.callId, optionIndex: i }],
        }
        body.push(row)
      })
    })
    const custom = textLine(`  [${options.length + 1}] ✎ type your custom answer in the chat`, { dim: true })
    ;(custom as LayoutRow).actions = [
      { label: "custom answer", kind: "option", callId: tool.callId, optionIndex: options.length },
    ]
    body.push(custom)
  }

  // Output preview (docs/agent.md loop #4 + docs/config.md "chat.toolOutput"):
  // collapsed shows a preview + clickable hint; expanded shows everything up
  // to a defensive cap.
  if (hasOutput(tool)) {
    const lines = (tool.output ?? "").split("\n")
    const expanded = opts.toolOutput !== "collapsed"
    const cap = expanded ? OUTPUT_EXPAND_CAP : OUTPUT_PREVIEW_LINES
    const shown = lines.slice(0, cap)
    const inner = Math.max(8, w - 4)
    if (expanded) {
      // Expanded WRAPS each line: the collapsed view truncates to the card
      // width, so a single long line (e.g. `memory read journal`) would be
      // revealed as the SAME truncated text — "expand" would look like a no-op.
      for (const l of shown) body.push(...wrapPlain(`  ${l}`, { dim: true }, w))
    } else {
      for (const l of shown) body.push(textLine(`  ${truncateToWidth(l, inner)}`, { dim: true }))
    }
    const remaining = lines.length - shown.length
    // A long single line has nothing "more" by line count, yet still hides text.
    const clipped = !expanded && shown.some((l) => cps(l).length > inner)
    if (remaining > 0 || clipped) {
      const lead = remaining > 0 ? `… +${remaining} line${remaining === 1 ? "" : "s"}` : "… long line"
      const hint = textLine(`  ${lead} (${expanded ? "output capped" : "click or Alt+E to expand"})`, { dim: true })
      if (!expanded) (hint as LayoutRow).actions = [{ label: "toggle output", kind: "toggle-card", callId: tool.callId }]
      body.push(hint)
    }
  }

  // Pending approval card: status row + one clickable row per action.
  if (tool.status === "pending") {
    const actions: CardAction[] = [
      { label: "y accept", kind: "accept", callId: tool.callId },
      { label: "n reject", kind: "reject", callId: tool.callId },
    ]
    if (tool.destructive !== true && tool.allowPrefix) {
      actions.push({ label: `a allow ${tool.allowPrefix.trim()}*`, kind: "allow", callId: tool.callId })
    }
    for (const a of actions) {
      const row = textLine(`  [${a.label}]`, { accent: true })
      ;(row as LayoutRow).actions = [a]
      body.push(row)
    }
    if (tool.destructive === true) body.push(textLine("  destructive — allow disabled", { dim: true }))
  }

  return { label: "", labelStyle: {}, body }
}

function hasOutput(tool: ToolCardData): boolean {
  return typeof tool.output === "string" && tool.output.length > 0
}

/**
 * True when a pending card's full approval detail says more than the header's
 * clipped params peek — a multi-line command (a `&&` continuation) or one the
 * 72-char summary already elided. A short single-line command is left to the
 * header alone: the body would just repeat it verbatim.
 */
function hasFullerDetail(tool: ToolCardData): boolean {
  const detail = typeof tool.detail === "string" ? tool.detail : ""
  if (detail.length === 0) return false
  const lines = detail.split("\n")
  if (lines.length > 1) return true
  return (lines[0] ?? "").trim() !== tool.paramsSummary
}

/** Result of layoutThinking: header row (clickable when collapsible) + the
 * dim body rows (present only while open). */
export interface ThinkingLayout {
  header: LayoutRow
  body: MdLine[]
}

/**
 * Reasoning ("thinking") block layout: while the model is
 * still reasoning the header is a spinner + "Thinking"; once done it becomes
 * `+ Thought for 2.3s` (collapsed) or `- Thought for 2.3s` (open), and the
 * body renders muted + italic below. When the block is NOT open (session
 * `/thinking hide`), only the one-line header shows — the reasoning body is
 * not drawn until the user expands it with Alt+T / a header click. BOTH header
 * forms carry the toggle action (the active spinner too, so reasoning can be
 * read while it streams). `bodyText` overrides the rendered body (stream-reveal
 * pacing — ChatSidebar passes the revealed prefix; the header duration still
 * comes from the message). Pure — unit-tested.
 */
export function layoutThinking(
  msg: ChatMessage,
  width: number,
  opts: { open: boolean; active: boolean; glyph?: string; bodyText?: string },
): ThinkingLayout | null {
  const w = Math.max(4, Math.floor(width))
  const raw = (msg.thinking ?? "").trim()
  if (raw.length === 0) return null
  const text = (opts.bodyText ?? msg.thinking ?? "").trim()
  const dur = typeof msg.thinkingMs === "number" ? ` for ${formatDuration(msg.thinkingMs)}` : ""
  let header: LayoutRow
  if (opts.active) {
    header = textLine(thinkingHeaderText(opts.glyph ?? "◐"), { accent: true, italic: true })
  } else {
    header = textLine(`${opts.open ? "-" : "+"} Thought${dur}`, { dim: true })
  }
  header.actions = [{ label: "toggle thinking", kind: "toggle-thinking", callId: String(msg.id) }]
  const body: MdLine[] = []
  if (opts.open) {
    const lines = text.split("\n")
    const shown = lines.slice(0, 300)
    for (const l of shown) body.push(...wrapPlain(l === "" ? "" : l, { dim: true, italic: true }, w - 2))
    if (lines.length > shown.length) body.push(textLine(`… +${lines.length - shown.length} more lines`, { dim: true }))
  }
  return { header, body }
}

/** Rows can carry actions (windowing preserves them via RowExtras copies);
 * `isLabel` marks the per-message label row (it hosts the copy affordance). */
export type LayoutRow = MdLine & { actions?: CardAction[]; isLabel?: boolean }

/** Are two rows semantically identical — same segments (text + flat style
 * flags), same action list, same label/copy markers? Two rows that render
 * identically must be interchangeable, so their OBJECT IDENTITY can be
 * preserved across a recompute (see {@link reuseRows}). `runningGlyph` is not an
 * input: a row whose only change is the animated status glyph is NOT equal and
 * is rebuilt, while every settled row stays byte-identical. Pure —
 * unit-tested. */
export function sameRow(a: LayoutRow, b: LayoutRow): boolean {
  if (a.isLabel !== b.isLabel || a.copyLine !== b.copyLine) return false
  if (a.segs.length !== b.segs.length) return false
  for (let i = 0; i < a.segs.length; i++) {
    const x = a.segs[i]
    const y = b.segs[i]
    if (x === undefined || y === undefined || !sameSeg(x, y)) return false
  }
  return sameActions(a.actions, b.actions)
}

function sameSeg(a: Seg, b: Seg): boolean {
  if (a.text !== b.text) return false
  const x = a.style
  const y = b.style
  return (
    x.bold === y.bold &&
    x.italic === y.italic &&
    x.underline === y.underline &&
    x.code === y.code &&
    x.heading === y.heading &&
    x.link === y.link &&
    x.href === y.href &&
    x.dim === y.dim &&
    x.error === y.error &&
    x.accent === y.accent
  )
}

function sameActions(a: readonly CardAction[] | undefined, b: readonly CardAction[] | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined || y === undefined) return false
    if (x.label !== y.label || x.kind !== y.kind || x.callId !== y.callId || x.optionIndex !== y.optionIndex) return false
  }
  return true
}

/** Reconcile a freshly laid row list against the previous one, REUSING the
 * previous object for every semantically-unchanged row. The chat row model is
 * positional, so rows are paired by index; an index whose row renders
 * identically is safe to reuse there (a reused row also keeps its mapped
 * component instance under `<For>`, and therefore its hover/press signals).
 *
 * This is what stops the 80ms spinner tick from remounting a running card's
 * interactive rows: only the status row carries the animated glyph, so only it
 * is not equal and gets a fresh object; ask_user options, approval buttons and
 * toggle/copy rows keep their identity and stay hovered (docs/DESIGN.md
 * "Motion"). Pure — unit-tested. */
export function reuseRows(prev: readonly LayoutRow[], next: readonly LayoutRow[]): LayoutRow[] {
  return next.map((row, i) => {
    const before = prev[i]
    return before !== undefined && sameRow(before, row) ? before : row
  })
}

/** Per-message copy affordance (label row): `⧉ copy` appended after a
 * two-space gap. Copies the message's RAW content to the system clipboard via
 * OSC52 (the same channel as drag-select copy). */
export const COPY_AFFORDANCE = "⧉ copy"
export const COPY_AFFORDANCE_GAP = "  "

/** User-message rewind affordance (label row, after copy): `↺ revert`. Clicking
 * it rewinds the conversation to just before that message and reloads its text
 * into the input for editing (ChatSession.revertToUserMessage, docs/ui.md
 * "Rewind"). User messages only.
 *
 * Glyph rule: use TEXT-presentation symbols that a monospace font actually
 * covers. A glyph with the Unicode Emoji property (`↩` U+21A9, `⚠` U+26A0)
 * renders as a COLOR emoji, and an uncovered symbol glyph (`✕` U+2715) makes
 * terminals fall back to a symbol font that draws it large/double-width — both
 * break the monochrome chrome and the cell math. Covered + Emoji=false:
 * `⧉ ↺ × ❯ ✱` (`↺` U+21BA undo, `×` U+00D7 Latin-1 close). */
export const REVERT_AFFORDANCE = "↺ revert"

/** Max fraction of the content width a user bubble may occupy. */
export const USER_BUBBLE_MAX_RATIO = 0.8
/** Floor for a user bubble's text width so its label and BOTH label
 * affordances (`⧉ copy` then `↺ revert`) fit without clipping. 5 = "❯ you". */
export const USER_BUBBLE_MIN_TEXT =
  5 +
  [...(COPY_AFFORDANCE_GAP + COPY_AFFORDANCE)].length +
  [...(COPY_AFFORDANCE_GAP + REVERT_AFFORDANCE)].length
/** Horizontal card chrome: 1 border on each side (the inner horizontal
 * padding was removed — docs/DESIGN.md "Chat sidebar" — so content sits tight
 * against the card edge and closer to the terminal). */
export const CARD_CHROME = 2

/** Card text width for a role: assistant/tool/etc. use the full content width;
 * a user bubble is capped at `USER_BUBBLE_MAX_RATIO`. The caller shrink-wraps
 * user bubbles with `userBubbleTextWidth`. Pure. */
export function cardTextWidth(contentWidth: number, role: ChatMessage["role"]): number {
  const w = Math.max(4, Math.floor(contentWidth))
  if (role === "user") return Math.max(Math.min(USER_BUBBLE_MIN_TEXT, w), Math.floor(w * USER_BUBBLE_MAX_RATIO))
  return w
}

/** Total card width (text + border + padding). Pure. */
export function cardOuterWidth(textWidth: number): number {
  return Math.max(4, Math.floor(textWidth)) + CARD_CHROME
}

/** Shrink-wrap a user bubble: the widest source line, clamped to
 * `[USER_BUBBLE_MIN_TEXT, maxTextWidth]` (a line wider than the cap wraps).
 * Pure — unit-tested. */
export function userBubbleTextWidth(content: string, maxTextWidth: number): number {
  const max = Math.max(1, Math.floor(maxTextWidth))
  const floor = Math.min(USER_BUBBLE_MIN_TEXT, max)
  let longest = 1
  for (const line of (content === "" ? " " : content).split("\n")) {
    longest = Math.max(longest, [...line].length)
  }
  return Math.min(max, Math.max(floor, longest))
}


export interface CopyAffordance {
  /** Rendered text (gap included). */
  text: string
  /** Cell column where the affordance starts (click region). */
  start: number
  /** Cell width of the affordance (click region). */
  length: number
}

/** Geometry of the label-row copy affordance: null when there is no label or
 * the label + affordance do not fit the content width (narrow sidebars keep a
 * clean label row). Pure — unit-tested in chatCopyAffordance.test.ts. */
export function labelCopyAffordance(label: string, width: number): CopyAffordance | null {
  if (label.length === 0) return null
  const labelCells = [...label].length
  const text = COPY_AFFORDANCE_GAP + COPY_AFFORDANCE
  const length = [...text].length
  if (labelCells + length > Math.max(4, Math.floor(width))) return null
  return { text, start: labelCells, length }
}

/** Geometry of the label-row REVERT affordance (user messages): it follows the
 * copy affordance (`⧉ copy` then `  ↺ revert`). Null when copy is absent/does
 * not fit, or when the copy + revert pair does not fit the content width (the
 * row degrades to copy-only rather than clipping). Pure — unit-tested. */
export function labelRevertAffordance(label: string, width: number): CopyAffordance | null {
  const copy = labelCopyAffordance(label, width)
  if (copy === null) return null
  const start = copy.start + copy.length
  const text = COPY_AFFORDANCE_GAP + REVERT_AFFORDANCE
  const length = [...text].length
  if (start + length > Math.max(4, Math.floor(width))) return null
  return { text, start, length }
}

/** Assistant body segments (M9 phase 4): prose renders through the native
 * <markdown> renderable (proper wrapping + scope styles); fenced code stays
 * on our custom rows so the M3 per-line click-to-paste affordance survives. */
export type AssistantSegment =
  | { kind: "prose"; text: string }
  | { kind: "fence"; code: string; lang: string }

/** A segment plus its exact span in the SOURCE content (UTF-16 offsets), so
 * the stream reveal can pace the text INSIDE stable segment boundaries
 * (ui/chat/streamReveal.ts) — segment nodes then keep their identity and
 * update in place instead of remounting per flush. */
export interface AssistantSpan {
  seg: AssistantSegment
  start: number
  len: number
}

/** `segmentAssistant` with source offsets. Same state machine, one home. */
export function segmentAssistantSpans(content: string): AssistantSpan[] {
  const spans: AssistantSpan[] = []
  let prose: { lines: string[]; start: number } | null = null
  let fence: { lang: string; code: string[]; start: number } | null = null
  let offset = 0
  const flushProse = (end: number): void => {
    if (prose === null) return
    const text = prose.lines.join("\n")
    if (text.trim().length > 0) spans.push({ seg: { kind: "prose", text }, start: prose.start, len: end - prose.start })
    prose = null
  }
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const lineStart = offset
    offset += line.length + (i < lines.length - 1 ? 1 : 0)
    const m = /^\s*```(\S*)\s*$/.exec(line)
    if (m !== null && fence === null) {
      flushProse(lineStart)
      fence = { lang: m[1] ?? "", code: [], start: offset }
    } else if (fence !== null && m !== null) {
      spans.push({ seg: { kind: "fence", code: fence.code.join("\n"), lang: fence.lang }, start: fence.start, len: lineStart - fence.start })
      fence = null
    } else if (fence !== null) {
      fence.code.push(line)
    } else {
      if (prose === null) prose = { lines: [], start: lineStart }
      prose.lines.push(line)
    }
  }
  const end = Math.min(offset, content.length)
  flushProse(end)
  if (fence !== null) spans.push({ seg: { kind: "fence", code: fence.code.join("\n"), lang: fence.lang }, start: fence.start, len: end - fence.start })
  return spans
}

/** Split assistant content into prose / fenced-code segments (a fence that
 * never closes — mid-stream — still yields a code segment). */
export function segmentAssistant(content: string): AssistantSegment[] {
  return segmentAssistantSpans(content).map((s) => s.seg)
}

/** Verbatim content: split on \n FIRST so every source line wraps on its own
 * (a raw \n must never collapse into a space — it is a hard line break). */
function wrapPlain(content: string, style: SegStyle, w: number): MdLine[] {
  const src = content === "" ? " " : content
  const logical = src.split("\n").map((l) => textLine(l.length === 0 ? "" : l, style))
  return wrapLines(logical, w)
}

/** Full transcript layout: label row + blank spacer + body rows. */
export function layoutMessages(messages: readonly ChatMessage[], width: number): MdLine[] {
  const out: MdLine[] = []
  for (const msg of messages) {
    const { label, labelStyle, body } = layoutMessage(msg, width)
    if (label.length > 0) out.push(textLine(label, labelStyle))
    out.push(...body)
    out.push({ segs: [] }) // blank spacer between messages
  }
  return out
}

/** Convenience for tests: plain text of the whole layout. */
export function layoutText(messages: readonly ChatMessage[], width: number): string {
  return layoutMessages(messages, width)
    .map((l) => l.segs.map((s) => s.text).join(""))
    .join("\n")
}

function truncateToWidth(s: string, w: number): string {
  return truncateWithEllipsis(s, Math.max(4, w))
}

export { plain }
