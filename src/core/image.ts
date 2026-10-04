/**
 * Image attachments (docs/agent.md "Images"). Pure helpers + guarded fs for
 * the one place sensus handles picture bytes:
 *
 * - an attachment is a FILE on disk (stored under the session's `assets/`
 *   directory) referenced by a small metadata record. The record — not the
 *   pixels — rides the JSONL transcript, so transcripts stay small and the
 *   provider request reads the bytes at assembly time (byte-identical across
 *   requests = prompt-cache friendly).
 * - media type + dimensions are sniffed from the bytes (magic numbers), never
 *   trusted from a filename.
 * - every fs helper never throws: failures come back as null / an error string.
 *
 * Keep this module free of agent/provider imports so store.ts, the provider
 * seam and the UI can all import it without cycles.
 */

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { errorMessage } from "./util.ts"

/** Image formats accepted for both clipboard paste and `view_image`. */
export const IMAGE_MEDIA_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif"]

/** Clipboard / file-size ceiling for one image (bytes). */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024
/** How many images one message may carry. */
export const MAX_ATTACHMENTS = 5
/** Rough token cost when dimensions are unknown (a mid-size photo). */
export const DEFAULT_IMAGE_TOKENS = 1100

/**
 * One stored image. `path` is absolute; `id` is the content hash (also the
 * asset basename), so re-attaching identical bytes dedupes to one file.
 */
export interface ImageAttachment {
  /** Content hash (sha1, 12 hex chars) — asset basename + dedupe key. */
  id: string
  /** Display name (original filename or "clipboard.png"). */
  name: string
  /** IANA media type, sniffed from the bytes. */
  mediaType: string
  /** Byte size of the stored asset. */
  bytes: number
  /** Absolute path of the stored asset. */
  path: string
  width?: number
  height?: number
}

/** Is this a media type sensus can send/see? */
export function isImageMediaType(mediaType: string): boolean {
  return IMAGE_MEDIA_TYPES.includes(mediaType.toLowerCase())
}

/** Lower-case media type without parameters ("image/png; charset=x" -> "image/png"). */
export function baseMediaType(mediaType: string): string {
  return (mediaType.split(";")[0] ?? "").trim().toLowerCase()
}

/** Extension for a stored asset ("image/png" -> "png"). */
export function imageExtension(mediaType: string): string {
  switch (baseMediaType(mediaType)) {
    case "image/jpeg":
      return "jpg"
    case "image/webp":
      return "webp"
    case "image/gif":
      return "gif"
    default:
      return "png"
  }
}

/** Guess a media type from a filename (fallback when magic sniffing fails). */
export function mediaTypeFromName(name: string): string | null {
  const ext = name.toLowerCase().split(".").pop() ?? ""
  switch (ext) {
    case "png":
      return "image/png"
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "webp":
      return "image/webp"
    case "gif":
      return "image/gif"
    default:
      return null
  }
}

/** Sniff the media type from magic bytes; null when it is not a known image. */
export function detectImageMediaType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp"
  }
  return null
}

function be16(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) * 256 + (b[o + 1] ?? 0)
}

function le16(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) + (b[o + 1] ?? 0) * 256
}

function be32(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) * 0x1000000 + ((b[o + 1] ?? 0) << 16) + ((b[o + 2] ?? 0) << 8) + (b[o + 3] ?? 0)) >>> 0
}

function le24(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) + ((b[o + 1] ?? 0) << 8) + ((b[o + 2] ?? 0) << 16)
}

/**
 * Pixel dimensions from the container header (best effort, never throws).
 * PNG / GIF / WebP / JPEG. Null when the format is unknown or truncated.
 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  try {
    const media = detectImageMediaType(bytes)
    if (media === "image/png") {
      if (bytes.length < 24) return null
      const width = be32(bytes, 16)
      const height = be32(bytes, 20)
      return width > 0 && height > 0 ? { width, height } : null
    }
    if (media === "image/gif") {
      if (bytes.length < 10) return null
      const width = le16(bytes, 6)
      const height = le16(bytes, 8)
      return width > 0 && height > 0 ? { width, height } : null
    }
    if (media === "image/webp") {
      const fourCC = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0)
      if (fourCC === "VP8X" && bytes.length >= 30) {
        return { width: le24(bytes, 24) + 1, height: le24(bytes, 27) + 1 }
      }
      if (fourCC === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
        // 14 bits width-1 then 14 bits height-1, little-endian bit stream.
        const bits = (bytes[21] ?? 0) | ((bytes[22] ?? 0) << 8) | ((bytes[23] ?? 0) << 16) | ((bytes[24] ?? 0) << 24)
        const width = (bits & 0x3fff) + 1
        const height = ((bits >> 14) & 0x3fff) + 1
        return width > 0 && height > 0 ? { width, height } : null
      }
      if (fourCC === "VP8 " && bytes.length >= 30) {
        const width = le16(bytes, 26) & 0x3fff
        const height = le16(bytes, 28) & 0x3fff
        return width > 0 && height > 0 ? { width, height } : null
      }
      return null
    }
    if (media === "image/jpeg") {
      // Walk the marker segments to a Start-Of-Frame (SOF0..SOF15 except DHT/DAC/RST).
      let o = 2
      while (o + 9 < bytes.length) {
        if (bytes[o] !== 0xff) {
          o++
          continue
        }
        const marker = bytes[o + 1] ?? 0
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
          o += 2
          continue
        }
        const len = be16(bytes, o + 2)
        if (len < 2) return null
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
        if (isSof) {
          const height = be16(bytes, o + 5)
          const width = be16(bytes, o + 7)
          return width > 0 && height > 0 ? { width, height } : null
        }
        o += 2 + len
      }
      return null
    }
    return null
  } catch {
    return null
  }
}

/** Stable content id (assets dedupe on identical bytes). */
export function imageContentId(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex").slice(0, 12)
}

/** "312 KB" / "1.4 MB" / "812 B". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B"
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${Math.round(n)} B`
}

/** Rough vision cost of one image (~1 token / 750 px, clamped). */
export function estimateImageTokens(att: ImageAttachment): number {
  if (att.width === undefined || att.height === undefined || att.width <= 0 || att.height <= 0) return DEFAULT_IMAGE_TOKENS
  const area = att.width * att.height
  return Math.max(256, Math.min(4000, Math.ceil(area / 750)))
}

/** One-line chip label: "screenshot.png · 1200×800 · 312 KB". */
export function attachmentLabel(att: ImageAttachment): string {
  const dims = att.width !== undefined && att.height !== undefined ? ` · ${att.width}×${att.height}` : ""
  return `${att.name}${dims} · ${formatBytes(att.bytes)}`
}

/** Build an attachment from raw bytes WITHOUT writing to disk (clipboard). */
export function attachmentFromBytes(
  bytes: Uint8Array,
  name: string,
  mediaTypeHint?: string,
): { ok: true; attachment: Omit<ImageAttachment, "path"> } | { ok: false; error: string } {
  if (bytes.length === 0) return { ok: false, error: "empty image data" }
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, error: `image too large (${formatBytes(bytes.length)} > ${formatBytes(MAX_IMAGE_BYTES)})` }
  const mediaType = detectImageMediaType(bytes) ?? (mediaTypeHint !== undefined ? baseMediaType(mediaTypeHint) : null)
  if (mediaType === null || !isImageMediaType(mediaType)) {
    return { ok: false, error: "unsupported image format (png, jpeg, webp, gif)" }
  }
  const dims = imageDimensions(bytes)
  return {
    ok: true,
    attachment: {
      id: imageContentId(bytes),
      name,
      mediaType,
      bytes: bytes.length,
      ...(dims !== null ? { width: dims.width, height: dims.height } : {}),
    },
  }
}

/**
 * Persist image bytes under `dir` (the session's `assets/`) and return the
 * full attachment. Never throws; an error string surfaces to the UI as a toast.
 */
export function storeImageBytes(
  dir: string,
  bytes: Uint8Array,
  name: string,
  mediaTypeHint?: string,
): { ok: true; attachment: ImageAttachment } | { ok: false; error: string } {
  const built = attachmentFromBytes(bytes, name, mediaTypeHint)
  if (!built.ok) return built
  const path = join(dir, `${built.attachment.id}.${imageExtension(built.attachment.mediaType)}`)
  try {
    mkdirSync(dir, { recursive: true })
    // Same bytes => same id => same path; rewrite is harmless and idempotent.
    writeFileSync(path, bytes)
  } catch (e) {
    return { ok: false, error: `could not store image: ${errorMessage(e)}` }
  }
  return { ok: true, attachment: { ...built.attachment, path } }
}

/**
 * Read an image FILE into an attachment (used by `view_image` and the resume
 * path). Returns null when the file is missing, too large, or not an image.
 */
export function readImageAttachment(path: string, name?: string, mediaTypeHint?: string): ImageAttachment | null {
  try {
    // Size-gate BEFORE reading: a pasted arbitrary file path must never pull a
    // multi-GB file into memory just to discover it is not an image.
    const stat = statSync(path)
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) return null
    const bytes = readFileSync(path)
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null
    const mediaType = detectImageMediaType(bytes) ?? (mediaTypeHint !== undefined ? baseMediaType(mediaTypeHint) : null)
    if (mediaType === null || !isImageMediaType(mediaType)) return null
    const dims = imageDimensions(bytes)
    return {
      id: imageContentId(bytes),
      name: name ?? path.split("/").pop() ?? "image",
      mediaType,
      bytes: bytes.length,
      path,
      ...(dims !== null ? { width: dims.width, height: dims.height } : {}),
    }
  } catch {
    return null
  }
}

/** Read image bytes for a provider request. Null when unreadable. */
export function readImageBytes(path: string): Uint8Array | null {
  try {
    const bytes = readFileSync(path)
    return bytes.length > 0 ? bytes : null
  } catch {
    return null
  }
}

/** Validate attachment metadata from persisted JSON (drop anything malformed). */
export function parseImageAttachments(raw: unknown): ImageAttachment[] {
  if (!Array.isArray(raw)) return []
  const out: ImageAttachment[] = []
  for (const entry of raw) {
    if (out.length >= MAX_ATTACHMENTS) break
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue
    const e = entry as Record<string, unknown>
    const id = typeof e["id"] === "string" ? e["id"] : ""
    const name = typeof e["name"] === "string" ? e["name"] : ""
    const mediaType = typeof e["mediaType"] === "string" ? baseMediaType(e["mediaType"]) : ""
    const path = typeof e["path"] === "string" ? e["path"] : ""
    const bytes = typeof e["bytes"] === "number" && Number.isFinite(e["bytes"]) && e["bytes"] >= 0 ? e["bytes"] : 0
    if (id.length === 0 || path.length === 0 || !isImageMediaType(mediaType)) continue
    const width = typeof e["width"] === "number" && Number.isFinite(e["width"]) && e["width"] > 0 ? e["width"] : undefined
    const height = typeof e["height"] === "number" && Number.isFinite(e["height"]) && e["height"] > 0 ? e["height"] : undefined
    out.push({ id, name: name.length > 0 ? name : "image", mediaType, path, bytes, ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) })
  }
  return out
}
