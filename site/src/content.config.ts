import { defineCollection } from "astro:content"
import { glob } from "astro/loaders"
import { z } from "astro/zod"

// The user manual: one Markdown file per page under src/content/docs/; the
// slug is the filename (the manifest in src/data/docs-manifest.json owns
// order, titles, and status). No MDX dependency: a page opts into a generated
// reference table with the `generated` frontmatter flag.
const docs = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/docs" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    order: z.number(),
    generated: z.enum(["keymap", "commands", "tools"]).optional(),
  }),
})

export const collections = { docs }
