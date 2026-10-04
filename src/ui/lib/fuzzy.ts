/**
 * Re-export barrel — fuzzy scoring moved to the headless engine
 * (`src/engine/fuzzy.ts`, docs/architecture.md "engine/") so `config/` can use
 * it without importing the renderer. The UI import path is kept for existing
 * callers.
 */

export { fuzzyScore, matchIndices, matchSegments, type MatchSegment } from "../../engine/fuzzy.ts"
