// The node dialog of the workflow editor (src/lib/workflow-node-form.ts): WHEN the round cap is in the sheet, WHAT it shows, and
// that the command picker offers exactly the commands the server and the iOS sheet know. Without a browser — it is about the
// computations the dialog merely calls, and two bindings across file boundaries that no type error would ever report.
//
// Why visibility is a guard: "At most N rounds per run" used to stand on EVERY step, and on a step without a cycle the value never
// takes effect (the counter restarts per loop iteration). The rule "only in a cycle" is a decision — and a decision without a
// measurement is a claim.
//
// Also: the three three-valued modes of a node (`nodeModes`, legacy data), rule 1 (checks effectively), rule 2 (check cap), rule 3
// (round cap, `effectiveCaps(…, wf)`) and the composition `rowsFor(cycle, node, wf)`. The same rules against the SERVER are held by
// web/test/workflow-settings-binding.test.mjs.
//
// The bindings: `NODE_COMMANDS` (the picker's stock) must say the same as the regex `isHarnessCommand` in
// server/backend/electron/server/workflows.js (what cbase executes itself) and as the quick-pick chips in the iOS sheet
// (`WorkflowNodeSheet.nodeCommands`). Three places, one list — if one drifts, a client offers a command the server passes on to the
// CLI as a message ("Unknown command", the whole message swallowed). And `PLACEHOLDER` (the three chips at the text) against
// `WorkflowNodeSheet.placeholder` — two clients, one chip row; a fourth placeholder in the web would otherwise silently be missing
// on the phone.
//
// Run:  node --test web/test/workflow-node-form.test.mjs
import { test } from "node:test";
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

// The source is compiled to JS with the local tsc and imported — the real module text is checked, not a copy of it (model:
// slash.test.mjs).
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-node-form-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "workflow-node-form.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const {
  nodesOnCycle, effectiveCaps, exitTitle, showsCap, showsDoneMode, rowsFor, capField, capFromInput,
  PLACEHOLDER, insertPlaceholder, NODE_COMMANDS,
  nodeModes, checksEffective, checkCapContinue, DONE_MODES, CAP_MODES,
} = await import(pathToFileURL(path.join(out, "workflow-node-form.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

// Shorthand for graphs: nodes as objects, edges as "a>b" or "a>b:branch".
const node = (id, extra = {}) => ({ id, type: "instruction", title: id.toUpperCase(), ...extra });
const edge = (s) => {
  const [pair, branch] = s.split(":");
  const [from, to] = pair.split(">");
  return { from, to, branch: branch ?? null };
};
const graph = (nodes, edges) => ({ nodes, edges: edges.map(edge) });

// ── nodesOnCycle ─────────────────────────────────────────────────────────────────────────────

test("cycles: a chain has none, A→B→A has both, the loop body without a back edge has none", () => {
  const chain = graph([node("s", { type: "start" }), node("a"), node("b"), node("e", { type: "end" })], ["s>a", "a>b", "b>e"]);
  assert.deepEqual([...nodesOnCycle(chain)], []);

  const round = graph([node("a"), node("b")], ["a>b", "b>a"]);
  assert.deepEqual([...nodesOnCycle(round)].sort(), ["a", "b"]);

  // The body of a loop node (each element → X → Y) is NOT a cycle in the graph — the driver does the repetition, not an edge
  // back. X and Y therefore carry no cap.
  const body = graph(
    [node("l", { type: "loop" }), node("x"), node("y"), node("e", { type: "end" })],
    ["l>x:each", "x>y", "l>e:done"],
  );
  assert.deepEqual([...nodesOnCycle(body)], []);

  // Only the cycle itself, not the inflow: A leads in, B and C turn.
  const inflow = graph([node("a"), node("b"), node("c")], ["a>b", "b>c", "c>b"]);
  assert.deepEqual([...nodesOnCycle(inflow)].sort(), ["b", "c"]);
});

test("cycles: a node that leads into the cycle via a SECOND edge turns with it (A→B, B→A, A→C, C→B)", () => {
  // C→B→A→C is a cycle. An older depth-first search took only the nodes on the stack of a back edge and returned {A, B}: the
  // server (`cycleGroup`, SCC) and the iPhone (`cycleEdges` endpoints) counted C, the web sheet showed neither "Rounds per run"
  // nor the toggle on C — while `effectiveCaps` below computed with the group for C all along.
  // Counter-test: on the old body this line is red (returns ["a", "b"]).
  const secondEdge = graph([node("a"), node("b"), node("c")], ["a>b", "b>a", "a>c", "c>b"]);
  assert.deepEqual([...nodesOnCycle(secondEdge)].sort(), ["a", "b", "c"]);
  // And the group of `effectiveCaps` says the same: C inherits from the cycle it lies in.
  const withCap = graph([node("a", { maxVisits: 20, title: "Review" }), node("b"), node("c")], ["a>b", "b>a", "a>c", "c>b"]);
  assert.deepEqual(effectiveCaps(withCap, 5).get("c"), { cap: 20, auto: false, from: "Review" });
  assert.ok(nodesOnCycle(withCap).has("c"), "where effectiveCaps yields a cycle cap, the sheet must show the field");
});

// ── effectiveCaps ────────────────────────────────────────────────────────────────────────────

test("effective cap: an own value applies, the cycle node inherits the largest set one with its giver, else the default", () => {
  // Own value: unchanged, no giver.
  const own = graph([node("a", { maxVisits: 7 }), node("b")], ["a>b", "b>a"]);
  assert.deepEqual(effectiveCaps(own, 5).get("a"), { cap: 7, auto: false, from: "" });

  // Without an own value: the largest set in the cycle, and `from` names who carries it.
  const inherits = graph([node("a"), node("b", { maxVisits: 20, title: "Review" }), node("c", { maxVisits: 9 })], ["a>b", "b>c", "c>a"]);
  assert.deepEqual(effectiveCaps(inherits, 5).get("a"), { cap: 20, auto: false, from: "Review" });
  assert.deepEqual(effectiveCaps(inherits, 5).get("c"), { cap: 9, auto: false, from: "" }, "an own value does not inherit, even if a larger one stands in the cycle");

  // Nobody set: default, and the (old) checkmark counts cycle-wide — `capAuto: true` reads as "Continue".
  const standard = graph([node("a"), node("b", { capAuto: true })], ["a>b", "b>a"]);
  assert.deepEqual(effectiveCaps(standard, 5).get("a"), { cap: 5, auto: true, from: "" });

  // Outside any cycle: default, nothing inherited.
  const free = graph([node("a"), node("b", { maxVisits: 20 })], ["a>b"]);
  assert.deepEqual(effectiveCaps(free, 5).get("a"), { cap: 5, auto: false, from: "" });
});

test("round cap three-valued (rule 3): the node overrules, else the group (Continue before Ask), else the workflow", () => {
  const cycle = (a = {}, b = {}, c = {}) => graph([node("a", a), node("b", b), node("c", c)], ["a>b", "b>c", "c>a"]);
  const auto = (g, wf, id = "a") => effectiveCaps(g, 5, wf).get(id).auto;
  // All "like workflow": the workflow's default decides — and if missing, Ask.
  assert.equal(auto(cycle(), { loopCapAuto: true }), true, "workflow \"Continue\"");
  assert.equal(auto(cycle(), { loopCapAuto: false }), false, "workflow \"Ask\"");
  assert.equal(auto(cycle(), undefined), false, "without defaults: Ask");
  // The node's own mode overrules the workflow in both directions.
  assert.equal(auto(cycle({ loopCapMode: "ask" }), { loopCapAuto: true }), false, "node \"Ask\" breaks workflow \"Continue\"");
  assert.equal(auto(cycle({ loopCapMode: "continue" }), { loopCapAuto: false }), true, "node \"Continue\" breaks workflow \"Ask\"");
  // … and a neighbor: the node's OWN mode applies before the group (the node itself lies in it — without these two lines
  // "Continue before Ask" would hold the statement above by chance).
  assert.equal(auto(cycle({ loopCapMode: "ask" }, { loopCapMode: "continue" }), { loopCapAuto: true }), false, "node \"Ask\" beats neighbor \"Continue\"");
  assert.equal(auto(cycle({ loopCapMode: "continue", maxVisits: 3 }), { loopCapAuto: false }), true, "node \"Continue\" with its own cap (no group)");
  // A neighbor in the cycle: "Continue" counts cycle-wide, "Ask" breaks the workflow, "Continue" beats "Ask".
  assert.equal(auto(cycle({}, { loopCapMode: "continue" }), { loopCapAuto: false }), true, "a neighbor \"Continue\" pulls the cycle on");
  assert.equal(auto(cycle({}, { loopCapMode: "ask" }), { loopCapAuto: true }), false, "a neighbor \"Ask\" breaks workflow \"Continue\"");
  assert.equal(auto(cycle({}, { loopCapMode: "ask" }, { loopCapMode: "continue" }), { loopCapAuto: false }), true, "\"Continue\" beats \"Ask\" in the group");
  // With explicit caps only the givers count: a neighbor WITHOUT a cap says nothing.
  const giver = cycle({}, { maxVisits: 9, loopCapMode: "ask" }, { loopCapMode: "continue" });
  assert.deepEqual(effectiveCaps(giver, 5, { loopCapAuto: true }).get("a"), { cap: 9, auto: false, from: "B" }, "the giver says \"Ask\", the neighbor without a cap does not count");
  // An own cap or no cycle: no group — own mode, else the workflow.
  const own = cycle({ maxVisits: 3 }, { loopCapMode: "continue" });
  assert.equal(auto(own, { loopCapAuto: false }), false, "own cap: the neighbor does not count");
  assert.equal(auto(own, { loopCapAuto: true }), true, "own cap, \"like workflow\": the workflow");
  const chain = graph([node("a"), node("b", { loopCapMode: "continue" })], ["a>b"]);
  assert.equal(auto(chain, { loopCapAuto: false }), false, "outside any cycle: no neighbor");
});

test("the three modes: read legacy data (doneCheck/capAuto), valid values win, nonsense is \"like workflow\"", () => {
  assert.deepEqual([...DONE_MODES], ["inherit", "on", "off"]);
  assert.deepEqual([...CAP_MODES], ["inherit", "ask", "continue"]);
  const m = (extra) => nodeModes(node("a", extra));
  assert.deepEqual(m({}), { doneMode: "inherit", doneCapMode: "inherit", loopCapMode: "inherit" }, "never touched");
  assert.deepEqual(m({ doneCheck: true }), { doneMode: "on", doneCapMode: "inherit", loopCapMode: "inherit" }, "old checkmark \"check\" ⇒ on");
  assert.deepEqual(m({ doneCheck: false, capAuto: false }), { doneMode: "inherit", doneCapMode: "inherit", loopCapMode: "inherit" }, "old false is \"never touched\" — the server wrote it on EVERY node");
  assert.deepEqual(m({ capAuto: true }), { doneMode: "inherit", doneCapMode: "continue", loopCapMode: "continue" }, "old \"without asking\" applied to both caps");
  assert.deepEqual(m({ doneCheck: true, doneMode: "off", capAuto: true, doneCapMode: "ask" }), { doneMode: "off", doneCapMode: "ask", loopCapMode: "continue" }, "a valid new value wins over legacy data");
  assert.deepEqual(m({ doneMode: "yes", doneCapMode: 1, loopCapMode: null }), { doneMode: "inherit", doneCapMode: "inherit", loopCapMode: "inherit" }, "nonsense falls back to \"like workflow\"");
});

test("checks effectively (rule 1) and check cap (rule 2): node × workflow, only on instruction/parallel", () => {
  const WF = [{}, { doneAll: true }, { doneAll: false }];
  for (const type of ["instruction", "parallel"]) {
    for (const wf of WF) {
      const workflowChecks = wf.doneAll !== false;
      assert.equal(checksEffective(node("a", { type }), wf), workflowChecks, `${type} "like workflow" with ${JSON.stringify(wf)}`);
      assert.equal(checksEffective(node("a", { type, doneMode: "on" }), wf), true, `${type} "on" beats the workflow`);
      assert.equal(checksEffective(node("a", { type, doneMode: "off" }), wf), false, `${type} "off" beats the workflow`);
    }
  }
  assert.equal(checksEffective(node("a"), undefined), true, "without defaults the workflow checks (missing means on)");
  for (const type of ["condition", "ask", "loop", "review", "start", "trigger", "end"]) {
    assert.equal(checksEffective(node("a", { type, doneMode: "on" }), { doneAll: true }), false, `${type} never checks`);
    assert.equal(showsDoneMode(node("a", { type })), false, `${type}: no "Check completion" row`);
  }
  for (const [mode, wfContinue, desired] of [
    ["inherit", false, false], ["inherit", true, true], ["ask", true, false], ["continue", false, true], [undefined, true, true],
  ]) {
    assert.equal(checkCapContinue(node("a", mode ? { doneCapMode: mode } : {}), { doneCapAuto: wfContinue }), desired, `Check cap: node ${mode ?? "missing"}, Workflow ${wfContinue ? "Continue" : "Question##ask"}`);
  }
  assert.equal(checkCapContinue(node("a", { capAuto: true }), { doneCapAuto: false }), true, "old checkmark ⇒ \"Continue\" at the check cap too");
});

test("exit of the cycle: the first way out, else empty", () => {
  const g = graph([node("a"), node("b", { title: "Review" }), node("e", { type: "end", title: "End" })], ["a>b", "b>a:issues", "b>e:ok"]);
  assert.equal(exitTitle(g, "a"), "End");
  const without = graph([node("a"), node("b")], ["a>b", "b>a"]);
  assert.equal(exitTitle(without, "a"), "");
});

// ── Visibility ───────────────────────────────────────────────────────────────────────────────

test("the cap appears ONLY on a step in a cycle — never on start, end, trigger", () => {
  const cycle = new Set(["a", "s", "e", "t"]);
  assert.equal(showsCap(cycle, node("a")), true, "instruction in a cycle");
  assert.equal(showsCap(cycle, node("a", { type: "condition" })), true, "a condition turns too");
  assert.equal(showsCap(cycle, node("a", { type: "loop" })), true, "the loop node, if it ITSELF lies in a cycle");
  assert.equal(showsCap(new Set(), node("a")), false, "instruction outside: the value never takes effect");
  assert.equal(showsCap(new Set(), node("a", { type: "loop", maxVisits: 9 })), false, "a stored value does not make a field");
  for (const type of ["start", "end", "trigger"]) {
    assert.equal(showsCap(cycle, node(type[0], { type })), false, `${type} carries no cap`);
  }
});

// ── Composition per type ─────────────────────────────────────────────────────────────────────

test("the sheet per type: start = command, end = notification, trigger = part + command, the rest text + command + notification", () => {
  // As a table, three-valued: `cap`/`loopCap` hang on the cycle, `doneMode` on the kind, `scale`/`doneCap` on whether the node
  // checks EFFECTIVELY with the defaults `wf`. The title is always there and is no row.
  const no = { trigger: false, text: false, list: false, command: false, cap: false, loopCap: false, doneMode: false, doneCap: false, scale: false, notification: false };
  const aside = new Set();
  const onCycle = new Set(["n"]);
  const rows = (type, extra = {}, cycle = aside, wf = { doneAll: false }) => rowsFor(cycle, node("n", { type, ...extra }), wf);

  assert.deepEqual(rows("start"), { ...no, command: true }, "Start##noun");
  assert.deepEqual(rows("end"), { ...no, notification: true }, "End");
  assert.deepEqual(rows("trigger"), { ...no, trigger: true, command: true }, "Trigger");
  const work = { ...no, text: true, command: true, notification: true };
  assert.deepEqual(rows("instruction"), { ...work, doneMode: true }, "instruction, workflow does not check");
  assert.deepEqual(rows("parallel"), { ...work, doneMode: true }, "parallel, workflow does not check");
  assert.deepEqual(rows("condition"), work, "Condition");
  assert.deepEqual(rows("ask"), work, "Question");
  assert.deepEqual(rows("review"), work, "Review");
  assert.deepEqual(rows("loop"), { ...work, list: true }, "loop: plus the fixed list");

  // Scale and check cap appear where checking is EFFECTIVE: node "on", or "like workflow" with a workflow that checks all — also on
  // a CHAIN (no cycle needed).
  const checks = { ...work, doneMode: true, scale: true, doneCap: true };
  assert.deepEqual(rows("instruction", { doneMode: "on" }), checks, "node \"on\"");
  assert.deepEqual(rows("instruction", {}, aside, { doneAll: true }), checks, "\"like workflow\", workflow checks all");
  assert.deepEqual(rows("instruction", {}, aside, {}), checks, "\"like workflow\", default missing ⇒ on");
  assert.deepEqual(rows("instruction", { doneMode: "off" }, aside, { doneAll: true }), { ...work, doneMode: true }, "node \"off\" beats the workflow: neither scale nor check cap");
  assert.deepEqual(rows("instruction", { doneCheck: true }), checks, "legacy doneCheck: true ⇒ on");
  assert.deepEqual(rows("condition", { doneMode: "on" }, aside, { doneAll: true }), work, "a mode on a condition: no row");

  // In a cycle the cap and "At the round cap" are added — on every working node, never on start/end/trigger.
  for (const type of ["instruction", "parallel", "condition", "ask", "review", "loop"]) {
    const z = rows(type, {}, onCycle);
    assert.equal(z.cap, true, `${type} in a cycle: rounds per run`);
    assert.equal(z.loopCap, true, `${type} in a cycle: at the round cap`);
    assert.equal(z.doneCap, false, `${type} in a cycle, without checking: NO check cap`);
  }
  for (const type of ["start", "end", "trigger"]) {
    const z = rows(type, {}, onCycle, { doneAll: true });
    assert.equal(z.cap, false, `${type}: never a cap`);
    assert.equal(z.loopCap, false, `${type}: never "At the round cap"`);
    assert.equal(z.doneCap, false, `${type}: never "At the check cap"`);
  }
});

// ── Number field ─────────────────────────────────────────────────────────────────────────────

test("number field: empty is 0 and 0 is empty, nonsense becomes 0, too much is clamped", () => {
  assert.equal(capField(node("a")), "");
  assert.equal(capField(node("a", { maxVisits: 0 })), "", "the 0 is never shown");
  assert.equal(capField(node("a", { maxVisits: 12 })), "12");

  assert.equal(capFromInput("", 99), 0);
  assert.equal(capFromInput("   ", 99), 0);
  assert.equal(capFromInput("abc", 99), 0);
  assert.equal(capFromInput("0", 99), 0);
  assert.equal(capFromInput("-3", 99), 0);
  assert.equal(capFromInput("150", 99), 99, "above the server's limit: clamped");
  assert.equal(capFromInput("7", 99), 7);
  assert.equal(capFromInput(" 12 ", 99), 12);
  assert.equal(capFromInput("2.6", 99), 3, "rounded, not truncated");
  assert.equal(capFromInput("0.2", 99), 1, "greater than 0 means set — at least 1");
});

// ── Placeholders ─────────────────────────────────────────────────────────────────────────────

test("insert placeholder: at the caret, a selection is replaced, the caret stands behind it", () => {
  assert.deepEqual(PLACEHOLDER, ["{{input}}", "{{element}}", "{{answer}}"]);
  assert.deepEqual(insertPlaceholder("", 0, 0, "{{input}}"), { text: "{{input}}", caret: 9 });
  assert.deepEqual(insertPlaceholder("Prüfe  bitte", 6, 6, "{{element}}"), { text: "Prüfe {{element}} bitte", caret: 17 }, "in the middle of the text, without extra spaces");
  assert.deepEqual(insertPlaceholder("Prüfe DAS bitte", 6, 9, "{{element}}"), { text: "Prüfe {{element}} bitte", caret: 17 }, "the selection is replaced");
  assert.deepEqual(insertPlaceholder("Prüfe DAS bitte", 9, 6, "{{element}}"), { text: "Prüfe {{element}} bitte", caret: 17 }, "also selected backwards");
  assert.deepEqual(insertPlaceholder("ab", 5, 9, "{{answer}}"), { text: "ab{{answer}}", caret: 12 }, "a caret beyond the text appends");
});

// ── Bindings ─────────────────────────────────────────────────────────────────────────────────

const sourceOf = (...parts) => fs.readFileSync(path.join(repo, ...parts), "utf8");

// The iOS sheet of a step (`WorkflowNodeSheet`) may move between files; so the ONE file under Workflows/ that carries the
// declaration is searched — two would be two truths.
function iosSheet(declaration) {
  const folder = path.join(repo, "mobile", "CbaseMobile", "Workflows");
  const hits = fs.readdirSync(folder).filter((f) => f.endsWith(".swift"))
    .filter((f) => new RegExp(String.raw`^\s*static let ${declaration}\b`, "m").test(fs.readFileSync(path.join(folder, f), "utf8")));
  assert.equal(hits.length, 1, `\`static let ${declaration}\` is in ${hits.length} files under mobile/CbaseMobile/Workflows (${hits.join(", ") || "none"}) — exactly one expected`);
  return { file: hits[0], swift: fs.readFileSync(path.join(folder, hits[0]), "utf8") };
}

test("binding: NODE_COMMANDS == the alternatives of isHarnessCommand (workflows.js)", () => {
  const server = sourceOf("server", "backend", "electron", "server", "workflows.js");
  // `isHarnessCommand = (command) => /^\/(clear|compact)\s*$/i…` — the regex's group is read.
  const m = server.match(/isHarnessCommand\s*=\s*\(command\)\s*=>\s*\/\^\\\/\(([a-z|]+)\)/);
  assert.ok(m, "isHarnessCommand in workflows.js no longer in the known form — update the anchor, do not delete the test");
  const inServer = m[1].split("|");
  console.log(`  [node commands] server ${inServer.join("/")} · web ${NODE_COMMANDS.join("/")}`);
  assert.deepEqual([...NODE_COMMANDS], inServer, "the picker does not offer exactly the commands the server executes itself");
});

test("binding: NODE_COMMANDS == the chips of the iOS sheet (WorkflowNodeSheet.nodeCommands)", () => {
  const { file, swift } = iosSheet("nodeCommands");
  // `static let nodeCommands = ["/clear", "/compact"]` — a literal array of strings WITH a slash.
  const m = swift.match(/^\s*static let nodeCommands(?:\s*:\s*\[String\])?\s*=\s*\[([^\]]*)\]/m);
  assert.ok(m, `\`static let nodeCommands = [...]\` in ${file} not as a literal array — the iOS quick pick is no longer bound`);
  const inSheet = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  assert.ok(inSheet.length, "nodeCommands is empty — does the regex still apply?");
  for (const b of inSheet) assert.ok(b.startsWith("/"), `iOS chip "${b}" without a slash`);
  console.log(`  [node commands] iOS ${inSheet.join(" ")} · Web /${NODE_COMMANDS.join(" /")}`);
  assert.deepEqual(inSheet.map((b) => b.slice(1)), [...NODE_COMMANDS], "the iOS chips and the web stock do not name the same commands");
});

test("binding: PLACEHOLDER == the chips of the iOS sheet (WorkflowNodeSheet.placeholder)", () => {
  const { file, swift } = iosSheet("placeholder");
  // `static let placeholder = ["{{input}}", "{{element}}", "{{answer}}"]` — the same shape as `nodeCommands`; the chips'
  // `ForEach` line reads the constant, not a second literal. (The placeholder tokens are German on purpose: they are stored in
  // workflow texts.)
  const m = swift.match(/^\s*static let placeholder(?:\s*:\s*\[String\])?\s*=\s*\[([^\]]*)\]/m);
  assert.ok(m, `\`static let placeholder = [...]\` in ${file} not as a literal array — the iOS chips are no longer bound`);
  const inSheet = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  assert.ok(inSheet.length, "placeholder is empty — does the regex still apply?");
  assert.ok(/ForEach\(Self\.placeholder,/.test(swift), `the chip row of the iOS sheet (${file}) does not read \`Self.placeholder\` — a second literal next to it would be unbound`);
  console.log(`  [placeholders] iOS ${inSheet.join(" ")} · Web ${PLACEHOLDER.join(" ")}`);
  assert.deepEqual(inSheet, [...PLACEHOLDER], "the iOS chips and the web chips do not name the same placeholders in the same order");
});
