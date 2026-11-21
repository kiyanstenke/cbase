// ONE buffer per file in the window (editor navigation as in VS Code) — lib/buffer.ts and the views on it.
//
// (1) The module, compiled with tsc and EXECUTED against a fake server (GET files/read, PUT files/write with `base`/409 like server
//     files.js): two views see the same keys (none catches its own echo), `version` counts every change, a change without a view opens the
//     background tab exactly when no tab holds the buffer, saving with `base` (409 ⇒ nothing written, re-read, the choice stands; an open
//     choice holds the save command back; keys during saving stay unsaved), save-all saves everything and a 409 hits only its file, draft,
//     re-reading (own text never replaced, a stale read does not count), lifetime (unsaved without a holder stays around, `dismiss` only for
//     the last holder), LSP areas, instance at every address, renaming. Inserted text always with "\n" (CRLF formatter), save-all only
//     takes held buffers or background tabs, a read before saving does not count even via `takeDisk` (diff tab), a rename share goes into
//     the history of the most recently focused view, renaming reports itself (history), a successful save too. What is waited for is the
//     event (the fake server says when a held request has arrived), never the clock.
//     A draft for an already open buffer is only "done" if its text is in the buffer (same identifier or same text); a clean buffer takes
//     it, a buffer with its own text says "deviating" and replaces nothing. Two buffers of the same file (`supersede`): clean target ⇒ the
//     text moves over and the source yields; both with own text ⇒ the source stays, visible to save-all; a target that is still loading
//     decides once more after loading; `draftFremd`.
//     Every sabotage of the module is caught by its check — among them the missing passing on to the other view.
// (2) The views (sources): the CodeMirror extension brings foreign changes in with `fromBuffer` and WITHOUT history and never sends echoes
//     back (plus the semantics of these annotations on @codemirror/state + @codemirror/commands: undo only takes the own keys); CodePane
//     (both places) and the right side of the diff tab hang on the buffer; save-all and the background tab are wired; a preview with unsaved
//     text becomes fixed and is never replaced; after a confirmed discard (instance switch, last tab of a target, deleted chat) detaching
//     discards; the diff tab reads with a read marker. With counter-tests.
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
const source = read("src", "lib", "buffer.ts");

// ── Sabotages of the module: each bites at exactly one place and is caught by its check ──────────────────────────────────────────────
const SABOTAGES = {
  "no passing on to the other view": { old: "for (const a of [...this.views]) if (a !== source) a.apply(areas);", fresh: "for (const a of [...this.views]) if (false) a.apply(areas);", catches: "twoViews" },
  "echo to the source": { old: "for (const a of [...this.views]) if (a !== source) a.apply(areas);", fresh: "for (const a of [...this.views]) a.apply(areas);", catches: "twoViews" },
  "version does not count": { old: "text: applyToText(s.text, areas), version: s.version + 1 };", fresh: "text: applyToText(s.text, areas), version: s.version };", catches: "twoViews" },
  "background also with a tab": { old: "if (editor && this.dirty && this.holderTab === 0) {", fresh: "if (editor && this.dirty) {", catches: "withoutView" },
  "no background tab": { old: "if (editor && this.dirty && this.holderTab === 0) {", fresh: "if (false) {", catches: "withoutView" },
  "LSP text not normalised": { old: "insert: insert(a.newText) }, i };", fresh: "insert: String(a.newText ?? \"\") }, i };", catches: "crlf" },
  "area text not normalised": { old: "if (!isLsp(a)) return { b: { from: a.from, to: a.to, insert: insert(a.insert) }, i };", fresh: "if (!isLsp(a)) return { b: { from: a.from, to: a.to, insert: String(a.insert ?? \"\") }, i };", catches: "crlf" },
  "replaceText not normalised": { old: "const c = minimalChange(this.statusValue.text, norm(fresh));", fresh: "const c = minimalChange(this.statusValue.text, fresh);", catches: "crlf" },
  "overlap allowed": { old: `if (b.from < end) throw new RangeError("Changes overlap");`, fresh: `if (b.from < -1) throw new RangeError("Changes overlap");`, catches: "lsp" },
  "LSP character not clamped": { old: "return Math.min(start + p.character, end);", fresh: "return start + p.character;", catches: "lsp" },
  "insert after replace": { old: "raw.sort((x, y) => x.b.from - y.b.from || x.b.to - y.b.to || x.i - y.i);", fresh: "raw.sort((x, y) => x.b.from - y.b.from || x.i - y.i);", catches: "lsp" },
  "without precondition": { old: "JSON.stringify(writeBody(this.pathValue, text, s.lineEnding, s.base))", fresh: "JSON.stringify(writeBody(this.pathValue, text, s.lineEnding, null))", catches: "save" },
  "line ending not applied": { old: "JSON.stringify(writeBody(this.pathValue, text, s.lineEnding, s.base))", fresh: `JSON.stringify(writeBody(this.pathValue, text, "\\n", s.base))`, catches: "save" },
  "keys after save lost": { old: "this.set({ saved: text, base: shaFromResponse(response),", fresh: "this.set({ saved: this.statusValue.text, base: shaFromResponse(response),", catches: "save" },
  "409 without re-read": { old: "          await this.checkBack({ onError: o.onError });\n", fresh: "", catches: "save" },
  "choice does not hold the save back": { old: "if (s0.inquiry) { this.set({ storageError: { kind: \"first-select\" } });", fresh: "if (false) { this.set({ storageError: { kind: \"first-select\" } });", catches: "save" },
  "formatting overwrites keys": { old: `if (typeof f === "string" && this.statusValue.text === prior) this.replaceText(f);`, fresh: `if (typeof f === "string") this.replaceText(f);`, catches: "save" },
  "save-all takes clean ones along": { old: "const open = allBuffers().filter((p) => p.saveForAll);", fresh: "const open = allBuffers().filter((p) => p.status.state === \"da\");", catches: "allSave" },
  "save-all takes lingering ones along": { old: "return this.dirty && !this.readonly && (this.holders > 0 || this.inBackground) &&", fresh: "return this.dirty && !this.readonly &&", catches: "allSave" },
  "save-all forgets background tabs": { old: "return this.dirty && !this.readonly && (this.holders > 0 || this.inBackground) &&", fresh: "return this.dirty && !this.readonly && this.holders > 0 &&", catches: "allSave" },
  "draft without basis": { old: "const m = withDraft(disk, e);", fresh: "const m = e && disk && e.content !== disk.text ? { editor: e.content, saved: disk.text, inquiry: null } : null;", catches: "draft" },
  "open buffer takes the draft": { old: `draft: o.draft ? this.takeDraft(o.draft) : "none" });`, fresh: `draft: "none" });`, catches: "draft" },
  "open buffer: every draft done": { old: `draft: o.draft ? this.takeDraft(o.draft) : "none" });`, fresh: `draft: o.draft ? "done" : "none" });`, catches: "draft" },
  "draft replaces own text": { old: `if (this.dirty || s.inquiry || s.wayAccepted || this.readonly) return "deviating";`, fresh: `if (s.inquiry || s.wayAccepted || this.readonly) return "deviating";`, catches: "draft" },
  "own draft counts as foreign": { old: `if ((e.buffer && e.buffer === this.buffer) || norm(e.content) === s.text) return "done";`, fresh: `if (norm(e.content) === s.text) return "done";`, catches: "draft" },
  "supersede never takes over": { old: `&& d.saved === s.saved && through.replaceText(s.text)) kind = "takenOver";`, fresh: `&& false) kind = "takenOver";`, catches: "supersede" },
  "supersede overwrites own text": { old: `else if (d.state === "loaded" && !through.dirty && !through.readonly`, fresh: `else if (d.state === "loaded" && !through.readonly`, catches: "supersede" },
  "supersede across another disk": { old: `&& d.saved === s.saved && through.replaceText(s.text))`, fresh: `&& through.replaceText(s.text))`, catches: "supersede" },
  "superseded discarded despite own text": { old: `if (this.standsIn(this.supersededThrough)) { this.dismiss(); return; } this.inBackground = true; }`, fresh: `this.dismiss(); return; }`, catches: "supersede" },
  "superseded stays lying": { old: `if (this.standsIn(this.supersededThrough)) { this.dismiss(); return; } this.inBackground = true; }`, fresh: `this.inBackground = true; }`, catches: "supersede" },
  "superseded invisible to save-all": { old: `if (this.standsIn(this.supersededThrough)) { this.dismiss(); return; } this.inBackground = true; }`, fresh: `if (this.standsIn(this.supersededThrough)) { this.dismiss(); return; } }`, catches: "supersede" },
  "save-all writes the text twice": { old: " && !this.standsIn(this.supersededThrough); }", fresh: "; }", catches: "supersede" },
  "supersede does not wait for loading": { old: `if (d.state === "loading") void through.load()`, fresh: `if (false) void through.load()`, catches: "supersede" },
  "foreign draft counts as own": { old: "Boolean(e && e.buffer !== p.buffer && norm(e.content) !== p.text)", fresh: "Boolean(e && norm(e.content) !== p.text)", catches: "supersede" },
  "deleted file discards the draft": { old: "if (!(e && isMissingReading(err))) {", fresh: "if (true) {", catches: "draft" },
  "own text replaced": { old: "const n = afterReread(s.saved, s.text, disk, s.wayAccepted);", fresh: "const n = afterReread(s.saved, s.saved, disk, s.wayAccepted);", catches: "newRead" },
  "stale read counts": { old: "if (seq !== this.writeSeq || this.savesCurrently) return null;", fresh: "if (false) return null;", catches: "stale" },
  "read marker bypassed": { old: "if (marker !== undefined && (marker !== this.writeSeq || this.savesCurrently)) return null;", fresh: "if (false) return null;", catches: "stale" },
  "rename share without history": { old: "if (o.history && b.length) {", fresh: "if (false) {", catches: "history" },
  "rename share into the oldest view": { old: ".sort((x, y) => (y.focus ?? 0) - (x.focus ?? 0))[0];", fresh: ".sort((x, y) => (x.focus ?? 0) - (y.focus ?? 0))[0];", catches: "history" },
  "saving does not report": { old: "        for (const fn of [...SAVED]) { try { fn(this); } catch { /* a callback does not stop saving */ } }\n", fresh: "", catches: "save" },
  "saving reports before writing": { old: "        const response = await this.calls(`/files/write`,", fresh: "        for (const fn of [...SAVED]) fn(this);\n        const response = await this.calls(`/files/write`,", catches: "save" },
  "renaming does not report": { old: "  for (const fn of [...RENAME]) { try { fn(target, old, fresh, z2); } catch { /* a listener does not stop the rename */ } }\n", fresh: "", catches: "rename" },
  "closes unsaved": { old: "    if (this.dirty) return; // unsaved without a holder", fresh: "    if (false) return; // unsaved without a holder", catches: "lifetime" },
  "dismiss also with another holder": { old: "if (o.dismiss && this.holders === 0 && this.dirty) this.dismiss();", fresh: "if (o.dismiss && this.dirty) this.dismiss();", catches: "lifetime" },
  "never dismiss": { old: "if (o.dismiss && this.holders === 0 && this.dirty) this.dismiss();", fresh: "if (false) this.dismiss();", catches: "lifetime" },
  "address without instance": { old: "return transport<T>(instancePath(`${this.targetValue.apiBase}${rest}`, this.targetValue.instance), opts);", fresh: "return transport<T>(`${this.targetValue.apiBase}${rest}`, opts);", catches: "instance" },
  "moving without target": { old: "p.move(target2, z2);", fresh: "p.move(target2);", catches: "relocate" },
  "moving under the old key": { old: "const k = bufferKey(z2, target2);", fresh: "const k = bufferKey(p.target, target2);", catches: "relocate" },
  "whole target without path": { old: "return old ? fresh + path.slice(old.length) : fresh ? `${fresh}/${path}` : path;", fresh: "return fresh + path.slice(old.length);", catches: "relocate" },
  "move reports the old target": { old: "fn(target, old, fresh, z2)", fresh: "fn(target, old, fresh, target)", catches: "relocate" },
  "move without folder drops": { old: "if (sameTarget(target, z2) && (!old || old === fresh)) return;", fresh: "if (!old || old === fresh) return;", catches: "relocate" },
  "renaming without folder": { old: "if (old && path !== old && !path.startsWith(`${old}/`)) return null;", fresh: "if (old && path !== old) return null;", catches: "rename" },
  "key of a foreign target moves along": { old: "parts[0] !== target.apiBase || ", fresh: "", catches: "rename" },
};

// ── Compile: the module, its computations (file-status, code-instance, diff-tab, chat-tabs) and one copy per sabotage, in ONE tsc run.
// `api/core.ts` is a replacement without network — the test sets the transport. Type errors only count in the real source.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-buffer-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(path.join(src, "api"), { recursive: true });
for (const f of ["file-status.ts", "code-instance.ts", "diff-tab.ts", "chat-tabs.ts"]) fs.writeFileSync(path.join(src, f), read("src", "lib", f));
fs.writeFileSync(path.join(src, "api", "core.ts"), "export async function api<T = unknown>(p: string, _o?: RequestInit): Promise<T> { throw new Error(`no network in the test: ${p}`); }\n");
fs.writeFileSync(path.join(src, "buffer.ts"), source);
const copies = Object.entries(SABOTAGES).map(([name, s], i) => {
  const file = `buffer-sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), source.replace(s.old, s.fresh));
  return { name, file, catches: s.catches, places: source.split(s.old).length - 1 };
});
const allTs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allTs(path.join(dir, e.name)) : [path.join(dir, e.name)]));
try {
  execFileSync(process.execPath, [tsc, ...allTs(src), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/buffer-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "buffer.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = await load("buffer.ts");
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: await load(k.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory stayed behind:", String(e?.message || e).slice(0, 120)); }

// ── The fake server: files per target, GET files/read and PUT files/write with `base` (409 CHANGED) like server files.js ──────────────
const sha = (t) => crypto.createHash("sha256").update(t, "utf8").digest("hex");
const Z = { apiBase: "/api/projects/p1", instance: null };
const K = { apiBase: "/api/projects/p1", instance: "p1/copy-k1" };
function server(files = {}) {
  const disk = new Map(Object.entries(files));
  const requests = [];
  const held = [];
  const error = (status, fields, msg = "x") => Object.assign(new Error(msg), { httpStatus: status, ...fields });
  const t = async (url, opts = {}) => {
    const u = new URL(url, "http://x");
    const body = opts.body ? JSON.parse(opts.body) : null;
    const a = { path: u.pathname, instance: u.searchParams.get("instance"), method: opts.method ?? "GET", file: u.searchParams.get("path") ?? body?.path, body };
    requests.push(a);
    if (held.length && a.method === held[0].method) { const h = held.shift(); h.present(); await h.gate; }
    const k = `${a.instance ?? ""}|${a.file}`;
    if (a.path.endsWith("/files/read")) {
      if (!disk.has(k)) throw error(400, {}, `ENOENT: no such file or directory, stat '/x/${a.file}'`);
      const c = disk.get(k);
      return { content: c, sha: sha(c) };
    }
    if (a.path.endsWith("/files/write")) {
      const now = disk.get(k);
      if (body.base !== undefined && (now === undefined || sha(now) !== body.base)) throw error(409, { code: "CHANGED", current: now === undefined ? null : sha(now), missing: now === undefined });
      disk.set(k, body.content);
      return { ok: true, sha: sha(body.content) };
    }
    throw error(404, {}, `unknown: ${a.path}`);
  };
  return {
    t, requests,
    set: (file, c, instance = "") => disk.set(`${instance}|${file}`, c),
    remove: (file, instance = "") => disk.delete(`${instance}|${file}`),
    read: (file, instance = "") => disk.get(`${instance}|${file}`),
    /** The next request of this method waits until `free()` is called; `free.reached` resolves as soon as it has arrived (the event instead of
     *  a pause on the clock). */
    hold: (method) => {
      let free, present;
      const gate = new Promise((r) => { free = r; }), reached = new Promise((r) => { present = r; });
      held.push({ method, gate, present });
      return Object.assign(() => free(), { reached });
    },
    writes: () => requests.filter((x) => x.method === "PUT"),
  };
}
const fresh = (m, files) => { m.forgetAllBuffers(); const s = server(files); m.setTransport(s.t); return s; };
/** A fake view: holds its own text, receives foreign areas, types itself. */
function view(m, p, editor = null) {
  const a = { text: p.text, echos: 0, editor, apply(b) { a.text = m.applyToText(a.text, b); a.echos += 1; } };
  a.release = p.connect(a);
  a.type = (b) => { a.text = m.applyToText(a.text, m.asAreas(a.text, b)); p.ofView(a, b); };
  return a;
}
const loaded = async (m, target, filePath, o) => { const p = m.buffer(target, filePath); const release = p.hold(); const r = await p.load(o); return { p, release, r }; };

// ── (1) Checks ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const CHECKS = {
  async twoViews(m) {
    fresh(m, { "|a.ts": "unit\npair\n" });
    const { p, r } = await loaded(m, Z, "a.ts");
    assert.equal(r.kind, "text");
    assert.equal(m.findBuffer(Z, "a.ts"), p, "ONE buffer per file in the window");
    assert.equal(m.buffer(Z, "a.ts"), p);
    const A = view(m, p), B = view(m, p);
    const v0 = p.version;
    assert.ok(v0 >= 1, "loading counts as a change");
    A.type([{ from: 0, to: 4, insert: "UNIT" }]);
    assert.deepEqual([p.text, A.text, B.text], ["UNIT\npair\n", "UNIT\npair\n", "UNIT\npair\n"], "B sees what A types — and A does not get its own echo");
    assert.deepEqual([A.echos, B.echos], [0, 1]);
    assert.equal(p.version, v0 + 1, "version counts every change");
    assert.ok(p.dirty);
    B.type([{ from: 10, to: 10, insert: "more\n" }]);
    assert.deepEqual([A.text, B.text, p.version], ["UNIT\npair\nmore\n", "UNIT\npair\nmore\n", v0 + 2]);
    A.type([{ from: 0, to: 4, insert: "unit" }, { from: 10, to: 15, insert: "" }]);
    assert.deepEqual([p.text, B.text, p.dirty, p.version], ["unit\npair\n", "unit\npair\n", false, v0 + 3], "typed back: clean (computed, no flag)");
    A.release();
    B.type([{ from: 0, to: 0, insert: "x" }]);
    assert.equal(A.text, "unit\npair\n", "a detached view gets nothing any more");
  },
  async withoutView(m) {
    fresh(m, { "|b.ts": "old\n" });
    const p = m.buffer(Z, "b.ts");
    const onlyPeek = p.hold("other");
    await p.load();
    const opened = [];
    const editor = { openInBackground: (q) => opened.push(q) };
    assert.equal(m.change(p, [{ from: 0, to: 3, insert: "new" }], { editor }), true);
    assert.deepEqual([p.text, opened.length, opened[0]], ["new\n", 1, p], "unsaved without a tab: the triggering editor opens the background tab");
    const tab = p.hold("tab");
    m.change(p, [{ from: 0, to: 0, insert: "x" }], { editor });
    assert.equal(opened.length, 1, "if a tab holds the buffer, nothing opens any more");
    tab(); onlyPeek();
    // A view without a tab (peek) with an editor: the same via `ofView`.
    const q = m.buffer(Z, "b.ts");
    const hold = q.hold("other");
    const peek = view(m, q, editor);
    peek.type([{ from: 0, to: 1, insert: "" }]);
    assert.equal(opened.length, 2, "peek without a tab: the editor of the view opens the background tab");
    peek.release(); hold();
  },
  async lsp(m) {
    fresh(m, { "|c.ts": "ab\ncd\n" });
    const { p } = await loaded(m, Z, "c.ts");
    m.change(p, [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }, newText: "XY" }]);
    assert.equal(p.text, "ab\nXY\n", "LSP areas (0-based) become offsets");
    m.change(p, [{ range: { start: { line: 0, character: 99 }, end: { line: 0, character: 99 } }, newText: "!" }]);
    assert.equal(p.text, "ab!\nXY\n", "a character beyond the line clamps to the line end");
    m.change(p, [{ from: 4, to: 6, insert: "Q" }, { from: 4, to: 4, insert: "1" }, { from: 4, to: 4, insert: "2" }]);
    assert.equal(p.text, "ab!\n12Q\n", "at the same place: insert before replace, insertions in their order");
    const v = p.version;
    assert.throws(() => m.change(p, [{ from: 0, to: 3, insert: "" }, { from: 2, to: 4, insert: "" }]), /overlap/);
    assert.throws(() => m.change(p, [{ from: 0, to: 99, insert: "" }]), /outside/);
    assert.deepEqual([p.text, p.version], ["ab!\n12Q\n", v], "a rejected change changes nothing");
  },
  async save(m) {
    const s = fresh(m, { "|d.ts": "x\r\ny\r\n" });
    const { p } = await loaded(m, Z, "d.ts");
    assert.deepEqual([p.text, p.status.lineEnding, p.status.base], ["x\ny\n", "\r\n", sha("x\r\ny\r\n")], "normalised, line ending and checksum remembered");
    m.change(p, [{ from: 0, to: 1, insert: "X" }]);
    assert.deepEqual(await p.save(), { kind: "saved" });
    assert.deepEqual(s.writes().at(-1).body, { path: "d.ts", content: "X\r\ny\r\n", base: sha("x\r\ny\r\n") }, "written with line ending and precondition");
    assert.deepEqual([p.dirty, p.status.base], [false, sha("X\r\ny\r\n")]);
    // Keys between the save command and the answer stay unsaved.
    m.change(p, [{ from: 1, to: 1, insert: "1" }]);
    const free = s.hold("PUT");
    const running = p.save();
    await free.reached; // the PUT is on its way
    m.change(p, [{ from: 2, to: 2, insert: "2" }]);
    free();
    await running;
    assert.deepEqual([s.read("d.ts"), p.status.saved, p.dirty], ["X1\r\ny\r\n", "X1\ny\n", true], "what was sent is what is saved");
    // 409: the disk has changed — nothing written, re-read, the choice stands.
    s.set("d.ts", "other\n");
    const prior = s.writes().length;
    assert.deepEqual(await p.save(), { kind: "changed" });
    assert.equal(s.read("d.ts"), "other\n", "nothing overwritten");
    assert.deepEqual([p.text, p.status.inquiry, p.status.storageError], ["X12\ny\n", { kind: "changed", text: "other\n", sha: sha("other\n") }, { kind: "changed" }]);
    // An open choice holds the save command back — nothing goes out.
    assert.deepEqual(await p.save(), { kind: "first-select" });
    assert.equal(s.writes().length, prior + 1, "with an open choice save writes nothing");
    // "Keep mine": deliberately overwrite, WITHOUT a precondition.
    p.keep();
    assert.deepEqual(await p.save(), { kind: "saved" });
    assert.equal(s.writes().at(-1).body.base, undefined);
    assert.equal(s.read("d.ts"), "X12\r\ny\r\n");
    // Formatting on save: only applies if the buffer still shows what was formatted.
    m.change(p, [{ from: 0, to: 0, insert: " " }]);
    await p.save({ prior: async (t) => t.trimStart() });
    assert.equal(s.read("d.ts"), "X12\r\ny\r\n", "formatted and saved");
    m.change(p, [{ from: 0, to: 0, insert: " " }]);
    await p.save({ prior: async (t) => { m.change(p, [{ from: 0, to: 0, insert: "!" }]); return t.trimStart(); } });
    assert.equal(s.read("d.ts"), "! X12\r\ny\r\n", "if someone typed during formatting, their text applies");
    // EVERY successful save reports itself in the window (`atSave` — a comparison re-reads its left side), a 409 and a held save do not.
    const reported = [];
    const off = m.atSave((x) => reported.push([x.target.apiBase, x.path, x.dirty]));
    m.change(p, [{ from: 0, to: 0, insert: "#" }]);
    await p.save();
    s.set("d.ts", "else\n");
    m.change(p, [{ from: 0, to: 0, insert: "#" }]);
    assert.deepEqual(await p.save(), { kind: "changed" });
    assert.deepEqual(await p.save(), { kind: "first-select" });
    off();
    assert.deepEqual(reported, [[Z.apiBase, "d.ts", false]], "reported: only the successful save, AFTER writing (the buffer is clean)");
  },
  async allSave(m) {
    const s = fresh(m, { "|e1.ts": "a\n", "|e2.ts": "b\n", "|e3.ts": "c\n" });
    const a = await loaded(m, Z, "e1.ts"), b = await loaded(m, Z, "e2.ts"), c = await loaded(m, Z, "e3.ts");
    m.change(a.p, [{ from: 0, to: 1, insert: "A" }]);
    m.change(b.p, [{ from: 0, to: 1, insert: "B" }]);
    s.set("e2.ts", "other\n");
    const r = await m.saveAll();
    assert.deepEqual(r.map((x) => [x.buffer.path, x.result.kind]).sort(), [["e1.ts", "saved"], ["e2.ts", "changed"]], "only the unsaved ones, per file");
    assert.deepEqual([s.read("e1.ts"), s.read("e2.ts"), s.read("e3.ts")], ["A\n", "other\n", "c\n"], "a 409 hits only its file");
    assert.deepEqual([a.p.dirty, b.p.dirty, b.p.status.inquiry?.kind, c.p.dirty], [false, true, "changed", false]);
    assert.equal(s.writes().length, 2, "the clean file does not go out");
    // A lingering buffer (detached, no holder) does not go out; one opened as a background tab does.
    s.set("e4.ts", "d\n"); s.set("e5.ts", "e\n");
    const staleOne = await loaded(m, Z, "e4.ts");
    m.change(staleOne.p, [{ from: 0, to: 1, insert: "D" }]);
    staleOne.release();
    const hg = m.buffer(Z, "e5.ts"), only = hg.hold("other");
    await hg.load();
    m.change(hg, [{ from: 0, to: 1, insert: "E" }], { editor: { openInBackground() {} } });
    only();
    const r2 = await m.saveAll();
    assert.deepEqual(r2.map((x) => x.buffer.path).sort(), ["e2.ts", "e5.ts"], "save-all took along a lingering buffer (or forgot the background tab)");
    assert.deepEqual([s.read("e4.ts"), s.read("e5.ts"), staleOne.p.dirty], ["d\n", "E\n", true]);
  },
  async draft(m) {
    fresh(m, { "|f1.ts": "a\n", "|f2.ts": "new\n", "|f5.ts": "q\n" });
    const f1 = await loaded(m, Z, "f1.ts", { draft: { base: "a\n", content: "b\n", sha: sha("a\n") } });
    assert.deepEqual([f1.r.draft, f1.p.text, f1.p.status.saved, f1.p.status.inquiry], ["takenOver", "b\n", "a\n", null], "basis = disk: simply unsaved");
    const f2 = await loaded(m, Z, "f2.ts", { draft: { base: "old\n", content: "mine\n", sha: sha("old\n") } });
    assert.deepEqual([f2.r.draft, f2.p.text, f2.p.status.saved, f2.p.status.base, f2.p.status.inquiry?.kind], ["takenOver", "mine\n", "old\n", sha("old\n"), "changed"], "the basis counts, the choice stands");
    // Already open in the window and with its OWN unsaved text — the draft replaces nothing and is NOT done (the holder would otherwise
    // delete it, and its text would be nowhere any more). Done only if it comes from this buffer or carries the same text.
    const again = await m.loadBuffer(Z, "f1.ts", { draft: { base: "a\n", content: "zz\n" } });
    assert.deepEqual([again.kind, again.draft, f1.p.text], ["text", "deviating", "b\n"], "already open in the window with own text: the draft counted as done (or replaced the text)");
    const own = await m.loadBuffer(Z, "f1.ts", { draft: { base: "a\n", content: "old\n", buffer: f1.p.buffer } });
    assert.deepEqual([own.draft, f1.p.text], ["done", "b\n"], "a draft of THIS buffer is done (the buffer is newer)");
    const sameText = await m.loadBuffer(Z, "f1.ts", { draft: { base: "a\n", content: "b\r\n" } });
    assert.equal(sameText.draft, "done", "the same text (normalised) is done");
    const clean = await loaded(m, Z, "f5.ts");
    const foreignOnClean = await m.loadBuffer(Z, "f5.ts", { draft: { base: "q\n", content: "Q\n", sha: sha("q\n") } });
    assert.deepEqual([foreignOnClean.draft, clean.p.text, clean.p.status.saved, clean.p.dirty, clean.p.status.inquiry], ["takenOver", "Q\n", "q\n", true, null], "a clean open buffer does not take the draft");
    clean.release({ dismiss: true });
    const gone = await loaded(m, Z, "f3.ts", { draft: { base: "x\n", content: "y\n" } });
    assert.deepEqual([gone.r.draft, gone.p.text, gone.p.status.inquiry], ["takenOver", "y\n", { kind: "deleted" }], "the file is gone, the draft stays");
    const equal = await loaded(m, Z, "f2.ts");
    assert.equal(equal.r.draft, "none");
    fresh(m, { "|f4.ts": "a\n" });
    const done = await loaded(m, Z, "f4.ts", { draft: { base: "x\n", content: "a\n" } });
    assert.deepEqual([done.r.draft, done.p.dirty], ["done", false], "equal to the disk: done");
  },
  async supersede(m) {
    // The same file has two buffers (the workspace view opened it before the project list was there; then its buffer moved to the project,
    // where one already stood). The fake server separates the two keys — on the disk it is the same file, `base` protects the second write (409).
    const W = { apiBase: "/api/workspaces/w1", instance: null };
    const s = fresh(m, { "|p1/h.ts": "a\n", "|h.ts": "a\n", "|p1/h2.ts": "a\n", "|h2.ts": "a\n", "|p1/h3.ts": "a\n", "|h3.ts": "a\n", "|p1/h4.ts": "a\n", "|h4.ts": "a\n" });
    // Clean target on the same disk: the text moves over, the source yields as soon as nobody holds it, save-all writes ONCE.
    const q = await loaded(m, W, "p1/h.ts"), t = await loaded(m, Z, "h.ts");
    m.change(q.p, [{ from: 0, to: 1, insert: "MINE" }]);
    assert.equal(q.p.supersede(t.p), "takenOver");
    assert.deepEqual([t.p.text, t.p.dirty, q.p.text, q.p.superseded], ["MINE\n", true, "MINE\n", t.p], "the text did not move over");
    assert.deepEqual([q.p.saveForAll, t.p.saveForAll], [false, true], "save-all would write the same text twice");
    q.release();
    assert.equal(m.findBuffer(W, "p1/h.ts"), null, "the source does not yield although its text is in the target");
    assert.equal(t.p.text, "MINE\n");
    // Both carry their own: nothing is replaced, the source stays — even without a holder, visible to save-all.
    const q2 = await loaded(m, W, "p1/h2.ts"), t2 = await loaded(m, Z, "h2.ts");
    m.change(q2.p, [{ from: 0, to: 1, insert: "X" }]);
    m.change(t2.p, [{ from: 0, to: 1, insert: "Y" }]);
    assert.equal(q2.p.supersede(t2.p), "separated");
    assert.deepEqual([q2.p.text, t2.p.text], ["X\n", "Y\n"], "a buffer with its own text was replaced");
    q2.release();
    assert.equal(m.findBuffer(W, "p1/h2.ts"), q2.p, "the source with its own text yielded (silently lost)");
    assert.deepEqual([q2.p.text, q2.p.saveForAll], ["X\n", true], "the lingering source is invisible to save-all (or discarded)");
    // Target on another disk (saved differently): take nothing over.
    const q3 = await loaded(m, W, "p1/h3.ts");
    s.set("h3.ts", "else\n");
    const t3 = await loaded(m, Z, "h3.ts");
    m.change(q3.p, [{ from: 0, to: 1, insert: "Z" }]);
    assert.equal(q3.p.supersede(t3.p), "separated", "a target on another disk took over the text");
    assert.deepEqual([t3.p.text, t3.p.dirty], ["else\n", false]);
    q3.release({ dismiss: true }); t3.release();
    // The target is still loading: after loading it decides once more (the same load promise, the decision stands before it continues).
    const q4 = await loaded(m, W, "p1/h4.ts");
    m.change(q4.p, [{ from: 0, to: 1, insert: "FOUR" }]);
    const t4 = m.buffer(Z, "h4.ts"), rel4 = t4.hold();
    const free = s.hold("GET");
    const running = t4.load();
    await free.reached;
    assert.equal(q4.p.supersede(t4), "separated");
    free();
    await running;
    assert.deepEqual([t4.text, t4.dirty], ["FOUR\n", true], "after the target loaded, the text did not move over");
    q4.release();
    assert.equal(m.findBuffer(W, "p1/h4.ts"), null);
    const written = await m.saveAll();
    assert.deepEqual(written.map((x) => [x.buffer.path, x.result.kind]).sort(), [["h.ts", "saved"], ["h2.ts", "saved"], ["h4.ts", "saved"], ["p1/h2.ts", "saved"]], "save-all did not take exactly the buffers with own text");
    rel4(); t.release(); t2.release();
    // `draftFremd`: only a draft that does NOT come from this buffer and carries different text.
    assert.deepEqual([
      m.draftForeign({ base: "", content: "else\n", buffer: t.p.buffer }, t.p),
      m.draftForeign({ base: "", content: "else\n", buffer: "foreign" }, t.p),
      m.draftForeign({ base: "", content: "MINE\r\n" }, t.p),
      m.draftForeign(null, t.p),
    ], [false, true, false, false], "draftFremd computes wrongly");
  },
  async newRead(m) {
    const s = fresh(m, { "|g.ts": "unit\n" });
    const { p } = await loaded(m, Z, "g.ts");
    const A = view(m, p);
    s.set("g.ts", "pair\n");
    const v = p.version;
    assert.equal(await p.checkBack(), "takeOver", "clean: take over silently");
    assert.deepEqual([p.text, A.text, p.version, p.dirty], ["pair\n", "pair\n", v + 1, false], "the view gets the new text");
    A.type([{ from: 0, to: 0, insert: "!" }]);
    s.set("g.ts", "more\n");
    assert.equal(await p.checkBack(), "inquiries");
    assert.deepEqual([p.text, p.status.inquiry?.kind], ["!pair\n", "changed"], "own text is NEVER replaced");
    p.loadAgain();
    assert.deepEqual([p.text, A.text, p.dirty, p.status.base], ["more\n", "more\n", false, sha("more\n")], "\"reload\": the disk wins");
    A.type([{ from: 0, to: 0, insert: "?" }]);
    s.remove("g.ts");
    assert.equal(await p.checkBack(), "inquiries");
    assert.deepEqual(p.status.inquiry, { kind: "deleted" }, "deleted under own text: the choice stands");
    p.keep();
    assert.equal(await p.checkBack(), "unchanged", "\"keep mine\" for a deleted file does not ask again");
  },
  async stale(m) {
    const s = fresh(m, { "|h.ts": "a\n" });
    const { p } = await loaded(m, Z, "h.ts");
    m.change(p, [{ from: 0, to: 1, insert: "b" }]);
    const free = s.hold("GET");
    const read = p.checkBack(); // still reads "a\n" …
    await free.reached;
    assert.deepEqual(await p.save(), { kind: "saved" }); // … while the save writes "b\n"
    free();
    assert.equal(await read, null, "a read that began before the save does not count");
    assert.deepEqual([p.status.inquiry, p.dirty, p.status.saved], [null, false, "b\n"]);
    // Whoever reads itself (diff tab) and calls `takeDisk` with the read marker from BEFORE the read gets the same — without a marker the
    // buffer jumped cleanly back to the old state.
    m.change(p, [{ from: 0, to: 1, insert: "c" }]);
    const marker = p.readMarker(), old = { text: s.read("h.ts"), sha: sha(s.read("h.ts")) }; // read: "b\n"
    assert.deepEqual(await p.save(), { kind: "saved" }); // written: "c\n"
    assert.equal(p.takeDisk(old, undefined, marker), null, "a disk from before the save does not count");
    assert.deepEqual([p.text, p.dirty, p.status.base], ["c\n", false, sha("c\n")], "the buffer jumped back to the old state");
    assert.equal(p.takeDisk({ text: "c\n", sha: sha("c\n") }, undefined, p.readMarker()), "unchanged", "a fresh marker counts");
  },
  async crlf(m) {
    // A formatter with CRLF sends "\r\n" — the buffer stays at "\n" (like every view), the line ending is only applied by writing.
    const s = fresh(m, { "|n.ts": "x\r\ny\r\n" });
    const { p } = await loaded(m, Z, "n.ts");
    m.change(p, [{ range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } }, newText: "a\r\nb\rc" }]);
    assert.deepEqual([p.text, p.text.includes("\r")], ["a\nb\nc\n", false], "LSP text with CRLF got into the buffer raw");
    m.change(p, [{ from: 0, to: 0, insert: "0\r\n" }]);
    assert.equal(p.text, "0\na\nb\nc\n", "a range with CRLF got into the buffer raw");
    p.replaceText("x;\r\ny;\r\n");
    assert.equal(p.text, "x;\ny;\n", "replaceText (format on save) takes CRLF raw");
    await p.save();
    assert.equal(s.read("n.ts"), "x;\r\ny;\r\n", "the line ending of the disk is applied on writing");
  },
  async history(m) {
    // A rename share on an already open file goes as a step of its own into the most recently focused view that can do so — the others
    // get it as an echo; without such a view via the buffer.
    fresh(m, { "|q.ts": "unit\n" });
    const { p } = await loaded(m, Z, "q.ts");
    const own = (a, focus) => Object.assign(a, { focus, ownSteps: 0, own(b) { a.ownSteps += 1; a.text = m.applyToText(a.text, b); p.ofView(a, b); return true; } });
    const old = own(view(m, p), m.newFocus()), newer = own(view(m, p), m.newFocus()), without = view(m, p);
    m.change(p, [{ from: 0, to: 4, insert: "UNIT" }], { history: true });
    assert.deepEqual([newer.ownSteps, old.ownSteps, old.echos, without.echos], [1, 0, 1, 1], "not the most recently focused view took the step");
    assert.deepEqual([p.text, old.text, newer.text, without.text], ["UNIT\n", "UNIT\n", "UNIT\n", "UNIT\n"]);
    m.change(p, [{ from: 0, to: 4, insert: "two" }]);
    assert.equal(newer.ownSteps, 1, "without `history` no view takes a step of its own");
    old.release(); newer.release(); without.release();
  },
  async lifetime(m) {
    fresh(m, { "|i.ts": "a\n", "|j.ts": "a\n" });
    const toward = [];
    const off = m.atClose((p) => toward.push(p.path));
    try {
      const i = await loaded(m, Z, "i.ts");
      m.change(i.p, [{ from: 0, to: 1, insert: "b" }]);
      i.release(); // detached, not closed
      assert.equal(m.findBuffer(Z, "i.ts"), i.p, "unsaved without a holder stays around");
      assert.deepEqual(toward, []);
      const tab1 = i.p.hold(), tab2 = i.p.hold();
      tab1({ dismiss: true });
      assert.deepEqual([i.p.dirty, toward], [true, []], "another holder still shows the file: nothing discarded");
      tab2({ dismiss: true });
      assert.deepEqual([m.findBuffer(Z, "i.ts"), toward, i.p.text], [null, ["i.ts"], "a\n"], "the last tab closed: discarded and closed");
      const j = await loaded(m, Z, "j.ts");
      const A = view(m, j.p);
      j.release();
      assert.equal(m.findBuffer(Z, "j.ts"), j.p, "a connected view keeps it open");
      A.release();
      assert.deepEqual([m.findBuffer(Z, "j.ts"), toward], [null, ["i.ts", "j.ts"]], "clean, without holder and view: closed");
    } finally { off(); }
  },
  async instance(m) {
    const s = fresh(m, {});
    s.set("k.ts", "copy\n", "p1/copy-k1");
    const { p } = await loaded(m, K, "k.ts");
    assert.equal(p.text, "copy\n");
    assert.notEqual(m.buffer(Z, "k.ts"), p, "main and copy are two buffers");
    m.change(p, [{ from: 0, to: 0, insert: "!" }]);
    await p.save();
    assert.deepEqual(s.requests.filter((a) => a.file === "k.ts").map((a) => [a.method, a.path, a.instance]),
      [["GET", "/api/projects/p1/files/read", "p1/copy-k1"], ["PUT", "/api/projects/p1/files/write", "p1/copy-k1"]], "every address carries the instance");
  },
  async rename(m) {
    fresh(m, { "|src/a.ts": "a\n", "|src/b.ts": "b\n", "|x.ts": "x\n" });
    const reported = [];
    const off = m.atRename((z, old, newer) => reported.push([z.apiBase, old, newer]));
    const a = await loaded(m, Z, "src/a.ts"), b = await loaded(m, Z, "src/b.ts"), x = await loaded(m, Z, "x.ts");
    m.renameBuffer(Z, "src", "lib");
    assert.deepEqual([m.findBuffer(Z, "lib/a.ts"), m.findBuffer(Z, "lib/b.ts"), m.findBuffer(Z, "src/a.ts"), a.p.path], [a.p, b.p, null, "lib/a.ts"], "the folder moves along");
    m.renameBuffer(Z, "x.ts", "y.ts");
    assert.deepEqual([m.findBuffer(Z, "y.ts"), x.p.key], [x.p, m.bufferKey(Z, "y.ts")]);
    off();
    assert.deepEqual(reported, [[Z.apiBase, "src", "lib"], [Z.apiBase, "x.ts", "y.ts"]], "renaming does not report (the history would not move along)");
    // Stocks keyed like the buffer (problems, git base) compute the SAME rule.
    const W = { apiBase: "/api/workspaces/w1", instance: null };
    assert.equal(m.renamedKey(m.bufferKey(Z, "src/a.ts"), Z, "src", "lib"), m.bufferKey(Z, "lib/a.ts"), "the folder takes the number along");
    assert.equal(m.renamedKey(m.bufferKey(Z, "srcx/a.ts"), Z, "src", "lib"), null, "a neighbour with the same beginning stays");
    assert.equal(m.renamedKey(m.bufferKey(W, "src/a.ts"), Z, "src", "lib"), null, "another target stays");
    assert.equal(m.renamedKey(m.bufferKey(Z, "a.ts"), Z, "", "p1", W), m.bufferKey(W, "p1/a.ts"), "the whole target moves");
  },
  async relocate(m) {
    // A file changes the project (or leaves it, or a project arises/falls) — the buffer moves WITH ITS TEXT under the new target; if one is
    // already there, it stays where it is.
    fresh(m, { "|a.ts": "a\n", "|src/b.ts": "b\n", "|src/c.ts": "c\n" });
    const W = { apiBase: "/api/workspaces/w1", instance: null };
    const reported = [];
    const off = m.atRename((z, old, newer, z2) => reported.push([z.apiBase, old, newer, z2.apiBase]));
    const a = await loaded(m, Z, "a.ts");
    view(m, a.p).type([{ from: 0, to: 0, insert: "x" }]);
    m.renameBuffer(Z, "a.ts", "p1/a.ts", W);
    assert.deepEqual([m.findBuffer(W, "p1/a.ts"), m.findBuffer(Z, "a.ts"), a.p.target, a.p.text, a.p.dirty], [a.p, null, W, "xa\n", true], "the buffer moves under the new target with its text");
    const b = await loaded(m, Z, "src/b.ts"), c = await loaded(m, Z, "src/c.ts");
    m.renameBuffer(Z, "", "fresh", W); // a whole target (the project folder itself)
    assert.deepEqual([m.findBuffer(W, "fresh/src/b.ts"), m.findBuffer(W, "fresh/src/c.ts"), m.findBuffer(Z, "src/b.ts")], [b.p, c.p, null], "the whole target moves");
    const d = m.buffer(Z, "d.ts"), dW = m.buffer(W, "d.ts");
    m.renameBuffer(Z, "d.ts", "d.ts", W);
    assert.deepEqual([m.findBuffer(Z, "d.ts"), m.findBuffer(W, "d.ts"), d.target], [d, dW, Z], "an occupied target stays untouched");
    off();
    assert.deepEqual(reported[0], [Z.apiBase, "a.ts", "p1/a.ts", W.apiBase], "moving does not report the new target (the history computed wrongly)");
  },
};

test("(1) lib/buffer.ts: two views, change without a view, LSP areas, CRLF, saving with base/409, save-all, draft, re-reading, read marker, history, lifetime, instance, renaming", async () => {
  for (const [name, check] of Object.entries(CHECKS)) {
    try { await check(real); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
});

test("(1) counter-tests on the module: each sabotage bites at exactly one place and is caught by its check", async () => {
  const notCaught = [];
  for (const s of sabotaged) {
    assert.equal(s.places, 1, `sabotage "${s.name}": the place occurs ${s.places}× in the source — the sabotage is stale`);
    let caught = false;
    try { await CHECKS[s.catches](s.mod); } catch { caught = true; }
    if (!caught) notCaught.push(`${s.name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  console.log(`  [buffer] ${sabotaged.length} sabotages on the module, each caught`);
});

// ── (2) The views ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const Q = {
  view: read("src", "components", "code", "buffer-view.ts"),
  editor: read("src", "components", "code", "BufferEditor.tsx"),
  codePane: read("src", "components", "CodePane.tsx"),
  groups: read("src", "components", "code", "EditorGroups.tsx"),
  diffTab: read("src", "components", "code", "DiffTab.tsx"),
  turnout: read("src", "components", "chat", "DiffTabSwitch.tsx"),
  hook: read("src", "components", "chat", "chatTabs.ts"),
  area: read("src", "components", "chat", "ChatCodeArea.tsx"),
  codeArea: read("src", "components", "CodeArea.tsx"),
  chatPane: read("src", "components", "chat", "ChatPane.tsx"),
};
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const SOURCE_CHECKS = {
  addon(q) {
    const a = withoutComments(q.view);
    assert.ok(a.includes("annotations: [fromBuffer.of(true), Transaction.addToHistory.of(false)],"), "foreign changes do not come in as an echo without history (undo per view)");
    // Undo belongs to the BUFFER (lib/buffer-history.ts, as in VS Code at the model) — typing is reported to the buffer via the history,
    // undo/redo of every view computes there, the history of the view no longer takes text changes. That the history is shared is computed
    // by web/test/buffer-history.test.mjs EXECUTED.
    assert.ok(a.includes("for (const tr of u.transactions) if (tr.docChanged && !isBufferEcho(tr)) g.ofView(viewHandle, tr);"), "an echo does not go back to the buffer (loop) or keys do not go into the history of the buffer");
    assert.ok(a.includes("const release = p.connect(viewHandle);") && a.includes("const unregister = g.logIn(o.editor ?? null);") && a.includes("destroy() { alive = false; release(); unregister(); },"), "the view does not connect with its life (buffer and history)");
    assert.ok(a.includes(`{ key: "Mod-z", run: (v) => stepIn(v, p, "back"), preventDefault: true },`) && a.includes(`{ key: "Mod-y", mac: "Mod-Shift-z", run: (v) => stepIn(v, p, "before"), preventDefault: true },`) && /Prec\.highest\(keymap\.of\(\[/.test(a), "undo/redo do not compute in the history of the buffer (or after that of the view)");
    assert.ok(a.includes(`const r = e.inputType === "historyUndo" ? "back" : e.inputType === "historyRedo" ? "before" : null;`), "\"Edit → Undo\" (beforeinput) bypasses the history of the buffer");
    assert.ok(a.includes("EditorState.transactionExtender.of((tr) => (tr.docChanged && tr.annotation(Transaction.addToHistory) === undefined ? { annotations: Transaction.addToHistory.of(false) } : null)),"), "the history of the view keeps taking text changes (undo there would be a second truth)");
    assert.ok(a.includes("return p.readonly ? [plugin, historyOfThePuffers(p), EditorState.readOnly.of(true)] : [plugin, historyOfThePuffers(p)];"), "a view without the history of the buffer");
  },
  editor(q) {
    const e = withoutComments(q.editor);
    assert.ok(e.includes("bufferView(p, { editor: run.current.editor }),"), "the file editor does not hang on the buffer via the ONE extension");
    assert.ok(e.includes("apply: (b) => take(echoSpec(b)) };") && e.includes("const tr = e.state.update(spec);"), "a resting state does not get foreign changes (or into its history)");
    // A resting state keeps the history of the file alive (otherwise it would start anew after every tab switch).
    assert.ok(e.includes("const connected = old.connect(view), unregister = BufferHistory.of(old).logIn(run.current.editor);") && e.includes("e.release = () => { connected(); unregister(); };"), "a resting state does not hold the history of the buffer (undo ends at the tab switch)");
    assert.ok(!/from "@uiw\/react-codemirror";[\s\S]*\bvalue=/.test(e), "the editor reconciles via `value` again");
  },
  codePane(q) {
    const c = withoutComments(q.codePane);
    assert.ok(!/<CodeMirror\b/.test(c) && !/@uiw\/react-codemirror/.test(c), "CodePane shows the text past its buffer (react-codemirror with `value`)");
    // ONE editor per group — CodePane shows the text via `GroupsEditor` (components/code/EditorGroups.tsx), and that is nothing but the
    // BufferEditor with the extensions of ITS file.
    assert.equal((c.match(/<GroupsEditor\b/g) ?? []).length, 1, "CodePane does not show the text exactly once via the BufferEditor (per group)");
    assert.equal((c.match(/<BufferEditor\b/g) ?? []).length, 0, "CodePane shows the text past the groups");
    assert.ok(withoutComments(q.groups).includes("return <BufferEditor {...rest} extensions={extensions} />;"), "the editor of a group is not the BufferEditor");
    assert.ok(c.includes("const { bufferOf, tick: bufferTick, change } = useBufferTabs(coord, tabs.map((x) => x.path), { dismiss });"), "the tabs do not hold their buffers");
    // A tab is a file, a preview or a diff — the dot comes from the buffer it shows (lib/editor-inputs.ts `bufferFile`: the file or the
    // unstaged change; a preview carries none).
    assert.ok(c.includes("const dirtyOf = useCallback((k: string) => { const d = E.bufferFile(k); return d !== null && Boolean(bufferOfRef.current(d)?.dirty); }, []);")
      && c.includes("const tabDirty = (k: string) => dirtyOf(k);"), "the dot on the tab does not come from the buffer");
    assert.match(c, /if \(mod && e\.altKey && e\.code === "KeyS"\) \{ e\.preventDefault\(\); void allSave\(\); \}(?:\s*\/\/[^\n]*)?\s*else if \(mod && e\.key\.toLowerCase\(\) === "s"\)/, "save-all does not save all (or save catches it first)");
    assert.ok(c.includes("const r = await saveAll({"), "save-all does not go via saveAll");
    assert.ok(c.includes("if (stRef.current) stRef.current.open(pf, { fixed: true, background: true });"), "the background tab in the chat is missing");
    // Via lib/editor-groups.ts `openInBackground` — that it does not come to the front is computed by web/test/editor-groups.test.mjs.
    assert.ok(c.includes("else applyGroups((s) => G.openInBackground(s, pf));"), "the background tab on Coding → Files is missing (or comes to the front)");
    assert.ok(c.includes("editor={editorHolder}"), "the editor does not hand its holder to its view");
  },
  diffTab(q) {
    const d = withoutComments(q.diffTab);
    assert.ok(d.includes("const { bufferOf, tick, change } = useBufferTabs(coord, writeSource && file ? [file] : []);"), "the diff tab does not hold the buffer of its file");
    assert.ok(d.includes("...(run.current.buffer ? [bufferView(run.current.buffer)] : [])]"), "the right side does not hang on the buffer via the ONE extension");
    assert.ok(d.includes("const startB = () => run.current.buffer?.text ?? bText.current ?? run.current.fresh;"), "the right side does not begin with the text of the buffer");
    assert.ok(d.includes("buffer={d.writable && buf?.status.state === \"loaded\" ? buf : null}"), "the writable side does not get its buffer");
    assert.ok(withoutComments(q.turnout).includes("bufferTarget={tab.target}"), "the diff tab in the chat does not run the buffer under the target of the tab (the file tab next to it would have another)");
  },
  backgroundInChat(q) {
    assert.ok(withoutComments(q.hook).includes("open(s, tab, { fixed: Boolean(o?.fixed), background: Boolean(o?.background), unsaved: carriesUnsaved(s) })"), "the chat does not pass `background` on to the model (lib/chat-tabs.ts open)");
  },
  previewFixed(q) {
    // Unsaved text makes the preview fixed, wherever it comes from, and `open` never replaces a preview with unsaved text — otherwise
    // replacing would let go of the buffer with `dismiss`. The dot also comes from a tab not yet loaded (rename/peek loaded the file).
    const h = withoutComments(q.hook);
    assert.ok(h.includes("useEffect(() => { const v = state.preview; if (v && unsaved.has(v)) setStatus((s) => keep(s, v)); }"), "unsaved text does not make the preview fixed");
    assert.ok(h.includes("unsavedRef.current.has(k) || Boolean(tabBuffer(tabOf(s, k))?.dirty)"), "`open` does not ask the buffer of the preview");
    assert.ok(h.includes("open(x, tab, { fixed: s.fixed, unsaved: carriesUnsaved(x) })"), "the jump from outside replaces a preview with unsaved text");
    assert.ok(withoutComments(q.codePane).includes("tabs.filter((x) => bufferOf(x.path)?.dirty).map((x) => x.path)"), "the dot on the tab needs a loaded tab");
  },
  unmount(q) {
    // After a confirmed discard the unsaved text goes with it, otherwise save-all would write it later after all.
    assert.ok(withoutComments(q.editor).includes("const dismissAll = dismissRef.current?.() === true; for (const e of m.values()) { e.off(); e.release(dismissAll ? { dismiss: true } : undefined); }"), "detaching does not ask `dismiss`");
    assert.ok(withoutComments(q.codePane).includes("useBufferTabs(coord, tabs.map((x) => x.path), { dismiss });"), "CodePane does not pass `dismiss` on to its tabs");
    const b = withoutComments(q.area);
    assert.ok(b.includes("const dismiss = useCallback(() => alive.current || chatIsDeleted(tabsRef.current.chatKey), []);") && b.includes("dismiss={dismiss}")
      && b.includes("useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);"), "the code area does not discard the last tab of a target (or also on a chat switch)");
    const c = withoutComments(q.codeArea);
    assert.ok(c.includes("if (unsaved > 0) dismiss.current = true;") && c.includes("dismiss={() => dismiss.current}") && c.includes("useEffect(() => { dismiss.current = false; }, [choice.param]);"), "the instance switch does not discard (or stays armed)");
    assert.ok(withoutComments(q.chatPane).includes("dropChatCache(id); chatDeleted(id);"), "a deleted chat leaves its unsaved text lying around");
    // The deleted chat only discards what ITS draft carries (lib/chat-tabs.ts dismissesDeletedChat).
    assert.ok(withoutComments(q.hook).includes("if (dismissesDeletedChat(p, readDraft(read(draftKey(chatId, keyName(t)))))) p?.dismiss();"), "the deleted chat discards text it does not carry");
    assert.ok(withoutComments(q.hook).includes("if (stale?.dirty && stale.holders === 0) stale.dismiss();"), "a closed tab leaves a lingering buffer lying around");
  },
  readMarker(q) {
    // The diff tab reads the disk itself — with the read marker from BEFORE the read, otherwise the buffer jumped back after a save.
    const d = withoutComments(q.diffTab);
    assert.ok(d.includes("const p0 = bufRef.current, marker = p0?.readMarker();") && d.includes("marker: p === p0 ? marker : undefined } });")
      && d.includes("p.takeDisk(disk, h.reading?.lineEnding, p === p0 ? marker : undefined);"), "the diff tab takes a disk without a read marker");
  },
  close(q) {
    // A closed tab takes its unsaved text with it (it was asked beforehand) — otherwise the buffer would lie unsaved in the window and
    // save-all would write what the human discarded. File tab: via `useBufferTabs` (dismiss only for the same target); diff tab in the
    // chat: `closeTab` discards if nobody but it holds the buffer.
    const e = withoutComments(q.editor);
    assert.ok(e.includes("released.push([e, e.targetK === targetKey]);") && e.includes("e.release(dismiss ? { dismiss: true } : undefined);"), "a closed file tab does not discard (or a target switch discards)");
    assert.ok(withoutComments(q.hook).includes("if (p?.dirty && p.holders <= (stateRef.current.active === key ? 1 : 0)) p.dismiss();"), "a closed diff tab leaves its unsaved text in the buffer");
  },
};
const SOURCE_SABOTAGES = {
  "echo into the history": { file: "view", old: "annotations: [fromBuffer.of(true), Transaction.addToHistory.of(false)],", fresh: "annotations: [fromBuffer.of(true)],", catches: "addon" },
  "echo back to the buffer": { file: "view", old: "if (tr.docChanged && !isBufferEcho(tr)) g.ofView", fresh: "if (tr.docChanged) g.ofView", catches: "addon" },
  "keys past the history": { file: "view", old: "g.ofView(viewHandle, tr);", fresh: "p.ofView(view, areasFrom(tr.changes));", catches: "addon" },
  "undo in the view": { file: "view", old: `{ key: "Mod-z", run: (v) => stepIn(v, p, "back"), preventDefault: true },`, fresh: "", catches: "addon" },
  "history of the view takes text": { file: "view", old: "EditorState.transactionExtender.of(", fresh: "EditorState.transactionExtender.of(() => null) && (", catches: "addon" },
  "view without the history of the buffer": { file: "view", old: ": [plugin, historyOfThePuffers(p)];", fresh: ": plugin;", catches: "addon" },
  "history lives without a view": { file: "view", old: "destroy() { alive = false; release(); unregister(); },", fresh: "destroy() { alive = false; release(); },", catches: "addon" },
  "resting without echo": { file: "editor", old: "apply: (b) => take(echoSpec(b)) };", fresh: "apply: () => {} };", catches: "editor" },
  "resting without history": { file: "editor", old: "e.release = () => { connected(); unregister(); };", fresh: "e.release = () => { connected(); }; unregister();", catches: "editor" },
  "CodePane with value again": { file: "codePane", old: "<GroupsEditor", fresh: "<CodeMirror value={pa?.text} /><GroupsEditor", catches: "codePane" },
  "group past the buffer": { file: "groups", old: "return <BufferEditor {...rest} extensions={extensions} />;", fresh: "return null;", catches: "codePane" },
  "dot on the tab without buffer": { file: "codePane", old: "return d !== null && Boolean(bufferOfRef.current(d)?.dirty); }, []);", fresh: "return d !== null && false; }, []);", catches: "codePane" },
  "save-all missing": { file: "codePane", old: "void allSave(); }", fresh: "}", catches: "codePane" },
  "background tab in front": { file: "codePane", old: "{ fixed: true, background: true }", fresh: "{ fixed: true }", catches: "codePane" },
  "right side without buffer": { file: "diffTab", old: "...(run.current.buffer ? [bufferView(run.current.buffer)] : [])]", fresh: "]", catches: "diffTab" },
  "diff under the target without instance": { file: "turnout", old: "bufferTarget={tab.target}", fresh: "bufferTarget={target}", catches: "diffTab" },
  "chat swallows background": { file: "hook", old: ", background: Boolean(o?.background), unsaved: carriesUnsaved(s) })", fresh: ", unsaved: carriesUnsaved(s) })", catches: "backgroundInChat" },
  "preview stays preview": { file: "hook", old: "if (v && unsaved.has(v)) setStatus((s) => keep(s, v));", fresh: "if (false) setStatus((s) => keep(s, v));", catches: "previewFixed" },
  "open does not see the buffer": { file: "hook", old: "unsavedRef.current.has(k) || Boolean(tabBuffer(tabOf(s, k))?.dirty)", fresh: "unsavedRef.current.has(k)", catches: "previewFixed" },
  "jump replaces the preview": { file: "hook", old: "{ fixed: s.fixed, unsaved: carriesUnsaved(x) }", fresh: "{ fixed: s.fixed }", catches: "previewFixed" },
  "dot only loaded": { file: "codePane", old: "tabs.filter((x) => bufferOf(x.path)?.dirty).map((x) => x.path)", fresh: "tabs.filter((x) => x.loaded && bufferOf(x.path)?.dirty).map((x) => x.path)", catches: "previewFixed" },
  "detaching never discards": { file: "editor", old: "e.release(dismissAll ? { dismiss: true } : undefined);", fresh: "e.release();", catches: "unmount" },
  "CodePane without dismiss": { file: "codePane", old: "useBufferTabs(coord, tabs.map((x) => x.path), { dismiss });", fresh: "useBufferTabs(coord, tabs.map((x) => x.path));", catches: "unmount" },
  "chat switch discards": { file: "area", old: "alive.current || chatIsDeleted(", fresh: "true || chatIsDeleted(", catches: "unmount" },
  "instance switch does not discard": { file: "codeArea", old: "if (unsaved > 0) dismiss.current = true;", fresh: "", catches: "unmount" },
  "instance switch stays armed": { file: "codeArea", old: "useEffect(() => { dismiss.current = false; }, [choice.param]);", fresh: "", catches: "unmount" },
  "deleted chat lies": { file: "chatPane", old: "dropChatCache(id); chatDeleted(id);", fresh: "dropChatCache(id);", catches: "unmount" },
  "deleted chat discards foreign text": { file: "hook", old: "if (dismissesDeletedChat(p, readDraft(read(draftKey(chatId, keyName(t)))))) p?.dismiss();", fresh: "if (p?.dirty && p.holders === 0) p.dismiss();", catches: "unmount" },
  "lingering tab buffer stays": { file: "hook", old: "if (stale?.dirty && stale.holders === 0) stale.dismiss();", fresh: "", catches: "unmount" },
  "diff tab without read marker": { file: "diffTab", old: "p.takeDisk(disk, h.reading?.lineEnding, p === p0 ? marker : undefined);", fresh: "p.takeDisk(disk, h.reading?.lineEnding);", catches: "readMarker" },
  "diff tab loads without read marker": { file: "diffTab", old: "marker: p === p0 ? marker : undefined } });", fresh: "} });", catches: "readMarker" },
  "closed file tab stays lying": { file: "editor", old: "e.release(dismiss ? { dismiss: true } : undefined);", fresh: "e.release();", catches: "close" },
  "target switch discards": { file: "editor", old: "released.push([e, e.targetK === targetKey]);", fresh: "released.push([e, true]);", catches: "close" },
  "closed diff tab stays lying": { file: "hook", old: "p.holders <= (stateRef.current.active === key ? 1 : 0)) p.dismiss();", fresh: "p.holders <= (stateRef.current.active === key ? 1 : 0)) void 0;", catches: "close" },
  "diff tab discards what a file tab shows": { file: "hook", old: "p.holders <= (stateRef.current.active === key ? 1 : 0)) p.dismiss();", fresh: "true) p.dismiss();", catches: "close" },
};

test("(2) The views hang on the buffer: extension (echo without history), file editor, CodePane with save-all and background tab, diff tab, closing discards, preview fixed, detaching discards, read marker (with counter-tests)", () => {
  for (const [name, check] of Object.entries(SOURCE_CHECKS)) {
    try { check(Q); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
  const notCaught = [];
  for (const [name, s] of Object.entries(SOURCE_SABOTAGES)) {
    assert.equal(Q[s.file].split(s.old).length - 1 >= 1, true, `sabotage "${name}": the place is missing`);
    let caught = false;
    try { SOURCE_CHECKS[s.catches]({ ...Q, [s.file]: Q[s.file].replace(s.old, s.fresh) }); } catch { caught = true; }
    if (!caught) notCaught.push(name);
  }
  assert.deepEqual(notCaught, [], "source sabotages that no check catches");
});

// The semantics the extension builds on: a transaction with `addToHistory: false` does not enter the history, and undo then takes back only
// the OWN keys — the foreign change stays, the own one is mapped across it. Counter-test: the same foreign change WITH history would be
// taken along by undo.
test("(2) Undo per view: a foreign change without history survives the undo of the own keys (with counter-test)", async () => {
  const { EditorState, Transaction } = await import(pathToFileURL(path.join(webDir, "node_modules", "@codemirror", "state", "dist", "index.js")).href);
  const { history, undo } = await import(pathToFileURL(path.join(webDir, "node_modules", "@codemirror", "commands", "dist", "index.js")).href);
  const run = (foreignWithoutHistory) => {
    let st = EditorState.create({ doc: "abc", extensions: history() });
    st = st.update({ changes: { from: 3, insert: "X" }, userEvent: "input.type" }).state; // own key
    st = st.update({ changes: { from: 0, insert: "F" }, annotations: foreignWithoutHistory ? [Transaction.addToHistory.of(false)] : [] }).state; // foreign
    undo({ state: st, dispatch: (tr) => { st = tr.state; } });
    return st.doc.toString();
  };
  assert.equal(run(true), "Fabc", "undo takes back only the own key, the foreign change stays");
  assert.notEqual(run(false), "Fabc", "counter-test: with history undo would take the foreign change along");
});
