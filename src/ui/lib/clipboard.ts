/**
 * Host-clipboard read for paste (docs/keybindings.md, docs/agent.md "Images").
 * Terminal bracketed paste only carries TEXT, so a copied picture — or a file
 * copied in a file manager (a `text/uri-list` / gnome-copied-files list) —
 * never reaches `usePaste`. The paste hotkeys (Ctrl+Shift+V / Alt+V)
 * read the system clipboard directly through opentui's native clipboard
 * service and adapt to whatever it holds: image bytes, a copied-file list, or
 * plain text. Everything degrades to a reason string; a missing system
 * clipboard tool (wl-clipboard/xclip) is not an error worth crashing on.
 */

import { createHostClipboard, type HostClipboardService } from "@opentui/core"
import { baseMediaType } from "../../core/image.ts"
import { errorMessage } from "../../core/util.ts"

/** Preference order: an image wins, then a copied-file list, then plain text. */
const PREFERRED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/uri-list",
  "x-special/gnome-copied-files",
  "text/plain",
] as const

/** What the clipboard held, once read and classified. */
export type ClipboardReadResult =
  | { ok: true; kind: "image"; mimeType: string; bytes: Uint8Array }
  | { ok: true; kind: "files"; paths: string[] }
  | { ok: true; kind: "text"; text: string }
  | { ok: false; reason: string }

let service: HostClipboardService | null = null

function host(): HostClipboardService {
  service ??= createHostClipboard()
  return service
}

/** Friendly text for a non-read clipboard status. */
export function clipboardStatusMessage(status: string): string {
  switch (status) {
    case "empty":
      return "clipboard is empty — copy an image, file, or text first"
    case "unsupported":
      return "paste unavailable here (no system clipboard tool: wl-clipboard/xclip)"
    case "timed-out":
      return "clipboard read timed out — try again"
    case "limit-exceeded":
      return "clipboard content is too large"
    case "cancelled":
      return "clipboard read cancelled"
    default:
      return "could not read the clipboard"
  }
}

/** Is this MIME a file-URL list (the clipboard shape a copied file produces)? */
export function isFileListMime(mimeType: string): boolean {
  const mt = baseMediaType(mimeType)
  return mt === "text/uri-list" || mt === "x-special/gnome-copied-files"
}

/**
 * Parse a `text/uri-list` (RFC 2483) / gnome-copied-files body into local file
 * paths. `#` comment lines and non-`file:` URIs are skipped; percent-encoding is
 * decoded; a `file://host/path` authority is dropped. Pure and never throws.
 */
export function parseFileUriList(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith("#")) continue
    if (!line.toLowerCase().startsWith("file://")) continue
    const rest = line.slice("file://".length)
    // file:///abs => "/abs" (empty authority); file://host/abs => drop "host".
    const slash = rest.indexOf("/")
    if (slash < 0) continue
    const encoded = rest.slice(slash)
    let path = encoded
    try {
      path = decodeURIComponent(encoded)
    } catch {
      path = encoded // malformed %-escape: keep the raw path
    }
    if (path.length > 0) out.push(path)
  }
  return out
}

/** Read the system clipboard and classify what it holds. Never throws. */
export async function readClipboard(): Promise<ClipboardReadResult> {
  try {
    const result = await host().read({ preferredTypes: PREFERRED_TYPES })
    if (result.status === "failed") {
      return { ok: false, reason: `clipboard error: ${errorMessage(result.error)}` }
    }
    if (result.status !== "read") {
      return { ok: false, reason: clipboardStatusMessage(result.status) }
    }
    const mimeType = result.representation.mimeType
    if (baseMediaType(mimeType).startsWith("image/")) {
      return { ok: true, kind: "image", mimeType, bytes: result.representation.bytes }
    }
    const text = new TextDecoder().decode(result.representation.bytes)
    if (isFileListMime(mimeType)) {
      const paths = parseFileUriList(text)
      if (paths.length > 0) return { ok: true, kind: "files", paths }
    }
    if (text.length > 0) return { ok: true, kind: "text", text }
    return { ok: false, reason: "clipboard is empty" }
  } catch (e) {
    return { ok: false, reason: `clipboard error: ${errorMessage(e)}` }
  }
}
