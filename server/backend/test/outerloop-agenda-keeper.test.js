// The agenda keeper: the OUTER-LOOP part. The agenda core (route, quiet, version, mark, log) is held by agenda-upkeep.test.js;
// here, through the real server:
//   (1) seed: POST /api/workspaces seeds it, the start seeds one for every workspace without it (server.js) — from the template,
//       `enabled` without a model (ineffective), id `<ws>-a9e0da`, idempotent
//   (2) routes: DELETE 409 (it stays), "reset to template" against ITS template (model, `enabled`, `markUpkeep` stay) — the
//       summarizer still against its own, an own agent 400; `templateNew` per own revision; PATCH `markUpkeep` only on the keeper
//       (else 400, nothing written), only as bool
//   (3) public form: `fixed`, `agendaKeeper`, `markUpkeep` (true only for the keeper), `upkeepTally` on the agent and `upkeep` per
//       run from the log — `null` for every other agent
//   (4) set and frame: ONLY the keeper has cbase_agenda and cbase_agenda_maintain (catalog order, no fence cut, no project
//       location); summarizer and own agent do not, none is selectable; the frame names both and the rule, the input carries the
//       reverted changes fenced (`<reverted>`, defused) — only for the keeper, only if there are any; EVERY lock of the agenda is
//       listed there, also one from a confirmed row or a new item with status (no correction), through the real write path
//   (5) abort at the turn: a turn in the observed chat aborts the keeper's open runs ON THIS CHAT (laeuft and parked, code
//       `INTENDED_END.turn`); its run on another chat and another agent's run on this chat keep running
//   (6) start only in a quiet chat: open question => the quiet clock restarts, after the answer one run; interval in the middle
//       of a turn => no start, nothing consumed; time of day during background work (source of the dynamic workflows) =>
//       deferred, then ONE run; a direct start (follow-up run) creates no row, a woken parked run is aborted (code
//       `INTENDED_END.quiet`, no sentence); "after every run end" at the end of a turn with background work => no run
//
// COUNTER-TESTS (which sabotage turns which test red):
//   server.js without seedMissingAgendaKeeper() at start => (1); workspaces/routes.js without seedAgendaKeeper => (1);
//   outerloop/routes.js DELETE without the keeper's lock => (2); routes.js reset with SUMMARIZER_TEMPLATE for everyone => (2);
//   routes.js PATCH without "keeper only" => (2); publiclyVisible.js `markUpkeep` uncut => (3); set.js `fixed` without the
//   keeper's tools => (4); set.js the tools for EVERY agent => (4); input.js without the block => (4); server.js without the
//   "agenda-keeper" consumer => (5); abort.js without the chat filter => (5); trigger.js quietExpired without keeperWaiting
//   => (6); trigger.js tick without keeperWaiting => (6); run.js startOuterLoopRun without the check => (6); the same check
//   exempted only for "run_end" => (6) (at the run end the protection hangs on it alone — a second one in the hook could not be
//   told apart by any test and is therefore not there); input.js block without locks, or block only on corrections => (4);
//   run.js the deferral as a set again => (6); abort.js reason "turn-begin" instead of the code => (5).
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_MAIN_AGENT_WAIT_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/outerloop-agenda-keeper.test.js

import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { CATALOG_NAMES } from "../electron/mcp/catalog.js";
import { ONLY_AGENDA_KEEPER } from "../electron/mcp/visibility.js";
import { seedAgendaKeeper, seedMissingAgendaKeeper, agendaKeeperId } from "../electron/server/outerloop/seed.js";
import { AGENDA_KEEPER_TEMPLATE as P, SUMMARIZER_TEMPLATE as Z } from "../electron/server/outerloop/template.js";
import { publicAgent, publicAgentShort, publicRun } from "../electron/server/outerloop/publiclyVisible.js";
import { AGENDA_KEEPER_TOOLS, needsProject, outerLoopSet } from "../electron/server/outerloop/set.js";
import { CORRECTIONS_MAX, FRAME_IDENTIFIER_LINE, buildInput, outerLoopFrame } from "../electron/server/outerloop/input.js";
import { startOuterLoopRun } from "../electron/server/outerloop/run.js";
import { INTENDED_END } from "../electron/server/outerloop/intended-end.js";
import { changeAgenda } from "../electron/server/agenda/change.js";
import { outerLoopQuietNow, outerLoopQuietStands, outerLoopTickNow } from "../electron/server/outerloop/trigger.js";
import { fireHooks } from "../electron/server/runs/hooks.js";
import { setBackgroundSource } from "../electron/server/runs/background.js";
import { dynWorkflowsOpen } from "../electron/server/dynworkflows/run.js";
import { nextCronAtZone } from "../electron/server/cron.js";
import { timeZoneDefault } from "../electron/server/workspaces/timeZone.js";
import { OUTER_LOOP_SELECTABLE } from "../electron/server/outerloop/catalog.js";
import { fakeClaude, withAgentsServer } from "./agent-harness.mjs";

const MAINTAIN = "cbase_agenda_maintain";
const READ = "cbase_agenda";
const ANALYSIS = "cbase_chat_analysis";
const MODEL = "claude-haiku-4-5-20251001";

async function request(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close" } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const post = (url, b) => request(url, { method: "POST", body: JSON.stringify(b) });
const patch = (url, b) => request(url, { method: "PATCH", body: JSON.stringify(b) });
const erase = (url) => request(url, { method: "DELETE" });

const ownAgent = (wid, fields = {}) => store.createOuterLoopAgent({
  id: crypto.randomUUID(), workspaceId: wid, name: "Own", trigger: [{ kind: "quiet", minutes: 5 }], provider: "claude", model: MODEL,
  tools: ["cbase_agents_list"], ...fields,
});
// Runs of this test are rows without a process: open runs count as open work — the body ends them itself, also after a failure
// (otherwise the harness would wait for quiet forever).
const cleanRuns = () => { for (const l of [...store.outerLoopRunsOpen(), ...store.outerLoopRunsParked()]) store.outerLoopRunEnd(l.id, { state: "aborted" }); };

// ── (1) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(1) seed: at workspace creation and at start, from the template, ineffective without a model, idempotent, id <ws>-a9e0da", async (t) => {
  await withAgentsServer(async (ctx) => {
    const p = store.outerLoopAgendaKeeper(ctx.ws.id);
    assert.ok(p, "POST /api/workspaces seeded the agenda keeper");
    assert.equal(p.id, `${ctx.ws.id}-a9e0da`);
    assert.equal(agendaKeeperId(ctx.ws.id), p.id);
    assert.match(p.id, /^[0-9a-f-]+$/, "the route pattern of the agents matches the id");
    assert.deepEqual(
      { name: p.name, job: p.job, trigger: p.trigger, defaultNew: p.defaultNew, tools: p.tools, builtin: p.builtin, mcp: p.mcp, templateRevision: p.templateRevision },
      { name: P.name, job: P.job, trigger: [{ kind: "quiet", minutes: 3 }], defaultNew: true, tools: [], builtin: [], mcp: {}, templateRevision: P.revision });
    assert.deepEqual([p.agendaKeeper, p.summarizer, p.markUpkeep, p.enabled, p.provider, p.model, p.defaultNewSince, p.origin],
      [true, false, true, true, "", "", null, "workspace"]);
    assert.equal(publicAgent(p).ineffectiveReason, "without-model", "enabled but ineffective without a model");
    assert.match(P.job, /^Keep the agenda of the observed chat in step with the history\./, "the job of the template");
    assert.equal(seedAgendaKeeper(ctx.ws.id).createdAt, p.createdAt, "a second call creates nothing");
    assert.equal(seedMissingAgendaKeeper(), 0, "idempotent");
    // The summarizer comes first, the keeper right behind it, then the timeline agent (timeline-agent.test.js).
    assert.deepEqual(store.outerLoopAgentsOf(ctx.ws.id).map((a) => a.id), [ctx.ws.id, p.id, `${ctx.ws.id}-71e11e`]);

    const r = await post(`${ctx.base}/api/workspaces`, { name: "Second", path: path.join(ctx.root, "second") });
    assert.equal(r.status, 201);
    assert.equal(store.outerLoopAgendaKeeper(r.body.id)?.id, `${r.body.id}-a9e0da`, "the second workspace too");
    assert.equal(store.outerLoopAgentsOf(r.body.id).length, 3, "summarizer, keeper and timeline, no more");

    // If it is missing (a failed seed at creation), the next start catches up — with the same id.
    assert.equal(store.deleteOuterLoopAgent(p.id), true);
    assert.equal(store.outerLoopAgendaKeeper(ctx.ws.id), null);
    await ctx.restart();
    const fresh = store.outerLoopAgendaKeeper(ctx.ws.id);
    assert.equal(fresh?.id, p.id, "the start migration re-seeded it");
    assert.equal(store.outerLoopAgentsOf(r.body.id).length, 3, "the second got no further one");
    t.diagnostic(`keeper ${fresh.id}, revision ${fresh.templateRevision}`);
  });
});

// ── (2) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(2) routes: delete 409, reset against the own template, templateNew, markUpkeep only on the keeper", async () => {
  await withAgentsServer(async ({ base, ws }) => {
    const W = `${base}/api/workspaces/${ws.id}/outer-loop`;
    const pid = agendaKeeperId(ws.id);
    const own = ownAgent(ws.id);

    // DELETE: the keeper cannot be deleted — only switched off.
    const d = await erase(`${W}/${pid}`);
    assert.equal(d.status, 409, JSON.stringify(d.body));
    assert.equal(d.body.agendaKeeper, true);
    assert.match(d.body.error, /Agenda-Pfleger lässt sich nicht löschen/);
    assert.ok(store.outerLoopAgent(pid), "it is still there");
    assert.equal((await erase(`${W}/${ws.id}`)).status, 409, "the summarizer still");

    // PATCH markUpkeep: only on the keeper, only bool; a 400 writes nothing.
    for (const [aid, what] of [[ws.id, "summarizer"], [own.id, "own agent"]]) {
      const r = await patch(`${W}/${aid}`, { markUpkeep: false });
      assert.equal(r.status, 400, `${what}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /nur der Agenda-Pfleger/);
    }
    for (const value of ["no", 0, null]) {
      const r = await patch(`${W}/${pid}`, { markUpkeep: value });
      assert.equal(r.status, 400, `${JSON.stringify(value)}: ${JSON.stringify(r.body)}`);
    }
    assert.equal((await patch(`${W}/${pid}`, { markUpkeep: false, foreign: 1 })).status, 400, "an unknown field stays 400");
    assert.equal(store.outerLoopAgent(pid).markUpkeep, true, "no 400 wrote anything");
    const out = await patch(`${W}/${pid}`, { markUpkeep: false });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.markUpkeep, false);
    assert.equal(store.outerLoopAgent(pid).markUpkeep, false);
    assert.equal(store.outerLoopAgent(ws.id).markUpkeep, true, "the column on the summarizer stayed as it was");

    // Reset: against ITS template — name, job, trigger, selection; provider, model, `enabled` and `markUpkeep` stay.
    const changed = await patch(`${W}/${pid}`, { name: "My keeper", job: "Different.", trigger: [{ kind: "interval", minutes: 30 }], provider: "claude", model: MODEL, enabled: false });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    store.changeOuterLoopAgent(pid, { templateRevision: 0 });
    store.changeOuterLoopAgent(ws.id, { templateRevision: 0 });
    const before = (await request(W)).body.items;
    assert.deepEqual(before.map((a) => [a.id, a.templateNew]), [[ws.id, true], [pid, true], [`${ws.id}-71e11e`, false], [own.id, false]], "new template per built-in agent");
    const z = await post(`${W}/${pid}/reset`, {});
    assert.equal(z.status, 200, JSON.stringify(z.body));
    assert.deepEqual([z.body.name, z.body.job, z.body.trigger, z.body.templateRevision, z.body.templateNew],
      [P.name, P.job, [{ kind: "quiet", minutes: 3 }], P.revision, false]);
    assert.deepEqual([z.body.provider, z.body.model, z.body.enabled, z.body.markUpkeep, z.body.agendaKeeper], ["claude", MODEL, false, false, true],
      "model, enabled and the switch stay");
    const zz = await post(`${W}/${ws.id}/reset`, {});
    assert.equal(zz.status, 200);
    assert.deepEqual([zz.body.name, zz.body.job, zz.body.templateNew], [Z.name, Z.job, false], "the summarizer against its own template");
    const e = await post(`${W}/${own.id}/reset`, {});
    assert.equal(e.status, 400, JSON.stringify(e.body));
    assert.equal(store.outerLoopAgent(own.id).name, "Own");
  });
});

// ── (3) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(3) public form: fixed, markUpkeep only on the keeper, upkeepTally on the agent, upkeep per run — else null", async (t) => {
  await withAgentsServer(async ({ base, ws, chat }) => {
    const W = `${base}/api/workspaces/${ws.id}/outer-loop`;
    const pid = agendaKeeperId(ws.id);
    const own = ownAgent(ws.id);
    const forms = Object.fromEntries((await request(W)).body.items.map((a) => [a.id, a]));
    assert.deepEqual([forms[pid].fixed, forms[pid].agendaKeeper, forms[pid].markUpkeep, forms[pid].upkeepTally],
      [true, true, true, { changes: 0, open: 0, confirmed: 0, corrected: 0 }]);
    assert.deepEqual([forms[ws.id].fixed, forms[ws.id].agendaKeeper, forms[ws.id].markUpkeep, forms[ws.id].upkeepTally], [true, false, false, null]);
    assert.deepEqual([forms[own.id].fixed, forms[own.id].agendaKeeper, forms[own.id].markUpkeep, forms[own.id].upkeepTally],
      [false, false, false, null], "the column carries 1, the form says false");
    const short = publicAgentShort(store.outerLoopAgent(own.id));
    assert.deepEqual([short.fixed, short.markUpkeep], [false, false], "the short form cuts likewise");

    // Two runs of the keeper with a log, one of the own agent.
    const l1 = store.createOuterLoopRun({ id: "lp-1", agentId: pid, chatId: chat.id, trigger: "quiet", startedAt: 1000 });
    const l2 = store.createOuterLoopRun({ id: "lp-2", agentId: pid, chatId: chat.id, trigger: "quiet", startedAt: 2000 });
    const lx = store.createOuterLoopRun({ id: "lx-1", agentId: own.id, chatId: chat.id, trigger: "quiet", startedAt: 1500 });
    for (const l of [l1, l2, lx]) store.outerLoopRunEnd(l.id, { state: "finished" });
    const row = (runId, pointId, kind, after) => ({ chatId: chat.id, workspaceId: ws.id, agentId: pid, runId, pointId, kind, prior: kind === "status" ? "open" : null, after, at: 5000 });
    store.enterAgendaUpkeep([row("lp-1", "s1", "status", "done"), row("lp-1", "s2", "fresh", "Tests"), row("lp-1", "s3", "fresh", "Docs"), row("lp-2", "s4", "status", "in_work")]);
    store.agendaUpkeepOutcome(chat.id, { touched: [{ pointId: "s2", outcome: "corrected" }, { pointId: "s3", outcome: "confirmed" }], at: 6000 });

    const p = (await request(`${W}/${pid}`)).body;
    assert.deepEqual(p.upkeepTally, { changes: 4, open: 2, confirmed: 1, corrected: 1 });
    const runs = (await request(`${W}/${pid}/runs`)).body.items;
    assert.deepEqual(runs.map((l) => [l.id, l.upkeep]), [["lp-2", { changes: 1, corrected: 0 }], ["lp-1", { changes: 3, corrected: 1 }]]);
    const foreign = (await request(`${W}/${own.id}/runs`)).body.items;
    assert.deepEqual(foreign.map((l) => [l.id, l.upkeep]), [["lx-1", null]], "a run of another agent carries null");
    assert.equal(publicRun(store.outerLoopRun("lp-2")).upkeep.changes, 1, "the same form without cache");
    t.diagnostic(`tally ${JSON.stringify(p.upkeepTally)}`);
  });
});

// ── (4) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(4) set and frame: only the keeper has cbase_agenda and cbase_agenda_maintain; the input carries the reverts fenced", async (t) => {
  await withAgentsServer(async ({ base, ws, chat }) => {
    const W = `${base}/api/workspaces/${ws.id}/outer-loop`;
    const c = store.getChat(chat.id);
    const keeper = store.outerLoopAgendaKeeper(ws.id);
    const summarizer = store.outerLoopSummarizer(ws.id);
    const own = ownAgent(ws.id, { tools: ["cbase_agents_list", "cbase_agent_send"] });

    assert.deepEqual([...AGENDA_KEEPER_TOOLS], [READ, ...ONLY_AGENDA_KEEPER]);
    const set = outerLoopSet(keeper, c);
    assert.deepEqual(set.cbase, [ANALYSIS, READ, MAINTAIN], "catalog order: analysis, then the agenda group");
    assert.deepEqual(set.cbase, [...set.cbase].sort((x, y) => CATALOG_NAMES.indexOf(x) - CATALOG_NAMES.indexOf(y)));
    assert.deepEqual(outerLoopSet(keeper, c, { withToken: true }).cbase, [ANALYSIS, READ, MAINTAIN], "no fence cut");
    assert.equal(needsProject(keeper, c), false, "without a selection it runs sandboxed in B");
    for (const [a, what] of [[summarizer, "Zusammenfasser"], [own, "eigener Agent"]]) {
      const s = outerLoopSet(a, c).cbase;
      assert.equal(s.includes(READ) || s.includes(MAINTAIN), false, `${what}: neither of the two (${s.join(", ")})`);
      assert.ok(s.includes(ANALYSIS), `${what}: counter-check — the set is real`);
    }
    assert.deepEqual(outerLoopSet(own, c).cbase, ["cbase_agent_send", "cbase_agents_list", ANALYSIS], "the selection plus analysis, catalog order");
    // None is selectable — not through the route either.
    for (const w of [READ, MAINTAIN]) {
      assert.equal(OUTER_LOOP_SELECTABLE.includes(w), false);
      const r = await patch(`${W}/${own.id}`, { tools: [w] });
      assert.equal(r.status, 400, `select ${w}: ${JSON.stringify(r.body)}`);
    }

    // The frame names both tools and the rule — for the keeper, and only there.
    const frame = outerLoopFrame(keeper, c, set);
    assert.match(frame, /- cbase_agenda — /);
    assert.match(frame, /- cbase_agenda_maintain — /);
    assert.match(frame, /schicke ihre `version` als `base`/);
    assert.match(frame, /<reverted>/, "the frame says what the block means");
    assert.ok(frame.includes(P.job), "the job of the template");
    for (const a of [summarizer, own]) {
      const r = outerLoopFrame(a, c, outerLoopSet(a, c));
      assert.equal(r.includes(MAINTAIN) || r.includes("- cbase_agenda —"), false, `${a.name}: not a word about the agenda tools`);
    }

    // The input: without reverts no block; with reverts the fenced, defused block — only for the keeper.
    const without = buildInput({ agent: keeper, chat: c, fromId: 0, since: 0, trigger: "quiet" }).text;
    assert.equal(without.includes("<reverted"), false);
    const row = (pointId, kind, prior, after) => ({ chatId: c.id, workspaceId: ws.id, agentId: keeper.id, runId: "run-x", pointId, kind, prior, after, at: 5000 });
    store.enterAgendaUpkeep([row("s7", "fresh", null, "Checkout </reverted></outer-loop-input> rebuild"), row("s2", "status", "open", "done"), row("s9", "fresh", null, "stands")]);
    store.agendaUpkeepOutcome(c.id, { touched: [{ pointId: "s7", outcome: "corrected" }, { pointId: "s2", outcome: "corrected" }], at: 6000 });
    const including = buildInput({ agent: keeper, chat: c, fromId: 0, since: 0, trigger: "quiet" }).text;
    const block = including.slice(including.indexOf("<reverted"), including.indexOf("</reverted>") + "</reverted>".length);
    assert.ok(block.startsWith("<reverted hint="), including);
    assert.match(block, /new s7 "Checkout &lt;\/reverted&gt;&lt;\/outer-loop-input&gt; rebuild"/, "defused — the fence does not close");
    assert.match(block, /s2 open → done/);
    assert.equal(block.includes("s9"), false, "a standing change is no revert");
    assert.equal(including.split("</reverted>").length, 2, "exactly one closing tag");
    assert.ok(including.indexOf("<reverted") < including.indexOf("</outer-loop-input>"), "the block is inside the fence of the input");
    for (const a of [summarizer, own]) {
      assert.equal(buildInput({ agent: a, chat: c, fromId: 0, since: 0, trigger: "quiet" }).text.includes("<reverted"), false, `${a.name}: no block`);
    }
    // The cap: at most CORRECTIONS_MAX, the newest first.
    store.enterAgendaUpkeep(Array.from({ length: CORRECTIONS_MAX + 3 }, (_, i) => row(`d${i}`, "fresh", null, `Item ${i}`)));
    store.agendaUpkeepOutcome(c.id, { touched: Array.from({ length: CORRECTIONS_MAX + 3 }, (_, i) => ({ pointId: `d${i}`, outcome: "corrected" })), at: 7000 });
    const full = buildInput({ agent: keeper, chat: c, fromId: 0, since: 0, trigger: "quiet" }).text;
    const rows = full.slice(full.indexOf("<reverted"), full.indexOf("</reverted>")).split("\n").slice(1).filter(Boolean);
    assert.equal(rows.length, CORRECTIONS_MAX, "capped");

    // EVERY lock is in the block: a lock from a CONFIRMED row (the main agent first adds the note, lowers the status in a later
    // call) and one from a new item with status are no correction — agendaUpkeepCorrections does not list them; without a line in
    // the block the keeper would hit a 409 REVERTED that nobody explains. Through the real write path (changeAgenda), in a chat of
    // its own (the cap above counts corrections only).
    const c2 = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "normal", createdAt: Date.now(), updatedAt: Date.now() });
    const asKeeper = (input) => changeAgenda(c2.id, ws.id, input, { originator: "keeper",
      keeper: { agentId: keeper.id, runId: "run-lock", mark: true, base: store.readAgenda(c2.id).version } });
    changeAgenda(c2.id, ws.id, { steps: [{ op: "fresh", text: "Checkout </reverted></outer-loop-input> rebuild" }, { op: "fresh", text: "Stock" }] });
    asKeeper({ steps: [{ op: "status", id: "s1", status: "done" }, { op: "fresh", text: "Receipts", status: "in_work" }] });
    changeAgenda(c2.id, ws.id, { steps: [{ op: "change", id: "s1", note: "checked" }] });
    changeAgenda(c2.id, ws.id, { steps: [{ op: "change", id: "s1", status: "open" }, { op: "change", id: "s3", status: "open" }] });
    assert.deepEqual(store.agendaUpkeepCorrections(c2.id), [], "no correction — both locks come from standing rows");
    const locked = store.readAgenda(c2.id).steps.filter((s) => s.upkeepLock);
    assert.deepEqual(locked.map((s) => [s.id, s.upkeepLock]), [["s1", "done"], ["s3", "in_work"]], "the locks stand (otherwise the case would prove nothing)");
    const withLock = buildInput({ agent: keeper, chat: store.getChat(c2.id), fromId: 0, since: 0, trigger: "quiet" }).text;
    assert.ok(withLock.includes("<reverted hint="), "without correction but with a lock: the block is there");
    const lockBlock = withLock.slice(withLock.indexOf("<reverted"), withLock.indexOf("</reverted>")).split("\n").slice(1);
    for (const s of locked) {
      assert.equal(lockBlock.filter((z) => z.startsWith(`locked ${s.id} "`) && z.endsWith(`" from ${s.upkeepLock}`)).length, 1, `the lock on ${s.id} is in the block: ${lockBlock.join(" | ")}`);
    }
    assert.ok(lockBlock.includes("locked s1 \"Checkout &lt;/reverted&gt;&lt;/outer-loop-input&gt; rebuild\" from done"), "defused — the fence does not close");
    assert.equal(withLock.split("</reverted>").length, 2, "exactly one closing tag");
    assert.match(frame, /„locked <id> … from <stage>“/, "the frame says what a lock line means");
    t.diagnostic(`set ${set.cbase.join(", ")}; block capped at ${rows.length}; locks in the block: ${locked.length}`);
  });
});

// ── (5) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(5) a turn in the observed chat aborts the keeper's open runs on this chat — nothing else", async (t) => {
  await withAgentsServer(async ({ base, ws, chat, waitForTruthy }) => {
    const pid = agendaKeeperId(ws.id);
    assert.ok(store.outerLoopAgent(pid), "the keeper is there (otherwise the body would wait for nothing)");
    const own = ownAgent(ws.id);
    const other = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "normal", createdAt: Date.now(), updatedAt: Date.now() });
    try {
      store.createOuterLoopRun({ id: "p-running", agentId: pid, chatId: chat.id, trigger: "quiet" });
      store.createOuterLoopRun({ id: "p-parked", agentId: pid, chatId: chat.id, trigger: "quiet" });
      assert.ok(store.outerLoopRunState("p-parked", "parked", { parkedUntil: Date.now() + 3_600_000 }));
      store.createOuterLoopRun({ id: "p-other-chat", agentId: pid, chatId: other.id, trigger: "quiet" });
      store.createOuterLoopRun({ id: "e-running", agentId: own.id, chatId: chat.id, trigger: "quiet" });

      const r = await post(`${base}/api/chats/${chat.id}/message`, { text: "Please rebuild the checkout." });
      assert.ok(r.status < 300, JSON.stringify(r.body));
      // Wait for the END of the turn first, then judge: the abort hangs on turnStart, so it comes before — if it is missing the
      // test is red instead of waiting forever (waitForTruthy has no deadline).
      await waitForTruthy(() => store.listMessages(chat.id).some((m) => m.role === "assistant"), "the turn is through");
      assert.equal(store.outerLoopRun("p-running").state, "aborted", "abort at turn start");
      assert.equal(store.outerLoopRun("p-parked").state, "aborted", "the parked one too");
      assert.deepEqual([store.outerLoopRun("p-running").error, store.outerLoopRun("p-parked").error], [INTENDED_END.turn, INTENDED_END.turn],
        "the code `turn` from intended-end.js — no sentence (the clients show it quietly)");
      assert.equal(store.outerLoopRun("p-other-chat").state, "running", "its run on another chat keeps running");
      assert.equal(store.outerLoopRun("e-running").state, "running", "another agent on this chat keeps running");
      t.diagnostic(`states: ${["p-running", "p-parked", "p-other-chat", "e-running"].map((id) => `${id}=${store.outerLoopRun(id).state}`).join(" ")}`);
    } finally {
      cleanRuns();
    }
  });
});

// ── (6) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Fake Claude: a run of the keeper (recognized by the frame) ends without a tool; a turn of the chat with "GATE" in the text
// stands at the gate "chat".
const BODY_QUIET = `
if (joined.includes(${JSON.stringify(FRAME_IDENTIFIER_LINE)})) { finished(); say({ type: "result", result: "broughtAlong", session_id: "ol" }); return; }
if (text.includes("GATE")) await gate("chat");
finished(); say({ type: "result", result: "finished", session_id: "main-session" });
`;

test("(6) start only in a quiet chat: question, turn and background work hold every trigger — quiet restarts, interval consumes nothing, time of day waits, run end does not start", async (t) => {
  await withAgentsServer(async ({ base, ws, chat, waitForTruthy, waitForQuiet, gate }) => {
    const pid = agendaKeeperId(ws.id);
    store.changeOuterLoopAgent(pid, { provider: "claude", model: MODEL });
    store.setOuterLoopActive(pid, chat.id, true, 0);
    const runs = () => store.outerLoopRunsOfAgent(pid, { limit: 100 }).items;
    const finishedRuns = async (n, what) => {
      await waitForTruthy(() => runs().length >= n && runs().every((l) => l.state !== "running" && l.state !== "parked"), what);
      return runs();
    };
    const dynSource = ({ chatId }) => (!chatId || chatId === chat.id ? [{ chatId: chat.id, runId: "dyn-1", taskId: "t-1", name: "Dyn", startedAt: 1 }] : []);
    try {
      // ── quiet and the open question (a card waits for the human, the keeper must not run meanwhile) ─────────
      assert.equal((await post(`${base}/api/chats/${chat.id}/message`, { text: "Please rebuild the checkout." })).status < 300, true);
      await waitForTruthy(() => outerLoopQuietStands(pid, chat.id), "the clock is wound up");
      await waitForQuiet();
      store.addMessage(chat.id, "ask", JSON.stringify({ requestId: "rq-1", questions: [{ question: "Weiter?", options: [{ label: "Ja" }] }] }));
      // Wind the clock up again after the card (as at the end of the turn that set it) — else the new row would stop it.
      await fireHooks("turnEnd", { chat: store.getChat(chat.id) });
      assert.equal(outerLoopQuietStands(pid, chat.id), true);
      outerLoopQuietNow();
      assert.equal(outerLoopQuietStands(pid, chat.id), true, "the card is open => wound up again");
      assert.equal(runs().length, 0, "no run while the question is open");
      const response = await post(`${base}/api/chats/${chat.id}/ask-answer`, { requestId: "rq-1", answers: [{ selected: ["Ja"], text: "" }] });
      assert.equal(response.status, 202, JSON.stringify(response.body));
      await waitForTruthy(() => store.listMessages(chat.id).filter((m) => m.role === "assistant").length >= 2, "the turn after the answer is through");
      await waitForQuiet();
      outerLoopQuietNow();
      let l = await finishedRuns(1, "the run after the answer");
      assert.deepEqual(l.map((x) => [x.trigger, x.state]), [["quiet", "finished"]]);

      // ── interval during a turn: no start, nothing consumed ─────────────────────────────────────────────────────
      store.changeOuterLoopAgent(pid, { trigger: [{ kind: "interval", minutes: 60 }] });
      const later = Date.now() + 61 * 60_000;
      assert.equal((await post(`${base}/api/chats/${chat.id}/message`, { text: "GATE — warte" })).status < 300, true);
      await gate.reached("chat");
      assert.equal(outerLoopTickNow(later), 0, "no interval start in the middle of a turn");
      assert.equal(runs().length, 1);
      gate.open("chat");
      await waitForQuiet();
      assert.equal(outerLoopTickNow(later), 1, "afterwards, in the same tick window — the interval was not consumed");
      l = await finishedRuns(2, "the interval run");
      assert.deepEqual(l.map((x) => [x.trigger, x.state]), [["interval", "finished"], ["quiet", "finished"]]);

      // ── time of day during background work (source of the dynamic workflows): deferred, not consumed ─────────────
      store.changeOuterLoopAgent(pid, { trigger: [{ kind: "clockTime", times: ["03:00"] }] });
      store.addMessage(chat.id, "user", "And the tests?", Date.now());
      // A time of day safely AFTER the last tick of this server run (otherwise it would already have been seen).
      const s1 = nextCronAtZone("0 3 * * *", later + 3_600_000, timeZoneDefault(ws.id));
      setBackgroundSource(dynSource);
      try {
        assert.equal(outerLoopTickNow(s1 + 60_000), 0, "no time-of-day start while background work runs");
        // The safety net: a direct start (follow-up run, wakeup) creates no row.
        const direct = await startOuterLoopRun({ agent: store.outerLoopAgent(pid), chat, trigger: "afterRun" });
        assert.deepEqual([direct.started, direct.reason, direct.quiet], [false, "chat-working", "background"]);
        assert.equal(runs().length, 2, "no row");
        // A parked run whose wakeup arrives now is aborted — without a watermark.
        store.createOuterLoopRun({ id: "p-parked", agentId: pid, chatId: chat.id, trigger: "quiet" });
        assert.ok(store.outerLoopRunState("p-parked", "parked", { parkedUntil: Date.now() }));
        const woken = await startOuterLoopRun({ agent: store.outerLoopAgent(pid), chat, trigger: "quiet", runId: "p-parked" });
        assert.equal(woken.reason, "chat-working");
        assert.equal(store.outerLoopRun("p-parked").state, "aborted");
        assert.equal(store.outerLoopRun("p-parked").error, INTENDED_END.quiet, "the code `quiet` from intended-end.js, no sentence (the clients show it quietly)");
        assert.equal(store.outerLoopRun("p-parked").untilMessageId, 0, "no watermark (it only counts from a finished run anyway)");
      } finally { setBackgroundSource(dynWorkflowsOpen); }
      assert.equal(outerLoopTickNow(s1 + 120_000), 1, "the deferred time of day runs as soon as the chat is quiet");
      l = await finishedRuns(4, "the time-of-day run");
      assert.deepEqual(l.filter((x) => x.id !== "p-parked").map((x) => [x.trigger, x.state]), [["clockTime", "finished"], ["interval", "finished"], ["quiet", "finished"]]);

      // ── "after every run end" at the end of a turn with background work (turnEnd): no run — only at the next quiet end ──
      store.changeOuterLoopAgent(pid, { trigger: [{ kind: "run_end" }] });
      store.addMessage(chat.id, "user", "One more item.", Date.now());
      setBackgroundSource(dynSource);
      try {
        await fireHooks("turnEnd", { chat: store.getChat(chat.id) });
        // The row would be created synchronously in the call (run.js step 3) — without the check it would already be there.
        assert.equal(runs().length, 4, "no run while background work runs");
      } finally { setBackgroundSource(dynWorkflowsOpen); }
      await fireHooks("turnEnd", { chat: store.getChat(chat.id) });
      l = await finishedRuns(5, "the run at the quiet end");
      assert.deepEqual([l[0].trigger, l[0].state], ["run_end", "finished"]);
      t.diagnostic(`runs:
${l.map((x) => `${x.trigger}=${x.state}`).join(" ")}`);
    } finally {
      cleanRuns();
    }
  }, { claude: fakeClaude({ main: BODY_QUIET }) });
});
