/**
 * macOS ad-hoc code signing for the compiled binary (scripts/build.ts).
 *
 * `bun build --compile` embeds its own ad-hoc Mach-O signature, and that
 * signature has repeatedly regressed upstream: Bun 1.3.12–1.3.13 could write a
 * truncated `LC_CODE_SIGNATURE`, and Bun 1.4.x can write one macOS rejects. The
 * kernel then kills the binary before any JavaScript runs (`Killed: 9`, exit
 * 137) — which is exactly what makes a freshly compiled sensus look "broken on a
 * Mac" (the installer's `sensus --version` check dies here).
 *
 * Building with `BUN_NO_CODESIGN_MACHO_BINARY=1` makes Bun skip its signer; this
 * module re-signs the finished binary ad-hoc with the system `codesign`. Ad-hoc
 * signing (`--sign -`) needs no developer certificate and is enough for the
 * kernel to launch the binary. The hardened runtime is not enabled, so JIT needs
 * no entitlements file.
 *
 * The fallback exists because a binary that already carries a truncated signature
 * can make a plain overwrite fail with "invalid or unsupported format for
 * signature"; stripping the broken signature first makes it signable again.
 */

/** Runs an argv and returns its exit code, or -1 when it could not be spawned. */
export type CodeSignRunner = (argv: readonly string[]) => number

/**
 * Ad-hoc sign `outfile`. Returns true when the binary ends up signed (or the
 * host simply has no `codesign` — the caller's warning covers that case).
 */
export function adHocSignMacBinary(outfile: string, run: CodeSignRunner): boolean {
  if (run(["codesign", "--force", "--sign", "-", outfile]) === 0) return true
  // A truncated/foreign signature can block an in-place overwrite; drop it
  // first (best effort) and retry.
  run(["codesign", "--remove-signature", outfile])
  return run(["codesign", "--force", "--sign", "-", outfile]) === 0
}
