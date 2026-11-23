// A fake language server for the editor-navigation tests. Not a test, hence .mjs: a Node program that speaks LSP over stdio,
// started by the core (lsp/sessions.js) through the test seam `setLspTable` (in the test process) or `CBASE_LSP_FAKE` (in the
// server as a child process; then with `--language <language>` behind it). It computes nothing real: words are `[A-Za-z0-9_$]+`,
// a definition is the first occurrence of the word in the document, a rename replaces every occurrence in the document.
//
// THE SCENARIO (`--scenario <file>` or `FAKE_LSP_SCENARIO`, JSON; re-read for EVERY request, so a test can change it between
// two requests):
//   diagnosticWord  "FAILED"  every occurrence is a diagnostic (push after didOpen/didChange with `version`)
//   pull          bool       `diagnosticProvider` instead of push
//   definition    [{ path, range }]  fixed targets (absolute paths) instead of the first occurrence
//   renameAlongside    [{ path, range, newText? }]  additional changes of a rename (one outside ⇒ OUTSIDE)
//   createRename bool       the rename wants to create a file (`documentChanges` with `create`)
//   crashAt    "method"  at this request/notification: stderr row, then exit 3
//   dieAtStart bool         exit 2 at startup
//   without       ["…Provider"]  these capabilities are missing
//   diagnosticBundle  n       hold back reports per file until n versions are there, then report EVERY version (with its text and
//                            its `version`, even outdated ones) in order: a second reconcile in the waiting time, without a clock
//   codeActionBeides bool    a fifth code action "Beides": an edit (insert line 0) AND the command `fake.two`, whose applyEdit
//                            computes on the state AFTER the edit (insert line 1)
//   flat          bool       document symbols flat (containerName) instead of nested
//   suggestions   "many"     1,200 fillers BEFORE the auto-import entry (as typescript-language-server: auto-imports last); its resolve
//                            brings the import as additionalTextEdits and a command the editor does not execute
//                 "addition" three more entries: `deprecated: true` as a field, additional edits + `editor.action.triggerSuggest` in
//                            the list (an edit without an end), a foreign command
//   semantics     "broken" | "negative"   tokens without a group of five, or with a negative number
//                 "holds"    the token request stays open (until B sends `$/cancelRequest`, logged like every message)
//                 "refresh"  before answering, the server asks `workspace/semanticTokens/refresh` and waits for B
//                 <number>   a response error with this code (-32802 ServerCancelled)
//   trigger       { completion, signature, retrigger }   instead of the fixed trigger characters
// LOG (`FAKE_LSP_LOG`, JSONL): per received message `{ m, p }` (method, shortened params) and B's responses to own requests
// `{ response, result }`, written synchronously, so the order is right.
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const LANGUAGE = arg("--language") || "ts";
const SCENARIO = arg("--scenario") || process.env.FAKE_LSP_SCENARIO || "";
const LOG = process.env.FAKE_LSP_LOG || "";
const scenario = () => { if (!SCENARIO) return {}; try { return JSON.parse(fs.readFileSync(SCENARIO, "utf8")); } catch { return {}; } };
const log = (o) => { if (LOG) { try { fs.appendFileSync(LOG, `${JSON.stringify({ pid: process.pid, language: LANGUAGE, ...o })}\n`); } catch { /* ignore */ } } };

const docs = new Map(); // uri → { text, version }
let nextId = 1;
const open = new Map();
function write(n) { const t = JSON.stringify(n); process.stdout.write(`Content-Length: ${Buffer.byteLength(t)}\r\n\r\n${t}`); }
const request = (method, params) => new Promise((resolve) => { const id = `s${nextId++}`; open.set(id, resolve); write({ jsonrpc: "2.0", id, method, params }); });
const note = (method, params) => write({ jsonrpc: "2.0", method, params });

const rows = (t) => String(t).split(/\r\n|\n|\r/);
function occurrences(text, word) {
  const out = [];
  if (!word) return out;
  rows(text).forEach((z, line) => {
    const re = new RegExp(`(?<![A-Za-z0-9_$])${word.replace(/[$]/g, "\\$")}(?![A-Za-z0-9_$])`, "g");
    for (let m; (m = re.exec(z));) out.push({ start: { line, character: m.index }, end: { line, character: m.index + word.length } });
  });
  return out;
}
function wordAt(text, pos) {
  const z = rows(text)[pos?.line ?? 0] ?? "";
  let a = pos?.character ?? 0, b = a;
  while (a > 0 && /[A-Za-z0-9_$]/.test(z[a - 1])) a--;
  while (b < z.length && /[A-Za-z0-9_$]/.test(z[b])) b++;
  return a === b ? null : { word: z.slice(a, b), range: { start: { line: pos.line, character: a }, end: { line: pos.line, character: b } } };
}
const NULL = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
const uriOf = (path) => pathToFileURL(path).href;

function diagnosticsText(text) {
  const word = scenario().diagnosticWord || "FAILED";
  return occurrences(text ?? "", word).map((range) => ({ range, severity: 1, message: `${word} found`, source: "fake", code: "F1" }));
}
const diagnostics = (uri) => diagnosticsText(docs.get(uri)?.text);
// Only once B has answered `workspace/configuration` does the server answer and report diagnostics, so the answer is in the
// log before a test sees the first response (no waiting on a clock).
let configured;
const ready = new Promise((r) => { configured = r; });
const held = new Map(); // uri → [{ version, text }] (diagnosticBundle)
function report(uri) {
  const version = docs.get(uri)?.version;
  const n = Number(scenario().diagnosticBundle) || 0;
  if (n > 0) {
    const list = held.get(uri) || [];
    list.push({ version, text: docs.get(uri)?.text ?? "" });
    held.set(uri, list);
    if (list.length < n) return;
    held.delete(uri);
    ready.then(() => { for (const x of list) note("textDocument/publishDiagnostics", { uri, version: x.version, diagnostics: diagnosticsText(x.text) }); });
    return;
  }
  ready.then(() => { if (!scenario().pull && docs.get(uri)?.version === version) note("textDocument/publishDiagnostics", { uri, version, diagnostics: diagnostics(uri) }); });
}

function capabilities() {
  const caps = {
    textDocumentSync: 1, completionProvider: { triggerCharacters: scenario().trigger?.completion ?? ["."], resolveProvider: true }, hoverProvider: true,
    signatureHelpProvider: { triggerCharacters: scenario().trigger?.signature ?? ["("], ...(scenario().trigger?.retrigger ? { retriggerCharacters: scenario().trigger.retrigger } : {}) },
    semanticTokensProvider: { legend: { tokenTypes: ["variable", "function"], tokenModifiers: ["declaration", "readonly"] }, full: true },
    definitionProvider: true, typeDefinitionProvider: true, implementationProvider: true, referencesProvider: true, documentHighlightProvider: true,
    documentSymbolProvider: true, workspaceSymbolProvider: true, renameProvider: { prepareProvider: true },
    codeActionProvider: { codeActionKinds: ["quickfix", "refactor", "source"], resolveProvider: true }, documentFormattingProvider: true,
    callHierarchyProvider: true, executeCommandProvider: { commands: ["fake.apply", "fake.two", ...(LANGUAGE === "ts" ? ["_typescript.goToSourceDefinition"] : [])] },
    ...(scenario().pull ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } : {}),
  };
  for (const k of scenario().without || []) delete caps[k];
  return caps;
}

async function answer(method, p) {
  const d = p?.textDocument?.uri ? docs.get(p.textDocument.uri) : null;
  const uri = p?.textDocument?.uri;
  const w = d && p?.position ? wordAt(d.text, p.position) : null;
  switch (method) {
    case "initialize": return { capabilities: capabilities(), serverInfo: { name: "fake-lsp", version: "1.0.0" } };
    case "shutdown": return null;
    case "textDocument/completion": {
      const kind = scenario().suggestions;
      if (kind === "many") {
        const items = Array.from({ length: 1200 }, (_, i) => ({ label: `filler${i}`, kind: 6 }));
        items.push({ label: "countAll", kind: 3, data: { importFrom: "./tool" } });
        return { isIncomplete: false, items };
      }
      return { isIncomplete: false, items: [
        { label: "word1", kind: 6, detail: "a variable", insertText: "word1" },
        { label: "snip", kind: 15, insertTextFormat: 2, insertText: "snip($1)", documentation: { kind: "markdown", value: "*docs*" } },
        { label: "late", kind: 3, labelDetails: { detail: "(a)", description: "module" }, tags: [1], data: { seq: 3 } },
        ...(kind === "addition" ? [
          { label: "oldField", kind: 5, deprecated: true },
          { label: "withImport", kind: 3, additionalTextEdits: [{ range: NULL, newText: "import x;\n" }, { range: { start: { line: 0, character: 0 } }, newText: "broken" }], command: { title: "fresh", command: "editor.action.triggerSuggest" } },
          { label: "foreign", kind: 3, command: { title: "x", command: "_typescript.applyCompletionCodeAction", arguments: [] } },
        ] : []),
      ] };
    }
    // Resolves only entries with `data` (as typescript-language-server: detail and docs only here, so does an auto-import's import).
    case "completionItem/resolve":
      if (p?.data?.importFrom) {
        return { ...p, detail: `Auto import from '${p.data.importFrom}'`, additionalTextEdits: [{ range: NULL, newText: `import { ${p.label} } from "${p.data.importFrom}";\n` }], command: { title: "x", command: "_typescript.applyCompletionCodeAction", arguments: [] } };
      }
      return p?.data ? { ...p, detail: `resolved ${p.label}`, documentation: { kind: "markdown", value: `**${p.label}**` } } : p;
    case "textDocument/semanticTokens/full": {
      const kind = scenario().semantics;
      if (kind === "broken") return { data: [0, 6, 4, 0] };
      if (kind === "negative") return { data: [0, -1, 4, 0, 0] };
      if (kind === "holds") return new Promise(() => {});
      if (Number.isInteger(kind)) throw Object.assign(new Error("cancelled by the server"), { code: kind });
      if (kind === "refresh") log({ response: "workspace/semanticTokens/refresh", result: await request("workspace/semanticTokens/refresh", null) });
      // Every occurrence of "item" is a variable (readonly), the first one also its declaration; relatively encoded as in LSP.
      const locations = d ? occurrences(d.text, "item") : [];
      const data = [];
      let row = 0, column = 0;
      locations.forEach((r, i) => {
        const dz = r.start.line - row, ds = dz === 0 ? r.start.character - column : r.start.character;
        data.push(dz, ds, 4, 0, i === 0 ? 0b11 : 0b10);
        row = r.start.line; column = r.start.character;
      });
      return { data };
    }
    case "textDocument/hover": return w ? { contents: { kind: "markdown", value: `**${w.word}**` }, range: w.range } : null;
    case "textDocument/signatureHelp": return { signatures: [{ label: "f(a, b)", parameters: [{ label: "a" }, { label: "b", documentation: { kind: "markdown", value: "das *b*" } }] }], activeSignature: 0, activeParameter: 1 };
    case "textDocument/definition":
    case "textDocument/implementation": {
      const fixed = scenario().definition;
      if (Array.isArray(fixed)) return fixed.map((x) => ({ uri: uriOf(x.path), range: x.range || NULL }));
      const r = w ? occurrences(d.text, w.word)[0] : null;
      return r ? [{ uri, range: r }] : [];
    }
    case "textDocument/typeDefinition": {
      const r = w ? occurrences(d.text, w.word)[0] : null;
      return r ? [{ targetUri: uri, targetRange: r, targetSelectionRange: r }] : null;
    }
    case "textDocument/references": return w ? occurrences(d.text, w.word).map((range) => ({ uri, range })) : [];
    case "textDocument/documentHighlight": return w ? occurrences(d.text, w.word).map((range) => ({ range, kind: 1 })) : [];
    case "textDocument/documentSymbol":
      if (scenario().flat) return [{ name: "Klasse", kind: 5, location: { uri, range: NULL } }, { name: "method", kind: 6, containerName: "Klasse", location: { uri, range: NULL } }];
      return [{ name: "Klasse", kind: 5, range: NULL, selectionRange: NULL, children: [{ name: "method", kind: 6, range: NULL, selectionRange: NULL }] }];
    case "workspace/symbol": return [...docs.keys()].slice(0, 1).map((u) => ({ name: `${p?.query || ""}Symbol`, kind: 12, containerName: "module", location: { uri: u, range: NULL } }));
    case "textDocument/prepareRename": return w ? { range: w.range, placeholder: w.word } : null;
    case "textDocument/rename": {
      if (!w) return null;
      const db = scenario();
      const edits = occurrences(d.text, w.word).map((range) => ({ range, newText: p.newName }));
      if (db.createRename) return { documentChanges: [{ kind: "create", uri: uriOf("/tmp/fresh.ts") }, { textDocument: { uri, version: d.version }, edits }] };
      const changes = { [uri]: edits };
      for (const x of db.renameAlongside || []) (changes[uriOf(x.path)] ||= []).push({ range: x.range || NULL, newText: x.newText ?? p.newName });
      return { changes };
    }
    case "textDocument/codeAction":
      return [
        { title: "Repair", kind: "quickfix", isPreferred: true, data: { uri }, diagnostics: p?.context?.diagnostics || [] },
        { title: "With command", kind: "source.organizeImports", command: { title: "apply", command: "fake.apply", arguments: [uri] } },
        { title: "Bare command", command: "fake.apply", arguments: [uri] },
        { title: "Locked", kind: "refactor", disabled: { reason: "not possible here" } },
        ...(scenario().codeActionBeides ? [{ title: "Beides", kind: "quickfix", edit: { changes: { [uri]: [{ range: NULL, newText: "// eins\n" }] } }, command: { title: "two", command: "fake.two", arguments: [uri] } }] : []),
      ];
    case "codeAction/resolve": return p?.data?.uri ? { ...p, edit: { changes: { [p.data.uri]: [{ range: NULL, newText: "// repaired\n" }] } } } : p;
    case "workspace/executeCommand": {
      if (p?.command === "fake.apply") {
        const r = await request("workspace/applyEdit", { label: "fake", edit: { changes: { [p.arguments[0]]: [{ range: NULL, newText: "// command\n" }] } } });
        log({ response: "workspace/applyEdit", result: r });
        return null;
      }
      if (p?.command === "fake.two") {
        // Computed on the state AFTER the action's edit (LSP: first the edit, then the command); line 1 is the old line 0.
        const row1 = { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } };
        const r = await request("workspace/applyEdit", { label: "two", edit: { changes: { [p.arguments[0]]: [{ range: row1, newText: "// zwei\n" }] } } });
        log({ response: "workspace/applyEdit", result: r });
        return null;
      }
      if (p?.command === "_typescript.goToSourceDefinition") return [{ uri: p.arguments[0], range: NULL }];
      throw Object.assign(new Error(`unbekannter Befehl ${p?.command}`), { code: -32602 });
    }
    case "textDocument/prepareCallHierarchy": return w ? [{ name: w.word, kind: 12, uri, range: w.range, selectionRange: w.range, data: { secret: 1 } }] : null;
    case "callHierarchy/incomingCalls": return [{ from: { name: "caller", kind: 12, uri: p.item.uri, range: NULL, selectionRange: NULL }, fromRanges: [NULL] }];
    case "callHierarchy/outgoingCalls": return [{ to: { name: "called", kind: 12, uri: p.item.uri, range: NULL, selectionRange: NULL }, fromRanges: [NULL] }];
    case "textDocument/formatting": return [{ range: NULL, newText: "// formatiert\n" }];
    case "textDocument/diagnostic": return { kind: "full", items: diagnostics(uri) };
    default: throw Object.assign(new Error(`not supported: ${method}`), { code: -32601 });
  }
}

function noteReceived(method, p) {
  if (method === "initialized") {
    request("workspace/configuration", { items: [{ section: "basedpyright.analysis" }, { section: "python" }, {}] }).then((r) => { log({ response: "workspace/configuration", result: r }); configured(); });
    return;
  }
  if (method === "exit") process.exit(0);
  if (method === "textDocument/didOpen") { docs.set(p.textDocument.uri, { text: p.textDocument.text, version: p.textDocument.version }); report(p.textDocument.uri); return; }
  if (method === "textDocument/didChange") {
    const d = docs.get(p.textDocument.uri);
    if (d) { d.text = p.contentChanges.at(-1).text; d.version = p.textDocument.version; report(p.textDocument.uri); }
    return;
  }
  if (method === "textDocument/didClose") { docs.delete(p.textDocument.uri); return; }
}

function distribute(n) {
  if (n.id !== undefined && !n.method) { const r = open.get(n.id); if (r) { open.delete(n.id); r(n.result ?? n.error ?? null); } return; }
  const short = n.params && JSON.stringify(n.params).length > 400 ? { uri: n.params?.textDocument?.uri, ...(n.params.context ? { context: n.params.context } : {}) } : n.params;
  log({ m: n.method, p: short });
  if (scenario().crashAt === n.method) { process.stderr.write(`crash at ${n.method}\n`); process.exit(3); }
  if (n.id === undefined) { noteReceived(n.method, n.params); return; }
  (n.method === "initialize" || n.method === "shutdown" ? Promise.resolve() : ready).then(() => answer(n.method, n.params)).then(
    (result) => write({ jsonrpc: "2.0", id: n.id, result: result ?? null }),
    (e) => write({ jsonrpc: "2.0", id: n.id, error: { code: Number.isInteger(e?.code) ? e.code : -32603, message: String(e?.message || e) } }),
  );
}

if (scenario().dieAtStart) { process.stderr.write("dies at start\n"); process.exit(2); }
log({ start: true, argv: args, cwd: process.cwd(), file: fileURLToPath(import.meta.url) });
let buffer = Buffer.alloc(0);
process.stdin.on("data", (c) => {
  buffer = Buffer.concat([buffer, c]);
  for (;;) {
    const t = buffer.indexOf("\r\n\r\n");
    if (t < 0) return;
    const m = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, t).toString("ascii"));
    const n = Number(m?.[1] ?? 0);
    if (buffer.length < t + 4 + n) return;
    const body = buffer.subarray(t + 4, t + 4 + n).toString("utf8");
    buffer = buffer.subarray(t + 4 + n);
    distribute(JSON.parse(body));
  }
});
process.stdin.on("end", () => process.exit(0));
