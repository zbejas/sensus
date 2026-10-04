/**
 * Memory smoke (docs/memory.md): the `/memory` manager overlay opens, adds an
 * entry through the real MemoryStore, and persists it to
 * `<SENSUS_HOME>/memory/MEMORY.md`. One boot in the outer tmux driver.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appBootCommand, bootSessionArgv, createHarness, stopSandboxDaemon, type Harness, writeSmokeConfig } from "../helpers.ts"

const h: Harness = createHarness({
  sock: `/tmp/sensus/sensus-memory-smoke-${process.pid}.sock`,
  tag: "mem",
  dumpTarget: "memsmoke:0",
  labelFromPredicate: true,
})

const outer = h.outer
const capT = h.capT

afterAll(async () => {
  await h.killServer()
  try {
    rmSync(h.sock, { force: true })
  } catch {
    // tmux 3.6 leaves socket files
  }
})

describe("sensus memory (in-tmux smoke)", () => {
  test(
    "the /memory manager opens, adds an entry, and persists it",
    async () => {
    const home = mkdtempSync(join(tmpdir(), "sensus-memory-smoke-"))
    const sensusHome = join(home, "home")
    writeSmokeConfig(sensusHome, { layout: "topbar" })
    try {
      const start = await outer(
        bootSessionArgv(
          "memsmoke",
          appBootCommand({
            sensusHome,
            bootLog: "/tmp/sensus/memboot.stderr.log",
            env: "SENSUS_MOCK=1 SENSUS_DEBUG=1",
          }),
        ),
      )
      expect(start.code).toBe(0)
      const cap = (): Promise<string> => capT("memsmoke:0")
      const key = (k: string): Promise<void> => h.keyTo("memsmoke:0", k)
      const typ = (t: string): Promise<void> => h.typeTo("memsmoke:0", t)

      await h.waitFor(async () => (await cap()).includes("no messages yet"), "boot", { timeoutMs: 20000 })
      await key("BTab")
      await h.waitFor(async () => (await cap()).includes("input ●"), "focus chat", { timeoutMs: 5000 })
      await typ("/memory")
      await key("Enter")
      await h.waitFor(
        async () => (await cap()).includes("MEMORY.md") && (await cap()).includes("no entries — press a to add"),
        "memory manager",
        { timeoutMs: 8000 },
      )
      console.log("[mem] manager overlay open")

      await typ("a")
      await typ("smoke memory fact")
      await key("Enter")
      await h.waitFor(async () => (await cap()).includes("smoke memory fact"), "entry shown", { timeoutMs: 8000 })

      const file = join(sensusHome, "memory", "MEMORY.md")
      await h.waitFor(
        () => {
          try {
            return readFileSync(file, "utf8").includes("smoke memory fact")
          } catch {
            return false
          }
        },
        "persisted",
        { timeoutMs: 5000 },
      )
      console.log("[mem] manager add + persist ok")

      await key("Escape")
      await h.waitFor(async () => !(await cap()).includes("MEMORY.md"), "manager closed", { timeoutMs: 5000 })
      console.log("[mem] clean close")
    } finally {
      // The app detaches (D4): stop the sandbox daemon so it cannot leak.
      await stopSandboxDaemon(sensusHome).catch(() => {})
      try {
        rmSync(home, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
    },
    60_000,
  )
})
