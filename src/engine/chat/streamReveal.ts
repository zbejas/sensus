/**
 * Stream-reveal smoothing ("typewriter pour") for streaming assistant text —
 * docs/agent.md "Streaming display".
 *
 * Provider deltas arrive in network-sized bursts (several words at once);
 * left alone, each coalesced flush pops the whole burst into the bubble at
 * once, which reads as clanky. The authoritative string is never modified —
 * this module only tracks how much of it is REVEALED and advances the reveal
 * a bounded step per tick, so bursts unfurl like typing:
 *
 *   per-tick step = clamp(CATCHUP × backlog, floor, MAX_STEP)
 *
 * i.e. an exponential ease-out: a steady stream reveals near real time, a
 * burst of any size unfolds over roughly the same ~1s, and the pour can
 * never fall hopelessly behind a fast stream. Once the bubble is no longer
 * the live stream (`settled`), the floor rises so the tail finishes quickly
 * instead of trickling away under the settled label.
 *
 * Pure logic + explicit state (no Solid imports). The ChatSession owns one
 * instance per tab: reveal state must survive the per-flush message-reference
 * recreation (Solid `<For>` re-keys the block) and tab switches, and reset on
 * /clear + resume. The sidebar calls into it inside its layout memo and
 * passes the shared 80ms tick reader (ui/spinner.ts); the tick is read ONLY
 * while a backlog exists, so caught-up text never subscribes (the
 * conditional-read invariant) and idle repaints stay at zero.
 *
 * First sight of a message snaps: fresh streaming bubbles start at "" (their
 * deltas pour), while anything already carrying content (resume, restore,
 * re-mounted history) is shown whole.
 */

/** Advance cadence — matches the shared spinner tick (ui/spinner.ts). */
export const REVEAL_TICK_MS = 80
/** Reveal at least this many chars per tick while live (~25 chars/s floor). */
export const REVEAL_MIN_STEP = 2
/** Fraction of the outstanding backlog revealed per tick (the ease-out). */
export const REVEAL_CATCHUP = 0.18
/** Never reveal more than this per tick (huge dumps pour fast, not snap). */
export const REVEAL_MAX_STEP = 320
/** A long gap between advances (hidden tab, stalled loop) must not turn
 * into one giant jump — clamp the charged elapsed time. */
export const REVEAL_MAX_ELAPSED_MS = 160
/** Settled catch-up floor: once the bubble is no longer the live stream the
 * tail drains at least this fast (~4× the live floor). */
export const REVEAL_SETTLED_MIN_STEP = 96
/** After the pour completes, keep the shared-tick subscription (and the
 * re-render passes it drives) alive this long: opentui's <markdown> paints
 * reliably on MOUNT, and a node that mounts already-final in the very last
 * render pass could otherwise lose its only paint chance (the M9
 * remounted-sibling hazard). Linger gives the final state a few attempts. */
export const REVEAL_LINGER_MS = 220

export interface RevealState {
  /** Chars of the target string currently visible. */
  revealed: number
  /** Timestamp of the last advance (Date.now() clock). */
  lastAt: number
  /** When the pour first reached full length (linger anchor). */
  doneAt?: number
}

export interface RevealAdvanceOptions {
  /** The message is no longer the live stream — drain the tail faster. */
  settled?: boolean
}

/** The shared-animation-tick reader (ui/spinner.ts spinnerFrame). */
export type RevealTickReader = () => number

/** Pure step math: the state advanced toward `targetLen` as of `now`. */
export function advanceReveal(
  st: RevealState,
  targetLen: number,
  now: number,
  opts: RevealAdvanceOptions = {},
): RevealState {
  if (st.revealed >= targetLen) return { revealed: targetLen, lastAt: now }
  const elapsed = Math.min(REVEAL_MAX_ELAPSED_MS, Math.max(0, now - st.lastAt))
  const backlog = targetLen - st.revealed
  const floor = opts.settled === true ? REVEAL_SETTLED_MIN_STEP : REVEAL_MIN_STEP
  const perTick = Math.min(REVEAL_MAX_STEP, Math.max(floor, Math.ceil(backlog * REVEAL_CATCHUP)))
  const step = Math.max(1, Math.round((perTick * elapsed) / REVEAL_TICK_MS))
  return { revealed: Math.min(targetLen, st.revealed + step), lastAt: now }
}

const isHighSurrogate = (x: number): boolean => x >= 0xd800 && x <= 0xdbff
const isLowSurrogate = (x: number): boolean => x >= 0xdc00 && x <= 0xdfff
const isJoiner = (x: number): boolean => x === 0x200d || x === 0xfe0e || x === 0xfe0f
const isCombining = (x: number): boolean => x >= 0x0300 && x <= 0x036f

/**
 * Clamp a reveal cut to a grapheme-safe boundary: never split a UTF-16
 * surrogate pair, never end on a dangling ZWJ/variation selector, and never
 * separate a base char from a combining mark — an emoji like "👨‍👩‍👧" or "é"
 * must not flash as fragments for a frame.
 */
export function clampRevealCut(text: string, cut: number): number {
  let c = Math.max(0, Math.min(Math.floor(cut), text.length))
  while (c > 0 && c < text.length) {
    const prev = text.charCodeAt(c - 1) ?? 0
    const next = text.charCodeAt(c) ?? 0
    const bad =
      (isHighSurrogate(prev) && isLowSurrogate(next)) || isJoiner(prev) || isJoiner(next) || isCombining(next)
    if (!bad) break
    c--
  }
  return c
}

/**
 * The revealed-char cut of `text` for message `id`, advancing the tracked
 * state. `readTick` (the shared spinner frame) is touched only while a
 * backlog exists — pass null in non-reactive contexts (tests, ticks off).
 * The state map lives on the per-tab ChatSession; see the module docs.
 *
 * Returns the cut, NOT a string: callers slice per display unit (the sidebar
 * paces each assistant segment inside stable segment boundaries, so mounted
 * nodes keep updating until the pour is caught up — a one-shot slice of the
 * whole content would mount the tail segment fully-formed, and a missed
 * first paint could never be repainted).
 */
export function revealCut(
  states: Map<number, RevealState>,
  id: number,
  text: string,
  readTick: RevealTickReader | null,
  now: number,
  settled: boolean,
): number {
  let st = states.get(id)
  if (st === undefined) {
    // First sight: a bubble that already has content (resume, restored
    // history, a re-mounted settled block) snaps; a fresh streaming bubble
    // starts at "" and its deltas pour.
    st = { revealed: text.length, lastAt: now, doneAt: now }
    states.set(id, st)
    return text.length
  }
  if (st.revealed >= text.length) {
    st.revealed = text.length // defensive: content never shrinks
    if (st.doneAt === undefined) st.doneAt = now
    if (now - st.doneAt < REVEAL_LINGER_MS) {
      // Linger: keep re-rendering briefly so the final state gets more
      // mount/paint attempts (see REVEAL_LINGER_MS), then unsubscribe.
      readTick?.()
    }
    return text.length
  }
  readTick?.() // subscribe to the shared tick ONLY while behind (or lingering)
  const next = advanceReveal(st, text.length, now, { settled })
  st.revealed = next.revealed
  st.lastAt = next.lastAt
  // Still pouring — a settled stamp from an earlier empty first sight must
  // not survive (contentSettled would flip the streaming display off early).
  st.doneAt = st.revealed >= text.length ? (st.doneAt ?? now) : undefined
  return st.revealed
}

/**
 * Per-tab reveal state: one map per streamed channel (assistant content,
 * reasoning body), keyed by message id. Survives message-reference
 * recreation and tab switches; reset on /clear and resume.
 */
export class StreamReveal {
  private readonly contentStates = new Map<number, RevealState>()
  private readonly thinkingStates = new Map<number, RevealState>()

  content(id: number, text: string, readTick: RevealTickReader | null, now: number, settled: boolean): number {
    return revealCut(this.contentStates, id, text, readTick, now, settled)
  }

  thinking(id: number, text: string, readTick: RevealTickReader | null, now: number, settled: boolean): number {
    return revealCut(this.thinkingStates, id, text, readTick, now, settled)
  }

  /**
   * True when nothing is pending for this message: never tracked, or the
   * pour completed and its linger has elapsed (safe to leave the streaming
   * display). A message whose pour is still behind reports false — the
   * caller (ChatSession) then holds the streaming environment, whose tick
   * passes are what paint the tail reliably.
   */
  contentSettled(id: number, now: number): boolean {
    const st = this.contentStates.get(id)
    return st === undefined || (st.doneAt !== undefined && now - st.doneAt >= REVEAL_LINGER_MS)
  }

  /** /clear + resume: no message carries pending reveal state. */
  reset(): void {
    this.contentStates.clear()
    this.thinkingStates.clear()
  }
}
