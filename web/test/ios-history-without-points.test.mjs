// iPhone: the history without dots, the work indicator at the text edge — the source-text guards of the iOS page, no simulator.
//
// Reads the Swift sources under `mobile/CbaseMobile/` (read only, so it also runs on Linux — NOT under `onlyMacOS`). Comments are
// removed before every check: the sources NAME the forbidden thing in order to justify it ("before, a spinner turned …"). Checked
// PER DECLARATION, not per file — a `Circle()` in the task bar (`NativeTaskBar`, a check mark is content) is not a dot before a
// history row.
//
// The computation itself (chain, table, `runRowVisible`, `groupRunning`) is bound by `history-without-points.test.mjs` (table,
// keys) and `history-binding.test.mjs` (the same matrix through `xcrun swift`). Here it is checked that the iOS views also ASK it
// instead of computing themselves. What holds in the picture — edge ±1 pt, value "running", same height of indicator and metric row,
// marker = sheet — is measured by the XCUITests: `ChatRowsUITests.testRunHexagonStandsOnTheTextEdge`,
// `…testToolGroupShimmersOnlyInRunningTurn`, `…testChatHeaderDotWhileSubagentRuns`,
// `…testThinkingRowAndFileStatsOpenSheets`, `ChatStageUITests.testRunIndicatorIsItsOwnRowWithMessageSpacing`.
//
//   Z11 no icon column, no dot before answer/error/marker, no spinner, no clock
//   Z12 the texts of the run and metric row and the "ERROR" of the group row go through `L()`
//   Z13 the condition of the run row stands in ONE place (`HistoryState.runRowVisible`); named exceptions with a reason (none at present)
//   Z14 light effect, rotation and pulse respect Reduce Motion; no `TimelineView`
//   Z15 run indicator, metric row and group row stand in `.subheadline`
//   Z16 marker and sheet read the SAME state: the marker `chatAgentStates`, the sheet `entry.state` — both from `ChatViewModel`
//       (one assignment, one computation)
//   F7  the audible value is the translated word, not the identifier
//   §5.11 the red counter lies as its own layer over the light band (checked in the picture: otherwise pink-white)
//
// Counter-tests (each shown red once): above every test.
//
// Run:  node --test web/test/ios-history-without-points.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const IOS = "mobile/CbaseMobile";
const raw = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");

// ── Reading Swift ──────────────────────────────────────────────────────────────────────────────────
// Comments become spaces (line breaks stay), strings stay. A small reader instead of a regex: a `//` inside a
// string (`"https://…"`) is not a comment, and block comments nest in Swift. Interpolations with inner strings
// (`"\(L("x"))"`) work because the quotes cancel pairwise.
function withoutComments(t) {
  let out = "";
  let i = 0;
  const empty = (s) => s.replace(/[^\n]/g, " ");
  while (i < t.length) {
    if (t.startsWith('"""', i)) {
      const end = t.indexOf('"""', i + 3);
      const until = end < 0 ? t.length : end + 3;
      out += t.slice(i, until);
      i = until;
    } else if (t[i] === '"') {
      let j = i + 1;
      while (j < t.length && t[j] !== '"' && t[j] !== "\n") j += t[j] === "\\" ? 2 : 1;
      out += t.slice(i, j + 1);
      i = j + 1;
    } else if (t.startsWith("//", i)) {
      const end = t.indexOf("\n", i);
      const until = end < 0 ? t.length : end;
      out += empty(t.slice(i, until));
      i = until;
    } else if (t.startsWith("/*", i)) {
      let depth = 1;
      let j = i + 2;
      while (j < t.length && depth > 0) {
        if (t.startsWith("/*", j)) { depth++; j += 2; } else if (t.startsWith("*/", j)) { depth--; j += 2; } else j++;
      }
      out += empty(t.slice(i, j));
      i = j;
    } else {
      out += t[i];
      i++;
    }
  }
  return out;
}
const swift = (rel) => withoutComments(raw(`${IOS}/${rel}`));

// All Swift sources of the app (without the dictionaries — they only carry keys).
function allSwift(dir = path.join(repo, IOS)) {
  const out = [];
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, n.name);
    if (n.isDirectory()) out.push(...allSwift(p));
    else if (n.name.endsWith(".swift") && !n.name.startsWith("LocDE")) out.push(p);
  }
  return out;
}
const relIOS = (p) => path.relative(path.join(repo, IOS), p).split(path.sep).join("/");

// The block `{ … }` from the first `{` after `ab` — braces in strings do not count
// (`L("Done after {dur}")`). Returns the content WITHOUT the outer braces.
function block(t, startAt, location) {
  const start = t.indexOf("{", startAt);
  assert.ok(startAt >= 0 && start >= 0, `${location}: no block found`);
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (c === '"') {
      if (t.startsWith('"""', i)) { i = t.indexOf('"""', i + 3) + 2; continue; }
      let j = i + 1;
      while (j < t.length && t[j] !== '"' && t[j] !== "\n") j += t[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return t.slice(start + 1, i);
  }
  assert.fail(`${location}: block does not close`);
}
// Body of a declaration (`struct AgentRow`, `func stateWord(`) — exactly ONE occurrence.
function body2(t, header, location) {
  const idx = t.indexOf(header);
  assert.ok(idx >= 0, `${location}: \`${header}\` missing`);
  assert.equal(t.indexOf(header, idx + 1), -1, `${location}: \`${header}\` occurs more than once — the guard cannot tell which is meant`);
  return block(t, idx, `${location} ${header}`);
}

const TOOL_ROWS = "Chat/ChatToolRows.swift";
const RUN_STATUS = "Chat/ChatRunStatus.swift";
const TIMELINE_ROW = "Chat/ChatTimelineRow.swift";

// ── Z11: no icon column, no dot, no spinner, no clock ──
// Counter-test: `Circle().fill(Color.accentColor).frame(width: 7, height: 7)` back before the text in `ChatBlockView`.
test("Z11: no icon column, no dot before answer, error and marker, no spinner, no clock", () => {
  const hits = [];
  for (const p of allSwift()) {
    // WITH comments: even a comment about a column that no longer exists is the next wrong map (same rule as on the web).
    const q = fs.readFileSync(p, "utf8");
    if (/\bChatIconColumn\b|\bchatIconColumn\(/.test(q)) hits.push(relIOS(p));
  }
  assert.deepEqual(hits, [], `ChatIconColumn is still in: ${hits.join(", ")}`);

  const rows = swift(TOOL_ROWS);
  for (const header of ["struct ChatBlockView", "struct AgentRow", "struct ThinkingRow", "struct ToolGroupRow"]) {
    const r = body2(rows, header, TOOL_ROWS);
    assert.ok(!/\bCircle\s*\(/.test(r), `${header}: a Circle() is back before a history row`);
    assert.ok(!/\bProgressView\b/.test(r), `${header}: a ProgressView is turning again`);
  }
  assert.ok(!/\bProgressView\b/.test(rows), "ChatToolRows.swift: a ProgressView is back (the light effect replaces it)");
  assert.ok(!/"clock"/.test(rows), "ChatToolRows.swift: the clock of the thinking row is back");

  // The old identifiers no longer exist in the app — a test that searches for them would find nothing.
  const old = [];
  for (const p of allSwift()) {
    const q = withoutComments(fs.readFileSync(p, "utf8"));
    for (const k of ["chat-text-dot", "chat-tool-spinner"]) if (q.includes(`"${k}"`)) old.push(`${relIOS(p)}: ${k}`);
  }
  assert.deepEqual(old, [], `Removed identifiers still present: ${old.join(", ")}`);
});

// ── Z12: the texts go through L() ──
// `loc-audit.sh` checks that the keys exist — but only for LITERAL `L("…")`. A sentence that does not go through `L()` at
// all escapes it; it stays English in German.
// Counter-test: `"Done after \(ChatViewModel.formatDuration(…))"` back as a literal in the metric text.
test("Z12: \"Done/Aborted after …\", \"Tokens\" and \"ERROR\" go through L() — no literal", () => {
  const violations = [];
  for (const rel of [TIMELINE_ROW, RUN_STATUS, TOOL_ROWS]) {
    const q = swift(rel);
    if (/"Done after \\\(/.test(q)) violations.push(`${rel}: "Done after \\(…)"`);
    if (/"Aborted after \\\(/.test(q)) violations.push(`${rel}: "Aborted after \\(…)"`);
    if (/Text\(\s*"ERROR"\s*\)/.test(q)) violations.push(`${rel}: Text("ERROR")`);
    // Every string that ends in "Tokens" must be the argument of an `L(`.
    for (const m of q.matchAll(/"[^"\n]*Tokens"/g)) {
      if (!/\bL\(\s*$/.test(q.slice(Math.max(0, m.index - 8), m.index))) {
        violations.push(`${rel}: ${m[0]} without L(`);
      }
    }
  }
  assert.deepEqual(violations, [], `Sentences without L(): ${violations.join(" · ")}`);

  const row = swift(TIMELINE_ROW);
  assert.match(row, /L\("Done after \{dur\}"/, "the metric row asks L(\"Done after {dur}\")");
  assert.match(row, /L\("Aborted after \{dur\}"/, "the metric row asks L(\"Aborted after {dur}\")");
  assert.match(body2(swift(TOOL_ROWS), "struct ToolGroupRow", TOOL_ROWS), /Text\(L\("ERROR"\)\)/, "the group row says Text(L(\"ERROR\"))");
});

// ── Z13: the condition of the run row stands in ONE place ──
// An exception is named, with a reason — and checked in BOTH directions: if the condition is no longer there, the row must
// leave the list.
// Counter-test: `if model.busy, !model.waiting {` back where the run row is laid.
// Empty at present; a new exception needs a reason again.
const RUN_ROW_EXCEPTIONS = {};
test("Z13: the run row asks `HistoryState.runRowVisible` — exception named, with a reason", () => {
  const build = [];      // files that lay a run row into the stage
  const direct = [];     // files that build `RunIndicator(` themselves
  const oldForm = [];
  for (const p of allSwift()) {
    const rel = relIOS(p);
    const q = withoutComments(fs.readFileSync(p, "utf8"));
    if (/model\.busy\s*,\s*!model\.waiting/.test(q)) oldForm.push(rel);
    if (/\.run\(ChatRunRowState\(/.test(q)) build.push(rel);
    if (/\bRunIndicator\(/.test(q) && !["Chat/ChatRunStatus.swift", "Chat/ChatTimelineStage.swift"].includes(rel)) direct.push(rel);
  }
  assert.deepEqual(oldForm, [], `\`model.busy, !model.waiting\` is still in: ${oldForm.join(", ")}`);
  assert.deepEqual(build.sort(), ["Chat/ChatView.swift"],
    `The run row is laid by: ${build.join(", ")} — a new place belongs at runRowVisible`);
  for (const rel of build) {
    const q = swift(rel);
    const i = q.indexOf(".run(ChatRunRowState(");
    const beforehand = q.slice(Math.max(0, q.lastIndexOf("\n        if ", i)), i);
    assert.match(beforehand, /HistoryState\.runRowVisible\(busy:\s*model\.busy,\s*waiting:\s*model\.waiting\)/,
      `${rel}: the run row does not hang on HistoryState.runRowVisible`);
    // The row also stands for the pill "N running tasks" (waiting phase: resting hexagon + pill): whether it stands is told by
    // `RunningTasks.rowsParts` — with `runRowVisible` as `running` (bound to the web, running-tasks-binding.test.mjs). A
    // condition of its own next to it would be the third version.
    assert.match(beforehand, /if !RunningTasks\.rowsParts\(running:\s*HistoryState\.runRowVisible\(busy:\s*model\.busy,\s*waiting:\s*model\.waiting\),\s*time:\s*model\.runStartedAt != nil,\s*tasks:\s*runningTasks\.item\.count\)\.isEmpty \{/,
      `${rel}: the run row does not ask RunningTasks.rowsParts(running: runRowVisible …)`);
  }
  assert.deepEqual(direct.sort(), Object.keys(RUN_ROW_EXCEPTIONS).sort(),
    `RunIndicator( is built outside the stage in: ${direct.join(", ")} — an exception needs a reason in RUN_ROW_EXCEPTIONS`);
  for (const [rel, reason] of Object.entries(RUN_ROW_EXCEPTIONS)) {
    assert.ok(reason.length > 40, `${rel}: the exception needs a reason`);
    assert.match(swift(rel), /if model\.busy\s*\{/, `${rel}: the named exception (\`if model.busy\`) is no longer there — strike the line from RUN_ROW_EXCEPTIONS`);
  }
  console.log(`# run row: ${build.length} places ask runRowVisible, ${direct.length} named exception(s): ${direct.join(", ")}`);
});

// ── Z14: Reduce Motion and no TimelineView ──
// Every `.onAppear` that kicks off an animation (`= true`) must stand under `reduceMotion`.
// Limit: this is a statement about the source text — XCUITest cannot reliably toggle Reduce Motion.
// Counter-test: `.onAppear { spinning = true }` without the condition in `RunIndicator`.
function nudges(r) {
  return [...r.matchAll(/\.onAppear\s*\{/g)].map((m) => block(r, m.index, ".onAppear")).filter((b) => /=\s*true/.test(b));
}
test("Z14: light effect, rotation and pulse respect Reduce Motion — every kick-off stands under the condition", () => {
  const cases = [
    ["Chat/ChatShimmer.swift", "struct ChatShimmer"],
    [RUN_STATUS, "struct RunIndicator"],
    [TOOL_ROWS, "struct AgentRow"],
  ];
  for (const [rel, header] of cases) {
    const r = body2(swift(rel), header, rel);
    assert.match(r, /@Environment\(\\\.accessibilityReduceMotion\)/, `${header}: does not read accessibilityReduceMotion`);
    const a = nudges(r);
    assert.ok(a.length >= 1, `${header}: no animation kick-off found in .onAppear — shape changed? Move the guard`);
    for (const b of a) assert.match(b, /!\s*reduceMotion/, `${header}: a kick-off in .onAppear is not under !reduceMotion: {${b.trim()}}`);
  }
  const shimmer = body2(swift("Chat/ChatShimmer.swift"), "struct ChatShimmer", "ChatShimmer.swift");
  assert.ok(!/\bTimelineView\b/.test(swift("Chat/ChatShimmer.swift")), "ChatShimmer: no TimelineView (it re-evaluated the body per frame)");
  assert.match(shimmer, /reduceMotion\s*\{\s*content\.foregroundStyle\(\.primary\)/, "ChatShimmer: under Reduce Motion the sentence stands in .primary");
  assert.match(shimmer, /\.allowsHitTesting\(false\)/, "ChatShimmer: the band catches no touch");
});

// ── §5.11: the red counter stays red under the band ──
// Checked in the picture: the band masked with the whole sentence lightened the counter in its middle almost to white. The
// counter therefore lies as its own layer OVER the band, without a mask. Counter-test: the layer removed from `ToolGroupRow.body`.
test("§5.11: the red counter of the running group row lies as its own layer over the light band", () => {
  const group = body2(swift(TOOL_ROWS), "struct ToolGroupRow", TOOL_ROWS);
  const level = body2(group, "private var counterLevel: Text?", "ToolGroupRow");
  assert.match(level, /Text\(summary\.base\)\.foregroundStyle\(\.clear\)/, "counterLevel: the sentence before the counter is not transparent");
  assert.match(level, /Text\(" " \+ counter\)\.foregroundStyle\(\.red\)/, "counterLevel: the counter is not red");
  assert.match(level, /Text\(summary\.postscript\)\.foregroundStyle\(\.clear\)/, "counterLevel: the postscript is not transparent");
  const body = body2(group, "var body: some View", "ToolGroupRow");
  const shimmer = body.indexOf(".chatShimmer(running)");
  const over = body.indexOf("counterLevel", shimmer);
  assert.ok(shimmer >= 0 && over > shimmer, "the counter layer does not lie AFTER (over) the light band");
  const overlay = body.lastIndexOf(".overlay", over);
  assert.ok(overlay > shimmer, "the counter layer is not an overlay over the band");
  assert.match(block(body, overlay, "counter overlay"), /\.accessibilityHidden\(true\)/, "the counter layer is not removed from the tree (the sentence would stand twice in the label)");
});

// ── Z15: the same step as the tool rows ──
// Counter-test: `.chatFont(.caption)` back in `RunIndicator`.
test("Z15: run indicator, metric row and group row carry .chatFont(.subheadline)", () => {
  const run = body2(swift(RUN_STATUS), "struct RunIndicator", RUN_STATUS);
  const body = body2(run, "var body: some View", "RunIndicator");
  assert.match(body, /\.chatFont\(\.subheadline\)/, "RunIndicator: the row is not in .subheadline");
  assert.ok(!/\.chatFont\(\.caption2?\)/.test(body), "RunIndicator: a .caption step is back");

  const response = body2(swift(TIMELINE_ROW), "struct AssistantMessageView", TIMELINE_ROW);
  const i = response.indexOf("if let summary = item.summary");
  assert.ok(i >= 0, "AssistantMessageView: the metric row (`if let summary = item.summary`) is missing");
  const metric = block(response, i, "metric row");
  assert.match(metric, /\.chatFont\(\.subheadline\)/, "metric row: not in .subheadline");
  assert.match(metric, /\.chatRowSymbol\(/, "metric row: the hexagon does not have the box of the run indicator (chatRowSymbol)");
  assert.match(body, /\.chatRowSymbol\(identifier: "chat-run-hex"\)/, "RunIndicator: the hexagon has no chatRowSymbol box");
  assert.match(metric, /\.chatRowSymbol\(identifier: "chat-metric-hex"\)/, "metric row: identifier chat-metric-hex missing");
  assert.match(metric, /"chat-metric-row"/, "metric row: identifier chat-metric-row missing");
  // Before the action bar, as before (and as on the web).
  assert.ok(response.indexOf("if let summary = item.summary") < response.indexOf("MessageActionsBar("),
    "AssistantMessageView: the metric row does not stand BEFORE the action bar");

  const group = body2(swift(TOOL_ROWS), "struct ToolGroupRow", TOOL_ROWS);
  assert.match(group, /rowsText\s*\n\s*\.chatFont\(\.subheadline\)/, "ToolGroupRow: rowsText is not in .subheadline");
});

// ── Z16 + F7: marker and sheet read the same state; the value is the translated word ──
// Counter-tests: `stateWord` computes by itself again (`if entry.stopped { return L("Stopped") }` …); `AgentRow` no longer reads the map.
test("Z16: the marker reads chatAgentStates, the sheet entry.state — one assignment, one computation", () => {
  const rows = swift(TOOL_ROWS);
  const marker = body2(rows, "struct AgentRow", TOOL_ROWS);
  assert.match(marker, /@Environment\(\\\.chatAgentStates\)/, "AgentRow does not read chatAgentStates");
  assert.match(marker, /HistoryState\.agentStates\[/, "AgentRow does not look the identifier up in HistoryState.agentStates");
  assert.match(marker, /HistoryState\.agent\(/, "AgentRow: the fallback without a map does not ask HistoryState.agent(");
  assert.match(marker, /inStream:\s*states != nil \? false : nil/, "AgentRow: without a map `inStream` is nil, with a map false (empty is not unknown)");
  // The map applies FIRST — only if the block is missing from it does the marker compute by itself.
  assert.ok(marker.indexOf("states[block.id]") >= 0 && marker.indexOf("states[block.id]") < marker.indexOf("HistoryState.agent("),
    "AgentRow computes before it asks the map");
  for (const old of ["statusColor", "L(\"Stopped\")", "L(\"ERROR\")", "stopped"]) {
    assert.ok(!marker.includes(old), `AgentRow: the old own chain (${old}) is back`);
  }

  const sheetFile = swift("Chat/ChatDetailSheet.swift");
  const sheet = body2(sheetFile, "struct SubagentsSheet", "ChatDetailSheet.swift");
  const word = body2(sheet, "func stateWord(", "SubagentsSheet");
  assert.match(word, /entry\.state\b/, "SubagentsSheet.stateWord does not read entry.state");
  assert.ok(!/entry\.(stopped|error|status|report)\b/.test(word), "SubagentsSheet.stateWord computes by itself again");
  // The card carries no dot but the colored state word — its color is `wordColor`, its source stays `entry.state`.
  const point = body2(sheet, "func wordColor(", "SubagentsSheet");
  assert.match(point, /entry\.state\?\.identifier/, "SubagentsSheet.wordColor does not read entry.state (the color of the word — its source is the map)");
  assert.ok(!/func pointColor\(/.test(sheet), "SubagentsSheet: the dot is back (pointColor)");
  for (const old of ["L(\"Failed\")", "L(\"Open##state\")", "L(\"Stopped\")", "L(\"Done\")"]) {
    assert.ok(!sheet.includes(old), `SubagentsSheet: the old word ${old} is back (CallEntry keeps its words)`);
  }

  const vm = swift("Chat/ChatViewModel+Subagents.swift");
  assert.match(vm, /var agentStates: \[String: String\]/, "ChatViewModel.agentStates missing");
  const card = body2(vm, "var agentStates: [String: String]", "ChatViewModel+Subagents");
  const list = body2(vm, "var subagents: [SubagentEntry]", "ChatViewModel+Subagents");
  for (const [name, r] of [["agentStates", card], ["subagents", list]]) {
    assert.match(r, /\bassignment\b/, `${name}: not via the same assignment (assignment)`);
  }
  assert.match(card, /state\(live:/, "agentStates does not compute via state(live:…)");
  for (const header of ["func entry(live: SubagentLive", "func entry(block: ChatBlock"]) {
    const r = body2(vm, header, "ChatViewModel+Subagents");
    assert.match(r, /self\.state\(live:/, `${header}: does not compute the state via state(live:…)`);
    assert.match(r, /state: state\b/, `${header}: does not pass the state to SubagentEntry`);
    assert.match(r, /running: state\?\.identifier == "running"/, `${header}: the "Running" section does not follow the state`);
  }
  const one = body2(vm, "private func state(live:", "ChatViewModel+Subagents");
  assert.match(one, /HistoryState\.agent\(/, "state(live:…) does not ask HistoryState.agent(");
  assert.match(one, /inStream:\s*live != nil/, "state(live:…): inStream is not \"stands in the stream\"");

  const stage = swift("Chat/ChatTimelineStage.swift");
  assert.match(stage, /\.environment\(\\\.chatAgentStates,\s*agentStates\)/, "ChatTimelineStage.rowView does not set chatAgentStates (per cell — the environment is not inherited)");
  assert.match(stage, /parent\?\.model\.agentStates/, "ChatTimelineStage.apply does not read model.agentStates");
  assert.match(body2(stage, "private static func liveItemId(", "ChatTimelineStage"), /HistoryState\.runningResponseId\(/,
    "liveItemId does not ask HistoryState.runningResponseId (the rule with two readers)");
  assert.match(vm, /HistoryState\.runningResponseId\(/, "ChatViewModel does not ask HistoryState.runningResponseId");
});

// ── F7: the audible value is the translated word ──
// Counter-test: `.accessibilityValue(running ? "running-id" : "")` on the group row.
test("F7: group row, marker and sheet row carry the translated word as value — the visible one is hidden", () => {
  const rows = swift(TOOL_ROWS);
  assert.match(body2(rows, "struct ToolGroupRow", TOOL_ROWS), /\.accessibilityValue\(running \? L\("running"\) : ""\)/,
    "ToolGroupRow: the value is not L(\"running\") or empty");
  assert.match(rows, /\.chatShimmer\(running\)/, "ToolGroupRow: the sentence does not carry the light effect");
  const marker = body2(rows, "struct AgentRow", TOOL_ROWS);
  assert.match(marker, /\.accessibilityValue\(z\.map \{ L\(\$0\.word\) \} \?\? ""\)/, "AgentRow: the value is not L(word) or empty");
  assert.match(body2(marker, "struct Word", "AgentRow"), /\.accessibilityHidden\(true\)/, "AgentRow: the visible word is not removed from the tree");
  const sheet = body2(swift("Chat/ChatDetailSheet.swift"), "struct SubagentsSheet", "ChatDetailSheet.swift");
  assert.match(sheet, /\.accessibilityValue\(entry\.state\.map \{ L\(\$0\.word\) \} \?\? ""\)/, "SubagentsSheet: the row does not carry the same word as value");
  // Identifiers as value ("without-result" would be read aloud as "without minus result").
  for (const rel of [TOOL_ROWS, "Chat/ChatDetailSheet.swift"]) {
    assert.ok(!/\.accessibilityValue\([^)]*(?<!L\()"(running|without-result)"/.test(swift(rel)), `${rel}: an identifier stands as value`);
  }
});
