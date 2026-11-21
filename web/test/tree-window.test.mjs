// The explorer, smooth as in VS Code. The measured cause: the tree drew EVERY visible row (6,000 rows = about 60,000 nodes) and every
// scroll event set a state that recomputed the whole tree. The promises and who keeps them:
//
//   (1) The computation lib/tree-window.ts, EXECUTED: the window is the visible area plus a buffer, scrolling within the area returns
//       the SAME object, the always-drawn rows (focus, field, drag source) stay in, "show" scrolls close to the edge and far away
//       to the middle, `aria-setsize`/`aria-posinset` count the siblings in the same folder (VS Code `AbstractTree`).
//   (2) The window components/code/explorer/TreeWindow.tsx, RENDERED with the real React (react-dom/client) in a stub DOM (the suite
//       has no jsdom): at N = 5,000 only the visible rows (plus buffer) are present; a scroll event within the area draws
//       NOTHING, one across row boundaries draws only the rows that run in; one pass through all 5,000 rows draws each row at most
//       once (not all visible ones every time).
//   (3) The sources: the tree draws via TreeWindow (no `rows.map` any more), sets no state on scrolling except the sticky change,
//       passes aria-setsize/-posinset and `top` to the row, keeps focus/field/drag drawn, scrolls "show" from the index.
//
// Every sabotage changes exactly ONE spot (it must occur exactly once in the source) and must be caught.
//
// Run:  node --test --test-reporter=tap web/test/tree-window.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");
const LIB = read("src", "lib", "tree-window.ts");
const WINDOW = read("src", "components", "code", "explorer", "TreeWindow.tsx");
const TREE = read("src", "components", "code", "explorer", "ExplorerTree.tsx");
const ROW = read("src", "components", "code", "explorer", "TreeRow.tsx");
const CSS = read("src", "app", "globals.css");

// ── Compile (no type check, only transpile): react, react-dom via absolute paths so that nothing is written under node_modules ──
const require = createRequire(path.join(webDir, "package.json"));
process.env.NODE_ENV = "production"; // before the first load of react: the lean build
const ts = require("typescript");
const absolute = { "react": require.resolve("react"), "react/jsx-runtime": require.resolve("react/jsx-runtime"), "react-dom": require.resolve("react-dom") };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-tree-window-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let seq = 0;
function translate(lib, window) {
  const dir = path.join(tmp, `v${seq++}`);
  fs.mkdirSync(dir);
  const js = (src) => ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/from "(react|react\/jsx-runtime|react-dom)"/g, (_, m) => `from ${JSON.stringify(pathToFileURL(absolute[m]).href)}`)
    .replace(/from "@\/lib\/tree-window"/g, `from "./tree-window.mjs"`);
  fs.writeFileSync(path.join(dir, "tree-window.mjs"), js(lib));
  fs.writeFileSync(path.join(dir, "TreeWindow.mjs"), js(window));
  return dir;
}

// ── A stub DOM: exactly as much as react-dom/client needs for divs with attributes, style and text ──
class Node {
  constructor(doc, nodeType, nodeName) {
    this.ownerDocument = doc; this.nodeType = nodeType; this.nodeName = nodeName; this.tagName = nodeName; this.namespaceURI = null;
    this.childNodes = []; this.parentNode = null; this.attrs = new Map(); this.style = {}; this.listeners = new Map(); this.scrollTop = 0;
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null; }
  appendChild(k) { k.parentNode?.removeChild(k); this.childNodes.push(k); k.parentNode = this; return k; }
  insertBefore(k, before) { if (!before) return this.appendChild(k); k.parentNode?.removeChild(k); this.childNodes.splice(this.childNodes.indexOf(before), 0, k); k.parentNode = this; return k; }
  removeChild(k) { const i = this.childNodes.indexOf(k); if (i >= 0) this.childNodes.splice(i, 1); k.parentNode = null; return k; }
  setAttribute(n, v) { this.attrs.set(n, String(v)); }
  getAttribute(n) { return this.attrs.get(n) ?? null; }
  removeAttribute(n) { this.attrs.delete(n); }
  hasAttribute(n) { return this.attrs.has(n); }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map((k) => k.textContent).join(""); }
  set textContent(t) { if (this.nodeType === 3) { this.nodeValue = t; return; } for (const k of this.childNodes) k.parentNode = null; this.childNodes = []; if (t) this.appendChild(this.ownerDocument.createTextNode(t)); }
  addEventListener(kind, f) { if (!this.listeners.has(kind)) this.listeners.set(kind, new Set()); this.listeners.get(kind).add(f); }
  removeEventListener(kind, f) { this.listeners.get(kind)?.delete(f); }
  fire(kind) { for (const f of [...(this.listeners.get(kind) ?? [])]) f({ type: kind, target: this }); }
  contains(k) { for (let x = k; x; x = x.parentNode) if (x === this) return true; return false; }
  all(test) { const out = []; const go = (k) => { if (k.nodeType === 1 && test(k)) out.push(k); k.childNodes.forEach(go); }; go(this); return out; }
}
class Document extends Node {
  constructor() { super(null, 9, "#document"); this.ownerDocument = null; this.documentElement = new Node(this, 1, "HTML"); this.body = new Node(this, 1, "BODY"); this.documentElement.appendChild(this.body); this.activeElement = this.body; }
  createElement(t) { return new Node(this, 1, String(t).toUpperCase()); }
  createElementNS(_ns, t) { return this.createElement(t); }
  createTextNode(t) { const k = new Node(this, 3, "#text"); k.nodeValue = String(t); return k; }
}
const doc = new Document();
globalThis.window ??= globalThis;
globalThis.document = doc;
globalThis.HTMLIFrameElement ??= class HTMLIFrameElement {};
globalThis.navigator ??= { userAgent: "node" };
const React = await import(pathToFileURL(absolute.react).href);
const { createRoot } = await import(pathToFileURL(require.resolve("react-dom/client")).href);
const { flushSync } = await import(pathToFileURL(absolute["react-dom"]).href);
const h = React.createElement;

/** Renders TreeWindow (version `dir`) with N rows; counts the calls of `draw` and the render runs of the (memo) rows. */
async function status(dir, { count = 5000, zh = 22, view = 600, always = [] } = {}) {
  const { TreeWindow } = await import(pathToFileURL(path.join(dir, "TreeWindow.mjs")).href);
  const counter = { draw: 0, rows: 0, scrollNotices: 0 };
  const Row = React.memo(function Row({ i, top }) { counter.rows++; return h("div", { role: "treeitem", "data-i": String(i), style: { top } }); });
  const surface = doc.createElement("div");
  doc.body.appendChild(surface);
  const ref = { current: surface };
  const container = doc.createElement("div");
  surface.appendChild(container);
  const root = createRoot(container);
  const draw = (i, top) => { counter.draw++; return h(Row, { key: i, i, top }); };
  const props = { surface: ref, count, h: zh, view, always, draw, onScroll: () => { counter.scrollNotices++; } };
  // A synchronous render (flushSync) flushes its passive effects, the scroll listener, in the same call (React >= 18:
  // effects of a SyncLane commit run synchronously). No pause on the clock; `scrollNotices`/`height` prove that it is attached.
  flushSync(() => root.render(h(TreeWindow, props)));
  const rows = () => container.all((k) => k.getAttribute("role") === "treeitem").map((k) => Number(k.getAttribute("data-i")));
  const role = (top) => { surface.scrollTop = top; surface.fire("scroll"); };
  const height = () => container.firstChild?.style.height;
  return { counter, rows, role, height, end: () => { flushSync(() => root.unmount()); doc.body.removeChild(surface); } };
}

const SABOTAGES = [
  // computation
  { name: "all rows drawn", lib: ["until: Math.min(count, afterLast + buffer)", "until: count"], catches: ["window", "rendered"] },
  { name: "buffer without cap", lib: ["export const BUFFER = 8;", "export const BUFFER = 5000;"], catches: ["window", "rendered"] },
  { name: "window from row 0", lib: ["from: Math.max(0, first - buffer)", "from: 0"], catches: ["window", "rendered"] },
  { name: "always a new object", lib: ["old.from === fresh.from && old.until === fresh.until ? old : fresh", "fresh"], catches: ["window", "roles"] },
  { name: "focus drops out of the window", lib: ["if (!extra.length) return out;", "return out;"], catches: ["window", "rendered"] },
  { name: "show always to the edge", lib: ["return Math.max(0, top - (view - h) / 2);", "return top;"], catches: ["show"] },
  { name: "show always centered", lib: ["if (near) return top < scrollTop ? top : bottom - view;", ""], catches: ["show"] },
  { name: "posinset = index", lib: ["position[i] = k;", "position[i] = i + 1;"], catches: ["aria"] },
  { name: "setsize = all rows", lib: ["size[i] = count.get(rows[i].parent) ?? 1;", "size[i] = n;"], catches: ["aria"] },
  // drawing
  { name: "every scroll event draws", window: ["if (different) newDraw();", "newDraw();"], catches: ["roles"] },
  { name: "window does not scroll along", window: ["if (different) newDraw();", ""], catches: ["roles"] },
  { name: "no full height", window: ["style={{ height: count * h }}", "style={{}}"], catches: ["rendered"] },
  { name: "sticky does not listen", window: ["report.current?.(top.current);\n      });", "});"], catches: ["roles"] },
];

// ── (1) the computation ──
async function checkComputation(dir) {
  const L = await import(pathToFileURL(path.join(dir, "tree-window.mjs")).href);
  const error = new Set();
  const desired = (kind, ok) => { if (!ok) error.add(kind); };
  // window: view 600 px / 22 px = 27.3 rows; 8 buffer above, 8 below.
  const a = L.treeWindow(5000, 0, 22, 600);
  desired("window", a.from === 0 && a.until === 28 + 8);
  const b = L.treeWindow(5000, 22 * 1000 + 5, 22, 600);
  desired("window", b.from === 1000 - 8 && b.until === 1028 + 8 && b.until - b.from <= Math.ceil(600 / 22) + 1 + 2 * 8);
  const c = L.treeWindow(5000, 22 * 4990, 22, 600);
  desired("window", c.until === 5000 && c.from === 4990 - 8);
  desired("window", L.treeWindow(0, 0, 22, 600).until === 0);
  // same window => the same object; a different one => the new one
  desired("window", L.nextWindow(b, L.treeWindow(5000, 22 * 1000 + 15, 22, 600)) === b);
  desired("window", L.nextWindow(b, L.treeWindow(5000, 22 * 1001, 22, 600)) !== b);
  // always drawn: the focus far below stays in, sorted, without duplicates
  const g = L.drawn({ from: 10, until: 14 }, [4000, 12, 2], 5000);
  desired("window", JSON.stringify(g) === JSON.stringify([2, 10, 11, 12, 13, 4000]));
  // show: visible => null; one row below => to the bottom edge; far away => centered
  desired("show", L.scrollTarget(10, 22, 0, 600) === null);
  desired("show", L.scrollTarget(28, 22, 0, 600) === 29 * 22 - 600);
  desired("show", L.scrollTarget(8, 22, 220, 600) === 176); // two rows above the view: to the top edge
  desired("show", L.scrollTarget(1000, 22, 0, 600) === 22000 - (600 - 22) / 2);
  // aria: siblings per folder (root: a, b, c; in a: x, y)
  const s = L.ariaSet([{ parent: "" }, { parent: "a" }, { parent: "a" }, { parent: "" }, { parent: "" }]);
  desired("aria", JSON.stringify([...s.size]) === "[3,2,2,3,3]" && JSON.stringify([...s.position]) === "[1,1,2,2,3]");
  return error;
}

// ── (2) rendered ──
async function checkRendered(dir) {
  const error = new Set();
  const desired = (kind, ok) => { if (!ok) error.add(kind); };
  const N = 5000, visible = Math.ceil(600 / 22) + 1, cap = visible + 2 * 8;
  let s = await status(dir, { count: N, always: [4321] });
  try {
    const z = s.rows();
    desired("rendered", z.length <= cap + 1 && z.length >= visible);
    desired("rendered", z.includes(4321)); // the focus stays, even far below
    desired("rendered", z.includes(0) && !z.includes(200));
    desired("rendered", s.height() === `${N * 22}px`);
    desired("rendered", s.counter.rows === z.length);
  } finally { s.end(); }
  s = await status(dir, { count: N });
  try {
    // within the row: NOTHING draws (neither the window nor a row), sticky still listens
    const prior = { ...s.counter };
    s.role(2); s.role(5); s.role(8); // 608 / 22 < 28: the last clipped row stays the same
    desired("roles", s.counter.draw === prior.draw && s.counter.rows === prior.rows);
    desired("roles", s.counter.scrollNotices === prior.scrollNotices + 3);
    // across row boundaries: only the rows running in render
    const z0 = s.counter.rows;
    s.role(22 * 3);
    desired("roles", s.counter.rows - z0 === 3 && s.rows().includes(38) && !s.rows().includes(39));
    // once through all 5,000 rows in steps of 7 px: each row rendered at most once (not all visible ones per event)
    const z1 = s.counter.rows;
    for (let top = 22 * 3; top <= N * 22 - 600; top += 7) s.role(top);
    desired("roles", s.counter.rows - z1 <= N && s.rows().includes(N - 1));
    desired("rendered", s.rows().length <= cap + 1 && !s.rows().includes(0)); // at the bottom only the lower rows are present
  } finally { s.end(); }
  return error;
}

const real = translate(LIB, WINDOW);

test("(1) the computation: window, same object, always drawn, show, aria", async () => {
  assert.deepEqual([...(await checkComputation(real))], []);
});

test("(2) rendered with react-dom: at N = 5,000 only the visible rows are present; one scroll event does not redraw every row", async () => {
  assert.deepEqual([...(await checkRendered(real))], []);
});

test("Counter-probes: every sabotage is caught", async () => {
  for (const sabotage of SABOTAGES) {
    const [old, fresh] = sabotage.lib ?? sabotage.window;
    const source = sabotage.lib ? LIB : WINDOW;
    assert.equal(source.split(old).length - 1, 1, `sabotage "${sabotage.name}" is stale (spot not exactly once)`);
    const dir = translate(sabotage.lib ? LIB.replace(old, fresh) : LIB, sabotage.window ? WINDOW.replace(old, fresh) : WINDOW);
    const caught = new Set([...(await checkComputation(dir)), ...(await checkRendered(dir))]);
    for (const f of sabotage.catches) assert.ok(caught.has(f), `sabotage "${sabotage.name}" not caught by "${f}" (caught: ${[...caught].join(", ") || "nothing"})`);
  }
});

// ── (3) the sources: each promise is a spot that occurs exactly once; the counter-probe removes it (or puts the old form back) ──
const Q = { tree: TREE, row: ROW, css: CSS, window: WINDOW };
const PLACES = [
  ["tree draws via the window", "tree", "<TreeWindow surface={surface} count={rows.length} h={dimensions.h} view={dimensions.view} always={always} draw={draw} onScroll={computeSticky} />"],
  ["sticky only on change", "tree", "if (sameNode(stickyNode(sz, top, m.h, m.view), stickyRef.current)) return;"],
  ["focus, field and drag stay drawn", "tree", "const always = [focusIndex, fieldIndex, dragIndex].filter((i) => i >= 0);"],
  ["show from the index", "tree", "const target = scrollTarget(i, dimensions.h, el.scrollTop, el.clientHeight);"],
  ["aria-setsize on the row", "tree", "setsize={aria.size[i]}"],
  ["aria-posinset on the row", "tree", "posinset={aria.position[i]}"],
  ["aria once per row state", "tree", "const aria = useMemo(() => ariaSet(rows), [rows]);"],
  ["row carries aria-setsize", "row", "aria-setsize={setsize}"],
  ["row carries aria-posinset", "row", "aria-posinset={posinset}"],
  ["row at its top", "row", "style={{ top, paddingLeft: inset(row.depth) }}"],
  ["row stays memo", "row", "export const TreeRow = memo(function TreeRow("],
  ["rows absolute in the window", "css", ".cb-tree-window > .cb-tree-row { position: absolute; left: 0; right: 0; }"],
  ["window draws synchronously in the event", "window", "flushSync(() => {"],
  ["window takes over the state before painting", "window", "useLayoutEffect(() => {\n    const el = surface.current;\n    if (!el || el.scrollTop === top.current) return;"],
];
/** The old form must not come back: all rows drawn, one state per scroll event at the tree. */
const FORBIDDEN = [
  ["all rows drawn", "tree", /rows\.map\(\(z, i\) => draw/, "{rows.map((z, i) => draw(z, i))}"],
  ["state per scroll event at the tree", "tree", /(?<!draw=\{draw\} )onScroll=|setScroll\b/, "onScroll={afterRoles}"],
];
function checkSources(q) {
  const error = [];
  for (const [name, file, place] of PLACES) if (q[file].split(place).length - 1 !== 1) error.push(name);
  for (const [name, file, pattern] of FORBIDDEN) if (pattern.test(q[file])) error.push(name);
  return error;
}
test("(3) the sources: tree via the window, no state per scroll, aria and top on the row, with counter-probes", () => {
  assert.deepEqual(checkSources(Q), []);
  for (const [name, file, place] of PLACES) assert.ok(checkSources({ ...Q, [file]: Q[file].replace(place, "") }).includes(name), `counter-probe "${name}" not caught`);
  for (const [name, file, , old] of FORBIDDEN) assert.ok(checkSources({ ...Q, [file]: `${Q[file]}\n${old}` }).includes(name), `counter-probe "${name}" not caught`);
});
