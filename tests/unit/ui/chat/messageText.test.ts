import { describe, expect, test } from "bun:test"
import { mdText } from "../../../../src/agent/markdown.ts"
import { fenceRows, imageChipText } from "../../../../src/ui/chat/messageText.ts"
import type { ImageAttachment } from "../../../../src/core/image.ts"

const img = (name: string, bytes: number, id = name): ImageAttachment => ({
  id,
  name,
  mediaType: "image/png",
  bytes,
  path: `/tmp/${name}`,
})

describe("imageChipText", () => {
  test("renders `▣ name · size` chips joined by two spaces", () => {
    expect(imageChipText([img("cat.png", 812)], 40)).toBe("▣ cat.png · 812 B")
    expect(imageChipText([img("cat.png", 812), img("dog.png", 2048)], 60)).toBe(
      "▣ cat.png · 812 B  ▣ dog.png · 2 KB",
    )
  })

  test("truncates to width-1 code points with an ellipsis", () => {
    const out = imageChipText([img("screenshot-of-a-very-long-name.png", 123456)], 12)
    expect([...out].length).toBeLessThanOrEqual(12)
    expect(out.endsWith("…")).toBe(true)
  })

  test("a zero width still yields a bounded one-glyph string", () => {
    expect(imageChipText([img("cat.png", 1)], 0)).toBe("…")
  })
})

describe("fenceRows", () => {
  test("re-renders a fence through the markdown pipeline with per-line paste payloads", () => {
    const code = "const x = 1\nconsole.log(x)"
    const rows = fenceRows({ kind: "fence", lang: "ts", code }, 60)
    const text = mdText(rows)
    // The language label row is rendered (wrapped rows trim trailing spaces).
    expect(text.split("\n")[0]).toBe(" ts")
    expect(text).toContain("const x = 1")
    expect(text).toContain("console.log(x)")
    expect(text).toContain("click to paste · double-click to run")
    // Each clickable row points at its OWN line, never the whole block.
    const lines = rows.map((r) => r.copyLine).filter((c): c is string => c !== undefined)
    expect(lines).toEqual(["const x = 1", "console.log(x)"])
  })

  test("wrapping splits long code rows without dropping characters", () => {
    const code = "abcdefghijklmnopqrstuvwxyz"
    const rows = fenceRows({ kind: "fence", lang: "text", code }, 10)
    // Structure: [language label] [wrapped code rows] [wrapped hint rows];
    // the hint starts with "↳". Reassembling the code rows must not drop
    // characters.
    const hintAt = rows.findIndex((r) => mdText([r]).includes("↳"))
    const joined = rows
      .slice(1, hintAt)
      .map((r) => r.segs.map((s) => s.text).join(""))
      .join("")
    expect(joined).toBe(code)
  })
})
