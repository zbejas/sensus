/**
 * StatusBar: the bottom row — a left group of context facts (which tab, cwd,
 * terminal health) and a right group of agent facts (chat state, model+ctx,
 * thinking, agent, approval), separated by an elastic gap.
 *
 * Visual language (docs/DESIGN.md "Status bar"): each chip is a muted LABEL
 * next to a readable VALUE, so the row scans as structure rather than one grey
 * line. The clickable chips (model, context, think, agent, approval) light up on
 * hover and flash the accent block on press, the same feedback every clickable
 * row uses. Semantic tones carry meaning only: streaming accent, `full-auto`
 * warning, a dead shell danger.
 *
 * opentui spans cannot carry handlers, so the row is ONE <text> and the clicked
 * column maps back onto a chip (src/ui/lib/bar.ts). Toast notifications are NOT
 * here — they float top-right (ui/ToastPanel).
 */

import { type JSX } from "@opentui/solid"
import { For } from "solid-js"
import { formatTokens, trustChipLabel, formatContextLimit } from "../../engine/index.ts"
import { elapsedText } from "../chat/chatLayout.ts"
import { spinnerChar } from "../lib/spinner.ts"
import { bgProps, theme } from "../../theme/theme.ts"
import {
  barFlex,
  createBarRow,
  fitBarParts,
  joinBarParts,
  type BarFitRule,
  type BarPart,
  type BarSpan,
  type BarTone,
} from "../lib/bar.ts"
import { mcpChipPart } from "../lib/mcpChip.ts"
import { tabTitle } from "../lib/tabs.ts"
import type { TerminalState, UiStore } from "../lib/store.ts"

const TERMINAL_LABEL: Record<TerminalState, string> = {
  starting: "starting",
  ok: "ok",
  dead: "dead",
}

function fmtTokens(n: number): string {
  return formatTokens(n)
}

const SEP = " · "

/**
 * Overflow priority (docs/DESIGN.md "Status bar"): when the row cannot fit,
 * sacrifice in this order. `cwd` and the tab title are unbounded values, so
 * they shrink with an ellipsis first; the conditional `mcp`/`no-tools`
 * chips and the transient `chat` state drop next; then the left context group
 * yields to the right-hand agent affordances, and the informational `trust`
 * chip before the safety-relevant `jobs` count. The approval indicator (the one
 * fact that changes what a shell command does) is never dropped.
 */
const STATUS_FIT_PLAN: readonly BarFitRule[] = [
  { ids: ["cwd"], mode: "truncate", span: 2, min: 4 },
  { ids: ["mcp"], mode: "drop" },
  { ids: ["no-tools"], mode: "drop" },
  { ids: ["trust"], mode: "drop" },
  { ids: ["tab"], mode: "truncate", span: 2, min: 4 },
  { ids: ["model"], mode: "truncate", min: 4 },
  { ids: ["context"], mode: "truncate", min: 3 },
  { ids: ["chat"], mode: "drop" },
  { ids: ["terminal"], mode: "drop" },
  { ids: ["cwd"], mode: "drop" },
  { ids: ["tab"], mode: "drop" },
  { ids: ["jobs"], mode: "drop" },
  { ids: ["think"], mode: "drop" },
  { ids: ["context"], mode: "drop" },
  { ids: ["model"], mode: "drop" },
  { ids: ["agent"], mode: "drop" },
]

export function StatusBar(props: {
  store: UiStore
  /** Terminal width — the agent group is padded to the bar's right edge. */
  width: number
  /** Click on the agent chip (agent picker — Alt+M / /agent). */
  onOpenAgents?: () => void
  /** Click on the approval indicator (confirm / full-auto). */
  onToggleApproval?: () => void
  /** Click on the model indicator (endpoint@model). */
  onOpenModels?: () => void
  /** Click on the context indicator (used/limit) — the context inspector. */
  onOpenContext?: () => void
  /** Click on the thinking-mode chip (think:<mode>) — cycles choices. */
  onCycleThinking?: () => void
  /** Click on the `tab N/M: title` chip — cycle to the next tab (wraps). */
  onCycleTab?: () => void
  /** Click on the `mcp:` chip — open the MCP server manager. */
  onOpenMcp?: () => void
}): JSX.Element {
  const t = () => theme()
  const innerWidth = (): number => Math.max(props.width - 2, 0)

  const build = (): BarPart[] => {
    // A terminal-size warning (below the 20x5 minimum) is the one thing that
    // matters — the rest of the readout is unusable at that size. The elastic
    // pad still trails it so a shrinking row repaints every cell.
    const sizeWarn = props.store.sizeWarning()
    if (sizeWarn !== null) {
      return [{ id: "size-warn", spans: [{ text: sizeWarn, tone: "danger", bold: true }] }, barFlex()]
    }
    // Prefix window: first and visible (it only lasts ~1s). Not clickable.
    if (props.store.prefixPending()) {
      return [{ id: "prefix", spans: [{ text: "prefix…", tone: "warning", bold: true }] }, barFlex()]
    }

    const tabs = props.store.tabs()
    const activeId = props.store.activeTabId()
    const activeIdx = tabs.findIndex((tab) => tab.id === activeId)
    const tabCount = tabs.length
    const active = props.store.activeTab()
    const s = active?.status ?? null

    // ---- left group: where you are --------------------------------------
    const left: BarPart[] = []
    // The title is its own span so the overflow fitter can ellipsize it while
    // the `tab ` label and the `2/3:` index stay intact.
    const tabPrefix = tabCount === 0 ? "" : tabCount === 1 ? "1: " : `${activeIdx + 1}/${tabCount}: `
    const tabName = tabCount === 0 ? "none" : active ? tabTitle(active) : "zsh"
    const tabSpans: BarSpan[] = [{ text: "tab ", tone: "label" }]
    if (tabPrefix.length > 0) tabSpans.push({ text: tabPrefix, tone: "value" })
    tabSpans.push({ text: tabName, tone: "value" })
    // Clickable: cycles to the next tab (wraps), keyboard parity with Alt+Right.
    left.push({ id: "tab", spans: tabSpans, onClick: props.onCycleTab })
    left.push({
      id: "cwd",
      spans: [{ text: "cwd:", tone: "label" }, { text: " ", tone: "label" }, { text: s?.cwd ?? "~", tone: "value" }],
    })
    // Terminal-engine conditionals: only when they mean something.
    if (props.store.terminalState() !== "ok") {
      const st = props.store.terminalState()
      left.push({
        id: "terminal",
        spans: [
          { text: "terminal:", tone: "label" },
          { text: " ", tone: "label" },
          { text: TERMINAL_LABEL[st], tone: st === "dead" ? "danger" : "warning" },
        ],
      })
    }
    if (s?.dead) left.push({ id: "dead", spans: [{ text: `shell exited (${s.deadStatus ?? 0})`, tone: "danger" }] })

    // ---- right group: how the agent is set up ---------------------------
    const right: BarPart[] = []
    const chat = active?.chat
    if (chat) {
      const status = chat.accessors.status()
      // Compaction is shown even though its status may read "streaming"
      // (automatic preflight) or "idle" (manual /compact): it is a distinct
      // phase the user must be able to see (docs/agent.md "Streaming display").
      const compacting = chat.accessors.compacting()
      // Hidden while idle — "nothing happening" is the default, not a fact.
      if (status !== "idle" || compacting) {
        const since = chat.accessors.streamingSince()
        const live = status === "streaming" && !compacting
        const active = live || compacting
        const label = compacting ? "compacting" : status === "disabled" ? "no-key" : status
        const glyph = active ? ` ${spinnerChar(chat.accessors.animations())}` : ""
        const elapsed = active && since > 0 ? ` ${elapsedText(Date.now() - since)}` : ""
        const tone: BarTone = active ? "accent" : "warning"
        right.push({
          id: "chat",
          spans: [
            { text: "chat:", tone: "label" },
            { text: label, tone, bold: active },
            { text: `${glyph}${elapsed}`, tone: "accent" },
          ],
        })
      }
      // Catalog refreshes (picker enrichment / models.dev prefetch) re-render the
      // ctx limit; the SESSION resolves it so the display matches the compaction
      // trigger. Two clickable chips: the model name opens the model picker
      // (`/models`), the context figure opens the context inspector (`/ctx`).
      props.store.modelInfoVersion()
      const meta = chat.modelMeta()
      const limit = formatContextLimit(chat.contextLimit())
      const used = chat.accessors.contextUsed()
      right.push({
        id: "model",
        spans: [{ text: `${chat.endpointName()}@`, tone: "label" }, { text: chat.modelName(), tone: "value" }],
        onClick: props.onOpenModels,
      })
      if (limit !== null) {
        right.push({
          id: "context",
          spans: [{ text: `${used > 0 ? `${fmtTokens(used)}/` : ""}${limit}`, tone: "label" }],
          onClick: props.onOpenContext,
        })
      }
      // Thinking chip: only when it means something — the model advertises
      // thinking modes (choices to cycle) or a mode is actually set
      // (docs/agent.md "Thinking modes"). A reasoner with no advertised options
      // gets no chip: there is nothing to cycle and no invented "default".
      const effort = chat.effortSetting()
      const hasThinkingChoices = (meta?.reasoningOptions?.length ?? 0) > 0
      if (hasThinkingChoices || effort !== "default") {
        right.push({
          id: "think",
          spans: [{ text: "think:", tone: "label" }, { text: effort, tone: "value" }],
          onClick: props.onCycleThinking,
        })
      }
      // Clickable agent chip (keyboard: Alt+M or /agent); `✱` matches the chat
      // label glyph.
      right.push({
        id: "agent",
        spans: [{ text: "✱ ", tone: "accent" }, { text: `agent:${chat.agentName()}`, tone: "value" }],
        onClick: props.onOpenAgents,
      })
      // Approval indicator: `full-auto` is a caution (warning), `confirm` is the
      // quiet safe default. Clickable (keyboard: Alt+Y or /yolo).
      const full = chat.accessors.approval() === "full-auto"
      right.push({
        id: "approval",
        spans: [{ text: full ? "full-auto" : "confirm", tone: full ? "warning" : "value", bold: full }],
        onClick: props.onToggleApproval,
      })
      // Background jobs started by this session that are still live: a
      // persistent warning so a detached job can never outlive the turn
      // invisibly (docs/agent.md "Background-job visibility").
      const jobs = chat.activeJobCount()
      if (jobs > 0) {
        right.push({
          id: "jobs",
          spans: [{ text: "jobs:", tone: "label" }, { text: String(jobs), tone: "warning", bold: true }],
        })
      }
      // Session-scoped trust ("approve and don't ask again this session"): the
      // chip NAMES the trusted operation class(es) and a click revokes them all
      // (docs/agent.md "Approval modes"). A single pattern is named outright;
      // several collapse to `<first>, +N` to keep the row bounded.
      const trust = chat.trustPatterns()
      if (trust.length > 0) {
        right.push({
          id: "trust",
          spans: [{ text: "trust:", tone: "label" }, { text: trustChipLabel(trust), tone: "success" }],
          onClick: () => {
            const n = chat.revokeAllTrust()
            if (n > 0) props.store.showToast(`session trust cleared (${n} pattern${n === 1 ? "" : "s"})`, "info", 3000)
          },
        })
      }
      if (chat.accessors.noTools()) right.push({ id: "no-tools", spans: [{ text: "no-tools", tone: "warning" }] })
      // MCP: shown whenever servers are configured (including before the first
      // message) so the chip is clickable to open the MCP manager and toggle
      // servers off to save context. Reading the registry's version signal
      // (through ChatSession.mcpStatusFacts) keeps it live across
      // connect/fail/markDown//reload (docs/mcp.md "UI").
      const mcpChip = mcpChipPart(chat.accessors.mcpEnabled(), chat.mcpStatusFacts())
      if (mcpChip !== null) right.push({ ...mcpChip, onClick: props.onOpenMcp })
    }

    const composed = [...joinBarParts(left, SEP), barFlex(), ...joinBarParts(right, SEP)]
    return fitBarParts(composed, innerWidth(), STATUS_FIT_PLAN)
  }

  const row = createBarRow({ build, innerWidth })

  return (
    <box
      style={{
        height: 1,
        flexDirection: "row",
        ...bgProps(t().barBg),
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <text
        selectable={false}
        style={{ fg: t().barFg }}
        onMouseMove={row.onMouseMove}
        onMouseOut={row.onMouseOut}
        onMouseDown={row.onMouseDown}
      >
        <For each={row.spans()}>{(s) => <span style={s.style}>{s.text}</span>}</For>
      </text>
    </box>
  )
}
