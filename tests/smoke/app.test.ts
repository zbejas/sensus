/**
 * App-shell smoke (dogfood pattern from AGENTS.md): the SHELL half of the app
 * driven by an OUTER tmux — boot/layout, tabs, native scrollback, vim mouse,
 * OSC52, sidebar resize/paste, settings (endpoints v2), theme persistence, the
 * /models picker, the Ctrl+A prefix and the nest guard. The agent chat
 * (streaming, tools, approvals, agents, MCP) lives in chat.test.ts;
 * ship/color-fidelity stay dedicated guard files. The app itself owns no tmux
 * server — the outer session below is only the test driver.
 *
 * One boot per scenario group; all artifacts under /tmp/sensus; SENSUS_HOME
 * sandboxes.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startMockModelsDev, startMockOpenai } from "../mocks/mockOpenai.ts"
import {
  appBootCommand,
  bgCount,
  bootSessionArgv,
  createHarness,
  expectNoStrayProcesses,
  REPO_ROOT,
  sgrPress,
  sgrRelease,
  sgrWheelSeq,
  writeSmokeConfig,
  type Harness,
} from "../helpers.ts"

const h: Harness = createHarness({
  sock: `/tmp/sensus/sensus-app-smoke-${process.pid}.sock`,
  tag: "app",
  dumpTarget: "app:0",
  labelFromPredicate: true,
})

const outer = h.outer
const capT = h.capT
const capET = h.capET
const sendHexToUI = (bytes: string, target = "app:0"): Promise<void> => h.sendHexTo(bytes, target)

/** Focus observable: the input title gains a dot when the chat has focus. */
const CHAT_FOCUS = "input ●"

const mock = await startMockOpenai()
const mockDev = await startMockModelsDev()

afterAll(async () => {
  await mock.close().catch(() => {})
  await mockDev.close().catch(() => {})
  await h.killServer()
  try {
    rmSync(h.sock, { force: true })
  } catch {
    // tmux 3.6 leaves socket files
  }
})

describe("sensus app shell (in-tmux smoke)", () => {
  test(
    "boots, tabs, scrollback, vim mouse, OSC52, paste, sidebar resize, clean exit",
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), "sensus-smoke-"))
      const sensusHome = `${workDir}/home`
      // Keep the historical topbar layout: this scenario drives the horizontal
      // tab bar and hard-coded row indices; the rail has its own scenario.
      writeSmokeConfig(sensusHome, { layout: "topbar" })
      const lines: string[] = []
      for (let i = 1; i <= 100; i++) lines.push(`N${String(i).padStart(3, "0")}`)
      const vimFile = join(workDir, "hundred.txt")
      writeFileSync(vimFile, lines.join("\n") + "\n")

      try {
        const start = await outer(
          bootSessionArgv(
            "app",
            `env SHELL=/bin/bash SENSUS_SKIP=1 SENSUS_HOME=${sensusHome} SENSUS_RUNTIME_DIR=${sensusHome}/daemon-runtime bun run src/index.tsx`,
          ),
        )
        expect(start.code).toBe(0)
        const capture = async (extra: string[] = []): Promise<string> =>
          (await outer(["capture-pane", "-p", ...extra, "-t", "app:0"])).stdout
        const typeText = (t: string): Promise<void> => h.typeTo("app:0", t)
        const pressKey = (k: string): Promise<void> => h.keyTo("app:0", k)
        const waitFor = (
          p: () => boolean | Promise<boolean>,
          timeoutMs = 15000,
          stepMs = 100,
          label = "?",
        ): Promise<void> => h.waitFor(p, label, { timeoutMs, stepMs })

        // 1. Boot: tab bar, sidebar, status bar (fresh tab title = shell basename).
        await waitFor(async () => {
          const out = await capture()
          return out.includes("1:bash") && out.includes("no messages yet") && out.includes("tab 1: bash")
        })
        console.log("[app] boot ok")

        // 2. Keys reach the pane.
        await typeText("echo SMOKETEST-$((40+2))")
        await pressKey("Enter")
        await waitFor(async () => (await capture()).includes("SMOKETEST-42"))
        console.log("[app] key roundtrip ok")

        // 3. Native scrollback: wheel up reveals lines above the live viewport.
        //    Paced ~20ms — opentui coalesces rapid same-coordinate wheel events.
        //    The embedded VT has no scroll indicator, so the older line itself
        //    is the proof: live shows ~N015..N060, so N010 is scrollback-only.
        await typeText("seq -f 'N%03g' 1 60")
        await pressKey("Enter")
        await waitFor(async () => (await capture()).includes("N060"))
        for (let i = 0; i < 3; i++) {
          await sendHexToUI(sgrWheelSeq(true, 10, 10))
          await Bun.sleep(20)
        }
        await waitFor(async () => {
          const out = await capture()
          return out.includes("N010") && !out.includes("N060")
        })
        console.log("[app] scrollback wheel shows older lines")
        // Wheel back to the bottom re-arms live follow (typing does NOT exit
        // the native scrollback — that was tmux copy-mode behavior).
        for (let i = 0; i < 5; i++) {
          await sendHexToUI(sgrWheelSeq(false, 10, 10))
          await Bun.sleep(20)
        }
        await waitFor(async () => {
          const out = await capture()
          return out.includes("N060") && !out.includes("N010")
        })
        await typeText("echo LIVE-BACK")
        await pressKey("Enter")
        await waitFor(async () => (await capture()).includes("LIVE-BACK"))
        console.log("[app] wheel returns to live; new output follows")

        // 4. Tabs: open, per-tab frames, jump, shell-basename title, close.
        await pressKey("C-t")
        await waitFor(async () => {
          const out = await capture()
          return out.includes("2:bash") && out.includes("tab 2/2: bash")
        })
        await typeText("echo TAB2MARK")
        await pressKey("Enter")
        await waitFor(async () => (await capture()).includes("TAB2MARK"))
        await pressKey("M-Left")
        await waitFor(async () => {
          const out = await capture()
          return out.includes("tab 1/2: bash") && out.includes("N060") && !out.includes("TAB2MARK")
        })
        console.log("[app] tab switch restores tab frames")
        await pressKey("M-1")
        await pressKey("M-Right")
        await waitFor(async () => {
          const out = await capture()
          return out.includes("tab 2/2: bash") && out.includes("TAB2MARK")
        })
        await typeText("sleep 30")
        await pressKey("Enter")
        // The tab title is the shell basename now (no `pane_current_command`):
        // running a command no longer renames the tab.
        await waitFor(async () => {
          const out = await capture()
          return out.includes("tab 2/2: bash") && out.includes("2:bash")
        })
        await pressKey("C-w")
        await waitFor(async () => {
          const out = await capture()
          return out.includes("tab 1: bash") && out.includes("N060") && !out.includes("2:bash")
        })
        console.log("[app] tabs open/switch/close ok")

        // 4b. Chat resize (Alt+. / Alt+,) keeps the terminal usable
        //     (/status pane size). Run before the overlays: the global hotkey
        //     layer can miss the first Alt+punctuation right after an overlay
        //     closes, which made this racy at the end of the sequence.
        await pressKey("M-.") // grow chat 50 -> 54 (pane narrows)
        // Regression guard: the resize must not wipe or double-space the pane
        // (the embedded VT's reflow is corrupted by an explicit default-bg
        // truecolor or a `\e[2J` erase). The earlier `seq` output survives.
        await waitFor(async () => {
          const out = await capture()
          return out.includes("N030") && out.includes("N060")
        })
        await typeText("echo RESIZED-OK")
        await pressKey("Enter")
        await waitFor(async () => (await capture()).includes("RESIZED-OK"))
        await pressKey("BTab")
        await waitFor(async () => (await capture()).includes(CHAT_FOCUS), 5000)
        await typeText("/status")
        await pressKey("Enter")
        await waitFor(async () => (await capture()).includes("pane size: 143x46"), 8000)
        await pressKey("BTab")
        await waitFor(async () => !(await capture()).includes(CHAT_FOCUS), 5000)
        await pressKey("M-,") // shrink back
        // Content also survives shrinking the chat back.
        await waitFor(async () => {
          const out = await capture()
          return out.includes("N030") && out.includes("N060")
        })
        await typeText("echo RESIZED-BACK")
        await pressKey("Enter")
        await waitFor(async () => (await capture()).includes("RESIZED-BACK"))
        console.log("[app] sidebar resize keeps pane usable + content (/status size ok)")

        // 4c. Drag the pane divider (mouse) to resize, and the status-bar
        //     context chip opens the context inspector (the model chip opens
        //     the model picker). The sidebar is back at its 50-col default.
        //     The two cards are separate, so the divider is the blank gap one
        //     column right of the terminal card's top-right corner `╮`.
        const borderRow = await h.rowOf("app:0", "terminal")
        const termRight = async (): Promise<number> => h.colOf("app:0", borderRow, "╮")
        const startRight = await termRight()
        expect(startRight).toBeGreaterThan(0)
        const dragY = 10
        // Drag 10 columns left → sidebar 50 → 60, then back to the default 50.
        // The divider follows the pointer 1:1, so moving the mouse `delta`
        // columns moves the border `delta` too. Retry a drag whose motion event
        // was coalesced/dropped (the pane reflows on every step; docs/testing.md
        // "wait for the transition").
        const dragDividerTo = async (target: number): Promise<void> => {
          for (let attempt = 0; attempt < 5; attempt++) {
            const right = await termRight()
            if (right === target) return
            const divider = right + 1 // the blank column between the two cards
            const delta = target - right
            await sendHexToUI(sgrPress(divider, dragY))
            await Bun.sleep(30)
            // The raw SGR motion param is 1-based (screen col + 1).
            await sendHexToUI(`\x1b[<32;${divider + delta + 1};${dragY + 1}M`)
            await Bun.sleep(30)
            await sendHexToUI(sgrRelease(divider + delta, dragY))
            await Bun.sleep(60)
          }
          await h.waitFor(async () => (await termRight()) === target, "divider drag")
        }
        await dragDividerTo(startRight - 10)
        await dragDividerTo(startRight)
        // Context chip click → context inspector (Esc closes).
        const barRow = await h.rowOf("app:0", "tab 1: bash")
        const barLine = (await capture()).split("\n")[barRow] ?? ""
        const modelAt = barLine.indexOf("main@gpt-5")
        expect(modelAt).toBeGreaterThan(0)
        const ctxCol = modelAt + "main@gpt-5".length + " · ".length
        await sendHexToUI(sgrPress(ctxCol, barRow))
        await sendHexToUI(sgrRelease(ctxCol, barRow))
        await waitFor(async () => (await capture()).includes("context inspector"))
        await pressKey("Escape")
        await waitFor(async () => !(await capture()).includes("context inspector"))
        console.log("[app] divider drag + status context chip ok")

        // 5. vim with mouse=a: wheel scrolls the buffer, click moves the cursor.
        await typeText(`vim -u NONE ${vimFile}`)
        await pressKey("Enter")
        await waitFor(async () => (await capture()).includes("N001"))
        await typeText(":set mouse=a ruler")
        await pressKey("Enter")
        // The status bar no longer reports `mouse:app` (no tmux mouse flag);
        // vim's own ruler confirms the option took effect before we wheel/click.
        await waitFor(async () => /1,1\s+Top/.test(await capture()))
        console.log("[app] vim mouse mode on (ruler confirmed)")
        for (let i = 0; i < 2; i++) {
          await sendHexToUI(sgrWheelSeq(false, 6, 12))
          await Bun.sleep(20)
        }
        await waitFor(async () => {
          const out = await capture()
          return !out.includes("N001") && !out.includes("N002")
        })
        console.log("[app] vim wheel scroll ok")
        await typeText("gg")
        await waitFor(async () => (await capture()).includes("N001"))
        await sendHexToUI(sgrPress(6, 31))
        await sendHexToUI(sgrRelease(6, 31))
        await waitFor(async () => /\b30,\d/.test(await capture()))
        console.log("[app] vim click-to-move ok")
        await typeText(":q!")
        await pressKey("Enter")
        await waitFor(async () => (await capture()).includes("bash") && !(await capture()).includes("N001"))

        // 6. Drag-select -> OSC52 copy (asserted on the pane's raw OUTPUT via
        //    pipe-pane; each poll re-establishes the target and re-drags).
        const oscLog = "/tmp/sensus/osc52-pane-output.log"
        try {
          rmSync(oscLog, { force: true })
        } catch {
          // ignore
        }
        await outer(["pipe-pane", "-o", "-t", "app:0", `dd of=${oscLog} bs=1 status=none`])
        await typeText("clear")
        await pressKey("Enter")
        await typeText("echo OSC52TARGET")
        await pressKey("Enter")
        await waitFor(async () => (await capture()).includes("OSC52TARGET"))
        const expectedB64 = Buffer.from("OSC52TARGET").toString("base64")
        await waitFor(
          async () => {
            try {
              const out = await Bun.file(oscLog).text()
              if (out.includes("]52;c;") && out.includes(expectedB64)) return true
            } catch {
              // file not created yet
            }
            await typeText("clear")
            await pressKey("Enter")
            await typeText("echo OSC52TARGET")
            await pressKey("Enter")
            await Bun.sleep(400)
            await sendHexToUI(sgrPress(1, 3))
            await sendHexToUI(`\x1b[<32;${11};${4}M`)
            await sendHexToUI(`\x1b[<32;${21};${4}M`)
            await sendHexToUI(sgrRelease(20, 3))
            return false
          },
          15000,
          150,
        )
        await outer(["pipe-pane", "-t", "app:0"])
        console.log("[app] OSC52 copy ok")

        // 6b. Chrome is NOT selectable: dragging over a command-menu header
        //     must neither copy nor close the menu. Step 6 proved the SGR drag
        //     path copies from the terminal, so the absence here is meaningful
        //     (regression: menu text used to be selectable and copied on
        //     click/drag).
        // Step 6's copy toast is still on screen (2.5s TTL): let it expire so
        // this check isolates the drag's effect from the earlier selection.
        await waitFor(async () => !(await capture()).includes("copied to clipboard"), 6000)
        await pressKey("C-p")
        await waitFor(async () => (await capture()).includes("command menu"))
        const headerY = await h.rowOf("app:0", "Settings")
        expect(headerY).toBeGreaterThan(0)
        // Drag ACROSS the header text. The chrome is a centered modal whose
        // column moves with the terminal width, so derive the x from the
        // header itself instead of a fixed screen column (SGR is 1-based).
        const headerX = await h.colOf("app:0", headerY, "Settings")
        expect(headerX).toBeGreaterThan(0)
        const wireY = headerY + 1
        await sendHexToUI(`\x1b[<0;${headerX + 1};${wireY}M`)
        await sendHexToUI(`\x1b[<32;${headerX + 7};${wireY}M`)
        await sendHexToUI(`\x1b[<32;${headerX + 15};${wireY}M`)
        await sendHexToUI(`\x1b[<0;${headerX + 15};${wireY}m`)
        await Bun.sleep(400)
        const menuAfterDrag = await capture()
        expect(menuAfterDrag.includes("copied to clipboard")).toBe(false)
        expect(menuAfterDrag.includes("command menu")).toBe(true)
        await pressKey("Escape")
        await waitFor(async () => !(await capture()).includes("command menu"))
        console.log("[app] menu drag does not select/copy ok")

        // 8. Bracketed paste into the sidebar draft; the send (no API key)
        //    proves the send path ran and empties the input.
        await pressKey("BTab")
        await waitFor(async () => (await capture()).includes(CHAT_FOCUS), 5000)
        await outerWithInput(["load-buffer", "-"], "PASTED-DRAFT")
        await outer(["paste-buffer", "-t", "app:0"])
        await waitFor(async () => (await capture()).includes("PASTED-DRAFT"))
        await pressKey("Enter")
        await waitFor(async () => (await capture()).includes("no API key"), 8000)
        await pressKey("BTab")
        await waitFor(async () => !(await capture()).includes(CHAT_FOCUS), 5000)
        console.log("[app] sidebar paste ok")

        // 8b. Terminal-reply leak guard (docs/terminal-layer.md "Input &
        //     focus"): a terminal colour reply split across reads makes
        //     opentui's stdin parser flush the head and re-emit its tail as key
        //     events. Inject a split OSC 11 reply (`ESC]11;rgb` + >20ms +
        //     `:ffff/ffff/ffff`), let the guard drop it, then deliver the
        //     residual (`0c`) in a SEPARATE read; none of it may reach the pane.
        await sendHexToUI("1b 5d 31 31 3b 72 67 62")
        await Bun.sleep(120)
        await sendHexToUI("3a 66 66 66 66 2f 66 66 66 66 2f 66 66 66 66")
        await Bun.sleep(120)
        await sendHexToUI("30 63")
        await Bun.sleep(200)
        const afterGuard = await capture()
        expect(afterGuard).not.toContain(":ffff")
        expect(afterGuard).not.toContain("# 0c")
        // Clear the readline buffer in case a regression left junk on the prompt.
        await pressKey("C-u")
        console.log("[app] split OSC reply guard ok")

        // 9. Exit: shell death in the last tab quits sensus. The outer session
        //    ending + no lingering sandbox process is the whole proof now (no
        //    private tmux server to inspect).
        await typeText("exit")
        await pressKey("Enter")
        await waitFor(async () => (await outer(["has-session", "-t", "app"])).code !== 0, 10000)
        console.log("[app] clean exit ok")
        await Bun.sleep(300)
        await expectNoStrayProcesses(sensusHome)
      } finally {
        await outer(["kill-server"])
        try {
          rmSync(workDir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    },
    180_000,
  )

  test(
    "chat-only view (Alt+Home): pane hides, chat spans full width, second press restores",
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), "sensus-app-chatonly-"))
      const sensusHome = `${workDir}/home`
      writeSmokeConfig(sensusHome, { layout: "topbar" })
      try {
        const start = await outer(
          bootSessionArgv(
            "appchatonly",
            `env SHELL=/bin/bash SENSUS_SKIP=1 SENSUS_HOME=${sensusHome} SENSUS_RUNTIME_DIR=${sensusHome}/daemon-runtime bun run src/index.tsx`,
          ),
        )
        expect(start.code).toBe(0)
        const cap = (): Promise<string> => capT("appchatonly:0")
        const key = (k: string): Promise<void> => h.keyTo("appchatonly:0", k)
        const waitFor = (p: () => boolean | Promise<boolean>, label: string, timeoutMs = 15000): Promise<void> =>
          h.waitFor(p, label, { timeoutMs })
        // The chat card's title sits on its top border; its column is the card's
        // left edge, so a leftward shift proves the card widened to full width.
        const chatTitleCol = async (): Promise<number> => {
          const row = await h.rowOf("appchatonly:0", "chat")
          if (row < 0) return -1
          return h.colOf("appchatonly:0", row, "chat")
        }

        await waitFor(async () => {
          const out = await cap()
          return out.includes("terminal ●") && out.includes("no messages yet") && out.includes("tab 1: bash")
        }, "boot: pane focused, chat visible, status bar")
        const fullLayoutCol = await chatTitleCol()
        expect(fullLayoutCol).toBeGreaterThan(0)

        // Alt+Home: the pane unmounts, focus clamps to the chat, the chat card
        // starts at the left edge, and the top + status bars stay.
        await key("M-Home")
        await waitFor(async () => {
          const out = await cap()
          return !out.includes("terminal ●") && out.includes("chat ●")
        }, "pane hidden, chat focused")
        await waitFor(async () => {
          const out = await cap()
          return out.includes("1:bash") && out.includes("tab 1: bash")
        }, "top bar + status bar kept")
        const chatOnlyCol = await chatTitleCol()
        expect(chatOnlyCol).toBeLessThan(fullLayoutCol)

        // Shift+Tab cannot focus the hidden pane (focus stays clamped to chat).
        await key("BTab")
        await Bun.sleep(300)
        expect(await cap()).toContain("chat ●")

        // A second Alt+Home restores the pane and the configured layout.
        await key("M-Home")
        await waitFor(async () => (await chatTitleCol()) > chatOnlyCol, "pane restored, chat shrinks back")
        console.log("[app] chat-only view (Alt+Home) hides/restores the pane")
      } finally {
        await outer(["kill-server"])
        try {
          rmSync(workDir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    },
    120_000,
  )

  test(
    "auto chat-only: a narrow terminal starts with the pane hidden (default on)",
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), "sensus-app-auto-"))
      const sensusHome = `${workDir}/home`
      // A 30-col chat sidebar so the revealed pane at 60 columns is usable
      // (the topbar layout does not clamp the configured chat width).
      writeSmokeConfig(sensusHome, { layout: "topbar", sidebar: { width: 30 } })
      try {
        const start = await outer(
          bootSessionArgv(
            "appauto",
            `env SHELL=/bin/bash SENSUS_SKIP=1 SENSUS_HOME=${sensusHome} SENSUS_RUNTIME_DIR=${sensusHome}/daemon-runtime bun run src/index.tsx`,
            { cols: 60, rows: 30 },
          ),
        )
        expect(start.code).toBe(0)
        const cap = (): Promise<string> => capT("appauto:0")
        const key = (k: string): Promise<void> => h.keyTo("appauto:0", k)
        const waitFor = (p: () => boolean | Promise<boolean>, label: string, timeoutMs = 15000): Promise<void> =>
          h.waitFor(p, label, { timeoutMs })

        // 60 columns: the pane is hidden and the chat has focus, by default.
        await waitFor(async () => {
          const out = await cap()
          return out.includes("chat ●") && !out.includes("terminal ●") && out.includes("1:bash")
        }, "narrow boot auto-switches to chat-only")
        // The chat card starts at the left edge (full width).
        const chatRow = await h.rowOf("appauto:0", "chat")
        expect(chatRow).toBeGreaterThanOrEqual(0)
        expect((await cap()).split("\n")[chatRow] ?? "").toContain("╭")

        // Alt+Home still overrides: the pane comes back even though auto is on.
        // Focus stays on the chat, so the revealed pane is unfocused.
        await key("M-Home")
        await waitFor(async () => {
          const out = await cap()
          return out.includes(" terminal ") && out.includes("chat ●")
        }, "manual Alt+Home reveals the pane")
        console.log("[app] auto chat-only on a narrow terminal (Alt+Home overrides)")
      } finally {
        await outer(["kill-server"])
        try {
          rmSync(workDir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    },
    120_000,
  )

  test(
    "settings endpoints, theme live + persisted, /models picker, test-connection",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "sensus-app-settings-"))
      const sensusHome = join(home, "home")
      const configPathInSandbox = `${sensusHome}/config.json`

      const boot = (session: string): Promise<{ code: number }> =>
        outer(
          bootSessionArgv(
            session,
            appBootCommand({
              sensusHome,
              bootLog: `/tmp/sensus/app-settings-${session}.stderr.log`,
              mockUrl: mock.url,
              env: `SENSUS_CACHE_DIR=${sensusHome}/cache SENSUS_MOCK=1 SENSUS_MODELS_DEV_URL=${mockDev.url}`,
            }),
          ),
        )

      try {
        const start = await boot("appset")
        expect(start.code).toBe(0)
        const cap = (): Promise<string> => capT("appset:0")
        const capE = (): Promise<string> => capET("appset:0")
        const key = (k: string): Promise<void> => h.keyTo("appset:0", k)
        const typ = (t: string): Promise<void> => h.typeTo("appset:0", t)
        const waitFor = (p: () => boolean | Promise<boolean>, label: string, timeoutMs = 15000): Promise<void> =>
          h.waitFor(p, label, { timeoutMs, dump: cap })

        // 0. Boot: terminal theme paints ZERO background SGRs (M5 invariant).
        await waitFor(async () => (await cap()).includes("no messages yet"), "boot")
        await waitFor(async () => bgCount(await capE()) === 0, "terminal theme paints no backgrounds", 8000)
        // Boot prefetch: the models.dev index lands in the sandbox cache before
        // the picker is ever opened, so a default install resolves the real
        // context window instead of the 128k fallback.
        await waitFor(() => existsSync(`${sensusHome}/cache/models-dev.json`), "models.dev prefetched at boot")
        console.log("[app] settings boot ok (terminal theme, zero bg SGRs, models.dev prefetched)")

        // 1. Ctrl+O opens the endpoint list.
        await key("C-o")
        await waitFor(async () => (await cap()).includes("+ add endpoint") && (await cap()).includes("main"), "endpoint list opens")
        console.log("[app] ctrl+o opens the endpoint list")

        // 1b. Bracketed paste (what a real terminal sends for Cmd/Ctrl+V)
        //     reaches the open overlay through store.overlayPasteHandler; it
        //     used to be dropped for every overlay except the sudo prompt.
        await outerWithInput(["load-buffer", "-"], "bracketed")
        await outer(["paste-buffer", "-p", "-t", "appset:0"])
        await waitFor(async () => (await cap()).includes("filter: bracketed"), "settings filter got the paste")
        await key("Escape") // clear the filter
        await waitFor(async () => !(await cap()).includes("filter: bracketed"), "settings filter cleared")
        console.log("[app] bracketed paste into a settings field works")

        // 2. Add an endpoint via the row, then delete it (persist round-trip).
        await key("Down") // main -> "+ add endpoint"
        await key("Enter")
        await waitFor(async () => (await cap()).includes('endpoint "endpoint-2"'), "endpoint-2 added + opened")
        for (let i = 0; i < 11; i++) await key("Down") // name0 .. browse10 -> delete11
        await key("Enter") // destructive confirm (y/N) — never deletes on a single Enter
        await waitFor(async () => (await cap()).includes("delete endpoint"), "delete confirm shown")
        await key("y")
        await waitFor(async () => !(await cap()).includes("endpoint-2"), "endpoint-2 deleted")
        expect(readFileSync(configPathInSandbox, "utf8")).not.toContain("endpoint-2")
        console.log("[app] endpoint add + delete round-trip persists")

        // 3. Theme switch LIVE via the picker (Appearance → theme).
        await key("Escape")
        await waitFor(async () => !(await cap()).includes("+ add endpoint"), "settings closed", 6000)
        await key("C-o")
        await waitFor(async () => (await cap()).includes("+ add endpoint"), "settings reopens")
        await key("Tab") // detail pane -> rail
        await key("Down")
        await key("Down")
        await key("Down") // Endpoints -> Model -> Agent -> Appearance
        await key("Enter") // open Appearance (focuses the detail pane)
        await waitFor(async () => (await cap()).includes("settings · Appearance"), "appearance view")
        await waitFor(async () => (await cap()).includes("auto chat-only"), "auto chat-only row present")
        await key("Enter") // theme row -> opens the searchable picker
        await waitFor(async () => (await cap()).includes("filter:"), "theme picker opens")
        await typ("dracula")
        await waitFor(async () => bgCount(await capE()) > 0, "dracula preview paints backgrounds", 8000)
        await key("Enter") // apply + persist, returns to settings
        await waitFor(async () => (await cap()).includes("+ add endpoint"), "settings returns after pick")
        await waitFor(
          () => readFileSync(configPathInSandbox, "utf8").includes('"theme": "dracula"'),
          "theme persisted",
          8000,
        )
        await waitFor(async () => bgCount(await capE()) > 0, "dracula theme paints backgrounds", 8000)
        console.log("[app] theme picker live preview + persisted (dracula)")

        // 3b. The old global Advanced rail category is now a PER-SECTION
        //     submenu: Appearance ends with an "Advanced…" row one level
        //     deeper (themePalette overrides); Esc pops back to the section.
        //     (The picker above unmounted/re-mounted this screen, so navigate
        //     back to Appearance first.)
        await key("Tab") // detail -> rail
        await key("Down")
        await key("Down")
        await key("Down") // Endpoints -> Model -> Agent -> Appearance
        await key("Enter") // open Appearance (focuses the detail pane)
        await waitFor(async () => (await cap()).includes("settings · Appearance"), "appearance for advanced")
        await key("Down") // theme -> chat sidebar width -> layout -> auto chat-only -> tab rail width -> Advanced…
        await key("Down")
        await key("Down")
        await key("Down")
        await key("Down")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("settings · Appearance · advanced"), "advanced submenu opens")
        await waitFor(async () => (await cap()).includes("default foreground"), "themePalette fields shown")
        for (let i = 0; i < 2; i++) await key("Down") // default fg -> default bg -> color mode
        await key("Enter") // color mode auto -> truecolor (persists)
        await waitFor(
          () => readFileSync(configPathInSandbox, "utf8").includes('"colorMode": "truecolor"'),
          "advanced color mode persisted",
          8000,
        )
        await key("Escape")
        await waitFor(
          async () => (await cap()).includes("settings · Appearance") && !(await cap()).includes("advanced"),
          "advanced pops back to Appearance",
        )
        console.log("[app] per-section Advanced submenu opens + persists + pops back")

        // 4. Pick terminal back; chrome must emit ZERO bg SGRs again.
        await key("Tab") // detail pane -> rail
        await key("Home") // reset to the top of the rail (step 3b left it on Appearance)
        await key("Down")
        await key("Down")
        await key("Down") // -> Appearance
        await key("Enter") // open Appearance
        await waitFor(async () => (await cap()).includes("settings · Appearance"), "appearance view 2")
        await key("Enter") // theme row -> picker
        await waitFor(async () => (await cap()).includes("filter:"), "theme picker opens 2")
        await typ("terminal")
        await key("Enter") // apply + persist, returns to settings
        await waitFor(
          () => readFileSync(configPathInSandbox, "utf8").includes('"theme": "terminal"'),
          "theme back to terminal",
          20000,
        )
        await waitFor(async () => (await cap()).includes("+ add endpoint"), "settings returns after terminal pick")
        await key("Escape")
        await waitFor(async () => !(await cap()).includes("+ add endpoint"), "settings closed 2", 6000)
        await waitFor(async () => bgCount(await capE()) === 0, "no black-boxing after round-trip", 8000)
        expect(readFileSync(configPathInSandbox, "utf8")).toContain('"theme": "terminal"')
        console.log("[app] theme round-trip leaves zero bg SGRs (no black-boxing)")

        // 4b. The Chat display rows apply to LIVE bubbles, not just new ones:
        //     render a message card (the palette's "Show help" runs the local
        //     /help slash — no provider needed), then flip chat.cardStyle
        //     fill (the default) -> border in Settings. The already-rendered
        //     bubble must repaint WITHOUT a restart (it loses the theme card
        //     fill), and cycling it back must restore it.
        await key("C-p")
        await waitFor(async () => (await cap()).includes("type to filter"), "palette opens for help")
        await typ("help")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("Ctrl+O opens /settings"), "help bubble rendered")
        await waitFor(async () => !(await cap()).includes("type to filter"), "palette closed after help", 6000)
        const fillBg = bgCount(await capE())
        // The Chat category exposes the configurable tool-turn cap and the
        // card-style row; cycling each persists (chat.maxToolTurns / cardStyle).
        await key("C-o")
        await waitFor(async () => (await cap()).includes("+ add endpoint"), "settings reopens for chat")
        await key("Tab") // detail pane -> rail
        for (let i = 0; i < 4; i++) await key("Down") // Endpoints -> Model -> Agent -> Appearance -> Chat
        await key("Enter") // open Chat (focuses the detail pane)
        await waitFor(async () => (await cap()).includes("settings · Chat"), "chat view")
        await waitFor(async () => (await cap()).includes("tool turns"), "tool turns row")
        for (let i = 0; i < 4; i++) await key("Down") // thinking -> tool output -> animations -> card style -> tool turns
        await key("Enter") // off -> 25
        await waitFor(() => readFileSync(configPathInSandbox, "utf8").includes('"maxToolTurns": 25'), "tool turns persisted", 8000)
        await key("Up") // tool turns -> card style
        await key("Enter") // fill -> border
        await waitFor(() => readFileSync(configPathInSandbox, "utf8").includes('"cardStyle": "border"'), "card style persisted", 8000)
        await key("Escape")
        await waitFor(async () => !(await cap()).includes("settings · Chat"), "settings closed 3", 6000)
        // The commit toasts paint a card fill of their own; let them expire so
        // the count isolates the message bubble.
        await waitFor(
          async () => !(await cap()).includes("cardStyle") && !(await cap()).includes("config reloaded"),
          "card-style toasts cleared",
          6000,
        )
        await waitFor(async () => bgCount(await capE()) < fillBg, "live bubble rebuilt without the card fill", 8000)
        const borderBg = bgCount(await capE())
        // Cycle back to fill: the same live bubble repaints again and the
        // persisted default is left untouched for the restart step below.
        await key("C-o")
        await waitFor(async () => (await cap()).includes("+ add endpoint"), "settings reopens for card style")
        await key("Tab")
        for (let i = 0; i < 4; i++) await key("Down")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("settings · Chat"), "chat view 2")
        for (let i = 0; i < 3; i++) await key("Down") // thinking -> tool output -> animations -> card style
        await key("Enter") // border -> fill
        await waitFor(() => readFileSync(configPathInSandbox, "utf8").includes('"cardStyle": "fill"'), "card style restored", 8000)
        await key("Escape")
        await waitFor(async () => !(await cap()).includes("settings · Chat"), "settings closed 4", 6000)
        await waitFor(
          async () => !(await cap()).includes("cardStyle") && !(await cap()).includes("config reloaded"),
          "restore toasts cleared",
          6000,
        )
        await waitFor(async () => bgCount(await capE()) > borderBg, "live bubble rebuilt with the card fill", 8000)
        console.log("[app] chat card style + tool-turn cap apply live and persist")

        // 5. /models: picker rows are endpoint-scoped; Enter applies + persists.
        await key("BTab")
        await waitFor(async () => (await cap()).includes(CHAT_FOCUS), "focus sidebar")
        await typ("/models")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("model picker"), "picker opens")
        await waitFor(async () => (await cap()).includes("main · mock-gpt-large"), "endpoint models listed")
        await waitFor(async () => (await cap()).includes("Mock GPT Large"), "models.dev enrichment")
        await waitFor(async () => (await cap()).includes("262k"), "context limit shown")
        await typ("large")
        await waitFor(async () => !(await cap()).includes("qwen3-coder"), "filter narrows")
        await key("Enter") // apply to session + persist as default
        await waitFor(async () => (await cap()).includes("main@mock-gpt-large"), "status bar shows the pick")
        // The write is synchronous, but a loaded parallel run can still read
        // the file mid-frame — poll for the persisted value.
        await waitFor(
          () => readFileSync(configPathInSandbox, "utf8").includes('"model": "main@mock-gpt-large"'),
          "model persisted",
          8000,
        )
        console.log("[app] /models lists + enriches + persists the pick")

        // 6. /theme persists across RESTART (boot 2, same SENSUS_HOME).
        await typ("/theme dark")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("theme → dark"), "/theme applies")
        expect(readFileSync(configPathInSandbox, "utf8")).toContain('"theme": "dark"')
        await key("BTab")
        await waitFor(async () => !(await cap()).includes(CHAT_FOCUS), "terminal focus before exit", 5000)
        // A global hotkey can swallow the next byte through some overlay/theme
        // transitions; C-c absorbs it (and clears the empty prompt anyway).
        await key("C-c")
        await typ("exit")
        await key("Enter")
        await waitFor(async () => (await outer(["has-session", "-t", "appset"])).code !== 0, "clean exit 1", 10000)
        await Bun.sleep(400)

        const start2 = await boot("appset2")
        expect(start2.code).toBe(0)
        const cap2 = (): Promise<string> => capT("appset2:0")
        const cap2E = (): Promise<string> => capET("appset2:0")
        const key2 = (k: string): Promise<void> => h.keyTo("appset2:0", k)
        await h.waitFor(
          async () => (await cap2()).includes("no messages yet") && (await cap2()).includes("main@mock-gpt-large"),
          "restart boot + persisted model",
          { timeoutMs: 15000 },
        )
        // The ctx limit comes from the models.dev cache persisted on disk —
        // the EFFECTIVE ceiling: min(262k context window, 200k input cap).
        await h.waitFor(async () => (await cap2()).includes("main@mock-gpt-large · 200k"), "ctx limit from cache", { timeoutMs: 10000 })
        await h.waitFor(async () => bgCount(await cap2E()) > 0, "dark theme after restart", { timeoutMs: 8000 })
        console.log("[app] /theme + model persist across restart")

        // 7. Settings test-connection against the mock (endpoint + model count).
        await key2("C-o")
        await h.waitFor(async () => (await cap2()).includes("+ add endpoint"), "endpoint list (boot 2)", { timeoutMs: 8000 })
        await key2("Enter") // open the "main" endpoint editor
        await h.waitFor(async () => (await cap2()).includes('endpoint "main"'), "endpoint editor", { timeoutMs: 8000 })
        for (let i = 0; i < 4; i++) await key2("Down") // name0..show3 -> test4
        await key2("Enter")
        await h.waitFor(async () => (await cap2()).includes("test connection: ok"), "test connection ok", { timeoutMs: 10000 })
        await h.waitFor(async () => (await cap2()).includes("5 model(s)"), "model count shown", { timeoutMs: 8000 })
        console.log("[app] settings test connection ok against the mock")

        // 8. Clean exit 2; no lingering sandbox process.
        await key2("Escape")
        // The editor title vanishes when the overlay closes (any view).
        await h.waitFor(async () => !(await cap2()).includes('endpoint "main"'), "settings closed", { timeoutMs: 6000 })
        await h.typeTo("appset2:0", "exit")
        await key2("Enter")
        await h.waitFor(async () => (await outer(["has-session", "-t", "appset2"])).code !== 0, "clean exit 2", { timeoutMs: 10000 })
        await Bun.sleep(400)
        await expectNoStrayProcesses(sensusHome)
        console.log("[app] clean exits + no strays")
      } finally {
        await outer(["kill-server"])
        try {
          rmSync(home, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    },
    240_000,
  )

  test(
    "sensus init: bracketed paste fills the api-key field (trailing newline stripped)",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "sensus-app-init-"))
      const sensusHome = join(home, "home")
      const configFile = join(sensusHome, "config.json")
      try {
        const start = await outer(
          bootSessionArgv(
            "appinit",
            `env SHELL=/bin/bash SENSUS_SKIP=1 SENSUS_HOME=${sensusHome} SENSUS_RUNTIME_DIR=${sensusHome}/daemon-runtime bun run src/index.tsx init; echo "INIT-EXIT=$?"; sleep 60`,
          ),
        )
        expect(start.code).toBe(0)
        const cap = (): Promise<string> => capT("appinit:0")
        const key = (k: string): Promise<void> => h.keyTo("appinit:0", k)
        const waitFor = (p: () => boolean | Promise<boolean>, label: string, timeoutMs = 15000): Promise<void> =>
          h.waitFor(p, label, { timeoutMs, dump: cap })

        await waitFor(async () => (await cap()).includes("sensus setup — theme"), "wizard opens on theme first")
        await key("Enter") // apply the default theme and continue to the endpoint
        await waitFor(async () => (await cap()).includes("sensus setup — endpoint"), "endpoint step")
        // The provider row leads the field list: ←/→ cycles the real protocols
        // (mock is not offered here).
        await key("Right")
        await waitFor(async () => (await cap()).includes("OpenAI (Responses)"), "provider cycles to OpenAI Responses")
        await key("Left")
        await waitFor(async () => !(await cap()).includes("OpenAI (Responses)"), "provider cycles back")
        await key("Tab")
        await key("Tab")
        await key("Tab") // provider -> name -> baseURL -> api key
        // Enter opens the field for editing (the wizard never edits on a bare
        // keystroke); a real terminal then sends bracketed paste and the
        // trailing newline must be stripped, not treated as Enter.
        await key("Enter")
        await outerWithInput(["load-buffer", "-"], "sk-init-paste-abcdef\n")
        await outer(["paste-buffer", "-p", "-t", "appinit:0"])
        await key("C-r") // reveal the key
        await waitFor(async () => (await cap()).includes("sk-init-paste-abcdef"), "pasted key visible")
        expect(await cap()).toContain("sensus setup — endpoint")
        console.log("[app] init wizard Enter-to-edit + bracketed paste into the api-key field ok")

        await key("Enter") // commit the field edit
        await key("Escape") // leaving is confirm-gated now (nothing written yet)
        await waitFor(async () => (await cap()).includes("exit setup?"), "exit confirmation appears", 8000)
        await key("y") // confirm exit: close the wizard, write nothing
        await waitFor(async () => !(await cap()).includes("sensus setup — endpoint"), "wizard closes after confirm", 8000)
        let wrote = false
        try {
          readFileSync(configFile)
          wrote = true
        } catch {
          // cancelled: nothing written
        }
        expect(wrote).toBe(false)
        console.log("[app] init exit confirms, then writes no config")
      } finally {
        await outer(["kill-server"])
        try {
          rmSync(home, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    },
    90_000,
  )

  test(
    "sensus init: save writes config, boots sensus, and onboarding leaves you in it",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "sensus-app-ready-"))
      const sensusHome = join(home, "home")
      const configFile = join(sensusHome, "config.json")
      try {
        const start = await outer(
          bootSessionArgv(
            "appready",
            `env SHELL=/bin/bash SENSUS_SKIP=1 SENSUS_HOME=${sensusHome} SENSUS_RUNTIME_DIR=${sensusHome}/daemon-runtime bun run src/index.tsx init; echo "INIT-EXIT=$?"; sleep 60`,
          ),
        )
        expect(start.code).toBe(0)
        const cap = (): Promise<string> => capT("appready:0")
        const key = (k: string): Promise<void> => h.keyTo("appready:0", k)
        const typ = (t: string): Promise<void> => h.typeTo("appready:0", t)
        const waitFor = (p: () => boolean | Promise<boolean>, label: string, timeoutMs = 15000): Promise<void> =>
          h.waitFor(p, label, { timeoutMs, dump: cap })

        await waitFor(async () => (await cap()).includes("sensus setup — theme"), "wizard opens on theme")
        await key("Enter") // apply the default theme → endpoint
        await waitFor(async () => (await cap()).includes("sensus setup — endpoint"), "endpoint step")
        await key("Tab")
        await key("Tab")
        await key("Tab")
        await key("Tab") // provider → name → baseURL → api key → continue (no key needed)
        await key("Enter") // continue → test
        await waitFor(async () => (await cap()).includes("sensus setup — test"), "test step")
        await key("Enter") // continue despite the (expected) fetch failure
        await waitFor(async () => (await cap()).includes("sensus setup — model"), "model step")
        await typ("test-model")
        await key("Enter") // typed id is the choice when nothing was fetched
        await waitFor(async () => (await cap()).includes("sensus setup — host scan"), "host scan step")
        await key("n") // skip the host scan → review
        await waitFor(async () => (await cap()).includes("sensus setup — review"), "review step")
        await key("Enter") // write the config → the wizard exits and sensus boots

        // The TUI boots with the welcome overlay over it (the orientation moved
        // out of the wizard, which no longer prints "Run `sensus` to start.").
        await waitFor(async () => (await cap()).includes("welcome to sensus"), "onboarding overlay appears", 25000)
        await waitFor(async () => (await cap()).includes("the layout"), "first onboarding page")
        // The preview defaults to the sidebar rail now (the config default).
        await waitFor(async () => (await cap()).includes("sidebar layout"), "layout preview defaults to sidebar")
        await key("l")
        await waitFor(async () => (await cap()).includes("topbar layout"), "layout preview toggles to topbar")
        // The preview is LIVE and SAVED: the pick is written to config.json,
        // not just the session store.
        await waitFor(async () => readFileSync(configFile, "utf8").includes('"layout": "topbar"'), "layout pick saved")
        expect(existsSync(configFile)).toBe(true)
        expect(readFileSync(configFile, "utf8")).toContain("test-model")

        // Enter pages straight to the hotkey cheat sheet (no chat page).
        await key("Enter") // → keys page
        await waitFor(async () => (await cap()).includes("getting around"), "keys page")
        await key("Enter") // last page → dismiss, leaving us in sensus
        await waitFor(async () => !(await cap()).includes("welcome to sensus"), "onboarding dismissed")
        // Left in sensus with the SAVED topbar layout (the `l` pick persists
        // past dismissal) + the empty chat.
        await waitFor(
          async () => (await cap()).includes("no messages yet") && (await cap()).includes("1:bash"),
          "left in sensus",
        )
        console.log("[app] init save writes config + boots into sensus with onboarding")
      } finally {
        await outer(["kill-server"])
        try {
          rmSync(home, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    },
    180_000,
  )

  test(
    "first run: a plain sensus opens the setup wizard (no `init` needed) and Esc asks before leaving",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "sensus-app-firstrun-"))
      const sensusHome = join(home, "home")
      const configFile = join(sensusHome, "config.json")
      try {
        const start = await outer(
          bootSessionArgv(
            "appfirstrun",
            `env SHELL=/bin/bash SENSUS_SKIP=1 SENSUS_HOME=${sensusHome} SENSUS_RUNTIME_DIR=${sensusHome}/daemon-runtime bun run src/index.tsx; echo "EXIT=$?"; sleep 60`,
          ),
        )
        expect(start.code).toBe(0)
        const cap = (): Promise<string> => capT("appfirstrun:0")
        const key = (k: string): Promise<void> => h.keyTo("appfirstrun:0", k)
        const waitFor = (p: () => boolean | Promise<boolean>, label: string, timeoutMs = 15000): Promise<void> =>
          h.waitFor(p, label, { timeoutMs, dump: cap })

        // No config at all: the setup modal opens over the live UI by itself
        // (first-run guidance without a separate `sensus init`).
        await waitFor(async () => (await cap()).includes("sensus setup — theme"), "setup auto-opens on first run", 25000)
        // Leaving asks first — the dialog explains settings/config.json stay editable.
        await key("Escape")
        await waitFor(async () => (await cap()).includes("exit setup?"), "exit confirmation appears")
        await waitFor(async () => (await cap()).includes("Ctrl+O"), "confirm names the settings screen")
        await key("Enter") // Enter stays in setup (the safe default)
        await waitFor(async () => (await cap()).includes("sensus setup — theme"), "Enter stays in setup")
        let wrote = false
        try {
          readFileSync(configFile)
          wrote = true
        } catch {
          // nothing written
        }
        expect(wrote).toBe(false)
        console.log("[app] first run auto-opens setup + Esc confirm stays")
      } finally {
        await outer(["kill-server"])
        try {
          rmSync(home, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    },
    180_000,
  )

  test(
    "sessions overlay: infinite scroll reveals older rows, Enter opens a resumed new tab",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "sensus-app-sessions-"))
      const sensusHome = join(home, "home")
      writeSmokeConfig(sensusHome, { layout: "topbar" })
      // 55 seeded transcripts: page 1 (50) stops before the oldest, so paging
      // is observable by pressing End.
      const seedDir = join(sensusHome, "sessions", "seed")
      mkdirSync(seedDir, { recursive: true })
      for (let n = 1; n <= 55; n++) {
        const id = String(n).padStart(3, "0")
        writeFileSync(
          join(seedDir, `tab-${id}.jsonl`),
          [
            JSON.stringify({ ts: n * 1000, type: "session_start", sensus: "sensus" }),
            JSON.stringify({ ts: n * 1000 + 1, type: "user_message", content: `seed session ${id} marker` }),
            JSON.stringify({ ts: n * 1000 + 2, type: "assistant_message", content: `seed reply ${id}`, model: "m" }),
          ].join("\n") + "\n",
        )
      }

      try {
        const start = await outer(
          bootSessionArgv(
            "appsessions",
            appBootCommand({
              sensusHome,
              bootLog: `/tmp/sensus/app-sessions-${process.pid}.stderr.log`,
              env: "SENSUS_MOCK=1",
            }),
          ),
        )
        expect(start.code).toBe(0)
        const cap = (): Promise<string> => capT("appsessions:0")
        const key = (k: string): Promise<void> => h.keyTo("appsessions:0", k)
        const typ = (t: string): Promise<void> => h.typeTo("appsessions:0", t)
        const waitFor = (p: () => boolean | Promise<boolean>, label: string, timeoutMs = 15000): Promise<void> =>
          h.waitFor(p, label, { timeoutMs, dump: cap })

        await waitFor(async () => (await cap()).includes("no messages yet"), "boot")
        await key("BTab")
        await waitFor(async () => (await cap()).includes("input ●"), "focus sidebar")
        await typ("/sessions")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("session search"), "session search opens")
        await waitFor(async () => (await cap()).includes("seed/tab-055"), "page 1 lists recent seeds")
        expect(await cap()).not.toContain("seed/tab-001")
        // Infinite scroll: End at the bottom fetches the next offset page.
        await key("End")
        await waitFor(async () => (await cap()).includes("seed/tab-001"), "older page loads")
        await key("End") // now jump to the true oldest row
        await waitFor(async () => (await cap()).includes("seed/tab-001 · "), "oldest row selected")
        // Enter attaches in a NEW tab, resuming the transcript.
        await key("Enter")
        await waitFor(async () => (await cap()).includes("2:seed session 001"), "new tab opened")
        await waitFor(async () => (await cap()).includes("seed session 001 marker"), "resumed transcript shown")
        console.log("[app] sessions overlay pages + Enter opens a resumed tab")
      } finally {
        await outer(["kill-server"])
        try {
          rmSync(home, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    },
    120_000,
  )

  test(
    "sessions overlay: Del asks to delete, refuses a live tab, then unlinks a picked transcript",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "sensus-app-sessiondel-"))
      const sensusHome = join(home, "home")
      writeSmokeConfig(sensusHome, { layout: "topbar" })
      // One seeded transcript older than the live tab's own session, so the
      // recents list is [live tab-1, del/tab-1].
      const seedPath = join(sensusHome, "sessions", "del", "tab-1.jsonl")
      mkdirSync(join(sensusHome, "sessions", "del"), { recursive: true })
      writeFileSync(
        seedPath,
        [
          JSON.stringify({ ts: 1_000_000, type: "session_start", sensus: "sensus" }),
          JSON.stringify({ ts: 1_000_001, type: "user_message", content: "uniquedeleteme marker" }),
        ].join("\n") + "\n",
      )

      try {
        const start = await outer(
          bootSessionArgv(
            "appsessiondel",
            appBootCommand({
              sensusHome,
              bootLog: `/tmp/sensus/app-sessiondel-${process.pid}.stderr.log`,
              env: "SENSUS_MOCK=1",
            }),
          ),
        )
        expect(start.code).toBe(0)
        const cap = (): Promise<string> => capT("appsessiondel:0")
        const key = (k: string): Promise<void> => h.keyTo("appsessiondel:0", k)
        const typ = (t: string): Promise<void> => h.typeTo("appsessiondel:0", t)
        // tmux/keyTo may not know "Delete"; send the raw ESC [ 3 ~ (0x1b 0x5b 0x33 0x7e).
        const del = (): Promise<void> => h.sendHexTo("\x1b[3~", "appsessiondel:0")
        const waitFor = (p: () => boolean | Promise<boolean>, label: string, timeoutMs = 15000): Promise<void> =>
          h.waitFor(p, label, { timeoutMs, dump: cap })

        await waitFor(async () => (await cap()).includes("no messages yet"), "boot")
        await key("BTab")
        await waitFor(async () => (await cap()).includes("input ●"), "focus sidebar")
        // An empty tab no longer creates a transcript (docs/sessions.md "Empty
        // sessions are not stored"), so send one message to make the live tab a
        // deletable-looking session that the overlay must refuse to unlink.
        await typ("live delete guard")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("MOCKREPLY-OK"), "live tab reply")
        await waitFor(async () => (await cap()).includes("✱ copilot"), "live reply settled")
        await typ("/sessions")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("session search"), "session search opens")
        await waitFor(async () => (await cap()).includes("del/tab-1"), "seed listed")

        // 1. Index 0 is the live tab's own session: deleting it is refused.
        await del()
        await waitFor(async () => (await cap()).includes("y confirm"), "delete confirm shown")
        await key("y")
        await waitFor(async () => (await cap()).includes("open in a tab"), "live session delete refused")
        expect(existsSync(seedPath)).toBe(true)

        // 2. `n` cancels the confirm and removes nothing.
        await key("j") // move to the older seeded row
        await waitFor(async () => (await cap()).includes("del/tab-1 · "), "seed row highlighted")
        await del()
        await waitFor(async () => (await cap()).includes("y confirm"), "seed delete confirm shown")
        await key("n")
        await waitFor(async () => !(await cap()).includes("y confirm"), "cancel closes the confirm")
        expect(existsSync(seedPath)).toBe(true)
        await waitFor(async () => (await cap()).includes("del/tab-1"), "seed still listed")

        // 3. `y` confirms: the transcript is unlinked and the row disappears.
        await del()
        await waitFor(async () => (await cap()).includes("y confirm"), "seed delete confirm again")
        await key("y")
        await waitFor(async () => (await cap()).includes("deleted session"), "delete toast")
        await waitFor(async () => !(await cap()).includes("del/tab-1"), "seed row gone")
        expect(existsSync(seedPath)).toBe(false)
        console.log("[app] sessions overlay deletes a picked transcript (Del -> y), refuses live tabs")
      } finally {
        await outer(["kill-server"])
        try {
          rmSync(home, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    },
    120_000,
  )

  test(
    "prefix mode: hint, non-d pass-through to pane, timeout, chat-focus cancel",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "sensus-app-prefix-"))
      writeSmokeConfig(home, { layout: "topbar" })
      const launchScript = `/tmp/sensus/app-launch-p-${process.pid}.sh`
      const bootLog = `/tmp/sensus/app-boot-p-${process.pid}.stderr.log`
      writeFileSync(
        launchScript,
        [
          "#!/bin/bash",
          `cd ${REPO_ROOT}`,
          `exec env SHELL=/bin/bash SENSUS_SKIP=1 SENSUS_HOME=${home} SENSUS_RUNTIME_DIR=${home}/daemon-runtime SENSUS_MOCK=1 SENSUS_DEBUG=1 bun run src/index.tsx "$@" 2>>${bootLog}`,
        ].join("\n") + "\n",
        { mode: 0o755 },
      )
      const cap = (): Promise<string> => capT("appp:0")
      const prefixThen = async (target: string, k: string): Promise<void> => {
        await h.keyTo(target, "C-a")
        await h.keyTo(target, k)
      }
      try {
        await outer([
          "new-session", "-d", "-x", "200", "-y", "50", "-s", "appp", "-c", REPO_ROOT,
          `bash ${launchScript}; echo "APP-EXIT-CODE=$?"; sleep 240`,
        ])
        await h.waitFor(async () => (await cap()).includes("tab 1: bash") && (await cap()).includes("no messages yet"), "boot P")

        // 1. Prefix opens the hint; a non-d key goes through as C-a + key.
        await h.typeTo("appp:0", "1234567890")
        await prefixThen("appp:0", "x")
        await h.waitFor(async () => (await cap()).includes("x1234567890"), "prefix+x reaches pane", { timeoutMs: 6000 })
        expect((await cap()).includes("APP-EXIT-CODE")).toBe(false)
        console.log("[app] prefix: C-a x routed to pane")
        await h.keyTo("appp:0", "C-c")
        await Bun.sleep(300)

        // 2. Hint appears, then the timeout sends the bare C-a: "ABC"+C-a+Z.
        await h.typeTo("appp:0", "ABC")
        await h.keyTo("appp:0", "C-a")
        await h.waitFor(async () => (await cap()).includes("prefix…"), "prefix hint visible", { timeoutMs: 3000, stepMs: 25 })
        await h.waitFor(async () => !(await cap()).includes("prefix…"), "prefix hint gone (timeout)", { timeoutMs: 4000, stepMs: 25 })
        await h.typeTo("appp:0", "Z")
        await h.waitFor(async () => (await cap()).includes("ZABC"), "timeout delivered bare C-a", { timeoutMs: 6000 })
        expect((await cap()).includes("APP-EXIT-CODE")).toBe(false)
        console.log("[app] prefix: hint shown, timeout sends bare C-a")
        await h.keyTo("appp:0", "C-c")
        await Bun.sleep(300)

        // 3. Chat focus: C-a arms the hint; a non-d key cancels + edits.
        await h.keyTo("appp:0", "BTab")
        await h.waitFor(async () => (await cap()).includes(CHAT_FOCUS), "focus sidebar", { timeoutMs: 5000 })
        await h.keyTo("appp:0", "C-a")
        await h.waitFor(async () => (await cap()).includes("prefix…"), "prefix hint in chat", { timeoutMs: 3000, stepMs: 25 })
        await h.typeTo("appp:0", "q")
        await h.waitFor(async () => !(await cap()).includes("prefix…"), "hint canceled by chat key", { timeoutMs: 4000, stepMs: 25 })
        await h.waitFor(async () => /│\s*q/.test(await cap()), "chat draft got the q", { timeoutMs: 4000 })
        expect((await cap()).includes("tab 1: bash")).toBe(true)
        expect((await cap()).includes("APP-EXIT-CODE")).toBe(false)
        console.log("[app] prefix: chat-focus pass-through cancels cleanly")
      } finally {
        try {
          // The chat draft holds the "q" — send it so the placeholder can
          // mark the focus flip back to the terminal for the clean exit.
          await h.keyTo("appp:0", "Enter")
          await Bun.sleep(400)
          await h.keyTo("appp:0", "BTab")
          await h.waitFor(async () => !(await cap()).includes(CHAT_FOCUS), "back to terminal", { timeoutMs: 5000 })
          await h.typeTo("appp:0", "exit")
          await h.keyTo("appp:0", "Enter")
          // The outer pane outlives the app (`sleep 240`), so the launcher's
          // exit-code echo is the app-gone proof; the sandbox scan catches a
          // lingering app/PTY.
          await h.waitFor(async () => (await cap()).includes("APP-EXIT-CODE=0"), "prefix boot cleaned up", {
            timeoutMs: 10000,
          })
          await expectNoStrayProcesses(home)
        } catch (e) {
          console.log("[app] prefix teardown fallback", e)
        }
        try {
          rmSync(home, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    },
    180_000,
  )

  test(
    "layout sidebar: vertical rail boots, tabs stack, settings toggle flips to topbar + persists",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "sensus-app-rail-"))
      const sensusHome = join(home, "home")
      const configFile = join(sensusHome, "config.json")
      // Seed `layout: "sidebar"` so the boot exercises the vertical rail
      // (docs/DESIGN.md "Tab rail") instead of the default top bar.
      writeSmokeConfig(sensusHome, { layout: "sidebar", tabs: { width: 24 } })
      try {
        const start = await outer(
          bootSessionArgv(
            "apprail",
            appBootCommand({
              sensusHome,
              bootLog: `/tmp/sensus/app-rail-${process.pid}.stderr.log`,
              env: "SENSUS_MOCK=1",
            }),
          ),
        )
        expect(start.code).toBe(0)
        const cap = (): Promise<string> => capT("apprail:0")
        const key = (k: string): Promise<void> => h.keyTo("apprail:0", k)
        const waitFor = (p: () => boolean | Promise<boolean>, label: string, timeoutMs = 15000): Promise<void> =>
          h.waitFor(p, label, { timeoutMs, dump: cap })

        // 1. The rail replaces the top bar: the ` tabs ` card, the pinned
        //    ` + new tab` / ` ? commands` rows, and the terminal/chat all
        //    render on one frame.
        await waitFor(async () => {
          const out = await cap()
          return (
            out.includes(" tabs ") &&
            out.includes(" + new tab") &&
            out.includes(" ? commands") &&
            out.includes("no messages yet")
          )
        }, "sidebar rail boots")
        // Row 0 is the rail's top border, NOT the horizontal bar's row-0 strip
        // (whose right-aligned ` ? commands` button is the tell).
        const firstRow = (await cap()).split("\n")[0] ?? ""
        expect(firstRow).toContain(" tabs ")
        expect(firstRow).not.toContain(" ? commands")
        console.log("[app] layout sidebar: rail boots (top bar gone)")

        // 2. A new tab stacks top-down as a second rail row.
        await key("C-t")
        await waitFor(async () => (await cap()).includes("2:bash"), "second tab listed in the rail")
        console.log("[app] layout sidebar: tabs stack top-down")

        // 3. Settings -> Appearance -> cycle `layout` back to topbar. The
        //    switch is LIVE (the rail goes away behind the overlay) and
        //    persisted to config.
        await key("C-o")
        await waitFor(async () => (await cap()).includes("+ add endpoint"), "settings opens")
        await key("Tab") // detail pane -> rail
        await key("Down")
        await key("Down")
        await key("Down") // Endpoints -> Model -> Agent -> Appearance
        await key("Enter") // open Appearance (focuses the detail pane)
        await waitFor(async () => (await cap()).includes("settings · Appearance"), "appearance view")
        await key("Down")
        await key("Down") // theme -> chat sidebar width -> layout
        await waitFor(async () => (await cap()).includes("layout: sidebar"), "layout row shows the seeded mode")
        await key("Enter") // cycle sidebar -> topbar (applies live + persists)
        // The topbar now carries the same ` + new tab` / ` ? commands` labels,
        // so the rail-specific tell is its ` tabs ` card title.
        await waitFor(async () => !(await cap()).includes(" tabs "), "rail gone live after toggling to topbar")
        await waitFor(
          () => readFileSync(configFile, "utf8").includes('"layout": "topbar"'),
          "layout persisted",
          8000,
        )
        console.log("[app] layout sidebar: settings toggle flips live + persists")
      } finally {
        await outer(["kill-server"])
        try {
          rmSync(home, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    },
    120_000,
  )

  test("nest guard: SENSUS_ACTIVE=1 refuses, SENSUS_SKIP=1 boots", async () => {
    // Refusal: a nested boot with SENSUS_ACTIVE set exits with the documented
    // message (stderr to a file — a stdout redirect breaks opentui tty sizing).
    const home = mkdtempSync(join(tmpdir(), "sensus-app-nest-"))
    const stderrLog = "/tmp/sensus/app-nest-refuse.stderr.log"
    try {
      rmSync(stderrLog, { force: true })
    } catch {
      // ignore
    }
    const refuse = await h.sh(
      ["bash", "-c", `SENSUS_ACTIVE=1 SENSUS_HOME=${home}/home bun run src/index.tsx 2>>${stderrLog}`],
      { cwd: REPO_ROOT, timeoutMs: 15000 },
    )
    expect(refuse.code).not.toBe(0)
    const err = await Bun.file(stderrLog).text()
    expect(err).toContain("inside sensus")
    console.log("[app] nest guard refuses inside sensus")

    // Override: SENSUS_SKIP=1 boots the real UI (a plain boot, no setup modal:
    // the smoke harness sets SENSUS_NO_SETUP).
    const skipHome = join(home, "skip-home")
    mkdirSync(skipHome, { recursive: true })
    const start = await outer(
      bootSessionArgv(
        "appnest",
        appBootCommand({ sensusHome: skipHome, bootLog: "/tmp/sensus/app-nest-skip.stderr.log", env: "SENSUS_ACTIVE=1" }),
      ),
    )
    expect(start.code).toBe(0)
    await h.waitFor(async () => (await capT("appnest:0")).includes("no messages yet"), "SENSUS_SKIP override boots", { timeoutMs: 15000 })
    await h.typeTo("appnest:0", "exit")
    await h.keyTo("appnest:0", "Enter")
    await h.waitFor(async () => (await outer(["has-session", "-t", "appnest"])).code !== 0, "nest boot clean exit", { timeoutMs: 10000 })
    await Bun.sleep(300)
    console.log("[app] SENSUS_SKIP=1 boots the real UI")
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }, 60_000)
})

const outerWithInput = h.outerWithInput
