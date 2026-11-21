// The tree computation of the progress tree: src/lib/dyn-tree.ts, compiled with tsc (it imports only the leaf
// history-state.js) and run against written-out expectations. What the server view delivers is checked by
// server/backend/test/dynworkflows-tree.test.js at the main seam; here: bands per phase, n/m, the display word per journal
// state, the loading state (not loaded is not "no workflow") and that no event is lost that reaches the route during the
// request.
//
// Counter-test: in treeModel `finished` counted as `status !== "running" && status !== "waiting"` (a skipped one would count
// as finished) ⇒ "n/m" red.
//
// Run:  node --test web/test/dyn-tree.test.mjs
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
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-dyn-tree-"));
after(() => { try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "dyn-tree.ts"), path.join(webDir, "src", "lib", "agents.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const tree = await import(pathToFileURL(path.join(out, "dyn-tree.js")).href);
const { AGENT_STATES } = await import(pathToFileURL(path.join(out, "history-state.js")).href);
const { tokenText } = await import(pathToFileURL(path.join(out, "agents.js")).href);

const agent = (n, status, phase, extra = {}) => ({ n, label: `A${n}`, phase, status, provider: "claude", model: "claude-opus-5-5", agentId: status === "waiting" ? "" : `ag-${n}`, ...extra });
const run = (runId, agents, extra = {}) => ({
  runId, taskId: `t-${runId}`, name: "tree", status: "running", stoppedOf: "", error: "", startedAt: 1, endedAt: null,
  phase: "Read", phases: ["Read", "Check"], agents, logs: [{ text: "go", phase: "Read", at: 2 }], logsTruncated: 0, ...extra,
});
const event = (b) => ({ type: "harness", subtype: "dynwf_tree", tree: b });

test("n/m: only \"finished\" counts as finished — skipped, failed, stopped, waiting and running do not; m is all agent() calls", () => {
  const l = run("wf_1", [
    agent(1, "finished", "Read"), agent(2, "skipped", "Read"), agent(3, "error", "Read"),
    agent(4, "waiting", "Check", { reason: "cap" }), agent(5, "running", "Check"), agent(6, "stopped", "Check"), agent(7, "finished", "Check"),
  ]);
  const { header } = tree.treeModel(l);
  assert.equal(`${header.finished}/${header.started}`, "2/7");
  assert.equal(header.name, "tree");
  assert.equal(header.phase, "Read");
  assert.equal(header.running, true);
  assert.deepEqual(header.logs.map((z) => z.text), ["go"]);
});

// Phases without agents used to drop out — also those from meta.phases, which the server sends on purpose so that one sees
// what is still to come. Counter-test: the old `.filter((b) => b.rows.length > 0)` back ⇒ this test red.
test("bands: one per phase in the order of the phases, phases without agents with their state, agents without a phase in the last band without a title", () => {
  const l = run("wf_2", [agent(1, "finished", "Check"), agent(2, "running", null), agent(3, "finished", "Addendum"), agent(4, "running", "Check")],
    { phase: "Check", phases: ["Read", "Check", "Report"] });
  const { bands } = tree.treeModel(l);
  assert.deepEqual(bands.map((b) => [b.title, b.rows.map((z) => z.n), b.empty ?? ""]),
    [["Read", [], "without_agents"], ["Check", [1, 4], ""], ["Report", [], "without_agents"], ["Addendum", [3], ""], [null, [2], ""]],
    "\"Report\" lies before \"Addendum\", in which an agent already ran — passed, not pending");
  const comes = tree.treeModel(run("wf_2b", [agent(1, "running", "Implement")], { phase: "Implement", phases: ["Implement", "Check", "Fix"] })).bands;
  assert.deepEqual(comes.map((b) => [b.title, b.empty ?? ""]), [["Implement", ""], ["Check", "pending"], ["Fix", "pending"]]);
  const past = tree.treeModel(run("wf_2c", [agent(1, "error", "Implement")], { status: "failed", phase: "Implement", phases: ["Implement", "Check"] })).bands;
  assert.deepEqual(past.map((b) => [b.title, b.empty ?? ""]), [["Implement", ""], ["Check", "not_reached"]]);
  const now = tree.treeModel(run("wf_2d", [agent(1, "finished", "Plan")], { phase: "Implement", phases: ["Plan", "Implement", "Check"] })).bands;
  assert.deepEqual(now.map((b) => [b.title, b.empty ?? "", b.finished, tree.bandDefaultOpen(b, true)]),
    [["Plan", "", 1, false], ["Implement", "running", 0, false], ["Check", "pending", 0, false]], "the current phase without agents \"runs\"");
  for (const b of [...bands, ...comes, ...past, ...now]) if (b.empty) assert.ok(tree.BAND_EMPTY_WORD[b.empty], `word for ${b.empty}`);
});

test("display word per journal state: from the bound table, finished without a word, waiting and skipped states of their own", () => {
  const l = run("wf_3", ["running", "waiting", "finished", "error", "skipped", "stopped", "without-result"].map((s, i) => agent(i + 1, s, "Read")));
  const rows = tree.treeModel(l).bands[0].rows;
  assert.deepEqual(rows.map((z) => z.state?.identifier ?? "finished"), ["running", "waiting", "finished", "error", "skipped", "stopped", "without-result"]);
  for (const z of rows) if (z.state) assert.deepEqual(z.state, AGENT_STATES[z.state.identifier], "the state comes from AGENT_STATES");
  assert.equal(rows[1].state.word, "waiting");
  assert.equal(rows[4].state.word, "skipped");
});

test("tokens: the lower-bound marker is not lost in conversion", () => {
  const l = run("wf_4", [agent(1, "finished", "Read", { tokens: 4200, tokenKind: "only_output" }), agent(2, "finished", "Read", { tokens: 4200, tokenKind: "full" }), agent(3, "finished", "Read", { tokens: 10 })]);
  const t = (k, p) => k.replace("{tokens}", p?.tokens ?? "");
  const [a, b, c] = tree.treeModel(l).bands[0].rows;
  assert.equal(tokenText(a.tokens, a.tokenKind, t), "at least 4,2k");
  assert.equal(tokenText(b.tokens, b.tokenKind, t), "4,2k");
  assert.equal(tokenText(c.tokens, c.tokenKind, t), "at least 10", "an unknown kind is not full");
});

test("loading state: not loaded is not \"no workflow\"; a read empty list is", () => {
  assert.equal(tree.carriesWorkflow(tree.TREE_UNLOADED), null);
  const empty = tree.treeLoaded(tree.treeLoading(tree.TREE_UNLOADED), { runs: [], additional: 0 });
  assert.equal(empty.loaded, true);
  assert.equal(tree.carriesWorkflow(empty), false);
  assert.equal(tree.carriesWorkflow(tree.treeAfterEvent(empty, event(run("wf_5", [])))), true);
  // An answer without a list (error, foreign shape) is NOT an empty one: the state stays unloaded.
  const broken = tree.treeLoaded(tree.treeLoading(tree.TREE_UNLOADED), { error: "x" });
  assert.equal(tree.carriesWorkflow(broken), null);
});

test("events: replace the run in place, a new one stands in front; those that came during the request lie over the answer", () => {
  const old = run("wf_a", [agent(1, "running", "Read")]);
  let s = tree.treeLoaded(tree.treeLoading(tree.TREE_UNLOADED), { runs: [old, run("wf_b", [])], additional: 3 });
  assert.equal(s.additional, 3);
  s = tree.treeAfterEvent(s, event({ ...old, agents: [agent(1, "finished", "Read")], status: "finished" }));
  assert.deepEqual(s.runs.map((l) => [l.runId, l.status]), [["wf_a", "finished"], ["wf_b", "running"]]);
  s = tree.treeAfterEvent(s, event(run("wf_c", [])));
  assert.deepEqual(s.runs.map((l) => l.runId), ["wf_c", "wf_a", "wf_b"]);
  assert.equal(tree.treeAfterEvent(s, { type: "harness", subtype: "workflow_run" }), s, "foreign events leave the state alone");
  // The request to the route is running; meanwhile the new state arrives — the (older) answer does not overwrite it.
  let r = tree.treeLoading(tree.TREE_UNLOADED);
  r = tree.treeAfterEvent(r, event({ ...old, status: "stopped", stoppedOf: "human" }));
  r = tree.treeLoaded(r, { runs: [old], additional: 0 });
  assert.deepEqual(r.runs.map((l) => [l.runId, l.status]), [["wf_a", "stopped"]]);
  assert.deepEqual(r.buffer, [], "the buffer is empty after the answer");
});

test("badge: running workflow agents of running runs — waiting ones and finished runs do not count", () => {
  const s = tree.treeLoaded(tree.treeLoading(tree.TREE_UNLOADED), {
    runs: [
      run("wf_x", [agent(1, "running", "Read"), agent(2, "waiting", "Read"), agent(3, "running", "Check"), agent(4, "finished", "Check")]),
      run("wf_y", [agent(1, "running", "Read")], { status: "stopped" }),
    ],
    additional: 0,
  });
  assert.equal(tree.runningWorkflowAgents(s), 2);
  assert.equal(tree.runningWorkflowAgents(tree.TREE_UNLOADED), 0);
});

// ── Only in coding chats ──────────────────────────────────────────────────────────────────────────────────────
// The tree hangs in ONE place: ChatPane calls the hook, the right bar of the coding chat hands it to the agent bar. No other
// view gives the agent bar a tree. Counter-test: `workflows={…}` on any other agent bar ⇒ red.
test("only in coding chats: only the right bar of the coding chat hands the tree to the agent bar, nobody else", () => {
  const src = (...parts) => fs.readFileSync(path.join(webDir, "src", ...parts), "utf8");
  const calls = (source) => [...source.matchAll(/<AgentBar\b[\s\S]*?\/>/g)].map((m) => m[0]);
  const bar = calls(src("components", "chat", "ChatRightSidebar.tsx"));
  assert.equal(bar.length, 1);
  assert.match(bar[0], /workflows=\{dynTree\}/, "the bar of the coding chat passes the tree on");
  // The same promise holds over ALL sources: no other file renders an agent bar with a tree, and only ChatPane calls the hook.
  const allSources = [];
  const run = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) run(full);
      else if (/\.tsx?$/.test(e.name)) allSources.push(full);
    }
  };
  run(path.join(webDir, "src"));
  for (const full of allSources) {
    const rel = path.relative(path.join(webDir, "src"), full);
    if (rel === path.join("components", "chat", "ChatRightSidebar.tsx")) continue;
    const q = fs.readFileSync(full, "utf8");
    for (const a of calls(q)) assert.ok(!/\bworkflows=/.test(a), `${rel}: the agent bar gets a tree`);
    if (rel !== path.join("components", "chat", "ChatPane.tsx") && rel !== path.join("components", "chat", "chatDynTree.ts")) {
      assert.ok(!/useDynTree\(/.test(q), `${rel}: calls the tree hook`);
    }
  }
  const pane = src("components", "chat", "ChatPane.tsx");
  assert.equal([...pane.matchAll(/= useDynTree\(activeId\);/g)].length, 1, "ChatPane calls the hook exactly once, with the open chat");
  assert.equal([...pane.matchAll(/treeEvent\(evt\);/g)].length, 1, "onEvent feeds it exactly once");
});

// The two handles per agent row. Counter-test: in agentHandles `restart` computed like `skip` (also "waiting") ⇒ red — a parked
// agent has no attempt that could restart (the server answers 409).
test("handles per row: skip on running and parked ones, restart only on running ones — only started, only in a running run; the path encoded", () => {
  const a = (status, agentId = "ag-1") => ({ status, agentId });
  const g = (x, l = true) => tree.agentHandles(x, l);
  assert.deepEqual(g(a("running")), { skip: true, restart: true });
  assert.deepEqual(g(a("waiting")), { skip: true, restart: false }, "parked at the limit (waits WITH agentId)");
  assert.deepEqual(g(a("waiting", "")), { skip: false, restart: false }, "a waiting one without a process");
  assert.deepEqual(g(a("running", "")), { skip: false, restart: false }, "called, not started yet");
  for (const s of ["finished", "error", "skipped", "stopped", "without-result"]) assert.deepEqual(g(a(s)), { skip: false, restart: false }, s);
  assert.deepEqual(g(a("running"), false), { skip: false, restart: false }, "nothing in a finished run");
  assert.equal(tree.interventionPath("c 1", "wf_1", 3, "skip"), "/api/chats/c%201/dyn-workflows/runs/wf_1/agents/3/skip");
  assert.equal(tree.interventionPath("c1", "wf/x", 1, "restart"), "/api/chats/c1/dyn-workflows/runs/wf%2Fx/agents/1/restart");
});

// The wait reason as text, per row and at the head of a phase in which only waiting remains. That iOS says the same is held
// by dyn-tree-binding.test.mjs. COUNTER-TESTS: in `waitText` the number taken without checking the kind (`cap?.run` for
// every kind) ⇒ "wait reason per row" red at "kind user takes the number of the user cap"; in `bandWaitText` without
// `some(… "running")` ⇒ "wait reason at the phase head" red; in DynWorkflowTree.tsx the cell without
// `@min-[18rem]/phase:w-[152px]` ⇒ "form (web): the wait reason" red; in `waitCell` without the `startedAt` check ⇒ "wait
// reason: cell or columns" red at "started, without tokens"; in DynWorkflowTree.tsx the cell again for every waiting row
// (`const cell = wait;`) ⇒ "form (web): the wait reason" red at "the cell only via waitCell"; in `WAIT_TEXTS.user` the old
// short form "waiting · user cap {n}" ⇒ "wait reason per row" red at "the number in front"; in DynWorkflowTree.swift in front of
// the token column `if identifier != "waiting" {` ⇒ "form (iOS): the wait reason" red at "tokens and time stand in every row".
// A parked agent that already ran (parked at the usage limit: waiting with `startedAt` and tokens) keeps its columns; the
// narrow cell (84 px) truncates at the END, so every version with a number carries it directly behind "waiting · ".
const wt = (w) => (w ? [w.short, w.values.n ?? null, w.values.reason ?? null] : null);
test("wait reason per row: short, long and explanation, the number only if kind AND number are known", () => {
  // An explicit `undefined` as the cap is the older server — no default value that covers it.
  const w = (reason, kind, ...rest) => tree.waitText({ status: rest[1] ?? "waiting", reason, cap: kind }, rest.length ? rest[0] : { run: 2, user: 8 });
  // The narrow cell (84 px) truncates at the END — "waiting · user cap 8" lost exactly the number there. Every version with a
  // number therefore carries it directly behind "waiting · ", in the short one as in the long one (behind the middle dot).
  for (const kind of tree.CAP_KINDS) {
    const f = w("cap", kind);
    assert.ok(f.short.startsWith("waiting · {n} "), `the number in front (${kind}): ${f.short}`);
    assert.ok(f.lang.startsWith("waiting for a free slot · {n} "), `the number in front (${kind}, long): ${f.lang}`);
  }
  assert.deepEqual(wt(w("cap", "run")), ["waiting · {n} at a time", 2, null], "the reported case: the cap per run holds, number 2");
  assert.deepEqual(wt(w("cap", "user")), ["waiting · {n} per user", 8, null], "kind user takes the number of the user cap");
  assert.equal(w("cap", "run").lang, "waiting for a free slot · {n} at a time");
  assert.equal(w("cap", "user").lang, "waiting for a free slot · {n} per user");
  // The cap per run is a fixed 8 (dynworkflows/cap.js) — the explanation no longer names a core count as the reason.
  assert.doesNotMatch(w("cap", "run").explanation, /processor|\bcores?\b/i, "the explanation names the processor cores as the reason — the number no longer follows from them");
  assert.match(w("cap", "user").explanation, /Concurrent workflow agents/, "… and where to set it");
  // Empty is not unknown: without kind, without number, with a number that is none — the text without a number, none invented.
  for (const [kind, d, why] of [[undefined, { run: 2 }, "without kind"], ["other", { run: 2 }, "unknown kind"], ["run", undefined, "older server"],
    ["run", { user: 8 }, "the number of the kind is missing"], ["run", { run: 0 }, "zero"], ["run", { run: 2.5 }, "not an integer"], ["run", { run: "2" }, "text"]]) {
    assert.deepEqual(wt(w("cap", kind, d)), ["waiting for a slot", null, null], why);
    assert.equal(w("cap", kind, d).lang, "waiting for a free slot", why);
  }
  assert.deepEqual(wt(w("stagger", "run")), ["waiting · prompt cache", null, null], "the kind of a cap applies only for the reason \"cap\"");
  assert.deepEqual(wt(w("limit")), ["waiting · limit", null, null]);
  assert.deepEqual(wt(w("credit-gate")), ["waiting · credit gate", null, null]);
  assert.deepEqual(wt(w("project")), ["waiting · project", null, null]);
  assert.deepEqual(wt(w(undefined)), ["waiting", null, null], "without a reason only the word");
  assert.deepEqual(wt(w(7)), ["waiting", null, null], "a reason that is not a string is none");
  assert.deepEqual(wt(w("new-reason")), ["waiting · {reason}", null, "new-reason"], "an unknown reason verbatim");
  for (const status of ["running", "finished", "error", "skipped", "stopped", "without-result"]) assert.equal(w("cap", "run", undefined, status), null, `${status} does not wait`);
  // Every key stands in i18n-de.ts (the web translates via t(…, values)) — and none twice (TS1117).
  const en = fs.readFileSync(path.join(webDir, "src", "lib", "i18n-de.ts"), "utf8");
  const keys = [...en.matchAll(/^ {2}"((?:[^"\\]|\\.)*)":/gm)].map((m) => m[1]);
  assert.ok(tree.WAIT_KEY.length >= 20, `too few keys (${tree.WAIT_KEY.length})`);
  assert.deepEqual([...new Set(tree.WAIT_KEY)].filter((k) => !keys.includes(k)), [], "without a German translation");
  assert.deepEqual(keys.filter((k, i) => keys.indexOf(k) !== i && tree.WAIT_KEY.includes(k)), [], "duplicate keys (TS1117)");
});

// The seam server ↔ client: every reason the server writes into the journal and every cap kind that cap.js reports has its own
// wording in the client — and the client knows no reason the server never writes. The sources are read by path; every anchor
// THROWS if it finds nothing. Counter-test: the case `"project"` removed in `waitText` ⇒ red at "own wording".
test("wait reason: every reason and every cap kind the server writes has its own wording — and none without a reason", (t) => {
  const server = (d) => fs.readFileSync(path.join(webDir, "..", "server", "backend", "electron", "server", "dynworkflows", d), "utf8");
  const run = server("run.js");
  const fromRun = [...run.matchAll(/journal\(\{ kind: "waiting",[^}]*?reason: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(fromRun.length >= 5, `anchor run.js: only ${fromRun.length} journal entries \"waiting\" with a reason found`);
  const parked = server("tree.js").match(/rec\?\.status === "parked" \? "([^"]+)"/);
  assert.ok(parked, "anchor tree.js: the reason of a parked agent");
  const kinds = server("cap.js").match(/waiting2\?\.\(occupiedOf\(runId\) >= runCap\(\) \? "([^"]+)" : "([^"]+)"\)/);
  assert.ok(kinds, "anchor cap.js: the kind of the cap that holds");
  const reasons = [...new Set([...fromRun, parked[1]])].sort();
  t.diagnostic(`[wait reason] server: ${reasons.length} reasons (${reasons.join(", ")}), kinds ${kinds[1]}/${kinds[2]}`);
  assert.deepEqual(reasons, [...tree.WAIT_REASONS].sort(), "the server writes other reasons than the client knows");
  for (const reason of tree.WAIT_REASONS) {
    const w = tree.waitText({ status: "waiting", reason }, undefined);
    assert.ok(w && w.short !== "waiting · {reason}" && w.short !== "waiting", `"${reason}" has no wording of its own (${w?.short})`);
  }
  assert.deepEqual([kinds[1], kinds[2]].sort(), [...tree.CAP_KINDS].sort(), "the server reports other kinds of the cap than the client knows");
  for (const kind of [kinds[1], kinds[2]]) {
    assert.equal(tree.waitText({ status: "waiting", reason: "cap", cap: kind }, { run: 3, user: 4 })?.values.n, kind === "run" ? 3 : 4, `kind "${kind}" takes the number of its cap`);
  }
});

test("wait reason at the phase head: only in a running run, only if waiting and nothing is worked on — the first waiting agent speaks", () => {
  const z = (status, extra = {}) => ({ n: 1, status, ...extra });
  const d = { run: 2, user: 8 };
  const band = (...rows) => ({ rows });
  const maintainer = band(...[3, 4, 5, 6, 7, 8].map((n) => z("waiting", { n, reason: "cap", cap: "run" })));
  assert.equal(tree.bandWaitText(maintainer, true, d)?.lang, "waiting for a free slot · {n} at a time", "the reported case");
  assert.equal(tree.bandWaitText(maintainer, true, d)?.values.n, 2);
  assert.equal(tree.bandWaitText(band(z("running"), z("waiting", { reason: "cap", cap: "run" })), true, d), null, "if one runs, the phase has not stalled");
  assert.equal(tree.bandWaitText(band(z("finished"), z("waiting", { reason: "limit" })), true, d)?.short, "waiting · limit", "finished and waiting: the head says what for");
  assert.equal(tree.bandWaitText(band(z("waiting", { reason: "stagger" }), z("waiting", { reason: "cap", cap: "run" })), true, d)?.short, "waiting · prompt cache", "the FIRST waiting agent");
  assert.equal(tree.bandWaitText(maintainer, false, d), null, "nothing in a finished run");
  assert.equal(tree.bandWaitText(band(z("finished"), z("error")), true, d), null, "nothing without a waiting agent");
  assert.equal(tree.bandWaitText(band(), true, d), null, "an empty phase has its own word (BAND_EMPTY_WORD)");
  // Through treeModel: the same phase from a server view.
  const l = run("wf_w", [agent(1, "running", "Checks"), agent(2, "running", "QA"), ...[3, 4, 5, 6, 7, 8].map((n) => agent(n, "waiting", "Verify", { reason: "cap", cap: "run" }))],
    { phase: "Verify", phases: ["Checks", "QA", "Verify"], cap: d });
  const { header, bands } = tree.treeModel(l);
  assert.deepEqual(bands.map((b) => [b.title, tree.bandWaitText(b, header.running, l.cap)?.values.n ?? null]), [["Checks", null], ["QA", null], ["Verify", 2]]);
});

// The cell over model, tokens and time only while the waiting agent has NOTHING of them. An agent that already ran and is parked
// at the usage limit comes from tree.js as "waiting" with reason "limit", `startedAt` and tokens — the cell would have hidden
// both. Counter-test in the head of the wait-reason block above.
test("wait reason: cell or columns — the cell only without start and without tokens, the parked one keeps its columns", () => {
  const a = (status, extra = {}) => ({ n: 1, status, reason: "limit", ...extra });
  assert.equal(tree.waitCell(a("waiting", { reason: "cap", cap: "run" })), true, "waits for a slot, has nothing: the cell");
  for (const reason of tree.WAIT_REASONS) assert.equal(tree.waitCell(a("waiting", { reason })), true, `${reason}, without start and tokens: the cell`);
  assert.equal(tree.waitCell(a("waiting", { startedAt: 5, tokens: 40, tokenKind: "full" })), false, "parked at the limit (started, with tokens): the columns stay");
  assert.equal(tree.waitCell(a("waiting", { startedAt: 5 })), false, "started, without tokens");
  assert.equal(tree.waitCell(a("waiting", { tokens: 40 })), false, "tokens without start");
  assert.equal(tree.waitCell(a("waiting", { tokens: 0 })), false, "zero tokens are a number, not a missing one");
  for (const status of ["running", "finished", "error", "skipped", "stopped", "without-result"]) assert.equal(tree.waitCell(a(status)), false, `${status} does not wait`);
  // Through the server view: the parked one and one waiting at the cap in the same phase — only the second gets the cell, and
  // both say their reason (waitText).
  const l = run("wf_p", [agent(1, "waiting", "Verify", { reason: "limit", agentId: "ag-1", startedAt: 9_000_000, tokens: 1200, tokenKind: "full" }),
    agent(2, "waiting", "Verify", { reason: "cap", cap: "run" })], { phase: "Verify", phases: ["Verify"], cap: { run: 2, user: 8 } });
  const rows = tree.treeModel(l).bands[0].rows;
  assert.deepEqual(rows.map((z) => [z.n, tree.waitCell(z), tree.waitText(z, l.cap)?.short, tree.agentDurationMs(z, l, 9_000_500)]),
    [[1, false, "waiting · limit", 500], [2, true, "waiting · {n} at a time", null]]);
});

// The form of the wait reason on the web: the cell stands in place of model, tokens and time and is EXACTLY as wide as they
// including gaps — otherwise the edges of the number columns jump between waiting and running rows; the phase head carries the
// text under the tiles, dimmed, without a surface of its own. Reads source text (without comments).
test("form (web): the wait reason stands visibly in the row and at the phase head, the cell as wide as the three columns", () => {
  const q = withoutComments(fs.readFileSync(path.join(webDir, "src", "components", "chat", "DynWorkflowTree.tsx"), "utf8"));
  const px = (name) => {
    const m = q.match(new RegExp(`const ${name} = "w-\\[(\\d+)px\\]"`));
    assert.ok(m, `column width ${name} not found`);
    return Number(m[1]);
  };
  const gap = 6; // gap-1.5 of the row
  assert.match(q, /className="cb-row group flex items-center gap-1\.5 /, "the row carries gap-1.5 — otherwise the computation is wrong");
  const wait = q.match(/const SP_WAIT = "w-\[(\d+)px\] @min-\[18rem\]\/phase:w-\[(\d+)px\]"/);
  assert.ok(wait, "the wait-reason cell has a narrow and a wide version (container query like the model column)");
  assert.match(q, /const MODEL_VISIBLE = "hidden @min-\[18rem\]\/phase:block"/, "the same threshold as the model column");
  assert.equal(Number(wait[1]), px("SP_TOKEN") + gap + px("SP_TIME"), "narrow: tokens + time");
  assert.equal(Number(wait[2]), px("SP_MODEL") + gap + px("SP_TOKEN") + gap + px("SP_TIME"), "wide: model + tokens + time");
  const row = q.slice(q.indexOf("\nfunction AgentRow("));
  assert.match(row, /const wait = identifier === "waiting" \? waitText\(row, run\.cap\) : null;/, "the row computes the reason via waitText");
  // The cell only via `waitCell`, otherwise the reason next to the label and the columns stay.
  assert.match(row, /const cell = wait && waitCell\(row\) \? wait : null;/, "the cell only via waitCell");
  assert.match(row, /const beside = wait && !cell \? wait : null;/, "otherwise the reason stands next to the label");
  assert.match(row, /\{cell \? \(\s*<span className=\{`\$\{SP_WAIT\} shrink-0 truncate text-\[11px\] text-dim`\} data-dynwf-wait/, "the waiting row without values shows the reason as a cell, dimmed");
  assert.match(row, /\{t\(cell\.short, cell\.values\)\}\s*<\/span>\s*\) : \(\s*<>\s*<span className=\{`\$\{SP_MODEL\}/, "the short version with number stands visibly — otherwise the columns from model on");
  const besideLabel = row.match(/<span className="min-w-0 truncate text-\[12px\]">\{label\}<\/span>\s*\{beside \? \(\s*<span className="([^"]*)"[^>]*data-dynwf-wait-beside[^>]*>\s*\{t\(beside\.short, beside\.values\)\}/);
  assert.ok(besideLabel, "the reason of a waiting one with values stands short directly behind the label");
  assert.match(besideLabel[1], /(?:^|\s)text-dim(?:\s|$)/, `dimmed: ${besideLabel[1]}`);
  assert.match(besideLabel[1], /(?:^|\s)truncate(?:\s|$)/, `truncated instead of wrapped: ${besideLabel[1]}`);
  assert.doesNotMatch(besideLabel[1], /(?:^|\s)(?:rounded[\w-[\]]*|border[\w-]*|bg-[\w/[\]-]+)(?=\s|$)/, `the reason next to the label is a badge: ${besideLabel[1]}`);
  const phase = q.slice(q.indexOf("\nfunction PhasesSection("), q.indexOf("\nfunction StateSymbol("));
  assert.match(phase, /const wait = bandWaitText\(band, header\.running, run\.cap\);/);
  const headerRow = phase.match(/\{wait && \(\s*<span className="([^"]*)"[^>]*data-dynwf-band-wait>\s*\{t\(wait\.lang, wait\.values\)\}/);
  assert.ok(headerRow, "the phase head shows the reason in the long version");
  assert.doesNotMatch(headerRow[1], /(?:^|\s)(?:rounded[\w-[\]]*|border[\w-]*|bg-[\w/[\]-]+)(?=\s|$)/, `the reason at the phase head is a card: ${headerRow[1]}`);
});

test("form (iOS): the wait reason with number in the side line and at the phase head, computed by DynTree", () => {
  const ios = withoutComments(fs.readFileSync(path.join(webDir, "..", "mobile", "CbaseMobile", "Chat", "DynWorkflowTree.swift"), "utf8"));
  assert.doesNotMatch(ios, /waitReason/, "the old reason without a number");
  assert.match(ios, /let wait = DynTree\.bandWaitText\(band, runRunning: header\.running, cap: run\.cap\)/);
  assert.match(ios, /if let wait \{\s*Text\(L\(wait\.lang, wait\.values\)\)/, "the phase head shows the reason");
  assert.match(ios, /\.accessibilityIdentifier\("chat-dynwf-band-wait"\)/);
  assert.match(ios, /if z\.identifier == "waiting", let w = DynTree\.waitText\(agent, cap: run\.cap\) \{\s*parts\.append\(L\(w\.short, w\.values\)\)/, "the side line shows the short version with number");
  // The same rule as on the web: the reason never displaces tokens and time. Both columns stand in EVERY row directly behind
  // the row button, without a condition (also for the one parked at the limit).
  assert.match(ios, /\.accessibilityIdentifier\("chat-dynwf-agent-\\\(run\.runId\)-\\\(agent\.n\)"\)\s*Text\(Self\.tokenColumn\(agent\)\)[\s\S]*?\.accessibilityIdentifier\("chat-dynwf-tokens-[^"]*"\)\s*Text\(timeColumn\)/,
    "tokens and time status in every row, without a condition");
});

// What cards, tiles and table show is computed by the same file — n/m and default "open" per phase, tile kind, times, token sum,
// short model name. Counter-test: in `agentDurationMs` for a finished run `now` instead of the end of the run (a stopped agent
// kept counting) ⇒ "time per agent" red.
test("phase cards: n/m per card (only \"finished\"), open only in a running run and only while something runs or waits in it", () => {
  const l = run("wf_k", [
    agent(1, "finished", "Read"), agent(2, "skipped", "Read"),
    agent(3, "running", "Check"), agent(4, "finished", "Check"),
    agent(5, "waiting", "Wait"), agent(6, "error", null),
  ], { phases: ["Read", "Check", "Wait"] });
  const { bands } = tree.treeModel(l);
  assert.deepEqual(bands.map((b) => [b.title, `${b.finished}/${b.rows.length}`, tree.bandDefaultOpen(b, true)]),
    [["Read", "1/2", false], ["Check", "1/2", true], ["Wait", "0/1", true], [null, "0/1", false]]);
  for (const b of bands) assert.equal(tree.bandDefaultOpen(b, false), false, "a finished run opens nothing by itself");
});

// Finished is GREEN, stopped/without result amber — web AND iOS.
test("tiles: blue running, green finished, outlined waiting, red error, amber aborted, otherwise dimmed", () => {
  assert.deepEqual(["running", "finished", "waiting", "error", "skipped", "stopped", "without-result", "whatever", ""].map(tree.tileKind),
    ["running", "finished", "waiting", "error", "muted", "aborted", "aborted", "muted", "muted"]);
  // The colour per kind at the sources: a finished tile is green, never grey.
  const web = fs.readFileSync(path.join(webDir, "src", "components", "chat", "DynWorkflowTree.tsx"), "utf8");
  const table = web.match(/const TILE[^=]*=\s*\{([\s\S]*?)\};/);
  assert.ok(table, "the table TILE stands in DynWorkflowTree.tsx");
  const color = Object.fromEntries([...table[1].matchAll(/(\w+):\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(Object.keys(color).sort(), ["aborted", "error", "finished", "muted", "running", "waiting"]);
  assert.match(color.finished, /(?:^|\s)bg-ok(?:\/\d+)?(?=\s|$)/, `web: finished is not green: ${color.finished}`);
  assert.match(color.running, /(?:^|\s)bg-accent(?:\/\d+)?(?=\s|$)/);
  assert.match(color.error, /(?:^|\s)bg-danger(?:\/\d+)?(?=\s|$)/);
  assert.match(color.aborted, /(?:^|\s)bg-warn(?:\/\d+)?(?=\s|$)/);
  const ios = fs.readFileSync(path.join(webDir, "..", "mobile", "CbaseMobile", "Chat", "DynWorkflowTree.swift"), "utf8");
  const fall = (kind) => ios.match(new RegExp(`case "${kind}":\\s*form\\.(\\w+)\\(Color\\.(\\w+)`))?.slice(1).join(" ");
  assert.equal(fall("finished"), "fill green", "iOS: finished is not green");
  assert.equal(fall("running"), "fill accentColor");
  assert.equal(fall("error"), "fill red");
  assert.equal(fall("aborted"), "fill orange");
});

test("time per agent and run: start to end, running until now, in a finished run until its end; never started is no zero", () => {
  const running = { status: "running", endedAt: null };
  const to = { status: "stopped", endedAt: 9000 };
  assert.equal(tree.agentDurationMs({ startedAt: 100, endedAt: 5100 }, running, 1e7), 5000);
  assert.equal(tree.agentDurationMs({ startedAt: 100 }, running, 1100), 1000, "running: until now");
  assert.equal(tree.agentDurationMs({ startedAt: 100 }, to, 1e7), 8900, "without an own end in a finished run: until the end of the run");
  assert.equal(tree.agentDurationMs({ startedAt: 100 }, { status: "finished", endedAt: null }, 1e7), null);
  assert.equal(tree.agentDurationMs({ endedAt: 400 }, running, 1e7), null, "never started (from the journal, failed before the start)");
  assert.equal(tree.agentDurationMs({ startedAt: 500, endedAt: 400 }, running, 1e7), 0, "never negative");
  assert.equal(tree.runDurationMs({ status: "running", startedAt: 1000, endedAt: null }, 4000), 3000);
  assert.equal(tree.runDurationMs({ status: "finished", startedAt: 1000, endedAt: 2500 }, 1e7), 1500);
  assert.equal(tree.runDurationMs({ status: "finished", startedAt: 1000, endedAt: null }, 1e7), null);
  assert.equal(tree.runDurationMs({ status: "running", startedAt: 0, endedAt: null }, 1e7), null, "a sparse view without start");
});

test("token sum: only reported numbers, lower bound as soon as one is not full, without any number no sum", () => {
  assert.deepEqual(tree.runTokens({ agents: [{ tokens: 1000, tokenKind: "full" }, { tokens: 50, tokenKind: "full" }, {}] }), { tokens: 1050, tokenKind: "full" });
  assert.deepEqual(tree.runTokens({ agents: [{ tokens: 1000, tokenKind: "full" }, { tokens: 7 }] }), { tokens: 1007, tokenKind: "only_output" }, "an unknown kind is not full");
  assert.deepEqual(tree.runTokens({ agents: [{ tokens: 3, tokenKind: "only_output" }] }), { tokens: 3, tokenKind: "only_output" });
  assert.equal(tree.runTokens({ agents: [{}, { tokenKind: "full" }] }), null);
  assert.equal(tree.runTokens({ agents: [] }), null);
});

test("parts of the run sum: only if EVERY counted agent carries its parts", () => {
  const parts = (input, cacheWrite, cacheRead, output) => ({ input, cacheWrite, cacheRead, output });
  assert.deepEqual(
    tree.runTokenParts({ agents: [{ tokens: 22_729, tokenParts: parts(10, 19_288, 102_640, 3_431) }, { tokens: 46_000, tokenParts: parts(44_101, 0, 210_944, 2_246) }, {}] }),
    parts(44_111, 19_288, 313_584, 5_677));
  // An agent without parts (an older journal) — a breakdown that does not fit the sum does not exist.
  assert.equal(tree.runTokenParts({ agents: [{ tokens: 5, tokenParts: parts(5, 0, 0, 0) }, { tokens: 7 }] }), null);
  assert.equal(tree.runTokenParts({ agents: [{}] }), null);
  // An agent at 0 without parts (Codex before the turn end, stopped before the first call) does not take the breakdown from the run.
  assert.deepEqual(tree.runTokenParts({ agents: [{ tokens: 5, tokenParts: parts(5, 0, 0, 0) }, { tokens: 0 }] }), parts(5, 0, 0, 0));
});

// One card per run, the phases sections inside (only the hairline on top), spacing between two runs, NO accent border — web
// AND iOS. The computed styles are measured by hand in a real browser (not in the gate); here the guard stands on the
// sources so that the border does not silently come back. Reads only source text (without comments), also runs on Linux.
// Counter-test: against the old form of both files ⇒ red (web: `border-accent/55` on the open phase, a card per phase; iOS:
// `CbPane(accent:)`, the accent overlay of the phase).
const withoutComments = (q) => q.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
test("form (web): one card per run, the phases without a card of their own, no accent border, no heading \"Phases\"", () => {
  const web = withoutComments(fs.readFileSync(path.join(webDir, "src", "components", "chat", "DynWorkflowTree.tsx"), "utf8"));
  // No accent on border, ring, outline, shadow or divider — in no spelling (side, opacity, state).
  const accentMargin = web.match(/(?<![\w-])(?:[\w-]+:)*(?:border(?:-[trblxyse])?|ring(?:-offset)?|outline|shadow|divide(?:-[xy])?)-accent(?:\/\d+)?(?![\w-])/g);
  assert.equal(accentMargin, null, `accent border in DynWorkflowTree.tsx: ${accentMargin}`);
  // The card of the run: the one surface, at the place with data-dynwf-header — radius and surface like the subagent list.
  // The card carries no border: a surface is rounding + `bg-panel` instead of rounding + border, plus `cb-task-card` (in dark
  // mode it raises the surface one step, globals.css), still without a border.
  const card = web.match(/<section className="([^"]*)"\s+data-dynwf-header=/);
  assert.ok(card, "the card carries data-dynwf-header");
  assert.equal(card[1], "overflow-hidden rounded-xl bg-panel cb-task-card");
  // Otherwise NO element carries a surface or a full border with rounding (the tiles carry their outline via the table TILE,
  // not as a class on the element).
  const classes = [...web.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]);
  const surfaces = classes.filter((k) => /(?:^|\s)rounded(?:-[\w[\]]+)?(?=\s|$)/.test(k) && /(?:^|\s)(?:border|bg-panel)(?=\s|$)/.test(k));
  assert.deepEqual(surfaces, [card[1]], "exactly ONE surface with rounding");
  // The phase: a section — hairline on top, no border, no rounding, no background, no state change on the border.
  const phase = web.match(/className=(?:"([^"]*)"|\{`([^`]*)`\})\s+data-dynwf-band=/);
  assert.ok(phase, "the section of the phase carries data-dynwf-band");
  const pk = phase[1] ?? phase[2];
  assert.match(pk, /(?:^|\s)border-t(?=\s|$)/, "the phase carries its hairline on top");
  assert.doesNotMatch(pk, /(?:^|\s)(?:rounded[\w-[\]]*|border|border-[lrbxy]|bg-[\w/[\]-]+|shadow[\w-]*|ring[\w-]*)(?=\s|$)|\$\{/, `the phase is a card: ${pk}`);
  // Spacing between two runs, no divider; the heading "Phases" is gone.
  assert.doesNotMatch(web, /\[&>\*\+\*\]:border-t/, "a divider stands between two runs again");
  assert.doesNotMatch(web, /t\("Phases"\)/, "the heading \"Phases\" is back");
});

test("form (iOS): one CbPane per run, the phases without one of their own, no accent border, no heading \"Phases\"", () => {
  const ios = withoutComments(fs.readFileSync(path.join(webDir, "..", "mobile", "CbaseMobile", "Chat", "DynWorkflowTree.swift"), "utf8"));
  assert.doesNotMatch(ios, /CbPane\s*\(\s*accent/, "iOS: the tinted surface with accent border (CbPane(accent:))");
  assert.doesNotMatch(ios, /(?:strokeBorder|stroke|border)\s*\(\s*(?:Color\.)?accentColor/, "iOS: a border in the accent colour");
  assert.equal((ios.match(/\bCbPane\b/g) ?? []).length, 1, "iOS: exactly ONE surface — the card of the run, none per phase");
  assert.doesNotMatch(ios, /\bDivider\(\)/, "iOS: spacing between two runs, no divider");
  assert.doesNotMatch(ios, /L\("Phases"\)/, "iOS: the heading \"Phases\" is back");
});

// ONE list "Background Tasks": every card has the same design as the workflow card, 6 px spacing, no card of the main run,
// no bands, no dot. The order is held by bg-rows.test.mjs, the computed styles are measured in a real browser.
// Counter-test: against the old form of AgentBar.tsx, DynWorkflowTree.tsx, ChatDetailSheet.swift and DynWorkflowTree.swift ⇒
// both tests red.
const classOf = (q, m) => m[1] ?? m[2];
const classesWithTag = (q) => [...q.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
  .map((m) => ({ tag: (q.slice(q.lastIndexOf("<", m.index)).match(/^<([\w.]+)/) ?? [])[1] ?? "", kind: classOf(q, m) }));
test("form (web): background tasks in \"Running\"/\"Ended\", every card in the form of the workflow card, 6 px spacing, no main run", () => {
  const treeQ = withoutComments(fs.readFileSync(path.join(webDir, "src", "components", "chat", "DynWorkflowTree.tsx"), "utf8"));
  const bar = withoutComments(fs.readFileSync(path.join(webDir, "src", "components", "AgentBar.tsx"), "utf8"));
  const wfCard = treeQ.match(/<section className="([^"]*)"\s+data-dynwf-header=/)[1];
  // The card of the subagent: the SAME surface as the card of the run, character for character.
  const agCard = bar.match(/<section className="([^"]*)"\s+data-agents-card\b/);
  assert.ok(agCard, "the subagent card is a <section> with data-agents-card");
  assert.equal(agCard[1], wfCard, "the subagent card carries a different surface than the workflow card");
  // No other surface with border and rounding than the cards (buttons excepted — they are no card): those of the subagent and of
  // a running command/monitor (`ItemCard`), character for character like the workflow card. No accent border, no dot.
  const surfaces = classesWithTag(bar).filter(({ tag, kind }) => tag !== "button"
    && /(?:^|\s)rounded(?:-[\w[\]]+)?(?=\s|$)/.test(kind) && /(?:^|\s)(?:border|bg-panel)(?=\s|$)/.test(kind)).map((k) => k.kind);
  // Plus the card of the wakeup — the same surface — and the own card of a monitor (`MonitorCard`: stop, kind, log).
  assert.deepEqual(surfaces, [wfCard, wfCard, wfCard, wfCard], "the cards (subagent, command, monitor, wakeup) — no other surface with border and rounding");
  const accentMargin = bar.match(/(?<![\w-])(?:[\w-]+:)*(?:border(?:-[trblxyse])?|ring(?:-offset)?|outline|shadow|divide(?:-[xy])?)-accent(?:\/\d+)?(?![\w-])/g);
  assert.equal(accentMargin, null, `accent border in AgentBar.tsx: ${accentMargin}`);
  assert.doesNotMatch(bar, /rounded-full/, "a dot before the row — the card carries ONE state indicator, the coloured word");
  assert.match(bar, /data-agents-word/, "the state word of the card");
  // The selection opens IN the card: a section with a hairline on top, without a surface of its own.
  const selection = bar.match(/<div className="([^"]*)" data-agents-selection/);
  assert.ok(selection, "the opened section carries data-agents-selection");
  assert.match(selection[1], /(?:^|\s)border-t(?=\s|$)/);
  assert.doesNotMatch(selection[1], /(?:^|\s)(?:rounded[\w-[\]]*|bg-[\w/[\]-]+)(?=\s|$)/, `the section is a card: ${selection[1]}`);
  const report = bar.match(/<div([^>]*)data-agents-report/);
  assert.ok(report && !/className/.test(report[1]), "the report stands in the section without a box of its own");
  // "Background tasks" is the title of the panel (ChatRightSidebar), below it two sections with 6 px spacing; the headings per
  // kind, the old-form bands and the card of the main run are gone.
  const barSidebar = withoutComments(fs.readFileSync(path.join(webDir, "src", "components", "chat", "ChatRightSidebar.tsx"), "utf8"));
  assert.match(barSidebar, /<Header title=\{t\("Background tasks"\)\} \/>/, "the title of the panel is \"Background Tasks\"");
  assert.doesNotMatch(bar, /t\("Background tasks"\)/, "a second heading \"Background Tasks\" in the list");
  // Both sections under ONE node in ONE map (lib/bg-rows.ts, guard bg-rows.test.mjs): in two nodes React rebuilt the card of a
  // workflow that ended under the eye, and it folded shut. The mark `data-bg-section` therefore sits on the head of the section.
  assert.match(bar, /<div className="space-y-1\.5" data-bg-tasks>\s*\{rows\.map\(/, "\"Running\" and \"Ended\" with 6 px spacing, ONE node");
  assert.match(bar, /section="running"/, "the section \"Running\"");
  assert.match(bar, /section="ended"/, "the section \"Ended\"");
  assert.match(bar, /aria-expanded=\{!endedClosed\} data-bg-ended/, "\"Ended\" collapsible");
  for (const q of [bar, treeQ]) {
    assert.doesNotMatch(q, /t\("Subagents of this chat"\)|t\("Dynamic workflows"\)/, "a heading per kind is back");
  }
  assert.doesNotMatch(bar, /data-agents-main-run|\bMainRun\b|mainRun/, "the card of the main run is back");
  assert.doesNotMatch(bar, /data-agents-band|\bBandHeader\b/, "the old-form bands (column heads, own reason) are back");
  assert.doesNotMatch(treeQ, /export function DynWorkflowTree\b|data-dynwf-tree/, "the own workflow list is back");
  // Every card carries its key in the list.
  assert.match(bar, /data-agents-card data-bg-task=\{taskKey\}/);
  assert.match(treeQ, /data-bg-task=\{workflowKey\(run\.runId\)\}/);
  // No main-run props any more on the way there (grepped by NAME, not by place).
  const src = (...parts) => fs.readFileSync(path.join(webDir, "src", ...parts), "utf8");
  for (const file of [["components", "chat", "ChatRightSidebar.tsx"]]) {
    assert.doesNotMatch(withoutComments(src(...file)), /\bMainRun\b|mainRun=|runStartedAt/, `${file.at(-1)}: a main-run prop still lives`);
  }
});

test("form (iOS): background tasks in \"Running\"/\"Ended\" in the agent sheet, every card a CbPane without accent, 6 pt spacing, no main run", () => {
  const sheet = withoutComments(fs.readFileSync(path.join(webDir, "..", "mobile", "CbaseMobile", "Chat", "ChatDetailSheet.swift"), "utf8"));
  const treeQ = withoutComments(fs.readFileSync(path.join(webDir, "..", "mobile", "CbaseMobile", "Chat", "DynWorkflowTree.swift"), "utf8"));
  const start = sheet.indexOf("struct SubagentsSheet");
  assert.ok(start >= 0, "the agent sheet stands in ChatDetailSheet.swift");
  const sb = sheet.slice(start);
  assert.doesNotMatch(sb, /CbOverline\(L\("Background tasks"\)/, "\"Background Tasks\" is the title of the sheet, no second heading");
  assert.match(sb, /sectionHeader\(L\("Running"\)/, "the section \"Running\"");
  assert.match(sb, /sectionHeader\(L\("Finished"\)/, "the section \"Ended\"");
  assert.doesNotMatch(sb, /L\("Main run"\)|chat-agents-main-run|mainMetrics|mainModel/, "the card of the main run is back");
  assert.doesNotMatch(sb, /L\("Subagents of this chat"\)/, "a heading per kind is back");
  assert.doesNotMatch(sb + treeQ, /L\("Dynamic workflows"\)/, "a heading per kind is back");
  // Both sections in ONE ForEach (`sheetRows`): a card that moves from "Running" to "Finished" keeps its state — in two ForEach
  // SwiftUI rebuilt it, and a stopped workflow folded shut under the eye (testDynWorkflowTreeInAgentsSheet).
  assert.match(sb, /VStack\(alignment: \.leading, spacing: 6\) \{\s*ForEach\(rows\) \{ row in\s*switch row \{\s*case \.headerRunning:\s*sectionHeader\(L\("Running"\)/,
    "\"Running\" with 6 pt spacing, in the ONE ForEach");
  assert.match(sb, /case \.headerEnded:\s*Button \{[^\n]*endedClosed\.toggle\(\)/, "\"Ended\" collapsible, in the same ForEach");
  assert.equal((sb.match(/ForEach\(rows\)/g) || []).length, 1, "exactly ONE ForEach over both sections");
  assert.doesNotMatch(sb, /ForEach\((active|finished)\)/, "a ForEach per section — the card would lose its state on the move");
  assert.match(sb, /case \.task\(let task\): return task\.id/, "the identifier of a card is the key of its task, in both sections");
  // The model computes the list (Chat/ChatViewModel+BackgroundTasks.swift), the sheet shows it.
  assert.match(sb, /model\.backgroundList\(list\)/, "the sheet takes the list of the model");
  const modelQ = withoutComments(fs.readFileSync(path.join(webDir, "..", "mobile", "CbaseMobile", "Chat", "ChatViewModel+BackgroundTasks.swift"), "utf8"));
  assert.match(modelQ, /BackgroundTasks\.list\(/, "the order from the bound computation");
  // The card of the subagent: a CbPane without accent, like that of the run; no dot before the row.
  const card = sb.match(/CbPane(?:\s*\([^)]*\))?\s*\{[\s\S]*?\.accessibilityIdentifier\("chat-agents-row"\)/);
  assert.ok(card, "the row of a subagent lies in a CbPane");
  assert.doesNotMatch(sb, /CbPane\s*\(\s*accent/, "iOS: the card is tinted");
  assert.doesNotMatch(sb, /Circle\(\)/, "iOS: a dot before the row — the card carries ONE state indicator");
  assert.match(sb, /\.navigationTitle\([^\n]*active == nil \? L\("Background tasks"\)/, "the title of the sheet is \"Background Tasks\"");
  assert.match(treeQ, /struct DynWorkflowCard\b/, "the card of the run is usable from outside");
});

test("short model name for the column, description at the head trimmed and empty without", () => {
  assert.equal(tree.modelShortName("claude", "claude-opus-5-5"), "opus-5-5");
  assert.equal(tree.modelShortName("codex", "gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(tree.modelShortName("openrouter", "anthropic/claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(tree.modelShortName("claude", "(Standard)"), "claude");
  assert.equal(tree.modelShortName("claude", "claude-"), "claude-", "something of the name remains");
  assert.equal(tree.modelShortName("", ""), "");
  assert.equal(tree.treeModel(run("wf_b", [], { description: "  Checks.  " })).header.description, "Checks.");
  assert.equal(tree.treeModel(run("wf_b", [])).header.description, "", "an older server without a description");
});

// The sheet "Message" to a workflow agent used to hang on its table row — which exists only while its phase is open, and the phase
// folds shut by itself as soon as nothing runs or waits in it. If the agent ended while the human typed (exactly the case of the
// rejection, 409), the sheet went with its text. The state belongs to the run's CARD, which survives the folding — web (`messageTo`)
// and iOS (`.sheet` on DynWorkflowCard). A DOM proof would be a test bench outside the gate; here the guard on the sources (without
// comments). Counter-test: against the old form of both files ⇒ both checks red.
const body = (q, header, end) => {
  const i = q.search(header);
  assert.ok(i >= 0, `not found: ${header}`);
  const j = q.slice(i + 1).search(end);
  return q.slice(i, j < 0 ? q.length : i + 1 + j);
};
test("web: the sheet \"Message\" of a workflow agent hangs on the card, not on the row or the phase", () => {
  const q = withoutComments(fs.readFileSync(path.join(webDir, "src", "components", "chat", "DynWorkflowTree.tsx"), "utf8"));
  const next = /\n(?:export )?function /;
  const card = body(q, /\nexport function DynWorkflowCard\(/, next);
  const phase = body(q, /\nfunction PhasesSection\(/, next);
  const row = body(q, /\nfunction AgentRow\(/, next);
  assert.doesNotMatch(row, /<AgentMessageSheet\b/, "the row renders the sheet itself — it goes with the folding phase");
  assert.doesNotMatch(phase, /<AgentMessageSheet\b/, "the phase renders the sheet — it folds shut by itself");
  // On the card: bound only to its own state, not to `open` (the opening of the card).
  assert.match(card, /\{\s*messageTo && chatId && <AgentMessageSheet\b[^>]*target=\{messageTo\}/, "the card does not hold the sheet");
  assert.doesNotMatch(card, /\{\s*open && [^}]*<AgentMessageSheet\b/, "the sheet hangs on the opening of the card");
});
test("iOS: the .sheet \"Message\" of a workflow agent hangs on DynWorkflowCard, not on row or phase", () => {
  const q = withoutComments(fs.readFileSync(path.join(webDir, "..", "mobile", "CbaseMobile", "Chat", "DynWorkflowTree.swift"), "utf8"));
  const next = /\n(?:private |fileprivate )?struct /;
  const card = body(q, /\nstruct DynWorkflowCard: View/, next);
  const phase = body(q, /\nprivate struct DynWorkflowPhase: View/, next);
  const row = body(q, /\nprivate struct DynWorkflowAgentRow: View/, next);
  assert.doesNotMatch(row, /\.sheet\(|AgentMessageSheet\(/, "the row presents the sheet — it goes with the folding phase");
  assert.doesNotMatch(phase, /\.sheet\(|AgentMessageSheet\(/, "the phase presents the sheet — it folds shut by itself");
  assert.match(card, /\.sheet\(item: \$message\) \{ target in AgentMessageSheet\(/, "the card does not present the sheet");
});
