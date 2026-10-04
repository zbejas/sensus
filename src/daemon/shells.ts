/**
 * ShellRegistry — the daemon's owned PTY shells (P3c-i; D1/D4/D11/D12;
 * docs/daemon-api.md "WebSocket channels", docs/terminal-layer.md "PTY core
 * vs renderable").
 *
 * The daemon owns the PTY (`PtySession` from the IF1 engine barrel): spawn,
 * output fan-out, resize, kill, the bounded raw byte replay buffer, and the
 * streamed `terminal.status` facts (cwd/alt/command-running/death/size/cursor
 * — P4a gap 1). Every byte the shell emits has an absolute cursor, so a
 * re-attaching client gets only the bytes it is missing instead of a full
 * repaint (D12). The client owns the embedded VT, so the registry emits raw
 * bytes and never a rendered frame. The daemon spawns with a NULL palette, so
 * `PtySession`'s SGR rewriter is a no-op and those bytes are exactly the PTY
 * output — SGR rewrite + `PanePainter` belong to the client (D1; P4a gap 4).
 *
 * Roles (D11): exactly one `controller` per shell (the only client allowed to
 * write input / resize); every other attached client is a read-only
 * `observer`. Ownership transfer is explicit (`handover`).
 *
 * Every method is defensive: a PTY/listener failure surfaces as an error
 * result or a dropped byte, never an exception (AGENTS.md rule 10).
 */

import { errorMessage } from "../core/util.ts"
import type { Logger } from "../core/log.ts"
import { componentLogger } from "./log.ts"
import { PtySession, type PtySessionOptions, type TerminalStatus } from "../engine/index.ts"

/** Module-level child logger for the shell registry (component `daemon.shells`). */
const log: Logger = componentLogger("daemon.shells")

/** Who may drive a shell (D11). */
export type ShellRole = "controller" | "observer"

/** Default raw-replay cap (~1 MiB): enough to repaint a screen, always bounded
 * (D12 — drop oldest). A single chunk larger than the cap is truncated to its
 * tail so memory stays bounded even under a byte burst. */
export const SHELL_REPLAY_MAX_BYTES = 1024 * 1024

/** Events the registry delivers to attached clients. */
export type ShellEventName = "terminal.output" | "terminal.exit" | "terminal.role" | "terminal.status"

/** The transport-free sink the registry fans shell output/role changes into.
 * The WS `DaemonClient` implements it; a test can record instead. */
export interface ShellClient {
  readonly id: string
  deliver(event: ShellEventName, payload: Record<string, unknown>): void
}

/** One shell as `terminal.list` reports it. `attached`/`controller` describe
 * SERVER state (a shell in use), not the requesting client. */
export interface ShellListEntry {
  shellId: string
  cols: number
  rows: number
  alive: boolean
  /** At least one client is attached. */
  attached: boolean
  /** A controller is currently set. */
  controller: boolean
  cwd: string | null
  /** Epoch ms this shell was last *inactive*: the moment it lost its last
   * attached client, or its creation time if never attached. `null` while a
   * client is attached (it is in use). The idle reaper uses this to kill a
   * shell left unused past the re-attach window (docs/daemon-api.md
   * "Lifecycle"). */
  lastDetachedAt: number | null
}

/** Payload of `terminal.attached` (the replay that repaints a re-attaching
 * client — D12). `replay` is base64 post-rewrite PTY bytes covering the
 * absolute range `[replayFrom, cursor)`; `cursor` is the shell's total emitted
 * byte count, so a client can resume from it later. `truncated` is true when
 * the requested start predates the retained ring (the replay is the best the
 * daemon still has, not the exact missing range). `resetAlt` is true when the
 * client must clear the alternate screen before writing the replay. */
export interface ShellAttachResult {
  shellId: string
  role: ShellRole
  replay: string
  /** Absolute output offset of the first replay byte. */
  replayFrom: number
  /** Absolute output offset just past the last replay byte. */
  cursor: number
  /** The replay does not start at the requested/zero offset. */
  truncated: boolean
  resetAlt: boolean
  cols: number
  rows: number
  /** Current status (cwd/alt/command-running/death/size/cursor). Also streamed
   * as the first `terminal.status` right after this event (P4a gap 1). */
  status: TerminalStatus
}

/** Client-reported terminal facts (D2): the client's VT grid is authoritative
 * while a client is attached; the scanner ring is the no-client fallback. */
export interface ShellFacts {
  lines: string[]
  cursor: { x: number; y: number; visible: boolean }
  /** The client that supplied the facts. */
  clientId: string
  updatedAt: number
}

/** The read-only shell view a bound chat's context getter needs (P4a gap 3).
 * `ShellRegistry` implements it; keeping the surface structural lets a test
 * stub it. */
export interface ShellContextSource {
  getFacts(shellId: string): ShellFacts | null
  statusOf(shellId: string): TerminalStatus | null
  recentLines(shellId: string, n: number): string[]
  ptyFor(shellId: string): PtySession | null
  shellName(shellId: string): string | null
  hasClient(shellId: string): boolean
  /** Epoch ms the shell last lost its last client (or its creation time), or
   * null when unknown / the shell is currently attached. Optional so existing
   * structural stubs stay valid; absent ≡ null. The boot picker surfaces this
   * on `ChatListEntry` so it can age-gate re-attach without a second call. */
  lastDetachedAtOf?(shellId: string): number | null
}

/** Result of a registry operation: a value or a stable error code. */
export type ShellOpResult<T> = { ok: true; result: T } | { ok: false; error: string }

export interface ShellRegistryOptions {
  /** The user's shell (config `shell` / `$SHELL`); resolved per `open` so a
   * config reload is reflected. */
  defaultShell: () => string
  /** Default cwd for a spawned shell (`open` may override). */
  cwd?: string
  /** Extra environment for a spawned shell (`open` may override). */
  env?: Record<string, string | undefined>
  /** Raw-replay cap; defaults to `SHELL_REPLAY_MAX_BYTES`. */
  replayMaxBytes?: number
  /** Test seam: override the PTY spawner. */
  spawn?: (opts: PtySessionOptions) => PtySession
  /** Test seam: clock. */
  now?: () => number
}

export interface ShellOpenOptions {
  cols: number
  rows: number
  cwd?: string
  shell?: string
  env?: Record<string, string | undefined>
}

interface ShellRecord {
  id: string
  pty: PtySession
  /** The shell binary this session was launched with (context `shell`). */
  shell: string
  /** Attached clients, keyed by client id. */
  clients: Map<string, ShellClient>
  /** The one client allowed input/resize, or null. */
  controller: string | null
  /** Bounded ring of post-rewrite output chunks (D12). */
  replay: Uint8Array[]
  replayBytes: number
  /** Total bytes emitted since the shell was created (absolute output cursor). */
  outCursor: number
  /** Absolute offset of the first byte in `replay` (`outCursor - replayBytes`). */
  bufferStart: number
  alive: boolean
  facts: ShellFacts | null
  /** Last status fanned out, so `terminal.status` fires only on a real change. */
  lastStatus: TerminalStatus | null
  /** Epoch ms the shell last lost its last client (creation time until first
   * attach). Drives the idle reaper; see `ShellListEntry.lastDetachedAt`. */
  lastDetachedAt: number
}

/** Clamp a cell dimension to a positive integer. */
function normalizeSize(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n)) : 1
}

/** Structural equality for the status change detector. Optional fields are
 * normalized (undefined ≡ false/null) so a scanner that starts reporting one
 * is not treated as a change. */
function sameStatus(a: TerminalStatus, b: TerminalStatus): boolean {
  return (
    a.dead === b.dead &&
    a.deadStatus === b.deadStatus &&
    a.cols === b.cols &&
    a.rows === b.rows &&
    a.cwd === b.cwd &&
    a.currentCommand === b.currentCommand &&
    a.alternateOn === b.alternateOn &&
    (a.applicationCursor ?? false) === (b.applicationCursor ?? false) &&
    (a.commandRunning ?? false) === (b.commandRunning ?? false) &&
    (a.lastExitCode ?? null) === (b.lastExitCode ?? null) &&
    a.cursorX === b.cursorX &&
    a.cursorY === b.cursorY &&
    a.cursorVisible === b.cursorVisible
  )
}

/** ULID-ish, collision-resistant-enough, sortable shell id: base36 time +
 * counter + random tail. Stable for a shell's whole life (D4/D12). */
function makeShellId(now: number, counter: number): string {
  return `${now.toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export class ShellRegistry {
  private readonly records = new Map<string, ShellRecord>()
  private readonly shellsListeners = new Set<(shells: ShellListEntry[]) => void>()
  private readonly exitListeners = new Set<(shellId: string) => void>()
  private counter = 0
  private closed = false

  constructor(private readonly opts: ShellRegistryOptions) {}

  /** Subscribe to shell-list changes (`terminal.shells`). */
  onShellsChanged(cb: (shells: ShellListEntry[]) => void): void {
    this.shellsListeners.add(cb)
  }

  /** Subscribe to shell exits (a PTY died). Fired once per shell, before the
   * record is removed, so a bound chat can be released. Listener failures are
   * contained. */
  onShellExit(cb: (shellId: string) => void): void {
    this.exitListeners.add(cb)
  }

  /** Re-broadcast the shell list to subscribers. Callers that changed
   * attachment membership invoke this after their own event frames so an
   * attaching client sees `terminal.attached` before the list churn. */
  refreshShells(): void {
    const shells = this.list()
    for (const cb of this.shellsListeners) {
      try {
        cb(shells)
      } catch (err) {
        // A listener failure must not break the registry.
        log.warn("shells-list change listener failed", { err })
      }
    }
  }

  /** Spawn a shell on a fresh native PTY. Never throws. */
  open(opts: ShellOpenOptions): ShellOpResult<{ shellId: string }> {
    if (this.closed) return { ok: false, error: "registry_closed" }
    const cols = normalizeSize(opts.cols)
    const rows = normalizeSize(opts.rows)

    let shell: string
    try {
      const requested = opts.shell !== undefined && opts.shell.length > 0 ? opts.shell : this.opts.defaultShell()
      shell = requested.length > 0 ? requested : "/bin/sh"
    } catch (e) {
      shell = process.env["SHELL"] ?? "/bin/sh"
      log.debug("default shell resolution failed; using $SHELL", { err: e, shell })
    }

    const spawn = this.opts.spawn ?? PtySession.spawn
    let pty: PtySession
    try {
      // P4a gap 4 / D1: the daemon is BYTE-TRANSPARENT. `palette: null` + no
      // theme defaults makes `PtySession`'s SGR rewriter a no-op (bold-bright
      // only applies once a palette is set), so the WS stream carries raw PTY
      // bytes; the client owns SGR rewrite + `PanePainter`. Do not pass a
      // palette here.
      pty = spawn({ cols, rows, shell, cwd: opts.cwd ?? this.opts.cwd, env: opts.env ?? this.opts.env, palette: null })
    } catch (e) {
      log.debug("PTY spawn threw", { err: e, shell })
      return { ok: false, error: `spawn_failed: ${errorMessage(e)}` }
    }
    if (pty.spawnError !== null) {
      try {
        pty.kill()
      } catch (e) {
        // already gone
        log.debug("PTY kill after spawn error failed", { err: e, shell })
      }
      return { ok: false, error: "spawn_failed" }
    }

    this.counter += 1
    const now = (this.opts.now ?? Date.now)()
    const record: ShellRecord = {
      id: makeShellId(now, this.counter),
      pty,
      shell,
      clients: new Map(),
      controller: null,
      replay: [],
      replayBytes: 0,
      outCursor: 0,
      bufferStart: 0,
      alive: true,
      facts: null,
      lastStatus: null,
      // A shell that is never attached is "inactive" from birth; the idle
      // reaper may reclaim it like any unattended pane.
      lastDetachedAt: now,
    }
    this.records.set(record.id, record)

    pty.onOutput((bytes) => {
      try {
        this.handleOutput(record, bytes)
      } catch (e) {
        // A fan-out failure must not break the PTY data path (rule 10).
        log.debug("PTY output handler threw", { err: e, shellId: record.id })
      }
    })
    pty.onExit((code) => {
      try {
        this.handleExit(record, code)
      } catch (e) {
        // A fan-out failure must not break the exit path (rule 10).
        log.debug("PTY exit handler threw", { err: e, shellId: record.id })
      }
    })

    this.refreshShells()
    return { ok: true, result: { shellId: record.id } }
  }

  /** Every live shell. Dead shells are removed on exit, so `alive` is true for
   * every entry (kept in the shape for the frozen contract). */
  list(): ShellListEntry[] {
    return [...this.records.values()].map((record) => ({
      shellId: record.id,
      cols: record.pty.cols,
      rows: record.pty.rows,
      alive: record.alive,
      attached: record.clients.size > 0,
      controller: record.controller !== null,
      cwd: record.pty.status().cwd,
      // An attached shell is in use: report no inactivity clock. Otherwise the
      // last-detached stamp (or birth) is the reaper's clock.
      lastDetachedAt: record.clients.size > 0 ? null : record.lastDetachedAt,
    }))
  }

  /**
   * Shells that have been **inactive** (no attached client) since before
   * `now - maxIdleMs`. The idle reaper kills these so a session left unattended
   * past the re-attach window cannot be resumed later (docs/daemon-api.md
   * "Lifecycle"). A currently-attached shell is never returned. Pure read.
   */
  abandoned(now: number, maxIdleMs: number): string[] {
    if (!Number.isFinite(maxIdleMs) || maxIdleMs < 0) return []
    const cutoff = now - maxIdleMs
    const out: string[] = []
    for (const record of this.records.values()) {
      if (record.clients.size > 0) continue
      if (record.lastDetachedAt <= cutoff) out.push(record.id)
    }
    return out
  }

  /** The last client-reported VT facts for a shell, or null. */
  getFacts(shellId: string): ShellFacts | null {
    return this.records.get(shellId)?.facts ?? null
  }

  /** Whether at least one client is currently attached to the shell. */
  hasClient(shellId: string): boolean {
    return (this.records.get(shellId)?.clients.size ?? 0) > 0
  }

  /** Epoch ms the shell last lost its last client (or its creation time), or
   * null when the shell is unknown or currently attached. */
  lastDetachedAtOf(shellId: string): number | null {
    const record = this.records.get(shellId)
    if (record === undefined || record.clients.size > 0) return null
    return record.lastDetachedAt
  }

  /** The live status for a shell (scanner facts + any client cursor), or null. */
  statusOf(shellId: string): TerminalStatus | null {
    const record = this.records.get(shellId)
    if (record === undefined) return null
    return this.statusFor(record)
  }

  /** The scanner ring's recent plain-text tail for a shell (context fallback). */
  recentLines(shellId: string, n: number): string[] {
    const record = this.records.get(shellId)
    if (record === undefined) return []
    try {
      return record.pty.recentLines(n)
    } catch (e) {
      log.debug("recentLines read failed", { err: e, shellId: record.id })
      return []
    }
  }

  /** The raw PTY session (the `AgentPane` a bound chat's tools drive), or null. */
  ptyFor(shellId: string): PtySession | null {
    return this.records.get(shellId)?.pty ?? null
  }

  /** The shell binary a session was launched with, or null. */
  shellName(shellId: string): string | null {
    return this.records.get(shellId)?.shell ?? null
  }

  /** The current status with `cursorX`/`cursorY` overlaid from client facts
   * when a client supplied them AND is still attached (D2); null cursor
   * otherwise. The PTY status is a fresh object, so mutating is safe. */
  private statusFor(record: ShellRecord): TerminalStatus {
    const base = record.pty.status()
    const facts = record.facts
    if (facts !== null && record.clients.size > 0) {
      base.cursorX = facts.cursor.x
      base.cursorY = facts.cursor.y
      base.cursorVisible = facts.cursor.visible
    }
    return base
  }

  /** Fan the current status out to every attached client. Always emits — the
   * `terminal.status` that lands right after `terminal.attach` / `resize`
   * (P4a gap 1). No-op delivery when no client is attached. */
  announceStatus(shellId: string): void {
    const record = this.records.get(shellId)
    if (record === undefined) return
    this.emitStatus(record, true)
  }

  /**
   * Attach a client. A second controller is rejected (`controller_taken`)
   * unless it goes through `handover`; observers are always welcome.
   *
   * `cursor` is the client's last applied absolute output offset:
   *   - omitted → full retained replay (boot / fresh VT)
   *   - a number → only bytes after it; `truncated` when that start predates
   *     the retained ring, in which case the full retained ring is replayed.
   */
  attach(shellId: string, client: ShellClient, role: ShellRole, cursor?: number): ShellOpResult<ShellAttachResult> {
    const record = this.records.get(shellId)
    if (record === undefined || !record.alive) return { ok: false, error: "shell_not_found" }
    if (role === "controller" && record.controller !== null && record.controller !== client.id) {
      return { ok: false, error: "controller_taken" }
    }

    record.clients.set(client.id, client)
    let effective: ShellRole = record.controller === client.id ? "controller" : "observer"
    if (role === "controller") {
      record.controller = client.id
      effective = "controller"
    }

    const status = this.statusFor(record)
    // Seed the change detector: the client gets the status in `terminal.attached`
    // (and an explicit `terminal.status` right after), not a duplicate on the
    // next output chunk.
    record.lastStatus = status

    const full = cursor === undefined || !Number.isSafeInteger(cursor) || cursor < 0
    const requested = full ? record.bufferStart : cursor
    const end = record.outCursor
    // A cursor older than the ring cannot be honored exactly; a full replay of
    // the retained ring is the best the daemon still has. A full attach into
    // retained history is equally clipped.
    const truncated = full ? record.bufferStart > 0 : requested < record.bufferStart
    const from = truncated || full ? record.bufferStart : Math.min(requested, end)
    const replayFrom = Math.min(from, end)

    return {
      ok: true,
      result: {
        shellId: record.id,
        role: effective,
        replay: this.sliceReplay(record, replayFrom, end),
        replayFrom,
        cursor: end,
        truncated,
        resetAlt: status.alternateOn === true && (full || truncated),
        cols: record.pty.cols,
        rows: record.pty.rows,
        status,
      },
    }
  }

  /** Deliver each attached client its own `terminal.role` (D11). */
  announceRole(shellId: string): void {
    const record = this.records.get(shellId)
    if (record === undefined) return
    for (const client of record.clients.values()) {
      try {
        client.deliver("terminal.role", {
          shellId: record.id,
          clientId: client.id,
          role: record.controller === client.id ? "controller" : "observer",
        })
      } catch (err) {
        // contained
        log.warn("terminal.role delivery failed", { err, shellId: record.id, clientId: client.id })
      }
    }
  }

  /** Detach one client from one shell; the shell stays alive (D4). */
  detach(shellId: string, client: ShellClient): ShellOpResult<{ shellId: string }> {
    const record = this.records.get(shellId)
    if (record === undefined) return { ok: false, error: "shell_not_found" }
    this.removeClient(record, client.id)
    return { ok: true, result: { shellId } }
  }

  /** Detach a client from every shell (WS close). */
  detachClient(clientId: string): void {
    for (const record of this.records.values()) this.removeClient(record, clientId)
  }

  private removeClient(record: ShellRecord, clientId: string): void {
    if (!record.clients.delete(clientId)) return
    // The shell is now unattended (or observer-only): stamp the inactivity
    // clock the moment the LAST client leaves, so the idle reaper can reclaim
    // it once the re-attach window passes.
    if (record.clients.size === 0) record.lastDetachedAt = (this.opts.now ?? Date.now)()
    if (record.controller !== clientId) return
    record.controller = null
    // Tell the remaining clients control is free.
    for (const client of record.clients.values()) {
      try {
        client.deliver("terminal.role", { shellId: record.id, clientId, role: "observer" })
      } catch (err) {
        // contained
        log.warn("terminal.role (controller freed) delivery failed", { err, shellId: record.id, clientId: client.id })
      }
    }
  }

  /** Move the controller role to another attached client (D11). Only the
   * current controller may hand over. */
  handover(shellId: string, client: ShellClient, toClientId: string): ShellOpResult<{ shellId: string; clientId: string }> {
    const record = this.records.get(shellId)
    if (record === undefined || !record.alive) return { ok: false, error: "shell_not_found" }
    if (record.controller !== client.id) return { ok: false, error: "not_controller" }
    if (toClientId !== client.id && !record.clients.has(toClientId)) return { ok: false, error: "not_attached" }
    record.controller = toClientId
    return { ok: true, result: { shellId, clientId: toClientId } }
  }

  /** Controller-only input into the PTY. An observer is rejected. */
  input(shellId: string, client: ShellClient, bytes: Uint8Array): ShellOpResult<{ shellId: string }> {
    const record = this.records.get(shellId)
    if (record === undefined || !record.alive) return { ok: false, error: "shell_not_found" }
    if (record.controller !== client.id) return { ok: false, error: "not_controller" }
    try {
      record.pty.write(bytes)
    } catch (e) {
      log.debug("PTY write failed", { err: e, shellId: record.id })
      return { ok: false, error: "write_failed" }
    }
    return { ok: true, result: { shellId } }
  }

  /** Controller-only PTY resize. */
  resize(shellId: string, client: ShellClient, cols: number, rows: number): ShellOpResult<{ shellId: string }> {
    const record = this.records.get(shellId)
    if (record === undefined || !record.alive) return { ok: false, error: "shell_not_found" }
    if (record.controller !== client.id) return { ok: false, error: "not_controller" }
    record.pty.resize(cols, rows)
    return { ok: true, result: { shellId } }
  }

  /** Store a client's VT facts (D2). The client must be attached. */
  facts(shellId: string, client: ShellClient, facts: Omit<ShellFacts, "clientId" | "updatedAt">): ShellOpResult<{ shellId: string }> {
    const record = this.records.get(shellId)
    if (record === undefined || !record.alive) return { ok: false, error: "shell_not_found" }
    if (!record.clients.has(client.id)) return { ok: false, error: "not_attached" }
    record.facts = {
      lines: [...facts.lines],
      cursor: { x: facts.cursor.x, y: facts.cursor.y, visible: facts.cursor.visible },
      clientId: client.id,
      updatedAt: (this.opts.now ?? Date.now)(),
    }
    return { ok: true, result: { shellId } }
  }

  /** Kill one shell and emit `terminal.exit` to its clients. */
  kill(shellId: string): ShellOpResult<{ shellId: string }> {
    const record = this.records.get(shellId)
    if (record === undefined) return { ok: false, error: "shell_not_found" }
    try {
      record.pty.kill()
    } catch (e) {
      // already gone
      log.debug("PTY kill failed (already gone?)", { err: e, shellId: record.id })
    }
    // Emit the exit synchronously so `terminal.kill` always observes
    // `terminal.exit`; the async `onExit` then no-ops (idempotent).
    this.handleExit(record, record.pty.status().deadStatus)
    return { ok: true, result: { shellId } }
  }

  /** Kill every shell (daemon shutdown). Best-effort, no event fan-out. */
  killAll(): void {
    this.closed = true
    for (const record of this.records.values()) {
      try {
        record.pty.kill()
      } catch (e) {
        // already gone
        log.debug("PTY killAll kill failed", { err: e, shellId: record.id })
      }
      record.alive = false
      record.clients.clear()
    }
    this.records.clear()
  }

  // -- internals --------------------------------------------------------------

  private handleOutput(record: ShellRecord, bytes: Uint8Array): void {
    if (!record.alive || bytes.byteLength === 0) return
    record.outCursor += bytes.byteLength
    this.pushReplay(record, bytes)
    if (record.clients.size > 0) {
      const data = Buffer.from(bytes).toString("base64")
      for (const client of record.clients.values()) {
        try {
          // The frame's end cursor lets the client detect a dropped frame (the
          // per-client outbound queue drops oldest) and resync from its last
          // applied offset (D12).
          client.deliver("terminal.output", { shellId: record.id, data, cursor: record.outCursor })
        } catch (err) {
          // A slow/failed sink must not stop the others.
          log.warn("terminal.output delivery failed", { err, shellId: record.id, clientId: client.id })
        }
      }
    }
    // The scanner may have parsed a cwd/alt/command change out of these bytes;
    // stream the status when it actually changed (P4a gap 1).
    this.emitStatus(record, false)
  }

  private handleExit(record: ShellRecord, code: number | null): void {
    if (!record.alive) return
    record.alive = false
    // The death status lands before `terminal.exit` (P4a gap 1). The PTY's own
    // `dead` flag is set asynchronously (on `proc.exited`), so force it here.
    this.emitStatus(record, true, code)
    for (const client of record.clients.values()) {
      try {
        client.deliver("terminal.exit", { shellId: record.id, code })
      } catch (err) {
        // contained
        log.warn("terminal.exit delivery failed", { err, shellId: record.id, clientId: client.id })
      }
    }
    record.clients.clear()
    // A bound chat's shell is gone: it can never be re-attached, so the daemon
    // releases it (the listener aborts any in-flight turn). Fired before the
    // record is removed, contained so a listener failure cannot break exit.
    for (const listener of this.exitListeners) {
      try {
        listener(record.id)
      } catch (err) {
        // contained
        log.warn("shell exit listener failed", { err, shellId: record.id })
      }
    }
    this.records.delete(record.id)
    this.refreshShells()
  }

  /** Fan the shell status out to attached clients. `force` emits even when the
   * status is unchanged (attach/resize/death); otherwise only on a real change.
   * A `deadStatus` forces `dead: true` (the synchronous kill path — the PTY
   * flips its own flag asynchronously). */
  private emitStatus(record: ShellRecord, force: boolean, deadStatus?: number | null): void {
    const status = this.statusFor(record)
    if (deadStatus !== undefined) {
      status.dead = true
      status.deadStatus = deadStatus
    }
    if (!force && record.lastStatus !== null && sameStatus(record.lastStatus, status)) return
    record.lastStatus = status
    if (record.clients.size === 0) return
    for (const client of record.clients.values()) {
      try {
        client.deliver("terminal.status", { shellId: record.id, status })
      } catch (err) {
        // contained
        log.warn("terminal.status delivery failed", { err, shellId: record.id, clientId: client.id })
      }
    }
  }

  private pushReplay(record: ShellRecord, bytes: Uint8Array): void {
    const copy = bytes.slice()
    record.replay.push(copy)
    record.replayBytes += copy.byteLength
    const cap = this.opts.replayMaxBytes ?? SHELL_REPLAY_MAX_BYTES
    while (record.replayBytes > cap && record.replay.length > 0) {
      if (record.replay.length === 1) {
        const only = record.replay[0]
        if (only !== undefined && only.byteLength > cap) {
          record.replay[0] = only.slice(only.byteLength - cap)
          record.replayBytes = cap
        }
        break
      }
      const dropped = record.replay.shift()
      record.replayBytes -= dropped?.byteLength ?? 0
    }
    // Invariant: the ring always holds the last `replayBytes` of the stream.
    record.bufferStart = record.outCursor - record.replayBytes
  }

  /** Base64 of the retained output in the absolute range `[from, to)`. An
   * empty string when the range is empty or outside the ring. Pure. */
  private sliceReplay(record: ShellRecord, from: number, to: number): string {
    if (to <= from || record.replayBytes === 0) return ""
    const bufferStart = record.outCursor - record.replayBytes
    let skip = from - bufferStart
    if (skip < 0) skip = 0
    const chunks: Buffer[] = []
    for (const chunk of record.replay) {
      if (skip >= chunk.byteLength) {
        skip -= chunk.byteLength
        continue
      }
      chunks.push(Buffer.from(skip > 0 ? chunk.subarray(skip) : chunk))
      skip = 0
    }
    if (chunks.length === 0) return ""
    const joined = Buffer.concat(chunks)
    const limit = to - from
    const out = joined.byteLength > limit ? joined.subarray(0, limit) : joined
    return out.toString("base64")
  }
}
