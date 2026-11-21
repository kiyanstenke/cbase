// The "+500k" budget of a turn (server/backend/electron/server/dynworkflows/budget.js, runs/turn-output.js, run.js). Main seam
// with the harness of agent-harness.mjs: real server, real cbase MCP server, real routes, real agent core; only the providers are
// faked, with FIXED output numbers: the main agent reports "HAUPTOUT:<n>" as message_delta of its main stream, a workflow agent
// "{OUT:<n>}"/"{IN:<n>}" as usage.
//
// COUNTER-TESTS (each turns the named test red):
//   - removing the count of the main run (`countMainOutput` in runs/do-run.js) turns "budget reached" red (the pot stands at
//     270,000, `agent()` does not throw, d starts);
//   - the budget-in-turn reading the raw history (the last user row) instead of the completion-notice reading turns "channel,
//     schedule, event, completion notice" red;
//   - removing the base value taken before the restart (run.js resume) turns "restart" red (r3 runs).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, fakeCodex, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { FINISHED_MARKER } from "../electron/server/runs/completionNotice.js";
import { fireHooks } from "../electron/server/runs/hooks.js";
import { deliverUserPrompt } from "../electron/server/runs/queue.js";
import { budgetFromText } from "../electron/server/dynworkflows/budget.js";
import * as store from "../electron/server/store.js";

// ── The recogniser alone ─────────────────────────────────────────────────────────────────────────────────────────
test("recogniser: \"+500k\" as a word of its own (k/m/b, decimals), \"use/spend 2M tokens\" like the original; the last statement wins", () => {
  const cases = [
    ["+500k", 500_000], ["please +500k", 500_000], ["+500K.", 500_000], ["(+2m)", null], ["+1.5m please", 1_500_000], ["+2b", 2_000_000_000],
    ["+500 k", 500_000], ["use 2M tokens", 2_000_000], ["spend 500k tokens", 500_000], ["Use 1.5m token", 1_500_000],
    ["+100k and then after all +200k", 200_000], ["use 1m tokens, +300k", 300_000],
    ["a+500k", null], ["+500kb", null], ["+500", null], ["500k", null], ["+0k", null], ["", null], [null, null],
  ];
  for (const [text, desired] of cases) assert.equal(budgetFromText(text), desired, `${JSON.stringify(text)} ⇒ ${desired}`);
});

// The main agent: "HALT:x" first holds it at gate x; "HAUPTOUT:<n>" reports n output tokens in the main stream (message_delta);
// "WF[<tag>]:{json}:FW" calls cbase_dynamic_workflow and stores the tool result under wf-<tag>. Every completion/system
// notice it stores in notices.jsonl.
const MAIN = `
  const gateName = (String(text).match(/HALT:(\\w+)/) || [])[1];
  if (gateName) await gate(gateName);
  const out = (String(text).match(/HAUPTOUT:(\\d+)/) || [])[1];
  if (out) say({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: Number(out) } } });
  if (text.includes("<task-notification>")) fs.appendFileSync(path.join(LOCATION, "notices.jsonl"), JSON.stringify({ text }) + "\\n");
  if (text.includes("WF[")) {
    const i = text.indexOf("WF[");
    const tag = text.slice(i + 3, text.indexOf("]:", i));
    const args = JSON.parse(text.slice(text.indexOf("]:", i) + 2, text.indexOf(":FW", i)));
    const id = "toolu_wf_" + tag;
    say({ type: "assistant", message: { id: "a-" + tag, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_dynamic_workflow", input: args }] } });
    let t = "";
    try { const r = await mcpCall("cbase_dynamic_workflow", args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    { const z = path.join(LOCATION, "wf-" + tag); fs.writeFileSync(z + ".teil", t); fs.renameSync(z + ".teil", z); } // atomic: the test waits only for the existence
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  say({ type: "assistant", message: { id: "c-" + Date.now(), content: [{ type: "text", text: "ok" }] } });
  finished();
  say({ type: "result", result: "ok", session_id: "main-session" });`;
// A workflow agent: {TAG:x} names it, {GATE:x} holds it at gate x, {OUT:n}/{IN:n} are its tokens.
const SUB = `
    const ab = text.lastIndexOf("Here is the task:");
    const job = ab >= 0 ? text.slice(ab) : text;
    const field = (k, v) => (job.includes("{" + k + ":") ? job.split("{" + k + ":")[1].split("}")[0] : v);
    const tag = field("TAG", "x");
    fs.appendFileSync(path.join(LOCATION, "sub-start-" + tag), "x");
    if (job.includes("{GATE:")) await gate(field("GATE", ""));
    say({ type: "assistant", message: { id: "s-" + tag + "-" + fs.readFileSync(path.join(LOCATION, "sub-start-" + tag), "utf8").length, usage: { input_tokens: Number(field("IN", "1")), output_tokens: Number(field("OUT", "1")) }, content: [{ type: "text", text: "Finding " + tag }] } });
    finished();
    say({ type: "result", result: "Finding " + tag, session_id: "sub-" + tag });`;
const claude = fakeClaude({ main: MAIN, sub: SUB });

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const ultracodeOn = (base, chatId) => json(`${base}/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
const script = (name, body) => `export const meta = { name: '${name}', description: 'Budget', phases: [{ title: 'One' }] }\n${body}\n`;
const wf = (tag, args) => `WF[${tag}]:${JSON.stringify(args)}:FW`;
const send = (base, chatId, text) => post(`${base}/api/chats/${chatId}/message`, { text });
async function result(root, tag) {
  const file = path.join(root, `wf-${tag}`);
  await waitForTruthy(() => fs.existsSync(file), `tool result ${tag}`);
  const t = fs.readFileSync(file, "utf8");
  return t.startsWith("ERROR ") ? { error: t } : JSON.parse(t);
}
const toEnd = (runId) => waitForTruthy(() => (store.readDynRun(runId)?.status !== "running" ? store.readDynRun(runId) : null), `run ${runId} finished`);
const started = (root, tag) => fs.existsSync(path.join(root, `sub-start-${tag}`));
// A script that only returns its budget.
const TARGET = "return { total: budget.total, unlimited: budget.remaining() === Infinity };";

test("cause: \"+500k\" from the human sets budget.total = 500,000: directly, bundled at the turn transition, in the steering run; without a statement no upper limit", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, gate, waitForIdle } = ctx;
    await ultracodeOn(base, chat.id);
    const total = async (tag) => { const r = await result(root, tag); assert.equal(r.status, "started", JSON.stringify(r)); return (await toEnd(r.runId)).returnValue; };

    await send(base, chat.id, `Please thoroughly +500k ${wf("d", { script: script("direct", TARGET) })}`);
    assert.deepEqual(await total("d"), { total: 500_000, unlimited: false });
    await waitForIdle();

    await send(base, chat.id, wf("o", { script: script("without", TARGET) }));
    assert.deepEqual(await total("o"), { total: null, unlimited: true }, "without a statement: budget.total null, remaining() Infinity");
    await waitForIdle();

    // Injected into the SAME process at the turn transition: the budget is in the first of two queued messages.
    await send(base, chat.id, "Preliminary HALT:v");
    await gate.reached("v");
    const two = await send(base, chat.id, "And then +500k.");
    const three = await send(base, chat.id, wf("b", { script: script("bundle", TARGET) }));
    assert.equal(two.queued && three.queued, true, "both wait behind the running turn");
    gate.open("v");
    assert.deepEqual(await total("b"), { total: 500_000, unlimited: false });
    await waitForIdle();

    // Steering: the bundle becomes a NEW run.
    await send(base, chat.id, "Second preliminary HALT:w");
    await gate.reached("w");
    await send(base, chat.id, "+500k please");
    await send(base, chat.id, wf("s", { script: script("control", TARGET) }));
    const st = await post(`${base}/api/chats/${chat.id}/control`, {});
    assert.equal(st.sent, 2, JSON.stringify(st));
    assert.deepEqual(await total("s"), { total: 500_000, unlimited: false });
    gate.open("w");
    await waitForIdle();
  }, { claude });
});

test("cause: \"+500k\" in a channel, schedule, event message or completion notice sets nothing", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, waitForIdle } = ctx;
    await ultracodeOn(base, chat.id);
    for (const [tag, cause] of [["k", "channel"], ["z", "schedule"], ["e", "event"], ["f", "agent"]]) {
      const text = `${cause === "agent" ? FINISHED_MARKER : ""}Please +500k. ${wf(tag, { script: script(`from-${cause}`, TARGET) })}`;
      deliverUserPrompt(store.getChat(chat.id), { prompt: text, display: text, cause });
      const r = await result(root, tag);
      assert.equal(r.status, "started", `${cause}: ${JSON.stringify(r)}`);
      assert.deepEqual((await toEnd(r.runId)).returnValue, { total: null, unlimited: true }, `${cause} sets no budget`);
      await waitForIdle();
    }
  }, { claude });
});

test("budget reached: main run + agents of the turn together; running agents finish, the dropped pipeline/parallel slot is noted in the run, every further agent() throws", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, gate, waitForIdle } = ctx;
    await ultracodeOn(base, chat.id);
    // Main run 300,000, a 250,000 => 550,000 >= 500,000 while b and c still run. Without the main run the pot would stand
    // at 270,000 and d would run.
    const body = [
      "const r = await parallel([",
      "  () => agent('x {TAG:a}{OUT:250000}'),",
      "  () => agent('x {TAG:b}{OUT:10000}{GATE:b}'),",
      "  () => agent('x {TAG:c}{OUT:10000}{GATE:c}').then(() => agent('x {TAG:d}{OUT:10000}')),",
      "]);",
      "let thrown = null;",
      "try { await agent('x {TAG:e}'); } catch (e) { thrown = e.name + ': ' + e.message; }",
      "return { r, thrown, spent: budget.spent(), total: budget.total };",
    ].join("\n");
    await send(base, chat.id, `+500k HAUPTOUT:300000 ${wf("a", { script: script("budget", body) })}`);
    const r = await result(root, "a");
    assert.equal(r.status, "started", JSON.stringify(r));
    await waitForTruthy(() => store.readDynJournal(r.runId).some((e) => e.kind === "result" && e.n === 1), "a is done");
    await gate.reached("b");
    await gate.reached("c");
    gate.open("b");
    gate.open("c");
    const end = await toEnd(r.runId);
    assert.equal(end.status, "finished", end.error);
    assert.deepEqual(end.returnValue.r, ["Finding a", "Finding b", null], "b ran to the end and keeps its result; the slot of c is dropped");
    assert.equal(end.returnValue.spent, 570_000, "300,000 main run + 250,000 + 10,000 + 10,000");
    assert.equal(end.returnValue.total, 500_000);
    assert.match(String(end.returnValue.thrown), /^WorkflowBudgetExceededError: Workflow token budget exceeded \(570,000 \/ 500,000 output tokens\)/);
    assert.equal(started(root, "d"), false, "d never started");
    assert.equal(started(root, "e"), false, "e never started");
    // The note is in the run, not silent: as a failure in its events (the tree) and in the output file.
    const note = "parallel: 1 slot dropped — token budget exceeded";
    assert.ok(store.readDynEvents(r.runId).some((e) => e.kind === "failure" && e.text === note), JSON.stringify(store.readDynEvents(r.runId)));
    assert.ok(JSON.parse(fs.readFileSync(end.outputPath, "utf8")).failures.includes(note));
    assert.equal(end.budgetTotal, 500_000);
    assert.equal(end.budgetConsumed, 570_000, "the state of the pot is on the run (restart)");
    await waitForIdle();
  }, { claude });
});

test("Codex agent: its reported consumption is a LOWER BOUND, it still counts against the budget", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, waitForIdle } = ctx;
    await ultracodeOn(base, chat.id);
    // "+1k", main run 996, the Codex agent reports 4 output tokens (fakeCodex: turn.completed) => 1,000; the next one throws.
    const body = [
      "const a = await agent('x {TAG:cx}', { model: 'codex::gpt-5.6-sol' });",
      "let thrown = null;",
      "try { await agent('x {TAG:after}'); } catch (e) { thrown = e.name; }",
      "return { a, thrown, spent: budget.spent() };",
    ].join("\n");
    await send(base, chat.id, `+1k HAUPTOUT:996 ${wf("c", { script: script("codex", body) })}`);
    const r = await result(root, "c");
    assert.equal(r.status, "started", JSON.stringify(r));
    const end = await toEnd(r.runId);
    assert.equal(end.status, "finished", end.error);
    assert.deepEqual(end.returnValue, { a: "Codex-Befund 42", thrown: "WorkflowBudgetExceededError", spent: 1000 });
    assert.equal(started(root, "after"), false);
    await waitForIdle();
  }, { claude, codex: fakeCodex() });
});

test("approval card: the budget of the turn travels along; accepted, the workflow runs with budget.total from the message", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, waitForIdle } = ctx;
    await send(base, chat.id, `+2m ${wf("k", { script: script("card", TARGET) })}`);
    const k = await result(root, "k");
    assert.equal(k.status, "awaiting_approval", JSON.stringify(k));
    await waitForIdle();
    const turnedOn = await post(`${base}/api/chats/${chat.id}/dyn-workflows/approval`, { requestId: k.requestId, decision: "accept" });
    assert.match(turnedOn.runId, /^wf_/, JSON.stringify(turnedOn));
    assert.deepEqual((await toEnd(turnedOn.runId)).returnValue, { total: 2_000_000, unlimited: false });
    await waitForIdle();
  }, { claude });
});

test("restart: a resumed run keeps its upper limit and the consumed state", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    const body = [
      "await agent('x {TAG:r1}{OUT:150000}');",
      "await agent('x {TAG:r2}{OUT:100000}{GATE:r2}');",
      "try { await agent('x {TAG:r3}'); } catch (e) { return e.name; }",
      "return 'r3 ran';",
    ].join("\n");
    await send(base, chat.id, `+500k HAUPTOUT:300000 ${wf("n", { script: script("restartGrace", body) })}`);
    const r = await result(root, "n");
    assert.equal(r.status, "started", JSON.stringify(r));
    await ctx.gate.reached("r2");
    assert.equal(store.readDynRun(r.runId).budgetConsumed, 450_000, "300,000 main run + 150,000 (r1)");
    await ctx.restart({ withBackground: true });
    await fireHooks("restartGrace", {});
    assert.equal(store.readDynRun(r.runId).status, "running", "resumed");
    ctx.gate.open("r2");
    const end = await toEnd(r.runId);
    assert.equal(end.status, "finished", end.error);
    assert.equal(end.returnValue, "WorkflowBudgetExceededError", "450,000 from the first server run + 100,000 (r2, run again) >= 500,000: r3 throws");
    assert.equal(started(root, "r3"), false);
    await ctx.waitForIdle();
  }, { claude });
});
