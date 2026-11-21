// Names in the explorer as in VS Code, lib/explorer-names.ts, EXECUTED: the copy name after VS Code `incrementFileName` ("a.ts" ->
// "a copy.ts" -> "a copy 2.ts", a folder without extension, ".env" without extension), the validation of the field (errors keep it
// open, edge whitespace is only a warning, like VS Code `validateFileName`: "/" INSIDE the name is allowed - "a/b.ts" creates folders,
// `targetPath` - only a leading one is not; every part valid; tabs at the edge and a trailing "/" fall away, `wellFormed`), the
// preselection when renaming and the plan of a drop (drag, paste, duplicate: never into itself, when moving never over an occupied
// name, when copying the next free name). The drop plan reports an occupied name when moving WITH the target (the "Replace?"
// question), a folder above the source as "itself" and an unknown kind when copying as "unknown" (never silently a file).
// `importPlan` (VS Code `ExternalFileImport.importResources`) is the plan of a drop from the explorer of ANOTHER window: copied under
// its OWN name, an occupied name asks "Replace?" (no copy name), unknown = missing, a folder on the root asks beforehand, and what
// never works (target inside the source, replacing would delete the source's folder) carries its error.
// Each sabotage is a copy of the source with ONE changed spot; the assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/explorer-names.test.mjs
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
const SOURCE = fs.readFileSync(path.join(webDir, "src", "lib", "explorer-names.ts"), "utf8");

const SABOTAGES = {
  "copy does not count on": { old: "return `${m[1]} ${n + 1}${suffix}`;", fresh: "return `${stem} copy${suffix}`;", catches: "copy" },
  "folder with extension": { old: `const suffix = isFolder ? "" : suffixOf(name);`, fresh: "const suffix = suffixOf(name);", catches: "copy" },
  "dotfile has an extension": { old: `return i <= 0 ? "" : name.slice(i);`, fresh: `return i < 0 ? "" : name.slice(i);`, catches: "copy" },
  "free name without search": { old: "if (!occupied.has(n)) return n;", fresh: "return n;", catches: "copy" },
  "leading slash allowed": { old: `return { error: "slash", warning: null };`, fresh: "return { error: null, warning: null };", catches: "check" },
  "slash in the name forbidden (old rule)": { old: String.raw`if (name[0] === "/" || name[0] === "\\")`, fresh: String.raw`if (/[\\/]/.test(name))`, catches: "check" },
  "\".\" allowed": { old: `t !== "." && t !== ".."`, fresh: "true", catches: "check" },
  "only the whole name checked": { old: String.raw`const parts = name.split(/[\\/]/);`, fresh: "const parts = [name];", catches: "check" },
  "the old name counts as existing": { old: "if (name !== old && existing.includes(name))", fresh: "if (existing.includes(name))", catches: "check" },
  "no warning at the edge": { old: String.raw`if (parts.some((t) => /^\s|\s$/.test(t))) return { error: null, warning: "margin" };`, fresh: "", catches: "check" },
  "whitespace only is no error": { old: String.raw`if (!name || /^\s+$/.test(name))`, fresh: "if (!name)", catches: "check" },
  "trailing \"/\" stays": { old: String.raw`.replace(/\/+$/, "")`, fresh: "", catches: "check" },
  "\"\\\" does not separate": { old: String.raw`const name = wellFormed(raw).split(/[\\/]/).join("/");`, fresh: "const name = wellFormed(raw);", catches: "check" },
  "occupied without target": { old: "omitted.push({ from, reason: \"occupied\", to: target ? `${target}/${name}` : name });", fresh: "omitted.push({ from, reason: \"occupied\" });", catches: "deposit" },
  "unknown kind as file": { old: `if (type === null) { omitted.push({ from, reason: "unknown" }); continue; }`, fresh: "", catches: "deposit" },
  "replace deletes the source": { old: "if (occupied.has(name) && from.startsWith(`${target ? `${target}/` : \"\"}${name}/`))", fresh: "if (false)", catches: "deposit" },
  "selection with extension": { old: "return [0, name.length - suffix.length];", fresh: "return [0, name.length];", catches: "selection" },
  "into the own subfolder": { old: "if (target === from || target.startsWith(`${from}/`))", fresh: "if (target === from)", catches: "deposit" },
  "children not with the folder": { old: "return set.filter((p) => !set.some((q) => q !== p && p.startsWith(`${q}/`)));", fresh: "return set;", catches: "deposit" },
  "move into the same folder": { old: "if (parentOf(from) === target) {", fresh: `if (parentOf(from) === "\\u0000") {`, catches: "deposit" },
  "move over an occupied name": { old: "if (occupied.has(name)) { omitted.push", fresh: `if (occupied.has("\\u0000")) { omitted.push`, catches: "deposit" },
  "two copies of the same name": { old: "    occupied.add(name);\n", fresh: "", catches: "deposit" },
  "import with copy name": { old: "const to = target ? `${target}/${name}` : name;\n    const replace", fresh: "const to = target ? `${target}/${name} copy` : name;\n    const replace", catches: "import" },
  "import without replace question": { old: "const replace = occupied.has(name);", fresh: "const replace = false;", catches: "import" },
  "import unknown as file": { old: "const kind = kindOf(from);\n    if", fresh: "const kind = kindOf(from) ?? \"file\";\n    if", catches: "import" },
  "import into itself": { old: `const error = target === from || target.startsWith(\`\${from}/\`) ? "itself"`, fresh: `const error = target === from ? "itself"`, catches: "import" },
  "import replaces the source's folder": { old: `: replace && from.startsWith(\`\${to}/\`) ? "contained" : null;`, fresh: ": null;", catches: "import" },
  "folder on the root does not ask": { old: `folderAtRoot: target === "" && ops.some((o) => o.kind === "dir")`, fresh: "folderAtRoot: false", catches: "import" },
  "folder asks everywhere": { old: `folderAtRoot: target === "" && ops.some`, fresh: "folderAtRoot: ops.some", catches: "import" },
  "root with slash": { old: "ops.push({ from, to: target ? `${target}/${name}` : name });", fresh: "ops.push({ from, to: `${target}/${name}` });", catches: "deposit" },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-explorer-names-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "explorer-names.ts"), SOURCE);
const copies = Object.entries(SABOTAGES).map(([name, s], i) => {
  const file = `explorer-names-sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, s.fresh));
  return { name, file, catches: s.catches, places: SOURCE.split(s.old).length - 1 };
});
execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((f) => path.join(src, f)), "--outDir", out, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck"], { stdio: "pipe" });
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);

const FOLDER = new Set(["src", "a", "a/sub", "p", "q", "v1.2"]);
const FILES = new Set(["a/x.ts", "b/x.ts", "c/x.ts", "p/x.ts", "q/x.ts", "a.b"]);
const kindOf = (p) => (FOLDER.has(p) ? "dir" : FILES.has(p) ? "file" : null);

const CHECKS = {
  copy: (m) => {
    assert.equal(m.copyName("a.ts", false), "a copy.ts");
    assert.equal(m.copyName("a copy.ts", false), "a copy 2.ts");
    assert.equal(m.copyName("a copy 2.ts", false), "a copy 3.ts");
    assert.equal(m.copyName("archive.tar.gz", false), "archive.tar copy.gz", "only the last extension (like path.extname)");
    assert.equal(m.copyName("v1.2", true), "v1.2 copy", "a folder has no extension");
    assert.equal(m.copyName(".env", false), ".env copy", "a leading dot is no extension");
    assert.equal(m.freeCopyName("a.ts", false, ["a.ts", "a copy.ts", "a copy 2.ts"]), "a copy 3.ts");
    assert.equal(m.freeCopyName("a.ts", false, new Set(["a.ts"])), "a copy.ts");
  },
  check: (m) => {
    assert.deepEqual(m.checkName("", []), { error: "empty", warning: null });
    assert.deepEqual(m.checkName("   ", []), { error: "empty", warning: null });
    // VS Code `validateFileName`: "/" INSIDE the name creates folders - only a leading one is an error.
    assert.deepEqual(m.checkName("a/b.ts", []), { error: null, warning: null }, "\"a/b.ts\" is allowed");
    assert.deepEqual(m.checkName("a\\b.ts", []), { error: null, warning: null });
    assert.equal(m.checkName("/a", []).error, "slash");
    assert.equal(m.checkName("\\a", []).error, "slash");
    assert.equal(m.checkName(".", []).error, "invalid");
    assert.equal(m.checkName("..", []).error, "invalid");
    assert.equal(m.checkName("a/../b", []).error, "invalid", "every part is checked");
    assert.equal(m.checkName("a//b", []).error, "invalid", "an empty part");
    assert.equal(m.checkName("x.ts", ["x.ts", "y.ts"]).error, "existing");
    assert.deepEqual(m.checkName("x.ts", ["x.ts", "y.ts"], "x.ts"), { error: null, warning: null }, "the own old name is not \"already existing\"");
    assert.deepEqual(m.checkName(" x.ts", []), { error: null, warning: "margin" }, "edge whitespace is a warning, not an error");
    assert.deepEqual(m.checkName("a /b.ts", []), { error: null, warning: "margin" }, "also at the edge of a part");
    assert.deepEqual(m.checkName("x.ts/", ["y"]), { error: null, warning: null }, "trailing \"/\" falls away (well-formed)");
    assert.equal(m.checkName("x.ts/", ["x.ts"]).error, "existing", "the well-formed name is checked");
    assert.deepEqual(m.checkName("x.ts", []), { error: null, warning: null });
    assert.equal(m.wellFormed("\tx.ts\t"), "x.ts");
    assert.equal(m.targetPath("src", "a/b.ts"), "src/a/b.ts");
    assert.equal(m.targetPath("", "a\\b.ts/"), "a/b.ts", "\"\\\" separates like \"/\", at the end it falls away");
  },
  selection: (m) => {
    assert.deepEqual(m.nameSelection("Chat.test.ts", false), [0, 9], "without the last extension");
    assert.deepEqual(m.nameSelection(".env", false), [0, 4]);
    assert.deepEqual(m.nameSelection("src.v2", true), [0, 6], "a folder whole");
  },
  deposit: (m) => {
    const plan = (q, z, kind, v = []) => m.depositPlan(q, z, kind, v, kindOf);
    assert.deepEqual(plan(["a/x.ts", "a", "a/sub"], "b", "move"), { ops: [{ from: "a", to: "b/a" }], omitted: [] }, "only the topmost paths");
    assert.deepEqual(plan(["a"], "a/sub", "move").omitted, [{ from: "a", reason: "itself" }]);
    assert.deepEqual(plan(["a"], "a", "copy").omitted, [{ from: "a", reason: "itself" }]);
    assert.deepEqual(plan(["a"], "a/sub", "copy").omitted, [{ from: "a", reason: "itself" }], "never into itself even when copied");
    assert.deepEqual(plan(["b/x.ts"], "b", "move", ["x.ts"]).omitted, [{ from: "b/x.ts", reason: "same-folder" }]);
    assert.deepEqual(plan(["c/x.ts"], "b", "move", ["x.ts"]), { ops: [], omitted: [{ from: "c/x.ts", reason: "occupied", to: "b/x.ts" }] }, "moving never overwrites silently - it asks (with target)");
    assert.deepEqual(plan(["a/a"], "", "move", ["a"]), { ops: [], omitted: [{ from: "a/a", reason: "itself" }] }, "\"Replace\" of a folder above the source would delete the source too");
    assert.deepEqual(plan(["a.b"], "", "copy", ["a.b"]).ops, [{ from: "a.b", to: "a copy.b" }], "a file");
    assert.deepEqual(plan(["new.b"], "", "copy", ["new.b"]), { ops: [], omitted: [{ from: "new.b", reason: "unknown" }] }, "unknown kind: never silently as a file");
    assert.deepEqual(plan(["new.b"], "x", "move").ops, [{ from: "new.b", to: "x/new.b" }], "moving does not need the kind");
    assert.deepEqual(plan(["c/x.ts"], "", "move").ops, [{ from: "c/x.ts", to: "x.ts" }], "into the root without slash");
    assert.deepEqual(plan(["b/x.ts"], "b", "copy", ["x.ts"]).ops, [{ from: "b/x.ts", to: "b/x copy.ts" }], "duplicate in place");
    assert.deepEqual(plan(["p/x.ts", "q/x.ts"], "r", "copy").ops, [{ from: "p/x.ts", to: "r/x.ts" }, { from: "q/x.ts", to: "r/x copy.ts" }], "two sources of the same name");
    assert.deepEqual(plan(["src"], "", "copy", ["src", "src copy"]).ops, [{ from: "src", to: "src copy 2" }], "a folder without extension");
  },
  import: (m) => {
    const imp = (q, z, v = []) => m.importPlan(q, z, v, kindOf);
    const op = (from, to, kind, replace = false, error = null) => ({ from, to, kind, replace, error });
    assert.deepEqual(imp(["c/x.ts"], "b"), { ops: [op("c/x.ts", "b/x.ts", "file")], missing: [], folderAtRoot: false }, "under the own name");
    assert.deepEqual(imp(["c/x.ts"], "b", ["x.ts"]).ops, [op("c/x.ts", "b/x.ts", "file", true)], "occupied: replace question, no copy name (VS Code `confirmOverwrite`)");
    assert.deepEqual(imp(["b/x.ts"], "b", ["x.ts"]).ops, [op("b/x.ts", "b/x.ts", "file", true)], "onto the own folder: asks, then nothing to do");
    assert.deepEqual(imp(["new.b", "a.b"], "x"), { ops: [op("a.b", "x/a.b", "file")], missing: ["new.b"], folderAtRoot: false }, "unknown is missing (VS Code `fileService.exists`)");
    assert.deepEqual(imp(["a"], "a/sub").ops, [op("a", "a/sub/a", "dir", false, "itself")], "into the own subfolder: error");
    assert.deepEqual(m.importPlan(["a/a"], "", ["a"], (p) => (p === "a/a" ? "file" : kindOf(p))).ops, [op("a/a", "a", "file", true, "contained")], "replacing would delete the source's folder");
    assert.deepEqual(imp(["a/sub"], "", ["a"]).ops, [op("a/sub", "sub", "dir")], "a subfolder onto the root");
    assert.equal(imp(["a/sub"], "").folderAtRoot, true, "a folder on the root asks beforehand (VS Code `doImport`, `target.isRoot`)");
    assert.equal(imp(["a/sub"], "b").folderAtRoot, false, "only on the root");
    assert.equal(imp(["a/x.ts"], "").folderAtRoot, false, "only for folders");
    assert.deepEqual(imp(["a", "a/x.ts"], "b").ops, [op("a", "b/a", "dir")], "only the topmost paths");
  },
};

test("explorer names: copy name, validation, preselection and drop plan keep their promise", async () => {
  const m = await load("explorer-names.ts");
  for (const check of Object.values(CHECKS)) check(m);
});

test("explorer names: each sabotage fails its check", async (t) => {
  for (const k of copies) {
    assert.equal(k.places, 1, `sabotage "${k.name}" is stale: the spot occurs ${k.places}x in the source`);
    const m = await load(k.file);
    assert.throws(() => CHECKS[k.catches](m), `sabotage "${k.name}" went unnoticed by "${k.catches}"`);
  }
  t.diagnostic(`${copies.length} sabotages caught`);
});
