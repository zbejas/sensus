/**
 * Daemon runtime paths (docs/daemon-api.md, docs/operations.md "Daemon"): the
 * runtime-dir resolution order (`SENSUS_RUNTIME_DIR` → `XDG_RUNTIME_DIR` →
 * `os.tmpdir()`) and the daemon's filenames under it.
 */

import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sensusRuntimeDirFrom } from "../../../src/engine/index.ts"
import {
  daemonEventsSocketPath,
  daemonLogJsonlPath,
  daemonLogPath,
  daemonPidPath,
  daemonRuntimeDir,
  daemonSocketPath,
  daemonTokenPath,
} from "../../../src/daemon/index.ts"

const uid = typeof process.getuid === "function" ? String(process.getuid()) : "0"

describe("config: sensusRuntimeDirFrom", () => {
  test("SENSUS_RUNTIME_DIR wins, then non-empty XDG_RUNTIME_DIR, then the tmp fallback", () => {
    expect(sensusRuntimeDirFrom({ SENSUS_RUNTIME_DIR: "/custom/run" })).toBe("/custom/run")
    expect(sensusRuntimeDirFrom({ SENSUS_RUNTIME_DIR: "/custom/run", XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("/custom/run")
    expect(sensusRuntimeDirFrom({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe(`/run/user/1000/sensus-${uid}`)
    expect(sensusRuntimeDirFrom({ XDG_RUNTIME_DIR: "" })).toBe(join(tmpdir(), `sensus-${uid}`))
    expect(sensusRuntimeDirFrom({})).toBe(join(tmpdir(), `sensus-${uid}`))
  })
})

describe("daemon: runtime filenames", () => {
  test("socket/token/pid/log/events filenames derive from a given dir", () => {
    const dir = "/run/user/1000/sensus-1000"
    expect(daemonSocketPath(dir)).toBe(join(dir, "daemon.sock"))
    expect(daemonTokenPath(dir)).toBe(join(dir, "daemon.token"))
    expect(daemonPidPath(dir)).toBe(join(dir, "daemon.pid"))
    expect(daemonLogPath(dir)).toBe(join(dir, "daemon.log"))
    expect(daemonLogJsonlPath(dir)).toBe(join(dir, "daemon-log.jsonl"))
    expect(daemonEventsSocketPath(dir)).toBe(join(dir, "events.sock"))
  })

  test("the default dir is the shared runtime dir (SENSUS_RUNTIME_DIR seam)", () => {
    const prev = process.env["SENSUS_RUNTIME_DIR"]
    try {
      process.env["SENSUS_RUNTIME_DIR"] = "/tmp/hermetic-daemon"
      expect(daemonRuntimeDir()).toBe("/tmp/hermetic-daemon")
      expect(daemonSocketPath()).toBe(join("/tmp/hermetic-daemon", "daemon.sock"))
      expect(daemonTokenPath()).toBe(join("/tmp/hermetic-daemon", "daemon.token"))
      expect(daemonPidPath()).toBe(join("/tmp/hermetic-daemon", "daemon.pid"))
      expect(daemonLogPath()).toBe(join("/tmp/hermetic-daemon", "daemon.log"))
    } finally {
      if (prev === undefined) delete process.env["SENSUS_RUNTIME_DIR"]
      else process.env["SENSUS_RUNTIME_DIR"] = prev
    }
  })
})
