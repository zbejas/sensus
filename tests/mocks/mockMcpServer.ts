/**
 * Mock MCP stdio server (docs/mcp.md test support): a standalone bun script
 * speaking newline-delimited JSON-RPC 2.0 on stdin/stdout, spawned by
 * src/agent/mcp/registry.test.ts (and usable in smoke tests).
 *
 * Modes (argv[2]):
 *   (default)  initialize + tools/list {echo, fail}; tools/call echo echoes
 *              `ECHO:<text>`, fail returns isError:true with "boom".
 *   "env"      adds an `envecho` tool: prints `ENV=<MCP_MOCK_ENV>` — proves
 *              the config `env` expansion reached the child process.
 *   "crash"    answers initialize, then exits(1) — down-detection tests.
 *   "slow"     sleeps 3s before every response — timeout tests.
 *   "paged"    tools/list paginates: page 1 {echo} + nextCursor "p2",
 *              page 2 {fail} — exercises the cursor loop.
 *   "cwd"      adds a `pwd` tool: returns `CWD=<process.cwd()>` — proves the
 *              registry spawns the child in its resolved per-server dir.
 */

interface JsonRpcMessage {
  jsonrpc: string
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string }
}

const mode = process.argv[2] ?? "default"

function send(msg: JsonRpcMessage): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

function reply(id: number | string | undefined, result: unknown): void {
  if (id === undefined) return
  send({ jsonrpc: "2.0", id, result })
}

function replyError(id: number | string | undefined, code: number, message: string): void {
  if (id === undefined) return
  send({ jsonrpc: "2.0", id, error: { code, message } })
}

const tools = (): Array<Record<string, unknown>> => {
  const list: Array<Record<string, unknown>> = [
    {
      name: "echo",
      description: "Echo the input text back",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    {
      name: "fail",
      description: "Always fails (isError result)",
      inputSchema: { type: "object", properties: {} },
    },
  ]
  if (mode === "env") {
    list.push({
      name: "envecho",
      description: "Prints the MCP_MOCK_ENV value",
      inputSchema: { type: "object", properties: {} },
    })
  }
  if (mode === "cwd") {
    list.push({
      name: "pwd",
      description: "Prints the server process working directory",
      inputSchema: { type: "object", properties: {} },
    })
  }
  return list
}

const callResult = (method: string, params: Record<string, unknown>): unknown => {
  const name = String(params["name"] ?? "")
  const args = (params["arguments"] ?? {}) as Record<string, unknown>
  if (name === "echo") {
    return { content: [{ type: "text", text: `ECHO:${String(args["text"] ?? "")}` }] }
  }
  if (name === "fail") {
    return { content: [{ type: "text", text: "boom" }], isError: true }
  }
  if (name === "envecho") {
    return { content: [{ type: "text", text: `ENV=${process.env["MCP_MOCK_ENV"] ?? ""}` }] }
  }
  if (name === "pwd") {
    return { content: [{ type: "text", text: `CWD=${process.cwd()}` }] }
  }
  return { content: [{ type: "text", text: `mock: unknown tool "${name}"` }], isError: true }
}

let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buf += chunk
  let nl: number
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (line.trim().length === 0) continue
    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(line) as JsonRpcMessage
    } catch {
      continue
    }
    handle(msg)
  }
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function handle(msg: JsonRpcMessage): Promise<void> {
  if (msg.method === undefined) return
  const id = msg.id
  if (msg.method.startsWith("notifications/")) {
    return // no reply for notifications
  }
  if (mode === "slow") await sleep(3000)
  switch (msg.method) {
    case "initialize":
      reply(id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-mcp", version: "1.0.0" },
      })
      if (mode === "crash") process.exit(1)
      return
    case "tools/list": {
      const cursor = typeof msg.params?.["cursor"] === "string" ? (msg.params["cursor"] as string) : undefined
      if (mode === "paged") {
        if (cursor === undefined) reply(id, { tools: [tools()[0]], nextCursor: "p2" })
        else reply(id, { tools: [tools()[1]] })
        return
      }
      reply(id, { tools: tools() })
      return
    }
    case "tools/call":
      reply(id, callResult(msg.method, msg.params ?? {}))
      return
    default:
      replyError(id, -32601, `method not found: ${msg.method}`)
  }
}

// Keep the process alive; sensus kills us on stopAll.
process.on("SIGTERM", () => process.exit(0))
