// The quick-diff peek in the git gutter as in VS Code 1.143:
//
// (1) The computations (lib/quick-diff.ts), EXECUTED against the semantics of VS Code (quickDiffModel.ts, quickDiffWidget.ts, read from
//     the 1.143 bundle): the blocks of the gutter as `IChange` (index lines from the offset, over random texts: the changes rebuild the
//     text from the index), kind/end line/height/hit, Alt+F3/Shift+Alt+F3 and the click (inclusive, round-robin, canNavigate, a click
//     on the open one closes), the list switch with an open peek (sortedDiff with merged neighbors; a difference at or before the open
//     one ⇒ to the next, none left ⇒ close), the dimensions (height, arrow, header, body, handle), view and cursor after the action,
//     the title — and STAGING: the body of `POST …/git/stage-block` BOUND to the server (server/backend/electron/server/git.js
//     `stageBlockBody`/`blockInIndex`, the same code as the route): over random index texts with LF, CR LF, CR and with/without a
//     final line break the server accepts every body, writes exactly the new base of the client (normalized) and leaves the line
//     endings of the other lines alone; staged one after another, the whole buffer ends up in the index. Also the checksum of the base
//     (`baseSha`, lib/sha256.ts against node:crypto and against the server `indexChecksum`) and `findAgain` (the SHOWN change, not the
//     number).
// (2) The sources: the gutter calls the route with repo, file and the line ending of the buffer, then takes over base and git tree, the
//     click runs via mouse down/up and `clickTarget`, the list via `afterListSwitch` (not with focus in the peek); Alt+F3/Shift+Alt+F3
//     are in the command table as `editor.action.dirtydiff.next/previous`; the peek carries the actions in the order and with the
//     glyphs of VS Code, the Dark/Light Modern colors, Esc/Shift+Esc; CodePane passes the git tree through; every text has its English
//     entry. Staging and reverting hit the shown change and close afterwards (as in VS Code), the base is fetched anew after staging
//     and after a failure, a running stage switches the button off, the location goes with its view, FILTER/INDEX_CHANGED have a
//     wording of their own, the old texts of the click peek are gone.
//
// Each sabotage is a copy of the source with ONE changed spot (exactly once there); the assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/quick-diff.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");
// The server (git.js) — the same functions that `POST …/git/stage-block` runs.
const G = await import(pathToFileURL(path.resolve(webDir, "..", "server", "backend", "electron", "server", "git.js")).href);

const SOURCE = read("src", "lib", "quick-diff.ts");
const SABOTAGES = {
  "fresh without a line before": { old: "if (b.kind === \"fresh\") return { originalStart: beforeIndex, originalEnd: 0,", fresh: "if (b.kind === \"fresh\") return { originalStart: beforeIndex + 1, originalEnd: 0,", catches: "form" },
  "offset forgotten": { old: "offset += nowCount - b.old.length;", fresh: "", catches: "form" },
  "deletion before line 1 under line 0": { old: "(a.modifiedStart === 0 ? 1 : a.modifiedStart)", fresh: "a.modifiedStart", catches: "form" },
  "height one side only": { old: "return now + index;", fresh: "return now;", catches: "form" },
  "next not inclusive": { old: "endRow(a) >= row", fresh: "endRow(a) > row", catches: "target" },
  "previous without round-robin": { old: "return list.length - 1;", fresh: "return 0;", catches: "target" },
  "canNavigate missing": { old: "if (o.row === undefined && o.open !== null && n <= 1) return null;", fresh: "", catches: "target" },
  "open not round-robin": { old: "return roundRobin((o.open < n ? o.open : -1) + o.direction, n);", fresh: "return o.open;", catches: "target" },
  "click on the open one reopens": { old: "if (i === open) return { kind: \"close\" };", fresh: "", catches: "target" },
  "list switch never jumps": { old: "if (beginnings.some((s) => s <= open))", fresh: "if (beginnings.some((s) => s < open))", catches: "list" },
  "list switch does not close": { old: "if (!after.length) return { kind: \"close\" };", fresh: "", catches: "list" },
  "neighbors not merged": { old: "if (beginnings.length && end === start) { end += count; return; }", fresh: "", catches: "list" },
  "height without third cap": { old: "Math.floor(editorRows / 3)", fresh: "editorRows", catches: "dimensions" },
  "arrow rounded down": { old: "const arrow = Math.round(lh / 3)", fresh: "const arrow = Math.floor(lh / 3)", catches: "dimensions" },
  "header rounded down": { old: "const header = Math.ceil(lh * 1.2);", fresh: "const header = Math.floor(lh * 1.2);", catches: "dimensions" },
  "handle without limits": { old: "return fresh > 5 && fresh < 35 ? fresh : null;", fresh: "return fresh;", catches: "dimensions" },
  "view of the deletion without following line": { old: "if (a.modifiedEnd === 0) return { from: a.modifiedStart, until: a.modifiedStart + 1 };", fresh: "if (a.modifiedEnd === 0) return { from: a.modifiedStart, until: a.modifiedStart };", catches: "view" },
  "cursor on the start instead of one lower": { old: "Math.min(a.modifiedStart + 1, rows)", fresh: "Math.min(a.modifiedStart, rows)", catches: "view" },
  "title always plural": { old: "(count > 1 ?", fresh: "(count > 0 ?", catches: "view" },
  "staging with the lines of the index": { old: "nowRows.slice(a.modifiedStart - 1, a.modifiedEnd)", fresh: "indexRows.slice(a.modifiedStart - 1, a.modifiedEnd)", catches: "stage" },
  "staging one line too high": { old: "const from = a.originalEnd === 0 ? a.originalStart : a.originalStart - 1;", fresh: "const from = a.originalStart - 1 < 0 ? 0 : a.originalStart - 1;", catches: "stage" },
  "row count without empty last line": { old: "rowCount: indexRows.length,", fresh: "rowCount: indexRows.filter(Boolean).length,", catches: "binding" },
  "line ending fixed LF": { old: "lineEnding, baseSha }, newBase };", fresh: "lineEnding: \"\\n\" as const, baseSha }, newBase };", catches: "binding" },
  "without checksum": { old: "const baseSha = sha256Hex(norm(base));", fresh: "const baseSha = \"\";", catches: "binding" },
  "checksum of the new base": { old: "sha256Hex(norm(base))", fresh: "sha256Hex(norm(newBase))", catches: "binding" },
  "find again via the buffer": { old: "a.originalStart === shown.originalStart && a.originalEnd === shown.originalEnd", fresh: "a.modifiedStart === shown.modifiedStart && a.modifiedEnd === shown.modifiedEnd", catches: "again" },
  "find again only at the start": { old: " && a.originalEnd === shown.originalEnd", fresh: "", catches: "again" },
  "new base without the block": { old: "const newBase = [...indexRows.slice(0, from), ...rows, ...indexRows.slice(until)].join(\"\\n\");", fresh: "const newBase = base;", catches: "binding" },
};

// SHA-256 of the base — a computation of its own (crypto.subtle is asynchronous and needs a secure context), hence against node:crypto.
const SHA_SOURCE = read("src", "lib", "sha256.ts");
const SHA_SABOTAGES = {
  "length in bytes instead of bits": { old: "const bits = data.length * 8;", fresh: "const bits = data.length;" },
  "without padding bit": { old: "m[data.length] = 0x80;", fresh: "" },
  "characters instead of UTF-8": { old: "new TextEncoder().encode(text)", fresh: "Uint8Array.from(text, (c) => c.charCodeAt(0) & 255)" },
  "one round too few": { old: "for (let i = 0; i < 64; i++) {\n      const t1", fresh: "for (let i = 0; i < 63; i++) {\n      const t1" },
  "block boundary wrong": { old: "const length = (((data.length + 9 + 63) >> 6) << 6);", fresh: "const length = (((data.length + 8 + 63) >> 6) << 6);" },
};

// ── Compile: the computation, its dependencies and one copy per sabotage, in ONE tsc run. ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-quick-diff-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "file-status.ts"), read("src", "lib", "file-status.ts"));
fs.writeFileSync(path.join(src, "dirty-diff.ts"), read("src", "lib", "dirty-diff.ts"));
fs.writeFileSync(path.join(src, "sha256.ts"), SHA_SOURCE);
fs.writeFileSync(path.join(src, "quick-diff.ts"), SOURCE);
const copies = [];
const shaCopies = [];
for (const [name, s] of Object.entries(SHA_SABOTAGES)) {
  const file = `sha256-sabotage-${shaCopies.length}.ts`;
  fs.writeFileSync(path.join(src, file), SHA_SOURCE.replace(s.old, () => s.fresh));
  shaCopies.push({ name, file, places: SHA_SOURCE.split(s.old).length - 1 });
}
for (const [name, s] of Object.entries(SABOTAGES)) {
  const file = `quick-diff-sabotage-${copies.length}.ts`;
  fs.writeFileSync(path.join(src, file), SOURCE.replace(s.old, () => s.fresh));
  copies.push({ name, file, catches: s.catches, places: SOURCE.split(s.old).length - 1 });
}
try {
  execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((d) => path.join(src, d)), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "quick-diff.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const D = await load("dirty-diff.ts");
const real = await load("quick-diff.ts");
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: await load(k.file) })));
const SHA = await load("sha256.ts");
const shaSabotaged = await Promise.all(shaCopies.map(async (k) => ({ ...k, mod: await load(k.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const Z = (...rows) => rows.join("\n");
const A = (originalStart, originalEnd, modifiedStart, modifiedEnd) => ({ originalStart, originalEnd, modifiedStart, modifiedEnd });
/** A generator without outside randomness (repeatable): linear congruence. */
const random = (seed) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const norm = (t) => t.replace(/\r\n?/g, "\n");
const S = (t) => crypto.createHash("sha256").update(norm(t), "utf8").digest("hex");
const rowsOf = (t) => { const n = norm(t); return n === "" ? [] : n.split("\n"); };
/** A random pair (index, buffer): lines from a small alphabet (so the diff finds equal ones), the buffer edited from it. */
function pair(r) {
  const index = Array.from({ length: Math.floor(r() * 14) }, () => "abcdef"[Math.floor(r() * 6)]);
  const now = [];
  for (const z of index) {
    const w = r();
    if (w < 0.15) continue; // deleted
    if (w < 0.3) { now.push(z.toUpperCase()); continue; } // changed
    now.push(z);
    if (w > 0.85) now.push("n" + Math.floor(r() * 3)); // fresh
  }
  if (r() < 0.2) now.unshift("front");
  return { index, now };
}
const withEnd = (rows, r, end) => {
  const ENDS = ["\n", "\r\n", "\r"];
  const kind = r() < 0.4 ? "\n" : r() < 0.6 ? "\r\n" : null; // uniform or mixed
  return rows.map((z, i) => z + (i < rows.length - 1 || end ? (kind ?? ENDS[Math.floor(r() * 3)]) : "")).join("");
};

const CHECKS = {
  form(Q) {
    const base = Z("a", "b", "c", "d", "e");
    const ae = (now) => Q.changes(D.dirtyDiff(base, now));
    assert.deepEqual(ae(Z("a", "b", "X", "Y", "c", "d", "e")), [A(2, 0, 3, 4)], "fresh after b: index line before 2, end 0");
    assert.deepEqual(ae(Z("a", "B", "c", "d", "e")), [A(2, 2, 2, 2)], "modified");
    assert.deepEqual(ae(Z("a", "d", "e")), [A(2, 3, 1, 0)], "deleted under line 1");
    assert.deepEqual(ae(Z("c", "d", "e")), [A(1, 2, 0, 0)], "deleted before the first line");
    // Several blocks: the index lines from the offset of the blocks before.
    assert.deepEqual(ae(Z("N1", "N2", "a", "b", "d", "E", "x")), [A(0, 0, 1, 2), A(3, 3, 4, 0), A(5, 5, 6, 7)], "fresh, deleted, changed in a row");
    assert.equal(Q.kindOf(A(2, 0, 3, 4)), "fresh");
    assert.equal(Q.kindOf(A(2, 3, 1, 0)), "deleted");
    assert.equal(Q.kindOf(A(2, 2, 2, 2)), "changed");
    assert.equal(Q.endRow(A(1, 2, 0, 0)), 1, "a deletion before the first line: the peek under line 1");
    assert.equal(Q.endRow(A(2, 3, 4, 0)), 4);
    assert.equal(Q.endRow(A(2, 0, 3, 7)), 7);
    assert.equal(Q.changeHeight(A(2, 0, 3, 4)), 2, "fresh: the new lines");
    assert.equal(Q.changeHeight(A(2, 4, 1, 0)), 3, "deleted: the old lines");
    assert.equal(Q.changeHeight(A(2, 3, 2, 2)), 3, "changed: both sides");
    assert.ok(Q.rowHits(1, A(1, 2, 0, 0)), "click on line 1 hits the deletion before it");
    assert.ok(Q.rowHits(4, A(2, 3, 4, 0)) && !Q.rowHits(5, A(2, 3, 4, 0)), "a deletion hits only the line above");
    assert.ok(Q.rowHits(3, A(2, 0, 3, 4)) && Q.rowHits(4, A(2, 0, 3, 4)) && !Q.rowHits(5, A(2, 0, 3, 4)));
    // Over random pairs: the changes rebuild the buffer from the index (the form of VS Code, applyLineChanges).
    const r = random(11);
    for (let n = 0; n < 300; n++) {
      const { index, now } = pair(r);
      const list = Q.changes(D.dirtyDiff(index.join("\n"), now.join("\n")) ?? []);
      const fresh = [];
      let i = 0; // next index line (0-based)
      for (const a of list) {
        const untilBefore = a.originalEnd === 0 ? a.originalStart : a.originalStart - 1;
        fresh.push(...index.slice(i, untilBefore));
        if (a.modifiedEnd > 0) fresh.push(...now.slice(a.modifiedStart - 1, a.modifiedEnd));
        i = a.originalEnd === 0 ? a.originalStart : a.originalEnd;
      }
      fresh.push(...index.slice(i));
      assert.deepEqual(fresh, now, `pair ${n}: ${JSON.stringify(index)} → ${JSON.stringify(now)}`);
    }
  },
  target(Q) {
    const L = [A(1, 1, 2, 3), A(5, 0, 7, 7), A(9, 10, 11, 0)]; // lines 2–3, 7, deletion under 11
    const z = (open, cursorRow, direction, row) => Q.peekTarget({ list: L, open, cursorRow, direction, row });
    assert.equal(z(null, 1, 1), 0, "closed, cursor before: the first");
    assert.equal(z(null, 3, 1), 0, "inclusive: the cursor INSIDE the first shows it");
    assert.equal(z(null, 4, 1), 1);
    assert.equal(z(null, 12, 1), 0, "after the last: round-robin the first");
    assert.equal(z(null, 7, -1), 1, "previous: the last one that starts at or before the line");
    assert.equal(z(null, 6, -1), 0);
    assert.equal(z(null, 1, -1), 2, "before the first: round-robin the last");
    assert.equal(z(0, 1, 1), 1, "open: round-robin onward");
    assert.equal(z(2, 1, 1), 0);
    assert.equal(z(0, 1, -1), 2);
    assert.equal(z(1, 99, 1, 2), 0, "with a row (click) counts from the row, not round-robin");
    assert.equal(Q.peekTarget({ list: [L[0]], open: 0, cursorRow: 1, direction: 1 }), null, "canNavigate: one change with an open peek does nothing");
    assert.equal(Q.peekTarget({ list: [L[0]], open: null, cursorRow: 9, direction: 1 }), 0, "closed: even one opens");
    assert.equal(Q.peekTarget({ list: [], open: null, cursorRow: 1, direction: 1 }), null);
    assert.equal(Q.nextFrom(L, 8), 2);
    assert.equal(Q.previousFrom(L, 11), 2);
    assert.deepEqual(Q.clickTarget(L, null, 3), { kind: "show", index: 0 });
    assert.deepEqual(Q.clickTarget(L, 0, 2), { kind: "close" }, "click on the open one closes");
    assert.deepEqual(Q.clickTarget(L, 0, 11), { kind: "show", index: 2 });
    assert.equal(Q.clickTarget(L, null, 5), null, "no change on the row");
    assert.deepEqual(Q.clickTarget([A(1, 2, 0, 0)], null, 1), { kind: "show", index: 0 }, "the deletion before line 1");
  },
  list(Q) {
    const a = A(1, 1, 1, 1), b = A(5, 5, 5, 5), c = A(9, 9, 9, 9);
    assert.deepEqual(Q.differenceBeginnings([a, b, c], [a, b, c]), []);
    assert.deepEqual(Q.differenceBeginnings([a, b, c], [b, c]), [0]);
    assert.deepEqual(Q.differenceBeginnings([a, b, c], [a, c]), [1]);
    assert.deepEqual(Q.differenceBeginnings([a, b], [A(1, 1, 1, 2), A(5, 5, 5, 6)]), [0], "adjacent differences are ONE splice (sortedDiff)");
    assert.deepEqual(Q.differenceBeginnings([a, c], [a, b, c]), [1]);
    // VS Code onDidModelChange → next(): from the open one round-robin onward in the NEW list (after staging the open one, one further).
    assert.deepEqual(Q.afterListSwitch([a, b, c], [b, c], 0), { kind: "jump", index: 1 });
    assert.deepEqual(Q.afterListSwitch([a, b, c], [a, b], 2), { kind: "jump", index: 0 }, "the last one staged: round-robin the first");
    assert.deepEqual(Q.afterListSwitch([a, b, c], [a, b, A(9, 9, 9, 10)], 0), { kind: "stay", index: 0 }, "moved only behind it: the peek stays");
    assert.deepEqual(Q.afterListSwitch([a, b, c], [a, b, c], 1), null);
    assert.deepEqual(Q.afterListSwitch([a], [], 0), { kind: "close" }, "no change left: close");
  },
  dimensions(Q) {
    const m = Q.peekDimensions(A(2, 2, 2, 3), 18, 900); // height 3 rows, 50 editor rows
    assert.ok(Math.abs(m.rows - (11 + 1 / 18)) < 1e-9, `rows ${m.rows}`);
    assert.equal(m.arrow, 6);
    assert.equal(m.frame, 1);
    assert.ok(Math.abs(m.height - 199) < 1e-9);
    assert.ok(Math.abs(m.holder - 185) < 1e-9);
    assert.equal(m.header, 22);
    assert.equal(m.body, 162);
    assert.ok(Math.abs(Q.peekDimensions(A(1, 30, 1, 30), 18, 900).rows - (16 + 1 / 18)) < 1e-9, "at most a third of the editor");
    assert.ok(Math.abs(Q.peekDimensions(A(1, 1, 1, 1), 18, 200).rows - (3 + 1 / 18)) < 1e-9, "small editor: a third");
    assert.equal(Q.peekDimensions(A(1, 1, 1, 1), 20, 900).arrow, 7, "arrow rounded");
    assert.equal(Q.peekDimensions(A(1, 1, 1, 1), 18, 900, 20).rows, 20, "a dragged height applies");
    assert.equal(Q.dragHeight(10, 37, 18), 12);
    assert.equal(Q.dragHeight(10, -37, 18), 8);
    assert.equal(Q.dragHeight(6, -18, 18), null, "not below 6 rows");
    assert.equal(Q.dragHeight(34, 18, 18), null, "not above 34 rows");
  },
  view(Q) {
    assert.deepEqual(Q.peekView(A(3, 4, 2, 0)), { from: 2, until: 3 }, "deletion: the line above and the one below");
    assert.deepEqual(Q.peekView(A(3, 4, 3, 5)), { from: 2, until: 6 }, "changed: one line of margin");
    assert.deepEqual(Q.peekView(A(2, 0, 3, 5)), { from: 3, until: 5 }, "fresh: exactly the lines");
    assert.equal(Q.cursorAfterAction(A(2, 2, 3, 3), 10), 4, "one line below the start (Selection(modifiedStart, 0) is 0-based)");
    assert.equal(Q.cursorAfterAction(A(1, 2, 0, 0), 10), 1);
    assert.equal(Q.cursorAfterAction(A(2, 2, 9, 9), 9), 9, "clamped to the text");
    assert.equal(Q.titleKey(1), "{source} - {n} of {m} change");
    assert.equal(Q.titleKey(2), "{source} - {n} of {m} changes");
  },
  stage(Q) {
    const base = Z("a", "b", "c", "d", "e"), now = Z("N", "a", "B", "c", "e", "x");
    const bl = D.dirtyDiff(base, now);
    const r = (i) => Q.stageBody(base, now, bl, i, "\n");
    assert.deepEqual(r(0).body, { from: 0, until: 0, old: [], rows: ["N"], rowCount: 5, lineEnding: "\n", baseSha: S(base) }, "fresh before the first line");
    assert.equal(r(0).newBase, Z("N", "a", "b", "c", "d", "e"));
    assert.deepEqual(r(1).body, { from: 1, until: 2, old: ["b"], rows: ["B"], rowCount: 5, lineEnding: "\n", baseSha: S(base) }, "changed: the lines of the buffer");
    assert.equal(r(1).newBase, Z("a", "B", "c", "d", "e"));
    assert.deepEqual(r(2).body, { from: 3, until: 4, old: ["d"], rows: [], rowCount: 5, lineEnding: "\n", baseSha: S(base) }, "deleted");
    assert.equal(r(2).newBase, Z("a", "b", "c", "e"));
    assert.equal(Q.stageBody(base, now, bl, 9, "\n"), null);
    // Staged one after another (each against the new base) the whole buffer ends up in the index — over random pairs and blocks.
    const zf = random(5);
    for (let n = 0; n < 200; n++) {
      const p = pair(zf);
      let b = p.index.join("\n");
      const j = p.now.join("\n");
      for (let step = 0; step < 40; step++) {
        const blocks = D.dirtyDiff(b, j) ?? [];
        if (!blocks.length) break;
        b = Q.stageBody(b, j, blocks, Math.floor(zf() * blocks.length), "\n").newBase;
      }
      assert.equal(b, j, `pair ${n}: ${JSON.stringify(p.index)} → ${JSON.stringify(p.now)}`);
    }
  },
  binding(Q) {
    // An index without a line ending: new lines get that of the buffer.
    const b1 = D.dirtyDiff("a", Z("a", "b"));
    const r1 = Q.stageBody("a", Z("a", "b"), b1, 0, "\r\n");
    assert.equal(G.blockInIndex("a", G.stageBlockBody(r1.body)), "a\r\nb", "the line ending of the buffer for an index without one");
    // Over random index texts (LF, CR LF, CR, mixed, with and without a final line break): the server accepts every body, writes exactly the
    // new base of the client and leaves the lines before the block byte for byte.
    const zf = random(23);
    let checked = 0;
    for (let n = 0; n < 250; n++) {
      const p = pair(zf);
      const raw = withEnd(p.index, zf, zf() < 0.5);
      const base = norm(raw);
      const now = p.now.join("\n") + (zf() < 0.5 ? "\n" : "");
      const blocks = D.dirtyDiff(base, now) ?? [];
      for (let i = 0; i < blocks.length; i++) {
        const r = Q.stageBody(base, now, blocks, i, zf() < 0.5 ? "\n" : "\r\n");
        let fresh;
        try { fresh = G.blockInIndex(raw, G.stageBlockBody(JSON.parse(JSON.stringify(r.body)))); }
        catch (e) { throw new Error(`pair ${n}, block ${i}: the server rejects (${e.code ?? e.message}) — ${JSON.stringify({ raw, now, body: r.body })}`); }
        assert.equal(norm(fresh), r.newBase, `pair ${n}, block ${i}: the server writes something other than the new base`);
        assert.equal(r.body.baseSha, G.indexChecksum(raw), `pair ${n}, block ${i}: the checksum of the client is not that of the server`);
        // The lines before the block with their endings — except the one that becomes the last through a deletion at the end (the last line never ends).
        let prior = raw.split(/(?<=\r\n|\r(?!\n)|\n)/).slice(0, r.body.from).join("");
        if (!r.body.rows.length && r.body.until === r.body.rowCount) prior = prior.replace(/(\r\n|\r|\n)$/, "");
        assert.ok(fresh.startsWith(prior), `pair ${n}, block ${i}: the lines before lost their line ending ${JSON.stringify({ raw, now, body: r.body, fresh })}`);
        if (!/\r/.test(raw) && /\n/.test(raw)) assert.equal(fresh, r.newBase, `pair ${n}, block ${i}: an LF index stays LF`);
        checked++;
      }
    }
    assert.ok(checked > 300, `only ${checked} blocks checked`);
    // Computed against an index that moved in the meantime (same row count, a pure insertion) — the server rejects.
    const client = Z("a", "b", "c", "d", ""), moved = Z("x", "a", "b", "c", "");
    const rb = Q.stageBody(client, Z("a", "b", "FRESH", "c", "d", ""), D.dirtyDiff(client, Z("a", "b", "FRESH", "c", "d", "")), 0, "\n");
    assert.throws(() => G.blockInIndex(moved, G.stageBlockBody(rb.body)), (e) => e.status === 409 && e.code === "INDEX_CHANGED", "an insertion into a moved index");
    assert.equal(G.blockInIndex(client, G.stageBlockBody(rb.body)), Z("a", "b", "FRESH", "c", "d", ""));
  },
  again(Q) {
    // The change at line 5 (index 4) was shown; afterwards two lines were added on top — it now stands at line 7, its number is 1.
    const base = Z("a", "b", "c", "d", "e"), prior = Z("a", "b", "c", "D", "e"), after = Z("N1", "N2", "a", "b", "c", "D", "e");
    const g = Q.changes(D.dirtyDiff(base, prior))[0];
    const list = Q.changes(D.dirtyDiff(base, after));
    assert.equal(list.length, 2);
    assert.equal(Q.findAgain(list, g), 1, "the shown change, not the one with its old number");
    assert.deepEqual(list[1], A(4, 4, 6, 6));
    // Typed into the shown one: the same spot in the index, so the same change.
    assert.equal(Q.findAgain(Q.changes(D.dirtyDiff(base, Z("a", "b", "c", "DD", "D2", "e"))), g), 0);
    // Gone (reverted) or merged with the neighbor: -1.
    assert.equal(Q.findAgain(Q.changes(D.dirtyDiff(base, Z("N1", "a", "b", "c", "d", "e"))), g), -1, "another one that carries the number 0");
    assert.equal(Q.findAgain(Q.changes(D.dirtyDiff(base, Z("a", "b", "C", "D", "e"))), g), -1, "merged: the spot in the index is a different one");
    assert.equal(Q.findAgain(Q.changes(D.dirtyDiff(base, Z("a", "b", "c", "D", "E"))), g), -1, "merged with the following one: same start, different end");
  },
  sha(H) {
    for (const t of ["", "abc", "a\nb\n", "äöüß € 中文 \u{1D11E}", "x".repeat(55), "x".repeat(56), "x".repeat(63), "x".repeat(64), "x".repeat(65), "ä".repeat(32),
      Array.from({ length: 70_000 }, (_, i) => String.fromCharCode(32 + (i * 7919) % 90)).join("")]) {
      assert.equal(H.sha256Hex(t), crypto.createHash("sha256").update(t, "utf8").digest("hex"), `SHA-256 of ${JSON.stringify(t.slice(0, 20))}… (${t.length} characters)`);
    }
  },
};

test("(1) computations: form, target, list switch, dimensions, view, staging — bound to the server", () => {
  for (const [name, check] of Object.entries(CHECKS)) {
    try { check(name === "sha" ? SHA : real); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
});

test("(1) counter-tests of the computations: every sabotage appears exactly once and is caught", () => {
  const stale = [], notCaught = [];
  for (const s of sabotaged) {
    if (s.places !== 1) { stale.push(`${s.name} (${s.places}×)`); continue; }
    let caught = false;
    try { CHECKS[s.catches](s.mod); } catch { caught = true; }
    if (!caught) notCaught.push(`${s.name} (${s.catches})`);
  }
  for (const s of shaSabotaged) {
    if (s.places !== 1) { stale.push(`sha256: ${s.name} (${s.places}×)`); continue; }
    let caught = false;
    try { CHECKS.sha(s.mod); } catch { caught = true; }
    if (!caught) notCaught.push(`sha256: ${s.name}`);
  }
  assert.deepEqual(stale, [], "sabotages whose spot does not appear exactly once in lib/quick-diff.ts or lib/sha256.ts");
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  console.log(`  [quick-diff] computations: ${Object.keys(CHECKS).length} checks, ${sabotaged.length + shaSabotaged.length} sabotages, each caught`);
});

// ── (2) The sources ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const Q = {
  margin: read("src", "components", "code", "git-gutter.ts"),
  peek: read("src", "components", "code", "quick-diff-peek.ts"),
  commands: read("src", "lib", "editor-commands.ts"),
  pane: read("src", "components", "CodePane.tsx"),
  codicons: read("src", "lib", "codicons.ts"),
  en: read("src", "lib", "i18n-de.ts"),
  ruler: read("src", "components", "code", "overviewRuler.ts"),
};
const TEXTS = ["Revert Change", "Stage Change", "Show Next Change", "Show Previous Change", "Close", "Git Local Changes (Working Tree)",
  "{source} - {n} of {m} changes", "{source} - {n} of {m} change", "The change could not be staged: {msg}",
  "This file goes through a Git filter when staged (such as Git LFS) — staging by block would bypass it. Please stage the whole file.",
  "The index has changed in the meantime — the gutter is being reloaded. Please stage the change again."];
// The texts of the old click peek (German wording of the translation file) — without users, gone.
const GONE = ["Diesen Block auf HEAD zurücksetzen (nicht gespeichert)", "In HEAD standen hier keine Zeilen."];
const SOURCE_CHECKS = {
  margin(q) {
    const r = withoutComments(q.margin);
    assert.ok(r.includes("tree = await location.calls<GitTree>(\"/git/stage-block\", { method: \"POST\", body: JSON.stringify({ repo: location.repo, file: location.file, ...r.body }) });"), "staging not via the route with repo and file of the base");
    assert.ok(r.includes("const r = g ? stageBody(v.base, view.state.doc.toString(), g.blocks, g.index, p.status.lineEnding) : null;"), "staging not with the text and the line ending of the buffer");
    assert.ok(r.includes("setGitBase(p.key, r.newBase);") && r.includes("location.gitTree(tree);"), "after staging, gutter or git tree stay stale");
    assert.ok(r.includes("const location: Location = { calls, repo: a.body.repo, file: a.body.file,") && r.includes("LOCATIONS.set(a.key, location);"), "the location of staging is not that of the base");
    // After staging AND after a failure the base is fetched anew (not believed; a moved index would otherwise always be 409).
    assert.equal((r.match(/location\.fetchNew\(\);/g) ?? []).length, 2, "the base is not fetched anew after staging or after a failure");
    assert.ok(r.includes("fetchNew: () => setCatchUpSeq((n) => n + 1) };") && r.includes("focusSeq, catchUpSeq]);"), "fetchNew does not fetch");
    // After an error-free action the cursor as in VS Code, then close — for staging and reverting.
    assert.ok(r.includes("view.dispatch({ selection: { anchor: doc.line(cursorAfterAction(a, doc.lines)).from }, userEvent: \"select\" });\n    close(view);\n  };"), "the peek stays open after the action");
    assert.ok(r.includes("view.dispatch({ changes: ae, userEvent: \"input.gitRevert\" });\n    afterAction(view, g.a);") && r.includes("if (view.dom.isConnected) afterAction(view, g.a);"), "an action does not close");
    // The SHOWN change, found again in the fresh list.
    assert.ok(r.includes("shown.set(view, { a, base });") && r.includes("index = findAgain(list, g.a);"), "the action hits the number, not the shown change");
    assert.ok(r.includes("if (!g || g.base !== base) return null;"), "a change shown against another base hits a foreign line");
    assert.equal((r.match(/const g = shownChange\(view, v\.base\)/g) ?? []).length, 2, "staging or reverting misses the shown change");
    // At most one stage per view, the button off while it runs.
    assert.ok(r.includes("|| !location || stagesCurrently.has(view)) return;") && r.includes("stagesCurrently.add(view);\n    stageButtonStatus(view, true);") && r.includes("} finally {\n      stagesCurrently.delete(view);\n      stageButtonStatus(view, false);"), "a second click stages again");
    assert.ok(r.includes("stages: () => stagesCurrently.has(view),"), "the peek does not learn that staging is going on");
    // The location goes with its view (only if it is still its own).
    assert.ok(r.includes("useEffect(() => () => releaseLocation(ownRef), []);") && r.includes("if (e && LOCATIONS.get(e.key) === e.location) LOCATIONS.delete(e.key);"), "the location stays after the view");
    // FILTER (and INDEX_CHANGED) with a wording of their own.
    assert.ok(r.includes("if (code === \"FILTER\") return t(\"This file goes through a Git filter when staged") && r.includes("if (code === \"INDEX_CHANGED\") return t("), "FILTER or INDEX_CHANGED without a wording of their own");
    assert.ok(r.includes("const ae = reset(view.state.doc.toString(), block);") && !/save\(/.test(r), "reverting not in the buffer or it saves");
    assert.ok(r.includes("const z = clickTarget(changes(v.blocks), v.open, d.row);") && r.includes("view.state.doc.lineAt(row.from).number !== d.row"), "the click not like onEditorMouseUp");
    assert.ok(/mousedown\(view, row, ev\) \{[\s\S]*?rowHits\(n, a\)[\s\S]*?\},\s*mouseup\(/.test(r), "mouse down does not remember a change row");
    assert.ok(r.includes("const followUp = afterListSwitch(changes(v.blocks), after, v.open);") && r.includes("if (peekHasFocus(view)) {"), "the list switch not like onDidModelChange");
    assert.ok(r.includes("for (const b of QUICK_DIFF_COMMANDS) {") && r.includes("registerCommand<EditorContext>({ ...b, execute: (k) => { STEERING.get(k.view)?.navigate(DIRECTION[b.id]); } });"), "Alt+F3/Shift+Alt+F3 not in the command table");
    assert.ok(r.includes("const DIRECTION: Record<string, 1 | -1> = { \"editor.action.dirtydiff.next\": 1, \"editor.action.dirtydiff.previous\": -1 };"), "direction of the commands swapped");
    assert.ok(r.includes("const i = peekTarget({ list: changes(v.blocks), open: v.open,"), "Alt+F3 misses the target");
    assert.ok(r.includes("PEEK_THEME,") && r.includes("peekKeys((view) => view.state.field(field, false)?.open != null, (view) => close(view)),"), "peek without form or without Esc");
    assert.ok(r.includes("showRowFallsOutside(view, endRow(pk.a) + 1);"), "showChange does not follow with the view");
  },
  peek(q) {
    const s = withoutComments(q.peek);
    const acts = [...s.matchAll(/\{ id: "(\w+)", title: "([^"]+)", symbol: "([\w-]+)" \}/g)].map((m) => `${m[1]}|${m[2]}|${m[3]}`);
    assert.deepEqual(acts, ["reset|Revert Change|discard", "stage|Stage Change|add", "next|Show Next Change|arrow-down",
      "previous|Show Previous Change|arrow-up", "close|Close|close"], "the actions not in order, title and glyph of VS Code");
    for (const [rule, values] of [["&dark .cm-quickdiff", ["\"--qd-header\": \"#252526\"", "\"--qd-title\": \"#ffffff\"", "\"--qd-description\": \"#ccccccb3\"", "\"--qd-symbol\": \"#cccccc\"", "\"--qd-symbol-off\": \"#cccccc80\"", "\"--qd-new\": \"#2ea043\"", "\"--qd-changed\": \"#0078d4\"", "\"--qd-deleted\": \"#f85149\""]],
      ["&light .cm-quickdiff", ["\"--qd-header\": \"#f3f3f3\"", "\"--qd-title\": \"#000000\"", "\"--qd-description\": \"#616161\"", "\"--qd-symbol\": \"#3b3b3b\"", "\"--qd-symbol-off\": \"#61616180\"", "\"--qd-new\": \"#2ea043\"", "\"--qd-changed\": \"#005fb8\"", "\"--qd-deleted\": \"#f85149\""]]]) {
      const row = s.split("\n").find((z) => z.includes(`"${rule}": {`)) ?? "";
      for (const w of values) assert.ok(row.includes(w), `${rule}: ${w} missing`);
    }
    assert.ok(s.includes("\".cm-quickdiff[data-quick-diff-kind=fresh]\": { \"--qd-color\": \"var(--qd-new)\" },") && s.includes("\".cm-quickdiff[data-quick-diff-kind=deleted]\": { \"--qd-color\": \"var(--qd-deleted)\" },"), "frame and arrow not in the color of the change");
    assert.ok(s.includes("{ key: \"Escape\", run }, { key: \"Shift-Escape\", run }") && s.includes("{ key: \"Escape\", run: () => { this.d.control.close(); return true; } },"), "Esc does not close (outside and in the peek)");
    assert.ok(s.includes("{ key: \"Alt-F3\", preventDefault: true, run: () => { this.d.control.next(); return true; } },"), "Alt+F3 in the peek does not mean the outer editor");
    assert.ok(s.includes("unifiedMergeView({ original: d.base,") && s.includes("mergeControls: false"), "the diff not against the index or with buttons of its own");
    assert.ok(s.includes("const dimensions = peekDimensions(d.change, m.defaultLineHeight, m.scrollDOM.clientHeight, this.pulled ?? undefined);"), "dimensions not from the computation");
    assert.ok(s.includes("export const SOURCE = \"Git Local Changes (Working Tree)\";") && s.includes("tr(titleKey(d.count), { source: tr(SOURCE), n: d.index + 1, m: d.count })"), "title not like VS Code");
    // `EditorView.theme` throws on load at `&dark`/`&light` (only the base theme knows them) — the whole page froze.
    for (const m of s.matchAll(/EditorView\.theme\(\{[\s\S]*?\}\);/g)) assert.doesNotMatch(m[0], /&(dark|light)\b/, "&dark/&light in EditorView.theme");
    assert.ok(s.includes("DIFF_IN_PEEK, dark ? CHANGED_DARK : CHANGED_LIGHT,") && s.includes("const CHANGED_LIGHT = EditorView.theme({ \"&.cm-merge-b.cm-merge-b .cm-changedText\": { background: \"#9ccc2c40\" } });"), "changed text not in the VS Code color per mode");
    // Off while staging is going on — a newly built peek too; off looks like VS Code (disabledForeground, no hover).
    assert.ok(s.includes("if (a.id === \"stage\") b.disabled = this.d.control.stages();") && s.includes("for (const b of view.dom.querySelectorAll<HTMLButtonElement>(\".cm-quickdiff-action[data-quick-diff-action=stage]\")) b.disabled = off;"), "the button does not go off while staging");
    assert.ok(s.includes("\".cm-quickdiff-action:disabled\": { color: \"var(--qd-symbol-off)\", cursor: \"default\" },") && s.includes("\".cm-quickdiff-action:not(:disabled):hover\""), "a switched-off button does not look like VS Code");
    for (const g of ["discard", "add", "arrow-down", "arrow-up", "close"]) assert.ok(q.codicons.includes(`  "${g}": { box: "0 0 16 16", paths: [`), `glyph ${g} missing in lib/codicons.ts`);
  },
  commands(q) {
    const b = withoutComments(q.commands);
    assert.ok(b.includes("{ id: \"editor.action.dirtydiff.next\", title: \"Show Next Change\", shortcut: \"⌥F3\", keys: [\"Alt-F3\"] },"), "editor.action.dirtydiff.next not like VS Code");
    assert.ok(b.includes("{ id: \"editor.action.dirtydiff.previous\", title: \"Show Previous Change\", shortcut: \"⇧⌥F3\", keys: [\"Shift-Alt-F3\"] },"), "editor.action.dirtydiff.previous not like VS Code");
  },
  pane(q) {
    const c = withoutComments(q.pane);
    // The base of the active group as a hook, and for each front file in ANOTHER group a `<GitBase …/>`.
    assert.ok((c.match(/useGitBase\(\{[^\n]*gitTree: afterGitAction \}\);/g) ?? []).length === 1 && c.includes("gitTree={afterGitAction} />"), "CodePane does not pass the git tree to every base");
    assert.ok(/const afterGitAction = useCallback\(\(t: GitTree\) => \{\n\s+if \(stRef\.current\) takeOverGitTree\(apiBase, gitChat, gitChat \? null : instance, t\);\n\s+else applyGitTree\(t\);/.test(c), "the git tree after staging does not go into explorer and bar");
  },
  ruler(q) {
    // The zone of the peek hangs as a block widget at the line — the marks of the ruler measure only the text line (VS Code: zones are not
    // in the marks; otherwise the mark of the open change would reach across the whole peek).
    const l = withoutComments(q.ruler);
    assert.ok(l.includes("return Array.isArray(b.type) ? (b.type as readonly BlockInfo[]).find((t) => t.type === BlockType.Text && t.from <= pos && pos <= t.to) ?? b : b;"), "the ruler measures the line including the peek");
    assert.ok(l.includes("const a = rowsBlock(v, Math.min(from, doc.length)), b = rowsBlock(v, Math.min(Math.max(from, to), doc.length));"), "the marks do not measure the text line");
  },
  texts(q) {
    for (const k of TEXTS) assert.equal(q.en.split(`\n  "${k}": `).length - 1, 1, `"${k}" does not appear exactly once in lib/i18n-de.ts`);
    for (const k of GONE) assert.ok(!q.en.includes(`"${k}"`), `"${k}" is still in lib/i18n-de.ts (without users)`);
  },
};
const SOURCE_SABOTAGES = {
  "staging to the wrong route": { file: "margin", old: "location.calls<GitTree>(\"/git/stage-block\"", fresh: "location.calls<GitTree>(\"/git/stage\"", catches: "margin" },
  "staging without repo": { file: "margin", old: "JSON.stringify({ repo: location.repo, file: location.file, ...r.body })", fresh: "JSON.stringify({ file: location.file, ...r.body })", catches: "margin" },
  "staging with LF instead of the buffer line ending": { file: "margin", old: "g.blocks, g.index, p.status.lineEnding)", fresh: "g.blocks, g.index, \"\\n\")", catches: "margin" },
  "not fetched anew after a failure": { file: "margin", old: "showHint(view, stageError(e));\n      location.fetchNew();", fresh: "showHint(view, stageError(e));", catches: "margin" },
  "believed after staging": { file: "margin", old: "    location.fetchNew(); // … and read", fresh: "    // … and read", catches: "margin" },
  "fetchNew does not fetch": { file: "margin", old: "focusSeq, catchUpSeq]);", fresh: "focusSeq]);", catches: "margin" },
  "open after the action": { file: "margin", old: "userEvent: \"select\" });\n    close(view);\n  };", fresh: "userEvent: \"select\" });\n  };", catches: "margin" },
  "staging without finishing": { file: "margin", old: "if (view.dom.isConnected) afterAction(view, g.a);", fresh: "", catches: "margin" },
  "action via the number": { file: "margin", old: "index = findAgain(list, g.a);", fresh: "index = view.state.field(field, false)?.open ?? -1;", catches: "margin" },
  "shown not remembered": { file: "margin", old: "shown.set(view, { a, base });", fresh: "", catches: "margin" },
  "shown against foreign base": { file: "margin", old: "if (!g || g.base !== base) return null;", fresh: "if (!g) return null;", catches: "margin" },
  "double-click stages twice": { file: "margin", old: "|| !location || stagesCurrently.has(view)) return;", fresh: "|| !location) return;", catches: "margin" },
  "button stays on": { file: "margin", old: "stagesCurrently.add(view);\n    stageButtonStatus(view, true);", fresh: "stagesCurrently.add(view);", catches: "margin" },
  "location stays after the view": { file: "margin", old: "useEffect(() => () => releaseLocation(ownRef), []);", fresh: "", catches: "margin" },
  "foreign location released": { file: "margin", old: "if (e && LOCATIONS.get(e.key) === e.location) LOCATIONS.delete(e.key);", fresh: "if (e) LOCATIONS.delete(e.key);", catches: "margin" },
  "FILTER without wording": { file: "margin", old: "if (code === \"FILTER\") return t(", fresh: "if (code === \"FILTERX\") return t(", catches: "margin" },
  "new peek forgets the staging": { file: "peek", old: "if (a.id === \"stage\") b.disabled = this.d.control.stages();", fresh: "", catches: "peek" },
  "off looks on": { file: "peek", old: "\".cm-quickdiff-action:disabled\": { color: \"var(--qd-symbol-off)\", cursor: \"default\" },", fresh: "", catches: "peek" },
  "off light like dark": { file: "peek", old: "\"--qd-symbol-off\": \"#61616180\"", fresh: "\"--qd-symbol-off\": \"#cccccc80\"", catches: "peek" },
  "old text comes back": { file: "en", old: "\n  \"The change could not be staged: {msg}\": ", fresh: "\n  \"There were no lines here in HEAD.\": \"In HEAD standen hier keine Zeilen.\",\n  \"The change could not be staged: {msg}\": ", catches: "texts" },
  "gutter stays stale after staging": { file: "margin", old: "setGitBase(p.key, r.newBase);", fresh: "", catches: "margin" },
  "explorer stays stale after staging": { file: "margin", old: "location.gitTree(tree);", fresh: "", catches: "margin" },
  "reverting saves": { file: "margin", old: "view.dispatch({ changes: ae, userEvent: \"input.gitRevert\" });", fresh: "view.dispatch({ changes: ae, userEvent: \"input.gitRevert\" }); void p.save();", catches: "margin" },
  "click without mouse press": { file: "margin", old: "view.state.doc.lineAt(row.from).number !== d.row", fresh: "false", catches: "margin" },
  "list switch also with focus": { file: "margin", old: "if (peekHasFocus(view)) {", fresh: "if (false) {", catches: "margin" },
  "commands not registered": { file: "margin", old: "for (const b of QUICK_DIFF_COMMANDS) {", fresh: "for (const b of [] as typeof QUICK_DIFF_COMMANDS) {", catches: "margin" },
  "direction swapped": { file: "margin", old: "\"editor.action.dirtydiff.next\": 1, \"editor.action.dirtydiff.previous\": -1", fresh: "\"editor.action.dirtydiff.next\": -1, \"editor.action.dirtydiff.previous\": 1", catches: "margin" },
  "without Esc": { file: "margin", old: "peekKeys((view) => view.state.field(field, false)?.open != null, (view) => close(view)),", fresh: "", catches: "margin" },
  "actions rearranged": { file: "peek", old: "  { id: \"reset\", title: \"Revert Change\", symbol: \"discard\" },\n  { id: \"stage\", title: \"Stage Change\", symbol: \"add\" },", fresh: "  { id: \"stage\", heading: \"Stage Change\", symbol: \"add\" },\n  { id: \"revert\", heading: \"Revert Change\", symbol: \"discard\" },", catches: "peek" },
  "header light like dark": { file: "peek", old: "\"&light .cm-quickdiff\": { \"--qd-header\": \"#f3f3f3\"", fresh: "\"&light .cm-quickdiff\": { \"--qd-header\": \"#252526\"", catches: "peek" },
  "changed light like dark": { file: "peek", old: "\"--qd-changed\": \"#005fb8\"", fresh: "\"--qd-changed\": \"#0078d4\"", catches: "peek" },
  "frame always blue": { file: "peek", old: "\".cm-quickdiff[data-quick-diff-kind=fresh]\": { \"--qd-color\": \"var(--qd-new)\" },", fresh: "", catches: "peek" },
  "Esc in the peek does nothing": { file: "peek", old: "{ key: \"Escape\", run: () => { this.d.control.close(); return true; } },", fresh: "", catches: "peek" },
  "&dark in the theme": { file: "peek", old: "const CHANGED_DARK = EditorView.theme({ \"&.cm-merge-b", fresh: "const CHANGED_DARK = EditorView.theme({ \"&dark.cm-merge-b", catches: "peek" },
  "changed text always dark": { file: "peek", old: "DIFF_IN_PEEK, dark ? CHANGED_DARK : CHANGED_LIGHT,", fresh: "DIFF_IN_PEEK, CHANGED_DARK,", catches: "peek" },
  "diff with buttons of its own": { file: "peek", old: "mergeControls: false", fresh: "mergeControls: true", catches: "peek" },
  "title without source": { file: "peek", old: "{ source: tr(SOURCE), n: d.index + 1, m: d.count }", fresh: "{ source: \"\", n: d.index + 1, m: d.count }", catches: "peek" },
  "glyph missing": { file: "codicons", old: "  \"discard\": { box: \"0 0 16 16\", paths: [", fresh: "  \"discard-alt\": { box: \"0 0 16 16\", paths: [", catches: "peek" },
  "Alt+F3 on F3": { file: "commands", old: "shortcut: \"⌥F3\", keys: [\"Alt-F3\"]", fresh: "shortcut: \"F3\", keys: [\"F3\"]", catches: "commands" },
  "previous without Shift": { file: "commands", old: "keys: [\"Shift-Alt-F3\"]", fresh: "keys: [\"Ctrl-Alt-F3\"]", catches: "commands" },
  "git tree not passed through": { file: "pane", old: "gitState: activePath ? gitXY[activePath] ?? \"\" : null, active: isActive, gitTree: afterGitAction });", fresh: "gitState: activePath ? gitXY[activePath] ?? \"\" : null, active: isActive });", catches: "pane" },
  "git tree not passed to the other groups": { file: "pane", old: "active={isActive} gitTree={afterGitAction} />", fresh: "active={isActive} />", catches: "pane" },
  "ruler measures the peek too": { file: "ruler", old: "const a = rowsBlock(v, Math.min(from, doc.length)), b = rowsBlock(v, Math.min(Math.max(from, to), doc.length));", fresh: "const a = v.lineBlockAt(Math.min(from, doc.length)), b = v.lineBlockAt(Math.min(Math.max(from, to), doc.length));", catches: "ruler" },
  "line without text part": { file: "ruler", old: "t.type === BlockType.Text && ", fresh: "", catches: "ruler" },
  "text without English": { file: "en", old: "\n  \"Stage Change\": ", fresh: "\n  \"Stage the change\": ", catches: "texts" },
};

test("(2) sources: route, click, list switch, commands, form and texts of the peek", () => {
  for (const [name, check] of Object.entries(SOURCE_CHECKS)) {
    try { check(Q); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
});

test("(2) counter-tests of the sources: every sabotage appears exactly once and is caught", () => {
  const stale = [], notCaught = [];
  for (const [name, s] of Object.entries(SOURCE_SABOTAGES)) {
    const n = Q[s.file].split(s.old).length - 1;
    if (n !== 1) { stale.push(`${name} (${n}×)`); continue; }
    let caught = false;
    try { SOURCE_CHECKS[s.catches]({ ...Q, [s.file]: Q[s.file].replace(s.old, () => s.fresh) }); } catch { caught = true; }
    if (!caught) notCaught.push(`${name} (${s.catches})`);
  }
  assert.deepEqual(stale, [], "sabotages whose spot does not appear exactly once in their source");
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  console.log(`  [quick-diff] sources: ${Object.keys(SOURCE_CHECKS).length} checks, ${Object.keys(SOURCE_SABOTAGES).length} sabotages, each caught`);
});
