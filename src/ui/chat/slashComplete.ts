/**
 * Re-export barrel — the implementation moved to the headless engine
 * (`src/engine/chat/slashComplete.ts`, docs/architecture.md "engine/") so
 * `agent/` can use it without importing the renderer. The UI import path is
 * kept for existing callers.
 */

export {
  acceptCompletion,
  isExactCommandQuery,
  menuWindow,
  slashMenuForLine,
  type SlashMenuState,
} from "../../engine/chat/slashComplete.ts"
