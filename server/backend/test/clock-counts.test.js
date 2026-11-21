// Guard: a fixed number that concerns a CLOCK must not creep back into the suite.
//
// Why: full backend runs with `--test-concurrency=10` on 14 cores had 5, 1 and 2 red tests, while at 3 and 6 they
// were green every time. The suite measured how fast the machine is, not whether the product is right. Three kinds of
// numbers do that:
//
//   (1) RIPCORDS. Fake-CLI scripts carried `setTimeout(() => process.exit(9), N)` with many different numbers
//       between 8 000 and 40 000. A ripcord should turn a hang into a red line; a guessed small number instead turns
//       a slow machine into a functional failure. There is ONE concept for it now: `ripcord.mjs`. (The count is in
//       the printed measurement line, not here: it is counted on every run.)
//
//   (2) UPPER DURATION BOUNDS. A claim "that was faster than N ms" is a statement about the machine, not the product.
//       There are NONE (the list below is empty and stays so) - each former one could be proven as a count instead
//       of a time.
//
//   (3) BARE PAUSES. An `await sleep(400)` before an assertion bets that the machine is done in 400 ms - under load
//       a positive assertion after it goes red and an absence window silently green. Almost all were replaced
//       (quiet, gates, counters); what remained is named with a reason in `fixtures/pauses-allowed.json` and may only
//       SHRINK. Ticks in wait loops are allowed (rule "no timers in tests") - nothing goes red on them, they are
//       glance intervals.
//
// Explicitly NOT red is the opposite direction: `assert.ok(durationMs > 0)` or `assert.ok(Date.now() - t0 >= 15)` are
// LOWER bounds. Under load they become more true, not less - so they can never fail on utilization.
//
// Shape of the lists: `CYCLES_ALLOWED` from `import-direction.test.js` - named, with reason and follow-up, and red in
// BOTH directions (a new place is red, a list row without a place is too). The numbers stand in the printed
// measurement line, never in the test title: a number in a title ages silently.
//
// Counter-tests: a ripcord with its own number in any fake turns "ripcords: ..." red; an upper duration bound
// (`assert.ok(duration < 500)`) anywhere in the three trees turns the upper-bounds test red; a new bare
// `await sleep(N)` outside a wait loop turns the bare-pauses test red; the detection probes go red when a pattern of
// the detector is weakened.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { RIPCORD, RIPCORD_MS } from "./ripcord.mjs";
import { privatePart } from "../../../tools/check/cleanliness.mjs";

// The TypeScript parser is a RUNTIME dependency of server/backend (dynworkflows/script.js) - not a foreign package.
const ts = createRequire(import.meta.url)("typescript");

const TESTDIR = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(TESTDIR, "..", "..", "..");

// This file itself is exempt: it carries the patterns it searches for in plain text.
// `ripcord.mjs` is the one place where the number MAY stand.
const EXEMPT = new Set(["clock-counts.test.js", "ripcord.mjs"]);

const files = () =>
  fs.readdirSync(TESTDIR)
    .filter((f) => (f.endsWith(".test.js") || f.endsWith(".mjs")) && !EXEMPT.has(f))
    .sort();

// Kind (2) applies across ALL three test trees of the gate - ripcords (1) exist only here, an upper duration bound
// can stand anywhere (`sh-deadline.test.mjs` under tools/check does). The file names carry their tree as prefix so
// the key stays unambiguous.
const TREES = [
  ["", TESTDIR],
  ["web/test/", path.join(REPO, "web", "test")],
  ["tools/check/", path.join(REPO, "tools", "check")],
  ["tools/deploy/", path.join(REPO, "tools", "deploy")],
  // The maintainer's private deploy tests, where the tree carries them (a public clone has none).
  [`${path.relative(REPO, privatePart("deploy"))}/`, privatePart("deploy")],
].filter(([, dir]) => fs.existsSync(dir));
const filesAllerTrees = () =>
  TREES.flatMap(([prefix, dir]) =>
    fs.readdirSync(dir)
      .filter((f) => /\.test\.(js|mjs)$/.test(f) && !(prefix === "" && EXEMPT.has(f)))
      .sort()
      .map((f) => ({ name: prefix + f, path: path.join(dir, f) })));

// Comment lines do NOT count: a commented-out assertion is no assertion, and a guard that reads comments reports a
// place that no longer exists.
const CODE = (z) => !/^\s*(?:\/\/|\*|\/\*)/.test(z);
const read = (f) => fs.readFileSync(path.join(TESTDIR, f), "utf8").split("\n");

// ── (1) Ripcords ──────────────────────────────────────────────────────────────────────────────
// A ripcord with its own number (forbidden) against one that inserts the concept (wanted). The inserted version
// stands in the source as the placeholder of a template string - it becomes a line only when the fake is built, so
// the PLACEHOLDER is searched for here, not the line.
const RIPCORD_WITH_COUNT = new RegExp(String.raw`process\.exit\(\s*9\s*\)\s*,\s*([0-9][0-9_]*)`);
const PLACEHOLDER = "${RIPCORD}";

function ripcords() {
  const own = [];   // places with their own number
  const shared = [];  // places that insert the concept
  for (const f of files()) {
    read(f).forEach((row, i) => {
      if (!CODE(row)) return;
      const m = row.match(RIPCORD_WITH_COUNT);
      if (m) own.push({ file: f, row: i + 1, count: Number(m[1].replace(/_/g, "")) });
      else if (row.trim() === PLACEHOLDER) shared.push({ file: f, row: i + 1 });
    });
  }
  return { own, shared };
}

// ── (2) Upper duration bounds ─────────────────────────────────────────────────────────────────
// A measured duration checked UPWARD against a fixed number. The number may also stand behind a name
// (`assert.ok(duration < BARRIER_MS)`) - that is how it should be, and that is how numbers hide from a search for
// digits. A name is therefore resolved in the same file; if it cannot be resolved, THAT is the finding.
//
// The name of the duration is a HEURISTIC: an earlier version knew only `duration|elapsed|verstrichen` and missed four
// places (`total < 90_000`, `ms < 500`, twice `waited < 8_000`). The list of names is therefore broad; a hit that is
// no duration costs a list row with the reason "no duration" - cheaper than a missed one. The German names stay in
// the pattern on purpose: they match identifiers in the other test files.
const DURATION_NAMES = String.raw`\b(?:dauer|duration|elapsed|verstrichen|waited|gewartet|gesamt|laufzeit|took|ms|secs|sekunden)[\w$]*|[A-Za-z_$][\w$]*(?:Ms|MS|Dauer|Zeit|Duration|Elapsed)\b`;
const UPPER_BARRIER = new RegExp(
  String.raw`assert[^\n]*?(Date\.now\(\)\s*-\s*[A-Za-z_$][\w$]*|` + DURATION_NAMES + String.raw`)\s*<=?\s*([0-9][0-9_]*|[A-Za-z_$][\w$]*)`,
);

const countValue = (raw, rows) => {
  if (/^[0-9]/.test(raw)) return Number(raw.replace(/_/g, ""));
  const hits = rows.find((z) => new RegExp(String.raw`^\s*(?:const|let)\s+${raw}\s*=\s*[0-9][0-9_]*\s*;`).test(z));
  if (!hits) return null;
  return Number(hits.match(/=\s*([0-9][0-9_]*)/)[1].replace(/_/g, ""));
};

function upperBounds() {
  const found = [];
  for (const { name, path: filePath } of filesAllerTrees()) {
    const rows = fs.readFileSync(filePath, "utf8").split("\n");
    rows.forEach((row, i) => {
      if (!CODE(row)) return;
      const m = row.match(UPPER_BARRIER);
      if (!m) return;
      found.push({
        file: name,
        row: i + 1,
        place: m[1].replace(/\s+/g, " "),
        count: countValue(m[2], rows),
      });
    });
  }
  return found;
}

/**
 * The named list. Each row: WHERE, HOW BIG, WHY this is no measurement of the machine, and WHAT would replace it.
 * If a number grows or shrinks the test is red - the number is then a decision and must be justified, not adjusted.
 */
// EMPTY - by decision: no test measures the time of things. All former bounds could be proven without a clock
// (a count of re-checks, a step count, a pgrep on the grandchild). The shape stays so that a future exception
// COULD be named - the test below turns it red until someone consciously reverses the decision.
const UPPER_BOUNDS_ALLOWED = [];

const key = (s) => `${s.file} · ${s.place}`;

test("ripcords: every ripcord takes the ONE number from ripcord.mjs", (t) => {
  const { own, shared } = ripcords();
  t.diagnostic(`ripcords: ${shared.length} shared (${RIPCORD_MS} ms), ${own.length} with their own number`);
  if (own.length) {
    t.diagnostic(`own numbers: ${own.map((e) => `${e.file}:${e.row}=${e.count}`).join(", ")}`);
  }
  assert.deepEqual(
    own.map((e) => `${e.file}:${e.row} (${e.count} ms)`),
    [],
    "A ripcord with its own number is a disguised deadline: under load the fake dies with code 9, " +
      "and the test reports a functional failure where only the machine was slow. Insert: ${RIPCORD} from ./ripcord.mjs",
  );
  assert.ok(shared.length > 0, "not a single ripcord found - the search expression no longer matches");
});

test("ripcords: whoever inserts the ripcord imports it from ripcord.mjs", (t) => {
  const { shared } = ripcords();
  const withoutImport = [];
  for (const file of new Set(shared.map((g) => g.file))) {
    const text = read(file).join("\n");
    if (!/from "\.\/ripcord\.mjs"/.test(text)) withoutImport.push(file);
  }
  t.diagnostic(`files with a ripcord: ${new Set(shared.map((g) => g.file)).size}, without import: ${withoutImport.length}`);
  assert.deepEqual(withoutImport, [], "the line is there, but the concept comes from elsewhere");
  // The concept itself: a line that carries the number and takes the timer out of the event loop.
  assert.ok(RIPCORD.includes(String(RIPCORD_MS)), "the line does not carry the number");
  assert.ok(RIPCORD.includes(".unref()"), "without unref the ripcord keeps the fake itself alive");
  // The largest of the guessed numbers was 40 000 (fakes waiting for a limit reset). A ripcord that does not lie
  // clearly above it is a deadline again. The bound is coarse on purpose - it should catch a turn-back, not
  // prescribe a number.
  const LARGEST_GUESSED_MS = 40_000;
  t.diagnostic(`ripcord ${RIPCORD_MS} ms against the largest guessed number ${LARGEST_GUESSED_MS} ms`);
  assert.ok(
    RIPCORD_MS >= 2 * LARGEST_GUESSED_MS,
    `the ripcord (${RIPCORD_MS} ms) does not lie clearly above the largest number the suite ever needed (${LARGEST_GUESSED_MS} ms)`,
  );
});

test("upper duration bounds: none - the list is empty, and every place in the tree is red", (t) => {
  assert.equal(
    UPPER_BOUNDS_ALLOWED.length, 0,
    "no duration is checked upward - an exception needs the maintainer's decision, not just a reason",
  );
  const found = upperBounds();
  t.diagnostic(
    `upper duration bounds: ${found.length} measured, ${UPPER_BOUNDS_ALLOWED.length} named - ` +
      (found.map((g) => `${g.file}:${g.row} ${g.place} < ${g.count}`).join(" · ") || "no"),
  );
  for (const e of UPPER_BOUNDS_ALLOWED) {
    t.diagnostic(`named: ${key(e)} < ${e.count} — ${e.reason.slice(0, 120)}…`);
  }

  const allowed = new Map(UPPER_BOUNDS_ALLOWED.map((e) => [key(e), e]));
  const seen = new Map(found.map((g) => [key(g), g]));

  const fresh = found.filter((g) => !allowed.has(key(g)));
  assert.deepEqual(
    fresh.map((g) => `${g.file}:${g.row} ${g.place} < ${g.count}`),
    [],
    "New upper duration bound: either it measures the machine - then remove it - or " +
      "it checks a mechanism, then it belongs with reason and follow-up in UPPER_BOUNDS_ALLOWED.",
  );

  const withoutCause = UPPER_BOUNDS_ALLOWED.filter((e) => !seen.has(key(e)));
  assert.deepEqual(
    withoutCause.map(key),
    [],
    "A list row without a place in the tree: the bound is gone (then delete the row) " +
      "or it was renamed (then follow the row).",
  );

  const moved = found
    .filter((g) => allowed.has(key(g)) && allowed.get(key(g)).count !== g.count)
    .map((g) => `${key(g)}: ${allowed.get(key(g)).count} → ${g.count}`);
  assert.deepEqual(
    moved,
    [],
    "The number of a named bound changed. Larger means the margin was too tight - then the reason must be " +
      "rewritten. Smaller means someone is measuring the machine again.",
  );

  const unreadable = found.filter((g) => g.count === null).map((g) => `${g.file}:${g.row} ${g.place}`);
  assert.deepEqual(unreadable, [], "the bound stands behind a name that is no number in the same file - so it cannot be measured");

  for (const e of UPPER_BOUNDS_ALLOWED) {
    assert.ok(e.reason && e.reason.length > 40, `${key(e)}: no exception without a reason`);
    assert.ok(e.followUpJob && e.followUpJob.length > 20, `${key(e)}: no exception without a follow-up`);
  }
});

// ── (3) Bare pauses ───────────────────────────────────────────────────────────────────────────
// THE RULE IN ONE SENTENCE: every pause expression is counted - the call of a pause helper or a `new Promise` whose
// executor does nothing but put a `setTimeout` on its `resolve` - that does NOT stand in the body of a wait loop of
// the same function; whether it is awaited, put into a `Promise.race` or chained with `.then` makes no difference.
//
//   pause helper    a function of the same file whose only expression is such a promise or the call of another
//                   pause helper (`const sleep = (ms) => new Promise((r) => setTimeout(r, ms))`,
//                   `const short = () => sleep(5)`); plus what a file imports as such from a neighbor file, and
//                   `setTimeout` from `node:timers/promises`. Counted at the CALL, not at the definition.
//   wait loop       `while`/`do`/`for` with a condition that is no pure counter (`i < N`), or a loop with
//                   `break`/`return`/`throw` in its body - it polls for something. A counting loop without an exit is
//                   N pauses in a row and counts.
//
// Why a parser and not a line search: the fake CLIs stand as template strings IN the test files and carry the same
// words (`await sleep(${ms})`). The tree separates code from string by itself, and it sees whether a pause stands in
// a loop. It is the same parser that checks dynamic workflows (typescript, runtime package).
//
// LIMITS - what this guard does NOT count, on purpose:
//   - Pretend delays IN fake scripts (template strings, written .sh/.cjs): played latency without an assert; for the
//     parser they are text.
//   - Deadlines: a timer on `reject` (`Promise.race([run, deadline])`) and an executor that subscribes to an event
//     next to the timer ("exit or 5 s"). That is waiting for an event with a cap, not a pause; a deadline a test goes
//     red on is forbidden by the same rule, but not counted here.
//   - A wait loop with a counter cap (`i < 200 && ...`) is a hidden deadline if it is checked after.
//   - `setImmediate`, `queueMicrotask`, shell `sleep` in command strings (usually the subject under test) and
//     helpers reachable only through an object (`h.sleep()`).
// Whoever wants to move the limit extends the detection AND the probes in the test below - the probes are the path
// that breaks the promise.
const PAUSES_TREES = [
  ["server/backend/test", (f) => f.endsWith(".test.js") || f.endsWith(".mjs")],
  ["web/test", (f) => f.endsWith(".mjs")],
  ["web/test/streams", (f) => f.endsWith(".mjs")],
  ["tools/check", (f) => f.endsWith(".test.mjs")],
  ["tools/deploy", (f) => f.endsWith(".test.mjs")],
  [path.relative(REPO, privatePart("deploy")), (f) => f.endsWith(".test.mjs")],
];
const PAUSES_LIST = path.join(TESTDIR, "fixtures", "pauses-allowed.json");

const K = ts.SyntaxKind;
const FN = new Set([K.ArrowFunction, K.FunctionExpression, K.FunctionDeclaration, K.MethodDeclaration,
  K.Constructor, K.GetAccessor, K.SetAccessor]);
const LOOP = new Set([K.WhileStatement, K.DoStatement, K.ForStatement, K.ForOfStatement, K.ForInStatement]);

const core = (n) => { while (n && (ts.isParenthesizedExpression(n) || ts.isAwaitExpression(n))) n = n.expression; return n; };
const isFunction = (n) => !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));

// The one expression of a function body (`=> x`, `{ return x; }`, `{ x; }`, `{ await x; }`), else null.
function soleExpression(fn) {
  const b = fn.body;
  if (!b) return null;
  if (!ts.isBlock(b)) return core(b);
  if (b.statements.length !== 1) return null;
  const s = b.statements[0];
  if (ts.isExpressionStatement(s) || (ts.isReturnStatement(s) && s.expression)) return core(s.expression);
  return null;
}

// `setTimeout(...)`, also with an appended `.unref()`.
function timerCall(n) {
  n = core(n);
  while (n && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isCallExpression(n.expression.expression)) {
    n = n.expression.expression;
  }
  return n && ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "setTimeout" ? n : null;
}

// Does a node inside call the identifier `name`?
function callsOn(node, name) {
  let yes = false;
  const b = (n) => {
    if (yes) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) { yes = true; return; }
    ts.forEachChild(n, b);
  };
  b(node);
  return yes;
}

// A promise that RESOLVES after a duration. The executor sets exactly one timer (at most `t.unref()` besides), and
// the timer calls the FIRST argument. Returns the duration as source text or null.
function durationPromise(n) {
  if (!ts.isNewExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== "Promise") return null;
  const ex = n.arguments?.[0];
  if (!isFunction(ex) || !ex.parameters.length || !ts.isIdentifier(ex.parameters[0].name)) return null;
  const resolve = ex.parameters[0].name.text;
  const parts = ts.isBlock(ex.body) ? [...ex.body.statements] : [ex.body];
  let timer = null;
  for (const s of parts) {
    const expression = ts.isExpressionStatement(s) ? s.expression
      : ts.isVariableStatement(s) ? (s.declarationList.declarations.length === 1 ? s.declarationList.declarations[0].initializer : null)
      : ts.isBlock(ex.body) ? null : s;
    const t = expression && timerCall(expression);
    if (t) { if (timer) return null; timer = t; continue; }
    const k = expression && core(expression);
    const onlyUnref = !!k && ts.isCallExpression(k) && ts.isPropertyAccessExpression(k.expression)
      && ts.isIdentifier(k.expression.expression) && ["unref", "ref"].includes(k.expression.name.text);
    if (!onlyUnref) return null;
  }
  if (!timer || !timer.arguments.length) return null;
  const target = timer.arguments[0];
  const resolvesOn = (ts.isIdentifier(target) && target.text === resolve) || (isFunction(target) && callsOn(target.body, resolve));
  return resolvesOn ? (timer.arguments[1]?.getText() ?? "0") : null;
}

// The pause helpers of a file - defined locally or inherited - and the nodes of their definitions.
function pausesHelper(sf, inherited) {
  const helper = new Set(inherited);
  const exported = new Set();
  const definitions = new Set();
  const candidates = [];
  const collect = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && isFunction(n.initializer)) candidates.push([n.name.text, n.initializer, n]);
    else if (ts.isFunctionDeclaration(n) && n.name && n.body) candidates.push([n.name.text, n, n]);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  for (let further = true; further;) {   // until the fixed point: whoever only calls a helper is one itself
    further = false;
    for (const [name, fn, decl] of candidates) {
      const e = soleExpression(fn);
      if (!e || definitions.has(e)) continue;
      const isHelper = durationPromise(e) !== null
        || (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && helper.has(e.expression.text));
      if (!isHelper) continue;
      helper.add(name);
      definitions.add(e);
      if (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Export) exported.add(name);
      further = true;
    }
  }
  return { helper, exported, definitions };
}

// Names a file imports as pause helpers. `helperOf(specifier)` returns the exported helpers of a neighbor file (in
// the tree: parsed; in the probes: supplied).
function importedHelper(sf, helperOf) {
  const names = new Set();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !s.importClause?.namedBindings || !ts.isNamedImports(s.importClause.namedBindings)) continue;
    const from = s.moduleSpecifier.text;
    const offering = from === "node:timers/promises" || from === "timers/promises" ? new Set(["setTimeout"])
      : from.startsWith(".") ? helperOf(from) : new Set();
    for (const el of s.importClause.namedBindings.elements) {
      if (offering.has((el.propertyName || el.name).text)) names.add(el.name.text);
    }
  }
  return names;
}

// The counting loop: `for (let i = ...; i < N; ...)` - the condition is only the counter from the head.
function countLoop(l) {
  const c = l.condition && core(l.condition);
  if (!c || !ts.isBinaryExpression(c) || ![K.LessThanToken, K.LessThanEqualsToken].includes(c.operatorToken.kind)) return false;
  if (!ts.isIdentifier(c.left) || !l.initializer || !ts.isVariableDeclarationList(l.initializer)) return false;
  return l.initializer.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === c.left.text);
}
function hasOutcome(body) {
  let yes = false;
  const b = (n) => {
    if (yes || FN.has(n.kind)) return;
    if (ts.isBreakStatement(n) || ts.isReturnStatement(n) || ts.isThrowStatement(n)) { yes = true; return; }
    ts.forEachChild(n, b);
  };
  b(body);
  return yes;
}
function waitLoop(l) {
  if (ts.isWhileStatement(l) || ts.isDoStatement(l)) return l.expression.kind !== K.TrueKeyword || hasOutcome(l.statement);
  if (ts.isForStatement(l) && l.condition && !countLoop(l)) return true;
  return hasOutcome(l.statement);
}
function inTick(n) {
  for (let p = n.parent; p && !FN.has(p.kind); p = p.parent) if (LOOP.has(p.kind)) return waitLoop(p);
  return false;
}

/** The bare pauses of a source text: [{ row, duration }]. */
function barePauses(text, name, helperOf = () => new Set()) {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const { helper, definitions } = pausesHelper(sf, importedHelper(sf, helperOf));
  const places = [];
  const visits = (n) => {
    let duration = null;
    if (!definitions.has(n)) {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && helper.has(n.expression.text)) duration = n.arguments[0]?.getText(sf) ?? "default";
      else duration = durationPromise(n);
    }
    if (duration !== null && !inTick(n)) {
      places.push({ row: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, duration: duration.replace(/\s+/g, " ") });
    }
    ts.forEachChild(n, visits);
  };
  visits(sf);
  return places;
}

// Across the tree: map "repo-relative path" -> places. Imported helpers from neighbor files are parsed there.
function pausesInTree() {
  const exportsCache = new Map();
  const exportsOf = (abs) => {
    if (!exportsCache.has(abs)) {
      let names = new Set();
      if (fs.existsSync(abs)) {
        const sf = ts.createSourceFile(abs, fs.readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        names = pausesHelper(sf, new Set()).exported;
      }
      exportsCache.set(abs, names);
    }
    return exportsCache.get(abs);
  };
  const measured = new Map();
  for (const [tree, matches] of PAUSES_TREES) {
    const dir = path.join(REPO, tree);
    if (!fs.existsSync(dir)) continue;   // the private deploy tests: a public clone has none
    for (const f of fs.readdirSync(dir).filter(matches).sort()) {
      const places = barePauses(fs.readFileSync(path.join(dir, f), "utf8"), f, (from) => exportsOf(path.resolve(dir, from)));
      if (places.length) measured.set(`${tree}/${f}`, places);
    }
  }
  return measured;
}

const scanned = (file) => PAUSES_TREES.some(([tree, matches]) => path.posix.dirname(file) === tree && matches(path.posix.basename(file)));

test("bare pauses: the detection - what counts, what is a tick, what it does not see", () => {
  const SLEEP = "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n";
  const probe = (code, helperOf) => barePauses(code, "probe.js", helperOf).map((s) => s.duration);
  // Counts: the helper at the call, inline, with unref, in a race, via .then, in a callback, as a counting loop.
  assert.deepEqual(probe(SLEEP + "await sleep(50);"), ["50"], "a bare await sleep");
  assert.deepEqual(probe("await new Promise((r) => setTimeout(r, 400));"), ["400"], "inline");
  assert.deepEqual(probe("await new Promise((res) => { const t = setTimeout(() => res(), 7); t.unref(); });"), ["7"], "block with unref");
  assert.deepEqual(probe(SLEEP + "await Promise.race([run, sleep(100)]);"), ["100"], "in a race");
  assert.deepEqual(probe(SLEEP + "hook(() => sleep(10).then(() => 1));"), ["10"], "not awaited, in a callback");
  assert.deepEqual(probe(SLEEP + "for (let i = 0; i < 3; i++) await sleep(10);"), ["10"], "counting loop without an exit");
  assert.deepEqual(probe(SLEEP + "const short = () => sleep(5);\nawait short();"), ["default"], "a helper that only passes on");
  assert.deepEqual(probe("async function wait(ms) { await new Promise((r) => setTimeout(r, ms)); }\nawait wait(3);"), ["3"], "async-Helper");
  assert.deepEqual(probe('import { setTimeout as sleep } from "node:timers/promises";\nawait sleep(20);'), ["20"], "timers/promises");
  assert.deepEqual(probe('import { sleep as s } from "./h.mjs";\nawait s(9);', (v) => new Set(v === "./h.mjs" ? ["sleep"] : [])), ["9"], "imported");
  assert.deepEqual(probe('import { sleep } from "./other.mjs";\nawait sleep(9);'), [], "same name, but no pause helper");
  // Tick: in a wait loop.
  assert.deepEqual(probe(SLEEP + "while (!finished()) await sleep(25);"), [], "while with a condition");
  assert.deepEqual(probe(SLEEP + "async function f() { for (;;) { if (finished()) return; await sleep(25); } }"), [], "for(;;) with an exit");
  assert.deepEqual(probe(SLEEP + "for (let i = 0; i < 9 && !finished(); i++) await sleep(25);"), [], "counter AND condition");
  assert.deepEqual(probe(SLEEP + "for (; !done; await sleep(25)) check();"), [], "tick in the loop head");
  assert.deepEqual(probe(SLEEP + "for (const x of xs) { if (x()) break; await sleep(25); }"), [], "for-of with an exit");
  // Does not see (the limits in the header).
  assert.deepEqual(probe("const fake = `await new Promise((r) => setTimeout(r, 30));`;"), [], "template string of a fake");
  assert.deepEqual(probe(SLEEP + "// await sleep(50)\n/* await sleep(60) */"), [], "comment");
  assert.deepEqual(probe('await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("x")), 8000))]);'), [], "deadline on reject");
  assert.deepEqual(probe('await new Promise((r) => { kind.once("exit", r); setTimeout(r, 5000); });'), [], "event with a cap");
  assert.deepEqual(probe(SLEEP), [], "the definition itself");
});

test("bare pauses: only named files, and the list shrinks along", (t) => {
  const raw = JSON.parse(fs.readFileSync(PAUSES_LIST, "utf8"));
  assert.ok(Array.isArray(raw.entries), `${path.relative(REPO, PAUSES_LIST)}: field "entries" missing`);
  const list = raw.entries;
  const measured = pausesInTree();
  const sum = [...measured.values()].reduce((a, s) => a + s.length, 0);
  const named = list.reduce((a, e) => a + (Number(e.count) || 0), 0);
  // The measurement line - on EVERY run; the numbers stand here and never in the title.
  t.diagnostic(
    `bare pauses: ${sum} in ${measured.size} files, named: ${named} in ${list.length} entries - ` +
      ([...measured].map(([d, s]) => `${path.posix.basename(d)} ${s.length}`).join(" · ") || "no"),
  );
  for (const [d, s] of measured) t.diagnostic(`  ${d}: ${s.map((x) => `:${x.row} (${x.duration})`).join(", ")}`);

  const withoutReason = list.filter((e) => typeof e.reason !== "string" || e.reason.trim().length < 20).map((e) => e.file ?? "?");
  assert.deepEqual(withoutReason, [], "an entry without a reason is a silent exception - the reason comes from the code, not \"stays\"");
  const withoutCount = list.filter((e) => !Number.isInteger(e.count) || e.count < 1).map((e) => `${e.file}: ${e.count}`);
  assert.deepEqual(withoutCount, [], "the number is the count of bare pauses of the file, an integer from 1");
  const names = list.map((e) => e.file);
  assert.deepEqual(names.filter((d, i) => names.indexOf(d) !== i), [], "a file stands twice in the list");
  const missing = list.filter((e) => !fs.existsSync(path.join(REPO, String(e.file)))).map((e) => e.file);
  assert.deepEqual(missing, [], "an entry for a file that does not exist - renamed (follow) or deleted (delete the entry)");
  const foreign = list.filter((e) => !scanned(String(e.file))).map((e) => e.file);
  assert.deepEqual(foreign, [], "an entry for a file this guard does not read at all - it covered nothing");

  const allowed = new Map(list.map((e) => [e.file, e.count]));
  const places = (d) => measured.get(d).map((x) => `:${x.row} (${x.duration})`).join(", ");
  const fresh = [...measured.keys()].filter((d) => !allowed.has(d)).map((d) => `${d} ${places(d)}`);
  assert.deepEqual(
    fresh, [],
    "New bare pause: wait for the event (waitForQuiet, gate, counter seam, stream barrier) instead of the clock - " +
      "a pause before an assertion measures the machine. A tick belongs in a wait loop.",
  );
  const risen = [...measured].filter(([d, s]) => allowed.has(d) && s.length > allowed.get(d))
    .map(([d, s]) => `${d}: ${allowed.get(d)} → ${s.length} (${places(d)})`);
  assert.deepEqual(risen, [], "the number of a named file rose - the list may only shrink");
  const bringAlong = list.filter((e) => (measured.get(e.file)?.length ?? 0) < e.count)
    .map((e) => `${e.file}: named ${e.count}, measured ${measured.get(e.file)?.length ?? 0}`);
  assert.deepEqual(
    bringAlong, [],
    "Fewer pauses than named: good - let the number in the list shrink along (delete the entry at 0), " +
      "otherwise it silently covers the next new pause.",
  );
});
