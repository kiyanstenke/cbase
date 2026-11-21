// Order of the areas and the one-time migration "skills back to coding".
//
// Formerly a skill carried two independent marks (coding, managing — also both or neither), and a project saw a workspace
// skill only if it had ADOPTED it (`project_skill_enabled`, opt-in, by name). Now every skill belongs to exactly one area,
// and a workspace coding skill applies in every project until the project hides it (`project_skill_excluded`, opt-out, by id).
// store/toolchain.js arrangeSkillAreas (registered as "skills-area") does:
//   1. both marks → coding + managing copy `<name>-managing` (taken ⇒ -2, -3) with resources      ┐ at EVERY start (a rolled-back
//   2. no mark → coding                                                                           │ release writes the old pattern)
//   3. project skill only managing → workspace level, name taken ⇒ `<name>-<n>` from 2            ┘
//   4. opt-in → opt-out: every combination (project × workspace coding skill) not adopted becomes a hide ┐ ONCE
//   5. marker `migration.skills_area_optout`                                                             ┘
// Checked through `initStore` on a deposit whose old state a second (raw) connection creates — the store API can no longer
// write it (createSkill takes only one area). Plus the counter-proofs: "a second start changes nothing" (not even for a skill
// created SINCE — without the marker it would be hidden everywhere), the order after rollback and re-rollout (marker stands,
// 1–3 run, 4 does not), the transaction (if a step fails, everything stands as before), unreadable resources (the copy is
// made without, the process lives — `fs.cpSync` aborted there with SIGABRT), the copies journal and the 64-character name limit.
//
// OWN file (like migrations): `initStore` rebinds the module-wide `db`.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { db as storeDb } from "../electron/server/store/db.js";
import { validName } from "../electron/server/skills.js";

const MARKER = "migration.skills_area_optout";

// The lines a call writes to the log under "[skills]" (log, warn, error) — "log line only on a finding".
function withLog(fn) {
  const rows = [];
  const old = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(old)) console[k] = (...a) => rows.push(a.map(String).join(" "));
  try { fn(); } finally { Object.assign(console, old); }
  return rows.filter((z) => z.startsWith("[skills]"));
}

function withDeposit(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-skills-area-"));
  try {
    store.initStore(dir);
    run(dir);
  } finally {
    try { fs.chmodSync(path.join(dir, "skill-resources"), 0o755); } catch { /* did not exist */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.warn("[test] temp directory stayed behind:", String(e?.message || e).slice(0, 120)); }
  }
}

// A skill in the OLD STATE: arbitrary marks, as a release before the migration wrote them.
let counter = 0;
function oldSkill({ ws, project = null, name, coding, managing, resources = false }) {
  const id = `sk-${++counter}-${name}`;
  storeDb.prepare(`INSERT INTO skills (id, workspace_id, project_id, name, description, body, has_resources, allowed_tools, model, for_coding, for_managing, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?)`)
    .run(id, ws, project, name, `Purpose ${name}`, `Instructions ${name}`, resources ? 1 : 0, coding ? 1 : 0, managing ? 1 : 0, 1000 + counter, 2000 + counter);
  return id;
}
const takeOver = (project, name) =>
  storeDb.prepare("INSERT INTO project_skill_enabled (project_id, skill_name) VALUES (?, ?)").run(project, name);
// The deposit "before the migration": the marker gone (the fresh deposit got it at the first initStore).
const markerGone = () => storeDb.prepare("DELETE FROM app_settings WHERE key = ?").run(MARKER);
const skillsRaw = () => storeDb.prepare("SELECT * FROM skills ORDER BY id").all().map((r) => ({ ...r }));
const hides = () => storeDb.prepare(`SELECT p.name AS project, s.name AS skill FROM project_skill_excluded e
  JOIN projects p ON p.id = e.project_id JOIN skills s ON s.id = e.skill_id ORDER BY p.name, s.name`).all().map((r) => `${r.project}:${r.skill}`);
const names = (list) => list.map((s) => s.name).sort();
// The managing skills of a workspace (legacy rows of an old store, `for_managing = 1`): the migration holds its invariant.
const managingSkills = (ws) => store.listWorkspaceSkills(ws).filter((s) => s.area === "managing");

// The situation: two workspaces, three projects, all five cases.
function oldSituation(dir) {
  store.createWorkspace({ id: "w1", name: "W1", path: "/w1", createdAt: 1 });
  store.createWorkspace({ id: "w2", name: "W2", path: "/w2", createdAt: 1 });
  store.addProject("w1", { id: "p-till", name: "Shop", path: "/w1/till", createdAt: 1 });
  store.addProject("w1", { id: "p-store", name: "Storage", path: "/w1/store", createdAt: 2 });
  store.addProject("w2", { id: "p-other", name: "Other", path: "/w2/other", createdAt: 1 });
  const ids = {
    // 1. both marks — once with resources, once with a taken copy name, once on a project
    both: oldSkill({ ws: "w1", name: "both", coding: true, managing: true, resources: true }),
    duplicate: oldSkill({ ws: "w1", name: "duplicate", coding: true, managing: true }),
    duplicateManaging: oldSkill({ ws: "w1", name: "duplicate-managing", coding: true, managing: false }),
    projBoth: oldSkill({ ws: "w1", project: "p-till", name: "proj-both", coding: true, managing: true }),
    // 2. no mark
    without: oldSkill({ ws: "w1", name: "without", coding: false, managing: false }),
    // 3. project skill only managing — without and with a name clash at the workspace level (first free number from 2)
    mgrProj: oldSkill({ ws: "w1", project: "p-till", name: "mgr-proj", coding: false, managing: true }),
    collision: oldSkill({ ws: "w1", name: "collision", coding: true, managing: false }),
    collision2: oldSkill({ ws: "w1", name: "collision-2", coding: true, managing: false }),
    collisionProj: oldSkill({ ws: "w1", project: "p-store", name: "collision", coding: false, managing: true }),
    // 4. opt-in: "common" adopted in both projects
    common: oldSkill({ ws: "w1", name: "common", coding: true, managing: false }),
    onlyMgr: oldSkill({ ws: "w1", name: "only-mgr", coding: false, managing: true }),
    other: oldSkill({ ws: "w2", name: "other", coding: true, managing: false }),
  };
  takeOver("p-till", "both");
  takeOver("p-till", "common");
  takeOver("p-store", "common");
  takeOver("p-store", "collision");
  takeOver("p-store", "nonexistent"); // a leftover without a skill: does not count
  takeOver("p-other", "other");
  // Resources of the skill "both" — they go along with the managing copy.
  const res = path.join(dir, "skill-resources", ids.both, "references");
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(path.join(res, "rules.md"), "RULES");
  markerGone();
  return ids;
}

test("migration: all five cases — areas, copies, move, hides, marker", () => {
  withDeposit((dir) => {
    const ids = oldSituation(dir);
    store.initStore(dir);

    // 5. The marker stands.
    assert.match(store.getSetting(MARKER, ""), /^\d{4}-\d\d-\d\dT/);
    // Invariant: exactly one mark per skill, managing never on a project.
    for (const r of skillsRaw()) {
      assert.equal(r.for_coding + r.for_managing, 1, `${r.name}: exactly one area`);
      if (r.for_managing) assert.equal(r.project_id, null, `${r.name}: managing has no project level`);
    }

    // 1. both marks: the original stays coding (id, level, name), the copy is managing at the workspace level.
    const both = store.getSkill(ids.both);
    assert.deepEqual([both.name, both.projectId, both.area], ["both", null, "coding"]);
    const copy = store.getSkillByName("w1", null, "both-managing");
    assert.ok(copy, "the managing copy is missing");
    assert.notEqual(copy.id, ids.both, "the copy has a new id");
    assert.deepEqual([copy.area, copy.description, copy.body, copy.hasResources, copy.createdAt, copy.updatedAt],
      ["managing", both.description, both.body, true, both.createdAt, both.updatedAt], "the copy carries content and timestamps of the original");
    assert.equal(fs.readFileSync(path.join(dir, "skill-resources", copy.id, "references", "rules.md"), "utf8"), "RULES", "the resources are copied along");
    assert.ok(fs.existsSync(path.join(dir, "skill-resources", ids.both, "references", "rules.md")), "and the original keeps its own");
    assert.equal(store.getSkill(ids.duplicate).area, "coding");
    assert.equal(store.getSkillByName("w1", null, "duplicate-managing-2")?.area, "managing", "\"duplicate-managing\" was taken ⇒ -2");
    assert.equal(store.getSkill(ids.duplicateManaging).area, "coding", "the skill that held the name stays untouched");
    const projBoth = store.getSkill(ids.projBoth);
    assert.deepEqual([projBoth.projectId, projBoth.area], ["p-till", "coding"], "a project skill with both marks stays in the project");
    assert.equal(store.getSkillByName("w1", null, "proj-both-managing")?.area, "managing", "its managing copy sits at the workspace level");

    // 2. no mark → coding.
    assert.equal(store.getSkill(ids.without).area, "coding");

    // 3. project managing → workspace level, without and with a name clash (first free number from 2: "collision-2" is taken).
    const mgrProj = store.getSkill(ids.mgrProj);
    assert.deepEqual([mgrProj.name, mgrProj.projectId, mgrProj.area], ["mgr-proj", null, "managing"]);
    const collisionProj = store.getSkill(ids.collisionProj);
    assert.deepEqual([collisionProj.name, collisionProj.projectId, collisionProj.area], ["collision-3", null, "managing"]);
    assert.equal(store.getSkill(ids.collision).name, "collision", "the workspace skill keeps its name");

    // 4. Opt-in → opt-out: every combination NOT adopted is a hide — in W1 7 coding skills × 2 projects minus 4 adoptions;
    // managing skills never; W2 has its only one adopted; no combination across workspaces.
    assert.deepEqual(hides(), [
      "Shop:collision", "Shop:collision-2", "Shop:duplicate", "Shop:duplicate-managing", "Shop:without",
      "Storage:both", "Storage:collision-2", "Storage:duplicate", "Storage:duplicate-managing", "Storage:without",
    ]);

    // On the day of the migration every project chat sees the same skills as before (old: adopted coding skills + own coding skills).
    assert.deepEqual(names(store.effectiveSkills("w1", "p-till")), ["both", "common", "proj-both"]);
    assert.deepEqual(names(store.effectiveSkills("w1", "p-store")), ["collision", "common"]);
    assert.deepEqual(names(store.effectiveSkills("w2", "p-other")), ["other"]);
    // The managing skills of the workspace — the copies under their new names.
    assert.deepEqual(names(managingSkills("w1")),
      ["both-managing", "collision-3", "duplicate-managing-2", "mgr-proj", "only-mgr", "proj-both-managing"]);
    // `project_skill_enabled` stays (for a rollback) but is no longer read.
    assert.equal(storeDb.prepare("SELECT count(*) AS n FROM project_skill_enabled").get().n, 6);
  });
});

test("counter-proof: a second start changes nothing — not even for a skill or project created since", () => {
  withDeposit((dir) => {
    oldSituation(dir);
    store.initStore(dir);
    const marker = store.getSetting(MARKER, "");
    const prior = { skills: skillsRaw(), hidden: hides() };

    // After the migration: a new workspace coding skill and a new project — both without a row in project_skill_enabled. If the
    // migration ran a second time they would be hidden in EVERY project (step 4) — opt-out would turn into opt-in.
    store.createSkill({ id: "sk-new", workspaceId: "w1", name: "fresh", description: "d", body: "b", createdAt: 9, updatedAt: 9 });
    store.addProject("w1", { id: "p-new", name: "Fresh", path: "/w1/fresh", createdAt: 9 });
    const log = withLog(() => store.initStore(dir));

    assert.deepEqual(log, [], "without a finding the ordering writes no log line");
    assert.equal(store.getSetting(MARKER, ""), marker, "the marker stays as it was");
    assert.deepEqual(skillsRaw().filter((r) => r.id !== "sk-new"), prior.skills, "no skill moved");
    assert.deepEqual(hides(), prior.hidden, "no new hide");
    assert.ok(names(store.effectiveSkills("w1", "p-new")).includes("fresh"), "the new skill applies in the new project");
    assert.ok(names(store.effectiveSkills("w1", "p-till")).includes("fresh"), "and in every other");
  });
});

test("transaction: if a step fails (here step 4), everything stands as before — the resources copy is gone too — and the marker is missing; the next start catches up", () => {
  withDeposit((dir) => {
    const ids = oldSituation(dir);
    const prior = skillsRaw();
    // A database error AFTER steps 1–3 (the copy of "both" with its resources is already created by then).
    storeDb.exec("CREATE TRIGGER test_step4_fails BEFORE INSERT ON project_skill_excluded BEGIN SELECT RAISE(ABORT, 'Test: step 4 fails'); END");
    const log = withLog(() => store.initStore(dir));
    assert.ok(log.some((z) => /not put in order/.test(z) && /step 4 fails/.test(z)), `reported loudly: ${JSON.stringify(log)}`);
    assert.equal(store.getSetting(MARKER, ""), "", "without success no marker");
    assert.deepEqual(skillsRaw(), prior, "no skill half migrated");
    assert.deepEqual(hides(), [], "no hide");
    assert.deepEqual(fs.readdirSync(path.join(dir, "skill-resources")), [ids.both], "no orphaned resources copy, no journal");

    storeDb.exec("DROP TRIGGER test_step4_fails");
    store.initStore(dir);
    assert.ok(store.getSetting(MARKER, ""), "the next start migrates");
    assert.equal(hides().length, 10);
    assert.ok(store.getSkillByName("w1", null, "both-managing")?.hasResources);
  });
});

test("resources unreadable (a subfolder without permissions): the managing copy is created WITHOUT resources, the start goes on — the process lives", () => {
  withDeposit((dir) => {
    const ids = oldSituation(dir);
    const locked = path.join(dir, "skill-resources", ids.both, "references", "locked");
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, "x.md"), "x");
    fs.chmodSync(locked, 0o000);
    try {
      assert.throws(() => fs.readdirSync(locked), /EACCES/, "precondition: the folder really is unreadable (is the test running as root?)");
      // With `fs.cpSync` the whole test process ended right here (SIGABRT) — no catch, no red line, a dead run.
      const log = withLog(() => store.initStore(dir));

      assert.ok(store.getSetting(MARKER, ""), "the migration ran through");
      assert.equal(hides().length, 10, "all other steps stand");
      const copy = store.getSkillByName("w1", null, "both-managing");
      assert.deepEqual([copy?.area, copy?.hasResources], ["managing", false], "the copy stands, without resources");
      assert.ok(!fs.existsSync(path.join(dir, "skill-resources", copy.id)), "no half copy of the resources");
      assert.ok(!fs.existsSync(path.join(dir, "skill-resources", ".area-copies.json")), "no journal");
      assert.equal(store.getSkill(ids.both).hasResources, true, "the original keeps its resources");
      assert.ok(log.some((z) => /WITHOUT resources/.test(z) && /"both"/.test(z) && /EACCES/.test(z)), `reported loudly: ${JSON.stringify(log)}`);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
});

test("ordering at EVERY start: after rollback and re-rollout (marker stands) the invariant holds again — step 4 does not run once more", () => {
  withDeposit((dir) => {
    store.createWorkspace({ id: "w1", name: "W1", path: "/w1", createdAt: 1 });
    store.addProject("w1", { id: "p1", name: "Shop", path: "/w1/till", createdAt: 1 });
    store.addProject("w1", { id: "p2", name: "Storage", path: "/w1/store", createdAt: 2 });
    store.createSkill({ id: "s-new", workspaceId: "w1", name: "fresh", createdAt: 1, updatedAt: 1 });
    const marker = store.getSetting(MARKER, "");
    assert.ok(marker, "precondition: the fresh deposit carries the marker");

    // Rollback: the older release creates by ITS pattern (default both marks — also for the new web, which sends only
    // `area`), plus managing on a project, a skill without a mark and an adoption (opt-in).
    const wsBoth = oldSkill({ ws: "w1", name: "ws-both", coding: true, managing: true, resources: true });
    fs.mkdirSync(path.join(dir, "skill-resources", wsBoth), { recursive: true });
    fs.writeFileSync(path.join(dir, "skill-resources", wsBoth, "a.md"), "A");
    const projBoth = oldSkill({ ws: "w1", project: "p1", name: "proj-both", coding: true, managing: true });
    const projMgr = oldSkill({ ws: "w1", project: "p1", name: "proj-mgr", coding: false, managing: true });
    const without = oldSkill({ ws: "w1", name: "without", coding: false, managing: false });
    takeOver("p1", "ws-both");
    // The finding before the restart: the workspace skill reads as managing and is missing for the coding chat.
    assert.equal(store.getSkill(wsBoth).area, "managing");
    assert.ok(!names(store.effectiveSkills("w1", "p1")).includes("ws-both"));

    // Roll out again.
    const log = withLog(() => store.initStore(dir));
    assert.ok(log.some((z) => /ordering at start/.test(z) && /2 split/.test(z) && /1 moved to the workspace level/.test(z)), `laut gemeldet: ${JSON.stringify(log)}`);
    assert.ok(log.some((z) => /"without" carried no marker/.test(z)));
    for (const r of skillsRaw()) {
      assert.equal(r.for_coding + r.for_managing, 1, `${r.name}: exactly one area`);
      if (r.for_managing) assert.equal(r.project_id, null, `${r.name}: managing has no project level`);
    }
    assert.deepEqual([store.getSkill(wsBoth).area, store.getSkill(projBoth).area, store.getSkill(without).area], ["coding", "coding", "coding"]);
    assert.deepEqual([store.getSkill(projMgr).projectId, store.getSkill(projMgr).area], [null, "managing"], "the project managing skill sits at the workspace level");
    const copy = store.getSkillByName("w1", null, "ws-both-managing");
    assert.equal(fs.readFileSync(path.join(dir, "skill-resources", copy.id, "a.md"), "utf8"), "A", "the copy carries the resources");
    assert.deepEqual(names(store.effectiveSkills("w1", "p1")), ["fresh", "proj-both", "without", "ws-both"]);
    assert.deepEqual(names(store.effectiveSkills("w1", "p2")), ["fresh", "without", "ws-both"]);
    assert.deepEqual(names(managingSkills("w1")), ["proj-both-managing", "proj-mgr", "ws-both-managing"]);
    // Step 4 did NOT run once more: otherwise "fresh" and "without" would be hidden in both projects and "ws-both" in Storage.
    assert.deepEqual(hides(), [], "no hide from the old opt-in");
    assert.equal(store.getSetting(MARKER, ""), marker, "the marker stays as it was");

    // And afterwards quiet again: a third start finds nothing.
    const raw = skillsRaw();
    assert.deepEqual(withLog(() => store.initStore(dir)), []);
    assert.deepEqual(skillsRaw(), raw);
  });
});

test("copies journal: if the process ends in the middle of the ordering, the next start cleans exactly the copies without a skill", () => {
  withDeposit((dir) => {
    store.createWorkspace({ id: "w1", name: "W1", path: "/w1", createdAt: 1 });
    const res = path.join(dir, "skill-resources");
    const folder = (name) => { fs.mkdirSync(path.join(res, name), { recursive: true }); fs.writeFileSync(path.join(res, name, "x.md"), name); };
    const alive = crypto.randomUUID(); // the row stands (process end AFTER the commit, before the journal is deleted)
    store.createSkill({ id: alive, workspaceId: "w1", name: "alive", area: "managing", hasResources: true, createdAt: 1, updatedAt: 1 });
    folder(alive);
    const waise = crypto.randomUUID(); // the transaction rolled back, the folder stayed
    folder(waise);
    const foreign = crypto.randomUUID(); // not in the journal: no folder of this transaction, stays
    folder(foreign);
    fs.mkdirSync(path.join(dir, "outside"));
    fs.writeFileSync(path.join(res, ".area-copies.json"), JSON.stringify([waise, alive, "../outside", 7]));

    const log = withLog(() => store.initStore(dir));
    assert.ok(!fs.existsSync(path.join(res, waise)), "the orphan is cleaned");
    assert.ok(fs.existsSync(path.join(res, alive, "x.md")), "a copy with a skill stays");
    assert.ok(fs.existsSync(path.join(res, foreign, "x.md")), "a folder outside the journal stays");
    assert.ok(fs.existsSync(path.join(dir, "outside")), "no entry leads out of the resources folder");
    assert.ok(!fs.existsSync(path.join(res, ".area-copies.json")), "the journal is gone");
    assert.deepEqual(log, ["[skills] 1 orphaned resource copy/copies of an aborted ordering cleaned up"]);
  });
});

test("names of the ordering stay valid: at most 64 characters (skills.js validName), cut at the stem, no \"--\" at the cut", () => {
  withDeposit((dir) => {
    store.createWorkspace({ id: "w1", name: "W1", path: "/w1", createdAt: 1 });
    store.addProject("w1", { id: "p1", name: "Shop", path: "/w1/till", createdAt: 1 });
    const a60 = "a".repeat(60);                                 // + "-managing" = 69
    const a61 = `${"a".repeat(58)}-zz`;                          // cut gives the same stem as a60 ⇒ collision ⇒ "-managing-2"
    const b64 = `${"b".repeat(54)}-${"c".repeat(9)}`;            // the cut after 55 characters falls on the hyphen
    const d64 = "d".repeat(64);
    for (const name of [a60, a61, b64, d64]) assert.ok(validName(name), `precondition: ${name} is valid`);
    oldSkill({ ws: "w1", name: a60, coding: true, managing: true });
    oldSkill({ ws: "w1", name: a61, coding: true, managing: true });
    oldSkill({ ws: "w1", name: b64, coding: true, managing: true });
    oldSkill({ ws: "w1", name: d64, coding: true, managing: false });
    oldSkill({ ws: "w1", project: "p1", name: d64, coding: false, managing: true }); // step 3, name taken ⇒ "-2"
    store.initStore(dir);

    const managing = names(managingSkills("w1"));
    assert.deepEqual(managing, [
      `${"a".repeat(53)}-managing-2`,
      `${"a".repeat(55)}-managing`,
      `${"b".repeat(54)}-managing`,
      `${"d".repeat(62)}-2`,
    ].sort());
    for (const r of skillsRaw()) assert.ok(validName(r.name), `${r.name} (${r.name.length} characters) is a valid skill name`);
  });
});

test("hiddenIn: projects by name as elsewhere in the server (localeCompare \"de\", same-named by id) — not binary", () => {
  withDeposit(() => {
    store.createWorkspace({ id: "w1", name: "W1", path: "/w1", createdAt: 1 });
    const projects = [["p-z", "zeta"], ["p-ae", "Ärzte"], ["p-g2", "Same"], ["p-b", "beta"], ["p-a", "Alpha"], ["p-g1", "Same"]];
    for (const [id, name] of projects) store.addProject("w1", { id, name, path: `/w1/${id}`, createdAt: 1 });
    store.createSkill({ id: "s", workspaceId: "w1", name: "s", createdAt: 1, updatedAt: 1 });
    for (const [id] of projects) store.setSkillExcluded(id, "s", true);
    assert.deepEqual(store.skillHides("w1").get("s"), [
      { id: "p-a", name: "Alpha" }, { id: "p-ae", name: "Ärzte" }, { id: "p-b", name: "beta" },
      { id: "p-g1", name: "Same" }, { id: "p-g2", name: "Same" }, { id: "p-z", name: "zeta" },
    ]);
  });
});

test("hiding: by id, deletion paths clean up with it (skill, project), managing can never be hidden", () => {
  withDeposit(() => {
    store.createWorkspace({ id: "w1", name: "W1", path: "/w1", createdAt: 1 });
    store.addProject("w1", { id: "p1", name: "Shop", path: "/w1/till", createdAt: 1 });
    store.addProject("w1", { id: "p2", name: "Storage", path: "/w1/store", createdAt: 2 });
    store.createSkill({ id: "s-a", workspaceId: "w1", name: "a", createdAt: 1, updatedAt: 1 });
    store.createSkill({ id: "s-b", workspaceId: "w1", name: "b", createdAt: 1, updatedAt: 1 });
    store.createSkill({ id: "s-m", workspaceId: "w1", name: "m", area: "managing", createdAt: 1, updatedAt: 1 });

    // Opt-out: without a hide every workspace coding skill applies in every project.
    assert.deepEqual(names(store.effectiveSkills("w1", "p1")), ["a", "b"]);
    store.setSkillExcluded("p1", "s-a", true);
    assert.deepEqual(names(store.effectiveSkills("w1", "p1")), ["b"]);
    assert.deepEqual(names(store.effectiveSkills("w1", "p2")), ["a", "b"], "the hide applies only in its project");
    assert.deepEqual(names(store.effectiveSkills("w1", null)), ["a", "b"], "the workspace chat still sees everything");
    assert.deepEqual(store.wsSkillsInProject("p1").map((s) => [s.name, s.enabled]), [["a", false], ["b", true]], "managing is not in the project view");
    assert.deepEqual(store.skillHides("w1").get("s-a"), [{ id: "p1", name: "Shop" }]);

    // The project skill wins on the same name (A4) — also against a hidden one.
    store.createSkill({ id: "s-pa", workspaceId: "w1", projectId: "p2", name: "a", createdAt: 1, updatedAt: 1 });
    assert.equal(store.effectiveSkills("w1", "p2").find((s) => s.name === "a").id, "s-pa");

    // Showing again takes the row back; hiding twice stays ONE row.
    store.setSkillExcluded("p1", "s-b", true);
    store.setSkillExcluded("p1", "s-b", true);
    assert.deepEqual([...store.listExcludedSkillIds("p1")].sort(), ["s-a", "s-b"]);
    store.setSkillExcluded("p1", "s-b", false);
    assert.deepEqual([...store.listExcludedSkillIds("p1")], ["s-a"]);

    // Deletion paths: the skill takes its hides along, the project its own.
    store.setSkillExcluded("p2", "s-b", true);
    store.deleteSkill("s-a");
    assert.deepEqual([...store.listExcludedSkillIds("p1")], []);
    assert.deepEqual([...store.listExcludedSkillIds("p2")], ["s-b"]);
    store.deleteProject("w1", "p2");
    assert.equal(storeDb.prepare("SELECT count(*) AS n FROM project_skill_excluded").get().n, 0);

    // Input of the old marks throws — a caller who meant managing would otherwise silently get coding.
    assert.throws(() => store.createSkill({ id: "x", workspaceId: "w1", name: "x", forManaging: true, createdAt: 1, updatedAt: 1 }), /`area`/);
    assert.throws(() => store.createSkill({ id: "y", workspaceId: "w1", name: "y", area: "both", createdAt: 1, updatedAt: 1 }), /unknown area/);
    assert.throws(() => store.createSkill({ id: "z", workspaceId: "w1", projectId: "p1", name: "z", area: "managing", createdAt: 1, updatedAt: 1 }), /no project level/);
  });
});
