// The completion notice of a subagent, bound: web and iOS READ it the same way.
//
// The server writes the notice (server/backend/electron/server/runs/completionNotice.js); it is read twice —
// `readCompletionNotice`/`queueEntry` in web/src/lib/completionNotice.ts and `CompletionNotice.read`/`.queue`
// in mobile/CbaseMobile/Chat/CompletionNotice.swift. The name used to be read from the summary with a greedy regex on web and
// backwards per outcome on Swift: if the error text carried `"…" failed`, both showed a mangled name, and not even the same one.
// Now the name stands in `<name>`; old data without the element is read by BOTH by the same rule (`nameFromSummary`).
//
// Model: history-binding.test.mjs. The Swift file is taken WHOLE (it imports only Foundation), combined with a stand-in for
// `L` (English is the key, `{name}` is replaced — like `fmt` on web) and a driver into one program, and REALLY executed with
// `xcrun swift`. The cases go in as a JSON file and the results come out as JSON (line breaks and quotes in the texts). Without
// the toolchain the test fails LOUDLY (hence `onlyMacOS` in `latch.json`).
//
// Further forms under the same marker: (1) the WAKE-UP CALL OF A COPY (stacks/inset.js moveInWakeText, stacks/remove.js
// copyWakeText) carries neither `<name>` nor `<status>` — it used to show only "System message" for all five outcomes. The cases
// are written here by the REAL server: both functions run in a process of their own (they pull in the server tree with its data
// layer, the test process stays free of it); plus a source check that there are exactly these five summary forms — a sixth turns
// the file red instead of silently showing "System message" again. (2) The completion notice of a GRAPH workflow
// (workflows/graph-background.js) is called "Workflow" — only in the word; merging with the end marker
// (`completionNoticeDuplicate`) stays with the dynamic workflow and is compared web <-> iOS for every case here.
// (3) The notice of a MONITOR (runs/monitor-notice.js), written by the real server; without the switch it would read "Subagent
// "<name>" finished" — also the event of a running monitor.
//
// COUNTER-TESTS (each sabotage turns the named tests red):
//   - in lib/completionNotice.ts the old greedy reading `/^Agent "([^]*)" (?:completed|was stopped|failed)/` instead of
//     `nameFromSummary` => "old data: error text with "x" failed" reads `Reviewer" failed: Tool "Bash` and differs from iOS
//     (two tests red);
//   - in runs/completionNotice.js drop the `<name>` line => the file fails already when building the cases ("the server writes <name>");
//   - in the web strip drop the `continue` of the system-notice branch => the source contract (last test) is red;
//   - in lib/completionNotice.ts drop the copy line in `finishedRow` => web shows "System message", differs from iOS and from
//     the expectation; in CompletionNotice.swift switch off the copy block in `row` => "iOS shows "System message"";
//     drop `|| isGraphWorkflowNotice(text)` => "Subagent "Job → Ship" finished"; extend `completionNoticeDuplicate` to the graph
//     workflow => "merges with the end marker";
//   - in lib/completionNotice.ts drop the `if (isMonitorNotice(text))` block => "Monitor: …" shows "Subagent …"; in
//     CompletionNotice.swift set `isMonitor` to `false` => iOS differs.
//
// Run:  node --test web/test/completion-notice-binding.test.mjs   (needs server/backend/node_modules — the server tree
//       loads `ws`; like xcrun, a missing one fails LOUDLY)
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { completionNotice } from "../../server/backend/electron/server/runs/completionNotice.js";
import { monitorNotice, monitorEndText } from "../../server/backend/electron/server/runs/monitor-notice.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const SOURCE_TS = path.join(webDir, "src", "lib", "completionNotice.ts");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Chat", "CompletionNotice.swift");
// `CompletionNotice.queue` asks the third kind first (`InboundAgentMessage.queue`) — so that file runs along (it also imports
// only Foundation; it is bound itself in agents-message-binding.test.mjs).
const SOURCE_MESSAGE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Chat", "InboundAgentMessage.swift");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
const tmpDir = () => (tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "cbase-finished-binding-")));

// ── The cases ───────────────────────────────────────────────────────────────────────────────
// Written by the SERVER (as they arise today), plus each same text WITHOUT `<name>` (old data) and a few hand-built
// edge cases. `name` is the expectation; `null` means: only equality web <-> iOS.
const withoutName = (t) => t.replace(/^<name>[^\n]*<\/name>\n/m, "");
const REPORTS = [
  { title: "finished", r: { status: "completed", agentId: "a1", description: "Check on the side", report: "Finding" }, name: "Check on the side" },
  { title: "stopped", r: { status: "stopped", agentId: "a2", description: "Search", report: "" }, name: "Search" },
  { title: "failed", r: { status: "failed", agentId: "a3", description: "Reviewer", error: "Exit 1\nmore" }, name: "Reviewer" },
  { title: "error text with \"x\" failed", r: { status: "failed", agentId: "a4", description: "Reviewer", error: 'Tool "Bash" failed: exit 2' }, name: "Reviewer" },
  { title: "quotes in the name AND in the error", r: { status: "failed", agentId: "a5", description: 'Say "hello"', error: 'Call "x" failed: broken' }, name: 'Say "hello"' },
  { title: "name with \" completed", r: { status: "completed", agentId: "a6", description: 'Part " completed', report: "" }, name: 'Part " completed' },
  { title: "foreign text in the name", r: { status: "completed", agentId: "a7", description: "Part <A> & B", report: "" }, name: "Part <A> & B" },
  { title: "without description: type", r: { status: "completed", agentId: "a8", agentType: "code-reviewer", report: "" }, name: "code-reviewer" },
  { title: "without anything: id", r: { status: "failed", agentId: "a9", error: "" }, name: "a9" },
];
const CASES = [];
for (const b of REPORTS) {
  const text = completionNotice(b.r, { toolUseId: "toolu_1" });
  CASES.push({ title: `Server: ${b.title}`, text, name: b.name });
  const old = withoutName(text);
  assert.notEqual(old, text, `${b.title}: the server writes <name>`);
  // Old data: the same rule in both. A name that itself carries `" failed: ` is unsolvable there — not included here.
  CASES.push({ title: `Old data: ${b.title}`, text: old, name: b.name });
}
const header = "<task-notification>\n<task-id>h1</task-id>\n";
CASES.push(
  { title: "Hand: without status, finished form", text: `${header}<summary>Agent "X" completed</summary>\n</task-notification>`, name: "X" },
  { title: "Hand: without status, error form", text: `${header}<summary>Agent "X" failed: "y" failed: z</summary>\n</task-notification>`, name: "X" },
  { title: "Hand: status does not match the form", text: `${header}<status>completed</status>\n<summary>Agent "X" failed: z</summary>\n</task-notification>`, name: "" },
  { title: "Hand: summary without head", text: `${header}<status>completed</status>\n<summary>finished</summary>\n</task-notification>`, name: "" },
  { title: "Hand: empty <name> wins", text: `${header}<status>completed</status>\n<name></name>\n<summary>Agent "X" completed</summary>\n</task-notification>`, name: "" },
  { title: "Hand: unknown status", text: `${header}<status>whatever</status>\n<name>N</name>\n</task-notification>`, name: "N" },
  { title: "no completion notice", text: "Hello <name>X</name>", name: null },
);

// ── The wake-up call of a copy, written by the REAL server ────────────────────────────────────────────────────────
const STACKS = path.join(repo, "server", "backend", "electron", "server", "stacks");
// The five calls per copy: [function, arguments after `k`, expected outcome, expected row (English = key)].
const COPY_CALLS = [
  ["inset", ["ready"], "ready", "Copy “{name}” ready"],
  ["inset", ["error"], "not-built", "Copy “{name}” not built"],
  ["remove", ["removed", "copy/{name}/main → 3 commits"], "clearedAway", "Copy “{name}” removed"],
  ["remove", ["removed", "", { neverBuilt: true }], "never-built-removed", "Copy “{name}” removed (never built)"],
  ["remove", ["error", "docker rm: exit 1"], "not-cleared-away", "Copy “{name}” not removed"],
];
// Copy names per projectbox/creation.js COPY_NAME (`[a-z0-9-]`, 1–24 characters); reasons that could disturb the reading.
const COPIES = [
  { name: "e2e1", error: "no space\nsecond line", result: { branchSpace: "copy/e2e1/", dnsName: "e2e1.cbase", hints: ["h1"] } },
  { name: "k", error: "", result: null },
  { name: "abcdefghij-klmnopqrst-uv", error: 'Copy "x" ready', result: null },
  { name: "0-9", error: "Foreign text <A> & B \"z\" removed (never built)", result: null },
];
function copyFormsFromServer() {
  const url = (d) => JSON.stringify(pathToFileURL(path.join(STACKS, d)).href);
  const input = COPIES.flatMap((k) => COPY_CALLS.map(([fn, args]) => [fn, { projectId: "0123456789abcdef0123456789abcdef", ...k }, args]));
  const script = `
const { moveInWakeText } = await import(${url("inset.js")});
const { copyWakeText } = await import(${url("remove.js")});
const out = ${JSON.stringify(input)}.map(([fn, k, args]) => (fn === "inset" ? moveInWakeText : copyWakeText)(k, ...args));
process.stdout.write(JSON.stringify(out) + "\\n");
process.exit(0);
`;
  const env = { ...process.env, HOME: tmpDir() };
  delete env.NODE_TEST_CONTEXT;
  let output;
  try {
    output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`the server could not be loaded (stacks/inset.js, stacks/remove.js — is server/backend/node_modules missing?): ${String(e.stderr || e.message).slice(0, 600)}`);
  }
  const texts = JSON.parse(output.trim().split("\n").pop());
  return COPIES.flatMap((k, i) => COPY_CALLS.map(([fn, args, outcome, row], j) => ({
    title: `Copy "${k.name}": ${fn}(${args[0]}${args[2]?.neverBuilt ? ", neverBuilt" : ""})`,
    text: texts[i * COPY_CALLS.length + j], name: "", copy: { name: k.name, outcome }, row: row.replace("{name}", k.name), fromServer: true,
  })));
}
const COPY_CASES = copyFormsFromServer();
// A form unknown to the switch is NOT a copy wake-up call — the row claims no outcome.
const copyHeader = "<task-notification>\n<task-id>copy-k1</task-id>\n";
COPY_CASES.push(
  { title: "Copy, hand: unknown outcome", text: `${copyHeader}<summary>Copy "k1" frozen</summary>\n</task-notification>`, name: "", copy: null, row: "System message" },
  { title: "Copy, hand: without name", text: `${copyHeader}<summary>Copy "" ready</summary>\n</task-notification>`, name: "", copy: null, row: "System message" },
  { title: "Copy, hand: without closing character", text: `${copyHeader}<summary>Copy "k1 ready</summary>\n</task-notification>`, name: "", copy: null, row: "System message" },
  { title: "Copy, hand: \"ready\" with suffix", text: `${copyHeader}<summary>Copy "k1" ready and more</summary>\n</task-notification>`, name: "", copy: null, row: "System message" },
  // Should the wake-up call one day carry `<name>` and `<status>`, it stays a copy row (the kind is the summary).
  { title: "Copy, hand: with <name> and <status>", text: `${copyHeader}<status>completed</status>\n<name>k1</name>\n<summary>Copy "k1" removed</summary>\n</task-notification>`, name: "k1", copy: { name: "k1", outcome: "clearedAway" }, row: "Copy “k1” removed" },
);

// ── The completion notice of a graph workflow ───────────────────────────────────────────────────────────────────
// The notice builder in graph-background.js is not exported; the cases follow its form, and the form is held here against the source.
const xmlEsc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const graph = (id, status, name, summary) => [
  "<task-notification>", `<task-id>${id}</task-id>`, `<status>${status}</status>`, `<name>${xmlEsc(name)}</name>`,
  `<summary>${xmlEsc(summary)}</summary>`, "<result>ok</result>", "</task-notification>",
].join("\n");
const GRAPH_CASES = [
  { title: "Graph workflow: finished", text: graph("g1", "completed", "Job → Ship", 'Graph-Workflow "Job → Ship" completed'), name: "Job → Ship", row: "Workflow “Job → Ship” finished" },
  { title: "Graph workflow: stopped", text: graph("g2", "stopped", "Part <A> & B", 'Graph-Workflow "Part <A> & B" was stopped'), name: "Part <A> & B", row: "Workflow “Part <A> & B” stopped" },
  { title: "Graph workflow: failed", text: graph("g3", "failed", "Check", 'Graph-Workflow "Check" failed: Step "x" failed: exit 2'), name: "Check", row: "Workflow “Check” failed" },
  // For comparison: the dynamic workflow (dynworkflows/run.js) — it, and only it, merges with its end marker.
  { title: "dynamic workflow: finished", text: graph("w1", "completed", "findings-collect", 'Workflow "findings-collect" completed'), name: "findings-collect", row: "Workflow “findings-collect” finished", duplicate: true },
];
// ── The notice of a monitor, written by the REAL server (runs/monitor-notice.js) ───────────────────────────────
// Without the switch it would read "Subagent "<name>" finished" — also for the event of a running monitor (counter-test in the header).
const mTask = (report, name) => ({ taskId: "monitor_ab12cd34", description: name, report, timeoutMs: 600_000 });
const MONITOR_CASES = [
  ["event", mTask("rows", "vitest"), { status: "running", output: "FAIL a.test.ts" }, false, "Monitor “vitest” reports"],
  ["end, exit 0", mTask("end", "Suite <A> & B"), { status: "completed", output: "ok" }, true, "Monitor “Suite <A> & B” ended", { exitCode: 0 }],
  ["end, exit 1", mTask("end", "Build"), { status: "failed", output: "error" }, true, "Monitor “Build” failed", { exitCode: 1 }],
  ["time limit", mTask("end", "Long"), { status: "timed_out", output: "" }, true, "Monitor “Long” timed out", {}],
  ["flood brake", mTask("rows", "Log"), { status: "flooded", output: "x" }, true, "Monitor “Log” throttled", {}],
  ["WebSocket closed", mTask("end", "ws \"q\""), { status: "completed", output: "" }, true, "Monitor “ws \"q\"” ended", { wsCode: 1000 }],
].map(([title, task, event, end, row, info]) => ({
  title: `Monitor: ${title}`,
  text: monitorNotice({ task, event: end ? { ...event, end: monitorEndText({ task, status: event.status, info }) } : event, logFile: "/a/monitors/x.log", end }),
  name: task.description, row,
}));
CASES.push(...COPY_CASES, ...GRAPH_CASES, ...MONITOR_CASES);
// The task id per case: the end marker that `duplicate` compares against (web `completionNoticeDuplicate`, iOS `duplicate`).
const taskId = (text) => /<task-id>([^<]*)<\/task-id>/.exec(text)?.[1] ?? "";

// The queue: each text with and without the server's flag, plus two ordinary inputs.
const QUEUE = [];
for (const f of [...CASES, { text: "And another question" }, { text: "" }]) {
  for (const systemNotice of [true, false, null]) QUEUE.push({ text: f.text, systemNotice });
}

// ── Web ─────────────────────────────────────────────────────────────────────────────────────
async function loadWeb() {
  const out = path.join(tmpDir(), "web");
  execFileSync(process.execPath, [tsc, SOURCE_TS, "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  return import(pathToFileURL(path.join(out, "completionNotice.js")).href);
}
// The same placeholder replacement as `fmt` in src/lib/i18n.ts — English is the key.
const t = (k, p) => (p ? k.replace(/\{(\w+)\}/g, (m, x) => (x in p ? String(p[x]) : m)) : k);

// ── iOS ─────────────────────────────────────────────────────────────────────────────────────
let iosResult = null;
function runIos() {
  if (iosResult) return iosResult;
  const source = fs.readFileSync(SOURCE_SWIFT, "utf8");
  const imports = source.split("\n").filter((z) => /^import /.test(z));
  assert.deepEqual(imports, ["import Foundation"], "CompletionNotice.swift imports only Foundation — otherwise it no longer runs standalone here");
  const input = path.join(tmpDir(), "cases.json");
  fs.writeFileSync(input, JSON.stringify({ read: CASES.map((f) => f.text), markers: CASES.map((f) => taskId(f.text)), queue: QUEUE }));
  const message = fs.readFileSync(SOURCE_MESSAGE_SWIFT, "utf8");
  assert.deepEqual(message.split("\n").filter((z) => /^import /.test(z)), ["import Foundation"], "InboundAgentMessage.swift imports only Foundation");
  const file = path.join(tmpDir(), "finished.swift");
  fs.writeFileSync(file, `${source}
${message.replace(/^import Foundation\n/m, "")}

// ── Stand-in and driver (web/test/completion-notice-binding.test.mjs) ──
func L(_ key: String) -> String { key }
func L(_ key: String, _ params: [String: CustomStringConvertible]) -> String {
    var s = key
    for (k, v) in params { s = s.replacingOccurrences(of: "{\\(k)}", with: v.description) }
    return s
}
let data = try! Data(contentsOf: URL(fileURLWithPath: ${JSON.stringify(input)}))
let root = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
var read: [Any] = []
let markers = root["markers"] as! [String]
for (i, text) in (root["read"] as! [String]).enumerated() {
    if let f = CompletionNotice.read(text) {
        let k: Any = CompletionNotice.copy(text).map { ["name": $0.name, "outcome": $0.outcome.rawValue] } ?? NSNull()
        read.append(["agentId": f.agentId, "name": f.name, "status": f.status, "row": CompletionNotice.row(text),
                     "copy": k, "duplicate": CompletionNotice.duplicate(markerTaskId: markers[i], text)])
    }
    else { read.append(NSNull()) }
}
var queue: [Any] = []
for q in root["queue"] as! [[String: Any]] {
    let flag = q["systemNotice"] as? Bool
    if let z = CompletionNotice.queue(text: q["text"] as! String, systemNotice: flag) { queue.append(z) } else { queue.append(NSNull()) }
}
let outData = try! JSONSerialization.data(withJSONObject: ["read": read, "queue": queue])
print(String(data: outData, encoding: .utf8)!)
`);
  let output;
  try {
    output = execFileSync("xcrun", ["swift", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`the Swift source could not be executed (xcrun swift): ${e.stderr || e.message}`);
  }
  iosResult = JSON.parse(output.trim().split("\n").pop());
  return iosResult;
}

// ── The checks ───────────────────────────────────────────────────────────────────────────
test("name, outcome and system row — iOS reads the same as web case by case, and the right name", async () => {
  const web = await loadWeb();
  const ios = runIos();
  assert.equal(ios.read.length, CASES.length);
  CASES.forEach((f, i) => {
    const w = web.readCompletionNotice(f.text);
    const z = web.finishedRow(f.text);
    // The end marker compared against carries the case's own task id — the hardest case for `duplicate`.
    const marker = { kind: "workflow-end", marker: { taskId: taskId(f.text) } };
    const webRow = w ? {
      agentId: w.agentId, name: w.name, status: w.status, row: t(z.label, z.labelParams),
      copy: web.readCopyNotice(f.text), duplicate: web.completionNoticeDuplicate(marker, f.text),
    } : null;
    assert.deepEqual(ios.read[i], webRow, `${f.title}: web and iOS differ`);
    if (f.name === null) assert.equal(webRow, null, `${f.title}: no completion notice`);
    else assert.equal(webRow?.name, f.name, `${f.title}: wrong name`);
  });
});

// Every form the server writes for the wake-up call of a copy shows name and outcome in web AND iOS — never
// "System message" —, the graph workflow notice is called Workflow, and only the dynamic workflow merges with its end marker.
test("the wake-up call of a copy shows name and outcome, the graph workflow is called Workflow — web and iOS, spelled out", async () => {
  const web = await loadWeb();
  const ios = runIos();
  const checked = [...COPY_CASES, ...GRAPH_CASES, ...MONITOR_CASES];
  for (const f of checked) {
    const i = CASES.indexOf(f);
    const z = web.finishedRow(f.text);
    assert.equal(t(z.label, z.labelParams), f.row, `${f.title}: web shows "${t(z.label, z.labelParams)}"`);
    assert.equal(ios.read[i]?.row, f.row, `${f.title}: iOS shows "${ios.read[i]?.row}"`);
    if ("copy" in f) assert.deepEqual(web.readCopyNotice(f.text), f.copy, `${f.title}: copy read wrong`);
    const marker = { kind: "workflow-end", marker: { taskId: taskId(f.text) } };
    assert.equal(web.completionNoticeDuplicate(marker, f.text), f.duplicate === true, `${f.title}: merges with the end marker or not`);
    // The queue goes through the same switch.
    const e = web.queueEntry({ text: f.text, systemNotice: true });
    assert.equal(e.systemNotice && t(e.label, e.labelParams), f.row, `${f.title}: queue`);
  }
  // All five outcomes came from the server, for every copy.
  const fromServer = COPY_CASES.filter((f) => f.fromServer);
  assert.equal(fromServer.length, COPIES.length * COPY_CALLS.length);
  assert.deepEqual([...new Set(fromServer.map((f) => f.copy.outcome))].sort(),
    ["clearedAway", "never-built-removed", "not-built", "not-cleared-away", "ready"]);
});

// Completeness: the server writes exactly these five summary forms — a sixth (a new outcome) would fall through the
// switch and show only "System message" again. And the graph form the hand cases above follow is the one in the server.
test("the server writes exactly the five copy forms of the switch, and the graph form of the cases", () => {
  const source = ["inset.js", "remove.js"].map((d) => fs.readFileSync(path.join(STACKS, d), "utf8")).join("\n");
  const forms = [...source.matchAll(/`Copy "\$\{k\.name\}"([^`$]*)/g)].map((m) => m[1]).sort();
  assert.deepEqual(forms, [" not built: ", " not removed: ", " ready", " removed", " removed (never built)"],
    "the summary forms of the copy wake-up call have changed — update lib/completionNotice.ts readCopyNotice, CompletionNotice.swift copy and COPY_CALLS here");
  const graphSource = fs.readFileSync(path.join(repo, "server", "backend", "electron", "server", "workflows", "graph-background.js"), "utf8");
  for (const s of ['`Graph-Workflow "${name}" completed`', '`Graph-Workflow "${name}" was stopped`', '`Graph-Workflow "${name}" failed: ', "`<status>${status}</status>`", "`<name>${xml(name)}</name>`"]) {
    assert.ok(graphSource.includes(s), `workflows/graph-background.js no longer writes ${s} — the graph cases here follow an old form`);
  }
});

// Every row of the new cases has a German version — on web (i18n-de.ts) and on iOS (LocDEBase/LocDEMobile; the
// calls in CompletionNotice.swift are literal, loc-audit.sh sees them too, this test holds the web beside it).
test("every copy and graph row is translated, on web and on iOS", async () => {
  const web = await loadWeb();
  const entries = (q) => new Set([...q.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:\s*"/gm)].map((m) => m[1]));
  const webKey = entries(fs.readFileSync(path.join(webDir, "src", "lib", "i18n-de.ts"), "utf8"));
  const iosKey = entries(["LocDEBase.swift", "LocDEMobile.swift"]
    .map((d) => fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", "Kit", d), "utf8")).join("\n"));
  const labels = [...new Set([...COPY_CASES, ...GRAPH_CASES, ...MONITOR_CASES].map((f) => web.finishedRow(f.text).label))];
  assert.ok(labels.length >= 8, `too few rows checked: ${labels.join(" · ")}`);
  assert.deepEqual(labels.filter((l) => !webKey.has(l)), [], "without German version on web");
  assert.deepEqual(labels.filter((l) => !iosKey.has(l)), [], "without German version on iOS");
});

test("the queue entry — system message with name and state in both, an input stays an input", async () => {
  const web = await loadWeb();
  const ios = runIos();
  assert.equal(ios.queue.length, QUEUE.length);
  QUEUE.forEach((q, i) => {
    const e = web.queueEntry({ text: q.text, ...(q.systemNotice === null ? {} : { systemNotice: q.systemNotice }) });
    const webRow = e.systemNotice ? t(e.label, e.labelParams) : null;
    assert.equal(ios.queue[i], webRow, `entry ${i} (${JSON.stringify(q).slice(0, 80)}): web and iOS differ`);
  });
  // The expectation spelled out, not only the equality.
  const finished = completionNotice({ status: "failed", agentId: "q1", description: "Reviewer", error: 'Tool "Bash" failed: exit 2' });
  const e = web.queueEntry({ text: finished, systemNotice: true });
  assert.equal(e.systemNotice, true);
  assert.equal(t(e.label, e.labelParams), "Subagent \"{name}\" failed".replace("{name}", "Reviewer"));
  assert.equal(web.queueEntry({ text: finished }).systemNotice, true, "the marker on the text suffices (older server)");
  assert.equal(web.queueEntry({ text: "And another question" }).systemNotice, false);
  assert.equal(t(web.queueEntry({ text: "And another question", systemNotice: true }).label), "System message",
    "flagged by the server, but no completion notice: the general row");
});

// The strip uses the switch — and the system message has no trash can (source contract; the view itself is measured by
// the probe).
test("web and iOS strip ask the switch, and their system-message branch has no trash can", () => {
  const web = fs.readFileSync(path.join(webDir, "src", "components", "ComposerStrip.tsx"), "utf8");
  const branch = /const entry = queueEntry\(q\);\n\s*if \(entry\.systemNotice\) \{([^]*?)\n\s*continue;\n\s*\}/.exec(web);
  assert.ok(branch, "ComposerStrip branches on queueEntry and then moves on (continue)");
  assert.ok(!/onDismiss|verwerfen/.test(branch[1]), "no dismiss in the system-message branch");
  const swift = fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", "Chat", "ChatComposer.swift"), "utf8");
  assert.match(swift, /let systemLine = CompletionNotice\.queue\(text: item\.text, systemNotice: item\.systemNotice\)/);
  assert.match(swift, /onDismiss: systemLine == nil \? \{ Task \{ await model\.cancelQueued\(item\) \} \} : nil/,
    "iOS: the system message has no trash can");
  const strip = fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", "Chat", "ChatStrip.swift"), "utf8");
  assert.match(strip, /if let onDismiss \{\n\s*Button\(action: onDismiss\)/, "StripMessage draws the trash can only with a handler");
});
