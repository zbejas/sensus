/**
 * Usage resource (P4c-ii; docs/daemon-api.md "Routes", docs/agent.md
 * "Observability").
 *
 * `GET /v1/usage` returns the serializable roll-ups the UsageDashboard overlay
 * renders: the bounded `by day` window, the full `by session` list (titles
 * included), and the overall total. The pure aggregation lives in the engine
 * (`aggregateUsage`, `sumRollups`); this module only reads the transcripts and
 * shapes the report, so a remote client needs no local sessions dir.
 *
 * Never throws: a missing or unreadable sessions dir degrades to an empty
 * report. `bySession` is capped at `MAX_USAGE_SESSIONS` (newest activity
 * first) so a huge history cannot grow the response without bound.
 */

import { Elysia } from "elysia"
import { getLogger } from "../core/log.ts"
import {
  aggregateUsage,
  isUsageDayKey,
  listAllSessions,
  sumRollups,
  type UsageRollup,
  type UsageSample,
} from "../engine/index.ts"
import { jsonResponse, unauthorizedResponse, usageResponseSchema } from "./apiSchemas.ts"

/** The dashboard window: the newest N distinct days with usage. */
export const USAGE_WINDOW_DAYS = 14
/** Bound on the `by session` list (newest activity first). */
export const MAX_USAGE_SESSIONS = 500

/** One session's display metadata (the `by session` row title/sort key). */
export interface UsageSessionMeta {
  path: string
  title: string
  lastTs: number
}

/** The serializable usage report (mirrors the dashboard's in-process one). */
export interface DaemonUsageReport {
  windowDays: number
  generatedAt: number
  /** Sum over the windowed day roll-ups. */
  total: UsageRollup
  /** Roll-ups per day, within the window (oldest first is NOT guaranteed). */
  byDay: UsageRollup[]
  /** Roll-ups per session, all retained history, newest activity first. */
  bySession: UsageRollup[]
  /** Display metadata for every session in `bySession`. */
  sessions: UsageSessionMeta[]
  /** Distinct sessions with usage inside the day window (the header count). */
  windowSessions: number
}

export interface BuildUsageReportOptions {
  windowDays?: number
  now?: () => number
}

/**
 * Build the report from the sessions data dir. `opts.now` is a test seam for
 * `generatedAt`.
 */
export function buildUsageReport(dataDir: string, opts: BuildUsageReportOptions = {}): DaemonUsageReport {
  const windowDays = Math.max(1, Math.floor(opts.windowDays ?? USAGE_WINDOW_DAYS))
  const generatedAt = (opts.now ?? Date.now)()

  let sessions: ReturnType<typeof listAllSessions> = []
  try {
    sessions = listAllSessions(dataDir)
  } catch {
    sessions = []
  }

  interface Turn {
    day: string
    path: string
    usage: UsageSample["usage"]
  }
  const turns: Turn[] = []
  const sessionMeta = new Map<string, UsageSessionMeta>()
  for (const s of sessions) {
    const label = s.title.length > 0 ? s.title : s.path
    sessionMeta.set(s.path, { path: s.path, title: label, lastTs: s.lastTs ?? 0 })
    for (const m of s.messages) {
      if (m.role !== "assistant") continue
      const at = m.ts ?? s.lastTs
      let day = "unknown"
      try {
        if (at !== null && at !== undefined) day = new Date(at).toISOString().slice(0, 10)
      } catch {
        // keep "unknown"
      }
      turns.push({ day, path: s.path, usage: m.usage ?? null })
    }
  }

  const knownDays = [...new Set(turns.map((t) => t.day).filter(isUsageDayKey))].sort()
  const keptDays = new Set(knownDays.slice(-windowDays))
  // Non-calendar keys ("unknown", legacy) cannot be ordered into the window,
  // so they ride along rather than being silently dropped.
  const inWindow = (day: string): boolean => !isUsageDayKey(day) || keptDays.has(day)

  // Bound the session list to the newest activity first.
  const orderedPaths = [...sessionMeta.values()]
    .sort((a, b) => b.lastTs - a.lastTs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, MAX_USAGE_SESSIONS)
    .map((s) => s.path)
  const keptPaths = new Set(orderedPaths)

  const byDay: UsageSample[] = []
  const bySession: UsageSample[] = []
  const windowPaths = new Set<string>()
  for (const t of turns) {
    if (!keptPaths.has(t.path)) continue
    bySession.push({ key: t.path, usage: t.usage })
    if (!inWindow(t.day)) continue
    byDay.push({ key: t.day, usage: t.usage })
    if (t.usage !== null) windowPaths.add(t.path)
  }

  const dayRows = aggregateUsage(byDay)
  const total = sumRollups(dayRows)
  // Keep the newest-first order established above; aggregateUsage preserves
  // first-seen order, which follows `orderedPaths`.
  const sessionRows = aggregateUsage(bySession)
    .filter((r) => keptPaths.has(r.key))
    .sort((a, b) => {
      const at = sessionMeta.get(a.key)?.lastTs ?? 0
      const bt = sessionMeta.get(b.key)?.lastTs ?? 0
      if (bt !== at) return bt - at
      return b.totalTokens - a.totalTokens
    })

  return {
    windowDays,
    generatedAt,
    total,
    byDay: dayRows,
    bySession: sessionRows,
    sessions: orderedPaths.map((p) => sessionMeta.get(p)).filter((s): s is UsageSessionMeta => s !== undefined),
    windowSessions: windowPaths.size,
  }
}

export interface UsageRoutesDeps {
  /** The report builder; defaults to the sessions data dir. */
  report: () => DaemonUsageReport
}

/** Mount the usage route (auth is applied globally by the parent app). */
export function usageRoutes(deps: UsageRoutesDeps) {
  return new Elysia({ name: "sensus-daemon-usage" }).get(
    "/v1/usage",
    () => {
      try {
        return { ok: true, ...deps.report() }
      } catch (err) {
        getLogger().child({ component: "daemon.usage" }).warn("usage report build failed", { err })
        return {
          ok: true,
          windowDays: USAGE_WINDOW_DAYS,
          generatedAt: Date.now(),
          total: sumRollups([]),
          byDay: [],
          bySession: [],
          sessions: [],
          windowSessions: 0,
        }
      }
    },
    {
      detail: {
        tags: ["usage"],
        operationId: "getUsage",
        summary: "Usage roll-ups for the dashboard",
        description:
          "The bounded `by day` window (newest 14 distinct days with usage), the full `by session` list (capped at 500, newest activity first) and the overall total. A missing or unreadable sessions dir degrades to an empty report.",
        responses: { 200: jsonResponse(usageResponseSchema, "The serializable usage report."), 401: unauthorizedResponse() },
      },
    },
  )
}
