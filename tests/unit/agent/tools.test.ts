/**
 * Tools unit tests (docs/agent.md "Tools"): truncation, path resolution, diff,
 * edit/write planning (not-found / not-unique), hidden command execution
 * (truncation + timeout kill + abort kill), approval classification.
 * Real commands + real files in a temp dir; no PTY, no network.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  approvalDecision,
  commandAllSudoNonInteractive,
  commandHasNonInteractiveSudo,
  commandPrefix,
  commandUsesSudo,
  commandWithSudoAskpass,
  commandWithSudoStdin,
  countSudoInvocations,
  compactDiff,
  diffLinesText,
  executeMemoryTool,
  executeTool,
  isDestructiveCommand,
  isMemoryWrite,
  isSudoPasswordFailure,
  isSudoPasswordRejection,
  matchGlob,
  parseToolArguments,
  planEditFile,
  planWriteFile,
  applyFilePlan,
  resolveToolName,
  resolveToolPath,
  runHiddenCommand,
  startBackgroundJob,
  checkBackgroundJob,
  killBackgroundJob,
  clearJobs,
  suggestAllowPrefix,
  TOOL_SPECS,
  toolApprovalDetail,
  toolParamsSummary,
  truncateHead,
  truncateHeadTail,
} from "../../../src/agent/tools.ts"
import type { MemoryToolBridge } from "../../../src/agent/memory/types.ts"
import type { SessionSearchBridge } from "../../../src/session/indexDb.ts"
import { sudoAskpassBroker } from "../../../src/agent/sudoAskpass.ts"
import { agentKeyAction } from "../../../src/terminal/keys.ts"
import { classifyPaneState } from "../../../src/terminal/paneState.ts"
import { configureLogger, parseLogLine, type LogRecord } from "../../../src/core/log.ts"

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sensus-tools-"))
})

afterAll(() => {
  sudoAskpassBroker.disarm()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

const ctx = (overrides: Partial<Parameters<typeof executeTool>[2]> = {}) => ({
  pane: null,
  paneCwd: dir,
  signal: new AbortController().signal,
  ...overrides,
})

describe("text + path + diff helpers", () => {
  test("truncation: head+tail keeps both ends with a marker, short text passes through, head-only caps", () => {
    const text = "a".repeat(5000) + "MIDDLE" + "b".repeat(5000)
    const out = truncateHeadTail(text, 8000)
    expect(out.length).toBeLessThan(8100)
    expect(out.startsWith("aaaa")).toBe(true)
    expect(out.endsWith("bbbb")).toBe(true)
    expect(out).toContain("truncated")
    expect(truncateHeadTail("short", 8000)).toBe("short")
    const head = truncateHead("x".repeat(70_000), 64_000)
    expect(head.length).toBeLessThan(64_200)
    expect(head).toContain("truncated")
  })

  test("resolveToolPath: relative resolves against the pane cwd; absolute and ~ pass through; null base falls back to cwd", () => {
    expect(resolveToolPath("a/b.txt", dir)).toBe(join(dir, "a/b.txt"))
    expect(resolveToolPath("/etc/hosts", dir)).toBe("/etc/hosts")
    const home = process.env["HOME"] ?? ""
    expect(resolveToolPath("~/notes.md", dir)).toBe(join(home, "notes.md"))
    expect(resolveToolPath("x", null)).toBe(join(process.cwd(), "x"))
  })

  test("diff: changed-line marking; compactDiff keeps context, collapses distant runs, caps rows", () => {
    const d = diffLinesText("one\ntwo\nthree", "one\nTWO\nthree")
    expect(d.some((l) => l.kind === "-" && l.text === "two")).toBe(true)
    expect(d.some((l) => l.kind === "+" && l.text === "TWO")).toBe(true)
    expect(d.filter((l) => l.kind === " ").map((l) => l.text)).toEqual(["one", "three"])
    // Contiguous change: nothing to collapse yet.
    const lines: Array<{ kind: " " | "+" | "-"; text: string }> = []
    for (let i = 0; i < 200; i++) lines.push({ kind: " ", text: `filler ${i}` })
    lines[100] = { kind: "+", text: "CHANGED" }
    const compact = compactDiff(lines, 24)
    expect(compact.some((l) => l.kind === "+" && l.text === "CHANGED")).toBe(true)
    expect(compact.length).toBe(3)
    // Distant changes collapse with "unchanged" markers.
    lines[10] = { kind: "+", text: "A" }
    lines[150] = { kind: "-", text: "filler 150" }
    const collapsed = compactDiff(lines, 24)
    expect(collapsed.some((l) => l.text === "A")).toBe(true)
    expect(collapsed.some((l) => l.text.includes("unchanged line"))).toBe(true)
    // Cap: 200 changed lines cannot fit into 24 rows.
    const many: Array<{ kind: " " | "+" | "-"; text: string }> = []
    for (let i = 0; i < 200; i++) many.push({ kind: "+", text: `add ${i}` })
    const capped = compactDiff(many, 24)
    expect(capped.length).toBe(25)
    expect(capped[capped.length - 1]?.text).toContain("more diff rows")
  })

  test("file plans: edit computes the diff and writes on apply (errors on missing/not-found/not-unique); write marks creation and diffs overwrites", () => {
    // Edit: plan computes, nothing written until apply.
    const f = join(dir, "plan.txt")
    writeFileSync(f, "alpha\nbeta\ngamma\n", "utf8")
    const res = planEditFile({ path: "plan.txt", old_string: "beta", new_string: "BETA2" }, dir)
    if (!res.ok) throw new Error(res.error)
    expect(res.plan.newContent).toBe("alpha\nBETA2\ngamma\n")
    expect(res.plan.diff.some((l) => l.kind === "-" && l.text === "beta")).toBe(true)
    expect(res.plan.diff.some((l) => l.kind === "+" && l.text === "BETA2")).toBe(true)
    expect(readFileSync(f, "utf8")).toBe("alpha\nbeta\ngamma\n")
    expect(applyFilePlan(res.plan)).toContain("wrote")
    expect(readFileSync(f, "utf8")).toBe("alpha\nBETA2\ngamma\n")
    // Edit errors (behavior-level: plan refused, file untouched).
    writeFileSync(join(dir, "dup.txt"), "same\nsame\n")
    expect(planEditFile({ path: "dup.txt", old_string: "same", new_string: "x" }, dir).ok).toBe(false)
    expect(planEditFile({ path: "dup.txt", old_string: "nope", new_string: "x" }, dir).ok).toBe(false)
    expect(planEditFile({}, dir).ok).toBe(false)
    expect(readFileSync(join(dir, "dup.txt"), "utf8")).toBe("same\nsame\n")
    // Write: creation marks `existed:false`; overwrite produces a diff.
    const res2 = planWriteFile({ path: "new.txt", content: "hello\n" }, dir)
    if (!res2.ok) throw new Error(res2.error)
    expect(res2.plan.existed).toBe(false)
    expect(applyFilePlan(res2.plan)).toContain("created")
    const res3 = planWriteFile({ path: "new.txt", content: "world\n" }, dir)
    if (!res3.ok) throw new Error(res3.error)
    expect(res3.plan.existed).toBe(true)
    expect(res3.plan.diff.some((l) => l.kind === "-" && l.text === "hello")).toBe(true)
  })
})

describe("hidden shell (shell_background)", () => {
  test("captures merged output + exit code and honors the given cwd", async () => {
    const r = await runHiddenCommand({ command: "echo out; echo err >&2; exit 3", cwd: dir })
    expect(r.exitCode).toBe(3)
    expect(r.output).toContain("out")
    expect(r.output).toContain("err")
    const pwd = await runHiddenCommand({ command: "pwd", cwd: dir })
    expect(pwd.output.trim()).toBe(dir)
  })

  test("safety rails: timeout kills the child, abort kills the child, stdinData feeds the child", async () => {
    const timedOut = await runHiddenCommand({ command: "echo started; sleep 30", cwd: dir, timeoutS: 1 })
    expect(timedOut.timedOut).toBe(true)
    expect(timedOut.exitCode).toBeNull()
    expect(timedOut.output).toContain("started")
    const ac = new AbortController()
    const running = runHiddenCommand({ command: "sleep 30; echo late", cwd: dir, signal: ac.signal })
    await Bun.sleep(150)
    ac.abort()
    const aborted = await running
    expect(aborted.aborted).toBe(true)
    expect(aborted.exitCode).toBeNull()
    // sudo -S style password on stdin.
    const fed = await runHiddenCommand({ command: "read -s pw; echo got=$pw", cwd: dir, stdinData: "sekrit\n" })
    expect(fed.exitCode).toBe(0)
    expect(fed.output).toContain("got=sekrit")
  }, 8000)

  test("background jobs: start returns an id at once, polling is incremental, unknown ids error cleanly", async () => {
    const id = await startBackgroundJob({ command: "echo one; sleep 0.4; echo two", cwd: dir })
    expect(typeof id).toBe("number")
    const early = await checkBackgroundJob(id)
    expect(early.ok).toBe(true)
    const final = await checkBackgroundJob(id, { wait: true })
    expect(final.ok).toBe(true)
    expect(final.running).toBe(false)
    expect(final.exitCode).toBe(0)
    const all = `${early.output ?? ""}${final.output ?? ""}`
    expect(all).toContain("one")
    expect(all).toContain("two")
    // Output is reported once: the second poll does not repeat it.
    const id2 = await startBackgroundJob({ command: "echo a; sleep 0.2; echo b", cwd: dir })
    const first = await checkBackgroundJob(id2, { wait: true })
    expect(`${first.output ?? ""}`).toContain("a")
    const second = await checkBackgroundJob(id2)
    expect(`${second.output ?? ""}`).not.toContain("a")
    // Unknown job id.
    const missing = await checkBackgroundJob(999_999)
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain("no such job")
  }, 8000)

  test("background jobs stream live output (bounded) during the run, and an aborted wait resolves promptly", async () => {
    // Output is visible on a poll BEFORE the process exits (not only after).
    const id = await startBackgroundJob({ command: "printf 'tick1\\n'; sleep 30", cwd: dir })
    const live = await checkBackgroundJob(id, { wait: true, timeoutS: 1 })
    expect(live.ok).toBe(true)
    expect(live.running).toBe(true)
    expect(live.output).toContain("tick1")
    killBackgroundJob(id)

    // A chatty job's buffer is capped while it runs (never unbounded).
    const chatty = await startBackgroundJob({ command: "yes line | head -c 400000; sleep 30", cwd: dir })
    await Bun.sleep(500)
    const polled = await checkBackgroundJob(chatty)
    expect(polled.running).toBe(true)
    expect(polled.output?.length ?? 0).toBeLessThan(300_000)
    expect(polled.output ?? "").toContain("trimmed")
    killBackgroundJob(chatty)

    // Esc (ctx.signal) aborts a blocking `wait` promptly instead of 30s.
    const ac = new AbortController()
    const blocked = await startBackgroundJob({ command: "sleep 30", cwd: dir })
    const t0 = Date.now()
    const waiting = checkBackgroundJob(blocked, { wait: true, timeoutS: 30, signal: ac.signal })
    await Bun.sleep(150)
    ac.abort()
    const rep = await waiting
    expect(rep.ok).toBe(true)
    expect(rep.running).toBe(true)
    expect(Date.now() - t0).toBeLessThan(3000)
    killBackgroundJob(blocked)
  }, 10000)

  test("a straggler holding the pipe after exit does not crash the daemon (drain timeout cancels via the reader)", async () => {
    // The parent shell exits at once but a backgrounded grandchild inherits the
    // stdout pipe, so EOF never arrives inside the 150ms drain window — the
    // branch that previously called `stream.cancel()` on a locked stream and
    // crashed the process with an unhandled rejection. It must resolve promptly
    // (cancel through the reader unblocks the pump) and emit no rejection.
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    const lines: string[] = []
    configureLogger({ level: "debug", sink: (line) => lines.push(line) })
    process.on("unhandledRejection", onRejection)
    try {
      const t0 = Date.now()
      const r = await runHiddenCommand({ command: "(sleep 5) & echo hi", cwd: dir })
      const elapsed = Date.now() - t0
      expect(r.exitCode).toBe(0)
      expect(r.output).toContain("hi")
      // Well under the straggler's 5s lifetime: the reader cancel settled the
      // pumps instead of waiting for the grandchild to exit.
      expect(elapsed).toBeLessThan(2000)
      await Bun.sleep(50)
      expect(rejections).toEqual([])
      // The lost drain race is visible in the structured log (docs/logging.md):
      // a warn with the cause; the command itself is deliberately not logged.
      const recs = lines.map((l) => parseLogLine(l)).filter((r): r is LogRecord => r !== null)
      const drained = recs.find((rec) => rec.msg === "hidden command force-drained")
      expect(drained?.level).toBe("warn")
      expect(drained?.component).toBe("agent.tools")
      expect(drained?.attributes?.["timedOut"]).toBe(false)
      expect(drained?.attributes?.["aborted"]).toBe(false)
      expect(drained?.attributes?.["command"]).toBeUndefined()
    } finally {
      process.off("unhandledRejection", onRejection)
      configureLogger({ level: "error", sink: () => {} })
    }
  }, 8000)

  test("clearJobs kills and forgets every job (the chat's /clear), so nothing is left running or unfindable", async () => {
    const marker = join(dir, "cleared-marker.txt")
    try { rmSync(marker, { force: true }) } catch { /* ignore */ }
    const id = await startBackgroundJob({ command: `sleep 1; echo alive > ${marker}`, cwd: dir })
    expect(clearJobs()).toBeGreaterThanOrEqual(1)
    // Forgotten: no poll/kill target remains.
    expect((await checkBackgroundJob(id)).ok).toBe(false)
    expect(killBackgroundJob(id).ok).toBe(false)
    // Killed: the delayed write never happens.
    await Bun.sleep(1300)
    expect(existsSync(marker)).toBe(false)
  }, 8000)

  test("clearJobs(owner) drops only that session's jobs — other tabs keep theirs", async () => {
    const a = await startBackgroundJob({ command: "sleep 30", cwd: dir, owner: "chat-1" })
    const b = await startBackgroundJob({ command: "sleep 30", cwd: dir, owner: "chat-2" })
    expect(clearJobs("chat-1")).toBeGreaterThanOrEqual(1)
    // The cleared session's job is gone; the other session's is still pollable.
    expect((await checkBackgroundJob(a)).ok).toBe(false)
    expect((await checkBackgroundJob(b)).ok).toBe(true)
    clearJobs()
  }, 8000)

  test("reaping the oldest job kills it — no orphan runs on with no id left to stop it", async () => {
    const pidFile = join(dir, "reaped.pid")
    try { rmSync(pidFile, { force: true }) } catch { /* ignore */ }
    const oldest = await startBackgroundJob({ command: `echo $$ > ${pidFile}; sleep 30`, cwd: dir })
    for (let i = 0; i < 50 && !existsSync(pidFile); i++) await Bun.sleep(20)
    const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10)
    expect(Number.isFinite(pid)).toBe(true)
    // Push the registry past MAX_JOBS (32): the oldest job is reaped.
    for (let i = 0; i < 32; i++) await startBackgroundJob({ command: "true", cwd: dir })
    expect((await checkBackgroundJob(oldest)).ok).toBe(false)
    await Bun.sleep(200)
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
    clearJobs()
  }, 15000)
})

describe("shell_session key encoding (agentKeyAction)", () => {
  test("maps agent key names to terminal key actions; unknown names are null", () => {
    // Fixture table: [agent key, expected action]
    const cases: Array<[string, ReturnType<typeof agentKeyAction>]> = [
      ["enter", { kind: "keys", names: ["Enter"] }],
      ["tab", { kind: "keys", names: ["Tab"] }],
      ["up", { kind: "keys", names: ["Up"] }],
      ["pgup", { kind: "keys", names: ["PageUp"] }],
      ["escape", { kind: "keys", names: ["Escape"] }],
      ["space", { kind: "literal", text: " " }],
      ["ctrl+c", { kind: "keys", names: ["C-C"] }],
      ["c-c", { kind: "keys", names: ["C-C"] }],
      ["alt+x", { kind: "keys", names: ["M-X"] }],
      ["m-x", { kind: "keys", names: ["M-X"] }],
      ["shift+tab", { kind: "keys", names: ["S-Tab"] }],
      ["f5", { kind: "keys", names: ["F5"] }],
      ["", null],
      ["wat", null],
    ]
    for (const [key, expected] of cases) expect(agentKeyAction(key)).toEqual(expected)
  })
})

describe("sudo detection / retry helpers", () => {
  test("failure patterns, real-sudo detection, and the FIRST-sudo -S rewrite", () => {
    for (const out of ["sudo: a password is required", "sudo: no password was provided", "sudo: a terminal is required", "[sudo] password for root:", "sudo: 3 incorrect password attempts", "Sorry, try again."]) {
      expect(isSudoPasswordFailure(out)).toBe(true)
    }
    expect(isSudoPasswordFailure("rm: cannot remove '/x': Permission denied")).toBe(false)
    expect(isSudoPasswordFailure("")).toBe(false)
    expect(commandUsesSudo("sudo ls")).toBe(true)
    expect(commandUsesSudo("echo sudo word")).toBe(false)
    expect(commandUsesSudo("true && sudo apt update")).toBe(true)
    // Wrapped invocations the old boundary missed (they skipped the popup and
    // let the model retry the failing command): env assignments, timeout,
    // env/nohup wrappers, parens. A sudo ARGUMENT (echo/grep) stays false.
    expect(commandUsesSudo("DEBIAN_FRONTEND=noninteractive sudo apt-get update")).toBe(true)
    expect(commandUsesSudo("FOO=1 sudo -n true")).toBe(true)
    expect(commandUsesSudo("timeout 300 sudo apt-get install -y x")).toBe(true)
    expect(commandUsesSudo("env FOO=bar sudo id")).toBe(true)
    expect(commandUsesSudo("nohup sudo id")).toBe(true)
    expect(commandUsesSudo("(sudo id)")).toBe(true)
    expect(commandUsesSudo("grep sudo file")).toBe(false)
    expect(commandUsesSudo("printf 'sudo: a password is required'")).toBe(false)
    expect(commandWithSudoStdin("sudo id")).toBe("sudo -S -p '' id")
    expect(commandWithSudoStdin("echo hi && sudo id -u")).toBe("echo hi && sudo -S -p '' id -u")
    expect(commandWithSudoStdin("DEBIAN_FRONTEND=noninteractive sudo apt-get update")).toBe(
      "DEBIAN_FRONTEND=noninteractive sudo -S -p '' apt-get update",
    )
    expect(commandWithSudoStdin("timeout 300 sudo apt-get update")).toBe("timeout 300 sudo -S -p '' apt-get update")
    expect(commandWithSudoStdin("echo hi")).toBe("echo hi")
    // A real rejection (sudo TRIED the password) is distinct from "a password
    // is required" — the latter also comes from -n / nested / missing-askpass
    // and must NOT drop the cached vault.
    expect(isSudoPasswordRejection("sudo: 3 incorrect password attempts")).toBe(true)
    expect(isSudoPasswordRejection("Sorry, try again.")).toBe(true)
    expect(isSudoPasswordRejection("sudo: a password is required")).toBe(false)
    expect(isSudoPasswordRejection("sudo: no askpass program specified")).toBe(false)
    // -n detection looks only at the first option, so `grep -n` is not a hit.
    expect(commandHasNonInteractiveSudo("sudo -n id")).toBe(true)
    expect(commandHasNonInteractiveSudo("sudo --non-interactive id")).toBe(true)
    expect(commandHasNonInteractiveSudo("sudo -Sn id")).toBe(true)
    expect(commandHasNonInteractiveSudo("sudo -k whoami")).toBe(false)
    expect(commandHasNonInteractiveSudo("sudo grep -n foo")).toBe(false)
    expect(commandHasNonInteractiveSudo("sudo id")).toBe(false)
    // "All -n" is the only skip case — a mixed line must still be rescued.
    expect(commandAllSudoNonInteractive("sudo -n true")).toBe(true)
    expect(commandAllSudoNonInteractive("sudo -n true && sudo -n id")).toBe(true)
    expect(commandAllSudoNonInteractive("sudo -n true; sudo whoami")).toBe(false)
    expect(commandAllSudoNonInteractive("sudo whoami")).toBe(false)
  })
})

describe("executeTool", () => {
  test("shell_background returns exit code + merged output and truncates huge output", async () => {
    const r = await executeTool("shell_background", { command: "echo EXEC-OK" }, ctx())
    expect(r.ok).toBe(true)
    expect(r.exitCode).toBe(0)
    expect(r.result).toContain("EXEC-OK")
    const big = await executeTool("shell_background", { command: "seq 1 20000" }, ctx())
    expect(big.ok).toBe(true)
    // Boundary cap (default tool_output: 2000 lines / 51200 bytes), tail bias:
    // the last ~2000 lines survive (~12k chars) plus the truncation hint.
    expect(big.result.length).toBeLessThan(13_000)
    expect(big.truncated).toBe(true)
    expect(big.result).toContain("lines truncated")
    expect(big.preview.length).toBeLessThan(1300)
  })

  test("shell_background background:true starts a job; job polling reports status via the job param", async () => {
    const start = await executeTool("shell_background", { command: "echo J-OUT", background: true }, ctx())
    expect(start.ok).toBe(true)
    expect(start.result).toMatch(/started background job #\d+/)
    const m = /#(\d+)/.exec(start.result)
    expect(m).not.toBeNull()
    const poll = await executeTool("shell_background", { job: Number(m?.[1]), wait: true }, ctx())
    expect(poll.ok).toBe(true)
    expect(poll.result).toContain("J-OUT")
    expect(poll.result).toContain("exit 0")
  }, 5000)

  test("shell_session types text, special keys, and enter through the pane; unknown keys are dropped", async () => {
    const sent: Array<{ kind: string; text?: string; names?: string[] }> = []
    const r = await executeTool(
      "shell_session",
      { text: "ls", keys: ["enter", "ctrl+c", "bogus-key"], enter: false },
      ctx({
        pane: {
          sendKeys: async (a) => {
            sent.push(a)
          },
          captureScrollbackRaw: async () => "",
        },
      }),
    )
    expect(r.ok).toBe(true)
    expect(sent).toHaveLength(3)
    expect(sent[0]?.kind).toBe("literal")
    expect(sent[0]?.text).toBe("ls")
    expect(sent[1]).toEqual({ kind: "keys", names: ["Enter"] })
    expect(sent[2]).toEqual({ kind: "keys", names: ["C-C"] })
    expect(r.result).toContain("visible pane")
    expect(r.result).toContain("dropped unknown keys: bogus-key")
  })

  test("shell_session + sudo: reuses the session password and types it with askpass (no in-pane prompt)", async () => {
    const sent: Array<{ kind: string; text?: string; names?: string[] }> = []
    let asked = 0
    const r = await executeTool(
      "shell_session",
      { text: "sudo whoami", enter: true },
      ctx({
        pane: {
          sendKeys: async (a) => {
            sent.push(a)
          },
          captureScrollbackRaw: async () => "",
        },
        hasSudoPassword: () => true,
        requestSudo: async () => {
          asked++
          return "cached-pw"
        },
      }),
    )
    expect(r.ok).toBe(true)
    expect(asked).toBe(1)
    // Rewritten so sudo reads the helper, not a pane prompt.
    expect(sent[0]).toEqual({ kind: "literal", text: "sudo -A whoami" })
    // The note no longer overclaims "authenticated": it says the password was
    // used via askpass, and the pane check saw no rejection.
    expect(r.result).toContain("session password")
    expect(r.result).toContain("askpass")
  })

  test("shell_session + sudo: asks via the seam when not cached, then types the askpass form", async () => {
    const sent: Array<{ kind: string; text?: string; names?: string[] }> = []
    let asked = 0
    const r = await executeTool(
      "shell_session",
      { text: "sudo /usr/sbin/pct enter 100", enter: true },
      ctx({
        pane: {
          sendKeys: async (a) => {
            sent.push(a)
          },
          captureScrollbackRaw: async () => "",
        },
        requestSudo: async (cmd) => {
          asked++
          expect(cmd).toContain("pct enter 100")
          return "typed-pw"
        },
      }),
    )
    expect(r.ok).toBe(true)
    expect(asked).toBe(1)
    expect(sent[0]?.text).toBe("sudo -A /usr/sbin/pct enter 100")
  })

  test("shell_session + sudo: a declined password types nothing and tells the model not to retry", async () => {
    const sent: Array<{ kind: string; text?: string; names?: string[] }> = []
    const r = await executeTool(
      "shell_session",
      { text: "sudo systemctl restart nginx", enter: true },
      ctx({
        pane: {
          sendKeys: async (a) => {
            sent.push(a)
          },
          captureScrollbackRaw: async () => "",
        },
        requestSudo: async () => null,
      }),
    )
    expect(r.ok).toBe(false)
    expect(sent).toHaveLength(0)
    expect(r.result).toContain("Do not retry")
  })

  test("shell_session + sudo without a popup still types the command, but instructs the model to wait", async () => {
    const sent: Array<{ kind: string; text?: string; names?: string[] }> = []
    const r = await executeTool(
      "shell_session",
      { text: "sudo whoami", enter: true },
      ctx({
        pane: {
          sendKeys: async (a) => {
            sent.push(a)
          },
          captureScrollbackRaw: async () => "",
        },
      }),
    )
    expect(r.ok).toBe(true)
    expect(sent[0]?.text).toBe("sudo whoami")
    expect(r.result).toContain("waiting for YOUR sudo password")
    expect(r.result).toContain("do not retry")
  })

  test("sudo retry: password failure without a popup returns guidance; the popup seam retries via askpass", async () => {
    // Guidance path: a stub command whose output mimics sudo's tty-less
    // failure (hermetic — no real sudo involved).
    const script = join(dir, "fake-sudo.sh")
    writeFileSync(script, "#!/bin/sh\necho 'sudo: a password is required' >&2\nexit 1\n", { mode: 0o755 })
    const failed = await executeTool("shell_background", { command: `sudo ${script}` }, ctx())
    expect(failed.ok).toBe(false)
    expect(failed.result).toContain("sudo password")
    expect(failed.result).toContain("Ask the user")
    // Popup seam: a fake `sudo` shim — without -A it fails like a tty-less
    // sudo; with -A it invokes $SUDO_ASKPASS (the helper the executor made) and
    // uses the password it prints. The command's stdin is never involved.
    writeFileSync(
      join(dir, "sudo"),
      '#!/bin/sh\naskpass_mode=0\nfor a in "$@"; do [ "$a" = "-A" ] && askpass_mode=1; done\n' +
        'if [ "$askpass_mode" = "1" ]; then pw=$("$SUDO_ASKPASS"); echo "authenticated=$pw"; exit 0; fi\n' +
        'echo "sudo: a password is required" >&2\nexit 1\n',
      { mode: 0o755 },
    )
    let asked = 0
    const ok = await executeTool(
      "shell_background",
      { command: `export PATH="${dir}:$PATH"; sudo ls` },
      ctx({
        requestSudo: async () => {
          asked++
          return "typed-password"
        },
      }),
    )
    expect(ok.ok).toBe(true)
    expect(asked).toBe(1)
    expect(ok.result).toContain("authenticated=typed-password")
    // Wrong password: the executor re-prompts (bounded), reports the password
    // as incorrect — NOT a user decline — and drops the bad cached password.
    writeFileSync(
      join(dir, "sudo"),
      '#!/bin/sh\naskpass_mode=0\nfor a in "$@"; do [ "$a" = "-A" ] && askpass_mode=1; done\n' +
        'if [ "$askpass_mode" = "1" ]; then echo "Sorry, try again." >&2; echo "sudo: 3 incorrect password attempts" >&2; exit 1; fi\n' +
        'echo "sudo: a password is required" >&2\nexit 1\n',
      { mode: 0o755 },
    )
    let rejected = 0
    let wrongAsked = 0
    const bad = await executeTool(
      "shell_background",
      { command: `export PATH="${dir}:$PATH"; sudo ls` },
      ctx({
        requestSudo: async () => {
          wrongAsked++
          return "wrong"
        },
        onSudoRejected: () => rejected++,
      }),
    )
    expect(bad.ok).toBe(false)
    expect(bad.result).toContain("not accepted")
    expect(bad.result).toContain("incorrect")
    // The model is told this is a WRONG PASSWORD, not a user decline.
    expect(bad.result.toLowerCase()).toContain("not a cancellation")
    expect(bad.result).not.toContain("prompt was declined")
    // Bounded: three password submissions total, and each rejection dropped
    // the (empty) vault so the next ask happens.
    expect(wrongAsked).toBe(3)
    expect(rejected).toBe(3)
  })

  test("sudo retry: a wrong password re-prompts with a hint and authenticates on the next try", async () => {
    writeFileSync(
      join(dir, "sudo"),
      '#!/bin/sh\naskpass_mode=0\nfor a in "$@"; do [ "$a" = "-A" ] && askpass_mode=1; done\n' +
        'if [ "$askpass_mode" = "1" ]; then pw=$("$SUDO_ASKPASS");\n' +
        '  if [ "$pw" = "good" ]; then echo "auth:$pw"; exit 0; fi\n' +
        '  echo "Sorry, try again." >&2; echo "sudo: 3 incorrect password attempts" >&2; exit 1; fi\n' +
        'echo "sudo: a password is required" >&2\nexit 1\n',
      { mode: 0o755 },
    )
    const hints: Array<string | undefined> = []
    let asked = 0
    let rejected = 0
    const r = await executeTool(
      "shell_background",
      { command: `export PATH="${dir}:$PATH"; sudo id` },
      ctx({
        requestSudo: async (_cmd, hint) => {
          asked++
          hints.push(hint)
          return asked === 1 ? "bad" : "good"
        },
        onSudoRejected: () => rejected++,
      }),
    )
    expect(r.ok).toBe(true)
    expect(r.result).toContain("auth:good")
    // Two submissions: the first (wrong) triggered the re-prompt, the second
    // authenticated. The re-prompt explained itself via the hint.
    expect(asked).toBe(2)
    expect(hints[0]).toBeUndefined()
    expect(hints[1]).toContain("wrong password")
    expect(rejected).toBe(1)
  })

  test("shell_session sudo: a NEW pane rejection reports the password as incorrect (not a cancel) and drops the vault", async () => {
    let captures = 0
    let rejected = 0
    const r = await executeTool(
      "shell_session",
      { text: "sudo whoami", enter: true },
      ctx({
        pane: {
          sendKeys: async () => {},
          // First capture is the BEFORE snapshot (empty); the later poll sees
          // the rejection sudo just printed.
          captureScrollbackRaw: async () => {
            captures++
            return captures === 1 ? "" : "Sorry, try again.\nsudo: 3 incorrect password attempts"
          },
        },
        requestSudo: async () => "bad-pw",
        onSudoRejected: () => rejected++,
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.result).toContain("incorrect")
    expect(r.result.toLowerCase()).toContain("not a cancellation")
    expect(r.result).not.toContain("no password was provided")
    expect(rejected).toBe(1)
  })

  test("shell_session sudo: a stale rejection already in the pane is NOT a false positive", async () => {
    // The before-snapshot already shows a rejection, so it cannot be
    // attributed to this command: the outcome is "unknown", not a failure.
    let rejected = 0
    const r = await executeTool(
      "shell_session",
      { text: "sudo whoami", enter: true },
      ctx({
        pane: {
          sendKeys: async () => {},
          captureScrollbackRaw: async () => "Sorry, try again.\nsudo: 3 incorrect password attempts",
        },
        requestSudo: async () => "pw",
        onSudoRejected: () => rejected++,
      }),
    )
    expect(r.ok).toBe(true)
    expect(rejected).toBe(0)
    expect(r.result).toContain("earlier sudo failure")
  })

  test("a -n/--non-interactive sudo never prompts and never touches the cached vault", async () => {
    writeFileSync(
      join(dir, "sudo"),
      '#!/bin/sh\necho "sudo: a password is required" >&2\nexit 1\n',
      { mode: 0o755 },
    )
    let asked = 0
    let rejected = 0
    const r = await executeTool(
      "shell_background",
      { command: `export PATH="${dir}:$PATH"; sudo -n id` },
      ctx({
        requestSudo: async () => {
          asked++
          return "pw"
        },
        onSudoRejected: () => rejected++,
      }),
    )
    expect(r.ok).toBe(false)
    expect(asked).toBe(0)
    expect(rejected).toBe(0)
    expect(r.result).toContain("non-interactive")
  })

  test("a -n sudo failing inside a successful chain (exit 0) still surfaces the guidance", async () => {
    writeFileSync(join(dir, "sudo"), '#!/bin/sh\necho "sudo: a password is required" >&2\nexit 1\n', { mode: 0o755 })
    let asked = 0
    const r = await executeTool(
      "shell_background",
      { command: `export PATH="${dir}:$PATH"; sudo -n true; echo AFTER` },
      ctx({ requestSudo: async () => { asked++; return "pw" } }),
    )
    expect(asked).toBe(0) // never prompts for -n
    expect(r.exitCode).toBe(0) // the chain's last command succeeded
    expect(r.result).toContain("AFTER")
    expect(r.result).toContain("non-interactive")
  })

  test("a retry that needs a password but does not try it keeps the vault (no bogus clear)", async () => {
    // The shim fails the same way for the first run and the askpass retry,
    // without ever printing a rejection — so the password was never tested.
    writeFileSync(
      join(dir, "sudo"),
      '#!/bin/sh\necho "sudo: a password is required" >&2\nexit 1\n',
      { mode: 0o755 },
    )
    let asked = 0
    let rejected = 0
    const r = await executeTool(
      "shell_background",
      { command: `export PATH="${dir}:$PATH"; sudo true` },
      ctx({
        requestSudo: async () => {
          asked++
          return "pw"
        },
        onSudoRejected: () => rejected++,
      }),
    )
    expect(asked).toBe(1)
    expect(rejected).toBe(0)
    expect(r.result).toContain("kept")
  })

  test("multi-sudo retry: every sudo invocation uses askpass (command stdin untouched)", async () => {
    // A shim that authenticates only via $SUDO_ASKPASS and echoes the
    // subcommand — proves BOTH sudo's get the password, not just the first
    // (the `sudo -k true && sudo whoami` regression).
    writeFileSync(
      join(dir, "sudo"),
      '#!/bin/sh\nif [ "$1" = "-A" ]; then pw=$("$SUDO_ASKPASS"); echo "auth:$2:$pw"; exit 0; fi\n' +
        'echo "sudo: a password is required" >&2\nexit 1\n',
      { mode: 0o755 },
    )
    const command = `export PATH="${dir}:$PATH"; sudo first && sudo second`
    expect(countSudoInvocations(command)).toBe(2)
    expect(commandWithSudoAskpass(command)).toBe(`export PATH="${dir}:$PATH"; sudo -A first && sudo -A second`)
    expect(commandWithSudoStdin(command)).toBe(
      `export PATH="${dir}:$PATH"; sudo -S -p '' first && sudo -S -p '' second`,
    )
    let asked = 0
    const r = await executeTool(
      "shell_background",
      { command },
      ctx({ requestSudo: async () => { asked++; return "pw" } }),
    )
    expect(asked).toBe(1)
    expect(r.ok).toBe(true)
    expect(r.result).toContain("auth:first:pw")
    expect(r.result).toContain("auth:second:pw")
  })

  test("a cached password is used PROACTIVELY, so a compound cannot mask the sudo step (exit 0)", async () => {
    writeFileSync(
      join(dir, "sudo"),
      '#!/bin/sh\nif [ "$1" = "-A" ]; then pw=$("$SUDO_ASKPASS"); echo "auth:$2:$pw"; exit 0; fi\n' +
        'echo "sudo: a password is required" >&2\nexit 1\n',
      { mode: 0o755 },
    )
    let asked = 0
    const r = await executeTool(
      "shell_background",
      { command: `export PATH="${dir}:$PATH"; sudo id; echo AFTER` },
      ctx({ hasSudoPassword: () => true, requestSudo: async () => { asked++; return "cached" } }),
    )
    expect(asked).toBe(1) // resolved once, with no popup
    expect(r.result).toContain("auth:id:cached")
    expect(r.result).toContain("AFTER")
    expect(r.result).not.toContain("a password is required")
  })

  test("a masked sudo failure (trailing echo → exit 0) still triggers the prompt + askpass retry", async () => {
    writeFileSync(
      join(dir, "sudo"),
      '#!/bin/sh\nif [ "$1" = "-A" ]; then pw=$("$SUDO_ASKPASS"); echo "auth:$2:$pw"; exit 0; fi\n' +
        'echo "sudo: a terminal is required to read the password" >&2\nexit 1\n',
      { mode: 0o755 },
    )
    let asked = 0
    const r = await executeTool(
      "shell_background",
      { command: `export PATH="${dir}:$PATH"; sudo id; echo AFTER` },
      ctx({ requestSudo: async () => { asked++; return "typed" } }),
    )
    expect(asked).toBe(1)
    expect(r.result).toContain("auth:id:typed")
    expect(r.result).toContain("AFTER")
  })

  test("a mixed line with a sudo -n probe still rescues the plain sudo (the -k trap)", async () => {
    // A sudo shim that honours -n (fails without prompting) and authenticates
    // other calls via askpass.
    writeFileSync(
      join(dir, "sudo"),
      '#!/bin/sh\nfor a in "$@"; do [ "$a" = "-n" ] && { echo "sudo: a password is required" >&2; exit 1; }; done\n' +
        'if [ "$1" = "-A" ]; then pw=$("$SUDO_ASKPASS"); echo "auth:$2:$pw"; exit 0; fi\n' +
        'echo "sudo: a password is required" >&2\nexit 1\n',
      { mode: 0o755 },
    )
    const command = `export PATH="${dir}:$PATH"; sudo -n true; sudo -k; sudo whoami; echo AFTER`
    let asked = 0
    const r = await executeTool(
      "shell_background",
      { command },
      ctx({ hasSudoPassword: () => true, requestSudo: async () => { asked++; return "cached" } }),
    )
    expect(asked).toBe(1)
    // The plain `sudo whoami` was rescued; the -n part cannot be.
    expect(r.result).toContain("auth:whoami:cached")
    expect(r.result).toContain("AFTER")
    expect(r.result).toContain("non-interactive")
  })

  test("without a cache, a mixed -n line prompts and rescues the plain sudo too", async () => {
    writeFileSync(
      join(dir, "sudo"),
      '#!/bin/sh\nfor a in "$@"; do [ "$a" = "-n" ] && { echo "sudo: a password is required" >&2; exit 1; }; done\n' +
        'if [ "$1" = "-A" ]; then pw=$("$SUDO_ASKPASS"); echo "auth:$2:$pw"; exit 0; fi\n' +
        'echo "sudo: a terminal is required to read the password" >&2\nexit 1\n',
      { mode: 0o755 },
    )
    const command = `export PATH="${dir}:$PATH"; sudo -n true; sudo whoami; echo AFTER`
    let asked = 0
    const r = await executeTool(
      "shell_background",
      { command },
      ctx({ requestSudo: async () => { asked++; return "typed" } }),
    )
    expect(asked).toBe(1)
    expect(r.result).toContain("auth:whoami:typed")
    expect(r.result).toContain("AFTER")
  })

  test("askpass retry leaves the command's stdin alone (a command piped INTO sudo works)", async () => {
    // The `-S` approach fed the password on stdin, so `echo data | sudo tee f`
    // had its data mistaken for a password. Askpass never touches stdin.
    writeFileSync(
      join(dir, "sudo"),
      '#!/bin/sh\nif [ "$1" = "-A" ]; then pw=$("$SUDO_ASKPASS"); shift; exec "$@"; fi\n' +
        'echo "sudo: a password is required" >&2\nexit 1\n',
      { mode: 0o755 },
    )
    const out = join(dir, "piped-out.txt")
    const r = await executeTool(
      "shell_background",
      { command: `export PATH="${dir}:$PATH"; printf PAYLOAD | sudo tee ${out}` },
      ctx({ requestSudo: async () => "pw" }),
    )
    expect(r.ok).toBe(true)
    expect(readFileSync(out, "utf8")).toBe("PAYLOAD")
  })

  test("read tools: read_file pages with offset/limit and errors cleanly; get_scrollback uses the deep capture", async () => {
    writeFileSync(join(dir, "read.txt"), "l1\nl2\nl3\n")
    const r = await executeTool("read_file", { path: "read.txt", offset: 2, limit: 1 }, ctx())
    expect(r.result).toBe("l2\n(file has more lines — raise limit or offset)")
    const miss = await executeTool("read_file", { path: "nope.txt" }, ctx())
    expect(miss.ok).toBe(false)
    expect(miss.result).toContain("cannot read")
    // Never open a directory / device / FIFO (a whole-file read would OOM or
    // block the TUI thread forever).
    const asDir = await executeTool("read_file", { path: "." }, ctx())
    expect(asDir.ok).toBe(false)
    expect(asDir.result).toContain("is a directory")
    const asDevice = await executeTool("read_file", { path: "/dev/null" }, ctx())
    expect(asDevice.ok).toBe(false)
    expect(asDevice.result).toContain("not a regular file")
    // A file over the read cap is served as a bounded window, never loaded whole.
    const big = join(dir, "big.txt")
    const bigLine = "y".repeat(2000)
    writeFileSync(big, `${bigLine}\n`.repeat(5000), "utf8")
    const windowed = await executeTool("read_file", { path: "big.txt", offset: 1, limit: 5 }, ctx())
    expect(windowed.ok).toBe(true)
    expect(windowed.result).toContain("yyyy")
    expect(windowed.result).toContain("(file has more lines — raise limit or offset)")
    // ...and an unbounded read is still capped to the tool-output size.
    const capped = await executeTool("read_file", { path: "big.txt" }, ctx())
    expect(capped.ok).toBe(true)
    expect((capped.result ?? "").length).toBeLessThan(200_000)
    // edit_file refuses a file too large to search/replace safely.
    const bigEdit = planEditFile({ path: "big.txt", old_string: "yyy", new_string: "zzz" }, dir)
    expect(bigEdit.ok).toBe(false)
    if (!bigEdit.ok) expect(bigEdit.error).toContain("too large to edit")
    // write_file's diff read is bounded too (the plan still succeeds).
    const bigWrite = planWriteFile({ path: "big.txt", content: "replacement\n" }, dir)
    expect(bigWrite.ok).toBe(true)
    if (bigWrite.ok) expect(bigWrite.plan.diff.length).toBeLessThanOrEqual(41)
    const scroll = await executeTool("get_scrollback", { lines: 10 }, ctx({ pane: {
      sendKeys: async () => {},
      captureScrollbackRaw: async (lines) => `captured ${lines}`,
    } }))
    expect(scroll.result).toBe("captured 10")
  })

  test("view_image reads a real image file into an attachment; non-images and missing paths error cleanly", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    )
    writeFileSync(join(dir, "pic.png"), png)
    const r = await executeTool("view_image", { path: "pic.png" }, ctx())
    expect(r.ok).toBe(true)
    expect(r.images?.length).toBe(1)
    expect(r.images?.[0]?.mediaType).toBe("image/png")
    expect(r.images?.[0]?.width).toBe(1)
    expect(r.result).toContain("attached in the next message")
    writeFileSync(join(dir, "not-image.txt"), "hello")
    const bad = await executeTool("view_image", { path: "not-image.txt" }, ctx())
    expect(bad.ok).toBe(false)
    expect(bad.images).toBeUndefined()
    expect((await executeTool("view_image", { path: "missing.png" }, ctx())).ok).toBe(false)
    expect((await executeTool("view_image", {}, ctx())).ok).toBe(false)
  })

  test("reload re-reads config/instructions/agents via the seam (the /reload action); no seam and failure degrade", async () => {
    let called = 0
    const ok = await executeTool(
      "reload",
      {},
      ctx({
        reloadConfig: () => {
          called++
          return "config reloaded (1 endpoint(s) · 2 agent(s))"
        },
      }),
    )
    expect(called).toBe(1)
    expect(ok.ok).toBe(true)
    expect(ok.result).toContain("config reloaded")
    // A failed reload (null message) surfaces as an error, never a throw.
    const failed = await executeTool("reload", {}, ctx({ reloadConfig: () => null }))
    expect(failed.ok).toBe(false)
    expect(failed.result).toContain("reload failed")
    // No config host wired: degrades cleanly.
    expect((await executeTool("reload", {}, ctx())).ok).toBe(false)
    expect(toolParamsSummary("reload", {})).toBe("config + agents")
    // Confirm mode gates it like every other tool.
    expect(approvalDecision("reload", "confirm", {}, []).gate).toBe(true)
  })
})

describe("approval classification", () => {
  test("confirm mode: every tool gates except ask_user; allow-prefix exempts, prefix is suggested", () => {
    for (const name of [
      "read_file",
      "get_scrollback",
      "session_search",
      "session_list",
      "session_view",
      "view_image",
      "reload",
      "memory",
      "host_scan",
      "edit_file",
      "write_file",
      "mcp__server__tool",
    ]) {
      expect(approvalDecision(name, "confirm", {}, []).gate).toBe(true)
    }
    // shell_session is the split: typing auto-runs, a submission gates.
    expect(approvalDecision("shell_session", "confirm", { text: "ls" }, []).gate).toBe(false)
    expect(approvalDecision("shell_session", "confirm", { text: "ls", enter: true }, []).gate).toBe(true)
    // ask_user IS the interaction — it renders the question, never a card.
    expect(approvalDecision("ask_user", "confirm", {}, []).gate).toBe(false)
    // full-auto auto-runs ordinary reads.
    expect(approvalDecision("read_file", "full-auto", {}, []).gate).toBe(false)
    expect(approvalDecision("shell_background", "confirm", { command: "ls" }, []).gate).toBe(true)
    expect(approvalDecision("edit_file", "confirm", {}, []).gate).toBe(true)
    expect(approvalDecision("write_file", "confirm", {}, []).gate).toBe(true)
    // Allow-prefix list exempts matching command prefixes.
    const exempt = approvalDecision("shell_background", "confirm", { command: "git status" }, ["git "])
    expect(exempt.gate).toBe(false)
    expect(exempt.allowPrefix).toBe("git ")
    expect(approvalDecision("shell_background", "confirm", { command: "rm x" }, ["git "]).gate).toBe(true)
    // A saved `permission` allow rule exempts any tool, reads included.
    const allowedRead = approvalDecision("read_file", "confirm", { path: "src/a.ts" }, [], [{ tool: "read_file", pattern: "src/*", action: "allow" }])
    expect(allowedRead.gate).toBe(false)
    expect(suggestAllowPrefix("git status --short")).toBe("git status ")
    expect(suggestAllowPrefix("ls")).toBe("ls ")
    expect(suggestAllowPrefix("  ")).toBe("")
  })

  test("commandPrefix is arity-aware (OpenCode permission/arity.ts) and suggestAllowPrefix adds a trailing space", () => {
    // Two-token commands.
    expect(commandPrefix("git status")).toBe("git status")
    expect(commandPrefix("git status --short")).toBe("git status")
    expect(commandPrefix("git commit -m x")).toBe("git commit")
    // Deeper known subcommands.
    expect(commandPrefix("npm run test")).toBe("npm run test")
    expect(commandPrefix("docker compose up")).toBe("docker compose")
    // Single-token commands stop before the first flag/argument.
    expect(commandPrefix("rm -rf /")).toBe("rm")
    expect(commandPrefix("ls -la")).toBe("ls")
    // Unknown commands fall back to their first token.
    expect(commandPrefix("frobnicate --wat")).toBe("frobnicate")
    expect(commandPrefix("  ")).toBe("")
    // The suggested session prefix keeps the trailing-space convention.
    expect(suggestAllowPrefix("git commit -m x")).toBe("git commit ")
  })

  test("matchGlob: '*' and '?' wildcards with literal anchoring", () => {
    expect(matchGlob("git *", "git status")).toBe(true)
    expect(matchGlob("git *", "git")).toBe(false) // the space is literal
    expect(matchGlob("git*", "git")).toBe(true) // '*' matches empty
    expect(matchGlob("git *", "npm install")).toBe(false)
    expect(matchGlob("*.ts", "tools.ts")).toBe(true)
    expect(matchGlob("src/?ne.ts", "src/one.ts")).toBe(true)
    expect(matchGlob("src/?ne.ts", "src/onee.ts")).toBe(false)
    expect(matchGlob("a.b", "axb")).toBe(false) // '.' is literal, not "any char"
    expect(matchGlob("", "")).toBe(true)
    expect(matchGlob("", "x")).toBe(false)
  })

  test("permission rules: allow/ask/deny, '*', patterns, last-match-wins, allowPrefix fallback", () => {
    // No rules = byte-identical to the baseline (compatibility).
    expect(approvalDecision("shell_background", "confirm", { command: "ls" }, [])).toEqual({ gate: true })
    expect(approvalDecision("shell_background", "confirm", { command: "ls" }, [], [])).toEqual({ gate: true })

    // allow: a rule waves a normally-gated tool through.
    expect(approvalDecision("shell_background", "confirm", { command: "ls" }, [], [{ tool: "shell_background", action: "allow" }])).toEqual(
      { gate: false, action: "allow" },
    )
    // ask: a rule gates a read.
    expect(approvalDecision("read_file", "confirm", { path: "/tmp/x" }, [], [{ tool: "read_file", action: "ask" }])).toEqual({
      gate: true,
      action: "ask",
    })
    // deny: terminal, even full-auto.
    expect(approvalDecision("shell_background", "full-auto", { command: "ls" }, [], [{ tool: "*", action: "deny" }])).toEqual({
      gate: true,
      action: "deny",
    })

    // "*" tool matches any tool name.
    expect(approvalDecision("edit_file", "confirm", { path: "/tmp/x" }, [], [{ tool: "*", action: "allow" }]).gate).toBe(false)

    // pattern: matched against the shell command / target path; miss leaves baseline.
    expect(approvalDecision("shell_background", "confirm", { command: "git status" }, [], [{ tool: "shell_background", pattern: "git *", action: "allow" }]).gate).toBe(false)
    expect(approvalDecision("shell_background", "confirm", { command: "npm install" }, [], [{ tool: "shell_background", pattern: "git *", action: "allow" }]).gate).toBe(true)
    expect(approvalDecision("edit_file", "confirm", { path: "src/a.ts" }, [], [{ tool: "edit_file", pattern: "src/*", action: "allow" }]).gate).toBe(false)
    expect(approvalDecision("edit_file", "confirm", { path: "docs/a.md" }, [], [{ tool: "edit_file", pattern: "src/*", action: "allow" }]).gate).toBe(true)
    // A pattern now matches shell_session's typed text (it was silently ignored
    // before — permissionTarget returned null for shell_session).
    expect(approvalDecision("shell_session", "confirm", { text: "ls -la" }, [], [{ tool: "shell_session", pattern: "ls *", action: "ask" }]).gate).toBe(true)
    // A non-matching pattern leaves the baseline (typing auto-runs).
    expect(approvalDecision("shell_session", "confirm", { text: "cat x" }, [], [{ tool: "shell_session", pattern: "ls *", action: "ask" }]).gate).toBe(false)
    // A pattern on a tool with no match target (and no text) still never matches — typing auto-runs.
    expect(approvalDecision("shell_session", "confirm", {}, [], [{ tool: "shell_session", pattern: "ls *", action: "ask" }]).gate).toBe(false)

    // last-match-wins: a later allow overrides an earlier deny (no deny-domination).
    expect(
      approvalDecision("shell_background", "confirm", { command: "ls" }, [], [
        { tool: "shell_background", action: "deny" },
        { tool: "shell_background", action: "allow" },
      ]),
    ).toEqual({ gate: false, action: "allow" })

    // allowPrefix fallback still applies when no rule matched.
    const exempt = approvalDecision("shell_background", "confirm", { command: "git status" }, ["git "], [{ tool: "read_file", action: "deny" }])
    expect(exempt.gate).toBe(false)
    expect(exempt.allowPrefix).toBe("git ")
  })

  test("permission rules never un-gate a destructive command", () => {
    const d = approvalDecision("shell_background", "full-auto", { command: "rm -rf /" }, [], [{ tool: "*", action: "allow" }])
    expect(d.gate).toBe(true)
    expect(d.destructive).toBe(true)
    // A deny still denies (and stays terminal).
    const denied = approvalDecision("shell_background", "full-auto", { command: "rm -rf /" }, [], [{ tool: "*", action: "deny" }])
    expect(denied.gate).toBe(true)
    expect(denied.action).toBe("deny")
  })

  test("full-auto skips gates except destructive commands", () => {
    expect(approvalDecision("shell_background", "full-auto", { command: "ls -la" }, []).gate).toBe(false)
    expect(approvalDecision("shell_background", "full-auto", { command: "rm -rf /" }, []).gate).toBe(true)
    // The destructive table underneath: clearly-catastrophic classes...
    expect(isDestructiveCommand("rm -rf /")).toBe(true)
    expect(isDestructiveCommand("sudo shutdown now")).toBe(true)
    expect(isDestructiveCommand("dd if=/dev/zero of=/dev/sda")).toBe(true)
    expect(isDestructiveCommand("rm -rf ~")).toBe(true)
    expect(isDestructiveCommand("rm -rf /etc")).toBe(true)
    expect(isDestructiveCommand("rm -rf *")).toBe(true)
    expect(isDestructiveCommand("find / -delete")).toBe(true)
    expect(isDestructiveCommand("chmod -R 000 /")).toBe(true)
    expect(isDestructiveCommand("shred disk.img")).toBe(true)
    expect(isDestructiveCommand("wipefs -a /dev/sda")).toBe(true)
    expect(isDestructiveCommand("mv ~ /tmp")).toBe(true)
    expect(isDestructiveCommand("> /dev/sda")).toBe(true)
    expect(isDestructiveCommand(":(){ :|:& };:")).toBe(true)
    expect(isDestructiveCommand("cd /; rm -rf *")).toBe(true)
    expect(isDestructiveCommand("rm -rf ~/*")).toBe(true)
    // ...while ordinary work is NOT destructive (the floor stays narrow).
    expect(isDestructiveCommand("rm -rf /tmp/sandbox")).toBe(false)
    expect(isDestructiveCommand("rm -rf ./build")).toBe(false)
    expect(isDestructiveCommand("rm -rf node_modules")).toBe(false)
    // A deep path under a critical root is normal work, not a wipe of that root.
    expect(isDestructiveCommand("rm -rf /home/user/project/node_modules")).toBe(false)
    expect(isDestructiveCommand("rm -rf /var/tmp/foo")).toBe(false)
    expect(isDestructiveCommand("dd if=/dev/zero of=/dev/null")).toBe(false)
    expect(isDestructiveCommand("find /tmp -name '*.log' -delete")).toBe(false)
    expect(isDestructiveCommand("chmod 755 script.sh")).toBe(false)
    expect(isDestructiveCommand("wc -l /etc/hosts")).toBe(false)
    expect(isDestructiveCommand("ls -la /")).toBe(false)
    expect(isDestructiveCommand("git push --force")).toBe(false)
  })

  test("shell_session carries the destructive floor and is pattern-matchable (permission rules)", () => {
    // Typing auto-runs in both modes; a submission gates in confirm.
    expect(approvalDecision("shell_session", "confirm", { text: "ls -la" }, []).gate).toBe(false)
    expect(approvalDecision("shell_session", "confirm", { text: "ls -la", enter: true }, []).gate).toBe(true)
    expect(approvalDecision("shell_session", "full-auto", { text: "ls -la" }, []).gate).toBe(false)
    // ...but a catastrophic command gates even in full-auto, and a rule cannot
    // wave it through.
    expect(approvalDecision("shell_session", "confirm", { text: "rm -rf /" }, []).gate).toBe(true)
    expect(approvalDecision("shell_session", "full-auto", { text: "rm -rf /" }, []).gate).toBe(true)
    const floored = approvalDecision("shell_session", "full-auto", { text: "rm -rf /" }, [], [{ tool: "shell_session", action: "allow" }])
    expect(floored.gate).toBe(true)
    expect(floored.destructive).toBe(true)
  })

  test("MCP tools gate in confirm mode and auto-run in full-auto; no shell allow-prefix applies (docs/mcp.md)", () => {
    expect(approvalDecision("mcp__playwright__browser_click", "confirm", {}, []).gate).toBe(true)
    expect(approvalDecision("mcp__firecrawl__search", "full-auto", {}, []).gate).toBe(false)
    const d = approvalDecision("mcp__firecrawl__search", "confirm", {}, ["mcp__firecrawl__search"])
    expect(d.gate).toBe(true)
    expect(d.allowPrefix).toBeUndefined()
  })
})

describe("tool specs + args", () => {
  test("the core 7 tools are specced with valid JSON schemas; argument parsing is defensive; summaries pick the key param", () => {
    const names = TOOL_SPECS.map((s) => s.function.name)
    expect(names).toEqual([
      "shell_background",
      "shell_session",
      "read_file",
      "edit_file",
      "write_file",
      "get_scrollback",
      "view_image",
      "ask_user",
      "memory",
      "host_scan",
      "session_search",
      "session_list",
      "session_view",
      "skills_list",
      "skill_view",
      "reload",
    ])
    for (const s of TOOL_SPECS) {
      expect(s.function.parameters["type"]).toBe("object")
      expect(Array.isArray(s.function.parameters["required"])).toBe(true)
    }
    // ask_user advertises the wider option range, the auto-appended custom
    // entry, and full (untruncated) question rendering to the model.
    const ask = TOOL_SPECS.find((s) => s.function.name === "ask_user")
    const askProps = ask?.function.parameters["properties"] as
      | Record<string, { description?: string }>
      | undefined
    expect(ask?.function.description).toContain("type your custom answer")
    expect(askProps?.["options"]?.description).toContain("1-8")
    // Defensive argument parsing.
    expect(parseToolArguments('{"command":"ls"}')).toEqual({ command: "ls" })
    for (const junk of ["", "not json", "[1,2]"]) expect(parseToolArguments(junk)).toEqual({})
    // Params summaries.
    expect(toolParamsSummary("shell_background", { command: "echo hi" })).toBe("echo hi")
    expect(toolParamsSummary("shell_background", { job: 7, kill: true })).toBe("kill job #7")
    expect(toolParamsSummary("shell_session", { text: "ls", enter: true })).toBe("ls ⏎")
    expect(toolParamsSummary("shell_session", { keys: ["ctrl+c"] })).toBe("[ctrl+c]")
    expect(toolParamsSummary("read_file", { path: "/a/b" })).toBe("/a/b")
    expect(toolParamsSummary("get_scrollback", {})).toBe("500")
    // ask_user: the question renders in full on the card body — the header
    // summary stays empty so it is not duplicated (truncated) up top.
    expect(toolParamsSummary("ask_user", { question: "Which way?", options: ["left", "right"] })).toBe("")
    // MCP tools show the JSON args peek.
    expect(toolParamsSummary("mcp__t__echo", { text: "hello" })).toBe('{"text":"hello"}')
    expect(toolParamsSummary("mcp__t__x", {})).toBe("{}")
  })

  test("toolApprovalDetail: the pending card's FULL, untruncated review text", () => {
    // A long command survives in full — the whole point of the pending card.
    const longCmd = `cd /home/u/dev/proj && git commit -m ${"x".repeat(90)}`
    expect(toolApprovalDetail("shell_background", { command: longCmd })).toBe(longCmd)
    // Multi-line (&&-continued) commands keep every line, not just the first.
    const multi = "cd /srv/app && \\\nsource .venv/bin/activate && \\\npython manage.py migrate"
    expect(toolApprovalDetail("shell_background", { command: multi })).toBe(multi)
    // Job calls carry no command to review.
    expect(toolApprovalDetail("shell_background", { job: 7, kill: true })).toBeNull()
    expect(toolApprovalDetail("shell_background", {})).toBeNull()
    // shell_session's typed text is reviewable; key-only calls are not.
    expect(toolApprovalDetail("shell_session", { text: "sudo rm x", enter: true })).toBe("sudo rm x")
    expect(toolApprovalDetail("shell_session", { keys: ["ctrl+c"] })).toBeNull()
    // MCP args render in full (the peek clips them).
    expect(toolApprovalDetail("mcp__t__echo", { text: "hello" })).toBe('{"text":"hello"}')
    // Tools whose header peek already tells the whole story have no detail.
    expect(toolApprovalDetail("read_file", { path: "/a/b" })).toBeNull()
    expect(toolApprovalDetail("edit_file", { path: "/a/b" })).toBeNull()
    expect(toolApprovalDetail("ask_user", { question: "Which way?" })).toBeNull()
  })

  test("resolveToolName repairs exact / case-insensitive / unique prefix+suffix; ambiguous and unknown pass through", () => {
    const known = ["shell_background", "read_file", "write_file", "get_scrollback", "mcp__t__ping"]
    // Exact and case-insensitive.
    expect(resolveToolName("read_file", known)).toBe("read_file")
    expect(resolveToolName("Shell_Background", known)).toBe("shell_background")
    // Unique prefix / suffix (the model dropped or rearranged a segment).
    expect(resolveToolName("read", known)).toBe("read_file")
    expect(resolveToolName("scrollback", known)).toBe("get_scrollback")
    expect(resolveToolName("PING", known)).toBe("mcp__t__ping")
    // Ambiguous (read_file + write_file both end in "file") -> unchanged.
    expect(resolveToolName("file", known)).toBe("file")
    // Zero candidates -> unchanged so `unknown tool "<name>"` still surfaces.
    expect(resolveToolName("nope", known)).toBe("nope")
    expect(resolveToolName("", known)).toBe("")
  })
})

describe("memory tool (docs/memory.md)", () => {
  test("dispatches to the store bridge; bad action/target degrade; writes are classified for writeApproval", async () => {
    const calls: string[] = []
    const bridge: MemoryToolBridge = {
      read: () => "body",
      list: (t) => {
        calls.push(`list:${t}`)
        return { ok: true, message: "listed" }
      },
      readResult: (t) => {
        calls.push(`read:${t}`)
        return { ok: true, message: "read-body" }
      },
      add: (t, c) => {
        calls.push(`add:${t}:${c}`)
        return { ok: true, message: "added" }
      },
      replace: (t, o, c) => {
        calls.push(`replace:${t}:${o}:${c}`)
        return { ok: true, message: "replaced" }
      },
      remove: (t, o) => {
        calls.push(`remove:${t}:${o}`)
        return { ok: false, message: "no match" }
      },
      rewrite: (t, body) => {
        calls.push(`rewrite:${t}:${body}`)
        return { ok: true, message: "rewritten" }
      },
      usage: () => ({ target: "memory", used: 1, limit: 2, percent: 50, entries: 1 }),
    }
    const added = await executeTool("memory", { action: "add", target: "host", content: "x" }, { ...ctx(), memory: bridge })
    expect(added.ok).toBe(true)
    expect(calls).toEqual(["add:host:x"])
    expect((await executeTool("memory", { action: "read", target: "journal" }, { ...ctx(), memory: bridge })).result).toBe("read-body")
    expect((await executeTool("memory", { action: "nope", target: "memory" }, { ...ctx(), memory: bridge })).ok).toBe(false)
    expect((await executeTool("memory", { action: "add", target: "nope" }, { ...ctx(), memory: bridge })).ok).toBe(false)
    // No bridge (memory disabled): degrades, never throws.
    expect((await executeTool("memory", { action: "list", target: "memory" }, ctx())).ok).toBe(false)
    // writeApproval classification.
    for (const action of ["add", "replace", "remove", "rewrite"]) expect(isMemoryWrite("memory", { action })).toBe(true)
    expect(isMemoryWrite("memory", { action: "list" })).toBe(false)
    expect(isMemoryWrite("read_file", {})).toBe(false)
    expect(toolParamsSummary("memory", { action: "add", target: "host" })).toBe("add host")
    expect(toolParamsSummary("host_scan", {})).toBe("read-only machine scan")

    // rewrite commits the model-supplied whole-store body (memory/host only).
    const rw = await executeTool("memory", { action: "rewrite", target: "host", content: "merged\n§\nsecond" }, { ...ctx(), memory: bridge })
    expect(rw.ok).toBe(true)
    expect(rw.result).toBe("rewritten")
    expect(calls).toContain("rewrite:host:merged\n§\nsecond")
    // JOURNAL is rejected before the bridge is reached.
    expect((await executeTool("memory", { action: "rewrite", target: "journal", content: "x" }, { ...ctx(), memory: bridge })).ok).toBe(false)
    expect(toolParamsSummary("memory", { action: "rewrite", target: "host" })).toBe("rewrite host")
  })

  test("host_scan runs the read-only whitelist and returns a curated redacted draft", async () => {
    const r = await executeTool("host_scan", {}, ctx())
    expect(r.ok).toBe(true)
    expect(r.result).toContain("# Host scan draft")
    expect(r.result).toContain("uname")
    expect(r.result).toContain("DRAFT from read-only probes")
    expect(r.result).not.toMatch(/sk-[A-Za-z0-9]{16,}/)
  })

  test("skills_list/skill_view are progressive disclosure over the catalog; unknown names and no catalog degrade", async () => {
    const catalog = {
      skills: [
        { name: "deploy", description: "ship it", path: "/x/deploy/SKILL.md", body: "1. build\n2. ship" },
        { name: "notes", description: "some notes", path: "/x/notes.md", body: "notes body" },
      ],
      byName: {},
      warnings: [],
    }
    catalog.byName = Object.fromEntries(catalog.skills.map((s) => [s.name, s]))
    const ctxSkills = { ...ctx(), skills: catalog }
    const list = await executeTool("skills_list", {}, ctxSkills)
    expect(list.ok).toBe(true)
    expect(list.result).toContain("deploy: ship it")
    expect(list.result).not.toContain("1. build") // bodies stay out of the index

    const view = await executeTool("skill_view", { name: "deploy" }, ctxSkills)
    expect(view.ok).toBe(true)
    expect(view.result).toContain("1. build")
    expect((await executeTool("skill_view", { name: "missing" }, ctxSkills)).ok).toBe(false)
    expect((await executeTool("skills_list", {}, ctx())).ok).toBe(false)
    expect(toolParamsSummary("skills_list", {})).toBe("list")
    expect(toolParamsSummary("skill_view", { name: "deploy" })).toBe("deploy")
  })
})

describe("MCP tool routing (M11, docs/mcp.md)", () => {
  test("executeTool routes mcp__* through the ctx.mcp bridge; errors and oversized results handled; no bridge degrades", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const bridge = {
      call: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args })
        return { ok: true, result: `PONG:${name}` }
      },
    }
    const r = await executeTool("mcp__srv__ping", { text: "yo" }, { ...ctx(), mcp: bridge })
    expect(r.ok).toBe(true)
    expect(r.result).toBe("PONG:mcp__srv__ping")
    expect(calls).toEqual([{ name: "mcp__srv__ping", args: { text: "yo" } }])
    // isError results surface as failures.
    const err = await executeTool("mcp__srv__bad", {}, { ...ctx(), mcp: { call: async () => ({ ok: false, result: "kaput" }) } })
    expect(err.ok).toBe(false)
    expect(err.result).toBe("kaput")
    // Oversized results are capped at the boundary (default 51200 bytes): a
    // single over-byte line is byte-sliced, so the result is genuinely smaller.
    const big = "x".repeat(60_000)
    const huge = await executeTool("mcp__srv__big", {}, { ...ctx(), mcp: { call: async () => ({ ok: true, result: big }) } })
    expect(huge.ok).toBe(true)
    expect(huge.truncated).toBe(true)
    expect(huge.result.length).toBeLessThan(56_000)
    expect(huge.result).toContain("bytes truncated")
    // No bridge -> unknown-tool degradation.
    const none = await executeTool("mcp__srv__ping", {}, ctx())
    expect(none.ok).toBe(false)
    expect(none.result).toContain("unknown tool")
  })
})

describe("session search tool (Phase 1.6)", () => {
  test("dispatches to the bridge, formats hits, refuses an empty query, and degrades without a bridge", async () => {
    const calls: Array<{ q: string; limit?: number; session?: string; offset?: number }> = []
    const bridge: SessionSearchBridge = {
      search: (q, limit, session, offset) => {
        calls.push({ q, limit, session, offset })
        return [
          { path: "/s/inst/tab-1.jsonl", sessionId: "inst/tab-1", title: "alpha chat", tags: [], ts: 5, role: "user", snippet: "…discussed alpha here…", messageIndex: 0 },
          { path: "/s/inst/tab-1.jsonl", sessionId: "inst/tab-1", title: "alpha chat", tags: [], ts: 5, role: "assistant", snippet: "…alpha reply…", messageIndex: 1 },
        ]
      },
      list: () => [],
    }
    const r = await executeTool("session_search", { query: "alpha", limit: 5, session: "inst", offset: 2 }, { ...ctx(), sessionSearch: bridge })
    expect(r.ok).toBe(true)
    expect(r.result).toContain("[user] inst/tab-1 #0")
    expect(r.result).toContain("alpha reply")
    expect(calls).toEqual([{ q: "alpha", limit: 5, session: "inst", offset: 2 }])
    // No matches: a successful, explanatory result (not an error).
    const none = await executeTool("session_search", { query: "nope" }, { ...ctx(), sessionSearch: { search: () => [], list: () => [] } })
    expect(none.ok).toBe(true)
    expect(none.result).toContain("no past messages match")
    // Empty query refused.
    expect((await executeTool("session_search", { query: "   " }, { ...ctx(), sessionSearch: bridge })).ok).toBe(false)
    // No bridge: degrades with an error string, never throws.
    expect((await executeTool("session_search", { query: "x" }, ctx())).ok).toBe(false)
    // Confirm gates it like every other tool; full-auto auto-runs it.
    expect(approvalDecision("session_search", "confirm", {}, []).gate).toBe(true)
    expect(approvalDecision("session_search", "full-auto", {}, []).gate).toBe(false)
    expect(toolParamsSummary("session_search", { query: "alpha", session: "inst" })).toBe("alpha @ inst")
    expect(toolParamsSummary("session_search", { query: "alpha" })).toBe("alpha")
  })

  test("session_list + session_view dispatch to the bridge, page by offset, and degrade without a reader", async () => {
    const listCalls: Array<{ limit?: number; offset?: number }> = []
    const viewCalls: Array<{ session: string; offset?: number; limit?: number }> = []
    const bridge: SessionSearchBridge = {
      search: () => [],
      list: (limit, offset) => {
        listCalls.push({ limit, offset })
        return [
          { path: "/s/inst/tab-1.jsonl", sessionId: "inst/tab-1", title: "alpha chat", tags: ["work"], messages: 3, lastTs: 1_700_000_000_000, firstUser: "alpha" },
        ]
      },
      readSession: (session, offset, limit) => {
        viewCalls.push({ session, offset, limit })
        if (session !== "inst/tab-1") return null
        return {
          path: "/s/inst/tab-1.jsonl",
          sessionId: "inst/tab-1",
          title: "alpha chat",
          tags: ["work"],
          total: 3,
          offset: offset ?? 0,
          lastTs: 1_700_000_000_000,
          messages: [
            { index: 0, role: "user", ts: 1_700_000_000_000, content: "hello" },
            { index: 1, role: "assistant", ts: 1_700_000_001_000, content: "world" },
          ],
        }
      },
    }
    const c = { ...ctx(), sessionSearch: bridge }

    const list = await executeTool("session_list", { limit: 5, offset: 0 }, c)
    expect(list.ok).toBe(true)
    expect(list.result).toContain("inst/tab-1")
    expect(list.result).toContain("alpha chat")
    expect(list.result).toContain("work")
    expect(listCalls).toEqual([{ limit: 5, offset: 0 }])

    const view = await executeTool("session_view", { session: "inst/tab-1", offset: 0, limit: 10 }, c)
    expect(view.ok).toBe(true)
    expect(view.result).toContain("[0 user]")
    expect(view.result).toContain("world")
    expect(view.result).toContain("showing #0-#1")
    // Last index 1 -> the next page starts at 2 (2 < total 3).
    expect(view.result).toContain("offset 2")
    expect(viewCalls).toEqual([{ session: "inst/tab-1", offset: 0, limit: 10 }])

    // Empty page -> an explanatory success, not an error.
    const emptyBridge: SessionSearchBridge = {
      search: () => [],
      list: () => [],
      readSession: () => ({ path: "/p", sessionId: "x", title: "t", tags: [], total: 3, offset: 99, lastTs: null, messages: [] }),
    }
    const empty = await executeTool("session_view", { session: "x", offset: 99 }, { ...ctx(), sessionSearch: emptyBridge })
    expect(empty.ok).toBe(true)
    expect(empty.result).toContain("no messages at offset 99")

    // Unknown session -> an error with guidance.
    expect((await executeTool("session_view", { session: "nope" }, c)).ok).toBe(false)
    // Missing session arg refused.
    expect((await executeTool("session_view", {}, c)).ok).toBe(false)

    // No bridge, and no reader on the bridge, both degrade (never throw).
    expect((await executeTool("session_list", {}, ctx())).ok).toBe(false)
    expect((await executeTool("session_view", { session: "x" }, ctx())).ok).toBe(false)
    expect((await executeTool("session_view", { session: "x" }, { ...ctx(), sessionSearch: { search: () => [], list: () => [] } })).ok).toBe(false)

    // Confirm gates them like every other tool; full-auto auto-runs them.
    expect(approvalDecision("session_list", "confirm", {}, []).gate).toBe(true)
    expect(approvalDecision("session_view", "confirm", {}, []).gate).toBe(true)
    expect(approvalDecision("session_list", "full-auto", {}, []).gate).toBe(false)
    expect(toolParamsSummary("session_list", {})).toBe("recent sessions")
    expect(toolParamsSummary("session_view", { session: "inst/tab-1", offset: 5 })).toBe("inst/tab-1 @5")
    expect(toolParamsSummary("session_view", { session: "inst/tab-1" })).toBe("inst/tab-1")
  })
})

// ===========================================================================
// HARness workstream (#20 shell_session delivery + pane pre-flight, #21
// pane-state probe, #22 position-independent hidden-shell sudo). Appended last
// so parallel edits to the approvals block above never collide.
// ===========================================================================

/**
 * A live-pane stub whose `paneState` runs the SAME pure classifier the real
 * `TerminalSession` uses, over a mutable screen it updates as keys are sent.
 */
function livePane(initial: string[]) {
  let lines = [...initial]
  const sent: Array<{ kind: "literal"; text: string } | { kind: "keys"; names: string[] }> = []
  return {
    sent,
    sendKeys: async (a: { kind: "literal"; text: string } | { kind: "keys"; names: string[] }) => {
      sent.push(a)
      if (a.kind === "literal") lines = [...lines, `% ${a.text}`]
      else if (a.names.some((n) => n === "Enter")) lines = [...lines, "output", "% "]
    },
    captureScrollbackRaw: async () => lines.join("\n"),
    paneState: (n?: number) => classifyPaneState({ lines, tailLines: n ?? 10 }),
    setLines: (l: string[]) => {
      lines = [...l]
    },
  }
}

describe("shell_session pane-state pre-flight + delivery (#20/#21)", () => {
  test("refuses a dquote continuation: types nothing, names it, and shows the offending pane lines", async () => {
    const pane = livePane(['user@host ~ % echo "abc', "dquote> "])
    const r = await executeTool("shell_session", { text: "ls -la", enter: true }, ctx({ pane }))
    expect(r.ok).toBe(false)
    expect(pane.sent).toHaveLength(0)
    expect(r.result).toContain("refused")
    expect(r.result).toContain("Nothing was typed")
    expect(r.result).toContain("dquote")
    expect(r.result).toContain("dquote>")
  })

  test("a keys-only enter into a continuation is refused identically (same bug, no literal text)", async () => {
    const pane = livePane(["quote> "])
    const r = await executeTool("shell_session", { keys: ["enter"] }, ctx({ pane }))
    expect(r.ok).toBe(false)
    expect(pane.sent).toHaveLength(0)
    expect(r.result).toContain("refused")
    expect(r.result).toContain("quote")
  })

  test("refuses a running foreground process and a waiting sudo password prompt", async () => {
    const running = livePane(["% sleep 30"])
    const r1 = await executeTool("shell_session", { text: "ls", enter: true }, ctx({
      pane: {
        sendKeys: running.sendKeys,
        captureScrollbackRaw: running.captureScrollbackRaw,
        paneState: () => classifyPaneState({ lines: ["% sleep 30"], commandRunning: true }),
      },
    }))
    expect(r1.ok).toBe(false)
    expect(r1.result).toContain("running")

    const pwPane = {
      sendKeys: async () => {},
      captureScrollbackRaw: async () => "[sudo] password for alice:",
      paneState: () => classifyPaneState({ lines: ["[sudo] password for alice:"] }),
    }
    const r2 = await executeTool("shell_session", { text: "secret", enter: true }, ctx({ pane: pwPane }))
    expect(r2.ok).toBe(false)
    expect(r2.result).toContain("password")
  })

  test("at a prompt: delivered, with the probe state exposed for planning", async () => {
    const pane = livePane(["user@host ~ %"])
    const r = await executeTool("shell_session", { text: "ls", enter: true }, ctx({ pane }))
    expect(r.ok).toBe(true)
    expect(r.result).toContain("delivered")
    expect(r.result).toContain("visible pane")
    expect(r.result).toContain("pane state before typing: prompt")
  })

  test("when the echo never appears the result is unverified — it must not read as success", async () => {
    const pane = {
      sendKeys: async () => {}, // a write that silently no-ops
      captureScrollbackRaw: async () => "user@host ~ %",
      paneState: () => classifyPaneState({ lines: ["user@host ~ %"] }),
    }
    const r = await executeTool("shell_session", { text: "rm -rf build", enter: true }, ctx({ pane }))
    expect(r.ok).toBe(true)
    expect(r.result).toContain("unverified")
    expect(r.result.toLowerCase()).toContain("could not confirm")
    expect(r.result).not.toContain("delivered")
  })

  test("a pane with no probe is never refused blindly; delivery is unverified, not a crash", async () => {
    const pane = { sendKeys: async () => {}, captureScrollbackRaw: async () => "" }
    const r = await executeTool("shell_session", { text: "echo hi", enter: true }, ctx({ pane }))
    expect(r.ok).toBe(true)
    expect(r.result).toContain("unverified")
    expect(r.result).toContain("visible pane")
  })
})

describe("hidden-shell sudo position-independence (#22)", () => {
  test("sudo detection covers ANY position (operators, subshells, braces, newlines)", () => {
    for (const c of [
      "ls /tmp; sudo whoami",
      "a && sudo b",
      "sudo a | sudo b",
      "$( sudo z )",
      "{ sudo x; }",
      "x\nsudo y",
      "if true; then sudo z; fi",
      "for i in 1; do sudo true; done",
    ]) {
      expect(commandUsesSudo(c)).toBe(true)
    }
    expect(commandUsesSudo("echo sudo")).toBe(false)
    expect(commandUsesSudo("grep sudo file")).toBe(false)
    expect(commandWithSudoAskpass("ls /tmp; sudo whoami")).toBe("ls /tmp; sudo -A whoami")
  })

  test("`ls; sudo whoami` authenticates in one call (no tty error) and reports the ticket", async () => {
    const shimDir = mkdtempSync(join(dir, "sudo-pos-"))
    writeFileSync(
      join(shimDir, "sudo"),
      '#!/bin/sh\nif [ "$1" = "-A" ]; then pw=$("$SUDO_ASKPASS"); echo "root:$pw"; exit 0; fi\n' +
        'echo "sudo: a terminal is required to read the password" >&2\nexit 1\n',
      { mode: 0o755 },
    )
    let asked = 0
    const embedded = await executeTool(
      "shell_background",
      { command: `export PATH="${shimDir}:$PATH"; ls /tmp >/dev/null; sudo whoami` },
      ctx({ requestSudo: async () => { asked++; return "pw" } }),
    )
    expect(asked).toBe(1)
    expect(embedded.ok).toBe(true)
    expect(embedded.result).toContain("root:pw")
    expect(embedded.result).not.toContain("terminal is required")
    expect(embedded.result).toContain("sudo ticket")
    // No regression: sudo-first still works.
    const first = await executeTool(
      "shell_background",
      { command: `export PATH="${shimDir}:$PATH"; sudo whoami` },
      ctx({ requestSudo: async () => "pw" }),
    )
    expect(first.ok).toBe(true)
    expect(first.result).toContain("root:pw")
  })

  test("a declined prompt fails fast with the reason and never runs the command bare", async () => {
    const shimDir = mkdtempSync(join(dir, "sudo-declined-"))
    writeFileSync(join(shimDir, "sudo"), '#!/bin/sh\necho RAN-BARE\nexit 7\n', { mode: 0o755 })
    let asked = 0
    const r = await executeTool(
      "shell_background",
      { command: `export PATH="${shimDir}:$PATH"; ls /tmp >/dev/null; sudo whoami; echo AFTER` },
      ctx({ requestSudo: async () => { asked++; return null } }),
    )
    expect(asked).toBe(1)
    expect(r.ok).toBe(false)
    expect(r.result).toContain("declined")
    expect(r.result).not.toContain("RAN-BARE")
    expect(r.result).not.toContain("AFTER")
  })
})
