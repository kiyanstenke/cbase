// Routes: workspaces. Each function takes ctx = { req, res, url, p, m } (sub-slices of a family additionally wid/sub/ws)
// and returns NEXT when it is not responsible; any other return value means "answered". Call order: ROUTES in server.js.
// Functions: workspaceListRoutes · workspaceRoutes (owner) · coreWorkspaceRoutes (base, overview) ·
// tailWorkspaceRoutes (agents, file-search, settings-json, setup-mcp, projects, context, browser/ensure, codeRoute).
// A project is created only via POST …/projects.
// workspaceRoutes owns the family: preamble (regex, lookup, 404), then the table of sub-slices in order.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { classifyContext, routeDumpToProject } from "../claude.js";
import { rankContext } from "../retrieval.js";
import { findFilesByName } from "../files.js";
import { ensureUserBrowser } from "../browsers.js";
import { killTerminalsByTag } from "../terminal.js";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { NEXT, readBody, send } from "../runtime/http.js";
import { foreignProviderIn } from "../providers/index.js";
import { agentRunFor } from "../settings/agent-models.js";
import { agentSkillsField } from "../toolchain/skill-catalog.js";
import { unknownInWorkspace, unknownText, toolListFromBody } from "../toolchain/agent-tools.js";
import { agentMcpFromBody } from "../toolchain/agent-mcp.js";
import { channelWorkspaceRoutes } from "../channels/routes.js";
import { codeRoute, fileLimit } from "../devtools/code-route.js";
import { userBrowserTarget } from "../devtools/user-browser.js";

import { dumpIntoProject, validateOkf } from "../projects/context.js";
import { formRejectionText, withFormHints, checkContextForm } from "../projects/context-form.js";

import { managedPath, managedPathsOn, managedWsRoot } from "./git-auth.js";

import { closeChats } from "../chats/erase.js";
import { scheduledWorkspaceRoutes } from "../scheduled/routes.js";
import { instructionsWorkspaceRoutes } from "./instructions-routes.js";
import { runServicesScan } from "../projects/scans.js";
import { createImportChat } from "../projects/coding-jobs.js";
import { toolchainWorkspaceRoutes } from "../toolchain/routes.js";
import { skillHistoryWorkspaceRoutes } from "../toolchain/skill-routes.js";
import { workflowWorkspaceRoutes } from "../workflows/routes.js";
import { dynWorkflowWorkspaceRoutes } from "../dynworkflows/routes.js";
import { outerLoopWorkspaceRoutes } from "../outerloop/routes.js";
import { seedAgendaKeeper, seedTimelineAgent, seedSummarizer } from "../outerloop/seed.js";
import { abortOuterLoop } from "../outerloop/abort.js";
import { writeWorkspaceMcpJson } from "../toolchain/mcp-config.js";
import { deleteProjectbox, projectDelete } from "../projectbox/erase.js";
// ONE truth about open work when deleting; the files of the channels.
import { deleteObstacles, deleteLock } from "../runs/archive.js";
import { channelFileDir } from "../channels/messages.js";
import { projectboxOps } from "../projectbox/ops.js";
import { workspaceDeleteLock } from "../projectbox/idle.js"; // holds starts in ALL chats
import { GIT_ACCESS_HEADER, gitInstanceForWorkspace, gitAccessResponse } from "../projectbox/git-assignment.js";
import { requestSource } from "../projectbox/fence.js"; // the same source as the fence
// The switch of POST …/projects in ops mode and the fields `instance`/`setup` of the projects.
import { projectCreateInOps } from "../projectbox/setup/routes.js";
import { setupAtPath, setupField } from "../projectbox/setup/status.js";
import { uploadBegins } from "../runtime/upload-stamp.js"; // the upload stamp on the workspace level too
import { projectInstanceField } from "../projectbox/names.js";
import { withRepoCount } from "../gitView/repos.js"; // `repos` per project

// `GET /api/workspaces` and `GET /api/workspaces/:id`: in ops mode `instance` and `setup` per project — the same
// computation as `GET /api/projects`. Without ops mode the object itself. Plus `repos` (gitView/repos.js withRepoCount) —
// also in the overview (`…/overview`), which the web project list reads.
const withProjectFields = (ws) => (projectboxOps() && Array.isArray(ws?.projects)
  ? { ...ws, projects: withRepoCount(setupField(projectInstanceField(ws.projects))) }
  : ws);

export async function workspaceListRoutes(ctx) {
  const { req, res, url, p, m } = ctx;

      // ── Workspaces ───────────────────────────────────────────────────────
      if (p === "/api/workspaces" && m === "GET") return send(res, 200, store.listWorkspaces().map(withProjectFields));
      if (p === "/api/workspaces" && m === "POST") {
        const b = await readBody(req);
        let wsPath = String(b.path || "").trim();
        const nameIn = String(b.name || "").trim();
        // Managed mode: only the name comes from the client, the path is assigned.
        if (!wsPath && managedPathsOn() && nameIn) wsPath = managedPath(managedWsRoot(), nameIn);
        const name = nameIn || path.basename(wsPath);
        if (!wsPath) return send(res, 400, { error: T("Path required") });
        // Create a missing folder (remotely there is no file picker — the path is typed).
        if (!fs.existsSync(wsPath)) { try { fs.mkdirSync(wsPath, { recursive: true }); } catch {} }
        if (!fs.existsSync(wsPath) || !fs.statSync(wsPath).isDirectory()) return send(res, 400, { error: T("Path does not exist or is not a folder") });
        const ws = store.createWorkspace({ id: crypto.randomUUID(), name, path: path.resolve(wsPath), createdAt: Date.now() });
        // Provide the cbase MCP server in the workspace (also for manual claude calls in the folder).
        try { writeWorkspaceMcpJson(ws.path, ws.id); } catch {}
        // The summarizer: once per workspace from the template, inactive until a model is chosen — the start migration
        // (server.js seedMissingSummarizer) catches up on one that failed here at the next start.
        try { seedSummarizer(ws.id); } catch (e) { console.error("[outer-loop] seeding the summarizer failed:", e?.message || e); }
        // The agenda keeper: likewise, inactive until a model is chosen; the start catches up on a failed seed.
        try { seedAgendaKeeper(ws.id); } catch (e) { console.error("[outer-loop] seeding the agenda keeper failed:", e?.message || e); }
        // The timeline agent likewise — otherwise the start migration catches up.
        try { seedTimelineAgent(ws.id); } catch (e) { console.error("[outer-loop] seeding the timeline agent failed:", e?.message || e); }
        return send(res, 201, ws);
      }
  return NEXT;
}
export async function workspaceRoutes(ctx) {
  const { req, res, url, p, m } = ctx;

      const wm = p.match(/^\/api\/workspaces\/([0-9a-f-]+)(\/.*)?$/);
      if (wm) {
        const wid = wm[1]; const sub = wm[2] || "";
        const ws = store.getWorkspace(wid);
        if (!ws) return send(res, 404, { error: "workspace not found" });
        const fctx = { ...ctx, wid, sub, ws };
        for (const s of [
          coreWorkspaceRoutes,
          toolchainWorkspaceRoutes,
          skillHistoryWorkspaceRoutes, // history, recently deleted, deletion requests, switch of the skills (toolchain/skill-routes.js)
          workflowWorkspaceRoutes,
          channelWorkspaceRoutes,
          dynWorkflowWorkspaceRoutes, // library of dynamic workflows
          outerLoopWorkspaceRoutes, // outer-loop agents of the workspace — outerloop/routes.js
          scheduledWorkspaceRoutes, // scheduled jobs — scheduled/routes.js
          instructionsWorkspaceRoutes, // instructions for agents per workspace and project — workspaces/instructions-routes.js
          tailWorkspaceRoutes,
        ]) {
          const r = await s(fctx);
          if (r !== NEXT) return r;
        }
      }
  return NEXT;
}
// What holds up deleting the workspace: per chat of the workspace — of any kind, archived or not — the deletion
// obstacles of the chat route (runs/archive.js deleteObstacles), with the chat id. `skip(chat)`: chats that another
// checker sees (the idle check of a converted project).
function wsDeleteObstacles(wid, omit = () => false) {
  const open = [];
  for (const chatId of store.chatIdsInWorkspace(wid)) {
    if (omit(store.getChat(chatId) || {})) continue;
    for (const o of deleteObstacles(chatId)) open.push({ chatId, ...o });
  }
  return open;
}

export async function coreWorkspaceRoutes(ctx) {
  const { req, res, url, p, m, wid, sub, ws } = ctx;

        if (sub === "" && m === "GET") return send(res, 200, withProjectFields(ws));
        if (sub === "" && m === "PATCH") {
          const b = await readBody(req);
          if (typeof b.name === "string" && b.name.trim()) return send(res, 200, store.renameWorkspace(wid, b.name.trim()));
          return send(res, 200, ws);
        }
        if (sub === "" && m === "DELETE") {
          // FIRST the project containers of all projects of this workspace (projectbox/erase.js — stop, remove by id,
          // network, name, row; volume and runtime folder only with purge=1). 409 during a creation/relocation/re-creation
          // and for every converted project that is not idle — checked for ALL before a shell ends or a container falls.
          // 500 when one does not fall: then the route deletes NOTHING. If a `stop` fails, the containers already
          // stopped run again; if an `rm` or the probe fails later, the containers of the projects removed before are
          // gone but their rows stay (the message names them, a second attempt continues). Before the chats, so an
          // abort does not leave half a workspace. Without an instance row `box.fields` is empty.
          //
          // Open work that would keep writing after the deletion (a turn, a compaction, a goal verdict — the same query as
          // chat route and archive, runs/archive.js deleteObstacles) holds up the deletion: 409 like the chat route, and
          // NOTHING has happened. The chats of a CONVERTED project (in server mode) are checked by the idle check of the
          // project container (projectbox/erase.js) — stricter and with its own response; so they are not repeated here.
          //
          // FIRST the workspace lock, THEN the check (as projectLocks: the other way round there would be a window). While
          // it stands, no turn or subagent begins in ANY chat of the workspace — each waits (composer: queue, otherwise a
          // wait row) and falls with its chat or starts after a refusal (projectbox/idle.js workspaceDeleteLock). Without
          // it a tick or a message in another chat could begin a turn during the docker steps: the second check would
          // answer 409 after the project containers were already removed. A second deletion of the same workspace: 409.
          const wsLock = workspaceDeleteLock(wid);
          if (!wsLock.ok) return send(res, 409, { error: wsLock.error });
          // The idle lock of the converted projects holds until the chats are GONE: if deleteProjectbox released it in
          // its finally, the transition would wake what waited during the deletion — a turn would start under a chat that
          // falls moments later. It is released here, after the closing path (wakeProject then no longer finds the
          // chats) or after any refusal.
          const hold = {};
          const holdNew = {};
          let allProjects = ws.projects || [];
          try {
            const converted = new Set(projectboxOps() ? (ws.projects || []).filter((pr) => store.converted(pr.id)).map((pr) => pr.id) : []);
            const prior = wsDeleteObstacles(wid, (c) => converted.has(c.projectId || ""));
            if (prior.length) return send(res, 409, deleteLock(prior, { workspace: true }));
            const purge = url.searchParams.get("purge") === "1";
            const box = await deleteProjectbox((ws.projects || []).map((pr) => pr.id), { purge, hold });
            if (box.response) return send(res, box.response.status, box.response.body);
            // The project list FRESH — what came into being during the docker steps despite the lock (the creation POST
            // asks it, projectbox/setup/routes.js; another path does not) goes through the same path before
            // store.deleteWorkspace takes its project row. Otherwise container, instance and setup row would remain without a project.
            const known = new Set((ws.projects || []).map((pr) => String(pr.id)));
            const fresh = (store.getWorkspace(wid)?.projects || []).filter((pr) => !known.has(String(pr.id)));
            if (fresh.length) {
              const boxNew = await deleteProjectbox(fresh.map((pr) => pr.id), { purge, hold: holdNew });
              const together = (extra = []) => ({ projectContainer: [...(box.fields?.projectContainer || []), ...extra] });
              if (boxNew.response) {
                return send(res, boxNew.response.status, { ...boxNew.response.body, ...together(boxNew.response.body?.projectContainer || []) });
              }
              if (box.fields?.projectContainer || boxNew.fields?.projectContainer) box.fields = together(boxNew.fields?.projectContainer || []);
              allProjects = [...allProjects, ...fresh];
            }
            // From here to the closing path no more await. The safeguard: what began during the docker steps despite the
            // lock (a compaction — a oneshot; the lock lets oneshots run because they cannot wait) holds up now — the
            // project containers are then already gone (`projectContainer` says so), the rows stay, a second attempt
            // deletes without docker.
            const afterwards = wsDeleteObstacles(wid);
            if (afterwards.length) return send(res, 409, { ...deleteLock(afterwards, { workspace: true }), ...box.fields });
            // The chats of the workspace go through the ONE closing path: the store deletes all rows in one go and
            // reports the ids, cleanup follows from them. The store deletes its channels too (every participant is a
            // chat of this workspace — a closing note would have no reader).
            // The running outer-loop runs of this workspace's agents end BEFORE their rows (deleting ends them, no 409) —
            // rows to "aborted", cores silent (outerloop/abort.js); store.deleteWorkspace takes the rows.
            abortOuterLoop({ agentIds: store.outerLoopAgentsOf(wid).map((a) => a.id), reason: T("Workspace deleted") });
            let deleted = null;
            const chatIds = closeChats([], () => (deleted = store.deleteWorkspace(wid)).chatIds);
            // Also the shells of the terminal tab (workspace level `ws:<id>`, per project `proj:<id>`):
            // without the workspace no client reaches them any more; they would otherwise run until restart.
            killTerminalsByTag(`ws:${wid}`);
            for (const pr of allProjects) killTerminalsByTag(`proj:${pr.id}`);
            // Likewise the files of the channels: the rows are gone, nobody would read them any more.
            for (const k of deleted?.channelIds || []) fs.rmSync(channelFileDir(k), { recursive: true, force: true });
            return send(res, 200, { ok: true, removedChats: chatIds.length, note: T("The folder on disk is kept."), ...box.fields });
          } finally {
            // FIRST the workspace lock (after a refusal it wakes the chats whose start it held — except those of a project
            // whose lock still stands), THEN the locks of the converted projects (wakeProject wakes their chats). The other
            // way round wakeProject would hit the still standing workspace lock and push their wait rows to the next look.
            try { wsLock.resolve(); } finally { try { hold.resolve?.(); } finally { holdNew.resolve?.(); } }
          }
        }

        if (sub === "/overview" && m === "GET") {
          const exists = fs.existsSync(ws.path);
          return send(res, 200, {
            id: ws.id, name: ws.name, path: ws.path, exists,
            hasClaudeMd: exists && (fs.existsSync(path.join(ws.path, "CLAUDE.md")) || fs.existsSync(path.join(ws.path, ".claude", "CLAUDE.md"))),
            // Dead fields: `agents`, `varsCount`, `mcpCount` and `workflowCount` fed counters of the Coding tab row
            // that no longer exist; no client reads them. They still go out because their TypeScript declaration is in
            // web/src/lib/api/workflows.ts — dropping a server field without its type would leave a type that lies.
            // When cleaning up, `agents` is the most expensive: `listWorkspaceAgents` returns the FULL row per subagent,
            // including the whole role prompt (`body`), on every opening of a workspace. Whoever needs it fetches
            // /agents. To take along: WorkflowModels.swift (reads via c.int with default 0, harmless),
            // mobile/test-fixtures/chat-gateway/routes-workspace.mjs and routes-fixture.mjs.
            agents: store.listWorkspaceAgents(wid),
            // The same fields `instance`/`setup` as workspace list and /api/projects — the web project list reads HERE.
            projects: withProjectFields(ws).projects || [],
            categories: store.categories(wid),
            contextCount: store.listContext(wid).length,
            varsCount: store.countVars(wid),
            mcpCount: store.listMcpServers(wid).length,
            workflowCount: store.listWorkspaceWorkflows(wid).length,
          });
        }
  return NEXT;
}
export async function tailWorkspaceRoutes(ctx) {
  const { req, res, url, p, m, wid, sub, ws } = ctx;

        // The stored git access of the workspace for the git helper in the user container — only with the ops marker,
        // from loopback and with the key file of the data folder; from a project network the fence already rejects
        // (projectbox/git-assignment.js gitAccessResponse).
        if (sub === "/git-access" && m === "POST") {
          let body = null;
          try { body = await readBody(req); } catch { body = null; }
          const a = gitAccessResponse({ source: requestSource(req), key: req.headers[GIT_ACCESS_HEADER], workspaceId: wid, body });
          res.writeHead(a.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify(a.body));
          return;
        }
        // Custom subagent CRUD (app-managed, DB) — workspace level (project_id NULL).
        // Agent types of cbase_agent (not auto-discovered), so they can be switched per project.
        if (sub === "/agents" && m === "GET") return send(res, 200, store.listWorkspaceAgents(wid));
        if (sub === "/agents" && m === "POST") {
          const b = await readBody(req);
          const name = String(b.name || "").trim();
          if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || name.length > 64) return send(res, 400, { error: T("Name must be lower-kebab-case (a-z, 0-9, -)") });
          if (foreignProviderIn(b.model)) return send(res, 400, { error: T`Unknown provider in model: ${foreignProviderIn(b.model)}` });
          const list = agentTools(b.tools, wid);
          if (list.error) return send(res, 400, { error: list.error });
          const mcp = agentMcpFromBody(b.mcp, { workspaceId: wid, projectId: null });
          if (mcp.error) return send(res, 400, { error: mcp.error });
          const now = Date.now();
          return send(res, 201, store.createAgent({ id: crypto.randomUUID(), workspaceId: wid, projectId: null, name, description: b.description || "", toolList: list.value ?? null, model: b.model || "", body: b.body || "", skills: agentSkillsField(b.skills), mcp: mcp.value ?? {}, createdAt: now, updatedAt: now }));
        }
        const agentMatch = sub.match(/^\/agents\/([0-9a-f-]+)$/);
        if (agentMatch) {
          const ag = store.getAgent(agentMatch[1]);
          if (!ag || ag.workspaceId !== wid || ag.projectId) return send(res, 404, { error: "agent not found" });
          if (m === "GET") return send(res, 200, ag);
          if (m === "PUT") {
            const b = await readBody(req);
            const fields = { updatedAt: Date.now() };
            // Only three providers: a reference "<foreign>::…" is a 400 (providers/index.js foreignProviderIn).
            if (typeof b.model === "string" && foreignProviderIn(b.model)) return send(res, 400, { error: T`Unknown provider in model: ${foreignProviderIn(b.model)}` });
            for (const k of ["description", "model", "body"]) if (typeof b[k] === "string") fields[k] = b[k];
            const list = agentTools(b.tools, wid);
            if (list.error) return send(res, 400, { error: list.error });
            if (list.value !== undefined) fields.toolList = list.value;
            // The Coding MCP servers of the type (toolchain/agent-mcp.js): if the field is missing, the choice stays
            // (a client without the field — iOS — does not delete it).
            const mcp = agentMcpFromBody(b.mcp, { workspaceId: wid, projectId: null });
            if (mcp.error) return send(res, 400, { error: mcp.error });
            if (mcp.value !== undefined) fields.mcp = mcp.value;
            if (b.skills !== undefined) fields.skills = agentSkillsField(b.skills);
            return send(res, 200, store.updateAgent(agentMatch[1], fields));
          }
          if (m === "DELETE") return send(res, 200, { ok: store.deleteAgent(agentMatch[1]) });
        }
        // File name search in the workspace (for @-mentions in chat — cwd is the workspace).
        if (sub === "/file-search" && m === "GET") {
          const q = String(url.searchParams.get("q") || "");
          if (!fs.existsSync(ws.path)) return send(res, 200, { results: [], truncated: false });
          // The same limit as the file routes of the workspace level — in a converted project the search follows no
          // link (without the ops marker it is null and nothing changes).
          let limit;
          // (the source as its own arrow function: the line with `gitInstanceSource: () => gitInstanceForWorkspace()` is
          // the ONE start place of the workspace level in in-project-start-places.test.js — the name search starts nothing)
          try { limit = fileLimit(ws.path, { gitInstanceSource: () => gitInstanceForWorkspace() }); } catch (e) { const f = String(e?.message || e); return send(res, 409, { error: f }); }
          try { return send(res, 200, findFilesByName(ws.path, q, 30, limit ? { limit } : {})); }
          catch { return send(res, 200, { results: [], truncated: false }); }
        }
        // Read/write project settings (.claude/settings.json) — hooks (PreToolUse/PostToolUse/…) AND permission
        // rules (permissions.allow/deny) live here. Claude Code reads the file automatically at start.
        // PUT validates the JSON.
        if (sub === "/settings-json" && (m === "GET" || m === "PUT")) {
          const file = path.join(ws.path, ".claude", "settings.json");
          if (m === "GET") {
            let content = "";
            try { if (fs.existsSync(file)) content = fs.readFileSync(file, "utf8"); } catch {}
            return send(res, 200, { content, exists: fs.existsSync(file) });
          }
          const b = await readBody(req);
          const content = String(b.content ?? "").trim();
          if (content) { try { JSON.parse(content); } catch (e) { return send(res, 400, { error: T("Invalid JSON: ") + String(e.message || e) }); } }
          try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, content ? content + "\n" : "{}\n");
            return send(res, 200, { ok: true });
          } catch (e) { return send(res, 400, { error: String(e.message || e) }); }
        }
        // (Re)configure the MCP server in the workspace.
        if (sub === "/setup-mcp" && m === "POST") {
          if (!fs.existsSync(ws.path)) return send(res, 400, { error: T("Workspace path not found") });
          try { writeWorkspaceMcpJson(ws.path, ws.id); return send(res, 200, { ok: true, path: path.join(ws.path, ".mcp.json") }); }
          catch (e) { return send(res, 400, { error: String(e.message || e) }); }
        }

        // Projects
        if (sub === "/projects" && m === "POST") {
          const b = await readBody(req);
          // In ops mode a project is created ONLY with container and setup; without ops mode the plain path.
          // The body goes as the FIRST argument (not inside an object): the seam guard web/test/seams-fields.test.mjs
          // only follows hand-overs by argument position and would otherwise not see that `sources` and `codeRepos` are read.
          if (projectboxOps()) return projectCreateInOps(b, { res, ws });
          let projPath = String(b.path || "").trim();
          const projNameIn = String(b.name || "").trim();
          // Managed mode: create the project folder automatically under the workspace.
          if (!projPath && managedPathsOn() && projNameIn) projPath = managedPath(ws.path, projNameIn);
          if (!projPath) return send(res, 400, { error: T("Path required") });
          try { fs.mkdirSync(projPath, { recursive: true }); } catch (e) { return send(res, 400, { error: T("Cannot create path: ") + String(e.message || e) }); }
          const proj = store.addProject(wid, { id: crypto.randomUUID(), name: String(b.name || "").trim() || path.basename(projPath), path: path.resolve(projPath), createdAt: Date.now() });
          // Trigger the services scan (fire-and-forget) — only when the folder is not empty.
          try { if (fs.readdirSync(proj.path).length > 0) runServicesScan(proj); } catch {}
          return send(res, 201, proj);
        }
        const pm = sub.match(/^\/projects\/([0-9a-f-]+)$/);
        if (pm && m === "DELETE") {
          // The delete button of the web UI. The same path as DELETE /api/projects/:id (projectbox/erase.js
          // projectDelete): first the project container — 409 in the turn of a converted project and during
          // creation/relocation/re-creation, 500 when it does not fall; then the route deletes NOTHING.
          // A project of ANOTHER workspace is 404, and nothing is deleted.
          const r = await projectDelete({ workspaceId: wid, projectId: pm[1], project: store.getProject(pm[1]), purge: url.searchParams.get("purge") === "1" });
          return send(res, r.status, r.body);
        }

        // Context dumpster
        if (sub === "/context" && m === "GET") {
          const search = (url.searchParams.get("search") || "").trim();
          const rows = store.listContext(wid, {
            category: url.searchParams.get("category") || undefined,
            q: url.searchParams.get("q") || undefined,
            status: url.searchParams.get("status") || "all",
          });
          // As with project knowledge: `q` filters exactly, `search` sorts by meaning.
          if (!search) return send(res, 200, rows);
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 20));
          const items = rows.map((r) => ({ ...r, updatedAt: r.updated_at || r.created_at, codePaths: [] }));
          const ranked = await rankContext(search, items, { workspaceId: wid, limit });
          // The store form (snake_case) is kept — the clients read it that way; only relevance/scoreParts
          // are added. The camelCase helper fields are removed again.
          return send(res, 200, ranked.map(({ updatedAt, codePaths, ...rest }) => rest));
        }
        if (sub === "/context" && m === "POST") {
          const b = await readBody(req);
          const text = String(b.text || "").trim();
          if (!text) return send(res, 400, { error: T("text required") });
          const src = String(b.source || "").trim();
          const projects = (ws.projects || []).filter((p) => fs.existsSync(p.path));
          // Put into the workspace dumpster archive (free categories).
          const toWorkspace = async () => {
            const cats = store.categories(wid).map((c) => c.category);
            const cls = await classifyContext(text, cats, agentRunFor("classify"));
            const item = store.insertContext(wid, { ...cls, body: text, source: src, createdAt: Date.now() });
            // The FORM (projects/context-form.js) — hints only, here too (cbase_workspace_context_add).
            const { formHints } = checkContextForm({ title: cls.title, summary: cls.summary, body: text, category: cls.category });
            return send(res, 201, withFormHints({ target: "workspace", status: "created", item }, formHints));
          };

          // 1) "Workspace" chosen explicitly (also by the MCP tool cbase_workspace_context_add).
          if (b.route === "workspace") return toWorkspace();

          // 2) A project chosen explicitly → sort it in there (autonomous project dump).
          if (b.projectId) {
            const proj = projects.find((p) => p.id === b.projectId) || store.getProject(String(b.projectId));
            if (!proj || !fs.existsSync(proj.path)) return send(res, 400, { error: T("Project not found") });
            const r = await dumpIntoProject(proj.id, text, src || "dumpster");
            return send(res, r.status === "created" ? 201 : 200, { ...r, target: "project", projectId: proj.id, projectName: proj.name });
          }

          // 3) Detect automatically (default). Without projects → workspace.
          if (!projects.length) return toWorkspace();
          const hintsFor = (p) => store.listProjectContext(p.id, { withBody: false }).slice(0, 5).map((e) => e.title).filter(Boolean).join("; ");
          const projList = projects.map((p) => ({ id: p.id, name: p.name, hints: hintsFor(p) }));
          let routing = { decision: "none" };
          try { routing = await routeDumpToProject({ text, projects: projList, ...agentRunFor("curator") }); } catch {}

          if (routing.decision === "project" && routing.projectId) {
            const proj = projects.find((p) => p.id === routing.projectId);
            if (proj) {
              const r = await dumpIntoProject(proj.id, text, "dumpster");
              return send(res, r.status === "created" ? 201 : 200, { ...r, target: "project", projectId: proj.id, projectName: proj.name, reason: routing.reason });
            }
          }
          // 4) No project fits — or the assignment is unclear (`unsure`) → workspace dumpster.
          return toWorkspace();
        }
        // File import into the dumpster: creates a Coding chat (projects/coding-jobs.js) and returns the job. The client
        // then uploads the files via /api/chats/:id/attachments, sends the job with the attachments via
        // /api/chats/:id/message and opens the chat in Coding. `target`: "workspace", "auto" or a project id of this
        // workspace; `text`: a hint from the user (the dumpster's text field).
        if (sub === "/context/ingest" && m === "POST") {
          const b = await readBody(req);
          const r = createImportChat(wid, { target: b.target, text: b.text });
          if (!r) return send(res, 400, { error: T("Project not found") });
          return send(res, 201, r);
        }
        if (sub === "/context-categories" && m === "GET") return send(res, 200, store.categories(wid));
        const contextMatch = sub.match(/^\/context\/(\d+)$/);
        if (contextMatch) {
          if (m === "GET") { const it = store.getContextItem(wid, Number(contextMatch[1])); return it ? send(res, 200, it) : send(res, 404, { error: "not found" }); }
          // OKF light: workspace knowledge has lifecycle/links but no git anchors.
          if (m === "PUT") {
            const iid = Number(contextMatch[1]);
            const inventory = store.getContextItem(wid, iid);
            if (!inventory) return send(res, 404, { error: "not found" });
            const b = await readBody(req);
            const wsSlugs = new Map(store.listContext(wid, { status: "all" }).map((r) => [r.slug, { id: r.id, title: r.title, status: r.status }]));
            const problems = validateOkf({ status: b.status, confidence: b.confidence, links: b.links }, { slugs: wsSlugs });
            if (problems.length) return send(res, 400, { error: T("OKF validation failed — nothing changed."), problems });
            // The FORM (projects/context-form.js) as in the project PUT: hints; rejected only with the agent marker
            // (cbase_workspace_context_update) for a body over the limit that grows compared to the stored one.
            const form = checkContextForm({ title: b.title, summary: b.summary, body: b.body, category: b.category ?? inventory.category },
              { previousBodyLength: String(inventory.body || "").length, lock: b.ofAgent === true });
            if (form.rejection) return send(res, 400, { error: formRejectionText(form.rejection) });
            return send(res, 200, withFormHints(store.updateContext(wid, iid, {
              category: b.category ?? undefined,
              title: b.title != null ? String(b.title) : undefined,
              body: b.body ?? undefined,
              summary: b.summary != null ? String(b.summary) : undefined,
              tags: b.tags ?? undefined,
              status: b.status ?? undefined,
              owners: b.owners ?? undefined,
              links: b.links,
              confidence: b.confidence ?? undefined,
            }), form.formHints));
          }
          if (m === "DELETE") return send(res, 200, { ok: store.deleteContext(wid, Number(contextMatch[1])) });
        }
        // Browser tab (workspace level): streamed Chromium with a persistent profile per scope.
        if (sub === "/browser/ensure" && m === "POST") {
          try {
            // The same computation as the turn of a chat without a project (devtools/user-browser.js userBrowserTarget).
            const b = await ensureUserBrowser(userBrowserTarget({ workspace: ws }));
            return send(res, 200, b);
          } catch (e) { return send(res, 200, { error: String(e.message || e) }); }
        }
        // Code editor / git / terminal / debug on the workspace level — root = workspace folder.
        // Logic shared with projects (codeRoute). Answers /files, /git, /ts, /terminal, /debug/launch.
        // A repo under the folder of a converted project runs in that project's container; everything else, including
        // terminal and debugger, stays in the user container. The source is a factory — asked only by a /git, /files
        // or /ts route (the latter two via fileLimit: the area of a file of a converted project).
        // Only in ops mode (devtools/code-route.js): the upload stamp under `ws:<id>` (an upload holds `busy` here too;
        // an upload id belongs to the project level — 400 OPERATION_LOCATION), and 409 for every write path that
        // touches the folder of a project whose server-side setup step is currently running.
        const creation = projectboxOps() ? {
          uploadBegins: (operation) => {
            if (operation) throw Object.assign(new Error(T("An upload id belongs to the project level (POST /api/projects/:id/upload) — nothing written.")), { status: 400, code: "OPERATION_LOCATION" });
            return uploadBegins(`ws:${ws.id}`);
          },
          setupLock: (paths) => setupAtPath(ws.id, paths),
          setupPerPath: true,
        } : {};
        if (await codeRoute(ws.path, sub, m, req, res, url, { gitInstanceSource: gitInstanceForWorkspace, workspaceId: ws.id, ...creation })) return; // access of THIS workspace
  return NEXT;
}

// The tool list of a definition from the body: read and checked against the registered tools —
// an unknown name is an error naming it instead of silently disappearing. `raw` undefined = not sent.
function agentTools(raw, workspaceId) {
  let value;
  try { value = toolListFromBody(raw); } catch (e) { return { error: e.message }; }
  const unknown = unknownInWorkspace(value);
  if (unknown) return { error: unknownText(unknown, workspaceId) };
  return { value };
}
