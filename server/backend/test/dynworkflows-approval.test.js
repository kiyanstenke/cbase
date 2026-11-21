// Opt-in and approval card of a dynamic workflow (server/backend/electron/server/dynworkflows/approval.js and run.js
// decideApproval). Main seam with the harness of agent-harness.mjs: real server, real cbase MCP server, real routes, real
// agent core; only the providers are faked. No chat here is in Ultracode mode: the opt-in comes from the keyword or the
// card alone.
//
// COUNTER-TESTS (each turns the named test red):
//   - the recogniser reads the RAW history (the last user row) instead of the reading of the completion-notice detection
//     => "channel, schedule, event, completion notice" starts a run;
//   - removing the keyword-in-turn check in run.js (only the mode counts) turns "keyword" and "bundle" red;
//   - removing the decide-once check (`k.ruling`) in decideApproval makes "accept" start a second run on the second click.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import { FINISHED_MARKER, isCompletionNotice } from "../electron/server/runs/completionNotice.js";
import { deliverUserPrompt } from "../electron/server/runs/queue.js";
import { carriesKeyword } from "../electron/server/dynworkflows/approval.js";
import * as store from "../electron/server/store.js";
import { db } from "../electron/server/store/db.js";

// ── The recogniser alone: the cases of the original (Claude Code, `dm(e, "ultracode")`) ───────────────────
test("recogniser: whole word, any spelling; not after a leading /, not in a quote, bracket or tag", () => {
  const cases = [
    ["ultracode", true], ["UltraCode", true], ["please ultracode.", true], ["do it with ultracode, thanks", true],
    // A tag before and after masks only itself: measured on the function in the binary (the original is authoritative).
    ["<x>ultracode</x>", true],
    ["/ultracode", false], ["/effort ultracode", false], ['"ultracode"', false], ["'ultracode'", false], ["`ultracode`", false],
    ["(ultracode)", false], ["[ultracode]", false], ["{ultracode}", false], ["<ultracode>", false], ["<x ultracode>", false],
    ["ultracodes", false], ["superultracode", false], ["ultra-code", false], ["ultracode?", false], ["pre-ultracode", false],
    ["a/ultracode", false], ["ultracode.md", false], ["", false], [null, false],
  ];
  for (const [text, desired] of cases) assert.equal(carriesKeyword(text), desired, `${JSON.stringify(text)} ⇒ ${desired}`);
});

// The main agent: "GATE:x" first holds it at gate x; "WF[<tag>]:{json}:FW" calls cbase_dynamic_workflow with these arguments
// and stores the tool result under wf-<tag>; "{AGAIN}" in a completion notice (from a workflow result) calls it again with
// the script "again". Every completion/system notice it stores in notices.jsonl.
const AGAIN = { script: "export const meta = { name: 'again', description: 'Second run', phases: [{ title: 'Read' }] }\nreturn await agent('x {TAG:n}');\n" };
const MAIN = `
  const gateName = (String(text).match(/GATE:(\\w+)/) || [])[1];
  if (gateName) await gate(gateName);
  // "includes", not "startsWith": a silent hint (e.g. the one of accepting) stands BEFORE the input.
  const notice = text.includes("<task-notification>");
  if (notice) fs.appendFileSync(path.join(LOCATION, "notices.jsonl"), JSON.stringify({ text }) + "\\n");
  let tag = "", args = null;
  if (notice && text.includes("{AGAIN}")) { tag = "n"; args = ${JSON.stringify(AGAIN)}; }
  else if (text.includes("WF[")) {
    const i = text.indexOf("WF[");
    tag = text.slice(i + 3, text.indexOf("]:", i));
    args = JSON.parse(text.slice(text.indexOf("]:", i) + 2, text.indexOf(":FW", i)));
  }
  if (tag) {
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
// A workflow agent: reports "Finding <tag>" and stores its start.
const SUB = `
    const ab = text.lastIndexOf("Here is the task:");
    const job = ab >= 0 ? text.slice(ab) : text;
    const tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : "x";
    fs.appendFileSync(path.join(LOCATION, "sub-start-" + tag), "x");
    say({ type: "assistant", message: { id: "s-" + tag, content: [{ type: "text", text: "Finding " + tag }] } });
    finished();
    say({ type: "result", result: "Finding " + tag, session_id: "sub-" + tag });`;
const claude = fakeClaude({ main: MAIN, sub: SUB });

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const script = (name, body) => `export const meta = { name: '${name}', description: 'Description of ${name}', phases: [{ title: 'Read', detail: 'read first' }, { title: 'Write' }] }\n${body}\n`;
const wf = (tag, args) => `WF[${tag}]:${JSON.stringify(args)}:FW`;
const send = (base, chatId, text) => post(`${base}/api/chats/${chatId}/message`, { text });
async function result(root, tag) {
  const file = path.join(root, `wf-${tag}`);
  await waitForTruthy(() => fs.existsSync(file), `tool result ${tag}`);
  const t = fs.readFileSync(file, "utf8");
  return t.startsWith("ERROR ") ? { error: t } : JSON.parse(t);
}
// The fakes (child processes) write the logs while the test reads: only completed lines (jsonl.mjs).
const notices = (root) => readJsonl(path.join(root, "notices.jsonl")).map((z) => z.text);
const runCount = () => db.prepare("SELECT COUNT(*) n FROM dyn_workflow_runs").get().n;
const rows = (chatId, role) => store.listMessages(chatId).filter((m) => m.role === role).map((m) => JSON.parse(m.text));
// The route answer with status (json() of the harness does not throw but returns the body; both are needed here).
async function decide(base, chatId, body) {
  const res = await fetch(`${base}/api/chats/${chatId}/dyn-workflows/approval`, {
    method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("keyword: \"ultracode\" in the message opens the start in this turn; the follow-up turn of the completion notice (word in the result) gets the card", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    assert.equal(store.getChat(chat.id).ultracode, false, "the chat is NOT in Ultracode mode");
    await send(base, chat.id, `Please with ultracode: ${wf("a", { script: script("first", "await agent('x {TAG:a}');\nreturn 'ultracode {AGAIN}';") })}`);
    const r = await result(root, "a");
    assert.equal(r.status, "started", JSON.stringify(r));
    // The run ends, the completion notice carries "ultracode {AGAIN}" in the result; its turn calls the tool again.
    const n = await result(root, "n");
    assert.equal(n.status, "awaiting_approval", `the turn of a completion notice is no opt-in: ${JSON.stringify(n)}`);
    assert.ok(notices(root).some((t) => t.includes("ultracode {AGAIN}")), "the completion notice carried the word");
    assert.equal(runCount(), 1, "only the first run");
    assert.deepEqual(rows(chat.id, "workflow_approval").map((k) => k.name), ["again"]);
    assert.equal(fs.existsSync(path.join(root, "sub-start-n")), false, "no agent of the second");
  }, { claude });
});

test("bundle: the word in a queued message opens the start in the injected turn, and in the steering run", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, gate, waitForIdle } = ctx;
    // Injected into the SAME process at the turn transition: two messages, the word is in the first.
    await send(base, chat.id, "Preliminary GATE:v");
    await gate.reached("v");
    const two = await send(base, chat.id, "And then please ultracode.");
    const three = await send(base, chat.id, wf("b", { script: script("bundle", "return await agent('x {TAG:b}');") }));
    assert.equal(two.queued && three.queued, true, "both wait behind the running turn");
    gate.open("v");
    assert.equal((await result(root, "b")).status, "started");
    await waitForIdle();
    // Steering: the bundle becomes a NEW run.
    await send(base, chat.id, "Second preliminary GATE:w");
    await gate.reached("w");
    await send(base, chat.id, "ULTRACODE please");
    await send(base, chat.id, wf("s", { script: script("control", "return await agent('x {TAG:s}');") }));
    const st = await post(`${base}/api/chats/${chat.id}/control`, {});
    assert.equal(st.sent, 2, JSON.stringify(st));
    assert.equal((await result(root, "s")).status, "started");
    gate.open("w");
    await waitForIdle();
    assert.equal(rows(chat.id, "workflow_approval").length, 0, "no card");
  }, { claude });
});

test("channel, schedule, event, completion notice with the word never open: the card appears", async () => {
  await withAgentsServer(async (ctx) => {
    const { chat, root, waitForIdle } = ctx;
    for (const [tag, cause] of [["k", "channel"], ["z", "schedule"], ["e", "event"], ["f", "agent"]]) {
      const text = `${cause === "agent" ? FINISHED_MARKER : ""}Please ultracode. ${wf(tag, { script: script(`from-${cause}`, `return await agent('x {TAG:${tag}}');`) })}`;
      deliverUserPrompt(store.getChat(chat.id), { prompt: text, display: text, cause });
      const r = await result(root, tag);
      assert.equal(r.status, "awaiting_approval", `${cause}: ${JSON.stringify(r)}`);
      await waitForIdle();
    }
    assert.equal(runCount(), 0, "no run");
    assert.deepEqual(rows(chat.id, "workflow_approval").map((k) => k.name), ["from-channel", "from-schedule", "from-event", "from-agent"]);
    for (const tag of ["k", "z", "e", "f"]) assert.equal(fs.existsSync(path.join(root, `sub-start-${tag}`)), false, `no agent (${tag})`);
  }, { claude });
});

test("card: at once \"awaiting_approval\", no script, no agent, no open turn; survives the restart; accepting starts exactly once, rejecting reports as a system notice", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, waitForIdle } = ctx;
    await send(base, chat.id, wf("c", { script: script("card", "return await agent('x {TAG:c}');"), args: { list: [1, 2] } }));
    const r = await result(root, "c");
    assert.equal(r.status, "awaiting_approval", JSON.stringify(r));
    assert.match(r.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(r.runId, undefined, "no run id");
    await waitForIdle();
    const active = await json(`${base}/api/runs/active`);
    assert.deepEqual([active.busy, active.runs, active.approvals, active.dynWorkflows], [false, 0, [], []], "the card holds no turn and is no waiting approval");
    assert.equal(runCount(), 0, "no run created");
    assert.equal(fs.existsSync(path.join(root, "sub-start-c")), false, "no agent");
    const [card] = rows(chat.id, "workflow_approval");
    assert.equal(card.requestId, r.requestId);
    assert.deepEqual([card.name, card.description, card.phases], ["card", "Description of card", [{ title: "Read", detail: "read first" }, { title: "Write" }]]);

    // The route demands its fields.
    for (const body of [{ requestId: r.requestId }, { decision: "accept" }, { requestId: r.requestId, decision: "maybe" }, { requestId: r.requestId, decision: "constructor" }]) {
      const x = await decide(base, chat.id, body);
      assert.equal(x.status, 400, `${JSON.stringify(body)} ⇒ 400: ${JSON.stringify(x.body)}`);
    }
    assert.equal((await decide(base, chat.id, { requestId: "00000000-0000-0000-0000-000000000000", decision: "accept" })).status, 404);

    // The card lives in the history: after the restart it is still open and starts on accepting.
    await ctx.restart();
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    assert.equal(log.filter((m) => m.role === "workflow_approval").length, 1, "the card is in the history after the restart");
    const turnedOn = await decide(base, chat.id, { requestId: r.requestId, decision: "accept" });
    assert.equal(turnedOn.status, 200, JSON.stringify(turnedOn.body));
    assert.equal(turnedOn.body.decision, "accepted");
    assert.match(turnedOn.body.runId, /^wf_/);
    const second = await decide(base, chat.id, { requestId: r.requestId, decision: "accept" });
    assert.deepEqual([second.status, second.body.reason, second.body.decision], [409, "decided", "accepted"], "a second click changes nothing");
    assert.equal((await decide(base, chat.id, { requestId: r.requestId, decision: "reject" })).status, 409);
    await waitForTruthy(() => notices(root).some((t) => t.includes('Workflow "card" completed')), "completion notice of the accepted run");
    assert.ok(notices(root).some((t) => t.includes("Freigabe-Karte des dynamischen Workflows „card“ angenommen")), "the silent hint of accepting travels with the next turn");
    assert.equal(runCount(), 1, "exactly one run");
    assert.equal(fs.readFileSync(path.join(root, "sub-start-c"), "utf8"), "x", "exactly one agent");
    const run = store.readDynRun(turnedOn.body.runId);
    assert.equal(run.status, "finished");
    assert.deepEqual(rows(chat.id, "workflow_approval_ruling").map((e) => [e.requestId, e.decision, e.runId]), [[r.requestId, "accepted", turnedOn.body.runId]]);
    const markers = rows(chat.id, "workflow_marker").map((m) => [m.phase, m.name]);
    assert.deepEqual(markers, [["start", "card"], ["end", "card"]]);
    // The order in the history: card, ruling, start marker.
    const roles = store.listMessages(chat.id).map((m) => m.role).filter((x) => x.startsWith("workflow_"));
    assert.deepEqual(roles, ["workflow_approval", "workflow_approval_ruling", "workflow_marker", "workflow_marker"]);
    await waitForIdle();

    // Rejecting: nothing starts, the agent learns it as a system notice.
    await send(base, chat.id, wf("d", { script: script("rejected", "return await agent('x {TAG:d}');") }));
    const d = await result(root, "d");
    assert.equal(d.status, "awaiting_approval");
    await waitForIdle();
    const rejected = await decide(base, chat.id, { requestId: d.requestId, decision: "reject" });
    assert.deepEqual([rejected.status, rejected.body.decision], [200, "rejected"], JSON.stringify(rejected.body));
    await waitForTruthy(() => notices(root).find((t) => t.includes('Workflow "rejected" was rejected by the user')), "system notice of the rejection");
    await waitForIdle();
    const notice = store.listMessages(chat.id).filter((m) => m.role === "user").at(-1).text;
    assert.ok(isCompletionNotice(notice), "stored under the role user as a system notice (marker in front), never as user text");
    assert.doesNotMatch(notice, /<status>|<name>/, "without status and name: the clients show \"system notice\"");
    assert.equal((await decide(base, chat.id, { requestId: d.requestId, decision: "accept" })).status, 409, "rejected stays rejected");
    assert.equal(runCount(), 1, "the rejection started nothing");
    assert.equal(fs.existsSync(path.join(root, "sub-start-d")), false);
  }, { claude });
});
