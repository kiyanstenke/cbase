// Editor navigation (go to definition, peek, history, commands): the calculations, EXECUTED.
//
// (1) Hits (lib/navigation.ts `hitsSelection`): no hit -> nothing; exactly one jumps; several open the peek; identical places count once;
//     "Peek" (`alwaysPeek`) shows even a single hit in the peek.
// (2) Grouping (`groupedByFile`): per file, files by path, external targets last with their token, within a file by position; plus the
//     line preview (`previewParts`).
// (3) History (`NavHistory`): jump, back (remembers where one stood; forward returns there), forward, a new jump cuts off the forward
//     part, the same place adds nothing new, cap; a tab switch records, the one caused by an own jump does not record twice (`tabSwitched`).
// (4) Commands (`W3_COMMANDS` in the ONE table lib/editor-commands.ts): no key collides with W2 or the W4 keys, the shortcuts are those of
//     VS Code on the Mac, hidden by `features` (source definition only with `source_definition`; "Peek" submenu without a visible child is
//     gone), group order as in VS Code.
// (5) Sources: every W3 id has exactly one execution (components/code/lsp-navigation.ts); the commands are in the table BEFORE the keys are
//     bound; an external target gets no language service; CodePane passes the connection on to the editor base and to the diff tab, has the
//     "references" mode and jumps with a line through the history; the diff tab passes the connection on; every text that is translated
//     only through a table (command title, peek title, "No ... found.") has its key in lib/i18n-de.ts.
// (6) Proofreading, at the sources: renaming carries the history along (see `renamed` in (3)); after every `await` the navigation checks
//     that the view still shows the same file; the call tree takes only answers of the current direction; Cmd+S in the peek saves the
//     peek; restart/stop carry `file`; the "Outline" button names no shortcut that does not exist; outline and problems ask with a pause
//     and only the last answer counts.
//
// Every sabotage is a copy of the source with ONE changed spot (the spot appears exactly once, otherwise the sabotage is stale); the
// assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/lsp-navigation.test.mjs
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
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");

const NAV = read("src", "lib", "navigation.ts");
const SABOTAGES = {
  "several jump": { old: "if (e.length === 1 && !o.alwaysPeek) return", fresh: "if (e.length >= 1 && !o.alwaysPeek) return", catches: "hits" },
  "peek jumps": { old: "if (e.length === 1 && !o.alwaysPeek) return", fresh: "if (e.length === 1) return", catches: "hits" },
  "no deduplication": { old: "    if (seen.has(k)) continue;\n", fresh: "", catches: "hits" },
  "files not sorted": { old: "  return groups.sort(", fresh: "  return groups; void (", catches: "groups" },
  "external not last": { old: "Number(Boolean(a.extern)) - Number(Boolean(b.extern)) || ", fresh: "", catches: "groups" },
  "positions not sorted": { old: "  for (const g of groups) g.locations.sort(", fresh: "  for (const g of []) g.locations.sort(", catches: "groups" },
  "token forgotten": { old: "if (!g.extern && o.external?.token) g.extern = { token: o.external.token };", fresh: "", catches: "groups" },
  "preview not shortened": { old: "if (before.length > leadTime) before =", fresh: "if (false) before =", catches: "preview" },
  "no cut-off": { old: "    this.list.length = this.i + 1;\n    if (samePlace(", fresh: "    if (samePlace(", catches: "history" },
  "back does not remember": { old: "    if (now && this.list[this.i].path === now.path) this.list[this.i] = now;\n    this.i -= 1;", fresh: "    this.i -= 1;", catches: "history" },
  "same place twice": { old: "if (samePlace(this.current(), to)) { this.list[this.i] = to; return; }", fresh: "", catches: "history" },
  "no cap": { old: "while (this.list.length > this.max)", fresh: "while (false)", catches: "history" },
  "own jump twice": { old: "  if (v.current()?.path === fresh.path) return false;\n", fresh: "", catches: "history" },
  "source definition always": { old: `rank: 30, needs: "source_definition" }`, fresh: "rank: 30 }", catches: "commands" },
  "peek on top instead of in the submenu": { old: `{ id: "editor.action.peekDefinition", title: "Peek Definition", parent: PEEK_MENU,`, fresh: `{ id: "editor.action.peekDefinition", title: "Peek Definition", group: "navigation",`, catches: "commands" },
  "rename does not carry along": { old: "if (p === old || p.startsWith(`${old}/`)) this.list[k] = { ...this.list[k], path: fresh + p.slice(old.length) };", fresh: "", catches: "history" },
  "rename hits name prefixes": { old: "p.startsWith(`${old}/`)", fresh: "p.startsWith(old)", catches: "history" },
  "wrong shortcut": { old: `shortcut: "⌥⇧F12", keys: ["Shift-Alt-F12"]`, fresh: `shortcut: "⇧F12", keys: ["Shift-Alt-F12"]`, catches: "commands" },
};

// ── Compile: navigation.ts, the table, the contract (types) and one copy per sabotage, in ONE tsc run. `api/core.ts` without network. ───
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-lsp-navigation-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(path.join(src, "api"), { recursive: true });
fs.writeFileSync(path.join(src, "api", "lsp.ts"), read("src", "lib", "api", "lsp.ts"));
fs.writeFileSync(path.join(src, "api", "core.ts"), "export async function api<T = unknown>(p: string, _o?: RequestInit): Promise<T> { throw new Error(`no network in test: ${p}`); }\n");
fs.writeFileSync(path.join(src, "editor-commands.ts"), read("src", "lib", "editor-commands.ts"));
fs.writeFileSync(path.join(src, "navigation.ts"), NAV);
const copies = [];
for (const [name, s] of Object.entries(SABOTAGES)) {
  const file = `navigation-sabotage-${copies.length}.ts`;
  fs.writeFileSync(path.join(src, file), NAV.replace(s.old, s.fresh));
  copies.push({ name, file, catches: s.catches, places: NAV.split(s.old).length - 1 });
}
const allTs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allTs(path.join(dir, e.name)) : [path.join(dir, e.name)]));
try {
  execFileSync(process.execPath, [tsc, ...allTs(src), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "navigation.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const N = await load("navigation.ts");
const B = await load("editor-commands.ts");
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: await load(k.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

const r = (l1, c1, l2 = l1, c2 = c1 + 3) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
const location = (file, l, c = 0, token) => ({ file, range: r(l, c), ...(token ? { external: { token } } : {}) });

// ── (1) Hits ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function hits(M) {
  assert.deepEqual(M.hitsSelection([]), { kind: "none" });
  assert.deepEqual(M.hitsSelection(null), { kind: "none" });
  const a = location("src/a.ts", 4, 2);
  assert.deepEqual(M.hitsSelection([a]), { kind: "jump", location: a }, "a single hit does not jump");
  assert.deepEqual(M.hitsSelection([a, { ...a, range: r(4, 2) }]), { kind: "jump", location: a }, "the same place twice counts as several");
  const b = location("src/b.ts", 1);
  assert.deepEqual(M.hitsSelection([a, b]), { kind: "peek", locations: [a, b] }, "several hits do not open a peek");
  assert.deepEqual(M.hitsSelection([a], { alwaysPeek: true }), { kind: "peek", locations: [a] }, "\"Peek\" jumps instead of peeking");
  assert.deepEqual(M.hitsSelection([a, { file: "", range: r(0, 0) }, { file: "x.ts" }]), { kind: "jump", location: a }, "a place without file/range counts");
}
// ── (2) Grouping and preview ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function groups(M) {
  const locations = [location("src/b.ts", 9), location("/usr/lib/lib.dom.d.ts", 3, 0, "tok1"), location("src/a.ts", 20), location("src/a.ts", 2, 5), location("src/a.ts", 2, 1), location("src/b.ts", 9)];
  const g = M.groupedByFile(locations);
  assert.deepEqual(g.map((x) => x.file), ["src/a.ts", "src/b.ts", "/usr/lib/lib.dom.d.ts"], "files not by path, external not last");
  assert.deepEqual(g[0].locations.map((o) => [o.range.start.line, o.range.start.character]), [[2, 1], [2, 5], [20, 0]], "hits of a file not by position");
  assert.equal(g[1].locations.length, 1, "identical places twice in the group");
  assert.deepEqual(g[2].extern, { token: "tok1" }, "the token of an external target is missing on the group");
  assert.equal(g[0].extern, null);
  assert.deepEqual(M.flatHits(g).map((o) => o.file), ["src/a.ts", "src/a.ts", "src/a.ts", "src/b.ts", "/usr/lib/lib.dom.d.ts"]);
  assert.deepEqual(M.pathParts("src/lib/x.ts"), { name: "x.ts", folder: "src/lib" });
  assert.deepEqual(M.pathParts("x.ts"), { name: "x.ts", folder: "" });
}
function preview(M) {
  assert.deepEqual(M.previewParts("    const foo = bar(foo);", 10, 13), { before: "const ", hits: "foo", after: " = bar(foo);" }, "indent not cut off");
  const lang = `${"x".repeat(80)}target()`;
  const t = M.previewParts(lang, 80, 86, 10);
  assert.equal(t.before, `…${"x".repeat(10)}`, "a long lead-in is not shortened");
  assert.equal(t.hits, "target");
  assert.deepEqual(M.previewParts("abc", 1, 99), { before: "a", hits: "bc", after: "" }, "a range beyond the line does not clamp");
  assert.deepEqual(M.previewParts("  ab", 1, 2), { before: "", hits: " ", after: "ab" }, "a hit in the indent loses its start");
}
// ── (3) History ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function history(M) {
  const o = (filePath, line) => ({ path: filePath, pos: { line, character: 0 }, extern: null });
  const v = new M.NavHistory(50);
  assert.equal(v.back(o("a", 0)), null, "back without history");
  v.jump(null, o("a", 0));
  v.jump(o("a", 10), o("b", 5)); // moved in a down to line 10, then F12 to b
  assert.deepEqual(v.entries().map((e) => `${e.path}${e.pos.line}`), ["a10", "b5"], "the entry of a does not follow the place where one stood");
  assert.deepEqual(v.back(o("b", 7)), o("a", 10), "back does not lead to the place before");
  assert.equal(v.canForward, true);
  assert.deepEqual(v.before(o("a", 12)), o("b", 7), "forward does not lead to where one stood before going back");
  assert.deepEqual(v.back(o("b", 7)), o("a", 12), "back does not remember the place where one stood");
  v.jump(o("a", 12), o("c", 1)); // after a back: a new jump cuts off the forward part (b)
  assert.deepEqual(v.entries().map((e) => `${e.path}${e.pos.line}`), ["a12", "c1"], "a new jump does not cut off the forward part");
  assert.equal(v.canForward, false);
  assert.equal(v.before(o("c", 1)), null, "forward after the cut-off");
  v.jump(o("c", 1), o("c", 1));
  assert.equal(v.entries().length, 2, "a jump to the same place records an entry");
  v.jump(o("c", 1), o("c", 40)); // far away in the same file: one entry
  assert.deepEqual(v.entries().map((e) => `${e.path}${e.pos.line}`), ["a12", "c1", "c40"]);
  assert.deepEqual(v.back(o("c", 40)), o("c", 1));
  const d = new M.NavHistory(3);
  d.jump(null, o("a", 0));
  for (const p of ["b", "c", "d", "e"]) d.jump(null, o(p, 0));
  assert.deepEqual(d.entries().map((e) => e.path), ["c", "d", "e"], "the cap does not apply");
  assert.equal(d.index, 2);
  assert.deepEqual(d.current(), o("e", 0));
  // Tab switch: a click on another tab records; the switch caused by an own jump (the history is already there) does not.
  const t = new M.NavHistory(50);
  assert.equal(M.tabSwitched(t, null, o("a", 0)), true);
  t.jump(o("a", 3), o("b", 8)); // go to: tab b comes to the front afterwards
  assert.equal(M.tabSwitched(t, o("a", 3), o("b", 8)), false, "the tab switch of an own jump records a second entry");
  assert.equal(M.tabSwitched(t, o("b", 9), o("c", 0)), true, "a tab switch does not record an entry");
  assert.deepEqual(t.entries().map((e) => `${e.path}${e.pos.line}`), ["a3", "b9", "c0"]);
  assert.deepEqual(t.back(o("c", 0)), o("b", 9));
  // A renamed file or folder carries its entries along; a name that merely STARTS the same does not.
  const u = new M.NavHistory(50);
  u.jump(o("src/a.ts", 1), o("src/b.ts", 2));
  u.jump(o("src/b.ts", 2), o("srcx/c.ts", 3));
  u.renamed("src", "lib");
  assert.deepEqual(u.entries().map((e) => `${e.path}${e.pos.line}`), ["lib/a.ts1", "lib/b.ts2", "srcx/c.ts3"], "a rename does not carry the history along (or wrongly)");
  u.renamed("lib/a.ts", "lib/z.ts");
  assert.deepEqual(u.back(o("srcx/c.ts", 3)), o("lib/b.ts", 2));
  assert.deepEqual(u.back(o("lib/b.ts", 2)), o("lib/z.ts", 1), "back leads to the old name");
}
// ── (4) Commands ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SHORTCUT = {
  "editor.action.revealDefinition": "F12", "editor.action.goToImplementation": "⌘F12", "editor.action.goToReferences": "⇧F12",
  "editor.action.peekDefinition": "⌥F12", "editor.action.peekImplementation": "⇧⌘F12", "references-view.findReferences": "⌥⇧F12",
  "references-view.showCallHierarchy": "⌥⇧H", "workbench.action.navigateBack": "⌃-", "workbench.action.navigateForward": "⌃⇧-",
};
/** The keys W4 occupies (palette, files Cmd+P, symbols Cmd+Shift+O, workspace symbols Cmd+T, line Ctrl+G). */
const W4_KEYS = ["Shift-Mod-p", "Mod-p", "Shift-Mod-o", "Mod-t", "Ctrl-g"];
function commands(M) {
  B.emptyCommands();
  try {
    for (const b of B.W2_COMMANDS) B.registerCommand({ ...b });
    for (const b of M.W3_COMMANDS) B.registerCommand({ ...b }); // a key of W2 would throw here
    const w3Keys = new Set(M.W3_COMMANDS.flatMap((b) => b.keys ?? []).map(B.keyNormalized));
    for (const t of W4_KEYS) assert.ok(!w3Keys.has(B.keyNormalized(t)), `W3 occupies the key ${t} of W4`);
    for (const [id, k] of Object.entries(SHORTCUT)) assert.equal(B.command(id)?.shortcut, k, `shortcut of ${id} is not the one of VS Code`);
    for (const b of M.W3_COMMANDS) if (b.shortcut) assert.ok(b.keys?.length, `${b.id} shows a shortcut without a key`);
    const situation = (f) => ({ features: new Set(f), language: true, writable: true });
    const k = {};
    const visible = (f) => M.W3_COMMANDS.map((b) => B.command(b.id)).filter((b) => B.commandVisible(b, situation(f), k)).map((b) => b.id);
    assert.deepEqual(visible([]), ["workbench.action.navigateBack", "workbench.action.navigateForward"], "without a server more than back/forward is shown");
    const def = visible(["definition", "references"]);
    assert.deepEqual(def.sort(), ["editor.action.goToReferences", "editor.action.peekDefinition", "editor.action.peekMenu", "editor.action.referenceSearch.trigger",
      "editor.action.revealDefinition", "references-view.findReferences", "workbench.action.navigateBack", "workbench.action.navigateForward"].sort(), "hiding by features is wrong");
    assert.ok(!def.includes("typescript.goToSourceDefinition"), "source definition without `source_definition`");
    assert.ok(visible(["source_definition"]).includes("typescript.goToSourceDefinition"), "source definition missing despite `source_definition`");
    // The menu: groups in the order of VS Code, "Peek" carries the peek entries that are missing above.
    const menu = B.menuGroups(situation(["definition", "type_definition", "implementation", "references", "call_hierarchy", "rename"]), k);
    assert.deepEqual(menu.map((g) => g.group).slice(0, 3), ["navigation", "search", "change"], "group order");
    assert.deepEqual(menu[0].commands.map((b) => b.id), ["editor.action.revealDefinition", "editor.action.goToTypeDefinition", "editor.action.goToImplementation", "editor.action.goToReferences", "editor.action.peekMenu"], "group navigation");
    assert.deepEqual(menu[1].commands.map((b) => b.id), ["references-view.findReferences", "references-view.findImplementations", "references-view.showCallHierarchy"], "group search");
    assert.deepEqual(B.childrenOf("editor.action.peekMenu", situation(["definition", "type_definition", "implementation", "references"]), k).map((b) => b.id),
      ["editor.action.peekDefinition", "editor.action.peekTypeDefinition", "editor.action.peekImplementation", "editor.action.referenceSearch.trigger"], "submenu Peek");
    assert.ok(!B.commandVisible(B.command("editor.action.peekMenu"), situation(["call_hierarchy"]), k), "\"Peek\" without a visible child is shown");
  } finally { B.emptyCommands(); }
}

const CHECK = { hits, groups, preview, history, commands };
test("(1)–(4) hits, groups, preview, history, commands — really green, every sabotage caught", () => {
  for (const f of Object.values(CHECK)) f(N);
  for (const k of sabotaged) {
    assert.equal(k.places, 1, `sabotage "${k.name}": the spot appears ${k.places}x in the source (stale)`);
    assert.throws(() => CHECK[k.catches](k.mod), `sabotage "${k.name}" was not caught by "${k.catches}"`);
  }
  console.log(`# Measurement: ${sabotaged.length} sabotages caught`);
});

// ── (5) Sources ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const Q = {
  navigation: read("src", "components", "code", "lsp-navigation.ts"),
  addon: read("src", "components", "code", "lsp-extension.ts"),
  codePane: read("src", "components", "CodePane.tsx"),
  diffTab: read("src", "components", "code", "DiffTab.tsx"),
  i18n: read("src", "lib", "i18n-de.ts"),
};
/** The texts translated only through a table (`tr(TITLE[action])`, `tr(b.title)`) — a missing key would silently show English. */
function translated(q) {
  const table = (name) => {
    const m = new RegExp(`const ${name}: Record<LocationAction, string> = \\{([\\s\\S]*?)\\n\\};`).exec(q.navigation);
    assert.ok(m, `lsp-navigation.ts: ${name} not found (stale anchor)`);
    const values = [...m[1].matchAll(/: "([^"]+)"/g)].map((x) => x[1]);
    assert.equal(values.length, 5, `${name}: not one text per action`);
    return values;
  };
  const texts = [...N.W3_COMMANDS.map((b) => b.title), ...table("TITLE"), ...table("NO")];
  const missing = texts.filter((x) => !q.i18n.includes(`\n  ${JSON.stringify(x)}: `));
  assert.deepEqual(missing, [], "without a German entry in lib/i18n-de.ts");
  return texts.length;
}
function sources(q) {
  translated(q);
  const block = /const EXECUTION: Record<string, \(k: EditorContext\) => unknown> = \{([\s\S]*?)\n\};/.exec(q.navigation);
  assert.ok(block, "lsp-navigation.ts: EXECUTION not found (stale anchor)");
  const execution = [...block[1].matchAll(/^\s*"([\w.-]+)":/gm)].map((x) => x[1]).sort();
  assert.deepEqual(execution, N.W3_COMMANDS.filter((b) => !b.submenu).map((b) => b.id).sort(), "not every W3 id has exactly one execution");
  const e = withoutComments(q.addon);
  const iNav = e.indexOf("navigationExtension({"), iCmd = e.indexOf("commandExtension()");
  assert.ok(iNav >= 0 && iCmd >= 0 && iNav < iCmd, "the W3 commands are not in the table before the keys are bound");
  assert.ok(/if \(!o\.buffer \|\| !sp \|\| o\.buffer\.readonly\) return base;/.test(e), "an external target gets the language service (only files of the instance)");
  const c = withoutComments(q.codePane);
  assert.ok(/editorExtensions\(\{ buffer: paLoaded, editor: editorHolder, navigation: nav\.connection \}\)/.test(c), "CodePane does not pass the connection to the editor base");
  assert.ok(/<NavContext\.Provider value=\{nav\.connection\}>\{controlled\.content\}<\/NavContext\.Provider>/.test(c), "the diff tab in place of the editor does not get the connection");
  assert.ok(/mode === "references" && <ReferencesBar /.test(c) && /setMode\("references"\)/.test(c), "the \"references\" mode is missing");
  assert.ok(/if \(goto\) nav\.connection\.rememberJump\(/.test(c), "a jump with a line bypasses the history");
  assert.ok(!/pendingGoto/.test(c), "the old line jump still stands next to the history");
  assert.ok(/pa\?\.readonly && !controlled\?\.content && <WriteProtectionRow /.test(c), "an external target is not visibly marked");
  assert.ok(/editorExtensions\(\{ buffer: run\.current\.buffer, editor: run\.current\.editor \?\? null, navigation \}\)/.test(withoutComments(q.diffTab)) && /useContext\(NavContext\)/.test(q.diffTab),
    "the diff tab does not pass the connection on");
}
// ── (6) Proofreading ────────────────────────────────────────────────────────────────────────────────────────────────
const G = {
  connection: read("src", "components", "code", "navigation-connection.tsx"),
  navigation: Q.navigation,
  references: read("src", "components", "code", "ReferencesBar.tsx"),
  peek: read("src", "components", "code", "lsp-peek.ts"),
  statusLine: read("src", "components", "code", "LspStatusLine.tsx"),
  codePane: Q.codePane,
  // The "Outline" button sits in the explorer's activity bar, not in CodePane.
  header: read("src", "components", "code", "explorer", "ExplorerHeader.tsx"),
  i18n: Q.i18n,
  layout: read("src", "components", "code", "layout-problems.ts"),
};
function proofread(q) {
  const a = withoutComments(q.connection);
  assert.ok(/useEffect\(\(\) => atRename\(\(target, alt0, new0, newTarget\) => \{[\s\S]*?z\.history\.renamed\(old, fresh\);[\s\S]*?\}\), \[z\]\);/.test(a), "rename does not carry the history along");
  assert.ok(a.includes("const old = k.ofCanon(target, alt0), fresh = k.ofCanon(newTarget, new0);"), "the history does not convert a canonical rename into the editor's coordinates");
  const n = withoutComments(q.navigation);
  const questions = [...n.matchAll(/await questions\(d, [^\n]*\n\s*(.*)/g)].map((x) => x[1]);
  assert.ok(questions.length >= 3, "lsp-navigation.ts: the navigation questions not found (stale anchor)");
  for (const z of questions) assert.ok(/^if \(!stillPresent\(view, (n|d)\.buffer\)\) return( false)?;$/.test(z), `after an await the navigation jumps without checking that the view still shows the same file: ${z}`);
  assert.ok(n.includes("const stillPresent = (view: EditorView, p: Buffer): boolean => view.dom.isConnected && navOf(view.state)?.buffer === p;"), "stillPresent does not check view AND buffer");
  const r = withoutComments(q.references);
  assert.ok(r.includes("const set = (k: Node) => { if (seq === run.current) setNode((v) => ({ ...v, [id]: k })); };") && /if \(fresh === direction\) return;\s*run\.current \+= 1;/.test(r), "a late answer of the old direction lands in the new call tree");
  assert.ok(withoutComments(q.peek).includes(`Prec.highest(keymap.of([{ key: "Mod-s", preventDefault: true, stopPropagation: true, run: () => { void p.save(); return true; } }]))`), "Cmd+S in the peek does not save the peek");
  const s = withoutComments(q.statusLine);
  for (const action of ["restart", "stop"]) assert.ok(s.includes(`lspCalls(target, "${action}", { language: s.language, file: path })`), `${action} without file — at workspace level the server does not find the project`);
  const c = withoutComments(q.codePane), header = withoutComments(q.header);
  assert.ok(header.includes(`{ m: "outline", title: t("Outline (symbols)"), `) && !header.includes("⌘⇧O") && !c.includes("⌘⇧O"), "the \"Outline\" button names Cmd+Shift+O (the key belongs to the palette)");
  assert.ok(q.i18n.includes(`\n  "Outline (symbols)": `), "\"Outline (symbols)\" without a German entry");
  // The open OUTLINE section of the explorer asks too — same route, same pause.
  assert.ok(c.includes("useLayoutAndProblems({ outlineOn: mode === \"outline\" || (mode === \"explorer\" && sectionOpen.layout), activePath, pa, problemsOn: bottom === \"problems\", tabs, bufferOf, bufferTick, change })") && !/\bquestionBuffer\(/.test(c), "CodePane asks outline/problems bypassing the pause");
  const g = withoutComments(q.layout);
  assert.ok(g.includes("export const PROBLEMS_PAUSE_MS = 500;") && g.includes("}, immediately ? 0 : PROBLEMS_PAUSE_MS);"), "problems ask without a pause");
  assert.ok(g.includes("const seq = ++run.current;") && g.includes("if (seq !== run.current) return;\n    for (const [k, z] of counts) setDiagnostics(k, z);\n    setProblems(all);"), "a late answer of the problems overwrites a newer one (also the counts in the inventory)");
  // CodePane no longer renders per keystroke — outline and problems listen to every change themselves and defer the question.
  assert.ok(g.includes("question(immediately ? 0 : LAYOUT_PAUSE_MS);") && g.includes("const off = pa.subscribe(() => { if (pa.version !== version && pa.status.state === \"loaded\") { version = pa.version; question(LAYOUT_PAUSE_MS); } });") && g.includes("return () => { alive = false; off(); if (h) clearTimeout(h); };"), "the outline asks on every keystroke or not at all after a change");
  assert.ok(g.includes("const off = change.subscribe(() => { clearTimeout(h); h = setTimeout(() => { void loadProblems(); }, PROBLEMS_PAUSE_MS); });"), "the problems do not ask after a change, or ask without a pause");
}
test("(6) proofreading: history on rename, stillPresent after await, call tree per direction, Cmd+S in the peek, file on restart/stop, outline without Cmd+Shift+O, pauses (with counter-probes)", () => {
  proofread(G);
  const SAB = {
    "history without rename": { ...G, connection: G.connection.replace("z.history.renamed(old, fresh);", "") },
    "history without conversion": { ...G, connection: G.connection.replace("const old = k.ofCanon(target, alt0), fresh = k.ofCanon(newTarget, new0);", "const old = alt0, fresh = new0;") },
    "jumps without stillPresent": { ...G, navigation: G.navigation.replace("if (!stillPresent(view, d.buffer)) return;", "") },
    "stillPresent view only": { ...G, navigation: G.navigation.replace("view.dom.isConnected && navOf(view.state)?.buffer === p;", "view.dom.isConnected;") },
    "call tree without run": { ...G, references: G.references.replace("if (seq === run.current) setNode(", "setNode(") },
    "direction change does not count": { ...G, references: G.references.replace("run.current += 1;", "") },
    "peek without Cmd+S": { ...G, peek: G.peek.replace(`Prec.highest(keymap.of([{ key: "Mod-s", preventDefault: true, stopPropagation: true, run: () => { void p.save(); return true; } }])),`, "") },
    "stop without file": { ...G, statusLine: G.statusLine.replace(`lspCalls(target, "stop", { language: s.language, file: path })`, `lspCalls(target, "stop", { language: s.language })`) },
    "Cmd+Shift+O back": { ...G, header: G.header.replace(`title: t("Outline (symbols)"), `, `title: t("Outline (symbols, Cmd+Shift+O)"), `) },
    "problems without pause": { ...G, layout: G.layout.replace("}, immediately ? 0 : PROBLEMS_PAUSE_MS);", "}, 0);") },
    "problems without run number": { ...G, layout: G.layout.replace("if (seq !== run.current) return;", "") },
    "outline without pause": { ...G, layout: G.layout.replace("version = pa.version; question(LAYOUT_PAUSE_MS); } });", "version = pa.version; question(0); } });") },
    "outline does not listen": { ...G, layout: G.layout.replace("const off = pa.subscribe(", "const off = () => {}; void (") },
    "problems do not listen": { ...G, layout: G.layout.replace("const off = change.subscribe(() => {", "const off = () => {}; void (() => {") },
    "problems without pause after change": { ...G, layout: G.layout.replace("void loadProblems(); }, PROBLEMS_PAUSE_MS); });", "void loadProblems(); }, 0); });") },
    "CodePane without changes": { ...G, codePane: G.codePane.replace("bufferOf, bufferTick, change })", "bufferOf, bufferTick, change: { subscribe: () => () => {} } })") },
  };
  for (const [name, q] of Object.entries(SAB)) {
    assert.ok(Object.keys(q).some((k) => q[k] !== G[k]), `sabotage "${name}" has no effect (stale)`);
    assert.throws(() => proofread(q), `sabotage "${name}" was not caught`);
  }
});

test("(5) sources: one execution per W3 id, registration order, no language service for external targets, CodePane and diff tab connected (with counter-probes)", () => {
  sources(Q);
  console.log(`# Measurement: ${translated(Q)} translated table texts checked`);
  const SAB = {
    "execution missing": { ...Q, navigation: Q.navigation.replace(`  "references-view.findImplementations": (k) => findAll(k, "implementations"),\n`, "") },
    "keys before the commands": { ...Q, addon: Q.addon.replace("  const nav = navigationExtension({", "  const early = commandExtension();\n  const nav = navigationExtension({") },
    "external with language service": { ...Q, addon: Q.addon.replace("if (!o.buffer || !sp || o.buffer.readonly) return base;", "if (!o.buffer || !sp) return base;") },
    "CodePane without connection": { ...Q, codePane: Q.codePane.replace("navigation: nav.connection }));", "}));") },
    "diff tab without context": { ...Q, codePane: Q.codePane.replace("<NavContext.Provider value={nav.connection}>{controlled.content}</NavContext.Provider>", "controlled.content") },
    "no references mode": { ...Q, codePane: Q.codePane.replace(`{mode === "references" && <ReferencesBar `, `{false && <ReferencesBar `) },
    "line without history": { ...Q, codePane: Q.codePane.replace("if (goto) nav.connection.rememberJump(", "if (goto) void (") },
    "without write-protection row": { ...Q, codePane: Q.codePane.replace("{active && pa?.readonly && !controlled?.content && <WriteProtectionRow path={active.path} />}", "") },
    "diff tab passes nothing on": { ...Q, diffTab: Q.diffTab.replace("editor: run.current.editor ?? null, navigation })", "editor: run.current.editor ?? null })") },
    "translation missing": { ...Q, i18n: Q.i18n.replace(`  "No source definition found.": "Keine Quelldefinition gefunden.",\n`, "") },
    "title without translation": { ...Q, i18n: Q.i18n.replace(`  "Go to Source Definition": "Gehe zu Quelldefinition",\n`, "") },
  };
  for (const [name, q] of Object.entries(SAB)) {
    assert.ok(Object.keys(q).some((k) => q[k] !== Q[k]), `sabotage "${name}" has no effect (stale)`);
    assert.throws(() => sources(q), `sabotage "${name}" was not caught`);
  }
});
