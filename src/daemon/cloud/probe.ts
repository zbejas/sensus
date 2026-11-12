/**
 * HTTP-level probe for the outbound tunnel (docs/auth.md "Troubleshooting").
 *
 * A failed WebSocket upgrade surfaces in Bun only as "Expected 101 status
 * code", which cannot distinguish a rejected token from a reverse proxy
 * stripping `Upgrade`. When the tunnel fails before its socket opens, it asks
 * this probe for the actual HTTP response and logs the status/content type.
 *
 * The probe never follows redirects (a proxy login page must not receive the
 * device token) and never treats a non-101 response as a working tunnel.
 */

import { errorMessage } from "../../core/util.ts"
import { connectorUrl } from "./state.ts"
import type { FetchLike } from "./pairing.ts"

export interface UpgradeProbeResult {
  /** True only for a real `101 Switching Protocols` response. */
  ok: boolean
  /** HTTP status; 0 when the request never completed. */
  status: number
  contentType: string | null
  location: string | null
  /** One-line human summary for logs/`cloud doctor`. */
  detail: string
  /** Transport error text (null when an HTTP response arrived). */
  error: string | null
}

export interface UpgradeProbeOptions {
  cloud: string
  deviceToken?: string
  instanceId?: string
  fetchImpl?: FetchLike
  timeoutMs?: number
}

/** Collapse a body to a short single-line snippet for the log/doctor output. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim()
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat
}

function describe(status: number, contentType: string | null, location: string | null, body: string): string {
  if (status === 101) return "HTTP 101 Switching Protocols"
  const parts = [`HTTP ${status}`]
  if (contentType !== null && contentType.length > 0) parts.push(contentType)
  if (location !== null && location.length > 0) parts.push(`→ ${location}`)
  const text = snippet(body)
  if (text.length > 0) parts.push(`— ${text}`)
  return parts.join(" ")
}

/**
 * Ask `/api/connector` for its HTTP answer without opening a real WebSocket.
 * `Connection`/`Upgrade` headers make an endpoint that supports WS answer 101
 * (or reject the plain request), while an edge proxy that strips the upgrade
 * answers with its own 3xx/HTML/4xx — exactly the distinguishing signal.
 */
export async function probeConnectorUpgrade(opts: UpgradeProbeOptions): Promise<UpgradeProbeResult> {
  const url = new URL(connectorUrl(opts.cloud))
  url.protocol = url.protocol === "wss:" ? "https:" : "http:"
  const headers: Record<string, string> = {
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64"),
    accept: "*/*",
  }
  if (opts.deviceToken !== undefined) headers["authorization"] = `Bearer ${opts.deviceToken}`
  if (opts.instanceId !== undefined) headers["x-sensus-instance"] = opts.instanceId
  // Some fetch implementations reject the upgrade headers as forbidden. The
  // retry still asks the endpoint (without them) so a proxy's 401/403/HTML is
  // captured instead of only a transport error.
  const plainHeaders: Record<string, string> = {
    accept: "*/*",
    ...(headers["authorization"] !== undefined ? { authorization: headers["authorization"] } : {}),
    ...(headers["x-sensus-instance"] !== undefined ? { "x-sensus-instance": headers["x-sensus-instance"] } : {}),
  }

  const fetchImpl = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000)
  timer.unref?.()
  try {
    let res: Response
    try {
      res = await fetchImpl(url.toString(), {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      })
    } catch (e) {
      if (!/header|forbidden|upgrade/iu.test(errorMessage(e))) throw e
      res = await fetchImpl(url.toString(), {
        method: "GET",
        headers: plainHeaders,
        redirect: "manual",
        signal: controller.signal,
      })
    }
    const contentType = res.headers.get("content-type")
    const location = res.headers.get("location")
    let body = ""
    try {
      body = await res.text()
    } catch {
      // a 101/closed upgrade has no readable body
    }
    return {
      ok: res.status === 101,
      status: res.status,
      contentType,
      location,
      detail: describe(res.status, contentType, location, body),
      error: null,
    }
  } catch (e) {
    const message = errorMessage(e)
    return {
      ok: false,
      status: 0,
      contentType: null,
      location: null,
      detail: `request failed: ${message}`,
      error: message,
    }
  } finally {
    clearTimeout(timer)
  }
}
