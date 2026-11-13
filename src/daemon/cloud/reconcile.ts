/**
 * Repair the always-on service for a host that was already paired before
 * `cloud pair` started installing one (docs/auth.md "Commands"). A paired host
 * that updates must not need to re-pair or run `daemon install` by hand.
 *
 * Idempotent and best-effort: the unit is written/enabled only when it is
 * missing, and the install never starts a second daemon (`startNow: false`).
 * The caller may be the daemon itself, `sensus update`, or the TUI boot, so a
 * failure is a value and never throws.
 */

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { errorMessage } from "../../core/util.ts"
import {
  checkUserLinger,
  enableUserLinger,
  installService,
  serviceUnitKind,
  serviceUnitPath,
  type LingerEnableResult,
  type LingerStatus,
  type ServiceCommandOptions,
  type ServiceIo,
} from "../service.ts"
import { SYSTEM_RUNTIME_DIR } from "../paths.ts"
import { installSystemService, systemServiceInstalled, systemServicePath } from "../systemService.ts"
import { resolveRuntimeDir } from "./paths.ts"
import { readCloudConnection } from "./state.ts"

export interface ReconcileCloudServiceOptions {
  /** The pairing's config home (`SENSUS_HOME`). */
  home: string
  env: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  io?: ServiceIo
  /** Which service scope this pairing uses (default `user`). */
  serviceScope?: "user" | "system"
  /** Test seam: the root system unit exists. */
  systemInstalled?: () => boolean
  /** Test seam: install the root system unit. */
  installSystem?: (opts: {
    home: string
    env: NodeJS.ProcessEnv
    runtimeDir: string
    startNow?: boolean
    uid?: number
  }) => Promise<number>
  /** Override the uid used for a system install (tests). */
  uid?: number
  /** Test seam: does the unit file exist? Defaults to `existsSync`. */
  unitExists?: (path: string) => boolean
  /** Test seam: is systemd actually running (Linux containers usually lack it)? */
  systemdAvailable?: () => boolean
  /** Try to enable lingering on Linux (default true; `--no-linger` sets false). */
  tryLinger?: boolean
  /** Test seam: install the unit. Defaults to `installService`. */
  install?: (opts: ServiceCommandOptions) => Promise<number>
  /** Test seam: read lingering. Defaults to `checkUserLinger`. */
  linger?: (opts: { env: NodeJS.ProcessEnv; platform?: NodeJS.Platform }) => Promise<LingerStatus>
  /** Test seam: enable lingering. Defaults to `enableUserLinger`. */
  enableLinger?: (opts: {
    env: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
    user?: string
  }) => Promise<LingerEnableResult>
}

export type ReconcileCloudServiceStatus =
  | "unpaired"
  | "disabled"
  | "unsupported"
  | "none"
  | "present"
  | "installed"
  | "failed"

export interface ReconcileCloudServiceResult {
  status: ReconcileCloudServiceStatus
  /** The unit path, or the failure reason. */
  detail: string | null
  /** What the best-effort lingering attempt did. */
  linger: "not-applicable" | "already" | "enabled" | "failed"
}

/** Ensure a paired, enabled host has its user service unit (never starts it). */
export async function reconcileCloudService(
  opts: ReconcileCloudServiceOptions,
): Promise<ReconcileCloudServiceResult> {
  try {
    const read = readCloudConnection(opts.home)
    if (!read.ok) return { status: "failed", detail: read.error, linger: "not-applicable" }
    if (read.connection === null) return { status: "unpaired", detail: null, linger: "not-applicable" }
    if (!read.connection.enabled) return { status: "disabled", detail: null, linger: "not-applicable" }

    const platform = opts.platform ?? process.platform
    const scope = opts.serviceScope ?? read.connection.serviceScope ?? "user"
    if (scope === "none") return { status: "none", detail: "pairing opted out of a service", linger: "not-applicable" }
    if (scope === "system") {
      const installed = opts.systemInstalled?.() ?? systemServiceInstalled()
      if (installed) return { status: "present", detail: systemServicePath(), linger: "not-applicable" }
      const install = opts.installSystem ?? installSystemService
      const code = await install({
        io: opts.io ?? { out: () => {}, err: () => {} },
        env: opts.env,
        home: opts.home,
        runtimeDir: SYSTEM_RUNTIME_DIR,
        startNow: false,
        uid: opts.uid,
      })
      if (code !== 0) return { status: "failed", detail: `system service install exited ${code}`, linger: "not-applicable" }
      return { status: "installed", detail: systemServicePath(), linger: "not-applicable" }
    }

    const kind = serviceUnitKind(platform)
    if (kind === null) {
      return { status: "unsupported", detail: `no user service on ${platform}`, linger: "not-applicable" }
    }
    const userHome = opts.env["HOME"] ?? homedir()
    const unitPath = serviceUnitPath(kind, userHome)
    const exists = opts.unitExists ?? existsSync
    if (exists(unitPath)) return { status: "present", detail: unitPath, linger: "not-applicable" }
    if (kind === "systemd" && !(opts.systemdAvailable ?? (() => existsSync("/run/systemd/system")))()) {
      // A container or a non-systemd init: no user manager to enable a unit.
      return { status: "unsupported", detail: "systemd is not running", linger: "not-applicable" }
    }

    let linger: ReconcileCloudServiceResult["linger"] = "not-applicable"
    if (platform === "linux" && opts.tryLinger !== false) {
      const status = await (opts.linger ?? checkUserLinger)({ env: opts.env, platform })
      if (status.applicable) {
        if (status.enabled === true) {
          linger = "already"
        } else {
          const enabled = await (opts.enableLinger ?? enableUserLinger)({
            env: opts.env,
            platform,
            user: status.user,
          })
          linger = enabled.ok ? "enabled" : "failed"
        }
      }
    }

    const io = opts.io ?? { out: () => {}, err: () => {} }
    const install = opts.install ?? installService
    const code = await install({
      io,
      env: opts.env,
      home: userHome,
      runtimeDir: resolveRuntimeDir(opts.env),
      sensusHome: opts.home,
      // The daemon may already be alive; never start a second one.
      startNow: false,
    })
    if (code !== 0) return { status: "failed", detail: `service install exited ${code}`, linger }
    return { status: "installed", detail: unitPath, linger }
  } catch (e) {
    return { status: "failed", detail: errorMessage(e), linger: "not-applicable" }
  }
}
