import { describe, expect, test } from "bun:test"
import { modelDetailLines, rankModels } from "../../../../src/ui/components/ModelPicker.tsx"
import type { PickerModel } from "../../../../src/ui/components/ModelPicker.tsx"
import { fuzzyScore } from "../../../../src/ui/lib/fuzzy.ts"

const model = (id: string, endpoint: string, chat = true): PickerModel => ({
  id,
  endpoint,
  ownedBy: null,
  endpointTypes: chat ? ["chat_completions"] : ["embeddings"],
  chat,
  meta: null,
})

const CATALOG: readonly PickerModel[] = [
  model("zeta", "main"),
  model("alpha", "main"),
  model("embed-1", "main", false),
  model("beta", "ollama"),
]

describe("rankModels (model picker ordering)", () => {
  test("an empty query preserves the endpoint order verbatim (no chat hoist, no id sort); filtered-out models drop", () => {
    expect(rankModels(CATALOG, "").map((m) => m.id)).toEqual(["zeta", "alpha", "embed-1", "beta"])
    expect(rankModels(CATALOG, "embed").map((m) => m.id)).toEqual(["embed-1"])
  })

  test("filtering ranks by fuzzy score (label or endpoint/id) with ties keeping endpoint order", () => {
    // 'a' hits alpha (substring, pos 0) best; zeta/beta tie on subsequence.
    const res = rankModels(CATALOG, "a")
    expect(res[0]?.id).toBe("alpha")
    const rest = res.slice(1).map((m) => m.id)
    expect(rest).toContain("zeta")
    expect(rest).toContain("beta")
    expect(fuzzyScore("a", "alpha")).toBeGreaterThan(fuzzyScore("a", "zeta") ?? -1)
    // "olb" is a subsequence of "ollama/beta" but not of "beta" alone.
    expect(rankModels(CATALOG, "olb").map((m) => m.id)).toEqual(["beta"])
  })

  test("'endpoint@' scopes the query: scope alone narrows without filtering, scope + text does both, foreign endpoints never match", () => {
    const scoped = rankModels(CATALOG, "ollama@")
    expect(scoped.map((m) => m.id)).toEqual(["beta"])
    expect(scoped.every((m) => m.endpoint === "ollama")).toBe(true)
    expect(rankModels(CATALOG, "main@alph").map((m) => m.id)).toEqual(["alpha"])
    expect(rankModels(CATALOG, "ollama@alph").map((m) => m.id)).toEqual([])
  })
})

describe("modelDetailLines (bounded detail pane)", () => {
  const rich: PickerModel = {
    id: "llama-3.1-8b",
    endpoint: "main",
    ownedBy: "meta",
    endpointTypes: ["chat_completions", "responses"],
    chat: true,
    meta: {
      id: "llama-3.1-8b",
      provider: "meta",
      name: "Llama 3.1 8B",
      context: 128000,
      output: null,
      toolCall: true,
      costInputPerMtok: null,
      costOutputPerMtok: null,
      reasoning: true,
      reasoningOptions: [],
      temperatureSupported: null,
    },
  }

  test("surfaces every model fact and the active tag", () => {
    const lines = modelDetailLines(rich, "main@llama-3.1-8b")
    const joined = lines.join("\n")
    expect(lines).toHaveLength(4)
    expect(joined).toContain("main@llama-3.1-8b")
    expect(joined).toContain("Llama 3.1 8B")
    expect(joined).toContain("128k")
    expect(joined).toContain("tools yes")
    expect(joined).toContain("reasoning yes")
    expect(joined).toContain("owned by   meta")
    expect(joined).toContain("chat_completions, responses")
    expect(joined).toContain("← active")
    // A different session model drops the tag and tags embeddings rows.
    const other = modelDetailLines(rich, "other@x")
    expect(other.join("\n")).not.toContain("← active")
    expect(modelDetailLines({ ...rich, chat: false }, "x@y").join("\n")).toContain("(embeddings)")
  })

  test("unknown metadata renders placeholders instead of blank fields", () => {
    const bare = modelDetailLines({ ...model("mystery", "proxy"), endpointTypes: [] }, "x@y")
    const joined = bare.join("\n")
    expect(joined).toContain("(unknown)")
    expect(joined).toContain("tools ?")
    expect(joined).toContain("reasoning ?")
    expect(joined).toContain("types —")
  })
})
