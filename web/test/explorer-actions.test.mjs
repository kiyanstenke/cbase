// Explorer operation as in VS Code, lib/explorer-actions.ts, EXECUTED: which key does what (`keyToAction`), content and order of the
// context menu (`menuPlan`: "Paste" only on folders, "Open in Terminal" only with a terminal), the selection after a click
// (`select`: cmd toggles, shift takes the range from the anchor, cmd+shift ADDS it), where "Paste" puts things (`insertTargets` =
// VS Code `pasteFileHandler`: onto the source itself => its folder, into an own subfolder => error) and the folder of an element
// (`targetFolder`: an unknown kind is null, never silently a file). Each sabotage is a copy of the source with ONE changed spot;
// the assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/explorer-actions.test.mjs
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
const SOURCE = fs.readFileSync(path.join(webDir, "src", "lib", "explorer-actions.ts"), "utf8");
const TREE = fs.readFileSync(path.join(webDir, "src", "lib", "explorer-tree.ts"), "utf8");

const SABOTAGES = {
  // cmd+C/cmd+V on the copied folder itself must not put the copy INTO it.
  "paste onto the source puts inside": { old: "if (element === q) target = parentOf(q);\n    else ", fresh: "", catches: "insert" },
  "paste into the own subfolder": { old: "if (element !== q && element.startsWith(`${q}/`)) return { error: \"ancestor\" };", fresh: "", catches: "insert" },
  "paste: unknown as file": { old: `else return { error: "unknown" };`, fresh: "else target = parentOf(element);", catches: "insert" },
  "paste without groups": { old: "if (g) g.sources.push(q); else groups.push({ target, sources: [q] });", fresh: "groups.push({ target, sources: [q] });", catches: "insert" },
  "target folder: unknown as file": { old: `if (kind === "file") return parentOf(path);`, fresh: "return parentOf(path);", catches: "target" },
  "alt+shift+F missing": { old: `if (!mod && e.alt && e.shift && e.code === "KeyF") return { kind: "search-in-folder" };`, fresh: "", catches: "keys" },
  "PageUp/PageDown missing": { old: `PageUp: "pageUp", PageDown: "pageDown",`, fresh: "", catches: "keys" },
  "alt+C via key": { old: `if (mod && e.alt && e.code === "KeyC")`, fresh: `if (mod && e.alt && e.key === "c")`, catches: "keys" },
  "shift expands everything": { old: `expand: e.shift && (key === "up" || key === "down")`, fresh: "expand: e.shift", catches: "keys" },
  "cmd swallows CodePane": { old: "  if (mod || e.alt) return null;\n", fresh: "", catches: "keys" },
  "paste on files": { old: `if (folder) disabled.push({ action: "insert", disabled: !k.clipboard });`, fresh: `disabled.push({ action: "insert", disabled: !k.clipboard });`, catches: "menu" },
  "terminal without terminal": { old: `if (k.terminal) disabled.push({ action: "in-terminal" });`, fresh: `disabled.push({ action: "in-terminal" });`, catches: "menu" },
  "double separators": { old: `if (p === "separator" && (!clean.length || clean[clean.length - 1] === "separator")) continue;`, fresh: "", catches: "menu" },
  // "Open Preview" on a Markdown file like VS Code `markdown.showPreview` (explorer/context, navigation).
  "preview missing": { old: `if (k.preview && k.kind === "file") disabled.push({ action: "preview" });`, fresh: "", catches: "menu" },
  "preview on folders": { old: `if (k.preview && k.kind === "file")`, fresh: `if (k.preview)`, catches: "menu" },
  "preview before \"Open to the Side\"": { old: `  if (k.beside && k.kind === "file") disabled.push({ action: "to-page" });`, fresh: `  if (k.preview && k.kind === "file") disabled.push({ action: "to-page" });`, catches: "menu" },
  "rename with several": { old: `{ action: "rename", disabled: k.several }`, fresh: `{ action: "rename" }`, catches: "menu" },
  "cmd+shift click replaces": { old: "new Set(mod.meta ? [...status.selection, ...fresh] : fresh)", fresh: "new Set(fresh)", catches: "select" },
  "shift moves the anchor": { old: "anchor: status.anchor ?? path", fresh: "anchor: path", catches: "select" },
  "cmd click replaces": { old: "if (n.has(path)) n.delete(path); else n.add(path);", fresh: "n.clear(); n.add(path);", catches: "select" },
  // Delete with unsaved changes (VS Code `deleteFiles`): the confirmation must say that unsaved changes are lost.
  "delete without warning": { old: "if (affected.size === 0) return null;", fresh: "return null;", catches: "erase" },
  "delete: folder as file": { old: "return affected.has(e) ? { kind: \"file\", name } : { kind: \"folder\", name, count: affected.size };", fresh: "return { kind: \"file\", name };", catches: "erase" },
  "delete: neighbor counts too": { old: "p === e || p.startsWith(`${e}/`)", fresh: "p.startsWith(e)", catches: "erase" },
  "delete: several as one": { old: "if (list.length > 1) return { kind: \"files\" };", fresh: "", catches: "erase" },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-explorer-actions-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "explorer-actions.ts"), SOURCE);
fs.writeFileSync(path.join(src, "explorer-tree.ts"), TREE);
const copies = Object.entries(SABOTAGES).map(([name, s], i) => {
  const file = `explorer-actions-sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, s.fresh));
  return { name, file, catches: s.catches, places: SOURCE.split(s.old).length - 1 };
});
execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((f) => path.join(src, f)), "--outDir", out, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck"], { stdio: "pipe" });
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const tree = await load("explorer-tree.ts");

const d = (p) => ({ name: p.split("/").pop(), path: p, type: "dir" });
const f = (p) => ({ name: p.split("/").pop(), path: p, type: "file" });
const K = { "": [d("a"), d("b"), f("c.ts"), f("d.ts")], a: [f("a/x.ts"), f("a/y.ts")] };
const ROWS = tree.visibleRows(K, new Set(["a"]));
const ev = (o) => ({ key: "", code: "", meta: false, ctrl: false, alt: false, shift: false, ...o });
const kind = (x) => x?.kind ?? null;
const plan = (m, k) => m.menuPlan({ target: null, kind: "dir", several: false, clipboard: true, terminal: false, ...k }).map((p) => (p === "separator" ? "|" : p.disabled ? `(${p.action})` : p.action));

const CHECKS = {
  erase: (m) => {
    assert.equal(m.deleteWarning(["a/x.ts"], []), null, "without unsaved changes: the ordinary confirmation");
    assert.equal(m.deleteWarning(["a/x.ts"], ["b/y.ts"]), null, "unsaved changes elsewhere do not count");
    assert.deepEqual(m.deleteWarning(["a/x.ts"], ["a/x.ts"]), { kind: "file", name: "x.ts" }, "one file: \"You are deleting {0} ...\"");
    assert.deepEqual(m.deleteWarning(["a"], ["a/x.ts"]), { kind: "folder", name: "a", count: 1 }, "a folder with one: \"... in 1 file\"");
    assert.deepEqual(m.deleteWarning(["a"], ["a/x.ts", "a/b/y.ts", "ab/z.ts"]), { kind: "folder", name: "a", count: 2 },
      "a folder: counts only what lies below it (not the neighbor \"ab\")");
    assert.deepEqual(m.deleteWarning(["a", "c.ts"], ["a/x.ts"]), { kind: "files" }, "several entries: \"You are deleting files ...\"");
  },
  insert: (m) => {
    // VS Code pasteFileHandler: onto the copied source itself => into its folder ("src copy" next to "src").
    assert.deepEqual(m.insertTargets("src", "dir", ["src"]), { groups: [{ target: "", sources: ["src"] }] }, "onto the source itself: its folder");
    assert.deepEqual(m.insertTargets("p/src", "dir", ["p/src"]), { groups: [{ target: "p", sources: ["p/src"] }] });
    assert.deepEqual(m.insertTargets("src/sub", "dir", ["src"]), { error: "ancestor" }, "into an own subfolder: error");
    assert.deepEqual(m.insertTargets("src/sub/a.ts", "file", ["src"]), { error: "ancestor" }, "also via a file inside it");
    assert.deepEqual(m.insertTargets("lib", "dir", ["src"]), { groups: [{ target: "lib", sources: ["src"] }] }, "another folder: inside");
    assert.deepEqual(m.insertTargets("lib/x.ts", "file", ["src"]), { groups: [{ target: "lib", sources: ["src"] }] }, "a file: its folder");
    assert.deepEqual(m.insertTargets("", "dir", ["src"]), { groups: [{ target: "", sources: ["src"] }] }, "the root");
    assert.deepEqual(m.insertTargets("lib/fresh", null, ["src"]), { error: "unknown" }, "unknown kind: never silently as a file");
    assert.deepEqual(m.insertTargets("src", "dir", ["src", "lib/a.ts"]), { groups: [{ target: "", sources: ["src"] }, { target: "src", sources: ["lib/a.ts"] }] },
      "each source its target, grouped");
    assert.deepEqual(m.insertTargets("lib", "dir", ["a.ts", "b.ts"]), { groups: [{ target: "lib", sources: ["a.ts", "b.ts"] }] }, "same target: one group");
  },
  target: (m) => {
    assert.equal(m.targetFolder(null, null), "");
    assert.equal(m.targetFolder("src", "dir"), "src");
    assert.equal(m.targetFolder("src/a.ts", "file"), "src");
    assert.equal(m.targetFolder("src/fresh", null), null, "unknown is null, not the folder of a file");
  },
  keys: (m) => {
    const a = (o) => m.keyToAction(ev(o));
    assert.deepEqual(a({ code: "KeyC", key: "ç", meta: true, alt: true }), { kind: "path-copy", relative: false }, "alt+cmd+C via code (alt+C is \"ç\")");
    assert.deepEqual(a({ code: "KeyC", key: "Ç", meta: true, alt: true, shift: true }), { kind: "path-copy", relative: true });
    assert.equal(kind(a({ code: "KeyC", key: "c", meta: true })), "copy");
    assert.equal(kind(a({ code: "KeyX", key: "x", ctrl: true })), "cut");
    assert.equal(kind(a({ code: "KeyV", key: "v", meta: true })), "insert");
    assert.equal(kind(a({ code: "KeyA", key: "a", meta: true })), "all");
    assert.equal(kind(a({ key: "Backspace", meta: true })), "erase");
    assert.equal(kind(a({ key: "Delete" })), "erase");
    assert.equal(kind(a({ key: "ArrowDown", meta: true })), "open-fixed");
    assert.equal(kind(a({ code: "KeyF", key: "Ï", alt: true, shift: true })), "search-in-folder", "alt+shift+F like VS Code findInFolder");
    assert.equal(a({ code: "KeyS", key: "s", meta: true }), null, "cmd+S belongs to CodePane");
    assert.equal(a({ code: "KeyP", key: "p", meta: true }), null);
    assert.equal(a({ key: "f", alt: true, code: "KeyF" }), null, "alt+F alone: nothing");
    assert.deepEqual(a({ key: "ArrowDown", shift: true }), { kind: "step", key: "down", expand: true });
    assert.deepEqual(a({ key: "ArrowLeft", shift: true }), { kind: "step", key: "left", expand: false }, "shift+left does not expand");
    assert.deepEqual(a({ key: "PageDown" }), { kind: "step", key: "pageDown", expand: false });
    assert.deepEqual(a({ key: "PageUp" }), { kind: "step", key: "pageUp", expand: false });
    assert.deepEqual(a({ key: "Home" }), { kind: "step", key: "beginning", expand: false });
    assert.equal(kind(a({ key: "Enter" })), "rename");
    assert.equal(kind(a({ key: "F2" })), "rename");
    assert.equal(kind(a({ key: " " })), "spacebar");
    assert.equal(kind(a({ key: "Escape" })), "esc");
    assert.deepEqual(a({ key: "q" }), { kind: "typing", character: "q" });
    assert.equal(a({ key: "Tab" }), null);
  },
  menu: (m) => {
    // VS Code: folder - New File, New Folder, [Terminal], | Find in Folder | Cut, Copy, Paste | Path, relative |
    // Rename, Delete; a file without New/Find/Paste. cbase appends Download/Upload.
    assert.deepEqual(plan(m, { target: "src", kind: "dir" }), ["new-file", "new-folder", "|", "search", "|", "cut", "copy", "insert", "|",
      "path", "relative", "|", "rename", "erase", "|", "download", "upload"]);
    assert.deepEqual(plan(m, { target: "a.ts", kind: "file" }), ["cut", "copy", "|", "path", "relative", "|", "rename", "erase", "|", "download"],
      "paste only on folders (ExplorerFolderContext)");
    assert.deepEqual(plan(m, {}), ["new-file", "new-folder", "|", "search", "|", "insert", "|", "path", "upload"], "the empty area: the root");
    assert.deepEqual(plan(m, { target: "src", kind: "dir", terminal: true }).slice(0, 4), ["new-file", "new-folder", "in-terminal", "|"], "terminal only if there is one");
    assert.deepEqual(plan(m, { target: "a.ts", kind: "file", terminal: true }).slice(0, 2), ["in-terminal", "|"]);
    // "Open Preview" (Markdown) in "navigation" after "Open to the Side", never on a folder, only if the view can do it.
    assert.deepEqual(plan(m, { target: "a.md", kind: "file", beside: true, preview: true }).slice(0, 3), ["to-page", "preview", "|"], "Markdown: to the side, preview");
    assert.deepEqual(plan(m, { target: "a.md", kind: "file", preview: true }).slice(0, 2), ["preview", "|"], "in the chat without \"to the side\"");
    assert.ok(!plan(m, { target: "a.md", kind: "dir", preview: true }).includes("preview"), "never on a folder");
    assert.ok(!plan(m, { target: "a.ts", kind: "file", beside: true }).includes("preview"), "no preview without Markdown");
    assert.deepEqual(plan(m, { target: "src", kind: "dir", clipboard: false }).filter((x) => x.includes("insert")), ["(insert)"], "off without clipboard");
    const more = plan(m, { target: "a.ts", kind: "file", several: true });
    assert.ok(more.includes("(rename)") && more.includes("(download)") && more.includes("erase"), "several: rename/download off, delete on");
    assert.ok(plan(m, { target: "x", kind: null }).includes("(download)"), "unknown kind: no download");
  },
  select: (m) => {
    const empty = { selection: new Set(), focus: null, anchor: null };
    let s = m.select(empty, ROWS, "a/x.ts");
    assert.deepEqual([[...s.selection], s.focus, s.anchor], [["a/x.ts"], "a/x.ts", "a/x.ts"], "click");
    s = m.select(s, ROWS, "c.ts", { meta: true });
    assert.deepEqual([[...s.selection], s.anchor], [["a/x.ts", "c.ts"], "c.ts"], "cmd click adds and sets the anchor");
    s = m.select(s, ROWS, "c.ts", { meta: true });
    assert.deepEqual([...s.selection], ["a/x.ts"], "cmd click removes again");
    s = m.select(m.select(empty, ROWS, "a"), ROWS, "b", { shift: true });
    assert.deepEqual([[...s.selection], s.anchor], [["a", "a/x.ts", "a/y.ts", "b"], "a"], "shift click: range from the anchor, the anchor stays");
    s = m.select(s, ROWS, "a/x.ts", { shift: true });
    assert.deepEqual([...s.selection], ["a", "a/x.ts"], "shift again: from the same anchor");
    // cmd+shift click (VS Code): the range from the anchor ADDED.
    s = m.select(m.select(m.select(empty, ROWS, "d.ts"), ROWS, "a/x.ts", { meta: true }), ROWS, "a/y.ts", { meta: true, shift: true });
    assert.deepEqual([...s.selection].sort(), ["a/x.ts", "a/y.ts", "d.ts"], "cmd+shift click adds the range");
  },
};

test("explorer operation: keys, menu, selection, paste and target folder keep their promise", async () => {
  const m = await load("explorer-actions.ts");
  for (const check of Object.values(CHECKS)) check(m);
});

test("explorer operation: each sabotage fails its check", async (t) => {
  for (const k of copies) {
    assert.equal(k.places, 1, `sabotage "${k.name}" is stale: the spot occurs ${k.places}x in the source`);
    const m = await load(k.file);
    assert.throws(() => CHECKS[k.catches](m), `sabotage "${k.name}" went unnoticed by "${k.catches}"`);
  }
  t.diagnostic(`${copies.length} sabotages caught`);
});
