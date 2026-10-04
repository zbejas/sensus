/**
 * hostAdapter — the REST-backed, `ChatHost`-shaped facade for the client UI
 * (P4c-iii; D5/D13). The runtime path no longer constructs the engine: the
 * daemon owns config/agents/skills/memory/sessions/MCP, and this adapter reads
 * them over `RestClient` and exposes the exact surface `App.tsx` and the
 * overlays call today.
 *
 * It contains NO engine objects and imports ONLY types + pure helpers from
 * `src/engine/index.ts` — never `src/agent/**` runtime code. The few overlays
 * whose engine surface is synchronous and file-backed (memory manager, session
 * search, usage) are served by thin REST-backed shims: reads come from a
 * prefetched cache and mutations are forwarded to REST. Those shims are
 * best-effort and their remaining gaps are called out in the report.
 */

import { createSignal } from "solid-js"
import type { AgentDef, ContextBreakdown, McpServerStatusFact, SensusConfig, SkillsCatalog } from "../engine/index.ts"
import type { AgentsCatalog } from "../config/agents.ts"
import type { RestClient } from "./restClient.ts"
import type { WsClient } from "./wsClient.ts"

export type ConfigChangeKind = "internal" | "user" | "settings"
export type ConfigChangeListener = (kind: ConfigChangeKind) => void

export interface HostAdapterOptions {
  rest: RestClient
  ws: WsClient
  /** The effective (redacted) config fetched at boot. */
  initialConfig: SensusConfig
}

/** Map a daemon agent summary onto the UI's `AgentDef` shape (prompt omitted). */
function summaryToAgent(summary: { name: string; description: string; tools: string[] | null; skills: string[] | null; sudoPrompt: string; shell: string; path: string; prompt?: string }): AgentDef {
  return {
    name: summary.name,
    description: summary.description,
    tools: summary.tools,
    skills: summary.skills,
    sudoPrompt: summary.sudoPrompt as AgentDef["sudoPrompt"],
    shell: summary.shell as AgentDef["shell"],
    prompt: summary.prompt ?? "",
    path: summary.path,
  }
}

/**
 * The client's config/engine facade. Every getter is synchronous (served from a
 * cache prefetched by `preload`); every mutation forwards to REST and refreshes
 * the cache. No engine object exists in this class.
 */
export class HostAdapter {
  readonly rest: RestClient
  readonly ws: WsClient

  private config: SensusConfig
  private rawConfig: Record<string, unknown> = {}
  private agents: AgentsCatalog = { agents: [], byName: {}, warnings: [] }
  private skills: SkillsCatalog = { skills: [], byName: {}, warnings: [] }
  private mcpFacts: McpServerStatusFact[] = []
  private hostContent: string | null = null
  private readonly sMcpVersion = createSignal(0)
  private readonly listeners = new Set<ConfigChangeListener>()

  constructor(opts: HostAdapterOptions) {
    this.rest = opts.rest
    this.ws = opts.ws
    this.config = opts.initialConfig
  }

  // -- config -----------------------------------------------------------------

  getConfig(): SensusConfig {
    return this.config
  }

  /** The raw (secret-free) config document — the settings/setup seed. */
  getRawConfig(): Record<string, unknown> {
    return this.rawConfig
  }

  onConfigChange(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emitConfigChange(kind: ConfigChangeKind): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(kind)
      } catch {
        // a listener must never break a reload
      }
    }
  }

  /**
   * Re-fetch the effective config and notify listeners. Returns null (the
   * synchronous `ChatHost.reload` contract) and does the REST round-trip in the
   * background; a failure is reported through `onToast`.
   */
  reload(kind: ConfigChangeKind = "internal"): string | null {
    void this.refreshConfig().then((warning) => {
      if (warning !== null) this.toast(warning, "warn")
      this.emitConfigChange(kind)
    })
    return null
  }

  private toast(message: string, level: "info" | "success" | "warn" | "error" = "info"): void {
    try {
      this.onToast?.(message, level)
    } catch {
      // a toast must never throw
    }
  }

  /** Set by `index.tsx` so adapter-side failures surface like chat toasts. */
  onToast: ((message: string, level?: "info" | "success" | "warn" | "error", ttlMs?: number) => void) | undefined

  private async refreshConfig(): Promise<string | null> {
    try {
      const res = await this.rest.config()
      this.config = res.config as unknown as SensusConfig
      try {
        const raw = await this.rest.rawConfig()
        this.rawConfig = raw.raw
      } catch {
        // leave the previous raw doc
      }
      return null
    } catch (e) {
      return `config reload failed: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  // -- preload ----------------------------------------------------------------

  /** Fetch the synchronous getters' data, once, before first render. */
  async preload(): Promise<void> {
    await Promise.all([this.refreshConfig(), this.refreshAgents(), this.refreshSkills(), this.refreshMcp(), this.refreshHostMemory()])
  }

  /** The live HOST.md content (the setup seed refuses to clobber a non-empty one). */
  async refreshHostMemory(): Promise<void> {
    try {
      const res = await this.rest.memoryTarget("host")
      this.hostContent = res.content.length > 0 ? res.content : null
    } catch {
      // leave the previous content
    }
  }

  getHostMemory(): string | null {
    return this.hostContent
  }

  private async refreshAgents(): Promise<void> {
    try {
      const res = await this.rest.agents()
      const agents = res.agents.map(summaryToAgent)
      const byName: Record<string, AgentDef> = {}
      for (const a of agents) byName[a.name] = a
      this.agents = { agents, byName, warnings: res.warnings }
    } catch {
      // leave the previous catalog
    }
  }

  private async refreshSkills(): Promise<void> {
    try {
      const res = await this.rest.skills()
      const skills = res.skills.map((s) => ({ name: s.name, description: s.description, path: s.path, body: "" }))
      const byName: Record<string, (typeof skills)[number]> = {}
      for (const s of skills) byName[s.name] = s
      this.skills = { skills, byName, warnings: res.warnings }
    } catch {
      // leave the previous catalog
    }
  }

  async refreshMcp(): Promise<void> {
    try {
      const res = await this.rest.mcp()
      this.mcpFacts = res.servers.map((s) => ({
        name: s.name,
        status: s.status as McpServerStatusFact["status"],
        toolCount: s.toolCount,
      }))
      this.sMcpVersion[1]((v) => v + 1)
    } catch {
      // leave the previous facts
    }
  }

  // -- synchronous catalogs ---------------------------------------------------

  getAgents(): AgentsCatalog {
    return this.agents
  }

  getSkills(): SkillsCatalog {
    return this.skills
  }

  /** A saved transcript's Context Inspector snapshot (P4e), via REST. */
  async sessionContextBreakdown(path: string): Promise<{ title: string; breakdown: ContextBreakdown } | null> {
    const match = /\/sessions\/([^/]+)\/([^/]+)\.jsonl$/.exec(path)
    if (match === null) return null
    try {
      const res = await this.rest.sessionContext(match[1]!, match[2]!)
      return { title: res.title, breakdown: res.breakdown }
    } catch {
      return null
    }
  }

  // -- mutations --------------------------------------------------------------

  /** Persist a raw config patch (Model/Agent/Keymap/MCP/layout writes). */
  async putConfig(patch: Record<string, unknown>): Promise<string | null> {
    return await this.writeConfig(patch, false)
  }

  /** REPLACE the whole raw config (the settings screen's full-doc write). */
  async putConfigDoc(doc: Record<string, unknown>): Promise<string | null> {
    return await this.writeConfig(doc, true)
  }

  private async writeConfig(doc: Record<string, unknown>, replace: boolean): Promise<string | null> {
    try {
      const res = await this.rest.putConfig(doc, { replace })
      this.config = res.config as unknown as SensusConfig
      try {
        const raw = await this.rest.rawConfig()
        this.rawConfig = raw.raw
      } catch {
        // leave the previous raw doc
      }
      this.emitConfigChange("settings")
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  /** Set the default agent (new sessions); returns null on success. */
  setDefaultAgent(name: string): string | null {
    // `agent` is the config-file key (docs/config.md); `defaultAgent` is only the
    // resolved `SensusConfig` field — writing it would leave an unknown top-level key.
    void this.putConfig({ agent: name }).then((err) => {
      if (err !== null) this.toast(err, "error")
    })
    return null
  }

  readonly mcp = {
    statusVersion: (): number => this.sMcpVersion[0](),
    serverStatuses: (): McpServerStatusFact[] => this.mcpFacts,
  }
}
