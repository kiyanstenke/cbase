// The sessions of the language service: ONE session per (project, instance, language) — a language server process with its
// connection, documents and diagnostics. B is the only LSP client.
//
// THE START (on first use of a language in an instance) goes through runtime/inProject.js (`inProject` with the session's
// instance) with `cwd` = project folder — with an instance in the project container (the same path; in a copy its overlay view),
// without one in B (the local server and a project that has not been relocated; the process then gets its own process group and
// a secret-free environment). Before every start, in this order — and none of it starts anything:
//   1. the instance: `stopped`/`stop` ⇒ `stopped` (a language command never starts an instance); any state other than `ready` ⇒
//      `starting` (the instance is just coming up);
//   2. the project's lock (relocation, re-creation, deletion, clearing — `setStartLock`, connected in server.js): ⇒ `starting`; a
//      server starting in the middle of a relocation would stall its process search (`process-in-project`);
//   3. the package: if it is missing ⇒ `missing`;
//   4. the memory gate (workflows/storage-gate.js): closed ⇒ `memory` with the reason.
// Then `initialize` (deadline INIT_DEADLINE_MS), `initialized`, `workspace/didChangeConfiguration` ⇒ `ready`.
//
// THE END. No idle shutdown. No contribution to `busy`, to the idle gate or to the project lock — a session is not open work. It
// ends (`endSessions`) at the lock of the project or the instance and when the instance stops (projectbox/idle.js
// `setLanguageServiceEnd` → here; the lock ends it BEFORE the relocation's process search, in B with SIGKILL to its own group,
// i.e. immediately), after a layout run (projectbox/layout/procedure.js) and at server end (hook "serverEnd", server.js). When the
// UI language changes (`languageSwitched`), a session whose server speaks the old one leaves in order (`shutdown`/`exit`) and
// restarts at once. A crash is `error` with the tail of stderr; the next use restarts it, but at most once per RESTART_GAP_MS — a
// server that dies again immediately does not spin in a loop. `restart` and `stop` are the buttons of the status bar.
//
// EVERY CHANGE of state goes out as `{ type: "lsp/status", projectId, instance, language, state, error?, version?, interpreter? }`
// on `/api/events` (runtime/sse.js broadcast). `instance` is the identifier "<project>/<instance>", null without an instance.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as store from "../store.js";
import { T, atUiLangSwitch, getUiLang } from "../i18n.js";
import { broadcast } from "../runtime/sse.js";
import { inProject } from "../runtime/inProject.js";
import { storageSituation } from "../workflows/storage-gate.js";
import { Connection } from "./connection.js";
import { entryFor } from "./table.js";
import { receiveDiagnostic, reopenDocuments, carryoverOf, cleanExpired } from "./documents.js";
import { uriOfPath } from "./text.js";
import { DIAGNOSTIC_EVENT, SEMANTICS_EVENT, LANGUAGES, STATUS_EVENT } from "./contract.js";

const INIT_DEADLINE_MS = 60_000;
const RESTART_GAP_MS = 60_000;
const ACTION_HOLD_MS = 5 * 60_000;
const EXTERN_HOLD_MS = 30 * 60_000;
/** At most this many tokens of external targets are valid at once (across all sessions) — beyond that the least recently named one drops. */
export const EXTERNAL_CAP = 5000;
const CLEAN_TICK_MS = 60_000;

/** A reason for having no language service (`{ supported: false, reason, language?, state?, error? }` with 200). */
export class LspNot extends Error {
  constructor(reason, extra = {}) { super(reason); this.body = { supported: false, reason, ...extra }; }
}

const sessions = new Map(); // key → session
const situations = new Map();     // key → { state, error } — what a start without a session last refused (memory)
const externalFiles = new Map();   // token → { abs, key, projectId, instanceName, inst, at } — in order of the last naming
const externIndex = new Map(); // `${key}\0${abs}` → token (an index instead of an uncapped linear search)

let startLock = null;
/** `fn(projectId, instanceName | null)` → reason of the lock or null (server.js: projectbox/idle.js projectLocked + open relocation). */
export function setStartLock(fn) { startLock = typeof fn === "function" ? fn : null; }
let reporter = broadcast;
/** Test seam: where the status events go (`null` = `/api/events`). */
export function setStatusReporter(fn) { reporter = typeof fn === "function" ? fn : broadcast; }
let interpreterSupplier = null;
const clientPages = new Map();
/** The client side of a server that wants more from the client than LSP (Markdown: `markdown/parse`, `markdown/fs/*` —
 *  lsp/markdown.js): `fn(session, connection)` registers its requests. Registered from actions.js (this leaf does not import
 *  lsp/markdown.js — that would read back here through limit.js). `null` takes it back. */
export function setClientPage(language, fn) { if (typeof fn === "function") clientPages.set(language, fn); else clientPages.delete(language); }
/** `fn({ projectId, instance, root })` → path of the Python interpreter or null (automatic). */
export function setInterpreterSupplier(fn) { interpreterSupplier = typeof fn === "function" ? fn : null; }

const instanceName = (inst) => (inst ? String(inst.instance || "main") : null);
const identifierOf = (inst) => (inst ? String(inst.identifier || `${inst.projectId}/${inst.instance || "main"}`) : null);
export const keyOf = (target, language) => `${target.projectId}|${instanceName(target.instance) ?? "-"}|${language}`;
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

function ctxOf(s) {
  let interpreter = null;
  if (s.language === "python" && interpreterSupplier) {
    try { interpreter = interpreterSupplier({ projectId: s.projectId, instance: s.instance, root: s.root }) || null; } catch { interpreter = null; }
  }
  // The UI language the session started with (the server's messages are in that language, lsp/table.js "LANGUAGE OF THE MESSAGES").
  return { interpreter, locale: s.locale || getUiLang(), inContainer: Boolean(s.instance) };
}

function report(s, state = s.state) {
  const ctx = s.language === "python" ? ctxOf(s) : {};
  reporter({
    type: STATUS_EVENT, projectId: s.projectId, instance: s.identifier, language: s.language, state,
    ...(s.error && state === "error" ? { error: s.error } : {}), ...(s.version ? { version: s.version } : {}),
    ...(ctx.interpreter ? { interpreter: ctx.interpreter } : {}),
  });
}
function reportSituation(target, language, state, error) {
  reporter({ type: STATUS_EVENT, projectId: String(target.projectId), instance: identifierOf(target.instance), language, state, ...(error ? { error } : {}) });
}

// What the client can do (LSP 3.17) — cbase takes only whole texts and does not offer dynamic registration (but accepts one);
// resource changes (creating/renaming files) by a server are discarded by the boundary anyway (lsp/limit.js).
const SYMBOLS = Array.from({ length: 26 }, (_, i) => i + 1);
const CLIENT_CAPABILITIES = Object.freeze({
  general: { positionEncodings: ["utf-16"] },
  window: { workDoneProgress: true, showMessage: {} },
  workspace: {
    configuration: true, workspaceFolders: true, applyEdit: true,
    workspaceEdit: { documentChanges: true, resourceOperations: [] },
    symbol: { symbolKind: { valueSet: SYMBOLS } }, executeCommand: {}, didChangeConfiguration: {},
    // A server may ask for the tokens of all views again (`workspace/semanticTokens/refresh` ⇒ event SEMANTICS_EVENT).
    semanticTokens: { refreshSupport: true },
  },
  textDocument: {
    synchronization: { didSave: false, willSave: false, dynamicRegistration: false },
    completion: {
      contextSupport: true,
      completionItem: {
        snippetSupport: true, documentationFormat: ["markdown", "plaintext"], labelDetailsSupport: true, deprecatedSupport: true,
        // As vscode-languageclient: detail, docs AND the additional edits (the import of an auto-import) only on resolve.
        tagSupport: { valueSet: [1] }, resolveSupport: { properties: ["detail", "documentation", "additionalTextEdits"] },
      },
    },
    hover: { contentFormat: ["markdown", "plaintext"] },
    signatureHelp: { contextSupport: true, signatureInformation: { documentationFormat: ["markdown", "plaintext"], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true } },
    definition: { linkSupport: true }, typeDefinition: { linkSupport: true }, implementation: { linkSupport: true }, declaration: { linkSupport: true },
    // Links (⌘-click, `link`) and colors (`colors`) as vscode-languageclient.
    documentLink: { tooltipSupport: true }, colorProvider: {},
    references: {}, documentHighlight: {}, callHierarchy: {},
    documentSymbol: { hierarchicalDocumentSymbolSupport: true, symbolKind: { valueSet: SYMBOLS } },
    codeAction: {
      codeActionLiteralSupport: { codeActionKind: { valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports", "source.fixAll"] } },
      isPreferredSupport: true, disabledSupport: true, dataSupport: true, resolveSupport: { properties: ["edit"] },
    },
    formatting: {}, rangeFormatting: {},
    rename: { prepareSupport: true },
    // Semantic tokens: only `full`, relatively encoded, without overlap and without multi-line tokens — the types and modifiers
    // VS Code knows (tokenClassificationRegistry.ts); the colors are computed by the editor (web/src/lib/semantics.ts).
    semanticTokens: {
      dynamicRegistration: false, requests: { range: false, full: { delta: false } }, formats: ["relative"],
      tokenTypes: [
        "namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember",
        "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator",
      ],
      tokenModifiers: ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"],
      overlappingTokenSupport: false, multilineTokenSupport: false, serverCancelSupport: true, augmentsSyntaxTokens: true,
    },
    publishDiagnostics: { relatedInformation: false, versionSupport: true },
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
  },
});

/** The capabilities of a session in the wording of the contract (what is missing is not in the menu). */
export function capabilitiesOf(s) {
  const c = s.caps || {};
  const reg = s.registered;
  const exists = (field, method) => Boolean(c[field]) || reg.has(method);
  const out = [];
  if (exists("completionProvider", "textDocument/completion")) out.push("completion");
  if (exists("hoverProvider", "textDocument/hover")) out.push("hover");
  if (exists("signatureHelpProvider", "textDocument/signatureHelp")) out.push("signature_help");
  if (exists("definitionProvider", "textDocument/definition")) out.push("definition");
  if (exists("typeDefinitionProvider", "textDocument/typeDefinition")) out.push("type_definition");
  if ((c.executeCommandProvider?.commands || []).includes("_typescript.goToSourceDefinition")) out.push("source_definition");
  if (exists("implementationProvider", "textDocument/implementation")) out.push("implementation");
  if (exists("referencesProvider", "textDocument/references")) out.push("references");
  if (exists("callHierarchyProvider", "textDocument/prepareCallHierarchy")) out.push("call_hierarchy");
  if (exists("documentHighlightProvider", "textDocument/documentHighlight")) out.push("document_highlight");
  if (exists("documentSymbolProvider", "textDocument/documentSymbol")) out.push("document_symbol");
  if (exists("workspaceSymbolProvider", "workspace/symbol")) out.push("workspace_symbol");
  if (exists("renameProvider", "textDocument/rename")) out.push("rename");
  if (exists("codeActionProvider", "textDocument/codeAction")) {
    // Without `codeActionKinds` (`codeActionProvider: true`, dynamically registered) the server does not say which kinds it can
    // do — then only `quick_fix` (what is not certainly there is not in the menu).
    const kinds = Array.isArray(c.codeActionProvider?.codeActionKinds) ? c.codeActionProvider.codeActionKinds : null;
    const contains = (front) => (kinds ? kinds.some((k) => k === front || String(k).startsWith(`${front}.`)) : front === "quickfix");
    if (contains("quickfix")) out.push("quick_fix");
    if (contains("refactor")) out.push("refactor");
    if (contains("source")) out.push("source_action");
  }
  if (exists("documentFormattingProvider", "textDocument/formatting")) out.push("format");
  // Only with the legend (it exists only in the static capability — cbase does not register dynamically) and `full`.
  const sem = c.semanticTokensProvider;
  if (sem?.full && Array.isArray(sem.legend?.tokenTypes)) out.push("semantic_tokens");
  if (exists("documentLinkProvider", "textDocument/documentLink")) out.push("document_link");
  if (exists("colorProvider", "textDocument/documentColor")) out.push("document_color");
  return out;
}

/** The server's trigger characters (as in VS Code: from the capabilities, not hard-coded in the editor) — suggestions
 *  (`triggerCharacters`), the parameter hints (`triggerCharacters`) and their re-query while open (`retriggerCharacters`). At
 *  most 32 per list. */
export function triggerOf(s) {
  const c = s.caps || {};
  const list = (x) => (Array.isArray(x) ? [...new Set(x.filter((z) => typeof z === "string" && z.length > 0 && z.length <= 4))].slice(0, 32) : []);
  return {
    completion: list(c.completionProvider?.triggerCharacters ?? s.registerOptions?.get("textDocument/completion")?.triggerCharacters),
    signature: list(c.signatureHelpProvider?.triggerCharacters),
    signatureRetrigger: list(c.signatureHelpProvider?.retriggerCharacters),
  };
}

class Session {
  constructor(target, language, key) {
    this.key = key;
    this.projectId = String(target.projectId);
    this.instance = target.instance || null;
    this.identifier = identifierOf(this.instance);
    this.language = language;
    this.root = path.resolve(String(target.root));
    this.rootReal = real(this.root);
    this.locale = getUiLang(); // fixed for the lifetime of the process (a change restarts, languageSwitched)
    this.carryover = null;      // the predecessor's documents (language switch) — `didOpen` before `ready`, then DIAGNOSTIC_EVENT
    this.state = "off";
    this.error = null;
    this.version = null;
    this.caps = {};
    this.registered = new Set();
    this.registerOptions = new Map(); // method → registerOptions
    this.area = target.area || null;  // where the client side reads (lsp/markdown.js — lsp/limit.js inside)
    this.kind = null;
    this.v = null;
    this.start = null;
    this.startedAt = 0;
    this.intentional = false;
    this.documents = new Map();
    this.diagnostics = new Map();
    this.diagWaiters = new Set();
    this.seq = 0;
    this.actions = new Map(); // id → { raw, at }
    this.fang = null;          // during code_action_apply: the captured `workspace/applyEdit` edits
  }
}

// The environment of a server in B (without an instance): without secrets and without cbase's switches — the server loads project
// code (the TypeScript and the tsconfig plugins from node_modules). With an instance B's environment does not go along anyway
// (runtime/inProject.js). lsp/run.js (formatter and interpreter search without an instance) starts with it as well.
const SECRET = /TOKEN|SECRET|PASSW|API_?KEY|_KEY$|AUTH|CREDENTIAL|COOKIE|PRIVATE/i;
export function environmentInB() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SECRET.test(k) && !k.startsWith("CBASE_")) out[k] = v;
  return out;
}

function wire(s, v, entry) {
  v.atRequest("workspace/configuration", (p) => (Array.isArray(p?.items) ? p.items : []).map((it) => entry.response(it?.section, ctxOf(s)) ?? null));
  // Dynamically registered (the Markdown server registers suggestions only after the settings, with its trigger characters): the
  // method and its options (triggerOf reads `triggerCharacters` there if the capability did not come statically).
  v.atRequest("client/registerCapability", (p) => {
    for (const r of p?.registrations || []) if (r?.method) { s.registered.add(String(r.method)); s.registerOptions.set(String(r.method), r.registerOptions || {}); }
    return null;
  });
  v.atRequest("client/unregisterCapability", (p) => {
    for (const r of p?.unregisterations || p?.unregistrations || []) if (r?.method) { s.registered.delete(String(r.method)); s.registerOptions.delete(String(r.method)); }
    return null;
  });
  v.atRequest("window/workDoneProgress/create", () => null);
  v.atRequest("window/showMessageRequest", () => null);
  v.atRequest("workspace/workspaceFolders", () => [{ uri: uriOfPath(s.root), name: path.basename(s.root) }]);
  // The server wants new tokens — to the views of this language (lib/api/lsp.ts LSP_SEMANTICS_EVENT, components/code/lsp-semantics.ts).
  v.atRequest("workspace/semanticTokens/refresh", () => {
    reporter({ type: SEMANTICS_EVENT, projectId: s.projectId, instance: s.identifier, language: s.language });
    return null;
  });
  // Likewise new diagnostics (as vscode-languageclient: every view of this language asks `diagnostics` again).
  v.atRequest("workspace/diagnostic/refresh", () => {
    reporter({ type: DIAGNOSTIC_EVENT, projectId: s.projectId, instance: s.identifier, language: s.language });
    return null;
  });
  for (const m of ["workspace/inlayHint/refresh", "workspace/codeLens/refresh", "workspace/inlineValue/refresh", "workspace/foldingRange/refresh"]) v.atRequest(m, () => null);
  // `workspace/applyEdit` (code_action_apply): only CAPTURED during an apply and returned to the client as `edit` — B never
  // writes what a server wants to change on its own.
  v.atRequest("workspace/applyEdit", (p) => {
    if (s.fang) { s.fang.push(p?.edit || {}); return { applied: true }; }
    return { applied: false, failureReason: "cbase applies a language server's edits only through the editor" };
  });
  v.atNote("textDocument/publishDiagnostics", (p) => receiveDiagnostic(s, p));
  clientPages.get(s.language)?.(s, v);
}

function initParameter(s, entry) {
  const uri = uriOfPath(s.root);
  return {
    // In the project container B's pid is not visible — a server watching it would exit at once. In B it ends with B.
    processId: s.instance ? null : process.pid,
    clientInfo: { name: "cbase" },
    locale: ctxOf(s).locale, // as vscode-languageclient (`vscode.env.language`)
    rootPath: s.root, rootUri: uri, workspaceFolders: [{ uri, name: path.basename(s.root) }],
    capabilities: CLIENT_CAPABILITIES,
    initializationOptions: entry.init(ctxOf(s)),
  };
}

const short = (t, n = 400) => { const x = String(t ?? "").trim(); return x.length > n ? `…${x.slice(-n)}` : x; };

function fail(s, e) {
  if (s.intentional) return;
  s.state = "error";
  s.error = short(e?.message || e);
  console.warn(`[lsp] ${s.key}: start failed — ${s.error}`);
  kill(s);
  report(s);
}

function atEnd(s, end2) {
  for (const w of [...s.diagWaiters]) w();
  s.documents.clear();
  if (s.intentional) return;
  s.state = "error";
  const reason = end2?.error || (end2?.signal ? `Signal ${end2.signal}` : `Exit ${end2?.code ?? "?"}`);
  s.error = short(`${reason}${end2?.stderr?.trim() ? ` — ${end2.stderr.trim().split("\n").slice(-5).join("\n")}` : ""}`);
  console.warn(`[lsp] ${s.key}: Server ended (${reason})`);
  report(s);
}

function kill(s) {
  const k = s.kind;
  if (!k || k.exitCode !== null || k.signalCode !== null) return;
  // With an instance `kill` hits the group in the container and escalates itself (runtime/inProject.js); in B the server is the
  // leader of its own group (detached) — SIGKILL to it also takes tsserver along, immediately and synchronously.
  if (s.instance) { try { k.kill("SIGTERM"); } catch { /* gone */ } return; }
  try { process.kill(-k.pid, "SIGKILL"); } catch { try { k.kill("SIGKILL"); } catch { /* gone */ } }
}

async function start(s, entry) {
  s.state = "starting";
  s.error = null;
  s.startedAt = Date.now();
  report(s);
  const [program, ...args] = entry.command;
  const inst = s.instance;
  let kind;
  try {
    // The entry's environment (the l10n bundle) goes along — in B added to the cleaned environment, in the container as a
    // deviation from B's environment (runtime/inProject.js `envAllowlist` carries exactly the deviations over).
    const addition = entry.environment?.(ctxOf(s)) || {};
    const withAddition = Object.keys(addition).length ? { env: { ...process.env, ...addition } } : {};
    kind = inProject(inst, program, args, { cwd: s.root, stdio: ["pipe", "pipe", "pipe"], ...(inst ? withAddition : { env: { ...environmentInB(), ...addition }, detached: true }) });
  } catch (e) { fail(s, e); return; }
  s.kind = kind;
    // The process does not keep B's event loop alive (tests end even if a server still lives; in production the HTTP server keeps it).
  kind.unref?.();
  for (const st of [kind.stdout, kind.stderr, kind.stdin]) st?.unref?.();
  const v = new Connection(kind);
  s.v = v;
  wire(s, v, entry);
  v.atEnd((end2) => atEnd(s, end2));
  try {
    const r = await v.request("initialize", initParameter(s, entry), { deadline: INIT_DEADLINE_MS });
    if (s.intentional || !v.alive) return;
    s.caps = r?.capabilities || {};
    const info = r?.serverInfo;
    s.version = info?.version ? `${info.name || entry.pack} ${info.version}` : entry.version ? `${entry.pack} ${entry.version}` : null;
    v.note("initialized", {});
    v.note("workspace/didChangeConfiguration", { settings: entry.settings(ctxOf(s)) });
    // After a language switch the predecessor's documents — BEFORE a waiting request gets the session (it would otherwise run
    // into 409 TEXT_MISSING) and before the window asks for new diagnostics.
    const including = s.carryover;
    s.carryover = null;
    if (including) reopenDocuments(s, including);
    s.state = "ready";
    report(s);
    // The open views ask for their diagnostics again — no click, no key (web/src/components/code/lsp-diagnostics.ts).
    if (including) reporter({ type: DIAGNOSTIC_EVENT, projectId: s.projectId, instance: s.identifier, language: s.language });
  } catch (e) { fail(s, e); }
}

// The situation BEFORE a start (header, points 1 and 2) — null means: it may start.
function situationBefore(target) {
  const name = instanceName(target.instance);
  if (name) {
    let row = null;
    try { row = store.projectInstance(String(target.projectId), name); } catch (e) { return { reason: "error", error: T`The instance cannot be read (${e?.message || e})` }; }
    const z = row?.state;
    if (z === "stopped" || z === "stop") return { reason: "stopped", state: "stopped" };
    if (z && z !== "ready") return { reason: "starting", state: "starting" };
  }
  let lock = null;
  try { lock = startLock?.(String(target.projectId), name) || null; } catch { lock = "unreadable"; }
  if (lock) return { reason: "starting", state: "off", lock: String(lock) };
  return null;
}

let cleanTick = null;
function cleanInTick() {
  if (cleanTick) return;
  cleanTick = setInterval(() => cleanEverything(), CLEAN_TICK_MS);
  cleanTick.unref?.();
}

/** Expired buffers (BUFFER_LEASE_MS), code actions (5 min) and tokens of external targets (30 min) — `now` is a test seam. */
export function cleanEverything(now = Date.now()) {
  let n = 0;
  for (const s of sessions.values()) {
    if (s.state === "ready") n += cleanExpired(s, now);
    for (const [id, a] of s.actions) if (now - a.at > ACTION_HOLD_MS) s.actions.delete(id);
  }
  for (const [t, e] of externalFiles) if (now - e.at > EXTERN_HOLD_MS) dropExtern(t);
  return n;
}

/**
 * The READY session for (target, language) — starts it on first use (see the header). Throws `LspNot` with the reason if there
 * is none. `target`: `{ projectId, instance (object | null), root }`.
 */
export async function sessionFor(target, language, { carryover = null } = {}) {
  if (!target?.projectId) throw new LspNot("no_project");
  if (!LANGUAGES.includes(language)) throw new LspNot("no_language");
  const k = keyOf(target, language);
  const situation = situationBefore(target);
  let s = sessions.get(k) || null;
  if (situation) {
    if (s && situation.reason === "stopped") end(s, "stopped");
    throw new LspNot(situation.reason, { language, state: situation.state || "off", ...(situation.error ? { error: situation.error } : {}) });
  }
  if (s && s.root !== path.resolve(String(target.root))) { end(s, "root"); s = null; }
  // The UI language changed — the server still speaks the old one (it is fixed at start); VS Code reloads the window for that.
  if (s && s.locale !== getUiLang() && (s.state === "ready" || s.state === "error")) { end(s, "language"); s = null; }
  if (s && (s.state === "starting" || s.state === "ready")) return readyOf(s, k);
  if (s && s.state === "error" && Date.now() - s.startedAt < RESTART_GAP_MS) {
    throw new LspNot("error", { language, state: "error", error: s.error || "" });
  }
  const entry = entryFor(language);
  if (!entry?.command) {
    situations.set(k, { state: "missing" });
    throw new LspNot("missing", { language, state: "missing" });
  }
  const gate = storageSituation();
  if (!gate.free) {
    const prior = situations.get(k)?.state;
    situations.set(k, { state: "memory", error: gate.reason });
    if (prior !== "memory") reportSituation(target, language, "memory", gate.reason);
    throw new LspNot("memory", { language, state: "memory", error: gate.reason });
  }
  situations.delete(k);
  if (s) sessions.delete(k);
  s = new Session(target, language, k);
  if (Array.isArray(carryover)) s.carryover = carryover;
  sessions.set(k, s);
  cleanInTick();
  s.start = start(s, entry);
  return readyOf(s, k);
}

// The session as soon as it is ready. If it ended intentionally while the request was waiting and its successor is already there
// (the language switch restarts at once — even one that was itself still starting), the request waits for THAT one — at most a
// few switches deep.
async function readyOf(s, k) {
  for (let step = 0; step < 4; step += 1) {
    await s.start;
    if (s.state === "ready") return s;
    const to = sessions.get(k);
    if (!s.intentional || !to || to === s || (to.state !== "starting" && to.state !== "ready")) break;
    s = to;
  }
  throw new LspNot("error", { language: s.language, state: s.state, error: s.error || "" });
}

const openSwitch = []; // the restarts per switch until languageSwitchFinished collects them (at most 16)
/**
 * The UI language changed — every running (or starting) session whose server still speaks the old one restarts AT ONCE, like
 * VS Code, which restarts the app for that: end the old one in order (`shutdown`/`exit`, open requests throw `EEND` immediately),
 * start the new one with the new `locale`/`VSCODE_L10N_BUNDLE_LOCATION`, `didOpen` its documents (with buffer and version as
 * before), then DIAGNOSTIC_EVENT to the windows. A session in the new language stays; one in `error` starts only on the next
 * use (sessionFor). Hooked to `atUiLangSwitch` (below, at load). → the restarts (tests wait for them).
 */
export function languageSwitched() {
  const now = getUiLang();
  const fresh = [];
  const gone = [];
  for (const old of [...sessions.values()]) {
    if (old.locale === now || (old.state !== "ready" && old.state !== "starting")) continue;
    const including = new Map((old.carryover || []).map((d) => [d.uri, d]));
    for (const d of old.documents.values()) including.set(d.uri, carryoverOf(d));
    const target = { projectId: old.projectId, instance: old.instance, root: old.root, ...(old.area ? { area: old.area } : {}) };
    gone.push(end(old, "language", { gentle: true }));
    fresh.push(sessionFor(target, old.language, { carryover: [...including.values()] }).then(
      (s) => s,
      (e) => { console.warn(`[lsp] ${old.key}: restart after the language switch failed — ${e?.body?.reason || e?.message || e}`); return null; },
    ));
  }
  const current = Promise.all([Promise.all(fresh), Promise.all(gone)]).then(([n]) => n);
  openSwitch.push(current);
  if (openSwitch.length > 16) openSwitch.shift(); // in production nobody asks — the list does not grow
  return current;
}
/** Test seam: resolves when every language switch triggered since the last call is through (the new sessions ready or failed,
 *  the old processes gone) — with ALL their results (one session per restart, null for a failed one). */
export function languageSwitchFinished() {
  const list = openSwitch.splice(0);
  return Promise.all(list).then((x) => x.flat());
}
atUiLangSwitch(() => { void languageSwitched(); });

/** The running (ready) session, without starting — or null. */
export function runningSession(target, language) {
  const s = sessions.get(keyOf(target, language));
  return s && s.state === "ready" ? s : null;
}
/** All ready sessions of the same instance (workspace_symbols starts none). */
export function runningSessions(target) {
  const front = `${target.projectId}|${instanceName(target.instance) ?? "-"}|`;
  return [...sessions.values()].filter((s) => s.key.startsWith(front) && s.state === "ready");
}

/** The state per language (`status`) — starts NOTHING. */
export function statusOf(target, languages = LANGUAGES) {
  const situation = situationBefore(target);
  return languages.map((language) => {
    const k = keyOf(target, language);
    const s = sessions.get(k);
    if (situation?.reason === "stopped") return { language, state: "stopped", features: [] };
    if (s) {
      const ctx = language === "python" ? ctxOf(s) : {};
      return {
        language, state: s.state, features: s.state === "ready" ? capabilitiesOf(s) : [],
        ...(s.state === "ready" ? { triggers: triggerOf(s) } : {}),
        ...(s.version ? { version: s.version } : {}), ...(s.error ? { error: s.error } : {}),
        ...(ctx.interpreter ? { interpreter: ctx.interpreter } : {}),
      };
    }
    if (situation?.reason === "starting" && situation.state === "starting") return { language, state: "starting", features: [] };
    const remembered = situations.get(k);
    if (remembered?.state === "memory") return { language, state: "memory", features: [], ...(remembered.error ? { error: remembered.error } : {}) };
    const e = entryFor(language);
    if (!e?.command) return { language, state: "missing", features: [] };
    return { language, state: "off", features: [], ...(e.version ? { version: `${e.pack} ${e.version}` } : {}) };
  });
}

// `gentle` (language switch): a ready server leaves in order (lsp/connection.js farewell — `shutdown`, `exit`, each with a
// deadline); only after that, if it still lives, kill. Open and new requests to it throw at once. Otherwise kill immediately
// (lock, stop, server end). → a promise that resolves once the process is gone (the language switch waits for it).
function end(s, reason, { gentle = false } = {}) {
  s.intentional = true;
  const what = s.state;
  s.state = "off";
  s.documents.clear();
  for (const w of [...s.diagWaiters]) w();
  for (const [t, e] of externalFiles) if (e.key === s.key) dropExtern(t);
  const v = s.v;
  const gone = v?.alive ? new Promise((resolve) => v.atEnd(() => resolve())) : Promise.resolve();
  // Whoever waits for `gone` (the language switch, languageSwitchFinished) waits for the `exit` of the process — and that comes
  // through the process itself, which `start` deliberately keeps from holding the loop (unref; the farewell deadline likewise).
  // Without a hold the event loop was empty in this window, and a test process without an HTTP server ended in the middle of the
  // wait ("Promise resolution is still pending but the event loop has already resolved"). From here on the process ends for
  // certain (SIGKILL at once or after the farewell), so the hold ends too.
  if (v?.alive) s.kind?.ref?.();
  if (gentle && what === "ready" && v?.alive) {
    void v.farewell(T("The language server is restarting (language changed) — repeat the request")).finally(() => kill(s));
  } else kill(s);
  if (sessions.get(s.key) === s) sessions.delete(s.key);
  if (what !== "off") {
    console.log(`[lsp] ${s.key}: ended (${reason})`);
    report(s, reason === "stopped" ? "stopped" : "off");
  }
  return gone;
}

/** `stop`: end until the next use. → whether one was running. */
export function stopSession(target, language) {
  const s = sessions.get(keyOf(target, language));
  situations.delete(keyOf(target, language));
  if (!s) return false;
  end(s, "stop");
  return true;
}
/** `restart`: end and start again at once (also from `error`, without the gap). */
export async function restart(target, language) {
  const k = keyOf(target, language);
  const s = sessions.get(k);
  if (s) end(s, "restart");
  situations.delete(k);
  return sessionFor(target, language);
}

/**
 * End the sessions of a project — `instance` null: all (every instance and without an instance), otherwise only those of that
 * instance (`"main"`, `"copy-<name>"`). The path of the lock, the stop and the layout run (header "THE END"). `language`: only
 * the sessions of that language — a change of the Python interpreter ends only the project's Python servers
 * (lsp/interpreter.js), the next use starts them with the new one. → how many.
 */
export function endSessions(projectId, instance = null, reason = "lock", language = null) {
  const pid = String(projectId ?? "");
  let n = 0;
  for (const s of [...sessions.values()]) {
    if (s.projectId !== pid) continue;
    if (language && s.language !== language) continue;
    if (instance !== null && instance !== undefined && (instanceName(s.instance) ?? "main") !== String(instance)) continue;
    end(s, reason === "stop" ? "stopped" : reason);
    n += 1;
  }
  for (const k of [...situations.keys()]) if (k.startsWith(`${pid}|`) && (!language || k.endsWith(`|${language}`))) situations.delete(k);
  return n;
}
/** At server end (hook "serverEnd") and in tests: every session. → how many. */
export function endAllSessions(reason = "serverEnd") {
  let n = 0;
  for (const s of [...sessions.values()]) { end(s, reason); n += 1; }
  situations.clear();
  externalFiles.clear();
  externIndex.clear();
  return n;
}
/**
 * The process groups of a project's living language servers IN B (without an instance — there the server is the leader of its
 * own group, `detached`). For the process search in the plan of a relocation (projectbox/idle.js languageServiceGroups,
 * connected in server.js).
 */
export function groupsInB(projectId) {
  const pid = String(projectId ?? "");
  return [...sessions.values()]
    .filter((s) => s.projectId === pid && !s.instance && s.kind && s.kind.exitCode === null && s.kind.signalCode === null && Number.isInteger(s.kind.pid))
    .map((s) => s.kind.pid);
}
/** How many server processes are alive right now (tests, the deploy's status line). */
export const sessionsCount = () => [...sessions.values()].filter((s) => s.kind && s.kind.exitCode === null && s.kind.signalCode === null).length;

// ── External targets: B reads only what a server itself named as a target ─────────────────────────────────────────────────────
const externKey = (key, abs) => `${key}\0${abs}`;
function dropExtern(t) {
  const e = externalFiles.get(t);
  if (!e) return;
  externalFiles.delete(t);
  const k = externKey(e.key, e.abs);
  if (externIndex.get(k) === t) externIndex.delete(k);
}
/**
 * A token for a location outside the instance that this session named — valid for EXTERN_HOLD_MS. Looked up through the index
 * (session + path), at most EXTERNAL_CAP at once: `workspace_symbols` names up to 1,000 locations per keystroke. For the editor
 * only — an agent reads a location outside with its own tools and gets no token (lsp/limit.js locationOf).
 */
export function rememberExternal(s, abs) {
  const now = Date.now();
  const k = externKey(s.key, abs);
  const old = externIndex.get(k);
  const e = old ? externalFiles.get(old) : null;
  if (e && now - e.at <= EXTERN_HOLD_MS) {
    e.at = now;
    externalFiles.delete(old); externalFiles.set(old, e); // to the end: the order is that of the last naming
    return old;
  }
  if (old) dropExtern(old);
  const token = crypto.randomBytes(16).toString("hex");
  externalFiles.set(token, { abs, key: s.key, projectId: s.projectId, instanceName: instanceName(s.instance), inst: s.instance, at: now });
  externIndex.set(k, token);
  while (externalFiles.size > EXTERNAL_CAP) dropExtern(externalFiles.keys().next().value);
  return token;
}
/** How many tokens of external targets are valid right now (tests). */
export const externalCount = () => externalFiles.size;
/** The named target for a token — only for the same project and the same instance, only while it is valid; otherwise null. */
export function externalTarget(target, token) {
  const e = typeof token === "string" ? externalFiles.get(token) : null;
  if (!e || Date.now() - e.at > EXTERN_HOLD_MS) return null;
  if (e.projectId !== String(target.projectId) || e.instanceName !== instanceName(target.instance)) return null;
  return e;
}
