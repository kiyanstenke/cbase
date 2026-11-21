// The ONE history of a buffer (as in VS Code: undo belongs to the model, not the editor) —
// lib/buffer-history.ts EXECUTED, on real CodeMirror states (@codemirror/state + @codemirror/commands from web/node_modules) and the
// real lib/buffer.ts:
//   - the same file in two views (two groups): undo in one takes back what the other typed, redo brings it back — in BOTH;
//   - the selection of back then returns with the step; keystrokes merge as in a single view;
//   - foreign changes (a change without a view) stay put on undo; a rename share is ONE step of its own;
//   - a view that joins later (split) has the history; only without any view does it let go, and if the buffer then runs away from it,
//     it starts anew (without throwing).
// Every claim comes with a sabotage of the source (counter-test): each sabotage names the check that must turn red.
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
const source = read("src", "lib", "buffer-history.ts");

const SABOTAGES = {
  "echo into the history": { old: "annotations: Transaction.addToHistory.of(false) }).state;\n    this.version", fresh: "}).state;\n    this.version", catches: "foreignStays" },
  "step twice": { old: `this.next = tr.annotation(fromHistory) ? "already" : tr;`, fresh: "this.next = tr;", catches: "twoViews" },
  "prior selection missing": { old: "if (prior.ranges.every((r) => r.to <= s.doc.length) && !s.selection.eq(prior)) s =", fresh: "if (false) s =", catches: "selection" },
  "kind of key missing": { old: "if (ue) ann.push(Transaction.userEvent.of(ue));", fresh: "", catches: "selection" },
  "rename without step": { old: `annotations: [Transaction.userEvent.of("input.rename"), isolateHistory.of("full")],`, fresh: "annotations: [Transaction.addToHistory.of(false)],", catches: "rename" },
  "lets go on the first unregister": { old: "if (this.count === 0) { const l = this.release;", fresh: "if (true) { const l = this.release;", catches: "share" },
  "never starts anew": { old: "if (!this.synchronous || this.state.doc.toString() !== this.p.text) {", fresh: "if (false) {", catches: "newBegin" },
};

// ── Compile: buffer, history and one copy of the history per sabotage, in ONE tsc run (node_modules as a link — the same instance
// of @codemirror/state for test, history and commands).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-history-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(path.join(src, "api"), { recursive: true });
fs.symlinkSync(path.join(webDir, "node_modules"), path.join(tmp, "node_modules"), "dir");
for (const f of ["file-status.ts", "code-instance.ts", "diff-tab.ts", "chat-tabs.ts", "buffer.ts"]) fs.writeFileSync(path.join(src, f), read("src", "lib", f));
fs.writeFileSync(path.join(src, "api", "core.ts"), "export async function api<T = unknown>(p: string, _o?: RequestInit): Promise<T> { throw new Error(`no network in the test: ${p}`); }\n");
fs.writeFileSync(path.join(src, "buffer-history.ts"), source);
const copies = Object.entries(SABOTAGES).map(([name, s], i) => {
  const file = `history-sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), source.replace(s.old, s.fresh));
  return { name, file, catches: s.catches, places: source.split(s.old).length - 1 };
});
const allTs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allTs(path.join(dir, e.name)) : [path.join(dir, e.name)]));
try {
  execFileSync(process.execPath, [tsc, ...allTs(src), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/history-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "buffer-history.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const P = await load("buffer.ts");
const real = await load("buffer-history.ts");
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: await load(k.file) })));
const { EditorState, EditorSelection, Transaction } = await import(pathToFileURL(path.join(out, "..", "node_modules", "@codemirror", "state", "dist", "index.js")).href);
process.on("exit", () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* stays */ } });

const Z = { apiBase: "/api/projects/p", instance: null };
let seq = 0;
/** A loaded buffer (no network: the disk comes along). */
async function loaded(text) {
  P.forgetAllBuffers();
  const p = P.buffer(Z, `d${++seq}.ts`);
  p.hold("tab");
  await p.load({ disk: { disk: { text, sha: null } } });
  return p;
}
/** A view like components/code/buffer-view.ts: one state, echoes without history, keys through the history, undo/redo there. */
function view2(G, p) {
  const g = G.BufferHistory.of(p);
  const v = { state: EditorState.create({ doc: p.text, selection: { anchor: 0 } }) };
  const view = { apply(b) { v.state = v.state.update({ changes: b.map((x) => ({ ...x })), annotations: Transaction.addToHistory.of(false) }).state; } };
  const unregister = g.logIn(null), release = p.connect(view);
  const report = (spec) => { const tr = v.state.update(spec); v.state = tr.state; g.ofView(view, tr); };
  v.report = report;
  v.text = () => v.state.doc.toString();
  v.type = (pos, t, time = 1000) => report({ changes: { from: pos, insert: t }, selection: { anchor: pos + t.length }, userEvent: "input.type", annotations: Transaction.time.of(time) });
  v.select = (anchor) => { v.state = v.state.update({ selection: { anchor: anchor } }).state; };
  v.step = (r) => { const s = g.step(r); if (s) report({ changes: s.changes, selection: s.selection, annotations: G.fromHistory.of(true) }); return Boolean(s); };
  v.release = () => { release(); unregister(); };
  return v;
}

const CHECKS = {
  async twoViews(G) {
    const p = await loaded("abc\n");
    const A = view2(G, p), B = view2(G, p);
    A.type(3, "X");
    assert.deepEqual([A.text(), B.text(), p.text], ["abcX\n", "abcX\n", "abcX\n"], "B does not see what A types");
    assert.ok(B.step("back"), "undo in B does nothing with what A typed (undo per view)");
    assert.deepEqual([A.text(), B.text(), p.text], ["abc\n", "abc\n", "abc\n"], "undo in B does not take back in both");
    assert.ok(A.step("before"), "redo in A does not bring back what B took back");
    assert.deepEqual([A.text(), B.text(), p.text], ["abcX\n", "abcX\n", "abcX\n"]);
    assert.ok(!B.step("before"), "after redoing there is nothing left ahead");
    assert.ok(B.step("back") && !A.step("back"), "the step was booked twice");
    assert.equal(p.text, "abc\n");
    A.release(); B.release();
  },
  async selection(G) {
    const p = await loaded("word pair\n");
    const A = view2(G, p), B = view2(G, p);
    A.select(4);
    A.type(4, "x", 1000); A.type(5, "y", 1100); // two keys in quick succession: ONE step (as in a single view)
    B.select(0);
    assert.ok(B.step("back"));
    assert.equal(B.text(), "word pair\n", "two keys in quick succession are not ONE step");
    assert.equal(B.state.selection.main.head, 4, "the selection of back then (before the key in A) does not return with the step");
    // A paste right after a key is a step of its own (the kind counts: input.paste does not merge with input.type).
    A.type(0, "q", 2000);
    A.report({ changes: { from: 1, insert: "ZZ" }, userEvent: "input.paste", annotations: Transaction.time.of(2050) });
    assert.ok(B.step("back"));
    assert.equal(B.text(), "qword pair\n", "a paste merges with the key before it (the kind got lost)");
    A.release(); B.release();
  },
  async foreignStays(G) {
    const p = await loaded("abc\n");
    const A = view2(G, p);
    A.type(3, "X");
    assert.ok(p.change([{ from: 0, to: 0, insert: "F" }]), "change without a view does not work");
    assert.equal(A.text(), "FabcX\n");
    assert.ok(A.step("back"));
    assert.equal(A.text(), "Fabc\n", "undo takes the foreign change along (or not the own key)");
    assert.ok(!A.step("back"), "the foreign change is in the history");
    A.release();
  },
  async rename(G) {
    const p = await loaded("let a = a;\n");
    const A = view2(G, p), B = view2(G, p);
    A.type(10, " ", 1000);
    assert.ok(p.change([{ from: 4, to: 5, insert: "b" }, { from: 8, to: 9, insert: "b" }], { history: true }), "rename share does not work");
    assert.deepEqual([A.text(), B.text()], ["let b = b; \n", "let b = b; \n"]);
    assert.ok(B.step("back"));
    assert.equal(B.text(), "let a = a; \n", "the rename share is not ONE step of its own (or not in the history)");
    assert.equal(A.text(), "let a = a; \n");
    A.release(); B.release();
  },
  async share(G) {
    const p = await loaded("abc\n");
    const A = view2(G, p);
    A.type(0, "1", 1000); A.type(1, " ", 5000);
    const B = view2(G, p); // split — the new group
    assert.ok(B.step("back") && B.text() === "1abc\n", "the new group does not have the history");
    A.release(); // the old group drops out — the new one keeps typing
    B.type(1, "2", 9000);
    assert.ok(B.step("back") && B.text() === "1abc\n", "the history let go although a view is still alive");
    assert.ok(B.step("back") && B.text() === "abc\n");
    B.release();
  },
  async newBegin(G) {
    const p = await loaded("abc\n");
    const A = view2(G, p);
    A.type(3, "X");
    A.release(); // no view left — the history lets go
    p.hold("other");
    assert.ok(p.change([{ from: 0, to: 0, insert: "F" }]));
    const B = view2(G, p);
    assert.equal(B.text(), "FabcX\n");
    assert.deepEqual(G.BufferHistory.of(p).depth, { back: 0, before: 0 }, "the history does not start anew although the buffer ran away from it");
    B.type(0, "Y");
    assert.ok(B.step("back") && B.text() === "FabcX\n", "after the fresh start undo does not take back the new key");
    B.release();
  },
};

test("Undo belongs to the buffer: two views, selection, foreign changes, rename, sharing, fresh start (with counter-tests)", async () => {
  for (const [name, check] of Object.entries(CHECKS)) {
    try { await check(real); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
  const notCaught = [];
  for (const k of sabotaged) {
    assert.equal(k.places, 1, `sabotage "${k.name}": the spot does not occur exactly once in the source`);
    let caught = false;
    try { await CHECKS[k.catches](k.mod); } catch { caught = true; }
    if (!caught) notCaught.push(k.name);
  }
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  console.log(`  [buffer-history] ${sabotaged.length} sabotages, each caught`);
});
