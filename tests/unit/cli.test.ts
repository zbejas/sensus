/**
 * M4 CLI tests: --help / --version / init (in-app setup boot intent + headless
 * --create-config), the nesting guard, no-rc-writes guarantee, and the
 * terminal-size guards. All pure (no spawns): output goes to a captured
 * buffer, HOME/SENSUS_HOME come from a fake env.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleCli, matchesEventsFilter, matchesTriggersFilter, nestedBootRefused, parseEventsArgs, runEvents, runTriggers, type CliIo } from "../../src/cli.ts"
import { SENSUS_VERSION } from "../../src/version.ts"
import { MIN_COLS, MIN_ROWS, isTooSmall, tooSmallMessage } from "../../src/ui/lib/layout.ts"
import { configPath, sensusHomeFrom } from "../../src/config/config.ts"

function captureIo(): { lines: string[]; errors: string[]; io: CliIo } {
  const lines: string[] = []
  const errors: string[] = []
  return {
    lines,
    errors,
    io: {
      out: (s) => lines.push(s),
      err: (s) => errors.push(s),
    },
  }
}

const tempHome = (): { home: string; cleanup: () => void } => {
  const home = mkdtempSync(join(tmpdir(), "sensus-cli-test-"))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

describe("cli", () => {
  test("--version (and aliases) prints the version and exits 0; the version stays in sync with package.json", () => {
    for (const flag of ["--version", "-v", "version"]) {
      const { lines, io } = captureIo()
      expect(handleCli([flag], io, {})).toEqual({ action: "exit", code: 0 })
      expect(lines[0]).toBe(`sensus ${SENSUS_VERSION}`)
    }
    // src/version.ts re-exports package.json's version (single source of truth).
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version: string
    }
    expect(SENSUS_VERSION).toBe(pkg.version)
  })

  test("--help (and aliases) prints usage covering commands + start flags", () => {
    for (const flag of ["--help", "-h", "help"]) {
      const { lines, io } = captureIo()
      expect(handleCli([flag], io, {})).toEqual({ action: "exit", code: 0 })
      const text = lines.join("\n")
      expect(text).toContain("Usage:")
      expect(text).toContain("sensus init")
      expect(text).toContain("--create-config")
      expect(text).not.toContain("--print") // the zshrc snippet flags are gone
      expect(text).toContain("--version")
      expect(text).toContain("--resume")
      expect(text).toContain("--yolo")
      expect(text).toContain("sensus kill")
    }
  })

  test("kill dispatch is headless and returns the kill action", () => {
    const { io } = captureIo()
    expect(handleCli(["kill"], io, {})).toEqual({ action: "kill", argv: [] })
    expect(handleCli(["kill", "--dry-run"], io, {})).toEqual({ action: "kill", argv: ["--dry-run"] })
    // Still headless inside a sensus pane (handled before the nest guard).
    expect(handleCli(["kill"], io, { SENSUS_ACTIVE: "1" })).toEqual({ action: "kill", argv: [] })
  })

  test("boot flags and unknown args still boot the TUI", () => {
    const { io } = captureIo()
    expect(handleCli([], io, {})).toEqual({ action: "boot" })
    expect(handleCli(["--resume"], io, {})).toEqual({ action: "boot" })
    expect(handleCli(["--model", "x/y"], io, {})).toEqual({ action: "boot" })
    // A typo'd subcommand is not silently swallowed — it boots (flag parser ignores it).
    expect(handleCli(["inti"], io, {})).toEqual({ action: "boot" })
  })

  test("init boots the TUI with the setup wizard marked (and writes nothing yet)", () => {
    const { home, cleanup } = tempHome()
    try {
      const { lines, io } = captureIo()
      expect(handleCli(["init"], io, { HOME: home })).toEqual({ action: "boot", setup: "force" })
      expect(lines).toEqual([])
      expect(existsSync(configPath(sensusHomeFrom({ HOME: home })))).toBe(false)
      // SENSUS_HOME redirects (same rule as boot) and still requests setup.
      expect(handleCli(["init"], io, { SENSUS_HOME: join(home, "redirected") })).toEqual({
        action: "boot",
        setup: "force",
      })
      // No HOME/SENSUS_HOME at all: a clear error, not a write to /.
      const { errors, io: io2 } = captureIo()
      expect(handleCli(["init"], io2, {})).toEqual({ action: "exit", code: 1 })
      expect(errors.join("\n")).toContain("HOME")
    } finally {
      cleanup()
    }
  })

  test("init --remove / --print were removed with the launcher and fail with a pointer", () => {
    const { home, cleanup } = tempHome()
    try {
      for (const flag of ["--remove", "--print"]) {
        const { errors, io } = captureIo()
        expect(handleCli(["init", flag], io, { HOME: home })).toEqual({ action: "exit", code: 1 })
        expect(errors.join("\n")).toContain("removed with the zshrc launcher")
      }
    } finally {
      cleanup()
    }
  })

  test("init --create-config scaffolds the starter config.json: once, never overwriting, no rc writes", () => {
    const { home, cleanup } = tempHome()
    try {
      const { lines, io } = captureIo()
      expect(handleCli(["init", "--create-config"], io, { HOME: home })).toEqual({ action: "exit", code: 0 })
      const file = join(home, ".config/sensus/config.json")
      expect(existsSync(file)).toBe(true)
      expect(lines.join("\n")).toContain("Created starter config")
      // Starter document: the user-facing knobs, resolved from the same
      // defaults the resolver uses (docs/config.md schema).
      const doc = JSON.parse(readFileSync(file, "utf8")) as {
        model: string
        endpoints: Record<string, { baseURL: string; apiKey?: string }>
        agent: string
        approval: string
      }
      expect(doc.model).toBe("main@gpt-5")
      expect(doc.endpoints["main"]?.baseURL).toBe("https://api.openai.com/v1")
      expect(doc.approval).toBe("confirm")

      // Never overwrites: user edits survive a re-run (idempotent install).
      writeFileSync(file, '{"model":"mine@model","note":"keep me"}')
      const { lines: lines2, io: io2 } = captureIo()
      expect(handleCli(["init", "--create-config"], io2, { HOME: home })).toEqual({ action: "exit", code: 0 })
      expect(readFileSync(file, "utf8")).toBe('{"model":"mine@model","note":"keep me"}')
      expect(lines2.join("\n")).toContain("already exists")

      // SENSUS_HOME redirects the scaffold location (same rule as boot).
      const { io: io3 } = captureIo()
      expect(handleCli(["init", "--create-config"], io3, { SENSUS_HOME: join(home, "redirected") })).toEqual({
        action: "exit",
        code: 0,
      })
      expect(existsSync(join(home, "redirected/config.json"))).toBe(true)

      // No HOME/SENSUS_HOME at all: a clear error, not a write to /.config.
      const { errors, io: io4 } = captureIo()
      expect(handleCli(["init", "--create-config"], io4, {})).toEqual({ action: "exit", code: 1 })
      expect(errors.join("\n")).toContain("HOME")
    } finally {
      cleanup()
    }
  })

  test("init NEVER touches a shell rc file (temp HOME with pre-existing rc files)", () => {
    const { home, cleanup } = tempHome()
    try {
      // Existing rc files must survive both the wizard decision and the
      // headless scaffold byte-for-byte.
      const zshrc = join(home, ".zshrc")
      const bashrc = join(home, ".bashrc")
      writeFileSync(zshrc, "export EDITOR=vim\n")
      writeFileSync(bashrc, "export PS1='x'\n")

      const { io } = captureIo()
      expect(handleCli(["init"], io, { HOME: home })).toEqual({ action: "boot", setup: "force" })
      expect(handleCli(["init", "--create-config"], io, { HOME: home })).toEqual({ action: "exit", code: 0 })

      expect(readFileSync(zshrc, "utf8")).toBe("export EDITOR=vim\n")
      expect(readFileSync(bashrc, "utf8")).toBe("export PS1='x'\n")
      // And with no rc files present, init does not create any.
      const fresh = mkdtempSync(join(tmpdir(), "sensus-cli-norc-"))
      try {
        expect(handleCli(["init", "--create-config"], io, { HOME: fresh })).toEqual({ action: "exit", code: 0 })
        expect(existsSync(join(fresh, ".zshrc"))).toBe(false)
        expect(existsSync(join(fresh, ".bashrc"))).toBe(false)
      } finally {
        rmSync(fresh, { recursive: true, force: true })
      }
    } finally {
      cleanup()
    }
  })

  test("nest guard: boots inside sensus refuse unless SENSUS_SKIP; headless subcommands stay usable", () => {
    // The guard's predicate: set in every sensus pane, overridden by the
    // test/dogfood hatch.
    expect(nestedBootRefused({ SENSUS_ACTIVE: "1" })).toBe(true)
    expect(nestedBootRefused({ SENSUS_ACTIVE: "1", SENSUS_SKIP: "1" })).toBe(false)
    expect(nestedBootRefused({ SENSUS_ACTIVE: "" })).toBe(false)
    expect(nestedBootRefused({})).toBe(false)
    // Any boot argv (bare, flags, typo'd subcommand) is refused with the hint.
    for (const argv of [[], ["--resume"], ["inti"]]) {
      const { errors, io } = captureIo()
      expect(handleCli(argv, io, { SENSUS_ACTIVE: "1" })).toEqual({ action: "exit", code: 1 })
      expect(errors.join("\n")).toContain("SENSUS_SKIP=1")
    }
    // `sensus init` boots the TUI now (setup is in-app), so it refuses to nest
    // too — with a HOME set so the HOME check is not what fires.
    const { home, cleanup } = tempHome()
    try {
      const { errors, io: initIo } = captureIo()
      expect(handleCli(["init"], initIo, { SENSUS_ACTIVE: "1", HOME: home })).toEqual({ action: "exit", code: 1 })
      expect(errors.join("\n")).toContain("SENSUS_SKIP=1")
    } finally {
      cleanup()
    }
    // The test/dogfood hatch starts a nested copy on purpose; an empty
    // SENSUS_ACTIVE does not count.
    const { io: allow } = captureIo()
    expect(handleCli([], allow, { SENSUS_ACTIVE: "1", SENSUS_SKIP: "1" })).toEqual({ action: "boot" })
    expect(handleCli([], allow, { SENSUS_ACTIVE: "" })).toEqual({ action: "boot" })
    // Headless subcommands still work from inside sensus (checked before the guard).
    const { lines, io } = captureIo()
    expect(handleCli(["--version"], io, { SENSUS_ACTIVE: "1" })).toEqual({ action: "exit", code: 0 })
    expect(lines[0]).toBe(`sensus ${SENSUS_VERSION}`)
    expect(handleCli(["--help"], io, { SENSUS_ACTIVE: "1" })).toEqual({ action: "exit", code: 0 })
    const { home: home2, cleanup: cleanup2 } = tempHome()
    try {
      expect(handleCli(["init", "--create-config"], io, { SENSUS_ACTIVE: "1", HOME: home2 })).toEqual({
        action: "exit",
        code: 0,
      })
    } finally {
      cleanup2()
    }
  })

  test("terminal size guards: below 20x5 is too small, at/above is fine, the message names both", () => {
    for (const [cols, rows, tooSmall] of [
      [10, 3, true],
      [19, 50, true],
      [200, 4, true],
      [20, 5, false],
      [200, 50, false],
    ] as const) {
      expect(isTooSmall(cols, rows)).toBe(tooSmall)
    }
    expect(MIN_COLS).toBe(20)
    expect(MIN_ROWS).toBe(5)
    const msg = tooSmallMessage(10, 3)
    expect(msg).toContain("(10x3)")
    expect(msg).toContain("20x5")
  })
})

describe("cli events tail (docs/events.md)", () => {
  test("dispatch is headless and returns the events action", () => {
    const { io } = captureIo()
    expect(handleCli(["events", "tail"], io, {})).toEqual({ action: "events", argv: ["tail"] })
    // Still headless inside a sensus pane (handled before the nest guard).
    expect(handleCli(["events", "tail", "--follow"], io, { SENSUS_ACTIVE: "1" })).toEqual({
      action: "events",
      argv: ["tail", "--follow"],
    })
  })

  test("parseEventsArgs accepts follow/type/since, rejects bad flags and dates", () => {
    expect(parseEventsArgs(["tail"])).toEqual({ ok: true, follow: false, filter: { types: null, since: null } })
    const parsed = parseEventsArgs(["tail", "-f", "--type", "tool.executed,error.raised", "--since=1000"])
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.follow).toBe(true)
      expect(parsed.filter.types?.has("tool.executed")).toBe(true)
      expect(parsed.filter.types?.has("error.raised")).toBe(true)
      expect(parsed.filter.since).toBe(1000)
    }
    const iso = parseEventsArgs(["--since", "1970-01-01T00:00:01.000Z"])
    if (iso.ok) expect(iso.filter.since).toBe(1000)
    expect(parseEventsArgs(["--since", "not-a-date"]).ok).toBe(false)
    expect(parseEventsArgs(["--type"]).ok).toBe(false)
    expect(parseEventsArgs(["--nope"]).ok).toBe(false)
  })

  test("matchesEventsFilter filters by v1 type and since; unparseable lines drop", () => {
    const line = JSON.stringify({ v: 1, ts: 500, type: "tool.executed", instanceId: "i", session: "s" })
    expect(matchesEventsFilter(line, { types: null, since: null })).toBe(true)
    expect(matchesEventsFilter(line, { types: new Set(["tool.executed"]), since: null })).toBe(true)
    expect(matchesEventsFilter(line, { types: new Set(["error.raised"]), since: null })).toBe(false)
    expect(matchesEventsFilter(line, { types: null, since: 500 })).toBe(true)
    expect(matchesEventsFilter(line, { types: null, since: 501 })).toBe(false)
    // An unfiltered tail keeps every line (no parsing needed); once a filter
    // is present an unparseable line can never match.
    expect(matchesEventsFilter("{not json", { types: null, since: null })).toBe(true)
    expect(matchesEventsFilter("{not json", { types: new Set(["tool.executed"]), since: null })).toBe(false)
  })

  test("runEvents prints the log (filters applied) and returns 0; a missing log is empty", async () => {
    const { home, cleanup } = tempHome()
    try {
      const lines = [
        { v: 1, ts: 100, type: "session.started", instanceId: "i", session: "s" },
        { v: 1, ts: 200, type: "tool.executed", instanceId: "i", session: "s" },
        { v: 1, ts: 300, type: "error.raised", instanceId: "i", session: "s" },
      ]
      writeFileSync(join(home, "events.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")

      const all = captureIo()
      expect(await runEvents(["tail"], all.io, { SENSUS_HOME: home })).toBe(0)
      expect(all.lines).toHaveLength(3)
      expect(all.lines[0]).toContain("session.started")

      const filtered = captureIo()
      expect(await runEvents(["tail", "--type", "error.raised", "--since", "250"], filtered.io, { SENSUS_HOME: home })).toBe(0)
      expect(filtered.lines).toHaveLength(1)
      expect(filtered.lines[0]).toContain("error.raised")

      const missing = captureIo()
      expect(await runEvents(["tail"], missing.io, { SENSUS_HOME: join(home, "nope") })).toBe(0)
      expect(missing.lines).toEqual([])

      const bad = captureIo()
      expect(await runEvents(["tail", "--since", "nope"], bad.io, { SENSUS_HOME: home })).toBe(1)
      expect(bad.errors.join("\n")).toContain("--since")
    } finally {
      cleanup()
    }
  })
})

describe("cli triggers tail (docs/triggers.md)", () => {
  test("dispatch is headless and returns the triggers action", () => {
    const { io } = captureIo()
    expect(handleCli(["triggers", "tail"], io, {})).toEqual({ action: "triggers", argv: ["tail"] })
    // Still headless inside a sensus pane (handled before the nest guard).
    expect(handleCli(["triggers", "tail", "--follow"], io, { SENSUS_ACTIVE: "1" })).toEqual({
      action: "triggers",
      argv: ["tail", "--follow"],
    })
  })

  test("matchesTriggersFilter matches the rule's `on` or the underlying event type", () => {
    const record = JSON.stringify({
      v: 1,
      ts: 500,
      on: "error.raised",
      event: { v: 1, ts: 500, type: "error.raised", instanceId: "i", session: "s" },
    })
    const wildcard = JSON.stringify({
      v: 1,
      ts: 600,
      on: "*",
      event: { v: 1, ts: 600, type: "tool.executed", instanceId: "i", session: "s" },
    })
    expect(matchesTriggersFilter(record, { types: null, since: null })).toBe(true)
    expect(matchesTriggersFilter(record, { types: new Set(["error.raised"]), since: null })).toBe(true)
    expect(matchesTriggersFilter(record, { types: new Set(["tool.executed"]), since: null })).toBe(false)
    // A `"*"` rule is still selectable by the concrete event it fired on.
    expect(matchesTriggersFilter(wildcard, { types: new Set(["*"]), since: null })).toBe(true)
    expect(matchesTriggersFilter(wildcard, { types: new Set(["tool.executed"]), since: null })).toBe(true)
    expect(matchesTriggersFilter(record, { types: null, since: 500 })).toBe(true)
    expect(matchesTriggersFilter(record, { types: null, since: 501 })).toBe(false)
    expect(matchesTriggersFilter("{not json", { types: new Set(["error.raised"]), since: null })).toBe(false)
  })

  test("runTriggers prints the log (filters applied) and returns 0; a missing log is empty", async () => {
    const { home, cleanup } = tempHome()
    try {
      const lines = [
        { v: 1, ts: 100, on: "error.raised", event: { type: "error.raised" } },
        { v: 1, ts: 200, on: "*", event: { type: "tool.executed" } },
        { v: 1, ts: 300, on: "memory.written", event: { type: "memory.written" } },
      ]
      writeFileSync(join(home, "triggers.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")

      const all = captureIo()
      expect(await runTriggers(["tail"], all.io, { SENSUS_HOME: home })).toBe(0)
      expect(all.lines).toHaveLength(3)

      const filtered = captureIo()
      expect(await runTriggers(["tail", "--type", "tool.executed"], filtered.io, { SENSUS_HOME: home })).toBe(0)
      expect(filtered.lines).toHaveLength(1)
      expect(filtered.lines[0]).toContain("tool.executed")

      const missing = captureIo()
      expect(await runTriggers(["tail"], missing.io, { SENSUS_HOME: join(home, "nope") })).toBe(0)
      expect(missing.lines).toEqual([])

      const bad = captureIo()
      expect(await runTriggers(["tail", "--nope"], bad.io, { SENSUS_HOME: home })).toBe(1)
      expect(bad.errors.join("\n")).toContain("unknown flag")
    } finally {
      cleanup()
    }
  })
})
