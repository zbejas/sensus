/**
 * `sensus auth` — host-local pairing identity and scope policy. No network,
 * no cloud token, no relay: this is the auth surface the separate connector
 * reads. Run as the Sensus user.
 */

import { errorMessage } from "../core/util.ts"
import { authHomeFrom, safeUid } from "./paths.ts"
import { loadOrCreateIdentity, readIdentity } from "./identity.ts"
import {
  defaultPolicy,
  readPolicy,
  scopeSummary,
  updatePolicyScopes,
  writePolicy,
  type AuthPolicy,
} from "./policy.ts"
import { parseScopeList } from "./scopes.ts"

export interface AuthIo {
  out(s: string): void
  err(s: string): void
}

export interface AuthCliOptions {
  home?: string
  uid?: number
  now?: () => number
}

const USAGE = `sensus auth — host-local pairing identity and scopes

Usage:
  sensus auth init [--allow <scopes>]   create the identity and default policy
  sensus auth identity [--json]         show the host fingerprint and public key
  sensus auth scopes [--allow <scopes>] show or change host-local scopes
  sensus auth status [--json]           show identity, policy, and paths

Scopes: view, chat, control, orchestrator (default: view).
These files are 0600 and are read by the separate cloud connector. The cloud
cannot write or widen them. Run as the Sensus user, not root.
`

interface ParsedFlags {
  values: Map<string, string | true>
  error: string | null
}

function parseFlags(argv: readonly string[], booleanFlags: ReadonlySet<string>): ParsedFlags {
  const values = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ""
    if (!arg.startsWith("--")) {
      return { values, error: `unexpected argument ${JSON.stringify(arg)}` }
    }
    const body = arg.slice(2)
    const eq = body.indexOf("=")
    if (eq >= 0) {
      values.set(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    if (booleanFlags.has(body)) {
      values.set(body, true)
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) {
      return { values, error: `--${body} needs a value` }
    }
    values.set(body, next)
    i++
  }
  return { values, error: null }
}

function stringFlag(values: Map<string, string | true>, name: string): string | undefined {
  const value = values.get(name)
  return typeof value === "string" ? value : undefined
}

function printPolicy(io: AuthIo, home: string, policy: AuthPolicy): void {
  io.out(`sensus auth: policy      ${home}/auth/policy.json`)
  io.out(`sensus auth: scopes      ${scopeSummary(policy)}`)
  io.out(`sensus auth: allowed cwd ${policy.allowedCwd.length > 0 ? policy.allowedCwd.join(", ") : "(none)"}`)
  io.out(`sensus auth: start daemon ${policy.startDaemon ? "yes" : "no"}`)
}

function status(io: AuthIo, home: string, json: boolean): number {
  const identity = readIdentity(home)
  const policy = readPolicy(home)
  if (json) {
    io.out(
      JSON.stringify(
        {
          home,
          initialized: identity.identity !== null,
          identity: identity.identity
            ? {
                path: `${home}/auth/identity.json`,
                fingerprint: identity.identity.fingerprint,
                publicKey: identity.identity.publicKey,
                createdAt: identity.identity.createdAt,
              }
            : null,
          identityError: identity.error,
          policy: policy.ok
            ? {
                path: `${home}/auth/policy.json`,
                existed: policy.existed,
                scopes: policy.policy.scopes,
                startDaemon: policy.policy.startDaemon,
                allowedCwd: policy.policy.allowedCwd,
                maxStreams: policy.policy.maxStreams,
              }
            : null,
          policyError: policy.ok ? null : policy.error,
        },
        null,
        2,
      ),
    )
    return identity.error || !policy.ok ? 1 : 0
  }
  if (identity.identity) {
    io.out(`sensus auth: fingerprint ${identity.identity.fingerprint}`)
    io.out(`sensus auth: identity    ${home}/auth/identity.json`)
  } else {
    io.err(identity.error ?? "sensus auth: not initialized — run `sensus auth init`")
  }
  if (policy.ok) {
    printPolicy(io, home, policy.policy)
    if (!policy.existed) io.out("sensus auth: policy is the default (view only); set it with `sensus auth scopes --allow ...`")
  } else {
    io.err(policy.error)
  }
  return identity.error || !policy.ok ? 1 : 0
}

function init(io: AuthIo, home: string, allow: string | undefined, opts: AuthCliOptions): number {
  const identity = loadOrCreateIdentity(home, { uid: opts.uid ?? safeUid(), now: opts.now })
  if (!identity.ok) {
    io.err(`sensus auth: ${identity.error}`)
    return 1
  }
  const parsed = allow === undefined ? { ok: true as const, scopes: defaultPolicy().scopes } : parseScopeList(allow)
  if (!parsed.ok) {
    io.err(`sensus auth: ${parsed.error}`)
    return 1
  }
  const existing = readPolicy(home)
  if (!existing.ok) {
    io.err(`sensus auth: ${existing.error}`)
    return 1
  }
  const policy = existing.existed
    ? allow === undefined
      ? existing.policy
      : updatePolicyScopes(existing.policy, parsed.scopes)
    : { ...defaultPolicy(), scopes: parsed.scopes }
  if (!existing.existed || allow !== undefined) {
    const written = writePolicy(home, policy, { uid: opts.uid ?? safeUid() })
    if (!written.ok) {
      io.err(`sensus auth: ${written.error}`)
      return 1
    }
  }
  io.out(`sensus auth: identity ${identity.created ? "created" : "already present"}`)
  io.out(`sensus auth: fingerprint ${identity.identity.fingerprint}`)
  printPolicy(io, home, policy)
  return 0
}

function scopes(io: AuthIo, home: string, allow: string | undefined, opts: AuthCliOptions): number {
  const parsed = allow === undefined ? null : parseScopeList(allow)
  if (parsed && !parsed.ok) {
    io.err(`sensus auth: ${parsed.error}`)
    return 1
  }
  const existing = readPolicy(home)
  if (!existing.ok) {
    io.err(`sensus auth: ${existing.error}`)
    return 1
  }
  if (parsed === null) {
    printPolicy(io, home, existing.policy)
    return 0
  }
  const written = writePolicy(home, updatePolicyScopes(existing.policy, parsed.scopes), {
    uid: opts.uid ?? safeUid(),
  })
  if (!written.ok) {
    io.err(`sensus auth: ${written.error}`)
    return 1
  }
  io.out(`sensus auth: scopes ${parsed.scopes.join(",")}`)
  io.out(`sensus auth: policy ${written.path}`)
  return 0
}

function identity(io: AuthIo, home: string, json: boolean): number {
  const existing = readIdentity(home)
  if (!existing.identity) {
    io.err(existing.error ?? "sensus auth: not initialized — run `sensus auth init`")
    return 1
  }
  if (json) {
    io.out(
      JSON.stringify(
        {
          path: `${home}/auth/identity.json`,
          fingerprint: existing.identity.fingerprint,
          publicKey: existing.identity.publicKey,
          createdAt: existing.identity.createdAt,
        },
        null,
        2,
      ),
    )
    return 0
  }
  io.out(`sensus auth: fingerprint ${existing.identity.fingerprint}`)
  io.out(`sensus auth: public key  ${existing.identity.publicKey}`)
  io.out(`sensus auth: identity    ${home}/auth/identity.json`)
  return 0
}

/** Run one `sensus auth` invocation. Returns a process exit code. */
export function runAuth(
  argv: readonly string[],
  io: AuthIo,
  env: NodeJS.ProcessEnv = process.env,
  opts: AuthCliOptions = {},
): number {
  const home = opts.home ?? authHomeFrom(env)
  const [command, ...rest] = argv
  try {
    if (command === undefined || command === "help" || command === "--help") {
      io.out(USAGE)
      return command === undefined ? 1 : 0
    }
    if (command === "status") {
      const flags = parseFlags(rest, new Set(["json"]))
      if (flags.error) {
        io.err(`sensus auth status: ${flags.error}`)
        return 1
      }
      return status(io, home, flags.values.get("json") === true)
    }
    if (command === "identity") {
      const flags = parseFlags(rest, new Set(["json"]))
      if (flags.error) {
        io.err(`sensus auth identity: ${flags.error}`)
        return 1
      }
      return identity(io, home, flags.values.get("json") === true)
    }
    if (command === "init") {
      const flags = parseFlags(rest, new Set())
      if (flags.error) {
        io.err(`sensus auth init: ${flags.error}`)
        return 1
      }
      return init(io, home, stringFlag(flags.values, "allow"), opts)
    }
    if (command === "scopes") {
      const flags = parseFlags(rest, new Set())
      if (flags.error) {
        io.err(`sensus auth scopes: ${flags.error}`)
        return 1
      }
      return scopes(io, home, stringFlag(flags.values, "allow"), opts)
    }
    io.err(`sensus auth: unknown command ${JSON.stringify(command)}`)
    io.err(USAGE)
    return 1
  } catch (e) {
    io.err(`sensus auth: ${errorMessage(e)}`)
    return 1
  }
}
