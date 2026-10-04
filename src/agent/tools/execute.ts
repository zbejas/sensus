import { errorMessage } from "../../core/util.ts"
import { agentKeyAction } from "../../terminal/keys.ts"
import { verifyPaneDelivery, type DeliveryVerdict } from "../../terminal/delivery.ts"
import {
  formatPaneEvidence,
  paneStateRefusal,
  paneStateSummary,
  type PaneState,
} from "../../terminal/paneState.ts"
import { abortableSleep } from "../processUtil.ts"
import { isMcpToolName } from "../mcp/types.ts"
import { createSudoAskpass, sudoAskpassBroker } from "../sudoAskpass.ts"
import { MAX_IMAGE_BYTES, formatBytes, readImageAttachment } from "../../core/image.ts"
import { isRewritableTarget, type MemoryResult, type MemoryTarget, type MemoryToolBridge } from "../memory/types.ts"
import { formatHostScan, HOST_SCAN_COMMANDS, type HostScanEntry } from "../memory/hostScan.ts"
import { truncateToolOutput } from "../truncate.ts"
import { skillsIndexText } from "../skills/loader.ts"
import { readTextWindow } from "./readFile.ts"
import {
  commandAllSudoNonInteractive,
  commandHasNonInteractiveSudo,
  commandUsesSudo,
  commandWithSudoAskpass,
  commandWithSudoStdin,
  countSudoInvocations,
  isSudoPasswordFailure,
  isSudoPasswordRejection,
} from "./sudo.ts"
import {
  checkBackgroundJob,
  killBackgroundJob,
  runCommandResultText,
  runHiddenCommand,
  startBackgroundJob,
} from "./jobs.ts"
import { resolveToolPath } from "./parse.ts"
import { argString, numArg } from "./filePlan.ts"
import type { IndexedSession, SessionView, SessionViewMessage } from "../../session/indexDb.ts"
import type { AgentPane, RunCommandResult, ToolContext, ToolExecution } from "./types.ts"
import { componentLogger } from "../log.ts"

const log = componentLogger("agent.tools")

// ---- Executors -------------------------------------------------------------

/**
 * Guidance appended when a `-n`/`--non-interactive` sudo fails. `-n` forbids
 * the password helper, and the tty-less hidden shell has no sudo ticket, so
 * such a command can never authenticate — the model must re-run it with plain
 * `sudo`.
 */
const SUDO_NONINTERACTIVE_GUIDANCE =
  "\n(This sudo used -n/--non-interactive, which never prompts — the hidden shell has no sudo ticket, so it cannot authenticate. Re-run it as plain `sudo <cmd>` (without -n); sensus uses the session password cache or prompts once. The cached password was left untouched.)"

/** Total password SUBMISSIONS allowed in one `shell_background` call (the
 * cached password counts as the first). Enough to recover from a typo without
 * re-prompting forever. */
const MAX_SUDO_PASSWORD_ATTEMPTS = 3

/** Popup hint shown when re-asking after sudo refused the previous password. */
const SUDO_RETRY_HINT = "wrong password — try again"

/**
 * One-line ticket note appended to a privileged call so the agent can order its
 * commands and stop re-prompting (task #22). sudo's timestamp is the
 * `/etc/sudoers` default (`timestamp_timeout`, usually 15 min); a hidden shell
 * has no tty, so sensus authenticates through the askpass broker regardless.
 */
const SUDO_TICKET_NOTE =
  "\n(sudo ticket: authenticated via the askpass broker; sudo's default ticket lasts about 15 minutes (timestamp_timeout), after which a fresh password is needed.)"

/** Lines of pane scrollback the `shell_session` rejection check reads. */
const PANE_SUDO_LINES = 40
/** How long (ms) the `shell_session` rejection check polls before giving up. */
const PANE_SUDO_WAIT_MS = 1600

/** Pane screen lines read for the pane-state pre-flight / refusal evidence. */
const PANE_STATE_LINES = 10
/** How long (ms) the post-type delivery acknowledgement polls, best-effort. */
const DELIVERY_WAIT_MS = 400
/** Poll cadence for the delivery acknowledgement. */
const DELIVERY_POLL_MS = 80

const PREVIEW_LIMIT = 1200

const previewOf = (s: string): string => (s.length > PREVIEW_LIMIT ? `${s.slice(0, PREVIEW_LIMIT)}…` : s)

/** Read the structured pane state via the optional pane probe (never throws). */
function readPaneState(pane: AgentPane | null, tailLines = PANE_STATE_LINES): PaneState | null {
  if (pane === null) return null
  const fn = pane.paneState
  if (typeof fn !== "function") return null
  try {
    return fn.call(pane, tailLines)
  } catch (e) {
    log.debug("pane state probe threw", { err: e })
    return null
  }
}

/**
 * Acknowledge a `shell_session` write: poll the live screen for a bounded
 * window and classify whether the typed line actually landed (echo/prompt
 * anchored). Missing evidence is `"unverified"` — never a hard failure, and
 * never a new blocking wait (a few hundred ms, then best-effort).
 */
async function verifyDeliveryBounded(
  ctx: ToolContext,
  text: string,
  before: readonly string[] | null,
): Promise<DeliveryVerdict> {
  const pane = ctx.pane
  if (pane === null || before === null || typeof pane.paneState !== "function") return "unverified"
  const deadline = Date.now() + DELIVERY_WAIT_MS
  let verdict: DeliveryVerdict = "unverified"
  for (;;) {
    const after = readPaneState(pane)?.tail ?? null
    if (after !== null) {
      verdict = verifyPaneDelivery({ text, before, after, submitted: true })
      if (verdict === "delivered") return "delivered"
    }
    if (ctx.signal.aborted || Date.now() >= deadline) return verdict
    try {
      await abortableSleep(DELIVERY_POLL_MS, ctx.signal)
    } catch (e) {
      log.debug("shell_session delivery poll sleep failed", { err: e })
      return verdict
    }
  }
}

/**
 * `session_view` per-message body cap. A single huge message must not crowd
 * the rest of the window out of the model's context; the whole result is still
 * capped once at the tool boundary. Paging (offset/limit) is the primary guard
 * against reading a giant transcript.
 */
const SESSION_VIEW_MESSAGE_CHARS = 2000

/** `YYYY-MM-DD HH:MM` (UTC) for a transcript timestamp; `unknown time` when absent. */
function formatSessionTs(ts: number | null): string {
  if (ts === null || !Number.isFinite(ts)) return "unknown time"
  try {
    return new Date(ts).toISOString().slice(0, 16).replace("T", " ")
  } catch (e) {
    log.debug("session timestamp format failed", { ts, err: e })
    return "unknown time"
  }
}

/** One `session_list` row: id · time · count · title · tags. */
function formatSessionListRow(s: IndexedSession): string {
  const title = s.title.length > 0 ? ` · "${s.title}"` : ""
  const tags = s.tags.length > 0 ? ` · tags: ${s.tags.join(", ")}` : ""
  return `${s.sessionId} · ${formatSessionTs(s.lastTs)} · ${s.messages} msg${title}${tags}`
}

/** One `session_view` message block; the body is clipped per message. */
function formatSessionMessage(m: SessionViewMessage): string {
  const body = m.content.trim()
  const clipped =
    body.length > SESSION_VIEW_MESSAGE_CHARS
      ? `${body.slice(0, SESSION_VIEW_MESSAGE_CHARS)}\n… (+${body.length - SESSION_VIEW_MESSAGE_CHARS} chars clipped)`
      : body
  return `[${m.index} ${m.role}] ${formatSessionTs(m.ts)}\n${clipped}`
}

const MEMORY_ACTIONS = new Set(["add", "replace", "remove", "list", "read", "rewrite"])
const MEMORY_TARGETS = new Set(["memory", "host", "journal"])

/**
 * The `memory` tool (docs/memory.md): validate action/target, then delegate to
 * the store bridge. Pure dispatch — the bridge owns caps, matching and safety.
 * `rewrite` commits a whole-store body the MODEL supplied (memory/host only);
 * no separate provider pass is involved.
 */
export async function executeMemoryTool(
  bridge: MemoryToolBridge,
  args: Record<string, unknown>,
): Promise<ToolExecution> {
  const action = argString(args, "action") ?? ""
  const target = argString(args, "target") ?? ""
  if (!MEMORY_ACTIONS.has(action)) {
    return { ok: false, result: `memory: unknown action "${action}" (add|replace|remove|list|read|rewrite)`, preview: "bad action" }
  }
  if (!MEMORY_TARGETS.has(target)) {
    return { ok: false, result: `memory: unknown target "${target}" (memory|host|journal)`, preview: "bad target" }
  }
  const t = target as MemoryTarget
  let res: MemoryResult
  try {
    switch (action) {
      case "list":
        res = bridge.list(t)
        break
      case "read":
        res = bridge.readResult(t)
        break
      case "add":
        res = bridge.add(t, argString(args, "content") ?? "")
        break
      case "replace":
        res = bridge.replace(t, argString(args, "old_text") ?? "", argString(args, "content") ?? "")
        break
      case "rewrite": {
        if (!isRewritableTarget(t)) {
          return {
            ok: false,
            result: `memory: ${t} is append-only and ring-trims automatically — rewrite applies to memory or host`,
            preview: "rewrite unsupported",
          }
        }
        res = bridge.rewrite(t, argString(args, "content") ?? "")
        break
      }
      default:
        res = bridge.remove(t, argString(args, "old_text") ?? "")
        break
    }
  } catch (e) {
    return { ok: false, result: `memory: ${errorMessage(e)}`, preview: "memory failed" }
  }
  const exec: ToolExecution = { ok: res.ok, result: res.message, preview: previewOf(res.message) }
  if (res.write !== undefined) exec.memoryWrite = res.write
  return exec
}

/** Is this a mutating memory action (subject to memory.writeApproval)? */
export function isMemoryWrite(name: string, args: Record<string, unknown>): boolean {
  if (name !== "memory") return false
  const action = String(args["action"] ?? "")
  return action === "add" || action === "replace" || action === "remove" || action === "rewrite"
}

/**
 * `host_scan` (docs/memory.md): run the READ-ONLY whitelist through the hidden
 * shell, then render a redacted draft for the agent to curate into HOST.md.
 * Never throws; an aborted signal stops the pass early.
 */
export async function runHostScan(ctx: ToolContext): Promise<ToolExecution> {
  const entries: HostScanEntry[] = []
  for (const command of HOST_SCAN_COMMANDS) {
    if (ctx.signal.aborted) break
    let output = ""
    let ok = false
    try {
      const r = await runHiddenCommand({ command, cwd: ctx.paneCwd, timeoutS: 20, signal: ctx.signal })
      output = r.output
      ok = r.exitCode === 0 && !r.aborted && !r.timedOut
    } catch (e) {
      ok = false
      log.debug("host_scan probe command failed", { command, err: e })
    }
    entries.push({ command, output, ok })
  }
  const draft = formatHostScan(entries, { cwd: ctx.paneCwd })
  return { ok: true, result: draft, preview: previewOf(draft) }
}

/**
 * Resolve a sudo password for a `shell_session` command via the session seam
 * (cache, else the masked popup). Resolves null if the popup is declined or the
 * generation aborts while it is open — the popup may outlive the abort.
 */
async function resolveSudoPassword(ctx: ToolContext, command: string): Promise<string | null> {
  if (ctx.requestSudo === undefined) return null
  return Promise.race([
    ctx.requestSudo(command),
    new Promise<null>((resolveNull) => {
      if (ctx.signal.aborted) resolveNull(null)
      else ctx.signal.addEventListener("abort", () => resolveNull(null), { once: true })
    }),
  ])
}

/**
 * Await a bounded pane check after a `shell_session` sudo command was typed:
 * did the visible pane report that sudo REJECTED the password? `before` is the
 * scrollback snapshot taken BEFORE typing — if it already contains a rejection
 * we cannot attribute any later one to this command, so the result is
 * "unknown" (never a false rejection). Polls the pane's bounded ring until a
 * rejection appears or `PANE_SUDO_WAIT_MS` elapses. Never throws.
 *
 * LIMITATION: the ring is bounded and shared with the user's own typing, so
 * this is a best-effort, time-bounded heuristic, not a guarantee. A rejection
 * that scrolls off the ring, arrives after the window, or comes from an
 * earlier command reads as "clear"/"unknown"; the caller treats both the same
 * (the softer note). "rejected" means a genuinely NEW rejection line appeared
 * after the before-snapshot.
 */
async function checkPaneSudoOutcome(
  ctx: ToolContext,
  before: string,
  ms = PANE_SUDO_WAIT_MS,
): Promise<"rejected" | "clear" | "unknown"> {
  const pane = ctx.pane
  if (pane === null) return "unknown"
  if (isSudoPasswordRejection(before)) return "unknown"
  const deadline = Date.now() + ms
  while (!ctx.signal.aborted && Date.now() < deadline) {
    let raw = ""
    try {
      raw = await pane.captureScrollbackRaw(PANE_SUDO_LINES)
    } catch (e) {
      log.debug("shell_session sudo rejection scrollback read failed", { err: e })
      return "unknown"
    }
    if (isSudoPasswordRejection(raw)) return "rejected"
    await abortableSleep(200, ctx.signal)
  }
  return ctx.signal.aborted ? "unknown" : "clear"
}

/**
 * Run a tool whose execution needs no approval gate: shell_background,
 * shell_session, read_file, get_scrollback. edit_file/write_file go through
 * planFile* + applyFilePlan in the loop (approval first, then the write).
 */
/**
 * Truncation direction per tool: shell-like output keeps its TAIL (errors and
 * the exit status live at the end); everything else keeps its HEAD.
 */
function truncationDirection(name: string): "head" | "tail" {
  return name === "shell_background" || name === "get_scrollback" ? "tail" : "head"
}

/** Cap a tool result at the configured limits and spill the full text (P0). */
function capToolExecution(exec: ToolExecution, name: string, ctx: ToolContext): ToolExecution {
  // Image loads carry bytes in `images`, not the text result.
  if (name === "view_image") return exec
  const r = truncateToolOutput(exec.result, {
    limits: ctx.toolOutput,
    direction: truncationDirection(name),
    dir: ctx.toolOutputDir ?? null,
  })
  if (!r.truncated) return exec
  return { ...exec, result: r.content, truncated: true, ...(r.outputPath !== undefined ? { outputPath: r.outputPath } : {}) }
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecution> {
  const exec = await executeToolInner(name, args, ctx)
  return capToolExecution(exec, name, ctx)
}

async function executeToolInner(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecution> {
  try {
    switch (name) {
      case "memory": {
        if (ctx.memory === undefined) {
          return { ok: false, result: "memory: unavailable (memory is disabled)", preview: "memory unavailable" }
        }
        return await executeMemoryTool(ctx.memory, args)
      }
      case "host_scan":
        return runHostScan(ctx)
      case "skills_list": {
        const catalog = ctx.skills
        if (catalog === undefined) {
          return { ok: false, result: "skills_list: unavailable (no skills loaded)", preview: "skills unavailable" }
        }
        const text =
          catalog.skills.length === 0
            ? `(no skills installed — add SKILL.md files under ~/.config/sensus/skills/)`
            : skillsIndexText(catalog)
        return { ok: true, result: text, preview: previewOf(text) }
      }
      case "skill_view": {
        const catalog = ctx.skills
        const name = (argString(args, "name") ?? "").trim()
        const def = catalog?.byName[name]
        if (catalog === undefined || def === undefined) {
          return { ok: false, result: `skill_view: unknown skill "${name}" (use skills_list)`, preview: "unknown skill" }
        }
        const body = def.body.length > 0 ? def.body : `(${def.name} has an empty body)`
        return { ok: true, result: body, preview: previewOf(body) }
      }
      case "reload": {
        // The agent can apply config/AGENTS.md/agents/skills/MCP edits itself
        // (the /reload action) instead of typing /reload into the user's pane.
        if (ctx.reloadConfig === undefined) {
          return { ok: false, result: "reload: unavailable here (no config host wired)", preview: "reload unavailable" }
        }
        const message = ctx.reloadConfig()
        if (message === null) {
          return { ok: false, result: "reload: config reload failed — see the toast for details", preview: "reload failed" }
        }
        return { ok: true, result: message, preview: previewOf(message) }
      }
      case "session_search": {
        if (ctx.sessionSearch === undefined) {
          return { ok: false, result: "session_search: unavailable (session index not wired)", preview: "session search unavailable" }
        }
        const query = (argString(args, "query") ?? "").trim()
        if (query.length === 0) {
          return { ok: false, result: "session_search: empty query", preview: "empty query" }
        }
        const sessionArg = argString(args, "session")
        const session = sessionArg !== null && sessionArg.trim().length > 0 ? sessionArg.trim() : undefined
        const limit = numArg(args["limit"]) ?? undefined
        const offset = numArg(args["offset"]) ?? undefined
        let hits
        try {
          hits = ctx.sessionSearch.search(query, limit, session, offset)
        } catch (e) {
          const msg = `session_search: ${errorMessage(e)}`
          return { ok: false, result: msg, preview: previewOf(msg) }
        }
        if (hits.length === 0) {
          const text = `no past messages match "${query}"${session !== undefined ? ` in ${session}` : ""}`
          return { ok: true, result: text, preview: text }
        }
        const lines = hits.map((h) => `[${h.role}] ${h.sessionId} #${h.messageIndex} · ${h.snippet}`)
        const result = `session_search "${query}" — ${hits.length} match(es)\n${lines.join("\n")}`
        return { ok: true, result, preview: previewOf(lines[0] ?? result) }
      }
      case "session_list": {
        if (ctx.sessionSearch === undefined) {
          return { ok: false, result: "session_list: unavailable (session index not wired)", preview: "session list unavailable" }
        }
        const limit = numArg(args["limit"]) ?? undefined
        const offsetRaw = numArg(args["offset"])
        const offset = offsetRaw ?? undefined
        let rows: IndexedSession[]
        try {
          rows = ctx.sessionSearch.list(limit, offset)
        } catch (e) {
          const msg = `session_list: ${errorMessage(e)}`
          return { ok: false, result: msg, preview: previewOf(msg) }
        }
        const effOffset = offsetRaw !== null && offsetRaw > 0 ? Math.floor(offsetRaw) : 0
        if (rows.length === 0) {
          const text = effOffset > 0 ? `no more sessions at offset ${effOffset}` : "no past sessions yet"
          return { ok: true, result: text, preview: text }
        }
        const lines = rows.map(formatSessionListRow)
        const result = `session_list — ${rows.length} session(s) at offset ${effOffset}\n${lines.join("\n")}`
        return { ok: true, result, preview: previewOf(lines[0] ?? result) }
      }
      case "session_view": {
        if (ctx.sessionSearch === undefined) {
          return { ok: false, result: "session_view: unavailable (session index not wired)", preview: "session view unavailable" }
        }
        if (ctx.sessionSearch.readSession === undefined) {
          return { ok: false, result: "session_view: unavailable (transcript reader not wired)", preview: "session view unavailable" }
        }
        const session = (argString(args, "session") ?? "").trim()
        if (session.length === 0) {
          return { ok: false, result: "session_view: missing session (an id/path substring from session_list)", preview: "missing session" }
        }
        const offset = numArg(args["offset"]) ?? 0
        const limit = numArg(args["limit"]) ?? undefined
        let view: SessionView | null
        try {
          view = ctx.sessionSearch.readSession(session, offset, limit)
        } catch (e) {
          const msg = `session_view: ${errorMessage(e)}`
          return { ok: false, result: msg, preview: previewOf(msg) }
        }
        if (view === null) {
          const msg = `session_view: no past session matches "${session}" (use session_list to find one)`
          return { ok: false, result: msg, preview: previewOf(msg) }
        }
        if (view.total === 0) {
          const text = `session ${view.sessionId} ("${view.title}") has no messages`
          return { ok: true, result: text, preview: text }
        }
        if (view.messages.length === 0) {
          const text = `no messages at offset ${view.offset} — session ${view.sessionId} ("${view.title}") has ${view.total}`
          return { ok: true, result: text, preview: text }
        }
        const first = view.messages[0]
        const last = view.messages[view.messages.length - 1]
        const from = first !== undefined ? first.index : view.offset
        const to = last !== undefined ? last.index : from
        const nextOffset = to + 1
        const tags = view.tags.length > 0 ? ` · tags: ${view.tags.join(", ")}` : ""
        const header = `session_view ${view.sessionId} — "${view.title}" · ${view.total} message(s) · showing #${from}-#${to}${tags}`
        const footer =
          nextOffset < view.total
            ? `\n\n(more messages — call session_view again with session "${view.sessionId}" and offset ${nextOffset})`
            : ""
        const result = `${header}\n\n${view.messages.map(formatSessionMessage).join("\n\n")}${footer}`
        return { ok: true, result, preview: previewOf(result) }
      }
      case "shell_background": {
        const jobRaw = args["job"]
        if (typeof jobRaw === "number" && Number.isFinite(jobRaw)) {
          const jobId = Math.floor(jobRaw)
          if (args["kill"] === true) {
            const k = killBackgroundJob(jobId)
            return k.ok
              ? { ok: true, result: `killed job #${jobId}`, preview: `killed job #${jobId}` }
              : { ok: false, result: k.error ?? "kill failed", preview: previewOf(k.error ?? "") }
          }
          const rep = await checkBackgroundJob(jobId, {
            wait: args["wait"] === true,
            timeoutS: numArg(args["timeout_s"]) ?? undefined,
            signal: ctx.signal,
          })
          if (!rep.ok) return { ok: false, result: rep.error ?? "job check failed", preview: previewOf(rep.error ?? "") }
          const lines: string[] = []
          if (rep.running === true) lines.push("still running")
          if (rep.timedOut === true) lines.push("(timed out — process killed)")
          lines.push(rep.exitCode === null ? "exit ? (running/killed)" : `exit ${rep.exitCode}`)
          const out = rep.output ?? ""
          lines.push(out.length === 0 ? "(no new output)" : out)
          const text = lines.join("\n")
          return { ok: true, result: text, preview: previewOf(text), exitCode: rep.exitCode ?? null }
        }
        const command = argString(args, "command") ?? ""
        if (command.trim().length === 0) return { ok: false, result: "shell_background: empty command", preview: "empty command" }
        if (args["background"] === true) {
          const cwdArg = argString(args, "cwd")
          const cwd = cwdArg !== null && cwdArg.length > 0 ? resolveToolPath(cwdArg, ctx.paneCwd) : ctx.paneCwd
          const jobId = await startBackgroundJob({ command, cwd, owner: ctx.jobScope })
          return {
            ok: true,
            result: `started background job #${jobId} (shell_background with job: ${jobId} reports status/new output; kill: true stops it)`,
            preview: `▶ job #${jobId}`,
          }
        }
        const toRaw = args["timeout_s"]
        const timeoutS = typeof toRaw === "number" && Number.isFinite(toRaw) && toRaw > 0 ? toRaw : undefined
        const cwdArg = argString(args, "cwd")
        const cwd = cwdArg !== null && cwdArg.length > 0 ? resolveToolPath(cwdArg, ctx.paneCwd) : ctx.paneCwd
        const runOpts = { command, cwd, timeoutS, signal: ctx.signal }

        /** Resolve the sudo password via the seam; abort resolves as null (the
         * popup can outlive the generation's abort — the user may be slow).
         * `hint` lets a re-prompt explain WHY it is asking again. */
        const resolveSudo = async (hint?: string): Promise<string | null> => {
          if (ctx.requestSudo === undefined) return null
          return Promise.race([
            ctx.requestSudo(command, hint),
            new Promise<null>((resolveNull) => {
              if (ctx.signal.aborted) resolveNull(null)
              else ctx.signal.addEventListener("abort", () => resolveNull(null), { once: true })
            }),
          ])
        }
        /** Run the command with every sudo authenticated by askpass (`sudo -A`;
         * fallback `sudo -S`), never putting the password on the command's own
         * stdin. `SUDO_ASKPASS` is exported for the WHOLE call (not just the
         * rewritten word), so a sudo in any position the rewrite misses still
         * authenticates: the hidden shell has no tty, so sudo falls back to the
         * askpass program. */
        const runWithSudo = async (password: string): Promise<RunCommandResult> => {
          const askpass = createSudoAskpass(password)
          try {
            if (askpass !== null) {
              return await runHiddenCommand({
                ...runOpts,
                command: commandWithSudoAskpass(command),
                env: { SUDO_ASKPASS: askpass.helperPath },
              })
            }
            const sudoLines = Math.max(1, countSudoInvocations(command))
            return await runHiddenCommand({
              ...runOpts,
              command: commandWithSudoStdin(command),
              stdinData: `${password}\n`.repeat(sudoLines),
            })
          } finally {
            askpass?.cleanup()
          }
        }

        // Prove the credential broker is reachable BEFORE running (task #22):
        // when the command invokes sudo ANYWHERE and a popup/cache seam exists,
        // resolve the password up front. A hidden shell has no tty, so a bare
        // sudo can only fail with "a terminal is required"; asking first means a
        // decline fails fast instead of running the command bare. A cached
        // password is used with no popup, exactly as before.
        let asked = false
        // Password SUBMISSIONS = times the command was run with a password; the
        // cached password (if any) counts as the first.
        let submissions = 0
        let startedWithPassword = false
        let r: RunCommandResult
        const wantsSudo = commandUsesSudo(command) && !commandAllSudoNonInteractive(command)
        const prePassword = wantsSudo && ctx.requestSudo !== undefined ? await resolveSudo() : null
        if (wantsSudo && ctx.requestSudo !== undefined && (prePassword === null || prePassword.length === 0)) {
          const msg =
            "shell_background: this command needs sudo anywhere in the line, but no password was provided " +
            "(the sudo prompt was declined/cancelled), so the command was NOT run. " +
            "Do not retry unchanged — ask the user to run it in their terminal, or approve the sudo prompt."
          return { ok: false, result: msg, preview: "sudo password declined" }
        }
        if (prePassword !== null && prePassword.length > 0) {
          asked = true
          startedWithPassword = true
          submissions = 1
          r = await runWithSudo(prePassword)
        } else {
          r = await runHiddenCommand(runOpts)
        }

        // Handle a sudo password failure in the OUTPUT, regardless of the exit
        // code: a trailing `echo "rc=$?"` masks the real status. Skip the
        // popup only when EVERY sudo is `-n` (nothing can be rescued); a mixed
        // line is retried so its plain sudo's authenticate.
        if (!r.timedOut && !r.aborted && commandUsesSudo(command) && isSudoPasswordFailure(r.output)) {
          if (commandAllSudoNonInteractive(command)) {
            const text = runCommandResultText(r) + SUDO_NONINTERACTIVE_GUIDANCE
            return { ok: r.exitCode === 0, result: text, preview: previewOf(text), exitCode: r.exitCode }
          }
          let rejected = isSudoPasswordRejection(r.output)
          // A cached password that was never TRIED (a nested/unrewritten sudo,
          // a missing askpass) is KEPT — only a real rejection clears it.
          if (startedWithPassword && !rejected) {
            const extra = commandHasNonInteractiveSudo(command)
              ? SUDO_NONINTERACTIVE_GUIDANCE
              : "\n(sudo still needs a password; the cached password was kept — a nested sudo may need a different form.)"
            const text = runCommandResultText(r) + extra
            return { ok: r.exitCode === 0, result: text, preview: previewOf(text), exitCode: r.exitCode }
          }
          // Re-prompt loop: a wrong password is NOT a cancellation. Drop the
          // bad cached password, ask again with a hint explaining WHY, and retry
          // the rewritten command — bounded so a fat-fingered user can recover
          // without an infinite prompt loop. A rejection keeps asking; a
          // decline/abort stops with the rejection text intact.
          if (rejected) ctx.onSudoRejected?.()
          while (submissions < MAX_SUDO_PASSWORD_ATTEMPTS && !ctx.signal.aborted) {
            const password = await resolveSudo(rejected ? SUDO_RETRY_HINT : undefined)
            if (ctx.requestSudo !== undefined) asked = true
            if (password === null || password.length === 0) break
            submissions++
            r = await runWithSudo(password)
            if (!isSudoPasswordFailure(r.output)) {
              const text = runCommandResultText(r) + SUDO_TICKET_NOTE
              return { ok: !r.timedOut, result: text, preview: previewOf(text), exitCode: r.exitCode }
            }
            if (!isSudoPasswordRejection(r.output)) {
              // The password was never tried (a nested or unrewritten sudo, a
              // missing askpass). KEEP the vault and explain.
              const text =
                runCommandResultText(r) +
                "\n(sudo still needs a password; the cached password was kept — a nested or -n sudo may need a different form.)"
              return { ok: false, result: text, preview: previewOf(text), exitCode: r.exitCode }
            }
            rejected = true
            ctx.onSudoRejected?.()
          }
          // sudo TRIED the password and refused it (or kept refusing): the
          // entered password was incorrect. This is NOT a decline/cancel, so
          // the model must never be told the user declined.
          if (isSudoPasswordRejection(r.output)) {
            const text =
              runCommandResultText(r) +
              "\n(sudo rejected the entered password as incorrect (not accepted) — this is NOT a cancellation or a decline. Ask the user to re-enter the password, or run the command themselves in their terminal; do not retry the same password.)"
            return { ok: false, result: text, preview: previewOf(text), exitCode: r.exitCode }
          }
          // No password obtainable: keep the original failure, add guidance.
          const guidance =
            "\n(The command needs the user's sudo password. Ask the user to run it themselves in their " +
            (asked ? "terminal (the sudo prompt was declined/cancelled)" : "terminal, or to approve the sudo prompt") +
            " — do NOT retry unchanged.)"
          const text = runCommandResultText(r) + guidance
          return { ok: false, result: text, preview: previewOf(text), exitCode: r.exitCode }
        }
        if (r.aborted) return { ok: false, result: "aborted by user (process killed)", preview: "aborted by user", exitCode: null }
        const text = runCommandResultText(r) + (submissions > 0 ? SUDO_TICKET_NOTE : "")
        return { ok: !r.timedOut, result: text, preview: previewOf(text), exitCode: r.exitCode }
      }
      case "shell_session": {
        const text = argString(args, "text") ?? ""
        const enter = args["enter"] === true
        const rawKeys = args["keys"]
        const keys = Array.isArray(rawKeys) ? rawKeys.map((k) => String(k)) : []
        if (!ctx.pane) return { ok: false, result: "shell_session: no visible pane attached", preview: "no visible pane" }
        if (text.length === 0 && keys.length === 0 && !enter) {
          return { ok: false, result: "shell_session: nothing to type", preview: "nothing to type" }
        }
        // Pre-flight (tasks #20/#21): never type into a pane that is NOT at a
        // prompt. The live screen knows about a dquote>/quote>/heredoc>
        // continuation (the 2026-09-28 swallow), a foreground command still
        // running, a waiting sudo/SSH password prompt, or a full-screen app.
        // Unknown => proceed: we do not refuse on a guess.
        const pre = readPaneState(ctx.pane)
        const refusal = paneStateRefusal(pre)
        if (refusal !== null) {
          const evidence = formatPaneEvidence(pre)
          const contLabel =
            pre?.state === "continuation" && pre.continuationKind !== undefined
              ? ` (continuation: ${pre.continuationKind})`
              : ""
          const recover =
            pre?.state === "continuation"
              ? 'Recover by finishing or clearing the pending input in the pane (e.g. keys: ["ctrl+c"] to abandon it, or close the quote and press enter), then retry.'
              : "Wait for the pane to return to a prompt, or handle it in the terminal yourself, then retry."
          return {
            ok: false,
            result:
              `refused: ${refusal}. Nothing was typed${contLabel}.\n\n` +
              `pane (last ${Math.min(6, pre?.tail.length ?? 0)} lines):\n${evidence}\n\n${recover}`,
            preview: `⛔ refused:${contLabel.length > 0 ? contLabel : " pane not at a prompt"}`,
          }
        }
        // Snapshot the pre-type screen for the bounded echo/prompt-anchored
        // delivery check (null when the pane has no probe => "unverified").
        const beforeTail = pre?.tail ?? null
        // Sudo in the visible pane (docs/agent.md "Sudo"): the pane is a real
        // shell the USER is watching. Resolve the password through the session
        // seam (cache, else the masked popup) and type the command with askpass
        // (`sudo -A`) so it authenticates with no in-pane prompt — the agent
        // must not type a bare `sudo`, wait, and then retry around a prompt.
        let typeText = text
        let sudoNote = ""
        let sudoCancelled = false
        // When we type a `sudo -A` command, snapshot the pane BEFORE typing so
        // the post-type check cannot attribute a STALE earlier rejection to this
        // command (checkPaneSudoOutcome treats such a before-snapshot as
        // "unknown").
        let sudoBefore: string | null = null
        if (commandUsesSudo(text)) {
          if (ctx.requestSudo !== undefined) {
            const password = await resolveSudoPassword(ctx, text)
            if (password === null || password.length === 0) {
              sudoCancelled = true
            } else if (sudoAskpassBroker.helperPath() !== null && sudoAskpassBroker.arm(password)) {
              typeText = commandWithSudoAskpass(text)
              sudoBefore = await ctx.pane.captureScrollbackRaw(PANE_SUDO_LINES).catch(() => "")
            } else {
              // No askpass material: fall back to the pane's own prompt.
              sudoNote = " — the pane is now waiting for YOUR sudo password; STOP and let the user type it, do not retry"
            }
          } else {
            sudoNote = " — the pane is now waiting for YOUR sudo password; STOP and let the user type it, do not retry"
          }
        }
        if (sudoCancelled) {
          const msg =
            "shell_session: this command needs sudo but no password was provided (the sudo prompt was declined/cancelled), so nothing was typed. " +
            "Do not retry — ask the user to run it in their terminal, or run it with shell_background (sensus prompts/uses the cache)."
          return { ok: false, result: msg, preview: "sudo password cancelled" }
        }
        const dropped: string[] = []
        // Order: literal text first, then the special keys, then Enter (the
        // natural typing order; "enter" is a convenience for keys:["enter"]).
        if (typeText.length > 0) await ctx.pane.sendKeys({ kind: "literal", text: typeText })
        for (const raw of keys) {
          const action = agentKeyAction(raw)
          if (action === null) {
            if (raw.trim().length > 0) dropped.push(raw.trim())
            continue
          }
          await ctx.pane.sendKeys(action)
        }
        if (enter) await ctx.pane.sendKeys({ kind: "keys", names: ["Enter"] })
        // Verify instead of claiming success blindly: after typing a `sudo -A`
        // command, a NEW rejection in the pane means the password was wrong.
        if (sudoBefore !== null) {
          const outcome = await checkPaneSudoOutcome(ctx, sudoBefore)
          if (outcome === "rejected") {
            // sudo TRIED the password and refused it: drop the vault so the
            // next attempt asks again. This is a WRONG PASSWORD, not a cancel.
            ctx.onSudoRejected?.()
            const msg =
              "shell_session: typed the command with the session sudo password, but the pane shows sudo REJECTED it as incorrect — this is NOT a cancellation. " +
              "Do not retry with the same password; ask the user to re-enter it, or run the command themselves in their terminal."
            return { ok: false, result: msg, preview: "sudo password incorrect" }
          }
          sudoNote =
            outcome === "clear"
              ? " — sudo used the session password via askpass (no prompt in the pane)"
              : " — typed with the session password via askpass (no prompt in the pane), but the pane already showed an earlier sudo failure, so confirm the result"
        }
        // Acknowledge the write (task #20): bounded, echo/prompt-anchored. A
        // missing echo is "unverified" — say so; never narrate success.
        const delivered = await verifyDeliveryBounded(ctx, text, beforeTail)
        const parts: string[] = []
        if (text.length > 0) parts.push(`${text.length} chars`)
        if (keys.length > 0) parts.push(`keys [${keys.join(", ")}]`)
        if (enter) parts.push("Enter")
        const what = parts.join(" + ")
        const droppedNote = dropped.length > 0 ? ` (dropped unknown keys: ${dropped.join(", ")})` : ""
        const status =
          delivered === "delivered"
            ? `delivered — typed ${what} into the user's visible pane`
            : `unverified — typed ${what} into the user's visible pane, but could not confirm the shell accepted it (no echo/prompt change observed); re-check the pane before assuming it ran`
        let result = `${status}${sudoNote}${droppedNote}`
        const stateSummary = paneStateSummary(pre)
        if (stateSummary !== null) result += `\n(pane state before typing: ${stateSummary})`
        if (delivered !== "delivered") {
          const after = readPaneState(ctx.pane)
          if (after !== null && after.tail.length > 0) result += `\npane after typing:\n${formatPaneEvidence(after)}`
        }
        return {
          ok: true,
          result,
          preview: `⌨ ${what}${delivered === "delivered" ? "" : " (unverified)"}`,
        }
      }
      case "read_file": {
        const path = argString(args, "path") ?? ""
        if (path.length === 0) return { ok: false, result: "read_file: missing path", preview: "missing path" }
        const full = resolveToolPath(path, ctx.paneCwd)
        const offsetRaw = args["offset"]
        const limitRaw = args["limit"]
        const offset = typeof offsetRaw === "number" && Number.isFinite(offsetRaw) && offsetRaw >= 1 ? Math.floor(offsetRaw) : 1
        const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.floor(limitRaw) : null
        // Bounded read (readFile.ts): regular files only, large files streamed
        // as a capped line window — never readFileSync of a whole huge file.
        const win = readTextWindow(full, offset, limit)
        if (!win.ok) {
          const msg = `read_file: cannot read ${path} (${win.error})`
          return { ok: false, result: msg, preview: previewOf(msg) }
        }
        let text = win.lines.join("\n")
        if (win.more) text += "\n(file has more lines — raise limit or offset)"
        if (win.note !== undefined) text += `\n(${win.note})`
        return { ok: true, result: text, preview: previewOf(text) }
      }
      case "get_scrollback": {
        const linesRaw = args["lines"]
        const lines = typeof linesRaw === "number" && Number.isFinite(linesRaw) && linesRaw >= 1 ? Math.floor(linesRaw) : 500
        if (!ctx.pane) return { ok: false, result: "get_scrollback: no visible pane attached", preview: "no visible pane" }
        const raw = await ctx.pane.captureScrollbackRaw(Math.min(lines, 5000))
        // The tool boundary caps the result (tail bias) at the tool_output limits.
        const result = raw.length === 0 ? "(scrollback empty)" : raw
        return { ok: true, result, preview: previewOf(result) }
      }
      case "view_image": {
        // Vision tool (docs/agent.md "Images"): read + validate a local image
        // file and hand the bytes to the session, which lifts them into the
        // provider history as a synthetic user message (tool roles are
        // text-only on the OpenAI-compatible wire).
        const pathArg = (argString(args, "path") ?? "").trim()
        if (pathArg.length === 0) return { ok: false, result: "view_image: missing path", preview: "missing path" }
        const full = resolveToolPath(pathArg, ctx.paneCwd)
        const att = readImageAttachment(full, pathArg.split("/").pop())
        if (att === null) {
          const msg = `view_image: not a readable image (png, jpeg, webp, gif; max ${formatBytes(MAX_IMAGE_BYTES)}) — ${full}`
          return { ok: false, result: msg, preview: "not an image" }
        }
        const dims = att.width !== undefined && att.height !== undefined ? `${att.width}×${att.height}` : "unknown size"
        const text = `Loaded image "${att.name}" (${att.mediaType}, ${dims}, ${formatBytes(att.bytes)}). The image is attached in the next message.`
        return { ok: true, result: text, preview: `🖼 ${att.name}`, images: [att] }
      }
      default: {
        // MCP tools (M11): mcp__<server>__<tool> -> registry tools/call. The
        // result flows through the tool boundary like every other tool.
        if (isMcpToolName(name) && ctx.mcp) {
          const r = await ctx.mcp.call(name, args, ctx.signal)
          return { ok: r.ok, result: r.result, preview: previewOf(r.result) }
        }
        return { ok: false, result: `unknown tool "${name}"`, preview: `unknown tool "${name}"` }
      }
    }
  } catch (e) {
    const msg = `${name} failed: ${errorMessage(e)}`
    return { ok: false, result: msg, preview: previewOf(msg) }
  }
}
