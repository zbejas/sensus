/**
 * Re-export barrel — the shared animation tick moved to the headless engine
 * (`src/engine/spinner.ts`, docs/architecture.md "engine/") so `agent/chat`
 * can read the tick without importing the renderer. The UI import path is kept
 * for existing callers.
 */

export {
  spinnerChar,
  spinnerFrame,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  SPINNER_STATIC,
} from "../../engine/spinner.ts"
