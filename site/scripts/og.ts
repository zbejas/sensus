/**
 * Rasterize src/assets/og.svg into public/og.png (1200x630).
 *
 * Run from site/: `bun run og`. The PNG is committed so the Pages build does
 * not depend on the host's fonts; this script is its provenance.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const svg = readFileSync(join(root, "src/assets/og.svg"))
const out = join(root, "public/og.png")

await sharp(svg).png({ compressionLevel: 9 }).toFile(out)
console.log(`wrote ${out}`)
