import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../../../src/config/config.ts"
import {
  captureSecrets,
  deleteSecret,
  isSecretRef,
  listSecretNames,
  loadSecrets,
  migrateConfigSecrets,
  resolveSecretValue,
  secretRefName,
  secretsKeyPath,
  secretsPath,
  setSecret,
} from "../../../src/config/secrets.ts"
import { handleCli, type CliIo } from "../../../src/cli.ts"

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "sensus-secrets-"))
}

function io(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err }
}

/** Write a config.json into a sandbox and return its path. */
function writeConfig(home: string, doc: unknown): void {
  writeFileSync(join(home, "config.json"), JSON.stringify(doc, null, 2))
}

function env(home: string): NodeJS.ProcessEnv {
  return { HOME: home, SENSUS_HOME: home, PATH: process.env["PATH"] ?? "/usr/bin" }
}

describe("secrets store", () => {
  test("round-trips encrypted at rest, is never plaintext on disk, key file is 0600", () => {
    const home = sandbox()
    try {
      const res = setSecret(home, "OPENAI_API_KEY", "sk-super-secret-value")
      expect(res.ok).toBe(true)
      expect(res.keyCreated).toBe(true)

      // The value is not readable in the store file, and the envelope is marked.
      const raw = readFileSync(secretsPath(home), "utf8")
      expect(raw).not.toContain("sk-super-secret-value")
      expect(raw).toContain("aes-256-gcm")

      // Key + store are owner-only.
      expect(statSync(secretsKeyPath(home)).mode & 0o777).toBe(0o600)
      expect(statSync(secretsPath(home)).mode & 0o777).toBe(0o600)

      const loaded = loadSecrets(home)
      expect(loaded.unavailable).toBe(false)
      expect(loaded.plaintext).toBe(false)
      expect(loaded.values["OPENAI_API_KEY"]).toBe("sk-super-secret-value")

      // set preserves other entries; rm removes one.
      setSecret(home, "KANEO_API_KEY", "k-1")
      setSecret(home, "OPENAI_API_KEY", "sk-rotated")
      expect(listSecretNames(home)).toEqual(["KANEO_API_KEY", "OPENAI_API_KEY"])
      expect(loadSecrets(home).values["OPENAI_API_KEY"]).toBe("sk-rotated")
      deleteSecret(home, "KANEO_API_KEY")
      expect(listSecretNames(home)).toEqual(["OPENAI_API_KEY"])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("a plaintext store is usable but flagged for migration", () => {
    const home = sandbox()
    try {
      writeFileSync(secretsPath(home), JSON.stringify({ OLD_KEY: "sk-old", JUNK: 42 }))
      const loaded = loadSecrets(home)
      expect(loaded.plaintext).toBe(true)
      expect(loaded.unavailable).toBe(false)
      expect(loaded.values["OLD_KEY"]).toBe("sk-old")
      expect(loaded.values["JUNK"]).toBeUndefined() // non-strings dropped
      expect(loaded.warnings.some((w) => w.includes("plaintext"))).toBe(true)

      // migrate encrypts it in place without losing the value.
      const migrated = migrateConfigSecrets(home)
      expect(migrated.ok).toBe(true)
      expect(readFileSync(secretsPath(home), "utf8")).toContain("aes-256-gcm")
      expect(loadSecrets(home).plaintext).toBe(false)
      expect(loadSecrets(home).values["OLD_KEY"]).toBe("sk-old")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("an unreadable store is never clobbered by set/rm/capture", () => {
    const home = sandbox()
    try {
      setSecret(home, "KEEP", "v")
      chmodSync(secretsKeyPath(home), 0o600)
      rmSync(secretsKeyPath(home)) // key gone -> ciphertext unreadable

      expect(loadSecrets(home).unavailable).toBe(true)
      expect(setSecret(home, "NEW", "x").ok).toBe(false)
      expect(deleteSecret(home, "KEEP").ok).toBe(false)
      const cfg = { endpoints: { main: { apiKey: "literal" } } }
      expect(captureSecrets(home, cfg).error).toBeDefined()
      // The original ciphertext survived (no empty overwrite).
      expect(readFileSync(secretsPath(home), "utf8")).toContain("aes-256-gcm")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("captureSecrets routes endpoint keys and MCP credential-ish values into the store", () => {
    const home = sandbox()
    try {
      const doc = {
        endpoints: {
          main: { baseURL: "https://api.openai.com/v1", apiKey: "sk-literal" },
          ollama: { baseURL: "http://x/v1", apiKey: "" },
        },
        mcp: {
          servers: {
            firecrawl: { url: "https://mcp.firecrawl.dev/mcp", headers: { Authorization: "Bearer sk-fc" } },
            local: { command: "node", env: { NODE_ENV: "production", KANEO_API_KEY: "kaneo-secret" } },
          },
        },
      }
      const captured = captureSecrets(home, doc)
      expect(captured.error).toBeUndefined()
      expect(captured.moved.sort()).toEqual(["FIRECRAWL_AUTHORIZATION", "LOCAL_KANEO_API_KEY", "MAIN_API_KEY"])

      const out = captured.doc as typeof doc
      expect(out.endpoints.main.apiKey).toBe("${MAIN_API_KEY}")
      expect(out.endpoints.ollama.apiKey).toBe("")
      expect(out.mcp.servers.firecrawl.headers.Authorization).toBe("${FIRECRAWL_AUTHORIZATION}")
      expect(out.mcp.servers.local.env.KANEO_API_KEY).toBe("${LOCAL_KANEO_API_KEY}")
      // Non-secret env is left alone.
      expect(out.mcp.servers.local.env.NODE_ENV).toBe("production")
      // The caller's document is not mutated (capture clones).
      expect(doc.endpoints.main.apiKey).toBe("sk-literal")

      const values = loadSecrets(home).values
      expect(values["MAIN_API_KEY"]).toBe("sk-literal")
      expect(values["FIRECRAWL_AUTHORIZATION"]).toBe("Bearer sk-fc")
      expect(values["LOCAL_KANEO_API_KEY"]).toBe("kaneo-secret")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("ref helpers accept exactly a whole-string ${NAME}", () => {
    expect(isSecretRef("${OPENAI_API_KEY}")).toBe(true)
    expect(secretRefName(" ${FOO_2} ")).toBe("FOO_2")
    expect(isSecretRef("Bearer ${FOO}")).toBe(false)
    expect(isSecretRef("sk-literal")).toBe(false)
    expect(secretRefName("nope")).toBeNull()
  })
})

describe("secrets resolution + migration", () => {
  test("${NAME} in endpoint apiKey and MCP headers resolves from the store, then process env", () => {
    const home = sandbox()
    try {
      setSecret(home, "MAIN_API_KEY", "sk-from-store")
      // FC_KEY is deliberately NOT in the store — the process env supplies it.
      writeConfig(home, {
        endpoints: { main: { baseURL: "https://api.openai.com/v1", apiKey: "${MAIN_API_KEY}" } },
        mcp: {
          servers: {
            firecrawl: { url: "https://mcp.firecrawl.dev/mcp", headers: { Authorization: "Bearer ${FC_KEY}" } },
          },
        },
      })
      const c = loadConfig([], { ...env(home), FC_KEY: "sk-from-env" })
      expect(c.endpoints["main"]?.apiKey).toBe("sk-from-store")
      expect(c.mcp.servers["firecrawl"]?.headers?.Authorization).toBe("Bearer sk-from-env")
      // The store wins over a same-named process env var.
      const c2 = loadConfig([], { ...env(home), MAIN_API_KEY: "sk-from-env" })
      expect(c2.endpoints["main"]?.apiKey).toBe("sk-from-store")

      // resolveSecretValue (UI one-off requests) uses the same precedence.
      expect(resolveSecretValue("${MAIN_API_KEY}", home)).toBe("sk-from-store")
      expect(resolveSecretValue("sk-literal", home)).toBe("sk-literal")
      expect(resolveSecretValue("Bearer ${FC_KEY}", home, { ...env(home), FC_KEY: "sk-env" })).toBe("Bearer sk-env")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("migrate moves config.json's plaintext keys into the encrypted store and rewrites refs", () => {
    const home = sandbox()
    try {
      writeConfig(home, {
        endpoints: { main: { baseURL: "https://api.openai.com/v1", apiKey: "sk-plain" } },
        mcp: { servers: { firecrawl: { url: "https://mcp.firecrawl.dev/mcp", headers: { Authorization: "Bearer sk-fc" } } } },
      })
      const res = migrateConfigSecrets(home)
      expect(res.ok).toBe(true)
      expect(res.updatedConfig).toBe(true)
      expect(res.moved.sort()).toEqual(["FIRECRAWL_AUTHORIZATION", "MAIN_API_KEY"])

      // config.json is plaintext-free and references the store; a .bak exists.
      const cfgText = readFileSync(join(home, "config.json"), "utf8")
      expect(cfgText).not.toContain("sk-plain")
      expect(cfgText).not.toContain("sk-fc")
      expect(cfgText).toContain("${MAIN_API_KEY}")
      expect(existsSync(join(home, "config.json.bak"))).toBe(true)

      // And resolution loads the moved values transparently.
      const c = loadConfig([], env(home))
      expect(c.endpoints["main"]?.apiKey).toBe("sk-plain")
      expect(c.mcp.servers["firecrawl"]?.headers?.Authorization).toBe("Bearer sk-fc")

      // A second migrate is a no-op.
      const again = migrateConfigSecrets(home)
      expect(again.moved).toEqual([])
      expect(again.updatedConfig).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("sensus secrets CLI", () => {
  test("set/list/rm/migrate run headlessly under SENSUS_HOME", () => {
    const home = sandbox()
    try {
      const a = io()
      expect(handleCli(["secrets", "set", "TEST_KEY", "sk-1"], a.io, env(home))).toEqual({ action: "exit", code: 0 })
      expect(a.out.join("\n")).toContain("${TEST_KEY}")

      const b = io()
      handleCli(["secrets", "list"], b.io, env(home))
      expect(b.out).toEqual(["TEST_KEY"])

      // Migration picks up a plaintext config written alongside.
      writeConfig(home, { endpoints: { main: { apiKey: "sk-plain" } } })
      const c = io()
      handleCli(["secrets", "migrate"], c.io, env(home))
      expect(c.out.join("\n")).toContain("${MAIN_API_KEY}")

      const d = io()
      handleCli(["secrets", "rm", "TEST_KEY"], d.io, env(home))
      expect(d.out.join("\n")).toContain("removed TEST_KEY")

      // Bad name is rejected without writing.
      const e = io()
      expect(handleCli(["secrets", "set", "bad-name", "x"], e.io, env(home))).toEqual({ action: "exit", code: 1 })
      expect(e.err.join("\n")).toContain("NAME must match")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
