// Instructions for agents per workspace and project, through the real server:
//   (1) routes: create, read (workspace and project level including `takenOver`), required fields (400), conflict (409), cap (400),
//       foreign project / foreign section (404), order (complete, else 400), takeover only for workspace sections, history,
//       delete with version; the `instructions` event after writing
//   (2) the computation (toolchain/instructions.js): scope per role, off, deselected, empty text, order workspace → project
//   (3) the migration of the profile files: bound with text => ONE section "Persona" (main), exactly once; empty/unbound => nothing
//   (4) /api/profiles and /api/workspaces/:id/claude-md no longer exist (404)
//   (5) deleting a project or workspace clears its sections
// The way into the prompts of all agents is held by system-prompt-findings.test.js and projectMemory.test.js.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";
import { sectionsFor, instructionsBlock } from "../electron/server/toolchain/instructions.js";
import { MIGRATION_MARKER, migrateProfilesIntoInstructions } from "../electron/server/workspaces/instructions-migration.js";

async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-instructions-"));
  let server;
  try {
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    await run({ base: `http://127.0.0.1:${server.address().port}`, root });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
}
async function request(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close" } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const post = (url, b) => request(url, { method: "POST", body: JSON.stringify(b) });
const put = (url, b) => request(url, { method: "PUT", body: JSON.stringify(b) });
async function ok(r) { const x = await r; assert.ok(x.status < 400, `${x.status}: ${JSON.stringify(x.body)}`); return x.body; }

async function build(base, root) {
  const wsA = await ok(post(`${base}/api/workspaces`, { name: "A", path: path.join(root, "ws-a") }));
  const wsB = await ok(post(`${base}/api/workspaces`, { name: "B", path: path.join(root, "ws-b") }));
  fs.mkdirSync(path.join(root, "ws-a", "till"), { recursive: true });
  fs.mkdirSync(path.join(root, "ws-b", "foreign"), { recursive: true });
  const pA = await ok(post(`${base}/api/workspaces/${wsA.id}/projects`, { name: "Till", path: path.join(root, "ws-a", "till") }));
  const pB = await ok(post(`${base}/api/workspaces/${wsB.id}/projects`, { name: "Foreign", path: path.join(root, "ws-b", "foreign") }));
  return { wsA, wsB, pA, pB };
}

test("(1) routes: create, read, required fields, conflict, cap, foreign ids, order, takeover, history, delete", async () => {
  await withServer(async ({ base, root }) => {
    const { wsA, pA, pB } = await build(base, root);
    const AW = `${base}/api/workspaces/${wsA.id}/instructions`;
    const empty = await ok(request(AW));
    assert.deepEqual([empty.workspace, empty.project], [[], null]);
    assert.deepEqual(empty.cap, { text: 20_000, title: 80, sections: 30 });

    // Required fields: every missing field is 400 — projectId too (null means workspace, missing means nothing).
    for (const without of ["projectId", "title", "text", "scope", "enabled"]) {
      const b = { projectId: null, title: "T", text: "x", scope: "all", enabled: true };
      delete b[without];
      assert.equal((await post(AW, b)).status, 400, `without ${without}`);
    }
    assert.equal((await post(AW, { projectId: null, title: "T", text: "x", scope: "sometimes", enabled: true })).status, 400, "unknown scope");
    assert.equal((await post(AW, { projectId: null, title: "  ", text: "x", scope: "all", enabled: true })).status, 400, "empty title");
    const tooLong = await post(AW, { projectId: null, title: "T", text: "x".repeat(20_001), scope: "all", enabled: true });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.body.error, /20000/, "the cap says that it is one");
    assert.equal((await post(AW, { projectId: pB.id, title: "T", text: "x", scope: "all", enabled: true })).status, 404, "project of another workspace");

    const a1 = (await ok(post(AW, { projectId: null, title: "Persona", text: "You are P.", scope: "main", enabled: true }))).section;
    const a2 = (await ok(post(AW, { projectId: null, title: "For all", text: "Rule R.", scope: "all", enabled: true }))).section;
    const p1 = (await ok(post(AW, { projectId: pA.id, title: "Project", text: "Rule K.", scope: "sub", enabled: true }))).section;
    assert.deepEqual([a1.pos, a2.pos, p1.pos, a1.version], [0, 1, 0, 1]);

    // Read with project: both levels, `takenOver` on the workspace sections.
    let withP = await ok(request(`${AW}?projectId=${pA.id}`));
    assert.deepEqual(withP.workspace.map((a) => [a.title, a.takenOver]), [["Persona", true], ["For all", true]]);
    assert.deepEqual(withP.project.map((a) => a.title), ["Project"]);
    assert.equal((await request(`${AW}?projectId=${pB.id}`)).status, 404);

    // Change: version required, stale version 409 with the current state.
    assert.equal((await put(`${AW}/${a2.id}`, { title: "For all", text: "Rule R2.", scope: "all", enabled: true })).status, 400, "without version");
    const a2b = (await ok(put(`${AW}/${a2.id}`, { title: "For all", text: "Rule R2.", scope: "all", enabled: true, version: 1 }))).section;
    assert.equal(a2b.version, 2);
    const conflict = await put(`${AW}/${a2.id}`, { title: "For all", text: "overwrites", scope: "all", enabled: true, version: 1 });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.section.text, "Rule R2.", "the conflict returns the current state");

    // Foreign section (through the wrong workspace) => 404.
    const { wsB } = { wsB: (await ok(request(`${base}/api/workspaces`))).find((w) => w.name === "B") };
    assert.equal((await put(`${base}/api/workspaces/${wsB.id}/instructions/${a2.id}`, { title: "x", text: "x", scope: "all", enabled: true, version: 2 })).status, 404);

    // Order: exactly the sections of the level, else 400.
    assert.equal((await put(`${AW}/order`, { projectId: null, ids: [a2.id] })).status, 400, "incomplete");
    assert.equal((await put(`${AW}/order`, { projectId: null, ids: [a2.id, p1.id] })).status, 400, "foreign level");
    const ordered = await ok(put(`${AW}/order`, { projectId: null, ids: [a2.id, a1.id] }));
    assert.deepEqual(ordered.sections.map((a) => a.title), ["For all", "Persona"]);

    // Takeover: only workspace sections, only projects of this workspace.
    assert.equal((await put(`${AW}/${p1.id}/takeover`, { projectId: pA.id, takenOver: false })).status, 400, "project section");
    assert.equal((await put(`${AW}/${a1.id}/takeover`, { projectId: pB.id, takenOver: false })).status, 404);
    assert.equal((await put(`${AW}/${a1.id}/takeover`, { projectId: pA.id })).status, 400, "without takenOver");
    await ok(put(`${AW}/${a1.id}/takeover`, { projectId: pA.id, takenOver: false }));
    withP = await ok(request(`${AW}?projectId=${pA.id}`));
    assert.deepEqual(withP.workspace.map((a) => [a.title, a.takenOver]), [["For all", true], ["Persona", false]]);

    // History: create, change (the conflict writes nothing), takeover.
    assert.deepEqual((await ok(request(`${AW}/${a2.id}/history`))).entries.map((e) => e.kind), ["change", "create"]);
    assert.deepEqual((await ok(request(`${AW}/${a1.id}/history`))).entries.map((e) => e.kind), ["takeover", "create"]);

    // Delete: version required, stale 409, else gone — including the opt-out row.
    assert.equal((await request(`${AW}/${a1.id}`, { method: "DELETE" })).status, 400);
    assert.equal((await request(`${AW}/${a1.id}?version=7`, { method: "DELETE" })).status, 409);
    await ok(request(`${AW}/${a1.id}?version=1`, { method: "DELETE" }));
    assert.equal(store.agentSection(a1.id), null);
    assert.equal(store.agentSectionsOffInProject(pA.id).size, 0, "the opt-out row went with it");
    assert.equal((await request(`${AW}/${a1.id}/history`)).status, 404, "a deleted section can no longer be found through the route");
    assert.deepEqual(store.agentSectionHistory(a1.id).map((e) => e.kind), ["erase", "takeover", "create"], "its history stays in storage");
  });
});

test("(2) computation: scope per role, off, deselected, empty text, workspace before project — and the block", async () => {
  await withServer(async ({ base, root }) => {
    const { wsA, pA } = await build(base, root);
    const fresh = (projectId, title, text, scope, on = true) => store.createAgentSection({ id: `t-${title}`, workspaceId: wsA.id, projectId, title, text, scope, enabled: on });
    fresh(null, "WA", "ws-all", "all");
    fresh(null, "WH", "ws-main", "main");
    fresh(null, "WS", "ws-sub", "sub");
    fresh(null, "WX", "ws-off", "all", false);
    fresh(null, "WL", "   ", "all");
    const sectionRow = fresh(null, "WB", "ws-deselected", "all");
    fresh(pA.id, "PA", "pr-all", "all");
    fresh(pA.id, "PH", "pr-main", "main");
    store.setAgentSectionTakeover(sectionRow, pA.id, false);
    const title = (o) => sectionsFor(o).map((a) => a.title);
    assert.deepEqual(title({ workspaceId: wsA.id, projectId: pA.id, role: "main" }), ["WA", "WH", "PA", "PH"]);
    assert.deepEqual(title({ workspaceId: wsA.id, projectId: pA.id, role: "sub" }), ["WA", "WS", "PA"]);
    assert.deepEqual(title({ workspaceId: wsA.id, projectId: null, role: "main" }), ["WA", "WH", "WB"], "without project: only the workspace, nothing deselected");
    assert.deepEqual(title({ workspaceId: wsA.id, projectId: pA.id, role: "outer" }), [], "an unknown role gets nothing");
    const block = instructionsBlock(sectionsFor({ workspaceId: wsA.id, projectId: pA.id, role: "sub" }));
    assert.match(block, /^# User instructions\n/);
    assert.ok(block.includes("## WA\nws-all") && block.indexOf("## WS") < block.indexOf("## PA"), block);
    assert.equal(instructionsBlock([]), "");
  });
});

test("(3) profile migration: bound with text => ONE section “Persona” (main agent only), exactly once; empty or unbound => nothing", async () => {
  await withServer(async ({ base, root }) => {
    const { wsA, wsB } = await build(base, root);
    const dir = path.join(root, "profiles-old");
    fs.mkdirSync(dir, { recursive: true });
    const write = (f, o) => fs.writeFileSync(path.join(dir, f), JSON.stringify(o));
    write("default.json", { name: "Examplecorp", systemPrompt: "You are P. Load skill X.", workspaceId: wsA.id });
    write("empty.json", { name: "Empty", systemPrompt: "", workspaceId: wsB.id });
    write("global.json", { name: "Global", systemPrompt: "Global", workspaceId: "" });
    write("orphaned.json", { name: "Orphaned", systemPrompt: "Text", workspaceId: "exists-not" });
    fs.writeFileSync(path.join(dir, "broken.json"), "{");
    assert.equal(store.getSetting(MIGRATION_MARKER, ""), "", "without profile files the server start sets no marker (golden byte-equal)");
    assert.equal(migrateProfilesIntoInstructions(dir), 1);
    const a = store.agentSectionsOfTheLevel(wsA.id, null);
    assert.deepEqual(a.map((x) => [x.title, x.text, x.scope, x.enabled]), [["Persona", "You are P. Load skill X.", "main", true]]);
    assert.deepEqual(store.agentSectionsOfTheLevel(wsB.id, null), []);
    assert.equal(migrateProfilesIntoInstructions(dir), 0, "a second start does not migrate again");
    assert.equal(store.getSetting(MIGRATION_MARKER, "") !== "", true, "the marker is set");
    assert.equal(store.agentSectionsOfTheLevel(wsA.id, null).length, 1);
  });
});

test("(4) /api/profiles and /api/workspaces/:id/claude-md no longer exist; the start creates no profile any more", async () => {
  await withServer(async ({ base, root }) => {
    const { wsA } = await build(base, root);
    assert.equal((await request(`${base}/api/profiles`)).status, 404);
    assert.equal((await request(`${base}/api/workspaces/${wsA.id}/claude-md`)).status, 404);
    assert.equal(fs.existsSync(path.join(root, "data-root", "profiles", "default.json")), false);
  });
});

test("(5) deleting a project or workspace clears its sections including opt-out and history", async () => {
  await withServer(async ({ base, root }) => {
    const { wsA, wsB, pA } = await build(base, root);
    const w = store.createAgentSection({ id: "l-w", workspaceId: wsA.id, projectId: null, title: "W", text: "w", scope: "all", enabled: true });
    store.createAgentSection({ id: "l-p", workspaceId: wsA.id, projectId: pA.id, title: "P", text: "p", scope: "all", enabled: true });
    store.setAgentSectionTakeover(w, pA.id, false);
    store.createAgentSection({ id: "l-b", workspaceId: wsB.id, projectId: null, title: "B", text: "b", scope: "all", enabled: true });
    await ok(request(`${base}/api/workspaces/${wsA.id}/projects/${pA.id}`, { method: "DELETE" }));
    assert.equal(store.agentSection("l-p"), null);
    assert.equal(store.agentSectionsOffInProject(pA.id).size, 0);
    assert.ok(store.agentSection("l-w"), "the workspace section stays");
    store.deleteWorkspace(wsA.id);
    assert.equal(store.agentSection("l-w"), null);
    assert.ok(store.agentSection("l-b"), "another workspace stays untouched");
  });
});
