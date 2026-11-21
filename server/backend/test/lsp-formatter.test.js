// Formatter and Python interpreter of the language service (lsp/formatter.js and lsp/interpreter.js, registered as in server.js:
// setFormatter, setStatusAddition, setInterpreterSupplier, setInterpreterMachine) in the test process, against the fake language
// server (test/fake-lsp.mjs) and FAKE programs (Prettier, ruff, black, python as shell scripts that log their arguments). Without
// an instance they run in B (lsp/run.js via inProject with null) — the path in the project container is the same call with an
// instance (in-project-start-places.test.js holds the spot).
//   (1) Prettier: the nearest `node_modules/.bin/prettier` from the file upward, `--stdin-filepath`, ONE edit over the whole
//       document; with a range `--range-start/--range-end`; the status names `formatter: "prettier"`; an agent formats through it to disk
//   (2) a failing formatter => 400 with its message, no silent fallback to the server
//   (3) Python: ruff before black, searched in the bin/ of the effective interpreter and in the venvs of the file
//   (4) Python without ruff/black and without a format from the server => `format` missing from `features`, `format` => { supported: false }
//   (5) Interpreter: detection down to depth 3, choice only at project level, only a Python executable in the container (else 400,
//       nothing stored), a switch ends the Python sessions and the next start gets the new one (`python.pythonPath`)
//   (6) detection runs synchronously in B — it reads at most ENTRY_CAP entries per folder (opendir), at most ENTRIES_TOTAL overall,
//       and finds `.venv`/`venv` directly (a full folder does not hide them)
// Counter-tests (ONE sabotage each, the whole file run): folderUpward without the folders between file and root (root only) => (1) red;
// statusAddition always includes `format` => (4) red; interpreterAction without endSessions on a switch => (5) red; ruff and black
// swapped => (3) red; projectFormatter without the throw on exit != 0 => (2) red; venvsIn without ENTRY_CAP in the read loop => (6) red.
//
// Run (from server/backend/): CBASE_EMBED_OFFLINE=1 node --test test/lsp-formatter.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as store from "../electron/server/store.js";
import { setLspTable } from "../electron/server/lsp/table.js";
import { endAllSessions, setInterpreterSupplier, sessionsCount } from "../electron/server/lsp/sessions.js";
import { lspEditorResponse } from "../electron/server/lsp/routes.js";
import { setFormatter, setInterpreterMachine, setStatusAddition } from "../electron/server/lsp/actions.js";
import { agentAction } from "../electron/server/lsp/agents.js";
import { projectFormatter, statusAddition } from "../electron/server/lsp/formatter.js";
import { ENTRIES_TOTAL, ENTRY_CAP, settingOf, interpreterAction, interpreterFor, venvsIn, forgetDetection } from "../electron/server/lsp/interpreter.js";
import { FORMATTER, INTERPRETER_SOURCES } from "../electron/server/lsp/contract.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fake-lsp.mjs");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-lsp-formatter-")));
const data = path.join(root, "data");
const project = path.join(root, "proj");
const empty = path.join(root, "empty");
const SCENARIO = path.join(root, "scenario-ts.json");
const SCENARIO_PY = path.join(root, "scenario-py.json");
const LOG = path.join(root, "lsp.jsonl");
const FMT_LOG = path.join(root, "fmt.log");
for (const d of [data, project, empty]) fs.mkdirSync(d, { recursive: true });
store.initStore(data);
process.env.FAKE_LSP_LOG = LOG;
fs.writeFileSync(SCENARIO, "{}");
fs.writeFileSync(SCENARIO_PY, "{}");
setLspTable({
  ts: { command: [process.execPath, FAKE, "--scenario", SCENARIO] },
  python: { command: [process.execPath, FAKE, "--scenario", SCENARIO_PY, "--language", "python"] },
});
setFormatter(projectFormatter);
setStatusAddition(statusAddition);
setInterpreterSupplier(interpreterFor);
setInterpreterMachine(interpreterAction);

// A fake program: logs `<name> <arguments>` and returns stdin transformed.
function program(p, name, body) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> '${FMT_LOG}'\n${body}\n`, { mode: 0o755 });
  return p;
}
const python = (p, version = "3.12.1") => program(p, "python", `echo ${version}`);
const fmtLog = () => (fs.existsSync(FMT_LOG) ? fs.readFileSync(FMT_LOG, "utf8").trim().split("\n").filter((z) => !z.startsWith("python ")) : []);
const lspLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((z) => JSON.parse(z)) : []);

// Target and editor as in the core (lsp-core.test.js): project level, no instance.
const targetIn = (rootDir, projectId) => (file, base = rootDir) => (file ? { projectId, instance: null, root: rootDir, base, abs: path.join(rootDir, file) } : { projectId, instance: null, root: rootDir, base });
const P = targetIn(project, "p1");
const L = targetIn(empty, "p2");
const ed = (z, action, body = {}) => lspEditorResponse(action, body, (f) => z(f));
let buffer = 0;
const withBuffer = (file, text, extra = {}) => ({ file, buffer: `b${++buffer}`, version: 1, text, ...extra });

test.after(() => {
  endAllSessions("test");
  setLspTable(null);
  setFormatter(null);
  setStatusAddition(null);
  setInterpreterSupplier(null);
  setInterpreterMachine(null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("(1) Prettier: the nearest from the file upward, --stdin-filepath, ONE edit over the document; range; status; agent writes", async () => {
  program(path.join(project, "node_modules", ".bin", "prettier"), "prettier-root", "tr 'a-z' 'A-Z'");
  program(path.join(project, "web", "node_modules", ".bin", "prettier"), "prettier-web", "tr 'a-z' 'A-Z' | sed 's/^/WEB:/'");
  fs.mkdirSync(path.join(project, "web", "src"), { recursive: true });
  const text = "const a = 1;\nconst b = 2;\n";
  let r = await ed(P, "format", withBuffer("web/src/x.ts", text));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }, newText: "WEB:CONST A = 1;\nWEB:CONST B = 2;\n" }], formatter: "prettier" });
  assert.deepEqual(fmtLog().at(-1), `prettier-web --stdin-filepath ${path.join(project, "web", "src", "x.ts")}`);
  // Outside web/ the one at the root applies.
  r = await ed(P, "format", withBuffer("y.ts", text));
  assert.equal(r.body.edits[0].newText, "CONST A = 1;\nCONST B = 2;\n");
  assert.match(fmtLog().at(-1), /^prettier-root /);
  // A range goes along as UTF-16 offsets.
  r = await ed(P, "format", withBuffer("y.ts", text, { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 12 } } }));
  assert.equal(r.status, 200);
  assert.equal(fmtLog().at(-1), `prettier-root --stdin-filepath ${path.join(project, "y.ts")} --range-start 13 --range-end 25`);
  // Nothing to do => no edits.
  r = await ed(P, "format", withBuffer("y.ts", "ALREADY UPPER\n"));
  assert.deepEqual(r.body, { edits: [], formatter: "prettier" });
  // The status names the formatter (the session is already running).
  const st = await ed(P, "status", { file: "web/src/x.ts" });
  assert.deepEqual(st.body.languages.map((l) => [l.language, l.state, l.formatter, l.features.includes("format")]), [["ts", "ready", "prettier", true]]);
  // An agent (cbase_lsp_edit format): through the same formatter to disk.
  const file = path.join(project, "web", "src", "agent.ts");
  fs.writeFileSync(file, "let z = 3;\n");
  assert.deepEqual(await agentAction("format", { projectId: "p1", instance: null, root: project, base: null, abs: file }), { changed: [file], formatter: "prettier" });
  assert.equal(fs.readFileSync(file, "utf8"), "WEB:LET Z = 3;\n");
  assert.ok(FORMATTER.includes("prettier"));
});

test("(2) a failing formatter => 400 with its message, no fallback to the server", async () => {
  const p = path.join(project, "broken", "node_modules", ".bin", "prettier");
  program(p, "prettier-broken", "cat > /dev/null; echo 'SyntaxError: Unexpected token (1:7)' >&2; exit 2");
  fs.mkdirSync(path.join(project, "broken"), { recursive: true });
  const prior = lspLog().filter((x) => x.m === "textDocument/formatting").length;
  const r = await ed(P, "format", withBuffer("broken/z.ts", "const = ;\n"));
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.error, "prettier: SyntaxError: Unexpected token (1:7)");
  assert.equal(lspLog().filter((x) => x.m === "textDocument/formatting").length, prior, "the server did not format instead");
  fs.rmSync(path.join(project, "broken"), { recursive: true, force: true });
});

test("(3) Python: ruff before black — in the interpreter's bin/, then in the file's venvs", async () => {
  forgetDetection();
  python(path.join(project, ".venv", "bin", "python"));
  program(path.join(project, ".venv", "bin", "black"), "black", "sed 's/^/BLACK:/'");
  python(path.join(project, "svc", ".venv", "bin", "python"));
  program(path.join(project, "svc", ".venv", "bin", "ruff"), "ruff", "sed 's/^/RUFF:/'");
  // Root: the interpreter is .venv (shallowest venv) — only black there.
  let r = await ed(P, "format", withBuffer("y.py", "x=1\n"));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, newText: "BLACK:x=1\n" }], formatter: "black" });
  assert.equal(fmtLog().at(-1), `black -q --stdin-filename ${path.join(project, "y.py")} -`);
  // svc/: ruff from the file's venv takes precedence over black in the interpreter's bin/.
  r = await ed(P, "format", withBuffer("svc/z.py", "x=1\ny=2\n", { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } }));
  assert.equal(r.body.formatter, "ruff", JSON.stringify(r.body));
  assert.equal(fmtLog().at(-1), `ruff format --stdin-filename ${path.join(project, "svc", "z.py")} --range=2:1-2:4 -`);
  const st = await ed(P, "status", { file: "svc/z.py" });
  assert.deepEqual(st.body.languages.map((l) => [l.language, l.formatter, l.interpreter]), [["python", "ruff", path.join(project, ".venv", "bin", "python")]]);
});

test("(4) Python without ruff/black and without a format from the server => no `format` in features, format => supported:false", async () => {
  fs.writeFileSync(SCENARIO_PY, JSON.stringify({ without: ["documentFormattingProvider"] }));
  try {
    let r = await ed(L, "diagnostics", withBuffer("a.py", "x = 1\n"));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const st = await ed(L, "status", { file: "a.py" });
    const py = st.body.languages[0];
    assert.equal(py.state, "ready");
    assert.equal(py.features.includes("format"), false, JSON.stringify(py));
    assert.equal(py.formatter, undefined, JSON.stringify(py));
    r = await ed(L, "format", withBuffer("a.py", "x = 1\n"));
    assert.deepEqual(r, { status: 200, body: { supported: false, reason: "missing" } });
  } finally { fs.writeFileSync(SCENARIO_PY, "{}"); endAllSessions("test"); }
  // If the server can format, the status names it.
  await ed(L, "diagnostics", withBuffer("a.py", "x = 1\n"));
  const py = (await ed(L, "status", { file: "a.py" })).body.languages[0];
  assert.deepEqual([py.features.includes("format"), py.formatter], [true, "server"]);
});

test("(5) interpreter: detection down to depth 3, choice only at project level and only executable, a switch restarts the Python servers", async () => {
  forgetDetection();
  python(path.join(project, "a", "b", ".venv", "bin", "python"), "3.11.0");
  python(path.join(project, "a", "b", "c", ".venv", "bin", "python"), "3.10.0");
  const auto = path.join(project, ".venv", "bin", "python");
  let r = await ed(P, "interpreter", {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.selected, null);
  assert.equal(r.body.effective, auto);
  const venvs = r.body.candidates.filter((c) => c.source === "venv");
  assert.deepEqual(venvs.map((c) => [path.relative(project, c.path), c.version]), [[".venv/bin/python", "3.12.1"], ["svc/.venv/bin/python", "3.12.1"], ["a/b/.venv/bin/python", "3.11.0"]], "a/b/c/.venv is deeper than 3");
  assert.ok(r.body.candidates.every((c) => INTERPRETER_SOURCES.includes(c.source)), JSON.stringify(r.body.candidates));
  // Only at project level, only absolute, only executable — else 400 and nothing stored.
  const selected = python(path.join(root, "tool", "bin", "python3"), "3.13.2");
  r = await ed((f) => P(f, path.join(project, "svc")), "interpreter", { set: selected });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  for (const wrong of ["python3", "/not/there/python", path.join(project, "y.py")]) {
    r = await ed(P, "interpreter", { set: wrong });
    assert.equal(r.status, 400, `${wrong}: ${JSON.stringify(r.body)}`);
  }
  assert.equal(store.getSetting(settingOf("p1"), ""), "", "nothing stored");
  // A running Python session got the automatic one.
  await ed(P, "diagnostics", withBuffer("y.py", "x = 1\n"));
  await ed(P, "diagnostics", withBuffer("y.ts", "const x = 1;\n"));
  const pathsToServer = () => lspLog().filter((x) => x.language === "python" && x.response === "workspace/configuration").map((x) => x.result?.[1]?.pythonPath ?? null);
  assert.equal(pathsToServer().at(-1), auto);
  const sessions = sessionsCount();
  r = await ed(P, "interpreter", { set: selected });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.selected, r.body.effective], [selected, selected]);
  assert.deepEqual(r.body.candidates.find((c) => c.path === selected), { path: selected, version: "3.13.2", source: "chosen" });
  assert.equal(store.getSetting(settingOf("p1"), ""), selected, "stored per project");
  assert.equal(sessionsCount(), sessions - 1, "only the Python session ended, TypeScript kept running");
  // The next use starts the Python server with the choice; status and formatter search follow it.
  await ed(P, "diagnostics", withBuffer("y.py", "x = 1\n"));
  assert.equal(pathsToServer().at(-1), selected);
  assert.equal((await ed(P, "status", { file: "y.py" })).body.languages[0].interpreter, selected);
  // Back to automatic.
  r = await ed(P, "interpreter", { set: null });
  assert.deepEqual([r.body.selected, r.body.effective], [null, auto]);
  assert.equal(store.getSetting(settingOf("p1"), ""), "");
});

test("(6) detection reads at most ENTRY_CAP entries per folder and still finds .venv/venv", () => {
  const w = path.join(root, "many");
  const full = path.join(w, "full");
  for (let i = 0; i < ENTRY_CAP + 50; i++) fs.mkdirSync(path.join(full, `d${String(i).padStart(5, "0")}`), { recursive: true });
  python(path.join(full, "venv", "bin", "python"));
  python(path.join(w, ".venv", "bin", "python"));
  const read = new Map();
  const real = fs.opendirSync;
  fs.opendirSync = (p, ...rest) => {
    const d = real.call(fs, p, ...rest);
    const read2 = d.readSync.bind(d);
    d.readSync = () => { const e = read2(); if (e) read.set(p, (read.get(p) || 0) + 1); return e; };
    return d;
  };
  let v;
  try { v = venvsIn(w); } finally { fs.opendirSync = real; }
  assert.deepEqual(v.map((x) => path.relative(w, x.python)), [".venv/bin/python", "full/venv/bin/python"]);
  assert.ok(read.get(full) > 0, "detection did not read the full folder via opendir");
  assert.ok(read.get(full) <= ENTRY_CAP, `${read.get(full)} entries read from one folder (cap ${ENTRY_CAP})`);
  assert.ok([...read.values()].reduce((a, b) => a + b, 0) <= ENTRIES_TOTAL);
  fs.rmSync(w, { recursive: true, force: true });
});
