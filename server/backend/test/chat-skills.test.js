// The skills of THIS chat — the list behind the slash picker in the composer.
//
// The picker in the composer shows two kinds: the client-side slash commands (the client knows those itself) and the SKILLS that
// are effective for exactly this chat. The latter are a server answer, because which set applies is decided by the scope: a
// workspace chat sees workspace skills plus those of ALL projects, a project chat its own plus the workspace Coding skills it has
// not hidden (opt-out).
//
// This route must not drift from what a RUN materialises: both ask `store.effectiveSkills`. Exactly that is what the third
// claim checks — a second calculation in the picker would be a list promising something other than the agent can do afterwards.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import crypto from "node:crypto";

import { startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";

async function json(url, init) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-chat-skills-"));
  let server;
  try {
    const wsPath = path.join(root, "workspace");
    const projPath = path.join(wsPath, "till");
    fs.mkdirSync(projPath, { recursive: true });
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const base = `http://127.0.0.1:${server.address().port}`;
    const workspace = (await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Test", path: wsPath }) })).body;
    const project = (await json(`${base}/api/workspaces/${workspace.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Checkout", path: projPath }) })).body;
    await run({ base, workspace, project });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(root, { recursive: true, force: true }); }
    catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }
  }
}

// The workspace level requires no department; a missing field means Coding (default here: explicitly coding). A project skill is
// always Coding.
const skill = (base, scope, id, name, description, area = scope === "workspaces" ? "coding" : undefined) =>
  json(`${base}/api/${scope}/${id}/skills`, { method: "POST", body: JSON.stringify({ name, description, body: "Do something.", ...(area ? { area } : {}) }) });
// A managing skill is only legacy stock: no way creates it, so the test puts it into the store — as it stands in an old
// database.
const oldManaging = (workspace, name, description = "Managing.") => {
  const t = Date.now();
  return store.createSkill({ id: crypto.randomUUID(), workspaceId: workspace.id, name, description, body: "Do something.", area: "managing", createdAt: t, updatedAt: t });
};

test("slash picker: the workspace chat sees workspace skills AND those of the projects, with origin", async () => {
  await withServer(async ({ base, workspace, project }) => {
    await skill(base, "workspaces", workspace.id, "grill", "Puts a plan to the test.");
    await skill(base, "projects", project.id, "receipt", "Formats a receipt.");

    const chat = (await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: workspace.id }) })).body;
    const { status, body } = await json(`${base}/api/chats/${chat.id}/skills`);
    assert.equal(status, 200);

    const byName = Object.fromEntries(body.map((s) => [s.name, s]));
    assert.deepEqual(Object.keys(byName).sort(), ["grill", "receipt"]);
    // The description is the whole purpose of the picker — without it the list would be a column of names.
    assert.equal(byName.grill.description, "Puts a plan to the test.");
    // Origin: a project skill in the workspace chat says which project it comes from.
    assert.equal(byName.receipt.originProject, "Checkout");
    assert.equal(byName.grill.originProject, "");
    // The picker writes "/name" — no field may contaminate the name.
    assert.match(byName.receipt.name, /^[a-z0-9][a-z0-9-]*$/);
  });
});

test("slash picker: the project chat is isolated — foreign projects are missing, hiding works (opt-out)", async () => {
  await withServer(async ({ base, workspace, project }) => {
    const secondPath = path.join(path.dirname(project.path), "warehouse");
    fs.mkdirSync(secondPath, { recursive: true });
    const second = (await json(`${base}/api/workspaces/${workspace.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Warehouse", path: secondPath }) })).body;

    const grill = (await skill(base, "workspaces", workspace.id, "grill", "Puts a plan to the test.")).body;
    await skill(base, "projects", project.id, "receipt", "Formats a receipt.");
    await skill(base, "projects", second.id, "stocktake", "Counts stock.");

    const chat = (await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: workspace.id, projectId: project.id }) })).body;

    // Without doing anything: the own skill AND the workspace skill (opt-out) — the foreign project skill cannot be chosen at all.
    const including = await json(`${base}/api/chats/${chat.id}/skills`);
    assert.deepEqual(including.body.map((s) => s.name).sort(), ["grill", "receipt"]);
    assert.ok(!including.body.some((s) => s.name === "stocktake"), "a foreign project skill must not show up in the project chat");

    // Hidden (by id) the workspace skill drops out — only in THIS project.
    assert.deepEqual((await json(`${base}/api/projects/${project.id}/workspace-skills/${grill.id}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: false }) })).body, { ok: true });
    assert.deepEqual((await json(`${base}/api/chats/${chat.id}/skills`)).body.map((s) => s.name), ["receipt"]);
    const secondChat = (await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: workspace.id, projectId: second.id }) })).body;
    assert.deepEqual((await json(`${base}/api/chats/${secondChat.id}/skills`)).body.map((s) => s.name).sort(), ["grill", "stocktake"]);

    // Shown again it is back.
    await json(`${base}/api/projects/${project.id}/workspace-skills/${grill.id}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
    assert.deepEqual((await json(`${base}/api/chats/${chat.id}/skills`)).body.map((s) => s.name).sort(), ["grill", "receipt"]);
  });
});

test("slash picker: the list is the same calculation a run materialises", async () => {
  await withServer(async ({ base, workspace, project }) => {
    const grill = (await skill(base, "workspaces", workspace.id, "grill", "Puts a plan to the test.")).body;
    await skill(base, "workspaces", workspace.id, "check", "Checks.");
    await skill(base, "projects", project.id, "receipt", "Formats a receipt.");
    await json(`${base}/api/projects/${project.id}/workspace-skills/${grill.id}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    for (const projectId of [null, project.id]) {
      const chat = (await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: workspace.id, projectId }) })).body;
      const route = (await json(`${base}/api/chats/${chat.id}/skills`)).body.map((s) => s.name).sort();
      // Exactly what doRun materialises for this chat (runs/do-run.js → toolchain/skill-catalog.js:chatSkills → store.effectiveSkills).
      const run = store.effectiveSkills(workspace.id, projectId).map((s) => s.name).sort();
      assert.deepEqual(route, run, `projectId ${projectId}`);
    }
  });
});

test("slash picker: a workspace without skills returns an empty list, no error", async () => {
  await withServer(async ({ base, workspace }) => {
    // The empty case is no edge case: that is what EVERY fresh workspace looks like, and the picker must show the plain command
    // list there instead of an error message or nothing.
    const chat = (await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: workspace.id }) })).body;
    const { status, body } = await json(`${base}/api/chats/${chat.id}/skills`);
    assert.equal(status, 200);
    assert.deepEqual(body, []);
  });
});

// ── One department: Coding ──────────────────────────────────────────────────────────────────────
//
// A skill used to carry two independent marks (Coding, Managing), later it belonged to EXACTLY ONE department. With the managing
// teardown only Coding remains: a missing `area` means Coding, `managing` is a 400 on every route, and an old managing skill
// (legacy stock) is in no list, no catalog and no chat. No way switches the department. The marks stand beside it in every
// answer, DERIVED (an older iOS app would not decode otherwise). It is checked at the route — what does not arrive here no client
// can set.

const ws = (base, workspace) => `${base}/api/workspaces/${workspace.id}`;

test("department when creating in the workspace: missing means Coding, managing and unknown are 400, the name is unique even against an old managing skill", async () => {
  await withServer(async ({ base, workspace }) => {
    const post = (body) => json(`${ws(base, workspace)}/skills`, { method: "POST", body: JSON.stringify({ description: "x", body: "y", ...body }) });
    for (const body of [{ area: "managing" }, { area: "both" }, { area: "coding", forManaging: true }, { forCoding: false }]) {
      assert.equal((await post({ name: "rejected", ...body })).status, 400, JSON.stringify(body));
    }
    assert.equal(store.listWorkspaceSkills(workspace.id).length, 0, "no 400 created a skill");

    const without = await post({ name: "without" });
    assert.equal(without.status, 201, "without area it is Coding");
    assert.deepEqual([without.body.area, without.body.forCoding, without.body.forManaging], ["coding", true, false]);
    const coding = await post({ name: "grill", area: "coding", forCoding: true });
    assert.equal(coding.status, 201, "a matching mark is ok");
    assert.deepEqual([coding.body.area, coding.body.forCoding, coding.body.forManaging], ["coding", true, false]);

    // One name per workspace level — an old managing skill also occupies its name.
    oldManaging(workspace, "situation");
    assert.equal((await post({ name: "grill" })).status, 409);
    assert.equal((await post({ name: "situation" })).status, 409);
  });
});

test("department: PUT never changes it — a contradicting statement is 400, a matching or missing one is not", async () => {
  await withServer(async ({ base, workspace, project }) => {
    const sk = (await skill(base, "workspaces", workspace.id, "grill", "Old.")).body;
    const put = (body, url = `${ws(base, workspace)}/skills/${sk.id}`) => json(url, { method: "PUT", body: JSON.stringify(body) });
    for (const body of [{ area: "managing" }, { forManaging: true }, { forCoding: false }, { area: "anything" }]) {
      const r = await put({ ...body, description: "Must not arrive." });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal((await json(`${ws(base, workspace)}/skills/${sk.id}`)).body.description, "Old.", "a 400 writes nothing");
    const matching = await put({ area: "coding", forCoding: true, forManaging: false, description: "New." });
    assert.equal(matching.status, 200);
    assert.deepEqual([matching.body.description, matching.body.area], ["New.", "coding"]);
    assert.equal((await put({ body: "Only the content." })).status, 200, "without a statement about the department");

    // The same rule for the project skill.
    const ps = (await skill(base, "projects", project.id, "receipt", "Project.")).body;
    assert.equal((await put({ area: "managing" }, `${base}/api/projects/${project.id}/skills/${ps.id}`)).status, 400);
    assert.equal((await put({ forCoding: true, description: "ok" }, `${base}/api/projects/${project.id}/skills/${ps.id}`)).status, 200);
  });
});

test("project level: always Coding — managing is 400, missing means Coding", async () => {
  await withServer(async ({ base, project }) => {
    const post = (body) => json(`${base}/api/projects/${project.id}/skills`, { method: "POST", body: JSON.stringify({ description: "x", body: "y", ...body }) });
    assert.equal((await post({ name: "mgr", area: "managing" })).status, 400);
    assert.equal((await post({ name: "unknown", area: "both" })).status, 400);
    assert.equal((await post({ name: "contradicting", forManaging: true })).status, 400);
    const without = await post({ name: "without" });
    assert.equal(without.status, 201);
    assert.equal(without.body.area, "coding");
    assert.equal((await post({ name: "including", area: "coding" })).status, 201);
    const list = (await json(`${base}/api/projects/${project.id}/skills`)).body;
    assert.deepEqual(list.map((s) => [s.name, s.area, s.forCoding, s.forManaging]), [["including", "coding", true, false], ["without", "coding", true, false]]);
  });
});

test("list: ?area= may be missing (Coding), managing and unknown are 400, Coding carries hiddenIn (by project name), an old managing skill is not in it", async () => {
  await withServer(async ({ base, workspace, project }) => {
    const apexPath = path.join(path.dirname(project.path), "apex");
    fs.mkdirSync(apexPath, { recursive: true });
    const apex = (await json(`${base}/api/workspaces/${workspace.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Apex", path: apexPath }) })).body;
    const grill = (await skill(base, "workspaces", workspace.id, "grill", "Coding.")).body;
    await skill(base, "workspaces", workspace.id, "check", "Coding.");
    oldManaging(workspace, "situation");
    await skill(base, "projects", project.id, "receipt", "Project.");

    for (const q of ["?area=managing", "?area=alle"]) assert.equal((await json(`${ws(base, workspace)}/skills${q}`)).status, 400, q);

    // "Checkout" was created first, "Apex" afterwards — sorted by NAME.
    for (const p of [project, apex]) {
      await json(`${base}/api/projects/${p.id}/workspace-skills/${grill.id}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    }
    const coding = (await json(`${ws(base, workspace)}/skills?area=coding`)).body;
    assert.deepEqual(coding.map((s) => s.name), ["check", "grill"], "only the workspace level, only Coding — no seeded handover skill, no old managing skill");
    assert.deepEqual((await json(`${ws(base, workspace)}/skills`)).body, coding, "without a parameter the same list");
    const byName = Object.fromEntries(coding.map((s) => [s.name, s]));
    assert.deepEqual(byName.grill.hiddenIn, [{ id: apex.id, name: "Apex" }, { id: project.id, name: "Checkout" }]);
    assert.deepEqual(byName.check.hiddenIn, []);
    assert.deepEqual([byName.grill.area, byName.grill.forCoding, byName.grill.forManaging], ["coding", true, false]);
  });
});

test("project view of the workspace skills: only Coding, opt-out, PATCH by id with 400/404", async () => {
  await withServer(async ({ base, workspace, project }) => {
    const grill = (await skill(base, "workspaces", workspace.id, "grill", "Coding.")).body;
    const situation = oldManaging(workspace, "situation");
    const own = (await skill(base, "projects", project.id, "receipt", "Project.")).body;
    const view = async () => (await json(`${base}/api/projects/${project.id}/workspace-skills`)).body;
    const patch = (id, body) => json(`${base}/api/projects/${project.id}/workspace-skills/${encodeURIComponent(id)}/enabled`, { method: "PATCH", body: JSON.stringify(body) });

    assert.deepEqual((await view()).map((s) => [s.name, s.enabled, s.area]), [["grill", true, "coding"]], "opt-out: available without doing anything; managing never");

    // 400: a non-boolean is no statement — a missing `enabled` used to silently mean "off".
    for (const body of [{}, { enabled: "false" }, { enabled: 0 }, { enabled: null }]) assert.equal((await patch(grill.id, body)).status, 400, JSON.stringify(body));
    // 404: not a workspace Coding skill of this workspace — the NAME (the old form), a managing skill, a project skill, nonsense.
    for (const id of ["grill", situation.id, own.id, "00000000-0000-4000-8000-000000000000"]) {
      assert.equal((await patch(id, { enabled: false })).status, 404, id);
    }
    assert.deepEqual((await view()).map((s) => s.enabled), [true], "none of the failures wrote");

    assert.deepEqual((await patch(grill.id, { enabled: false })).body, { ok: true });
    assert.deepEqual((await view()).map((s) => s.enabled), [false]);
    assert.deepEqual((await patch(grill.id, { enabled: true })).body, { ok: true });
    assert.deepEqual((await view()).map((s) => s.enabled), [true]);
  });
});

test("department in the chat: a Coding chat sees Coding skills of the workspace and the projects, never an old managing skill; an old manager chat sees nothing", async () => {
  await withServer(async ({ base, workspace, project }) => {
    await skill(base, "workspaces", workspace.id, "grill", "Coding.");
    oldManaging(workspace, "situation");
    await skill(base, "projects", project.id, "receipt", "Project.");

    const chat = (await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: workspace.id }) })).body;
    assert.deepEqual((await json(`${base}/api/chats/${chat.id}/skills`)).body.map((s) => s.name).sort(), ["grill", "receipt"]);

    // A manager chat is only legacy stock (no way creates it): its catalog is empty, although the workspace holds a Coding AND an
    // old managing skill.
    const t = Date.now();
    const mgr = store.createChat({ id: crypto.randomUUID(), workspaceId: workspace.id, kind: "manager", title: "Situation", provider: "claude", model: "", createdAt: t, updatedAt: t });
    assert.deepEqual((await json(`${base}/api/chats/${mgr.id}/skills`)).body, []);
  });
});

test("effective-skills: always Coding — the old parameter area=managing is ignored", async () => {
  await withServer(async ({ base, workspace }) => {
    oldManaging(workspace, "situation");
    await skill(base, "workspaces", workspace.id, "grill", "Coding.");

    const coding = (await json(`${ws(base, workspace)}/effective-skills`)).body;
    assert.deepEqual(coding.map((s) => s.name), ["grill"], "without area Coding applies — the normal case of this route");
    assert.equal(coding[0].area, "coding");
    assert.deepEqual((await json(`${ws(base, workspace)}/effective-skills?area=managing`)).body, coding, "area=managing returns the same");
  });
});

// ── The cost line: GET …/skill-catalog ──────────────────────────────────────────────────────────
// The same calculation as the catalog in the system prompt — checked against the REAL prompt of a run in skills-way.test.js;
// here the levels, the error cases and that the number falls with a hiding.
test("skill-catalog: count and tokens per level — workspace, project with hiding; missing means Coding, managing is 400, 404 for a foreign project", async () => {
  await withServer(async ({ base, workspace, project }) => {
    const catalog = async (q) => json(`${ws(base, workspace)}/skill-catalog${q}`);
    assert.deepEqual((await catalog("?area=coding")).body, { count: 0, token: 0 }, "an empty catalog costs nothing");
    for (const q of ["?area=managing", "?area=alle"]) assert.equal((await catalog(q)).status, 400, q);

    const grill = (await skill(base, "workspaces", workspace.id, "grill", "Puts a plan to the test.")).body;
    await skill(base, "workspaces", workspace.id, "check", "Checks step by step.");
    oldManaging(workspace, "situation", "The situation of the workspace.");
    await skill(base, "projects", project.id, "receipt", "Formats a receipt.");

    const wsLevel = (await catalog("?area=coding")).body;
    assert.equal(wsLevel.count, 3, "workspace level: what a workspace chat gets — workspace + all projects, no old managing skill");
    assert.deepEqual((await catalog("")).body, wsLevel, "without a parameter the same count");
    assert.ok(wsLevel.token > 0);
    const projPrior = (await catalog(`?area=coding&projectId=${project.id}`)).body;
    assert.equal(projPrior.count, 3);
    await json(`${base}/api/projects/${project.id}/workspace-skills/${grill.id}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    const projAfter = (await catalog(`?area=coding&projectId=${project.id}`)).body;
    assert.equal(projAfter.count, 2, "project level: own + not hidden");
    assert.ok(projAfter.token < projPrior.token, "the cost falls with the hiding");
    assert.deepEqual((await catalog("?area=coding")).body, wsLevel, "the workspace level stays");

    // A project of ANOTHER workspace would mix foreign skills into the count.
    const foreignPath = fs.mkdtempSync(path.join(path.dirname(path.dirname(project.path)), "foreign-"));
    const foreignWs = (await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Foreign", path: foreignPath }) })).body;
    fs.mkdirSync(path.join(foreignPath, "p"), { recursive: true });
    const foreignProject = (await json(`${base}/api/workspaces/${foreignWs.id}/projects`, { method: "POST", body: JSON.stringify({ name: "P", path: path.join(foreignPath, "p") }) })).body;
    assert.equal((await catalog(`?area=coding&projectId=${foreignProject.id}`)).status, 404);
    assert.equal((await catalog("?area=coding&projectId=exists-not")).status, 404);
  });
});

test("the /skills page is gone: GET /api/skills is 404", async () => {
  await withServer(async ({ base }) => {
    assert.equal((await json(`${base}/api/skills`)).status, 404);
  });
});

test("delete paths: a deleted workspace skill takes its hidings along, a deleted project its own", async () => {
  await withServer(async ({ base, workspace, project }) => {
    const a = (await skill(base, "workspaces", workspace.id, "a", "A.")).body;
    const b = (await skill(base, "workspaces", workspace.id, "b", "B.")).body;
    for (const s of [a, b]) await json(`${base}/api/projects/${project.id}/workspace-skills/${s.id}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    assert.deepEqual([...store.listExcludedSkillIds(project.id)].sort(), [a.id, b.id].sort());
    assert.equal((await json(`${ws(base, workspace)}/skills/${a.id}`, { method: "DELETE" })).status, 200);
    assert.deepEqual([...store.listExcludedSkillIds(project.id)], [b.id]);
    assert.equal((await json(`${base}/api/projects/${project.id}`, { method: "DELETE" })).status < 300, true);
    assert.deepEqual([...store.listExcludedSkillIds(project.id)], []);
  });
});
