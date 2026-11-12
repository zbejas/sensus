/**
 * The WebSocket-upgrade HTTP probe (docs/auth.md "Troubleshooting"): a failed
 * upgrade must report the proxy/HTTP answer instead of Bun's opaque error.
 */

import { describe, expect, test } from "bun:test"
import { probeConnectorUpgrade } from "../../../src/daemon/cloud/probe"

function response(status: number, body = "", headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers })
}

describe("probeConnectorUpgrade", () => {
  test("asks the HTTPS connector endpoint with the upgrade headers, never following redirects", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const result = await probeConnectorUpgrade({
      cloud: "https://cloud.example",
      deviceToken: "device-token",
      instanceId: "inst_1",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init })
        // The Response constructor rejects 101; a fetch implementation would
        // surface the upgrade response as this minimal shape.
        return {
          status: 101,
          headers: new Headers(),
          text: async () => "",
        } as unknown as Response
      },
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe(101)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://cloud.example/api/connector")
    expect(calls[0]?.init?.redirect).toBe("manual")
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers["authorization"]).toBe("Bearer device-token")
    expect(headers["x-sensus-instance"]).toBe("inst_1")
    expect(headers["upgrade"]).toBe("websocket")
    expect(headers["connection"]).toBe("Upgrade")
  })

  test("reports a proxy redirect and its HTML body", async () => {
    const result = await probeConnectorUpgrade({
      cloud: "https://cloud.example",
      fetchImpl: async () =>
        response(302, "<html>Sign in to Cloudflare Access</html>", {
          "content-type": "text/html; charset=utf-8",
          location: "https://team.cloudflareaccess.com/",
        }),
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(302)
    expect(result.detail).toContain("HTTP 302")
    expect(result.detail).toContain("text/html")
    expect(result.detail).toContain("https://team.cloudflareaccess.com/")
    expect(result.detail).toContain("Cloudflare Access")
  })

  test("reports a rejected token as HTTP 401", async () => {
    const result = await probeConnectorUpgrade({
      cloud: "https://cloud.example",
      deviceToken: "expired",
      fetchImpl: async () => response(401, JSON.stringify({ error: "unauthorized" }), { "content-type": "application/json" }),
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(result.detail).toContain("HTTP 401")
    expect(result.detail).toContain("unauthorized")
  })

  test("reports a transport failure with status 0", async () => {
    const result = await probeConnectorUpgrade({
      cloud: "https://cloud.example",
      fetchImpl: async () => {
        throw new Error("dial tcp: connection refused")
      },
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(0)
    expect(result.error).toContain("connection refused")
    expect(result.detail).toContain("request failed")
  })

  test("retries without the upgrade headers when fetch rejects them", async () => {
    let calls = 0
    const result = await probeConnectorUpgrade({
      cloud: "https://cloud.example",
      fetchImpl: async () => {
        calls += 1
        if (calls === 1) throw new TypeError("Request headers cannot contain forbidden header: Connection")
        return response(403, "denied", { "content-type": "text/html" })
      },
    })
    expect(calls).toBe(2)
    expect(result.status).toBe(403)
    expect(result.detail).toContain("HTTP 403")
  })

  test("a plain HTTP 200 is not treated as a working upgrade", async () => {
    const result = await probeConnectorUpgrade({
      cloud: "https://cloud.example",
      fetchImpl: async () => response(200, "<html>app</html>", { "content-type": "text/html" }),
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(200)
    expect(result.detail).toContain("text/html")
  })
})
