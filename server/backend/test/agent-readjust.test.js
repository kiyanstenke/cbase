// Readjusting and resuming agents — the main seam with the agent harness: real server, real cbase MCP server, real routes;
// only the providers are faked (Claude, Codex, loop engine).
//
// `cbase_agent_send` behaves like `SendMessage` in Claude Code, with three cases depending on the recipient's state:
//   - If it is RUNNING, the message goes into its next tool round — Claude over stdin (no second instance), the loop
//     engine in-process. Codex reads stdin only BEFORE the start (measured on 0.153.1: with an open stdin `codex exec`
//     does not even start until EOF): there the answer says "after the end as a resumption", and that is what happens.
//   - If it is FINISHED or was stopped by the agent, it is resumed with its full context (Claude --resume, Codex
//     `exec … resume`, the engine with its history) — always in the background, the call returns at once, the answer
//     comes as a new completion notice under the same id. Also from an EARLIER turn.
//   - If a HUMAN stopped it, it is rejected.
// In addition: the report of a grandchild goes to its living parent agent, otherwise to the main agent.
//
// No clock: every fake stands at a gate (file) until the test releases it; tests wait for events.
//
// Counter-proofs (which sabotage turns which test red):
//   - send to a running agent throws "still working" again => "Claude" red;
//   - closeAgents without `knownCount` (a core with only finished agents is closed) => "Claude" red
//     ("Unknown subagent" in the next turn);
//   - the check `stoppedOf === "human"` removed from send => "Claude" red (the resumption runs);
//   - the engine without `takeControl` at the tool round => "Engine" red;
//   - onFinish without the delivery to the parent agent => "Grandchild" red (the main agent gets the grandchild report).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { LOCATION, fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { isCompletionNotice } from "../electron/server/runs/completionNotice.js";
import { GRANDCHILD_REPORT_SET, subagentFrame } from "../electron/server/providers/agent-runtime.js";
import { readJsonl } from "./jsonl.mjs";

// The main agent runs the calls from "OPS:[…]"; `saveAs` stores the agentId under a name (`id-<name>`), `to` inserts it
// again — also in a later turn (new process). Result to `result-<tag>`. It only reads a completion notice.
const MAIN = `
  if (text.startsWith("<task-notification>")) {
    finished();
    say({ type: "result", result: "Notice read", session_id: "main-session" });
    return;
  }
  const ops = JSON.parse(/OPS:(\\[.*\\])/.exec(text)[1]);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const args = { ...op.args };
    if (op.to) args.agentId = fs.readFileSync(path.join(LOCATION, "id-" + op.to), "utf8");
    const id = "toolu_" + op.tag;
    say({ type: "assistant", message: { id: "main-" + op.tag, content: [{ type: "tool_use", id, name: "mcp__cbase__" + op.w, input: args }] } });
    let t = "";
    try { const m = await mcpCall(op.w, args); t = (m.result && m.result.isError ? "FEHLER " : "") + textOf(m); } catch (e) { t = "FEHLER " + (e && e.message ? e.message : String(e)); }
    if (op.saveAs) { try { fs.writeFileSync(path.join(LOCATION, "id-" + op.saveAs), JSON.parse(t).agentId); } catch {} }
    fs.writeFileSync(path.join(LOCATION, "result-" + op.tag), t);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;

// The subagent — its behavior is a marker in the job:
//   {LIMIT:x}  reports, stands at gate "limit-x", then fetches the lines that arrived up to the tool limit
//   {GATE:x}     stands at gate x and reports
//   {KIND}      starts a grandchild ({GRANDCHILD}) in the background and waits for a line on stdin OR the gate "kind"
//   {KIND-SHORT} starts a grandchild ({GRANDCHILD-GATE}) in the background and reports at once
//   otherwise   reports at once — with --resume as a resumption together with the message
const SUB = `
    const marker = (/\\{([A-Z-]+)(?::([a-z]+))?\\}/.exec(text) || [])[1] || "";
    const x = (/\\{[A-Z-]+:([a-z]+)\\}/.exec(text) || [])[1] || "";
    try { fs.writeFileSync(path.join(LOCATION, "sub-" + (x || marker || "gone") + "-" + process.pid), ""); } catch {}
    // Like the real CLI: the session stands in the first event (so a stopped agent has one that it resumes from).
    say({ type: "system", subtype: "init", session_id: "sub-session-" + (x || marker || "f") });
    const end = (r) => { finished(); say({ type: "result", result: r, session_id: "sub-session-" + (x || marker || "f") }); };
    if (marker === "LIMIT") {
      say({ type: "assistant", message: { id: "sub-g", content: [{ type: "text", text: "Interim " + x }] } });
      await gate("limit-" + x);
      const fresh = anTheLimit();
      fs.writeFileSync(path.join(LOCATION, "stdin-" + x), JSON.stringify(fresh));
      return end("Report " + x + (fresh.length ? " with " + fresh.join(" | ") : ""));
    }
    if (marker === "GATE") { await gate(x); return end("Report " + x); }
    if (marker === "KIND" || marker === "KIND-SHORT") {
      const args = { description: "Grandchild", prompt: marker === "KIND" ? "Check {GRANDCHILD}." : "Check {GRANDCHILD-GATE}." };
      say({ type: "assistant", message: { id: "kind-1", content: [{ type: "tool_use", id: "toolu_kind", name: "mcp__cbase__cbase_agent", input: args }] } });
      const t = textOf(await mcpCall("cbase_agent", args));
      fs.writeFileSync(path.join(LOCATION, "grandchild-start"), t);
      say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_kind", content: t }] } });
      if (marker === "KIND-SHORT") return end("Child done before the grandchild");
      await new Promise((r) => { const iv = setInterval(() => { if (inlet.length || fs.existsSync(path.join(LOCATION, "gates", "kind"))) { clearInterval(iv); r(); } }, 20); });
      const fresh = anTheLimit();
      fs.writeFileSync(path.join(LOCATION, "kind-stdin"), JSON.stringify(fresh));
      return end("Child done, grandchild: " + (fresh.length ? "preserved" : "nothing"));
    }
    if (marker === "GRANDCHILD") return end("Grandchild report");
    if (marker === "GRANDCHILD-GATE") { await gate("grandchild"); return end("Grandchild report late"); }
    return end("Report" + (arg("--resume") ? " (resumed: " + text + ")" : ""));`;

const fake = fakeClaude({ sub: SUB, main: MAIN });

// Fake Codex with a gate: `{GATE}` in the prompt holds the first turn, a resumption (`exec … resume <id>`) reports its
// prompt. Every call stands in `codex-calls`.
const CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const LOCATION = ${JSON.stringify(LOCATION)};
// Atomic: a test often waits only for the EXISTENCE of a file and then reads it — without rename it read an empty one under
// load. pids/ and gates/ are enumerated and stay raw, as do calls with options.
{ const raw = fs.writeFileSync; fs.writeFileSync = (p, d, o) => { if (typeof p !== "string" || o !== undefined || p.split(path.sep).some((s) => s === "pids" || s === "gates")) return raw(p, d, o); const t = path.join(path.dirname(p), "." + path.basename(p) + ".teil-" + process.pid); raw(t, d); fs.renameSync(t, p); }; }
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
const say = (o) => console.log(JSON.stringify(o));
const argv = process.argv.slice(2);
const ri = argv.indexOf("resume");
const prompt = argv[argv.length - 1];
const message = prompt.split("[END SYSTEM-DEFAULTS]").pop().trim();
fs.appendFileSync(path.join(LOCATION, "codex-calls"), JSON.stringify({ resume: ri >= 0 ? argv[ri + 1] : "", message }) + "\\n");
(async () => {
  say({ type: "thread.started", thread_id: ri >= 0 ? argv[ri + 1] : "codex-thread" });
  say({ type: "turn.started" });
  if (message.includes("{GATE}")) {
    await new Promise((r) => { const t = setInterval(() => { if (fs.existsSync(path.join(LOCATION, "gates", "codex"))) { clearInterval(t); r(); } }, 20); });
  }
  say({ type: "item.completed", item: { id: "answer-1", type: "agent_message", text: ri >= 0 ? "Codex resumed: " + message : "Codex report" } });
  say({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } });
})();
`;

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const read = (root, file) => { try { return fs.readFileSync(path.join(root, file), "utf8"); } catch { return ""; } };
const job = (ops) => `Go OPS:${JSON.stringify(ops)}`;
const notices = (log) => log.filter((m) => m.role === "user" && isCompletionNotice(m.text));
const noticesOf = (log, agentId) => notices(log).filter((m) => m.text.includes(`<task-id>${agentId}</task-id>`));
const turnPast = (base) => async () => ((await json(`${base}/api/runs/active`)).runs === 0 ? true : null);
const result = (waitForTruthy, root, tag) => waitForTruthy(() => read(root, `result-${tag}`) || null, `result ${tag}`);
const idOf = (root, name) => read(root, `id-${name}`);
const START = (tag, prompt, further = {}) => ({ w: "cbase_agent", tag, args: { description: `Agent ${tag}`, prompt, ...further } });
const SEND = (tag, to, message) => ({ w: "cbase_agent_send", tag, to, args: { message } });

test("Claude: running from an earlier turn => delivered into the next stdin chunk, no second instance; finished from an earlier turn => resumption in the background under the same id; stopped by the agent => resumed, stopped by the human => rejected", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForTruthy, waitForLog }) => {
    try {
      // Turn 1: only F, in the foreground and finished — the turn ends without a living agent (its core must stay anyway).
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([
        { ...START("f1", "Take a quick look.", { run_in_background: false }), saveAs: "F" },
      ]) });
      await result(waitForTruthy, root, "f1");
      await waitForTruthy(turnPast(base), "turn 1 is over");
      // Turn 2: B runs (gate), C is stopped by the main agent and readjusted at once, D runs (gate) — the human stops
      // that one shortly.
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([
        { ...START("b1", "Work {LIMIT:b}."), saveAs: "B" },
        { ...START("c1", "Wait {GATE:c}."), saveAs: "C" },
        { w: "cbase_agent_stop", tag: "c2", to: "C", args: {} },
        SEND("c3", "C", "Go on C"),
        { ...START("d1", "Wait {GATE:d}."), saveAs: "D" },
      ]) });
      await result(waitForTruthy, root, "d1");
      await waitForTruthy(turnPast(base), "turn 2 is over");
      await gate.reached("limit-b");
      await gate.reached("d");
      const [B, F, C, D] = ["B", "F", "C", "D"].map((n) => idOf(root, n));
      assert.match(read(root, "result-f1"), /"status": "completed"/, "F reported in the foreground");

      // Stopped by the agent => resumed (in the background), the answer comes as a completion notice under C.
      assert.match(read(root, "result-c3"), /"resumed": true/, read(root, "result-c3").slice(0, 300));
      const logC = await waitForLog(chat.id, (l) => noticesOf(l, C).length === 1);
      assert.match(noticesOf(logC, C)[0].text, /<result>Report \(resumed: Go on C\)<\/result>/);

      // The human stops D (stop button, without a turn).
      const stop = await post(`${base}/api/chats/${chat.id}/agent/stop`, { agentId: D, from: "human" });
      assert.equal(stop.ok, true);
      await waitForTruthy(turnPast(base), "the completion-notice turn of C is over");

      // Turn 3: B still runs (from turn 2) => delivered; F is finished (from turn 1) => resumption; D => rejected.
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([
        SEND("b2", "B", "Check X too."),
        SEND("f2", "F", "And further?"),
        SEND("d2", "D", "Go on D"),
      ]) });
      const b2 = await result(waitForTruthy, root, "b2");
      assert.doesNotMatch(b2, /FEHLER|still working/, b2.slice(0, 300));
      assert.match(b2, /"delivered": true/);
      const f2 = await result(waitForTruthy, root, "f2");
      assert.doesNotMatch(f2, /FEHLER|Unknown subagent/, f2.slice(0, 300));
      assert.deepEqual([/"resumed": true/.test(f2), /"background": true/.test(f2), f2.includes(`"agentId": "${F}"`)], [true, true, true],
        "finished => back at once, in the background, same id");
      const d2 = await result(waitForTruthy, root, "d2");
      assert.match(d2, /^FEHLER .*stopped by the human/, d2.slice(0, 300));

      // B reads the message at its tool limit — in the same process.
      gate.open("limit-b");
      const log = await waitForLog(chat.id, (l) => noticesOf(l, B).length === 1 && noticesOf(l, F).length === 1);
      assert.deepEqual(JSON.parse(read(root, "stdin-b")), ["Check X too."], "the message stands in the next stdin chunk");
      assert.match(noticesOf(log, B)[0].text, /<result>Report b with Check X too\.<\/result>/);
      const processesB = fs.readdirSync(root).filter((f) => f.startsWith("sub-b-"));
      assert.equal(processesB.length, 1, `no second instance: ${processesB.join(", ")}`);
      assert.match(noticesOf(log, F)[0].text, /<result>Report \(resumed: And further\?\)<\/result>/, "F: --resume of its session");
      assert.equal(noticesOf(log, D).length, 0, "stopped by the human: no resumption, no notice");
    } finally {
      for (const t of ["limit-b", "c", "d"]) gate.open(t);
    }
  }, { claude: fake });
});

test("Codex: running => the answer says \"after the end as a resumption\", and the resumption follows via `exec … resume`; finished => resumption in the background", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForTruthy, waitForLog }) => {
    try {
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([
        { ...START("x1", "Work {GATE}.", { model: "codex::gpt-5.6-sol" }), saveAs: "X" },
        SEND("x2", "X", "Codex handed in later"),
        { ...START("y1", "Short.", { model: "codex::gpt-5.6-sol", run_in_background: false }), saveAs: "Y" },
      ]) });
      const x2 = await result(waitForTruthy, root, "x2");
      assert.doesNotMatch(x2, /FEHLER/, x2.slice(0, 300));
      assert.match(x2, /"afterEnd": true/);
      assert.match(x2, /after the end of its running turn as a resumption/);
      await result(waitForTruthy, root, "y1");
      await waitForTruthy(turnPast(base), "turn 1 is over");
      const [X, Y] = ["X", "Y"].map((n) => idOf(root, n));

      gate.open("codex");
      const log = await waitForLog(chat.id, (l) => noticesOf(l, X).length === 1);
      assert.match(noticesOf(log, X)[0].text, /<result>Codex resumed: Codex handed in later<\/result>/,
        "ONE completion notice, after the resumption");
      await waitForTruthy(turnPast(base), "the completion-notice turn is over");

      await post(`${base}/api/chats/${chat.id}/message`, { text: job([SEND("y2", "Y", "Codex go on")]) });
      const y2 = await result(waitForTruthy, root, "y2");
      assert.match(y2, /"resumed": true/, y2.slice(0, 300));
      const log2 = await waitForLog(chat.id, (l) => noticesOf(l, Y).length === 1);
      assert.match(noticesOf(log2, Y)[0].text, /<result>Codex resumed: Codex go on<\/result>/);

      const calls = readJsonl(path.join(root, "codex-calls")); // only complete lines (jsonl.mjs) — the fake CLI writes while the test reads
      const rows = calls.map((a) => `${a.resume || "fresh"}: ${a.message.replace(/\s+/g, " ")}`).sort();
      assert.deepEqual(rows, ["codex-thread: Codex go on", "codex-thread: Codex handed in later", "fresh: Short.", "fresh: Work {GATE}."],
        "one start each, the message and the follow-up each as `exec … resume` of the thread");
    } finally {
      gate.open("codex");
    }
  }, { claude: fake, codex: CODEX });
});

// The engine side: a loop-engine subagent (the fake OpenRouter of the harness). {E-LAUF} holds its first model request until
// the test releases it, and then calls a tool — the message must stand in the request AFTER the tool result.
let engineFree = null;
const engineGate = () => new Promise((r) => { engineFree = r; });
let engineWaiting = null;
const engine = {
  round: async (b) => {
    const everything = JSON.stringify(b.messages || []);
    if (everything.includes("{E-LAUF}") && !(b.messages || []).some((m) => m.role === "tool")) {
      await engineWaiting;
      return { toolCalls: [{ id: "call_e1", name: "Read", arguments: { file_path: "/exists/es/not.txt" } }] };
    }
    return { text: everything.includes("Engine go on") ? "Engine resumed" : "Engine report" };
  },
};

test("Engine: running => the message stands in the next tool round (one request, no second turn); finished => resumption with its history", async () => {
  engineWaiting = engineGate();
  await withAgentsServer(async ({ base, chat, root, waitForTruthy, waitForLog, engine: e }) => {
    try {
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([
        { ...START("e1", "Work {E-LAUF}.", { model: e.model }), saveAs: "E" },
        SEND("e2", "E", "Engine readjusted"),
        { ...START("g1", "Check {E-DONE}.", { model: e.model, run_in_background: false }), saveAs: "G" },
      ]) });
      const e2 = await result(waitForTruthy, root, "e2");
      assert.doesNotMatch(e2, /FEHLER/, e2.slice(0, 300));
      assert.match(e2, /"delivered": true/);
      await result(waitForTruthy, root, "g1");
      await waitForTruthy(turnPast(base), "turn 1 is over");
      const [E, G] = ["E", "G"].map((n) => idOf(root, n));

      engineFree();
      const log = await waitForLog(chat.id, (l) => noticesOf(l, E).length === 1);
      const ofE = e.requests.filter((a) => a.stream !== false && JSON.stringify(a.messages || []).includes("{E-LAUF}"));
      assert.equal(ofE.length, 2, "two model requests: the tool, then the answer — no second turn");
      const msgs = ofE[1].messages;
      const iTool = msgs.findIndex((m) => m.role === "tool");
      assert.ok(iTool >= 0, "the second request carries the tool result");
      assert.deepEqual(msgs.slice(iTool + 1).map((m) => [m.role, m.content]), [["user", "Engine readjusted"]],
        "the message stands directly behind the tool result");
      assert.match(noticesOf(log, E)[0].text, /<result>Engine report<\/result>/);
      await waitForTruthy(turnPast(base), "the completion-notice turn is over");

      await post(`${base}/api/chats/${chat.id}/message`, { text: job([SEND("g2", "G", "Engine go on")]) });
      assert.match(await result(waitForTruthy, root, "g2"), /"resumed": true/);
      const log2 = await waitForLog(chat.id, (l) => noticesOf(l, G).length === 1);
      assert.match(noticesOf(log2, G)[0].text, /<result>Engine resumed<\/result>/);
      const last = e.requests.filter((a) => JSON.stringify(a.messages || []).includes("Engine go on")).pop();
      const history = JSON.stringify(last.messages);
      assert.match(history, /\{E-DONE\}/, "the first job stands in the history of the resumption");
      assert.match(history, /Engine report/, "the first answer too");
    } finally {
      engineFree?.();
    }
  }, { claude: fake, engine });
});

test("Grandchild: its report appears in the next tool round of the living CHILD, not at the main agent; if the child is done earlier, the main agent gets it", async () => {
  // Frame and execution: ONE sentence.
  assert.ok(subagentFrame({ depth: 1, delegated: true }).includes(GRANDCHILD_REPORT_SET));
  assert.doesNotMatch(subagentFrame({ depth: 1, delegated: true }), /before you report/, "collecting is no longer a duty");
  await withAgentsServer(async ({ base, chat, root, gate, waitForTruthy, waitForLog }) => {
    try {
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([{ ...START("k1", "Work {KIND}."), saveAs: "K" }]) });
      await result(waitForTruthy, root, "k1");
      const K = idOf(root, "K");
      // The child writes "kind-stdin" as soon as the line is there; if the report went to the main agent, it would stand there.
      const log = await waitForLog(chat.id, (l) => read(root, "kind-stdin") || notices(l).some((m) => m.text.includes("Grandchild report")));
      gate.open("kind");
      const grandchild = JSON.parse(read(root, "grandchild-start")).agentId;
      assert.equal(noticesOf(log, grandchild).length, 0, "the main agent did not get the grandchild report");
      const inChild = JSON.parse(read(root, "kind-stdin") || "[]");
      assert.equal(inChild.length, 1, JSON.stringify(inChild).slice(0, 300));
      assert.match(inChild[0], new RegExp(`^<task-notification>[^]*<task-id>${grandchild}</task-id>[^]*<result>Grandchild report</result>`));
      const log2 = await waitForLog(chat.id, (l) => noticesOf(l, K).length === 1);
      assert.match(noticesOf(log2, K)[0].text, /<result>Child done, grandchild: preserved<\/result>/);
      assert.equal(notices(log2).length, 1, "exactly one completion notice at the main agent — the child's");
      await waitForTruthy(turnPast(base), "the completion-notice turn is over");

      // The child ends before the grandchild => the grandchild report goes to the main agent (no loss).
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([{ ...START("k2", "Work {KIND-SHORT}."), saveAs: "K2" }]) });
      await result(waitForTruthy, root, "k2");
      const K2 = idOf(root, "K2");
      await waitForLog(chat.id, (l) => noticesOf(l, K2).length === 1);
      await gate.reached("grandchild");
      const grandchild2 = JSON.parse(read(root, "grandchild-start")).agentId;
      gate.open("grandchild");
      const log3 = await waitForLog(chat.id, (l) => noticesOf(l, grandchild2).length === 1);
      assert.match(noticesOf(log3, grandchild2)[0].text, /<result>Grandchild report late<\/result>/);
    } finally {
      gate.open("kind");
      gate.open("grandchild");
    }
  }, { claude: fake });
});
