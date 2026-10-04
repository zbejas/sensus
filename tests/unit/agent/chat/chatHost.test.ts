import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChatHost, type ConfigChangeKind } from "../../../../src/agent/chat/chatHost.ts"
import { applyChatDisplayConfig } from "../../../../src/agent/chat/chatSession.ts"
import { defaultConfig, loadConfig } from "../../../../src/config/config.ts"
import { configureLogger, parseLogLine, type LogRecord } from "../../../../src/core/log.ts"
import type { SensusEvent } from "../../../../src/agent/extensions.ts"
import { sessionMetaPath } from "../../../../src/session/meta.ts"
import type { ChatProvider, StreamResult } from "../../../../src/agent/provider/provider.ts"
import { startMockOpenai, type MockOpenaiServer } from "../../../mocks/mockOpenai.ts"

async function until(f: () => boolean, ms = 5000, label = "condition"): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (f()) return
    await Bun.sleep(15)
  }
  throw new Error(`until(${label}) timed out`)
}

/** ChatHost is the single config-change seam: `onConfigChange` listeners fire
 * after every successful reload with an explicit kind. App registers ONE
 * listener whose body is the config-derived surface list (docs/config.md
 * "Live config reload"); the kind is what keeps internal reloads (model/agent
 * picks, MCP toggles, keymap edits, setup) from clobbering session-scoped
 * display overrides while user `/reload` and settings writes re-seed them
 * (Kaneo #25). loadConfig() here reads the caller's real config (argv is empty)
 * — fine: the assertions only depend on the reload succeeding and the config
 * object being swapped, not on its contents. */

// Test scratch root; create it so a fresh checkout can run this file alone.
mkdirSync("/tmp/sensus", { recursive: true })

const makeHost = (): ChatHost =>
  new ChatHost({
    dataDir: "/tmp/sensus/chathost-test",
    instanceId: "test",
    initialConfig: defaultConfig(),
    argv: [],
    toast: () => {},
  })

describe("ChatHost.onConfigChange (the single config-change seam)", () => {
  test("fires after the config swap with an explicit kind; unsubscribe + throwing listeners are safe", () => {
    const host = makeHost()
    const before = host.getConfig()
    const kinds: ConfigChangeKind[] = []
    const off = host.onConfigChange((kind) => {
      kinds.push(kind)
      // Fires AFTER this.config = next: the listener sees the new object.
      expect(host.getConfig()).not.toBe(before)
    })
    // Default = internal (a picker/MCP/keymap/setup reload re-reads config for
    // an unrelated reason).
    expect(host.reload()).not.toBeNull()
    // Explicit kinds: user (chat `/reload`, Ctrl+P, agent tool), settings (a
    // settings-screen write).
    expect(host.reload("user")).not.toBeNull()
    expect(host.reload("settings")).not.toBeNull()
    expect(kinds).toEqual(["internal", "user", "settings"])
    // Unsubscribing stops delivery.
    off()
    host.reload("user")
    expect(kinds).toEqual(["internal", "user", "settings"])
    // Every listener fires; a throwing one is contained and does not stop the rest.
    const throwing = makeHost()
    let other = 0
    throwing.onConfigChange(() => {
      throw new Error("boom")
    })
    throwing.onConfigChange(() => {
      other++
    })
    expect(throwing.reload()).not.toBeNull()
    expect(other).toBe(1)
    // No listener registered — reload works unchanged.
    expect(makeHost().reload()).not.toBeNull()
  })

  test("internal reloads leave session-scoped overrides; user /reload and settings writes re-seed (#25)", () => {
    const host = makeHost()
    const chat = host.createTabChat(1)
    // App's surface router contract: re-seed every open tab for user/settings
    // only. This mirrors `applyConfigChange` in App.tsx.
    host.onConfigChange((kind) => {
      if (kind === "internal") return
      applyChatDisplayConfig(chat, host.getConfig().chat)
    })
    // A session-scoped display toggle (Alt+C / `/cards`) overrides the config.
    chat.toggleCardStyle() // "fill" -> "border"
    expect(chat.accessors.cardStyle()).toBe("border")
    // Internal reload (e.g. a model pick) must NOT clobber it.
    expect(host.reload()).not.toBeNull()
    expect(chat.accessors.cardStyle()).toBe("border")
    // A user reload re-seeds from config (the default "fill").
    expect(host.reload("user")).not.toBeNull()
    expect(chat.accessors.cardStyle()).toBe("fill")
    // A settings write re-seeds too.
    chat.toggleCardStyle()
    expect(chat.accessors.cardStyle()).toBe("border")
    expect(host.reload("settings")).not.toBeNull()
    expect(chat.accessors.cardStyle()).toBe("fill")
  })

  test("the chat `/reload` slash command arrives as user kind (the agent tool shares the dep)", () => {
    const host = makeHost()
    const kinds: ConfigChangeKind[] = []
    host.onConfigChange((kind) => kinds.push(kind))
    // `/reload` and the agent's `reload` tool both go through the session's
    // `reloadConfig` dep, which the host wires to `reload("user")`.
    host.createTabChat(1).handleInput("/reload")
    expect(kinds).toEqual(["user"])
  })
})

describe("ChatHost extensions seam (docs/extensions.md)", () => {
  test("createTabChat emits session-start; reload rebuilds the sink; a throwing factory degrades to the no-op defaults", () => {
    const lines: string[] = []
    configureLogger({ level: "debug", sink: (line) => lines.push(line) })
    try {
      const events: SensusEvent[] = []
      const host = new ChatHost({
        dataDir: "/tmp/sensus/chathost-ext-test",
        instanceId: "inst-ext",
        initialConfig: defaultConfig(),
        argv: [],
        toast: () => {},
        eventSinkFactory: () => ({ emit: (e) => events.push(e) }),
        approvalPolicyFactory: () => null,
      })
      const chat1 = host.createTabChat(1)
      host.createTabChat(2)
      const starts = events.filter((e) => e.type === "session-start")
      expect(starts).toHaveLength(2)
      const start = starts[0]
      if (start?.type === "session-start") {
        expect(start.session).toBe("inst-ext")
        expect(start.resumed).toBe(false)
        expect(start.agent).toBe("copilot")
      }
      // Releasing a tab records the matching `session ended` + reason.
      host.endTabChat(chat1, "shutdown")
      // The same lifecycle is recorded as structured activity (docs/logging.md).
      const recs = lines.map((l) => parseLogLine(l)).filter((r): r is LogRecord => r !== null)
      const startedRecs = recs.filter(
        (r) => r.msg === "session started" && r.attributes?.["session"] === "inst-ext",
      )
      expect(startedRecs).toHaveLength(2)
      expect(startedRecs[0]?.level).toBe("info")
      expect(startedRecs[0]?.component).toBe("agent.chat")
      expect(startedRecs[0]?.attributes?.["tab"]).toBe(1)
      expect(startedRecs[0]?.attributes?.["resumed"]).toBe(false)
      const ended = recs.find((r) => r.msg === "session ended" && r.attributes?.["session"] === "inst-ext")
      expect(ended?.level).toBe("info")
      expect(ended?.attributes?.["reason"]).toBe("shutdown")
      expect(events.some((e) => e.type === "session-end" && e.reason === "shutdown")).toBe(true)

      // /reload rebuilds the sink through the factory without throwing.
      expect(host.reload("user")).not.toBeNull()

      // A throwing factory must degrade to the no-op default, never fail boot.
      const bad = new ChatHost({
        dataDir: "/tmp/sensus/chathost-ext-bad",
        instanceId: "inst-bad",
        initialConfig: defaultConfig(),
        argv: [],
        toast: () => {},
        eventSinkFactory: () => {
          throw new Error("boom")
        },
      })
      expect(() => bad.createTabChat(1)).not.toThrow()
    } finally {
      configureLogger({ level: "error", sink: () => {} })
    }
  })
})

describe("ChatHost session titles (docs/sessions.md \"Auto titles\")", () => {
  test("first prompt generates a title via the selected model and writes the sidecar", async () => {
    const home = mkdtempSync(join(tmpdir(), "sensus-chathost-title-"))
    const prevHome = process.env["SENSUS_HOME"]
    process.env["SENSUS_HOME"] = home
    try {
      const cfg = defaultConfig()
      cfg.endpoints["main"] = { ...cfg.endpoints["main"]!, provider: "mock", apiKey: "test-key" }
      const host = new ChatHost({
        dataDir: join(home, "data"),
        instanceId: "inst",
        initialConfig: cfg,
        argv: [],
        toast: () => {},
      })
      const chat = host.createTabChat(1)
      chat.handleInput("help me deploy the alpha service tonight")
      await until(() => chat.accessors.status() === "idle", 8000, "idle")
      const metaPath = sessionMetaPath(chat.sessionFilePath ?? "")
      await until(() => {
        try {
          return readFileSync(metaPath, "utf8").includes("title")
        } catch {
          return false
        }
      }, 8000, "title sidecar")
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { title?: string }
      const generated = meta.title ?? ""
      expect(typeof meta.title).toBe("string")
      expect(generated.length).toBeGreaterThan(0)
      expect(generated.split(/\s+/).length).toBeLessThanOrEqual(10)
      // The generated title is pushed onto the session for the tab title.
      await until(() => chat.accessors.sessionTitle() === generated, 4000, "session title signal")
      expect(chat.accessors.sessionTitle()).toBe(generated)
    } finally {
      if (prevHome === undefined) delete process.env["SENSUS_HOME"]
      else process.env["SENSUS_HOME"] = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("ChatHost model selection is per-session (docs/config.md)", () => {
  test("a pick persists the new default for NEW sessions but never yanks an open tab's model", () => {
    const home = mkdtempSync(join(tmpdir(), "sensus-chathost-model-"))
    const prevHome = process.env["SENSUS_HOME"]
    process.env["SENSUS_HOME"] = home
    try {
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({
          model: "main@plain-model",
          endpoints: {
            main: { baseURL: "http://127.0.0.1:1/v1", apiKey: "k" },
            alt: { baseURL: "http://127.0.0.1:1/v1", apiKey: "k" },
          },
        }),
      )
      const host = new ChatHost({
        dataDir: join(home, "data"),
        instanceId: "inst",
        initialConfig: loadConfig([]),
        argv: [],
        toast: () => {},
      })
      const a = host.createTabChat(1)
      const b = host.createTabChat(2)
      expect(a.selectedModel()).toBe("main@plain-model")
      expect(b.selectedModel()).toBe("main@plain-model")
      // The picker path: persist the default for NEW sessions, then apply the
      // pick to THIS session (the daemon's `chat.setModel` does the same).
      expect(host.setSelectedModel("alt", "alt-model")).toBeNull()
      a.setModelSelection("alt", "alt-model")
      expect(a.selectedModel()).toBe("alt@alt-model")
      expect(b.selectedModel()).toBe("main@plain-model") // sibling untouched
      expect(host.createTabChat(3).selectedModel()).toBe("alt@alt-model") // new default
    } finally {
      if (prevHome === undefined) delete process.env["SENSUS_HOME"]
      else process.env["SENSUS_HOME"] = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("ChatHost provider credential invalidation", () => {  let server: MockOpenaiServer

  beforeAll(async () => {
    server = await startMockOpenai({ validApiKeys: ["fresh-key"] })
  })

  afterAll(async () => {
    await server.close()
  })

  /** Reach the memoized provider the way ChatSession does (per request). */
  const providerOf = (host: ChatHost, name: string): ChatProvider =>
    (host as unknown as { provider(n: string): ChatProvider }).provider(name)

  const stream = (p: ChatProvider): Promise<StreamResult> =>
    p.stream(
      { model: "plain-model", messages: [{ role: "user", content: "hi" }] },
      { onDelta: () => {} },
      new AbortController().signal,
    )

  test("a corrected key takes effect on the next request (settings save / /reload), unchanged config reuses the client", async () => {
    const cfg = defaultConfig()
    cfg.endpoints["main"] = { ...cfg.endpoints["main"]!, baseURL: server.url, apiKey: "stale-key", maxTokens: 128 }
    const host = new ChatHost({
      dataDir: "/tmp/sensus/chathost-provider",
      instanceId: "test",
      initialConfig: cfg,
      argv: [],
      toast: () => {},
    })

    // Boot with the wrong key: the first request 401s and the client is cached.
    const p1 = providerOf(host, "main")
    const failed = await stream(p1)
    expect(failed.finish).toBe("error")
    expect(failed.error).toContain("401")
    // Nothing changed: the memo is reused rather than rebuilding per request.
    expect(providerOf(host, "main")).toBe(p1)

    // /reload swaps in a config whose endpoint carries the corrected key
    // (Settings save + pickers go through the same path). The next request
    // must use it without a process restart.
    host.getConfig().endpoints["main"]!.apiKey = "fresh-key"
    const p2 = providerOf(host, "main")
    expect(p2).not.toBe(p1)
    const ok = await stream(p2)
    expect(ok.finish).toBe("stop")
    expect(ok.error).toBeNull()
  })
})

describe("ChatHost no-tools latch is per session (shared memoized provider)", () => {
  let server: MockOpenaiServer

  beforeAll(async () => {
    server = await startMockOpenai()
  })
  afterAll(async () => {
    await server.close()
  })

  test("a tools-rejection in one tab does not disable tools for a sibling tab", async () => {
    const home = mkdtempSync(join(tmpdir(), "sensus-chathost-notools-"))
    try {
      const cfg = defaultConfig()
      cfg.endpoints["main"] = { ...cfg.endpoints["main"]!, baseURL: server.url, apiKey: "k", maxTokens: 128 }
      cfg.model = "main@plain-model"
      cfg.titles.enabled = false
      const host = new ChatHost({
        dataDir: join(home, "data"),
        instanceId: "inst",
        initialConfig: cfg,
        argv: [],
        toast: () => {},
      })
      const a = host.createTabChat(1)
      const b = host.createTabChat(2)
      a.setModelSelection("main", "notools-model")
      b.setModelSelection("main", "plain-model")

      // Session A: the endpoint rejects tools -> A latches no-tools.
      a.handleInput("hello from a")
      await until(() => a.accessors.status() === "idle", 8000, "a idle")
      expect(a.accessors.noTools()).toBe(true)
      const aHits = server.requests.filter((r) => r.model === "notools-model")
      expect(aHits[0]?.hasTools).toBe(true) // original request carried tools
      expect(aHits[1]?.hasTools).toBe(false) // immediate tool-less retry

      // Session B shares the SAME memoized provider but must still send tools.
      b.handleInput("plain: sibling reply")
      await until(() => b.accessors.status() === "idle", 8000, "b idle")
      expect(b.accessors.noTools()).toBe(false)
      const bHits = server.requests.filter((r) => r.model === "plain-model")
      expect(bHits.at(-1)?.hasTools).toBe(true)

      // Session A's latch is still intact for its own later requests.
      a.handleInput("plain: follow up")
      await until(() => a.accessors.status() === "idle", 8000, "a idle 2")
      const aHits2 = server.requests.filter((r) => r.model === "notools-model")
      expect(aHits2.at(-1)?.hasTools).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("ChatHost.sessionContextBreakdown (saved-session Context inspector)", () => {
  test("persisted tool calls render on their turn instead of (empty); tokens include tool overhead", () => {
    const home = mkdtempSync(join(tmpdir(), "sensus-chathost-ctx-"))
    try {
      const path = join(home, "tab-1.jsonl")
      const lines = [
        { ts: 1, type: "session_start", sensus: "sensus", endpoint: "main", model: "gpt-5" },
        { ts: 2, type: "user_message", content: "clean /tmp" },
        // Dropped assistant bubble (reasoning only) with two persisted calls.
        { ts: 3, type: "assistant_message", content: "", thinking: "reasoning", model: "gpt-5", usage: null, aborted: false },
        { ts: 4, type: "tool_call", callId: "c1", name: "run_command", paramsSummary: "du -sh /tmp", status: "done", output: null, exitCode: 0 },
        { ts: 5, type: "tool_call", callId: "c2", name: "run_command", paramsSummary: "rm -rf x", status: "done", output: null, exitCode: 0 },
        { ts: 6, type: "assistant_message", content: "Done — freed some space.", model: "gpt-5", usage: null, aborted: false },
      ]
      writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
      const out = makeHost().sessionContextBreakdown(path)
      expect(out).not.toBeNull()
      const history = out!.breakdown.history
      expect(history.map((e) => e.preview)).toEqual(["clean /tmp", "→ run_command ×2", "Done — freed some space."])
      expect(history.some((e) => e.preview === "(empty)")).toBe(false)
      // The tool-call turn carries the call overhead, not just the 4-token shell.
      const callEntry = history.find((e) => e.preview.includes("→ run_command"))
      expect(callEntry?.tokens).toBeGreaterThan(4)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("ChatHost instructions (docs/config.md 'instructions')", () => {
  test("/reload re-resolves the config `instructions` list and re-reads the files", () => {
    const home = mkdtempSync(join(tmpdir(), "sensus-chathost-instr-"))
    const prevHome = process.env["SENSUS_HOME"]
    process.env["SENSUS_HOME"] = home
    try {
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({
          model: "main@gpt-5",
          endpoints: { main: { baseURL: "https://api.openai.com/v1", apiKey: "" } },
          instructions: ["AGENTS.extra.md"],
        }),
      )
      writeFileSync(join(home, "AGENTS.extra.md"), "FIRST-VERSION")
      const host = new ChatHost({
        dataDir: join(home, "data"),
        instanceId: "inst",
        initialConfig: defaultConfig(),
        argv: [],
        toast: () => {},
      })
      // /reload reads the sandbox config + re-resolves instruction files
      // (relative entry falls back to the config dir).
      expect(host.reload()).not.toBeNull()
      expect(host.getConfig().instructions).toEqual(["AGENTS.extra.md"])
      expect(host.getInstructions()).toContain("FIRST-VERSION")
      // Editing the file and reloading picks up the new body.
      writeFileSync(join(home, "AGENTS.extra.md"), "SECOND-VERSION")
      host.reload()
      expect(host.getInstructions()).toContain("SECOND-VERSION")
      expect(host.getInstructions()).not.toContain("FIRST-VERSION")
    } finally {
      if (prevHome === undefined) delete process.env["SENSUS_HOME"]
      else process.env["SENSUS_HOME"] = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})
