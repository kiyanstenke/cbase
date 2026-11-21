// The set of an Outer Loop run, bound: web and iOS read `set` the same.
//
// The server writes `set.extern` as a list `{key, name, tools}` (server/backend/electron/server/outerloop/set.js:setRow) and
// `dropped.genus`. The web (`normSet` in web/src/lib/api/outerloop.ts, reached via `normOuterLoopRun`) turns it into "<server>: <tool>";
// iOS (`OuterLoopSetRaw` in mobile/CbaseMobile/Models/OuterLoopModels.swift) once tried only `[String]` and a map — both failed silently
// on the object list, `extern` was empty for EVERY run. The rule exists ONCE per client.
//
// Model: token-kind-binding.test.mjs. The Swift types are cut out, assembled with the decode helpers into a program and REALLY run with
// `xcrun swift`. If the toolchain is missing the test fails LOUDLY (`latch.json`: `onlyMacOS`).
//
// Counter-probes: in OuterLoopModels.swift the old branch `c.strings(.extern)` instead of the object list => the equality test red (iOS
// empty, web "Teams: read"); without `genus` in `DroppedKeys` => likewise red; `locked` struck from `DroppedKeys` => case "with locked"
// red, iOS empty.
//
// The file also binds the fields of the agenda keeper: `OuterLoopAgent` (`agendaKeeper`, `fixed`, `markUpkeep`, `upkeepTally`),
// `OuterLoopRun.upkeep`, the chat info, the words of the tally (web `upkeepTallyText`/`runUpkeepText` in
// components/outerloop/outerLoopText.ts, iOS `OuterLoopWord.upkeepTally`/`runUpkeep` in Code/OuterLoopPane.swift — including "Track
// record unknown") and the display of a run the server ended on purpose (`runError` — EVERY code of the ONE server constant
// `INTENDED_END` in outerloop/intended-end.js, loaded directly: `turn` and `quiet`, per code a case at the server's state and the same
// code at `error`/`finished`). Both sides REALLY run: the web via tsc / transpileModule, iOS as ONE program from the whole
// Models/OuterLoopModels.swift (without `OuterLoopAPI`, which needs the APIClient), DecodeHelpers.swift, JSONValue.swift and the words
// from OuterLoopWord, compiled with `xcrun swiftc`; `L` returns the key with filled placeholders, like `t` in the web. The cases come
// from the server shape: the field names and the state of an intended end are READ from the server source (outerloop/publiclyVisible.js,
// store/outer-loop.js, store/agenda-upkeep.js), the codes from `INTENDED_END` — an anchor that finds nothing throws. Plus nonsense per
// field (missing, wrong type, decimal, list instead of object, values on an agent that is not the keeper).
//
// Counter-probes of the keeper ("fields", "runs", "words" are the keeper tests below; "field names" the first):
//   OuterLoopModels.swift: `markUpkeep = c.bool(.markUpkeep)` (old default)                                    => "fields" red
//     same: `upkeepTally` decoded on every agent                                                               => "fields" red
//     same: the changes count decoded without a total                                                          => "fields" red
//     same: `case agendaKeeper = "agendaKeeperX"` (a wrong wire key)                                           => "fields", "runs" red
//   OuterLoopPane.swift: `runUpkeep` without `guard p.corrected > 0`                                           => "runs", "words" red
//     same: "no change yet" in lower case                                                                      => "fields", "words" red
//     same: without a tally "—" (the editor's old fallback)                                                    => "fields", "words" red
//     same: the abort-at-turn constant set to "Turn"                                                           => "runs" red
//   outerLoopText.ts: `upkeepTallyText(null)` => "—"                                                           => "fields", "words" red
//     same: the abort-at-turn constant "Turn" => "runs" red; `p.corrected ?` instead of `> 0`                  => "words" red
//   lib/api/outerloop.ts: a wrong count function in normUpkeepTally (decimal)                                  => "fields" red
//   server anchors (run in a copy of the repo): `agendaKeeperTurnStart` renamed or `SET state` gone => the anchor THROWS, all four red;
//     reason "turn-begin" => "runs" red; `upkeepTallies:` in publicAgent or `confirmed:` in agendaUpkeepTally => "field names" red.
//   intended-end.js: a new code without client text; outerLoopText.ts: `quiet` gone / intended end `quiet: false`; OuterLoopPane.swift:
//   `case "quiet"` gone / `runError` without the state "aborted"                                                => each red in "runs"
//
// Run:  node --test web/test/outerloop-set-binding.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const SOURCE_TS = path.join(webDir, "src", "lib", "api", "outerloop.ts");
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Models", "OuterLoopModels.swift");
const SOURCE_HELPER = path.join(repo, "mobile", "CbaseMobile", "Models", "DecodeHelpers.swift");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
const tmpDir = () => (tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "cbase-outerloop-set-binding-")));

// The cases: the value of `set` in a run row as the server writes it, plus the fallbacks of both clients.
const CASES = [
  { name: "setRow (server)", set: { cbase: ["cbase_fact_search", "cbase_chat_analysis"], builtin: ["Read"], extern: [{ key: "teams", name: "Teams", tools: ["read", "search"] }], dropped: { fence: ["mcp__gitlab__issues"], approval: ["cbase_doc_write"], genus: ["cbase_workflow_list"] } } },
  { name: "server without names, without tools", set: { cbase: [], builtin: [], extern: [{ key: "k1", name: "", tools: ["w"] }, { key: "k2", name: "Two", tools: [] }], dropped: { fence: [], approval: [] } } },
  { name: "list of names", set: { cbase: ["a"], builtin: [], extern: ["Teams: read"], dropped: { fence: [], approval: [] } } },
  { name: "map server -> tools", set: { cbase: [], builtin: [], extern: { teams: ["read"], gitlab: ["issues", "mrs"] }, dropped: {} } },
  { name: "old row without genus", set: { cbase: ["x"], builtin: ["Bash"], extern: [], dropped: { fence: ["z"], approval: [] } } },
  { name: "without dropped and extern", set: { cbase: ["x"], builtin: [] } },
  { name: "with locked", set: { cbase: ["x"], builtin: [], extern: [], dropped: { fence: [], approval: [], locked: ["mcp__teams__send"], genus: [] } } },
  { name: "as JSON text", set: JSON.stringify({ cbase: ["x"], builtin: [], extern: [{ key: "t", name: "T", tools: ["a"] }], dropped: { fence: [], approval: [], genus: ["g"] } }) },
];

const form = (s) => ({ cbase: s.cbase, builtin: s.builtin, extern: s.extern, fence: s.dropped.fence, approval: s.dropped.approval, locked: s.dropped.locked, genus: s.dropped.genus });

async function loadWeb() {
  const out = path.join(tmpDir(), "web");
  execFileSync(process.execPath, [tsc, SOURCE_TS, "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom"], { cwd: webDir, stdio: "pipe" });
  return import(pathToFileURL(path.join(out, "outerloop.js")).href);
}

// A block from the line `header` to the first line `end` after it (same indentation).
function block(rows, header, end, location) {
  const start = rows.findIndex((z) => z === header);
  assert.ok(start >= 0, `\`${header}\` is missing in ${location} — update the anchor, do not delete the test`);
  const end2 = rows.findIndex((z, i) => i > start && z === end);
  assert.ok(end2 > start, `the end of \`${header}\` is missing in ${location}`);
  return rows.slice(start, end2 + 1).join("\n");
}

function runIos() {
  const rows = fs.readFileSync(SOURCE_SWIFT, "utf8").split("\n");
  const location = "OuterLoopModels.swift";
  const set = block(rows, "struct OuterLoopSet: Hashable, Sendable {", "}", location);
  const entry = block(rows, "private struct OuterLoopExternEntry: Decodable {", "}", location);
  const raw = block(rows, "private struct OuterLoopSetRaw: Decodable {", "}", location);
  const mcpChoice = block(rows, "    func mcpChoice(_ key: Key) -> [String: [String]] {", "    }", location);
  // Only the helpers the three types use (DecodeHelpers.swift also knows JSONValue).
  const hz = fs.readFileSync(SOURCE_HELPER, "utf8").split("\n");
  const helper = ["import Foundation", "extension KeyedDecodingContainer {",
    ...["    func str(_ key: Key, _ fallback: String = \"\") -> String {", "    func strOpt(_ key: Key) -> String? {", "    func strings(_ key: Key) -> [String] {"]
      .map((header) => block(hz, header, "    }", "DecodeHelpers.swift")), "}"].join("\n");
  const file = path.join(tmpDir(), "set.swift");
  // Like OuterLoopRun (Models/OuterLoopModels.swift): an object directly, a text via JSONDecoder.
  fs.writeFileSync(file, `${helper}
extension KeyedDecodingContainer {
${mcpChoice}
}
${set}
${entry.replace(/^private /, "")}
${raw.replace(/^private /, "")}
struct Wrapper: Decodable {
    let set: OuterLoopSet
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        if let r = (try? c.decodeIfPresent(OuterLoopSetRaw.self, forKey: .set)) ?? nil { set = r.set }
        else if let s = c.strOpt(.set), let r = try? JSONDecoder().decode(OuterLoopSetRaw.self, from: Data(s.utf8)) { set = r.set }
        else { set = OuterLoopSet() }
    }
    enum K: String, CodingKey { case set }
}
let input = CommandLine.arguments[1]
let cases = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: input))) as! [Any]
var outData: [[String: [String]]] = []
for f in cases {
    let d = try! JSONSerialization.data(withJSONObject: ["set": f])
    let s = try! JSONDecoder().decode(Wrapper.self, from: d).set
    outData.append(["cbase": s.cbase, "builtin": s.builtin, "extern": s.extern, "fence": s.droppedFence, "approval": s.droppedApproval, "locked": s.droppedLocked, "genus": s.droppedGenus])
}
print(String(data: try! JSONSerialization.data(withJSONObject: outData, options: [.sortedKeys]), encoding: .utf8)!)
`);
  const input = path.join(tmpDir(), "cases.json");
  fs.writeFileSync(input, JSON.stringify(CASES.map((f) => f.set)));
  let output = "";
  try {
    output = execFileSync("xcrun", ["swift", file, input], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`the Swift source could not be run (xcrun swift): ${e.stderr || e.message}`);
  }
  return JSON.parse(output.trim());
}

test("web: the server's object list becomes \"<server>: <tool>\", dropped.genus arrives", async () => {
  const { normOuterLoopRun } = await loadWeb();
  const s = normOuterLoopRun({ id: "l", set: CASES[0].set }).set;
  assert.deepEqual(s.extern, ["Teams: read", "Teams: search"]);
  assert.deepEqual(s.dropped.genus, ["cbase_workflow_list"]);
  assert.deepEqual(normOuterLoopRun({ id: "l", set: CASES[4].set }).set.dropped.genus, [], "an old row without genus is empty");
});

// The server writes `dropped.locked` (chosen tools of a coding MCP server that are deselected at the server for coding chats,
// outerloop/set.js), and the runs list shows them beside fence and approval marker. iOS reads it likewise (`droppedLocked`), the
// equality test below compares it. Counter-probe: `locked` struck from `normSet` => this test red.
test("web: dropped.locked arrives, an old row without the field is empty", async () => {
  const { normOuterLoopRun } = await loadWeb();
  const set = { ...CASES[0].set, dropped: { ...CASES[0].set.dropped, locked: ["mcp__teams__send"] } };
  assert.deepEqual(normOuterLoopRun({ id: "l", set }).set.dropped.locked, ["mcp__teams__send"]);
  assert.deepEqual(normOuterLoopRun({ id: "l", set: CASES[4].set }).set.dropped.locked, [], "a row without locked is empty");
});

test("web and iOS read the set the same (xcrun swift)", async () => {
  const { normOuterLoopRun } = await loadWeb();
  const web = CASES.map((f) => form(normOuterLoopRun({ id: "l", set: f.set }).set));
  const ios = runIos();
  console.log(`# Outer Loop set: ${CASES.length} cases`);
  for (let i = 0; i < CASES.length; i += 1) assert.deepEqual(ios[i], web[i], `case "${CASES[i].name}": iOS differs from the web`);
  assert.ok(ios[0].extern.length > 0, "iOS does not read the server's object list as empty");
});

// ── Agenda keeper ─────────────────────────────────────────────────────────────────────────────────────────────
// What keeps the keeper's fields, its words and the display of an intentionally ended run the same on both sides.
const SERVER = path.join(repo, "server", "backend", "electron", "server");
// The codes of an intended end: the ONE server constant (outerloop/intended-end.js, a leaf without imports — loaded directly).
const { INTENDED_END } = await import(pathToFileURL(path.join(SERVER, "outerloop", "intended-end.js")).href);
const SOURCE_WORD_TS = path.join(webDir, "src", "components", "outerloop", "outerLoopText.ts");
const SOURCE_WORD_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Code", "OuterLoopPane.swift");
const SOURCE_JSON_VALUE = path.join(repo, "mobile", "CbaseMobile", "Models", "JSONValue.swift");

// The server shape, read from the source. Every anchor THROWS if it finds nothing — a silent fallback to a copied value would be exactly
// the promise without a way that this section is meant to close.
function serverForm() {
  const read = (rel) => fs.readFileSync(path.join(SERVER, rel), "utf8");
  const anchor = (text, re, what) => {
    const m = text.match(re);
    if (!m) throw new Error(`Server source: ${what} not found (${re}) — update the anchor, do not delete the test`);
    return m;
  };
  const key = (literal) => [...literal.matchAll(/(\w+)\s*:/g)].map((m) => m[1]).sort();
  const publiclyVisible = read("outerloop/publiclyVisible.js");
  const agentFrom = anchor(read("store/outer-loop.js"), /function agentFrom\(r\) \{[\s\S]*?\n\}\n/, "store/outer-loop.js agentFrom")[0];
  const upkeepFields = anchor(publiclyVisible, /const upkeepFields = \(agent\) => \(\{([^\n]*)\}\);/, "publiclyVisible.js upkeepFields")[1];
  const publicAgent = anchor(publiclyVisible, /export function publicAgent\([\s\S]*?\n\}\n/, "publiclyVisible.js publicAgent")[0];
  const publicRun = anchor(publiclyVisible, /export function publicRun\([\s\S]*?\n\}\n/, "publiclyVisible.js publicRun")[0];
  const tally = anchor(read("store/agenda-upkeep.js"), /function agendaUpkeepTally\([\s\S]*?\n\}\n/, "store/agenda-upkeep.js agendaUpkeepTally")[0];
  const abort = anchor(read("store/outer-loop.js"), /function outerLoopRunsAbortIds\([\s\S]*?\n\}\n/, "store/outer-loop.js outerLoopRunsAbortIds")[0];
  // An anchor that throws: without the constant, empty or with a code that is no text, there would be nothing to bind.
  const intended = INTENDED_END && typeof INTENDED_END === "object" ? Object.values(INTENDED_END) : [];
  if (!intended.length || intended.some((c) => typeof c !== "string" || !c)) {
    throw new Error(`outerloop/intended-end.js INTENDED_END: expected codes, found ${JSON.stringify(INTENDED_END)} — update the anchor, do not delete the test`);
  }
  return {
    // The identifiers on the agent (store shape, via `...withoutArea(agent)` in publicAgent).
    identifier: ["summarizer", "agendaKeeper"].filter((k) => new RegExp(`\\b${k}:`).test(agentFrom)),
    // `fixed`, `markUpkeep` (via `...upkeepFields(agent)` — after the store shape, they override its `markUpkeep`).
    upkeepFields: key(upkeepFields),
    spreads: /\.\.\.withoutArea\(agent\),\s*\.\.\.upkeepFields\(agent\),/.test(publicAgent),
    tallyField: /\n\s+upkeepTally:/.test(publicAgent) ? "upkeepTally" : null,
    runField: /return \{[^\n]*[,{]\s*upkeep\s*(?=[,}])[^\n]*\};/.test(publicRun) ? "upkeep" : null,
    // The tally on the agent (last `return { … }`) and per run (`out.set(…, { … })`).
    tallyAgent: key(anchor(tally, /return \{ (changes[^\n]*) \};\n\}/, "agendaUpkeepTally: tally on the agent")[1]),
    tallyRun: key(anchor(tally, /out\.set\(r\.run_id, \{ ([^\n]*) \}\);/, "agendaUpkeepTally: tally per run")[1]),
    intended,
    abortState: anchor(abort, /SET state = '(\w+)'/, "outerLoopRunsAbortIds: the state")[1],
  };
}

// The cases. The server shape (publicAgent/publicRun/publicAgentShort): per agent the store shape plus `fixed`, `markUpkeep` (true only for
// the keeper), `upkeepTally` (for the keeper an object with all four counters, otherwise null); per run `upkeep` (for the keeper
// `{ changes, corrected }`, otherwise null) and `error`/`state` — per intended end of the server a run with its code and the server's
// state, plus the same code at another state (there it is no intended end).
function keeperCases(sf) {
  const agent = (o) => ({ id: "a", workspaceId: "w1", projectId: null, chatId: null, origin: "workspace", name: "A", job: "", trigger: [],
    provider: "claude", model: "sonnet", effort: "high", defaultNew: true, defaultNewSince: null, tools: [], builtin: [], mcp: {},
    summarizer: false, agendaKeeper: false, templateRevision: 1, on: true, createdAt: 1, updatedAt: 2, chatTitle: null, chatKind: null,
    projectName: null, effective: true, ineffectiveReason: null, templateNew: false, notTakenOverIn: [], running: 0, ...o });
  const run = (o) => ({ id: "l", agentId: "w1-a9e0da", chatId: "c1", trigger: "quiet", state: "finished", startedAt: 1, endedAt: 2, parkedUntil: null,
    attempts: 1, set: { cbase: [], builtin: [], extern: [], dropped: {} }, error: "", provider: "claude", model: "sonnet", billing: "subscription",
    input: 1, output: 1, cached: 0, cost: null, chatTitle: "C", chatKind: "normal", upkeep: null, ...o });
  const b = (changes, open, confirmed, corrected) => ({ changes, open, confirmed, corrected });
  const agents = [
    // server shape
    { name: "keeper (server)", raw: agent({ id: "w1-a9e0da", name: "Agenda keeper", agendaKeeper: true, fixed: true, markUpkeep: true, upkeepTally: b(12, 7, 3, 2) }) },
    { name: "keeper off, without change (server)", raw: agent({ id: "w1-a9e0da", agendaKeeper: true, fixed: true, markUpkeep: false, upkeepTally: b(0, 0, 0, 0) }) },
    { name: "summariser (server)", raw: agent({ id: "w1-z", summarizer: true, fixed: true, markUpkeep: false, upkeepTally: null }) },
    { name: "workspace agent (server)", raw: agent({ fixed: false, markUpkeep: false, upkeepTally: null }) },
    // nonsense
    { name: "keeper without the new fields (older server)", raw: agent({ agendaKeeper: true }) },
    { name: "keeper with wrong types", raw: agent({ agendaKeeper: true, fixed: "yes", markUpkeep: "no", upkeepTally: [12, 7, 3, 2] }) },
    { name: "tally without total", raw: agent({ agendaKeeper: true, fixed: true, markUpkeep: true, upkeepTally: { open: 1, corrected: 2 } }) },
    { name: "tally full of nonsense", raw: agent({ agendaKeeper: true, upkeepTally: { changes: "12", open: 2.7, confirmed: null, corrected: -1 } }) },
    { name: "tally as text", raw: agent({ agendaKeeper: true, upkeepTally: "12" }) },
    { name: "switch and tally on another agent", raw: agent({ markUpkeep: true, upkeepTally: b(4, 4, 0, 0) }) },
    { name: "identifier as number", raw: agent({ agendaKeeper: 1, fixed: 1, markUpkeep: 1 }) },
    { name: "identifier as text", raw: agent({ agendaKeeper: "true" }) },
    { name: "summariser, server says not fixed", raw: agent({ summarizer: true, fixed: false }) },
    { name: "empty object", raw: {} },
  ];
  const runs = [
    { name: "keeper run (server)", raw: run({ upkeep: { changes: 3, corrected: 1 } }) },
    { name: "keeper run without correction (server)", raw: run({ upkeep: { changes: 3, corrected: 0 } }) },
    { name: "run of another agent (server)", raw: run({ agentId: "a", upkeep: null }) },
    { name: "agent deleted (server)", raw: run({ state: "aborted", error: "Agent deleted" }) },
    { name: "error (server)", raw: run({ state: "error", error: "Model unavailable" }) },
    { name: "upkeep as list", raw: run({ upkeep: [3, 1] }) },
    { name: "upkeep as text", raw: run({ upkeep: "3" }) },
    { name: "upkeep empty", raw: run({ upkeep: {} }) },
    { name: "upkeep full of nonsense", raw: run({ upkeep: { changes: "3", corrected: 1.9 } }) },
    { name: "without upkeep, error, state", raw: { id: "l" } },
    // Per intended end of the server: its code at the server's state — and the same code at `error`/`finished` (no intended end).
    ...sf.intended.flatMap((code) => [
      { name: `intended end "${code}" (server)`, intended: code, raw: run({ state: sf.abortState, error: code, endedAt: 3, upkeep: { changes: 0, corrected: 0 } }) },
      { name: `code "${code}", but state error`, notIntended: code, raw: run({ state: "error", error: code }) },
      { name: `code "${code}", but state finished`, notIntended: code, raw: run({ state: "finished", error: code }) },
    ]),
  ];
  // The chat info (`GET /api/chats/:id/outer-loop`, publicAgentShort + activation + last run).
  const chat = { targetChat: true, reason: "", notes: [], agents: [
    { ...agent({ id: "w1-a9e0da", agendaKeeper: true, fixed: true, markUpkeep: true }), active: true, source: "standard", since: 5, toggleable: true, running: 0,
      lastRun: run({ state: sf.abortState, error: sf.intended.at(-1), upkeep: { changes: 0, corrected: 0 } }) },
    { ...agent({ id: "w1-z", summarizer: true, fixed: true }), active: true, source: "standard", since: 5, toggleable: true, running: 1,
      lastRun: run({ agentId: "w1-z", state: "error", error: "broken" }) },
    { ...agent({ id: "x" }), active: false, source: "no-default", toggleable: true, running: false, lastRun: null },
  ] };
  // The words directly: tallies (null = unknown) and run tallies at every boundary.
  const tallies = [null, b(0, 0, 0, 0), b(1, 1, 0, 0), b(1, 0, 1, 0), b(2, 0, 1, 1), b(12, 7, 3, 2), b(3, 0, 0, 3), b(-3, 0, 0, 0)];
  const runTallies = [{ changes: 0, corrected: 0 }, { changes: 1, corrected: 0 }, { changes: 1, corrected: 1 }, { changes: 3, corrected: 1 },
    { changes: 3, corrected: 0 }, { changes: 12, corrected: 12 }, { changes: -1, corrected: 0 }, { changes: 2, corrected: -1 }];
  return { agents, runs, chat, tallies, runTallies };
}

// A t() that returns the key with filled placeholders — `L` does the same in the iOS program.
const tKey = (k, p = {}) => k.replace(/\{(\w+)\}/g, (_, n) => String(p[n] ?? `{${n}}`));

async function keeperWeb(f) {
  const { normOuterLoopAgent, normOuterLoopRun, normOuterLoopChatState } = await loadWeb();
  // outerLoopText.ts imports only types via `@/lib/api` — transpiled without type checking (the project's tsc checks the types).
  const ts = (await import(pathToFileURL(path.join(webDir, "node_modules", "typescript", "lib", "typescript.js")).href)).default;
  const js = ts.transpileModule(fs.readFileSync(SOURCE_WORD_TS, "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const file = path.join(tmpDir(), "outerLoopText.mjs");
  fs.writeFileSync(file, js);
  const word = await import(pathToFileURL(file).href);
  const t = tKey;
  return {
    agents: f.agents.map(({ raw }) => {
      const a = normOuterLoopAgent(raw);
      return { summarizer: a.summarizer, agendaKeeper: a.agendaKeeper, fixed: a.fixed, markUpkeep: a.markUpkeep, upkeepTally: a.upkeepTally, tallyText: word.upkeepTallyText(a.upkeepTally, t) };
    }),
    runs: f.runs.map(({ raw }) => {
      const l = normOuterLoopRun(raw);
      return { upkeep: l.upkeep, upkeepText: l.upkeep ? word.runUpkeepText(l.upkeep, t) : null, error: word.runError(l, t) };
    }),
    chat: normOuterLoopChatState(f.chat).agents.map((a) => ({ id: a.id, summarizer: a.summarizer, agendaKeeper: a.agendaKeeper,
      upkeep: a.lastRun?.upkeep ?? null, error: a.lastRun ? word.runError(a.lastRun, t) : null })),
    tallies: f.tallies.map((b) => word.upkeepTallyText(b, t)),
    runTallies: f.runTallies.map((p) => word.runUpkeepText(p, t)),
  };
}

function keeperIos(f) {
  const models = fs.readFileSync(SOURCE_SWIFT, "utf8");
  const helper = fs.readFileSync(SOURCE_HELPER, "utf8");
  const jsonValue = fs.readFileSync(SOURCE_JSON_VALUE, "utf8");
  for (const [name, text] of [["OuterLoopModels.swift", models], ["DecodeHelpers.swift", helper], ["JSONValue.swift", jsonValue]]) {
    assert.deepEqual(text.split("\n").filter((z) => /^import /.test(z)), ["import Foundation"], `${name} imports only Foundation — otherwise it cannot be bound`);
  }
  // OuterLoopAPI needs the app's APIClient — it drops out, everything else in the file runs along.
  const api = block(models.split("\n"), "enum OuterLoopAPI {", "}", "OuterLoopModels.swift");
  // The words from OuterLoopWord (Code/OuterLoopPane.swift — the file needs SwiftUI, hence only these parts).
  const wz = fs.readFileSync(SOURCE_WORD_SWIFT, "utf8").split("\n");
  const location = "OuterLoopPane.swift";
  const word = ["enum OuterLoopWord {",
    block(wz, "    static func upkeepTally(_ b: OuterLoopUpkeepTally?) -> String {", "    }", location),
    block(wz, "    static func runUpkeep(_ p: OuterLoopRunUpkeep) -> String {", "    }", location),
    block(wz, "    private static func changes(_ n: Int) -> String {", "    }", location),
    block(wz, "    static func intendedEnd(_ code: String) -> String? {", "    }", location),
    block(wz, "    static func runError(_ l: OuterLoopRun) -> (text: String, quiet: Bool)? {", "    }", location),
    "}"].join("\n");
  const file = path.join(tmpDir(), "keeper.swift");
  fs.writeFileSync(file, `${jsonValue}
${helper.replace(/^import Foundation\n/m, "")}
${models.replace(/^import Foundation\n/m, "").replace(api, "")}

// ── translation: the key with filled placeholders (like t in the web part of the test) ──
func L(_ key: String) -> String { key }
func L(_ key: String, _ params: [String: CustomStringConvertible]) -> String {
    var text = key
    for (name, value) in params { text = text.replacingOccurrences(of: "{\\(name)}", with: value.description) }
    return text
}
${word}

// ── driver (web/test/outerloop-set-binding.test.mjs) ──
let root = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
func data(_ o: Any) -> Data { try! JSONSerialization.data(withJSONObject: o, options: [.fragmentsAllowed]) }
func tallyFrom(_ b: OuterLoopUpkeepTally?) -> Any {
    b.map { ["changes": $0.changes, "open": $0.open, "confirmed": $0.confirmed, "corrected": $0.corrected] as Any } ?? NSNull()
}
func runUpkeepFrom(_ p: OuterLoopRunUpkeep?) -> Any { p.map { ["changes": $0.changes, "corrected": $0.corrected] as Any } ?? NSNull() }
func errorFrom(_ l: OuterLoopRun?) -> Any {
    guard let l, let f = OuterLoopWord.runError(l) else { return NSNull() }
    return ["text": f.text, "quiet": f.quiet]
}
let agents: [Any] = (root["agents"] as! [Any]).map { raw in
    let a = try! JSONDecoder().decode(OuterLoopAgent.self, from: data(raw))
    return ["summarizer": a.summarizer, "agendaKeeper": a.agendaKeeper, "fixed": a.fixed, "markUpkeep": a.markUpkeep,
            "upkeepTally": tallyFrom(a.upkeepTally), "tallyText": OuterLoopWord.upkeepTally(a.upkeepTally)] as [String: Any]
}
let runs: [Any] = (root["runs"] as! [Any]).map { raw in
    let l = try! JSONDecoder().decode(OuterLoopRun.self, from: data(raw))
    return ["upkeep": runUpkeepFrom(l.upkeep), "upkeepText": l.upkeep.map { OuterLoopWord.runUpkeep($0) as Any } ?? NSNull(), "error": errorFrom(l)] as [String: Any]
}
let stand = try! JSONDecoder().decode(OuterLoopChatState.self, from: data(root["chat"]!))
let chat: [Any] = stand.agents.map { a in
    ["id": a.id, "summarizer": a.agent.summarizer, "agendaKeeper": a.agent.agendaKeeper, "upkeep": runUpkeepFrom(a.lastRun?.upkeep),
     "error": errorFrom(a.lastRun)] as [String: Any]
}
let tallies: [Any] = (root["tallies"] as! [Any]).map { raw in
    OuterLoopWord.upkeepTally(raw is NSNull ? nil : try! JSONDecoder().decode(OuterLoopUpkeepTally.self, from: data(raw)))
}
let runTallies: [Any] = (root["runTallies"] as! [Any]).map { raw in OuterLoopWord.runUpkeep(try! JSONDecoder().decode(OuterLoopRunUpkeep.self, from: data(raw))) }
let outData: [String: Any] = ["agents": agents, "runs": runs, "chat": chat, "tallies": tallies, "runTallies": runTallies]
print(String(data: try! JSONSerialization.data(withJSONObject: outData, options: [.sortedKeys]), encoding: .utf8)!)
`);
  const input = path.join(tmpDir(), "keeper-cases.json");
  fs.writeFileSync(input, JSON.stringify({ agents: f.agents.map((x) => x.raw), runs: f.runs.map((x) => x.raw), chat: f.chat, tallies: f.tallies, runTallies: f.runTallies }));
  const bin = path.join(tmpDir(), "keeper");
  try {
    execFileSync("xcrun", ["swiftc", "-o", bin, file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`the Swift source could not be compiled (xcrun swiftc): ${e.stderr || e.message}`);
  }
  return JSON.parse(execFileSync(bin, [input], { encoding: "utf8" }).trim().split("\n").pop());
}

let keeper = null;
const keeperBoth = async () => {
  if (!keeper) { const sf = serverForm(); const f = keeperCases(sf); keeper = { sf, f, web: await keeperWeb(f), ios: keeperIos(f) }; }
  return keeper;
};

test("keeper: the field names of the server shape are those both clients read (read from the server source)", (tt) => {
  const sf = serverForm();
  tt.diagnostic(`Server: intended end = state "${sf.abortState}", error in ${JSON.stringify(sf.intended)}`);
  assert.deepEqual(sf.identifier, ["summarizer", "agendaKeeper"], "store/outer-loop.js agentFrom carries both identifiers");
  assert.deepEqual(sf.upkeepFields, ["fixed", "markUpkeep"], "publiclyVisible.js upkeepFields: exactly fixed and markUpkeep");
  assert.ok(sf.spreads, "publicAgent applies upkeepFields AFTER the store shape (otherwise its markUpkeep = default 1 would apply to every agent)");
  assert.equal(sf.tallyField, "upkeepTally", "publicAgent carries upkeepTally");
  assert.equal(sf.runField, "upkeep", "publicRun carries upkeep");
  assert.deepEqual(sf.tallyAgent, ["changes", "confirmed", "corrected", "open"], "the tally on the agent");
  assert.deepEqual(sf.tallyRun, ["changes", "corrected"], "the tally per run");
});

test("keeper: web and iOS read agendaKeeper, fixed, markUpkeep and upkeepTally the same — server shape and nonsense (xcrun swiftc)", async (tt) => {
  const { f, web, ios } = await keeperBoth();
  tt.diagnostic(`agent cases: ${f.agents.length}`);
  for (let i = 0; i < f.agents.length; i += 1) assert.deepEqual(ios.agents[i], web.agents[i], `agent "${f.agents[i].name}": iOS differs from the web`);
  // The cases did not run empty: the server shape arrived, not the defaults.
  assert.deepEqual(web.agents[0], { summarizer: false, agendaKeeper: true, fixed: true, markUpkeep: true,
    upkeepTally: { changes: 12, open: 7, confirmed: 3, corrected: 2 }, tallyText: "12 changes · 10 standing · 2 corrected" });
  assert.equal(web.agents[1].markUpkeep, false, "the switched-off switch arrives");
  assert.equal(web.agents[1].tallyText, "No change yet");
  assert.deepEqual([web.agents[2].fixed, web.agents[2].upkeepTally, web.agents[3].fixed], [true, null, false]);
  assert.deepEqual([web.agents[4].fixed, web.agents[4].markUpkeep, web.agents[4].upkeepTally, web.agents[4].tallyText],
    [true, true, null, "Track record unknown"], "older server: fixed by the rule, switch by the default, tally unknown");
  assert.deepEqual(web.agents[6].upkeepTally, { changes: 3, open: 1, confirmed: 0, corrected: 2 }, "without a total the sum of the outcomes");
  assert.deepEqual([web.agents[9].markUpkeep, web.agents[9].upkeepTally], [false, null], "switch and tally only for the keeper");
});

test("keeper: web and iOS read upkeep per run the same and show EVERY intended end of the server quietly with its own text", async (tt) => {
  const { sf, f, web, ios } = await keeperBoth();
  for (let i = 0; i < f.runs.length; i += 1) assert.deepEqual(ios.runs[i], web.runs[i], `run "${f.runs[i].name}": iOS differs from the web`);
  for (let i = 0; i < web.chat.length; i += 1) assert.deepEqual(ios.chat[i], web.chat[i], `chat info, agent ${i}: iOS differs from the web`);
  assert.deepEqual(web.runs[0], { upkeep: { changes: 3, corrected: 1 }, upkeepText: "3 changes · 1 corrected", error: null });
  assert.equal(web.runs[1].upkeepText, "3 changes", "without a correction no \"· 0 corrected\"");
  const next = (name) => web.runs[f.runs.findIndex((x) => x.name === name)];
  assert.deepEqual(next("agent deleted (server)").error, { text: "Agent deleted", quiet: false });
  // Every code of the server: quiet, with its own text (not the code) — on BOTH sides (iOS == web above); at another state red.
  const texts = [];
  f.runs.forEach((x, i) => {
    if (x.intended) {
      const fe = web.runs[i].error;
      assert.equal(fe?.quiet, true, `"${x.intended}" (intended end of the server) is not shown quietly: ${JSON.stringify(fe)}`);
      assert.ok(fe.text && fe.text !== x.intended, `"${x.intended}" has no own text: ${JSON.stringify(fe)}`);
      texts.push(fe.text);
    }
    if (x.notIntended) assert.deepEqual(web.runs[i].error, { text: x.notIntended, quiet: false }, `${x.name}: only code AND state of the server together are quiet`);
  });
  assert.equal(texts.length, sf.intended.length, "one case per server code");
  assert.equal(new Set(texts).size, texts.length, "every code has its own text");
  assert.ok(texts.includes("Stopped: the chat went back to work") && texts.includes("Postponed: the chat was not quiet"), `the texts: ${JSON.stringify(texts)}`);
  assert.deepEqual(web.chat.map((a) => a.error?.quiet ?? null), [true, false, null], "the chat info shows the last run likewise");
  tt.diagnostic(`intended ends: ${sf.intended.map((c, i) => `${c} → ${texts[i]}`).join("; ")}`);
});

test("keeper: the words of the tally are the same on both sides — also \"Track record unknown\" and at every boundary", async () => {
  const { web, ios } = await keeperBoth();
  assert.deepEqual(ios.tallies, web.tallies);
  assert.deepEqual(ios.runTallies, web.runTallies);
  assert.deepEqual(web.tallies, ["Track record unknown", "No change yet", "1 change · 1 standing · 0 corrected", "1 change · 1 standing · 0 corrected",
    "2 changes · 1 standing · 1 corrected", "12 changes · 10 standing · 2 corrected", "3 changes · 0 standing · 3 corrected", "No change yet"]);
  assert.deepEqual(web.runTallies, ["no change", "1 change", "1 change · 1 corrected", "3 changes · 1 corrected", "3 changes",
    "12 changes · 12 corrected", "no change", "2 changes"]);
});
