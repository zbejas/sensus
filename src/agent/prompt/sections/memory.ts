import { section } from "../section.ts"

/**
 * The frozen MEMORY snapshot plus the pointer to the stores it does not carry
 * (HOST.md / JOURNAL.md, read through the memory tool). Frozen per session
 * (docs/memory.md) — a write this session appears in the prompt next session,
 * which is what keeps the prefix cache valid.
 */
export const memorySection = section("memory", 900, ({ facts }) => {
  const memory = facts.memory
  if (memory === undefined || memory === null) return ""
  return [
    "Memory (your notes; maintain it with the memory tool):",
    "══════════════════════════════════════════════",
    `MEMORY [${memory.used}/${memory.limit} chars]`,
    "══════════════════════════════════════════════",
    memory.text.trim().length > 0 ? memory.text.trimEnd() : "(empty — record durable facts worth remembering)",
    "",
    'HOST.md (the machine/server architecture map) and JOURNAL.md (episodic log) are NOT shown here. ALWAYS consult HOST.md with the memory tool (target "host", action "list" or "read") before answering or acting on anything about this machine — its services, ports, paths, dependencies, or configuration — and keep it current. Use target "journal" for the episodic log.',
    'When a store is full (usage at its cap, or a write is rejected for over-limit), run the memory tool with action "rewrite" (target "memory" or "host") to replace the whole store with a condensed body you compose: merge related entries, drop stale detail, and keep every durable fact. Never drop durable facts to make room. For a small change, replace/remove one entry instead.',
  ].join("\n")
})
