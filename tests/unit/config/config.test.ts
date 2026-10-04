import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  activeEndpoint,
  activeEndpointName,
  activeModelId,
  configPath,
  defaultConfig,
  loadConfig,
  parseArgs,
  parseSelectedModel,
  resolveConfig,
  sensusCacheDir,
  sensusDataDir,
  sensusHome,
  sensusRuntimeDirFrom,
  selectedModelString,
  starterConfigDoc,
  sensusHomeFrom,
  validateBaseURL,
  SIDEBAR_DEFAULT_WIDTH,
  type SensusConfig,
} from "../../../src/config/config.ts"

/** Non-null endpoint accessor (endpoints are keyed records under strict mode). */
const ep = (c: SensusConfig, n = "main") => c.endpoints[n]!

function makeEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: "/nonexistent-home",
    SHELL: "/bin/bash",
    PATH: process.env["PATH"] ?? "/usr/bin",
    ...extra,
  }
}

function sandbox(): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "sensus-config-"))
  const env = makeEnv({ SENSUS_HOME: dir })
  return { dir, env }
}

function writeConfig(dir: string, data: unknown): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify(data, null, 2))
}

/** Run `fn` with a config file written to a fresh sandbox; cleaned up after.
 * Tests resolve through `resolve` so the sandbox file is always the one read. */
function withConfigFile(data: unknown, fn: (resolve: (env?: Record<string, string>) => SensusConfig) => void): void {
  const { dir, env } = sandbox()
  try {
    if (data !== null) writeConfig(dir, data)
    fn((extraEnv = {}) => resolveConfig([], { ...env, ...extraEnv }, configPath(dir)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("config resolution", () => {
  test("parseArgs: space/= forms, sidebar-width, unknown flags ignored, empty argv safe", () => {
    const a = parseArgs(["--model", "gpt-x", "--base-url=http://x/v1", "--yolo", "--resume"])
    expect(a.model).toBe("gpt-x")
    expect(a.baseURL).toBe("http://x/v1")
    expect(a.yolo).toBe(true)
    expect(a.resume).toBe(true)

    const side = parseArgs(["--sidebar-width", "44"])
    expect(side.sidebarWidth).toBe(44)

    const unknown = parseArgs(["--wat", "1", "--other"])
    expect(unknown.model).toBeUndefined()
    expect(unknown.yolo).toBe(false)

    expect(parseArgs([])).toEqual({ resume: false, yolo: false })
  })

  test("starterConfigDoc + sensusHomeFrom: the scaffold matches the resolver's defaults and honors SENSUS_HOME", () => {
    // The starter file resolves to exactly the built-in defaults (a starter
    // document that drifts from defaultConfig() would lie to new users).
    const doc = starterConfigDoc() as {
      model: string
      endpoints: Record<string, { baseURL?: string; apiKey?: string }>
      agent: string
      approval: string
    }
    const d = defaultConfig()
    expect(doc.model).toBe(d.model)
    expect(doc.endpoints["main"]?.baseURL).toBe(d.endpoints["main"]?.baseURL)
    expect(doc.endpoints["main"]?.apiKey).toBe("")
    expect(doc.agent).toBe(d.defaultAgent)
    expect(doc.approval).toBe(d.approval)
    // And the resolver accepts the scaffolded document verbatim, no warnings.
    const { dir, env } = sandbox()
    try {
      writeFileSync(join(dir, "config.json"), JSON.stringify(doc, null, 2))
      const c = resolveConfig([], env, configPath(dir))
      expect(c.warnings).toEqual([])
      expect(c.model).toBe(d.model)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    // sensusHomeFrom mirrors sensusHome()'s SENSUS_HOME redirect for an injected env.
    expect(sensusHomeFrom({ SENSUS_HOME: "/s", HOME: "/h" })).toBe("/s")
    expect(sensusHomeFrom({ HOME: "/h" })).toBe("/h/.config/sensus")
  })

  test("defaults: the built-in config is complete (no themePalette, no mcp servers)", () => {
    const c = defaultConfig()
    // The terminal pane is the centerpiece: the chat must not claim the
    // majority of a common desktop window (see SIDEBAR_DEFAULT_WIDTH).
    expect(c.sidebarWidth).toBe(50)
    expect(c.sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH)
    expect(c.approval).toBe("confirm")
    expect(c.defaultAgent).toBe("copilot")
    expect(c.allowPrefixes).toEqual([])
    expect(c.permission).toEqual([])
    expect(c.instructions).toEqual([])
    expect(c.shell.length).toBeGreaterThan(0)
    expect(c.themePalette).toBeNull()
    expect(Object.keys(c.mcp.servers)).toEqual([])
    expect(c.chat.maxToolTurns).toBeNull()
    expect(c.extensions).toEqual({ approvalPolicy: { kind: "default" }, eventSink: { kind: "noop" } })
    expect(ep(c)).toMatchObject({ baseURL: "https://api.openai.com/v1", apiKey: "" })
    expect(c.model).toBe("main@gpt-5")
    expect(activeEndpointName(c)).toBe("main")
    expect(activeModelId(c)).toBe("gpt-5")
    expect(c.context).toEqual({
      scrollbackLines: 100,
      enabled: true,
      autoCompact: true,
      keepTokens: 15_000,
      bufferTokens: 20_000,
      contextLimit: 0,
    })
  })

  test("context section: values parse; invalid ones warn and keep defaults (0 = unlimited/auto, null normalized)", () => {
    withConfigFile({
      context: {
        scrollbackLines: 40,
        autoCompact: false,
        keepTokens: 8000,
        bufferTokens: 5000,
        contextLimit: 32_000,
      },
    }, (resolve) => {
      const c = resolve()
      expect(c.context).toEqual({
        scrollbackLines: 40,
        enabled: true,
        autoCompact: false,
        keepTokens: 8000,
        bufferTokens: 5000,
        contextLimit: 32_000,
      })
    })

    withConfigFile({ context: { autoCompact: false, keepTokens: -5, bufferTokens: "x", contextLimit: null } }, (resolve) => {
      const c = resolve()
      expect(c.context.autoCompact).toBe(false)
      expect(c.context.keepTokens).toBe(15_000)
      expect(c.context.bufferTokens).toBe(20_000)
      // Explicit null (legacy) and a missing key both mean unlimited/auto (0).
      expect(c.context.contextLimit).toBe(0)
      // Out-of-range numbers warn; wrong-typed values are silently ignored
      // (same policy as enabled/scrollbackLines).
      expect(c.warnings.some((w) => w.includes("keepTokens"))).toBe(true)
    })

    // Explicit 0 is the documented default ("unlimited"/auto), not an error.
    withConfigFile({ context: { contextLimit: 0 } }, (resolve) => {
      const c = resolve()
      expect(c.context.contextLimit).toBe(0)
      expect(c.warnings.some((w) => w.includes("contextLimit"))).toBe(false)
    })

    // A negative limit is invalid — warn and keep the default (0).
    withConfigFile({ context: { contextLimit: -1 } }, (resolve) => {
      const c = resolve()
      expect(c.context.contextLimit).toBe(0)
      expect(c.warnings.some((w) => w.includes("contextLimit"))).toBe(true)
    })
  })

  test("chat section: maxToolTurns parses a positive number, explicit null = no cap; invalid warns + keeps the default", () => {
    withConfigFile({ chat: { maxToolTurns: 100 } }, (resolve) => {
      expect(resolve().chat.maxToolTurns).toBe(100)
    })
    withConfigFile({ chat: { maxToolTurns: null } }, (resolve) => {
      expect(resolve().chat.maxToolTurns).toBeNull()
    })
    withConfigFile({ chat: { maxToolTurns: 0 } }, (resolve) => {
      const c = resolve()
      expect(c.chat.maxToolTurns).toBeNull()
      expect(c.warnings.some((w) => w.includes("maxToolTurns"))).toBe(true)
    })
  })

  test("chat section: cardStyle selects fill or border (default); invalid warns + keeps the default", () => {
    withConfigFile({}, (resolve) => {
      expect(resolve().chat.cardStyle).toBe("fill")
    })
    withConfigFile({ chat: { cardStyle: "border" } }, (resolve) => {
      expect(resolve().chat.cardStyle).toBe("border")
    })
    withConfigFile({ chat: { cardStyle: "nope" } }, (resolve) => {
      const c = resolve()
      expect(c.chat.cardStyle).toBe("fill")
      expect(c.warnings.some((w) => w.includes("cardStyle"))).toBe(true)
    })
  })

  test("layout + tabs.width + autoChatOnly: parse; invalid values warn and keep defaults", () => {
    // Defaults: the sidebar rail + a 24-column rail + the auto chat-only view on.
    expect(defaultConfig().layout).toBe("sidebar")
    expect(defaultConfig().tabRailWidth).toBe(24)
    expect(defaultConfig().autoChatOnly).toBe(true)

    withConfigFile({ layout: "sidebar", tabs: { width: 30 }, autoChatOnly: false }, (resolve) => {
      const c = resolve()
      expect(c.layout).toBe("sidebar")
      expect(c.tabRailWidth).toBe(30)
      expect(c.autoChatOnly).toBe(false)
      expect(c.warnings.filter((w) => w.includes("layout") || w.includes("tabs") || w.includes("autoChatOnly"))).toEqual([])
    })

    // A finite width in range floors.
    withConfigFile({ tabs: { width: 30.9 } }, (resolve) => {
      expect(resolve().tabRailWidth).toBe(30)
    })

    // An invalid layout string warns and falls back to sidebar.
    withConfigFile({ layout: "bogus" }, (resolve) => {
      const c = resolve()
      expect(c.layout).toBe("sidebar")
      expect(c.warnings.some((w) => w.includes("layout must be"))).toBe(true)
    })

    // A non-boolean autoChatOnly warns and keeps the default (on).
    withConfigFile({ autoChatOnly: "yes" }, (resolve) => {
      const c = resolve()
      expect(c.autoChatOnly).toBe(true)
      expect(c.warnings.some((w) => w.includes("autoChatOnly must be a boolean"))).toBe(true)
    })

    // An out-of-range tabs.width warns and falls back to 24.
    withConfigFile({ tabs: { width: 4 } }, (resolve) => {
      const c = resolve()
      expect(c.tabRailWidth).toBe(24)
      expect(c.warnings.some((w) => w.includes("tabs.width must be a number 16-60"))).toBe(true)
    })

    // Unknown keys inside tabs warn; a non-object tabs warns and is ignored.
    withConfigFile({ tabs: { extra: true } }, (resolve) => {
      expect(resolve().warnings.some((w) => w.includes('tabs has unknown key "extra"'))).toBe(true)
    })
    withConfigFile({ tabs: "nope" }, (resolve) => {
      const c = resolve()
      expect(c.tabRailWidth).toBe(24)
      expect(c.warnings.some((w) => w.includes("tabs must be an object"))).toBe(true)
    })
  })

  test("daemonPersistent: file flag + SENSUS_DAEMON_PERSISTENT override; invalid warns", () => {
    expect(defaultConfig().daemonPersistent).toBe(false)
    withConfigFile({ daemonPersistent: true }, (resolve) => {
      const c = resolve()
      expect(c.daemonPersistent).toBe(true)
      expect(c.warnings.filter((w) => w.includes("daemonPersistent"))).toEqual([])
    })
    // The env truthy spelling turns it on even when the file says otherwise.
    withConfigFile({ daemonPersistent: false }, (resolve) => {
      expect(resolve({ SENSUS_DAEMON_PERSISTENT: "1" }).daemonPersistent).toBe(true)
      expect(resolve({ SENSUS_DAEMON_PERSISTENT: "0" }).daemonPersistent).toBe(false)
    })
    // A non-boolean file value and an unparseable env value warn and keep default.
    withConfigFile({ daemonPersistent: "yes" }, (resolve) => {
      const c = resolve({ SENSUS_DAEMON_PERSISTENT: "maybe" })
      expect(c.daemonPersistent).toBe(false)
      expect(c.warnings.some((w) => w.includes("daemonPersistent must be a boolean"))).toBe(true)
      expect(c.warnings.some((w) => w.includes("SENSUS_DAEMON_PERSISTENT"))).toBe(true)
    })
  })

  test("updateCheck: on by default, file flag + SENSUS_UPDATE_CHECK override; invalid warns", () => {
    expect(defaultConfig().updateCheck).toBe(true)
    withConfigFile({ updateCheck: false }, (resolve) => {
      const c = resolve()
      expect(c.updateCheck).toBe(false)
      expect(c.warnings.filter((w) => w.includes("updateCheck"))).toEqual([])
    })
    // The env truthy spelling turns it on even when the file says otherwise.
    withConfigFile({ updateCheck: true }, (resolve) => {
      expect(resolve({ SENSUS_UPDATE_CHECK: "0" }).updateCheck).toBe(false)
      expect(resolve({ SENSUS_UPDATE_CHECK: "false" }).updateCheck).toBe(false)
      expect(resolve({ SENSUS_UPDATE_CHECK: "1" }).updateCheck).toBe(true)
    })
    // A non-boolean file value and an unparseable env value warn and keep default.
    withConfigFile({ updateCheck: "yes" }, (resolve) => {
      const c = resolve({ SENSUS_UPDATE_CHECK: "maybe" })
      expect(c.updateCheck).toBe(true)
      expect(c.warnings.some((w) => w.includes("updateCheck must be a boolean"))).toBe(true)
      expect(c.warnings.some((w) => w.includes("SENSUS_UPDATE_CHECK"))).toBe(true)
    })
  })

  test("titles section: enabled + model parse; invalid values warn and keep defaults", () => {
    withConfigFile({ titles: { enabled: false, model: " ollama@llama3 " } }, (resolve) => {
      const c = resolve()
      expect(c.titles).toEqual({ enabled: false, model: "ollama@llama3" })
    })
    withConfigFile({ titles: { enabled: "yes", model: 42 } }, (resolve) => {
      const c = resolve()
      expect(c.titles).toEqual(defaultConfig().titles)
      expect(c.warnings.some((w) => w.includes("titles.enabled"))).toBe(true)
      expect(c.warnings.some((w) => w.includes("titles.model"))).toBe(true)
    })
    withConfigFile({ titles: { extra: 1 } }, (resolve) => {
      expect(resolve().warnings.some((w) => w.includes('titles has unknown key "extra"'))).toBe(true)
    })
  })

  test("memory section: caps/policy parse; invalid values warn and keep defaults", () => {
    withConfigFile({
      memory: {
        enabled: true,
        memoryCharLimit: 1500,
        hostCharLimit: 3000,
        journalCharLimit: 6000,
        writeApproval: true,
        consolidateAtPercent: 70,
        redactSecrets: false,
      },
    }, (resolve) => {
      const c = resolve()
      expect(c.memory).toEqual({
        enabled: true,
        memoryCharLimit: 1500,
        hostCharLimit: 3000,
        journalCharLimit: 6000,
        writeApproval: true,
        consolidateAtPercent: 70,
        redactSecrets: false,
      })
    })

    withConfigFile({ memory: { memoryCharLimit: -1, consolidateAtPercent: 0, extra: true } }, (resolve) => {
      const c = resolve()
      expect(c.memory.memoryCharLimit).toBe(2200)
      expect(c.memory.consolidateAtPercent).toBe(80)
      expect(c.warnings.some((w) => w.includes("memory.memoryCharLimit"))).toBe(true)
      expect(c.warnings.some((w) => w.includes("memory.consolidateAtPercent"))).toBe(true)
      expect(c.warnings.some((w) => w.includes('memory has unknown key "extra"'))).toBe(true)
    })

    withConfigFile({ memory: "nope" }, (resolve) => {
      const c = resolve()
      expect(c.memory.enabled).toBe(true)
      expect(c.warnings.some((w) => w.includes("memory must be an object"))).toBe(true)
    })

    expect(defaultConfig().memory).toEqual({
      enabled: true,
      memoryCharLimit: 2200,
      hostCharLimit: 4000,
      journalCharLimit: 8000,
      writeApproval: false,
      consolidateAtPercent: 80,
      redactSecrets: true,
    })
  })

  test("tool_output section: defaults, valid override, invalid/unknown keys warn and keep defaults", () => {
    expect(defaultConfig().toolOutput).toEqual({ maxLines: 2000, maxBytes: 51200 })

    withConfigFile({ tool_output: { max_lines: 500, max_bytes: 2048 } }, (resolve) => {
      const c = resolve()
      expect(c.toolOutput).toEqual({ maxLines: 500, maxBytes: 2048 })
      expect(c.warnings.filter((w) => w.includes("tool_output"))).toEqual([])
    })

    withConfigFile({ tool_output: { max_lines: -1, max_bytes: "big", extra: true } }, (resolve) => {
      const c = resolve()
      expect(c.toolOutput).toEqual({ maxLines: 2000, maxBytes: 51200 })
      expect(c.warnings.some((w) => w.includes("tool_output.max_lines"))).toBe(true)
      expect(c.warnings.some((w) => w.includes("tool_output.max_bytes"))).toBe(true)
      expect(c.warnings.some((w) => w.includes('tool_output has unknown key "extra"'))).toBe(true)
    })

    withConfigFile({ tool_output: "nope" }, (resolve) => {
      const c = resolve()
      expect(c.toolOutput).toEqual({ maxLines: 2000, maxBytes: 51200 })
      expect(c.warnings.some((w) => w.includes("tool_output must be an object"))).toBe(true)
    })
  })

  test("permission section: valid rules parse; bad/unknown entries are skipped with warnings", () => {
    expect(defaultConfig().permission).toEqual([])

    withConfigFile({
      permission: [
        { tool: "*", action: "allow" },
        { tool: "shell_background", pattern: "git *", action: "ask" },
        { tool: "edit_file", action: "deny" },
      ],
    }, (resolve) => {
      const c = resolve()
      expect(c.permission).toEqual([
        { tool: "*", action: "allow" },
        { tool: "shell_background", pattern: "git *", action: "ask" },
        { tool: "edit_file", action: "deny" },
      ])
      expect(c.warnings.filter((w) => w.includes("permission"))).toEqual([])
    })

    // Non-object entries, missing tool, and bad actions are skipped; unknown
    // rule keys and a bad pattern warn but keep the rule.
    withConfigFile({
      permission: [
        42,
        { action: "allow" },
        { tool: "ls", action: "maybe" },
        { tool: "cat", action: "allow", extra: true, pattern: "" },
      ],
    }, (resolve) => {
      const c = resolve()
      expect(c.permission).toEqual([{ tool: "cat", action: "allow" }])
      const w = c.warnings.join("\n")
      expect(w).toContain("permission[0] must be an object")
      expect(w).toContain("permission[1].tool")
      expect(w).toContain("permission[2].action")
      expect(w).toContain('permission[3] has unknown key "extra"')
      expect(w).toContain("permission[3].pattern")
    })

    withConfigFile({ permission: "nope" }, (resolve) => {
      const c = resolve()
      expect(c.permission).toEqual([])
      expect(c.warnings.some((w) => w.includes("permission must be an array"))).toBe(true)
    })
  })

  test("instructions section: string entries kept; non-strings/empty warned and dropped", () => {
    expect(defaultConfig().instructions).toEqual([])

    withConfigFile({
      instructions: ["AGENTS.extra.md", "~/notes/*.md", "https://example.test/rules.md"],
    }, (resolve) => {
      const c = resolve()
      expect(c.instructions).toEqual(["AGENTS.extra.md", "~/notes/*.md", "https://example.test/rules.md"])
      expect(c.warnings.filter((w) => w.includes("instructions"))).toEqual([])
    })

    withConfigFile({ instructions: [42, "", "  ", "guides/GUIDE.md", null] }, (resolve) => {
      const c = resolve()
      expect(c.instructions).toEqual(["guides/GUIDE.md"])
      const w = c.warnings.join("\n")
      expect(w).toContain("instructions has 4 non-string/empty entries — dropped")
    })

    withConfigFile({ instructions: "nope" }, (resolve) => {
      const c = resolve()
      expect(c.instructions).toEqual([])
      expect(c.warnings.some((w) => w.includes("instructions must be an array"))).toBe(true)
    })
  })

  test("compaction section: prune/tail_turns parse; aliases override context; invalid/unknown warn", () => {
    expect(defaultConfig().compaction).toEqual({ prune: false, tailTurns: 0 })

    // OpenCode names. context.* is parsed first, compaction.* overrides it.
    withConfigFile({
      context: { autoCompact: false, keepTokens: 8000, bufferTokens: 5000 },
      compaction: { auto: true, prune: true, tail_turns: 3, preserve_recent_tokens: 12000, reserved: 9000 },
    }, (resolve) => {
      const c = resolve()
      expect(c.compaction).toEqual({ prune: true, tailTurns: 3 })
      expect(c.context.autoCompact).toBe(true) // compaction.auto overrides autoCompact
      expect(c.context.keepTokens).toBe(12000) // preserve_recent_tokens overrides keepTokens
      expect(c.context.bufferTokens).toBe(9000) // reserved overrides bufferTokens
      expect(c.warnings.filter((w) => w.includes("compaction"))).toEqual([])
    })

    // tail_turns accepts 0 (off, the default) explicitly.
    withConfigFile({ compaction: { tail_turns: 0 } }, (resolve) => {
      expect(resolve().compaction.tailTurns).toBe(0)
    })

    // Invalid + unknown keys warn and keep the defaults.
    withConfigFile({
      compaction: { prune: "yes", tail_turns: -1, auto: 1, preserve_recent_tokens: 0, reserved: -1, extra: true },
    }, (resolve) => {
      const c = resolve()
      expect(c.compaction).toEqual({ prune: false, tailTurns: 0 })
      expect(c.warnings.some((w) => w.includes("compaction.prune"))).toBe(true)
      expect(c.warnings.some((w) => w.includes("compaction.tail_turns"))).toBe(true)
      expect(c.warnings.some((w) => w.includes("compaction.auto"))).toBe(true)
      expect(c.warnings.some((w) => w.includes("compaction.preserve_recent_tokens"))).toBe(true)
      expect(c.warnings.some((w) => w.includes("compaction.reserved"))).toBe(true)
      expect(c.warnings.some((w) => w.includes('compaction has unknown key "extra"'))).toBe(true)
    })

    withConfigFile({ compaction: "nope" }, (resolve) => {
      const c = resolve()
      expect(c.compaction).toEqual({ prune: false, tailTurns: 0 })
      expect(c.warnings.some((w) => w.includes("compaction must be an object"))).toBe(true)
    })
  })

  test("SENSUS_HOME redirects the config + data dirs; without it XDG-style paths apply", () => {
    const dir = mkdtempSync(join(tmpdir(), "sensus-home-"))
    const prev = process.env["SENSUS_HOME"]
    const prevHome = process.env["HOME"]
    const prevCache = process.env["SENSUS_CACHE_DIR"]
    try {
      process.env["SENSUS_HOME"] = dir
      expect(sensusHome()).toBe(dir)
      expect(sensusDataDir()).toBe(dir)
      expect(sensusCacheDir()).toBe(`${dir}/cache`)
      expect(configPath(dir)).toBe(`${dir}/config.json`)

      delete process.env["SENSUS_HOME"]
      delete process.env["SENSUS_CACHE_DIR"]
      process.env["HOME"] = "/x"
      expect(sensusHome()).toBe("/x/.config/sensus")
      expect(sensusDataDir()).toBe("/x/.local/share/sensus")
      expect(sensusCacheDir()).toBe("/x/.cache/sensus")
      // SENSUS_CACHE_DIR wins outright.
      process.env["SENSUS_CACHE_DIR"] = "/c/cache"
      expect(sensusCacheDir()).toBe("/c/cache")

      // Runtime dir (daemon UDS socket/token): explicit override wins, then
      // XDG_RUNTIME_DIR, then the OS tmpdir — never a throw on a missing uid.
      const uid = String(process.getuid?.() ?? 0)
      expect(sensusRuntimeDirFrom({ SENSUS_RUNTIME_DIR: "/r/run" })).toBe("/r/run")
      expect(sensusRuntimeDirFrom({ SENSUS_RUNTIME_DIR: "/r/run", XDG_RUNTIME_DIR: "/xdg" })).toBe("/r/run")
      expect(sensusRuntimeDirFrom({ XDG_RUNTIME_DIR: "/xdg" })).toBe(`/xdg/sensus-${uid}`)
      expect(sensusRuntimeDirFrom({})).toBe(join(tmpdir(), `sensus-${uid}`))
    } finally {
      if (prev === undefined) delete process.env["SENSUS_HOME"]
      else process.env["SENSUS_HOME"] = prev
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
      if (prevCache === undefined) delete process.env["SENSUS_CACHE_DIR"]
      else process.env["SENSUS_CACHE_DIR"] = prevCache
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("resolution order defaults -> file -> env -> CLI, for both baseURL/approval and the selected model", () => {
    const { dir, env } = sandbox()
    try {
      writeConfig(dir, {
        model: "alpha@a-model",
        endpoints: {
          alpha: { baseURL: "http://file.local/v1" },
          beta: { baseURL: "http://beta.local/v1" },
          main: {},
        },
      })
      // file only
      const fileOnly = resolveConfig([], env, configPath(dir))
      expect(fileOnly.model).toBe("alpha@a-model")
      expect(activeEndpointName(fileOnly)).toBe("alpha")
      expect(ep(fileOnly, "alpha").baseURL).toBe("http://file.local/v1")
      expect(ep(fileOnly, "beta")).toBeDefined()

      // + env: bare SENSUS_MODEL keeps the endpoint; endpoint@model switches both
      const envPick = resolveConfig(
        [],
        { ...env, SENSUS_MODEL: "env-model", SENSUS_APPROVAL: "full-auto" },
        configPath(dir),
      )
      expect(envPick.model).toBe("alpha@env-model")
      const envSwitch = resolveConfig([], { ...env, SENSUS_MODEL: "beta@b-model" }, configPath(dir))
      expect(envSwitch.model).toBe("beta@b-model")

      // + CLI wins over both; --endpoint switches the endpoint, keeping the model id
      const cli = resolveConfig(
        ["--model", "main@cli-model", "--base-url", "https://cli.local/v1", "--yolo"],
        { ...env, SENSUS_MODEL: "env-model", SENSUS_APPROVAL: "confirm" },
        configPath(dir),
      )
      expect(cli.model).toBe("main@cli-model")
      expect(ep(cli).baseURL).toBe("https://cli.local/v1")
      expect(cli.approval).toBe("full-auto")
      const cliEndpoint = resolveConfig(["--endpoint", "beta"], env, configPath(dir))
      expect(cliEndpoint.model).toBe("beta@a-model")
      expect(activeEndpoint(cliEndpoint).name).toBe("beta")
      expect(activeEndpoint(cliEndpoint).baseURL).toBe("http://beta.local/v1")
      expect(activeModelId(cliEndpoint)).toBe("a-model")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("malformed config content warns but never fails boot (invalid JSON, unknown endpoint)", () => {
    // Invalid JSON: file ignored, defaults survive.
    const { dir, env } = sandbox()
    try {
      writeFileSync(join(dir, "config.json"), "{ not json !")
      const bad = resolveConfig([], env, configPath(dir))
      expect(bad.bootError).toBeNull()
      expect(bad.warnings.join("\n")).toContain("invalid JSON")
      expect(activeEndpointName(bad)).toBe("main")

      // Selected model pointing at an undefined endpoint: warn + fall back to the first.
      writeConfig(dir, { model: "nope@x", endpoints: { main: {} } })
      const c = resolveConfig([], env, configPath(dir))
      expect(activeEndpointName(c)).toBe("main")
      expect(c.warnings.join("\n")).toContain("nope")
      expect(c.bootError).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("unknown and legacy top-level/endpoint keys warn once, never fail boot", () => {
    withConfigFile({
      bogusKey: 1,
      profiles: { main: {} },
      defaultProfile: "main",
      defaultMode: "copilot",
      endpoints: { main: { baseURL: "http://x/v1", strange: true, apiKeyEnv: "OPENAI_API_KEY" } },
    }, (resolve) => {
      const c = resolve()
      expect(c.bootError).toBeNull()
      const w = c.warnings.join("\n")
      expect(w).toContain('unknown key "bogusKey"')
      expect(w).toContain('endpoint "main" has unknown key "strange"')
      // The removed apiKeyEnv key points users at apiKey.
      expect(w).toContain('endpoint "main" key "apiKeyEnv" is gone')
      // Legacy profiles-era keys get a clean-break pointer, and defaultMode
      // does NOT silently become the agent.
      expect(w).toContain('"profiles" is gone')
      expect(w).toContain('"defaultProfile" is gone')
      expect(w).toContain('"defaultMode" is gone')
      expect(c.defaultAgent).toBe("copilot")
    })
  })

  test("bad baseURL fails fast (bootError) — from file, env, and CLI", () => {
    const { dir, env } = sandbox()
    try {
      writeConfig(dir, { endpoints: { main: { baseURL: "not a url" } } })
      const fromFile = resolveConfig([], env, configPath(dir))
      expect(fromFile.bootError).toContain("bad baseURL")
      expect(fromFile.bootError).toContain("not a url")

      const fromEnv = resolveConfig([], { ...env, SENSUS_BASE_URL: "ftp://x" }, null)
      expect(fromEnv.bootError).toContain("SENSUS_BASE_URL")

      const fromCli = resolveConfig(["--base-url", "://broken"], env, null)
      expect(fromCli.bootError).toContain("--base-url")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("scalar keys: agent and allowPrefixes parse when valid, warn + default when not", () => {
    const { dir, env } = sandbox()
    try {
      writeConfig(dir, { agent: "autopilot", allowPrefixes: ["git ", "ls "], endpoints: { main: {} } })
      const ok = resolveConfig([], env, configPath(dir))
      expect(ok.defaultAgent).toBe("autopilot")
      expect(ok.allowPrefixes).toEqual(["git ", "ls "])
      expect(ok.warnings.join("\n")).not.toContain("agent")
      expect(ok.warnings.join("\n")).not.toContain("allowPrefixes")

      writeConfig(dir, { agent: "", allowPrefixes: ["git ", 42, ""], endpoints: { main: {} } })
      const partial = resolveConfig([], env, configPath(dir))
      expect(partial.defaultAgent).toBe("copilot")
      expect(partial.warnings.join("\n")).toContain("agent must be a non-empty string")
      expect(partial.allowPrefixes).toEqual(["git "])
      expect(partial.warnings.join("\n")).toContain("allowPrefixes")

      writeConfig(dir, { allowPrefixes: "git" })
      const wrongType = resolveConfig([], env, configPath(dir))
      expect(wrongType.allowPrefixes).toEqual([])
      expect(wrongType.warnings.join("\n")).toContain("allowPrefixes must be an array")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("per-model metadata overrides parse into the endpoint", () => {
    withConfigFile({
      model: "main@gpt-5",
      endpoints: {
        main: {
          models: {
            "gpt-5": { contextLimit: 400_000, inputLimit: 272_000, reasoning: true, reasoningEfforts: ["low", "high"], temperatureSupported: false, vision: true },
            // Invalid values warn and resolve null (kept non-trivial by contextLimit).
            "partial": { contextLimit: 1000, inputLimit: 0 },
          },
        },
      },
    }, (resolve) => {
      const c = resolve()
      const o = ep(c).models["gpt-5"]
      expect(o?.contextLimit).toBe(400_000)
      expect(o?.inputLimit).toBe(272_000)
      expect(o?.reasoning).toBe(true)
      expect(o?.reasoningEfforts).toEqual(["low", "high"])
      expect(o?.temperatureSupported).toBe(false)
      expect(o?.vision).toBe(true)
      expect(o?.toolCall).toBeNull()
      const partial = ep(c).models["partial"]
      expect(partial?.inputLimit).toBeNull()
      expect(c.warnings.some((w) => w.includes("inputLimit must be a positive number"))).toBe(true)
    })
  })

  test("parseSelectedModel: splits at the FIRST @, rejects degenerate forms, round-trips", () => {
    expect(parseSelectedModel("main@gpt-4o")).toEqual({ endpoint: "main", model: "gpt-4o" })
    expect(parseSelectedModel("ollama@qwen3@latest")).toEqual({ endpoint: "ollama", model: "qwen3@latest" })
    for (const bad of ["", "bare-model", "@model", "endpoint@"]) {
      expect(parseSelectedModel(bad)).toBeNull()
    }
    const s = selectedModelString("ep", "m@tag")
    expect(parseSelectedModel(s)).toEqual({ endpoint: "ep", model: "m@tag" })
  })

  test("endpoint helpers: apiKey parses from the file and baseURL validation", () => {
    const { dir, env } = sandbox()
    try {
      writeConfig(dir, { endpoints: { main: { apiKey: "direct-key" } } })
      const c = resolveConfig([], env, configPath(dir))
      expect(activeEndpoint(c).apiKey).toBe("direct-key")

      expect(validateBaseURL("https://api.openai.com/v1")).toBeNull()
      expect(validateBaseURL("http://localhost:8080/v1")).toBeNull()
      expect(validateBaseURL("gopher://x")).not.toBeNull()
      expect(validateBaseURL("")).not.toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("loadConfig (full path): CLI overrides apply through the whole pipeline", () => {
    const { dir } = sandbox()
    const prevHome = process.env["SENSUS_HOME"]
    process.env["SENSUS_HOME"] = dir
    try {
      const c = loadConfig(["--model", "main@m1", "--yolo", "--sidebar-width", "30"])
      expect(c.model).toBe("main@m1")
      expect(c.approval).toBe("full-auto")
      expect(c.sidebarWidth).toBe(30)
    } finally {
      // prevHome is undefined when the suite runs without SENSUS_HOME set —
      // assigning it would set the env var to the literal string "undefined"
      // and poison sensusHome() for the rest of the single-process run
      // (chatHost.test.ts then materialized ./undefined/agents — the bug).
      if (prevHome === undefined) delete process.env["SENSUS_HOME"]
      else process.env["SENSUS_HOME"] = prevHome
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  })

  test("thinkingMode: off / budget:<n> / effort keywords all parse; invalid warns and is dropped", () => {
    const { dir, env } = sandbox()
    try {
      writeConfig(dir, {
        endpoints: {
          main: { thinkingMode: "high" },
          a: { thinkingMode: "off" },
          b: { thinkingMode: "budget:8192" },
          c: { thinkingMode: "xhigh" },
          bad: { thinkingMode: "not a mode!" },
        },
      })
      const c = resolveConfig([], env, join(dir, "config.json"))
      expect(c.endpoints["main"]?.thinkingMode).toBe("high")
      expect(c.endpoints["a"]?.thinkingMode).toBe("off")
      expect(c.endpoints["b"]?.thinkingMode).toBe("budget:8192")
      expect(c.endpoints["c"]?.thinkingMode).toBe("xhigh")
      expect(c.endpoints["bad"]?.thinkingMode).toBeUndefined()
      expect(c.warnings.some((w) => w.includes("thinkingMode"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("endpoint provider protocols: canonical kinds parse, legacy http canonicalizes, unknown warns; baseURL defaults per protocol", () => {
    expect(defaultConfig().endpoints["main"]?.provider).toBe("openai-compatible")
    withConfigFile({
      endpoints: {
        compat: { provider: "openai-compatible" },
        responses: { provider: "openai-responses" },
        anthropic: { provider: "anthropic" },
        google: { provider: "google" },
        mock: { provider: "mock" },
        legacy: { provider: "http" },
        empty: { provider: "google", baseURL: "" },
        explicit: { provider: "anthropic", baseURL: "http://localhost:9999/v1/" },
        bogus: { provider: "wat" },
        missing: {},
      },
    }, (resolve) => {
      const c = resolve()
      // Canonical kinds + their per-protocol default baseURLs.
      expect(ep(c, "compat").provider).toBe("openai-compatible")
      expect(ep(c, "compat").baseURL).toBe("https://api.openai.com/v1")
      expect(ep(c, "responses").provider).toBe("openai-responses")
      expect(ep(c, "responses").baseURL).toBe("https://api.openai.com/v1")
      expect(ep(c, "anthropic").provider).toBe("anthropic")
      expect(ep(c, "anthropic").baseURL).toBe("https://api.anthropic.com/v1")
      expect(ep(c, "google").provider).toBe("google")
      expect(ep(c, "google").baseURL).toBe("https://generativelanguage.googleapis.com/v1beta")
      // Mock keeps the constructed default (it never talks to the URL).
      expect(ep(c, "mock").provider).toBe("mock")
      expect(ep(c, "mock").baseURL).toBe("https://api.openai.com/v1")
      // Legacy "http" canonicalizes with no warning.
      expect(ep(c, "legacy").provider).toBe("openai-compatible")
      expect(c.warnings.some((w) => w.includes('endpoint "legacy"'))).toBe(false)
      // An explicit empty baseURL resolves; an explicit URL is kept as authored.
      expect(ep(c, "empty").baseURL).toBe("https://generativelanguage.googleapis.com/v1beta")
      expect(ep(c, "explicit").baseURL).toBe("http://localhost:9999/v1/")
      // A missing provider key defaults silently; an unknown one warns (with
      // the accepted list) and falls back to openai-compatible.
      expect(ep(c, "missing").provider).toBe("openai-compatible")
      expect(ep(c, "missing").baseURL).toBe("https://api.openai.com/v1")
      expect(c.warnings.some((w) => w.includes('endpoint "missing"'))).toBe(false)
      expect(ep(c, "bogus").provider).toBe("openai-compatible")
      expect(c.warnings.some((w) => w.includes('endpoint "bogus" provider must be "openai-compatible"'))).toBe(true)
      expect(c.bootError).toBeNull()
    })
  })

  test("themePalette: valid palette/foreground/background/colorMode parse", () => {
    withConfigFile({
      themePalette: {
        palette: ["#282828", "#cc241d", "rgb:10/20/30"],
        foreground: "#ebdbb2",
        background: "#282828",
        paneColors: "index",
        boldBright: false,
        colorMode: "truecolor",
      },
    }, (resolve) => {
      const c = resolve()
      expect(c.themePalette?.palette).toEqual(["#282828", "#cc241d", "rgb:10/20/30"])
      expect(c.themePalette?.foreground).toBe("#ebdbb2")
      expect(c.themePalette?.background).toBe("#282828")
      expect(c.themePalette?.paneColors).toBe("index")
      expect(c.themePalette?.boldBright).toBe(false)
      expect(c.themePalette?.colorMode).toBe("truecolor")
    })

    // A bare { colorMode } object is a meaningful override (not dropped).
    withConfigFile({ themePalette: { colorMode: "ansi256" } }, (resolve) => {
      expect(resolve().themePalette?.colorMode).toBe("ansi256")
    })

    // paneColors/boldBright alone are meaningful too.
    withConfigFile({ themePalette: { paneColors: "exact", boldBright: true } }, (resolve) => {
      expect(resolve().themePalette?.paneColors).toBe("exact")
      expect(resolve().themePalette?.boldBright).toBe(true)
    })
  })

  test("themePalette: invalid colors drop per-entry with warnings; degenerate shapes resolve to null", () => {
    withConfigFile({
      themePalette: {
        palette: ["#ff0000", "nope", 42],
        foreground: "zzz",
        background: "#282828",
        paneColors: "bogus",
        boldBright: "yes",
        colorMode: "bogus",
      },
    }, (resolve) => {
      const c = resolve()
      expect(c.themePalette?.palette).toEqual(["#ff0000", null, null])
      expect(c.themePalette?.foreground).toBeUndefined()
      expect(c.themePalette?.background).toBe("#282828")
      expect(c.themePalette?.paneColors).toBeUndefined()
      expect(c.themePalette?.boldBright).toBeUndefined()
      expect(c.themePalette?.colorMode).toBeUndefined()
      const w = c.warnings.join("\n")
      expect(w).toContain("themePalette.palette")
      expect(w).toContain("themePalette.foreground")
      expect(w).toContain("themePalette.paneColors must be")
      expect(w).toContain("themePalette.boldBright must be")
      expect(w).toContain("themePalette.colorMode must be")
    })

    // All-invalid palette / non-object / wrong shapes: ignored (null), warn, boot fine.
    withConfigFile({ themePalette: { palette: ["nope"], foreground: "zzz" } }, (resolve) => {
      expect(resolve().themePalette).toBeNull()
    })
    withConfigFile({ themePalette: "bogus" }, (resolve) => {
      const c = resolve()
      expect(c.themePalette).toBeNull()
      expect(c.warnings.join("\n")).toContain("themePalette must be an object")
    })
    withConfigFile({ themePalette: { palette: "bogus", unknownKey: 1 } }, (resolve) => {
      const c = resolve()
      expect(c.themePalette).toBeNull()
      expect(c.warnings.join("\n")).toContain("palette must be an array")
      expect(c.warnings.join("\n")).toContain('unknown key "unknownKey"')
    })
  })

  test("mcp servers: stdio + http parse with defaults, ${VAR} headers expand, invalid entries skip with warnings", () => {
    const { dir, env } = sandbox()
    try {
      writeConfig(dir, {
        mcp: {
          servers: {
            playwright: { command: "npx", args: ["@playwright/mcp@latest"], cwd: "scratch/playwright" },
            varcwd: { command: "run", cwd: "${MCP_CWD_VAR}" },
            badcwd: { command: "run", cwd: 123 },
            firecrawl: { url: "https://mcp.firecrawl.dev/mcp", cwd: "/nope", headers: { Authorization: "Bearer ${FIRECRAWL_API_KEY}" } },
            disabled: { command: "run", enabled: false, timeout_s: 5 },
          },
        },
      })
      const c = resolveConfig([], env, join(dir, "config.json"))
      const pw = c.mcp.servers["playwright"]
      expect(pw?.command).toBe("npx")
      expect(pw?.args).toEqual(["@playwright/mcp@latest"])
      expect(pw?.cwd).toBe("scratch/playwright")
      expect(pw?.enabled).toBe(true)
      expect(pw?.timeoutS).toBe(60)
      // ${VAR} expansion in cwd: missing -> empty + warn, present -> expanded.
      expect(c.mcp.servers["varcwd"]?.cwd).toBe("")
      expect(c.warnings.some((w) => w.includes("MCP_CWD_VAR"))).toBe(true)
      // A non-string cwd warns and is ignored.
      expect(c.mcp.servers["badcwd"]?.cwd).toBeUndefined()
      expect(c.warnings.some((w) => w.includes('"badcwd" cwd must be a string'))).toBe(true)
      // cwd is stdio-only: an http entry warns and drops it.
      expect(c.mcp.servers["firecrawl"]?.cwd).toBeUndefined()
      expect(c.warnings.some((w) => w.includes('"firecrawl" cwd is stdio-only'))).toBe(true)
      // ${VAR} expansion with the env var present, and missing -> empty + warn.
      const withKey = resolveConfig([], { ...env, FIRECRAWL_API_KEY: "sk-test", MCP_CWD_VAR: "sub" }, join(dir, "config.json"))
      expect(withKey.mcp.servers["firecrawl"]?.headers?.Authorization).toBe("Bearer sk-test")
      expect(withKey.mcp.servers["varcwd"]?.cwd).toBe("sub")
      expect(c.mcp.servers["firecrawl"]?.headers?.Authorization).toBe("Bearer ")
      expect(c.warnings.some((w) => w.includes("FIRECRAWL_API_KEY") || w.includes("NOPE_KEY"))).toBe(true)
      const dis = c.mcp.servers["disabled"]
      expect(dis?.enabled).toBe(false)
      expect(dis?.timeoutS).toBe(5)
      expect(c.bootError).toBeNull()

      // Invalid entries warn + are skipped (never block boot).
      writeConfig(dir, {
        mcp: {
          servers: {
            bad: { args: ["no command"] },
            both: { command: "a", url: "https://x" },
            badurl: { url: "ftp://nope" },
          },
        },
      })
      const c2 = resolveConfig([], env, join(dir, "config.json"))
      expect(Object.keys(c2.mcp.servers)).toEqual([])
      expect(c2.warnings.filter((w) => w.includes("mcp server")).length).toBeGreaterThanOrEqual(3)
      expect(c2.bootError).toBeNull()

      // Non-object section warns; defaults carry no servers.
      writeConfig(dir, { mcp: 42 })
      const c3 = resolveConfig([], env, join(dir, "config.json"))
      expect(Object.keys(c3.mcp.servers)).toEqual([])
      expect(c3.warnings.some((w) => w.includes("mcp must be an object"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("extensions: policy + sink parse; malformed values degrade to the no-op/local defaults", () => {
    withConfigFile(
      {
        extensions: {
          approvalPolicy: { kind: "acme", tier: "gold" },
          eventSink: { kind: "uds", path: "unix:///run/sensus/events.sock" },
        },
      },
      (resolve) => {
        const c = resolve()
        // The policy object (kind + extra keys) is passed through for a host
        // factory; the sink normalizes to kind/path.
        expect(c.extensions.approvalPolicy).toEqual({ kind: "acme", tier: "gold" })
        expect(c.extensions.eventSink).toEqual({ kind: "uds", path: "unix:///run/sensus/events.sock" })
        expect(c.warnings).toEqual([])
        expect(c.bootError).toBeNull()
      },
    )

    withConfigFile(
      {
        extensions: {
          approvalPolicy: { kind: "" },
          eventSink: { kind: "uds" },
          extra: true,
        },
      },
      (resolve) => {
        const c = resolve()
        // No throw, and every invalid value keeps the safe default.
        expect(c.extensions.approvalPolicy).toEqual({ kind: "default" })
        expect(c.extensions.eventSink).toEqual({ kind: "noop" })
        const warnings = c.warnings.join("\n")
        expect(warnings).toContain("approvalPolicy.kind")
        expect(warnings).toContain("eventSink.path is required")
        expect(warnings).toContain('unknown key "extra"')
        expect(c.bootError).toBeNull()
      },
    )

    withConfigFile({ extensions: 42 }, (resolve) => {
      const c = resolve()
      expect(c.extensions).toEqual({ approvalPolicy: { kind: "default" }, eventSink: { kind: "noop" } })
      expect(c.warnings.some((w) => w.includes("extensions must be an object"))).toBe(true)
    })
  })
})

describe("config triggers (docs/triggers.md)", () => {
  test("defaults to no triggers", () => {
    expect(defaultConfig().triggers).toEqual([])
  })

  test("parses on / tool / session rules and the wildcard", () => {
    withConfigFile(
      {
        triggers: [
          { on: "error.raised" },
          { on: "tool.executed", tool: "shell_background" },
          { on: "file.changed", session: "s1" },
          { on: "*" },
        ],
      },
      (resolve) => {
        const c = resolve()
        expect(c.triggers).toEqual([
          { on: "error.raised" },
          { on: "tool.executed", tool: "shell_background" },
          { on: "file.changed", session: "s1" },
          { on: "*" },
        ])
        expect(c.warnings).toEqual([])
      },
    )
  })

  test("skips invalid rules and warns; unknown keys and a bad section never fail boot", () => {
    withConfigFile(
      {
        triggers: [
          42,
          { on: "not.a.type" },
          { on: "" },
          { on: "error.raised", tool: 7, session: "", extra: true },
        ],
      },
      (resolve) => {
        const c = resolve()
        // The last rule survives with its invalid filters dropped.
        expect(c.triggers).toEqual([{ on: "error.raised" }])
        const warnings = c.warnings.join("\n")
        expect(warnings).toContain("triggers[0] must be an object")
        expect(warnings).toContain("triggers[1].on must be a v1 event type")
        expect(warnings).toContain("triggers[2].on must be a v1 event type")
        expect(warnings).toContain("triggers[3].tool must be a non-empty string")
        expect(warnings).toContain("triggers[3].session must be a non-empty string")
        expect(warnings).toContain('unknown key "extra"')
        expect(c.bootError).toBeNull()
      },
    )

    withConfigFile({ triggers: "nope" }, (resolve) => {
      const c = resolve()
      expect(c.triggers).toEqual([])
      expect(c.warnings.some((w) => w.includes("triggers must be an array"))).toBe(true)
    })
  })
})
