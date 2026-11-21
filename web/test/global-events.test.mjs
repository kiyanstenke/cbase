// The global event stream (src/lib/api.ts) is a module singleton: ONE /api/events connection for all consumers. On connect the
// server sends a single "init" (running chats, open browsers, open dynamic workflows); consumers that subscribe later get it replayed.
//
// The replayed "init" must carry the CURRENT state, not the original frame from page load: the connection lives as long as any
// consumer holds it, and a late consumer (e.g. the chat list after a page switch) would otherwise see a stale snapshot — a chat
// started meanwhile missing, a finished one still shown as running (the spinner would turn until the app is reloaded). The same
// holds for the open dynamic workflows (`dynWorkflows` in "init").
//
// Counter-tests: in src/lib/api/events.ts `initState()` without the `dynWorkflows: …` line => "Latecomer …" red (the old snapshot
// from `lastInit`), plus the first test and the name probe; the branch `msg.type === "dyn_workflow"` without `openWorkflows.delete`
// => "Latecomer …" red ("finished runs are missing …").
//
// Run:  node --test web/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const source = path.join(webDir, "src", "lib", "api.ts");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

// Stands in for the browser's SSE connection. `emit` plays a server frame.
class FakeEventSource {
  static instances = [];
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
  constructor(url) {
    this.url = url;
    this.closed = false;
    this.readyState = 1;
    this.onmessage = null;
    FakeEventSource.instances.push(this);
  }
  close() { this.closed = true; this.readyState = 2; }
  // The watchdog (`watch`) attaches listeners for open/message/ping — no effect here.
  addEventListener() {}
  removeEventListener() {}
  emit(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

test("A replayed “init” carries the CURRENT state, not the one from page load", async (t) => {
  if (!fs.existsSync(tsc)) { t.skip("node_modules missing (tsc) — event stream not testable"); return; }
  // Output below web/ so that ESM resolution works (as in the markdown test).
  const out = fs.mkdtempSync(path.join(webDir, "node_modules", ".events-test-"));
  globalThis.EventSource = FakeEventSource;
  try {
    execFileSync(process.execPath, [
      tsc, source, "--module", "esnext", "--target", "es2022",
      "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom", "--outDir", out,
    ], { cwd: webDir, stdio: "pipe" });
    const { subscribeGlobalEvents } = await import(pathToFileURL(path.join(out, "api.js")).href);

    // The header holds the connection open on every page.
    const header = [];
    const offHeader = subscribeGlobalEvents((e) => header.push(e));
    const es = FakeEventSource.instances.at(-1);
    assert.ok(es, "a connection must have been created");

    es.emit({ type: "init", running: [], browsers: [] });
    es.emit({ type: "run", chatId: "c1", running: true }); // another page starts a coding chat

    // Switch to another page: the chat list attaches only NOW. It missed the start and must still see it —
    // otherwise the spinner of the running chat does not turn.
    const list = [];
    const offList = subscribeGlobalEvents((e) => list.push(e));
    assert.deepEqual(list, [{ type: "init", running: ["c1"], browsers: [], dynWorkflows: [] }]);

    // Switch back: the list is torn down, the run ends without it.
    offList();
    es.emit({ type: "run", chatId: "c1", running: false });

    const listAgain = [];
    const offListAgain = subscribeGlobalEvents((e) => listAgain.push(e));
    assert.deepEqual(listAgain, [{ type: "init", running: [], browsers: [], dynWorkflows: [] }],
      "a chat that has finished meanwhile must not be replayed as running");

    // Same for the browser list — it also lives only in "init" and would otherwise go stale.
    es.emit({ type: "browsers", list: [{ id: "b1" }] });
    const laterConsumer = [];
    subscribeGlobalEvents((e) => laterConsumer.push(e))();
    assert.deepEqual(laterConsumer, [{ type: "init", running: [], browsers: [{ id: "b1" }], dynWorkflows: [] }]);

    // Live events reach everyone currently subscribed (passed through unchanged).
    assert.deepEqual(header.at(-1), { type: "browsers", list: [{ id: "b1" }] });

    // When the last consumer leaves, the connection is closed — and the next attach brings its own initial state,
    // so nothing stale is replayed.
    offHeader();
    offListAgain();
    assert.equal(es.closed, true);
    const fresh = [];
    const offNew = subscribeGlobalEvents((e) => fresh.push(e));
    assert.equal(FakeEventSource.instances.length, 2, "a second connection must have been created");
    assert.deepEqual(fresh, []);
    offNew();
  } finally {
    delete globalThis.EventSource;
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// Translates the stream into a fresh directory and loads it — one module instance per test (the stream is a singleton).
function translateStream() {
  const out = fs.mkdtempSync(path.join(webDir, "node_modules", ".events-test-"));
  execFileSync(process.execPath, [
    tsc, source, "--module", "esnext", "--target", "es2022",
    "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom", "--outDir", out,
  ], { cwd: webDir, stdio: "pipe" });
  return out;
}

test("Latecomer: the replayed “init” carries the dynamic workflows open NOW, not those from page load", async (t) => {
  if (!fs.existsSync(tsc)) { t.skip("node_modules missing (tsc) — event stream not testable"); return; }
  const out = translateStream();
  globalThis.EventSource = FakeEventSource;
  try {
    const { subscribeGlobalEvents } = await import(pathToFileURL(path.join(out, "api.js")).href);
    const header = [];
    const offHeader = subscribeGlobalEvents((e) => header.push(e));
    const es = FakeEventSource.instances.at(-1);
    // At page load r1 is open in c1; then r1 ends, r2 starts in c2, and in c3 two runs run, one of which ends.
    es.emit({ type: "init", running: [], browsers: [], dynWorkflows: [{ chatId: "c1", runId: "r1" }, { chatId: "", runId: "broken" }, { runId: "without-chat" }] });
    es.emit({ type: "dyn_workflow", chatId: "c1", runId: "r1", open: false });
    es.emit({ type: "dyn_workflow", chatId: "c2", runId: "r2", open: true });
    es.emit({ type: "dyn_workflow", chatId: "c3", runId: "r3", open: true });
    es.emit({ type: "dyn_workflow", chatId: "c3", runId: "r4", open: true });
    es.emit({ type: "dyn_workflow", chatId: "c3", runId: "r3", open: false });
    // Incomplete events change nothing (same check as workflowChatsApply in lib/workflow-chats.ts).
    es.emit({ type: "dyn_workflow", chatId: "c9", runId: "r9" });
    es.emit({ type: "dyn_workflow", chatId: "c9", runId: "r9", open: "yes" });
    es.emit({ type: "dyn_workflow", runId: "r2", open: false });

    // The chat list attaches only now — it must see the CURRENT state.
    const list = [];
    const offList = subscribeGlobalEvents((e) => list.push(e));
    assert.equal(list.length, 1);
    const status = list[0].dynWorkflows.map((z) => `${z.chatId}/${z.runId}`).sort();
    assert.deepEqual(status, ["c2/r2", "c3/r4"], "finished runs are missing, runs started meanwhile are present");
    assert.deepEqual(list[0].running, []);
    // The live events themselves go unchanged to everyone subscribed.
    assert.deepEqual(header.at(-1), { type: "dyn_workflow", runId: "r2", open: false });
    assert.ok(header.some((e) => e.type === "dyn_workflow" && e.runId === "r2" && e.open === true));

    // A new "init" (reconnect) replaces the state completely.
    es.emit({ type: "init", running: [], browsers: [], dynWorkflows: [{ chatId: "c5", runId: "r5" }] });
    const after = [];
    subscribeGlobalEvents((e) => after.push(e))();
    assert.deepEqual(after[0].dynWorkflows, [{ chatId: "c5", runId: "r5" }]);

    // A backend without the field: "none known", events after it still count.
    es.emit({ type: "init", running: [], browsers: [] });
    es.emit({ type: "dyn_workflow", chatId: "c6", runId: "r6", open: true });
    const old = [];
    subscribeGlobalEvents((e) => old.push(e))();
    assert.deepEqual(old[0].dynWorkflows, [{ chatId: "c6", runId: "r6" }]);

    // When the last consumer leaves, the state falls with the connection — the next attach brings its own "init".
    offList();
    offHeader();
    assert.equal(es.closed, true);
    const fresh = [];
    const offNew = subscribeGlobalEvents((e) => fresh.push(e));
    const es2 = FakeEventSource.instances.at(-1);
    assert.notEqual(es2, es, "a new connection");
    es2.emit({ type: "init", running: [], browsers: [] });
    const later = [];
    subscribeGlobalEvents((e) => later.push(e))();
    assert.deepEqual(later[0].dynWorkflows, [], "nothing from the old connection");
    offNew();
  } finally {
    delete globalThis.EventSource;
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// The event names and the shape on which the maintained state hangs are those of the server and of the chat list's calculation.
test("dynWorkflows: the stream reads `dynWorkflows` and `dyn_workflow` under the same names as the server and lib/workflow-chats.ts", () => {
  const repo = path.resolve(webDir, "..");
  const events = fs.readFileSync(path.join(webDir, "src", "lib", "api", "events.ts"), "utf8");
  const wfChats = fs.readFileSync(path.join(webDir, "src", "lib", "workflow-chats.ts"), "utf8");
  const run = fs.readFileSync(path.join(repo, "server", "backend", "electron", "server", "dynworkflows", "run.js"), "utf8");
  const sse = fs.readFileSync(path.join(repo, "server", "backend", "electron", "server", "runtime", "sse.js"), "utf8");
  const name = /export const GLOBAL_EVENT = "([^"]+)"/.exec(run)?.[1];
  assert.ok(name, "GLOBAL_EVENT not found in dynworkflows/run.js");
  assert.ok(wfChats.includes(`export const WORKFLOW_EVENT = "${name}"`), "lib/workflow-chats.ts names the event differently");
  assert.ok(events.includes(`msg.type === "${name}"`), "lib/api/events.ts does not maintain the state from the event");
  assert.ok(/type: "init"[^\n]*dynWorkflows/.test(sse), "runtime/sse.js does not carry `dynWorkflows` in init");
  assert.ok(events.includes("msg.dynWorkflows") && events.includes("dynWorkflows: [...openWorkflows]"), "lib/api/events.ts does not read or pass on `dynWorkflows`");
  assert.ok(!/from\s+["'][^"']*workflow-chats/.test(events), "lib/api/ is a leaf — no import of lib/workflow-chats.ts");
});

// iOS has no such path: ONE consumer of the stream (AppState) holds the state itself, every view reads it there — nothing to
// replay. Whoever adds a second consumer needs the same maintenance as above.
test("dynWorkflows, iOS: exactly ONE consumer of /api/events (AppState), and it maintains `dynWorkflows` from init AND event", () => {
  const mobile = path.resolve(webDir, "..", "mobile", "CbaseMobile");
  const hits = [];
  const run = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) run(p);
      else if (e.name.endsWith(".swift") && fs.readFileSync(p, "utf8").includes('"/api/events"')) hits.push(path.relative(mobile, p));
    }
  };
  run(mobile);
  assert.deepEqual(hits, [path.join("Models", "AppState.swift")]);
  const app = fs.readFileSync(path.join(mobile, "Models", "AppState.swift"), "utf8");
  assert.ok(app.includes('event["dynWorkflows"]') && app.includes('type == "dyn_workflow"'), "AppState does not maintain the open workflows");
});
