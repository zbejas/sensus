/**
 * The embedded cloud client: one outbound WSS per paired daemon, backed by the
 * typed broker and the local daemon's own WS.
 *
 * This replaces the standalone `sensus-cloud` connector. It is inert unless
 * `<SENSUS_HOME>/cloud/connection.json` exists and is enabled; the daemon
 * starts it after its listeners are up and stops it during teardown.
 */

import { componentLogger } from "../log.ts"
import type { Logger } from "../../core/log.ts"
import { sensusDataDir, sensusHomeFrom } from "../../config/config/paths.ts"
import type { EventSink, MemoryStore } from "../../engine/index.ts"
import { readIdentity } from "../../auth/identity.ts"
import { readPolicy } from "../../auth/policy.ts"
import { discoverDaemon, type DiscoveryResult } from "./discovery.ts"
import { cleanupLeftoverRuns, forgetRun, recordRun } from "./cleanup.ts"
import { RelayBroker } from "./broker.ts"
import { CloudTunnel, type TunnelState } from "./tunnel.ts"
import { readCloudConnection, hostFacts, type CloudConnection } from "./state.ts"
import { cloudDir, resolveRuntimeDir } from "./paths.ts"

const log: Logger = componentLogger("daemon.cloud")

export interface CloudStatus {
  paired: boolean
  enabled: boolean
  cloud: string | null
  instanceId: string | null
  fingerprint: string | null
  unixUser: string | null
  runsAsRoot: boolean
  connected: boolean
  state: TunnelState | "unpaired" | "disabled" | "error"
  lastError: string | null
}

export interface CloudClientOptions {
  home?: string
  runtimeDir?: string
  env?: NodeJS.ProcessEnv
  version: string
  /** Sessions data dir (`sensusDataDir()`); transcript ops read it in-process. */
  dataDir?: string
  /** Saved-session Context Inspector snapshot (the daemon's `chats`). */
  contextForSession?: (path: string) => { title: string; breakdown: unknown } | null
  /** True when a live chat still appends to a transcript path. */
  isSessionOpen?: (path: string) => boolean
  /** Delete a transcript through the engine (JSONL + sidecar + FTS rows). */
  deleteSession?: (path: string) => { ok: boolean; message?: string }
  /** Per-call memory store (the same store the REST route uses). */
  memoryStore?: () => MemoryStore
  /** Audit sink for a committed `memory.write` (`memory-write`). */
  events?: EventSink
  /** Test seam: fake broker/tunnel discovery. */
  discover?: () => Promise<DiscoveryResult>
  /** Test seam: do not create the real tunnel in unit tests. */
  startTunnel?: boolean
}

export interface CloudClient {
  /** Start the tunnel if a pairing exists and is enabled. Never throws. */
  start(): Promise<void>
  /** Stop the tunnel intentionally (daemon shutdown/unpair). */
  stop(): Promise<void>
  /** Re-read connection.json and reconnect (pairing/disable/enable). */
  reload(): Promise<CloudStatus>
  status(): CloudStatus
  /** True while a paired, enabled daemon should keep the process alive. */
  pinned(): boolean
}

class EmbeddedCloudClient implements CloudClient {
  private readonly home: string
  private readonly runtimeDir: string
  private readonly env: NodeJS.ProcessEnv
  private connection: CloudConnection | null = null
  private tunnel: CloudTunnel | null = null
  private broker: RelayBroker | null = null
  private tunnelState: TunnelState = "idle"
  private lastError: string | null = null
  private terminalStop = false
  private started = false
  private canConnect = false

  constructor(private readonly opts: CloudClientOptions) {
    this.home = opts.home ?? sensusHomeFrom(opts.env ?? process.env)
    this.runtimeDir = opts.runtimeDir ?? resolveRuntimeDir(opts.env ?? process.env)
    this.env = opts.env ?? process.env
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.connect()
  }

  private discover(): Promise<DiscoveryResult> {
    if (this.opts.discover !== undefined) return this.opts.discover()
    return discoverDaemon({ runtimeDir: this.runtimeDir, env: this.env })
  }

  private async connect(): Promise<void> {
    if (this.tunnel !== null) return
    const read = readCloudConnection(this.home)
    if (!read.ok) {
      this.connection = null
      this.lastError = read.error
      log.warn("cloud connection state is invalid", { err: read.error, home: this.home })
      return
    }
    if (read.connection === null) {
      this.connection = null
      return
    }
    this.connection = read.connection
    if (!read.connection.enabled) {
      log.info("cloud pairing is disabled", { cloud: read.connection.cloud })
      return
    }
    const identity = readIdentity(this.home)
    if (identity.identity === null) {
      this.lastError = identity.error ?? "host identity is missing"
      log.warn("cloud pairing exists but the host identity is missing", { err: this.lastError })
      return
    }
    const policy = readPolicy(this.home)
    if (!policy.ok) {
      this.lastError = policy.error
      log.warn("cloud pairing exists but the host policy is invalid", { err: policy.error })
      return
    }
    this.canConnect = true

    const broker = new RelayBroker({
      policy: policy.policy,
      discover: () => this.discover(),
      dataDir: this.opts.dataDir ?? sensusDataDir(),
      ...(this.opts.contextForSession !== undefined ? { contextForSession: this.opts.contextForSession } : {}),
      ...(this.opts.isSessionOpen !== undefined ? { isSessionOpen: this.opts.isSessionOpen } : {}),
      ...(this.opts.deleteSession !== undefined ? { deleteSession: this.opts.deleteSession } : {}),
      ...(this.opts.memoryStore !== undefined ? { memoryStore: this.opts.memoryStore } : {}),
      ...(this.opts.events !== undefined ? { events: this.opts.events } : {}),
      recordRun: (record) => recordRun(this.home, record),
      forgetRun: (streamId) => forgetRun(this.home, streamId),
      startDaemon: async () => true,
      maxStreams: policy.policy.maxStreams,
      onLog: (level, message) => this.report(level, message),
    })
    this.broker = broker

    // Leftovers from a previous daemon are released through the local WS; this
    // is best-effort and never blocks the tunnel.
    void cleanupLeftoverRuns({
      home: this.home,
      discover: () => this.discover(),
      onError: (message) => this.report("warn", message),
    }).catch((e: unknown) => this.report("warn", `run cleanup failed: ${String(e)}`))

    const tunnel = new CloudTunnel({
      cloudUrl: read.connection.cloud,
      instanceId: read.connection.instanceId,
      deviceToken: read.connection.deviceToken,
      identity: identity.identity,
      policy: policy.policy,
      broker,
      connectorVersion: this.opts.version,
      host: hostFacts({ uid: read.connection.uid, env: this.env, unixUser: read.connection.unixUser }),
      preflight: true,
      probeUpgrade: true,
      onLog: (level, message) => this.report(level, message),
      onStateChange: (state) => {
        this.tunnelState = state
        if (state === "ready") this.lastError = null
      },
      onStopped: (reason) => {
        this.tunnelState = "stopped"
        if (reason === "revoked" || reason === "unauthorized" || reason === "unsupported_protocol") {
          this.terminalStop = true
        }
        log.info("cloud tunnel stopped", { reason, cloud: read.connection?.cloud })
      },
    })
    this.tunnel = tunnel
    this.tunnelState = tunnel.state
    tunnel.start()
    log.info("cloud tunnel starting", {
      cloud: read.connection.cloud,
      instanceId: read.connection.instanceId,
      user: read.connection.unixUser,
      root: read.connection.runsAsRoot,
      home: cloudDir(this.home),
    })
  }

  private report(level: "info" | "warn" | "error", message: string): void {
    if (level === "error" || level === "warn") this.lastError = message
    if (level === "error") log.error(message)
    else if (level === "warn") log.warn(message)
    else log.info(message)
  }

  async stop(): Promise<void> {
    const tunnel = this.tunnel
    this.tunnel = null
    this.broker = null
    if (tunnel !== null) await tunnel.stop()
  }

  async reload(): Promise<CloudStatus> {
    await this.stop()
    this.terminalStop = false
    this.canConnect = false
    this.lastError = null
    this.tunnelState = "idle"
    await this.connect()
    return this.status()
  }

  status(): CloudStatus {
    const connection = this.connection
    if (connection === null) {
      return {
        paired: false,
        enabled: false,
        cloud: null,
        instanceId: null,
        fingerprint: null,
        unixUser: null,
        runsAsRoot: false,
        connected: false,
        state: this.lastError !== null ? "error" : "unpaired",
        lastError: this.lastError,
      }
    }
    return {
      paired: true,
      enabled: connection.enabled,
      cloud: connection.cloud,
      instanceId: connection.instanceId,
      fingerprint: connection.fingerprint,
      unixUser: connection.unixUser,
      runsAsRoot: connection.runsAsRoot,
      connected: this.tunnel?.state === "ready",
      state: !connection.enabled ? "disabled" : this.tunnel !== null ? this.tunnel.state : this.tunnelState,
      lastError: this.lastError,
    }
  }

  pinned(): boolean {
    return this.connection !== null && this.connection.enabled && this.canConnect && !this.terminalStop
  }
}

/** Build the daemon's cloud client. `startTunnel: false` keeps tests hermetic. */
export function createCloudClient(opts: CloudClientOptions): CloudClient {
  if (opts.startTunnel === false) {
    return {
      start: async () => {},
      stop: async () => {},
      reload: async () => ({
        paired: false,
        enabled: false,
        cloud: null,
        instanceId: null,
        fingerprint: null,
        unixUser: null,
        runsAsRoot: false,
        connected: false,
        state: "unpaired",
        lastError: null,
      }),
      status: () => ({
        paired: false,
        enabled: false,
        cloud: null,
        instanceId: null,
        fingerprint: null,
        unixUser: null,
        runsAsRoot: false,
        connected: false,
        state: "unpaired",
        lastError: null,
      }),
      pinned: () => false,
    }
  }
  return new EmbeddedCloudClient(opts)
}
