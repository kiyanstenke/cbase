// ONE buffer per file in the window ACROSS the levels too (editor navigation as in VS Code) — lib/buffer-coordinates.ts and the views on it.
//
// (1) The module, compiled with tsc and EXECUTED together with lib/buffer.ts, the language service (lib/api/lsp.ts) and the WorkspaceEdit
//     (lib/lsp-change.ts) against a fake server whose disk goes by ABSOLUTE paths (the workspace route and the project route see the same
//     file under two paths, a copy has its own):
//     - the same file via the workspace level (`orbit-2/a.ts`) and the project level (`a.ts`) is ONE buffer: typing shows in the other view,
//       unsaved at both places, saving goes ONCE via the project, `buffer`/`version` of the language service are the same (the second place
//       does not send the text again), a rename on one level changes the other;
//     - a file of the workspace level WITHOUT a project keeps its own buffer (also next to a folder with the same beginning);
//     - copies (other instance) stay separate, their places lie in no view of main;
//     - a project list not yet read creates NO buffer (empty is not unknown; a row without a project list is unknown);
//     - hits of the language service land in the workspace view at the right path (an external target stays, a project outside the workspace
//       folder does not lie in it), a WorkspaceEdit from the workspace view changes the project view, the background tab opens at the path of
//       the view;
//     - when the list changes (project created, deleted, its folder moved), open buffers move along with their unsaved text; an occupied
//       target takes nothing away;
//     - rename across the border of a project (out, in, a folder with a project folder inside, a project folder itself);
//     - on a target change the language service closes the old file and opens the new one with text.
//     Further findings:
//     - `collision`: when a buffer moves to an occupied target, its text passes into a clean target on the same disk, and the source
//       yields; if both carry their own, the source stays (save-all, the tab keeps it, a newly opened tab shows it) — `base` makes the second
//       write fail instead of silently overwriting;
//     - `nested`: a project in the folder of another — the view of the outer one (main only) and the workspace level map to the inner one,
//       buffers move in and out again, an equally long folder takes nothing over, a copy stays the identity;
//     - `order`: an older reading of `/api/workspaces` that arrives after a younger one does not count (page and loader);
//     - `loader`: after an error it stands (listeners learn it) and is re-read at a growing, capped interval, only while someone is looking;
//       a success takes it back; ONE run at a time, a nudge meanwhile reads once more afterwards; `stale`: which events of the stream
//       trigger a re-read;
//     - `normed`: `a//b`, `a/./b`, `a/x/../b` and trailing slashes on workspace and project folders are no second buffers.
//     (The diff tab is held by web/test/file-status.test.mjs, chat tabs by web/test/chat-tabs.test.mjs, the editor by web/test/lsp-editor.test.mjs.)
// (2) The views (sources): CodePane, diff tab, chat tabs, background tab of the chat, navigation, references, breadcrumbs and the page go
//     through the coordinates; a tab only switches via `tabBufferFor`; the hook re-reads on focus and events and shows the read error;
//     the page reads with a sequence number. With counter-tests.
//
// Each sabotage is a copy of the source with ONE changed place (the place occurs exactly once, otherwise the sabotage is stale); the
// assigned check must fail on it. What is waited for are the answers of the fake server, never the clock.
//
// Run:  node --test --test-reporter=tap web/test/buffer-coordinates.test.mjs
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
const KQ = read("src", "lib", "buffer-coordinates.ts");
const LQ = read("src", "lib", "api", "lsp.ts");

// ── Sabotages ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const K_SABOTAGES = {
  "mapping missing": { old: "return p && r !== null ? { target: projectTarget(p.id), path: r } : { target: z, path: rel };", fresh: "return { target: z, path: rel };", catches: "oneBuffer" },
  "ofCanon missing": { old: "return p ? under(root, connection(p.path, path)) : null;", fresh: "return null;", catches: "lspHits" },
  "folder boundary missing": { old: "abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null", fresh: "abs.startsWith(root) ? abs.slice(root.length + 1) : null", catches: "lspHits" },
  "names never remembered": { old: "    rememberNames(w);\n", fresh: "", catches: "names" },
  "names only on a changed card": { old: "    rememberNames(w);\n    if (!w ||", fresh: "    if (!CARDS.has(w?.id ?? \"\")) rememberNames(w);\n    if (!w ||", catches: "names" },
  "copy without its name": { old: "return k ? `${n} (${k})` : n;", fresh: "return n;", catches: "names" },
  "names survive forgetting": { old: " NAMES.clear();", fresh: "", catches: "names" },
  "copy equals main": { old: "const p = card.projects.find((x) => sameTarget(projectTarget(x.id), k));", fresh: "const p = card.projects.find((x) => projectTarget(x.id).apiBase === k.apiBase);", catches: "copies" },
  "empty counts as without project": { old: "if (!card || root === null) return identity(!wid);", fresh: "if (!card || root === null) return identity(true);", catches: "notLoaded" },
  "missing project list counts as empty": { old: "typeof w.path !== \"string\" || !Array.isArray(w.projects)) continue; // without a list: unknown, not empty\n    const projects = w.projects.filter(", fresh: "typeof w.path !== \"string\") continue;\n    const projects = (w.projects ?? []).filter(", catches: "notLoaded" },
  "relocation missing": { old: "    relocate(w.id, old?.card ?? null, fresh);\n", fresh: "", catches: "relocation" },
  "project does not stay": { old: "const stays = pid ? fresh.projects.find((x) => x.id === pid) ?? null : null;", fresh: "const stays = null as { path: string } | null;", catches: "relocation" },
  "deleted project stays": { old: "const root = own ? fresh.wsPath : (stays ?? (pid ? old?.projects.find((x) => x.id === pid) : undefined))?.path;", fresh: "const root = own ? fresh.wsPath : stays?.path;", catches: "relocation" },
  // occupied target
  "occupied target without supersede": { old: "    if (t && t !== p) p.supersede(t);\n", fresh: "", catches: "collision" },
  "tab switches with own text": { old: "(!old.dirty || (old.superseded === c && old.text === c.text))", fresh: "true", catches: "collision" },
  "tab stays with the superseded": { old: "return c && c !== held && switches(held, c) ? c : held;", fresh: "return held;", catches: "collision" },
  "lingering superseded invisible": { old: "return stale && !switches(stale, c) ? stale : c;", fresh: "return c;", catches: "collision" },
  // nested
  "project view without deeper project": { old: "const deeper = wid ? -1 : root.length;", fresh: "const deeper = wid ? -1 : Infinity;", catches: "nested" },
  "equally long view takes over": { old: "const r = p && p.path.length > deeper ? under(p.path, abs) : null;", fresh: "const r = p && p.path.length >= deeper ? under(p.path, abs) : null;", catches: "nested" },
  "deeper does not move": { old: "(!stays || r.path.length > stays.path.length)", fresh: "!stays", catches: "nested" },
  "equally long move takes over": { old: "(!stays || r.path.length > stays.path.length)", fresh: "true", catches: "nested" },
  "copy maps": { old: "export const projectOf = (z: BufferTarget): string | null => (z.instance ? null : PROJ.exec(z.apiBase)?.[1] ?? null);", fresh: "export const projectOf = (z: BufferTarget): string | null => PROJ.exec(z.apiBase)?.[1] ?? null;", catches: "nested" },
  // order of the readings
  "list in arrival order": { old: "if (seq <= applied) return false;", fresh: "if (false) return false;", catches: "order" },
  "loader without number": { old: "reportWorkspaces(l as WorkspaceRow[], seq);", fresh: "reportWorkspaces(l as WorkspaceRow[]);", catches: "order" },
  // re-reading
  "no re-read after error": { old: "    planeRepetition();\n", fresh: "", catches: "lader" },
  "interval does not grow": { old: "repeatGap(failedAttempts++)", fresh: "repeatGap(failedAttempts)", catches: "lader" },
  "interval uncapped": { old: "Math.min(Math.max(0, Math.floor(n)), REPEAT_MS.length - 1)", fresh: "Math.max(0, Math.floor(n))", catches: "lader" },
  "read error silent": { old: "if (text !== errorText) { errorText = text; reportListeners(); }", fresh: "errorText = text;", catches: "lader" },
  "read error stays": { old: "const wasError = errorText !== null;\n    errorText = null;", fresh: "const wasError = errorText !== null;", catches: "lader" },
  "repetition without anyone looking": { old: "if (scheduled || LISTENERS.size === 0) return;", fresh: "if (scheduled) return;", catches: "lader" },
  "two runs at once": { old: "if (running) { again = true; return running; }", fresh: "", catches: "lader" },
  "nudge during reading lost": { old: "if (running) { again = true; return running; }", fresh: "if (running) return running;", catches: "lader" },
  "layout always counts": { old: "if (type === \"project/layout\") return evt?.kind === \"finished\";", fresh: "if (type === \"project/layout\") return true;", catches: "stale" },
  "every project event reads": { old: "return Boolean(pid && CARDS.size > 0 && !entryWith(pid));", fresh: "return Boolean(pid);", catches: "stale" },
  // normed
  "card not normalised": { old: "const fresh = normCard({ wsPath: w.path, projects });", fresh: "const fresh = { wsPath: w.path, projects };", catches: "normed" },
  "path of the view not normalised": { old: "const rel = normPath(path), abs = connection(root, rel);", fresh: "const rel = path, abs = connection(root, rel);", catches: "normed" },
  "identity not normalised": { old: "toCanon: ready ? (path) => ({ target: z, path: absolute(path) ? path : normPath(path) }) : () => null,", fresh: "toCanon: ready ? (path) => ({ target: z, path }) : () => null,", catches: "normed" },
  "connection not normalised": { old: "const connection = (root: string, rel: string) => normPath(`${root}/${rel}`);", fresh: "const connection = (root: string, rel: string) => `${root}/${rel}`;", catches: "normed" },
  "rename across the border": { old: "renameBuffer(a.target, a.path, n.path, n.target);", fresh: "renameBuffer(a.target, a.path, n.path);", catches: "rename" },
  "project folder under the folder stays": { old: "    if (z) renameBuffer(p.target, p.path, z.path, z.target);", fresh: "    void z;", catches: "rename" },
};
const L_SABOTAGES = {
  "target change without unregistering": { old: "const equal = Boolean(old && sameFile(old, target, file));", fresh: "const equal = Boolean(old && old.file === file);", catches: "lspTarget" },
  "state knows no target": { old: "return Boolean(b && sameFile(b, q.target, q.path) && b.version === q.version);", fresh: "return Boolean(b && b.file === q.path && b.version === q.version);", catches: "lspTarget" },
};

// ── Compile: module, buffer, language service, WorkspaceEdit and one copy per sabotage, in ONE tsc run. `api/core.ts` is a replacement without
// network — the test sets the transports. Type errors only count in the real sources.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-buffer-coordinates-"));
const src = path.join(tmp, "src"), out = path.join(tmp, "out");
fs.mkdirSync(path.join(src, "api"), { recursive: true });
for (const f of ["buffer.ts", "file-status.ts", "code-instance.ts", "diff-tab.ts", "chat-tabs.ts", "commandPalette.ts", "lsp-change.ts"]) fs.writeFileSync(path.join(src, f), read("src", "lib", f));
fs.writeFileSync(path.join(src, "buffer-coordinates.ts"), KQ);
fs.writeFileSync(path.join(src, "api", "lsp.ts"), LQ);
fs.writeFileSync(path.join(src, "api", "core.ts"), "export async function api<T = unknown>(p: string, _o?: RequestInit): Promise<T> { throw new Error(`no network in the test: ${p}`); }\n");
const copy = (source, sabotages, folder, prefix) => Object.entries(sabotages).map(([name, s], i) => {
  const file = path.join(folder, `${prefix}-sabotage-${i}.ts`);
  fs.writeFileSync(path.join(src, file), source.replace(s.old, s.fresh));
  return { name, file, catches: s.catches, places: source.split(s.old).length - 1 };
});
const kCopies = copy(KQ, K_SABOTAGES, "", "buffer-coordinates"), lCopies = copy(LQ, L_SABOTAGES, "api", "lsp");
const allTs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allTs(path.join(dir, e.name)) : [path.join(dir, e.name)]));
try {
  execFileSync(process.execPath, [tsc, ...allTs(src), "--outDir", out, "--rootDir", src, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--strict", "--lib", "es2022,dom"], { stdio: "pipe" });
} catch (e) {
  const text = `${String(e.stdout || "")}${String(e.stderr || "")}`;
  const realError = text.split("\n").filter((z) => /error TS\d+/.test(z) && !/-sabotage-\d+\.ts\(/.test(z));
  if (realError.length || !fs.existsSync(path.join(out, "buffer-coordinates.js"))) throw new Error(`tsc: ${text}`.slice(0, 4000));
}
const load = (file) => import(pathToFileURL(path.join(out, file.replace(/\.ts$/, ".js"))).href);
const P = await load("buffer.ts"), L = await load(path.join("api", "lsp.ts")), A = await load("lsp-change.ts"), K = await load("buffer-coordinates.ts");
const kSabotaged = await Promise.all(kCopies.map(async (x) => ({ ...x, mod: await load(x.file) })));
const lSabotaged = await Promise.all(lCopies.map(async (x) => ({ ...x, mod: await load(x.file) })));
try { fs.rmSync(tmp, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory stayed behind:", String(e?.message || e).slice(0, 120)); }

// ── The fake server: ONE disk by absolute paths; each route has its root (a copy its own) ─────────────────────────
const W = { apiBase: "/api/workspaces/w1", instance: null };
const P1 = { apiBase: "/api/projects/p1", instance: null };
const P2 = { apiBase: "/api/projects/p2", instance: null };
const P3 = { apiBase: "/api/projects/p3", instance: null };
const P9 = { apiBase: "/api/projects/p9", instance: null };
const K1 = { apiBase: "/api/projects/p1", instance: "p1/copy-k1" };
/** The list of `/api/workspaces`: p1 and p2 in the workspace folder (p2 under a subfolder), p3 OUTSIDE (a folder with the same beginning). */
const list = (projects = { p1: "/ws/orbit-2", p2: "/ws/group/other", p3: "/ws-alt/p3" }) =>
  [{ id: "w1", name: "W", path: "/ws", projects: Object.entries(projects).map(([id, p]) => ({ id, name: id, path: p })) }];
const sha = (t) => crypto.createHash("sha256").update(t, "utf8").digest("hex");
function server(files = {}) {
  const disk = new Map(Object.entries(files));
  const roots = { "/api/workspaces/w1": "/ws", "/api/projects/p1": "/ws/orbit-2", "/api/projects/p2": "/ws/group/other", "/api/projects/p3": "/ws-alt/p3", "/api/projects/p9": "/ws/fresh" };
  const requests = [];
  const error = (status, fields, msg = "x") => Object.assign(new Error(msg), { httpStatus: status, ...fields });
  const t = async (url, opts = {}) => {
    const u = new URL(url, "http://x");
    const m = /^(\/api\/(?:workspaces|projects)\/[^/]+)\/(.+)$/.exec(u.pathname);
    if (!m) throw error(404, {}, `unknown: ${u.pathname}`);
    const body = opts.body ? JSON.parse(opts.body) : {};
    const instance = u.searchParams.get("instance");
    const root = instance ? `/copies/${instance}` : roots[m[1]];
    const file = u.searchParams.get("path") ?? body.path ?? body.file ?? null;
    const abs = file === null ? null : file.startsWith("/") ? file : `${root}/${file}`;
    requests.push({ base: m[1], instance, action: m[2], file, abs, body, method: opts.method ?? "GET" });
    if (m[2] === "files/read") {
      if (!disk.has(abs)) throw error(400, {}, `ENOENT: no such file or directory, stat '${abs}'`);
      const c = disk.get(abs);
      return { content: c, sha: sha(c) };
    }
    if (m[2] === "files/write") {
      const now = disk.get(abs);
      if (body.base !== undefined && (now === undefined || sha(now) !== body.base)) throw error(409, { code: "CHANGED", current: now === undefined ? null : sha(now), missing: now === undefined });
      disk.set(abs, body.content);
      return { ok: true, sha: sha(body.content) };
    }
    if (m[2].startsWith("lsp/")) return {};
    throw error(404, {}, `unknown: ${m[2]}`);
  };
  return { t, requests, read: (abs) => disk.get(abs), migrate: (base, root) => { roots[base] = root; } };
}
/** Fresh state: no buffers, no cards, no reconcile; both transports on the fake server. */
function fresh(k, files) {
  P.forgetAllBuffers(); k.forgetCards(); L.forgetLspReconcile();
  const s = server(files);
  P.setTransport(s.t); L.setLspTransport(s.t);
  return s;
}
/** A fake view: holds its own text, receives foreign areas, types itself. */
function view(p) {
  const a = { text: p.text, apply(b) { a.text = P.applyToText(a.text, b); } };
  a.release = p.connect(a);
  a.type = (b) => { a.text = P.applyToText(a.text, P.asAreas(a.text, b)); p.ofView(a, b); };
  return a;
}
const loaded = async (p) => { const release = p.hold("tab"); const r = await p.load(); assert.equal(r.kind, "text", `${p.path}: ${r.kind}`); return release; };
const lspRequests = (s) => s.requests.filter((a) => a.action.startsWith("lsp/"));

// ── (1) Checks ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const CHECKS = {
  async oneBuffer(k) {
    const s = fresh(k, { "/ws/orbit-2/a.ts": "text\n" });
    k.reportWorkspaces(list());
    const kW = k.coordinatesOf(W), kP = k.coordinatesOf(P1);
    const pW = k.bufferFor(kW, "orbit-2/a.ts"), pP = k.bufferFor(kP, "a.ts");
    assert.equal(pW, pP, "the same file via the workspace and the project level is ONE buffer");
    assert.deepEqual([pW.target, pW.path], [P1, "a.ts"], "the buffer speaks canonically (project, main, path relative to the project)");
    const releaseW = await loaded(pW), releaseP = pP.hold("tab");
    assert.deepEqual(s.requests.map((a) => [a.base, a.instance, a.action, a.file]), [["/api/projects/p1", null, "files/read", "a.ts"]], "read ONCE, via the project");
    const A1 = view(pW), B1 = view(pP);
    A1.type([{ from: 0, to: 4, insert: "ONE" }]);
    assert.deepEqual([B1.text, pP.dirty, k.findInView(kP, "a.ts")?.dirty], ["ONE\n", true, true], "typing in Coding → Files shows in the code tab of the chat, unsaved at both places");
    const v = pP.version;
    await L.lspQuestion(pW, "hover", {});
    await L.lspQuestion(pP, "hover", {});
    assert.deepEqual(lspRequests(s).map((a) => [a.base, a.instance, a.body.file, a.body.buffer, a.body.version, "text" in a.body]),
      [["/api/projects/p1", null, "a.ts", pP.buffer, v, true], ["/api/projects/p1", null, "a.ts", pP.buffer, v, false]],
      "buffer and version of the language service are the same at both places — the second does not send the text again");
    assert.equal((await pP.save()).kind, "saved");
    assert.deepEqual([s.read("/ws/orbit-2/a.ts"), pW.dirty, s.requests.filter((a) => a.action === "files/write").map((a) => [a.base, a.file])],
      ["ONE\n", false, [["/api/projects/p1", "a.ts"]]], "saved from the chat is saved in Coding → Files too (one write)");
    assert.equal(k.keyInView(kW, "orbit-2/a.ts"), k.keyInView(kP, "a.ts"), "breadcrumbs and jump targets: the same key");
    k.renameInView(kW, "orbit-2/a.ts", "orbit-2/src/a.ts");
    assert.deepEqual([pP.path, k.findInView(kP, "src/a.ts"), k.findInView(kP, "a.ts")], ["src/a.ts", pP, null], "renamed in the workspace view: the chat tab moves along");
    k.renameInView(kP, "src/a.ts", "lib/a.ts");
    assert.equal(k.findInView(kW, "orbit-2/lib/a.ts"), pW, "renamed in the chat: Coding → Files moves along");
    A1.release(); B1.release(); releaseW(); releaseP();
  },
  // Name of a root — for title and suffix of a comparison of two files from two targets (VS Code, several roots:
  // "{root} • {path}"). Read from the same list as the cards; before the first reading the identifier.
  async names(k) {
    fresh(k, {});
    assert.deepEqual([k.rootName(W), k.rootName(P1), k.rootName(K1)], ["w1", "p1", "p1 (k1)"], "before the first reading: the identifier (a copy with its name)");
    k.reportWorkspaces([{ id: "w1", name: "Firm", path: "/ws", projects: [{ id: "p1", name: "ORBIT", path: "/ws/orbit-2" }] }]);
    assert.deepEqual([k.rootName(W), k.rootName(P1), k.rootName(K1), k.rootName(P2)], ["Firm", "ORBIT", "ORBIT (k1)", "p2"], "the name of the workspace or project; an unknown one keeps the identifier");
    k.reportWorkspaces([{ id: "w1", name: "Firm", path: "/ws", projects: [{ id: "p1", name: "ORBIT new", path: "/ws/orbit-2" }] }]);
    assert.equal(k.rootName(P1), "ORBIT new", "renamed with the same card: the new name");
    k.forgetCards();
    assert.equal(k.rootName(P1), "p1", "forgotten means: the identifier again");
  },
  async withoutProject(k) {
    const s = fresh(k, { "/ws/notes/x.md": "n\n", "/ws/orbit-2x/a.ts": "near\n", "/ws/orbit-2/a.ts": "p\n" });
    k.reportWorkspaces(list());
    const kW = k.coordinatesOf(W);
    const n = k.bufferFor(kW, "notes/x.md"), fast = k.bufferFor(kW, "orbit-2x/a.ts"), p = k.bufferFor(kW, "orbit-2/a.ts");
    assert.deepEqual([n.target, n.path, fast.target, fast.path, p.target], [W, "notes/x.md", W, "orbit-2x/a.ts", P1],
      "a file without a project keeps its own buffer of the workspace level (also next to a project folder with the same beginning)");
    const release = await loaded(n);
    assert.deepEqual(s.requests.map((a) => [a.base, a.file]), [["/api/workspaces/w1", "notes/x.md"]], "read via the workspace route");
    assert.equal(k.inView(k.coordinatesOf(P1), W, "notes/x.md"), null, "it does not lie in a project view");
    release();
  },
  async copies(k) {
    fresh(k, { "/ws/orbit-2/a.ts": "main\n", "/copies/p1/copy-k1/a.ts": "copy\n" });
    k.reportWorkspaces(list());
    const kW = k.coordinatesOf(W), kP = k.coordinatesOf(P1), kK = k.coordinatesOf(K1);
    const h = k.bufferFor(kW, "orbit-2/a.ts"), c = k.bufferFor(kK, "a.ts");
    assert.notEqual(h, c, "a copy is a buffer of its own");
    const releaseH = await loaded(h), releaseC = await loaded(c);
    assert.deepEqual([h.text, c.text, c.target], ["main\n", "copy\n", K1]);
    assert.deepEqual([k.inView(kW, K1, "a.ts"), k.inView(kP, K1, "a.ts"), k.inView(kK, P1, "a.ts"), k.inView(kK, K1, "a.ts")], [null, null, null, "a.ts"],
      "a place of a copy lies in no view of main (otherwise a hit of the copy would open the file of main)");
    releaseH(); releaseC();
  },
  async notLoaded(k) {
    fresh(k, { "/ws/orbit-2/a.ts": "a\n" });
    const kW = k.coordinatesOf(W);
    assert.deepEqual([kW.ready, k.bufferFor(kW, "orbit-2/a.ts"), k.findInView(kW, "orbit-2/a.ts"), k.keyInView(kW, "orbit-2/a.ts"), P.allBuffers().length],
      [false, null, null, null, 0], "without a project list read: not ready, and no buffer is created");
    k.reportWorkspaces([{ id: "w1", name: "W", path: "/ws" }]);
    assert.equal(k.coordinatesOf(W).ready, false, "a row without a project list is unknown, not empty");
    k.reportWorkspaces([{ id: "w2", name: "W2", path: "/w2", projects: [] }]);
    assert.equal(k.coordinatesOf(W).ready, false, "the list of another workspace says nothing about this one");
    const inChat = P.buffer(P1, "a.ts"); // meanwhile a chat opens the file at the project level
    k.reportWorkspaces(list());
    const kW2 = k.coordinatesOf(W);
    assert.deepEqual([kW2.ready, k.bufferFor(kW2, "orbit-2/a.ts"), P.allBuffers().length], [true, inChat, 1], "the list arrives: the same buffer, no second one");
    k.reportWorkspaces(list());
    assert.equal(k.coordinatesOf(W), kW2, "an equal list changes nothing (the same object for the dependencies of the hooks)");
  },
  async lspHits(k) {
    fresh(k, { "/ws/orbit-2/a.ts": "const a = b;\n", "/ws/orbit-2/frontend/b.ts": "export const b = 1;\n" });
    k.reportWorkspaces(list());
    const kW = k.coordinatesOf(W), kP = k.coordinatesOf(P1);
    assert.deepEqual([k.inView(kW, P1, "frontend/b.ts"), k.inView(kP, P1, "frontend/b.ts"), k.inView(kW, P2, "x.ts"), k.inView(kW, W, "notes/x.md")],
      ["orbit-2/frontend/b.ts", "frontend/b.ts", "group/other/x.ts", "notes/x.md"], "a hit (relative to the target of the asking buffer) lands at the path of the view");
    assert.equal(k.inView(kW, P1, "/usr/lib/node_modules/x/index.d.ts"), "/usr/lib/node_modules/x/index.d.ts", "a target outside any instance stays as it is");
    assert.deepEqual([k.inView(kW, P3, "a.ts"), k.inView(kP, P2, "x.ts")], [null, null], "a project outside the workspace folder (or another project) does not lie in the view");
    const pW = k.bufferFor(kW, "orbit-2/a.ts");
    const release = await loaded(pW);
    const B1 = view(k.bufferFor(kP, "a.ts"));
    const opened = [];
    const editor = { openInBackground: (p) => opened.push(k.inView(kW, p.target, p.path)) }; // like CodePane `editorHolder`
    const edit = (z, c) => ({ range: { start: { line: 0, character: c }, end: { line: 0, character: c + 1 } }, newText: z });
    const r = await A.applyWorkspaceEdit(pW.target, { changes: [{ file: "a.ts", edits: [edit("c", 10)] }, { file: "frontend/b.ts", edits: [edit("c", 13)] }] }, { editor });
    assert.deepEqual(r, { kind: "ok", files: ["a.ts", "frontend/b.ts"] });
    assert.equal(B1.text, "const a = c;\n", "a rename from the workspace view shows in the project view");
    assert.deepEqual([opened, k.findInView(kW, "orbit-2/frontend/b.ts")?.text], [["orbit-2/frontend/b.ts"], "export const c = 1;\n"], "the background tab opens at the path of the view");
    B1.release(); release();
  },
  async relocation(k) {
    const s = fresh(k, { "/ws/fresh/a.ts": "a\n", "/ws/group/other/b.ts": "b\n", "/ws/orbit-2/c.ts": "c\n", "/ws/new2/e.ts": "e\n" });
    k.reportWorkspaces(list({ p1: "/ws/orbit-2", p2: "/ws/group/other" }));
    const kW = k.coordinatesOf(W);
    let reported = 0;
    const off = k.subscribeCards(() => { reported += 1; });
    const a = k.bufferFor(kW, "fresh/a.ts"), b = k.bufferFor(kW, "group/other/b.ts"), e = k.bufferFor(kW, "new2/e.ts");
    const release = [await loaded(a), await loaded(b), await loaded(e)];
    for (const p of [a, b, e]) view(p).type([{ from: 0, to: 0, insert: "x" }]);
    const c = P.buffer(P1, "c.ts");
    const e2 = P.buffer({ apiBase: "/api/projects/p10", instance: null }, "e.ts"); // a chat already holds the file in the new project
    assert.deepEqual([a.target, b.target, e.target], [W, P2, W]);
    // p9 arises via `fresh/`, p10 via `new2/`, p2 falls, p1 moves to `orbit-new/`.
    s.migrate("/api/projects/p1", "/ws/orbit-new");
    k.reportWorkspaces(list({ p1: "/ws/orbit-new", p9: "/ws/fresh", p10: "/ws/new2" }));
    const kW2 = k.coordinatesOf(W);
    assert.deepEqual([reported, kW2 === kW], [1, false], "a changed list reports itself (the hooks recompute)");
    assert.deepEqual([a.target, a.path, a.text, a.dirty, k.bufferFor(kW2, "fresh/a.ts")], [P9, "a.ts", "xa\n", true, a], "a project arises: the buffer moves into the project with its text");
    assert.deepEqual([b.target, b.path, b.text, b.dirty, k.bufferFor(kW2, "group/other/b.ts")], [W, "group/other/b.ts", "xb\n", true, b], "a project falls: the buffer moves to the workspace level with its text");
    assert.deepEqual([c.target, c.path, k.findInView(kW2, "orbit-new/c.ts")], [P1, "c.ts", c], "a project that stays keeps its buffers (even if its folder moves)");
    assert.deepEqual([e.target, e.path, e.text, e.dirty, e2.target.apiBase, e2.path], [W, "new2/e.ts", "xe\n", true, "/api/projects/p10", "e.ts"], "an occupied target: nothing is lost, nothing is overwritten");
    assert.equal((await a.save()).kind, "saved");
    assert.equal(s.read("/ws/fresh/a.ts"), "xa\n", "after the move the buffer saves via its new target");
    off(); for (const l of release) l();
  },
  async rename(k) {
    fresh(k, {});
    k.reportWorkspaces(list());
    const kW = k.coordinatesOf(W), kP = k.coordinatesOf(P1);
    const a = P.buffer(P1, "src/a.ts");
    k.renameInView(kW, "orbit-2/src/a.ts", "loose/a.ts");
    assert.deepEqual([a.target, a.path, k.findInView(kP, "src/a.ts")], [W, "loose/a.ts", null], "out of the project: the buffer becomes that of the workspace level");
    k.renameInView(kW, "loose/a.ts", "group/other/a.ts");
    assert.deepEqual([a.target, a.path], [P2, "a.ts"], "into another project");
    const x = P.buffer(W, "group/note.md");
    k.renameInView(kW, "group", "team");
    assert.deepEqual([x.path, a.target, a.path, k.findInView(kW, "team/other/a.ts")], ["team/note.md", W, "team/other/a.ts", a], "a folder with a project folder inside: its buffers move along");
    k.reportWorkspaces(list({ p1: "/ws/orbit-2", p2: "/ws/team/other", p3: "/ws-alt/p3" }));
    assert.deepEqual([a.target, a.path], [P2, "a.ts"], "the new list arrives: again the buffer of the project, the same object");
    const c = P.buffer(P1, "c.ts");
    k.renameInView(k.coordinatesOf(W), "orbit-2", "orbit-3");
    assert.equal(k.findInView(k.coordinatesOf(W), "orbit-3/c.ts"), c, "a project folder renamed itself: the tab finds its buffer");
    k.reportWorkspaces(list({ p1: "/ws/orbit-3", p2: "/ws/team/other", p3: "/ws-alt/p3" }));
    assert.deepEqual([c.target, c.path], [P1, "c.ts"], "and after the new list it is that of the project again");
  },
  async collision(k) {
    // Workspace → Files opened the file at the workspace level when p1/p2 were not yet there; a chat already holds it at the project level.
    // Then the list with the projects arrives.
    const s = fresh(k, { "/ws/orbit-2/a.ts": "a\n", "/ws/group/other/c.ts": "c\n" });
    k.reportWorkspaces(list({}));
    const kW0 = k.coordinatesOf(W);
    const wa = k.bufferFor(kW0, "orbit-2/a.ts"), wc = k.bufferFor(kW0, "group/other/c.ts");
    const releaseWa = await loaded(wa), releaseWc = await loaded(wc);
    for (const [p, t] of [[wa, "MINE"], [wc, "X"]]) { const a = view(p); a.type([{ from: 0, to: 1, insert: t }]); a.release(); }
    const pa = k.bufferFor(k.coordinatesOf(P1), "a.ts"), pc = k.bufferFor(k.coordinatesOf(P2), "c.ts");
    const releasePa = await loaded(pa), releasePc = await loaded(pc);
    { const a = view(pc); a.type([{ from: 0, to: 1, insert: "Y" }]); a.release(); }
    assert.ok(wa !== pa && wc !== pc, "precondition: two buffers per file");
    k.reportWorkspaces(list({ p1: "/ws/orbit-2", p2: "/ws/group/other" }));
    const kW = k.coordinatesOf(W);
    // Clean target on the same disk: the text passes over, the tab switches, the source yields on release.
    assert.deepEqual([pa.text, pa.dirty], ["MINE\n", true], "the unsaved text did not pass into the occupied target");
    assert.equal(k.tabBufferFor(kW, "orbit-2/a.ts", wa), pa, "the tab does not switch to the canonical buffer although its text is there");
    releaseWa();
    assert.equal(P.findBuffer(W, "orbit-2/a.ts"), null, "the source stayed behind although its text is in the target");
    // Both carry their own: the source stays with its text, the tab keeps it, a newly opened tab shows it.
    assert.deepEqual([wc.text, pc.text], ["X\n", "Y\n"], "a buffer with its own text was replaced");
    assert.equal(k.tabBufferFor(kW, "group/other/c.ts", wc), wc, "the tab switched and took unsaved text out of sight");
    releaseWc();
    assert.equal(P.findBuffer(W, "group/other/c.ts"), wc, "the source with its own text yielded (silently lost)");
    assert.equal(k.tabBufferFor(kW, "group/other/c.ts"), wc, "a newly opened tab does not show the text that stayed behind");
    assert.ok(wc.saveForAll, "save-all does not see the source that stayed behind");
    // Save-all: a ONCE (via the project); c tried twice — the second write fails on `base` (409), nothing silently overwritten.
    const r = await P.saveAll();
    const kind = (base, file) => r.find((x) => x.buffer.target.apiBase === base && x.buffer.path === file)?.result.kind;
    assert.deepEqual([kind(P1.apiBase, "a.ts"), r.filter((x) => x.buffer.path.endsWith("a.ts")).length, s.read("/ws/orbit-2/a.ts")], ["saved", 1, "MINE\n"]);
    assert.deepEqual([kind(W.apiBase, "group/other/c.ts"), kind(P2.apiBase, "c.ts")].sort(), ["changed", "saved"], "two buffers of the same file: the second write overwrote the first");
    releasePa(); releasePc();
  },
  async nested(k) {
    // pb lies in the folder of pa. The file belongs to the inner one — also in the view of the outer one.
    const PA = { apiBase: "/api/projects/pa", instance: null }, PB = { apiBase: "/api/projects/pb", instance: null }, PQ = { apiBase: "/api/projects/pq", instance: null };
    const KA = { apiBase: "/api/projects/pa", instance: "pa/copy-k" };
    const s = fresh(k, { "/ws/a/b/x.ts": "x\n", "/ws/a/y.ts": "y\n" });
    s.migrate(PA.apiBase, "/ws/a"); s.migrate(PB.apiBase, "/ws/a/b"); s.migrate(PQ.apiBase, "/ws/a");
    const only = (p) => [{ id: "w1", name: "W", path: "/ws", projects: Object.entries(p).map(([id, path]) => ({ id, name: id, path })) }];
    k.reportWorkspaces(only({ pa: "/ws/a" }));
    const q = k.bufferFor(k.coordinatesOf(PA), "b/x.ts");
    const release = await loaded(q);
    view(q).type([{ from: 0, to: 0, insert: "Q" }]);
    k.reportWorkspaces(only({ pa: "/ws/a", pb: "/ws/a/b" }));
    assert.deepEqual([q.target, q.path, q.text, q.dirty], [PB, "x.ts", "Qx\n", true], "pb arises: the buffer of the outer one moves into the inner one with its text");
    const kPa = k.coordinatesOf(PA), kW = k.coordinatesOf(W);
    assert.deepEqual([k.bufferFor(kPa, "b/x.ts"), k.bufferFor(kW, "a/b/x.ts"), k.bufferFor(k.coordinatesOf(PB), "x.ts")], [q, q, q], "the view of the outer one (or the workspace level) has a second buffer");
    assert.deepEqual([kPa.toCanon("y.ts").target, k.inView(kPa, PB, "x.ts"), k.inView(kW, PB, "x.ts")], [PA, "b/x.ts", "a/b/x.ts"]);
    const kKa = k.coordinatesOf(KA);
    assert.deepEqual(kKa.toCanon("b/x.ts"), { target: KA, path: "b/x.ts" }, "a copy of the outer one maps (it has its own files)");
    assert.equal((await q.save()).kind, "saved");
    assert.equal(s.read("/ws/a/b/x.ts"), "Qx\n", "saved via the inner project: the same file");
    k.reportWorkspaces(only({ pa: "/ws/a" }));
    assert.deepEqual([q.target, q.path], [PA, "b/x.ts"], "pb falls: the buffer moves back into the outer one");
    // A project with an equally long folder (the same folder) takes nothing over — neither in the view nor on a move.
    k.reportWorkspaces(only({ pa: "/ws/a", pq: "/ws/a" }));
    const yq = k.bufferFor(k.coordinatesOf(PQ), "y.ts");
    assert.deepEqual([yq.target, yq.path], [PQ, "y.ts"], "the view of a project with an equally long folder maps to the other one");
    k.reportWorkspaces(only({ pa: "/ws/a", pq: "/ws/a", p9: "/ws/fresh" }));
    assert.deepEqual([yq.target, yq.path], [PQ, "y.ts"], "an equally long folder took over the buffer on the move");
    release();
  },
  async order(k) {
    // Two readings overtake each other — the number counts, whoever reads BEFORE the request.
    fresh(k, { "/ws/orbit-2/a.ts": "a\n" });
    const n1 = k.beginReading(), n2 = k.beginReading();
    assert.equal(k.reportWorkspaces(list({ p1: "/ws/orbit-2" }), n2), true);
    const p = k.bufferFor(k.coordinatesOf(W), "orbit-2/a.ts");
    assert.equal(k.reportWorkspaces(list({}), n1), false, "the older answer counted");
    assert.deepEqual([p.target, k.cardOf("w1").projects.length], [P1, 1], "the older answer restored the old card (the buffer moved back)");
    // The loader draws its number before the request; the page reads afterwards and finishes first.
    let respond = null;
    k.setCardsTransport(() => new Promise((r) => { respond = r; }), () => {});
    try {
      const run = k.loadCards();
      const n3 = k.beginReading();
      k.reportWorkspaces(list({ p1: "/ws/orbit-2", p9: "/ws/fresh" }), n3);
      respond(list({}));
      await run;
      assert.deepEqual([k.cardOf("w1").projects.map((x) => x.id), p.target], [["p1", "p9"], P1], "the answer of the loader overwrote a younger reading of the page");
    } finally { k.setCardsTransport(null); }
  },
  async loader(k) {
    // After an error it is read again. The clock is replaced: scheduling goes into a list, and the scheduled function returns the run it
    // triggers — it is waited for, never for the time.
    fresh(k, {});
    const gate = () => { let on; const p = new Promise((r) => { on = r; }); return { p, on }; };
    const scheduled = [];
    let requests = 0, response = () => Promise.reject(new Error("offline"));
    k.setCardsTransport((url) => { requests += 1; assert.equal(url, "/api/workspaces"); return response(); }, (fn, ms) => { scheduled.push({ fn, ms }); });
    let reported = 0, off = null;
    const next = async () => { const g = scheduled.shift(); assert.ok(g, "no re-read was scheduled"); await g.fn(); };
    try {
      await k.loadCards();
      assert.deepEqual([k.cardsError(), scheduled.length], ["offline", 0], "without a view that looks, nothing is scheduled (the next one reads itself) — the error stands anyway");
      k.forgetCards();
      off = k.subscribeCards(() => { reported += 1; });
      await k.loadCards();
      assert.deepEqual([reported, k.cardsError(), scheduled.map((g) => g.ms)], [1, "offline", [1000]], "the error does not stand (or is not reported), or it is not read again");
      for (let i = 0; i < 5; i += 1) await next();
      assert.deepEqual([scheduled.map((g) => g.ms), requests, reported], [[30000], 7, 1], "the interval does not grow capped (or an equal error reports itself every time)");
      assert.deepEqual([0, 1, 2, 3, 4, 5, 99, -1].map(k.repeatGap), [1000, 2000, 5000, 10000, 30000, 30000, 30000, 1000]);
      // The server answers again: error gone (reported), card there, nothing scheduled any more.
      response = () => Promise.resolve(list());
      await next();
      assert.deepEqual([k.cardsError(), Boolean(k.cardOf("w1")), scheduled.length, reported > 1], [null, true, 0, true], "after a success the error stands on (or scheduling continues)");
      // ONE run at a time; a nudge meanwhile reads once more afterwards (it may have come after the change the first did not see).
      const first = gate();
      const prior = requests;
      response = () => (requests === prior + 1 ? first.p : Promise.resolve(list()));
      const l1 = k.loadCards(), l2 = k.loadCards();
      assert.deepEqual([requests - prior, l1 === l2], [1, true], "two runs at once");
      first.on(list());
      await l1;
      assert.equal(requests - prior, 2, "the nudge during reading was lost");
    } finally { off?.(); k.setCardsTransport(null); }
  },
  stale(k) {
    fresh(k, {});
    assert.equal(k.cardsStale({ type: "project/setup", projectId: "p77" }), false, "without a card read (the view reads anyway)");
    k.reportWorkspaces(list());
    const cases = [
      [{ type: "project/setup", projectId: "p77" }, true], // a new project
      [{ type: "project/setup", projectId: "p1" }, false],
      [{ type: "project/layout", projectId: "p1", kind: "finished" }, true], // an adopted layout moves folders
      [{ type: "project/layout", projectId: "p1", kind: "check" }, false],
      [{ type: "lsp/status", projectId: "p77" }, false],
      [{ type: "project/instance" }, false],
      [null, false],
    ];
    assert.deepEqual(cases.map(([e]) => k.cardsStale(e)), cases.map(([, v]) => v));
  },
  async normed(k) {
    // The same file in another spelling is no second buffer (the server resolves with path.resolve).
    fresh(k, { "/ws/orbit-2/a.ts": "a\n", "/ws/notes/x.md": "n\n" });
    const kP0 = k.coordinatesOf(P1); // without a card: the identity, normalised too
    assert.deepEqual([k.bufferFor(kP0, "./b.ts") === k.bufferFor(kP0, "b.ts"), k.bufferFor(kP0, "src//../b.ts").path], [true, "b.ts"]);
    k.reportWorkspaces([{ id: "w1", name: "W", path: "/ws/", projects: [] }]);
    const w = k.bufferFor(k.coordinatesOf(W), "orbit-2//a.ts");
    assert.deepEqual([w.target, w.path], [W, "orbit-2/a.ts"]);
    k.reportWorkspaces([{ id: "w1", name: "W", path: "/ws/", projects: [{ id: "p1", path: "/ws//orbit-2/./" }] }]);
    assert.deepEqual([w.target, w.path], [P1, "a.ts"], "the buffer did not move into the project (folder in another spelling)");
    const kW = k.coordinatesOf(W), kP = k.coordinatesOf(P1);
    assert.deepEqual(["orbit-2/a.ts", "./orbit-2//a.ts", "orbit-2/src/../a.ts"].map((pf) => k.bufferFor(kW, pf) === w), [true, true, true], "another spelling is a second buffer");
    assert.equal(k.bufferFor(kP, "./a.ts"), w);
    assert.equal(k.bufferFor(kW, "notes//x.md"), k.bufferFor(kW, "notes/x.md"), "a file of the workspace level in another spelling");
    assert.deepEqual([k.inView(kW, P1, "src/../a.ts"), k.inView(kW, P1, "../../etc/x")], ["orbit-2/a.ts", null], "a place of the language service in another spelling (or outside)");
  },
};
/** The language service on a target change of the same buffer (move between project and workspace level, copy): unregister the old file, register the new one with text. */
const L_CHECKS = {
  async lspTarget(l) {
    const s = server({});
    l.setLspTransport(s.t); l.forgetLspReconcile();
    const q = { target: P1, path: "a.ts", buffer: "b-1", version: 3, text: "x\n" };
    await l.lspQuestion(q, "hover", {});
    assert.deepEqual([l.lspKnowsStatus(q), l.lspKnowsStatus({ ...q, target: K1 })], [true, false], "the state only applies to target AND file");
    await l.lspQuestion({ ...q, target: K1 }, "hover", {});
    assert.deepEqual(lspRequests(s).map((a) => [a.base, a.instance, a.action, a.body.file, "text" in a.body]), [
      ["/api/projects/p1", null, "lsp/hover", "a.ts", true],
      ["/api/projects/p1", null, "lsp/close", "a.ts", false],
      ["/api/projects/p1", "p1/copy-k1", "lsp/hover", "a.ts", true],
    ], "a target change with the same path unregisters the old file and registers the new one with text");
    await l.lspQuestion({ ...q, target: W, path: "orbit-2/a.ts", version: 4 }, "hover", {});
    assert.deepEqual(lspRequests(s).slice(3).map((a) => [a.base, a.instance, a.action, a.body.file, "text" in a.body]), [
      ["/api/projects/p1", "p1/copy-k1", "lsp/close", "a.ts", false],
      ["/api/workspaces/w1", null, "lsp/hover", "orbit-2/a.ts", true],
    ]);
  },
};

test("(1) lib/buffer-coordinates.ts: ONE buffer across both levels, own buffer without a project, copies separate, not loaded creates nothing, LSP hits at the path of the view, move, rename, occupied target, nested, order, loader, normalised, target change in the language service", async () => {
  for (const [name, check] of Object.entries(CHECKS)) {
    try { await check(K); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
  for (const [name, check] of Object.entries(L_CHECKS)) {
    try { await check(L); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
});

test("(1) counter-tests: each sabotage bites at exactly one place and is caught by its check", async () => {
  const notCaught = [];
  for (const [s, checks] of [...kSabotaged.map((x) => [x, CHECKS]), ...lSabotaged.map((x) => [x, L_CHECKS])]) {
    assert.equal(s.places, 1, `sabotage "${s.name}": the place occurs ${s.places}× in the source — the sabotage is stale`);
    let caught = false;
    try { await checks[s.catches](s.mod); } catch { caught = true; }
    if (!caught) notCaught.push(`${s.name} (${s.catches})`);
  }
  assert.deepEqual(notCaught, [], "sabotages that no check catches");
  console.log(`  [buffer-coordinates] ${kSabotaged.length + lSabotaged.length} sabotages, each caught`);
});

// ── (2) The views go through the coordinates ────────────────────────────────────────────────────────────────────────────────────
const withoutComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const Q = {
  editor: read("src", "components", "code", "BufferEditor.tsx"),
  codePane: read("src", "components", "CodePane.tsx"),
  diffTab: read("src", "components", "code", "DiffTab.tsx"),
  hook: read("src", "components", "chat", "chatTabs.ts"),
  area: read("src", "components", "chat", "ChatCodeArea.tsx"),
  connection: read("src", "components", "code", "navigation-connection.tsx"),
  navigation: read("src", "components", "code", "lsp-navigation.ts"),
  addon: read("src", "components", "code", "lsp-extension.ts"),
  core: read("src", "components", "code", "lsp-nav-core.ts"),
  references: read("src", "components", "code", "ReferencesBar.tsx"),
  breadcrumbs: read("src", "components", "code", "Breadcrumbs.tsx"),
  hookK: read("src", "components", "code", "coordinates.ts"),
  page: read("src", "app", "workspaces", "page.tsx"),
  i18n: read("src", "lib", "i18n-de.ts"),
};
const SOURCE_CHECKS = {
  editor(q) {
    const e = withoutComments(q.editor);
    assert.ok(e.includes("const p = tabBufferFor(kRef.current, pf);") && e.includes("if (p) m.set(pf,"), "the tabs fetch their buffer past the coordinates (or create one without a mapping)");
    // After every render a tab switches to the buffer it is to hold — first hold, then release without `dismiss`.
    assert.ok(e.includes("const n = tabBufferFor(kRef.current, pf, e.p);") && e.includes("m.set(pf, { p: n, release: n.hold(\"tab\"), off: subscription(n), targetK: e.targetK });\n      e.off(); e.release();"), "a tab keeps holding the old buffer after a move (or discards it on switching)");
    assert.ok(e.includes("findInView(kRef.current, pf)"), "`bufferOf` searches past the coordinates");
  },
  codePane(q) {
    const c = withoutComments(q.codePane);
    assert.ok(c.includes("const coord = useCoordinates(target)") && c.includes("useBufferTabs(coord, tabs.map((x) => x.path)"), "CodePane holds its tabs without coordinates");
    assert.ok(c.includes("const k = coordRef.current.toCanon(path); if (!k) return;") && c.includes("loadBuffer(k.target, k.path, {"), "CodePane loads in the coordinates of the view (second buffer) or without a mapping");
    assert.ok(c.includes("const pf = inView(coordRef.current, p.target, p.path); if (pf === null) return;"), "the background tab opens the canonical path instead of the path of the view");
    assert.ok(c.includes("renameInView(coord, path, to);") && c.includes("renameInView(coordRef.current, x.path, n)"), "renaming in the tree (or after the layout) does not move the buffers via the coordinates");
    assert.ok(c.includes("useNavigation({ coordinates: coord,"), "the navigation does not get the coordinates");
  },
  diffTab(q) {
    const d = withoutComments(q.diffTab);
    // When comparing two files: the coordinates of the target of the RIGHT side (the left one may come from another area).
    assert.ok(d.includes("const coord = useCoordinates(source.kind === \"files\" ? source.rightTarget : (bufferTarget ?? target));") &&d.includes("useBufferTabs(coord, writeSource && file ? [file] : [])"), "the right side of the diff tab does not hang on the coordinates");
    assert.ok(d.includes("const waiting = writeSource && Boolean(file) && !coord.ready;") && d.includes("if (waiting) return;"), "the diff tab loads before the mapping is known");
  },
  chat(q) {
    assert.equal(withoutComments(q.hook).split("findInView(coordinatesOf(tab.target), ").length - 1, 1, "a chat tab finds its buffer past the coordinates");
    assert.ok(withoutComments(q.hook).includes("return d === null ? null : findInView(coordinatesOf(tab.target), d);"), "a chat tab (file or diff with a writable side) finds its buffer past the coordinates");
    assert.ok(withoutComments(q.area).includes("const pf = inView(coordinatesOf(z), p.target, p.path); if (pf !== null) tabsRef.current.open({ kind: \"file\", target: z, path: pf }"), "the background tab of the chat opens the canonical path");
  },
  navigation(q) {
    const a = withoutComments(q.connection);
    assert.ok(a.includes("pathOf: (p: Buffer) => inView(run.current.coordinates, p.target, p.path),"), "the history remembers canonical paths");
    assert.ok(a.includes("const path = inView(run.current.coordinates, target, location.file);") && a.includes("if (path === null) {"), "a hit opens without conversion (or a place that does not lie in the view)");
    assert.ok(a.includes("keyInView(run.current.coordinates, s.path) === k"), "the pending jump compares past the coordinates");
    assert.ok(withoutComments(q.navigation).includes("void n.connection.open(n.buffer.target, location, locationOf(view));") && withoutComments(q.navigation).includes("n.connection.pathOf(n.buffer)"), "lsp-navigation does not name the target of the asking buffer");
    assert.ok(withoutComments(q.addon).includes("void n.open(p.target, location);"), "lsp-extension does not name the target of the asking buffer");
    assert.ok(withoutComments(q.core).includes("n.connection ? n.connection.pathOf(n.buffer) : n.buffer.path"), "the remembered spot carries the canonical path");
    const r = withoutComments(q.references);
    assert.ok(r.split("connection.open(e.target, ").length - 1 === 3 && r.includes("rowLoader(e.target, e.source)"), "the references open relative to a target other than that of the asking buffer");
  },
  frame(q) {
    assert.ok(withoutComments(q.breadcrumbs).includes("keyInView(useCoordinates(target), path)"), "the breadcrumbs ask the buffer of the view past the coordinates");
    const h = withoutComments(q.hookK);
    assert.ok(h.includes("if (wid ? !cardOf(wid) : !cardWithProject(pid)) void loadCards();"), "without a list read the hook does not read it (the tabs would wait forever)");
    // Re-reading happens on focus and on events of the stream that report a new situation; the read error is shown.
    assert.ok(h.includes("window.addEventListener(\"focus\", focus);") && h.includes("const stream = subscribeGlobalEvents((evt) => { if (cardsStale(evt)) void loadCards(); });"), "the hook does not re-read on focus or event");
    assert.ok(h.includes("const f = k.ready ? null : cardsError();") && h.includes("t(\"The workspace's projects could not be read — retrying: {msg}\", { msg: f })"), "a waiting view does not show the read error");
    assert.ok(q.i18n.includes("\n  \"The workspace's projects could not be read — retrying: {msg}\": "), "the read error has no English text");
    // The page draws its number BEFORE the request.
    const page = withoutComments(q.page), iSeq = page.indexOf("const seq = beginReading();"), iApi = page.indexOf("await api<Workspace[]>(\"/api/workspaces\")", iSeq);
    assert.ok(iSeq >= 0 && iApi > iSeq && page.includes("reportWorkspaces(listItems, seq);"), "the page does not report its workspace list (or without the number of its reading)");
  },
};
const SOURCE_SABOTAGES = {
  "tabs without coordinates": { file: "editor", old: "const p = tabBufferFor(kRef.current, pf);", fresh: "const p = buffer(k.target, pf);", catches: "editor" },
  "tab never switches": { file: "editor", old: "const n = tabBufferFor(kRef.current, pf, e.p);", fresh: "const n = e.p;", catches: "editor" },
  "tab switches and discards": { file: "editor", old: "      e.off(); e.release();\n      switched = true;", fresh: "      e.off(); e.release({ dismiss: true });\n      switched = true;", catches: "editor" },
  "CodePane loads in view coordinates": { file: "codePane", old: "loadBuffer(k.target, k.path, {", fresh: "loadBuffer(target, path, {", catches: "codePane" },
  "background tab without conversion": { file: "codePane", old: "const pf = inView(coordRef.current, p.target, p.path); if (pf === null) return;", fresh: "const pf = p.path;", catches: "codePane" },
  "rename in the tree without coordinates": { file: "codePane", old: "renameInView(coord, path, to);", fresh: "renameBuffer(target, path, to);", catches: "codePane" },
  "diff tab does not wait": { file: "diffTab", old: "if (waiting) return;", fresh: "", catches: "diffTab" },
  "comparison: buffer in the target of the tab instead of the right side": { file: "diffTab", old: "useCoordinates(source.kind === \"files\" ? source.rightTarget : (bufferTarget ?? target))", fresh: "useCoordinates(bufferTarget ?? target)", catches: "diffTab" },
  "chat tab does not search canonically": { file: "hook", old: "findInView(coordinatesOf(tab.target), d)", fresh: "findBuffer(tab.target, d)", catches: "chat" },
  "chat background without conversion": { file: "area", old: "path: pf }", fresh: "path: p.path }", catches: "chat" },
  "hit without conversion": { file: "connection", old: "const path = inView(run.current.coordinates, target, location.file);", fresh: "const path = location.file;", catches: "navigation" },
  "spot in view coordinates": { file: "core", old: "n.connection ? n.connection.pathOf(n.buffer) : n.buffer.path", fresh: "n.buffer.path", catches: "navigation" },
  "hook does not read": { file: "hookK", old: "if (wid ? !cardOf(wid) : !cardWithProject(pid)) void loadCards();", fresh: "", catches: "frame" },
  "project view does not read": { file: "hookK", old: "if (wid ? !cardOf(wid) : !cardWithProject(pid)) void loadCards();", fresh: "if (wid && !cardOf(wid)) void loadCards();", catches: "frame" },
  "stream does not re-read": { file: "hookK", old: "if (cardsStale(evt)) void loadCards();", fresh: "void evt;", catches: "frame" },
  "focus does not re-read": { file: "hookK", old: "window.addEventListener(\"focus\", focus);", fresh: "void focus;", catches: "frame" },
  "read error not shown": { file: "hookK", old: "const f = k.ready ? null : cardsError();", fresh: "const f = null;", catches: "frame" },
  "read error without English": { file: "i18n", old: "\n  \"The workspace's projects could not be read — retrying: {msg}\": ", fresh: "\n  \"projects not readable\": ", catches: "frame" },
  "page does not report": { file: "page", old: "reportWorkspaces(listItems, seq);", fresh: "void listItems;", catches: "frame" },
  "page reports without number": { file: "page", old: "reportWorkspaces(listItems, seq);", fresh: "reportWorkspaces(listItems);", catches: "frame" },
  "number after the request": { file: "page", old: "    const seq = beginReading();", fresh: "", catches: "frame" },
};
test("(2) The views go through the coordinates: tabs, load, background tab, rename, diff tab, chat, navigation, breadcrumbs, page (with counter-tests)", () => {
  for (const [name, check] of Object.entries(SOURCE_CHECKS)) {
    try { check(Q); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  }
  const notCaught = [];
  for (const [name, s] of Object.entries(SOURCE_SABOTAGES)) {
    assert.equal(Q[s.file].split(s.old).length - 1, 1, `sabotage "${name}": the place does not occur exactly once`);
    let caught = false;
    try { SOURCE_CHECKS[s.catches]({ ...Q, [s.file]: Q[s.file].replace(s.old, s.fresh) }); } catch { caught = true; }
    if (!caught) notCaught.push(name);
  }
  assert.deepEqual(notCaught, [], "source sabotages that no check catches");
});
