// Agent communication, "the description follows the execution": per run kind - coding main agent, old manager chat, administrator,
// subagent - the environment that toolchain/mcp-config.js writeMcpConfig writes for the cbase MCP server (CBASE_WRITE_PERMISSION
// from communication/sender.js), the REAL MCP server with exactly that environment (tools/list) and the send route for the same
// run kind. What the description of cbase_agent_send says about `chat:<id>` and `channel:<id>`, and whether cbase_agents_list
// names the view `start`, must match the server's answer.
//
// Counter-tests (which sabotage turns which test red):
//   mcp-config.js: line `env.CBASE_WRITE_PERMISSION = ...` removed          => "manager" red (description without chat:, server 200)
//   sender.js: WRITE_PERMISSION_CODING = "no"                                => "coding" red (description without chat:, server 501)
//   tools/agents.js: condition `u.withAgent` on the view start removed       => "manager" red (start named, the tool throws)
//   tools/agents.js: condition `mainAgent` on the CHANNEL set removed        => "subagent" red (channel: named, server 403)
//   tools/agents.js: `!u.onlySubagents` on `mainAgent` removed               => "administrator" red (channel:/wf: named, server 403)
//   send.js: `!WRITES_CHANNEL.has(role)` on the channel back to subagent/workflow => "administrator"/"service" red (channel message 200)
//   tools/agents.js without `if (u.outerLoop) return OUTER_LOOP_SEND;`      => "outer loop" red (channel:<id> named, server 403)
// There is no manager agent that writes any more: the role `manager` and the write permission `approval` are gone
// (communication/sender.js), as is the named set `manager` (mcp/toolsets.js). An old manager chat is "special" like the
// administrator - its description names only its own subagents, and its send route is locked (runs/manager-lock.js, 409).

import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { writeMcpConfig } from "../electron/server/toolchain/mcp-config.js";
import { json, makeChat, makeWorkspace, ok, withMcp, withServer } from "./server-harness.mjs";

const NAMES_CHAT = /chat:<id>/;
const NAMES_CHANNEL = /channel:<id>/;
// The view 'start' is named in the field `view` (tools/agents.js listViews), no longer in the description.
const NAMES_START = /'start'/;

async function descriptions(base, root, cfg) {
  const { servers } = writeMcpConfig(path.join(root, `mcp-${crypto.randomUUID()}.json`), cfg);
  const env = { ...servers.cbase.env, CBASE_BASE_URL: base };
  let tools = [];
  await withMcp(env, async ({ rpc }) => { tools = (await rpc("tools/list", {})).result?.tools || []; });
  const t = (n) => tools.find((x) => x.name === n);
  return { env, send: t("cbase_agent_send"), list: t("cbase_agents_list"), agent: t("cbase_agent") };
}

test("description = execution: per run kind agent_send and agents_list say what the send route does", async () => {
  await withServer(async ({ base, wsPath, root }) => {
    const ws = await makeWorkspace(base, "Description", wsPath);
    const coding = await makeChat(base, ws.id);
    const target = await makeChat(base, ws.id);
    const tt = Date.now();
    const mgr = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "manager", agentId: "ag-1", createdAt: tt, updatedAt: tt });
    const verw = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "manager", createdAt: tt, updatedAt: tt });
    store.updateChat(verw.id, { specialRole: "administrator" });
    const k = await ok(`${base}/api/workspaces/${ws.id}/channels`, { method: "POST", body: JSON.stringify({ name: "K", participants: [coding.id, target.id], creatorChatId: coding.id, cap: 0 }) });
    const send = (chatId, to, extra = {}) => json(`${base}/api/chats/${chatId}/agent/send`, { method: "POST", body: JSON.stringify({ to, message: "Hello", from: "agent", ...extra }) });

    // Coding main agent (full set): channel: yes, chat: free (server: through the open channel), start yes.
    {
      const d = await descriptions(base, root, { chatId: coding.id, workspaceId: ws.id });
      assert.equal(d.env.CBASE_WRITE_PERMISSION, "free");
      assert.equal(d.env.CBASE_ONLY_SUBAGENTS, undefined, "coding: no special mark");
      assert.match(d.send.description, /wf:</);
      assert.match(d.send.description, NAMES_CHAT, "coding: chat:<id> named");
      assert.doesNotMatch(d.send.description, /approval/, "coding: without approval");
      assert.match(d.send.description, NAMES_CHANNEL);
      // A coding chat reads the channel etiquette only here (the system prompt section on channels does not name it).
      assert.match(d.send.description, /CHANNEL \([^)]*\): [^.]*short and to the point, the channel is no chat with the user/, "coding: the channel etiquette stands at the channel");
      assert.match(d.list.inputSchema.properties.view.description, NAMES_START);
      assert.ok(d.list.inputSchema.properties.view.enum.includes("start"));
      const cr = await send(coding.id, `chat:${target.id}`);
      assert.equal(cr.status, 200, JSON.stringify(cr.body));
      assert.equal(cr.body.channelId, k.id, "through the existing channel");
      const kr = await send(coding.id, `channel:${k.id}`);
      assert.equal(kr.status, 200, JSON.stringify(kr.body));
    }
    // An old manager chat (explicit list without cbase_agent): "special" - neither chat: nor channel:, no approval, start NOT; the
    // send route is locked (runs/manager-lock.js).
    {
      const d = await descriptions(base, root, { chatId: mgr.id, workspaceId: ws.id, tools: ["cbase_agents_list", "cbase_agent_send"] });
      assert.equal(d.env.CBASE_WRITE_PERMISSION, undefined, "manager: no write permission");
      assert.equal(d.env.CBASE_ONLY_SUBAGENTS, "1", "manager: the mark only-subagents");
      assert.doesNotMatch(d.send.description, NAMES_CHANNEL);
      assert.doesNotMatch(d.send.description, NAMES_CHAT, "manager: chat:<id> not named");
      assert.doesNotMatch(d.send.description, /approval/);
      assert.doesNotMatch(d.list.inputSchema.properties.view.description, NAMES_START, "without cbase_agent no view start");
      assert.ok(!d.list.inputSchema.properties.view.enum.includes("start"));
      assert.equal(d.agent, undefined);
      const r = await send(mgr.id, `chat:${target.id}`);
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.managerLocked, true);
      // A run without cbase_agent asks for the view start in vain - the tool says so itself.
      await withMcp({ ...(d.env), CBASE_BASE_URL: base }, async ({ call }) => {
        const s = await call("cbase_agents_list", { view: "start" });
        assert.equal(s.isError, true, s.text);
      });
    }
    // Administrator (explicit list WITH the subagent family): no chat:, no channel:, no wf:, start yes - the server rejects all three,
    // even as participant of a channel that someone created through the workspace route. The same for a chat of a foreign kind with
    // the full catalog - an unknown kind: an old app-agent chat (service) is read-only (runs/only-readable.js) and would get 409
    // before the send route.
    const service = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "unknown", createdAt: tt, updatedAt: tt });
    for (const [who, special, cfg] of [
      ["Administrator", verw, { tools: ["cbase_agent", "cbase_agent_output", "cbase_agent_send", "cbase_agent_stop", "cbase_agents_list"] }],
      ["Service", service, {}],
    ]) {
      const d = await descriptions(base, root, { chatId: special.id, workspaceId: ws.id, ...cfg });
      assert.equal(d.env.CBASE_WRITE_PERMISSION, undefined);
      assert.equal(d.env.CBASE_ONLY_SUBAGENTS, "1", `${who}: mark only-subagents`);
      assert.doesNotMatch(d.send.description, NAMES_CHAT, `${who}: chat:<id> not named`);
      assert.doesNotMatch(d.send.description, NAMES_CHANNEL, `${who}: channel:<id> not named`);
      assert.doesNotMatch(d.send.description, /wf:</, `${who}: wf: not named`);
      assert.match(d.send.description, /SUBAGENT/);
      assert.match(d.list.inputSchema.properties.view.description, NAMES_START);
      // The administrator is a manager chat - its send route is locked (409 before any check), no channel arises with it.
      const locked = special.kind === "manager";
      assert.equal((await send(special.id, `chat:${target.id}`)).status, locked ? 409 : 403);
      assert.equal((await send(special.id, "wf:run-x:1")).status, locked ? 409 : 403, `${who}: wf:`);
      if (locked) {
        const kv = await json(`${base}/api/workspaces/${ws.id}/channels`, { method: "POST", body: JSON.stringify({ name: `K-${who}`, participants: [special.id, target.id], creatorChatId: special.id, cap: 0 }) });
        assert.equal(kv.status, 409, `${who}: no channel with a manager chat ${JSON.stringify(kv.body)}`);
        continue;
      }
      const ks = await ok(`${base}/api/workspaces/${ws.id}/channels`, { method: "POST", body: JSON.stringify({ name: `K-${who}`, participants: [special.id, target.id], creatorChatId: special.id, cap: 0 }) });
      const rk = await send(special.id, `channel:${ks.id}`);
      assert.equal(rk.status, 403, `${who}: channel: ${JSON.stringify(rk.body)}`);
      assert.match(rk.body.error, /nur deine eigenen Subagenten/);
      assert.equal(store.listChannelMessages(ks.id).filter((n) => n.senderKind === "chat").length, 0, `${who}: nothing in the channel`);
    }
    // Subagent (depth 1, profile): neither chat: nor channel: - the server rejects both.
    {
      const profile = `${coding.id}-agent-x1`;
      const d = await descriptions(base, root, { chatId: coding.id, workspaceId: ws.id, agentDepth: 1, profileKey: profile });
      assert.equal(d.env.CBASE_WRITE_PERMISSION, undefined);
      assert.doesNotMatch(d.send.description, NAMES_CHAT);
      assert.doesNotMatch(d.send.description, NAMES_CHANNEL, "subagent: channel:<id> not named");
      assert.equal((await send(coding.id, `chat:${target.id}`, { ofProfile: profile })).status, 403);
      assert.equal((await send(coding.id, `channel:${k.id}`, { ofProfile: profile })).status, 403);
    }
    // Outer-loop run: its own mark; agent_send names ONLY chat:<id> (no channel:, no wf:), agents_list only three views - the server
    // sends to chat: (as the agent, without a channel) and rejects channel:/wf:, the view start is 400.
    {
      const ol = store.createOuterLoopAgent({ id: crypto.randomUUID(), workspaceId: ws.id, name: "Observer", trigger: [{ kind: "quiet", minutes: 5 }], provider: "claude", model: "m", tools: ["cbase_agents_list", "cbase_agent_send"] });
      store.createOuterLoopRun({ id: "ol-run", agentId: ol.id, chatId: coding.id, trigger: "quiet", set: { cbase: ["cbase_agents_list", "cbase_agent_send", "cbase_chat_analysis"], builtin: [], extern: [], dropped: { fence: [], approval: [] } } });
      const marker = `${ol.id}:ol-run`;
      try {
        const d = await descriptions(base, root, { chatId: coding.id, workspaceId: ws.id, tools: ["cbase_agents_list", "cbase_agent_send", "cbase_chat_analysis"], outerLoop: marker });
        assert.equal(d.env.CBASE_OUTER_LOOP, marker);
        assert.match(d.send.description, NAMES_CHAT, "outer loop: chat:<id> named");
        assert.doesNotMatch(d.send.description, NAMES_CHANNEL, "outer loop: channel:<id> not named");
        assert.doesNotMatch(d.send.description, /wf:</, "outer loop: wf: not named");
        assert.doesNotMatch(d.list.inputSchema.properties.view.description, NAMES_START);
        assert.deepEqual(d.list.inputSchema.properties.view.enum, ["summary", "chats", "chat"]);
        assert.equal(d.agent, undefined, "no delegation");
        const r = await send(coding.id, `chat:${target.id}`, { outerLoop: marker });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.channelId, undefined, "without channel");
        assert.equal((await send(coding.id, `channel:${k.id}`, { outerLoop: marker })).status, 403);
        assert.equal((await send(coding.id, "wf:run-x:1", { outerLoop: marker })).status, 403);
        await withMcp({ ...(d.env), CBASE_BASE_URL: base }, async ({ call }) => {
          const s = await call("cbase_agents_list", { view: "start" });
          assert.equal(s.isError, true, s.text);
        });
        assert.equal((await json(`${base}/api/chats/${coding.id}/communication?${new URLSearchParams({ view: "start", outerLoop: marker })}`)).status, 400);
      } finally { store.outerLoopRunEnd("ol-run", { state: "finished" }); }
    }
    // A run without cbase_agent_send in its set gets no write-permission mark (it would say nothing).
    {
      const d = await descriptions(base, root, { chatId: mgr.id, workspaceId: ws.id, tools: ["cbase_agents_list"] });
      assert.equal(d.env.CBASE_WRITE_PERMISSION, undefined);
      assert.equal(d.send, undefined);
    }
  });
});
