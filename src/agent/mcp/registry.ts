/**
 * McpRegistry (M11, docs/mcp.md): owns every configured MCP server for one
 * sensus instance — lazy connections, tool discovery, `tools/call` dispatch
 * and the merged OpenAI function specs that ride in each chat request.
 *
 * Design:
 * - LAZY: nothing spawns at boot. ChatSession calls `ensureReady()` at the
 *   start of a generation; connections run in parallel and are cached for
 *   the instance. A failed/timed-out server marks itself `failed`, toasts
 *   via the returned failure list, and chat continues without its tools
 *   (same degradation ethos as no-tools mode).
 * - NAMESPACED: every tool surfaces as `mcp__<server>__<tool>` so names
 *   cannot collide with the core tool specs or across servers (over-long names get a
 *   hash suffix — types.ts wireToolName). The wire->ref map is authoritative.
 * - APPROVALS live in the tool layer (tools.ts): mcp__* gates in confirm
 *   mode like run_command, auto-runs in full-auto.
 * - /reload: `restartChanged()` diffs the new server configs; changed
 *   servers are stopped and reconnected lazily on the next ensureReady.
 */

import { createSignal } from "solid-js"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import type { ToolSpec } from "../tools.ts"
import { truncateHeadTail } from "../tools.ts"
import { SENSUS_VERSION } from "../../version.ts"
import { sensusCacheDir, sensusHome } from "../../config/config.ts"
import {
  parseWireName,
  wireToolName,
  type McpConfig,
  type McpServerConfig as ServerConfig,
} from "./types.ts"
import { JsonRpcSession, type JsonRpcMessage } from "./jsonrpc.ts"
import { StdioTransport } from "./stdio.ts"
import { HttpTransport } from "./http.ts"
import { maybeCleanupMcpCache, mcpCacheRoot } from "./cache.ts"
import { errorMessage, isRecord } from "../../core/util.ts"
import type { McpServerStatus, McpServerStatusFact } from "../chat/chatMessages.ts"
import { componentLogger } from "../log.ts"

const log = componentLogger("agent.mcp")

/** The MCP protocol revision this client speaks (servers may answer older). */
const PROTOCOL_VERSION = "2025-06-18"

/** Per-server status vocabulary; the canonical definition lives in the chat
 * model (`chatMessages.ts`) so the UI seam can name it without importing the
 * registry. Re-exported here for registry consumers. */
export type { McpServerStatus, McpServerStatusFact }

/** One MCP tool definition (tools/list item). */
interface McpToolDef {
  name: string
  description?: string
  inputSchema?: unknown
}

interface ServerConn {
  name: string
  cfg: ServerConfig
  status: McpServerStatus
  /** Tool count / failure detail. */
  detail: string
  tools: McpToolDef[]
  session: JsonRpcSession | null
  transport: StdioTransport | HttpTransport | null
  /** In-flight ensureReady connect (shared across concurrent callers). */
  connecting: Promise<string | null> | null
  /** tools/list fingerprint (restartChanged diffing). */
  fingerprint: string
  /** Consecutive failed connect attempts (drives the retry backoff). */
  failures: number
  /** Epoch ms before which a failed server is not retried (0 = eligible). */
  retryAt: number
}

const EMPTY: Omit<ServerConn, "name" | "cfg" | "fingerprint"> = {
  status: "idle",
  detail: "",
  tools: [],
  session: null,
  transport: null,
  connecting: null,
  failures: 0,
  retryAt: 0,
}

/** Default retry backoff base for a failed MCP server (ms). */
export const MCP_RETRY_BASE_MS = 2_000
/** Cap on the MCP retry backoff (ms). */
export const MCP_RETRY_CAP_MS = 60_000

/**
 * Bounded exponential backoff before a failed MCP server is retried:
 * `min(base * 2**(failures-1), cap)`. `failures` is 1-based (the first failure
 * waits `base`). Pure and deterministic for tests.
 */
export function mcpRetryDelayMs(
  failures: number,
  opts: { baseMs?: number; capMs?: number } = {},
): number {
  const base = Math.max(1, opts.baseMs ?? MCP_RETRY_BASE_MS)
  const cap = Math.max(base, opts.capMs ?? MCP_RETRY_CAP_MS)
  const n = Math.max(1, Math.floor(failures))
  return Math.min(cap, base * 2 ** (n - 1))
}

export interface McpServerFact {
  name: string
  tools: string[]
}

export interface McpCallResult {
  ok: boolean
  result: string
}

/** Serialize one server config for restart diffing. */
function fingerprintOf(cfg: ServerConfig): string {
  return JSON.stringify(cfg)
}

/**
 * Resolve the working directory for one stdio MCP server (docs/mcp.md
 * "Configuration"). A stdio server must NEVER inherit sensus's process cwd —
 * servers like `@playwright/mcp` write scratch output into it. Resolution:
 *   1. explicit `cfg.cwd` wins (a relative path resolves against `homeDir`);
 *   2. otherwise a stable per-server `<cacheRoot>/mcp/<server>/` (created
 *      best-effort);
 *   3. a default dir that cannot be created falls back to `os.tmpdir()`.
 * `mkdir` is injectable so tests can force the failure path; it defaults to a
 * recursive `fs.mkdirSync`.
 */
export function resolveMcpServerCwd(
  name: string,
  cfg: ServerConfig,
  deps: { cacheRoot: string; homeDir: string; mkdir?: (path: string) => void },
): { cwd: string; warning?: string } {
  if (cfg.cwd !== undefined && cfg.cwd.length > 0) {
    return { cwd: isAbsolute(cfg.cwd) ? cfg.cwd : resolve(deps.homeDir, cfg.cwd) }
  }
  const dir = join(deps.cacheRoot, "mcp", name)
  const mkdir = deps.mkdir ?? ((p: string): void => void mkdirSync(p, { recursive: true }))
  try {
    mkdir(dir)
    return { cwd: dir }
  } catch (e) {
    const fallback = tmpdir()
    return {
      cwd: fallback,
      warning: `mcp server "${name}": could not create ${dir} (${errorMessage(e)}) — using ${fallback}`,
    }
  }
}

export class McpRegistry {
  private conns = new Map<string, ServerConn>()
  private seenFingerprint = ""
  /** Failed-server retry backoff knobs (test seam; defaults are production). */
  private readonly retryBaseMs: number
  private readonly retryCapMs: number
  /**
   * Solid signal bumped on every per-server status transition (connect start,
   * success, failure, mid-run death, stop/rebuild). The status bar subscribes
   * through `ChatSession.mcpStatusFacts()` so the chip repaints without
   * polling — the registry itself holds no reactive UI state.
   */
  private readonly sStatusVersion = createSignal(0)

  constructor(initial?: McpConfig, opts: { retryBaseMs?: number; retryCapMs?: number } = {}) {
    // Best-effort, hourly-throttled prune of stale per-server scratch files
    // (docs/mcp.md "Configuration"). Never throws; does not affect startup.
    maybeCleanupMcpCache(mcpCacheRoot(sensusCacheDir()))
    this.retryBaseMs = Math.max(1, opts.retryBaseMs ?? MCP_RETRY_BASE_MS)
    this.retryCapMs = Math.max(this.retryBaseMs, opts.retryCapMs ?? MCP_RETRY_CAP_MS)
    if (initial) this.rebuildConns(initial)
  }

  /** Bump the reactive status version (every mutation that changes a status). */
  private bumpStatus(): void {
    this.sStatusVersion[1]((v) => v + 1)
  }

  /** Reactive read: subscribe inside a tracked scope to repaint on any
   *  per-server status transition (docs/mcp.md "UI"). */
  statusVersion(): number {
    return this.sStatusVersion[0]()
  }

  /** Per-server `{name, status, toolCount}` snapshot (status bar; sync cache).
   *  Includes `disabled` entries — the caller decides what is meaningful. */
  serverStatuses(): McpServerStatusFact[] {
    return [...this.conns.values()].map((conn) => ({
      name: conn.name,
      status: conn.status,
      toolCount: conn.tools.length,
    }))
  }

  /**
   * Recreate the conn table for a config (preserving live connections).
   * Fingerprint diffing: a server entry is LEFT ALONE (live connection
   * survives /reload) unless it is new, removed, or its normalized config
   * (command/args/env/url/headers/enabled) changed — changed entries are
   * stopped and rebuilt "idle"; the next ensureReady reconnects them.
   */
  private rebuildConns(cfg: McpConfig | undefined): void {
    const wanted = cfg?.servers ?? {}
    for (const [name, conn] of this.conns) {
      if (!(name in wanted)) {
        void this.stopConn(conn)
        this.conns.delete(name)
      }
    }
    for (const [name, serverCfg] of Object.entries(wanted)) {
      const existing = this.conns.get(name)
      if (existing && existing.fingerprint === fingerprintOf(serverCfg)) continue
      if (existing) void this.stopConn(existing)
      this.conns.set(name, {
        name,
        cfg: serverCfg,
        fingerprint: fingerprintOf(serverCfg),
        ...EMPTY,
        status: serverCfg.enabled ? "idle" : "disabled",
      })
    }
    this.seenFingerprint = JSON.stringify({ servers: wanted })
    this.bumpStatus()
  }

  /** Merged OpenAI function specs from every CONNECTED server (sync cache). */
  currentSpecs(): ToolSpec[] {
    const specs: ToolSpec[] = []
    const seen = new Set<string>()
    for (const conn of this.conns.values()) {
      if (conn.status !== "connected") continue
      for (const tool of conn.tools) {
        const wire = wireToolName(conn.name, tool.name)
        let unique = wire
        for (let n = 2; seen.has(unique); n++) unique = `${wire}_${n}`
        seen.add(unique)
        specs.push(this.specFor(unique, tool))
      }
    }
    return specs
  }

  private specFor(wireName: string, tool: McpToolDef): ToolSpec {
    const schema = isRecord(tool.inputSchema) ? tool.inputSchema : {}
    const parameters = { ...schema, type: "object" }
    return {
      type: "function",
      function: {
        name: wireName,
        description: tool.description ?? `${tool.name} (MCP tool)`,
        parameters,
      },
    }
  }

  /** Per-server facts for the system prompt (connected servers only). */
  connectedServerFacts(): McpServerFact[] {
    const facts: McpServerFact[] = []
    for (const conn of this.conns.values()) {
      if (conn.status !== "connected") continue
      facts.push({ name: conn.name, tools: conn.tools.map((t) => t.name) })
    }
    return facts
  }

  /** One status line per configured server (`/mcp`, `/status`). */
  statusLines(): string[] {
    const lines: string[] = []
    for (const conn of this.conns.values()) {
      const what =
        conn.cfg.command !== undefined
          ? `stdio: ${[conn.cfg.command, ...(conn.cfg.args ?? [])].join(" ")}`
          : `http: ${conn.cfg.url ?? "?"}`
      const detail = conn.status === "connected" ? `${conn.tools.length} tool(s)` : conn.detail
      const suffix = conn.cfg.enabled ? (detail.length > 0 ? ` — ${detail}` : "") : " — disabled in config"
      lines.push(`${conn.name}: ${conn.status}${suffix} (${what})`)
    }
    return lines
  }

  /**
   * Lazy connection pass: (re)diff the config, connect every idle server in
   * parallel, return per-server failure messages (empty = all good). Awaited
   * by ChatSession before the first request of a generation; Esc aborts.
   */
  async ensureReady(cfg: McpConfig | undefined, signal: AbortSignal): Promise<string[]> {
    this.rebuildConns(cfg)
    const failures: string[] = []
    const attempts: Array<Promise<void>> = []
    for (const conn of this.conns.values()) {
      if (!conn.cfg.enabled || conn.status === "connected") continue
      // A failed server is retried only AFTER its backoff elapses, so one
      // transient first-connect failure does not remove its tools for the whole
      // instance (docs/mcp.md). Before then it is skipped lazily/non-blocking.
      if (conn.status === "failed" && Date.now() < conn.retryAt) continue
      if (signal.aborted) break
      attempts.push(
        this.connect(conn, signal)
          .then((err) => {
            if (err !== null) failures.push(`${conn.name}: ${err}`)
          })
          .catch((e: unknown) => {
            failures.push(`${conn.name}: connection failed`)
            log.warn("mcp server connect failed", { server: conn.name, err: e })
          }),
      )
    }
    await Promise.all(attempts)
    return failures
  }

  /** Connect one server. Returns the failure message or null. */
  private async connect(conn: ServerConn, signal: AbortSignal): Promise<string | null> {
    if (conn.connecting) return conn.connecting
    conn.status = "starting"
    conn.detail = "connecting…"
    this.bumpStatus()
    conn.connecting = (async (): Promise<string | null> => {
      const timeoutMs = conn.cfg.timeoutS * 1000
      try {
        const { session, transport } = this.buildTransport(conn)
        conn.session = session
        conn.transport = transport
        await transport.start({
          onMessage: (msg) => session.handleIncoming(msg),
          onDown: (err) => this.markDown(conn, err),
        })
        const init = await session.request<Record<string, unknown>>(
          "initialize",
          {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "sensus", version: SENSUS_VERSION },
          },
          timeoutMs,
          signal,
        )
        const serverInfo = init?.serverInfo as { name?: string; version?: string } | undefined
        conn.detail = serverInfo?.name ? `${serverInfo.name}${serverInfo.version ? ` ${serverInfo.version}` : ""}` : ""
        session.notify("notifications/initialized")
        const tools = await this.listTools(session, conn, signal)
        if (signal.aborted) return "aborted"
        conn.tools = tools
        conn.status = "connected"
        conn.detail = ""
        conn.failures = 0
        conn.retryAt = 0
        this.bumpStatus()
        return null
      } catch (e) {
        conn.status = "failed"
        conn.detail = errorMessage(e)
        conn.failures += 1
        // Schedule a bounded-backoff retry so a later generation can recover.
        conn.retryAt = Date.now() + mcpRetryDelayMs(conn.failures, { baseMs: this.retryBaseMs, capMs: this.retryCapMs })
        conn.session = null
        this.bumpStatus()
        // A timed-out/failed connect must NOT orphan the child (stdio) or
        // the HTTP session: close the transport before dropping it.
        const t = conn.transport
        conn.transport = null
        if (t) await t.close().catch((e: unknown) => {
          log.debug("mcp transport cleanup after failed connect failed", { server: conn.name, err: e })
        })
        return conn.detail
      } finally {
        conn.connecting = null
      }
    })()
    return conn.connecting
  }

  /** tools/list with cursor pagination (MCP spec: nextCursor). */
  private async listTools(session: JsonRpcSession, conn: ServerConn, signal: AbortSignal): Promise<McpToolDef[]> {
    const tools: McpToolDef[] = []
    let cursor: string | undefined
    for (let page = 0; page < 50; page++) {
      const res = await session.request<{ tools?: unknown; nextCursor?: string }>(
        "tools/list",
        cursor !== undefined ? { cursor } : {},
        conn.cfg.timeoutS * 1000,
        signal,
      )
      if (Array.isArray(res?.tools)) {
        for (const t of res.tools) {
          if (t !== null && typeof t === "object" && typeof (t as Record<string, unknown>)["name"] === "string") {
            const def = t as Record<string, unknown>
            tools.push({
              name: def["name"] as string,
              description: typeof def["description"] === "string" ? (def["description"] as string) : undefined,
              inputSchema: def["inputSchema"],
            })
          }
        }
      }
      const next = typeof res?.nextCursor === "string" ? (res.nextCursor as string) : undefined
      if (next === undefined || next.length === 0) break
      cursor = next
    }
    return tools
  }

  private buildTransport(conn: ServerConn): { session: JsonRpcSession; transport: StdioTransport | HttpTransport } {
    const cfg = conn.cfg
    if (cfg.url !== undefined) {
      const t = new HttpTransport({ name: conn.name, url: cfg.url, headers: cfg.headers ?? {} })
      return { session: this.wireSession(conn, t), transport: t }
    }
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v
    }
    delete env["SENSUS_ACTIVE"] // MCP children are not the sensus pane
    Object.assign(env, cfg.env ?? {})
    const resolved = resolveMcpServerCwd(conn.name, cfg, { cacheRoot: sensusCacheDir(), homeDir: sensusHome() })
    const t = new StdioTransport({
      name: conn.name,
      command: cfg.command ?? "",
      args: cfg.args ?? [],
      env,
      cwd: resolved.cwd,
    })
    return { session: this.wireSession(conn, t), transport: t }
  }

  /**
   * The ONE JsonRpcSession wiring: both transports plug in identically. (The
   * HTTP GET stream is not opened in v1, so server-initiated notifications
   * never arrive there — sharing the stdio handler is safe.)
   */
  private wireSession(conn: ServerConn, transport: { send(msg: JsonRpcMessage): void }): JsonRpcSession {
    return new JsonRpcSession({
      name: conn.name,
      send: (msg) => transport.send(msg),
      onNotification: (msg) => this.onNotification(conn, msg),
    })
  }

  /** Server notifications: tools/list_changed refreshes the cached list. */
  private onNotification(conn: ServerConn, msg: JsonRpcMessage): void {
    if (msg.method === "notifications/tools/list_changed" && conn.status === "connected" && conn.session) {
      void this.listTools(conn.session, conn, new AbortController().signal)
        .then((tools) => {
          conn.tools = tools
          this.bumpStatus()
        })
        .catch((e: unknown) => {
          // keep the previous list
          log.warn("mcp tools/list refresh failed; keeping previous list", { server: conn.name, err: e })
        })
    }
  }

  private markDown(conn: ServerConn, err: string): void {
    if (conn.status === "connected" || conn.status === "starting") {
      conn.status = "failed"
      conn.detail = err
      conn.tools = []
      // Self-heal later: back off before the next automatic reconnect attempt.
      conn.failures += 1
      conn.retryAt = Date.now() + mcpRetryDelayMs(conn.failures, { baseMs: this.retryBaseMs, capMs: this.retryCapMs })
      // Pending calls (e.g. tools/list racing the crash) must reject NOW,
      // not hang until their timeout.
      conn.session?.failAll(new Error(err))
      conn.session = null
      const t = conn.transport
      conn.transport = null
      // The stdio child already exited (onDown fired); close() releases the
      // pipes and is a harmless no-op kill on a dead pid.
      if (t) void t.close().catch((e: unknown) => {
        log.debug("mcp transport close after markDown failed", { server: conn.name, err: e })
      })
      this.bumpStatus()
    }
  }

  /** Execute one `mcp__<server>__<tool>` call (docs/mcp.md "Execution"). */
  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult> {
    const ref = parseWireName(name)
    if (ref === null) return { ok: false, result: `${name}: not an MCP tool name` }
    const conn = this.conns.get(ref.server)
    if (!conn) return { ok: false, result: `${name}: MCP server "${ref.server}" is not configured` }
    if (conn.status === "disabled") return { ok: false, result: `${name}: MCP server "${ref.server}" is disabled` }
    if (conn.session === null || conn.status !== "connected") {
      // The model saw the spec earlier, the server died since — reconnect
      // once on demand so a crashed server self-heals on the next call.
      const err = await this.connect(conn, signal)
      if (err !== null || conn.session === null) {
        return { ok: false, result: `${name}: MCP server "${ref.server}" unavailable (${conn.detail || err})` }
      }
    }
    const session = conn.session
    try {
      const res = await session.request<{
        content?: Array<Record<string, unknown>>
        structuredContent?: unknown
        isError?: boolean
      }>("tools/call", { name: ref.tool, arguments: args }, conn.cfg.timeoutS * 1000, signal)
      if (signal.aborted) return { ok: false, result: `${name}: aborted by user` }
      const text = flattenContent(res?.content)
      if (res?.isError === true) return { ok: false, result: text.length > 0 ? text : `${name}: tool reported an error` }
      if (text.length === 0 && res?.structuredContent !== undefined) {
        try {
          return { ok: true, result: truncateHeadTail(JSON.stringify(res.structuredContent), 16_000) }
        } catch {
          return { ok: true, result: "(empty tool result)" }
        }
      }
      return { ok: true, result: text.length === 0 ? "(empty tool result)" : text }
    } catch (e) {
      if (signal.aborted) return { ok: false, result: `${name}: aborted by user` }
      return { ok: false, result: `${name}: ${errorMessage(e)}` }
    }
  }

  /** `/reload`: diff the new config; changed servers stop + reconnect lazily. */
  async restartChanged(cfg: McpConfig | undefined): Promise<string[]> {
    const before = new Map(this.conns)
    this.rebuildConns(cfg)
    const changes: string[] = []
    for (const [name, after] of this.conns) {
      const old = before.get(name)
      if (old && old.fingerprint === after.fingerprint) continue
      // An `enabled` flip reads as on/off (the MCP manager's toggle), not a
      // generic "restarted (config changed)".
      if (old && old.cfg.enabled && !after.cfg.enabled) changes.push(`mcp ${name}: disabled`)
      else if (old && !old.cfg.enabled && after.cfg.enabled) changes.push(`mcp ${name}: enabled`)
      else if (old && old.status === "connected") changes.push(`mcp ${name}: restarted (config changed)`)
      else if (!old && after.cfg.enabled) changes.push(`mcp ${name}: added`)
    }
    for (const [name] of before) {
      if (!this.conns.has(name)) changes.push(`mcp ${name}: removed`)
    }
    return changes
  }

  /**
   * Stop one conn (transport close; pending calls reject via onDown). Never
   * rejects: rebuild paths fire it without awaiting (`void stopConn`), so a
   * transport whose close() throws must not escape as an unhandled rejection —
   * same swallow-and-log shape as `markDown`'s close.
   */
  private async stopConn(conn: ServerConn): Promise<void> {
    const t = conn.transport
    conn.session = null
    conn.transport = null
    if (!t) return
    try {
      await t.close()
    } catch (e) {
      log.debug("mcp transport close failed", { server: conn.name, err: e })
    }
  }

  /** Kill every server (exit / detach / /reload teardown). Never throws. */
  async stopAll(): Promise<void> {
    // Capture the transports BEFORE nulling the conn fields — stopConn
    // reads them, and nulling first would orphan every child (the M11
    // binary-boot stray).
    const all = [...this.conns.values()]
    const transports = all.map((c) => c.transport)
    for (const conn of all) {
      conn.status = "idle"
      conn.detail = ""
      conn.tools = []
      conn.session = null
      conn.transport = null
    }
    this.bumpStatus()
    await Promise.allSettled(transports.map((t) => (t ? t.close() : Promise.resolve())))
  }
}

/**
 * Flatten MCP tool-result content blocks to model-facing text (docs/mcp.md
 * "Result handling"): text verbatim, other block types as one-line notes so
 * the model knows something non-textual came back. Null-safe.
 */
export function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== "object") continue
    const b = block as Record<string, unknown>
    if (b["type"] === "text" && typeof b["text"] === "string") {
      parts.push(b["text"] as string)
    } else if (b["type"] === "image") {
      parts.push(`[image block: ${typeof b["mimeType"] === "string" ? (b["mimeType"] as string) : "unknown type"}]`)
    } else if (b["type"] === "audio") {
      parts.push(`[audio block: ${typeof b["mimeType"] === "string" ? (b["mimeType"] as string) : "unknown type"}]`)
    } else if (b["type"] === "resource") {
      const r = b["resource"] as Record<string, unknown> | undefined
      const uri = r && typeof r["uri"] === "string" ? (r["uri"] as string) : "unknown"
      parts.push(`[resource block: ${uri}]`)
    } else if (typeof b["type"] === "string") {
      parts.push(`[${b["type"] as string} block]`)
    }
  }
  return parts.join("\n")
}

