/**
 * Slash command dispatch extracted from ChatSession (MOVE-ONLY): the entire
 * `handleSlash` switch lives here, parameterised over `SlashHost`. ChatSession
 * implements the host with bound accessors + its existing methods, so every
 * branch, toast, overlay open and early return is byte-identical to the
 * in-class version. The slash event's JSONL append stays at the routing site in
 * `ChatSession.handleInput` (not here).
 */

import { mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { parseSelectedModel, selectedModelString, type ApprovalMode } from "../../config/config.ts"
import { matchThemeName, THEME_NAMES } from "../../theme/theme.ts"
import {
  knobDescription,
  parseThinkingMode,
  resolveThinkingKnob,
  thinkingChoices,
  type ModelMeta,
  type ThinkingKnob,
} from "../provider/modelCatalog.ts"
import { skillSlug, type SkillsCatalog } from "../skills/loader.ts"
import { errorMessage } from "../../core/util.ts"
import { formatBytes, type ImageAttachment } from "../../core/image.ts"
import type { ToolSpec } from "../tools.ts"
import type { SlashCommand } from "../slash.ts"
import { componentLogger } from "../log.ts"
import { HELP_TEXT, type ChatMessage, type ChatSessionDeps, type ChatStatus } from "./chatMessages.ts"
import { formatTokens } from "./compaction.ts"

const log = componentLogger("agent.chat")

/** `/map` bootstrap: run host_scan, then curate the draft into HOST.md. */
const MAP_INSTRUCTION =
  "Run the host_scan tool now, then use its draft to update HOST.md (the server architecture map) with the memory tool. Curate it into the fixed section template, keep only durable facts (services/ports/paths/commands/gotchas), and skip anything already covered by MEMORY.md. Report what you mapped in one short paragraph."

/**
 * The live ChatSession surface `dispatchSlash` reads/writes. Grouped by area;
 * every member is a lazy call, so signal reads and side effects stay in sync
 * with the session exactly as the in-class body did.
 */
export interface SlashHost {
  // ---- messages ----
  /** Append a system bubble to the transcript. */
  addSystem(text: string): void
  /** The live display transcript (read-only). */
  messages(): readonly ChatMessage[]
  /** Session deps (file rotate, toasts, overlays, config, memory, audit, …). */
  deps: ChatSessionDeps

  // ---- selection (model / agent / effort) ----
  selectedModel(): string
  modelName(): string
  endpointName(): string
  setModelSelection(endpoint: string, model: string): void
  agentName(): string
  setAgentSelection(name: string): void
  modelMeta(): ModelMeta | null
  effortSetting(): string
  setEffortOverride(mode: string): void
  thinkingKnob(): ThinkingKnob | null

  // ---- display state ----
  status(): ChatStatus
  approval(): ApprovalMode
  setApproval(mode: ApprovalMode): void
  thinkingMode(): "show" | "hide"
  toggleThinkingMode(): "show" | "hide"
  setThinkingMode(mode: "show" | "hide"): void
  toolDetails(): "expanded" | "collapsed"
  toggleToolDetails(): "expanded" | "collapsed"
  setToolDetails(mode: "expanded" | "collapsed"): void
  animations(): boolean
  cardStyle(): "fill" | "border"
  toggleCardStyle(): "fill" | "border"
  setCardStyle(style: "fill" | "border"): void
  compactions(): number
  totalTokens(): number

  // ---- busy / MCP / clear ----
  isCompacting(): boolean
  clearAll(): void
  runManualCompaction(): Promise<void>
  mcpEnabled(): boolean
  setMcpEnabled(on: boolean): void
  mcpStatusSummary(): string
  mcpSpecsForRequest(): ToolSpec[]
  noTools(): boolean

  // ---- context status ----
  contextEnabled(): boolean
  setContextEnabled(on: boolean): void
  contextUsed(): number
  contextLimit(): number
  cacheRead(): { cached: number; prompt: number } | null
  providerHistoryLength(): number

  // ---- draft / editor ----
  draftImages(): ImageAttachment[]
  clearDraftImages(): void
  addDraftImageFromPath(pathArg: string): { ok: true; name: string; bytes: number } | { ok: false; error: string }
  setEditorText(text: string): void
  sendMessage(text: string): Promise<void>

  // ---- pins / skills ----
  pinned(): readonly string[]
  setPinned(value: string[] | ((prev: string[]) => string[])): void
  skillCatalogForAgent(): SkillsCatalog | undefined
}

/**
 * Fire-and-forget a slash command's async work. The command returns
 * immediately, so nothing owns the promise; a rejection would surface as an
 * unhandled rejection (fatal for the headless daemon). Log it and let the
 * session carry on.
 */
function fireAndForget(promise: Promise<unknown>, command: string): void {
  void promise.catch((e: unknown) => log.warn(`slash ${command} failed`, { err: e }))
}

export function dispatchSlash(cmd: SlashCommand, host: SlashHost): void {
  switch (cmd.name) {
    case "help":
      host.addSystem(HELP_TEXT)
      return
    case "clear":
      host.clearAll()
      host.deps.rotateFile()
      host.deps.toast("chat cleared — old session file kept", "success")
      return
    case "model": {
      // /model with no arg opens the picker; with an arg it accepts
      // "<endpoint>@<model>" or a bare model id on the current endpoint.
      // The pick applies to THIS session and persists as the config
      // default for NEW sessions (docs/config.md) — other tabs are
      // untouched.
      if (cmd.arg.length === 0) {
        if (host.deps.openOverlay) host.deps.openOverlay("models")
        else host.addSystem(`selected model: ${host.selectedModel()} — /model <endpoint>@<id> or bare <id> sets it (persists)`)
        return
      }
      const parsed = parseSelectedModel(cmd.arg)
      const next =
        parsed !== null
          ? { endpoint: parsed.endpoint, model: parsed.model }
          : { endpoint: host.endpointName(), model: cmd.arg }
      const cfg = host.deps.getConfig()
      if (!(next.endpoint in cfg.endpoints)) {
        host.deps.toast(`unknown endpoint "${next.endpoint}" — pick one of: ${Object.keys(cfg.endpoints).join(", ")}`, "error", 5000)
        return
      }
      if (host.deps.setSelectedModel !== undefined) {
        const err = host.deps.setSelectedModel(next.endpoint, next.model)
        if (err !== null) {
          host.deps.toast(`model save failed: ${err}`, "error", 4500)
          return
        }
      } else {
        host.deps.toast("model persistence not wired here", "warn")
        return
      }
      host.setModelSelection(next.endpoint, next.model)
      host.deps.toast(`model → ${selectedModelString(next.endpoint, next.model)} (this session + default for new ones)`, "success")
      return
    }
    case "agent": {
      // /agent with no arg opens the picker; with an arg it switches THIS
      // session's agent and persists it as the config default for NEW
      // sessions (other tabs untouched).
      if (cmd.arg.length === 0) {
        if (host.deps.openOverlay) host.deps.openOverlay("agents")
        else host.addSystem(`agent: ${host.agentName()} — /agent <name> switches (this session + default)`)
        return
      }
      const catalog = host.deps.getAgents?.()
      if (catalog === undefined || catalog.byName[cmd.arg] === undefined) {
        const names = catalog ? Object.keys(catalog.byName).join(", ") : "(none loaded)"
        host.deps.toast(`unknown agent "${cmd.arg}" — pick one of: ${names}`, "error", 5000)
        return
      }
      if (host.deps.setDefaultAgent !== undefined) {
        const err = host.deps.setDefaultAgent(cmd.arg)
        if (err !== null) {
          host.deps.toast(`agent save failed: ${err}`, "error", 4500)
          return
        }
      } else {
        host.deps.toast("agent persistence not wired here", "warn")
        return
      }
      host.setAgentSelection(cmd.arg)
      host.deps.toast(`agent → ${cmd.arg} (this session + default for new ones; next request)`, "success")
      return
    }
    case "context": {
      if (cmd.arg !== "on" && cmd.arg !== "off") {
        host.deps.toast(`usage: /context on|off — currently ${host.contextEnabled() ? "on" : "off"}`, "warn", 4500)
        return
      }
      host.setContextEnabled(cmd.arg === "on")
      host.deps.toast(`terminal context ${cmd.arg} (per session)`)
      return
    }
    case "image": {
      // Attach an image FILE to the draft, or clear the pending attachments.
      // Clipboard paste uses the paste hotkeys (App); /image is the
      // portable path for a file copied in a file manager.
      const arg = cmd.arg.trim()
      if (arg === "clear") {
        const n = host.draftImages().length
        host.clearDraftImages()
        host.deps.toast(n > 0 ? "attachments cleared" : "no attachments to clear", "info", 2500)
        return
      }
      if (arg.length === 0) {
        host.deps.toast("usage: /image <path> attaches an image file · /image clear removes them", "warn", 4500)
        return
      }
      const res = host.addDraftImageFromPath(arg)
      if (!res.ok) {
        host.deps.toast(`/image: ${res.error}`, "error", 5000)
        return
      }
      const count = host.draftImages().length
      host.deps.toast(`attached ${res.name} (${formatBytes(res.bytes)}, ${count} image${count === 1 ? "" : "s"}) — Enter sends`, "success", 3500)
      return
    }
    case "compact": {
      if (host.status() === "streaming" || host.isCompacting()) {
        host.deps.toast("a reply or compaction is still running — Esc aborts first", "warn", 3500)
        return
      }
      fireAndForget(host.runManualCompaction(), "/compact")
      return
    }
    case "status": {
      const cfg = host.deps.getConfig()
      const used = host.contextUsed()
      const limit = host.contextLimit()
      const usedPart = used > 0 ? `${formatTokens(used)}/` : ""
      const cache = host.cacheRead()
      const cacheLine =
        cache !== null && cache.prompt > 0
          ? ` · cache: ${Math.round((cache.cached / cache.prompt) * 100)}% (${formatTokens(cache.cached)}/${formatTokens(cache.prompt)} cached)`
          : ""
      const lines = [
        "runtime status",
        `  model: ${host.endpointName()}@${host.modelName()} · ctx ${usedPart}${formatTokens(limit)}${cacheLine}`,
        `  tokens (cumulative): ${formatTokens(host.totalTokens())}`,
        `  agent: ${host.agentName()} · approval: ${host.approval()} · thinking: ${host.effortSetting()} (${knobDescription(host.thinkingKnob())}) · context injection: ${host.contextEnabled() && cfg.context.enabled ? "on" : "off"} · scrollback: ${cfg.context.scrollbackLines} lines`,
        `  thinking display: ${host.thinkingMode()} · tool output: ${host.toolDetails()} · animations: ${host.animations() ? "on" : "off"} · card style: ${host.cardStyle()}`,
        `  compactions: ${host.compactions()} · auto-compact: ${cfg.context.autoCompact ? "on" : "off"} (keep ${formatTokens(cfg.context.keepTokens)}, buffer ${formatTokens(cfg.context.bufferTokens)}${cfg.context.contextLimit > 0 ? `, limit ${formatTokens(cfg.context.contextLimit)}` : ""})`,
        `  tools: ${host.noTools() ? "unavailable (no-tools mode)" : "available"} · mcp: ${host.mcpStatusSummary()} · history: ${host.providerHistoryLength()} provider message(s)`,
      ]
      const extra = host.deps.getRuntimeStatus?.() ?? null
      if (extra !== null && extra.length > 0) lines.push(...extra.split("\n").map((l) => `  ${l}`))
      host.addSystem(lines.join("\n"))
      return
    }
    case "yolo": {
      host.setApproval(cmd.arg !== "off" ? "full-auto" : "confirm")
      return
    }
    case "sudo": {
      // Session sudo password (docs/agent.md "Sudo"): stored encrypted in
      // RAM by the popup; /sudo forget clears it. The password is never
      // shown in chat and never reaches the model.
      const arg = cmd.arg.trim().toLowerCase()
      if (arg === "forget" || arg === "clear") {
        host.deps.clearSudoPassword?.()
        host.deps.toast("sudo password forgotten for this session", "info", 3000)
        return
      }
      if (arg.length > 0) {
        host.deps.toast("usage: /sudo [forget]", "warn", 3000)
        return
      }
      if (host.deps.hasSudoPassword?.() === true) {
        host.deps.toast("sudo password is held in RAM for this session — /sudo forget clears it", "info", 5000)
      } else {
        host.deps.toast("no sudo password yet — the masked prompt appears when a command needs one", "info", 5000)
      }
      return
    }
    case "thinking": {
      // Reasoning display: /thinking toggles, or force
      // with an argument. Per-block clicks still override single blocks.
      if (cmd.arg.length === 0) {
        const next = host.toggleThinkingMode()
        host.deps.toast(`thinking display → ${next} (${next === "show" ? "reasoning expanded" : "collapsed — click a block or press Alt+T to expand"})`)
        return
      }
      if (cmd.arg !== "show" && cmd.arg !== "hide") {
        host.deps.toast(`usage: /thinking [show|hide] — currently ${host.thinkingMode()}`, "error", 4500)
        return
      }
      host.setThinkingMode(cmd.arg)
      host.deps.toast(`thinking display → ${cmd.arg}`)
      return
    }
    case "effort": {
      // Thinking-mode selection (docs/agent.md "Thinking modes"): the model's
      // models.dev metadata decides the vocabulary; /effort alone lists it.
      const meta = host.modelMeta()
      if (cmd.arg.length === 0) {
        const knob = resolveThinkingKnob(host.effortSetting(), meta)
        const choices = thinkingChoices(meta)
        const choicesLine =
          choices.length > 0
            ? `choices: ${choices.join(" · ")}`
            : "this model advertises no thinking modes — set one explicitly with /effort <mode>"
        host.addSystem(
          `thinking mode: ${host.effortSetting()} (${knobDescription(knob)})\n\n` +
            `${choicesLine}\n` +
            `/effort <mode> sets it for this session; the endpoint's thinkingMode (docs/config.md) is the fallback. ` +
            `An unset mode uses the model's highest advertised setting; "off" picks the lowest.`,
        )
        return
      }
      const parsed = parseThinkingMode(cmd.arg)
      if (parsed === null) {
        const choices = thinkingChoices(meta)
        const usage = choices.length > 0 ? `[${choices.join("|")}]` : "<effort|off|budget:<n>>"
        host.deps.toast(`usage: /effort ${usage} — currently ${host.effortSetting()}`, "error", 5000)
        return
      }
      host.setEffortOverride(cmd.arg.toLowerCase())
      return
    }
    case "details": {
      // Tool-output detail: on = expanded, off = collapsed.
      if (cmd.arg.length === 0) {
        const next = host.toggleToolDetails()
        host.deps.toast(`tool output details → ${next === "expanded" ? "on (full output)" : "off (preview, click a card or press Alt+E to expand)"}`)
        return
      }
      if (cmd.arg !== "on" && cmd.arg !== "off") {
        host.deps.toast(`usage: /details [on|off] — currently ${host.toolDetails()}`, "error", 4500)
        return
      }
      host.setToolDetails(cmd.arg === "on" ? "expanded" : "collapsed")
      host.deps.toast(`tool output details ${cmd.arg}`)
      return
    }
    case "cards": {
      // Message card style: "fill" = borderless themed panel,
      // "border" = rounded bordered card with no fill.
      if (cmd.arg.length === 0) {
        const next = host.toggleCardStyle()
        host.deps.toast(`card style → ${next}`)
        return
      }
      if (cmd.arg !== "fill" && cmd.arg !== "border") {
        host.deps.toast(`usage: /cards [fill|border] — currently ${host.cardStyle()}`, "error", 4500)
        return
      }
      host.setCardStyle(cmd.arg)
      host.deps.toast(`card style ${cmd.arg}`)
      return
    }
    case "models": {
      if (host.deps.openOverlay) {
        host.deps.openOverlay("models")
      } else {
        host.deps.toast("model picker not wired here", "warn")
      }
      return
    }
    case "ctx": {
      // Context inspector (Phase 3.1): what occupies the model's window.
      if (host.deps.openOverlay) host.deps.openOverlay("context")
      else host.addSystem("context inspector is unavailable here")
      return
    }
    case "settings": {
      if (host.deps.openOverlay) {
        host.deps.openOverlay("settings")
      } else {
        host.deps.toast("settings not wired here", "warn")
      }
      return
    }
    case "init-wizard": {
      // `/init-wizard` reopens the setup wizard as an in-app modal (docs/operations.md
      // "Setup wizard"). It is a guided shortcut over the same steps the settings
      // screen exposes — nothing here is required after first run.
      if (host.deps.openOverlay) host.deps.openOverlay("setup")
      else host.deps.toast("setup wizard not wired here", "warn")
      return
    }
    case "theme": {
      if (cmd.arg.length === 0) {
        // The picker gives live preview + search across the large registry
        // (docs/DESIGN.md). Fall back to a text listing when no UI is wired.
        if (host.deps.openOverlay) {
          host.deps.openOverlay("themes")
        } else {
          const current = host.deps.getTheme?.() ?? host.deps.getConfig().theme
          const names = THEME_NAMES.map((n) => `  ${n}${n === current ? "   ← active" : ""}`).join("\n")
          host.addSystem(`themes\n${names}\n\n/theme <name> switches live and persists (docs/config.md)`)
        }
        return
      }
      const wanted = matchThemeName(cmd.arg)
      if (wanted === null) {
        host.deps.toast(`unknown theme "${cmd.arg}" — run /theme to pick one`, "error", 4000)
        return
      }
      const err = host.deps.applyTheme?.(wanted) ?? null
      if (err !== null && err !== undefined) host.deps.toast(`theme switch failed: ${err}`, "error", 4000)
      else host.deps.toast(`theme → ${wanted} (live; persisted to config)`, "success")
      return
    }
    case "reload": {
      if (!host.deps.reloadConfig) {
        host.deps.toast("config reload not wired here", "warn")
        return
      }
      const message = host.deps.reloadConfig()
      host.deps.toast(message ?? "config reloaded", "success", 4000)
      return
    }
    case "map": {
      if (host.deps.memory === undefined || !host.deps.getConfig().memory.enabled) {
        host.deps.toast("memory is disabled — enable it first (docs/memory.md)", "warn", 5000)
        return
      }
      host.addSystem("scanning this machine (read-only) and updating HOST.md…")
      fireAndForget(host.sendMessage(MAP_INSTRUCTION), "/map")
      return
    }
    case "memory": {
      if (host.deps.openOverlay) host.deps.openOverlay("memory")
      else host.addSystem("memory manager is unavailable here (docs/memory.md)")
      return
    }
    case "skills": {
      if (host.deps.openOverlay) host.deps.openOverlay("skills")
      else host.addSystem("skills manager is unavailable here (docs/skills.md)")
      return
    }
    case "skill": {
      const catalog = host.skillCatalogForAgent()
      const def = catalog?.byName[cmd.arg]
      if (def === undefined) {
        const names = catalog?.skills.map((s) => s.name).join(", ") ?? ""
        host.deps.toast(`unknown skill "${cmd.arg}"${names.length > 0 ? ` — try: ${names}` : " (no skills installed)"}`, "warn", 5000)
        return
      }
      fireAndForget(host.sendMessage(`Use the "${def.name}" skill:\n\n${def.body}`), "/skill")
      return
    }
    case "learn": {
      const slug = skillSlug(cmd.arg) || "new-skill"
      fireAndForget(
        host.sendMessage(
          `Create a reusable skill from the procedure we just did. Write it with the write_file tool to ` +
            `~/.config/sensus/skills/${slug}/SKILL.md — frontmatter (name: ${slug}, description: <one line>) ` +
            `then a concise, GENERAL numbered procedure (no one-off values, no secrets). After writing, ` +
            `confirm the skill name and run /reload so I can see it.`,
        ),
        "/learn",
      )
      return
    }
    case "pin": {
      const last = [...host.messages()].reverse().find((m) => m.role === "assistant" && m.content.trim().length > 0)
      if (last === undefined) {
        host.deps.toast("nothing to pin yet", "warn", 3000)
        return
      }
      const fact = last.content.replace(/\s+/g, " ").trim().slice(0, 300)
      if (host.pinned().includes(fact)) {
        host.deps.toast("already pinned", "info", 2500)
        return
      }
      host.setPinned((p) => [...p, fact])
      host.deps.toast(`pinned — survives compaction (${host.pinned().length} pin(s))`, "success", 3000)
      return
    }
    case "unpin": {
      host.setPinned([])
      host.deps.toast("pinned facts cleared", "info", 2500)
      return
    }
    case "remember": {
      const fact = cmd.arg.trim()
      if (fact.length === 0) {
        host.deps.toast("usage: /remember <fact>", "warn", 4000)
        return
      }
      if (host.deps.memory === undefined || !host.deps.getConfig().memory.enabled) {
        host.deps.toast("memory is disabled (docs/memory.md)", "warn", 5000)
        return
      }
      const res = host.deps.memory.add("memory", fact)
      host.deps.toast(res.message, res.ok ? "success" : "error", res.ok ? 3000 : 6000)
      return
    }
    case "usage": {
      if (host.deps.openOverlay) host.deps.openOverlay("usage")
      else host.addSystem("usage dashboard is unavailable here")
      return
    }
    case "keys": {
      if (host.deps.openOverlay) host.deps.openOverlay("keymap")
      else host.addSystem("keybinding editor is unavailable here")
      return
    }
    case "edit": {
      const lastUser = [...host.messages()].reverse().find((m) => m.role === "user" && m.content.trim().length > 0)
      if (lastUser === undefined) {
        host.deps.toast("no message to edit yet", "warn", 3000)
        return
      }
      host.setEditorText(lastUser.content)
      host.deps.toast("loaded the last message — edit and Enter to resend", "info", 4000)
      return
    }
    case "retry": {
      const lastUser = [...host.messages()].reverse().find((m) => m.role === "user" && m.content.trim().length > 0)
      if (lastUser === undefined) {
        host.deps.toast("nothing to retry yet", "warn", 3000)
        return
      }
      host.deps.toast("asking again…", "info", 2500)
      fireAndForget(host.sendMessage(lastUser.content), "/retry")
      return
    }
    case "find": {
      const query = cmd.arg.trim().toLowerCase()
      if (query.length === 0) {
        host.deps.toast("usage: /find <text>", "warn", 4000)
        return
      }
      const hits = host.messages().filter((m) => m.content.toLowerCase().includes(query))
      if (hits.length === 0) {
        host.addSystem(`no messages match "${cmd.arg}"`)
        return
      }
      host.addSystem(
        `matches for "${cmd.arg}" (${hits.length})\n` +
          hits
            .slice(-12)
            .map((m) => {
              const one = m.content.replace(/\s+/g, " ").trim()
              const at = one.toLowerCase().indexOf(query)
              const start = Math.max(0, at - 30)
              return `  [${m.role}] …${one.slice(start, start + 120)}…`
            })
            .join("\n"),
      )
      return
    }
    case "undo": {
      const bridge = host.deps.audit
      if (bridge === undefined) {
        host.deps.toast("undo is not available in this session", "warn", 4000)
        return
      }
      const entry = bridge.lastUndoable()
      if (entry === null || entry.path === undefined) {
        host.deps.toast("nothing to undo", "info", 3000)
        return
      }
      try {
        if (entry.before === null || entry.before === undefined) {
          unlinkSync(entry.path)
        } else {
          mkdirSync(dirname(entry.path), { recursive: true })
          writeFileSync(entry.path, entry.before, "utf8")
        }
        bridge.markUndone(entry.ts)
        host.deps.toast(`undid ${entry.tool} on ${entry.path}`, "success", 5000)
      } catch (e) {
        host.deps.toast(`undo failed: ${errorMessage(e)}`, "error", 5000)
      }
      return
    }
    case "audit": {
      const n = Number.parseInt(cmd.arg, 10)
      const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 20
      const entries = host.deps.audit?.recent(limit) ?? []
      if (entries.length === 0) {
        host.addSystem("audit log is empty (nothing state-changing recorded yet)")
        return
      }
      host.addSystem(
        `audit (last ${entries.length})\n` +
          entries
            .map((e) => {
              const when = new Date(e.ts).toISOString().replace("T", " ").slice(0, 19)
              const ok = e.ok ? "ok " : "ERR"
              return `  ${when} ${ok} [${e.kind}] ${e.summary}`
            })
            .join("\n"),
      )
      return
    }
    case "sessions": {
      if (host.deps.openOverlay) host.deps.openOverlay("sessions")
      else host.addSystem("session search is unavailable here")
      return
    }
    case "mcp": {
      // MCP servers (M11): no arg = status, on|off = session toggle.
      if (cmd.arg !== "" && cmd.arg !== "on" && cmd.arg !== "off") {
        host.deps.toast(`usage: /mcp [on|off] — currently ${host.mcpEnabled() ? "on" : "off"}`, "warn", 4500)
        return
      }
      if (cmd.arg === "on" || cmd.arg === "off") {
        host.setMcpEnabled(cmd.arg === "on")
        return
      }
      const registry = host.deps.mcp
      const lines = ["mcp servers (docs/mcp.md)"]
      if (!host.mcpEnabled()) lines.push("  session toggle: OFF (/mcp on re-enables)")
      if (!registry) {
        lines.push("  no registry wired (tests?)")
      } else {
        const status = registry.statusLines()
        if (status.length === 0) lines.push("  none configured — add mcp.servers to config.json (/reload)")
        else lines.push(...status.map((l) => `  ${l}`))
        const specs = host.mcpSpecsForRequest()
        if (specs.length > 0) lines.push(`  ${specs.length} tool(s) merged into requests`)
        if (status.some((l) => l.includes(": idle") || l.includes(": starting"))) {
          lines.push("  (servers connect lazily on the next message — docs/mcp.md)")
        }
      }
      host.addSystem(lines.join("\n"))
      return
    }
    default:
      host.deps.toast(`unknown command /${cmd.name === "" ? cmd.raw : cmd.name} — /help lists the commands`, "error", 4500)
      return
  }
}
