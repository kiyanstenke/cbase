// Routes: projects, services and ports. Every function takes ctx = { req, res, url, p, m } (sub-slices of a family also
// id/sub/chat, wid/sub/ws or pid/sub/proj) and returns NEXT if it is not responsible; any other return means "answered".
// Call order: ROUTES in server.js.
// Functions: projectListRoutes (project-context/schema, context-suggestions/pending, context-index*, projects) ·
// serviceGlobalRoutes · projectRoutes (owner) · itemProjectRoutes (base, agents, mcp-servers, services, vars, skills,
// workflows; `upload` goes through codeProjectRoutes → codeRoute) · serviceProjectRoutes · contextProjectRoutes ·
// servicePortRoutes (project-services POST, ports, conflicts) · serviceEventRoutes · portRoutes.
// projectRoutes is the owner of the family: preamble (regex, lookup, 404), then the table of sub-slices in order.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { classifyContext } from "../claude.js";
import { findSimilarContext } from "../dedup.js";
import { EMBED_MODEL_ID } from "../embeddings.js";
import { backfillContextEmbeddings, rankContext } from "../retrieval.js";
import { DEFAULT_RANGE, claimsPerSpace, findingsInSpace, cwdInside, freePort, instanceAlive, listenersInInstance, parsePortsParam, portsInInstance, resolveListeners, scanPorts } from "../ports.js";
import { staleInfo, staleInfoForList, verifyAnchors } from "../okf.js";
import * as skillsLib from "../skills.js";
import * as wf from "../workflows.js";
import { hostResources, quotaResources, storageLimitInQuota } from "../host-resources.js";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { checkCommandSyntax, checkNow, clearMonitorEvents, currentEventSeq, ServiceInstanceError, ServiceRunningError, serviceRunning, getMonitorEvents, portOccupied, projectResources, checkStartFree, recordAgentRun, serviceStatus, startHeld, startSimple, stopService, tailLogAny } from "../services.js";
import { DIRS } from "../app-state.js";
import { FILE_CATEGORY_MAP, PROJECT_CATEGORIES, PROJECT_CATEGORY_SLUGS, dumpIntoProject, firstHeading, markContextWrite, resolveContextLinks, validateOkf } from "./context.js";
import { formRejectionText, withFormHints, checkContextForm } from "./context-form.js";
import { NEXT, readBody, readBodyOrEmpty, send } from "../runtime/http.js";
import { foreignProviderIn } from "../providers/index.js";
import { agentRunFor } from "../settings/agent-models.js";
import { areaContradicts, areaToCreate, agentSkillsField, skillFields, skillMeta } from "../toolchain/skill-catalog.js";
import { SkillError, withChanges, changeSkill, skillCreate, skillDelete } from "../toolchain/skill-change.js";
import { unknownInWorkspace, unknownText, toolListFromBody } from "../toolchain/agent-tools.js";
import { agentMcpFromBody } from "../toolchain/agent-mcp.js";
import { runServicesScan, serviceScans } from "./scans.js";
import { codeProjectRoutes } from "../devtools/routes.js";
import { gitStandsSituation } from "../devtools/code-route.js";
import { withLosses, saveWorkflow, workflowFull, workflowMeta, workflowTriggerRoute } from "../workflows/definitions.js";
import { headersChange, normalizeMcpBody, varsBody, varsMcpRow } from "../toolchain/mcp-config.js";
import { serviceCwd, startServiceChat } from "./coding-jobs.js";
import { running } from "../runs/state.js";
import { dynWorkflowProjectRoutes } from "../dynworkflows/routes.js";
import { projectDelete } from "../projectbox/erase.js";
import { projectInstanceField } from "../projectbox/names.js";
import { instanceForProject } from "../runs/instance.js";
import { instanceTarget, instanceTargets, identifierParts, convertedProjects } from "../projectbox/network-targets.js";
import { MAIN } from "../projectbox/creation.js";
import { portChange, portsWithHint } from "../projectbox/transition.js";
import { ONLY_IN_OPS, projectboxOps } from "../projectbox/ops.js";
import { relocationProjectRoutes } from "../projectbox/relocation/routes.js";
import { setupProjectRoutes } from "../projectbox/setup/routes.js";
import { setupField, layoutWriteLock } from "../projectbox/setup/status.js";
import { stackCopyProjectRoutes } from "../stacks/routes.js";
import { instanceProjectRoutes } from "../projectbox/instance-actions.js"; // actions on an instance
import { instancesTreeProjectRoutes } from "../projectbox/instances-tree.js"; // the instances tree
import { timelineRoutes } from "../timeline/routes.js"; // timeline per project: list, toggle, dismiss, the agent's path
import { gitViewProjectRoutes } from "../gitView/routes.js"; // git view: overview, fetch, detail, diff
import { withRepoCount } from "../gitView/repos.js"; // `repos` per project in GET /api/projects
import { lfsAccessProjectRoutes } from "../projectbox/lfs-access.js";
import { layoutProjectRoutes } from "../projectbox/layout/routes.js"; // layout of existing projects
import { outerLoopProjectRoutes } from "../outerloop/routes.js";
import { projectLocked } from "../projectbox/idle.js";
import { serviceWithInstances, instancesFromTwo, resourcesWithInstances } from "./instance-fields.js";

// Is the project in a relocation? The lock with reason "relocation" (from idle until the end), an open relocation journal
// (also after a restart, before restart grace resumes) or an instance in state "relocation". A service the human starts in B
// during this window would be stopped again by the relocation's "stop" step — without notice.
// Read-only: projectbox/idle.js and projectbox/relocation/ stay untouched.
// Per instance: lock and journal of a relocation apply to the PROJECT, the state "relocation" to the row of THIS instance (a
// copy is never in it; for main the same answer as long as only main has a row).
function relocationInProgress(projectId, instance = MAIN) {
  if (projectLocked(projectId)?.reason === "relocation") return true;
  if (store.openRelocation(projectId)) return true;
  if (instance !== MAIN) return store.projectInstance(projectId, instance)?.state === "relocation";
  return store.projectInstancesOf(projectId).some((i) => i.state === "relocation");
}

// The `hint` of the auto anchor from the SITUATION gitStandsSituation (devtools/code-route.js) returned — the text must not
// contradict `containerStands` (a PAUSED container and a missing or failing wakeup do not wake anything):
//   reason "stopped"   the wakeup ran: "it is being woken".
//   reason "frozen"    a pause someone else holds: "briefly frozen — it is not being woken".
//   otherwise (`error`) "not running and was not started" plus the message of the docker CLI or the wakeup.
function anchorHint(situation) {
  if (situation?.reason === "stopped") {
    return T("Created, but without an anchor: the project container is stopped — it is being woken. Anchor it afterwards with cbase_context_verify.");
  }
  if (situation?.reason === "frozen") {
    return T("Created, but without an anchor: the project is briefly frozen (paused) — it is not being woken. Once it resumes, anchor it with cbase_context_verify.");
  }
  const error = String(situation?.error || "").replace(/\s+/g, " ").trim().slice(0, 400); // multi-line: the start failure is at the end
  return T`Created, but without an anchor: the project container is not running and was not started${error ? ` (${error})` : ""}. Once it runs, anchor it with cbase_context_verify.`;
}

// The instance of a service call (start, stop, log) from `?instance`, three-valued like the tunnel (tunnel.js) — a missing
// field is no statement:
//   missing                   main: every call without it, byte-identical.
//   "" (empty)                main as well. At the tunnel empty means "explicitly B"; for a service there is no B path next
//                             to main — without relocation main IS B, with relocation no service of the project runs in B.
//                             From a project network the fence rejects empty anyway.
//   "<projectId>/<instance>"  this instance. `main` is main (also before the relocation); a copy must exist NOW — unknown
//                             404 (without the ops marker with ONLY_IN_OPS), unreadable 500; no identifier or one of
//                             ANOTHER project 400. Never a fallback to main.
// The rejections use the vocabulary of the Code tab's instance choice (devtools/routes.js selectedInstance): 400
// `code: "INSTANCE_INVALID"`, 404 `code: "UNKNOWN_INSTANCE"`, each with the named identifier as `identifier` — by that a view
// visibly falls back to main (web/src/lib/code-instance.ts, iOS Code/CodeInstance.swift). The 500 (row unreadable) carries no
// `code`: it is no verdict on the choice.
// → `{ instance }` or `{ status, response }` (the body of the rejection).
function serviceInstance(raw, pid) {
  if (raw === null || raw === "") return { instance: MAIN };
  const reject = (status, code, error) => ({ status, response: { ...(code ? { code } : {}), identifier: raw, error } });
  const parts = identifierParts(raw);
  if (!parts) return reject(400, "INSTANCE_INVALID", T`not an instance identifier “<project>/<instance>”: ${raw}`);
  if (parts.projectId !== String(pid)) return reject(400, "INSTANCE_INVALID", T`instance ${raw} does not belong to project ${pid}`);
  if (parts.instance === MAIN) return { instance: MAIN };
  let target;
  try { target = instanceTarget(raw); } catch (e) { return reject(500, null, String(e?.message || e)); }
  if (!target) return reject(404, "UNKNOWN_INSTANCE", projectboxOps() ? `unknown instance: ${raw}` : ONLY_IN_OPS);
  return { instance: target.instance };
}
// A copy that vanished between choice and call (services.js ServiceInstanceError) — 404 as above, the same body.
const serviceError = (res, e) => {
  if (e instanceof ServiceInstanceError) return send(res, e.status, { code: e.code, identifier: e.identifier, error: e.message });
  throw e;
};

export async function projectListRoutes(ctx) {
  const { req, res, url, p, m } = ctx;

      // ── Projects (global) + project context ─────────────────────────────
      if (p === "/api/project-context/schema" && m === "GET") return send(res, 200, PROJECT_CATEGORIES);
      // Pending curator suggestions per project (for badges in the UI).
      if (p === "/api/context-suggestions/pending" && m === "GET") return send(res, 200, store.pendingSuggestionCounts());
      // State and rebuild of the knowledge search index. GET is diagnosis ("how much is embedded?"), POST catches up what is
      // missing; with {"reset":true} all vectors are discarded and recomputed (needed after changing the embedding model).
      if (p === "/api/context-index" && m === "GET") {
        return send(res, 200, { model: EMBED_MODEL_ID, scopes: store.contextEmbeddingStats(EMBED_MODEL_ID) });
      }
      if (p === "/api/context-index/reindex" && m === "POST") {
        const b = await readBodyOrEmpty(req);
        const cleared = b && b.reset ? store.clearContextEmbeddings() : 0;
        const result = await backfillContextEmbeddings();
        return send(res, 200, { cleared, ...result, scopes: store.contextEmbeddingStats(EMBED_MODEL_ID) });
      }
      // A converted (or currently relocating) project carries `instance` — name `<slug>.cbase`, container, state
      // (projectbox/names.js projectInstanceField). Without an instance row no field.
      // Plus `setup` per project with an open setup — the same computation as GET /api/workspaces
      // (projectbox/setup/status.js); without server operation unchanged.
      // Plus `repos` per project — the number of code repos or `null` (not read yet); only in server operation
      // (gitView/repos.js withRepoCount).
      if (p === "/api/projects" && m === "GET") return send(res, 200, withRepoCount(setupField(projectInstanceField(store.listAllProjects()))));
  return NEXT;
}

export async function serviceGlobalRoutes(ctx) {
  const { req, res, url, p, m } = ctx;
      // ALL scanned project services (incl. portless ones) + live status — for the Apps page.
      if (p === "/api/project-services" && m === "GET") {
        const svcs = store.listAllProjectServices();
        // Per service `instances: [{ identifier, running, holdsStart }]` — ONLY from two instances of the project on
        // (projects/instance-fields.js).
        const instancesPerProject = new Map();
        const instancesOf = (pid) => {
          if (!instancesPerProject.has(pid)) instancesPerProject.set(pid, instancesFromTwo(pid));
          return instancesPerProject.get(pid);
        };
        const withStatus = await Promise.all(
          svcs.map(async (s) => {
            // serviceRunning instead of a port probe — a portless service runs if its group (or its run in the container) is alive.
            const running = await serviceRunning(s.projectId, s);
            // The same answer as the start guard — the Apps page offers "Stop" on running || holdsStart.
            const row = { ...s, running, holdsStart: !running && (await startHeld(s.projectId, s)) };
            return serviceWithInstances(row, instancesOf(s.projectId), running,
              (instance) => serviceRunning(s.projectId, s, { instance }),
              (instance) => startHeld(s.projectId, s, { instance }));
          }),
        );
        return send(res, 200, withStatus);
      }
      // Project resources: CPU/RAM of the running containers per project + disk (folder size).
      // ?workspaceId filters; ?projectId limits to one project; ?disk=0 skips the (more expensive) du.
      if (p === "/api/project-resources" && m === "GET") {
        const wsFilter = url.searchParams.get("workspaceId") || null;
        const projFilter = url.searchParams.get("projectId") || null;
        const includeDisk = url.searchParams.get("disk") !== "0";
        const svcs = store.listAllProjectServices();
        let projects = store.listAllProjects();
        if (wsFilter) projects = projects.filter((pr) => pr.workspaceId === wsFilter);
        if (projFilter) projects = projects.filter((pr) => pr.id === projFilter);
        const byProject = projects.map((pr) => ({
          id: pr.id, name: pr.name, path: pr.path,
          services: svcs.filter((s) => s.projectId === pr.id && s.container),
        }));
        // `host`: what the machine has left overall (RAM, swap, load, disk) — the pill shows it above the breakdown per
        // project. In the user container /proc/meminfo shows the HOST, not the quota: the container's limits are separate in
        // `quota` (cgroup memory.max/cpu.max, `null` without a limit), and `memLimitBytes` of a converted project is never
        // above it.
        let host = null;
        try { host = hostResources(DIRS?.data || process.cwd()); } catch { /* without numbers, not without an answer */ }
        let quota = null;
        try { quota = quotaResources(); } catch { /* without a quota, not without an answer */ }
        try {
          const out = await projectResources(byProject, { includeDisk });
          let converted = null;
          if (quota) { try { converted = convertedProjects(); } catch { /* uncapped, not without an answer */ } }
          const capped = (rows) => (converted ? rows.map((z) => storageLimitInQuota(z, quota, converted.has(String(z.projectId)))) : rows);
          // `instances` (from two instances on) gets the fields of the contract (projects/instance-fields.js).
          return send(res, 200, { ...(Array.isArray(out) ? { resources: resourcesWithInstances(capped(out)) } : out), host, quota });
        } catch (e) { return send(res, 200, { error: String(e.message || e), resources: [], host, quota }); }
      }
      // Correct/remove a single scanned service — so that an agent, after really resolving a conflict, sets the scan data
      // straight directly (no re-scan needed; cbase_service_update/_delete).
      {
        const psm = p.match(/^\/api\/project-services\/(\d+)$/);
        if (psm) {
          const sid = Number(psm[1]);
          const service = store.getProjectService(sid);
          if (!service) return send(res, 404, { error: "service not found" });
          if (m === "PATCH") {
            const b = await readBody(req);
            const fields = {};
            if ("port" in b) {
              if (b.port === null) fields.port = null;
              else if (Number.isInteger(b.port) && b.port >= 1 && b.port <= 65535) fields.port = b.port;
              else return send(res, 400, { error: T("port must be 1-65535 or null") });
            }
            // On a service of a CONVERTED project the port is not moved — unless something already listens on the new one in
            // the project container (then the registration follows the run). The response carries the hint there
            // (projectbox/transition.js). Without a converted project `converted` is empty.
            const converted = convertedProjects();
            const inContainer = converted.has(String(service.projectId));
            if ("port" in fields) {
              const check = await portChange({ service, port: fields.port, converted });
              if (!check.ok) return send(res, check.status, { error: check.error });
            }
            if (typeof b.name === "string" && b.name.trim()) fields.name = b.name.trim().slice(0, 100);
            if (typeof b.startCommand === "string") {
              // Length limit WITH a message: truncating silently stores a command ending mid-word, and a truncated command
              // is in the worst case a different command.
              if (b.startCommand.length > 300) return send(res, 400, { error: T`Start command is ${b.startCommand.length} characters, 300 are allowed. Please shorten it — truncating silently would change the command.` });
              fields.startCommand = b.startCommand;
              // Syntax gate: do not store broken commands at all — the user sees the error at once, an agent
              // (cbase_service_update) gets it as the response and corrects it.
              const synErr = checkCommandSyntax(fields.startCommand);
              if (synErr) return send(res, 400, { error: T`Start command has a syntax error: ${synErr}` });
            }
            // The description is the service's operating manual and must stay correctable: otherwise a description and the
            // start command next to it can contradict each other with no way to fix it.
            if (typeof b.description === "string") {
              if (b.description.length > 2000) return send(res, 400, { error: T`Description is ${b.description.length} characters, 2000 are allowed.` });
              fields.description = b.description;
            }
            // The response carries the replaced start command when a stored command was displaced — the store appends it (it
            // knows the predecessor because it writes it to the history). Whoever overwrites can restore it at the end.
            const fresh = store.updateProjectService(sid, fields);
            return send(res, 200, inContainer && fresh ? portsWithHint([fresh], converted)[0] : fresh);
          }
          if (m === "DELETE") return send(res, 200, { ok: store.deleteProjectService(sid) });
        }
        const pshm = p.match(/^\/api\/project-services\/(\d+)\/command-history$/);
        if (pshm && m === "GET") {
          const sid = Number(pshm[1]);
          if (!store.getProjectService(sid)) return send(res, 404, { error: "service not found" });
          return send(res, 200, { history: store.serviceCommandHistory(sid) });
        }
      }
  return NEXT;
}

export async function projectRoutes(ctx) {
  const { req, res, url, p, m } = ctx;
      const pj = p.match(/^\/api\/projects\/([0-9a-f-]+)(\/.*)?$/);
      if (pj) {
        const pid = pj[1]; const sub = pj[2] || "";
        const proj = store.getProject(pid);
        if (!proj) return send(res, 404, { error: "project not found" });
        const fctx = { ...ctx, pid, sub, proj };
        for (const s of [
          itemProjectRoutes,
          dynWorkflowProjectRoutes, // adopting dynamic workflows
          relocationProjectRoutes, // relocation (plan, start, status) — projectbox/relocation/routes.js
          setupProjectRoutes, // setup (sources, conflict, retry) and later upload — projectbox/setup/routes.js
          stackCopyProjectRoutes, // request and read stack copies — stacks/routes.js
          instanceProjectRoutes, // repos, branch, discard, stack restart per instance — projectbox/instance-actions.js
          instancesTreeProjectRoutes, // the instances tree — projectbox/instances-tree.js
          lfsAccessProjectRoutes, // git access for LFS in agent shells — projectbox/lfs-access.js
          layoutProjectRoutes, // read and check the layout of an existing project; remove old containers — projectbox/layout/routes.js
          outerLoopProjectRoutes, // adopting the workspace's outer-loop agents — outerloop/routes.js
          timelineRoutes, // timeline per project: /timeline… — BEFORE codeProjectRoutes — timeline/routes.js
          gitViewProjectRoutes, // git view: overview, fetch, detail, diff — BEFORE codeProjectRoutes — gitView/routes.js
          codeProjectRoutes,
          serviceProjectRoutes,
          contextProjectRoutes,
        ]) {
          const r = await s(fctx);
          if (r !== NEXT) return r;
        }

      }
  return NEXT;
}
export async function itemProjectRoutes(ctx) {
  const { req, res, url, p, m, pid, sub, proj } = ctx;

        if (sub === "" && m === "GET") return send(res, 200, proj);
        if (sub === "" && m === "PATCH") {
          const b = await readBody(req);
          const name = typeof b.name === "string" ? b.name.trim() : "";
          if (!name) return send(res, 400, { error: T("name required") });
          return send(res, 200, store.renameProject(pid, name.slice(0, 120)));
        }
        if (sub === "" && m === "DELETE") {
          // FIRST the project container (stop, remove by id, network, name, row; volume and runtime folder only with
          // purge=1 — discarding is not deleting). 409 during creation/relocation/re-creation and for a converted project
          // that is not idle, 500 if it does not go down: then the route deletes NOTHING. The same path as
          // DELETE /api/workspaces/:wid/projects/:pid (projectbox/erase.js projectDelete).
          const r = await projectDelete({ workspaceId: proj.workspaceId, projectId: pid, project: proj, purge: url.searchParams.get("purge") === "1" });
          return send(res, r.status, r.body);
        }
        // Project upload: there is only ONE version — codeProjectRoutes passes /upload to devtools/code-route.js:codeRoute,
        // a few lines later in the same family. Reintroducing a branch here would silently shadow it, because
        // itemProjectRoutes runs BEFORE codeProjectRoutes; server/backend/test/code-scopes.test.js measures the branch on
        // both levels and forbids the copy's return.

        // Project subagents: the project's own agents (CRUD) + view of the workspace agents with their enabled status.
        // The default is per project (`wsAgentsDefault`): a new project adopts all ("on", switching off is the exception),
        // an older project stays opt-in ("off"). `enabled` comes from the same computation as the run's agent set
        // (store/toolchain.js wsAgentsInProject), and the default goes along so the UI states what is true for THIS project.
        if (sub === "/agents" && m === "GET") {
          return send(res, 200, {
            projectAgents: store.listProjectAgents(pid),
            workspaceAgents: store.wsAgentsInProject(pid, proj.workspaceId),
            wsAgentsDefault: store.wsAgentsDefault(pid),
          });
        }
        if (sub === "/agents" && m === "POST") {
          const b = await readBody(req);
          const name = String(b.name || "").trim();
          if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || name.length > 64) return send(res, 400, { error: T("Name must be lower-kebab-case (a-z, 0-9, -)") });
          if (foreignProviderIn(b.model)) return send(res, 400, { error: T`Unknown provider in model: ${foreignProviderIn(b.model)}` });
          const list = agentTools(b.tools, proj.workspaceId);
          if (list.error) return send(res, 400, { error: list.error });
          const mcp = agentMcpFromBody(b.mcp, { workspaceId: proj.workspaceId, projectId: pid });
          if (mcp.error) return send(res, 400, { error: mcp.error });
          const now = Date.now();
          return send(res, 201, store.createAgent({ id: crypto.randomUUID(), workspaceId: proj.workspaceId, projectId: pid, name, description: b.description || "", toolList: list.value ?? null, model: b.model || "", body: b.body || "", skills: agentSkillsField(b.skills), mcp: mcp.value ?? {}, createdAt: now, updatedAt: now }));
        }
        // Switch a workspace agent on/off in the project. `enabled` is required and a boolean — a missing field is no
        // statement: in a project that adopts the workspace agents, `!!undefined` would silently switch the agent OFF. And
        // only a workspace agent of THIS workspace is switchable (like the workspace credentials).
        const ae = sub.match(/^\/agents\/([0-9a-f-]+)\/enabled$/);
        if (ae && m === "PATCH") {
          const b = await readBody(req);
          if (typeof b?.enabled !== "boolean") return send(res, 400, { error: T("enabled (true/false) is missing") });
          if (!store.listWorkspaceAgents(proj.workspaceId).some((a) => a.id === ae[1])) return send(res, 404, { error: "workspace agent not found" });
          store.setAgentEnabled(pid, ae[1], b.enabled);
          return send(res, 200, { ok: true });
        }
        const pa = sub.match(/^\/agents\/([0-9a-f-]+)$/);
        if (pa) {
          const ag = store.getAgent(pa[1]);
          if (!ag || ag.projectId !== pid) return send(res, 404, { error: "agent not found" });
          if (m === "GET") return send(res, 200, ag);
          if (m === "PUT") {
            const b = await readBody(req);
            const fields = { updatedAt: Date.now() };
            // Only the built-in providers: a reference "<foreign>::…" is a 400 (providers/index.js foreignProviderIn).
            if (typeof b.model === "string" && foreignProviderIn(b.model)) return send(res, 400, { error: T`Unknown provider in model: ${foreignProviderIn(b.model)}` });
            for (const k of ["description", "model", "body"]) if (typeof b[k] === "string") fields[k] = b[k];
            const list = agentTools(b.tools, proj.workspaceId);
            if (list.error) return send(res, 400, { error: list.error });
            if (list.value !== undefined) fields.toolList = list.value;
            // The coding MCP servers of the type (toolchain/agent-mcp.js): if the field is missing, the choice stays (a client
            // without the field does not delete it).
            const mcp = agentMcpFromBody(b.mcp, { workspaceId: proj.workspaceId, projectId: pid });
            if (mcp.error) return send(res, 400, { error: mcp.error });
            if (mcp.value !== undefined) fields.mcp = mcp.value;
            if (b.skills !== undefined) fields.skills = agentSkillsField(b.skills);
            return send(res, 200, store.updateAgent(pa[1], fields));
          }
          if (m === "DELETE") return send(res, 200, { ok: store.deleteAgent(pa[1]) });
        }

        // Project MCP servers: the project's own servers (isolated, CRUD on workspace level via /api/mcp-servers/:id) PLUS
        // the workspace servers — they apply in every project until the project hides them (opt-out like the credentials).
        // `enabled` here means "not hidden"; whether the server is on workspace-wide is `inWorkspaceActive` (one switched off
        // there is missing in every project, even if it is not hidden here). The catalog is the same as in the workspace
        // (/api/mcp-catalog).
        if (sub === "/mcp-servers" && m === "GET") {
          const hidden = store.listExcludedMcpServerIds(pid);
          return send(res, 200, {
            projectServers: store.listProjectMcpServers(pid),
            workspaceServers: store.listMcpServers(proj.workspaceId).map((s) => ({ ...s, enabled: !hidden.has(s.id), inWorkspaceActive: s.enabled })),
          });
        }
        // Create a project-owned MCP server (isolated from other projects).
        if (sub === "/mcp-servers" && m === "POST") {
          const b = await readBody(req);
          const norm = normalizeMcpBody(b);
          if (norm.error) return send(res, 400, { error: norm.error });
          // Creating takes headers along.
          const header = headersChange(b.headers, norm.transport);
          if (header.error) return send(res, 400, { error: header.error });
          if (store.listProjectMcpServers(pid).some((s) => s.name === norm.name)) {
            return send(res, 409, { error: T`A server "${norm.name}" already exists in this project.` });
          }
          const now = Date.now();
          return send(res, 201, store.createMcpServer({ id: crypto.randomUUID(), workspaceId: proj.workspaceId, projectId: pid, ...norm, headers: header.headers, createdAt: now, updatedAt: now }));
        }
        // Hide a workspace MCP server in the project (`{enabled:false}`) or show it again (`{enabled:true}`) — only workspace
        // servers, no project servers. The field is required and a boolean: under `!!b.enabled` a body without the field (or
        // with "true" as text) would silently hide it.
        const me = sub.match(/^\/mcp-servers\/([0-9a-f-]+)\/enabled$/);
        if (me && m === "PATCH") {
          const b = await readBody(req);
          const srv = store.getMcpServer(me[1]);
          if (!srv || srv.workspaceId !== proj.workspaceId || srv.projectId) return send(res, 404, { error: "mcp server not found" });
          if (typeof b.enabled !== "boolean") return send(res, 400, { error: T("enabled (true | false) is missing") });
          store.setMcpServerAvailable(pid, me[1], b.enabled);
          return send(res, 200, { ok: true });
        }

        // Services (result of the AI service scan) + run status + re-scan
        if (sub === "/services" && m === "GET") {
          // The scan's status BEFORE the list: a scan that ends during the status probes below would otherwise appear as
          // "done" (with `removed`) next to the list from before. This way "done" is always paired with a list from after,
          // and a still running scan says "running" — the client then asks again anyway.
          const scan = serviceScans.get(pid) || null;
          const services = store.listProjectServices(pid);
          const withStatus = await Promise.all(
            services.map(async (s) => ({ ...s, status: await serviceStatus(pid, s.id, s) })),
          );
          return send(res, 200, { scan, services: withStatus });
        }
        if (sub === "/services/scan" && m === "POST") {
          if (!fs.existsSync(proj.path)) return send(res, 400, { error: T("Project path not found") });
          runServicesScan(proj);
          return send(res, 202, { ok: true });
        }

        // Project credentials/variables/links — structured like workspace vars, but bound to the project.
        // ?mcp=1 = MCP view: list WITHOUT values (discovery); value retrieval only with mcp_access.
        if (sub === "/vars" && m === "GET") {
          // ?mcp=1 = the agent's view: effective set (own project vars + adopted workspace vars), WITHOUT values.
          // Without mcp=1 = only the own project vars (for the UI CRUD).
          if (url.searchParams.get("mcp") === "1") {
            return send(res, 200, store.effectiveProjectVars(pid, proj.workspaceId).map(varsMcpRow));
          }
          return send(res, 200, store.listProjectVars(pid));
        }
        // Workspace credentials with their availability for this project (the UI's list). They are available in EVERY
        // project (default on); `enabled: false` are the exceptions a project explicitly hid.
        if (sub === "/workspace-vars" && m === "GET") {
          const excluded = store.listExcludedWorkspaceVarIds(pid);
          return send(res, 200, store.listVars(proj.workspaceId).map((v) => ({ ...v, enabled: !excluded.has(v.id) })));
        }
        const wve = sub.match(/^\/workspace-vars\/(\d+)\/enabled$/);
        if (wve && m === "PATCH") {
          const b = await readBody(req);
          if (!store.listVars(proj.workspaceId).some((x) => x.id === Number(wve[1]))) return send(res, 404, { error: "workspace var not found" });
          store.setWorkspaceVarAvailable(pid, Number(wve[1]), !!b.enabled);
          return send(res, 200, { ok: true });
        }
        if (sub === "/vars" && m === "POST") {
          const b = await readBody(req);
          const key = String(b.key || "").trim();
          if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) return send(res, 400, { error: T("key: letter first, then letters/digits/_ . - (max. 64)") });
          const patch = varsBody(b, { fresh: true });
          if (patch.error) return send(res, 400, { error: patch.error });
          if (store.getProjectVarByKey(pid, key)) return send(res, 409, { error: T`key "${key}" already exists` });
          return send(res, 201, store.createProjectVar(pid, { key, ...patch }));
        }
        const pvkm = sub.match(/^\/vars\/by-key\/([^/]+)$/);
        if (pvkm && m === "GET") {
          // Resolve effectively: own project var first, otherwise an adopted workspace var.
          const v = store.resolveProjectVar(pid, proj.workspaceId, decodeURIComponent(pvkm[1]));
          if (!v) return send(res, 404, { error: "Entry not found — cbase_vars_list shows the existing keys." });
          if (url.searchParams.get("mcp") === "1" && !v.mcpAccess) {
            return send(res, 403, { error: `"${v.key}" is locked for Claude — please ask the user for the value directly or ask for it to be released.` });
          }
          return send(res, 200, v);
        }
        const pvim = sub.match(/^\/vars\/(\d+)$/);
        if (pvim && m === "PUT") {
          const b = await readBody(req);
          const old = store.listProjectVars(pid).find((x) => x.id === Number(pvim[1]));
          if (!old) return send(res, 404, { error: T("Entry not found") });
          const patch = varsBody(b, { fresh: false, kindOld: old.kind });
          if (patch.error) return send(res, 400, { error: patch.error });
          if (b.key !== undefined) {
            const key = String(b.key).trim();
            if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) return send(res, 400, { error: T("Invalid key") });
            const other = store.getProjectVarByKey(pid, key);
            if (other && other.id !== Number(pvim[1])) return send(res, 409, { error: T`key "${key}" already exists` });
            patch.key = key;
          }
          const v = store.updateProjectVar(Number(pvim[1]), patch);
          return v ? send(res, 200, v) : send(res, 404, { error: T("Entry not found") });
        }
        if (pvim && m === "DELETE") return send(res, 200, { ok: store.deleteProjectVar(Number(pvim[1])) });

        // Project skills (provider-agnostic, DB): the project's own skills (isolated, always Coding) PLUS a view of the
        // workspace coding skills with their hide status (opt-out, like the workspace credentials). At runtime ONLY the
        // effective set (own + not hidden) is in the chat's catalog — the same path for every provider.
        if (sub === "/skills" && m === "GET") return send(res, 200, withChanges(proj.workspaceId, store.listProjectSkills(pid).map(skillMeta)));
        if (sub === "/skills" && m === "POST") {
          const b = await readBody(req);
          const newArea = areaToCreate(b, { project: true });
          if (newArea.error) return send(res, 400, { error: newArea.error });
          const name = String(b.name || "").trim();
          if (!skillsLib.validName(name)) return send(res, 400, { error: T("Skill name must be lower-kebab-case (a-z, 0-9, -)") });
          if (store.getSkillByName(proj.workspaceId, pid, name)) return send(res, 409, { error: T`A skill "${name}" already exists in this project.` });
          // Through the ONE mutation path (toolchain/skill-change.js): history, event — the response stays the skill.
          try {
            const { skill } = skillCreate({ workspaceId: proj.workspaceId, projectId: pid, name, description: b.description || "", body: b.body || "", allowedTools: b.allowedTools || "", model: b.model || "", area: newArea.area }, { who: "human" });
            return send(res, 201, skill);
          } catch (e) { if (e instanceof SkillError) return send(res, e.status, e.body); throw e; }
        }
        // Workspace CODING skills with their hide status for this project — `enabled` = NOT hidden; the same computation as
        // every run's set (store/toolchain.js wsSkillsInProject).
        if (sub === "/workspace-skills" && m === "GET") {
          return send(res, 200, withChanges(proj.workspaceId, store.wsSkillsInProject(pid, proj.workspaceId).map(({ enabled, ...s }) => ({ ...skillMeta(s), enabled }))));
        }
        // Hide/show by skill ID. A name no longer matches a skill here and ends in the 404. A body without a boolean is no
        // statement (400).
        const pske = sub.match(/^\/workspace-skills\/([^/]+)\/enabled$/);
        if (pske && m === "PATCH") {
          const b = await readBody(req);
          if (typeof b.enabled !== "boolean") return send(res, 400, { error: T("enabled (true | false) is missing") });
          const skillId = pske[1]; // a UUID — compared raw (a broken %-escape would otherwise be a throw instead of the 404)
          if (!store.wsSkillsInProject(pid, proj.workspaceId).some((s) => s.id === skillId)) return send(res, 404, { error: "workspace skill not found" });
          store.setSkillExcluded(pid, skillId, !b.enabled);
          return send(res, 200, { ok: true });
        }
        // Project workflows: own ones (isolated) PLUS a view of the workspace workflows with their adoption status — the
        // same opt-in pattern as for skills, agents and MCP servers.
        if (sub === "/workflows" && m === "GET") return send(res, 200, store.listProjectWorkflows(pid).map(workflowMeta));
        if (sub === "/workflows" && m === "POST") {
          const b = await readBody(req);
          const name = String(b.name || "").trim().slice(0, 64);
          if (!name) return send(res, 400, { error: T("Name required") });
          if (store.getWorkflowByName(proj.workspaceId, pid, name)) return send(res, 409, { error: T`A workflow "${name}" already exists in this project.` });
          const now = Date.now();
          return send(res, 201, workflowFull(store.createWorkflow({ id: crypto.randomUUID(), workspaceId: proj.workspaceId, projectId: pid, name, description: String(b.description || "").slice(0, 400), graph: wf.normalizeGraph(b.graph), createdAt: now, updatedAt: now })));
        }
        if (sub === "/workspace-workflows" && m === "GET") {
          const enabled = store.listEnabledWorkflowNames(pid);
          return send(res, 200, store.listWorkspaceWorkflows(proj.workspaceId).map((w) => ({ ...workflowMeta(w), enabled: enabled.has(w.name) })));
        }
        const pwfe = sub.match(/^\/workspace-workflows\/([^/]+)\/enabled$/);
        if (pwfe && m === "PATCH") {
          const b = await readBody(req);
          store.setWorkflowEnabled(pid, decodeURIComponent(pwfe[1]), !!b.enabled);
          return send(res, 200, { ok: true });
        }
        const pwfm = sub.match(/^\/workflows\/([0-9a-f-]+)$/);
        if (pwfm) {
          const flow = store.getWorkflow(pwfm[1]);
          if (!flow || flow.projectId !== pid) return send(res, 404, { error: "workflow not found" });
          if (m === "GET") return send(res, 200, workflowFull(flow));
          if (m === "PUT") {
            const r = await saveWorkflow(req, flow, proj.workspaceId, pid);
            return r.error ? send(res, r.status, { error: r.error }) : send(res, 200, withLosses(r));
          }
          if (m === "DELETE") return send(res, 200, { ok: store.deleteWorkflow(pwfm[1]) });
        }
        {
          const ptm = sub.match(/^\/workflows\/([0-9a-f-]+)\/trigger-(status|test)$/);
          if (ptm) {
            const flow = store.getWorkflow(ptm[1]);
            if (!flow || flow.projectId !== pid) return send(res, 404, { error: "workflow not found" });
            if (await workflowTriggerRoute(req, res, m, sub, flow)) return;
          }
        }

        const psm = sub.match(/^\/skills\/([0-9a-f-]+)$/);
        if (psm) {
          const sk = store.getSkill(psm[1]);
          if (!sk || sk.projectId !== pid) return send(res, 404, { error: "skill not found" });
          if (m === "GET") return send(res, 200, sk);
          if (m === "PUT") {
            const b = await readBody(req);
            const contradiction = areaContradicts(b, sk.area);
            if (contradiction) return send(res, 400, { error: contradiction });
            try {
              const { updatedAt: _u, ...fields } = skillFields(b);
              return send(res, 200, changeSkill(psm[1], fields, { who: "human" }).skill);
            } catch (e) { if (e instanceof SkillError) return send(res, e.status, e.body); throw e; }
          }
          // If an agent definition names the skill, 409 `{ error, references }` — otherwise its next start would fail.
          if (m === "DELETE") {
            try { skillDelete(psm[1], { who: "human" }); return send(res, 200, { ok: true }); }
            catch (e) { if (e instanceof SkillError) return send(res, e.status, e.body); throw e; }
          }
        }
  return NEXT;
}

export async function serviceProjectRoutes(ctx) {
  const { req, res, url, p, m, pid, sub, proj } = ctx;
        // Start a service — { mode: "simple" | "agent" }
        const svcStart = sub.match(/^\/services\/(\d+)\/start$/);
        if (svcStart && m === "POST") {
          const service = store.listProjectServices(pid).find((s) => s.id === Number(svcStart[1]));
          if (!service) return send(res, 404, { error: "service not found" });
          if (!fs.existsSync(proj.path)) return send(res, 400, { error: T("Project path not found") });
          const b = await readBodyOrEmpty(req);
          const mode = b.mode === "agent" ? "agent" : "simple";
          // The instance (`?instance`, three-valued — missing ⇒ main); every check and the start itself apply to it.
          const choice = serviceInstance(url.searchParams.get("instance"), pid);
          if (choice.status) return send(res, choice.status, choice.response);
          const { instance } = choice;
          // There is no agent start in a COPY: the service chat is its OWN chat (coding-jobs.js startServiceChat), and only
          // the chat that created a copy (or a child chat via its start) binds to it — it would run in main and register the
          // service in the copy: 409, never an entry without a run. Checked right after the instance choice, BEFORE any probe
          // and before `setStartInstructions`: the start instruction applies per project and service, not per instance — a
          // rejected start would otherwise still write it.
          if (mode === "agent" && instance !== MAIN) {
            return send(res, 409, { code: "COPY_AGENT", error: T`"${service.name}" can only be started simply (start command) in a copy. There is no agent start in a copy: the chat that starts the service does not know the copy, so it would run in the main instance.` });
          }
          // A copy starts a service only when `ready`. A copy being built, being cleared (the backup runs: what a run writes
          // afterwards bypasses it) or in error must not accept a plain start — the lock in the clients alone is not enough,
          // a view between two polls is stale. 409 with `code` and `identifier` like the other rejections of the instance
          // choice; stopping stays allowed (it clears, it does not write).
          if (instance !== MAIN) {
            const state = store.projectInstance(pid, instance)?.state ?? null;
            if (state !== "ready") {
              const name = instance.replace(/^copy-/, "");
              return send(res, 409, { code: "COPY_NOT_READY", identifier: `${pid}/${instance}`, state, error: T`"${service.name}" was not started: the copy ${name} is not ready right now (${state ?? "unknown"}). Start it again once it is ready.` });
            }
          }
          // No start (plain or via agent) while the project relocates — the relocation would stop it again. The relocation
          // itself starts its services via services.js, not via this route.
          if (relocationInProgress(pid, instance)) {
            return send(res, 409, { code: "RELOCATION", error: T`"${service.name}" was not started: the project is moving into its container. Start it again after the move.` });
          }
          // No start in main while the layout rebuilds the folder — that flow stopped the services and starts them itself
          // (via services.js).
          if (instance === MAIN && layoutWriteLock(pid)) {
            return send(res, 409, { code: "LAYOUT_RUNNING", error: T`"${service.name}" was not started: the project structure is being rebuilt. Start it again afterwards.` });
          }
          // A converted project starts its services in the project container (services.js startSimple). Both checks before
          // that ask the instance: the state in the container, the port on its IP (portOccupied). Without an instance in B.
          // Already running? Check container-aware (Compose-internal services have no host port).
          try {
            if ((await serviceStatus(pid, service.id, { ...service, instance })).running) {
              return send(res, 409, { error: T`"${service.name}" is already running.` });
            }
            if (service.port != null && (await portOccupied(pid, service.port, { instance }))) {
              return send(res, 409, { error: T`Port ${service.port} is already in use — something else is probably running there.` });
            }
          } catch (e) { return serviceError(res, e); }
          // For BOTH paths: if the existing entry holds a live group (the service listens elsewhere or is still booting —
          // the port above did not see it), neither an agent chat is created nor an entry overwritten — 409 like "already
          // running", with `code`, so a client can offer stopping.
          try {
            checkStartFree(pid, service, { instance });
          } catch (e) {
            if (e instanceof ServiceRunningError) return send(res, 409, { code: e.code, error: e.message });
            return serviceError(res, e);
          }
          if (mode === "agent") {
            // Remember start instructions (they survive re-scans) and pass them to the agent.
            const instructions = typeof b.instructions === "string" ? b.instructions : "";
            store.setStartInstructions(pid, service.name, instructions);
            const chatId = startServiceChat(proj, service, instructions);
            recordAgentRun({ projectId: pid, service, chatId });
            return send(res, 202, { mode, chatId });
          }
          if (!service.startCommand) {
            return send(res, 400, { error: T("No start command stored — use the agent start.") });
          }
          // If the existing entry holds a live group, startSimple does not overwrite it but throws — 409 like "already running".
          let run;
          try {
            run = startSimple({ projectId: pid, service, cwd: serviceCwd(proj, service), projectName: proj.name, workspaceId: proj.workspaceId ?? null, instance });
          } catch (e) {
            if (e instanceof ServiceRunningError) return send(res, 409, { code: e.code, error: e.message });
            return serviceError(res, e);
          }
          return send(res, 202, { mode, pid: run.pid });
        }
        // Stop a service
        const svcStop = sub.match(/^\/services\/(\d+)\/stop$/);
        if (svcStop && m === "POST") {
          const service = store.listProjectServices(pid).find((s) => s.id === Number(svcStop[1]));
          if (!service) return send(res, 404, { error: "service not found" });
          const choice = serviceInstance(url.searchParams.get("instance"), pid);
          if (choice.status) return send(res, choice.status, choice.response);
          let r;
          try {
            r = await stopService({ projectId: pid, serviceId: service.id, port: service.port, container: service.container, dir: service.dir || "", instance: choice.instance });
          } catch (e) { return serviceError(res, e); }
          return send(res, 200, r);
        }
        // Service log (last lines) — the file of the plain start, otherwise docker logs of the container.
        const svcLog = sub.match(/^\/services\/(\d+)\/log$/);
        if (svcLog && m === "GET") {
          const service = store.listProjectServices(pid).find((s) => s.id === Number(svcLog[1]));
          if (!service) return send(res, 404, { error: "service not found" });
          const lines = Math.min(2000, Math.max(10, Number(url.searchParams.get("lines")) || 300));
          const choice = serviceInstance(url.searchParams.get("instance"), pid);
          if (choice.status) return send(res, choice.status, choice.response);
          let log;
          try { log = await tailLogAny(pid, service.id, { ...service, instance: choice.instance }, lines); } catch (e) { return serviceError(res, e); }
          return send(res, 200, { log });
        }
  return NEXT;
}
export async function contextProjectRoutes(ctx) {
  const { req, res, url, p, m, pid, sub, proj } = ctx;

        if (sub === "/context/import-folders" && m === "POST") {
          if (!fs.existsSync(proj.path) || !fs.statSync(proj.path).isDirectory()) return send(res, 400, { error: T("Project path not found##2") });
          const imported = [], skipped = [];
          const readAll = (root, cb) => {
            const walk = (dir) => {
              for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
                const fp = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(fp); continue; }
                if (entry.name.startsWith(".")) continue;
                cb(fp, entry.name, path.relative(root, dir) === "" ? "" : path.relative(root, dir));
              }
            };
            walk(root);
          };
          // PROJECT_INFORMATION → project_context (every file one entry, category from the file name)
          const seen = new Set(store.listProjectContext(pid, { withBody: false }).map((c) => c.source));
          for (const rootName of ["PROJECT_INFORMATION", "PROJECT-INFORMATION"]) {
            const root = path.join(proj.path, rootName);
            if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
            readAll(root, (fp, name, folder) => {
              const source = `${rootName}/${folder ? folder + "/" : ""}${name}`;
              const label = `context: ${source}`;
              if (seen.has(source)) { skipped.push(label + " (exists already)"); return; }
              if (fs.statSync(fp).size > 2_000_000) { skipped.push(label + " (too large)"); return; }
              const base = name.replace(/\.md$/i, "").toLowerCase();
              const category = FILE_CATEGORY_MAP[base] || "overview";
              const content = fs.readFileSync(fp, "utf8");
              store.createProjectContext(pid, {
                category,
                title: firstHeading(content) || name.replace(/\.md$/i, ""),
                body: content,
                tags: FILE_CATEGORY_MAP[base] ? "" : base, // keep unknown file names as a tag
                source,
              });
              seen.add(source);
              imported.push(label);
            });
          }
          return send(res, 200, { imported, skipped });
        }

        // Project context (categorized). Contains the OWN entries PLUS those from the adopted workspace categories
        // (origin:"workspace", read-only) — so the agent also sees the adopted context via cbase_context_list. With an
        // active category filter the adopted ones are NOT appended (different taxonomy); without a filter they appear.
        if (sub === "/context" && m === "GET") {
          const category = url.searchParams.get("category") || undefined;
          const q = url.searchParams.get("q") || undefined;
          // `q` is the exact substring search (the UI's filter field, slug/symbol/path matches).
          // `search` is the MEANING search: semantic + BM25 + structure boosts (retrieval.js).
          // Both may come together — then q pre-filters and search sorts.
          const search = (url.searchParams.get("search") || "").trim();
          const meta = !!url.searchParams.get("meta"); // meta=1 → metadata only (OKF read chain: survey first, then load)
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 20));
          const own = store.listProjectContext(pid, {
            category, tag: url.searchParams.get("tag") || undefined, q,
            status: url.searchParams.get("status") || "all",
            path: url.searchParams.get("path") || undefined,
            // A meaning search ALWAYS needs the body: the sentence vector is built from title+summary+body and persisted.
            // Computed from a truncated text it would be permanently wrong. `meta` is therefore applied only after ranking.
            withBody: search ? true : !meta,
          }).map((it) => ({ ...it, origin: "project" }));
          const adopted = category ? [] : store.adoptedWorkspaceContext(pid, proj.workspaceId, { q });
          let out = [...own, ...adopted];
          if (search) {
            out = await rankContext(search, out, { projectId: pid, workspaceId: proj.workspaceId, limit });
            if (meta) out = out.map(({ body, ...rest }) => rest);
          }
          // Freshness per entry (only own, git-anchored ones): commits on code_paths since verification. Runs AFTER ranking —
          // then it costs git calls only for the entries that are returned. Stale entries are NOT penalized: they should be
          // found and checked, not hidden.
          if (fs.existsSync(proj.path)) {
            try {
              const mine = out.filter((it) => it.origin === "project");
              // git in the project container. Deliberately the instance of the PROJECT (main), never that of a copy —
              // project knowledge is the project's state in the shared database; its anchors apply against the main state.
              // What a copy changes only arrives there when it is fetched back.
              const fresh = await staleInfoForList(proj.path, mine, { instance: instanceForProject(pid) });
              for (const it of mine) if (fresh.has(it.id)) it.freshness = fresh.get(it.id);
            } catch { /* best effort — the display degrades to "unrated" */ }
          }
          // In the METADATA list the commit list is only counted, not included: with many stale entries the commit objects
          // dominate the response. This is the survey view of the OKF read chain and should be cheap; whoever needs the
          // commits loads the entry (cbase_context_get) and gets them in full there.
          if (meta) {
            for (const it of out) {
              const f = it.freshness;
              if (!f || !f.commits) continue;
              const { commits, ...rest } = f;
              it.freshness = { ...rest, commitCount: commits.length };
            }
          }
          return send(res, 200, out);
        }
        // Adopting workspace context categories into this project (opt-in, like workspace skills).
        if (sub === "/context/adopt" && m === "GET") {
          return send(res, 200, store.adoptableWorkspaceContextCategories(pid, proj.workspaceId));
        }
        if (sub === "/context/adopt" && m === "POST") {
          const b = await readBody(req);
          const category = String(b.category || "").trim();
          if (!category) return send(res, 400, { error: T("category required") });
          store.setContextCategoryAdopted(pid, category, !!b.enabled);
          return send(res, 200, { ok: true });
        }
        if (sub === "/context" && m === "POST") {
          const b = await readBody(req);
          const category = String(b.category || "").trim();
          if (!PROJECT_CATEGORY_SLUGS.has(category)) return send(res, 400, { error: `category must be a known slug (see /api/project-context/schema)` });
          const title = String(b.title || "").trim();
          const body = String(b.body ?? "");
          const summary = String(b.summary || "").trim();
          if (!title && !body) return send(res, 400, { error: T("title or body required") });
          const problems = validateOkf(b, { slugs: store.projectContextSlugs(pid), projPath: fs.existsSync(proj.path) ? proj.path : null });
          if (problems.length) return send(res, 400, { error: T("OKF validation failed — nothing created."), problems });
          // The FORM (context-form.js): hints in the response; rejected is only a body above the limit, and only with the
          // marker `ofAgent` (only the MCP tools set it) — web and iOS write through the same route, a human only gets the
          // hints.
          const form = checkContextForm({ title, summary, body, category }, { lock: b.ofAgent === true });
          if (form.rejection) return send(res, 400, { error: formRejectionText(form.rejection) });
          // Dedup check (word coverage, see dedup.js) in TWO stages. Rejecting on every find is dangerous, because the
          // protocol then tells the model "extend the named entry instead" — a false alarm thereby merges a new fact into a
          // foreign entry. So it blocks only on evidence that had ZERO false alarms on real data; everything below is
          // created and the find comes along as a hint.
          let similar = [];
          if (!b.force) {
            try {
              const existing = store.listProjectContext(pid, { withBody: true });
              similar = findSimilarContext(existing, { title, summary, body, category, tags: b.tags });
              const blocking = similar.filter((c) => c.blocking);
              if (blocking.length) return send(res, 200, { duplicate: true, candidates: blocking });
            } catch (e) {
              // Dedup is best effort — if it fails, create normally.
            }
          }
          // Auto anchor: whoever creates with code_paths has the code in front of them NOW — the current repo HEADs are the
          // verification state without the agent having to call verify separately.
          let lastVerified = null;
          // If the project container is stopped, the auto anchor wakes it like verification does (gitStandsSituation) — the
          // entry is created unanchored and the response says so (`containerStands` with the situation, `hint` from the same
          // situation — anchorHint: a pause and a missing wakeup do not wake, and the text says that). Without an instance
          // the field is absent.
          let stands = null;
          if (Array.isArray(b.codePaths) && b.codePaths.length && fs.existsSync(proj.path)) {
            try {
              const a = await verifyAnchors(proj.path, b.codePaths, { instance: instanceForProject(pid) });
              if (a.containerStands) {
                const { projectId: _p, ...situation } = gitStandsSituation(a.containerStands.projectId, a.containerStands.error);
                stands = situation;
              } else if (Object.keys(a.commits).length) lastVerified = { commits: a.commits, at: a.at };
            } catch { /* create unanchored — freshness then shows "never verified" */ }
          }
          markContextWrite(pid);
          const created = store.createProjectContext(pid, {
            category, title, body, summary, tags: b.tags, source: String(b.source || "").trim(),
            validAsOf: String(b.validAsOf || "").trim(), pinned: b.pinned,
            slug: b.slug, status: b.status, supersededBy: b.supersededBy, owners: b.owners,
            links: b.links, codePaths: b.codePaths, symbols: b.symbols, confidence: b.confidence, lastVerified,
          });
          // Weaker finds accompany the CREATED entry as a hint — in-band responses steer the model more strongly than any
          // prompt, and here they cost nothing.
          const standsField = stands ? { containerStands: stands, hint: anchorHint(stands) } : {};
          if (similar.length) {
            return send(res, 201, withFormHints({
              ...created,
              ...standsField,
              similar,
              hint: T(
                "Created. Similar entries found — check whether your knowledge belongs there instead (cbase_context_update); otherwise link them via links.related.",
              ),
            }, form.formHints));
          }
          return send(res, 201, withFormHints({ ...created, ...standsField }, form.formHints));
        }
        // Project dumpster (FULLY AUTONOMOUS) — logic in dumpIntoProject (also used by workspace routing).
        if (sub === "/context/dump" && m === "POST") {
          const b = await readBody(req);
          const text = String(b.text || "").trim();
          if (!text) return send(res, 400, { error: T("text required") });
          const r = await dumpIntoProject(pid, text, String(b.source || "dumpster").trim());
          return send(res, r.status === "created" ? 201 : 200, r);
        }
        if (sub === "/context/categories" && m === "GET") return send(res, 200, store.projectContextCategories(pid));
        // Lookup by the stable slug (link traversal) — its own path so slugs can never collide with literal routes like
        // /context/dump.
        const cxs = sub.match(/^\/context\/by-slug\/([a-z0-9-]+)$/);
        if (cxs && m === "GET") {
          const it = store.getProjectContext(pid, cxs[1]);
          if (!it) return send(res, 404, { error: T`No entry with slug "${cxs[1]}"` });
          const out = { ...it, origin: "project" };
          try { out.freshness = fs.existsSync(proj.path) ? await staleInfo(proj.path, it, { instance: instanceForProject(pid) }) : null; } catch { out.freshness = null; }
          out.linksResolved = resolveContextLinks(pid, it);
          return send(res, 200, out);
        }
        // Verification: set the anchors to the current repo HEADs. Call ONLY after the content was really checked against
        // the code — the server checks the paths, not the meaning.
        const cxv = sub.match(/^\/context\/(\d+)\/verify$/);
        if (cxv && m === "POST") {
          const it = store.getProjectContext(pid, Number(cxv[1]));
          if (!it) return send(res, 404, { error: "not found" });
          if (!Array.isArray(it.codePaths) || !it.codePaths.length) {
            return send(res, 400, { error: T("Entry has no code_paths — nothing to verify without an anchor. Set code_paths via update first.") });
          }
          if (!fs.existsSync(proj.path)) return send(res, 400, { error: T("Project folder missing") });
          let before = null;
          // The git calls of verification run in the project container (without an instance row null).
          const okfInstance = instanceForProject(pid); // main — `verifyAnchors` writes a commit state into the shared database, and a commit of a copy would never exist there
          try { before = await staleInfo(proj.path, it, { instance: okfInstance }); } catch {}
          const a = await verifyAnchors(proj.path, it.codePaths, { instance: okfInstance });
          // A stopped project container is not "no git repo" — wake it and answer "project is starting" (the same situation
          // as the git view, devtools/code-route.js gitStandsSituation); no anchor from a half state.
          if (a.containerStands) {
            const situation = gitStandsSituation(a.containerStands.projectId, a.containerStands.error);
            return send(res, 409, { error: String(situation.error || situation.notice || ""), ...situation });
          }
          if (!Object.keys(a.commits).length) {
            return send(res, 400, { error: T("None of the code_paths lives in a git repo — verification needs git-anchored paths.") });
          }
          markContextWrite(pid);
          store.updateProjectContext(pid, it.id, { lastVerified: { commits: a.commits, at: a.at } });
          return send(res, 200, {
            verified: true, anchors: a.commits, verifiedAt: a.at,
            clearedCommits: before?.commits?.length || 0,
            ...(a.missing.length ? { missingPaths: a.missing } : {}),
          });
        }
        const cxm = sub.match(/^\/context\/(\d+)$/);
        if (cxm) {
          const cid = Number(cxm[1]);
          if (m === "GET") {
            const it = store.getProjectContext(pid, cid);
            if (!it) return send(res, 404, { error: "not found" });
            const out = { ...it, origin: "project" };
            try { out.freshness = fs.existsSync(proj.path) ? await staleInfo(proj.path, it, { instance: instanceForProject(pid) }) : null; } catch { out.freshness = null; }
            out.linksResolved = resolveContextLinks(pid, it);
            return send(res, 200, out);
          }
          if (m === "PUT") {
            const existing = store.getProjectContext(pid, cid);
            if (!existing) return send(res, 404, { error: "not found" });
            const b = await readBody(req);
            if (b.category != null && !PROJECT_CATEGORY_SLUGS.has(String(b.category))) return send(res, 400, { error: "category must be a known slug" });
            const problems = validateOkf(b, { slugs: store.projectContextSlugs(pid), projPath: fs.existsSync(proj.path) ? proj.path : null, selfSlug: existing.slug });
            if (problems.length) return send(res, 400, { error: T("OKF validation failed — nothing changed."), problems });
            // The FORM (context-form.js): only the fields this call writes, in the effective category; rejected only with
            // the marker `ofAgent` a body above the limit that grows compared to the stored one — an old, long entry stays
            // editable.
            const form = checkContextForm({ title: b.title, summary: b.summary, body: b.body, category: b.category ?? existing.category },
              { previousBodyLength: String(existing.body || "").length, lock: b.ofAgent === true });
            if (form.rejection) return send(res, 400, { error: formRejectionText(form.rejection) });
            // Content or paths touched → the writer has the code in front of them: renew the anchor along with it.
            let lastVerified;
            const effPaths = b.codePaths !== undefined ? b.codePaths : existing.codePaths;
            if ((b.body !== undefined || b.codePaths !== undefined) && Array.isArray(effPaths) && effPaths.length && fs.existsSync(proj.path)) {
              try {
                const a = await verifyAnchors(proj.path, effPaths, { instance: instanceForProject(pid) });
                if (Object.keys(a.commits).length) lastVerified = { commits: a.commits, at: a.at };
              } catch { /* the anchor stays as it was */ }
            }
            markContextWrite(pid);
            return send(res, 200, withFormHints(store.updateProjectContext(pid, cid, {
              category: b.category ?? undefined,
              title: b.title != null ? String(b.title) : undefined,
              body: b.body ?? undefined,
              summary: b.summary != null ? String(b.summary) : undefined,
              tags: b.tags ?? undefined,
              validAsOf: b.validAsOf != null ? String(b.validAsOf) : undefined,
              pinned: b.pinned ?? undefined,
              slug: b.slug ?? undefined,
              status: b.status ?? undefined,
              supersededBy: b.supersededBy != null ? String(b.supersededBy) : undefined,
              owners: b.owners ?? undefined,
              links: b.links,
              codePaths: b.codePaths ?? undefined,
              symbols: b.symbols ?? undefined,
              confidence: b.confidence ?? undefined,
              lastVerified,
            }), form.formHints));
          }
          if (m === "DELETE") { markContextWrite(pid); return send(res, 200, { ok: store.deleteProjectContext(pid, cid) }); }
        }

        // Curator suggestions
        if (sub === "/context-suggestions" && m === "GET") return send(res, 200, store.listSuggestions(pid, "pending"));
        const sgm = sub.match(/^\/context-suggestions\/(\d+)\/(apply|dismiss)$/);
        if (sgm && m === "POST") {
          const sid = Number(sgm[1]); const action = sgm[2];
          const s = store.getSuggestion(pid, sid);
          if (!s) return send(res, 404, { error: "suggestion not found" });
          if (s.status !== "pending") return send(res, 409, { error: T("The suggestion is no longer open") });
          if (action === "dismiss") { store.setSuggestionStatus(pid, sid, "dismissed"); return send(res, 200, { ok: true }); }
          // apply
          try {
            if (s.op === "create") {
              store.createProjectContext(pid, { category: s.category, title: s.title, body: s.body, summary: s.summary, tags: s.tags, validAsOf: s.validAsOf, source: "curator" });
            } else if (s.op === "update") {
              if (!store.getProjectContext(pid, s.targetId)) { store.setSuggestionStatus(pid, sid, "dismissed"); return send(res, 409, { error: T("The target entry no longer exists — suggestion dismissed") }); }
              const fields = {};
              for (const k of ["category", "title", "body", "summary", "validAsOf"]) if (s[k]) fields[k] = s[k];
              if (s.tags) fields.tags = s.tags;
              store.updateProjectContext(pid, s.targetId, fields);
            } else if (s.op === "delete") {
              store.deleteProjectContext(pid, s.targetId);
            }
            store.setSuggestionStatus(pid, sid, "applied");
            return send(res, 200, { ok: true });
          } catch (e) {
            return send(res, 400, { error: String(e.message || e) });
          }
        }
  return NEXT;
}
export async function servicePortRoutes(ctx) {
  const { req, res, url, p, m } = ctx;

      // ── Services & ports (project_services = single source) ──────────────
      // Create a new service on a project (project_services) — for cbase_service_add.
      if (p === "/api/project-services" && m === "POST") {
        const b = await readBody(req);
        const projectId = String(b.projectId || "").trim();
        if (!store.getProject(projectId)) return send(res, 400, { error: "project not found" });
        const name = String(b.name || "").trim();
        if (!name) return send(res, 400, { error: T("name required") });
        let port = null;
        if (b.port !== undefined && b.port !== null && b.port !== "") {
          port = Number(b.port);
          if (!Number.isInteger(port) || port < 1 || port > 65535) return send(res, 400, { error: T`Invalid port: ${b.port}` });
        }
        {
          const synErr = checkCommandSyntax(String(b.startCommand || ""));
          if (synErr) return send(res, 400, { error: T`Start command has a syntax error: ${synErr}` });
        }
        return send(res, 201, store.addProjectService(projectId, {
          name, kind: String(b.kind || "other"), port,
          container: String(b.container || ""), tech: String(b.tech || ""),
          dir: String(b.dir || ""), startCommand: String(b.startCommand || ""), description: String(b.description || ""),
        }));
      }

      // The claims; that of a converted project carries the hint (its port belongs to it, no conflict) — cbase_ports_list
      // passes it on.
      if (p === "/api/ports" && m === "GET") return send(res, 200, portsWithHint(store.listScannedPorts(), convertedProjects()));
      // Port conflicts per project (warning icons on the project cards, Apps page) — a DISPLAY only, in the shape
      // `{ items }` per project. The ONE computation (store.projectPortConflicts): a converted project never appears here.
      if (p === "/api/ports/conflicts" && m === "GET") {
        const raw = store.projectPortConflicts(convertedProjects());
        const map = {};
        for (const [pid, items] of Object.entries(raw)) map[pid] = { items };
        return send(res, 200, map);
      }
  return NEXT;
}

export async function serviceEventRoutes(ctx) {
  const { req, res, url, p, m } = ctx;
      // Service monitor: fetch new status-change events (in-app push + bell poll this).
      if (p === "/api/services/events" && m === "GET") {
        const since = Number(url.searchParams.get("since") || 0) || 0;
        // `seq` is the highest number ever assigned, not that of the returned list: the push bridge recognizes a restart
        // of the sequence by it (seq < its cursor) even when its filter leaves nothing — otherwise it would stay silent
        // forever.
        return send(res, 200, { events: getMonitorEvents(since), seq: currentEventSeq() });
      }
      // Clear the notification history (notification center "Delete all").
      if (p === "/api/services/events" && m === "DELETE") {
        clearMonitorEvents();
        return send(res, 200, { ok: true });
      }
      // Trigger a monitor pass at once (manual "check now").
      if (p === "/api/services/check" && m === "POST") {
        await checkNow();
        return send(res, 200, { ok: true });
      }
  return NEXT;
}

export async function portRoutes(ctx) {
  const { req, res, url, p, m } = ctx;
      if (p === "/api/ports/running" && m === "GET") {
        const registered = store.listScannedPorts();
        const spec = url.searchParams.get("ports");
        let fixed = null;
        if (spec) {
          try { fixed = parsePortsParam(spec); } catch (e) { return send(res, 400, { error: String(e.message || e) }); }
        }
        // The namespaces: B and per converted project its instance. `instance=<identifier>` only that one, `instance=`
        // (empty) only B, without `instance` B and all instances. Without an instance row B is the only space with all claims.
        const spaceChoice = portClean(url.searchParams.get("instance"));
        if (spaceChoice.status) return send(res, spaceChoice.status, { error: spaceChoice.reason });
        const perSpace = claimsPerSpace(registered, spaceChoice.all);
        // The conflicts from the ONE computation (store.portConflicts), without the converted projects — the same set whose
        // claims are in their instances. They belong to space B; an instance has none.
        const conflictsB = store.portConflicts(new Set(spaceChoice.all.map((z) => z.projectId)), registered);
        // Light mode for polling (?registered): only open/closed, without process resolution.
        const light = Boolean(url.searchParams.get("registered"));
        // The projects of a space for "unregistered": B has all without an instance, an instance only its project.
        const allProjects = light ? [] : store.listAllProjects();
        const converted = new Set(spaceChoice.all.map((z) => z.projectId));
        const projectsInSpace = (target) => (target ? allProjects.filter((pr) => pr.id === target.projectId) : allProjects.filter((pr) => !converted.has(pr.id)));
        // One computation per space, the spaces in PARALLEL, and an instance is only probed if it is ALIVE: an address
        // without a running container (being created, server end until restart grace, removed) does not answer, and every
        // batch of ports would run into its deadline there — a full scan took tens of seconds per instance, and callers
        // then held every port for "not there", including one of B. Whether it is alive is told by the instance's port
        // state (ports.js portsInInstance: ONE `docker exec`) — also in light mode. Not reachable means: not probed,
        // `unreachable` names it (an unchecked space is not an empty one), and the findings are incomplete. The order of
        // the response stays that of the spaces (B first).
        // Light mode asks ONLY that in an instance — no process resolution (lsof, two more execs per instance). Open/closed
        // is still measured by the TCP probe on the instance's IP — the same path as the tunnel (tunnel.js): a listener
        // only on [::1] is in /proc/net/tcp6 but not reachable through the DNAT of the instance IP.
        const spaceResults = await Promise.all(spaceChoice.clean.map(async (target) => {
          const identifier = target ? target.identifier : null;
          const claims = perSpace.get(identifier) || [];
          let toScan;
          if (fixed) toScan = fixed;
          else if (light) {
            // Check only registered ports — those of THIS space.
            toScan = [...new Set(claims.map((r) => r.port))].sort((a, b) => a - b);
          } else {
            const set = new Set(claims.map((r) => r.port));
            for (let prt = DEFAULT_RANGE.from; prt <= DEFAULT_RANGE.to; prt++) set.add(prt);
            toScan = [...set].sort((a, b) => a - b);
          }
          // An instance without an address is known but not reachable: nothing probed, and the findings are incomplete.
          if (target && !target.ip) return { unreachable: { instance: identifier, reason: T("no address") } };
          // Unreadable is not "no process" and not "nothing listens": the container is not running (or missing). Light only
          // the ports (ONE exec), full including processes.
          const listener = target ? await (light ? portsInInstance(target) : listenersInInstance(target)) : null;
          if (target && listener === null) return { unreachable: { instance: identifier, reason: T("container not readable (not running or missing)") } };
          const open = await scanPorts(toScan, target ? { host: target.ip } : {});
          let procs = {};
          if (!light && target) for (const prt of open) procs[prt] = listener[prt] ?? null;
          else if (!light) procs = await resolveListeners(open);
          const byPort = new Map(claims.map((r) => [r.port, r]));
          const openInSpace = open.map((prt) => {
            const reg = byPort.get(prt) ?? null;
            const proc = procs[prt] ?? null;
            const entry = { port: prt, instance: identifier, registered: reg };
            if (!light) entry.process = proc;
            // Foreign occupation: a process listens whose cwd is NOT in the project of the registered service — the
            // registration then says nothing about the actual provider (make port squatting visible).
            if (reg && proc?.cwd) {
              const projPath = store.getProject(reg.projectId)?.path || "";
              if (projPath) entry.mismatch = !cwdInside(proc.cwd, projPath);
            }
            return entry;
          });
          // Reserved but closed: registered ports in the scan range nothing listens on — so that an allocation is visible
          // even without a running process.
          const openSet = new Set(open);
          const scanSet = new Set(toScan);
          const reserved = claims.filter((r) => scanSet.has(r.port) && !openSet.has(r.port)).map((r) => ({ ...r, instance: identifier }));
          // FINDINGS: the same scan, but as a named statement instead of a field one first has to evaluate — otherwise a
          // frontend can run for days on an unregistered port next to its own registration without anyone noticing. Per
          // namespace (ports.js findingsInSpace).
          return {
            scanned: toScan.length, open: openInSpace, reserved,
            findings: findingsInSpace({ identifier, conflicts: target ? [] : conflictsB, open: openInSpace, projects: projectsInSpace(target), light }),
          };
        }));
        const unreachable = spaceResults.filter((r) => r.unreachable).map((r) => r.unreachable);
        const probed = spaceResults.filter((r) => !r.unreachable);
        return send(res, 200, {
          scanned: probed.reduce((n, r) => n + r.scanned, 0),
          open: probed.flatMap((r) => r.open),
          reserved: probed.flatMap((r) => r.reserved),
          findings: probed.flatMap((r) => r.findings),
          // Without process resolution "foreign-occupied" and "unregistered" cannot be decided. That must be stated,
          // otherwise a caller reads the empty list as a clean bill.
          findingsComplete: !light && !unreachable.length,
          // Only with an unprobed instance (without an instance the field is absent).
          ...(unreachable.length ? { unreachable } : {}),
        });
      }
      if (p === "/api/ports/free" && m === "GET") {
        const start = Number(url.searchParams.get("start") || 3000);
        const end = Number(url.searchParams.get("end") || 9999);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) return send(res, 400, { error: T("Invalid range") });
        // Per instance: `instance=<identifier>` searches in the namespace of the project container — only the claims of ITS
        // project apply, probing happens on its IP. Without (or empty) in B.
        const identifier = url.searchParams.get("instance");
        if (!identifier) {
          // In B the ports of converted projects do not count as taken: they listen in their own namespace.
          let converted;
          try { converted = convertedProjects(); } catch (e) { return send(res, 500, { error: String(e?.message || e) }); }
          const r = await freePort({ start, end, claims: store.listScannedPorts().filter((a) => !converted.has(String(a.projectId))) });
          return send(res, r.status, r.body);
        }
        const choice = portClean(identifier);
        if (choice.status) return send(res, choice.status, { error: choice.reason });
        const [target] = choice.clean;
        if (!target.ip) return send(res, 409, { error: T`Instance ${target.identifier} has no address` });
        // An instance whose container is not running is not probed — nobody answers at its address, every port would be
        // "free". Same wording as `unreachable` in /api/ports/running.
        if (!(await instanceAlive(target))) {
          return send(res, 409, { error: T`Instance ${target.identifier} is not reachable (container not running or missing)`, instance: target.identifier });
        }
        const r = await freePort({ start, end, claims: store.listScannedPorts().filter((a) => a.projectId === target.projectId), host: target.ip });
        return send(res, r.status, r.status === 200 ? { ...r.body, instance: target.identifier } : r.body);
      }
  return NEXT;
}

// The namespaces of a port query from the parameter `instance` — three-valued, a missing field is no statement:
//   null (not given)          B and every instance      → { clean: [null, …targets], all }
//   "" (empty)                explicitly only B         → { clean: [null], all }
//   "<projectId>/<instance>"  only this instance        → { clean: [target], all } — unknown 404 (without server operation
//                                                          with the wording ONLY_IN_OPS), unreadable 500
// `all` are the targets of ALL converted projects — their claims never belong to B, even if B alone is asked.
function portClean(raw) {
  let all;
  let target = null;
  try {
    all = instanceTargets();
    if (raw) target = instanceTarget(raw);
  } catch (e) {
    return { status: 500, reason: String(e?.message || e) };
  }
  if (raw === null) return { clean: [null, ...all], all };
  if (raw === "") return { clean: [null], all };
  if (!target) return { status: 404, reason: projectboxOps() ? `unknown instance: ${raw}` : ONLY_IN_OPS };
  return { clean: [target], all };
}

// The tool list of a definition from the body: read and checked against the registered tools — an unknown name is an error
// naming it instead of silently vanishing. `value` undefined = not sent.
function agentTools(raw, workspaceId) {
  let value;
  try { value = toolListFromBody(raw); } catch (e) { return { error: e.message }; }
  const unknown = unknownInWorkspace(value);
  if (unknown) return { error: unknownText(unknown, workspaceId) };
  return { value };
}
