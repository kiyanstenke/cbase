// Guards of the timeline per project (build contract V1-V3).
//
//   (1) append-only: UPDATE and DELETE fail at the trigger on each of the four tables; deleting the project clears the timeline (the
//       workspace path too), the chats survive without a project.
//   (2) Human routes: GET (active, empty), PUT without a field / not a boolean => 400, switch off/on; dismiss 400/200/409.
//   (3) Agent path: without marker / foreign agent / foreign project => 403; switch off => 409 OFF; citation missing, foreign chat, failed
//       call, call without result, read tool, kind => 400; non-existent SHA / wrong branch => 400 ANCHOR (real git repo); duplicate
//       citation => 409 DUPLICATE; subagent call as citation (`from`); collect (one level) and dismiss; form E of the list with filters and pages.
//   (4) toolIndex: main chat AND subagent, without read tools, ok/error/unknown, track fromId/untilId; timelineMostRecent.
//
// COUNTER-TEST: the trigger `timeline_events_no_update` removed from store/timeline.js => (1) red ("UPDATE went through"). The seam
// `isTimeline` in (3) stands in for the outer-loop `timeline` flag on the agent - the HTTP path with the default is the 403 of an
// ordinary agent.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as store from "../electron/server/store.js";
import { db as rawDb } from "../electron/server/store/db.js";
import { timelineAgentAction, readTimelineAgent } from "../electron/server/timeline/agent.js";
import { timelineMostRecent, timelineList, searchTimeline, toolIndex } from "../electron/server/timeline/read.js";
import { readCitation } from "../electron/server/timeline/tool-index.js";
import { json, makeWorkspace, makeProject, ok, withServer } from "./server-harness.mjs";

const MODEL = "claude-haiku-4-5-20251001";
const withServerValue = (fn) => withServer(async (ctx) => {
  try { await fn(ctx); } finally { for (const l of store.outerLoopRunsOpen()) store.outerLoopRunEnd(l.id, { state: "aborted" }); }
});
const newChat = (base, workspaceId, projectId) => ok(`${base}/api/chats`, {
  method: "POST", body: JSON.stringify({ workspaceId, projectId, provider: "claude", model: MODEL, permissionMode: "bypassPermissions" }),
});
const toolValue = (chatId, name, { id = crypto.randomUUID(), parent, result = "ok" } = {}) => {
  const row = store.addMessage(chatId, "tool", JSON.stringify({ name, detail: `${name}-detail`, id, input: {}, ...(parent ? { parent } : {}) }));
  if (result !== null) store.addMessage(chatId, "tool_result", JSON.stringify({ id, result: "r", isError: result === "error" }));
  return row;
};
const tool = (chatId, name, id, parent) => store.addMessage(chatId, "tool", JSON.stringify({ name, detail: `${name}-detail`, id, input: {}, ...(parent ? { parent } : {}) }));
// Like the subagent sink in runs/agents.js (underEvent) and do-run.js: the result row carries NO `parent` - only the call.
const resultRow = (chatId, id, error) => store.addMessage(chatId, "tool_result", JSON.stringify({ id, result: "r", isError: error }));
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

async function seed({ base, wsPath, projPath }) {
  fs.mkdirSync(projPath, { recursive: true });
  git(projPath, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(projPath, "a.txt"), "a");
  git(projPath, "add", "-A");
  git(projPath, "commit", "-q", "-m", "one");
  const shaMain = git(projPath, "rev-parse", "HEAD");
  git(projPath, "checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(projPath, "b.txt"), "b");
  git(projPath, "add", "-A");
  git(projPath, "commit", "-q", "-m", "two");
  const shaFeature = git(projPath, "rev-parse", "HEAD");
  git(projPath, "checkout", "-q", "main");
  const ws = await makeWorkspace(base, "W", wsPath);
  const pj = await makeProject(base, ws.id, projPath);
  const proj = store.getProject(pj.id);
  const chat = await newChat(base, ws.id, pj.id);
  const without = await newChat(base, ws.id, null);
  return { ws, proj, chat, without, shaMain, shaFeature };
}

test("(1) append-only: UPDATE/DELETE fail on all four tables; deleting the project and the workspace clears the timeline", async () => {
  await withServerValue(async (ctx) => {
    const { ws, proj, chat } = await seed(ctx);
    const z = toolValue(chat.id, "Bash");
    const one = (id, ref) => store.enterTimeline({ id, projectId: proj.id, workspaceId: ws.id, kind: "code", title: id, at: 1,
      citationKind: "tool", citationRef: ref, chatId: chat.id, tags: ["x"] });
    one("tl_a", String(z));
    one("tl_b", "999");
    store.appendTimelineParts("tl_a", ["tl_b"]);
    store.dismissTimeline({ eventId: "tl_b", from: "user", justification: "wrong" });
    for (const [tab, where] of [["timeline_events", "id = 'tl_a'"], ["timeline_tags", "event_id = 'tl_a'"], ["timeline_parts", "part_id = 'tl_b'"], ["timeline_dismissals", "event_id = 'tl_b'"]]) {
      const column = { timeline_events: "title", timeline_tags: "word", timeline_parts: "collection_id", timeline_dismissals: "justification" }[tab];
      assert.throws(() => rawDb.prepare(`UPDATE ${tab} SET ${column} = 'fresh' WHERE ${where}`).run(), /timeline-only-append/, `UPDATE went through: ${tab}`);
      assert.throws(() => rawDb.prepare(`DELETE FROM ${tab} WHERE ${where}`).run(), /timeline-only-append/, `DELETE went through: ${tab}`);
    }
    assert.equal(store.timelineRow("tl_a").title, "tl_a");
    assert.ok(store.deleteProject(ws.id, proj.id));
    for (const tab of ["timeline_events", "timeline_tags", "timeline_parts", "timeline_dismissals"]) {
      assert.equal(rawDb.prepare(`SELECT count(*) AS n FROM ${tab}`).get().n, 0, `${tab} after deleting the project`);
    }
    assert.equal(store.getChat(chat.id).projectId ?? null, null, "the chat survives without a project");
    // The workspace path: a second project with an event, then the workspace.
    const p2 = await makeProject(ctx.base, ws.id, path.join(ctx.wsPath, "two"), "Two");
    store.enterTimeline({ id: "tl_c", projectId: p2.id, workspaceId: ws.id, kind: "git", title: "c", at: 1, citationKind: "message", citationRef: "1" });
    assert.throws(() => rawDb.prepare("DELETE FROM timeline_events WHERE id = 'tl_c'").run(), /timeline-only-append/);
    store.deleteWorkspace(ws.id);
    assert.equal(rawDb.prepare("SELECT count(*) AS n FROM timeline_events").get().n, 0, "after deleting the workspace");
  });
});

test("(2) Human routes: GET, toggle (400 without a field), dismiss 400/200/409", async () => {
  await withServerValue(async (ctx) => {
    const { ws, proj, chat } = await seed(ctx);
    const url = `${ctx.base}/api/projects/${proj.id}/timeline`;
    let r = await json(url);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { active: true, events: [], further: null, continueId: null });
    for (const body of [{}, { active: "no" }, { active: 0 }, { active: null }]) {
      r = await json(url, { method: "PUT", body: JSON.stringify(body) });
      assert.equal(r.status, 400, `PUT ${JSON.stringify(body)}`);
      assert.equal(r.body.code, "BODY");
    }
    assert.equal(store.timelineActive(proj.id), true, "a missing field is no statement");
    r = await json(url, { method: "PUT", body: JSON.stringify({ active: false }) });
    assert.deepEqual([r.status, r.body.active, store.timelineActive(proj.id)], [200, false, false]);
    assert.equal((await json(url)).body.active, false);
    await json(url, { method: "PUT", body: JSON.stringify({ active: true }) });

    store.enterTimeline({ id: "tl_v", projectId: proj.id, workspaceId: ws.id, kind: "code", title: "v", at: 5, citationKind: "tool", citationRef: String(toolValue(chat.id, "Edit")), chatId: chat.id });
    r = await json(`${url}/tl_v/dismiss`, { method: "POST", body: JSON.stringify({ justification: "  " }) });
    assert.deepEqual([r.status, r.body.code], [400, "JUSTIFICATION"]);
    r = await json(`${url}/tl_nix/dismiss`, { method: "POST", body: JSON.stringify({ justification: "x" }) });
    assert.deepEqual([r.status, r.body.code], [404, "UNKNOWN"]);
    r = await json(`${url}/tl_v/dismiss`, { method: "POST", body: JSON.stringify({ justification: "not true" }) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.event.dismissed && [r.body.event.dismissed.from, r.body.event.dismissed.justification], ["user", "not true"]);
    r = await json(`${url}/tl_v/dismiss`, { method: "POST", body: JSON.stringify({ justification: "again" }) });
    assert.deepEqual([r.status, r.body.code], [409, "ALREADY_DISMISSED"]);
    const list = (await json(url)).body;
    assert.equal(list.events.length, 1);
    assert.equal(list.events[0].citation.tool, "Edit");
    assert.equal(list.events[0].citation.chatTitle, store.getChat(chat.id).title);
  });
});

test("(3) Agent path: marker 403, switch 409, checks 400/409, anchor on a real repo, subagent, collect, dismiss, list", async () => {
  await withServerValue(async (ctx) => {
    const { ws, proj, chat, without, shaMain, shaFeature } = await seed(ctx);
    const agent = store.createOuterLoopAgent({ id: `${ws.id}-tl`, workspaceId: ws.id, name: "Timeline" });
    const run = store.createOuterLoopRun({ id: crypto.randomUUID(), agentId: agent.id, chatId: chat.id, trigger: "quiet" });
    const marker = `${agent.id}:${run.id}`;
    const agentUrl = `${ctx.base}/api/projects/${proj.id}/timeline/agent`;

    // 403 over HTTP: without marker, with the marker of an ordinary agent (the default of the detection), with a workflow marker.
    for (const body of [{ action: "enter" }, { action: "enter", outerLoop: marker }, { action: "enter", outerLoop: marker, workflowAgent: "x" }]) {
      const r = await json(agentUrl, { method: "POST", body: JSON.stringify(body) });
      assert.deepEqual([r.status, r.body.code], [403, "NO_RUN"], JSON.stringify(body));
    }
    assert.equal((await json(`${agentUrl}?outerLoop=${encodeURIComponent(marker)}`)).status, 403);

    const yes = { isTimeline: () => true };
    const tun = (body) => timelineAgentAction(proj, { outerLoop: marker, ...body }, yes);
    // Run on a chat WITHOUT a project or a finished run => 403, also with the detection.
    const runWithout = store.createOuterLoopRun({ id: crypto.randomUUID(), agentId: agent.id, chatId: without.id, trigger: "quiet" });
    assert.equal((await timelineAgentAction(proj, { outerLoop: `${agent.id}:${runWithout.id}`, action: "enter" }, yes)).status, 403);

    const zBash = toolValue(chat.id, "Bash");
    const zError = toolValue(chat.id, "Edit", { result: "error" });
    const zOpen = toolValue(chat.id, "Write", { result: null });
    const zRead = toolValue(chat.id, "mcp__cbase__cbase_agenda");
    const zSub = toolValue(chat.id, "Bash", { parent: "agent:sub1" });
    const zSubError = toolValue(chat.id, "Edit", { parent: "agent:sub1", result: "error" });
    const zText = store.addMessage(chat.id, "assistant", "Teams message sent to Max.");
    const zForeign = toolValue(without.id, "Bash");
    const base = { action: "enter", kind: "code", title: "Feature X in Branch" };
    const missing = async (body, status, code) => {
      const r = await tun({ ...base, ...body });
      assert.deepEqual([r.status, r.body.code], [status, code], `${JSON.stringify(body)} → ${JSON.stringify(r.body)}`);
      return r;
    };
    await missing({}, 400, "CITATION");
    await missing({ kind: "feature", citation: { kind: "tool", row: zBash } }, 400, "KIND");
    await missing({ title: " ", citation: { kind: "tool", row: zBash } }, 400, "BODY");
    await missing({ citation: { kind: "tool", row: zBash }, unknown: 1 }, 400, "BODY");
    await missing({ citation: { kind: "tool", row: 99_999_999 } }, 400, "CITATION");
    await missing({ citation: { kind: "tool", row: zForeign } }, 400, "CITATION");
    await missing({ citation: { kind: "message", row: zBash } }, 400, "CITATION");
    await missing({ citation: { kind: "tool", row: zError } }, 400, "FAILED");
    await missing({ citation: { kind: "tool", row: zOpen } }, 400, "FAILED");
    await missing({ citation: { kind: "tool", row: zSubError } }, 400, "FAILED");
    await missing({ citation: { kind: "tool", row: zRead } }, 400, "ONLY_READING");
    await missing({ citation: { kind: "tool", row: zSub, from: "" } }, 400, "CITATION");
    await missing({ citation: { kind: "tool", row: zBash }, tags: Array.from({ length: 9 }, (_, i) => `w${i}`) }, 400, "BODY");
    await missing({ citation: { kind: "tool", row: zBash }, anchor: { sha: "0123456789abcdef0123456789abcdef01234567" } }, 400, "ANCHOR");
    await missing({ citation: { kind: "tool", row: zBash }, anchor: { sha: shaFeature, branch: "main" } }, 400, "ANCHOR");
    await missing({ citation: { kind: "tool", row: zBash }, anchor: { sha: "--help" } }, 400, "ANCHOR");

    // Switch off => 409 OFF, nothing written.
    store.setTimelineActive(proj.id, false);
    await missing({ citation: { kind: "tool", row: zBash } }, 409, "OFF");
    store.setTimelineActive(proj.id, true);
    assert.equal(rawDb.prepare("SELECT count(*) AS n FROM timeline_events").get().n, 0, "no check wrote anything");

    let r = await tun({ ...base, text: "on feature", citation: { kind: "tool", row: zBash }, anchor: { sha: shaMain.slice(0, 10), branch: "main" }, tags: ["Login", "login", "auth"], agendaItemId: "p3" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const a = r.body.event;
    assert.deepEqual([a.kind, a.citation.kind, a.citation.tool, a.citation.from, a.citation.chatId, a.anchor.branch, a.agendaItemId, a.tags],
      ["code", "tool", "Bash", "", chat.id, "main", "p3", ["auth", "login"]]);
    assert.equal(store.timelineRow(a.id).runId, run.id);
    r = await missing({ citation: { kind: "tool", row: zBash } }, 409, "DUPLICATE");
    assert.equal(r.body.eventId, a.id);

    r = await tun({ ...base, kind: "test", title: "Subagent ran the tests", citation: { kind: "tool", row: zSub, from: "subagent:sub1" }, anchor: { sha: shaFeature, branch: "feature" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const b = r.body.event;
    assert.equal(b.citation.from, "subagent:sub1");
    r = await tun({ ...base, kind: "communication", title: "Teams to Max", citation: { kind: "message", row: zText }, anchor: { mrIid: 12 } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c = r.body.event;
    assert.deepEqual([c.citation.kind, c.citation.tool, c.anchor.mrIid], ["message", null, 12]);

    // Collect: a collects b and c; one level.
    r = await tun({ action: "collect", collectionId: a.id, parts: [b.id, c.id, b.id] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.event.parts.map((x) => x.id), [b.id, c.id]);
    const zD = toolValue(chat.id, "Bash");
    const d = (await tun({ ...base, title: "d", citation: { kind: "tool", row: zD } })).body.event;
    assert.deepEqual([(await tun({ action: "collect", collectionId: d.id, parts: [b.id] })).body.code], ["ALREADY_COLLECTED"]);
    assert.deepEqual([(await tun({ action: "collect", collectionId: d.id, parts: [a.id] })).body.code], ["LEVEL"]);
    assert.deepEqual([(await tun({ action: "collect", collectionId: b.id, parts: [d.id] })).body.code], ["LEVEL"]);
    assert.deepEqual([(await tun({ action: "collect", collectionId: d.id, parts: ["tl_nix"] })).status], [404]);

    // Dismiss by the agent.
    assert.equal((await tun({ action: "dismiss", eventId: d.id, justification: "" })).body.code, "JUSTIFICATION");
    r = await tun({ action: "dismiss", eventId: d.id, justification: "duplicate of a" });
    assert.deepEqual([r.status, r.body.event.dismissed.from], [200, "agent"]);
    assert.equal((await tun({ action: "dismiss", eventId: d.id, justification: "again" })).body.code, "ALREADY_DISMISSED");

    // The list: only the topmost (a with parts, d), newest first; filters also hit through parts; pages.
    const url = `${ctx.base}/api/projects/${proj.id}/timeline`;
    let l = (await json(url)).body;
    assert.deepEqual(l.events.map((e) => e.id).sort(), [a.id, d.id].sort());
    assert.deepEqual(l.events.find((e) => e.id === a.id).parts.map((x) => x.id), [b.id, c.id]);
    assert.deepEqual((await json(`${url}?kind=communication`)).body.events.map((e) => e.id), [a.id], "kind hits through part c");
    assert.deepEqual((await json(`${url}?word=auth`)).body.events.map((e) => e.id), [a.id]);
    assert.deepEqual((await json(`${url}?chat=${without.id}`)).body.events, []);
    l = (await json(`${url}?limit=1`)).body;
    assert.equal(l.events.length, 1);
    assert.ok(Number.isFinite(l.further));

    // The agent's read tool (V3 over HTTP): search over all (also parts), event with collectionId.
    const q = (o) => new URLSearchParams({ outerLoop: marker, ...o });
    const s = readTimelineAgent(proj, q({ action: "search", anchor: shaFeature.slice(0, 8) }), yes);
    assert.deepEqual([s.status, s.body.events.map((e) => e.id), s.body.events[0].collectionId], [200, [b.id], a.id]);
    assert.equal(readTimelineAgent(proj, q({ action: "event", id: a.id }), yes).body.event.parts.length, 2);
    assert.equal(readTimelineAgent(proj, q({ action: "event", id: "tl_nix" }), yes).status, 404);
  });
});

test("(4) toolIndex: main chat and subagent, without read tools, ok/error/unknown, track; timelineMostRecent", async () => {
  await withServerValue(async (ctx) => {
    const { ws, proj, chat } = await seed(ctx);
    const prior = store.addMessage(chat.id, "assistant", "go");
    const z1 = toolValue(chat.id, "Bash");
    toolValue(chat.id, "Read");
    toolValue(chat.id, "mcp__cbase__cbase_chat_analysis");
    const z2 = toolValue(chat.id, "Edit", { result: "error" });
    const z3 = toolValue(chat.id, "Bash", { parent: "agent:s9" });
    // A subagent with a real call block: the stored state knows its parentToolUseId.
    store.rememberSubagent(chat.id, { agentId: "s7", state: "running", parentToolUseId: "blk-7" });
    const z4 = toolValue(chat.id, "Write", { parent: "blk-7", result: null });
    const z5 = toolValue(chat.id, "Bash");
    const idx = toolIndex(chat.id, { fromId: prior });
    assert.deepEqual(idx.map((x) => [x.row, x.from, x.name, x.ok]), [
      [z1, "", "Bash", true], [z2, "", "Edit", false], [z3, "subagent:s9", "Bash", true], [z4, "subagent:s7", "Write", null], [z5, "", "Bash", true],
    ]);
    assert.equal(idx[0].detail, "Bash-detail");
    assert.deepEqual(toolIndex(chat.id, { fromId: z1, untilId: z3 }).map((x) => x.row), [z2, z3]);
    assert.equal(timelineMostRecent(proj.id), "", "empty without an event");
    store.enterTimeline({ id: "tl_j", projectId: proj.id, workspaceId: ws.id, kind: "git", title: "Push to main", at: Date.now(), citationKind: "message", citationRef: "7", branch: "main", tags: ["release"] });
    const text = timelineMostRecent(proj.id);
    assert.match(text, /^tl_j .*\[git\] Push to main · reported row 7 · main · #release$/);
    assert.equal(timelineMostRecent(proj.id, { days: 1, now: Date.now() + 3 * 86_400_000 }), "", "older than `days` drops out");
  });
});

// ── Findings of the cross-read ─────────────────────────────────────────────────────────────────────────────────────

test("(5) GUARD pairing over (id, parent) - Codex item_5 in the main chat ok, item_5 in the subagent ERROR => the subagent call is not acceptable", async () => {
  await withServerValue(async (ctx) => {
    const { proj, chat } = await seed(ctx);
    const agent = store.createOuterLoopAgent({ id: `${proj.workspaceId}-tl6`, workspaceId: proj.workspaceId, name: "Timeline" });
    const run = store.createOuterLoopRun({ id: crypto.randomUUID(), agentId: agent.id, chatId: chat.id, trigger: "quiet" });
    const tun = (row) => timelineAgentAction(proj, { outerLoop: `${agent.id}:${run.id}`, action: "enter", kind: "code", title: `X ${row}`, citation: { kind: "tool", row, from: "subagent:x1" } }, { isTimeline: () => true });
    const prior = store.addMessage(chat.id, "assistant", "go");
    // Codex counts item ids anew per process: main chat (B) and subagent (X) both carry item_5.
    // a) Interleaved: both open, then two results without parent - cannot be decided which belongs to whom => both open.
    const b = tool(chat.id, "Bash", "item_5");
    const x = tool(chat.id, "Edit", "item_5", "agent:x1");
    resultRow(chat.id, "item_5", false);
    resultRow(chat.id, "item_5", true);
    assert.deepEqual(toolIndex(chat.id, { fromId: prior }).map((a) => [a.row, a.from, a.ok]), [[b, "", null], [x, "subagent:x1", null]]);
    assert.equal(readCitation(x).ok, null, "X does not get the result of B");
    let r = await tun(x);
    assert.deepEqual([r.status, r.body.code], [400, "FAILED"], JSON.stringify(r.body));
    // b) One after another: B with its result, then X with ERROR - unambiguous => B ok, X ERROR (also when checking ONE citation).
    const middle = store.addMessage(chat.id, "assistant", "further");
    const b2 = tool(chat.id, "Bash", "item_7");
    resultRow(chat.id, "item_7", false);
    const x2 = tool(chat.id, "Edit", "item_7", "agent:x1");
    resultRow(chat.id, "item_7", true);
    assert.deepEqual(toolIndex(chat.id, { fromId: middle }).map((a) => [a.row, a.ok]), [[b2, true], [x2, false]]);
    assert.deepEqual([readCitation(b2).ok, readCitation(x2).ok], [true, false]);
    r = await tun(x2);
    assert.deepEqual([r.status, r.body.code], [400, "FAILED"], JSON.stringify(r.body));
  });
});

test("(6) GUARD finding: if the run ends during the git check of the anchor, the agent writes nothing (403)", async () => {
  await withServerValue(async (ctx) => {
    const { proj, chat, shaMain } = await seed(ctx);
    const agent = store.createOuterLoopAgent({ id: `${proj.workspaceId}-tl7`, workspaceId: proj.workspaceId, name: "Timeline" });
    const run = store.createOuterLoopRun({ id: crypto.randomUUID(), agentId: agent.id, chatId: chat.id, trigger: "quiet" });
    const z = toolValue(chat.id, "Bash");
    const body = { outerLoop: `${agent.id}:${run.id}`, action: "enter", kind: "code", title: "T", citation: { kind: "tool", row: z }, anchor: { sha: shaMain } };
    const checkCommit = async () => { store.outerLoopRunEnd(run.id, { state: "aborted" }); return { found: true, onBranch: true }; };
    const r = await timelineAgentAction(proj, body, { isTimeline: () => true, checkCommit });
    assert.deepEqual([r.status, r.body.code], [403, "NO_RUN"], JSON.stringify(r.body));
    assert.equal(rawDb.prepare("SELECT count(*) AS n FROM timeline_events").get().n, 0, "nothing written");
  });
});

test("(7) GUARD paging with the cursor (until, untilId) - three events with the same at, page size 2 => all three; until alone loses one", async () => {
  await withServerValue(async (ctx) => {
    const { ws, proj } = await seed(ctx);
    for (const n of ["a", "b", "c"]) {
      store.enterTimeline({ id: `tl_equal_${n}`, projectId: proj.id, workspaceId: ws.id, kind: "git", title: n, at: 5_000, citationKind: "message", citationRef: `1${n.charCodeAt(0)}`, createdAt: 7_000 });
    }
    const paginate = (read) => {
      const ids = [];
      let cursor = {};
      for (let i = 0; i < 5; i++) {
        const s = read(cursor);
        ids.push(...s.events.map((e) => e.id));
        if (s.further === null) break;
        cursor = { until: s.further, untilId: s.continueId };
      }
      return ids;
    };
    const all = ["tl_equal_a", "tl_equal_b", "tl_equal_c"];
    assert.deepEqual(paginate((c) => timelineList(proj, { ...c, limit: 2 })).sort(), all, "list: all three, none twice");
    assert.deepEqual(paginate((c) => searchTimeline(proj.id, { ...c, limit: 2 })).sort(), all, "the agent's search: all three");
    // The same cursor over HTTP.
    const url = `${ctx.base}/api/projects/${proj.id}/timeline`;
    const s1 = (await json(`${url}?limit=2`)).body;
    const s2 = (await json(`${url}?limit=2&until=${s1.further}&untilId=${encodeURIComponent(s1.continueId)}`)).body;
    assert.deepEqual([...s1.events, ...s2.events].map((e) => e.id).sort(), all);
    // Counter-test (backward compatible, the old way): `until` alone pages at < until - the third event with the same at drops out.
    assert.equal(paginate((c) => timelineList(proj, { until: c.until, limit: 2 })).length, 2, "counter-test: until alone loses one");
  });
});

// ── Refinement: NO_PROOF ───────────────────────────────────────────────────────────────────────────────────────────

test("(8) GUARD NO_PROOF: cbase bookkeeping, question, cbase rows and user commands are no citation - index and check from ONE list; counter-tests: Bash, Write, agent_send, path, assistant, subagent pass", async () => {
  await withServerValue(async (ctx) => {
    const { ws, proj, chat } = await seed(ctx);
    const agent = store.createOuterLoopAgent({ id: `${ws.id}-tl8`, workspaceId: ws.id, name: "Timeline" });
    const run = store.createOuterLoopRun({ id: crypto.randomUUID(), agentId: agent.id, chatId: chat.id, trigger: "quiet" });
    let n = 0;
    const tun = (citation) => timelineAgentAction(proj, { outerLoop: `${agent.id}:${run.id}`, action: "enter", kind: "code", title: `E${++n}`, citation }, { isTimeline: () => true });
    const prior = store.addMessage(chat.id, "assistant", "go");

    // Bookkeeping tools - with and without MCP prefix, also from a subagent.
    const internalRows = [
      toolValue(chat.id, "mcp__cbase__cbase_agenda_write"), toolValue(chat.id, "cbase_agenda_maintain"), toolValue(chat.id, "TodoWrite"),
      toolValue(chat.id, "TaskUpdate"), toolValue(chat.id, "mcp__cbase__cbase_ask"), toolValue(chat.id, "mcp__cbase__cbase_agent"),
      toolValue(chat.id, "mcp__cbase__cbase_dynamic_workflow"), toolValue(chat.id, "ExitPlanMode"),
    ];
    const internalSub = toolValue(chat.id, "TodoWrite", { parent: "agent:s8" });
    // Counter-tests: what can change something in the world stays proof.
    const zBash = toolValue(chat.id, "Bash");
    const zWrite = toolValue(chat.id, "Write");
    const zSend = toolValue(chat.id, "mcp__cbase__cbase_agent_send");
    const zSubBash = toolValue(chat.id, "Bash", { parent: "agent:s8" });

    // The index shows only what the check would accept (the same calculation).
    const idx = toolIndex(chat.id, { fromId: prior }).map((a) => a.row);
    assert.deepEqual(idx, [zBash, zWrite, zSend, zSubBash], "bookkeeping drops out of the index, what can prove stays");
    for (const z of [...internalRows, internalSub]) {
      assert.equal(readCitation(z).ok, true, "counter-test: the call SUCCEEDED - it is rejected because of the tool, not because of the result");
      const r = await tun({ kind: "tool", row: z, ...(z === internalSub ? { from: "subagent:s8" } : {}) });
      assert.deepEqual([r.status, r.body.code], [400, "NO_PROOF"], `${z} → ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /Nimm den Aufruf, der das Ergebnis herbeigeführt hat/, "the refusal says what qualifies instead");
    }
    // Reading stays ONLY_READING (the older, more precise refusal).
    assert.equal((await tun({ kind: "tool", row: toolValue(chat.id, "mcp__cbase__cbase_lsp") })).body.code, "ONLY_READING");
    for (const [z, from] of [[zBash, undefined], [zWrite, undefined], [zSend, undefined], [zSubBash, "subagent:s8"]]) {
      const r = await tun({ kind: "tool", row: z, ...(from ? { from } : {}) });
      assert.equal(r.status, 201, `counter-test ${z}: ${JSON.stringify(r.body)}`);
    }

    // Messages: only user, main agent, subagent - and no user command.
    const rows = {
      ask: store.addMessage(chat.id, "ask", JSON.stringify({ question: "Shall I merge?" })),
      ask_answer: store.addMessage(chat.id, "ask_answer", JSON.stringify({ response: "Yes, variant B" })),
      channel: store.addMessage(chat.id, "channel", JSON.stringify({ text: "MR !45 merged" })),
      workflow: store.addMessage(chat.id, "workflow", JSON.stringify({ status: "finished" })),
      goal: store.addMessage(chat.id, "goal", JSON.stringify({ target: "x" })),
      meta: store.addMessage(chat.id, "meta", "Model switched"),
      hint: store.addMessage(chat.id, "hint", "Compacted"),
    };
    for (const [role, z] of Object.entries(rows)) {
      assert.equal(readCitation(z).kind, "message", `counter-test ${role}: the read function calls the row a message - it is rejected by the role`);
      const r = await tun({ kind: "message", row: z });
      assert.deepEqual([r.status, r.body.code], [400, "NO_PROOF"], `${role} → ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, new RegExp(`\\(${role}\\)`), "the refusal names the role");
    }
    for (const command of ["/status", "  /workflow:deploy now", "/compact"]) {
      const r = await tun({ kind: "message", row: store.addMessage(chat.id, "user", command) });
      assert.deepEqual([r.status, r.body.code], [400, "NO_PROOF"], `${command} → ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /Befehl des Nutzers/);
    }
    const gut = [
      store.addMessage(chat.id, "user", "/tmp/build deleted and rebuilt"),
      store.addMessage(chat.id, "user", "I merged MR !45 in GitLab."),
      store.addMessage(chat.id, "assistant", "MR !45 merged: export invoices as CSV."),
      store.addMessage(chat.id, "sub_text", JSON.stringify({ text: "Tests green.", parent: "agent:s8" })),
    ];
    for (const z of gut) {
      const r = await tun({ kind: "message", row: z });
      assert.equal(r.status, 201, `counter-test ${z}: ${JSON.stringify(r.body)}`);
    }
  });
});
