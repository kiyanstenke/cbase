// MCP tools: variables, workspace context and LSP (cbase_vars_*, workspace_context_*, lsp, lsp_edit).
// One contiguous slice of the tool array, in source order: cbase-mcp.js spreads the groups back together into TOOLS; the order
// is part of the prompt prefix (cache), guard: server/backend/test/mcp-catalog.test.js.

import { api, enc, int, needWorkspace, obj, qs, scopeWorkspace, str, varsBase } from "../lib.js";
import { CREDENTIALS_AREA } from "../credentials-set.js";

// The actions of the agents' language service: the second copy of `AGENT_READ`/`AGENT_CHANGE` from server/lsp/contract.js (this
// process never imports the server tree, import-direction.test.js (j)); bound via tools/list in test/mcp-schema.test.js.
const LSP_READ = Object.freeze(["diagnostics", "definition", "type_definition", "implementations", "references", "call_hierarchy", "hover", "outline", "completions", "workspace_symbols", "code_actions"]);
const LSP_CHANGE = Object.freeze(["rename", "format", "code_action"]);
const LSP_KINDS = Object.freeze(["quickfix", "refactor", "source"]);

const workspaceTools = [
  {
    name: "cbase_vars_list",
    description: `Lists credentials, variables, links and free-text accesses with key, kind, description and access (true/false), but NEVER values. kind is secret|variable|link|freeText; freeText is a multi-line block holding a whole access (host, port, user, password …); the description says what it is for. ${CREDENTIALS_AREA} Always use it first when tokens/URLs/config values/database accesses are needed: that shows what exists and what you may access. access=false means locked → ask the user.`,
    inputSchema: obj({}),
    handler: async () => api("GET", `${await varsBase()}/vars?mcp=1`),
  },
  {
    name: "cbase_vars_get",
    description: `Get the value of an entry (credential/variable/link/free text) by key, only for entries with access=true (otherwise an error). With kind=freeText a multi-line block arrives, as the user entered it: read it and take what you need (it follows no fixed schema). The scope is that of cbase_vars_list: ${CREDENTIALS_AREA} NEVER write secret values into files, commits, logs or context entries; use them only directly in commands/requests.`,
    inputSchema: obj({ key: str("key from cbase_vars_list") }, ["key"]),
    handler: async (a) => api("GET", `${await varsBase()}/vars/by-key/${enc(a.key)}?mcp=1`),
  },
  {
    name: "cbase_workspace_context_search",
    description: "Search the free workspace context archive (context dumpster): facts/snippets thrown in by the user, LLM-sorted. Put your question in `search` (meaning search, sorted by relevance); `q` is only for exact strings. By default only status=active; outdated entries (status deprecated) via status:'all'. Entries carry OKF-light fields (slug, status, owners, links).",
    inputSchema: obj({
      search: str("MEANING search: question or topic in your own words. Also finds entries that do not contain your words. The normal case."),
      q: str("EXACT substring search: only for a concretely known string (slug, name, path)."),
      limit: int("Maximum number of hits for search (default 20)"),
      category: str("Category"), status: str("active (default) | deprecated | all"),
    }),
    handler: async (a) => api("GET", `/api/workspaces/${await needWorkspace()}/context${qs({ search: a.search, q: a.q, limit: a.limit, category: a.category, status: a.status || "active" })}`),
  },
  {
    name: "cbase_workspace_context_update",
    description: "Updates a workspace context entry (OKF light): set outdated entries to status:'deprecated' instead of deleting, maintain owners, links or content. id from cbase_workspace_context_search. Also the right way for project entries ADOPTED from the workspace (origin:'workspace', negative id → use abs(id) here).",
    inputSchema: obj({
      id: int("Entry ID (from cbase_workspace_context_search; for adopted entries abs(id))"),
      title: str("Title"), body: str("Content; a body over 6,000 characters that grows compared to the stored one is rejected"), summary: str("Summary"), category: str("Category (free)"),
      tags: { type: "array", items: { type: "string" } },
      status: str("active | deprecated | superseded"), owners: { type: "array", items: { type: "string" } },
      links: { type: "object", additionalProperties: true, description: "{related|depends_on|supersedes|conflicts_with: [slug,…]}; slugs of other workspace entries" },
      confidence: str("high | medium | low"),
    }, ["id"]),
    // `ofAgent` as with cbase_context_update (projects/context-form.js): the length limit applies to the agent, not to the human.
    handler: async (a) => api("PUT", `/api/workspaces/${await needWorkspace()}/context/${enc(Math.abs(a.id))}`, {
      title: a.title, body: a.body, summary: a.summary, category: a.category, tags: a.tags,
      status: a.status, owners: a.owners, links: a.links, confidence: a.confidence,
      ofAgent: true,
    }),
  },
  {
    name: "cbase_workspace_context_add",
    description: "Store knowledge at WORKSPACE level: an LLM sorts the text into category/title/summary. This is the right place for everything that does NOT hang on one project but applies to all: quirks of the tool and container environment, conventions of the workspace (ports, branch rules, release cadence), responsibilities, accesses. Rule of thumb: if you would write down the same insight again in the next project, it belongs here and not in cbase_context_create. Also for context thrown in by the user without a project reference. No project routing.",
    inputSchema: obj({ text: str("Text to throw in (required)"), source: str("Source (optional)"), workspaceId: str("Workspace ID (optional; otherwise from the working directory)") }, ["text"]),
    handler: async (a) => {
      const ws = await scopeWorkspace();
      if (ws && a.workspaceId && a.workspaceId !== ws) throw new Error("You can throw workspace context in only into this chat's workspace.");
      return api("POST", `/api/workspaces/${enc(a.workspaceId || ws || (await needWorkspace()))}/context`, { text: a.text, source: a.source, route: "workspace" });
    },
  },
  {
    // The agents' language service: the language server of the project's instance, the same as in the editor, in EVERY harness
    // (Claude, Codex, third party), the counterpart of Claude Code's `LSP` tool. READING; what changes is in cbase_lsp_edit. The
    // actions are the list `AGENT_READ` from server/lsp/contract.js (bound in test/mcp-schema.test.js; this process never imports
    // the server tree).
    name: "cbase_lsp",
    description: "Asks the project's language server about a file (TypeScript/JavaScript, Python, YAML, JSON) without changing anything. diagnostics: errors and warnings of the file, faster and more precise than a full build. definition, type_definition, implementations, references: places of the symbol at line/column. hover: type and docs at line/column. outline: structure of the file. completions: suggestions at line/column. call_hierarchy: callers (direction incoming) or callees (outgoing) of the function at line/column. workspace_symbols: symbols of the project by query. code_actions: quick fixes and refactorings at line/column (with endLine/endColumn for a selection), numbered; carry them out with cbase_lsp_edit, action code_action, the same position and the same index. Lines and columns are 1-based, paths absolute; external: true means outside the project (read-only). Renaming, formatting and carrying out code actions: cbase_lsp_edit.",
    inputSchema: obj({
      file: str("Absolute path of the file (for workspace_symbols: a file of the project in the language searched for)"),
      action: { type: "string", enum: [...LSP_READ], description: "Default: diagnostics" },
      line: int("Line, 1-based (all actions except diagnostics, outline, workspace_symbols)"),
      column: int("Column, 1-based"),
      endLine: int("code_actions only: end of the selection, line (1-based)"),
      endColumn: int("code_actions only: end of the selection, column (1-based)"),
      query: str("workspace_symbols only: part of the symbol name"),
      direction: { type: "string", enum: ["incoming", "outgoing"], description: "call_hierarchy only: incoming = who calls the function (default), outgoing = what it calls" },
      kinds: { type: "array", items: { type: "string", enum: [...LSP_KINDS] }, description: "code_actions only: only these kinds" },
    }, ["file"]),
    handler: (a) => {
      const action = a.action || "diagnostics";
      if (!LSP_READ.includes(action)) throw new Error(`cbase_lsp only reads (${LSP_READ.join(", ")}); ${action} belongs to cbase_lsp_edit if it changes something.`);
      return api("POST", "/api/lsp", {
        file: a.file, action, line: a.line, column: a.column, endLine: a.endLine, endColumn: a.endColumn,
        query: a.query, direction: a.direction, kinds: a.kinds,
      });
    },
  },
  {
    // The writing counterpart: B writes to disk, all or nothing (lsp/limit.js); the actions are `AGENT_CHANGE`.
    name: "cbase_lsp_edit",
    description: "Changes code through the project's language server and writes the result directly into the files. rename: renames the symbol at line/column to newName across the whole project. format: formats the file with the project's formatter (Prettier, ruff or black), otherwise with the language server's. code_action: applies the code action with index from cbase_lsp code_actions: the same file, the same position, the same kinds. All or nothing: if a change reaches beyond the project, nothing is written. The answer names the changed files (changed); an open editor with unsaved changes to the same file notices on saving that it has changed.",
    inputSchema: obj({
      file: str("Absolute path of the file"),
      action: { type: "string", enum: [...LSP_CHANGE], description: "rename | format | code_action" },
      line: int("Line, 1-based (rename, code_action)"),
      column: int("Column, 1-based (rename, code_action)"),
      endLine: int("code_action only: end of the selection as with code_actions"),
      endColumn: int("code_action only: end of the selection as with code_actions"),
      newName: str("rename only: the new name (an identifier)"),
      index: int("code_action only: the number from cbase_lsp code_actions (from 1)"),
      kinds: { type: "array", items: { type: "string", enum: [...LSP_KINDS] }, description: "code_action only: the same kinds as with code_actions" },
    }, ["file", "action"]),
    handler: (a) => {
      if (!LSP_CHANGE.includes(a.action)) throw new Error(`cbase_lsp_edit knows ${LSP_CHANGE.join(", ")}; reading goes through cbase_lsp.`);
      return api("POST", "/api/lsp", {
        file: a.file, action: a.action, line: a.line, column: a.column, endLine: a.endLine, endColumn: a.endColumn,
        newName: a.newName, index: a.index, kinds: a.kinds,
      });
    },
  },
];

export { LSP_CHANGE, LSP_READ, workspaceTools };
