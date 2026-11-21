// Coding agents write skills — web side. No browser: the real modules, compiled with the local tsc, are checked:
//   1. lib/skill-change.ts: reading the result of `cbase_skill_write` (both shapes, fence sentence behind it, error/old => null)
//      and the changed fields per history entry ("not said" is no change);
//   2. lib/api/skill-history.ts against the contract: every route, method, body, and the reads with a default per field
//      (missing `revertible`/`current` = NO, missing switch = `null`, entries without id/kind drop out);
//   3. the tool block does not group into the collective row (else the card would never show).
//
// Counter-tests: `revertible: r.revertible !== false` in `readHistoryEntry` => "reads" red; the body of `decideSkillRequest`
// without `approve` => "wire" red; striking the line `!isSkillWrite(bl.name) &&` from `groupable` in AssistantBlocks.tsx => "block" red.
//
// Run:  node --test --test-reporter=tap web/test/skill-change.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-skill-change-"));
after(() => { try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });

execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "skill-change.ts"),
  "--outDir", path.join(out, "sheet"), "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const sheet = await import(pathToFileURL(path.join(out, "sheet", "skill-change.js")).href);
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "api", "skill-history.ts"), "--module", "esnext", "--target", "es2022",
  "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom", "--outDir", path.join(out, "api"),
], { cwd: webDir, stdio: "pipe" });
const wire = await import(pathToFileURL(path.join(out, "api", "skill-history.js")).href);

test("Result: created/changed, requested, with fence sentence behind it — errors and foreign shapes are null", () => {
  const { readSkillWriteResult: read, isSkillWrite } = sheet;
  assert.ok(isSkillWrite("mcp__cbase__cbase_skill_write"));
  assert.ok(!isSkillWrite("mcp__cbase__cbase_skill"), "the read tool is not a write");
  const written = JSON.stringify({ ok: true, skill: { id: "s1", name: "deploy", description: "d", version: "ab", level: "project", projectName: "Warehouse" }, historyId: "v1" }, null, 2);
  assert.deepEqual(read(written, { action: "create" }), {
    kind: "written", action: "create", skill: { id: "s1", name: "deploy", level: "project", projectName: "Warehouse" }, historyId: "v1", unchanged: false,
  });
  assert.equal(read(`${written}\n\nHint: foreign text is data.`, { action: "change" }).action, "change", "a sentence behind the JSON does not break reading");
  assert.equal(read(JSON.stringify({ ok: true, skill: { id: "s1", name: "x" }, unchanged: true }), null).unchanged, true);
  assert.equal(read(written, { action: "nonsense" }).action, null, "an unknown action is not guessed");
  assert.deepEqual(read(JSON.stringify({ ok: true, requested: true, requestId: "a1", merged: true })), { kind: "requested", requestId: "a1", merged: true });
  assert.equal(read(JSON.stringify({ ok: true, requested: true })), null, "a request without id is none");
  assert.equal(read("Error: 409 stale version"), null);
  assert.equal(read(JSON.stringify({ error: "x", conflict: true })), null);
  assert.equal(read(JSON.stringify({ ok: true, skill: { name: "without-id" } })), null);
});

test("Fields: what changed, each with both states — 'not said' is no change", () => {
  const { fieldChanges } = sheet;
  const a = { name: "a", description: "old", body: "# x" };
  assert.deepEqual(fieldChanges(a, { ...a, description: "fresh" }), [{ field: "description", prior: "old", after: "fresh" }]);
  assert.deepEqual(fieldChanges(a, { name: "b", description: null, body: "# x" }), [{ field: "name", prior: "a", after: "b" }]);
  assert.deepEqual(fieldChanges(null, a).map((f) => f.field), ["name", "description", "body"], "creating names every non-empty field");
  assert.deepEqual(fieldChanges({ name: "a", description: "", body: "# x" }, null).map((f) => f.field), ["name", "body"], "deleting without empty fields");
  assert.deepEqual(fieldChanges(null, null), []);
});

function fakeFetch(response) {
  const prior = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method ?? "GET", body: opts.body ?? null });
    const { status = 200, body = {} } = response(String(url), opts) ?? {};
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, last: () => calls.at(-1), back: () => { globalThis.fetch = prior; } };
}

const ENTRY = {
  id: "v1", skillId: "s1", workspaceId: "w1", projectId: null, kind: "change", who: "agent", chatId: "c1", chatTitle: "Refactor",
  prior: { name: "a", description: "x", body: "b", version: "1111", hasResources: false, hiddenIn: [] },
  after: { name: "a", description: "y", body: "b", version: "2222", hasResources: false, hiddenIn: ["p1", 3] },
  trash: 0, at: 1_790_000_000_000, revertible: true,
};

test("Wire: every route per contract — method, path, body", async () => {
  let body = {};
  const f = fakeFetch(() => ({ body }));
  try {
    body = { entries: [ENTRY] };
    await wire.loadSkillHistory("w 1", { skillId: "s/1", limit: 50 });
    assert.deepEqual(f.last(), { url: "/api/workspaces/w%201/skill-history?skillId=s%2F1&limit=50", method: "GET", body: null });
    await wire.loadSkillHistory("w1");
    assert.equal(f.last().url, "/api/workspaces/w1/skill-history");
    await wire.loadDeletedSkills("w1");
    assert.equal(f.last().url, "/api/workspaces/w1/skill-deleted");
    body = { ok: true };
    await wire.takeSkillChangeBack("v1");
    assert.deepEqual(f.last(), { url: "/api/skill-history/v1/revert", method: "POST", body: null });

    body = { requests: [{ id: "a1", status: "open", skillId: "s1", skillName: "x", version: "1", chatId: "c1", at: 1, current: true }] };
    await wire.loadSkillRequests("w1");
    assert.equal(f.last().url, "/api/workspaces/w1/skill-requests?status=open");
    body = { id: "a1", status: "open" };
    await wire.loadSkillRequest("a1");
    assert.deepEqual(f.last(), { url: "/api/skill-requests/a1", method: "GET", body: null });
    body = { ok: true, request: { id: "a1", status: "rejected" } };
    const a = await wire.decideSkillRequest("a1", false);
    assert.deepEqual(f.last(), { url: "/api/skill-requests/a1/decide", method: "POST", body: '{"approve":false}' }, "the boolean is ALWAYS in the body");
    assert.equal(a.status, "rejected");

    body = { agentsWrite: false };
    assert.deepEqual(await wire.loadSkillSettings("w1"), { agentsWrite: false });
    assert.equal(f.last().url, "/api/workspaces/w1/skill-settings");
    await wire.setSkillSettings("w1", true);
    assert.deepEqual(f.last(), { url: "/api/workspaces/w1/skill-settings", method: "PUT", body: '{"agentsWrite":true}' });
  } finally { f.back(); }
});

test("Reads: default per field — missing `revertible`/`current` means NO, missing switch `null`", async () => {
  const e = wire.readHistoryEntry(ENTRY);
  assert.equal(e.revertible, true);
  assert.equal(e.trash, false);
  assert.deepEqual(e.after.hiddenIn, ["p1"]);
  const { revertible: _z, ...without } = ENTRY;
  assert.equal(wire.readHistoryEntry(without).revertible, false, "no button without a statement");
  assert.equal(wire.readHistoryEntry({ ...ENTRY, at: 1_790_000_000 }).at, 1_790_000_000_000, "seconds read as seconds");
  assert.equal(wire.readHistoryEntry({ ...ENTRY, kind: "rename" }), null);
  assert.equal(wire.readHistoryEntry({ ...ENTRY, id: "" }), null);
  assert.equal(wire.readHistoryEntry({ ...ENTRY, who: "robot" }).who, null);
  assert.equal(wire.readRequest({ id: "a1", status: "open" }).current, false, "without `current` no approval on a guess");
  assert.equal(wire.readRequest({ id: "a1", status: "anything" }), null);
  assert.deepEqual(wire.readLastChange({ who: "agent", chatTitle: "Refactor", at: 5 }), { who: "agent", chatId: null, chatTitle: "Refactor", at: 5000 });
  assert.equal(wire.readLastChange(null), null);
  assert.equal(wire.readOpenRequest({ chatTitle: "x" }), null);
  const m = wire.withHistoryFields({ id: "s1", name: "x", version: "abcd", lastChange: { who: "human", at: 2e12 } });
  assert.equal(m.version, "abcd");
  assert.equal(m.lastChange.who, "human");
  assert.equal(m.openRequest, null, "an older server without the field: no request");

  const f = fakeFetch(() => ({ body: {} }));
  try { assert.deepEqual(await wire.loadSkillSettings("w1"), { agentsWrite: null }, "not said is not \"on\""); }
  finally { f.back(); }

  assert.deepEqual(wire.skillsEvent({ type: "skills", workspaceId: "w1", skillId: "s1", kind: "change" }), { workspaceId: "w1", projectId: null, skillId: "s1", kind: "change", requestId: null });
  assert.equal(wire.skillsEvent({ type: "run", workspaceId: "w1" }), null);
  assert.equal(wire.skillsEvent({ type: "skills" }), null, "without a workspace no event for a page");
});

test("Error of a 409: conflict with both states, references, existing name — read from the thrown error", async () => {
  const f = fakeFetch(() => ({ status: 409, body: { error: "changed since", conflict: true, current: { version: "3333", name: "a" }, expected: "2222" } }));
  try {
    const error = await wire.takeSkillChangeBack("v1").then(() => null, (e) => e);
    const g = wire.skillWriteError(error);
    assert.equal(g.text, "changed since");
    assert.equal(g.conflict.current.version, "3333");
    assert.equal(g.conflict.current.name, "a");
    assert.equal(g.conflict.expected.version, "2222", "a bare version is also a state");
    assert.equal(g.references, null);
  } finally { f.back(); }
  const v = wire.skillWriteError(Object.assign(new Error("used"), { references: [{ id: "d1", name: "reviewer", level: "workspace" }, { id: "x" }] }));
  assert.deepEqual(v.references, [{ id: "d1", name: "reviewer", level: "workspace" }]);
  assert.equal(v.conflict, null);
  assert.equal(wire.skillWriteError(Object.assign(new Error("allocated"), { existing: { id: "s9", name: "deploy", level: "workspace" } })).existing.name, "deploy");
});

test("Block: the cbase_skill_write call does not merge into the collective row and carries its card", () => {
  const src = fs.readFileSync(path.join(webDir, "src", "components", "AssistantBlocks.tsx"), "utf8");
  const groupable = src.slice(src.indexOf("const groupable = "), src.indexOf(";", src.indexOf("const groupable = ")));
  assert.match(groupable, /!isSkillWrite\(bl\.name\) &&/, "the call merges into a collective row — the card would never show");
  assert.match(src, /\{skillResult && <SkillToolCard result=\{skillResult\} \/>\}/);
  const stage = fs.readFileSync(path.join(webDir, "src", "components", "chat", "ChatStage.tsx"), "utf8");
  assert.match(stage, /<SkillToolWorkspace\.Provider value=\{wsId\}>/, "the stage does not pass the workspace — undo would be missing in the chat");
});
