/**
 * PromptComposer — the input-editor seam extracted from ChatSession
 * (MOVE-ONLY). Owns the single `InputEditor` instance (shared with the sidebar
 * through `ChatSession.editorState`), the draft image attachments, the slash
 * autocomplete selection/dismissal state, and the up-arrow history ring.
 *
 * The signal accessors are exposed as bound arrow properties so
 * `ChatSession.accessors` can hold them directly (a plain method would lose
 * `this` when called off the accessors object). All ChatSession-facing names
 * stay on ChatSession as thin delegates; this class is not imported by UI code.
 */

import { createSignal } from "solid-js"
import { dirname, join } from "node:path"
import type { SessionFile } from "../../session/store.ts"
import { InputEditor } from "../../engine/chat/inputEditor.ts"
import { MAX_ATTACHMENTS, readImageAttachment, storeImageBytes, type ImageAttachment } from "../../core/image.ts"
import { resolveToolPath } from "../tools.ts"
import { acceptCompletion, slashMenuForLine, type SlashMenuState } from "../../engine/chat/slashComplete.ts"
import { componentLogger } from "../log.ts"

const log = componentLogger("agent.chat")

export interface PromptComposerHost {
  /** imageAssetsDir source (the session's JSONL file). */
  getFile(): SessionFile
  /** paneCwd source (path resolution for /image). */
  paneCwd(): string | null
  /** modelMeta()?.vision === true. */
  isVisionModel(): boolean
}

export class PromptComposer {
  readonly editor = new InputEditor()

  private readonly sEditorVersion = createSignal(0)
  /** Images attached to the current draft (docs/agent.md "Images"), cleared
   * when the message is sent. The pixel bytes live on disk (session assets). */
  private readonly sDraftImages = createSignal<ImageAttachment[]>([])
  /** Highlighted row in the slash autocomplete menu (M8). */
  private readonly sSlashSel = createSignal(0)
  /** Slash menu dismissed with Esc (M8) until the draft text changes again.
   * A SIGNAL, not a field: the sidebar's menu memo tracks it (a plain field
   * would leave the stale menu painted — the M7 reactivity lesson). */
  private readonly sSlashDismissed = createSignal(false)

  private readonly history: string[] = []
  private histIdx: number | null = null

  constructor(private readonly host: PromptComposerHost) {}

  // ---- signal accessors held by ChatSession.accessors ----------------------

  /** Bound accessor (see the class comment). */
  readonly editorVersion = (): number => this.sEditorVersion[0]()
  /** Draft image attachments, newest last. */
  readonly draftImages = (): ImageAttachment[] => this.sDraftImages[0]()
  /** Highlighted slash row. */
  readonly slashSelection = (): number => this.sSlashSel[0]()

  // ---- history recall (per-tab, in-memory ring) ---------------------------

  historyOlder(): string | null {
    if (this.history.length === 0) return null
    this.histIdx = this.histIdx === null ? this.history.length - 1 : Math.max(0, this.histIdx - 1)
    return this.history[this.histIdx] ?? null
  }

  historyNewer(): string | null {
    if (this.histIdx === null) return null
    this.histIdx++
    if (this.histIdx >= this.history.length) {
      this.histIdx = null
      return ""
    }
    return this.history[this.histIdx] ?? null
  }

  isBrowsingHistory(): boolean {
    return this.histIdx !== null
  }

  noteTextEdited(): void {
    this.histIdx = null
    this.sSlashDismissed[1](false) // a new query reopens the menu
    this.sSlashSel[1](0)
  }

  /** Append a sent line to the up-arrow history (bounded). */
  pushHistory(text: string): void {
    this.history.push(text)
    if (this.history.length > 50) this.history.shift()
    this.histIdx = null
  }

  // ---- editor ---------------------------------------------------------------

  bumpEditor(): void {
    this.sEditorVersion[1]((v) => v + 1)
  }

  setDraft(text: string): void {
    this.editor.setText(text)
    this.noteTextEdited()
    this.bumpEditor()
  }

  getDraft(): string {
    return this.editor.getText()
  }

  clearDraft(): void {
    this.editor.clear()
    this.noteTextEdited()
    this.bumpEditor()
  }

  // ---- image attachments (docs/agent.md "Images") -------------------------

  /** Directory for this session's stored image assets (beside the JSONL). */
  private imageAssetsDir(): string | null {
    try {
      return join(dirname(this.host.getFile().filePath), "assets")
    } catch (e) {
      log.debug("image assets dir resolution failed", { err: e })
      return null
    }
  }

  /** Does the selected model accept image input? (models.dev / config override;
   * metadata absent = unknown, which does not enable the view_image tool.) */
  modelSupportsVision(): boolean {
    return this.host.isVisionModel()
  }

  /** Add a validated attachment to the draft (dedupe by id, cap by count). */
  private pushDraftImage(att: ImageAttachment): { ok: true } | { ok: false; error: string } {
    const existing = this.sDraftImages[0]()
    if (existing.some((a) => a.id === att.id && a.path === att.path)) return { ok: true }
    if (existing.length >= MAX_ATTACHMENTS) return { ok: false, error: `at most ${MAX_ATTACHMENTS} images per message` }
    this.sDraftImages[1]([...existing, att])
    return { ok: true }
  }

  /**
   * Attach an image from raw bytes (clipboard paste): stored under the
   * session's assets dir so the transcript references stable bytes.
   */
  addDraftImage(bytes: Uint8Array, name: string, mediaTypeHint?: string): { ok: true } | { ok: false; error: string } {
    const dir = this.imageAssetsDir()
    if (dir === null) return { ok: false, error: "no session file to store the image" }
    const stored = storeImageBytes(dir, bytes, name, mediaTypeHint)
    if (!stored.ok) return { ok: false, error: stored.error }
    return this.pushDraftImage(stored.attachment)
  }

  /** Attach an image FILE (path resolves against the pane cwd). */
  addDraftImageFromPath(pathArg: string): { ok: true; name: string; bytes: number } | { ok: false; error: string } {
    const full = resolveToolPath(pathArg, this.host.paneCwd())
    const att = readImageAttachment(full)
    if (att === null) return { ok: false, error: `not a readable image (png, jpeg, webp, gif): ${full}` }
    const pushed = this.pushDraftImage(att)
    return pushed.ok ? { ok: true, name: att.name, bytes: att.bytes } : pushed
  }

  removeDraftImage(id: string): void {
    this.sDraftImages[1]((list) => list.filter((a) => a.id !== id))
  }

  clearDraftImages(): void {
    if (this.sDraftImages[0]().length > 0) this.sDraftImages[1]([])
  }

  /** Replace the draft's attachments wholesale (rewind / clear). */
  setDraftImages(images: ImageAttachment[]): void {
    this.sDraftImages[1](images)
  }

  // ---- slash autocomplete (M8) -----------------------------------------------

  /**
   * Current autocomplete state for the draft (null = menu closed): the cursor
   * must sit on the FIRST logical line and that line must be "/token" with no
   * space yet. Derived from the editor, so it can never go stale across tab
   * switches; an Esc dismissal resets on the next text edit.
   */
  slashMenu(): SlashMenuState | null {
    if (this.sSlashDismissed[0]()) return null
    const cur = this.editor.cursor()
    const first = this.editor.getText().split("\n")[0] ?? ""
    return slashMenuForLine(first, cur.row === 0)
  }

  /** Move the highlighted menu row (wraps); count = current match count. */
  slashSelect(delta: number, count: number): void {
    if (count <= 0) return
    const cur = this.sSlashSel[0]()
    this.sSlashSel[1]((((cur + delta) % count) + count) % count)
  }

  /** Esc: dismiss the menu without touching the draft. */
  slashDismiss(): void {
    this.sSlashDismissed[1](true)
  }

  /** Accept the highlighted completion (Tab / Enter on a partial token). */
  acceptSlashCompletion(): boolean {
    const menu = this.slashMenu()
    if (menu === null) return false
    const sel = Math.min(this.sSlashSel[0](), menu.matches.length - 1)
    const match = menu.matches[sel] ?? menu.matches[0]
    return match !== undefined && this.completeWith(match.name)
  }

  /** Click-to-accept a specific menu row (only while that row is offered). */
  acceptSlashNamed(name: string): boolean {
    const menu = this.slashMenu()
    if (menu === null || !menu.matches.some((m) => m.name === name)) return false
    return this.completeWith(name)
  }

  private completeWith(name: string): boolean {
    if (this.slashMenu() === null) return false // draft changed since render
    const res = acceptCompletion(this.getDraft(), name)
    this.editor.setText(res.text)
    this.editor.setCursor(res.cursorRow, res.cursorCol)
    this.histIdx = null
    this.sSlashDismissed[1](false)
    this.sSlashSel[1](0)
    this.bumpEditor()
    return true
  }
}
