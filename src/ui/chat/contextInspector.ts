/**
 * Re-export barrel — the pure helpers + snapshot shapes moved to the headless
 * engine (`src/engine/chat/contextInspector.ts`, docs/architecture.md
 * "engine/") so `agent/` can build the breakdown without importing the
 * renderer. The UI import path is kept for existing callers.
 */

export {
  breakdownRows,
  emptyContextBreakdown,
  firstLine,
  formatContextBreakdown,
  formatHistoryRow,
  historyPreview,
  historyRoleTag,
  historyWindow,
  messagePreview,
  toolCallSummary,
  usageBar,
  type ContextBreakdown,
  type ContextHistoryEntry,
  type ContextHistoryWindow,
  type ContextRow,
  type ContextUsageBar,
} from "../../engine/chat/contextInspector.ts"
