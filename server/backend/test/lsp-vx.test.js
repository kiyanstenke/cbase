// A language switch restarts the language servers IMMEDIATELY: i18n.js `atUiLangSwitch` -> lsp/sessions.js `languageSwitched` —
// the old session leaves in order (lsp/connection.js farewell: `shutdown`, `exit`), the new one starts with the new `locale`, its
// documents get `didOpen` (buffer and version as before, lsp/documents.js `reopenDocuments`), then `lsp/diagnostic_refresh` goes to
// the windows.
//   (1) de -> en: fresh without a click — events off/starting/ready/diagnostic_refresh, the old process got shutdown and exit and is
//       gone, ONE process lives; the diagnostics of the same buffer (WITHOUT text: the document went along) speak English
//   (2) same language: no listener, no restart (same process) — not even when languageSwitched itself is called
//   (3) a running request ends cleanly (502 instead of hanging), one made during the switch goes to the new session
//   (4) de -> en -> de in one go: the starting en session passes its documents on, in the end ONE process in de, diagnostics without text
//   (5) `workspace/diagnostic/refresh` of a server => the same event
// Counter-tests: no listener at the switch => (1) red; a switch to the same language that restarts => (2) red.
//
// Run (from server/backend/): CBASE_EMBED_OFFLINE=1 node --test test/lsp-vx.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { endAllSessions, groupsInB, setStatusReporter, sessionsCount, languageSwitched, languageSwitchFinished } from "../electron/server/lsp/sessions.js";
import { lspEditorResponse } from "../electron/server/lsp/routes.js";
import { setLspTable } from "../electron/server/lsp/table.js";
import { DIAGNOSTIC_EVENT, STATUS_EVENT } from "../electron/server/lsp/contract.js";
import { atUiLangSwitch, getUiLang, setUiLang } from "../electron/server/i18n.js";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-lsp-vx-")));
const project = path.join(root, "proj");
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, "a.css"), "a { colr: red; }\n");
const LOG = path.join(root, "log.txt");
fs.writeFileSync(LOG, "");
const priorLanguage = getUiLang();

// The fake server: diagnostics in the language it started with, its language in the hover; line 7 never answers (the running
// request), line 8 asks for new diagnostics. Every message goes into the log with the pid (synchronous, before the end).
const WRONG = path.join(root, "fake.mjs");
fs.writeFileSync(WRONG, `
import fs from "node:fs";
let locale = null, buffer = Buffer.alloc(0), next = 1;
const write = (x) => { const t = JSON.stringify(x); process.stdout.write("Content-Length: " + Buffer.byteLength(t) + "\\r\\n\\r\\n" + t); };
const notice = () => (locale === "de" ? "Unbekannte Eigenschaft: 'colr'" : "Unknown property: 'colr'");
const diagnostics = (uri, version) => write({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, version,
  diagnostics: [{ range: { start: { line: 0, character: 4 }, end: { line: 0, character: 8 } }, severity: 2, message: notice(), source: "css" }] } });
function edit(m) {
  if (m.method) fs.appendFileSync(${JSON.stringify(LOG)}, process.pid + " " + m.method + "\\n");
  const response = (result) => write({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize": locale = m.params.locale ?? null; return response({ capabilities: { hoverProvider: true, textDocumentSync: 1 } });
    case "textDocument/didOpen": return diagnostics(m.params.textDocument.uri, m.params.textDocument.version);
    case "textDocument/didChange": return diagnostics(m.params.textDocument.uri, m.params.textDocument.version);
    case "textDocument/hover": {
      const z = m.params.position.line;
      if (z === 7) return; // hangs
      if (z === 8) write({ jsonrpc: "2.0", id: "bitte-" + next++, method: "workspace/diagnostic/refresh" });
      return response({ contents: { kind: "plaintext", value: String(locale) } });
    }
    case "shutdown": return response(null);
    case "exit": process.exit(0);
    default: if (m.id !== undefined && m.method) response(null);
  }
}
process.stdin.on("data", (c) => {
  buffer = Buffer.concat([buffer, c]);
  for (;;) { const i = buffer.indexOf("\\r\\n\\r\\n"); if (i < 0) return; const l = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, i).toString())[1]);
    if (buffer.length < i + 4 + l) return; const m = JSON.parse(buffer.subarray(i + 4, i + 4 + l).toString()); buffer = buffer.subarray(i + 4 + l); edit(m); }
});
`);

const TARGET = { projectId: "pvx", instance: null, root: project, base: project };
const ed = (action, body = {}) => lspEditorResponse(action, body, (f) => (f ? { ...TARGET, abs: path.join(project, f) } : { ...TARGET }));
const TEXT = "a { colr: red; }\n".repeat(9);
// The window buffer: once with text, afterwards only id and version (as lib/api/lsp.ts, text only after 409 TEXT_MISSING).
const buffer = (extra = {}) => ({ file: "a.css", buffer: "window-1", version: 1, ...extra });
const hover = async (line) => ed("hover", buffer({ position: { line, character: 3 } }));
const language = async () => (await hover(0)).body.contents;
const notices = async () => {
  const r = await ed("diagnostics", buffer());
  assert.equal(r.status, 200, `diagnostics without text: ${JSON.stringify(r.body)} (the document did not go along)`);
  return r.body.diagnostics.map((d) => d.message);
};
const log = () => fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((z) => z.split(" "));
const pid = () => { const g = groupsInB("pvx"); assert.equal(g.length, 1, `exactly one server: ${g}`); return g[0]; };

let events = [];
const waiters = new Set();
/** Waits for an event from index `ab` on — no tick, no pause (the barrier releases as soon as it came). */
const event = (check, from = 0) => new Promise((resolve) => {
  const look = () => { const e = events.slice(from).find(check); if (e) { waiters.delete(look); resolve(e); return true; } return false; };
  if (!look()) waiters.add(look);
});

test.before(async () => {
  setStatusReporter((e) => { events.push(e); for (const w of [...waiters]) w(); });
  setUiLang("de");
  setLspTable({ css: { command: [process.execPath, WRONG] } });
  const r = await ed("diagnostics", buffer({ text: TEXT }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
});
test.after(() => {
  endAllSessions("test");
  setLspTable(null);
  setStatusReporter(null);
  setUiLang(priorLanguage);
  fs.rmSync(root, { recursive: true, force: true });
});

test("(1) de → en: fresh at once, old process gone in order, one process, diagnostics of the same buffer in English without text", async () => {
  assert.deepEqual(await notices(), ["Unbekannte Eigenschaft: 'colr'"]);
  const old = pid();
  const mark = events.length;
  setUiLang("en"); // just that — no further call, no click
  const refresh = await event((e) => e.type === DIAGNOSTIC_EVENT, mark);
  assert.deepEqual(refresh, { type: DIAGNOSTIC_EVENT, projectId: "pvx", instance: null, language: "css" });
  await languageSwitchFinished();
  const states = events.slice(mark).filter((e) => e.type === STATUS_EVENT).map((e) => e.state);
  assert.deepEqual(states, ["off", "starting", "ready"]);
  assert.ok(events.indexOf(refresh) > events.findLastIndex((e) => e.type === STATUS_EVENT && e.state === "ready"), "the event comes AFTER ready");
  const fresh = pid();
  assert.notEqual(fresh, old, "a new process");
  assert.equal(sessionsCount(), 1, "no session twice, the old process is gone");
  const oldOnes = log().filter(([p]) => Number(p) === old).map(([, m]) => m);
  assert.deepEqual(oldOnes.slice(-2), ["shutdown", "exit"], "ended in order");
  // Diagnostics first (the server creates them from didOpen), THEN its log: B sends didOpen before `ready`, but the server writes
  // the line only when it reads it — read right after `ready` that was a race under load.
  assert.deepEqual(await notices(), ["Unknown property: 'colr'"]);
  const fresh2 = log().filter(([p]) => Number(p) === fresh).map(([, m]) => m);
  assert.ok(fresh2.indexOf("textDocument/didOpen") > fresh2.indexOf("initialized"), "the document went along");
  assert.equal(await language(), "en");
});

test("(2) same language: no listener, no restart", async () => {
  const prior = pid();
  let called = 0;
  const from = atUiLangSwitch(() => { called += 1; });
  try {
    const n = events.length;
    setUiLang("en");
    assert.equal(called, 0, "setUiLang with the same language calls nobody");
    assert.deepEqual(await languageSwitched(), [], "languageSwitched starts nothing that already speaks the language");
    assert.equal(pid(), prior);
    assert.deepEqual(events.slice(n), []);
  } finally { from(); }
});

test("(3) a running request ends cleanly with an error, one during the switch goes to the new session", async () => {
  const hangs = hover(7);
  await hover(0); // the server works in order: once this one is answered, it has the hanging one
  setUiLang("de");
  const during = language();
  const r = await hangs;
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.match(r.body.error, /startet neu/);
  assert.equal(await during, "de");
  await languageSwitchFinished();
  assert.equal(sessionsCount(), 1);
  assert.deepEqual(await notices(), ["Unbekannte Eigenschaft: 'colr'"]);
});

test("(4) de → en → de in one go: the documents pass through the starting session, in the end ONE process in de", async () => {
  setUiLang("en");
  setUiLang("de");
  const fresh = await languageSwitchFinished();
  assert.ok(fresh.every((s) => s && s.locale === "de" && s.state === "ready"), "every restart ends in the ready de session");
  assert.equal(sessionsCount(), 1);
  assert.deepEqual(await notices(), ["Unbekannte Eigenschaft: 'colr'"]);
  assert.equal(await language(), "de");
});

test("(5) workspace/diagnostic/refresh of a server ⇒ lsp/diagnostic_refresh", async () => {
  const mark = events.length;
  const r = await hover(8);
  assert.equal(r.status, 200);
  assert.deepEqual(await event((e) => e.type === DIAGNOSTIC_EVENT, mark), { type: DIAGNOSTIC_EVENT, projectId: "pvx", instance: null, language: "css" });
});
