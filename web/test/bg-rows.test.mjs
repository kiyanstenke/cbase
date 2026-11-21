// The rows of the "Background Tasks" list (src/lib/bg-rows.ts) and their wiring in components/AgentBar.tsx. The bug this
// guard catches: "Running" and "Ended" stood as two separate parent nodes, each with its own `.map(card)`. If a dynamic
// workflow ended under the eye, its card moved into the second node, React built it there NEW (state holds only with the same
// parent AND the same `key`), `DynWorkflowCard` started again at `useState(head.running)` = closed — the stopped run folded
// shut. iOS had the same bug (form test in dyn-tree.test.mjs); there is no DOM in the suite (no jsdom), hence two halves: the
// RULES of the row list as pure computation and the form of the bar (ONE parent node, ONE `.map` over both sections, the
// card with its task's key).
//
// Counter-test (which sabotage turns which test red): AgentBar.tsx in the old form (two nodes, `active.map(card)` /
// `finished.map(card)`) turns the form check red (so does dyn-tree.test.mjs); in bg-rows.ts the task key under "Ended" with a
// prefix (`ended:${key(task)}`) turns "sequence" and "same key in both sections" red.
//
// Run:  node --test web/test/bg-rows.test.mjs
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

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-bg-rows-"));
execFileSync(process.execPath, [
  tsc, path.join(src, "lib", "bg-rows.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const Z = await import(pathToFileURL(path.join(out, "bg-rows.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }

const task = (key) => ({ key });
const rows = (e) => Z.bgRows({ active: [], finished: [], commands: [], monitors: [], endedClosed: false, key: (t) => t.key, ...e });
const keys = (z) => z.map((r) => r.key);
const unique = (z) => assert.equal(new Set(keys(z)).size, z.length, `duplicate keys: ${keys(z)}`);

test("sequence: \"Running\", running tasks, commands and monitors (newest first), then \"Ended\" with the ended ones", () => {
  const z = rows({
    active: [task("agent:a1"), task("workflow:w1")],
    finished: [task("workflow:w0"), task("graph:g0")],
    commands: [{ taskId: "b1" }, { taskId: "b2" }],
    monitors: [{ taskId: "m1" }],
  });
  assert.deepEqual(keys(z), ["header:running", "agent:a1", "workflow:w1", "command:b2", "command:b1", "monitor:m1", "header:ended", "workflow:w0", "graph:g0"]);
  assert.deepEqual(z.filter((r) => r.kind === "header").map((r) => [r.section, r.first]), [["running", true], ["ended", false]]);
  assert.deepEqual(z.filter((r) => r.kind === "task").map((r) => r.section), ["running", "running", "ended", "ended"]);
  unique(z);
});

test("same key in both sections: a workflow that ends keeps its row (the core of the bug)", () => {
  const prior = rows({ active: [task("workflow:w1"), task("agent:a1")], finished: [task("agent:a0")] });
  const after = rows({ active: [task("agent:a1")], finished: [task("workflow:w1"), task("agent:a0")] });
  const rowOf = (z, k) => z.find((r) => r.kind === "task" && r.task.key === k);
  assert.equal(rowOf(prior, "workflow:w1").section, "running");
  assert.equal(rowOf(after, "workflow:w1").section, "ended");
  assert.equal(rowOf(prior, "workflow:w1").key, "workflow:w1", "a card's key is that of its task — no prefix per section");
  assert.equal(rowOf(after, "workflow:w1").key, rowOf(prior, "workflow:w1").key, "the card changes its key when it changes section");
  // The last running thing ends too: the head "Running" falls, "Ended" becomes the first — the keys stay.
  const last = rows({ finished: [task("workflow:w1"), task("agent:a1"), task("agent:a0")] });
  assert.deepEqual(keys(last), ["header:ended", "workflow:w1", "agent:a1", "agent:a0"]);
  for (const z of [prior, after, last]) unique(z);
});

test("\"Ended\" folded: the head stands, the cards do not; \"Running\" stays whole", () => {
  const z = rows({ active: [task("agent:a1")], finished: [task("agent:a0")], endedClosed: true });
  assert.deepEqual(keys(z), ["header:running", "agent:a1", "header:ended"]);
});

test("Without anything running no head \"Running\" — \"Ended\" is then the first (Σ and identifier of the heading)", () => {
  const z = rows({ finished: [task("agent:a0")] });
  assert.deepEqual(z.filter((r) => r.kind === "header").map((r) => [r.key, r.first]), [["header:ended", true]]);
});

test("A running command or monitor alone opens \"Running\"; without ended ones no head \"Ended\"", () => {
  assert.deepEqual(keys(rows({ commands: [{ taskId: "b1" }] })), ["header:running", "command:b1"]);
  assert.deepEqual(keys(rows({ monitors: [{ taskId: "m1" }] })), ["header:running", "monitor:m1"]);
  assert.deepEqual(rows({}), [], "nothing runs, nothing ended — no row");
});

test("Command/monitor without taskId: key by the place in the reversed sequence, command and monitor separate", () => {
  const z = rows({ commands: [{}, { taskId: "" }], monitors: [{ taskId: null }] });
  assert.deepEqual(keys(z), ["header:running", "command:0", "command:1", "monitor:0"]);
  unique(z);
});

test("Form: AgentBar renders both sections under ONE parent node in ONE `.map` over `bgRows`", () => {
  const raw = fs.readFileSync(path.join(src, "components", "AgentBar.tsx"), "utf8");
  // Comments out — the origin describes the old form verbatim.
  const bar = raw.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(bar, /import \{ bgRows \} from "@\/lib\/bg-rows";/);
  assert.match(bar, /const rows = bgRows\(\{ active, finished, commands, monitors, wakeup: bg\.wakeup, endedClosed, key: \(e: Entry\) => e\.key \}\);/,
    "the rows come from the computation, with the entry's key");
  assert.equal((bar.match(/data-bg-tasks(?![-\w])/g) || []).length, 1, "exactly ONE node carries data-bg-tasks — the list");
  assert.match(bar, /<div className="space-y-1\.5" data-bg-tasks>\s*\{rows\.map\(\(z\) =>/, "the ONE parent node with 6 px, in it the ONE map");
  assert.equal((bar.match(/\brows\.map\(/g) || []).length, 1, "exactly ONE map over the rows");
  assert.doesNotMatch(bar, /\b(?:active|finished)\.map\(|\[\.\.\.(?:commands|monitors)\]\.reverse\(\)\.map\(/,
    "one map per section — a card would lose its state on the move");
  assert.match(bar, /z\.kind === "task" \? card\(z\.task\)/, "a task's card comes from `card`");
  // Every card carries the entry's key as its key — the same one bgRows gives the row.
  const card = bar.slice(bar.indexOf("const card = (e: Entry) =>"), bar.indexOf("return (", bar.indexOf("const card = (e: Entry) =>")));
  assert.equal((card.match(/key=\{e\.key\}/g) || []).length, 3, "subagent, workflow and graph with key = e.key");
  // The section markers at the head, the folding, the gap between the sections.
  assert.match(bar, /<SectionHeader key=\{z\.key\} section="running" word=\{t\("Running"\)\}/);
  assert.match(bar, /<SectionHeader section="ended" word=\{t\("Finished"\)\}/);
  assert.match(bar, /data-bg-section=\{section\}/, "SectionHeader carries the section marker");
  assert.match(bar, /aria-expanded=\{!endedClosed\} data-bg-ended/, "\"Ended\" foldable");
  assert.match(bar, /\$\{z\.first \? "" : "mt-3"\}/, "12 px between the sections, only if \"Running\" stands above");
});
