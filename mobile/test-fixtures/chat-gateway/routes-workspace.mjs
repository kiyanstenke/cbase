// Workspace routes of the fixture gateway: overview, workflows, vars, MCP, skills (contract §2.4), workflows per project, chat workflows/skills.
import { S, workspaceId, json, dynShort, workspace, defaultWorkflows, body, workflowMeta, defaultPagesSkills, longSkillBody, defaultSkills, workflowFull, projectId, runOf, lockOf, LOCK_SCOPES_FIXTURE, NEXT } from "./state.mjs";
// The two picker lists carry a `shortName` per entry — computed with THE SAME leaf as the server (`workflows/shortName.js`,
// no imports), not with a copy: a fixture that rebuilds the contract would test its own invention.
import { withShortNames } from "../../../server/backend/electron/server/workflows/shortName.js";

// Coding → MCP with the airlock: ONE http server with a set header (only the name — no value is stored anywhere, not even
// here), three tools (reads · writes · unclear), `choice: null` (all), one marker and "subagents inherit" off. Shape as `mapMcp` of
// the server (store/toolchain.js; the fields are held by web/test/mcp-tools-binding.test.mjs). The state lives HERE and not in
// `state.mjs` (2,000-line guard); `/fixture/reset-run` resets it via `resetMcpAirlock`. PATCH takes only the fields of the body
// (a missing field means unchanged).
const MCP_ID = "6d1f0c3a-0000-4000-8000-00000000a11e";
const mcpSeed = () => ({
  id: MCP_ID, workspaceId, projectId: null, name: "teams", transport: "http", command: "", args: [], env: {},
  url: "https://extractors.example/api/mcp", enabled: true, createdAt: 1792400000000, updatedAt: 1792400000000,
  headers: [{ name: "Authorization", set: true }],
  tools: [
    { name: "teams_read", description: "Reads a channel.", writing: false, fresh: false },
    { name: "teams_send", description: "Sends a message.", writing: true, fresh: false },
    { name: "archive_read", description: "Reads the archive.", writing: null, fresh: false },
  ],
  toolsAt: Date.now() - 5 * 60_000, toolsError: "", choice: null, markers: ["teams_send"], subagentsInherit: false,
});
let mcpServer = mcpSeed();
export function resetMcpAirlock() {
  mcpServer = mcpSeed();
}

export async function routesWorkspace(ctx) {
  const { req, res, url, path, method } = ctx;
    // Overview + status endpoints of the mobile shell (counters, pills, notifications).
    if (path === `/api/workspaces/${workspaceId}/overview` && method === "GET") {
      return json(res, 200, {
        id: workspaceId,
        name: workspace.name,
        path: workspace.path,
        exists: true,
        hasClaudeMd: false,
        agents: [],
        projects: workspace.projects,
        categories: [],
        contextCount: 0,
        varsCount: 0,
        mcpCount: 0,
        workflowCount: S.workflows.length,
      });
    }

    // ── Workflows ──
    if (path === "/fixture/workflows" && method === "GET") {
      return json(res, 200, { workflows: S.workflows, projectWorkflows: S.projectWorkflows, adopted: [...S.adoptedWorkflows], run: S.workflowRun, lastStart: S.lastWorkflowStart, lastPut: S.lastWorkflowPut });
    }
    if (path === "/fixture/workflows" && method === "POST") {
      // Optional `{ runs: { "<id>": { …run settings } } }`: laid over the seed after the reset — so a test gets a workflow
      // with its own compaction without saving through the UI (hint line in the auto menu of the chat).
      const request = (await body(req)) || {};
      S.workflows = defaultWorkflows();
      for (const [id, run] of Object.entries(request.runs || {})) {
        const w = S.workflows.find((x) => x.id === id);
        if (w) w.run = runOf({ ...runOf(w.run), ...run });
      }
      S.lastWorkflowPut = null;
      S.projectWorkflows = [];
      S.adoptedWorkflows = new Set();
      S.workflowRun = null;
      S.limitWait = null;
      S.notices = [];
      S.lastWorkflowStart = null;
      return json(res, 200, { reset: true });
    }
    if (path === `/api/workspaces/${workspaceId}/mcp-servers` && method === "GET") return json(res, 200, [mcpServer]);
    if (path === "/api/mcp-catalog" && method === "GET") return json(res, 200, []);
    if (path === `/api/mcp-servers/${MCP_ID}/tools` && method === "POST") {
      mcpServer = { ...mcpServer, toolsAt: Date.now(), toolsError: "" };
      return json(res, 200, mcpServer);
    }
    if (path === `/api/mcp-servers/${MCP_ID}` && method === "PATCH") {
      const b = await body(req);
      const fresh = { ...mcpServer };
      if ("choice" in b) {
        fresh.choice = b.choice === null ? null : b.choice;
        fresh.tools = fresh.tools.map((w) => ({ ...w, fresh: w.fresh && fresh.choice !== null && !fresh.choice.includes(w.name) }));
      }
      if ("markers" in b) fresh.markers = b.markers;
      if (typeof b.subagentsInherit === "boolean") fresh.subagentsInherit = b.subagentsInherit;
      if (typeof b.enabled === "boolean") fresh.enabled = b.enabled;
      mcpServer = fresh;
      return json(res, 200, mcpServer);
    }
    if (path === `/api/workspaces/${workspaceId}/vars` && method === "GET") {
      return json(res, 200, S.vars);
    }
    if (path === `/api/workspaces/${workspaceId}/vars` && method === "POST") {
      const request = await body(req);
      const fresh = {
        id: 900 + S.vars.length + 1,
        key: String(request.key || ""),
        kind: String(request.kind || "variable"),
        value: String(request.value || ""),
        description: String(request.description || ""),
        mcpAccess: request.mcpAccess !== false,
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      S.vars.push(fresh);
      return json(res, 201, fresh);
    }
    const varPut = path.match(new RegExp(`^/api/workspaces/${workspaceId}/vars/(\\d+)$`));
    if (varPut && method === "PUT") {
      const request = await body(req);
      const entry = S.vars.find((v) => v.id === Number(varPut[1]));
      if (!entry) return json(res, 404, { error: "not found" });
      if (request.key !== undefined) entry.key = String(request.key);
      if (request.kind !== undefined) entry.kind = String(request.kind);
      if (request.value !== undefined) entry.value = String(request.value);
      if (request.description !== undefined) entry.description = String(request.description);
      if (request.mcpAccess !== undefined) entry.mcpAccess = request.mcpAccess !== false;
      return json(res, 200, entry);
    }
    if (varPut && method === "DELETE") {
      S.vars = S.vars.filter((v) => v.id !== Number(varPut[1]));
      return json(res, 200, { ok: true });
    }
    if (path === `/api/workspaces/${workspaceId}/workflows` && method === "GET") {
      return json(res, 200, S.workflows.map(workflowMeta));
    }
    if (path === `/api/workspaces/${workspaceId}/effective-workflows` && method === "GET") {
      return json(res, 200, withShortNames([...S.workflows, ...S.projectWorkflows]).map((w) => ({ ...workflowMeta(w), shortName: w.shortName })));
    }
    // ── Skills in Coding ──
    // Every skill belongs to ONE area; the workspace list, the catalog and creation require `area` (unknown ⇒ 400, and
    // `managing` ⇒ 400 as on the server — the Managing skill of the seed is a leftover that appears in no list). If `area` is
    // MISSING, the fixture keeps answering 400, unlike the server (where it means Coding): the counter-check of
    // CodingUITests/testSkillsInCodingShowsOnlyWorkspaceSkillsAndCreatesOne hangs on it.
    // Coding skills of the workspace carry `hiddenIn`, the project view `enabled`; hiding goes by skill id (the old name-based
    // form is gone ⇒ 404); `/api/skills` no longer exists (falls into the 404 of the entry). Every request is in
    // `S.skillsCalls` — the tests read there what arrived.
    {
      const wsSkills = path.match(/^\/api\/workspaces\/([^/]+)\/skills(?:\/([^/]+))?$/);
      const projSkills = path.match(/^\/api\/projects\/([^/]+)\/skills(?:\/([^/]+))?$/);
      const inProject = path.match(/^\/api\/projects\/([^/]+)\/workspace-skills(?:\/([^/]+)\/enabled)?$/);
      const catalog = path.match(/^\/api\/workspaces\/([^/]+)\/skill-catalog$/);
      if (wsSkills || projSkills || inProject || catalog) {
        const bodyText = ["POST", "PUT", "PATCH"].includes(method) ? ((await body(req)) || {}) : null;
        S.skillsCalls.push({ method, path, query: Object.fromEntries(url.searchParams), ...(bodyText ? { body: bodyText } : {}) });
        const AREAS = ["coding"];
        // Only the fixture workspace has skills and projects; every other one (the second) is empty.
        const ofTheWorkspace = (wid) => (wid === workspaceId ? S.pagesSkills : []);
        const project = (pid) => workspace.projects.find((p) => p.id === pid) || null;
        const meta = (s) => ({ id: s.id, name: s.name, description: s.description, hasResources: !!s.hasResources, area: s.area, forCoding: s.area === "coding", forManaging: s.area === "managing" });
        const full = (s) => ({ ...meta(s), body: s.body || "" });
        const out = (pid, sid) => S.skillsHidden.has(`${pid}:${sid}`);
        const hiddenIn = (s) => workspace.projects.filter((p) => out(p.id, s.id)).map((p) => ({ id: p.id, name: p.name }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const wsCoding = (wid) => ofTheWorkspace(wid).filter((s) => !s.projectId && s.area === "coding");
        // PUT never changes the area: `area` or a marker that contradicts it ⇒ 400; matching or missing is fine.
        const contradicts = (s, r) => (r.area !== undefined && r.area !== s.area)
          || (typeof r.forCoding === "boolean" && r.forCoding !== (s.area === "coding"))
          || (typeof r.forManaging === "boolean" && r.forManaging !== (s.area === "managing"));
        const create = (fields) => {
          S.skillCounter += 1;
          const s = { id: `60000000-0000-4000-8000-000000000${S.skillCounter}`, hasResources: false, ...fields };
          S.pagesSkills.push(s);
          return s;
        };
        const change = (s, r) => {
          if (contradicts(s, r)) return json(res, 400, { error: "The area of a skill does not change — delete it and create it anew." });
          if (typeof r.description === "string") s.description = r.description;
          if (typeof r.body === "string") s.body = r.body;
          return json(res, 200, full(s));
        };
        const erase = (s) => {
          S.pagesSkills = S.pagesSkills.filter((x) => x.id !== s.id);
          for (const k of [...S.skillsHidden]) if (k.endsWith(`:${s.id}`)) S.skillsHidden.delete(k);
          return json(res, 200, { ok: true });
        };

        if (catalog && method === "GET") {
          const area = url.searchParams.get("area");
          if (!AREAS.includes(area)) return json(res, 400, { error: "Field “area” is missing or unknown." });
          const wid = catalog[1];
          const pid = url.searchParams.get("projectId") || null;
          let effective;
          if (!pid) effective = ofTheWorkspace(wid).filter((s) => s.area === "coding"); // workspace + all projects
          else {
            const own = ofTheWorkspace(wid).filter((s) => s.projectId === pid);
            const names = new Set(own.map((s) => s.name)); // the project wins on the same name
            effective = [...own, ...wsCoding(wid).filter((s) => !out(pid, s.id) && !names.has(s.name))];
          }
          // About 85 tokens per catalog row — the same order of magnitude the real server computes.
          return json(res, 200, { count: effective.length, token: effective.length * 85 });
        }

        if (wsSkills) {
          const [, wid, sid] = wsSkills;
          if (!sid && method === "GET") {
            const area = url.searchParams.get("area");
            if (!AREAS.includes(area)) return json(res, 400, { error: "Field “area” is missing or unknown." });
            return json(res, 200, ofTheWorkspace(wid).filter((s) => !s.projectId && s.area === area)
              .map((s) => ({ ...meta(s), hiddenIn: hiddenIn(s) })));
          }
          if (!sid && method === "POST") {
            if (!AREAS.includes(bodyText.area)) return json(res, 400, { error: "Field “area” is missing or unknown." });
            const name = String(bodyText.name || "").trim();
            if (!name) return json(res, 400, { error: "Name is missing." });
            if (wid !== workspaceId) return json(res, 404, { error: "workspace not found" });
            // Unique across BOTH areas of the workspace level.
            if (S.pagesSkills.some((s) => !s.projectId && s.name === name)) return json(res, 409, { error: `A skill "${name}" already exists.` });
            return json(res, 200, full(create({ name, description: String(bodyText.description || ""), body: String(bodyText.body || ""), area: bodyText.area, projectId: null })));
          }
          if (sid) {
            const s = ofTheWorkspace(wid).find((x) => x.id === sid && !x.projectId);
            if (!s) return json(res, 404, { error: "skill not found" });
            if (method === "GET") return json(res, 200, full(s));
            if (method === "PUT") return change(s, bodyText);
            if (method === "DELETE") return erase(s);
          }
        }

        if (projSkills) {
          const [, pid, sid] = projSkills;
          if (!project(pid)) return json(res, 404, { error: "project not found" });
          if (!sid && method === "GET") return json(res, 200, S.pagesSkills.filter((s) => s.projectId === pid).map(meta));
          if (!sid && method === "POST") {
            // Managing knows no project level; missing or coding is fine.
            if (bodyText.area !== undefined && bodyText.area !== "coding") return json(res, 400, { error: "Managing skills exist only per workspace." });
            const name = String(bodyText.name || "").trim();
            if (!name) return json(res, 400, { error: "Name is missing." });
            if (S.pagesSkills.some((s) => s.projectId === pid && s.name === name)) return json(res, 409, { error: `A skill "${name}" already exists.` });
            return json(res, 200, full(create({ name, description: String(bodyText.description || ""), body: String(bodyText.body || ""), area: "coding", projectId: pid })));
          }
          if (sid) {
            const s = S.pagesSkills.find((x) => x.id === sid && x.projectId === pid);
            if (!s) return json(res, 404, { error: "skill not found" });
            if (method === "GET") return json(res, 200, full(s));
            if (method === "PUT") return change(s, bodyText);
            if (method === "DELETE") return erase(s);
          }
        }

        if (inProject) {
          const [, pid, sid] = inProject;
          if (!project(pid)) return json(res, 404, { error: "project not found" });
          if (!sid && method === "GET") return json(res, 200, wsCoding(workspaceId).map((s) => ({ ...meta(s), enabled: !out(pid, s.id) })));
          if (sid && method === "PATCH") {
            // On request the switch fails (`patchError`): the guard that the app shows the message across the reload and
            // the switch stays at the state of the server.
            // The message stays German: CodingUITests matches it in the label.
            if (S.skillsPatchError) return json(res, S.skillsPatchError, { error: "Fixture: Ausblenden abgelehnt" });
            if (typeof bodyText.enabled !== "boolean") return json(res, 400, { error: "Field \"enabled\" is missing or not a boolean." });
            const s = wsCoding(workspaceId).find((x) => x.id === sid);
            if (!s) return json(res, 404, { error: "skill not found" });
            if (bodyText.enabled) S.skillsHidden.delete(`${pid}:${s.id}`);
            else S.skillsHidden.add(`${pid}:${s.id}`);
            return json(res, 200, { ok: true, enabled: bodyText.enabled });
          }
        }
        return json(res, 405, { error: `fixture: ${method} ${path} not provided` });
      }
    }
    // Reset the seed — and vary it on request: `lang` gives the first skill the long body, `hidden` hides the workspace skill
    // "release-notes" in the fixture project (the workspace level then shows "Hidden in: …"), `patchError` (status code) makes
    // every switch PATCH fail. Without a value everything falls back, so does the record — an aborted neighbor leaves nothing
    // behind (`reset-run` clears the same).
    if (path === "/fixture/pages-skills" && method === "POST") {
      const request = (await body(req)) || {};
      S.pagesSkills = defaultPagesSkills();
      S.skillsHidden = new Set();
      S.skillsCalls = [];
      S.skillsPatchError = Number(request.patchError) || 0;
      if (request.lang === true) S.pagesSkills[0].body = longSkillBody();
      if (request.hidden === true) S.skillsHidden.add(`${projectId}:${S.pagesSkills[0].id}`);
      return json(res, 200, { count: S.pagesSkills.length, lang: request.lang === true, hidden: request.hidden === true, patchError: S.skillsPatchError });
    }
    // The test reads the state HERE, not at the switch: whether a switch is on cannot be seen from outside — what counts is
    // what arrived at the server.
    if (path === "/fixture/pages-skills" && method === "GET") {
      return json(res, 200, { skills: S.pagesSkills, hidden: [...S.skillsHidden], calls: S.skillsCalls });
    }
    // Counterpart for the chat that does not exist yet (draft).
    // The same for the saved dynamic workflows (routes-chat.mjs carries the chat route).
    if (path === `/api/workspaces/${workspaceId}/dyn-workflows` && method === "GET") {
      // The error text stays German: CodingUITests matches "nicht lesbar".
      if (S.dynLibraryError) return json(res, 500, { error: "Fixture: die Bibliothek ist nicht lesbar." });
      return json(res, 200, S.dynWorkflows.map(dynShort));
    }
    // The library as a Coding category — view (script byte-identical) and delete per id (as the server: `[0-9a-f-]+`), the
    // takeover per project goes by the NAME in the path. Every call is in `S.dynLibraryCalls` with the RAW path: a name encoded
    // beforehand would arrive here as `%25…` and hit no entry (404).
    {
      const single = path.match(/^\/api\/workspaces\/[^/]+\/dyn-workflows\/([0-9a-f-]+)$/);
      if (single && (method === "GET" || method === "DELETE")) {
        S.dynLibraryCalls.push({ method, path });
        const index = S.dynWorkflows.findIndex((w) => w.id === single[1]);
        if (index < 0) return json(res, 404, { error: "dynamic workflow not found" });
        const w = S.dynWorkflows[index];
        if (method === "GET") return json(res, 200, { ...dynShort(w), meta: { name: w.name, description: w.description, ...(w.title ? { title: w.title } : {}), ...(w.whenToUse ? { whenToUse: w.whenToUse } : {}), ...(w.phases?.length ? { phases: w.phases } : {}) }, script: w.script });
        S.dynWorkflows.splice(index, 1);
        S.dynTakenOver.delete(w.name);
        return json(res, 200, { ok: true });
      }
    }
    if (path === `/api/projects/${projectId}/workspace-dyn-workflows` && method === "GET") {
      if (S.dynLibraryError) return json(res, 500, { error: "Fixture: die Bibliothek ist nicht lesbar." });
      return json(res, 200, S.dynWorkflows.map((w) => ({ ...dynShort(w), enabled: S.dynTakenOver.has(w.name) })));
    }
    {
      const takeover = path.match(/^\/api\/projects\/[^/]+\/workspace-dyn-workflows\/([^/]+)\/enabled$/);
      if (takeover && method === "PATCH") {
        const request = (await body(req)) || {};
        S.dynLibraryCalls.push({ method, path, body: request });
        // As the server: the field is required and a boolean (a missing field is not a statement).
        if (typeof request.enabled !== "boolean") return json(res, 400, { error: "Field \"enabled\" is missing or not a boolean." });
        let name;
        try { name = decodeURIComponent(takeover[1]); } catch { return json(res, 400, { error: "bad name" }); }
        const w = S.dynWorkflows.find((x) => x.name === name);
        if (!w) return json(res, 404, { error: "dynamic workflow not found" });
        if (request.enabled) S.dynTakenOver.add(w.name);
        else S.dynTakenOver.delete(w.name);
        return json(res, 200, { ok: true, name: w.name, enabled: request.enabled });
      }
    }
    if (path === `/api/workspaces/${workspaceId}/effective-skills` && method === "GET") {
      return json(res, 200, S.skills);
    }
    // Reset or empty — a test over the EMPTY picker needs a workspace without skills.
    if (path === "/fixture/skills" && method === "POST") {
      const request = (await body(req)) || {};
      S.skills = Array.isArray(request.skills) ? request.skills : defaultSkills();
      return json(res, 200, { count: S.skills.length });
    }
    if (path === `/api/workspaces/${workspaceId}/workflows` && method === "POST") {
      const request = await body(req);
      const created = {
        id: `50000000-0000-4000-8000-0000000000${(S.workflows.length + 10).toString().padStart(2, "0")}`,
        name: String(request.name || "Workflow"),
        description: String(request.description || ""),
        projectId: null,
        graph: { nodes: [], edges: [] },
      };
      S.workflows.push(created);
      return json(res, 201, workflowFull(created));
    }
    if (path === `/api/projects/${projectId}/workflows` && method === "GET") {
      return json(res, 200, S.projectWorkflows.map(workflowMeta));
    }
    if (path === `/api/projects/${projectId}/workspace-workflows` && method === "GET") {
      return json(res, 200, S.workflows.map((w) => ({ ...workflowMeta(w), enabled: S.adoptedWorkflows.has(w.name) })));
    }
    {
      const adopt = path.match(/^\/api\/projects\/[^/]+\/workspace-workflows\/(.+)\/enabled$/);
      if (adopt && method === "PATCH") {
        const request = await body(req);
        const name = decodeURIComponent(adopt[1]);
        if (request.enabled) S.adoptedWorkflows.add(name);
        else S.adoptedWorkflows.delete(name);
        return json(res, 200, { ok: true });
      }
      const single = path.match(/^\/api\/(?:workspaces|projects)\/[^/]+\/workflows\/([^/]+)$/);
      if (single) {
        const list = path.includes("/projects/") ? S.projectWorkflows : S.workflows;
        const index = list.findIndex((w) => w.id === single[1]);
        if (index < 0) return json(res, 404, { error: "workflow not found" });
        if (method === "GET") return json(res, 200, workflowFull(list[index]));
        if (method === "PUT") {
          const request = await body(req);
          S.lastWorkflowPut = request;
          // Arming as on the real server (definitions.js): only with a fully configured trigger — otherwise 400, and NOTHING is
          // stored.
          if (typeof request.active === "boolean" && request.active) {
            const node = (request.graph || list[index].graph).nodes || [];
            const ready = node.filter((n) => n.type === "trigger" && n.trigger?.accountId && (n.trigger?.events || []).length);
            if (!node.some((n) => n.type === "trigger")) return json(res, 400, { error: "Activating needs a trigger step." });
            if (!ready.length) return json(res, 400, { error: "The trigger is not fully configured yet." });
          }
          if (request.lock && typeof request.lock === "object") {
            if (request.lock.scope !== undefined && !LOCK_SCOPES_FIXTURE.includes(String(request.lock.scope))) {
              return json(res, 400, { error: "Unknown lock scope." });
            }
            const lock = lockOf({ scope: request.lock.scope ?? list[index].lock?.scope, template: request.lock.template ?? list[index].lock?.template });
            if (lock.scope === "custom" && !lock.template.trim()) return json(res, 400, { error: "A custom key needs a template." });
            list[index].lock = lock;
          }
          if (typeof request.active === "boolean") list[index].active = request.active;
          if (typeof request.name === "string" && request.name.trim()) list[index].name = request.name.trim();
          if (typeof request.description === "string") list[index].description = request.description;
          // As on the real server: without `run` the run settings stay; if it comes, the body applies over the stock — the
          // test for the meta sheet measures that.
          if (request.run && typeof request.run === "object") list[index].run = runOf({ ...runOf(list[index].run), ...request.run });
          // As `normalizeGraph` on the real server: title/text are trimmed; the three modes of the nodes (doneMode,
          // doneCapMode, loopCapMode) stay as they come.
          if (request.graph) {
            list[index].graph = {
              nodes: (request.graph.nodes || []).map((n) => ({ ...n, title: String(n.title || "").trim(), text: String(n.text || "").trim() })),
              edges: request.graph.edges || [],
            };
          }
          return json(res, 200, workflowFull(list[index]));
        }
        if (method === "DELETE") {
          list.splice(index, 1);
          return json(res, 200, { ok: true });
        }
      }
    }
    if (path === `/api/chats/${S.chat.id}/workflows` && method === "GET") {
      return json(res, 200, withShortNames([...S.workflows, ...S.projectWorkflows]).map((w) => ({ ...workflowMeta(w), shortName: w.shortName })));
    }
    // Skills of this chat — the second kind in the slash picker. Deliberately for EVERY chat and not only for `chat.id`: the
    // overview lists three, and which one a test opens depends on their order. A route that knows only one of them gives the
    // picker an empty list in two of three cases — and the test would be green without entering the path.
    if (/^\/api\/chats\/[0-9a-f-]+\/skills$/.test(path) && method === "GET") {
      return json(res, 200, S.skills);
    }
    return NEXT;
}
