import { section } from "../section.ts"

/**
 * Static environment facts. Deliberately stable: cwd, approval mode and the
 * scrollback tail are volatile and ride the per-generation terminal context
 * block instead (docs/agent-context.md "Prompt caching").
 */
export const environmentSection = section("environment", 300, ({ facts }) =>
  [
    "Environment:",
    `- os: ${facts.os}`,
    `- host: ${facts.hostname}`,
    `- shell: ${facts.shell}`,
    "- cwd: the user's terminal working directory — provided per message in the terminal context block; file tools resolve relative paths against it",
    `- model: ${facts.model}`,
    `- terminal: ${facts.terminal}`,
  ].join("\n"),
)
