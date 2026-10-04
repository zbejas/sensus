import type { CliArgs } from "./types.ts"

/** Parse CLI flags. Unknown flags are ignored. */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { resume: false, yolo: false }
  const takeValue = (flag: string): string | undefined => {
    const eq = flag.indexOf("=")
    if (eq !== -1) return flag.slice(eq + 1)
    return undefined
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) continue
    const inline = takeValue(a)
    const value = (): string | undefined => {
      if (inline !== undefined) return inline
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) {
        i++
        return next
      }
      return undefined
    }
    if (a === "--resume" || a.startsWith("--resume=")) args.resume = true
    else if (a === "--yolo") args.yolo = true
    else if (a.startsWith("--model")) args.model = value()
    else if (a.startsWith("--endpoint")) args.endpoint = value()
    else if (a.startsWith("--base-url")) args.baseURL = value()
    else if (a.startsWith("--sidebar-width")) {
      const v = value()
      if (v !== undefined) {
        const n = Number(v)
        if (Number.isFinite(n) && n >= 20) args.sidebarWidth = Math.floor(n)
      }
    }
    // Unknown flags ignored.
  }
  return args
}

/** Validate a baseURL; returns an error message or null when acceptable. */
export function validateBaseURL(url: string | undefined): string | null {
  if (!url || url.trim() === "") return "empty baseURL"
  try {
    const u = new URL(url)
    if (u.protocol !== "http:" && u.protocol !== "https:") return `unsupported protocol "${u.protocol}"`
    return null
  } catch {
    return `unparseable baseURL "${url}"`
  }
}
