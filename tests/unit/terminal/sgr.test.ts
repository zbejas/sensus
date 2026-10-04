import { describe, expect, test } from "bun:test"
import { buildPanePalette, SgrColorRewriter, type PanePalette } from "../../../src/terminal/sgr.ts"
import { KONSOLE_DEFAULT_PALETTE } from "../../../src/theme/themePalette.ts"

/** A 256-entry palette where index i = rgb(i, i, i), so assertions are simple. */
function rampPalette(): PanePalette {
  return Array.from({ length: 256 }, (_, i) => [i, i, i] as const)
}

function dec(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1")
}

function rewrite(input: string, palette: PanePalette | null, boldBright = true): string {
  const r = new SgrColorRewriter({ boldBright })
  r.setPalette(palette)
  return dec(r.transform(new TextEncoder().encode(input)))
}

describe("buildPanePalette", () => {
  test("parses hex entries and leaves unanswered ones null", () => {
    const p = buildPanePalette({ palette: ["#ff0000", null, "#00ff00"] })
    expect(p).not.toBeNull()
    expect(p?.[0]).toEqual([255, 0, 0])
    expect(p?.[1]).toBeNull()
    expect(p?.[2]).toEqual([0, 255, 0])
    expect(p?.[255]).toBeNull()
  })

  test("null when nothing was answered", () => {
    expect(buildPanePalette({ palette: [null, null] })).toBeNull()
    expect(buildPanePalette(null)).toBeNull()
  })

  test("a Konsole-lie detection is not repainted: basic 0-15 stay indices", () => {
    // Full 256-entry detection where 0-15 is Konsole's compiled-in table and
    // 16+ is answered: the lie row is dropped (VT palette), the cube is kept.
    const palette = [...KONSOLE_DEFAULT_PALETTE, ...Array.from({ length: 240 }, () => "#000000")]
    const p = buildPanePalette({ palette })
    expect(p).not.toBeNull()
    for (let i = 0; i < 16; i++) expect(p?.[i]).toBeNull()
    expect(p?.[16]).toEqual([0, 0, 0])
    // The rewriter leaves the lying basic color as an index (VT palette) but
    // still maps the 256-cube entry through the kept palette.
    expect(rewrite("\x1b[31mX\x1b[38;5;16mY", p)).toBe("\x1b[31mX\x1b[38;2;0;0;0mY")
    // Sparse: only the lie answered → null (the pane rewrite becomes a no-op).
    expect(buildPanePalette({ palette: [...KONSOLE_DEFAULT_PALETTE] })).toBeNull()
    // A truthful scheme still rewrites normally.
    expect(buildPanePalette({ palette: ["#000000", "#ff0000"] })?.[1]).toEqual([255, 0, 0])
  })
})

describe("SgrColorRewriter", () => {
  const pal = rampPalette()

  test("basic fg/bg map to palette truecolor", () => {
    expect(rewrite("\x1b[31mX", pal)).toBe("\x1b[38;2;1;1;1mX")
    expect(rewrite("\x1b[42mX", pal)).toBe("\x1b[48;2;2;2;2mX")
  })

  test("bright fg/bg use index + 8", () => {
    expect(rewrite("\x1b[91mX", pal)).toBe("\x1b[38;2;9;9;9mX")
    expect(rewrite("\x1b[104mX", pal)).toBe("\x1b[48;2;12;12;12mX")
  })

  test("256-color entries map through the palette", () => {
    expect(rewrite("\x1b[38;5;196mX", pal)).toBe("\x1b[38;2;196;196;196mX")
    expect(rewrite("\x1b[48;5;21mX", pal)).toBe("\x1b[48;2;21;21;21mX")
  })

  test("colon-form 256-color maps too", () => {
    expect(rewrite("\x1b[38:5:196mX", pal)).toBe("\x1b[38;2;196;196;196mX")
  })

  test("truecolor passes through unchanged", () => {
    expect(rewrite("\x1b[38;2;12;34;56mX", pal)).toBe("\x1b[38;2;12;34;56mX")
  })

  test("bold->bright for basic fg, suppressed by dim", () => {
    expect(rewrite("\x1b[1;31mX", pal)).toBe("\x1b[1;38;2;9;9;9mX")
    expect(rewrite("\x1b[2;31mX", pal)).toBe("\x1b[2;38;2;1;1;1mX")
    // bold then color in a later sequence still brightens (state tracked)
    expect(rewrite("\x1b[1m\x1b[31mX", pal)).toBe("\x1b[1m\x1b[38;2;9;9;9mX")
    // reset clears bold
    expect(rewrite("\x1b[1;31m\x1b[0m\x1b[31mX", pal)).toBe("\x1b[1;38;2;9;9;9m\x1b[0m\x1b[38;2;1;1;1mX")
  })

  test("non-color attributes and non-SGR escapes are untouched", () => {
    expect(rewrite("\x1b[4mX\x1b[0m", pal)).toBe("\x1b[4mX\x1b[0m")
    expect(rewrite("\x1b[2J\x1b[H", pal)).toBe("\x1b[2J\x1b[H")
    expect(rewrite("plain \x1b]0;title\x07text", pal)).toBe("plain \x1b]0;title\x07text")
  })

  test("no palette: verbatim (VT keeps its own palette)", () => {
    expect(rewrite("\x1b[31mX\x1b[0m", null)).toBe("\x1b[31mX\x1b[0m")
  })

  test("unanswered entry falls back to the original index", () => {
    const sparse = Array.from({ length: 256 }, () => null) as (readonly [number, number, number] | null)[]
    sparse[1] = [9, 8, 7]
    expect(rewrite("\x1b[31mX", sparse)).toBe("\x1b[38;2;9;8;7mX")
    expect(rewrite("\x1b[32mX", sparse)).toBe("\x1b[32mX")
  })

  test("a sequence split across chunks is rewired correctly", () => {
    const r = new SgrColorRewriter()
    r.setPalette(pal)
    const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
    const a = dec(r.transform(enc("\x1b[3")))
    const b = dec(r.transform(enc("8;5;196mX")))
    expect(a + b).toBe("\x1b[38;2;196;196;196mX")
  })

  test("boldBright can be disabled", () => {
    expect(rewrite("\x1b[1;31mX", pal, false)).toBe("\x1b[1;38;2;1;1;1mX")
  })

  test("malformed / truncated input never throws", () => {
    expect(() => rewrite("\x1b[", pal)).not.toThrow()
    expect(() => rewrite("\x1b", pal)).not.toThrow()
    // a trailing lone ESC is held as carry (stream not finished) — no throw
    expect(rewrite("hi\x1b", pal)).toBe("hi")
  })
})

describe("SgrColorRewriter fast path (no-escape chunks)", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

  test("a no-escape chunk is returned by reference once the prefix is out", () => {
    const r = new SgrColorRewriter()
    r.setDefaults([1, 2, 3], null)
    // First chunk consumes the one-time default-fg assertion (allocates).
    void r.transform(enc("hi"))
    const chunk = enc("plain text with no escapes at all")
    const out = r.transform(chunk)
    expect(out).toBe(chunk)
    expect(out).toEqual(chunk)
  })

  test("a palette alone (no defaults) returns a no-escape first chunk by reference", () => {
    const r = new SgrColorRewriter()
    r.setPalette(rampPalette())
    const chunk = enc("plain")
    expect(r.transform(chunk)).toBe(chunk)
  })

  test("a no-escape chunk does not disturb a later rewrite", () => {
    const r = new SgrColorRewriter()
    r.setPalette(rampPalette())
    r.setDefaults([250, 251, 252], null)
    void r.transform(enc("x"))
    const plain = enc("plain")
    expect(r.transform(plain)).toBe(plain)
    expect(dec(r.transform(enc("\x1b[31mY")))).toBe("\x1b[38;2;1;1;1mY")
    expect(dec(r.transform(enc("\x1b[39m")))).toBe("\x1b[38;2;250;251;252m")
  })

  test("escape chunks still rewrite identically with a seeded default", () => {
    const r = new SgrColorRewriter()
    r.setPalette(rampPalette())
    r.setDefaults([250, 251, 252], null)
    expect(dec(r.transform(enc("\x1b[31mX")))).toBe("\x1b[38;2;250;251;252m\x1b[38;2;1;1;1mX")
  })

  test("a corrupt huge parameter run is chunk-decoded and never throws", () => {
    const r = new SgrColorRewriter()
    r.setPalette(rampPalette())
    const huge = new Uint8Array(200_000)
    huge[0] = 0x1b
    huge[1] = 0x5b
    huge.fill(0x30, 2) // '0'
    huge[huge.length - 1] = 0x6d // 'm'
    expect(() => r.transform(huge)).not.toThrow()
  })
})

describe("SgrColorRewriter theme defaults", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

  test("the default FOREGROUND is re-applied on reset/39; the default background is left to the VT/painter", () => {
    const r = new SgrColorRewriter()
    r.setDefaults([250, 251, 252], [10, 11, 12])
    // first chunk: assert only the theme fg — no bg truecolor and no
    // background-color-erase (that erase corrupts the VT's resize reflow)
    expect(dec(r.transform(enc("hi")))).toBe("\x1b[38;2;250;251;252mhi")
    // reset re-applies the theme fg (the default bg is repainted by PanePainter)
    expect(dec(r.transform(enc("\x1b[31mX\x1b[0m")))).toContain("\x1b[0;38;2;250;251;252m")
    // 39 -> theme fg; 49 (default bg) passes through for the painter to theme
    expect(dec(r.transform(enc("\x1b[39m\x1b[49m")))).toBe("\x1b[38;2;250;251;252m\x1b[49m")
  })

  test("a default background with no fg leaves the stream otherwise untouched", () => {
    const r = new SgrColorRewriter()
    r.setDefaults(null, [7, 8, 9])
    expect(dec(r.transform(enc("\x1b[31m\x1b[0m")))).toBe("\x1b[31m\x1b[0m")
  })

  test("a default fg change is re-asserted on the next chunk", () => {
    const r = new SgrColorRewriter()
    r.setDefaults([1, 1, 1], null)
    void r.transform(enc("a"))
    r.setDefaults([2, 2, 2], null)
    expect(dec(r.transform(enc("b")))).toBe("\x1b[38;2;2;2;2mb")
  })
})
