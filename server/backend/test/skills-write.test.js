// Coding main agents write skills. The promises and their ways:
//   (1) Version on every skill response, `lastChange`/`openRequest` on the lists, `id/version/level` on cbase_skill.
//   (2) Tool route per role: the main agent of a coding chat 201; subagent, workflow agent, outer loop, manager agent, special
//       chat 403 — even if the model sends the marks itself (they come AFTER its arguments).
//   (3) Switch per workspace: off ⇒ route 403 AND no mark in the MCP file AND no offering.
//   (4) Version/conflict 409, rename, unchanged, names (taken, a project skill under a workspace skill's name).
//   (5) An agent definition names the skill ⇒ rename, request, release and also the UI's DELETE 409 with `references`.
//   (6) Trash + restore: text, resources and hides come back, exactly once.
//   (7) Undo: exactly once, only on the latest state (otherwise 409 with both states), writes no new entry.
//   (8) Deletion request: requested, merged, lapses on a change (hint), approve/reject (hint), exactly once.
//   (9) Offering: writeMcpConfig writes the mark only for the coding main run; offeringNames offers only with it.
//  (10) Event on /api/events.
//  (11) The line of a skill an agent wrote last carries the mark in the catalog and the head its sentence; cbase_skill says it
//       with `ofAgent`/`hint`; after a human change both are gone, without a mark the block stays as before.
//  (12) A merged request reports decision and lapse to EACH of its chats; a request whose skill was changed past the mutation
//       path lapses on reading (list, request, skill list) with a hint.
//  (13) The fields of the 409 (`existing`, `current`, `references`) reach the model through the real MCP server; a managing
//       skill stays invisible to the agent even in a name conflict (no `existing`), not to the human.
//  (14) `revertible` says the same as `revert` (reference, taken old name); deleteProject cleans history, requests and the
//       trash folders of the project skills, the workspace skill stays.
// Counter-proofs (each by a short sabotage): without the role check of the route (2) goes red, without the switch in
// mcp-config.js (3), without the reference check in skillDelete (5), without the "already reverted" check in revert (6)/(7).
// The condition `reverted_at IS NULL` in the UPDATE (store/skill-history.js) is the second wall against a concurrent second
// call — the mutation path is synchronous, a test does not reach it without the first. For (11)–(14): without the mark in
// skillCatalog (11) goes red, without `additionalChats` in requestChats and without cleanStaleRequests (12), without
// ERROR_OBJECTS in mcp/lib.js and without the managing branch in checkFree (13), without the reference check in revertible
// (14); without the DELETEs in deleteProject/deleteWorkspace the deletion lists in the schema register.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as store from "../electron/server/store.js";
import { writeMcpConfig } from "../electron/server/toolchain/mcp-config.js";
import { offeringNames } from "../electron/mcp/offering.js";
import { ONLY_CODING_MAIN_RUN, OUTER_LOOP_LOCKED, VIEW_BY_DEPTH, WORKFLOW_AGENT_INDIVIDUAL, lockedForDepth, lockedForWorkflowAgent } from "../electron/mcp/visibility.js";
import { skillTools } from "../electron/mcp/tools/skills.js";
import { AGENTS_MARKER, AGENTS_SENTENCE, skillCatalog } from "../electron/server/toolchain/skill-catalog.js";
import { riskOf } from "../electron/server/providers/permission-gate.js";
import { FENCE_TABLE } from "../electron/server/projectbox/fence-table.js";
import { withAgentsServer, waitForTruthy } from "./agent-harness.mjs";

const MCP_SCRIPT = fileURLToPath(new URL("../electron/mcp/cbase-mcp.js", import.meta.url));
const WRITE = "cbase_skill_write";

async function request(base, method, filePath, body) {
  const res = await fetch(`${base}${filePath}`, { method, headers: { Connection: "close", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const tool = (base, chatId, body) => request(base, "POST", `/api/chats/${chatId}/skill-write`, body);
// A managing skill is only legacy data since the managing teardown (the route no longer takes `area: managing`, 400) —
// the test puts it into the store as it stands in an old database.
const oldManaging = (ws, name) => {
  const t = Date.now();
  return store.createSkill({ id: crypto.randomUUID(), workspaceId: ws.id, name, description: "Managing.", body: "M", area: "managing", createdAt: t, updatedAt: t });
};

// The real MCP server with the environment of a run (like agenda.test.js).
function withMcp(env, run) {
  const child = spawn(process.execPath, [MCP_SCRIPT], {
    env: { ...process.env, CBASE_TOOLS: undefined, CBASE_TOOLSET: undefined, CBASE_SKILLS: undefined, CBASE_AGENT_DEPTH: undefined,
      CBASE_WORKFLOW_AGENT: undefined, CBASE_OUTER_LOOP: undefined, CBASE_INSTANCE: undefined, CBASE_PROFILE_KEY: undefined,
      CBASE_ONLY_SUBAGENTS: undefined, CBASE_TOKEN: undefined, CBASE_SKILL_WRITE: undefined, ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const open = new Map();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const z = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!z) continue;
      const msg = JSON.parse(z);
      open.get(msg.id)?.(msg);
      open.delete(msg.id);
    }
  });
  let n = 1;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = n++;
    open.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = async (name, args = {}) => {
    const r = (await rpc("tools/call", { name, arguments: args })).result || {};
    const text = r.content?.[0]?.text || "";
    let data = null;
    try { data = JSON.parse(text); } catch { /* error text */ }
    return { isError: r.isError === true, text, data };
  };
  const list = async () => ((await rpc("tools/list", {})).result?.tools || []);
  return (async () => {
    try {
      await rpc("initialize", { protocolVersion: "2025-06-18" });
      return await run({ call, list });
    } finally {
      child.stdin.end();
      child.kill();
    }
  })();
}

// The global stream, recorded (only the skill events).
function globalStreamFor(base) {
  const ctl = new AbortController();
  const events = [];
  let connected = false;
  (async () => {
    try {
      const res = await fetch(`${base}/api/events`, { signal: ctl.signal, headers: { Connection: "close" } });
      connected = true;
      const dec = new TextDecoder();
      let b = "";
      for await (const chunk of res.body) {
        b += dec.decode(chunk, { stream: true });
        let i;
        while ((i = b.indexOf("\n\n")) >= 0) {
          const block = b.slice(0, i);
          b = b.slice(i + 2);
          const row = block.split("\n").find((z) => z.startsWith("data: "));
          if (!row) continue;
          try { const e = JSON.parse(row.slice(6)); if (e.type === "skills") events.push(e); } catch { /* no JSON */ }
        }
      }
    } catch { /* aborted */ }
  })();
  return { events, connected: () => connected, shutdown: () => ctl.abort() };
}

async function createProject(base, ws, name) {
  const filePath = path.join(ws.path, name.toLowerCase());
  fs.mkdirSync(filePath, { recursive: true });
  const r = await request(base, "POST", `/api/workspaces/${ws.id}/projects`, { name, path: filePath });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
const newChat = async (base, ws, body = {}) => (await request(base, "POST", "/api/chats", { workspaceId: ws.id, provider: "claude", ...body })).data;
const read = async (base, chatId, name) => (await request(base, "GET", `/api/chats/${chatId}/skills/${name}`)).data;

test("(1) version on every skill response; lists including lastChange/openRequest; cbase_skill supplies id, version, level", async () => {
  await withAgentsServer(async ({ base, ws, chat }) => {
    const r = await request(base, "POST", `/api/workspaces/${ws.id}/skills`, { name: "grill", area: "coding", description: "Checks a plan.", body: "Ask questions." });
    assert.equal(r.status, 201);
    const expected = crypto.createHash("sha256").update("grill\0Checks a plan.\0Ask questions.").digest("hex").slice(0, 16);
    assert.equal(r.data.version, expected, "version = sha256(name \\0 description \\0 body), 16 base-16 characters");
    const list = (await request(base, "GET", `/api/workspaces/${ws.id}/skills?area=coding`)).data;
    assert.equal(list[0].version, expected);
    assert.equal(list[0].lastChange.who, "human");
    assert.equal(list[0].openRequest, null);
    const eff = (await request(base, "GET", `/api/workspaces/${ws.id}/effective-skills`)).data;
    assert.equal(eff[0].version, expected);
    assert.ok("lastChange" in eff[0] && "openRequest" in eff[0]);
    assert.equal((await request(base, "GET", `/api/chats/${chat.id}/skills`)).data[0].version, expected, "the chat's list too (slash picker)");
    const l = await read(base, chat.id, "grill");
    assert.equal(l.id, r.data.id);
    assert.equal(l.version, expected);
    assert.equal(l.level, "workspace");
    // The project list and workspace-skills likewise.
    const p = await createProject(base, ws, "Shop");
    await request(base, "POST", `/api/projects/${p.id}/skills`, { name: "receipt", description: "Receipt.", body: "B" });
    const pl = (await request(base, "GET", `/api/projects/${p.id}/skills`)).data;
    assert.ok(pl[0].version && "lastChange" in pl[0] && "openRequest" in pl[0]);
    const wl = (await request(base, "GET", `/api/projects/${p.id}/workspace-skills`)).data;
    assert.ok(wl[0].version && "lastChange" in wl[0] && wl[0].enabled === true);
  });
});

test("(2) tool route per role: main agent of a coding chat 201 (through the real MCP server), subagent/workflow/outer loop 403, manager chats 409", async () => {
  await withAgentsServer(async ({ base, ws, chat }) => {
    // The main agent through the real MCP server — the model sends the marks empty, they drop out before the own ones.
    await withMcp({ CBASE_BASE_URL: base, CBASE_CHAT_ID: chat.id, CBASE_WORKSPACE_ID: ws.id, CBASE_SKILL_WRITE: "1" }, async ({ call, list }) => {
      const names = (await list()).map((t) => t.name);
      assert.ok(names.includes(WRITE) && names.includes("cbase_skill"), "both tools on offer, even without a catalog");
      const r = await call(WRITE, { action: "create", name: "till-receipt", description: "Formats a receipt.", guide: "Step 1", ofProfile: "", workflowAgent: "", outerLoop: "" });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.data.ok, true);
      assert.equal(r.data.skill.name, "till-receipt");
      assert.equal(r.data.skill.level, "workspace");
      assert.ok(r.data.historyId);
      // Loadable in the same turn — the name is a free string, checked in the server.
      const l = await call("cbase_skill", { name: "till-receipt" });
      assert.equal(l.isError, false, l.text);
      assert.equal(l.data.body, "Step 1");
      assert.equal(l.data.version, r.data.skill.version);
      const missing = await call("cbase_skill", { name: "nonexistent" });
      assert.equal(missing.isError, true, "an unknown name runs into a wall in the server");
    });
    // A subagent (depth 1) does not see the tool, even with the mark; if it calls the route, 403.
    await withMcp({ CBASE_BASE_URL: base, CBASE_CHAT_ID: chat.id, CBASE_WORKSPACE_ID: ws.id, CBASE_SKILL_WRITE: "1", CBASE_AGENT_DEPTH: "1", CBASE_PROFILE_KEY: "p-1" }, async ({ list }) => {
      assert.equal((await list()).some((t) => t.name === WRITE), false);
    });
    const create = { action: "create", name: "x-role", description: "x" };
    for (const [role, markers] of [["subagent", { ofProfile: "p-1" }], ["workflow", { workflowAgent: "wf-1" }], ["outer_loop", { outerLoop: "a:b" }]]) {
      const r = await tool(base, chat.id, { ...create, ...markers });
      assert.equal(r.status, 403, role);
      assert.equal(r.data.role, role);
    }
    const t = Date.now();
    const mgr = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "manager", agentId: "ag-1", title: "Manager", createdAt: t, updatedAt: t });
    const verw = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "manager", title: "Administrator", createdAt: t, updatedAt: t });
    store.updateChat(verw.id, { specialRole: "administrator" });
    // Manager agent and administrator are manager chats, read-only — the lock (409, runs/manager-lock.js) answers before the
    // role check.
    for (const c of [mgr, verw]) {
      const r = await tool(base, c.id, create);
      assert.equal(r.status, 409, c.title);
      assert.equal(r.data.managerLocked, true, c.title);
    }
    assert.ok(!store.getSkillByName(ws.id, null, "x-role"), "no role except coding created it");
    // Unknown action, missing name: 400 — nothing written.
    assert.equal((await tool(base, chat.id, { action: "rechristen" })).status, 400);
    assert.equal((await tool(base, chat.id, { action: "create" })).status, 400);
    assert.equal((await tool(base, chat.id, { action: "create", name: "Upper Case" })).status, 400);
    assert.equal((await tool(base, chat.id, { action: "create", name: "long", description: "x".repeat(1001) })).status, 400, "cap of the description");
    // Archived: 409 (the lock BEFORE the body in chatRoutes).
    const arch = await newChat(base, ws);
    assert.equal((await request(base, "PUT", `/api/chats/${arch.id}/archive`, { archived: true })).status, 200);
    assert.equal((await tool(base, arch.id, create)).status, 409);
  });
});

test("(3) switch per workspace: off ⇒ route 403, no mark in the MCP file, no offering; without a boolean 400; default on", async () => {
  await withAgentsServer(async ({ base, ws, chat, root }) => {
    assert.deepEqual((await request(base, "GET", `/api/workspaces/${ws.id}/skill-settings`)).data, { agentsWrite: true }, "missing value = on");
    const file = path.join(root, "mcp-toggle.json");
    const opts = { workspaceId: ws.id, chatId: chat.id, extraServers: [], headless: true, toolset: "", tools: null, skills: [], vision: true };
    let env = writeMcpConfig(file, opts).servers.cbase.env;
    assert.equal(env.CBASE_SKILL_WRITE, "1");
    assert.ok(offeringNames(env).includes(WRITE));
    assert.equal((await request(base, "PUT", `/api/workspaces/${ws.id}/skill-settings`, {})).status, 400, "a missing field is not an announcement");
    assert.equal((await request(base, "PUT", `/api/workspaces/${ws.id}/skill-settings`, { agentsWrite: "no" })).status, 400);
    const out = await request(base, "PUT", `/api/workspaces/${ws.id}/skill-settings`, { agentsWrite: false });
    assert.deepEqual(out.data, { agentsWrite: false });
    env = writeMcpConfig(file, opts).servers.cbase.env;
    assert.equal(env.CBASE_SKILL_WRITE, undefined, "off ⇒ no mark");
    assert.equal(offeringNames(env).includes(WRITE), false, "off ⇒ no offering");
    const r = await tool(base, chat.id, { action: "create", name: "off-test" });
    assert.equal(r.status, 403);
    assert.equal(r.data.off, true);
    assert.ok(!store.getSkillByName(ws.id, null, "off-test"));
    // The UI is unaffected.
    assert.equal((await request(base, "POST", `/api/workspaces/${ws.id}/skills`, { name: "off-test", area: "coding" })).status, 201);
    await request(base, "PUT", `/api/workspaces/${ws.id}/skill-settings`, { agentsWrite: true });
    assert.equal(writeMcpConfig(file, opts).servers.cbase.env.CBASE_SKILL_WRITE, "1");
  });
});

test("(4) version/conflict 409, rename, unchanged without an entry, names taken, project skill under a workspace skill's name", async () => {
  await withAgentsServer(async ({ base, ws }) => {
    const p = await createProject(base, ws, "Shop");
    const pc = await newChat(base, ws, { projectId: p.id });
    const wc = await newChat(base, ws);
    // Project chat ⇒ project level as the default.
    const a = await tool(base, pc.id, { action: "create", name: "receipt", description: "Format a receipt.", guide: "v1" });
    assert.equal(a.status, 201, JSON.stringify(a.data));
    assert.equal(a.data.skill.level, "project");
    assert.equal(a.data.skill.projectName, "Shop");
    const id = a.data.skill.id;
    const v1 = a.data.skill.version;
    // Without version: 400; outdated: 409 with current.version.
    assert.equal((await tool(base, pc.id, { action: "change", id, guide: "v2" })).status, 400);
    const b = await tool(base, pc.id, { action: "change", id, version: v1, guide: "v2" });
    assert.equal(b.status, 200);
    const v2 = b.data.skill.version;
    assert.notEqual(v2, v1);
    const k = await tool(base, pc.id, { action: "change", id, version: v1, guide: "v3" });
    assert.equal(k.status, 409);
    assert.equal(k.data.conflict, true);
    assert.equal(k.data.current.version, v2);
    assert.equal(store.getSkill(id).body, "v2", "the conflict changes nothing");
    // Unchanged: no entry, no event.
    const prior = store.skillHistoryList(ws.id, { skillId: id }).length;
    const u = await tool(base, pc.id, { action: "change", id, version: v2, guide: "v2" });
    assert.equal(u.data.unchanged, true);
    assert.equal(u.data.historyId, null);
    assert.equal(store.skillHistoryList(ws.id, { skillId: id }).length, prior);
    // Rename: the name changes, the id stays; the chat reads under the new name.
    const ren = await tool(base, pc.id, { action: "change", id, version: v2, name: "till-receipt" });
    assert.equal(ren.status, 200);
    assert.equal(store.getSkill(id).name, "till-receipt");
    assert.equal((await read(base, pc.id, "till-receipt")).id, id);
    // Name taken (on the same level): 409 with existing.
    await tool(base, pc.id, { action: "create", name: "second" });
    const taken = await tool(base, pc.id, { action: "create", name: "till-receipt" });
    assert.equal(taken.status, 409);
    assert.equal(taken.data.existing.id, id);
    // A project skill under the name of a workspace coding skill — rejected through the tool, the UI stays as it is.
    const wsSkill = await tool(base, wc.id, { action: "create", name: "grill", description: "Workspace." });
    assert.equal(wsSkill.data.skill.level, "workspace");
    const e9 = await tool(base, pc.id, { action: "create", name: "grill" });
    assert.equal(e9.status, 409);
    assert.equal(e9.data.existing.level, "workspace");
    assert.match(e9.data.error, /Ändere den vorhandenen/); // German T() output (uiLang de)
    const e9ren = await tool(base, pc.id, { action: "change", id, version: store.getSkill(id).version, name: "grill" });
    assert.equal(e9ren.status, 409, "also when renaming");
    assert.equal((await request(base, "POST", `/api/projects/${p.id}/skills`, { name: "grill" })).status, 201, "the UI stays as it is");
    // A workspace chat creates a project skill and names the project; without naming 400.
    assert.equal((await tool(base, wc.id, { action: "create", name: "without-project", level: "project" })).status, 400);
    const including = await tool(base, wc.id, { action: "create", name: "with-project", level: "project", project: "Shop" });
    assert.equal(including.status, 201);
    assert.equal(including.data.skill.level, "project");
    // An id outside the set of the chat: 404 (a project skill of ANOTHER project for a project chat).
    const q = await createProject(base, ws, "Storage");
    const foreign = (await request(base, "POST", `/api/projects/${q.id}/skills`, { name: "stocktake" })).data;
    assert.equal((await tool(base, pc.id, { action: "change", id: foreign.id, version: foreign.version, guide: "x" })).status, 404);
    // Managing skills are invisible to the tool — only legacy data now, which no way creates; the test puts it into the store.
    const mg = oldManaging(ws, "situation");
    assert.equal((await tool(base, wc.id, { action: "erase", id: mg.id, version: mg.version })).status, 404);
  });
});

test("(5) an agent definition names the skill — rename, request and the UI's DELETE (workspace and project) 409 with references", async () => {
  await withAgentsServer(async ({ base, ws, chat }) => {
    const p = await createProject(base, ws, "Shop");
    const sk = (await request(base, "POST", `/api/workspaces/${ws.id}/skills`, { name: "rules", area: "coding", body: "R" })).data;
    const psk = (await request(base, "POST", `/api/projects/${p.id}/skills`, { name: "receipt" })).data;
    const t = Date.now();
    const def = store.createAgent({ id: crypto.randomUUID(), workspaceId: ws.id, projectId: null, name: "Checker", skills: "rules, receipt", createdAt: t, updatedAt: t });
    const del = await request(base, "DELETE", `/api/workspaces/${ws.id}/skills/${sk.id}`);
    assert.equal(del.status, 409);
    assert.deepEqual(del.data.references, [{ id: def.id, name: "Checker", level: "workspace" }]);
    assert.ok(store.getSkill(sk.id), "not deleted");
    const pDelete = await request(base, "DELETE", `/api/projects/${p.id}/skills/${psk.id}`);
    assert.equal(pDelete.status, 409, "also a project skill that a workspace agent names");
    const ren = await tool(base, chat.id, { action: "change", id: sk.id, version: sk.version, name: "rules-new" });
    assert.equal(ren.status, 409);
    assert.equal(ren.data.references[0].name, "Checker");
    const request2 = await tool(base, chat.id, { action: "erase", id: sk.id, version: sk.version });
    assert.equal(request2.status, 409);
    assert.ok(Array.isArray(request2.data.references));
    // Changing without renaming works.
    assert.equal((await tool(base, chat.id, { action: "change", id: sk.id, version: sk.version, guide: "R2" })).status, 200);
    // Reference removed ⇒ deleting works.
    store.updateAgent(def.id, { skills: "" });
    assert.equal((await request(base, "DELETE", `/api/workspaces/${ws.id}/skills/${sk.id}`)).status, 200);
    assert.ok(!store.getSkill(sk.id));
  });
});

test("(6) trash and restore: resources move, text, files and hides come back — exactly once", async () => {
  await withAgentsServer(async ({ base, ws }) => {
    const p = await createProject(base, ws, "Shop");
    const sk = (await request(base, "POST", `/api/workspaces/${ws.id}/skills`, { name: "rules", area: "coding", description: "D", body: "Text", allowedTools: "Read", model: "haiku" })).data;
    const dir = store.skillResourceDir(sk.id);
    fs.mkdirSync(path.join(dir, "references"), { recursive: true });
    fs.writeFileSync(path.join(dir, "references", "a.md"), "Attachment");
    store.updateSkill(sk.id, { hasResources: true });
    assert.equal((await request(base, "PATCH", `/api/projects/${p.id}/workspace-skills/${sk.id}/enabled`, { enabled: false })).status, 200);
    assert.equal((await request(base, "DELETE", `/api/workspaces/${ws.id}/skills/${sk.id}`)).status, 200);
    assert.equal(fs.existsSync(dir), false, "gone from the resource store");
    const deleted = (await request(base, "GET", `/api/workspaces/${ws.id}/skill-deleted`)).data.entries;
    assert.equal(deleted.length, 1);
    const e = deleted[0];
    assert.equal(e.kind, "erase");
    assert.equal(e.trash, true);
    assert.equal(e.revertible, true);
    assert.deepEqual(e.prior.hiddenIn, [p.id]);
    assert.equal(fs.readFileSync(path.join(store.skillTrashDir(e.id), "references", "a.md"), "utf8"), "Attachment", "in the trash, not in nothing");
    // Restore = undo of the delete entry.
    const z = await request(base, "POST", `/api/skill-history/${e.id}/revert`);
    assert.equal(z.status, 200, JSON.stringify(z.data));
    assert.equal(z.data.skill.id, sk.id, "under the old id");
    const fresh = store.getSkill(sk.id);
    assert.equal(fresh.body, "Text");
    assert.equal(fresh.allowedTools, "Read");
    assert.equal(fresh.model, "haiku");
    assert.equal(fresh.area, "coding");
    assert.equal(fs.readFileSync(path.join(dir, "references", "a.md"), "utf8"), "Attachment", "files back");
    const ws2 = (await request(base, "GET", `/api/projects/${p.id}/workspace-skills`)).data;
    assert.equal(ws2.find((s) => s.id === sk.id).enabled, false, "the hide came back too");
    assert.equal((await request(base, "GET", `/api/workspaces/${ws.id}/skill-deleted`)).data.entries.length, 0);
    const two = await request(base, "POST", `/api/skill-history/${e.id}/revert`);
    assert.equal(two.status, 409, "exactly once");
    assert.equal(two.data.reverted, true, "rejected as \"already reverted\", not as a conflict");
    // No new entry through undo: create + erase, the delete entry is marked.
    const history = (await request(base, "GET", `/api/workspaces/${ws.id}/skill-history?skillId=${sk.id}`)).data.entries;
    assert.deepEqual(history.map((x) => x.kind), ["erase", "create"]);
    assert.ok(history[0].revertedAt);
    // Restoring fails if another skill carries the name.
    assert.equal((await request(base, "DELETE", `/api/workspaces/${ws.id}/skills/${sk.id}`)).status, 200);
    const e2 = (await request(base, "GET", `/api/workspaces/${ws.id}/skill-deleted`)).data.entries[0];
    await request(base, "POST", `/api/workspaces/${ws.id}/skills`, { name: "rules", area: "coding" });
    assert.equal((await request(base, "GET", `/api/workspaces/${ws.id}/skill-deleted`)).data.entries[0].revertible, false);
    const kon = await request(base, "POST", `/api/skill-history/${e2.id}/revert`);
    assert.equal(kon.status, 409);
    assert.equal(kon.data.existing.name, "rules");
  });
});

test("(7) undo: only on the latest state (otherwise 409 with both states), exactly once; undoing a create, and the reference check", async () => {
  await withAgentsServer(async ({ base, ws, chat }) => {
    const a = (await tool(base, chat.id, { action: "create", name: "plan", guide: "v1" })).data;
    const b = (await tool(base, chat.id, { action: "change", id: a.skill.id, version: a.skill.version, guide: "v2" })).data;
    const c = (await tool(base, chat.id, { action: "change", id: a.skill.id, version: b.skill.version, guide: "v3", name: "plan-new" })).data;
    const history = (await request(base, "GET", `/api/workspaces/${ws.id}/skill-history?skillId=${a.skill.id}`)).data.entries;
    assert.deepEqual(history.map((e) => [e.kind, e.who, e.chatId, e.revertible]), [["change", "agent", chat.id, true], ["change", "agent", chat.id, false], ["create", "agent", chat.id, false]]);
    assert.equal(history[0].prior.body, "v2");
    assert.equal(history[0].after.body, "v3");
    // The older entry: conflict with both states.
    const k = await request(base, "POST", `/api/skill-history/${b.historyId}/revert`);
    assert.equal(k.status, 409);
    assert.equal(k.data.conflict, true);
    assert.equal(k.data.current.body, "v3");
    assert.equal(k.data.expected.body, "v2");
    // The latest: back to v2 and the old name.
    const z = await request(base, "POST", `/api/skill-history/${c.historyId}/revert`);
    assert.equal(z.status, 200);
    assert.equal(z.data.skill.body, "v2");
    assert.equal(z.data.skill.name, "plan");
    const again = await request(base, "POST", `/api/skill-history/${c.historyId}/revert`);
    assert.equal(again.status, 409, "exactly once");
    assert.equal(again.data.reverted, true);
    // Now the middle one is next.
    const v2 = (await request(base, "GET", `/api/workspaces/${ws.id}/skill-history?skillId=${a.skill.id}`)).data.entries;
    assert.deepEqual(v2.map((e) => e.revertible), [false, true, false]);
    assert.equal(v2.length, 3, "undo writes no new entry");
    assert.equal((await request(base, "POST", `/api/skill-history/${b.historyId}/revert`)).status, 200);
    // Undoing the create — with the reference check.
    const t = Date.now();
    const def = store.createAgent({ id: crypto.randomUUID(), workspaceId: ws.id, name: "Consumer", skills: "plan", createdAt: t, updatedAt: t });
    const e8 = await request(base, "POST", `/api/skill-history/${a.historyId}/revert`);
    assert.equal(e8.status, 409);
    assert.equal(e8.data.references[0].id, def.id);
    store.deleteAgent(def.id);
    const way = await request(base, "POST", `/api/skill-history/${a.historyId}/revert`);
    assert.equal(way.status, 200);
    assert.equal(way.data.skill, undefined);
    assert.ok(!store.getSkill(a.skill.id));
    assert.equal((await request(base, "POST", `/api/skill-history/${crypto.randomUUID()}/revert`)).status, 404);
  });
});

test("(8) deletion request: requested, merged, lapses on a change (hint), approve and reject (hint), exactly once", async () => {
  await withAgentsServer(async ({ base, ws, chat }) => {
    const a = (await tool(base, chat.id, { action: "create", name: "old", guide: "x" })).data;
    const r1 = await tool(base, chat.id, { action: "erase", id: a.skill.id, version: a.skill.version, reason: "stale" });
    assert.equal(r1.status, 200);
    assert.deepEqual(Object.keys(r1.data).sort(), ["ok", "requestId", "requested"]);
    assert.ok(store.getSkill(a.skill.id), "deleting is a request — the skill stays");
    const r2 = await tool(base, chat.id, { action: "erase", id: a.skill.id, version: a.skill.version });
    assert.equal(r2.data.requestId, r1.data.requestId);
    assert.equal(r2.data.merged, true);
    const request2 = (await request(base, "GET", `/api/skill-requests/${r1.data.requestId}`)).data;
    assert.equal(request2.status, "open");
    assert.equal(request2.current, true);
    assert.equal(request2.reason, "stale");
    assert.equal(request2.skillName, "old");
    const list = (await request(base, "GET", `/api/workspaces/${ws.id}/skill-requests?status=open`)).data.requests;
    assert.deepEqual(list.map((x) => x.id), [r1.data.requestId]);
    assert.equal((await request(base, "GET", `/api/workspaces/${ws.id}/skill-requests?status=nonsense`)).status, 400);
    assert.equal((await request(base, "GET", `/api/workspaces/${ws.id}/skills?area=coding`)).data[0].openRequest.id, r1.data.requestId);
    // The human changes the skill beforehand ⇒ the request visibly lapses, the chat gets a hint.
    const beforeHint = store.openHints(chat.id).length;
    await request(base, "PUT", `/api/workspaces/${ws.id}/skills/${a.skill.id}`, { body: "changed" });
    assert.equal((await request(base, "GET", `/api/skill-requests/${r1.data.requestId}`)).data.status, "expired");
    const h = store.openHints(chat.id);
    assert.equal(h.length, beforeHint + 1);
    assert.match(h.at(-1).text, /verfallen/); // German T() output (uiLang de)
    assert.equal((await request(base, "POST", `/api/skill-requests/${r1.data.requestId}/decide`, { approve: true })).status, 409);
    // New request on the new version — without a boolean 400, approving deletes, twice 409.
    const v = store.getSkill(a.skill.id).version;
    const r3 = (await tool(base, chat.id, { action: "erase", id: a.skill.id, version: v })).data;
    assert.notEqual(r3.requestId, r1.data.requestId);
    assert.equal((await request(base, "POST", `/api/skill-requests/${r3.requestId}/decide`, {})).status, 400);
    const ok = await request(base, "POST", `/api/skill-requests/${r3.requestId}/decide`, { approve: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.request.status, "approved");
    assert.ok(!store.getSkill(a.skill.id));
    assert.match(store.openHints(chat.id).at(-1).text, /freigegeben/); // German T() output (uiLang de)
    assert.equal((await request(base, "POST", `/api/skill-requests/${r3.requestId}/decide`, { approve: true })).status, 409, "exactly once");
    const deleted = (await request(base, "GET", `/api/workspaces/${ws.id}/skill-deleted`)).data.entries[0];
    assert.equal(deleted.requestId, r3.requestId);
    assert.equal(deleted.who, "agent");
    // Reject: the skill stays, hint.
    const b = (await tool(base, chat.id, { action: "create", name: "stays" })).data;
    const r4 = (await tool(base, chat.id, { action: "erase", id: b.skill.id, version: b.skill.version })).data;
    const no = await request(base, "POST", `/api/skill-requests/${r4.requestId}/decide`, { approve: false });
    assert.equal(no.data.request.status, "rejected");
    assert.ok(store.getSkill(b.skill.id));
    assert.match(store.openHints(chat.id).at(-1).text, /abgelehnt/); // German T() output (uiLang de)
    // The chat is gone ⇒ the request stays at the skill page.
    const r5 = (await tool(base, chat.id, { action: "erase", id: b.skill.id, version: b.skill.version })).data;
    assert.ok(r5.requestId);
    assert.equal((await request(base, "GET", `/api/skill-requests/${crypto.randomUUID()}`)).status, 404);
  });
});

test("(9) offering: only the coding main run carries the mark; subagent, workflow agent, outer loop, explicit list, named set and special chat do not — visibility, release level, fence", async () => {
  await withAgentsServer(async ({ base, ws, chat, root }) => {
    const file = path.join(root, "mcp-offering.json");
    const baseValue = { workspaceId: ws.id, chatId: chat.id, extraServers: [], headless: true, toolset: "", tools: null, skills: [], vision: true };
    const marker = (o) => writeMcpConfig(file, { ...baseValue, ...o }).servers.cbase.env.CBASE_SKILL_WRITE;
    assert.equal(marker({}), "1", "main run");
    assert.equal(marker({ agentDepth: 1, profileKey: "p" }), undefined, "subagent");
    assert.equal(marker({ agentDepth: 1, workflowAgent: "wf-1" }), undefined, "workflow agent");
    assert.equal(marker({ agentDepth: 1, outerLoop: "a:b", tools: [] }), undefined, "outer loop");
    assert.equal(marker({ tools: ["cbase_skill", WRITE] }), undefined, "explicit list");
    // A named set.
    assert.equal(marker({ toolset: "named" }), undefined, "named set");
    const t = Date.now();
    const mgr = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "manager", agentId: "ag-1", title: "M", createdAt: t, updatedAt: t });
    const context = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "normal", title: "K", createdAt: t, updatedAt: t });
    store.updateChat(context.id, { specialRole: "context" });
    assert.equal(marker({ chatId: mgr.id }), undefined, "manager chat without a list");
    assert.equal(store.getChat(context.id).specialRole, "context");
    assert.equal(marker({ chatId: context.id }), undefined, "special chat");
    // Visibility (description = execution) in all four lists.
    assert.ok(VIEW_BY_DEPTH.alwaysLocked.includes(WRITE) && WORKFLOW_AGENT_INDIVIDUAL.includes(WRITE) && OUTER_LOOP_LOCKED.includes(WRITE) && ONLY_CODING_MAIN_RUN.includes(WRITE));
    for (let depth = 1; depth <= 3; depth++) assert.equal(lockedForDepth(WRITE, depth), true);
    assert.equal(lockedForWorkflowAgent(WRITE), true);
    const including = { CBASE_SKILL_WRITE: "1" };
    assert.ok(offeringNames(including).includes(WRITE));
    assert.equal(offeringNames({}).includes(WRITE), false, "never without the mark");
    for (const env of [{ CBASE_AGENT_DEPTH: "1" }, { CBASE_WORKFLOW_AGENT: "wf" }, { CBASE_OUTER_LOOP: "a:b", CBASE_TOOLS: JSON.stringify([WRITE]) }, { CBASE_ONLY_SUBAGENTS: "1" }]) {
      assert.equal(offeringNames({ ...including, ...env }).includes(WRITE), false, JSON.stringify(env));
    }
    // Never asks (READ_MCP) — the release level is "read" like that of the agenda.
    assert.equal(riskOf(`mcp__cbase__${WRITE}`), riskOf("mcp__cbase__cbase_agenda_write"));
    // The fence row (project container).
    assert.ok(FENCE_TABLE.some((z) => z.family === "chat-skill-write" && z.rule === "allowed" && z.mcp === true), "row chat-skill-write");
    // The description: first sentence and length (the length guard holds it in general).
    const d = skillTools[0].description;
    assert.ok(d.length <= 1500);
    assert.match(d, /^[^.]{20,160}\./);
  });
});

test("(10) event `skills` on /api/events after create, change, request, decision, undo and switch", async () => {
  await withAgentsServer(async ({ base, ws, chat }) => {
    const stream = globalStreamFor(base);
    try {
      await waitForTruthy(() => stream.connected(), "stream connected");
      const a = (await tool(base, chat.id, { action: "create", name: "event" })).data;
      const b = (await tool(base, chat.id, { action: "change", id: a.skill.id, version: a.skill.version, guide: "fresh" })).data;
      const r = (await tool(base, chat.id, { action: "erase", id: a.skill.id, version: b.skill.version })).data;
      await request(base, "POST", `/api/skill-requests/${r.requestId}/decide`, { approve: false });
      await request(base, "POST", `/api/skill-history/${b.historyId}/revert`);
      await request(base, "PUT", `/api/workspaces/${ws.id}/skill-settings`, { agentsWrite: false });
      await waitForTruthy(() => stream.events.some((e) => e.kind === "setting"), "event setting");
      assert.deepEqual(stream.events.map((e) => e.kind), ["create", "change", "request", "decided", "back", "setting"]);
      const e = stream.events[0];
      assert.deepEqual(Object.keys(e).sort(), ["kind", "projectId", "skillId", "type", "workspaceId"]);
      assert.equal(e.workspaceId, ws.id);
      assert.equal(e.skillId, a.skill.id);
      assert.equal(stream.events[2].requestId, r.requestId);
    } finally { stream.shutdown(); }
  });
});

test("(11) mark in the catalog and on cbase_skill for skills an agent wrote last — gone after the human", async () => {
  await withAgentsServer(async ({ base, ws, chat }) => {
    const human = (await request(base, "POST", `/api/workspaces/${ws.id}/skills`, { name: "grill", area: "coding", description: "Checks a plan." })).data;
    const without = skillCatalog(store.effectiveSkills(ws.id, null));
    assert.equal(without.includes(AGENTS_MARKER) || without.includes(AGENTS_SENTENCE), false, "without an agent skill neither mark nor sentence");
    const a = (await tool(base, chat.id, { action: "create", name: "till-receipt", description: "Formats a receipt." })).data;
    const including = skillCatalog(store.effectiveSkills(ws.id, null));
    assert.ok(including.includes(`- till-receipt ${AGENTS_MARKER}: Formats a receipt.`), including);
    assert.ok(including.includes("- grill: Checks a plan."), "the human's line stays without a mark");
    assert.ok(including.includes(AGENTS_SENTENCE), "the head explains the mark");
    assert.ok(including.indexOf(AGENTS_SENTENCE) < including.indexOf("\n- "), "the sentence stands BEFORE the list");
    const l = await read(base, chat.id, "till-receipt");
    assert.equal(l.ofAgent, true);
    assert.match(l.hint, /no human/);
    assert.equal("ofAgent" in (await read(base, chat.id, "grill")), false);
    // The human changes the skill ⇒ mark gone; if they undo the change it stands again (the latest VALID change counts).
    const put = await request(base, "PUT", `/api/workspaces/${ws.id}/skills/${a.skill.id}`, { description: "Formats a till receipt." });
    assert.equal(put.status, 200, JSON.stringify(put.data));
    assert.equal(skillCatalog(store.effectiveSkills(ws.id, null)).includes(AGENTS_MARKER), false, "after the human no mark");
    assert.equal("ofAgent" in (await read(base, chat.id, "till-receipt")), false);
    const recent = store.skillHistoryList(ws.id, { skillId: a.skill.id })[0];
    assert.equal((await request(base, "POST", `/api/skill-history/${recent.id}/revert`)).status, 200);
    assert.ok(skillCatalog(store.effectiveSkills(ws.id, null)).includes(`- till-receipt ${AGENTS_MARKER}:`), "undone ⇒ the agent again");
    // In the run too: the system prompt of the chat carries the same calculation (runs/do-run.js → skillCatalog) — a fake turn is
    // not enough for the bytes; the function is the one place, both callers (do-run, agents) call it.
    assert.ok(human.id);
  });
});

test("(12) a merged request reports to each of its chats; a stale one lapses on reading with a hint", async () => {
  await withAgentsServer(async ({ base, ws, chat }) => {
    const second = await newChat(base, ws);
    const a = (await tool(base, chat.id, { action: "create", name: "old", guide: "x" })).data;
    const r1 = (await tool(base, chat.id, { action: "erase", id: a.skill.id, version: a.skill.version })).data;
    const r2 = (await tool(base, second.id, { action: "erase", id: a.skill.id, version: a.skill.version })).data;
    assert.equal(r2.requestId, r1.requestId);
    assert.equal(r2.merged, true);
    assert.equal((await tool(base, second.id, { action: "erase", id: a.skill.id, version: a.skill.version })).data.requestId, r1.requestId, "the same chat twice");
    assert.deepEqual(store.skillRequest(r1.requestId).additionalChats.map((c) => c.id), [second.id], "once per chat, never the first");
    const beforeOne = store.openHints(chat.id).length;
    const beforeTwo = store.openHints(second.id).length;
    assert.equal((await request(base, "POST", `/api/skill-requests/${r1.requestId}/decide`, { approve: false })).status, 200);
    assert.equal(store.openHints(chat.id).length, beforeOne + 1);
    assert.equal(store.openHints(second.id).length, beforeTwo + 1, "the merged chat learns the decision too");
    assert.match(store.openHints(second.id).at(-1).text, /abgelehnt/); // German T() output (uiLang de)

    // Lapse through the mutation path: both chats.
    const r3 = (await tool(base, chat.id, { action: "erase", id: a.skill.id, version: a.skill.version })).data;
    await tool(base, second.id, { action: "erase", id: a.skill.id, version: a.skill.version });
    await request(base, "PUT", `/api/workspaces/${ws.id}/skills/${a.skill.id}`, { body: "fresh" });
    assert.equal(store.skillRequest(r3.requestId).status, "expired");
    assert.match(store.openHints(second.id).at(-1).text, /verfallen/, "the lapse reaches the second chat too"); // German T() output (uiLang de)

    // Changed past the mutation path (a migration, an old release) — the request lapses on the next read.
    const v = store.getSkill(a.skill.id).version;
    const r4 = (await tool(base, chat.id, { action: "erase", id: a.skill.id, version: v })).data;
    store.updateSkill(a.skill.id, { body: "from the side" });
    const beforeN4 = store.openHints(chat.id).length;
    assert.deepEqual((await request(base, "GET", `/api/workspaces/${ws.id}/skill-requests?status=open`)).data.requests, [], "the open list no longer names it");
    assert.equal((await request(base, "GET", `/api/skill-requests/${r4.requestId}`)).data.status, "expired");
    assert.equal(store.openHints(chat.id).length, beforeN4 + 1, "exactly one hint, even across two read paths");
    // Through the skill list likewise, and a skill that no longer exists.
    const b = (await tool(base, chat.id, { action: "create", name: "gone" })).data;
    const r5 = (await tool(base, chat.id, { action: "erase", id: b.skill.id, version: b.skill.version })).data;
    store.deleteSkill(b.skill.id);
    await request(base, "GET", `/api/workspaces/${ws.id}/skills?area=coding`);
    assert.equal(store.skillRequest(r5.requestId).status, "expired");
    assert.match(store.openHints(chat.id).at(-1).text, /gibt es nicht mehr/); // German T() output (uiLang de)
    // A request on an older version is not merged at the next request but lapses.
    const c = (await tool(base, chat.id, { action: "create", name: "third" })).data;
    const r6 = (await tool(base, chat.id, { action: "erase", id: c.skill.id, version: c.skill.version })).data;
    store.updateSkill(c.skill.id, { body: "different" });
    const r7 = (await tool(base, second.id, { action: "erase", id: c.skill.id, version: store.getSkill(c.skill.id).version })).data;
    assert.notEqual(r7.requestId, r6.requestId);
    assert.equal(r7.merged, undefined);
    assert.equal(store.skillRequest(r6.requestId).status, "expired");
  });
});

test("(13) the fields of the errors reach the model; a managing skill stays invisible to the agent in a name conflict", async () => {
  await withAgentsServer(async ({ base, ws, chat }) => {
    const exists = (await tool(base, chat.id, { action: "create", name: "plan", guide: "v1" })).data.skill;
    const t = Date.now();
    store.createAgent({ id: crypto.randomUUID(), workspaceId: ws.id, projectId: null, name: "Planner", skills: "plan", createdAt: t, updatedAt: t });
    const mg = oldManaging(ws, "situation"); // legacy data since the teardown (see above)
    await withMcp({ CBASE_BASE_URL: base, CBASE_CHAT_ID: chat.id, CBASE_WORKSPACE_ID: ws.id, CBASE_SKILL_WRITE: "1" }, async ({ call }) => {
      const taken = await call(WRITE, { action: "create", name: "plan" });
      assert.equal(taken.isError, true);
      assert.ok(taken.text.includes(`existing: {"id":"${exists.id}"`), taken.text);
      const kon = await call(WRITE, { action: "change", id: exists.id, version: "0000000000000000", guide: "v2" });
      assert.ok(kon.text.includes(`current: {"version":"${exists.version}"}`), kon.text);
      const ver = await call(WRITE, { action: "change", id: exists.id, version: exists.version, name: "plan-new" });
      assert.ok(/references:\n- \{"id":"[^"]+","name":"Planner","level":"workspace"\}/.test(ver.text), ver.text);
      // The name of a managing skill — taken, but without `existing` (and without its id in the text).
      const situation = await call(WRITE, { action: "create", name: "situation", level: "workspace" });
      assert.equal(situation.isError, true);
      assert.match(situation.text, /schon vergeben/); // German T() output (uiLang de)
      assert.equal(situation.text.includes(mg.id) || situation.text.includes("existing"), false, situation.text);
    });
    const ren = await tool(base, chat.id, { action: "change", id: (await tool(base, chat.id, { action: "create", name: "free" })).data.skill.id, version: store.getSkillByName(ws.id, null, "free").version, name: "situation" });
    assert.equal(ren.status, 409);
    assert.equal("existing" in ren.data, false, "also when renaming");
    // The human still sees the managing skill (the UI stays as it is).
    const m = await request(base, "POST", `/api/workspaces/${ws.id}/skills`, { name: "situation", area: "coding" });
    assert.equal(m.status, 409);
  });
});

test("(14) revertible says the same as revert; deleteProject cleans history, requests and trash of the project skills", async () => {
  await withAgentsServer(async ({ base, ws, chat }) => {
    const p = await createProject(base, ws, "Shop");
    const pc = await newChat(base, ws, { projectId: p.id });
    // Create with a reference ⇒ not revertible, without ⇒ revertible.
    const a = (await tool(base, chat.id, { action: "create", name: "rules" })).data;
    const history = async (skillId) => (await request(base, "GET", `/api/workspaces/${ws.id}/skill-history?skillId=${skillId}`)).data.entries;
    assert.equal((await history(a.skill.id))[0].revertible, true);
    const t = Date.now();
    const def = store.createAgent({ id: crypto.randomUUID(), workspaceId: ws.id, projectId: null, name: "Checker", skills: "rules", createdAt: t, updatedAt: t });
    assert.equal((await history(a.skill.id))[0].revertible, false, "a reference blocks undoing a create");
    assert.equal((await request(base, "POST", `/api/skill-history/${a.historyId}/revert`)).status, 409, "and revert says the same");
    store.deleteAgent(def.id);
    // Undo a rename: the old name is taken meanwhile ⇒ both no.
    const b = (await tool(base, chat.id, { action: "create", name: "plan" })).data;
    const ren = (await tool(base, chat.id, { action: "change", id: b.skill.id, version: b.skill.version, name: "plan-new" })).data;
    assert.equal((await history(b.skill.id))[0].revertible, true);
    await tool(base, chat.id, { action: "create", name: "plan" });
    assert.equal((await history(b.skill.id))[0].revertible, false, "the old name is taken");
    assert.equal((await request(base, "POST", `/api/skill-history/${ren.historyId}/revert`)).status, 409);
    // A deletion of a project skill whose project is gone ⇒ not revertible — the deletion path of the project cleans it up.
    const ps = (await tool(base, pc.id, { action: "create", name: "receipt" })).data;
    const dir = store.skillResourceDir(ps.skill.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.md"), "x");
    store.updateSkill(ps.skill.id, { hasResources: true });
    assert.equal((await request(base, "DELETE", `/api/projects/${p.id}/skills/${ps.skill.id}`)).status, 200);
    const deleted = (await request(base, "GET", `/api/workspaces/${ws.id}/skill-deleted`)).data.entries.find((e) => e.skillId === ps.skill.id);
    assert.equal(deleted.revertible, true);
    const bin = store.skillTrashDir(deleted.id);
    assert.ok(fs.existsSync(path.join(bin, "a.md")));
    const other = (await tool(base, pc.id, { action: "create", name: "till-two" })).data;
    await tool(base, pc.id, { action: "erase", id: other.skill.id, version: other.skill.version });
    assert.equal(store.deleteProject(ws.id, p.id), true);
    assert.equal(fs.existsSync(bin), false, "the trash folder falls with the project");
    assert.ok(!store.skillHistoryEntry(deleted.id), "the history of the project skill too");
    assert.deepEqual(store.skillRequestsList(ws.id).filter((x) => x.projectId === p.id), [], "and its requests");
    assert.ok(store.skillHistoryList(ws.id, { skillId: a.skill.id }).length, "the history of the workspace skills stays");
  });
});
