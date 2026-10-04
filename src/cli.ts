/**
 * CLI handling for the non-TUI entry points:
 *
 *   sensus --help | -h | help        usage text
 *   sensus --version | -v | version  version line
 *   sensus update | upgrade          check the latest release and install it
 *                                    in place (headless; never boots the TUI)
 *   sensus init                      boot the TUI with the setup wizard open
 *                                    (optional alias for the in-app `/init-wizard`;
 *                                    index.tsx reads the "setup" intent)
 *   sensus init --create-config      headless: scaffold the starter config.json
 *                                    (never overwrites; the installers depend
 *                                    on this — no rc writes, no TUI)
 *   sensus [flags]                   boot the TUI (default)
 *
 * Handled BEFORE config resolution / terminal boot, so these work headless
 * (and from the compiled binary). Pure-ish: output goes through an injected
 * `io`, the config path comes from the passed env — unit tests run it without
 * spawning.
 *
 * The zshrc launcher is gone: `init` no longer touches any rc file, and
 * `--remove`/`--print` were removed with it.
 */

import { existsSync, readFileSync } from "node:fs"
import { configPath, eventsPath, sensusDataDirFrom, sensusHomeFrom, starterConfigDoc, triggersPath } from "./config/config.ts"
import { writeRawConfig } from "./config/configFile.ts"
import { deleteSecret, listSecretNames, migrateConfigSecrets, secretsPath, setSecret } from "./config/secrets.ts"
import { loadSessionFile } from "./session/store.ts"
import { sessionToMarkdown } from "./session/meta.ts"
import { SENSUS_VERSION } from "./version.ts"
import { errorMessage } from "./core/util.ts"

export interface CliIo {
  out(s: string): void
  err(s: string): void
}

export type CliDecision =
  | { action: "boot"; setup?: "force" }
  | { action: "exit"; code: number }
  | { action: "update"; argv: string[] }
  | { action: "daemon"; argv: string[] }
  | { action: "kill"; argv: string[] }
  | { action: "events"; argv: string[] }
  | { action: "triggers"; argv: string[] }

/**
 * Refusal printed when the TUI boot happens inside sensus (README "Never
 * nests"). Sensus panes carry `SENSUS_ACTIVE=1`; a manual `sensus` typed
 * inside a sensus pane is refused here. `SENSUS_SKIP=1` is the test/dogfood
 * hatch that starts a nested instance on purpose.
 */
export const NEST_GUARD_MESSAGE =
  "sensus: refusing to start inside sensus (SENSUS_ACTIVE is set).\n" +
  "Detach first (Ctrl+A then d), or set SENSUS_SKIP=1 to start a nested copy on purpose (tests/dogfooding)."

/**
 * True when a TUI boot must be refused because we are inside a sensus pane
 * (`SENSUS_ACTIVE=1`) and the test/dogfooding hatch is not set. Used by the
 * nest guard below (docs/operations.md "Launcher"): every boot path, including
 * `sensus init`, now starts the TUI (setup is an in-app overlay), so all of
 * them must not nest.
 */
export function nestedBootRefused(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env["SENSUS_ACTIVE"] && !env["SENSUS_SKIP"])
}

const USAGE = `sensus ${SENSUS_VERSION} — a terminal you live in: terminal TUI with an embedded shell and an AI agent sidebar.

Usage:
  sensus [flags]            start sensus (a fullscreen TUI hosting your shell)
  sensus init               start sensus with the setup wizard open (optional)
  sensus init --create-config   scaffold ~/.config/sensus/config.json (never overwrites)
  sensus --version          print the version
  sensus --help             this text
  sensus --export <file>    print a session transcript as markdown
  sensus update             update to the latest release in place (alias: upgrade)
  sensus secrets <cmd>      manage the encrypted secrets store: list | set <NAME> <value> | rm <NAME> | migrate
  sensus daemon <cmd>       run/manage the local daemon (worker): serve | start | stop | status | logs | install | uninstall
  sensus kill               stop every running sensus daemon (the kill switch; --dry-run)
  sensus events tail        print the local event log (--follow, --type <t>, --since <ms|ISO>)
  sensus triggers tail      print the local trigger log (--follow, --type <t>)

Setup runs INSIDE sensus: a plain first run opens the wizard automatically, and
/init-wizard (or Ctrl+P → Setup wizard) reopens it. "sensus init" just opens it on boot.

Start flags:
  --model <endpoint@id>     select the model (bare <id> keeps the endpoint)
  --endpoint <name>        switch the selected model's endpoint
  --base-url <url>         override the selected endpoint's baseURL
  --resume                  pick a recent chat session to continue
  --yolo                    start in full-auto approval mode
  --sidebar-width <cols>    chat sidebar width in columns

Docs: docs/config.md (configuration) · docs/agents.md (agents) ·
docs/keybindings.md (keys) · ~/.config/sensus/AGENTS.md (custom agent
instructions).`

function printUsage(io: CliIo): void {
  io.out(USAGE)
}

/**
 * `sensus init --create-config`: scaffold the starter config.json when the
 * file does not exist yet — NEVER overwrites (user edits are the truth),
 * never throws. The installers run exactly this, so it must stay headless.
 */
function scaffoldConfigFile(io: CliIo, env: NodeJS.ProcessEnv): number {
  if (!(env["SENSUS_HOME"] ?? env["HOME"])) {
    io.err("sensus init: HOME is not set — cannot locate the config directory")
    return 1
  }
  const path = configPath(sensusHomeFrom(env))
  if (existsSync(path)) {
    io.out(`sensus init: config already exists (${path}) — leaving it untouched`)
    return 0
  }
  const res = writeRawConfig(path, starterConfigDoc())
  if (!res.ok) {
    io.err(`sensus init: could not write ${path}: ${res.error ?? "unknown error"}`)
    return 1
  }
  io.out(`Created starter config: ${path} (schema + docs: docs/config.md)`)
  return 0
}

/**
 * Handle `sensus init [flags]`. Returns a decision to stop (headless scaffold,
 * removed flags, or a missing HOME), or `null` to continue booting the TUI —
 * `handleCli` then marks that boot with `setup: "force"`.
 */
function runInit(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv): CliDecision | null {
  if (argv.includes("--remove") || argv.includes("--print")) {
    io.err(
      "sensus init: --remove/--print were removed with the zshrc launcher — " +
        "`sensus` no longer starts from your shell; run `sensus` (setup opens in-app) or `sensus init`.",
    )
    return { action: "exit", code: 1 }
  }
  // Headless, config-only: the installers rely on this exact invocation and it
  // must never open a TUI or touch an rc file.
  if (argv.includes("--create-config")) {
    return { action: "exit", code: scaffoldConfigFile(io, env) }
  }
  if (!(env["SENSUS_HOME"] ?? env["HOME"])) {
    io.err("sensus init: HOME is not set — cannot locate the config directory")
    return { action: "exit", code: 1 }
  }
  // Interactive setup now lives INSIDE sensus: boot the TUI and open the setup
  // modal (handleCli marks the boot; index.tsx/App open it). Nothing is written
  // before the TUI starts.
  return null
}

/**
 * `sensus secrets …` (docs/config.md "Secrets"): manage the encrypted store
 * headlessly. `migrate` moves every plaintext key out of config.json and
 * rewrites it with `${NAME}` refs; the other verbs edit the store directly.
 * Never boots the TUI, never nests.
 */
function runSecrets(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv): number {
  if (!(env["SENSUS_HOME"] ?? env["HOME"])) {
    io.err("sensus secrets: HOME is not set — cannot locate the config directory")
    return 1
  }
  const home = sensusHomeFrom(env)
  const sub = argv[0] ?? "list"

  if (sub === "list") {
    const names = listSecretNames(home)
    if (names.length === 0) io.out(`(no secrets stored — ${secretsPath(home)})`)
    else for (const n of names) io.out(n)
    return 0
  }

  if (sub === "set") {
    const name = argv[1]
    const value = argv[2]
    if (name === undefined || value === undefined || value.length === 0) {
      io.err("usage: sensus secrets set <NAME> <value>")
      return 1
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      io.err("sensus secrets: NAME must match [A-Za-z_][A-Za-z0-9_]*")
      return 1
    }
    const res = setSecret(home, name, value)
    if (!res.ok) {
      io.err(`sensus secrets: ${res.error ?? "write failed"}`)
      return 1
    }
    io.out(`stored ${name} in ${secretsPath(home)} — reference it as \${${name}} in config.json`)
    return 0
  }

  if (sub === "rm" || sub === "delete") {
    const name = argv[1]
    if (name === undefined || name.length === 0) {
      io.err("usage: sensus secrets rm <NAME>")
      return 1
    }
    const res = deleteSecret(home, name)
    if (!res.ok) {
      io.err(`sensus secrets: ${res.error ?? "write failed"}`)
      return 1
    }
    io.out(`removed ${name}`)
    return 0
  }

  if (sub === "migrate") {
    const res = migrateConfigSecrets(home)
    if (!res.ok) {
      io.err(`sensus secrets migrate: ${res.error ?? "migration failed"}`)
      return 1
    }
    if (res.moved.length === 0) {
      io.out("no plaintext secrets found in config.json")
      return 0
    }
    io.out(`moved ${res.moved.length} secret(s) into ${secretsPath(home)}; config.json now references them:`)
    for (const n of res.moved) io.out(`  \${${n}}`)
    return 0
  }

  io.err("usage: sensus secrets [list | set <NAME> <value> | rm <NAME> | migrate]")
  return 1
}

// ---- events tail (docs/events.md) ------------------------------------------

/** How often `--follow` re-reads the log for appended lines. */
export const EVENTS_FOLLOW_MS = 250

export interface EventsFilter {
  /** v1 type names to keep (null = all). */
  types: Set<string> | null
  /** Inclusive lower bound on `ts` (null = unbounded). */
  since: number | null
}

export type ParsedEventsArgs =
  | { ok: true; follow: boolean; filter: EventsFilter }
  | { ok: false; error: string }

/** Parse a `--since` value: epoch millis or anything `Date.parse` accepts. */
function parseSince(value: string): number | null {
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const ms = Date.parse(trimmed)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Parse `sensus events tail [--follow|-f] [--type a,b] [--since <ms|ISO>]`.
 * A leading `tail` positional is accepted; unknown flags are an error.
 */
export function parseEventsArgs(argv: readonly string[]): ParsedEventsArgs {
  const args = argv[0] === "tail" ? argv.slice(1) : argv
  let follow = false
  let types: Set<string> | null = null
  let since: number | null = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ""
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1
    const flag = eq >= 0 ? arg.slice(0, eq) : arg
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined
    if (flag === "--follow" || flag === "-f") {
      follow = true
      continue
    }
    if (flag === "--type") {
      const value = inline ?? args[++i]
      if (value === undefined || value.trim().length === 0) return { ok: false, error: "--type needs a value" }
      types = new Set(value.split(",").map((s) => s.trim()).filter((s) => s.length > 0))
      continue
    }
    if (flag === "--since") {
      const value = inline ?? args[++i]
      if (value === undefined || value.trim().length === 0) return { ok: false, error: "--since needs a value" }
      const parsed = parseSince(value)
      if (parsed === null) return { ok: false, error: `--since must be epoch millis or a date: ${value}` }
      since = parsed
      continue
    }
    if (flag.startsWith("-")) return { ok: false, error: `unknown flag: ${flag}` }
    // A bare positional (an extra `tail`) is ignored.
  }
  return { ok: true, follow, filter: { types, since } }
}

/** True when one raw NDJSON line matches the filter (unparseable = false). */
export function matchesEventsFilter(line: string, filter: EventsFilter): boolean {
  if (filter.types === null && filter.since === null) return true
  try {
    const rec = JSON.parse(line) as { type?: unknown; ts?: unknown }
    if (filter.types !== null && (typeof rec.type !== "string" || !filter.types.has(rec.type))) return false
    if (filter.since !== null && (typeof rec.ts !== "number" || rec.ts < filter.since)) return false
    return true
  } catch {
    return false
  }
}

/**
 * `sensus events tail` (docs/events.md): print the local v1 event log, then
 * follow it with `--follow`. Headless — never boots the TUI, never nests. The
 * log path is the data dir (`SENSUS_HOME` redirects it, like the sessions dir).
 */
export async function runEvents(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv): Promise<number> {
  const parsed = parseEventsArgs(argv)
  if (!parsed.ok) {
    io.err(`sensus events: ${parsed.error}`)
    io.err("usage: sensus events tail [--follow] [--type <type,type>] [--since <epoch-ms|ISO>]")
    return 1
  }
  const path = eventsPath(sensusDataDirFrom(env))
  let offset = 0
  const readNew = (): void => {
    let buf: Buffer
    try {
      buf = readFileSync(path)
    } catch {
      return // no log yet
    }
    // A truncated (or rotated-away) file: start over rather than mis-slice.
    if (buf.length < offset) offset = 0
    if (buf.length === offset) return
    const chunk = buf.subarray(offset).toString("utf8")
    offset = buf.length
    for (const line of chunk.split("\n")) {
      if (line.trim().length === 0) continue
      if (matchesEventsFilter(line, parsed.filter)) io.out(line)
    }
  }
  readNew()
  if (!parsed.follow) return 0
  await new Promise<void>((resolve) => {
    const timer = setInterval(readNew, EVENTS_FOLLOW_MS)
    const stop = (): void => {
      clearInterval(timer)
      resolve()
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
  return 0
}

/**
 * True when one trigger-log NDJSON line matches. `--type` matches the rule's
 * `on` value OR the underlying v1 event's `type` (so a `"*"` rule is still
 * selectable by the concrete event it fired on); `--since` matches `ts`.
 * Unparseable lines never match when a filter is set.
 */
export function matchesTriggersFilter(line: string, filter: EventsFilter): boolean {
  if (filter.types === null && filter.since === null) return true
  try {
    const rec = JSON.parse(line) as { on?: unknown; ts?: unknown; event?: { type?: unknown } }
    if (filter.types !== null) {
      const on = typeof rec.on === "string" ? rec.on : ""
      const eventType = rec.event !== undefined && typeof rec.event.type === "string" ? rec.event.type : ""
      if (!filter.types.has(on) && !filter.types.has(eventType)) return false
    }
    if (filter.since !== null && (typeof rec.ts !== "number" || rec.ts < filter.since)) return false
    return true
  } catch {
    return false
  }
}

/**
 * `sensus triggers tail` (docs/triggers.md): print the local condition-trigger
 * log, then follow it with `--follow`. Headless — never boots the TUI, never
 * nests. The log path is the data dir (`SENSUS_HOME` redirects it, like the
 * events log).
 */
export async function runTriggers(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv): Promise<number> {
  const parsed = parseEventsArgs(argv)
  if (!parsed.ok) {
    io.err(`sensus triggers: ${parsed.error}`)
    io.err("usage: sensus triggers tail [--follow] [--type <type,type>] [--since <epoch-ms|ISO>]")
    return 1
  }
  const path = triggersPath(sensusDataDirFrom(env))
  let offset = 0
  const readNew = (): void => {
    let buf: Buffer
    try {
      buf = readFileSync(path)
    } catch {
      return // no log yet
    }
    // A truncated (or rotated-away) file: start over rather than mis-slice.
    if (buf.length < offset) offset = 0
    if (buf.length === offset) return
    const chunk = buf.subarray(offset).toString("utf8")
    offset = buf.length
    for (const line of chunk.split("\n")) {
      if (line.trim().length === 0) continue
      if (matchesTriggersFilter(line, parsed.filter)) io.out(line)
    }
  }
  readNew()
  if (!parsed.follow) return 0
  await new Promise<void>((resolve) => {
    const timer = setInterval(readNew, EVENTS_FOLLOW_MS)
    const stop = (): void => {
      clearInterval(timer)
      resolve()
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
  return 0
}

/**
 * Dispatch subcommands/flags that must not boot the TUI. Everything else
 * (including unknown args) returns "boot" — flag parsing continues in
 * config.ts, which ignores what it does not know.
 */
export function handleCli(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv): CliDecision {
  const first = argv[0]
  const wantsInit = first === "init"
  if (wantsInit) {
    const decided = runInit(argv.slice(1), io, env)
    if (decided !== null) return decided
  }
  if (first === "--help" || first === "-h" || first === "help") {
    printUsage(io)
    return { action: "exit", code: 0 }
  }
  if (first === "--version" || first === "-v" || first === "version") {
    io.out(`sensus ${SENSUS_VERSION}`)
    return { action: "exit", code: 0 }
  }
  if (first === "--export") {
    const target = argv[1]
    if (target === undefined || target.length === 0) {
      io.err("sensus --export: needs a session file path")
      return { action: "exit", code: 1 }
    }
    try {
      io.out(sessionToMarkdown(loadSessionFile(target)))
      return { action: "exit", code: 0 }
    } catch (e) {
      io.err(`sensus --export: ${errorMessage(e)}`)
      return { action: "exit", code: 1 }
    }
  }
  if (first === "secrets") {
    return { action: "exit", code: runSecrets(argv.slice(1), io, env) }
  }
  // The daemon subcommands are HEADLESS and must be handled before the nest
  // guard, so `sensus daemon serve` works even with SENSUS_ACTIVE set
  // (docs/operations.md "Daemon"). `src/index.tsx` awaits the async runner
  // (handleCli stays synchronous so the pure CLI tests can stay spawn-free).
  if (first === "daemon") {
    return { action: "daemon", argv: argv.slice(1) }
  }
  // `sensus kill` is the global kill switch (docs/operations.md "Daemon"): it
  // stops every daemon this user runs, whatever runtime dir each was started
  // with. Headless — handled before the nest guard so it works inside a sensus
  // pane too (which it then kills; the runner warns). `index.tsx` lazily loads
  // the Elysia-free runner.
  if (first === "kill") {
    return { action: "kill", argv: argv.slice(1) }
  }
  // `sensus events tail` is headless too (docs/events.md): handled before the
  // nest guard so it works from inside a sensus pane. `index.tsx` awaits the
  // async runner (follow mode blocks).
  if (first === "events") {
    return { action: "events", argv: argv.slice(1) }
  }
  // `sensus triggers tail` is headless too (docs/triggers.md): handled before
  // the nest guard so it works from inside a sensus pane.
  if (first === "triggers") {
    return { action: "triggers", argv: argv.slice(1) }
  }
  // `sensus update` (alias `upgrade`) is headless too (docs/operations.md
  // "Update"): handled before the nest guard so it works from inside a sensus
  // pane. `src/index.tsx` awaits the async runner.
  if (first === "update" || first === "upgrade") {
    return { action: "update", argv: argv.slice(1) }
  }
  // Nesting guard (README "Never nests"): a MANUAL `sensus` inside a sensus
  // pane is refused — including `sensus init`, which now boots the TUI rather
  // than writing config pre-boot. Deliberately AFTER the headless subcommands
  // above (--create-config/--help/--version stay usable from inside sensus) and
  // BEFORE any config/terminal/render side effects. SENSUS_SKIP is the
  // test/dogfood hatch (the zshrc launcher that also checked it is gone).
  if (nestedBootRefused(env)) {
    io.err(NEST_GUARD_MESSAGE)
    return { action: "exit", code: 1 }
  }
  return wantsInit ? { action: "boot", setup: "force" } : { action: "boot" }
}
