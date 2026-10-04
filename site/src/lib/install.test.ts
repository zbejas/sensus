import { describe, expect, test } from "bun:test"
import {
  contentsApiUrl,
  installResponse,
  LATEST_RELEASE_API,
  rawScriptUrl,
  RELEASE_ASSET_URL,
  type InstallCache,
} from "./install"

const SCRIPT = "#!/usr/bin/env bash\n# sensus release installer\n"
const TAG = "v0.0.95"

interface Call {
  url: string
  headers: Record<string, string>
}

/** A fetch stub: URLs map to responses; unmapped URLs 404. */
function fakeFetch(
  routes: Record<string, () => Response | Promise<Response>>,
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) })
    const route = routes[url]
    return route ? route() : new Response("not found", { status: 404 })
  }
  return { fetch: impl as typeof fetch, calls }
}

function memoryCache(): InstallCache & { entries: Map<string, Response> } {
  const entries = new Map<string, Response>()
  return {
    entries,
    match: async (key) => entries.get(key)?.clone(),
    put: async (key, response) => {
      entries.set(key, response.clone())
    },
  }
}

function request(method = "GET"): Request {
  return new Request("https://sensus.sh/install", { method })
}

describe("/install", () => {
  test("serves the release asset when the release carries install.sh", async () => {
    const { fetch, calls } = fakeFetch({
      [RELEASE_ASSET_URL]: () => new Response(SCRIPT, { status: 200 }),
    })

    const response = await installResponse(request(), { fetch, cache: null })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(response.headers.get("x-install-source")).toBe("release-asset")
    expect(await response.text()).toBe(SCRIPT)
    expect(calls.map((call) => call.url)).toEqual([RELEASE_ASSET_URL])
  })

  test("falls back across both script layouts at the latest release tag", async () => {
    // Pre-split releases carry the installer at the repo root only.
    const { fetch, calls } = fakeFetch({
      [LATEST_RELEASE_API]: () => Response.json({ tag_name: TAG }),
      [rawScriptUrl(TAG, "install.sh")]: () => new Response(SCRIPT, { status: 200 }),
    })

    const response = await installResponse(request(), { fetch, cache: null })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-install-source")).toBe(`tag:${TAG}`)
    expect(await response.text()).toBe(SCRIPT)
    expect(calls.map((call) => call.url)).toEqual([
      RELEASE_ASSET_URL,
      LATEST_RELEASE_API,
      rawScriptUrl(TAG, "scripts/install-release.sh"),
      rawScriptUrl(TAG, "install.sh"),
    ])
  })

  test("uses the GitHub API with a token when the repository is private", async () => {
    const assetUrl = "https://api.github.com/repos/zbejas/sensus/releases/assets/1"
    const { fetch, calls } = fakeFetch({
      [LATEST_RELEASE_API]: () =>
        Response.json({
          tag_name: TAG,
          assets: [
            { name: "sensus-linux-x64", url: "https://api.github.com/assets/bin" },
            { name: "install.sh", url: assetUrl },
          ],
        }),
      [assetUrl]: () => new Response(SCRIPT, { status: 200 }),
    })

    const response = await installResponse(request(), { fetch, cache: null, token: "test-token" })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-install-source")).toBe("release-asset")
    expect(await response.text()).toBe(SCRIPT)
    expect(calls[0]?.headers["authorization"]).toBe("Bearer test-token")
    expect(calls[1]?.url).toBe(assetUrl)
    expect(calls[1]?.headers["accept"]).toBe("application/octet-stream")

    // Without the install.sh asset, the private path reads the script through
    // the contents API instead.
    const contents = fakeFetch({
      [LATEST_RELEASE_API]: () => Response.json({ tag_name: TAG, assets: [] }),
      [contentsApiUrl(TAG, "install.sh")]: () => new Response(SCRIPT, { status: 200 }),
    })
    const fallback = await installResponse(request(), {
      fetch: contents.fetch,
      cache: null,
      token: "test-token",
    })
    expect(fallback.headers.get("x-install-source")).toBe(`tag:${TAG}`)
    expect(await fallback.text()).toBe(SCRIPT)
  })

  test("answers 502 with a recovery path when the release cannot be reached", async () => {
    const { fetch } = fakeFetch({
      [RELEASE_ASSET_URL]: () => {
        throw new Error("network down")
      },
      [LATEST_RELEASE_API]: () => new Response("rate limited", { status: 403 }),
    })

    const response = await installResponse(request(), { fetch, cache: null })

    expect(response.status).toBe(502)
    expect(await response.text()).toContain(RELEASE_ASSET_URL)
  })

  test("HEAD answers headers only; other methods are refused", async () => {
    const { fetch } = fakeFetch({
      [RELEASE_ASSET_URL]: () => new Response(SCRIPT, { status: 200 }),
    })

    const head = await installResponse(request("HEAD"), { fetch, cache: null })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")

    const post = await installResponse(request("POST"), { fetch, cache: null })
    expect(post.status).toBe(405)
    expect(post.headers.get("allow")).toBe("GET, HEAD")
  })

  test("caches a successful GET at the edge and serves the cached copy", async () => {
    const cache = memoryCache()
    const { fetch, calls } = fakeFetch({
      [RELEASE_ASSET_URL]: () => new Response(SCRIPT, { status: 200 }),
    })

    const first = await installResponse(request(), { fetch, cache })
    expect(first.status).toBe(200)
    expect(cache.entries.size).toBe(1)

    const second = await installResponse(request(), { fetch, cache })
    expect(await second.text()).toBe(SCRIPT)
    expect(calls.length).toBe(1)

    // A failed resolve is never cached.
    const failing = fakeFetch({})
    await installResponse(request(), { fetch: failing.fetch, cache })
    expect(cache.entries.size).toBe(1)
  })
})
