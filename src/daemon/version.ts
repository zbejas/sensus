/**
 * The client's version-handshake decision (D21), extracted from
 * `src/daemon/lifecycle.ts` into its own Elysia-free module so the client can
 * import it without loading Elysia (see `src/client/daemonEnsure.ts`).
 * `src/daemon/index.ts` still re-exports it for compatibility.
 */

/**
 * The client's version-handshake decision (D21). Pure: `ok` when the versions
 * match; `restart` when the daemon holds no shells (a restart loses nothing);
 * `warn` when it holds shells (the user chooses restart-and-lose or defer).
 */
export function versionMismatchAction(
  localVersion: string,
  remoteVersion: string,
  heldShells: number,
): "ok" | "restart" | "warn" {
  if (localVersion === remoteVersion) return "ok"
  return heldShells > 0 ? "warn" : "restart"
}
