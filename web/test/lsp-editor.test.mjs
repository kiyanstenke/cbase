// The editor foundation of the language service (editor navigation like VS Code) — the computations, EXECUTED:
//
// (1) Reconciliation per buffer (lib/api/lsp.ts `lspQuestion`): `{ file, buffer, version }`, `text` only for a state the server does not
//     have from this window yet; `409 TEXT_MISSING` => repeated EXACTLY once with text (never a loop, never without text, never for
//     another code); renamed buffer => `close` of the old file and text under the new one; `lspClose` only unregisters a reported buffer;
//     the instance is in the address. Plus `lspEventAffects` (project and instance of the status event). The request with text goes
//     out only after the `close` has arrived (also a second question of the same buffer), and a failed `close` does not make the
//     request fail.
// (2) Positions (`lspPosOf`/`lspOffsetOf` over CodeMirror's `Text`) compute like lib/buffer.ts `offsetOf` — ONE conversion in two
//     forms, held against each other here (clamping beyond row and text).
// (3) WorkspaceEdit over several buffers (lib/lsp-change.ts): all files loaded and HELD, everything checked, then changed in one go —
//     unsaved, background tab per file without a tab, the triggering view through itself; an invalid list or a file that cannot be
//     loaded changes NOTHING; another view of the same file takes its share as its own step. `reconcileWith` reconciles EVERY open
//     buffer of the same language — also clean ones (which look first) and known ones — except the triggering one, and names the
//     version per buffer; if an affected buffer deviates from it on applying, NOTHING is changed ("changed").
// (4) The command table (lib/editor-commands.ts): hiding by capabilities, write protection and empty submenu, order of the groups;
//     no key and no shortcut twice, a duplicate id or key (even written differently) throws.
// (5) Sources: every W2 id has exactly one execution (components/code/lsp-commands.ts), CodePane calls nothing via `/ts/*` any more,
//     no longer has the Rename/Format pills, no `withoutLanguageService`, and attaches the extension exactly once; the diff tab on the
//     editable side; codeIntelli.ts is gone. Rename and code action reconcile, carry the state and report "Changed in the meantime".
//
// Every sabotage is a copy of the source with ONE changed place (the place occurs exactly once, otherwise the sabotage is stale); the
// assigned check must fail on it.
//
// Run:  node --test --test-reporter=tap web/test/lsp-editor.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Text } from "@codemirror/state";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");

const SOURCES = { lsp: read("src", "lib", "api", "lsp.ts"), change: read("src", "lib", "lsp-change.ts"), commands: read("src", "lib", "editor-commands.ts") };
const SABOTAGES = {
  lsp: {
    "text always": { old: "const withText = !(equal && old && old.version === version);", fresh: "const withText = true;", catches: "reconcile" },
    "text never": { old: "const withText = !(equal && old && old.version === version);", fresh: "const withText = false;", catches: "reconcile" },
    "no second attempt": { old: "return send(true); // exactly once with text", fresh: "throw e;", catches: "reconcile" },
    "second attempt without text": { old: "return send(true); // exactly once with text", fresh: "return send(false);", catches: "reconcile" },
    "every code repeated": { old: `if (withText || lspErrorCode(e) !== "TEXT_MISSING") throw e;`, fresh: "if (withText) throw e;", catches: "reconcile" },
    "renamed without close": { old: `const closing: Promise<void> = post(old.target, "close", { file: old.file, buffer }).then(() => {}, () => {});`, fresh: "const closing: Promise<void> = Promise.resolve();", catches: "reconcile" },
    "registration before unregistration": { old: "await open;", fresh: "", catches: "unregistration" },
    "unregistration not remembered": { old: "UNREGISTRATION.set(buffer, closing);", fresh: "", catches: "unregistration" },
    "close error breaks the question": { old: ".then(() => {}, () => {}); // a failing close", fresh: ".then(() => {}); // a failing close", catches: "unregistration" },
    "instance missing from the address": { old: "`${target.apiBase}/lsp/${action}${target.instance ? `?instance=${encodeURIComponent(target.instance)}` : \"\"}`", fresh: "`${target.apiBase}/lsp/${action}`", catches: "reconcile" },
    "character not clamped": { old: "return Math.min(l.from + ch, l.to);", fresh: "return l.from + ch;", catches: "positions" },
    "event of every project": { old: "if (String(evt.projectId ?? \"\") !== project) return false;", fresh: "", catches: "event" },
    "main only without identifier": { old: "const name = inst.startsWith(`${project}/`) ? inst.slice(project.length + 1) : inst;", fresh: "const name = inst;", catches: "event" },
  },
  change: {
    "change before checking": { old: "try { areas.set(p, asAreas(p.text, perFile.get(p.path) ?? [])); }", fresh: "try { p.change(perFile.get(p.path) ?? [], { editor: o.editor ?? null, history: true }); areas.set(p, []); }", catches: "change" },
    "without holding": { old: `held.push({ p, release: p.hold("other") });`, fresh: "held.push({ p, release: () => {} });", catches: "change" },
    "no background tab": { old: "p.change(b, { editor: o.editor ?? null, history: true });", fresh: "p.change(b, { history: true });", catches: "change" },
    "without history": { old: "p.change(b, { editor: o.editor ?? null, history: true });", fresh: "p.change(b, { editor: o.editor ?? null });", catches: "change" },
    "view bypassed": { old: "if (!(o.view?.buffer === p && o.view.apply(b)))", fresh: "if (true)", catches: "change" },
    "only unsaved reconciled": { old: "await Promise.all(open.map(async (p) => {", fresh: "await Promise.all(open.filter((p) => p.dirty).map(async (p) => {", catches: "reconcileWith" },
    "known ones skipped": { old: "await Promise.all(open.map(async (p) => {", fresh: "const { lspKnowsStatus: knows } = await import(\"./api/lsp.js\");\n  await Promise.all(open.filter((p) => !p.dirty || !knows(p)).map(async (p) => {", catches: "reconcileWith" },
    "clean ones do not look": { old: "await Promise.all(open.filter((p) => !p.dirty).map((p) => p.checkBack().catch(() => null)));", fresh: "", catches: "reconcileWith" },
    "trigger doubled": { old: "allBuffers().filter((p) => p !== except && ", fresh: "allBuffers().filter((p) => ", catches: "reconcileWith" },
    "other language included": { old: "&& lspLanguageOf(p.path)?.language === language);", fresh: ");", catches: "reconcileWith" },
    "version after the reconcile": { old: "try { await lspQuestion(p, \"sync\", {}); status.set(p, v); }", fresh: "try { await lspQuestion(p, \"sync\", {}); status.set(p, v + 1); }", catches: "reconcileWith" },
    "version not checked": { old: "if (o.state && (v === undefined ? p.dirty : v !== p.version)) return { kind: \"changed\", file: p.path };", fresh: "", catches: "reconcileWith" },
    "unseen unsaved counts": { old: "v === undefined ? p.dirty : v !== p.version", fresh: "v === undefined ? false : v !== p.version", catches: "reconcileWith" },
  },
  commands: {
    "capability ignored": { old: "if (b.needs && !situation.features.has(b.needs)) return false;", fresh: "", catches: "hide" },
    "write protection ignored": { old: "if (b.writing && !situation.writable) return false;", fresh: "", catches: "hide" },
    "empty submenu visible": { old: "if (b.submenu) return childrenOf(b.id, situation, k).length > 0;", fresh: "", catches: "hide" },
    "keys not normalized": { old: `return [...[...mods].sort(), key].join("-");`, fresh: "return name;", catches: "keys" },
    "duplicate key allowed": { old: "if (prior) throw new Error(", fresh: "if (false) throw new Error(", catches: "keys" },
  },
};
const FILE = { lsp: "api/lsp.ts", change: "lsp-change.ts", commands: "editor-commands.ts" };

// ── Compiling: the modules, their computations and one copy per sabotage, in ONE tsc run. `api/core.ts` is a replacement without network. ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-lsp-editor-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(path.join(src, "api"), { recursive: true });
for (const f of ["file-status.ts", "code-instance.ts", "diff-tab.ts", "chat-tabs.ts", "buffer.ts"]) fs.writeFileSync(path.join(src, f), read("src", "lib", f));
fs.writeFileSync(path.join(src, "api", "core.ts"), "export async function api<T = unknown>(p: string, _o?: RequestInit): Promise<T> { throw new Error(`no network in the test: ${p}`); }\n");
for (const [k, q] of Object.entries(SOURCES)) fs.writeFileSync(path.join(src, FILE[k]), q);
const copies = [];
for (const [k, list] of Object.entries(SABOTAGES)) {
  for (const [name, s] of Object.entries(list)) {
    const file = FILE[k].replace(/\.ts$/, `-sabotage-${copies.length}.ts`);
    fs.writeFileSync(path.join(src, file), SOURCES[k].replace(s.old, s.fresh));
    copies.push({ name, module: k, file, catches: s.catches, places: SOURCES[k].split(s.old).length - 1 });
  }
}
const allTs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allTs(path.join(dir, e.name)) : [path.join(dir, e.name)]));
try {
  execFileSync(process.execPath, [tsc, ...allTs(src), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--skipLibCheck", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "lsp-change.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = { lsp: await load("api/lsp.ts"), change: await load("lsp-change.ts"), commands: await load("editor-commands.ts") };
const P = await load("buffer.ts");
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: await load(k.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.warn("[test] temp directory was left behind:", String(e?.message || e).slice(0, 120)); }

const Z = { apiBase: "/api/projects/p1", instance: null };
const error = (fields, msg = "x") => Object.assign(new Error(msg), fields);

// ── (1) Reconciliation ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function reconcile(L) {
  L.forgetLspReconcile();
  const requests = [];
  let response = () => ({ ok: true });
  L.setLspTransport(async (url, o) => { const r = JSON.parse(o.body); requests.push({ url, r }); return response(url, r); });
  const K = { apiBase: "/api/projects/p1", instance: "p1/copy-k1" };
  const q1 = { target: K, path: "src/a.ts", buffer: "b1", version: 1, text: "one" };
  await L.lspQuestion(q1, "hover", { position: { line: 0, character: 1 } });
  assert.equal(requests[0].url, "/api/projects/p1/lsp/hover?instance=p1%2Fcopy-k1", "the instance is not in the address");
  assert.deepEqual(requests[0].r, { position: { line: 0, character: 1 }, file: "src/a.ts", buffer: "b1", version: 1, text: "one" }, "the first call does not carry the text");
  await L.lspQuestion(q1, "highlights", { position: { line: 0, character: 0 } });
  assert.ok(!("text" in requests[1].r), "the same state goes out with text again");
  assert.equal(L.lspKnowsStatus(q1), true);
  const q2 = { ...q1, version: 2, text: "two" };
  assert.equal(L.lspKnowsStatus(q2), false);
  await L.lspQuestion(q2, "diagnostics");
  assert.equal(requests[2].r.text, "two", "a new state goes out without text");
  // The server does not know it anyway (lease, restart): exactly one second attempt, WITH text.
  let missing = 1;
  response = (_u, r) => { if (!("text" in r) && missing-- > 0) throw error({ code: "TEXT_MISSING", httpStatus: 409 }); return { ok: true }; };
  let n = requests.length;
  await L.lspQuestion(q2, "hover", { position: { line: 0, character: 0 } });
  assert.equal(requests.length - n, 2, "TEXT_MISSING is not repeated exactly once");
  assert.ok(!("text" in requests[n].r) && requests[n + 1].r.text === "two", "the second attempt does not carry the text");
  // A TEXT_MISSING on a request WITH text ends (no loop); another code is never repeated.
  response = () => { throw error({ code: "TEXT_MISSING", httpStatus: 409 }); };
  n = requests.length;
  await assert.rejects(L.lspQuestion({ ...q1, version: 3, text: "three" }, "hover", {}));
  assert.equal(requests.length - n, 1, "a request with text is repeated after TEXT_MISSING (loop)");
  response = (_u, r) => { if (!("text" in r)) throw error({ code: "STALE_ACTION", httpStatus: 409 }); return { ok: true }; };
  await L.lspQuestion({ ...q1, version: 4, text: "four" }, "hover", {});
  n = requests.length;
  await assert.rejects(L.lspQuestion({ ...q1, version: 4, text: "fourth" }, "code_action_apply", { id: "x" }));
  assert.equal(requests.length - n, 1, "another error code is repeated");
  // Renamed: the old file unregisters, the new one comes with text.
  response = () => ({ ok: true });
  n = requests.length;
  const q5 = { ...q1, path: "src/b.ts", version: 4, text: "four" };
  await L.lspQuestion(q5, "hover", {});
  assert.deepEqual(requests.slice(n).map((a) => [a.url.split("?")[0].split("/").pop(), a.r.file, "text" in a.r]), [["close", "src/a.ts", false], ["hover", "src/b.ts", true]], "after renaming the unregistration/registration is wrong");
  // `lspClose`: once, and only for a reported buffer.
  n = requests.length;
  await L.lspClose(q5);
  await L.lspClose(q5);
  await L.lspClose({ buffer: "never-reported" });
  assert.deepEqual(requests.slice(n).map((a) => [a.url, a.r]), [["/api/projects/p1/lsp/close?instance=p1%2Fcopy-k1", { file: "src/b.ts", buffer: "b1" }]]);
  L.setLspTransport(null);
}

// If a buffer switches between workspace and project level (same `buffer`, same file — the same session at the server), the `close` of the
// old registration must arrive BEFORE the request with text. The `close` stays open here until the test answers it: the requests after it
// must not have gone out by then (the transport is called synchronously — without waiting they would be in the list at once). The `close`
// fails, the requests do not.
async function unregistration(L) {
  L.forgetLspReconcile();
  const requests = [];
  let dismiss = null;
  L.setLspTransport(async (url, o) => {
    const action = url.split("?")[0].split("/").pop();
    requests.push({ action, r: JSON.parse(o.body) });
    if (action === "close") return new Promise((_res, rej) => { dismiss = rej; });
    return { ok: true };
  });
  try {
    const W = { apiBase: "/api/workspaces/w1", instance: null }, Pr = { apiBase: "/api/projects/p1", instance: null };
    await L.lspQuestion({ target: W, path: "p1/a.ts", buffer: "u1", version: 1, text: "one" }, "hover", {});
    requests.length = 0;
    const q = { target: Pr, path: "a.ts", buffer: "u1", version: 1, text: "one" };
    const first = L.lspQuestion(q, "hover", {});
    const second = L.lspQuestion(q, "highlights", {});
    for (const f of [first, second]) f.catch(() => {}); // a caught sabotage should leave no unhandled failure
    assert.deepEqual(requests.map((a) => a.action), ["close"], "a request with text went out before the unregistration had arrived");
    assert.equal(typeof dismiss, "function");
    dismiss(new Error("close failed"));
    await first;
    await second;
    assert.deepEqual(requests.map((a) => [a.action, a.r.file, "text" in a.r]), [["close", "p1/a.ts", false], ["hover", "a.ts", true], ["highlights", "a.ts", true]], "unregistration and registration are not in this order");
    assert.equal(L.lspKnowsStatus(q), true, "after the move the server does not know the state");
  } finally { L.setLspTransport(null); }
}

function event(L) {
  const P1 = { apiBase: "/api/projects/p1", instance: null }, K1 = { apiBase: "/api/projects/p1", instance: "p1/copy-k1" }, W = { apiBase: "/api/workspaces/w1", instance: null };
  const e = (projectId, instance) => ({ type: "lsp/status", projectId, instance, language: "ts", state: "ready" });
  assert.equal(L.lspEventAffects(e("p1", "main"), P1), true);
  assert.equal(L.lspEventAffects(e("p1", "p1/main"), P1), true, "the main of a moved project (identifier p1/main) does not affect the route without instance=");
  assert.equal(L.lspEventAffects(e("p1", null), P1), true, "a project without a move (instance null)");
  assert.equal(L.lspEventAffects(e("p1", "p1/main"), K1), false);
  assert.equal(L.lspEventAffects(e("p1", "copy-k1"), P1), false);
  assert.equal(L.lspEventAffects(e("p1", "copy-k1"), K1), true);
  assert.equal(L.lspEventAffects(e("p1", "p1/copy-k1"), K1), true);
  assert.equal(L.lspEventAffects(e("p2", "main"), P1), false, "an event of a foreign project affects this one");
  assert.equal(L.lspEventAffects(e("p2", "main"), W), true, "at workspace level every one counts (only the server says the file)");
  assert.equal(L.lspEventAffects({ type: "project/instance", projectId: "p1" }, P1), false);
}

test("(1) reconciliation per buffer: text only for an unknown state, TEXT_MISSING exactly once, close on renaming and closing; status event (with counter-tests)", async () => {
  await reconcile(real.lsp);
  await unregistration(real.lsp);
  event(real.lsp);
});

// ── (2) Positions ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function positions(L) {
  const rowsStarts = (t) => { const s = [0]; for (let i = t.indexOf("\n"); i >= 0; i = t.indexOf("\n", i + 1)) s.push(i + 1); return s; };
  let checked = 0;
  for (const text of ["", "a", "ab\ncd", "x\n\ny\n", "äöü😀\nzz\n\t q"]) {
    const doc = Text.of(text.split("\n")), starts = rowsStarts(text);
    for (let line = 0; line <= starts.length + 1; line++) {
      for (let character = 0; character <= 8; character++) {
        assert.equal(L.lspOffsetOf(doc, { line, character }), P.offsetOf(starts, text.length, { line, character }), `${JSON.stringify(text)} ${line}:${character}`);
        checked += 1;
      }
    }
    for (let off = 0; off <= text.length; off++) assert.equal(L.lspOffsetOf(doc, L.lspPosOf(doc, off)), off);
    assert.deepEqual(L.lspPosOf(doc, text.length + 5), L.lspPosOf(doc, text.length));
  }
  const d = Text.of(["abc", "def"]);
  assert.deepEqual(L.lspAreaOf(d, { start: { line: 1, character: 2 }, end: { line: 0, character: 1 } }), { from: 1, to: 6 });
  return checked;
}
test("(2) positions: CodeMirror offset <-> {line, character} computes like lib/buffer.ts offsetOf, clamps beyond row and text (including counter-test)", () => {
  const n = positions(real.lsp);
  console.log(`# measurement: ${n} positions held against lib/buffer.ts offsetOf`);
});

// ── (3) WorkspaceEdit ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function disk(files) {
  const m = new Map(Object.entries(files));
  P.forgetAllBuffers();
  P.setTransport(async (url) => {
    const u = new URL(url, "http://x"), file = u.searchParams.get("path");
    if (!m.has(file)) throw error({ httpStatus: 400 }, `ENOENT: no such file or directory, stat '/x/${file}'`);
    return { content: m.get(file) };
  });
}
const r = (l1, c1, l2, c2) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
async function change(A) {
  const closed = [];
  const unsubscribe = P.atClose((p) => closed.push(p.path));
  try {
    disk({ "a.ts": "alpha beta", "b.ts": "beta gamma\nbeta", "c.ts": "free", "d.ts": "delta" });
    const editor = { open: [], openInBackground(p) { this.open.push(p.path); } };
    // c.ts is open in a view (the triggering one) — it changes through itself.
    const c = P.buffer(Z, "c.ts");
    const releaseC = c.hold("tab");
    await c.load();
    const view = { called: 0, apply(b) { this.called += 1; c.change(b); return true; } };
    // d.ts is open in ANOTHER view: its share goes as its own step into that view's history (⌘Z there takes it back).
    const d = P.buffer(Z, "d.ts");
    const releaseD = d.hold("tab");
    await d.load();
    const other = { ownSteps: 0, focus: P.newFocus(), apply() {}, own(b) { other.ownSteps += 1; d.ofView(other, b); return true; } };
    const releaseOther = d.connect(other);
    const e = await A.applyWorkspaceEdit(Z, { changes: [
      { file: "a.ts", edits: [{ range: r(0, 6, 0, 10), newText: "BETA" }] },
      { file: "b.ts", edits: [{ range: r(0, 0, 0, 4), newText: "BETA" }] },
      { file: "b.ts", edits: [{ range: r(1, 0, 1, 4), newText: "BETA" }] },
      { file: "c.ts", edits: [{ range: r(0, 0, 0, 4), newText: "FREE" }] },
      { file: "d.ts", edits: [{ range: r(0, 0, 0, 5), newText: "DELTA" }] },
    ] }, { editor, view: { buffer: c, apply: (b) => view.apply(b) } });
    assert.deepEqual(e, { kind: "ok", files: ["a.ts", "b.ts", "c.ts", "d.ts"] });
    assert.deepEqual([P.findBuffer(Z, "a.ts")?.text, P.findBuffer(Z, "b.ts")?.text, c.text, d.text], ["alpha BETA", "BETA gamma\nBETA", "FREE", "DELTA"], "not every file changed (two lists of the same file together?)");
    assert.equal(other.ownSteps, 1, "another open view did not get the share as its own step");
    releaseOther(); releaseD();
    assert.ok(P.findBuffer(Z, "a.ts").dirty && P.findBuffer(Z, "b.ts").dirty, "the change is not unsaved");
    assert.equal(view.called, 1, "the triggering view does not change its file through itself");
    assert.deepEqual(editor.open, ["a.ts", "b.ts"], "background tabs are wrong (only files without a tab)");
    assert.deepEqual([P.findBuffer(Z, "a.ts").holders, P.findBuffer(Z, "b.ts").holders], [0, 0], "a holder stayed stuck");
    assert.deepEqual(closed, [], "a buffer closed between loading and changing (unheld — atClose ran, the server would get close)");
    releaseC();

    // All or nothing: an overlapping list in b does not change a either.
    disk({ "a.ts": "alpha beta", "b.ts": "beta gamma" });
    const e2 = await A.applyWorkspaceEdit(Z, { changes: [
      { file: "a.ts", edits: [{ range: r(0, 6, 0, 10), newText: "BETA" }] },
      { file: "b.ts", edits: [{ range: r(0, 0, 0, 4), newText: "X" }, { range: r(0, 2, 0, 6), newText: "Y" }] },
    ] }, { editor });
    assert.equal(e2.kind, "error");
    assert.equal(e2.file, "b.ts");
    assert.equal(P.findBuffer(Z, "a.ts")?.text ?? "alpha beta", "alpha beta", "a was changed although b was invalid");
    assert.ok(!P.findBuffer(Z, "a.ts")?.dirty);
    // A file that cannot be loaded likewise changes nothing.
    disk({ "a.ts": "alpha beta" });
    const e3 = await A.applyWorkspaceEdit(Z, { changes: [{ file: "a.ts", edits: [{ range: r(0, 0, 0, 1), newText: "A" }] }, { file: "gone.ts", edits: [{ range: r(0, 0, 0, 0), newText: "x" }] }] });
    assert.equal(e3.kind, "error");
    assert.ok(!P.findBuffer(Z, "a.ts")?.dirty, "a was changed although gone.ts was missing");
  } finally { unsubscribe(); }
}
async function reconcileWith(A) {
  const L = real.lsp;
  L.forgetLspReconcile();
  const onDisk = { "a.ts": "one", "b.ts": "two", "c.py": "three", "d.ts": "four", "e.ts": "five", "f.ts": "six" };
  P.forgetAllBuffers();
  P.setTransport(async (url) => {
    const file = new URL(url, "http://x").searchParams.get("path");
    if (!(file in onDisk)) throw error({ httpStatus: 400 }, `ENOENT: no such file or directory, stat '/x/${file}'`);
    return { content: onDisk[file] };
  });
  const requests = [];
  L.setLspTransport(async (url, o) => { requests.push({ action: url.split("?")[0].split("/").pop(), r: JSON.parse(o.body) }); return {}; });
  const [a, b, c, d, e] = ["a.ts", "b.ts", "c.py", "d.ts", "e.ts"].map((f) => P.buffer(Z, f));
  const lose = [a, b, c, d, e].map((p) => p.hold("tab"));
  try {
    for (const p of [a, b, c, d, e]) await p.load();
    for (const p of [a, b, c, e]) p.change([{ from: 0, to: 0, insert: "x" }]);
    await L.lspQuestion(e, "hover", {}); // e: the server already knows the state — still goes out (lease expired, restart)
    onDisk["d.ts"] = "FOUR"; // d: clean, an agent wrote in the meantime
    requests.length = 0;
    const state = await A.reconcileWith(Z, "ts", b);
    const syncs = requests.filter((x) => x.action === "sync");
    assert.deepEqual(syncs.map((x) => x.r.file).sort(), ["a.ts", "d.ts", "e.ts"], "not every open ts buffer (without the triggering one, without python) — also clean and known ones");
    assert.equal(syncs.find((x) => x.r.file === "d.ts")?.r.text, "FOUR", "a clean buffer did not look before the reconcile");
    assert.deepEqual([...state].map(([p, v]) => [p.path, v]).sort(), [["a.ts", a.version], ["d.ts", d.version], ["e.ts", e.version]], "the state does not name the reconciled version per buffer");
    // The trigger adds its version; if an affected buffer changes until the server answers, NOTHING is changed.
    state.set(b, b.version);
    const edit = { changes: [{ file: "b.ts", edits: [{ range: r(0, 0, 0, 1), newText: "B" }] }, { file: "a.ts", edits: [{ range: r(0, 0, 0, 1), newText: "A" }] }] };
    a.change([{ from: 1, to: 1, insert: "!" }]); // typed while the server was computing
    const prior = [a.text, b.text];
    assert.deepEqual(await A.applyWorkspaceEdit(Z, edit, { state }), { kind: "changed", file: "a.ts" }, "a list against an old state was applied");
    assert.deepEqual([a.text, b.text], prior, "on \"changed\" something was changed after all");
    state.set(a, a.version);
    assert.equal((await A.applyWorkspaceEdit(Z, edit, { state })).kind, "ok", "the same state does not apply");
    // Not part of the reconcile: unsaved counts as changed (the server computed with the disk), a freshly loaded clean file does not.
    assert.deepEqual(await A.applyWorkspaceEdit(Z, { changes: [{ file: "c.py", edits: [{ range: r(0, 0, 0, 0), newText: "#" }] }] }, { state }), { kind: "changed", file: "c.py" }, "an unsaved buffer without reconcile applied");
    assert.equal((await A.applyWorkspaceEdit(Z, { changes: [{ file: "f.ts", edits: [{ range: r(0, 0, 0, 0), newText: "#" }] }] }, { state })).kind, "ok", "a freshly loaded clean file counted as changed");
  } finally {
    for (const release of lose) release({ dismiss: true });
    L.setLspTransport(null);
  }
}
test("(3) WorkspaceEdit over several buffers: held, checked, in one go — unsaved, background tabs, own view, other view with history; otherwise nothing; reconcileWith with versions (with counter-tests)", async () => {
  await change(real.change);
  await reconcileWith(real.change);
});

// ── (4) Command table ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ALL = ["rename", "format", "refactor", "source_action", "quick_fix", "definition"];
function enter(B) {
  B.emptyCommands();
  for (const b of B.W2_COMMANDS) B.registerCommand({ ...b, execute: () => {} });
}
function hide(B) {
  enter(B);
  const situation = (f, writable = true) => ({ features: new Set(f), language: f.length > 0, writable });
  const ids = (g) => g.map((x) => [x.group, x.commands.map((b) => b.id.replace("editor.action.", ""))]);
  assert.deepEqual(ids(B.menuGroups(situation([]), null)), [["change", ["changeAll"]], ["clipboard", ["clipboardCutAction", "clipboardCopyAction", "clipboardPasteAction"]]], "without a server there is more (or less) than clipboard and Change All Occurrences");
  assert.deepEqual(ids(B.menuGroups(situation(ALL), null)), [["change", ["rename", "changeAll", "formatDocument", "refactor", "sourceAction"]], ["clipboard", ["clipboardCutAction", "clipboardCopyAction", "clipboardPasteAction"]]]);
  assert.deepEqual(ids(B.menuGroups(situation(["rename"]), null)), [["change", ["rename", "changeAll"]], ["clipboard", ["clipboardCutAction", "clipboardCopyAction", "clipboardPasteAction"]]], "Format/Refactor are there without the capability");
  assert.deepEqual(ids(B.menuGroups(situation(ALL, false), null)), [["clipboard", ["clipboardCopyAction"]]], "a write-protected view offers changing");
  // A submenu ("Peek ▸") is there only if a child is visible.
  B.registerCommand({ id: "x.peek", title: "Preview", group: "navigation", rank: 50, submenu: true });
  assert.ok(!B.menuGroups(situation(ALL), null).some((g) => g.group === "navigation"), "an empty submenu is there");
  B.registerCommand({ id: "x.peekDef", title: "Peek Definition", parent: "x.peek", needs: "definition", execute: () => {} });
  assert.deepEqual(ids(B.menuGroups(situation(ALL), null))[0], ["navigation", ["x.peek"]], "the child is not in the submenu but at the top (or missing)");
  assert.deepEqual(B.childrenOf("x.peek", situation(ALL), null).map((b) => b.id), ["x.peekDef"]);
  assert.ok(!B.menuGroups(situation(["rename"]), null).some((g) => g.group === "navigation"), "without the child's capability the submenu is there");
  // What does not belong in the menu (key only): Quick Fix, F8/⇧F8, ⇧F10.
  for (const id of ["editor.action.quickFix", "editor.action.marker.next", "editor.action.marker.prev", "editor.action.showContextMenu"]) assert.ok(!B.menuGroups(situation(ALL), null).some((g) => g.commands.some((b) => b.id === id)), `${id} is in the menu`);
}
function keys(B) {
  enter(B);
  const all = B.W2_COMMANDS.flatMap((b) => (b.keys ?? []).map(B.keyNormalized));
  assert.equal(new Set(all).size, all.length, `duplicate key in W2: ${all}`);
  const shortcut = B.W2_COMMANDS.map((b) => b.shortcut).filter(Boolean);
  assert.equal(new Set(shortcut).size, shortcut.length, "duplicate shortcut in W2");
  assert.throws(() => B.registerCommand({ id: "editor.action.rename", title: "x" }), /already registered/);
  assert.throws(() => B.registerCommand({ id: "x.formatDifferent", title: "x", keys: ["Alt-Shift-F"] }), /already belongs/, "⌥⇧F written differently is not the same key");
  assert.throws(() => B.registerCommand({ id: "x.cmdF2", title: "x", keys: ["Cmd-F2"] }), /already belongs/, "Cmd-F2 and Mod-F2 are the same key on the Mac");
  const output = B.registerCommand({ id: "x.f12", title: "Go to Definition", group: "navigation", keys: ["F12"] });
  assert.throws(() => B.registerCommand({ id: "x.f12b", title: "y", keys: ["F12"] }));
  output();
  B.registerCommand({ id: "x.f12b", title: "y", keys: ["F12"] }); // unregistered frees the key
  assert.equal(B.keyNormalized("Ctrl--"), "ctrl--");
  assert.equal(B.keyNormalized("Ctrl-Shift--"), "ctrl-shift--");
  assert.equal(B.keyNormalized("Shift-Mod-p"), B.keyNormalized("Cmd-Shift-P"));
}
test("(4) command table: hiding by capability, write protection and empty submenu; no duplicate key/shortcut/id (with counter-tests)", () => {
  hide(real.commands);
  keys(real.commands);
});

// ── Counter-tests ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const CHECK = {
  reconcile: (m) => reconcile(m), unregistration: (m) => unregistration(m), positions: (m) => positions(m), event: (m) => event(m),
  change: (m) => change(m), reconcileWith: (m) => reconcileWith(m), hide: (m) => hide(m), keys: (m) => keys(m),
};
test("counter-tests: every sabotage is caught by its check", async () => {
  for (const k of sabotaged) {
    assert.equal(k.places, 1, `sabotage "${k.name}": the place occurs ${k.places}× in the source (stale)`);
    // lsp-change copies use the real api/lsp.js; reconcileWith sets its transport itself.
    let caught = false;
    try { await CHECK[k.catches](k.mod); } catch { caught = true; }
    assert.ok(caught, `sabotage "${k.name}" (${k.module}) was not caught by "${k.catches}"`);
  }
  real.lsp.setLspTransport(null);
  console.log(`# measurement: ${sabotaged.length} sabotages caught`);
});

// ── (5) Sources ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const Q = {
  commands: read("src", "components", "code", "lsp-commands.ts"),
  codePane: read("src", "components", "CodePane.tsx"),
  diffTab: read("src", "components", "code", "DiffTab.tsx"),
  rename: read("src", "components", "code", "lsp-rename.ts"),
  actions: read("src", "components", "code", "lsp-actions.ts"),
  i18n: read("src", "lib", "i18n-de.ts"),
};
function sources(q) {
  // Rename and code action reconcile BEFORE the request, add their own version to the state, pass it on and say so if something has
  // moved in the meantime.
  for (const [name, kind] of [["rename", "input.rename"], ["actions", "input.codeaction"]]) {
    const s = withoutComments(q[name]);
    const iStart = s.indexOf("const state = await reconcileWith(d.buffer.target, d.language, d.buffer);"), iSet = s.indexOf("state.set(d.buffer, d.buffer.version);"), iQuestion = s.indexOf("await questions(d, ", iSet + 1);
    assert.ok(iStart >= 0 && iSet > iStart && iQuestion > iSet, `${name}: no reconcile with state before the request`);
    assert.ok(s.includes(`view: overView(view, d, "${kind}"), state });`), `${name}: the state does not go to applyWorkspaceEdit`);
    assert.ok(s.includes(`if (e.kind === "changed") showHint(view, tr("Changed in the meantime — nothing changed."));`), `${name}: "Changed in the meantime" is not said`);
  }
  assert.ok(q.i18n.includes(`\n  "Changed in the meantime — nothing changed.": `), "\"Changed in the meantime\" without English text");
  const block = /const EXECUTION: Record<string, \(k: EditorContext\) => unknown> = \{([\s\S]*?)\n\};/.exec(q.commands);
  assert.ok(block, "lsp-commands.ts: EXECUTION not found (anchor stale)");
  const execution = [...block[1].matchAll(/^\s*"([\w.]+)":/gm)].map((x) => x[1]).sort();
  assert.deepEqual(execution, real.commands.W2_COMMANDS.map((b) => b.id).sort(), "not every W2 id has exactly one execution");
  const c = withoutComments(q.codePane);
  assert.ok(!/\/ts\//.test(c), "CodePane still calls /ts/* (the old service is gone)");
  assert.ok(!/codeIntelli|makeIntelliSense|isIntelliFile/.test(c), "CodePane still hangs on codeIntelli.ts");
  assert.ok(!/withoutLanguageService/.test(c), "the copy branch without language service is still there");
  assert.ok(!/>Rename<|>Format</.test(c), "the Rename/Format pills are still there");
  assert.equal((c.match(/editorExtensions\(/g) ?? []).length, 1, "CodePane does not attach the editor foundation exactly once");
  assert.ok(/prior: settings\.formatOnSave \? \(content\) => formattedText\(p, content, \{ tabSize: settings\.tabSize \}\) : undefined/.test(c), "Format on save does not go the same way as ⌥⇧F");
  assert.ok(/editorExtensions\(\{ buffer: run\.current\.buffer, editor: run\.current\.editor \?\? null(?:, navigation)? \}\)/.test(withoutComments(q.diffTab)), "the editable side of the diff tab does not have the editor foundation");
  assert.ok(!fs.existsSync(path.join(webDir, "src", "components", "codeIntelli.ts")), "components/codeIntelli.ts still exists");
}
test("(5) sources: every W2 id has its execution; CodePane without /ts/*, pills and copy branch, extension exactly once; diff tab with extension; rename/code action with state (with counter-tests)", () => {
  sources(Q);
  const SAB = {
    "execution missing": { ...Q, commands: Q.commands.replace(`  "editor.action.sourceAction": (k) => showCodeActions(k.view, "source"),\n`, "") },
    "/ts/ back": { ...Q, codePane: Q.codePane.replace("formattedText(p, content, { tabSize: settings.tabSize })", "calls(`/ts/format`)") },
    "pill back": { ...Q, codePane: `${Q.codePane}\nconst x = <button>Rename</button>;` },
    "diff tab without": { ...Q, diffTab: Q.diffTab.replace("editorExtensions({ buffer: run.current.buffer", "noExtensions({ buffer: run.current.buffer") },
    "rename without state": { ...Q, rename: Q.rename.replace(`view: overView(view, d, "input.rename"), state });`, `view: overView(view, d, "input.rename") });`) },
    "action without own version": { ...Q, actions: Q.actions.replace("state.set(d.buffer, d.buffer.version);", "") },
    "rename is silent": { ...Q, rename: Q.rename.replace(`if (e.kind === "changed") showHint(view, tr("Changed in the meantime — nothing changed."));`, "") },
    "hint without English": { ...Q, i18n: Q.i18n.replace(`  "Changed in the meantime — nothing changed.": `, `  "Changed meanwhile": `) },
  };
  for (const [name, q] of Object.entries(SAB)) {
    assert.ok(Object.keys(q).some((k) => q[k] !== Q[k]), `sabotage "${name}" does not apply (stale)`);
    assert.throws(() => sources(q), `sabotage "${name}" was not caught`);
  }
});
