// The agenda keeper: core and data layer. Guard that the main LLM and the outer-loop LLM never update the agenda at the same time,
// and that items changed by the outer loop are visibly marked.
//
// What holds here:
//   (1) The route POST /api/chats/:id/agenda/upkeep on the real server: 403 without a matching run (foreign agent, other chat,
//       finished run, broken marker, workflow marker), 400 at the body, 409 CHAT_WORKING per quiet reason (turn, queued, background,
//       question), 409 STALE, 400 per forbidden operation (erase, move, arrange, change, status backward, status on a parent item,
//       foreign field, title/description not empty) - every refusal writes nothing (version stays). Then the effect: marker (on/off),
//       log rows, hint to the main agent, event `harness/agenda`, no hint without effect.
//   (2) The main agent (PUT without markers) and the server (review gate) after the keeper: outcome corrected/confirmed,
//       `upkeepLock` (409 REVERTED), which falls when the main agent itself moves forward; the server sets no outcome. The marker
//       STAYS after main agent and server and carries `afterwards` from the outcome of ITS row (corrected, confirmed, open,
//       outdated - outdated before the outcome); a later change by the keeper replaces it; if only the explanation changes (same
//       status as the keeper), that is a new revision including event, a second time it is not.
//   (3) The delete paths: chat, outer-loop agent, workspace take the log rows along.
//   (4) Data layer: columns and index of the keeper (never with the summarizer, never with project/chat, at most one per workspace),
//       sorting, an old store gets the columns via ALTER; the hint text with cap.
//   (5) The tool on the real MCP server with the run marker: cbase_agenda delivers the `version`, cbase_agenda_maintain writes with
//       it and answers with view + version; a refusal is an error result with code (STALE without number, CHAT_WORKING); markers
//       sent along by the model are dropped.
//   (6) Measured on the TREE: `fresh` under a leaf is NO_SHEET; after the operations no existing item goes backward in the computed
//       status (BACKWARD - also via an open new item under a done parent) or over its lock (REVERTED - also via its sub-items); a
//       leftover lock holds nothing else up.
//   (7) The outcome per ROW (status: measured at the keeper's level; fresh: corrected only if the item is gone); the lock from every
//       STANDING row (open OR confirmed), the lowest undercut level (also two levels in one move); a new item with status locks; the
//       server closes no row, and the main agent is then measured at the keeper's level, not the server's. A row whose level the
//       main agent set ITSELF is outdated and never locks again - keeper open -> in_work, main agent done, later open => no lock,
//       the keeper brings in_work along.
//   (8) What the main agent does not touch stays marked and open (arrange of others, also by the server); move confirms (the marker
//       stays, `afterwards` confirmed); a deleted subtree corrects the new item in it; the description stays open until its change;
//       the fork via the real route drops the markers, keeps the locks, copies no log.
//   (9) NO_AGENDA, ARCHIVED (before the body and in the move), quiet check and move in one synchronous call, background via the
//       source of the dynamic workflows.
//
// The keeper is created via the store unless the seed (outerloop/seed.js, another builder) has already seeded it; its run is a row
// `running` - the test sends the marker in the body like the MCP server (`outerLoop` = `<agentId>:<runId>`).
//
// Counter-tests (each one substitution, each RED):
//   agenda/upkeep.js: keeper flag `agendaKeeper` / run belongs to the agent / run is running / per quiet reason (turn, queued,
//   background, question) / hint deposited => (1). agenda/operations.js: STALE / NOT_ALLOWED (op) / BACKWARD / NO_SHEET / NOT_EMPTY /
//   REVERTED / marker gone at the main agent / set lock / lock falls / switch `markUpkeep` / "only the main agent sets an outcome"
//   (`main` = originator !== "keeper") => (1)+(2); `upkeep` in agendaResponse => agenda.test.js (7)/(8). agenda/change.js: outcome
//   written => (2). Delete paths: chat (chats/erase.js) and agent (store/outer-loop.js) => (3); workspace (store/workspaces.js) is
//   caught by schema-register.test.js "deleteWorkspace ..." (the chat delete path of every chat of the workspace already cleans up
//   here). ALTER of old stores => (4).
//   mcp/tools/agenda.js: reading without version (agendaView instead of readView) / workflowAgent of the model not dropped => (5);
//   agenda/operations.js: STALE with the number => (5) / NO_SHEET for fresh gone => (6) / recheck BACKWARD gone => (6) / recheck
//   REVERTED gone => (6) / REVERTED without "rises" (an old lock would hold everything up) => (6) / fresh row corrected on status
//   change => (7) / status row measured at the previous state instead of the keeper's level => (7) / highest instead of lowest level
//   => (7) / fresh row without level => (7) / marker gone at EVERY item => (8) / move does not touch => (8) / deleted subtree does not
//   count => (8) / description row closes on every write => (8); store/agenda-upkeep.js: only open rows stand => (7); store/agenda.js:
//   fork keeps the markers => (8) / fork takes the lock at the marked item => (8); chatKeepsAgenda always true => (9) / move without
//   archive check => (9); agenda/upkeep.js: maintainAgenda async => (9); outerloop/routes.js: PATCH without markUpkeep => (1).
//   Outdated rows, all red in (7): agenda/operations.js outdated rows count after all / `<` instead of `<=` (the main agent's own
//   level does not outdate) / highest instead of lowest level; store/agenda-upkeep.js `outdated` never written / only open rows
//   stand; agenda/change.js `outdated` not passed to the store.
//   The marker stays: agenda/operations.js: marker gone at the other writer (the old rule) => (2) / upkeepAfterwards without outdated
//   => (2) + agenda.test.js (8) / agendaResponse without afterwards => (2); agenda/change.js: agendaView without rows => (2) / no new
//   revision => (2) / always a new revision => (2); store/agenda.js: newRevision ignored => (2) / fork keeps the markers => (8);
//   store/agenda-upkeep.js: agendaUpkeepHistory without outdated => (2).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { db as rawDb } from "../electron/server/store/db.js";
import { changeAgenda } from "../electron/server/agenda/change.js";
import { UPKEEP_HINT_CAP, maintainAgenda, upkeepHintText, upkeepQuietReason } from "../electron/server/agenda/upkeep.js";
import { pendingRunInputs, running } from "../electron/server/runs/state.js";
import { setGraphSource, setBackgroundSource } from "../electron/server/runs/background.js";
import { graphRunsOpen } from "../electron/server/workflows/graph-start.js";
import { dynWorkflowsOpen } from "../electron/server/dynworkflows/run.js";
import { writeMcpConfig } from "../electron/server/toolchain/mcp-config.js";
import { outerLoopSet } from "../electron/server/outerloop/set.js";
import { json, makeChat, makeWorkspace, openStream, withMcp, withServer } from "./server-harness.mjs";

const KEEPER_SUFFIX = "-a9e0da";

function keeperOf(workspaceId) {
  return store.outerLoopAgendaKeeper(workspaceId)
    ?? store.createOuterLoopAgent({ id: `${workspaceId}${KEEPER_SUFFIX}`, workspaceId, name: "Agenda keeper", agendaKeeper: true });
}
const runOn = (agentId, chatId) => store.createOuterLoopRun({ id: crypto.randomUUID(), agentId, chatId, trigger: "quiet" });
const maintain = (base, chatId, markerValue, body) =>
  json(`${base}/api/chats/${chatId}/agenda/upkeep`, { method: "POST", body: JSON.stringify({ ...body, ...(markerValue === undefined ? {} : { outerLoop: markerValue }) }) });
const main = (base, chatId, body) => json(`${base}/api/chats/${chatId}/agenda`, { method: "PUT", body: JSON.stringify(body) });
const read = async (base, chatId) => (await json(`${base}/api/chats/${chatId}/agenda`)).body.agenda;
const point = (agenda, id) => agenda.steps.find((s) => s.id === id);
const raw = (chatId, id) => store.readAgenda(chatId).steps.find((s) => s.id === id);
const rows = (where, ...args) => rawDb.prepare(`SELECT * FROM agenda_upkeep WHERE ${where} ORDER BY id`).all(...args);
// This test's runs are rows without a process: an open run is "open work" (/api/runs/active `outerLoop`), and the harness would wait
// forever for quiet at the end - so the body ends them itself, also after a failure.
const withServerValue = (fn) => withServer(async (ctx) => {
  try { await fn(ctx); } finally { for (const l of store.outerLoopRunsOpen()) store.outerLoopRunEnd(l.id, { state: "aborted" }); }
});

test("(1)+(2) keeper route: marker, body, quiet, version, operations - then marker, log, hint, event; the main agent takes precedence", async (t) => {
  await withServerValue(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Upkeep", wsPath);
    const c = await makeChat(base, ws.id);
    const c2 = await makeChat(base, ws.id);
    const c3 = await makeChat(base, ws.id);
    const p = keeperOf(ws.id);
    assert.equal(p.agendaKeeper, true);
    assert.equal(p.markUpkeep, true, "default: mark changes ON");
    const other = store.createOuterLoopAgent({ id: crypto.randomUUID(), workspaceId: ws.id, name: "Other" });
    const lp = runOn(p.id, c.id);
    const lx = runOn(other.id, c.id);
    const lpOtherChat = runOn(p.id, c2.id);
    const lpFinished = runOn(p.id, c.id);
    assert.equal(store.outerLoopRunEnd(lpFinished.id, { state: "finished" }), true);
    const mp = `${p.id}:${lp.id}`;

    // The main agent's agenda: s1 open, s2 in work, s3 with child s4; a description, NO title.
    const h0 = await main(base, c.id, {
      description: "## Goal\nTill",
      steps: [{ op: "fresh", text: "A" }, { op: "fresh", text: "B", status: "in_work" }, { op: "fresh", text: "Parent" }, { op: "fresh", text: "Child", under: "s3" }],
    });
    assert.equal(h0.status, 200, JSON.stringify(h0.body));
    assert.equal(h0.body.agenda.version, 1);
    assert.equal(point(h0.body.agenda, "s1").upkeep, null, "without a keeper no marker - `upkeep` is null");
    const version = async () => (await read(base, c.id)).version;

    // ── 403: only the keeper's running run on THIS chat ──────────────────────────────────────────────────────────────
    for (const [what, m, extra] of [
      ["without marker", undefined, {}],
      ["broken marker", p.id, {}],
      ["run of another agent", `${other.id}:${lx.id}`, {}],
      ["foreign run under the keeper's name", `${p.id}:${lx.id}`, {}],
      ["run on another chat", `${p.id}:${lpOtherChat.id}`, {}],
      ["finished run", `${p.id}:${lpFinished.id}`, {}],
      ["workflow marker", mp, { workflowAgent: "wf-1" }],
    ]) {
      const r = await maintain(base, c.id, m, { base: 1, steps: [{ op: "fresh", text: "X" }], ...extra });
      assert.equal(r.status, 403, `${what}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, "NO_RUN", what);
    }
    assert.equal(await version(), 1, "no refusal at the run wrote anything");
    t.diagnostic(`403 NO_RUN in 7 cases, version afterwards ${await version()}`);

    // ── 400 at the body ───────────────────────────────────────────────────────────────────────────────────────────────
    for (const [what, body] of [
      ["without base", { steps: [] }],
      ["negative base", { base: -1, steps: [] }],
      ["base as text", { base: "1", steps: [] }],
      ["foreign field", { base: 1, steps: [], erase: true }],
    ]) {
      const r = await maintain(base, c.id, mp, body);
      assert.equal(r.status, 400, `${what}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, "BODY", what);
    }

    // ── 409 CHAT_WORKING per quiet reason ─────────────────────────────────────────────────────────────────────────────
    const quiet = { base: 1, steps: [{ op: "status", id: "s1", status: "in_work" }] };
    const working = async (reason) => {
      const r = await maintain(base, c.id, mp, quiet);
      assert.equal(r.status, 409, `${reason}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, "CHAT_WORKING");
      assert.equal(r.body.reason, reason);
    };
    running.add(c.id);
    try { await working("turn"); } finally { running.delete(c.id); }
    pendingRunInputs.set(c.id, [{ id: "e-1", prompt: "further", display: "further", cause: "user" }]);
    try { await working("queued"); } finally { pendingRunInputs.delete(c.id); }
    setGraphSource(({ chatId }) => (chatId === c.id || !chatId ? [{ chatId: c.id, startId: "g-1", childChatId: "k", runId: "r", name: "Graph", startedAt: 1 }] : []));
    try { await working("background"); } finally { setGraphSource(graphRunsOpen); }
    // The open question on a chat of its own (the card would otherwise stay open).
    const l3 = runOn(p.id, c3.id);
    store.addMessage(c3.id, "ask", JSON.stringify({ requestId: "rq-1", questions: [{ question: "Continue?", options: [{ label: "Yes" }] }] }));
    const rf = await maintain(base, c3.id, `${p.id}:${l3.id}`, { base: 0, steps: [{ op: "fresh", text: "X" }] });
    assert.equal(rf.status, 409, JSON.stringify(rf.body));
    assert.equal(rf.body.reason, "question");
    assert.equal((await read(base, c3.id)).version, 0, "the question holds the writing up");

    // ── 409 STALE ──────────────────────────────────────────────────────────────────────────────────────────────────
    const old = await maintain(base, c.id, mp, { base: 0, steps: [{ op: "fresh", text: "X" }] });
    assert.equal(old.status, 409, JSON.stringify(old.body));
    assert.equal(old.body.code, "STALE");

    // ── 400 per forbidden operation ───────────────────────────────────────────────────────────────────────────────────
    for (const [what, code, body] of [
      ["erase", "NOT_ALLOWED", { steps: [{ op: "erase", id: "s1" }] }],
      ["move", "NOT_ALLOWED", { steps: [{ op: "move", id: "s1", after: "s2" }] }],
      ["arrange", "NOT_ALLOWED", { steps: [{ op: "arrange", ids: ["s2", "s1", "s3"] }] }],
      ["change (text)", "NOT_ALLOWED", { steps: [{ op: "change", id: "s1", text: "different" }] }],
      ["status with text", "NOT_ALLOWED", { steps: [{ op: "status", id: "s1", status: "done", text: "different" }] }],
      ["status backward", "BACKWARD", { steps: [{ op: "status", id: "s2", status: "open" }] }],
      ["status on parent item", "NO_SHEET", { steps: [{ op: "status", id: "s3", status: "done" }] }],
      ["description already stands", "NOT_EMPTY", { description: "different" }],
      ["unknown id", "INVALID", { steps: [{ op: "status", id: "s9", status: "done" }] }],
      // All or nothing: an allowed operation before a forbidden one writes nothing either.
      ["allowed, then forbidden", "NOT_ALLOWED", { steps: [{ op: "fresh", text: "Y" }, { op: "erase", id: "s1" }] }],
    ]) {
      const r = await maintain(base, c.id, mp, { base: 1, ...body });
      assert.equal(r.status, 400, `${what}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, code, what);
    }
    assert.equal(await version(), 1, "no refusal wrote anything");
    assert.deepEqual(rows("chat_id = ?", c.id), [], "no refusal logged");
    assert.equal(store.openHints(c.id).length, 0, "no refusal deposited a hint");

    // ── The effect ────────────────────────────────────────────────────────────────────────────────────────────────────
    const stream = await openStream(`${base}/api/chats/${c.id}/stream`);
    let gut;
    try {
      gut = await maintain(base, c.id, mp, {
        base: 1, title: "Till",
        steps: [{ op: "status", id: "s1", status: "done" }, { op: "status", id: "s2", status: "done" }, { op: "fresh", text: "New C", status: "in_work" }],
      });
      assert.equal(gut.status, 200, JSON.stringify(gut.body));
      await stream.waitFor((e) => e.type === "harness" && e.subtype === "agenda" && e.agenda?.version === 2, "event harness/agenda with version 2");
    } finally { await stream.close(); }
    assert.equal(gut.body.version, 2);
    assert.deepEqual(gut.body.changed, [
      { pointId: "", kind: "title", prior: "", after: "Till" },
      { pointId: "s1", kind: "status", prior: "open", after: "done" },
      { pointId: "s2", kind: "status", prior: "in_work", after: "done" },
      { pointId: "s5", kind: "fresh", prior: null, after: "New C" },
    ]);
    const a2 = gut.body.agenda;
    const m1 = point(a2, "s1").upkeep;
    assert.deepEqual(Object.keys(m1).sort(), ["afterwards", "agentId", "at", "kind", "prior", "runId"], "the shape of the marker (including `afterwards`)");
    assert.deepEqual({ ...m1, at: 0 }, { agentId: p.id, runId: lp.id, at: 0, kind: "status", prior: "open", afterwards: "open" });
    assert.deepEqual({ ...point(a2, "s5").upkeep, at: 0 }, { agentId: p.id, runId: lp.id, at: 0, kind: "fresh", prior: null, afterwards: "open" });
    assert.equal(point(a2, "s3").upkeep, null, "not touched => no marker");
    assert.ok(a2.steps.every((s) => !Object.hasOwn(s, "upkeepLock")), "`upkeepLock` never goes out");
    // Log: four rows, all open; tally per agent and per run.
    assert.deepEqual(rows("chat_id = ?", c.id).map((z) => [z.point_id, z.kind, z.outcome, z.workspace_id, z.run_id]), [
      ["", "title", "open", ws.id, lp.id], ["s1", "status", "open", ws.id, lp.id], ["s2", "status", "open", ws.id, lp.id], ["s5", "fresh", "open", ws.id, lp.id],
    ]);
    assert.deepEqual(store.agendaUpkeepTally({ agentId: p.id }), { changes: 4, open: 4, confirmed: 0, corrected: 0 });
    const perRun = store.agendaUpkeepTally({ runIds: [lp.id, l3.id] });
    assert.deepEqual([perRun.get(lp.id), perRun.get(l3.id)], [{ changes: 4, corrected: 0 }, { changes: 0, corrected: 0 }]);
    // The hint to the main agent: silent, with source, names every change.
    const hints = store.openHints(c.id);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].source, "agenda-keeper");
    for (const part of ["s1 „A“ open → done", "s2 „B“ in_work → done", "neu s5 „New C“ (in_work)", "Titel „Till“", "cbase_agenda_write"]) {
      assert.ok(hints[0].text.includes(part), `hint names ${part}: ${hints[0].text}`);
    }
    // Without effect: 200 unchanged, no hint, no log, no version.
    const nothing = await maintain(base, c.id, mp, { base: 2, steps: [{ op: "status", id: "s1", status: "done" }] });
    assert.equal(nothing.status, 200, JSON.stringify(nothing.body));
    assert.equal(nothing.body.unchanged, true);
    assert.equal(nothing.body.version, 2);
    assert.equal(store.openHints(c.id).length, 1);
    assert.equal(rows("chat_id = ?", c.id).length, 4);
    // The title stands now => NOT_EMPTY.
    assert.equal((await maintain(base, c.id, mp, { base: 2, title: "Different" })).body.code, "NOT_EMPTY");

    // Marking OFF - via the route, as the editor switches: the existing markers stay, logging still happens, marking does not.
    const toggle = (enabled) => json(`${base}/api/workspaces/${ws.id}/outer-loop/${p.id}`, { method: "PATCH", body: JSON.stringify({ markUpkeep: enabled }) });
    const out = await toggle(false);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.markUpkeep, false);
    assert.deepEqual(["s1", "s2", "s5"].map((id) => raw(c.id, id).upkeep?.kind), ["status", "status", "fresh"],
      "switching off via the route removes no existing marker");
    const without = await maintain(base, c.id, mp, { base: 2, steps: [{ op: "fresh", text: "Without marker" }] });
    assert.equal(without.status, 200, JSON.stringify(without.body));
    assert.equal(point(without.body.agenda, "s6").upkeep, null, "switch off => no marker");
    assert.notEqual(point(without.body.agenda, "s1").upkeep, null, "switching off removes no existing marker");
    assert.equal(rows("chat_id = ?", c.id).length, 5, "the log does not depend on the switch");
    assert.equal((await toggle(true)).status, 200);

    // ── (2) The main agent after the keeper ───────────────────────────────────────────────────────────────────────────
    // s1 back (done -> in_work) => corrected + lock; s2 text => confirmed; s5 deleted (created by the keeper) => corrected; the
    // title changed => corrected. Every marker stays and says what happened afterwards - from the outcome of the row that belongs
    // to it.
    const h1 = await main(base, c.id, {
      title: "Till new",
      steps: [{ op: "change", id: "s1", status: "in_work" }, { op: "change", id: "s2", text: "B2" }, { op: "erase", id: "s5" }],
    });
    assert.equal(h1.status, 200, JSON.stringify(h1.body));
    assert.deepEqual({ ...point(h1.body.agenda, "s1").upkeep, at: 0 }, { agentId: p.id, runId: lp.id, at: 0, kind: "status", prior: "open", afterwards: "corrected" },
      "the main agent does NOT remove the marker - it says \"taken back\"");
    assert.equal(point(h1.body.agenda, "s2").upkeep?.afterwards, "confirmed", "text changed => the marker stays, \"edited\"");
    assert.equal(point(h1.body.agenda, "s5"), undefined, "deleted => nothing to show");
    assert.equal(point(await read(base, c.id), "s1").upkeep?.afterwards, "corrected", "the same explanation when reading (GET)");
    assert.equal(raw(c.id, "s1").upkeepLock, "done", "the taken-back level is locked");
    const outcome = Object.fromEntries(rows("chat_id = ?", c.id).map((z) => [`${z.point_id || z.kind}`, z.outcome]));
    assert.deepEqual(outcome, { title: "corrected", s1: "corrected", s2: "confirmed", s5: "corrected", s6: "open" });
    assert.deepEqual(store.agendaUpkeepTally({ agentId: p.id }), { changes: 5, open: 1, confirmed: 1, corrected: 3 });
    assert.deepEqual(store.agendaUpkeepTally({ runIds: [lp.id] }).get(lp.id), { changes: 5, corrected: 3 });
    const corrections = store.agendaUpkeepCorrections(c.id);
    assert.deepEqual(corrections.map((k) => [k.pointId, k.kind, k.after]).sort(), [["", "title", "Till"], ["s1", "status", "done"], ["s5", "fresh", "New C"]]);

    // The lock: the keeper must not set s1 to done again (409), ...
    const v3 = await version();
    const locked = await maintain(base, c.id, mp, { base: v3, steps: [{ op: "status", id: "s1", status: "done" }] });
    assert.equal(locked.status, 409, JSON.stringify(locked.body));
    assert.equal(locked.body.code, "REVERTED");
    // ... until the main agent itself moves forward - then it falls, and a later step back without an open row does not lock anew.
    assert.equal((await main(base, c.id, { steps: [{ op: "change", id: "s1", status: "done" }] })).status, 200);
    assert.equal(Object.hasOwn(raw(c.id, "s1"), "upkeepLock"), false, "forward by the main agent => the lock falls");
    assert.equal((await main(base, c.id, { steps: [{ op: "change", id: "s1", status: "open" }] })).status, 200);
    assert.equal(Object.hasOwn(raw(c.id, "s1"), "upkeepLock"), false, "without a standing row (the only one is corrected) a step back does not lock");
    const again2 = await maintain(base, c.id, mp, { base: await version(), steps: [{ op: "status", id: "s1", status: "done" }] });
    assert.equal(again2.status, 200, JSON.stringify(again2.body));
    // A later change by the keeper replaces the marker: new run, new time, open again.
    assert.deepEqual([point(again2.body.agenda, "s1").upkeep.kind, point(again2.body.agenda, "s1").upkeep.afterwards], ["status", "open"]);
    assert.equal(point(again2.body.agenda, "s1").upkeep.prior, "open");

    // The server (review gate) leaves the marker standing and sets no outcome - it stays "open".
    const beforeServer = rows("chat_id = ? AND point_id = 's1' AND outcome = 'open'", c.id).length;
    assert.equal(beforeServer, 1);
    const sv = changeAgenda(c.id, ws.id, { steps: [{ op: "change", id: "s1", note: "Review" }] }, { originator: "server" });
    assert.equal(point(sv.agenda, "s1").upkeep?.afterwards, "open", "the server leaves the marker standing");
    assert.equal(rows("chat_id = ? AND point_id = 's1' AND outcome = 'open'", c.id).length, 1, "the server sets no outcome");
    // The main agent with the same status: confirmed and outdated - the agenda stays the same, the marker's explanation does not: a
    // new revision (version + 1, event), otherwise every client would keep "open" (same version => the existing one stays).
    const beforeEqual = await version();
    const stream2 = await openStream(`${base}/api/chats/${c.id}/stream`);
    let equal;
    try {
      equal = await main(base, c.id, { steps: [{ op: "change", id: "s1", status: "done" }] });
      assert.equal(equal.status, 200, JSON.stringify(equal.body));
      // First the answer (fails at once), then the event - it went out BEFORE the answer, so it is already in the stream; this way
      // the test does not wait for an event that never comes.
      assert.equal(equal.body.unchanged, undefined, "the explanation changed => no \"unchanged\" answer");
      assert.equal(equal.body.agenda.version, beforeEqual + 1);
      assert.equal(point(equal.body.agenda, "s1").upkeep?.afterwards, "outdated", "status set itself => \"adopted\" takes precedence over \"edited\"");
      const ev = await stream2.waitFor((e) => e.type === "harness" && e.subtype === "agenda" && e.agenda?.version === beforeEqual + 1,
        "event harness/agenda of the new revision");
      assert.equal(point(ev.agenda, "s1").upkeep?.afterwards, "outdated", "the event carries \"adopted\"");
    } finally { await stream2.close(); }
    assert.equal(rows("chat_id = ? AND point_id = 's1'", c.id).at(-1).outcome, "confirmed", "same status => confirmed");
    // The same status once more: nothing in agenda or explanation => unchanged, no version.
    const again = await main(base, c.id, { steps: [{ op: "change", id: "s1", status: "done" }] });
    assert.equal(again.body.unchanged, true, "without a new explanation \"same state => unchanged\" holds");
  });
});

test("(3) delete paths: chat, outer-loop agent and workspace take the log along", async () => {
  await withServerValue(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Deleting", wsPath);
    const c1 = await makeChat(base, ws.id);
    const c2 = await makeChat(base, ws.id);
    let p = keeperOf(ws.id);
    const write = async (chatId, text) => {
      const l = runOn(p.id, chatId);
      const r = await maintain(base, chatId, `${p.id}:${l.id}`, { base: (await read(base, chatId)).version, steps: [{ op: "fresh", text }] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    };
    await write(c1.id, "one");
    await write(c2.id, "two");
    assert.equal(rows("workspace_id = ?", ws.id).length, 2);
    assert.equal((await json(`${base}/api/chats/${c1.id}`, { method: "DELETE" })).status, 200);
    assert.deepEqual(rows("chat_id = ?", c1.id), [], "the chat takes its rows along");
    assert.equal(rows("chat_id = ?", c2.id).length, 1, "another chat keeps its own");
    assert.equal(store.deleteOuterLoopAgent(p.id), true);
    assert.deepEqual(rows("agent_id = ?", p.id), [], "the agent takes its rows along");
    p = keeperOf(ws.id);
    await write(c2.id, "three");
    assert.equal(rows("workspace_id = ?", ws.id).length, 1);
    assert.equal((await json(`${base}/api/workspaces/${ws.id}`, { method: "DELETE" })).status, 200);
    assert.deepEqual(rows("workspace_id = ?", ws.id), [], "the workspace takes its rows along");
  });
});

test("(4) data layer: keeper flag, at most one per workspace, never with summarizer/project/chat; sorting; old store", async () => {
  await withServerValue(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Data", wsPath);
    const p = keeperOf(ws.id);
    assert.throws(() => store.createOuterLoopAgent({ id: crypto.randomUUID(), workspaceId: ws.id, name: "Second", agendaKeeper: true }), /UNIQUE/);
    assert.throws(() => store.createOuterLoopAgent({ id: crypto.randomUUID(), workspaceId: "ws-x", name: "Z+P", agendaKeeper: true, summarizer: true }), /CHECK/);
    assert.throws(() => store.createOuterLoopAgent({ id: crypto.randomUUID(), workspaceId: "ws-x", projectId: "p", name: "P", agendaKeeper: true }), /CHECK/);
    assert.throws(() => store.createOuterLoopAgent({ id: crypto.randomUUID(), workspaceId: "ws-x", chatId: "c", name: "C", agendaKeeper: true }), /CHECK/);
    assert.equal(store.outerLoopAgendaKeeper(ws.id).id, p.id);
    assert.equal(store.outerLoopAgendaKeeper("ws-unknown"), null);
    // Sorting: summarizer, keeper, workspace, project, chat.
    const z = store.outerLoopSummarizer(ws.id) ?? store.createOuterLoopAgent({ id: crypto.randomUUID(), workspaceId: ws.id, name: "Summarizer", summarizer: true });
    const w = store.createOuterLoopAgent({ id: crypto.randomUUID(), workspaceId: ws.id, name: "AAA Workspace" });
    const ids = store.outerLoopAgentsOf(ws.id).map((a) => a.id);
    assert.ok(ids.indexOf(z.id) < ids.indexOf(p.id) && ids.indexOf(p.id) < ids.indexOf(w.id), `order: ${ids.join(", ")}`);
    // markUpkeep is changeable, the flag is not.
    assert.equal(store.changeOuterLoopAgent(p.id, { markUpkeep: false }).markUpkeep, false);
    assert.throws(() => store.changeOuterLoopAgent(p.id, { agendaKeeper: false }), /not changeable/);
  });
});

// An old store: the table without the two columns and without index, with a summarizer row - a second initStore appends both columns
// (same check as in the CREATE) and creates the index; the existing rows get the defaults. Own test WITHOUT server: initStore
// replaces the process's database.
test("(4) old store: initStore appends agenda_keeper and upkeep_mark, with check and index", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-upkeep-alt-"));
  try {
    store.initStore(dir);
    store.createOuterLoopAgent({ id: "z", workspaceId: "w", name: "Z", summarizer: true });
    rawDb.exec("DROP INDEX outer_loop_agenda_keeper_je_ws");
    rawDb.exec("ALTER TABLE outer_loop_agents DROP COLUMN upkeep_mark");
    rawDb.exec("ALTER TABLE outer_loop_agents DROP COLUMN agenda_keeper");
    const columns = () => rawDb.prepare("PRAGMA table_info(outer_loop_agents)").all().map((c) => c.name);
    assert.ok(!columns().includes("agenda_keeper"), "the old shape stands");
    store.initStore(dir);
    assert.deepEqual(columns().slice(-2), ["agenda_keeper", "upkeep_mark"], "appended, at the end as in the CREATE");
    const z = store.outerLoopAgent("z");
    assert.deepEqual([z.agendaKeeper, z.markUpkeep], [false, true], "the existing rows get the defaults");
    assert.ok(rawDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'outer_loop_agenda_keeper_je_ws'").get(), "the index stands");
    assert.throws(() => store.createOuterLoopAgent({ id: "zp", workspaceId: "w2", name: "ZP", summarizer: true, agendaKeeper: true }), /CHECK/);
    store.createOuterLoopAgent({ id: "p1", workspaceId: "w", name: "P", agendaKeeper: true });
    assert.throws(() => store.createOuterLoopAgent({ id: "p2", workspaceId: "w", name: "P2", agendaKeeper: true }), /UNIQUE/);
    store.initStore(dir); // a third time: nothing twice
    assert.equal(columns().filter((s) => s === "agenda_keeper").length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("(4) hint text: names every change, cuts texts, caps and says so", () => {
  const agenda = { steps: [{ id: "s1", text: "x".repeat(120), status: "done" }, { id: "s2", text: "Fresh", status: "open" }] };
  const t1 = upkeepHintText([{ pointId: "s1", kind: "status", prior: "in_work", after: "done" }, { pointId: "s2", kind: "fresh", prior: null, after: "Fresh" }], agenda);
  assert.ok(t1.includes(`s1 „${"x".repeat(UPKEEP_HINT_CAP.text - 1)}…“ in_work → done`), t1);
  assert.ok(t1.includes("neu s2 „Fresh“ (open)"), t1);
  const many = Array.from({ length: UPKEEP_HINT_CAP.changes + 3 }, (_, i) => ({ pointId: `s${i + 10}`, kind: "fresh", prior: null, after: `P${i}` }));
  const t2 = upkeepHintText(many, { steps: [] });
  assert.ok(t2.includes("… und 3 weitere"), t2);
  assert.ok(!t2.includes(`P${UPKEEP_HINT_CAP.changes}”`) && !t2.includes(`„P${UPKEEP_HINT_CAP.changes}“`), "above the cap not one by one");
});

// ── (5) The tool on the real MCP server (cbase_agenda must output the version - the keeper otherwise has no valid value for `base`) ──
test("(5) tool: cbase_agenda supplies the version, cbase_agenda_maintain writes with it; a refusal is an error with code; markers of the model are dropped", async (t) => {
  await withServerValue(async ({ base, wsPath, root }) => {
    const ws = await makeWorkspace(base, "Tool", wsPath);
    const c = await makeChat(base, ws.id);
    const p = keeperOf(ws.id);
    const l = runOn(p.id, c.id);
    assert.equal((await main(base, c.id, { steps: [{ op: "fresh", text: "A" }, { op: "fresh", text: "B" }] })).status, 200);
    assert.equal((await main(base, c.id, { title: "Till" })).status, 200);
    const v = (await read(base, c.id)).version;
    assert.equal(v, 2, "two writes by the main agent - a guessed 0 would not match");
    // The MCP file as for a keeper run (runs/agents.js agentSpecFactory: depth 1, profile, its set, the run marker).
    const set = outerLoopSet(p, store.getChat(c.id));
    const { servers } = writeMcpConfig(path.join(root, `mcp-${crypto.randomUUID()}.json`), {
      workspaceId: ws.id, chatId: c.id, agentDepth: 1, profileKey: `${c.id}-outerloop-${p.id}-${l.id}`, tools: set.cbase, outerLoop: `${p.id}:${l.id}`,
    });
    await withMcp({ ...servers.cbase.env, CBASE_BASE_URL: base }, async ({ listTools, call }) => {
      const names = await listTools();
      assert.ok(names.includes("cbase_agenda") && names.includes("cbase_agenda_maintain"), names.join(", "));
      assert.equal(names.includes("cbase_agenda_write"), false);
      // Reading: the version stands in the view.
      const read = await call("cbase_agenda");
      assert.equal(read.isError, false, read.text);
      assert.equal(read.data.agenda?.version, v, `cbase_agenda delivers the version: ${read.text}`);
      // Writing with exactly this number. The model sends foreign markers along - they are dropped before the MCP server's markers
      // (a workflow marker of the model would otherwise give 403 NO_RUN).
      const ok = await call("cbase_agenda_maintain", {
        base: read.data.agenda.version, steps: [{ op: "status", id: "s1", status: "in_work" }], workflowAgent: "wf-x", outerLoop: "foreign:run", ofProfile: "main",
      });
      assert.equal(ok.isError, false, ok.text);
      assert.deepEqual([ok.data.ok, ok.data.version, ok.data.changed], [true, v + 1, [{ pointId: "s1", kind: "status", prior: "open", after: "in_work" }]],
        "the answer: compact view plus version");
      assert.ok(ok.data.agenda?.steps?.some((s) => s.id === "s1" && s.status === "in_work"), ok.text);
      assert.equal(raw(c.id, "s1").upkeep?.runId, l.id, "written under the MCP server's run marker, not the model's");
      // A refusal goes to the model as an error result with code - STALE without the current number.
      const old = await call("cbase_agenda_maintain", { base: v, steps: [{ op: "status", id: "s2", status: "in_work" }] });
      assert.equal(old.isError, true, old.text);
      assert.deepEqual([old.data.code, old.data.status], ["STALE", 409]);
      assert.doesNotMatch(old.data.error, /\d/, `STALE names no number: ${old.data.error}`);
      assert.match(old.data.error, /cbase_agenda/, "says how to go on");
      running.add(c.id);
      let taken;
      try { taken = await call("cbase_agenda_maintain", { base: ok.data.version, steps: [{ op: "status", id: "s2", status: "in_work" }] }); }
      finally { running.delete(c.id); }
      assert.equal(taken.isError, true, taken.text);
      assert.deepEqual([taken.data.code, taken.data.reason], ["CHAT_WORKING", "turn"]);
      const further = await call("cbase_agenda_maintain", { base: ok.data.version, steps: [{ op: "status", id: "s2", status: "in_work" }] });
      assert.equal(further.isError, false, further.text);
      t.diagnostic(`read ${v}, written ${ok.data.version}, afterwards ${further.data.version}`);
    });
  });
});

// ── (6) Only bring along, measured on the TREE (`fresh` with `under` at a leaf used to set its status past all checks for `status` -
// backward as well as over a lock) ────────────────────────────────────────────────────────────────────────────────────────────────
test("(6) tree: fresh under a leaf is NO_SHEET; no item goes backward in the computed status or over its lock", async (t) => {
  await withServerValue(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Tree", wsPath);
    const c = await makeChat(base, ws.id);
    const p = keeperOf(ws.id);
    const mp = `${p.id}:${runOn(p.id, c.id).id}`;
    const version = async () => (await read(base, c.id)).version;
    const pf = async (body) => maintain(base, c.id, mp, { base: await version(), ...body });
    // s1 leaf open, s2 leaf done (by the main agent), s3 parent item whose only child s4 is done (completely done).
    assert.equal((await main(base, c.id, { steps: [
      { op: "fresh", text: "A" }, { op: "fresh", text: "B", status: "done" }, { op: "fresh", text: "Parent" }, { op: "fresh", text: "Child", under: "s3", status: "done" },
    ] })).status, 200);
    // s1: the keeper sets done, the main agent takes back => lock done.
    assert.equal((await pf({ steps: [{ op: "status", id: "s1", status: "done" }] })).status, 200);
    assert.equal((await main(base, c.id, { steps: [{ op: "change", id: "s1", status: "in_work" }] })).status, 200);
    assert.equal(raw(c.id, "s1").upkeepLock, "done");
    const v0 = await version();
    // The scenarios: a new item under a LEAF - over the lock or backward - is NO_SHEET.
    for (const [what, op] of [
      ["under the locked leaf s1, done", { op: "fresh", under: "s1", text: "finished", status: "done" }],
      ["under the done leaf s2, open", { op: "fresh", under: "s2", text: "still open" }],
    ]) {
      const r = await pf({ steps: [op] });
      assert.equal(r.status, 400, `${what}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, "NO_SHEET", what);
    }
    // Via `after` (level of s4): an open or begun new item under the completely done s3 would reopen it => BACKWARD.
    for (const st of ["open", "in_work"]) {
      const r = await pf({ steps: [{ op: "fresh", after: "s4", text: "Addendum", status: st }] });
      assert.equal(r.status, 400, `${st}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, "BACKWARD", st);
      assert.match(r.body.error, /öffnet nichts wieder, was erledigt ist/);
    }
    assert.equal(await version(), v0, "no refusal wrote anything");
    // Over the lock via the sub-items: the main agent breaks s1 down (s5 done, s6 open - s1 computed in_work); the lock stays. The
    // last done child would lift s1 to done => REVERTED; in_work leaves s1 where it is.
    assert.equal((await main(base, c.id, { steps: [{ op: "fresh", under: "s1", text: "Part 1", status: "done" }, { op: "fresh", under: "s1", text: "Part 2" }] })).status, 200);
    assert.equal(raw(c.id, "s1").upkeepLock, "done");
    const over = await pf({ steps: [{ op: "status", id: "s6", status: "done" }] });
    assert.equal(over.status, 409, JSON.stringify(over.body));
    assert.equal(over.body.code, "REVERTED");
    assert.equal((await pf({ steps: [{ op: "status", id: "s6", status: "in_work" }] })).status, 200);
    // A leftover lock holds nothing else up: the main agent closes s1 via s6 itself (computed done, the lock still stands) - a new
    // item elsewhere goes through, also one under which the same call puts a child.
    assert.equal((await main(base, c.id, { steps: [{ op: "change", id: "s6", status: "done" }] })).status, 200);
    assert.equal(raw(c.id, "s1").upkeepLock, "done", "the lock at s1 is still there");
    const beside = await pf({ steps: [{ op: "fresh", text: "Beside", status: "done" }, { op: "fresh", under: "s7", text: "below" }] });
    assert.equal(beside.status, 200, JSON.stringify(beside.body));
    // A done new item under the completely done s3 leaves it done.
    const alongside = await pf({ steps: [{ op: "fresh", after: "s4", text: "Addendum", status: "done" }] });
    assert.equal(alongside.status, 200, JSON.stringify(alongside.body));
    assert.equal(point(alongside.body.agenda, "s3").status, "done");
    t.diagnostic(`version ${await version()}`);
  });
});

// ── (7) The outcome per ROW, the lock from every STANDING row ────────────────────────────────────────────────────────────────────
test("(7) outcome per row; the lock comes from open and confirmed rows, the lowest level locks; measured at the keeper's level", async (t) => {
  await withServerValue(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Rows", wsPath);
    const c = await makeChat(base, ws.id);
    const p = keeperOf(ws.id);
    // One run per call (as in operation), then finished.
    const run = async (body) => {
      const l = runOn(p.id, c.id);
      const r = await maintain(base, c.id, `${p.id}:${l.id}`, { base: (await read(base, c.id)).version, ...body });
      store.outerLoopRunEnd(l.id, { state: "finished" });
      return r;
    };
    const mainOk = async (body) => assert.equal((await main(base, c.id, body)).status, 200, JSON.stringify(body));
    const outcome = (pointId, kind) => rows("chat_id = ? AND point_id = ? AND kind = ?", c.id, pointId, kind).map((z) => z.outcome);
    await mainOk({ steps: [{ op: "fresh", text: "A" }, { op: "fresh", text: "B" }, { op: "fresh", text: "C" }] });

    // The scenario: run 1 sets s1 open -> in_work and creates s4; run 2 sets s1 and s4 to done; the main agent takes both back to
    // in_work. Only the second level is taken back - the first and the item stand.
    assert.equal((await run({ steps: [{ op: "status", id: "s1", status: "in_work" }, { op: "fresh", text: "D" }] })).status, 200);
    assert.equal((await run({ steps: [{ op: "status", id: "s1", status: "done" }, { op: "status", id: "s4", status: "done" }] })).status, 200);
    await mainOk({ steps: [{ op: "change", id: "s1", status: "in_work" }, { op: "change", id: "s4", status: "in_work" }] });
    assert.deepEqual(rows("chat_id = ?", c.id).map((z) => [z.point_id, z.kind, z.prior, z.after, z.outcome]), [
      ["s1", "status", "open", "in_work", "confirmed"],
      ["s4", "fresh", null, "D", "confirmed"],
      ["s1", "status", "in_work", "done", "corrected"],
      ["s4", "status", "open", "done", "corrected"],
    ]);
    assert.deepEqual(store.agendaUpkeepTally({ agentId: p.id }), { changes: 4, open: 0, confirmed: 2, corrected: 2 });
    assert.deepEqual(store.agendaUpkeepCorrections(c.id).map((k) => [k.pointId, k.kind]).sort(), [["s1", "status"], ["s4", "status"]],
      "the block <taken_back> names only what is taken back");
    assert.deepEqual([raw(c.id, "s1").upkeepLock, raw(c.id, "s4").upkeepLock], ["done", "done"]);

    // The main agent's own level: it has just set s1 to in_work ITSELF - the row open -> in_work is thereby outdated (its outcome
    // stays confirmed), the level belongs to it. If it now sets s1 to open, only the level it took back from the keeper (done) locks;
    // the keeper may bring in_work along again.
    assert.deepEqual(rows("chat_id = ? AND point_id = 's1' AND kind = 'status'", c.id).map((z) => z.outdated_at !== null), [true, false],
      "only the row whose level the main agent set itself is outdated");
    await mainOk({ steps: [{ op: "change", id: "s1", status: "open" }] });
    assert.equal(raw(c.id, "s1").upkeepLock, "done");
    assert.deepEqual(outcome("s1", "status"), ["confirmed", "corrected"], "closed rows stay as they are");
    assert.equal((await run({ steps: [{ op: "status", id: "s1", status: "in_work" }] })).status, 200, "in_work was the main agent's level");
    const againS1 = await run({ steps: [{ op: "status", id: "s1", status: "done" }] });
    assert.equal(againS1.status, 409, JSON.stringify(againS1.body));
    assert.equal(againS1.body.code, "REVERTED");

    // A new item with status: the keeper creates s5 in_work, the main agent sets it to open => the fresh row is confirmed (the item
    // stands), the level is locked.
    assert.equal((await run({ steps: [{ op: "fresh", text: "E", status: "in_work" }] })).status, 200);
    await mainOk({ steps: [{ op: "change", id: "s5", status: "open" }] });
    assert.deepEqual(outcome("s5", "fresh"), ["confirmed"]);
    assert.equal(raw(c.id, "s5").upkeepLock, "in_work");
    assert.equal((await run({ steps: [{ op: "status", id: "s5", status: "in_work" }] })).body.code, "REVERTED");

    // After a closed row: the keeper sets s2 to done, the main agent adds the note (confirmed) and takes s2 back only in the next
    // call => the lock arises anyway; the row stays confirmed.
    assert.equal((await run({ steps: [{ op: "status", id: "s2", status: "done" }] })).status, 200);
    await mainOk({ steps: [{ op: "change", id: "s2", note: "checked" }] });
    assert.deepEqual(outcome("s2", "status"), ["confirmed"]);
    await mainOk({ steps: [{ op: "change", id: "s2", status: "in_work" }] });
    assert.equal(raw(c.id, "s2").upkeepLock, "done");
    assert.deepEqual(outcome("s2", "status"), ["confirmed"], "the first outcome holds");
    assert.equal((await run({ steps: [{ op: "status", id: "s2", status: "done" }] })).body.code, "REVERTED");

    // The server does not count: the keeper sets s3 to in_work, the review gate (server) to done - it closes no row. The main agent
    // takes it back to in_work: measured at the KEEPER's level (in_work), not the server's => confirmed, no lock.
    assert.equal((await run({ steps: [{ op: "status", id: "s3", status: "in_work" }] })).status, 200);
    changeAgenda(c.id, ws.id, { steps: [{ op: "change", id: "s3", status: "done" }] }, { originator: "server" });
    assert.deepEqual(outcome("s3", "status"), ["open"], "the server closes no row");
    await mainOk({ steps: [{ op: "change", id: "s3", status: "in_work" }] });
    assert.deepEqual(outcome("s3", "status"), ["confirmed"]);
    assert.equal(Object.hasOwn(raw(c.id, "s3"), "upkeepLock"), false, "no lock at the server's level");

    // Two levels back in ONE move: the keeper sets s6 open -> in_work and in_work -> done, the main agent takes s6 straight to open
    // => the lowest undercut level locks (otherwise the keeper would set in_work again, which the main agent has just taken back too).
    await mainOk({ steps: [{ op: "fresh", text: "F" }] });
    assert.equal((await run({ steps: [{ op: "status", id: "s6", status: "in_work" }] })).status, 200);
    assert.equal((await run({ steps: [{ op: "status", id: "s6", status: "done" }] })).status, 200);
    await mainOk({ steps: [{ op: "change", id: "s6", status: "open" }] });
    assert.deepEqual(outcome("s6", "status"), ["corrected", "corrected"]);
    assert.equal(raw(c.id, "s6").upkeepLock, "in_work");
    assert.equal((await run({ steps: [{ op: "status", id: "s6", status: "in_work" }] })).body.code, "REVERTED");

    // Outdated: the keeper sets s7 open -> in_work, the main agent sets s7 to done ITSELF (confirmed, and the level in_work is
    // outdated), later it reopens s7 => NO lock: the old row does not lock anew, the keeper may bring in_work along after the reopening.
    // The counter-case beside it is s2 above: there the main agent confirmed only via the note - the row stayed standing, and lowering locked.
    await mainOk({ steps: [{ op: "fresh", text: "G" }] });
    assert.equal((await run({ steps: [{ op: "status", id: "s7", status: "in_work" }] })).status, 200);
    await mainOk({ steps: [{ op: "change", id: "s7", status: "done" }] });
    assert.deepEqual(outcome("s7", "status"), ["confirmed"]);
    assert.equal(Object.hasOwn(raw(c.id, "s7"), "upkeepLock"), false);
    await mainOk({ steps: [{ op: "change", id: "s7", status: "open" }] });
    assert.equal(Object.hasOwn(raw(c.id, "s7"), "upkeepLock"), false, "the outdated row does not lock anew on reopening");
    assert.deepEqual(outcome("s7", "status"), ["confirmed"], "the first outcome stays");
    const broughtAlong = await run({ steps: [{ op: "status", id: "s7", status: "in_work" }] });
    assert.equal(broughtAlong.status, 200, JSON.stringify(broughtAlong.body));
    assert.equal(point(broughtAlong.body.agenda, "s7").status, "in_work");
    // And the new row counts again: if the main agent takes THIS in_work back, it locks.
    await mainOk({ steps: [{ op: "change", id: "s7", status: "open" }] });
    assert.equal(raw(c.id, "s7").upkeepLock, "in_work");

    // An already CONFIRMED row is also outdated: s8 is confirmed via the note, then the main agent sets it to done itself and reopens
    // it => no lock. Whoever outdated only open rows would lock in_work here - the same finding via a detour.
    await mainOk({ steps: [{ op: "fresh", text: "H" }] });
    assert.equal((await run({ steps: [{ op: "status", id: "s8", status: "in_work" }] })).status, 200);
    await mainOk({ steps: [{ op: "change", id: "s8", note: "checked" }] });
    assert.deepEqual(outcome("s8", "status"), ["confirmed"]);
    await mainOk({ steps: [{ op: "change", id: "s8", status: "done" }] });
    await mainOk({ steps: [{ op: "change", id: "s8", status: "open" }] });
    assert.equal(Object.hasOwn(raw(c.id, "s8"), "upkeepLock"), false, "the confirmed, then outdated row does not lock anew");
    assert.equal((await run({ steps: [{ op: "status", id: "s8", status: "in_work" }] })).status, 200);

    // The server outdates nothing (agenda/README): the keeper sets s9 to in_work, the review gate to done, the main agent takes it
    // all the way back to open => the keeper's level is undercut, it locks. If the server outdated, no lock would arise, and the
    // keeper would set in_work again (ping-pong) - the s3 case above cannot tell the difference.
    await mainOk({ steps: [{ op: "fresh", text: "I" }] });
    assert.equal((await run({ steps: [{ op: "status", id: "s9", status: "in_work" }] })).status, 200);
    changeAgenda(c.id, ws.id, { steps: [{ op: "change", id: "s9", status: "done" }] }, { originator: "server" });
    assert.deepEqual(rows("chat_id = ? AND point_id = 's9'", c.id).map((z) => z.outdated_at), [null], "the server outdates no row");
    await mainOk({ steps: [{ op: "change", id: "s9", status: "open" }] });
    assert.deepEqual(outcome("s9", "status"), ["corrected"]);
    assert.equal(raw(c.id, "s9").upkeepLock, "in_work");
    assert.equal((await run({ steps: [{ op: "status", id: "s9", status: "in_work" }] })).body.code, "REVERTED");
    t.diagnostic(`tally ${JSON.stringify(store.agendaUpkeepTally({ agentId: p.id }))}`);
  });
});

// ── (8) What the main agent does not touch, and the fork ─────────────────────────────────────────────────────────────────────────
test("(8) untouched stays marked and open; move confirms; a deleted subtree corrects; description; the fork", async (t) => {
  await withServerValue(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Untouched", wsPath);
    const c = await makeChat(base, ws.id);
    const p = keeperOf(ws.id);
    const run = async (chatId, body) => {
      const l = runOn(p.id, chatId);
      const r = await maintain(base, chatId, `${p.id}:${l.id}`, { base: (await read(base, chatId)).version, ...body });
      store.outerLoopRunEnd(l.id, { state: "finished" });
      return r;
    };
    const mainOk = async (body) => assert.equal((await main(base, c.id, body)).status, 200, JSON.stringify(body));
    const kind = (id) => raw(c.id, id).upkeep?.kind ?? null;
    const outcome = (pointId, a) => rows("chat_id = ? AND point_id = ? AND kind = ?", c.id, pointId, a).map((z) => z.outcome);
    // s1 undertaking with child s2, s3 and s4 leaves - without title and description.
    await mainOk({ steps: [{ op: "fresh", text: "Undertaking" }, { op: "fresh", text: "Step", under: "s1" }, { op: "fresh", text: "Other" }, { op: "fresh", text: "Third" }] });
    const r1 = await run(c.id, { description: "## Goal\nTill", steps: [{ op: "fresh", under: "s1", text: "Keeper child" }, { op: "status", id: "s3", status: "in_work" }, { op: "status", id: "s4", status: "in_work" }] });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.deepEqual(["s5", "s3", "s4"].map(kind), ["fresh", "status", "status"]);

    // Arrange (main agent as well as server) touches no item: all markers stay, all rows open.
    await mainOk({ steps: [{ op: "arrange", ids: ["s3", "s4", "s1"] }] });
    changeAgenda(c.id, ws.id, { steps: [{ op: "arrange", ids: ["s1", "s3", "s4"] }] }, { originator: "server" });
    assert.deepEqual(["s5", "s3", "s4"].map(kind), ["fresh", "status", "status"], "arranging others removes no marker");
    assert.equal(rows("chat_id = ? AND outcome = 'open'", c.id).length, 4);
    // Moving a marked item confirms it - only it; the marker stays and says so.
    await mainOk({ steps: [{ op: "move", id: "s3", after: "beginning" }] });
    assert.deepEqual([kind("s3"), kind("s4"), kind("s5")], ["status", "status", "fresh"], "move removes no marker");
    const afterwards = async (id) => point(await read(base, c.id), id)?.upkeep?.afterwards ?? null;
    assert.deepEqual([await afterwards("s3"), await afterwards("s4"), await afterwards("s5")], ["confirmed", "open", "open"]);
    assert.deepEqual([outcome("s3", "status"), outcome("s4", "status"), outcome("s5", "fresh")], [["confirmed"], ["open"], ["open"]]);
    // The description stays open as long as the main agent does not change it - even if it sets the title.
    await mainOk({ title: "Till" });
    assert.deepEqual(outcome("", "description"), ["open"]);
    // A subtree that contains an item created by the keeper goes: its fresh row is corrected.
    await mainOk({ steps: [{ op: "erase", id: "s1" }] });
    assert.deepEqual(outcome("s5", "fresh"), ["corrected"]);
    assert.equal(raw(c.id, "s5"), undefined, "deleted => no marker left to show");
    await mainOk({ description: "## Goal\nTill and warehouse" });
    assert.deepEqual(outcome("", "description"), ["corrected"]);

    // The fork: the markers fall (the log does not come along), the lock stays (the take-back still applies) - also at an item that
    // carries both: s6 locked at done, then set to in_work by the keeper (allowed under the lock).
    assert.equal((await run(c.id, { steps: [{ op: "status", id: "s3", status: "done" }] })).status, 200);
    await mainOk({ steps: [{ op: "change", id: "s4", status: "open" }, { op: "fresh", text: "Fourth" }] });
    assert.equal((await run(c.id, { steps: [{ op: "status", id: "s6", status: "done" }] })).status, 200);
    await mainOk({ steps: [{ op: "change", id: "s6", status: "open" }] });
    assert.equal((await run(c.id, { steps: [{ op: "status", id: "s6", status: "in_work" }] })).status, 200);
    assert.deepEqual([kind("s3"), raw(c.id, "s4").upkeepLock, kind("s6"), raw(c.id, "s6").upkeepLock], ["status", "in_work", "status", "done"],
      "before the fork: s3 marked, s4 locked, s6 both");
    const fork = await json(`${base}/api/chats/${c.id}/fork`, { method: "POST", body: "{}" });
    assert.equal(fork.status, 201, JSON.stringify(fork.body));
    const f = fork.body.id;
    assert.equal(store.readAgenda(f).steps.some((s) => Object.hasOwn(s, "upkeep")), false, "no marker in the fork");
    assert.deepEqual([raw(f, "s4").upkeepLock, raw(f, "s6").upkeepLock], ["in_work", "done"], "the lock goes along - also at the marked item");
    assert.ok((await read(base, f)).steps.every((s) => s.upkeep === null));
    assert.deepEqual(rows("chat_id = ?", f), [], "no log in the fork");
    assert.equal(kind("s3"), "status", "the original keeps its marker");
    assert.equal((await run(f, { steps: [{ op: "status", id: "s4", status: "in_work" }] })).body.code, "REVERTED", "the take-back applies in the fork");
    t.diagnostic(`fork ${f}: ${store.readAgenda(f).steps.length} items`);
  });
});

// ── (9) The route at the edge: NO_AGENDA, ARCHIVED, synchronous, background via the source of the dynamic workflows ─────────────
test("(9) route: NO_AGENDA and ARCHIVED; quiet check and move in ONE synchronous call; background also via dynamic workflows", async () => {
  await withServerValue(async ({ base, wsPath }) => {
    const ws = await makeWorkspace(base, "Margin", wsPath);
    const c = await makeChat(base, ws.id);
    const p = keeperOf(ws.id);
    const mp = `${p.id}:${runOn(p.id, c.id).id}`;
    assert.equal((await main(base, c.id, { steps: [{ op: "fresh", text: "A" }] })).status, 200);
    const status = (st) => ({ steps: [{ op: "status", id: "s1", status: st }] });

    // Synchronous: between the quiet check and the move there is no await - the whole path returns as a finished answer, and the
    // agenda is written before anything else can run.
    const r = maintainAgenda(store.getChat(c.id), { base: 1, outerLoop: mp, ...status("in_work") });
    assert.equal(typeof r?.then, "undefined", "maintainAgenda is synchronous");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(store.readAgenda(c.id).version, 2, "written before the call returns");

    // Background via the source of the dynamic workflows (the graph source holds (1)).
    setBackgroundSource(({ chatId }) => (!chatId || chatId === c.id ? [{ chatId: c.id, runId: "dyn-1", taskId: "t-1", name: "Dyn", startedAt: 1 }] : []));
    try {
      assert.equal(upkeepQuietReason(c.id), "background");
      const h = await maintain(base, c.id, mp, { base: 2, ...status("done") });
      assert.equal(h.status, 409, JSON.stringify(h.body));
      assert.deepEqual([h.body.code, h.body.reason], ["CHAT_WORKING", "background"]);
    } finally { setBackgroundSource(dynWorkflowsOpen); }
    assert.equal(upkeepQuietReason(c.id), null);

    // A chat without agenda: 409 NO_AGENDA (before any other check of the move). Every genus without agenda is also read-only
    // (runs/only-readable.js) - via HTTP the block already catches it (409 onlyReadable), the move itself says NO_AGENDA.
    const t0 = Date.now();
    const wb = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "context", title: "Context", createdAt: t0, updatedAt: t0 });
    const mpWb = `${p.id}:${runOn(p.id, wb.id).id}`;
    const k = await maintain(base, wb.id, mpWb, { base: 0, steps: [{ op: "fresh", text: "X" }] });
    assert.equal(k.status, 409, JSON.stringify(k.body));
    assert.equal(k.body.onlyReadable, true, JSON.stringify(k.body));
    const kz = maintainAgenda(store.getChat(wb.id), { base: 0, outerLoop: mpWb, steps: [{ op: "fresh", text: "X" }] });
    assert.deepEqual([kz.status, kz.body.code], [409, "NO_AGENDA"], JSON.stringify(kz.body));

    // Archived: before the body (chats/routes.js) - and in the move, if the chat was archived between reading and writing.
    const prior = store.getChat(c.id);
    const arch = await json(`${base}/api/chats/${c.id}/archive`, { method: "PUT", body: JSON.stringify({ archived: true }) });
    assert.equal(arch.status, 200, JSON.stringify(arch.body));
    const mp2 = `${p.id}:${runOn(p.id, c.id).id}`;
    const a1 = await maintain(base, c.id, mp2, { base: 2, ...status("done") });
    assert.equal(a1.status, 409, JSON.stringify(a1.body));
    assert.equal(a1.body.archived, true);
    const a2 = maintainAgenda(prior, { base: 2, outerLoop: mp2, ...status("done") });
    assert.deepEqual([a2.status, a2.body.code], [409, "ARCHIVED"], JSON.stringify(a2.body));
    assert.equal(store.readAgenda(c.id).version, 2, "nothing written");
  });
});
