// The instance choice of the Code tab. web/src/lib/code-instance.ts is compiled with tsc and EXECUTED; plus the contract of the UI,
// read by path: every route of the code view carries the choice (CodePane via `calls`/`filePath`, terminal, search, download, git
// column), the page mounts the area.
//
// The promises, each with the way that breaks it:
//   (a) no choice without conversion or without a ready copy: no parameter, everything as before;
//   (b) a ready copy becomes a choice: identifier and parameter `instance=<identifier>`; main carries NO parameter;
//   (c) a remembered copy that is gone, being cleared away, failed or otherwise not ready falls VISIBLY back to main (hint), the
//       choice is forgotten, but NOT one that is only transiently not ready (g);
//   (d) empty is not unknown: while the list loads, the editor waits for a remembered copy; if it did not arrive, main with the hint
//       "unchecked", and the choice stays remembered;
//   (e) 404 `UNKNOWN_INSTANCE` of the chosen copy in the middle of editing => main with a hint; every other error changes nothing;
//   (f) the UI: no call of the code view bypasses the choice;
//   (g) a remembered copy in `create`, `start` (after EVERY restart of B) or `recreate` stays chosen and remembered: parameter and
//       label stay, hint "transient", it stays in the bar; once ready again it counts without a hint (it used to fall back to
//       main, be forgotten, and the editor was rebuilt);
//   (h) a fallback WITHOUT the user's doing with unsaved tabs keeps the displayed copy (hint "held", same parameter, no rebuild);
//       without unsaved tabs, without a displayed copy or without a switch the new choice applies. "held" carries the REASON (the
//       new choice's, otherwise the last held one);
//   (i) a shown fallback follows the READ list (`hintBySituation`): "clearAway -> removed" turns "not ready" into "gone", another
//       state replaces the old one, ready again => superseded; "held during clearAway" first names the clearing and "gone" after the
//       removal; the area tracks the hint on every load and does not forget the choice while it is held.
//
// Run:  node --test web/test/code-instance.test.mjs
// COUNTER-TESTS: without the leaf red (tsc does not find the file); in `selectInstance` drop the fallback (a remembered copy counts
// even without a hit: `if (!hit) return { ..., param: g, ... }`) => (c) red; in CodePane.tsx a call back to
// `api(`${apiBase}/files/write`` => (f) red; `TRANSIENT` empty => (g) red; `holdFallback` always returns `fresh` => (h) red;
// `fallbackBySituation` without the branch "row gone => way" => (i) red; in the area drop `&& !getsHeld` => (i) red.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const SOURCE = path.join(webDir, "src", "lib", "code-instance.ts");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });

let module = null;
async function load() {
  if (module) return module;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-code-instance-"));
  execFileSync(process.execPath, [tsc, SOURCE, "--outDir", tmp, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  module = await import(pathToFileURL(path.join(tmp, "code-instance.js")).href);
  return module;
}

const P = "p1";
const field = (copies, o = {}) => ({ identifier: `${P}/main`, state: "ready", converted: true, ...(copies ? { copies } : {}), ...o });
const k = (name, state = "ready", o = {}) => ({ identifier: `${P}/copy-${name}`, name: `${name}.p1.cbase`, chatId: "c", state, ...o });

test("(a) no choice: not converted, without copies, without a ready copy, foreign or broken rows: no parameter", async () => {
  const { selectInstance, instanceOptions } = await load();
  for (const [name, f] of [
    ["without field", undefined],
    ["null", null],
    ["not converted", field([k("k1")], { converted: false })],
    ["converted missing", field([k("k1")], { converted: undefined })],
    ["without copies", field(undefined)],
    ["empty copies", field([])],
    ["none ready", field([k("k1", "starts"), k("k2", "paused")])],
    ["copy of another project", field([{ identifier: "p2/copy-k1", state: "ready" }])],
    ["no copy identifier", field([{ identifier: `${P}/main`, state: "ready" }, { identifier: "garbage", state: "ready" }])],
  ]) {
    assert.deepEqual(instanceOptions(f), [], name);
    const w = selectInstance(P, f, null, "loaded");
    assert.deepEqual([w.options, w.param, w.copy, w.hint, w.waiting], [[], null, null, null, false], name);
  }
  assert.equal(selectInstance(P, undefined, null, "loaded").identifier, null, "without a move no instance");
  assert.equal(selectInstance(P, field([]), null, "loaded").identifier, `${P}/main`, "converted: the identifier of main, but no parameter");
});

test("(b) a ready copy becomes a choice; main carries no parameter, the copy `instance=<identifier>`", async () => {
  const { selectInstance, instanceOptions, instancePath, copyNameOf, rememberKey } = await load();
  const f = field([k("k1"), k("k2", "starts"), k("k3"), k("k1")]);
  assert.deepEqual(instanceOptions(f), [
    { identifier: `${P}/main`, kind: "main", name: "" },
    { identifier: `${P}/copy-k1`, kind: "copy", name: "k1" },
    { identifier: `${P}/copy-k3`, kind: "copy", name: "k3" },
  ], "main first, only ready copies, each once, in the order of the list");
  for (const g of [null, "", `${P}/main`, "p2/copy-k1", "garbage"]) {
    const w = selectInstance(P, f, g, "loaded");
    assert.deepEqual([w.identifier, w.param, w.copy, w.hint, w.remember], [`${P}/main`, null, null, null, null], String(g));
    assert.equal(w.options.length, 3);
  }
  const w = selectInstance(P, f, `${P}/copy-k3`, "loaded");
  assert.deepEqual([w.identifier, w.param, w.copy, w.hint, w.waiting, w.remember], [`${P}/copy-k3`, `${P}/copy-k3`, "k3", null, false, `${P}/copy-k3`]);
  assert.equal(instancePath("/api/projects/p1/files/read?path=a%20b", w.param), "/api/projects/p1/files/read?path=a%20b&instance=p1%2Fcopy-k3");
  assert.equal(instancePath("/api/projects/p1/git", w.param), "/api/projects/p1/git?instance=p1%2Fcopy-k3");
  assert.equal(instancePath("/api/projects/p1/git#x", w.param), "/api/projects/p1/git?instance=p1%2Fcopy-k3#x");
  for (const empty of [null, undefined, ""]) assert.equal(instancePath("/api/projects/p1/git?repo=x", empty), "/api/projects/p1/git?repo=x", "main: byte-equal");
  assert.equal(copyNameOf("p/q/copy-a-b"), "a-b");
  assert.equal(copyNameOf("p1/main"), null);
  assert.equal(rememberKey("p1"), "cbase-code-instance:p1");
});

test("(c) a remembered copy, cleared away or not ready, falls visibly back to main and is forgotten", async () => {
  const { selectInstance } = await load();
  let w = selectInstance(P, field([k("k1")]), `${P}/copy-away`, "loaded");
  assert.deepEqual([w.identifier, w.param, w.copy, w.hint, w.remember], [`${P}/main`, null, null, { kind: "gone", name: "away" }, null]);
  assert.equal(w.options.length, 2, "the choice stays offered");
  w = selectInstance(P, field([k("k1"), k("k2", "paused")]), `${P}/copy-k2`, "loaded");
  assert.deepEqual([w.param, w.hint, w.remember], [null, { kind: "not-ready", name: "k2", state: "paused" }, null]);
  // The last copy is gone: no choice any more, but the hint.
  w = selectInstance(P, field(undefined), `${P}/copy-k1`, "loaded");
  assert.deepEqual([w.options, w.param, w.hint], [[], null, { kind: "gone", name: "k1" }]);
  // The project is not (any more) converted: the copy does not exist.
  w = selectInstance(P, undefined, `${P}/copy-k1`, "loaded");
  assert.deepEqual([w.identifier, w.param, w.hint], [null, null, { kind: "gone", name: "k1" }]);
  // The copy goes or has failed: fallback, forgotten (only THESE states, not create/start/recreate).
  for (const state of ["clearAway", "error"]) {
    w = selectInstance(P, field([k("k1"), k("k2", state)]), `${P}/copy-k2`, "loaded");
    assert.deepEqual([w.param, w.hint, w.remember], [null, { kind: "not-ready", name: "k2", state }, null], state);
  }
});

test("(d) empty is not unknown: the list loads => wait (only with a remembered copy); it did not arrive => main, hint, choice stays", async () => {
  const { selectInstance } = await load();
  let w = selectInstance(P, undefined, `${P}/copy-k1`, "loading");
  assert.deepEqual([w.waiting, w.param, w.hint, w.remember], [true, null, null, `${P}/copy-k1`]);
  w = selectInstance(P, undefined, null, "loading");
  assert.deepEqual([w.waiting, w.param, w.hint, w.options], [false, null, null, []], "without a remembered copy main right away, as before");
  w = selectInstance(P, undefined, "p2/copy-k1", "loading");
  assert.equal(w.waiting, false, "the copy of another project does not count");
  w = selectInstance(P, undefined, `${P}/copy-k1`, "error");
  assert.deepEqual([w.waiting, w.param, w.hint, w.remember], [false, null, { kind: "unchecked", name: "k1" }, `${P}/copy-k1`]);
  w = selectInstance(P, undefined, null, "error");
  assert.deepEqual([w.waiting, w.param, w.hint], [false, null, null]);
});

test("(e) 404 UNKNOWN_INSTANCE of the chosen copy in the middle of editing => main with a hint; every other error => nothing", async () => {
  const { selectInstance, afterError } = await load();
  const w = selectInstance(P, field([k("k1"), k("k2")]), `${P}/copy-k1`, "loaded");
  const err = (o) => Object.assign(new Error("x"), o);
  const r = afterError(w, err({ code: "UNKNOWN_INSTANCE", identifier: `${P}/copy-k1` }));
  assert.deepEqual([r.identifier, r.param, r.copy, r.hint, r.remember], [`${P}/main`, null, null, { kind: "gone", name: "k1" }, null]);
  assert.deepEqual(r.options.map((o) => o.identifier), [`${P}/main`, `${P}/copy-k2`], "the cleared copy drops out of the choice");
  assert.deepEqual(afterError(selectInstance(P, field([k("k1")]), `${P}/copy-k1`, "loaded"), err({ code: "UNKNOWN_INSTANCE" })).options, [], "only main left: no choice");
  for (const o of [{ code: "COPY_LOCKED" }, { status: 409 }, {}, { code: "UNKNOWN_INSTANCE", identifier: `${P}/copy-k2` }]) {
    assert.equal(afterError(w, err(o)), null, JSON.stringify(o));
  }
  assert.equal(afterError(w, null), null);
  assert.equal(afterError(selectInstance(P, field([k("k1")]), null, "loaded"), err({ code: "UNKNOWN_INSTANCE" })), null, "main has nowhere to fall back to");
});

test("(g) a copy in create, start or recreate stays chosen and remembered: no fallback, no rebuild; ready again => without a hint", async () => {
  const { selectInstance, TRANSIENT } = await load();
  assert.deepEqual([...TRANSIENT], ["create", "start", "recreate"]);
  const K2 = `${P}/copy-k2`;
  for (const state of ["create", "start", "recreate"]) {
    // Next to a ready copy and alone (after a restart of B EVERY copy is on start).
    for (const copies of [[k("k1"), k("k2", state)], [k("k2", state)], [k("k1", state), k("k2", state)]]) {
      const w = selectInstance(P, field(copies), K2, "loaded");
      const what = `${state} ${JSON.stringify(copies.map((x) => x.state))}`;
      assert.deepEqual([w.identifier, w.param, w.copy, w.remember, w.waiting], [K2, K2, "k2", K2, false], what);
      assert.deepEqual(w.hint, { kind: "transient", name: "k2", state }, what);
      assert.ok(w.options.some((o) => o.identifier === K2), `${what}: the chosen copy drops out of the bar`);
      assert.equal(w.options[0].kind, "main", what);
      assert.ok(!w.options.some((o) => o.identifier === `${P}/copy-k1` && copies.find((x) => x.identifier === o.identifier)?.state !== "ready"), `${what}: a foreign not ready copy is offered`);
    }
  }
  // The sequence after a restart of B: ready -> start -> ready: the same choice all the time, without a hint in the end.
  const followUp = ["ready", "start", "ready"].map((state) => selectInstance(P, field([k("k2", state)]), K2, "loaded"));
  assert.deepEqual(followUp.map((w) => [w.param, w.remember]), [[K2, K2], [K2, K2], [K2, K2]]);
  assert.deepEqual(followUp.map((w) => w.hint?.kind ?? null), [null, "transient", null]);
  // Not converted (the row without a move): no project container, the copy does not exist: fallback as before.
  const without = selectInstance(P, field([k("k2", "start")], { converted: false }), K2, "loaded");
  assert.deepEqual([without.param, without.hint?.kind, without.remember], [null, "gone", null]);
});

test("(h) a fallback without the user's doing with unsaved tabs keeps the displayed copy; otherwise the new choice applies", async () => {
  const { selectInstance, holdFallback, afterError } = await load();
  const K1 = `${P}/copy-k1`;
  const displayed = selectInstance(P, field([k("k1")]), K1, "loaded");
  for (const fresh of [
    selectInstance(P, field([]), K1, "loaded"), // gone
    selectInstance(P, field([k("k1", "clearAway")]), K1, "loaded"), // being cleared away
    afterError(displayed, { code: "UNKNOWN_INSTANCE", identifier: K1 }), // 404 in the middle of editing
  ]) {
    const h = holdFallback(displayed, fresh, 2);
    assert.deepEqual([h.param, h.copy, h.identifier, h.waiting], [K1, "k1", K1, false], JSON.stringify(fresh.hint));
    assert.deepEqual(h.hint, { kind: "held", name: "k1", reason: fresh.hint }, "the reason is the new choice's");
    assert.deepEqual(h.options, displayed.options);
    // Without unsaved tabs the new choice applies.
    assert.equal(holdFallback(displayed, fresh, 0), fresh);
    // A second render with the held display keeps holding.
    assert.equal(holdFallback(h, fresh, 2).param, K1);
  }
  const ready = selectInstance(P, field([k("k1"), k("k2")]), `${P}/copy-k2`, "loaded");
  assert.equal(holdFallback(displayed, displayed, 3), displayed, "no switch: nothing to hold");
  assert.equal(holdFallback(null, ready, 3), ready, "nothing displayed: nothing to hold");
  const inMain = selectInstance(P, field([k("k1")]), null, "loaded");
  assert.equal(holdFallback(inMain, ready, 3), ready, "main is never held");
});

test("(i) a shown fallback follows the read list; 'held' names the reason according to the list", async () => {
  const { selectInstance, holdFallback, hintBySituation, afterError } = await load();
  const K1 = `${P}/copy-k1`;
  const nb = (state, name = "k1") => ({ kind: "not-ready", name, state });
  // clearAway -> removed: "not ready (clearAway)" becomes "gone" as soon as the row is missing (the hint used to freeze).
  const inClearAway = selectInstance(P, field([k("k1", "clearAway"), k("k2")]), K1, "loaded");
  assert.deepEqual(inClearAway.hint, nb("clearAway"));
  assert.equal(inClearAway.remember, null, "the choice is forgotten; afterwards the choice computes nothing about the copy");
  for (const [what, f, desired] of [
    ["row gone, another copy stays", field([k("k2")]), { kind: "gone", name: "k1" }],
    ["row gone, no copy left", field([]), { kind: "gone", name: "k1" }],
    ["project without copies field", field(undefined), { kind: "gone", name: "k1" }],
    ["failed instead of cleared away", field([k("k1", "error")]), nb("error")],
    ["ready again (recreated)", field([k("k1")]), null],
    ["being recreated", field([k("k1", "recreate")]), nb("recreate")],
  ]) assert.deepEqual(hintBySituation(nb("clearAway"), f, "loaded"), desired, what);
  // Unchanged: the same object (the page then does not re-render); nothing on a list that was not read.
  const h = nb("clearAway");
  assert.equal(hintBySituation(h, field([k("k1", "clearAway")]), "loaded"), h, "same state: the same object");
  for (const situation of ["loading", "error"]) assert.equal(hintBySituation(h, field([]), situation), h, `${situation}: nothing decided`);
  // "gone" stays (it can come from a 404 while the list still carries the copy); the other kinds are tracked by the choice itself.
  const way = { kind: "gone", name: "k1" };
  assert.equal(hintBySituation(way, field([k("k1")]), "loaded"), way);
  assert.equal(hintBySituation(way, field([]), "loaded"), way);
  for (const other of [{ kind: "transient", name: "k1", state: "start" }, { kind: "unchecked", name: "k1" }]) {
    assert.equal(hintBySituation(other, field([]), "loaded"), other, other.kind);
  }
  assert.equal(hintBySituation(null, field([]), "loaded"), null);

  // held during clearAway: the area does not forget the choice while it is held; the choice keeps computing about the copy, and the
  // reason follows the list: first the clearing, then "gone".
  const displayed = selectInstance(P, field([k("k1")]), K1, "loaded");
  const hold1 = holdFallback(displayed, selectInstance(P, field([k("k1", "clearAway")]), K1, "loaded"), 1);
  assert.deepEqual([hold1.param, hold1.hint], [K1, { kind: "held", name: "k1", reason: nb("clearAway") }]);
  const hold2 = holdFallback(hold1, selectInstance(P, field([]), K1, "loaded"), 1);
  assert.deepEqual([hold2.param, hold2.hint], [K1, { kind: "held", name: "k1", reason: { kind: "gone", name: "k1" } }]);
  // If the new choice names no reason (main after a forgotten marker), the last held one stays; never guessed.
  const without = selectInstance(P, field([]), null, "loaded");
  assert.deepEqual(holdFallback(hold2, without, 1).hint, { kind: "held", name: "k1", reason: { kind: "gone", name: "k1" } });
  assert.deepEqual(holdFallback(displayed, without, 1).hint, { kind: "held", name: "k1", reason: null }, "no reason known: null");
  assert.deepEqual(holdFallback(displayed, afterError(displayed, { code: "UNKNOWN_INSTANCE" }), 1).hint.reason, { kind: "gone", name: "k1" });

  // The area (by path): tracks the hint on every load, does not forget the choice while held, shows states as a word, and the text of
  // a "held" depends on the reason.
  const read = (rel) => fs.readFileSync(path.join(webDir, rel), "utf8");
  const area = read("src/components/CodeArea.tsx");
  assert.match(area, /setHint\(\(h\) => hintBySituation\(h, fresh, "loaded"\)\)/, "load() does not track the hint");
  assert.match(area, /raw\.remember !== remembered && !getsHeld\)/, "the area forgets the choice while it holds the copy");
  assert.ok(!/state: h\.state \|\| "\?"/.test(area), "the area shows the raw state identifier (clearAway) instead of the word");
  assert.match(area, /stateWord\(h\.state, t\)/);
  assert.match(area, /is being removed — \{n\} file\(s\)/, "'held' does not name the clearing");
});

test("(f) the UI: no call of the code view bypasses the choice, the page mounts the area", () => {
  const read = (rel) => fs.readFileSync(path.join(webDir, rel), "utf8");
  const pane = read("src/components/CodePane.tsx");
  // Every call with `${apiBase}` goes through `filePath`/`calls` (they carry `instance=`); an `api(`${apiBase}...` beside them would hit main.
  const past = pane.split("\n").filter((z) => /`\$\{apiBase\}/.test(z) && !/const filePath = useCallback/.test(z));
  assert.deepEqual(past, [], "CodePane.tsx builds an address bypassing `filePath`");
  assert.match(pane, /<TerminalPanel apiBase=\{apiBase\} instance=\{instance\}/);
  assert.match(pane, /<SearchView calls=\{calls\}/);
  // The search (own file) asks only via `calls`; an own address would hit main.
  const search = read("src/components/code/SearchView.tsx");
  assert.match(search, /calls<FileSearchResponse>\("\/files\/search"/);
  assert.doesNotMatch(search, /\bapi\(|apiBase\}/, "SearchView.tsx builds an address bypassing `calls`");
  assert.match(pane, /startFileDownload\(apiBase, [^)]*, instance\)/);
  assert.match(pane, /fileDownloadUrl\(apiBase, active\.path, true, instance\)/);
  const terminal = read("src/components/TerminalPanel.tsx");
  assert.match(terminal, /instancePath\(`\$\{apiBase\}\/terminal`, instance\)/);
  const events = read("src/lib/api/events.ts");
  assert.match(events, /instance=\$\{encodeURIComponent\(instance\)\}/);
  const git = read("src/components/GitSidebar.tsx");
  assert.match(git, /instancePath\(chatPath\(apiBase, rest, chatId\), instance\)/);
  assert.match(read("src/lib/git-state.ts"), /instancePath\(chatPath\(apiBase, "\/git", chatId\), instance\)/);
  const area = read("src/components/CodeArea.tsx");
  assert.match(area, /selectInstance\(/);
  assert.match(area, /afterError\(/);
  assert.match(area, /holdFallback\(displayed\.current, raw, unsaved\)/, "the area does not hold a fallback with unsaved tabs");
  assert.match(area, /<GitSidebar[^>]*instance=\{choice\.param\}/s);
  assert.match(read("src/app/workspaces/page.tsx"), /<CodeArea/);
});
