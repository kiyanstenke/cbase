// The pure computations of the git bar in the style of the VS Code source control (src/lib/git-bar.ts) — executed, not
// re-implemented: the source is compiled with the local tsc and imported (model: chat-bar.test.mjs).
//
// What the computations carry and why they are a latch:
// - `primaryButton` decides what the wide button under the commit field DOES: commit, publish the branch (push with upstream)
//   or synchronise (pull, then push). A wrong kind pushes commits to the remote where the user wanted to commit. And: EMPTY IS
//   NOT UNKNOWN — a repo with `statusError` has no KNOWN changes, but not "none" either; it must never become
//   "Synchronise"/"Publish" (both presuppose "nothing to commit").
// - `syncSteps` is the order of the sync button: pull first, then push (like VS Code) — the other way round the remote rejects
//   the push as soon as it is ahead.
// - The selection in the "Repositories" section: click, second click back to the default, Cmd/Ctrl-click add/remove; a choice
//   whose repos have disappeared becomes the default (all) — never "no repo".
// - "Load more" in the graph: step 50, at most 500 (the server caps there; the computation itself is held by
//   web/test/git-graph.test.mjs).
// - The storage of the collapsed sections: nonsense in localStorage means "all open", never a throw in render. Three sections —
//   "Branches" is gone, a stored `branches` is an unknown entry.
// - Sections can be moved and resized like in VS Code:
//   · the ORDER: unknown and duplicate entries drop out, missing ones are appended (never a section that disappears); the
//     insertion point when dragging the head, "in place" is no movement, "up/down" among the VISIBLE sections, and an invisible
//     one ("Repositories" with a single repo) keeps its place relative to the others;
//   · the HEIGHTS: shares → whole pixels summing to the available height, none below `MIN_BODY` (unless the window is too small
//     for all — then equal), proportional at another panel height; dragging the gap moves only the two neighbours and clamps at
//     the minimum height; pixels → shares → pixels is lossless (otherwise the gap would wander a pixel away from the pointer
//     while dragging); a gap only under an open section with an open one below it.
// Plus the binding: GitSidebar.tsx CALLS these computations (instead of re-implementing them) and mounts the graph
// (components/git-bar/GitGraph.tsx — that it loads without its own timer is held by web/test/git-graph.test.mjs), and moving
// works through pointer events — no HTML5 drag and drop (Electron shell).
//
// COUNTER-PROOF built in (test "sabotage", the number in the printed line): one sabotage per promise on a copy of the source —
// one place each — is compiled along; the check `check` must throw on each. If one stays green, the check measures nothing at
// that place.
//
// Run:  node --test web/test/git-bar.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const SOURCE = path.join(webDir, "src", "lib", "git-bar.ts");
const source = fs.readFileSync(SOURCE, "utf8");

// The sabotages: ONE place each that breaks a promise. `old` must stand exactly so in the source (otherwise the test itself is outdated).
const SABOTAGES = {
  "statusError is skipped (would mean \"no changes\")": { old: `  if (r.statusError) return { kind: "commit", unknown: true };\n`, fresh: "" },
  "sync pushes before pulling": { old: `  if (count(r.behind) > 0) s.push("pull");\n  if (count(r.ahead) > 0) s.push("push");`, fresh: `  if (count(r.ahead) > 0) s.push("push");\n  if (count(r.behind) > 0) s.push("pull");` },
  "second click stays on the repo": { old: `selection && selection.length === 1 && selection[0] === key ? null : [key]`, fresh: `[key]` },
  "storage accepts every truthy value": { old: `(value as Record<string, unknown>)[id] === true`, fresh: `(value as Record<string, unknown>)[id]` },
  "order accepts unknown entries": { old: `if ((GIT_SECTIONS as readonly unknown[]).includes(v) && !out.includes(v as GitSection))`, fresh: `if (!out.includes(v as GitSection))` },
  "in place is a movement": { old: `  if (place === i || place === i + 1) return null;\n`, fresh: "" },
  "distribute without minimum height": { old: `const under = free.filter((i) => raw[i] < min);`, fresh: `const under: number[] = [];` },
  "drag without lower bound": { old: `const lo = Math.min(0, min - a);`, fresh: `const lo = -a;` },
  "rounding loses pixels": { old: `  for (let k = 0; missing > 0 && n > 0; k = (k + 1) % n, missing--) whole[byRemainder[k].i]++;\n`, fresh: "" },
  "gap under a collapsed section": { old: `    if (!isOpen(id)) return;\n`, fresh: "" },
  "shares accept every number": { old: `if (weight(v)) out[id] = v;`, fresh: `if (typeof v === "number") out[id] = v as number;` },
};

// Compile: the real source and one copy per sabotage, in ONE tsc run (each file a leaf without imports).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-git-bar-"));
const src = path.join(tmp, "src");
const out = path.join(tmp, "out");
fs.mkdirSync(src);
fs.writeFileSync(path.join(src, "real.ts"), source);
const sabotageFiles = Object.entries(SABOTAGES).map(([name, { old, fresh }], i) => {
  const file = `sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), source.replace(old, fresh));
  return { name, file, applies: source.includes(old) };
});
execFileSync(process.execPath, [
  tsc, ...fs.readdirSync(src).map((f) => path.join(src, f)),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict",
], { stdio: "pipe" });
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = await load("real.ts");
const sabotaged = await Promise.all(sabotageFiles.map(async (s) => ({ ...s, mod: await load(s.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

// A repo in the form the server sends in `GET …/git` (lib/api/git.ts GitRepo) — only the fields that decide here.
const repo = (x = {}) => ({ branch: "main", detached: false, upstream: "origin/main", ahead: 0, behind: 0, remote: { url: "x" }, counts: { total: 0 }, changes: [], ...x });

function checkPrimary(m) {
  const { primaryButton, hasSomethingToDo } = m;
  // Changes ⇒ commit, whatever is going on at the remote.
  assert.deepEqual(primaryButton(repo({ counts: { total: 3 } })), { kind: "commit", unknown: false });
  assert.deepEqual(primaryButton(repo({ counts: { total: 1 }, ahead: 2, behind: 1 })), { kind: "commit", unknown: false }, "with changes never synchronise");
  assert.deepEqual(primaryButton(repo({ counts: { total: 2 }, upstream: null })), { kind: "commit", unknown: false }, "with changes never publish");
  // Without `counts` the changes themselves count.
  assert.deepEqual(primaryButton(repo({ counts: null, changes: [{}] })), { kind: "commit", unknown: false });
  // Unknown is not "nothing to commit".
  for (const x of [{ ahead: 2 }, { upstream: null }, { ahead: 0, behind: 0 }]) {
    assert.deepEqual(primaryButton(repo({ statusError: "index unreadable", counts: null, ...x })), { kind: "commit", unknown: true }, `statusError with ${JSON.stringify(x)}`);
  }
  // Nothing to commit, upstream present: ↑/↓ decide.
  assert.deepEqual(primaryButton(repo({ ahead: 2 })), { kind: "synchronize", ahead: 2, behind: 0 });
  assert.deepEqual(primaryButton(repo({ behind: 3 })), { kind: "synchronize", ahead: 0, behind: 3 });
  assert.deepEqual(primaryButton(repo({ ahead: 1, behind: 4 })), { kind: "synchronize", ahead: 1, behind: 4 });
  assert.deepEqual(primaryButton(repo({ ahead: 0, behind: 0 })), { kind: "off" }, "when level there is nothing to do");
  assert.deepEqual(primaryButton(repo({ ahead: NaN, behind: -1 })), { kind: "off" }, "nonsense in ahead/behind counts as 0");
  // Without upstream: publish — only with a remote, only on a branch.
  assert.deepEqual(primaryButton(repo({ upstream: null })), { kind: "publish" });
  assert.deepEqual(primaryButton(repo({ upstream: null, detached: true })), { kind: "off" }, "a detached HEAD is not a branch");
  assert.deepEqual(primaryButton(repo({ upstream: null, branch: "" })), { kind: "off" });
  assert.deepEqual(primaryButton(repo({ upstream: null, remote: null })), { kind: "off" }, "nothing to publish without a remote");
  assert.deepEqual(primaryButton(repo({ remote: null, ahead: 2 })), { kind: "off" }, "no sync without a remote");
  // The default of the expansion follows the same computation.
  assert.equal(hasSomethingToDo(repo({ counts: { total: 1 } })), true);
  assert.equal(hasSomethingToDo(repo({ ahead: 1 })), true);
  assert.equal(hasSomethingToDo(repo()), false);
}

function checkSync(m) {
  const { syncSteps } = m;
  assert.deepEqual(syncSteps(repo({ remote: null })), [], "no button without a remote");
  assert.deepEqual(syncSteps(repo({ upstream: null })), ["push"], "without upstream: publish (push sets it)");
  assert.deepEqual(syncSteps(repo({ upstream: null, detached: true })), []);
  assert.deepEqual(syncSteps(repo({ behind: 2 })), ["pull"]);
  assert.deepEqual(syncSteps(repo({ ahead: 2 })), ["push"]);
  assert.deepEqual(syncSteps(repo({ ahead: 1, behind: 1 })), ["pull", "push"], "pull first, then push");
  assert.deepEqual(syncSteps(repo()), ["fetch"], "when level, look whether there is anything new");
  assert.deepEqual(syncSteps(repo({ ahead: NaN, behind: undefined })), ["fetch"]);
}

function checkSelection(m) {
  const { selectRepo, tidySelection, shownRepos, graphRepo } = m;
  assert.deepEqual(selectRepo(null, "a", false), ["a"], "click selects exactly this one");
  assert.equal(selectRepo(["a"], "a", false), null, "a second click on the only selected one returns to the default");
  assert.deepEqual(selectRepo(["a"], "b", false), ["b"]);
  assert.deepEqual(selectRepo(["a", "b"], "a", false), ["a"], "click in a multi-selection selects exactly this one");
  assert.deepEqual(selectRepo(null, "a", true), ["a"], "Cmd-click without a selection starts one");
  assert.deepEqual(selectRepo(["a"], "b", true), ["a", "b"]);
  assert.deepEqual(selectRepo(["a", "b"], "a", true), ["b"]);
  assert.equal(selectRepo(["b"], "b", true), null, "when the selection becomes empty, the default applies");
  const prior = ["a"];
  selectRepo(prior, "b", true);
  assert.deepEqual(prior, ["a"], "the old selection stays untouched (React state)");
  assert.equal(tidySelection(null, ["a"]), null);
  assert.deepEqual(tidySelection(["a", "x"], ["a", "b"]), ["a"]);
  assert.equal(tidySelection(["x"], ["a", "b"]), null, "only vanished repos ⇒ default, never \"no repo\"");
  const repos = [{ k: "a" }, { k: "b" }, { k: "c" }];
  const s = (r) => r.k;
  assert.deepEqual(shownRepos(repos, s, null).map(s), ["a", "b", "c"]);
  assert.deepEqual(shownRepos(repos, s, ["c", "a"]).map(s), ["a", "c"], "in the order of the tree");
  assert.deepEqual(shownRepos(repos, s, ["x"]).map(s), ["a", "b", "c"]);
  assert.equal(graphRepo(["a", "b"], "b", ["a"]), "b", "the choice in the graph head applies");
  assert.equal(graphRepo(["a", "b"], "x", ["b"]), "b", "a vanished choice falls back to the first shown one");
  assert.equal(graphRepo(["a", "b"], null, []), "a");
  assert.equal(graphRepo([], null, []), null);
  // Without a choice the first shown one WITH a remote (the purely local root repo with only `main` must not precede `frontend`).
  assert.equal(graphRepo(["root", "frontend"], null, ["root", "frontend"], ["frontend"]), "frontend", "a purely local repo displaces the one with a remote");
  assert.equal(graphRepo(["root", "frontend"], "root", ["root", "frontend"], ["frontend"]), "root", "the explicit choice beats the remote");
  assert.equal(graphRepo(["root", "frontend"], null, ["root"], ["frontend"]), "root", "only what is shown counts — a hidden repo with a remote does not");
  assert.equal(graphRepo(["a"], null, ["a"], []), "a", "without any remote the first shown one");
  const { readGraphChoice } = m;
  assert.equal(readGraphChoice(null), null);
  assert.equal(readGraphChoice(""), null);
  assert.equal(readGraphChoice("frontend"), "frontend");
}

function checkGraphAndStorage(m) {
  const { GRAPH_STEP, GRAPH_MAX, readCollapsed, toggleCollapsed, GIT_SECTIONS } = m;
  assert.equal(GRAPH_STEP, 50);
  assert.equal(GRAPH_MAX, 500, "the server caps `git log -n` at 500 (git.js gitLog)");
  // The next limit is computed by lib/git-graph.ts `loadMore` (web/test/git-graph.test.mjs).
  assert.deepEqual([...GIT_SECTIONS], ["repos", "changes", "graph"], "\"Branches\" is gone");
  for (const nonsense of [null, undefined, "", "{", "null", "[]", "42", "\"graph\"", '{"graph":1}', '{"graph":"true"}']) {
    assert.deepEqual(readCollapsed(nonsense), {}, `readCollapsed(${JSON.stringify(nonsense)}) is "all open"`);
  }
  assert.deepEqual(readCollapsed('{"graph":true,"foreign":true,"repos":false}'), { graph: true }, "only known sections, only explicit true");
  assert.deepEqual(readCollapsed('{"branches":true,"changes":true}'), { changes: true }, "a stored \"branches\" is unknown");
  const to = { graph: true };
  assert.deepEqual(toggleCollapsed(to, "graph"), {});
  assert.deepEqual(toggleCollapsed(to, "repos"), { graph: true, repos: true });
  assert.deepEqual(to, { graph: true }, "toggleCollapsed does not change the old state");
}

const ALL = ["repos", "changes", "graph"];
function checkOrder(m) {
  const { normalizeOrder, readOrder, insertPlace, targetFromPlace, targetStep, move, ORDER_KEY } = m;
  assert.equal(ORDER_KEY, "cbase-git-sections-order");
  // Storage: nonsense is the default, unknown and duplicate entries drop out, missing ones are appended.
  for (const nonsense of [null, undefined, "", "[", "42", "null", '{"graph":1}', '"graph"']) {
    assert.deepEqual(readOrder(nonsense), ALL, `readOrder(${JSON.stringify(nonsense)}) is the default`);
  }
  assert.deepEqual(readOrder('["graph"]'), ["graph", "repos", "changes"], "missing sections are appended in the default order");
  assert.deepEqual(normalizeOrder(["branches", "graph", "graph", 7, null, "changes", "foreign"]), ["graph", "changes", "repos"],
    "\"branches\", foreign entries, numbers and duplicates drop out");
  assert.deepEqual(normalizeOrder(["graph", "changes", "repos"]), ["graph", "changes", "repos"], "a valid order stays");
  // Insertion point: how many centres lie above the pointer.
  assert.equal(insertPlace([10, 50, 90], 5), 0);
  assert.equal(insertPlace([10, 50, 90], 30), 1);
  assert.equal(insertPlace([10, 50, 90], 60), 2);
  assert.equal(insertPlace([10, 50, 90], 400), 3);
  assert.equal(insertPlace([], 10), 0);
  // Target from the place: in place (before/after) is no movement.
  assert.deepEqual(targetFromPlace(ALL, "graph", 0), { before: "repos" }, "graph to the very top");
  assert.deepEqual(targetFromPlace(ALL, "graph", 1), { before: "changes" });
  assert.equal(targetFromPlace(ALL, "graph", 2), null, "above itself is no movement");
  assert.equal(targetFromPlace(ALL, "graph", 3), null, "below itself is no movement");
  assert.deepEqual(targetFromPlace(ALL, "repos", 3), { before: null }, "to the end");
  assert.equal(targetFromPlace(ALL, "repos", 1), null);
  assert.equal(targetFromPlace(ALL, "repos", 0), null);
  assert.equal(targetFromPlace(ALL, "repos", 4), null, "outside");
  assert.equal(targetFromPlace(ALL, "repos", -1), null, "outside");
  assert.equal(targetFromPlace(["changes", "graph"], "repos", 0), null, "an invisible section does not move");
  // Up / down among the visible ones.
  assert.deepEqual(targetStep(ALL, "graph", -1), { before: "changes" });
  assert.equal(targetStep(ALL, "graph", 1), null, "the last one cannot move further down");
  assert.equal(targetStep(ALL, "repos", -1), null, "the first one cannot move further up");
  assert.deepEqual(targetStep(ALL, "repos", 1), { before: "graph" });
  assert.deepEqual(targetStep(ALL, "changes", 1), { before: null });
  // Moving within the whole order.
  const old = [...ALL];
  assert.deepEqual(move(old, "graph", { before: "repos" }), ["graph", "repos", "changes"]);
  assert.deepEqual(move(old, "repos", { before: null }), ["changes", "graph", "repos"]);
  assert.deepEqual(move(old, "changes", { before: "repos" }), ["changes", "repos", "graph"]);
  assert.deepEqual(old, ALL, "move does not change the old order (React state)");
  // "Repositories" is missing (one repo): the others move among themselves, "repos" keeps its place relative to them.
  const full = ["changes", "repos", "graph"];
  const visible = full.filter((id) => id !== "repos");
  const upward = move(full, "graph", targetStep(visible, "graph", -1));
  assert.deepEqual(upward, ["graph", "changes", "repos"]);
  assert.deepEqual(upward.filter((id) => id !== "repos"), ["graph", "changes"], "the visible order is the wanted one");
  for (const r of [ALL, full, upward]) {
    for (const id of r) for (const place of [0, 1, 2, 3]) {
      const z = targetFromPlace(r, id, place);
      if (z) assert.deepEqual([...move(r, id, z)].sort(), [...ALL].sort(), "move loses and duplicates nothing");
    }
  }
}

function checkHeights(m) {
  const { readShares, availableHeight, distribute, pull, asShares, column, MIN_BODY, HEADER_HEIGHT, DEFAULT_SHARE, HEIGHTS_KEY, SPLIT_STEP } = m;
  assert.equal(HEIGHTS_KEY, "cbase-git-sections-heights");
  assert.equal(HEADER_HEIGHT, 22);
  assert.equal(MIN_BODY, 50, "head + two rows (2 × 22) + 6 px padding");
  assert.equal(SPLIT_STEP, 16, "arrow keys like at the chat list");
  const sum = (h) => Object.values(h).reduce((s, v) => s + v, 0);
  // Storage: `null` = default (roles), only positive finite numbers of known sections.
  for (const nonsense of [null, undefined, "", "{", "[]", "42", "null", "{}", '{"graph":0}', '{"graph":-1}', '{"graph":"0.4"}', '{"foreign":1}']) {
    assert.equal(readShares(nonsense), null, `readShares(${JSON.stringify(nonsense)}) is the default`);
  }
  assert.deepEqual(readShares('{"graph":0.4,"foreign":1,"repos":-1,"aenderungen":"0.5","branches":0.2}'), { graph: 0.4 });
  // Available: bar minus heads minus hairlines.
  assert.equal(availableHeight(800, 3), 800 - 3 * 22 - 2);
  assert.equal(availableHeight(800, 2), 800 - 2 * 22 - 1);
  assert.equal(availableHeight(40, 3), 0, "never negative");
  assert.equal(availableHeight(0, 3), 0);
  assert.equal(availableHeight(NaN, 3), 0);
  // Distributing: exact sum, ratio, minimum height, default weight for missing ones.
  assert.deepEqual(distribute([], { graph: 1 }, 500), {});
  assert.deepEqual(distribute(["changes", "graph"], { changes: 0.6, graph: 0.4 }, 500), { changes: 300, graph: 200 });
  assert.deepEqual(distribute(["changes", "graph"], { changes: 0.6, graph: 0.4 }, 1000), { changes: 600, graph: 400 }, "proportional at another panel height");
  assert.deepEqual(distribute(["changes", "graph"], { changes: 6, graph: 4 }, 500), { changes: 300, graph: 200 }, "weights, no sum of 1");
  const three = distribute(ALL, { repos: 1, changes: 1, graph: 1 }, 301);
  assert.equal(sum(three), 301, "the sum is the available height — no pixel lost");
  assert.deepEqual(three, { repos: 101, changes: 100, graph: 100 });
  assert.deepEqual(distribute(["changes", "graph"], { changes: 0.99, graph: 0.01 }, 500), { changes: 450, graph: 50 }, "none below MIN_BODY");
  assert.deepEqual(distribute(ALL, { repos: 0.98, changes: 0.01, graph: 0.01 }, 400), { repos: 300, changes: 50, graph: 50 }, "two at the minimum height, the rest shares");
  assert.deepEqual(distribute(["changes", "graph"], { changes: 1, graph: 1 }, 60), { changes: 30, graph: 30 }, "too small for all minimum heights ⇒ equal");
  assert.equal(sum(distribute(ALL, { repos: 3 }, 37)), 37);
  const missing = distribute(["repos", "changes"], { changes: DEFAULT_SHARE.changes }, 650);
  assert.deepEqual(missing, { repos: 200, changes: 450 }, "without a stored weight DEFAULT_SHARE applies");
  assert.deepEqual(distribute(["changes", "graph"], null, 800), { changes: 450, graph: 350 });
  for (const H of [0, 1, 99, 100, 101, 333, 731, 1234]) for (const w of [{ repos: 0.2, changes: 0.5, graph: 0.3 }, { repos: 0.001, graph: 9 }]) {
    const h = distribute(ALL, w, H);
    assert.equal(sum(h), H, `sum at H=${H}`);
    for (const v of Object.values(h)) assert.ok(Number.isInteger(v) && v >= 0, `whole, non-negative pixels at H=${H}`);
    if (H >= 3 * MIN_BODY) for (const v of Object.values(h)) assert.ok(v >= MIN_BODY, `none below MIN_BODY at H=${H}: ${JSON.stringify(h)}`);
  }
  // Dragging: only the two neighbours, sum stays, clamp at the minimum height.
  const px = { repos: 100, changes: 300, graph: 200 };
  assert.deepEqual(pull(px, "changes", "graph", 40), { repos: 100, changes: 340, graph: 160 });
  assert.deepEqual(pull(px, "changes", "graph", -40), { repos: 100, changes: 260, graph: 240 });
  assert.deepEqual(pull(px, "changes", "graph", -1000), { repos: 100, changes: 50, graph: 450 }, "top not below MIN_BODY");
  assert.deepEqual(pull(px, "changes", "graph", 1000), { repos: 100, changes: 450, graph: 50 }, "bottom not below MIN_BODY");
  assert.deepEqual(pull(px, "repos", "graph", 30), { repos: 130, changes: 300, graph: 170 }, "across a collapsed one: only the two");
  assert.deepEqual(pull(px, "changes", "graph", NaN), px, "no drag without a number");
  assert.deepEqual(pull(px, "changes", "graph", 12.6), { repos: 100, changes: 313, graph: 187 }, "whole pixels");
  assert.deepEqual(pull({ changes: 30, graph: 30 }, "changes", "graph", 10), { changes: 30, graph: 30 }, "whoever is already below the limit does not shrink");
  assert.deepEqual(pull({ changes: 30, graph: 300 }, "changes", "graph", -10), { changes: 30, graph: 300 });
  assert.deepEqual(pull({ changes: 30, graph: 300 }, "changes", "graph", 10), { changes: 40, graph: 290 }, "it may grow");
  assert.deepEqual(px, { repos: 100, changes: 300, graph: 200 }, "pull does not change the old state");
  // Shares: fraction of the sum of the open ones, collapsed ones keep their weight; the way back is lossless.
  assert.deepEqual(asShares({ changes: 300, graph: 200 }, ["changes", "graph"], null), { changes: 0.6, graph: 0.4 });
  assert.deepEqual(asShares({ changes: 300, graph: 100 }, ["changes", "graph"], { repos: 0.2, changes: 0.1 }), { repos: 0.2, changes: 0.75, graph: 0.25 });
  assert.deepEqual(asShares({}, ["changes"], { graph: 0.3 }), { graph: 0.3 }, "without a height the old one stays");
  const open = ["repos", "changes", "graph"];
  for (const H of [150, 151, 517, 732, 999]) {
    let status = distribute(open, { repos: 0.21, changes: 0.47, graph: 0.32 }, H);
    for (const d of [7, -13, 101, -400, 3]) {
      status = pull(status, "changes", "graph", d);
      assert.deepEqual(distribute(open, asShares(status, open, null), H), status, `pixels → shares → pixels at H=${H} after ${d}`);
    }
  }
  // Gaps: under every open one with an open one below; a collapsed one has none.
  const on = (...ids) => (id) => ids.includes(id);
  assert.deepEqual(column(ALL, on(...ALL)), [{ after: 0, top: "repos", bottom: "changes" }, { after: 1, top: "changes", bottom: "graph" }]);
  assert.deepEqual(column(ALL, on("repos", "graph")), [{ after: 0, top: "repos", bottom: "graph" }], "across the collapsed one");
  assert.deepEqual(column(ALL, on("changes", "graph")), [{ after: 1, top: "changes", bottom: "graph" }], "no gap under a collapsed one");
  assert.deepEqual(column(ALL, on("repos", "changes")), [{ after: 0, top: "repos", bottom: "changes" }]);
  assert.deepEqual(column(ALL, on("graph")), [], "a single open one has no gap");
  assert.deepEqual(column(ALL, on()), []);
}

function check(m) {
  checkPrimary(m);
  checkSync(m);
  checkSelection(m);
  checkGraphAndStorage(m);
  checkOrder(m);
  checkHeights(m);
}

test("primary button: commit · publish · synchronise · off — and an unreadable status stays \"commit, unknown\"", () => checkPrimary(real));
test("sync button: pull first, then push; without upstream push; when level fetch; without remote nothing", () => checkSync(real));
test("selection of repositories: click, second click, Cmd-click; vanished repos ⇒ default; graph repo", () => checkSelection(real));
test("graph: step 50, cap 500, and the storage of the collapsed sections", () => checkGraphAndStorage(real));
test("order: storage normalised, insertion point, in place no movement, up/down, invisible ones keep their place", () => checkOrder(real));
test("heights: shares ↔ pixels lossless, exact sum, minimum height, proportional, drag only between two neighbours, gap only between open ones", () => checkHeights(real));

// The number of sabotages is in the printed line, not in the title (a number in the title silently ages).
test("sabotage: every place turns the check red (the built-in counter-proof)", (t) => {
  for (const s of sabotaged) {
    assert.ok(s.applies, `sabotage "${s.name}" no longer applies — its wording is not in src/lib/git-bar.ts (test outdated?)`);
    assert.throws(() => check(s.mod), `sabotage "${s.name}" stays green — the check does not measure this place`);
  }
  t.diagnostic(`${sabotaged.length} sabotages on src/lib/git-bar.ts, each red`);
});

// ── Binding: GitSidebar.tsx calls the computations instead of re-implementing them ─────────────────────────────────────────────────────────────
// Checked on the source text without comment lines (like chat-bar.test.mjs `readCode`): a comment naming the call is not a call.
const code = (s) => s.split("\n").filter((z) => !/^\s*(\/\/|\/\*|\*)/.test(z)).join("\n").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
function checkBinding(git) {
  assert.ok(/from "@\/lib\/git-bar"/.test(git), "GitSidebar.tsx does not import the computations from @/lib/git-bar");
  assert.ok(/const p = primaryButton\(repo\);/.test(git) && /data-git-primary=\{p\.kind\}/.test(git), "the primary button does not compute its kind via primaryButton(repo)");
  assert.ok(/for \(const step of syncSteps\(r\)\)/.test(git), "the sync does not go through syncSteps(r)");
  assert.ok(/selectRepo\(tidySelection\(a, keys\), k, addition\)/.test(git) && /shownRepos\(repos, repoKey, choice\)/.test(git), "the selection of repositories does not compute via selectRepo/shownRepos");
  assert.ok(/graphRepo\(repos\.map\(repoKey\), choice, shown\.map\(repoKey\), repos\.filter\(\(r\) => r\.remote\)\.map\(repoKey\)\)/.test(git), "the repo of the graph does not come from graphRepo");
  assert.ok(/readCollapsed\(localStorage\.getItem\(SECTIONS_KEY\)\)/.test(git), "the collapsed sections do not come from storage via readCollapsed");
  // The graph (no own timer, reloads only with the repo state, "Load more") is components/git-bar/GitGraph.tsx — its binding
  // with counter-proof is held by web/test/git-graph.test.mjs; here only that the bar mounts it.
  assert.ok(/<GitGraph /.test(git), "GitSidebar.tsx does not mount the graph (<GitGraph …>)");
  // The stack: storage, distributing, drag, gaps, moving — all through the computations.
  const sStart = git.indexOf("function SectionStack(");
  const sEnd = git.indexOf("function SplitHandle(", sStart);
  assert.ok(sStart > 0 && sEnd > sStart, "function SectionStack( … function SplitHandle( missing");
  const stack = git.slice(sStart, sEnd);
  assert.ok(/readOrder\(localStorage\.getItem\(ORDER_KEY\)\)/.test(stack), "the order does not come from storage via readOrder");
  assert.ok(/readShares\(localStorage\.getItem\(HEIGHTS_KEY\)\)/.test(stack), "the heights do not come from storage via readShares");
  assert.ok(/const px = shares && bar > 0 \? distribute\(open, shares, available\) : null;/.test(stack), "the heights of the bodies are not computed by distribute(open, shares, available)");
  assert.ok(/const available = availableHeight\(bar, visible\.length\);/.test(stack), "the available height is not computed by availableHeight");
  assert.ok(/asShares\(pull\(z\.start, z\.top, z\.bottom, y - z\.y0\)/.test(stack), "the drag at the gap does not go through pull/asShares");
  assert.ok(/const columns = column\(visible, \(id\) => !collapsed\[id\]\);/.test(stack), "which gaps exist is not computed by column()");
  assert.ok(/insertPlace\(rects\.map\(/.test(stack) && /targetFromPlace\(ids\(\), id, /.test(stack), "the insertion point is not computed via insertPlace/targetFromPlace");
  assert.ok(/moveInOrder\(state\.current\.order, id, target\)/.test(stack) && /targetStep\(state\.current\.visible, id, direction\)/.test(stack), "moving does not go through moveInOrder/targetStep");
  assert.ok(/const TRANSACTION_THRESHOLD = 4;/.test(git) && /< TRANSACTION_THRESHOLD\) return;/.test(stack), "the threshold between click and drag (4 px) is missing");
  assert.ok(/e\.detail === 0/.test(stack), "the keyboard click is swallowed after a drag");
  // Pointer events, no HTML5 drag and drop (Electron shell) — in the whole file.
  for (const forbidden of ["draggable", "onDragStart", "onDrop", "dataTransfer", "\"dragstart\""]) assert.ok(!git.includes(forbidden), `GitSidebar.tsx contains ${forbidden} — moving uses pointer events`);
  // The SplitHandle: horizontal, row-resize, keyboard.
  const split = git.slice(sEnd, git.indexOf("function SectionMenu(", sEnd));
  assert.ok(/role="separator" aria-orientation="horizontal"/.test(split) && /cursor-row-resize/.test(split) && /aria-valuenow=\{value\}/.test(split), "the gap is not a horizontal separator with row-resize and aria-valuenow");
}
test("binding: GitSidebar.tsx calls the computations (with counter-proof)", () => {
  const git = code(fs.readFileSync(path.join(webDir, "src", "components", "GitSidebar.tsx"), "utf8"));
  checkBinding(git);
  const sabotages = {
    "primary button computed itself": git.replace("const p = primaryButton(repo);", "const p = { kind: \"commit\" as const, unknown: false };"),
    "graph not mounted": git.replace("<GitGraph ", "<GitGraphGone "),
    "stack computes the heights itself": git.replace("const px = shares && bar > 0 ? distribute(open, shares, available) : null;", "const px = shares && bar > 0 ? Object.fromEntries(open.map((id) => [id, available / open.length])) : null;"),
    "order unchecked from storage": git.replace("readOrder(localStorage.getItem(ORDER_KEY))", "JSON.parse(localStorage.getItem(ORDER_KEY) ?? \"[]\")"),
    "HTML5 drag and drop on the header": git.replace("<section data-git-section={id}", "<section draggable data-git-section={id}"),
    "every press is a drag": git.replace("< TRANSACTION_THRESHOLD) return;", "< 0) return;"),
  };
  for (const [name, copy] of Object.entries(sabotages)) {
    assert.notEqual(copy, git, `sabotage "${name}" no longer applies (wording in GitSidebar.tsx changed?)`);
    assert.throws(() => checkBinding(copy), `sabotage "${name}" stays green`);
  }
});

test("a folder entry (untracked folder / embedded repository, \"x/\") opens no diff — computed, and the row uses it", () => {
  assert.equal(real.isFolderEntry("reader-agent/"), true);
  assert.equal(real.isFolderEntry("a/b/"), true);
  assert.equal(real.isFolderEntry("a/b.txt"), false);
  assert.equal(real.isFolderEntry("/"), false);
  assert.equal(real.isFolderEntry(""), false);
  const git = code(fs.readFileSync(path.join(webDir, "src", "components", "GitSidebar.tsx"), "utf8"));
  const row = git.slice(git.indexOf("function FileRow("), git.indexOf("// ── Graph"));
  const check = (src) => {
    assert.ok(/const folder = isFolderEntry\(change\.path\);/.test(src), "FileRow does not compute folder via isFolderEntry");
    assert.ok(/onClick=\{folder \? undefined : \(\) => onOpen\(false\)\}/.test(src) && /onDoubleClick=\{folder \? undefined : \(\) => onOpen\(true\)\}/.test(src), "a folder row still opens a diff");
  };
  check(row);
  assert.throws(() => check(row.replace("onClick={folder ? undefined : () => onOpen(false)}", "onClick={() => onOpen(false)}")), "sabotage: a folder row that opens a diff stays green");
});
