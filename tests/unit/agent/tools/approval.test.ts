/**
 * Approval classifier + session-trust tests (docs/agent.md "Approval modes").
 *
 * The highest-risk logic is which operation classes are eligible for
 * session-scoped trust vs which are destructive/irreversible-exempt — a
 * table-driven classifier test plus the gate-level precedence (trust never
 * overrides the destructive floor) and the live-jobs accessor that feeds the
 * status-bar chip. Pure functions + real detached shells; no network.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  approvalDecision,
  isDestructiveCommand,
  isReadOnlyShellCommand,
  isTrustExempt,
  readonlyGuardDecision,
  shellSessionSubmits,
  shellSessionSubmitText,
  trustChipLabel,
  trustPatternFor,
  type TrustPattern,
} from "../../../../src/agent/tools/approval.ts"
import { activeJobs, killBackgroundJob, startBackgroundJob } from "../../../../src/agent/tools/jobs.ts"

const shell = (command: string): Record<string, unknown> => ({ command })

describe("session trust classifier (trustPatternFor)", () => {
  test("eligible operation classes get an arity-aware prefix and can be trusted", () => {
    const cases: Array<[string, Record<string, unknown>, string | null]> = [
      ["shell_background", shell("git status --short"), "git status "],
      ["shell_background", shell("git status"), "git status "],
      ["shell_background", shell("git commit -m x"), "git commit "],
      ["shell_background", shell("systemctl status nginx"), "systemctl status "],
      ["shell_background", shell("docker compose up -d"), "docker compose "],
      ["shell_background", shell("ls -la"), "ls "],
      ["shell_background", shell("echo hi"), "echo "],
      ["shell_background", shell("pct exec 500 -- docker ps"), "pct "],
      ["shell_session", { text: "ls -la" }, "ls "],
      // No trustable class: non-shell tools and empty targets.
      ["read_file", { path: "/tmp/x" }, null],
      ["edit_file", { path: "/tmp/x" }, null],
      ["write_file", { path: "/tmp/x" }, null],
      ["shell_background", shell(""), null],
      ["shell_session", {}, null],
    ]
    for (const [name, args, prefix] of cases) {
      expect({ name, prefix: trustPatternFor(name, args)?.prefix ?? null }).toEqual({ name, prefix })
    }
  })

  test("destructive / irreversible classes are NEVER trust-eligible", () => {
    const exempt = [
      "rm -rf /",
      "rm -rf /tmp/sandbox",
      "rm -rf ./build",
      "sudo apt update",
      "dd if=/dev/zero of=/dev/sda",
      "mkfs.ext4 /dev/sdb",
      "shred disk.img",
      "fdisk /dev/sda",
      "git reset --hard HEAD",
      "git clean -fdx",
      "git restore .",
      "git checkout .",
      "git push --force origin main",
      "git push -f",
      "chmod -R 777 .",
      "chown -R me .",
      "mv a b",
      "docker rm -f api",
      "docker compose down -v",
      "kubectl delete pod api",
      "terraform destroy",
      "pct destroy 100",
      "systemctl stop nginx",
      "shutdown -h now",
      "bash -c 'echo hi'",
      "kill -9 123",
    ]
    for (const command of exempt) {
      expect({ command, trust: trustPatternFor("shell_background", shell(command)) }).toEqual({ command, trust: null })
      expect({ command, exempt: isTrustExempt(command) }).toEqual({ command, exempt: true })
    }
  })

  test("compound commands are not trustable (their class is ambiguous), plain ones are", () => {
    for (const command of ["git status && rm -rf /tmp/x", "git log | head", "echo a; echo b", "echo $(date)"]) {
      expect(trustPatternFor("shell_background", shell(command))).toBeNull()
    }
    expect(isTrustExempt("git status")).toBe(false)
    expect(isTrustExempt("docker compose up")).toBe(false)
    expect(isTrustExempt("ls -la")).toBe(false)
  })

  test("the status-bar trust label NAMES one pattern and collapses several", () => {
    const t = (prefix: string): TrustPattern => ({ tool: "shell_background", prefix })
    expect(trustChipLabel([t("git status ")])).toBe("git status*")
    expect(trustChipLabel([t("git status "), t("ls ")])).toBe("git status*, ls*")
    expect(trustChipLabel([t("a "), t("b "), t("c ")])).toBe("a*, +2")
  })
})

describe("approvalDecision session trust precedence", () => {
  const trust: TrustPattern[] = [{ tool: "shell_background", prefix: "git status " }]

  test("a matching trusted class auto-runs in confirm mode", () => {
    const d = approvalDecision("shell_background", "confirm", shell("git status --short"), [], [], trust)
    expect(d.gate).toBe(false)
    expect(d.allowPrefix).toBe("git status ")
  })

  test("a non-matching class still gates, and trust never crosses tools", () => {
    expect(approvalDecision("shell_background", "confirm", shell("npm install"), [], [], trust).gate).toBe(true)
    // Typing auto-runs; shell_background trust never crosses tools to a submission.
    expect(approvalDecision("shell_session", "confirm", { text: "git status" }, [], [], trust).gate).toBe(false)
    expect(approvalDecision("shell_session", "confirm", { text: "git status", enter: true }, [], [], trust).gate).toBe(true)
  })

  test("the destructive floor stands over session trust (true floor AND broader exempt classes)", () => {
    const floored = approvalDecision("shell_background", "confirm", shell("rm -rf /"), [], [], [{ tool: "shell_background", prefix: "rm " }])
    expect(floored.gate).toBe(true)
    expect(floored.destructive).toBe(true)
    // `rm -rf ./build` is not the catastrophic floor, but it is trust-exempt:
    // a stale "rm " pattern must not wave it through.
    const exempt = approvalDecision("shell_background", "confirm", shell("rm -rf ./build"), [], [], [{ tool: "shell_background", prefix: "rm " }])
    expect(exempt.gate).toBe(true)
    expect(isDestructiveCommand("rm -rf ./build")).toBe(false)
  })

  test("full-auto still gates only the destructive floor; trust does not widen it", () => {
    expect(approvalDecision("shell_background", "full-auto", shell("ls -la"), [], [], trust).gate).toBe(false)
    const d = approvalDecision("shell_background", "full-auto", shell("rm -rf /"), [], [], [{ tool: "shell_background", prefix: "rm " }])
    expect(d.gate).toBe(true)
    expect(d.destructive).toBe(true)
  })

  test("an explicit `permission` rule wins over session trust", () => {
    const d = approvalDecision(
      "shell_background",
      "confirm",
      shell("git status --short"),
      [],
      [{ tool: "shell_background", action: "ask" }],
      trust,
    )
    expect(d.gate).toBe(true)
    expect(d.action).toBe("ask")
  })
})

describe("shell_session gate (confirm mode)", () => {
  test("a submission is detected across enter, keys, and pasted newlines", () => {
    expect(shellSessionSubmits({ text: "ls", enter: true })).toBe(true)
    expect(shellSessionSubmits({ text: "ls", keys: ["enter"] })).toBe(true)
    expect(shellSessionSubmits({ text: "ls", keys: ["return"] })).toBe(true)
    expect(shellSessionSubmits({ text: "ls", keys: ["ENTER"] })).toBe(true) // case-insensitive
    expect(shellSessionSubmits({ text: "ls\n" })).toBe(true) // newline in literal text
    expect(shellSessionSubmits({ text: "a\nb\r" })).toBe(true)
    // Typing and non-submit keys never press Enter.
    expect(shellSessionSubmits({ text: "ls" })).toBe(false)
    expect(shellSessionSubmits({ text: "ls", keys: ["tab"] })).toBe(false)
    expect(shellSessionSubmits({ text: "ls", keys: ["shift+enter"] })).toBe(false) // modified Enter does not submit a shell line
    expect(shellSessionSubmits({ keys: ["up", "down"] })).toBe(false)
    expect(shellSessionSubmits({})).toBe(false)
  })

  test("the submitted text is the typed line, trailing newlines trimmed", () => {
    expect(shellSessionSubmitText({ text: "git status\n" })).toBe("git status")
    expect(shellSessionSubmitText({ text: "a\r\nb" })).toBe("a\r\nb")
    expect(shellSessionSubmitText({})).toBe("")
  })

  test("typing auto-runs; every submission gates — a bare Enter included", () => {
    const typed = approvalDecision("shell_session", "confirm", { text: "ls -la" }, [])
    expect(typed.gate).toBe(false)
    expect(approvalDecision("shell_session", "confirm", { text: "ls -la", keys: ["tab"] }, []).gate).toBe(false)
    const submitted = approvalDecision("shell_session", "confirm", { text: "ls -la", enter: true }, [])
    expect(submitted.gate).toBe(true)
    expect(submitted.destructive).toBeUndefined()
    expect(approvalDecision("shell_session", "confirm", { text: "ls", keys: ["enter"] }, []).gate).toBe(true)
    // A bare Enter can run a line already sitting in the pane: it gates too.
    expect(approvalDecision("shell_session", "confirm", { enter: true }, []).gate).toBe(true)
    expect(approvalDecision("shell_session", "confirm", { keys: ["up", "enter"] }, []).gate).toBe(true)
  })

  test("full-auto never gates an ordinary submission — only the destructive floor", () => {
    expect(approvalDecision("shell_session", "full-auto", { text: "ls -la", enter: true }, []).gate).toBe(false)
    const floored = approvalDecision("shell_session", "full-auto", { text: "rm -rf /", enter: true }, [])
    expect(floored.gate).toBe(true)
    expect(floored.destructive).toBe(true)
  })

  test("session trust covers a repeated submission class but never the destructive floor", () => {
    const trust: TrustPattern[] = [{ tool: "shell_session", prefix: "git status " }]
    const trusted = approvalDecision("shell_session", "confirm", { text: "git status --short", enter: true }, [], [], trust)
    expect(trusted.gate).toBe(false)
    expect(trusted.allowPrefix).toBe("git status ")
    expect(trustPatternFor("shell_session", { text: "git status --short", enter: true })?.prefix).toBe("git status ")
    // A different class still gates.
    expect(approvalDecision("shell_session", "confirm", { text: "npm install", enter: true }, [], [], trust).gate).toBe(true)
    // Trust never waves through a trust-exempt class even if a stale pattern exists.
    const exempt = approvalDecision("shell_session", "confirm", { text: "sudo apt update", enter: true }, [], [], [{ tool: "shell_session", prefix: "sudo " }])
    expect(exempt.gate).toBe(true)
    const floored = approvalDecision("shell_session", "confirm", { text: "rm -rf /", enter: true }, [], [], [{ tool: "shell_session", prefix: "rm " }])
    expect(floored.gate).toBe(true)
    expect(floored.destructive).toBe(true)
  })

  test("an explicit permission `allow` rule still overrides the gate", () => {
    const d = approvalDecision(
      "shell_session",
      "confirm",
      { text: "ls -la", enter: true },
      [],
      [{ tool: "shell_session", pattern: "ls *", action: "allow" }],
    )
    expect(d.gate).toBe(false)
    expect(d.action).toBe("allow")
  })
})

describe("activeJobs (status-bar chip + context line)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sensus-active-jobs-"))
  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  test("enumerates live jobs by owner and forgets killed ones", async () => {
    const id = await startBackgroundJob({ command: "sleep 30", cwd: dir, owner: "scope-a" })
    const mine = activeJobs("scope-a")
    expect(mine.some((j) => j.id === id)).toBe(true)
    expect(mine.some((j) => j.command === "sleep 30")).toBe(true)
    // Owner-scoped: another session never sees it.
    expect(activeJobs("scope-b").some((j) => j.id === id)).toBe(false)
    expect(activeJobs().some((j) => j.id === id)).toBe(true)
    // Killed + forgotten: no longer live.
    expect(killBackgroundJob(id).ok).toBe(true)
    expect(activeJobs("scope-a").some((j) => j.id === id)).toBe(false)
  }, 10000)
})

describe("read-only agent guard (readonlyGuardDecision)", () => {
  test("hard-denies mutating tools and permits read-only ones", () => {
    for (const name of ["edit_file", "write_file", "memory", "shell_session"]) {
      const d = readonlyGuardDecision(name, {})
      expect(d?.action).toBe("deny")
      expect(d?.denySource).toBe("guard")
    }
    expect(readonlyGuardDecision("mcp__github__create_issue", {})?.action).toBe("deny")
    for (const name of ["read_file", "get_scrollback", "session_search", "skills_list", "host_scan", "ask_user"]) {
      expect(readonlyGuardDecision(name, {})).toBeNull()
    }
  })

  test("allows read-only shell commands and denies mutating ones", () => {
    const allowed = [
      "ls -la",
      "cat foo.txt",
      "grep -rn TODO src",
      "git status",
      "git log --oneline -5",
      "git -C /repo diff HEAD~1",
      "ps aux",
      "wc -l file",
      "echo hello",
      "find . -name '*.ts'",
    ]
    for (const cmd of allowed) {
      expect({ cmd, ok: isReadOnlyShellCommand(cmd) }).toEqual({ cmd, ok: true })
    }
    const denied = [
      "ls -la > /tmp/x",
      "echo hi >> log.txt",
      "sed -i 's/a/b/' f",
      "rm -rf build",
      "mv a b",
      "cp a b",
      "mkdir newdir",
      "touch x",
      "chmod +x run.sh",
      "chown me:me f",
      "truncate -s 0 f",
      "dd if=/dev/zero of=x bs=1M count=1",
      "tee out.txt",
      "apt install curl",
      "npm install lodash",
      "bun add zod",
      "systemctl restart nginx",
      "docker run alpine",
      "pct destroy 100",
      "sudo ls",
      "su - root",
      "find . -name x -delete",
      "find . -exec rm {} ;",
      "echo x | xargs rm",
      "git commit -m x",
      "git push origin main",
      "git checkout main",
      "git reset --hard",
      "git clean -fd",
      "git apply patch.diff",
      "bash -c 'rm x'",
      "python3 -c \"open('x','w')\"",
      "patch < p.diff",
      "kill 1234",
      "crontab -e",
    ]
    for (const cmd of denied) {
      expect({ cmd, ok: isReadOnlyShellCommand(cmd) }).toEqual({ cmd, ok: false })
    }
  })

  test("a denied shell command yields a guard denial with a reason", () => {
    const d = readonlyGuardDecision("shell_background", { command: "ls -la > /tmp/x" })
    expect(d?.action).toBe("deny")
    expect(d?.denySource).toBe("guard")
    expect(d?.denyReason).toContain("ls -la > /tmp/x")
    expect(readonlyGuardDecision("shell_background", { command: "git status" })).toBeNull()
  })
})
