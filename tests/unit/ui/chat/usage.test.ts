import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  aggregateUsage,
  buildUsageChart,
  estimatedCost,
  formatTokenCount,
  formatUsageRow,
  sumRollups,
  usageChartLegend,
  usageSegments,
  type UsageRollup,
  type UsageRow,
} from "../../../../src/engine/chat/usage.ts"
import { usageLines, usageReport } from "../../../../src/ui/components/UsageDashboard.tsx"
import { buildUsageReport } from "../../../../src/daemon/usage.ts"
import type { UsageInfo } from "../../../../src/agent/provider/provider.ts"

const rowText = (r: UsageRow): string => r.spans.map((s) => s.text).join("")
const rowTones = (r: UsageRow): string[] => [
  ...new Set(r.spans.flatMap((s) => (s.bg !== undefined ? [s.tone, s.bg] : [s.tone]))),
]

const u = (p: number, c: number, cached?: number): UsageInfo => ({
  promptTokens: p,
  completionTokens: c,
  totalTokens: p + c,
  cachedTokens: cached ?? null,
})

describe("usage aggregation", () => {
  test("rolls up by key with cache percent; null usage is skipped", () => {
    const rows = aggregateUsage([
      { key: "s1", usage: u(100, 20, 40) },
      { key: "s1", usage: u(100, 30, 60) },
      { key: "s2", usage: u(50, 10) },
      { key: "s2", usage: null },
    ])
    const s1 = rows.find((r) => r.key === "s1")!
    expect(s1.calls).toBe(2)
    expect(s1.promptTokens).toBe(200)
    expect(s1.completionTokens).toBe(50)
    expect(s1.totalTokens).toBe(250)
    expect(s1.cachedTokens).toBe(100)
    expect(s1.cachePercent).toBe(50)
    expect(rows.find((r) => r.key === "s2")?.cachePercent).toBe(0)
  })

  test("cost is null without a price and computed with one; formatting is compact", () => {
    const [row] = aggregateUsage([{ key: "m", usage: u(1_000_000, 500_000) }])
    expect(row).toBeDefined()
    expect(estimatedCost(row!, {})).toBeNull()
    expect(estimatedCost(row!, { m: { input: 3, output: 15 } })!).toBeCloseTo(3 + 7.5, 5)
    expect(formatTokenCount(999)).toBe("999")
    expect(formatTokenCount(12_300)).toBe("12.3k")
    expect(formatTokenCount(1_280_000)).toBe("1.3M")
    expect(formatUsageRow(row!)).toContain("cache 0%")
    expect(formatUsageRow(row!, { m: { input: 3, output: 15 } })).toContain("$10.5000")
  })

  test("sumRollups keeps the call count of the source rows and recomputes cache%", () => {
    const rows = aggregateUsage([
      { key: "a", usage: u(100, 10, 50) },
      { key: "b", usage: u(300, 30, 0) },
    ])
    const total = sumRollups(rows)
    expect(total.key).toBe("all")
    expect(total.calls).toBe(2)
    expect(total.promptTokens).toBe(400)
    expect(total.completionTokens).toBe(40)
    expect(total.totalTokens).toBe(440)
    expect(total.cachedTokens).toBe(50)
    expect(total.cachePercent).toBe(12)
  })

  test("usageLines aggregates a transcript by day and session with a cache hit rate", () => {
    const dir = mkdtempSync(join(tmpdir(), "sensus-usage-"))
    try {
      const inst = join(dir, "sessions", "inst")
      mkdirSync(inst, { recursive: true })
      const events = [
        { ts: 1700000000000, type: "user_message", content: "hi" },
        {
          ts: 1700000001000,
          type: "assistant_message",
          content: "yo",
          model: "m",
          usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, cachedTokens: 50 },
          aborted: false,
        },
        { ts: 1700000002000, type: "user_message", content: "more" },
        {
          ts: 1700000003000,
          type: "assistant_message",
          content: "sure",
          model: "m",
          usage: { promptTokens: 200, completionTokens: 20, totalTokens: 220, cachedTokens: 0 },
          aborted: false,
        },
      ]
      writeFileSync(join(inst, "tab-1.jsonl"), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8")
      const text = usageLines(buildUsageReport(dir)).join("\n")
      expect(text).toContain("by day")
      expect(text).toContain("by session")
      expect(text).toContain("cache 16%")
      expect(text).toContain("330 tok")
      // The `all` row must count every call, not collapse to a single sample.
      expect(text).toContain("all · 2 calls · 330 tok (300 in / 30 out)")
      // The dashboard now leads with a stacked daily chart.
      expect(text).toContain("tokens by day")
      expect(text).toContain("cache hit")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const roll = (key: string, prompt: number, completion: number, cached = 0): UsageRollup => ({
  key,
  calls: 1,
  promptTokens: prompt,
  completionTokens: completion,
  totalTokens: prompt + completion,
  cachedTokens: cached,
  cachePercent: prompt > 0 ? Math.floor((cached / prompt) * 100) : 0,
})

describe("usage chart", () => {
  test("segments split the prompt into cache hit/miss and clamp a bogus cache", () => {
    expect(usageSegments(roll("d", 300, 40, 200))).toEqual({ cache: 200, miss: 100, output: 40 })
    // cached beyond the prompt must not paint past the bar
    expect(usageSegments(roll("d", 100, 5, 999))).toEqual({ cache: 100, miss: 0, output: 5 })
  })

  test("builds a scaled stacked bar chart with axis ticks, dates and colors", () => {
    const chart = buildUsageChart(
      [roll("2026-01-01", 300, 100, 200), roll("2026-01-02", 100, 0, 0), roll("2026-01-03", 0, 50, 0)],
      { width: 60, height: 4 },
    )
    expect(chart.max).toBe(400)
    expect(chart.days).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"])
    expect(chart.truncatedFrom).toBeNull()
    // height plot rows + one date-label row
    expect(chart.rows.length).toBe(5)

    const top = chart.rows[0]!
    expect(rowText(top)).toContain("400") // max tick
    expect(rowText(top).split("")[0]).toBe("4") // gutter is right-aligned to the widest label
    expect(rowText(top)).toContain("█") // the busiest day reaches the top
    expect(rowTones(top)).toContain("success") // cache hit rides on top

    const bottom = chart.rows[3]!
    expect(rowText(bottom)).toContain("┼") // 0 tick meets the axis
    expect(rowText(bottom)).toContain("─") // baseline
    expect(rowTones(bottom)).toContain("warning") // output sits at the base...
    expect(rowTones(bottom)).toContain("accent") // ...with the cache-miss slice above it

    // The chart is colour-separated top→bottom: cache hit, cache miss, output.
    const stack = chart.rows.flatMap((r) => r.spans.filter((s) => s.text.includes("█")).map((s) => s.tone))
    expect(stack).toContain("success")
    expect(stack).toContain("accent")
    expect(stack).toContain("warning")

    // The last row carries thinned MM/DD labels.
    expect(rowText(chart.rows[4]!)).toContain("01/01")
  })

  test("keeps the newest days and flags truncation when the plot is too narrow", () => {
    const days = Array.from({ length: 10 }, (_, i) => roll(`2026-02-${String(i + 1).padStart(2, "0")}`, 100, 0))
    const chart = buildUsageChart(days, { width: 14, height: 4 })
    expect(chart.days.length).toBeLessThan(10)
    expect(chart.days.at(-1)).toBe("2026-02-10") // newest retained
    expect(chart.truncatedFrom).toBe(10)
  })

  test("a tiny non-zero segment keeps at least one visible cell", () => {
    // Output is 0.1% of the bar: it must not be swallowed by the cache-hit block.
    const outputOnly = new Set(
      buildUsageChart([roll("2026-03-01", 999_000, 1000, 999_000)], { width: 40, height: 4 }).rows.flatMap(rowTones),
    )
    expect(outputOnly).toContain("warning")
    expect(outputOnly).toContain("success")
    expect(outputOnly).not.toContain("accent") // no cache-miss tokens -> no miss color

    // A 0.1% miss and 0.1% output both survive alongside a dominant cache hit.
    const all = new Set(
      buildUsageChart([roll("2026-03-02", 1_000_000, 1000, 999_000)], { width: 40, height: 4 }).rows.flatMap(rowTones),
    )
    expect([...all]).toEqual(expect.arrayContaining(["success", "accent", "warning"]))
  })

  test("grows a short bar so every segment colour is shown", () => {
    const chart = buildUsageChart(
      [
        roll("2026-04-01", 1000, 100, 900), // tiny day, all three segments
        roll("2026-04-02", 1_000_000, 100_000, 900_000),
      ],
      { width: 40, height: 8 },
    )
    const tones = new Set(chart.rows.flatMap(rowTones))
    expect([...tones]).toEqual(expect.arrayContaining(["success", "accent", "warning"]))
    // The tiny bar is grown to one cell per segment (3), not rounded to nothing.
    expect(chart.rows.length).toBe(9) // 8 plot rows + date labels
  })

  test("no usable days yields no chart; the legend is colour-separated", () => {
    expect(buildUsageChart([], { width: 40, height: 4 }).rows).toEqual([])
    expect(buildUsageChart([roll("unknown", 10, 5)], { width: 40, height: 4 }).rows).toEqual([])
    expect(rowTones(usageChartLegend())).toEqual(expect.arrayContaining(["success", "accent", "warning"]))
    expect(rowText(usageChartLegend())).toContain("cache hit")
  })

  test("the report interleaves chart rows between the summary and the text roll-ups", () => {
    const dir = mkdtempSync(join(tmpdir(), "sensus-usage-chart-"))
    try {
      const inst = join(dir, "sessions", "inst")
      mkdirSync(inst, { recursive: true })
      const events = [
        { ts: Date.UTC(2026, 0, 1), type: "user_message", content: "hi" },
        { ts: Date.UTC(2026, 0, 1) + 1000, type: "assistant_message", content: "yo", model: "m", usage: { promptTokens: 300, completionTokens: 100, totalTokens: 400, cachedTokens: 200 }, aborted: false },
        { ts: Date.UTC(2026, 0, 2), type: "user_message", content: "more" },
        { ts: Date.UTC(2026, 0, 2) + 1000, type: "assistant_message", content: "ok", model: "m", usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100, cachedTokens: 0 }, aborted: false },
      ]
      writeFileSync(join(inst, "tab-1.jsonl"), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8")
      const rows = usageReport(buildUsageReport(dir), { width: 60, height: 4 })
      const text = rows.map(rowText)
      const chartAt = text.findIndex((l) => l.includes("tokens by day"))
      const legendAt = text.findIndex((l) => l.includes("cache hit"))
      const dayAt = text.findIndex((l) => l.trimStart().startsWith("by day"))
      expect(chartAt).toBeGreaterThan(-1)
      // One session, two calendar days: the daily view must show BOTH days
      // (bucketed per message, not collapsed onto the session's last ts).
      expect(text[chartAt]).toContain("2 days")
      expect(legendAt).toBeGreaterThan(chartAt)
      expect(text[legendAt + 1]).toBe("") // blank padding between legend and graph
      expect(dayAt).toBeGreaterThan(chartAt)
      expect(text.some((l) => l.includes("cache hit"))).toBe(true)
      // Chart labels thin out to the first date; both days appear in `by day`.
      expect(text.some((l) => l.includes("01/01"))).toBe(true)
      expect(text.some((l) => l.includes("2026-01-02"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("keeps same-titled sessions as separate, individually clickable rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "sensus-usage-dup-"))
    try {
      const inst = join(dir, "sessions", "inst")
      mkdirSync(inst, { recursive: true })
      const write = (name: string, prompt: number): void => {
        const events = [
          { ts: 1700000000000, type: "user_message", content: "same title" },
          { ts: 1700000001000, type: "assistant_message", content: "reply", model: "m", usage: { promptTokens: prompt, completionTokens: 0, totalTokens: prompt, cachedTokens: 0 }, aborted: false },
        ]
        writeFileSync(join(inst, `${name}.jsonl`), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8")
      }
      write("tab-1", 100)
      write("tab-2", 900)
      const rows = usageReport(buildUsageReport(dir), { width: 60, height: 4 })
      const sessionRows = rows.filter((r) => r.sessionPath !== undefined)
      // Both sessions share a title, so the by-session list must still list both
      // (keyed by path) rather than merging them into one row.
      expect(sessionRows).toHaveLength(2)
      expect(new Set(sessionRows.map((r) => r.sessionPath)).size).toBe(2)
      expect(new Set(sessionRows.map((r) => r.sessionTitle))).toEqual(new Set(["same title"]))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("orders the text lists newest-first: recent days and sessions on top", () => {
    const dir = mkdtempSync(join(tmpdir(), "sensus-usage-order-"))
    try {
      const inst = join(dir, "sessions", "inst")
      mkdirSync(inst, { recursive: true })
      const session = (name: string, iso: string, prompt: number): void => {
        const ts = Date.parse(`${iso}T12:00:00Z`)
        const events = [
          { ts, type: "user_message", content: name },
          { ts: ts + 1000, type: "assistant_message", content: "reply", model: "m", usage: { promptTokens: prompt, completionTokens: 0, totalTokens: prompt, cachedTokens: 0 }, aborted: false },
        ]
        writeFileSync(join(inst, `${name}.jsonl`), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8")
      }
      session("a", "2026-01-05", 300)
      session("b", "2026-01-03", 500)
      session("c", "2026-01-08", 100)
      const text = usageReport(buildUsageReport(dir), { width: 60, height: 4 }).map(rowText)
      const after = (needle: string): string[] => {
        const at = text.findIndex((l) => l.trimStart().startsWith(needle))
        return text.slice(at + 1)
      }
      const dayStart = (l: string): string => l.trim().slice(0, 10)
      const days = after("by day")
        .filter((l) => /^\s{2}\d{4}-\d{2}-\d{2}/.test(l))
        .map(dayStart)
      expect(days).toEqual(["2026-01-08", "2026-01-05", "2026-01-03"])
      // Sessions are ranked by newest activity first: c (01-08), a (01-05), b (01-03).
      const toks = after("by session").filter((l) => l.includes("tok")).map((l) => Number(l.split("·")[2]?.trim().split(" ")[0]))
      expect(toks).toEqual([100, 300, 500])
      // Session rows carry the transcript path so the dashboard can open its ctx.
      const sessionRow = usageReport(buildUsageReport(dir), { width: 60, height: 4 }).find((r) => r.sessionPath !== undefined)
      expect(sessionRow?.sessionPath).toMatch(/\.jsonl$/)
      expect(sessionRow?.sessionTitle).toBeTruthy()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the daily roll-up spans every session, not just the 50 newest", () => {
    const dir = mkdtempSync(join(tmpdir(), "sensus-usage-all-"))
    try {
      const inst = join(dir, "sessions", "inst")
      mkdirSync(inst, { recursive: true })
      const write = (name: string, ts: number, prompt: number): void => {
        const events = [
          { ts, type: "user_message", content: name },
          { ts: ts + 1000, type: "assistant_message", content: "reply", model: "m", usage: { promptTokens: prompt, completionTokens: 0, totalTokens: prompt, cachedTokens: 0 }, aborted: false },
        ]
        writeFileSync(join(inst, `${name}.jsonl`), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8")
      }
      // An older day's sessions must not be crowded out by 55 newer ones.
      write("old", Date.parse("2026-01-01T12:00:00Z"), 100)
      for (let i = 0; i < 55; i += 1) write(`new-${i}`, Date.parse("2026-03-01T12:00:00Z") + i * 2000, 10)
      const text = usageReport(buildUsageReport(dir), { width: 60, height: 4 }).map(rowText)
      expect(text.some((l) => l.includes("2026-01-01"))).toBe(true)
      expect(text.some((l) => l.includes("2026-03-01"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("caps the roll-up at the 14 newest days with activity", () => {
    const dir = mkdtempSync(join(tmpdir(), "sensus-usage-window-"))
    try {
      const inst = join(dir, "sessions", "inst")
      mkdirSync(inst, { recursive: true })
      for (let i = 0; i < 20; i += 1) {
        const day = `2026-02-${String(i + 1).padStart(2, "0")}`
        const ts = Date.parse(`${day}T12:00:00Z`)
        const events = [
          { ts, type: "user_message", content: day },
          { ts: ts + 1000, type: "assistant_message", content: "reply", model: "m", usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100, cachedTokens: 0 }, aborted: false },
        ]
        writeFileSync(join(inst, `s-${i}.jsonl`), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8")
      }
      const all = usageReport(buildUsageReport(dir), { width: 60, height: 4 }).map(rowText)
      const dayAt = all.findIndex((l) => l.trimStart().startsWith("by day"))
      const sessionAt = all.findIndex((l) => l.trimStart().startsWith("by session"))
      const daySection = all.slice(dayAt, sessionAt).join("\n")
      expect(all.some((l) => l.includes("usage over the last 14 days"))).toBe(true)
      // Newest 14 days (02-07..02-20) survive; the six oldest drop off.
      expect(daySection).toContain("2026-02-20")
      expect(daySection).toContain("2026-02-07")
      expect(daySection).not.toContain("2026-02-06")
      expect(all.some((l) => l.includes("14 sessions"))).toBe(true)
      // ...but older sessions stay reachable in the (unwindowed) by-session list.
      expect(all.some((l) => l.includes("2026-02-06"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("paginates the by-session list so older sessions stay reachable", () => {
    const dir = mkdtempSync(join(tmpdir(), "sensus-usage-page-"))
    try {
      const inst = join(dir, "sessions", "inst")
      mkdirSync(inst, { recursive: true })
      for (let i = 0; i < 5; i += 1) {
        const day = `2026-04-${String(i + 1).padStart(2, "0")}`
        const ts = Date.parse(`${day}T12:00:00Z`)
        const events = [
          { ts, type: "user_message", content: `title-${i}` },
          { ts: ts + 1000, type: "assistant_message", content: "reply", model: "m", usage: { promptTokens: 100 - i, completionTokens: 0, totalTokens: 100 - i, cachedTokens: 0 }, aborted: false },
        ]
        writeFileSync(join(inst, `s-${i}.jsonl`), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8")
      }
      const page1 = usageReport(buildUsageReport(dir), { width: 60, height: 4, sessionLimit: 2 })
      expect(page1.filter((r) => r.sessionPath !== undefined)).toHaveLength(2)
      // The load-more row carries how many older sessions are still hidden.
      expect(page1.find((r) => r.loadMore !== undefined)?.loadMore).toBe(3)
      const text1 = page1.map(rowText).join("\n")
      expect(text1).toContain("2 of 5")
      expect(text1).toContain("3 older sessions")
      // A larger page (the UI's "load more") reveals the rest and drops the row.
      const page2 = usageReport(buildUsageReport(dir), { width: 60, height: 4, sessionLimit: 5 })
      expect(page2.filter((r) => r.sessionPath !== undefined)).toHaveLength(5)
      expect(page2.some((r) => r.loadMore !== undefined)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
