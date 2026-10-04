/**
 * Re-export barrel — the implementation moved to the headless engine
 * (`src/engine/chat/inputEditor.ts`, docs/architecture.md "engine/") so
 * `agent/`/`config/` can use it without importing the renderer. The UI import
 * path is kept for existing callers.
 */

export { InputEditor, visualToCursor, wrapEditorLine, cps, type EditorRow } from "../../engine/chat/inputEditor.ts"
