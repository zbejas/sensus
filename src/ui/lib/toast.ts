/**
 * Re-export barrel — toast levels/policy moved to the headless engine
 * (`src/engine/toast.ts`, docs/architecture.md "engine/") so the agent chat
 * seam can carry a `ToastLevel` without importing the renderer. The UI import
 * path is kept for existing callers.
 */

export {
  defaultTtl,
  shouldPreemptToast,
  toastGlyph,
  toastLines,
  toastPanelWidth,
  toastSeverity,
  toastToken,
  TOAST_CHROME_X,
  TOAST_GLYPH_COLS,
  TOAST_MARGIN_RIGHT,
  TOAST_MARGIN_TOP,
  TOAST_MAX_LINES,
  TOAST_MAX_WIDTH,
  TOAST_PAD_X,
  TOAST_PAD_Y,
  type Toast,
  type ToastLevel,
} from "../../engine/toast.ts"
