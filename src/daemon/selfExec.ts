/**
 * Self-exec argv for re-launching the sensus binary as the daemon (D15; P4c).
 *
 * Extracted from `src/daemon/cli.ts` into its own Elysia-free module so the
 * client's boot path can reuse it without pulling the daemon's Elysia app into
 * the TUI (see `src/client/daemonEnsure.ts`). `src/daemon/index.ts` still
 * re-exports it for compatibility.
 *
 * In a compiled binary `process.execPath` IS the binary and `Bun.main` is a
 * virtual `/$bunfs/...` path, so only `execPath` is used; in dev `execPath` is
 * `bun` and `Bun.main` is the entry file.
 */

/** The base argv to re-exec the daemon with (no subcommand). */
export function daemonSelfArgv(execPath: string, bunMain: string, compiled: boolean): string[] {
  return compiled ? [execPath] : [execPath, bunMain]
}

/** True when this module is running from a compiled binary's virtual FS. */
export function compiledEntry(): boolean {
  return import.meta.url.includes("$bunfs")
}
