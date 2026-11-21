// The tab row of the Coding department: no numbers, and the same list in web and iOS.
//
// THREE promises, and the second is worth more than its occasion.
//
// (a) NO NUMBER. The first seven tabs used to carry a counter in a capsule (chats, agents, workflows, projects, MCP, context,
//     credentials). They counted STOCKS, and a stock stands on its target page anyway; in the navigation it was only noise that
//     twitched on every load. "Gone" means gone: no dot (`warn`) and no dimmed number as a substitute either. Without a guard this
//     is a matter of taste that comes back with the next "a small number would help" and nobody notices because nothing breaks.
//     On the mobile side this promise is bound to the THING, not to the name of a computation: `count(for:)` is gone, but a number
//     can also be fetched directly from `state.overview`. So the row itself is measured.
//
// (b) ONE LIST, TWO CLIENTS. Which categories the Coding department has is written twice:
//       1. `const tabItems: Tab[]`  in web/src/app/workspaces/page.tsx (the tab row)
//       2. `enum WorkspaceCategory` in mobile/CbaseMobile/Models/AppState.swift (the mobile list; the right drawer and the Coding overview
//          BOTH read `state.categories` from it)
//     If they drift apart, a category is missing on ONE device, with no error and no gap in the picture. The guard must therefore
//     see ADDING, not only renaming, and a regex only sees the spelling it knows. Both anchors therefore count how many entries
//     they READ against the number of lines that look like an entry: a tab `key: "codeReview"` or a case `case skills = "skills"`
//     would otherwise slip past and the test would stay green while the page is missing on a device.
//
// (c) ONE KEY, ONE PLACE. The tab key used to stand FOUR times on the Workspaces page: order of the glide effect, type of the tab
//     state, allow list of the restore after reload, and the tab list. If a new key was missing from the allow list, the tab silently
//     jumped back to "Chats" after reload, and (b) did not see it because it reads only the tab list. Now the keys stand in
//     web/src/lib/coding-tabs.ts; order, type and allow list derive from it, and the page's tab list is bound to that list (both
//     directions, also the order). A second enumeration on the page is red.
//
// (d) ONE TAB, TWO KINDS. The library of dynamic workflows is no tab of its own (web) and no category of its own (iOS), but the
//     kind "Dynamic" next to "Graph": a segment bar in WorkflowsTab.tsx (`data-wf-kind`) and Workflows/WorkflowKindBar.swift
//     (`wf-kind-*`), the same values in the same order as `WORKFLOW_KINDS`. The old key "dynworkflows" is a named legacy in BOTH
//     clients: a stored value leads after reload or restart to "workflows" + "dynamic", never silently to "Chats", the same silent
//     fallback (c) was built against.
//
// (e) THE CODE TAB STAYS MOUNTED. The page used to unmount it on tab change (`{tab === "code" && ...}`): open tabs with unsaved
//     changes and a held copy lived only in its state and were lost without asking, in main and copy alike. Now it stays mounted
//     after the first opening like chats and terminal (`hidden`), and while hidden the ticks pause (`active`: the editor's git tick,
//     the column's git state).
//     COUNTER-TEST: with the condition on `tab` red; `active` removed from the editor's tick => red.
//
// Read BY PATH, from both trees, without an import from mobile/. Whoever moves one of the files updates the line here.
//
// Run:  node --test web/test/coding-tab.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const SOURCE_WEB = path.join(repo, "web", "src", "app", "workspaces", "page.tsx");
const SOURCE_IOS = path.join(repo, "mobile", "CbaseMobile", "Models", "AppState.swift");
const SOURCE_DRAWER = path.join(repo, "mobile", "CbaseMobile", "Shell", "AppShell.swift");
const SOURCE_OVERVIEW = path.join(repo, "mobile", "CbaseMobile", "Code", "CodingOverview.swift");
const SOURCE_KIT = path.join(repo, "web", "src", "components", "CbKit.tsx");

const SOURCE_KEY = path.join(repo, "web", "src", "lib", "coding-tabs.ts");
const SOURCE_WF_TAB = path.join(repo, "web", "src", "components", "workflow", "WorkflowsTab.tsx");
const SOURCE_I18N = path.join(repo, "web", "src", "lib", "i18n-de.ts");
const SOURCE_IOS_KIND = path.join(repo, "mobile", "CbaseMobile", "Workflows", "WorkflowKindBar.swift");
const SOURCE_IOS_CONTENT = path.join(repo, "mobile", "CbaseMobile", "Shell", "CategoryContent.swift");
const SOURCE_IOS_LEFT = path.join(repo, "mobile", "CbaseMobile", "Shell", "LeftDrawerBody.swift");

// (c): the key list, compiled with tsc (leaf module without imports); the test asks the same function as the page.
const output = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-coding-tab-"));
after(() => { try { fs.rmSync(output, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });
execFileSync(process.execPath, [
  path.join(repo, "web", "node_modules", "typescript", "bin", "tsc"), SOURCE_KEY,
  "--outDir", output, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const key = await import(pathToFileURL(path.join(output, "coding-tabs.js")).href);

const read = (p) => fs.readFileSync(p, "utf8");
const short = (p) => path.relative(repo, p);

// Comment lines drop out BEFORE every measurement: the reason is written where it applies, and a comment above a line ("a counter
// used to be here") is just what this test asks for and must not turn it red.
const withoutComments = (text) =>
  text.split("\n").filter((z) => !/^\s*(\/\/|\/\*|\*)/.test(z));

// Every anchor THROWS if it grasps at nothing. The silent death of a source measurement is the empty set: equal to every other
// empty set, and the test stays green without having measured anything.
function cut(sourcePath, pattern, declaration) {
  const block = read(sourcePath).match(pattern);
  assert.ok(
    block,
    `declaration "${declaration}" not found in ${short(sourcePath)} — ` +
      "renamed or reformatted? Update the anchor here, do NOT delete the test.",
  );
  return block[1];
}

// And every anchor counts what it SKIPPED. A regex measures the spelling it knows; the next category is written in one nobody
// thought of. Whoever counts only the hits takes the overlooked for "does not exist", and that is exactly the case this guard
// was built for.
function complete(rows, read, looks, sourcePath, hint) {
  const candidates = rows.filter(looks);
  assert.equal(
    candidates.length,
    read.length,
    `${short(sourcePath)}: ${candidates.length} lines look like an entry, entries read: ` +
      `${read.length}. ${hint}\nRows:\n` + candidates.map((z) => "  " + z.trim()).join("\n") +
      `\nRead: ${read.join(", ")}`,
  );
}

function tabRows() {
  const block = cut(
    SOURCE_WEB,
    /const tabItems: Tab\[\] = o \? \[\n([\s\S]*?)\n {2}\] : \[\];/,
    "const tabItems: Tab[] = o ? [",
  );
  return withoutComments(block);
}

function webKey() {
  const rows = tabRows();
  const keys = rows.flatMap((z) => [...z.matchAll(/\bkey: "([a-z]+)"/g)].map((m) => m[1]));
  complete(
    rows, keys, (z) => /\bkey\s*:/.test(z), SOURCE_WEB,
    'A tab key that the regex /key: "([a-z]+)"/ does not read (capital letter, hyphen, digit) would be in NO assignment of this ' +
      "test, and the category would be missing unnoticed on the iPhone. Either write the key lower case and in one word, or " +
      "extend the regex here.",
  );
  // The bound stands EXACTLY on today's number (13 keys): a lower bound with room below lets the silent loss of a tab through, and
  // that is just what it should catch. Whoever removes a tab on purpose moves it along.
  assert.ok(keys.length >= 13, `Only ${keys.length} tabs found: does the regex still match?`);
  return keys;
}

function iosCategories() {
  const rows = withoutComments(cut(
    SOURCE_IOS,
    /enum WorkspaceCategory: String[^{]*\{\n([\s\S]*?)\n {4}var id: String \{ rawValue \}/,
    "enum WorkspaceCategory: String ...",
  ));
  const cases = rows.flatMap((z) => [...z.matchAll(/^ {4}case (\w+)$/g)].map((m) => m[1]));
  complete(
    rows, cases, (z) => /^\s*case\b/.test(z), SOURCE_IOS,
    "A case with an explicit raw value (`case x = \"x\"`) or two cases on one line (`case x, y`) would slip past the regex: " +
      "the category would not exist for this test, and a missing web counterpart would stay green. One case per line, " +
      "without raw value.",
  );
  // Same rule as in the web part: exactly today's number (`.dynworkflows` is the kind "Dynamic" under `.workflows`).
  assert.ok(cases.length >= 10, `Only ${cases.length} cases found: does the regex still match?`);
  return cases;
}

// The names may differ between the two trees. The assignment is therefore a TABLE and not a computation, and because it would be
// a third copy as soon as it concealed something, it is complete ON BOTH SIDES: a key missing here is red, whichever side it is on.
const ASSIGNMENT = {
  chats: "chats",
  // The scheduled jobs, directly after Chats; mobile `WorkspaceCategory.scheduled` after `.chats`.
  scheduled: "scheduled",
  agents: "agents",
  // With two kinds (Graph, Dynamic): the library of dynamic workflows is no entry of its own, see promise (d).
  workflows: "workflows",
  projects: "projects",
  // In an entered project "project" stands in the same place: the project's own view. On mobile that is the SAME category
  // `.projects`, which in an entered project opens the view instead of the list; the two web tabs exclude each other
  // (ONLY_WORKSPACE / ONLY_PROJECT) and stand side by side, so in the expectation they collapse into ONE entry
  // (`withoutNeighborDouble` below).
  project: "projects",
  mcp: "mcp",
  context: "context",
  vars: "vars",
  // A Coding tab, directly after credentials, on both levels; mobile `WorkspaceCategory.skills` after `.vars`.
  skills: "skills",
  code: "code",
  terminal: "terminal",
  browser: "browser",

};

test("Coding tab row: no counter, no dot, no capsule", () => {
  const rows = tabRows();

  const withCount = rows.filter((z) => /(^|[\s{,])n\s*:/.test(z));
  assert.deepEqual(
    withCount.map((z) => z.trim()),
    [],
    "The Coding tab row carries a number again. The counters were abolished on purpose: they counted STOCKS, and a stock stands " +
      "on its target page anyway. If the number really comes back, that is the maintainer's decision and this line is where " +
      "it is justified.",
  );

  const withPoint = rows.filter((z) => /(^|[\s{,])(warn|tone)\s*:/.test(z));
  assert.deepEqual(
    withPoint.map((z) => z.trim()),
    [],
    "\"Gone\" includes the substitute: no warning dot on a Coding tab that stands in for the abolished number.",
  );

  console.log(`  [coding tabs] ${webKey().length} tabs, 0 counters, 0 dots`);
});

test("Coding categories: web and iOS carry the same list in the same order", () => {
  const web = webKey();
  const ios = iosCategories();

  console.log(`  [coding tabs] ${web.length} tabs on the web, ${ios.length} cases on iOS`);

  const unknownInWeb = web.filter((k) => !(k in ASSIGNMENT));
  assert.deepEqual(
    unknownInWeb,
    [],
    "These web tabs are in no assignment of this test: " + unknownInWeb.join(", ") +
      ": either the mobile counterpart is missing, or the category is web-only on purpose and belongs in the ASSIGNMENT table " +
      "with `null` and a reason.",
  );

  // Two web tabs of the same mobile category that stand SIDE BY SIDE and exclude each other via the level ("projects" /
  // "project") are one case on the iPhone; otherwise `.projects` would stand twice in the expectation.
  const withoutNeighborDouble = (list) => list.filter((k, i) => i === 0 || list[i - 1] !== k);
  const expectedIos = withoutNeighborDouble(web.map((k) => ASSIGNMENT[k]).filter(Boolean));
  const onlyOnIos = ios.filter((k) => !expectedIos.includes(k));
  assert.deepEqual(
    onlyOnIos,
    [],
    "These categories exist ONLY on mobile; on the web the page is not reachable: " +
      onlyOnIos.join(", "),
  );

  const missingOnIos = web.filter((k) => ASSIGNMENT[k] && !ios.includes(ASSIGNMENT[k]));
  assert.deepEqual(
    missingOnIos,
    [],
    "These Coding categories are missing on the IPHONE; the page is not reachable there, and nobody sees the gap: " +
      missingOnIos.join(", "),
  );

  // The order IS a promise here (unlike the app-agent catalog): in both clients it is the way through the department, first what
  // the agents work with, then the tools. Two devices sorting the same entries differently cost the user a reorientation at every
  // switch.
  assert.deepEqual(
    ios,
    expectedIos,
    "Web and iOS sort the Coding categories differently. Web (without the web-only entries): " +
      expectedIos.join(" → ") + "; iOS: " + ios.join(" → "),
  );
});

test("Coding categories: both mobile display places read the same list and show no number", () => {
  // Otherwise the binding above would be only half true: an enumeration of its own in the drawer or in the overview would be a
  // THIRD list this test never sees.
  const drawer = read(SOURCE_DRAWER);
  const overview = read(SOURCE_OVERVIEW);

  assert.match(
    drawer,
    /ForEach\(state\.categories\)/,
    `The right drawer (${short(SOURCE_DRAWER)}) no longer enumerates the Coding categories from ` +
      "`state.categories`: an own list there is a third truth.",
  );
  assert.match(
    overview,
    /state\.categories\.filter/,
    `The Coding overview (${short(SOURCE_OVERVIEW)}) no longer enumerates the categories from ` +
      "`state.categories`: see above.",
  );

  // Promise (a) on the mobile side, measured at the THING. Forbidding `state.count(for:)` would block the one way that is closed
  // anyway; next time the number comes directly from `state.overview` or a new helper. So the ROW is measured: whatever brings a
  // number onto the screen stands in its body.
  const ROWS = [
    {
      path: SOURCE_DRAWER,
      pattern: /private func categoryRow\(_ category: WorkspaceCategory\) -> some View \{\n([\s\S]*?)\n {8}\.accessibilityIdentifier\("category-/,
      declaration: "private func categoryRow(_ category: WorkspaceCategory) -> some View",
      location: "the right drawer",
    },
    {
      path: SOURCE_OVERVIEW,
      pattern: /private func categoryRow\(_ category: WorkspaceCategory\) -> some View \{\n([\s\S]*?)\n {8}\.accessibilityIdentifier\("coding-overview-/,
      declaration: "private func categoryRow(_ category: WorkspaceCategory) -> some View",
      location: "the Coding overview",
    },
  ];
  // `Text(verbatim:)` renders an interpolated number, `monospacedDigit` and `Capsule` are the form the old counter had. The labels
  // themselves go through `L(...)`; none of the three names has another purpose in these two bodies.
  const FORBIDDEN = [
    [/Text\(verbatim:/, "Text(verbatim:), an interpolated number at the category"],
    [/monospacedDigit/, "monospacedDigit(), the digit form of the old counter"],
    [/Capsule\(/, "Capsule(), the capsule the old counter sat in"],
  ];
  for (const { path: filePath, pattern, declaration, location } of ROWS) {
    const body = cut(filePath, pattern, declaration);
    for (const [character, what] of FORBIDDEN) {
      assert.doesNotMatch(
        body,
        character,
        `${location} (${short(filePath)}) shows a number per Coding category again: ${what}. It was abolished in both clients: ` +
          "see the first test.",
      );
    }
  }
});



test("Coding tab keys: ONE place; the page's tab list is bound to lib/coding-tabs.ts", () => {
  // Promise (c). The tab list contains "projects" only on workspace level (inserted conditionally); the source text is read, so all
  // keys stand there in the order of the row.
  const web = webKey();
  const list = [...key.CODING_TABS];
  assert.deepEqual(
    web, list,
    `The tab list in ${short(SOURCE_WEB)} and the keys in ${short(SOURCE_KEY)} drift apart. ` +
      "A tab ONLY in the row has no type and silently falls back to \"Chats\" after reload; a key ONLY in the " +
      `list is a tab nobody sees. Row: ${web.join(", ")}; list: ${list.join(", ")}`,
  );

  // No second enumeration on the page: no allow list of comparisons, no order of its own, no literal type.
  const page = withoutComments(read(SOURCE_WEB)).join("\n");
  const second = [
    [/savedTab\s*===\s*"/, "an allow list of `savedTab === \"...\"`"],
    [/\bTAB_ORDER\b/, "an order of its own `TAB_ORDER`"],
    [/useState<\s*"chats"\s*\|/, "a literal type of the tab state"],
  ];
  for (const [pattern, what] of second) {
    assert.doesNotMatch(page, pattern, `${short(SOURCE_WEB)} has ${what} again; the keys stand in ${short(SOURCE_KEY)}.`);
  }
  assert.match(page, /useState<CodingTab>\(/, `${short(SOURCE_WEB)}: the tab state is no longer typed as CodingTab.`);
  assert.match(page, /savedTabOf\(savedTab, /, `${short(SOURCE_WEB)}: the restore after reload no longer asks savedTab.`);

  // And the restore itself: every key comes back, except for the named exceptions. A tab of the OTHER level (ONLY_WORKSPACE in the
  // project, ONLY_PROJECT in the workspace) leads to its counterpart, or to "chats" without one (both directions).
  for (const k of list) {
    const expected = key.NOT_RESTORED.includes(k) ? "chats" : k;
    const against = key.LEVELS_COUNTERPART[k] ?? "chats";
    const inWorkspace = key.ONLY_PROJECT.includes(k) ? against : expected;
    assert.equal(key.savedTab(k, false), inWorkspace, `workspace level: ${k}`);
    const inProject = key.ONLY_WORKSPACE.includes(k) ? against : expected;
    assert.equal(key.savedTab(k, true), inProject, `in the project: ${k}`);
  }
  // The two lists exclude each other, each side has its counterpart on the other, and it stands in the row exactly there (directly
  // side by side, inserted conditionally via `enteredProject`).
  assert.deepEqual(key.ONLY_WORKSPACE.filter((k) => key.ONLY_PROJECT.includes(k)), [], "a tab is in ONLY_WORKSPACE AND ONLY_PROJECT");
  assert.equal(key.savedTab("projects", true), "project", "\"projects\" in an entered project => \"project\"");
  assert.equal(key.savedTab("project", false), "projects", "\"project\" on workspace level => \"projects\"");
  for (const k of [...key.ONLY_WORKSPACE, ...key.ONLY_PROJECT]) {
    const g = key.LEVELS_COUNTERPART[k];
    if (g) assert.equal(key.LEVELS_COUNTERPART[g], k, `the counterpart of ${k} does not lead back`);
  }
  assert.equal(key.tabOnLevel("project", true), "project");
  assert.equal(key.tabOnLevel("projects", false), "projects");
  assert.equal(key.tabOnLevel("chats", true), "chats");
  const pageRaw = read(SOURCE_WEB);
  assert.match(pageRaw, /\.\.\.\(!enteredProject \? \[\{ key: "projects"/, "\"projects\" no longer stands conditionally on workspace level in the row");
  assert.match(pageRaw, /\.\.\.\(enteredProject \? \[\{ key: "project",/, "\"project\" does not stand conditionally in the entered project in the row");
  assert.match(pageRaw, /tabOnLevel\(tab, !!enteredProject\)/, "the level switch does not lead the tab via tabOnLevel");
  assert.equal(key.savedTab(null, false), "chats");
  assert.equal(key.savedTab("exists-not", false), "chats");
  // Promise (d): the old tab "dynworkflows" is no tab any more, but a stored value does NOT fall back to "chats".
  assert.equal(key.isCodingTab("dynworkflows"), false, "\"dynworkflows\" is no tab of its own any more");
  assert.equal(key.savedTab("dynworkflows", false), "workflows", "old tab \"dynworkflows\" (workspace level) => \"workflows\"");
  assert.equal(key.savedTab("dynworkflows", true), "workflows", "old tab \"dynworkflows\" (in the project) => \"workflows\"");
  console.log(`  [coding tabs] ${list.length} keys in one place, restored except: ${key.NOT_RESTORED.join(", ")}`);
});

test("Workflows: ONE tab with two kinds; legacy \"dynworkflows\", segment bar in web and iOS", () => {
  // Promise (d). First the computation (the same function as the page), then the sources that carry it.
  assert.deepEqual([...key.WORKFLOW_KINDS], ["graph", "dynamic"], "The kinds are \"graph\", \"dynamic\", in this order");

  // Every legacy leads to a living tab and is none itself; otherwise it would stand in the row or lead nowhere.
  for (const [old, fresh] of Object.entries(key.OLD_TAB)) {
    assert.equal(key.isCodingTab(old), false, `legacy "${old}" is still in CODING_TABS`);
    assert.equal(key.isCodingTab(fresh), true, `legacy "${old}" leads to "${fresh}", which does not exist`);
  }
  assert.deepEqual(Object.keys(key.OLD_TAB), ["dynworkflows"], "The named legacies have changed: justify here");
  // No prototype key as legacy: "constructor" is no old tab.
  assert.equal(key.savedTab("constructor", false), "chats");

  const kind = key.savedWorkflowKind;
  const MATRIX = [
    [null, null, "graph", "nothing stored => default"],
    [null, "workflows", "graph", "tab without kind => default"],
    ["dynamic", "workflows", "dynamic", "stored kind applies"],
    ["graph", "workflows", "graph", "stored kind applies"],
    ["nonsense", "workflows", "graph", "unknown kind => default"],
    [null, "dynworkflows", "dynamic", "old tab \"dynworkflows\" => \"dynamic\""],
    ["graph", "dynworkflows", "dynamic", "the old tab takes precedence over a stored kind: it stood for exactly this page"],
    ["dynamic", "chats", "dynamic", "the kind also applies while another tab is open"],
  ];
  for (const [saved, tabValue, expected, why] of MATRIX) {
    assert.equal(kind(saved, tabValue), expected, `savedWorkflowKind(${saved}, ${tabValue}): ${why}`);
  }

  // The page: no second way to the library, the legacy only via lib/coding-tabs.ts, the kind in the same move as the tab. Comments
  // drop out beforehand.
  const page = withoutComments(read(SOURCE_WEB)).join("\n");
  assert.doesNotMatch(page, /"dynworkflows"/, `${short(SOURCE_WEB)} knows the key "dynworkflows" again; the legacy stands in ${short(SOURCE_KEY)}.`);
  assert.doesNotMatch(page, /<DynWorkflowsPane\b/, `${short(SOURCE_WEB)} renders the library itself again; it is the kind "Dynamic" in WorkflowsTab (two places).`);
  assert.match(page, /setWfKind\(savedWorkflowKind\(savedKind, savedTab\)\)/, `${short(SOURCE_WEB)}: the kind after reload does not ask savedWorkflowKind.`);
  assert.match(page, /<WorkflowsTab[\s\S]*?kind=\{wfKind\}[\s\S]*?onKindChange=\{setWfKind\}/, `${short(SOURCE_WEB)}: WorkflowsTab does not get the kind.`);
  // Before the first await of open(): otherwise the store effect would write the old workspace's kind under the new id.
  const open = cut(SOURCE_WEB, /\n {2}async function open\(id: string\) \{\n([\s\S]*?)\n {2}\}\n/, "async function open(id: string)");
  const iKind = open.indexOf("setWfKind(");
  const iAwait = open.indexOf("await ");
  assert.ok(iKind >= 0 && iAwait >= 0 && iKind < iAwait, "open(): setWfKind is not before the first await");
  assert.match(open, /try \{ savedKind = localStorage\.getItem\(`cbase-wf-kind:\$\{id\}`\); \} catch \{\}/, "open(): the kind is not read in try/catch");
  assert.match(page, /try \{ localStorage\.setItem\(`cbase-wf-kind:\$\{activeId\}`, wfKind\); \} catch \{\}/, "The kind is not remembered per workspace in try/catch");

  // The bar: kit segments, an identifier per kind on the BUTTON, no number (promise (a) holds here too), the library as a branch
  // of the kind, and the graph sub-bar only for "graph" (the run history shows only graph runs).
  const tab = withoutComments(read(SOURCE_WF_TAB)).join("\n");
  assert.match(tab, /<Segments\s+label=\{t\("Workflow type"\)\}\s+items=\{WORKFLOW_KINDS\.map\(\(a\) => \(\{ key: a, label: kindName\(a\), data: \{ "data-wf-kind": a \} \}\)\)\}/,
    `${short(SOURCE_WF_TAB)}: the kind bar is no longer the kit segments over WORKFLOW_KINDS with data-wf-kind per button.`);
  assert.doesNotMatch(tab, /WORKFLOW_KINDS\.map\([^\n]*\bn\s*:/, `${short(SOURCE_WF_TAB)}: the kind bar carries a number.`);
  assert.match(tab, /kind === "dynamic"\s*\?\s*<DynWorkflowsPane workspaceId=\{workspaceId\} projectId=\{projectId\} \/>/, `${short(SOURCE_WF_TAB)}: "Dynamic" does not show the library.`);
  assert.match(tab, /\{kind === "graph" && \(/, `${short(SOURCE_WF_TAB)}: the sub-bar workflows / run history is not only for "graph".`);
  assert.match(read(SOURCE_KIT), /\{\.\.\.it\.data\}/, `${short(SOURCE_KIT)}: Segments no longer spreads \`data\` on the button; data-wf-kind would never arrive.`);
  const en = read(SOURCE_I18N);
  for (const k of ["Graph", "Dynamic", "Workflow type"]) {
    assert.equal((en.match(new RegExp(`^\\s*"${k}":`, "gm")) || []).length, 1, `${short(SOURCE_I18N)}: "${k}" is not there exactly once`);
  }

  // iOS: the same kinds in the same order, the bar with CbSegments without a number, the content per kind, the legacy in
  // AppState.enter, and the left drawer no longer knows a category `.dynworkflows`.
  const appState = read(SOURCE_IOS);
  const iosKinds = [...cut(SOURCE_IOS, /enum WorkflowKind: String, CaseIterable, Sendable \{\n([\s\S]*?)\n\}/, "enum WorkflowKind")
    .matchAll(/^ {4}case (\w+)$/gm)].map((m) => m[1]);
  assert.deepEqual(iosKinds, [...key.WORKFLOW_KINDS], "iOS `WorkflowKind` and web `WORKFLOW_KINDS` drift apart");
  assert.match(appState, /static let legacyDynworkflows = "dynworkflows"/, `${short(SOURCE_IOS)}: the named legacy is missing`);
  // The choice is kept: remembered per workspace in didSet, read in enter AFTER setting activeWorkspaceId; otherwise the kind of
  // the new workspace lands under the id of the old one.
  assert.match(appState, /@Published var workflowKind: WorkflowKind = \.graph \{\n\s*didSet \{\n\s*if let id = activeWorkspaceId \{ defaults\.set\(workflowKind\.rawValue, forKey: "cbase\.mobile\.wfart:\\\(id\)"\) \}/,
    `${short(SOURCE_IOS)}: the kind is not remembered per workspace`);
  assert.match(appState, /func enter\(workspaceId: String, restore: Bool = false\) async \{\n\s*let changed = workspaceId != activeWorkspaceId\n\s*activeWorkspaceId = workspaceId\n[\s\S]*?defaults\.string\(forKey: "cbase\.mobile\.wfart:\\\(workspaceId\)"\)\.flatMap\(WorkflowKind\.init\(rawValue:\)\)\n\s*workflowKind = savedKind \?\? \.graph/,
    `${short(SOURCE_IOS)}: enter does not read the remembered kind (or before activeWorkspaceId)`);
  assert.match(appState, /raw == WorkspaceCategory\.legacyDynworkflows \{\n[^\n]*\n\s*category = \.workflows\n\s*workflowKind = \.dynamic/,
    `${short(SOURCE_IOS)}: a stored "dynworkflows" does not lead to .workflows + .dynamic`);
  const bar = read(SOURCE_IOS_KIND);
  assert.match(bar, /CbSegments\(\s*options: WorkflowKind\.allCases\.map/, `${short(SOURCE_IOS_KIND)}: the bar is not CbSegments over WorkflowKind.allCases`);
  assert.match(bar, /id: "wf-kind-\\\(kind\.rawValue\)"/, `${short(SOURCE_IOS_KIND)}: the identifier per segment is not wf-kind-<kind>`);
  assert.doesNotMatch(bar, /count:/, `${short(SOURCE_IOS_KIND)}: the kind bar carries a number`);
  assert.doesNotMatch(bar, /\.accessibilityIdentifier/, `${short(SOURCE_IOS_KIND)}: an identifier on the bar overwrites those of the buttons`);
  const content = read(SOURCE_IOS_CONTENT);
  assert.match(content, /case \.workflows:[\s\S]*?switch state\.workflowKind \{\s*case \.graph:\s*WorkflowsPane\([\s\S]*?case \.dynamic:\s*DynWorkflowsPane\(/,
    `${short(SOURCE_IOS_CONTENT)}: .workflows does not switch per kind to WorkflowsPane / DynWorkflowsPane`);
  assert.doesNotMatch(read(SOURCE_IOS_LEFT), /\.dynworkflows\b/, `${short(SOURCE_IOS_LEFT)}: the left drawer still knows the category .dynworkflows`);
  console.log("  [coding tabs] workflows: kinds " + key.WORKFLOW_KINDS.join(" · ") + ", legacies: " + Object.keys(key.OLD_TAB).join(", "));
});

test("Agents: three kinds (subagents, outer loop, instructions), the same list in web and iOS", () => {
  // The kind list is bound. First the computation, then the bar (kit segments over AGENT_KINDS with data-agents-kind per button,
  // without a number), the branch per kind, then iOS `AgentKind`.
  assert.deepEqual([...key.AGENT_KINDS], ["subagents", "outerloop", "instructions"], "The kinds are \"subagents\", \"outerloop\", \"instructions\", in this order");
  for (const [raw, expected] of [[null, "subagents"], ["instructions", "instructions"], ["outerloop", "outerloop"], ["nonsense", "subagents"], ["constructor", "subagents"]]) {
    assert.equal(key.savedAgentKind(raw), expected, `savedAgentKind(${raw})`);
  }
  const SOURCE_AG_TAB = path.join(repo, "web", "src", "components", "outerloop", "AgentsTab.tsx");
  const tab = withoutComments(read(SOURCE_AG_TAB)).join("\n");
  assert.match(tab, /<Segments\s+label=\{t\("Kind of agents"\)\}\s+items=\{AGENT_KINDS\.map\(\(a\) => \(\{ key: a, label: kindName\(a\), data: \{ "data-agents-kind": a \} \}\)\)\}/,
    `${short(SOURCE_AG_TAB)}: the kind bar is no longer the kit segments over AGENT_KINDS with data-agents-kind per button.`);
  assert.doesNotMatch(tab, /AGENT_KINDS\.map\([^\n]*\bn\s*:/, `${short(SOURCE_AG_TAB)}: the kind bar carries a number.`);
  assert.match(tab, /kind === "instructions"\s*\?\s*<AgentInstructions workspaceId=\{workspaceId\} projectId=\{projectId\} \/>/, `${short(SOURCE_AG_TAB)}: "Instructions" does not show AgentInstructions.`);
  const en = read(SOURCE_I18N);
  for (const k of ["Subagents", "Outer loop", "Instructions", "Kind of agents"]) {
    assert.equal((en.match(new RegExp(`^\\s*"${k}":`, "gm")) || []).length, 1, `${short(SOURCE_I18N)}: "${k}" is not there exactly once`);
  }
  const iosKinds = [...cut(SOURCE_IOS, /enum AgentKind: String, CaseIterable, Sendable \{\n([\s\S]*?)\n\}/, "enum AgentKind")
    .matchAll(/^ {4}case (\w+)$/gm)].map((m) => m[1]);
  assert.deepEqual(iosKinds, [...key.AGENT_KINDS], "iOS `AgentKind` and web `AGENT_KINDS` drift apart");
  console.log("  [coding tabs] agents: kinds " + key.AGENT_KINDS.join(" · "));
});

test("(e) the Code tab is not torn down on tab change: hidden like chats and terminal, no tick while hidden", () => {
  const page = withoutComments(read(SOURCE_WEB)).join("\n");
  const start = page.indexOf("<CodeArea");
  assert.ok(start > 0, `${short(SOURCE_WEB)}: <CodeArea not found: update the anchor, do NOT delete the test`);
  // The block around the area: `{<condition> && (` ... `<div className=...>` ... `<CodeArea`.
  const on = page.lastIndexOf("&& (", start);
  const condition = page.slice(page.lastIndexOf("{", on) + 1, on);
  const wrapper = page.slice(on, start);
  assert.ok(on > 0 && condition.length < 80, `${short(SOURCE_WEB)}: the condition before <CodeArea cannot be read: ${JSON.stringify(condition)}`);
  assert.ok(!/\btab\b/.test(condition), `${short(SOURCE_WEB)}: the Code tab depends on the open tab (${condition.trim()}); a tab change tears it down, unsaved tabs and "held" are gone`);
  assert.match(wrapper, /tab === "code" \? [^:]+ : "hidden"/, `${short(SOURCE_WEB)}: the Code tab's wrapper is not hidden via hidden`);
  const element = page.slice(start, page.indexOf("/>", start));
  assert.match(element, /active=\{tab === "code"\}/, `${short(SOURCE_WEB)}: <CodeArea> does not learn whether it is visible (ticks would keep running while hidden)`);
  // And no tick while hidden: the area passes `active` to editor and git column (both levels), the editor pauses its git tick, the
  // column does not read the git state.
  const area = read(path.join(repo, "web", "src", "components", "CodeArea.tsx"));
  assert.equal((area.match(/active=\{active\}/g) ?? []).length, 5, "CodeArea.tsx: `active` does not go to CodePane and GitSidebar of both levels (and the project area)");
  const pane = read(path.join(repo, "web", "src", "components", "CodePane.tsx"));
  // The own tick does not run when CONTROLLED either (`isControlled`): in the chat the area reads the shared git state
  // (useGitState), no second poller; web/test/chat-tabs.test.mjs holds that (source).
  assert.match(pane, /if \(!isActive \|\| isControlled\) return;\s*refreshGit\(\);[\s\S]{0,240}setInterval\(refreshGit, 8000\)[\s\S]{0,120}\}, \[refreshGit, isActive, isControlled\]\);/, "CodePane.tsx: the git tick also runs while hidden (or controlled)");
  // One editor per group: EACH measures anew when becoming visible, not only the active one.
  assert.match(pane, /if \(isActive\) for \(const r of views\.current\.values\(\)\) r\.current\?\.view\?\.requestMeasure\(\)/, "CodePane.tsx: CodeMirror does not measure anew when becoming visible");
  const git = read(path.join(repo, "web", "src", "components", "GitSidebar.tsx"));
  assert.match(git, /useGitState\(active \? apiBase : null, chatId, instance\)/, "GitSidebar.tsx: the column also reads the git state while hidden");
});
