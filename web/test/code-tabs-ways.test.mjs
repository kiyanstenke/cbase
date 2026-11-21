// Code tabs in the chat: source guards over the ways a diff or a file opens in the chat. Diffs from the git bar in the chat open a
// tab instead of the modal.
//
// What hangs here and why it is a guard ("execution side = description side": EVERY way that opened a DiffModal in the chat opens a
// tab; the guard counts the ways):
//   (1) The ways of the git bar: in GitSidebar.tsx EXACTLY five places name a diff source (conflict, staged, unstaged, stash,
//       history), in git-bar/GitGraph.tsx EXACTLY two (file of a commit, whole commit), all via `onDiff`/`showDiff`. They reach the
//       modal only via `showDiff`, and that asks the chat bar's callback (`onDiffTab`) FIRST. A new way past `showDiff` (an
//       `openFileDiff` at the FileRow, a `setModal({ kind: "diff" ...` in the body) is red, and so is a way that disappears.
//   (2) Only the chat bar gives the callback (Coding -> Files and Projects -> Git keep the modal), and only it sends `openDiffTab`
//       with the target the bar shows: in chat mode `null` (= the chat's, computed in the hook), with a choice the instance.
//   (3) `DiffSource` is defined EXACTLY ONCE (lib/chat-tabs.ts).
//   (4) The file name of an Edit/MultiEdit/Write row in the history (AssistantBlocks.tsx) is a button ONLY with a path RELATIVE to
//       the chat's target (lib/chat-tabs.ts `relativeToRoot`, checked on the model there): no button without context, none for a
//       path outside, none that sends the raw path; the stage sets the context from the root of the chat's target.
//
// COUNTER-TESTS built in: every sabotage is a copy of the sources with ONE changed spot (the spot must appear exactly once); the
// check must throw on each.
//
// Run:  node --test web/test/code-tabs-ways.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const srcDir = path.join(webDir, "src");
const read = (rel) => fs.readFileSync(path.join(webDir, rel), "utf8");
// Without comments (whole comment lines, block comments, JSX comments): a comment that names a call is not a call.
const code = (s) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((z) => !/^\s*\/\//.test(z)).join("\n");

const FILES = {
  sidebar: "src/components/GitSidebar.tsx",
  graph: "src/components/git-bar/GitGraph.tsx",
  right: "src/components/chat/ChatRightSidebar.tsx",
  blocks: "src/components/AssistantBlocks.tsx",
  stage: "src/components/chat/ChatStage.tsx",
  summary: "src/lib/tool-summary.ts",
};
const REAL = Object.fromEntries(Object.entries(FILES).map(([k, rel]) => [k, code(read(rel))]));

// All sources under web/src (for "exactly once" and "only the chat bar").
function allSources() {
  const out = {};
  const run = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) run(p);
      else if (/\.(ts|tsx)$/.test(e.name)) out[path.relative(webDir, p)] = code(fs.readFileSync(p, "utf8"));
    }
  };
  run(srcDir);
  return out;
}
const ALL = allSources();

const count = (s, needle) => s.split(needle).length - 1;
/** The body of a `const X = useCallback(` declaration up to the line with `}, [` (the dependencies). */
function body(s, beginning) {
  const i = s.indexOf(beginning);
  assert.ok(i >= 0, `"${beginning}" is missing: renamed? Update the anchor, do not delete the test`);
  const j = s.indexOf("\n  }, [", i);
  assert.ok(j > i, `the end of "${beginning}" is missing`);
  return s.slice(i, j);
}

// ── (1) The ways of the git bar ──────────────────────────────────────────────────────────────────────────────────────────────────
const kinds = (s) => [...s.matchAll(/\b(?:onDiff|showDiff)\(\{ kind: "([\w-]+)"/g)].map((m) => m[1]).sort();
function checkWays(q) {
  assert.deepEqual(kinds(q.sidebar), ["change", "change", "change", "history", "stash"],
    "GitSidebar.tsx: the diff ways are not exactly conflict, staged, unstaged, stash and history via onDiff/showDiff");
  assert.deepEqual(kinds(q.graph), ["commit", "commit-whole"], "GitGraph.tsx: the diff ways are not exactly file of a commit and whole commit via onDiff");
  // The three file rows of the changes open via onDiff: staged with staged: true, conflict and unstaged without.
  for (const [list, staged] of [["conflicts", false], ["staged", true], ["unstaged", false]]) {
    assert.match(q.sidebar, new RegExp(`\\b${list}\\.map\\(\\(c\\) => <FileRow [^\\n]*onOpen=\\{\\(fixed\\) => onDiff\\(\\{ kind: "change", repo: rel, file: c\\.path, staged: ${staged} \\}, \\{ fixed \\}\\)\\}`),
      `the rows of "${list}" do not open their diff via onDiff (staged: ${staged})`);
  }
  assert.match(q.sidebar, /<div onClick=\{folder \? undefined : \(\) => onOpen\(false\)\} onDoubleClick=\{folder \? undefined : \(\) => onOpen\(true\)\}/, "a file row does not open as a preview on click and fixed on double click (a folder entry opens nothing)");
  assert.match(q.sidebar, /onShow=\{\(hash, subject\) => showDiff\(\{ kind: "history", repo: modal\.repo\.relPath, hash \}/, "the history dialog does not show its commit via showDiff");
  assert.equal(count(q.sidebar, "onDiff={showDiff}"), 3, "changes (two forms) and the graph section do not get showDiff");
  assert.match(q.sidebar, /<GitGraph [^\n]*onDiff=\{onDiff\}/, "the graph does not get the callback");
  // The modal only via showDiff, and showDiff asks the chat bar's callback FIRST.
  const show = body(q.sidebar, "const showDiff = useCallback<ShowDiff>(");
  const precedence = show.indexOf("if (diffTab.current) { diffTab.current(q, a); setModal(null); return; }");
  assert.ok(precedence > 0, "showDiff does not hand a diff to the chat bar's callback first");
  for (const opener of ["openFileDiff(", "openTextDiff("]) {
    const place = show.indexOf(opener);
    assert.ok(place > precedence, `${opener} in showDiff is not BEHIND the callback`);
    assert.equal(count(q.sidebar, opener), 1, `${opener} is called outside showDiff (exactly ONE call expected)`);
  }
  assert.match(q.sidebar, /\n  diffTab\.current = onDiffTab;\n/, "the bar's callback does not arrive in diffTab");
  const file = body(q.sidebar, "const openFileDiff = useCallback(");
  const text = body(q.sidebar, "const openTextDiff = useCallback(");
  assert.equal(count(q.sidebar, `setModal({ kind: "diff"`), 2, "a DiffModal opens past openFileDiff/openTextDiff");
  assert.ok(file.includes(`setModal({ kind: "diff"`) && text.includes(`setModal({ kind: "diff"`), "the DiffModal does not open in openFileDiff/openTextDiff");
  for (const s of [q.sidebar, q.graph]) assert.doesNotMatch(s, /\bonTextDiff\b|\bonFileDiff\b/, "the old load callback (onTextDiff/onFileDiff) is back");
  assert.doesNotMatch(q.graph, /DiffModal|setModal|\/git\/stash\/show/, "the graph opens a modal itself");
}

// ── (2) Only the chat bar gives the callback ─────────────────────────────────────────────────────────────────────────────────────
function checkChatBar(q, all) {
  const withCallback = Object.entries(all).filter(([, s]) => /<GitSidebar\b[^>]*\bonDiffTab=/.test(s)).map(([d]) => d);
  assert.deepEqual(withCallback, [FILES.right], "onDiffTab is not given by exactly the chat bar (Coding -> Files and Projects -> Git keep the modal)");
  const sender = Object.entries(all).filter(([d, s]) => d !== "src/lib/chat-tabs.ts" && /\bopenDiffTab\(/.test(s)).map(([d]) => d);
  assert.deepEqual(sender, [FILES.right], "openDiffTab is not sent by exactly the chat bar");
  assert.match(q.right, /<GitSidebar\n(?:\s+[^\n]*\n)*?\s+onDiffTab=\{openDiff\}\n/, "the chat bar does not attach openDiff to its GitSidebar");
  assert.match(q.right, /diffTabTarget\.current = \{ chat: activeId \?\? draftChat\(wsId\), target: inChatMode \|\| !gitApiBase \? null : \{ apiBase: gitApiBase, instance: target\.instance \} \};/,
    "the tab's target is not the bar's (chat mode: the chat's; choice: the chosen instance) or the draft is missing");
  assert.match(q.right, /openDiffTab\(d\.chat, q, d\.target, a\);/, "openDiff does not send chat, source, target and display");
}

// ── (3) DiffSource exactly once ──────────────────────────────────────────────────────────────────────────────────────────────────
function checkOneType(all) {
  const locations = Object.entries(all).filter(([, s]) => /\b(?:type|interface)\s+DiffSource\s*[=<{]/.test(s)).map(([d]) => d);
  assert.deepEqual(locations, ["src/lib/chat-tabs.ts"], "DiffSource is not defined EXACTLY once (in lib/chat-tabs.ts)");
}

// ── (4) The file name button in the history ───────────────────────────────────────────────────────────────────────────────────────────
function checkButton(q) {
  assert.equal(count(q.blocks, "<FileButton "), 2, "the file name button is not in exactly ToolBlock and ToolRow");
  assert.equal(count(q.blocks, "<FileButton rel={file} "), 2, "a file name button gets something other than the relative path");
  assert.equal(count(q.blocks, "const file = useFileTab(block);"), 2, "ToolBlock/ToolRow do not compute the path via useFileTab");
  assert.equal(count(q.blocks, "{file ? ("), 2, "the button is not only in the branch with a relative path");
  const hook = q.blocks.slice(q.blocks.indexOf("function useFileTab("), q.blocks.indexOf("\n}\n", q.blocks.indexOf("function useFileTab(")));
  assert.match(hook, /const path = toolFile\(block\.name, block\.input\);\n\s+return k\?\.root && path \? relativeToRoot\(path, k\.root, k\.cwd\) : null;/,
    "useFileTab does not return the path RELATIVE to the root of the chat's target (or null)");
  assert.equal(count(q.blocks, "openFileTab("), 1, "openFileTab is not there exactly once (in the button)");
  assert.match(q.blocks, /onClick=\{\(e\) => \{ e\.stopPropagation\(\); if \(k\) openFileTab\(k\.chatKey, rel\); \}\}/, "the button does not open the relative path in the context's chat");
  assert.match(q.summary, /export const FILE_TOOLS: readonly string\[\] = \["Edit", "MultiEdit", "Write"\];/, "the tools with a file name button are not Edit/MultiEdit/Write");
  assert.match(q.stage, /const fileRoot = targetRoot\(workspace, chatTabs\.chatTarget\);/, "the stage does not take the root from the chat's target");
  assert.match(q.stage, /\{ chatKey: chatTabs\.chatKey, root: fileRoot, cwd: workspace\.path \}/, "the context does not carry chat, root and cwd of the workspace");
  assert.match(q.stage, /<FileTabContext\.Provider value=\{fileTab\}>/, "the stage does not set the context around the history");
}

const CHECKS = {
  ways: (q) => checkWays(q),
  bar: (q) => checkChatBar(q, { ...ALL, [FILES.right]: q.right, [FILES.sidebar]: q.sidebar }),
  type: (q) => checkOneType({ ...ALL, "src/lib/diff-tab.ts": q.diffTab ?? ALL["src/lib/diff-tab.ts"] }),
  button: (q) => checkButton(q),
};

test("code tab ways: every diff of the bar goes via showDiff into the tab, one type, file name button only relative", (t) => {
  for (const [name, f] of Object.entries(CHECKS)) {
    try { f(REAL); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
  t.diagnostic(`ways: GitSidebar ${kinds(REAL.sidebar).length}, GitGraph ${kinds(REAL.graph).length}`);
});

// name -> [file key, old, new, check]
const SABOTAGES = {
  "a FileRow opens the modal directly": ["sidebar", `onOpen={(fixed) => onDiff({ kind: "change", repo: rel, file: c.path, staged: true }, { fixed })}`, `onOpen={() => openFileDiff(rel, c.path, true)}`, "ways"],
  "the double click does not open fixed": ["sidebar", "onDoubleClick={folder ? undefined : () => onOpen(true)}", "onDoubleClick={folder ? undefined : () => onOpen(false)}", "ways"],
  "the stash opens past the callback": ["sidebar", `onClick={() => onDiff({ kind: "stash", repo: rel, ref: s.ref }, { title: s.message || undefined })}`, `onClick={() => setModal({ kind: "diff", title: s.ref, badge: "stash" })}`, "ways"],
  "the history opens past the callback": ["sidebar", `showDiff({ kind: "history", repo: modal.repo.relPath, hash }, { title: subject || undefined })`, `openTextDiff(subject || hash, hash.slice(0, 8), async () => "")`, "ways"],
  "a second call of the modal beside showDiff": ["sidebar", "  const showHistory = useCallback((r: GitRepo) => setModal({ kind: \"history\", repo: r }), []);", "  const showHistory = useCallback((r: GitRepo) => openTextDiff(r.relPath, \"log\", async () => \"\"), [openTextDiff]);", "ways"],
  "showDiff does not ask the callback": ["sidebar", "    if (diffTab.current) { diffTab.current(q, a); setModal(null); return; }\n", "", "ways"],
  "the callback does not arrive": ["sidebar", "  diffTab.current = onDiffTab;\n", "", "ways"],
  "the whole commit drops out": ["graph", `onDiff({ kind: "commit-whole", repo: rel, hash: c.hash }, { title: c.subject || c.hash, short: c.short });`, "", "ways"],
  "the graph does not get the callback": ["sidebar", " path={path} onDiff={onDiff} turn={turn} />", " path={path} onDiff={() => {}} turn={turn} />", "ways"],
  "the chat bar gives no callback": ["right", "                  onDiffTab={openDiff}\n", "", "bar"],
  "tab in chat mode with the bar's target instead of the chat's": ["right", "target: inChatMode || !gitApiBase ? null : { apiBase: gitApiBase, instance: target.instance }", "target: !gitApiBase ? null : { apiBase: gitApiBase, instance: target.instance }", "bar"],
  "the draft of a new chat gets no tab": ["right", "chat: activeId ?? draftChat(wsId)", "chat: activeId ?? \"\"", "bar"],
  "a second type DiffSource": ["diffTab", `type DiffSource, type TabTarget, type RootName } from "./chat-tabs.js";`, `type TabTarget, type RootName } from "./chat-tabs.js";\nexport type DiffSource = { kind: "stash"; repo: string; index: number };`, "type"],
  "the button gets the raw path": ["blocks", `<FileButton rel={file} shimmers={shimmers} className={shimmers ? "" : "text-dim"}>`, `<FileButton rel={block.detail} shimmers={shimmers} className={shimmers ? "" : "text-dim"}>`, "button"],
  "useFileTab without relativizing": ["blocks", "return k?.root && path ? relativeToRoot(path, k.root, k.cwd) : null;", "return k && path ? path : null;", "button"],
  "the button opens the display text": ["blocks", "if (k) openFileTab(k.chatKey, rel);", "if (k) openFileTab(k.chatKey, String(children));", "button"],
  "NotebookEdit gets a button": ["summary", `["Edit", "MultiEdit", "Write"];`, `["Edit", "MultiEdit", "Write", "NotebookEdit"];`, "button"],
  "the root is the workspace instead of the chat's target": ["stage", "const fileRoot = targetRoot(workspace, chatTabs.chatTarget);", "const fileRoot = workspace.path;", "button"],
};

test("code tab ways: counter-tests, every sabotage hits exactly one spot and is caught", (t) => {
  const sources = { ...REAL, diffTab: ALL["src/lib/diff-tab.ts"] };
  const notCaught = [];
  for (const [name, [file, old, fresh, check]] of Object.entries(SABOTAGES)) {
    const prior = sources[file];
    assert.equal(count(prior, old), 1, `sabotage "${name}": the spot appears ${count(prior, old)}x in ${file}; the sabotage is stale`);
    let caught = false;
    try { CHECKS[check]({ ...sources, [file]: prior.replace(old, fresh) }); } catch { caught = true; }
    if (!caught) notCaught.push(`${name} (${check})`);
  }
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  t.diagnostic(`${Object.keys(SABOTAGES).length} sabotages, each caught`);
});
