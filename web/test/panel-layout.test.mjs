// Panel and layout of Coding → Files as in VS Code:
//
// (1) The computations of lib/panel-layout.ts, EXECUTED: sizes with the VS Code limits (side bar ≥ 170, the editor keeps 220 ×
//     header + 70, panel ≥ 77; defaults min(300, width/4) and a third of the work area; double-click max(300, longest name + 16) or
//     40 % of the work area — measured on the container, never on the window), snapping off below half the minimum size, the steps as
//     in VS Code layout.ts (Cmd+J opens with focus, EVERY close gives it to the editor; Cmd+B shows without focus and when hiding the
//     focus goes to the panel or the editor; Shift+Cmd+M and Ctrl+` open OR close; the status bar toggles with focus; "Maximize" opens a
//     closed panel maximized; the end of the terminal closes it; Shift+Cmd+E/Shift+Cmd+D back to the editor, Shift+Cmd+F always the
//     search, a tab click takes no focus, closing keeps "maximized"), the search seed (single line, not with focus in the search,
//     escaped in regex mode), what is remembered and the keys (Mac and Ctrl, "`" also via `Backquote`).
// (2) The sources: the wiring remembers per device inside try/catch but never "open", and reads before the first paint together with
//     the refs; the commands appear in the table only for editors of a layout; a key runs once; on the page also without focus; the
//     focus finds a target in the panel; the terminal lets the workbench keys through; the optimal width measures the text, dragging
//     works on the element and snaps off below half the width; CodePane attaches width, drag bar (with name and value), seed, keys
//     and palette, the status bar toggles with focus; the palette names no command twice and no dead one; the drag bar also ends on
//     cancel; every wording is in i18n-de.ts.
//
// Each sabotage is a copy of the source with ONE changed spot (exactly once there); the assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/panel-layout.test.mjs
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

const SOURCE = read("src", "lib", "panel-layout.ts");
const SABOTAGES = {
  "editor without minimum width": { old: "slot - EDITOR_MIN_WIDTH", fresh: "slot", catches: "sizes" },
  "side bar without minimum": { old: "clamp(wish, SIDEBAR_MIN, ", fresh: "clamp(wish, 0, ", catches: "sizes" },
  "fixed default 300": { old: "remembered ?? Math.min(SIDEBAR_PREFERRED, slot / 4)", fresh: "remembered ?? SIDEBAR_PREFERRED", catches: "sizes" },
  "double-click without names": { old: "Math.max(SIDEBAR_PREFERRED, Number.isFinite(optimal) ? optimal : 0)", fresh: "SIDEBAR_PREFERRED", catches: "sizes" },
  "panel without minimum": { old: "PANEL_MIN_HEIGHT, m.slot - Math.max(EDITOR_MIN_HEIGHT, m.editorMin)", fresh: "0, m.slot - Math.max(EDITOR_MIN_HEIGHT, m.editorMin)", catches: "sizes" },
  "editor without minimum height": { old: "m.slot - Math.max(EDITOR_MIN_HEIGHT, m.editorMin)", fresh: "m.slot", catches: "sizes" },
  "editor minimum without header": { old: "Math.max(EDITOR_MIN_HEIGHT, m.editorMin)", fresh: "EDITOR_MIN_HEIGHT", catches: "sizes" },
  "panel default on the slot instead of the work area": { old: "remembered ?? (m.work > 0 ? m.work : m.slot) / 3", fresh: "remembered ?? m.slot / 3", catches: "sizes" },
  "panel double-click one third": { old: "panelHeight((m.work > 0 ? m.work : m.slot) * 0.4, m)", fresh: "panelHeight((m.work > 0 ? m.work : m.slot) / 3, m)", catches: "sizes" },
  "optimal without margin": { old: "Math.ceil(max) + OPTIMAL_MARGIN", fresh: "Math.ceil(max)", catches: "optimal" },
  "optimal without indent": { old: "max = Math.max(max, n.left - pageLeft + n.width);", fresh: "max = Math.max(max, n.width);", catches: "optimal" },
  "never snaps off": { old: "return wish < min / 2 ? \"off\" : \"on\";", fresh: "return \"on\";", catches: "optimal" },
  "snaps off already at the minimum": { old: "wish < min / 2 ?", fresh: "wish < min ?", catches: "optimal" },
  "Cmd+J does not close": { old: "case \"panel\": return s.open ? close() : ", fresh: "case \"panel\": return false ? close() : ", catches: "panel" },
  "view closes without focus": { old: "s.tab === a.tab && focusInPanel) return close();", fresh: "s.tab === a.tab) return close();", catches: "panel" },
  "view never closes": { old: "      if (s.open && s.tab === a.tab && focusInPanel) return close();\n", fresh: "", catches: "panel" },
  "status bar only with focus": { old: "if (s.open && s.tab === a.tab) return close();", fresh: "if (s.open && s.tab === a.tab && focusInPanel) return close();", catches: "panel" },
  "status bar opens without focus": { old: "      return { state: { ...s, open: true, tab: a.tab }, focus: \"panel\" };\n    case \"show\"", fresh: "      return { state: { ...s, open: true, tab: a.tab }, focus: null };\n    case \"show\"", catches: "panel" },
  "tab click takes the focus": { old: "case \"show\": return { state: { ...s, open: true, tab: a.tab }, focus: null };", fresh: "case \"show\": return { state: { ...s, open: true, tab: a.tab }, focus: \"panel\" };", catches: "panel" },
  "closing leaves the focus nowhere": { old: "({ state: { ...s, open: false }, focus: \"editor\" })", fresh: "({ state: { ...s, open: false }, focus: null })", catches: "panel" },
  "closing clears maximized": { old: "({ state: { ...s, open: false }, ", fresh: "({ state: { ...s, open: false, maximized: false }, ", catches: "panel" },
  "maximize does not toggle back": { old: "maximized: !s.maximized", fresh: "maximized: true", catches: "panel" },
  "maximize only opens": { old: "{ state: { ...s, open: true, maximized: true }, focus: \"panel\" }", fresh: "{ state: { ...s, open: true }, focus: \"panel\" }", catches: "panel" },
  "terminal end does not close": { old: "case \"terminalWay\": return s.open && s.tab === \"terminal\" ? close()", fresh: "case \"terminalWay\": return false ? close()", catches: "panel" },
  "terminal end closes every tab": { old: "s.open && s.tab === \"terminal\" ? close()", fresh: "s.open ? close()", catches: "panel" },
  "Cmd+B: focus only from the page": { old: "focus: l.panelOpen && (l.inPanel || l.editorHidden) ? \"panel\" : \"editor\"", fresh: "focus: l.inPage ? \"editor\" : null", catches: "page" },
  "Cmd+B forgets the panel": { old: "l.panelOpen && (l.inPanel || l.editorHidden) ? \"panel\" : ", fresh: "", catches: "page" },
  "Cmd+B: maximized panel does not count": { old: "(l.inPanel || l.editorHidden)", fresh: "(l.inPanel)", catches: "page" },
  "Cmd+B takes the focus when showing": { old: "if (!s.visible) return { state: { ...s, visible: true }, focus: null };", fresh: "if (!s.visible) return { state: { ...s, visible: true }, focus: \"page\" };", catches: "page" },
  "Shift+Cmd+E never goes to the editor": { old: "      if (s.visible && s.mode === a.mode && l.inPage) return { state: s, focus: \"editor\" };\n", fresh: "", catches: "page" },
  "Shift+Cmd+F without search": { old: "case \"search\": return { state: { visible: true, mode: \"search\" }, focus: \"page\" };", fresh: "case \"search\": return { state: { ...s, visible: true }, focus: \"page\" };", catches: "page" },
  "seed multi-line": { old: "t && !/[\\r\\n]/.test(t) ? t : null", fresh: "t ? t : null", catches: "seed" },
  "seed with focus in the search": { old: "return !focusInSearch && t", fresh: "return t", catches: "seed" },
  "regex not escaped": { old: "return regex ? text.replace(", fresh: "return false ? text.replace(", catches: "seed" },
  "remembered height unchecked": { old: "height: typeof h === \"number\" && Number.isFinite(h) && h > 0 ? h : null,", fresh: "height: (h as number) ?? null,", catches: "remembered" },
  "remembered tab unchecked": { old: "tab: (PANEL_TAB as readonly unknown[]).includes(o.tab) ? (o.tab as PanelTab) : null,", fresh: "tab: (o.tab as PanelTab) ?? null,", catches: "remembered" },
  "backtick only via key": { old: "  if (!name.endsWith(\"-`\") || e.code !== \"Backquote\") return false;\n", fresh: "  return false;\n", catches: "keys" },
  "backtick without modifiers": { old: "return matchesKey(`${name.slice(0, -1)}x`, { ...e, code: \"KeyX\", key: \"x\" }, mac);", fresh: "return true;", catches: "keys" },
  "Shift+Cmd+F takes Cmd+F": { old: "keys: [\"Mod-Shift-f\"]", fresh: "keys: [\"Mod-f\"]", catches: "keys" },
  "terminal on Cmd+`": { old: "keys: [\"Ctrl-`\"]", fresh: "keys: [\"Mod-`\"]", catches: "keys" },
  "Cmd+J as Shift+Cmd+J": { old: "keys: [\"Mod-j\"]", fresh: "keys: [\"Mod-Shift-j\"]", catches: "keys" },
  "Shift+Cmd+D missing": { old: "keys: [\"Mod-Shift-d\"]", fresh: "keys: []", catches: "keys" },
};

// ── Compile: panel-layout.ts with lib/commandPalette.ts, lib/api/lsp.ts (core.ts as a stand-in without network) and one copy per sabotage. ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-panel-layout-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(path.join(src, "api"), { recursive: true });
fs.writeFileSync(path.join(src, "api", "lsp.ts"), read("src", "lib", "api", "lsp.ts"));
fs.writeFileSync(path.join(src, "api", "core.ts"), "export async function api<T = unknown>(p: string, _o?: RequestInit): Promise<T> { throw new Error(`no network in the test: ${p}`); }\n");
fs.writeFileSync(path.join(src, "commandPalette.ts"), read("src", "lib", "commandPalette.ts"));
fs.writeFileSync(path.join(src, "panel-layout.ts"), SOURCE);
const copies = [];
for (const [name, s] of Object.entries(SABOTAGES)) {
  const file = `panel-layout-sabotage-${copies.length}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, s.fresh));
  copies.push({ name, file, catches: s.catches, places: SOURCE.split(s.old).length - 1 });
}
const allTs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allTs(path.join(dir, e.name)) : [path.join(dir, e.name)]));
try {
  execFileSync(process.execPath, [tsc, ...allTs(src), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "panel-layout.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = await load("panel-layout.ts");
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: await load(k.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

// ── (1) Checks of the computations ───────────────────────────────────────────────────────────────────────────────────────────────────
const press = (code, key, mod = {}) => ({ code, key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mod });
const S = (open, tab = "problems", maximized = false) => ({ open, tab, maximized });
const M = (slot, work = slot, editorMin = 70) => ({ slot, work, editorMin });
/** Where the focus is: in the side bar, in the panel; open, maximized (the editor hidden). */
const situation = (o = {}) => ({ inPage: false, inPanel: false, panelOpen: false, editorHidden: false, ...o });
const CHECKS = {
  sizes(L) {
    assert.equal(L.sidebarWidth(null, 1600), 300, "default: at most 300");
    assert.equal(L.sidebarWidth(null, 800), 200, "default: a quarter of the width");
    assert.equal(L.sidebarWidth(null, 600), 170, "default: never below 170");
    assert.equal(L.sidebarWidth(100, 1000), 170, "dragged: never below 170");
    assert.equal(L.sidebarWidth(1000, 1000), 780, "dragged: the editor keeps 220");
    assert.equal(L.sidebarWidth(650, 1400), 650, "no fixed upper limit (VS Code: unlimited up to the editor minimum)");
    assert.equal(L.sidebarWidth(null, 0), 240, "unmeasured: the previous width");
    assert.equal(L.sidebarWidth(450, 0), 450, "unmeasured: the remembered value");
    assert.equal(L.sidebarBack(0, 1600), 300, "double-click without names: 300");
    assert.equal(L.sidebarBack(520.4, 1600), 520, "double-click: the longest name");
    assert.equal(L.sidebarBack(5000, 1600), 1380, "double-click: clamped");
    // Measured on the container — `slot` (editor area + panel), `work` (all of CodePane), `editorMin` (group header + 70).
    assert.equal(L.panelHeight(null, M(900)), 300, "panel: default one third");
    assert.equal(L.panelHeight(null, M(840, 1200)), 400, "panel: one third of the WORK AREA (VS Code: the workbench), not of the slot");
    assert.equal(L.panelHeight(50, M(900)), 77, "panel: never below 77");
    assert.equal(L.panelHeight(2000, M(900)), 830, "panel: the editor keeps 70");
    assert.equal(L.panelHeight(2000, M(900, 900, 105)), 795, "panel: the editor keeps its header + 70 (measured, not a fixed 57)");
    assert.equal(L.panelHeight(2000, M(900, 900, 0)), 830, "panel: unmeasured header — at least 70");
    assert.equal(L.panelHeight(null, M(0, 0, 0)), 260, "panel unmeasured");
    assert.equal(L.panelHeight(333, M(0, 0, 0)), 333, "panel unmeasured: the remembered value");
    assert.equal(L.panelBack(M(900, 1000, 105)), 400, "panel double-click: 40 % of the work area");
    assert.equal(L.clamp(500, 170, 100), 170, "if the space is not enough, the minimum applies");
  },
  // The optimal width from the TEXT widths of the names (+16 as in VS Code), snapping off below half the minimum size.
  optimal(L) {
    assert.equal(L.optimalWidthFrom(100, [{ left: 140, width: 100 }, { left: 120, width: 60 }]), 156, "the right edge of the widest name + 16");
    assert.equal(L.optimalWidthFrom(0, [{ left: 10, width: 50.2 }]), 77, "roundedUp");
    assert.equal(L.optimalWidthFrom(100, []), 0, "nothing measured: 0 (then 300 applies)");
    const names = [{ left: 140, width: 100 }];
    assert.equal(L.optimalWidthFrom(100, names), L.optimalWidthFrom(100, names), "the same tree yields the same width (used to grow by 12 px per double-click)");
    assert.deepEqual([84, 85, 100, 170].map((w) => L.snap(w, 170)), ["off", "on", "on", "on"], "side bar: below 85 px it snaps off");
    assert.deepEqual([38, 39, 77].map((w) => L.snap(w, 77)), ["off", "on", "on"], "panel: below 38.5 px it snaps off");
  },
  panel(L) {
    const p = (s, a, f) => { const r = L.panelStep(s, a, f); return [r.state.open, r.state.tab, r.state.maximized, r.focus]; };
    // VS Code layout.ts `setPanelHidden`: opening focuses the panel, EVERY close gives the focus to the editor.
    assert.deepEqual(p(S(false), { kind: "panel" }, false), [true, "problems", false, "panel"], "Cmd+J opens and focuses");
    assert.deepEqual(p(S(true, "terminal"), { kind: "panel" }, true), [false, "terminal", false, "editor"], "Cmd+J closes, the focus goes to the editor");
    assert.deepEqual(p(S(true), { kind: "panel" }, false), [false, "problems", false, "editor"], "Cmd+J closes — the focus goes to the editor from elsewhere too (setPanelHidden)");
    const m = { kind: "view", tab: "problems" };
    assert.deepEqual(p(S(false, "terminal"), m, false), [true, "problems", false, "panel"], "Shift+Cmd+M opens the problems");
    assert.deepEqual(p(S(true), m, false), [true, "problems", false, "panel"], "Shift+Cmd+M with focus elsewhere: focus, do not close");
    assert.deepEqual(p(S(true), m, true), [false, "problems", false, "editor"], "Shift+Cmd+M with focus inside: close");
    assert.deepEqual(p(S(true, "terminal"), m, true), [true, "problems", false, "panel"], "Shift+Cmd+M from the terminal: to problems");
    // VS Code `toggleProblems`: visible ⇒ close, otherwise open WITH focus.
    const u = { kind: "toggle", tab: "problems" };
    assert.deepEqual(p(S(true), u, false), [false, "problems", false, "editor"], "status bar: visible ⇒ close");
    assert.deepEqual(p(S(true, "debug"), u, false), [true, "problems", false, "panel"]);
    assert.deepEqual(p(S(false), u, false), [true, "problems", false, "panel"], "status bar: opening focuses the problems");
    assert.deepEqual(p(S(false, "debug"), { kind: "show", tab: "terminal" }, false), [true, "terminal", false, null], "a tab click takes no focus");
    assert.deepEqual(p(S(true, "debug", true), { kind: "close" }, false), [false, "debug", true, "editor"], "closing keeps \"maximized\" (opensMaximized: preserve)");
    assert.deepEqual(p(S(false), { kind: "close" }, false), [false, "problems", false, null], "closing a closed panel does nothing");
    // VS Code panelActions.ts `toggleMaximizedPanel`: closed ⇒ open AND maximize.
    assert.deepEqual(p(S(false), { kind: "maximize" }, false), [true, "problems", true, "panel"], "maximize opens a closed panel maximized");
    assert.deepEqual(p(S(false, "problems", true), { kind: "maximize" }, false), [true, "problems", true, "panel"], "a remembered \"maximized\" stays on opening");
    assert.deepEqual(p(S(true), { kind: "maximize" }, false), [true, "problems", true, null]);
    assert.deepEqual(p(S(true, "problems", true), { kind: "maximize" }, false), [true, "problems", false, null], "maximize toggles back");
    // VS Code `terminal.integrated.hideOnLastClosed`: when the last terminal ends, the panel closes if it showed the terminal.
    const w = { kind: "terminalWay" };
    assert.deepEqual(p(S(true, "terminal"), w, false), [false, "terminal", false, "editor"], "the terminal is gone: the panel closes");
    assert.deepEqual(p(S(true, "problems"), w, false), [true, "problems", false, null], "if it showed something else, it stays");
    assert.deepEqual(p(S(false, "terminal"), w, false), [false, "terminal", false, null]);
  },
  page(L) {
    const g = (s, a, l) => { const r = L.pagesStep(s, a, l); return [r.state.visible, r.state.mode, r.focus]; };
    const view = (visible, mode = "explorer") => ({ visible, mode });
    const toggle = { kind: "toggle" };
    // VS Code layout.ts `setSideBarHidden`: hiding ⇒ `focusPanelOrEditor`, showing without focus.
    assert.deepEqual(g(view(true), toggle, situation({ inPage: true })), [false, "explorer", "editor"], "Cmd+B hides, the focus goes to the editor");
    assert.deepEqual(g(view(true), toggle, situation()), [false, "explorer", "editor"], "Cmd+B with focus in the editor: it stays there (focusPanelOrEditor)");
    assert.deepEqual(g(view(true), toggle, situation({ inPanel: true, panelOpen: true })), [false, "explorer", "panel"], "Cmd+B with focus in the panel: it stays in the panel");
    assert.deepEqual(g(view(true), toggle, situation({ inPage: true, panelOpen: true, editorHidden: true })), [false, "explorer", "panel"], "Cmd+B with a maximized panel: into the panel (the editor is hidden)");
    assert.deepEqual(g(view(true), toggle, situation({ inPage: true, panelOpen: true })), [false, "explorer", "editor"]);
    assert.deepEqual(g(view(false, "search"), toggle, situation()), [true, "search", null], "Cmd+B shows, without focus");
    const e = { kind: "view", mode: "explorer" };
    assert.deepEqual(g(view(false, "search"), e, situation()), [true, "explorer", "page"], "Shift+Cmd+E shows the explorer");
    assert.deepEqual(g(view(true), e, situation()), [true, "explorer", "page"], "Shift+Cmd+E without focus: focus");
    assert.deepEqual(g(view(true), e, situation({ inPage: true })), [true, "explorer", "editor"], "Shift+Cmd+E with focus: back to the editor");
    const d = { kind: "view", mode: "debug" };
    assert.deepEqual(g(view(true), d, situation({ inPage: true })), [true, "debug", "page"], "Shift+Cmd+D shows \"Run and Debug\"");
    assert.deepEqual(g(view(true, "debug"), d, situation({ inPage: true })), [true, "debug", "editor"]);
    assert.deepEqual(g(view(true, "search"), { kind: "search" }, situation({ inPage: true })), [true, "search", "page"], "Shift+Cmd+F: always the search and its field");
    assert.deepEqual(g(view(false), { kind: "search" }, situation()), [true, "search", "page"]);
  },
  // VS Code searchView.ts `updateTextFromSelection`: no new seed with focus in the search, escaped in regex mode.
  seed(L) {
    assert.equal(L.searchSeed("foo bar"), "foo bar");
    assert.equal(L.searchSeed(""), null);
    assert.equal(L.searchSeed(null), null);
    assert.equal(L.searchSeed("a\nb"), null, "multi-line: no seed");
    assert.equal(L.searchSeed("a\r\nb"), null);
    assert.equal(L.searchSeed("foo", true), null, "the focus is already in the search: no new seed");
    assert.equal(L.seedForField("a.b(c)*[x]{1}|^$+?\\", true), "a\\.b\\(c\\)\\*\\[x\\]\\{1\\}\\|\\^\\$\\+\\?\\\\", "escaped in regex mode (strings.escapeRegExpCharacters)");
    assert.equal(L.seedForField("a.b", false), "a.b", "otherwise literal");
  },
  remembered(L) {
    assert.deepEqual(L.panelRemembered(null), { height: null, tab: null, maximized: false });
    assert.deepEqual(L.panelRemembered({ height: 250, tab: "terminal", maximized: true }), { height: 250, tab: "terminal", maximized: true });
    assert.deepEqual(L.panelRemembered({ height: -1, tab: "x", maximized: "true" }), { height: null, tab: null, maximized: false }, "broken values do not count");
    assert.deepEqual(L.panelRemembered({ height: "300" }), { height: null, tab: null, maximized: false });
  },
  keys(L) {
    const id = (e, mac) => L.layoutCommandToKey(e, mac)?.id ?? null;
    const mac = (code, key, mod) => id(press(code, key, mod), true);
    const pc = (code, key, mod) => id(press(code, key, mod), false);
    assert.equal(mac("KeyB", "b", { metaKey: true }), "workbench.action.toggleSidebarVisibility");
    assert.equal(mac("KeyB", "b", { ctrlKey: true }), null, "not Ctrl+B on the Mac");
    assert.equal(pc("KeyB", "b", { ctrlKey: true }), "workbench.action.toggleSidebarVisibility", "outside the Mac Ctrl+B");
    assert.equal(pc("KeyB", "b", { metaKey: true }), null);
    assert.equal(mac("KeyJ", "j", { metaKey: true }), "workbench.action.togglePanel");
    assert.equal(mac("KeyE", "E", { metaKey: true, shiftKey: true }), "workbench.view.explorer");
    assert.equal(mac("KeyF", "F", { metaKey: true, shiftKey: true }), "workbench.action.findInFiles");
    assert.equal(mac("KeyF", "f", { metaKey: true }), null, "Cmd+F stays the search in the editor");
    assert.equal(mac("KeyD", "D", { metaKey: true, shiftKey: true }), "workbench.view.debug");
    assert.equal(mac("KeyM", "M", { metaKey: true, shiftKey: true }), "workbench.actions.view.problems");
    assert.equal(pc("KeyM", "M", { ctrlKey: true, shiftKey: true }), "workbench.actions.view.problems");
    assert.equal(mac("Backquote", "`", { ctrlKey: true }), "workbench.action.terminal.toggleTerminal", "Ctrl+` on the Mac too");
    assert.equal(mac("Backquote", "Dead", { ctrlKey: true }), "workbench.action.terminal.toggleTerminal", "Ctrl+` via the key position (German keyboard)");
    assert.equal(pc("Backquote", "`", { ctrlKey: true }), "workbench.action.terminal.toggleTerminal");
    assert.equal(mac("Backquote", "`", { metaKey: true }), null, "Cmd+` belongs to macOS (window switching)");
    assert.equal(mac("Backquote", "Dead", { ctrlKey: true, shiftKey: true }), null, "Ctrl+Shift+` is a new terminal, not this one");
    assert.equal(mac("Backquote", "Dead", {}), null);
    const t = Object.fromEntries(L.LAYOUT_COMMANDS.map((b) => [b.id, b.shortcut ?? ""]));
    assert.deepEqual(t, {
      "workbench.action.toggleSidebarVisibility": "⌘B", "workbench.action.togglePanel": "⌘J", "workbench.view.explorer": "⇧⌘E",
      "workbench.action.findInFiles": "⇧⌘F", "workbench.view.debug": "⇧⌘D", "workbench.actions.view.problems": "⇧⌘M",
      "workbench.action.terminal.toggleTerminal": "⌃`", "workbench.action.toggleMaximizedPanel": "",
    }, "ids and shortcuts as in VS Code");
  },
};

test("(1) computations: sizes, optimal width, snapping, panel steps, side bar, seed, remembered values, keys", () => {
  for (const [k, check] of Object.entries(CHECKS)) {
    try { check(real); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
});

test("(1) counter-tests: every sabotage appears exactly once in the source and is caught by its check", () => {
  const stale = copies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}×)`);
  assert.deepEqual(stale, [], "sabotages whose spot does not appear exactly once in the source");
  const notCaught = [];
  for (const s of sabotaged) {
    let caught = false;
    try { CHECKS[s.catches](s.mod); } catch { caught = true; }
    if (!caught) notCaught.push(`${s.name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  console.log(`  [panel-layout] ${sabotaged.length} sabotages, each caught`);
});

// ── (2) The sources ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Only comments at the start of a line and JSX comments — a "/*" in the middle of a string stays.
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\*[\s\S]*?\*\//gm, "");
const Q = {
  connection: read("src", "components", "code", "panel", "code-layout.ts"),
  pane: read("src", "components", "CodePane.tsx"),
  host: read("src", "components", "code", "palette-host.ts"),
  search: read("src", "components", "code", "SearchView.tsx"),
  bar: read("src", "components", "code", "panel", "DragBar.tsx"),
  css: read("src", "app", "globals.css"),
  i18n: read("src", "lib", "i18n-de.ts"),
  panel: read("src", "components", "code", "panel", "LowerPanel.tsx"),
  view: read("src", "components", "code", "panel", "ProblemsView.tsx"),
  debug: read("src", "components", "DebugPanel.tsx"),
  header: read("src", "components", "code", "explorer", "ExplorerHeader.tsx"),
  layout: SOURCE,
};
/** The text between two marks (the first must be there). */
const between = (s, from, until) => { const i = s.indexOf(from); assert.ok(i >= 0, `mark missing: ${from.slice(0, 60)}`); const j = s.indexOf(until, i + from.length); return s.slice(i, j < 0 ? undefined : j); };
const SOURCE_CHECKS = {
  remember(q) {
    const a = withoutComments(q.connection);
    const rows = a.split("\n");
    const withoutTry = rows.map((z, i) => (z.includes("localStorage.") && !/\btry\b/.test(z) && !/\btry\s*\{\s*$/.test(rows[i - 1] ?? "") ? i + 1 : 0)).filter(Boolean);
    assert.deepEqual(withoutTry, [], "a localStorage access without try/catch (private window, full, blocked)");
    assert.ok(rows.filter((z) => z.includes("localStorage.")).length >= 2, "nothing is remembered");
    assert.ok(a.includes("write(PANEL_KEY, { height: h, tab: s.tab, maximized: s.maximized })") && !/write\(PANEL_KEY, \{[^}]*\bopen\b/.test(a), "\"open\" must not be remembered (a remembered TERMINAL started a shell on every load)");
    assert.ok(a.includes("if (remember) rememberPanel(stateRef.current, h);") && a.includes("if (remember) write(PAGE_KEY, { width: b });"), "remembering happens only on release");
    // Terminals are a LIST (lib/terminal-list.ts): only `endTerminal` ("End terminal" and the end of its shell) removes one.
    assert.equal(a.split('{ kind: "end"').length - 1, 1, "only \"End terminal\" and the end of the shell remove a terminal (closing ends no shell)");
    // What is remembered before the first paint, the refs immediately too — otherwise a step in the same pass overwrote it with the default.
    const read = between(a, "useLayoutEffect(() => {\n    const p = panelRemembered(read(PANEL_KEY));", "}, []);");
    assert.ok(read.includes("heightRef.current = p.height;") && read.includes("stateRef.current = fresh;"), "the remembered values do not set the refs (a step on mount overwrote height and \"maximized\")");
  },
  table(q) {
    const a = withoutComments(q.connection);
    assert.ok(a.includes("condition: (_situation, k) => Boolean(hostOf(k.view)),"), "the layout keys apply in every editor, also outside a layout");
    assert.ok(a.includes("if (command(b.id)) continue;"), "a second registration throws (id already taken)");
    assert.ok(a.includes("if (e.defaultPrevented) return true;"), "a key the editor has already handled would run twice");
    assert.ok(a.includes("if (!o.active || !o.pageFiles) return;") && a.includes("const h = (e: KeyboardEvent) => { if (inDocument(e.target)) key(e); };"), "without focus on the page: the keys are missing or run twice");
    assert.ok(a.includes("searchSeed(v.state.sliceDoc(sel.from, sel.to), situation.inPage && page.mode === \"search\")") && a.includes("if (field) { field.focus(); field.select(); return; }"), "Shift+Cmd+F does not take the selection, seeds even with focus in the search, or does not focus the search field");
    assert.ok(a.includes("const f = panelStep(lay.stateRef.current, a, inPanel);") && a.includes("const inPanel = Boolean(lay.panelRef.current?.contains(document.activeElement));"), "the steps do not know the focus");
    assert.ok(a.includes("(content?.querySelector<HTMLElement>(\"[data-panel-focus], textarea:not([data-terminal-inactive] textarea)\") ?? content)?.focus({ preventScroll: true });"),
      "the focus finds no target in the panel (an empty text, the debug console) or falls into a hidden terminal");
    assert.ok(a.includes("const terminalWay = useCallback((seq?: number) => { if (lay.endTerminal(seq)) panelStepFrom({ kind: \"terminalWay\" }); }, [lay, panelStepFrom]);"), "the end of the last terminal does not close the panel");
    const end = between(a, "const endTerminal = useCallback((seq?: number): boolean => {", "}, []);");
    assert.ok(end.includes("if (fresh === old) return false;") && end.includes("return !fresh.list.length;"), "the panel closes although a terminal is still running (or twice for the same end)");
    assert.ok(a.includes("export const keyForTheWorkbench = (e: KeyboardEvent): boolean => Boolean(layoutCommandToKey(e, isMac()) || paletteCommandToKey(e, isMac()));"), "the terminal does not let the workbench keys through");
  },
  // The side bar.
  page(q) {
    const a = withoutComments(q.connection);
    const opt = between(a, "export function optimalWidth(", "return optimalWidthFrom(");
    assert.ok(opt.includes("r.selectNodeContents(el);") && opt.includes("const b = r.getBoundingClientRect();") && opt.includes("querySelectorAll<HTMLElement>(\".cb-tree-name\")"), "the optimal width measures the stretched box of the name, not its text (+12 px per double-click)");
    const sb = between(a, "export function usePagesWidth(", "const back = ");
    const turn = between(sb, "const drag = (distance: number, finished: boolean) => {", "if (z.frame) cancelAnimationFrame(z.frame);");
    assert.ok(turn.includes("requestAnimationFrame(") && !turn.includes("lay.setWidth(") && !turn.includes("hide("), "while dragging, every movement goes into state (all of CodePane re-renders)");
    assert.ok(sb.includes("if (snap(z.wish, SIDEBAR_MIN) === \"off\") { if (el) el.style.width = `${width}px`; hide(); return; }"), "below half the minimum width the side bar does not snap off");
    assert.ok(sb.includes("useLayoutEffect(() => {\n    const el = root.current;"), "the width is measured only after the first paint");
  },
  pane(q) {
    const c = withoutComments(q.pane);
    // On a .md file "Markdown: Open Preview" is appended (`paletteAddition`), with a preview also "Markdown: Toggle Preview Lock" —
    // the layout commands stay exactly once.
    assert.ok(c.includes("addition: paletteAddition }") && c.includes("const paletteAddition = [\n    ...layConn.paletteCommands,\n") && c.split("layConn.paletteCommands").length - 1 === 1
      && !/commands: \{[^\n]*\bterminal: \[/.test(c), "the palette names the layout commands not at all or twice");
    assert.ok(c.includes("else if (layConn.key(e)) { if (stRef.current) e.stopPropagation(); }") && !c.includes("e.ctrlKey && e.key === \"`\""), "the keys are not attached at the root (or Ctrl+` has a second path)");
    assert.ok(c.includes("style={treeAsDrawer ? undefined : { width: pagesWidth.width }}"), "the width of the side bar is not the dragged one");
    assert.ok(c.includes("onDrag={pagesWidth.drag} onBack={pagesWidth.back}"), "the side bar has no drag bar with double-click");
    assert.ok(c.includes("label={t(\"Primary Side Bar width\")} value={pagesWidth.value}"), "the drag bar of the side bar has no name or value for assistive technology");
    assert.ok(c.includes("usePagesWidth(lay, rootRef, treeToggle)"), "the side bar does not snap off while dragging");
    assert.ok(c.includes(" seed={lay.seed} onSeedConsumed={lay.seedConsumed} />"), "the search does not get the seed or does not forget it");
    assert.ok(c.includes("ref={lay.pagesRef}") && c.includes("pageFiles: !isControlled"), "the focus does not find the side bar");
    for (const r of ["problems", "debug", "terminal"]) assert.ok(c.includes(`onClick={() => layConn.panelStep({ kind: "toggle", tab: "${r}" })}`), `the "${r}" entry of the status bar does not toggle as in VS Code`);
  },
  palette(q) {
    const w = withoutComments(q.host);
    assert.ok(w.includes("for (const z of b.addition ?? []) if (!withView || !command(z.id)) out.push(z);") && w.includes("commands: hostCommands(a.commands, Boolean(v))"), "a layout command would appear twice in the palette with a view");
    assert.ok(!w.includes("terminal?: Toggle") && !w.includes("b.terminal"), "the dead terminal switch of the palette is still there");
  },
  search(q) {
    const s = withoutComments(q.search);
    assert.ok(s.includes("setQuery(seedForField(seed.text, regex));") && s.includes("}, [seedSeq]);"), "the search does not take the seed, takes it unescaped, or on every render");
    assert.ok(s.includes("    onSeedConsumed?.();\n"), "the search does not report the seed as consumed (it would be back after the next mount)");
  },
  bar(q) {
    const l = q.bar;
    assert.ok(l.includes("onDoubleClick={(e) => { e.preventDefault(); onBack(); }}") && l.includes("e.currentTarget.setPointerCapture(e.pointerId);"), "the drag bar does not reset or loses the pointer");
    assert.ok(l.includes("onDrag(e ? at(e) - z.at : z.distance, true);"), "releasing does not report \"finished\" (nothing would be remembered)");
    assert.ok(l.includes("onPointerCancel={(e) => end(e.currentTarget, null)}") && l.includes("onLostPointerCapture={(e) => end(e.currentTarget, null)}"), "a canceled drag gets stuck (pointercancel, lostpointercapture)");
    assert.ok(l.includes("aria-label={label}") && l.includes("aria-valuenow={value ? Math.round(value.now) : undefined}"), "the drag bar does not tell assistive technology what it drags");
    assert.ok(q.css.includes(".cb-sash:hover { background-color: var(--color-accent); transition-delay: 0.3s; }") && q.css.includes(".cb-sash[data-dragging] {"), "the drag bar does not look like VS Code (focus color after 300 ms)");
  },
  texts(q) {
    const key = new Set();
    for (const m of q.i18n.matchAll(/^\s*(["'])((?:\\.|(?!\1).)*)\1\s*:/gm)) key.add(m[2].replace(/\\(.)/g, "$1"));
    const missing = [];
    for (const b of q.layout.matchAll(/title: "([^"]+)"/g)) if (!key.has(b[1])) missing.push(b[1]);
    for (const source of [q.panel, q.view, q.debug, q.header]) for (const m of source.matchAll(/\bt\("((?:\\.|[^"\\])*)"/g)) if (!key.has(m[1].replace(/\\(.)/g, "$1"))) missing.push(m[1]);
    assert.deepEqual([...new Set(missing)], [], "wordings without an English entry in lib/i18n-de.ts");
  },
};
const SOURCE_SABOTAGES = {
  "remembering without try": { file: "connection", old: "try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not remembered — the size applies until reload */ }", fresh: "localStorage.setItem(key, JSON.stringify(value));", catches: "remember" },
  "open remembered": { file: "connection", old: "write(PANEL_KEY, { height: h, tab: s.tab, maximized: s.maximized })", fresh: "write(PANEL_KEY, { open: s.open, height: h, tab: s.tab, maximized: s.maximized })", catches: "remember" },
  "remembering on every drag step": { file: "connection", old: "if (remember) rememberPanel(stateRef.current, h);", fresh: "rememberPanel(stateRef.current, h);", catches: "remember" },
  "closing ends the shell": { file: "connection", old: "set(fresh === null ? { ...s, open: false } : { ...s, open: true, tab: fresh });", fresh: "if (fresh === null) terminal({ kind: \"end\" }); set(fresh === null ? { ...s, open: false } : { ...s, open: true, tab: fresh });", catches: "remember" },
  "remembered value without height ref": { file: "connection", old: "    heightRef.current = p.height;\n", fresh: "", catches: "remember" },
  "remembered value without state ref": { file: "connection", old: "    stateRef.current = fresh;\n", fresh: "", catches: "remember" },
  "remembered value after the paint": { file: "connection", old: "useLayoutEffect(() => {\n    const p = panelRemembered", fresh: "useEffect(() => {\n    const p = panelRemembered", catches: "remember" },
  "keys in every editor": { file: "connection", old: "condition: (_situation, k) => Boolean(hostOf(k.view)),", fresh: "", catches: "table" },
  "key runs twice": { file: "connection", old: "if (e.defaultPrevented) return true;", fresh: "", catches: "table" },
  "document listener in every field": { file: "connection", old: "if (inDocument(e.target)) key(e);", fresh: "key(e);", catches: "table" },
  "Shift+Cmd+F without selection": { file: "connection", old: "searchSeed(v.state.sliceDoc(sel.from, sel.to), ", fresh: "searchSeed(null, ", catches: "table" },
  "Shift+Cmd+F seeds with focus in the search": { file: "connection", old: ", situation.inPage && page.mode === \"search\")", fresh: ")", catches: "table" },
  "panel step without focus": { file: "connection", old: "const f = panelStep(lay.stateRef.current, a, inPanel);", fresh: "const f = panelStep(lay.stateRef.current, a, false);", catches: "table" },
  "empty text not focused": { file: "connection", old: "content?.querySelector<HTMLElement>(\"[data-panel-focus], textarea:not(", fresh: "content?.querySelector<HTMLElement>(\"textarea:not(", catches: "table" },
  "focus into the hidden terminal": { file: "connection", old: "textarea:not([data-terminal-inactive] textarea)\") ?? content)", fresh: "textarea\") ?? content)", catches: "table" },
  "terminal end without closing": { file: "connection", old: "if (lay.endTerminal(seq)) panelStepFrom({ kind: \"terminalWay\" });", fresh: "lay.endTerminal(seq);", catches: "table" },
  "terminal end closes in every case": { file: "connection", old: "    return !fresh.list.length;\n", fresh: "    return true;\n", catches: "table" },
  "terminal without pass-through": { file: "connection", old: "Boolean(layoutCommandToKey(e, isMac()) || paletteCommandToKey(e, isMac()))", fresh: "false", catches: "table" },
  "width from the box": { file: "connection", old: "    r.selectNodeContents(el);\n    const b = r.getBoundingClientRect();", fresh: "    const b = el.getBoundingClientRect();", catches: "page" },
  "side bar per movement in state": { file: "connection", old: "    z.wish = z.start + distance;\n", fresh: "    z.wish = z.start + distance;\n    lay.setWidth(sidebarWidth(z.wish, slot), false);\n", catches: "page" },
  "side bar does not snap off": { file: "connection", old: "if (snap(z.wish, SIDEBAR_MIN) === \"off\") { if (el) el.style.width = `${width}px`; hide(); return; }", fresh: "", catches: "page" },
  "width measured after the paint": { file: "connection", old: "useLayoutEffect(() => {\n    const el = root.current;", fresh: "useEffect(() => {\n    const el = root.current;", catches: "page" },
  "old terminal switch in the palette": { file: "pane", old: "addition: paletteAddition }", fresh: "terminal: [bottom === \"terminal\", setTermOpen], addition: paletteAddition }", catches: "pane" },
  "palette without layout commands": { file: "pane", old: "const paletteAddition = [\n    ...layConn.paletteCommands,\n", fresh: "const paletteAddition = [\n", catches: "pane" },
  "keys not at the root": { file: "pane", old: "else if (layConn.key(e)) { if (stRef.current) e.stopPropagation(); }", fresh: "", catches: "pane" },
  "side bar fixed width": { file: "pane", old: "{ width: pagesWidth.width }", fresh: "{ width: 240 }", catches: "pane" },
  "drag bar without double-click": { file: "pane", old: " onBack={pagesWidth.back}", fresh: " onBack={() => {}}", catches: "pane" },
  "side drag bar without name": { file: "pane", old: "label={t(\"Primary Side Bar width\")}", fresh: "label=\"\"", catches: "pane" },
  "side bar never snaps off": { file: "pane", old: "usePagesWidth(lay, rootRef, treeToggle)", fresh: "usePagesWidth(lay, rootRef, () => {})", catches: "pane" },
  "search without seed": { file: "pane", old: " seed={lay.seed} ", fresh: " ", catches: "pane" },
  "seed stays": { file: "pane", old: " onSeedConsumed={lay.seedConsumed}", fresh: "", catches: "pane" },
  "terminal entry without focus": { file: "pane", old: "onClick={() => layConn.panelStep({ kind: \"toggle\", tab: \"terminal\" })}", fresh: "onClick={() => setBottom((b) => (b === \"terminal\" ? null : \"terminal\"))}", catches: "pane" },
  "debug entry without focus": { file: "pane", old: "onClick={() => layConn.panelStep({ kind: \"toggle\", tab: \"debug\" })}", fresh: "onClick={() => setBottom((b) => (b === \"debug\" ? null : \"debug\"))}", catches: "pane" },
  "palette twice": { file: "host", old: "if (!withView || !command(z.id)) out.push(z);", fresh: "out.push(z);", catches: "palette" },
  "dead terminal switch": { file: "host", old: "    addition?: readonly PaletteCommand[];", fresh: "    terminal?: Toggle;\n    addition?: readonly PaletteCommand[];", catches: "palette" },
  "search without adoption": { file: "search", old: "setQuery(seedForField(seed.text, regex));", fresh: "", catches: "search" },
  "seed unescaped": { file: "search", old: "seedForField(seed.text, regex)", fresh: "seed.text", catches: "search" },
  "seed not consumed": { file: "search", old: "    onSeedConsumed?.();\n", fresh: "", catches: "search" },
  "drag bar without reset": { file: "bar", old: "onDoubleClick={(e) => { e.preventDefault(); onBack(); }}", fresh: "onDoubleClick={(e) => { e.preventDefault(); }}", catches: "bar" },
  "release without finished": { file: "bar", old: "onDrag(e ? at(e) - z.at : z.distance, true);", fresh: "onDrag(e ? at(e) - z.at : z.distance, false);", catches: "bar" },
  "cancel gets stuck": { file: "bar", old: "      onPointerCancel={(e) => end(e.currentTarget, null)}\n", fresh: "", catches: "bar" },
  "lost capture gets stuck": { file: "bar", old: "      onLostPointerCapture={(e) => end(e.currentTarget, null)}\n", fresh: "", catches: "bar" },
  "drag bar without value": { file: "bar", old: "aria-valuenow={value ? Math.round(value.now) : undefined}", fresh: "", catches: "bar" },
  "text without translation": { file: "i18n", old: "  \"Hide Panel\": \"Bereich ausblenden\",\n", fresh: "", catches: "texts" },
  "command title without translation": { file: "i18n", old: "  \"View: Toggle Problems\": \"Ansicht: Probleme umschalten\",\n", fresh: "", catches: "texts" },
  "debug text without translation": { file: "i18n", old: "  \"Breakpoints\": \"Haltepunkte\",\n", fresh: "", catches: "texts" },
};

test("(2) sources: remembering, command table, side bar, CodePane, palette, search, DragBar, texts (including counter-tests)", () => {
  for (const [k, check] of Object.entries(SOURCE_CHECKS)) {
    try { check(Q); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
  const stale = Object.entries(SOURCE_SABOTAGES).filter(([, s]) => Q[s.file].split(s.old).length !== 2).map(([n]) => n);
  assert.deepEqual(stale, [], "sabotages whose spot does not appear exactly once in the source");
  const notCaught = [];
  for (const [name, s] of Object.entries(SOURCE_SABOTAGES)) {
    let caught = false;
    try { SOURCE_CHECKS[s.catches]({ ...Q, [s.file]: Q[s.file].replace(s.old, s.fresh) }); } catch { caught = true; }
    if (!caught) notCaught.push(`${name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "source sabotages that no check catches");
  console.log(`  [panel-layout] ${Object.keys(SOURCE_SABOTAGES).length} source sabotages, each caught`);
});
