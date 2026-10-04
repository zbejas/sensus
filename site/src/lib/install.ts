/**
 * The /install endpoint's logic, kept pure so it is unit-tested and the Pages
 * Function stays a thin adapter (site/functions/install.ts).
 *
 * Sources, in order:
 *   1. the `install.sh` asset attached to the latest GitHub release
 *      (release.yml stages scripts/install-release.sh as install.sh);
 *   2. the installer at the latest release tag (scripts/install-release.sh
 *      first, then the pre-split root install.sh), never `main`, so /install
 *      always serves a released installer.
 *
 * A private repository cannot be fetched anonymously: set the optional
 * GITHUB_TOKEN Pages secret and both steps go through the GitHub API with
 * auth. Public installs still require the repository (and its releases) to be
 * public: the installer itself downloads binaries from GitHub Releases
 * without a token.
 *
 * Successful responses are cached at the edge for a few minutes.
 */

export const RELEASE_ASSET_URL =
  "https://github.com/zbejas/sensus/releases/latest/download/install.sh"

export const LATEST_RELEASE_API = "https://api.github.com/repos/zbejas/sensus/releases/latest"

/** Pre-split releases carried the installer at the repo root. */
const SCRIPT_PATHS = ["scripts/install-release.sh", "install.sh"] as const

export function rawScriptUrl(tag: string, path: string = SCRIPT_PATHS[0]): string {
  return `https://raw.githubusercontent.com/zbejas/sensus/${tag}/${path}`
}

export function contentsApiUrl(tag: string, path: string): string {
  return `https://api.github.com/repos/zbejas/sensus/contents/${path}?ref=${tag}`
}

const CACHE_KEY = "https://sensus.sh/install"
const CACHE_SECONDS = 300

/** The slice of the Cache API this endpoint uses. */
export interface InstallCache {
  match(key: string): Promise<Response | undefined>
  put(key: string, response: Response): Promise<void>
}

export interface InstallDeps {
  fetch?: typeof fetch
  /** `null` disables caching; omitted means "the runtime cache, if any". */
  cache?: InstallCache | null
  /** GitHub token for a private repository; absent/null fetches anonymously. */
  token?: string | null
}

/** The runtime Cache API when running on Cloudflare; absent under Bun. */
export function edgeCache(): InstallCache | null {
  const runtime = globalThis as { caches?: { default?: InstallCache } }
  return runtime.caches?.default ?? null
}

function textResponse(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  })
}

interface ResolvedScript {
  body: string
  source: string
}

interface ReleasePayload {
  tag_name?: unknown
  assets?: Array<{ name?: unknown; url?: unknown }>
}

async function resolveAtLatestTag(
  fetcher: typeof fetch,
  token: string | null,
): Promise<ResolvedScript | null> {
  try {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "sensus-site",
    }
    if (token) headers.authorization = `Bearer ${token}`

    const meta = await fetcher(LATEST_RELEASE_API, { headers })
    if (!meta.ok) return null
    const payload = (await meta.json()) as ReleasePayload
    const tag = typeof payload.tag_name === "string" ? payload.tag_name : ""
    if (!tag) return null

    // Private mode: the release asset and the script both come through the
    // GitHub API (raw.githubusercontent.com is not reliably token-aware).
    if (token) {
      const asset = payload.assets?.find(
        (candidate) => candidate.name === "install.sh" && typeof candidate.url === "string",
      )
      if (asset && typeof asset.url === "string") {
        const response = await fetcher(asset.url, {
          headers: { ...headers, accept: "application/octet-stream" },
        })
        if (response.ok) return { body: await response.text(), source: "release-asset" }
      }

      for (const path of SCRIPT_PATHS) {
        const response = await fetcher(contentsApiUrl(tag, path), {
          headers: { ...headers, accept: "application/vnd.github.raw" },
        })
        if (response.ok) return { body: await response.text(), source: `tag:${tag}` }
      }
      return null
    }

    for (const path of SCRIPT_PATHS) {
      const response = await fetcher(rawScriptUrl(tag, path), { redirect: "follow" })
      if (response.ok) return { body: await response.text(), source: `tag:${tag}` }
    }
    return null
  } catch {
    return null
  }
}

async function resolveScript(fetcher: typeof fetch, token: string | null): Promise<ResolvedScript | null> {
  if (token) return resolveAtLatestTag(fetcher, token)

  try {
    const asset = await fetcher(RELEASE_ASSET_URL, { redirect: "follow" })
    if (asset.ok) return { body: await asset.text(), source: "release-asset" }
  } catch {
    // Network failure: try the tag fallback below.
  }

  return resolveAtLatestTag(fetcher, null)
}

export async function installResponse(
  request: Request,
  deps: InstallDeps = {},
): Promise<Response> {
  const method = request.method.toUpperCase()
  if (method !== "GET" && method !== "HEAD") {
    return textResponse(405, "method not allowed: GET /install returns the installer\n", {
      allow: "GET, HEAD",
    })
  }

  const fetcher = deps.fetch ?? fetch
  const token = deps.token ?? null
  const cache = deps.cache === undefined ? edgeCache() : deps.cache

  if (cache) {
    const hit = await cache.match(CACHE_KEY)
    if (hit) return hit
  }

  const script = await resolveScript(fetcher, token)
  if (!script) {
    return textResponse(
      502,
      "sensus install: could not reach the latest release.\n" +
        "  Retry, or download the installer directly:\n" +
        `  ${RELEASE_ASSET_URL}\n`,
    )
  }

  const response = new Response(method === "HEAD" ? null : script.body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`,
      "x-content-type-options": "nosniff",
      "x-install-source": script.source,
    },
  })

  if (cache && method === "GET") {
    await cache.put(CACHE_KEY, response.clone())
  }

  return response
}
