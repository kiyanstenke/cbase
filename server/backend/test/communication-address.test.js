// Agent communication, the three leaves without a server: the address of a `cbase_agent_send` (communication/address.js), role and
// write permission of the sender (communication/sender.js) and the ONE visibility predicate (communication/visibility.js).
//
// OWN file with its own `initStore` (like archive-store.test.js): the module-wide `db` is bound here - in a file with running
// test servers that would be a bet that nobody is writing right now.
//
// Counter-tests (which sabotage turns which test red):
//   address.js: prefix "chat" removed from the prefix list                   => "address" red (chat:<id> would be a subagent)
//   sender.js: `if (ofProfile) return "subagent"` removed                     => "sender" red (a subagent in a coding chat would be coding)
//   sender.js: WRITE_PERMISSION_CODING = "no"                                 => "write permission" red
//   visibility.js: isChildChat branch removed                                  => "visibility: child chat" red
// The role `manager`, the write permission `approval` and the two visibility exceptions for manager chats (earlier run of the own
// schedule, channel partner) are gone; the tests check the opposite: an old manager chat is "special", never writes and is never
// readable, not even through a common channel.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { readAddress } from "../electron/server/communication/address.js";
import { ROLES, WRITE_PERMISSIONS, WRITE_PERMISSION_CODING, senderOf, writePermissionToChats } from "../electron/server/communication/sender.js";
import { commonChannel, readable, readableReason } from "../electron/server/communication/visibility.js";

test("address: no prefix is a subagent, otherwise wf/graph/channel/chat - a known prefix without rest keeps its kind", () => {
  assert.deepEqual(readAddress("a1b2"), { kind: "subagent", id: "a1b2" });
  assert.deepEqual(readAddress("  reviewer "), { kind: "subagent", id: "reviewer" });
  assert.deepEqual(readAddress("foreign:x"), { kind: "subagent", id: "foreign:x" }, "an unknown prefix is a label");
  assert.deepEqual(readAddress("channel:k-1"), { kind: "channel", channelId: "k-1" });
  assert.deepEqual(readAddress("chat:c-9"), { kind: "chat", chatId: "c-9" });
  assert.deepEqual(readAddress("graph:g7"), { kind: "graph", startId: "g7" });
  // The sender address of an outer-loop card - never a subagent "outerloop:..." (as a target send.js rejects it, 400).
  assert.deepEqual(readAddress("outerloop:a-1"), { kind: "outerloop", agentId: "a-1" });
  assert.deepEqual(readAddress("wf:run-3:2"), { kind: "wf", runId: "run-3", n: 2 });
  assert.deepEqual(readAddress("wf:run-3"), { kind: "wf", runId: "run-3", n: null });
  assert.deepEqual(readAddress("chat:"), { kind: "chat", chatId: "" });
  assert.deepEqual(readAddress(undefined), { kind: "subagent", id: "" });
});

test("sender: role - marks before the chat row; special chats, app agents and every old manager chat are \"special\"", () => {
  const coding = { kind: "normal", specialRole: "" };
  const manager = { kind: "manager", specialRole: "", agentId: "ag" };
  assert.equal(senderOf(coding), "coding");
  assert.equal(senderOf(manager), "special", "a manager chat with an agent is \"special\" too");
  assert.equal(senderOf({ kind: "manager", specialRole: "", agentId: null }), "special", "manager chat without agent");
  assert.equal(senderOf({ kind: "manager", specialRole: "administrator", agentId: null }), "special");
  assert.equal(senderOf({ kind: "manager", specialRole: "pipeline", agentId: null }), "special");
  for (const kind of ["service", "context"]) assert.equal(senderOf({ kind, specialRole: "" }), "special", kind);
  assert.equal(ROLES.includes("manager"), false, "the role manager is gone");
  assert.equal(senderOf(manager, { ofProfile: "c-agent-a1" }), "subagent", "the mark takes precedence over the chat row");
  assert.equal(senderOf(coding, { ofProfile: "c-agent-a1" }), "subagent");
  assert.equal(senderOf(coding, { workflowAgent: "w1" }), "workflow");
  assert.equal(senderOf(coding, { outerLoop: "o1" }), "outer_loop");
  assert.equal(senderOf(null), "special");
});

test("write permission: the coding main agent is free, all others never - the former manager too", () => {
  assert.equal(WRITE_PERMISSION_CODING, "free", "exactly this constant opens writing for coding");
  assert.deepEqual([...WRITE_PERMISSIONS], ["free", "no"], "the write permission \"approval\" is gone");
  assert.equal(writePermissionToChats("coding"), "free");
  for (const r of ["manager", "outer_loop", "subagent", "workflow", "special", "", undefined]) assert.equal(writePermissionToChats(r), "no", String(r));
});

test("visibility: same workspace, coding chats without child chats - an old manager chat never, not even as channel partner or run of the same schedule", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-comment-"));
  try {
    store.initStore(dir);
    const t = Date.now();
    store.createWorkspace({ id: "w1", name: "W1", path: path.join(dir, "w1"), createdAt: t });
    store.createWorkspace({ id: "w2", name: "W2", path: path.join(dir, "w2"), createdAt: t });
    const chat = (id, fields = {}) => store.createChat({ id, workspaceId: "w1", createdAt: t, updatedAt: t, ...fields });
    const reader = chat("reader");
    const other = chat("other");
    const foreign = store.createChat({ id: "foreign", workspaceId: "w2", createdAt: t, updatedAt: t });
    const mgrChat = chat("mgr", { kind: "manager" });
    const administrator = chat("admin", { kind: "manager" });
    store.updateChat("admin", { specialRole: "administrator" });
    const service = chat("service", { kind: "service" });
    const kind = chat("kind");
    store.createGraphStart({ id: "g1", chatId: "other", childChatId: "kind", workflowId: "wf", workflowName: "WF", shortName: "wf", status: "running" });
    // The predicate takes no third argument; a passed one changes nothing.
    const opts = { scheduleId: "s1" };
    assert.equal(readable(reader, other, opts), true, "coding chat of the same workspace");
    assert.match(readableReason(reader, foreign, opts), /anderen Workspace/);
    assert.equal(readable(reader, store.getChat("admin"), opts), false, "special chat administrator");
    assert.equal(readable(reader, service, opts), false, "app-agent chat");
    assert.equal(readable(reader, administrator, opts), false);
    // visibility: child chat
    assert.match(readableReason(reader, store.getChat("kind"), opts), /Kind-Chat/, "a graph child chat appears only under its run");
    // An old manager chat - not even as partner of an EXISTING channel.
    assert.equal(readable(reader, mgrChat, opts), false, "without channel");
    store.createChannel({ id: "k1", workspaceId: "w1", name: "K", status: "closed" });
    store.addChannelParticipants("k1", { chatId: "reader" });
    store.addChannelParticipants("k1", { chatId: "mgr" });
    assert.equal(commonChannel("reader", "mgr")?.id, "k1", "precondition: the channel exists");
    assert.match(readableReason(reader, mgrChat, opts), /kein Coding-Chat/, "with a channel neither");
    // A run of an old schedule no longer reads an earlier run of the same schedule.
    const run1 = chat("run1", { kind: "manager", agentId: null, scheduleId: "s1" });
    const run2 = chat("run2", { kind: "manager", agentId: null, scheduleId: "s1" });
    assert.equal(readable(run2, run1, { scheduleId: "s1" }), false, "same schedule");
    assert.equal(readable(reader, run1, opts), false, "a schedule run for a coding chat");
    assert.equal(readable(reader, null, opts), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
