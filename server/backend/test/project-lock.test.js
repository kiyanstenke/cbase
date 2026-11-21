// Idle and lock per project (the lock keeps starts away while a project container is not ready) and the marker "server ends"
// (runs/server-end.js serverEnds).
//
// What holds here:
//   (1) The callers of doRun stand as a named table: a hit without a row is red, a row without a hit too, a changed count as
//       well (built-in sabotage with an extra, a missing and a multiplied call in text copies). The lock stands at the HEAD of
//       doRun — after `running.add`, in the same expression as the credit gate, before any spawn —, so every caller reaches it;
//       only the resume retry is exempt (`noResume`, the same turn with a fresh session). Also: no call stands NAKED — each is
//       awaited (`await`), returned (`return`) or has its `.catch(` behind the parenthesis; a rejection without a catcher
//       would end the process (the service agent now goes through startRun).
//   (2) The verdict per state and purpose as a table, plus: without operating marker or without instance row null.
//   (3) Composer: while the instance works (`start`) the message waits in the queue (`queued`, `locked`) — no run, no docker;
//       after `ready` the turn runs (user → assistant). Without operating marker it runs at once.
//   (4) A direct doRun (like the goal gate, a round at the completion gate): a wait row with reason "project" instead of a
//       spawn; "Try now" holds it; after `ready` the turn runs, the row is gone.
//   (5) Graph workflow: the driver step waits in the wait row (reason "project", workflow marker), after `ready` it runs and
//       the run ends "done".
//   (6) Gate step after approval: a stopped step to which the human gives a new task (workflows/gates.js answerWorkflow)
//       waits likewise and runs after `ready`.
//   (7) `error` of a converted project: the message ends visibly at once — hint, run_aborted, busy:false, no spawn; the user's
//       message stays. The text is in the stream ONCE: the hint row goes out live (`row`), the end of the waiting carries
//       `run_aborted` (reason "project") without text.
//   (8) Relocation: a subagent start gets a tool error with reason, a oneshot is rejected.
//   (9) projectLocks: lock, THEN idle — a living subagent resp. a workflow run in `waiting` is open (the lock is released at
//       once); quiet ⇒ the project's terminals end with a message, new turns wait, `resolve()` wakes.
//  (10) Workflow agent of a dynamic workflow in `start`: waits (journal "waiting", reason "project"), no spawn, starts after
//       `ready`; no failed agent.
//  (11) During the server end (the stop chain holds at a gate) a message to a converted project is queued, no turn begins; after
//       the restart it runs. Also: during the server end the turns of a chat WITHOUT project and of a chat in a project WITHOUT
//       instance row run as before — no wait row "server end", not once more after the restart.
//  (12) Project switch: a subagent core stays pinned to its project A even if its chat moves to B — A's idle sees the living
//       agent (projectLocks(A) refuses with open=[agent]), and a start FROM this core (the agent calls its grandchild) is
//       rejected at A's lock although the chat now stands in B. Likewise for a dynamic workflow: its open core counts in A's
//       idle ("workflow", its living agent "workflowagent"), and its next agent waits at A's lock (`start`).
//  (13) The criteria of idle as a named table — every reason from ARCHIVE_REASONS (without the question) plus monitor, verdict,
//       oneshot, earmarked graph start: one state per criterion, `open` names EXACTLY this reason, and projectLocks refuses;
//       the open question alone is quiet. Red if ARCHIVE_REASONS gains a reason the table does not name. "copy" (set-up or
//       clear-away of the chat's copy) alone is quiet too: idle is exactly the question step 0 of the clear-away asks.
//  (13c) Every reason literal of idleOf has a guard: it stands in IDLE_CRITERIA or PROJECT_WIDE, and every PROJECT_WIDE entry
//       stands as a literal in the source.
//  (14) A limit row whose start the lock holds keeps its reason ("reset") — after `ready` the transition fires it, with a
//       resume row, and the turn runs.
//  (15) If the lock cannot read the database it falls CLOSED — turn and agent wait ("unreadable"), a oneshot runs (unless a
//       relocation holds the lock and the project is unknown), runInstance throws; the composer's message waits in the wait
//       row (not in the queue, which no transition wakes) and runs as soon as the database answers; if not even the wait row
//       can be written, the start ends visibly and the chat does not stand in `running` forever.
// (15b) closed only where an instance row COULD concern the project — in B without any row, lock (turn, agent, oneshot) and
//       runInstance return null on a read error, and the composer turn runs at once (no wait row "unreadable"); if ANOTHER
//       project carries a row, the known one stays open, the unknown one (chat row unreadable) falls closed, likewise next to an
//       explicit lock without row; after deleting the row open again.
// (15c) the wait row is written, every read afterwards throws (prepare of the test process swapped) — doRun ends without a
//       throw, the chat does not hang in `running`, the run end `run:false` goes through the global stream; after `ready` the
//       turn runs.
//  (16) A project switch in the middle of a turn is allowed (200), also with converted source and converted target; the turn
//       stays pinned to its project and holds A's idle until its end (reason "running", projectLocks refuses), afterwards A is quiet.
//  (17) No new project terminal under a lock: POST /api/projects/:pid/terminal answers 409 LOCKED.
//
// Waiting only on events and states, never on a duration (agent-harness.mjs waitForTruthy, gates). Without account (HOME,
// `security`, OAuth token swapped): the wait row checks the limit on waking — otherwise it would read the keychain.
//
// COUNTER-TESTS (each a sabotage at the source, the whole file run, then restored):
//   runs/do-run.js: projectLockHolds removed from the head of doRun (only the composer branch holds)
//                                                  ⇒ (1) head, (4), (5), (6), (7) red — driver, gate and direct doRun spawn
//   runs/queue.js: the lock branch in deliverUserPrompt removed
//                                                  ⇒ (3), (9), (11) red — the message goes into the run, `queued` is missing
//   runs/limit-gate.js: projectLockHolds never asks (verdict null)   ⇒ (4), (5), (6), (7) red
//   runs/auto-continue.js: fireAutoContinueInner does not hold      ⇒ (4) red ("Try now" starts in the middle of the recreation)
//   runs/project-lock.js: projectStartGate answers null              ⇒ (8), (10) red (subagent and workflow agent start)
//   dynworkflows/run.js: gateFor without the project branch (`return null`)  ⇒ (10) red (the agent fails at the core gate)
//   projectbox/idle.js: open workflow runs not counted               ⇒ (9) red (a workflow in `waiting` counts as quiet)
//   runs/server-end.js: `ends = true;` removed                       ⇒ (11) red (the turn begins in the ending process)
//   projectbox/idle.js: the loop over coresInProject removed         ⇒ (12), (12b) red (A counts as quiet)
//   runs/agents.js: startGate passes no `projectId`                  ⇒ (12) red (the grandchild starts, B's lock asked)
//   dynworkflows/run.js: gateFor asks without `projectId`           ⇒ (12b) red (agent #2 fails at the core gate instead of waiting)
//   projectbox/idle.js: the monitor row removed                      ⇒ (13) red (monitor: open empty)
//   runs/archive.js: ARCHIVE_REASONS extended by "new"               ⇒ (13) red (a reason without a table row)
//   projectbox/idle.js: `serverEnds()` moved before the project check ⇒ (11) red (the chat without project is queued)
//   runs/auto-continue.js overwriting the reason                     ⇒ (14) red (reason "project" instead of "reset")
//   projectbox/idle.js without `takeHalted` in wakeProject           ⇒ (14) red (the transition did not fire the row)
//   runs/project-lock.js + projectbox/idle.js: read error ⇒ open     ⇒ (15) red (the lock answers null)
//   projectbox/run-instance.js: read error ⇒ null                    ⇒ (15) red (runInstance returns null instead of throwing)
//   runs/queue.js queueing every "wait"                              ⇒ (15) red (the message stood in the queue)
//   runs/limit-gate.js: parkOrQueue without try/catch                ⇒ (15) red (the chat stayed in `running`)
//   chats/routes.js with the 409 lock for a project switch           ⇒ (16) red (409 instead of 200)
//   projectbox/idle.js without the loop over turnsInProject          ⇒ (16) red (A counts as quiet in the middle of the turn)
//   projectbox/idle.js + run-instance.js without the limit (always closed) ⇒ (15b) red (turn waits without a row)
//   projectbox/run-instance.js alone without the limit               ⇒ (15b) red (runInstance throws without a row)
//   store/project-instances.js: delete does not maintain the set     ⇒ (15b) red (closed after the delete)
//   store/project-instances.js: create does not maintain the set     ⇒ (15), (15b) red (the row does not close)
//   runs/limit-gate.js with the re-read uncaught                     ⇒ (15c) red (the chat stayed in `running`)
//   runs/do-run.js with the re-read in the gate branch uncaught      ⇒ (15c) red (doRun threw, no run end)
//   devtools/code-route.js: `const lock = null;`                     ⇒ (17) red (201)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as store from "../electron/server/store.js";
import { setInstanceState } from "../electron/server/projectbox/instances.js";
import { projectLocked, projectIdle, projectLock, projectLocks } from "../electron/server/projectbox/idle.js";
import { projectWaitingCount } from "../electron/server/dynworkflows/parking.js";
import { dynWorkflowsOpen } from "../electron/server/dynworkflows/run.js";
import { doRun } from "../electron/server/runs/do-run.js";
import { ARCHIVE_REASONS, openWork, setCopyWork } from "../electron/server/runs/archive.js";
import { copyWorkOf } from "../electron/server/stacks/remove.js";
import { pendingPermissions } from "../electron/server/runs/approvals.js";
import { setBackgroundSource } from "../electron/server/runs/background.js";
import { instanceForProject, releaseTurn } from "../electron/server/runs/instance.js";
import { startServiceChat } from "../electron/server/projects/coding-jobs.js";
import { autoContinueFiring, autoContinueSweepMs } from "../electron/server/runs/limit-gate.js";
import { startLock } from "../electron/server/runs/project-lock.js";
import { deliverUserPrompt } from "../electron/server/runs/queue.js";
import { compacting, pendingRunInputs, running, targetCheckOn, targetCheckOff } from "../electron/server/runs/state.js";
import { closeMonitors, startMonitor } from "../electron/server/runs/monitors.js";
import { runningVerdicts } from "../electron/server/workflows/driver.js";
import { runningOneshotsOf, runOnce } from "../electron/server/providers/index.js";
import { killTerminal } from "../electron/server/terminal.js";
import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { readJsonl } from "./jsonl.mjs";

const TESTDIR = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON = path.resolve(TESTDIR, "..", "electron");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ── (1) The callers of doRun ──────────────────────────────────────────────────────────────────────────────────────

// Per function that calls doRun: how often, which path, and which test here shows the locked start without a spawn. All
// reach the lock at the head of doRun (test "Head of doRun"); the integration shows it on four paths.
const DORUN_CALLER = [
  { key: "server/runs/do-run.js#startRun", count: 1, way: "composer, channel, queue, wait row, restart grace (queue.js, auto-continue.js, resume.js), the service chat (projects/coding-jobs.js startServiceChat)", proof: "(3) composer, (4) wait row" },
  { key: "server/runs/do-run.js#doRun", count: 1, way: "resume retry with `noResume` — the same turn with a fresh session, it has already passed the lock", proof: "exempt like the credit gate" },
  // The body of the driver is driveWorkflowIntern — driveWorkflow is the wrapper that occupies the
  // chat for the duration of the decision (runs/state.js workflowDecides); the two calls are the same.
  { key: "server/workflows/driver.js#driveWorkflowIntern", count: 2, way: "driver step (command node, work node)", proof: "(5) graph workflow" },
  { key: "server/workflows/gates.js#answerWorkflow", count: 4, way: "task at a gate (stopped, completion gate, approval card, agent question)", proof: "(6) stopped step" },
  { key: "server/workflows/gates.js#gateAfterRunWithoutClaim", count: 1, way: "another round at the completion gate", proof: "(4) direct doRun" },
  { key: "server/runs/post-run.js#goalGateAfterRun", count: 1, way: "goal gate: next round", proof: "(4) direct doRun" },
];

function sourceFiles() {
  const out = [];
  const run = (dir) => {
    for (const n of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (n.name === "node_modules") continue;
      const abs = path.join(dir, n.name);
      if (n.isDirectory()) run(abs);
      else if (/\.(c|m)?js$/.test(n.name)) out.push({ path: path.relative(ELECTRON, abs).split(path.sep).join("/"), text: fs.readFileSync(abs, "latin1") });
    }
  };
  run(ELECTRON);
  return out;
}
// A call is `doRun(` except the declaration; comment lines do not count (the same rule as projectbox-ops.test.js).
const DORUN = /(?<!function\s)\bdoRun\(/g;
const COMMENT = /^\s*(?:\/\/|\*|\/\*)/;
const FUNCTION_TOP = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/;
function doRunCalls(files) {
  const hits = new Map();
  for (const { path: filePath, text } of files) {
    const rows = text.split("\n");
    const beginnings = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") beginnings.push(i + 1);
    for (const m of text.matchAll(DORUN)) {
      let row = 0;
      while (row + 1 < beginnings.length && beginnings[row + 1] <= m.index) row++;
      if (COMMENT.test(rows[row])) continue;
      let fn = "(module level)";
      for (let k = row; k >= 0; k--) { const f = rows[k].match(FUNCTION_TOP); if (f) { fn = f[1]; break; } }
      const k = `${filePath}#${fn}`;
      if (!hits.has(k)) hits.set(k, { count: 0, rows: [] });
      hits.get(k).count++;
      hits.get(k).rows.push(row + 1);
    }
  }
  return hits;
}
function callerViolations(hits) {
  const v = [];
  const table = new Map(DORUN_CALLER.map((e) => [e.key, e]));
  for (const [k, t] of hits) {
    const e = table.get(k);
    if (!e) v.push(`NEW doRun caller ${k} (row ${t.rows.join(", ")}) — does it reach the lock? Add a row to DORUN_CALLER with path and proof`);
    else if (e.count !== t.count) v.push(`${k}: ${t.count} call(s) instead of ${e.count} (row ${t.rows.join(", ")})`);
  }
  for (const [k] of table) if (!hits.has(k)) v.push(`Row without a hit ${k} — rebuilt? Then delete the row`);
  return v;
}

// A doRun that nobody awaits and that has no catcher ends the
// PROCESS with a rejection — and with it every running turn. Each call is awaited (`await`), returned (`return`) or carries its
// `.catch(` right behind the closing parenthesis (whitespace and line breaks in between do not count).
function bareCalls(files) {
  const v = [];
  for (const { path: filePath, text } of files) {
    for (const m of text.matchAll(DORUN)) {
      const beginning = text.lastIndexOf("\n", m.index) + 1;
      const end = text.indexOf("\n", m.index);
      if (COMMENT.test(text.slice(beginning, end === -1 ? text.length : end))) continue;
      if (/\b(?:await|return)\s+$/.test(text.slice(beginning, m.index))) continue;
      let i = m.index + m[0].length - 1; // the opening parenthesis
      for (let depth = 0; i < text.length; i++) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")" && --depth === 0) break;
      }
      if (/^\s*\.catch\(/.test(text.slice(i + 1, i + 200))) continue;
      v.push(`${filePath}:${text.slice(0, m.index).split("\n").length} — doRun without await, return or .catch: a rejection ends the process (use startRun)`);
    }
  }
  return v;
}

test("(1) doRun callers: the named table covers every call — no new one, none gone, no changed count", () => {
  const hits = doRunCalls(sourceFiles());
  for (const e of DORUN_CALLER) console.log(`[project-lock] doRun caller ${e.key} (${e.count}×): ${e.way} — proof: ${e.proof}`);
  assert.deepEqual(callerViolations(hits), []);
  assert.deepEqual(bareCalls(sourceFiles()), [], "a naked doRun");
});

test("(1) doRun callers, built-in sabotage: an extra, a missing and a multiplied call are red", () => {
  const real = sourceFiles();
  const including = (filePath, text) => [...real.filter((d) => d.path !== filePath), { path: filePath, text }];
  const one = (files) => callerViolations(doRunCalls(files));
  const addition = one(including("server/projects/sabotage.js", 'import { doRun } from "../runs/do-run.js";\nexport function foreign(chat) {\n  doRun(chat, "go");\n}\n'));
  assert.equal(addition.length, 1);
  assert.match(addition[0], /^NEW doRun caller server\/projects\/sabotage\.js#foreign \(row 3\)/);
  // Missing and multiplied: at a caller of the table with EXACTLY one call, chosen from the table instead of nailed to a file
  // (so a refactor of one caller does not break the test).
  const target = DORUN_CALLER.find((e) => e.count === 1 && !e.key.startsWith("server/runs/do-run.js#"));
  assert.ok(target, "no caller with exactly one call outside do-run.js");
  const [targetPath] = target.key.split("#");
  const targetText = real.find((d) => d.path === targetPath).text;
  const row = doRunCalls([{ path: targetPath, text: targetText }]).get(target.key).rows[0];
  const enabledRow = (fn) => targetText.split("\n").map((z, i) => (i === row - 1 ? fn(z) : z)).join("\n");
  const without = one(including(targetPath, enabledRow((z) => z.replace(/\bdoRun\(/, "void ("))));
  assert.deepEqual(without, [`Row without a hit ${target.key} — rebuilt? Then delete the row`]);
  const duplicate = one(including(targetPath, enabledRow((z) => z.replace(/\bdoRun\(/, "doRun(null) && doRun("))));
  assert.equal(duplicate.length, 1);
  assert.ok(duplicate[0].startsWith(`${target.key}: 2 call(s) instead of 1`), duplicate[0]);
  // A comment is no call.
  assert.deepEqual(one(including(targetPath, `${targetText}\n// doRun(chat, "only explained");\n`)), []);
});

test("(1) no naked doRun — built-in sabotage: red without a catcher, not with await, return or .catch (also on the next line)", () => {
  const file = (body) => [{ path: "server/projects/sabotage.js", text: `import { doRun } from "../runs/do-run.js";\nexport function foreign(chat) {\n${body}\n}\n` }];
  const bare = bareCalls(file('  doRun(chat, "go");'));
  assert.equal(bare.length, 1);
  assert.match(bare[0], /^server\/projects\/sabotage\.js:3 — doRun without await/);
  // The old form of the service agent, literally: the guard would have found it.
  assert.equal(bareCalls(file("  store.addMessage(chat.id, \"user\", text);\n  doRun(chat, text);\n  return chat.id;")).length, 1);
  assert.deepEqual(bareCalls(file('  await doRun(chat, "go");')), []);
  assert.deepEqual(bareCalls(file('  return doRun(chat, f("a", g(1)));')), []);
  assert.deepEqual(bareCalls(file('  doRun(chat, f("a", g(1)))\n    .catch((e) => console.error(e));')), []);
  assert.deepEqual(bareCalls(file('  // doRun(chat, "only explained");')), []);
  // A .catch that belongs to ANOTHER expression does not count.
  assert.equal(bareCalls(file('  doRun(chat, "go"); x.catch(() => {});')).length, 1);
});

// What this test promises is only the second half: no unhandled rejection. The error itself is in the log and as a volatile
// `run_error` on the chat's stream (runs/do-run.js startRun), NOT in the stored history — whoever opens the service chat
// later sees only the task.
test("(1) the service agent with a throw at the head of doRun — error in the log and as a run_error event, no unhandled rejection (which ended the server)", async () => {
  const unhandled = [];
  const merker = (e) => unhandled.push(String(e?.message || e));
  process.on("unhandledRejection", merker);
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const filePath = path.join(ctx.root, "workspace", "serviceprj"); // empty: no services scan
      fs.mkdirSync(filePath, { recursive: true });
      const p = await post(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { name: "ServicePrj", path: filePath });
      let chatId = null;
      // The throw: `app_settings` is missing for the duration of the SYNCHRONOUS start — the
      // credit gate at the head of doRun reads there before doRun waits for the first time.
      withoutTable(ctx, "app_settings", () => {
        chatId = startServiceChat(store.getProject(p.id), { name: "web", kind: "frontend", port: null, startCommand: "true" });
      });
      // One turn of the event loop: Node reports an unhandled rejection at the end of the tick in which it arose.
      await new Promise((r) => setImmediate(r));
      assert.ok(chatId, "no chat of the service agent");
      // A throw BEFORE the try of doRun leaves the chat in `running` (a separate finding) — taken back here,
      // otherwise the harness quiet would wait forever.
      running.delete(chatId);
      releaseTurn(chatId, { ran: false });
    }));
  } finally {
    process.off("unhandledRejection", merker);
  }
  assert.deepEqual(unhandled, [], "a rejection without a catcher ends the server process when nobody listens");
});

test("(1) Head of doRun: the lock stands after `running.add`, in the same expression as the credit gate, before every spawn", () => {
  const text = fs.readFileSync(path.join(ELECTRON, "server", "runs", "do-run.js"), "latin1");
  const header = text.indexOf("async function doRun(");
  assert.ok(header >= 0, "doRun not found");
  const body = text.slice(header);
  const add = body.indexOf("running.add(chat.id);");
  const condition = body.search(/if \(!noResume && \(projectLockHolds\(chat, text, \{[^}]*\}\)\s*\|\|\s*await creditGateHolds\(chat, text,/);
  const spawn = body.search(/\brunChat\(/);
  assert.ok(add >= 0 && condition > add, `the lock does not stand behind running.add (add ${add}, lock ${condition})`);
  assert.ok(spawn > condition, `a spawn before the lock (lock ${condition}, runChat ${spawn})`);
  // No `await` between `running.add` and the lock (code, not comment): otherwise a second message would get through,
  // or the head would wait before it decides.
  const code = body.slice(add, condition).split("\n").filter((z) => !COMMENT.test(z)).join("\n");
  assert.ok(!/\bawait\b/.test(code), `an await between running.add and the lock:\n${code}`);
  // startRun does not ask the lock itself — otherwise drivers and gates would run past it, and the table above would lie.
  const sl = text.slice(text.indexOf("function startRun("));
  assert.ok(!sl.slice(0, sl.indexOf("\n}\n")).includes("projectLock"), "startRun asks the lock itself");
});

// ── Common parts of the integration ─────────────────────────────────────────────────────────────────────────────────

// The main agent writes a line per turn to main.jsonl; "{MAINGATE:x}" holds it at gate x; "AG:{json}" calls cbase_agent
// (result under ag-<description>); "WF[tag]:{json}" calls cbase_dynamic_workflow (result under wf-<tag>).
const MAIN = `
  fs.appendFileSync(path.join(LOCATION, "main.jsonl"), JSON.stringify({ turn, text }) + "\\n");
  if (text.includes("{MAINGATE:")) await gate(text.split("{MAINGATE:")[1].split("}")[0]);
  const ag = text.indexOf("AG:{");
  const wf = text.indexOf("WF[");
  if (text.includes("<task-notification>")) {
    say({ type: "assistant", message: { id: "m-" + Date.now(), content: [{ type: "text", text: "Notification read" }] } });
  } else if (wf >= 0) {
    const tag = text.slice(wf + 3, text.indexOf("]:", wf));
    const args = JSON.parse(text.slice(text.indexOf("]:", wf) + 2));
    const id = "toolu_wf_" + tag;
    say({ type: "assistant", message: { id: "a-" + tag, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_dynamic_workflow", input: args }] } });
    let t = "";
    try { const r = await mcpCall("cbase_dynamic_workflow", args); t = (r.result && r.result.isError ? "FEHLER " : "") + textOf(r); } catch (e) { t = "FEHLER " + (e && e.message ? e.message : String(e)); }
    { const z = path.join(LOCATION, "wf-" + tag); fs.writeFileSync(z + ".teil", t); fs.renameSync(z + ".teil", z); } // atomic: the test waits only for existence
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  } else if (ag >= 0) {
    const args = JSON.parse(text.slice(ag + 3));
    const id = "toolu_ag_" + args.description;
    say({ type: "assistant", message: { id: "ag-" + args.description, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_agent", input: args }] } });
    let t = "";
    try { const r = await mcpCall("cbase_agent", args); t = (r.result && r.result.isError ? "FEHLER " : "") + textOf(r); } catch (e) { t = "FEHLER " + (e && e.message ? e.message : String(e)); }
    fs.writeFileSync(path.join(LOCATION, "ag-" + args.description), t);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  say({ type: "assistant", message: { id: "c-" + Date.now(), content: [{ type: "text", text: "Answer " + turn }] } });
  finished();
  say({ type: "result", result: "Answer " + turn, session_id: "main-session" });`;
// A subagent or workflow agent: {TAG:x} names it (every spawn appends an "x" to sub-start-<tag>), {GATE:x} holds it
// at gate x-<spawn count>.
const SUB = `
    const ab = text.lastIndexOf("Here is the task:");
    const job = ab >= 0 ? text.slice(ab) : text;
    const tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : "x";
    fs.appendFileSync(path.join(LOCATION, "sub-start-" + tag), "x");
    const nr = fs.readFileSync(path.join(LOCATION, "sub-start-" + tag), "utf8").length;
    say({ type: "assistant", message: { id: "s-" + tag + nr, content: [{ type: "text", text: "working " + tag }] } });
    if (job.includes("{GATE:")) await gate(job.split("{GATE:")[1].split("}")[0] + "-" + nr);
    // "{ENKEL}": after the gate the agent itself calls cbase_agent — a start from ITS core (result under
    // grandchild-result). The grandchild is tagged "grandchild" (sub-start-grandchild).
    if (job.includes("{ENKEL}")) {
      const args = { description: "grandchild", prompt: "Help {TAG:grandchild}", run_in_background: false };
      say({ type: "assistant", message: { id: "s-grandchild", content: [{ type: "tool_use", id: "toolu_grandchild", name: "mcp__cbase__cbase_agent", input: args }] } });
      let t = "";
      try { const r = await mcpCall("cbase_agent", args); t = (r.result && r.result.isError ? "FEHLER " : "") + textOf(r); } catch (e) { t = "FEHLER " + (e && e.message ? e.message : String(e)); }
      fs.writeFileSync(path.join(LOCATION, "grandchild-result"), t);
    }
    finished();
    say({ type: "result", result: "Finding " + tag, session_id: "sub-" + tag + "-s" });`;
// Oneshots (verdicts of the workflow gates): "done".
const ONESHOT = `respond('{"done": true, "yes": true, "note": "ok"}');`;
const CLAUDE = fakeClaude({ main: MAIN, sub: SUB, oneshot: ONESHOT });

const turns = (root) => readJsonl(path.join(root, "main.jsonl"));
const spawns = (root, tag) => { const f = path.join(root, `sub-start-${tag}`); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").length : 0; };
const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const send = (ctx, text) => post(`${ctx.base}/api/chats/${ctx.chat.id}/message`, { text });
const active = (ctx) => json(`${ctx.base}/api/runs/active`);
const history = (ctx) => json(`${ctx.base}/api/chats/${ctx.chat.id}/log`);
const waitRow = async (ctx) => (await json(`${ctx.base}/api/chats/${ctx.chat.id}/auto-continue`)).wait;

async function projectWithChat(ctx, name) {
  const filePath = path.join(ctx.root, "workspace", name.toLowerCase());
  const p = await ctx.projectWithoutInstance({ name, path: filePath });
  fs.mkdirSync(filePath, { recursive: true });
  await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
  return p;
}

// The operating markers — set for the server in the test process AFTER it ran (they are read at runtime; at start with
// CBASE_CONTAINER warmupEmbeddings would load onnxruntime, see projectbox-server-end.test.js).
const TUNABLES = ["CBASE_CONTAINER", "CBASE_DIND", "CBASE_DOCKER_BIN", "CBASE_SERVER_END_MS"];
async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(TUNABLES.map((k) => [k, process.env[k]]));
  try {
    for (const k of TUNABLES) { if (values[k] === undefined) delete process.env[k]; else process.env[k] = values[k]; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const ops = (fd) => ({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin });

// Without account (as in dynworkflows-limits.test.js): waking a wait row checks the limit — without this the server would
// read the keychain and ask the usage endpoint of the REAL account. Also `npx` as a no-op (credit-gate.test.js): with a
// swapped HOME every server would load the Playwright MCP over the network into an empty npx cache.
async function withoutAccount(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-lock-account-"));
  const prior = { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN, NPX_BIN: process.env.NPX_BIN };
  try {
    const shim = path.join(root, "shim");
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, "security"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    fs.writeFileSync(path.join(shim, "npx"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    for (const d of ["home", "codex-home"]) fs.mkdirSync(path.join(root, d));
    process.env.HOME = path.join(root, "home");
    process.env.CODEX_HOME = path.join(root, "codex-home");
    process.env.PATH = `${shim}:${process.env.PATH}`;
    process.env.NPX_BIN = path.join(shim, "npx");
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { console.warn(`Cleanup of ${root}: ${e.code || e.message}`); }
  }
}

// The server of a test (in the test process). The finally puts every still working instance on `ready` — otherwise the
// harness quiet would wait forever for it after a failure (`projectInstances` in /api/runs/active) instead of reporting
// the error; the transition wakes what still waits, and the harness clears it away.
function withServer(fn, opts = { claude: CLAUDE }) {
  return withAgentsServer(async (ctx) => {
    try { await fn(ctx); }
    finally {
      for (const z of store.projectInstancesInState(store.PROJECT_WORK_STATES)) {
        try { setInstanceState(z.projectId, z.instance, "ready"); } catch (e) { console.warn(`[project-lock] cleanup ${z.identifier}: ${e?.message || e}`); }
      }
    }
  }, opts);
}

// An SSE reader for a chat's stream (the form of graph-hold.test.js); `connected` waits for the first event.
function recording(base, chatId) {
  const events = [];
  const controller = new AbortController();
  const done = (async () => {
    const res = await fetch(`${base}/api/chats/${chatId}/stream`, { signal: controller.signal, headers: { Connection: "close" } });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) return;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try { events.push(JSON.parse(line.slice(6))); } catch { /* defective frame */ }
        }
      }
    } catch { /* aborted */ }
  })();
  return {
    events,
    connected: () => waitForTruthy(() => events.some((e) => e.type === "harness" && e.subtype === "connected"), "stream connected"),
    stop: async () => { controller.abort(); await done; },
  };
}

// A workflow OF THE PROJECT: a chat with project focus sees workspace workflows only when adopted (store effectiveWorkflows).
const createFlow = (ctx, projectId, name, graph) => post(`${ctx.base}/api/projects/${projectId}/workflows`, { name, graph });
const flowStart = (ctx, workflowId) => post(`${ctx.base}/api/chats/${ctx.chat.id}/workflow`, { workflowId, input: "go" });
const runStatus = async (ctx, runId) => (await json(`${ctx.base}/api/workflow-runs/${runId}`)).run;
const oneNode = (text) => ({
  nodes: [
    { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
    { id: "n1", type: "instruction", title: "One", text, x: 200, y: 0 },
    { id: "e0", type: "end", title: "End", x: 400, y: 0 },
  ],
  edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "e0" }],
});

// ── (2) The verdict per state and purpose ─────────────────────────────────────────────────────────────────────────────

test("(2) verdict per state × purpose — and without operating marker or without instance row null", async () => {
  const fd = await fakeDocker();
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const p = await projectWithChat(ctx, "Table");
      const id = ctx.chat.id;
      const verdict = () => Object.fromEntries(["turn", "agent", "oneshot"].map((z) => [z, projectLock(id, z)?.kind ?? null]));
      const set = (state, convertedAt = null) => {
        if (store.instanceFor(p.id)) store.changeProjectInstance(p.id, "main", { state, convertedAt });
        else store.createProjectInstance({ projectId: p.id, state, convertedAt });
      };
      const all = (kind) => ({ turn: kind, agent: kind, oneshot: kind });
      await withEnvironment(ops(fd), async () => {
        assert.deepEqual(verdict(), all(null), "without an instance row no lock");
      });
      const rows = [
        ["start", null, { turn: "wait", agent: "wait", oneshot: null }],
        ["create", null, { turn: "wait", agent: "wait", oneshot: null }],
        ["recreate", Date.now(), { turn: "wait", agent: "wait", oneshot: null }],
        ["relocation", null, { turn: "wait", agent: "deny", oneshot: "deny" }],
        ["ready", Date.now(), all(null)],
        ["ready", null, all(null)],
        ["error", Date.now(), { turn: "error", agent: "error", oneshot: null }],
        ["error", null, all(null)],
      ];
      for (const [state, marker, desired] of rows) {
        set(state, marker);
        await withEnvironment({}, async () => assert.deepEqual(verdict(), all(null), `without operating marker no lock (${state})`));
        await withEnvironment(ops(fd), async () => assert.deepEqual(verdict(), desired, `${state}${marker ? " (converted)" : ""}`));
      }
      // The reason is in the text: `error` names the error of the row.
      store.changeProjectInstance(p.id, "main", { state: "error", convertedAt: Date.now(), error: "network detach missing" });
      await withEnvironment(ops(fd), async () => assert.match(projectLock(id, "turn").text, /Projekt-Container nicht bereit: network detach missing/));
      // The explicit lock of a relocation applies like the state `relocation`, also over `ready`.
      store.changeProjectInstance(p.id, "main", { state: "ready", convertedAt: null, error: "" });
      await withEnvironment(ops(fd), async () => {
        const s = projectLocks(p.id, { reason: "relocation" });
        assert.equal(s.ok, true, JSON.stringify(s));
        try { assert.deepEqual(verdict(), { turn: "wait", agent: "deny", oneshot: "deny" }); }
        finally { assert.equal(s.resolve(), true); }
        assert.equal(s.resolve(), false, "a second resolve does nothing");
        assert.deepEqual(verdict(), all(null));
      });
      assert.deepEqual(fd.calls(), [], "no docker");
    }));
  } finally { fd.cleanUp(); }
});

// ── (3) Composer ────────────────────────────────────────────────────────────────────────────────────────────────────

test("(3) composer: instance starts ⇒ queued/locked, no run, no docker; after ready the turn runs (user → assistant); without operating marker at once", async () => {
  const fd = await fakeDocker();
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const p = await projectWithChat(ctx, "Checkout");
      setInstanceState(p.id, "main", "start");
      // Without operating marker the message runs at once, even with a row in `start`.
      const g1 = await send(ctx, "G1-MESSAGE");
      assert.equal(g1.queued, false, JSON.stringify(g1));
      await waitForTruthy(() => turns(ctx.root).some((t) => t.text.includes("G1-MESSAGE")), "turn without operating marker");
      await waitForTruthy(async () => (await active(ctx)).runs === 0, "turn finished");
      const prior = turns(ctx.root).length;

      await withEnvironment(ops(fd), async () => {
        const a = await send(ctx, "FIRST at start");
        const b = await send(ctx, "SECOND at start");
        assert.equal(a.queued, true, JSON.stringify(a));
        assert.equal(a.locked, true, JSON.stringify(a));
        assert.equal(b.queued, true, JSON.stringify(b));
        assert.deepEqual(b.queue.map((q) => q.text), ["FIRST at start", "SECOND at start"]);
        // Decided synchronously in the route: no run, both entries in the queue, no wait row.
        const s = await active(ctx);
        assert.equal(s.runs, 0);
        assert.equal(s.open.queue, 2);
        assert.equal(await waitRow(ctx), null);
        assert.equal(turns(ctx.root).length, prior, "no turn during the start");
        assert.ok(!(await history(ctx)).some((m) => m.role === "user" && m.text.includes("at start")), "the user row is created only at the start");

        setInstanceState(p.id, "main", "ready");
        await waitForTruthy(() => turns(ctx.root).length > prior, "turn after ready");
        await ctx.waitForQuiet();
      });
      const fresh = turns(ctx.root).slice(prior);
      assert.equal(fresh.length, 1, `the two queued messages run bundled: ${JSON.stringify(fresh.map((t) => t.text))}`);
      assert.ok(fresh[0].text.includes("FIRST at start") && fresh[0].text.includes("SECOND at start"), fresh[0].text);
      const log = await history(ctx);
      const i1 = log.findIndex((m) => m.role === "user" && m.text.includes("FIRST at start"));
      const i2 = log.findIndex((m) => m.role === "user" && m.text.includes("SECOND at start"));
      const response = log.findIndex((m, i) => i > i2 && m.role === "assistant");
      assert.ok(i1 >= 0 && i2 > i1 && response > i2, `user → user → assistant: ${JSON.stringify(log.map((m) => m.role))}`);
      assert.deepEqual(fd.calls(), [], "no docker");
    }));
  } finally { fd.cleanUp(); }
});

// ── (4) Direct doRun ──────────────────────────────────────────────────────────────────────────────────────────────

test("(4) direct doRun (goal gate, round at the completion gate): wait row \"project\" instead of a spawn, \"Try now\" holds; after ready it runs", async () => {
  const fd = await fakeDocker();
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const p = await projectWithChat(ctx, "Direct");
      await withEnvironment(ops(fd), async () => {
        setInstanceState(p.id, "main", "recreate");
        await doRun(store.getChat(ctx.chat.id), "DIRECT-JOB");
        assert.equal(turns(ctx.root).length, 0, "no turn");
        const w = await waitRow(ctx);
        assert.equal(w?.reason, "project", JSON.stringify(w));
        assert.equal(w.gate, false);
        assert.equal((await active(ctx)).runs, 0);
        const hint = (await history(ctx)).filter((m) => m.role === "hint");
        assert.equal(hint.length, 1, JSON.stringify(hint));
        assert.match(hint[0].text, /neu angelegt/);
        // "Try now" stops at the lock: no start, the row stays (without an attempt).
        const now = await post(`${ctx.base}/api/chats/${ctx.chat.id}/auto-continue/now`, {});
        assert.equal(now.ok, false);
        const w2 = await waitRow(ctx);
        assert.equal(w2?.reason, "project");
        assert.equal(w2.attempts, 0);
        assert.equal(turns(ctx.root).length, 0, "no turn after \"Try now\"");
        assert.ok(!(await history(ctx)).some((m) => m.role === "limit"), "no limit row — it is no limit");

        setInstanceState(p.id, "main", "ready");
        await waitForTruthy(() => turns(ctx.root).length === 1, "turn after ready");
        await ctx.waitForQuiet();
      });
      assert.ok(turns(ctx.root)[0].text.includes("DIRECT-JOB"));
      assert.equal(await waitRow(ctx), null, "the wait row is cleared away");
      assert.equal(store.getPendingResume(ctx.chat.id), null);
    }));
  } finally { fd.cleanUp(); }
});

// ── (5) Driver step ──────────────────────────────────────────────────────────────────────────────────────────────

test("(5) graph workflow: the driver step waits in the wait row (project, workflow), no spawn; after ready it runs, the run ends done", async () => {
  const fd = await fakeDocker();
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const p = await projectWithChat(ctx, "Graph");
      const flow = await createFlow(ctx, p.id, "Driver", oneNode("DRIVER-JOB"));
      await withEnvironment(ops(fd), async () => {
        setInstanceState(p.id, "main", "start");
        const r = await flowStart(ctx, flow.id);
        // Waits for the row OR a turn: without the lock at the head of doRun the step would run — red instead of hanging.
        await waitForTruthy(async () => (await waitRow(ctx))?.reason === "project" || turns(ctx.root).length > 0, "wait row or turn of the driver step");
        assert.equal(turns(ctx.root).length, 0, "the driver step does not spawn");
        const w = await waitRow(ctx);
        assert.equal(w?.reason, "project", JSON.stringify(w));
        assert.equal(w.workflow, true, "the row carries the workflow");
        assert.equal(w.kind, "run");
        assert.equal((await runStatus(ctx, r.run.id)).status, "running");
        assert.equal((await active(ctx)).runs, 0);
        assert.equal(turns(ctx.root).length, 0, "the driver step does not spawn");

        setInstanceState(p.id, "main", "ready");
        const end = await waitForTruthy(async () => { const x = await runStatus(ctx, r.run.id); return ["done", "failed", "cancelled"].includes(x.status) ? x : null; }, "run closed");
        assert.equal(end.status, "done", `${end.status}: ${end.note}`);
        await ctx.waitForQuiet();
      });
      assert.equal(turns(ctx.root).length, 1);
      assert.ok(turns(ctx.root)[0].text.includes("DRIVER-JOB"));
      assert.equal(store.getPendingResume(ctx.chat.id), null);
    }));
  } finally { fd.cleanUp(); }
});

// ── (6) Gate step after approval ──────────────────────────────────────────────────────────────────────────────────

test("(6) gate step: a stopped step gets a new task — locked it waits (no spawn), after ready it runs", async () => {
  const fd = await fakeDocker();
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const p = await projectWithChat(ctx, "Gate");
      const flow = await createFlow(ctx, p.id, "Stopped", oneNode("GATE-JOB {MAINGATE:g1}"));
      const r = await flowStart(ctx, flow.id);
      await ctx.gate.reached("g1");
      await post(`${ctx.base}/api/chats/${ctx.chat.id}/stop`, {});
      await waitForTruthy(async () => (await runStatus(ctx, r.run.id)).status === "waiting", "run holds at the stopped step");
      await waitForTruthy(async () => (await active(ctx)).runs === 0, "turn finished");
      const prior = turns(ctx.root).length;
      await withEnvironment(ops(fd), async () => {
        setInstanceState(p.id, "main", "start");
        const a = await send(ctx, "NEW-JOB for the same step");
        assert.equal(a.workflow, true, JSON.stringify(a));
        await waitForTruthy(async () => (await waitRow(ctx))?.reason === "project" || turns(ctx.root).length > prior, "wait row or turn of the gate step");
        assert.equal(turns(ctx.root).length, prior, "the gate step does not spawn");
        const w = await waitRow(ctx);
        assert.equal(w?.reason, "project", JSON.stringify(w));
        assert.equal(w.workflow, true);
        assert.equal((await active(ctx)).runs, 0);
        assert.equal(turns(ctx.root).length, prior, "the gate step does not spawn");

        setInstanceState(p.id, "main", "ready");
        await waitForTruthy(() => turns(ctx.root).length > prior, "turn after ready");
        const end = await waitForTruthy(async () => { const x = await runStatus(ctx, r.run.id); return ["done", "failed", "cancelled"].includes(x.status) ? x : null; }, "run closed");
        assert.equal(end.status, "done", `${end.status}: ${end.note}`);
        await ctx.waitForQuiet();
      });
      assert.ok(turns(ctx.root)[prior].text.includes("NEW-JOB"), turns(ctx.root)[prior].text);
    }));
  } finally { fd.cleanUp(); }
});

// ── (7) error ──────────────────────────────────────────────────────────────────────────────────────────────────────

test("(7) error of a converted project: the message ends at once — hint (once in the stream), run_aborted, busy:false, no spawn; the user row stays", async () => {
  const fd = await fakeDocker();
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const p = await projectWithChat(ctx, "Broken");
      const stream = recording(ctx.base, ctx.chat.id);
      try {
        await stream.connected();
        await withEnvironment(ops(fd), async () => {
          setInstanceState(p.id, "main", "error", { error: "network detach missing", convertedAt: Date.now() });
          const a = await send(ctx, "MESSAGE on error");
          assert.equal(a.queued, false, JSON.stringify(a));
          const bar = await ctx.barrier(stream);
          const s = await active(ctx);
          assert.equal(s.busy, false);
          assert.equal(s.runs, 0);
          const log = await history(ctx);
          const u = log.findIndex((m) => m.role === "user" && m.text === "MESSAGE on error");
          const h = log.findIndex((m) => m.role === "hint" && m.text.includes("Projekt-Container nicht bereit: network detach missing"));
          assert.ok(u >= 0 && h > u, `user row, then hint: ${JSON.stringify(log.map((m) => [m.role, m.text.slice(0, 40)]))}`);
          // The text is in the stream ONCE: as a hint row (`row`), the end of the waiting without text (`run_aborted`).
          const soFar = stream.events.slice(0, bar);
          const TEXT = /Projekt-Container nicht bereit: network detach missing/;
          const rows = soFar.filter((e) => e.type === "row" && e.row?.role === "hint" && TEXT.test(e.row?.text || ""));
          assert.equal(rows.length, 1, `the hint row live: ${JSON.stringify(soFar.map((e) => [e.type, e.subtype || e.row?.role]))}`);
          const end = soFar.filter((e) => e.type === "harness" && e.subtype === "run_aborted");
          assert.equal(end.length, 1, JSON.stringify(end));
          assert.equal(end[0].reason, "project");
          const duplicate = soFar.filter((e) => e.type === "harness" && e.subtype === "run_error" && TEXT.test(String(e.stderr || "")));
          assert.deepEqual(duplicate, [], "the same text once more as run_error — twice in the open chat");
          assert.equal(await waitRow(ctx), null, "error does not wait");
        });
      } finally { await stream.stop(); }
      await ctx.waitForQuiet();
      assert.equal(turns(ctx.root).length, 0, "no spawn");
    }));
  } finally { fd.cleanUp(); }
});

// ── (8) Relocation: subagent and oneshot ─────────────────────────────────────────────────────────────────────────────────

test("(8) relocation: a subagent start gets a tool error with reason, a oneshot of the chat is rejected", async () => {
  const fd = await fakeDocker();
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const p = await projectWithChat(ctx, "Relocation");
      // The turn is already running (idle would have seen it — here the instance is switched by hand) and starts its
      // subagent only AFTER the gate.
      await send(ctx, `{MAINGATE:u1} AG:${JSON.stringify({ description: "relocation", prompt: "Check {TAG:u}", run_in_background: false })}`);
      await ctx.gate.reached("u1");
      await withEnvironment(ops(fd), async () => {
        setInstanceState(p.id, "main", "relocation");
        ctx.gate.open("u1");
        await waitForTruthy(() => fs.existsSync(path.join(ctx.root, "ag-relocation")), "result of the subagent call");
        const ag = fs.readFileSync(path.join(ctx.root, "ag-relocation"), "utf8");
        assert.match(ag, /zieht in seinen Container um/, ag);
        assert.equal(spawns(ctx.root, "u"), 0, "no subagent started");
        let error = null;
        try { await runOnce("Say OK", { model: "claude::claude-haiku-4-5-20251001", chatId: ctx.chat.id, cwd: ctx.root }); } catch (e) { error = e; }
        assert.ok(error, "the oneshot ran during the relocation");
        assert.match(error.message, /kein Modellaufruf während des Umzugs/);
        await waitForTruthy(async () => (await active(ctx)).runs === 0, "turn finished");
        setInstanceState(p.id, "main", "ready");
      });
      await ctx.waitForQuiet();
    }));
  } finally { fd.cleanUp(); }
});

// ── (9) Idle and projectLocks ─────────────────────────────────────────────────────────────────────────────────

// Read a terminal's stream to its end — `event: exit` ends it (terminal.js).
function terminalReader(base, id) {
  let text = "";
  const done = (async () => {
    const res = await fetch(`${base}/api/terminal/${id}/stream`, { headers: { Connection: "close" } });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) return;
      text += decoder.decode(value, { stream: true });
    }
  })();
  return { text: () => text, end: done };
}

test("(9) projectLocks: lock, then idle — subagent lives resp. workflow waits ⇒ open, released; quiet ⇒ terminals ended with a message, turns wait, resolve wakes", async () => {
  const fd = await fakeDocker();
  const terminals = [];
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const p = await projectWithChat(ctx, "Idle");
      // (a) a living background agent
      await send(ctx, `AG:${JSON.stringify({ description: "alongside", prompt: "Read {TAG:h} {GATE:h}", run_in_background: true })}`);
      await ctx.gate.reached("h-1");
      await waitForTruthy(async () => (await active(ctx)).runs === 0, "turn finished, the agent lives");
      const l1 = projectIdle(p.id);
      assert.equal(l1.quiet, false);
      assert.ok(l1.open.some((o) => o.reason === "agent" && o.chatId === ctx.chat.id), JSON.stringify(l1.open));
      await withEnvironment(ops(fd), async () => {
        const s = projectLocks(p.id, { reason: "relocation" });
        assert.equal(s.ok, false, JSON.stringify(s));
        assert.ok(s.open.some((o) => o.reason === "agent"), JSON.stringify(s.open));
        assert.equal(projectLocked(p.id), null, "the lock is released");
      });
      ctx.gate.open("h-1");
      await ctx.waitForQuiet();
      assert.deepEqual(projectIdle(p.id).open, [], "quiet after the agent");

      // (b) a workflow run in `waiting` (between two steps at a gate — no turn runs)
      store.startWorkflowRun({ id: "wf-run-lock", chatId: ctx.chat.id, workflowId: "wf-x", workflowName: "X", workspaceId: ctx.ws.id, projectId: p.id });
      store.updateWorkflowRun(ctx.chat.id, { status: "waiting" });
      try {
        const l2 = projectIdle(p.id);
        assert.deepEqual(l2.open.map((o) => o.reason), ["workflow"], JSON.stringify(l2.open));
        await withEnvironment(ops(fd), async () => {
          const s = projectLocks(p.id, { reason: "recreate" });
          assert.equal(s.ok, false);
          assert.equal(projectLocked(p.id), null);
        });
      } finally { store.updateWorkflowRun(ctx.chat.id, { status: "cancelled" }); }
      assert.equal(projectIdle(p.id).quiet, true);

      // (c) quiet: a shell of the project and one of the chat, a foreign one
      const shell = async (tag) => {
        const r = await post(`${ctx.base}/api/workspaces/${ctx.ws.id}/terminal`, { cols: 80, rows: 24, tag });
        assert.equal(r.available, true, `node-pty fehlt: ${JSON.stringify(r)}`);
        terminals.push(r.id);
        return r.id;
      };
      const tProj = await shell(`proj:${p.id}`);
      const tChat = await shell(`chat:${ctx.chat.id}`);
      const tForeign = await shell("ws:foreign");
      const reader = terminalReader(ctx.base, tProj);
      // The reader is connected when a character comes through ITS subscription (the shell's buffer is passed on at subscription).
      await post(`${ctx.base}/api/terminal/${tProj}/input`, { data: "echo READY\r" });
      await waitForTruthy(() => reader.text().includes("READY"), "terminal connected");
      assert.equal(projectIdle(p.id).terminals, 2, "terminals do not count as open, but are there");
      await withEnvironment(ops(fd), async () => {
        const s = projectLocks(p.id, { reason: "relocation" });
        assert.equal(s.ok, true, JSON.stringify(s));
        assert.equal(s.terminalsEnded, 2);
        assert.deepEqual(projectLocked(p.id)?.reason, "relocation");
        const alive = async (tid) => (await json(`${ctx.base}/api/terminal/${tid}/exists`)).exists;
        assert.equal(await alive(tProj), false);
        assert.equal(await alive(tChat), false);
        assert.equal(await alive(tForeign), true, "a foreign shell stays");
        await reader.end;
        assert.match(reader.text(), /Das Projekt zieht in seinen Container um — dieses Terminal wurde beendet\./);
        assert.match(reader.text(), /event: exit/);
        // A second lock while the first stands: refused.
        assert.equal(projectLocks(p.id, { reason: "recreate" }).ok, false);
        // A new turn waits.
        const prior = turns(ctx.root).length;
        const a = await send(ctx, "DURING the lock");
        assert.equal(a.locked, true, JSON.stringify(a));
        assert.equal(turns(ctx.root).length, prior);
        assert.equal(s.resolve(), true);
        await waitForTruthy(() => turns(ctx.root).some((t) => t.text.includes("DURING the lock")), "turn after the release");
        await ctx.waitForQuiet();
      });
      assert.deepEqual(fd.calls(), [], "no docker");
    }));
  } finally {
    // Straight at the module (the server is already closed here): a living login shell would keep the event loop open.
    for (const id of terminals) killTerminal(id);
    fd.cleanUp();
  }
});

// ── (10) Workflow agent of a dynamic workflow ─────────────────────────────────────────────────────────────────

test("(10) workflow agent in start: waits (journal \"waiting\", reason project), no spawn; after ready it starts, no failed agent", async () => {
  const fd = await fakeDocker();
  process.env.CBASE_DYNWF_STAGGER_MS = "0";
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const p = await projectWithChat(ctx, "Dyn");
      await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
      const script = [
        "export const meta = { name: 'lock', description: 'Lock', phases: [{ title: 'One' }] }",
        "const a = await agent('A {TAG:a} {GATE:a}', { label: 'a' });",
        "const b = await agent('B {TAG:b}', { label: 'b' });",
        "return { a, b };",
      ].join("\n");
      await send(ctx, `WF[s]:${JSON.stringify({ script })}`);
      await waitForTruthy(() => fs.existsSync(path.join(ctx.root, "wf-s")), "tool result");
      const r = JSON.parse(fs.readFileSync(path.join(ctx.root, "wf-s"), "utf8"));
      assert.equal(r.status, "started", JSON.stringify(r));
      await ctx.gate.reached("a-1");
      const entries = (n) => store.readDynJournal(r.runId).filter((e) => e.n === n);
      await withEnvironment(ops(fd), async () => {
        setInstanceState(p.id, "main", "start");
        ctx.gate.open("a-1");
        const b = await waitForTruthy(() => entries(2).find((e) => e.kind !== "launched") || null, "state of agent #2");
        assert.equal(b.kind, "waiting", `the agent does not wait: ${JSON.stringify(b)}`);
        assert.equal(b.reason, "project");
        assert.equal(b.state, "start");
        assert.equal(spawns(ctx.root, "b"), 0, "no spawn in start");
        assert.equal(projectWaitingCount(), 1);

        setInstanceState(p.id, "main", "ready");
        const run = await waitForTruthy(() => (store.readDynRun(r.runId)?.status !== "running" ? store.readDynRun(r.runId) : null), "run finished");
        assert.equal(projectWaitingCount(), 0);
        assert.equal(spawns(ctx.root, "b"), 1);
        assert.ok(!store.readDynJournal(r.runId).some((e) => e.kind === "failed"), JSON.stringify(store.readDynJournal(r.runId).filter((e) => e.kind === "failed")));
        assert.equal(run.status, "finished", JSON.stringify(run));
        assert.deepEqual(entries(2).map((e) => e.kind), ["launched", "waiting", "started", "result"]);
        await ctx.waitForQuiet();
      });
    }));
  } finally {
    delete process.env.CBASE_DYNWF_STAGGER_MS;
    fd.cleanUp();
  }
});

// ── (11) Server end ───────────────────────────────────────────────────────────────────────────────────────────

// As in projectbox-server-end.test.js: the row straight into the database of the server process (the harness's read access
// is readOnly); `convertedAt` NULL takes the conversion back — so that the turn in the next process runs without a project
// container (here it is about the time, not the place).
function writeRow(dataRoot, projectId, containerId) {
  const raw = new DatabaseSync(path.join(dataRoot, "data", "automater.db"), { timeout: 2_147_483_647 });
  try {
    const t = Date.now();
    raw.prepare(`INSERT INTO project_instances (project_id, instance, container_id, state, converted_at, state_since, created_at, updated_at)
      VALUES (?, 'main', ?, 'ready', ?, ?, ?, ?)`).run(projectId, containerId, t, t, t, t);
  } finally { raw.close(); }
}
function notMoreConverted(dataRoot, projectId) {
  const raw = new DatabaseSync(path.join(dataRoot, "data", "automater.db"), { timeout: 2_147_483_647 });
  try { raw.prepare("UPDATE project_instances SET converted_at = NULL WHERE project_id = ?").run(projectId); }
  finally { raw.close(); }
}
async function gateOrEnd(fd, alive) {
  const marker = path.join(fd.dir, "gates", "stop.waiting");
  for (;;) {
    if (fs.existsSync(marker)) return "gate";
    if (!alive()) return "end";
    await pause(15);
  }
}
// The end of the server process: exit 0 — or the one named exception from projectbox-server-end.test.js (onnxruntime
// aborts with SIGABRT AFTER process.exit(0) under CBASE_CONTAINER=1), only with exactly this line in the log.
function assertOrdered(end, root) {
  if (end.code === 0 && end.signal === null) return;
  assert.equal(end.signal, "SIGABRT", `no orderly end: ${JSON.stringify(end)}`);
  const log = fs.readdirSync(root).filter((n) => /^server-\d+\.log$/.test(n)).map((n) => fs.readFileSync(path.join(root, n), "utf8")).join("\n");
  assert.match(log, /libc\+\+abi: terminating due to uncaught exception of type std::__1::system_error: mutex lock failed/,
    `SIGABRT without the known destructor line of onnxruntime: ${JSON.stringify(end)}`);
}

// Another chat in the harness's workspace — without a project, or in a new project (without an instance row).
async function newChat(ctx, projectName = null) {
  const c = await post(`${ctx.base}/api/chats`, { workspaceId: ctx.ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" });
  if (projectName) {
    const filePath = path.join(ctx.root, "workspace", projectName.toLowerCase());
    fs.mkdirSync(filePath, { recursive: true });
    const p = await ctx.projectWithoutInstance({ name: projectName, path: filePath });
    await json(`${ctx.base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
  }
  return c;
}
const waitRowOf = async (ctx, chatId) => (await json(`${ctx.base}/api/chats/${chatId}/auto-continue`)).wait;

test("(11) while the server ends, a message to a converted project is queued — no turn; after the restart it runs", async () => {
  const fd = await fakeDocker({ stopGate: "stop" });
  try {
    await withoutAccount(() => withEnvironment({ ...ops(fd), CBASE_SERVER_END_MS: "3600000" }, () => withAgentsServer(async (ctx) => {
      // The finally opens the gate at the latest: otherwise the harness cleanup (SIGTERM, then waiting for the end) would wait
      // an hour at the stop chain instead of reporting the error.
      try {
        const p = await projectWithChat(ctx, "End");
        const cid = execFileSync(fd.bin, ["run", "-d", "--name", `cbase-p-${p.id}`, "--label", `cbase.project=${p.id}`, "cbase-projectbox:latest"], { encoding: "utf8" }).trim();
        writeRow(ctx.dataRoot, p.id, cid);
        // A chat without project and one in a project without instance row — both are NOT converted.
        const without = await newChat(ctx);
        const not = await newChat(ctx, "WithoutRow");
        // Before the end a turn runs like any other (ready, converted): the lock is not the cause of everything.
        await send(ctx, "PRIOR");
        await waitForTruthy(() => turns(ctx.root).length === 1, "turn before the end");
        await waitForTruthy(async () => (await active(ctx)).runs === 0, "turn finished");

        const { ended, alive } = ctx.signal("SIGTERM");
        assert.equal(await gateOrEnd(fd, alive), "gate", "the process ended before the stop chain stood at the gate");
        const a = await send(ctx, "DURING the end");
        assert.equal(a.queued, true, JSON.stringify(a));
        assert.equal(a.locked, true, JSON.stringify(a));
        assert.equal((await active(ctx)).runs, 0, "no run in the ending process");
        // "Only converted projects" hangs on the order in the lock (serverEnds AFTER the project and the row check) — the
        // other two chats run in the ending process as before, without a wait row "server end".
        for (const [chat, text] of [[without, "WITHOUT-PROJECT at the end"], [not, "WITHOUT-ROW at the end"]]) {
          const r = await post(`${ctx.base}/api/chats/${chat.id}/message`, { text });
          assert.equal(r.queued, false, `${text}: queued instead of started — ${JSON.stringify(r)}`);
          assert.notEqual(r.locked, true, text);
          await waitForTruthy(() => turns(ctx.root).some((t) => t.text.includes(text)), `turn "${text}" in the ending process`);
        }
        await waitForTruthy(async () => (await active(ctx)).runs === 0, "the two turns finished");
        for (const chat of [without, not]) assert.equal(await waitRowOf(ctx, chat.id), null, `${chat.id}: a wait row in the ending process`);
        notMoreConverted(ctx.dataRoot, p.id);
        fd.openGate("stop");
        assertOrdered(await ended, ctx.root);
        // No turn of the converted project ran in the ending process — only the other two.
        assert.ok(!turns(ctx.root).some((t) => t.text.includes("DURING the end")), "a turn of the converted project in the ending process");
        assert.equal(turns(ctx.root).length, 3, JSON.stringify(turns(ctx.root).map((t) => t.text)));

        await ctx.crash(); // a new server process on the same data folder, restart grace at once
        await waitForTruthy(() => turns(ctx.root).some((t) => t.text.includes("DURING the end")), "turn after the restart");
        await ctx.waitForQuiet();
        const log = await history(ctx);
        const u = log.findIndex((m) => m.role === "user" && m.text.includes("DURING the end"));
        assert.ok(u >= 0 && log.slice(u + 1).some((m) => m.role === "assistant"), `user → assistant: ${JSON.stringify(log.map((m) => m.role))}`);
        // The restart does not make them up once more (no row, no queue entry).
        for (const text of ["WITHOUT-PROJECT at the end", "WITHOUT-ROW at the end"]) {
          assert.equal(turns(ctx.root).filter((t) => t.text.includes(text)).length, 1, `${text}: once more after the restart`);
        }
      } finally { fd.openGate("stop"); }
    }, { claude: CLAUDE, childProcess: true })));
  } finally { fd.cleanUp(); }
});

// ── (12) Project switch: the core stays on its project ─────────────────────────────────────

// Move the chat into a new project B (the core of the old one stays where it is).
async function switchProject(ctx, name) {
  const filePath = path.join(ctx.root, "workspace", name.toLowerCase());
  fs.mkdirSync(filePath, { recursive: true });
  const b = await post(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { name, path: filePath });
  await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: b.id }) });
  return b;
}

test("(12) project switch with a living subagent: idle and lock of A see it, a start from its core is rejected at A's lock", async () => {
  const fd = await fakeDocker();
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const a = await projectWithChat(ctx, "Old");
      await send(ctx, `AG:${JSON.stringify({ description: "pinned", prompt: "Read {TAG:f} {GATE:f} {ENKEL}", run_in_background: true })}`);
      await ctx.gate.reached("f-1");
      await waitForTruthy(async () => (await active(ctx)).runs === 0, "turn finished, the agent lives");
      await switchProject(ctx, "Fresh");
      assert.deepEqual(store.chatIdsInProject(a.id), [], "the chat no longer stands in A");

      const l = projectIdle(a.id);
      assert.equal(l.quiet, false, "the agent in A's core dropped out of A's idle because its chat stands elsewhere");
      assert.ok(l.open.some((o) => o.reason === "agent" && o.chatId === ctx.chat.id && o.agentId), JSON.stringify(l.open));
      await withEnvironment(ops(fd), async () => {
        const s = projectLocks(a.id, { reason: "relocation" });
        assert.equal(s.ok, false, `A's lock overlooked the agent: ${JSON.stringify(s)}`);
        assert.ok(s.open.some((o) => o.reason === "agent"), JSON.stringify(s.open));
        assert.equal(projectLocked(a.id), null, "the lock is released");

        // A's instance relocates: the agent now calls its grandchild — a start FROM A's core. It is rejected with A's reason
        // although the chat stands in B (B is free).
        setInstanceState(a.id, "main", "relocation");
        ctx.gate.open("f-1");
        await waitForTruthy(() => fs.existsSync(path.join(ctx.root, "grandchild-result")), "result of the grandchild call");
        const t = fs.readFileSync(path.join(ctx.root, "grandchild-result"), "utf8");
        assert.match(t, /zieht in seinen Container um/, `the grandchild ran past A's lock: ${t.slice(0, 300)}`);
        assert.equal(spawns(ctx.root, "grandchild"), 0, "no grandchild started");
        setInstanceState(a.id, "main", "ready");
      });
      await ctx.waitForQuiet();
      assert.equal(projectIdle(a.id).quiet, true, "after the agent A is quiet");
    }));
  } finally { fd.cleanUp(); }
});

test("(12b) project switch with a running dynamic workflow: its core counts in A's idle, its next agent waits at A's lock", async () => {
  const fd = await fakeDocker();
  process.env.CBASE_DYNWF_STAGGER_MS = "0";
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const a = await projectWithChat(ctx, "DynOld");
      await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
      const script = [
        "export const meta = { name: 'switch', description: 'Switch', phases: [{ title: 'One' }] }",
        "const a = await agent('A {TAG:wa} {GATE:wa}', { label: 'a' });",
        "const b = await agent('B {TAG:wb}', { label: 'b' });",
        "return { a, b };",
      ].join("\n");
      await send(ctx, `WF[w]:${JSON.stringify({ script })}`);
      await waitForTruthy(() => fs.existsSync(path.join(ctx.root, "wf-w")), "tool result");
      const r = JSON.parse(fs.readFileSync(path.join(ctx.root, "wf-w"), "utf8"));
      assert.equal(r.status, "started", JSON.stringify(r));
      await ctx.gate.reached("wa-1");
      await waitForTruthy(async () => (await active(ctx)).runs === 0, "turn finished, the workflow runs");
      await switchProject(ctx, "DynNew");

      const reason = projectIdle(a.id).open.map((o) => o.reason);
      assert.ok(reason.includes("workflow") && reason.includes("workflowagent"), `the workflow in A's core dropped out of A's idle: ${reason}`);
      const entries = (n) => store.readDynJournal(r.runId).filter((e) => e.n === n);
      await withEnvironment(ops(fd), async () => {
        setInstanceState(a.id, "main", "start");
        ctx.gate.open("wa-1");
        const b = await waitForTruthy(() => entries(2).find((e) => e.kind !== "launched") || null, "state of agent #2");
        assert.equal(b.kind, "waiting", `agent #2 does not wait at A's lock: ${JSON.stringify(b)}`);
        assert.equal(b.reason, "project");
        assert.equal(spawns(ctx.root, "wb"), 0, "no spawn while A starts");
        setInstanceState(a.id, "main", "ready");
        const run = await waitForTruthy(() => (store.readDynRun(r.runId)?.status !== "running" ? store.readDynRun(r.runId) : null), "run finished");
        assert.equal(run.status, "finished", JSON.stringify(run));
        assert.equal(spawns(ctx.root, "wb"), 1);
        await ctx.waitForQuiet();
      });
      assert.equal(projectIdle(a.id).quiet, true, "after the workflow A is quiet");
    }));
  } finally {
    delete process.env.CBASE_DYNWF_STAGGER_MS;
    fd.cleanUp();
  }
});

// ── (13) The criteria of idle as a named table ─────────────────────────────────────────────────────

// What projectbox/idle.js counts beyond the archive's open work (runs/archive.js ARCHIVE_REASONS, without "question"; a live monitor is one of them).
// The work a core keeps after a project switch (coresInProject) is held by (12)/(12b).
const IDLE_ADDITION = ["verdict", "oneshot", "graph-start"];
// Reasons of open work that idle does NOT count (projectbox/idle.js): the question (its answer is a new turn — the lock
// holds that) and the copy (step 0 of its clear-away asks idle).
const NOT_IDLE = ["question", "copy"];
// Per criterion: `establish(chatId, projectId, workspaceId, ctx)` → cleanup (may return a promise). Established and
// checked without a macrotask in between — no other code of the process clears the state beforehand. The real subagent
// ("agent") stands for itself.
const IDLE_CRITERIA = [
  { reason: "running", establish: (c) => { running.add(c); return () => running.delete(c); } },
  { reason: "agent", real: true },
  { reason: "dynworkflow", establish: (c) => {
    setBackgroundSource(({ chatId } = {}) => (!chatId || chatId === c ? [{ chatId: c, runId: "dyn-pd3", name: "pd3", startedAt: Date.now() }] : []));
    return () => setBackgroundSource(dynWorkflowsOpen); // the source server.js sets
  } },
  { reason: "graphWorkflow", establish: (c) => {
    const z = store.createGraphStart({ id: "gs-hg-pd3", chatId: c, workflowId: "wf-pd3", workflowName: "PD3", background: true, status: "earmarked" });
    return () => store.changeGraphStart(z.id, { status: "stopped" });
  } },
  { reason: "interrupted", establish: (c) => { store.setActiveRun(c, { prompt: "pd3" }); return () => store.clearActiveRun(c); } },
  { reason: "compacted", establish: (c) => { compacting.add(c); return () => compacting.delete(c); } },
  { reason: "queue", establish: (c) => { pendingRunInputs.set(c, [{ id: "pd3", prompt: "pd3", display: "pd3" }]); return () => pendingRunInputs.delete(c); } },
  { reason: "waitRow", establish: (c) => {
    store.setPendingResume(c, { prompt: "pd3", reason: "reset", dueAt: Date.now() + 3_600_000 });
    return () => store.clearPendingResume(c);
  } },
  { reason: "workflow", establish: (c, p, ws) => {
    store.startWorkflowRun({ id: "wf-run-pd3", chatId: c, workflowId: "wf-pd3", workflowName: "PD3", workspaceId: ws, projectId: p });
    store.updateWorkflowRun(c, { status: "waiting" });
    return () => store.updateWorkflowRun(c, { status: "cancelled" });
  } },
  { reason: "approval", establish: (c) => { pendingPermissions.set("perm-pd3", { chatId: c }); return () => pendingPermissions.delete("perm-pd3"); } },
  { reason: "target", establish: (c) => { targetCheckOn(c); return () => targetCheckOff(c); } },
  // A REAL monitor on the chat (runs/monitors.js).
  { reason: "monitor", establish: (c) => {
    const location = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-lock-monitor-"));
    startMonitor(c, { command: "sleep 600", description: "Lock", report: "end" }, { cwd: location, outputLocation: location, deliver: () => {} });
    return () => { closeMonitors(c); fs.rmSync(location, { recursive: true, force: true }); };
  } },
  { reason: "verdict", establish: (c) => { runningVerdicts.set(c, 1); return () => runningVerdicts.delete(c); } },
  // Counted from the entry into runOnce (providers/index.js) — synchronously, before the first await.
  { reason: "oneshot", establish: (c, _p, _ws, ctx) => {
    const run = runOnce("Say OK", { model: "claude::claude-haiku-4-5-20251001", chatId: c, cwd: ctx.root }).catch(() => null);
    return () => run;
  } },
  { reason: "graph-start", establish: (c) => {
    const z = store.createGraphStart({ id: "gs-vg-pd3", chatId: c, workflowId: "wf-pd3", workflowName: "PD3", background: false, status: "earmarked" });
    return () => store.changeGraphStart(z.id, { status: "stopped" });
  } },
];

test("(13) the table of idle criteria names every reason of open work (without the question) and the three additions — no more, no fewer", () => {
  const desired = [...ARCHIVE_REASONS.filter((g) => !NOT_IDLE.includes(g)), ...IDLE_ADDITION].sort();
  assert.deepEqual(IDLE_CRITERIA.map((k) => k.reason).sort(), desired,
    "ARCHIVE_REASONS (runs/archive.js) or idle has gained or lost a reason — row in IDLE_CRITERIA");
});

test("(13) one state per criterion — `open` names exactly this reason, projectLocks refuses; the open question alone is quiet", async () => {
  const fd = await fakeDocker();
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const p = await projectWithChat(ctx, "Criteria");
      const c = ctx.chat.id;
      const check = async (reason, way) => {
        let l = null;
        let s = null;
        try {
          l = projectIdle(p.id);
          s = await withEnvironment(ops(fd), async () => projectLocks(p.id, { reason: "relocation" }));
        } finally {
          if (s?.ok) s.resolve();
          await way?.();
        }
        assert.deepEqual(l.open.map((o) => [o.chatId, o.reason]), [[c, reason]], `${reason}: ${JSON.stringify(l.open)}`);
        assert.equal(s.ok, false, `${reason}: projectLocks locked a project that is not idle`);
        assert.deepEqual(s.open.map((o) => o.reason), [reason], reason);
        assert.equal(projectLocked(p.id), null, `${reason}: the lock stayed`);
        assert.equal(projectIdle(p.id).quiet, true, `${reason}: not quiet after the cleanup — ${JSON.stringify(projectIdle(p.id).open)}`);
      };
      // A first turn with title, so that no oneshot of the chat falls into one of the checks.
      await send(ctx, "WARM_UP");
      await ctx.waitForQuiet();
      await waitForTruthy(() => runningOneshotsOf(c) === 0, "oneshots of the first turn finished");
      assert.equal(projectIdle(p.id).quiet, true, JSON.stringify(projectIdle(p.id).open));

      // "agent": a real background agent that lives at the gate after its turn has ended.
      await send(ctx, `AG:${JSON.stringify({ description: "criterion", prompt: "Read {TAG:lk} {GATE:lk}", run_in_background: true })}`);
      await ctx.gate.reached("lk-1");
      await waitForTruthy(async () => (await active(ctx)).runs === 0 && runningOneshotsOf(c) === 0, "turn finished, the agent lives");
      await check("agent", async () => { ctx.gate.open("lk-1"); await ctx.waitForQuiet(); });
      await waitForTruthy(() => runningOneshotsOf(c) === 0, "oneshots after the agent finished");

      for (const k of IDLE_CRITERIA.filter((x) => !x.real)) {
        const way = k.establish(c, p.id, ctx.ws.id, ctx);
        await check(k.reason, way);
      }

      // The open question does NOT count (its answer is a new turn — the lock holds that).
      store.addMessage(c, "ask", JSON.stringify({ requestId: "rq-pd3", questions: [{ question: "Continue?" }] }));
      try {
        assert.deepEqual(openWork(c).map((o) => o.reason), ["question"], "the question is not open — the state is missing");
        assert.equal(projectIdle(p.id).quiet, true, JSON.stringify(projectIdle(p.id).open));
      } finally { store.addMessage(c, "ask_answer", JSON.stringify({ requestId: "rq-pd3" })); }
      // The chat's copy under construction counts for the archive, NOT for idle.
      setCopyWork((id) => (id === c ? { name: "k1", state: "build", phase: "clone1" } : null));
      try {
        assert.deepEqual(openWork(c).map((o) => o.reason), ["copy"], "the copy is not open — the state is missing");
        assert.equal(projectIdle(p.id).quiet, true, JSON.stringify(projectIdle(p.id).open));
      } finally { setCopyWork(copyWorkOf); } // the source server.js sets
      await ctx.waitForQuiet();
    }));
  } finally { fd.cleanUp(); }
});

// ── (14) A limit row at the lock keeps its reason ─────────────────────────────────────────────────────

test("(14) a limit row whose start the lock holds keeps its reason — after ready the transition fires it, with a resume row", async () => {
  const fd = await fakeDocker();
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const p = await projectWithChat(ctx, "Limit");
      const c = ctx.chat.id;
      await withEnvironment(ops(fd), async () => {
        setInstanceState(p.id, "main", "start");
        const now = Date.now();
        store.setPendingResume(c, {
          kind: "run", prompt: "LIMIT-JOB", reason: "reset", limitGroup: "five_hour", limitLabel: "5-Stunden-Limit",
          resetsAt: now - 1000, dueAt: now + 3_600_000, now,
        });
        // "Try now" hits the lock: not fired, the REASON stays (it used to become "project").
        const r = await post(`${ctx.base}/api/chats/${c}/auto-continue/now`, {});
        assert.equal(r.ok, false);
        const w = store.getPendingResume(c);
        assert.equal(w?.reason, "reset", `the lock overwrote the reason of the limit row: ${JSON.stringify(w)}`);
        assert.deepEqual([w.limitGroup, w.limitLabel, w.attempts], ["five_hour", "5-Stunden-Limit", 0]);
        assert.equal(turns(ctx.root).length, 0);

        setInstanceState(p.id, "main", "ready");
        // The transition's waker runs as a microtask (projectbox/instances.js), before the continuation of this await;
        // fireAutoContinue enters the chat synchronously into autoContinueFiring and holds it at least over the limit check.
        // If the transition did NOT fire the row, nothing happens that could be waited for (due only in 10 min) — hence
        // asked here, not waited.
        await Promise.resolve();
        assert.ok(autoContinueFiring.has(c), "the transition after ready did not fire the held limit row");
        await waitForTruthy(() => turns(ctx.root).some((t) => t.text.includes("LIMIT-JOB")), "turn of the limit row");
        await ctx.waitForQuiet();
      });
      const rows = (await history(ctx)).filter((m) => m.role === "limit").map((m) => JSON.parse(m.text));
      assert.ok(rows.some((z) => z.kind === "resume"), `no resume row — the row ran as a lock row: ${JSON.stringify(rows)}`);
      assert.equal(store.getPendingResume(c), null, "the row is cleared away");
    }));
  } finally { fd.cleanUp(); }
});

// ── (15) Closed when the database does not answer ─────────────────────────────────────────────────────

// Make tables of the server's database unreadable for the duration of `fn`: `ALTER TABLE … RENAME` over a second
// connection; the store prepares every statement anew and runs into "no such table". `fn` is SYNCHRONOUS — between
// renaming and back no other code of this process runs (the server runs in the test process).
function withoutTable(ctx, tables, fn) {
  const raw = new DatabaseSync(path.join(ctx.dataRoot, "data", "automater.db"), { timeout: 2_147_483_647 });
  const list = [].concat(tables);
  try {
    for (const t of list) raw.exec(`ALTER TABLE ${t} RENAME TO ${t}_way_r2b`);
    try { return fn(); } finally { for (const t of list) raw.exec(`ALTER TABLE ${t}_way_r2b RENAME TO ${t}`); }
  } finally { raw.close(); }
}

test("(15) unreadable ⇒ closed — turn and agent wait, runInstance throws; the message waits in the wait row and runs afterwards; without a writable wait row the start ends visibly", async () => {
  const fd = await fakeDocker();
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const p = await projectWithChat(ctx, "Unreadable");
      const c = ctx.chat.id;
      const filePath = path.join(ctx.root, "workspace", "relocation-elsewhere");
      fs.mkdirSync(filePath, { recursive: true });
      const other = await post(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { name: "RelocationElsewhere", path: filePath });
      // The lock falls closed only where an instance row COULD concern the project (without any row see (15b)): the chat's
      // project carries one, still without `converted_at` (after creation, before the relocation) — readable it holds
      // nothing, the turn runs in B.
      store.createProjectInstance({ projectId: p.id, state: "ready" });
      await withEnvironment(ops(fd), async () => {
        // (a) The instance row is unreadable (the chat's project is not).
        const a = withoutTable(ctx, "project_instances", () => {
          let thrown = null;
          try { instanceForProject(p.id); } catch (e) { thrown = e; }
          return { turn: startLock(c, "turn"), agent: startLock(c, "agent"), oneshot: startLock(c, "oneshot"), thrown };
        });
        assert.deepEqual([a.turn?.kind, a.turn?.reason], ["wait", "unreadable"], `Turn: ${JSON.stringify(a.turn)}`);
        assert.deepEqual([a.agent?.kind, a.agent?.reason], ["wait", "unreadable"], `Agent: ${JSON.stringify(a.agent)}`);
        assert.equal(a.oneshot, null, "a oneshot runs in B");
        assert.match(String(a.thrown?.message), /Instance of project .* not readable .*no start in B at the old path/, "runInstance returned null instead of throwing");

        // (b) The chat row is unreadable: the project is unknown.
        const b = withoutTable(ctx, "chats", () => ({ turn: startLock(c, "turn"), oneshot: startLock(c, "oneshot") }));
        assert.equal(b.turn?.reason, "unreadable", JSON.stringify(b.turn));
        assert.equal(b.oneshot, null, "without a running relocation a oneshot runs");
        // … if a relocation holds the lock (of a project it COULD be), the oneshot is rejected; a core whose
        // project is known without the database gets the lock of its project BEFORE any read.
        const sp = projectLocks(other.id, { reason: "relocation" });
        assert.equal(sp.ok, true, JSON.stringify(sp));
        try {
          const b2 = withoutTable(ctx, "chats", () => ({ oneshot: startLock(c, "oneshot"), core: startLock(c, "agent", { projectId: other.id }) }));
          assert.equal(b2.oneshot?.kind, "deny", `a relocation runs, the project is unknown: ${JSON.stringify(b2.oneshot)}`);
          assert.deepEqual([b2.core?.kind, b2.core?.reason], ["deny", "relocation"], JSON.stringify(b2.core));
        } finally { sp.resolve(); }

        // (c) Composer: not into the queue (no transition would wake it) but into the wait row — rechecked at the sweeper's
        //     tick; as soon as the database answers, the turn runs.
        const chat = store.getChat(c);
        let after = 0;
        const r = withoutTable(ctx, "project_instances", () => {
          const x = deliverUserPrompt(chat, { prompt: "UNREADABLE-JOB", display: "UNREADABLE-JOB" });
          after = Date.now();
          return x;
        });
        // Queued (the old behaviour): nothing woke the queue any more, and the harness quiet would wait forever for it after
        // the failure — clear away first, then red.
        if (r.queued) pendingRunInputs.delete(c);
        assert.equal(r.queued, false, `the message stands in the queue that no transition wakes: ${JSON.stringify(r)}`);
        assert.equal(running.has(c), false, "the turn ran although the lock could read nothing");
        assert.equal(turns(ctx.root).length, 0);
        const w = store.getPendingResume(c);
        assert.deepEqual([w?.reason, w?.evidence], ["project", "unreadable"], JSON.stringify(w));
        assert.ok(w.dueAt <= after + autoContinueSweepMs(), `rechecked only ${w.dueAt - after} ms later — the cap of the lock instead of the sweeper`);
        await waitForTruthy(() => turns(ctx.root).some((t) => t.text.includes("UNREADABLE-JOB")), "turn as soon as the database answers again");
        await ctx.waitForQuiet();

        // (d) Not even the wait row can be written: the start ends visibly, the chat does not stand in `running`.
        const run = withoutTable(ctx, ["project_instances", "pending_resumes"], () => doRun(store.getChat(c), "WITHOUT-WAIT-ROW"));
        await run.catch(() => null);
        const hangs = running.has(c);
        running.delete(c); // otherwise the harness quiet would wait forever after a failure
        assert.equal(hangs, false, "the chat stayed in `running` forever");
        const h = (await history(ctx)).filter((m) => m.role === "hint").map((m) => m.text);
        assert.ok(h.some((t) => /Wartezeile ließ sich nicht schreiben/.test(t)), JSON.stringify(h));
        assert.ok(!turns(ctx.root).some((t) => t.text.includes("WITHOUT-WAIT-ROW")), "the turn ran");
        await ctx.waitForQuiet();
      });
    }));
  } finally { fd.cleanUp(); }
});

// ── (15b) Closed only where an instance row could concern the project ──────────────────────────

test("(15b) in B without a row that could concern the project a read error stays the plain path — turn runs, runInstance null; a foreign row or lock closes only the unknown project", async () => {
  const fd = await fakeDocker();
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const p = await projectWithChat(ctx, "WithoutRow");
      const c = ctx.chat.id;
      const filePath = path.join(ctx.root, "workspace", "with-line");
      fs.mkdirSync(filePath, { recursive: true });
      const other = await post(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { name: "WithRow", path: filePath });
      const read = (fn) => { try { return { value: fn(), thrown: null }; } catch (e) { return { value: undefined, thrown: e }; } };
      await withEnvironment(ops(fd), async () => {
        assert.deepEqual(store.projectInstances(), [], "starting point: B without any instance row");
        // (a) The instance table is unreadable, no row anywhere: the plain path — no verdict, no instance.
        const a = withoutTable(ctx, "project_instances", () => ({
          turn: startLock(c, "turn"), agent: startLock(c, "agent"), oneshot: startLock(c, "oneshot"), inst: read(() => instanceForProject(p.id)),
        }));
        assert.deepEqual([a.turn, a.agent, a.oneshot], [null, null, null], `a read error holds without any row: ${JSON.stringify(a)}`);
        assert.equal(a.inst.thrown, null, `runInstance threw without any row: ${a.inst.thrown?.message}`);
        assert.equal(a.inst.value, null);
        // (b) The chat row is unreadable (project unknown), no row, no lock: likewise.
        const b = withoutTable(ctx, "chats", () => ({ turn: startLock(c, "turn"), agent: startLock(c, "agent") }));
        assert.deepEqual([b.turn, b.agent], [null, null], JSON.stringify(b));
        // (c) Composer: the turn runs at once — no wait row "unreadable", no queue.
        const r = withoutTable(ctx, "project_instances", () => deliverUserPrompt(store.getChat(c), { prompt: "G2-JOB", display: "G2-JOB" }));
        if (r.queued) pendingRunInputs.delete(c); // otherwise the harness quiet would wait forever after a failure
        const parked = store.getPendingResume(c);
        if (parked) store.clearPendingResume(c);
        assert.equal(r.queued, false, JSON.stringify(r));
        assert.equal(parked, null, `a read error parked a turn without any instance row: ${JSON.stringify(parked)}`);
        await waitForTruthy(() => turns(ctx.root).some((t) => t.text.includes("G2-JOB")), "turn as before");
        await ctx.waitForQuiet();
        // (d) ANOTHER project carries a row: this chat's project is known and carries none ⇒ open; if it is
        //     unknown (chat row unreadable) it could be the other one ⇒ closed; the other one itself ⇒ closed.
        store.createProjectInstance({ projectId: other.id, state: "ready" });
        const d = withoutTable(ctx, "project_instances", () => ({
          turn: startLock(c, "turn"), own: read(() => instanceForProject(p.id)), foreign: read(() => instanceForProject(other.id)),
        }));
        assert.equal(d.turn, null, JSON.stringify(d.turn));
        assert.equal(d.own.thrown, null, `runInstance threw for a project without a row: ${d.own.thrown?.message}`);
        assert.match(String(d.foreign.thrown?.message), /not readable .*no start in B at the old path/, "runInstance of the project WITH a row returned null");
        assert.deepEqual([withoutTable(ctx, "chats", () => startLock(c, "turn"))?.reason], ["unreadable"], "unknown project next to a row: open");
        // (e) The row falls (delete path) ⇒ the plain path again.
        store.deleteProjectInstance(other.id);
        assert.equal(withoutTable(ctx, "chats", () => startLock(c, "turn")), null, "still closed after deleting the last row");
        // (f) An explicit lock without a row (a relocation locks before its first row): the unknown project ⇒ closed.
        const sp = projectLocks(other.id, { reason: "relocation" });
        assert.equal(sp.ok, true, JSON.stringify(sp));
        try {
          assert.equal(withoutTable(ctx, "chats", () => startLock(c, "turn"))?.reason, "unreadable", "unknown project next to a lock: open");
          assert.equal(withoutTable(ctx, "project_instances", () => startLock(c, "turn")), null, "the lock of a FOREIGN project closes the known one");
        } finally { sp.resolve(); }
      });
      assert.deepEqual(fd.calls(), [], "no docker");
    }));
  } finally { fd.cleanUp(); }
});

// ── (15c) The wait row is there, every read afterwards throws ───────────────────────────────────────────────────

// For the duration of `fn` (SYNCHRONOUS) every read of a chat's wait row throws, AFTER it was written — the
// read-back inside the write itself (store setPendingResume) still passes. `DatabaseSync.prototype.prepare` of the
// test process (the server runs in it, the store prepares every statement anew) is swapped and put back in the finally.
// That is what a SQLITE_BUSY looks like that hits exactly between write and re-read (not reproducible via a table:
// if it is missing, the write itself fails).
function readingAfterTheWriteThrows(fn) {
  const real = DatabaseSync.prototype.prepare;
  let phase = 0; // 0 before the write · 1 written (the read-back passes) · 2 every further read throws
  let thrown = 0;
  DatabaseSync.prototype.prepare = function (sql, ...rest) {
    const s = String(sql);
    if (/^\s*INSERT INTO pending_resumes\b/.test(s)) phase = 1;
    else if (/^\s*SELECT[\s\S]*\bFROM pending_resumes WHERE chat_id = \?/.test(s)) {
      if (phase === 1) phase = 2;
      else if (phase === 2) { thrown += 1; throw new Error("database is locked (test: read after the write)"); }
    }
    return real.call(this, sql, ...rest);
  };
  try { return { value: fn(), thrown: () => thrown }; } finally { DatabaseSync.prototype.prepare = real; }
}

// The global stream (/api/events) — run end to chat list and other devices.
function globalerRecording(base) {
  const events = [];
  const controller = new AbortController();
  const done = (async () => {
    const res = await fetch(`${base}/api/events`, { signal: controller.signal, headers: { Connection: "close" } });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) return;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try { events.push(JSON.parse(line.slice(6))); } catch { /* defective frame */ }
        }
      }
    } catch { /* aborted */ }
  })();
  return {
    events,
    connected: () => waitForTruthy(() => events.some((e) => e.type === "init"), "global stream connected"),
    stop: async () => { controller.abort(); await done; },
  };
}

test("(15c) the wait row is there, the re-read throws — doRun ends, the chat does not hang in `running`, the run end goes to all; after ready the turn runs", async () => {
  const fd = await fakeDocker();
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const p = await projectWithChat(ctx, "ReadBack");
      const c = ctx.chat.id;
      const stream = globalerRecording(ctx.base);
      try {
        await stream.connected();
        await withEnvironment(ops(fd), async () => {
          setInstanceState(p.id, "main", "start");
          const prior = stream.events.length;
          const { value: run, thrown } = readingAfterTheWriteThrows(() => doRun(store.getChat(c), "READ-UP-JOB"));
          const error = await run.then(() => null, (e) => e);
          const hangs = running.has(c);
          running.delete(c); // otherwise the harness quiet would wait forever after a failure
          assert.ok(thrown() >= 1, "the read after the write was not asked — the test measures nothing");
          assert.equal(hangs, false, "the chat stayed in `running` (throw from projectLockHolds before running.delete)");
          assert.equal(error, null, `doRun warf: ${error?.message}`);
          const w = store.getPendingResume(c);
          assert.deepEqual([w?.reason, w?.evidence], ["project", "start"], `the wait row is missing: ${JSON.stringify(w)}`);
          // The run end is in the stream BEFORE the change to ready (one stream, one order — no waiting for something
          // that might not come).
          setInstanceState(p.id, "main", "ready");
          await waitForTruthy(() => stream.events.slice(prior).some((e) => e.type === "project/instance" && e.projectId === p.id && e.state === "ready"), "change to ready in the stream");
          const fresh = stream.events.slice(prior);
          const end = fresh.findIndex((e) => e.type === "run" && e.chatId === c && e.running === false);
          const ready = fresh.findIndex((e) => e.type === "project/instance" && e.state === "ready");
          assert.ok(end >= 0 && end < ready, `no run end to the other devices: ${JSON.stringify(fresh.map((e) => e.type))}`);
        });
        // The transition after ready fires the wait row (without waker — the re-read failed), the turn runs.
        await waitForTruthy(() => turns(ctx.root).some((t) => t.text.includes("READ-UP-JOB")), "turn after ready");
        await ctx.waitForQuiet();
        assert.equal(store.getPendingResume(c), null, "the wait row is cleared away");
      } finally { await stream.stop(); }
    }));
  } finally { fd.cleanUp(); }
});

// ── (16) The project switch in the middle of a turn is allowed, the turn counts in the idle of its old project ──
// The running turn stays in the old project. It is pinned to its project like a core (runs/instance.js) and counts there
// (projectbox/idle.js, reason "running"), the switch goes through. Here a turn WITHOUT instance (it began before A was
// converted): counted by project, not by instance — exactly the case in which a relocation of A would start under it.
// The turn WITH instance plus fence is held by fence.test.js (12).
test("(16) project switch in the middle of a turn — 200, also with converted source and converted target; until its end the turn holds A's idle, afterwards A is quiet", async () => {
  const fd = await fakeDocker();
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const a = await projectWithChat(ctx, "SwitchA");
      const filePath = path.join(ctx.root, "workspace", "switchb");
      fs.mkdirSync(filePath, { recursive: true });
      const b = await post(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { name: "SwitchB", path: filePath });
      const changeOver = async (projectId) => {
        const r = await fetch(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify({ projectId }) });
        return { status: r.status, body: await r.json() };
      };
      const project = () => store.getChat(ctx.chat.id).projectId;
      await send(ctx, "{MAINGATE:w1} SWITCH-TURN");
      await ctx.gate.reached("w1");
      try {
        await withEnvironment(ops(fd), async () => {
          store.createProjectInstance({ projectId: a.id, state: "ready", convertedAt: Date.now() });
          store.createProjectInstance({ projectId: b.id, state: "ready", convertedAt: Date.now() });
          const r = await changeOver(b.id);
          assert.equal(r.status, 200, `the switch in the middle of a turn is allowed — ${JSON.stringify(r.body)}`);
          assert.equal(project(), b.id);
          assert.deepEqual(store.chatIdsInProject(a.id), [], "the chat no longer stands in A");
          const l = projectIdle(a.id);
          assert.equal(l.quiet, false, "the running turn dropped out of A's idle because its chat stands elsewhere");
          assert.ok(l.open.some((o) => o.chatId === ctx.chat.id && o.reason === "running"), JSON.stringify(l.open));
          const s = projectLocks(a.id, { reason: "relocation" });
          assert.equal(s.ok, false, `a relocation of A would start under the turn: ${JSON.stringify(s)}`);
          assert.ok(s.open.some((o) => o.reason === "running"), JSON.stringify(s.open));
          assert.equal(projectLocked(a.id), null, "the lock is released");
          // Out of the project: likewise 200, the turn stays in A.
          assert.equal((await changeOver(null)).status, 200);
          assert.equal(projectIdle(a.id).quiet, false);
        });
        // Without operating marker as before.
        assert.equal((await changeOver(b.id)).status, 200);
        assert.equal(project(), b.id);
      } finally { ctx.gate.open("w1"); }
      await ctx.waitForQuiet();
      assert.equal(projectIdle(a.id).quiet, true, "after the turn A is quiet");
      assert.deepEqual(fd.calls(), [], "no docker");
    }));
  } finally { fd.cleanUp(); }
});

// ── (13c) Every reason of idle has a guard ───────────────────────────────────
// IDLE_CRITERIA (above) establishes one state per reason of open work. What idleOf (projectbox/idle.js) counts PROJECT-WIDE
// beyond that (work that no chat of the project owns any more) is held by other tests — named in PROJECT_WIDE. (13c)
// reads the reason literals from the SOURCE of idleOf and checks both directions: every literal stands in one of the two
// tables, and every PROJECT_WIDE entry stands as a literal in the source. A new reason without a guard is therefore red.
// COUNTER-TEST: built in (the source plus `reason: "new"` ⇒ red); without the entry `git` ⇒ red at the literal "git".
const PROJECT_WIDE = {
  git: "projectbox-git-worktree.test.js (11) — a teardown job in the project container belongs to no chat",
  running: "(12) — a turn keeps running whose chat has switched projects",
  agent: "(12)/(12b) — a core (subagent, dynamic workflow) whose chat has switched projects",
  detection: "project-detection.test.js (f)(g) — a computing service detection belongs to no chat",
  worktree: "layout-quiet.test.js — a graph workflow creates its worktree; the creation no longer belongs to a turn",
};
function idleReasons(source) {
  const from = source.indexOf("function idleOf(");
  assert.ok(from > 0, "idleOf not found — renamed?");
  const until = source.indexOf("\nexport function ", from);
  const body = source.slice(from, until === -1 ? undefined : until).replace(/^[ \t]*\/\/.*$/gm, "");
  const reasons = new Set();
  for (const [, g] of body.matchAll(/alongside\("([a-z]+)"/g)) reasons.add(g);
  for (const [, g] of body.matchAll(/reason: (?:[^,}]*\? )?"([a-z]+)"/g)) reasons.add(g);
  return reasons;
}
function idleFindings(source) {
  const reasons = idleReasons(source);
  const known = new Set([...IDLE_CRITERIA.map((k) => k.reason), ...Object.keys(PROJECT_WIDE)]);
  return [
    ...[...reasons].filter((g) => !known.has(g)).map((g) => `Reason "${g}" in idleOf without a guard (neither IDLE_CRITERIA nor PROJECT_WIDE)`),
    ...Object.keys(PROJECT_WIDE).filter((g) => !reasons.has(g)).map((g) => `PROJECT_WIDE names "${g}", idleOf does not count it (any more)`),
  ];
}
test("(13c) every reason literal in idleOf stands in IDLE_CRITERIA or PROJECT_WIDE, every PROJECT_WIDE entry in idleOf — built-in sabotage red", () => {
  const source = fs.readFileSync(path.join(TESTDIR, "..", "electron", "server", "projectbox", "idle.js"), "utf8");
  assert.ok(idleReasons(source).size >= 6, `too few reasons read: ${[...idleReasons(source)].join(", ")}`);
  assert.deepEqual(idleFindings(source), []);
  // Built-in sabotage: a new reason in the body of idleOf.
  const sabotaged = source.replace("function idleOf(pid, onlyInstance) {\n  const open = [];", "function idleOf(pid, onlyInstance) {\n  const open = [];\n  open.push({ chatId: \"\", reason: \"new\", text: \"\" });");
  assert.notEqual(sabotaged, source, "sabotage outdated");
  assert.deepEqual(idleFindings(sabotaged), ["Reason \"new\" in idleOf without a guard (neither IDLE_CRITERIA nor PROJECT_WIDE)"]);
});

// ── (17) No new project terminal under a lock ───────────────────────────────────
// projectLocks ends the project's terminals (`proj:<id>`, the chat rail) — a terminal that someone opened AFTERWARDS would run
// in the middle of a relocation or recreation. POST /api/projects/:pid/terminal answers 409 { code: "LOCKED", reason } — locked,
// an open relocation journal or an instance in the state "relocation". Workspace terminals (ws:) stay exempt. Checked in the
// branch `/terminal` of codeRoute via `opts.sessionLock` (codeProjectRoutes carries no branch of its own, code-scopes.test.js).
// The lock asks the instance in which the session STARTS (tag `chat:<id>` ⇒ that of the chat), and the debugger has the same
// check — the guards for that need a real copy: project-terminal-copy.test.js.
test("(17) POST /api/projects/:pid/terminal under a lock ⇒ 409 LOCKED; without a lock as usual", async () => {
  const fd = await fakeDocker();
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const p = await projectWithChat(ctx, "Terminal-Lock");
      const terminal = (b = {}) => fetch(`${ctx.base}/api/projects/${p.id}/terminal`, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(b) })
        .then(async (r) => ({ status: r.status, body: await r.json() }));
      await withEnvironment(ops(fd), async () => {
        const s = projectLocks(p.id, { reason: "relocation" });
        assert.equal(s.ok, true, JSON.stringify(s));
        try {
          const r = await terminal({ cols: 80, rows: 24 });
          assert.equal(r.status, 409, `a terminal under the lock: ${JSON.stringify(r)}`);
          assert.deepEqual([r.body.code, r.body.reason], ["LOCKED", "relocation"]);
          assert.match(String(r.body.error || ""), /gesperrt/i);
          if (r.body.id) killTerminal(r.body.id);
        } finally { s.resolve(); }
      });
      // Counter-check: without a lock as usual (201 with terminal resp. 200 {available:false} without node-pty).
      const free = await terminal({ cols: 80, rows: 24 });
      assert.ok(free.status === 201 || (free.status === 200 && free.body.available === false), JSON.stringify(free));
      if (free.body.id) killTerminal(free.body.id);
    }));
  } finally { fd.cleanUp(); }
});
