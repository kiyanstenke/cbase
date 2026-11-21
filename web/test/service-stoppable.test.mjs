// "Stop" at `running || holdsStart` in all four service views. The server's start protection (services.js startSimple)
// answers 409 "already running — stop first" when the process group of a service lives but does not listen on the registered
// port (nodemon after a crash, a service on another port). The views decided "Stop" on the port signal (`running`) alone —
// they offered only "Start", and the start ended in the 409 every time, with no way out. Now the state reports the same
// verdict as `holdsStart` (GET /api/projects/:id/services -> `status.holdsStart`, GET /api/project-services -> `holdsStart`;
// server guard in server/backend/test/projectbox-services.test.js), and EVERY view offers the stop at `running || holdsStart`:
//   Web   ProjectServicesPane.tsx (button per service), app/apps/page.tsx (button per service via `ctlFromPs`, "Stop all")
//   iOS   Code/ProjectsPane.swift (button per service), Shell/AppsPage.swift (button per service, "Stop all"), the field in
//         Models/ServiceModels.swift (both models; a missing field means false — older servers).
// Read by path. Counter-test: the four views at the old state => every check red; the sabotage built in below shows the same
// patterns red on today's sources.
//
// Stop answer: the reason of a failed stop (`error`) stands in the message — `stopNotice` in the leaf
// web/src/lib/services-status.ts (compiled with tsc and EXECUTED), `ServiceStopResponse.notice` in Models/ServiceModels.swift
// (text against the same sequence), and all stop paths (web project services, apps single and "Stop all"; iOS projects, apps
// single and "Stop all") read the answer through them. Counter-tests, each red once: `stopNotice` without the `error` line =>
// "Stop answer" red; ProjectServicesPane back to the old body (`{ stopped: boolean }`, general sentence) => "in all views" red;
// the `error` line struck in `ServiceStopResponse.notice` => likewise red.
//
// Instance choice of the Apps page (web): the stop of a service goes to the instance of its view (`instancePath(…, param)`, the
// main without parameter) and its transition hangs on `uid` (per service AND instance) — ONE path for main and copy instead of
// a second one the guard would not see. The view of a copy carries its start protection (`holdsStart: st.holds` in `viewIn`), and
// `serviceInInstance` (executed) reads it from `instances[].holdsStart`. Counter-tests: apps/page.tsx at the old state =>
// "Stop at running || holdsStart" and "Stop answer in all views" red; in `serviceInInstance` the copy with `holds: false` =>
// "Start protection per instance" red.
//
// EVERY start and stop of the Apps page goes to the chosen instance — web start, "Start all", "Stop all", stop and agent start
// via `instancePath(…, param)` with `param` from `s.instanceParam`, iOS all four calls with `query: CodeInstance.query(…)` from
// the view. Counter-test: the sabotage (instancePath removed from startStack, stopStack, onStartSimple, onStartAgent, on iOS
// all four `query:`) => "Instance choice …" red with "4 of 5" or "4 of 4 … without" and one line per path. The stop answer
// check reads the transition key freely (`transitions[…] = nil`): the iOS Apps page keeps it per service AND instance
// (`AppsModel.transitionKey`).
//
// Run:  node --test web/test/service-stoppable.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const FILES = {
  pane: "web/src/components/ProjectServicesPane.tsx",
  apps: "web/src/app/apps/page.tsx",
  projectsIos: "mobile/CbaseMobile/Code/ProjectsPane.swift",
  appsIos: "mobile/CbaseMobile/Shell/AppsPage.swift",
  models: "mobile/CbaseMobile/Models/ServiceModels.swift",
};
const read = () => Object.fromEntries(Object.entries(FILES).map(([k, p]) => [k, fs.readFileSync(path.join(ROOT, p), "utf8")]));

// The condition immediately before the stop button: the branch it stands in.
function branchBefore(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) return null;
  const beforehand = text.slice(0, i);
  const branch = [...beforehand.matchAll(/(?:\)\s*:\s*([^?\n]+)\?\s*\(|else if ([^{\n]+)\{)/g)].pop();
  return branch ? (branch[1] || branch[2]).trim() : null;
}

function violations(q) {
  const v = [];
  const pane = branchBefore(q.pane, 't("Stop")');
  if (!/holds/.test(pane || "") || !/holdsStart/.test(q.pane)) v.push(`ProjectServicesPane: stop branch "${pane}" without holdsStart`);
  if (!/const stoppable = \(s: ProjectService\) => s\.running \|\| Boolean\(s\.holdsStart\)/.test(q.apps)) v.push("apps/page: stoppable missing");
  if (!/running: stoppable\(s\)/.test(q.apps)) v.push("apps/page: ctlFromPs asks only running");
  if (!/const toStop = svcs\.filter\(stoppable\)/.test(q.apps)) v.push("apps/page: \"Stop all\" asks only running");
  // Instance choice: in a chosen copy ITS start protection applies (`instances[].holdsStart` via serviceInInstance).
  if (!/holdsStart: st\.holds,/.test(q.apps)) v.push("apps/page: the view of a copy (viewIn) does not carry its start protection");
  const projects = branchBefore(q.projectsIos, 'L("Stop")');
  if (projects !== "stoppable" || !/let stoppable = running \|\| \(service\.status\?\.holdsStart \?\? false\)/.test(q.projectsIos)) {
    v.push(`ProjectsPane.swift: stop branch "${projects}" without holdsStart`);
  }
  const appsIos = branchBefore(q.appsIos, 'L("Stop")');
  if (appsIos !== "service.stoppable") v.push(`AppsPage.swift: stop branch "${appsIos}" without holdsStart`);
  if (!/let candidates = group\.services\.filter\(\\\.stoppable\)/.test(q.appsIos)) v.push("AppsPage.swift: \"Stop all\" asks only running");
  if ((q.models.match(/holdsStart = c\.bool\(\.holdsStart\)/g) || []).length !== 2) v.push("ServiceModels.swift: holdsStart not read in both models");
  if (!/var stoppable: Bool \{ running \|\| holdsStart \}/.test(q.models)) v.push("ServiceModels.swift: stoppable missing");
  return v;
}

test("\"Stop\" at running || holdsStart — web (project services, apps) and iOS (projects, apps, models)", () => {
  assert.deepEqual(violations(read()), []);
});

test("Sabotage: the stop branch on the port signal alone is red in every view", () => {
  const q = read();
  const cases = [
    ["pane", (t) => t.replace(") : running || holds ? (", ") : running ? (")],
    ["apps", (t) => t.replace("running: stoppable(s),", "running: s.running,")],
    ["apps", (t) => t.replace("const toStop = svcs.filter(stoppable);", "const toStop = svcs.filter((s) => s.running);")],
    ["apps", (t) => t.replace("holdsStart: st.holds,", "holdsStart: false,")],
    ["projectsIos", (t) => t.replace("} else if stoppable {", "} else if running {")],
    ["appsIos", (t) => t.replace("} else if service.stoppable {", "} else if service.running {")],
    ["appsIos", (t) => t.replace("group.services.filter(\\.stoppable)\n        guard", "group.services.filter(\\.running)\n        guard")],
    ["models", (t) => t.replace("holdsStart = c.bool(.holdsStart)\n        mode", "mode")],
  ];
  for (const [file, sabotage] of cases) {
    const broken = sabotage(q[file]);
    assert.notEqual(broken, q[file], `sabotage on ${file} did not take`);
    assert.notDeepEqual(violations({ ...q, [file]: broken }), [], `sabotage on ${file} stayed green`);
  }
});

// ── Stop answer: the reason of the server stands in the message ───────────────────────────────────────────────────────────────
// A stop in a frozen project container answers `stopped: false` with `error` ("Project container … is frozen — service … not
// stopped, try again", services.js `stopInInstance`). ProjectServicesPane read only `stopped` and showed the general sentence
// "could not be safely stopped — something may still be running on the port"; the Apps page (web) and both iOS views did not
// read the answer at all — a failed stop said NOTHING there. Now ONE rule per language: `stopNotice`
// (web/src/lib/services-status.ts, EXECUTED here) and `ServiceStopResponse.notice` (Models/ServiceModels.swift, bound by text
// to the same sequence): `stopped: true` or no statement => nothing; else `error`, without it the general sentence.
const webDir = path.join(ROOT, "web");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-service-stop-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "services-status.ts"), "--outDir", tmp, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const { stopNotice, serviceInInstance } = await import(pathToFileURL(path.join(tmp, "services-status.js")).href);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* left behind, harmless */ }
const ti = (k, w) => (w ? k.replace(/\{(\w+)\}/g, (_, n) => String(w[n])) : k);
const GENERAL = "{name} could not be safely stopped — something may still be running on the port.";
const FROZEN = "Project container p1/main is frozen — service 7 not stopped, try again (cap)";

test("Stop answer: `error` of the server stands in the message; stopped:true and an answer without `stopped` say nothing", () => {
  assert.equal(typeof stopNotice, "function", "stopNotice missing in the leaf services-status.ts");
  assert.equal(stopNotice({ stopped: false, error: FROZEN, killed: [] }, "web", ti), FROZEN, "the reason of the server is missing — the general sentence would stand there");
  assert.equal(stopNotice({ stopped: false, killed: [] }, "web", ti), ti(GENERAL, { name: "web" }));
  assert.equal(stopNotice({ stopped: false, error: "" }, "web", ti), ti(GENERAL, { name: "web" }));
  assert.equal(stopNotice({ stopped: false, error: "   " }, "web", ti), ti(GENERAL, { name: "web" }));
  assert.equal(stopNotice({ stopped: true, killed: [1] }, "web", ti), null);
  assert.equal(stopNotice({ stopped: true, error: "x" }, "web", ti), null, "stopped is stopped");
  // A missing field is no statement — neither success nor failure is claimed.
  for (const raw of [null, undefined, "no JSON", 7, {}, { stopped: "no" }, { error: FROZEN }]) {
    assert.equal(stopNotice(raw, "web", ti), null, `answer ${JSON.stringify(raw)}`);
  }
});

// Instance choice of the Apps page: in a chosen copy the page offers "Stop" at `running || holdsStart` of THIS copy
// (GET /api/project-services `instances: [{ identifier, running, holdsStart }]`, server/backend/electron/server/projects/instance-fields.js).
// `serviceInInstance` is the rule for it (executed); a missing entry is "unknown" (null), never "stopped" — otherwise the page
// would offer "Start" and the start would end in 409 SERVICE_RUNNING (in the copy).
test("Start protection per instance: serviceInInstance reads main from the row, copy from `instances`, without entry unknown", () => {
  assert.equal(typeof serviceInInstance, "function", "serviceInInstance missing in the leaf services-status.ts");
  const d = {
    running: false, holdsStart: true,
    instances: [{ identifier: "p1/main", running: false, holdsStart: true }, { identifier: "p1/copy-k1", running: false, holdsStart: true }, { identifier: "p1/copy-k2", running: true }],
  };
  assert.deepEqual(serviceInInstance(d, "p1/main", true), { running: false, holds: true }, "main: holdsStart of the row");
  assert.deepEqual(serviceInInstance(d, "p1/copy-k1", false), { running: false, holds: true }, "copy: its own start protection");
  assert.deepEqual(serviceInInstance(d, "p1/copy-k2", false), { running: true, holds: false });
  assert.deepEqual(serviceInInstance({ ...d, holdsStart: false }, "p1/copy-k1", false), { running: false, holds: true }, "the copy does not read the row of the main");
  assert.deepEqual(serviceInInstance(d, "p1/copy-k9", false), { running: null, holds: false }, "no entry => unknown");
  assert.deepEqual(serviceInInstance({ running: true }, "p1/copy-k1", false), { running: null, holds: false }, "no field (one instance, older server) => unknown");
  assert.deepEqual(serviceInInstance({ running: true, holdsStart: true }, null, true), { running: true, holds: false }, "holds only next to a non-running one");
});

const STOP = {
  pane: "web/src/components/ProjectServicesPane.tsx",
  apps: "web/src/app/apps/page.tsx",
  projectsIos: "mobile/CbaseMobile/Code/ProjectsPane.swift",
  appsIos: "mobile/CbaseMobile/Shell/AppsPage.swift",
  models: "mobile/CbaseMobile/Models/ServiceModels.swift",
};
const readStop = () => Object.fromEntries(Object.entries(STOP).map(([k, p]) => [k, fs.readFileSync(path.join(ROOT, p), "utf8")]));
// The body from `header` to the matching closing brace (null if the header does not exist).
function bodyOf(text, header) {
  const i = text.indexOf(header);
  if (i < 0) return null;
  const on = text.indexOf("{", i + header.length);
  let depth = 0;
  for (let j = on; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}" && !--depth) return text.slice(on + 1, j);
  }
  return null;
}

function stopViolations(q) {
  const v = [];
  const pane = bodyOf(q.pane, "async function stopService(s: Service)") || "";
  if (!/const notice = stopNotice\(await api<unknown>\(`\/api\/projects\/\$\{projectId\}\/services\/\$\{s\.id\}\/stop`, \{ method: "POST" \}\), s\.name, t\);/.test(pane)
    || !/setActionError\(notice\)/.test(pane)) v.push("ProjectServicesPane: the stop does not read `error` via stopNotice");
  if (/stopped: boolean/.test(pane) || /could not be safely stopped/.test(pane)) v.push("ProjectServicesPane: own sentence bypassing the leaf");
  // ONE path for main AND copy: the stop goes to the instance of the view (`instancePath(…, param)`, the main without parameter),
  // the transition hangs on `uid` (per service and instance).
  if (!/onStop: \(\) => runAction\(uid, "stopping", async \(\) => \{\s*const notice = stopNotice\(await api<unknown>\(instancePath\(`\/api\/projects\/\$\{s\.projectId\}\/services\/\$\{s\.id\}\/stop`, param\), \{ method: "POST" \}\), s\.name, t\);\s*if \(notice\) \{ setSvcTransition\(uid, null\); setError\(notice\); \}/.test(q.apps)) {
    v.push("apps/page: the stop of a service does not read the answer");
  }
  const stack = bodyOf(q.apps, "async function stopStack(projectId: string, svcs: ProjectService[])") || "";
  if (!/stopNotice\(/.test(stack) || !/setError\(/.test(stack)) v.push("apps/page: \"Stop all\" does not read the answers");
  for (const [file, header, target] of [["appsIos", "func stop(_ service: ProjectServiceRow) async", "service.name"], ["projectsIos", "private func stop(_ service: ProjectServiceDetail) async", "service.name"]]) {
    const r = bodyOf(q[file], header) || "";
    // The key of the transition is free: ProjectsPane keeps it per service (`service.id`), the Apps page per service AND instance
    // (`key` from `AppsModel.transitionKey`).
    if (!new RegExp(`if let notice = ServiceStopResponse\\.notice\\(from: data, name: ${target.replace(".", "\\.")}\\) \\{\\s*transitions\\[[^\\]\\n]+\\] = nil\\s*self\\.error = notice`).test(r)
      || !/let data = try await client\.send\(/.test(r)) v.push(`${STOP[file]}: the stop does not read the answer (ServiceStopResponse.notice)`);
  }
  const stackIos = bodyOf(q.appsIos, "func stopStack(_ group: ProjectGroup) async") || "";
  if (!/ServiceStopResponse\.notice\(from: data, name: service\.name\)/.test(stackIos) || !/self\.error = notices\.joined/.test(stackIos)) v.push("AppsPage.swift: \"Stop all\" does not read the answers");
  const model = bodyOf(q.models, "struct ServiceStopResponse: Decodable, Sendable") || "";
  if (!/stopped = c\.boolOpt\(\.stopped\)/.test(model) || !/error = c\.strOpt\(\.error\)/.test(model)) v.push("ServiceModels.swift: ServiceStopResponse does not read `stopped`/`error` tolerantly");
  const rule = bodyOf(model, "func notice(name: String) -> String?") || "";
  if (!/^\s*guard stopped == false else \{ return nil \}\s*if let error, !error\.trimmingCharacters\(in: \.whitespacesAndNewlines\)\.isEmpty \{ return error \}\s*return L\("\{name\} could not be safely stopped — something may still be running on the port\.", \["name": name\]\)\s*$/.test(rule)) {
    v.push("ServiceModels.swift: ServiceStopResponse.notice deviates from stopNotice (nothing at stopped/no statement, else error, else the general sentence)");
  }
  return v;
}

test("Stop answer in all views: web project services and apps (single, \"Stop all\"), iOS projects and apps (single, \"Stop all\")", () => {
  assert.deepEqual(stopViolations(readStop()), []);
});

test("Sabotage (stop answer): a view that does not read `error`, or a deviating iOS rule, is red", () => {
  const q = readStop();
  const cases = [
    ["pane", (t) => t.replace("setActionError(notice)", "setActionError(null)")],
    ["apps", (t) => t.replace("if (notice) { setSvcTransition(uid, null); setError(notice); }", "")],
    ["apps", (t) => t.replace(/(async function stopStack[\s\S]*?)stopNotice\(/, "$1String(")],
    ["appsIos", (t) => t.replace(/(func stop\(_ service: ProjectServiceRow\) async[\s\S]*?)self\.error = notice/, "$1_ = notice")],
    ["projectsIos", (t) => t.replace(/(private func stop\(_ service: ProjectServiceDetail\) async[\s\S]*?)ServiceStopResponse\.notice/, "$1ServiceStopResponse.noticeOld")],
    ["models", (t) => t.replace("guard stopped == false else { return nil }", "guard stopped != true else { return nil }")],
    ["models", (t) => t.replace("if let error, !error.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return error }\n", "")],
  ];
  for (const [file, sabotage] of cases) {
    const broken = sabotage(q[file]);
    assert.notEqual(broken, q[file], `sabotage on ${file} did not take`);
    assert.notDeepEqual(stopViolations({ ...q, [file]: broken }), [], `sabotage on ${file} stayed green`);
  }
});

// ── Instance choice: EVERY start and stop of the Apps page goes to the instance of the view ────────────────────────────────────
// If a copy is chosen in the Apps page, every action applies to it: web `instancePath(…, param)` with `param` from `s.instanceParam`
// (the view `viewIn`), iOS `query: CodeInstance.query(…)` with the parameter of the view (`view.param` or `group.view.param`). If it is
// missing at ONE place, it silently lands in the main while the page shows "Services · k1" — a second run on the data of the main.
// Two rules: (1) every start/stop call of a service in the file carries the instance (also a future further one), (2) every
// one of the named paths does, with `param` from the view.
const rowsWithoutComment = (t) => t.split("\n").map((z) => (/^\s*\/\//.test(z) ? "" : z)).join("\n");
const WEB_CALL = /`\/api\/projects\/\$\{[\w.]+\}\/services\/\$\{[\w.]+\}\/(?:start|stop)`/g;
const WEB_WITH_INSTANCE = /instancePath\(`\/api\/projects\/\$\{[\w.]+\}\/services\/\$\{[\w.]+\}\/(?:start|stop)`, param\)/g;
const IOS_CALL = /"\/api\/projects\/\\\(service\.projectId\)\/services\/\\\(service\.id\)\/(?:start|stop)"/g;
const IOS_WITH_INSTANCE = /"\/api\/projects\/\\\(service\.projectId\)\/services\/\\\(service\.id\)\/(?:start|stop)",\s*query: CodeInstance\.query\((?:view\.param|param)\)/g;

function instanceViolations(q) {
  const v = [];
  const web = rowsWithoutComment(q.apps);
  const ios = rowsWithoutComment(q.appsIos);
  const count = (t, re) => [...t.matchAll(re)].length;
  // (1) every call
  const [wa, wm] = [count(web, WEB_CALL), count(web, WEB_WITH_INSTANCE)];
  if (wa === 0 || wa !== wm) v.push(`apps/page: ${wa - wm} of ${wa} start/stop calls without instancePath(…, param)`);
  const [ia, iw] = [count(ios, IOS_CALL), count(ios, IOS_WITH_INSTANCE)];
  if (ia === 0 || ia !== iw) v.push(`AppsPage.swift: ${ia - iw} of ${ia} start/stop calls without query: CodeInstance.query(…)`);
  // (2) the named paths, web: stack start, stack stop, single stop, simple start, agent start — `param` from the view.
  const PARAM = /const param = s\.instanceParam \?\? null;/;
  const goes = (body, kind) => new RegExp("instancePath\\(`/api/projects/\\$\\{[\\w.]+\\}/services/\\$\\{s\\.id\\}/" + kind + "`, param\\)").test(body);
  for (const [name, header, kind] of [
    ["\"Start all\" (startStack)", "async function startStack(projectId: string, svcs: ProjectService[])", "start"],
    ["\"Stop all\" (stopStack)", "async function stopStack(projectId: string, svcs: ProjectService[])", "stop"],
  ]) {
    const body = bodyOf(web, header) || "";
    if (!PARAM.test(body) || !goes(body, kind)) v.push(`apps/page: ${name} does not go to the instance of the view`);
  }
  const ctl = bodyOf(web, "const ctlFromPs = (s: ProjectService): Ctl =>") || "";
  if (!PARAM.test(ctl)) v.push("apps/page: ctlFromPs does not take `param` from s.instanceParam");
  const section = (from, until) => {
    const i = ctl.indexOf(from);
    if (i < 0) return "";
    const j = until ? ctl.indexOf(until, i + from.length) : -1;
    return ctl.slice(i, j < 0 ? ctl.length : j);
  };
  for (const [name, from, until, kind] of [["Stop", "onStop:", "onStartSimple:", "stop"], ["Simple start", "onStartSimple:", "onStartAgent:", "start"], ["Start with agent", "onStartAgent:", null, "start"]]) {
    if (!goes(section(from, until), kind)) v.push(`apps/page: "${name}" of a service does not go to the instance of the view`);
  }
  // iOS: single start and stop via `view(service.projectId)`, the stacks via `group.view.param`.
  for (const [name, header, source, param] of [
    ["start", "func start(_ service: ProjectServiceRow, mode: String, instructions: String?) async -> String?", /let view = view\(service\.projectId\)/, "view\\.param"],
    ["stop", "func stop(_ service: ProjectServiceRow) async", /let view = view\(service\.projectId\)/, "view\\.param"],
    ["startStack", "func startStack(_ group: ProjectGroup) async", /let param = group\.view\.param\b/, "param"],
    ["stopStack", "func stopStack(_ group: ProjectGroup) async", /let param = group\.view\.param\b/, "param"],
  ]) {
    const body = bodyOf(ios, header) || "";
    if (!source.test(body) || !new RegExp(`query: CodeInstance\\.query\\(${param}\\)`).test(body)) v.push(`AppsPage.swift: ${name} does not go to the instance of the view`);
  }
  return v;
}

test("Instance choice: every start and stop of the Apps page goes to the chosen instance — web instancePath(…, param), iOS query: CodeInstance.query(…)", () => {
  assert.deepEqual(instanceViolations(readStop()), []);
});

test("Sabotage (instance choice): a start or stop without the instance of the view is red — per path, web and iOS", () => {
  const q = readStop();
  const cases = [
    ["apps", (t) => t.replace("instancePath(`/api/projects/${projectId}/services/${s.id}/start`, param)", "`/api/projects/${projectId}/services/${s.id}/start`")],
    ["apps", (t) => t.replace("instancePath(`/api/projects/${projectId}/services/${s.id}/stop`, param)", "`/api/projects/${projectId}/services/${s.id}/stop`")],
    ["apps", (t) => t.replace("instancePath(`/api/projects/${s.projectId}/services/${s.id}/stop`, param)", "`/api/projects/${s.projectId}/services/${s.id}/stop`")],
    ["apps", (t) => t.replace('api(instancePath(`/api/projects/${s.projectId}/services/${s.id}/start`, param), { method: "POST", body: JSON.stringify({ mode: "simple" })', 'api(`/api/projects/${s.projectId}/services/${s.id}/start`, { method: "POST", body: JSON.stringify({ mode: "simple" })')],
    ["apps", (t) => t.replace("api<{ chatId?: string }>(instancePath(`/api/projects/${s.projectId}/services/${s.id}/start`, param),", "api<{ chatId?: string }>(`/api/projects/${s.projectId}/services/${s.id}/start`,")],
    ["apps", (t) => t.replace("const param = s.instanceParam ?? null;", "const param = null;")],
    ["apps", (t) => t.replace(/(const ctlFromPs[\s\S]*?)const param = s\.instanceParam \?\? null;/, "$1const param = null;")],
    ["appsIos", (t) => t.replace(/query: CodeInstance\.query\(view\.param\),\s*body: Body\(mode: mode/, "body: Body(mode: mode")],
    ["appsIos", (t) => t.replace('/stop", query: CodeInstance.query(view.param))', '/stop")')],
    ["appsIos", (t) => t.replace(/query: CodeInstance\.query\(param\),\s*body: Body\(mode: "simple"\)/, 'body: Body(mode: "simple")')],
    ["appsIos", (t) => t.replace('/stop", query: CodeInstance.query(param))', '/stop")')],
    ["appsIos", (t) => t.replace("let param = group.view.param", "let param: String? = nil")],
  ];
  for (const [file, sabotage] of cases) {
    const broken = sabotage(q[file]);
    assert.notEqual(broken, q[file], `sabotage on ${file} did not take: ${sabotage}`);
    assert.notDeepEqual(instanceViolations({ ...q, [file]: broken }), [], `sabotage on ${file} stayed green: ${sabotage}`);
  }
});

// ── Start transition with an end rule ──────────────────────────────────────────────────────────────────────────────────────────
// "Starting" ended in all four service views only at `running`. Two cases hung forever, with neither a stop nor a start button: a
// run that the start protection holds (`holdsStart`; service registered on :3195, start command "PORT=3194 …" — 5 min "Starting"),
// and a simple start whose process dies at once. Now ONE rule: `transitionStep` in the leaf web/src/lib/service-transition.ts
// (compiled and EXECUTED here), Swift twin `ServiceTransitionRule` in Shell/AppsPage.swift (bound by text to the same numbers
// and lines), used by the web Apps page and project services, iOS Apps and projects; plus the stop NEXT TO "Starting" as soon as
// the state is stoppable. Counter-test: this file against the tree before the leaf (the four views via `git show`, without the
// leaf) => the three new tests red; the sabotages built in below show every binding red on today's sources.
// The linger time counts from the first dead state (`deadSince`, its ARRIVAL), which the step carries forward — not from the
// ANSWER of the start route: the server probes 8 s after the END of the start command (services.js), and a
// `docker compose up -d` that ran 3 s and whose service listened after 10 s stood at 8.3 s as "did not keep running", with
// "Start". Counter-test: the tests below against a leaf that counts from the answer => "Linger time from the first dead
// state" red (cases 1 and 2 "ended" instead of "reached"), plus the one-step check "a single dead state ends nothing".
const TRANSITION_SHEET = path.join(webDir, "src", "lib", "service-transition.ts");
let transition = {};
if (fs.existsSync(TRANSITION_SHEET)) {
  const tmpU = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-service-transition-"));
  execFileSync(process.execPath, [tsc, TRANSITION_SHEET, "--outDir", tmpU, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  transition = await import(pathToFileURL(path.join(tmpU, "service-transition.js")).href);
  try { fs.rmSync(tmpU, { recursive: true, force: true }); } catch { /* left behind, harmless */ }
}

test("Start transition: transitionStep — a held run ends at the deadline, a dead process after its linger time, an agent only at its deadline", () => {
  const { transitionStep, withResponse, TRANSITION_DEADLINE_MS: F, TRANSITION_DEADLINE_AGENT_MS: FA, TRANSITION_LINGER_MS: N } = transition;
  assert.equal(typeof transitionStep, "function", "transitionStep missing (web/src/lib/service-transition.ts) — \"Starting\" then ends only at running");
  assert.ok(F > 0 && FA >= F && N > 0 && N < F, `deadlines implausible: ${F}/${FA}/${N}`);
  const end = (u, s, z) => transitionStep(u, s, z).end;
  const afterwards = (u, s, z) => transitionStep(u, s, z).next;
  const t0 = 1_000_000;
  const start = { kind: "starting", since: t0, mode: "simple" };
  const held = { running: false, holdsStart: true };
  const tot = { running: false, holdsStart: false };
  const to = (now, queried = now) => ({ now, queried });
  // Target reached, state unknown.
  assert.equal(end(start, { running: true }, to(t0 + 1)), "reached");
  assert.equal(end(start, null, to(t0 + 1)), "unknown");
  assert.equal(end(start, { holdsStart: true }, to(t0 + 1)), "unknown", "a state without running is none");
  // The case from the E2E run: the start protection holds the run, the port stays closed — until the deadline "Starting", then it ends (the row
  // shows "running, unreachable" with "Stop"). With an answer the same: a held run is not "ended".
  assert.equal(end(start, held, to(t0 + F - 1)), null);
  assert.equal(end(start, held, to(t0 + F)), "deadline");
  assert.equal(end(withResponse(start, t0 + 50), held, to(t0 + 50 + N + 1)), null);
  // Simple start, process dead: the first dead state after the answer sets `deadSince` (its ARRIVAL) and ends nothing yet; only
  // a dead state whose query BEGAN at least N later ends it.
  const answered = withResponse(start, t0 + 100);
  assert.notEqual(answered, start, "withResponse returns a NEW object (the view removes by identity)");
  assert.equal(start.response, undefined, "withResponse does not change the old transition");
  assert.equal(end(start, tot, to(t0 + F - 1)), null, "without an answer a dead state says nothing (the run may not have been registered yet)");
  assert.equal(afterwards(start, tot, to(t0 + F - 1)), start, "without an answer no deadSince — the same transition");
  assert.equal(afterwards(answered, tot, to(t0 + 100 + N, t0 + 99)), answered, "a state from BEFORE the answer sets no deadSince");
  assert.equal(end(answered, tot, to(t0 + 100 + N, t0 + 100 + N)), null, "a single dead state ends nothing — the server probes only 8 s after the END of the command");
  const t1 = t0 + 300; // the first dead state: queried at t1 − 150, arrived at t1
  const totSeen = afterwards(answered, tot, to(t1, t1 - 150));
  assert.notEqual(totSeen, answered, "the step returns a NEW object when it sets deadSince");
  assert.equal(totSeen.deadSince, t1, "deadSince is the ARRIVAL of the first dead state, not the start of its query");
  assert.equal(answered.deadSince, undefined, "the step does not change the old transition");
  assert.equal(end(totSeen, tot, to(t1 + N + 100, t1 + N - 1)), null, "linger: the query began less than N after deadSince");
  assert.equal(end(totSeen, tot, to(t1 + N + 100, t1 + N)), "ended");
  assert.equal(afterwards(totSeen, tot, to(t1 + 1000, t1 + 900)), totSeen, "a further dead state changes nothing — the same transition");
  assert.equal(afterwards(totSeen, tot, to(t1 - 50, t0 + 150)).deadSince, t1 - 50, "an early ARRIVED dead state pulls deadSince forward (overlapping queries)");
  // A stoppable state whose query began AFTER deadSince takes deadSince back (the "dead" was not the end of the command); an older
  // one (an overtaken, later arrived query) changes nothing.
  assert.equal(afterwards(totSeen, held, to(t1 + 900, t1 + 700)).deadSince, null);
  assert.equal(afterwards(totSeen, held, to(t1 + 900, t1 - 200)), totSeen);
  assert.equal(end(afterwards(totSeen, held, to(t1 + 900, t1 + 700)), tot, to(t1 + N + 900, t1 + N + 800)), null, "after the take-back the linger starts anew");
  assert.equal(end(start, tot, to(t0 + F)), "deadline", "without an answer it ends at the deadline");
  // Agent start: only the target or its (longer) deadline — a run without a process group says nothing about the agent; no deadSince.
  const agent = withResponse({ kind: "starting", since: t0, mode: "agent" }, t0 + 10);
  assert.equal(end(agent, tot, to(t0 + F, t0 + F)), null);
  assert.equal(afterwards(agent, tot, to(t0 + F, t0 + F)), agent, "an agent start carries no deadSince");
  assert.equal(end(agent, tot, to(t0 + FA - 1)), null);
  assert.equal(end(agent, tot, to(t0 + FA)), "deadline");
  assert.equal(end(agent, { running: true }, to(t0 + 5)), "reached");
  // Stop: at the target, and a stop that does not take (a foreign process on the port) does not stand on "Stopping" forever.
  const stop = { kind: "stopping", since: t0 };
  assert.equal(end(stop, tot, to(t0 + 1)), "reached");
  assert.equal(end(stop, held, to(t0 + 1)), null);
  assert.equal(afterwards(stop, held, to(t0 + 1)), stop, "a stop carries no deadSince");
  assert.equal(end(stop, { running: true }, to(t0 + F - 1)), null);
  assert.equal(end(stop, { running: true }, to(t0 + F)), "deadline");
  // Counter-proof of the rule itself: the old one (start only at running) would let both cases of the finding NEVER end.
  const old = (u, s) => (u.kind === "starting" ? s.running : !(s.running || s.holdsStart));
  assert.equal(old(start, held), false);
  assert.equal(old(answered, tot), false);
});

// The case from the finding, as a sequence of queries at the rhythm of the views (800 ms, 150 ms until the answer; the server
// computes the state in the middle): start at 0, the 202 arrives at 200. `statusAt(t)` is the truth of the server at time t. The old
// rule (linger from the answer) stands next to it as `afterResponse` — it reports "ended" in case 1 and 2 where the service runs
// right after and the server reports no failed start.
test("Start transition: the linger time counts from the first dead state, not from the answer — the server probes 8 s after the END of the start command", () => {
  const { transitionStep, withResponse, TRANSITION_LINGER_MS: N } = transition;
  assert.equal(typeof transitionStep, "function", "transitionStep missing (web/src/lib/service-transition.ts)");
  const held = { running: false, holdsStart: true };
  const tot = { running: false, holdsStart: false };
  const running = { running: true, holdsStart: false };
  const RESPONSE = 200;
  const LATENCY = 150;
  const afterResponse = (u, s, z) => ({
    end: s.running ? "reached" : (!s.holdsStart && typeof u.response === "number" && z.queried - u.response >= N ? "ended" : null),
    next: u,
  });
  const run = (step, statusAt, until = 60_000) => {
    let u = { kind: "starting", since: 0, mode: "simple" };
    for (let queried = 0; queried <= until; queried += 800) {
      if (queried >= RESPONSE && u.response === undefined) u = withResponse(u, RESPONSE);
      const now = queried + LATENCY;
      const r = step(u, statusAt(queried + LATENCY / 2), { now, queried });
      if (r.end) return { end: r.end, at: queried };
      u = r.next;
    }
    return { end: null, at: null };
  };
  // Case 1 (from the finding): `docker compose up -d` ends after 3 s with 0, the service listens from 10 s (the probe of the server would come at 11 s).
  const fall1 = (t) => (t < 3_000 ? held : t < 10_000 ? tot : running);
  assert.equal(run(afterResponse, fall1).end, "ended", "counter-proof: the old rule reports case 1 as \"did not keep running\"");
  assert.equal(run(transitionStep, fall1).end, "reached");
  // Case 2: compose builds for 30 s (the group lives, holdsStart), ends with 0, the service listens from 32 s (probe of the server at 38 s).
  const fall2 = (t) => (t < 30_000 ? held : t < 32_000 ? tot : running);
  assert.equal(run(afterResponse, fall2).end, "ended", "counter-proof: the old rule reports case 2 as \"did not keep running\"");
  assert.equal(run(transitionStep, fall2).end, "reached");
  // The case of the original finding: the process dies at once — "ended" stays, after the linger from the first dead state.
  const immediatelyTot = (t) => (t < 250 ? held : tot);
  const r = run(transitionStep, immediatelyTot);
  assert.equal(r.end, "ended");
  assert.ok(r.at >= 250 + N && r.at <= 250 + N + 2 * 800 + LATENCY, `"ended" at ${r.at} ms — expected from ${250 + N}, at the latest two ticks later`);
  // Never before the probe of the server: if the start command ends at `commandEnd` and the service never listens, the query that
  // reports "ended" begins at the earliest N after the end — for every moment of the end, also between two ticks.
  for (const commandEnd of [300, 1_234, 3_000, 7_999, 12_345, 29_950]) {
    const s = run(transitionStep, (t) => (t < commandEnd ? held : tot));
    assert.equal(s.end, "ended", `end at ${commandEnd}`);
    assert.ok(s.at >= commandEnd + N, `end at ${commandEnd}: "ended" already at ${s.at} (probe of the server first at ${commandEnd + N})`);
  }
});

const TRANSITION_SOURCES = { ...STOP, sheet: "web/src/lib/service-transition.ts" };
const readTransition = () => Object.fromEntries(Object.entries(TRANSITION_SOURCES).map(([k, p]) => {
  const full = path.join(ROOT, p);
  return [k, fs.existsSync(full) ? fs.readFileSync(full, "utf8") : ""];
}));

function transitionViolations(q) {
  const v = [];
  const count = (re) => { const m = re.exec(q.sheet); return m ? Number(m[1].replace(/_/g, "")) : null; };
  const web = { deadline: count(/TRANSITION_DEADLINE_MS = ([\d_]+);/), agent: count(/TRANSITION_DEADLINE_AGENT_MS = ([\d_]+);/), afterRun: count(/TRANSITION_LINGER_MS = ([\d_]+);/) };
  // Swift twin: the same numbers (seconds) and the same lines in the same order.
  const rule = bodyOf(q.appsIos, "static func step(start: Bool, mode: String?, since: Date, response: Date?, deadSince: Date?, running: Bool?, holds: Bool, now: Date, queried: Date) -> (end: End?, deadSince: Date?)") || "";
  const totRule = bodyOf(q.appsIos, "static func deadSinceAfter(mode: String?, response: Date?, soFar: Date?, stoppable: Bool, now: Date, queried: Date) -> Date?") || "";
  const swiftCount = (name) => { const m = new RegExp(`static let ${name}: TimeInterval = (\\d+)\\b`).exec(q.appsIos); return m ? Number(m[1]) * 1000 : null; };
  if (web.deadline === null || swiftCount("deadlineSeconds") !== web.deadline) v.push("AppsPage.swift: ServiceTransitionRule.deadlineSeconds ≠ TRANSITION_DEADLINE_MS");
  if (web.agent === null || swiftCount("deadlineAgentSeconds") !== web.agent) v.push("AppsPage.swift: deadlineAgentSeconds ≠ TRANSITION_DEADLINE_AGENT_MS");
  if (web.afterRun === null || swiftCount("lingerSeconds") !== web.afterRun) v.push("AppsPage.swift: lingerSeconds ≠ TRANSITION_LINGER_MS");
  // The same lines as `transitionStep`/`deadSinceAfter` in the leaf (executed there, by text here): the linger time hangs on deadSince.
  const ROWS = [
    [rule, /guard let running else \{ return \(\.unknown, deadSince\) \}/],
    [rule, /let stoppable = running \|\| holds/],
    [rule, /if !start \{ return \(!stoppable \? \.reached : \(age >= deadlineSeconds \? \.deadline : nil\), deadSince\) \}/],
    [rule, /if running \{ return \(\.reached, deadSince\) \}/],
    [rule, /let tot = deadSinceAfter\(mode: mode, response: response, soFar: deadSince, stoppable: stoppable, now: now, queried: queried\)/],
    [rule, /if mode == "simple", !stoppable, let tot, queried\.timeIntervalSince\(tot\) >= lingerSeconds \{ return \(\.ended, tot\) \}/],
    [rule, /return \(age >= \(mode == "agent" \? deadlineAgentSeconds : deadlineSeconds\) \? \.deadline : nil, tot\)/],
    [totRule, /guard mode == "simple", let response, queried >= response else \{ return soFar \}/],
    [totRule, /if !stoppable \{ return soFar\.map \{ min\(\$0, now\) \} \?\? now \}/],
    [totRule, /if let soFar, queried >= soFar \{ return nil \}/],
    [totRule, /return soFar\s*$/],
  ];
  const fromByBody = new Map();
  for (const [body, re] of ROWS) {
    const from = fromByBody.get(body) ?? 0;
    const m = re.exec(body.slice(from));
    if (!m) { v.push(`AppsPage.swift: ServiceTransitionRule deviates (${re.source})`); break; }
    fromByBody.set(body, from + m.index + m[0].length);
  }
  if (/queried\.timeIntervalSince\(response\) >= lingerSeconds/.test(q.appsIos)) v.push("AppsPage.swift: the linger time still counts from the answer");
  // The four views ask the rule — measure the state at a query that began BEFORE it — and carry deadSince forward.
  if (!/const queried = Date\.now\(\);\s*const \[ps, k, pr\] = await Promise\.allSettled\(\[/.test(q.apps)
    || !/applyServices\(ps\.value, queried\)/.test(q.apps)
    || !/const \{ end, next \} = transitionStep\(u, service && !service\.unknown \? service : null, \{ now, queried \}\);/.test(q.apps)) v.push("apps/page: the end of a transition does not ask transitionStep");
  if (!/if \(next !== u\) carriedForward\.set\(uid, \[u, next\]\);/.test(q.apps)
    || !/for \(const \[uid, \[old, fresh\]\] of carriedForward\) \{\s*if \(next\[uid\] !== old\) continue;\s*next\[uid\] = fresh;/.test(q.apps)) v.push("apps/page: deadSince is not carried forward");
  if (/transition === "starting" && service\.running/.test(q.apps)) v.push("apps/page: the old end condition (only running) still stands");
  if (!/const queried = Date\.now\(\);\s*const d = await api/.test(q.pane) || !/const \{ end, next \} = transitionStep\(u, state, \{ now, queried \}\);/.test(q.pane)) v.push("ProjectServicesPane: the end of a transition does not ask transitionStep");
  if (!/if \(next !== u\) carriedForward\.set\(Number\(id\), \[u, next\]\);/.test(q.pane)
    || !/for \(const \[id, \[old, fresh\]\] of carriedForward\) \{\s*if \(next\[id\] !== old\) continue;\s*next\[id\] = fresh;/.test(q.pane)) v.push("ProjectServicesPane: deadSince is not carried forward");
  if (/transition === "starting" && running\)/.test(q.pane)) v.push("ProjectServicesPane: the old end condition (only running) still stands");
  if (!/let queried = Date\(\)\s*if let rows: \[ProjectServiceRow\] = try\? await client\.get\("\/api\/project-services"\)/.test(q.appsIos)
    || !/var further = u\s*guard let end = further\.step\(status, now: now, queried: queried\) else \{\s*if further != u \{ transitions\[key\] = further \}\s*continue\s*\}/.test(q.appsIos)
    || !/deadSince = r\.deadSince\s*return r\.end/.test(q.appsIos)) v.push("AppsPage.swift: the end of a transition does not ask ServiceTransitionRule.step or does not carry deadSince forward");
  if (/u\.kind == \.starts \? status\.running == true/.test(q.appsIos)) v.push("AppsPage.swift: the old end condition (only running) still stands");
  if (!/let queried = Date\(\)\s*do \{\s*let response: ProjectServicesResponse = try await client\.get/.test(q.projectsIos)
    || !/let step = ServiceTransitionRule\.step\(\s*start: run\.kind == "starting", mode: run\.mode, since: run\.since, response: run\.response, deadSince: run\.deadSince,/.test(q.projectsIos)
    || !/guard let end = step\.end else \{\s*if step\.deadSince != run\.deadSince \{ transitions\[id\]\?\.deadSince = step\.deadSince \}\s*continue\s*\}/.test(q.projectsIos)) v.push("ProjectsPane.swift: the end of a transition does not ask ServiceTransitionRule.step or does not carry deadSince forward");
  if (/transitions\[service\.id\] == "starting" && running/.test(q.projectsIos)) v.push("ProjectsPane.swift: the old end condition (only running) still stands");
  // The answer to a start is noted (otherwise a simple start with a dead process ends only at the deadline).
  if (!/withResponse\(u, Date\.now\(\)\)/.test(q.apps) || !/runAction\(uid, "starting", [\s\S]*?\}, param, "simple"\)/.test(q.apps)) v.push("apps/page: the simple start does not note mode or answer");
  if (!/withResponse\(u, Date\.now\(\)\)/.test(q.pane) || !/kind: "starting", since: Date\.now\(\), mode: mode/.test(q.pane)) v.push("ProjectServicesPane: the start does not note mode or answer");
  if (!/responseArrived\(key, u\)/.test(q.appsIos) || !/responseArrived\(u, run\)/.test(q.appsIos)) v.push("AppsPage.swift: start or stack start does not note the answer");
  if (!/if transitions\[service\.id\] == run \{ transitions\[service\.id\]\?\.response = Date\(\) \}/.test(q.projectsIos)) v.push("ProjectsPane.swift: the start does not note the answer");
  // The stop NEXT TO "Starting" as soon as the state is stoppable.
  if (!/const stopInStart = transition === "starting" && c\.running && !c\.unknown;\s*if \(transition && !stopInStart\) return/.test(q.apps)) v.push("apps/page: the stop is missing during \"Starting\"");
  if (!/\{transition === "starting" && !running && !holds \? \(/.test(q.pane)) v.push("ProjectServicesPane: the stop is missing during \"Starting\"");
  if (!/if let transition, !\(transition == \.starts && known && service\.stoppable\) \{/.test(q.appsIos)) v.push("AppsPage.swift: the stop is missing during \"Starting\"");
  if (!/if let transition = transitions\[service\.id\]\?\.kind, !\(transition == "starting" && stoppable\) \{/.test(q.projectsIos)) v.push("ProjectsPane.swift: the stop is missing during \"Starting\"");
  return v;
}

test("Start transition in all views: web Apps and project services, iOS Apps and projects ask the rule; the Swift twin carries the same numbers and lines", () => {
  assert.deepEqual(transitionViolations(readTransition()), []);
});

test("Sabotage (start transition): old end condition, a deviating number or line in the twin, missing answer mark or missing stop are red", () => {
  const q = readTransition();
  const cases = [
    ["sheet", (t) => t.replace("TRANSITION_DEADLINE_MS = 45_000;", "TRANSITION_DEADLINE_MS = 60_000;")],
    ["appsIos", (t) => t.replace("static let lingerSeconds: TimeInterval = 8", "static let lingerSeconds: TimeInterval = 5")],
    ["appsIos", (t) => t.replace("if running { return (.reached, deadSince) }", "if runs || holds { return (.reached, deadSince) }")],
    ["appsIos", (t) => t.replace(`if mode == "simple", !stoppable, let tot,`, `if !stoppable, let tot,`)],
    // The linger time counted from the answer again (the first version), the take-back struck, the fallback without answer check.
    ["appsIos", (t) => t.replace("queried.timeIntervalSince(tot) >= lingerSeconds { return (.ended, tot) }", "queried.timeIntervalSince(response ?? tot) >= lingerSeconds { return (.ended, tot) }")],
    ["appsIos", (t) => t.replace("if let soFar, queried >= soFar { return nil }", "")],
    ["appsIos", (t) => t.replace(`guard mode == "simple", let response, queried >= response else { return soFar }`, `guard mode == "simple" else { return soFar }`)],
    ["appsIos", (t) => t.replace("deadSince = r.deadSince", "_ = r.deadSince")],
    ["apps", (t) => t.replace("const { end, next } = transitionStep(u, service && !service.unknown ? service : null, { now, queried });", "const end = service?.running ? \"reached\" : null; const next = u;")],
    ["apps", (t) => t.replace("applyServices(ps.value, queried);", "applyServices(ps.value, Date.now());")],
    ["apps", (t) => t.replace("withResponse(u, Date.now())", "u")],
    ["apps", (t) => t.replace("if (next !== u) carriedForward.set(uid, [u, next]);", "")],
    ["apps", (t) => t.replace("if (transition && !stopInStart) return", "if (transition) return")],
    ["pane", (t) => t.replace("const { end, next } = transitionStep(u, state, { now, queried });", "const end = stand?.running ? \"reached\" : null; const next = u;")],
    ["pane", (t) => t.replace("next[id] = fresh;", "")],
    ["pane", (t) => t.replace("{transition === \"starting\" && !running && !holds ? (", "{transition === \"starting\" ? (")],
    ["appsIos", (t) => t.replace("guard let end = further.step(status, now: now, queried: queried) else {", "guard status?.running == true, let end = Optional(ServiceTransitionRule.Ende.reached) else {")],
    ["appsIos", (t) => t.replace("if further != u { transitions[key] = further }", "")],
    ["appsIos", (t) => t.replace("responseArrived(u, run)", "_ = run")],
    ["appsIos", (t) => t.replace("if let transition, !(transition == .starts && known && service.stoppable) {", "if let transition {")],
    ["projectsIos", (t) => t.replace("let step = ServiceTransitionRule.step(", "let step = ServiceTransitionRule.stepAlt(")],
    ["projectsIos", (t) => t.replace("response: run.response, deadSince: run.deadSince,", "answer: run.response, deadSince: nil,")],
    ["projectsIos", (t) => t.replace("if step.deadSince != run.deadSince { transitions[id]?.deadSince = step.deadSince }", "")],
    ["projectsIos", (t) => t.replace("if let transition = transitions[service.id]?.kind, !(transition == \"starting\" && stoppable) {", "if let transition = transitions[service.id]?.kind {")],
  ];
  for (const [file, sabotage] of cases) {
    const broken = sabotage(q[file]);
    assert.notEqual(broken, q[file], `sabotage on ${file} did not take: ${sabotage}`);
    assert.notDeepEqual(transitionViolations({ ...q, [file]: broken }), [], `sabotage on ${file} stayed green: ${sabotage}`);
  }
});

// ── "Remove" per service in web and iOS ─────────────────────────────────────────────────────────────────────────────────────────
// A re-scan removes only what it created itself and what neither runs nor stands in the target (store/projects.js scan match).
// What stays — registered by hand, of unknown origin, a duplicate next to a running service — is reported by the bell as "they
// stay", and no surface had a way to take it out (only PATCH; DELETE only via cbase_service_remove of an agent). Now: web
// ProjectServicesPane `removeService`, iOS ProjectsPane `remove` (service sheet and context menu), both
// `DELETE /api/project-services/:id` after a question — and ONLY on a stopped service without transition (the process of a running
// one would stay without a row, and nothing would stop it any more). The server path (duplicate, running, target, by hand):
// server/backend/test/ports-findings.test.js. Counter-test: the two views at the old state => red (no remove); the sabotages below on
// today's sources.
function removeViolations(q) {
  const v = [];
  const web = bodyOf(q.pane, "async function removeService(s: Service)") || "";
  if (!/if \(!ok\) return;/.test(web) || !/const ok = await question\(/.test(web)) v.push("ProjectServicesPane: remove without a question");
  if (!/await api\(`\/api\/project-services\/\$\{s\.id\}`, \{ method: "DELETE" \}\);\s*await load\(\);/.test(web)) v.push("ProjectServicesPane: remove does not call DELETE /api/project-services/:id");
  // The button stands in the branch "stopped": after the stop button, before the start menu, and not during a transition.
  const i = q.pane.indexOf('t("Stop")');
  const j = q.pane.indexOf('label={t("Start")}', i);
  const branch = i < 0 || j < 0 ? "" : q.pane.slice(i, j);
  if (!/\) : \(\s*<>\s*\{!transition && \(\s*<button type="button" onClick=\{\(\) => void removeService\(s\)\}/.test(branch)) v.push("ProjectServicesPane: \"Remove\" not solely in the branch of a stopped service without transition");
  const ios = bodyOf(q.projectsIos, "private func remove(_ service: ProjectServiceDetail) async") || "";
  if (!/try await client\.send\("\/api\/project-services\/\\\(service\.id\)", method: \.delete\)/.test(ios)) v.push("ProjectsPane.swift: remove does not call DELETE /api/project-services/:id");
  const may = bodyOf(q.projectsIos, "private func removable(_ service: ProjectServiceDetail) -> Bool") || "";
  if (!/transitions\[service\.id\] == nil && !\(service\.status\?\.running \?\? false\) && !\(service\.status\?\.holdsStart \?\? false\)/.test(may)) v.push("ProjectsPane.swift: removable does not ask stopped and without transition");
  if (!/remove: removable\(service\) \? \{/.test(q.projectsIos)) v.push("ProjectsPane.swift: the service sheet offers remove without removable");
  if (!/if removable\(service\) \{\s*Button\(role: \.destructive\) \{\s*removeQuestion = service/.test(q.projectsIos)) v.push("ProjectsPane.swift: the context menu offers remove without removable");
  if (!/if let service = removeQuestion \{ Task \{ await remove\(service\) \} \}/.test(q.projectsIos)) v.push("ProjectsPane.swift: the question does not remove");
  return v;
}

test("\"Remove\" per service — web and iOS call DELETE /api/project-services/:id after a question, only on a stopped service", () => {
  assert.deepEqual(removeViolations(readStop()), []);
});

test("Sabotage (remove): remove without DELETE, without a question or on a running service is red", () => {
  const q = readStop();
  const cases = [
    ["pane", (t) => t.replace('{ method: "DELETE" }', '{ method: "PATCH" }')],
    ["pane", (t) => t.replace("if (!ok) return;", "")],
    ["pane", (t) => t.replace("{!transition && (\n", "{(\n")],
    ["projectsIos", (t) => t.replace("method: .delete)\n            await load()", "method: .patch)\n            await load()")],
    ["projectsIos", (t) => t.replace("transitions[service.id] == nil && !(service.status?.running ?? false)", "transitions[service.id] == nil")],
    ["projectsIos", (t) => t.replace("remove: removable(service) ? {", "remove: true ? {")],
    ["projectsIos", (t) => t.replace("if removable(service) {\n                    Button(role: .destructive)", "if true {\n                    Button(role: .destructive)")],
  ];
  for (const [file, sabotage] of cases) {
    const broken = sabotage(q[file]);
    assert.notEqual(broken, q[file], `sabotage on ${file} did not take: ${sabotage}`);
    assert.notDeepEqual(removeViolations({ ...q, [file]: broken }), [], `sabotage on ${file} stayed green: ${sabotage}`);
  }
});
