// Routes: toolchain. Every function takes ctx = { req, res, url, p, m } (sub-slices of a family also id/sub/chat, wid/sub/ws
// or pid/sub/proj) and returns NEXT if it is not responsible; any other return means "answered". Call order: ROUTES in server.js.
// Functions: toolchainWorkspaceRoutes (mcp-servers, vars, skills, effective-skills, skill-catalog, approval-marks)
// · mcpCatalogRoutes.

import crypto from "node:crypto";
import * as skillsLib from "../skills.js";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { MCP_CATALOG, AIRLOCK_FIELDS, headersChange, normalizeMcpBody, airlockFields, varsBody, varsMcpRow } from "./mcp-config.js";
import { loadMcpTools } from "./mcp-load.js";
import { withoutNew } from "./mcp-tools.js";
import { NEXT, readBody, send } from "../runtime/http.js";
import { areaFromQuery, areaContradicts, areaToCreate, catalogCost, skillFields, skillMeta } from "./skill-catalog.js";
import { SkillError, withChanges, changeSkill, skillCreate, skillDelete } from "./skill-change.js";
import { MARKABLE, approvalMarks, setApprovalMarks } from "./approval-marks.js";
import { managerLock } from "../runs/manager-lock.js";

// Create, change and delete from the UI go through the ONE mutation path (skill-change.js, `who: human`) — with history,
// trash and the reference check. DELETE can additionally answer 409 `{ error, references }` (an agent definition names the skill).


export async function toolchainWorkspaceRoutes(ctx) {
  const { req, res, url, p, m, wid, sub, ws } = ctx;

        // Approval marks of the built-in tools (./approval-marks.js): marked ⇒ a run that chose the tool needs the human's
        // approval (the outer loop omits it). GET returns the marks of the coding section and the markable tools; PUT
        // `{ tools }` replaces the marks of that section — a missing `tools` is a 400, not "no mark".
        if (sub === "/approval-marks" && m === "GET") return send(res, 200, { tools: approvalMarks(wid), markable: MARKABLE });
        if (sub === "/approval-marks" && m === "PUT") {
          const b = await readBody(req);
          try { return send(res, 200, { tools: setApprovalMarks(wid, b.tools), markable: MARKABLE }); }
          catch (e) { return send(res, e.status || 500, { error: e.message }); }
        }


        // MCP servers of this workspace: list & create.
        if (sub === "/mcp-servers" && m === "GET") return send(res, 200, store.listMcpServers(wid));
        if (sub === "/mcp-servers" && m === "POST") {
          const b = await readBody(req);
          const norm = normalizeMcpBody(b);
          if (norm.error) return send(res, 400, { error: norm.error });
          // Creating takes headers along; everything else of the airlock starts at its factory default.
          const header = headersChange(b.headers, norm.transport);
          if (header.error) return send(res, 400, { error: header.error });
          if (store.listMcpServers(wid).some((s) => s.name === norm.name)) {
            return send(res, 409, { error: T`A server "${norm.name}" already exists in this workspace.` });
          }
          const now = Date.now();
          return send(res, 201, store.createMcpServer({ id: crypto.randomUUID(), workspaceId: wid, ...norm, headers: header.headers, createdAt: now, updatedAt: now }));
        }

        // Credentials/variables/links of the workspace.
        // ?mcp=1 = view for the MCP server: EFFECTIVE set (workspace vars + vars of ALL projects — a workspace chat may
        // access everything), list WITHOUT values (discovery), value retrieval only for entries with mcp_access.
        // Without mcp=1 = only workspace vars (UI CRUD).
        if (sub === "/vars" && m === "GET") {
          if (url.searchParams.get("mcp") === "1") {
            return send(res, 200, store.effectiveWorkspaceVars(wid).map(varsMcpRow));
          }
          return send(res, 200, store.listVars(wid));
        }
        if (sub === "/vars" && m === "POST") {
          const b = await readBody(req);
          const key = String(b.key || "").trim();
          if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) return send(res, 400, { error: T("key: letter first, then letters/digits/_ . - (max. 64)") });
          const patch = varsBody(b, { fresh: true });
          if (patch.error) return send(res, 400, { error: patch.error });
          if (store.getVarByKey(wid, key)) return send(res, 409, { error: T`key "${key}" already exists` });
          return send(res, 201, store.createVar(wid, { key, ...patch }));
        }
        const vkm = sub.match(/^\/vars\/by-key\/([^/]+)$/);
        if (vkm && m === "GET") {
          // Resolve from the workspace's view: workspace var first, otherwise project vars (all projects).
          const v = store.resolveWorkspaceVar(wid, decodeURIComponent(vkm[1]));
          if (!v) return send(res, 404, { error: "Entry not found — cbase_vars_list shows the existing keys." });
          if (url.searchParams.get("mcp") === "1" && !v.mcpAccess) {
            return send(res, 403, { error: `"${v.key}" is locked for Claude — please ask the user for the value directly or ask for it to be released.` });
          }
          return send(res, 200, v);
        }
        const vim = sub.match(/^\/vars\/(\d+)$/);
        if (vim && m === "PUT") {
          const b = await readBody(req);
          const old = store.listVars(wid).find((x) => x.id === Number(vim[1]));
          if (!old) return send(res, 404, { error: T("Entry not found") });
          const patch = varsBody(b, { fresh: false, kindOld: old.kind });
          if (patch.error) return send(res, 400, { error: patch.error });
          if (b.key !== undefined) {
            const key = String(b.key).trim();
            if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) return send(res, 400, { error: T("Invalid key") });
            const other = store.getVarByKey(wid, key);
            if (other && other.id !== Number(vim[1])) return send(res, 409, { error: T`key "${key}" already exists` });
            patch.key = key;
          }
          const v = store.updateVar(Number(vim[1]), patch);
          return v ? send(res, 200, v) : send(res, 404, { error: T("Entry not found") });
        }
        if (vim && m === "DELETE") return send(res, 200, { ok: store.deleteVar(Number(vim[1])) });

        // Skills CRUD (provider-agnostic, DB) — workspace level (project_id NULL). At runtime the catalog is in the system
        // prompt and the guide comes via `cbase_skill` — the same path for every provider. Addressed by id.
        // Only the department Coding exists: `?area=` may be missing (means Coding) or be `coding`; any other value — also
        // `managing` — is a 400. Managing skills of an old store remain in the data and appear in no list.
        // A coding skill carries `hiddenIn` (the projects hiding it, by name).
        if (sub === "/skills" && m === "GET") {
          const area = areaFromQuery(url);
          if (!area) return send(res, 400, { error: T("area is unknown — only coding remains (or omit the parameter)") });
          const list = store.listWorkspaceSkills(wid).filter((sk) => sk.area === area);
          const out = store.skillHides(wid);
          return send(res, 200, withChanges(wid, list.map((sk) => ({ ...skillMeta(sk), hiddenIn: out.get(sk.id) || [] }))));
        }
        if (sub === "/skills" && m === "POST") {
          const b = await readBody(req);
          const newArea = areaToCreate(b);
          if (newArea.error) return send(res, 400, { error: newArea.error });
          const name = String(b.name || "").trim();
          if (!skillsLib.validName(name)) return send(res, 400, { error: T("Skill name must be lower-kebab-case (a-z, 0-9, -)") });
          // The name is unique per workspace level across BOTH departments — getSkillByName asks without department, so a
          // managing skill still in the data keeps occupying its name until phase 2.
          if (store.getSkillByName(wid, null, name)) return send(res, 409, { error: T`A skill "${name}" already exists in this workspace.` });
          try {
            const { skill } = skillCreate({ workspaceId: wid, projectId: null, name, description: b.description || "", body: b.body || "", allowedTools: b.allowedTools || "", model: b.model || "", area: newArea.area }, { who: "human" });
            return send(res, 201, skill);
          } catch (e) { if (e instanceof SkillError) return send(res, e.status, e.body); throw e; }
        }
        const sm = sub.match(/^\/skills\/([0-9a-f-]+)$/);
        if (sm) {
          const sk = store.getSkill(sm[1]);
          if (!sk || sk.workspaceId !== wid || sk.projectId) return send(res, 404, { error: "skill not found" });
          if (m === "GET") return send(res, 200, sk);
          // Managing is removed (runs/manager-lock.js): a managing skill of an old store is no longer changed or deleted.
          if (sk.area === "managing" && (m === "PUT" || m === "DELETE")) return send(res, 409, managerLock());
          if (m === "PUT") {
            const b = await readBody(req);
            const contradiction = areaContradicts(b, sk.area);
            if (contradiction) return send(res, 400, { error: contradiction });
            try {
              const { updatedAt: _u, ...fields } = skillFields(b);
              return send(res, 200, changeSkill(sm[1], fields, { who: "human" }).skill);
            } catch (e) { if (e instanceof SkillError) return send(res, e.status, e.body); throw e; }
          }
          if (m === "DELETE") {
            try { skillDelete(sm[1], { who: "human" }); return send(res, 200, { ok: true }); }
            catch (e) { if (e instanceof SkillError) return send(res, e.status, e.body); throw e; }
          }
        }

        // Effective skills for a chat that does not exist yet: the slash picker is already available in the EMPTY chat, the
        // chat is only created on send — the same gap `effective-workflows` closes for the workflow choice.
        if (sub === "/effective-skills" && m === "GET") {
          const pid = url.searchParams.get("projectId") || null;
          // Always the coding skills (a parameter `area=managing` is ignored).
          return send(res, 200, withChanges(wid, store.effectiveSkills(wid, pid).map((s) => ({ ...skillMeta(s), originProject: s.originProject || "" }))));
        }
        // Count and cost of the catalog of ONE level — at the top of every skills view: `effectiveSkills` (Coding without a
        // project = what a workspace chat gets, i.e. workspace + all projects; with a project = own + not hidden) and the same
        // computation as the catalog in the system prompt (`catalogCost` → `skillCatalog`). No estimating in the client. A
        // project of ANOTHER workspace is 404 — otherwise the response would mix foreign skills and foreign hides into this
        // number. `?area=` as on the list: missing or `coding`, otherwise 400.
        if (sub === "/skill-catalog" && m === "GET") {
          if (!areaFromQuery(url)) return send(res, 400, { error: T("area is unknown — only coding remains (or omit the parameter)") });
          const pid = url.searchParams.get("projectId") || null;
          if (pid && store.getProject(pid)?.workspaceId !== wid) return send(res, 404, { error: "project not found" });
          return send(res, 200, catalogCost(store.effectiveSkills(wid, pid)));
        }
  return NEXT;
}
export async function mcpCatalogRoutes(ctx) {
  const { req, res, url, p, m } = ctx;

      // ── MCP servers (global: catalog + edit/delete a single server) ──
      if (p === "/api/mcp-catalog" && m === "GET") return send(res, 200, MCP_CATALOG);
      {
        // Load the tools of a coding server: initialize + tools/list, deadline 30 s — http with the headers (for a project
        // server from the namespace of its main instance), stdio where the server runs. An error goes to `toolsError` and
        // does NOT replace the cache; the response is the server as with GET.
        const wm = p.match(/^\/api\/mcp-servers\/([0-9a-f-]+)\/tools$/);
        if (wm && m === "POST") {
          const loaded = await loadMcpTools(wm[1]);
          return loaded ? send(res, 200, loaded) : send(res, 404, { error: T("MCP server not found") });
        }
        const mm = p.match(/^\/api\/mcp-servers\/([0-9a-f-]+)$/);
        if (mm) {
          const sid = mm[1];
          const server = store.getMcpServerInternal(sid);
          if (!server) return send(res, 404, { error: T("MCP server not found") });
          if (m === "PATCH") {
            const b = await readBody(req);
            // Allow plain enabling/disabling without full validation.
            if (Object.keys(b).length === 1 && typeof b.enabled === "boolean") {
              return send(res, 200, store.updateMcpServer(sid, { enabled: b.enabled }));
            }
            // The airlock fields ONLY from the body, BEFORE merging with the server: otherwise every field would be in every
            // PATCH, and a rename would reset the choice. A missing field means unchanged.
            const rest = Object.fromEntries(Object.entries(b).filter(([k]) => !AIRLOCK_FIELDS.includes(k)));
            const airlock = airlockFields(server, b);
            if (airlock.error) return send(res, 400, { error: airlock.error, ...(airlock.unknown ? { unknown: airlock.unknown } : {}) });
            const onlyAirlock = !Object.keys(rest).length;
            const { headers: _k, tools: _w, toolsAt: _a, toolsError: _f, choice: _wa, markers: _m, subagentsInherit: _s, autoMarkerFirst: _e, ...base } = server;
            const norm = onlyAirlock ? {} : normalizeMcpBody({ ...base, ...rest });
            if (norm.error) return send(res, 400, { error: norm.error });
            if (!onlyAirlock) {
              const siblings = server.projectId ? store.listProjectMcpServers(server.projectId) : store.listMcpServers(server.workspaceId);
              if (norm.name !== server.name && siblings.some((s) => s.name === norm.name)) {
                return send(res, 409, { error: T`A server "${norm.name}" already exists.` });
              }
              if (typeof b.enabled === "boolean") norm.enabled = b.enabled;
            }
            const transport = norm.transport || server.transport;
            // A switch to stdio drops the headers (they would apply nowhere: http/sse only).
            const oldHeader = transport === "stdio" && b.headers === undefined ? {} : store.mcpHeadersValues(sid);
            const header = headersChange(b.headers, transport, oldHeader);
            if (header.error) return send(res, 400, { error: header.error });
            const fields = { ...norm, ...airlock, headers: header.headers };
            // "fresh" drops as soon as a tool is checked — `choice: null` checks all.
            if ("choice" in airlock) fields.tools = withoutNew(server.tools, airlock.choice);
            return send(res, 200, store.updateMcpServer(sid, fields));
          }
          if (m === "DELETE") {
            store.deleteMcpServer(sid);
            return send(res, 200, { ok: true });
          }
        }
      }
  return NEXT;
}
