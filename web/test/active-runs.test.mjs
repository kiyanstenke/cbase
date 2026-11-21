// The "Active runs" pill reloads on the global event of a dynamic workflow: src/lib/active-runs.ts, compiled with
// tsc, held against the name the server sends (server/backend/electron/server/dynworkflows/run.js GLOBAL_EVENT; that
// it really sends start and end is checked by server/backend/test/active-runs.test.js against the real /api/events),
// and the pill must filter through exactly this function.
//
// It also shows copies being created (field `copies` of GET /api/active-runs, runs/routes.js): the allowlist
// `copiesFrom` (src/lib/api/copy-progress.ts; the progress itself is held on iOS by instances-tree-binding.test.mjs),
// the jump into the "Instances" tab (src/lib/project-jump.ts, the general jump into a project subitem: remember,
// take ONCE, expire after a minute, address there and back; the "Git" subitem is checked by jumps.test.mjs), both
// compiled with tsc and executed, and at the pill's source: the number counts copies too, `counts` stays the runs',
// a click leads through `showInstances` or `instancesAddress`, and every sentence of the copy row appears exactly
// once in i18n-de.ts.
//
// Counter-tests (each red, then reverted): "dyn_workflow" removed from LOAD_EVENTS (the old run/workflow_run/init
// filter) turns "reloads on dyn_workflow" and "binding to the server" red; the `k.id` check removed from
// `copiesFrom` turns "copies" red; the expiry removed from `takeInstancesTarget` (today `takeProjectTarget`) turns
// "jump" red; `count = total` in the pill turns "pill (source)" red.
//
// Run:  node --test web/test/active-runs.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-active-runs-"));
after(() => { try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "active-runs.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const { LOAD_EVENTS, loadAfterEvent } = await import(pathToFileURL(path.join(out, "active-runs.js")).href);
// Two leaf modules without imports, each compiled into its own folder (tsc puts a single file flat).
const translate = (rel, name) => {
  const target = path.join(out, name);
  execFileSync(process.execPath, [
    tsc, path.join(webDir, rel), "--outDir", target, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
    "--lib", "es2022,dom",
  ], { stdio: "pipe" });
  return import(pathToFileURL(path.join(target, path.basename(rel).replace(/\.ts$/, ".js"))).href);
};
const { copiesFrom } = await translate("src/lib/api/copy-progress.ts", "copy");
const jump = await translate("src/lib/project-jump.ts", "jump");

test("reloads on dyn_workflow, like on run start/end, graph workflow and init; not on anything else", () => {
  for (const type of ["dyn_workflow", "run", "workflow_run", "init"]) assert.equal(loadAfterEvent({ type }), true, type);
  for (const msg of [{ type: "browsers" }, { type: "todos" }, {}, null, { type: 5 }]) assert.equal(loadAfterEvent(msg), false, JSON.stringify(msg));
});

test("binding to the server: the name of the global event from dynworkflows/run.js is in the list", () => {
  const run = fs.readFileSync(path.join(repo, "server/backend/electron/server/dynworkflows/run.js"), "utf8");
  const m = /export const GLOBAL_EVENT = "([^"]+)";/.exec(run);
  assert.ok(m, "GLOBAL_EVENT missing from run.js");
  assert.ok(LOAD_EVENTS.includes(m[1]), `the pill does not know "${m[1]}": ${LOAD_EVENTS.join(", ")}`);
  assert.match(run, /broadcast\(\{ type: GLOBAL_EVENT,/, "the server sends it through broadcast");
});

// The pill shows copies being created: it reloads on the event that every state and phase change of a copy sends.
test("binding to the server: `project/copy` from stacks/state.js is in the list", () => {
  const state = fs.readFileSync(path.join(repo, "server/backend/electron/server/stacks/state.js"), "utf8");
  const m = /broadcast\(\{ type: "(project\/copy)",/.exec(state);
  assert.ok(m, "stacks/state.js no longer sends project/copy");
  assert.ok(LOAD_EVENTS.includes(m[1]), `the pill does not know "${m[1]}": ${LOAD_EVENTS.join(", ")}`);
  assert.equal(loadAfterEvent({ type: "project/copy" }), true);
});

test("the pill filters through loadAfterEvent, not through its own list", () => {
  const pill = fs.readFileSync(path.join(webDir, "src/components/pills/ActiveRunsPill.tsx"), "utf8");
  assert.match(pill, /subscribeGlobalEvents\(\(msg\) => \{\s*if \(!loadAfterEvent\(msg\)\) return;/);
  assert.doesNotMatch(pill, /msg\.type !== "run"/, "no second filter beside it");
});

const F_OK = { kind: "create", reason: "", step: 3, steps: 6, phase: "clone2", stage: null, begin: 1000, share: 0.5, restMs: 120000, estimateMs: 240000, overrun: false };

test("copies: `copiesFrom` is an allowlist; without the field none, broken entries drop, fallbacks for instance and base", () => {
  for (const raw of [undefined, null, "x", 5, {}, { 0: {} }]) assert.deepEqual(copiesFrom(raw), [], JSON.stringify(raw));
  const full = {
    id: "copy:7", name: "k1", instance: "copy-k1", projectId: "p1", projectName: "ORBIT", workspaceId: "w1", workspaceName: "Examplecorp",
    state: "build", baseInstance: "copy-k0", startedAt: 900, progress: F_OK,
  };
  assert.deepEqual(copiesFrom([full]), [{ ...full }]);
  // Without identifier, name, project or workspace an entry is none (it would lead nowhere).
  for (const field of ["id", "name", "projectId", "workspaceId"]) {
    const { [field]: _dropped, ...rest } = full;
    assert.deepEqual(copiesFrom([rest]), [], `without ${field}`);
    assert.deepEqual(copiesFrom([{ ...full, [field]: 5 }]), [], `${field} not a string`);
  }
  const [k] = copiesFrom([{ id: "copy:8", name: "k2", projectId: "p1", workspaceId: "w1", progress: { kind: "broken" }, startedAt: "x" }]);
  assert.equal(k.instance, "copy-k2", "without `instance`, copy-<name> applies");
  assert.equal(k.baseInstance, "main", "without `baseInstance`, main applies");
  assert.equal(k.progress, null, "a broken progress is none");
  assert.equal(k.startedAt, 0);
  assert.deepEqual(copiesFrom([null, full, "x", []]).map((x) => x.id), ["copy:7"]);
});

test("jump into the \"Instances\" tab: remember, take ONCE, expire, per project, address there and back, event", () => {
  const { rememberProjectTarget, takeInstancesTarget, instancesAddress, projectFromAddress, showInstances, PROJECT_JUMP_EVENT, VALID_MS } = jump;
  const rememberInstancesTarget = (projectId, target, now) => rememberProjectTarget("instances", projectId, target, now);
  const instancesFromAddress = (params) => {
    const s = projectFromAddress(params);
    return s && s.subitem === "instances" ? { projectId: s.projectId, ...s.target } : null;
  };
  rememberInstancesTarget("p1", { createFrom: "copy-k1" }, 1000);
  assert.equal(takeInstancesTarget("p2", 1001), null, "a request applies only to its project");
  assert.deepEqual(takeInstancesTarget("p1", 1001), { createFrom: "copy-k1" });
  assert.equal(takeInstancesTarget("p1", 1002), null, "once taken, it is gone");
  rememberInstancesTarget("p1", { instance: "copy-k1" }, 0);
  assert.equal(takeInstancesTarget("p1", VALID_MS + 1), null, "an expired request opens nothing any more");
  assert.equal(takeInstancesTarget("p1", 0), null, "and is gone afterwards");
  rememberInstancesTarget("p1", { instance: "copy-old" }, 0);
  rememberInstancesTarget("p1", { instance: "copy-new" }, 5);
  assert.deepEqual(takeInstancesTarget("p1", 6), { instance: "copy-new" }, "the newer request wins");

  const address = instancesAddress({ workspaceId: "w 1", projectId: "p1", instance: "copy-k1" });
  assert.equal(address, "/workspaces/?ws=w+1&instances=p1&instance=copy-k1");
  const params = new URLSearchParams(address.slice(address.indexOf("?") + 1));
  assert.equal(params.get("ws"), "w 1");
  assert.deepEqual(instancesFromAddress(params), { projectId: "p1", instance: "copy-k1" });
  assert.deepEqual(instancesFromAddress(new URLSearchParams("instances=p1&create=main&instance=")), { projectId: "p1", createFrom: "main" });
  assert.equal(instancesFromAddress(new URLSearchParams("ws=w1&chat=c1")), null, "without `instances` no jump");
  assert.equal(instancesFromAddress(new URLSearchParams("instances=%20")), null);

  const sent = [];
  const prior = globalThis.window;
  globalThis.window = { dispatchEvent: (e) => { sent.push({ type: e.type, detail: e.detail }); return true; } };
  try {
    showInstances({ workspaceId: "w1", projectId: "p9", createFrom: "main" });
  } finally {
    if (prior === undefined) delete globalThis.window; else globalThis.window = prior;
  }
  assert.deepEqual(sent, [{ type: PROJECT_JUMP_EVENT, detail: { workspaceId: "w1", projectId: "p9", subitem: "instances" } }]);
  assert.deepEqual(takeInstancesTarget("p9"), { createFrom: "main" }, "the event does not carry the request; it waits in the leaf module");
});

test("pill (source): copies beside the runs; number included, `counts` untouched, click into the \"Instances\" tab, sentences translated", () => {
  const pill = fs.readFileSync(path.join(webDir, "src/components/pills/ActiveRunsPill.tsx"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.match(pill, /const copies = copiesFrom\(view\?\.copies\);/, "the pill does not read `copies` through the allowlist");
  assert.match(pill, /const count = total \+ copies\.length;/, "the pill's number does not count the copies");
  assert.match(pill, /\{count > 0 && <span className="text-\[12px\] font-semibold tabular-nums">\{count\}<\/span>\}/);
  assert.doesNotMatch(pill, /counts[^;\n]*copies|copies[^;\n]*counts/, "`counts` (the count of the runs) is mixed with the copies");
  assert.match(pill, /items\.length === 0 && copies\.length === 0 \?/, "\"Nothing is running right now.\" would sit above a copy being created");
  const open = pill.slice(pill.indexOf("function openCopy"), pill.indexOf("async function stop"));
  assert.match(open, /const target = \{ workspaceId: k\.workspaceId, projectId: k\.projectId, instance: k\.instance \};/);
  assert.match(open, /readActiveScope\(\)\.workspaceId === k\.workspaceId\) \{ showInstances\(target\); return; \}/);
  assert.match(open, /rememberWorkspace\(k\.workspaceId\);\s*window\.location\.href = instancesAddress\(target\);/);
  const row = pill.slice(pill.indexOf("function CopyRow"), pill.indexOf("function StatusPoint"));
  assert.match(row, /const a = progressDetail\(k\.progress, k\.state\);/);
  assert.match(row, /<CopyProgressBar a=\{a\}/);
  const en = fs.readFileSync(path.join(webDir, "src/lib/i18n-de.ts"), "utf8").split("\n");
  const copyPart = [row, pill.slice(pill.indexOf("const copiesSet"), pill.indexOf("const summary")), pill.slice(pill.indexOf('data-runs-section="copies"'))].join("\n");
  const progress = fs.readFileSync(path.join(webDir, "src/components/projects/CopyProgress.tsx"), "utf8");
  const key = [...copyPart.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g), ...progress.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  assert.ok(key.length >= 15, `only ${key.length} sentences found; does the regex still match?`);
  for (const k of new Set(key)) {
    assert.equal(en.filter((z) => z.trimStart().startsWith(`"${k}":`)).length, 1, `"${k}" is not exactly once in i18n-de.ts`);
  }
});
