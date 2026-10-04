/**
 * No-egress guarantee (D8; docs/events.md "No egress"): with
 * `SENSUS_CONTROL_URL` unset there is ZERO outbound network. v1 ships no
 * forwarding path at all, so this test proves both halves:
 *
 *   1. a full headless turn (the offline MockProvider) with the daemon's
 *      default v1 JSONL event sink performs no `fetch` and no `Bun.connect`;
 *   2. no `src/**` file references `SENSUS_CONTROL_URL` at all — there is no
 *      forward that could be constructed/used when it IS set.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChatHost, JsonlEventSink, defaultConfig, type SensusConfig } from "../../../src/engine/index.ts"

const SRC = new URL("../../../src/", import.meta.url)

/** Every `.ts`/`.tsx` file under src/, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full)
  }
  return out
}

describe("no egress with SENSUS_CONTROL_URL unset (D8)", () => {
  test("no src file references SENSUS_CONTROL_URL (no forward path to construct)", () => {
    const hits: string[] = []
    for (const file of sourceFiles(SRC.pathname)) {
      if (readFileSync(file, "utf8").includes("SENSUS_CONTROL_URL")) hits.push(file)
    }
    expect(hits).toEqual([])
  })

  test("a full offline turn + the v1 sink call neither fetch nor Bun.connect", async () => {
    const prevControl = process.env["SENSUS_CONTROL_URL"]
    const prevDelay = process.env["SENSUS_MOCK_DELAY"]
    delete process.env["SENSUS_CONTROL_URL"]
    process.env["SENSUS_MOCK_DELAY"] = "0"

    const home = mkdtempSync(join(tmpdir(), "sensus-no-egress-"))
    const prevHome = process.env["SENSUS_HOME"]
    process.env["SENSUS_HOME"] = home

    const calls: unknown[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      calls.push(args[0])
      return Promise.reject(new Error("egress blocked by the no-egress test"))
    }) as typeof fetch
    // Bun.connect is overloaded; a loose cast is the only way to spy on it.
    const bun = Bun as unknown as { connect: (...a: unknown[]) => unknown }
    const origConnect = bun.connect
    bun.connect = (...a: unknown[]) => {
      calls.push(a[0])
      return origConnect(...a)
    }

    try {
      const cfg: SensusConfig = defaultConfig()
      cfg.endpoints["main"] = { ...cfg.endpoints["main"]!, provider: "mock", apiKey: "", maxTokens: 128 }
      cfg.model = "main@mock-model"
      cfg.titles.enabled = false

      const sink = new JsonlEventSink({ path: join(home, "data", "events.jsonl"), instanceId: "no-egress" })
      const host = new ChatHost({
        dataDir: join(home, "data"),
        instanceId: "no-egress",
        initialConfig: cfg,
        argv: [],
        toast: () => {},
        eventSinkFactory: () => sink,
      })
      const chat = host.createTabChat(1)
      chat.handleInput("plain:hello")
      const end = Date.now() + 8000
      while (chat.accessors.status() !== "idle" && Date.now() < end) await Bun.sleep(10)
      expect(chat.accessors.status()).toBe("idle")
      host.endTabChat(chat, "test")
      sink.flushSync()

      // The turn really ran and the local log really landed...
      expect(chat.accessors.messages().some((m) => m.role === "assistant" && m.content.length > 0)).toBe(true)
      const log = readFileSync(join(home, "data", "events.jsonl"), "utf8")
      expect(log).toContain("session.started")
      expect(log).toContain("turn.completed")
      // ...and nothing left the process.
      expect(calls).toEqual([])
    } finally {
      globalThis.fetch = origFetch
      bun.connect = origConnect
      if (prevHome === undefined) delete process.env["SENSUS_HOME"]
      else process.env["SENSUS_HOME"] = prevHome
      if (prevControl === undefined) delete process.env["SENSUS_CONTROL_URL"]
      else process.env["SENSUS_CONTROL_URL"] = prevControl
      if (prevDelay === undefined) delete process.env["SENSUS_MOCK_DELAY"]
      else process.env["SENSUS_MOCK_DELAY"] = prevDelay
      rmSync(home, { recursive: true, force: true })
    }
  })
})
