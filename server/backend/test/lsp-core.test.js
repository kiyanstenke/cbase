// The core of the language service against a FAKE language server (test/fake-lsp.mjs) in the test process: lsp/sessions.js,
// documents.js, limit.js, actions.js, routes.js — without HTTP and without a project container (the paths with instance, fence,
// FIFO and stopped instance are run by language-service-fifo.test.js with the server as a child process).
//   (1) status starts nothing                      (8) call hierarchy: `data` signed, tampered => 409
//   (2) reconcile: didOpen/didChange, TEXT_MISSING  (9) crash => error with stderr, event, no restart carousel; restart
//   (3) the reading actions and their shapes        (10) memory gate closed => memory, no process
//   (4) external targets only with a token          (11) lock: no start (starting); end at the lock (endSessions)
//       (NOT_NAMED)                                 (12) missing, no_language, no_project
//   (5) rename: edit relative; a location outside   (13) diagnostics per pull
//       or creating a file => 403 OUTSIDE           (14) sync: only the reconcile (didOpen/didChange), TEXT_MISSING as everywhere
//   (6) code actions: resolve, command with caught  (15) limit: writing through the opened parent folder (EOUTSIDE)
//       applyEdit, expired => 409                   (16) the five packages are pinned in the Dockerfile, with their start scripts
//   (7) workspace_symbols from running sessions          (one of them per language)
//   (17) tokens of external targets — index per session and path, cap EXTERNAL_CAP, the one least recently named falls
//   (18) diagnostics belong to the state of the request — if a second window reconciles while waiting, its diagnostics do not arrive
//   (19) restart/stop at workspace level — `file` determines the project, without `language` the file's language applies
//   (20) insertions at the same position in the order of the array
//   (21) `codeActionProvider: true` without kinds => only quick_fix
//   (22) a message above MESSAGE_MAX is a protocol error — the process ends, B does not buffer
//   (23) `completion_resolve` only for the latest list (an older one => `resolved: false`), labelDetails and "deprecated" (tags),
//        a parameter's docs, `semantic_tokens` with the server's legend — without `semanticTokensProvider` no tokens
//   (24) additional edits and command of a suggestion in the list and after resolving (editor commands only), `deprecated: true` as
//        a field, `detail` without fallback, above the cap filtered by the typed word (the auto-import at position 1,201 arrives),
//        a list of ANOTHER file is not resolvable
//   (25) if the client leaves, the server gets `$/cancelRequest` and the client 409; ServerCancelled (-32802) => 409;
//        `workspace/semanticTokens/refresh` => event to the views
//   (26) broken tokens (not a group of five, negative) => no tokens, the legend stays
//   (27) the trigger characters come from the server's capabilities (status `triggers`), cleaned; the reason for the parameter
//        hints goes to the server as LSP context (trigger character, retrigger, manual)
//   (28) over HTTP: if the client leaves before the answer, `abortOf(res)` ends — the server gets `$/cancelRequest`;
//        devtools/code-route.js passes this signal to lspEditorResponse (read, with a built-in sabotage)
// Counter-tests (ONE sabotage each, the whole file run): checkEdit without the throw for outside => (5) red; documentReconcile without
// textMissing => (2) red; sessionFor without storageSituation => (10) red; situationBefore without startLock => (11) red; unpacking
// without the signature check => (8) red; externalTarget without the project comparison => (4) red; EDITOR.sync removed or `sync`
// removed from EDITOR_ACTIONS => (14) red (UNKNOWN_ACTION); rememberExternal without the cap => (17) red; diagnosticsOf on the
// shared document again (version not pinned) => (18) red; languageTheButtons without the file's language => (19) red; applyOps
// without the index in the comparison => (20) red; capabilitiesOf without the "no kinds" branch => (21) red; connection without
// MESSAGE_MAX => (22) red; completion_resolve without the list-number comparison => (23) red; completionOf without `tags` => (23)
// red; completionOf without `addition` => (24) red; commandOf without the SUGGESTION_COMMANDS comparison => (24) red; completions
// without the filter by the typed word => (24) red; completion_resolve without `list.uri !== d.uri` => (24) red; completionOf
// without `it.deprecated === true` => (24) red; the fallback to labelDetails.detail back in completionOf => (23) and (24) red;
// responseFromError without -32802 => (25) red; connection without the abort via `signal` => (25) red (504 after the deadline
// instead of 409); the refresh responder mute again => (25) red; semantic_tokens without `heil` => (26) red; triggerOf without
// the filter => (27) red; signature_help without `context` => (27) red; abortOf without `ac.abort()` => (28) red.
// The agents (cbase_lsp/_edit) are run by lsp-agents.test.js.
//
// Run (from server/backend/): CBASE_EMBED_OFFLINE=1 node --test test/lsp-core.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { setLspTable, PACKAGES, SERVER_PACKAGE, SERVER_SCRIPT } from "../electron/server/lsp/table.js";
import { LANGUAGES } from "../electron/server/lsp/contract.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { EXTERNAL_CAP, endAllSessions, endSessions, externalCount, externalTarget, capabilitiesOf, rememberExternal, setStartLock, setStatusReporter, sessionsCount } from "../electron/server/lsp/sessions.js";
import { abortOf, lspEditorResponse } from "../electron/server/lsp/routes.js";
import { writeEverythingOrNothing } from "../electron/server/lsp/limit.js";
import { applyEdits } from "../electron/server/lsp/text.js";
import { MESSAGE_MAX, Connection } from "../electron/server/lsp/connection.js";
import { setDescriptorSeam } from "../electron/server/runtime/real-path.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fake-lsp.mjs");
const DOCKERFILE = path.join(HERE, "..", "Dockerfile");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-lsp-core-")));
const project = path.join(root, "proj");
const outside2 = path.join(root, "outside");
const SCENARIO = path.join(root, "scenario.json");
const LOG = path.join(root, "lsp.jsonl");
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(outside2, { recursive: true });
process.env.FAKE_LSP_LOG = LOG;
const scenario = (o = {}) => fs.writeFileSync(SCENARIO, JSON.stringify(o));
scenario();
const table = () => setLspTable({
  ts: { command: [process.execPath, FAKE, "--scenario", SCENARIO] },
  python: { command: [process.execPath, FAKE, "--scenario", SCENARIO, "--language", "python"] },
});
table();
const events = [];
setStatusReporter((e) => events.push(e));

const log = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((z) => JSON.parse(z)) : []);
const count = (m) => log().filter((x) => x.m === m).length;
const TARGET = { projectId: "p1", instance: null, root: project, base: project };
let resolve = (file) => (file ? { ...TARGET, abs: path.join(project, file) } : { ...TARGET });
const ed = (action, body = {}) => lspEditorResponse(action, body, (f) => resolve(f));
const A = "const item = 1;\nconst y = item + FAILED;\n";
fs.writeFileSync(path.join(project, "a.ts"), A);

test.after(() => {
  endAllSessions("test");
  setLspTable(null);
  setStatusReporter(null);
  setStartLock(null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("(1) status starts nothing — every language is off, no process", async () => {
  const r = await ed("status");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.languages.map((l) => [l.language, l.state]), [["ts", "off"], ["python", "off"], ["yaml", "missing"], ["json", "missing"], ["css", "missing"], ["markdown", "missing"]]);
  assert.equal(sessionsCount(), 0);
  assert.equal(log().filter((x) => x.start).length, 0, "a server was started");
  const onlyTs = await ed("status", { file: "a.ts" });
  assert.deepEqual(onlyTs.body.languages.map((l) => l.language), ["ts"]);
});

test("(2) reconcile: didOpen once, same buffer and state without text applies; a new state without text => 409 TEXT_MISSING", async () => {
  const r1 = await ed("diagnostics", { file: "a.ts", buffer: "b1", version: 1, text: A });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.diagnostics.length, 1);
  assert.deepEqual(r1.body.diagnostics[0], { range: { start: { line: 1, character: 17 }, end: { line: 1, character: 23 } }, severity: 1, message: "FAILED found", source: "fake", code: "F1" });
  assert.equal(sessionsCount(), 1);
  assert.ok(events.some((e) => e.type === "lsp/status" && e.language === "ts" && e.state === "ready" && e.projectId === "p1" && e.instance === null));
  const r2 = await ed("hover", { file: "a.ts", buffer: "b1", version: 1, position: { line: 0, character: 7 } });
  assert.equal(r2.status, 200);
  assert.equal(count("textDocument/didOpen"), 1);
  assert.equal(count("textDocument/didChange"), 0, "same buffer and state => no byte to the server");
  const r3 = await ed("hover", { file: "a.ts", buffer: "b1", version: 2, position: { line: 0, character: 7 } });
  assert.equal(r3.status, 409);
  assert.equal(r3.body.code, "TEXT_MISSING");
  const B2 = `${A}const z = FAILED;\n`;
  const r4 = await ed("diagnostics", { file: "a.ts", buffer: "b1", version: 2, text: B2 });
  assert.equal(r4.body.diagnostics.length, 2, "the diagnostics belong to the new state");
  assert.equal(count("textDocument/didChange"), 1);
  const r5 = await ed("hover", { file: "a.ts", buffer: "b9", version: 1, text: B2, position: { line: 0, character: 7 } });
  assert.equal(r5.status, 200);
  assert.equal(count("textDocument/didChange"), 1, "another buffer with the same text changes nothing at the server");
  assert.equal((await ed("close", { file: "a.ts", buffer: "b9" })).status, 200);
  await ed("workspace_symbols", { query: "" }); // an answer AFTER the didClose (the server's stdin is ordered)
  assert.equal(count("textDocument/didClose"), 1);
});

const doc = (extra = {}) => ({ file: "a.ts", buffer: "b1", version: 7, text: A, ...extra });
test("(3) the reading actions in their shapes", async () => {
  const pos = { line: 1, character: 11 };
  const h = await ed("hover", doc({ position: pos }));
  assert.deepEqual(h.body, { contents: "**item**", range: { start: { line: 1, character: 10 }, end: { line: 1, character: 14 } } });
  const c = await ed("completions", doc({ position: pos, trigger: "." }));
  assert.equal(c.body.incomplete, false);
  const { resolve: identifier, ...snip } = c.body.items[1];
  assert.deepEqual(snip, { label: "snip", kind: 15, documentation: "*docs*", insertText: "snip($1)", snippet: true });
  assert.match(identifier, /^\d+:1$/, "the server can resolve => every entry carries its id");
  const s = await ed("signature_help", doc({ position: pos }));
  assert.deepEqual(s.body, { signatures: [{ label: "f(a, b)", parameters: [{ label: [2, 3] }, { label: [5, 6], documentation: "das *b*" }] }], active: 0, activeParameter: 1 });
  const d = await ed("definition", doc({ position: pos }));
  assert.deepEqual(d.body, { locations: [{ file: "a.ts", range: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } } }] });
  const t = await ed("type_definition", doc({ position: pos }));
  assert.equal(t.body.locations[0].file, "a.ts", "LocationLink becomes Location");
  const r = await ed("references", doc({ position: pos }));
  assert.equal(r.body.locations.length, 2);
  assert.equal((await ed("source_definition", doc({ position: pos }))).body.locations.length, 1);
  assert.equal((await ed("highlights", doc({ position: pos }))).body.ranges.length, 2);
  const o = await ed("outline", doc());
  assert.deepEqual(o.body.symbols.map((x) => [x.name, x.kind, (x.children || []).map((k) => k.name)]), [["Klasse", 5, ["method"]]]);
  scenario({ flat: true });
  const of = await ed("outline", doc());
  assert.deepEqual(of.body.symbols.map((x) => [x.name, (x.children || []).map((k) => k.name)]), [["Klasse", ["method"]]], "flat, nested via containerName");
  scenario();
  assert.deepEqual((await ed("prepare_rename", doc({ position: pos }))).body, { range: { start: { line: 1, character: 10 }, end: { line: 1, character: 14 } }, placeholder: "item" });
  assert.deepEqual((await ed("format", doc())).body, { edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "// formatiert\n" }], formatter: "server" });
  const st = await ed("status", { file: "a.ts" });
  assert.equal(st.body.languages[0].state, "ready");
  assert.ok(st.body.languages[0].features.includes("source_definition") && st.body.languages[0].features.includes("call_hierarchy"));
  assert.equal(st.body.languages[0].version, "fake-lsp 1.0.0");
  assert.equal((await ed("nonexistent", doc())).body.code, "UNKNOWN_ACTION");
  // Python: workspace/configuration gets the settings from lsp/table.js (basedpyright "standard", open files).
  fs.writeFileSync(path.join(project, "m.py"), "x = 1\n");
  assert.equal((await ed("diagnostics", { file: "m.py", buffer: "p1", version: 1, text: "x = 1\n" })).status, 200);
  const conf = log().find((x) => x.response === "workspace/configuration" && x.language === "python");
  assert.equal(conf.result[0].typeCheckingMode, "standard");
  assert.equal(conf.result[0].diagnosticMode, "openFilesOnly");
});

test("(4) a target outside comes with a token; it is read only with that token, for the same project", async () => {
  const foreign = path.join(outside2, "lib.d.ts");
  fs.writeFileSync(foreign, "declare const item: number;\n");
  scenario({ definition: [{ path: foreign }, { path: path.join(project, "a.ts") }] });
  const d = await ed("definition", doc({ position: { line: 1, character: 11 } }));
  scenario();
  assert.equal(d.body.locations.length, 2);
  const [outside, inside] = d.body.locations;
  assert.equal(outside.file, foreign);
  assert.match(outside.external.token, /^[0-9a-f]{32}$/);
  assert.deepEqual(inside, { file: "a.ts", range: inside.range });
  const r = await ed("read", { token: outside.external.token });
  assert.deepEqual(r.body, { path: foreign, text: "declare const item: number;\n", language: "ts" });
  const no = await ed("read", { token: "0".repeat(32) });
  assert.equal(no.status, 403);
  assert.equal(no.body.code, "NOT_NAMED");
  const otherProject = await lspEditorResponse("read", { token: outside.external.token }, () => ({ ...TARGET, projectId: "p2" }));
  assert.equal(otherProject.status, 403, "a token applies only to the project whose server named the target");
});

test("(5) rename: the edit goes to the client relative, B writes nothing; a location outside or a new file => 403 OUTSIDE", async () => {
  const B = "import { item } from './a';\n";
  fs.writeFileSync(path.join(project, "b.ts"), B);
  scenario({ renameAlongside: [{ path: path.join(project, "b.ts"), range: { start: { line: 0, character: 9 }, end: { line: 0, character: 13 } } }] });
  const r = await ed("rename", doc({ position: { line: 1, character: 11 }, newName: "fresh" }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.edit.changes.map((c) => [c.file, c.edits.length]), [["a.ts", 2], ["b.ts", 1]]);
  assert.equal(fs.readFileSync(path.join(project, "a.ts"), "utf8"), A, "B writes nothing for the editor");
  assert.equal(fs.readFileSync(path.join(project, "b.ts"), "utf8"), B);
  scenario({ renameAlongside: [{ path: path.join(outside2, "lib.d.ts") }] });
  const out = await ed("rename", doc({ position: { line: 1, character: 11 }, newName: "fresh" }));
  assert.equal(out.status, 403);
  assert.equal(out.body.code, "OUTSIDE");
  scenario({ createRename: true });
  const create = await ed("rename", doc({ position: { line: 1, character: 11 }, newName: "fresh" }));
  assert.equal(create.status, 403);
  assert.equal(create.body.code, "OUTSIDE");
  scenario();
});

test("(6) code actions: B holds the raw ones, resolves, catches a command's applyEdit; a used id => 409 STALE_ACTION", async () => {
  const r = await ed("code_actions", doc({ range: { start: { line: 1, character: 17 }, end: { line: 1, character: 23 } }, kinds: ["quickfix", "source", "refactor"] }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.actions.map((a) => [a.title, a.kind ?? null, a.preferred ?? false, a.disabled ?? null]),
    [["Repair", "quickfix", true, null], ["With command", "source.organizeImports", false, null], ["Bare command", null, false, null], ["Locked", "refactor", false, "not possible here"]]);
  const ca = log().filter((x) => x.m === "textDocument/codeAction").at(-1);
  assert.equal(ca.p.context.diagnostics.length, 1, "the diagnostic at the position goes along (else no quickfix)");
  const [rep, command, bare] = r.body.actions;
  const e1 = await ed("code_action_apply", { id: rep.id });
  assert.equal(e1.status, 200, JSON.stringify(e1.body));
  assert.deepEqual(e1.body.edit.changes, [{ file: "a.ts", edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "// repaired\n" }] }]);
  const e2 = await ed("code_action_apply", { id: command.id });
  assert.equal(e2.status, 200, JSON.stringify(e2.body));
  assert.equal(e2.body.edit.changes[0].edits[0].newText, "// command\n");
  assert.deepEqual(log().filter((x) => x.response === "workspace/applyEdit").at(-1).result, { applied: true });
  assert.equal((await ed("code_action_apply", { id: bare.id })).body.edit.changes[0].edits[0].newText, "// command\n");
  const again = await ed("code_action_apply", { id: rep.id });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "STALE_ACTION");
});

test("(7) workspace_symbols from the RUNNING sessions of the instance (starts none)", async () => {
  const r = await ed("workspace_symbols", { query: "search" });
  assert.equal(r.status, 200);
  assert.ok(r.body.symbols.some((s) => s.name === "searchSymbol" && s.container === "module" && s.location.file === "a.ts"), JSON.stringify(r.body));
  const other = await lspEditorResponse("workspace_symbols", { query: "x" }, () => ({ ...TARGET, projectId: "p-empty" }));
  assert.deepEqual(other.body, { symbols: [] });
});

test("(8) call hierarchy: `data` goes back unchanged; tampered => 409", async () => {
  const r = await ed("call_hierarchy", doc({ position: { line: 1, character: 11 }, direction: "incoming" }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.root.name, "item");
  assert.equal(r.body.root.file, "a.ts");
  assert.deepEqual(r.body.calls.map((c) => c.item.name), ["caller"]);
  const out = await ed("call_hierarchy", { file: "a.ts", direction: "outgoing", item: r.body.root });
  assert.deepEqual(out.body.calls.map((c) => c.item.name), ["called"]);
  const wrong = { ...r.body.root, data: `${Buffer.from(JSON.stringify({ uri: "file:///etc/passwd", name: "x" })).toString("base64url")}.${r.body.root.data.split(".")[1]}` };
  const no = await ed("call_hierarchy", { file: "a.ts", direction: "incoming", item: wrong });
  assert.equal(no.status, 409);
});

test("(9) crash => error with the end of stderr, event; no restart carousel; restart starts fresh", async () => {
  scenario({ crashAt: "textDocument/hover" });
  const r = await ed("hover", doc({ position: { line: 1, character: 11 } }));
  scenario();
  assert.equal(r.status, 502, JSON.stringify(r.body));
  const st = await ed("status", { file: "a.ts" });
  assert.equal(st.body.languages[0].state, "error");
  assert.match(st.body.languages[0].error, /crash at textDocument\/hover/);
  assert.ok(events.some((e) => e.state === "error" && /crash at/.test(e.error || "")));
  const equal = await ed("diagnostics", doc());
  assert.deepEqual([equal.status, equal.body.supported, equal.body.reason], [200, false, "error"], "no immediate restart");
  assert.deepEqual((await ed("restart", { language: "ts" })).body, { ok: true });
  assert.equal((await ed("diagnostics", doc())).status, 200);
  assert.deepEqual((await ed("stop", { language: "ts" })).body, { ok: true });
  assert.equal((await ed("status", { file: "a.ts" })).body.languages[0].state, "off");
});

test("(10) memory gate closed => memory, no server", async () => {
  endAllSessions("test");
  const rootDir = path.join(root, "storage");
  fs.mkdirSync(path.join(rootDir, "sys", "fs", "cgroup"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "sys", "fs", "cgroup", "memory.max"), "1000\n");
  fs.writeFileSync(path.join(rootDir, "sys", "fs", "cgroup", "memory.current"), "950\n");
  process.env.CBASE_STORAGE_ROOT = rootDir;
  try {
    const prior = log().filter((x) => x.start).length;
    const r = await ed("diagnostics", doc());
    assert.deepEqual([r.status, r.body.supported, r.body.reason, r.body.state], [200, false, "memory", "memory"]);
    assert.match(r.body.error, /Speicher/);
    assert.equal(sessionsCount(), 0);
    assert.equal(log().filter((x) => x.start).length, prior, "started despite the memory gate");
    assert.equal((await ed("status", { file: "a.ts" })).body.languages[0].state, "memory");
    assert.ok(events.some((e) => e.state === "memory"));
  } finally { delete process.env.CBASE_STORAGE_ROOT; }
});

test("(11) lock: no start while it stands; at the lock every server of the project ends", async () => {
  setStartLock((pid) => (pid === "p1" ? "relocation" : null));
  const r = await ed("diagnostics", doc());
  setStartLock(null);
  assert.deepEqual([r.body.supported, r.body.reason], [false, "starting"]);
  assert.equal(sessionsCount(), 0);
  assert.equal((await ed("diagnostics", doc())).status, 200);
  assert.equal((await ed("diagnostics", { file: "m.py", buffer: "p1", version: 1, text: "x = 1\n" })).status, 200);
  assert.equal(sessionsCount(), 2);
  assert.equal(endSessions("p1", null, "relocation"), 2);
  assert.equal(sessionsCount(), 0);
  assert.equal((await ed("status", { file: "a.ts" })).body.languages[0].state, "off");
});

test("(12) missing, no_language, no_project", async () => {
  setLspTable({});
  try {
    assert.equal((await ed("status", { file: "a.ts" })).body.languages[0].state, "missing");
    assert.deepEqual((await ed("diagnostics", doc())).body.reason, "missing");
  } finally { table(); }
  assert.deepEqual((await ed("diagnostics", { file: "x.txt", buffer: "t", version: 1, text: "" })).body, { supported: false, reason: "no_language" });
  const without = await lspEditorResponse("diagnostics", { file: "a.ts" }, () => ({ reason: "no_project", base: root }));
  assert.deepEqual(without.body, { supported: false, reason: "no_project" });
  assert.equal((await ed("restart", { language: "cobol" })).status, 400);
});

test("(13) diagnostics per pull where the server offers it", async () => {
  endAllSessions("test");
  scenario({ pull: true });
  try {
    const r = await ed("diagnostics", doc({ version: 99 }));
    assert.equal(r.body.diagnostics.length, 1);
    assert.ok(count("textDocument/diagnostic") >= 1);
  } finally { scenario(); endAllSessions("test"); }
});

test("(14) sync: only reconciles — didOpen the first time (starts the server), didChange on a new state, without text on a new state 409 TEXT_MISSING", async () => {
  fs.writeFileSync(path.join(project, "sync.ts"), "const s = 1;\n");
  // Barrier: a request of the same buffer and state (without text) — the server reads stdin serially, its answer comes after the
  // log of the notification before it.
  const barrier = async (version) => assert.equal((await ed("hover", { file: "sync.ts", buffer: "sp", version, position: { line: 0, character: 6 } })).status, 200);
  const prior = count("textDocument/didOpen");
  const r1 = await ed("sync", { file: "sync.ts", buffer: "sp", version: 1, text: "const s = 2;\n" });
  assert.deepEqual(r1, { status: 200, body: { ok: true } });
  await barrier(1);
  assert.equal(count("textDocument/didOpen"), prior + 1, "the buffer was opened");
  const open = log().filter((x) => x.m === "textDocument/didOpen").at(-1);
  assert.equal(open.p.textDocument.text, "const s = 2;\n", "the buffer's text, not the disk's");
  const changes = count("textDocument/didChange");
  assert.deepEqual(await ed("sync", { file: "sync.ts", buffer: "sp", version: 1 }), { status: 200, body: { ok: true } }, "same buffer and state: without text");
  await barrier(1);
  assert.equal(count("textDocument/didChange"), changes, "no didChange without a new state");
  const missing = await ed("sync", { file: "sync.ts", buffer: "sp", version: 2 });
  assert.equal(missing.status, 409);
  assert.equal(missing.body.code, "TEXT_MISSING");
  assert.equal((await ed("sync", { file: "sync.ts", buffer: "sp", version: 2, text: "const s = 3;\n" })).status, 200);
  await barrier(2);
  assert.equal(count("textDocument/didChange"), changes + 1);
  assert.equal(log().filter((x) => x.m === "textDocument/didChange").at(-1).p.contentChanges.at(-1).text, "const s = 3;\n");
  await ed("close", { file: "sync.ts", buffer: "sp" });
});

test("(15) limit: if the OPENED parent folder of a target lies outside, B writes nothing", () => {
  const sub = path.join(project, "sub");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "a.ts"), "old\n");
  fs.writeFileSync(path.join(sub, "b.ts"), "old\n");
  const edits = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "fresh" }];
  try {
    setDescriptorSeam((fd, q) => (path.resolve(q) === sub ? "/outside/sub" : fs.realpathSync(q)));
    assert.throws(() => writeEverythingOrNothing({ area: [project] }, [{ lex: path.join(sub, "a.ts"), edits }, { lex: path.join(sub, "b.ts"), edits }]),
      (e) => e.status === 409 && /EOUTSIDE/.test(e.body.error));
  } finally { setDescriptorSeam(null); }
  assert.equal(fs.readFileSync(path.join(sub, "a.ts"), "utf8"), "old\n");
  assert.equal(fs.readFileSync(path.join(sub, "b.ts"), "utf8"), "old\n");
});

test("(16) packages: every pack from lsp/table.js is pinned in the Dockerfile, every start script with `test -f`", () => {
  const text = fs.readFileSync(DOCKERFILE, "utf8").replace(/\\\n/g, " ");
  const row = text.split("\n").find((z) => /^RUN npm install -g typescript-language-server@/.test(z));
  assert.ok(row, "the language-server line is missing in the Dockerfile");
  for (const [pack, scripts] of Object.entries(PACKAGES)) {
    assert.match(row, new RegExp(`\\s${pack.replace(/[-]/g, "\\-")}@\\d+\\.\\d+\\.\\d+(\\s|$)`), `${pack} unpinned or missing`);
    for (const script of scripts) assert.ok(row.includes(`test -f /usr/local/lib/node_modules/${pack}/${script}`), `${pack}/${script} is not checked in the build`);
  }
  // Every language starts a script that is in PACKAGES (and thus checked in the build).
  for (const language of LANGUAGES) assert.ok(PACKAGES[SERVER_PACKAGE[language]]?.includes(SERVER_SCRIPT[language]), `${language}: start script not in PACKAGES`);
});

test("(17) tokens of external targets — the same location of the same session keeps its token, at most EXTERNAL_CAP at once", () => {
  endAllSessions("test");
  assert.equal(externalCount(), 0);
  const s = { key: "p9|-|ts", projectId: "p9", instance: null };
  const target = { projectId: "p9", instance: null };
  const first = rememberExternal(s, "/x/0");
  const second = rememberExternal(s, "/x/1");
  for (let i = 2; i < EXTERNAL_CAP; i++) rememberExternal(s, `/x/${i}`);
  assert.equal(externalCount(), EXTERNAL_CAP);
  assert.equal(rememberExternal(s, "/x/0"), first, "same location, same token (moves to the end)");
  const fresh = rememberExternal(s, "/x/fresh");
  assert.equal(externalCount(), EXTERNAL_CAP, "the cap holds");
  assert.ok(externalTarget(target, first), "the one just named stays");
  assert.ok(externalTarget(target, fresh));
  assert.equal(externalTarget(target, second), null, "the one least recently named fell");
  const again = rememberExternal(s, "/x/1");
  assert.notEqual(again, second, "named anew => new token");
  assert.equal(externalTarget(target, again)?.abs, "/x/1");
  endAllSessions("test");
  assert.equal(externalCount(), 0);
});

test("(18) diagnostics belong to the state of the request — if a second window reconciles while waiting, its diagnostics do not arrive", async () => {
  fs.writeFileSync(path.join(project, "two.ts"), "");
  scenario({ diagnosticBundle: 2 });
  try {
    // Window 1 opens the file with an ERROR — the server holds the message back until a second state is there.
    const s1 = await ed("sync", { file: "two.ts", buffer: "f1", version: 1, text: "const a = FAILED;\n" });
    assert.equal(s1.status, 200, JSON.stringify(s1.body));
    const p1 = ed("diagnostics", { file: "two.ts", buffer: "f1", version: 1 });
    await new Promise((r) => setImmediate(r)); // p1 is waiting now (no byte to the server: same buffer and state)
    // Window 2 reconciles the same path with other text; only now does the server report — both states, in order.
    const s2 = await ed("sync", { file: "two.ts", buffer: "f2", version: 1, text: "const a = 1;\n" });
    assert.equal(s2.status, 200, JSON.stringify(s2.body));
    const r1 = await p1;
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.deepEqual(r1.body.diagnostics.map((d) => d.message), ["FAILED found"], "the diagnostics of the other text");
  } finally { scenario(); }
  // The second window's state gets its own.
  const r2 = await ed("diagnostics", { file: "two.ts", buffer: "f2", version: 1 });
  assert.deepEqual(r2.body.diagnostics, []);
});

test("(19) restart/stop at workspace level — file determines the project, without language the file's language applies", async () => {
  // Like devtools/code-route.js lspTargetFor at workspace level: without a file no project, a file under the project folder => it.
  const ws = (action, body) => lspEditorResponse(action, body, (f) => {
    const abs = f ? path.join(root, f) : null;
    return abs && abs.startsWith(`${project}${path.sep}`) ? { ...TARGET, base: root, abs } : { reason: "no_project", base: root };
  });
  assert.deepEqual((await ws("restart", { language: "ts" })).body, { supported: false, reason: "no_project" }, "without a file no project");
  const prior = log().filter((x) => x.start && x.language === "ts").length;
  assert.deepEqual((await ws("restart", { file: "proj/a.ts" })).body, { ok: true });
  assert.equal(log().filter((x) => x.start && x.language === "ts").length, prior + 1, "the project's TypeScript server restarted");
  assert.equal((await ws("status", { file: "proj/a.ts" })).body.languages[0].state, "ready");
  assert.deepEqual((await ws("stop", { file: "proj/a.ts" })).body, { ok: true });
  assert.equal((await ws("status", { file: "proj/a.ts" })).body.languages[0].state, "off");
  assert.deepEqual((await ws("status", {})).body, { languages: [] }, "without a file the status says nothing");
  assert.equal((await ws("restart", { file: "proj/note.txt" })).status, 400, "no language, no indication => 400");
  assert.equal((await ws("restart", { file: "proj/a.ts", language: "cobol" })).status, 400);
});

test("(20) insertions at the same position are in the order of the array", () => {
  const enabled = (line, character) => ({ start: { line, character }, end: { line, character } });
  assert.equal(applyEdits("ab", [{ range: enabled(0, 1), newText: "X" }, { range: enabled(0, 1), newText: "Y" }, { range: enabled(0, 1), newText: "Z" }]), "aXYZb");
  assert.equal(applyEdits("ab\ncd", [{ range: enabled(1, 0), newText: "1" }, { range: enabled(0, 0), newText: "0" }, { range: enabled(1, 0), newText: "2" }]), "0ab\n12cd");
  assert.throws(() => applyEdits("abc", [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: "" }, { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }, newText: "" }]), (e) => e.code === "EOVERLAP");
});

test("(21) codeActionProvider without kinds => only quick_fix; with kinds exactly those", () => {
  const including = (caps) => capabilitiesOf({ caps, registered: new Set() }).filter((f) => ["quick_fix", "refactor", "source_action"].includes(f));
  assert.deepEqual(including({ codeActionProvider: true }), ["quick_fix"]);
  assert.deepEqual(including({ codeActionProvider: { resolveProvider: true } }), ["quick_fix"]);
  assert.deepEqual(including({ codeActionProvider: { codeActionKinds: ["refactor.extract", "source.organizeImports"] } }), ["refactor", "source_action"]);
  assert.deepEqual(including({ codeActionProvider: { codeActionKinds: ["quickfix", "refactor", "source"] } }), ["quick_fix", "refactor", "source_action"]);
  assert.deepEqual(capabilitiesOf({ caps: {}, registered: new Set(["textDocument/codeAction"]) }).filter((f) => f.endsWith("fix") || f === "refactor"), ["quick_fix"], "registered dynamically, without kinds");
});

test("(23) resolve a suggestion (latest list only), labelDetails/deprecated, semantic tokens with legend", async () => {
  const pos = { line: 1, character: 11 };
  const c1 = await ed("completions", doc({ position: pos }));
  const late = c1.body.items[2];
  assert.equal(late.labelDetail, "(a)");
  assert.equal(late.description, "module");
  assert.equal(late.detail, undefined, "no fallback to labelDetails.detail (the agents compute that themselves)");
  assert.equal(late.deprecated, true, "tags: [1] => deprecated");
  const r = await ed("completion_resolve", doc({ resolve: late.resolve }));
  assert.deepEqual(r.body, { resolved: true, detail: "resolved late", documentation: "**late**" });
  const c2 = await ed("completions", doc({ position: pos }));
  assert.notEqual(c2.body.items[2].resolve, late.resolve, "every list has its own id");
  assert.deepEqual((await ed("completion_resolve", doc({ resolve: late.resolve }))).body, { resolved: false }, "an older list is no longer resolvable");
  assert.deepEqual((await ed("completion_resolve", doc({ resolve: "x" }))).body, { resolved: false });
  const st = await ed("status", { file: "a.ts" });
  assert.ok(st.body.languages[0].features.includes("semantic_tokens"));
  const sem = await ed("semantic_tokens", doc());
  assert.deepEqual(sem.body.legend, { types: ["variable", "function"], modifiers: ["declaration", "readonly"] });
  // A: "const item = 1;" and "const y = item + FAILED;" => (0,6) declaration, (1,10) relative one line lower, column absolute.
  assert.deepEqual(sem.body.data, [0, 6, 4, 0, 3, 1, 10, 4, 0, 2]);
  scenario({ without: ["semanticTokensProvider"] });
  await ed("restart", { file: "a.ts" });
  const without = await ed("semantic_tokens", doc({ buffer: "b23", version: 1 }));
  assert.deepEqual(without.body, { legend: { types: [], modifiers: [] }, data: [] });
  scenario();
  await ed("restart", { file: "a.ts" });
});

test("(22) a message above MESSAGE_MAX is a protocol error — the process ends, open requests throw", async () => {
  const kind = new EventEmitter();
  kind.stdout = new PassThrough();
  kind.stderr = new PassThrough();
  kind.stdin = new PassThrough();
  kind.stdin.resume();
  const signals = [];
  kind.kill = (sig) => { signals.push(sig); setImmediate(() => kind.emit("exit", null, sig)); return true; };
  const v = new Connection(kind);
  const open = v.request("textDocument/hover", {});
  kind.stdout.write(`Content-Length: ${MESSAGE_MAX + 1}\r\n\r\n`);
  kind.stdout.write(Buffer.alloc(1024, 32));
  await assert.rejects(open, (e) => e.code === "EEND" && /too large/.test(e.message));
  assert.deepEqual(signals, ["SIGKILL"]);
  assert.equal(v.alive, false);
});

const NULL0 = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

test("(24) additional edits and command of a suggestion; deprecated as a field; detail without fallback; filter above the cap", async () => {
  scenario({ suggestions: "addition" });
  try {
    const c = await ed("completions", doc({ position: { line: 1, character: 11 } }));
    const next = Object.fromEntries(c.body.items.map((it) => [it.label, it]));
    assert.equal(next.oldField.deprecated, true, "deprecated: true as a field (without tags)");
    assert.deepEqual(next.withImport.additionalTextEdits, [{ range: NULL0, newText: "import x;\n" }], "the change without an end drops out");
    assert.equal(next.withImport.command, "editor.action.triggerSuggest");
    assert.equal(next.foreign.command, undefined, "the editor does not run a foreign command — it does not cross the border");
    assert.equal(next.late.detail, undefined);
    assert.equal(next.word1.detail, "a variable");
    // The same id on ANOTHER file: not resolvable (the list belongs to a.ts).
    fs.writeFileSync(path.join(project, "different.ts"), "const z = 1;\n");
    const foreign = await ed("completion_resolve", { file: "different.ts", buffer: "b24a", version: 1, text: "const z = 1;\n", resolve: next.late.resolve });
    assert.deepEqual(foreign.body, { resolved: false }, "a list of another file");
    assert.equal((await ed("completion_resolve", doc({ resolve: next.late.resolve }))).body.resolved, true, "at a.ts it is");
  } finally { scenario(); }
  scenario({ suggestions: "many" });
  try {
    // Above the cap (1,000) first filtered by the typed word: `countAll` is at position 1,201 at the server.
    const text = "const a = 1;\nconst x = countA\n";
    const c = await ed("completions", doc({ buffer: "b24", version: 1, text, position: { line: 1, character: 16 } }));
    assert.deepEqual(c.body.items.map((it) => it.label), ["countAll"]);
    assert.equal(c.body.incomplete, true, "something dropped => the editor asks again while typing");
    const r = await ed("completion_resolve", doc({ buffer: "b24", version: 1, text, resolve: c.body.items[0].resolve }));
    assert.deepEqual(r.body, { resolved: true, detail: "Auto import from './tool'", additionalTextEdits: [{ range: NULL0, newText: "import { countAll } from \"./tool\";\n" }] }, "the import comes along, the foreign command does not");
    const empty = await ed("completions", doc({ buffer: "b24", version: 2, text: "const a = 1;\nconst x = \n", position: { line: 1, character: 10 } }));
    assert.equal(empty.body.items.length, 1000, "without a typed word: capped");
    assert.equal(empty.body.incomplete, true);
  } finally { scenario(); }
});

test("(25) semantic tokens — the client leaves => $/cancelRequest and 409; ServerCancelled => 409; refresh => event", async () => {
  scenario({ semantics: "holds" });
  try {
    const ac = new AbortController();
    const prior = count("textDocument/semanticTokens/full"), aborts = count("$/cancelRequest");
    const response = lspEditorResponse("semantic_tokens", doc(), (f) => resolve(f), { signal: ac.signal });
    while (count("textDocument/semanticTokens/full") === prior) await new Promise((r) => setImmediate(r));
    ac.abort();
    const r = await response;
    assert.equal(r.status, 409, JSON.stringify(r.body));
    while (count("$/cancelRequest") === aborts) await new Promise((r2) => setImmediate(r2));
    assert.ok(Number.isInteger(log().filter((x) => x.m === "$/cancelRequest").at(-1).p.id), "the server learns which request");
    const already = new AbortController();
    already.abort();
    assert.equal((await lspEditorResponse("semantic_tokens", doc(), (f) => resolve(f), { signal: already.signal })).status, 409, "already aborted");
  } finally { scenario(); }
  scenario({ semantics: -32802 });
  try {
    assert.equal((await ed("semantic_tokens", doc())).status, 409, "ServerCancelled means: ask again");
  } finally { scenario(); }
  scenario({ semantics: "refresh" });
  try {
    const n = events.length;
    const r = await ed("semantic_tokens", doc());
    assert.equal(r.status, 200);
    assert.deepEqual(events.slice(n).filter((e) => e.type !== "lsp/status"), [{ type: "lsp/semantic_refresh", projectId: "p1", instance: null, language: "ts" }]);
    assert.ok(log().some((x) => x.response === "workspace/semanticTokens/refresh" && x.result === null), "B answers the refresh");
  } finally { scenario(); }
  assert.deepEqual((await ed("semantic_tokens", doc())).body.data, [0, 6, 4, 0, 3, 1, 10, 4, 0, 2], "the session lives on");
});

test("(26) broken tokens => no tokens, the legend stays", async () => {
  for (const kind of ["broken", "negative"]) {
    scenario({ semantics: kind });
    try {
      const r = await ed("semantic_tokens", doc());
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { legend: { types: ["variable", "function"], modifiers: ["declaration", "readonly"] }, data: [] }, kind);
    } finally { scenario(); }
  }
});

test("(27) the trigger characters come from the server's capabilities, cleaned", async () => {
  await ed("diagnostics", doc());
  assert.deepEqual((await ed("status", { file: "a.ts" })).body.languages[0].triggers, { completion: ["."], signature: ["("], signatureRetrigger: [] });
  scenario({ trigger: { completion: [".", "", "too_long", ".", 5, "<"], signature: ["(", ","], retrigger: [")"] } });
  try {
    await ed("restart", { file: "a.ts" });
    await ed("diagnostics", doc());
    assert.deepEqual((await ed("status", { file: "a.ts" })).body.languages[0].triggers, { completion: [".", "<"], signature: ["(", ","], signatureRetrigger: [")"] });
  } finally { scenario(); }
  // The reason for the parameter hints goes along as LSP context (B reports `contextSupport`).
  const context = async (extra) => {
    await ed("signature_help", doc({ position: { line: 1, character: 11 }, ...extra }));
    return log().filter((x) => x.m === "textDocument/signatureHelp").at(-1).p.context;
  };
  assert.deepEqual(await context({}), { triggerKind: 1, isRetrigger: false }, "manual");
  assert.deepEqual(await context({ trigger: "(" }), { triggerKind: 2, triggerCharacter: "(", isRetrigger: false }, "trigger character");
  assert.deepEqual(await context({ trigger: ")", retrigger: true }), { triggerKind: 2, triggerCharacter: ")", isRetrigger: true }, "retrigger with character");
  assert.deepEqual(await context({ retrigger: true }), { triggerKind: 3, isRetrigger: true }, "retrigger after a change");
  assert.deepEqual(await context({ trigger: "too_long" }), { triggerKind: 1, isRetrigger: false }, "a character beyond four is none");
  await ed("stop", { file: "a.ts" });
  assert.equal((await ed("status", { file: "a.ts" })).body.languages[0].triggers, undefined, "only a ready server reports them");
});

test("(28) over HTTP: if the client leaves before the answer, the server gets $/cancelRequest; code-route passes the signal through", async () => {
  const http = await import("node:http");
  scenario({ semantics: "holds" });
  const finished = [];
  const srv = http.createServer(async (req, res) => {
    const r = await lspEditorResponse("semantic_tokens", doc(), (f) => resolve(f), { signal: abortOf(res) });
    finished.push(r.status);
    if (!res.writableEnded && !res.destroyed) res.end();
  });
  try {
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const prior = count("textDocument/semanticTokens/full"), aborts = count("$/cancelRequest");
    const req = http.request({ host: "127.0.0.1", port: srv.address().port, method: "POST", path: "/" });
    req.on("error", () => {});
    req.end();
    while (count("textDocument/semanticTokens/full") === prior) await new Promise((r) => setImmediate(r));
    req.destroy();
    while (count("$/cancelRequest") === aborts) await new Promise((r) => setImmediate(r));
    while (!finished.length) await new Promise((r) => setImmediate(r));
    assert.deepEqual(finished, [409]);
  } finally {
    scenario();
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
  const source = fs.readFileSync(path.join(HERE, "..", "electron", "server", "devtools", "code-route.js"), "utf8");
  const suffices = (q) => /const signal = abortOf\(res\);/.test(q) && /lspEditorResponse\([^;]*\{ signal \}\);/.test(q);
  assert.ok(suffices(source), "devtools/code-route.js passes abortOf(res) to lspEditorResponse");
  assert.equal(suffices(source.replace("{ signal });", "{});")), false, "sabotage: without signal");
});
