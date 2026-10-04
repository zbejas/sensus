/**
 * Build the standalone `sensus` binary (`bun run build [--outfile <path>]`).
 *
 * Compile-mode specifics (all REQUIRED — do not "simplify" away):
 * - The solid JSX transform is passed via `plugins: [solidPlugin]` AND
 *   registered with `plugin(solidPlugin)`. Which one the compile step honors
 *   differs across Bun versions (1.4.0 applies the array; newer builds only
 *   apply `plugin()`-registered onLoad plugins) — doing both works everywhere
 *   and dedup by plugin name makes the double registration harmless.
 * - `compile.autoloadBunfig: false` keeps the embedded runtime from reading
 *   the launching directory's bunfig.toml. A top-level `preload` there (this
 *   repo's bunfig has one; OpenTUI projects commonly do) resolves against the
 *   CWD instead of the binary and kills startup with `preload not found`.
 *   With autoload disabled the binary boots from any directory.
 * - On macOS the binary is re-signed ad-hoc after compile: Bun's own compile-time
 *   Mach-O signer has shipped broken/truncated signatures (Bun 1.3.12–1.3.13) and
 *   signatures macOS rejects (1.4.x), which the kernel answers with SIGKILL
 *   (`Killed: 9`) before any code runs. See scripts/macosSign.ts.
 *
 * Output: dist/sensus (override with --outfile <path>).
 */

import { plugin as registerBunPlugin } from "bun"
import solidPlugin from "@opentui/solid/bun-plugin"
import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { SENSUS_VERSION } from "../src/version.ts"
import { adHocSignMacBinary } from "./macosSign.ts"

registerBunPlugin(solidPlugin) // idempotent (dedup'd by the shared symbol state)

/** True when this build targets macOS (the only platform needing a signature). */
const isMac = process.platform === "darwin"

// Skip Bun's compile-time signer on macOS; ad-hoc sign the result below instead.
// Set before Bun.build so the compile step reads it (Bun's process.env writes
// reach the native env). Harmless when a Bun version ignores the variable — the
// post-build re-sign is the actual fix.
if (isMac) process.env.BUN_NO_CODESIGN_MACHO_BINARY = "1"

function parseOutfile(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--outfile" || a === "-o") {
      const next = argv[i + 1]
      if (next && next.length > 0) return resolve(next)
    }
    if (a?.startsWith("--outfile=")) return resolve(a.slice("--outfile=".length))
    if (a?.startsWith("-o=")) return resolve(a.slice(3))
  }
  return resolve("dist/sensus")
}

const outfile = parseOutfile(process.argv.slice(2))
mkdirSync(dirname(outfile), { recursive: true })

const result = await Bun.build({
  entrypoints: ["./src/index.tsx"],
  target: "bun",
  plugins: [solidPlugin],
  compile: {
    outfile,
    autoloadBunfig: false,
  },
})

if (!result.success) {
  console.error(`sensus build failed:`)
  for (const log of result.logs) console.error(`  ${log}`)
  process.exit(1)
}

if (isMac) {
  const signed = adHocSignMacBinary(outfile, (argv) => {
    try {
      const r = Bun.spawnSync([...argv], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
      return r.exitCode ?? -1
    } catch {
      return -1
    }
  })
  if (!signed) {
    console.error(
      "sensus build: warning: could not ad-hoc sign the macOS binary (codesign unavailable?) —\n" +
        "  macOS may kill it on launch with `Killed: 9`. Install the Xcode command line tools\n" +
        "  (`xcode-select --install`) and rebuild, or run `codesign --force --sign - " +
        outfile +
        "`.",
    )
  }
}

console.log(`sensus ${SENSUS_VERSION} -> ${outfile}`)