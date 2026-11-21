// The menu row: ONE form for every row of a menu in the app. The highlight (as for the theme toggle) must not touch the edges of the
// sheet and is slightly rounded, with a minimal gap between the highlighted boxes — one generic UI element used everywhere. Three parts:
//
// (1) The kit (components/CbKit.tsx): `menuRow`/`menuRowDanger`/`menuRowGuided` carry `cb-menu-row`, `MenuEntry` draws its row with it
//     (red with `data-danger`, symbol in `menuSymbol`), `popClass` keeps 6 px inner padding all round, and the kit `Menu` puts the focus
//     on an entry only when opened by KEY — with the mouse onto the sheet (Chromium counts a script's focus after a mouse click as
//     `:focus-visible`, so the first entry would stand highlighted on opening).
// (2) The CSS (app/globals.css): switching off the focus ring is UNLAYERED (the global `:focus-visible` ring is itself — from a layer
//     nothing would beat it), rounding, 2 px gap, highlight and symbol colour are in `@layer components` (any utility on the element
//     beats them: a palette keeps its marked row under the pointer), the guided row of a palette is exempt from the highlight under
//     the pointer.
// (3) The pass over web/src: every element with the role of a menu row (`menuitem`, `menuitemradio`, `menuitemcheckbox`, `option`)
//     carries the kit row — a new, hand-built menu row is red. Exceptions are named in `EXCEPTIONS` (file, count, reason) and are red in
//     BOTH directions: a new deviation as well as an entry whose deviation has vanished.
//
// COUNTER-PROBES BUILT IN: every sabotage is a copy of the source with ONE changed spot; the assigned check must throw on it, and the
// spot must appear exactly once in the source (otherwise the sabotage itself is stale and the test red).
//
// Run:  node --test web/test/menu-row.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(webDir, rel), "utf8");
const kit = read("src/components/CbKit.tsx");
const css = read("src/app/globals.css");

// Named exceptions of the pass: file -> { count, reason }. The count is that of the elements WITHOUT a kit row in this file.
const EXCEPTIONS = {
  "src/components/TextSize.tsx": {
    count: 3,
    reason: "the text-size steps (A-, percent, A+) in the \"Appearance\" menu: three small buttons side by side in ONE row, no menu rows",
  },
  "src/components/code/CommandPalette.tsx": {
    count: 1,
    reason: "the row of VS Code's Quick Input: 22 px, separator as an edge with the name on the right, key caps and buttons — form and colours of VS Code (`.cb-qi-row` in globals.css), not those of a cbase menu",
  },
};

const ROW_CLASS = /\b(?:menuRow|menuRowDanger|menuRowGuided)\b|\bcb-menu-row\b/;
// `(?<!\[)`: an attribute selector in a string (`querySelector('[role="menuitem"]')`) is no element.
const ROLE = /(?<!\[)role=(?:"(?:menuitem(?:radio|checkbox)?|option)"|\{[^}\n]*"(?:menuitem(?:radio|checkbox)?|option)"[^}\n]*\})/g;

function bodyFrom(text, anchor, end) {
  const i = text.indexOf(anchor);
  if (i < 0) throw new Error(`anchor missing: ${anchor}`);
  const j = text.indexOf(end, i + anchor.length);
  if (j < 0) throw new Error(`end missing after: ${anchor}`);
  return text.slice(i, j);
}

// ── (1) The kit ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

function checkKit(q) {
  const form = /const MENU_ROW_FORM = "([^"]*)";/.exec(q);
  assert.ok(form, "MENU_ROW_FORM is not in the kit");
  assert.ok(form[1].split(/\s+/).includes("cb-menu-row"), "the menu row form does not carry the class cb-menu-row");
  assert.ok(q.includes("export const menuRow = `${MENU_ROW_FORM} transition-colors`;"), "menuRow is not built on the form");
  assert.ok(q.includes("export const menuRowDanger = `${menuRow} text-danger`;"), "menuRowDanger is not built on menuRow");
  assert.ok(q.includes("export const menuRowGuided = `${MENU_ROW_FORM} cb-menu-guided`;"), "the guided row does not carry cb-menu-guided");
  const surface = /export const popSurface = "([^"]*)";/.exec(q);
  assert.ok(surface, "popSurface is not in the kit");
  assert.ok(!/(^|\s)p[xy]?-/.test(surface[1]), "popSurface carries inner padding — it is the surface WITHOUT");
  assert.ok(q.includes("export const popClass = `${popSurface} p-1.5`;"), "the menu sheet (popClass) does not keep 6 px inner padding all round");

  const entry = bodyFrom(q, "export function MenuEntry(", "\n}\n");
  assert.ok(entry.includes("className={`${danger ? menuRowDanger : menuRow}"), "MenuEntry does not draw its row with the kit row");
  assert.ok(entry.includes('...(danger ? { "data-danger": "" } : {})'), "a red row does not carry data-danger (it would get a grey background)");
  assert.ok(entry.includes("{icon && <span aria-hidden className={`${menuSymbol}"), "an entry's symbol is not in menuSymbol");
  assert.ok(/export const MenuSeparator = \(\) => <div role="separator" className="[^"]*\bmx-1\b/.test(q), "the separator is not indented like the rows");

  const menu = bodyFrom(q, "export function Menu(", "export function MenuEntry(");
  assert.ok(menu.includes("perKey.current = e.detail === 0;"), "the menu does not remember whether it was opened by key");
  assert.ok(menu.includes("if (!perKey.current) { b?.focus({ preventScroll: true }); return; }"),
    "opened with the mouse the focus is not on the sheet — the first entry would be highlighted on opening");
  assert.ok(menu.includes("tabIndex={-1}"), "the sheet cannot hold the focus (tabIndex -1)");
  assert.ok(menu.includes("onKeyDown={menuKeys}"), "on the sheet ↑/↓ do not move into the entries");
}

// ── (2) The CSS ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Ranges of all @layer blocks (braces counted; comments and strings in globals.css contain no braces where that would disturb —
// otherwise the check below that the block contains the menu rules would fail).
function layers(text) {
  const areas = [];
  const re = /@layer\s+[\w-]+\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
    }
    if (depth !== 0) throw new Error("an @layer block does not close");
    areas.push({ from: m.index, until: i, text: text.slice(m.index, i) });
  }
  return areas;
}
const inLayer = (areas, pos) => areas.some((b) => pos >= b.from && pos < b.until);

// The rule (selector list + body) in which `pos` stands.
function ruleAt(text, pos) {
  const on = text.indexOf("{", pos);
  const to = text.indexOf("}", on);
  return text.slice(pos, to + 1);
}

function checkCss(q) {
  const areas = layers(q);
  // The reason for the unlayered part: the global ring itself stands outside every layer.
  const ring = q.indexOf(":focus-visible {\n  outline: 2px solid");
  assert.ok(ring >= 0, "the global focus ring is no longer in globals.css — then check whether the unlayered part is still needed");
  assert.ok(!inLayer(areas, ring), "the global focus ring is in a layer");

  const out = q.indexOf(".cb-menu-row:focus-visible,\n");
  assert.ok(out >= 0, "switching off the focus ring on the menu row is missing");
  assert.ok(ruleAt(q, out).includes("outline: none;"), "the menu row does not switch off the focus ring");
  assert.ok(!inLayer(areas, out), "switching off the ring is in a layer — it would not beat the unlayered ring");

  const block = areas.find((b) => b.text.startsWith("@layer components") && b.text.includes(".cb-menu-row"));
  assert.ok(block, "form and highlight of the menu row are not in @layer components");
  const b = block.text;
  assert.ok(/\.cb-menu-row \{\s*border-radius: 10px;/.test(b), "the row is not rounded by 10 px");
  assert.ok(/\.cb-menu-row \+ \.cb-menu-row \{\s*margin-top: 2px;/.test(b), "there is no 2 px gap between two rows");
  assert.ok(/\.cb-menu-row:focus-visible \{\s*background-color: var\(--color-hover\);/.test(b), "the surface is missing under the keyboard focus");
  assert.ok(/\.cb-menu-row:not\(:disabled, \[aria-disabled="true"\], \.cb-menu-guided\):hover \{\s*background-color: var\(--color-hover\);/.test(b),
    "the highlight under the pointer is missing or does not exempt the guided row of a palette");
  assert.ok(/\.cb-menu-row\[data-danger\]:not\([^)]*\):hover \{\s*background-color: color-mix\(in srgb, var\(--color-danger\)/.test(b),
    "a red row does not get a red background under the pointer");
  // Outside the layer no rule may set the row's surface — it would beat every utility (the marked row of a palette).
  let i = -1;
  while ((i = q.indexOf(".cb-menu-row", i + 1)) >= 0) {
    if (inLayer(areas, i)) continue;
    assert.ok(!/background/.test(ruleAt(q, i)), "an unlayered rule sets the surface of the menu row");
  }
}

// ── (3) The pass ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// The opening JSX tag around `pos`: backwards the next `<Name` with no identifier before it (`querySelector<HTMLElement>` is no tag),
// forwards to the `>` outside {…} and "…".
function openingTag(text, pos) {
  let start = pos;
  for (;;) {
    start = text.lastIndexOf("<", start - 1);
    if (start < 0) throw new Error("no opening tag before the role");
    if (/[A-Za-z]/.test(text[start + 1] ?? "") && !/[\w$.]/.test(text[start - 1] ?? "")) break;
  }
  let depth = 0;
  let inText = false;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (depth === 0 && c === '"') inText = !inText;
    else if (inText) continue;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return text.slice(start, i + 1);
  }
  throw new Error("the tag does not close");
}

// Does the tag carry the kit row? Directly in the tag or via ONE constant of the same file (`className={row}` with
// `const row = \`${menuRow} …\``, ArchiveEntry).
function carriesKitRow(tag, text) {
  if (ROW_CLASS.test(tag)) return true;
  const name = /className=\{(\w+)\}/.exec(tag)?.[1];
  if (!name) return false;
  const def = new RegExp(`const ${name} = ([^;\n]*)`).exec(text);
  return Boolean(def && ROW_CLASS.test(def[1]));
}

// Per file: the elements with the role of a menu row, of those the ones without the kit row.
function menuRowsIn(text) {
  const all = [];
  for (const m of text.matchAll(ROLE)) all.push(openingTag(text, m.index));
  return { all, without: all.filter((tag) => !carriesKitRow(tag, text)) };
}

function tsxFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsxFiles(p));
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function pass(files) {
  const error = [];
  let rows = 0;
  const withRows = new Set();
  for (const [rel, text] of files) {
    const { all, without } = menuRowsIn(text);
    rows += all.length;
    if (all.length) withRows.add(rel);
    const exception = EXCEPTIONS[rel];
    if (exception) {
      if (without.length !== exception.count) error.push(`${rel}: ${without.length} rows without kit row, ${exception.count} are named (${exception.reason})`);
    } else {
      for (const tag of without) error.push(`${rel}: ${tag.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
  for (const rel of Object.keys(EXCEPTIONS)) if (!files.has(rel)) error.push(`${rel}: named exception without a file`);
  return { error, rows, withRows };
}

const sources = new Map(tsxFiles(path.join(webDir, "src")).map((p) => [path.relative(webDir, p).split(path.sep).join("/"), fs.readFileSync(p, "utf8")]));

// ── Counter-probes ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

function sabotage(q, old, fresh) {
  const n = q.split(old).length - 1;
  assert.equal(n, 1, `the sabotage spot appears ${n} times in the source (stale?): ${old.slice(0, 80)}`);
  return q.replace(old, fresh);
}

test("kit: menu row, danger, guided row, sheet with inner padding, focus on an entry only by key", () => {
  checkKit(kit);
});

test("kit: every sabotage of the promises is caught", () => {
  const cases = [
    ['const MENU_ROW_FORM = "cb-menu-row ', 'const MENU_ROW_FORM = "'],
    ["export const popClass = `${popSurface} p-1.5`;", "export const popClass = `${popSurface} py-1`;"],
    ["className={`${danger ? menuRowDanger : menuRow}", "className={`block w-full px-3 py-1.5 ${danger ? \"\" : \"\"}"],
    ['{...(danger ? { "data-danger": "" } : {})}', ""],
    ["{icon && <span aria-hidden className={`${menuSymbol}", "{icon && <span aria-hidden className={`grid"],
    ["if (!perKey.current) { b?.focus({ preventScroll: true }); return; }", ""],
    ["perKey.current = e.detail === 0;", ""],
    ["          onKeyDown={menuKeys}\n", ""],
    ["export const menuRowGuided = `${MENU_ROW_FORM} cb-menu-guided`;", "export const menuRowGuided = menuRow;"],
  ];
  for (const [old, fresh] of cases) assert.throws(() => checkKit(sabotage(kit, old, fresh)), `not caught: ${old.slice(0, 60)}`);
});

test("CSS: ring switched off unlayered, form and highlight in @layer components, guided row exempt", () => {
  checkCss(css);
});

test("CSS: every sabotage of the layering and the form is caught", () => {
  const cases = [
    // everything unlayered (a marked palette row would lose its colour under the pointer)
    ["@layer components {\n  .cb-menu-row {", "@media all {\n  .cb-menu-row {"],
    // switching off the ring moved into the layer
    [".cb-menu-row:focus-visible,\n.cb-pop[role=\"menu\"]:focus-visible,\n.cb-pop[role=\"listbox\"]:focus-visible {\n  outline: none;\n}\n@layer components {\n",
      "@layer components {\n.cb-menu-row:focus-visible,\n.cb-pop[role=\"menu\"]:focus-visible,\n.cb-pop[role=\"listbox\"]:focus-visible {\n  outline: none;\n}\n"],
    ["  .cb-menu-row + .cb-menu-row {\n    margin-top: 2px;", "  .cb-menu-row + .cb-menu-row {\n    margin-top: 0;"],
    [", .cb-menu-guided):hover", "):hover"],
    ["  .cb-menu-row {\n    border-radius: 10px;", "  .cb-menu-row {\n    border-radius: 0;"],
    ["  .cb-menu-row:focus-visible {\n    background-color: var(--color-hover);", "  .cb-menu-row:focus-visible {\n    color: inherit;"],
  ];
  for (const [old, fresh] of cases) assert.throws(() => checkCss(sabotage(css, old, fresh)), `not caught: ${old.slice(0, 60)}`);
  // An unlayered surface after the layer (it would beat every utility).
  assert.throws(() => checkCss(`${css}\n.cb-menu-row:hover { background-color: red; }\n`), "an unlayered surface is not caught");
});

test("pass: every menu row in web/src carries the kit row (named exceptions in both directions)", (t) => {
  const { error, rows, withRows } = pass(sources);
  // Anchors that throw instead of reporting empty: the pass must see the known menus.
  for (const rel of ["src/components/CbKit.tsx", "src/components/ThemeToggle.tsx", "src/components/code/explorer/TreeMenu.tsx", "src/components/code/CommandPalette.tsx", "src/components/ArchiveEntry.tsx"]) {
    assert.ok(withRows.has(rel), `the pass sees no menu row in ${rel} — role pattern stale?`);
  }
  t.diagnostic(`${sources.size} .tsx files, ${rows} elements with a menu row role in ${withRows.size} files, ${Object.keys(EXCEPTIONS).length} named exception(s)`);
  for (const [rel, a] of Object.entries(EXCEPTIONS)) t.diagnostic(`exception ${rel} (${a.count}): ${a.reason}`);
  assert.deepEqual(error, [], "menu rows without the kit row (CbKit menuRow/MenuEntry)");
});

test("pass: a hand-built menu row, a vanished and an additional exception are caught", () => {
  const raw = (tag) => menuRowsIn(`const x = () => (\n  <div>\n    ${tag}x</button>\n  </div>\n);\n`).without.length;
  // hand-built, also with traps in the tag (comparison in an expression, ">" in a string, generic before)
  assert.equal(raw('<button role="menuitem" className="block w-full px-3 py-1.5 hover:bg-hover">'), 1);
  assert.equal(raw('<button role="option" aria-selected={i === j} onClick={() => i < 3 && f(el.querySelector<HTMLElement>("a"))} title="a > b" className="px-3">'), 1);
  assert.equal(raw('<button role={choice ? "menuitemradio" : "menuitem"} className="px-3">'), 1);
  // a constant without a kit row is a hand row, one with it is not
  assert.equal(menuRowsIn('const row = "px-3 py-1.5";\n<button role="menuitem" className={row}>x</button>').without.length, 1);
  assert.equal(menuRowsIn('const row = `${menuRow} text-fg`;\n<button role="menuitem" className={row}>x</button>').without.length, 0);
  // an attribute selector in a string is no element
  assert.equal(menuRowsIn(`const q = '[role="menuitem"]:not([disabled])';`).all.length, 0);
  // with the kit row: nothing
  assert.equal(raw('<button role="menuitem" onClick={() => i < 3 && f()} title="a > b" className={`${menuRow} text-dim`}>'), 0);
  assert.equal(raw('<button role="option" className={i === j ? menuRowGuided : menuRowGuided}>'), 0);

  const including = new Map(sources);
  including.set("src/components/Fresh.tsx", '<button role="menuitem" className="px-3 py-1.5">x</button>');
  assert.ok(pass(including).error.some((f) => f.startsWith("src/components/Fresh.tsx")), "a new file with a hand row is not caught");
  const withoutException = new Map(sources);
  const tg = withoutException.get("src/components/TextSize.tsx");
  assert.ok(tg, "TextSize.tsx is missing");
  withoutException.set("src/components/TextSize.tsx", tg.replace('role="menuitem"', 'role="menuitem" data-x={menuRow}'));
  assert.ok(pass(withoutException).error.some((f) => f.includes("3 are named")), "a shrunken exception is not caught");
  const deleted = new Map(sources);
  deleted.delete("src/components/TextSize.tsx");
  assert.ok(pass(deleted).error.some((f) => f.includes("named exception without a file")), "an exception without a file is not caught");
});
