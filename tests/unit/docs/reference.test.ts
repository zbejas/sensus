/**
 * The committed reference JSON under site/src/data/generated/ is generated
 * from the root sources by scripts/gen-docs-reference.ts. Regenerating from
 * the builders must reproduce the committed files byte for byte, so stale
 * data fails the normal `bun run test:unit` loop.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  buildCommandsReference,
  buildKeymapReference,
  buildToolsReference,
  renderJson,
} from "../../../scripts/gen-docs-reference.ts"
import { GENERATED_DIR } from "./helpers"

const FILES: ReadonlyArray<readonly [string, string]> = [
  ["keymap.json", renderJson(buildKeymapReference())],
  ["commands.json", renderJson(buildCommandsReference())],
  ["tools.json", renderJson(buildToolsReference())],
]

describe("docs generated reference", () => {
  test("committed JSON matches the root sources", () => {
    for (const [file, expected] of FILES) {
      const committed = readFileSync(join(GENERATED_DIR, file), "utf8")
      expect(committed, `${file} is stale — run: bun run scripts/gen-docs-reference.ts`).toBe(
        expected,
      )
    }
  })
})
