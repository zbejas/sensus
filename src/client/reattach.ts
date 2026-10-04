/**
 * reconnect re-attachment (D5/D12; docs/architecture.md §client).
 *
 * The daemon keeps a socket's shell/chat subscriptions PER CONNECTION and drops
 * them when that socket closes. When the client's auto-reconnect opens a new
 * socket, the fresh server-side connection knows nothing about the shells/chats
 * this TUI was watching — so without re-attaching, `terminal.output` /
 * `chat.delta` / `chat.done` stop arriving and the UI freezes on the last state
 * it saw (e.g. a spinner that never settles).
 *
 * `reattachTabs` re-issues `terminal.attach` (which resumes from the session's
 * applied output cursor, so only missed bytes are replayed) and `chat.attach`
 * (which re-watches and pushes a fresh `chat.state` snapshot) for every open
 * tab. It awaits each attach and reports the tabs whose shell no longer exists
 * so the caller can rebuild them; a transient transport failure is surfaced but
 * never throws, and a `controller_taken` race against the daemon's still-open
 * previous socket is retried with backoff.
 */

import { errorMessage, isRecord } from "../core/util.ts"

/** The minimal transport shape `reattachTabs` needs (a `WsClient` satisfies it). */
export interface ReattachTransport {
  chat: { attach(params: { chatId: string }): Promise<unknown> }
}

/** The minimal tab shape `reattachTabs` needs (a `TabView` satisfies it). */
export interface ReattachableTab {
  id: number
  session: { reattach(): Promise<void>; readonly shellId: string }
  chat: { chatId: string }
}

/** One terminal reattach failure (the caller may rebuild when `shell_not_found`). */
export interface ReattachFailure {
  tab: ReattachableTab
  code: string | null
  message: string
}

/** Outcome of one recovery pass (for tests/diagnostics and rebuild decisions). */
export interface ReattachReport {
  /** Tabs whose terminal reattach was attempted. */
  attempted: number
  /** Tabs whose terminal `attach` failed. */
  terminalFailed: ReattachFailure[]
}

export interface ReattachOptions {
  /** Sleep seam for the `controller_taken` backoff (tests). */
  sleep?: (ms: number) => Promise<void>
  /** Max `controller_taken` retries per tab; default 4. */
  controllerRetries?: number
}

/** The stable error code of a transport failure, when it has one. */
function errorCode(e: unknown): string | null {
  if (!isRecord(e)) return null
  return typeof e["code"] === "string" ? e["code"] : null
}

/**
 * Split open tabs by whether the daemon still holds their shell. `live` is the
 * `terminal.list` shell-id set, or null when the listing was unavailable (then
 * every tab is "present" and the caller falls back to a best-effort re-attach).
 * `missing` tabs are rebuilt by the caller instead of being orphaned. Pure.
 */
export function partitionReattachTabs(
  tabs: ReadonlyArray<ReattachableTab>,
  live: ReadonlySet<string> | null,
): { present: ReattachableTab[]; missing: ReattachableTab[] } {
  if (live === null) return { present: [...tabs], missing: [] }
  const present: ReattachableTab[] = []
  const missing: ReattachableTab[] = []
  for (const tab of tabs) {
    if (live.has(tab.session.shellId)) present.push(tab)
    else missing.push(tab)
  }
  return { present, missing }
}

/**
 * Re-attach every open tab after a transport reconnect. Awaits the terminal
 * reattach (cursor-resumed) and the chat snapshot per tab; never throws. A tab
 * whose terminal attach failed (e.g. `shell_not_found` after a daemon restart)
 * is returned in `terminalFailed` so the caller can rebuild it in place.
 */
export async function reattachTabs(
  ws: ReattachTransport,
  tabs: ReadonlyArray<ReattachableTab>,
  onError?: (message: string) => void,
  opts: ReattachOptions = {},
): Promise<ReattachReport> {
  const terminalFailed: ReattachFailure[] = []
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms))
  const retries = opts.controllerRetries ?? 4
  const report = (message: string): void => {
    try {
      onError?.(message)
    } catch {
      // An error sink failure must not abort the rest of the recovery.
    }
  }

  for (const tab of tabs) {
    let lastError: unknown = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        await tab.session.reattach()
        lastError = null
        break
      } catch (e) {
        lastError = e
        // The daemon may not have processed the previous socket's close yet;
        // wait it out instead of leaving the tab frozen.
        if (errorCode(e) !== "controller_taken" || attempt === retries) break
        try {
          await sleep(100 * 2 ** attempt)
        } catch {
          // a failing sleep seam must not abort recovery
          break
        }
      }
    }
    if (lastError !== null) {
      terminalFailed.push({ tab, code: errorCode(lastError), message: errorMessage(lastError) })
      report(errorMessage(lastError))
    }

    // A shell that is gone takes its bound chat with it (and the caller
    // rebuilds the tab); a transient terminal failure still gets the chat
    // snapshot so the sidebar recovers on its own.
    if (errorCode(lastError) === "shell_not_found") continue
    try {
      await ws.chat.attach({ chatId: tab.chat.chatId })
    } catch (e) {
      // The shell is attached; a missing/closed chat must not rebuild the tab.
      report(errorMessage(e))
    }
  }

  return { attempted: tabs.length, terminalFailed }
}
