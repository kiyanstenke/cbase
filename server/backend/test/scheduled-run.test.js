// The run of a scheduled job: scheduled/run.js startRun and the hook consumers — main seam: real server, real routes, real cbase MCP
// server, fake Claude from the agent harness. Every turn of the fake waits at a gate: "GATE:x" in the text, an occurrence
// ("Scheduled run …", German under uiLang "de") at gate g1, g2, … in its order. Reading happens while the turn
// waits there; no time window.
//
// The promises, each with the way that breaks it:
//   (1) A busy chat queues the occurrence, the second occurrence drops out (row `hint`), "run now" is then 409. The human's entries
//       run in FIFO order with the occurrence; NOTHING goes into a foreign process — the occurrence not into the human's turn
//       (counter-test: without the line in runs/state.js inputFitsIntoTheRun, red with "the occurrence did NOT run in the human's
//       process" — it was injected at the `result`, same pid), the human's message not into the scheduled turn (`causeOf`, do-run.js).
//       The instructions are in the system prompt, the occurrence message is short; the occurrence's human input is "scheduled"
//       (ultracode applies, `turnWithoutHuman` is false).
//   (2) An aborted run is not repeated; a dismissed entry yields `dismissed`; an open question at the next occurrence is closed,
//       with its bell note; deleting the chat deletes the job.
//   (3) An error: the first sets the retry, the retry does not. `/workflow:` in the instructions: a hit travels along as an
//       announcement; a refusal ends as `error` with its wording, retried only on 409 `open`.
//   (4) In a job chat cbase_chat_set_project and cbase_switch_instance change nothing and answer with the sentence; in a chat
//       without a job both work (the counter-test) — on the REAL MCP process with the instance id of a run. On the server too:
//       POST …/instance => 409 JOB_ONLY_HUMAN, and instanceChoice/chatInstanceSet let only `ofHuman` through (counter-test:
//       without the line in runs/instance-switch.js instanceChoice the route answers 409 with another code).
//   (5)–(7) scheduled/tick.js: the tick starts a due occurrence, catches up a late one, books one beyond half the period as `missed`,
//       runs the retry and leaves a paused one alone (the tick is called directly, the occurrence put into the past via
//       `next_at`/`retry_at` — no clock, no pause; counted via scheduledTicks). A queued run survives ctx.restart() and starts, a run
//       without a runner ends "Server restarted". A parked run (usage limit) stays open — also on cleanup — and ends only with
//       its continuation.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { T } from "../electron/server/i18n.js";
import * as store from "../electron/server/store.js";
import { endRun, summary, startRun } from "../electron/server/scheduled/run.js";
import { scheduledAtStart, scheduledTick, scheduledTicks } from "../electron/server/scheduled/tick.js";
import { fireAutoContinue, runInputsRestartGrace } from "../electron/server/runs/auto-continue.js";
import { nextOccurrence, cadenceOff } from "../electron/server/scheduled/cadence.js";
import { humanInput, turnWithoutHuman, announcementsInTurn } from "../electron/server/runs/human-input.js";
import { keywordInTurn } from "../electron/server/dynworkflows/approval.js";
import { openAskOf, postAsk } from "../electron/server/runs/ask.js";
import { getMonitorEvents } from "../electron/server/services.js";
import { InstanceChoiceError, chatInstanceSet, instanceChoice } from "../electron/server/runs/instance-switch.js";
import { withMcp } from "./server-harness.mjs";

const MCP_BASE = { CBASE_TOOLS: undefined, CBASE_TOOLSET: undefined, CBASE_SKILLS: undefined, CBASE_AGENT_DEPTH: undefined, CBASE_SCHEMA: undefined, CBASE_WORKFLOW_AGENT: undefined, CBASE_INSTANCE: undefined, CBASE_TOKEN: undefined };

const SET = "Project and instance of a scheduled job are changed only by the user under Coding → Scheduled";

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
  fs.appendFileSync(path.join(LOCATION, "inputs.jsonl"), JSON.stringify({ tag, pid: process.pid, text, sp: arg("--append-system-prompt") }) + "\\n");
  if (String(text).includes("ERROR-TURN")) process.exit(2);
  if (tag) await gate(tag);
  finished();
  say({ type: "result", result: "Erledigt " + tag + "\\n\\nRest", session_id: "s-main" });`,
});

const inputs = (root) => {
  const f = path.join(root, "inputs.jsonl");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((z) => JSON.parse(z)) : [];
};
const input = (root, tag) => inputs(root).find((e) => e.tag === tag);
const send = (base, chatId, text) => json(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });

// A job on the test's chat — directly via the store; name = the chat's title.
function jobAt(chat, { instructions = "Enter the working hours.", cadence = "daily", plan = { clockTime: "22:00" }, timeZone = "Europe/Berlin", title = "Working hours" } = {}) {
  const r = cadenceOff(cadence, plan, { timeZone });
  assert.ok(r.ok, JSON.stringify(r));
  const now = Date.now();
  const raw = { id: crypto.randomUUID(), workspaceId: chat.workspaceId, instructions, cadence, plan: r.plan, cron: r.cron, oneTimeAt: r.oneTimeAt, timeZone, createdAt: now };
  store.createScheduledJob({ ...raw, nextAt: nextOccurrence({ ...raw }, now) });
  store.updateChat(chat.id, { jobId: raw.id, title, titled: 1 });
  return store.getScheduledJob(raw.id);
}
const runs = (a) => store.listScheduledRuns(a.id, { limit: 50 }).reverse();
const hints = (chatId) => store.listMessages(chatId).filter((m) => m.role === "hint").map((m) => m.text);

test("busy => queued, second occurrence dropped; FIFO with the human, nothing into a foreign process; prompt, occurrence message, human input", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForIdle }) => {
    const a = jobAt(chat, { instructions: "Enter the working hours. ultracode" });
    await send(base, chat.id, "Me first GATE:k1");
    await gate.reached("k1");

    const first = startRun(a, "tick").run;
    assert.equal(first.status, "open");
    assert.ok(first.entryId, "the occurrence waits as an entry in the queue");
    const two = await send(base, chat.id, "Then me GATE:k2");
    assert.equal(two.queued, true);
    const failed = startRun(a, "tick").run;
    assert.equal(failed.status, "failed");
    assert.ok(hints(chat.id).some((h) => /ausgefallen/.test(h)), "the drop-out is in the history as a hint");
    assert.throws(() => startRun(a, "hand"), (e) => e.status === 409, "\"run now\" is 409 while an occurrence waits");

    gate.open("k1");
    await gate.reached("g1");
    const g1 = input(root, "g1");
    assert.notEqual(g1.pid, input(root, "k1").pid, "the occurrence did NOT run in the human's process (injected at the result)");
    // The history row is the short occurrence message; the model reads it behind the ultracode prefix (the instructions carry
    // "ultracode" — the prefix IS the proof that the occurrence's human input counts).
    const occurrence = store.listMessages(chat.id).filter((m) => m.role === "user").map((m) => m.text).find((t) => t.startsWith("Geplanter Lauf"));
    assert.match(occurrence, /^Geplanter Lauf „Working hours“ — \S+ \d\d\.\d\d\.\d{4} \d\d:\d\d \(Europe\/Berlin\)$/, occurrence);
    assert.ok(g1.text.endsWith(occurrence), g1.text.slice(-300));
    assert.ok(g1.text.includes("<cbase-ultracode>"), "\"ultracode\" in the instructions carries the user turn's prefix");
    assert.ok(!g1.text.includes("Enter the working hours"), "the instructions are not in the occurrence message");
    assert.ok(g1.sp.includes("# Scheduled job of this chat") && g1.sp.includes("Enter the working hours. ultracode"), "the instructions are in the system prompt");
    assert.ok(g1.sp.includes("Täglich um 22:00") && g1.sp.includes("time zone Europe/Berlin"), "rhythm and zone in the head");
    assert.ok(!g1.text.includes("Me first") && !g1.text.includes("Then me GATE"), "the occurrence goes alone");
    const human = humanInput(chat.id);
    assert.equal(human.length, 1);
    assert.ok(human[0].includes("Enter the working hours. ultracode"), "the occurrence's human input carries the instructions");
    assert.equal(turnWithoutHuman(chat.id), false);
    assert.equal(keywordInTurn(chat.id), true, "\"ultracode\" in the instructions takes effect");

    // The human's message does not go into the scheduled turn — it waits behind it.
    const three = await send(base, chat.id, "Thirdly");
    assert.equal(three.queued, true);
    gate.open("g1");
    await gate.reached("k2");
    const k2 = input(root, "k2");
    assert.notEqual(k2.pid, g1.pid, "the human's entries did not run in the scheduled process");
    assert.ok(k2.text.includes("Thirdly"), "its two entries run bundled, in their order");
    assert.ok(k2.text.indexOf("Then me") < k2.text.indexOf("Thirdly"));
    gate.open("k2");
    await waitForIdle();

    const [l1, l2] = runs(a);
    assert.equal(l1.status, "ok", JSON.stringify(l1));
    assert.equal(l1.short, "Erledigt g1");
    assert.equal(l2.status, "failed");
    assert.equal(store.getScheduledJob(a.id).lastStatus, "ok");
  }, { claude });
});

test("aborted without retry, dismissed, open question closed, deleting the chat deletes the job", async () => {
  await withAgentsServer(async ({ base, chat, gate, waitForIdle, waitForQuiet }) => {
    const a = jobAt(chat);
    const question = postAsk(chat.id, [{ question: "Which week?", options: [] }]);
    assert.ok(openAskOf(chat.id));
    const run = startRun(a, "tick").run;
    // The START of the occurrence closes the card (scheduled/run.js scheduledTurnStart), not the delivery — the turn waits at the
    // gate, it has begun.
    await gate.reached("g1");
    assert.equal(openAskOf(chat.id), null, "the card is closed");
    assert.ok(hints(chat.id).some((h) => /Rückfrage wurde geschlossen/.test(h)));
    const note = getMonitorEvents(0).find((n) => n.kind === "question" && n.requestId === question.requestId);
    assert.ok(note, "the question had a bell note");
    assert.equal(note.resolved, true, "the bell note is resolved");
    await json(`${base}/api/chats/${chat.id}/stop`, { method: "POST", body: "{}" });
    await waitForIdle();
    assert.equal(store.getScheduledRun(run.id).status, "aborted");
    assert.equal(store.getScheduledJob(a.id).retryAt, 0, "an aborted run is not repeated");

    await send(base, chat.id, "Me GATE:k1");
    await gate.reached("k1");
    const waiting = startRun(a, "tick").run;
    const r = await fetch(`${base}/api/chats/${chat.id}/message/queue/${waiting.entryId}`, { method: "DELETE", headers: { Connection: "close" } });
    assert.equal(r.status, 200, await r.text());
    assert.equal(store.getScheduledRun(waiting.id).status, "dismissed");
    gate.open("k1");
    await waitForIdle();
    assert.equal(store.getScheduledRun(waiting.id).status, "dismissed", "the end of the foreign turn does not close the dismissed run again");

    await waitForQuiet();
    const way = await fetch(`${base}/api/chats/${chat.id}`, { method: "DELETE", headers: { Connection: "close" } });
    assert.equal(way.status, 200, await way.text());
    assert.equal(store.getScheduledJob(a.id), null, "the job goes with the chat");
    assert.deepEqual(store.listScheduledRuns(a.id), []);
  }, { claude });
});

test("error: repeated once; /workflow: as an announcement, refusal", async () => {
  await withAgentsServer(async ({ base, ws, chat, root, gate, waitForIdle }) => {
    const a = jobAt(chat, { title: "Job ERROR-TURN" });
    const prior = Date.now();
    const l1 = startRun(a, "tick").run;
    await waitForIdle();
    assert.equal(store.getScheduledRun(l1.id).status, "error", JSON.stringify(store.getScheduledRun(l1.id)));
    assert.ok(store.getScheduledJob(a.id).retryAt >= prior, "the first error sets the retry");
    const l2 = startRun(store.getScheduledJob(a.id), "repetition").run;
    await waitForIdle();
    assert.equal(store.getScheduledRun(l2.id).status, "error");
    assert.equal(store.getScheduledJob(a.id).retryAt, 0, "the retry is not repeated again");
    assert.equal(store.getScheduledJob(a.id).lastStatus, "error");

    store.updateChat(chat.id, { title: "Ship job" });
    const fresh = (name, extra = {}) => store.createWorkflow({ id: crypto.randomUUID(), workspaceId: ws.id, name, createdAt: Date.now(), updatedAt: Date.now(), ...extra });
    const ship = fresh("Ship");
    const refusal = (instructions) => {
      store.updateScheduledJob(a.id, { instructions, retryAt: 0 });
      const l = startRun(store.getScheduledJob(a.id), "tick").run;
      return { run: store.getScheduledRun(l.id), job: store.getScheduledJob(a.id) };
    };
    let x = refusal("/workflow:doesnotexist please");
    assert.equal(x.run.status, "error");
    assert.match(x.run.error, /„\/workflow:doesnotexist“ gibt es in diesem Chat nicht/);
    assert.equal(x.job.retryAt, 0, "404 name is not retried");
    for (let i = 0; i < 21; i++) fresh(`Many ${i}`);
    x = refusal(Array.from({ length: 21 }, (_, i) => `/workflow:many-${i}`).join(" "));
    assert.match(x.run.error, /Höchstens 20 Workflows/);
    assert.equal(x.job.retryAt, 0, "400 tooMany is not retried");
    const project = await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Till", path: path.join(root, "workspace", "till") }) });
    store.updateChat(chat.id, { projectId: project.id });
    x = refusal("/workflow:ship");
    assert.match(x.run.error, /gehört nicht zu diesem Chat/);
    assert.equal(x.job.retryAt, 0, "404 foreign is not retried");
    store.updateChat(chat.id, { projectId: null });
    const open = store.startWorkflowRun({ id: crypto.randomUUID(), chatId: chat.id, workflowId: ship.id, workflowName: ship.name, workspaceId: ws.id });
    x = refusal("/workflow:ship");
    assert.match(x.run.error, /schon ein Workflow offen/);
    assert.ok(x.job.retryAt > 0, "409 open is retried — only that heals");
    store.updateWorkflowRunById(open.id, { status: "done" });
    assert.equal(inputs(root).filter((e) => e.text.includes("Ship job")).length, 0, "a refusal does not reach the CLI");

    // Hit: the announcement travels along, the model reads the rewritten prompt around the occurrence message.
    store.updateScheduledJob(a.id, { instructions: "Start /workflow:ship for today.", retryAt: 0 });
    startRun(store.getScheduledJob(a.id), "hand");
    const tag = `g${inputs(root).filter((e) => e.tag.startsWith("g")).length + 1}`;
    await gate.reached(tag);
    const e = input(root, tag);
    assert.ok(e.text.startsWith("[cbase: The human starts these graph workflows with /workflow:]"), e.text);
    assert.ok(e.text.includes("Geplanter Lauf „Ship job“") && e.text.includes("von Hand gestartet"));
    assert.deepEqual(announcementsInTurn(chat.id).map((s) => s.workflows[0].shortName), ["ship"]);
    gate.open(tag);
    await waitForIdle();
  }, { claude });
});

test("in a job chat cbase_chat_set_project and cbase_switch_instance change nothing — without a job they work", async () => {
  await withAgentsServer(async ({ base, ws, chat, root, projectWithoutInstance }) => {
    const project = await projectWithoutInstance({ name: "Till", path: path.join(root, "workspace", "till") });
    // The REAL MCP server of the run, with the instance id that offers a run in a moved project the instance tools.
    const env = { ...MCP_BASE, CBASE_BASE_URL: base, CBASE_CHAT_ID: chat.id, CBASE_WORKSPACE_ID: ws.id, CBASE_INSTANCE: `${project.id}/main` };
    jobAt(chat);
    await withMcp(env, async ({ call, listTools }) => {
      assert.ok((await listTools()).includes("cbase_switch_instance"), "precondition: the tool is offered");
      const p = await call("cbase_chat_set_project", { projectId: project.id });
      const i = await call("cbase_switch_instance", { instance: "copy-k1" });
      assert.equal(p.isError, false, p.text);
      assert.deepEqual([p.data.changed, p.data.hint], [false, SET]);
      assert.deepEqual([i.data.changed, i.data.hint], [false, SET], i.text);
    });
    assert.equal(store.getChat(chat.id).projectId, null, "the project stayed");
    assert.equal(store.getChat(chat.id).instance, null, "the instance stayed");

    // The sentence holds at the SERVER too — the tool's route answers 409 with the code without the tool asking first (an agent with
    // a token or an older MCP process); instanceChoice and chatInstanceSet let only `ofHuman` through (the PATCH outside the fence).
    const route = await fetch(`${base}/api/chats/${chat.id}/instance`, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify({ instance: "copy-k1" }) });
    const body = await route.json();
    assert.deepEqual([route.status, body.code, body.error], [409, "JOB_ONLY_HUMAN", SET]);
    assert.throws(() => instanceChoice(project.id, "copy-k1", { chatId: chat.id }), (e) => e instanceof InstanceChoiceError && e.code === "JOB_ONLY_HUMAN");
    assert.throws(() => instanceChoice(project.id, "copy-k1", { chatId: chat.id, ofHuman: true }), (e) => e.code !== "JOB_ONLY_HUMAN", "the human gets past the rule (and then to the copy check)");
    store.updateChat(chat.id, { projectId: project.id });
    assert.equal(chatInstanceSet(chat.id, "copy-k1"), false, "without `ofHuman` no switch");
    assert.equal(store.getChat(chat.id).instance, null);
    assert.equal(chatInstanceSet(chat.id, "copy-k1", { ofHuman: true, separator: false }), true, "the human switches");
    store.updateChat(chat.id, { projectId: null, instance: null });

    // Counter-test: the same chat without a job — both reach their route.
    store.deleteScheduledJob(store.getChat(chat.id).jobId);
    await withMcp(env, async ({ call }) => {
      const p = await call("cbase_chat_set_project", { projectId: project.id });
      assert.equal(p.isError, false, p.text);
      assert.ok(!p.text.includes(SET));
      const i = await call("cbase_switch_instance", { instance: "copy-k1" });
      assert.ok(!i.text.includes(SET), i.text);
      assert.equal(i.isError, true, "the route answers itself (no live copy k1)");
    });
    assert.equal(store.getChat(chat.id).projectId, project.id, "without a job cbase_chat_set_project takes effect");
  });
});

test("endRun closes only an open run, and a one-time job is done", async () => {
  await withAgentsServer(async ({ chat }) => {
    const a = jobAt(chat, { cadence: "oneTime", plan: { at: Date.now() + 3600_000 } });
    const l = store.createScheduledRun({ jobId: a.id, workspaceId: a.workspaceId, chatId: chat.id, cause: "tick" });
    assert.equal(endRun(l.id, { resultText: "Done." }).status, "ok");
    assert.equal(endRun(l.id, { error: "later" }), null, "a closed run stays as it is");
    const now = store.getScheduledJob(a.id);
    assert.equal(now.status, "done");
    assert.equal(now.nextAt, 0);
  });
});

// Prompt and server say the same: the first paragraph of the answer to an occurrence becomes the notification
// (runs/system-prompt.js). The short form is the first paragraph (up to the blank line), its lines joined with " · ", 200 characters
// with an ellipsis. Counter-test: summary again with firstLines(text, 200) => red here and in the first and sixth test with
// "Erledigt g1 · Rest".
test("short form of an occurrence: the first paragraph, capped — not all lines", () => {
  assert.equal(summary("First paragraph of the answer.\n\nMore in the second."), "First paragraph of the answer.");
  assert.equal(summary("  Line one\nLine two\n \t\nThird paragraph"), "Line one · Line two", "lines WITHIN the paragraph stay, a blank line of whitespace separates");
  assert.equal(summary("A\r\n\r\nB"), "A", "with CRLF too");
  const lang = "x".repeat(250);
  assert.equal(summary(`${lang}\n\nRest`), `${"x".repeat(199)}…`, "cap 200 with an ellipsis");
  assert.equal(summary(""), "");
});

// Pass through a gate: the fake waits there, is released, the chat comes to rest.
const through = async ({ gate, waitForIdle }, tag) => { await gate.reached(tag); gate.open(tag); await waitForIdle(); };
// A failure must not become a hang: an occurrence that starts unexpectedly would otherwise wait at its gate forever, and the
// harness cleanup would wait for its rest. So all occurrence gates open in the finally.
const withOpenGates = async (ctx, fn) => { try { await fn(); } finally { for (let i = 1; i <= 9; i++) ctx.gate.open(`g${i}`); } };

test("tick: due, caught up, missed, retry; paused stays, one-time missed is done", async () => {
  await withAgentsServer(async (ctx) => withOpenGates(ctx, async () => {
    const { chat, root } = ctx;
    const a = jobAt(chat);
    // Set the job and run ONE tick — without an await in between (the server's timer cannot interleave).
    const tick = (fields) => {
      store.updateScheduledJob(a.id, fields);
      const prior = runs(a).length, n = scheduledTicks();
      scheduledTick();
      assert.equal(scheduledTicks(), n + 1, "the tick ran through completely");
      const fresh = runs(a).slice(prior);
      assert.ok(fresh.length <= 1, JSON.stringify(fresh));
      return { run: fresh[0] || null, job: store.getScheduledJob(a.id) };
    };

    const due = Date.now() - 1_000;
    let x = tick({ nextAt: due });
    assert.deepEqual([x.run.cause, x.run.scheduledAt, x.run.status], ["tick", due, "open"]);
    assert.ok(x.job.nextAt > Date.now(), "the occurrence is advanced");
    await through(ctx, "g1");
    assert.equal(store.getScheduledRun(x.run.id).status, "ok");
    assert.ok(!input(root, "g1").text.includes(T(" · caught up").trim()));

    x = tick({ nextAt: Date.now() - 30 * 60_000 });
    assert.equal(x.run.cause, "caughtUp", "beyond the catch-up threshold, within half the period");
    await through(ctx, "g2");
    assert.ok(input(root, "g2").text.includes(T(" · caught up").trim()), "the occurrence message says so");

    const tooLate = Date.now() - 13 * 3_600_000;
    x = tick({ nextAt: tooLate });
    assert.deepEqual([x.run.status, x.run.scheduledAt], ["missed", tooLate], "beyond half the period (daily: 12 h) it becomes missed");
    assert.match(x.run.error, /verpasst — der Rechner war nicht erreichbar/);
    assert.ok(x.job.nextAt > Date.now());
    assert.deepEqual([x.job.status, x.job.lastStatus], ["active", "missed"]);
    assert.equal(inputs(root).filter((e) => e.tag.startsWith("g")).length, 2, "a missed occurrence does not reach the CLI");

    const again = Date.now() - 1;
    x = tick({ retryAt: again });
    assert.deepEqual([x.run.cause, x.run.scheduledAt], ["repetition", again]);
    assert.equal(x.job.retryAt, 0, "the marker is used up");
    await through(ctx, "g3");
    assert.ok(input(root, "g3").text.includes("Wiederholung nach einem Fehler"));

    x = tick({ status: "paused", nextAt: Date.now() - 1_000 });
    assert.equal(x.run, null, "a paused job does not run — the tick looked at it (counted)");

    const oneTime = Date.now() - 7 * 3_600_000;
    x = tick({ status: "active", cadence: "oneTime", oneTimeAt: oneTime, nextAt: oneTime, cron: "" });
    assert.equal(x.run.status, "missed", "one-time: the limit is six hours");
    assert.deepEqual([x.job.status, x.job.nextAt], ["done", 0]);
  }), { claude });
});

test("after restart: a queued run survives ctx.restart() and starts; a run without a runner ends \"Server restarted\"", async () => {
  await withAgentsServer(async (ctx) => withOpenGates(ctx, async () => {
    const { chat, waitForQuiet, restart } = ctx;
    const a = jobAt(chat);
    await waitForQuiet();
    // The state left by a server that died in the middle of the human's turn: the occurrence is in the queue (the row as
    // runs/queue.js deliverUserPrompt writes it), its run is open; a second open run has no runner any more.
    const orphaned = store.createScheduledRun({ jobId: a.id, workspaceId: a.workspaceId, chatId: chat.id, cause: "tick", startedAt: Date.now() });
    const id = crypto.randomUUID();
    const display = "Geplanter Lauf „Working hours“ — before the restart";
    store.replaceRunInputs(chat.id, [{ id, prompt: display, display, attachments: [], cause: "schedule", causeSpecified: "schedule", silent: false, human: `${display}\n\n${a.instructions}` }]);
    const waiting = store.createScheduledRun({ jobId: a.id, workspaceId: a.workspaceId, chatId: chat.id, cause: "tick", queuedAt: Date.now(), entryId: id });

    await restart();
    const v = store.getScheduledRun(orphaned.id);
    const afterTheStart = store.getScheduledRun(waiting.id).status;
    // The queue's restart (in operation 2.5 s after the start; the harness switches the timer off) — BEFORE the assertions, so a
    // failure does not leave the queue standing (the cleanup would otherwise wait forever for its rest).
    assert.equal(runInputsRestartGrace(), 1);
    assert.deepEqual([v.status, v.error], ["error", "Server neu gestartet"]);
    assert.equal(store.getScheduledJob(a.id).retryAt, 0, "no retry — the turn may already have taken effect");
    assert.equal(afterTheStart, "open", "the queued run stays open");
    await through(ctx, "g1");
    const w = store.getScheduledRun(waiting.id);
    assert.equal(w.status, "ok", JSON.stringify(w));
    assert.equal(w.short, "Erledigt g1");
  }), { claude });
});

test("a parked run ends only with the continuation — and stays open on cleanup", async () => {
  await withAgentsServer(async (ctx) => withOpenGates(ctx, async () => {
    const { base, chat, root, waitForTruthy } = ctx;
    const a = jobAt(chat);
    fs.writeFileSync(path.join(root, "limit-on"), "1");
    const run = startRun(a, "tick").run;
    await waitForTruthy(async () => (store.getPendingResume(chat.id) && (await json(`${base}/api/runs/active`)).runs === 0 ? true : null), "the occurrence is parked, no turn runs");
    assert.equal(store.getScheduledRun(run.id).status, "open", "the end of the parked turn does not close the run");
    scheduledAtStart();
    assert.equal(store.getScheduledRun(run.id).status, "open", "parked counts as running — the cleanup leaves it");
    assert.equal(inputs(root).length, 0, "the parked occurrence has not reached a gate yet");

    fs.rmSync(path.join(root, "limit-on"));
    const r = await fireAutoContinue(chat.id);
    assert.ok(r && r.reason !== "target", JSON.stringify(r));
    await through(ctx, "g1");
    const l = store.getScheduledRun(run.id);
    assert.equal(l.status, "ok", JSON.stringify(l));
    assert.equal(store.getScheduledJob(a.id).lastStatus, "ok");
  }), { claude });
});
