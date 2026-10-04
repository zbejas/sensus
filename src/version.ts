/**
 * The sensus version — re-exported from package.json, which is the SINGLE
 * source of truth (they cannot drift). Reported by `sensus --version`,
 * --help and the build banner.
 *
 * The JSON import is inlined at build time (scripts/build.ts bundles it
 * into the standalone binary), so a compiled `sensus` reports the version
 * it was BUILT from; tests/ship.test.ts asserts the binary's --version
 * matches.
 */
import pkg from "../package.json"

export const SENSUS_VERSION: string = pkg.version