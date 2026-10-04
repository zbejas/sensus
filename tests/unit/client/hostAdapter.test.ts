/**
 * hostAdapter — the REST-backed ChatHost facade (docs/config.md `agent`).
 *
 * The regression guarded here: the agent picker / `/agent` must persist the
 * config-FILE key `agent`, not the resolved `SensusConfig.defaultAgent` field.
 * Writing the latter left an unknown top-level key that warned on the next boot.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { HostAdapter } from "../../../src/client/hostAdapter.ts"
import { RestClient } from "../../../src/client/restClient.ts"
import type { WsClient } from "../../../src/client/wsClient.ts"
import type { SensusConfig } from "../../../src/engine/index.ts"
import { startTestDaemon, waitUntil } from "./support.ts"

describe("hostAdapter: default-agent config write", () => {
  test("picking an agent persists `agent` (not the resolved `defaultAgent` field)", async () => {
    const daemon = await startTestDaemon()
    try {
      const rest = new RestClient({ runtimeDir: daemon.runtime, token: daemon.token })
      const host = new HostAdapter({
        rest,
        ws: {} as unknown as WsClient,
        initialConfig: {} as unknown as SensusConfig,
      })

      // setDefaultAgent is fire-and-forget (the ChatHost synchronous contract).
      expect(host.setDefaultAgent("scout")).toBe(null)
      const path = join(daemon.home, "config.json")
      const doc = await waitUntil(() => {
        try {
          const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
          return Object.keys(raw).length > 0 ? raw : null
        } catch {
          return null
        }
      })
      expect(doc.agent).toBe("scout")
      expect("defaultAgent" in doc).toBe(false)
    } finally {
      daemon.cleanup()
    }
  })
})
