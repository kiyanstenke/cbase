// The order of the "Background Tasks" list (src/lib/background-tasks.ts) — the agents tab of the right chat bar.
// Rules of the computation and their wiring in the source; that iOS computes the same is held by
// background-tasks-binding.test.mjs.
//
// The rules, each from a question that makes a wrong answer silent:
//   - Newest on top, subagents and runs MIXED — not all subagents first, then all workflows.
//   - A finished subagent knows no start time (its report names none): it stands at its place in the history, not at the
//     end. Otherwise after a reload all finished ones would sit below all workflows.
//   - A subagent that finishes DOES NOT JUMP (before with a start time, after without — same place).
//   - Ties and missing time are stable: on equal time the later arrival is on top, and computed twice gives the same
//     sequence.
//   - Not a number is not a time: 0, negative, NaN, Infinity, null count as "unknown", not as "very old".
//
// Counter-test (which sabotage turns which test red): in background-tasks.ts `eff[i] = s ?? last` → `eff[i] = s ??
// Number.NEGATIVE_INFINITY` turns "at its place in the history" and "does not jump" red; `return rang[b] - rang[a]` →
// `return rang[a] - rang[b]` turns "tie" red.
//
// Run:  node --test web/test/background-tasks.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const src = path.join(webDir, "src");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-background-tasks-"));
execFileSync(process.execPath, [
  tsc, path.join(src, "lib", "background-tasks.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const B = await import(pathToFileURL(path.join(out, "background-tasks.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }

const read = (rel) => fs.readFileSync(path.join(src, rel), "utf8");
const ag = (id, start) => ({ key: B.agentKey(id), start });
const wf = (id, start) => ({ key: B.workflowKey(id), start });
const short = (list) => list.map((s) => s.replace(/^agent:/, "A:").replace(/^workflow:/, "W:"));

test("keys: agent:<block id> and workflow:<run id> — two namespaces, no collision", () => {
  assert.equal(B.agentKey("toolu_1"), "agent:toolu_1");
  assert.equal(B.workflowKey("wf_1"), "workflow:wf_1");
  assert.notEqual(B.agentKey("x"), B.workflowKey("x"));
});

test("arrival sequence from the history: per row the subagents, then the start marker; each once, empty ids not", () => {
  const followUp = B.taskSequence([
    { agents: ["a1", "", "a2"] },
    { agents: [], workflowStart: "w1" },
    { agents: ["a3"], workflowStart: null },
    { agents: ["a1"], workflowStart: "w1" }, // the same again (reload + stream) — the first place counts
    { agents: [], workflowStart: "" },
    { agents: ["a4"], workflowStart: "w2" },
  ]);
  assert.deepEqual(short(followUp), ["A:a1", "A:a2", "W:w1", "A:a3", "A:a4", "W:w2"]);
});

test("Newest on top, subagents and workflows MIXED by start time", () => {
  const list = B.backgroundTasks(
    [ag("a-old", 1000), ag("a-new", 4000)],
    [wf("w-new", 3000), wf("w-old", 2000)], // the tree delivers newest first
    [],
  );
  assert.deepEqual(short(list), ["A:a-new", "W:w-new", "W:w-old", "A:a-old"]);
});

test("A finished subagent without start time stands at its place in the history — not at the end", () => {
  // History: f-old, then workflow w1 (start 100), then f-middle, then workflow w2 (start 200), then k (finished), then l (running, 300).
  const followUp = B.taskSequence([
    { agents: ["f-old"] }, { agents: [], workflowStart: "w1" }, { agents: ["f-middle"] },
    { agents: [], workflowStart: "w2" }, { agents: ["k"] }, { agents: ["l"] },
  ]);
  // The agent list: running first, then the finished in history order (lib/agents.ts `agentsList`).
  const list = B.backgroundTasks(
    [ag("l", 300), ag("f-old"), ag("f-middle"), ag("k")],
    [wf("w2", 200), wf("w1", 100)],
    followUp,
  );
  assert.deepEqual(short(list), ["A:l", "A:k", "W:w2", "A:f-middle", "W:w1", "A:f-old"]);
});

test("A subagent that finishes does not jump: with and without start time the same place", () => {
  const followUp = B.taskSequence([{ agents: [], workflowStart: "w1" }, { agents: ["a"] }, { agents: [], workflowStart: "w2" }]);
  const runs = [wf("w2", 500), wf("w1", 100)];
  const running = B.backgroundTasks([ag("a", 300)], runs, followUp);
  const finished = B.backgroundTasks([ag("a")], runs, followUp);
  assert.deepEqual(short(running), ["W:w2", "A:a", "W:w1"]);
  assert.deepEqual(finished, running, "the agent loses its start time on finishing — the place stays");
  // Also at the very top: the newest entry stays on top when it finishes.
  const top = B.taskSequence([{ agents: [], workflowStart: "w1" }, { agents: ["b"] }]);
  assert.deepEqual(short(B.backgroundTasks([ag("b", 900)], [wf("w1", 100)], top)), ["A:b", "W:w1"]);
  assert.deepEqual(short(B.backgroundTasks([ag("b")], [wf("w1", 100)], top)), ["A:b", "W:w1"]);
});

test("Ties and missing time are stable: the later arrival is on top, computed twice gives the same", () => {
  const followUp = B.taskSequence([{ agents: [], workflowStart: "w1" }, { agents: [], workflowStart: "w2" }, { agents: ["a1", "a2"] }]);
  const one = B.backgroundTasks([ag("a1"), ag("a2")], [wf("w2", 700), wf("w1", 700)], followUp);
  assert.deepEqual(short(one), ["A:a2", "A:a1", "W:w2", "W:w1"]);
  assert.deepEqual(B.backgroundTasks([ag("a1"), ag("a2")], [wf("w2", 700), wf("w1", 700)], followUp), one);
  // Without history and without time: the reversed list order (the agent list is in history order — the last is
  // the newest).
  assert.deepEqual(short(B.backgroundTasks([ag("x1"), ag("x2"), ag("x3")], [], [])), ["A:x3", "A:x2", "A:x1"]);
});

test("Not a number is not a time: 0, negative, NaN, Infinity and null count as unknown — not as \"very old\"", () => {
  const followUp = B.taskSequence([{ agents: [], workflowStart: "w1" }, { agents: ["a0", "an", "ai", "anull", "aneg"] }]);
  const list = B.backgroundTasks(
    [ag("a0", 0), ag("an", Number.NaN), ag("ai", Number.POSITIVE_INFINITY), ag("anull", null), ag("aneg", -5)],
    [wf("w1", 100)],
    followUp,
  );
  // All five stand AFTER w1 in the history — so above it, in reverse arrival.
  assert.deepEqual(short(list), ["A:aneg", "A:anull", "A:ai", "A:an", "A:a0", "W:w1"]);
});

test("What the history does not know: with time by the time, without time below all known times", () => {
  // The running agent "fresh" has not arrived in the history yet (its block is missing) — its time counts anyway.
  const followUp = B.taskSequence([{ agents: [], workflowStart: "w1" }]);
  assert.deepEqual(short(B.backgroundTasks([ag("fresh", 900)], [wf("w1", 100)], followUp)), ["A:fresh", "W:w1"]);
  // Without history (empty sequence) a subagent without time lands BELOW the runs — it is not as new as the newest.
  assert.deepEqual(short(B.backgroundTasks([ag("f")], [wf("w2", 200), wf("w1", 100)], [])), ["W:w2", "W:w1", "A:f"]);
});

test("Each key once, even if it comes twice", () => {
  const list = B.backgroundTasks([ag("a", 300), ag("a", 100)], [wf("w", 200), wf("w", 50)], []);
  assert.deepEqual(short(list), ["A:a", "W:w"]);
  // The core orders INDICES — each index exactly once.
  const idx = B.arrangeTasks([ag("p", 1), ag("q", 3), wf("r", 2)], []);
  assert.deepEqual(idx, [1, 2, 0]);
});

// Counter-test: deleting the line `for (const g of graph.slice().reverse()) alongside(g);` in background-tasks.ts turns it red.
test("Graph workflows in the background: own namespace, by start time between subagents and runs, on a tie above the dyn run", () => {
  assert.equal(B.graphKey("gs_1"), "graph:gs_1");
  assert.notEqual(B.graphKey("x"), B.workflowKey("x"));
  const gr = (id, start) => ({ key: B.graphKey(id), start });
  const list = B.backgroundTasks([ag("a", 400)], [wf("w", 200)], [], [gr("fresh", 300), gr("equal", 200), gr("old", 100)]);
  assert.deepEqual(list, ["agent:a", "graph:fresh", "graph:equal", "workflow:w", "graph:old"]);
  // Without the fourth value as before.
  assert.deepEqual(B.backgroundTasks([ag("a", 400)], [wf("w", 200)], []), ["agent:a", "workflow:w"]);
});

test("Wiring: the hook delivers the sequence, the coding chat's bar passes it on and orders with it", () => {
  const hook = read("components/chat/chatBackground.ts");
  assert.match(hook, /taskSequence as followUpFromHistory\b[^;]*from "@\/lib\/background-tasks"/);
  assert.match(hook, /b\.kind === "workflow-start" \? b\.marker\?\.runId/, "the start marker of a workflow counts as arrival");
  assert.match(hook, /return \{[^}]*\btaskSequence \};/);
  // The list "Background Tasks" is ordered by a hook (chat/chatBackgroundTasks.ts via lib/bg-list.ts) that the right bar
  // calls ONCE; the AgentBar gets the finished state (`bg`).
  const hook2 = read("components/chat/chatBackgroundTasks.ts");
  assert.match(hook2, /bgList\(\{ agents: ag, runs: wf, graph: gr, followUp: taskSequence \}\)/);
  assert.match(hook2, /e\(graphKey\(g\.startId\), g\.startedAt,/, "the start time of a graph run goes along");
  assert.match(hook2, /e\(agentKey\(a\.id \|\| `#\$\{i\}`\), a\.startedAt,/, "the start time of a subagent goes along");
  assert.match(hook2, /e\(workflowKey\(l\.runId\), l\.startedAt,/, "the start time of a run goes along");
  assert.match(read("lib/bg-list.ts"), /backgroundTasks\(q\.agents\.map\(source\), q\.runs\.map\(source\), q\.followUp, q\.graph\.map\(source\)\)/);
  assert.doesNotMatch(read("components/AgentBar.tsx"), /backgroundTasks\(/, "the bar orders by itself again — two computations for one list");
  const pane = read("components/chat/ChatPane.tsx");
  assert.match(pane, /backgroundEvent, taskSequence \} = useBackground\(bubbles, busy\);/);
  assert.match(pane, /<ChatRightSidebar[\s\S]*?taskSequence=\{taskSequence\}/);
  const page = read("components/chat/ChatRightSidebar.tsx");
  assert.match(page, /useBackgroundTasks\(\{[\s\S]*?taskSequence,/);
  assert.match(page, /<AgentBar[\s\S]*?bg=\{bg\}/);
  // The sequence has ONE path: hook → ChatPane → ChatRightSidebar → AgentBar.
});
