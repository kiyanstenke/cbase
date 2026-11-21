// Binding of the "Instances" tab: web/src/lib/instances-tree.ts (web) and mobile/CbaseMobile/Code/InstancesTree.swift (iOS) are
// RUN on the SAME cases — tsc and `xcrun swiftc` — and must deliver the same: the read response of GET /api/projects/:pid/instances
// (allowlist, parts with `loaded`, main first, duplicates once), per instance situation, situation of the parts, the actions with
// reason, the service action and the working chats, plus `openParam`, `baseOptions`, `chatInstanceOptions` (field `instance` from
// /api/projects), `copyName` and `chatInstanceName`; also `action` per instance and `actionFrom` (the same shape in the event
// `project/instance`: `stacks` null means "no list", never "no stack"), `asOf` per part and `rowOf` per instance (stack
// running/total, branch, links of the row), `progress` per instance with `copyProgressFrom` (allowlist: a broken core is NO
// progress, single fields fall back to null; main never carries one) and `progressDetail` (what row, detail and pill show) — web
// side in the leaf web/src/lib/api/copy-progress.ts, which instances-tree.ts imports (tsc takes it along); and
// `chatInstanceOptions` delivers at least main in EVERY converted project. macOS only (xcrun; latch.json `onlyMacOS`).
//
// THE FIELD `instance` GOES THROUGH THE APP'S DECODER: the app does not read it raw but via `ProjectInstanceShort.init(from:)`
// (mobile/CbaseMobile/Models/Models.swift, with `LenientEntry` and `ProjectCopyShort`) and `treeField`. The driver compiles
// EXACTLY these types from Models.swift along (excerpt by marker, not copied) and decodes every case like `Project.init`
// (`try? decodeIfPresent(ProjectInstanceShort.self, forKey: .instance)`). The app reads `copies` lenient PER ENTRY like the web,
// and the web takes a field without `state` text as none (like the app — `state` stays required there, the preview link,
// layout and relocation hang on it).
//
// Run:  node --test web/test/instances-tree-binding.test.mjs
// Counter-tests (each turns the named test red):
//   - in InstancesTree.swift `truthy` as `(x as? NSNumber)?.boolValue == true` alone (a 1 would be a truth value);
//   - `openParam` with Swift's `sort()` instead of UTF-16 ordering (only with the Unicode cases "～/😀/é/e+◌́" — without them
//     this sabotage stayed green; equality over UTF-16 like a JS `Set`, not Swift's canonical equivalence);
//   - `actionsOf` without the `waitingStart` check at start;
//   - `chatInstanceOptions` without "stopped" in `liveInstance`;
//   - Models.swift `copies` as a whole again (`try? c.decodeIfPresent([ProjectCopyShort].self, …)`) (field 6: the app offered no choice);
//   - InstancesTree.swift `chatInstanceOptions` without the check `copyState == copyReady` (field 6: copy-k8 being cleared away);
//   - InstancesTree.swift `linkStopped` without "stop";
//   - `actionFrom` with `stacks` as `[]` instead of nil when the field is no list (case "dismiss" with `stacks: "x"`);
//   - `progressDetail` with `restMin` also at `overrun` (case `overrun: true, restMs: 0`);
//   - `copyProgressFrom` without the check `step <= steps` (case `step: 7`);
//   - `chatInstanceOptions` again with `if copies.isEmpty { return [] }` (field 5: converted without a copy).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const SOURCE_TS = path.join(webDir, "src", "lib", "instances-tree.ts");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Code", "InstancesTree.swift");
const MODELS_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Models", "Models.swift");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const BUFFER = 64 * 1024 * 1024;

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
const tmpDir = () => (tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "cbase-instances-tree-binding-")));

// ── The cases ───────────────────────────────────────────────────────────────────────────────────────
const copy = (n, state, more = {}) => ({ name: `copy-${n}`, identifier: `p1/copy-${n}`, state, ...more });
// The progress of a copy (projectbox/copy-progress.js) — valid, with stage, overrun, broken.
const F_OK = { kind: "create", reason: "", step: 3, steps: 6, phase: "clone2", stage: null, begin: 1000, share: 0.41, restMs: 200000, estimateMs: 380000, overrun: false };
const F_WAITING = { kind: "waiting", reason: "queue", step: 0, steps: 6, phase: "", stage: null, begin: 5, share: null, restMs: null, estimateMs: null, overrun: false };
const PROGRESS_ITEMS = [
  null, undefined, "x", [], {}, F_WAITING, { kind: "waiting", reason: "storage", step: 0, steps: 6 },
  { kind: "waiting", reason: "different", step: 0, steps: 6 }, { kind: "waiting", step: 0, steps: 6 }, { ...F_WAITING, reason: "" },
  F_OK,
  { ...F_OK, step: 6, phase: "start", stage: { seq: 2, from: 3 }, share: 0.9, restMs: 59000 },
  { ...F_OK, step: 6, phase: "start", stage: { seq: 0, from: 3 } }, { ...F_OK, stage: { seq: 3, from: 2 } }, { ...F_OK, stage: { seq: 1.5, from: 2 } },
  { ...F_OK, stage: "2/3" }, { ...F_OK, stage: { seq: "2", from: 3 } }, { ...F_OK, stage: { seq: 3, from: 3 } },
  { ...F_OK, share: 1.2, restMs: -5, estimateMs: "5" }, { ...F_OK, share: "0.5", restMs: "100", begin: "1" }, { ...F_OK, share: 0, restMs: 0 },
  { ...F_OK, share: 1 }, { ...F_OK, share: -0.1 }, { ...F_OK, overrun: true, restMs: 0, share: 0.97 }, { ...F_OK, overrun: 1 },
  { ...F_OK, overrun: "true" }, { ...F_OK, step: 7 }, { ...F_OK, step: -1 }, { ...F_OK, step: 2.5 }, { ...F_OK, steps: 0, step: 0 },
  { ...F_OK, step: true }, { ...F_OK, step: "3" }, { ...F_OK, steps: 1e20 }, { ...F_OK, step: 0, phase: "unknown" },
  { ...F_OK, kind: "finished" }, { ...F_OK, kind: 1 }, { ...F_OK, phase: 5 }, { ...F_OK, restMs: 1234567 }, { ...F_OK, restMs: 60000 },
  { ...F_OK, restMs: 60001 }, { ...F_OK, begin: null, estimateMs: null }, { ...F_OK, foreign: [1], reason: "queue" },
];
// Without a (valid) progress the detail is calculated from the state alone (an older server).
const STATES = ["build", "create", "waiting_queue", "waiting_storage", "ready", "error", "clearAway", "", "BUILD"];
const MAIN_FULL = {
  name: "main", identifier: "p1/main", state: "ready", phase: "", error: "", waiting: null, cpu: 0.4, memBytes: 123456789,
  createdOf: null, base: null,
  container: { loaded: true, open: true, error: "", asOf: 1700000000999, list: [
    { name: "web", service: "web", running: true, status: "Up 3 hours" }, { service: "without-name", running: true }, null, "x",
    { name: "db", service: "db", running: 1, status: 5 },
  ] },
  repos: { loaded: true, open: true, error: "", asOf: "1700000000999", list: [
    { rel: "frontend-front", branch: "feat/x", detached: false, open: 0 },
    { rel: "", branch: "main", detached: false, open: 2 },
    { rel: "frontend", branch: "abc1234", detached: true, open: "3", error: "status not readable" },
    { rel: 5, branch: "x" }, { branch: "without-rel" },
  ] },
  services: [
    { id: 7, name: "Web", port: 3000, running: true, holdsStart: false, startable: true, link: { id: 9, url: "https://a.ngrok.app", procedure: 1700000000000, state: "online" } },
    { id: "8", name: "Api", port: null, running: false, holdsStart: false, startable: true, link: { id: "", url: "x" } },
    { id: "", name: "empty" }, { id: 3.5, name: "Fraction", startable: "true" }, { name: "without id" }, { id: true, name: "bool" },
    { id: 12, name: "Held", running: false, holdsStart: true, startable: false, link: "not an object" },
  ],
  chats: [{ id: "c1", title: "Running", running: true }, { id: "c2", title: null, running: 1 }, { id: 5, title: "count" }, { id: "c3", title: "Idle", running: false }],
  action: { kind: "stack-restart", running: false, since: 10, end: 20, ok: false, error: "db: broken",
    stacks: [{ project: "web", ok: true, error: null }, { project: "db", ok: false, error: "broken" }, null, { ok: true }, { project: 5 }, "x"] },
  // main never arises — a progress on main is a server error and is not read.
  progress: F_OK,
};
// The action on an instance — the same cases via `actionFrom` (tree field and event `project/instance`).
const ACTIONS = [
  null, undefined, "x", [], {}, { kind: "" }, { kind: 5 }, { kind: "branch", running: true, since: 5 },
  { kind: "dismiss", running: 1, since: "5", end: Infinity, ok: "true", error: 3, stacks: "x" },
  { kind: "stack-restart", running: true, since: 1.5, stacks: [] }, { kind: "stack-restart", running: false, ok: true, stacks: [{ project: "a", ok: 1 }] },
  { kind: "branch", running: false, ok: false, error: "Exit 1", stacks: null }, { kind: "unknown-xyz", ok: true },
];
const COPIES = [
  copy("k1", "stopped", { waiting: { reason: "storage", since: 100 }, container: { loaded: false, open: true, error: "container stopped" },
    repos: { loaded: false, open: true, error: "" }, createdOf: { chatId: "c9", title: "Agent" }, base: "main",
    services: [{ id: 1, name: "Web", port: 3000, startable: false }], chats: [] }),
  copy("k2", "stopped", { services: [{ id: 1, name: "Web", startable: true }] }),
  copy("k3", "clearAway", { container: { loaded: true, list: [{ name: "web", running: false }] }, repos: { loaded: true, list: [{ rel: "" }] } }),
  copy("k4", "waiting_queue", { waiting: { reason: "queue", since: null }, createdOf: { chatId: "" }, repos: { loaded: true, list: [] },
    container: { loaded: true, list: [], error: "part failed" }, progress: F_WAITING }),
  copy("k5", "start", { container: "broken", repos: null }),
  copy("k6", "error", { error: "build failed", createdOf: { chatId: "c7", title: 4 } }),
  copy("k7", "build", { phase: "clone2", waiting: { reason: "different" }, progress: F_OK }),
  copy("k8", "stop", { chats: [{ id: "c4", title: "Running", running: true }] }),
  copy("k9", "recreate"), copy("k10", "relocation"), copy("k11", "create", { progress: { kind: "broken" } }),
  copy("k12", "waiting_storage", { progress: { kind: "waiting", reason: "storage", step: 0, steps: 6, begin: "x" } }),
  copy("k13", "unknown-xyz"), { name: "copy-k14", identifier: "p1/copy-k14" },
  copy("k15", "ready", { repos: { loaded: true, open: true, error: "one broken", list: [{ rel: "", branch: "main", open: 0 }] },
    cpu: "0.4", memBytes: true, base: "copy-k2" }),
  copy("k16", "ready", { services: [
    { id: 1, name: "Held", running: false, holdsStart: true, startable: true }, { id: 2, name: "Without", running: false, startable: false },
    { id: 3, name: "With", running: false, startable: true }, { id: 4, name: "Running", running: true, startable: false },
  ], chats: [{ id: "c5", title: "a", running: true }, { id: "c6", title: "b", running: true }] }),
  copy("k17", "stopped", { waiting: { reason: "queue", since: 5 } }),
  copy("k18", "ready", { repos: { loaded: true, open: true, list: [] } }),
  ...ACTIONS.map((a, n) => copy(`a${n}`, "ready", { action: a })),
];
const TREES = [
  null, {}, "tree", [], { loaded: false, instances: [] }, { loaded: true }, { loaded: "true", instances: [] }, { loaded: 1, instances: [] },
  { loaded: true, instances: [] },
  { loaded: true, ops: false, asOf: 1700000000123, instances: [COPIES[0], MAIN_FULL, ...COPIES.slice(1),
    { ...COPIES[0], state: "ready" }, { ...MAIN_FULL, state: "error" },
    { name: "k2", state: "ready" }, { name: "copy-", state: "ready" }, { name: "", state: "ready" }, { name: 5 }, null, "x", [1]] },
  { loaded: true, ops: 0, asOf: "5", instances: [copy("a", "ready"), { name: "main", state: "stopped" }] },
  { loaded: true, ops: "no", instances: [{ name: "main", state: "start", waiting: { reason: "storage", since: 1 } }] },
  { loaded: true, instances: [copy("é", "ready"), copy("e\u0301", "ready"), copy("é", "error")] },
];
const OPEN = [
  [], ["main"], ["copy-k2", "main", "copy-k2", ""], ["copy-zz", "main"], ["Zeta", "alpha", "copy-k1"],
  ["copy-k10", "copy-k9", "copy-k1"], ["ä", "z", "Ä", "copy-k15"], ["～", "😀", "é", "e\u0301", "copy-é", "copy-e\u0301"],
];
// `state` of the instance row, `copyState` that of the copy row (projectbox/names.js projectInstanceField).
const k = (n, state, copyState = "ready") => ({ identifier: `p1/copy-${n}`, state, copyState });
const FIELDS = [
  null, {}, { identifier: "p1/main", state: "ready", converted: false, copies: [k("k1", "ready")] }, { identifier: "p1/main", state: "ready", converted: "true", copies: [k("k1", "ready")] },
  { identifier: "p1/main", state: "ready", converted: 1, copies: [k("k1", "ready")] }, { identifier: "p1/main", state: "ready", converted: true },
  { identifier: "p1/main", converted: true, state: "ready", copies: [
    k("k1", "ready"), k("k2", "start"), k("k3", "stopped"), k("k4", "create"), k("k5", "clearAway"), k("k6", "error"),
    { identifier: "p2/copy-x", state: "ready", copyState: "ready" }, { identifier: "p1/main", state: "ready", copyState: "ready" },
    { identifier: "p1/copy-", state: "ready", copyState: "ready" },
    null, "x", 5, [k("k9", "ready")], { state: "ready", copyState: "ready" }, { identifier: 5, state: "ready", copyState: "ready" },
    { identifier: "p1/copy-k7", state: 1, copyState: "ready" }, k("k1", "ready"),
    // The real case: instance row `ready`, copy row being cleared away or failed; without or with a broken `copyState`.
    k("k8", "ready", "clearAway"), k("k10", "ready", "error"), k("k11", "ready", ""), { identifier: "p1/copy-k12", state: "ready" },
    { identifier: "p1/copy-k13", state: "ready", copyState: 1 }, { identifier: "p1/copy-k14", state: "stopped", copyState: "ready", foreign: [1] },
  ] },
  { identifier: "p1/main", state: "ready", converted: true, copies: null }, { identifier: "p1/main", state: "ready", converted: true, copies: "x" },
  { identifier: "p1/main", state: "ready", converted: true, copies: [k("k4", "create")] },
  { identifier: "a/b/main", state: "stopped", converted: true, copies: [{ identifier: "a/b/copy-k1", state: "start", copyState: "ready" }, { identifier: "a/copy-k2", state: "ready", copyState: "ready" }] },
  { identifier: "/main", state: "ready", converted: true, copies: [{ identifier: "/copy-k1", state: "ready", copyState: "ready" }] },
  { identifier: "main", state: "ready", converted: true, copies: [k("k1", "ready")] }, { identifier: "p1/copy-k1", state: "ready", converted: true, copies: [k("k1", "ready")] },
  { identifier: 7, state: "ready", converted: true, copies: [k("k1", "ready")] },
  // A field without `state` text is none for the app (`state` is required) — and for the web likewise.
  { identifier: "p1/main", converted: true, state: 3, copies: [k("k1", "stopped")] }, { identifier: "p1/main", converted: true, copies: [k("k1", "ready")] },
  // A `copies` that is broken as a whole costs only the copies, not the field.
  { identifier: "p1/main", state: "ready", converted: true, copies: { k1: k("k1", "ready") } },
];
const NAMES = ["main", "copy-k1", "copy-", "copy", "copy-a-b", "Clone-k1", "", "  copy-k2  ", "\tclone-k3\n", "copy-copy-x"];

function runWeb(file) {
  const out = path.join(tmpDir(), "web");
  execFileSync(process.execPath, [tsc, SOURCE_TS, "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  const driver = path.join(out, "driver.mjs");
  fs.writeFileSync(driver, `import fs from "node:fs";
import { readTree, openParam, situationOf, partSituation, actionsOf, actionFrom, serviceAction, linkStopped, workingChats, baseOptions, chatInstanceOptions, chatInstanceName, copyName, rowOf, copyProgressFrom, progressDetail } from "./instances-tree.js";
const { trees, open, fields, names, actions, progressItems, states } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const results = trees.map((raw) => {
  const tree = readTree(raw);
  if (!tree) return { tree: null, open: open.map((o) => openParam(o, null)) };
  return {
    tree,
    perInstance: tree.instances.map((i) => ({ situation: situationOf(i), container: partSituation(i.container), repos: partSituation(i.repos), actions: actionsOf(i),
      services: i.services.map((d) => serviceAction(d, i)), linkStopped: linkStopped(i), arbeitend: workingChats(i).map((c) => c.id), row: rowOf(i),
      detail: progressDetail(i.progress, i.state) })),
    base: baseOptions(tree),
    open: open.map((o) => openParam(o, tree)),
  };
});
console.log(JSON.stringify({ results, withoutTree: open.map((o) => openParam(o, null)), baseWithout: baseOptions(null),
  fields: fields.map((f) => chatInstanceOptions(JSON.parse(f).instance ?? null)), copy: names.map((n) => copyName(n)),
  chat: [...names, null].map((n) => chatInstanceName(n)), action: actions.map((a) => actionFrom(a)),
  progress: progressItems.map((f) => copyProgressFrom(f)), detail: progressItems.map((f) => progressDetail(copyProgressFrom(f), "build")),
  without: states.map((z) => progressDetail(null, z)) }));
`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return JSON.parse(execFileSync(process.execPath, [driver, file], { encoding: "utf8", env, maxBuffer: BUFFER }).trim().split("\n").pop());
}

// The types through which the app reads the field `instance` — the excerpt from Models.swift from `struct ProjectInstanceShort` to
// the end of `struct ProjectCopyShort` (byte-exact, not copied): ProjectInstanceShort, its extension with `init(from:)`,
// LenientEntry, ProjectCopyShort. If one of them is missing from the excerpt, the marker has moved — red, instead of silently
// checking a different decoder.
function modelExcerpt() {
  const text = fs.readFileSync(MODELS_SWIFT, "utf8");
  const beginning = text.indexOf("struct ProjectInstanceShort:");
  const last = text.indexOf("struct ProjectCopyShort:", beginning);
  const end = last < 0 ? -1 : text.indexOf("\n}\n", last);
  assert.ok(beginning >= 0 && last > beginning && end > last, "Models.swift: ProjectInstanceShort … ProjectCopyShort not found — the marker has moved");
  const chunk = text.slice(beginning, end + 3);
  for (const must of ["extension ProjectInstanceShort", "init(from decoder: Decoder)", "var treeField: InstancesTree.Field", "struct LenientEntry", "struct ProjectCopyShort:"]) {
    assert.ok(chunk.includes(must), `the excerpt from Models.swift does not carry “${must}” — the binding checked a different decoder`);
  }
  return chunk;
}

function runIos(file) {
  const source = fs.readFileSync(SOURCE_SWIFT, "utf8");
  assert.deepEqual(source.split("\n").filter((z) => /^import /.test(z)), ["import Foundation"], "InstancesTree.swift imports only Foundation — otherwise it cannot be bound");
  assert.ok(!/\bL\(/.test(source.replace(/\/\/.*$/gm, "")), "InstancesTree.swift does not translate itself (no L(…))");
  const swift = path.join(tmpDir(), "binding.swift");
  fs.writeFileSync(swift, `${source}

${modelExcerpt()}

typealias IB = InstancesTree
func nn(_ v: Any?) -> Any { v ?? NSNull() }
func part<T>(_ t: IB.Part<T>, _ f: (T) -> Any) -> Any { ["loaded": t.loaded, "open": t.open, "error": t.error, "list": t.list.map(f), "asOf": nn(t.asOf)] as [String: Any] }
func rowJ(_ z: IB.Row) -> Any {
    [
        "stack": z.stack.map { ["run": $0.run, "total": $0.total, "down": $0.down] as [String: Any] } ?? NSNull(),
        "branch": z.branch.map { ["name": $0.name, "detached": $0.detached, "changed": $0.changed, "additional": $0.additional] as [String: Any] } ?? NSNull(),
        "links": z.links.map { ["service": $0.service, "port": nn($0.port), "stopped": $0.stopped] as [String: Any] },
    ] as [String: Any]
}
func stageJ(_ s: IB.Stage?) -> Any { s.map { ["seq": $0.seq, "from": $0.from] as [String: Any] } ?? NSNull() }
func progressJ(_ f: IB.CopyProgress?) -> Any {
    guard let f else { return NSNull() }
    return ["kind": f.kind, "reason": f.reason, "step": f.step, "steps": f.steps, "phase": f.phase, "stage": stageJ(f.stage),
            "begin": nn(f.begin), "share": nn(f.share), "restMs": nn(f.restMs), "estimateMs": nn(f.estimateMs), "overrun": f.overrun] as [String: Any]
}
func detailJ(_ a: IB.ProgressDetail?) -> Any {
    guard let a else { return NSNull() }
    return ["kind": a.kind, "step": a.step, "steps": a.steps, "phase": a.phase, "stage": stageJ(a.stage), "share": nn(a.share),
            "restMin": nn(a.restMin), "overrun": a.overrun] as [String: Any]
}
func verf(_ v: IB.Available) -> Any { ["on": v.on, "reason": nn(v.reason?.rawValue)] as [String: Any] }
func option(_ o: IB.Option) -> Any { ["name": o.name, "identifier": o.identifier, "state": o.state] }
func instance(_ i: IB.Instance) -> Any {
    [
        "name": i.name, "identifier": i.identifier, "state": i.state, "phase": i.phase, "error": i.error,
        "waiting": i.waiting.map { ["reason": $0.reason, "since": nn($0.since)] as [String: Any] } ?? NSNull(),
        "cpu": nn(i.cpu), "memBytes": nn(i.memBytes),
        "createdOf": i.createdOf.map { ["chatId": $0.chatId, "title": nn($0.title)] as [String: Any] } ?? NSNull(),
        "base": nn(i.base),
        "container": part(i.container) { ["name": $0.name, "service": $0.service, "running": $0.running, "status": $0.status] as [String: Any] },
        "repos": part(i.repos) { ["rel": $0.rel, "branch": $0.branch, "detached": $0.detached, "open": $0.open, "error": $0.error] as [String: Any] },
        "services": i.services.map { d -> Any in
            ["id": d.id, "name": d.name, "port": nn(d.port), "running": d.running, "holdsStart": d.holdsStart, "startable": d.startable,
             "link": d.link.map { ["id": $0.id, "url": $0.url, "procedure": nn($0.procedure), "state": $0.state] as [String: Any] } ?? NSNull()] as [String: Any]
        },
        "chats": i.chats.map { ["id": $0.id, "title": $0.title, "running": $0.running] as [String: Any] },
        "action": i.action.map(actionJ) ?? NSNull(),
        "progress": progressJ(i.progress),
    ] as [String: Any]
}
func actionJ(_ a: IB.Action) -> Any {
    ["kind": a.kind, "running": a.running, "since": nn(a.since), "end": nn(a.end), "ok": a.ok, "error": a.error,
     "stacks": a.stacks.map { $0.map { ["project": $0.project, "ok": $0.ok, "error": $0.error] as [String: Any] } } ?? NSNull()] as [String: Any]
}
func actions(_ a: IB.Actions) -> Any {
    ["stop": verf(a.stop), "start": verf(a.start), "abortStart": verf(a.abortStart), "erase": verf(a.erase),
     "branch": verf(a.branch), "chat": verf(a.chat), "code": verf(a.code), "terminal": verf(a.terminal), "asBase": verf(a.asBase)] as [String: Any]
}
// How Project.init (Models.swift) reads the field: (try? c.decodeIfPresent(ProjectInstanceShort.self, forKey: .instance)) ?? nil.
struct ProjectWithInstance: Decodable {
    let instance: ProjectInstanceShort?
    enum CodingKeys: String, CodingKey { case instance }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        instance = (try? c.decodeIfPresent(ProjectInstanceShort.self, forKey: .instance)) ?? nil
    }
}
func fieldOf(_ json: String) -> IB.Field? {
    (try! JSONDecoder().decode(ProjectWithInstance.self, from: Data(json.utf8))).instance?.treeField
}
let root = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
let open = (root["open"] as! [[String]])
let results: [Any] = (root["trees"] as! [Any]).map { raw in
    guard let tree = IB.readTree(raw is NSNull ? nil : raw) else {
        return ["tree": NSNull(), "open": open.map { nn(IB.openParam($0, nil)) }] as [String: Any]
    }
    return [
        "tree": ["ops": tree.ops, "asOf": tree.asOf, "instances": tree.instances.map(instance)] as [String: Any],
        "perInstance": tree.instances.map { i in
            ["situation": IB.situationOf(i).rawValue, "container": IB.partSituation(i.container).rawValue, "repos": IB.partSituation(i.repos).rawValue,
             "actions": actions(IB.actionsOf(i)), "services": i.services.map { IB.serviceAction($0, i).rawValue }, "linkStopped": IB.linkStopped(i),
             "arbeitend": IB.workingChats(i).map(\\.id), "row": rowJ(IB.rowOf(i)),
             "detail": detailJ(IB.progressDetail(i.progress, state: i.state))] as [String: Any]
        },
        "base": IB.baseOptions(tree).map(option),
        "open": open.map { nn(IB.openParam($0, tree)) },
    ] as [String: Any]
}
let names = root["names"] as! [String]
let result: [String: Any] = [
    "results": results,
    "withoutTree": open.map { nn(IB.openParam($0, nil)) },
    "baseWithout": IB.baseOptions(nil).map(option),
    "fields": (root["fields"] as! [String]).map { IB.chatInstanceOptions(fieldOf($0)).map(option) },
    "copy": names.map { nn(IB.copyName($0)) },
    "chat": (names.map { Optional($0) } + [nil]).map { IB.chatInstanceName($0) },
    "action": (root["actions"] as! [Any]).map { a in IB.actionFrom(a is NSNull ? nil : a).map(actionJ) ?? NSNull() },
    "progress": (root["progressItems"] as! [Any]).map { f in progressJ(IB.copyProgressFrom(f is NSNull ? nil : f)) },
    "detail": (root["progressItems"] as! [Any]).map { f in detailJ(IB.progressDetail(IB.copyProgressFrom(f is NSNull ? nil : f), state: "build")) },
    "without": (root["states"] as! [String]).map { z in detailJ(IB.progressDetail(nil, state: z)) },
]
print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
`);
  const bin = path.join(tmpDir(), "binding");
  execFileSync("xcrun", ["swiftc", "-O", swift, "-o", bin], { stdio: "pipe" });
  return JSON.parse(execFileSync(bin, [file], { encoding: "utf8", maxBuffer: BUFFER }).trim().split("\n").pop());
}

test("Binding: web and iOS read the instance tree the same — allowlist, situations, actions, services, open, base, chat instance choice", () => {
  const file = path.join(tmpDir(), "cases.json");
  // Every field as a response piece `{"instance": …}` — that is how the app reads it (Project.init) and the page (`list.find(…)?.instance ?? null`).
  fs.writeFileSync(file, JSON.stringify({ trees: TREES, open: OPEN, fields: FIELDS.map((f) => JSON.stringify({ instance: f })), names: NAMES, actions: ACTIONS,
    progressItems: PROGRESS_ITEMS, states: STATES }));
  const web = runWeb(file);
  const ios = runIos(file);

  // The cases measure something: a full tree, every situation, every part situation, every service action, every reason, options with copies.
  assert.equal(web.results.length, TREES.length);
  const full = web.results.find((a) => a.tree && a.tree.instances.length > 10);
  assert.ok(full, "no full tree among the cases — the binding measures nothing");
  assert.equal(full.tree.instances[0].name, "main", "main is not first");
  const positions = new Set(web.results.flatMap((a) => (a.perInstance || []).map((j) => j.situation)));
  for (const l of ["ready", "starts", "stops", "stopped", "waiting", "build", "clearAway", "error", "unknown"]) assert.ok(positions.has(l), `no instance in the situation ${l}`);
  const parts = new Set(web.results.flatMap((a) => (a.perInstance || []).flatMap((j) => [j.container, j.repos])));
  for (const t of ["closed", "loading", "error", "empty", "list"]) assert.ok(parts.has(t), `no part in the situation ${t}`);
  const services = new Set(web.results.flatMap((a) => (a.perInstance || []).flatMap((j) => j.services)));
  for (const d of ["stop", "start", "startCommand", "no"]) assert.ok(services.has(d), `no service action ${d}`);
  const reasons = new Set(web.results.flatMap((a) => (a.perInstance || []).flatMap((j) => Object.values(j.actions).map((v) => v.reason))).filter(Boolean));
  for (const g of ["not-ready", "not-stopped", "start-waiting", "no-waiting-start", "main", "gets-cleared-away", "no-repos", "repos-closed"]) {
    assert.ok(reasons.has(g), `no case with the reason ${g}`);
  }
  assert.ok(web.fields.some((o) => o.length > 2), "no chat instance choice with several copies");
  // The real case measures something — in the mixed field there is no copy whose copy row is not `ready`.
  assert.deepEqual(web.fields[6].map((o) => o.name), ["main", "copy-k1", "copy-k2", "copy-k3", "copy-k1", "copy-k14"], JSON.stringify(web.fields[6]));
  assert.ok(web.results.some((a) => (a.perInstance || []).some((j) => j.linkStopped)) && web.results.some((a) => (a.perInstance || []).some((j) => !j.linkStopped)), "linkStopped measures only one side");
  assert.ok(web.results.some((a) => a.open.some((o) => o && o.includes(","))), "openParam never names several instances");
  // rowOf: the cases measure something — a stack with one not running, one unread, a branch of the project folder BEHIND another repo
  // (the project folder wins), with open files and further repos, links, `asOf` as a number and as null.
  const rows = web.results.flatMap((a) => (a.perInstance || []).map((j) => j.row));
  assert.ok(rows.some((z) => z.stack && z.stack.run < z.stack.total && z.stack.down.length > 0), "no stack with one not running");
  assert.ok(rows.some((z) => z.stack === null) && rows.some((z) => z.branch === null), "no unread part in the row");
  assert.deepEqual(full.perInstance[0].row.branch, { name: "main", detached: false, changed: true, additional: 2 }, "the row's branch is not the project folder's");
  assert.ok(rows.some((z) => z.links.length > 0 && z.links.every((l) => l.service)), "no row with a link");
  assert.equal(full.tree.instances[0].container.asOf, 1700000000999, "asOf as a number");
  assert.equal(full.tree.instances[0].repos.asOf, null, "asOf as text is not a number");

  for (let i = 0; i < TREES.length; i++) assert.deepEqual(ios.results[i], web.results[i], `tree ${i}: ${JSON.stringify(TREES[i]).slice(0, 160)}`);
  assert.deepEqual(ios.withoutTree, web.withoutTree, "openParam without tree");
  assert.deepEqual(ios.baseWithout, web.baseWithout, "baseOptions without tree");
  for (let i = 0; i < FIELDS.length; i++) assert.deepEqual(ios.fields[i], web.fields[i], `chatInstanceOptions ${i}: ${JSON.stringify(FIELDS[i])}`);
  assert.deepEqual(ios.copy, web.copy, "copyName");
  assert.deepEqual(ios.chat, web.chat, "chatInstanceName");
  // The action — the cases measure something (a running one, one with stacks, one without a list, a discarded one).
  const acts = web.action;
  assert.equal(acts.length, ACTIONS.length);
  assert.ok(acts.some((a) => a?.running === true), "no running action among the cases");
  assert.ok(acts.some((a) => Array.isArray(a?.stacks) && a.stacks.length > 0), "no action with stacks");
  assert.ok(acts.some((a) => a && a.stacks === null), "no action without a list (stacks null)");
  assert.ok(acts.some((a) => Array.isArray(a?.stacks) && a.stacks.length === 0), "no action with an empty list (no stack)");
  assert.ok(acts.filter((a) => a === null).length >= 5, "too few discarded shapes");
  assert.ok(full.tree.instances[0].action?.stacks?.length === 2, "the action in the full tree does not measure the stacks allowlist");
  assert.deepEqual(ios.action, web.action, "actionFrom");

  // The instance choice of a converted project without a ready copy is main alone (the button stands, "Create copy …" below) — not empty;
  // a not converted or broken field stays empty.
  assert.deepEqual(web.fields[5].map((o) => o.name), ["main"], "converted without a copy: no choice (previously empty — the button was missing)");
  assert.deepEqual(web.fields[9].map((o) => o.name), ["main"], "converted, the copy is still arising: main alone");
  assert.deepEqual([web.fields[0], web.fields[2], web.fields[3]], [[], [], []], "a not converted field offers a choice");
  // The progress: the cases measure something — valid, waiting, with stage, overrun, broken core (null), broken fields (null beside it).
  const fw = web.progress;
  assert.equal(fw.length, PROGRESS_ITEMS.length);
  assert.ok(fw.filter((f) => f === null).length >= 15, "too few discarded shapes of the progress");
  assert.deepEqual(fw[PROGRESS_ITEMS.indexOf(F_OK)], F_OK, "a valid progress does not arrive unchanged");
  assert.ok(fw.some((f) => f?.stage?.seq === 2) && fw.some((f) => f && f.stage === null && f.phase === "start"), "no (discarded) stage among the cases");
  assert.ok(fw.some((f) => f && f.share === null && f.kind === "create"), "no discarded share");
  const aw = web.detail;
  for (const kind of ["queue", "storage", "step", "create"]) assert.ok(aw.some((a) => a?.kind === kind), `no detail of the kind ${kind}`);
  assert.ok(aw.some((a) => a?.overrun && a.restMin === null), "overrun names a remaining time");
  assert.deepEqual(aw.filter((a) => a?.restMin != null).map((a) => a.restMin).sort((x, y) => x - y).slice(0, 3), [1, 1, 1], "the remaining time does not round up to at least one minute");
  assert.ok(aw.some((a) => a?.restMin === 21), "the remaining time does not round up");
  assert.deepEqual(web.without.map((a) => a?.kind ?? null), ["create", "create", "queue", "storage", null, null, null, null, null], "the detail without progress reads the state wrongly");
  // In the tree: main never carries a progress, the copies theirs (or null if it is broken).
  assert.equal(full.tree.instances[0].progress, null, "main carries a progress");
  const k7 = full.tree.instances.find((i) => i.name === "copy-k7");
  assert.deepEqual([k7?.progress?.step, full.perInstance[full.tree.instances.indexOf(k7)].detail?.kind], [3, "step"], "the progress of an arising copy is missing in the tree");
  assert.equal(full.tree.instances.find((i) => i.name === "copy-k11")?.progress, null, "a broken progress in the tree was read");
  assert.equal(full.tree.instances.find((i) => i.name === "copy-k12")?.progress?.begin, null, "a broken field stayed");
  assert.deepEqual(ios.progress, web.progress, "copyProgressFrom");
  assert.deepEqual(ios.detail, web.detail, "progressDetail");
  assert.deepEqual(ios.without, web.without, "progressDetail without progress");
});
