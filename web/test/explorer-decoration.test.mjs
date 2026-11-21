// The decoration of an explorer row as in VS Code, lib/explorer-decoration.ts, EXECUTED: the git state per path (also in nested
// repos, unknown kinds fall away), the rank of a folder (conflict > modified > deleted > renamed > new > untracked), "ignored"
// from `GET .../git/ignored` (a folder applies to everything below it; the innermost repo judges, the root of a nested one is judged
// by the one above; an unread one does not judge), problems (errors AND warnings counted, the heavier colors, from ten "9+", hints do
// not count, a folder stays red) and the precedence problem > git > ignored. Also: every color is a CSS variable that app/globals.css
// sets light AND dark. Each sabotage is a copy of the source with ONE changed spot; the assigned check must fail on it.
// As in VS Code: untracked has its OWN color, every value light and dark equals the git extension's defaults (`gitDecoration.*`)
// and `list.error/warningForeground` (VS_CODE below); deleted colors no folder (`propagate: false`); a link carries the arrow
// character (`ExplorerDecorationsProvider`).
//
// Run:  node --test --test-reporter=tap web/test/explorer-decoration.test.mjs
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
const SOURCE = fs.readFileSync(path.join(webDir, "src", "lib", "explorer-decoration.ts"), "utf8");
const CSS = fs.readFileSync(path.join(webDir, "src", "app", "globals.css"), "utf8");

const SABOTAGES = {
  "unknown kind counts": { old: "if (!(GIT_KINDS as readonly string[]).includes(c.kind)) continue;", fresh: "", catches: "git" },
  "nested repo without prefix": { old: "m.set(r.relPath ? `${r.relPath}/${c.path}` : c.path, c.kind as GitKind);", fresh: "m.set(c.path, c.kind as GitKind);", catches: "git" },
  "the folder takes the last kind": { old: "if (!soFar || GIT_RANG[kind] > GIT_RANG[soFar]) m.set(d, kind);", fresh: "m.set(d, kind);", catches: "git" },
  "the outer repo judges": { old: ".sort((a, b) => b.rel.length - a.rel.length)", fresh: ".sort((a, b) => a.rel.length - b.rel.length)", catches: "ignored" },
  "an ignored folder does not apply below it": { old: "for (const a of ancestors(path)) if (a.length > r.rel.length && r.folder.has(a)) return true;", fresh: "", catches: "ignored" },
  "the folder mark falls away": { old: `if (full.endsWith("/")) folder.add(full.slice(0, -1)); else files.add(full);`, fresh: "files.add(full);", catches: "ignored" },
  "the root of an inner repo judges itself": { old: "path.startsWith(`${x.rel}/`)))", fresh: "path === x.rel || path.startsWith(`${x.rel}/`)))", catches: "ignored" },
  "hints count": { old: `if (p.severity !== "error" && p.severity !== "warning") continue;`, fresh: "", catches: "problems" },
  "a warning overrides the red folder": { old: `if (folder.get(d) !== "error") folder.set(d, kind);`, fresh: "folder.set(d, kind);", catches: "problems" },
  "only the errors counted": { old: "const count = z ? z.error + z.warnings : 0;", fresh: "const count = z ? (z.error || z.warnings) : 0;", catches: "files" },
  "no \"9+\"": { old: `(count < 10 ? String(count) : "9+")`, fresh: "String(count)", catches: "files" },
  "git before problem": { old: "const color = probColor ?? (git ? GIT_COLOR[git] : dimmed ? IGNORED_COLOR : null);", fresh: "const color = (git ? GIT_COLOR[git] : null) ?? probColor ?? (dimmed ? IGNORED_COLOR : null);", catches: "files" },
  "ignored before git": { old: "const color = probColor ?? (git ? GIT_COLOR[git] : dimmed ? IGNORED_COLOR : null);", fresh: "const color = probColor ?? (dimmed ? IGNORED_COLOR : git ? GIT_COLOR[git] : null);", catches: "files" },
  "deleted not struck through": { old: `through: git === "deleted"`, fresh: "through: false", catches: "files" },
  "letter before the number": { old: `.filter(Boolean);\n  return { color, character: parts.length ? parts.join(", ") : null`, fresh: `.filter(Boolean).reverse();\n  return { color, character: parts.length ? parts.join(", ") : null`, catches: "files" },
  "folder without dot": { old: "point: !reference && Boolean(prob || git)", fresh: "point: false", catches: "folder" },
  "folder: git before problem": { old: "const color = prob ? PROBLEM_COLOR[prob] : git ? GIT_COLOR[git] : dimmed ? IGNORED_COLOR : null;", fresh: "const color = git ? GIT_COLOR[git] : prob ? PROBLEM_COLOR[prob] : dimmed ? IGNORED_COLOR : null;", catches: "folder" },
  "a color without variable in globals.css": { old: `  untracked: "var(--git-untracked)",\n`, fresh: `  untracked: "var(--git-unknown)",\n`, catches: "css" },
  "untracked like new": { old: `  untracked: "var(--git-untracked)",\n`, fresh: `  untracked: "var(--git-new)",\n`, catches: "css" },
  "deleted colors the folder": { old: "deleted: false", fresh: "deleted: true", catches: "git" },
  "link without character": { old: "const reference = o.symlink ? REFERENCE_CHARACTER : null;", fresh: "const reference = null;", catches: "reference" },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-explorer-decoration-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "explorer-decoration.ts"), SOURCE);
const copies = Object.entries(SABOTAGES).map(([name, s], i) => {
  const file = `explorer-decoration-sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, s.fresh));
  return { name, file, catches: s.catches, places: SOURCE.split(s.old).length - 1 };
});
execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((f) => path.join(src, f)), "--outDir", out, "--module", "es2022", "--target", "es2022", "--strict", "--skipLibCheck"], { stdio: "pipe" });
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);

const REPOS = [
  { relPath: "", changes: [{ path: "a/b/z.ts", kind: "conflict" }, { path: "a/b/x.ts", kind: "modified" }, { path: "a/y.ts", kind: "added" }, { path: "n.ts", kind: "untracked" }, { path: "t.ts", kind: "typechange" }, { path: "gone/old.ts", kind: "deleted" }] },
  { relPath: "sub", changes: [{ path: "way.ts", kind: "deleted" }, { path: "m.ts", kind: "modified" }] },
];
const IGNORED = [
  { relPath: "", ignored: ["node_modules/", ".env", "logs/a.log", "vendored/"] },
  { relPath: "sub", ignored: ["build/", "x.tmp"] },
  { relPath: "vendored", ignored: [] },
  { relPath: "k", ignored: null },
];
const PROBLEMS = [
  { file: "src/a.ts", severity: "error" }, { file: "src/a.ts", severity: "warning" }, { file: "src/b.ts", severity: "warning" },
  { file: "lib/c.ts", severity: "warning" }, { file: "lib/c.ts", severity: "info" },
  ...Array.from({ length: 12 }, () => ({ file: "much.ts", severity: "warning" })),
];

/** The values of VS Code (git extension `gitDecoration.*`, Dark/Light Modern `list.errorForeground`/`list.warningForeground`). */
const VS_CODE = {
  dark: { "--git-changed": "#e2c08d", "--git-new": "#81b88b", "--git-untracked": "#73c991", "--git-deleted": "#c74e39", "--git-renamed": "#73c991",
    "--git-conflict": "#e4676b", "--git-ignored": "#8c8c8c", "--problem-error": "#f88070", "--problem-warning": "#cca700" },
  light: { "--git-changed": "#895503", "--git-new": "#587c0c", "--git-untracked": "#007100", "--git-deleted": "#ad0707", "--git-renamed": "#007100",
    "--git-conflict": "#ad0707", "--git-ignored": "#8e8e90", "--problem-error": "#b01011", "--problem-warning": "#855f00" },
};

/** Every variable `var(--x)` of the table: once in `:root { ... }` (dark, the default) and once in `:root:not([data-theme="dark"]) { ... }`,
 *  with the value from VS Code. */
function cssVariables(m, css = CSS) {
  const names = new Set([...Object.values(m.GIT_COLOR), ...Object.values(m.PROBLEM_COLOR), m.IGNORED_COLOR].map((v) => /^var\((--[\w-]+)\)$/.exec(v)?.[1]));
  assert.ok(!names.has(undefined), "every decoration color is a CSS variable");
  const blocks = (sel) => [...css.matchAll(new RegExp(`^${sel.replace(/[()[\]:"=]/g, "\\$&")} \\{([^}]*)\\}`, "gm"))].map((x) => x[1]).join("\n");
  const dark = blocks(":root"), light = blocks(':root:not([data-theme="dark"])');
  for (const n of names) {
    assert.ok(new RegExp(`^\\s*${n}: #[0-9a-f]{6};$`, "m").test(dark), `${n} is missing dark in app/globals.css`);
    assert.ok(new RegExp(`^\\s*${n}: #[0-9a-f]{6};$`, "m").test(light), `${n} is missing light in app/globals.css`);
    assert.ok(VS_CODE.dark[n] && VS_CODE.light[n], `${n}: no VS Code value known (add it to VS_CODE)`);
    assert.equal(new RegExp(`^\\s*${n}: (#[0-9a-f]{6});$`, "m").exec(dark)[1], VS_CODE.dark[n], `${n} dark differs from VS Code`);
    assert.equal(new RegExp(`^\\s*${n}: (#[0-9a-f]{6});$`, "m").exec(light)[1], VS_CODE.light[n], `${n} light differs from VS Code`);
  }
  return names.size;
}

const CHECKS = {
  git: (m) => {
    const g = m.gitCard(REPOS);
    assert.deepEqual([...g.keys()].sort(), ["a/b/x.ts", "a/b/z.ts", "a/y.ts", "gone/old.ts", "n.ts", "sub/m.ts", "sub/way.ts"], "unknown kinds fall away, nested repos with prefix");
    const o = m.folderCard(g);
    assert.equal(o.get("a"), "conflict", "the strongest state below");
    assert.equal(o.get("a/b"), "conflict");
    assert.equal(o.get("sub"), "modified", "modified before deleted");
    assert.equal(o.has("n.ts"), false);
    assert.equal(o.has("gone"), false, "deleted colors no folder (VS Code propagate: false)");
  },
  reference: (m) => {
    const k = m.cards(REPOS, IGNORED, []);
    assert.equal(m.decoration("l.ts", "file", k, { symlink: true }).character, m.REFERENCE_CHARACTER);
    assert.equal(m.REFERENCE_CHARACTER, "\u2937", "arrow like VS Code");
    assert.equal(m.decoration("a/y.ts", "file", k, { symlink: true }).character, "A, \u2937", "next to the git letter");
    assert.deepEqual(m.decoration("ldir", "dir", k, { symlink: true }), { color: null, character: "\u2937", point: false, dimmed: false, through: false });
    assert.equal(m.decoration("l.ts", "file", k).character, null, "nothing without a link");
  },
  ignored: (m) => {
    const ig = m.ignoredChecker(IGNORED);
    const yes = ["node_modules", "node_modules/react/index.js", ".env", "logs/a.log", "sub/build", "sub/build/o.js", "sub/x.tmp", "vendored"];
    const no = ["", "logs", "src/a.ts", "sub", "sub/src.ts", "vendored/a.js", "k/x.ts"];
    for (const p of yes) assert.equal(ig(p), true, `${p} is ignored`);
    for (const p of no) assert.equal(ig(p), false, `${p} is not ignored`);
    assert.equal(m.ignoredChecker(null)("x"), false);
  },
  problems: (m) => {
    const p = m.problemCard(PROBLEMS);
    assert.deepEqual(p.files.get("src/a.ts"), { error: 1, warnings: 1 });
    assert.deepEqual(p.files.get("lib/c.ts"), { error: 0, warnings: 1 }, "hints do not count");
    assert.equal(p.folder.get("src"), "error", "a warning afterwards does not recolor the red folder");
    assert.equal(p.folder.get("lib"), "warning");
  },
  files: (m) => {
    const k = m.cards(REPOS, IGNORED, [...PROBLEMS, { file: "a/b/x.ts", severity: "error" }, { file: "a/b/x.ts", severity: "warning" }]);
    const deco = (p) => m.decoration(p, "file", k);
    assert.deepEqual(deco("a/b/x.ts"), { color: m.PROBLEM_COLOR.error, character: "2, M", point: false, dimmed: false, through: false }, "problem before git, number before letter");
    assert.deepEqual(deco("src/b.ts"), { color: m.PROBLEM_COLOR.warning, character: "1", point: false, dimmed: false, through: false });
    assert.equal(deco("much.ts").character, "9+");
    assert.deepEqual(deco("sub/way.ts"), { color: m.GIT_COLOR.deleted, character: "D", point: false, dimmed: false, through: true });
    assert.deepEqual(deco(".env"), { color: m.IGNORED_COLOR, character: null, point: false, dimmed: true, through: false });
    const k2 = m.cards([{ relPath: "", changes: [{ path: "node_modules/x.js", kind: "modified" }] }], IGNORED, []);
    assert.equal(m.decoration("node_modules/x.js", "file", k2).color, m.GIT_COLOR.modified, "git before ignored");
  },
  folder: (m) => {
    const k = m.cards(REPOS, IGNORED, [{ file: "a/b/x.ts", severity: "error" }]);
    assert.deepEqual(m.decoration("a/b", "dir", k), { color: m.PROBLEM_COLOR.error, character: null, point: true, dimmed: false, through: false });
    assert.deepEqual(m.decoration("sub", "dir", k), { color: m.GIT_COLOR.modified, character: null, point: true, dimmed: false, through: false });
    assert.deepEqual(m.decoration("node_modules", "dir", k), { color: m.IGNORED_COLOR, character: null, point: false, dimmed: true, through: false });
    assert.deepEqual(m.decoration("empty", "dir", k), { color: null, character: null, point: false, dimmed: false, through: false });
  },
  css: (m) => {
    cssVariables(m);
    assert.notEqual(m.GIT_COLOR.untracked, m.GIT_COLOR.added, "untracked has its own color (VS Code: dark #73c991 vs #81b88b)");
  },
};

test("explorer decoration: git, ignored, problems and precedence keep their promise; every color set light and dark", async (t) => {
  const m = await load("explorer-decoration.ts");
  for (const check of Object.values(CHECKS)) check(m);
  t.diagnostic(`${cssVariables(m)} CSS variables set light and dark`);
});

test("explorer decoration: each sabotage fails its check", async (t) => {
  for (const k of copies) {
    assert.equal(k.places, 1, `sabotage "${k.name}" is stale: the spot occurs ${k.places}x in the source`);
    const m = await load(k.file);
    assert.throws(() => CHECKS[k.catches](m), `sabotage "${k.name}" went unnoticed by "${k.catches}"`);
  }
  // Counter-test of the CSS side: a variable set only dark is red.
  const m = await load("explorer-decoration.ts");
  const lightWithout = CSS.replace(/(:root:not\(\[data-theme="dark"\]\) \{\n  --git-changed: #[0-9a-f]{6};\n)/, ':root:not([data-theme="dark"]) {\n');
  assert.notEqual(lightWithout, CSS, "CSS counter-test is stale");
  assert.throws(() => cssVariables(m, lightWithout), "a variable set only dark went unnoticed");
  // And a value that is not VS Code's (new dark like untracked).
  const newWrong = CSS.replace(":root {\n  --git-changed: #e2c08d;\n  --git-new: #81b88b;\n", ":root {\n  --git-changed: #e2c08d;\n  --git-new: #73c991;\n");
  assert.notEqual(newWrong, CSS, "CSS value counter-test is stale");
  assert.throws(() => cssVariables(m, newWrong), "a value differing from VS Code went unnoticed");
  t.diagnostic(`${copies.length} sabotages caught`);
});
