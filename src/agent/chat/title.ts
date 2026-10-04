/**
 * Auto session titles (docs/sessions.md "Auto titles"): a tiny one-shot,
 * no-tools completion over the first user prompt, cleaned by
 * `cleanSessionTitle` (session/meta.ts) before it lands in the sidecar.
 *
 * Best-effort by contract: the provider seam never rejects, and every failure
 * path returns `null` so the caller keeps the derived (first-message) title.
 * Titles never block or break a send — ChatHost fires this in the background
 * and ignores the result.
 *
 * The model is chosen by the caller: `config.titles.model` when set, else the
 * session's selected model (docs/config.md "titles").
 */

import type { ChatProvider, ProviderMessage } from "../provider/provider.ts"
import { cleanSessionTitle } from "../../session/meta.ts"
import { componentLogger } from "../log.ts"

const log = componentLogger("agent.chat")

/** Completion cap for a title (a few tokens; the cleaner word-caps too). */
export const TITLE_MAX_TOKENS = 48

/** System instruction: ask for exactly one short title, nothing else. */
export const TITLE_INSTRUCTION =
  "You name chat sessions. Reply with ONLY a short title for the user's request: " +
  "3-8 words, no quotes, no trailing punctuation, no 'Title:' prefix. " +
  "Capture the topic or intent so the session is recognizable in a list."

/** The one-shot request messages for a title (system instruction + prompt). */
export function titleMessages(userText: string): ProviderMessage[] {
  return [
    { role: "system", content: TITLE_INSTRUCTION },
    { role: "user", content: userText },
  ]
}

export interface TitleRequest {
  provider: ChatProvider
  model: string
  /** The first user prompt (already trimmed by the caller). */
  userText: string
  signal: AbortSignal
}

/**
 * Ask `provider` for a title and return the cleaned string, or `null` when the
 * stream errored/aborted or produced nothing usable. Never throws.
 */
export async function requestSessionTitle(opts: TitleRequest): Promise<string | null> {
  try {
    let out = ""
    const res = await opts.provider.stream(
      {
        model: opts.model,
        messages: titleMessages(opts.userText),
        maxTokens: TITLE_MAX_TOKENS,
        tools: undefined, // a title is never a tool turn
        thinking: null, // never think for a title (cheap + deterministic)
      },
      { onDelta: (d) => (out += d) },
      opts.signal,
    )
    if (opts.signal.aborted || res.finish === "error") return null
    const title = cleanSessionTitle(out)
    return title.length > 0 ? title : null
  } catch (e) {
    log.debug("session title generation failed", { err: e })
    return null
  }
}
