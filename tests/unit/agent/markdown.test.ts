import { describe, expect, test } from "bun:test"
import {
  mdText,
  renderMarkdown,
  parseInline,
  wrapLines,
  wrapTextToWidth,
  linkifyLine,
  linkifyLines,
  EMPTY_LINE,
} from "../../../src/agent/markdown.ts"

const txt = (s: string): string[] => s.split("\n")
const textOf = (src: string): string => mdText(renderMarkdown(src))

describe("renderMarkdown — subset", () => {
  test("block structure: headings, lists, blockquotes, fenced code (label, copy hint, copy blocks)", () => {
    // Headings keep their text and get heading style.
    const heads = renderMarkdown("## Section\n# Top")
    expect(heads.map((l) => l.segs.map((s) => s.text).join(""))).toEqual(["▌ Section", "█ Top"])
    expect(heads[0]?.segs.some((s) => s.style.heading)).toBe(true)
    // Lists: bullet + ordered markers.
    const listText = txt(textOf("- one\n- two\n3. three"))
    expect(listText[0]).toContain("• one")
    expect(listText[1]).toContain("• two")
    expect(listText[2]).toContain("3. three")
    // Blockquote gets a dim bar prefix.
    const quote = renderMarkdown("> note text")
    expect(quote[0]?.segs[0]?.text).toBe("│ ")
    expect(mdText(quote)).toContain("note text")
    // Fenced code: language label, code line, paste hint; every code row
    // carries ITS OWN line for the click-to-paste action (M3), and the hint
    // row is not clickable.
    const src = "```ts\nconst x = 1\n```"
    const codeText = txt(textOf(src)).join("\n")
    expect(codeText).toContain("ts")
    expect(codeText).toContain("const x = 1")
    expect(codeText).toContain("click to paste · double-click to run")
    const withCopy = renderMarkdown(src).filter((l) => l.segs.some((s) => s.style.code))
    expect(withCopy.length).toBeGreaterThan(0)
    for (const l of withCopy) expect(l.copyLine).toBe("const x = 1")
    // A multi-command block never carries the whole block on one row: each row
    // pastes only its own command (the whole-block autorun bug this guards).
    const multi = renderMarkdown("```\none\ntwo\nthree\n```")
      .map((l) => l.copyLine)
      .filter((c): c is string => c !== undefined)
    expect(multi).toEqual(["one", "two", "three"])
    const hint = renderMarkdown(src).find((l) => mdText([l]).includes("click to paste"))
    expect(hint?.copyLine).toBeUndefined()
    // CRLF content never leaves a trailing CR in the click payload (a bare CR
    // would press Enter by itself).
    const cr = renderMarkdown("```\r\nls\r\n```")
    expect(cr.filter((l) => l.copyLine !== undefined).map((l) => l.copyLine)).toEqual(["ls"])
    // An unclosed fence is flushed defensively at EOF.
    expect(textOf("```js\nno closing")).toContain("no closing")
  })

  test("inline formatting: code, bold, italic, links render as text; escapes are literal; unterminated stays literal", () => {
    const text = textOf("run `ls -la` and **carefully** *maybe* [docs](https://x.dev).")
    expect(text).toContain("ls -la")
    expect(text).toContain("carefully")
    expect(text).toContain("maybe")
    expect(text).toContain("docs (https://x.dev)")
    // Inline escapes and unterminated emphasis stay literal.
    expect(textOf("a \\* b")).toBe("a * b")
    expect(textOf("**oops")).toContain("**oops")
    // Plain text passes through unchanged.
    expect(txt(textOf("hello world"))).toEqual(["hello world"])
  })

  test("defensive: empty and non-string input never crash (renderMarkdown + parseInline)", () => {
    expect(renderMarkdown("").length).toBe(1)
    expect(renderMarkdown("\n\n")).toBeInstanceOf(Array)
    expect(renderMarkdown(null)).toEqual([])
    expect(renderMarkdown(42)).toEqual([])
    expect(parseInline("").length).toBe(0)
    expect(parseInline("```").length).toBe(1)
    expect(parseInline("[unclosed").length).toBeGreaterThan(0)
  })
})

describe("wrapping", () => {
  test("wrapTextToWidth: greedy word wrap, hard-split long words, width 1, indent on the first row only", () => {
    const rows = wrapTextToWidth("one two three four", 10)
    expect(rows.every((r) => [...r].length <= 10)).toBe(true)
    expect(rows[0]).toBe("one two")
    expect(rows[1]).toBe("three four")
    // Long words are hard-split without losing characters.
    const split = wrapTextToWidth("supercalifragilistic", 6)
    expect(split.join("")).toBe("supercalifragilistic")
    expect(split[0]).toBe("superc")
    // Width 1 produces one column per char.
    expect(wrapTextToWidth("ab", 1)).toEqual(["a", "b"])
    // Leading indent is marked on the first row only; continuations drop it.
    const indented = wrapTextToWidth("    indented text that wraps past width", 14)
    expect(indented[0]?.startsWith("    ")).toBe(true)
    expect(indented[1]?.startsWith("    ")).toBe(false)
  })

  test("wrapLines preserves structure: blank logical lines survive and styles stay bound across wrapped rows", () => {
    const out = wrapLines([EMPTY_LINE, { segs: [{ text: "x", style: {} }] }], 10)
    expect(out.length).toBe(2)
    expect(out[0]?.segs.length ?? 0).toBe(0)
    // "bold text" wraps to two rows — both stay bold, segments aren't per-char.
    const wrapped = wrapLines(renderMarkdown("**bold text** here"), 8)
    const boldTexts = wrapped.flatMap((l) => l.segs.filter((s) => s.style.bold).map((s) => s.text))
    expect(boldTexts.join(" ")).toBe("bold text")
    expect(wrapped.every((l) => l.segs.every((s) => s.text.length === 1))).toBe(false)
  })
})

describe("link-aware inline pass (ask_user questions)", () => {
  test("parseInline links carry an href for the OSC-8 renderer", () => {
    const segs = parseInline("see [docs](https://x.dev) now")
    const link = segs.find((s) => s.style.link)
    expect(link?.text).toBe("docs")
    expect(link?.style.href).toBe("https://x.dev")
  })

  test("linkifyLine: markdown links and bare URLs become href segs; everything else stays verbatim", () => {
    const md = linkifyLine("deploy to [staging](https://s.example) first")
    expect(md.find((s) => s.text === "staging")?.style.href).toBe("https://s.example")
    expect(md.map((s) => s.text).join("")).toBe("deploy to staging (https://s.example) first")

    const bare = linkifyLine("open https://example.com/a?b=1 now")
    expect(bare.find((s) => s.text === "https://example.com/a?b=1")?.style.href).toBe("https://example.com/a?b=1")

    // Sentence punctuation is not part of the URL.
    const punct = linkifyLine("see https://example.com/x.")
    expect(punct.find((s) => s.style.href !== undefined)?.style.href).toBe("https://example.com/x")
    expect(punct.some((s) => s.text === ".")).toBe(true)

    // A shell glob is NOT markdown emphasis — the whole line stays one seg.
    const glob = linkifyLine("delete *.log and *.tmp?")
    expect(glob).toEqual([{ text: "delete *.log and *.tmp?", style: {} }])
  })

  test("linkifyLines splits on raw newlines and never throws on odd input", () => {
    const rows = linkifyLines("first\n\n[go](https://x.dev)")
    expect(rows.length).toBe(3)
    expect(rows[0]?.segs.map((s) => s.text).join("")).toBe("first")
    expect(rows[1]?.segs.length).toBe(0)
    expect(rows[2]?.segs.find((s) => s.style.href !== undefined)?.style.href).toBe("https://x.dev")
    expect(() => linkifyLine("")).not.toThrow()
  })
})
