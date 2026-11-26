// Review node end to end, against a REAL server (offline, no real LLM):
// request turn → wait → agenda item + notification → findings → fix → second round → approval.
//
// The fake CLI answers a review prompt like an agent writing a test guide: otherwise the test could not check that EXACTLY
// this text lands in chat, notification and agenda item (and not some prompt echo).
//
// The request stands as the item "Request review" in the AGENDA of the workflow chat (not as a sub-todo). Counter-test: a gate
// that creates a todo and leaves the agenda empty turns every check on `agendaOf` below red.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";
import { db } from "../electron/server/store/db.js";
import { RIPCORD } from "./ripcord.mjs";
import { waitForQuiet } from "./quiet.mjs";

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json();
  if (!res.ok) { const e = new Error(`${res.status}: ${JSON.stringify(body)}`); e.status = res.status; e.body = body; throw e; }
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait for an EVENT, without a deadline: under load a deadline measures the machine. If it hangs, the
// suite deadline is the emergency brake; every 30 s a line on stderr says what is being waited for.
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
// After a failure: stop open runs instead of waiting for quiet. Never throws.
async function stopOpen(base) {
  try {
    for (const it of (await json(`${base}/api/active-runs`)).items || []) {
      if (it.chatId) await fetch(`${base}/api/chats/${it.chatId}/stop`, { method: "POST" }).catch(() => {});
    }
  } catch { /* server already closed */ }
}

// Fake CLI:
//  · Turn: recognizes the review prompt and answers with a REAL guide (the round stands in it, so the
//    test can tell the second from the first); otherwise prompt echo.
//  · Oneshot: the review verdict decides by the marker FREE-PLEASE in the user answer.
const fakeClaude = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
const log = (s) => { try { fs.appendFileSync(process.env.CBASE_TEST_PROMPTS, s.replace(/\\s+/g, " ") + "\\n"); } catch {} };
${RIPCORD}
const argv = process.argv.slice(2);
if (!argv.includes("--input-format")) {
  let stdin = "";
  process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => {
    log("ONESHOT " + stdin.replace(/\\s+/g, " ").slice(0, 2000));
    let result = "Title";
    if (/"approval"/.test(stdin)) result = /FREE-PLEASE/.test(stdin) ? '{"approval": true, "note": "Marker FREE"}' : '{"approval": false, "note": "Marker FINDING"}';
    else if (/JSON array/.test(stdin)) result = '["Alpha", "Beta"]';
    else if (/condition/i.test(stdin)) result = /JA-PLEASE/.test(stdin) ? '{"yes": true, "note": "YES"}' : '{"yes": false, "note": "NO"}';
    process.stdout.write(JSON.stringify({ result }));
    clearTimeout(guard);
    process.exit(0);
  });
} else {
  log("ARGV " + argv.join(" "));
  process.stdin.on("end", () => process.exit(0));
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const c = msg.message && msg.message.content;
    const text = typeof c === "string" ? c : (Array.isArray(c) ? c.map((b) => b.text || "").join("") : "");
    log("TURN " + text.replace(/\\s+/g, " ").slice(0, 1200));
    let out;
    if (/HUMAN for a review/.test(text)) {
      const round = /This is round (\\d)/.exec(text);
      out = [
        "REVIEW-REQUEST" + (round ? " (round " + round[1] + ")" : ""),
        "1. Produced: checkout rebuild with discount logic.",
        "2. How to test: npm start, open /checkout, scan an item, set discount 10.",
        "3. Watch out: rounding at 3 decimal places unchecked.",
        "4. Out of scope: receipt printer.",
      ].join("\\n");
    } else {
      out = "DONE: " + text.replace(/\\s+/g, " ").slice(0, 160);
    }
    setTimeout(() => {
      say({ type: "assistant", message: { content: [{ type: "text", text: out }] } });
      say({ type: "result", result: out, session_id: "review-e2e" });
    }, Number(process.env.CBASE_TEST_DELAY || 100));
  });
}
`;

async function withServer(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-review-"));
  const bin = path.join(root, "fake-claude");
  const prompts = path.join(root, "prompts.log");
  const prev = {
    bin: process.env.CLAUDE_BIN, poll: process.env.CBASE_TRIGGER_POLL,
    prompts: process.env.CBASE_TEST_PROMPTS, delay: process.env.CBASE_TEST_DELAY,
    restartGrace: process.env.CBASE_RESTART_GRACE_MS,
  };
  let server, base = "", finished = false;
  try {
    // No restart: it is not the subject here.
    process.env.CBASE_RESTART_GRACE_MS = String(24 * 3_600_000);
    fs.writeFileSync(bin, fakeClaude);
    fs.chmodSync(bin, 0o755);
    fs.writeFileSync(prompts, "");
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";
    process.env.CBASE_TEST_PROMPTS = prompts;
    process.env.CBASE_TEST_DELAY = "100";
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Review", path: wsPath }) });
    await fn({
      base, ws,
      // Only WHOLE lines: the fake CLI writes while the test reads.
      prompts: () => fs.readFileSync(prompts, "utf8").split("\n").slice(0, -1).filter(Boolean),
      turns: () => fs.readFileSync(prompts, "utf8").split("\n").slice(0, -1).filter((l) => l.startsWith("TURN")),
    });
    finished = true;
  } finally {
    if (base && finished) await waitForQuiet(base);
    else if (base) await stopOpen(base);
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    for (const [k, v] of [["CLAUDE_BIN", prev.bin], ["CBASE_TRIGGER_POLL", prev.poll],
                          ["CBASE_TEST_PROMPTS", prev.prompts], ["CBASE_TEST_DELAY", prev.delay],
                          ["CBASE_RESTART_GRACE_MS", prev.restartGrace]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    // A test must not fail because its temp directory cannot be removed: a child process still
    // writing causes ENOTEMPTY, which says something about cleanup, not about the product. It is
    // still reported — otherwise junk piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
}

// `run: { doneAll: false }`: "check all work steps" is on by default; here the subject is the
// human's review, not the closing gate.
async function makeFlow(base, ws, name, graph, extra = {}) {
  const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, { method: "POST", body: JSON.stringify({ name }) });
  return json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({ graph, ...extra, run: { doneAll: false, ...(extra.run || {}) } }) });
}
async function newChat(base, ws, title) {
  const chat = await json(`${base}/api/chats`, {
    method: "POST",
    body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
  });
  await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title, titled: 1 }) });
  return chat;
}
const start = (base, chatId, workflowId, input = "") =>
  json(`${base}/api/chats/${chatId}/workflow`, { method: "POST", body: JSON.stringify({ workflowId, input }) });
const runOf = (base, runId) => json(`${base}/api/workflow-runs/${runId}`);
const untilStatus = (base, runId, ...want) =>
  waitFor(async () => { const d = await runOf(base, runId); return want.includes(d.run.status) ? d : null; });
const say = (base, chatId, text) => json(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });
const agendaOf = async (base, chatId) => (await json(`${base}/api/chats/${chatId}/agenda`)).agenda;
const reviewPoints = async (base, chatId) => (await agendaOf(base, chatId)).steps.filter((s) => s.text === "Review anfragen");
// TRAP: the bell events live in the MODULE STATE of services.js, not in the server's database —
// they survive the server switch between two tests of the same file. Always filter by the chat of
// the running test, otherwise the predecessor's events are counted too.
const eventsOf = async (base, chatId) =>
  ((await json(`${base}/api/services/events?since=0`)).events || []).filter((e) => !chatId || e.chatId === chatId);

// A review cycle: approval continues, findings go into the fix and from there back.
const reviewFlow = (over = {}) => ({
  nodes: [
    { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
    { id: "r1", type: "review", title: "Review anfragen", text: "Test the checkout in {{input}}.", x: 200, y: 0, ...over },
    { id: "further", type: "instruction", title: "Phase 5", text: "PHASE FIVE: commit", x: 420, y: -60 },
    { id: "fix", type: "instruction", title: "Fix findings", text: "FIX: {{answer}}", x: 420, y: 90 },
    { id: "e1", type: "end", title: "End", x: 640, y: -60, notify: true },
  ],
  edges: [
    { from: "s0", to: "r1" },
    { from: "r1", to: "further", branch: "ok" },
    { from: "r1", to: "fix", branch: "issues" },
    { from: "fix", to: "r1" },
    { from: "further", to: "e1" },
  ],
});

test("Review node: request turn, wait, agenda item, notification — findings spin a round, “passt” continues", async () => {
  await withServer(async ({ base, ws, turns, prompts }) => {
    const flow = await makeFlow(base, ws, "Review", reviewFlow());
    const chat = await newChat(base, ws, "Rebuild checkout");

    const r = await start(base, chat.id, flow.id, "Branch-7");
    const waiting = await untilStatus(base, r.run.id, "waiting", "done", "failed");
    assert.equal(waiting.run.status, "waiting", `Run should wait for the review, was ${waiting.run.status}: ${waiting.run.note}`);
    // Agenda item and notification follow the status change — checked once the server rests.
    await waitForQuiet(base);

    // 1) The request turn has run — with the placeholder replaced and the rule "change nothing more".
    assert.equal(turns().length, 1, "exactly one turn: the request");
    assert.match(turns()[0], /Test the checkout in Branch-7\./);
    assert.match(turns()[0], /Change NOTHING more in the code in this step/);
    // 2) What the agent wrote IS the presented request.
    assert.match(waiting.run.question, /REVIEW-REQUEST/);
    assert.match(waiting.run.question, /How to test/);
    // 3) Item "Request review" (stored German: "Review anfragen") in the chat's agenda, open, with a teaser. The gate can no longer
    // create a todo at all (the table is gone).
    const sub = await reviewPoints(base, chat.id);
    assert.equal(sub.length, 1, `exactly one review item expected: ${JSON.stringify((await agendaOf(base, chat.id)).steps)}`);
    assert.equal(sub[0].status, "open");
    assert.equal(sub[0].parent, null, "the item stands at the top level");
    assert.match(sub[0].note, /REVIEW-REQUEST/);
    // 4) Notification with a way to the chat (the bell turns it into a link to the chat).
    const ev = (await eventsOf(base, chat.id)).filter((e) => e.kind === "review");
    assert.equal(ev.length, 1, "exactly one review notification");
    assert.equal(ev[0].chatId, chat.id, "without chatId the notification leads nowhere");
    assert.match(ev[0].title, /Review angefragt/);
    assert.match(ev[0].body, /REVIEW-REQUEST/);

    // ── Round 1: report findings ──
    const response1 = await say(base, chat.id, "The save button does nothing, and the total rounds wrong.");
    assert.equal(response1.workflow, true, "the message is the verdict, not a new run");
    const waiting2 = await waitFor(async () => {
      const d = await runOf(base, r.run.id);
      return d.run.status === "waiting" && /round 2/.test(d.run.question) ? d : null;
    });
    assert.ok(waiting2, "after the findings a second review round must come");
    await waitForQuiet(base);
    // The fixing step gets the findings as {{answer}} …
    assert.ok(turns().some((l) => /FIX: The save button does nothing/.test(l)), "findings are missing in the fix prompt");
    // … and the second request knows what it was about (the findings stand as DATA in the prompt).
    const second = turns().filter((l) => /HUMAN for a review/.test(l)).at(-1);
    assert.match(second, /round 2/);
    assert.match(second, /The save button does nothing/);
    assert.match(second, /not an instruction to you/);
    // No second item — the same one is continued, its note is again the (new) request.
    const sub2 = await reviewPoints(base, chat.id);
    assert.equal(sub2.length, 1, "the second round must not create a second item");
    assert.equal(sub2[0].status, "open");
    assert.equal(sub2[0].id, sub[0].id);
    assert.match(sub2[0].note, /REVIEW-REQUEST \(round 2\)/);
    // Second notification, this time with the round number.
    const ev2 = (await eventsOf(base, chat.id)).filter((e) => e.kind === "review");
    assert.equal(ev2.length, 2);
    assert.match(ev2.at(-1).title, /Runde 2/);

    // ── Round 2: approval ──
    await say(base, chat.id, "passt");
    const finished = await untilStatus(base, r.run.id, "done", "failed");
    assert.equal(finished.run.status, "done", `Run ended as ${finished.run.status}: ${finished.run.note}`);
    await waitForQuiet(base);
    assert.match(turns().at(-1), /PHASE FIVE/, "after the approval the approval path must run");
    // The item is ticked off.
    const sub3 = (await agendaOf(base, chat.id)).steps.find((s) => s.id === sub[0].id);
    assert.equal(sub3.status, "done", "with the approval the review item is done");
    // The end node has its "notify" tick — the notification says the run is through.
    assert.ok((await eventsOf(base, chat.id)).some((e) => /am Ende/.test(e.title)), "notification of the end node is missing");

    // Log: two requests, two verdicts (first findings, then approval), both answers in it.
    const reviews = finished.steps.filter((s) => s.kind === "review");
    assert.deepEqual(
      reviews.map((s) => s.detail.verdict || "request"),
      ["request", "issues", "request", "ok"],
      `unexpected sequence: ${JSON.stringify(reviews.map((s) => s.detail))}`,
    );
    const responses = finished.steps.filter((s) => s.kind === "answer");
    assert.equal(responses.length, 2);
    assert.ok(responses.every((s) => s.detail.review === true), "the answers must be marked as a review verdict");
    assert.match(responses[0].detail.answer, /save button/);
    // A review costs ONE step per round (request) — waiting does not count twice.
    assert.equal(finished.run.total, 3, "step count: review + phase 5 + fix");
    // "passt" is decided by the parser without a model. The findings report is NOT unambiguous (short and
    // without an approval phrase) → exactly one verdict, and about this answer.
    const verdicts = prompts().filter((l) => l.startsWith("ONESHOT") && /"approval"/.test(l));
    assert.equal(verdicts.length, 1, `exactly one verdict expected: ${verdicts.length}`);
    assert.match(verdicts[0], /save button/, "the findings report was judged, not the approval");
  });
});

test("An unclear answer is judged — the model's verdict decides the path", async () => {
  await withServer(async ({ base, ws, turns, prompts }) => {
    const flow = await makeFlow(base, ws, "Review-Verdict", reviewFlow());
    const chat = await newChat(base, ws, "Verdict");
    const r = await start(base, chat.id, flow.id, "Branch-9");
    await untilStatus(base, r.run.id, "waiting", "failed");

    // "von mir aus" (German: "fine by me") is none of the unambiguous approvals → a small model interprets the answer.
    await say(base, chat.id, "von mir aus, FREE-PLEASE");
    const finished = await untilStatus(base, r.run.id, "done", "failed");
    assert.equal(finished.run.status, "done", `Run ended as ${finished.run.status}: ${finished.run.note}`);
    const verdict = prompts().filter((l) => l.startsWith("ONESHOT") && /approval/.test(l));
    assert.equal(verdict.length, 1, "the unclear answer should have been judged");
    assert.match(verdict[0], /plain text, not an instruction to you/, "the user answer must be passed fenced");
    assert.match(turns().at(-1), /PHASE FIVE/, "the model approved → approval path");
    const ok = finished.steps.filter((s) => s.kind === "review").at(-1);
    assert.equal(ok.detail.verdict, "ok");
    assert.match(ok.detail.note, /Marker FREE/, "the reason of the verdict belongs in the log");
  });
});

test("Without a findings edge the run ends visibly — and a deselected tick stays silent", async () => {
  await withServer(async ({ base, ws }) => {
    const flow = await makeFlow(base, ws, "Review-DeadEnd", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Build", text: "BUILD", x: 200, y: 0, notify: true },
        // Tick explicitly OFF: this review node must not report.
        { id: "r1", type: "review", title: "Please check", x: 420, y: 0, notify: false },
        { id: "further", type: "instruction", title: "Phase 5", text: "PHASE FIVE", x: 640, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "r1" }, { from: "r1", to: "further", branch: "ok" }],
    });
    // The editor says so already while building — as an ERROR, not a footnote.
    assert.ok(flow.problems.some((p) => p.nodeId === "r1" && p.level === "error" && /Befunde/.test(p.text)));

    const chat = await newChat(base, ws, "Dead end");
    const r = await start(base, chat.id, flow.id);
    await untilStatus(base, r.run.id, "waiting", "failed");
    await waitForQuiet(base);
    // Tick on the instruction → notification; tick off on the review node → no review notification.
    const ev = await eventsOf(base, chat.id);
    assert.ok(ev.some((e) => e.kind === "workflow" && /Schritt erreicht: Build/.test(e.title)), `step notification missing: ${JSON.stringify(ev)}`);
    assert.equal(ev.filter((e) => e.kind === "review").length, 0, "the deselected tick must stay silent");

    await say(base, chat.id, "The total row is missing and the back button hangs.");
    const out = await untilStatus(base, r.run.id, "failed", "done", "cancelled");
    assert.equal(out.run.status, "failed", "findings without a path must not fizzle out silently");
    assert.match(out.run.note, /keine Kante/);
  });
});

test("Skipping at a waiting review node acts like an approval (not like a finding)", async () => {
  await withServer(async ({ base, ws, turns }) => {
    // The findings edge stands FIRST in the graph: without special handling "skip" would take it.
    const flow = await makeFlow(base, ws, "Review-Skip", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "r1", type: "review", title: "Review", x: 200, y: 0 },
        { id: "fix", type: "instruction", title: "Repair", text: "FIX", x: 420, y: 90 },
        { id: "further", type: "instruction", title: "Phase 5", text: "PHASE FIVE", x: 420, y: -60 },
      ],
      edges: [
        { from: "s0", to: "r1" },
        { from: "r1", to: "fix", branch: "issues" },
        { from: "r1", to: "further", branch: "ok" },
        { from: "fix", to: "r1" },
      ],
    });
    const chat = await newChat(base, ws, "Skip");
    const r = await start(base, chat.id, flow.id);
    await untilStatus(base, r.run.id, "waiting", "failed");
    await json(`${base}/api/chats/${chat.id}/workflow/skip`, { method: "POST" });
    const finished = await untilStatus(base, r.run.id, "done", "failed");
    assert.equal(finished.run.status, "done", `Run ended as ${finished.run.status}: ${finished.run.note}`);
    assert.match(turns().at(-1), /PHASE FIVE/);
    await waitForQuiet(base);
    // Skipped also means here: the review item is off the table.
    const sub = await reviewPoints(base, chat.id);
    assert.equal(sub.length, 1);
    assert.equal(sub[0].status, "done", "the item must not remain open");
  });
});

// The findings replace the item's note — clipped to the agenda cap (2,000 characters), not torn: a long answer from the
// human must not make the item fail. Counter-test without `clipped` in reviewPointWrite: the item keeps the request as its
// note (agenda error, cap), the step log carries `agendaError` — both checks red.
test("Findings replace the note of the review item, clipped to the agenda cap", async () => {
  await withServer(async ({ base, ws }) => {
    const flow = await makeFlow(base, ws, "Review-Note", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "r1", type: "review", title: "Review", x: 200, y: 0 },
        { id: "e1", type: "end", title: "End", x: 420, y: 90 },
        { id: "e2", type: "end", title: "End ok", x: 420, y: -60 },
      ],
      edges: [{ from: "s0", to: "r1" }, { from: "r1", to: "e1", branch: "issues" }, { from: "r1", to: "e2", branch: "ok" }],
    });
    const chat = await newChat(base, ws, "Note");
    const r = await start(base, chat.id, flow.id);
    await untilStatus(base, r.run.id, "waiting", "failed");
    await waitForQuiet(base);
    const lang = `The save button does nothing. ${"And one more finding. ".repeat(150)}`;
    assert.ok([...lang].length > 2000);
    await say(base, chat.id, lang);
    const finished = await untilStatus(base, r.run.id, "done", "failed");
    assert.equal(finished.run.status, "done", `Run ended as ${finished.run.status}: ${finished.run.note}`);
    await waitForQuiet(base);
    const [point] = await reviewPoints(base, chat.id);
    assert.equal(point.status, "open", "findings do not close the item");
    assert.match(point.note, /^Runde 1: Befunde gemeldet — wird behoben\n\nThe save button does nothing\./);
    assert.equal([...point.note].length, 2000, "clipped to the cap");
    assert.ok(point.note.endsWith("…"), "the cut says it is one");
    const issues = finished.steps.find((s) => s.kind === "review" && s.detail.verdict === "issues");
    assert.equal(issues.detail.agendaError, undefined, `no agenda error: ${JSON.stringify(issues.detail)}`);
  });
});

// The card is the gate, the item only the display: if the agenda cannot be written (here: full, 200 items), the run still waits
// at the review and continues after the approval — the error stands in the step log. Counter-test without the try/catch in
// reviewPointCreate: the driver throws in the review, the run stays `running` — the test waits without a deadline and hangs
// until the suite deadline (no `waiting`, no `failed`).
test("A full agenda does not stop the review gate — the error stands in the step log", async () => {
  await withServer(async ({ base, ws, turns }) => {
    const flow = await makeFlow(base, ws, "Review-Full", reviewFlow());
    const chat = await newChat(base, ws, "Full");
    const steps = Array.from({ length: 500 }, (_, i) => ({ op: "fresh", text: `Item ${i + 1}` }));
    await json(`${base}/api/chats/${chat.id}/agenda`, { method: "PUT", body: JSON.stringify({ title: "Full", steps }) });
    const r = await start(base, chat.id, flow.id, "Branch-1");
    const waiting = await untilStatus(base, r.run.id, "waiting", "done", "failed");
    assert.equal(waiting.run.status, "waiting", `Run should wait despite a full agenda, was ${waiting.run.status}: ${waiting.run.note}`);
    const request = waiting.steps.filter((s) => s.kind === "review").at(-1);
    assert.match(request.detail.agendaError || "", /Deckel: eine Agenda trägt höchstens 500 Punkte/);
    assert.equal(request.detail.point, "");
    assert.equal((await reviewPoints(base, chat.id)).length, 0);
    await say(base, chat.id, "passt");
    const finished = await untilStatus(base, r.run.id, "done", "failed");
    assert.equal(finished.run.status, "done", `Run ended as ${finished.run.status}: ${finished.run.note}`);
    assert.match(turns().at(-1), /PHASE FIVE/);
  });
});

// The node agent may create sub-items under "Request review". Then the item's status is computed, and a `status` on it is an
// agenda error (agenda/operations.js). Round 2 must therefore write only the note: if it sent `{ change, note, status: "open" }`,
// the error would empty `reviewPoint`, the next round would create a SECOND item, and the approval would tick off nothing.
// Counter-test: round 2 carries `agendaError` ("has sub-items"), two review items, the item stays open after "passt" — all
// three checks red.
test("A review item with sub-items: round 2 continues only the note, the approval ticks off the leaves", async () => {
  await withServer(async ({ base, ws }) => {
    const flow = await makeFlow(base, ws, "Review-Subitems", reviewFlow());
    const chat = await newChat(base, ws, "Subitems");
    const r = await start(base, chat.id, flow.id, "Branch-3");
    assert.equal((await untilStatus(base, r.run.id, "waiting", "done", "failed")).run.status, "waiting");
    await waitForQuiet(base);
    const [point] = await reviewPoints(base, chat.id);
    assert.ok(point, "review item is missing");
    // Like the agent with cbase_agenda_write: two sub-items, one already done.
    await json(`${base}/api/chats/${chat.id}/agenda`, { method: "PUT", body: JSON.stringify({ steps: [
      { op: "fresh", text: "Click through the checkout", under: point.id },
      { op: "fresh", text: "Recompute the total", under: point.id, status: "done" },
    ] }) });

    // ── Round 1: findings → fix → round 2 ──
    await say(base, chat.id, "The save button does nothing, and the total rounds wrong.");
    await waitFor(async () => { const d = await runOf(base, r.run.id); return d.run.status === "waiting" && /round 2/.test(d.run.question) ? d : null; });
    await waitForQuiet(base);
    const round2 = (await runOf(base, r.run.id)).steps.filter((s) => s.kind === "review" && !s.detail.verdict).at(-1);
    assert.equal(round2.detail.agendaError, undefined, `Round 2 without agenda error: ${JSON.stringify(round2.detail)}`);
    assert.equal(round2.detail.point, point.id, "round 2 continues the SAME item");
    const two = await reviewPoints(base, chat.id);
    assert.equal(two.length, 1, `no second review item: ${JSON.stringify(two)}`);
    assert.match(two[0].note, /REVIEW-REQUEST \(round 2\)/, "the note is the new request");

    // ── Round 2: approval ──
    await say(base, chat.id, "passt");
    const finished = await untilStatus(base, r.run.id, "done", "failed");
    assert.equal(finished.run.status, "done", `Run ended as ${finished.run.status}: ${finished.run.note}`);
    await waitForQuiet(base);
    const ok = finished.steps.find((s) => s.kind === "review" && s.detail.verdict === "ok");
    assert.equal(ok.detail.agendaError, undefined, `Approval without agenda error: ${JSON.stringify(ok.detail)}`);
    const steps = (await agendaOf(base, chat.id)).steps;
    const p = steps.find((s) => s.id === point.id);
    assert.equal(p.status, "done", `with the approval the item is (computed) done: ${JSON.stringify(steps)}`);
    assert.deepEqual(steps.filter((s) => s.parent === point.id).map((s) => s.status), ["done", "done"], "both leaves ticked off");
  });
});

// A run with an old vars.reviewTodo continues. A run that stood at the card across a deploy carries `vars.reviewTodo` and
// `pending.todoId` but no item — none of it is read, the answer moves on, and the old field drops at the next write of the
// variables. Counter-test (sabotage: `base` without withoutReviewTodo in workflows/gates.js): `reviewTodo` still stands in the
// variables after the approval — red.
test("A legacy run (vars.reviewTodo, pending.todoId, no item) continues after the answer", async () => {
  await withServer(async ({ base, ws, turns }) => {
    const flow = await makeFlow(base, ws, "Review-Legacy", reviewFlow());
    const chat = await newChat(base, ws, "Legacy");
    const r = await start(base, chat.id, flow.id, "Branch-4");
    assert.equal((await untilStatus(base, r.run.id, "waiting", "done", "failed")).run.status, "waiting");
    await waitForQuiet(base);
    // Recreate the legacy state: no item in the agenda, the todo only as an id in the cursor.
    const [point] = await reviewPoints(base, chat.id);
    await json(`${base}/api/chats/${chat.id}/agenda`, { method: "PUT", body: JSON.stringify({ steps: [{ op: "erase", id: point.id }] }) });
    const old = store.getWorkflowRun(chat.id);
    const { reviewPoint: _p, ...vars } = old.cursor.vars || {};
    const { point: _q, ...pending } = old.cursor.pending || {};
    store.updateWorkflowRun(chat.id, { cursor: { ...old.cursor, vars: { ...vars, reviewTodo: "todo-before-ab7" }, pending: { ...pending, todoId: "todo-before-ab7" } } });
    assert.equal(store.getWorkflowRun(chat.id).cursor.pending.kind, "review", "the card is still there");

    await say(base, chat.id, "passt");
    const finished = await untilStatus(base, r.run.id, "done", "failed");
    assert.equal(finished.run.status, "done", `Run ended as ${finished.run.status}: ${finished.run.note}`);
    await waitForQuiet(base);
    assert.match(turns().at(-1), /PHASE FIVE/, "after the approval the approval path runs");
    const ok = finished.steps.find((s) => s.kind === "review" && s.detail.verdict === "ok");
    assert.ok(ok, `no approval step: ${JSON.stringify(finished.steps.map((s) => s.kind))}`);
    assert.equal(ok.detail.agendaError, undefined, `no agenda error: ${JSON.stringify(ok.detail)}`);
    assert.equal(Object.hasOwn(store.getWorkflowRunById(r.run.id).cursor.vars || {}, "reviewTodo"), false, "the old field drops at the next write");
    assert.equal((await reviewPoints(base, chat.id)).length, 0, "the answer creates no item afterwards");
  });
});

// An archived chat does not stop the gate. The store throws `archived` (store/agenda.js agendaChange reads the chat row
// fresh) — once when creating, once at completion. Archiving happens through a TEMP trigger exactly at the moment before
// (the answer of the request turn, or the human's message): the routes before it still saw the chat open. Counter-test
// (sabotage: agendaErrorDetail always returns {}): both checks on `agendaError` red.
test("An archived chat does not stop the review gate — creating and completion run through, the error stands in the log", async () => {
  await withServer(async ({ base, ws }) => {
    const flow = await makeFlow(base, ws, "Review-Archive", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "r1", type: "review", title: "Review", x: 200, y: 0 },
        { id: "e1", type: "end", title: "End", x: 420, y: 90 },
        { id: "e2", type: "end", title: "End ok", x: 420, y: -60 },
      ],
      edges: [{ from: "s0", to: "r1" }, { from: "r1", to: "e1", branch: "issues" }, { from: "r1", to: "e2", branch: "ok" }],
    });
    const archiveAt = (name, chatId, role) => db.exec(`CREATE TEMP TRIGGER ${name} AFTER INSERT ON messages
      WHEN new.chat_id = '${chatId}' AND new.role = '${role}' BEGIN UPDATE chats SET archived_at = 1 WHERE id = new.chat_id; END`);
    const open = (chatId) => db.prepare("UPDATE chats SET archived_at = NULL WHERE id = ?").run(chatId);
    try {
      // 1) Creating: archived as soon as the answer of the request turn stands — BEFORE the item.
      const a = await newChat(base, ws, "Archived at creation");
      archiveAt("rep2_archive_create", a.id, "assistant");
      const ra = await start(base, a.id, flow.id);
      const waiting = await untilStatus(base, ra.run.id, "waiting", "done", "failed");
      assert.equal(waiting.run.status, "waiting", `Run should wait despite the archive, was ${waiting.run.status}: ${waiting.run.note}`);
      db.exec("DROP TRIGGER rep2_archive_create");
      await waitForQuiet(base);
      const request = waiting.steps.filter((s) => s.kind === "review").at(-1);
      assert.equal(request.detail.agendaError, "archived", `Creating: ${JSON.stringify(request.detail)}`);
      assert.equal(request.detail.point, "");
      open(a.id);
      await say(base, a.id, "passt");
      assert.equal((await untilStatus(base, ra.run.id, "done", "failed")).run.status, "done");
      await waitForQuiet(base);

      // 2) Completion: the item stands, archiving happens with the human's message — BEFORE the tick-off.
      const b = await newChat(base, ws, "Archived at completion");
      const rb = await start(base, b.id, flow.id);
      assert.equal((await untilStatus(base, rb.run.id, "waiting", "done", "failed")).run.status, "waiting");
      await waitForQuiet(base);
      assert.equal((await reviewPoints(base, b.id)).length, 1);
      archiveAt("rep2_archive_completion", b.id, "user");
      await say(base, b.id, "passt");
      const finished = await untilStatus(base, rb.run.id, "done", "failed");
      db.exec("DROP TRIGGER rep2_archive_completion");
      assert.equal(finished.run.status, "done", `Run ended as ${finished.run.status}: ${finished.run.note}`);
      const ok = finished.steps.find((s) => s.kind === "review" && s.detail.verdict === "ok");
      assert.equal(ok?.detail.agendaError, "archived", `Completion: ${JSON.stringify(ok?.detail)}`);
      open(b.id);
      await waitForQuiet(base);
    } finally {
      db.exec("DROP TRIGGER IF EXISTS rep2_archive_create; DROP TRIGGER IF EXISTS rep2_archive_completion;");
    }
  });
});
