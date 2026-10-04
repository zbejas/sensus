/**
 * `bun run license:check` — verify every npm package actually bundled into the
 * shipped binary carries a license in the allow-list. Part of the licensing
 * gate (docs/licensing.md).
 *
 * Scope — the packages embedded in `dist/sensus`. Its `// node_modules/<path>`
 * module comments give the exact embedded package set (the bundler drops
 * dev-only tooling and the Babel/JSX compile path, so those never ship). When
 * the binary is missing it is built first (`bun run build`, well under a
 * second once Bun's cache is warm); if the build fails too (e.g. a mid-flight
 * `src/` refactor), the check falls back to the runtime closure of
 * `package.json` `dependencies` — and that fallback also reports the build-only
 * tooling it cannot distinguish, so treat it as advisory.
 *
 * Fails (exit 1) on:
 *   - a package with no license field and no LICENSE file carrying a
 *     recognizable allow-listed license;
 *   - a license whose SPDX id is outside {MIT, Apache-2.0, BSD-2-Clause,
 *     BSD-3-Clause, ISC}.
 *
 * Prints a concise table either way so a human can eyeball the result. `OR`
 * expressions pass when any branch is allowed (we may take that branch); `AND`
 * requires every branch. Platform-specific optional natives that are not
 * installed on this host are skipped (they are not bundled here).
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { dirname, join } from "node:path"

const ALLOWED = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"])

/** One row of the report. */
interface Row {
  name: string
  version: string
  license: string
  ok: boolean
}

interface PkgJson {
  name?: string
  version?: string
  license?: string
  licenses?: unknown
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

/** Read and parse `<dir>/package.json`, or null when absent/corrupt. */
function readPackage(dir: string): PkgJson | null {
  const file = join(dir, "package.json")
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PkgJson
  } catch {
    return null
  }
}

/**
 * Resolve a package directory the way Node does: walk up from `fromDir`
 * looking for `node_modules/<name>`, then fall back to the repo root.
 */
function resolvePackageDir(name: string, fromDir: string, repoRoot: string): string | null {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, "node_modules", name)
    if (existsSync(join(candidate, "package.json"))) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const top = join(repoRoot, "node_modules", name)
  return existsSync(join(top, "package.json")) ? top : null
}

/** The declared license string, tolerating the legacy `licenses` array form. */
function declaredLicense(pkg: PkgJson): string | null {
  if (typeof pkg.license === "string" && pkg.license.length > 0) return pkg.license
  const legacy = pkg.licenses
  if (Array.isArray(legacy)) {
    const types = legacy
      .filter((l): l is { type?: string } => typeof l === "object" && l !== null)
      .map((l) => l.type)
      .filter((t): t is string => typeof t === "string" && t.length > 0)
    if (types.length > 0) return types.join(" OR ")
  }
  return null
}

/** LICENSE/COPYING files sitting next to the package. */
function licenseFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => /^(licen[cs]e|copying)/i.test(f))
  } catch {
    return []
  }
}

/** True when a LICENSE/COPYING file sits next to the package. */
function hasLicenseFile(dir: string): boolean {
  return licenseFiles(dir).length > 0
}

/** Recognizable license markers, tested in order (3-clause before 2-clause). */
const FILE_MARKERS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "Apache-2.0", re: /Apache License\s*(?:\r?\n)?\s*Version 2\.0/i },
  { id: "MIT", re: /MIT License|Permission is hereby granted, free of charge/i },
  { id: "BSD-3-Clause", re: /Redistribution and use in source and binary forms[\s\S]{0,1500}?Neither the name/i },
  { id: "BSD-2-Clause", re: /Redistribution and use in source and binary forms/i },
  { id: "ISC", re: /ISC License|Permission to use, copy, modify, and(?:\/or)? distribute this software/i },
]

/**
 * When a package declares no SPDX field, read its LICENSE/COPYING file and
 * require a recognizable allow-listed license. Returns the id, or null when no
 * file carries a recognized license — a file that exists but is unclassifiable
 * must NOT pass (the old behavior fail-open).
 */
function classifyLicenseFile(dir: string): string | null {
  for (const file of licenseFiles(dir)) {
    let text: string
    try {
      text = readFileSync(join(dir, file), "utf8")
    } catch {
      continue
    }
    for (const marker of FILE_MARKERS) {
      if (marker.re.test(text)) return marker.id
    }
  }
  return null
}

/** Strip `WITH ...` and a trailing `+` from an SPDX id. */
export function baseId(token: string): string {
  return token
    .trim()
    .split(/\s+WITH\s+/i)[0]!
    .replace(/\+$/, "")
    .trim()
}

/** Tokenize an SPDX expression into ids, `AND`/`OR`, and parentheses. */
function tokenize(expr: string): string[] {
  return expr.match(/\(|\)|[^\s()]+/g) ?? []
}

/**
 * Evaluate an SPDX expression with correct precedence: `AND` binds tighter
 * than `OR`, and parentheses are honored. A top-level `OR` passes when one
 * branch is fully allowed; an `AND` requires every term. Crucially, a
 * parenthesized branch is NOT flattened into a top-level alternative, so a
 * required non-permissive term (`X AND (A OR B)`) fails the whole expression
 * rather than passing via `A`/`B`.
 */
export function classify(expr: string): { label: string; ok: boolean } {
  const tokens = tokenize(expr)
  let i = 0

  // factor := id | "(" expr ")"
  const parseFactor = (): { ok: boolean; label: string } => {
    const tok = tokens[i]
    if (tok === "(") {
      i++
      const inner = parseOr()
      if (i < tokens.length && tokens[i] === ")") i++
      return inner
    }
    i++
    const label = baseId(tok ?? expr.trim())
    return { ok: ALLOWED.has(label), label }
  }
  // term := factor ("AND" factor)*
  const parseAnd = (): { ok: boolean; label: string } => {
    let node = parseFactor()
    while (i < tokens.length && /^AND$/i.test(tokens[i]!)) {
      i++
      const rhs = parseFactor()
      node = { ok: node.ok && rhs.ok, label: node.label }
    }
    return node
  }
  // expr := term ("OR" term)*
  const parseOr = (): { ok: boolean; label: string } => {
    let node = parseAnd()
    while (i < tokens.length && /^OR$/i.test(tokens[i]!)) {
      i++
      const rhs = parseAnd()
      // Report an allowed branch as the label when one exists.
      node = { ok: node.ok || rhs.ok, label: node.ok ? node.label : rhs.label }
    }
    return node
  }

  const result = parseOr()
  return { label: result.label === "" ? expr.trim() : result.label, ok: result.ok }
}

/**
 * The npm package names embedded in the built binary, read from the
 * `// node_modules/<path>` source comments the bundler emits. Null when the
 * binary is absent or unreadable.
 */
function embeddedPackageNames(binaryPath: string): Set<string> | null {
  if (!existsSync(binaryPath)) return null
  let text: string
  try {
    text = readFileSync(binaryPath, "latin1")
  } catch {
    return null
  }
  const names = new Set<string>()
  const re = /\/\/ node_modules\/([^\n]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const spec = m[1]!.trim()
    if (!/\.(?:js|ts|mjs|cjs)$/.test(spec)) continue
    const parts = spec.split("/")
    names.add(parts[0]!.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!)
  }
  return names.size > 0 ? names : null
}

/** Runtime closure of the declared `dependencies`, resolved from disk. */
function runtimeClosure(repoRoot: string): Set<string> {
  const root = readPackage(repoRoot)
  const names = new Set<string>()
  const queue: Array<{ name: string; fromDir: string }> = Object.keys(root?.dependencies ?? {}).map(
    (name) => ({ name, fromDir: repoRoot }),
  )
  while (queue.length > 0) {
    const { name, fromDir } = queue.shift()!
    if (names.has(name)) continue
    names.add(name)
    const dir = resolvePackageDir(name, fromDir, repoRoot)
    const pkg = dir ? readPackage(dir) : null
    if (!dir || !pkg) continue
    for (const dep of [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]) {
      if (!names.has(dep)) queue.push({ name: dep, fromDir: dir })
    }
  }
  return names
}

/** True when the repo has been through `bun install` (the check needs node_modules). */
function hasNodeModules(repoRoot: string): boolean {
  return existsSync(join(repoRoot, "node_modules"))
}

/**
 * Build `dist/sensus` (best-effort) so the embedded-package scan has a target.
 * Returns the binary path on success, or null when the build cannot run.
 */
function buildBinary(repoRoot: string): string | null {
  const outfile = join(repoRoot, "dist", "sensus")
  try {
    const proc = Bun.spawnSync(["bun", "run", "build"], {
      cwd: repoRoot,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    })
    if (proc.exitCode === 0 && statSync(outfile).size > 0) return outfile
  } catch {
    // fall through to the advisory closure path
  }
  return null
}

function main(): number {
  const repoRoot = process.cwd()
  const root = readPackage(repoRoot)
  if (!root) {
    console.error("license:check: no package.json in the current directory")
    return 1
  }
  if (!hasNodeModules(repoRoot)) {
    console.error("license:check: node_modules is missing — run `bun install` first")
    return 1
  }

  const binaryPath = join(repoRoot, "dist", "sensus")
  let embedded = embeddedPackageNames(binaryPath)
  if (!embedded) {
    // No binary yet: build it so the scan reflects what actually ships.
    const built = buildBinary(repoRoot)
    embedded = built ? embeddedPackageNames(built) : null
  }

  const names = embedded ?? runtimeClosure(repoRoot)
  const scope = embedded
    ? "bundled into dist/sensus"
    : "runtime closure (advisory — build unavailable)"


  const rows: Row[] = []
  const missing: string[] = []
  for (const name of names) {
    const dir = resolvePackageDir(name, repoRoot, repoRoot)
    const pkg = dir ? readPackage(dir) : null
    if (!dir || !pkg) {
      missing.push(name)
      continue
    }
    const declared = declaredLicense(pkg)
    if (declared) {
      const { label, ok } = classify(declared)
      rows.push({ name, version: pkg.version ?? "?", license: label, ok })
    } else {
      const fromFile = classifyLicenseFile(dir)
      if (fromFile !== null) {
        rows.push({ name, version: pkg.version ?? "?", license: fromFile, ok: true })
      } else {
        rows.push({
          name,
          version: pkg.version ?? "?",
          license: hasLicenseFile(dir) ? "LICENSE file (unrecognized)" : "(none)",
          ok: false,
        })
      }
    }
  }

  rows.sort((a, b) => a.name.localeCompare(b.name))
  const width = Math.max(7, ...rows.map((r) => r.name.length))

  console.log(`license:check — ${rows.length} packages ${scope}\n`)
  console.log(`${"package".padEnd(width)}  ${"version".padEnd(10)}  license`)
  console.log(`${"-".repeat(width)}  ${"-".repeat(10)}  ${"-".repeat(24)}`)
  for (const r of rows) {
    console.log(`${r.name.padEnd(width)}  ${r.version.padEnd(10)}  ${r.ok ? "" : "FAIL "}${r.license}`)
  }

  const bad = rows.filter((r) => !r.ok)
  console.log("")
  if (bad.length + missing.length > 0) {
    for (const m of missing) console.error(`license:check: unresolved dependency ${m}`)
    for (const r of bad) {
      console.error(`license:check: ${r.name}@${r.version} has license "${r.license}", not in the allow-list`)
    }
    console.error(`\nlicense:check FAILED — allow-list: ${[...ALLOWED].join(", ")}`)
    return 1
  }
  console.log(`license:check OK — all ${rows.length} packages use: ${[...ALLOWED].join(", ")}`)
  return 0
}

// Run only when invoked as the script (`bun run license:check`), so a unit test
// can import the pure `classify`/`baseId` helpers without exiting the runner.
if (import.meta.main) process.exit(main())
