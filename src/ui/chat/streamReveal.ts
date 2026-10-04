/**
 * Re-export barrel — the implementation moved to the headless engine
 * (`src/engine/chat/streamReveal.ts`, docs/architecture.md "engine/") so
 * `agent/` can use it without importing the renderer. The UI import path is
 * kept for existing callers.
 */

export {
  advanceReveal,
  clampRevealCut,
  revealCut,
  StreamReveal,
  REVEAL_CATCHUP,
  REVEAL_LINGER_MS,
  REVEAL_MAX_ELAPSED_MS,
  REVEAL_MAX_STEP,
  REVEAL_MIN_STEP,
  REVEAL_SETTLED_MIN_STEP,
  REVEAL_TICK_MS,
  type RevealAdvanceOptions,
  type RevealState,
  type RevealTickReader,
} from "../../engine/chat/streamReveal.ts"
