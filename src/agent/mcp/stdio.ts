/**
 * MCP stdio transport (docs/mcp.md): newline-delimited JSON-RPC 2.0 over the
 * child's stdin/stdout (MCP messages never contain embedded newlines).
 * stderr is CAPTURED (ring buffer, ~4k) — never inherited, it would corrupt
 * the TUI's alt-screen. The child is spawned in its own session (setsid) when
 * possible so close() takes the whole process group with it.
 */

import type { JsonRpcMessage } from "./jsonrpc.ts"
import { errorMessage } from "../../core/util.ts"
import { componentLogger } from "../log.ts"

const log = componentLogger("agent.mcp")

export interface StdioSpawnOpts {
  name: string
  command: string
  args: string[]
  /** Full merged environment for the child. */
  env: Record<string, string>
  /** Child working directory (never the sensus process cwd; docs/mcp.md). */
  cwd?: string
}

/** setsid probe — shared with tools.ts via processUtil (the transport stays
  * decoupled from the tool layer; this module is neutral). */
import { haveSetsid, killProcessTree } from "../processUtil.ts"

export class StdioTransport {
  private proc: ReturnType<typeof Bun.spawn> | null = null
  private stderrTail: string[] = []
  private decoder = new TextDecoder()
  private lineBuf = ""
  private closed = false

  /** Resolve once the child is spawned and the pumps are running. */
  async start(handlers: {
    onMessage(msg: JsonRpcMessage): void
    onDown(err: string): void
  }): Promise<void> {
    const useSetsid = haveSetsid()
    const argv = useSetsid ? ["setsid", this.opts.command, ...this.opts.args] : [this.opts.command, ...this.opts.args]
    const proc = Bun.spawn(argv, {
      env: this.opts.env,
      cwd: this.opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    this.proc = proc

    const parseLine = (line: string): void => {
      const trimmed = line.trim()
      if (trimmed.length === 0) return
      try {
        const msg = JSON.parse(trimmed) as JsonRpcMessage
        if (msg !== null && typeof msg === "object") handlers.onMessage(msg)
      } catch (e) {
        // non-JSON stdout line (chatty server) — ignore
        log.debug("mcp stdio non-JSON stdout line ignored", { mcp: this.opts.name, err: e })
      }
    }

    void this.pump(proc.stdout, parseLine)
    void this.pump(
      proc.stderr,
      (chunk) => {
        // keep the tail; cap total memory
        this.stderrTail.push(chunk)
        while (this.stderrTail.length > 16) this.stderrTail.shift()
        while (this.stderrTail.join("").length > 4096 && this.stderrTail.length > 1) this.stderrTail.shift()
      },
      true,
    )

    void proc.exited.then((code) => {
      if (!this.closed) handlers.onDown(`server exited (code ${code ?? "?"})${this.stderrSuffix()}`)
    })
  }

  private readonly opts: StdioSpawnOpts

  constructor(opts: StdioSpawnOpts) {
    this.opts = opts
  }

  private stderrSuffix(): string {
    const tail = this.stderrTail.join("").trim()
    if (tail.length === 0) return ""
    const one = tail.split("\n").pop() ?? ""
    return `: ${one.slice(0, 200)}`
  }

  private async pump(
    stream: ReadableStream<Uint8Array> | null,
    fn: (chunk: string) => void,
    raw = false,
  ): Promise<void> {
    if (!stream) return
    try {
      for await (const bytes of stream) {
        if (raw) {
          fn(this.decoder.decode(bytes, { stream: true }))
          continue
        }
        this.lineBuf += this.decoder.decode(bytes, { stream: true })
        let nl: number
        while ((nl = this.lineBuf.indexOf("\n")) !== -1) {
          const line = this.lineBuf.slice(0, nl)
          this.lineBuf = this.lineBuf.slice(nl + 1)
          fn(line)
        }
      }
      if (this.lineBuf.length > 0) fn(this.lineBuf)
      this.lineBuf = ""
    } catch (e) {
      // stream died (close/kill) — whatever arrived is enough
      log.warn("mcp stdio stream died mid-pump", { mcp: this.opts.name, err: e })
    }
  }

  send(msg: JsonRpcMessage): void {
    if (this.closed || !this.proc?.stdin) throw new Error(`mcp ${this.opts.name}: server is not running`)
    const stdin = this.proc.stdin
    if (typeof stdin === "number") throw new Error(`mcp ${this.opts.name}: stdin is not a sink`)
    try {
      stdin.write(`${JSON.stringify(msg)}\n`)
    } catch (e) {
      throw new Error(`mcp ${this.opts.name}: write failed (${errorMessage(e)})`)
    }
  }

  /** Kill the child (process group when setsid wrapped it). Returns only
   * after the child is dead (TERM → bounded wait → SIGKILL), so shutdown
   * never orphans a server by exiting mid-kill. */
  async close(): Promise<void> {
    const proc = this.proc
    if (!proc || this.closed) return
    this.closed = true
    try {
      if (typeof proc.stdin !== "number") proc.stdin?.end()
    } catch (e) {
      // already closed
      log.debug("mcp stdio stdin end failed on close", { mcp: this.opts.name, err: e })
    }
    killProcessTree(proc, false) // TERM the group (setsid: child pid IS the group)
    const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(400).then(() => false)])
    if (!exited) {
      killProcessTree(proc, true) // SIGKILL escalation
      await Promise.race([proc.exited, Bun.sleep(400)])
    }
  }
}

