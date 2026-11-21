// Guards for gitView/user.js and gitView/color.js.
//
// What it proves, each with the sabotage that breaks it:
//   (1) Key colors: the same name => the same slot (hash, no randomness); up to COLORS copies no duplicate; a NEW copy moves no older
//       one; only the seventh shares a slot; main has no color. Sabotage: `keyColors` without "next free" (always the hash slot) =>
//       (1) red (duplicate among six names).
//   (2) The table from a seed, per row: subagent with a row — `running` as long as its core knows it ALIVE (a real core: fake Claude with
//       a subagent at the gate), afterwards `ended`; a subagent with a row without a core `ended`; a workflow agent (only in the journal,
//       never in `subagents`) `running` as long as its run is running; graph run `running` only with an open run — `ended`, although
//       `graph_starts.status` stays `started`; `copy/<name>/…` `running`/`copy-removed`; `cbase/agent-…` without a row `unknown`
//       (never `ended`); an ordinary branch without a state. Every user object carries ALL fields of the contract. Sabotage:
//       `subagentAlive` always false => (2) red ("running" expected); `view.endedAt === null` -> `z.status === "started"` => (2) red
//       (the ended graph run stood as `running`); the workflow query without a hit => (2) red (`unknown`).
//   (3) Running chats fresh on every call: a turn (runs/state.js running) appears at once and disappears at once; a living subagent keeps
//       the chat in; the instance counts (`chats.instance` NULL = main, `copy-<name>` = the copy). Sabotage: without `running.has` => (3) red.
//   (4) The tick asks the workflow agents for every `cbase/agent-*` without a `subagents` row: the query searches via the partial index
//       `dyn_workflow_journal_agent` (EXPLAIN QUERY PLAN of the same query, store.dynWorkflowAgentsPlan), never via a scan. Sabotage: the
//       CREATE INDEX struck => (4) red ("SCAN j").
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { running } from "../electron/server/runs/state.js";
import { liveAgents } from "../electron/server/runs/agents.js";
import { USER_FIELDS, COLORS } from "../electron/server/gitView/contract.js";
import { userAndState, runningChats } from "../electron/server/gitView/user.js";
import { hashSlot, keyColor, keyColors, keyColorsOfTheProject } from "../electron/server/gitView/color.js";
import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";

test("(1) key colors: stable, no duplicate until COLORS, a new copy moves no old one, only the seventh shares", () => {
  assert.equal(COLORS, 6);
  assert.equal(hashSlot("k1"), hashSlot("k1"), "same name, same slot");
  // Many names, each a prefix of the creation order: no duplicate up to six, and what was assigned stays.
  const names = ["k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "test", "acceptance", "x", "y"];
  let prior = new Map();
  for (let n = 1; n <= names.length; n++) {
    const f = keyColors(names.slice(0, n));
    assert.equal(f.size, n);
    for (const v of f.values()) assert.ok(Number.isInteger(v) && v >= 0 && v < COLORS, `index out of range: ${v}`);
    if (n <= COLORS) assert.equal(new Set(f.values()).size, n, `duplicate among ${n} copies: ${JSON.stringify([...f])}`);
    for (const [k, v] of prior) assert.equal(f.get(k), v, `the new copy ${names[n - 1]} moved ${k}`);
    prior = f;
  }
  // From the seventh: every slot at most twice, even up to twelve.
  const twelve = [...keyColors(names).values()];
  for (let p = 0; p < COLORS; p++) assert.equal(twelve.filter((v) => v === p).length, 2, `slot ${p} not even: ${twelve}`);
  // The same name counts once; the order decides about dodging, the name about the preferred slot.
  assert.deepEqual([...keyColors(["a", "a"])], [["a", hashSlot("a")]]);
});

const sub = `    await gate("sub");\n    finished();\n    say({ type: "result", result: "Finding", session_id: "sub-session" });`;
const main = `
  say({ type: "assistant", message: { id: "main-1", content: [{ type: "tool_use", id: "toolu_g", name: "mcp__cbase__cbase_agent",
    input: { description: "Checks", prompt: "Check.", run_in_background: false } }] } });
  await mcpCall("cbase_agent", { description: "Checks", prompt: "Check.", run_in_background: false });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;

test("(2)(3) user and state per source, running chats fresh, key colors of the project", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, ws, gate } = ctx;
    const p = await ctx.projectWithoutInstance({ name: "Git overview", path: path.join(ctx.root, "workspace", "gu4") });
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });

    // ── Seed ──
    // Subagent with a row, without a core (finished): ended.
    store.rememberSubagent(chat.id, { agentId: "sa-finished", name: "Old reviewer", state: "finished" });
    // Workflow agent: only in the journal of a dynamic workflow (label at launched, agentId at the started of the same n).
    store.createDynRun({ runId: "wf_gu4", taskId: "t1", chatId: chat.id, name: "Ultracode", meta: {}, scriptPath: "/x", outputPath: "/y" });
    store.writeDynJournal("wf_gu4", { kind: "launched", n: 1, key: "k1", label: "Write tests" });
    store.writeDynJournal("wf_gu4", { kind: "started", n: 1, key: "k1", agentId: "wfa-1" });
    // Graph run with a worktree: open (running) and one whose run is finished although the row stays `started`.
    const graph = (id, runStatus) => {
      store.startWorkflowRun({ id: `run-${id}`, chatId: `kind-${id}`, workflowId: "wf-g", workflowName: "Order → Ship" });
      if (runStatus !== "running") store.updateWorkflowRunById(`run-${id}`, { status: runStatus });
      store.createGraphStart({ id, chatId: chat.id, childChatId: `kind-${id}`, workflowId: "wf-g", workflowName: "Order → Ship", shortName: "ship",
        background: true, worktree: true, status: "started" });
      store.changeGraphStart(id, { runId: `run-${id}`, worktreePath: `/wt/${id}`, worktreeInfo: JSON.stringify({ dir: `/wt/${id}`, branch: `cbase/graph-${id.slice(0, 8)}` }) });
    };
    graph("aaaa1111-open", "running");
    graph("bbbb2222-finished", "done");
    // Copies: k1 lives, k2 is removed.
    store.createStackCopy({ projectId: p.id, name: "k1", state: "ready" });
    const k2 = store.createStackCopy({ projectId: p.id, name: "k2", state: "ready" });
    store.changeStackCopy(k2.id, { state: "removed" });

    // If a check fails, the finally clears the seeded runs and the gate — otherwise the harness would wait for an idle that never comes.
    let gateOpen = false;
    const cleanUp = () => {
      store.endDynRun("wf_gu4", { status: "finished" });
      store.updateWorkflowRunById("run-aaaa1111-open", { status: "done" });
      if (!gateOpen) { gateOpen = true; gate.open("sub"); }
    };
    try {
      // ── A living subagent: the main agent calls cbase_agent, the subagent stands at the gate. ──
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Check" }) });
      await gate.reached("sub");
      const live = liveAgents().find((a) => String(a.chatId) === String(chat.id));
      assert.ok(live?.agentId, "no living subagent in the chat");
      const aid = live.agentId;
      const row = store.subagentsWithIds([aid])[0];
      assert.ok(row, "the subagent has no row in subagents");

      const names = [`cbase/agent-${aid}`, "cbase/agent-sa-finished", "cbase/agent-wfa-1", "cbase/agent-niemand",
        "cbase/graph-aaaa1111", "cbase/graph-bbbb2222", "cbase/graph-cccc3333", "copy/k1/main", "copy/k2/feature/x", "cbase/otherwise", "feature/login"];
      const b = userAndState(p.id, names);
      const full = (kind, fields) => ({ ...Object.fromEntries(USER_FIELDS.map((k) => [k, null])), kind, ...fields });
      assert.deepEqual(b.get(`cbase/agent-${aid}`), { user: full("subagent", { name: row.name || null, chatId: chat.id, agentId: aid }), state: "running" });
      assert.deepEqual(b.get("cbase/agent-sa-finished"), { user: full("subagent", { name: "Old reviewer", chatId: chat.id, agentId: "sa-finished" }), state: "ended" });
      assert.deepEqual(b.get("cbase/agent-wfa-1"), { user: full("workflow-agent", { name: "Write tests", chatId: chat.id, agentId: "wfa-1" }), state: "running" });
      assert.deepEqual(b.get("cbase/agent-niemand"), { user: null, state: "unknown" }, "without a row the state is unknown, never ended");
      assert.deepEqual(b.get("cbase/graph-aaaa1111"), { user: full("graph", { name: "Order → Ship", chatId: chat.id, childChatId: "kind-aaaa1111-open" }), state: "running" });
      assert.deepEqual(b.get("cbase/graph-bbbb2222"), { user: full("graph", { name: "Order → Ship", chatId: chat.id, childChatId: "kind-bbbb2222-finished" }), state: "ended" });
      assert.equal(store.graphStart("bbbb2222-finished").status, "started", "the seed: the row stays started");
      assert.deepEqual(b.get("cbase/graph-cccc3333"), { user: null, state: "unknown" });
      assert.deepEqual(b.get("copy/k1/main"), { user: full("copy", { instance: "k1" }), state: "running" });
      assert.deepEqual(b.get("copy/k2/feature/x"), { user: full("copy", { instance: "k2" }), state: "copy-removed" });
      assert.deepEqual(b.get("cbase/otherwise"), { user: null, state: "unknown" });
      assert.deepEqual(b.get("feature/login"), { user: null, state: null }, "only group \"cbase\" carries a state");

      // (3) Running chats: the chat runs (turn + living subagent) in main; a second chat in the copy k1.
      const second = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, projectId: p.id, provider: "claude", model: "claude-haiku-4-5-20251001" }) });
      store.updateChat(second.id, { instance: "copy-k1" });
      const title = store.getChat(chat.id).title;
      assert.deepEqual(runningChats(p.id, "main"), [{ chatId: chat.id, title }]);
      assert.deepEqual(runningChats(p.id, "k1"), [], "the chat of the copy is not running");
      running.add(second.id);
      try {
        assert.deepEqual(runningChats(p.id, "k1").map((c) => c.chatId), [second.id], "a turn appears at once");
        assert.deepEqual(runningChats(p.id, "main").map((c) => c.chatId), [chat.id], "the instance counts");
      } finally { running.delete(second.id); }
      assert.deepEqual(runningChats(p.id, "k1"), [], "and disappears at once");

      // The workflow run ends => ended; the subagent ends => ended; the chat no longer runs. The seeded runs first: a running dynamic
      // workflow and an open graph run would otherwise hold the idle open forever.
      cleanUp();
      await ctx.waitForIdle();
      const after = userAndState(p.id, [`cbase/agent-${aid}`, "cbase/agent-wfa-1"]);
      assert.equal(after.get(`cbase/agent-${aid}`).state, "ended");
      assert.equal(after.get("cbase/agent-wfa-1").state, "ended");
      assert.deepEqual(runningChats(p.id, "main"), []);

      // Key colors of the project: only living copies (k1), main none.
      assert.deepEqual([...keyColorsOfTheProject(p.id)], [["k1", hashSlot("k1")]]);
      assert.equal(keyColor(p.id, "main"), null);
      assert.equal(keyColor(p.id, "k2"), null, "a removed copy has no color");
    } finally { cleanUp(); }
  }, { claude: fakeClaude({ main, sub }) });
});

test("(4) the workflow agents for agent ids search via the partial index, never via a scan of the whole journal", async () => {
  await withAgentsServer(async () => {
    for (const count of [1, 3]) {
      const plan = store.dynWorkflowAgentsPlan(count);
      assert.ok(plan.some((d) => /^SEARCH j USING INDEX dyn_workflow_journal_agent\b/.test(d)), `no partial index in the plan (${count} ids): ${JSON.stringify(plan)}`);
      assert.ok(!plan.some((d) => /^SCAN j\b/.test(d)), `full scan of the journal (${count} ids): ${JSON.stringify(plan)}`);
    }
  });
});
