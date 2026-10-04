/**
 * Shell integration (docs/terminal-layer.md "Status & facts").
 *
 * The pure planners are asserted directly; the second half is the regression
 * that matters: a zsh/bash pane spawned the way sensus spawns it must report
 * `cd`'s new directory via OSC 7, while still sourcing the user's rc (proved by
 * a marker the rc writes). Without integration the cwd chip froze at the spawn
 * directory — the reported bug.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { shellLaunchArgv } from "../../../src/terminal/launch.ts"
import {
  bashRcFile,
  cleanupShellIntegration,
  integrationFiles,
  prepareShellIntegration,
  shellFamily,
  shellIntegrationPlan,
  writeIntegrationFiles,
  zshRcFile,
} from "../../../src/terminal/shellIntegration.ts"

const scratch: string[] = []
const procs: Bun.Subprocess[] = []
const terms: Bun.Terminal[] = []

afterAll(() => {
  for (const p of procs) {
    try {
      p.kill()
    } catch {
      // already gone
    }
  }
  for (const t of terms) {
    try {
      t.close()
    } catch {
      // ignore
    }
  }
  cleanupShellIntegration()
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(d)
  return d
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) if (existsSync(p)) return p
  return null
}

const ZSH = firstExisting(["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh"])
const BASH = firstExisting(["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"])
const OSC7_TMP = /\x1b\]7;file:\/\/[^/]*\/tmp[\x07\x1b]/

/**
 * Spawn `shell` with an integration plan on a real PTY. Returns the terminal
 * (to write commands into) and a getter for the accumulated output. Input is
 * buffered by the PTY, so the delay only avoids racing shell startup.
 */
async function spawnIntegrated(
  shell: string,
  extraEnv: Record<string, string>,
): Promise<{ term: Bun.Terminal; out: () => string }> {
  const dir = scratchDir("sensus-integ-")
  writeIntegrationFiles(dir)
  const plan = shellIntegrationPlan(shell, dir, extraEnv["SENSUS_USER_ZDOTDIR"] ?? extraEnv["HOME"] ?? "")

  const decoder = new TextDecoder()
  let out = ""
  const term = new Bun.Terminal({
    cols: 100,
    rows: 30,
    name: "xterm-256color",
    data: (_t, bytes) => {
      out += decoder.decode(bytes, { stream: true })
    },
  })
  terms.push(term)
  const proc = Bun.spawn({
    cmd: shellLaunchArgv(shell, plan.args),
    terminal: term,
    detached: true,
    env: { ...process.env, TERM: "xterm-256color", ...extraEnv, ...plan.env },
  })
  procs.push(proc)

  await Bun.sleep(500)
  return { term, out: () => out }
}

/** Run `cd /tmp` in an integrated pane and wait for the OSC 7 report. */
async function probeCwd(shell: string, extraEnv: Record<string, string>): Promise<string> {
  const { term, out } = await spawnIntegrated(shell, extraEnv)
  term.write("cd /tmp\n")
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    if (OSC7_TMP.test(out())) break
    await Bun.sleep(50)
  }
  return out()
}

describe("shell integration planning", () => {
  test("shellFamily recognizes zsh/bash/fish and defaults others to posix", () => {
    expect(shellFamily("/bin/zsh")).toBe("zsh")
    expect(shellFamily("/usr/local/bin/bash")).toBe("bash")
    expect(shellFamily("fish")).toBe("fish")
    expect(shellFamily("/bin/sh")).toBe("posix")
    expect(shellFamily("/usr/bin/dash")).toBe("posix")
  })

  test("zsh plan redirects ZDOTDIR and preserves the user's original", () => {
    const plan = shellIntegrationPlan("/bin/zsh", "/tmp/sensus-int", "/home/me/zdot")
    expect(plan.args).toEqual([])
    expect(plan.env).toEqual({
      SENSUS_ZDOTDIR: "/tmp/sensus-int",
      SENSUS_USER_ZDOTDIR: "/home/me/zdot",
      ZDOTDIR: "/tmp/sensus-int",
    })
  })

  test("bash plan uses --rcfile; fish/posix are left alone", () => {
    expect(shellIntegrationPlan("/bin/bash", "/tmp/sensus-int", "/home/me")).toEqual({
      args: ["--rcfile", "/tmp/sensus-int/bashrc"],
      env: {},
    })
    expect(shellIntegrationPlan("/usr/bin/fish", "/tmp/sensus-int", "/home/me")).toEqual({ args: [], env: {} })
    expect(shellIntegrationPlan("/bin/sh", "/tmp/sensus-int", "/home/me")).toEqual({ args: [], env: {} })
  })

  test("integration file bodies carry the OSC 7 report and user-rc source", () => {
    expect(integrationFiles("zsh").map((f) => f.name)).toEqual([".zshenv", ".zshrc"])
    expect(integrationFiles("bash").map((f) => f.name)).toEqual(["bashrc"])
    expect(integrationFiles("fish")).toEqual([])

    for (const body of [zshRcFile(), bashRcFile()]) {
      expect(body).toContain("]7;file://%s%s\\a")
      expect(body).toContain("_sensus_report_cwd")
    }
    expect(zshRcFile()).toContain('. "${SENSUS_USER_ZDOTDIR}/.zshrc"')
    expect(zshRcFile()).toContain("precmd_functions+=(_sensus_report_cwd)")
    expect(zshRcFile()).toContain("bindkey '^[[1;5D' backward-word")
    expect(zshRcFile()).toContain("bindkey '^[[1;5C' forward-word")
    expect(bashRcFile()).toContain('. "${HOME}/.bashrc"')
    expect(bashRcFile()).toContain("PROMPT_COMMAND=")
  })

  test("prepareShellIntegration materializes the dir once", () => {
    const first = prepareShellIntegration("/bin/zsh")
    const second = prepareShellIntegration("/bin/zsh")
    const dir = first.env["ZDOTDIR"]
    expect(typeof dir).toBe("string")
    expect(first.env).toEqual(second.env)
    for (const name of [".zshenv", ".zshrc", "bashrc"]) {
      expect(existsSync(join(dir!, name))).toBe(true)
    }
  })
})

describe("shell integration reports cwd after cd", () => {
  test("zsh sources the user's rc and emits OSC 7 for the new directory", async () => {
    if (ZSH === null) return // host without zsh
    const userZdot = scratchDir("sensus-user-zsh-")
    writeFileSync(join(userZdot, ".zshrc"), "echo USER_ZSHRC_OK\n")
    const out = await probeCwd(ZSH, { SENSUS_USER_ZDOTDIR: userZdot })
    expect(out).toContain("USER_ZSHRC_OK")
    expect(OSC7_TMP.test(out)).toBe(true)
  })

  test("bash replays the user's rc and emits OSC 7 for the new directory", async () => {
    if (BASH === null) return // host without bash
    const home = scratchDir("sensus-user-bash-")
    writeFileSync(join(home, ".bashrc"), "echo USER_BASHRC_OK\n")
    const out = await probeCwd(BASH, { HOME: home })
    expect(out).toContain("USER_BASHRC_OK")
    expect(OSC7_TMP.test(out)).toBe(true)
  })

  test("zsh fills in unbound Ctrl+Left/Right word bindings, never overriding the user's", async () => {
    if (ZSH === null) return // host without zsh
    const userZdot = scratchDir("sensus-user-zsh-bind-")
    // The user's rc explicitly binds Ctrl+Left: the integration must keep it.
    writeFileSync(join(userZdot, ".zshrc"), "bindkey '^[[1;5D' beginning-of-line\n")
    const { term, out } = await spawnIntegrated(ZSH, { SENSUS_USER_ZDOTDIR: userZdot })
    term.write("bindkey '^[[1;5D'; bindkey '^[[1;5C'\n")
    const deadline = Date.now() + 6000
    while (Date.now() < deadline) {
      const text = out()
      if (text.includes("forward-word") && text.includes("beginning-of-line")) break
      await Bun.sleep(50)
    }
    expect(out()).toContain('"^[[1;5D" beginning-of-line')
    expect(out()).toContain('"^[[1;5C" forward-word')
  })

  test("zsh pane: Ctrl+Left skips a word at the prompt once integration is installed", async () => {
    if (ZSH === null) return // host without zsh
    const userZdot = scratchDir("sensus-user-zsh-word-")
    const { term, out } = await spawnIntegrated(ZSH, { SENSUS_USER_ZDOTDIR: userZdot })
    // Type a command, Ctrl+Left twice (before "def" then before "abc"), insert X.
    term.write("echo abc def")
    await Bun.sleep(150)
    term.write("\x1b[1;5D\x1b[1;5D")
    await Bun.sleep(150)
    term.write("X\n")
    const deadline = Date.now() + 6000
    // The executed output line (not the echoed command) is what proves the jump.
    const executed = (): boolean => /\nXabc def\r?\n/.test(out())
    while (Date.now() < deadline) {
      if (executed()) break
      await Bun.sleep(50)
    }
    expect(executed()).toBe(true)
  })
})
