// Color picker and markdown in copies: lsp/actions.js `color_presentation`, lsp/markdown.js (copy, outside),
// runtime/fileAccess.js (`stamp`, glob with `suffixes`).
//   (1) `color_presentation` over a real session (fake server): B passes color and range through (`textDocument/colorPresentation`),
//       forwards only intact notations (label, `textEdit` with an intact range, `additionalTextEdits`), caps; without color or range
//       or with a channel outside 0…1 => 400; without the capability (`colorProvider`) empty; the action is in the contract
//   (2) Markdown in a COPY: the search takes all 13 suffixes in ONE pass; freshness reports change/delete/create as in the
//       main — with ONE call for all stamps, a stamp just read (open) without a notice; `markdownFreshness` does not wait and asks
//       at most once per FRESH_COPY_MS
//   (3) Links out of the project: `markdown/fs/stat` knows files and folders outside (existence and kind, as VS Code — in the copy
//       too, a link counts as its target), nothing else outside is read or listed
//   (4) The program in the container (`node -e PROGRAM`): `stamp` and `glob` with `suffixes` — the same cores, no reach outward
// The copy runs here through its own access (`setMarkdownAccess`) with the SAME cores as in the container, against a folder.
// Counter-tests (one sabotage each, the whole file run; 14 of 14 red): channel unchecked, range unchecked, asked without capability,
// no cap, broken textEdit or extra passed through (actions.js); search only `.md`, open stamp reports, freshness waits, freshness
// unthrottled, stat outside removed, link not as target (markdown.js); stamp without kind, `suffixes` ignored (fileAccess.js).
//
// Run (from server/backend/): CBASE_EMBED_OFFLINE=1 node --test test/lsp-vv.test.js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { endAllSessions, setStatusReporter } from "../electron/server/lsp/sessions.js";
import { lspEditorResponse } from "../electron/server/lsp/routes.js";
import { COLOR_NOTATIONS_CAP, notationsOf } from "../electron/server/lsp/actions.js";
import { REQUESTS, FRESH_COPY_MS, freshCopy, markdownFreshness, setMarkdownAccess } from "../electron/server/lsp/markdown.js";
import { MARKDOWN_SUFFIXES, setLspTable } from "../electron/server/lsp/table.js";
import { EDITOR_ACTIONS } from "../electron/server/lsp/contract.js";
import * as dz from "../electron/server/runtime/fileAccess.js";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-lsp-vv-")));
const project = path.join(root, "proj");
const outside = path.join(root, "outside");
for (const d of [project, outside, path.join(project, "docs"), path.join(project, "node_modules", "x"), path.join(outside, "folder")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(project, "a.css"), "a { color: red; }\n");
fs.writeFileSync(path.join(project, "a.json"), "{}\n");
fs.writeFileSync(path.join(outside, "secret.md"), "# Secret\n");
fs.symlinkSync(path.join(outside, "folder"), path.join(outside, "reference"));
const uri = (p) => pathToFileURL(p).href;

// ── (1) the fake server ──
const WRONG = path.join(root, "fake.mjs");
fs.writeFileSync(WRONG, `
let buffer = Buffer.alloc(0);
const color = process.argv[2] === "color";
const write = (x) => { const t = JSON.stringify(x); process.stdout.write("Content-Length: " + Buffer.byteLength(t) + "\\r\\n\\r\\n" + t); };
const R = (z) => ({ start: { line: z, character: 0 }, end: { line: z, character: 3 } });
function edit(m) {
  const response = (result) => write({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize": return response({ capabilities: color ? { colorProvider: true } : { hoverProvider: true } });
    case "textDocument/colorPresentation": {
      const c = m.params.color, k = (x) => Math.round(x * 255);
      const rgb = "rgb(" + k(c.red) + ", " + k(c.green) + ", " + k(c.blue) + ")";
      if (c.red === 0.5) return response(Array.from({ length: 40 }, (_, i) => ({ label: "#" + i })));
      return response([
        { label: rgb, textEdit: { range: m.params.range, newText: rgb } },
        { label: "#ff0000" },
        { label: "" },
        { textEdit: { range: R(0), newText: "x" } },
        { label: "broken", textEdit: { range: { start: { line: -1, character: 0 }, end: R(0).end }, newText: "x" } },
        { label: "with extra", additionalTextEdits: [{ range: R(1), newText: "@import x;\\n" }, { range: R(2) }, { newText: "y" }] },
      ]);
    }
    default: if (m.id !== undefined) response(null);
  }
}
process.stdin.on("data", (c) => {
  buffer = Buffer.concat([buffer, c]);
  for (;;) { const i = buffer.indexOf("\\r\\n\\r\\n"); if (i < 0) return; const l = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, i).toString())[1]);
    if (buffer.length < i + 4 + l) return; const m = JSON.parse(buffer.subarray(i + 4, i + 4 + l).toString()); buffer = buffer.subarray(i + 4 + l); edit(m); }
});
`);
const TARGET = { projectId: "pvv", instance: null, root: project, base: project };
const ed = (action, body = {}) => lspEditorResponse(action, body, (f) => (f ? { ...TARGET, abs: path.join(project, f) } : { ...TARGET }));
const TEXT = "a { color: red; }\n";
const q = (file, extra = {}) => ({ file, buffer: "p1", version: 1, text: file.endsWith(".json") ? "{}\n" : TEXT, ...extra });
const AREA = { start: { line: 0, character: 11 }, end: { line: 0, character: 14 } };

// ── (2)/(3) the access into the copy: the same cores as in the container, against a folder ──
const core = (op, o, paths) => dz.CORES.programCore(fs, path, crypto, op, o, paths, () => Buffer.alloc(0));
const fakeAccess = () => {
  const calls = [];
  return {
    calls,
    async stamp(_inst, paths) { calls.push(["stamp", paths.length]); return core("stamp", {}, paths).stamp; },
    async glob(_inst, rootDir, o) {
      calls.push(["glob", o]);
      const r = core("glob", { ...o, anchor: rootDir }, [rootDir]);
      return { total: r.total, hits: r.hits.map((t) => ({ p: path.join(rootDir, t.rel), m: t.m })) };
    },
    async stat(_inst, p) { calls.push(["stat", p]); try { return core("stat", {}, [p]); } catch (e) { if (e.code === "ENOENT") return null; throw e; } },
    async read(_inst, p) { calls.push(["read", p]); const r = core("read", { maxBytes: 1 << 20 }, [p]); return { ...r, data: r.data == null ? null : Buffer.from(r.data, "base64") }; },
    async list(_inst, p) { calls.push(["list", p]); return core("list", {}, [p]).entries; },
  };
};
const session = (extra = {}) => {
  const sent = [];
  return {
    root: project, rootReal: project, instance: null, area: null, documents: new Map(), sent,
    v: { note: (m, p) => sent.push({ note: m, p }), request: (m, p) => { sent.push({ request: m, p }); return Promise.resolve(null); } },
    ...extra,
  };
};
const COPY = { instance: "k1", projectId: "pvv" };

test.before(() => {
  setStatusReporter(() => {});
  setLspTable({ css: { command: [process.execPath, WRONG, "color"] }, json: { command: [process.execPath, WRONG] } });
});
test.after(() => {
  endAllSessions("test");
  setLspTable(null);
  setStatusReporter(null);
  setMarkdownAccess(null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("(1) color_presentation: color and range pass through, only intact notations, capped; 400 without color/range; empty without capability", async () => {
  assert.ok(EDITOR_ACTIONS.includes("color_presentation"), "the action is in the contract");
  assert.equal((await ed("status", { file: "a.css" })).status, 200);
  const r = await ed("color_presentation", q("a.css", { color: { red: 1, green: 0, blue: 0, alpha: 1 }, range: AREA }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.presentations, [
    { label: "rgb(255, 0, 0)", textEdit: { range: AREA, newText: "rgb(255, 0, 0)" } },
    { label: "#ff0000" },
    { label: "broken" },
    { label: "with extra", additionalTextEdits: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: "@import x;\n" }] },
  ]);
  const many = await ed("color_presentation", q("a.css", { color: { red: 0.5, green: 0, blue: 0, alpha: 1 }, range: AREA }));
  assert.equal(many.body.presentations.length, COLOR_NOTATIONS_CAP);
  assert.equal(COLOR_NOTATIONS_CAP, 16);
  for (const [what, body] of [
    ["no color", { range: AREA }],
    ["no range", { color: { red: 1, green: 0, blue: 0, alpha: 1 } }],
    ["channel above 1", { color: { red: 2, green: 0, blue: 0, alpha: 1 }, range: AREA }],
    ["no alpha", { color: { red: 1, green: 0, blue: 0 }, range: AREA }],
    ["range broken", { color: { red: 1, green: 0, blue: 0, alpha: 1 }, range: { start: { line: 0 }, end: AREA.end } }],
  ]) assert.equal((await ed("color_presentation", q("a.css", body))).status, 400, what);
  assert.equal((await ed("status", { file: "a.json" })).status, 200);
  const without = await ed("color_presentation", q("a.json", { color: { red: 1, green: 0, blue: 0, alpha: 1 }, range: AREA }));
  assert.deepEqual(without.body, { presentations: [] }, "without colorProvider no notations");
  assert.deepEqual(notationsOf(null), []);
});

test("(2) markdown in a copy: all 13 suffixes in ONE pass, freshness with ONE call, open stamp without notice", async () => {
  const z = fakeAccess();
  setMarkdownAccess(z);
  try {
    for (const e of MARKDOWN_SUFFIXES) fs.writeFileSync(path.join(project, "docs", `file.${e}`), "# x\n");
    fs.writeFileSync(path.join(project, "node_modules", "x", "README.md"), "x\n");
    fs.writeFileSync(path.join(project, "docs", "d.txt"), "x\n");
    const s = session({ instance: COPY });
    const all = (await REQUESTS["markdown/findMarkdownFilesInWorkspace"](s, {})).sort();
    assert.deepEqual(all, MARKDOWN_SUFFIXES.map((e) => uri(path.join(project, "docs", `file.${e}`))).sort(), "all suffixes, without node_modules and .txt");
    assert.equal(MARKDOWN_SUFFIXES.length, 13);
    assert.deepEqual(z.calls.filter((a) => a[0] === "glob").length, 1, "ONE pass in the container");

    const b = path.join(project, "docs", "file.md"), fresh = path.join(project, "fresh.md");
    await REQUESTS["markdown/fs/readFile"](s, { uri: uri(b) });
    assert.equal(s.mdRead.get(b), "?", "read in the copy: the stamp comes at the next look");
    REQUESTS["markdown/fs/watcher/create"](s, { id: 7, uri: uri(fresh), options: {} });
    REQUESTS["markdown/fs/watcher/create"](s, { id: 8, uri: uri(b), options: { ignoreChange: true } });
    z.calls.length = 0;
    assert.equal(await freshCopy(s), 0, "the first look only sets the stamps");
    assert.deepEqual(z.calls, [["stamp", 2]], "ONE call for all stamps (read and watched, no duplicates)");
    assert.match(s.mdRead.get(b), /^f:\d+:/);
    assert.equal(s.sent.length, 0);

    fs.writeFileSync(b, "# changed, longer\n");
    fs.writeFileSync(fresh, "# New\n");
    assert.equal(await freshCopy(s), 2);
    assert.deepEqual(s.sent.filter((x) => x.note).map((x) => x.p.changes), [[{ uri: uri(b), type: 2 }]]);
    assert.deepEqual(s.sent.filter((x) => x.request).map((x) => [x.p.id, x.p.kind]), [[7, "create"]], "change on 8 is ignored");
    s.sent.length = 0;
    fs.rmSync(b);
    await freshCopy(s);
    assert.deepEqual(s.sent.filter((x) => x.note).map((x) => x.p.changes), [[{ uri: uri(b), type: 3 }]]);
    assert.deepEqual(s.sent.filter((x) => x.request).map((x) => [x.p.id, x.p.kind]), [[8, "delete"]]);

    // markdownFreshness in the copy: does not wait (0 at once), asks at most once per FRESH_COPY_MS.
    s.sent.length = 0;
    z.calls.length = 0;
    fs.writeFileSync(fresh, "# New and different\n");
    assert.equal(markdownFreshness(s), 0);
    assert.equal(markdownFreshness(s), 0);
    assert.ok(s.mdFreshnessRunning, "the look runs afterwards");
    await s.mdFreshnessRunning;
    assert.equal(z.calls.filter((a) => a[0] === "stamp").length, 1, "asked twice, looked once");
    assert.deepEqual(s.sent.filter((x) => x.request).map((x) => [x.p.id, x.p.kind]), [[7, "change"]]);
    assert.ok(FRESH_COPY_MS >= 1000);
    markdownFreshness(s);
    assert.equal(s.mdFreshnessRunning ?? null, null, "right after: no new look");
  } finally {
    setMarkdownAccess(null);
    for (const e of MARKDOWN_SUFFIXES) fs.rmSync(path.join(project, "docs", `file.${e}`), { force: true });
    fs.rmSync(path.join(project, "fresh.md"), { force: true });
  }
});

test("(3) links out of the project: stat knows files and folders outside (in the copy too, link as target), nothing outside is read", async () => {
  const s = session();
  assert.deepEqual(await REQUESTS["markdown/fs/stat"](s, { uri: uri(path.join(outside, "secret.md")) }), { isDirectory: false });
  assert.deepEqual(await REQUESTS["markdown/fs/stat"](s, { uri: uri(path.join(outside, "folder")) }), { isDirectory: true });
  assert.deepEqual(await REQUESTS["markdown/fs/stat"](s, { uri: uri(path.join(outside, "reference")) }), { isDirectory: true });
  assert.equal(await REQUESTS["markdown/fs/stat"](s, { uri: uri(path.join(outside, "missing.md")) }), null);
  assert.equal(await REQUESTS["markdown/fs/stat"](s, { uri: "https://example.com/x.md" }), null, "not a file URI");
  await assert.rejects(REQUESTS["markdown/fs/readFile"](s, { uri: uri(path.join(outside, "secret.md")) }));
  await assert.rejects(REQUESTS["markdown/fs/readDirectory"](s, { uri: uri(outside) }));
  assert.equal(await REQUESTS["markdown/parse"](s, { uri: uri(path.join(outside, "secret.md")) }).then((t) => t.length), 0, "parse does not read outside");
  const z = fakeAccess();
  setMarkdownAccess(z);
  try {
    const k = session({ instance: COPY });
    assert.deepEqual(await REQUESTS["markdown/fs/stat"](k, { uri: uri(path.join(outside, "reference")) }), { isDirectory: true }, "copy: link as target");
    assert.deepEqual(await REQUESTS["markdown/fs/stat"](k, { uri: uri(path.join(outside, "secret.md")) }), { isDirectory: false });
    assert.ok(z.calls.every((a) => a[0] === "stat"), "in the copy via the container");
    await assert.rejects(REQUESTS["markdown/fs/readFile"](k, { uri: uri(path.join(outside, "secret.md")) }));
    assert.ok(!z.calls.some((a) => a[0] === "read"), "never read outside");
  } finally { setMarkdownAccess(null); }
});

test("(4) the program in the container: stamp and glob with suffixes (node -e PROGRAM)", () => {
  const run = (op, o, ...paths) => JSON.parse(execFileSync(process.execPath, ["-e", dz.PROGRAM, "--", op, JSON.stringify(o), ...paths], { encoding: "utf8" }).trim());
  fs.writeFileSync(path.join(project, "docs", "x.mdown"), "x\n");
  fs.writeFileSync(path.join(project, "docs", "y.MD"), "y\n");
  try {
    const st = run("stamp", {}, path.join(project, "docs"), path.join(project, "docs", "x.mdown"), path.join(project, "missing.md"));
    assert.equal(st.ok, true);
    assert.equal(st.stamp.length, 3);
    assert.match(st.stamp[0], /^d:/);
    assert.match(st.stamp[1], /^f:2:/);
    assert.equal(st.stamp[2], null);
    const g = run("glob", { suffixes: ["md", "mdown"], skip: ["node_modules"], maxFiles: 1000, maxHits: 100, anchor: project }, project);
    assert.deepEqual(g.hits.map((t) => t.rel).sort(), ["docs/x.mdown", "docs/y.MD"], "suffixes case-insensitive, node_modules skipped");
    const old = run("glob", { pattern: "*.css", skip: ["node_modules"], maxFiles: 1000, maxHits: 100, anchor: project }, project);
    assert.deepEqual(old.hits.map((t) => t.rel), ["a.css"], "without suffixes the pattern applies as before");
  } finally {
    fs.rmSync(path.join(project, "docs", "x.mdown"), { force: true });
    fs.rmSync(path.join(project, "docs", "y.MD"), { force: true });
  }
});
