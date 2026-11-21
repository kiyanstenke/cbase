// The timeline agent: the OUTER-LOOP part. Storage, validation and the write route belong to the domain side `timeline/` with its own
// tests; here, through the real server:
//   (1) Seed and form: POST /api/workspaces seeds it, the start seeds one for every workspace without it (also an existing one) - id
//       `<ws>-71e11e`, from TIMELINE_TEMPLATE, `enabled` without a model (ineffective), `timeline` and `gapless` only on it, `fixed`;
//       DELETE 409, "reset to template" against ITS template
//   (2) GUARD visibility: cbase_timeline and cbase_timeline_write ONLY in the set of the timeline agent (fixed, not selectable), the
//       frame names them only for it; in the MCP server without an outer-loop marker blocked for every run - Coding catalog, explicit
//       list, subagent, workflow agent; the full set of a subagent does not carry them
//   (3) GUARD gapless: a track over the cap - read one after another every row is in EXACTLY one input, and the watermark never stands
//       behind an unseen row; counter-test in the same test: today's way (summarizer) jumps => the same check is false there. Through
//       the real run: ONE trigger reads the whole track in follow-up runs
//   (4) GUARD unchanged: summarizer and agenda keeper read as before - the newest rows, watermark over everything, no `row`, no timeline
//       blocks, no `rest`; the row form byte-exact
//   (5) GUARD: a chat without a project does not wake the timeline agent (not available, no run, no quiet clock) - also with a row
//       "enabled"; counter-test: the same agent on the chat of a project gets the quiet clock
//   (6) Switch "Abort on new message": off => the run continues, a run end queues; on => abort on THIS chat (code INTENDED_END.turn)
//   (7) The tool index: oldest first, own cap of 12,000 with a notice, defused, subagent marked, ERROR; the fence tags of the two
//       blocks fall out of a note
//   (8) Seam between the domain side and the outer-loop part: project switch off (PUT /api/projects/:id/timeline) => not available; the
//       write route accepts the run marker of the timeline agent (201) and not the keeper's (403) - store/outer-loop.js sets `timeline`,
//       timeline/agent.js checks it; reading through GET …/timeline/agent; the input carries the entry in <timeline-most-recent>
//       (timeline/read.js timelineMostRecent)
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_MAIN_AGENT_WAIT_MS=3600000 CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/timeline-agent.test.js

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as store from "../electron/server/store.js";
import { CATALOG_NAMES } from "../electron/mcp/catalog.js";
import { ONLY_WITH_OUTER_LOOP_MARKER, ONLY_TIMELINE_AGENT } from "../electron/mcp/visibility.js";
import { seedMissingTimelineAgents, seedTimelineAgent, timelineAgentId } from "../electron/server/outerloop/seed.js";
import { TIMELINE_RULE_BUNDLE, TIMELINE_RULE_CITATION, TIMELINE_TEMPLATE as TL } from "../electron/server/outerloop/template.js";
import { publicAgent } from "../electron/server/outerloop/publiclyVisible.js";
import { TIMELINE_TOOLS, outerLoopSet } from "../electron/server/outerloop/set.js";
import { FRAME_IDENTIFIER_LINE, buildInput, withoutFenceLeftovers, outerLoopFrame } from "../electron/server/outerloop/input.js";
import { activation, sinceFor } from "../electron/server/outerloop/activation.js";
import { TOOL_INDEX_MAX, toolIndexBlock } from "../electron/server/outerloop/timeline.js";
import { outerLoopCoreCount, outerLoopAfterRunMarker, startOuterLoopRun } from "../electron/server/outerloop/run.js";
import { outerLoopQuietStands } from "../electron/server/outerloop/trigger.js";
import { OUTER_LOOP_SELECTABLE } from "../electron/server/outerloop/catalog.js";
import { INTENDED_END } from "../electron/server/outerloop/intended-end.js";
import { agentToolset } from "../electron/server/runs/agent-set.js";
import { wallTimeText } from "../electron/server/cron.js";
import { getUiLang, setUiLang } from "../electron/server/i18n.js";
import { timeZoneDefault } from "../electron/server/workspaces/timeZone.js";
import { fakeClaude, withAgentsServer } from "./agent-harness.mjs";

const READ = "cbase_timeline";
const WRITE = "cbase_timeline_write";
const ANALYSIS = "cbase_chat_analysis";
const MODEL = "claude-haiku-4-5-20251001";
const MCP_SCRIPT = fileURLToPath(new URL("../electron/mcp/cbase-mcp.js", import.meta.url));

async function request(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close" } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const post = (url, b) => request(url, { method: "POST", body: JSON.stringify(b) });
const put = (url, b) => request(url, { method: "PUT", body: JSON.stringify(b) });
const patch = (url, b) => request(url, { method: "PATCH", body: JSON.stringify(b) });
const erase = (url) => request(url, { method: "DELETE" });

async function newProject(ctx, name) {
  const filePath = path.join(ctx.root, `project-${name}-${crypto.randomUUID().slice(0, 8)}`);
  fs.mkdirSync(filePath, { recursive: true });
  const r = await post(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { path: filePath, name });
  assert.ok(r.status < 400, JSON.stringify(r.body));
  return r.body;
}
const newChat = (wid, fields = {}) => {
  const at = Date.now();
  return store.createChat({ id: crypto.randomUUID(), workspaceId: wid, kind: "normal", title: "Project chat", createdAt: at, updatedAt: at, ...fields });
};
// The timeline agent with a model (effective) and row "enabled" from 0 on this chat (the watermark of the first run then reads everything).
function effectiveTimelineAgent(ws, chat) {
  const a = store.changeOuterLoopAgent(timelineAgentId(ws.id), { provider: "claude", model: MODEL });
  if (chat) store.setOuterLoopActive(a.id, chat.id, true, 0);
  return store.outerLoopAgent(a.id);
}
// Run rows of this test without a process: open runs count as open work - the body ends them itself.
const cleanRuns = () => { for (const l of [...store.outerLoopRunsOpen(), ...store.outerLoopRunsParked()]) store.outerLoopRunEnd(l.id, { state: "aborted" }); };

// tools/list by spawn - the same way as outerloop-visibility.test.js.
function toolsList(env) {
  return new Promise((resolve, reject) => {
    const empty = { CBASE_TOOLS: undefined, CBASE_TOOLSET: undefined, CBASE_SKILLS: undefined, CBASE_AGENT_DEPTH: undefined, CBASE_SCHEMA: undefined, CBASE_WORKFLOW_AGENT: undefined, CBASE_OUTER_LOOP: undefined, CBASE_INSTANCE: undefined, CBASE_FENCE_TOKEN: undefined };
    const child = spawn(process.execPath, [MCP_SCRIPT], { env: { ...process.env, ...empty, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => { stderr += c; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === 2) { child.kill(); resolve(msg.result.tools.map((t) => t.name)); }
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => { if (code) reject(new Error(`MCP server exited with ${code}: ${stderr.trim().split("\n")[0]}`)); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  });
}

// A long track: `n` exchanges of ~1,500 characters each - together far over the cap of 30,000 characters.
function longTrack(chatId, n = 30, t0 = 10_000) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    store.addMessage(chatId, i % 2 ? "assistant" : "user", `Row ${i}: ${"x".repeat(1500)}`, t0 + i);
    ids.push(store.messageStats(chatId).lastId);
  }
  return ids;
}
// The ids of the rows of a timeline-agent input (every row carries "· row N]").
const seenIn = (text) => [...text.matchAll(/ · row (\d+)\] /g)].map((m) => Number(m[1]));

// ── (1) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(1) Seed and form: on workspace creation and at start, from the template, ineffective without a model, fixed, id <ws>-71e11e", async (t) => {
  await withAgentsServer(async (ctx) => {
    const W = `${ctx.base}/api/workspaces/${ctx.ws.id}/outer-loop`;
    const a = store.outerLoopTimelineAgent(ctx.ws.id);
    assert.ok(a, "POST /api/workspaces seeded the timeline agent");
    assert.equal(a.id, `${ctx.ws.id}-71e11e`);
    assert.equal(timelineAgentId(ctx.ws.id), a.id);
    assert.match(a.id, /^[0-9a-f-]+$/, "the agents' route pattern matches the id");
    assert.deepEqual(
      { name: a.name, job: a.job, trigger: a.trigger, defaultNew: a.defaultNew, tools: a.tools, builtin: a.builtin, mcp: a.mcp, templateRevision: a.templateRevision },
      { name: "Timeline", job: TL.job, trigger: [{ kind: "quiet", minutes: 5 }], defaultNew: true, tools: [], builtin: [], mcp: {}, templateRevision: TL.revision });
    assert.deepEqual([a.timeline, a.gapless, a.agendaKeeper, a.summarizer, a.enabled, a.provider, a.model, a.origin], [true, true, false, false, true, "", "", "workspace"]);
    // The job carries what the build contract demands.
    for (const pattern of [/real/, /collecting event/, /tool call/, /Git anchor/, /code, git, test, communication, ops, other/, /tags/, /cbase_timeline/, /Git events .* you enter yourself/, /Dismiss .* give the reason/]) {
      assert.match(TL.job, pattern);
    }
    // NAMING guard: identifier AND what it is about, with a good and a bad example - in the template, in the fixed frame (see (2)) and in the
    // tool description of `title`. Counter-test: the sentence struck from the template => red here.
    assert.match(TL.job, /identifier .*AND what it is about/);
    assert.match(TL.job, /Good: "MR !45 merged: [^"]+"\. Bad: "MR !45 merged"/);
    assert.ok(TL.revision >= 3, "a new wording needs a new revision - otherwise no workspace sees a \"newer template\"");
    const mcpTimeline = fs.readFileSync(fileURLToPath(new URL("../electron/mcp/tools/timeline.js", import.meta.url)), "utf8");
    assert.match(mcpTimeline, /title: str\("[^"]*identifier AND subject, never just the number/, "the description of title does not say it");
    // Only it carries the flags.
    for (const other of [store.outerLoopSummarizer(ctx.ws.id), store.outerLoopAgendaKeeper(ctx.ws.id)]) {
      assert.deepEqual([other.timeline, other.gapless], [false, false], other.name);
    }
    const pub = publicAgent(a);
    assert.deepEqual([pub.fixed, pub.timeline, pub.ineffectiveReason, pub.markUpkeep], [true, true, "without-model", false]);
    assert.deepEqual(store.outerLoopAgentsOf(ctx.ws.id).map((x) => x.id), [ctx.ws.id, `${ctx.ws.id}-a9e0da`, a.id], "behind summarizer and keeper");
    assert.equal(seedTimelineAgent(ctx.ws.id).createdAt, a.createdAt, "a second call creates nothing");
    assert.equal(seedMissingTimelineAgents(), 0, "idempotent");

    // DELETE 409, reset against ITS template (model and `enabled` stay).
    const d = await erase(`${W}/${a.id}`);
    assert.equal(d.status, 409, JSON.stringify(d.body));
    assert.equal(d.body.timeline, true);
    assert.ok(store.outerLoopAgent(a.id), "it still exists");
    assert.equal((await patch(`${W}/${a.id}`, { name: "Mine", job: "Other.", provider: "claude", model: MODEL, enabled: false })).status, 200);
    const z = await post(`${W}/${a.id}/reset`, {});
    assert.equal(z.status, 200, JSON.stringify(z.body));
    assert.deepEqual([z.body.name, z.body.job, z.body.trigger, z.body.provider, z.body.model, z.body.enabled, z.body.timeline],
      [TL.name, TL.job, [{ kind: "quiet", minutes: 5 }], "claude", MODEL, false, true]);

    // A workspace that already existed without it (state before the timeline agent): the start seeds it afterwards - with the same id.
    const r = await post(`${ctx.base}/api/workspaces`, { name: "Second", path: path.join(ctx.root, "second") });
    assert.equal(r.status, 201);
    assert.equal(store.outerLoopTimelineAgent(r.body.id)?.id, `${r.body.id}-71e11e`, "the second workspace too");
    assert.equal(store.deleteOuterLoopAgent(a.id), true);
    assert.equal(store.deleteOuterLoopAgent(`${r.body.id}-71e11e`), true);
    await ctx.restart();
    assert.equal(store.outerLoopTimelineAgent(ctx.ws.id)?.id, a.id, "the start migration seeded it afterwards");
    assert.equal(store.outerLoopTimelineAgent(r.body.id)?.id, `${r.body.id}-71e11e`, "in every workspace");
    assert.equal(store.outerLoopAgentsOf(r.body.id).length, 3, "summarizer, keeper, timeline - no more");
    t.diagnostic(`Timeline agent ${a.id}, revision ${a.templateRevision}`);
  });
});

// ── (2) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(2) GUARD visibility: the two tools only on the timeline agent - never in the Coding catalog, no list without a marker", async (t) => {
  await withAgentsServer(async (ctx) => {
    const proj = await newProject(ctx, "View");
    const c = newChat(ctx.ws.id, { projectId: proj.id });
    const tla = store.outerLoopTimelineAgent(ctx.ws.id);
    assert.deepEqual([...TIMELINE_TOOLS], [READ, WRITE]);
    assert.deepEqual([...ONLY_TIMELINE_AGENT], [READ, WRITE]);
    const set = outerLoopSet(tla, c);
    assert.deepEqual(set.cbase, [ANALYSIS, READ, WRITE], "analysis plus the two, catalog order");
    assert.deepEqual(outerLoopSet(tla, c, { withToken: true }).cbase, [ANALYSIS, READ, WRITE], "no fence cut");
    const own = store.createOuterLoopAgent({ id: crypto.randomUUID(), workspaceId: ctx.ws.id, name: "Eigener", trigger: [{ kind: "quiet", minutes: 5 }], provider: "claude", model: MODEL, tools: ["cbase_agents_list"] });
    for (const a of [store.outerLoopSummarizer(ctx.ws.id), store.outerLoopAgendaKeeper(ctx.ws.id), own]) {
      const s = outerLoopSet(a, c).cbase;
      assert.equal(s.includes(READ) || s.includes(WRITE), false, `${a.name}: neither of the two (${s.join(", ")})`);
      const r = outerLoopFrame(a, c, outerLoopSet(a, c));
      assert.equal(r.includes(READ), false, `${a.name}: no word of the timeline in the frame`);
    }
    for (const w of [READ, WRITE]) {
      assert.equal(OUTER_LOOP_SELECTABLE.includes(w), false, `${w} is not selectable`);
      assert.equal((await patch(`${ctx.base}/api/workspaces/${ctx.ws.id}/outer-loop/${own.id}`, { tools: [w] })).status, 400, `select ${w}`);
      assert.equal(agentToolset({ parent: { cbase: null, builtin: null }, depth: 2 }).cbase.includes(w), false, `${w} is not in a subagent's full set`);
      assert.ok(ONLY_WITH_OUTER_LOOP_MARKER.includes(w));
    }
    // Description side = execution side: the frame names both and the rule - for the timeline agent.
    const frame = outerLoopFrame(tla, c, set);
    assert.match(frame, /- cbase_timeline — /);
    assert.match(frame, /- cbase_timeline_write — /);
    assert.match(frame, /<tool-index>/);
    assert.match(frame, /<timeline-most-recent>/);
    assert.ok(frame.includes(TL.job), "the job of the template");
    // The naming also stands in the FIXED frame - it holds whether or not the workspace adopts the new revision.
    const withoutJob = frame.replace(TL.job, "");
    assert.match(withoutJob, /mit Kennung \(Issue #123, MR !45, Pipeline #6789\) UND sage im Titel, worum es fachlich geht — nie nur Nummern/,
      "the naming rule is missing in the fixed frame");

    // The MCP server: blocked without a marker for EVERY run - also by an explicit list; with marker and list present.
    const list = JSON.stringify([...CATALOG_NAMES]);
    for (const [what, env] of [
      ["Coding-Katalog (Hauptlauf)", {}],
      ["explicit list", { CBASE_TOOLS: list }],
      ["Subagent Tiefe 1", { CBASE_AGENT_DEPTH: "1", CBASE_TOOLS: list }],
      ["Workflow-Agent", { CBASE_WORKFLOW_AGENT: "wf-1", CBASE_AGENT_DEPTH: "1", CBASE_TOOLS: list }],
    ]) {
      const n = await toolsList(env);
      assert.ok(n.length > 0, `${what}: tools at all`);
      assert.equal(n.includes(READ) || n.includes(WRITE), false, `${what}: neither of the two`);
    }
    const including = await toolsList({ CBASE_OUTER_LOOP: `${tla.id}:run-1`, CBASE_TOOLS: JSON.stringify(set.cbase) });
    assert.deepEqual(including, [ANALYSIS, READ, WRITE], "counter-test: with the marker in the set the server offers both");
    t.diagnostic(`Set ${set.cbase.join(", ")}`);
  });
});

// ── (3) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Fake Claude: an outer-loop run (recognised by the frame) answers at once with a note; every other run ends like the default.
const OL_BODY = `
if (joined.includes(${JSON.stringify(FRAME_IDENTIFIER_LINE)})) { finished(); say({ type: "result", result: "Nothing to enter.", session_id: "ol" }); return; }
finished(); say({ type: "result", result: "fertig", session_id: "main-session" });
`;

test("(3) GUARD gapless: every row in exactly one input, the watermark never behind an unseen one - counter-test: today's way jumps; the real run reads everything in follow-up runs", async (t) => {
  await withAgentsServer(async (ctx) => {
    const { waitForTruthy } = ctx;
    const proj = await newProject(ctx, "Long");
    const c = newChat(ctx.ws.id, { projectId: proj.id });
    const ids = longTrack(c.id);
    const tla = store.outerLoopTimelineAgent(ctx.ws.id);

    // The check that hits both ways: read like the runs one after another until nothing comes.
    const read = (agent, withRow) => {
      const inputs = [];
      let fromId = 0;
      for (let i = 0; i < ids.length + 2; i++) {
        const e = buildInput({ agent, chat: c, fromId, since: 0, trigger: "quiet" });
        if (!e.rows) break;
        const seen = withRow(e.text);
        inputs.push({ seen, untilId: e.untilId, rest: e.rest });
        if (e.untilId === fromId) break;
        fromId = e.untilId;
      }
      return inputs;
    };
    const matches = (inputs) => {
      const all = inputs.flatMap((x) => x.seen);
      const everyOnce = ids.every((id) => all.filter((g) => g === id).length === 1);
      const seenUntil = new Set();
      const neverBehind = inputs.every((x) => { x.seen.forEach((g) => seenUntil.add(g)); return ids.filter((id) => id <= x.untilId).every((id) => seenUntil.has(id)); });
      return { everyOnce, neverBehind };
    };

    const fresh = read(tla, seenIn);
    assert.ok(fresh.length >= 2, `the track needs several runs (otherwise the case checked nothing): ${fresh.length}`);
    assert.deepEqual(matches(fresh), { everyOnce: true, neverBehind: true }, JSON.stringify(fresh.map((x) => [x.seen.length, x.untilId, x.rest])));
    assert.deepEqual(fresh.map((x) => x.rest), [...fresh.slice(0, -1).map(() => true), false], "rest, until the track is empty");
    assert.equal(fresh[0].seen[0], ids[0], "from the FRONT: the oldest row first");

    // Counter-test: today's way (summarizer, same chat) - the oldest fall, the watermark jumps over them.
    const summary = store.outerLoopSummarizer(ctx.ws.id);
    const today = read(summary, (text) => ids.filter((id) => text.includes(`Row ${ids.indexOf(id)}: `)));
    assert.equal(today.length, 1, "today's way reads once and is done");
    assert.equal(today[0].untilId, ids.at(-1), "... with the watermark over EVERYTHING");
    assert.deepEqual(matches(today), { everyOnce: false, neverBehind: false }, "counter-test: the check catches the jump");

    // The real run: ONE trigger - the follow-up runs fetch the rest by themselves, each from the watermark of the previous one.
    const a = effectiveTimelineAgent(ctx.ws, c);
    const r = await startOuterLoopRun({ agent: a, chat: store.getChat(c.id), trigger: "quiet" });
    assert.equal(r.started, true, JSON.stringify(r));
    await waitForTruthy(() => {
      const l = store.outerLoopLastFinishedRun(a.id, c.id);
      return l && l.untilMessageId === ids.at(-1) && outerLoopCoreCount() === 0 && store.outerLoopRunsOpen().length === 0;
    }, "the whole track read");
    const runs = store.outerLoopRunsOfAgent(a.id, { limit: 500 }).items.filter((l) => l.chatId === c.id).sort((x, y) => x.fromMessageId - y.fromMessageId);
    assert.equal(runs.length, fresh.length, `as many runs as inputs: ${runs.map((l) => `${l.trigger}:${l.fromMessageId}→${l.untilMessageId}`).join(" ")}`);
    assert.deepEqual(runs.map((l) => l.state), runs.map(() => "finished"));
    assert.deepEqual(runs.map((l) => l.trigger), ["quiet", ...runs.slice(1).map(() => "afterRun")], "without a further trigger");
    for (let i = 1; i < runs.length; i++) assert.equal(runs[i].fromMessageId, runs[i - 1].untilMessageId, "each from the watermark of the previous one");
    assert.deepEqual(runs.map((l) => l.untilMessageId), fresh.map((x) => x.untilId), "the same watermarks as the inputs above");
    t.diagnostic(`${ids.length} rows in ${fresh.length} runs; today: ${today[0].seen.length} seen, line ${today[0].untilId}`);
  }, { claude: fakeClaude({ main: OL_BODY }) });
});

// ── (4) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(4) GUARD unchanged: summarizer and agenda keeper read as before - the newest, line over everything, without row, without timeline blocks", async () => {
  await withAgentsServer(async (ctx) => {
    const proj = await newProject(ctx, "Old");
    const short = newChat(ctx.ws.id, { projectId: proj.id, title: "Short" });
    store.addMessage(short.id, "user", "Please <rebuild> the checkout.", 1_700_000_000_000);
    store.addMessage(short.id, "assistant", "Done.", 1_700_000_060_000);
    const lang = newChat(ctx.ws.id, { projectId: proj.id, title: "Long" });
    const ids = longTrack(lang.id);
    const tz = timeZoneDefault(ctx.ws.id);
    const clock = (ms) => wallTimeText(ms, tz, { withYear: false });
    for (const a of [store.outerLoopSummarizer(ctx.ws.id), store.outerLoopAgendaKeeper(ctx.ws.id)]) {
      const e = buildInput({ agent: a, chat: store.getChat(short.id), fromId: 0, since: 0, trigger: "quiet" });
      assert.equal("rest" in e, false, `${a.name}: no rest`);
      // The row form byte-exact, as before the timeline agent.
      const history = e.text.slice(e.text.indexOf("<new-history"), e.text.indexOf("</new-history>") + "</new-history>".length);
      assert.equal(history, `<new-history rows="2">\n[user · ${clock(1_700_000_000_000)}] Please &lt;rebuild&gt; the checkout.\n[assistant · ${clock(1_700_000_060_000)}] Done.\n</new-history>`);
      for (const tag of ["<timeline-most-recent", "<tool-index", " · row "]) assert.equal(e.text.includes(tag), false, `${a.name}: ${tag}`);
      const l = buildInput({ agent: a, chat: store.getChat(lang.id), fromId: 0, since: 0, trigger: "quiet" });
      assert.equal(l.untilId, ids.at(-1), `${a.name}: the watermark over everything (today's behaviour, stays - gapless only for the timeline agent for now)`);
      assert.ok(l.text.includes(`Row ${ids.length - 1}: `) && !l.text.includes("Row 0: "), `${a.name}: the newest stay, the oldest fall`);
      assert.match(l.text, /die ältesten fehlen/);
    }
  });
});

// ── (5) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(5) GUARD: a chat without a project does not wake the timeline agent - counter-test: the chat of a project gets the quiet clock", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws, chat, waitForTruthy } = ctx;
    assert.equal(store.getChat(chat.id).projectId ?? null, null, "the test chat has no project (otherwise the case checked nothing)");
    const a = effectiveTimelineAgent(ws, chat);
    assert.deepEqual(activation(a, store.getChat(chat.id)), { active: false, source: "not-available", since: null }, "also with a row \"enabled\"");
    store.addMessage(chat.id, "user", "Push to main.", 1000);
    const r = await startOuterLoopRun({ agent: a, chat: store.getChat(chat.id), trigger: "quiet" });
    assert.deepEqual([r.started, r.reason], [false, "not-available"]);
    assert.equal(store.outerLoopRunsOfAgent(a.id).items.length, 0, "no row");
    const summary = store.changeOuterLoopAgent(ws.id, { provider: "claude", model: MODEL });
    store.setOuterLoopActive(summary.id, chat.id, true, 0);
    // A real turn: the quiet clocks are set at the turn end - for the summarizer (counter-test), not for the timeline agent.
    const m = await post(`${base}/api/chats/${chat.id}/message`, { text: "Please push." });
    assert.ok(m.status < 300, JSON.stringify(m.body));
    await waitForTruthy(() => outerLoopQuietStands(summary.id, chat.id), "the quiet clock of the summarizer stands");
    assert.equal(outerLoopQuietStands(a.id, chat.id), false, "no quiet clock for the timeline agent");

    // Counter-test: the same agent on the chat of a project.
    const proj = await newProject(ctx, "Awake");
    const pc = newChat(ws.id, { projectId: proj.id });
    store.setOuterLoopActive(a.id, pc.id, true, 0);
    assert.equal(activation(a, store.getChat(pc.id)).active, true, "active on the project chat");
    const m2 = await post(`${base}/api/chats/${pc.id}/message`, { text: "Please push." });
    assert.ok(m2.status < 300, JSON.stringify(m2.body));
    await waitForTruthy(() => outerLoopQuietStands(a.id, pc.id), "the quiet clock of the timeline agent stands on the project chat");
  }, { claude: fakeClaude({ main: OL_BODY }) });
});

// ── (6) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A switch per agent ("Abort on new message", `abortingTurn`) instead of a fixed rule: the timeline agent carries it OFF - its run
// continues, a trigger "after every run end" queues a follow-up run; the keeper carries it ON (abort as before). Switched on, the timeline
// agent aborts too. Counter-test against the old state: there the turn "t-pc" aborted - the first check below is red.
test("(6) Switch \"Abort on new message\": off => the run continues and a run end queues; on => abort on this chat", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws, waitForTruthy } = ctx;
    const W = `${base}/api/workspaces/${ws.id}/outer-loop`;
    const proj = await newProject(ctx, "Reading");
    const pc = newChat(ws.id, { projectId: proj.id });
    const other = newChat(ws.id, { projectId: proj.id });
    const tla = store.changeOuterLoopAgent(effectiveTimelineAgent(ws, pc).id, { trigger: [{ kind: "run_end" }] });
    const keeper = store.outerLoopAgendaKeeper(ws.id);
    assert.deepEqual([tla.abortingTurn, keeper.abortingTurn], [false, true], "the seed defaults");
    assert.equal(publicAgent(tla).abortingTurn, false, "the public form carries the switch");
    try {
      store.createOuterLoopRun({ id: "t-pc", agentId: tla.id, chatId: pc.id, trigger: "quiet" });
      store.createOuterLoopRun({ id: "t-other", agentId: tla.id, chatId: other.id, trigger: "quiet" });
      store.createOuterLoopRun({ id: "p-pc", agentId: keeper.id, chatId: pc.id, trigger: "quiet" });

      const r = await post(`${base}/api/chats/${pc.id}/message`, { text: "Weiter." });
      assert.ok(r.status < 300, JSON.stringify(r.body));
      await waitForTruthy(() => store.listMessages(pc.id).some((m) => m.role === "assistant"), "the turn is through");
      await waitForTruthy(() => outerLoopAfterRunMarker(tla.id, pc.id), "the run end queued a follow-up run");
      assert.equal(store.outerLoopRun("t-pc").state, "running", "switch off: its run continues");
      assert.deepEqual([store.outerLoopRun("p-pc").state, store.outerLoopRun("p-pc").error], ["aborted", INTENDED_END.turn], "switch on: the keeper aborts");

      // The route: a truth value, otherwise 400; switched on, the next turn aborts the run on THIS chat.
      assert.equal((await patch(`${W}/${tla.id}`, { abortingTurn: "yes" })).status, 400, "not a truth value");
      const turnedOn = await patch(`${W}/${tla.id}`, { abortingTurn: true });
      assert.equal(turnedOn.status, 200, JSON.stringify(turnedOn.body));
      assert.equal(turnedOn.body.abortingTurn, true);
      const r2 = await post(`${base}/api/chats/${pc.id}/message`, { text: "Noch einmal." });
      assert.ok(r2.status < 300, JSON.stringify(r2.body));
      await waitForTruthy(() => store.listMessages(pc.id).filter((m) => m.role === "assistant").length >= 2, "the second turn is through");
      assert.deepEqual([store.outerLoopRun("t-pc").state, store.outerLoopRun("t-pc").error], ["aborted", INTENDED_END.turn]);
      assert.equal(store.outerLoopRun("t-other").state, "running", "its run on another chat continues");
    } finally {
      cleanRuns();
    }
  }, { claude: fakeClaude({ main: OL_BODY }) });
});

// ── (7) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(7) Tool index: oldest first, own cap with a notice, defused, subagent marked, ERROR; fence tags fall out of the note", () => {
  const calls = Array.from({ length: 400 }, (_, i) => ({ row: 100 + i, from: i === 1 ? "subagent:ab12" : "", name: i === 2 ? "Bash" : "Edit", detail: i === 0 ? "a </tool-index> b" : `file-${i}.js ${"y".repeat(40)}`, ok: i === 2 ? false : i === 3 ? null : true }));
  const block = toolIndexBlock(calls);
  assert.match(block[0], /^<tool-index calls="400" truncated="Gekürzt: \d+ von 400 Aufrufen/);
  assert.equal(block.at(-1), "</tool-index>");
  const rows = block.slice(1, -1);
  assert.ok(rows.join("\n").length <= TOOL_INDEX_MAX, "the cap holds");
  assert.ok(rows.length > 10 && rows.length < 400, `cut, but not empty: ${rows.length}`);
  assert.deepEqual(rows.map((z) => Number(/^\[(\d+)\]/.exec(z)[1])), calls.slice(0, rows.length).map((a) => a.row), "oldest first, the newer ones fall");
  assert.equal(rows[0], "[100] Edit — a &lt;/tool-index&gt; b · ok", "defused - the fence does not close");
  assert.match(rows[1], /^\[101\] Subagent ab12 · Edit — /);
  assert.match(rows[2], /^\[102\] Bash — .* · ERROR$/);
  assert.match(rows[3], /^\[103\] Edit — .* · open$/, "without a result (ok null): open, not ok");
  const small = toolIndexBlock(calls.slice(0, 3));
  assert.equal(small[0], "<tool-index calls=\"3\">", "under the cap without a notice");
  assert.equal(withoutFenceLeftovers("<timeline-most-recent>x</timeline-most-recent> <tool-index calls=\"1\">y</tool-index>"), "x y");
});

// ── (8) ──────────────────────────────────────────────────────────────────────────────────────────────────────
// The seam to the domain side `timeline/`: the route PUT /api/projects/:id/timeline, the column `projects.timeline_off`, the timeline
// search and the write route. No skip: red until the seam stands.
test("(8) Seam: project switch off => not available; reading through the agent route; writing only with the marker of the timeline agent", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws } = ctx;
    const proj = await newProject(ctx, "Seam");
    const pc = newChat(ws.id, { projectId: proj.id });
    const a = effectiveTimelineAgent(ws, pc);
    try {
      assert.equal(activation(a, store.getChat(pc.id)).active, true, "switch on (default)");
      const out = await put(`${base}/api/projects/${proj.id}/timeline`, { active: false });
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.equal(activation(a, store.getChat(pc.id)).source, "not-available", "switch off => the agent is not available on the chat");
      assert.equal((await put(`${base}/api/projects/${proj.id}/timeline`, { active: true })).status, 200);
      assert.equal(activation(a, store.getChat(pc.id)).active, true);

      // Now, not 1970: the most-recent read covers the last seven days, and `at` is the time of the finding.
      const now = Date.now();
      store.addMessage(pc.id, "user", "Please merge the branch.", now - 2000);
      store.addMessage(pc.id, "assistant", "The branch is merged.", now - 1000);
      const notice = store.messageStats(pc.id).lastId;
      store.createOuterLoopRun({ id: "t-seam", agentId: a.id, chatId: pc.id, trigger: "quiet" });
      const keeper = store.outerLoopAgendaKeeper(ws.id);
      store.createOuterLoopRun({ id: "p-seam", agentId: keeper.id, chatId: pc.id, trigger: "quiet" });

      const entry = { action: "enter", kind: "git", title: "Branch merged", citation: { kind: "message", row: notice } };
      const foreign = await post(`${base}/api/projects/${proj.id}/timeline/agent`, { ...entry, outerLoop: `${keeper.id}:p-seam` });
      assert.equal(foreign.status, 403, `the keeper's marker: ${JSON.stringify(foreign.body)}`);
      const ok = await post(`${base}/api/projects/${proj.id}/timeline/agent`, { ...entry, outerLoop: `${a.id}:t-seam` });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      const s = await request(`${base}/api/projects/${proj.id}/timeline/agent?${new URLSearchParams({ outerLoop: `${a.id}:t-seam`, action: "search" })}`);
      assert.equal(s.status, 200, JSON.stringify(s.body));
      assert.ok(Array.isArray(s.body.events) && s.body.events.some((e) => e.id === ok.body.event.id), JSON.stringify(s.body));
      const e = await request(`${base}/api/projects/${proj.id}/timeline/agent?${new URLSearchParams({ outerLoop: `${a.id}:t-seam`, action: "event", id: ok.body.event.id })}`);
      assert.equal(e.status, 200, JSON.stringify(e.body));
      assert.equal(e.body.event.title, "Branch merged");
      // The input carries the most recent entry (timelineMostRecent), defused in the fence.
      const one = buildInput({ agent: a, chat: store.getChat(pc.id), fromId: 0, since: 0, trigger: "quiet" }).text;
      const mostRecent = one.slice(one.indexOf("<timeline-most-recent"), one.indexOf("</timeline-most-recent>"));
      assert.ok(mostRecent.includes("Branch merged"), mostRecent);
    } finally {
      cleanRuns();
    }
  });
});

// ── Findings of the cross-read ─────────────────────────────────────────────────────────────────────────────────────────
// A call and its result as the turn writes them; `detail` long enough that a few hundred calls blow the index cap.
function callWithResult(chatId, i, ts) {
  const id = `call-${i}-${crypto.randomUUID().slice(0, 6)}`;
  const row = store.addMessage(chatId, "tool", JSON.stringify({ name: "Edit", detail: `file-${i}.js ${"d".repeat(90)}`, id, input: {} }), ts);
  store.addMessage(chatId, "tool_result", JSON.stringify({ id, result: "ok", isError: false }), ts);
  return row;
}
// The rows of the tool index of an input (each starts with "[N] ").
const indexIn = (text) => {
  const block = text.slice(text.indexOf("<tool-index"), text.indexOf("</tool-index>"));
  return [...block.matchAll(/^\[(\d+)\] /gm)].map((m) => Number(m[1]));
};

test("(9) GUARD: the tool index of the first run starts like the history at activation (since) - no back-filling", async () => {
  await withAgentsServer(async (ctx) => {
    const proj = await newProject(ctx, "Since");
    const c = newChat(ctx.ws.id, { projectId: proj.id });
    const old = [callWithResult(c.id, 0, 1_000), callWithResult(c.id, 1, 2_000)];
    store.addMessage(c.id, "user", "before activation", 2_500);
    store.addMessage(c.id, "user", "after activation", 6_000);
    const fresh = [callWithResult(c.id, 2, 6_100)];
    store.addMessage(c.id, "assistant", "finished", 6_200);
    const tla = store.outerLoopTimelineAgent(ctx.ws.id);
    const e = buildInput({ agent: tla, chat: store.getChat(c.id), fromId: 0, since: 5_000, trigger: "quiet" });
    assert.deepEqual(indexIn(e.text), fresh, "only the calls from activation on");
    assert.ok(!e.text.includes("before activation"), "the history likewise");
    // Counter-test: without the lower bound the old calls would be in the index.
    const without = buildInput({ agent: tla, chat: store.getChat(c.id), fromId: 0, since: 0, trigger: "quiet" });
    assert.deepEqual(indexIn(without.text), [...old, ...fresh]);
  });
});

test("(10) GUARD gapless also for the tool index - every call and every message in exactly one input, the watermark never behind an unshown one, every run progresses", async () => {
  await withAgentsServer(async (ctx) => {
    const proj = await newProject(ctx, "Index");
    const c = newChat(ctx.ws.id, { projectId: proj.id });
    const calls = [];
    const messages = [];
    // Short messages (the history fits in one run), but 300 calls (the index does not).
    for (let i = 0; i < 300; i++) {
      if (i % 30 === 0) messages.push(store.addMessage(c.id, i % 60 ? "assistant" : "user", `Step ${i}`, 10_000 + i));
      calls.push(callWithResult(c.id, i, 10_000 + i));
    }
    messages.push(store.addMessage(c.id, "assistant", "End", 20_000));
    const tla = store.outerLoopTimelineAgent(ctx.ws.id);
    const inputs = [];
    let fromId = 0;
    for (let i = 0; i < 50; i++) {
      const e = buildInput({ agent: tla, chat: store.getChat(c.id), fromId, since: 0, trigger: "quiet" });
      if (e.untilId === fromId) break;
      inputs.push({ index: indexIn(e.text), history: seenIn(e.text), untilId: e.untilId, rest: e.rest });
      fromId = e.untilId;
    }
    const shows = (list, kind) => {
      const seen = new Set();
      for (const x of inputs) {
        x[kind].forEach((g) => seen.add(g));
        const behind = list.filter((id) => id <= x.untilId && !seen.has(id));
        assert.deepEqual(behind, [], `${kind}: unshown behind the watermark ${x.untilId}`);
      }
      const all = inputs.flatMap((x) => x[kind]);
      assert.deepEqual([...all].sort((a, b) => a - b), list, `${kind}: every row exactly once`);
    };
    shows(calls, "index");
    shows(messages, "history");
    assert.ok(inputs.length >= 2, `the index needs several runs (otherwise the case checked nothing): ${inputs.length}`);
    assert.deepEqual(inputs.map((x) => x.rest), [...inputs.slice(0, -1).map(() => true), false], "rest, until the track is empty");
    for (let i = 1; i < inputs.length; i++) assert.ok(inputs[i].untilId > inputs[i - 1].untilId, "every run progresses");
  });
});

// The timeline agent used to run via "default for new chats" and so only on chats created AFTER the model choice - on no existing project
// chat; measured 0 runs, 0 events. The tests above always switched it on by row and did not see it. Now "on by default, opt-out per
// project". Counter-test against the old state: source "no-default", not active.
test("(11) GUARD default on: without a row active on EVERY project chat, also one older than the model choice - row \"off\" switches off, a chat without a project never", async () => {
  await withAgentsServer(async (ctx) => {
    const proj = await newProject(ctx, "Old");
    const old = newChat(ctx.ws.id, { projectId: proj.id, createdAt: 1_000, updatedAt: 1_000 });
    const a = effectiveTimelineAgent(ctx.ws);
    assert.ok(a.defaultNewSince === null || a.defaultNewSince > 1_000, "the model choice lies after the chat creation (otherwise the case checked nothing)");
    const current = activation(a, store.getChat(old.id));
    assert.deepEqual([current.active, current.source], [true, "timeline"], "active without a row");
    const since = Math.max(Number(a.createdAt) || 0, 1_000);
    assert.equal(current.since, since, "reads from its seed, not the whole history");
    assert.equal(sinceFor(a, store.getChat(old.id)), since, "activation and first run say the same");
    store.setOuterLoopActive(a.id, old.id, false, Date.now());
    assert.equal(activation(a, store.getChat(old.id)).source, "row-off", "switchable off per chat");
    assert.equal(activation(a, store.getChat(ctx.chat.id)).source, "not-available", "a chat without a project never wakes it");
  });
});

// ── Refinement: naming, bundling ────────────────────────────────────────────────────────────────────────────────────────────────────

test("(13) GUARD bundling and citation (revision 4): ONE source for template and fixed frame, with a good and a bad example; the tool description says it briefly", async () => {
  await withAgentsServer(async (ctx) => {
    const proj = await newProject(ctx, "Rule");
    const c = newChat(ctx.ws.id, { projectId: proj.id });
    const tla = store.outerLoopTimelineAgent(ctx.ws.id);
    assert.ok(TL.revision >= 4, "a new wording needs a new revision");
    // The rule carries what the finding demanded.
    for (const pattern of [/work cycle .* becomes ONE event at its end/, /"Started", "running" and intermediate states are no event, "done with a result" is/,
      /Questions to the user, reports and summaries, plans, the user's decisions/, /a decision may stand in the text of the event that carries it out/,
      /Good: ONE event "[^"]+"\. Bad: "Gate started"/]) {
      assert.match(TIMELINE_RULE_BUNDLE, pattern);
    }
    assert.match(TIMELINE_RULE_CITATION, /not a write to a status or notes file, no agenda change, no command like \/status/);
    // In the template AND in the fixed frame - also if the workspace does not adopt the template (job removed).
    for (const r of [TIMELINE_RULE_BUNDLE, TIMELINE_RULE_CITATION]) assert.ok(TL.job.includes(r), "in the template");
    const set = outerLoopSet(tla, c);
    const fixed = outerLoopFrame({ ...tla, job: "Other." }, c, set);
    // The rule constants are bound to the ENGLISH wording of the frame (the German one is its own entry in i18n-de.js).
    const lang = getUiLang();
    setUiLang("en");
    try {
      const fixedEn = outerLoopFrame({ ...tla, job: "Other." }, c, set);
      for (const r of [TIMELINE_RULE_BUNDLE, TIMELINE_RULE_CITATION]) assert.ok(fixedEn.includes(r), "in the fixed frame without the job of the template");
    } finally { setUiLang(lang); }
    assert.match(fixed, /400 NO_PROOF taugt die Fundstelle nicht/, "the frame explains the new refusal");
    // The tool description: bundling and which message proves - in the source, like (1) for title.
    const mcpTimeline = fs.readFileSync(fileURLToPath(new URL("../electron/mcp/tools/timeline.js", import.meta.url)), "utf8");
    assert.match(mcpTimeline, /A work pass \(gate, package, review round\) is ONE event at its end/);
    assert.match(mcpTimeline, /message = a message of the user or an agent that reports it \(reported\), not a question, not a command like \/status/);
  });
});
