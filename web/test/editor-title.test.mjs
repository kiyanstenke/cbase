// The title bar of an editor as in VS Code 1.143. Finding: in three groups of 320 px the pills "▶ Debug", "Blame" and "Saved/Save" took
// the room and only "T" was left of the tab title.
//
// (1) The computations (lib/editor-title.ts), EXECUTED: which icon buttons a file carries and in which order ("Run or Debug…" first, VS Code
//     `order: -1`); how many fit next to ONE tab (120 px, VS Code `.tab.sizing-fit`) — the rest moves from the back into "…"; what a file
//     carries in "…" (Save greyed without unsaved changes, Blame as a toggle with a check mark).
// (2) The sources: no text pill in the title bar any more (no "Blame", no "Saved", no capsule), Debug as codicon `run` with the title from the
//     language pack and the same effect (Node debug); Save (⌘S) and the Blame toggle in the "…" of the group and — in the chat — in a "…" of
//     its own; the bar measures its width and hands it to the buttons, CodePane computes the room for buttons AND menu from it; ONE "…"
//     button (EditorTitleSymbols.tsx `MoreButton`); the `run` glyph is the codicons' play.svg; English texts present, old ones gone.
//
// Each sabotage is a copy of the source with ONE changed spot (the spot occurs exactly once, otherwise the sabotage is stale); the assigned
// check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/editor-title.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");
const ts = createRequire(import.meta.url)(path.join(webDir, "node_modules", "typescript"));
const load = (source) => {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const m = { exports: {} };
  new Function("exports", "module", js)(m.exports, m);
  return m.exports;
};

// ── (1) The computations ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const LIB = read("src", "lib", "editor-title.ts");
const COMPUTATIONS = {
  order(K) {
    const all = { debug: true, preview: true, asPreview: true, change: true };
    assert.deepEqual(K.titleActions(all), ["debug.run", "markdown.showPreviewToSide", "markdown.reopenAsPreview", "git.openChange"], "\"Run or Debug…\" is not first (VS Code order -1) or the order is wrong");
    assert.deepEqual(K.titleActions({ debug: false, preview: false, asPreview: false, change: false }), [], "a file without capabilities carries buttons");
    assert.deepEqual(K.titleActions({ debug: true, preview: false, asPreview: false, change: true }), ["debug.run", "git.openChange"]);
    assert.deepEqual(K.titleActions({ debug: false, preview: true, asPreview: true, change: false }), ["markdown.showPreviewToSide", "markdown.reopenAsPreview"]);
  },
  slot(K) {
    const perButton = K.BUTTON_WIDTH + K.BUTTON_GAP;
    assert.equal(K.BUTTON_WIDTH, 22, "a title bar button is 22 px (VS Code)");
    assert.equal(K.TAB_MINIMUM, 120, "the tabs keep the width of one tab (VS Code `.tab.sizing-fit`: 120 px)");
    // The finding: three groups of 320 px, a TypeScript file with a change (Debug + open changes) — everything stays, the title stays.
    assert.equal(K.titleSlot(320, 2, 2), 2, "in a group of 320 px buttons move although there is room");
    assert.equal(K.titleSlot(320, 4, 2), 4);
    assert.equal(K.titleSlot(0, 3, 2), 3, "unmeasured (0): all buttons stay");
    assert.equal(K.titleSlot(500, 0, 2), 0);
    for (let b = 150; b <= 400; b += 1) {
      for (let n = 0; n <= 4; n += 1) {
        const p = K.titleSlot(b, n, 2);
        assert.ok(p >= 0 && p <= n, `slot ${p} outside 0…${n}`);
        const occupied = (p + 2) * perButton + K.ACTIONS_MARGIN;
        if (p > 0) assert.ok(b - occupied >= K.TAB_MINIMUM, `at ${b} px and ${p} buttons the tab keeps ${b - occupied} px — less than a tab`);
        if (p < n) assert.ok(b - occupied - perButton < K.TAB_MINIMUM, `at ${b} px a button moves that would still fit`);
      }
    }
    assert.equal(K.titleSlot(200, 4, 2), 0, "very narrow: all buttons of the file move into \"…\"");
  },
  share(K) {
    assert.deepEqual(K.splitActions(["a", "b", "c"], 1), { visible: ["a"], overflow: ["b", "c"] }, "the overflow does not come from the back (same order)");
    assert.deepEqual(K.splitActions(["a", "b"], 5), { visible: ["a", "b"], overflow: [] });
    assert.deepEqual(K.splitActions(["a", "b"], 0), { visible: [], overflow: ["a", "b"] });
    assert.deepEqual(K.splitActions(["a"], -1), { visible: [], overflow: ["a"] });
  },
  menu(K) {
    const ids = (x) => x.map((e) => e.id);
    assert.deepEqual(ids(K.fileMenu({ dirty: true, deleted: false, blameOn: false })), ["workbench.action.files.save", "git.blame.toggleEditorDecoration"], "Save or Blame is missing in \"…\"");
    assert.equal(K.fileMenu({ dirty: true, deleted: false, blameOn: false })[0].inactive, false, "unsaved changes cannot be saved");
    assert.equal(K.fileMenu({ dirty: false, deleted: false, blameOn: false })[0].inactive, true, "\"Save\" is not greyed without unsaved changes");
    assert.equal(K.fileMenu({ dirty: true, deleted: true, blameOn: false })[0].inactive, true, "a deleted file can be saved");
    assert.equal(K.fileMenu({ dirty: false, deleted: false, blameOn: true })[1].on, true, "the Blame toggle does not show its state");
    assert.equal(K.fileMenu({ dirty: false, deleted: false, blameOn: false })[1].on, false);
  },
};
const LIB_SABOTAGES = [
  ["Debug at the back", "order", "  if (l.debug) out.push(\"debug.run\"); // order -1: before all others\n", ""],
  ["Debug missing", "order", "out.push(\"debug.run\")", "void 0"],
  ["Changes before the preview", "order", "  if (l.preview) out.push(\"markdown.showPreviewToSide\");\n", "  if (l.change) out.push(\"git.openChange\");\n  if (l.preview) out.push(\"markdown.showPreviewToSide\");\n"],
  ["no tab stays free", "slot", "const free = width - TAB_MINIMUM - ACTIONS_MARGIN - fixed * perButton;", "const free = width - ACTIONS_MARGIN - fixed * perButton;"],
  ["split and \"…\" do not count", "slot", "const free = width - TAB_MINIMUM - ACTIONS_MARGIN - fixed * perButton;", "const free = width - TAB_MINIMUM - ACTIONS_MARGIN;"],
  ["unmeasured: everything gone", "slot", "if (!(width > 0) || count <= 0) return Math.max(0, count);", "if (count <= 0) return 0;"],
  ["tab not free as in VS Code", "slot", "export const TAB_MINIMUM = 120;", "export const TAB_MINIMUM = 20;"],
  ["overflow from the front", "share", "return { visible: actions.slice(0, n), overflow: actions.slice(n) };", "return { visible: actions.slice(actions.length - n), overflow: actions.slice(0, actions.length - n) };"],
  ["Save always active", "menu", "inactive: !d.dirty || d.deleted }", "inactive: false }"],
  ["deleted file saveable", "menu", "inactive: !d.dirty || d.deleted }", "inactive: !d.dirty }"],
  ["Blame without check", "menu", "on: d.blameOn }", "on: false }"],
  ["Blame missing in the menu", "menu", "    { id: \"git.blame.toggleEditorDecoration\", on: d.blameOn },\n", ""],
];

test("(1) computations: button order, room next to a tab, overflow from the back, Save/Blame in \"…\" (with counter-tests)", (tt) => {
  const K = load(LIB);
  for (const f of Object.values(COMPUTATIONS)) f(K);
  for (const [name, catches, old, fresh] of LIB_SABOTAGES) {
    assert.equal(LIB.split(old).length - 1, 1, `counter-test "${name}" is stale: the spot does not occur exactly once in lib/editor-title.ts`);
    assert.throws(() => COMPUTATIONS[catches](load(LIB.replace(old, fresh))), `counter-test "${name}" is not caught by "${catches}"`);
  }
  tt.diagnostic(`${LIB_SABOTAGES.length} sabotages on the computations, each caught`);
});

// ── (2) The sources ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const Q = {
  input: read("src", "components", "code", "InputParts.tsx"),
  pane: read("src", "components", "CodePane.tsx"),
  bar: read("src", "components", "code", "TabBar.tsx"),
  symbols: read("src", "components", "code", "EditorTitleSymbols.tsx"),
  groups: read("src", "components", "code", "EditorGroups.tsx"),
  i18n: read("src", "lib", "i18n-de.ts"),
};
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, `"${a.slice(0, 60)}" is missing`); const j = s.indexOf(b, i + a.length); return s.slice(i, j < 0 ? undefined : j); };
const SOURCE_CHECKS = {
  pills(q) {
    const one = withoutComments(q.input);
    const buttons = between(one, "export function EditorTitleButtons(", "\n}\n");
    // No text pills: no "Blame"/"Debug" as text, no "Saved", no capsule, no text buttons — only TitleButton and "…".
    assert.ok(!/>\s*(Blame|Debug)\s*</.test(buttons) && !one.includes("t(\"Saved\")") && !one.includes("pillSm") && !buttons.includes("rounded-full") && !buttons.includes("<button"),
      "the title bar has a text pill again (Debug, Blame, Saved/Save)");
    assert.ok(buttons.includes("{K.splitActions(all, n).visible.map((a) => <TitleButton key={a.id} name={a.symbol} title={a.title} data={a.data} onClick={(ev) => a.execute(ev.altKey)} />)}"),
      "the buttons of the file are not the visible icon buttons from lib/editor-title.ts");
    assert.ok(buttons.includes("{more && <MoreButton t={t} menu={() => titleMenuItems(t, file, n)} />}"), "in the chat the \"…\" with Save and Blame is missing");
  },
  debug(q) {
    const one = withoutComments(q.input);
    assert.ok(one.includes("case \"debug.run\": return { id, symbol: \"run\", title: t(\"Run or Debug…\"), data: { \"data-title-debug\": \"\" }, execute: () => d.onDebug() };"),
      "\"Run or Debug…\" is not the icon button with the codicon run (or does not start the Node debug)");
    assert.ok(withoutComments(q.pane).includes("onBlame: () => setBlameOn((v) => !v), onSave: () => saveFile(p), onDebug: () => void startDebug(p),")
      && withoutComments(q.pane).includes("debug: lspLanguageOf(p)?.language === \"ts\", blameOn,"), "Debug, Save or Blame lost their effect");
    // The glyph: play.svg of the codicons (Codicon.run is the same code point).
    assert.ok(q.symbols.includes("  run: \"M4.74514 3.06414C4.41183 2.87665 4 3.11751 4 3.49993V12.5002C4 12.8826 4.41182 13.1235 4.74512 12.936L12.7454 8.43601C13.0852 8.24486"), "the \"run\" glyph is not play.svg of the codicons");
  },
  menu(q) {
    const one = withoutComments(q.input);
    const m = between(one, "export function fileMenuPoints(", "\n}\n");
    assert.ok(m.includes("{ id: e.id, label: t(\"Save\"), right: \"⌘S\", disabled: e.inactive, execute: d.onSave }"), "\"Save\" (⌘S) is missing in \"…\" or never greyed");
    assert.ok(m.includes("{ id: e.id, label: t(\"Toggle Git Blame Editor Decoration\"), on: e.on, execute: d.onBlame }"), "the Blame toggle is missing in \"…\" or shows no check mark");
    assert.ok(one.includes("return [...overflowPoints(K.splitActions(fileActions(t, d), slot).overflow), ...fileMenuPoints(t, d)];"), "\"…\" does not carry the overflow before the entries of the file");
    assert.ok(one.includes("actions.map((a) => ({ id: a.id, label: a.title, execute: () => a.execute(false) }))"), "a moved button has no effect in the menu");
    const p = withoutComments(q.pane);
    assert.ok(p.includes("return [...titleMenuItems(t, fileTitleFor(front, gid), slot), ...groupMenuItems(t, {"), "the \"…\" of the group does not carry Save, Blame or the overflow");
    assert.ok(p.includes("return d ? <EditorTitleButtons t={t} kind=\"file\" file={d} slot={slot} more={!gid} /> : null;"), "in the chat (without a group) its own \"…\" is missing — or the group carries two");
    // ONE "…" button for group and chat.
    assert.ok(withoutComments(q.groups).includes("<MoreButton t={t} menu={menu} data={{ \"data-group-more\": \"\" }} />")
      && withoutComments(q.symbols).includes("openEditorMenu({ x: r.left, y: r.bottom + 2, groups: menu() })"), "\"…\" is not ONE button with the ONE editor menu");
  },
  slot(q) {
    const p = withoutComments(q.pane), l = withoutComments(q.bar);
    assert.ok(p.includes("right={(width) => { const slot = slotIn(g, width); return <>{buttonsFor(g.active, g.id, slot)}<GroupsButtons t={t} onShare={(below) => partsGroup(g.id, below ? \"bottom\" : \"right\")} menu={() => groupsMenu(g.id, slot)} /></>; }}"),
      "buttons and \"…\" of the group do not compute with the same room");
    assert.ok(p.includes("return titleSlot(width, d ? fileActions(t, d).length : 0, 2); };"), "the room does not count split and \"…\" or the buttons of the file");
    assert.ok(l.includes("const buttons = typeof right === \"function\" ? right(width) : right;") && l.includes("{buttons && <div className=\"relative z-10 flex shrink-0 items-center gap-0.5 bg-bg px-1.5\" data-tab-bar-actions>{buttons}</div>}"),
      "the bar does not hand its width to the buttons");
    assert.ok(l.includes("const miss = () => setWidth(Math.round(el.getBoundingClientRect().width));") && l.includes("ro.observe(el);") && l.includes("      ref={wrapper}\n"),
      "the bar does not measure its whole width (or does not re-measure)");
    // The tabs scroll (VS Code), the bar does not shrink the actions.
    assert.ok(l.includes("className=\"cb-tabs-scroll flex min-w-0 flex-1 items-stretch overflow-x-auto\""), "the tabs no longer scroll horizontally");
  },
  texts(q) {
    for (const k of ["Run or Debug…", "Toggle Git Blame Editor Decoration", "Save", "More Actions…"]) {
      assert.equal(q.i18n.split(`\n  ${JSON.stringify(k)}: `).length - 1, 1, `"${k}" does not have exactly one English text`);
    }
    for (const k of ["Git-Blame (Autor je Zeile) ein-/ausblenden", "Speichern (⌘S)"]) assert.ok(!q.i18n.includes(`: ${JSON.stringify(k)},\n`), `the old text "${k}" is still in i18n-de.ts`);
  },
};
const SOURCE_SABOTAGES = [
  ["Blame pill back", "pills", "input", "  if (!file) return null;\n  const all", "  if (!file) return <button className=\"rounded-full\">Blame</button>;\n  const all"],
  ["Save pill back", "pills", "input", "      {more && <MoreButton", "      <span>{t(\"Saved\")}</span>\n      {more && <MoreButton"],
  ["all buttons despite overflow", "pills", "input", "{K.splitActions(all, n).visible.map(", "{all.map("],
  ["chat without \"…\"", "pills", "input", "{more && <MoreButton t={t} menu={() => titleMenuItems(t, file, n)} />}", ""],
  ["Debug as arrow pill", "debug", "input", "symbol: \"run\", title: t(\"Run or Debug…\")", "symbol: \"open-preview\", title: t(\"Debug\")"],
  ["Debug without effect", "debug", "input", "execute: () => d.onDebug() };", "execute: () => undefined };"],
  ["Save without effect", "debug", "pane", "onSave: () => saveFile(p),", "onSave: () => undefined,"],
  ["wrong glyph", "debug", "symbols", "  run: \"M4.74514 3.06414C4.41183", "  run: \"M4 3.06414C4.41183"],
  ["Save never greyed", "menu", "input", "disabled: e.inactive, execute: d.onSave }", "execute: d.onSave }"],
  ["Blame without check", "menu", "input", "on: e.on, execute: d.onBlame }", "execute: d.onBlame }"],
  ["overflow missing in the menu", "menu", "input", "return [...overflowPoints(K.splitActions(fileActions(t, d), slot).overflow), ...fileMenuPoints(t, d)];", "return [...fileMenuPoints(t, d)];"],
  ["moved button dead", "menu", "input", "execute: () => a.execute(false) }))", "execute: () => undefined }))"],
  ["group without file entries", "menu", "pane", "return [...titleMenuItems(t, fileTitleFor(front, gid), slot), ...groupMenuItems(t, {", "return [...groupMenuItems(t, {"],
  ["two \"…\" in the group", "menu", "pane", "slot={slot} more={!gid} />", "slot={slot} more />"],
  ["own \"…\" button of the group", "menu", "groups", "<MoreButton t={t} menu={menu} data={{ \"data-group-more\": \"\" }} />", "<button data-group-more />"],
  ["menu of the group without room", "slot", "pane", "menu={() => groupsMenu(g.id, slot)} />", "menu={() => groupsMenu(g.id, 99)} />"],
  ["buttons without room", "slot", "pane", "<>{buttonsFor(g.active, g.id, slot)}<GroupsButtons", "<>{buttonsFor(g.active, g.id)}<GroupsButtons"],
  ["split and \"…\" not counted", "slot", "pane", "fileActions(t, d).length : 0, 2); };", "fileActions(t, d).length : 0, 0); };"],
  ["width never handed", "slot", "bar", "const buttons = typeof right === \"function\" ? right(width) : right;", "const buttons = typeof right === \"function\" ? right(0) : right;"],
  ["does not re-measure", "slot", "bar", "    ro.observe(el);\n", "\n"],
  ["tabs do not scroll", "slot", "bar", "className=\"cb-tabs-scroll flex min-w-0 flex-1 items-stretch overflow-x-auto\"", "className=\"cb-tabs-scroll flex min-w-0 flex-1 items-stretch overflow-hidden\""],
  ["Debug text without English", "texts", "i18n", "\n  \"Run or Debug…\": ", "\n  \"Run or Debug (gone)\": "],
  ["Blame text without English", "texts", "i18n", "\n  \"Toggle Git Blame Editor Decoration\": ", "\n  \"Git Blame Editor Decoration (gone)\": "],
  ["old Blame text stays", "texts", "i18n", "\n  \"Toggle Git Blame Editor Decoration\": ", "\n  \"x\": \"Git-Blame (Autor je Zeile) ein-/ausblenden\",\n  \"Toggle Git Blame Editor Decoration\": "],
];

test("(2) sources: no pills, Debug as codicon run, Save/Blame in \"…\", room from the bar width, texts (with counter-tests)", (tt) => {
  for (const f of Object.values(SOURCE_CHECKS)) f(Q);
  for (const [name, catches, k, old, fresh] of SOURCE_SABOTAGES) {
    assert.equal(Q[k].split(old).length - 1, 1, `counter-test "${name}" is stale: the spot does not occur exactly once in ${k}`);
    assert.throws(() => SOURCE_CHECKS[catches]({ ...Q, [k]: Q[k].replace(old, fresh) }), `counter-test "${name}" is not caught by "${catches}"`);
  }
  tt.diagnostic(`${SOURCE_SABOTAGES.length} sabotages on the sources, each caught`);
});
