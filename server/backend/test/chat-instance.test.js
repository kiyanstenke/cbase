// Guard for chats bound to an instance: the binding of a chat to an instance is in `chats.instance` (NULL = main), no longer at the
// copy (`stack_copies.chat_id`). Main seam through `withAgentsServer` on the fake docker (server/backend/test/fake-docker.mjs) like
// stacks-inset.test.js: a converted project with main `cbase-p-<pid>` and a copy `k1` (`cbase-k-<pid>-k1`), built through the REAL
// setters (stacks/state.js copyRequests, setCopyState). The fake main agent writes one line per turn to turns.jsonl: the identifier
// of the instance from its MCP configuration (`CBASE_INSTANCE`), the prompt with the silent hints and the `--resume` of its start.
//
// The promises, each with the sabotage that breaks it:
//   (1) A copy WITHOUT a chat (a human creates it): on `ready` no wake turn, no binding, `inset` false. The binding follows
//       `chats.instance`: PATCH `{instance:"copy-k1"}` ⇒ separator (role `hint`) in the history, the next turn runs in the copy and
//       continues the same CLI session (`--resume`); a PATCH WITHOUT the field changes nothing ("a missing field is no statement");
//       `"main"` leads back; the same value again writes no second separator.
//   (2) The check (runs/instance-switch.js instanceChoice): a copy that does not exist, is still being built or whose instance row
//       is missing ⇒ 409 UNKNOWN_INSTANCE; no text ⇒ 400 INSTANCE_INVALID; a project without move ⇒ 409 NOT_CONVERTED; without a
//       project ⇒ 409 NO_PROJECT — and a No changes NOTHING, not even another field sent along. POST /api/chats takes `instance`
//       with the same rules (with ⇒ bound without a separator duty, without ⇒ main, unknown ⇒ 409 and no chat).
//   (3) A binding to a dead copy (a row that does not exist — a race) ⇒ 409 COPY_LOCKED at the routes with `?chat=` (with the
//       copy's name), no turn, no docker; never silently main. The restart step (stacks/inset.js copiesWakeRestartGrace) resets the
//       dead binding — separator, silent hint —, afterwards the chat runs in main.
//   (4) A project switch resets `chats.instance` in the same UPDATE (separator, silent hint in the next turn); the switch back to
//       the old project does NOT bind again.
//   (5) A running turn stays pinned — it ends in main, a queued message does not go into its open process, it becomes the next turn
//       and runs in the copy, with the silent hint where the previous one ran.
//   (6) The move-out ("after removed"): ALL chats working in the copy go back to main — also one that did not create it (POST with
//       `instance`), with separator and silent hint.
//   (7) The PATCH checks `instance` against the FRESH row, not against `ctx.chat` from before the await — a second PATCH that
//       switched the project during the first would otherwise bind to a copy of the OLD project (called directly at coreChatRoutes
//       with a stale row, without a clock). A chat deleted meanwhile ⇒ 404.
//   (8) The child chat of a graph run (`graph_starts.child_chat_id`) never switches — PATCH and POST /instance ⇒ 409 INSTANCE_PINNED
//       (also for main), no separator, nothing written; a title PATCH stays 200, an ordinary chat still switches. If the child
//       creates a copy itself, it does NOT move in on `ready` and is not woken (silent hint instead of a wake turn).
//   (9) PATCH `{ projectId, instance }` from a copy — the silent hint names the chosen copy of the new project, not "main", and the
//       next turn runs there.
//  (10) GET /api/chats carries `copy` from `chats.instance` — the creator working in main shows none; a chat started in the copy
//       shows it with its state.
//
// No clock: it waits for gates, quiet and states — and EITHER for the event OR for the end of the runs (waitingForTurns, atGate).
// Every working instance row is taken back in the body of the harness (clearAwayCopies).
//
// Counter-tests, one sabotage each on the real tree, the whole file run:
//   chats/routes.js   PATCH does not call chatInstanceSet(id, instanceNew) (the choice is never written)  ⇒ (1), (4), (5), (6) red
//   store/chats.js    updateChat does not set `instance = NULL` on a project switch                       ⇒ (4) red
//   stacks/remove.js  copyOfTheChat returns null for a dead binding instead of the dead marker (silently main) ⇒ (3) red
//   stacks/inset.js   move-out without the loop over chatsInInstance (only the child pin)                  ⇒ (6) red
//   chats/routes.js   PATCH without the fresh row (`ctx.chat` from before the await)                       ⇒ (7) red: 200, the chat is in
//                                                                                                              P2 with instance copy-k1
//   runs/instance-switch.js instanceChoice does not call instancePinned                                    ⇒ (8) red: PATCH 200, copy-k1
//   stacks/inset.js   the pinned check always false (move-in and wake call without a guard)                ⇒ (8) red: "the child moved into
//                                                                                                              its copy although its pin applies"
//   chats/routes.js   copyProjectSwitched without `toInstance`                                             ⇒ (9) red: "… and works there in main."
//   chats/routes.js   GET /api/chats with the old mapping `stack_copies.chat_id`                           ⇒ (10) red: "the creator in main
//                                                                                                              shows its created copy"
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { copyInstance } from "../electron/server/projectbox/creation.js";
import { copiesWakeRestartGrace } from "../electron/server/stacks/inset.js";
import { copyRequests, setCopyState } from "../electron/server/stacks/state.js";
import { instanceSeparatorText } from "../electron/server/runs/instance-switch.js";
import { coreChatRoutes } from "../electron/server/chats/routes.js";
import { PROGRAM as FILE_ACCESS_PROGRAM } from "../electron/server/runtime/fileAccess.js";
import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { readJsonl } from "./jsonl.mjs";

// ── Environment, fake docker, project (as in stacks-inset.test.js) ────────────────────────────────────────────────────
async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const ops = (fd) => ({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200",
  CLAUDE_CONFIG_DIR: path.join(fd.dir, "b-home", ".claude"), CODEX_HOME: path.join(fd.dir, "b-home", ".codex") });
function containerStart(fd, name) {
  execFileSync(fd.bin, ["run", "-d", "--name", name, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
}
const execCalls = (fd) => fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec");
// Turns (the wrapper) in this container — without the file accesses at the turn start (runtime/fileAccess.js, as in stacks-inset.test.js).
const turnsIn = (fd, container) => execCalls(fd).filter((a) => a.args.includes(container) && a.args.some((x) => String(x).includes("cbase-wrapper")) && !a.args.includes(FILE_ACCESS_PROGRAM)).length;
const dockerCalls = (fd) => fd.calls({ daemon: "host" }).filter((a) => a.args[0] !== "info" && a.args[0] !== "version");

async function projectInOps(ctx, fd, { name = "Checkout", folder = "till", chat = ctx.chat } = {}) {
  const projPath = path.join(ctx.root, "workspace", folder);
  fs.mkdirSync(projPath, { recursive: true });
  const p = await ctx.projectWithoutInstance({ name, path: projPath });
  const main = `cbase-p-${p.id}`;
  containerStart(fd, main);
  store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: main });
  if (chat) await json(`${ctx.base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
  return { p, main, copy: `cbase-k-${p.id}-k1`, pid: p.id, projPath };
}
// A copy through the real setters up to `ready` — `chatId` null: a human creates it (no move-in). `inset` as in copyRequests (true with a
// chat); `inset: false` with a chat is a creator that does not move in (the chat list, (10)).
function copyReadyMake(fd, o, { chatId = null, name = "k1", inset = Boolean(chatId) } = {}) {
  const k = copyRequests({ projectId: o.pid, name, chatId, inset });
  setCopyState(k.id, "build", { phase: "clone1" });
  containerStart(fd, `cbase-k-${o.pid}-${name}`);
  return setCopyState(k.id, "ready", { result: { branchSpace: `copy/${name}/`, hints: [] } });
}

// ── The fake main agent ─────────────────────────────────────────────────────────────────────────────────────────────
const MAIN = `
  { const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers.cbase; const env = cfg.env || {};
    fs.appendFileSync(path.join(LOCATION, "turns.jsonl"), JSON.stringify({ n: turn, text, all: JSON.stringify(msg.message.content),
      instance: env.CBASE_INSTANCE || null, resume: arg("--resume") || null }) + "\\n"); }
  if (text.includes("HOLD")) { await gate("hold"); }
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;
const claude = fakeClaude({ main: MAIN, sub: `finished(); say({ type: "result", result: "x", session_id: "sub-session" });` });

const turns = (ctx) => readJsonl(path.join(ctx.root, "turns.jsonl"));
const quiet = (ctx) => ctx.waitForQuiet();
const send = (ctx, text, chatId = ctx.chat.id) => json(`${ctx.base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });
const runs = async (ctx) => (await json(`${ctx.base}/api/runs/active`)).runs;
async function waitingForTurns(ctx, n, what) {
  await waitForTruthy(async () => (turns(ctx).length >= n || (await runs(ctx)) === 0 ? true : null), what);
  assert.ok(turns(ctx).length >= n, `${what}: the run ended without the fake CLI seeing a turn (${turns(ctx).length} of ${n})`);
  return turns(ctx);
}
async function atGate(ctx, name) {
  const marker = path.join(ctx.root, "gates", `${name}.waiting`);
  await waitForTruthy(async () => (fs.existsSync(marker) || (await runs(ctx)) === 0 ? true : null), `gate ${name} or end of run`);
  assert.ok(fs.existsSync(marker), `the run ended without the fake CLI reaching the gate "${name}"`);
}
// An answer with its status (json() of the harness throws on an error status).
async function raw(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init.headers || {}) } });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
const patch = (ctx, body, chatId = ctx.chat.id) => raw(`${ctx.base}/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify(body) });
// The separators in the history (role `hint`, wording runs/instance-switch.js) — the role also carries other messages (the lock of a
// dead copy, (3)).
const hints = (chatId) => store.listMessages(chatId).filter((m) => m.role === "hint").map((m) => m.text);
const separator = (chatId) => hints(chatId).filter((t) => t.startsWith("Dieser Chat arbeitet jetzt in "));
const identifier = (o, inst) => `${o.pid}/${inst}`;

function clearAwayCopies() {
  for (const k of store.liveStackCopies()) {
    try {
      if (["build", "ready", "clearAway"].includes(k.state)) setCopyState(k.id, "error", { error: "End of test" });
      store.deleteProjectInstance(k.projectId, copyInstance(k.name));
      setCopyState(k.id, "removed");
    } catch { /* already gone */ }
  }
}
async function withInstances(fn) {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      try { await withEnvironment(ops(fd), () => fn(ctx, fd)); } finally { clearAwayCopies(); }
    }, { claude });
  } finally { fd.cleanUp(); }
}

// ── (1) Copy without a chat, binding through chats.instance ───────────────────────────────────────────────────────────
test("(1) copy without a chat: no wake turn, no binding; PATCH instance binds with a separator, the next turn runs in the copy with the same session; a missing field changes nothing; main leads back", async () => {
  await withInstances(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const k = copyReadyMake(fd, o);
    assert.equal(k.state, "ready");
    assert.equal(k.chatId, null, "the copy carries a chat although a human created it");
    assert.equal(k.inset, false);
    await quiet(ctx);
    assert.deepEqual(turns(ctx), [], "a copy without a chat woke a chat");
    assert.equal(store.getChat(ctx.chat.id).instance, null, "a copy without a chat bound a chat");

    // A turn before the switch: in main (it creates the CLI session).
    await send(ctx, "First");
    await waitingForTurns(ctx, 1, "the first turn");
    await quiet(ctx);
    assert.equal(turns(ctx)[0].instance, identifier(o, "main"));

    // The switch: column, answer, separator.
    const r = await patch(ctx, { instance: copyInstance("k1") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.instance, copyInstance("k1"), "the PATCH answer does not name the instance");
    assert.equal(store.getChat(ctx.chat.id).instance, copyInstance("k1"));
    assert.deepEqual(separator(ctx.chat.id), [instanceSeparatorText(copyInstance("k1"))], "no (or more than one) separator in the history");

    await send(ctx, "In the copy");
    await waitingForTurns(ctx, 2, "the turn after the switch");
    await quiet(ctx);
    assert.equal(turns(ctx)[1].instance, identifier(o, copyInstance("k1")), "the turn after the switch did not run in the copy");
    assert.equal(turns(ctx)[1].resume, "main-session", "the CLI session did not move along (no --resume)");
    assert.equal(turnsIn(fd, o.copy), 1, "no turn in the copy container");

    // A PATCH WITHOUT the field (a title) does not change the instance — and writes no separator.
    const title = await patch(ctx, { title: "Renamed" });
    assert.equal(title.status, 200);
    assert.equal(store.getChat(ctx.chat.id).instance, copyInstance("k1"), "a PATCH without `instance` reset the instance");
    assert.equal(separator(ctx.chat.id).length, 1);

    // The same value again: nothing.
    assert.equal((await patch(ctx, { instance: copyInstance("k1") })).status, 200);
    assert.equal(separator(ctx.chat.id).length, 1, "the same value wrote a second separator");

    // Back: "main".
    const back = await patch(ctx, { instance: "main" });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(store.getChat(ctx.chat.id).instance, null);
    assert.deepEqual(separator(ctx.chat.id), [instanceSeparatorText(copyInstance("k1")), instanceSeparatorText(null)]);
    await send(ctx, "Back in main");
    await waitingForTurns(ctx, 3, "the turn after the way back");
    await quiet(ctx);
    assert.equal(turns(ctx)[2].instance, identifier(o, "main"));
    assert.equal(turns(ctx)[2].resume, "main-session");
    // The copy lives on: nobody touched it.
    assert.equal(store.stackCopy(k.id).state, "ready");
  });
});

// ── (2) The check; POST with instance ─────────────────────────────────────────────────────────────────────────────────
test("(2) unknown, building or row-less copy ⇒ 409 UNKNOWN_INSTANCE, no text ⇒ 400, without move 409 NOT_CONVERTED, without a project 409 NO_PROJECT — a No changes nothing; POST /api/chats takes instance with the same rules", async () => {
  await withInstances(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const no = async (body, status, code) => {
      const r = await patch(ctx, body);
      assert.deepEqual([r.status, r.body?.code], [status, code], `${JSON.stringify(body)}: ${JSON.stringify(r.body)}`);
    };
    await no({ instance: "copy-nonexistent" }, 409, "UNKNOWN_INSTANCE");
    await no({ instance: "anything" }, 409, "UNKNOWN_INSTANCE");
    await no({ instance: 7 }, 400, "INSTANCE_INVALID");
    // A copy being built: nobody moves into it.
    const inBuild = copyRequests({ projectId: o.pid, name: "build", chatId: null });
    setCopyState(inBuild.id, "build", { phase: "clone1" });
    await no({ instance: copyInstance("build") }, 409, "UNKNOWN_INSTANCE");
    // A ready copy without an instance row (a race with the clearing away).
    copyReadyMake(fd, o);
    store.deleteProjectInstance(o.pid, copyInstance("k1"));
    await no({ instance: copyInstance("k1") }, 409, "UNKNOWN_INSTANCE");
    // A No changes nothing — not even the title sent along.
    await no({ instance: "copy-nonexistent", title: "Must not" }, 409, "UNKNOWN_INSTANCE");
    assert.notEqual(store.getChat(ctx.chat.id).title, "Must not", "a rejected PATCH wrote another field");
    assert.equal(store.getChat(ctx.chat.id).instance, null);
    assert.deepEqual(separator(ctx.chat.id), []);
    // `null` and "main" always go (even without effect).
    assert.equal((await patch(ctx, { instance: null })).status, 200);
    assert.deepEqual(separator(ctx.chat.id), [], "a main without a switch wrote a separator");

    // A project without a move (no instance row).
    const oldPath = path.join(ctx.root, "workspace", "old");
    fs.mkdirSync(oldPath, { recursive: true });
    const old = await ctx.projectWithoutInstance({ name: "Old", path: oldPath });
    const r1 = await patch(ctx, { projectId: old.id, instance: "copy-x" });
    assert.deepEqual([r1.status, r1.body?.code], [409, "NOT_CONVERTED"], JSON.stringify(r1.body));
    assert.equal(store.getChat(ctx.chat.id).projectId, o.pid, "a rejected PATCH switched the project");
    // Without a project.
    const r2 = await patch(ctx, { projectId: null, instance: "copy-x" });
    assert.deepEqual([r2.status, r2.body?.code], [409, "NO_PROJECT"], JSON.stringify(r2.body));

    // POST /api/chats: with, without, unknown.
    const fresh = (body) => raw(`${ctx.base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ctx.chat.workspaceId, provider: "claude", projectId: o.pid, ...body }) });
    // Create the row again: k1 is then a living instance.
    store.createProjectInstance({ projectId: o.pid, instance: copyInstance("k1"), state: "ready", convertedAt: Date.now(), containerId: o.copy });
    const including = await fresh({ instance: copyInstance("k1") });
    assert.equal(including.status, 201, JSON.stringify(including.body));
    assert.equal(including.body.instance, copyInstance("k1"));
    assert.equal(store.getChat(including.body.id).instance, copyInstance("k1"));
    const without = await fresh({});
    assert.equal(without.status, 201);
    assert.equal(store.getChat(without.body.id).instance, null, "a chat without `instance` does not work in main");
    const count = store.listChats(ctx.chat.workspaceId).length;
    const unknown = await fresh({ instance: "copy-nonexistent" });
    assert.deepEqual([unknown.status, unknown.body?.code], [409, "UNKNOWN_INSTANCE"], JSON.stringify(unknown.body));
    assert.equal(store.listChats(ctx.chat.workspaceId).length, count, "a rejected POST created a chat anyway");
  });
});

// ── (3) dead binding ⇒ 409 COPY_LOCKED; the restart step resets ──────────────────────────────────────────────────────
test("(3) a binding to a copy that does not exist: 409 COPY_LOCKED with its name, no turn, no docker — never silently main; the restart step resets it, afterwards the chat runs in main", async () => {
  await withInstances(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    store.updateChat(ctx.chat.id, { instance: "copy-away" }); // the race: the column points at a copy without a row
    const prior = dockerCalls(fd).length;
    const git = await raw(`${ctx.base}/api/projects/${o.pid}/git?chat=${ctx.chat.id}`);
    assert.equal(git.status, 409, `the git view of a chat with a dead binding: ${git.status} ${JSON.stringify(git.body).slice(0, 300)}`);
    assert.equal(git.body.instance, "copy-away", JSON.stringify(git.body));
    await send(ctx, "Go");
    await quiet(ctx);
    assert.deepEqual(turns(ctx), [], "a turn ran despite the dead binding");
    assert.equal(dockerCalls(fd).length, prior, "a docker call despite the dead binding (silently main?)");
    assert.ok(hints(ctx.chat.id).some((t) => t.includes("„copy-away“") && t.includes("auch nicht im Haupt")), `no lock message: ${JSON.stringify(hints(ctx.chat.id))}`);

    // The restart step repairs: back to main, separator, silent hint.
    copiesWakeRestartGrace();
    assert.equal(store.getChat(ctx.chat.id).instance, null, "the restart step left the dead binding standing");
    assert.deepEqual(separator(ctx.chat.id), [instanceSeparatorText(null)]);
    await send(ctx, "Now");
    await waitingForTurns(ctx, 1, "the turn after the repair");
    await quiet(ctx);
    const t = turns(ctx).at(-1);
    assert.equal(t.instance, identifier(o, "main"));
    assert.ok(t.all.includes("Die Kopie „away“, in der dieser Chat arbeitete, gibt es nicht mehr"), `no silent hint about the dead binding: ${t.all.slice(0, 600)}`);
  });
});

// ── (4) Project switch resets ─────────────────────────────────────────────────────────────────────────────────────────
test("(4) a project switch resets the instance in the same UPDATE (separator, silent hint); back to the old project does not bind again", async () => {
  await withInstances(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    copyReadyMake(fd, o);
    assert.equal((await patch(ctx, { instance: copyInstance("k1") })).status, 200);
    const second = await projectInOps(ctx, fd, { name: "Warehouse", folder: "warehouse", chat: null });
    const r = await patch(ctx, { projectId: second.pid });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.instance, null, "the answer of the project switch still names the copy");
    assert.equal(store.getChat(ctx.chat.id).instance, null, "the project switch left the instance standing");
    assert.deepEqual(separator(ctx.chat.id), [instanceSeparatorText(copyInstance("k1")), instanceSeparatorText(null)]);
    // Back to the old project: the copy lives, but the chat stays in main.
    assert.equal((await patch(ctx, { projectId: o.pid })).status, 200);
    assert.equal(store.getChat(ctx.chat.id).instance, null, "the switch back bound the chat to its copy again");
    await send(ctx, "Where am I");
    await waitingForTurns(ctx, 1, "the turn after the switch");
    await quiet(ctx);
    const t = turns(ctx)[0];
    assert.equal(t.instance, identifier(o, "main"), "the turn did not run in main");
    assert.ok(t.all.includes("zurück in sie kommt der Chat nur über die Wahl seiner Instanz"), `no silent hint about the project switch: ${t.all.slice(0, 900)}`);
  });
});

// ── (5) the running turn stays ────────────────────────────────────────────────────────────────────────────────────────
test("(5) a switch in the middle of a turn: the turn ends in main, the queued message does not go into its process, it becomes the next turn in the copy — with the silent hint", async () => {
  await withInstances(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    copyReadyMake(fd, o);
    await send(ctx, "HOLD");
    await atGate(ctx, "hold");
    assert.equal(turns(ctx)[0].instance, identifier(o, "main"));
    assert.equal((await patch(ctx, { instance: copyInstance("k1") })).status, 200);
    await send(ctx, "Afterwards");
    assert.equal(turns(ctx).length, 1, "a second turn began while the first was running");
    ctx.gate.open("hold");
    await waitingForTurns(ctx, 2, "the follow-up turn");
    await quiet(ctx);
    const t = turns(ctx);
    assert.equal(t.length, 2, `the message went into the running turn: ${JSON.stringify(t.map((x) => x.text.slice(0, 60)))}`);
    assert.equal(t[0].instance, identifier(o, "main"));
    assert.ok(t[1].text.includes("Afterwards"));
    assert.equal(t[1].instance, identifier(o, copyInstance("k1")), "the follow-up turn did not run in the copy");
    assert.ok(t[1].all.includes("instance-switch"), `no silent hint where the previous turn ran: ${t[1].all.slice(0, 900)}`);
    assert.equal(turnsIn(fd, o.main), 1);
    assert.equal(turnsIn(fd, o.copy), 1);
  });
});

// ── (6) The move-out resets all ───────────────────────────────────────────────────────────────────────────────────────
test("(6) after `removed` ALL chats of the copy go back to main — also one that did not create it (POST with instance) — with separator and silent hint", async () => {
  await withInstances(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    const k = copyReadyMake(fd, o);
    assert.equal((await patch(ctx, { instance: copyInstance("k1") })).status, 200);
    const second = await json(`${ctx.base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ctx.chat.workspaceId, provider: "claude", projectId: o.pid, instance: copyInstance("k1") }) });
    const uninvolved = await json(`${ctx.base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ctx.chat.workspaceId, provider: "claude", projectId: o.pid }) });
    assert.deepEqual(store.chatsInInstance(o.pid, copyInstance("k1")).sort(), [ctx.chat.id, second.id].sort());
    // The clearing away (stacks/clearAway.js): `clearAway`, at the end instance row gone and `removed`.
    setCopyState(k.id, "clearAway", { phase: "save" });
    store.deleteProjectInstance(o.pid, copyInstance("k1"));
    setCopyState(k.id, "removed");
    for (const id of [ctx.chat.id, second.id]) {
      assert.equal(store.getChat(id).instance, null, `chat ${id} stayed at the removed copy`);
      assert.equal(separator(id).at(-1), instanceSeparatorText(null), `no separator in chat ${id}`);
    }
    assert.deepEqual(separator(uninvolved.id), [], "a chat in main got a separator");
    await send(ctx, "After the move-out", second.id);
    await waitingForTurns(ctx, 1, "the turn after the move-out");
    await quiet(ctx);
    const t = turns(ctx)[0];
    assert.equal(t.instance, identifier(o, "main"));
    assert.ok(t.all.includes("in der dieser Chat arbeitete, wurde abgeräumt"), `no silent hint about the move-out: ${t.all.slice(0, 600)}`);
  });
});

// ── Further promises: (7) to (10) ───────────────────────────────────────────────────────────────────────────────────────
// A route's answer, called directly (pattern files-copy.test.js): `chat` in ctx is the row the owner chatRoutes read BEFORE the
// await of the body — here deliberately a stale one.
function stubResponse() {
  const r = { status: 0, parts: [], writeHead(c) { r.status = c; }, write(d) { r.parts.push(Buffer.from(d)); return true; }, end(d) { if (d) r.parts.push(Buffer.from(d)); } };
  Object.defineProperty(r, "json", { get: () => { try { return JSON.parse(Buffer.concat(r.parts).toString("utf8")); } catch { return null; } } });
  return r;
}
async function patchWithOldRow(chatId, oldRow, body) {
  const req = new PassThrough();
  req.method = "PATCH";
  req.headers = { "content-type": "application/json" };
  req.end(JSON.stringify(body));
  const res = stubResponse();
  const url = new URL(`http://x/api/chats/${chatId}`);
  await coreChatRoutes({ req, res, url, p: url.pathname, m: "PATCH", id: chatId, sub: "", chat: oldRow });
  return res;
}
// A child chat of a graph run: the pin is in `graph_starts.instance` ("" = main). Status "stopped": the run is over, the child chat
// stays a child (chats/genus.js) — and holds no quiet of the harness.
function childChat(ctx, o, { pin = "" } = {}) {
  const now = Date.now();
  const childRow = store.createChat({ id: crypto.randomUUID(), workspaceId: ctx.chat.workspaceId, projectId: o.pid, title: "Child", kind: "normal", provider: "claude", createdAt: now, updatedAt: now });
  store.createGraphStart({ id: `gs-${crypto.randomUUID()}`, chatId: ctx.chat.id, childChatId: childRow.id, workflowId: "wf-kind", workflowName: "Child", shortName: "child", background: true, status: "stopped", instance: pin });
  return childRow;
}

// (7): the PATCH reads the row FRESH after the body.
// Counter-test: chats/routes.js PATCH without `const chat = store.getChat(id)` (checks against `ctx.chat`) ⇒ (7) red (200 instead of
// 409, the chat in P2 bound to copy-k1 of P1).
test("(7) the PATCH checks `instance` against the FRESH row — a project switch that ran through between loading and body does not bind the chat to a copy of its old project", async () => {
  await withInstances(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    copyReadyMake(fd, o);
    const second = await projectInOps(ctx, fd, { name: "Warehouse", folder: "warehouse", chat: null });
    const old = store.getChat(ctx.chat.id); // the row the second PATCH read before its await: project P1
    assert.equal(old.projectId, o.pid);
    // The first PATCH (project switch to P2) runs through while the second waits for its body.
    assert.equal((await patch(ctx, { projectId: second.pid })).status, 200);
    const r = await patchWithOldRow(ctx.chat.id, old, { instance: copyInstance("k1") });
    assert.deepEqual([r.status, r.json?.code], [409, "UNKNOWN_INSTANCE"], `checked against the old project: ${r.status} ${JSON.stringify(r.json)}`);
    const now = store.getChat(ctx.chat.id);
    assert.deepEqual([now.projectId, now.instance], [second.pid, null], "the chat in P2 carries a copy of P1");
    // A row deleted meanwhile ⇒ 404, no writing to a row that no longer exists.
    const way = await patchWithOldRow("exists-not", old, { title: "x" });
    assert.equal(way.status, 404);
  });
});

// (8): the child chat of a graph run never switches — PATCH, POST /instance and the move-in.
// Counter-tests: runs/instance-switch.js instanceChoice without the line `if (chatId) instancePinned(chatId);` ⇒ (8) red (PATCH 200);
// stacks/inset.js move-in and wake without the pinned check ⇒ (8) red (the child was bound to copy-k2 after `ready` and woken).
test("(8) a child chat of a graph run ⇒ 409 INSTANCE_PINNED at PATCH and POST /instance (also for main), no separator, no wake; if it creates a copy, it does not move in (silent hint instead of a wake)", async () => {
  await withInstances(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    copyReadyMake(fd, o);
    const childRow = childChat(ctx, o);
    for (const value of [copyInstance("k1"), "main", null]) {
      const r = await patch(ctx, { instance: value }, childRow.id);
      assert.deepEqual([r.status, r.body?.code], [409, "INSTANCE_PINNED"], `PATCH ${value}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /Kind-Chat eines Graph-Laufs.*fest in main/s, r.body.error);
    }
    const w = await raw(`${ctx.base}/api/chats/${childRow.id}/instance`, { method: "POST", body: JSON.stringify({ instance: copyInstance("k1") }) });
    assert.deepEqual([w.status, w.body?.code], [409, "INSTANCE_PINNED"], `POST /instanz: ${JSON.stringify(w.body)}`);
    assert.equal(store.getChat(childRow.id).instance, null, "the child's column was written");
    assert.deepEqual(separator(childRow.id), [], "a separator in the child — description without execution");
    // A PATCH without `instance` still works (rename).
    assert.equal((await patch(ctx, { title: "Child renamed" }, childRow.id)).status, 200);
    // An ordinary chat still switches (the guard hits only the child).
    assert.equal((await patch(ctx, { instance: copyInstance("k1") })).status, 200);

    // The move-in: the child creates k2 with `inset` (the tool) — on `ready` it does NOT move in and is not woken.
    const k2 = copyReadyMake(fd, o, { chatId: childRow.id, name: "k2" });
    assert.deepEqual([k2.state, k2.inset], ["ready", true]);
    await quiet(ctx);
    assert.equal(store.getChat(childRow.id).instance, null, "the child moved into its copy although its pin applies");
    assert.deepEqual(turns(ctx), [], "the child was woken with \"from this turn in the copy\"");
    const h = store.openHints(childRow.id).map((x) => x.text).find((t) => t.includes("„k2“"));
    assert.ok(h, `no silent hint to the child: ${JSON.stringify(store.openHints(childRow.id))}`);
    assert.match(h, /Kind-Chat eines Graph-Laufs und bleibt in der Instanz, in der sein Lauf begann/, h);
  });
});

// (9): if the same PATCH chooses a copy with the project, the silent hint names it.
// Counter-test: chats/routes.js without `toInstance` at copyProjectSwitched ⇒ (9) red ("works there in main", the next turn ran in
// copy-k2).
test("(9) PATCH `{ projectId, instance }` from a copy — the silent hint names the chosen copy, not \"main\"; the turn runs there", async () => {
  await withInstances(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    copyReadyMake(fd, o);
    assert.equal((await patch(ctx, { instance: copyInstance("k1") })).status, 200);
    const second = await projectInOps(ctx, fd, { name: "Warehouse", folder: "warehouse", chat: null });
    copyReadyMake(fd, second, { name: "k2" });
    const r = await patch(ctx, { projectId: second.pid, instance: copyInstance("k2") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.projectId, r.body.instance], [second.pid, copyInstance("k2")]);
    const h = store.openHints(ctx.chat.id).filter((x) => x.source === "stack-copy").map((x) => x.text);
    assert.equal(h.length, 1, JSON.stringify(h));
    assert.match(h[0], /im Projekt „Warehouse“ und arbeitet dort in copy-k2\./, h[0]);
    await send(ctx, "Where am I");
    await waitingForTurns(ctx, 1, "the turn after the switch");
    await quiet(ctx);
    assert.equal(turns(ctx)[0].instance, identifier(second, copyInstance("k2")), "the turn did not run in the chosen copy");
  });
});

// (10): the chat list names the copy a chat works IN (`chats.instance`), not the one it created.
// Counter-test: chats/routes.js GET /api/chats with the old mapping through `k.chatId` ⇒ (10) red (A showed "k1", B nothing).
test("(10) GET /api/chats carries `copy` from `chats.instance` — the creator in main shows none, a chat started in the copy shows it with its state", async () => {
  await withInstances(async (ctx, fd) => {
    const o = await projectInOps(ctx, fd);
    // A (ctx.chat) created k1 but did not move in (works in main); a human created k2, B works in it.
    copyReadyMake(fd, o, { chatId: ctx.chat.id, name: "k1", inset: false });
    copyReadyMake(fd, o, { name: "k2" });
    const b = await json(`${ctx.base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ctx.chat.workspaceId, provider: "claude", projectId: o.pid, instance: copyInstance("k2") }) });
    // Only a chat with at least one message is in the list.
    for (const id of [ctx.chat.id, b.id]) if (!store.listMessages(id).length) store.addMessage(id, "user", "Hello");
    const list = await json(`${ctx.base}/api/chats?workspaceId=${encodeURIComponent(ctx.chat.workspaceId)}`);
    const row = (id) => list.find((c) => c.id === id);
    assert.equal(row(ctx.chat.id)?.copy, null, `the creator in main shows its created copy: ${JSON.stringify(row(ctx.chat.id)?.copy)}`);
    assert.deepEqual(row(b.id)?.copy, { name: "k2", state: "ready" }, "the chat in k2 does not show its copy");
    // A switches to k1: now it shows it.
    assert.equal((await patch(ctx, { instance: copyInstance("k1") })).status, 200);
    const list2 = await json(`${ctx.base}/api/chats?workspaceId=${encodeURIComponent(ctx.chat.workspaceId)}`);
    assert.deepEqual(list2.find((c) => c.id === ctx.chat.id)?.copy, { name: "k1", state: "ready" });
  });
});
