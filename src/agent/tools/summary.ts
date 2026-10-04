import { isMcpToolName } from "../mcp/types.ts"
import { argString } from "./filePlan.ts"

/**
 * Command-prefix arities, mirrored from OpenCode's
 * `packages/opencode/src/permission/arity.ts`. Each key maps to how many leading TOKENS define the
 * "human-understandable command"; flags never count. Longest matching prefix
 * wins. `"docker compose"` is pinned at 2 (the task's expected
 * `docker compose up` → `docker compose `); upstream currently lists 3.
 */
const ARITY: Record<string, number> = {
  cat: 1,
  cd: 1,
  chmod: 1,
  chown: 1,
  cp: 1,
  echo: 1,
  env: 1,
  export: 1,
  grep: 1,
  kill: 1,
  killall: 1,
  ln: 1,
  ls: 1,
  mkdir: 1,
  mv: 1,
  ps: 1,
  pwd: 1,
  rm: 1,
  rmdir: 1,
  sleep: 1,
  source: 1,
  tail: 1,
  touch: 1,
  unset: 1,
  which: 1,
  aws: 3,
  az: 3,
  bazel: 2,
  brew: 2,
  bun: 2,
  "bun run": 3,
  "bun x": 3,
  cargo: 2,
  "cargo add": 3,
  "cargo run": 3,
  cdk: 2,
  cf: 2,
  cmake: 2,
  composer: 2,
  consul: 2,
  "consul kv": 3,
  crictl: 2,
  deno: 2,
  "deno task": 3,
  doctl: 3,
  docker: 2,
  "docker builder": 3,
  "docker compose": 2,
  "docker container": 3,
  "docker image": 3,
  "docker network": 3,
  "docker volume": 3,
  eksctl: 2,
  "eksctl create": 3,
  firebase: 2,
  flyctl: 2,
  gcloud: 3,
  gh: 3,
  git: 2,
  "git config": 3,
  "git remote": 3,
  "git stash": 3,
  go: 2,
  gradle: 2,
  helm: 2,
  heroku: 2,
  hugo: 2,
  ip: 2,
  "ip addr": 3,
  "ip link": 3,
  "ip netns": 3,
  "ip route": 3,
  kind: 2,
  "kind create": 3,
  kubectl: 2,
  "kubectl kustomize": 3,
  "kubectl rollout": 3,
  kustomize: 2,
  make: 2,
  mc: 2,
  "mc admin": 3,
  minikube: 2,
  mongosh: 2,
  mysql: 2,
  mvn: 2,
  ng: 2,
  npm: 2,
  "npm exec": 3,
  "npm init": 3,
  "npm run": 3,
  "npm view": 3,
  nvm: 2,
  nx: 2,
  openssl: 2,
  "openssl req": 3,
  "openssl x509": 3,
  pip: 2,
  pipenv: 2,
  pnpm: 2,
  "pnpm dlx": 3,
  "pnpm exec": 3,
  "pnpm run": 3,
  poetry: 2,
  podman: 2,
  "podman container": 3,
  "podman image": 3,
  psql: 2,
  pulumi: 2,
  "pulumi stack": 3,
  pyenv: 2,
  python: 2,
  rake: 2,
  rbenv: 2,
  "redis-cli": 2,
  rustup: 2,
  serverless: 2,
  sfdx: 3,
  skaffold: 2,
  sls: 2,
  sst: 2,
  swift: 2,
  systemctl: 2,
  terraform: 2,
  "terraform workspace": 3,
  tmux: 2,
  turbo: 2,
  ufw: 2,
  vault: 2,
  "vault auth": 3,
  "vault kv": 3,
  vercel: 2,
  volta: 2,
  wp: 2,
  yarn: 2,
  "yarn dlx": 3,
  "yarn run": 3,
}

/**
 * Arity-aware command prefix (docs/agent.md approval modes): the longest known command
 * prefix, expanded to its arity tokens. `git status --short` → `git status`,
 * `npm run test` → `npm run test`, `git commit -m x` → `git commit`,
 * `rm -rf /` → `rm`, unknown commands → their first token. Pure; no trailing
 * space (see `suggestAllowPrefix`).
 */
export function commandPrefix(command: string): string {
  const tokens = command.trim().split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) return ""
  for (let len = tokens.length; len > 0; len--) {
    const arity = ARITY[tokens.slice(0, len).join(" ")]
    if (arity !== undefined) return tokens.slice(0, arity).join(" ")
  }
  return tokens[0] ?? ""
}

/**
 * Suggested "allow this prefix for this session" value for a command
 * (docs/agent.md approval modes): the arity-aware command prefix plus a
 * trailing space, so allowing `git status ` covers every `git status` variant
 * this session.
 */
export function suggestAllowPrefix(command: string): string {
  const prefix = commandPrefix(command)
  return prefix.length > 0 ? `${prefix} ` : ""
}

/** Short params summary for the tool card's first row. */
export function toolParamsSummary(name: string, args: Record<string, unknown>): string {
  const oneLine = (s: string): string => {
    const one = (s.split("\n")[0] ?? "").trim()
    return one.length > 72 ? `${one.slice(0, 72)}…` : one
  }
  const str = (key: string): string => oneLine(argString(args, key) ?? "")
  switch (name) {
    case "shell_background": {
      const jobRaw = args["job"]
      if (typeof jobRaw === "number" && Number.isFinite(jobRaw)) {
        return args["kill"] === true ? `kill job #${Math.floor(jobRaw)}` : `job #${Math.floor(jobRaw)}${args["wait"] === true ? " (wait)" : ""}`
      }
      return str("command")
    }
    case "shell_session": {
      const rawKeys = args["keys"]
      const keys = Array.isArray(rawKeys) ? rawKeys.map((k) => String(k)).join(",") : ""
      return `${str("text")}${keys.length > 0 ? (str("text").length > 0 ? " " : "") + `[${keys}]` : ""}${args["enter"] === true ? " ⏎" : ""}`
    }
    case "read_file":
      return str("path")
    case "view_image":
      return str("path")
    case "edit_file":
      return str("path")
    case "write_file":
      return str("path")
    case "get_scrollback":
      return String(args["lines"] ?? 500)
    case "ask_user":
      // The question renders in full on the card body — a params peek would
      // duplicate it (truncated) in the header.
      return ""
    case "memory":
      return `${str("action")} ${str("target")}`
    case "host_scan":
      return "read-only machine scan"
    case "session_search": {
      const scope = str("session")
      return `${str("query")}${scope.length > 0 ? ` @ ${scope}` : ""}`
    }
    case "session_list":
      return "recent sessions"
    case "session_view": {
      const off = args["offset"]
      return `${str("session")}${typeof off === "number" && off > 0 ? ` @${Math.floor(off)}` : ""}`
    }
    case "skills_list":
      return "list"
    case "skill_view":
      return str("name")
    case "reload":
      return "config + agents"
    default:
      if (isMcpToolName(name)) {
        // One-line args peek (the JSON the model sent), card-summary clipped.
        let json = ""
        try {
          json = JSON.stringify(args)
        } catch {
          json = ""
        }
        return oneLine(json)
      }
      return ""
  }
}

/**
 * The FULL, untruncated approval-relevant text for a gated tool call — what the
 * user must be able to read before accepting (docs/agent.md "Approval modes",
 * docs/ui.md "Tool cards"). `toolParamsSummary` is deliberately clipped for the
 * card header; a pending card renders this in its body (wrapped, never
 * truncated) so a long/multi-line command or a big MCP args blob can never be
 * approved unseen. Newlines are preserved: a `&&`-continued command is several
 * source lines, and collapsing it to the first line would hide the rest.
 *
 * Null when the header peek already tells the whole story (short single-line
 * commands, file paths, ask_user questions, edit diffs — the latter render in
 * full elsewhere on the card).
 */
export function toolApprovalDetail(name: string, args: Record<string, unknown>): string | null {
  switch (name) {
    case "shell_background": {
      // Job-management calls carry no command to review.
      const jobRaw = args["job"]
      if (typeof jobRaw === "number" && Number.isFinite(jobRaw)) return null
      const cmd = argString(args, "command") ?? ""
      return cmd.length > 0 ? cmd : null
    }
    case "shell_session": {
      const text = argString(args, "text") ?? ""
      return text.length > 0 ? text : null
    }
    default:
      if (isMcpToolName(name)) {
        try {
          return JSON.stringify(args)
        } catch {
          return null
        }
      }
      return null
  }
}
