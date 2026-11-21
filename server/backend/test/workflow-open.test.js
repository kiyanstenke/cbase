// The notion "open" of a workflow run, and the guard against spelling it out again.
//
// Defect: two tests in wait-row-lifecycle.test.js failed on the same line, `assert.equal(wait.workflow,
// true)`. The wait row carried `kind: "judge"` but `workflow: false`. Behind it was no flakiness but a
// double truth in the product: the flag was computed as `store.getWorkflowRun(chat.id)?.status ===
// "running"` in TWO places (runs/limit-gate.js, runs/auto-continue.js), while the rest of the tree asked
// the same question in three other spellings: `["running", "waiting"].includes(status)`,
// `status === "running" || status === "waiting"` and as SQL `status IN ('running','waiting')`. The
// question is the same everywhere: IS THE RUN STILL OPEN? And the answer of the first two was wrong,
// because a verdict on a cap or review answer is parked WHILE the run stands on `waiting`
// (workflows/gates.js, answerCap: the run stays "waiting" with the same open question). The flag is
// computed when WRITING and persisted; a row marked wrongly once never heals.
//
// The notion therefore stands ONCE, in store/workflows.js (`WORKFLOW_OPEN`, `workflowOpen`,
// `workflowOpenFor`, `workflowOpenSql`). This file holds both:
//   1. the guard: no place under electron/server/ asks past the notion; the exceptions are NAMED with
//      a reason and a follow-up, printed on every run, and the list may only shrink (shape: CYCLES_ALLOWED
//      in server/backend/test/import-direction.test.js).
//   2. the counter-test on the product: a cap verdict parked at the limit WHILE the run stands on
//      "waiting".
//
// Counter-test map: with the flag computed as "running" again, the third test is red at
// `wait.workflow`; a new copy of the question or of the status set turns the first test red (the
// second test pins the shapes it must catch).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startServer } from "../electron/server/server.js";
import { RIPCORD } from "./ripcord.mjs";
import { waitForQuiet } from "./quiet.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(HERE, "../electron/server");

// ── 1. The guard ──────────────────────────────────────────────────────────────────────────────

// What the guard looks for, in two kinds:
//   A = the direct question on the run (`getWorkflowRun(...)?.status === "running"`), exactly the spelling
//       that was wrong. It is not ALWAYS wrong, hence the exception list.
//   B = the transcript of the notion itself: the status set as a literal, in JS as in SQL.
const PATTERN_A = /getWorkflowRun\s*\([^)]*\)\s*\?\.\s*status\s*(===|!==)\s*"running"/g;
const PATTERN_B = [
  /\[\s*"running"\s*,\s*"waiting"\s*\]/g,
  /status\s*===\s*"running"\s*\|\|[^\n]*?"waiting"/g,
  /IN\s*\(\s*'running'\s*,\s*'waiting'\s*\)/g,
];

// A comment is no place. This file and store/workflows.js EXPLAIN the trap and write it down literally;
// without this cut the guard would report its own justification as a violation (`tools/check/lib/
// tree-rules.mjs` reads statically too, and an import in a comment is no edge).
//
// ONLY comments are removed; strings and template literals stay, because the SQL stands in them. A `/`
// outside a comment is read as an ordinary character; a regular expression containing `//` or `/*`
// would have to escape them.
export function withoutComments(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i += 1;
      while (i < n) {
        const d = text[i];
        out += d;
        i += 1;
        if (d === "\\") { if (i < n) { out += text[i]; i += 1; } continue; }
        if (d === c) break;
      }
      continue;
    }
    if (c === "/" && text[i + 1] === "/") { while (i < n && text[i] !== "\n") i += 1; continue; }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      out += " ";
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Counts the places of both kinds per file, on the COMMENT-FREE text.
 * @param {{path: string, text: string}[]} files
 * @returns {Map<string, {a: number, b: number}>}  only files with at least one hit
 */
export function places(files) {
  const hits = new Map();
  for (const f of files) {
    const code = withoutComments(f.text);
    const a = (code.match(PATTERN_A) || []).length;
    const b = PATTERN_B.reduce((n, re) => n + (code.match(re) || []).length, 0);
    if (a || b) hits.set(f.path, { a, b });
  }
  return hits;
}

// The exceptions. Each stands here because it was read INDIVIDUALLY and asks a DIFFERENT question than
// "is the run open?", or because it is the notion itself. `a`/`b` are the maximum counts allowed per
// kind: more is a new copy, fewer an entry that stands too wide (and so silently allowed growing back).
const EXCEPTIONS = [
  {
    file: "runs/do-run.js", a: 1, b: 0,
    reason: "`workflowRunning` asks: DOES A WORKFLOW DRIVER ADVANCE NOW? That is so only for `running`; `workflowGateAfterRun` bails out at once for any other status. If \"open\" were meant here, a free turn in a waiting workflow chat would get no target gate any more.",
    followUpJob: "none (stays: another question, not the same)",
  },
  {
    file: "runs/auto-continue.js", a: 1, b: 0,
    reason: "`runInputsRestartGrace` asks: DOES THE CHAT BELONG TO ITS DRIVER? Only then would a turn of its own be a second run. A WAITING run explicitly gets the queued entry as its answer (startFollowUpRun); the justification stands above the loop.",
    followUpJob: "none (stays: another question, not the same)",
  },
  {
    file: "projectbox/idle.js", a: 1, b: 0,
    reason: "On the transition to `ready`, `wakeProject` asks the same question as `runInputsRestartGrace`, with the same conditions: DOES THE CHAT BELONG TO ITS DRIVER? Only a `running` run drives itself on (then a turn of its own would be a second run); a WAITING one gets the queued entry as its answer (startFollowUpRun). The idle check of the same file asks \"open\" instead, via `openWork` and `workflowOpenFor`.",
    followUpJob: "none (stays: another question, not the same)",
  },
  {
    file: "workflows/driver.js", a: 2, b: 0,
    reason: "`workflowDismissedHook` and `workflowContinueHook` both ask: IS ANYONE STILL DRIVING IT? A `waiting` run waits for a HUMAN, so it is neither a zombie (which the first would have to close) nor to be continued (which the second would do); neither may touch it.",
    followUpJob: "none (stays: another question, not the same)",
  },
  {
    file: "workflows/gates.js", a: 1, b: 0,
    reason: "`workflowAbandonedHook` asks the same as the driver: a run given up after `attempts` resumptions is a zombie only if a DRIVER would have to advance it. A `waiting` run waits for a human and may keep waiting.",
    followUpJob: "none (stays: another question, not the same)",
  },
  {
    file: "workflows/graph-message.js", a: 1, b: 0,
    reason: "`nodeTurnRunning` asks: MAY A MESSAGE GO INTO THE RUNNING NODE TURN NOW? Only for `running`; at a `waiting` run a gate waits for the human, and a message into the turn or the queue would become the gate answer there; it is noted instead.",
    followUpJob: "none (stays: another question, not the same)",
  },
  {
    file: "store/workflows.js", a: 0, b: 1,
    reason: "The notion ITSELF: `const WORKFLOW_OPEN = [\"running\", \"waiting\"]`. The status set has to stand somewhere once; this is the line that knows it.",
    followUpJob: "none (stays: the source)",
  },
  {
    file: "store/db.js", a: 0, b: 1,
    reason: "A one-time SCHEMA MIGRATION (`workflow_runs_old` to `workflow_runs`, backfilling `ended_at`). It describes a historical state and is frozen; store/workflows.js imports the file, so an edge back would be an import cycle.",
    followUpJob: "none (stays; a status set as a leaf of its own UNDER db.js would be an intermediate layer saving a single line)",
  },
];

/**
 * Both directions: a place without an entry is NEW, an entry without a place is to be removed, and an
 * entry that allows more than stands there silently allows growing back.
 * @param {Map<string, {a: number, b: number}>} hits
 * @param {{file: string, a: number, b: number}[]} list
 * @returns {string[]}
 */
export function violations(hits, list) {
  const out = [];
  const allowed = new Map(list.map((e) => [e.file, e]));
  for (const [file, t] of [...hits].sort()) {
    const e = allowed.get(file);
    if (!e) { out.push(`NEW ${file}: A=${t.a} B=${t.b} — no entry in EXCEPTIONS. Route the place through store.workflowOpen/workflowOpenFor, or enter it WITH A REASON.`); continue; }
    if (t.a > e.a || t.b > e.b) out.push(`GREW ${file}: A=${t.a} B=${t.b}, allowed A=${e.a} B=${e.b} — a place was added.`);
  }
  for (const e of list) {
    const t = hits.get(e.file);
    if (!t) { out.push(`Entry ${e.file} has no place any more — remove it.`); continue; }
    if (t.a < e.a || t.b < e.b) out.push(`SHRUNK ${e.file}: A=${t.a} B=${t.b}, entry allows A=${e.a} B=${e.b} — follow up on the entry, otherwise it silently grows back.`);
  }
  return out;
}

function serverFiles() {
  return fs.readdirSync(SERVER_DIR, { recursive: true })
    .map((p) => String(p).split(path.sep).join("/"))
    .filter((p) => p.endsWith(".js") && !p.split("/").includes("node_modules"))
    .sort()
    .map((p) => ({ path: p, text: fs.readFileSync(path.join(SERVER_DIR, p), "utf8") }));
}

test("\"open\" stands once: no place under electron/server/ asks past the notion", (t) => {
  const files = serverFiles();
  assert.ok(files.some((f) => f.path === "store/workflows.js"), "store/workflows.js is missing in the tree; wrong directory?");
  const hits = places(files);
  // Printed on EVERY run: a silent exception list cannot be told from a forgotten one. And the NUMBERS
  // stand here, not in the test title; a number in the title ages silently.
  for (const e of EXCEPTIONS) {
    t.diagnostic(`exception ${e.file} (A=${e.a} B=${e.b}): ${e.reason} FOLLOW-UP: ${e.followUpJob}`);
  }
  const sum = [...hits.values()].reduce((s, x) => ({ a: s.a + x.a, b: s.b + x.b }), { a: 0, b: 0 });
  t.diagnostic(`measured: ${sum.a} direct questions (A) and ${sum.b} transcripts of the status set (B) in ${hits.size} of ${files.length} files`);
  const out = violations(hits, EXCEPTIONS);
  assert.deepEqual(out, [], `The notion "open" is spelled out again:\n  ${out.join("\n  ")}`);
});

// What the guard does NOT see, explicitly: the question over an already read row
// (`const run = store.getWorkflowRun(x); ... run.status === "running"`). It stands in a good dozen
// places and is right almost everywhere; a pattern for it would have an exception list longer than
// the rule. What is caught is the spelling in which the error arose, and the transcript of the status
// set: the two that create a COPY.
test("Counter-test: a new copy is noticed, and so is an entry without a place", () => {
  const file = (p, ...rows) => ({ path: p, text: `${rows.join("\n")}\n` });
  const source = file("store/workflows.js", 'const WORKFLOW_OPEN = ["running", "waiting"];');
  const list = [{ file: "store/workflows.js", a: 0, b: 1, reason: "counter-test", followUpJob: "counter-test" }];
  assert.deepEqual(violations(places([source]), list), []);

  // (a) A new direct question in a file that is not in the list.
  const newA = [source, file("runs/fresh.js", 'const x = store.getWorkflowRun(chat.id)?.status === "running";')];
  const a = violations(places(newA), list);
  assert.equal(a.length, 1);
  assert.match(a[0], /^NEW runs\/fresh\.js: A=1 B=0 —/);

  // (b) The negation is the same question too; it must not slip through.
  const newNot = [source, file("runs/fresh.js", 'if (store.getWorkflowRun(id)?.status !== "running") return;')];
  assert.match(violations(places(newNot), list)[0], /^NEW runs\/fresh\.js: A=1 B=0/);

  // (c) A new transcript of the status set, in all three spellings, JS as well as SQL.
  for (const row of [
    'if (["running", "waiting"].includes(run.status)) return;',
    'const open = run.status === "running" || run.status === "waiting";',
    'db.prepare(`SELECT 1 FROM workflow_runs WHERE status IN (\'running\',\'waiting\')`);',
  ]) {
    const v = violations(places([source, file("runs/fresh.js", row)]), list);
    assert.equal(v.length, 1, `not found: ${row}`);
    assert.match(v[0], /^NEW runs\/fresh\.js: A=0 B=1/, row);
  }

  // (d) A SECOND place in a file that already has an entry: grown, not covered.
  const grown = violations(places([file("store/workflows.js",
    'const WORKFLOW_OPEN = ["running", "waiting"];',
    'const second = ["running", "waiting"];')]), list);
  assert.equal(grown.length, 1);
  assert.match(grown[0], /^GREW store\/workflows\.js: A=0 B=2, allowed A=0 B=1/);

  // (e) The entry stands, the place is gone: red, otherwise the debt would stand forever.
  const way = violations(places([file("store/workflows.js", "const x = 1;")]), list);
  assert.equal(way.length, 1);
  assert.match(way[0], /^Entry store\/workflows\.js has no place any more — remove it/);

  // (f) An entry that is too WIDE is red as well: it silently allowed growing back.
  const toFar = violations(places([source]), [{ file: "store/workflows.js", a: 1, b: 1, reason: "counter-test", followUpJob: "counter-test" }]);
  assert.equal(toFar.length, 1);
  assert.match(toFar[0], /^SHRUNK store\/workflows\.js: A=0 B=1, entry allows A=1 B=1/);

  // (g) A COMMENT is no place; otherwise the guard would report its own justification.
  assert.equal(places([file("runs/fresh.js",
    '// this was wrong: store.getWorkflowRun(chat.id)?.status === "running"',
    '/* as a block too: ["running", "waiting"].includes(x) */',
    "const x = 1;")]).size, 0);
  // A string, on the other hand, is very much a place: the SQL stands there.
  assert.equal(places([file("runs/fresh.js", 'const sql = "status IN (\'running\',\'waiting\')";')]).get("runs/fresh.js").b, 1);
});

// ── 2. The counter-test on the product ────────────────────────────────────────────────────────
// The path that breaks the promise: a verdict is parked WHILE the run stands on "waiting". This is
// deterministic at the round cap: `answerCap` calls the interpretation without touching the status
// (the run stays "waiting" with the same open question).

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`${res.status}: ${JSON.stringify(body)}`); e.status = res.status; e.body = body; throw e; }
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait for an EVENT, without a deadline (a deadline would measure the machine under load). If it hangs,
// the suite deadline is the emergency stop; every 30 s a stderr line says what is being waited for.
async function waitFor(fn, what = String(fn).replace(/\s+/g, " ").slice(0, 200)) {
  const t0 = Date.now();
  let reported = 0;
  for (;;) {
    const v = await fn();
    if (v) return v;
    const tick = Math.floor((Date.now() - t0) / 30_000);
    if (tick > reported) { reported = tick; process.stderr.write(`[waiting] for ${tick * 30} s: ${what}\n`); }
    await sleep(40);
  }
}

// Fake Claude after the pattern of wait-row-lifecycle.test.js, cut down to what is needed: turns
// answer, verdicts are read at the marker, and the FIRST interpretation of a cap answer dies at the
// usage limit (wording of the real CLI, with a reset hint).
const fakeClaude = ({ stateFile, promptLog, resetInSeconds = 600 }) => `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
const log = (s) => { try { fs.appendFileSync(${JSON.stringify(promptLog)}, s.replace(/\\s+/g, " ").slice(0, 600) + "\\n"); } catch {} };
const counter = (file) => { let n = 0; try { n = Number(fs.readFileSync(file, "utf8")) || 0; } catch {} return n; };
const set = (file, n) => { try { fs.writeFileSync(file, String(n)); } catch {} };
const hint = " · resets at " + new Date(Date.now() + ${resetInSeconds} * 1000).toISOString();
const limitTod = () => { process.stderr.write("Claude usage limit reached" + hint + "\\n"); process.exit(1); };
${RIPCORD}
const argv = process.argv.slice(2);
if (!argv.includes("--input-format")) {
  let stdin = ""; process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => {
    log("ONESHOT " + stdin.slice(0, 500));
    let result = "Title";
    if (/compacting the chat history/i.test(stdin)) result = "SUMMARY: state of the history";
    else if (/You interpret ONE answer/.test(stdin)) {
      // EXACTLY ONCE at the limit: afterwards the same question is interpreted normally (the re-entry
      // after the reset must not run into the same limit).
      const n = counter(${JSON.stringify(`${stateFile}.judge`)});
      if (n < 1) { set(${JSON.stringify(`${stateFile}.judge`)}, n + 1); limitTod(); }
      result = '{"continue": false, "rounds": 0, "note": "Marker END"}';
    }
    else if (/list|JSON array/i.test(stdin)) result = '["Alpha", "Beta", "Gamma"]';
    else if (/condition/i.test(stdin)) result = /JA-PLEASE/.test(stdin) ? '{"yes": true, "note": "Marker YES"}' : '{"yes": false, "note": "Marker NO"}';
    process.stdout.write(JSON.stringify({ result }));
    clearTimeout(guard);
    process.exit(0);
  });
} else {
  process.stdin.on("end", () => process.exit(0));
  readline.createInterface({ input: process.stdin }).on("line", (l) => {
    let msg; try { msg = JSON.parse(l); } catch { return; }
    if (msg.type !== "user") return;
    const c = msg.message && msg.message.content;
    const text = typeof c === "string" ? c : (Array.isArray(c) ? c.map((b) => b.text || "").join("") : "");
    log("TURN " + text);
    const out = "ERLEDIGT: " + text.replace(/\\s+/g, " ").slice(0, 120);
    setTimeout(() => {
      say({ type: "assistant", message: { content: [{ type: "text", text: out }] } });
      say({ type: "result", result: out, session_id: "workflow-open" });
    }, 30);
  });
}
`;

// Keep the Anthropic usage endpoint out of the test (empty HOME, a `security` that finds nothing): the
// server falls back to the reset hint in the message. `npx` and the embedding model are disabled,
// otherwise the start downloads hundreds of megabytes into this HOME.
function isolateCredentials(root) {
  const binDir = path.join(root, "shim");
  fs.mkdirSync(binDir, { recursive: true });
  for (const [name, body] of [["security", "#!/bin/sh\nexit 1\n"], ["npx", "#!/bin/sh\nexit 0\n"]]) {
    const p = path.join(binDir, name);
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
    if (name === "npx") process.env.NPX_BIN = p;
  }
  process.env.CBASE_EMBED_OFFLINE = "1";
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

const ENV_KEYS = ["CLAUDE_BIN", "NPX_BIN", "CBASE_EMBED_OFFLINE", "CBASE_TRIGGER_POLL", "CBASE_DEPOSIT_TICK_MS", "CBASE_SCHEDULE_TICK_MS", "CBASE_RESTART_GRACE_MS", "HOME", "PATH", "CLAUDE_CODE_OAUTH_TOKEN"];

async function withServer(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-workflow-open-"));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let server, base = "", finished = false;
  try {
    process.env.CBASE_TRIGGER_POLL = "0";
    // No restart follow-up: it is not the subject here.
    process.env.CBASE_RESTART_GRACE_MS = String(24 * 3_600_000);
    process.env.CBASE_DEPOSIT_TICK_MS = "3600000";
    process.env.CBASE_SCHEDULE_TICK_MS = "3600000";
    isolateCredentials(root);
    const stateFile = path.join(root, "runs.txt");
    const promptLog = path.join(root, "prompts.txt");
    fs.writeFileSync(promptLog, "");
    const bin = path.join(root, "fake-claude");
    fs.writeFileSync(bin, fakeClaude({ stateFile, promptLog }));
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Open", path: wsPath }) });
    await fn({ base, ws, prompts: () => fs.readFileSync(promptLog, "utf8").split("\n").slice(0, -1).filter(Boolean) });
    finished = true;
  } finally {
    // Do not wait after a failure: a run parked at the limit would otherwise hold the file.
    if (base && finished) await waitForQuiet(base);
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    // A failure while cleaning up says something about the cleanup, not about the product.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}); test unaffected.`); }
  }
}

// Cycle with cap 1: instruction, condition (marker NO), back; after one round the cap asks and the
// run stands on "waiting" (as in workflow-loop-cap.test.js).
const cycleFlow = () => ({
  nodes: [
    { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
    { id: "n1", type: "instruction", title: "Round", text: "WORK", maxVisits: 1, x: 200, y: 0 },
    { id: "c1", type: "condition", title: "Done?", text: "Is everything done? (NO-PLEASE)", x: 420, y: 0 },
    { id: "e1", type: "end", title: "End", x: 640, y: -80 },
  ],
  edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "c1" }, { from: "c1", to: "e1", branch: "true" }, { from: "c1", to: "n1", branch: "false" }],
});

test("Cap interpretation at the limit: the run stands on waiting and the wait row still carries it", async (t) => {
  await withServer(async ({ base, ws }) => {
    const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, { method: "POST", body: JSON.stringify({ name: "Cap-interpretation" }) });
    await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({ graph: cycleFlow(), lock: { scope: "off", template: "" }, run: { doneAll: false } }) });
    const chat = await json(`${base}/api/chats`, {
      method: "POST",
      body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
    });
    const r = await json(`${base}/api/chats/${chat.id}/workflow`, { method: "POST", body: JSON.stringify({ workflowId: flow.id, input: "" }) });

    // Precondition: one round has run, the cap asks; the run stands on "waiting".
    const held = await waitFor(async () => {
      const d = await json(`${base}/api/chats/${chat.id}/workflow`);
      return d.run?.status === "waiting" && d.run?.pending === "cap" ? d.run : null;
    });
    assert.equal(held.status, "waiting");

    // An answer the parser CANNOT read, so a model interprets it, which dies at the limit, so parkJudge
    // writes the wait row. The status stays "waiting" meanwhile.
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "hm, was hältst du davon, entscheide du" }) });
    const wait = await waitFor(async () => (await json(`${base}/api/chats/${chat.id}/auto-continue`)).wait || null);
    assert.equal(wait.kind, "judge", "precondition: the verdict is parked");
    const state = await json(`${base}/api/chats/${chat.id}/workflow`);
    t.diagnostic(`run when the row was written: status=${state.run.status} pending=${state.run.pending}; row: kind=${wait.kind} workflow=${wait.workflow}`);
    assert.equal(state.run.status, "waiting", "precondition of this test: the run stands on waiting, not on running");
    assert.equal(state.run.id, r.run.id);

    // The core: a workflow hangs on this row. With the flag asking "running" instead of "open" this was
    // `false`, and because it is persisted that never healed: the strip did not tell the human before
    // discarding that a run hangs on it.
    assert.equal(wait.workflow, true, "the wait row does not know the workflow (flag asks running instead of open)");

    // Leave tidy: cancelling ends the run and takes the row along.
    await json(`${base}/api/chats/${chat.id}/workflow/cancel`, { method: "POST" });
    await waitFor(async () => (["cancelled", "failed", "done"].includes((await json(`${base}/api/chats/${chat.id}/workflow`)).run?.status) ? true : null));
    assert.equal((await json(`${base}/api/chats/${chat.id}/auto-continue`)).wait, null);
  });
});
