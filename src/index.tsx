/**
 * sensus entry point: parse args -> load config (file/env/CLI) ->
 * (--resume: pick a session) -> boot the UI (which spawns the native PTY).
 *
 * Config validation (a bad baseURL logs + opens the setup modal to fix),
 * per-run instance id for the
 * JSONL session dirs, and the ChatHost wiring chat sessions into tabs.
 */

// Must be the FIRST import: it sets COLORTERM before @opentui/core evaluates
// (OpenTUI's native renderer reads the truecolor capability around load time).
import "./core/colorModeBoot.ts"
import { createCliRenderer, type CliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { loadConfig, parseArgs, sensusDataDir, sensusHome, configPath } from "./config/config.ts"
import { readRawConfig } from "./config/configFile.ts"
import { handleCli, runEvents, runTriggers } from "./cli.ts"
import { connect, restartAndReconnect } from "./client/daemonEnsure.ts"
import { RestClient } from "./client/restClient.ts"
import { HostAdapter } from "./client/hostAdapter.ts"
import { listAttachCandidates } from "./client/attachPicker.ts"
import { SENSUS_VERSION } from "./version.ts"
import type { SensusConfig } from "./config/config.ts"
import { listRecentSessions, type LoadedSession } from "./session/store.ts"
import { errorMessage } from "./core/util.ts"
import { resolvedColorMode } from "./core/colorMode.ts"
import { resolveTheme, setTheme, theme } from "./theme/theme.ts"
import { applyThemePersisted, currentThemeName } from "./theme/themePersist.ts"
import { App } from "./ui/components/App.tsx"
import { isTooSmall, shouldAutoChatOnly, tooSmallMessage } from "./ui/lib/layout.ts"
import { createSensusKeymap, enableModifyOtherKeysLevel2, type SensusKeymap } from "./core/keymapRuntime.ts"
import { createUiStore } from "./ui/lib/store.ts"
import { DaemonMismatchPrompt } from "./ui/components/DaemonMismatchPrompt.tsx"
import { resolveReattachMaxAgeMs, type DaemonInfo } from "./daemon/index.ts"
import type { AttachCandidate } from "./client/attachPicker.ts"
import type { WsClient } from "./client/wsClient.ts"
import { isDefaultConfig } from "./config/wizard.ts"

const cliIo = {
  out: (s: string): void => console.log(s),
  err: (s: string): void => console.error(s),
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  // Non-TUI entry points (--help/--version/init --create-config) run before
  // config resolution so they work headless and from the compiled binary.
  const cli = handleCli(argv, cliIo, process.env)
  if (cli.action === "exit") return cli.code
  // Headless daemon lifecycle (D18): loaded lazily so the TUI boot path never
  // pulls in Elysia. `serve` blocks here until a signal; the other commands
  // return an exit code.
  if (cli.action === "daemon") {
    const { runDaemon } = await import("./daemon/cli.ts")
    return await runDaemon(cli.argv, cliIo, process.env)
  }
  // Headless event-log tail (docs/events.md): `--follow` blocks here.
  if (cli.action === "events") {
    return await runEvents(cli.argv, cliIo, process.env)
  }
  // Headless trigger-log tail (docs/triggers.md): `--follow` blocks here.
  if (cli.action === "triggers") {
    return await runTriggers(cli.argv, cliIo, process.env)
  }
  // The global kill switch (docs/operations.md "Daemon"): stop every running
  // daemon this user owns, whatever runtime dir it uses. Loaded lazily and
  // Elysia-free, like the daemon lifecycle CLI.
  if (cli.action === "kill") {
    const { runKill } = await import("./daemon/kill.ts")
    return await runKill(cli.argv, cliIo, process.env)
  }
  // `sensus init` no longer configures in its own renderer: it boots the TUI
  // with the setup modal open (exactly like a plain first run). Setup is an
  // in-app overlay, so the wizard and every later edit share one surface
  // (docs/operations.md "Setup wizard").
  const forceSetup = cli.setup === "force"

  const config = loadConfig(argv)
  const dataDir = sensusDataDir()

  // A bad baseURL no longer refuses to boot: the provider client is built
  // lazily, so the TUI comes up and the setup modal fixes the endpoint in place
  // (docs/operations.md "Setup wizard").
  if (config.bootError) console.error(`sensus: ${config.bootError}`)
  for (const w of config.warnings) console.error(`sensus: ${w}`)

  // Boot the daemon and connect the client (D5): the TUI is HTTP/WS-only — no
  // in-process engine. A failure is a clear message and a non-zero exit, never
  // a crash. `connect()` auto-spawns an on-demand daemon (D3) and applies the
  // D21 version handshake.
  let conn = await connect({ localVersion: SENSUS_VERSION })
  if (!conn.ok) {
    console.error(`sensus: ${conn.error}`)
    console.error("sensus: cannot reach the daemon — run `sensus daemon start` and retry")
    return 1
  }
  // D21 version handshake: a running daemon whose version differs AND that still
  // holds live shells cannot be replaced silently. `connect()` hands that up as a
  // warning instead of losing the shells; prompt at boot and let the user choose
  // restart-and-lose-shells vs defer (docs/daemon-api.md "Version handshake").
  // A "restart" detaches, stops the stale daemon, starts the new version, and
  // reconnects; a "defer" keeps it and warns for the rest of the session.
  let deferredWarning: string | null = null
  if (conn.warning !== null) {
    const restart = await runDaemonMismatchPrompt(conn.info, conn.warning)
    if (restart) {
      const reconnected = await restartAndReconnect(conn, { localVersion: SENSUS_VERSION })
      if (!reconnected.ok) {
        console.error(`sensus: ${reconnected.error}`)
        console.error("sensus: cannot reach the daemon — run `sensus daemon restart` and retry")
        return 1
      }
      conn = reconnected
    } else {
      deferredWarning = conn.warning
    }
  }
  let daemonConfig: SensusConfig
  try {
    daemonConfig = (await conn.rest.config()).config as unknown as SensusConfig
  } catch (e) {
    console.error(`sensus: cannot read the daemon config: ${errorMessage(e)}`)
    conn.stop()
    return 1
  }
  const host = new HostAdapter({ rest: conn.rest, ws: conn.ws, initialConfig: daemonConfig })
  await host.preload()
  // Warm the daemon's models.dev catalog (writes its cache) so the status bar
  // resolves the real context window without opening the model picker first.
  void conn.rest.models().catch(() => {})

  // Setup intent: `sensus init` forces it; otherwise a first run (no config, or
  // an untouched auto-generated default) or a boot config error opens it so the
  // user is guided instead of facing a chat with no endpoint.
  // SENSUS_NO_SETUP=1 is the test/dogfooding hatch that keeps a plain boot bare
  // (like SENSUS_SKIP); it never suppresses an explicit `sensus init`.
  const noAutoSetup = ((): boolean => {
    const v = process.env["SENSUS_NO_SETUP"]
    return v === "1" || v === "true"
  })()
  const setupRaw = readRawConfig(configPath(sensusHome()))
  const firstRun = isDefaultConfig(setupRaw)
  const setup: "auto" | "force" | undefined = forceSetup
    ? "force"
    : noAutoSetup
      ? undefined
      : firstRun || config.bootError !== null
        ? "auto"
        : undefined

  const args = parseArgs(argv)
  // Boot picker data (D4): fetched here (it needs the daemon/session dir), but
  // the CHOICE is made in-app as a window like Settings — App opens the picker
  // and awaits it before booting tab 1. `--resume` lists recent sessions; a
  // plain boot lists the daemon's live shells/chats to re-attach.
  let resumeSessions: LoadedSession[] | undefined
  if (args.resume) {
    resumeSessions = listRecentSessions(dataDir)
  }
  let attachCandidates: AttachCandidate[] | undefined
  if (!args.resume) {
    attachCandidates = await listAttachCandidatesForBoot(conn.ws)
  }

  let renderer: CliRenderer | null = null
  let exiting = false

  const shutdown = (code: number, message?: string): void => {
    if (exiting) return
    exiting = true
    void (async () => {
      try {
        renderer?.destroy()
      } catch {
        // already destroyed
      }
      // Normal exits print nothing (architecture: "leave alt-screen, print
      // nothing") — unless SENSUS_DEBUG asks for the reason (test diagnosis).
      if (message) console.error(message)
      else if (process.env["SENSUS_DEBUG"]) {
        console.error(`sensus: exit (${code})`)
      }
      // DETACH (D4): close the WS but leave the daemon + shells alive. A full
      // teardown is `sensus daemon stop`.
      try {
        conn.stop()
      } catch {
        // already gone
      }
      process.exit(code)
    })()
  }

  // Instrument EVERY signal opentui treats as fatal (its exitSignals list) plus
  // SIGPIPE, so mid-run deaths are diagnosable under SENSUS_DEBUG. Our own
  // handlers are registered BEFORE createCliRenderer, so they run first.
  if (process.env["SENSUS_DEBUG"]) {
    const dbg = (sig: string): void => console.error(`sensus: signal ${sig}`)
    for (const sig of [
      "SIGINT",
      "SIGTERM",
      "SIGQUIT",
      "SIGABRT",
      "SIGHUP",
      "SIGPIPE",
      "SIGBUS",
      "SIGBREAK",
    ]) {
      process.on(sig as NodeJS.Signals, () => dbg(sig))
    }
    process.on("exit", (code) => console.error(`sensus: process exit (${code})`))
  }
  const onSignal = (_sig: string): void => {
    // Exit-signal handlers mirror opentui's fatal set (INT/TERM/HUP/QUIT).
    // Sensus quits; opentui ALSO destroys its renderer on these.
    shutdown(0)
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  process.on("SIGHUP", onSignal)
  process.on("SIGQUIT", onSignal)
  process.on("uncaughtException", (err) => {
    shutdown(1, `sensus crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
  })
  process.on("unhandledRejection", (reason) => {
    shutdown(1, `sensus crashed: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`)
  })

  // Theme (M5): resolve the config's theme name onto the live tokens BEFORE
  // the renderer starts. bg null (adaptive "terminal") → no renderer
  // background → the terminal's own palette shows through.
  const bootTheme = resolveTheme(config.theme)
  setTheme(bootTheme.name)
  const rendererBg = theme().bg

  try {
    // `remote: false` is load-bearing, not cosmetic: OpenTUI's terminal
    // capability detection treats an SSH session (SSH_CONNECTION/CLIENT/TTY) as
    // "remote with forwarded env" and EARLY-RETURNS before applying
    // `COLORTERM`/`TERM` (packages/native/src/terminal.zig
    // checkEnvironmentOverrides). Over SSH that leaves caps `rgb/ansi256` false
    // no matter what `core/colorMode.ts` forces, so every indexed pane color is
    // emitted as the fixed VGA snapshot (`38;2;128;0;0`) — the reported bug.
    // Sensus renders to the real terminal, not a remote host, so it must be
    // `.local`. `remote` only gates terminal graphics queries (renderer.zig).
    renderer = await createCliRenderer({
      remote: false,
      exitOnCtrlC: false,
      targetFps: 30,
      ...(rendererBg !== null ? { backgroundColor: rendererBg } : {}),
    })
    // Kitty keyboard protocol (docs/keybindings.md "Gotchas"): Shift+Enter and
    // distinct Ctrl+char reporting need an extended encoding, and OpenTUI only
    // QUERIES it at startup — push it explicitly so terminals that support the
    // protocol (Ghostty, kitty, WezTerm, …) report the Shift modifier. A
    // terminal without support ignores the sequence. Best-effort: an
    // unsupported renderer must never fail boot.
    try {
      renderer.enableKittyKeyboard()
    } catch {
      // no kitty support — the modifyOtherKeys upgrade below still applies
    }
    // xterm `modifyOtherKeys` fallback: OpenTUI enables it at construction but
    // only at LEVEL 1, which does NOT report the Shift modifier on Enter — so on
    // xterm / iTerm2 / macOS Terminal and other non-kitty terminals Shift+Enter
    // arrives as a bare CR, indistinguishable from Enter, and sends instead of
    // inserting a newline. Upgrade to LEVEL 2, whose `ESC [ 27 ; 2 ; 13 ~`
    // encoding OpenTUI's parser already decodes to `{return, shift:true}`.
    // Kitty terminals ignore this because the pushed protocol wins, and OpenTUI
    // resets to `>4;0m` on destroy so the mode does not leak. Best-effort.
    enableModifyOtherKeysLevel2()
    // Boot guard (M4 edge case): a terminal below 20x5 cannot host the layout
    // — refuse cleanly instead of rendering garbage.
    if (isTooSmall(renderer.width, renderer.height)) {
      const msg = tooSmallMessage(renderer.width, renderer.height)
      try {
        renderer.destroy()
      } catch {
        // ignore
      }
      renderer = null
      console.error(`sensus: ${msg}`)
      // Detach the client so the open WS + daemon child cannot hold the event
      // loop open (the process must exit with the clear refusal).
      try {
        conn.stop()
      } catch {
        // already gone
      }
      process.exit(1)
    }
    // M9: OpenTUI keymap — global hotkeys dispatch through it (keymapRuntime).
    // Created here because the renderer owns the key event stream it hooks.
    // A failure falls back to App's legacy inline hotkey check rather than
    // killing the boot.
    let sensusKeymap: SensusKeymap | undefined
    try {
      sensusKeymap = createSensusKeymap(renderer)
    } catch (err) {
      console.error(`sensus: keymap init failed (${errorMessage(err)}) — falling back to inline hotkeys`)
    }

    const store = createUiStore({
      sidebarWidth: config.sidebarWidth,
      layoutMode: config.layout,
      tabRailWidth: config.tabRailWidth,
      // Seed the narrow-terminal auto chat-only view from the boot size so
      // there is no first-frame flash; App keeps it live on resize/reload.
      autoChatOnly: config.autoChatOnly && shouldAutoChatOnly(renderer.width),
    })
    store.setTerminalState("ok")
    if (config.warnings[0]) store.showToast(config.warnings[0], "warn", 6000)
    // The user deferred the D21 daemon restart at boot: keep the reminder visible
    // so it is clear they are running the older daemon until they restart.
    if (deferredWarning !== null) store.showToast(deferredWarning, "warn", 10000)

    // Route adapter-side failures (config reload, memory writes) to toasts.
    host.onToast = (m, level, ttl) => store.showToast(m, level, ttl)

    // Sudo (docs/agent.md "Sudo"): the daemon emits `sudo.request` and blocks;
    // the UI shows the masked prompt and answers over WS.
    conn.ws.on("sudo.request", (e) => {
      store.setSudoRequest({
        command: e.command,
        ...(e.prompt.length > 0 ? { hint: e.prompt } : {}),
        resolve: (password, remember) => {
          store.setSudoRequest(null)
          void conn.ws
            .request("sudo.answer", { chatId: e.chatId, requestId: e.requestId, password: password ?? "", remember })
            .catch(() => {
              // a gone request / shell is not fatal
            })
        },
      })
    })
    conn.ws.on("sudo.resolved", () => {
      if (store.sudoRequest() !== null) store.setSudoRequest(null)
    })
    // Prime the MCP facts the status bar / manager read.
    void host.refreshMcp()

    await render(
      () => (
        <App
          store={store}
          shell={config.shell}
          keymapOverrides={config.keymap}
          sensusKeymap={sensusKeymap}
          host={host}
          attachCandidates={attachCandidates}
          resumeSessions={resumeSessions}
          setup={setup}
          setupError={config.bootError}
          onExit={(reason) => {
            if (reason && process.env["SENSUS_DEBUG"]) console.error(`sensus: ${reason}`)
            console.error("sensus: detached — shells stay in the daemon (run `sensus daemon stop` to tear it down)")
            shutdown(0)
          }}
        />
      ),
      renderer,
    )
  } catch (e) {
    const message = errorMessage(e)
    try {
      renderer?.destroy()
    } catch {
      // ignore
    }
    console.error(`sensus: failed to start: ${message}`)
    return 1
  }

  await new Promise<never>(() => {})
  return 0 // unreachable
}

/**
 * Fetch the daemon's re-attachable candidates for the boot picker window (D4).
 * Age-gated so a session from a previous workday is never offered (the daemon's
 * reaper kills them; this guards the race). Every failure yields `[]` — the boot
 * then starts a fresh tab, never crashes (AGENTS.md rule 10).
 */
async function listAttachCandidatesForBoot(ws: WsClient): Promise<AttachCandidate[]> {
  try {
    return (await listAttachCandidates(ws, resolveReattachMaxAgeMs())).candidates
  } catch {
    return []
  }
}

/**
 * The D21 boot prompt, in its own fullscreen renderer like the resume/attach
 * pickers: when the running daemon holds shells and its version differs, ask
 * whether to restart it (loses the shells) or keep it. A renderer failure
 * defers — a prompt must never kill the boot (AGENTS.md rule 10).
 */
async function runDaemonMismatchPrompt(info: DaemonInfo, warning: string): Promise<boolean> {
  let picker: CliRenderer | null = null
  const pickerBg = theme().bg
  try {
    picker = await createCliRenderer({
      // Same SSH capability fix as the main renderer (see the comment there).
      remote: false,
      exitOnCtrlC: false,
      targetFps: 30,
      ...(pickerBg !== null ? { backgroundColor: pickerBg } : {}),
    })
  } catch {
    return false
  }
  const restart = await new Promise<boolean>((resolve) => {
    void render(
      () => <DaemonMismatchPrompt warning={warning} shells={info.shells} onChoice={(r) => resolve(r)} />,
      picker,
    )
  })
  try {
    picker?.destroy()
  } catch {
    // ignore
  }
  return restart
}

export default main

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code
  })
  .catch((err) => {
    console.error(`sensus: ${errorMessage(err)}`)
    process.exitCode = 1
  })
