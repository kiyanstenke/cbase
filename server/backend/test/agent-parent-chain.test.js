// Grandchildren and their parent agents, and the resumption of a worktree agent. The main seam with the agent harness:
// real server, real cbase MCP server, real routes; only the providers are faked.
//
// What holds here:
//   - A grandchild that the idle cleanup removed from memory is brought back from the stored state by its PARENT agent
//     via cbase_agent_send (runs/agents.js isChildOf then asks store/subagents.js); a sibling agent still gets
//     "is not one of your subagents".
//   - A foreground grandchild that switches to the background AFTER the turn (button) reports that with exactly ONE
//     background event (onSwitch without a turn -> reportBackground).
//   - When a parent agent ends (finished, failed, stopped), its living foreground children go through the same
//     transition as at the end of the turn (providers/agent-runtime.js toBackground, reason "parent-end"): the
//     `foreground` marker drops, one notice per transition, BEFORE the parent's own end.
//   - A worktree agent whose unchanged worktree was removed at its end resumes in a fresh worktree
//     (folderForResumption); if none can be created, send rejects with the reason.
//
// No clock: the fakes stand at gates (files), tests wait for events; the idle deadline and the tick without a turn never
// fire on their own (set to one day / one hour), the cleanup is triggered through the idleNow seam.
//
// Counter-proofs (which sabotage turns which test red):
//   - isChildOf without the fall-back to the stored state => "cleaned-up grandchild" red (the parent gets "is not one of your subagents")
//   - onSwitch without `reportBackground` in the no-turn case => "foreground grandchild switches" red (zero notices
//     instead of one);
//   - the loop over the foreground children in settle() removed => the three "parent end" tests red (the row keeps
//     `foreground`, no notice of the transition);
//   - `folderForResumption(rec)` removed from send() => "worktree agent whose unchanged worktree" red (the resumption
//     fails in the deleted folder, and the rejection without a repo is missing).
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 \
//   CBASE_EMBED_OFFLINE=1 CBASE_AGENT_STALL_MS=3600000 node --test server/backend/test/agent-parent-chain.test.js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { isCompletionNotice } from "../electron/server/runs/completionNotice.js";
import { resolveAgent, agentsList, coreWithAgent, liveAgents, idleNow } from "../electron/server/runs/agents.js";
import { createAgentRuntime } from "../electron/server/providers/agent-runtime.js";

// Neither the idle deadline nor the tick without a turn expires on its own in the test.
process.env.CBASE_AGENT_IDLE_MS = String(24 * 3_600_000);
process.env.CBASE_AGENT_TICK_MS = String(3_600_000);

// Both roles run the calls from "OPS:[…]" in order: `to` inserts the agentId that an earlier `saveAs` stored under a name
// (`id-<name>`); the result goes to `result-<tag>` ("FEHLER " in front for a tool error). `go: true` does not wait for
// the result (the call stays open). `{ gate: x }` is no call: the role stands at gate x before it makes the next calls.
const OPS = `
  const performAction = async (ops) => {
    for (const op of ops) {
      if (op.gate) { await gate(op.gate); continue; }
      const args = { ...op.args };
      if (op.to) args.agentId = fs.readFileSync(path.join(LOCATION, "id-" + op.to), "utf8");
      const id = "toolu_" + op.tag;
      say({ type: "assistant", message: { id: "m-" + op.tag, content: [{ type: "tool_use", id, name: "mcp__cbase__" + op.w, input: args }] } });
      const call = mcpCall(op.w, args);
      if (op.go) { call.catch(() => {}); continue; }
      let t = "";
      try { const m = await call; t = (m.result && m.result.isError ? "FEHLER " : "") + textOf(m); } catch (e) { t = "FEHLER " + (e && e.message ? e.message : String(e)); }
      if (op.saveAs) { try { fs.writeFileSync(path.join(LOCATION, "id-" + op.saveAs), JSON.parse(t).agentId); } catch {} }
      fs.writeFileSync(path.join(LOCATION, "result-" + op.tag), t);
      say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
    }
  };
  const ops = /OPS:(\\[.*\\])/.exec(text);`;

const MAIN = `${OPS}
  if (text.includes("<task-notification>")) {
    finished();
    say({ type: "result", result: "Notice read", session_id: "main-session" });
    return;
  }
  if (ops) await performAction(JSON.parse(ops[1]));
  // {MAINGATE:x}: the main run stands at gate x after its calls — the turn stays open.
  for (const m of text.replace(/OPS:\\[.*\\]/, "").matchAll(/\\{MAINGATE:([a-z0-9]+)\\}/g)) await gate(m[1]);
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;

// The subagent: {GATE:x} before the calls, {NACH:x} after them, {CRASH} dies afterwards with exit 1. It reports a session
// (resumable) and reports its directory.
const SUB = `${OPS}
  const session = arg("--resume") || ("sub-" + process.pid);
  if (text.includes("<task-notification>")) {
    finished();
    say({ type: "result", result: "Notice read", session_id: session });
    return;
  }
  say({ type: "system", subtype: "init", session_id: session });
  // The gates stand OUTSIDE the calls (a grandchild job in OPS carries its own).
  const rest = text.replace(/OPS:\\[.*\\]/, "");
  for (const m of rest.matchAll(/\\{GATE:([a-z0-9]+)\\}/g)) await gate(m[1]);
  // {FREI:x}: a permission request through its own MCP server; the answer goes to free-x.
  for (const m of rest.matchAll(/\\{FREI:([a-z0-9]+)\\}/g)) {
    let r; try { r = textOf(await mcpCall("cbase_permission_prompt", { tool_name: "Bash", input: { command: "ls" } }, null)); } catch (e) { r = "FEHLER " + (e && e.message || e); }
    fs.writeFileSync(path.join(LOCATION, "free-" + m[1]), String(r));
  }
  if (ops) await performAction(JSON.parse(ops[1]));
  for (const m of rest.matchAll(/\\{NACH:([a-z0-9]+)\\}/g)) await gate(m[1]);
  if (rest.includes("{CRASH}")) { process.stderr.write("Subagent crashed\\n"); process.exit(1); }
  finished();
  say({ type: "result", result: "Report cwd=" + process.cwd() + (arg("--resume") ? " resumed" : ""), session_id: session });`;

const fake = fakeClaude({ main: MAIN, sub: SUB });

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const read = (root, file) => { try { return fs.readFileSync(path.join(root, file), "utf8"); } catch { return ""; } };
const job = (ops) => `Go OPS:${JSON.stringify(ops)}`;
const START = (tag, prompt, further = {}) => ({ w: "cbase_agent", tag, args: { description: `Agent ${tag}`, prompt, ...further } });
const SEND = (tag, to, message) => ({ w: "cbase_agent_send", tag, to, args: { message } });
const result = (root, tag) => waitForTruthy(() => read(root, `result-${tag}`) || null, `result ${tag}`);
const idOf = (root, name) => read(root, `id-${name}`);
const turnPast = (base) => async () => ((await json(`${base}/api/runs/active`)).runs === 0 ? true : null);
const noticesOf = (log, agentId) => log.filter((m) => m.role === "user" && isCompletionNotice(m.text) && m.text.includes(`<task-id>${agentId}</task-id>`));
// The rows that web and iOS read (SSE `background`) — the `foreground` marker stands only there.
const rowsOf = (chatId) => liveAgents().filter((a) => a.chatId === chatId);
const rowOf = (chatId, description) => rowsOf(chatId).find((a) => a.description === description) || null;

// The event stream of a chat (also without a turn) — model: agent-lifetime.test.js.
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
  return { events, async shut() { ac.abort(); await pump; } };
}
const backgroundFrom = (stream, start) => stream.events.slice(start).filter((e) => e.subtype === "background");
const rowIn = (evt, agentId) => (evt.agents || []).find((a) => a.agentId === agentId) || null;

test("cleaned-up grandchild: its parent agent brings it back from the stored state via cbase_agent_send, a sibling is rejected", async () => {
  await withAgentsServer(async ({ base, chat, root, waitForLog, waitForIdle }) => {
    // A starts the grandchild E in the foreground (its report goes to A); S is a sibling of A.
    const grandchild = START("e1", "Short.", { run_in_background: false });
    await post(`${base}/api/chats/${chat.id}/message`, { text: job([
      { ...START("a1", `OPS:${JSON.stringify([{ ...grandchild, saveAs: "E" }])}`), saveAs: "A" },
      { ...START("s1", "Short."), saveAs: "S" },
    ]) });
    await result(root, "s1");
    const [A, S] = ["A", "S"].map((n) => idOf(root, n));
    await waitForLog(chat.id, (l) => noticesOf(l, A).length === 1 && noticesOf(l, S).length === 1);
    const E = idOf(root, "E");
    assert.ok(E, "A started the grandchild");
    assert.match(read(root, "result-e1"), /"status": "completed"/, "the foreground grandchild reported to A");
    await waitForTruthy(turnPast(base), "the turns are over");
    await waitForIdle();

    assert.ok(idleNow() >= 1, "the idle core is closed");
    for (const id of [A, S, E]) assert.equal(coreWithAgent(chat.id, id), null, `${id} is in no core any more`);

    // A and S are resumed from the stored state; their message makes them address the grandchild.
    await post(`${base}/api/chats/${chat.id}/message`, { text: job([
      SEND("a2", "A", `OPS:${JSON.stringify([SEND("ea", "E", "go on, from the parent agent")])}`),
      SEND("s2", "S", `OPS:${JSON.stringify([SEND("es", "E", "go on, from the sibling")])}`),
    ]) });
    assert.match(await result(root, "a2"), /"resumed": true/);
    assert.match(await result(root, "s2"), /"resumed": true/);
    const fromParent = await result(root, "ea");
    assert.doesNotMatch(fromParent, /^FEHLER/, `the parent agent brings back its cleaned-up grandchild: ${fromParent.slice(0, 300)}`);
    assert.match(fromParent, /"resumed": true/);
    assert.match(await result(root, "es"), /^FEHLER [^]*is not one of your subagents/, "a sibling does not lead the grandchild");
    await waitForIdle();
    console.log(`  [grandchild] ${E}: parent ${A} resumes, sibling ${S} rejected`);
  }, { claude: fake });
});

test("foreground grandchild switches to the background after the turn: exactly one notice, no second event", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForIdle, barrier }) => {
    const stream = await openStream(`${base}/api/chats/${chat.id}/stream`);
    try {
      const grandchild = START("e1", "{GATE:e}", { run_in_background: false });
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([{ ...START("a1", `{GATE:a} OPS:${JSON.stringify([grandchild])} {NACH:p}`), saveAs: "A" }]) });
      await result(root, "a1");
      await waitForTruthy(turnPast(base), "the turn is over");
      gate.open("a"); // only now does A start the grandchild — after the turn
      await gate.reached("e");
      const prior = await waitForTruthy(() => rowOf(chat.id, "Agent e1"), "the grandchild is in the bar");
      assert.equal(prior.foreground, true, "its call waits");
      const E = prior.agentId;
      const A = idOf(root, "A");

      // The cut stands BEHIND the stream barrier (quiet.mjs), not at `events.length`: the look above went into the
      // server memory (liveAgents), the reader lags — under load the background event that reported the grandchild
      // in the foreground arrived only AFTER the cut and counted as a second notice.
      const bar = await barrier(stream);
      const r = await post(`${base}/api/chats/${chat.id}/agent/background`, { agentId: E });
      assert.deepEqual(r, { ok: true, agentId: E, background: true });
      assert.match(await result(root, "e1"), /"intoTheBackground": "human"/, "the waiting call of the parent agent returned");
      await gate.reached("p");
      gate.open("e");
      // The end of the grandchild reports with a row WITHOUT it — until then every event that names it counts.
      await waitForTruthy(() => backgroundFrom(stream, bar).find((e) => !rowIn(e, E)) || null, "the end of the grandchild is in the stream");
      const untilEnd = [];
      for (const e of backgroundFrom(stream, bar)) { if (!rowIn(e, E)) break; untilEnd.push(e); }
      console.log(`  [switch] ${untilEnd.length} notice(s) between button and end of the grandchild`);
      assert.equal(untilEnd.length, 1, `exactly one notice of the switch: ${JSON.stringify(untilEnd.map((e) => e.agents))}`);
      assert.equal(rowIn(untilEnd[0], E).foreground, undefined, "the notice shows it in the background");
      assert.ok(rowIn(untilEnd[0], A), "the parent agent lives alongside");
    } finally {
      for (const t of ["a", "e", "p"]) gate.open(t);
      await stream.shut();
    }
    await waitForIdle();
  }, { claude: fake });
});

// The parent agent A has started its foreground grandchild E (the call stays open) and stands at gate "p"; `end` ends it
// in one of three ways. Afterwards: E no longer carries the marker, and ONE notice shows the transition while A is still
// in the bar (before its own end).
async function parentEnd(end) {
  await withAgentsServer(async ({ base, chat, root, gate, waitForIdle, barrier }) => {
    const stream = await openStream(`${base}/api/chats/${chat.id}/stream`);
    try {
      const grandchild = { ...START("e1", "{GATE:e}", { run_in_background: false }), go: true };
      const addition = end === "failed" ? " {CRASH}" : "";
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([{ ...START("a1", `{GATE:a} OPS:${JSON.stringify([grandchild])} {NACH:p}${addition}`), saveAs: "A" }]) });
      await result(root, "a1");
      await waitForTruthy(turnPast(base), "the turn is over");
      gate.open("a");
      await gate.reached("e");
      await gate.reached("p");
      const A = idOf(root, "A");
      const prior = await waitForTruthy(() => rowOf(chat.id, "Agent e1"), "the grandchild is in the bar");
      assert.equal(prior.foreground, true, "its call waits");
      const E = prior.agentId;

      // Behind the stream barrier (see the switch test) — the cut only serves to wait for the end of A; counting below is
      // by CONTENT.
      const bar = await barrier(stream);
      if (end === "stopped") {
        const r = await post(`${base}/api/chats/${chat.id}/agent/stop`, { agentId: A, from: "human" });
        assert.equal(r.ok, true, JSON.stringify(r));
      } else gate.open("p");
      // The end of A reports with a row without it.
      await waitForTruthy(() => backgroundFrom(stream, bar).find((e) => !rowIn(e, A)) || null, "the end of the parent agent is in the stream");
      const status = agentsList(chat.id).find((a) => a.agentId === A)?.status;
      assert.equal(status, { finished: "completed", failed: "failed", stopped: "stopped" }[end], `A ended ${end}`);
      const after = rowOf(chat.id, "Agent e1");
      assert.equal(after?.agentId, E, "the grandchild lives on");
      assert.equal(after.foreground, undefined, `after the end of A it carries no foreground marker: ${JSON.stringify(after)}`);
      assert.equal(agentsList(chat.id).find((a) => a.agentId === E)?.background, true, "it is a background agent");
      // By CONTENT, not by position: the transition is the notice in which A still lives and E stands without the marker —
      // before, E always carried it (its call waits), afterwards A is no longer there. Counted over the WHOLE stream, so
      // without a cut that could be off under load; it is complete up to here because the end of A (awaited above) is
      // written after the transition and SSE is ordered per connection.
      const background = stream.events.filter((e) => e.subtype === "background");
      const isTransition = (e) => rowIn(e, A) && rowIn(e, E) && !rowIn(e, E).foreground;
      const transition = background.filter(isTransition);
      console.log(`  [parent end ${end}] ${transition.length} notice(s) of the transition`);
      assert.equal(transition.length, 1, "exactly one notice of the transition, before the end of the parent agent");
      const withMarker = background.slice(background.indexOf(transition[0]) + 1).filter((e) => rowIn(e, E)?.foreground);
      assert.deepEqual(withMarker, [], "no notice after the transition shows it in the foreground");

      gate.open("e");
      await waitForTruthy(() => (rowsOf(chat.id).length === 0 ? true : null), "the grandchild is done");
    } finally {
      for (const t of ["a", "e", "p"]) gate.open(t);
      await stream.shut();
    }
    await waitForIdle();
  }, { claude: fake });
}

test("parent end (finished): its foreground children go to the background, one notice", () => parentEnd("finished"));
test("parent end (failed): its foreground children go to the background, one notice", () => parentEnd("failed"));
test("parent end (stopped): its foreground children go to the background, one notice", () => parentEnd("stopped"));

// Git without personal configuration — as in agent-level-repo.test.js.
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "5",
  GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Test",
  GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "test@example.com",
  GIT_CONFIG_KEY_2: "core.excludesFile", GIT_CONFIG_VALUE_2: "/dev/null",
  GIT_CONFIG_KEY_3: "core.attributesFile", GIT_CONFIG_VALUE_3: "/dev/null",
  GIT_CONFIG_KEY_4: "init.defaultBranch", GIT_CONFIG_VALUE_4: "main",
};
async function withGitEnvironment(fn) {
  const prior = Object.fromEntries(Object.keys(GIT_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, GIT_ENV);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const git = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
};

test("worktree agent whose unchanged worktree was removed resumes in a fresh one — without a repo, send rejects with the reason", async () => {
  await withGitEnvironment(() => withAgentsServer(async ({ base, chat, root, waitForLog, waitForIdle }) => {
    // The working folder of the chat is the repo.
    const repo = path.join(root, "workspace");
    git(["init", "-q"], repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    git(["add", "a.txt"], repo);
    git(["commit", "-qm", "start"], repo);

    await post(`${base}/api/chats/${chat.id}/message`, { text: job([{ ...START("w1", "Short.", { run_in_background: false, isolation: "worktree" }), saveAs: "W" }]) });
    const first = JSON.parse(await result(root, "w1"));
    const W = first.agentId;
    assert.match(first.report, /cwd=\S*agent-/, `it ran in a worktree: ${first.report}`);
    assert.equal(first.worktree, "", "unchanged => not in the report");
    assert.equal(fs.existsSync(first.cwd), false, "the unchanged worktree is gone");
    await waitForTruthy(turnPast(base), "the turn is over");

    await post(`${base}/api/chats/${chat.id}/message`, { text: job([SEND("w2", "W", "continue please")]) });
    assert.match(await result(root, "w2"), /"resumed": true/);
    const log = await waitForLog(chat.id, (l) => noticesOf(l, W).length === 1);
    const notice = noticesOf(log, W)[0].text;
    assert.match(notice, /<status>completed<\/status>/, `the resumption ran: ${notice.slice(0, 600)}`);
    assert.match(notice, /cwd=\S*agent-\S* resumed/, "in a worktree, as a resumption");
    await waitForTruthy(turnPast(base), "the notice turn is over");
    await waitForIdle();

    // Without a repo no worktree can be created any more: the resumption is rejected with the reason.
    fs.renameSync(path.join(repo, ".git"), path.join(repo, ".git-way"));
    try {
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([SEND("w3", "W", "once more")]) });
      assert.match(await result(root, "w3"), /^FEHLER [^]*cannot be resumed: its worktree was removed at its end/);
      await waitForTruthy(turnPast(base), "the third turn is over");
    } finally {
      fs.renameSync(path.join(repo, ".git-way"), path.join(repo, ".git"));
    }
    await waitForIdle();
  }, { claude: fake }));
});

// ── Review group B2 ───────────────────────────────────────────────────────────────────────────────────────────────────

// `/stop` ended every living non-background agent of the core — also the foreground GRANDCHILD of a background agent that
// is waited for not by the turn but by its parent agent. The other turn end (detach from the turn) leaves it standing; a
// grandchild stopped like that could no longer be resumed.
test("/stop of the turn lets the foreground grandchild of a background agent live — it ends with its report", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForIdle }) => {
    try {
      const grandchild = { ...START("e1", "{GATE:e}", { run_in_background: false }), saveAs: "E" };
      await post(`${base}/api/chats/${chat.id}/message`, { text: `${job([{ ...START("a1", `OPS:${JSON.stringify([grandchild])} {NACH:p}`), saveAs: "A" }])} {MAINGATE:h}` });
      await result(root, "a1");
      await gate.reached("e");
      await gate.reached("h");
      await post(`${base}/api/chats/${chat.id}/stop`, {});
      await waitForTruthy(turnPast(base), "the turn is stopped");
      gate.open("e");
      const e1 = await result(root, "e1");
      assert.match(e1, /"status": "completed"/, `the grandchild worked to the end instead of dying with the stop of the turn: ${e1.slice(0, 300)}`);
      gate.open("p");
    } finally { for (const t of ["e", "p", "h"]) gate.open(t); }
    await waitForIdle();
  }, { claude: fake });
});

// Without a turn only a BACKGROUND agent got a card (runs/permissions.js) — a foreground grandchild that its parent agent
// waits for got "no running run", for up to 240 s, until it switched to the background.
test("the permission of a foreground grandchild after the turn becomes a card — no silent rejection", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForIdle }) => {
    try {
      const grandchild = { ...START("e1", "{FREI:e}", { run_in_background: false }), go: true };
      // The harness chat runs as bypassPermissions — there no run is offered cbase_permission_prompt (the real CLI calls
      // it only in the asking mode). So set it to asking, as in approvals-je-agent.
      await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ permissionMode: "default" }) });
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([{ ...START("a1", `{GATE:a} OPS:${JSON.stringify([grandchild])} {NACH:p}`), saveAs: "A" }]) });
      await result(root, "a1");
      await waitForTruthy(turnPast(base), "the turn is over");
      gate.open("a"); // only now does A start the grandchild — after the turn
      const state = await waitForTruthy(async () => {
        const response = read(root, "free-e");
        if (response) return { response };
        const log = await json(`${base}/api/chats/${chat.id}/log`);
        const card = log.filter((m) => m.role === "approval").map((m) => JSON.parse(m.text)).find((k) => k.input?.command === "ls");
        return card ? { rid: card.requestId } : null;
      }, "card or answer of the grandchild");
      assert.ok(state.rid, `after the turn a card appears instead of a silent rejection: ${state.response}`);
      const d = await post(`${base}/api/chats/${chat.id}/permission-decision`, { requestId: state.rid, behavior: "allow" });
      assert.equal(d.ok, true, JSON.stringify(d));
      assert.match(await waitForTruthy(() => read(root, "free-e") || null, "answer to the grandchild"), /allow/);
      gate.open("p");
    } finally { for (const t of ["a", "p"]) gate.open(t); }
    await waitForIdle();
  }, { claude: fake });
});

// Short names collide across the cores of a chat (one core per turn). Stop searched from the oldest core, send/output from
// the newest — a subagent stopped the main agent's agent with stop("x") instead of its own child. Now ONE resolution: own
// children first, a living one before a known one; ambiguous => error with the candidates.
test("a short name across several cores: the subagent hits its own child, ambiguous is the same error for send, output and stop", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForIdle }) => {
    try {
      // Turn 1: the main agent starts H1 "x" (background, at gate a).
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([{ ...START("h1", "{GATE:a}", { name: "x" }), saveAs: "H1" }]) });
      await result(root, "h1");
      await waitForTruthy(turnPast(base), "turn 1 is over");
      await gate.reached("a");
      // Turn 2: S starts its child K "x" and stops "x" — K is meant.
      const childOps = [{ ...START("k1", "{GATE:b}", { name: "x" }), saveAs: "K" }, { w: "cbase_agent_stop", tag: "st", args: { agentId: "x" } }];
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([{ ...START("s1", `OPS:${JSON.stringify(childOps)} {NACH:p}`, { name: "s" }), saveAs: "S" }]) });
      const st = await result(root, "st");
      const H1 = idOf(root, "H1");
      const K = idOf(root, "K");
      assert.doesNotMatch(st, /^FEHLER/, st.slice(0, 300));
      assert.ok(st.includes(K) && !st.includes(H1), `S stopped its own child ${K}, not ${H1}: ${st.slice(0, 300)}`);
      assert.ok(liveAgents().some((a) => a.agentId === H1), "H1 lives on");
      await waitForTruthy(turnPast(base), "turn 2 is over");
      // Turn 3: the main agent starts H3 "x" — two own living "x" in two cores.
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([
        { ...START("h3", "{GATE:c}", { name: "x" }), saveAs: "H3" },
        { w: "cbase_agent_output", tag: "out", args: { agentId: "x", block: false } },
        { w: "cbase_agent_send", tag: "snd", args: { agentId: "x", message: "further" } },
        { w: "cbase_agent_stop", tag: "st3", args: { agentId: "x" } },
      ]) });
      const H3 = await waitForTruthy(() => idOf(root, "H3") || null, "H3 started");
      for (const tag of ["out", "snd", "st3"]) {
        const r = await result(root, tag);
        assert.match(r, /^FEHLER [^]*mehrdeutig/, `${tag}: ${r.slice(0, 300)}`);
        for (const id of [H1, H3]) assert.ok(r.includes(id), `${tag} names the candidate ${id}: ${r.slice(0, 300)}`);
      }
      for (const id of [H1, H3]) assert.ok(liveAgents().some((a) => a.agentId === id), `${id} was not stopped`);
    } finally { for (const t of ["a", "b", "c", "p"]) gate.open(t); }
    await waitForIdle();
  }, { claude: fake });
});

// At server end, closing the core removes an unchanged worktree, but the store is silent there — in the stored state the
// repo stands only in the worktree (`worktree.repo`), never as `worktreeRepo`. Picked up, the core read only the second:
// the resumption found neither folder nor repo and rejected.
test("worktree agent across a restart — its worktree is gone, the resumption creates a fresh one", async () => {
  await withGitEnvironment(() => withAgentsServer(async ({ base, chat, root, gate, restart, waitForLog, waitForIdle }) => {
    const repo = path.join(root, "workspace");
    git(["init", "-q"], repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    git(["add", "a.txt"], repo);
    git(["commit", "-qm", "start"], repo);
    try {
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([{ ...START("w1", "{GATE:w}", { isolation: "worktree" }), saveAs: "W" }]) });
      await result(root, "w1");
      await gate.reached("w");
      const W = idOf(root, "W");
      await restart({ withBackground: true });
      gate.open("w");
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([SEND("w2", "W", "continue please")]) });
      const w2 = await result(root, "w2");
      assert.doesNotMatch(w2, /^FEHLER/, `the resumption after the restart: ${w2.slice(0, 400)}`);
      assert.match(w2, /"resumed": true/);
      const log = await waitForLog(chat.id, (l) => noticesOf(l, W).length >= 1);
      const notice = noticesOf(log, W).at(-1).text;
      assert.match(notice, /cwd=\S*agent-\S* resumed/, `in a fresh worktree, as a resumption: ${notice.slice(0, 600)}`);
      await waitForTruthy(turnPast(base), "the notice turn is over");
    } finally { gate.open("w"); }
    await waitForIdle();
  }, { claude: fake }));
});

// Second path: a PARKED worktree agent, picked up after the restart, resumes via its alarm (`wakeup`) — that never called
// folderForResumption and started the process in the missing folder (ENOENT). The unit: the core without a server, a real
// repo, the alarm as a seam.
test("a parked worktree agent from the stored state resumes after the alarm in a fresh worktree", async () => {
  await withGitEnvironment(async () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "cbase-n15-"));
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    git(["init", "-q"], repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    git(["add", "a.txt"], repo);
    git(["commit", "-qm", "start"], repo);
    const top = git(["rev-parse", "--show-toplevel"], repo);
    const way = path.join(path.dirname(top), ".cbase-worktrees", "agent-n15");
    let woken = null;
    const runs = [];
    const rt = createAgentRuntime({
      chatId: "c-n15", cwd: repo, parentProvider: "claude",
      resolveRef: () => ({ connector: {}, providerId: "claude", model: "" }),
      buildSpec: (o) => ({ cwd: o.cwd }),
      runChat: ({ spec }) => { runs.push({ cwd: spec.cwd, present: fs.existsSync(spec.cwd) }); return Promise.resolve({ code: 0, sessionId: "s-n15", resultText: "further" }); },
      wakeup: (ms, fn) => { woken = fn; return () => { woken = null; }; },
    });
    try {
      rt.pickUp({ agentId: "n15", name: "n15", provider: "claude", model: "", sessionId: "s-n15", state: "parked", status: "parked",
        parkedUntil: Date.now() + 3_600_000, cwd: way, worktree: { dir: way, branch: "cbase/agent-n15", repo: top, base: "" } });
      assert.equal(typeof woken, "function", "the alarm is set");
      woken();
      await waitForTruthy(() => (runs.length || rt.get("n15")?.status === "failed" ? true : null), "resumption or failure");
      assert.deepEqual(runs.map((l) => l.present), [true], `the process starts in an existing folder: ${JSON.stringify(runs)} ${rt.get("n15")?.error || ""}`);
    } finally {
      rt.close();
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* cleanup must not fail the test */ }
    }
  });
});

// ── Second reading of group B2 ────────────────────────────────────────────────────────────────────────────────────────

// The resolution picked the right agent, but send and output passed the RAW name on — the core resolved it once more itself
// (the youngest of that name in the core before the stored state). If the resolved agent stood only in the stored state
// (its core was closed) and the core of the turn held a grandchild of the same name, the message went to the grandchild.
// Counter-proof: with the raw name passed on, both calls name the grandchild X2 instead of X1.
test("send and output to a short name reach the resolved agent from the stored state, not the same-named grandchild in the core of the turn", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForIdle }) => {
    try {
      // Turn A: the main agent starts X1 "x" (background, at gate a); its core stays open while X1 lives.
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([{ ...START("x1", "{GATE:a}", { name: "x" }), saveAs: "X1" }]) });
      await result(root, "x1");
      await waitForTruthy(turnPast(base), "turn A is over");
      await gate.reached("a");
      // Turn B: S (foreground) starts its grandchild X2 "x" (background, at gate b) and returns; the main agent then
      // stands at gate h and only then asks for "x" — output first, then a message.
      const grandchild = [{ ...START("x2", "{GATE:b}", { name: "x" }), saveAs: "X2" }];
      await post(`${base}/api/chats/${chat.id}/message`, { text: job([
        START("s1", `OPS:${JSON.stringify(grandchild)}`, { name: "s", run_in_background: false }),
        { gate: "h" },
        { w: "cbase_agent_output", tag: "out", args: { agentId: "x", block: false } },
        { w: "cbase_agent_send", tag: "snd", args: { agentId: "x", message: "continue please" } },
      ]) });
      await gate.reached("b");
      await gate.reached("h");
      const X1 = idOf(root, "X1");
      const X2 = idOf(root, "X2");
      // X1 ends AFTER the last state of X2 (its picture is the newest of that name), then its core closes.
      gate.open("a");
      await waitForTruthy(() => (liveAgents().some((a) => a.agentId === X1) ? null : true), "X1 is done");
      await waitForTruthy(() => { idleNow(); return coreWithAgent(chat.id, X1) === null ? true : null; }, "the core of turn A is closed");
      // Precondition: the name means X1 (own child of the main agent, only in the stored state), and the core of the turn holds X2 "x".
      const target = resolveAgent(chat.id, "x");
      assert.equal(target?.agentId, X1, "the resolution picks X1");
      assert.equal(target.core, null, "X1 stands only in the stored state");
      assert.ok(liveAgents().some((a) => a.agentId === X2), "X2 lives in the core of the turn");
      gate.open("h");
      for (const tag of ["out", "snd"]) {
        const r = await result(root, tag);
        assert.doesNotMatch(r, /^FEHLER/, `${tag}: ${r.slice(0, 300)}`);
        assert.ok(r.includes(X1) && !r.includes(X2), `${tag} reaches X1, not the grandchild ${X2}: ${r.slice(0, 300)}`);
      }
      assert.match(await result(root, "snd"), /"resumed": true/, "X1 was resumed");
    } finally { for (const t of ["a", "b", "h"]) gate.open(t); }
    await waitForIdle();
  }, { claude: fake });
});

// For an agent with an instance, weiter() waits for the fresh worktree in the project container (one promise) and then
// went on without asking. A stop in this window left the already accounted agent "running" forever, spawned into the
// container and left the fresh worktree lying. The unit: the core without a server, the instance's management tool as a
// seam (`gitFor`), whose first answer hangs at a gate (no timer).
// Counter-proof: without the check after the wait, runChat is called and the status is "running".
test("a stop while the fresh worktree is created in the project container: no process, the agent stays stopped, the worktree goes back", async () => {
  let gateOn = () => {};
  const gateClosed = new Promise((r) => { gateOn = r; });
  const calls = [];
  const teardowns = [];
  const runs = [];
  let woken = null;
  const kg = {
    run: async (args) => {
      calls.push(args.join(" "));
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") { await gateClosed; return { ok: true, out: "/proj/repo" }; }
      if (args[0] === "rev-parse") return { ok: true, out: "abc123" };
      return { ok: true, out: "" };
    },
    teardown: async (job) => { teardowns.push(job); return { removed: true }; },
  };
  const rt = createAgentRuntime({
    chatId: "c-n15c", cwd: "/proj/repo", parentProvider: "claude",
    resolveRef: () => ({ connector: {}, providerId: "claude", model: "" }),
    buildSpec: (o) => ({ cwd: o.cwd }),
    runChat: ({ spec }) => { runs.push(spec.cwd); return Promise.resolve({ code: 0, sessionId: "s-n15c", resultText: "further" }); },
    wakeup: (ms, fn) => { woken = fn; return () => { woken = null; }; },
    gitFor: (identifier) => (identifier === "pA/main" ? kg : null),
  });
  try {
    rt.pickUp({ agentId: "n15c", name: "n15c", provider: "claude", model: "", sessionId: "s-n15c", state: "parked", status: "parked",
      parkedUntil: Date.now() + 3_600_000, cwd: "/exists/es/not/agent-n15c", instance: "pA/main", worktreeRepo: "/proj/repo" });
    assert.equal(typeof woken, "function", "the alarm is set");
    woken();
    await waitForTruthy(() => (calls.length ? true : null), "the fresh worktree is created in the project container");
    assert.equal(rt.stop("n15c"), true);
    assert.equal(rt.get("n15c").status, "stopped");
    gateOn();
    await waitForTruthy(() => (teardowns.length || runs.length || rt.get("n15c")?.status !== "stopped" ? true : null), "teardown of the worktree or a start");
    assert.deepEqual(runs, [], "after the stop no process starts");
    assert.equal(rt.get("n15c").status, "stopped", "the agent stays stopped");
    assert.equal(teardowns.length, 1, "the worktree just created goes back");
    assert.match(teardowns[0].worktrees[0].dir, /agent-n15c$/);
  } finally {
    gateOn();
    rt.close();
  }
});
