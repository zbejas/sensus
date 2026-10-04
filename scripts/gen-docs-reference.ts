/**
 * `bun run scripts/gen-docs-reference.ts`: regenerate the committed reference
 * JSON the public site renders (`site/src/data/generated/*.json`).
 *
 * The site build never imports the repo-root `src/` (Cloudflare installs site
 * dependencies only), so the enumerable reference is extracted here and
 * committed. Deterministic by construction: fixed source order, explicit
 * stable sorts, no timestamps. `tests/unit/docs/reference.test.ts` regenerates
 * from these builders and fails when the committed files are stale.
 *
 * Scope (masterplan §7): keymap bindings (`src/core/keymap.ts` + command
 * catalog metadata), slash commands (`src/agent/slash.ts` + catalog labels),
 * and tool names with one-line summaries (`src/agent/tools/specs.ts`).
 * No counts anywhere: the user pages state behavior, not totals.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { SLASH_COMMANDS } from "../src/agent/slash.ts"
import { TOOL_SPECS } from "../src/agent/tools/specs.ts"
import { CATEGORY_LABELS, COMMAND_CATALOG } from "../src/core/commandCatalog.ts"
import { defaultKeyAliases, defaultKeymap, specLabel } from "../src/core/keymap.ts"

/** Display order for the keybinding groups (mirrors the Ctrl+P palette groups). */
const CATEGORY_ORDER: string[] = ["settings", "chat", "help", "tabs", "layout"]

export interface KeymapRow {
  action: string
  keys: string[]
  label: string
  description: string
  category: string
  categoryLabel: string
  slash: string | null
}

export interface CommandRow {
  name: string
  usage: string
  description: string
  label: string | null
  keys: string[]
  category: string | null
}

export interface ToolRow {
  name: string
  summary: string
}

export interface KeymapReference {
  bindings: KeymapRow[]
}

export interface CommandsReference {
  commands: CommandRow[]
}

export interface ToolsReference {
  tools: ToolRow[]
}

/** Locale-independent comparison, so output cannot vary across machines. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Display copy never carries em dashes. A spaced dash introduces an
 * explanation, so it becomes a colon; a bare dash falls back to a hyphen.
 */
function tidy(text: string): string {
  return text.replace(/\s*—\s*/g, ": ").replace(/—/g, "-")
}

/** Every bound action, with its default keys and catalog label. */
export function buildKeymapReference(): KeymapReference {
  const bindings: KeymapRow[] = []
  for (const command of COMMAND_CATALOG) {
    if (command.action === undefined) continue
    const aliases = defaultKeyAliases[command.action] ?? []
    bindings.push({
      action: command.action,
      keys: [specLabel(defaultKeymap[command.action]), ...aliases.map(specLabel)].map(tidy),
      label: tidy(command.label),
      description: tidy(command.description),
      category: command.category,
      categoryLabel: tidy(CATEGORY_LABELS[command.category]),
      slash: command.slash ?? null,
    })
  }
  const rank = (category: string): number => {
    const index = CATEGORY_ORDER.indexOf(category)
    return index === -1 ? CATEGORY_ORDER.length : index
  }
  bindings.sort((a, b) => rank(a.category) - rank(b.category) || compare(a.label, b.label))
  return { bindings }
}

/**
 * The chat commands users type, in the documented menu order (help first).
 * A catalog row with the same slash spelling contributes its label, category,
 * and default keybinding.
 */
export function buildCommandsReference(): CommandsReference {
  const commands: CommandRow[] = SLASH_COMMANDS.map((slash) => {
    const catalog = COMMAND_CATALOG.find((command) => command.slash === `/${slash.name}`)
    const action = catalog?.action
    const aliases = action === undefined ? [] : (defaultKeyAliases[action] ?? [])
    return {
      name: slash.name,
      usage: tidy(slash.usage),
      description: tidy(slash.description),
      label: catalog === undefined ? null : tidy(catalog.label),
      keys:
        action === undefined
          ? []
          : [specLabel(defaultKeymap[action]), ...aliases.map(specLabel)].map(tidy),
      category: catalog?.category ?? null,
    }
  })
  return { commands }
}

/**
 * User-facing one-liners for tool descriptions whose opening sentence names
 * implementation details (`HOST.md`, `config.json`, parameter names). The
 * site's voice rule forbids those on user pages; keep these behavior-accurate.
 */
const SUMMARY_OVERRIDES: Record<string, string> = {
  edit_file: "Replace one exact piece of text in a file with new content.",
  host_scan: "Read-only discovery pass over this machine to draft its architecture map.",
  reload: "Re-read your configuration, custom instructions, agents, and skills from disk.",
}

/** First sentence of a description, or the whole text when it has no boundary. */
function firstSentence(text: string): string {
  const match = /^([\s\S]*?[.!?])(?:\s|$)/.exec(text.trim())
  return (match?.[1] ?? text.trim()).trim()
}

/** Tool names with a one-line summary each, sorted by name. */
export function buildToolsReference(): ToolsReference {
  const tools: ToolRow[] = TOOL_SPECS.map((spec) => ({
    name: spec.function.name,
    summary: tidy(SUMMARY_OVERRIDES[spec.function.name] ?? firstSentence(spec.function.description)),
  }))
  tools.sort((a, b) => compare(a.name, b.name))
  return { tools }
}

/** The exact on-disk form: two-space JSON with a trailing newline. */
export function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function main(): number {
  const outDir = join(import.meta.dir, "..", "site", "src", "data", "generated")
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, "keymap.json"), renderJson(buildKeymapReference()))
  writeFileSync(join(outDir, "commands.json"), renderJson(buildCommandsReference()))
  writeFileSync(join(outDir, "tools.json"), renderJson(buildToolsReference()))
  console.log(`gen-docs-reference: wrote keymap.json, commands.json, tools.json to ${outDir}`)
  return 0
}

// Run only when invoked as the script, so tests can import the builders.
if (import.meta.main) process.exit(main())
