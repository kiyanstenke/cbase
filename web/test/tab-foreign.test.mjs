// A tab from ANOTHER window: as in VS Code a group opens the file of a tab that is dropped from another window, if it has the
// same location (origin, route, instance); otherwise it is rejected (and never lands as text in the editor).
//
// (1) The computation lib/tab-foreign.ts, EXECUTED: the data of a drag (window always, location and path only for a file); a drag
//     from THIS window is never foreign; foreign AND here only at the same location (each of the three details counts); on drop only
//     a path whose data name exactly this location (no `..`, no absolute path, nothing unreadable).
// (2) The sources: the tab carries the data when dragged (files AND chat), the tile does not reorder a foreign tab, bar and area
//     accept "foreign" only via `foreignTabHere` and open on drop only via `foreignPath` (otherwise nothing), CodePane gives its
//     location to both. The explorer takes a foreign drag like VS Code `ExternalFileImport` (`importing`, useExplorer.ts): sources and
//     target freshly read, a folder at the root asks, occupied => "Replace?" (delete first, then copy), onto itself nothing, missing
//     and impossible reported, a single file opens pinned.
//
// Every sabotage changes exactly ONE spot (otherwise it is stale) and must be caught.
//
// Run:  node --test --test-reporter=tap web/test/tab-foreign.test.mjs
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
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const SOURCE = read("src", "lib", "tab-foreign.ts");
const SABOTAGES = {
  "location without instance": { old: "JSON.stringify([o.origin, o.apiBase, o.instance ?? null])", fresh: "JSON.stringify([o.origin, o.apiBase])" },
  "location without origin": { old: "JSON.stringify([o.origin, o.apiBase, o.instance ?? null])", fresh: "JSON.stringify([o.apiBase, o.instance ?? null])" },
  "own window counts as foreign": { old: " && !types.includes(windowType(window));", fresh: ";" },
  "every drag counts as foreign": { old: "types.some((t) => t.startsWith(WINDOW_PREFIX)) && ", fresh: "" },
  "foreign without location": { old: "fromOtherWindow(types, window) && types.includes(locationType(location))", fresh: "fromOtherWindow(types, window)" },
  "drop without location comparison": { old: "return x.origin === location.origin && x.apiBase === location.apiBase && (x.instance ?? null) === (location.instance ?? null);", fresh: "return true;" },
  "drop with ..": { old: " || x.path.split(\"/\").includes(\"..\")", fresh: "" },
  "drag without location": { old: "  if (foreign && foreign.path) out.push(", fresh: "  if (false) out.push(" },
  "drag without window": { old: "const out: [string, string][] = [[windowType(window), \"1\"]];", fresh: "const out: [string, string][] = [];" },
  "explorer drag without window": { old: "return [[windowType(window), \"1\"], [locationType(location), \"1\"]];", fresh: "return [[locationType(location), \"1\"]];" },
  "explorer drag without location": { old: "return [[windowType(window), \"1\"], [locationType(location), \"1\"]];", fresh: "return [[windowType(window), \"1\"]];" },
  "explorer drop with ..": { old: "!p.startsWith(\"/\") && !p.split(\"/\").includes(\"..\")", fresh: "true" },
  "explorer drop with subset": { old: "return paths.length && paths.length === x.paths.length ? paths : null;", fresh: "return paths.length ? paths : null;" },
  "explorer drop empty": { old: "return paths.length && paths.length === x.paths.length ? paths : null;", fresh: "return paths.length === x.paths.length ? paths : null;" },
  "drop reads only tabs": { old: "  if (types.includes(treeType)) return foreignTreePaths(data(treeType), location);\n", fresh: "" },
  "drop without location comparison (explorer)": { old: "  if (!sameLocation(x, location)) return null;\n  if (!Array.isArray(x.paths))", fresh: "  if (!Array.isArray(x.paths))" },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-tab-foreign-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "tab-foreign.ts"), SOURCE);
const copies = Object.entries(SABOTAGES).map(([name, s], i) => {
  const file = `tab-foreign-sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, s.fresh));
  return { name, file, places: SOURCE.split(s.old).length - 1 };
});
try {
  execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((d) => path.join(src, d)), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  if (text.split("\n").some((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z)) || !fs.existsSync(path.join(out, "tab-foreign.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (d) => import(pathToFileURL(path.join(out, d.replace(/\.ts$/, ".js"))).href);
const real = await load("tab-foreign.ts");
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, M: await load(k.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* irrelevant */ }

const TAB = "application/x-cbase-tab";
function computation(M) {
  const location = { origin: "https://cbase.example", apiBase: "/api/workspaces/w1", instance: null };
  // A drag from window A (file): this is how window B sees it while dragging (only the types) and on drop (the data).
  const data = new Map(M.tabDragData({ location, path: "till/src/app.ts" }, "windowa"));
  const types = [TAB, "text/plain", ...data.keys()];
  assert.ok(types.includes(M.windowType("windowa")) && types.includes(M.LOCATION_TYPE) && types.includes(M.locationType(location)), "the drag carries window, location and the location identifier");
  assert.deepEqual(new Map(M.tabDragData(null, "windowa")), new Map([[M.windowType("windowa"), "1"]]), "without a file only the window");
  for (const t of types) assert.equal(t, t.toLowerCase(), `type ${t} not lowercase (the browser lowercases types)`);
  assert.equal(M.fromOtherWindow(types, "windowa"), false, "a drag from THIS window is never foreign");
  assert.equal(M.foreignTabHere(types, location, "windowa"), false);
  assert.equal(M.fromOtherWindow(types, "fensterb"), true);
  assert.equal(M.foreignTabHere(types, location, "fensterb"), true, "window B at the same location takes the tab");
  assert.equal(M.fromOtherWindow([TAB, "text/plain"], "fensterb"), false, "a drag without window (explorer, text) is not a foreign tab");
  for (const different of [{ ...location, origin: "https://other.example" }, { ...location, apiBase: "/api/workspaces/w2" }, { ...location, instance: "p1/copy" }]) {
    assert.equal(M.foreignTabHere(types, different, "fensterb"), false, `other location ${JSON.stringify(different)} takes the tab`);
    assert.equal(M.foreignPath(data.get(M.LOCATION_TYPE), different), null, `other location ${JSON.stringify(different)} opens on drop`);
  }
  assert.equal(M.foreignPath(data.get(M.LOCATION_TYPE), location), "till/src/app.ts");
  const including = (filePath) => JSON.stringify({ ...location, path: filePath });
  assert.equal(M.foreignPath(including("../outside.ts"), location), null, "`..` opens nothing");
  assert.equal(M.foreignPath(including("/etc/passwd"), location), null, "an absolute path opens nothing");
  assert.equal(M.foreignPath("not json", location), null);
  assert.equal(M.foreignPath(JSON.stringify([1]), location), null);
  const copy = { ...location, instance: "p1/k" };
  assert.equal(M.foreignPath(new Map(M.tabDragData({ location: copy, path: "a.ts" }, "x")).get(M.LOCATION_TYPE), copy), "a.ts", "a copy to itself");
  assert.notEqual(M.locationIdentifier(location), M.locationIdentifier(copy));

  // Entries from the explorer of another window: types like a tab (window + location identifier), data with origin.
  const TREE = "application/x-cbase-tree";
  const dragTypes = M.treeDragTypes(location, "windowa");
  const dataTypes = [TREE, "text/plain", ...dragTypes.map(([t]) => t)];
  assert.ok(dataTypes.includes(M.windowType("windowa")) && dataTypes.includes(M.locationType(location)) && !dataTypes.includes(M.LOCATION_TYPE), "the explorer drag carries window and location identifier (no tab data)");
  assert.equal(M.foreignTabHere(dataTypes, location, "windowa"), false, "never foreign in the own window");
  assert.equal(M.foreignTabHere(dataTypes, location, "fensterb"), true, "window B at the same location takes the entries");
  for (const different of [{ ...location, origin: "https://other.example" }, { ...location, apiBase: "/api/workspaces/w2" }, { ...location, instance: "p1/copy" }])
    assert.equal(M.foreignTabHere(dataTypes, different, "fensterb"), false, `other location ${JSON.stringify(different)} takes the entries`);
  const dataOf = (paths, o = location) => JSON.stringify({ origin: o.origin, apiBase: o.apiBase, instance: o.instance, paths });
  assert.deepEqual(M.foreignTreePaths(dataOf(["a.ts", "src/b"]), location), ["a.ts", "src/b"]);
  for (const different of [{ ...location, origin: "https://other.example" }, { ...location, apiBase: "/api/workspaces/w2" }, { ...location, instance: "p1/copy" }])
    assert.equal(M.foreignTreePaths(dataOf(["a.ts"]), different), null, `other location ${JSON.stringify(different)} takes on drop`);
  assert.equal(M.foreignTreePaths(JSON.stringify({ apiBase: location.apiBase, instance: null, paths: ["a.ts"] }), location), null, "without origin (old drag) nothing");
  assert.equal(M.foreignTreePaths(dataOf(["a.ts", "../x"]), location), null, "a path with `..` discards the whole drop");
  assert.equal(M.foreignTreePaths(dataOf(["/etc"]), location), null, "an absolute path takes nothing");
  assert.equal(M.foreignTreePaths(dataOf([]), location), null, "empty takes nothing");
  assert.equal(M.foreignTreePaths(dataOf(["a", 3]), location), null);
  assert.equal(M.foreignTreePaths("not json", location), null);
  const read = (m) => (t) => m.get(t) ?? "";
  assert.deepEqual(M.foreignFiles(read(new Map([[TREE, dataOf(["a.ts"])]])), dataTypes, location, TREE), ["a.ts"], "the drop opens the explorer entries");
  assert.deepEqual(M.foreignFiles(read(data), types, location, TREE), ["till/src/app.ts"], "the drop opens a tab");
  assert.equal(M.foreignFiles(read(new Map()), ["text/plain"], location, TREE), null);
}

test("(1) Computation: data of the drag, foreign only from another window at the same location, drop only with exactly the current location (with counter-probes)", () => {
  computation(real);
  const stale = copies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}×)`);
  assert.deepEqual(stale, [], "stale sabotages");
  const not = sabotaged.filter((s) => { try { computation(s.M); return true; } catch { return false; } }).map((s) => s.name);
  assert.deepEqual(not, [], "sabotages of the computation that no check catches");
});

const Q = {
  bar: read("src", "components", "code", "TabBar.tsx"),
  groups: read("src", "components", "code", "EditorGroups.tsx"),
  pane: read("src", "components", "CodePane.tsx"),
  chat: read("src", "components", "chat", "ChatTabBar.tsx"),
  tree: read("src", "components", "code", "explorer", "ExplorerTree.tsx"),
  ex: read("src", "components", "code", "explorer", "useExplorer.ts"),
};
function sources(q) {
  const l = withoutComments(q.bar), g = withoutComments(q.groups), p = withoutComments(q.pane), c = withoutComments(q.chat);
  assert.ok(l.includes("for (const [type, value] of tabDragData(drag.foreign ?? null)) e.dataTransfer.setData(type, value);"), "the tab carries neither window nor location when dragged");
  assert.ok(l.includes("if (!e.dataTransfer.types.includes(DRAG_TYPE) || fromOtherWindow(e.dataTransfer.types)) return;")
    && l.includes("if (!from || fromOtherWindow(e.dataTransfer.types)) return;"), "the tile reorders a tab from another window");
  assert.ok(l.includes("if (location && foreignTabHere(e.dataTransfer.types, location)) return \"foreign\";")
    && l.includes("if (kind === \"foreign\") { const f = location ? foreignFiles((type) => e.dataTransfer.getData(type), e.dataTransfer.types, location, TREE_TYPE) : null; if (!f) return; files = f; }"), "the bar does not take/open a foreign tab, or does so without location comparison");
  assert.ok(l.includes("foreign: location && fileTab(p) ? { location, path: p } : null"), "the file tabs of the bar do not carry their location");
  assert.ok(g.includes("if (location && (types.includes(TAB_TYPE) || types.includes(TREE_TYPE)) && foreignTabHere(types, location)) return \"foreign\";")
    && g.includes("if (kind === \"foreign\") { const f = location ? foreignFiles((type) => e.dataTransfer.getData(type), e.dataTransfer.types, location, TREE_TYPE) : null; if (!f) return; files = f; }"), "the area does not take/open a foreign tab, or does so without location comparison");
  assert.ok(p.includes("const location = useMemo(() => tabLocation(apiBase, instance ?? null), [apiBase, instance]);")
    && (p.match(/\n\s+location=\{location\}\n/g) ?? []).length === 2, "CodePane does not give bar and area its location");
  assert.ok(c.includes("foreign: tab.kind === \"file\" ? { location: tabLocation(tab.target.apiBase, tab.target.instance), path: tab.path } : null"), "the file tabs of the chat do not carry their location");
  // The explorer carries window, location and origin when dragging; a foreign drag is only taken at the same location and then COPIED.
  const b = withoutComments(q.tree);
  assert.ok(b.includes("for (const [type, value] of treeDragTypes(location)) e.dataTransfer.setData(type, value);")
    && b.includes("const data: DragData = { origin: location.origin,"), "the explorer drag does not carry window/location/origin");
  assert.ok(b.includes("if (foreign && !foreignTabHere(e.dataTransfer.types, tabLocation(apiBase, instance ?? null))) { e.dataTransfer.dropEffect = \"none\";"), "the explorer accepts a foreign drag without location comparison");
  assert.ok(b.includes("const q = foreignTreePaths(e.dataTransfer.getData(DRAG_TYPE), tabLocation(apiBase, instance ?? null));")
    && b.includes("void ex.importing(q, z);"), "the explorer does not drop a foreign drag (or not as an import)");
  const x = withoutComments(q.ex);
  assert.ok(x.includes("const list = (d: string) => { let l = listen.get(d); if (!l) listen.set(d, (l = load(d))); return l; };")
    && x.includes("const plan = importPlan(sources, target, ((await list(target)) ?? []).map((e) => e.name), (p) => kinds.get(p) ?? null);"), "the import does not read sources and target freshly");
  assert.ok(x.includes("if (plan.folderAtRoot) {") && x.includes("if (!(await question(text, { ok: t(\"Copy Folder\") }))) return [];"), "a folder at the root does not ask first");
  assert.ok(x.includes("if (o.replace && !(await question(t(\"A file or folder with the name “{name}” already exists in the destination folder."), "an occupied name does not ask");
  assert.ok(x.includes("if (o.replace) { await calls(`/files?path=${encodeURIComponent(o.to)}`, { method: \"DELETE\" }); oRef.current.onDeleted(o.to); }\n          const r = await calls<{ omitted?: number }>(\"/files/copy\""), "replacing does not delete before copying (the server never overwrites)");
  assert.ok(x.includes("if (o.to !== o.from) {"), "onto itself it is deleted and copied (VS Code: nothing)");
  assert.ok(x.includes("if (o.error === \"itself\") throw") && x.includes("if (o.error === \"contained\") throw"), "the impossible is attempted instead of reported");
  assert.ok(x.includes("if (plan.missing.length) alert("), "missing items are not reported");
  assert.ok(x.includes("if (ops.length === 1 && finished.length === 1 && ops[0].kind === \"file\") oRef.current.onOpen(finished[0].to, true);"), "a single file does not open (VS Code `explorer.autoOpenDroppedFile`)");
}
const SOURCE_SABOTAGES = [
  ["tab without data", "bar", "for (const [type, value] of tabDragData(drag.foreign ?? null)) e.dataTransfer.setData(type, value);", ""],
  ["tile reorders foreign (drag)", "bar", "if (!e.dataTransfer.types.includes(DRAG_TYPE) || fromOtherWindow(e.dataTransfer.types)) return;", "if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;"],
  ["tile reorders foreign (drop)", "bar", "if (!from || fromOtherWindow(e.dataTransfer.types)) return;", "if (!from) return;"],
  ["bar does not take foreign", "bar", "if (location && foreignTabHere(e.dataTransfer.types, location)) return \"foreign\";", ""],
  ["bar opens without comparison", "bar", "const f = location ? foreignFiles((type) => e.dataTransfer.getData(type), e.dataTransfer.types, location, TREE_TYPE) : null; if (!f) return; files = f;", "files = [JSON.parse(e.dataTransfer.getData(\"application/x-cbase-location\")).path];"],
  ["file tabs without location", "bar", "foreign: location && fileTab(p) ? { location, path: p } : null", "foreign: null"],
  ["area does not take foreign", "groups", "if (location && (types.includes(TAB_TYPE) || types.includes(TREE_TYPE)) && foreignTabHere(types, location)) return \"foreign\";", ""],
  ["area opens without comparison", "groups", "const f = location ? foreignFiles((type) => e.dataTransfer.getData(type), e.dataTransfer.types, location, TREE_TYPE) : null; if (!f) return; files = f;", "files = [JSON.parse(e.dataTransfer.getData(\"application/x-cbase-location\")).path];"],
  ["CodePane without location", "pane", "          area={area}\n          location={location}\n", "          area={area}\n"],
  ["explorer drag without types", "tree", "for (const [type, value] of treeDragTypes(location)) e.dataTransfer.setData(type, value);", ""],
  ["explorer drag without origin", "tree", "const data: DragData = { origin: location.origin,", "const data: DragData = {"],
  ["explorer takes every foreign drag", "tree", "if (foreign && !foreignTabHere(e.dataTransfer.types, tabLocation(apiBase, instance ?? null))) {", "if (false) {"],
  ["explorer drops foreign without comparison", "tree", "const q = foreignTreePaths(e.dataTransfer.getData(DRAG_TYPE), tabLocation(apiBase, instance ?? null));", "const q = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)).paths;"],
  ["explorer moves foreign", "tree", "void ex.importing(q, z);", "void ex.deposit(q, z, \"move\");"],
  ["import does not read freshly", "ex", "if (!l) listen.set(d, (l = load(d)));", "if (!l) listen.set(d, (l = Promise.resolve(children[d] ?? null)));"],
  ["folder at the root without question", "ex", "if (plan.folderAtRoot) {", "if (false) {"],
  ["import replaces without question", "ex", "if (o.replace && !(await question(", "if (false && !(await question("],
  ["replacing without deleting", "ex", "if (o.replace) { await calls(`/files?path=${encodeURIComponent(o.to)}`, { method: \"DELETE\" }); oRef.current.onDeleted(o.to); }\n", ""],
  ["copied onto itself", "ex", "if (o.to !== o.from) {", "if (true) {"],
  ["impossible attempted", "ex", "if (o.error === \"itself\") throw", "if (false) throw"],
  ["missing silent", "ex", "if (plan.missing.length) alert(", "if (false) alert("],
  ["file does not open", "ex", "if (ops.length === 1 && finished.length === 1 && ops[0].kind === \"file\") oRef.current.onOpen(finished[0].to, true);", ""],
  ["area does not take foreign explorer", "groups", "(types.includes(TAB_TYPE) || types.includes(TREE_TYPE)) && foreignTabHere", "types.includes(TAB_TYPE) && foreignTabHere"],
  ["chat tabs without location", "chat", "foreign: tab.kind === \"file\" ? { location: tabLocation(tab.target.apiBase, tab.target.instance), path: tab.path } : null", "foreign: null"],
];
test("(2) Sources: the tab carries the location, the tile does not reorder, bar and area open only at the same location (with counter-probes)", () => {
  sources(Q);
  for (const [name, k, old, fresh] of SOURCE_SABOTAGES) {
    const n = Q[k].split(old).length - 1;
    assert.equal(n, 1, `counter-probe "${name}" is stale: the spot occurs ${n}x in ${k}`);
    assert.throws(() => sources({ ...Q, [k]: Q[k].replace(old, fresh) }), undefined, `counter-probe "${name}" is not caught`);
  }
});
