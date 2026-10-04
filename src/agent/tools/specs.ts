import type { ToolSpec } from "./types.ts"

// ---- Tool specs (OpenAI function-tool JSON schemas) ------------------------

const obj = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

export const TOOL_SPECS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "shell_background",
      description:
        "Run a shell command in a hidden background shell (NOT the user's visible terminal — the " +
        "user sees NOTHING that happens here). stdout+stderr are captured and returned with the exit " +
        "code. cwd defaults to the user's terminal working directory. Use this to investigate state " +
        "and to make changes the user asked you to perform yourself. For anything the user should " +
        "WATCH happen, use shell_session instead.",
      parameters: obj(
        {
          command: { type: "string", description: "The command line to run (bash)." },
          timeout_s: { type: "number", description: "Kill the command after this many seconds (default 120)." },
          cwd: { type: "string", description: "Working directory; defaults to the user's terminal cwd." },
          background: { type: "boolean", description: "Start detached and return a job id immediately instead of waiting (for long-running commands)." },
          job: { type: "number", description: "Job id from a background start: report its status and new output." },
          wait: { type: "boolean", description: "With job: block until it exits (bounded by timeout_s)." },
          kill: { type: "boolean", description: "With job: kill the job's process group instead of reading it." },
        },
        [],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "shell_session",
      description:
        "Type into the user's VISIBLE terminal — their live shell session, the pane they are " +
        "looking at. The user SEES every keystroke. This is how you drive their terminal: moving " +
        "around, launching editors, running commands they asked to see. Never use shell_background " +
        "for anything the user asked to watch happen in THEIR terminal.",
      parameters: obj(
        {
          text: { type: "string", description: "Literal text to type." },
          keys: {
            type: "array",
            items: { type: "string" },
            description:
              "Special keys to press (in order): enter, tab, escape, backspace, space, up, down, left, " +
              "right, home, end, pageup, pagedown, delete, insert, f1-f12 — with modifiers like " +
              "'ctrl+c', 'alt+x', 'shift+tab' ('c-c'/'m-x' also accepted).",
          },
          enter: { type: "boolean", description: "Append Enter after the text (default false)." },
        },
        [],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file (plain text, truncated to ~64k chars). Relative paths resolve against " +
        "the user's terminal cwd. offset/limit page by lines (offset is 1-based). " +
        "Prefer this over shelling out to sed/awk/head/tail to view a file: it returns a " +
        "bounded, pageable view.",
      parameters: obj(
        {
          path: { type: "string", description: "File path (absolute, ~/..., or relative to the terminal cwd)." },
          offset: { type: "number", description: "First line to show (1-based)." },
          limit: { type: "number", description: "Max lines to show." },
        },
        ["path"],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace the single exact occurrence of old_string in a file with new_string. Fails " +
        "when old_string is not found or appears more than once. A diff card is shown in " +
        "chat; the write happens on approval.",
      parameters: obj(
        {
          path: { type: "string", description: "File path (absolute, ~/..., or relative to the terminal cwd)." },
          old_string: { type: "string", description: "Exact text to replace (include surrounding lines to stay unique)." },
          new_string: { type: "string", description: "Replacement text (empty string deletes)." },
        },
        ["path", "old_string", "new_string"],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a file with content. A diff card is shown when the file already " +
        "exists; the write happens on approval.",
      parameters: obj(
        {
          path: { type: "string", description: "File path (absolute, ~/..., or relative to the terminal cwd)." },
          content: { type: "string", description: "Full file content." },
        },
        ["path", "content"],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "get_scrollback",
      description:
        "Deep-capture the user's visible terminal scrollback (last N lines including the " +
        "live screen) to see what happened there.",
      parameters: obj(
        {
          lines: { type: "number", description: "How many lines (default 500, max 5000)." },
        },
        [],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "view_image",
      description:
        "Look at an image FILE on this machine (png, jpeg, webp, gif) — screenshots, diagrams, " +
        "photos. The picture is added to your context so you can actually see it; describe or act " +
        "on what is in it. Relative paths resolve against the user's terminal cwd. Only offered " +
        "when the selected model accepts image input.",
      parameters: obj(
        {
          path: { type: "string", description: "Image file path (absolute, ~/..., or relative to the terminal cwd)." },
        },
        ["path"],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user a question in chat and WAIT for their answer — the whole agent pauses " +
        "until they reply. The question renders in full (wrapped) with clickable links. " +
        "Provide short options whenever a choice exists — up to 8 (they render as clickable " +
        "buttons) — and use as many as the decision needs. A final \"type your custom answer " +
        "in the chat\" entry is appended automatically, so never add your own other/free-text " +
        "option. Reserve it for genuine forks — a decision that is the user's to make " +
        "(destructive or irreversible choices, missing credentials, ambiguous goals) — not a " +
        "per-step sign-off or a \"what next?\" prompt. Do NOT ask about things you can find " +
        "out yourself (use the read tools first).",
      parameters: obj(
        {
          question: { type: "string", description: "The question; it renders in full (wrapped), so keep it a short paragraph. Details go in your message above the question." },
          options: { type: "array", items: { type: "string" }, description: "Optional choices shown as clickable buttons (1-8 short labels). Do NOT add an other/type-your-own entry — the UI always appends one." },
        },
        ["question"],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "memory",
      description:
        "Maintain your long-term memory. MEMORY.md is always in your system prompt; HOST.md (the " +
        "machine/server architecture map) and JOURNAL.md (episodic log) are NOT — read them with " +
        'action:"list"/"read". Save durable facts (environment conventions, services/ports/paths, ' +
        "lessons learned, user preferences) and SKIP transient noise, secrets, and anything already " +
        "in the prompt. Entries are separated by '§'. Each store has a HARD character cap: an " +
        "over-limit add/replace returns an error with the current entries — consolidate first. " +
        "Duplicate adds are ignored. replace is a FIND-AND-REPLACE: it locates the single entry " +
        "containing old_text and substitutes content for ONLY that matched span, leaving the rest " +
        "of the entry intact (when old_text is the whole entry, the whole entry is replaced). " +
        "replace/remove require old_text to be unique; an ambiguous match lists the candidates. " +
        "remove deletes the whole matched entry. JOURNAL is append-only and ring-trims its oldest " +
        'entries. When MEMORY or HOST is full, use action:"rewrite" to replace the WHOLE store with ' +
        "a condensed body you compose (memory/host only) — merge related entries, drop stale detail, " +
        "and keep every durable fact; do not hand-edit entry by entry unless the change is small. " +
        "Every write reports the character delta; a replace that removes a large fraction is flagged.",
      parameters: obj(
        {
          action: { type: "string", enum: ["add", "replace", "remove", "list", "read", "rewrite"], description: "Operation to perform. rewrite (memory/host only) replaces the whole store with the content body." },
          target: { type: "string", enum: ["memory", "host", "journal"], description: "Which store." },
          content: { type: "string", description: "New text: the entry body for add, the replacement for the matched old_text span in replace, or the full new store body (entries separated by a lone § line) for rewrite." },
          old_text: { type: "string", description: "Exact substring to find: the span replace substitutes, or the entry remove deletes. Must be unique." },
        },
        ["action", "target"],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "host_scan",
      description:
        "Read-only discovery pass over this machine (OS, hostname, disks, listening ports, failed " +
        "services, containers, addresses, git remotes) to DRAFT the HOST.md " +
        "architecture map. Returns a redacted draft; CURATE it into HOST.md with the memory tool " +
        "rather than dumping it verbatim. Use when starting on a new machine or refreshing the map.",
      parameters: obj({}, []),
    },
  },
  {
    type: "function",
    function: {
      name: "session_search",
      description:
        "Search PAST chat sessions (this user's earlier conversations with you) by content — " +
        "useful when they reference something discussed before, or when checking whether a " +
        "question/decision has come up already. Returns newest-first matches with the role, a " +
        "short session id, and a snippet. Narrow to one session with `session` (an id or path " +
        "substring from a previous result). Read-only.",
      parameters: obj(
        {
          query: { type: "string", description: "Words to search for in past messages." },
          session: { type: "string", description: "Optional session id or path substring to search within." },
          limit: { type: "number", description: "Max matches (default 20, max 100)." },
          offset: { type: "number", description: "Skip this many matches (0-based, for paging)." },
        },
        ["query"],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "session_list",
      description:
        "List PAST chat sessions (this user's earlier conversations with you), newest first — " +
        "use it to see what was discussed and to pick a session to open with session_view. " +
        "Returns time, session id, title, message count and tags per session. Paged with " +
        "limit/offset so a long history is read in windows, never all at once. Read-only.",
      parameters: obj(
        {
          limit: { type: "number", description: "Max sessions (default 20, max 100)." },
          offset: { type: "number", description: "Skip this many sessions (0-based, for paging)." },
        },
        [],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "session_view",
      description:
        "View the messages of one PAST chat session, in order (oldest first). Identify it with " +
        "`session` — an id or path substring from session_list/session_search. Paged with " +
        "`offset` (0-based message index) and `limit` so a huge transcript is read in windows, " +
        "never loaded whole; long message bodies are clipped. Check `total` and the trailing " +
        "hint to page. Read-only.",
      parameters: obj(
        {
          session: { type: "string", description: "Session id or path substring from session_list or session_search." },
          offset: { type: "number", description: "First message index to show (0-based; default 0)." },
          limit: { type: "number", description: "Max messages (default 20, max 50)." },
        },
        ["session"],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "skills_list",
      description: "List the available skills with their one-line descriptions. Use skill_view to read a full procedure.",
      parameters: obj({}, []),
    },
  },
  {
    type: "function",
    function: {
      name: "skill_view",
      description:
        "Read a skill's full procedure by name (progressive disclosure). Skills are reusable, " +
        "user-authored or learned procedures under ~/.config/sensus/skills/.",
      parameters: obj(
        { name: { type: "string", description: "Skill name from skills_list." } },
        ["name"],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "reload",
      description:
        "Re-read sensus's own configuration from disk: config.json (endpoints, selected model, " +
        "approval/permission rules, MCP servers), custom instructions (AGENTS.md + the config " +
        "`instructions` list), agent definitions, and skills — the same action as the user's " +
        "/reload command. Call this after you or the user edit any of those files to make the " +
        "change take effect; do NOT type /reload into the user's terminal. Read-only: it never " +
        "writes files (changed MCP servers are restarted in the background).",
      parameters: obj({}, []),
    },
  },
]
