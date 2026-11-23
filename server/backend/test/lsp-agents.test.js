// The language service of the AGENTS against a FAKE language server (test/fake-lsp.mjs) in the test process: lsp/agents.js via
// lsp/actions.js, documents.js and limit.js — without HTTP and without a project container (the route with a copy's token is run by
// fence-instance.test.js (4), the FIFO paths by language-service-fifo.test.js, the schema of the two MCP tools by mcp-schema.test.js).
//   (1) reading: every action of AGENT_READ in its shape — 1-based, kinds as words, paths absolute, call_hierarchy without `data`
//   (2) cap with notice (`truncated`), missing position 400, unknown and editor action 400 UNKNOWN_ACTION
//   (3) rename writes the disk all or nothing: no identifier 400, no symbol 400, a location outside 403 OUTSIDE (nothing written),
//       `beforeWrite` locks => `{ changed: [], locked }`
//   (4) code_action with `index` at the same position: resolve, command with a caught applyEdit, locked/outside => 400
//   (5) format: the server's formatter writes; without a formatter `{ supported: false, reason: "missing" }`
//   (6) an unsaved buffer of the editor: the agent computes and writes against the disk, the editor then gets TEXT_MISSING and
//       sends its buffer again
//   (7) a `disk` document the agent has since changed with its own tools — rename computes and writes against the disk; if the
//       disk differs at write time from the text computed against, 409 without a byte
//   (8) edit and caught applyEdit of the same code action on the same file apply one after the other — ONE change per file
//   (9) a location outside goes to an agent as `external: true`, without a token; the editor gets one
//   (10) the editor renames — before that B reconciles the session's `disk` documents with the disk, buffers stay
//   (11) an agent's suggestions do not replace the editor's latest list — it stays resolvable
// Counter-tests (ONE sabotage each, the whole file run): clipped without the cap => (2) red; pos without +1 => (1) red; writeEdit
// without returning the lock (`locked`) => (3) red; code_action without the disabled check => (4) red; plattenReconcile for buffers
// only again => (7) red (409 instead of written) and (10) red; writeEverythingOrNothing takes `text` unchecked as the old state again
// => (7) red (written instead of 409); unite merely concatenating again => (8) red; locationOf without the branch for agents => (9)
// red; agents.js without `{ agent: true }` => (11) red.
//
// Run (from server/backend/): CBASE_EMBED_OFFLINE=1 node --test test/lsp-agents.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { setLspTable } from "../electron/server/lsp/table.js";
import { endAllSessions, externalCount } from "../electron/server/lsp/sessions.js";
import { writeEverythingOrNothing } from "../electron/server/lsp/limit.js";
import { applyEdits } from "../electron/server/lsp/text.js";
import { lspEditorResponse } from "../electron/server/lsp/routes.js";
import { AGENT_CAP, agentAction } from "../electron/server/lsp/agents.js";
import { AGENT_CHANGE, AGENT_READ } from "../electron/server/lsp/contract.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fake-lsp.mjs");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-lsp-agents-")));
const project = path.join(root, "proj");
const outside = path.join(root, "outside");
const SCENARIO = path.join(root, "scenario.json");
const LOG = path.join(root, "lsp.jsonl");
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
process.env.FAKE_LSP_LOG = LOG;
const scenario = (o = {}) => fs.writeFileSync(SCENARIO, JSON.stringify(o));
scenario();
setLspTable({ ts: { command: [process.execPath, FAKE, "--scenario", SCENARIO] }, python: { command: [process.execPath, FAKE, "--scenario", SCENARIO, "--language", "python"] } });

const TARGET = { projectId: "p1", instance: null, root: project, base: project };
const agent = (action, abs, body = {}, extra = {}) => agentAction(action, { ...TARGET, base: null, abs, ...extra }, body);
const ed = (action, body = {}) => lspEditorResponse(action, body, (f) => (f ? { ...TARGET, abs: path.join(project, f) } : { ...TARGET }));
const file = (name, text) => { const p = path.join(project, name); fs.writeFileSync(p, text); return p; };
const read = (p) => fs.readFileSync(p, "utf8");
const logValue = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((z) => JSON.parse(z)) : []);
// The text the server last got for `filePath` BEFORE the last request `method` (didOpen/didChange).
function textBefore(method, filePath) {
  const log = logValue();
  const until = log.findLastIndex((x) => x.m === method);
  const uri = pathToFileURL(filePath).href;
  const z = log.slice(0, until).filter((x) => (x.m === "textDocument/didOpen" || x.m === "textDocument/didChange") && x.p?.textDocument?.uri === uri).at(-1);
  return z ? (z.m === "textDocument/didOpen" ? z.p.textDocument.text : z.p.contentChanges.at(-1).text) : null;
}

test.after(() => {
  endAllSessions("test");
  setLspTable(null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("(1) reading: every action in its shape — lines and columns 1-based, kinds as words, paths absolute", async () => {
  const pa = file("read.ts", "const old = 1;\nconst y = old + FAILED;\n");
  const dg = await agent("diagnostics", pa);
  assert.deepEqual(dg, { diagnostics: [{ range: { start: { line: 2, column: 17 }, end: { line: 2, column: 23 } }, severity: "error", message: "FAILED found", source: "fake", code: "F1" }] });
  const def = await agent("definition", pa, { line: 2, column: 12 });
  assert.deepEqual(def, { locations: [{ file: pa, range: { start: { line: 1, column: 7 }, end: { line: 1, column: 10 } } }] });
  const refs = await agent("references", pa, { line: 1, column: 8 });
  assert.deepEqual(refs.locations.map((l) => [l.file, l.range.start.line, l.range.start.column]), [[pa, 1, 7], [pa, 2, 11]]);
  assert.equal(refs.truncated, undefined);
  assert.deepEqual(await agent("hover", pa, { line: 2, column: 12 }), { contents: "**old**", range: { start: { line: 2, column: 11 }, end: { line: 2, column: 14 } } });
  assert.deepEqual(await agent("hover", pa, { line: 1, column: 11 }), { contents: null }, "on the equals sign: nothing");
  const ol = await agent("outline", pa);
  assert.deepEqual(ol.symbols.map((x) => [x.name, x.kind, x.children?.map((c) => [c.name, c.kind])]), [["Klasse", "class", [["method", "method"]]]]);
  assert.deepEqual(ol.symbols[0].range, { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } });
  const co = await agent("completions", pa, { line: 2, column: 12 });
  assert.deepEqual(co, { items: [{ label: "word1", kind: "variable", detail: "a variable" }, { label: "snip", kind: "snippet" }, { label: "late", kind: "function", detail: "(a)" }], incomplete: false }, "without docs, without insertText, without an id to resolve");
  const one = await agent("call_hierarchy", pa, { line: 1, column: 8 });
  assert.equal(one.direction, "incoming");
  assert.deepEqual([one.root.name, one.root.kind, one.root.file], ["old", "function", pa]);
  assert.equal(one.root.data, undefined, "no opaque data to an agent");
  assert.deepEqual(one.calls.map((c) => [c.item.name, c.ranges.length]), [["caller", 1]]);
  const out = await agent("call_hierarchy", pa, { line: 1, column: 8, direction: "outgoing" });
  assert.deepEqual([out.direction, out.calls[0].item.name], ["outgoing", "called"]);
  const ws = await agent("workspace_symbols", pa, { query: "Q" });
  assert.deepEqual(ws.symbols.map((x) => [x.name, x.kind, x.container, x.location.file]), [["QSymbol", "function", "module", ws.symbols[0].location.file]]);
  assert.ok(path.isAbsolute(ws.symbols[0].location.file));
  const ca = await agent("code_actions", pa, { line: 2, column: 17, endLine: 2, endColumn: 23 });
  assert.deepEqual(ca.actions, [
    { index: 1, title: "Repair", kind: "quickfix", preferred: true },
    { index: 2, title: "With command", kind: "source.organizeImports" },
    { index: 3, title: "Bare command" },
    { index: 4, title: "Locked", kind: "refactor", disabled: "not possible here" },
  ]);
  // The diagnostics at the position go along (the server gets them in the context).
  const request = fs.readFileSync(LOG, "utf8").trim().split("\n").map((z) => JSON.parse(z)).filter((x) => x.m === "textDocument/codeAction").at(-1);
  assert.deepEqual(request.p.context.diagnostics.map((d) => d.message), ["FAILED found"]);
  // Every action of the list is covered (a new one in AGENT_READ without a line here would stand out).
  assert.deepEqual([...AGENT_READ].sort(), ["call_hierarchy", "code_actions", "completions", "definition", "diagnostics", "hover", "implementations", "outline", "references", "type_definition", "workspace_symbols"]);
  for (const a of ["type_definition", "implementations"]) assert.ok(Array.isArray((await agent(a, pa, { line: 2, column: 12 })).locations), a);
});

test("(2) cap with notice, missing position 400, unknown and editor action 400 UNKNOWN_ACTION", async () => {
  const n = AGENT_CAP.locations + 3;
  const pd = file("cap.ts", "old;\n".repeat(n));
  const r = await agent("references", pd, { line: 1, column: 1 });
  assert.equal(r.locations.length, AGENT_CAP.locations);
  assert.equal(r.truncated, true, "a capped list says so");
  await assert.rejects(agent("definition", pd, {}), (e) => e.status === 400 && /line und column/.test(e.body.error));
  await assert.rejects(agent("definition", pd, { line: 0, column: 1 }), (e) => e.status === 400, "0 is not a 1-based line");
  for (const a of ["prepare_rename", "code_action_apply", "highlights", "nonsense"]) {
    await assert.rejects(agent(a, pd, { line: 1, column: 1 }), (e) => e.status === 400 && e.body.code === "UNKNOWN_ACTION", a);
  }
  assert.deepEqual([...AGENT_CHANGE], ["rename", "format", "code_action"]);
});

test("(3) rename writes the disk all or nothing — identifier, symbol, OUTSIDE, lock", async () => {
  const pa = file("rename.ts", "const old = 1;\nconst y = old + 1;\n");
  assert.deepEqual(await agent("rename", pa, { line: 2, column: 12, newName: "fresh" }), { changed: [pa] });
  assert.equal(read(pa), "const fresh = 1;\nconst y = fresh + 1;\n");
  // The server then knows the new state: a second rename computes on it.
  assert.deepEqual(await agent("rename", pa, { line: 1, column: 8, newName: "third" }), { changed: [pa] });
  assert.equal(read(pa), "const third = 1;\nconst y = third + 1;\n");
  await assert.rejects(agent("rename", pa, { line: 1, column: 8, newName: "a-b" }), (e) => e.status === 400 && /kein Bezeichner/.test(e.body.error));
  await assert.rejects(agent("rename", pa, { line: 1, column: 8 }), (e) => e.status === 400 && /newName/.test(e.body.error));
  await assert.rejects(agent("rename", pa, { line: 1, column: 14, newName: "x" }), (e) => e.status === 400 && /Kein umbenennbares Symbol/.test(e.body.error));
  const prior = read(pa);
  scenario({ renameAlongside: [{ path: path.join(outside, "lib.d.ts") }] });
  try {
    await assert.rejects(agent("rename", pa, { line: 1, column: 8, newName: "x2" }), (e) => e.status === 403 && e.body.code === "OUTSIDE");
  } finally { scenario(); }
  assert.equal(read(pa), prior, "nothing written");
  let asked = null;
  const locked = await agent("rename", pa, { line: 1, column: 8, newName: "x3" }, { beforeWrite: (d) => { asked = d; return { code: "COPY_NOT_READY", identifier: "p1/copy-k1", state: "clearAway" }; } });
  assert.deepEqual(locked, { changed: [], locked: { code: "COPY_NOT_READY", identifier: "p1/copy-k1", state: "clearAway" } });
  assert.deepEqual(asked, [pa]);
  assert.equal(read(pa), prior, "locked: nothing written");
});

test("(4) code_action: index at the same position — resolve and command write, locked or outside the list 400", async () => {
  const text = "const z = FAILED;\n";
  const pc = file("action.ts", text);
  const place = { line: 1, column: 11, endLine: 1, endColumn: 17 };
  assert.deepEqual(await agent("code_action", pc, { ...place, index: 1 }), { changed: [pc], title: "Repair" });
  assert.equal(read(pc), `// repaired\n${text}`);
  assert.deepEqual(await agent("code_action", pc, { ...place, line: 2, endLine: 2, index: 2 }), { changed: [pc], title: "With command" });
  assert.equal(read(pc), `// command\n// repaired\n${text}`, "the command's caught applyEdit went to disk");
  const prior = read(pc);
  await assert.rejects(agent("code_action", pc, { ...place, index: 4 }), (e) => e.status === 400 && /not possible here/.test(e.body.error));
  await assert.rejects(agent("code_action", pc, { ...place, index: 9 }), (e) => e.status === 400 && /4 Code-Aktion/.test(e.body.error));
  await assert.rejects(agent("code_action", pc, { ...place, index: 0 }), (e) => e.status === 400 && /index fehlt/.test(e.body.error));
  assert.equal(read(pc), prior);
});

test("(5) format: the server's formatter writes; without it { supported: false, reason: missing }", async () => {
  const pf = file("fmt.ts", "const a=1\n");
  assert.deepEqual(await agent("format", pf), { changed: [pf], formatter: "server" });
  assert.equal(read(pf), "// formatiert\nconst a=1\n");
  endAllSessions("test");
  scenario({ without: ["documentFormattingProvider"] });
  try {
    const prior = read(pf);
    assert.deepEqual(await agent("format", pf), { supported: false, reason: "missing" });
    assert.equal(read(pf), prior);
  } finally { scenario(); endAllSessions("test"); }
});

test("(6) an unsaved buffer of the editor: the agent writes against the disk, the editor then gets TEXT_MISSING", async () => {
  const pa = file("main.ts", "const old = 1;\n");
  const pb = file("buffer.ts", "const b = 1;\n");
  // The editor holds buffer.ts with unsaved text.
  const r1 = await ed("diagnostics", { file: "buffer.ts", buffer: "e1", version: 3, text: "const b = 2; // UNSAVED\n" });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  // The rename also touches buffer.ts (inserted at the start) — what is written is based on the DISK state.
  scenario({ renameAlongside: [{ path: pb, newText: "// " }] });
  try {
    assert.deepEqual(await agent("rename", pa, { line: 1, column: 8, newName: "fresh" }), { changed: [pa, pb] });
  } finally { scenario(); }
  assert.equal(read(pa), "const fresh = 1;\n");
  assert.equal(read(pb), "// const b = 1;\n", "not the buffer's text");
  // The editor asks with the same buffer and state without text: the server now knows the disk => TEXT_MISSING, the editor resends.
  const r2 = await ed("hover", { file: "buffer.ts", buffer: "e1", version: 3, position: { line: 0, character: 7 } });
  assert.equal(r2.status, 409, JSON.stringify(r2.body));
  assert.equal(r2.body.code, "TEXT_MISSING");
  const r3 = await ed("hover", { file: "buffer.ts", buffer: "e1", version: 3, text: "const b = 2; // UNSAVED\n", position: { line: 0, character: 7 } });
  assert.equal(r3.status, 200);
});

test("(7) a disk document the agent has since changed itself — rename computes and writes against the disk; if it differs at write time, 409 without a byte", async () => {
  const pa = file("stale-a.ts", "const value = 1;\n");
  const pb = file("stale-b.ts", "const b = 1;\n");
  // The agent asks about a — a then sits in the session as a `disk` document (lease BUFFER_LEASE_MS) …
  await agent("diagnostics", pa);
  // … and changes a with its own edit tool, bypassing B.
  fs.writeFileSync(pa, "// new\nconst item = 1;\n");
  // A rename in b also hits a (line 2 of a, `item`).
  scenario({ renameAlongside: [{ path: pa, range: { start: { line: 1, character: 6 }, end: { line: 1, character: 10 } }, newText: "count" }] });
  try {
    assert.deepEqual(await agent("rename", pb, { line: 1, column: 7, newName: "c" }), { changed: [pb, pa] });
  } finally { scenario(); }
  assert.equal(read(pa), "// new\nconst count = 1;\n", "the agent's change stayed, the edit was added");
  assert.equal(read(pb), "const c = 1;\n");
  assert.equal(textBefore("textDocument/rename", pa), "// new\nconst item = 1;\n", "the server computed against the old text of a");
  // If the disk still changes between computing and writing: 409, nothing written (as in the copy).
  const pc = file("stale-c.ts", "new\n");
  const edits = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "x" }];
  assert.throws(() => writeEverythingOrNothing({}, [{ lex: pc, edits, text: "old\n" }]), (e) => e.status === 409 && /geändert/.test(e.body.error));
  assert.equal(read(pc), "new\n", "nothing written");
  // Without `text` (a file the session does not know) the disk applies.
  assert.deepEqual(writeEverythingOrNothing({}, [{ lex: pc, edits }]).changed, [pc]);
  assert.equal(read(pc), "xnew\n");
});

test("(8) edit and caught applyEdit on the same file apply ONE AFTER THE OTHER — one change per file", async () => {
  const pc = file("both.ts", "x;\n");
  scenario({ codeActionBeides: true });
  try {
    const ca = await agent("code_actions", pc, { line: 1, column: 1 });
    assert.equal(ca.actions[4]?.title, "Beides", JSON.stringify(ca.actions));
    assert.deepEqual(await agent("code_action", pc, { line: 1, column: 1, index: 5 }), { changed: [pc], title: "Beides" });
    assert.equal(read(pc), "// eins\n// zwei\nx;\n", "the command's applyEdit computes on the state after the edit");
    // The editor gets the same computation as ONE change against its buffer.
    const nul = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    const r1 = await ed("code_actions", { file: "both.ts", buffer: "e8", version: 1, text: "y;\n", range: nul });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    const id = r1.body.actions.find((a) => a.title === "Beides")?.id;
    const r2 = await ed("code_action_apply", { file: "both.ts", id });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.deepEqual(r2.body.edit.changes.map((c) => [c.file, c.edits.length]), [["both.ts", 1]], "one change per file");
    assert.equal(applyEdits("y;\n", r2.body.edit.changes[0].edits), "// eins\n// zwei\ny;\n");
  } finally { scenario(); }
});

test("(9) a location outside goes to an agent as external: true — without a token; the editor gets one", async () => {
  const lib = path.join(outside, "lib9.d.ts");
  fs.writeFileSync(lib, "declare const x: number;\n");
  const pe = file("extern9.ts", "x;\n");
  scenario({ definition: [{ path: lib }] });
  try {
    const prior = externalCount();
    const r = await agent("definition", pe, { line: 1, column: 1 });
    assert.deepEqual(r.locations.map((l) => [l.file, l.external]), [[lib, true]]);
    assert.equal(externalCount(), prior, "an agent created a token");
    const e = await ed("definition", { file: "extern9.ts", buffer: "e9", version: 1, text: "x;\n", position: { line: 0, character: 0 } });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    assert.equal(typeof e.body.locations[0]?.external?.token, "string", "the editor reads only with a token");
    assert.equal(externalCount(), prior + 1);
  } finally { scenario(); }
});

test("(10) the editor renames — before that B reconciles the session's disk documents with the disk, buffers stay", async () => {
  const pa = file("ed-a.ts", "const value = 1;\n");
  const pc = file("ed-c.ts", "const c = 1;\n");
  file("ed-b.ts", "const b = 1;\n");
  await agent("diagnostics", pa); // a as a disk document
  const buffer = await ed("sync", { file: "ed-c.ts", buffer: "e10c", version: 4, text: "const c = 2; // UNSAVED\n" });
  assert.equal(buffer.status, 200, JSON.stringify(buffer.body));
  fs.writeFileSync(pa, "// new\nconst item = 1;\n"); // changed by the agent
  const r = await ed("rename", { file: "ed-b.ts", buffer: "e10b", version: 1, text: "const b = 1;\n", position: { line: 0, character: 6 }, newName: "c" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(textBefore("textDocument/rename", pa), "// new\nconst item = 1;\n", "the server computed against the old text of a");
  assert.equal(textBefore("textDocument/rename", pc), "const c = 2; // UNSAVED\n", "an editor's buffer stayed");
  assert.equal(read(pa), "// new\nconst item = 1;\n", "the editor writes nothing");
});

test("(11) an agent's suggestions do not replace the editor's latest list — it stays resolvable", async () => {
  const pa = file("suggestion.ts", "const old = 1;\nconst y = old;\n");
  const doc = (o = {}) => ({ file: "suggestion.ts", buffer: "v11", version: 1, text: read(pa), ...o });
  const list = await ed("completions", doc({ position: { line: 1, character: 12 } }));
  const late = list.body.items.find((it) => it.label === "late");
  assert.ok(late?.resolve, JSON.stringify(list.body));
  const co = await agent("completions", pa, { line: 2, column: 12 });
  assert.equal(co.items.length, 3);
  const r = await ed("completion_resolve", doc({ resolve: late.resolve }));
  assert.deepEqual(r.body, { resolved: true, detail: "resolved late", documentation: "**late**" }, "the editor's list still applies");
});
