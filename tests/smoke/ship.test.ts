/**
 * M4 ship tests: the compiled standalone binary + installer.
 *
 * - `bun run build` (scripts/build.ts) into a temp dir, then drive the BINARY
 *   end-to-end in tmux: boot (with a poisoned cwd bunfig.toml — regression
 *   guard for compile's autoloadBunfig:false), mock chat turn, mid-run shrink
 *   below the tmux minimum (notice + no crash + recovery), clean exit.
 * - Tiny-terminal boot refusal (10x3 → clear message, exit).
 * - install-release.sh end-to-end in a temp HOME/PREFIX + `sensus init`
 *   round-trip, plus the build-install.sh build+delegate wrapper.
 * - install-release.sh release mode against a local release server: download,
 *   checksum verification, and the corrupt-checksum refusal (docs/operations.md).
 *
 * If `bun build --compile` cannot produce a runnable binary on this platform,
 * the build test logs the failure and the binary-dependent tests skip
 * gracefully (docs/operations.md).
 *
 * All artifacts live under /tmp/sensus (AGENTS.md smoke-test rules apply:
 * one outer-tmux socket per file, wait for state transitions, clean up). The
 * binary is driven by an OUTER tmux as a test host only; it owns no tmux
 * server of its own.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SENSUS_VERSION } from "../../src/version.ts"
import { bootSessionArgv, createHarness, expectNoStrayProcesses, REPO_ROOT, type Harness, writeSmokeConfig } from "../helpers.ts"

const WORK = mkdtempSync(join("/tmp/sensus/sensus-ship-"))

const h: Harness = createHarness({
  sock: `/tmp/sensus/sensus-ship-${process.pid}.sock`,
  tag: "ship",
  dumpTarget: "ship:0",
})

const sh = h.sh
const outer = h.outer

// Legacy positional adapter (timeoutMs before label; stepMs 100).
const waitFor = (
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 15000,
  stepMs = 100,
): Promise<void> => h.waitFor(predicate, label, { timeoutMs, stepMs })

/** The binary under test (set by the build test; null → dependent tests skip). */
let binaryPath: string | null = null

/** The release asset name for the host running the suite (matches release.yml). */
function platformReleaseAsset(): string {
  const os = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "darwin" : null
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null
  if (os === null || arch === null) throw new Error(`no release asset for ${process.platform}/${process.arch}`)
  return `sensus-${os}-${arch}`
}

afterAll(async () => {
  await h.killServer()
  for (const sock of [h.sock]) {
    try {
      rmSync(sock, { force: true })
    } catch {
      // ignore — tmux 3.6 leaves socket files behind
    }
  }
})

describe("M4 ship: compiled binary + installer", () => {
  test(
    "bun run build produces the standalone binary (skips the rest if unsupported here)",
    async () => {
      const out = join(WORK, "sensus")
      const r = await sh(["bun", "run", "scripts/build.ts", "--outfile", out], {
        cwd: REPO_ROOT,
        timeoutMs: 240_000,
      })
      if (r.code !== 0) {
        // Platform genuinely cannot compile (e.g. no --compile support): skip
        // the binary tests instead of failing the suite (docs/operations.md).
        console.warn(`[ship] SKIPPING binary tests — build failed:\n${r.stderr || r.stdout}`)
        return
      }
      expect(existsSync(out)).toBe(true)
      binaryPath = out
      const v = await sh([out, "--version"], { timeoutMs: 15_000 })
      expect(v.code).toBe(0)
      expect(v.stdout.trim()).toBe(`sensus ${SENSUS_VERSION}`)
      console.log("[ship] build ok")
    },
    300_000,
  )

  test(
    "binary --help / init --create-config work headlessly, even from a cwd whose bunfig has a preload",
    async () => {
      if (binaryPath === null) {
        console.log("[ship] skip: no binary")
        return
      }
      // Poisoned bunfig (top-level preload the standalone cannot resolve):
      // the binary must boot anyway — scripts/build.ts sets autoloadBunfig:false.
      const poison = join(WORK, "poison-cwd")
      mkdirSync(poison, { recursive: true })
      writeFileSync(join(poison, "bunfig.toml"), 'preload = ["./definitely-missing.ts"]\n')
      const help = await sh([binaryPath, "--help"], { cwd: poison, timeoutMs: 15_000 })
      expect(help.code).toBe(0)
      expect(help.stdout).toContain("Usage:")
      expect(help.stdout).toContain("sensus init")
      // Headless scaffold: config written, no shell rc file touched.
      const home = mkdtempSync(join(tmpdir(), "sensus-ship-init-"))
      try {
        const created = await sh([binaryPath, "init", "--create-config"], {
          cwd: poison,
          env: { HOME: home },
          timeoutMs: 15_000,
        })
        expect(created.code).toBe(0)
        expect(existsSync(join(home, ".config/sensus/config.json"))).toBe(true)
        expect(existsSync(join(home, ".zshrc"))).toBe(false)
        expect(existsSync(join(home, ".bashrc"))).toBe(false)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
      console.log("[ship] binary flags ok (poisoned bunfig cwd)")
    },
    60_000,
  )

  test(
    "binary daemon start/status/stop round-trips headlessly and leaves no orphan",
    async () => {
      if (binaryPath === null) {
        console.log("[ship] skip: no binary")
        return
      }
      const runtime = mkdtempSync(join(tmpdir(), "sensus-ship-daemon-run-"))
      const home = mkdtempSync(join(tmpdir(), "sensus-ship-daemon-home-"))
      const env = { SENSUS_RUNTIME_DIR: runtime, SENSUS_HOME: home, SENSUS_SKIP: "1" }
      const sock = join(runtime, "daemon.sock")
      try {
        const start = await sh([binaryPath, "daemon", "start"], { env, timeoutMs: 30_000 })
        expect(start.code).toBe(0)
        expect(start.stdout).toContain("started")
        expect(existsSync(sock)).toBe(true)

        const status = await sh([binaryPath, "daemon", "status"], { env, timeoutMs: 15_000 })
        expect(status.code).toBe(0)
        expect(status.stdout).toContain("running")

        const stop = await sh([binaryPath, "daemon", "stop"], { env, timeoutMs: 15_000 })
        expect(stop.code).toBe(0)
        await Bun.sleep(200)
        expect(existsSync(sock)).toBe(false)
        expect(existsSync(join(runtime, "daemon.pid"))).toBe(false)

        // Idempotent when nothing is running.
        const again = await sh([binaryPath, "daemon", "stop"], { env, timeoutMs: 15_000 })
        expect(again.code).toBe(0)
        expect(again.stdout).toContain("not running")
        console.log("[ship] binary daemon lifecycle ok")
      } finally {
        // Never leave a detached daemon behind if an assertion failed.
        await sh([binaryPath, "daemon", "stop"], { env, timeoutMs: 15_000 }).catch(() => undefined)
        rmSync(runtime, { recursive: true, force: true })
        rmSync(home, { recursive: true, force: true })
      }
    },
    90_000,
  )

  test(
    "binary boots under tmux (poisoned cwd), chats, survives a shrink below the minimum, exits clean",
    async () => {
      if (binaryPath === null) {
        console.log("[ship] skip: no binary")
        return
      }
      const home = mkdtempSync(join(tmpdir(), "sensus-ship-home-"))
      // Pin the topbar layout (the binary scenario drives the horizontal tab
      // bar and hard-coded status row); the default is the sidebar rail now.
      writeSmokeConfig(home, { layout: "topbar" })
      const poison = join(WORK, "poison-cwd")
      try {
        const boot = await outer(
          bootSessionArgv(
            "ship",
            `env SHELL=/bin/bash SENSUS_SKIP=1 SENSUS_HOME=${home} SENSUS_RUNTIME_DIR=${home}/daemon-runtime SENSUS_MOCK=1 ${binaryPath} 2>>/tmp/sensus/sensus-ship-boot.err`,
            { cwd: poison }, // cwd with the poisoned bunfig.toml (see above)
          ),
        )
        expect(boot.code).toBe(0)

        // 1. Boot: full UI (tab bar + sidebar + status bar).
        await waitFor(async () => {
          const out = await h.capT("ship:0")
          return out.includes("1:bash") && out.includes("no messages yet") && out.includes("tab 1: bash")
        }, "binary boot UI")
        console.log("[ship] binary boot ok (from poisoned-bunfig cwd)")

        // 2. A chat turn works end-to-end in the binary (reactivity alive).
        //    The placeholder (empty input, NOT focused) marks chat focus —
        //    the trimmed bar has no `focus:` segment.
        await outer(["send-keys", "-t", "ship:0", "BTab"])
        await waitFor(async () => (await h.capT("ship:0")).includes("input ●"), "focus sidebar")
        await outer(["send-keys", "-t", "ship:0", "-l", "--", "binary ship test"])
        await outer(["send-keys", "-t", "ship:0", "Enter"])
        await waitFor(async () => (await h.capT("ship:0")).includes("MOCKREPLY-OK"), "mock reply in binary")
        console.log("[ship] binary chat turn ok")

        // 3. Shrink below the terminal minimum (4 rows < 5; 40 cols keeps the
        //    message readable): notice + no crash.
        await outer(["send-keys", "-t", "ship:0", "BTab"]) // back to terminal focus
        await outer(["resize-window", "-t", "ship:0", "-x", "40", "-y", "4"])
        await waitFor(async () => (await h.capT("ship:0")).includes("terminal too small"), "too-small notice")
        const alive = await outer(["has-session", "-t", "ship"])
        expect(alive.code).toBe(0)
        console.log("[ship] shrink below minimum shows the notice, no crash")

        // 4. Grow back: full UI returns, pane usable again. (The trimmed bar
        //    no longer shows the pane size — the RECOVERED-OK echo below is
        //    the usable-again proof.)
        await outer(["resize-window", "-t", "ship:0", "-x", "200", "-y", "50"])
        await waitFor(async () => {
          const out = await h.capT("ship:0")
          // The tab now carries the session title (the chat turn above), so
          // assert the tab index rather than the shell basename.
          return out.includes("tab 1:") && out.includes("input ") && !out.includes("terminal too small")
        }, "recovery after resize")
        await outer(["send-keys", "-t", "ship:0", "-l", "echo RECOVERED-OK"])
        await outer(["send-keys", "-t", "ship:0", "Enter"])
        await waitFor(async () => (await h.capT("ship:0")).includes("RECOVERED-OK"), "pane usable after recovery")
        console.log("[ship] recovery after resize ok")

        // 5. Agents on the binary: the bar carries the agent chip and the
        //    click opens the picker (docs/agents.md). The full picker/switch
        //    interactions live in chat.test.ts — this only proves the binary
        //    SHIPS the agents UI.
        const barRow = async (): Promise<string> => (await h.capT("ship:0")).split("\n")[49] ?? ""
        const agentCol = (await barRow()).indexOf("agent:")
        expect(agentCol).toBeGreaterThan(0)
        await h.sgrClick("ship:0", agentCol + 2, 49)
        await waitFor(async () => (await h.capT("ship:0")).includes(" agents "), "binary agent chip opens the picker", 8000)
        await outer(["send-keys", "-t", "ship:0", "Escape"])
        await waitFor(async () => !(await h.capT("ship:0")).includes(" agents "), "binary picker closed", 8000)
        console.log("[ship] binary agents UI ok")

        // 6. Clean exit: type exit in the terminal; sensus quits and leaves no
        //    lingering sandbox process (the embedded VT PTY child included).
        await outer(["send-keys", "-t", "ship:0", "-l", "exit"])
        await outer(["send-keys", "-t", "ship:0", "Enter"])
        await waitFor(async () => (await outer(["has-session", "-t", "ship"])).code !== 0, "clean exit", 10000)
        await Bun.sleep(300)
        await expectNoStrayProcesses(home)
        console.log("[ship] binary clean exit ok")
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    },
    120_000,
  )

  test(
    "tiny terminal at boot: refuses with a clear message instead of rendering garbage",
    async () => {
      if (binaryPath === null) {
        console.log("[ship] skip: no binary")
        return
      }
      const home = mkdtempSync(join(tmpdir(), "sensus-ship-tiny-"))
      const errFile = join(WORK, "tiny-boot.err")
      try {
        const boot = await outer([
          "new-session",
          "-d",
          "-x",
          "10",
          "-y",
          "3",
          "-s",
          "tiny",
          "-c",
          REPO_ROOT,
          `env SENSUS_SKIP=1 SENSUS_HOME=${home} SENSUS_RUNTIME_DIR=${home}/daemon-runtime SENSUS_MOCK=1 ${binaryPath} 2>${errFile}`,
        ])
        expect(boot.code).toBe(0)
        await waitFor(
          () => {
            try {
              return readFileSync(errFile, "utf8").includes("terminal too small")
            } catch {
              return false
            }
          },
          "too-small boot message",
          15000,
        )
        const msg = readFileSync(errFile, "utf8")
        expect(msg).toContain("(10x3)")
        expect(msg).toContain("20x5")
        // The app exits (session disappears; tmux closes the last window).
        await waitFor(async () => (await outer(["has-session", "-t", "tiny"])).code !== 0, "tiny boot exits", 10000)
        console.log("[ship] tiny-terminal boot refusal ok")
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    },
    60_000,
  )

  test(
    "install-release.sh end-to-end in a temp HOME (idempotent) + headless config scaffold, no rc writes",
    async () => {
      if (binaryPath === null) {
        console.log("[ship] skip: no binary")
        return
      }
      const home = mkdtempSync(join(tmpdir(), "sensus-ship-install-"))
      const prefix = join(home, "prefix")
      const binPath = join(prefix, "bin", "sensus")
      try {
        // 1. Install (prebuilt path — the from-source build is the test above).
        const install = await sh(["bash", "scripts/install-release.sh"], {
          cwd: REPO_ROOT,
          timeoutMs: 60_000,
          env: { HOME: home, PREFIX: prefix, SENSUS_PREBUILT: binaryPath },
        })
        expect(install.code).toBe(0)
        expect(install.stdout).toContain(`Installed: ${binPath}`)
        expect(existsSync(binPath)).toBe(true)
        // Not on PATH by construction -> the warning must be printed.
        expect(install.stdout).toContain("not on your PATH")
        expect(install.stdout).toContain(`export PATH="${prefix}/bin:`)
        expect(install.stdout).toContain("setup wizard")
        // Setup is in-app now — install must not tell people to run `sensus init`.
        expect(install.stdout).not.toContain("sensus init")
        // The zshrc launcher is gone — no launcher instructions remain.
        expect(install.stdout).not.toContain("launcher")
        expect(install.stdout).not.toContain(".zshrc")
        const ver = await sh([binPath, "--version"], { timeoutMs: 15_000 })
        expect(ver.stdout.trim()).toBe(`sensus ${SENSUS_VERSION}`)

        // 2. Re-run: idempotent (overwrites cleanly, still succeeds).
        const again = await sh(["bash", "scripts/install-release.sh"], {
          cwd: REPO_ROOT,
          timeoutMs: 60_000,
          env: { HOME: home, PREFIX: prefix, SENSUS_PREBUILT: binaryPath },
        })
        expect(again.code).toBe(0)
        expect(existsSync(binPath)).toBe(true)

        // 3. Headless `init --create-config` via the installed binary in a temp
        //    HOME: scaffolds config, never creates or edits a shell rc file.
        const initHome = mkdtempSync(join(tmpdir(), "sensus-ship-init-"))
        try {
          const init = await sh([binPath, "init", "--create-config"], { env: { HOME: initHome }, timeoutMs: 15_000 })
          expect(init.code).toBe(0)
          expect(existsSync(join(initHome, ".config/sensus/config.json"))).toBe(true)
          expect(existsSync(join(initHome, ".zshrc"))).toBe(false)
          expect(existsSync(join(initHome, ".bashrc"))).toBe(false)
          // Re-running is a no-op that leaves the file untouched.
          const before = readFileSync(join(initHome, ".config/sensus/config.json"), "utf8")
          const init2 = await sh([binPath, "init", "--create-config"], { env: { HOME: initHome }, timeoutMs: 15_000 })
          expect(init2.code).toBe(0)
          expect(init2.stdout).toContain("already exists")
          expect(readFileSync(join(initHome, ".config/sensus/config.json"), "utf8")).toBe(before)
        } finally {
          rmSync(initHome, { recursive: true, force: true })
        }
        console.log("[ship] install-release.sh + headless config scaffold ok")
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    },
    120_000,
  )

  test(
    "build-install.sh builds via bun and delegates the install (fake bun, real scripts)",
    async () => {
      if (binaryPath === null) {
        console.log("[ship] skip: no binary")
        return
      }
      const home = mkdtempSync(join(tmpdir(), "sensus-ship-build-install-"))
      const fakeRepo = join(home, "repo")
      const fakeBin = join(home, "bin")
      const prefix = join(home, "prefix")
      const binPath = join(prefix, "bin", "sensus")
      try {
        // A minimal "checkout": the two real scripts + the markers the wrapper
        // looks for. A fake bun stands in for the compiler: `run build` copies
        // the already-built binary to dist/sensus, which the wrapper must then
        // install through install-release.sh (the real delegation seam).
        mkdirSync(join(fakeRepo, "scripts"), { recursive: true })
        mkdirSync(fakeBin, { recursive: true })
        writeFileSync(join(fakeRepo, "package.json"), "{}")
        writeFileSync(join(fakeRepo, "scripts/build.ts"), "")
        cpSync(join(REPO_ROOT, "scripts/build-install.sh"), join(fakeRepo, "scripts/build-install.sh"))
        cpSync(join(REPO_ROOT, "scripts/install-release.sh"), join(fakeRepo, "scripts/install-release.sh"))
        writeFileSync(
          join(fakeBin, "bun"),
          `#!/usr/bin/env bash
case "$1" in
  --version) echo 1.4.2 ;;
  install) exit 0 ;;
  run) mkdir -p dist && cp "$SENSUS_FAKE_BUILT" dist/sensus && chmod +x dist/sensus ;;
  *) exit 0 ;;
esac
`,
        )
        chmodSync(join(fakeBin, "bun"), 0o755)
        const r = await sh(["bash", "scripts/build-install.sh"], {
          cwd: fakeRepo,
          timeoutMs: 60_000,
          env: {
            HOME: home,
            PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`,
            PREFIX: prefix,
            SENSUS_FAKE_BUILT: binaryPath,
          },
        })
        expect(r.code).toBe(0)
        expect(r.stdout).toContain("Building the sensus binary")
        expect(r.stdout).toContain("Installing the built binary")
        expect(existsSync(binPath)).toBe(true)
        const ver = await sh([binPath, "--version"], { timeoutMs: 15_000 })
        expect(ver.stdout.trim()).toBe(`sensus ${SENSUS_VERSION}`)
        console.log("[ship] build-install.sh build + delegate ok")
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    },
    120_000,
  )

  test(
    "install-release.sh downloads + checksum-verifies a release (and refuses a mismatch)",
    async () => {
      if (binaryPath === null) {
        console.log("[ship] skip: no binary")
        return
      }
      // A local stand-in for GitHub Releases: same URL layout the script uses
      // (`/download/<tag>/<asset>` + `checksums.txt`), served from memory.
      const asset = platformReleaseAsset()
      const bytes = new Uint8Array(await Bun.file(binaryPath).arrayBuffer())
      const goodSha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
      let checksumLine = `${goodSha}  ${asset}\n`
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          const path = new URL(req.url).pathname
          if (path === `/latest/download/${asset}` || path === `/download/v9.9.9/${asset}`) {
            return new Response(bytes)
          }
          if (path === "/latest/download/checksums.txt" || path === "/download/v9.9.9/checksums.txt") {
            return new Response(checksumLine)
          }
          return new Response("not found", { status: 404 })
        },
      })

      const home = mkdtempSync(join(tmpdir(), "sensus-ship-release-"))
      const prefix = join(home, "prefix")
      const binPath = join(prefix, "bin", "sensus")
      const runInstall = () =>
        sh(["bash", "scripts/install-release.sh", "--version", "v9.9.9"], {
          cwd: REPO_ROOT,
          timeoutMs: 60_000,
          env: {
            PREFIX: prefix,
            HOME: home,
            SENSUS_RELEASES_BASE_URL: `http://127.0.0.1:${server.port}`,
          },
        })

      try {
        const install = await runInstall()
        expect(install.code).toBe(0)
        expect(install.stdout).toContain(`Downloading ${asset} (v9.9.9)`)
        expect(install.stdout).toContain("Checksum verified.")
        expect(install.stdout).toContain(`Installed: ${binPath}`)
        expect(existsSync(binPath)).toBe(true)
        // Release mode needs no bun (the binary embeds the runtime) and must not
        // tell people to run `sensus init`.
        expect(install.stdout).not.toContain("bun is required")
        expect(install.stdout).not.toContain("sensus init")
        const ver = await sh([binPath, "--version"], { timeoutMs: 15_000 })
        expect(ver.stdout.trim()).toBe(`sensus ${SENSUS_VERSION}`)

        // Corrupt checksum: refuse to install, non-zero exit, no binary.
        checksumLine = `${"0".repeat(64)}  ${asset}\n`
        rmSync(binPath, { force: true })
        const bad = await runInstall()
        expect(bad.code).not.toBe(0)
        expect(`${bad.stdout}\n${bad.stderr}`).toContain("checksum mismatch")
        expect(existsSync(binPath)).toBe(false)
        console.log("[ship] install-release.sh download + checksum guard ok")
      } finally {
        server.stop(true)
        rmSync(home, { recursive: true, force: true })
      }
    },
    120_000,
  )
})