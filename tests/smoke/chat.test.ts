/**
 * Chat smoke (dogfood pattern from AGENTS.md): the AGENT half of the app in
 * tmux — chat streaming, slash autocomplete, the command palette, agent
 * switching, tool approvals, MCP — against the mock provider / mock OpenAI
 * SSE server. The shell half (tabs, scrollback, vim, prefix) lives in
 * app.test.ts; ship/color-fidelity stay dedicated guard files. The app owns no
 * tmux server; the OUTER tmux harness is only the test driver.
 *
 * One boot per scenario group:
 *   1. mock chat (SENSUS_MOCK): stream + slash MENU + command PALETTE +
 *      abort + copy + scroll pin + /clear + --resume   (2 boots)
 *   2. tools over the mock SSE server: approval card, /yolo, edit diff,
 *      approval-batch plan card (approve-all commits), abort, no-tools
 *                                                        (2 boots)
 *   3. agents (docs/agents.md): /agent + Alt+M picker + agent chip + the
 *      posture the provider SEES + clickable chrome     (1 boot)
 *   4. MCP end-to-end (docs/mcp.md) + config `agent` default at boot
 *                                                        (1 boot)
 *
 * All artifacts under /tmp/sensus; SENSUS_HOME sandboxes.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startMockOpenai } from "../mocks/mockOpenai.ts"
import {
  appBootCommand,
  bgCount,
  bootSessionArgv,
  createHarness,
  expectNoStrayProcesses,
  makeWaitChatIdle,
  REPO_ROOT,
  sgrPress,
  sgrRelease,
  sgrWheelSeq,
  stopSandboxDaemon,
  writeSmokeConfig,
  type Harness,
} from "../helpers.ts"

const h: Harness = createHarness({
  sock: `/tmp/sensus/sensus-chat-smoke-${process.pid}.sock`,
  tag: "chat",
  dumpTarget: "chatsmoke:0",
  labelFromPredicate: true,
})

const outer = h.outer
const capT = h.capT
const capET = h.capET

/** Per-boot stderr logs (append; the harness prints them on failure). */
const BOOT_LOG = (session: string): string => `/tmp/sensus/chatboot-${session}.stderr.log`

/** Target state must HOLD across two polls ~250ms apart (AGENTS.md rule). */
async function holdFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  waitFor: (p: () => boolean | Promise<boolean>, l: string, t?: number) => Promise<void>,
  timeoutMs = 8000,
): Promise<void> {
  await waitFor(predicate, label, timeoutMs)
  await Bun.sleep(250)
  await waitFor(predicate, `${label} (hold)`, timeoutMs)
}

/** Count non-empty JSONL lines across all session files (resume checks). */
async function jsonlCount(sessionDir: string): Promise<number> {
  try {
    const proc = Bun.spawn(["bash", "-c", `ls ${sessionDir}/*/*.jsonl 2>/dev/null`], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const files = await new Response(proc.stdout).text()
    await proc.exited
    let n = 0
    for (const f of files.trim().split("\n")) {
      if (!f) continue
      const t = await Bun.file(f).text()
      n += t.split("\n").filter((l) => l.trim().length > 0).length
    }
    return n
  } catch {
    return 0
  }
}

/** Every `user_message` content recorded across the sandbox's session files. */
async function userMessages(sessionDir: string): Promise<string[]> {
  const out: string[] = []
  try {
    const proc = Bun.spawn(["bash", "-c", `cat ${sessionDir}/*/*.jsonl 2>/dev/null`], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line) as { type?: string; content?: unknown }
        if (ev.type === "user_message" && typeof ev.content === "string") out.push(ev.content)
      } catch {
        // corrupt line — docs/sessions.md: skipped on load, ignored here
      }
    }
  } catch {
    // sandbox/session dir not created yet
  }
  return out
}

/** Focus observable: the input title gains a dot when the chat has focus. */
const CHAT_FOCUS = "input ●"

const mock = await startMockOpenai()

afterAll(async () => {
  await mock.close().catch(() => {})
  await h.killServer()
  try {
    rmSync(h.sock, { force: true })
  } catch {
    // tmux 3.6 leaves socket files
  }
})

describe("sensus chat (in-tmux smoke)", () => {
  test(
    "mock chat: stream, slash menu, palette, abort, copy, pin, /clear, resume",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "sensus-chat-smoke-"))
      const sensusHome = join(home, "home")
      // Keep the historical topbar layout: this scenario drives the horizontal
      // tab bar and hard-coded row indices; the rail has its own scenario.
      writeSmokeConfig(sensusHome, { layout: "topbar" })
      const boot = (session: string, extraArgs: string[]): Promise<{ code: number }> =>
        outer(
          bootSessionArgv(
            session,
            appBootCommand({
              sensusHome,
              bootLog: BOOT_LOG(session),
              env: "SENSUS_MOCK=1 SENSUS_MOCK_DELAY=40 SENSUS_DEBUG=1",
              args: extraArgs.join(" ") || undefined,
            }),
          ),
        )

      const wheel = async (up: boolean, times: number): Promise<void> => {
        // Paced: opentui coalesces rapid same-coordinate wheel events.
        for (let i = 0; i < times; i++) {
          await h.sendHexTo(`\x1b[<${up ? 64 : 65};171;20M`, "chatsmoke:0")
          await Bun.sleep(20)
        }
      }

      try {
        const start = await boot("chatsmoke", [])
        expect(start.code).toBe(0)
        const cap = (): Promise<string> => capT("chatsmoke:0")
        const capE = (): Promise<string> => capET("chatsmoke:0")
        const key = (k: string): Promise<void> => h.keyTo("chatsmoke:0", k)
        const typ = (t: string): Promise<void> => h.typeTo("chatsmoke:0", t)
        const bar = async (): Promise<string> => (await cap()).split("\n")[49] ?? ""
        // Two-phase idle wait (AGENTS.md): require the transition INTO
        // `chat:streaming` (miss tolerated), then a DISAPPEARANCE wait that
        // can only pass once truly true — the drain-hold keeps the status
        // until the reveal pour lands, so sends must wait for this.
        const waitChatIdle = makeWaitChatIdle({
          cap,
          waitFor: (p, _label, timeoutMs) => h.waitFor(p, "?", { timeoutMs }),
          probes: 6,
          probeWindowMs: 1200,
        })

        // 1. Boot: chat enabled (key present) + endpoint@model in the bar.
        await h.waitFor(async () => {
          const out = await cap()
          return out.includes("no messages yet") && out.includes("main@gpt-5")
        }, "boot", { timeoutMs: 15000 })
        console.log("[chat] boot ok")

        // 2. Send a message; mock reply streams in; ctx usage appears.
        await key("BTab")
        await h.waitFor(async () => (await cap()).includes(CHAT_FOCUS), "focus sidebar", { timeoutMs: 5000 })
        await typ("hello smoke")
        await key("Enter")
        await h.waitFor(async () => (await cap()).includes("MOCKREPLY-OK"), "mock reply", { timeoutMs: 15000 })
        expect((await cap()).includes("❯ you")).toBe(true)
        // Settled label: the reveal drain holds the display until the reply
        // has visually landed — wait for the `✱` swap before moving on.
        await h.waitFor(async () => (await cap()).includes("✱ copilot"), "settled label", { timeoutMs: 5000 })
        await h.waitFor(async () => {
          const s = await cap()
          return !s.includes("chat:streaming") && /\/[0-9]+(\.[0-9]+)?[kM]/.test(s)
        }, "ctx usage", { timeoutMs: 10000 })
        console.log("[chat] mock reply streamed + ctx usage shown")

        // 3. Multiline input: Alt+Enter AND the xterm modifyOtherKeys level-2
        //    Shift+Enter encoding both insert a newline and never send.
        //    Non-kitty terminals (xterm / iTerm2 / macOS Terminal) report
        //    Shift+Enter as the raw `ESC [ 27 ; 2 ; 13 ~` once sensus upgrades
        //    modifyOtherKeys to level 2 (docs/keybindings.md "Gotchas");
        //    injecting those bytes is the e2e stand-in for the terminal's own
        //    encoder. The JSONL proves the whole draft went out as ONE
        //    user_message — a Shift+Enter that SENT instead would split
        //    "line three" into its own message and no record would hold all
        //    three lines.
        await typ("multi line one")
        await key("M-Enter")
        await typ("line two")
        await h.sendHexTo("\x1b[27;2;13~", "chatsmoke:0")
        await typ("line three")
        await key("Enter")
        await h.waitFor(async () => (await cap()).includes("multi line one") && (await cap()).includes("line two") && (await cap()).includes("line three"), "multiline", { timeoutMs: 15000 })
        await waitChatIdle()
        // Exact match: the record must be the three lines separated by the
        // newlines Alt+Enter AND Shift+Enter inserted. A Shift+Enter that SENT
        // would split "line three" off; one that was DROPPED would fuse
        // "line twoline three" — both fail this.
        const multiline = await userMessages(`${sensusHome}/sessions`)
        expect(multiline).toContain("multi line one\nline two\nline three")
        console.log("[chat] alt+enter + modifyOtherKeys shift+enter multiline ok")

        // 4. History recall: Up with empty input recalls the last send.
        await key("Up")
        await h.waitFor(async () => (await cap()).includes(CHAT_FOCUS), "focus sidebar 2", { timeoutMs: 4000 })
        await Bun.sleep(150)
        await typ("X")
        await key("Enter")
        await h.waitFor(async () => (await cap()).includes("line threeX"), "history recall", { timeoutMs: 15000 })
        await waitChatIdle()
        console.log("[chat] history recall ok")

        // 6. Slash AUTOCOMPLETE menu (opaque cardBg panel over messages):
        //    "/" lists the first 6 commands; the panel ADDS bg SGRs vs
        //    dismissed (same draft, same caret). Descriptions are truncated to
        //    the chat width, so assert on stable prefixes (docs/ui.md — the
        //    default sidebar is narrower than the full description text).
        await typ("/")
        await h.waitFor(
          async () => (await cap()).includes("❯ /help") && (await cap()).includes("summarize older history to free"),
          "menu lists first window",
        )
        await h.waitFor(
          async () => (await cap()).includes("show the command list") && !(await cap()).includes("wipe this chat"),
          "window capped at 6 rows",
          { timeoutMs: 30000 },
        )
        const bgWithMenu = bgCount(await capE())
        await key("Escape")
        await h.waitFor(async () => !(await cap()).includes("show the command list"), "menu dismissed", { timeoutMs: 4000 })
        const bgWithoutMenu = bgCount(await capE())
        expect(bgWithoutMenu).toBeGreaterThan(0) // the caret cell (by design)
        expect(bgWithMenu).toBeGreaterThan(bgWithoutMenu)
        // "/cl" filters; Tab completes; the completed command executes.
        await typ("cl")
        await h.waitFor(async () => (await cap()).includes("❯ /clear") && !(await cap()).includes("/help"), "filter to /clear")
        await key("Tab")
        await h.waitFor(async () => (await cap()).includes("/clear") && !(await cap()).includes("wipe this chat"), "Tab completes", { timeoutMs: 4000 })
        await key("Enter")
        await h.waitFor(async () => (await cap()).includes("chat cleared — old session file kept"), "/clear executes")
        // "/m" window (model, models, memory, map, mcp): Down ×4 selects /mcp.
        await typ("/m")
        await h.waitFor(async () => (await cap()).includes("❯ /model"), "/m window")
        await key("Down")
        await key("Down")
        await key("Down")
        await key("Down")
        await h.waitFor(async () => (await cap()).includes("❯ /mcp"), "Down x4 selects /mcp")
        await key("Tab")
        await h.waitFor(async () => !(await cap()).includes("MCP servers status"), "Tab accepts /mcp", { timeoutMs: 4000 })
        await key("Enter")
        await h.waitFor(async () => (await cap()).includes("mcp servers (docs/mcp.md)"), "/mcp executes")
        await h.waitFor(async () => (await cap()).includes("none configured"), "no servers configured")
        // Hybrid Enter: an EXACT command sends even with the menu open.
        await typ("/yolo")
        await h.waitFor(async () => (await cap()).includes("full-auto approval toggle"), "/yolo menu open")
        await key("Enter")
        await h.waitFor(async () => (await bar()).includes("full-auto"), "exact /yolo sends", { timeoutMs: 8000 })
        await typ("/yolo off")
        await key("Enter")
        await h.waitFor(async () => (await bar()).includes("confirm"), "/yolo off restores", { timeoutMs: 8000 })
        // Esc dismisses; a NEW query reopens; C-c clears the draft.
        await typ("/")
        await h.waitFor(async () => (await cap()).includes("❯ /help"), "menu reopens for /")
        await key("Escape")
        await h.waitFor(async () => !(await cap()).includes("show the command list"), "Esc dismisses", { timeoutMs: 4000 })
        await typ("cl")
        await h.waitFor(async () => (await cap()).includes("❯ /clear"), "new query reopens")
        await key("C-c")
        await Bun.sleep(150)
        // Click-to-accept: "/cl" narrows to /clear, click the row.
        await typ("/cl")
        await h.waitFor(async () => (await cap()).includes("❯ /clear"), "menu open for click")
        const row = await h.rowOf("chatsmoke:0", "wipe this chat")
        expect(row).toBeGreaterThanOrEqual(0)
        const col = await h.colOf("chatsmoke:0", row, "/clear")
        expect(col).toBeGreaterThanOrEqual(0)
        await h.sgrClick("chatsmoke:0", col + 1, row)
        await h.waitFor(async () => !(await cap()).includes("wipe this chat"), "click accepts", { timeoutMs: 4000 })
        await key("Enter")
        await h.waitFor(async () => (await cap()).includes("chat cleared — old session file kept"), "clicked /clear executes")
        console.log("[chat] slash menu: filter/complete/navigate/click/hybrid ok")
        await typ("menu flow done")
        await key("Enter")
        await waitChatIdle()

        // 7. Slash commands: /help, unknown error, /model (persist), /yolo.
        await typ("/help")
        await key("Enter")
        await h.waitFor(async () => (await cap()).includes("Esc aborts a reply"), "/help", { timeoutMs: 5000 })
        await typ("/definitely-not-a-cmd")
        await key("Enter")
        await h.waitFor(async () => (await cap()).includes("unknown command"), "unknown cmd", { timeoutMs: 5000 })
        await typ("/model fake/model-9")
        await key("Enter")
        await h.waitFor(async () => (await bar()).includes("fake/model-9"), "/model applies", { timeoutMs: 5000 })
        await typ("/model gpt-5")
        await key("Enter")
        await h.waitFor(async () => (await bar()).includes("gpt-5") && !(await bar()).includes("fake/model-9"), "/model back", { timeoutMs: 5000 })
        console.log("[chat] slash commands ok")


        // 8. Command PALETTE (Ctrl+P): rows + binding hints + live suffix.
        await key("C-p")
        await h.waitFor(async () => (await cap()).includes("type to filter") && (await cap()).includes("Open settings"), "palette opens")
        expect(await cap()).toContain("Model catalog")
        expect(await cap()).toContain("Reload config")
        expect(await cap()).toContain("Agent picker")
        expect(await cap()).toContain("Close tab")
        expect(await cap()).toContain("ctrl+o")
        expect(await cap()).toContain("alt+m")
        expect(await cap()).toContain("/models")
        expect(await cap()).toContain("now: confirm")
        // Type-to-filter (disappearance wait): "catalog" matches ONLY the
        // model-catalog row (labels AND descriptions are filtered).
        await typ("catalog")
        await h.waitFor(async () => !(await cap()).includes("Open settings"), "palette filter narrows", { timeoutMs: 4000 })
        expect(await cap()).toContain("Model catalog")
        for (let i = 0; i < 7; i++) await key("BSpace")
        await h.waitFor(async () => (await cap()).includes("Open settings"), "backspace restores", { timeoutMs: 4000 })
        // Enter runs toggle-approval: bar flips to full-auto, menu closes.
        await typ("appro")
        await h.waitFor(async () => !(await cap()).includes("Open settings"), "filter appro", { timeoutMs: 4000 })
        await key("Enter")
        await holdFor(async () => (await bar()).includes("full-auto") && !(await cap()).includes("type to filter"), "toggle-approval ran", (p, l, t) => h.waitFor(p, l, { timeoutMs: t }))
        // Reopen: the approval row shows the LIVE suffix.
        await key("C-p")
        await h.waitFor(async () => (await cap()).includes("type to filter"), "palette reopens")
        expect(await cap()).toContain("now: full-auto")
        await key("Escape")
        await h.waitFor(async () => !(await cap()).includes("type to filter"), "Esc closes palette", { timeoutMs: 4000 })
        // The palette opens the settings screen (overlay replaces overlay).
        await key("C-p")
        await h.waitFor(async () => (await cap()).includes("type to filter"), "palette reopens 2")
        await typ("sett")
        await h.waitFor(async () => (await cap()).includes("Open settings"), "settings row surfaced")
        await key("Enter")
        // "+ add endpoint" is unique to the settings overlay (the /help
        // bubble's "/settings settings screen" row also contains " settings ").
        await h.waitFor(async () => (await cap()).includes("+ add endpoint") && !(await cap()).includes("type to filter"), "settings via palette")
        // VIEW TREE: Esc pops Settings back to the palette that opened it.
        await key("Escape")
        await h.waitFor(async () => (await cap()).includes("type to filter") && !(await cap()).includes("+ add endpoint"), "Esc returns to the palette")
        // A second Esc closes the palette itself.
        await key("Escape")
        await h.waitFor(async () => !(await cap()).includes("type to filter"), "palette closed", { timeoutMs: 4000 })
        // Palette help runs the real slash path.
        await key("C-p")
        await h.waitFor(async () => (await cap()).includes("type to filter"), "palette reopens 3")
        await typ("help")
        await key("Enter")
        // The help bubble is now taller than the viewport, so assert a stable
        // FOOTER line (the top "Sensus chat commands" heading scrolls off).
        await h.waitFor(async () => (await cap()).includes("Ctrl+O opens /settings"), "palette /help")
        await h.waitFor(async () => !(await cap()).includes("type to filter"), "palette closed after help", { timeoutMs: 4000 })
        console.log("[chat] command palette ok")
        await typ("/yolo off")
        await key("Enter")
        await h.waitFor(async () => (await bar()).includes("confirm"), "confirm restored", { timeoutMs: 8000 })

        // 9. Esc aborts a streaming reply; partial reply kept + marked.
        await typ("explain: abortme")
        await key("Enter")
        await Bun.sleep(500)
        await key("Escape")
        await h.waitFor(async () => (await cap()).includes("aborted"), "abort marker", { timeoutMs: 10000 })
        await waitChatIdle()
        console.log("[chat] esc abort ok")

        // 10. Terminal keeps working while a reply streams.
        await typ("explain: parallel")
        await key("Enter")
        await key("BTab")
        await h.waitFor(async () => !(await cap()).includes(CHAT_FOCUS), "terminal focus", { timeoutMs: 5000 })
        await typ("echo CHATSMOKE-PARALLEL")
        await key("Enter")
        await h.waitFor(async () => (await cap()).includes("CHATSMOKE-PARALLEL"), "parallel echo", { timeoutMs: 8000 })
        await key("BTab")
        await h.waitFor(async () => (await cap()).includes(CHAT_FOCUS), "sidebar refocus", { timeoutMs: 5000 })
        await waitChatIdle()
        console.log("[chat] terminal usable alongside chat")

        // 10b. modifyOtherKeys level-2 pane regression (docs/terminal-layer.md
        //      "Input & focus"). Sensus asks xterm/iTerm2 for level 2 at boot,
        //      which changes how ALL modified keys are encoded; OpenTUI parses
        //      the CSI 27;mod;code~ form and re-encodes it for the embedded
        //      PTY. Verify the path end-to-end (not just at the parser): a
        //      Ctrl+letter and Tab must still land in the pane, and Enter must
        //      still submit. `AB` + Left + modifyOtherKeys Ctrl+E + `C` runs
        //      `ABC`: Ctrl+E (0x05) must move readline to end-of-line, so the
        //      line is `ABC`, NOT `ACB` (dropped/double-encoded/literal).
        await key("BTab")
        await h.waitFor(async () => !(await cap()).includes(CHAT_FOCUS), "terminal focus (modifyOtherKeys probe)", { timeoutMs: 5000 })
        await typ("AB")
        await key("Left")
        await h.sendHexTo("\x1b[27;5;101~", "chatsmoke:0")
        await typ("C")
        await key("Enter")
        await h.waitFor(async () => (await cap()).includes("ABC: command not found"), "Ctrl+E reaches the pane as 0x05", { timeoutMs: 8000 })
        expect((await cap()).includes("ACB")).toBe(false)
        // Tab still reaches the pane (unmodified under level 2): `cat -A`
        // renders the raw byte as `^I`, which no literal-forward could produce.
        await typ("cat -A")
        await key("Enter")
        await Bun.sleep(300)
        await key("Tab")
        await typ("TABPROBE")
        await key("Enter")
        await h.waitFor(async () => (await cap()).includes("^ITABPROBE"), "Tab reaches the pane", { timeoutMs: 8000 })
        await key("C-c")
        await key("BTab")
        await h.waitFor(async () => (await cap()).includes(CHAT_FOCUS), "sidebar refocus after modifyOtherKeys probe", { timeoutMs: 5000 })
        console.log("[chat] modifyOtherKeys level-2 pane regression ok (ctrl+e + tab + enter)")

        // 11. Wheel scroll pins the view; appends don't yank; wheel down
        //     re-arms the sticky follow. Rows compared BELOW the toast
        //     region (rows 1-3) by ROW INDEX (capture rows are trimmed).
        await typ("explain: fillview")
        await key("Enter")
        await waitChatIdle()
        await wheel(true, 8)
        const scrolledUp = await cap()
        await typ("while scrolled up")
        await key("Enter")
        await waitChatIdle()
        const pinned = await cap()
        expect(pinned.split("\n").slice(3, 5)).toEqual(scrolledUp.split("\n").slice(3, 5))
        await wheel(false, 14)
        await h.waitFor(async () => (await cap()).includes("while scrolled up"), "sticky re-grab", { timeoutMs: 8000 })
        console.log("[chat] scroll pin + sticky re-grab ok")

        // 11b. Jump-to-latest: scroll up, append a message (the view stays
        //      unpinned), then End with an empty draft snaps to the newest
        //      message without wheeling all the way back.
        await wheel(true, 8)
        await typ("jump target")
        await key("Enter")
        await waitChatIdle()
        await key("End")
        await h.waitFor(async () => (await cap()).includes("jump target"), "End jumps to latest", { timeoutMs: 8000 })
        console.log("[chat] End jump-to-latest ok")

        // 11c. Keyboard paging: PgUp reaches the first message; PgDn returns.
        //      Pace the presses: a burst of keys can coalesce into one effect
        //      run (the scroll request is a signal), which would page once.
        for (let i = 0; i < 40; i++) {
          await key("PageUp")
          await Bun.sleep(25)
        }
        await h.waitFor(async () => (await cap()).includes("menu flow done"), "PgUp reaches the top", { timeoutMs: 10000 })
        for (let i = 0; i < 40; i++) {
          await key("PageDown")
          await Bun.sleep(25)
        }
        await h.waitFor(async () => !(await cap()).includes("menu flow done"), "PgDn pages back down", { timeoutMs: 10000 })
        console.log("[chat] PgUp/PgDn paging ok")

        // 11d. Scrollbar: on overflow the thumb is visible; dragging it to the
        //      top jumps the transcript to the first message (then End returns).
        const findThumb = async (): Promise<{ x: number; y: number } | null> => {
          const lines = (await cap()).split("\n")
          const blocks = "█▀▄▌▐"
          for (let y = 0; y < lines.length; y++) {
            const line = lines[y] ?? ""
            // The scrollbar is the column just inside the chat card's right
            // padding; the card's `│` border is the last cell on the row. The
            // message panels paint block glyphs too, so scan ONLY that column.
            if (!line.endsWith("│")) continue
            const x = line.length - 3
            if (blocks.includes(line[x] ?? "")) return { x, y }
          }
          return null
        }
        await key("End")
        await h.waitFor(async () => (await cap()).includes("jump target"), "bottom before drag", { timeoutMs: 8000 })
        const thumb = await findThumb()
        expect(thumb).not.toBeNull()
        const tx = thumb!.x
        await h.sendHexTo(sgrPress(tx, thumb!.y), "chatsmoke:0")
        await Bun.sleep(150)
        // button-1 drag motion (SGR 32) up the track, then release.
        await h.sendHexTo(`\x1b[<32;${tx + 1};5M`, "chatsmoke:0")
        await Bun.sleep(150)
        await h.sendHexTo(`\x1b[<32;${tx + 1};3M`, "chatsmoke:0")
        await Bun.sleep(150)
        await h.sendHexTo(sgrRelease(tx, 2), "chatsmoke:0")
        // Dragging the thumb scrolls the transcript away from the pinned bottom;
        // the newest message leaves the viewport.
        await h.waitFor(async () => !(await cap()).includes("jump target"), "scrollbar drag scrolls up", { timeoutMs: 8000 })
        await key("End")
        await h.waitFor(async () => (await cap()).includes("jump target"), "End restores after drag", { timeoutMs: 8000 })
        console.log("[chat] scrollbar drag ok")

        // 12. Per-message copy affordance: clicking `⧉ copy` emits the RAW
        //     message text as OSC52 on the pane output (pipe-pane hook) and
        //     raises the toast.
        const oscCopyLog = "/tmp/sensus/osc52-copy-message.log"
        try {
          rmSync(oscCopyLog, { force: true })
        } catch {
          // ignore
        }
        await outer(["pipe-pane", "-o", "-t", "chatsmoke:0", `dd of=${oscCopyLog} bs=1 status=none`])
        const clickCopy = async (): Promise<void> => {
          const lines = (await cap()).split("\n")
          let target = -1
          let col = 0
          for (let y = 0; y < lines.length; y++) {
            const line = lines[y] ?? ""
            if (line.includes("⧉ copy")) {
              target = y
              col = line.indexOf("⧉ copy") + 3
            }
          }
          if (target < 0) throw new Error("no ⧉ copy affordance visible")
          await h.sendHexTo(sgrPress(col, target), "chatsmoke:0")
          await h.sendHexTo(sgrRelease(col, target), "chatsmoke:0")
        }
        await clickCopy()
        await h.waitFor(async () => (await cap()).includes("copied to clipboard"), "copy toast", { timeoutMs: 4000 })
        await h.waitFor(
          async () => {
            let payload = ""
            try {
              const m = (await Bun.file(oscCopyLog).text()).match(/\]52;c;([A-Za-z0-9+/=]+)/)
              if (m !== null) payload = Buffer.from(m[1]!, "base64").toString("utf8")
            } catch {
              // file not created yet
            }
            const screen = (await cap()).replace(/\s+/g, "")
            let inJsonl = false
            if (payload.length > 0) {
              const proc = Bun.spawn(["bash", "-c", `cat ${sensusHome}/sessions/*/*.jsonl 2>/dev/null`], {
                stdout: "pipe",
                stderr: "ignore",
              })
              const transcript = await new Response(proc.stdout).text()
              await proc.exited
              inJsonl = transcript.includes(JSON.stringify(payload).slice(1, -1))
            }
            const ok = payload.length > 0 && (screen.includes(payload.replace(/\s+/g, "")) || inJsonl)
            if (!ok) {
              await Bun.sleep(300)
              await clickCopy().catch(() => {})
              return false
            }
            return true
          },
          "copy payload",
          { timeoutMs: 10000, stepMs: 150 },
        )
        await outer(["pipe-pane", "-t", "chatsmoke:0"])
        console.log("[chat] message copy button → OSC52 ok")

        // 12b. Rewind: `↺ revert` on a user message drops it and everything
        //      after it and reloads its text into the input. Nothing streams
        //      here, so it applies on the first click (no confirm).
        await key("End")
        await h.waitFor(async () => (await cap()).includes("jump target"), "revert target on screen", { timeoutMs: 8000 })
        const clickRevert = async (): Promise<boolean> => {
          const lines = (await cap()).split("\n")
          for (let y = lines.length - 1; y >= 0; y--) {
            const at = (lines[y] ?? "").indexOf("↺ revert")
            if (at >= 0) {
              const col = at + 3
              await h.sendHexTo(sgrPress(col, y), "chatsmoke:0")
              await h.sendHexTo(sgrRelease(col, y), "chatsmoke:0")
              return true
            }
          }
          return false
        }
        expect(await clickRevert()).toBe(true)
        await h.waitFor(async () => (await cap()).includes("rewound"), "rewind toast", { timeoutMs: 4000 })
        // The reverted text now sits in the input; clearing the draft removes
        // it from the screen entirely (proving it left the transcript too).
        await key("C-c")
        await h.waitFor(async () => !(await cap()).includes("jump target"), "reverted turn removed", { timeoutMs: 6000 })
        console.log("[chat] rewind affordance ok")

        // 13. /clear wipes the transcript and rotates the session file.
        const sessionDir = `${sensusHome}/sessions`
        await typ("/clear")
        await key("Enter")
        await h.waitFor(async () => (await cap()).includes("no messages yet"), "/clear wipes", { timeoutMs: 8000 })
        await h.waitFor(async () => (await jsonlCount(sessionDir)) >= 2, "file rotation", { timeoutMs: 8000 })
        await typ("final before exit")
        await key("Enter")
        await h.waitFor(async () => (await cap()).includes("final before exit"), "final message", { timeoutMs: 15000 })
        await waitChatIdle()
        console.log("[chat] /clear + file rotation ok")

        // 14. Exit cleanly, restart with --resume, transcript restores and
        //     appends continue into the SAME file.
        await key("BTab")
        await typ("exit")
        await key("Enter")
        await h.waitFor(async () => (await outer(["has-session", "-t", "chatsmoke"])).code !== 0, "clean exit", { timeoutMs: 10000 })

        const resumed = await boot("chatsmoke2", ["--resume"])
        expect(resumed.code).toBe(0)
        await h.waitFor(async () => (await capT("chatsmoke2:0")).includes("resume a session"), "resume picker", { timeoutMs: 15000 })
        await h.keyTo("chatsmoke2:0", "Enter")
        await h.waitFor(async () => {
          const c = await capT("chatsmoke2:0")
          return c.includes("❯ you") && c.includes("final before exit")
        }, "resume restores", { timeoutMs: 15000 })
        const before = await jsonlCount(sessionDir)
        await h.keyTo("chatsmoke2:0", "BTab")
        await h.typeTo("chatsmoke2:0", "post-resume message")
        await h.keyTo("chatsmoke2:0", "Enter")
        await h.waitFor(async () => (await capT("chatsmoke2:0")).includes("post-resume message"), "post-resume send", { timeoutMs: 15000 })
        await h.waitFor(async () => (await jsonlCount(sessionDir)) > before, "resume appends same file", { timeoutMs: 10000 })
        await h.keyTo("chatsmoke2:0", "BTab")
        await h.typeTo("chatsmoke2:0", "exit")
        await h.keyTo("chatsmoke2:0", "Enter")
        await h.waitFor(async () => (await outer(["has-session", "-t", "chatsmoke2"])).code !== 0, "clean exit 2", { timeoutMs: 10000 })
        console.log("[chat] resume restores + appends ok")
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
    "tools: approval card, /yolo bypass, edit diff, plan card, abort, no-tools",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "sensus-m3-smoke-"))
      const sensusHome = join(home, "home")
      const workDir = join(home, "work")
      mkdirSync(workDir, { recursive: true })
      const editFile = join(workDir, "e2e-edit.txt")
      writeFileSync(editFile, "line-OLD-HERE\n")
      // Real provider against the mock SSE server: the key comes from config
      // (no env fallback — docs/config.md). A FIXED theme so the sudo modal's
      // backdrop is exercised: an opaque backdrop would hide the background,
      // which the adaptive `terminal` theme (bg = null) would not.
      writeSmokeConfig(sensusHome, { layout: "topbar", theme: "dark", endpoints: { main: { apiKey: "smoke-key" } } })

      const boot = (session: string, model: string): Promise<{ code: number }> =>
        outer(
          bootSessionArgv(
            session,
            appBootCommand({
              sensusHome,
              bootLog: BOOT_LOG(session),
              mockUrl: mock.url,
              env: `SENSUS_MODEL=${model} SENSUS_DEBUG=1`,
            }),
          ),
        )

      try {
        // 1. Boot against the REAL HttpProvider talking to the mock SSE server.
        const start = await boot("m3smoke", "mock")
        expect(start.code).toBe(0)
        const cap = (): Promise<string> => capT("m3smoke:0")
        const waitFor = (p: () => boolean | Promise<boolean>, label: string, timeoutMs = 15000): Promise<void> =>
          h.waitFor(p, label, { timeoutMs, dump: cap })
        const key = (k: string): Promise<void> => h.keyTo("m3smoke:0", k)
        const typ = (t: string): Promise<void> => h.typeTo("m3smoke:0", t)
        const waitChatIdle = makeWaitChatIdle({
          cap,
          waitFor: (p, _label, timeoutMs) => waitFor(p, "?", timeoutMs),
          defaultTimeoutMs: 25000,
        })
        await waitFor(async () => {
          const out = await cap()
          return out.includes("no messages yet") && out.includes("main@mock")
        }, "boot", 15000)
        console.log("[chat] tools boot ok (http provider)")

        // 1b. Waiting indicator (docs/agent.md "Streaming display"): while the
        // model is thinking — before its first delta creates the assistant
        // bubble — an animated "Thinking" row stands in for the bubble header.
        // A delayed-first-token model makes that window observable; the only
        // cue used to be the bare streaming caret.
        await key("BTab")
        await waitFor(async () => (await cap()).includes(CHAT_FOCUS), "focus sidebar for lag", 5000)
        await typ("/model lag")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("main@lag"), "/model lag", 5000)
        // `plain:` bypasses the default tool call so the delayed reply streams
        // with no card in the way (a card would suppress the waiting row).
        await typ("plain:LAGPLAIN-OK")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("Thinking"), "waiting indicator", 5000)
        await waitFor(async () => (await cap()).includes("LAGPLAIN-OK"), "lag reply", 20000)
        await waitChatIdle()
        // 1c. The reasoning header is the bubble's ONLY live row (docs/DESIGN.md
        // "Motion"): while the model reasons, the animated `⠋ Thinking` header
        // must not have the animated streaming label's spinner stacked above it.
        // A slow model widens the reasoning window enough to sample it and to
        // click the LIVE header: it must carry the toggle action and expand the
        // reasoning body mid-stream. A `think:` message streams reasoning before
        // the reply (mock).
        await typ("/model slow")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("main@slow"), "/model slow", 5000)
        await typ("think:reasoning-window")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("Thinking"), "active thinking header", 5000)
        // The standalone waiting row (before the first delta creates the bubble)
        // shares the header text but has no action. Wait for the streaming
        // caret, which only the assistant bubble draws, then click the header.
        await waitFor(async () => (await cap()).includes("▌"), "live bubble caret", 5000)
        expect((await cap()).includes("+ Thought")).toBe(false)
        // The live header re-renders every spinner frame; a click can be dropped
        // mid-repaint, so retry until the body appears. Each iteration checks the
        // body BEFORE clicking again, so a success is never toggled back off.
        let liveExpanded = false
        for (let i = 0; i < 10 && !liveExpanded; i++) {
          const row = await h.rowOf("m3smoke:0", "Thinking")
          if (row < 0) break
          const col = await h.colOf("m3smoke:0", row, "Thinking")
          await h.sgrClick("m3smoke:0", col, row)
          await Bun.sleep(120)
          liveExpanded = (await cap()).includes("The user wants the mock reply")
        }
        expect(liveExpanded).toBe(true)
        for (let i = 0; i < 15; i++) {
          const out = await cap()
          // The header is active only until content streams (it then settles to
          // `+ Thought for …`); assert only while it is the live row.
          if (out.includes("Thinking")) expect(out).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] slow · /)
          await Bun.sleep(20)
        }
        await waitFor(async () => (await cap()).includes("PLAINREPLY-OK"), "think reply", 20000)
        await waitChatIdle()
        // Restore the boot model for the tool checks below.
        await typ("/model mock")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("main@mock"), "/model back", 5000)
        // Hand focus back to the terminal (step 2 re-focuses the sidebar).
        await key("BTab")
        console.log("[chat] waiting indicator ok")

        // 2. Approval flow: cmd: -> shell_background card -> y -> output.
        // The command is deliberately longer than the 72-char header peek: a
        // pending card must render it IN FULL (docs/agent.md "Approval modes"),
        // so the tail marker is on screen BEFORE accepting.
        await key("BTab")
        await waitFor(async () => (await cap()).includes(CHAT_FOCUS), "focus sidebar", 5000)
        const longCmd = `echo SENSUS-E2E-42 && echo ${"P".repeat(80)} && echo SENSUS-CMD-TAIL-42`
        await typ(`cmd:${longCmd}`)
        await key("Enter")
        await waitFor(async () => (await cap()).includes("awaiting approval"), "card pending", 15000)
        await waitFor(async () => (await cap()).includes("[y accept]"), "card actions", 5000)
        expect((await cap()).includes("SENSUS-CMD-TAIL-42")).toBe(true)
        // Terminal stays usable while the card waits.
        await key("BTab")
        await waitFor(async () => !(await cap()).includes(CHAT_FOCUS), "terminal focus", 5000)
        await typ("echo TERMINAL-ALIVE")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("TERMINAL-ALIVE"), "terminal alive", 8000)
        await key("BTab")
        await waitFor(async () => (await cap()).includes(CHAT_FOCUS), "sidebar refocus", 5000)
        await key("y")
        await waitFor(async () => (await cap()).includes("● done") && (await cap()).includes("SENSUS-E2E-42"), "tool done + output", 15000)
        await waitFor(async () => (await cap()).includes("TOOLDONE-OK"), "cited reply", 15000)
        await waitFor(async () => /\/[0-9]+(\.[0-9]+)?[kM]/.test(await cap()), "ctx usage", 10000)
        await waitChatIdle()
        expect((await cap()).includes("exit 0")).toBe(true)
        console.log("[chat] approve -> run -> cited -> tokens ok")

        // 3. /yolo bypasses the card entirely.
        await typ("/yolo")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("full-auto"), "yolo on", 5000)
        await typ("cmd: echo YOLO-BYPASS-99")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("YOLO-BYPASS-99") && (await cap()).includes("● done"), "yolo bypass", 15000)
        await waitChatIdle()
        expect((await cap()).includes("awaiting approval")).toBe(false)
        console.log("[chat] /yolo bypass ok")

        // 3b. Sudo popup owns input even with NO overlay open (regression):
        //     in full-auto a hidden sudo command fails for a password, the
        //     popup appears, typed keys reach its masked field, Tab SELECTS
        //     session caching, and Enter submits + retries with sudo -S (a
        //     PATH shim stands in for sudo, so no real privilege is involved).
        const shimDir = join(workDir, "shim")
        mkdirSync(shimDir, { recursive: true })
        // The shim authenticates ONLY via the askpass helper the app creates
        // ($SUDO_ASKPASS) and ONLY with the exact password, so a truncated
        // capture (symbols dropped) or a missing helper fails the test.
        writeFileSync(
          join(shimDir, "sudo"),
          '#!/bin/sh\nfor a in "$@"; do [ "$a" = "-A" ] && { pw=$("$SUDO_ASKPASS"); [ "$pw" = "hu!ter.2" ] && exit 0; echo "sudo: 1 incorrect password attempt" >&2; exit 1; }; done\necho "sudo: a password is required" >&2\nexit 1\n',
          { mode: 0o755 },
        )
        await typ(`cmd:export PATH="${shimDir}:$PATH"; sudo true`)
        await key("Enter")
        await waitFor(async () => (await cap()).includes("sudo password required"), "sudo popup opens", 15000)
        // The modal must not black out the background (docs/DESIGN.md): the
        // status bar peeking out from under the centered card stays visible.
        // A fixed theme's opaque full-screen backdrop would hide it.
        await waitFor(async () => (await cap()).includes("main@mock"), "sudo modal leaves background visible", 5000)
        await typ("hu!ter.2") // symbols must survive exactly
        await waitFor(async () => (await cap()).includes("••••"), "keystrokes reach the masked sudo field", 5000)
        await key("Tab") // SELECT caching for the session (off by default)
        await key("Enter")
        await waitFor(async () => !(await cap()).includes("sudo password required"), "sudo popup submits", 8000)
        await waitFor(async () => (await cap()).includes("TOOLDONE-OK"), "reply after sudo retry", 15000)
        await waitChatIdle()
        console.log("[chat] sudo popup owns input with no overlay open")

        // 3c. Cached for the session (selected with Tab): a SECOND hidden sudo
        //     command reuses the RAM-cached password with NO popup. The unique
        //     outer marker proves the retry actually ran.
        await typ(`cmd:export PATH="${shimDir}:$PATH"; sudo true && echo SECOND-SUDO-DONE`)
        await key("Enter")
        await waitFor(async () => (await cap()).includes("SECOND-SUDO-DONE"), "second sudo reused the cached password", 15000)
        expect((await cap()).includes("sudo password required")).toBe(false)
        await waitChatIdle()
        console.log("[chat] cached sudo password reused without a new popup")

        // 4. edit_file diff card: accept applies the file change.
        await typ("/yolo off")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("confirm"), "confirm restored", 5000)
        await typ("edit:" + editFile + "|line-OLD-HERE|line-NEW-HERE")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("awaiting approval"), "edit card", 15000)
        await waitFor(async () => (await cap()).includes("- line-OLD-HERE"), "diff minus", 5000)
        await waitFor(async () => (await cap()).includes("+ line-NEW-HERE"), "diff plus", 5000)
        await key("y")
        await waitFor(async () => (await cap()).includes("wrote") && (await cap()).includes("e2e-edit.txt"), "edit applied", 15000)
        await waitChatIdle()
        expect((await Bun.file(editFile).text()).includes("line-NEW-HERE")).toBe(true)
        console.log("[chat] edit_file diff applied on accept")

        // 4b. ask_user card (docs/agent.md): the question renders IN FULL with
        // clickable links, options are numbered/clickable, and a custom-answer
        // entry is always appended. A digit picks an option and the loop resumes.
        await typ("ask:Open https://example.com/x to read the docs before choosing|Staging/Production/Canary/Blue-green/Foo")
        await key("Enter")
        // The question renders IN FULL but WRAPPED (docs/agent.md), so at the
        // default chat width the sentence breaks across rows; assert on the
        // pieces rather than one unbroken line.
        await waitFor(
          async () => {
            const out = await cap()
            return out.includes("https://example.com/x") && out.includes("read the docs") && out.includes("before")
          },
          "ask question in full",
          15000,
        )
        await waitFor(async () => (await cap()).includes("[1] Staging"), "ask option 1", 5000)
        await waitFor(async () => (await cap()).includes("[5] Foo"), "ask option 5", 5000)
        await waitFor(async () => (await cap()).includes("type your custom answer in the chat"), "ask custom entry", 5000)
        await key("2")
        await waitFor(
          async () => /TOOLDONE-OK[\s\S]*user answered:[\s\S]*Production/.test(await cap()),
          "ask answered",
          15000,
        )
        await waitChatIdle()
        console.log("[chat] ask_user card: full question, links, options, custom entry ok")

        // 4c. Approval-batch plan card (docs/agent.md "Approval-batch plan
        //     card"): a turn with TWO gated calls in `confirm` mode is presented
        //     as ONE plan, not two cards. Clicking `A approve all` is a
        //     one-step "approve the task": it approves every non-destructive
        //     line AND commits — both commands run WITHOUT a separate confirm.
        await typ("both:echo PLAN-A|echo PLAN-B")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("▸ plan · 2 approvals"), "plan card", 15000)
        await waitFor(async () => (await cap()).includes("[A approve all]"), "approve-all control", 5000)
        // No individual pending card: the plan is the single gate.
        expect((await cap()).includes("awaiting approval")).toBe(false)
        const allRow = await h.rowOf("m3smoke:0", "[A approve all]")
        const allCol = await h.colOf("m3smoke:0", allRow, "[A approve all]")
        await h.sgrClick("m3smoke:0", allCol + 3, allRow)
        // The click commits: both commands run and the reply cites them.
        await waitFor(async () => (await cap()).includes("TOOLDONE-OK"), "batch reply after approve-all click", 15000)
        await waitChatIdle()
        const afterAll = await cap()
        expect(afterAll.includes("exit 0")).toBe(true)
        console.log("[chat] plan card: approve-all click commits the batch in one step")

        // 5. Esc aborts a slow stream cleanly.
        await typ("/model slow")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("slow"), "slow model", 5000)
        await typ("tell me something slow")
        await key("Enter")
        await Bun.sleep(700)
        await key("Escape")
        await waitFor(async () => (await cap()).includes("aborted"), "slow abort", 10000)
        await waitChatIdle()
        console.log("[chat] esc abort (slow) ok")

        // 6. Degradation: endpoint rejects tools -> no-tools mode. The daemon is
        //    shared (one per sandbox), so the second app cannot change the model
        //    via env — set it on THIS chat with `/model` after boot.
        const degraded = await boot("m3notools", "notools-mock")
        expect(degraded.code).toBe(0)
        const cap2 = (): Promise<string> => capT("m3notools:0")
        await waitFor(async () => (await cap2()).includes("no messages yet"), "notools boot", 15000)
        await h.keyTo("m3notools:0", "BTab")
        await waitFor(async () => (await cap2()).includes(CHAT_FOCUS), "notools focus", 5000)
        await h.typeTo("m3notools:0", "/model notools-mock")
        await h.keyTo("m3notools:0", "Enter")
        await waitFor(async () => (await cap2()).includes("main@notools-mock"), "notools model set", 8000)
        await h.typeTo("m3notools:0", "hello there")
        await h.keyTo("m3notools:0", "Enter")
        await waitFor(async () => (await cap2()).includes("PLAINREPLY-OK"), "plain reply", 20000)
        await waitFor(async () => (await cap2()).includes("no-tools"), "degradation marker", 10000)
        await waitFor(async () => (await cap2()).includes("click to paste · double-click to run"), "markdown + code hint", 8000)
        // 6b. Code-line click: a single click PASTES the clicked command into
        //     the pane without running it (and never the whole block); a rapid
        //     second click presses Enter to run it. The mock's fence prints a
        //     marker (`PLAIN-REPLY-OK`) that appears nowhere in the reply text,
        //     so its presence proves the command actually executed.
        const codeRow = await h.rowOf("m3notools:0", "printf 'PLAIN-REPLY")
        expect(codeRow).toBeGreaterThan(0)
        const codeCol = await h.colOf("m3notools:0", codeRow, "printf")
        await h.sgrClick("m3notools:0", codeCol + 2, codeRow)
        await waitFor(async () => (await cap2()).includes("command pasted"), "code line paste toast", 5000)
        expect((await cap2()).includes("PLAIN-REPLY-OK")).toBe(false)
        // Let the double-click tracker expire (a click inside the previous
        // click's 400ms window would be read as "run", not a fresh paste),
        // clear the pasted line (terminal focus, no selection -> ^C goes to the
        // pane), then double-click from scratch: paste + Enter in one gesture.
        await Bun.sleep(600)
        await h.keyTo("m3notools:0", "BTab")
        await h.keyTo("m3notools:0", "C-c")
        const doubleClick = sgrPress(codeCol + 2, codeRow) + sgrRelease(codeCol + 2, codeRow)
        await h.sendHexTo(`${doubleClick}${doubleClick}`, "m3notools:0")
        await h.waitFor(async () => (await cap2()).includes("PLAIN-REPLY-OK"), "double-click runs the command", { timeoutMs: 8000, dump: cap2 })
        console.log("[chat] code line click: paste + double-click run ok")

        // 7. Clean exits for both sessions.
        await h.keyTo("m3notools:0", "BTab")
        await h.typeTo("m3notools:0", "exit")
        await h.keyTo("m3notools:0", "Enter")
        await waitFor(async () => (await outer(["has-session", "-t", "m3notools"])).code !== 0, "notools exit", 10000)
        await h.keyTo("m3smoke:0", "BTab")
        await h.typeTo("m3smoke:0", "exit")
        await h.keyTo("m3smoke:0", "Enter")
        await waitFor(async () => (await outer(["has-session", "-t", "m3smoke"])).code !== 0, "m3 exit", 10000)
        console.log("[chat] tools clean exits ok")
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
    "agents: picker, chip click, posture on the wire, clickable chrome",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "sensus-m7-smoke-"))
      const sensusHome = join(home, "home")
      // Real provider against the mock SSE server: the key comes from config.
      // cardStyle "border" is pinned here (not the shipped default) so the
      // zero-background guard stays deterministic. The toggle is asserted in step 7b.
      writeSmokeConfig(sensusHome, { layout: "topbar", chat: { cardStyle: "border" }, endpoints: { main: { apiKey: "smoke-key" } } })
      // The built-in scout (readonly) is materialized on boot and supplies the
      // second posture to switch between (autopilot was merged into copilot).
      // It is NOT hand-written here: a same-named user file would be rescued as
      // scout.modified-<time>.md by the Sensus-owned built-in lifecycle.

      const start = await outer(
        bootSessionArgv(
          "m7",
          // Real HttpProvider against the mock server: the mock records
          // request bodies so the agent posture is asserted on the wire.
          appBootCommand({
            sensusHome,
            bootLog: BOOT_LOG("m7"),
            mockUrl: mock.url,
          }),
        ),
      )
      expect(start.code).toBe(0)
      const cap = (): Promise<string> => capT("m7:0")
      const capE = (): Promise<string> => capET("m7:0")
      const waitFor = (p: () => boolean | Promise<boolean>, label: string, timeoutMs = 15000): Promise<void> =>
        h.waitFor(p, label, { timeoutMs, dump: cap })
      const key = (k: string): Promise<void> => h.keyTo("m7:0", k)
      const typ = (t: string): Promise<void> => h.typeTo("m7:0", t)
      const bar = async (): Promise<string> => (await cap()).split("\n")[49] ?? ""
      const clickInBar = async (sub: string): Promise<void> => {
        const col = await h.colOf("m7:0", 49, sub)
        if (col < 0) throw new Error(`"${sub}" not in status bar`)
        await h.sgrClick("m7:0", col + 2, 49)
      }
      const waitChatIdle = makeWaitChatIdle({
        cap,
        waitFor: (p, _label, timeoutMs) => waitFor(p, "?", timeoutMs ?? 25000),
      })
      /** Send a message, approve the scripted shell_background card, wait idle. */
      const runScriptedTurn = async (text: string): Promise<void> => {
        await typ(text)
        await key("Enter")
        await waitFor(async () => (await cap()).includes("awaiting approval"), `card for ${text}`, 15000)
        await waitFor(async () => (await cap()).includes("[y accept]"), "card actions", 5000)
        await key("y")
        await waitFor(async () => (await cap()).includes("TOOLDONE-OK"), `reply for ${text}`, 15000)
        await waitChatIdle()
      }

      try {
        // 0. Boot: default agent chip + zero CHROME bg SGRs.
        await waitFor(async () => {
          const out = await cap()
          return out.includes("no messages yet") && out.includes("main@gpt-5")
        }, "boot", 15000)
        await waitFor(async () => (await bar()).includes("agent:copilot"), "agent chip in bar")
        await waitFor(async () => bgCount(await capE()) === 0, "zero chrome bg SGRs", 8000)
        console.log("[chat] agents boot ok (agent:copilot, zero chrome bg)")

        // Focus round-trip (the old synthesized pane-cursor overlay is gone:
        // the embedded VT draws its own native cursor, which the renderable —
        // not sensus — owns).
        await key("BTab")
        await waitFor(async () => (await cap()).includes("input ●"), "focus sidebar", 5000)
        await key("BTab")
        await waitFor(async () => !(await cap()).includes("input ●"), "focus terminal", 5000)
        console.log("[chat] focus round-trip ok")

        // 1. /agent <name>: applies + persists (bar chip flips).
        await key("BTab")
        await waitFor(async () => (await cap()).includes("input ●"), "focus sidebar 2", 5000)
        await typ("/agent scout")
        await key("Enter")
        await waitFor(async () => (await bar()).includes("agent:scout"), "/agent scout chip", 8000)
        expect((await cap()).includes("agent: copilot —")).toBe(false)
        await typ("/status")
        await key("Enter")
        // Short probe: the readout wraps mid-sentence in the 50-col sidebar.
        await waitFor(async () => (await cap()).includes("agent: scout ·"), "/status agent", 5000)
        console.log("[chat] /agent switch ok")

        // 2. Alt+M opens the agent PICKER: rows, preview, Esc close.
        await key("M-m")
        await waitFor(async () => (await cap()).includes(" agents "), "picker opens")
        await waitFor(async () => (await cap()).includes("copilot — Guides you step by step"), "copilot row + description")
        await waitFor(async () => (await cap()).includes("scout — Read-only research"), "scout row")
        await waitFor(async () => (await cap()).includes("You are operating as SCOUT"), "prompt preview")
        await waitFor(async () => (await cap()).includes("agent(s)"), "picker footer")
        await key("Escape")
        await waitFor(async () => !(await cap()).includes(" agents "), "picker closed", 5000)
        console.log("[chat] Alt+M picker ok")

        // 3. First turn: the provider SEES the scout posture. (The first
        //    prompt also fires the auto-title probe — match the chat request by
        //    its posture-bearing system prompt, docs/sessions.md "Auto titles".)
        await runScriptedTurn("hello one")
        const req0 = mock.requests.find((r) => r.userText.endsWith("hello one") && r.systemText.includes("You are operating as"))
        expect(req0).toBeDefined()
        expect(req0!.systemText).toContain("You are operating as SCOUT")
        expect(req0!.systemText).not.toContain("You are operating as COPILOT")
        // The tab title tracks the session title: the first prompt seeds the
        // derived placeholder, so the shell basename is gone (docs/sessions.md).
        await waitFor(async () => !(await bar()).includes("1:bash") && (await bar()).includes("1:"), "tab title follows session", 8000)
        console.log("[chat] scout posture on the wire")

        // 4. Agent CHIP click opens the picker; pick copilot; wire flips.
        await clickInBar("agent:")
        await waitFor(async () => (await cap()).includes(" agents "), "picker via chip")
        await key("Down")
        await key("Enter")
        await waitFor(async () => (await bar()).includes("agent:copilot"), "chip pick copilot", 8000)
        await runScriptedTurn("hello two")
        const req1 = mock.requests.find((r) => r.userText.endsWith("hello two") && r.systemText.includes("You are operating as"))
        expect(req1).toBeDefined()
        expect(req1!.systemText).toContain("You are operating as COPILOT")
        expect(req1!.systemText).not.toContain("You are operating as SCOUT")
        console.log("[chat] agent chip click flips the wire posture")

        // 5. Approval chip click: confirm -> full-auto -> (Alt+Y) confirm.
        await clickInBar("confirm")
        await waitFor(async () => (await cap()).includes("approval → full-auto"), "approval chip note", 5000)
        await waitFor(async () => (await bar()).includes("full-auto"), "bar full-auto", 5000)
        await key("M-y")
        await waitFor(async () => (await bar()).includes("confirm"), "Alt+Y back", 5000)
        console.log("[chat] approval chip + Alt+Y ok")

        // 6. Model indicator click opens the model catalog picker.
        await clickInBar("main@")
        await waitFor(async () => (await cap()).includes("model picker"), "picker opens", 8000)
        await waitFor(async () => (await cap()).includes("mock-gpt-large"), "endpoint models", 8000)
        await key("Escape")
        await waitFor(async () => !(await cap()).includes("model picker"), "picker closed", 5000)
        console.log("[chat] model chip click ok")

        // 6b. Card click-to-expand (per-card override): a long-output tool card
        //     collapses to a preview + hint; clicking the hint expands THIS card
        //     (regression: the sidebar used to feed every card the GLOBAL
        //     setting, so the per-card override was never read), and Alt+E
        //     collapses it again.
        await typ("cmd:seq 1 20")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("[y accept]"), "long card actions", 15000)
        await key("y")
        await waitFor(async () => (await cap()).includes("TOOLDONE-OK"), "long card reply", 15000)
        await waitChatIdle()
        await waitFor(async () => (await cap()).includes("click or Alt+E to expand"), "expand hint", 8000)
        const hintRow = await h.rowOf("m7:0", "click or Alt+E")
        const hintCol = await h.colOf("m7:0", hintRow, "click or Alt+E")
        await h.sgrClick("m7:0", hintCol + 3, hintRow)
        await waitFor(async () => !(await cap()).includes("click or Alt+E"), "card expanded by click", 6000)
        await key("M-e")
        await waitFor(async () => (await cap()).includes("click or Alt+E to expand"), "card collapsed by Alt+E", 6000)
        // Park the pointer off the chat rows: a resting pointer over an
        // interactive row paints a transient hover fill (docs/DESIGN.md), which
        // would defeat the zero-background assertion in step 7.
        await h.sendHexTo("\x1b[<35;10;49M", "m7:0")
        console.log("[chat] card click-to-expand ok")

        // 6c. Pre-tool thinking header click: a thinking bubble that precedes a
        //     tool call renders first in its ACTIVE `⠋ Thinking` form (no click
        //     action) and settles to a clickable `+ Thought`. The row must read
        //     its action at CLICK time — a captured `actions[0]` stayed
        //     undefined, so the click did nothing (stale-props regression).
        await typ("thinktool:reason")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("[y accept]"), "thinktool card", 15000)
        await key("y")
        await waitFor(async () => (await cap()).includes("TOOLDONE-OK"), "thinktool reply", 15000)
        await waitChatIdle()
        await waitFor(async () => (await cap()).includes("+ Thought"), "settled pre-tool thinking", 8000)
        const thinkRow = await h.rowOf("m7:0", "+ Thought")
        const thinkCol = await h.colOf("m7:0", thinkRow, "Thought")
        await h.sgrClick("m7:0", thinkCol + 2, thinkRow)
        await waitFor(async () => (await cap()).includes("- Thought"), "pre-tool thinking expanded by click", 6000)
        await h.sendHexTo("\x1b[<35;10;49M", "m7:0")
        console.log("[chat] pre-tool thinking click ok")

        // 7. Theme via /theme (theme is no longer a palette row — Ctrl+O
        //    settings + /theme are canonical); verify live bg invariants.
        if (!(await cap()).includes("input ●")) await key("BTab")
        await typ("/theme dark")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("theme → dark"), "theme dark note", 8000)
        await waitFor(async () => bgCount(await capE()) > 0, "dark paints bg", 8000)
        await typ("/theme terminal")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("theme → terminal"), "theme restore note", 8000)
        await waitFor(async () => bgCount(await capE()) === 0, "terminal restores zero bg", 8000)
        console.log("[chat] theme via /theme ok")

        // 7b. Card style toggle: /cards fill paints the themed panels
        //     (many bg SGRs) even in the adaptive terminal theme; /cards border
        //     restores the background-free look.
        await typ("/cards fill")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("card style fill"), "cards fill note", 8000)
        await waitFor(async () => bgCount(await capE()) > 5, "fill paints panels", 8000)
        await typ("/cards border")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("card style border"), "cards border note", 8000)
        await waitFor(async () => bgCount(await capE()) === 0, "border restores zero bg", 8000)
        console.log("[chat] card style toggle ok")

        // 8. Tab bar clicks: Ctrl+T, click tab 2, "+" opens tab 3, active-tab
        //    click refocuses the pane.
        await key("BTab")
        await waitFor(async () => !(await cap()).includes("input ●"), "terminal focus 2", 5000)
        await key("C-t")
        await waitFor(async () => (await bar()).includes("tab 2/2: bash"), "tab 2 open", 8000)
        await typ("echo TAB2MARK")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("TAB2MARK"), "tab 2 marker", 8000)
        await key("M-Left")
        await waitFor(async () => (await bar()).includes("tab 1/2:"), "back to tab 1", 8000)
        let col = await h.colOf("m7:0", 0, "2:bash")
        expect(col).toBeGreaterThanOrEqual(0)
        await h.sgrClick("m7:0", col + 1, 0)
        await waitFor(async () => (await bar()).includes("tab 2/2: bash") && (await cap()).includes("TAB2MARK"), "click switches tab", 8000)

        // 8a. Status-bar `tab` chip click cycles to the NEXT tab, wrapping: we
        //     are on the last tab (2/2), so one click must land back on tab 1.
        await clickInBar("tab 2/2: bash")
        await waitFor(async () => (await bar()).includes("tab 1/2:") && !(await cap()).includes("TAB2MARK"), "status tab chip cycles (wraps)", 8000)
        // And once more: from tab 1 the same click advances to tab 2. (Tab 1
        // carries a session title by now, so match the prefix only.)
        await clickInBar("tab 1/2:")
        await waitFor(async () => (await bar()).includes("tab 2/2: bash") && (await cap()).includes("TAB2MARK"), "status tab chip advances", 8000)

        // 8b. Close a tab from its bar `×`: the second `×` on row 0 belongs to
        //     tab 2. Focus falls to the left neighbor (tab 1) and its PTY dies.
        const tabRow = (await cap()).split("\n")[0] ?? ""
        const firstX = tabRow.indexOf("×")
        const secondX = firstX >= 0 ? tabRow.indexOf("×", firstX + 1) : -1
        expect(secondX).toBeGreaterThan(firstX)
        await h.sgrClick("m7:0", secondX, 0)
        await waitFor(async () => (await bar()).includes("tab 1:") && !(await cap()).includes("TAB2MARK"), "× closes tab 2", 8000)
        // Reopen a second tab so the rest of the scenario (3 tabs) still holds.
        await key("C-t")
        await waitFor(async () => (await bar()).includes("tab 2/2: bash"), "tab 2 reopened", 8000)

        col = await h.colOf("m7:0", 0, "+")
        expect(col).toBeGreaterThan(0)
        await h.sgrClick("m7:0", col, 0)
        await waitFor(async () => (await bar()).includes("tab 3/3: bash"), "+ opens tab 3", 8000)
        await key("C-w")
        await Bun.sleep(350)
        await key("C-w")
        await waitFor(async () => (await bar()).includes("tab 1:") && !(await cap()).includes("TAB2MARK"), "tabs closed", 8000)
        await key("BTab")
        await waitFor(async () => (await cap()).includes("input ●"), "sidebar focus 3", 5000)
        col = await h.colOf("m7:0", 0, "1:")
        expect(col).toBeGreaterThanOrEqual(0)
        await h.sgrClick("m7:0", col + 2, 0)
        await waitFor(async () => !(await cap()).includes("input ●"), "active-tab refocus", 5000)
        console.log("[chat] tab bar clicks ok")

        // 9. Input click places the caret (HELLOWORLD +X between O and W).
        await key("BTab")
        await waitFor(async () => (await cap()).includes("input ●"), "sidebar focus 4", 5000)
        await typ("HELLOWORLD")
        let draftRow = -1
        let draftCol = -1
        // The draft render can lag the keystrokes — poll until visible.
        await waitFor(
          async () => {
            for (const r of [44, 45, 46, 47]) {
              const c = await h.colOf("m7:0", r, "HELLOWORLD")
              if (c >= 0) {
                draftRow = r
                draftCol = c
                return true
              }
            }
            return false
          },
          "draft visible",
          5000,
        )
        expect(draftRow).toBeGreaterThanOrEqual(0)
        await h.sgrClick("m7:0", draftCol + 5, draftRow)
        await Bun.sleep(150)
        await typ("X")
        await waitFor(async () => (await cap()).includes("HELLOXWORLD"), "caret insert", 5000)
        await key("C-c")
        await Bun.sleep(150)
        console.log("[chat] input click-to-caret ok")

        // 10. Zero bg SGRs (overlays closed, terminal focus) — must run
        //     BEFORE the reverse-video row, which paints a persistent bg bar.
        await waitFor(async () => bgCount(await capE()) === 0, "still no black-boxing", 8000)

        // 10b. Reverse video: the VT swaps the pane's current fg (the theme
        //      default, #d4d4d4 = 212;212;212 here) with the bg (black).
        await key("BTab")
        await waitFor(async () => !(await cap()).includes("input ●"), "terminal focus 3", 5000)
        await typ("printf '\\033[7mREVTXT\\033[27mPLAIN\\033[0m\\n'")
        await key("Enter")
        await waitFor(async () => {
          const line = (await capE()).split("\n").find((l) => l.includes("REVTXT") && !l.includes("printf"))
          return line !== undefined && /\x1b\[38;2;0;0;0m\x1b\[48;2;212;212;212mREVTXT/.test(line)
        }, "reverse video swapped colors", 8000)
        console.log("[chat] reverse video ok")

        // 11. Clean exit; no lingering sandbox process (app or PTY child).
        await typ("exit")
        await key("Enter")
        await waitFor(async () => (await outer(["has-session", "-t", "m7"])).code !== 0, "clean exit", 10000)
        await Bun.sleep(400)
        await expectNoStrayProcesses(sensusHome)
        console.log("[chat] agents clean exit, no strays")
      } finally {
        await outer(["kill-server"])
        try {
          rmSync(home, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    },
    300_000,
  )

  test(
    "MCP end-to-end + config agent default at boot",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "sensus-m11-smoke-"))
      const sensusHome = join(home, "home")
      mkdirSync(sensusHome, { recursive: true })
      // Config (v2 filename): one stdio MCP server (the mock) + the copilot
      // default — the boot chip assertion doubles as the config `agent` default
      // check. The endpoint key lives in config (real HttpProvider against the
      // mock SSE server).
      writeFileSync(
        join(sensusHome, "config.json"),
        JSON.stringify(
          {
            layout: "topbar",
            agent: "copilot",
            endpoints: { main: { apiKey: "smoke-key" } },
            mcp: {
              servers: {
                mock: { command: process.execPath, args: [join(REPO_ROOT, "tests", "mocks", "mockMcpServer.ts")] },
              },
            },
          },
          null,
          2,
        ),
      )

      const start = await outer(
        bootSessionArgv(
          "m11",
          appBootCommand({
            sensusHome,
            bootLog: BOOT_LOG("m11"),
            mockUrl: mock.url,
          }),
        ),
      )
      expect(start.code).toBe(0)
      const cap = (): Promise<string> => capT("m11:0")
      const waitFor = (p: () => boolean | Promise<boolean>, label: string, timeoutMs = 15000): Promise<void> =>
        h.waitFor(p, label, { timeoutMs, dump: cap })
      const key = (k: string): Promise<void> => h.keyTo("m11:0", k)
      const typ = (t: string): Promise<void> => h.typeTo("m11:0", t)

      try {
        await waitFor(
          async () => {
            const out = await cap()
            const bar = out.split("\n")[49] ?? ""
            // The MCP server is configured but idle: the chip is still shown
            // (its enabled count) and clickable to open the manager.
            return out.includes("no messages yet") && bar.includes("agent:copilot") && bar.includes("mcp:1")
          },
          "boot (config agent default: copilot chip; mcp chip shows enabled count while idle)",
          15000,
        )
        // The status-bar chip opens the manager; Space toggles the highlighted
        // server's config `enabled` flag (written to config.json and applied
        // live — reload re-reads the file, so a failed write would not stick).
        const mcpCol = await h.colOf("m11:0", 49, "mcp:1")
        expect(mcpCol).toBeGreaterThanOrEqual(0)
        await h.sgrClick("m11:0", mcpCol, 49)
        await waitFor(async () => (await cap()).includes("Space/Enter toggle"), "mcp manager opens")
        await key("Space")
        await waitFor(async () => (await cap()).includes("disabled in config"), "toggle off applies live")
        await key("Escape")
        await waitFor(async () => !(await cap()).includes("Space/Enter toggle"), "mcp manager closes", 4000)
        await waitFor(async () => ((await cap()).split("\n")[49] ?? "").includes("mcp:0"), "chip reads 0 enabled")
        // Toggle it back on (the global state round-trips).
        const mcpOffCol = await h.colOf("m11:0", 49, "mcp:0")
        await h.sgrClick("m11:0", mcpOffCol, 49)
        await waitFor(async () => (await cap()).includes("Space/Enter toggle"), "mcp manager reopens")
        await key("Space")
        await waitFor(async () => (await cap()).includes("enabled · idle"), "toggle on applies live")
        await key("Escape")
        await waitFor(async () => !(await cap()).includes("Space/Enter toggle"), "mcp manager closes", 4000)
        await waitFor(async () => ((await cap()).split("\n")[49] ?? "").includes("mcp:1"), "chip reads 1 enabled")
        await key("BTab")
        await waitFor(async () => (await cap()).includes("input ●"), "focus sidebar", 5000)
        console.log("[chat] mcp boot ok (agent:copilot from config)")

        // 1. /mcp: the server is configured but NOT connected yet (lazy).
        await typ("/mcp")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("mcp servers (docs/mcp.md)"), "/mcp section")
        await waitFor(async () => (await cap()).includes("mock: idle"), "mock idle (lazy)")
        console.log("[chat] /mcp lists the idle server")

        // 2. Marker message -> mcp__mock__echo card -> approve -> result.
        await typ("mcp:mock|echo|{\"text\":\"SMOKE-MCP\"}")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("mcp__mock__echo"), "mcp tool card", 20000)
        await waitFor(async () => (await cap()).includes("awaiting approval"), "approval pending")
        await key("y")
        await waitFor(async () => (await cap()).includes("ECHO:SMOKE-MCP"), "tool result", 20000)
        // The drain-hold keeps `chat:streaming` until the pour lands —
        // sending while busy silently keeps the draft (chatKeys busy path).
        await waitFor(async () => !(await cap()).includes("chat:streaming"), "generation idle (drain-hold released)")
        // The status bar surfaces the live server once it connects (before the
        // first message the same chip shows the enabled count, `mcp:1`).
        await waitFor(
          async () => ((await cap()).split("\n")[49] ?? "").includes("mcp:mock"),
          "status-bar mcp chip",
        )
        console.log("[chat] mcp__mock__echo executed through the registry")

        // 3. /mcp now reports the live connection + merged tool count.
        await typ("/mcp")
        await key("Enter")
        await waitFor(async () => (await cap()).includes("mock: connected"), "mock connected")
        await waitFor(async () => (await cap()).includes("tool(s) merged into requests"), "specs merged")
        console.log("[chat] /mcp reports connected + merged tools")

        // 4. Clean exit; the MCP child must be killed by the app shutdown.
        await key("BTab")
        await waitFor(async () => !(await cap()).includes("input ●"), "terminal focus", 5000)
        await typ("exit")
        await key("Enter")
        await waitFor(async () => (await outer(["has-session", "-t", "m11"])).code !== 0, "app exited", 10000)
        // The daemon owns the MCP child now; stopping it kills the child (D4:
        // the client detaches, the daemon keeps shells/turns until stopped).
        await stopSandboxDaemon(sensusHome)
        await Bun.sleep(600)
        const strays = Bun.spawnSync(["sh", "-c", "pgrep -f '[m]ockMcpServer' || true"], { stdout: "pipe" }).stdout.toString()
        expect(strays.trim()).toBe("")
        console.log("[chat] clean exit, no stray MCP processes")
      } finally {
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
    "images: /image attaches a file, the draft chip renders, the send carries pixels to the provider",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "sensus-image-smoke-"))
      const sensusHome = join(home, "home")
      writeSmokeConfig(sensusHome, { layout: "topbar" })
      const pngDir = join(home, "img")
      mkdirSync(pngDir, { recursive: true })
      const pngPath = join(pngDir, "shot.png")
      writeFileSync(
        pngPath,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          "base64",
        ),
      )
      const boot = (session: string, extraArgs: string[]): Promise<{ code: number }> =>
        outer(
          bootSessionArgv(
            session,
            appBootCommand({
              sensusHome,
              bootLog: BOOT_LOG(session),
              env: "SENSUS_MOCK=1 SENSUS_MOCK_DELAY=20 SENSUS_DEBUG=1",
              args: extraArgs.join(" ") || undefined,
            }),
          ),
        )
      try {
        const start = await boot("chatimg", [])
        expect(start.code).toBe(0)
        const cap = (): Promise<string> => capT("chatimg:0")
        const key = (k: string): Promise<void> => h.keyTo("chatimg:0", k)
        const typ = (t: string): Promise<void> => h.typeTo("chatimg:0", t)
        const waitChatIdle = makeWaitChatIdle({
          cap,
          waitFor: (p, _label, timeoutMs) => h.waitFor(p, "?", { timeoutMs }),
          probes: 6,
          probeWindowMs: 1200,
        })
        await h.waitFor(async () => (await cap()).includes("no messages yet"), "image boot", { timeoutMs: 15000 })
        await key("BTab")
        await h.waitFor(async () => (await cap()).includes(CHAT_FOCUS), "image sidebar focus", { timeoutMs: 5000 })

        // Attach a real PNG by path; the draft chip row appears above the input.
        await typ(`/image ${pngPath}`)
        await key("Enter")
        await h.waitFor(async () => (await cap()).includes("attached shot.png"), "attach toast", { timeoutMs: 6000 })
        await h.waitFor(async () => {
          const s = await cap()
          return s.includes("attach") && s.includes("▣") && s.includes("shot.png")
        }, "draft chip", { timeoutMs: 6000 })

        // Send with just the image attached (empty text is allowed).
        await typ("what is in this image?")
        await key("Enter")
        // The MockProvider appends MOCKIMAGE-OK when a request carried images.
        await h.waitFor(async () => (await cap()).includes("MOCKIMAGE-OK"), "image reached the provider", { timeoutMs: 15000 })
        await h.waitFor(async () => (await cap()).includes("✱ copilot"), "image settled label", { timeoutMs: 6000 })
        await waitChatIdle()
        // The sent user bubble keeps its chip. The attach toast floats over the
        // sidebar's top-right, so wait for it to expire before reading the row.
        await h.waitFor(async () => !(await cap()).includes("attached shot.png"), "attach toast expires", { timeoutMs: 8000 })
        expect((await cap()).includes("▣ shot.png")).toBe(true)
        console.log("[chat] image attach -> draft chip -> send -> provider MOCKIMAGE-OK ok")

        await key("BTab") // back to the pane for a clean exit
        await typ("exit")
        await key("Enter")
        await h.waitFor(async () => (await outer(["has-session", "-t", "chatimg"])).code !== 0, "image clean exit", { timeoutMs: 10000 })
      } finally {
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
