// Start and end of a scheduled run on EVERY path — scheduled/run.js scheduledTurnStart, scheduledEndHook, scheduledDismissedHook,
// scheduledAbandoned and the marker `scheduledRun`. Main seam: real server, real routes, fake Claude from the agent harness; an
// occurrence ("Scheduled run …", German under uiLang "de") waits at gate g1, g2, … in its order, the human's message
// "GATE:x" at gate x. No time window.
//
// The promises, each with the sabotage that breaks it (each turns only the named test red):
//   (1) An occurrence whose resume after the restart is ABANDONED (runs/resume.js, MAX_RESUME_ATTEMPTS) ends `error` — without a retry;
//       the next occurrence closes itself, and the job is deletable. Sabotage: without the registration
//       `registerHook("restartGraceAbandoned", scheduledAbandoned, …)` in server.js it stays open.
//   (2) If the gate throws (doRun before the try), the occurrence ends `error` with the thrown wording. Sabotage: without the line
//       `if (thrown) fireHooks("beforeRunBroadcast", …)` in runs/limit-gate.js clearAwayGateWithoutTurn it stays open.
//   (3) A dismissed wait row: the human (strip) => `aborted` without a note; the machine (attempt cap, switch "auto-continue off")
//       => `error` with the wording and a note, without a retry. Sabotage: scheduled/run.js scheduledDismissedHook without
//       distinguishing by `kind` (always `aborted`).
//   (4) A QUEUED occurrence does not close an open question (the human can still answer it); only its START resolves card and
//       bell note, and `startedAt` is that start, not the queueing. Sabotage: without the registration
//       `registerHook("turnStart", scheduledTurnStart, …)` in server.js.
//   (5) If the gate holds back a directly delivered occurrence behind a FOREIGN wait row (runs/limit-gate.js parkOrQueue), the new
//       entry carries the marker of its run and the human input: the run counts as queued, a second occurrence fails, and the turn
//       runs with the occurrence's human input. Sabotage: parkOrQueue without the occurrence's fields.
//   (6) If the human dismisses this NEWLY queued entry (new id, only the marker `scheduledRun`, the run's `entryId` stays null), the
//       run becomes `dismissed` and the job is deletable at once. Sabotage: scheduled/run.js scheduledInputDismissed searching only
//       by `entryId` — the run stays `open`, the job DELETE answers 409.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import * as store from "../electron/server/store.js";
import { startRun } from "../electron/server/scheduled/run.js";
import { scheduledAtStart } from "../electron/server/scheduled/tick.js";
import { stateOf } from "../electron/server/scheduled/routes.js";
import { nextOccurrence, cadenceOff } from "../electron/server/scheduled/cadence.js";
import { resumeInterruptedWork } from "../electron/server/runs/resume.js";
import { cancelAutoContinue } from "../electron/server/runs/auto-continue.js";
import { pendingRunInputs } from "../electron/server/runs/state.js";
import { humanInput } from "../electron/server/runs/human-input.js";
import { openAskOf, postAsk } from "../electron/server/runs/ask.js";
import { setProjectLock } from "../electron/server/runs/project-lock.js";
import { projectLock } from "../electron/server/projectbox/idle.js";
import { getMonitorEvents } from "../electron/server/services.js";

const claude = fakeClaude({
  main: `
  // "limit-on" in the location: an occurrence fails on the usage limit (CLI wording, reset in an hour — only the test wakes it).
  if (String(text).includes("Geplanter Lauf") && fs.existsSync(path.join(LOCATION, "limit-on"))) {
    process.stderr.write("Claude usage limit reached · resets at " + new Date(Date.now() + 3600000).toISOString() + "\\n");
    process.exit(1);
  }
  let tag = (String(text).match(/GATE:(\\w+)/) || [])[1] || "";
  if (!tag && String(text).includes("Geplanter Lauf")) {
    const f = path.join(LOCATION, "scheduled-count");
    const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0) + 1;
    fs.writeFileSync(f, String(n));
    tag = "g" + n;
  }
  if (tag) await gate(tag);
  finished();
  say({ type: "result", result: "Erledigt " + tag, session_id: "s-main" });`,
});

// A private copy of the two helpers from scheduled-run.test.js (a .test.js never imports another).
function jobAt(chat, { instructions = "Enter the working hours.", title = "Working hours" } = {}) {
  const r = cadenceOff("daily", { clockTime: "22:00" }, { timeZone: "Europe/Berlin" });
  assert.ok(r.ok, JSON.stringify(r));
  const now = Date.now();
  const raw = { id: crypto.randomUUID(), workspaceId: chat.workspaceId, instructions, cadence: "daily", plan: r.plan, cron: r.cron, oneTimeAt: r.oneTimeAt, timeZone: "Europe/Berlin", createdAt: now };
  store.createScheduledJob({ ...raw, nextAt: nextOccurrence({ ...raw }, now) });
  store.updateChat(chat.id, { jobId: raw.id, title, titled: 1 });
  return store.getScheduledJob(raw.id);
}
const hints = (chatId) => store.listMessages(chatId).filter((m) => m.role === "hint").map((m) => m.text);
const send = (base, chatId, text) => json(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });
const notes = (chatId, kind) => getMonitorEvents(0).filter((n) => n.chatId === chatId && n.kind === kind);
const through = async ({ gate, waitForIdle }, tag) => { await gate.reached(tag); gate.open(tag); await waitForIdle(); };
// A failure must not become a hang: all gates open in the finally (see scheduled-run.test.js).
const withOpenGates = async (ctx, fn) => { try { await fn(); } finally { for (const t of ["g1", "g2", "g3", "k1", "k2"]) ctx.gate.open(t); } };
async function raw(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init.headers || {}) } });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

test("abandoned resume: the occurrence ends `error`, the next closes itself, the job is deletable", async () => {
  await withAgentsServer(async (ctx) => withOpenGates(ctx, async () => {
    const { base, ws, chat, waitForQuiet } = ctx;
    const a = jobAt(chat);
    await waitForQuiet();
    // State after the third crash in the middle of an occurrence: open run, active_runs row of the occurrence with two attempts used.
    const old = store.createScheduledRun({ jobId: a.id, workspaceId: a.workspaceId, chatId: chat.id, cause: "tick", startedAt: Date.now() });
    store.setActiveRun(chat.id, { kind: "chat:schedule", prompt: "Geplanter Lauf „Working hours“ — before the crash", startedAt: Date.now() });
    store.bumpActiveRunAttempts(chat.id);
    store.bumpActiveRunAttempts(chat.id);
    scheduledAtStart();
    assert.equal(store.getScheduledRun(old.id).status, "open", "with an active_runs row it is left to the resume");
    resumeInterruptedWork();
    const l = store.getScheduledRun(old.id);
    assert.deepEqual([l.status, l.error], ["error", "Wiederanlauf nach dem Neustart aufgegeben"], JSON.stringify(l));
    assert.equal(store.getScheduledJob(a.id).retryAt, 0, "no retry — the turn may already have taken effect");

    const fresh = startRun(store.getScheduledJob(a.id), "hand").run;
    await through(ctx, "g1");
    assert.equal(store.getScheduledRun(fresh.id).status, "ok", "the next occurrence closes itself");
    assert.equal(store.getScheduledRun(old.id).status, "error", "and not the old one again");
    const way = await raw(`${base}/api/workspaces/${ws.id}/scheduled/${a.id}`, { method: "DELETE" });
    assert.equal(way.status, 200, JSON.stringify(way.body));
  }), { claude });
});

test("a throw in the gate ends the occurrence `error` with its wording", async () => {
  await withAgentsServer(async (ctx) => withOpenGates(ctx, async () => {
    const { chat, waitForQuiet } = ctx;
    const a = jobAt(chat);
    await waitForQuiet();
    // The database does not answer in the head of doRun: the project lock (otherwise the real one, projectbox/idle.js) returns for the
    // SECOND call of this chat — doRun, after delivery — a verdict whose reason throws on reading. Delivery (first call) sees the real lock.
    let n = 0;
    const thrown = { kind: "wait", get reason() { throw new Error("EIO: database not answering"); } };
    setProjectLock((chatId, purpose, ...rest) => (chatId === chat.id && purpose === "turn" && ++n === 2 ? thrown : projectLock(chatId, purpose, ...rest)));
    let run;
    try {
      run = startRun(a, "hand").run;
      // Wait for IDLE, not for the end of the occurrence: without the report (the counter-test) that would be a hang instead of a red
      // test. The throw comes in the synchronous head of doRun; afterwards the chat is free.
      await ctx.waitForIdle();
    } finally { setProjectLock(projectLock); }
    assert.equal(n, 2, "the lock was asked for delivery and doRun");
    const l = store.getScheduledRun(run.id);
    assert.equal(l.status, "error", JSON.stringify(l));
    assert.match(l.error, /EIO: database not answering/);
    assert.ok(store.getScheduledJob(a.id).retryAt > 0, "a first error is retried (the throw may heal)");
    await waitForQuiet();
  }), { claude });
});

test("dismissed wait row: the human => aborted without a note, the machine => error with wording and note", async () => {
  await withAgentsServer(async (ctx) => withOpenGates(ctx, async () => {
    const { base, chat, root, waitForTruthy } = ctx;
    const a = jobAt(chat);
    fs.writeFileSync(path.join(root, "limit-on"), "1");
    const parking = async () => {
      const run = startRun(store.getScheduledJob(a.id), "hand").run;
      await waitForTruthy(async () => (store.getPendingResume(chat.id) && (await json(`${base}/api/runs/active`)).runs === 0 ? true : null), "the occurrence is parked");
      assert.equal(store.getScheduledRun(run.id).status, "open");
      return run;
    };

    // The machine: the attempt cap (runs/auto-continue.js maybeAutoContinue, kind "gave-up" with the row's wording).
    let run = await parking();
    const prior = notes(chat.id, "schedule").length;
    cancelAutoContinue(chat.id, { kind: "gave-up", reason: "Session limit: no further attempts after 12 automatic continuations." });
    let l = store.getScheduledRun(run.id);
    assert.deepEqual([l.status, l.error], ["error", "Session limit: no further attempts after 12 automatic continuations."], JSON.stringify(l));
    assert.equal(store.getScheduledJob(a.id).retryAt, 0, "no retry — it would run into the same limit");
    assert.equal(notes(chat.id, "schedule").length, prior + 1, "one note: the run was lost silently");

    // The machine: the switch "auto-continue off" (real route, kind "off" with the note as the row).
    run = await parking();
    const out = await raw(`${base}/api/auto-continue`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    l = store.getScheduledRun(run.id);
    assert.deepEqual([l.status, l.error], ["error", "Automatisches Fortsetzen wurde ausgeschaltet."], JSON.stringify(l));
    await raw(`${base}/api/auto-continue`, { method: "PUT", body: JSON.stringify({ enabled: true }) });

    // The human: "Cancel" on the strip (DELETE …/auto-continue, kind "cancel").
    run = await parking();
    const count = notes(chat.id, "schedule").length;
    const way = await raw(`${base}/api/chats/${chat.id}/auto-continue`, { method: "DELETE" });
    assert.equal(way.status, 200, JSON.stringify(way.body));
    l = store.getScheduledRun(run.id);
    assert.equal(l.status, "aborted", JSON.stringify(l));
    assert.equal(notes(chat.id, "schedule").length, count, "the human knows — no note");
    fs.rmSync(path.join(root, "limit-on"));
  }), { claude });
});

test("queued does not close a question; the start resolves card and note and is `startedAt`", async () => {
  await withAgentsServer(async (ctx) => withOpenGates(ctx, async () => {
    const { base, chat, gate, waitForIdle } = ctx;
    const a = jobAt(chat);
    await send(base, chat.id, "Me first GATE:k1");
    await gate.reached("k1");
    // The card of the running turn — the human can answer it as long as the occurrence only waits.
    const question = postAsk(chat.id, [{ question: "Which week?", options: [] }]);
    const run = startRun(a, "tick").run;
    assert.ok(run.entryId, "the occurrence is queued");
    assert.equal(openAskOf(chat.id)?.requestId, question.requestId, "the card stays open while the occurrence waits");
    assert.ok(!hints(chat.id).some((h) => /Rückfrage wurde geschlossen/.test(h)));
    assert.equal(store.getScheduledRun(run.id).startedAt, 0, "queued is not started");

    const on = Date.now();
    gate.open("k1");
    await gate.reached("g1");
    const l = store.getScheduledRun(run.id);
    assert.ok(l.startedAt >= on, `startedAt is the start (${l.startedAt} < ${on})`);
    assert.equal(openAskOf(chat.id), null, "the card is closed");
    assert.equal(notes(chat.id, "question").find((n) => n.requestId === question.requestId)?.resolved, true, "the bell note is resolved");
    assert.ok(hints(chat.id).some((h) => /Rückfrage wurde geschlossen/.test(h)));
    gate.open("g1");
    await waitForIdle();
    assert.ok(store.getScheduledRun(run.id).startedAt >= on, "the end does not move the start");
  }), { claude });
});

test("the gate puts a directly delivered occurrence behind a foreign wait row: the entry carries marker and human input", async () => {
  await withAgentsServer(async (ctx) => withOpenGates(ctx, async () => {
    const { chat, waitForQuiet, waitForIdle, gate } = ctx;
    const a = jobAt(chat, { instructions: "Enter the working hours." });
    await waitForQuiet();
    // The race: between delivery and gate a foreign run wait row appears (another path parked), and the project lock holds the turn
    // (reason "project") — parkOrQueue queues it behind the row instead of overwriting it.
    let n = 0;
    setProjectLock((chatId, purpose, ...rest) => {
      if (chatId === chat.id && purpose === "turn" && ++n === 2) {
        store.setPendingResume(chat.id, { kind: "run", prompt: "Foreign job", provider: "claude", reason: "reset", dueAt: Date.now() + 3_600_000 });
        return { kind: "wait", reason: "project", state: "start", text: "The instance is starting." };
      }
      return projectLock(chatId, purpose, ...rest);
    });
    let run;
    try {
      run = startRun(a, "tick").run;
      await ctx.waitForTruthy(() => ((pendingRunInputs.get(chat.id) || []).length ? true : null), "the occurrence is in the queue");
    } finally { setProjectLock(projectLock); }
    const [entry] = pendingRunInputs.get(chat.id);
    assert.deepEqual([entry.scheduledRun, entry.cause, entry.causeSpecified], [run.id, "schedule", "schedule"], JSON.stringify(entry));
    assert.ok(entry.human.includes("Enter the working hours."), "the human input travels along");
    assert.equal(stateOf(store.getScheduledJob(a.id)), "queued");
    assert.equal(startRun(store.getScheduledJob(a.id), "tick").run.status, "failed", "a second occurrence fails");

    // The human dismisses the foreign row — the queue drains, the occurrence runs with its human input.
    cancelAutoContinue(chat.id, { note: "Waiting for the limit reset was cancelled." });
    await gate.reached("g1");
    const human = humanInput(chat.id);
    assert.equal(human.length, 1);
    assert.ok(human[0].includes("Enter the working hours."), JSON.stringify(human));
    gate.open("g1");
    await waitForIdle();
    assert.equal(store.getScheduledRun(run.id).status, "ok");
  }), { claude });
});

test("the human dismisses the occurrence newly queued by the gate: the run becomes `dismissed`, the job is deletable", async () => {
  await withAgentsServer(async (ctx) => withOpenGates(ctx, async () => {
    const { base, ws, chat, waitForQuiet } = ctx;
    const a = jobAt(chat);
    await waitForQuiet();
    // The same race as in (5): the gate queues the occurrence anew behind a foreign row (new id, only the marker).
    let n = 0;
    setProjectLock((chatId, purpose, ...rest) => {
      if (chatId === chat.id && purpose === "turn" && ++n === 2) {
        store.setPendingResume(chat.id, { kind: "run", prompt: "Foreign job", provider: "claude", reason: "reset", dueAt: Date.now() + 3_600_000 });
        return { kind: "wait", reason: "project", state: "start", text: "The instance is starting." };
      }
      return projectLock(chatId, purpose, ...rest);
    });
    let run;
    try {
      run = startRun(a, "tick").run;
      await ctx.waitForTruthy(() => ((pendingRunInputs.get(chat.id) || []).length ? true : null), "the occurrence is in the queue");
    } finally { setProjectLock(projectLock); }
    const [entry] = pendingRunInputs.get(chat.id);
    assert.equal(entry.scheduledRun, run.id);
    assert.notEqual(entry.id, store.getScheduledRun(run.id).entryId, "the entry is NEW — the run does not know its id");

    const r = await raw(`${base}/api/chats/${chat.id}/message/queue/${entry.id}`, { method: "DELETE" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(store.getScheduledRun(run.id).status, "dismissed", JSON.stringify(store.getScheduledRun(run.id)));
    const way = await raw(`${base}/api/workspaces/${ws.id}/scheduled/${a.id}`, { method: "DELETE" });
    assert.equal(way.status, 200, JSON.stringify(way.body));
    cancelAutoContinue(chat.id, { note: "Waiting for the limit reset was cancelled." });
  }), { claude });
});
