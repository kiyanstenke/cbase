// The tab bar as in VS Code:
//
// (1) The computations (lib/tab-bar.ts), EXECUTED: the color of the name (error before warning before Git; the same CSS variables as the
//     explorer, lib/explorer-decoration.ts, one source), the folder suffix of equal names (VS Code labels.ts `shorten`: the shortest unique
//     part, "…", the root "./", equal folders without suffix), the sets of the context menu (Others / Right / Saved / All) and their
//     shortcuts (⌥⌘T, ⌘K U, ⌘K W, ⌘K Enter, ⌥⌘C, ⌥⇧⌘C), reordering by dragging, and the list of the files page as preview/pinned
//     via the SAME rule as in the chat (lib/chat-tabs.ts: a preview replaces the preview in its place, unsaved content is never
//     replaced, new opens right of the active one, after closing the most recently used one; rename and delete via the same rule).
// (2) The sources: ONE building block (components/code/TabBar.tsx `TabTile`) draws the tabs of the files page AND the file/diff tabs
//     of the chat; the icon only via FileSymbol; the menu via the ONE editor menu (cb-pop at the body, no `fixed inset-0`); the ✕ sits
//     NEXT TO the role=tab and is not a tab stop; middle click closes, double click pins; dragging reorders; the preview is italic;
//     shortcuts in the menu only if bound, gray for empty sets, "Copy Path" without await (root up front), a cancel ends
//     "close several", the diff tab copies repo + file, CodePane routes every change of the list through the rule.
//
// Every sabotage is a copy of the source with ONE changed spot (the spot occurs exactly once, otherwise the sabotage is stale);
// the assigned check must fail on it.
//
// Run:  node --test web/test/tab-bar.test.mjs
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

const SOURCE = read("src", "lib", "tab-bar.ts");
const SABOTAGES = {
  "Git before problem": { old: "return problem ? PROBLEM_COLOR[problem] : git && isGitKind(git) ? GIT_COLOR[git] : null;", fresh: "return git && isGitKind(git) ? GIT_COLOR[git] : problem ? PROBLEM_COLOR[problem] : null;", catches: "color" },
  "inherited key is a state": { old: "Object.prototype.hasOwnProperty.call(GIT_COLOR, x)", fresh: "x in GIT_COLOR", catches: "color" },
  "warning before error": { old: "return z.error > 0 ? \"error\" : z.warnings > 0 ? \"warning\" : null;", fresh: "return z.warnings > 0 ? \"warning\" : z.error > 0 ? \"error\" : null;", catches: "color" },
  "same folder gets a suffix": { old: "if (different.length < 2) continue;", fresh: "", catches: "additions" },
  "end as substring": { old: "return !atEnd || other.endsWith(withSeparator);", fresh: "return true;", catches: "additions" },
  "without omission at the front": { old: "${start > 0 ? `${OMISSION}/` : \"\"}", fresh: "", catches: "additions" },
  "root without ./": { old: "if (path === \"\") return \"./\";", fresh: "if (path === \"\") return \"\";", catches: "additions" },
  "Shift before Alt": { old: "relative: \"⌥⇧⌘C\"", fresh: "relative: \"⇧⌥⌘C\"", catches: "shortcut" },
  "chord takes Cmd+W": { old: "    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;\n", fresh: "", catches: "shortcut" },
  "Alt+Cmd+T without Alt": { old: "if (mod && e.altKey && !e.shiftKey && e.code === \"KeyT\")", fresh: "if (mod && !e.shiftKey && e.code === \"KeyT\")", catches: "shortcut" },
  "copy without Alt": { old: "if (!mod || !e.altKey || e.code !== \"KeyC\") return null;", fresh: "if (!mod || e.code !== \"KeyC\") return null;", catches: "shortcut" },
  "trail gets lost in the list": { old: "  ...(l.last ? { last: l.last.filter((p) => l.paths.includes(p)).map(k) } : {}),\n", fresh: "", catches: "list" },
  "background comes to the front": { old: "fixed: o.fixed, background: o.background, unsaved:", fresh: "fixed: o.fixed, unsaved:", catches: "list" },
  "rename bypasses the list": { old: "return fromState(renameStatus(asState(l), LIST_TARGET, old, fresh));", fresh: "return l;", catches: "list" },
  "delete bypasses the list": { old: "return fromState(removeFiles(asState(l), LIST_TARGET, path, () => false));", fresh: "return l;", catches: "list" },
  "right including the tab": { old: "return i < 0 ? [] : queue.slice(i + 1);", fresh: "return i < 0 ? [] : queue.slice(i);", catches: "set" },
  "saved = unsaved": { old: "case \"saved\": return queue.filter((k) => clean(k));", fresh: "case \"saved\": return queue.filter((k) => !clean(k));", catches: "set" },
  "drop always before": { old: "+ (afterwards ? 1 : 0);", fresh: "+ 0;", catches: "reorder" },
  "drop onto itself changes": { old: "if (i < 0 || from === to ||", fresh: "if (i < 0 ||", catches: "reorder" },
  "opening always pinned": { old: "fixed: o.fixed, background:", fresh: "fixed: true, background:", catches: "list" },
  "unsaved replaceable": { old: "return p !== undefined && Boolean(o.unsaved?.(p));", fresh: "return false;", catches: "list" },
};

// ── Compile: the source, its dependencies lib/chat-tabs.ts and lib/explorer-decoration.ts and one copy per sabotage, in ONE tsc run. ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-tab-bar-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "chat-tabs.ts"), read("src", "lib", "chat-tabs.ts"));
fs.writeFileSync(path.join(src, "explorer-decoration.ts"), read("src", "lib", "explorer-decoration.ts"));
fs.writeFileSync(path.join(src, "tab-bar.ts"), SOURCE);
const copies = [];
for (const [name, s] of Object.entries(SABOTAGES)) {
  const file = `tab-bar-sabotage-${copies.length}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, s.fresh));
  copies.push({ name, file, catches: s.catches, places: SOURCE.split(s.old).length - 1 });
}
try {
  execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((d) => path.join(src, d)), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "tab-bar.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = await load("tab-bar.ts");
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: await load(k.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

// ── The checks ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const CHECKS = {
  color(L) {
    // The values are the variables of the explorer (light/dark in app/globals.css): tree and tab color from ONE table.
    assert.equal(L.tabColor("modified", null), "var(--git-changed)", "M (modified)");
    assert.equal(L.tabColor("untracked", null), "var(--git-untracked)", "untracked has its own color as in VS Code");
    assert.equal(L.tabColor("deleted", null), "var(--git-deleted)");
    assert.equal(L.tabColor("conflict", null), "var(--git-conflict)");
    assert.equal(L.tabColor(null, null), null, "without Git and problem no own color");
    assert.equal(L.tabColor("modified", "error"), "var(--problem-error)", "an error colors before the Git state");
    assert.equal(L.tabColor("added", "warning"), "var(--problem-warning)", "a warning colors before the Git state");
    assert.equal(L.tabColor("unknown", null), null, "an unknown state does not color");
    assert.equal(L.tabColor("toString", null), null, "an inherited key is not a state");
    assert.equal(L.isGitKind("toString"), false);
    assert.equal(L.problemKind({ error: 1, warnings: 3 }), "error", "error before warning");
    assert.equal(L.problemKind({ error: 0, warnings: 2 }), "warning");
    assert.equal(L.problemKind({ error: 0, warnings: 0 }), null);
    assert.equal(L.problemKind(null), null);
  },
  additions(L) {
    // The results of VS Code (base/common/labels.ts `shorten` over the folders of tabs with the same name, multiEditorTabsControl).
    const z = (...paths) => L.nameAdditions(paths.map((p) => ({ name: p ? p.split("/").pop() : "x", path: p })));
    assert.deepEqual(z("src/a/index.ts", "src/b/index.ts", "src/app.ts"), ["…/a", "…/b", ""], "the shortest unique part, \"…\" for what is left out, a single name without suffix");
    assert.deepEqual(z("a/x/y.ts", "b/x/y.ts"), ["a/…", "b/…"], "the distinguishing folder in front, what is shared behind it as \"…\"");
    assert.deepEqual(z("y.ts", "lib/y.ts"), ["./", "lib"], "the root is called \"./\"");
    assert.deepEqual(z("a/y.ts", "a/y.ts"), ["", ""], "the same folder (two instances): no suffix (the instance is shown on the tab)");
    assert.deepEqual(z("a.ts", "b.ts"), ["", ""]);
    assert.deepEqual(z(null, null), ["", ""], "without a path (a commit) no suffix");
    assert.deepEqual(z("p/q/r/s.ts", "p/z/r/s.ts", "t.ts"), ["…/q/…", "…/z/…", ""], "omission at the front and at the back");
    assert.deepEqual(z("a/b/n.ts", "a/xb/n.ts"), ["…/b", "…/xb"], "an end only counts as a whole segment (\"b\" is not \"xb\")");
    assert.deepEqual(L.truncate(["src", "lib/src"]), ["src", "lib/…"], "without a unique part the whole path");
  },
  shortcut(L) {
    const k = (code, m = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m });
    const mac = { mac: true }, win = { mac: false };
    assert.deepEqual(L.menuShortcut(k("KeyT", { metaKey: true, altKey: true }), mac, false), { kind: "set", set: "other" }, "Alt+Cmd+T closes others");
    assert.equal(L.menuShortcut(k("KeyT", { metaKey: true }), mac, false), null, "Cmd+T alone is not it");
    assert.deepEqual(L.menuShortcut(k("KeyK", { metaKey: true }), mac, false), { kind: "chord" }, "Cmd+K starts the chord");
    assert.deepEqual(L.menuShortcut(k("KeyU"), mac, true), { kind: "set", set: "saved" }, "⌘K U");
    assert.deepEqual(L.menuShortcut(k("KeyW"), mac, true), { kind: "set", set: "all" }, "⌘K W");
    assert.deepEqual(L.menuShortcut(k("Enter"), mac, true), { kind: "fixed" }, "⌘K Enter");
    assert.equal(L.menuShortcut(k("KeyW", { metaKey: true }), mac, true), null, "Cmd+K Cmd+W is another command");
    assert.equal(L.menuShortcut(k("KeyU"), mac, false), null, "U without a chord is typing");
    assert.deepEqual(L.menuShortcut(k("KeyT", { ctrlKey: true, altKey: true }), win, false), { kind: "set", set: "other" }, "otherwise Ctrl");
    assert.equal(L.menuShortcut(k("KeyT", { ctrlKey: true, altKey: true }), mac, false), null, "on the Mac Ctrl is not Cmd");
    assert.equal(L.copyShortcut(k("KeyC", { metaKey: true, altKey: true }), mac), "path");
    assert.equal(L.copyShortcut(k("KeyC", { metaKey: true, altKey: true, shiftKey: true }), mac), "relative");
    assert.equal(L.copyShortcut(k("KeyC", { metaKey: true }), mac), null, "Cmd+C is copying");
    const t = L.shortcutText(mac);
    assert.deepEqual([t.other, t.saved, t.all, t.fixed, t.path, t.relative], ["⌥⌘T", "⌘K U", "⌘K W", "⌘K Enter", "⌥⌘C", "⌥⇧⌘C"], "the order ⌃⌥⇧⌘ as in VS Code");
    assert.equal(L.shortcutText(win).all, "Ctrl+K W");
  },
  set(L) {
    const queue = ["a", "b", "c", "d"];
    const clean = (k) => k !== "b";
    assert.deepEqual(L.closeSet("other", queue, "b", clean), ["a", "c", "d"]);
    assert.deepEqual(L.closeSet("right", queue, "b", clean), ["c", "d"]);
    assert.deepEqual(L.closeSet("right", queue, "d", clean), []);
    assert.deepEqual(L.closeSet("right", queue, "x", clean), [], "an unknown tab: nothing to the right");
    assert.deepEqual(L.closeSet("saved", queue, "a", clean), ["a", "c", "d"], "the unsaved one stays");
    assert.deepEqual(L.closeSet("all", queue, "a", clean), queue);
  },
  reorder(L) {
    const id = (x) => x;
    const r = ["a", "b", "c", "d"];
    assert.deepEqual(L.reorder(r, id, "a", "c", false), ["b", "a", "c", "d"], "before c");
    assert.deepEqual(L.reorder(r, id, "a", "c", true), ["b", "c", "a", "d"], "after c");
    assert.deepEqual(L.reorder(r, id, "d", "a", false), ["d", "a", "b", "c"], "to the front");
    assert.equal(L.reorder(r, id, "b", "b", true), r, "onto itself: the same list");
    assert.equal(L.reorder(r, id, "b", "c", false), r, "to the same place: the same list (no new state)");
    assert.equal(L.reorder(r, id, "x", "a", false), r, "unknown: the same list");
    assert.equal(L.dropAfter(70, 0, 100), true);
    assert.equal(L.dropAfter(30, 0, 100), false);
  },
  list(L) {
    const empty = { paths: [], active: null, preview: null };
    let l = L.openInList(empty, "a.ts");
    assert.deepEqual(l, { paths: ["a.ts"], active: "a.ts", preview: "a.ts", last: ["a.ts"] }, "a click opens as a preview");
    l = L.openInList(l, "b.ts");
    assert.deepEqual(l, { paths: ["b.ts"], active: "b.ts", preview: "b.ts", last: ["b.ts"] }, "the next preview replaces the old one in its place");
    l = L.keepInList(l, "b.ts");
    assert.equal(l.preview, null, "double click pins");
    l = L.openInList(l, "c.ts");
    assert.deepEqual(l, { paths: ["b.ts", "c.ts"], active: "c.ts", preview: "c.ts", last: ["c.ts", "b.ts"] });
    // Unsaved content is never replaced: the new preview is added.
    const dirty = L.openInList(l, "d.ts", { unsaved: (p) => p === "c.ts" });
    assert.deepEqual(dirty.paths, ["b.ts", "c.ts", "d.ts"], "an unsaved preview was replaced");
    // Opened pinned: is added, the preview stays.
    const fixed = L.openInList(l, "e.ts", { fixed: true });
    assert.deepEqual(fixed, { paths: ["b.ts", "c.ts", "e.ts"], active: "e.ts", preview: "c.ts", last: ["e.ts", "c.ts", "b.ts"] }, "opening pinned does not replace the preview");
    // An open file only becomes active (and goes to the front of the trail).
    assert.deepEqual(L.openInList(fixed, "b.ts"), { ...fixed, active: "b.ts", last: ["b.ts", "e.ts", "c.ts"] });
    // Closing without a trail: the right neighbor, else the left one; with a trail: the most recently used one.
    const withoutLane = { paths: fixed.paths, active: "c.ts", preview: null };
    assert.equal(L.closeInList(withoutLane, "c.ts").active, "e.ts");
    assert.equal(L.closeInList({ ...withoutLane, active: "e.ts" }, "e.ts").active, "c.ts");
    const lane = { paths: ["a.ts", "b.ts", "c.ts"], active: "c.ts", preview: null, last: ["c.ts", "a.ts", "b.ts"] };
    assert.equal(L.closeInList(lane, "c.ts").active, "a.ts", "the most recently used one, not the neighbor");
    assert.deepEqual(L.activateInList(lane, "b.ts").last, ["b.ts", "c.ts", "a.ts"], "a click maintains the trail");
    assert.deepEqual(L.openInList({ ...lane, active: "a.ts" }, "x.ts", { fixed: true }).paths, ["a.ts", "x.ts", "b.ts", "c.ts"], "new one right next to the active one");
    const rear = L.openInList(lane, "y.ts", { fixed: true, background: true });
    assert.deepEqual([rear.paths, rear.active], [["a.ts", "b.ts", "c.ts", "y.ts"], "c.ts"], "in the background: added, nothing comes to the front");
    assert.deepEqual(L.closeInList({ paths: ["a.ts"], active: "a.ts", preview: "a.ts" }, "a.ts"), { ...empty, last: [] }, "the last tab: nothing active, no preview");
    // Rename and delete in the tree via the same rule.
    const tree = { paths: ["src/a.ts", "src/b.ts", "c.ts"], active: "src/a.ts", preview: "src/b.ts", last: ["src/a.ts", "c.ts", "src/b.ts"] };
    assert.deepEqual(L.renameInList(tree, "src", "lib"), { paths: ["lib/a.ts", "lib/b.ts", "c.ts"], active: "lib/a.ts", preview: "lib/b.ts", last: ["lib/a.ts", "c.ts", "lib/b.ts"] }, "the folder moves along with active, preview and trail");
    const way = L.removeFromList(tree, "src");
    assert.deepEqual([way.paths, way.active, way.preview], [["c.ts"], "c.ts", null], "the deleted folder closes its tabs");
  },
};

test("(1) Computations: color, folder suffix, menu sets, shortcuts, reordering, preview/pinned/trail as in the chat", () => {
  for (const [k, check] of Object.entries(CHECKS)) {
    try { check(real); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
});

test("(1) Counter-tests: every sabotage occurs exactly once in the source and is caught by its check", () => {
  const stale = copies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}x)`);
  assert.deepEqual(stale, [], "sabotages whose spot does not occur exactly once in the source");
  const notCaught = [];
  for (const s of sabotaged) {
    let caught = false;
    try { CHECKS[s.catches](s.mod); } catch { caught = true; }
    if (!caught) notCaught.push(`${s.name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  console.log(`  [tab-bar] ${sabotaged.length} sabotages, each caught`);
});

// ── (2) The sources ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const Q = {
  tile: read("src", "components", "code", "TabBar.tsx"),
  chat: read("src", "components", "chat", "ChatTabBar.tsx"),
  hook: read("src", "components", "chat", "chatTabs.ts"),
  pane: read("src", "components", "CodePane.tsx"),
};
const SOURCE_CHECKS = {
  oneBuildingBlock(q) {
    const k = withoutComments(q.tile);
    assert.match(k, /export function TabTile\(/, "TabTile is missing");
    // Both bars draw their file tabs with TabTile, and neither has a tab form of its own any more.
    const chat = withoutComments(q.chat);
    assert.ok((chat.match(/<TabTile\b/g) ?? []).length >= 2, "the chat does not draw views and code tabs with TabTile");
    assert.ok(!/<FileIcon\b/.test(chat), "the chat draws a file icon of its own");
    const pane = withoutComments(q.pane);
    assert.ok(pane.includes("<CodeTabBar"), "the files page does not draw its tabs with the tab bar");
    assert.ok(!/role="tab"/.test(pane), "CodePane still draws tabs of its own");
    // The icon only via FileSymbol.
    assert.ok(k.includes("<FileSymbol path={symbolPath} />"), "the file icon does not come from FileSymbol");
  },
  vscodeBehavior(q) {
    const k = withoutComments(q.tile);
    assert.ok(k.includes("onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}"), "middle click does not close");
    assert.ok(k.includes("onDoubleClick={onKeep}"), "double click does not pin");
    assert.ok(k.includes('preview ? "italic" : ""'), "the preview is not italic");
    // ✕ always on the active one, otherwise on hover; with unsaved content the dot in its place.
    assert.ok(k.includes('dirty || !active ? "opacity-0 group-hover:opacity-100" : ""'), "the ✕ is not on the active tab or on hover");
    assert.ok(k.includes("data-tab-unsaved"), "no dot for unsaved content");
    // The name carries the color (Git, problem) and the suffix of equal names stands dimmed behind it.
    assert.ok(k.includes("style={color ? { color: color } : undefined}"), "the name does not carry the color");
    assert.ok(k.includes("data-tab-addition"), "no folder suffix");
    // Dragging reorders.
    assert.ok(k.includes("draggable={Boolean(drag)}") && k.includes('e.dataTransfer.setData(DRAG_TYPE, drag.key)'), "dragging is missing");
    assert.ok(k.includes("drag.onDropped(from, dropAfter(e.clientX, r.left, r.width))"), "the drop does not reorder via dropAfter");
  },
  menuAndAccess(q) {
    const k = withoutComments(q.tile);
    assert.ok(k.includes("openEditorMenu({ x: e.clientX, y: e.clientY, groups: menu() })"), "the context menu is not the ONE editor menu");
    assert.ok(!/fixed inset-0/.test(k), "a fixed inset-0 catcher");
    // ✕ NEXT TO the role=tab, no tab stop.
    const span = k.indexOf("{...tabProps}"), to = k.indexOf("</span>\n      <button", span), x = k.indexOf("data-tab-close", span);
    assert.ok(span > 0 && to > span && x > to, "the ✕ is INSIDE the role=tab");
    assert.match(k.slice(to, x), /tabIndex=\{-1\}/, "the ✕ is a tab stop");
    // The entries of the menu as in VS Code.
    for (const w of ["Close", "Close Others", "Close to the Right", "Close Saved", "Close All", "Copy Path", "Copy Relative Path", "Reveal in Explorer View", "Keep Open"]) {
      assert.ok(k.includes(`t("${w}")`), `the entry "${w}" is missing`);
    }
  },
  menuVSCode(q) {
    // A shortcut only appears where it is bound (the caller supplies them), an empty entry is gray, the clipboard
    // is written in the click (the root is available up front), ⌥⌘C/⌥⇧⌘C on the focused tab.
    const k = withoutComments(q.tile);
    const menu = k.slice(k.indexOf("export function tabMenu("), k.indexOf("export function problemOfTheFile("));
    assert.ok(!/right: "[^"]/.test(menu), "a shortcut is hard-coded in the menu (bound or not)");
    assert.ok(menu.includes("right: k.path, disabled: !w, execute: () => { if (w) copyText(fullPath(w, rel)); } },") && !menu.includes(".then("), "\"Copy Path\" writes after an await");
    assert.ok(menu.includes("disabled: empty(id),"), "a set that would hit nothing is not gray");
    assert.ok(k.includes("useRootsUpfront([apiBase]);") && k.includes("root: rootNow(apiBase),"), "the files page does not read the root up front");
    assert.ok(k.includes("const copy = copyShortcut(e, { mac });"), "Alt+Cmd+C on the tab is not bound");
    const c = withoutComments(q.chat);
    assert.ok(c.includes("useRootsUpfront(state.tabs.map((x) => x.target.apiBase));") && c.includes("root: rootNow(tab.target.apiBase),"), "the chat does not read the root up front");
    assert.ok(c.includes("const copy = copyShortcut(e, { mac: tabs.mac });"), "Alt+Cmd+C on the chat tab is not bound");
    const h = withoutComments(q.hook);
    assert.ok(h.includes("const m = s.active === CHAT ? null : menuShortcut(ev, r.environment, chord.current);"), "Alt+Cmd+T, Cmd+K U, Cmd+K W are not bound in the chat");
    assert.ok(h.includes("shortcut: { close: closeShortcutText(environment), ...shortcutText(environment) },"), "the chat shows other shortcuts than it binds");
    const p = withoutComments(q.pane);
    assert.ok(p.includes("if (tabKeys(e)) return;") && p.includes("const m = menuShortcut(e, environment, chord.current);"), "the files page does not bind the shortcuts of its menu");
    assert.ok(p.includes("shortcut={tabShortcutTexts}"), "the files page shows other shortcuts than it binds");
  },
  closeAsVSCode(q) {
    // A cancel ("Close anyway?" -> no) ends "close several", in the chat AND on the files page.
    const h = withoutComments(q.hook);
    assert.ok(h.includes("const closeTab = useCallback(async (key: string): Promise<boolean> => {"), "closing does not say whether it was canceled");
    assert.ok(h.includes("if (!(await closeTab(x))) return;"), "a cancel keeps closing in the chat");
    assert.ok(!withoutComments(q.chat).includes("await tabs.close(x)"), "the bar closes sets bypassing the rule");
    const p = withoutComments(q.pane);
    // Unsaved means "the buffer the tab shows" (`dirtyOf`, lib/editor-inputs.ts `bufferFile`, also a diff).
    assert.ok(p.includes("(x) => !dirtyOf(x))) {\n      if (!(await closeTab(p, gid))) return;\n"), "a cancel keeps closing on the files page");
    // The diff tab copies repo + file (the file alone is relative to the repo).
    const c = withoutComments(q.chat);
    assert.ok(c.includes("relPath: tabRelPath(tab),") && c.includes("return d === null ? null : targetPath(tab.source.repo, d);"), "the relative path of a diff tab is relative to the repo");
  },
  previewInMenu(q) {
    // "Open Preview" in the tab menu of a Markdown file as in VS Code (`markdown.showPreview` in editor/title/context, group `1_open`,
    // after copying, before "Reveal in Explorer View"); a preview (a webview) has neither "Copy Path" nor "Reveal in Explorer View",
    // in the chat as on the files page.
    const k = withoutComments(q.tile), menu = k.slice(k.indexOf("export function tabMenu("), k.indexOf("export function problemOfTheFile("));
    const v = menu.indexOf("if (h.openPreview) groups.push([{ id: \"markdown.showPreview\", label: t(\"Open Preview\"), execute: h.openPreview }]);");
    assert.ok(v > menu.indexOf("id: \"rel-path\"") && v < menu.indexOf("id: \"explorer\""), "\"Open Preview\" is missing in the tab menu (or is not between copying and explorer)");
    assert.ok(k.includes("openPreview: onPreview?.(p),"), "the files page does not pass \"Open Preview\" to the menu");
    const c = withoutComments(q.chat);
    assert.ok(c.includes("openPreview: tab.kind === \"file\" && isMarkdown(tab.path) ? () => tabs.openPreview(tab.target, tab.path) : undefined,"), "\"Open Preview\" is missing in the tab menu in the chat");
    assert.ok(c.includes("showInExplorer: tab.kind === \"file\" ? () => tabs.showInExplorer(k) : undefined,") && c.includes("if (tab.kind === \"preview\") return null;"), "a preview in the chat has \"Copy Path\"/\"Reveal in Explorer View\"");
    const p = withoutComments(q.pane);
    assert.ok(p.includes("onPreview={(p) => (E.isFileTab(p) && isMarkdown(p) ? () => { const s0 = gr.ref.current; if (applyGroups((x) => E.openPreview(G.activateGroup(x, g.id), g.id, p)) !== s0) focusWish.current = g.id; } : undefined)}"), "the files page does not offer \"Open Preview\" (or in the wrong group)");
  },
  listOverTheRule(q) {
    // Every change of the lists of the files page goes through the groups (lib/editor-groups.ts: they compute via
    // lib/tab-bar.ts and maintain the trail, executed in web/test/editor-groups.test.mjs), never past them. Rename
    // and delete compute via the keys of the tabs (lib/editor-inputs.ts `followRename`/`hitsDeleted`: previews and
    // diffs move along or drop out).
    const p = withoutComments(q.pane);
    for (const must of [
      "applyGroups((s) => E.followRename(s, (a) => (a === path ? to : a.startsWith(`${path}/`) ? to + a.slice(path.length) : a), followUpLocation, false, dirtyOf));",
      "applyGroups((s) => G.remove(s, E.hitsDeleted((a) => a === path || a.startsWith(path + \"/\"), dirtyOf, followUpLocation)));", "else applyGroups((s) => G.remove(s, E.hitsFile((x) => x === path)));",
      "onActivate={(p) => { applyGroups((s) => G.activateTab(s, g.id, p)); if (E.isFileTab(p)) setSelected(p); }}", "else applyGroups((s) => G.openInBackground(s, pf));",
    ]) assert.ok(p.includes(must), `bypasses the rule: ${must}`);
    assert.ok(!/\bsetActivePath\(|\bsetPreview\(/.test(p), "active or preview set past the groups");
  },
};
const SOURCE_SABOTAGES = {
  "middle click does nothing": { file: "tile", old: "onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}", fresh: "", catches: "vscodeBehavior" },
  "preview not italic": { file: "tile", old: 'preview ? "italic" : ""', fresh: '""', catches: "vscodeBehavior" },
  "✕ always hidden": { file: "tile", old: 'dirty || !active ? "opacity-0 group-hover:opacity-100" : ""', fresh: '"opacity-0 group-hover:opacity-100"', catches: "vscodeBehavior" },
  "name without color": { file: "tile", old: "style={color ? { color: color } : undefined}", fresh: "", catches: "vscodeBehavior" },
  "drop without side": { file: "tile", old: "drag.onDropped(from, dropAfter(e.clientX, r.left, r.width))", fresh: "drag.onDropped(from, false)", catches: "vscodeBehavior" },
  "own menu": { file: "tile", old: "openEditorMenu({ x: e.clientX, y: e.clientY, groups: menu() })", fresh: "void 0", catches: "menuAndAccess" },
  "✕ as tab stop": { file: "tile", old: "        tabIndex={-1}\n        onClick={(e) => { e.stopPropagation(); onClose(); }}", fresh: "        onClick={(e) => { e.stopPropagation(); onClose(); }}", catches: "menuAndAccess" },
  "Copy Path missing": { file: "tile", old: 't("Copy Relative Path")', fresh: 't("Path (relative)")', catches: "menuAndAccess" },
  "icon bypasses the building block": { file: "tile", old: "<FileSymbol path={symbolPath} />", fresh: "<span />", catches: "oneBuildingBlock" },
  "files page with a bar of its own": { file: "pane", old: "<CodeTabBar", fresh: "<div", catches: "oneBuildingBlock" },
  "Copy Path after await": { file: "tile", old: "execute: () => { if (w) copyText(fullPath(w, rel)); } },", fresh: "execute: () => { void rootOf(\"x\").then((x) => copyText(x ?? rel)); } },", catches: "menuVSCode" },
  "shortcut hard-coded in the menu": { file: "tile", old: "right: k.relative,", fresh: "right: \"⇧⌥⌘C\",", catches: "menuVSCode" },
  "set never gray": { file: "tile", old: "disabled: empty(id),", fresh: "", catches: "menuVSCode" },
  "Alt+Cmd+C unbound on the tab": { file: "tile", old: "const copy = copyShortcut(e, { mac });", fresh: "const copy = null as null | \"path\";", catches: "menuVSCode" },
  "chat does not bind the menu": { file: "hook", old: "const m = s.active === CHAT ? null : menuShortcut(ev, r.environment, chord.current);", fresh: "const m = null as ReturnType<typeof menuShortcut>;", catches: "menuVSCode" },
  "files do not bind the menu": { file: "pane", old: "if (tabKeys(e)) return;", fresh: "", catches: "menuVSCode" },
  "cancel keeps closing in the chat": { file: "hook", old: "if (!(await closeTab(x))) return;", fresh: "await closeTab(x);", catches: "closeAsVSCode" },
  "cancel keeps closing on files": { file: "pane", old: "(x) => !dirtyOf(x))) {\n      if (!(await closeTab(p, gid))) return;\n", fresh: "(x) => !dirtyOf(x))) {\n      await closeTab(p, gid);\n", catches: "closeAsVSCode" },
  "diff path relative to the repo": { file: "chat", old: "relPath: tabRelPath(tab),", fresh: "relPath: tab.kind === \"file\" ? tab.path : diffPath(tab.source),", catches: "closeAsVSCode" },
  "Open Preview missing in the menu": { file: "tile", old: "if (h.openPreview) groups.push([{ id: \"markdown.showPreview\", label: t(\"Open Preview\"), execute: h.openPreview }]);\n", fresh: "", catches: "previewInMenu" },
  "Open Preview behind the explorer": { file: "tile", old: "if (h.openPreview) groups.push([{ id: \"markdown.showPreview\", label: t(\"Open Preview\"), execute: h.openPreview }]);\n  if (h.showInExplorer) groups.push([{ id: \"explorer\", label: t(\"Reveal in Explorer View\"), execute: h.showInExplorer }]);", fresh: "if (h.showInExplorer) groups.push([{ id: \"explorer\", label: t(\"Reveal in Explorer View\"), execute: h.showInExplorer }]);\n  if (h.openPreview) groups.push([{ id: \"markdown.showPreview\", label: t(\"Open Preview\"), execute: h.openPreview }]);", catches: "previewInMenu" },
  "page does not pass the preview": { file: "tile", old: "openPreview: onPreview?.(p),", fresh: "", catches: "previewInMenu" },
  "chat without Open Preview": { file: "chat", old: "openPreview: tab.kind === \"file\" && isMarkdown(tab.path) ? () => tabs.openPreview(tab.target, tab.path) : undefined,", fresh: "", catches: "previewInMenu" },
  "chat preview in the explorer": { file: "chat", old: "showInExplorer: tab.kind === \"file\" ?", fresh: "showInExplorer: tab.kind !== \"diff\" ?", catches: "previewInMenu" },
  "chat preview copies its path": { file: "chat", old: "  if (tab.kind === \"preview\") return null;\n", fresh: "", catches: "previewInMenu" },
  "page without Open Preview": { file: "pane", old: "onPreview={(p) => (E.isFileTab(p) && isMarkdown(p) ?", fresh: "onPreview={(p) => (false ?", catches: "previewInMenu" },
  "rename bypasses the list (page)": { file: "pane", old: "applyGroups((s) => E.followRename(s, (a) => (a === path ? to : a.startsWith(`${path}/`) ? to + a.slice(path.length) : a), followUpLocation, false, dirtyOf));", fresh: "void to;", catches: "listOverTheRule" },
  "delete bypasses the list (page)": { file: "pane", old: "applyGroups((s) => G.remove(s, E.hitsDeleted((a) => a === path || a.startsWith(path + \"/\"), dirtyOf, followUpLocation)));", fresh: "void path;", catches: "listOverTheRule" },
  "discard bypasses the list": { file: "pane", old: "else applyGroups((s) => G.remove(s, E.hitsFile((x) => x === path)));", fresh: "else setTabs((prev) => prev.filter((x) => x.path !== path));", catches: "listOverTheRule" },
  "click bypasses the trail": { file: "pane", old: "onActivate={(p) => { applyGroups((s) => G.activateTab(s, g.id, p)); if (E.isFileTab(p)) setSelected(p); }}", fresh: "onActivate={(p) => { setActivePath(p); setSelected(p); }}", catches: "listOverTheRule" },
};

test("(2) Sources: ONE building block for files and chat, behavior as in VS Code, menu and accessibility", () => {
  for (const [name, check] of Object.entries(SOURCE_CHECKS)) {
    try { check(Q); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
});

test("(2) Counter-probes on the sources: every sabotage occurs exactly once and is caught", () => {
  const stale = [], notCaught = [];
  for (const [name, s] of Object.entries(SOURCE_SABOTAGES)) {
    const n = Q[s.file].split(s.old).length - 1;
    if (n !== 1) { stale.push(`${name} (${n}x)`); continue; }
    let caught = false;
    try { SOURCE_CHECKS[s.catches]({ ...Q, [s.file]: Q[s.file].replace(s.old, s.fresh) }); } catch { caught = true; }
    if (!caught) notCaught.push(`${name} (${s.catches})`);
  }
  assert.deepEqual(stale, [], "sabotages whose spot does not occur exactly once");
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
});
