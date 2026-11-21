// Guard for "files in the copy", code-editor part (project container stage 2; server/backend/electron/server/files-in-copy.js,
// devtools/code-route.js).
//
// THE GAP. The file routes of the code editor (`/files/*`, `/upload`) and the language service (`/lsp/*`) used to run in B, i.e.
// against the main instance. The token of a copy or a `?chat=<chat of the copy>` let them read and write the files of the main
// instance. Now the target instance (devtools/routes.js targetInstance) picks the way: for a copy every access goes through its
// container (files-in-copy.js).
//
// Promises, each with the way that breaks it:
//   (1) Parity: on the same tree the functions for the copy answer like files.js in B — tree (with links, heavy folders, `.git`
//       hidden), reading (text, binary, image, too large, folder), search (all switches), the errors of create, rename, delete and upload.
//   (2) The routes: the token of a copy WITHOUT `?chat` writes, reads, creates, renames, deletes, searches and uploads only in the copy —
//       the main instance stays byte-exact (sha256), the copy's files do not lie in B; the main token does not see them; `?chat=<copy chat>`
//       of a session without token likewise; with neither the main instance as before. Download: a file raw (bytes, type, header), a
//       folder as ZIP does not exist from a copy (400 with message).
//   (3) The copy's language service runs IN the copy: `/lsp/*` with the copy token starts the language server in the copy's container,
//       without a buffer it reads nothing from B (409), a rename returns only `{ edit }` — the main instance stays byte-exact; the main
//       token gets its own server. The agents (`/api/lsp`, cbase_lsp/_edit) work IN the copy likewise: fence-instance.test.js (4).
//   (4) No fallback: when the container is down, the routes answer 409 — the main instance is untouched, nothing arises in B.
//   (5) The instance choice of the code tab `?instance=<project>/<instance>` (no chat, no token) works in the chosen instance; an
//       unknown copy is 404 `UNKNOWN_INSTANCE`, never the main instance (header of the test).
//   (6) When the instance row of a copy is not `ready` (from step 0 of the clear-away `clearAway`), EVERY way of the copy under /files,
//       /upload and /git except the reading ones (code-route.js COPY_READING) answers 409 COPY_NOT_READY with identifier and state — the
//       list of ways comes from the source of code-route.js, so a new way is checked too; terminal (also the chat bar's) and debugger
//       409 LOCKED; reading stays open; `earmarked` does not lock. Counter-tests in the header of the test.
//
// No clock: the copy arises through the real series (stacks-copy-harness.mjs), the tests wait for states. The routes are called with a
// stub request and response (no network); every harness connection closes in its finally.
//
// COUNTER-TESTS (one sabotage each on the real tree):
//   files-in-copy.js   .git is not hidden in the tree                                         ⇒ (1) red
//   files-in-copy.js   reading: too-large file without flag `tooLarge`                         ⇒ (1) red
//   files-in-copy.js   download: a folder gives no `dir` answer                                ⇒ (1) (2) red
//   files-in-copy.js   search: case-insensitive ignores the switch                             ⇒ (1) red
//   devtools/code-route.js  the copy takes the way of files.js (no branch for the copy)        ⇒ (2) (4) red
//                           container down ⇒ 400 instead of 409 (no fallback)                   ⇒ (4) red
//   runtime/fileAccess.js `fastCore`: the hit cap counts EVERY file again (before the prefilter) ⇒ (1) red
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import * as store from "../electron/server/store.js";
import * as main from "../electron/server/files.js";
import * as copy from "../electron/server/files-in-copy.js";
import { READ_MAX } from "../electron/server/runtime/fileAccess.js";
import { codeProjectRoutes, writeLockCopy } from "../electron/server/devtools/routes.js";
import { FIND_CAP, COPY_READING, copyWritePath } from "../electron/server/devtools/code-route.js";
import { setCopyState } from "../electron/server/stacks/state.js";
import { killTerminal } from "../electron/server/terminal.js";
import { instanceForProject, instanceIsCopy } from "../electron/server/runs/instance.js";
import { productionView, fenceContext } from "../electron/server/projectbox/fence.js";
import { endAllSessions } from "../electron/server/lsp/sessions.js";
import { json } from "./agent-harness.mjs";
import { buildCopy, situationDefault, withCopy } from "./stacks-copy-harness.mjs";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const shaFile = (p) => sha(fs.readFileSync(p));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

// The tree in the main instance BEFORE the copy starts (shows through in the copy).
function mainTree(root) {
  const write = (rel, content) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p; };
  write("ed/text.txt", "Hello TODO\nRow 2\nanother todo\n");
  write("ed/bin.dat", Buffer.from([0x66, 0x6f, 0x6f, 0, 1, 2]));
  write("ed/image.png", PNG);
  write("ed/sub/deep.md", "# Title\nTODO deep\n");
  write("ed/node_modules/m/i.js", "// TODO heavy\n");
  write("ed/large.bin", Buffer.alloc(5 * 1024 * 1024 + 1, 65)); // above MAX_READ: "too large"
  fs.truncateSync(write("ed/huge.bin", ""), READ_MAX + 1); // above the cap of the file access (sparse): the download from the copy refuses
  // The order of the search: the container's walk is by name in byte order ("Zeta" before "alpha"), files.js sorts by
  // localeCompare ("alpha" before "Zeta") — files-in-copy.js must sort like files.js.
  write("ed/Zeta.txt", "TODO Zeta\n");
  write("ed/alpha.txt", "TODO alpha\n");
  // The rank of the name search: basename hit before path hit, start of the basename before the middle.
  for (const rel of ["zork/a.txt", "ed/x/zork.txt", "ed/x/barzork.txt", "ed/y/zorkbar.txt"]) write(rel, "x\n");
  fs.symlinkSync("text.txt", path.join(root, "ed", "reference"));
  fs.symlinkSync("exists-not", path.join(root, "ed", "dead"));
  fs.symlinkSync("sub", path.join(root, "ed", "folder-reference"));
}

function stubResponse() {
  const r = { status: 0, header: {}, parts: [], writeHead(c, k) { r.status = c; r.header = k || {}; }, write(d) { r.parts.push(Buffer.from(d)); return true; }, end(d) { if (d) r.parts.push(Buffer.from(d)); } };
  Object.defineProperty(r, "body", { get: () => Buffer.concat(r.parts) });
  Object.defineProperty(r, "json", { get: () => { try { return JSON.parse(Buffer.concat(r.parts).toString("utf8")); } catch { return null; } } });
  return r;
}
async function route(pid, { method, sub, query = "", body, fence, raw }) {
  const req = new PassThrough();
  req.method = method;
  req.headers = { "content-type": "application/json" };
  req.end(raw ?? JSON.stringify(body ?? {}));
  const res = stubResponse();
  const url = new URL(`http://x/api/projects/${pid}${sub}${query}`);
  await codeProjectRoutes({ req, res, url, p: url.pathname, m: method, pid, sub, proj: store.getProject(pid), fence });
  return res;
}
async function copyWithChat(ctx, b) {
  const pid = b.s.projectId;
  await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
  await buildCopy(b, { chatId: ctx.chat.id });
  const inst = instanceForProject(pid, "copy-k1");
  assert.ok(inst && instanceIsCopy(inst), "the copy instance must resolve");
  return inst;
}
const withoutDirSize = (entries) => entries.map((e) => (e.type === "dir" ? { ...e, size: 0 } : e));
const errorOf = async (p) => { try { await p; } catch (e) { return e; } return null; };

test("(1) parity: on the same tree files-in-copy answers like files.js — tree, reading, search and the errors of the write ways", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainTree(b.s.path); }, async ({ ctx, b }) => {
    const inst = await copyWithChat(ctx, b);
    const W = b.s.path;

    // Tree: folders first, `.git` gone, links marked as such (the dead one too), heavy folders `heavy`.
    for (const rel of ["", "ed", "ed/sub", "ed/folder-reference"]) {
      const h = main.listDir(W, rel);
      const k = await copy.listDir(inst, W, rel);
      assert.equal(k.path, h.path, `Baum ${rel}: path`);
      assert.deepEqual(withoutDirSize(k.entries), withoutDirSize(h.entries), `Baum ${rel}`);
    }
    const ed = await copy.listDir(inst, W, "ed");
    const after = Object.fromEntries(ed.entries.map((e) => [e.name, e]));
    assert.equal(after.reference.symlink, true);
    assert.equal(after["folder-reference"].type, "dir", "a link to a folder counts as a folder");
    assert.equal(after.dead.symlink, true);
    assert.equal(after.dead.size, 0);
    assert.equal(after.node_modules.heavy, true);
    assert.ok(!(await copy.listDir(inst, W, "")).entries.some((e) => e.name === ".git"), ".git stays hidden");
    assert.equal((await errorOf(copy.listDir(inst, W, "ed/text.txt"))).message, "Kein Verzeichnis");
    assert.equal((await errorOf(copy.listDir(inst, W, "missing"))).message, "Kein Verzeichnis");
    assert.match((await errorOf(copy.listDir(inst, W, "../outside"))).message, /Pfad außerhalb des Projekts/);

    // Reading: text, binary, image, too large — the same shapes; folder and missing throw.
    for (const rel of ["ed/text.txt", "ed/bin.dat", "ed/image.png", "ed/large.bin", "ed/reference", "ed/sub/deep.md"]) {
      assert.deepEqual(await copy.readFile(inst, W, rel), main.readFile(W, rel), `Lesen ${rel}`);
    }
    assert.equal((await copy.readFile(inst, W, "ed/large.bin")).tooLarge, true);
    assert.equal((await copy.readFile(inst, W, "ed/image.png")).image, true);
    assert.equal((await errorOf(copy.readFile(inst, W, "ed/sub"))).message, (await errorOf(Promise.resolve().then(() => main.readFile(W, "ed/sub")))).message);
    assert.match((await errorOf(copy.readFile(inst, W, "ed/missing.txt"))).message, /ENOENT/);

    // Search: all switches, invalid expression, empty query.
    // Plus "whole word" and the filters — the copy gets the fields along (files-in-copy.js).
    for (const o of [{ query: "todo" }, { query: "TODO", caseSensitive: true }, { query: "TODO", exclusions: false, exclude: ".git" }, { query: "todo", open: ["ed/text.txt", "ed/node_modules/x.js", "ed/fresh.md"] }, { query: "^#", regex: true }, { query: "line \\d", regex: true }, { query: "exists-not" },
      { query: "todo", wholeWord: true }, { query: "todo", include: "ed/sub" }, { query: "todo", include: "*.{txt,md}", exclude: "ed/x, *.md" }]) {
      assert.deepEqual(await copy.searchFiles(inst, W, o), main.searchFiles(W, o), `Suche ${JSON.stringify(o)}`);
    }
    assert.equal((await copy.searchFiles(inst, W, { query: "todo" })).count > 0, true);
    assert.deepEqual(await copy.searchFiles(inst, W, { query: "" }), { results: [], count: 0, files: 0, truncated: false, openMatches: [] });
    assert.match((await errorOf(copy.searchFiles(inst, W, { query: "(", regex: true }))).message, /Invalid regular expression/);

    // Name search (@-mentions): the same hits in the same order.
    for (const q of ["deep", "text", "", "ed/", "zork"]) assert.deepEqual(await copy.findFilesByName(inst, W, q, 50), main.findFilesByName(W, q, 50), `Namen ${q}`);
    assert.deepEqual((await copy.findFilesByName(inst, W, "zork", 50)).results, ["ed/x/zork.txt", "ed/y/zorkbar.txt", "ed/x/barzork.txt", "zork/a.txt"], "the rank: start of the basename, basename, then only the path");
    // Quick open (⌘P): the same scope as the search, the same order as VS Code — equal in B and in the container.
    for (const q of ["deep", "text", "", "ed/", "zork", "e t", "TXT", "ed/x/zork.txt", "zork x", "x zork"]) assert.deepEqual(await copy.quickOpenFiles(inst, W, q, 50), main.quickOpenFiles(W, q, 50), `Quick Open ${q}`);
    assert.deepEqual((await copy.quickOpenFiles(inst, W, "zork", 3)).truncated, true, "the cap with notice in the copy too");
    // The two caps of the walk: the hit cap counts only matching files, the walk has its own — in the container as in B (the same
    // numbers, the same fields).
    for (const caps of [{ maxHits: 2 }, { maxWalk: 3 }, { maxHits: 1, maxWalk: 100 }]) {
      for (const q of ["zork", "txt", "zzz"]) assert.deepEqual(await copy.quickOpenFiles(inst, W, q, 50, caps), main.quickOpenFiles(W, q, 50, caps), `Quick Open ${q} ${JSON.stringify(caps)}`);
    }
    assert.deepEqual((await copy.quickOpenFiles(inst, W, "zork", 50, { maxHits: 4 })).results.length, 4, "the hit cap counts hits, not files");
    assert.deepEqual(await copy.quickOpenFiles(inst, W, "zzz", 50, { maxWalk: 3 }), { results: [], truncated: true, aborted: true, searched: 3 }, "the walk cap in the copy too");
    assert.deepEqual((await copy.searchFiles(inst, W, { query: "todo (Zeta|alpha)", regex: true })).results.map((x) => x.path), ["ed/alpha.txt", "ed/Zeta.txt"], "sorted like files.js (localeCompare), not in walk order");

    // The errors of the write ways — as in B.
    assert.equal((await errorOf(copy.createEntry(inst, W, "ed/text.txt", "file"))).message, "Existiert bereits");
    assert.equal((await errorOf(copy.createEntry(inst, W, "ed/dead", "file"))).message, "Existiert bereits", "a dangling link is an existing name");
    assert.deepEqual(await copy.createEntry(inst, W, "ed/fresh/x.txt", "file"), { ok: true, path: "ed/fresh/x.txt", type: "file" });
    assert.deepEqual(await copy.createEntry(inst, W, "ed/folder", "dir"), { ok: true, path: "ed/folder", type: "dir" });
    assert.equal((await errorOf(copy.renameEntry(inst, W, "ed/missing", "ed/x"))).message, "Quelle nicht gefunden");
    assert.equal((await errorOf(copy.renameEntry(inst, W, "ed/text.txt", "ed/bin.dat"))).message, "Ziel existiert bereits");
    assert.deepEqual(await copy.renameEntry(inst, W, "ed/fresh/x.txt", "ed/new2/y.txt"), { ok: true, path: "ed/new2/y.txt" });
    // Copy: the same errors as files.js copyEntry; a file and a folder with content in the copy, a link in the folder drops out (the
    // file access creates none) and counts in `omitted`; never overwritten.
    assert.equal((await errorOf(copy.copyEntry(inst, W, "ed/missing", "ed/x"))).message, "Quelle nicht gefunden");
    assert.equal((await errorOf(copy.copyEntry(inst, W, "ed/text.txt", "ed/bin.dat"))).code, "TARGET_EXISTS");
    assert.equal((await errorOf(copy.copyEntry(inst, W, "ed/sub", "ed/sub/in"))).message, "Ein Ordner lässt sich nicht in sich selbst kopieren");
    assert.deepEqual(await copy.copyEntry(inst, W, "ed/text.txt", "ed/text copy.txt"), { ok: true, path: "ed/text copy.txt", copied: 1, omitted: 0 });
    assert.equal((await copy.readFile(inst, W, "ed/text copy.txt")).content, "Hello TODO\nRow 2\nanother todo\n");
    await copy.createEntry(inst, W, "ed/new2/v", "dir");
    assert.deepEqual(await copy.copyEntry(inst, W, "ed/new2", "ed/new3"), { ok: true, path: "ed/new3", copied: 3, omitted: 0 });
    assert.deepEqual((await copy.listDir(inst, W, "ed/new3")).entries.map((e) => e.name), ["v", "y.txt"]);
    assert.equal(fs.existsSync(path.join(W, "ed", "text copy.txt")), false, "the copy wrote in B");
    await copy.deleteEntry(inst, W, "ed/new3");
    await copy.deleteEntry(inst, W, "ed/text copy.txt");
    assert.equal((await errorOf(copy.deleteEntry(inst, W, "ed/missing"))).message, "Nicht gefunden");
    assert.equal((await errorOf(copy.deleteEntry(inst, W, ""))).message, "Projektordner kann nicht gelöscht werden");
    assert.deepEqual(await copy.deleteEntry(inst, W, "ed/new2"), { ok: true });
    assert.equal((await errorOf(copy.writeFile(inst, W, "ed/sub", "x"))).message, "Ist ein Verzeichnis");
    assert.deepEqual(await copy.writeFile(inst, W, "ed/w.txt", "Ä\n"), { ok: true, path: "ed/w.txt", size: 3 });
    // Upload: target folder must exist, paths stay in the folder, follow-up chunks append.
    assert.equal((await errorOf(copy.uploadFiles(inst, W, { dir: "ed/missing", files: [] }))).message, "Zielordner nicht gefunden");
    assert.match((await errorOf(copy.uploadFiles(inst, W, { dir: "ed", files: [{ path: "../x", dataB64: "" }] }))).message, /Ungültiger Pfad/);
    await copy.uploadFiles(inst, W, { dir: "ed", files: [{ path: "up/a.bin", dataB64: Buffer.from([1, 2]).toString("base64") }] });
    const r = await copy.uploadFiles(inst, W, { dir: "ed", files: [{ path: "up/a.bin", dataB64: Buffer.from([3]).toString("base64"), append: true }] });
    assert.deepEqual(r, { written: 1, dir: "ed" });
    assert.ok((await copy.downloadCopy(inst, W, "ed/up/a.bin")).data.equals(Buffer.from([1, 2, 3])));
    assert.equal((await copy.downloadCopy(inst, W, "ed/sub")).dir, true);
    assert.equal((await errorOf(copy.downloadCopy(inst, W, "ed/missing"))).message, "Nicht gefunden");
    const dl = await copy.downloadCopy(inst, W, "ed/reference"); // a link becomes the file it points to (resolved in the container)
    assert.deepEqual([dl.dir, dl.name, dl.data.toString()], [false, "reference", "Hello TODO\nRow 2\nanother todo\n"]);
    // Above the cap of the file access the download refuses with a message — never a throw from inside or a piece of the file.
    const huge = await errorOf(copy.downloadCopy(inst, W, "ed/huge.bin"));
    assert.match(String(huge?.message), /Datei zu groß für den Download aus der Kopie/);
  });
});

test("(2) routes: the token of a copy and ?chat=<copy chat> write, read, create, rename, delete, search and upload only in the copy — the main instance stays byte-exact", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainTree(b.s.path); }, async ({ ctx, b }) => {
    const inst = await copyWithChat(ctx, b);
    const pid = b.s.projectId;
    const view = productionView();
    const fenceK = fenceContext(store.projectInstance(pid, "copy-k1"), view);
    const fenceH = fenceContext(store.projectInstance(pid, "main"), view);
    const W = b.s.path;
    const text = path.join(W, "ed", "text.txt");
    const prior = { text: shaFile(text), notes: shaFile(path.join(W, "notes.md")), png: shaFile(path.join(W, "ed", "image.png")) };
    const mainIntact = (what) => {
      assert.equal(shaFile(text), prior.text, `${what}: text.txt changed in the main instance`);
      assert.equal(shaFile(path.join(W, "notes.md")), prior.notes, `${what}: notes.md changed in the main instance`);
      for (const rel of ["ed/copy-only.txt", "ed/fresh", "ed/renamed.txt", "ed/upload", "copy-top.txt"]) assert.equal(fs.existsSync(path.join(W, rel)), false, `${what}: ${rel} lies in B (the main instance)`);
    };
    // Two ways into the copy: the token (without ?chat) and the session with the copy chat (without token).
    const ways = [
      ["token of the copy", { fence: fenceK, query: "" }],
      ["?chat=<copy chat>", { fence: undefined, query: `?chat=${ctx.chat.id}` }],
    ];
    for (const [name, { fence, query }] of ways) {
      const R = (method, sub, body, extra = "", raw) => route(pid, { method, sub, query: query + (extra ? (query ? "&" : "?") + extra : ""), body, fence, raw });

      // Write, then read the same way.
      let r = await R("PUT", "/files/write", { path: "ed/copy-only.txt", content: `Copy ${name}\n` });
      assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.json)}`);
      assert.deepEqual(r.json, { ok: true, path: "ed/copy-only.txt", size: Buffer.byteLength(`Copy ${name}\n`), sha: sha(`Copy ${name}\n`) });
      r = await R("GET", "/files/read", undefined, "path=ed/copy-only.txt");
      assert.equal(r.json.content, `Copy ${name}\n`, name);
      // The precondition of writing (files-base.test.js for the main instance): reading names `sha`, a stale `base` ⇒ 409 CHANGED and
      // the copy's file stays; a deleted one ⇒ 409 `missing` and it is not created; the matching one writes. Counter-test: without
      // the precondition in code-route.js this is red (no sha, 200 instead of 409).
      assert.equal(r.json.sha, sha(`Copy ${name}\n`), `${name}: reading names sha`);
      r = await R("PUT", "/files/write", { path: "ed/copy-only.txt", content: "stale\n", base: sha("another version\n") });
      assert.deepEqual([r.status, r.json.code, r.json.current], [409, "CHANGED", sha(`Copy ${name}\n`)], `${name}: ${JSON.stringify(r.json)}`);
      r = await R("PUT", "/files/write", { path: "ed/never-there.txt", content: "x\n", base: sha("y\n") });
      assert.deepEqual([r.status, r.json.code, r.json.missing], [409, "CHANGED", true], `${name}: ${JSON.stringify(r.json)}`);
      r = await R("GET", "/files/read", undefined, "path=ed/never-there.txt");
      assert.equal(r.status, 400, `${name}: the missing file was created despite 409`);
      r = await R("PUT", "/files/write", { path: "ed/copy-only.txt", content: `Copy ${name}\n`, base: sha(`Copy ${name}\n`) });
      assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.json)}`);
      r = await R("PUT", "/files/write", { path: "ed/text.txt", content: `overwritten in the copy (${name})\n` });
      assert.equal(r.status, 200);
      r = await R("GET", "/files/read", undefined, "path=ed/text.txt");
      assert.match(r.json.content, /overwritten in the copy/);
      mainIntact(`${name} after writing`);

      // Tree and search see their own.
      r = await R("GET", "/files/tree", undefined, "path=ed");
      assert.ok(r.json.entries.some((e) => e.name === "copy-only.txt"), `${name}: tree without the copy file`);
      r = await R("POST", "/files/search", { query: `Copy ${name}` });
      assert.deepEqual(r.json.results.map((x) => x.path), ["ed/copy-only.txt"], name);
      // ⌘P of the code tabs: the name search of the copy finds the file that lies only in the copy.
      r = await R("POST", "/files/find", { query: "copy-only" });
      assert.deepEqual([r.status, r.json.results, r.json.truncated, r.json.cap], [200, ["ed/copy-only.txt"], false, FIND_CAP], `${name}: ${JSON.stringify(r.json)}`);

      // Create, rename, delete, upload.
      r = await R("POST", "/files/create", { path: "ed/fresh/file.txt", type: "file" });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      r = await R("POST", "/files/create", { path: "ed/fresh/file.txt", type: "file" });
      assert.equal(r.status, 400);
      assert.equal(r.json.error, "Existiert bereits");
      r = await R("POST", "/files/rename", { from: "ed/copy-only.txt", to: "ed/renamed.txt" });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      r = await R("GET", "/files/read", undefined, "path=ed/copy-only.txt");
      assert.equal(r.status, 400, "the file is renamed");
      r = await R("POST", "/upload", undefined, "", JSON.stringify({ dir: "ed", files: [{ path: "upload/a.bin", dataB64: PNG.toString("base64") }] }));
      assert.equal(r.status, 200, JSON.stringify(r.json));
      r = await R("GET", "/files/download", undefined, "path=ed/upload/a.bin&inline=1");
      assert.equal(r.status, 200);
      assert.ok(r.body.equals(PNG), "the uploaded bytes come back raw");
      assert.equal(r.header["Content-Length"], PNG.length);
      assert.match(String(r.header["Content-Disposition"]), /^inline; filename="a\.bin"/);
      r = await R("GET", "/files/download", undefined, "path=ed/image.png&inline=1");
      assert.equal(r.header["Content-Type"], "image/png");
      assert.ok(r.body.equals(PNG));
      r = await R("GET", "/files/download", undefined, "path=ed/sub");
      assert.equal(r.status, 400);
      assert.match(r.json.error, /Ordner lässt sich aus einer Kopie nicht als ZIP laden|cannot be downloaded as ZIP/);
      r = await R("DELETE", "/files", undefined, "path=ed/fresh");
      assert.equal(r.status, 200, JSON.stringify(r.json));
      r = await R("DELETE", "/files", undefined, "path=ed/upload");
      assert.equal(r.status, 200);
      r = await R("DELETE", "/files", undefined, "path=ed/renamed.txt");
      assert.equal(r.status, 200);
      mainIntact(`${name} after all write ways`);

      // Deleting a file of the main instance in the copy (whiteout): gone there, present in the main instance.
      r = await R("DELETE", "/files", undefined, "path=notes.md");
      assert.equal(r.status, 200, JSON.stringify(r.json));
      r = await R("GET", "/files/read", undefined, "path=notes.md");
      assert.equal(r.status, 400, `${name}: the deleted file can still be read in the copy`);
      mainIntact(`${name} after deleting`);
      // restore for the next way
      r = await R("PUT", "/files/write", { path: "notes.md", content: "Notizen\n" });
      assert.equal(r.status, 200);
      r = await R("PUT", "/files/write", { path: "ed/text.txt", content: "Hello TODO\nRow 2\nanother todo\n" });
      assert.equal(r.status, 200);
    }

    // The other side: the main token and the session without ?chat see none of it — and write to the main instance, as before.
    let r = await route(pid, { method: "PUT", sub: "/files/write", body: { path: "ed/copy-only.txt", content: "another one\n" }, fence: fenceK });
    assert.equal(r.status, 200);
    r = await route(pid, { method: "GET", sub: "/files/read", query: "?path=ed/copy-only.txt", fence: fenceH });
    assert.equal(r.status, 400, "the main token sees the copy file");
    r = await route(pid, { method: "GET", sub: "/files/read", query: "?path=ed/copy-only.txt" });
    assert.equal(r.status, 400, "the session without ?chat sees the copy file");
    r = await route(pid, { method: "PUT", sub: "/files/write", body: { path: "copy-top.txt", content: "H\n" }, fence: fenceH });
    assert.equal(r.status, 200);
    assert.equal(fs.readFileSync(path.join(W, "copy-top.txt"), "utf8"), "H\n", "the main token writes to the main instance");
    fs.rmSync(path.join(W, "copy-top.txt"));
    r = await route(pid, { method: "PUT", sub: "/files/write", body: { path: "copy-top.txt", content: "H2\n" } });
    assert.equal(fs.readFileSync(path.join(W, "copy-top.txt"), "utf8"), "H2\n", "without token and without ?chat the main instance as before");
    fs.rmSync(path.join(W, "copy-top.txt"));
    // And the copy token with the main instance's chat: 403, nothing written.
    r = await route(pid, { method: "PUT", sub: "/files/write", query: "?chat=exists-not", body: { path: "ed/text.txt", content: "X" }, fence: fenceK });
    assert.equal(r.status, 403);
    assert.equal(shaFile(text), prior.text);
  });
});

test("(3) the copy's language service runs IN the copy: /lsp/* with the copy token starts the language server in the copy's container — without a buffer it reads nothing from B, a rename returns only { edit }", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainTree(b.s.path); }, async ({ ctx, b }) => {
    await copyWithChat(ctx, b);
    const pid = b.s.projectId;
    const view = productionView();
    const instK = store.projectInstance(pid, "copy-k1");
    const instH = store.projectInstance(pid, "main");
    const fenceK = fenceContext(instK, view);
    const fenceH = fenceContext(instH, view);
    const ts = path.join(b.s.path, "a.ts");
    fs.writeFileSync(ts, "export const alt: number = 1;\nexport const y = alt + 1;\n");
    const prior = shaFile(ts);
    const FAKE_LSP = new URL("./fake-lsp.mjs", import.meta.url).pathname;
    const savedEnvironment = process.env.CBASE_LSP_FAKE;
    process.env.CBASE_LSP_FAKE = JSON.stringify([process.execPath, FAKE_LSP]);
    const lspStarts = () => b.fd.calls().filter((a) => a.args[0] === "exec" && a.args.includes(FAKE_LSP));
    const inContainer = (a, inst, name) => (inst.containerId && a.args.includes(inst.containerId)) || a.args.includes(name);
    try {
      // Without a buffer: the copy reads no file from B's disk (the main instance lies there) — 409, and no language server starts.
      let r = await route(pid, { method: "POST", sub: "/lsp/diagnostics", body: { file: "a.ts" }, fence: fenceK });
      assert.equal(r.status, 409, JSON.stringify(r.json));
      assert.equal(lspStarts().length, 0, "a language server started without a buffer");
      // With a buffer: the language server computes in the copy (the fake server reports every "FAILED" as a diagnostic).
      r = await route(pid, { method: "POST", sub: "/lsp/diagnostics", body: { file: "a.ts", buffer: "buffer-1", version: 1, text: "export const FAILED = 1;\n" }, fence: fenceK });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.diagnostics?.length, 1, JSON.stringify(r.json));
      assert.ok(lspStarts().length === 1 && inContainer(lspStarts()[0], instK, b.copy) && !inContainer(lspStarts()[0], instH, b.main), JSON.stringify(lspStarts().map((a) => a.args)));
      // Rename: only `{ edit }` — the main instance stays byte-exact.
      r = await route(pid, { method: "POST", sub: "/lsp/rename", body: { file: "a.ts", buffer: "buffer-1", version: 2, text: "export const alt = 1;\n", position: { line: 0, character: 13 }, newName: "fresh" }, fence: fenceK });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual((r.json.edit?.changes || []).map((c) => c.file), ["a.ts"], JSON.stringify(r.json));
      assert.equal(shaFile(ts), prior, "the copy's language service wrote to the main instance");
      // The control: the main token gets its OWN language server in the main container (one session per instance).
      r = await route(pid, { method: "POST", sub: "/lsp/diagnostics", body: { file: "a.ts" }, fence: fenceH });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(r.json.diagnostics, [], JSON.stringify(r.json));
      assert.equal(lspStarts().length, 2, JSON.stringify(lspStarts().map((a) => a.args)));
      assert.ok(inContainer(lspStarts()[1], instH, b.main), JSON.stringify(lspStarts()[1].args));
    } finally {
      endAllSessions("test");
      if (savedEnvironment === undefined) delete process.env.CBASE_LSP_FAKE; else process.env.CBASE_LSP_FAKE = savedEnvironment;
    }
  });
});

test("(4) no fallback: when the container is down, the copy's file routes answer 409 — the main instance is untouched, nothing arises in B", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainTree(b.s.path); }, async ({ ctx, b }) => {
    await copyWithChat(ctx, b);
    const pid = b.s.projectId;
    const fenceK = fenceContext(store.projectInstance(pid, "copy-k1"), productionView());
    const W = b.s.path;
    const text = path.join(W, "ed", "text.txt");
    const prior = shaFile(text);
    const cfg = path.join(b.fd.dir, "config.json");
    fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, "utf8")), execBroken: [b.copy] }));
    const calls = [
      { method: "GET", sub: "/files/tree", query: "?path=ed" },
      { method: "GET", sub: "/files/read", query: "?path=ed/text.txt" },
      { method: "GET", sub: "/files/download", query: "?path=ed/text.txt" },
      { method: "PUT", sub: "/files/write", body: { path: "ed/fallback.txt", content: "in B?\n" } },
      { method: "POST", sub: "/files/create", body: { path: "ed/fallback-2.txt", type: "file" } },
      { method: "POST", sub: "/files/rename", body: { from: "ed/text.txt", to: "ed/fallback-3.txt" } },
      { method: "DELETE", sub: "/files", query: "?path=ed/text.txt" },
      { method: "POST", sub: "/files/search", body: { query: "TODO" } },
      { method: "POST", sub: "/upload", raw: JSON.stringify({ dir: "ed", files: [{ path: "fallback-4.bin", dataB64: "AQ==" }] }) },
    ];
    for (const a of calls) {
      const r = await route(pid, { ...a, fence: fenceK });
      assert.equal(r.status, 409, `${a.method} ${a.sub}: ${r.status} ${JSON.stringify(r.json)} (fallback to B?)`);
      assert.match(String(r.json?.error), /copy .*copy-k1/, `${a.sub}: the message names the copy`);
    }
    assert.equal(shaFile(text), prior);
    for (const n of ["fallback.txt", "fallback-2.txt", "fallback-3.txt", "fallback-4.bin"]) assert.equal(fs.existsSync(path.join(W, "ed", n)), false, `${n} lies in B`);
  });
});

// The instance choice of the code tab. The tab belongs to no chat — without `?instance=` it never reached a copy.
// COUNTER-TESTS (one sabotage each on devtools/routes.js):
//   the helper that applies the chosen instance returns the target instead of the choice (choice not applied) ⇒ (5) red ("the choice writes to B")
//   the chosen-instance resolver: an unknown copy falls back to the main instance (instead of 404)            ⇒ (5) red (200 instead of 404)
test("(5) the code tab's instance choice: ?instance=<project>/copy-k1 works in the copy, <project>/main in the main instance; unknown 404, foreign 400, against the token 403 — never a fallback to the main instance", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainTree(b.s.path); }, async ({ ctx, b }) => {
    await copyWithChat(ctx, b);
    const pid = b.s.projectId;
    const W = b.s.path;
    const text = path.join(W, "ed", "text.txt");
    const prior = shaFile(text);
    const view = productionView();
    const fenceK = fenceContext(store.projectInstance(pid, "copy-k1"), view);
    const fenceH = fenceContext(store.projectInstance(pid, "main"), view);
    const K = `${pid}/copy-k1`;
    const q = (identifier, extra = "") => `?instance=${encodeURIComponent(identifier)}${extra ? "&" + extra : ""}`;

    // The copy: write, read, tree, search, language service — the main instance stays byte-exact.
    let r = await route(pid, { method: "PUT", sub: "/files/write", query: q(K), body: { path: "ed/choice.txt", content: "only in the copy\n" } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(fs.existsSync(path.join(W, "ed", "choice.txt")), false, "the choice writes to B (the main instance)");
    r = await route(pid, { method: "PUT", sub: "/files/write", query: q(K), body: { path: "ed/text.txt", content: "Copy\n" } });
    assert.equal(r.status, 200);
    assert.equal(shaFile(text), prior, "the choice overwrites the main instance");
    r = await route(pid, { method: "GET", sub: "/files/read", query: q(K, "path=ed/choice.txt") });
    assert.equal(r.json?.content, "only in the copy\n");
    r = await route(pid, { method: "GET", sub: "/files/tree", query: q(K, "path=ed") });
    assert.ok(r.json.entries.some((e) => e.name === "choice.txt"), "the tree of the choice shows the copy");
    r = await route(pid, { method: "POST", sub: "/files/search", query: q(K), body: { query: "only in the copy" } });
    assert.deepEqual(r.json.results.map((x) => x.path), ["ed/choice.txt"]);
    r = await route(pid, { method: "POST", sub: "/lsp/diagnostics", query: q(K), body: { file: "a.ts" } });
    assert.equal(r.status, 409, `the language service of the chosen copy reads nothing from B: ${JSON.stringify(r.json)}`);

    // The main instance, chosen explicitly: does not see the copy file and writes to B.
    r = await route(pid, { method: "GET", sub: "/files/read", query: q(`${pid}/main`, "path=ed/choice.txt") });
    assert.equal(r.status, 400, "the chosen main instance sees the copy file");
    r = await route(pid, { method: "PUT", sub: "/files/write", query: q(`${pid}/main`), body: { path: "main-choice.txt", content: "H\n" } });
    assert.equal(r.status, 200);
    assert.equal(fs.readFileSync(path.join(W, "main-choice.txt"), "utf8"), "H\n");
    fs.rmSync(path.join(W, "main-choice.txt"));
    // Empty means: no choice (the main instance as before).
    r = await route(pid, { method: "GET", sub: "/files/read", query: "?instance=&path=ed/text.txt" });
    assert.equal(r.status, 200);
    assert.equal(r.json.content, fs.readFileSync(text, "utf8"));

    // A removed (unknown) copy: 404 with code and identifier — nothing in B, terminal and version control neither.
    for (const [method, sub, extra, body] of [["GET", "/files/tree", "path=ed"], ["PUT", "/files/write", "", { path: "ed/back.txt", content: "B?\n" }], ["POST", "/terminal", "", {}], ["GET", "/git", ""]]) {
      r = await route(pid, { method, sub, query: q(`${pid}/copy-away`, extra), body });
      assert.equal(r.status, 404, `${method} ${sub}: ${r.status} ${JSON.stringify(r.json)}`);
      assert.equal(r.json.code, "UNKNOWN_INSTANCE");
      assert.equal(r.json.identifier, `${pid}/copy-away`);
      assert.match(r.json.error, /unknown instance/);
    }
    assert.equal(fs.existsSync(path.join(W, "ed", "back.txt")), false, "an unknown copy fell back to the main instance");

    // Foreign or no identifier: 400.
    for (const raw of ["other-project/copy-k1", "garbage", `${pid}/`]) {
      r = await route(pid, { method: "GET", sub: "/files/read", query: q(raw, "path=ed/text.txt") });
      assert.equal(r.status, 400, `${raw}: ${JSON.stringify(r.json)}`);
      assert.equal(r.json.code, "INSTANCE_INVALID");
    }
    // Together with ?chat: the same instance works, another is 400.
    r = await route(pid, { method: "GET", sub: "/files/read", query: q(K, `chat=${ctx.chat.id}&path=ed/choice.txt`) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await route(pid, { method: "GET", sub: "/files/read", query: q(`${pid}/main`, `chat=${ctx.chat.id}&path=ed/text.txt`) });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    // From a project network the token decides: the main token chooses no copy, the copy token only itself.
    r = await route(pid, { method: "PUT", sub: "/files/write", query: q(K), body: { path: "ed/fence.txt", content: "Z\n" }, fence: fenceH });
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.equal(r.json.code, "INSTANCE_FOREIGN");
    r = await route(pid, { method: "GET", sub: "/files/read", query: q(`${pid}/main`, "path=ed/text.txt"), fence: fenceK });
    assert.equal(r.status, 403);
    r = await route(pid, { method: "GET", sub: "/files/read", query: q(K, "path=ed/choice.txt"), fence: fenceK });
    assert.equal(r.json?.content, "only in the copy\n");
    assert.equal(fs.existsSync(path.join(W, "ed", "fence.txt")), false);
    assert.equal(shaFile(text), prior);
  });
});

// A copy being cleared away accepts no write way any more. Without this every way answered 200 (write, create, upload, git commit, a
// new terminal), and what came after the backup of its repo was silently deleted with the container.
// COUNTER-TESTS (one sabotage each, only (6) run):
//   devtools/routes.js      `writeLock: writeLockCopy,` dropped                    ⇒ (6) red ("DELETE /files: 200 {ok:true}")
//   devtools/routes.js      terminal lock without the copy's line                  ⇒ (6) red ("/terminal {}: 201")
//   devtools/code-route.js  `POST /git/commit` in COPY_READING                     ⇒ (6) red ("POST /git/commit does not count as a write way" —
//                           the list of ways comes from the source, a loosened way is noticed)
const CODE_ROUTE = fs.readFileSync(new URL("../electron/server/devtools/code-route.js", import.meta.url), "utf8");
const codeRouteWays = () => [...new Set([...CODE_ROUTE.matchAll(/sub === "([^"]+)" && m === "([A-Z]+)"/g)].map((x) => `${x[2]} ${x[1]}`))].sort();

test("(6) when a copy's instance row is not ready (clear-away), every write way under /files, /upload and /git answers 409 COPY_NOT_READY, terminal and debugger 409 LOCKED — reading stays open, earmarked does not lock", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); mainTree(b.s.path); }, async ({ ctx, b }) => {
    const inst = await copyWithChat(ctx, b);
    const pid = b.s.projectId;
    const W = b.s.path;
    const K = `${pid}/copy-k1`;
    const q = (extra = "") => `?instance=${encodeURIComponent(K)}${extra ? "&" + extra : ""}`;
    const text = path.join(W, "ed", "text.txt");
    const prior = shaFile(text);

    // The ways from the source — every line of COPY_READING stands there (a stale one would be a dead entry), both sides are occupied.
    const ways = codeRouteWays().filter((w) => /^[A-Z]+ \/(files|upload|git)(\/|$)/.test(w) && !/ \/git\/creds$/.test(w));
    for (const l of COPY_READING) assert.ok(ways.includes(l), `COPY_READING names ${l}, code-route.js does not know the way`);
    const writing = ways.filter((w) => copyWritePath(...w.split(" ")));
    const reading = ways.filter((w) => !copyWritePath(...w.split(" ")));
    assert.ok(writing.length >= 20 && reading.length === COPY_READING.length, `writing ${writing.length}, reading ${reading.join(", ")}`);
    for (const w of ["PUT /files/write", "POST /files/create", "POST /files/rename", "POST /files/copy", "DELETE /files", "POST /upload", "POST /git/commit", "POST /git/stage", "POST /git/checkout", "POST /git/stash", "POST /git/worktree"]) {
      assert.ok(writing.includes(w), `${w} does not count as a write way`);
    }
    // The ignored paths are read by the tree also in a copy being cleared away — reading, named.
    for (const w of ["GET /git/ignored", "GET /files/tree", "POST /files/find"]) assert.ok(reading.includes(w), `${w} does not count as reading`);

    // `earmarked`: only stack_kopien, the instance row stays `ready` — writing works as always.
    setCopyState(b.k.id, "clearAway", { phase: "earmarked" });
    assert.equal(store.projectInstance(pid, "copy-k1")?.state, "ready");
    assert.equal(writeLockCopy(inst), null);
    let r = await route(pid, { method: "PUT", sub: "/files/write", query: q(), body: { path: "ed/earmarked.txt", content: "earmarked\n" } });
    assert.equal(r.status, 200, `earmarked locks: ${JSON.stringify(r.json)}`);

    // From step 0 (the instance row `clearAway`): every write way 409, without reading the body and without touching the copy.
    setCopyState(b.k.id, "clearAway", { phase: "save" });
    assert.equal(store.projectInstance(pid, "copy-k1")?.state, "clearAway");
    assert.deepEqual(writeLockCopy(inst), { identifier: K, state: "clearAway" });
    const bodyText = { path: "ed/text.txt", content: "after the backup\n", from: "ed/text.txt", to: "ed/way.txt", type: "file", repo: "app", message: "late", files: ["a.txt"], branch: "main", name: "x" };
    for (const w of writing) {
      const [method, sub] = w.split(" ");
      r = await route(pid, { method, sub, query: q(sub === "/files" ? "path=ed/text.txt" : ""), body: bodyText, raw: sub === "/upload" ? JSON.stringify({ dir: "ed", files: [{ path: "late.bin", dataB64: "AQ==" }] }) : undefined });
      assert.equal(r.status, 409, `${w}: ${r.status} ${JSON.stringify(r.json)}`);
      assert.deepEqual([r.json?.code, r.json?.identifier, r.json?.state], ["COPY_NOT_READY", K, "clearAway"], `${w}: ${JSON.stringify(r.json)}`);
      assert.match(String(r.json?.error), /Kopie k1 wird abgeräumt|copy k1 is being removed/, w);
    }
    // The same way via the copy's chat (?chat=, without choice) — files and git take the instance of its chat.
    r = await route(pid, { method: "POST", sub: "/git/commit", query: `?chat=${ctx.chat.id}`, body: bodyText });
    assert.deepEqual([r.status, r.json?.code], [409, "COPY_NOT_READY"], JSON.stringify(r.json));
    r = await route(pid, { method: "PUT", sub: "/files/write", query: `?chat=${ctx.chat.id}`, body: bodyText });
    assert.deepEqual([r.status, r.json?.code], [409, "COPY_NOT_READY"], JSON.stringify(r.json));

    // Terminal (code tab and chat bar) and debugger: 409 LOCKED with the state as reason.
    for (const [sub, query, body] of [["/terminal", q(), {}], ["/terminal", "", { tag: `chat:${ctx.chat.id}` }], ["/debug/launch", q(), { file: "ed/text.txt" }]]) {
      r = await route(pid, { method: "POST", sub, query, body });
      if (sub === "/terminal" && r.json?.id) killTerminal(r.json.id); // only on failure (without lock) — no open process
      assert.equal(r.status, 409, `${sub} ${JSON.stringify(body)}: ${r.status} ${JSON.stringify(r.json)}`);
      assert.deepEqual([r.json?.code, r.json?.reason], ["LOCKED", "clearAway"], JSON.stringify(r.json));
    }

    // Reading stays open: tree, read, download, search; the reading git ways never answer COPY_NOT_READY.
    r = await route(pid, { method: "GET", sub: "/files/read", query: q("path=ed/earmarked.txt") });
    assert.deepEqual([r.status, r.json?.content], [200, "earmarked\n"]);
    r = await route(pid, { method: "GET", sub: "/files/read", query: q("path=ed/text.txt") });
    assert.equal(r.json?.content, "Hello TODO\nRow 2\nanother todo\n", "a write way changed the copy");
    r = await route(pid, { method: "GET", sub: "/files/tree", query: q("path=ed") });
    assert.equal(r.status, 200);
    assert.ok(!r.json.entries.some((e) => ["way.txt", "late.bin"].includes(e.name)), JSON.stringify(r.json.entries.map((e) => e.name)));
    r = await route(pid, { method: "GET", sub: "/files/download", query: q("path=ed/text.txt&inline=1") });
    assert.equal(r.status, 200);
    r = await route(pid, { method: "POST", sub: "/files/search", query: q(), body: { query: "earmarked" } });
    assert.deepEqual([r.status, r.json?.results?.map((x) => x.path)], [200, ["ed/earmarked.txt"]]);
    r = await route(pid, { method: "POST", sub: "/files/find", query: q(), body: { query: "earmarked" } });
    assert.deepEqual([r.status, r.json?.results], [200, ["ed/earmarked.txt"]], "the name search (⌘P) is reading and stays open");
    for (const w of reading.filter((x) => x.includes(" /git"))) {
      const [method, sub] = w.split(" ");
      r = await route(pid, { method, sub, query: q(), body: { repo: "app", file: "a.txt", ref: "HEAD", path: "a.txt" } });
      assert.notEqual(r.json?.code, "COPY_NOT_READY", `${w}: ${JSON.stringify(r.json)}`);
    }
    // The main instance never asks the lock.
    r = await route(pid, { method: "PUT", sub: "/files/write", query: `?instance=${encodeURIComponent(`${pid}/main`)}`, body: { path: "main-s1.txt", content: "H\n" } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    fs.rmSync(path.join(W, "main-s1.txt"));
    assert.equal(shaFile(text), prior, "the main instance was touched");
    for (const n of ["way.txt", "late.bin"]) assert.equal(fs.existsSync(path.join(W, "ed", n)), false, `${n} lies in B`);
  });
});
