// `POST …/files/find {query}` — the name search behind ⌘P in the chat's code area. The route lives in devtools/code-route.js and so on
// BOTH levels (project and workspace; code-scopes.test.js holds the equality and the anchor); the copy goes through files-in-copy.js
// (files-in-copy.test.js (2), (6)). Promises of the route itself:
//   (a) ⌘P searches in the scope of the search (quick open as in VS Code): the same exclusions as `/files/search` (the VS Code defaults —
//       node_modules, .git, … — and the ignore files; dist and coverage only when a .gitignore names them). Every character of the
//       input in that order (`fuzzyContains`), sorted like VS Code (`compareItemsByFuzzyScore`, runtime/fast-open.js — the same
//       computation as web/src/lib/fuzzy-scorer.ts, bound in web/test/quick-input.test.mjs). Case does not matter.
//   (b) a cap WITH notice: at most `cap` hits (512 like VS Code `MAX_RESULTS`), `truncated: true` when there were more — a list that
//       truncates silently cannot be told from a complete one. The cap applies AFTER sorting (the best 512, not the first 512 of the walk).
//   (c) the same answer on workspace level, with the path relative to the workspace root.
//   (d) Several words in ANY order (VS Code: the first word searches, each word scores on its own) — "note docs" finds like "docs note".
//   (e) The two caps of the walk (a not-ignored `.venv` with more than 20,000 files before `src/` used to fill the cap BEFORE filtering —
//       ⌘P did not find `app.ts`): the hit cap counts only MATCHING files, the walk has its own, larger safety cap and says so
//       (`aborted`, `searched`).
//   (f) With boundary (workspace level with relocated projects): the same walk without links in the scope, the same hits; a folder for
//       which the boundary throws stays out; the caps apply there too.
//
// COUNTER-TESTS (one change each, shown red once):
//   devtools/code-route.js: `FIND_CAP` in the main branch replaced by 100000               ⇒ (b) red (60 instead of 50 hits)
//   devtools/code-route.js: `cap: FIND_CAP` dropped from the answer                        ⇒ (b) red (cap undefined)
//   devtools/code-route.js: the whole `/files/find` branch (main) dropped                  ⇒ (a) and (b) red
//   devtools/code-route.js: the copy branch dropped                                        ⇒ files-in-copy.test.js (2), (6) red
//   devtools/code-route.js: "POST /files/find" dropped from COPY_READING                   ⇒ files-in-copy.test.js (6) red
//   files.js `quickOpenFiles`: HEAVY_DIRS instead of the search scope (`folderFrom`, without `fileFrom`) ⇒ (a) red
//   runtime/fast-open.js: capped first, then sorted                                        ⇒ (b) red (not the best 512)
//   files.js `quickOpenFiles`: the hit cap counts every file again (`if (++seen > maxHits)` before the prefilter) ⇒ (e) red
//   files.js `quickOpenFiles`: no prefilter in the walk (`fastMatches` dropped)            ⇒ (e) red (cap full of strangers)
//   files.js `quickOpenFiles`: `aborted` not reported                                      ⇒ (e) red
//   files.js `quickOpenFiles`: the walk with boundary does not walk the scope (`walkInArea` empty) ⇒ (f) red
//   runtime/fast-open.js: the stage-1 pattern is the whole input without whitespace        ⇒ (d) red (in the test (a)(c))
//   runtime/fileAccess.js: the container's hit cap counts every file                       ⇒ files-in-copy.test.js (1) red
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_MAIN_AGENT_WAIT_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/files-find.test.js

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { json, makeProject, makeWorkspace, withServer } from "./server-harness.mjs";
import { FIND_CAP } from "../electron/server/devtools/code-route.js";
import { findFilesByName, NAME_SEARCH_MAX_FILES, quickOpenFiles, FAST_WALK_MAX } from "../electron/server/files.js";
import { realRoots } from "../electron/server/runtime/real-path.js";

function create(root, rel, content = "x\n") {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
const find = (base, route, query) => json(`${base}${route}/files/find`, { method: "POST", body: JSON.stringify({ query }) });

test("(a)(c) ⌘P finds within the scope of the search, fuzzy and sorted like VS Code — on both levels", async () => {
  await withServer(async ({ base, wsPath, projPath }) => {
    for (const rel of ["src/till/prices.ts", "docs/prices-note.md", "src/app.ts", "node_modules/x/pricing.js", ".git/prices", "dist/prices.js", "coverage/prices.html"]) create(projPath, rel);
    const ws = await makeWorkspace(base, "Find", wsPath);
    const proj = await makeProject(base, ws.id, projPath, "Checkout");

    // Without .gitignore: node_modules and .git drop out (VS Code defaults), dist and coverage do not — like the search. The order is
    // that of quick open: prefix in the name before hit in the name, shorter name first, on a tie the shorter path.
    const p = await find(base, `/api/projects/${proj.id}`, "prices");
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual(p.body, { results: ["dist/prices.js", "src/till/prices.ts", "coverage/prices.html", "docs/prices-note.md"], truncated: false, cap: FIND_CAP });
    const search = await json(`${base}/api/projects/${proj.id}/files/search`, { method: "POST", body: JSON.stringify({ query: "x" }) });
    assert.deepEqual(search.body.results.map((r) => r.path).sort(), ["coverage/prices.html", "dist/prices.js", "docs/prices-note.md", "src/app.ts", "src/till/prices.ts"], "the search skips only the defaults");
    // With .gitignore BOTH skip the same folders.
    create(projPath, ".gitignore", "dist/\ncoverage/\n");
    const ignored = await json(`${base}/api/projects/${proj.id}/files/search`, { method: "POST", body: JSON.stringify({ query: "x" }) });
    assert.deepEqual(ignored.body.results.map((r) => r.path).sort(), ["docs/prices-note.md", "src/app.ts", "src/till/prices.ts"], "the search skips the ignored folders");
    const pi = await find(base, `/api/projects/${proj.id}`, "prices");
    assert.deepEqual(pi.body.results, ["src/till/prices.ts", "docs/prices-note.md"], "⌘P skips the same ignored folders as the search");
    // The chat @-mentions (findFilesByName) stay with HEAVY_DIRS — only ⌘P moved.
    assert.deepEqual(findFilesByName(projPath, "prices", 30).results, ["docs/prices-note.md", "src/till/prices.ts"]);

    const large = await find(base, `/api/projects/${proj.id}`, "PRICES.TS");
    assert.deepEqual(large.body.results, ["src/till/prices.ts"], "case does not matter");
    const filePath = await find(base, `/api/projects/${proj.id}`, "till/pre");
    assert.deepEqual(filePath.body.results, ["src/till/prices.ts"], "a path part finds too");
    // Fuzzy like VS Code: the characters in that order, not contiguous ("stp" → src/till/prices.ts), several words each on its own.
    assert.deepEqual((await find(base, `/api/projects/${proj.id}`, "stp")).body.results, ["src/till/prices.ts"], "scattered characters do not find");
    // (d) Two words, in any order (VS Code: the first word searches, each word scores on its own, on name or path).
    assert.deepEqual((await find(base, `/api/projects/${proj.id}`, "docs note")).body.results, ["docs/prices-note.md"], "two words");
    assert.deepEqual((await find(base, `/api/projects/${proj.id}`, "note docs")).body.results, ["docs/prices-note.md"], "two words, swapped");
    assert.deepEqual((await find(base, `/api/projects/${proj.id}`, "prices till")).body.results, ["src/till/prices.ts"], "the folder as second word");
    assert.deepEqual((await find(base, `/api/projects/${proj.id}`, "app src")).body.results, ["src/app.ts"], "the folder as second word (2)");
    assert.deepEqual((await find(base, `/api/projects/${proj.id}`, "zqx")).body.results, [], "nothing matching");
    assert.deepEqual((await find(base, `/api/projects/${proj.id}`, "")).body.results, [], "empty input: the history is the client's business");

    // (c) Workspace level: the same computation, the path relative to the workspace root.
    const w = await find(base, `/api/workspaces/${ws.id}`, "prices");
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.deepEqual(w.body, { results: ["till/src/till/prices.ts", "till/docs/prices-note.md"], truncated: false, cap: FIND_CAP });
  });
});

test("(b) cap with notice: more than `cap` hits ⇒ exactly `cap` (the best) and truncated — never silently cut", async () => {
  await withServer(async ({ base, wsPath, projPath }) => {
    assert.equal(FIND_CAP, 512, "the cap is the VS Code one (MAX_RESULTS)");
    // EXACTLY as many `file-NNN.txt` as the cap, plus ONE `file.txt` deep below: "file-" hits exactly 512, "file" 513.
    for (let i = 0; i < FIND_CAP; i++) create(projPath, `many/file-${String(i).padStart(3, "0")}.txt`);
    create(projPath, "zz/deep/bottom/file.txt");
    const ws = await makeWorkspace(base, "Cap", wsPath);
    const proj = await makeProject(base, ws.id, projPath, "Checkout");
    const r = await find(base, `/api/projects/${proj.id}`, "file");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.results.length, FIND_CAP);
    assert.equal(r.body.truncated, true, "more hits than the cap ⇒ truncated");
    assert.equal(r.body.cap, FIND_CAP, "the answer names its cap");
    // Sorted first, then capped: the best hit (the shortest name "file.txt") comes first although the walk finds it last.
    assert.equal(r.body.results[0], "zz/deep/bottom/file.txt", "the cap applied before sorting");
    // Exactly at the route cap: 512 hits are not cut, 513 are (the boundary itself, not just "far more").
    const exactly512 = await find(base, `/api/projects/${proj.id}`, "file-");
    assert.deepEqual([exactly512.body.results.length, exactly512.body.truncated], [FIND_CAP, false], "exactly 512 hits: nothing cut");
    assert.deepEqual([r.body.results.length, r.body.truncated], [FIND_CAP, true], "513 hits: 512 and cut");
    // Exactly at the cap nothing is cut (on the function, with a small cap).
    assert.deepEqual([quickOpenFiles(projPath, "file-00", 10).results.length, quickOpenFiles(projPath, "file.txt", 1).truncated], [10, true]);
    const exactly = quickOpenFiles(projPath, "bottom", 1);
    assert.deepEqual([exactly.results, exactly.truncated], [["zz/deep/bottom/file.txt"], false], "exactly at the cap: not cut");
  });
});

test("(e) the two caps of the walk: the hit cap counts only matching files, the walk has its own — both with notice", async () => {
  const projPath = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-find-cap-"));
  try {
    assert.deepEqual([NAME_SEARCH_MAX_FILES, FAST_WALK_MAX], [20000, 200000], "the caps of the route");
    // A large, NOT ignored folder without hits (a `.venv` without .gitignore) and a few hits next to it.
    for (let i = 0; i < 60; i++) create(projPath, `.venv/lib/p${i % 3}/module${i}.py`);
    for (const rel of ["src/app.ts", "src/lib/app-core.ts", "web/app/page.tsx"]) create(projPath, rel);
    // Hit cap 10 with 63 files: all 3 hits arrive, nothing is cut — only matching files were counted. (Counting EVERY file would stop the
    // walk after 10, "app" would find nothing depending on order, and `truncated` would always be true.)
    const r = quickOpenFiles(projPath, "app", 512, { maxHits: 10 });
    assert.deepEqual(r, { results: ["src/app.ts", "src/lib/app-core.ts", "web/app/page.tsx"], truncated: false }, "the cap counted files that do not match");
    // More hits than the hit cap: cut with notice, the walk stopped (not `aborted` — that is the other cap).
    const full = quickOpenFiles(projPath, "module", 512, { maxHits: 10 });
    assert.deepEqual([full.results.length, full.truncated, full.aborted], [10, true, undefined], "the hit cap says it is one");
    // The safety cap of the walk: at most this many files in scope — with its own notice and the number.
    const from = quickOpenFiles(projPath, "zzz", 512, { maxWalk: 20 });
    assert.deepEqual(from, { results: [], truncated: true, aborted: true, searched: 20 }, "the walk does not say it aborted");
    assert.equal(quickOpenFiles(projPath, "zzz", 512, { maxWalk: 63 }).aborted, undefined, "exactly at the walk cap nothing is aborted");
    assert.deepEqual(quickOpenFiles(projPath, "", 512, { maxWalk: 1 }), { results: [], truncated: false }, "without a pattern there is no walk");
  } finally {
    fs.rmSync(projPath, { recursive: true, force: true });
  }
});

test("(f) with boundary: the same walk without links in scope — the same hits, a folder with a throwing boundary stays out, the caps apply", async () => {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-find-limit-"));
  const projPath = fs.realpathSync(raw);
  try {
    for (const rel of ["till/src/app.ts", "till/docs/app-note.md", "till/.gitignore", "till/built/app.js", "stock/app.py", "free/app.rb"]) create(projPath, rel, rel.endsWith(".gitignore") ? "built/\n" : "x\n");
    // A link in scope pointing out: no hit with or without boundary (a link is no file of the walk).
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-find-outside-")));
    create(outside, "app-outside.ts");
    fs.symlinkSync(outside, path.join(projPath, "till", "reference"));
    const till = path.join(projPath, "till"), stock = path.join(projPath, "stock");
    // The boundary like workspaces/routes.js `fileLimit`: a relocated project has a scope (its real roots), a locked one throws.
    const limit = (dir) => {
      if (dir === till || dir.startsWith(`${till}${path.sep}`)) return realRoots([till]);
      if (dir === stock || dir.startsWith(`${stock}${path.sep}`)) throw Object.assign(new Error("locked"), { code: "LOCKED" });
      return null;
    };
    const without = quickOpenFiles(projPath, "app", 512);
    assert.deepEqual(without.results, ["free/app.rb", "stock/app.py", "till/src/app.ts", "till/docs/app-note.md"], "without boundary: everything but the ignored");
    const including = quickOpenFiles(projPath, "app", 512, { limit });
    assert.deepEqual(including, { results: ["free/app.rb", "till/src/app.ts", "till/docs/app-note.md"], truncated: false },
      "with boundary: the scope walked (with its .gitignore), the locked folder out");
    // The caps apply in scope too: the hit cap counts only hits there, the walk cap every file.
    assert.deepEqual(quickOpenFiles(projPath, "app", 512, { limit, maxHits: 2 }).truncated, true, "the hit cap in scope");
    assert.equal(quickOpenFiles(projPath, "zzz", 512, { limit, maxWalk: 2 }).aborted, true, "the walk cap in scope");
    fs.rmSync(outside, { recursive: true, force: true });
  } finally {
    fs.rmSync(raw, { recursive: true, force: true });
  }
});
