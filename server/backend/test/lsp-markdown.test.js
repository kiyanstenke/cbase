// CSS and Markdown language service: the client side of the Markdown server in B (lsp/markdown.js) and its wiring
// (lsp/sessions.js setClientPage, lsp/actions.js).
//   (1) Parsing as VS Code: markdown-it with a front-matter rule (`front_matter` is ONE token), headings with map/markup, linkify
//       without fuzzyLink, only the fields the language service reads
//   (2) the server's requests: exactly the "From server" methods of the protocol; parse takes `text`, else the open document, else
//       the disk; files only inside (outside: read throws; stat knows existence and kind, lsp-vv.test.js); the search skips
//       node_modules and dot folders
//   (3) freshness: a file read changes / is gone => `workspace/didChangeWatchedFiles`; watcher => onChange create/change/delete
//       (ignored kinds not)
//   (4) over a real session (fake server): the server asks `markdown/parse` and gets the tokens of the BUFFER; completions registered
//       dynamically => capability and trigger characters in the status
//   (5) Go to definition on a link: like VS Code NOTHING when the server knows no definition (no fallback to the link — cmd-click
//       follows it via `link`, test/lsp-vu.test.js)
//   (6) CSS: table and suffixes (css/scss/less one server), settings per languageId
// Counter-tests (one sabotage each, the whole file run): preludeRule not hooked in => (1) red; `md.linkify.set({ fuzzyLink: false })`
// removed => (1) red; textToParse without the open document => (2) and (4) red; locationOf without `inside` (pathOfUri alone) => (2)
// red; findMarkdown without the node_modules exclusion => (2) red; markdownFreshness without the didChangeWatchedFiles notice =>
// (3) red; without the ignored kinds => (3) red; `clientPages.get(s.language)?.(s, v)` removed => (4) red; triggerOf without
// registerOptions => (4) red; the old fallback `linkTarget` back in locationsRequest => (5) red.
//
// Run (from server/backend/): CBASE_EMBED_OFFLINE=1 node --test test/lsp-markdown.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { REQUESTS, findMarkdown, markdownFreshness, textToParse, tokensOf } from "../electron/server/lsp/markdown.js";
import { endAllSessions, setStatusReporter } from "../electron/server/lsp/sessions.js";
import { lspEditorResponse } from "../electron/server/lsp/routes.js";
import { SUFFIXES, LANGUAGES } from "../electron/server/lsp/contract.js";
import { MARKDOWN_SUFFIXES, entryFor, setLspTable } from "../electron/server/lsp/table.js";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-lsp-md-")));
const project = path.join(root, "proj");
const outside = path.join(root, "outside");
for (const d of [project, outside, path.join(project, "docs"), path.join(project, "node_modules", "x"), path.join(project, ".git")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(project, "README.md"), "# Disk\n");
fs.writeFileSync(path.join(project, "docs", "b.md"), "# B\n\n## Start\n");
fs.writeFileSync(path.join(project, "docs", "c.markdown"), "x\n");
fs.writeFileSync(path.join(project, "docs", "d.txt"), "x\n");
fs.writeFileSync(path.join(project, "node_modules", "x", "README.md"), "x\n");
fs.writeFileSync(path.join(project, ".git", "note.md"), "x\n");
fs.writeFileSync(path.join(outside, "secret.md"), "secret\n");
const uri = (p) => pathToFileURL(p).href;

// A session as lsp/markdown.js sees it (lsp/limit.js `inside` reads root/rootReal).
const session = (extra = {}) => {
  const sent = [];
  return {
    root: project, rootReal: project, instance: null, area: null, documents: new Map(), sent,
    v: { note: (m, p) => sent.push({ note: m, p }), request: (m, p) => { sent.push({ request: m, p }); return Promise.resolve(null); } },
    ...extra,
  };
};

test.after(() => {
  endAllSessions("test");
  setLspTable(null);
  setStatusReporter(null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("(1) parsing as VS Code: front matter one token, headings with map/markup, linkify without fuzzyLink, lean fields", () => {
  const t = tokensOf("---\ntitle: x\n---\n# One\n\nTwo\n---\n\nhttps://example.com and example.com\n\n```js\nx\n```\n");
  assert.equal(t[0].type, "front_matter", "the front matter is ONE token (yamlPreamble.ts)");
  assert.deepEqual(t[0].map, [0, 3]);
  assert.equal(t[0].markup, "---");
  const h = t.filter((x) => x.type === "heading_open");
  assert.deepEqual(h.map((x) => [x.markup, x.map]), [["#", [3, 4]], ["-", [5, 7]]]);
  assert.equal(t[t.indexOf(h[0]) + 1].children.map((c) => c.content).join(""), "One");
  const paragraph = t.filter((x) => x.type === "inline").map((x) => (x.children || []).map((c) => c.type).join(","));
  assert.ok(paragraph.some((z) => z.includes("link_open")), "https://… is linked (linkify)");
  const links = t.flatMap((x) => x.children || []).filter((c) => c.type === "link_open").length;
  assert.equal(links, 1, "example.com without a scheme stays text (fuzzyLink off)");
  const f = t.find((x) => x.type === "fence");
  assert.deepEqual([f.info, f.map], ["js", [10, 13]]);
  for (const x of t) for (const k of Object.keys(x)) assert.ok(["type", "map", "markup", "content", "info", "children"].includes(k), `field ${k}`);
  // Without front matter at the start: `---` is a rule, not a front_matter token.
  assert.ok(!tokensOf("Text\n---\nx\n---\n").some((x) => x.type === "front_matter"));
});

test("(2) the server's requests: methods, parse from text/document/disk, files only inside, search without node_modules and dot folders", async () => {
  // The "From server" methods of vscode-markdown-languageserver (protocol.ts, VS Code 1.143.1).
  assert.deepEqual(Object.keys(REQUESTS).sort(), [
    "markdown/findMarkdownFilesInWorkspace", "markdown/fs/readDirectory", "markdown/fs/readFile", "markdown/fs/stat",
    "markdown/fs/watcher/create", "markdown/fs/watcher/delete", "markdown/parse",
  ]);
  const s = session();
  const readme = path.join(project, "README.md");
  assert.equal(await textToParse(s, { uri: uri(readme), text: "# Text" }), "# Text");
  assert.equal(await textToParse(s, { uri: uri(readme) }), "# Disk\n");
  s.documents.set(uri(readme), { text: "# Buffer\n" });
  assert.equal(await textToParse(s, { uri: uri(readme) }), "# Buffer\n", "the open document takes precedence over the disk");
  const tok = await REQUESTS["markdown/parse"](s, { uri: uri(readme) });
  assert.equal(tok[1].children[0].content, "Buffer");
  assert.equal(await textToParse(s, { uri: uri(path.join(outside, "secret.md")) }), null, "B reads nothing outside");
  assert.deepEqual(await REQUESTS["markdown/parse"](s, { uri: uri(path.join(outside, "secret.md")) }), []);

  assert.deepEqual(Buffer.from(await REQUESTS["markdown/fs/readFile"](s, { uri: uri(path.join(project, "docs", "b.md")) })).toString(), "# B\n\n## Start\n");
  await assert.rejects(REQUESTS["markdown/fs/readFile"](s, { uri: uri(path.join(outside, "secret.md")) }));
  await assert.rejects(REQUESTS["markdown/fs/readFile"](s, { uri: uri(path.join(project, "..", "outside", "secret.md")) }));
  assert.deepEqual(await REQUESTS["markdown/fs/stat"](s, { uri: uri(path.join(project, "docs")) }), { isDirectory: true });
  assert.deepEqual(await REQUESTS["markdown/fs/stat"](s, { uri: uri(path.join(project, "docs", "b.md")) }), { isDirectory: false });
  assert.equal(await REQUESTS["markdown/fs/stat"](s, { uri: uri(path.join(project, "missing.md")) }), null);
  // Outside, stat knows existence and kind as VS Code (a link there is not missing) — nothing else is read there (lsp-vv.test.js (3)).
  assert.deepEqual(await REQUESTS["markdown/fs/stat"](s, { uri: uri(path.join(outside, "secret.md")) }), { isDirectory: false }, "outside: existence, no content");
  const folder = await REQUESTS["markdown/fs/readDirectory"](s, { uri: uri(path.join(project, "docs")) });
  assert.deepEqual(folder.sort(), [["b.md", { isDirectory: false }], ["c.markdown", { isDirectory: false }], ["d.txt", { isDirectory: false }]]);
  await assert.rejects(REQUESTS["markdown/fs/readDirectory"](s, { uri: uri(outside) }));
  const all = (await REQUESTS["markdown/findMarkdownFilesInWorkspace"](s, {})).sort();
  assert.deepEqual(all, [uri(readme), uri(path.join(project, "docs", "b.md")), uri(path.join(project, "docs", "c.markdown"))].sort());
  assert.deepEqual(findMarkdown(project, ["txt"]), [path.join(project, "docs", "d.txt")]);
  assert.ok(MARKDOWN_SUFFIXES.includes("md") && MARKDOWN_SUFFIXES.includes("markdown") && MARKDOWN_SUFFIXES.length === 13);
});

test("(3) freshness: changed/removed files and watchers report before the next action", async () => {
  const s = session();
  const b = path.join(project, "docs", "b.md");
  await REQUESTS["markdown/fs/readFile"](s, { uri: uri(b) });
  assert.equal(markdownFreshness(s), 0, "nothing changed => no notice");
  const fresh = path.join(project, "fresh.md");
  REQUESTS["markdown/fs/watcher/create"](s, { id: 7, uri: uri(fresh), options: {} });
  REQUESTS["markdown/fs/watcher/create"](s, { id: 8, uri: uri(b), options: { ignoreChange: true } });
  REQUESTS["markdown/fs/watcher/create"](s, { id: 9, uri: uri(path.join(outside, "secret.md")), options: {} });
  assert.equal(s.mdObserver.size, 2, "outside is not watched");
  fs.writeFileSync(b, "# B\n\n## Start and more\n");
  fs.writeFileSync(fresh, "# New\n");
  markdownFreshness(s);
  assert.deepEqual(s.sent.filter((x) => x.note).map((x) => x.p.changes), [[{ uri: uri(b), type: 2 }]]);
  assert.deepEqual(s.sent.filter((x) => x.request).map((x) => [x.p.id, x.p.kind]), [[7, "create"]], "change on 8 is ignored");
  s.sent.length = 0;
  fs.rmSync(b);
  markdownFreshness(s);
  assert.deepEqual(s.sent.filter((x) => x.note).map((x) => x.p.changes), [[{ uri: uri(b), type: 3 }]]);
  assert.deepEqual(s.sent.filter((x) => x.request).map((x) => [x.p.id, x.p.kind]), [[8, "delete"]]);
  REQUESTS["markdown/fs/watcher/delete"](s, { id: 7 });
  assert.equal(s.mdObserver.size, 1);
  fs.writeFileSync(b, "# B\n\n## Start\n");
  // The freshness of a copy (one call in the container, not awaited) is checked by lsp-vv.test.js (2).
});

// A fake Markdown server: asks B for `markdown/parse` at documentSymbol, registers completions dynamically, has no definition, but
// links (with resolve).
const WRONG = path.join(root, "fake-md.mjs");
fs.writeFileSync(WRONG, `
let root = "", n = 1; const open = new Map(); let buffer = Buffer.alloc(0);
const write = (x) => { const t = JSON.stringify(x); process.stdout.write("Content-Length: " + Buffer.byteLength(t) + "\\r\\n\\r\\n" + t); };
const question = (method, params) => new Promise((r) => { const id = "s" + n++; open.set(id, r); write({ jsonrpc: "2.0", id, method, params }); });
const R = (a, b, c, d) => ({ start: { line: a, character: b }, end: { line: c, character: d } });
async function edit(m) {
  if (m.id !== undefined && !m.method) { open.get(m.id)?.(m.result); open.delete(m.id); return; }
  const response = (result) => write({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize": root = m.params.rootUri; return response({ capabilities: { documentSymbolProvider: true, definitionProvider: true, documentLinkProvider: { resolveProvider: true } } });
    case "initialized": await question("client/registerCapability", { registrations: [{ id: "c", method: "textDocument/completion", registerOptions: { documentSelector: null, triggerCharacters: [".", "/", "#"] } }] }); return;
    case "textDocument/documentSymbol": { const t = await question("markdown/parse", { uri: m.params.textDocument.uri }); return response([{ name: t.map((x) => x.type).join(" "), kind: 15, range: R(0, 0, 0, 1), selectionRange: R(0, 0, 0, 1) }]); }
    case "textDocument/definition": return response(null);
    case "textDocument/documentLink": return response([{ range: R(0, 0, 0, 10), data: 1 }, { range: R(1, 0, 1, 10), target: "https://example.com/" }, { range: R(2, 0, 2, 10), target: root + "/docs/b.md" }]);
    case "documentLink/resolve": return response({ ...m.params, target: root + "/docs/b.md#L3,2" });
    default: if (m.id !== undefined) response(null);
  }
}
process.stdin.on("data", (c) => {
  buffer = Buffer.concat([buffer, c]);
  for (;;) { const i = buffer.indexOf("\\r\\n\\r\\n"); if (i < 0) return; const l = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, i).toString())[1]);
    if (buffer.length < i + 4 + l) return; const m = JSON.parse(buffer.subarray(i + 4, i + 4 + l).toString()); buffer = buffer.subarray(i + 4 + l); edit(m); }
});
`);
const TARGET = { projectId: "pmd", instance: null, root: project, base: project };
const ed = (action, body = {}) => lspEditorResponse(action, body, (f) => (f ? { ...TARGET, abs: path.join(project, f) } : { ...TARGET }));

test("(4) real session: B answers markdown/parse with the tokens of the buffer; completions registered dynamically => status", async () => {
  setStatusReporter(() => {});
  setLspTable({ markdown: { command: [process.execPath, WRONG] } });
  const r = await ed("outline", { file: "README.md", buffer: "p1", version: 1, text: "---\na: 1\n---\n# From the buffer\n" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.symbols[0].name, "front_matter heading_open inline heading_close", "the tokens came from the BUFFER, not from the disk");
  const st = await ed("status", { file: "README.md" });
  const md = st.body.languages[0];
  assert.equal(md.language, "markdown");
  assert.ok(md.features.includes("completion"), "dynamically registered completions are a capability");
  assert.deepEqual(md.triggers.completion, [".", "/", "#"], "the trigger characters from the registerOptions");
});

test("(5) go to definition on a link: without a definition from the server nothing (VS Code: no fallback to the link)", async () => {
  const q = (line) => ({ file: "README.md", buffer: "p1", version: 1, position: { line, character: 3 } });
  for (const z of [0, 1, 2, 3]) assert.deepEqual((await ed("definition", q(z))).body.locations, [], `line ${z}`);
});

test("(6) CSS: one server for css/scss/less, settings per languageId; the languages of the contract each have an entry", () => {
  setLspTable(null);
  assert.ok(LANGUAGES.includes("css") && LANGUAGES.includes("markdown"));
  assert.deepEqual([SUFFIXES[".css"], SUFFIXES[".scss"], SUFFIXES[".less"]], [["css", "css"], ["css", "scss"], ["css", "less"]]);
  assert.deepEqual(SUFFIXES[".md"], ["markdown", "markdown"]);
  for (const sp of LANGUAGES) assert.ok(entryFor(sp), `${sp} without entry`);
  const css = entryFor("css");
  assert.equal(css.pack, "vscode-langservers-extracted");
  for (const id of ["css", "scss", "less"]) {
    const set = css.response(id, {});
    assert.equal(set.validate, true, id);
    assert.equal(set.lint.unknownProperties, "warning", id);
    assert.equal(set.hover.documentation, true, id);
  }
  assert.equal(css.init({}).provideFormatter, true);
  const md = entryFor("markdown");
  assert.deepEqual(md.init({}).markdownFileExtensions, MARKDOWN_SUFFIXES);
  assert.equal(md.response("markdown.validate.enabled", {}), false, "link validation off as in VS Code");
  assert.equal(md.response("markdown.suggest.paths.enabled", {}), true);
  assert.equal(md.response("markdown.occurrencesHighlight.enabled", {}), false);
});
