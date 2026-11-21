// The editor's git margin ("dirty diff" against the index, like VS Code Quick Diff):
//
// (1) The computation (lib/dirty-diff.ts), EXECUTED: blocks new/changed/deleted with their rows (deleted: the row above,
//     0 = before the first), a minimal row diff (two separate changes are two blocks, not one), the cap (above it ONE
//     block, too large => no margin), "reset" restores exactly the block (all blocks reset = HEAD, over random texts)
//     and touches only it, and the base from the answer of `git/diff { staged: false, content }` (the index; untracked,
//     in conflict, binary => no margin); what a view does for the base (an inactive one nothing) and the shared
//     inventory — plus the RACE of two views of the same file: the inactive one deleted the margin of the active one.
//     A symbolic link in the index and a type change in the working tree (`xy` Y = "T") get no margin, a file with "-"
//     in front goes as "./-…".
// (2) The sources: the extension (components/code/git-gutter.ts) computes via dirtyDiff/reset, "reset" changes the
//     buffer through the editor and does not save, the margin hangs with ONE line in the list of extensions of
//     CodePane, nothing for a file without a repo or a read-only buffer; it is computed 200 ms after the last key, the
//     markers stand ready in the state, the base is forgotten on closing and fetched again on staging.
//
// Every sabotage is a copy of the source with ONE changed place (exactly once present); the assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/dirty-diff.test.mjs
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

const SOURCE = read("src", "lib", "dirty-diff.ts");
const SABOTAGES = {
  "common beginning not added back": { old: "aOf: s.aOf + beginning, aTo: s.aTo + beginning, bOf: s.bOf + beginning, bTo: s.bTo + beginning", fresh: "aOf: s.aOf, aTo: s.aTo, bOf: s.bOf, bTo: s.bTo", catches: "blocks" },
  "empty text has one row": { old: "return n === \"\" ? [] : n.split(\"\\n\");", fresh: "return n.split(\"\\n\");", catches: "blocks" },
  "snake forgotten": { old: "      while (x < N && y < M && A[x] === B[y]) { x++; y++; }\n      V[offset + k] = x;", fresh: "      V[offset + k] = x;", catches: "minimal" },
  "chunks never separated": { old: "if (last && last.aTo === aI && last.bTo === bI)", fresh: "if (last)", catches: "minimal" },
  "no cap": { old: "if (found < 0) return [{ aOf: beginning, aTo: beginning + N, bOf: beginning, bTo: beginning + M }];", fresh: "if (found < 0) return [];", catches: "cap" },
  "too large still computes": { old: "if (a.length + b.length > SIZE_MAX) return null;", fresh: "", catches: "cap" },
  "deleted one row lower": { old: "if (s.bTo === s.bOf) return { kind: \"deleted\", from: s.bOf, until: s.bOf, old };", fresh: "if (s.bTo === s.bOf) return { kind: \"deleted\", from: s.bOf + 1, until: s.bOf + 1, old };", catches: "blocks" },
  "new without row count": { old: "return { kind: \"fresh\", from: s.bOf + 1, until: s.bTo, old: [] };", fresh: "return { kind: \"fresh\", from: s.bOf + 1, until: s.bOf + 1, old: [] };", catches: "blocks" },
  "reset at the wrong row": { old: "const start = block.kind === \"deleted\" ? block.from : block.from - 1;", fresh: "const start = block.kind === \"deleted\" ? block.from : block.from;", catches: "reset" },
  "reset replaces everything": { old: "return { from: p, to: text.length - s, insert: fresh.slice(p, fresh.length - s) };", fresh: "return { from: 0, to: text.length, insert: fresh };", catches: "reset" },
  "conflict gets a margin": { old: "if (!response || response.conflict) return null;", fresh: "if (!response) return null;", catches: "base" },
  "inactive deletes the margin": { old: "if (!o.active) return { kind: \"nothing\" };", fresh: "", catches: "race" },
  "against HEAD": { old: "staged: false, content: true } };", fresh: "staged: true as unknown as false, content: true } };", catches: "job" },
  "conflict is fetched": { old: "o.gitKind === \"untracked\" || o.gitKind === \"conflict\" ||", fresh: "o.gitKind === \"untracked\" ||", catches: "job" },
  "link gets a margin": { old: "if (v.kind === \"text\" && v.reference) return null;", fresh: "", catches: "base" },
  "type change is fetched": { old: " || o.xy?.[1] === \"T\")", fresh: ")", catches: "job" },
  "path with \"-\" raw": { old: "file: file.startsWith(\"-\") ? `./${file}` : file,", fresh: "file: file,", catches: "job" },
  "without pause": { old: "export const MARGIN_WAIT_MS = 200;", fresh: "export const MARGIN_WAIT_MS = 0;", catches: "job" },
  "reports every set": { old: "if (this.bases.has(key) && this.bases.get(key) === base) return;", fresh: "", catches: "race" },
  "never forgets": { old: "forget(key: string): void { if (this.bases.delete(key)) this.report(); }", fresh: "forget(key: string): void { }", catches: "race" },
};

// ── Compile: the source, its dependency lib/file-status.ts and one copy per sabotage, in ONE tsc run. ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-dirty-diff-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "file-status.ts"), read("src", "lib", "file-status.ts"));
fs.writeFileSync(path.join(src, "dirty-diff.ts"), SOURCE);
const copies = [];
for (const [name, s] of Object.entries(SABOTAGES)) {
  const file = `dirty-diff-sabotage-${copies.length}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, () => s.fresh));
  copies.push({ name, file, catches: s.catches, places: SOURCE.split(s.old).length - 1 });
}
try {
  execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((d) => path.join(src, d)), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "dirty-diff.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = await load("dirty-diff.ts");
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: await load(k.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const Z = (...rows) => rows.join("\n");
const short = (bl) => bl.map((b) => `${b.kind}:${b.from}-${b.until}${b.old.length ? `[${b.old.join("|")}]` : ""}`);
/** A generator without outside randomness (repeatable): linear congruence. */
const random = (seed) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const apply = (text, ae) => text.slice(0, ae.from) + ae.insert + text.slice(ae.to);

const CHECKS = {
  blocks(D) {
    const base = Z("a", "b", "c", "d", "e");
    assert.deepEqual(D.dirtyDiff(base, base), [], "equal: no block");
    assert.deepEqual(short(D.dirtyDiff(base, Z("a", "b", "X", "Y", "c", "d", "e"))), ["fresh:3-4"], "two new rows after b");
    assert.deepEqual(short(D.dirtyDiff(base, Z("a", "B", "c", "d", "e"))), ["changed:2-2[b]"]);
    assert.deepEqual(short(D.dirtyDiff(base, Z("a", "d", "e"))), ["deleted:1-1[b|c]"], "deleted below row 1");
    assert.deepEqual(short(D.dirtyDiff(base, Z("c", "d", "e"))), ["deleted:0-0[a|b]"], "deleted before the first row");
    assert.deepEqual(short(D.dirtyDiff(base, Z("a", "b", "c"))), ["deleted:3-3[d|e]"], "deleted at the end");
    assert.deepEqual(short(D.dirtyDiff("", Z("x", "y"))), ["fresh:1-2"], "an empty base (newly staged) has no rows: all new");
    assert.deepEqual(short(D.dirtyDiff("a", "")), ["deleted:0-0[a]"], "all deleted");
    assert.deepEqual(short(D.dirtyDiff(Z("a", ""), Z("a", "n", ""))), ["fresh:2-2"], "a row before the final line break");
    assert.deepEqual(short(D.dirtyDiff(Z("a", "b"), "a\r\nb")), [], "CRLF counts like LF");
  },
  minimal(D) {
    // Two changes far apart are two blocks, the middle stays untouched.
    const base = Z("1", "2", "3", "4", "5", "6", "7", "8");
    assert.deepEqual(short(D.dirtyDiff(base, Z("1", "X", "3", "4", "5", "6", "Y", "8"))), ["changed:2-2[2]", "changed:7-7[7]"]);
    assert.deepEqual(short(D.dirtyDiff(base, Z("1", "3", "4", "5", "6", "7", "fresh", "8"))), ["deleted:1-1[2]", "fresh:7-7"]);
    // A moved paragraph: deleted above, new below — not "everything changed".
    const st = D.rowsChunks(["a", "b", "c", "d"], ["b", "c", "d", "a"]);
    assert.deepEqual(st, [{ aOf: 0, aTo: 1, bOf: 0, bTo: 0 }, { aOf: 4, aTo: 4, bOf: 3, bTo: 4 }]);
    // Over random pairs: applied, the chunks give exactly b, and none is empty.
    const r = random(7);
    for (let n = 0; n < 200; n++) {
      const a = Array.from({ length: Math.floor(r() * 12) }, () => "abcde"[Math.floor(r() * 5)]);
      const b = Array.from({ length: Math.floor(r() * 12) }, () => "abcde"[Math.floor(r() * 5)]);
      const st2 = D.rowsChunks(a, b);
      let output = [], i = 0;
      for (const s of st2) { assert.ok(s.aTo > s.aOf || s.bTo > s.bOf, "an empty chunk"); output.push(...a.slice(i, s.aOf), ...b.slice(s.bOf, s.bTo)); i = s.aTo; }
      output.push(...a.slice(i));
      assert.deepEqual(output, b, `chunks do not give b: ${a.join("")} → ${b.join("")}`);
      // Minimal: the number of changed rows is at most that of an LCS diff.
      const lcs = (() => { const t = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0)); for (let x = a.length - 1; x >= 0; x--) for (let y = b.length - 1; y >= 0; y--) t[x][y] = a[x] === b[y] ? 1 + t[x + 1][y + 1] : Math.max(t[x + 1][y], t[x][y + 1]); return t[0][0]; })();
      const changed = st2.reduce((s, x) => s + (x.aTo - x.aOf) + (x.bTo - x.bOf), 0);
      assert.equal(changed, a.length + b.length - 2 * lcs, `not minimal: ${a.join("")} → ${b.join("")}`);
    }
  },
  cap(D) {
    const a = Array.from({ length: 40 }, (_, i) => `z${i}`);
    const b = a.map((z, i) => (i % 2 ? `${z}!` : z));
    assert.deepEqual(D.rowsChunks(a, b, 3), [{ aOf: 1, aTo: 40, bOf: 1, bTo: 40 }], "above the cap: the middle as ONE chunk");
    assert.equal(D.rowsChunks(a, b).length, 20, "below the cap: each change on its own");
    const large = "x\n".repeat(D.SIZE_MAX);
    assert.equal(D.dirtyDiff(large, `${large}y`), null, "too large: no margin");
  },
  reset(D) {
    const base = Z("a", "b", "c", "d", "e");
    const now = Z("a", "B", "c", "fresh", "e");
    const bl = D.dirtyDiff(base, now);
    assert.deepEqual(short(bl), ["changed:2-2[b]", "changed:4-4[d]"]);
    const ae = D.reset(now, bl[0]);
    assert.deepEqual(ae, { from: 2, to: 3, insert: "b" }, "only the block — the smallest change");
    assert.equal(apply(now, ae), Z("a", "b", "c", "fresh", "e"));
    const way = Z("a", "d", "e"), blw = D.dirtyDiff(base, way);
    assert.equal(apply(way, D.reset(way, blw[0])), base, "deleted rows come back in their place");
    assert.equal(apply("", D.reset("", D.dirtyDiff("a\nb", "")[0])), "a\nb", "all deleted comes back");
    const front = Z("c", "d", "e");
    assert.equal(apply(front, D.reset(front, D.dirtyDiff(base, front)[0])), base, "deleted before the first row");
    const fresh = Z("a", "b", "X", "c", "d", "e");
    assert.equal(apply(fresh, D.reset(fresh, D.dirtyDiff(base, fresh)[0])), base, "new rows drop out");
    // Over random texts: all blocks reset from back to front = HEAD.
    const r = random(11);
    for (let n = 0; n < 150; n++) {
      const z = () => Array.from({ length: Math.floor(r() * 9) }, () => "abcxy"[Math.floor(r() * 5)]).join("\n");
      const h = z(), j = z();
      let t = j;
      for (const b of [...D.dirtyDiff(h, j)].reverse()) t = apply(t, D.reset(t, b));
      assert.equal(t, h, `reset ≠ HEAD: ${JSON.stringify(h)} ← ${JSON.stringify(j)}`);
    }
  },
  base(D) {
    assert.equal(D.gitBaseFrom({ prior: { kind: "text", text: "a\r\nb" }, after: { kind: "workingTree" } }), "a\nb", "the index as text, normalised");
    assert.equal(D.gitBaseFrom({ prior: { kind: "missing" }, after: { kind: "workingTree" } }), null, "untracked (not in the index): no margin");
    assert.equal(D.gitBaseFrom({ prior: { kind: "text", text: "x", stage: 2 }, after: { kind: "workingTree" }, conflict: true }), null, "in conflict: no margin (like VS Code)");
    assert.equal(D.gitBaseFrom({ prior: { kind: "binary" }, after: { kind: "workingTree" } }), null);
    assert.equal(D.gitBaseFrom({ prior: { kind: "large" }, after: { kind: "workingTree" } }), null);
    assert.equal(D.gitBaseFrom(null), null);
    // A link (120000) — its "text" is the path it points to; "reset" would write it into the file.
    assert.equal(D.gitBaseFrom({ prior: { kind: "text", text: "target.txt", reference: true }, after: { kind: "workingTree" } }), null, "a link in the index: no margin");
  },
  job(D) {
    const A = (o) => D.baseJob({ active: true, key: "k", path: "src/a.ts", relRepo: "", gitKind: "modified", ...o });
    assert.deepEqual(A(), { kind: "fetch", key: "k", body: { repo: "", file: "src/a.ts", staged: false, content: true } }, "against the index (staged: false)");
    assert.equal(A({ relRepo: "src" }).body.file, "a.ts", "relative to the repo");
    assert.deepEqual(A({ active: false }), { kind: "nothing" }, "an inactive view does nothing");
    assert.deepEqual(A({ key: null }), { kind: "nothing" });
    for (const o of [{ gitKind: "untracked" }, { gitKind: "conflict" }, { relRepo: null }, { path: "/external/a.ts" }, { relRepo: "lib" }, { path: null }]) {
      assert.deepEqual(A(o), { kind: "no", key: "k" }, `no margin: ${JSON.stringify(o)}`);
    }
    // Type change in the working tree (a file in the index, a link on disk) — no margin; a staged one (X = "T") asks the index.
    for (const xy of [".T", "MT", "AT"]) assert.deepEqual(A({ xy }), { kind: "no", key: "k" }, `no margin for ${xy}`);
    for (const xy of ["MM", ".M", "T.", "", null]) assert.equal(A({ xy }).kind, "fetch", `fetched for ${JSON.stringify(xy)}`);
    // A file with "-" in front (in the repo root) goes as "./-…"; in the middle of a path it stays as it is.
    assert.equal(A({ path: "-x.ts" }).body.file, "./-x.ts");
    assert.equal(A({ path: "sub/-x.ts", relRepo: "sub" }).body.file, "./-x.ts", "relative to the repo, in front");
    assert.equal(A({ path: "a/-x.ts" }).body.file, "a/-x.ts");
    assert.equal(D.MARGIN_WAIT_MS, 200, "computed 200 ms after the last key (VS Code)");
  },
  race(D) {
    // Two views of the same file (Coding → Files and the chat): the active one fetches the base, then the effect of the
    // inactive one runs — the margin of the active one stays.
    const B = new D.BaseInventory();
    let notices = 0;
    B.listen(() => { notices++; });
    const effect = (active, response) => {
      const a = D.baseJob({ active, key: "k", path: "a.ts", relRepo: "", gitKind: "modified" });
      if (a.kind === "no") B.set(a.key, null);
      else if (a.kind === "fetch") B.set(a.key, D.gitBaseFrom(response));
    };
    effect(true, { prior: { kind: "text", text: "old" }, after: { kind: "workingTree" } });
    effect(false, null);
    assert.equal(B.from("k"), "old", "the inactive view deleted the margin of the active one");
    B.set("k", "old");
    assert.equal(notices, 1, "only a real change reports");
    B.set("[\"/api/p\",\"\",\"x/y.ts\"]", "1");
    B.forgetWhere((k) => k.includes("x/"));
    assert.equal(B.from("[\"/api/p\",\"\",\"x/y.ts\"]"), null, "a renamed folder takes its bases along");
    B.forget("k");
    assert.equal(B.size, 0, "forgotten when the buffer closes");
  },
};

test("(1) computation: blocks, minimal, cap, reset, base, job, race", () => {
  for (const [k, check] of Object.entries(CHECKS)) {
    try { check(real); } catch (e) { throw new Error(`${k}: ${e.message}`); }
  }
});

test("(1) counter-tests: every sabotage stands exactly once in the source and is caught by its check", () => {
  const stale = copies.filter((k) => k.places !== 1).map((k) => `${k.name} (${k.places}×)`);
  assert.deepEqual(stale, [], "sabotages whose place does not stand exactly once in the source");
  const notCaught = [];
  for (const s of sabotaged) {
    let caught = false;
    try { CHECKS[s.catches](s.mod); } catch { caught = true; }
    if (!caught) notCaught.push(`${s.name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "sabotages no check catches");
  console.log(`  [dirty-diff] ${sabotaged.length} sabotages, each caught`);
});

// ── (2) The sources ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const Q = { margin: read("src", "components", "code", "git-gutter.ts"), pane: read("src", "components", "CodePane.tsx") };
const SOURCE_CHECKS = {
  margin(q) {
    const r = withoutComments(q.margin);
    // The same file in two groups computes its margin once — remembered per base, valid only for EXACTLY the text it was
    // computed against.
    assert.ok(r.includes("const text = state.doc.toString(), old = COMPUTED.get(base);") && r.includes("const blocks = dirtyDiff(base, text) ?? [];"), "the margin does not compute via dirtyDiff");
    assert.ok(r.includes("if (old && old.text === text) return old.blocks;"), "the remembered margin also applies to a different text");
    assert.ok(r.includes("const ae = reset(view.state.doc.toString(), block);"), "reset does not compute via reset");
    assert.ok(r.includes("view.dispatch({ changes: ae, userEvent: \"input.gitRevert\" });"), "reset does not change the buffer through the editor");
    assert.ok(!/save\(/.test(r), "reset saves");
    assert.ok(r.includes("if (!p || p.readonly) return [];"), "a read-only buffer gets a margin");
    assert.ok(r.includes("if (tr.docChanged) return { ...v, markers: v.markers.map(tr.changes), open };"), "the margin computes per key");
    assert.ok(r.includes("}, MARGIN_WAIT_MS);"), "the margin computes without a pause");
    assert.ok(r.includes("markers: (view) => view.state.field(field).markers,"), "the markers are built per update");
    assert.ok(r.includes("atClose((p) => BASES.forget(p.key));"), "the base stays after closing");
    assert.ok(r.includes("const a = baseJob({ active, key, path, relRepo, gitKind, xy: gitState });") && r.includes("if (a.kind === \"nothing\") return;"), "the base bypasses the rule");
    assert.ok(r.includes("body: JSON.stringify(a.body)"), "the base is not against the index");
    // The colours of VS Code editorGutter.added/modified/deletedBackground (Dark Modern / Light Modern).
    for (const [rule, color] of [["&dark .cm-gitMargin-new", "#2ea043"], ["&light .cm-gitMargin-new", "#2ea043"], ["&dark .cm-gitMargin-changed", "#0078d4"], ["&light .cm-gitMargin-changed", "#005fb8"]]) {
      assert.ok(r.includes(`"${rule}": { backgroundColor: "${color}" }`), `${rule} not in the VS Code colour (${color})`);
    }
    assert.ok(r.includes("borderLeft: \"5px solid #f85149\""), "deleted not in the VS Code colour");
  },
  oneRow(q) {
    const c = withoutComments(q.pane);
    assert.equal((c.match(/gitMargin\(/g) ?? []).length, 1, "the margin does not hang with exactly one line in CodePane");
    assert.ok(c.includes("list.push(gitMargin(paLoaded, t), cursorReporter);"), "the margin is not in the list of extensions");
    assert.ok(c.includes("useGitBase({ calls, path: activePath, buffer: paLoaded,"), "CodePane does not fetch the base");
    assert.ok(c.includes("gitState: activePath ? gitXY[activePath] ?? \"\" : null, ") && c.includes("xy[key] = `${c.x ?? \"\"}${c.y ?? \"\"}`;"), "staging does not fetch the base again");
  },
};
const SOURCE_SABOTAGES = {
  "margin bypasses dirtyDiff": { file: "margin", old: "const blocks = dirtyDiff(base, text) ?? [];", fresh: "const blocks: DiffBlock[] = [];", catches: "margin" },
  "margin from old text": { file: "margin", old: "if (old && old.text === text) return old.blocks;", fresh: "if (old) return old.blocks;", catches: "margin" },
  "reset saves": { file: "margin", old: "view.dispatch({ changes: ae, userEvent: \"input.gitRevert\" });", fresh: "view.dispatch({ changes: ae, userEvent: \"input.gitRevert\" }); void p.save();", catches: "margin" },
  "margin also read-only": { file: "margin", old: "if (!p || p.readonly) return [];", fresh: "if (!p) return [];", catches: "margin" },
  "margin missing in CodePane": { file: "pane", old: "list.push(gitMargin(paLoaded, t), cursorReporter);", fresh: "list.push(cursorReporter);", catches: "oneRow" },
  "base without buffer": { file: "pane", old: "useGitBase({ calls, path: activePath, buffer: paLoaded,", fresh: "useGitBase({ calls, path: activePath, buffer: null,", catches: "oneRow" },
  "recompute per key": { file: "margin", old: "if (tr.docChanged) return { ...v, markers: v.markers.map(tr.changes), open };", fresh: "if (tr.docChanged) { const b2 = compute(base, tr.state); return { base, blocks: b2, markers: markersFrom(b2, tr.state.doc), open }; }", catches: "margin" },
  "markers per update": { file: "margin", old: "markers: (view) => view.state.field(field).markers,", fresh: "markers: (view) => markersFrom(view.state.field(field).blocks, view.state.doc),", catches: "margin" },
  "base stays after closing": { file: "margin", old: "atClose((p) => BASES.forget(p.key));", fresh: "", catches: "margin" },
  "base bypasses the rule": { file: "margin", old: "if (a.kind === \"nothing\") return;", fresh: "", catches: "margin" },
  "type change not asked": { file: "margin", old: "gitKind, xy: gitState });", fresh: "gitKind });", catches: "margin" },
  "added light in its own colour": { file: "margin", old: "\"&light .cm-gitMargin-new\": { backgroundColor: \"#2ea043\" }", fresh: "\"&light .cm-gitMargin-new\": { backgroundColor: \"#48985d\" }", catches: "margin" },
  "changed light like dark": { file: "margin", old: "\"&light .cm-gitMargin-changed\": { backgroundColor: \"#005fb8\" }", fresh: "\"&light .cm-gitMargin-changed\": { backgroundColor: \"#0078d4\" }", catches: "margin" },
  "staging does not refetch": { file: "pane", old: "gitState: activePath ? gitXY[activePath] ?? \"\" : null, ", fresh: "", catches: "oneRow" },
};

test("(2) sources: the margin computes via the computation, resets in the buffer, hangs with one line in CodePane", () => {
  for (const [name, check] of Object.entries(SOURCE_CHECKS)) {
    try { check(Q); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
});

test("(2) counter-tests on the sources: every sabotage stands exactly once and gets caught", () => {
  const stale = [], notCaught = [];
  for (const [name, s] of Object.entries(SOURCE_SABOTAGES)) {
    const n = Q[s.file].split(s.old).length - 1;
    if (n !== 1) { stale.push(`${name} (${n}×)`); continue; }
    let caught = false;
    try { SOURCE_CHECKS[s.catches]({ ...Q, [s.file]: Q[s.file].replace(s.old, () => s.fresh) }); } catch { caught = true; }
    if (!caught) notCaught.push(`${name} (${s.catches})`);
  }
  assert.deepEqual(stale, [], "sabotages whose place does not stand exactly once");
  assert.deepEqual(notCaught, [], "sabotages no check catches");
});
