import { readFileSync } from "node:fs"
import { defineConfig } from "astro/config"
import sitemap from "@astrojs/sitemap"

// The version shown on the site (the install section's `--version` example)
// comes from the repo's root package.json at build time, so a release bump
// never leaves the site one version behind.
const rootPkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const version = typeof rootPkg.version === "string" ? rootPkg.version : "0.0.0"

// The public site for sensus.sh. Static output; the only dynamic surface is
// the /install Pages Function (site/functions/install.ts), which serves the
// latest release's installer. Cloudflare Pages builds this directory with
// `bun run build` (root directory: site, output: dist).
export default defineConfig({
  site: "https://sensus.sh",
  output: "static",
  integrations: [sitemap()],
  vite: {
    define: {
      __SENSUS_VERSION__: JSON.stringify(version),
    },
  },
})
