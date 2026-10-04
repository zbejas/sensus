import { describe, expect, test } from "bun:test"
import {
  HOST_SCAN_COMMANDS,
  HOST_SCAN_OUTPUT_CAP,
  formatHostScan,
  redactScanOutput,
  type HostScanEntry,
} from "../../../../src/agent/memory/hostScan.ts"

/**
 * A probe is read-only if it carries none of the forbidden tokens. The one
 * allowed redirect is `2>/dev/null` (stderr discard, never a file), so strip it
 * before sweeping for output redirection.
 */
function withoutStderrDiscard(command: string): string {
  return command.replace(/2>\s*\/dev\/null/g, "").replace(/2>&1/g, "")
}

const HOST_TEMPLATE_SECTIONS = [
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

describe("host_scan whitelist", () => {
  test("every probe is strictly read-only and tolerates missing tools", () => {
    expect(HOST_SCAN_COMMANDS.length).toBeGreaterThan(0)

    const forbidden: readonly RegExp[] = [
      /\brm\b/,
      /\bkill\b/,
      /\bpkill\b/,
      /\bshutdown\b/,
      /\breboot\b/,
      /\b(?:apt|apt-get|yum|dnf)\b/,
      /\bchmod\b/,
      /\bchown\b/,
      /systemctl\s+(?:start|stop|restart|enable|disable)/,
      /docker\s+(?:run|rm|stop|kill|rmi)/,
      /git\s+push/,
    ]

    for (const command of HOST_SCAN_COMMANDS) {
      expect(typeof command).toBe("string")
      expect(command.length).toBeGreaterThan(0)
      // No output redirection to a file — only the stderr discard is allowed.
      expect(withoutStderrDiscard(command)).not.toContain(">")
      for (const re of forbidden) expect(re.test(command), `${command} matched ${re}`).toBe(false)
      // A missing tool/service must not fail the pass.
      expect(command).toMatch(/(?:2>\/dev\/null|2>&1)/)
    }
  })

  test("covers the required discovery areas", () => {
    const joined = HOST_SCAN_COMMANDS.join("\n")
    for (const probe of [
      "uname -a",
      "cat /etc/os-release",
      "hostname",
      "uptime",
      "lsblk",
      "df -h",
      "ss -tlnp",
      "netstat",
      "systemctl --failed",
      "docker ps",
      "podman ps",
      "ip -brief addr",
      "git remote -v",
    ]) {
      expect(joined).toContain(probe)
    }
  })
})

describe("host_scan formatting", () => {
  test("one section per command, redacted body, truncation marker at the cap, template reminder", () => {
    const long = "d".repeat(HOST_SCAN_OUTPUT_CAP + 250)
    const entries: HostScanEntry[] = [
      { command: "uname -a", output: "Linux box 6.8.0 x86_64", ok: true },
      { command: "df -h", output: long, ok: true },
    ]
    const draft = formatHostScan(entries, { cwd: "/srv/app" })

    expect(draft).toContain("### uname -a")
    expect(draft).toContain("### df -h")
    expect(draft).toContain("Linux box 6.8.0 x86_64")
    expect(draft).toContain("…[truncated]")

    // The fenced body before the marker never exceeds the cap.
    const lines = draft.split("\n")
    const heading = lines.indexOf("### df -h")
    const fence = lines.indexOf("```", heading)
    expect((lines[fence + 1] ?? "").length).toBe(HOST_SCAN_OUTPUT_CAP)
    expect(lines[fence + 2]).toBe("…[truncated]")

    // It is a DRAFT: the fixed HOST.md template is named.
    for (const section of HOST_TEMPLATE_SECTIONS) expect(draft).toContain(section)
  })

  test("failed and empty probes render (unavailable); odd input never throws", () => {
    const entries = [
      { command: "systemctl --failed --no-pager", output: "", ok: false },
      { command: "podman ps", output: "   \n\n", ok: true },
      { command: "ip -brief addr", output: "eth0 UP 10.0.0.2/24", ok: true },
    ] as HostScanEntry[]
    const draft = formatHostScan(entries)
    expect(draft.match(/\(unavailable\)/g)?.length).toBe(2)
    expect(draft).toContain("eth0 UP 10.0.0.2/24")

    // Runtime garbage (nulls, missing fields, non-array) must degrade, not throw.
    expect(() => formatHostScan(null as unknown as HostScanEntry[])).not.toThrow()
    expect(() => formatHostScan([null, {}] as unknown as HostScanEntry[])).not.toThrow()
    expect(formatHostScan([null, {}] as unknown as HostScanEntry[])).toContain("(unavailable)")
    expect(formatHostScan([] as HostScanEntry[])).toContain("# Host scan draft")
  })

  test("hostname and cwd appear in the header when provided", () => {
    const host = [
      { command: "hostname 2>/dev/null || true", output: "sensus-box\n", ok: true },
    ] as HostScanEntry[]
    const withCwd = formatHostScan(host, { cwd: "/srv/app" })
    expect(withCwd).toContain("Host: sensus-box")
    expect(withCwd).toContain("CWD: /srv/app")

    const noCwd = formatHostScan(host)
    expect(noCwd).toContain("Host: sensus-box")
    expect(noCwd).not.toContain("CWD:")
  })
})

describe("redactScanOutput", () => {
  test("masks secret-looking spans, preserves ordinary text, trims + collapses blanks", () => {
    const out = redactScanOutput("api_key: sk-abcdefghijklmnopqrstuvwxyz\nservice listening   \n\n\n\nplain tail")
    expect(out).toContain("[redacted]")
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
    expect(out).toContain("service listening")
    expect(out).toContain("plain tail")
    expect(out).not.toMatch(/listening[ \t]+\n/) // trailing spaces stripped
    expect(out).not.toContain("\n\n\n") // blank spam collapsed
  })
})
