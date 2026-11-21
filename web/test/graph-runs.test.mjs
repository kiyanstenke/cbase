// The strip of the earmarked graph workflow start: src/lib/graph-runs.ts, compiled with tsc (a leaf without imports) and run
// against spelled-out expectations. What the server's view delivers is checked by server/backend/test/graph-start-route.test.js
// at the main seam; here: loading, event, buffer (no event is lost that arrives at the route during the request), "empty" is
// not "unknown", which row the strip shows, that the state word covers all nine states — and the wiring: ChatPane calls the
// hook exactly once, onEvent feeds it, the stage hands the row to the base, every key is translated. Also the card of a
// background run, the response form per wait kind and the request on the child chat — with the check that the sent words hit
// the server's interpretation (GO_RE/STOP_RE/OK_RE from workflows.js, read by path).
//
// Counter-tests: in foregroundRow the filter `l.background !== true` left out => "foreground only" red; in graphLoaded the
// buffer not laid over => "Buffer" red.
//
// Run:  node --test web/test/graph-runs.test.mjs
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
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-graph-runs-"));
after(() => { try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "graph-runs.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const G = await import(pathToFileURL(path.join(out, "graph-runs.js")).href);
const src = (...parts) => fs.readFileSync(path.join(webDir, "src", ...parts), "utf8");

const view = (startId, state, extra = {}) => ({
  startId, background: false, worktree: false, worktreePath: "", workflowId: `wf-${startId}`, name: `Job ${startId}`,
  shortName: `job-${startId}`, input: "", state, reason: "", chatId: "c1", run: null, wait: null, stoppedOf: "",
  startedAt: 100, updatedAt: 100, endedAt: null, ...extra,
});
const event = (run) => ({ type: "harness", subtype: "graph_run", run });
const loaded = (runs) => G.graphLoaded(G.graphLoading(G.GRAPH_UNLOADED), { runs });

test("Loading: the route's answer is the state, newest first — an error and a foreign shape are NOT “empty”", () => {
  assert.equal(G.hasGraphRuns(G.GRAPH_UNLOADED), null, "before the answer: unknown");
  const s = loaded([view("a", "finished", { startedAt: 1 }), view("b", "earmarked", { startedAt: 5 })]);
  assert.equal(s.loaded, true);
  assert.equal(s.loading, false);
  assert.deepEqual(s.runs.map((l) => l.startId), ["b", "a"], "descending by startedAt");
  const empty = loaded([]);
  assert.equal(G.hasGraphRuns(empty), false, "a read empty list means “no starts”");
  // On an error the hook gives `null` as the answer — that stays “not loaded”, likewise an answer without a list.
  for (const broken of [null, { error: "x", reason: "unknown" }, { runs: "no" }]) {
    const k = G.graphLoaded(G.graphLoading(G.GRAPH_UNLOADED), broken);
    assert.equal(G.hasGraphRuns(k), null, `${JSON.stringify(broken)} is not empty`);
    assert.equal(k.loading, false);
  }
  // An error on RELOADING (reconnect) leaves the shown state in place.
  const fresh = G.graphLoaded(G.graphLoading(s), null);
  assert.equal(fresh.loaded, true);
  assert.deepEqual(fresh.runs.map((l) => l.startId), ["b", "a"]);
  // Entries without startId or state do not enter the list.
  assert.deepEqual(loaded([{ startId: "", state: "earmarked" }, { startId: "x" }, view("c", "finished")]).runs.map((l) => l.startId), ["c"]);
});

test("Event: replaces by startId in place, a new start is added, foreign events leave the state in place", () => {
  let s = loaded([view("a", "earmarked", { startedAt: 10 }), view("b", "finished", { startedAt: 5 })]);
  s = G.graphApply(s, event(view("a", "stopped", { startedAt: 10, stoppedOf: "human" })));
  assert.deepEqual(s.runs.map((l) => [l.startId, l.state]), [["a", "stopped"], ["b", "finished"]]);
  s = G.graphApply(s, event(view("c", "earmarked", { startedAt: 20 })));
  assert.deepEqual(s.runs.map((l) => l.startId), ["c", "a", "b"]);
  // An older start that is only reported now sits at its time, not in front.
  s = G.graphApply(s, event(view("d", "finished", { startedAt: 7 })));
  assert.deepEqual(s.runs.map((l) => l.startId), ["c", "a", "d", "b"]);
  for (const foreign of [{ type: "harness", subtype: "dynwf_tree", run: view("x", "earmarked") }, { type: "harness", subtype: "graph_run" },
    { type: "harness", subtype: "graph_run", run: { startId: "" } }, { type: "assistant", subtype: "graph_run", run: view("x", "earmarked") }]) {
    assert.equal(G.graphApply(s, foreign), s, `${JSON.stringify(foreign).slice(0, 60)} leaves the state in place`);
  }
  assert.equal(G.GRAPH_EVENT, "graph_run");
  // An event before the first answer: the start is there, but the chat is not loaded yet (the list may have more).
  const prior = G.graphApply(G.GRAPH_UNLOADED, event(view("e", "earmarked")));
  assert.equal(prior.loaded, false);
  assert.equal(G.hasGraphRuns(prior), true);
});

test("Buffer: what arrives during the request lies over its (older) answer — afterwards the buffer is empty", () => {
  let r = G.graphLoading(loaded([view("a", "earmarked")]));
  assert.equal(r.loading, true);
  r = G.graphApply(r, event(view("a", "stopped", { stoppedOf: "human" })));
  r = G.graphApply(r, event(view("n", "earmarked", { startedAt: 200 })));
  assert.equal(r.buffer.length, 2);
  r = G.graphLoaded(r, { runs: [view("a", "earmarked")] });
  assert.deepEqual(r.runs.map((l) => [l.startId, l.state]), [["n", "earmarked"], ["a", "stopped"]]);
  assert.deepEqual(r.buffer, []);
  // Without a running request nothing is buffered.
  assert.deepEqual(G.graphApply(loaded([]), event(view("z", "earmarked"))).buffer, []);
});

test("foregroundRow: earmarked and waiting_lock with Cancel, the leftover worktree with Dismiss", () => {
  assert.equal(G.foregroundRow(G.GRAPH_UNLOADED), null);
  assert.equal(G.foregroundRow(loaded([])), null);
  assert.deepEqual(G.foregroundRow(loaded([view("a", "earmarked", { name: "Job → Ship" })])), {
    startId: "a", kind: "earmarked", text: "Workflow “{name}” starts when the turn ends", params: { name: "Job → Ship" },
    button: "Cancel", action: "abort",
  });
  assert.deepEqual(G.foregroundRow(loaded([view("a", "waiting_lock", { reason: "Project “web” is busy" })])), {
    startId: "a", kind: "waiting_lock", text: "Workflow “{name}” is waiting — {reason}", params: { name: "Job a", reason: "Project “web” is busy" },
    button: "Cancel", action: "abort",
  });
  // Without a reason no half sentence.
  const withoutReason = G.foregroundRow(loaded([view("a", "waiting_lock")]));
  assert.equal(withoutReason.text, "Workflow “{name}” is waiting for a lock");
  assert.deepEqual(withoutReason.params, { name: "Job a" });
  // Without a name the short name.
  assert.equal(G.foregroundRow(loaded([view("a", "earmarked", { name: "" })])).params.name, "job-a");
  for (const z of ["finished", "failed", "stopped", "dismissed"]) {
    const s = loaded([view("w", z, { worktree: true, worktreePath: "/ws/.cbase-worktrees/w" })]);
    assert.deepEqual(G.foregroundRow(s), {
      startId: "w", kind: "worktree", text: "Worktree with changes remains: {path}", params: { path: "/ws/.cbase-worktrees/w" },
      button: "Dismiss##hide", action: "hide",
    }, `finished (${z}) with worktree`);
    assert.equal(G.foregroundRow(s, new Set(["w"])), null, "hidden (Set)");
    assert.equal(G.foregroundRow(s, ["w"]), null, "hidden (list)");
    assert.equal(G.foregroundRow(loaded([view("w", z)])), null, `finished (${z}) without worktree: nothing`);
  }
});

test("foregroundRow: foreground only; running/waiting belong to the header's workflow strip; unknown states never", () => {
  assert.equal(G.foregroundRow(loaded([view("h", "earmarked", { background: true })])), null, "a background start is not in the strip");
  assert.equal(G.foregroundRow(loaded([view("h", "finished", { background: true, worktreePath: "/w" })])), null);
  for (const z of ["running", "waiting", "waiting_storage", "anything", ""]) {
    assert.equal(G.foregroundRow(loaded([view("a", z, { worktreePath: "/w" })])), null, `“${z}” gives no row`);
  }
  // An open start takes precedence over the worktree notice — even a newer one.
  const both = loaded([view("alt", "earmarked", { startedAt: 1 }), view("fresh", "finished", { startedAt: 9, worktreePath: "/w" })]);
  assert.equal(G.foregroundRow(both).startId, "alt");
  // Two worktree notices: the newest; after dismissing it the next.
  const two = loaded([view("w1", "finished", { startedAt: 1, worktreePath: "/w1" }), view("w2", "failed", { startedAt: 2, worktreePath: "/w2" })]);
  assert.equal(G.foregroundRow(two).startId, "w2");
  assert.equal(G.foregroundRow(two, ["w2"]).startId, "w1");
  // A background start next to an earmarked foreground start does not interfere.
  assert.equal(G.foregroundRow(loaded([view("h", "earmarked", { background: true, startedAt: 9 }), view("v", "earmarked", { startedAt: 1 })])).startId, "v");
});

test("STATE_WORD covers exactly the nine states of the contract, and every word and every row is translated", () => {
  assert.deepEqual([...G.GRAPH_STATES], ["earmarked", "waiting_lock", "waiting_storage", "running", "waiting", "finished", "failed", "stopped", "dismissed"]);
  assert.deepEqual(Object.keys(G.STATE_WORD).sort(), [...G.GRAPH_STATES].sort());
  assert.deepEqual(G.STATE_WORD, {
    earmarked: "Scheduled##earmarked", waiting_lock: "Waiting for lock", waiting_storage: "Waiting for memory", running: "Running",
    waiting: "Waiting for you", finished: "Done", failed: "Failed", stopped: "Stopped", dismissed: "Discarded",
  });
  // The states of the contract also stand in the server: the waiting ones and the end ones, in the same words.
  const serverDir = path.resolve(webDir, "..", "server", "backend", "electron", "server", "workflows");
  const bg = fs.readFileSync(path.join(serverDir, "graph-background.js"), "utf8");
  assert.ok(bg.includes('const WAITING = ["earmarked", "waiting_lock", "waiting_storage"];'), "the waiting states as in the server");
  assert.ok(bg.includes('const END = new Set(["finished", "failed", "stopped", "dismissed"]);'), "the end states as in the server");
  const en = src("lib", "i18n-de.ts");
  const key = [
    ...Object.values(G.STATE_WORD),
    "Workflow “{name}” starts when the turn ends", "Workflow “{name}” is waiting — {reason}", "Workflow “{name}” is waiting for a lock",
    "Worktree with changes remains: {path}", "Cancel", "Dismiss##hide",
  ];
  const missing = key.filter((k) => !en.includes(`"${k}":`));
  assert.deepEqual(missing, [], "without a German translation");
  // Every row foregroundRow can deliver is in the list above (no unchecked fourth one).
  const lib = src("lib", "graph-runs.ts");
  const texts = [...lib.matchAll(/text: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(texts.length >= 4);
  for (const tx of texts) assert.ok(key.includes(tx), `row without a check: ${tx}`);
});

// ── Wiring ────────────────────────────────────────────────────────────────────────────────────────────────────
// Counter-test: `graphRow={graphRow}` removed from the ComposerBase of the stage => red.
test("Wiring: ChatPane calls the hook exactly once with the open chat and feeds it from onEvent; the stage gives the row to the base; nobody else", () => {
  const pane = src("components", "chat", "ChatPane.tsx");
  assert.equal([...pane.matchAll(/= useGraphRuns\(activeId\);/g)].length, 1, "ChatPane calls the hook exactly once, with the open chat");
  assert.equal([...pane.matchAll(/graphEvent\(evt\);/g)].length, 1, "onEvent feeds it exactly once");
  // …right next to the tree at the head of onEvent — before the switch that returns early on some events.
  const header = pane.slice(pane.indexOf("function onEvent("), pane.indexOf('if (evt.type === "harness") {', pane.indexOf("function onEvent(")));
  assert.ok(header.includes("treeEvent(evt);") && header.includes("graphEvent(evt);"), "graphEvent stands at the head of onEvent next to treeEvent");
  const stage = src("components", "chat", "ChatStage.tsx");
  const plinth = stage.slice(stage.indexOf("<ComposerBase"), stage.indexOf("/>", stage.indexOf("<ComposerBase")));
  assert.match(plinth, /graphRow=\{graphRow\}/, "the stage gives the row to the base");
  assert.ok(stage.includes("foregroundRow(graphRuns, graphHidden)"), "the stage calculates the row from state and hidden ones");
  assert.ok(/stopGraphStart\(graphStrip\.startId\)\.catch\(/.test(stage), "a failed stop is caught (notice), not swallowed");
  const strip = src("components", "ComposerStrip.tsx");
  assert.ok(strip.includes('identifier: "graph-start"'), "the part is called graph-start (data-strip)");
  assert.ok(strip.includes('"graph-abort"') && strip.includes('"graph-hide"'), "the buttons carry their action");
  // NAMED: across ALL sources, only ChatPane calls the hook, and only the stage gives the base a row.
  const root = path.join(webDir, "src");
  const run = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? run(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);
  const hookUser = [], rowsGiver = [];
  for (const full of run(root)) {
    const q = fs.readFileSync(full, "utf8"), rel = path.relative(root, full).split(path.sep).join("/");
    if (/useGraphRuns\(/.test(q)) hookUser.push(rel);
    if (/graphRow=/.test(q)) rowsGiver.push(rel);
  }
  assert.deepEqual(hookUser.sort(), ["components/chat/ChatPane.tsx", "components/chat/chatGraphRuns.ts"], "who calls the graph hook (besides its definition)");
  assert.deepEqual(rowsGiver, ["components/chat/ChatStage.tsx"], "who gives the base a graph row");
});

test("Hook: loads via GET …/graph-workflows (a draft without id does not load), stops via POST …/stop with from “human”, reloads after an error", () => {
  const hook = src("components", "chat", "chatGraphRuns.ts");
  assert.ok(hook.includes("/api/chats/${encodeURIComponent(id)}/graph-workflows`"), "list via the route of the run views");
  assert.ok(hook.includes("/graph-workflows/${encodeURIComponent(startId)}/stop`"), "stop via the route per startId");
  assert.ok(hook.includes('JSON.stringify({ from: "human" })'), "the human stops");
  assert.ok(/if \(chatId\) load\(chatId\);/.test(hook), "no request without a chat id");
  assert.ok(/evt\.subtype === "connected"\) \{ if \(chatRef\.current\) load\(chatRef\.current\)/.test(hook), "connected reloads");
  assert.ok(/\.catch\(\(\) => \{ if \(chatRef\.current === id\) setGraphRuns\(\(s\) => graphLoaded\(s, null\)\)/.test(hook), "a load error is not “empty”");
  assert.ok(/catch \(e\) \{\s*if \(chatRef\.current === id\) load\(id\);\s*throw e;/.test(hook), "a stop error reloads and rethrows");
});

// ── Card and response of a background run ─────────────────────────────────────────────────────────────────────
// That iOS calculates the same is held by graph-runs-binding.test.mjs; here the rules per wait kind.
// Counter-tests: in cardOf `if (run.background !== true) return null;` removed => "Card" red; in responseForm the
// permission without `requestId ?` => "Form" red; in responseRequest `selected.slice(0, 1)` → `selected` => "Request" red.
const rear = (startId, state, extra = {}) => view(startId, state, { background: true, chatId: `kind-${startId}`, ...extra });
const waiting = (wait, extra = {}) => rear("w", "waiting", { wait, ...extra });

test("Card: background only; title, state word, tone, warning dot, second row, worktree and stop per state", () => {
  assert.equal(G.cardOf(view("v", "running")), null, "a foreground run has strip and banner, no card");
  const expected = {
    earmarked: ["quiet", true], waiting_lock: ["quiet", true], waiting_storage: ["quiet", true], running: ["running", true],
    waiting: ["waiting", true], finished: ["finished", false], failed: ["error", false], stopped: ["muted", false], dismissed: ["muted", false],
  };
  for (const z of G.GRAPH_STATES) {
    const k = G.cardOf(rear("a", z));
    assert.deepEqual([k.tone, k.stop], expected[z], z);
    assert.equal(k.stateWord, G.STATE_WORD[z]);
    assert.equal(k.warningDot, z === "waiting", `warning dot only at “waiting” (${z})`);
  }
  const foreign = G.cardOf(rear("a", "toString"));
  assert.deepEqual([foreign.stateWord, foreign.tone, foreign.stop], ["toString", "muted", false], "an unknown state stands raw, even one from the prototype");
  const r = { status: "running", step: 3, total: 7, nodeTitle: "Implement" };
  assert.equal(G.cardOf(rear("a", "running", { run: r })).row2, "3/7: Implement");
  assert.equal(G.cardOf(rear("a", "running", { run: { ...r, total: 0 } })).row2, "3: Implement");
  assert.equal(G.cardOf(rear("a", "running", { run: { ...r, nodeTitle: "" } })).row2, "3/7");
  assert.equal(G.cardOf(rear("a", "running", { run: { ...r, step: 0 } })).row2, "Implement");
  assert.equal(G.cardOf(rear("a", "running")).row2, "", "without run and without reason no second row");
  assert.equal(G.cardOf(rear("a", "waiting_lock", { reason: "Project busy", run: r })).row2, "Project busy", "the reason takes precedence");
  assert.equal(G.cardOf(rear("a", "finished", { worktreePath: "/ws/wt" })).worktree, "/ws/wt");
  assert.equal(G.cardOf(rear("a", "running", { name: "" })).title, "job-a", "without a name the short name");
  assert.equal(G.cardOf(rear("a", "running")).response, null, "without waiting no form");
  assert.deepEqual(G.cardOf(waiting({ kind: "question" })).response, G.responseForm(waiting({ kind: "question" })));
  // The state's cards: background only, in the state's sequence.
  assert.deepEqual(G.backgroundRuns(loaded([view("v", "running", { startedAt: 9 }), rear("h1", "running", { startedAt: 5 }), rear("h2", "finished", { startedAt: 7 })])).map((l) => l.startId), ["h2", "h1"]);
});

test("Form: per wait kind route, buttons (word → sent) and free text as in the table; unknown, without waiting, without requestId: none", () => {
  const short = (w, extra) => {
    const f = G.responseForm(waiting(w, extra));
    return f && { route: f.route, buttons: f.buttons.map((k) => [k.word, k.send]), freeText: f.freeText, placeholder: f.placeholder };
  };
  assert.deepEqual(short({ kind: "question", question: "Which?" }), { route: "message", buttons: [], freeText: true, placeholder: "Answer …" });
  assert.deepEqual(short({ kind: "cap" }), { route: "message", buttons: [["Continue", "continue"], ["{n} more", "more 2"], ["Finish", "finish"]], freeText: false, placeholder: "" });
  assert.deepEqual(G.responseForm(waiting({ kind: "cap" })).buttons[1].params, { n: String(G.MORE_DEFAULT) });
  assert.deepEqual(short({ kind: "review" }), { route: "message", buttons: [["Looks good", "looks good"]], freeText: true, placeholder: "Remarks …" });
  for (const kind of ["done", "stopped"]) assert.deepEqual(short({ kind }), { route: "message", buttons: [["Continue", "continue"]], freeText: true, placeholder: "Instruction …" }, kind);
  assert.deepEqual(short({ kind: "agent_ask", requestId: "r" }), { route: "ask-answer", buttons: [], freeText: true, placeholder: "Own answer …" });
  assert.deepEqual(short({ kind: "permission", requestId: "p" }), { route: "permission-decision", buttons: [["Allow", "allow"], ["Deny", "deny"]], freeText: false, placeholder: "" });
  assert.deepEqual(short({ kind: "dyn_approval", requestId: "d" }), { route: "dyn-workflows/approval", buttons: [["Accept", "accept"], ["Deny", "reject"]], freeText: false, placeholder: "" });
  for (const w of [{ kind: "permission" }, { kind: "dyn_approval", requestId: "" }, { kind: "unknown" }, null, { question: "without kind" }, "broken"]) {
    assert.equal(G.responseForm(waiting(w)), null, JSON.stringify(w));
  }
  assert.equal(G.responseForm(rear("w", "running", { wait: { kind: "question" } })), null, "only a WAITING run has a form");
  const ask = G.responseForm(waiting({ kind: "agent_ask", requestId: "r", questions: [
    { header: "Way", question: "Which one?", multiSelect: false, options: [{ label: "A", description: "A first" }, { label: "" }, { label: "B" }] }, "no",
  ] }));
  assert.deepEqual(ask.questions, [{ header: "Way", question: "Which one?", multiple: false, options: [{ label: "A", description: "A first" }, { label: "B", description: "" }] }]);
});

test("Request: path on the CHILD chat, body per route; empty, foreign or without child chat: nothing", () => {
  const on = (w, e, extra) => G.responseRequest(waiting(w, extra), e);
  assert.deepEqual(on({ kind: "question" }, { text: "  Blue \n" }), { path: "/api/chats/kind-w/message", body: { text: "Blue" } });
  assert.equal(on({ kind: "question" }, { text: "   " }), null, "an empty free text cannot be sent");
  assert.equal(on({ kind: "question" }, {}), null);
  assert.deepEqual(on({ kind: "cap" }, { button: "more" }).body, { text: "more 2" });
  assert.deepEqual(on({ kind: "cap" }, { button: "more", n: 5 }).body, { text: "more 5" });
  assert.deepEqual(on({ kind: "cap" }, { button: "more", n: 500 }).body, { text: `more ${G.MORE_MAX}` });
  assert.deepEqual(on({ kind: "cap" }, { button: "more", n: 0 }).body, { text: "more 2" }, "not a whole number => the default");
  assert.deepEqual(on({ kind: "cap" }, { button: "complete" }).body, { text: "finish" });
  assert.equal(on({ kind: "cap" }, { text: "continue please" }), null, "at the cap there is no free text");
  assert.equal(on({ kind: "cap" }, { button: "matches" }), null, "a foreign button");
  assert.deepEqual(on({ kind: "review" }, { button: "matches", text: "whatever" }).body, { text: "looks good" }, "the button takes precedence over the text");
  assert.deepEqual(on({ kind: "review" }, { text: "The test is missing." }).body, { text: "The test is missing." });
  assert.deepEqual(on({ kind: "stopped" }, { button: "further" }).body, { text: "continue" });
  assert.deepEqual(on({ kind: "permission", requestId: "p1" }, { button: "allow" }), { path: "/api/chats/kind-w/permission-decision", body: { requestId: "p1", behavior: "allow" } });
  assert.deepEqual(on({ kind: "permission", requestId: "p1" }, { button: "reject" }).body, { requestId: "p1", behavior: "deny" });
  assert.equal(on({ kind: "permission", requestId: "p1" }, { text: "yes" }), null);
  assert.deepEqual(on({ kind: "dyn_approval", requestId: "d1" }, { button: "accept" }), { path: "/api/chats/kind-w/dyn-workflows/approval", body: { requestId: "d1", decision: "accept" } });
  const questions = [
    { question: "One?", multiSelect: false, options: [{ label: "A" }, { label: "B" }] },
    { question: "Several?", multiSelect: true, options: [{ label: "C" }, { label: "D" }] },
  ];
  assert.deepEqual(on({ kind: "agent_ask", requestId: "q1", questions }, { selection: [["B", "A", "X"], ["D", "C", "D"]] }), {
    path: "/api/chats/kind-w/ask-answer", body: { requestId: "q1", answers: [{ selected: ["B"], text: "" }, { selected: ["D", "C"], text: "" }] },
  }, "without multi-select the first valid one, foreign labels and duplicates drop out");
  assert.deepEqual(on({ kind: "agent_ask", requestId: "q1", questions }, { text: " own " }).body.answers, [{ selected: [], text: "own" }, { selected: [], text: "" }]);
  assert.deepEqual(on({ kind: "agent_ask", requestId: "q1", questions }, { texts: ["", " two "] }).body.answers, [{ selected: [], text: "" }, { selected: [], text: "two" }]);
  assert.equal(on({ kind: "agent_ask", requestId: "q1", questions }, { selection: [["X"]] }), null, "neither selection nor text");
  assert.deepEqual(on({ kind: "agent_ask", requestId: "q2" }, { text: "free" }).body, { requestId: "q2", answers: [{ selected: [], text: "free" }] }, "without questions: the free text as answers[0].text");
  assert.equal(on({ kind: "question" }, { text: "x" }, { chatId: "" }), null, "without a child chat no request");
  assert.equal(on({ kind: "question" }, { text: "x" }, { chatId: "kind 1/ä" }).path, "/api/chats/kind%201%2F%C3%A4/message", "the path is encoded (fetch)");
  assert.equal(G.responseRequest(rear("a", "running"), { text: "x" }), null, "without a form no request");
});

test("The sent words hit the server's interpretation: GO_RE, STOP_RE and OK_RE from workflows.js", () => {
  const server = (...parts) => fs.readFileSync(path.resolve(webDir, "..", "server", "backend", "electron", "server", ...parts), "utf8");
  const source = server("workflows.js");
  const pattern = (name) => {
    const m = source.match(new RegExp(`^const ${name} = /(.+)/([a-z]*);$`, "m"));
    assert.ok(m, `${name} is in workflows.js`);
    return new RegExp(m[1], m[2]);
  };
  const GO = pattern("GO_RE"), STOP = pattern("STOP_RE"), OK = pattern("OK_RE"), BUT = pattern("BUT_RE");
  // Like capIntent in workflows.js: first STOP, then GO.
  const capIntent = (s) => (STOP.test(s) ? "stop" : GO.test(s) ? "go" : "unclear");
  const buttons = (kind, requestId = "") => G.responseForm(waiting({ kind, requestId })).buttons;
  const send = (kind, id) => buttons(kind).find((k) => k.id === id).send;
  assert.equal(capIntent(send("cap", "further")), "go");
  assert.equal(capIntent(send("cap", "more")), "go");
  assert.equal(capIntent(G.responseRequest(waiting({ kind: "cap" }), { button: "more", n: 7 }).body.text), "go");
  assert.equal(capIntent(send("cap", "complete")), "stop");
  for (const kind of ["done", "stopped"]) assert.equal(capIntent(send(kind, "further")), "go", kind);
  assert.ok(OK.test(send("review", "matches")) && !BUT.test(send("review", "matches")), "“matches” is an approval");
  assert.ok(!OK.test(send("cap", "further")), "“further” is no approval at the review (counter-check of the pattern)");
  // The decision words of the two other routes.
  const run = server("dynworkflows", "run.js");
  for (const k of buttons("dyn_approval", "d")) assert.ok(run.includes(`"${k.send}"`), `dyn approval knows “${k.send}”`);
  assert.ok(server("runs", "routes.js").includes('const behavior = b.behavior === "allow" ? "allow" : "deny";'), "the permission knows allow/deny");
  assert.deepEqual(buttons("permission", "p").map((k) => k.send), ["allow", "deny"]);
});

test("Translated: the words and placeholders of the response form are in i18n-de.ts", () => {
  const en = src("lib", "i18n-de.ts");
  const key = ["Continue", "{n} more", "Finish", "Looks good", "Allow", "Deny", "Accept", "Answer …", "Remarks …", "Instruction …", "Own answer …"];
  assert.deepEqual(key.filter((k) => !en.includes(`\n  "${k}":`)), [], "without a German translation");
  // …and every word responseForm can deliver is in the list above (no unchecked new one).
  const lib = src("lib", "graph-runs.ts");
  const section = lib.slice(lib.indexOf("export function responseForm("), lib.indexOf("export type GraphInput"));
  const words = [...section.matchAll(/button\("[^"]+", "([^"]+)"/g), ...section.matchAll(/, "([^"]+ …)"/g)].map((m) => m[1]);
  assert.ok(words.length >= 12, `too few words found (${words.length})`);
  for (const w of words) assert.ok(key.includes(w), `word without a check: ${w}`);
  assert.ok(lib.includes('button("more", "{n} more"'));
});

// ── The card in "Background Tasks", the pill, opening ────────────────────────────────────────────────────────────────
// Counter-tests: in childChatOf the check against the start chat dropped => "Opening" red; in graphDurationMs
// `ms(run?.startedAt) ??` dropped => "Duration" red; `graphRuns` not passed to the background-task list of the bar =>
// "Wiring (card)" red; in ChatStage `graphRuns` not passed to useRunningTasks => likewise.
test("Opening: the child chat of a background run — not the start's chat, not in the foreground, not without chatId", () => {
  assert.equal(G.childChatOf(rear("a", "running"), "c1"), "kind-a");
  assert.equal(G.childChatOf(rear("a", "stopped", { chatId: "c1" }), "c1"), "", "child deleted (child_chat_id NULL) => the view names the start's chat => no opening");
  assert.equal(G.childChatOf(rear("a", "stopped", { chatId: "" }), "c1"), "", "without chatId no opening");
  assert.equal(G.childChatOf(view("v", "running", { chatId: "different" }), "c1"), "", "a foreground run has no card");
  assert.equal(G.childChatOf(rear("a", "running"), null), "kind-a", "without a known start chat: the child");
});

test("Duration and “open”: from the start of the graph run, else from the row; until the end, else until now; open = not finished yet", () => {
  assert.equal(G.graphDurationMs(rear("a", "running", { startedAt: 1_000, run: { status: "running", startedAt: 4_000 } }), 10_000), 6_000, "the run counts from its own start");
  assert.equal(G.graphDurationMs(rear("a", "waiting_lock", { startedAt: 1_000 }), 10_000), 9_000, "without a run from the row");
  assert.equal(G.graphDurationMs(rear("a", "finished", { startedAt: 1_000, endedAt: 3_000 }), 10_000), 2_000, "finished => until endedAt");
  assert.equal(G.graphDurationMs(rear("a", "running", { startedAt: 0 }), 10_000), null, "without a timestamp no duration");
  assert.equal(G.graphDurationMs(rear("a", "running", { startedAt: 12_000 }), 10_000), 0, "never negative (server clock ahead)");
  const open = G.GRAPH_STATES.filter((z) => G.graphOpen(rear("a", z)));
  assert.deepEqual(open, ["earmarked", "waiting_lock", "waiting_storage", "running", "waiting"]);
  for (const z of G.GRAPH_STATES) assert.equal(G.graphOpen(rear("a", z)), G.cardOf(rear("a", z)).stop, `offen == stoppable (${z})`);
  assert.equal(G.graphOpen(rear("a", "toString")), false);
});

test("Wiring (card): cards in the bar (by start time, stop on the start's chat), badge, pill with opening, opening via cbase-open-chat", () => {
  const block = (q, marker) => q.slice(q.indexOf(marker), q.indexOf("/>", q.indexOf(marker)));
  const pane = src("components", "chat", "ChatPane.tsx");
  const inPane = block(pane, "<ChatRightSidebar");
  assert.ok(inPane.includes("graphRuns={graphRuns}") && inPane.includes("stopGraphStart={stopGraphStart}"), "ChatPane gives state and stop to the bar");
  const page = src("components", "chat", "ChatRightSidebar.tsx");
  const bar = block(page, "<AgentBar");
  // The hook chat/chatBackgroundTasks.ts calculates the list (ONCE in the right sidebar), the AgentBar gets the state (`bg`),
  // and the tab counts from it (`bg.running`).
  assert.ok(bar.includes("bg={bg}") && bar.includes("onGraphStop={stopGraphStart}"), "the bar gets state and stop");
  assert.ok(/useBackgroundTasks\(\{[\s\S]*?dynTree, graphRuns,/.test(page), "the hook gets the graph starts");
  assert.ok(page.includes("badge: bg.running }"), "the badge on the icon counts from the SAME list");
  const hook = src("components", "chat", "chatBackgroundTasks.ts");
  assert.ok(hook.includes("backgroundRuns(graphRuns).map((g) => e(graphKey(g.startId), g.startedAt, graphOpen(g),"), "the cards are the background runs, by their start time, open => “Running”");
  assert.ok(hook.includes("bgList({ agents: ag, runs: wf, graph: gr, followUp: taskSequence })"), "ordered through the ONE sequence");
  assert.ok(hook.includes("unloaded = !graphRuns.loaded;"), "before the route answers no empty state (not loaded)");
  const al = src("components", "AgentBar.tsx");
  assert.ok(al.includes("<GraphRunCard key={e.key} chatId={chatId} run={e.graph} now={now} onStop={onGraphStop} onResponse={onGraphResponse} />"), "the card with the stop (and the response)");
  assert.ok(al.includes("const liveRunning = bg.running > 0;"), "the clock ticks as long as something runs");
  assert.ok(al.includes("&& !bg.unloaded;"), "before the route answers no empty state");
  const card = src("components", "chat", "GraphRunCard.tsx");
  assert.ok(card.includes("const card = cardOf(run);") && card.includes("const childChat = childChatOf(run, chatId);") && card.includes("graphDurationMs(run, now)"), "the card calculates nothing itself");
  assert.ok(card.includes('window.dispatchEvent(new CustomEvent("cbase-open-chat", { detail: childChat }))'), "opening via the path of the bell and the channel bar, with the CHILD chat");
  assert.ok(card.includes("{childChat && ("), "without a child chat no opening");
  assert.ok(card.includes("data-bg-task={graphKey(run.startId)}"), "the same key as in the sequence");
  assert.ok(card.includes("await onStop(run.startId);"), "stop via the hook (on the start's chat, from “human”)");
  const stage = src("components", "chat", "ChatStage.tsx");
  assert.ok(stage.includes("wakeup: waitWakeup, dynTree, graphRuns });"), "the pill counts the graph runs");
  const tasksHook = src("components", "chat", "chatTasks.ts");
  assert.ok(tasksHook.includes("graphRuns: graphRuns.runs, graphLoaded: graphRuns.loaded,"), "an unloaded state makes the pill incomplete (“at least”)");
  assert.ok(src("components", "chat", "TasksPill.tsx").includes('p.kind === "workflow" || p.kind === "graph");'), "the pill's sheet offers “Open” for a graph workflow");
});

test("Translated: the card's sentences are in i18n-de.ts", () => {
  const en = src("lib", "i18n-de.ts");
  const card = src("components", "chat", "GraphRunCard.tsx");
  const sets = [...card.matchAll(/\bt\("([^"]+)"/g)].map((m) => m[1]);
  assert.ok(sets.length >= 9, `too few sentences found (${sets.length})`);
  assert.deepEqual([...new Set(sets)].filter((k) => !en.includes(`\n  "${k}":`)), [], "without a German translation");
});

// ── The response in the card ──────────────────────────────────────────────────────────────────────────────────────────
// responseForm calculates the form, responseRequest the request (run against the table above). Here: that the card speaks
// ONLY through these two (no calculation of its own), that "Send" is locked exactly when responseRequest would have nothing
// to send, that the response goes through the hook to the child chat, that "no longer open" (409 or `ok: false` of the
// permission) reloads and shows a notice — and the wiring ChatPane → bar → card.
// Counter-tests: in the hook `|| (r.ok && data?.ok === false)` removed => "Hook (response)" red; in the card
// `disabled={locked || !sendable}` → `disabled={locked}` => "Card (response)" red; in ChatRightSidebar
// `onGraphResponse={respondGraph}` removed => "Wiring (response)" red.
test("Send lock: per wait kind the free text sends exactly when the form has one and it is not empty; every button sends", () => {
  const questions = [{ question: "Way?", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }];
  const kinds = [
    { kind: "question" }, { kind: "cap" }, { kind: "review" }, { kind: "done" }, { kind: "stopped" },
    { kind: "agent_ask", requestId: "q", questions }, { kind: "permission", requestId: "p" }, { kind: "dyn_approval", requestId: "d" },
  ];
  for (const w of kinds) {
    const run = waiting(w);
    const f = G.responseForm(run);
    // The input the card builds for "Send" (GraphRunCard `freeInput`).
    const free = (text, selection = []) => (f.route === "ask-answer" ? { selection, text } : { text });
    assert.equal(G.responseRequest(run, free("")), null, `${w.kind}: empty => locked`);
    assert.equal(G.responseRequest(run, free("  \n ")), null, `${w.kind}: only whitespace => locked`);
    assert.equal(G.responseRequest(run, free("something")) !== null, f.freeText, `${w.kind}: text sendable <=> free text`);
    for (const k of f.buttons) assert.ok(G.responseRequest(run, { button: k.id }), `${w.kind}: button ${k.id}`);
  }
  const ask = waiting(kinds[5]);
  assert.ok(G.responseRequest(ask, { selection: [["A"]], text: "" }), "the question: a selection alone suffices");
});

test("Card (response): the form from card.response, sent via responseRequest and onResponse; locked while sending and until the next state; notice on “no longer open”", () => {
  const card = src("components", "chat", "GraphRunCard.tsx");
  assert.ok(card.includes("{card.response && <GraphResponse run={run} form={card.response} onResponse={onResponse} />}"), "the form comes from cardOf (= responseForm)");
  assert.ok(card.includes("const request = responseRequest(run, input);") && card.includes("await onResponse(request);"), "what responseRequest calculates is what gets sent");
  assert.ok(card.includes("const sendable = responseRequest(run, freeInput) !== null;"), "“Send” asks responseRequest — no rule of its own");
  assert.ok(card.includes("disabled={locked || !sendable}"), "an empty free text cannot be sent");
  assert.ok(card.includes("const locked = sends || accepted === instance || !onResponse;"), "locked while the response is in flight and until the next state arrives");
  assert.ok(card.includes("const instance = `${form.kind}|${form.requestId}|${run.updatedAt}`;"), "the next state is a new updatedAt");
  assert.ok(/await onResponse\(request\);[\s\S]{0,200}setText\(""\);/.test(card), "after 2xx the field is cleared");
  assert.ok(card.includes("if ((e as GraphResponseError)?.noLongerOpen) setHint(true);"), "“no longer open” is a notice, not an error");
  assert.ok(card.includes("data-graph-response-hint") && card.includes("data-graph-response-error"), "both are in the card");
  for (const handle of ["data-graph-question", "data-graph-tool", "data-graph-tool-input", "data-graph-option", "data-graph-button", "data-graph-remaining-count", "data-graph-text", "data-graph-send", "data-graph-more"]) {
    assert.ok(card.includes(handle), `handle ${handle}`);
  }
  assert.ok(/max=\{MORE_MAX\}/.test(card) && card.includes("send({ button: k.id, n })"), "“More {n}” with a selectable number, capped like the server");
  // Every wait kind of the table has a heading — otherwise a raw key would stand above the form.
  const kindWord = card.slice(card.indexOf("const KIND_WORD"), card.indexOf("};", card.indexOf("const KIND_WORD")));
  for (const kind of ["question", "cap", "review", "done", "stopped", "agent_ask", "permission", "dyn_approval"]) {
    assert.ok(new RegExp(`\\b${kind}: "`).test(kindWord), `heading for ${kind}`);
  }
  const en = src("lib", "i18n-de.ts");
  const words = [...kindWord.matchAll(/: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(words.filter((k) => !en.includes(`\n  "${k}":`)), [], "the headings are translated");
});

test("Hook (response): respondGraph sends the request (path and body from responseRequest) — 409 and ok:false mean “no longer open” and reload", () => {
  const hook = src("components", "chat", "chatGraphRuns.ts");
  assert.ok(hook.includes("await fetch(`${API_BASE}${request.path}`, {") && hook.includes("body: JSON.stringify(request.body),"), "path and body as responseRequest calculates them");
  assert.ok(hook.includes('method: "POST",'), "POST");
  assert.ok(hook.includes("const noLongerOpen = r.status === 409 || (r.ok && data?.ok === false);"), "409 — and /permission-decision answers 200 with ok:false");
  assert.ok(hook.includes("if (r.ok && !noLongerOpen) return;"), "2xx is success — graph_run brings the state");
  assert.ok(hook.includes("if (noLongerOpen && id && chatRef.current === id) load(id);"), "“no longer open” reloads the state");
  assert.ok(hook.includes("error.noLongerOpen = noLongerOpen;") && hook.includes("throw error;"), "and throws with the marker");
  assert.ok(/return \{[^}]*\brespondGraph\b[^}]*\};/.test(hook), "the hook returns respondGraph");
  // The route /permission-decision really answers a request that is no longer open with ok:false (not 409).
  const routes = fs.readFileSync(path.resolve(webDir, "..", "server", "backend", "electron", "server", "runs", "routes.js"), "utf8");
  const perm = routes.slice(routes.indexOf('sub === "/permission-decision"'), routes.indexOf('sub === "/permission-decision"') + 3000);
  assert.ok(/return send\(res, 200, \{ ok \}\);/.test(perm), "/permission-decision reports “not open” as ok:false");
  assert.ok(routes.includes('T("This question is no longer open.")'), "/ask-answer reports it as 409");
});

test("Wiring (response): ChatPane → ChatRightSidebar → AgentBar → card, the same hook", () => {
  const block = (q, marker) => q.slice(q.indexOf(marker), q.indexOf("/>", q.indexOf(marker)));
  const pane = src("components", "chat", "ChatPane.tsx");
  assert.ok(pane.includes("const { graphRuns, graphEvent, stopGraphStart, respondGraph, graphHidden, fadeGraphOut } = useGraphRuns(activeId);"), "from the ONE hook");
  assert.ok(block(pane, "<ChatRightSidebar").includes("respondGraph={respondGraph}"), "ChatPane gives the response to the bar");
  const page = src("components", "chat", "ChatRightSidebar.tsx");
  assert.ok(block(page, "<AgentBar").includes("onGraphResponse={respondGraph}"), "the bar gets the response");
  const al = src("components", "AgentBar.tsx");
  assert.ok(al.includes("onResponse={onGraphResponse}"), "the card gets it");
});
