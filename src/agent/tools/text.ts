// ---- Output truncation -----------------------------------------------------

/** Truncate to `limit` chars keeping head AND tail (shell_background ~8k). */
export function truncateHeadTail(text: string, limit = 8000): string {
  if (text.length <= limit) return text
  const half = Math.max(1, Math.floor(limit / 2))
  const hidden = text.length - 2 * half
  return `${text.slice(0, half)}\n…[${hidden} chars truncated]…\n${text.slice(text.length - half)}`
}

/** Truncate to `limit` chars keeping the head. */
export function truncateHead(text: string, limit = 64_000): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…[truncated: ${text.length - limit} more chars]…`
}
