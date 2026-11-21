// The seam of the git overview: backend and web on ONE leaf.
//
// `server/backend/electron/server/gitView/contract.js` (a leaf without imports) carries the lists the server computes with: groups,
// states, reasons, user kinds, MR states, main-branch sources, the caps (POINTS_MAX, ROWS_MAX, DETAIL_COMMITS_MAX), COLORS, the
// windows of the timeline, the auto-fetch interval and the fields of every answer (overview, instance, row, checked out, user,
// detail, the additional fields per repo in GET …/git). That the SERVER sends exactly these fields is held by
// server/backend/test/gitView.test.js; here is the other half: that the web reads them.
//
// What is bound here:
//   (a) Web, EXECUTED: `web/src/lib/api/gitView.ts` (compiled without tsconfig, like preview-binding.test.mjs) exports for EVERY
//       constant of the contract a counterpart with the same value (ASSIGNMENT — a new constant in the contract without a line
//       there is red); `normGitView`, `normGitViewRow`, `normGitInstance`, `normGitUser`, `normGitBranchDetail` get an object of
//       EXACTLY the fields of the contract and return every field with its value, in the order of the contract; every group,
//       state, user kind, reason, main-branch source and MR state survives the normalisation; every identifying colour
//       0..COLORS−1 survives it and COLORS itself does not; `branchesRunningOf`/`counterOf` read the fields GIT_REPO_FIELDS, and
//       `GitRepo` in lib/api/git.ts declares them. In the type the field lists are bound to the types via
//       `GIT_VIEW_TYPES_BOUND` (tsc).
//   (b) iOS, READ: `mobile/CbaseMobile/Models/GitViewModels.swift` — `enum GitViewContract` carries for every list and number
//       of the contract a counterpart with the same value (IOS_ASSIGNMENT; a new constant without a line is red), the `CodingKeys`
//       of the response, instance, row, checked-out, user and detail types are EXACTLY the field lists of the contract in its
//       order, `GitRepoFields.fields` = GIT_REPO_FIELDS, and `GitRepo` (Models/GitModels.swift) reads both fields. Swift is not
//       compiled here (only macOS with Xcode can); the source text is what is bound.
//   (c) Built-in sabotage on an in-memory copy: a renamed field in `normGitViewRow`, the MR list without `error` (the state
//       before the field was added), a contract with a new group and one with a constant without counterpart — each ⇒ deviation.
//
// Counter-proof: lib/api/gitView.ts with the old MR list (`["no-access", "none", "no-gitlab"]`, `error` only appended in
// normGitMr) ⇒ (a) red ("MR states").
//
// Run:  node --test --test-reporter=tap web/test/git-view-binding.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as V from "../../server/backend/electron/server/gitView/contract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const src = (...p) => path.join(webDir, "src", ...p);
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (p) => fs.readFileSync(p, "utf8");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });

// ── (a) Web ─────────────────────────────────────────────────────────────────────────────────────

let web = null;
async function loadWeb() {
  if (web) return web;
  assert.ok(fs.existsSync(tsc), "web/node_modules is missing (tsc) — the binding cannot be checked without the compiler");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-git-view-binding-"));
  execFileSync(process.execPath, [
    tsc, src("lib", "api", "gitView.ts"),
    "--outDir", tmp, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
    "--skipLibCheck", "--lib", "es2022,dom",
  ], { cwd: webDir, stdio: "pipe" });
  web = await import(pathToFileURL(path.join(tmp, "gitView.js")).href);
  return web;
}

/** A version of lib/api/gitView.ts with modified source — compiled next to the real one (the same `./core.js` import). */
async function loadWebSabotaged(change) {
  await loadWeb();
  const ts = createRequire(path.join(webDir, "package.json"))("typescript");
  const source = change(read(src("lib", "api", "gitView.ts")));
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  const file = path.join(tmp, `git-view-sabotage-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, js);
  return import(pathToFileURL(file).href);
}

/** Constant of the contract → its counterpart on the web. A constant missing here is a deviation (never silently unbound). */
const ASSIGNMENT = Object.freeze({
  GROUPS: "GIT_VIEW_GROUPS",
  STATES: "GIT_VIEW_STATES",
  USER_KINDS: "GIT_VIEW_USER_KINDS",
  REASONS: "GIT_VIEW_REASONS",
  POINTS_MAX: "GIT_VIEW_POINTS_MAX",
  ROWS_MAX: "GIT_VIEW_ROWS_MAX",
  DETAIL_COMMITS_MAX: "GIT_VIEW_DETAIL_COMMITS_MAX",
  COLORS: "GIT_VIEW_COLORS",
  WINDOW: "GIT_VIEW_WINDOW",
  WINDOW_DEFAULT: "GIT_VIEW_WINDOW_DEFAULT",
  FETCH_GAP_MS: "GIT_VIEW_FETCH_GAP_MS",
  MAIN_BRANCH_SOURCES: "GIT_VIEW_MAIN_BRANCH_SOURCES",
  MR_STATES: "GIT_VIEW_MR_STATES",
  RESPONSE_FIELDS: "GIT_VIEW_RESPONSE_FIELDS",
  INSTANCE_FIELDS: "GIT_VIEW_INSTANCE_FIELDS",
  ROW_FIELDS: "GIT_VIEW_ROW_FIELDS",
  CHECKED_OUT_FIELDS: "GIT_VIEW_CHECKED_OUT_FIELDS",
  USER_FIELDS: "GIT_VIEW_USER_FIELDS",
  DETAIL_FIELDS: "GIT_VIEW_DETAIL_FIELDS",
  GIT_REPO_FIELDS: "GIT_REPO_FIELDS",
});

/** Example values per field — none of them is the default of the normalisation, otherwise a lost field would look right. */
const EXAMPLE_USER = { kind: "workflow-agent", name: "Reviewer", chatId: "c1", agentId: "a1", childChatId: "kc1", instance: "k1" };
const EXAMPLE_CHECKED_OUT = { instance: "k1", worktree: "/w/x", notBackedUp: 2, chats: [{ chatId: "c9", title: "Running" }] };
const EXAMPLE_ROW = {
  group: "cbase", name: "cbase/agent-x1", local: true, remote: "origin/cbase/agent-x1", detached: { sha: "abc1234" },
  instance: "k1", toRemote: { ahead: 1, back: 2 }, toMain: { ahead: 3, back: 4, merged: true }, sinceCreation: { ahead: 5, back: 6 },
  branchPoint: 77, last: { t: 88, author: "A", subject: "B" }, commits: { points: [{ t: 1, pushed: false }], count: 1, notFetched: [9] },
  checkedOut: [EXAMPLE_CHECKED_OUT], user: EXAMPLE_USER, state: "running",
};
const EXAMPLE_INSTANCE = { name: "k1", color: 3, read: false, reason: "stopped", remoteState: { at: 111, source: "fetch-head" } };
const EXAMPLE_RESPONSE = {
  repo: { rel: "app", name: "app" }, repos: [{ rel: "app", name: "app" }, { rel: "", name: "gu7" }],
  mainBranch: { name: "trunk", source: "origin/HEAD" },
  instances: [{ name: "main", color: null, read: true, reason: null, remoteState: { at: 5, source: "fetch-head" } }],
  line: { commits: [1, 2], count: 2, from: 1, until: 2 }, rows: [EXAMPLE_ROW], clipped: { shown: 400, total: 401 },
};
const EXAMPLE_DETAIL = {
  row: EXAMPLE_ROW, commits: [{ sha: "f".repeat(40), t: 12, author: "A", subject: "one" }],
  files: [{ file: "a.txt", plus: 2, minus: 1, binary: false }], mr: { state: "no-access", error: "no access" },
  origin: { source: "reflog", from: "main", at: 3 }, clipped: { commits: { shown: 50, total: 52 }, files: null },
  failed: { commits: null, files: "git diff --numstat: Exit 128" },
};
const EXAMPLE_GIT_REPO = { branchesRunning: [EXAMPLE_ROW], counter: { checkedOut: 1, branches: 2, cbase: 3, remote: 4 } };
const fromFields = (fields, example, location) => Object.fromEntries(fields.map((f) => {
  assert.ok(Object.hasOwn(example, f), `the contract names "${f}" (${location}), this test has no example value for it — add one`);
  return [f, example[f]];
}));

/** All deviations of the web side from the contract (empty = bound). */
function webDeviations(m, contract = V) {
  const out = [];
  const equal = (holds, desired, what) => { try { assert.deepStrictEqual(holds, desired); } catch { out.push(`${what}: web ${JSON.stringify(holds)}, contract ${JSON.stringify(desired)}`); } };
  const copy = (x) => (Array.isArray(x) ? [...x] : x);
  for (const [name, value] of Object.entries(contract)) {
    const against = ASSIGNMENT[name];
    if (!against) { out.push(`${name}: no counterpart on the web (add to ASSIGNMENT)`); continue; }
    equal(copy(m[against]), copy(value), name);
  }

  // The normalisation: an object of EXACTLY the fields of the contract comes back complete, in the order of the contract.
  const user = fromFields(contract.USER_FIELDS, EXAMPLE_USER, "USER_FIELDS");
  const checkedOut = fromFields(contract.CHECKED_OUT_FIELDS, EXAMPLE_CHECKED_OUT, "CHECKED_OUT_FIELDS");
  const row = fromFields(contract.ROW_FIELDS, { ...EXAMPLE_ROW, checkedOut: [checkedOut], user }, "ROW_FIELDS");
  const instance = fromFields(contract.INSTANCE_FIELDS, EXAMPLE_INSTANCE, "INSTANCE_FIELDS");
  const response = fromFields(contract.RESPONSE_FIELDS, { ...EXAMPLE_RESPONSE, rows: [row], instances: [...EXAMPLE_RESPONSE.instances, instance] }, "RESPONSE_FIELDS");
  const detail = fromFields(contract.DETAIL_FIELDS, { ...EXAMPLE_DETAIL, row }, "DETAIL_FIELDS");

  const b = m.normGitUser(user);
  equal(b && Object.keys(b), [...contract.USER_FIELDS], "normGitUser: keys");
  equal(b, user, "normGitUser: values");
  const z = m.normGitViewRow(row);
  equal(z && Object.keys(z), [...contract.ROW_FIELDS], "normGitViewRow: keys");
  equal(z?.checkedOut?.[0] && Object.keys(z.checkedOut[0]), [...contract.CHECKED_OUT_FIELDS], "normGitViewRow: keys of checkedOut");
  equal(z, row, "normGitViewRow: values");
  const i = m.normGitInstance(instance);
  equal(i && Object.keys(i), [...contract.INSTANCE_FIELDS], "normGitInstance: keys");
  equal(i, instance, "normGitInstance: values");
  const a = m.normGitView(response);
  equal(Object.keys(a), [...contract.RESPONSE_FIELDS], "normGitView: keys");
  equal(a, response, "normGitView: values");
  const d = m.normGitBranchDetail(detail);
  equal(Object.keys(d), [...contract.DETAIL_FIELDS], "normGitBranchDetail: keys");
  equal(d, detail, "normGitBranchDetail: values");

  // Every word of the contract survives the normalisation.
  for (const group of contract.GROUPS) equal(m.normGitViewRow({ ...row, group })?.group, group, `group "${group}"`);
  for (const state of contract.STATES) equal(m.normGitViewRow({ ...row, state })?.state, state, `state "${state}"`);
  for (const kind of contract.USER_KINDS) equal(m.normGitUser({ ...user, kind })?.kind, kind, `user kind "${kind}"`);
  for (const reason of contract.REASONS) equal(m.normGitInstance({ ...instance, reason })?.reason, reason, `reason "${reason}"`);
  for (const source of contract.MAIN_BRANCH_SOURCES) equal(m.normGitView({ ...response, mainBranch: { name: "x", source } }).mainBranch?.source, source, `main-branch source "${source}"`);
  for (const state of contract.MR_STATES) equal(m.normGitMr({ state, error: "t" })?.state, state, `MR "${state}"`);
  for (let color = 0; color < contract.COLORS; color++) equal(m.normGitInstance({ ...instance, color })?.color, color, `Kennfarbe ${color}`);
  equal(m.normGitInstance({ ...instance, color: contract.COLORS })?.color, null, `identifying colour ${contract.COLORS} (outside)`);

  // The small view: the same field names on the repo of GET …/git.
  const repo = fromFields(contract.GIT_REPO_FIELDS, { ...EXAMPLE_GIT_REPO, branchesRunning: [row] }, "GIT_REPO_FIELDS");
  equal(m.branchesRunningOf(repo), [row], "branchesRunningOf");
  const counter = m.counterOf(repo);
  equal(counter && Object.keys(counter), [...contract.GROUPS], "counterOf: keys");
  equal(counter, repo.counter, "counterOf: values");
  return out;
}

test("web: lib/api/gitView.ts carries every constant of the contract, the normalisation loses no field and no word", async () => {
  const out = webDeviations(await loadWeb());
  assert.deepEqual(out, [], `web ≠ contract.js:\n${out.join("\n")}`);
});

test("web: GitRepo in lib/api/git.ts declares the additional fields of the small view (GIT_REPO_FIELDS)", () => {
  const text = read(src("lib", "api", "git.ts"));
  const header = text.indexOf("export interface GitRepo");
  assert.ok(header >= 0, "export interface GitRepo missing in lib/api/git.ts");
  const body = text.slice(header, text.indexOf("\n}", header));
  for (const f of V.GIT_REPO_FIELDS) assert.match(body, new RegExp(`\\n\\s+${f}\\?:`), `GitRepo without "${f}"`);
});

test("web, counter-proof: a renamed field, the old MR list, a new group and a constant without counterpart are noticed", async () => {
  const renamed = await loadWebSabotaged((q) => {
    assert.ok(q.includes("    user: normGitUser(r.user),"), "the line for the sabotage is no longer in normGitViewRow — follow up");
    return q.replace("    user: normGitUser(r.user),", "    userX: normGitUser(r.user),");
  });
  const out = webDeviations(renamed);
  assert.ok(out.some((z) => z.startsWith("normGitViewRow: keys")), `the renamed field went unnoticed:\n${out.join("\n")}`);

  const withoutError = await loadWebSabotaged((q) => {
    const old = '["no-access", "none", "no-gitlab", "error"] as const';
    assert.ok(q.includes(old), "the MR list no longer stands like this in lib/api/gitView.ts — follow up the sabotage");
    return q.replace(old, '["no-access", "nobody", "no-gitlab"] as const');
  });
  const dev2 = webDeviations(withoutError);
  assert.ok(dev2.some((z) => z.startsWith("MR_STATES")) && dev2.some((z) => z.startsWith('MR "error"')), dev2.join("\n"));

  const real = await loadWeb();
  const dev3 = webDeviations(real, { ...V, GROUPS: [...V.GROUPS, "stash"] });
  assert.ok(dev3.some((z) => z.startsWith("GROUPS")) && dev3.some((z) => z.startsWith('group "stash"')), dev3.join("\n"));
  const dev4 = webDeviations(real, { ...V, NEW_LIST: Object.freeze(["x"]) });
  assert.ok(dev4.some((z) => z.startsWith("NEW_LIST: no counterpart")), dev4.join("\n"));
});

// ── (b) iOS ─────────────────────────────────────────────────────────────────────────────────────

const IOS_MODELS = path.resolve(webDir, "..", "mobile", "CbaseMobile", "Models", "GitViewModels.swift");
const IOS_GIT = path.resolve(webDir, "..", "mobile", "CbaseMobile", "Models", "GitModels.swift");
/** Contract → `static let` in `enum GitViewContract`. The field lists (…_FIELDS) bind the CodingKeys, not this table. */
const IOS_ASSIGNMENT = {
  GROUPS: "groups", STATES: "states", USER_KINDS: "userKinds", REASONS: "reasons", POINTS_MAX: "pointsMax",
  ROWS_MAX: "rowsMax", DETAIL_COMMITS_MAX: "detailCommitsMax", COLORS: "colors", WINDOW: "window",
  WINDOW_DEFAULT: "windowDefault", FETCH_GAP_MS: "fetchGapMs", MAIN_BRANCH_SOURCES: "mainBranchSources",
  MR_STATES: "mrStates",
};
/** Field list → Swift type whose CodingKeys carry exactly these. */
const IOS_TYPES = {
  RESPONSE_FIELDS: "GitViewResponse", INSTANCE_FIELDS: "GitViewInstance", ROW_FIELDS: "GitViewRow",
  CHECKED_OUT_FIELDS: "GitViewCheckedOut", USER_FIELDS: "GitViewUser", DETAIL_FIELDS: "GitViewDetail",
};

/** The value of a `static let name = …` in `enum GitViewContract` as a JS value (list of words, number, word). */
function swiftConstant(text, name) {
  const header = text.indexOf("enum GitViewContract {");
  if (header < 0) return undefined;
  const body = text.slice(header, text.indexOf("\n}", header));
  const m = new RegExp(`static let ${name} = (.+)`).exec(body);
  if (!m) return undefined;
  const w = m[1].trim();
  if (w.startsWith("[")) return [...w.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  if (w.startsWith('"')) return w.slice(1, w.indexOf('"', 1));
  return Number(w.replace(/_/g, ""));
}

/** The cases of the first `enum CodingKeys` after `struct <type>` in source order (also over several `case` lines). */
function swiftCodingKeys(text, type) {
  const header = text.search(new RegExp(`\\n(?:struct|final class|class) ${type}\\b`));
  if (header < 0) return null;
  const start = text.indexOf("enum CodingKeys", header);
  const next = text.slice(header + 1).search(/\n(?:struct|final class|class|enum) \w/);
  if (start < 0 || (next >= 0 && start > header + 1 + next)) return null;
  const body = text.slice(text.indexOf("{", start) + 1, text.indexOf("}", start));
  return body.split("\n").flatMap((z) => {
    const m = /^\s*case (.+)$/.exec(z);
    return m ? m[1].split(",").map((x) => x.trim().split(/\s|=/)[0]).filter(Boolean) : [];
  });
}

function iosDeviations(models, git, contract = V) {
  const out = [];
  const assigned = new Set([...Object.keys(IOS_ASSIGNMENT), ...Object.keys(IOS_TYPES), "GIT_REPO_FIELDS"]);
  for (const k of Object.keys(contract)) if (!assigned.has(k)) out.push(`${k}: no counterpart in GitViewModels.swift`);
  for (const [k, swift] of Object.entries(IOS_ASSIGNMENT)) {
    if (!(k in contract)) continue;
    const holds = swiftConstant(models, swift);
    const desired = Array.isArray(contract[k]) ? [...contract[k]] : contract[k];
    try { assert.deepEqual(holds, desired); } catch { out.push(`${k} ≠ GitViewContract.${swift}: ${JSON.stringify(holds)} instead of ${JSON.stringify(desired)}`); }
  }
  for (const [k, type] of Object.entries(IOS_TYPES)) {
    const holds = swiftCodingKeys(models, type);
    try { assert.deepEqual(holds, [...contract[k]]); } catch { out.push(`${k} ≠ ${type}.CodingKeys: ${JSON.stringify(holds)}`); }
  }
  const repoFields = /enum GitRepoFields \{\s*static let fields = (\[[^\]]*\])/.exec(models);
  const fields = repoFields ? [...repoFields[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]) : null;
  try { assert.deepEqual(fields, [...contract.GIT_REPO_FIELDS]); } catch { out.push(`GIT_REPO_FIELDS ≠ GitRepoFields.fields: ${JSON.stringify(fields)}`); }
  for (const f of contract.GIT_REPO_FIELDS) {
    if (!new RegExp(`var ${f}: `).test(git) || !new RegExp(`forKey: \\.${f}\\)`).test(git)) out.push(`GitRepo (GitModels.swift) does not read "${f}"`);
  }
  return out;
}

test("iOS: GitViewModels.swift carries every constant of the contract, the CodingKeys are exactly its field lists", () => {
  const out = iosDeviations(read(IOS_MODELS), read(IOS_GIT));
  assert.deepEqual(out, [], `iOS ≠ contract.js:\n${out.join("\n")}`);
});

test("iOS, counter-proof: a missing MR state, a renamed key, a new group and an unread repo field are noticed", () => {
  const models = read(IOS_MODELS);
  const git = read(IOS_GIT);
  const old = '["no-access", "none", "no-gitlab", "error"]';
  assert.ok(models.includes(old), "the MR list no longer stands like this in GitViewModels.swift — follow up the sabotage");
  const a1 = iosDeviations(models.replace(old, '["no-access", "nobody", "no-gitlab"]'), git);
  assert.ok(a1.some((z) => z.startsWith("MR_STATES")), a1.join("\n"));
  const a2 = iosDeviations(models.replace("case instance, worktree, notBackedUp, chats", "case instance, worktree, notBackedUp, chat"), git);
  assert.ok(a2.some((z) => z.startsWith("CHECKED_OUT_FIELDS")), a2.join("\n"));
  const a3 = iosDeviations(models, git, { ...V, GROUPS: [...V.GROUPS, "stash"] });
  assert.ok(a3.some((z) => z.startsWith("GROUPS")), a3.join("\n"));
  const a4 = iosDeviations(models, git.replace(/forKey: \.counter\)/g, "forKey: .counterAlt)"));
  assert.ok(a4.some((z) => z.includes('"counter"')), a4.join("\n"));
  const a5 = iosDeviations(models, git, { ...V, NEW_LIST: Object.freeze(["x"]) });
  assert.ok(a5.some((z) => z.startsWith("NEW_LIST: no counterpart")), a5.join("\n"));
});
