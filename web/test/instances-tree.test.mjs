// What the "Instances" tab shows. The leaf web/src/lib/instances-tree.ts is compiled with tsc and RUN. The promises, each with
// the way that breaks it:
//   (a) Empty is not unknown: a part without `loaded` is never an empty list (situation closed/loading/error), a broken tree is
//       `null` (not "no instances"); foreign fields drop, main comes first;
//   (b) `?open=` carries only names the tree knows, sorted; without names no parameter;
//   (c) the situation: every state of instance and copy row has exactly one; a waiting start (stopped + storage) is "waiting";
//   (d) the actions: stop/code/terminal/base only when ready, start only when stopped without a waiting start, abort only with
//       one, delete never main and never while clearing away, branch only with loaded repos, chat also into a stopped instance;
//   (e) the service row: a running or held service offers stopping even if the instance is not ready; an instance without a
//       start command "startCommand" — copy like main (`startable` is calculated by the server for both from the command; the
//       guard there is server/backend/test/instances-tree.test.js (4)); `linkStopped` for stopped, stopping and starting, also
//       a waiting start;
//   (f) the instance choice of a chat: only converted projects; the copies only if runs/instance-switch.js instanceChoice accepts
//       them — copy row `ready` AND instance row alive (ready, start, stopped) —, main first, foreign identifiers dropped;
//       `chatInstanceName` reads NULL/"" as main. The real case: instance row `ready`, copy row `clearAway` (marked) or `error`
//       => dropped. A converted project WITHOUT a selectable copy is `[main]`, not empty — the choice then stands with "Create
//       copy …" (the cases "no copy", "no living one", "only ones to clear away" are therefore in the list "main alone").
//
// Counter-tests: in `partFrom` `loaded` replaced by `true` => (a) red; in `actionsOf` the `waitingStart` branch at start removed
// => (d) red; in `chatInstanceOptions` the LIVE_INSTANCE filter removed => (f) red; the check `k?.copyState === COPY_READY`
// removed => (f) red (a copy being cleared away stood in the choice); `linkStopped` without "start" => (e) red.
//
// Run:  node --test web/test/instances-tree.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const SOURCE = path.join(webDir, "src", "lib", "instances-tree.ts");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });

let module = null;
async function load() {
  if (module) return module;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-instances-tree-"));
  execFileSync(process.execPath, [tsc, SOURCE, "--outDir", tmp, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  module = await import(pathToFileURL(path.join(tmp, "instances-tree.js")).href);
  return module;
}

const P = "p1";
const to = { loaded: false, open: false };
const inst = (name, o = {}) => ({
  name, identifier: `${P}/${name}`, state: "ready", phase: "", error: "", waiting: null, cpu: 0.5, memBytes: 1024, createdOf: null,
  base: name === "main" ? null : "main", container: to, repos: to, services: [], chats: [], ...o,
});
const treeRaw = (instances) => ({ loaded: true, ops: true, asOf: 1, instances });

test("(a) Empty is not unknown: parts without `loaded` are no clear lists; broken => null; main first", async () => {
  const { readTree, partSituation } = await load();
  for (const raw of [null, undefined, 3, "x", [], {}, { loaded: false, instances: [] }, { loaded: true }, { loaded: true, instances: {} }]) {
    assert.equal(readTree(raw), null, JSON.stringify(raw));
  }
  const b = readTree(treeRaw([
    inst("copy-k1", { container: { loaded: false, open: true }, repos: { loaded: false, open: true, error: "Container is stopped" } }),
    inst("main", { container: { loaded: true, list: [{ name: "web", service: "web", running: true, status: "Up", secret: 1 }] }, repos: { loaded: true, list: [] } }),
    inst("main"),
    { name: "garbage" }, null, inst("copy-"),
  ]));
  assert.deepEqual(b.instances.map((i) => i.name), ["main", "copy-k1"]);
  const [h, k] = b.instances;
  assert.equal(partSituation(h.container), "list");
  assert.deepEqual(h.container.list, [{ name: "web", service: "web", running: true, status: "Up" }]);
  assert.equal(partSituation(h.repos), "empty");
  assert.equal(partSituation(k.container), "loading");
  assert.equal(partSituation(k.repos), "error");
  assert.equal(partSituation(readTree(treeRaw([inst("main", { container: { list: [{ name: "x" }] } })])).instances[0].container), "closed", "a list without `loaded` does not count");
  assert.equal(partSituation({ loaded: true, open: true, error: "ps failed", list: [] }), "error", "loaded with an error and an empty list is not “empty”");
  assert.equal(readTree(treeRaw([inst("main", { cpu: "much", memBytes: NaN })])).instances[0].cpu, null, "never 0 for unknown");
});

test("(b) `?open=` carries only known names, sorted, otherwise no parameter", async () => {
  const { readTree, openParam } = await load();
  const b = readTree(treeRaw([inst("main"), inst("copy-k2"), inst("copy-k1")]));
  assert.equal(openParam(["copy-k2", "main", "copy-away", "copy-k2"], b), "copy-k2,main");
  assert.equal(openParam([], b), null);
  assert.equal(openParam(["copy-away"], b), null);
  assert.equal(openParam(["copy-k1"], null), "copy-k1", "before the first tree the remembered names go out");
});

test("(c) the situation of every row — a waiting start is “waiting”", async () => {
  const { readTree, situationOf } = await load();
  const situation = (o) => situationOf(readTree(treeRaw([inst("copy-k1", o)])).instances[0]);
  const expected = {
    ready: "ready", start: "starts", recreate: "starts", relocation: "starts", stop: "stops", stopped: "stopped",
    create: "build", build: "build", clearAway: "clearAway", error: "error", "": "unknown", nonsense: "unknown",
  };
  for (const [state, l] of Object.entries(expected)) assert.equal(situation({ state }), l, state);
  assert.equal(situation({ state: "waiting_queue", waiting: { reason: "queue", since: 5 } }), "waiting");
  assert.equal(situation({ state: "waiting_storage" }), "waiting", "also without a `waiting` field");
  assert.equal(situation({ state: "stopped", phase: "waiting_storage", waiting: { reason: "storage", since: 9 } }), "waiting");
  assert.equal(situation({ state: "ready", waiting: { reason: "never" } }), "ready", "an unknown reason is no waiting");
});

test("(d) the actions per situation", async () => {
  const { readTree, actionsOf } = await load();
  const acts = (name, o) => actionsOf(readTree(treeRaw([inst(name, o)])).instances[0]);
  const one = (a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.on]));
  const reposLoaded = { loaded: true, list: [{ rel: "", branch: "main", detached: false, open: 0 }] };

  assert.deepEqual(one(acts("main", { repos: reposLoaded })), { stop: true, start: false, abortStart: false, erase: false, branch: true, chat: true, code: true, terminal: true, asBase: true });
  assert.equal(acts("main").erase.reason, "main");
  assert.deepEqual(acts("main").branch, { on: false, reason: "repos-closed" }, "branch needs the loaded repos");
  assert.deepEqual(acts("main", { repos: { loaded: true, list: [] } }).branch, { on: false, reason: "no-repos" });

  assert.deepEqual(one(acts("copy-k1", { state: "stopped" })), { stop: false, start: true, abortStart: false, erase: true, branch: false, chat: true, code: false, terminal: false, asBase: false });
  const waiting = acts("copy-k1", { state: "stopped", phase: "waiting_storage", waiting: { reason: "storage", since: 1 } });
  assert.deepEqual(one(waiting), { stop: false, start: false, abortStart: true, erase: true, branch: false, chat: true, code: false, terminal: false, asBase: false }, "a chat may enter: its turn waits along");
  assert.equal(waiting.start.reason, "start-waiting");

  assert.deepEqual(one(acts("copy-k1", { state: "clearAway" })), { stop: false, start: false, abortStart: false, erase: false, branch: false, chat: false, code: false, terminal: false, asBase: false });
  assert.equal(acts("copy-k1", { state: "clearAway" }).erase.reason, "gets-cleared-away");
  assert.equal(acts("copy-k1", { state: "waiting_queue", waiting: { reason: "queue", since: 1 } }).erase.on, true, "a waiting copy can be deleted (cancelled)");
  assert.equal(acts("copy-k1", { state: "error" }).erase.on, true);
});

test("(e) the service row", async () => {
  const { readTree, serviceAction } = await load();
  const d = (o) => ({ id: "s1", name: "Web", port: 3000, running: false, holdsStart: false, startable: true, link: null, ...o });
  const b = readTree(treeRaw([inst("main"), inst("copy-k1", { state: "stopped" })]));
  const [h, k] = b.instances;
  assert.equal(serviceAction(d({}), h), "start");
  assert.equal(serviceAction(d({ running: true }), h), "stop");
  assert.equal(serviceAction(d({ holdsStart: true }), k), "stop", "a held start offers stopping even without a ready instance");
  assert.equal(serviceAction(d({ startable: false }), h), "startCommand");
  assert.equal(serviceAction(d({}), k), "no");
  const withLink = readTree(treeRaw([inst("main", { services: [d({ id: 7, link: { id: 3, url: "https://x", procedure: 9, state: "active" } }), { id: "" }] })]));
  assert.deepEqual(withLink.instances[0].services.map((x) => [x.id, x.link?.id]), [["7", "3"]], "ids as text, a row without an id drops out");
  // The link of a standing instance reaches nothing — judged by the row's state, also a waiting start (situation "waiting").
  const { linkStopped } = await load();
  const stands = (o) => linkStopped(readTree(treeRaw([inst("copy-k1", o)])).instances[0]);
  for (const state of ["stopped", "stop", "start"]) assert.equal(stands({ state }), true, state);
  assert.equal(stands({ state: "stopped", phase: "waiting_storage", waiting: { reason: "storage", since: 1 } }), true, "a waiting start stands");
  for (const state of ["ready", "clearAway", "error", "build", "waiting_queue"]) assert.equal(stands({ state }), false, state);
});

test("(f) the instance choice of a chat and the value of chats.instance", async () => {
  const { chatInstanceOptions, chatInstanceName, baseOptions, readTree, workingChats } = await load();
  const field = (copies, o = {}) => ({ identifier: `${P}/main`, state: "ready", converted: true, copies, ...o });
  // `state` of the instance row, `copyState` that of the copy row in stack_copies (projectbox/names.js projectInstanceField).
  const k = (name, state, copyState = "ready") => ({ identifier: `${P}/copy-${name}`, state, copyState });
  assert.deepEqual(chatInstanceOptions(field([
    k("a", "ready"), k("b", "stopped"), k("c", "start"), k("e", "error"), { identifier: "p2/copy-x", state: "ready", copyState: "ready" },
    // The real case: the instance row stays `ready` while the copy is cleared away (DELETE only changes stack_copies) or after a
    // failed clearing — instanceChoice rejects it with 409, so the choice does not offer it.
    k("d", "ready", "clearAway"), k("f", "ready", "error"), k("g", "stopped", "clearAway"), k("h", "ready", ""),
    { identifier: `${P}/copy-i`, state: "ready" }, // without `copyState` (older server): unknown is not ready
  ])).map((o) => o.name), ["main", "copy-a", "copy-b", "copy-c"]);
  for (const [name, f] of [["without", undefined], ["null", null], ["not converted", field([k("a", "ready")], { converted: false })], ["broken identifier", field([k("a", "ready")], { identifier: "garbage" })], ["state not text (the app reads it the same way)", field([k("a", "ready")], { state: 3 })], ["without state", field([k("a", "ready")], { state: undefined })]]) {
    assert.deepEqual(chatInstanceOptions(f), [], name);
  }
  // Converted, but no selectable copy — main alone (the button stands, below it "Create copy …").
  for (const [name, f] of [["no copy", field([])], ["without copies field", field(undefined)], ["no living one", field([k("a", "error")])], ["only ones to clear away", field([k("a", "ready", "clearAway")])], ["one is arising", field([k("a", "create", "build")])]]) {
    assert.deepEqual(chatInstanceOptions(f), [{ name: "main", identifier: `${P}/main`, state: "ready" }], name);
  }
  for (const w of [null, undefined, "", "  ", "main"]) assert.equal(chatInstanceName(w), "main", String(w));
  assert.equal(chatInstanceName("copy-k1"), "copy-k1");
  const b = readTree(treeRaw([inst("main", { state: "start" }), inst("copy-k1"), inst("copy-k2", { state: "stopped" })]));
  assert.deepEqual(baseOptions(b).map((o) => o.name), ["copy-k1"], "base only ready — main need not be ready for a copy from a copy");
  assert.deepEqual(baseOptions(null), []);
  assert.deepEqual(workingChats(readTree(treeRaw([inst("main", { chats: [{ id: "c1", title: "A", running: true }, { id: "c2", title: "B", running: false }] })])).instances[0]).map((c) => c.id), ["c1"]);
});

// The stream event of an instance switch — the switch at which ChatPane reloads the history (divider).
// Counter-test: `w === null` to `w == null` (a MISSING field would mean "to main" — the workflow driver's `chat_settings` reset
// every chat) => red.
test("(g) instanceSwitchFromEvent: only `chat_settings` WITH the field `instance` is a switch; null/\"\"/main means main", async () => {
  const { instanceSwitchFromEvent } = await load();
  const ev = (o) => ({ type: "harness", subtype: "chat_settings", ...o });
  assert.deepEqual(instanceSwitchFromEvent(ev({ instance: "copy-k1" })), { instance: "copy-k1" });
  for (const w of [null, "", "main"]) assert.deepEqual(instanceSwitchFromEvent(ev({ instance: w })), { instance: null }, String(w));
  // The workflow driver sends `chat_settings` with its run fields — not a word about the instance.
  assert.equal(instanceSwitchFromEvent(ev({ workflowRunId: "r1" })), null, "a missing field is no statement");
  assert.equal(instanceSwitchFromEvent(ev({ instance: 5 })), null, "a value that is neither text nor null is no statement");
  for (const foreign of [null, "x", { type: "harness", subtype: "title", instance: "copy-k1" }, { type: "chat_meta", instance: "copy-k1" }]) {
    assert.equal(instanceSwitchFromEvent(foreign), null, JSON.stringify(foreign));
  }
});
