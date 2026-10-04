/**
 * Pane shell launcher (docs/terminal-layer.md "Controlling terminal").
 *
 * The pure argv shape is asserted directly; the second test is the regression
 * that matters: a zsh pane spawned the way sensus spawns it must be able to
 * `open("/dev/tty")`, which is exactly what sudo/ssh/gpg need and what broke
 * when the shell was spawned directly (setsid without TIOCSCTTY).
 */

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { shellLaunchArgv } from "../../../src/terminal/launch.ts"

const scratch: string[] = []
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

function firstExisting(paths: string[]): string | null {
  for (const p of paths) if (existsSync(p)) return p
  return null
}

describe("pane shell launch (controlling terminal)", () => {
  test("wraps a non-bash shell through bash; bash spawns directly", () => {
    expect(shellLaunchArgv("/bin/bash")).toEqual(["/bin/bash"])
    expect(shellLaunchArgv("/usr/bin/bash")).toEqual(["/usr/bin/bash"])
    if (existsSync("/bin/bash")) {
      expect(shellLaunchArgv("/usr/bin/zsh")).toEqual(["/bin/bash", "-c", 'exec "$0" "$@"', "/usr/bin/zsh"])
      expect(shellLaunchArgv("/usr/local/bin/fish")).toEqual(["/bin/bash", "-c", 'exec "$0" "$@"', "/usr/local/bin/fish"])
    } else {
      // No bash on this host: never wrap (bash is only used when present).
      expect(shellLaunchArgv("/usr/bin/zsh")).toEqual(["/usr/bin/zsh"])
    }
  })

  test("extraArgs are handed to the real shell, never the wrapper bash", () => {
    // bash direct: flags land on the requested shell.
    expect(shellLaunchArgv("/bin/bash", ["--rcfile", "/tmp/rc"])).toEqual(["/bin/bash", "--rcfile", "/tmp/rc"])
    if (existsSync("/bin/bash")) {
      // wrapped: flags ride after $0 in the exec form.
      expect(shellLaunchArgv("/usr/bin/zsh", ["-x"])).toEqual([
        "/bin/bash",
        "-c",
        'exec "$0" "$@"',
        "/usr/bin/zsh",
        "-x",
      ])
    } else {
      expect(shellLaunchArgv("/usr/bin/zsh", ["-x"])).toEqual(["/usr/bin/zsh", "-x"])
    }
  })

  test("the spawned shell can open /dev/tty (sudo/ssh need it)", async () => {
    const zsh = firstExisting(["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh"])
    if (zsh === null || !existsSync("/bin/bash")) return // host without zsh: covered above
    const dir = mkdtempSync(join(tmpdir(), "sensus-ctty-"))
    scratch.push(dir)
    const zdot = join(dir, "zdot")
    const marker = join(dir, "ok")
    mkdirSync(zdot, { recursive: true })

    const term = new Bun.Terminal({
      cols: 80,
      rows: 24,
      name: "xterm-256color",
      data: () => {},
    })
    const proc = Bun.spawn({
      cmd: shellLaunchArgv(zsh),
      terminal: term,
      detached: true,
      env: { ...process.env, TERM: "xterm-256color", ZDOTDIR: zdot },
    })
    try {
      // Input is buffered by the PTY, so a fixed delay is only to avoid racing
      // the very first shell startup; correctness comes from the marker poll.
      await Bun.sleep(500)
      term.write(`if exec 3</dev/tty 2>/dev/null; then printf ok > '${marker}'; fi; exit\n`)
      const deadline = Date.now() + 5000
      while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(50)
      expect(existsSync(marker)).toBe(true)
    } finally {
      try {
        proc.kill()
      } catch {
        // already gone
      }
      try {
        term.close()
      } catch {
        // ignore
      }
    }
  })
})
