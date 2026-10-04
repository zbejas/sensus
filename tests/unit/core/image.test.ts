/**
 * Image attachment primitives (docs/agent.md "Images"): magic-byte sniffing,
 * dimension parsing, asset round-trip, defensive JSONL parsing and the rough
 * token estimate. Pure/fs-only — no provider or tmux.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  attachmentFromBytes,
  attachmentLabel,
  baseMediaType,
  detectImageMediaType,
  estimateImageTokens,
  formatBytes,
  imageContentId,
  imageDimensions,
  imageExtension,
  parseImageAttachments,
  readImageAttachment,
  storeImageBytes,
} from "../../../src/core/image.ts"

/** A real 1x1 PNG. */
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

/** GIF89a, logical screen 2x3. */
const GIF_2x3 = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x02, 0x00, 0x03, 0x00, 0x00, 0x00])

/** Extended WebP (VP8X): canvas 4x3. */
const WEBP_4x3 = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x03, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00,
])

/** JPEG: SOI + SOF0 with height 2, width 3 (plus padding). */
const JPEG_3x2 = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x01, 0x01, 0x00,
])

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sensus-image-"))
})
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

describe("image sniffing + dimensions", () => {
  test("magic bytes identify png/jpeg/gif/webp and reject everything else", () => {
    expect(detectImageMediaType(PNG_1x1)).toBe("image/png")
    expect(detectImageMediaType(JPEG_3x2)).toBe("image/jpeg")
    expect(detectImageMediaType(GIF_2x3)).toBe("image/gif")
    expect(detectImageMediaType(WEBP_4x3)).toBe("image/webp")
    expect(detectImageMediaType(new TextEncoder().encode("not an image"))).toBeNull()
  })

  test("dimensions come from each container header", () => {
    expect(imageDimensions(PNG_1x1)).toEqual({ width: 1, height: 1 })
    expect(imageDimensions(GIF_2x3)).toEqual({ width: 2, height: 3 })
    expect(imageDimensions(WEBP_4x3)).toEqual({ width: 4, height: 3 })
    expect(imageDimensions(JPEG_3x2)).toEqual({ width: 3, height: 2 })
    expect(imageDimensions(new Uint8Array([1, 2, 3]))).toBeNull()
  })

  test("media-type helpers: base type, extension, human bytes, token estimate", () => {
    expect(baseMediaType("image/png; charset=binary")).toBe("image/png")
    expect(imageExtension("image/jpeg")).toBe("jpg")
    expect(imageExtension("image/png")).toBe("png")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(2048)).toBe("2 KB")
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB")
    // 750 px/token, clamped; unknown dims use the flat estimate.
    expect(estimateImageTokens({ id: "x", name: "a", mediaType: "image/png", bytes: 1, path: "/a", width: 1200, height: 800 })).toBe(1280)
    expect(estimateImageTokens({ id: "x", name: "a", mediaType: "image/png", bytes: 1, path: "/a" })).toBe(1100)
    expect(attachmentLabel({ id: "x", name: "shot.png", mediaType: "image/png", bytes: 2048, path: "/a", width: 10, height: 20 })).toBe("shot.png · 10×20 · 2 KB")
  })
})

describe("asset round-trip", () => {
  test("storeImageBytes writes a content-addressed file; readImageAttachment reads it back", () => {
    const stored = storeImageBytes(dir, PNG_1x1, "shot.png", "image/png")
    expect(stored.ok).toBe(true)
    if (!stored.ok) return
    expect(stored.attachment.mediaType).toBe("image/png")
    expect(stored.attachment.width).toBe(1)
    expect(stored.attachment.path.endsWith(`${stored.attachment.id}.png`)).toBe(true)
    const read = readImageAttachment(stored.attachment.path)
    expect(read?.id).toBe(stored.attachment.id)
    expect(read?.bytes).toBe(PNG_1x1.length)
    // Idempotent: same bytes, same id/path.
    const again = storeImageBytes(dir, PNG_1x1, "other-name.png", "image/png")
    expect(again.ok && again.attachment.path === stored.attachment.path).toBe(true)
    expect(imageContentId(PNG_1x1)).toBe(stored.attachment.id)
  })

  test("attachmentFromBytes rejects empty and non-image bytes; readImageAttachment returns null off image", () => {
    expect(attachmentFromBytes(new Uint8Array(), "x.png").ok).toBe(false)
    expect(attachmentFromBytes(new TextEncoder().encode("plain"), "x.png").ok).toBe(false)
    expect(readImageAttachment(join(dir, "missing.png"))).toBeNull()
  })
})

describe("parseImageAttachments (JSONL defensiveness)", () => {
  test("keeps well-formed image records, drops junk and non-images, caps the count", () => {
    const good = { id: "abc123", name: "a.png", mediaType: "image/png", bytes: 10, path: "/tmp/a.png", width: 2, height: 3 }
    expect(parseImageAttachments([good])).toEqual([good])
    expect(parseImageAttachments("nope")).toEqual([])
    expect(parseImageAttachments([null, 5, { id: "x" }, { ...good, mediaType: "text/plain" }, { ...good, path: "" }])).toEqual([])
    const many = Array.from({ length: 9 }, (_, i) => ({ ...good, id: `id${i}` }))
    expect(parseImageAttachments(many).length).toBe(5)
  })
})
