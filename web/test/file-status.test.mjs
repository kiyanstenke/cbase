// The state of a file in the editor - lib/file-status.ts and the two editors that have it computed (file tab / diff tab of the code tabs).
//
// (1) The leaf `web/src/lib/file-status.ts`, compiled with tsc and EXECUTED: line endings (CRLF there and back), the checksum as
//     precondition of `PUT .../files/write` (409 `CHANGED`), the draft on first load (its base counts), rereading (an editor with its
//     own text is NEVER replaced, not even by a deleted file), after saving (keys typed after cmd+S stay unsaved). Each sabotage on
//     the leaf turns exactly one check red.
// (2) The binding: ONE editor computes with the leaf - the file's buffer (`lib/buffer.ts`): it reads every file through
//     `fromReading`, writes only with `writeBody`, treats 409 as "reread + choice", computes draft and rereading through the leaf.
//     CodePane (file tab in the chat AND Coding -> Files) and DiffTab (right side of the diff) read and write only through it, pass a
//     save on and say when a draft could not be remembered. The behavior of the buffer itself is checked by `buffer.test.mjs`. Each
//     binding comes with a built-in sabotage.
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
const source = read("src", "lib", "file-status.ts");
const buffer = read("src", "lib", "buffer.ts");
const codePane = read("src", "components", "CodePane.tsx");
const diffTab = read("src", "components", "code", "DiffTab.tsx");

const SABOTAGES = {
  "majority wrong": { old: `return crlf >= lf ? "\\r\\n" : "\\n";`, fresh: `return "\\r\\n";` },
  "lone CR stays": { old: `text.replace(/\\r\\n?/g, "\\n")`, fresh: `text.replace(/\\r\\n/g, "\\n")` },
  "line ending not applied": { old: `(ze === "\\n" ? text : norm(text).replace(/\\n/g, "\\r\\n"))`, fresh: `text` },
  "checksum unvalidated": { old: `sha: typeof r.sha === "string" && SHA.test(r.sha) ? r.sha : null`, fresh: `sha: typeof r.sha === "string" ? r.sha : null` },
  "base always included": { old: `...(base && SHA.test(base) ? { base } : {})`, fresh: `base: base ?? ""` },
  "every 409 a Changed": { old: `if (!o || o.httpStatus !== 409 || o.code !== "CHANGED") return null;`, fresh: `if (!o || o.httpStatus !== 409) return null;` },
  "every read error a deletion": { old: `return !!o && o.httpStatus === 400 && typeof o.message === "string" && /\\bENOENT\\b/.test(o.message);`, fresh: `return !!o && o.httpStatus === 400;` },
  "draft on old base applies": { old: `if (base === disk.text) return`, fresh: `if (true) return` },
  "deleted file discards the draft": { old: `if (disk === null) return { editor: content, saved: base, inquiry: { kind: "deleted" } };`, fresh: `if (disk === null) return null;` },
  "draft not normalized": { old: `const content = norm(e.content), base = norm(e.base);`, fresh: `const content = e.content, base = e.base;` },
  "own text replaced": { old: `const dirty = editor !== null && editor !== saved;`, fresh: `const dirty = false;` },
  "deleted replaces the editor": { old: `if (disk === null) return wayAccepted ?`, fresh: `if (disk === null) return { kind: "takeOver" }; if (false) return wayAccepted ?` },
  "accepted asks again": { old: `return wayAccepted ? { kind: "unchanged" } :`, fresh: `return false ? { kind: "unchanged" } :` },
  "same text asks": { old: `  if (disk.text === editor) return { kind: "clean" };\n`, fresh: `` },
  "keys after cmd+S lost": { old: `return editorNow === null || norm(editorNow) === norm(sent) ? "clean" : "unsaved";`, fresh: `return "clean";` },
};

// Compile: the real source and one copy per sabotage in ONE tsc run (a leaf without imports). Type errors count only in the real
// source - a sabotage may break the type, it is caught by behavior.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-file-status-"));
const src = path.join(tmp, "src");
const out = path.join(tmp, "out");
fs.mkdirSync(src);
fs.writeFileSync(path.join(src, "real.ts"), source);
const copies = Object.entries(SABOTAGES).map(([name, s], i) => {
  const file = `sabotage-${i}.ts`;
  fs.writeFileSync(path.join(src, file), source.replace(s.old, s.fresh));
  return { name, file, places: source.split(s.old).length - 1 };
});
try {
  execFileSync(process.execPath, [tsc, ...fs.readdirSync(src).map((f) => path.join(src, f)),
    "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "real.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const real = await load("real.ts");
const sabotaged = await Promise.all(copies.map(async (k) => ({ ...k, mod: await load(k.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory left behind:", String(e?.message || e).slice(0, 120)); }

// ── (1) The leaf ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const sha = (t) => crypto.createHash("sha256").update(t, "utf8").digest("hex"); // like server files.js content sha
const S1 = sha("one"), S2 = sha("two");
const error = (status, fields = {}, message = "x") => Object.assign(new Error(message), { httpStatus: status, ...fields });

function checkLineEndings(m) {
  assert.equal(m.lineEndingOf("a\nb\n"), "\n");
  assert.equal(m.lineEndingOf("a\r\nb\r\n"), "\r\n");
  assert.equal(m.lineEndingOf("a\r\nb\n"), "\r\n", "tie: CRLF");
  assert.equal(m.lineEndingOf("a\r\nb\nc\n"), "\n", "the majority");
  assert.equal(m.lineEndingOf(""), "\n");
  assert.equal(m.norm("a\r\nb\rc\n"), "a\nb\nc\n", "a lone CR is also a line ending for CodeMirror");
  assert.equal(m.withLineEnding("a\nb\n", "\r\n"), "a\r\nb\r\n");
  assert.equal(m.withLineEnding("a\nb\n", "\n"), "a\nb\n");
  // Round trip: read -> in the editor (only \n) -> save yields the file byte for byte (it must not show as unsaved right away).
  const raw = "one\r\ntwo\r\n";
  const l = m.fromReading({ content: raw, sha: sha(raw) });
  assert.deepEqual(l, { text: "one\ntwo\n", lineEnding: "\r\n", sha: sha(raw) });
  const body = m.writeBody("a.txt", l.text, l.lineEnding, l.sha);
  assert.deepEqual(body, { path: "a.txt", content: raw, base: sha(raw) }, "saving writes the file back with its line endings");
  assert.equal(sha(body.content), body.base, "the precondition is the checksum of exactly the bytes that were read");
}
function checkPrecondition(m) {
  assert.equal(m.fromReading({ binary: true }), null, "no text, no state");
  assert.equal(m.fromReading({ content: "x", sha: "short" })?.sha, null, "a checksum that is none is unknown");
  assert.equal(m.fromReading({ content: "x" })?.sha, null, "an old server without sha: no precondition");
  assert.deepEqual(m.writeBody("a", "x", "\n", null), { path: "a", content: "x" }, "no base, no precondition (no empty field)");
  assert.deepEqual(m.writeBody("a", "x", "\n", "not-hex"), { path: "a", content: "x" });
  assert.equal(m.shaFromResponse({ ok: true, sha: S1 }), S1);
  assert.equal(m.shaFromResponse({ ok: true }), null);
  assert.deepEqual(m.isChangedError(error(409, { code: "CHANGED", current: S2 })), { current: S2, missing: false });
  assert.deepEqual(m.isChangedError(error(409, { code: "CHANGED", current: null, missing: true })), { current: null, missing: true }, "the file is gone");
  assert.equal(m.isChangedError(error(409, { code: "SERVICE_RUNNING" })), null, "another 409 is not a changed file");
  assert.equal(m.isChangedError(error(400, { code: "CHANGED" })), null);
  assert.equal(m.isChangedError(null), null);
  assert.equal(m.isMissingReading(error(400, {}, "ENOENT: no such file or directory, stat '/x/a.txt'")), true);
  assert.equal(m.isMissingReading(error(400, {}, "EACCES: permission denied")), false, "another read error is not a deletion");
  assert.equal(m.isMissingReading(error(500, {}, "ENOENT")), false);
}
function checkDraft(m) {
  const P = (text, s = S1) => ({ text, sha: s });
  assert.equal(m.withDraft(P("a\n"), null), null, "no draft");
  assert.equal(m.withDraft(P("a\n"), { base: "x\n", content: "a\n" }), null, "equal to the disk: done");
  assert.equal(m.withDraft(P("a\n"), { base: "x\r\n", content: "a\r\n" }), null, "equal to the disk, remembered only with CRLF: done");
  assert.deepEqual(m.withDraft(P("a\n"), { base: "a\n", content: "b\n" }), { editor: "b\n", saved: "a\n", inquiry: null }, "base = disk: only unsaved");
  // The disk changed since the draft: saved is the BASE, the choice stands (the draft does not apply against the new disk).
  assert.deepEqual(m.withDraft(P("new\n", S2), { base: "a\n", content: "b\n" }), { editor: "b\n", saved: "a\n", inquiry: { kind: "changed", text: "new\n", sha: S2 } });
  assert.deepEqual(m.withDraft(null, { base: "a\n", content: "b\n" }), { editor: "b\n", saved: "a\n", inquiry: { kind: "deleted" } }, "the file is gone, the draft stays");
}
function checkNewRead(m) {
  const P = (text) => ({ text, sha: S2 });
  assert.deepEqual(m.afterReread("a", "a", P("a")), { kind: "unchanged" });
  assert.deepEqual(m.afterReread("a", "a", P("b")), { kind: "takeOver" }, "clean: take over silently");
  assert.deepEqual(m.afterReread("a", null, P("b")), { kind: "takeOver" }, "without editor like clean");
  assert.deepEqual(m.afterReread("a", "a", null), { kind: "takeOver" }, "clean and deleted: no question");
  // Own text is never replaced.
  assert.deepEqual(m.afterReread("a", "mine", P("b")), { kind: "inquiries", inquiry: { kind: "changed", text: "b", sha: S2 } });
  assert.deepEqual(m.afterReread("a", "mine", P("a")), { kind: "unchanged" }, "the disk is still the saved one");
  assert.deepEqual(m.afterReread("a", "mine", P("mine")), { kind: "clean" }, "an agent wrote exactly my text");
  // Deleted under own text - the question; if the human said "keep", not again.
  assert.deepEqual(m.afterReread("a", "mine", null), { kind: "inquiries", inquiry: { kind: "deleted" } });
  assert.deepEqual(m.afterReread("", "mine", null, true), { kind: "unchanged" }, "accepted: as long as it stays gone, no new question");
  assert.deepEqual(m.afterReread("", "mine", P("there"), true), { kind: "inquiries", inquiry: { kind: "changed", text: "there", sha: S2 } }, "it came back: against its text");
}
function checkAfterSave(m) {
  assert.equal(m.afterSave("a\n", "a\n"), "clean");
  assert.equal(m.afterSave("a\n", "a\nb"), "unsaved", "keys between cmd+S and the answer stay unsaved");
  assert.equal(m.afterSave("a\r\n", "a\n"), "clean", "compared normalized");
  assert.equal(m.afterSave("a\n", null), "clean");
}
const CHECKS = [checkLineEndings, checkPrecondition, checkDraft, checkNewRead, checkAfterSave];
const checkEverything = (m) => { for (const p of CHECKS) p(m); };

test("(1) line endings: remembered, normalized, reapplied on save - CRLF byte for byte there and back", () => checkLineEndings(real));
test("(1) precondition: sha from files/read, base on files/write, 409 CHANGED, ENOENT", () => checkPrecondition(real));
test("(1) draft on first load: its base counts, when deleted it stays", () => checkDraft(real));
test("(1) reread: own text is never replaced, deleted is a question, accepted no new one", () => checkNewRead(real));
test("(1) after save: keys typed after cmd+S stay unsaved", () => checkAfterSave(real));
test("(1) sabotages on the leaf: each hits exactly one spot and turns the check red", () => {
  const open = [];
  for (const s of sabotaged) {
    assert.equal(s.places, 1, `sabotage "${s.name}" hits ${s.places} spots (instead of one) - its wording is not (uniquely) in lib/file-status.ts`);
    try { checkEverything(s.mod); open.push(s.name); } catch { /* caught */ }
  }
  assert.deepEqual(open, [], "sabotages that no check catches");
});

// ── (2) The binding: the buffer applies the leaf, the editors go through the buffer ─────────────────────────────────────────────
// The body of a function or method: from its head to the line that ends at the head's indentation with `}, [` (useCallback), `};` or
// `}`.
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
function body(s, header) {
  const i = s.indexOf(header);
  if (i < 0) throw new Error(`not found: ${header}`);
  const row = s.lastIndexOf("\n", i) + 1;
  const inset = s.slice(row, i).match(/^ */)[0];
  const end = s.slice(i).search(new RegExp(`\\n${inset}\\}(, \\[|;|\\n)`));
  if (end < 0) throw new Error(`end not found: ${header}`);
  return s.slice(i, i + end);
}
function checkBuffer(s) {
  assert.match(s, /^import \{[^}]*\bfromReading\b[^}]*\bwithDraft\b[^}]*\bafterReread\b[^}]*\bwriteBody\b[^}]*\} from "\.\/file-status\.js";$/m, "lib/buffer.ts does not compute through lib/file-status.ts");
  // Every reading of a file goes through fromReading (normalized, with line ending and checksum).
  const readings = [...s.matchAll(/`\/files\/read\?path=/g)];
  assert.ok(readings.length >= 2, `only ${readings.length} readings found - the reader no longer hits`);
  for (const l of readings) assert.ok(s.slice(l.index, l.index + 400).includes("fromReading(r)"), `a reading without fromReading: ...${s.slice(l.index, l.index + 80)}`);
  // Written exactly once, with line ending and precondition.
  assert.equal((s.match(/`\/files\/write`/g) ?? []).length, 1, "files/write occurs exactly once (save)");
  const save = body(s, "async save(");
  assert.match(save, /JSON\.stringify\(writeBody\(this\.pathValue, text, s\.lineEnding, s\.base\)\)/, "the buffer writes without line ending or precondition");
  assert.match(save, /if \(isChangedError\(e\)\) \{[\s\S]{0,300}await this\.checkBack\(/, "a 409 CHANGED does not reread (the choice would never appear)");
  assert.match(save, /this\.set\(\{ saved: text, base: shaFromResponse\(response\),/, "saved is not what was sent");
  assert.match(save, /if \(s0\.inquiry\) \{ this\.set\(\{ storageError: \{ kind: "first-select" \} \}\);/, "an open choice does not stop cmd+S");
  assert.match(save, /if \(typeof f === "string" && this\.statusValue\.text === prior\) this\.replaceText\(f\);/, "formatting on save overwrites keys that came meanwhile");
  // First load through withDraft, rereading through afterReread.
  assert.match(body(s, "private async loadNow("), /const m = withDraft\(disk, e\);/, "loading does not compute the draft through withDraft");
  assert.match(body(s, "takeDisk(disk: Disk"), /const n = afterReread\(s\.saved, s\.text, disk, s\.wayAccepted\);/, "takeDisk does not compute through afterReread");
}
function checkCodePane(s) {
  const c = withoutComments(s);
  // Reading and writing happen only in the buffer - a second path would be a second state of the same file.
  assert.doesNotMatch(c, /\/files\/(read|write)/, "CodePane reads or writes a file past the buffer");
  assert.match(s, /^import \{[^}]*\bloadBuffer\b[^}]*\} from "@\/lib\/buffer";$/m, "CodePane does not load through lib/buffer.ts");
  const load = body(s, "const loadTab = useCallback(");
  assert.match(load, /loadBuffer\(k\.target, k\.path, \{ draft: stRef\.current\?\.draft\.read\(path\) \?\? null,/, "the draft does not reach the buffer (withDraft computes there)");
  assert.match(load, /r\.draft === "done"\) \{ stRef\.current\?\.draft\.write\(path, null\);/, "a finished draft stays around and comes back on the next open");
  const save = body(s, "const saveFile = useCallback(");
  assert.match(save, /const r = await p\.save\(\{/, "saveFile does not save through the buffer");
  assert.match(save, /if \(r\.kind !== "saved"\) return;\s*stRef\.current\?\.saved\?\.\(path\);/, "a save does not nudge the tabs of the same target");
  assert.match(body(s, "const readNew = useCallback("), /bufferOf\(x\.path\)\?\.checkBack\(\{/, "readNew does not read through the buffer (afterReread)");
  // The draft carries the checksum of its base; what could not be remembered is said.
  const saveValue = body(s, "const saveDrafts = useCallback(");
  assert.match(saveValue, /const ok = s\.draft\.write\(x\.path, \{ base: saved, content: text, at: Date\.now\(\), buffer: p\.buffer, \.\.\.\(sha \? \{ sha \} : \{\}\) \}\);/, "the draft without the checksum of its base or without the id of its buffer");
  // A remembered draft that carries something other than this tab's buffer (handover on relocation) is not overwritten - the tab
  // writes only once it has written itself (lib/buffer.ts draftFremd).
  assert.match(saveValue, /\|\| \(!last && draftForeign\(s\.draft\.read\(x\.path\), p\)\)\) continue;/, "a foreign draft is overwritten with the buffer's text");
  assert.match(saveValue, /notRemembered\.set\(x\.path, !ok\);/, "a draft that was not remembered stays silent");
  assert.match(s, /\{active && !active\.loaded && <div[^>]*data-code-loading>\{waitingText\(coord, t\)\}<\/div>\}/, "the waiting file tab does not show the error when reading the projects");
  assert.match(s, /\{active\.notRemembered && <span[^>]*data-code-not-remembered>\{t\("Too large for a draft — it will not survive a reload; save before closing\."\)\}<\/span>\}/, "the \"too large\" hint is missing");
  assert.match(s, /\{pa\?\.status\.storageError && <span[^>]*data-code-save-error>\{storageErrorText\(pa\.status\.storageError\)\}<\/span>\}/, "a save error (also the 409 from alt+cmd+S) is missing");
  assert.match(s, /active && pa\?\.status\.inquiry\?\.kind === "deleted" && !controlled\?\.content && \(\s*<div[^>]*data-code-deleted=/, "the deleted file has no hint");
  assert.match(s, /active && pa\?\.status\.inquiry\?\.kind === "changed" && !controlled\?\.content && \(/, "the changed file has no choice");
  // The button disappears with the hint; focus used to fall to the document, so cmd+S afterwards went nowhere.
  assert.match(body(s, "const keepChanged = ("), /requestAnimationFrame\(\(\) => cmRef\.current\?\.view\?\.focus\(\)\);/, "after the choice the focus does not stay in the editor");
}
function checkDiffTab(s) {
  assert.doesNotMatch(withoutComments(s), /\/files\/write/, "the diff tab writes past the buffer");
  const save = body(s, "const save = useCallback(");
  assert.match(save, /const r = await p\.save\(\{/, "the diff tab does not save through the buffer");
  assert.match(save, /if \(r\.kind === "saved"\) back\.current\.onSaved\?\.\(file\);/, "a save is not passed on");
  assert.match(save, /if \(r\.kind === "saved" \|\| r\.kind === "changed"\) await load\("fresh"\);/, "after a 409 the diff does not reread");
  assert.match(s, /const r = await p\.load\(\{ draft: firstDraft\.current \?\? null, disk: \{ disk, lineEnding: h\.reading\?\.lineEnding, marker: p === p0 \? marker : undefined \} \}\);/, "the first state does not bring the draft into the buffer (withDraft)");
  assert.match(s, /\} else p\.takeDisk\(disk, h\.reading\?\.lineEnding, p === p0 \? marker : undefined\);/, "rereading does not go through the buffer (afterReread)");
  assert.match(s, /if \(isDirty\) \{ setNewError\(/, "not comparable with own text replaces the surface");
  assert.match(body(s, "const rememberDraft = ("), /setNotRemembered\(p\.dirty && ok === false\);/, "a draft that was not remembered stays silent");
  // A draft that carries something other than the already open buffer ("deviating") stays remembered.
  assert.match(body(s, "const rememberDraft = ("), /if \(!p \|\| p\.status\.state !== "loaded" \|\| foreign\.current\) return;/, "the diff tab overwrites a foreign draft");
  assert.match(body(s, "const rememberDraft = ("), /p\.status\.base, p\.buffer\);/, "the diff tab's draft does not carry its buffer's id");
  assert.match(s, /if \(r\.kind === "text" && r\.draft === "deviating"\) foreign\.current = true;/, "\"deviating\" does not hold the draft");
  // Without a buffer the right side is never editable - it loads until the mapping is known.
  assert.match(body(s, "const load = useCallback("), /if \(writeSource && file && !p\) \{ withoutBuffer\.current = true; setSituation\(\{ kind: "loading" \}\); return; \}/, "a writable side without a buffer is shown");
  assert.match(s, /useEffect\(\(\) => \{ if \(revision !== firstStatus\.current\) \{ firstStatus\.current = revision; if \(!waiting\) void load\("fresh"\); \} \}, \[revision, load, waiting\]\);/, "a new state loads although the mapping is missing");
  assert.match(s, /useEffect\(\(\) => \{ if \(buf && withoutBuffer\.current && !waiting\) \{ withoutBuffer\.current = false; void load\("first"\); \} \}, \[buf, load, waiting\]\);/, "when the buffer arrives, the side does not load");
  assert.match(s, /writable=\{d\.writable && buf\?\.status\.state === "loaded"\}/, "the surface is writable without a buffer");
  assert.match(s, /\{situation\.kind === "loading" && <Placeholder height=\{height\} text=\{waiting \? waitingText\(coord, t\) : t\("Loading…##inline"\)\} \/>\}/, "the waiting side does not show the error when reading the projects");
  assert.match(s, /\{storageText && <RowError text=\{storageText\}/, "a save error of the buffer is missing");
  for (const k of ["const loadAgain = () => {", "const mineKeep = () => {"]) assert.match(body(s, k), /requestAnimationFrame\(\(\) => surface\.current\?\.focus\(\)\);/, `${k}: after the choice the focus does not stay in the editor`);
  assert.match(s, /wholeFile \? t\("This file is untracked — “Discard change” deletes the WHOLE file\. Really delete it\?"\)/, "the question conceals that the whole file goes");
}
const SAB_BUFFER = {
  "reading without fromReading": buffer.replace(`const l = fromReading(r); // normalized`, `const l = { text: String(r.content ?? ""), eol: "\\n" as const, sha: null }; // normalized`),
  "second write path": buffer.replace(`  forgetStorageError(): void {`, "  writeRaw(): void { void this.calls(`/files/write`); }\n  forgetStorageError(): void {"),
  "without precondition": buffer.replace(`JSON.stringify(writeBody(this.pathValue, text, s.lineEnding, s.base))`, `JSON.stringify({ path: this.pathValue, content: text })`),
  "409 without reread": buffer.replace(`          await this.checkBack({ onError: o.onError });\n`, ""),
  "keys after cmd+S lost": buffer.replace(`this.set({ saved: text, base: shaFromResponse(response),`, `this.set({ kept: this.statusValue.text, baseline: shaFromResponse(reply),`),
  "choice does not stop cmd+S": buffer.replace(`if (s0.inquiry) { this.set({ storageError: { kind: "first-select" } });`, `if (false) { this.set({ storageError: { type: "first-select" } });`),
  "formatting overwrites": buffer.replace(`if (typeof f === "string" && this.statusValue.text === prior) this.replaceText(f);`, `if (typeof f === "string") this.replaceText(f);`),
  "draft without withDraft": buffer.replace(`const m = withDraft(disk, e);`, `const m = e && onDisk && e.content !== onDisk.text ? { editor: e.content, kept: onDisk.text, ask: null } : null;`),
  "reread without computation": buffer.replace(`const n = afterReread(s.saved, s.text, disk, s.wayAccepted);`, `const n = afterReread(s.saved, s.saved, onDisk, s.wayAccepted);`),
};
const SAB_CODEPANE = {
  "reads itself": codePane.replace(`  const loadTab = useCallback(async (path: string) => {\n`, "  const loadTab = useCallback(async (path: string) => {\n    void calls(`/files/read?path=${encodeURIComponent(path)}`);\n"),
  "writes itself": codePane.replace(`    const r = await p.save({\n`, "    await calls(`/files/write`, { method: \"PUT\", body: \"\" });\n    const r = await p.save({\n"),
  "draft past the buffer": codePane.replace(`{ draft: stRef.current?.draft.read(path) ?? null,`, `{ draftless: null,`),
  "finished draft stays": codePane.replace(`r.draft === "done") { stRef.current?.draft.write(path, null);`, `r.draft === "done") {`),
  "saves past the buffer": codePane.replace(`const r = await p.save({`, `const r = await saveWithoutBuffer(path, {`),
  "no nudge after saving": codePane.replace(`    stRef.current?.saved?.(path); // the other tabs of this target (a diff of the same file) reread`, `    // no nudge`),
  "reread past the buffer": codePane.replace(`bufferOf(x.path)?.checkBack({`, `bufferOf(x.path)?.loadAgain({`),
  "draft without sha": codePane.replace(`at: Date.now(), buffer: p.buffer, ...(sha ? { sha } : {}) });`, `at: Date.now(), buffer: p.buffer });`),
  "draft without buffer": codePane.replace(`at: Date.now(), buffer: p.buffer, ...(sha`, `at: Date.now(), ...(sha`),
  "foreign draft overwritten": codePane.replace(` || (!last && draftForeign(s.draft.read(x.path), p))) continue;`, `) continue;`),
  "waits without error text": codePane.replace(`data-code-loading>{waitingText(coord, t)}</div>}`, `data-code-loading>{t("Loading…##inline")}</div>}`),
  "not remembered silent": codePane.replace(`notRemembered.set(x.path, !ok);`, `notRemembered.set(x.path, false);`),
  "no too-large hint": codePane.replace(`{active.notRemembered && <span`, `{false && <span`),
  "save error silent": codePane.replace(`{pa?.status.storageError && <span`, `{false && <span`),
  "focus falls to the document": codePane.replace("    requestAnimationFrame(() => cmRef.current?.view?.focus());\n", ""),
  "no deleted hint": codePane.replace(`{active && pa?.status.inquiry?.kind === "deleted" && !controlled?.content && (`, `{active && false && !ctl?.content && (`),
  "no choice on changed": codePane.replace(`{active && pa?.status.inquiry?.kind === "changed" && !controlled?.content && (`, `{active && false && !ctl?.content && (`),
};
const SAB_DIFFTAB = {
  "writes itself": diffTab.replace(`const r = await p.save({ onError`, `await api(path("/files/write"), { method: "PUT", body: "" }); const r = await p.save({ onError`),
  "saves past the buffer": diffTab.replace(`const r = await p.save({ onError`, `const r = await saveWithoutBuffer({ onError`),
  "409 without reread": diffTab.replace(`if (r.kind === "saved" || r.kind === "changed") await load("fresh");`, `if (r.kind === "savedX") await load("newX");`),
  "no nudge after saving": diffTab.replace(`if (r.kind === "saved") back.current.onSaved?.(file); // a file tab of the same file rereads`, `// a file tab of the same file rereads`),
  "draft past the buffer": diffTab.replace(`draft: firstDraft.current ?? null, disk:`, `draftless: null, onDisk:`),
  "reread replaces": diffTab.replace(`} else p.takeDisk(disk, h.reading?.lineEnding, p === p0 ? marker : undefined);`, `} else p.loadAgain();`),
  "not comparable replaces": diffTab.replace(`if (isDirty) { setNewError(`, `if (false) { setNewError(`),
  "not remembered silent": diffTab.replace(`setNotRemembered(p.dirty && ok === false);`, `setNotRemembered(false);`),
  "save error silent": diffTab.replace(`{storageText && <RowError`, `{false && <RowError`),
  "focus falls to the document (keep)": diffTab.replace("    requestAnimationFrame(() => surface.current?.focus()); // so Cmd+S reaches the editor right afterwards\n", ""),
  "foreign draft overwritten": diffTab.replace(`if (!p || p.status.state !== "loaded" || foreign.current) return;`, `if (!p || p.status.state !== "loaded") return;`),
  "draft without buffer": diffTab.replace(`p.status.base, p.buffer);`, `p.status.base);`),
  "deviating forgotten": diffTab.replace(`if (r.kind === "text" && r.draft === "deviating") foreign.current = true;`, `if (false) foreign.current = true;`),
  "writable without buffer (load)": diffTab.replace(`if (writeSource && file && !p) { withoutBuffer.current = true; setSituation({ kind: "loading" }); return; }`, ``),
  "new state without mapping": diffTab.replace(`if (!waiting) void load("fresh"); } }, [revision, load, waiting]);`, `void load("fresh"); } }, [revision, load, waiting]);`),
  "buffer arrives, nothing loads": diffTab.replace(`  useEffect(() => { if (buf && withoutBuffer.current && !waiting) { withoutBuffer.current = false; void load("first"); } }, [buf, load, waiting]);\n`, ``),
  "surface writable without buffer": diffTab.replace(`writable={d.writable && buf?.status.state === "loaded"}`, `writableX={d.writable}`),
  "waits without error text": diffTab.replace(`text={waiting ? waitingText(coord, t) : t("Loading…##inline")} />}`, `text={t("Loading…##inline")} />}`),
  "question conceals the file": diffTab.replace(`wholeFile ? t("This file is untracked — “Discard change” deletes the WHOLE file. Really delete it?")`, `false ? ""`),
};
const binding = (name, sourceText, check, sabotages) => test(name, () => {
  check(sourceText);
  for (const [n, s] of Object.entries(sabotages)) {
    assert.notEqual(s, sourceText, `sabotage "${n}" no longer hits`);
    assert.throws(() => check(s), `sabotage "${n}" stays green`);
  }
});
binding("(2) binding lib/buffer.ts: read through fromReading, ONE write path with line ending and base, 409 => reread, draft and rereading through the leaf (with counter-test)", buffer, checkBuffer, SAB_BUFFER);
binding("(2) binding CodePane (file tab in the chat and Coding -> Files): only through the buffer, draft, nudge, hints, focus (with counter-test)", codePane, checkCodePane, SAB_CODEPANE);
binding("(2) binding DiffTab (right side of the diff): only through the buffer, reread after 409, draft, nudge, hints, question on discard (with counter-test)", diffTab, checkDiffTab, SAB_DIFFTAB);
