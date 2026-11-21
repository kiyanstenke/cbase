// MCP tools: projects and project context (cbase_projects_list, project_update/delete, chat_set_project, context_list/get/categories/create/dump/update/verify/delete).
// One contiguous slice of the tool array, in source order: cbase-mcp.js spreads the groups back together into TOOLS; the order
// is part of the prompt prefix (cache), guard: server/backend/test/mcp-catalog.test.js.
// There is deliberately no `cbase_project_create`: a human creates a project through the UI (in server operation the tool
// created a project WITHOUT a container in B). Stored tool lists lose the name once at start (toolchain/agent-tools.js dropRemovedTools).

import process from "node:process";
import { JOB_SENTENCE, CONTEXT_FORM, PROJECT_ID_FIELD, api, assertInScope, enc, inJobChat, int, obj, pidFor, qs, scopedProjects, str } from "../lib.js";

const projectTools = [
  {
    name: "cbase_projects_list",
    description: "List the projects of this chat's workspace (id, name, path, workspaceId, workspaceName). Use it to find your own project by its working directory. Projects of other workspaces are invisible to this chat.",
    inputSchema: obj({}),
    handler: () => scopedProjects(),
  },
  {
    name: "cbase_project_update",
    description: "Rename a project in cbase. projectId from cbase_projects_list.",
    inputSchema: obj({ projectId: str("Project ID"), name: str("New display name") }, ["projectId", "name"]),
    handler: async (a) => api("PATCH", `/api/projects/${enc(await assertInScope(a.projectId))}`, { name: a.name }),
  },
  {
    name: "cbase_project_delete",
    description: "Remove a project from cbase. The folder on disk is KEPT; only the cbase registration together with the project context and services is deleted. projectId from cbase_projects_list.",
    inputSchema: obj({ projectId: str("Project ID") }, ["projectId"]),
    handler: async (a) => api("DELETE", `/api/projects/${enc(await assertInScope(a.projectId))}`),
  },
  {
    name: "cbase_chat_set_project",
    description: "Assign this chat to a project (or remove the assignment with an empty or omitted projectId). The project must belong to the chat's workspace. Takes effect from the NEXT run on how the cbase_context_* tools resolve the project. projectId from cbase_projects_list.",
    inputSchema: obj({ projectId: str("Project ID (leave empty/omit = remove the assignment)") }),
    handler: async (a) => {
      const chatId = process.env.CBASE_CHAT_ID;
      if (!chatId) throw new Error("No chat context (CBASE_CHAT_ID missing): this chat cannot assign itself a project.");
      if (await inJobChat(chatId)) return { changed: false, hint: JOB_SENTENCE }; // only the human
      return api("PATCH", `/api/chats/${enc(chatId)}`, { projectId: a.projectId ? await assertInScope(a.projectId) : null });
    },
  },
  {
    name: "cbase_context_list",
    // No OKF block (length guard): the blueprint of an entry concerns WRITING and sits on the fields of cbase_context_create/_update.
    description: "Browse the project context (lasting project knowledge, OKF-structured). READ-LOG: (1) browse with this before working: put your question in `search` (meaning search: semantic + keyword + structure, sorted by relevance, with `relevance`/`scoreParts` per hit) and/or narrow by `path` to the affected code area; the default is METADATA-ONLY (slug, title, summary, status, codePaths, freshness); (2) load only the really matching entries in full via cbase_context_get; (3) `path` filters to entries whose codePaths cover the area. `freshness.stale:true` = there were commits on the codePaths since the last verification (`freshness.commitCount` counts them; WHICH ones is in cbase_context_get): check the content against the code before using it, then cbase_context_verify. `freshness.neverVerified` = anchored but never checked. By default only status=active; deprecated/superseded via status. Entries with origin:\"workspace\" are taken over from the workspace and READ-ONLY from the project's view.",
    inputSchema: obj({
      projectId: str(PROJECT_ID_FIELD),
      category: str("Category slug (see cbase_context_categories)"), tag: str("filter by tag"),
      search: str("MEANING search: question or topic in your own words (\"how do I restart the gateway\"). Also finds entries that do not contain your words, sorted by relevance. This is the normal case."),
      q: str("EXACT substring search: only if you know a concrete string (slug, symbol name, path, error text). Combinable with search: q filters first, search sorts."),
      limit: int("Maximum number of hits for search (default 20)"),
      path: str("project-relative file/folder path: only entries whose codePaths cover it"),
      status: str("active (default) | deprecated | superseded | all"),
      full: { type: "boolean", description: "true = full contents instead of metadata (expensive in context: only for small lists)" },
    }),
    handler: async (a) => api("GET", `/api/projects/${await pidFor(a)}/context${qs({ category: a.category, tag: a.tag, search: a.search, q: a.q, limit: a.limit, path: a.path, status: a.status || "active", meta: a.full ? undefined : "1" })}`),
  },
  {
    name: "cbase_context_get",
    description: "Load one project context entry in full, by numeric id OR slug. The answer contains `freshness` (stale/neverVerified + commits since verification on the codePaths) and `linksResolved` (linked entries as {slug,title,status} for traversal: related, depends_on, supersedes, conflicts_with). If freshness.stale, CHECK the content against the current code before relying on it, then cbase_context_verify (if still correct) or cbase_context_update (if not).",
    inputSchema: obj({ id: str("Entry ID or slug"), projectId: str(PROJECT_ID_FIELD) }, ["id"]),
    handler: async (a) => {
      const pid = await pidFor(a);
      const key = String(a.id);
      return api("GET", /^\d+$/.test(key) ? `/api/projects/${pid}/context/${enc(key)}` : `/api/projects/${pid}/context/by-slug/${enc(key)}`);
    },
  },
  {
    name: "cbase_context_categories",
    description: "Available category slugs (fixed set) together with the number of entries per category in the project.",
    inputSchema: obj({ projectId: str(PROJECT_ID_FIELD) }),
    handler: async (a) => {
      const pid = await pidFor(a);
      const [schema, counts] = await Promise.all([
        api("GET", "/api/project-context/schema"),
        api("GET", `/api/projects/${pid}/context/categories`),
      ]);
      return { schema, counts };
    },
  },
  {
    name: "cbase_context_create",
    // One rule line (CONTEXT_FORM) right after the purpose sentence instead of a long rules block at the end (beyond the 2,048
    // characters the CLI reads, so never read); the meaning of the fields sits on the fields, violations are reported by the
    // server in the answer (`formHints`).
    description: "Creates a new entry in the project context: a confirmed, lasting insight that helps future agents and is not in the code. " + CONTEXT_FORM
      + " Search for existing entries first (cbase_context_list): adding goes through cbase_context_update, outdated entries are deprecated there instead of deleted; working notes stay in your session."
      + " The server checks for near-duplicates: on strong evidence it creates NOTHING and returns {duplicate:true, candidates}: then update instead, and only for something really new force:true; weaker finds are named in `similar` in the result (link them via links.related)."
      + " With `codePaths` it anchors the current repo commits as the verification state (basis of stale detection)."
      + " Invalid status, confidence, links or codePaths details it rejects as `problems` and writes nothing; violations of the FORM it names under `formHints`, and it rejects a body over 6,000 characters.",
    inputSchema: obj({
      category: str("Category slug from the fixed set (cbase_context_categories); required; open matters belong in 'open-points'"),
      title: str("The statement itself (\"Everything is computed in cents, as integers\", not \"Money amounts and rounding\"); without an issue/MR number"),
      body: str("Markdown: the insight with reasoning and consequence, usually under 1,500 characters (the server rejects over 6,000); no session log"),
      summary: str("1–2 sentences. Only it is loaded when browsing; it must stand on its own"), tags: { type: "array", items: { type: "string" }, description: "Tags for filing" },
      slug: str("stable short ID in kebab-case (e.g. 'auth-token-refresh'): the reference under which other entries link it; the title may change, the slug must not. Derived from the title if omitted"),
      owners: { type: "array", items: { type: "string" }, description: "Responsible parties, e.g. ['backend']" },
      codePaths: { type: "array", items: { type: "string" }, description: "project-relative files/folders the knowledge hangs on (e.g. 'src/auth/'); they must exist and are the anchor of stale detection; without an anchor there is none" },
      symbols: { type: "array", items: { type: "string" }, description: "optional symbol names (functions/classes): best effort, no substitute for codePaths" },
      links: { type: "object", additionalProperties: true, description: "Relations to other entries: {related|depends_on|supersedes|conflicts_with: [slug,…]}; targets must be existing slugs, no self-reference; makes knowledge traversable" },
      status: str("active (default) | deprecated | superseded; outdated entries become deprecated (with supersededBy), never deleted"),
      confidence: str("high | medium | low; only if justifiable; otherwise derived from verification"),
      validAsOf: str("domain state, e.g. 'Sprint 3'"), pinned: { type: "boolean", description: "pin to the top" },
      force: { type: "boolean", description: "true = skip the dedup check and create anyway (only if really new, despite reported candidates)" },
      projectId: str(PROJECT_ID_FIELD),
    }, ["category"]),
    // `ofAgent`: the marker at which the route applies the length limit (projects/context-form.js). Web and iOS write through the
    // same route and never set it; a human only gets hints. Guard: context-form.test.js ("lock only for agents").
    handler: async (a) => api("POST", `/api/projects/${await pidFor(a)}/context`, {
      category: a.category, title: a.title, body: a.body, summary: a.summary, tags: a.tags, validAsOf: a.validAsOf, pinned: a.pinned, force: a.force,
      slug: a.slug, owners: a.owners, codePaths: a.codePaths, symbols: a.symbols, links: a.links, status: a.status, confidence: a.confidence,
      ofAgent: true,
    }),
  },
  {
    name: "cbase_context_dump",
    description: "Files free text into the project context FULLY AUTONOMOUSLY: an LLM picks category and title, creates a new entry or merges with an existing one. One call is enough; ideal for assigning thrown-in context to a project. Answer: {status:'created'|'updated', item, ...}.",
    inputSchema: obj({
      text: str("Text to file (required)"),
      projectId: str(`Target ${PROJECT_ID_FIELD}`),
      source: str("Source (optional)"),
    }, ["text"]),
    handler: async (a) => api("POST", `/api/projects/${await pidFor(a)}/context/dump`, { text: a.text, source: a.source }),
  },
  {
    name: "cbase_context_update",
    // Like cbase_context_create: CONTEXT_FORM after the purpose sentence, field meanings on the fields.
    description: "Updates an existing entry in the project context: only the fields you pass change. " + CONTEXT_FORM
      + " DEPRECATE goes through here: set status:'deprecated' (plus supersededBy:<slug> if a new entry replaces it); outdated knowledge is NEVER deleted, or the next agent learns the same mistake again."
      + " If you change body or codePaths, the server renews the verification anchor (you have the code in front of you right now). Also maintain `links` to related entries while at it."
      + " Invalid status, confidence, links or codePaths details it rejects as `problems` and changes nothing; violations of the FORM it names under `formHints`, and it rejects a body over 6,000 characters that grows compared to the stored one.",
    inputSchema: obj({
      id: int("Entry ID (from cbase_context_list)"), category: str("Category slug from the fixed set (cbase_context_categories)"),
      title: str("The statement itself; without an issue/MR number"),
      body: str("Markdown: insight, reasoning, consequence; usually under 1,500 characters, no session log"),
      summary: str("1–2 sentences. Only it is loaded when browsing; it must stand on its own"), tags: { type: "array", items: { type: "string" } }, validAsOf: str("domain state"),
      slug: str("change the stable short ID (careful: existing links point to the old slug)"),
      owners: { type: "array", items: { type: "string" } },
      codePaths: { type: "array", items: { type: "string" }, description: "project-relative files/folders; must exist; anchor of stale detection" },
      symbols: { type: "array", items: { type: "string" } },
      links: { type: "object", additionalProperties: true, description: "{related|depends_on|supersedes|conflicts_with: [slug,…]}; targets must be existing slugs, no self-reference" },
      status: str("active | deprecated | superseded; outdated entries become deprecated, never deleted"), supersededBy: str("slug of the replacing entry"),
      confidence: str("high | medium | low"),
      pinned: { type: "boolean" }, projectId: str(PROJECT_ID_FIELD),
    }, ["id"]),
    handler: async (a) => api("PUT", `/api/projects/${await pidFor(a)}/context/${enc(a.id)}`, {
      category: a.category, title: a.title, body: a.body, summary: a.summary, tags: a.tags, validAsOf: a.validAsOf, pinned: a.pinned,
      slug: a.slug, owners: a.owners, codePaths: a.codePaths, symbols: a.symbols, links: a.links,
      status: a.status, supersededBy: a.supersededBy, confidence: a.confidence,
      ofAgent: true, // as in cbase_context_create
    }),
  },
  {
    name: "cbase_context_verify",
    description: "Mark an entry as CHECKED: sets the verification anchor to the current repo commits of its codePaths. Call ONLY after you have actually checked the content against the current code and it still holds; if it no longer does, use cbase_context_update instead (correct the content) or status:'deprecated'. Typical flow: freshness.stale in list/get → read the code → verify OR update. The answer names the new anchors and how many commits were cleared as 'unverified' with it.",
    inputSchema: obj({ id: int("Entry ID"), projectId: str(PROJECT_ID_FIELD) }, ["id"]),
    handler: async (a) => api("POST", `/api/projects/${await pidFor(a)}/context/${enc(a.id)}/verify`),
  },
  {
    name: "cbase_context_delete",
    description: "Delete a project context entry PERMANENTLY: only for wrong entries or duplicates. Outdated knowledge is NOT deleted but set to status:'deprecated' via cbase_context_update (with supersededBy if there is a successor), so that the insight 'this used to hold, no longer true' is kept.",
    inputSchema: obj({ id: int("Entry ID"), projectId: str(PROJECT_ID_FIELD) }, ["id"]),
    handler: async (a) => api("DELETE", `/api/projects/${await pidFor(a)}/context/${enc(a.id)}`),
  },
];

export { projectTools };
