import { installResponse } from "../src/lib/install"

interface PagesContext {
  request: Request
  env?: { GITHUB_TOKEN?: string }
}

/**
 * Cloudflare Pages Function: GET|HEAD /install serves the installer attached
 * to the latest GitHub release (falling back to the installer at the latest
 * tag until that asset ships). All of the logic lives in src/lib/install.ts
 * so it is unit-tested; this file is only the platform adapter.
 *
 * Set the optional GITHUB_TOKEN secret on the Pages project while the
 * repository is private; drop it once the repo and its releases are public.
 */
export function onRequest(context: PagesContext): Promise<Response> {
  return installResponse(context.request, { token: context.env?.GITHUB_TOKEN ?? null })
}
