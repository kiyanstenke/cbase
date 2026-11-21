// CodePane no longer re-renders on every keystroke (measured in a real browser: 64 components per key before, 4 after):
// (1) lib/buffer-shape.ts, EXECUTED: the shape of a buffer changes with dirty, read-only, location and every field of the state, NOT
//     with text and version.
// (2) The wiring (read as source): `useBufferTabs` ticks only when the shape changed and reports EVERY change to `change`; outline,
//     problems (editor and explorer) and drafts (CodePane, diff tab) listen there; status bar and outline read the cursor position
//     themselves — CodePane does not subscribe to the cursor.
// Each counter-test changes ONE place and must turn red.
//
// Run:  node --test --test-reporter=tap web/test/buffer-shape.test.mjs
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
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "");

const SHEET = read("src", "lib", "buffer-shape.ts");
const SAB_COMPUTATION = {
  "text counts": ["const ONLY_TEXT = new Set([\"text\", \"version\"]);", "const ONLY_TEXT = new Set([\"version\"]);"],
  "version counts": ["const ONLY_TEXT = new Set([\"text\", \"version\"]);", "const ONLY_TEXT = new Set([\"text\"]);"],
  "no dirty": ["return [p.dirty, p.readonly, p.key,", "return [p.readonly, p.key,"],
  "no read-only": ["return [p.dirty, p.readonly, p.key,", "return [p.dirty, p.key,"],
  "no location": ["return [p.dirty, p.readonly, p.key,", "return [p.dirty, p.readonly,"],
  "keys only": ["...fields.flatMap((k) => [k, state[k]])", "...fields"],
  "unsorted": [".filter((k) => !ONLY_TEXT.has(k)).sort();", ".filter((k) => !ONLY_TEXT.has(k));"],
  "length ignored": ["if (!a || !b || a.length !== b.length) return false;", "if (!a || !b) return false;"],
  "first look equal": ["if (!a || !b || a.length !== b.length) return false;", "if (!a || !b) return true;\n  if (a.length !== b.length) return false;"],
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-buffer-shape-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "real.ts"), SHEET);
const copies = Object.entries(SAB_COMPUTATION).map(([name, [old, fresh]], i) => {
  const places = SHEET.split(old).length - 1;
  fs.writeFileSync(path.join(src, `s${i}.ts`), SHEET.replace(old, fresh));
  return { name, places, file: `s${i}.ts` };
});
try {
  execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((d) => path.join(src, d)), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  if (text.split("\n").some((z) => /error TS\d+/.test(z) && /real\.ts\(/.test(z)) || !fs.existsSync(path.join(out, "real.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (d) => import(pathToFileURL(path.join(out, d.replace(/\.ts$/, ".js"))).href);
const real = await load("real.ts");
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, M: await load(k.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

function computation(M) {
  const error = { kind: "network" };
  const base = { status: { state: "loaded", text: "a", version: 1, saved: "a", error: null, inquiry: null }, dirty: false, readonly: false, key: "w1::a.ts" };
  const g = (p) => M.shapeOf(p);
  const including = (state, rest = {}) => ({ ...base, ...rest, status: { ...base.status, ...state } });
  assert.ok(M.sameShape(g(base), g(including({}))), "same state, rebuilt");
  assert.ok(M.sameShape(g(base), g(including({ text: "ab", version: 2 }))), "a keystroke (text and version) does not change the shape");
  assert.ok(M.sameShape(g(base), g({ ...base, status: { version: 9, inquiry: null, error: null, text: "zz", saved: "a", state: "loaded" } })), "field order does not matter");
  assert.ok(!M.sameShape(g(base), g(including({}, { dirty: true }))), "dirty");
  assert.ok(!M.sameShape(g(base), g(including({}, { readonly: true }))), "read-only");
  assert.ok(!M.sameShape(g(base), g(including({}, { key: "w1::b.ts" }))), "location (renamed)");
  assert.ok(!M.sameShape(g(base), g(including({ state: "loading" }))), "State");
  assert.ok(!M.sameShape(g(base), g(including({ error }))), "SaveError");
  assert.ok(!M.sameShape(g(base), g(including({ inquiry: { kind: "changed" } }))), "Inquiry");
  assert.ok(!M.sameShape(g(base), g(including({ saved: "ab" }))), "saved text (saving)");
  assert.ok(!M.sameShape(g(base), g({ ...base, status: { ...base.status, fresh: 1 } })), "a new field");
  assert.ok(!M.sameShape(g(base), g({ ...base, status: { ...base.status, zz: 1 } })), "a new field at the end");
  assert.ok(!M.sameShape(g({ ...base, status: { state: "loaded", a: 1 } }), g({ ...base, status: { state: "loaded", b: 1 } })), "a different field with the same value");
  assert.ok(!M.sameShape(undefined, g(base)) && !M.sameShape(g(base), null), "no predecessor (first look): redraw");
}

test("(1) computation: the shape changes with everything except text and version (with counter-tests)", () => {
  computation(real);
  assert.deepEqual(copies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}×)`), [], "stale sabotages");
  const not = sabotaged.filter((s) => { try { computation(s.M); return true; } catch { return false; } }).map((s) => s.name);
  assert.deepEqual(not, [], "sabotages of the computation that no check catches");
});

const Q = {
  editor: read("src", "components", "code", "BufferEditor.tsx"),
  pane: read("src", "components", "CodePane.tsx"),
  diff: read("src", "components", "code", "DiffTab.tsx"),
  layout: read("src", "components", "code", "layout-problems.ts"),
  tree: read("src", "components", "code", "explorer", "tree-problems.ts"),
  bar: read("src", "components", "code", "StatusBar.tsx"),
  content: read("src", "components", "code", "LayoutContent.tsx"),
};
function sources(q) {
  const e = withoutComments(q.editor), p = withoutComments(q.pane), d = withoutComments(q.diff), g = withoutComments(q.layout), b = withoutComments(q.tree);
  assert.ok(e.includes("if (!sameShape(old, fresh)) tick();\n    for (const fn of [...listeners.current]) fn();"), "the holder ticks on every key or does not report every change");
  assert.ok(e.includes("const subscription = (p: Buffer) => { shape.current.set(p, shapeOf(p)); return p.subscribe(() => report(p)); };")
    && (e.match(/off: subscription\((p|n)\)/g) ?? []).length === 2 && !/subscribe\(tick\)/.test(e), "a tab subscribes to its buffer bypassing the shape comparison");
  assert.ok(p.includes("const { bufferOf, tick: bufferTick, change } = useBufferTabs(") && !/useCursorSituation\(/.test(p), "CodePane subscribes to the cursor (renders on every key)");
  assert.ok(p.includes("bufferOf, bufferTick, change });") && p.includes("useTreeProblems({ on: isActive && mode === \"explorer\" && !treeHidden, tabs, bufferOf, bufferTick, change });"), "outline/problems do not listen to the changes");
  assert.ok(p.includes("const off = change.subscribe(() => { clearTimeout(h); h = setTimeout(saveDrafts, 300); });"), "the coding chat drafts no longer follow the keys");
  assert.ok(d.includes("useEffect(() => change.subscribe(() => rememberLater.current()), [change]);"), "the diff tab draft no longer follows the keys");
  assert.ok(g.includes("const off = pa.subscribe(") && g.includes("const off = change.subscribe("), "outline or problems do not listen");
  assert.ok(b.includes("const off = change.subscribe(() => { clearTimeout(h); h = question(); });"), "the explorer problems do not listen");
  assert.ok(q.bar.includes("const situation = useCursorSituation(view);") && q.bar.includes("const one = useCursorValue(view, indentationOf);"), "the status bar does not read the cursor itself");
  assert.ok(q.content.includes("const cursor = useCursorSituation(view)?.lsp ?? null;"), "the outline does not read the cursor itself");
}
const SOURCE_SABOTAGES = [
  ["ticks per key", "editor", "if (!sameShape(old, fresh)) tick();", "tick();"],
  ["does not report", "editor", "\n    for (const fn of [...listeners.current]) fn();", ""],
  ["tab bypasses the comparison", "editor", "m.set(pf, { p, release: p.hold(\"tab\"), off: subscription(p), targetK: targetKey });", "m.set(pf, { p, release: p.hold(\"tab\"), off: p.subscribe(tick), targetK: targetKey });"],
  ["CodePane with cursor", "pane", "const activeView = useCallback(() => cmRef.current?.view ?? null, [cmRef]);", "const activeView = useCallback(() => cmRef.current?.view ?? null, [cmRef]);\n  const cursorSituation = useCursorSituation(activeView);"],
  ["problems without changes", "pane", "useTreeProblems({ on: isActive && mode === \"explorer\" && !treeHidden, tabs, bufferOf, bufferTick, change });", "useTreeProblems({ on: isActive && mode === \"explorer\" && !treeHidden, tabs, bufferOf, bufferTick, change: { subscribe: () => () => {} } });"],
  ["drafts without keys", "pane", "const off = change.subscribe(() => { clearTimeout(h); h = setTimeout(saveDrafts, 300); });", "const off = () => {};"],
  ["diff draft without keys", "diff", "useEffect(() => change.subscribe(() => rememberLater.current()), [change]);", ""],
  ["explorer problems deaf", "tree", "const off = change.subscribe(() => { clearTimeout(h); h = question(); });", "const off = () => {};"],
  ["status bar blind", "bar", "const one = useCursorValue(view, indentationOf);", "const one = \"leer:4\";"],
  ["outline blind", "content", "const cursor = useCursorSituation(view)?.lsp ?? null;", "const cursor = null;"],
];
test("(2) sources: tick only with the shape, every change to the listeners, cursor in the leaves (with counter-tests)", () => {
  sources(Q);
  for (const [name, k, old, fresh] of SOURCE_SABOTAGES) {
    const n = Q[k].split(old).length - 1;
    assert.equal(n, 1, `counter-test "${name}" is stale: the spot occurs ${n}× in ${k}`);
    assert.throws(() => sources({ ...Q, [k]: Q[k].replace(old, fresh) }), undefined, `counter-test "${name}" is not caught`);
  }
});
