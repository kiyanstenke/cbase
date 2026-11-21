// Codex has no allowlist for its built-in tools: Claude cuts with `--tools`, the engine with `agentTools`, Codex only
// knows three levels — shell and view_image fully off (connectors/codex.js CODEX_WITHOUT_FILE_ACCESS), a read-only sandbox
// (`-s read-only`), or writing like the client. A leaf without imports: the outer loop and the subagent spec factory
// (runs/agents.js) read the same list and the same mapping.

/** Built-in names that let Codex write or run commands — ONE list for execution and frame. */
export const CODEX_WRITES = Object.freeze(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]);

// How strict a mode is (for the "read-only" level: a run that already only reads stays as it is).
const ONLY_READING = new Set(["default", "plan"]);

/**
 * Maps the tool list of a Codex SUBAGENT (cbase_agent `tools`, agent type with a list) onto what Codex can do. Without it
 * a subagent with `["Read","Grep","Glob"]` would keep shell, apply_patch and its client's mode (often full access) while
 * the description says "it gets ONLY what is listed".
 *   `builtin`: the built-in names of the list — `null` = no list (nothing cut, everything like the client).
 *   → `{ codexWithoutFileAccess?: true, permissionMode }`:
 *     - list without built-in names  ⇒ no shell, no view_image (CODEX_WITHOUT_FILE_ACCESS) and read-only;
 *     - read-only names only (Read, Grep, Glob, WebFetch …) ⇒ the shell stays (Codex reads ONLY through it), sandbox read-only;
 *     - a name from CODEX_WRITES ⇒ the client's mode (never more than the client has).
 */
export function codexIntersectionOfTheBuiltins(builtin, permissionMode) {
  if (!Array.isArray(builtin)) return { permissionMode };
  if (builtin.some((t) => CODEX_WRITES.includes(t))) return { permissionMode };
  const reading = ONLY_READING.has(String(permissionMode || "")) ? permissionMode : "default";
  return builtin.length ? { permissionMode: reading } : { codexWithoutFileAccess: true, permissionMode: reading };
}
