import { section } from "../section.ts"

/**
 * Approval economics (docs/agent-approvals.md): in confirm mode every gated
 * call is a card the user must answer, so the cost of a turn is measured in
 * clicks as well as tokens. Sensus already collapses a batch into ONE plan
 * card; this section tells the model that batching is the expected shape of
 * work, which is the one lever no other agent has.
 *
 * Mode-agnostic on purpose: the live approval mode is volatile and rides the
 * terminal context block, never this byte-stable prompt.
 */
export const approvalsSection = section("approvals", 550, ({ has }) => {
  if (!has("shell_background") && !has("edit_file") && !has("write_file") && !has("shell_session")) return ""
  // A read-only agent still pays cards (reads are gated too), but it never
  // "announces a change" — those two lines are for agents that can mutate.
  const mutating = has("edit_file") || has("write_file") || has("shell_session")
  const lines = [
    "Working with approvals:",
    "- In confirm mode every gated call is a card the user answers — reads included. A turn costs their attention as well as tokens.",
    "- Batch INDEPENDENT calls into one turn: one plan card for N calls beats N cards for the same work. Never batch a call whose arguments depend on another call's output.",
    "- Do not spend a card re-reading what you already have or probing the same state twice.",
  ]
  if (mutating) {
    lines.push(
      "- Say what you are about to do in one line, then do it. The card is the gate — the user sees the change before it happens.",
      "- Destructive commands (rm -rf /-class) need the user's explicit text approval even in full-auto mode.",
    )
  }
  return lines.join("\n")
})
