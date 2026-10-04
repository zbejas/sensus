/**
 * host_scan core (docs/memory.md): a read-only discovery pass over the machine
 * so the agent can draft HOST.md (the server architecture map).
 *
 * This module owns the whitelist, the output formatting and the redaction; the
 * tool wiring (approval gate, hidden-shell execution, HOST.md write) lives in
 * tools.ts. Everything here is pure — no fs, no process spawn, no provider — so
 * the executor can run each HOST_SCAN_COMMANDS line through the hidden shell and
 * hand the results back as HostScanEntry[] for formatHostScan to render.
 *
 * Safety: the whitelist is strictly READ-ONLY (the forbidden-token sweep in the
 * tests is load-bearing) and every output is redacted through `redactSecrets`
 * before it can reach the model or a file.
 */

import { redactSecrets } from "./safety.ts"
import { componentLogger } from "../log.ts"

const log = componentLogger("agent.memory")

export interface HostScanEntry {
  command: string
  output: string
  ok: boolean
}

/**
 * Read-only whitelist — full shell command lines, run through the hidden shell.
 * Every probe tolerates a missing tool/service (`2>/dev/null || true`) so one
 * absent binary never fails the pass. No writes, no escalation, and the only
 * redirection is `2>/dev/null` (stderr discard, never a file).
 */
export const HOST_SCAN_COMMANDS: readonly string[] = [
  "uname -a 2>/dev/null || true",
  "cat /etc/os-release 2>/dev/null || true",
  "hostname 2>/dev/null || true",
  "uptime 2>/dev/null || true",
  "lsblk 2>/dev/null || true",
  "df -h 2>/dev/null || true",
  "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || true",
  "systemctl --failed --no-pager 2>/dev/null || true",
  `docker ps --format '{{.Names}}\\t{{.Image}}\\t{{.Ports}}' 2>/dev/null || true`,
  "podman ps 2>/dev/null || true",
  "ip -brief addr 2>/dev/null || true",
  "git remote -v 2>/dev/null || true",
]

/** Per-command output character cap used by formatHostScan. */
export const HOST_SCAN_OUTPUT_CAP = 1200

/** The fixed HOST.md section template the draft must be curated into. */
const HOST_TEMPLATE_SECTIONS: readonly string[] = [
  "## What this machine is",
  "## OS & hardware",
  "## Services & ports",
  "## Key paths",
  "## Commands",
  "## Data & volumes",
  "## Network/topology",
  "## Conventions",
  "## Gotchas",
  "## Open questions",
  "## Recent changes",
]

/**
 * Redact secret-looking spans (via `redactSecrets`) + strip trailing whitespace
 * per line + collapse blank-line spam. Never throws on odd input.
 */
export function redactScanOutput(text: string): string {
  if (typeof text !== "string") return ""
  const redacted = redactSecrets(text)
  const trimmed = redacted
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
  return trimmed.replace(/\n{3,}/g, "\n\n")
}

function capBody(text: string, cap: number): { body: string; truncated: boolean } {
  if (cap <= 0 || text.length <= cap) return { body: text, truncated: false }
  return { body: text.slice(0, cap), truncated: true }
}

/** First non-empty output line of the `hostname` probe, redacted (or null). */
function derivedHostname(entries: readonly HostScanEntry[]): string | null {
  for (const entry of entries) {
    try {
      if (entry === null || typeof entry !== "object") continue
      if (typeof entry.command !== "string" || !/^\s*hostname\b/.test(entry.command)) continue
      if (entry.ok !== true || typeof entry.output !== "string") continue
      const line = entry.output
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0)
      if (line !== undefined) return redactScanOutput(line).trim()
    } catch (e) {
      // odd entry — skip it and keep scanning
      log.debug("host_scan entry skipped while deriving hostname", { err: e })
    }
  }
  return null
}

/**
 * Format entries into a compact markdown draft for HOST.md: a short header
 * (hostname + cwd when provided), one `### <command>` section per entry with a
 * fenced, redacted body capped at HOST_SCAN_OUTPUT_CAP, and a closing reminder
 * to curate the draft into the fixed HOST.md section template. Failed/empty
 * entries render `(unavailable)`. Never throws on odd input.
 */
export function formatHostScan(entries: readonly HostScanEntry[], opts: { cwd?: string | null } = {}): string {
  try {
    return build(entries, opts)
  } catch (e) {
    log.debug("host_scan format failed; returning placeholder draft", { err: e })
    return "# Host scan draft\n\n(unavailable)\n"
  }
}

function build(entries: readonly HostScanEntry[], opts: { cwd?: string | null }): string {
  const list: readonly HostScanEntry[] = Array.isArray(entries) ? entries : []

  const header: string[] = ["# Host scan draft"]
  const host = derivedHostname(list)
  if (host !== null && host.length > 0) header.push(`Host: ${host}`)
  const cwd = typeof opts?.cwd === "string" && opts.cwd.trim().length > 0 ? opts.cwd.trim() : null
  if (cwd !== null) header.push(`CWD: ${cwd}`)
  header.push(`Probes: ${list.length}`)

  const sections: string[] = []
  for (const entry of list) {
    const command =
      entry !== null && typeof entry === "object" && typeof entry.command === "string" && entry.command.trim().length > 0
        ? entry.command
        : "(unknown command)"
    sections.push(`### ${command}`)

    const ok = entry !== null && typeof entry === "object" && entry.ok === true
    const raw = entry !== null && typeof entry === "object" && typeof entry.output === "string" ? entry.output : ""
    const redacted = redactScanOutput(raw).trim()
    if (!ok || redacted.length === 0) {
      sections.push("(unavailable)")
      continue
    }
    const { body, truncated } = capBody(redacted, HOST_SCAN_OUTPUT_CAP)
    sections.push("```")
    sections.push(body)
    if (truncated) sections.push("…[truncated]")
    sections.push("```")
  }

  const footer = [
    "> DRAFT from read-only probes — curate it into HOST.md using the fixed section template:",
    `> ${HOST_TEMPLATE_SECTIONS.map((s) => `\`${s}\``).join(" · ")}.`,
    "> Drop noise; keep durable facts. MEMORY.md owns volatile/environment notes.",
  ].join("\n")

  return `${header.join("\n")}\n\n${sections.join("\n")}\n\n${footer}\n`
}
