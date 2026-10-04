import { loadSecrets } from "../secrets.ts"
import { defaultEndpoint, parseSelectedModel } from "./defaults.ts"
import { configPath, sensusHomeFrom } from "./paths.ts"
import { resolveConfig } from "./resolve.ts"
import type { EndpointConfig, SensusConfig } from "./types.ts"

/** Resolve the final config for argv + the real environment (test hook: file
 * may be injected, and process.env is consulted when env is omitted). */
export function loadConfig(argv: readonly string[], env?: NodeJS.ProcessEnv): SensusConfig {
  const e = env ?? (process.env as NodeJS.ProcessEnv)
  const home = sensusHomeFrom(e)
  // Encrypted secrets resolve as an extra env layer: store first, process env
  // second, so `${NAME}` refs in config.json (endpoint apiKey, MCP env/headers)
  // work without the value ever living in the file (docs/config.md "Secrets").
  const secrets = loadSecrets(home)
  const merged = Object.keys(secrets.values).length > 0 ? { ...e, ...secrets.values } : e
  const out = resolveConfig(argv, merged, configPath(home))
  if (secrets.warnings.length > 0) out.warnings.unshift(...secrets.warnings)
  return out
}

/** The endpoint of a resolved config's selected model (always exists). */
export function activeEndpoint(config: SensusConfig): EndpointConfig {
  const selected = parseSelectedModel(config.model)
  const name = selected?.endpoint ?? Object.keys(config.endpoints)[0] ?? "main"
  return config.endpoints[name] ?? defaultEndpoint(name)
}

/** The selected model id (without the endpoint part). */
export function activeModelId(config: SensusConfig): string {
  return parseSelectedModel(config.model)?.model ?? "gpt-5"
}

/** The selected endpoint's name (status bar, pickers). */
export function activeEndpointName(config: SensusConfig): string {
  return parseSelectedModel(config.model)?.endpoint ?? Object.keys(config.endpoints)[0] ?? "main"
}
