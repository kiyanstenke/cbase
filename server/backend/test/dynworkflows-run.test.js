// The run of a dynamic workflow — main seam with the agent harness: real server, real cbase MCP server, real routes, real
// agent core; only the providers are faked. A coding chat in ultracode mode calls `cbase_dynamic_workflow`, the tool returns
// at once, the run lives outside the turn (server/backend/electron/server/dynworkflows/run.js), at the end the completion
// notice arrives through the chat's wake path.
//
// Counter-tests (which sabotage turns which test red):
//   - remove the opt-in check (`!chat.ultracode`) in run.js => "without mode" starts the run and falls (it answers with the
//     approval card instead of 403 — dynworkflows-approval.test.js);
//   - `/stop` also ends the chat's runs (endDynRun in the stop branch of runs/routes.js) => "/stop" falls;
//   - drop the hook "chatClosed" in runs/agents.js (closeAgentsOfTheChat) => "delete" finds the run and its child alive;
//   - drop the switch "open-work" in runs/archive.js => "archive" gets 200 instead of 409 (the second source is in
//     runs/background.js, setBackgroundSource);
//   - (a workflow does not count in `busy`; the counter-test for that is in active-runs.test.js)
//   - drop dynWorkflowsAtServerEnd at `close` => "server end" finds the agent child alive.
// Start and end markers: drop the call `marker(run2, "start")` in run() => "/stop" and "unhandled rejection" fall; drop the
// end marker in the stop branch => "/stop" falls.
// Resumption failing at its completion: drop the line `if (!run2.endMarker) reportGlobal(run2, false);` in resumptionFailed
// => "resumption" red (the global stream only carries `open: true`).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import { GLOBAL } from "./quiet.mjs";
import { isCompletionNotice } from "../electron/server/runs/completionNotice.js";
import { fireHooks } from "../electron/server/runs/hooks.js";
import { outputLocation, workflowScripts } from "../electron/server/runs/outputs.js";
import { normOptions, key, branchKey } from "../electron/server/dynworkflows/journal.js";
import { dynWorkflowsOf } from "../electron/server/dynworkflows/run.js";
import { deadlineText } from "../electron/server/dynworkflows/sandbox.js";
import * as store from "../electron/server/store.js";
import { db } from "../electron/server/store/db.js";

// The main agent: a message with "WF[<tag>]:{json}" calls cbase_dynamic_workflow with these arguments (with a call block,
// like the real CLI) and stores the tool result under wf-<tag>; "{HOLD}" then leaves the turn standing at gate "main-<tag>".
// A completion notice it stores with its argv in notices.jsonl. Otherwise it answers briefly.
const MAIN = `
  if (text.startsWith("<task-notification>")) {
    fs.appendFileSync(path.join(LOCATION, "notices.jsonl"), JSON.stringify({ text, argv }) + "\\n");
    say({ type: "assistant", message: { id: "m-" + Date.now(), content: [{ type: "text", text: "Notice read" }] } });
    finished();
    say({ type: "result", result: "Notice read", session_id: "main-session" });
    return;
  }
  const i = text.indexOf("WF[");
  if (i >= 0) {
    const tag = text.slice(i + 3, text.indexOf("]:", i));
    const args = JSON.parse(text.slice(text.indexOf("]:", i) + 2));
    const id = "toolu_wf_" + tag;
    say({ type: "assistant", message: { id: "a-" + tag, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_dynamic_workflow", input: args }] } });
    let t = "";
    try { const r = await mcpCall("cbase_dynamic_workflow", args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    { const z = path.join(LOCATION, "wf-" + tag); fs.writeFileSync(z + ".teil", t); fs.renameSync(z + ".teil", z); } // atomic: the test only waits for the file to exist
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
    if (text.includes("{HOLD}")) await gate("main-" + tag);
    say({ type: "assistant", message: { id: "b-" + tag, content: [{ type: "text", text: "Workflow started" }] } });
    finished();
    say({ type: "result", result: "Workflow started", session_id: "main-session" });
    return;
  }
  say({ type: "assistant", message: { id: "c-" + Date.now(), content: [{ type: "text", text: "Reply to " + text.slice(0, 30) }] } });
  finished();
  say({ type: "result", result: "Response", session_id: "main-session" });`;

// A workflow agent: marker {TAG:x} in the prompt, {GATE:x} holds it at the gate, {CRASH} makes its child crash. It reports
// consumption, stores pid and start and reports "Finding <tag>". Only the computed task is read (on a human cause the
// relay of the request precedes it — with the whole script, hence the markers of all agents).
const SUB = `
    const ab = text.lastIndexOf("Here is the task:");
    const job = ab >= 0 ? text.slice(ab) : text;
    const tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : "x";
    fs.writeFileSync(path.join(LOCATION, "sub-pid-" + tag), String(process.pid));
    fs.appendFileSync(path.join(LOCATION, "sub-start-" + tag), "x");
    if (job.includes("{CRASH}")) process.exit(1);
    say({ type: "assistant", message: { id: "s1-" + tag, usage: { input_tokens: 11, output_tokens: 5 }, content: [{ type: "text", text: "work" }] } });
    if (job.includes("{GATE:")) await gate(job.split("{GATE:")[1].split("}")[0]);
    say({ type: "assistant", message: { id: "s2-" + tag, content: [{ type: "text", text: "Finding " + tag }] } });
    finished();
    say({ type: "result", result: "Finding " + tag, session_id: "sub-" + tag });`;

const claude = fakeClaude({ main: MAIN, sub: SUB });

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const ultracodeOn = (base, chatId) => json(`${base}/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
const script = (name, body) => `export const meta = { name: '${name}', description: 'Tracer', phases: [{ title: 'Read' }] }\n${body}\n`;
// Start the workflow through the main agent; returns the tool result (JSON or "ERROR …").
async function startAt(ctx, chatId, tag, args, { hold = false } = {}) {
  await post(`${ctx.base}/api/chats/${chatId}/message`, { text: `${hold ? "{HOLD} " : ""}WF[${tag}]:${JSON.stringify(args)}` });
  const file = path.join(ctx.root, `wf-${tag}`);
  await waitForTruthy(() => fs.existsSync(file), `tool result ${tag}`);
  const t = fs.readFileSync(file, "utf8");
  return t.startsWith("ERROR ") ? { error: t } : JSON.parse(t);
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const subPid = (root, tag) => Number(fs.readFileSync(path.join(root, `sub-pid-${tag}`), "utf8"));
// The fakes (child processes) write the logs while the test reads — only completed lines (jsonl.mjs).
const notices = (root) => readJsonl(path.join(root, "notices.jsonl"));
const notMoreRunning = (runId) => waitForTruthy(() => (store.readDynRun(runId)?.status !== "running" ? store.readDynRun(runId) : null), `run ${runId} ended`);
// The markers of a run in the history: a role of their own, JSON text.
const markers = (log) => log.filter((m) => m.role === "workflow_marker").map((m) => JSON.parse(m.text));
const withoutTime = ({ at, ...m }) => { assert.equal(typeof at, "number"); return m; };
// A chat's SSE stream — it waits for the event, without a deadline (as in agent-lifetime.test.js).
async function openStream(url) {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal, headers: { Accept: "text/event-stream", Connection: "close" } });
  assert.equal(res.status, 200);
  const events = [];
  const pump = (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) { try { events.push(JSON.parse(line.slice(6))); } catch { /* partial line */ } }
          }
        }
      }
    } catch { /* abort on close */ }
  })();
  return { events, wait: (p, what) => waitForTruthy(() => events.find(p) || null, what), async shutdown() { ac.abort(); await pump; } };
}
// The initial state of the global stream (the first data line of /api/events) — with `dynWorkflows`, so that the chat list
// shows the working icon of a chat with an open dynamic workflow already at connect (runtime/sse.js).
async function globalInit(base) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  try {
    while (!buffer.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
    }
  } finally {
    ac.abort();
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  const row = buffer.split("\n").find((z) => z.startsWith("data: "));
  assert.ok(row, `no data event on /api/events: ${JSON.stringify(buffer)}`);
  return JSON.parse(row.slice("data: ".length));
}
const subConsumption = (chatId) => db.prepare("SELECT COUNT(*) n FROM usage_events WHERE chat_id = ? AND kind = 'sub'").get(chatId).n;

test("main seam: ultracode chat calls cbase_dynamic_workflow with two agent() — immediate return, chat free, dynWorkflows, journal v2 in call order, completion notice with readable output file", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    const text = script("tracer", "const [a, b] = await parallel([() => agent('Read A {TAG:a} {GATE:a}', { label: 'one' }), () => agent('Read B {TAG:b}', { label: 'two' })]);\nreturn { a, b };");
    const r = await startAt(ctx, chat.id, "h", { script: text });
    assert.equal(r.status, "started", JSON.stringify(r));
    assert.match(r.runId, /^wf_[a-z0-9-]{6,}$/);
    assert.ok(r.taskId && r.taskId !== r.runId, "own task id");
    // The script file lies at the chat's output location, byte-equal.
    assert.equal(r.scriptPath, path.join(workflowScripts(chat.id), r.runId, "script.js"));
    assert.equal(fs.readFileSync(r.scriptPath, "utf8"), text);
    // The turn ends although agent a still stands at the gate: no turn runs — the run is in its own field, not in busy (the
    // deploy does not wait for it).
    await ctx.gate.reached("a");
    await waitForTruthy(async () => (await json(`${base}/api/runs/active`)).runs === 0, "turn ended");
    const active = await json(`${base}/api/runs/active`);
    assert.equal(active.busy, false, "a running workflow does not count in busy");
    assert.deepEqual(active.dynWorkflows.map((w) => [w.chatId, w.runId, w.name]), [[chat.id, r.runId, "tracer"]]);
    // The global stream names the open run already in the initial state (working icon of the chat list) — this line holds the
    // WIRING in server.js (`workflows: () => …dynWorkflowsOpen…`), not only the sse side (hook-consumer-h4.test.js).
    const init = await globalInit(base);
    assert.deepEqual([init.running, init.dynWorkflows], [[], [{ chatId: chat.id, runId: r.runId }]]);
    // Consumption right after the end: b is finished, a not yet — exactly one row.
    await waitForTruthy(() => store.readDynJournal(r.runId).some((e) => e.kind === "result" && e.n === 2), "Agent b fertig");
    await waitForTruthy(() => subConsumption(chat.id) === 1, "consumption of b booked");
    assert.equal(store.readDynRun(r.runId).status, "running", "b's consumption is booked before the run ends");
    ctx.gate.open("a");
    const end = await notMoreRunning(r.runId);
    assert.equal(end.status, "finished", end.error);
    assert.deepEqual(end.returnValue, { a: "Finding a", b: "Finding b" });
    // Journal: launched 1, launched 2 (synchronously before the first wait), then started/result; keys as a chain — each thunk
    // of parallel() on ITS OWN lane (journal.js "branches"), not one behind the other.
    const j = store.readDynJournal(r.runId);
    assert.deepEqual(j.slice(0, 2).map((e) => [e.kind, e.n]), [["launched", 1], ["launched", 2]]);
    assert.deepEqual(j.filter((e) => e.kind === "result").map((e) => e.n).sort(), [1, 2]);
    assert.equal(j.filter((e) => e.kind === "started").length, 2);
    const norm = normOptions({ label: "one" }, { model: "claude::claude-opus-5-5" });
    const k1 = key(branchKey("", "parallel", 0), "Read A {TAG:a} {GATE:a}", norm);
    const k2 = key(branchKey("", "parallel", 1), "Read B {TAG:b}", normOptions({ label: "two" }, { model: "claude::claude-opus-5-5" }));
    assert.deepEqual([j[0].key, j[1].key], [k1, k2]);
    assert.deepEqual(j.filter((e) => e.kind === "launched").map((e) => e.chain), ["branches", "branches"], "every launched names the chain kind");
    assert.match(k1, /^v2:[0-9a-f]{64}$/);
    for (const e of j) assert.equal(e.key, e.n === 1 ? k1 : k2, `${e.kind} ${e.n}`);
    assert.equal(subConsumption(chat.id), 2);
    // The completion notice: a system message under the role user, read by the next turn.
    const log = await ctx.waitForLog(chat.id, (l) => l.some((m) => m.role === "user" && isCompletionNotice(m.text)));
    const notice = log.find((m) => m.role === "user" && isCompletionNotice(m.text)).text;
    assert.match(notice, new RegExp(`<task-id>${r.taskId}</task-id>`));
    assert.match(notice, /<tool-use-id>toolu_wf_h<\/tool-use-id>/);
    assert.match(notice, /<status>completed<\/status>/);
    assert.match(notice, /<name>tracer<\/name>/);
    assert.match(notice, /Finding a/);
    const output = /<output-file>([^<]+)<\/output-file>/.exec(notice)[1];
    assert.ok(output.startsWith(outputLocation(chat.id) + path.sep), `output file outside the readable location: ${output}`);
    assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).returnValue.b, "Finding b");
    await waitForTruthy(() => notices(root).length === 1, "completion notice at the main agent");
    const argv = notices(root)[0].argv;
    const addDirs = argv.flatMap((a, i) => (a === "--add-dir" ? [argv[i + 1]] : []));
    assert.ok(addDirs.includes(outputLocation(chat.id)), `the turn of the completion notice may read the location: ${addDirs}`);
    // No intermediate state of the workflow agents in the chat's history (only the two markers).
    assert.equal(log.filter((m) => m.role === "sub_text").length, 0);
    await ctx.waitForIdle();
    assert.deepEqual((await json(`${base}/api/runs/active`)).dynWorkflows, []);
    assert.deepEqual((await globalInit(base)).dynWorkflows, [], "after the run the initial state names no workflow any more");
  }, { claude });
});

test("markers: a run with two agent() leaves exactly two rows of the role workflow_marker (start, end with outcome), live and in the history — no row per agent, no meta/user/assistant for the workflow", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat } = ctx;
    await ultracodeOn(base, chat.id);
    const stream = await openStream(`${base}/api/chats/${chat.id}/stream`);
    try {
      await stream.wait((e) => e.subtype === "connected", "stream is up");
      const r = await startAt(ctx, chat.id, "m", { script: script("markers", "const a = await agent('Read A {TAG:ma} {GATE:ma}');\nconst b = await agent('Read B {TAG:mb}');\nreturn { a, b };") });
      assert.equal(r.status, "started", JSON.stringify(r));
      const start = await stream.wait((e) => e.type === "harness" && e.subtype === "workflow_marker" && e.marker?.phase === "start", "start marker live");
      assert.deepEqual(withoutTime(start.marker), { phase: "start", runId: r.runId, taskId: r.taskId, name: "markers" });
      // The turn is over, agent a stands at the gate: after the start marker only the rows of the turn that started the run
      // are there (tool result, its answer, its figures) — nothing from the workflow agent.
      await ctx.gate.reached("ma");
      await ctx.waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));
      const midway = await json(`${base}/api/chats/${chat.id}/log`);
      const iStart = midway.findIndex((m) => m.role === "workflow_marker");
      assert.deepEqual(markers(midway).map(withoutTime), [{ phase: "start", runId: r.runId, taskId: r.taskId, name: "markers" }]);
      assert.deepEqual(midway.slice(iStart + 1).map((m) => m.role), ["tool_result", "assistant", "meta"], "after the start marker only the triggering turn");
      ctx.gate.open("ma");
      const end = await stream.wait((e) => e.type === "harness" && e.subtype === "workflow_marker" && e.marker?.phase === "end", "end marker live");
      assert.deepEqual(withoutTime(end.marker), { phase: "end", runId: r.runId, taskId: r.taskId, name: "markers", status: "finished" });
      await ctx.waitForLog(chat.id, (l) => l.filter((m) => m.role === "meta").length === 2);
      await ctx.waitForIdle();
      const log = await json(`${base}/api/chats/${chat.id}/log`);
      assert.deepEqual(markers(log).map(withoutTime), [
        { phase: "start", runId: r.runId, taskId: r.taskId, name: "markers" },
        { phase: "end", runId: r.runId, taskId: r.taskId, name: "markers", status: "finished" },
      ]);
      // Between the markers: nothing. Afterwards: the completion notice (system message under user) and the follow-up turn.
      const iEnd = log.findLastIndex((m) => m.role === "workflow_marker");
      assert.deepEqual(log.slice(log.findIndex((m) => m.role === "workflow_marker") + 1, iEnd).map((m) => m.role), ["tool_result", "assistant", "meta"]);
      assert.ok(isCompletionNotice(log[iEnd + 1]?.text) && log[iEnd + 1].role === "user", "the completion notice follows the end marker");
      assert.deepEqual(log.slice(iEnd + 2).map((m) => m.role), ["assistant", "meta"]);
      // No row per agent: neither intermediate text nor tool nor answer of the workflow agents.
      assert.equal(log.filter((m) => m.role === "user").length, 2, "message + completion notice, no user row of the workflow");
      assert.deepEqual(log.filter((m) => m.role === "assistant").map((m) => m.text), ["Workflow started", "Notice read"]);
      assert.equal(log.filter((m) => m.role === "meta").length, 2, "one figure row per turn, none for the workflow");
      assert.equal(log.filter((m) => m.role !== "user" && /^work$|Finding/.test(m.text)).length, 0, "nothing from the workflow agent outside the completion notice");
      // Only through the stream barrier (quiet.mjs): what the server has sent up to NOW is counted — without it the line would
      // only check what the reader happened to have already, and a third marker in flight would slip through.
      await ctx.barrier(stream);
      assert.equal(stream.events.filter((e) => e.subtype === "workflow_marker").length, 2, "live exactly two markers");
    } finally { await stream.shutdown(); }
  }, { claude });
});

test("without ultracode mode and without keyword: the approval card, nothing starts", async () => {
  await withAgentsServer(async (ctx) => {
    const { chat, root } = ctx;
    const r = await startAt(ctx, chat.id, "o", { script: script("without", "return await agent('x {TAG:o}');") });
    assert.equal(r.status, "awaiting_approval", JSON.stringify(r));
    assert.deepEqual(store.dynRunsOpen(chat.id), []);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM dyn_workflow_runs").get().n, 0);
    assert.deepEqual(fs.readdirSync(workflowScripts(chat.id)), ["approvals"], "no run folder, only the job behind the card");
    await ctx.waitForIdle();
    assert.equal(fs.existsSync(path.join(root, "sub-start-o")), false, "no agent");
  }, { claude });
});

test("/stop ends only the turn, the workflow keeps running; cbase_dynamic_workflow_stop ends run and agent child without a notice", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    const r = await startAt(ctx, chat.id, "s", { script: script("stop", "return await agent('Wait {TAG:s} {GATE:s}');") }, { hold: true });
    assert.equal(r.status, "started", JSON.stringify(r));
    await ctx.gate.reached("main-s");
    await ctx.gate.reached("s");
    await post(`${base}/api/chats/${chat.id}/stop`, {});
    await waitForTruthy(async () => (await json(`${base}/api/runs/active`)).runs === 0, "Turn gestoppt");
    assert.equal(store.readDynRun(r.runId).status, "running", "/stop lets the workflow run");
    assert.equal(alive(subPid(root, "s")), true, "its agent is alive");
    // Stop through the tool route (the path of cbase_dynamic_workflow_stop), with the task id.
    const stop = await post(`${base}/api/chats/${chat.id}/dyn-workflows/stop`, { taskId: r.taskId });
    assert.equal(stop.status, "stopped");
    assert.equal(store.readDynRun(r.runId).status, "stopped");
    await waitForTruthy(() => !alive(subPid(root, "s")), "Agenten-Kind beendet");
    assert.deepEqual(dynWorkflowsOf(chat.id), []);
    await ctx.waitForIdle();
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    assert.equal(log.filter((m) => m.role === "user" && isCompletionNotice(m.text)).length, 0, "a stop through the tool reports nothing");
    assert.deepEqual(markers(log).map((m) => [m.phase, m.status]), [["start", undefined], ["end", "stopped"]], "the end marker carries the stop");
    // A second stop: no error, the run has already ended.
    assert.equal((await post(`${base}/api/chats/${chat.id}/dyn-workflows/stop`, { taskId: r.runId })).running, false);
  }, { claude });
});

test("archiving is blocked while the workflow runs (409, \"A dynamic workflow is running\"); deleting the chat and the workspace stops it with child and rows", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, ws, root } = ctx;
    await ultracodeOn(base, chat.id);
    const r = await startAt(ctx, chat.id, "l", { script: script("erase", "return await agent('Wait {TAG:l} {GATE:l}');") });
    await ctx.gate.reached("l");
    await waitForTruthy(async () => (await json(`${base}/api/runs/active`)).runs === 0, "turn ended");
    const arch = await fetch(`${base}/api/chats/${chat.id}/archive`, { method: "PUT", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify({ archived: true }) });
    const archBody = await arch.json();
    assert.equal(arch.status, 409, JSON.stringify(archBody));
    assert.match(JSON.stringify(archBody), /dynamischer Workflow läuft/);
    assert.equal(store.getChat(chat.id).archivedAt ?? null, null);
    await fetch(`${base}/api/chats/${chat.id}`, { method: "DELETE", headers: { Connection: "close" } }).then((x) => x.text());
    await waitForTruthy(() => !alive(subPid(root, "l")), "Agenten-Kind beendet");
    assert.deepEqual(dynWorkflowsOf(chat.id), []);
    assert.equal(store.readDynRun(r.runId), null, "the rows go with the chat");
    assert.equal(store.readDynJournal(r.runId).length, 0);
    // Deleting the workspace (a workspace of its own): the same closing path.
    const wsPath = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-dynwf-ws-"));
    try {
      const ws2 = await post(`${base}/api/workspaces`, { name: "Second", path: wsPath });
      const c2 = await post(`${base}/api/chats`, { workspaceId: ws2.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" });
      await json(`${base}/api/chats/${c2.id}`, { method: "PATCH", body: JSON.stringify({ title: "Second" }) });
      await ultracodeOn(base, c2.id);
      const r2 = await startAt(ctx, c2.id, "w", { script: script("ws", "return await agent('Wait {TAG:w} {GATE:w}');") });
      await ctx.gate.reached("w");
      await waitForTruthy(async () => (await json(`${base}/api/runs/active`)).runs === 0, "turn ended");
      await fetch(`${base}/api/workspaces/${ws2.id}`, { method: "DELETE", headers: { Connection: "close" } }).then((x) => x.text());
      await waitForTruthy(() => !alive(subPid(root, "w")), "Agenten-Kind beendet");
      assert.equal(store.readDynRun(r2.runId), null);
    } finally { fs.rmSync(wsPath, { recursive: true, force: true }); }
    assert.ok(ws.id);
  }, { claude });
});

test("safety net: a crashing agent child becomes null, the server keeps answering; after the server end no agent child lives, the run is interrupted", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    // The child crashes — that takes nothing from the server.
    const r = await startAt(ctx, chat.id, "f", { script: script("safety_net", "const a = await agent('Crash {TAG:f} {CRASH}');\nreturn { a };") });
    const end = await notMoreRunning(r.runId);
    assert.equal(end.status, "finished", end.error);
    assert.deepEqual(end.returnValue, { a: null });
    assert.deepEqual(store.readDynJournal(r.runId).map((e) => e.kind), ["launched", "started", "failed"]);
    await ctx.waitForLog(chat.id, (l) => l.some((m) => m.role === "user" && isCompletionNotice(m.text)));
    await ctx.waitForIdle();
    assert.equal((await json(`${base}/api/runs/active`)).busy, false, "the server answers");
    // Server end in the middle of the run: the child dies with it, the run is interrupted after the restart, busy is off.
    const r2 = await startAt(ctx, chat.id, "e", { script: script("serverEnd", "return await agent('Wait {TAG:e} {GATE:e}');") });
    await ctx.gate.reached("e");
    const pid = subPid(root, "e");
    await ctx.restart({ withBackground: true });
    await waitForTruthy(() => !alive(pid), "agent child ended with the server");
    assert.equal(store.readDynRun(r2.runId).status, "interrupted");
    const afterRestart = markers(await json(`${base}/api/chats/${chat.id}/log`));
    assert.deepEqual(afterRestart.filter((m) => m.runId === r2.runId).map((m) => [m.phase, m.status]), [["start", undefined], ["end", "interrupted"]], "Serverende: End-Marke „unterbrochen“ (Ticket 57)");
    assert.deepEqual(afterRestart.filter((m) => m.runId === r.runId).map((m) => m.status), [undefined, "finished"], "a crashing child is a null result, the run ends finished");
    assert.deepEqual(dynWorkflowsOf(chat.id), []);
    assert.equal((await json(`${base}/api/runs/active`)).busy, false);
  }, { claude });
});

test("time limit per section: a loop after the first wait ends the run with the limit in the text — a second chat answers anyway", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, ws } = ctx;
    await ultracodeOn(base, chat.id);
    const second = await post(`${base}/api/chats`, { workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" });
    await json(`${base}/api/chats/${second.id}`, { method: "PATCH", body: JSON.stringify({ title: "Second" }) });
    const r = await startAt(ctx, chat.id, "z", { script: script("loop", "await agent('Short {TAG:z} {GATE:z}');\nfor (;;) {}") });
    await ctx.gate.reached("z");
    ctx.gate.open("z");
    // The second chat gets its answer — at the latest once the limit has ended the loop.
    await post(`${base}/api/chats/${second.id}/message`, { text: "Hello second chat" });
    await ctx.waitForLog(second.id, (l) => l.some((m) => m.role === "assistant" && /Reply to Hello/.test(m.text)));
    const end = await notMoreRunning(r.runId);
    assert.equal(end.status, "failed");
    const limit = Number(process.env.CBASE_DYNWF_SECTION_MS) || 30000;
    assert.equal(end.error, deadlineText(limit));
    const log = await ctx.waitForLog(chat.id, (l) => l.some((m) => m.role === "user" && isCompletionNotice(m.text)));
    const notice = log.find((m) => m.role === "user" && isCompletionNotice(m.text)).text;
    assert.match(notice, /<status>failed<\/status>/);
    assert.match(notice, new RegExp(`more than ${limit} ms`));
    await ctx.waitForIdle();
  }, { claude });
});

// agent() no longer throws at the gate: with auto-continue the agent WAITS (dynworkflows-limits.test.js), without it returns
// null, and log() names it — here the second case.
test("every agent asks the credit gate: a refused gate starts no agent, without auto-continue agent() returns null and log() names it; journal launched → failed", async () => {
  await withoutAccount(() => withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    seedFullSession();
    await gate(base, false);
    await json(`${base}/api/auto-continue`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
    await ultracodeOn(base, chat.id);
    const r = await startAt(ctx, chat.id, "g", { script: script("gate", "const a = await agent('First {TAG:ga} {GATE:ga}');\nlet b;\ntry { b = await agent('Then {TAG:gb}', { label: 'then' }); } catch (e) { b = 'rejected: ' + e.message; }\nreturn { a, b };") });
    await ctx.gate.reached("ga");
    await gate(base, true);
    ctx.gate.open("ga");
    const end = await notMoreRunning(r.runId);
    assert.equal(end.status, "finished", end.error);
    assert.equal(end.returnValue.a, "Finding ga");
    assert.equal(end.returnValue.b, null, "at the gate without auto-continue: null, no throw");
    const logs = store.readDynEvents(r.runId).filter((e) => e.kind === "log").map((e) => e.text);
    assert.ok(logs.some((t) => t.includes("“then”") && /returned null/.test(t) && /credit gate/.test(t)), JSON.stringify(logs));
    assert.equal(fs.existsSync(path.join(root, "sub-start-gb")), false, "no child for the second agent");
    assert.deepEqual(store.readDynJournal(r.runId).filter((e) => e.n === 2).map((e) => e.kind), ["launched", "failed"]);
    // The completion notice wakes the chat — a turn at the gate waits in its row; gate off and release.
    await gate(base, false);
    await waitForTruthy(async () => {
      if (notices(root).length) return true;
      if ((await json(`${base}/api/chats/${chat.id}/auto-continue`)).wait) {
        await json(`${base}/api/chats/${chat.id}/auto-continue/now`, { method: "POST", body: JSON.stringify({ anyway: true }) }).catch(() => {});
      }
      return false;
    }, "completion notice at the main agent");
    await ctx.waitForIdle();
    await json(`${base}/api/auto-continue`, { method: "PUT", body: JSON.stringify({ enabled: true }) });
  }, { claude }));
});

// Without an account (model: agent-credit-gate.test.js): otherwise the utilization would come from the developer's REAL account.
async function withoutAccount(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-dynwf-account-"));
  const prior = { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  try {
    const shim = path.join(root, "shim");
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, "security"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    for (const d of ["home", "codex-home"]) fs.mkdirSync(path.join(root, d));
    process.env.HOME = path.join(root, "home");
    process.env.CODEX_HOME = path.join(root, "codex-home");
    process.env.PATH = `${shim}:${process.env.PATH}`;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { console.warn(`cleaning up ${root}: ${e.code || e.message}`); }
  }
}
// Session window 100 %, measured now, reset in one hour (field names as in fetchUsageLimits).
function seedFullSession() {
  const at = Date.now();
  const iso = new Date(at + 3_600_000).toISOString();
  store.setSetting("usage_cache_v1", JSON.stringify({
    fiveHour: { utilization: 100, resetsAt: iso }, sevenDay: { utilization: 4, resetsAt: null },
    limits: [{ kind: "session", group: "session", percent: 100, resets_at: iso }, { kind: "weekly", group: "weekly", percent: 4, resets_at: null }],
    at,
  }));
}
const gate = (base, on) => json(`${base}/api/credit-gate`, { method: "PUT", body: JSON.stringify({ enabled: on }) });

// An unhandled rejection in the script. The server runs here as its own PROCESS (kind): without the sandbox's catcher it
// dies of it — with it the run ends as failed, and the server keeps answering.
// Counter-test: the catcher registers nothing => the server process dies, the test falls.
test("unhandled rejection in the script: the run fails with the error text, the server process lives on", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat } = ctx;
    await ultracodeOn(base, chat.id);
    const r = await startAt(ctx, chat.id, "u", { script: script("rejection", "Promise.reject(new Error('boom in the script'));\nreturn await agent('Wait {TAG:u} {GATE:u}');") });
    assert.equal(r.status, "started", JSON.stringify(r));
    const log = await ctx.waitForLog(chat.id, (l) => l.some((m) => m.role === "user" && isCompletionNotice(m.text)));
    const notice = log.find((m) => m.role === "user" && isCompletionNotice(m.text)).text;
    assert.match(notice, /<status>failed<\/status>/);
    assert.match(notice, /boom in the script/);
    assert.deepEqual(markers(log).map((m) => [m.phase, m.status]), [["start", undefined], ["end", "failed"]], "end marker \"failed\" before the completion notice");
    await ctx.waitForIdle();
    assert.equal((await json(`${base}/api/runs/active`)).busy, false, "the server process answers");
    // Read from the server process's database; if it is writing right now (history of the woken turn), it is briefly locked —
    // then read again instead of reporting a failure.
    const status = await waitForTruthy(() => {
      const reader = ctx.db();
      try { return reader.prepare("SELECT status FROM dyn_workflow_runs WHERE id = ?").get(r.runId).status; }
      catch (e) { if (/database is locked/.test(e?.message)) return null; throw e; }
      finally { reader.close(); }
    }, "run row readable");
    assert.equal(status, "failed");
  }, { claude, childProcess: true });
});

// A throw in run() AFTER the end of the script — here the database refuses the ending with "finished" (trigger; in operation:
// disk full, locked file, a delivery that itself throws). The safety net used to end the run as "failed", set the end
// marker — and delivered NO completion notice: the agent had read at the start "end your turn, the result comes as
// <task-notification>" and waited forever. Now exactly ONE "failed" notice goes out. No hang on the old code: the turn is over
// before the agent leaves its gate — so the delivery begins a NEW turn and writes the user row in the same synchronous
// step as the ending; it is read after the run's end.
// Counter-test: without the completion notice in the safety net there is no notice in the history, the test falls.
test("a throw in run() after the script's end: the run ends failed AND the chat gets exactly one completion notice \"failed\"", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    db.exec("CREATE TRIGGER disk_full_trigger BEFORE UPDATE OF status ON dyn_workflow_runs WHEN NEW.status = 'finished' BEGIN SELECT RAISE(ABORT, 'Disk full (test)'); END;");
    try {
      const r = await startAt(ctx, chat.id, "n39", { script: script("disk", "const a = await agent('Read {TAG:n39} {GATE:n39}');\nreturn { a };") });
      assert.equal(r.status, "started", JSON.stringify(r));
      await ctx.gate.reached("n39");
      await waitForTruthy(async () => (await json(`${base}/api/runs/active`)).runs === 0, "turn ended");
      ctx.gate.open("n39");
      const end = await notMoreRunning(r.runId);
      assert.equal(end.status, "failed");
      assert.match(end.error, /Disk full \(test\)/);
      const log = await json(`${base}/api/chats/${chat.id}/log`);
      const inLog = log.filter((m) => m.role === "user" && isCompletionNotice(m.text));
      assert.equal(inLog.length, 1, "exactly one completion notice (before: none — the chat waited forever)");
      assert.match(inLog[0].text, new RegExp(`<task-id>${r.taskId}</task-id>`));
      assert.match(inLog[0].text, /<status>failed<\/status>/);
      assert.match(inLog[0].text, /Disk full \(test\)/);
      assert.deepEqual(markers(log).map((m) => [m.phase, m.status]), [["start", undefined], ["end", "failed"]], "exactly one end marker, before the notice");
      const output = /<output-file>([^<]+)<\/output-file>/.exec(inLog[0].text)[1];
      assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).status, "failed");
      await ctx.waitForIdle();
      assert.equal(notices(root).length, 1, "the main agent reads it exactly once");
    } finally { db.exec("DROP TRIGGER IF EXISTS disk_full_trigger"); }
  }, { claude });
});

// A continuation after the restart whose COMPLETION throws — here the database refuses the ending with "finished" (as above),
// so BEFORE the end marker. The safety net `resumptionFailed` took the run out of `active` but never reported `open: false` to
// the global stream: whoever had seen the start (`run` reports it open) kept the chat list's working icon until reload. It
// waits for the error row (it comes AFTER the report), then through the stream barrier — no deadline; without the report the
// test is red, not hanging.
test("resumption: a continuation whose completion throws — the global stream reports the run closed (dyn_workflow open:false)", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    const r = await startAt(ctx, chat.id, "fw", { script: script("resumption", "return await agent('Wait {TAG:fw} {GATE:fw}');") });
    assert.equal(r.status, "started", JSON.stringify(r));
    await ctx.gate.reached("fw");
    await ctx.restart({ withBackground: true });
    assert.equal(store.readDynRun(r.runId).status, "interrupted");
    fs.rmSync(path.join(root, "gates", "fw.waiting")); // the second arrival at the gate (the agent runs anew in the continuation)
    db.exec("CREATE TRIGGER completion_trigger BEFORE UPDATE OF status ON dyn_workflow_runs WHEN NEW.status = 'finished' BEGIN SELECT RAISE(ABORT, 'Completion throws (test)'); END;");
    const stream = await openStream(`${base}/api/events`);
    try {
      await stream.wait((e) => e.type === "init", "initial state of the global stream");
      await fireHooks("restartGrace", {});
      assert.equal(store.readDynRun(r.runId).status, "running", "the restart continues");
      await ctx.gate.reached("fw");
      ctx.gate.open("fw");
      await ctx.waitForLog(chat.id, (l) => l.some((m) => m.role === "hint" && m.text.includes(r.runId)));
      assert.equal(store.readDynRun(r.runId).status, "interrupted", "the continuation safety net has taken hold");
      await ctx.barrier(stream, GLOBAL);
      const notices = stream.events.filter((e) => e.type === "dyn_workflow" && e.runId === r.runId).map((e) => [e.chatId, e.open]);
      assert.deepEqual(notices, [[chat.id, true], [chat.id, false]], "reported open, then closed — exactly once");
      assert.deepEqual((await globalInit(base)).dynWorkflows, [], "and a new initial state does not name it");
    } finally {
      await stream.shutdown();
      db.exec("DROP TRIGGER IF EXISTS completion_trigger");
    }
  }, { claude });
});
