// The seam of the language service (editor navigation like VS Code): backend and web on ONE sheet.
//
// `server/backend/electron/server/lsp/contract.js` (a sheet without imports) carries the lists the server computes with: languages,
// suffixes, states, reasons, capabilities, editor actions, formatters, interpreter sources, error codes, the event and the deadlines.
// Here is the web half:
//   (a) EXECUTED: `web/src/lib/api/lsp.ts` (compiled without tsconfig) exports for EVERY constant of the contract its counterpart with
//       the same value (ASSIGNMENT) — or it is named in NOT_IN_WEB (with a reason). A new constant in the contract without either
//       is red, as is an entry here that the contract does not (any longer) have.
//   (b) READ: the response forms `LspResponses` in lib/api/lsp.ts name EXACTLY the editor actions of the contract (an action without form
//       or a form without action is red); every action the web source sends to the server (`questions`/`questionBuffer`/`lspQuestion`/
//       `lspCalls` with a literal) is in the contract; so is every capability it asks for (`can(…, "x")`, `needs: "x"`, `.has("x")` on
//       features). The address is `<apiBase>/lsp/<action>` with `?instance=` only for an instance.
//   (c) Built-in sabotage on in-memory copies: a contract with a new state, one with a constant without counterpart, a web without
//       ".pyi", a response form with a misspelled name, a call of an action that does not exist — each => deviation.
//
// Counter-test: `LSP_STATES` without "missing" in lib/api/lsp.ts => (a) red ("STATES").
//
// Run:  node --test --test-reporter=tap web/test/lsp-binding.test.mjs
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as V from "../../server/backend/electron/server/lsp/contract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const src = (...p) => path.join(webDir, "src", ...p);
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (p) => fs.readFileSync(p, "utf8");
const SOURCE = read(src("lib", "api", "lsp.ts"));

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });

let web = null;
async function loadWeb() {
  if (web) return web;
  assert.ok(fs.existsSync(tsc), "web/node_modules missing (tsc) — the binding cannot be checked without a compiler");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-lsp-binding-"));
  execFileSync(process.execPath, [
    tsc, src("lib", "api", "lsp.ts"),
    "--outDir", tmp, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom",
  ], { cwd: webDir, stdio: "pipe" });
  web = await import(pathToFileURL(path.join(tmp, "lsp.js")).href);
  return web;
}
async function loadWebSabotaged(change) {
  await loadWeb();
  const ts = createRequire(path.join(webDir, "package.json"))("typescript");
  const js = ts.transpileModule(change(SOURCE), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  const file = path.join(tmp, `lsp-sabotage-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, js);
  return import(pathToFileURL(file).href);
}

/** Constant of the contract → its counterpart on the web. */
const ASSIGNMENT = Object.freeze({
  LANGUAGES: "LSP_LANGUAGES",
  SUFFIXES: "LSP_SUFFIXES",
  STATES: "LSP_STATES",
  REASONS: "LSP_REASONS",
  CAPABILITIES: "LSP_CAPABILITIES",
  EDITOR_ACTIONS: "LSP_EDITOR_ACTIONS",
  FORMATTER: "LSP_FORMATTER",
  INTERPRETER_SOURCES: "LSP_INTERPRETER_SOURCES",
  CODES: "LSP_CODES",
  STATUS_EVENT: "LSP_STATUS_EVENT",
  SEMANTICS_EVENT: "LSP_SEMANTICS_EVENT",
  DIAGNOSTIC_EVENT: "LSP_DIAGNOSTIC_EVENT",
  SUGGESTION_COMMANDS: "LSP_SUGGESTION_COMMANDS",
  BUFFER_LEASE_MS: "LSP_BUFFER_LEASE_MS",
  DIAGNOSTICS_WAIT_MS: "LSP_DIAGNOSTICS_WAIT_MS",
  REQUEST_DEADLINE_MS: "LSP_REQUEST_DEADLINE_MS",
});
/** Constants the web deliberately does not mirror — with a reason. */
const NOT_IN_WEB = Object.freeze({
  AGENT_READ: "agents only (POST /api/lsp, MCP cbase_lsp) — the web never calls this shell",
  AGENT_CHANGE: "agents only (MCP cbase_lsp_edit) — the web writes through its buffers, never through the agent shell",
});

const raw = (x) => JSON.parse(JSON.stringify(x));
function deviationsA(contract, w) {
  const out = [];
  for (const k of Object.keys(contract)) {
    if (k in NOT_IN_WEB) continue;
    const target = ASSIGNMENT[k];
    if (!target) { out.push(`${k}: neither assigned nor named as an exception`); continue; }
    if (!(target in w)) { out.push(`${k}: the web does not export ${target}`); continue; }
    try { assert.deepEqual(raw(w[target]), raw(contract[k])); } catch { out.push(`${k}: ${JSON.stringify(w[target])} ≠ ${JSON.stringify(contract[k])}`); }
  }
  for (const k of [...Object.keys(ASSIGNMENT), ...Object.keys(NOT_IN_WEB)]) if (!(k in contract)) out.push(`${k}: is here, but not (any longer) in the contract`);
  return out;
}

/** The keys of the type `LspResponses` (the response forms per action). */
function responseForms(source) {
  const m = /export type LspResponses = \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(m, "lib/api/lsp.ts: `export type LspResponses = { … };` not found (anchor stale)");
  return [...m[1].matchAll(/^\s{2}([a-z_]+):/gm)].map((x) => x[1]);
}
function deviationsB(source, contract) {
  const forms = responseForms(source);
  const out = [];
  for (const a of contract.EDITOR_ACTIONS) if (!forms.includes(a)) out.push(`action ${a} without response form`);
  for (const f of forms) if (!contract.EDITOR_ACTIONS.includes(f)) out.push(`response form ${f} without action in the contract`);
  return out;
}

// The web source that calls the language service: lib/ and components/code/ and CodePane.
function webSources() {
  const files = [src("components", "CodePane.tsx"), src("lib", "lsp-status.ts"), src("lib", "lsp-change.ts"), src("lib", "editor-commands.ts")];
  for (const f of fs.readdirSync(src("components", "code"))) if (/^(lsp-|Lsp|EditorMenu)/.test(f)) files.push(src("components", "code", f));
  return Object.fromEntries(files.map((d) => [path.relative(webDir, d), read(d)]));
}
const CALL = /\b(?:questions|questionBuffer|lspQuestion|lspCalls)\([^,()]+(?:\([^()]*\))?[^,()]*,\s*"([a-z_]+)"/g;
const CAPABILITY = /\bcan\([^,()]+,\s*"([a-z_]+)"\)|\bneeds:\s*"([a-z_]+)"|(?:features|Features\([^)]*\))\.has\("([a-z_]+)"\)/g;
function deviationsC(sources, contract) {
  const out = [];
  let calls = 0, capable = 0;
  for (const [file, q] of Object.entries(sources)) {
    for (const m of q.matchAll(CALL)) { calls += 1; if (!contract.EDITOR_ACTIONS.includes(m[1])) out.push(`${file}: action "${m[1]}" is not in the contract`); }
    for (const m of q.matchAll(CAPABILITY)) { capable += 1; const f = m[1] ?? m[2] ?? m[3]; if (!contract.CAPABILITIES.includes(f)) out.push(`${file}: capability "${f}" is not in the contract`); }
  }
  return { out, calls, capable };
}

test("(a) every constant of the contract has its counterpart in lib/api/lsp.ts (or a named reason)", async () => {
  const w = await loadWeb();
  assert.deepEqual(deviationsA(V, w), []);
  // The address: <apiBase>/lsp/<action>, the instance only if there is one.
  assert.equal(w.lspPath({ apiBase: "/api/projects/p1", instance: null }, "hover"), "/api/projects/p1/lsp/hover");
  assert.equal(w.lspPath({ apiBase: "/api/projects/p1", instance: "p1/copy-k1" }, "rename"), "/api/projects/p1/lsp/rename?instance=p1%2Fcopy-k1");
  // Every suffix of the contract arrives at its language, a foreign one at none.
  for (const [suffix, [language, id]] of Object.entries(V.SUFFIXES)) assert.deepEqual(w.lspLanguageOf(`a/b/file${suffix.toUpperCase()}`), { language, languageId: id });
  assert.equal(w.lspLanguageOf("a/b.vue"), null);
  assert.equal(w.lspLanguageOf("Makefile"), null);
});

test("(b) the response forms name exactly the editor actions; the web source calls only actions and asks only capabilities of the contract", () => {
  assert.deepEqual(deviationsB(SOURCE, V), []);
  const { out, calls, capable } = deviationsC(webSources(), V);
  assert.deepEqual(out, []);
  // The anchor matches at all (an empty set would be a silent promise).
  assert.ok(calls >= 10, `only ${calls} calls found — the anchor is stale`);
  assert.ok(capable >= 8, `only ${capable} capabilities found — the anchor is stale`);
  console.log(`# measurement: ${calls} calls, ${capable} capability queries held against the contract`);
});

test("(c) sabotage: every deviation is caught", async () => {
  // The contract gains a state.
  assert.ok(deviationsA({ ...V, STATES: [...V.STATES, "paused"] }, await loadWeb()).some((x) => x.startsWith("STATES:")));
  // The contract gains a constant without counterpart.
  assert.ok(deviationsA({ ...V, NEW_LIST: ["x"] }, await loadWeb()).some((x) => x.startsWith("NEW_LIST:")));
  // The contract loses an excepted constant.
  const { AGENT_CHANGE: _dropped, ...without } = V;
  assert.ok(deviationsA(without, await loadWeb()).some((x) => x.startsWith("AGENT_CHANGE:")));
  // The web loses ".pyi".
  const old = `".py": ["python", "python"], ".pyi": ["python", "python"],`;
  assert.equal(SOURCE.split(old).length - 1, 1, "sabotage place \".pyi\" does not occur exactly once (stale)");
  const s1 = await loadWebSabotaged((q) => q.replace(old, `".py": ["python", "python"],`));
  assert.ok(deviationsA(V, s1).some((x) => x.startsWith("SUFFIXES:")));
  // A response form with a misspelled name.
  assert.equal(SOURCE.split("  code_action_apply: {").length - 1, 1);
  assert.ok(deviationsB(SOURCE.replace("  code_action_apply: {", "  code_actions_apply: {"), V).length >= 2);
  // A call of an action that does not exist, and a capability that does not exist.
  const q = { "x.ts": `await questions(d, "goto_definition", {}); if (can(d, "peek")) {}` };
  assert.deepEqual(deviationsC(q, V).out, ["x.ts: action \"goto_definition\" is not in the contract", "x.ts: capability \"peek\" is not in the contract"]);
});
