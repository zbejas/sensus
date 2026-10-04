#!/usr/bin/env bun
/**
 * npm-style launcher for running sensus from source (`bin` field in
 * package.json — `bun link` / `bunx sensus` style usage). The standalone
 * binary is built separately with `bun run build`.
 */
import "../src/index.tsx"