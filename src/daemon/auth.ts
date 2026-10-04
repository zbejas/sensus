/**
 * Bearer-token auth for the daemon API (docs/daemon-api.md): every request —
 * health/info included — must carry `Authorization: Bearer <token>` or get a
 * JSON `401` with `WWW-Authenticate: Bearer`. The filesystem (`0700` dir /
 * `0600` token) is the first line; this is the second. Comparison is
 * constant-time.
 */

import { timingSafeEqual } from "node:crypto"
import { Elysia } from "elysia"
import { isDocsPath } from "./openapi.ts"

/** Extract the token from an `Authorization` header, or null when absent/malformed. */
export function bearerFrom(header: string | null | undefined): string | null {
  if (typeof header !== "string") return null
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim())
  const token = match?.[1]?.trim()
  return token !== undefined && token.length > 0 ? token : null
}

/** Constant-time string compare; unequal lengths short-circuit to false. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  if (left.length !== right.length) return false
  try {
    return timingSafeEqual(left, right)
  } catch {
    return false
  }
}

/**
 * An Elysia plugin whose global `onBeforeHandle` rejects every request whose
 * bearer token is missing or wrong. `as: "global"` makes it apply to routes
 * registered on the parent instance after `.use()`.
 *
 * The documentation surface (`/openapi*`, `openapi.ts`) is the one exemption:
 * a browser cannot attach the bearer to the initial UI/spec fetch. It still
 * binds the local socket + loopback only and describes no secrets.
 */
export function bearerAuth(token: string) {
  return new Elysia({ name: "sensus-daemon-auth" }).onBeforeHandle({ as: "global" }, ({ request, set }) => {
    let pathname = ""
    try {
      pathname = new URL(request.url).pathname
    } catch {
      pathname = ""
    }
    if (isDocsPath(pathname)) return
    const provided = bearerFrom(request.headers.get("authorization"))
    if (provided === null || !safeEqual(provided, token)) {
      set.status = 401
      set.headers["WWW-Authenticate"] = "Bearer"
      return { error: "unauthorized" }
    }
  })
}
