/**
 * Headless PTY core (docs/terminal-layer.md "PTY core vs renderable"): a real
 * `Bun.Terminal` child with no renderer. Proves the daemon can own a shell and
 * read its output/facts without `@opentui/core`, and that a dead/closed PTY
 * degrades instead of throwing.
 */

import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PtySession } from "../../../src/terminal/ptySession.ts"

async function until(f: () => boolean, ms = 5000, label = "condition"): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (f()) return
    await Bun.sleep(15)
  }
  throw new Error(`until(${label}) timed out`)
}

describe("PtySession (headless PTY)", () => {
  test("streams child output, exposes the ring tail, reports the exit code, and tears down idempotently", async () => {
    // A tiny executable standing in for `sh -c 'printf PTY-OK; exit 3'` so the
    // REAL spawn path (shellLaunchArgv + Bun.Terminal) is what gets exercised.
    const dir = mkdtempSync(join(tmpdir(), "sensus-pty-"))
    const script = join(dir, "sayer")
    writeFileSync(script, "#!/bin/sh\nprintf 'PTY-OK\\n'\nexit 3\n")
    chmodSync(script, 0o755)

    const pty = PtySession.spawn({ cols: 80, rows: 24, shell: script })
    try {
      expect(pty.spawnError).toBeNull()

      // onOutput receives the post-rewrite raw bytes the daemon would fan out.
      let seen = ""
      const decoder = new TextDecoder()
      pty.onOutput((bytes) => {
        seen += decoder.decode(bytes, { stream: true })
      })
      await until(() => seen.includes("PTY-OK"), 5000, "PTY-OK onOutput")

      // The scanner ring carries the same line for the agent's context tail.
      expect(pty.recentLines(50).join("\n")).toContain("PTY-OK")
      expect(await pty.captureScrollbackRaw(50)).toContain("PTY-OK")

      // The child's exit status surfaces on the status fact + the exited promise.
      const code = await pty.exited
      expect(code).toBe(3)
      expect(pty.status().dead).toBe(true)
      expect(pty.status().deadStatus).toBe(3)

      // kill() is idempotent and never throws.
      pty.kill()
      expect(() => pty.kill()).not.toThrow()

      // A write to a closed PTY is a silent drop, never an exception.
      expect(() => pty.write(new Uint8Array([0x61]))).not.toThrow()
      expect(() => pty.sendBytes(new Uint8Array([0x62]))).not.toThrow()
      await expect(pty.sendText("x")).resolves.toBeUndefined()
      await expect(pty.sendKeys({ kind: "keys", names: ["Enter"] })).resolves.toBeUndefined()
    } finally {
      pty.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a spawn failure is a dead session, never a throw", () => {
    let pty: PtySession | null = null
    expect(() => {
      pty = PtySession.spawn({ cols: 80, rows: 24, shell: "/nonexistent/sensus-no-such-shell" })
    }).not.toThrow()
    expect(pty).not.toBeNull()
    // It may be dead immediately (spawn rejected) or die when the shell fails;
    // either way the status read is safe and the kill is clean.
    expect(() => pty!.status()).not.toThrow()
    expect(() => pty!.kill()).not.toThrow()
  })
})
