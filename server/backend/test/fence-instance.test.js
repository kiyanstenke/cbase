// Guard "files in the copy", part fence and target instance. The gap: from a project network (`ctx.fence`) the target instance of
// every instance-routed route used to be main (devtools/routes.js instanceForRequest, channels/messages.js channelSituation with
// the project as origin): a copy token wrote through the language service (lsp/agents.js agentAction, which writes the occurrences
// itself) and through channel files into main (the token route: channel-copy.test.js (7)-(9)). The contract: from a project
// network the TOKEN decides the instance, never the chat; a `?chat` must lie in it; no token of one instance reaches files, code
// or git of another instance of the same project.
//
// The promises, each with the way that breaks it:
//   (1) chatInstance (pure, against a test view): the chat lies in the project AND in the token's instance. A copy token with the
//       chat of main and a main token with the chat of the copy (child chats included) are NO; a living run of the chat in the
//       token's instance is YES; "cannot be determined" (locked copy, throwing source, view without the question) is NO.
//       (1b) browser: `proj:<id>` belongs to main, `proj:<id>@copy-<name>` to the copy, an agent browser to the chat OF the instance.
//       (1c) channel sender: a chat OF the instance.
//   (2) targetInstance (devtools/routes.js): with a token the token's instance, a ?chat must lie in it (else 403); a fence value
//       without a check, without an instance or for another project is 403, never main; without a token the chat's binding,
//       otherwise main as before. (2b) fenceContext carries identifier and instance (frozen).
//   (3) The code route on the write path (PUT /files/write, real copy on the fake docker): copy token with ?chat=<main chat> => 403
//       and main unchanged (sha256), main token with ?chat=<copy chat> => 403; the token's own way writes.
//   (4) Language service of the agents with a copy token: the same actions IN the copy. The language server starts in the copy's
//       container, reading and writing go through it (never through B's disk, where main lies): a file only the copy has works
//       (never "not found" from main), rename writes into the copy and main stays byte-exact; a copy that is not ready has no
//       language service and writes nothing; outside the project folder 403. The main token writes into main (control, through the
//       fake language server test/fake-lsp.mjs, `changed` with absolute paths). The editor (`/lsp/*`) in the copy: files-in-copy.test.js.
//   `:chat` must check more than the PROJECT: a copy token must not start a monitor in the main container (`docker exec … sh -c
//   <command>`, 201), a subagent in main's core or an alarm in its turn through the run routes of a main chat; nor the main token in the copy.
//   (5) Pure, over the WHOLE table: every row with a chat in the path accepts the own chat (and the child of its graph run) with both
//       tokens and rejects the chat of the other instance (403, "instance other than"), except the named pure read rows (`:chatInProject`,
//       GET only, reason `readInProject`: chat, chat-history, ?chatId of the artifacts); it lets the living-run case through (a living
//       run of the chat in the token's instance) and never a foreign or projectless chat; `chatInProject` on a writing method checks
//       the instance.
//   (6) The dispatcher with two running turns (main chat in main, copy chat in the copy, both at the gate): the copy token with the
//       main chat and the main token with the copy chat get a fence 403 on 17 run routes (monitor, agent, wakeup, agent/send|stop|output,
//       agents, monitor/stop, ask, permission-request, dyn-workflows (POST, run, stop, structured-output), graph-workflows start|stop,
//       captures), and after quiet NO call of the fake docker carries their marker; chat row and history stay readable in the
//       project (200); the own chat starts its monitor in ITS container (201). The living-run case at the dispatcher is held by
//       fence.test.js.
//   (7) The subagent of main in a chat that has moved into the copy: the fence checks the chat (now in the copy, so the copy token passes),
//       but the agent routes must also require that the agent lives in the token's instance, otherwise 403. (7b) the same for an agent
//       only in the stored state; (7c) short names that main and copy each use for their own subagent.
//
// No clock: the copy is built through the real sequence (stacks-copy-harness.mjs), waits are on states. Every connection of the
// harness is closed in its finally.
//
// COUNTER-TESTS (one sabotage each; the whole file run, red without exit hang):
//   fence.js, fence-table.js, devtools/routes.js from before this feature         => the whole file red (`targetInstance` missing)
//   fence.js: chatInstance checks the project only                                  => (1), (1b), (1c), (2), (2b), (3) red
//   fence.js: browser only compares main's key                                      => (1b) red
//   fence.js: sender without chatInstance                                           => (1c) red
//   routes.js: target takes the chat instead of the token                           => (2) red
//   routes.js: target without chatReason                                            => (2), (3) red
//   routes.js: target falls back to main                                            => (2) red
//   fence.js: underProject with realpath for the copy                               => (4) red
//   devtools/routes.js /api/lsp without the copy branch (lspCopyTarget)             => (4) red (the file only the copy has: 404 from main)
//   lsp/limit.js writeForAgent also writes for the copy through B                   => (4) red (409 instead of written)
//   fence.js: `:chat` checks the project only                                       => (5) red (chat-change PATCH), (6) red (201 instead of 403)
//   fence.js: chatInProject does not check the instance on writes                   => (5) red (the safe side)
//   fence-table.js: chat-monitor on `:chatInProject`                                => (5) red (exception without reason and list); (6) stays
//                                          green because the POST falls to the safe side (writing chatInProject checks the instance too)
//   fence-table.js: ?chatId of chat-artifacts-write on chatInProject                => (5) red (list of exceptions)
//   routes: the 403 line at /agent/send removed                                      => (7) red (200 instead of 403)
//   routes: the start-in-foreign-instance line removed                              => (7) red (201, the child runs)
//   routes: the instance filter in the agent list ineffective                        => (7) red (GET /agents names main's agent)
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { endAllSessions } from "../electron/server/lsp/sessions.js";
import { PARAMETER, BODY, TOKEN_HEADER, productionView, checkScope, setFenceSource, fenceContext } from "../electron/server/projectbox/fence.js";
import { FENCE_TABLE, parameterOf, rowFor } from "../electron/server/projectbox/fence-table.js";
import { tokenFor } from "../electron/server/projectbox/token.js";
import { setCreationOptions } from "../electron/server/projectbox/recreate.js";
import { codeProjectRoutes, targetInstance } from "../electron/server/devtools/routes.js";
import { instanceIsCopy, instanceNameFromIdentifier, setInstanceSource, setCopySource } from "../electron/server/runs/instance.js";
import { coreWithAgent, idleNow } from "../electron/server/runs/agents.js";
import { fakeClaude, json, waitForTruthy } from "./agent-harness.mjs";
import { buildCopy, inCopy, situationDefault, withCopy, writeInCopy } from "./stacks-copy-harness.mjs";
import { setCopyState } from "../electron/server/stacks/state.js";

const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// ── A test view: two instances (main, copy k1) of project pA, plus chats in both ───────────────────────────────────
const KH = "pA/main";
const KK = "pA/copy-k1";
const chatsTheView = {
  cH: { id: "cH", projectId: "pA" }, // in main
  cK: { id: "cK", projectId: "pA" }, // in the copy
  cKind: { id: "cKind", projectId: null }, // child chat of a graph run of cK (pinned to the copy)
  cKindH: { id: "cKindH", projectId: null }, // child chat of a graph run of cH
  cB: { id: "cB", projectId: "pB" },
  cO: { id: "cO", projectId: null },
};
function view({ binding = {}, runs = [], withoutQuestion = false } = {}) {
  const identifier = { cH: KH, cK: KK, cKind: KK, cKindH: KH, ...binding };
  const starts = { cKind: { chatId: "cK" }, cKindH: { chatId: "cH" } };
  // Every browser carries the debug host of its instance (`forIdentifier` sets the IP of the token).
  const browser = {
    brH: { scopeKey: "proj:pA", kind: "user", debugHost: IP_H }, brK: { scopeKey: "proj:pA@copy-k1", kind: "user", debugHost: IP_K }, brB: { scopeKey: "proj:pB", kind: "user", debugHost: "10.230.6.2" },
    brAgH: { kind: "agent", chatId: "cH", scopeKey: "agent:chat-cH:1", debugHost: IP_H }, brAgK: { kind: "agent", chatId: "cK", scopeKey: "agent:chat-cK:1", debugHost: IP_K },
  };
  return {
    project: (id) => ({ pA: { id: "pA", workspaceId: "w1", path: "/ws/pA" }, pB: { id: "pB", workspaceId: "w1", path: "/ws/pB" } })[id] || null,
    chat: (id) => chatsTheView[id] || null, graphStartOfChild: (id) => starts[id] || null,
    channelParticipants: () => [{ chatId: "cH" }, { chatId: "cK" }], browser: (id) => browser[id] || null,
    ...(withoutQuestion ? {} : {
      instanceForChat: (c) => {
        const k = identifier[c.id];
        if (k === "RAISES") throw new Error("source not readable");
        if (k === "LOCKED") return { instance: null, identifier: KK, locked: true };
        return { instance: { projectId: "pA" }, identifier: k ?? null, locked: false };
      },
    }),
    runInInstance: (chatId, k) => runs.some(([c, kk]) => c === chatId && kk === k),
  };
}
const IP_H = "10.230.5.2";
const IP_K = "10.230.7.2";
const per = (s, K) => ({ ...s, P: "pA", W: "w1", K, IP: K === KK ? IP_K : IP_H });

// ── (1) chatInstance: the chat lies in the project AND in the token's instance ─────────────────────────────────────────────────
test("(1) chatInstance: only a chat of the token's instance; the copy token not the main chat, the main token not the copy chat", () => {
  const check = (s, K, chat) => PARAMETER.chatInstance(per(s, K), chat);
  const s = view();
  // main token
  assert.equal(check(s, KH, "cH"), null);
  assert.equal(check(s, KH, "cKindH"), null, "the child of a main chat lies in main");
  assert.match(check(s, KH, "cK"), /instance other than/);
  assert.match(check(s, KH, "cKind"), /instance other than/, "the child of a copy chat is pinned to the copy");
  // copy token
  assert.equal(check(s, KK, "cK"), null);
  assert.equal(check(s, KK, "cKind"), null);
  assert.match(check(s, KK, "cH"), /instance other than/, "the main chat with the copy token: the write path into main");
  assert.match(check(s, KK, "cKindH"), /instance other than/);
  // Project first: foreign and projectless chats are no chats of this project
  for (const K of [KH, KK]) for (const c of ["cB", "cO", "existsNot"]) assert.match(check(s, K, c), /not a chat of this project/, `${K} ${c}`);
  // A LIVING run of the chat is in the token's instance: a subagent in main whose chat has since moved in
  const run = view({ runs: [["cK", KH], ["cH", KK]] });
  assert.equal(check(run, KH, "cK"), null, "the subagent in main reaches the chat that has moved in");
  assert.equal(check(run, KK, "cH"), null, "likewise in the other direction");
  assert.match(check(run, KK, "cKindH"), /instance other than/, "a run counts only for ITS chat");
  // "Cannot be determined" is NO: a locked copy, a throwing source, a view without the question, a binding without identifier
  assert.match(check(view({ binding: { cK: "LOCKED" } }), KK, "cK"), /instance other than/);
  assert.match(check(view({ binding: { cH: "RAISES" } }), KH, "cH"), /cannot be read/);
  assert.match(check(view({ withoutQuestion: true }), KH, "cH"), /cannot be determined/);
  assert.match(check(view({ binding: { cH: null } }), KH, "cH"), /instance other than/);
});

test("(1b) the browser check is about the instance: proj:<id> to main, proj:<id>@copy-<name> to the copy; an agent browser to the chat OF the instance", () => {
  const b = (K, id) => PARAMETER.browser(per(view(), K), id);
  assert.equal(b(KH, "brH"), null);
  assert.equal(b(KK, "brK"), null);
  assert.match(b(KK, "brH"), /not a browser of this instance/, "the project browser of main with the copy token");
  assert.match(b(KH, "brK"), /not a browser of this instance/, "the project browser of the copy with the main token");
  assert.equal(b(KH, "brAgH"), null);
  assert.equal(b(KK, "brAgK"), null);
  assert.match(b(KK, "brAgH"), /not a browser of this instance/);
  assert.match(b(KH, "brAgK"), /not a browser of this instance/);
  for (const K of [KH, KK]) assert.match(b(K, "brB"), /not a browser of this instance/);
  assert.match(b(KH, "missing"), /not a browser/);
});

test("(1c) the sender of a channel message is a chat OF the token's instance", () => {
  const p = (K, chatId) => BODY.senderOfTheProject(per(view(), K), { chatId }, { params: { channel: "k" } });
  assert.equal(p(KH, "cH"), null);
  assert.equal(p(KK, "cK"), null);
  assert.match(p(KK, "cH"), /instance other than/, "a copy token does not speak as a chat of main");
  assert.match(p(KH, "cK"), /instance other than/);
  assert.match(p(KH, "cO"), /not a chat of this project/);
});

// cbase_agent_send from a project network. The sender is the chat in the path (`:chat`, already the instance); the body names the
// target. chat:<id> crosses project and instance borders; the route checks the workspace. Counter-test: body removed from the
// "chat-agent-send" row, or the participant check for channel: removed => red; the old chat branch back => red.
test("(1d) agent_send from a project network: channel:<id> only as a participant, chat:<id> to any chat (project and instance borders open)", () => {
  const row = FENCE_TABLE.find((z) => z.family === "chat-agent-send");
  assert.equal(row.body, "agentSendInScope", "the row checks the body");
  const r = (K, chat, b) => BODY.agentSendInScope(per(view(), K), b, { params: { chat } });
  // channel: the test view has cH and cK as participants of every channel.
  assert.equal(r(KH, "cH", { to: "channel:k" }), null);
  assert.match(r(KH, "cKindH", { to: "channel:k" }) ?? "", /not a participant/);
  // chat: every instance and every project; the route checks the workspace.
  for (const [K, chat, target] of [[KH, "cH", "cKindH"], [KH, "cH", "cK"], [KK, "cK", "cH"], [KH, "cH", "cB"], [KH, "cH", "cO"]]) {
    assert.equal(r(K, chat, { to: `chat:${target}` }), null, `${K} ${chat} → ${target}`);
  }
  // an own subagent (without prefix), also through the alias agentId, is checked by the route; wf:/graph: it rejects.
  for (const b of [{ to: "a1" }, { agentId: "a1" }, { to: "wf:r:1" }, { to: "graph:g" }]) assert.equal(r(KK, "cK", b), null, JSON.stringify(b));
  // The fence context of the route no longer knows the border of the cbase_agents_list lists.
  assert.equal(fenceContext(MAIN_ROW, view()).chatInProject, undefined);
});

// ── (2) targetInstance: from a project network the token decides ────────────────────────────────────────────────────────────
const MAIN_ROW = Object.freeze({ projectId: "pA", instance: "main", identifier: KH });
const COPY_ROW = Object.freeze({ projectId: "pA", instance: "copy-k1", identifier: KK });
const fenceOf = (row, s = view()) => fenceContext(row, s);

test("(2) targetInstance: with a token the token's instance, a ?chat must lie in it; without a token the chat's binding, otherwise main", () => {
  const proj = { id: "pA" };
  const ctx = (fence) => ({ proj, fence });
  // Copy token: target copy, without ?chat and with the copy chat; with the main chat 403
  assert.equal(targetInstance(ctx(fenceOf(COPY_ROW)), null), COPY_ROW);
  assert.equal(targetInstance(ctx(fenceOf(COPY_ROW)), "cK"), COPY_ROW);
  assert.throws(() => targetInstance(ctx(fenceOf(COPY_ROW)), "cH"), (e) => e.status === 403 && /instance other than/.test(e.message));
  // Main token: target main; with the copy chat 403
  assert.equal(targetInstance(ctx(fenceOf(MAIN_ROW)), null), MAIN_ROW);
  assert.equal(targetInstance(ctx(fenceOf(MAIN_ROW)), "cH"), MAIN_ROW);
  assert.throws(() => targetInstance(ctx(fenceOf(MAIN_ROW)), "cK"), (e) => e.status === 403);
  // The subagent in main whose chat now lies in the copy (run lives in main) => allowed, target main
  assert.equal(targetInstance(ctx(fenceOf(MAIN_ROW, view({ runs: [["cK", KH]] }))), "cK"), MAIN_ROW);
  // Closed: a fence value without a check, without an instance or for another project is 403, never main
  assert.throws(() => targetInstance(ctx({ projectId: "pA", instance: COPY_ROW }), "cH"), (e) => e.status === 403 && /cannot be determined/.test(e.message));
  assert.throws(() => targetInstance(ctx({ projectId: "pA", chatReason: () => null }), null), (e) => e.status === 403 && /carries no instance/.test(e.message));
  assert.throws(() => targetInstance({ proj: { id: "pB" }, fence: fenceOf(COPY_ROW) }, null), (e) => e.status === 403 && /another project/.test(e.message));
  // Without a token: the chat's binding or main (UI, client, iOS)
  const mainRow = { projectId: "pA", instance: "main", identifier: KH };
  const copyRow = { projectId: "pA", instance: "copy-k1", identifier: KK };
  setInstanceSource((pid, inst = "main") => (pid === "pA" ? (inst === "main" ? mainRow : inst === "copy-k1" ? copyRow : null) : null));
  setCopySource((chatId) => (chatId === "cK" ? { projectId: "pA", instance: "copy-k1" } : null));
  try {
    assert.equal(targetInstance(ctx(undefined), null), mainRow, "without ?chat main");
    assert.equal(targetInstance(ctx(undefined), "cH"), mainRow);
    assert.equal(targetInstance(ctx(undefined), "cK"), copyRow, "without a token the chat decides");
  } finally { setInstanceSource(null); setCopySource(null); }
});

test("(2b) fenceContext carries identifier and instance of the token; instanceIsCopy and instanceNameFromIdentifier", () => {
  const z = fenceContext(COPY_ROW, view());
  assert.equal(z.identifier, KK);
  assert.equal(z.instance, COPY_ROW);
  assert.equal(z.projectId, "pA");
  assert.equal(z.projectPath, "/ws/pA");
  assert.equal(z.chatReason("cK"), null);
  assert.ok(z.chatReason("cH"));
  assert.throws(() => { z.identifier = "x"; }, TypeError, "the value is frozen");
  assert.equal(instanceIsCopy(COPY_ROW), true);
  assert.equal(instanceIsCopy(MAIN_ROW), false);
  assert.equal(instanceIsCopy({ projectId: "pA" }), false, "without a name main");
  assert.equal(instanceIsCopy(null), false);
  assert.equal(instanceNameFromIdentifier(KK), "copy-k1");
  assert.equal(instanceNameFromIdentifier(KH), "main");
  assert.equal(instanceNameFromIdentifier(null), "main");
});

// ── (3) The code route on the write path, (4) the language service: real copy on the fake docker ────────────────────────────────
function stubResponse() {
  const r = { status: 0, parts: [], writeHead(c) { r.status = c; }, write(d) { r.parts.push(Buffer.from(d)); return true; }, end(d) { if (d) r.parts.push(Buffer.from(d)); } };
  Object.defineProperty(r, "json", { get: () => { try { return JSON.parse(Buffer.concat(r.parts).toString("utf8")); } catch { return null; } } });
  return r;
}
async function route(pid, { method, sub, query = "", body, fence }) {
  const req = new PassThrough();
  req.method = method;
  req.headers = { "content-type": "application/json" };
  req.end(JSON.stringify(body ?? {}));
  const res = stubResponse();
  const url = new URL(`http://x/api/projects/${pid}${sub}${query}`);
  await codeProjectRoutes({ req, res, url, p: url.pathname, m: method, pid, sub, proj: store.getProject(pid), fence });
  return res;
}
async function chatInProject(ctx, pid, title) {
  const c = await json(`${ctx.base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ctx.ws.id, projectId: pid, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
  await json(`${ctx.base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
  return c;
}

test("(3) code route: the copy token with ?chat=<main chat> does not write into main (403), nor the main token with ?chat=<copy chat>; the token's own way writes", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    const cH = await chatInProject(ctx, pid, "Main chat");
    const cK = ctx.chat;
    await json(`${ctx.base}/api/chats/${cK.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
    await buildCopy(b, { chatId: cK.id });
    const mainRow = store.projectInstance(pid, "main");
    const copyRow = store.projectInstance(pid, "copy-k1");
    assert.ok(mainRow && copyRow, "both instance rows exist");
    const viewProd = productionView();
    const fenceH = fenceContext(mainRow, viewProd);
    const fenceK = fenceContext(copyRow, viewProd);
    const file = path.join(b.s.path, "shielded.txt");
    fs.writeFileSync(file, "Main\n");
    const prior = sha(file);
    const write = (fence, query, content) => route(pid, { method: "PUT", sub: "/files/write", query, body: { path: "shielded.txt", content }, fence });

    // The copy token with the main chat: 403, main unchanged.
    let r = await write(fenceK, `?chat=${cH.id}`, "FROM THE COPY\n");
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.match(r.json.error, /Fence/);
    assert.equal(sha(file), prior, "the copy token wrote into main with the main chat");
    // The main token with the copy chat: 403, main unchanged.
    r = await write(fenceH, `?chat=${cK.id}`, "WITH THE COPY CHAT\n");
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.equal(sha(file), prior, "the main token wrote with the copy chat");
    // A token for another project (fence value without copy row) is 403, so is a fence value without a check.
    r = await write({ projectId: "other", instance: mainRow, chatReason: () => null }, "", "FOREIGN\n");
    assert.equal(r.status, 403);
    r = await write({ projectId: pid, instance: mainRow }, `?chat=${cH.id}`, "WITHOUT CHECK\n");
    assert.equal(r.status, 403);
    assert.equal(sha(file), prior);
    // The control: the main token without ?chat and with the main chat writes into main.
    r = await write(fenceH, `?chat=${cH.id}`, "MAIN WITH MAIN CHAT\n");
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(fs.readFileSync(file, "utf8"), "MAIN WITH MAIN CHAT\n");
    r = await write(fenceH, "", "MAIN WITHOUT CHAT\n");
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(fs.readFileSync(file, "utf8"), "MAIN WITHOUT CHAT\n");
  });
});

test("(4) language service of the agents: a copy token works IN the copy (read and rename through its container, main stays byte-exact); not ready => no service, nothing written; the main token writes into main", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
    await buildCopy(b, { chatId: ctx.chat.id });
    const tH = tokenFor(store.projectInstance(pid, "main"));
    const tK = tokenFor(store.projectInstance(pid, "copy-k1"));
    const ts = path.join(b.s.path, "a.ts");
    const text = "export const alt = 1;\nexport const y = alt + 1;\n";
    fs.writeFileSync(ts, text);
    const prior = sha(ts);
    // The copy holds the same file with other text (written through its container, the upper layer), plus one only there.
    const textK = "export const alt = 2;\nexport const z = alt + FAILED;\n";
    writeInCopy(b, ts, textK);
    const onlyK = path.join(b.s.path, "only-in-the-copy.ts");
    writeInCopy(b, onlyK, "export const FAILED = 1;\n");
    assert.equal(fs.existsSync(onlyK), false, "the file only the copy has does not lie in main");
    const lsp = async (token, body) => {
      const r = await fetch(`${ctx.base}/api/lsp`, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close", [TOKEN_HEADER]: token }, body: JSON.stringify(body) });
      return { status: r.status, data: await r.json() };
    };
    const rename = { file: ts, action: "rename", line: 1, column: 14, newName: "newName" };
    const FAKE_LSP = new URL("./fake-lsp.mjs", import.meta.url).pathname;
    const lspStarts = () => b.fd.calls().filter((a) => a.args[0] === "exec" && a.args.includes(FAKE_LSP));
    const savedEnvironment = process.env.CBASE_LSP_FAKE;
    process.env.CBASE_LSP_FAKE = JSON.stringify([process.execPath, FAKE_LSP]);
    try {

    // Reading in the copy: the text of the COPY (FAILED on line 2), and a file only the copy has is not "not found".
    let r = await lsp(tK, { file: ts, action: "diagnostics" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.diagnostics.map((d) => [d.range.start.line, d.severity]), [[2, "error"]], JSON.stringify(r.data));
    assert.equal(lspStarts().length, 1, "one language server, in the copy's container");
    assert.ok(lspStarts()[0].args.includes(b.copy), JSON.stringify(lspStarts()[0].args));
    r = await lsp(tK, { file: onlyK, action: "diagnostics" });
    assert.equal(r.status, 200, `a file only the copy has: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.diagnostics.length, 1, JSON.stringify(r.data));
    r = await lsp(tK, { file: ts, action: "hover", line: 1, column: 14 });
    assert.equal(r.data.contents, "**alt**", JSON.stringify(r.data));
    // Writing in the copy: rename writes there, main stays byte-exact.
    r = await lsp(tK, rename);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data, { changed: [ts] });
    assert.equal(sha(ts), prior, "the language service wrote into main for the copy token");
    assert.equal(inCopy(b, b.s.path, "cat", ts), "export const newName = 2;\nexport const z = newName + FAILED;", "renamed in the copy");
    // Files outside the project folder stay 403.
    r = await lsp(tK, { file: "/etc/passwd.ts", action: "diagnostics" });
    assert.equal(r.status, 403, JSON.stringify(r.data));
    // The control: the main token renames in main and writes there, with its own language server.
    r = await lsp(tH, rename);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.changed, [ts], JSON.stringify(r.data));
    assert.equal(fs.readFileSync(ts, "utf8"), "export const newName = 1;\nexport const y = newName + 1;\n");
    assert.equal(lspStarts().length, 2, "the main token got its own language server");
    // Finally: a copy that is not ready (clearing away from step 0) has no language service (the core's lock): the agent is told,
    // nothing is written. (If the state changes BETWEEN computing and writing, `beforeWrite` with writeLockCopy holds: 409
    // COPY_NOT_READY; lsp-agents.test.js covers the computation through `locked`.)
    setCopyState(b.k.id, "clearAway", { phase: "save" });
    r = await lsp(tK, { file: ts, action: "rename", line: 1, column: 15, newName: "third" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.supported, false, JSON.stringify(r.data));
    assert.equal(r.data.changed, undefined, JSON.stringify(r.data));
    assert.equal(inCopy(b, b.s.path, "cat", ts), "export const newName = 2;\nexport const z = newName + FAILED;", "the locked copy stayed");
    } finally {
      endAllSessions("test");
      if (savedEnvironment === undefined) delete process.env.CBASE_LSP_FAKE; else process.env.CBASE_LSP_FAKE = savedEnvironment;
    }
  });
});

// ── (5) every row with :chat checks the chat by project AND token instance ─────────────────────────────────────────
// The pure read rows that stay with the PROJECT (`:chatInProject`, reason in `readInProject`): data of B's database or store, no file,
// no code, no git of an instance. What the filtered chat list shows may be read (cbase_chat_read reads every chat of the project,
// cbase_artifact_read the artifacts of the siblings in the folder). A further exception is a named change HERE.
// The communication row no longer checks ?chatId against the project: the route's predicate is the border (workspace, readable).
const READ_IN_PROJECT = ["chat", "chat-history", "chat-artifacts"];
// The rows that start, steer or read something IN the chat's instance (turn, subagent, monitor, workflow).
const RUN_ROWS = ["chat-agent", "chat-agent-send", "chat-agent-stop", "chat-agent-output", "chat-agents", "chat-question",
  "chat-approval-request", "chat-monitor", "chat-monitor-stop", "chat-wakeup", "chat-dyn-workflows", "chat-dyn-workflow-run",
  "chat-dyn-workflow-stop", "chat-dyn-workflow-bote", "chat-graph-start", "chat-graph-stop", "chat-captures"];
const chatNames = (z) => [...parameterOf(z.pattern), ...Object.values(z.query || {})].filter((n) => /^chat/.test(n));

test("(5) every row with :chat checks the chat by project AND token instance: copy token with the main chat and main token with the copy chat are 403; only named pure read rows stay with the project; the living-run case stays", () => {
  const rows = FENCE_TABLE.filter((z) => z.rule !== "rejected" && parameterOf(z.pattern).some((n) => /^chat/.test(n)));
  assert.ok(rows.length >= 30, `only ${rows.length} rows with a chat in the path`);
  const check = (inst, z, method, chat, runs = []) => {
    const params = Object.fromEntries(parameterOf(z.pattern).map((n) => [n, /^chat/.test(n) ? chat : "x"]));
    return checkScope({ instance: inst, row: z, params, method, body: {} }, view({ runs }));
  };
  for (const z of rows) {
    const inProject = parameterOf(z.pattern).includes("chatInProject");
    for (const m of z.methods) {
      const what = `${z.family} ${m}`;
      // The own chat and the child of its graph run: with both tokens.
      for (const [inst, chat] of [[MAIN_ROW, "cH"], [MAIN_ROW, "cKindH"], [COPY_ROW, "cK"], [COPY_ROW, "cKind"]]) {
        assert.deepEqual(check(inst, z, m, chat), { ok: true }, `${what}: ${inst.identifier} with ${chat}`);
      }
      // The OTHER instance of the same project: 403, except at a named read row.
      for (const [inst, chat] of [[COPY_ROW, "cH"], [COPY_ROW, "cKindH"], [MAIN_ROW, "cK"], [MAIN_ROW, "cKind"]]) {
        const r = check(inst, z, m, chat);
        if (inProject) { assert.deepEqual(r, { ok: true }, `${what}: read row in the project, ${inst.identifier} with ${chat}`); continue; }
        assert.equal(r.ok, false, `${what}: ${inst.identifier} reaches ${chat} of another instance`);
        assert.equal(r.status, undefined, `${what}: 403, not 409`);
        assert.match(r.reason, new RegExp(`^Fence \\(${z.family}\\): .*instance other than`), what);
      }
      // A LIVING run of the chat is in the token's instance (the pinned turn, a subagent in main of a chat that has since moved
      // in): it keeps reaching its chat.
      assert.deepEqual(check(MAIN_ROW, z, m, "cK", [["cK", KH]]), { ok: true }, `${what}: living run in main of the moved-in chat`);
      assert.deepEqual(check(COPY_ROW, z, m, "cH", [["cH", KK]]), { ok: true }, `${what}: living run, other direction`);
      // A foreign project, a projectless chat, an unknown one: never.
      for (const inst of [MAIN_ROW, COPY_ROW]) {
        for (const c of ["cB", "cO", "existsNot"]) assert.match(check(inst, z, m, c).reason ?? "", /not a chat of this project/, `${what}: ${inst.identifier} with ${c}`);
      }
    }
  }
  // The run rows carry :chat, never the read exception.
  for (const f of RUN_ROWS) {
    const z = FENCE_TABLE.find((x) => x.family === f);
    assert.ok(z, `row ${f} missing`);
    assert.ok(parameterOf(z.pattern).includes("chat"), `${f}: ${z.pattern}`);
  }
  // The exceptions: exactly READ_IN_PROJECT, GET only, each with a reason, and no reason without an exception.
  const exceptions = FENCE_TABLE.filter((z) => chatNames(z).includes("chatInProject"));
  assert.deepEqual(exceptions.map((z) => z.family), READ_IN_PROJECT);
  for (const z of exceptions) {
    assert.deepEqual([...z.methods], ["GET"], `${z.family}: a read row in the project is a PURE read row`);
    assert.ok(typeof z.readInProject === "string" && z.readInProject.length > 40, `${z.family}: without a reason (readInProject)`);
  }
  for (const z of FENCE_TABLE.filter((x) => x.readInProject)) assert.ok(chatNames(z).includes("chatInProject"), `${z.family}: readInProject without :chatInProject`);
  // The safe side: `chatInProject` on a WRITING method (a wrongly entered row) still checks the instance.
  assert.equal(PARAMETER.chatInProject(per(view(), KK), "cH", { writes: false }), null);
  assert.match(PARAMETER.chatInProject(per(view(), KK), "cH", { writes: true }) ?? "", /instance other than/);
  assert.match(PARAMETER.chatInProject(per(view(), KH), "cK", { writes: true }) ?? "", /instance other than/);
  assert.equal(PARAMETER.chatInProject(per(view(), KK), "cK", { writes: true }), null);
  // ?chatId on the artifacts: reading stays with the project (the siblings in the folder, files under B's <data>), writing and
  // deleting only in the token's instance.
  const artifact = (inst, m, own, chatId) => {
    const t = rowFor(m, `/api/chats/${own}/artifacts/file`);
    return checkScope({ instance: inst, row: t.row, params: t.params, method: m, query: new URLSearchParams({ chatId }), body: {} }, view());
  };
  assert.deepEqual(artifact(COPY_ROW, "GET", "cK", "cH"), { ok: true }, "reading the artifact of a sibling in main");
  assert.deepEqual(artifact(MAIN_ROW, "GET", "cH", "cK"), { ok: true });
  for (const m of ["PUT", "DELETE"]) {
    assert.match(artifact(COPY_ROW, m, "cK", "cH").reason ?? "", /instance other than/, `${m} ?chatId=<main chat> with the copy token`);
    assert.match(artifact(MAIN_ROW, m, "cH", "cK").reason ?? "", /instance other than/, m);
    assert.match(artifact(COPY_ROW, m, "cH", "cK").reason ?? "", /instance other than/, `${m}: the path chat of main`);
  }
  assert.match(artifact(COPY_ROW, "GET", "cK", "cB").reason ?? "", /not a chat of this project/);
});

// ── (6) at the real dispatcher: two running turns, main and copy ───────────────────────────────────────────────────────
// The normal case with copies: the main chat has a turn while the copy chat works. Both fakes hold at their gate.
const SOURCE_HEADER = "x-cbase-test-source";
const testSource = (req) => req.headers?.[SOURCE_HEADER] || req.socket?.remoteAddress;
const ipIn = (subnet) => String(subnet).replace(/\.0\/24$/, ".2");
async function rest(base, method, filePath, { token = null, source = null, body } = {}) {
  const headers = { Connection: "close" };
  if (token) headers[TOKEN_HEADER] = token;
  if (source) headers[SOURCE_HEADER] = source;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${filePath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data };
}
const HOLD_CLI = `
  if (text.includes("HOLD-MAIN")) await gate("hold-main");
  if (text.includes("HOLD-COPY")) await gate("hold-copy");
  finished();
  say({ type: "result", result: "ok", session_id: "s-" + turn });`;
// Red instead of a hang: at the gate OR the run is already over (a start that fails).
async function atGate(ctx, name, runningBeforehand) {
  const marker = path.join(ctx.root, "gates", `${name}.waiting`);
  await waitForTruthy(async () => (fs.existsSync(marker) || (await json(`${ctx.base}/api/runs/active`)).runs <= runningBeforehand ? true : null), `gate ${name} or end of run`);
  assert.ok(fs.existsSync(marker), `the run ended without the fake CLI reaching the gate "${name}"`);
}
const execWith = (b, word) => b.fd.calls().filter((a) => a.args[0] === "exec" && a.args.some((x) => String(x).includes(word)));
// The run routes of a chat, each with a body that would do something at the route; the fence stands in front.
const RUN_ROUTES = (marker) => [
  ["POST", "/monitor", { command: `echo ${marker}`, description: "fence-1" }, "chat-monitor"],
  ["POST", "/agent", { prompt: `Say ${marker}`, description: "fence-1" }, "chat-agent"],
  ["POST", "/wakeup", { prompt: marker, delaySeconds: 60 }, "chat-wakeup"],
  ["POST", "/agent/send", { agentId: "a1", message: marker }, "chat-agent-send"],
  ["POST", "/agent/stop", { agentId: "a1", from: "agent" }, "chat-agent-stop"],
  ["POST", "/agent/output", { agentId: "a1", block: false }, "chat-agent-output"],
  ["GET", "/agents", undefined, "chat-agents"],
  ["POST", "/monitor/stop", { taskId: "monitor_x" }, "chat-monitor-stop"],
  ["POST", "/ask", { questions: [{ question: marker, options: [] }] }, "chat-question"],
  ["POST", "/permission-request", { toolName: "Bash", input: { command: marker } }, "chat-approval-request"],
  ["POST", "/dyn-workflows", { script: "" }, "chat-dyn-workflows"],
  ["POST", "/dyn-workflows/run", { name: marker }, "chat-dyn-workflow-run"],
  ["POST", "/dyn-workflows/stop", { taskId: "x" }, "chat-dyn-workflow-stop"],
  ["POST", "/dyn-workflows/structured-output", {}, "chat-dyn-workflow-bote"],
  ["POST", "/graph-workflows/start", { shortName: marker }, "chat-graph-start"],
  ["POST", "/graph-workflows/s1/stop", { from: "agent" }, "chat-graph-stop"],
  ["POST", "/captures", { tab: "" }, "chat-captures"],
];

test("(6) dispatcher: the copy token starts no monitor, subagent or alarm through the main chat (403, no exec in cbase-p-<pid>); the main token likewise through the copy chat; the own chat works (201), history and chat row stay readable in the project", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    const cH = await chatInProject(ctx, pid, "Main chat");
    const cK = ctx.chat;
    await json(`${ctx.base}/api/chats/${cK.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
    await buildCopy(b, { chatId: cK.id });
    const mainRow = store.projectInstance(pid, "main");
    const copyRow = store.projectInstance(pid, "copy-k1");
    assert.ok(mainRow && copyRow?.subnet, "both instance rows exist, the copy with its network");
    const fromCopy = { token: tokenFor(copyRow), source: ipIn(copyRow.subnet) };
    const fromMain = { token: tokenFor(mainRow), ...(mainRow.subnet ? { source: ipIn(mainRow.subnet) } : {}) };
    // The sequence built with the scenario's options; the start of a turn asks the same ones, until quiet, also for a follow-up turn
    // that a monitor message triggers.
    setCreationOptions(() => b.opts);
    try { await twoTurnsAtGate({ ctx, b, cH, cK, fromCopy, fromMain }); } finally { setCreationOptions(null); }
    // After quiet: not one call of the fake docker carried the markers of the rejected requests, neither into main nor elsewhere.
    for (const marker of ["FROM-THE-COPY-INTO-THE-MAIN", "FROM-THE-MAIN-IN-THE-COPY"]) {
      assert.deepEqual(b.fd.calls().filter((a) => a.args.some((x) => String(x).includes(marker))).map((a) => a.args), [], marker);
    }
  }, { claude: fakeClaude({ main: HOLD_CLI }) });
});

// The body of (6): both turns at the gate, the requests, then gates open and quiet; gates and the source test seam are reset in finally.
async function twoTurnsAtGate({ ctx, b, cH, cK, fromCopy, fromMain }) {
  setFenceSource(testSource);
  const gates = [];
  try {
    await json(`${ctx.base}/api/chats/${cH.id}/message`, { method: "POST", body: JSON.stringify({ text: "HOLD-MAIN" }) });
    await atGate(ctx, "hold-main", 0);
    gates.push("hold-main");
    await json(`${ctx.base}/api/chats/${cK.id}/message`, { method: "POST", body: JSON.stringify({ text: "HOLD-COPY" }) });
    await atGate(ctx, "hold-copy", 1);
    gates.push("hold-copy");
    const turnExec = execWith(b, "cbase-wrapper");
    assert.ok(turnExec.some((a) => a.args.includes(b.main)) && turnExec.some((a) => a.args.includes(b.copy)), "the two turns do not each run in their own container");

    // The copy token with the main chat, and the main token with the copy chat: every run route 403 of the fence.
    for (const [from, dest, marker] of [[fromCopy, cH, "FROM-THE-COPY-INTO-THE-MAIN"], [fromMain, cK, "FROM-THE-MAIN-IN-THE-COPY"]]) {
      for (const [method, sub, body, family] of RUN_ROUTES(marker)) {
        const r = await rest(ctx.base, method, `/api/chats/${dest.id}${sub}`, { ...from, body });
        assert.equal(r.status, 403, `${method} ${sub} with the token of the other instance: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
        assert.match(r.data.error, new RegExp(`^Fence \\(${family}\\): .*instance other than`), sub);
      }
    }
    // Chat row and history stay readable in the project (cbase_chat_read), both directions.
    for (const [from, dest] of [[fromCopy, cH], [fromMain, cK]]) {
      for (const sub of ["", "/log"]) {
        const r = await rest(ctx.base, "GET", `/api/chats/${dest.id}${sub}`, from);
        assert.equal(r.status, 200, `GET ${sub || "/"} of the chat of the other instance: ${JSON.stringify(r.data).slice(0, 300)}`);
      }
    }
    // The control: the own chat starts its monitor in ITS container (201).
    for (const [from, dest, marker, container] of [[fromCopy, cK, "OWN-COPY", b.copy], [fromMain, cH, "OWN-MAIN", b.main]]) {
      const r = await rest(ctx.base, "POST", `/api/chats/${dest.id}/monitor`, { ...from, body: { command: `echo ${marker}`, description: "fence-1" } });
      assert.equal(r.status, 201, `own monitor (${marker}): ${JSON.stringify(r.data).slice(0, 300)}`);
      await waitForTruthy(() => (execWith(b, marker).length ? true : null), `exec of the monitor ${marker}`);
      assert.ok(execWith(b, marker).every((a) => a.args.includes(container)), `${marker} did not run in ${container}: ${JSON.stringify(execWith(b, marker).map((a) => a.args))}`);
    }
  } finally {
    for (const t of gates) ctx.gate.open(t);
    setFenceSource(null);
  }
  await ctx.waitForQuiet();
}

// ── (7) the subagent of main in a chat that has moved into the copy ───────────────────────────────────────────
// The fence checks the chat (which now lies in the copy, so the copy token passes); the agent routes used to find the agent in EVERY
// core of the chat, also in main's old one, so the copy token steered a subagent working in the main container (message, report, stop).
// Now the agent must live in the token's instance (`ctl.instanceOf(agentId) || ctl.instance`, runs/routes.js), otherwise 403. The main
// token reaches it (it lives there). Without the fence (B itself, the UI) unchanged. The START (`POST /agent` with `ofProfile` of the
// main agent) must not pick main's core either, and `GET /agents` must not name the ids for it.
// Counter-tests: the 403 line at /agent/send removed => (7) red (200 "delivered" instead of 403); the start-in-foreign-instance line
// removed => (7) red (201, the child runs); the instance filter in the agent list ineffective => (7) red (GET /agents names main's agent).
const GC3_CLI = fakeClaude({
  main: `
  if (text === "AGENT") {
    const args = { description: "On the side", prompt: "Wait at the gate." };
    say({ type: "assistant", message: { id: "main-a-" + turn, content: [{ type: "tool_use", id: "toolu_gc3" + turn, name: "mcp__cbase__cbase_agent", input: args }] } });
    const r = await mcpCall("cbase_agent", args);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_gc3" + turn, content: textOf(r) }] } });
  }
  if (text.includes("HOLD-COPY")) await gate("hold-copy");
  finished();
  say({ type: "result", result: "ok", session_id: "s-" + turn });`,
  sub: `
    await gate("gc3-sub");
    say({ type: "assistant", message: { id: "sub-1", content: [{ type: "text", text: "Finding" }] } });
    finished();
    say({ type: "result", result: "Finding", session_id: "sub-session" });`,
});

test("(7) a copy token does not reach, through a moved-in chat, the subagent living in main: /agent/send, /agent/output, /agent/stop and a start with its profile 403, GET /agents does not name it; the main token reaches it (200)", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    const c = ctx.chat;
    await json(`${ctx.base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
    setCreationOptions(() => b.opts);
    setFenceSource(testSource);
    const gates = [];
    try {
      // The subagent starts in main and outlives its turn (the coding chat does not hold it).
      await json(`${ctx.base}/api/chats/${c.id}/message`, { method: "POST", body: JSON.stringify({ text: "AGENT" }) });
      await ctx.gate.reached("gc3-sub");
      gates.push("gc3-sub");
      await waitForTruthy(async () => {
        const r = await json(`${ctx.base}/api/runs/active`);
        return r.runs === 0 && (r.agents || []).some((a) => a.chatId === c.id) ? r : null;
      }, "turn over, subagent alive");
      const [image] = store.subagentsOf(c.id);
      assert.equal(image?.instance, `${pid}/main`, "the subagent lives in main");
      // The chat moves into the copy and a turn runs there (the main agent's agent routes need a running turn).
      await buildCopy(b, { chatId: c.id });
      await json(`${ctx.base}/api/chats/${c.id}/message`, { method: "POST", body: JSON.stringify({ text: "HOLD-COPY" }) });
      await atGate(ctx, "hold-copy", 0);
      gates.push("hold-copy");
      const copyRow = store.projectInstance(pid, "copy-k1");
      const mainRow = store.projectInstance(pid, "main");
      const fromCopy = { token: tokenFor(copyRow), source: ipIn(copyRow.subnet) };
      const fromMain = { token: tokenFor(mainRow), ...(mainRow.subnet ? { source: ipIn(mainRow.subnet) } : {}) };
      const agentId = image.agentId;
      for (const [sub, body] of [
        ["/agent/send", { agentId, message: "FROM-THE-COPY", from: "agent" }],
        ["/agent/output", { agentId, block: false }],
        ["/agent/stop", { agentId, from: "agent" }],
      ]) {
        const r = await rest(ctx.base, "POST", `/api/chats/${c.id}${sub}`, { ...fromCopy, body });
        assert.equal(r.status, 403, `${sub} with the copy token to the subagent of main: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
        assert.match(r.data.error, /instance other than/, sub);
      }
      assert.ok((await json(`${ctx.base}/api/runs/active`)).agents.some((a) => a.agentId === agentId), "the subagent lives on after the rejected stop");
      // The START of a child with the profile of the main agent used to pick main's core, so the child inherited its instance
      // (201, `instance: <pid>/main`). Now 403, and no new agent is created.
      const prior = store.subagentsOf(c.id).length;
      const start = await rest(ctx.base, "POST", `/api/chats/${c.id}/agent`, { ...fromCopy, body: {
        description: "From the copy", prompt: "Work in main.", ofProfile: `${c.id}-agent-${agentId}`, callId: "toolu_gc3_start" } });
      assert.equal(start.status, 403, `/agent (start) with the main agent's profile and the copy token: ${start.status} ${JSON.stringify(start.data).slice(0, 300)}`);
      assert.match(start.data.error, /instance other than/);
      assert.equal(store.subagentsOf(c.id).length, prior, "a child was created despite 403");
      // The agent list no longer names main's agent to the copy token (the ids are what a start needs).
      const listCopy = await rest(ctx.base, "GET", `/api/chats/${c.id}/agents`, fromCopy);
      assert.equal(listCopy.status, 200, JSON.stringify(listCopy.data).slice(0, 300));
      assert.ok(!(listCopy.data.agents || []).some((a) => a.agentId === agentId), `GET /agents names main's agent to the copy token: ${JSON.stringify(listCopy.data.agents)}`);
      // The main token reaches it (it lives in main).
      const h = await rest(ctx.base, "POST", `/api/chats/${c.id}/agent/output`, { ...fromMain, body: { agentId, block: false } });
      assert.equal(h.status, 200, `main token: ${JSON.stringify(h.data).slice(0, 300)}`);
      const listMain = await rest(ctx.base, "GET", `/api/chats/${c.id}/agents`, fromMain);
      assert.ok((listMain.data.agents || []).some((a) => a.agentId === agentId), `GET /agents with the main token: ${JSON.stringify(listMain.data).slice(0, 300)}`);
    } finally {
      for (const t of gates) ctx.gate.open(t);
      setFenceSource(null);
    }
    try { await ctx.waitForQuiet(); } finally { setCreationOptions(null); }
  }, { claude: GC3_CLI });
});

// (7) covered only the agent in MEMORY. If the main agent exists only in the stored state (its core closed after idling, or after a
// deploy), the check asked `instanceOf`, which knows only memory, and fell back to the instance of the core that got the request:
// copy against copy, through. Then send took it up with the instance of its IMAGE, and it worked in main on instruction from the copy.
// Now the route checks the same way send/output go: the core knows it, otherwise the stored state.
test("(7b) a main subagent that exists only in the stored state: /agent/send and /agent/output with the copy token 403, nothing is taken up", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    const c = ctx.chat;
    await json(`${ctx.base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
    setCreationOptions(() => b.opts);
    setFenceSource(testSource);
    const gates = [];
    try {
      await json(`${ctx.base}/api/chats/${c.id}/message`, { method: "POST", body: JSON.stringify({ text: "AGENT" }) });
      await ctx.gate.reached("gc3-sub");
      gates.push("gc3-sub");
      // The chat moves into the copy while the main subagent lives; then it ends, the turn is over.
      await buildCopy(b, { chatId: c.id });
      ctx.gate.open("gc3-sub");
      await waitForTruthy(async () => {
        const r = await json(`${ctx.base}/api/runs/active`);
        return r.runs === 0 && !(r.agents || []).some((a) => a.chatId === c.id) ? r : null;
      }, "turn over, subagent done");
      const [image] = store.subagentsOf(c.id);
      assert.equal(image?.instance, `${pid}/main`, "the subagent lived in main");
      const agentId = image.agentId;
      // Main's core closes (idle), then a turn in the copy (the main agent's routes need one).
      assert.ok(idleNow() >= 1, "the idle core of main is closed");
      await json(`${ctx.base}/api/chats/${c.id}/message`, { method: "POST", body: JSON.stringify({ text: "HOLD-COPY" }) });
      await atGate(ctx, "hold-copy", 0);
      gates.push("hold-copy");
      assert.equal(coreWithAgent(c.id, agentId), null, "no core knows the agent any more; it exists only in the stored state");
      const copyRow = store.projectInstance(pid, "copy-k1");
      const fromCopy = { token: tokenFor(copyRow), source: ipIn(copyRow.subnet) };
      for (const [sub, body] of [
        ["/agent/send", { agentId, message: "FROM-THE-COPY", from: "agent" }],
        ["/agent/output", { agentId, block: false }],
        ["/agent/send", { name: image.name, message: "FROM-THE-COPY", from: "agent" }],
      ]) {
        const r = await rest(ctx.base, "POST", `/api/chats/${c.id}${sub}`, { ...fromCopy, body });
        assert.equal(r.status, 403, `${sub} ${JSON.stringify(body)} with the copy token to the main agent in the stored state: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
        assert.match(r.data.error, /instance other than/, sub);
      }
      assert.equal(coreWithAgent(c.id, agentId), null, "rejected before a core took it up");
      assert.equal(store.readSubagent(c.id, agentId)?.state, image.state, "its image is untouched");
    } finally {
      for (const t of gates) ctx.gate.open(t);
      setFenceSource(null);
    }
    try { await ctx.waitForQuiet(); } finally { setCreationOptions(null); }
  }, { claude: GC3_CLI });
});


// The ONE name resolution collected candidates from all cores and the stored state without knowing the token's instance, and the
// routes asked it BEFORE the instance check. From a copy that made (a) a short name ambiguous as soon as a main core used the same one
// (every core counts the default names `agent-N` anew, the normal case), and (b) the error named id, description and status of the
// main agent, which GET /agents hides from the copy token. Now a name from a project network counts only among the agents of the
// token's instance (`onlyInstance`); a foreign-only hit stays at the 403 of (7)/(7b). The copy's agent starts here through the route
// with the copy token (like the own monitor in (6)): the MCP server of a run in the copy does not reach B in the test.
// Counter-test: /agent/output with the copy token and the short name: 400 "ambiguous" with main's id.
test("(7c) a short name that main and copy each use for an own subagent: the copy token hits the copy's (output, stop) and never names main's; the main token hits main's", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    const c = ctx.chat;
    await json(`${ctx.base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
    setCreationOptions(() => b.opts);
    setFenceSource(testSource);
    const gates = [];
    try {
      // Turn in main: its subagent "agent-1" outlives the turn.
      await json(`${ctx.base}/api/chats/${c.id}/message`, { method: "POST", body: JSON.stringify({ text: "AGENT" }) });
      await ctx.gate.reached("gc3-sub");
      gates.push("gc3-sub");
      await waitForTruthy(async () => {
        const r = await json(`${ctx.base}/api/runs/active`);
        return r.runs === 0 && (r.agents || []).some((a) => a.chatId === c.id) ? r : null;
      }, "turn over, main's subagent alive");
      // The chat moves into the copy; its turn holds at the gate there, and the copy starts an OWN subagent.
      await buildCopy(b, { chatId: c.id });
      await json(`${ctx.base}/api/chats/${c.id}/message`, { method: "POST", body: JSON.stringify({ text: "HOLD-COPY" }) });
      await atGate(ctx, "hold-copy", 0);
      gates.push("hold-copy");
      const copyRow = store.projectInstance(pid, "copy-k1");
      const mainRow = store.projectInstance(pid, "main");
      const fromCopy = { token: tokenFor(copyRow), source: ipIn(copyRow.subnet) };
      const fromMain = { token: tokenFor(mainRow), ...(mainRow.subnet ? { source: ipIn(mainRow.subnet) } : {}) };
      const start = await rest(ctx.base, "POST", `/api/chats/${c.id}/agent`, { ...fromCopy, body: { description: "In the copy", prompt: "Wait at the gate.", callId: "toolu_gc3c_start" } });
      assert.equal(start.status, 201, `/agent with the copy token: ${start.status} ${JSON.stringify(start.data).slice(0, 300)}`);
      const images = store.subagentsOf(c.id);
      const main = images.find((x) => x.instance === `${pid}/main`);
      const copy = images.find((x) => x.instance === `${pid}/copy-k1`);
      assert.ok(main && copy, `one subagent each in main and copy: ${JSON.stringify(images.map((x) => [x.agentId, x.name, x.instance]))}`);
      assert.equal(copy.agentId, start.data.agentId);
      assert.equal(copy.name, main.name, "both use the same short name (counted anew per core)");
      const short = copy.name;
      const o = await rest(ctx.base, "POST", `/api/chats/${c.id}/agent/output`, { ...fromCopy, body: { agentId: short, block: false } });
      assert.equal(o.status, 200, `/agent/output "${short}" with the copy token: ${o.status} ${JSON.stringify(o.data).slice(0, 300)}`);
      assert.equal(o.data.agentId, copy.agentId, "the copy's agent");
      assert.ok(!JSON.stringify(o.data).includes(main.agentId), "the response does not name main's agent");
      const h = await rest(ctx.base, "POST", `/api/chats/${c.id}/agent/output`, { ...fromMain, body: { agentId: short, block: false } });
      assert.equal(h.status, 200, `/agent/output "${short}" with the main token: ${h.status} ${JSON.stringify(h.data).slice(0, 300)}`);
      assert.equal(h.data.agentId, main.agentId, "main's agent");
      const st = await rest(ctx.base, "POST", `/api/chats/${c.id}/agent/stop`, { ...fromCopy, body: { agentId: short, from: "agent" } });
      assert.equal(st.status, 200, `/agent/stop "${short}" with the copy token: ${st.status} ${JSON.stringify(st.data).slice(0, 300)}`);
      assert.equal(st.data.agentId, copy.agentId, "the copy's agent is the one stopped");
      assert.ok(!JSON.stringify(st.data).includes(main.agentId), "the stop response does not name main's agent");
      assert.ok((await json(`${ctx.base}/api/runs/active`)).agents.some((a) => a.agentId === main.agentId), "main's agent lives on");
    } finally {
      for (const t of gates) ctx.gate.open(t);
      setFenceSource(null);
    }
    try { await ctx.waitForQuiet(); } finally { setCreationOptions(null); }
  }, { claude: GC3_CLI });
});
