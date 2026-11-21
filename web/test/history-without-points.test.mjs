// The history without dots: the calculation of the history states (src/lib/history-state.ts) and the tables Web and iOS hang
// on. Without browser and without Swift — this file also runs on the Linux runner. The run of the same calculation through
// the iOS source is done by `history-binding.test.mjs` (macOS, `xcrun swift`).
//
// What is here, per promise:
//   Z3  a row runs exactly when its turn runs and its result is missing (lib matrix)
//   Z5  the state of a subagent is ONE chain: seven stages × inStream ∈ {true, false, null}
//   Z6  the identifier and word table is the same in TS and Swift, and every word has its key in i18n-de.ts AND in the mobile
//       dictionaries — `loc-audit.sh` does not see an `L(z.word)`, it only knows literal calls
//   Z7  the run display rests in the waiting phase (all eight combinations)
// and on the source text (cut out per function, see below):
//   Z1  no dot, spinner, brain or icon column stands before any history row
//   Z2  IconCol no longer exists
//   Z3  group row, call row and single block calculate "running" via the lib and set the shimmer only via `shimmerClass`;
//       the class name stands only in lib and CSS
//   Z4  reduced motion: no band, readable text — and the base rule stands BEFORE the exception
//   Z5  marker and fallback ask `agentState`, the tone class comes from the table
//   Z19 the expanded single group shimmers once
//   Z16 the list carries `state` equal to `agentState(…)`, the bar does not calculate itself, the card runs
//       ChatPane → ChatStage → BubbleRow → AssistantBlocks; the iOS part is live
//   Z7  (source text) the display rests in the waiting phase — coding passes `waiting` in; the old `busy && !streamingText`
//       stands nowhere any more
//   Z8  ONE building block, ONE word list: markers, `STATUS_WORDS`, `verbFor`, `fmtTokens` exactly once each
//   Z9  the metric row stands BEFORE the action icons
//   Z18 one edge for every row kind: no pl-/px-/ml-/mx- on the roots
// What holds in the DOM (edge, shimmer, state word of the marker, marker = bar) is measured in a real browser
// (matrix 7, PROBE, MARKER-NEIGHBOR), the edge of EVERY row kind including metric row, reduced motion and thinking after
// text likewise — both outside the gate.
//
// Counter-tests (each turns the named test red):
//   `toolRunning` without `live`                    => row "live=false, done=false" red
//   stage 4 without `inStream === null`             => "report running, turn running, stream does not carry it" shows
//                                                      "running" instead of "without result"
//   `runDisplayVisible` without `!waiting`          => the waiting-phase rows red
//   "without result" removed from LocDEMobile.swift => the key check red
//   7 px dot back in the text branch                => Z1 red
//   `className="cb-shimmer"` hard-coded in ToolRow  => Z3 (literal outside lib/CSS) red
//   rule removed from the reduced-motion block      => Z4 red
//   base rule moved BEHIND the exception            => Z4 red (then it would win, the band would run)
//   state word with `text-accent` instead of TONE_CLASS => Z5 red
//   `shimmer={false}` removed                       => Z19 red
//   marker back to `items-center gap-0.5`           => Z20 red
//   AgentRow (iOS) with `alignment: .center`        => Z20 (iOS) red
//   `inStream: true` → `false` in agentsList        => Z16 "stream + older bubble" red
//   `sameRow` not passed to memo                    => Z16 (card runs through) red
//   `export function IconCol` created again         => Z2 red
//   `STATUS_WORDS` defined a second time            => Z8 red
//   metric row BEHIND the actions                   => Z9 red
//   `pl-2` on the root of ThinkingBlock             => Z18 red
//
// Run:  node --test web/test/history-without-points.test.mjs
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
const SOURCE_SWIFT = path.join(repo, "mobile", "CbaseMobile", "Chat", "HistoryState.swift");
const I18N_EN = path.join(webDir, "src", "lib", "i18n-de.ts");
const LOC_EN_SWIFT = ["LocDEBase.swift", "LocDEMobile.swift"].map((d) => path.join(repo, "mobile", "CbaseMobile", "Kit", d));

// Like agents.test.mjs: compile the real source with the local tsc and import it. The leaf has no import — so exactly this
// one file is compiled.
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-history-state-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "history-state.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const lib = await import(pathToFileURL(path.join(out, "history-state.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }
const {
  AGENT_STATES, TONE_CLASS, toolRunning, groupRunning, agentState, runDisplayVisible,
  shimmerClass, lastResponseIdx, runningBlockIds,
} = lib;

// ── The table ───────────────────────────────────────────────────────────────────────────────
test("The table: per identifier word, tone and pulse — only “running” pulses", () => {
  assert.deepEqual(
    Object.values(AGENT_STATES).map((z) => [z.identifier, z.word, z.tone, z.pulses]),
    [
      ["running", "running", "accent", true],
      ["stopped", "stopped", "dim", false],
      ["error", "Error", "danger", false],
      ["without-result", "no result", "dim", false],
      // The two states of the workflow agents.
      ["waiting", "waiting", "dim", false],
      ["skipped", "skipped", "dim", false],
    ],
  );
  // The key of an entry IS its identifier — otherwise a lookup by identifier (badge -> `data-agent-state`, bar) returns a foreign state.
  for (const [k, z] of Object.entries(AGENT_STATES)) assert.equal(z.identifier, k, `entry “${k}” carries the identifier “${z.identifier}”`);
  // Finished has no identifier: a finished subagent carries no word.
  assert.ok(!("finished" in AGENT_STATES), "“finished” is not a state with a word");
  assert.deepEqual(TONE_CLASS, { accent: "text-accent", dim: "text-dim", danger: "text-danger" });
  for (const z of Object.values(AGENT_STATES)) assert.ok(TONE_CLASS[z.tone], `tone “${z.tone}” has no class`);
  // Cobalt stays reserved for the word "running" — no second state in the accent.
  assert.deepEqual(Object.values(AGENT_STATES).filter((z) => z.tone === "accent").map((z) => z.identifier), ["running"]);
});

// ── Z3: tool row and group row ────────────────────────────────────────────────────────────
test("Z3: a tool row runs exactly when its turn runs and no result is there", () => {
  // live × done × error — all eight, spelled out instead of computed: the table IS the promise.
  const cases = [
    [true, false, false, true],   // the only running case
    [true, true, false, false],   // finished
    [true, false, true, false],   // error without `done` (applyToolResult sets both today)
    [true, true, true, false],    // error
    [false, false, false, false], // turn over, result never came (stop, restart): NO shimmer
    [false, true, false, false],
    [false, false, true, false],
    [false, true, true, false],
  ];
  for (const [live, done, resultIsError, desired] of cases) {
    assert.equal(toolRunning({ done, resultIsError }, live), desired, `live=${live} done=${done} error=${resultIsError}`);
  }
  // Missing fields mean "no result", not "finished".
  assert.equal(toolRunning({}, true), true);
  assert.equal(toolRunning({}, false), false);
});

test("Z3: a group row runs exactly when ONE of its calls runs — empty never runs", () => {
  const open = { done: false };
  const finished = { done: true };
  const broken = { done: true, resultIsError: true };
  assert.equal(groupRunning([], true), false, "empty group");
  assert.equal(groupRunning([], false), false, "empty group");
  assert.equal(groupRunning([finished, finished], true), false);
  assert.equal(groupRunning([finished, open], true), true, "one open in the running turn");
  assert.equal(groupRunning([open, finished, broken], true), true);
  assert.equal(groupRunning([finished, open], false), false, "one open, but the turn is over");
  assert.equal(groupRunning([broken], true), false, "an error does not run");
  assert.equal(groupRunning([{ done: false, resultIsError: true }], true), false);
});

test("Z3: the shimmer class sits only on a running row", () => {
  assert.equal(shimmerClass(true), "cb-shimmer");
  assert.equal(shimmerClass(false), "");
});

// ── Z5: the state of a subagent ─────────────────────────────────────────────────────────────
// The seven stages of the chain, each with its inputs without `inStream`, and the answer for
// inStream = true | false | null. `null` as the answer means finished (no word).
const S = (error, rawStatus, done, turnRunning) => ({ error, rawStatus, done, turnRunning });
const STAGES = [
  // Name,                                          inputs,                           true,     false,           null
  ["2a error on the block",                          S(true, "", true, false),          "running", "error",        "error"],
  ["2b report “failed”",                           S(false, "failed", true, false),   "running", "error",        "error"],
  ["3 stopped",                                      S(false, "stopped", true, false),  "running", "stopped",      "stopped"],
  ["4a report running, turn running (background)",  S(false, "running", true, true),   "running", "without-result", "running"],
  ["4b report running, turn over",                   S(false, "running", true, false),  "running", "without-result", "without-result"],
  ["5a finished with report",                        S(false, "completed", true, true), "running", null,            null],
  ["5b finished without report (native CLI task)",   S(false, "", true, false),         "running", null,            null],
  ["5c other raw status with result",                S(false, "whatever", true, false), "running", null,            null],
  ["6 without result in the running turn",           S(false, "", false, true),         "running", "running",        "running"],
  ["7 without result, turn over",                    S(false, "", false, false),        "running", "without-result", "without-result"],
  // The order of the stages, named: what applies at the same time is decided by the earlier one.
  ["error AND stopped => error",                     S(true, "stopped", true, false),   "running", "error",        "error"],
  ["error AND report running => error",              S(true, "running", true, true),    "running", "error",        "error"],
  ["error in the running turn without `done` => error", S(true, "", false, true),       "running", "error",        "error"],
  ["stopped without `done` => stopped",              S(false, "stopped", false, true),  "running", "stopped",      "stopped"],
];

test("Z5: one chain for the state of a subagent — every stage × inStream ∈ {true, false, null}", () => {
  let n = 0;
  for (const [name, e, atTrue, atFalse, atNull] of STAGES) {
    for (const [inStream, desired] of [[true, atTrue], [false, atFalse], [null, atNull]]) {
      const z = agentState({ ...e, inStream });
      assert.equal(z ? z.identifier : null, desired, `${name}, inStream=${inStream}: is ${z ? z.identifier : "finished"}, should be ${desired ?? "finished"}`);
      // The answer is ALWAYS an entry of the table — never a rebuild with its own word.
      if (z) assert.equal(z, AGENT_STATES[z.identifier], `${name}: the state does not come from AGENT_STATES`);
      n++;
    }
  }
  assert.ok(n >= 7 * 3, `${n} cases checked`);
  // The named cases — a regression then carries their name.
  assert.equal(agentState({ ...S(false, "running", true, true), inStream: false }).identifier, "without-result",
    "report running, turn running, the stream does NOT carry it: the list is known, so the turn says nothing any more");
  assert.equal(agentState({ ...S(false, "running", true, true), inStream: null }).identifier, "running",
    "without a list (fallback, dock) the running turn is the best information");
  assert.equal(agentState({ ...S(false, "", true, false), inStream: false }), null,
    "native CLI task, finished: no “without result” any more");
});

// ── Z7: the run display ─────────────────────────────────────────────────────────────────────
test("Z7: the run display shows only when the chat works, no text streams and it is not waiting", () => {
  let enabled = 0;
  for (const busy of [true, false]) for (const streamingText of [true, false]) for (const waiting of [true, false]) {
    const desired = busy && !streamingText && !waiting;
    assert.equal(runDisplayVisible({ busy, streamingText, waiting }), desired, `busy=${busy} streamingText=${streamingText} waiting=${waiting}`);
    if (desired) enabled++;
  }
  assert.equal(enabled, 1, "of eight combinations exactly one shows the display");
  assert.equal(runDisplayVisible({ busy: true, streamingText: false, waiting: true }), false, "in the waiting phase it rests");
});

// ── The running response ────────────────────────────────────────────────────────────────────
test("lastResponseIdx: the last response bubble, −1 without one", () => {
  assert.equal(lastResponseIdx([]), -1);
  assert.equal(lastResponseIdx([{ role: "user" }]), -1);
  assert.equal(lastResponseIdx([{ role: "assistant" }, { role: "user" }]), 0, "also behind a user row (web rule)");
  assert.equal(lastResponseIdx([{ role: "user" }, { role: "assistant" }, { role: "limit" }, { role: "assistant" }, { role: "ask" }]), 3);
});

test("runningBlockIds: exactly the tool blocks of the bubbles to which the history gives `live`", () => {
  const tool = (id) => ({ kind: "tool", id });
  const bubbles = [
    { role: "assistant", blocks: [tool("old-1"), { kind: "text" }] },
    { role: "user", blocks: [{ kind: "text" }] },
    { role: "assistant", streaming: true, blocks: [tool("stream-1")] },
    { role: "assistant", blocks: [tool("last-1"), { kind: "text" }, tool("last-2"), { kind: "tool" }] },
  ];
  assert.deepEqual([...runningBlockIds(bubbles, true)].sort(), ["last-1", "last-2", "stream-1"],
    "the streaming bubble and the last response while busy; a block without an id does not count");
  assert.deepEqual([...runningBlockIds(bubbles, false)], ["stream-1"], "without busy only the streaming bubble");
  assert.equal(runningBlockIds([], true).size, 0);
});

// ── Z6 (Linux part): the same table in Swift, and every word has its keys ───────────────────
// The Swift table is read as TEXT, line by line in the source's format. Whoever changes the table's form updates this
// reader — a reader that finds nothing is red, not green.
function swiftTable() {
  const source = fs.readFileSync(SOURCE_SWIFT, "utf8");
  const re = /^\s*"([^"]+)": Agent\(identifier: "([^"]+)", word: "([^"]+)", tone: \.(\w+), pulses: (true|false)\),$/gm;
  return [...source.matchAll(re)].map((m) => ({ key: m[1], identifier: m[2], word: m[3], tone: m[4], pulses: m[5] === "true" }));
}

test("Z6: the iOS table is word-for-word identical to AGENT_STATES — identifier, word, tone, pulse", () => {
  const ios = swiftTable();
  assert.equal(ios.length, Object.keys(AGENT_STATES).length,
    `HistoryState.swift has ${ios.length} entries of the form “"k": Agent(identifier: …)” — form changed? Update the reader`);
  for (const e of ios) assert.equal(e.key, e.identifier, `iOS: key “${e.key}” carries the identifier “${e.identifier}”`);
  const norm = (xs) => xs.map((z) => `${z.identifier}|${z.word}|${z.tone}|${z.pulses}`).sort();
  assert.deepEqual(norm(ios), norm(Object.values(AGENT_STATES)), "web and iOS carry different state tables");
});

test("Z6: every state word has a key in i18n-de.ts AND in LocDE*.swift", () => {
  const web = fs.readFileSync(I18N_EN, "utf8");
  const ios = LOC_EN_SWIFT.map((d) => fs.readFileSync(d, "utf8")).join("\n");
  const has = (source, k) => new RegExp(`^\\s*"${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`, "m").test(source);
  const missing = [];
  for (const z of Object.values(AGENT_STATES)) {
    if (!has(web, z.word)) missing.push(`i18n-de.ts: “${z.word}”`);
    if (!has(ios, z.word)) missing.push(`LocDE*.swift: “${z.word}”`);
  }
  // The metric row on iOS: it calls it as a literal, then loc-audit.sh checks it itself. It stands here because the key must
  // be there BEFORE.
  if (!has(ios, "Done after {dur}")) missing.push("LocDE*.swift: “Done after {dur}”");
  assert.deepEqual(missing, [], "the German version would show English text here:\n  " + missing.join("\n  "));
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// The history rows themselves (AssistantBlocks.tsx) and the shimmer (globals.css)
// ════════════════════════════════════════════════════════════════════════════════════════════
// Source text is cut out PER FUNCTION, not per file: the checkmarks of the todo list and of the native task bar are content
// and rightly carry `rounded-full` — a file comparison would take them for a dot before a row.
const SOURCE_BLOCKS = path.join(webDir, "src", "components", "AssistantBlocks.tsx");
const SOURCE_CSS = path.join(webDir, "src", "app", "globals.css");
const blocks = () => fs.readFileSync(SOURCE_BLOCKS, "utf8");

// A component of the form `const X = memo(function X(` or `function X(` up to the first line that closes in column 0
// (`});` or `}`). Whoever changes the form updates the anchor — an anchor that finds nothing is red.
function fn(source, name) {
  const rows = source.split("\n");
  const start = rows.findIndex((z) =>
    new RegExp(`^(export )?const ${name} = memo\\(function ${name}\\(`).test(z) || new RegExp(`^function ${name}\\(`).test(z));
  assert.ok(start >= 0, `“${name}” is no longer in AssistantBlocks.tsx — renamed? Update the anchor, do not delete the test`);
  const end = rows.findIndex((z, i) => i > start && (z === "});" || z === "}"));
  assert.ok(end > start, `the end of “${name}” is not in column 0`);
  return rows.slice(start, end + 1).join("\n");
}
// A branch inside a body: from the anchor to the first line that ends with exactly `inset` + `}` (the closing block on the
// same indentation level).
function branch(body, anchor, inset) {
  const rows = body.split("\n");
  const start = rows.findIndex((z) => z.includes(anchor));
  assert.ok(start >= 0, `anchor “${anchor}” is missing`);
  const end = rows.findIndex((z, i) => i > start && z === `${inset}}`);
  assert.ok(end > start, `the end of the branch “${anchor}” is missing`);
  return { text: rows.slice(start, end + 1).join("\n"), rest: [...rows.slice(0, start), ...rows.slice(end + 1)].join("\n") };
}
const ROWS_FUNCTIONS = ["ThinkingBlock", "AgentWord", "ToolBlock", "ToolRow", "ToolGroup", "AssistantBlocks"];

test("Z1: no dot, no spinner, no brain, no icon column before a history row", () => {
  const q = blocks();
  const violations = [];
  for (const name of ROWS_FUNCTIONS) {
    const body = fn(q, name);
    for (const [pattern, what] of [
      [/rounded-full/, "rounded-full (a dot)"],
      [/<Spinner\b/, "<Spinner"],
      [/\bBrainDot\b/, "BrainDot"],
      [/h-\[7px\]/, "h-[7px] (the 7 px dot)"],
      [/\bIconCol\b/, "IconCol (the column that indents the text by 17 px)"],
    ]) if (pattern.test(body)) violations.push(`${name}: ${what}`);
  }
  assert.ok(!/import \{[^}]*\bSpinner\b/.test(q), "AssistantBlocks imports Spinner — a dead import falls through silently without noUnusedLocals");
  assert.ok(!/\bBrainDot\b/.test(q), "BrainDot is still in the file");
  assert.deepEqual(violations, [], "a character stands before a history row again:\n  " + violations.join("\n  "));
  // The new markers the DOM test benches measure.
  assert.match(fn(q, "AssistantBlocks"), /data-text-block/, "the text branch carries data-text-block");
  assert.match(fn(q, "AssistantBlocks"), /data-error-block/, "the error branch carries data-error-block");
  assert.ok(!/data-text-point/.test(q), "data-text-point is gone");
  assert.ok(!/data-tool-spinner/.test(q), "data-tool-spinner is gone");
  assert.match(fn(q, "ThinkingBlock"), /data-thinking-block/, "the thinking block carries data-thinking-block");
});

test("Z2: IconCol no longer exists — no occurrence in web/src, not even in comments", () => {
  const hits = [];
  const run = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) run(p);
      else if (/\.(ts|tsx|css)$/.test(e.name) && /\bIconCol\b/.test(fs.readFileSync(p, "utf8"))) hits.push(path.relative(webDir, p));
    }
  };
  run(path.join(webDir, "src"));
  assert.deepEqual(hits, [], "IconCol is still in: " + hits.join(", "));
});

test("Z3: group row, call row and single block ask the ONE calculation and set the effect only via shimmerClass", () => {
  const q = blocks();
  const group = fn(q, "ToolGroup");
  const row = fn(q, "ToolRow");
  const block = fn(q, "ToolBlock");
  assert.match(group, /groupRunning\(blocks, live\)/, "ToolGroup calculates `running` via groupRunning");
  assert.match(row, /toolRunning\(block, live\)/, "ToolRow calculates `running` via toolRunning");
  assert.match(block, /toolRunning\(block, live\)/, "ToolBlock calculates `running` via toolRunning");
  for (const [name, body] of [["ToolGroup", group], ["ToolRow", row], ["ToolBlock", block]]) {
    assert.match(body, /shimmerClass\(/, `${name} calls shimmerClass(`);
    assert.match(body, /data-shimmer=\{/, `${name} sets data-shimmer (the marker of the test benches)`);
    // No chain of its own next to the lib: the old condition stood as `live && …` in the body.
    assert.ok(!/\blive && (!block\.done|blocks\.some)/.test(body), `${name} calculates “running” itself again`);
  }
  assert.match(group, /aria-busy=\{running \|\| undefined\}/, "the group row tells screen readers that it is working");
  // The class name stands only in the lib and in the CSS — otherwise someone sets the effect past the calculation.
  const hits = [];
  const run = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) run(p);
      else if (/\.(ts|tsx|css)$/.test(e.name) && fs.readFileSync(p, "utf8").includes("cb-shimmer")) hits.push(path.relative(webDir, p).split(path.sep).join("/"));
    }
  };
  run(path.join(webDir, "src"));
  assert.deepEqual(hits.sort(), ["src/app/globals.css", "src/lib/history-state.ts"], "“cb-shimmer” is outside lib and CSS");
});

test("Z4: reduced motion — no band, readable text; the effect is unlayered and stands BEFORE its exception", () => {
  const css = fs.readFileSync(SOURCE_CSS, "utf8");
  // Blocks by brace counting, not by regex: a `}` in a comment is not in these blocks.
  const blocksOf = (header) => {
    const out = [];
    let i = 0;
    while ((i = css.indexOf(header, i)) >= 0) {
      const on = css.indexOf("{", i);
      let depth = 0, j = on;
      for (; j < css.length; j++) { if (css[j] === "{") depth++; else if (css[j] === "}" && --depth === 0) break; }
      out.push({ at: i, text: css.slice(on + 1, j) });
      i = j;
    }
    return out;
  };
  const rule = (text, sel) => {
    const m = text.match(new RegExp(`(^|\\n)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    return m ? m[2] : null;
  };
  const quiet = blocksOf("@media (prefers-reduced-motion: reduce)").find((b) => rule(b.text, ".cb-shimmer") !== null);
  assert.ok(quiet, "in the block `prefers-reduced-motion: reduce` there is no rule for .cb-shimmer");
  const r = rule(quiet.text, ".cb-shimmer");
  assert.match(r, /animation:\s*none/, "reduced motion: the animation stops");
  assert.match(r, /background:\s*none/, "reduced motion: the band is gone (otherwise a half-lit, frozen sentence would stand)");
  assert.match(r, /color:\s*var\(--color-fg\)/, "reduced motion: the text is readable (fg instead of transparent)");

  // The base rule: unlayered (utilities live in @layer utilities and would otherwise not lose),
  // and BEFORE the reduced-motion block — equal specificity, the later rule wins.
  const base = css.search(/\n\.cb-shimmer \{/);
  assert.ok(base >= 0, "the base rule .cb-shimmer is not in column 0");
  assert.ok(base < quiet.at, "the base rule stands BEHIND its reduced-motion exception — then it wins, and the band would keep running");
  // Unlayered means: at top level, in no @layer (and no @media) block. The braces BEFORE the rule are counted, comments
  // removed (they mention `@layer utilities`).
  const beforehand = css.slice(0, base).replace(/\/\*[^]*?\*\//g, "");
  const depth = [...beforehand].reduce((n, c) => n + (c === "{" ? 1 : c === "}" ? -1 : 0), 0);
  assert.equal(depth, 0, "the base rule is in a block (@layer/@media) instead of at top level");
  const b = rule(css.slice(base), ".cb-shimmer");
  assert.match(b, /color:\s*transparent/);
  assert.match(b, /background-clip:\s*text/);
  assert.match(b, /-webkit-background-clip:\s*text/, "Chrome/Safari need the prefix");
  assert.match(b, /animation:\s*cb-shimmer\b/);
  // Base and band are tokens (light and dark): base `--color-tool` (dark wins text-tool), band `--color-fg` — NO cobalt.
  assert.match(b, /linear-gradient\([^)]*var\(--color-tool\)[^)]*var\(--color-fg\)[^)]*var\(--color-tool\)/, "base --color-tool, band --color-fg");
  assert.ok(!/accent/.test(b), "the light band carries no accent");
  assert.ok(blocksOf("@keyframes cb-shimmer").length === 1, "@keyframes cb-shimmer exactly once");
  const forced = blocksOf("@media (forced-colors: active)").find((x) => rule(x.text, ".cb-shimmer") !== null);
  assert.ok(forced && /color:\s*CanvasText/.test(rule(forced.text, ".cb-shimmer")), "forced-colors: the sentence stays readable in the system colour");
});

test("Z5: state word instead of dot — the marker and the fallback ask the same chain", () => {
  const q = blocks();
  assert.ok(!/markerPoint/.test(q), "markerPoint is gone");
  const block = fn(q, "ToolBlock");
  const { text: marker, rest: fallback } = branch(block, "if (agentData && onAgentOpen && block.id) {", "  ");
  assert.match(marker, /agentState\(/, "the marker asks agentState");
  assert.match(fallback, /agentState\(/, "the fallback (dock) asks agentState");
  // The marker reads the card BEFORE it calculates itself — otherwise it would contradict the bar.
  assert.ok(marker.indexOf("states?.has(id)") >= 0 && marker.indexOf("states?.has(id)") < marker.indexOf("agentState("),
    "the marker reads `states` before it calculates itself");
  assert.match(marker, /inStream: states \? false : null/, "card known, block not in it => inStream false; no card => null");
  assert.match(fallback, /inStream: null/, "the fallback knows no list");
  assert.match(marker, /data-agent-state=\{z\?\.identifier \?\? "finished"\}/, "the marker carries data-agent-state (finished without a word)");
  // Tone only from the table: the word has no colour class of its own.
  const word = fn(q, "AgentWord");
  assert.match(word, /data-agent-word/);
  assert.match(word, /TONE_CLASS\[z\.tone\]/, "the tone class comes from TONE_CLASS");
  assert.ok(!/text-(accent|dim|danger)\b/.test(word), "the state word carries a colour class of its own next to the table");
  assert.match(word, /motion-reduce:animate-none/, "the pulse stands under reduced motion");
  assert.match(word, /t\(z\.word\)/, "the word is translated (the English words are the keys)");
  // The two old single words on the marker have merged into this one.
  assert.ok(!/t\("stopped"\)/.test(marker), "the old single word “stopped” is still on the marker");
});

// Z20: the marker's typesetting. With `items-center` the word (10.5 px) sat 2.8 px above the row's baseline (15.5 px), stuck
// to the task and the arrow with `gap-0.5`, and the space before the dot vanished at the start of the flex child
// ("Subagent·"). The source text is the guard here — no test bench of the gate renders the marker.
test("Z20: the marker puts the word on the baseline, with a fixed gap before the arrow — and keeps the space before the dot", () => {
  const { text: marker } = branch(fn(blocks(), "ToolBlock"), "if (agentData && onAgentOpen && block.id) {", "  ");
  const button = /<button[\s\S]*?className="([^"]*)"\s*>/.exec(marker)?.[1] ?? "";
  assert.match(button, /\bitems-baseline\b/, "the marker aligns its parts on the baseline");
  assert.doesNotMatch(button, /\bitems-center\b/, "centered, the smaller word sits above the baseline");
  assert.doesNotMatch(button, /\bgap-/, "the gap sits on the word and on the arrow, not as a shared gap");
  assert.match(marker, /<AgentWord z=\{z\} className="ml-\d/, "the word carries a fixed gap after the task");
  const arrow = /<span className="([^"]*)"><Chevron open=\{false\} \/><\/span>/.exec(marker)?.[1] ?? "";
  assert.match(arrow, /\bml-[\d.]+\b/, "the arrow carries a fixed gap after the word");
  assert.match(arrow, /\bself-center\b/, "the arrow is not text — it sits in the middle, not on the baseline");
  assert.doesNotMatch(marker, /className="min-w-0 truncate"> /, "an ordinary space at the start of the task would vanish");
  assert.match(marker, /\{"\\u00a0· "\}/, "a fixed space stands before the dot");
  assert.match(fn(blocks(), "AgentWord"), /\$\{className\}/, "AgentWord accepts the marker's gap");
});

// Z20 (iOS): the same three promises on `AgentRow` — they already held there (bottom edge of the letters in the same pixel
// row, arrow 8.7 pt behind the word, left edge flush with the answer and the run display). The guard holds the state;
// counter-test as sabotage: `.firstTextBaseline` → `.center` => red.
test("Z20 (iOS): AgentRow aligns on the first baseline, the word stands with a fixed gap before the arrow", () => {
  const q = fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", "Chat", "ChatToolRows.swift"), "utf8");
  const a = q.indexOf("private struct AgentRow");
  const row = q.slice(a, q.indexOf("private struct Word", a));
  assert.ok(a >= 0 && row.length > 0, "AgentRow (up to its Word) is no longer in ChatToolRows.swift — update the anchor");
  assert.match(row, /HStack\(alignment: \.firstTextBaseline, spacing: [1-9]\d*\)/, "the marker aligns on the first baseline, with a fixed gap");
  const word = row.indexOf("Word(state: z)");
  const arrow = row.indexOf('Image(systemName: "chevron.right")');
  assert.ok(word > 0 && arrow > word, "the state word stands before the arrow");
  assert.ok(!/Spacer/.test(row.slice(word, arrow)), "a Spacer stands between word and arrow — the gap would no longer be fixed");
});

test("Z19: an expanded SINGLE group shimmers once — the call below does not shimmer with it", () => {
  const group = fn(blocks(), "ToolGroup");
  const i = group.indexOf("{open && individual && (");
  assert.ok(i >= 0, "the branch `open && individual` is missing in ToolGroup");
  const end = group.indexOf(")}", i);
  const single = group.slice(i, end);
  assert.match(single, /<ToolBlock\b[^>]*shimmer=\{false\}/, "ToolGroup passes shimmer={false} to the expanded single call");
  // And in the area of SEVERAL calls the running row shimmers — there it says which one runs.
  assert.ok(!/<ToolRow\b[^>]*shimmer=/.test(group), "the rows of the area shimmer themselves (no switch-off there)");
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// ONE calculation for the state of a subagent
// ════════════════════════════════════════════════════════════════════════════════════════════
// The list (lib/agents.ts) calculates the state per agent ONCE; the bar reads it there, the marker in the history via the
// card `agentStates`. Here: the lib side and the source-text side. The DOM proof (marker = bar, also on the older bubble)
// is run by hand in a real browser.
const SOURCE_BAR = path.join(webDir, "src", "components", "AgentBar.tsx");
const component = (...parts) => fs.readFileSync(path.join(webDir, "src", "components", ...parts), "utf8");

// agents.ts imports history-state.js — tsc compiles both into the same folder.
const outAgents = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-history-agents-"));
execFileSync(process.execPath, [
  tsc, path.join(webDir, "src", "lib", "agents.ts"),
  "--outDir", outAgents, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const { agentsList } = await import(pathToFileURL(path.join(outAgents, "agents.js")).href);
try { fs.rmSync(outAgents, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

test("Z16: every entry of the list carries `state` equal to `agentState(…)` — also stream + older bubble", () => {
  const b = (o) => ({ kind: "tool", name: "Task", input: { description: "x" }, done: true, ...o });
  const run = JSON.stringify({ status: "running" });
  // [name, live, blocks, running, expected chain inputs per entry]
  const cases = [
    // The case where marker and bar diverged: the call sits in an OLDER bubble (not in `running`), the stream carries it —
    // running.
    ["stream + block of an older bubble", [{ taskId: "tu-1", description: "bg" }], [b({ id: "tu-1", result: run })], new Set(),
      [{ error: false, rawStatus: "running", done: true, inStream: true, turnRunning: false }], ["running"]],
    ["background, no longer carried by the stream, turn running", [], [b({ id: "tu-2", result: run })], new Set(["tu-2"]),
      [{ error: false, rawStatus: "running", done: true, inStream: false, turnRunning: true }], ["without-result"]],
    ["native task in the running turn", [], [b({ id: "tu-3", done: false })], new Set(["tu-3"]),
      [{ error: false, rawStatus: "", done: false, inStream: false, turnRunning: true }], ["running"]],
    ["native task finished", [], [b({ id: "tu-4", result: "ok" })], new Set(),
      [{ error: false, rawStatus: "", done: true, inStream: false, turnRunning: false }], ["finished"]],
    ["error without report", [], [b({ id: "tu-5", result: "x", resultIsError: true })], new Set(),
      [{ error: true, rawStatus: "", done: true, inStream: false, turnRunning: false }], ["error"]],
    ["stopped", [], [b({ id: "tu-6", result: JSON.stringify({ status: "stopped" }) })], new Set(),
      [{ error: false, rawStatus: "stopped", done: true, inStream: false, turnRunning: false }], ["stopped"]],
    ["other raw status with result", [], [b({ id: "tu-7", result: JSON.stringify({ status: "timeout" }) })], new Set(),
      [{ error: false, rawStatus: "timeout", done: true, inStream: false, turnRunning: false }], ["finished"]],
    ["without result after the run", [], [b({ id: "tu-8", done: false })], new Set(),
      [{ error: false, rawStatus: "", done: false, inStream: false, turnRunning: false }], ["without-result"]],
  ];
  for (const [name, live, blocksList, running, inputs, identifiers] of cases) {
    const list = agentsList(live, blocksList, running);
    assert.equal(list.length, inputs.length, `${name}: number of entries`);
    list.forEach((a, i) => {
      assert.deepEqual(a.state, agentState(inputs[i]), `${name}: state ≠ agentState(${JSON.stringify(inputs[i])})`);
      assert.equal(a.state?.identifier ?? "finished", identifiers[i], `${name}: identifier`);
    });
  }
});

test("Z16: the bar does not calculate itself — word and colour from `state` and TONE_CLASS", () => {
  const q = fs.readFileSync(SOURCE_BAR, "utf8");
  assert.ok(!/\brawStatus\b/.test(q), "AgentBar reads rawStatus — the chain belongs in lib/agents.ts");
  assert.ok(!/"[Ff]ailed"/.test(q), "the word “failed” is gone (another raw status with result is finished)");
  assert.ok(!/\bstate\(/.test(q), "the own calculation `state(` is gone");
  assert.match(q, /\.state\b/, "the bar reads Agent.state");
  assert.match(q, /TONE_CLASS\[/, "the colour comes from TONE_CLASS");
  assert.match(q, /data-agents-state=\{/, "the row carries data-agents-state (the DOM comparison in run.mjs measures it)");
  assert.ok(!/\bIconCol\b/.test(q), "the bar does not need IconCol — its card carries the coloured word instead of a dot");
});

test("Z16: the card runs through — ChatPane → ChatStage → BubbleRow → AssistantBlocks", () => {
  // List and card are calculated in the background hook (chat/chatBackground.ts) — the four patterns therefore read the hook,
  // and the view must call it with ITS history and ITS busy (otherwise the card would ask a foreign run).
  const hook = component("chat", "chatBackground.ts");
  assert.match(hook, /runningBlockIds\(bubbles, busy\)/, "the hook asks runningBlockIds — the same question as `live` in the history");
  assert.match(hook, /agentsList<Block>\(waitAgents, agentBlocks, runningBlocks\)/, "the hook passes `running` to the list");
  assert.match(hook, /stateCard\(/, "the hook builds the card from the list");
  assert.match(hook, /\[stateKey\]/, "the card is memoised via the content key");
  const pane = component("chat", "ChatPane.tsx");
  assert.match(pane, /^  const \{[^}\n]*\bagentStates\b[^}\n]*\} = useBackground\(bubbles, busy\);$/m, "ChatPane takes the card from the hook, with its history and its busy");
  assert.match(pane, /agentStates=\{agentStates\}/, "ChatPane passes agentStates to ChatStage");
  const stage = component("chat", "ChatStage.tsx");
  assert.match(stage, /^\s{2}agentStates: ReadonlyMap<string, AgentState \| null>;/m, "ChatStage: required prop agentStates");
  assert.match(stage, /<BubbleRow[\s\S]*?agentStates=\{agentStates\}[\s\S]*?\/>/, "ChatStage passes them on to BubbleRow");
  const row = component("chat", "ChatBubbleRow.tsx");
  assert.match(row, /<AssistantBlocks[^>]*agentStates=\{agentStates\}/, "BubbleRow passes them on to AssistantBlocks");
  assert.match(row, /bubblesKey\(a\.b\.blocks, a\.agentStates\) === bubblesKey\(b\.b\.blocks, b\.agentStates\)/,
    "BubbleRow compares only its own part of the card — otherwise every state change redraws every row");
  assert.match(row, /\}, sameRow\);/, "the comparison is passed to memo");
});

test("Z16 (iOS): the sheet reads `entry.state`, the marker `chatAgentStates`", () => {
  const sheet = fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", "Chat", "ChatDetailSheet.swift"), "utf8");
  const i = sheet.indexOf("func stateWord(");
  assert.ok(i >= 0, "stateWord missing in ChatDetailSheet.swift");
  assert.match(sheet.slice(i, sheet.indexOf("\n    }", i)), /entry\.state\b/, "stateWord reads entry.state");
  const rows = fs.readdirSync(path.join(repo, "mobile", "CbaseMobile", "Chat")).filter((d) => d.endsWith(".swift"))
    .map((d) => fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", "Chat", d), "utf8"));
  assert.ok(rows.some((q) => /struct AgentRow\b/.test(q) && /chatAgentStates/.test(q)), "AgentRow reads chatAgentStates");
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// ONE building block for the run display and the metric row (chat/RunDisplay.tsx)
// ════════════════════════════════════════════════════════════════════════════════════════════
// The name dates from the time of the three wrappers; only the coding chat remains.
const THREE = {
  coding: path.join("chat", "ChatStage.tsx"),
};
const sourceOf = (rel) => fs.readFileSync(path.join(webDir, "src", "components", rel), "utf8");
// All *.ts/*.tsx/*.css under web/src — for the "exactly once" counts.
function webSources() {
  const out = [];
  const run = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) run(p);
      else if (/\.(ts|tsx|css)$/.test(e.name)) out.push([path.relative(path.join(webDir, "src"), p), fs.readFileSync(p, "utf8")]);
    }
  };
  run(path.join(webDir, "src"));
  return out;
}
// An element in the source text, from `<Name` to the closing `/>` — the props of a call.
function call(source, name) {
  const i = source.indexOf(`<${name}`);
  assert.ok(i >= 0, `<${name} is missing`);
  const end = source.indexOf("/>", i);
  assert.ok(end > i, `<${name} … /> is not closed`);
  return { text: source.slice(i, end + 2), start: i };
}
// A branch in `onEvent` (or a function): from the anchor line to the first line that starts with "}" at the SAME
// indentation (the next `} else if` or the end of the function).
function block(source, anchor) {
  const rows = source.split("\n");
  const start = rows.findIndex((z) => z.includes(anchor));
  assert.ok(start >= 0, `anchor “${anchor}” is missing`);
  const inset = rows[start].match(/^\s*/)[0].length;
  const end = rows.findIndex((z, i) => i > start && z.match(/^\s*/)[0].length === inset && z.trim().startsWith("}"));
  assert.ok(end > start, `the end of “${anchor}” is missing`);
  return rows.slice(start, end).join("\n");
}

test("Z7 (source text): the display rests in the waiting phase — coding passes `waiting` in", () => {
  for (const [who, rel] of Object.entries(THREE)) {
    const q = sourceOf(rel);
    assert.ok(!q.includes("busy && !streamingText"), `${who}: the old condition \`busy && !streamingText\` is still in ${rel}`);
    const { text: a } = call(q, "RunDisplay");
    assert.match(a, /waiting=\{waiting\}/, `${who}: passes waiting={waiting} — otherwise the display would show in the waiting phase`);
    assert.match(a, /busy=\{busy\}/, `${who}: busy`);
    assert.match(a, /streamingText=\{streamingText\}/, `${who}: streamingText`);
  }
  // The building block itself asks the lib — and nothing else. The row also shows WITHOUT running work when tasks run
  // (resting logo + pill — it says in the waiting phase what is waited for). Whether the WORK runs is still decided by
  // `runDisplayVisible`; which parts show, by `rowsParts` (lib/running-tasks.ts, bound to iOS).
  const buildingBlock = sourceOf(path.join("chat", "RunDisplay.tsx"));
  assert.match(buildingBlock, /const running = runDisplayVisible\(p\);/, "RunDisplay decides via runDisplayVisible whether the work runs");
  assert.match(buildingBlock, /const parts = rowsParts\(\{ running, /, "rowsParts calculates the parts of the row from `running`");
  assert.match(buildingBlock, /if \(parts\.length === 0\) return null;/, "without work and without tasks no row");
  assert.match(buildingBlock, /^\s{2}waiting: boolean;/m, "waiting is required (no `?`) — whoever omits it gets a type error");
});

test("Z8: ONE building block, ONE word list — every marker and every definition exactly once", () => {
  const all = webSources();
  const location = (re) => all.flatMap(([rel, q]) => (q.match(re) || []).map(() => rel));
  for (const [re, name] of [
    [/data-run-hex\b/g, "data-run-hex"],
    [/data-metric-row\b/g, "data-metric-row"],
    [/\bconst STATUS_WORDS\b/g, "const STATUS_WORDS"],
    [/\bconst verbFor\b/g, "const verbFor"],
  ]) {
    const hits = location(re);
    assert.equal(hits.length, 1, `${name} appears ${hits.length}× on the web: ${hits.join(", ")}`);
  }
  assert.deepEqual(location(/\bdata-run-hex\b/g), [path.join("components", "chat", "RunDisplay.tsx")], "the marker sits in the building block");
  // fmtTokens: two DEFINITIONS with two formats — the chat format ("1 M") and the bar's ("1.2k").
  assert.deepEqual([...new Set(location(/\b(?:const|function) fmtTokens\b/g))].sort(),
    [path.join("components", "chat", "ChatCatalog.tsx"), path.join("lib", "agents.ts")].sort(),
    "fmtTokens is defined exactly in ChatCatalog (chat) and lib/agents (bar)");
  for (const [who, rel] of Object.entries(THREE)) {
    const q = sourceOf(rel);
    assert.ok(q.includes("<RunDisplay"), `${who}: <RunDisplay is missing in ${rel}`);
    assert.ok(!q.includes("for (let i = bubbles.length - 1"), `${who}: the own loop instead of lastResponseIdx is still in ${rel}`);
  }
  for (const rel of [path.join("chat", "ChatBubbleRow.tsx")]) {
    assert.ok(sourceOf(rel).includes("<MetricRow"), `<MetricRow is missing in ${rel}`);
  }
});

test("Z9: the metric row stands BEFORE the action icons — in the coding chat", () => {
  const row = sourceOf(path.join("chat", "ChatBubbleRow.tsx"));
  const k = row.indexOf("<MetricRow");
  const a = row.indexOf("actions(false)", row.indexOf("<AssistantBlocks"));
  assert.ok(k > 0 && a > 0 && k < a, "coding: <MetricRow before actions(false) in the assistant branch");
});

test("Z18: one edge for every row kind — no pl-/px-/ml-/mx- on the roots", () => {
  const padding = /(?:^|[\s"'`])-?(?:pl|px|ml|mx)-[\w[.]/;
  const violations = [];
  const q = blocks();
  for (const name of ["ThinkingBlock", "ToolGroup", "ToolBlock"]) {
    const rows = fn(q, name).split("\n");
    let n = 0;
    rows.forEach((z, i) => {
      if (z.trim() !== "return (") return;
      n++;
      if (padding.test(rows[i + 1])) violations.push(`${name}: ${rows[i + 1].trim()}`);
    });
    assert.ok(n > 0, `${name}: no root found — form changed? Update the anchor`);
  }
  const rowWith = (source, marker, location) => {
    const z = source.split("\n").filter((x) => x.includes(marker));
    assert.ok(z.length > 0, `${location}: ${marker} is missing`);
    return z;
  };
  for (const z of [...rowWith(q, "data-text-block", "text branch"), ...rowWith(q, "data-error-block", "error branch")]) {
    if (padding.test(z)) violations.push(`AssistantBlocks: ${z.trim()}`);
  }
  for (const z of rowWith(sourceOf("LimitStrip.tsx"), "data-limit-row=", "LimitRow")) {
    if (padding.test(z)) violations.push(`LimitRow: ${z.trim()}`);
  }
  const events = rowWith(sourceOf(path.join("chat", "ChatBubbleRow.tsx")), "data-event=", "event rows");
  assert.deepEqual([...new Set(events.map((z) => /data-event="(\w+)"/.exec(z)?.[1]))].sort(), ["monitor", "target", "trigger", "workflow"],
    "the four event rows carry data-event (target · workflow · trigger · monitor)");
  for (const z of events) if (padding.test(z)) violations.push(`event row: ${z.trim()}`);
  assert.deepEqual(violations, [], "a row carries a padding of its own again:\n  " + violations.join("\n  "));
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// Tool start: the run display comes back at the START of a call
// ════════════════════════════════════════════════════════════════════════════════════════════
// The display shows only when no answer text streams (`runDisplayVisible`). A text_delta switches it off in every wrapper;
// with the loop engine it came back only with the finished call AFTER the round. The engine therefore reports the start as
// `content_block_start`/tool_use (server/backend/test/engine-harness.test.js "tool start") — and THIS test pins that every
// wrapper translates it into `streamingText = false`: the wrapper's own branch is read, the sequence text_delta →
// content_block_start runs through the rule that stands there, and then through `runDisplayVisible`.
// Counter-test: `if (!parentId) setStreamingText(false);` removed in the content_block_start branch => "wrapper: after the
// tool start …" red.
test("Tool start: after text_delta → content_block_start/tool_use the run display shows again — in the coding chat's wrapper", () => {
  const WRAPPERS = { coding: path.join("chat", "ChatPane.tsx") };
  // What the branch does with the flag — only in the main stream (a subagent streams under its call); null: it leaves it.
  const rule = (q, anchor) => {
    const m = block(q, anchor).match(/if \(!parentId\) setStreamingText\((true|false)\);/);
    return m ? m[1] === "true" : null;
  };
  for (const [who, rel] of Object.entries(WRAPPERS)) {
    const q = sourceOf(rel);
    const text = rule(q, `ev.type === "content_block_delta" && ev.delta?.type === "text_delta"`);
    const start = rule(q, `ev.type === "content_block_start" && ev.content_block?.type === "tool_use"`);
    assert.equal(text, true, `${who}: text_delta no longer switches the display off — then this test checks nothing`);
    let streamingText = false; // run_started
    streamingText = text ?? streamingText;
    assert.equal(runDisplayVisible({ busy: true, streamingText, waiting: false }), false, `${who}: while text streams, it rests`);
    streamingText = start ?? streamingText;
    assert.equal(runDisplayVisible({ busy: true, streamingText, waiting: false }), true, `${who}: after the tool start the run display does not show again`);
  }
});
