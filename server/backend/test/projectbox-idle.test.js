// Idle state, lock and wakeup PER IDENTIFIER (projectbox/idle.js, header "PER IDENTIFIER").
//
// The instance of a chat comes through the hook `setInstanceForChat`; the test sets it itself: chat B sits in the copy
// `copy-k1`, chat A in the main instance.
//
// What holds:
//   (1) Without a copy `instanceIdle(<pid>/main)` is exactly `projectIdle(pid)` - quiet and with a running turn - and
//       `projectLocks(pid, { reason: "recreate" })` locks as before (projectLocked names it). An identifier that is none throws.
//   (2) A turn on the copy holds the COPY, not the main instance: recreating the main instance locks (and halts only the
//       main chat), recreating the copy waits with the copy's chat as open, a relocation (the whole project) likewise. After
//       the turn the copy locks too.
//   (3) Composer: while the copy is locked a message to B waits (queued, locked), one to A runs at once; resolving wakes B
//       (wakeProject per instance). A project lock and an instance lock exclude each other, two instances lock side by
//       side; "relocation" takes no instance.
//   (4) Without the copy's row a turn or agent of B ends visibly (error, never in the main instance), a oneshot runs; while
//       the copy is working (recreate, clearAway) B waits, A does not.
//   (5) "freeze" takes only the main instance - A's turn and agent wait, B (ready copy) runs on, also through the composer;
//       a relocation and a recreate of the main instance are excluded; resolving wakes A. A copy can be frozen too (as the
//       template of a copy from a copy) - its lock applies only to it, not to the main instance.
//   (6) A living subagent whose core is pinned to the MAIN instance (converted project, the turn ran in the project
//       container) while its chat now sits in the copy: it holds the main instance's idle state (recreating the main
//       instance does not lock under it), and a start FROM its core (the grandchild) judges the main instance (`start` =>
//       denied with a reason), not the chat's ready copy.
//   (7) The same for dynamic workflows: the next agent of a workflow pinned to the main instance waits at the main
//       instance's lock (journal "waiting", reason "project") although the chat sits in the ready copy; afterwards it runs.
//   (8) `countTerminals`: an open project terminal is open work - the lock does not stand (`open` with reason "terminal"), the
//       terminal stays; without the option the same lock ends it with a notice (`terminalsEnded: 1`).
//
// COUNTER-TESTS (each shown red, then reverted):
//   idle.js projectLocks: the per-project idle state also for "recreate"       => (2) red (the main instance does not lock - B open)
//   idle.js lockFor: every instance lock applies to the whole project         => (2) red (B waits for the main instance), (3) red
//                                                                                 (the copy's lock applies to the main instance)
//   idle.js projectLock: copy without row => fallback to the main instance (null) => (4) red
//   idle.js: "freeze" as a lock on the whole project again                     => (5) red ("the main instance's pause applies to the copy")
//   runs/agents.js coresInProject: `identifier: null`                          => (6) red ("the main instance counts as quiet although ...")
//   runs/agents.js gateForAgent does not pass the identifier on               => (6) red ("the grandchild ran past the main instance's lock")
//   idle.js projectLock does not evaluate the identifier                       => (6) red ("the lock judged the chat's copy")
//   dynworkflows/run.js gateFor without identifier                            => (7) red (agent #2 "failed" instead of "waiting")
//   idle.js `const open = countTerminals && ...` => `const open = false && ...`   => (8) red
//
// Waiting only on events: gates of the fake CLI, states (`waitForTruthy` without deadline), the server's quiet.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { setInstanceState } from "../electron/server/projectbox/instances.js";
import { countTerminalsByTag, createTerminal, killTerminal, terminalAvailable } from "../electron/server/terminal.js";
import {
  instanceIdle, projectLocked, projectIdle, projectLock, projectLocks, setInstanceForChat,
} from "../electron/server/projectbox/idle.js";
import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { readJsonl } from "./jsonl.mjs";

// The main agent writes one line per turn to main.jsonl; "{MAINGATE:x}" holds it at gate x.
const MAIN = `
  fs.appendFileSync(path.join(LOCATION, "main.jsonl"), JSON.stringify({ turn, text }) + "\\n");
  if (text.includes("{MAINGATE:")) await gate(text.split("{MAINGATE:")[1].split("}")[0]);
  say({ type: "assistant", message: { id: "c-" + Date.now(), content: [{ type: "text", text: "Answer " + turn }] } });
  finished();
  say({ type: "result", result: "Answer " + turn, session_id: "main-session" });`;
const CLAUDE = fakeClaude({ main: MAIN });

const turns = (root) => readJsonl(path.join(root, "main.jsonl"));
const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const send = (ctx, chatId, text) => post(`${ctx.base}/api/chats/${chatId}/message`, { text });
const COPY = "copy-k1";

// The operating marks, read at run time - set AFTER the server ran (built like project-lock.test.js).
const TUNABLES = ["CBASE_CONTAINER", "CBASE_DIND", "CBASE_DOCKER_BIN"];
async function inOps(fd, fn) {
  const saved = Object.fromEntries(TUNABLES.map((k) => [k, process.env[k]]));
  try {
    Object.assign(process.env, { CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin });
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// Without an account (built like project-lock.test.js): the wakeup checks the limit - without this the server would read the
// keychain and ask the usage endpoint of the REAL account; `npx` as a no-op.
async function withoutAccount(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-idle-account-"));
  const prior = { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN, NPX_BIN: process.env.NPX_BIN };
  try {
    const shim = path.join(root, "shim");
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, "security"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    fs.writeFileSync(path.join(shim, "npx"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    for (const d of ["home", "codex-home"]) fs.mkdirSync(path.join(root, d));
    process.env.HOME = path.join(root, "home");
    process.env.CODEX_HOME = path.join(root, "codex-home");
    process.env.PATH = `${shim}:${process.env.PATH}`;
    process.env.NPX_BIN = path.join(shim, "npx");
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { console.warn(`cleaning up ${root}: ${e.code || e.message}`); }
  }
}

// A project with two chats: A (the harness chat) in the main instance, B in the copy (through the hook). The copy's row is
// `ready`, without `converted_at` - it locks nothing by itself, and the turns run without docker in B.
async function twoChats(ctx, name, { copyRow = true } = {}) {
  const filePath = path.join(ctx.root, "workspace", name.toLowerCase());
  fs.mkdirSync(filePath, { recursive: true });
  const p = await post(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { name, path: filePath });
  await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
  const b = await post(`${ctx.base}/api/chats`, { workspaceId: ctx.ws.id, projectId: p.id, title: "Copy chat" });
  assert.ok(b?.id, JSON.stringify(b));
  if (copyRow) store.createProjectInstance({ projectId: p.id, instance: COPY, state: "ready", chatId: b.id, copyName: "k1" });
  return { p, a: ctx.chat.id, b: b.id };
}

// One test's server; the hook is taken back in the finally (every chat in the main instance again), and an instance still
// working is set to `ready` afterwards (otherwise the harness's quiet would wait for ever after a failure).
function withServer(fn, claude = CLAUDE) {
  return withAgentsServer(async (ctx) => {
    try { await fn(ctx); }
    finally {
      setInstanceForChat(null);
      for (const z of store.projectInstancesInState(store.PROJECT_WORK_STATES)) {
        try { setInstanceState(z.projectId, z.instance, "ready"); } catch (e) { console.warn(`[idle] cleaning up ${z.identifier}: ${e?.message || e}`); }
      }
    }
  }, { claude });
}
const copyFor = (b) => (chatId) => (chatId === b ? COPY : "main");

// ── (1) main instance without copy ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(1) without a copy the main instance's idle state is the project's - quiet and with a running turn; recreate locks as before; a wrong identifier throws", async () => {
  const fd = await fakeDocker();
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const filePath = path.join(ctx.root, "workspace", "individual");
      fs.mkdirSync(filePath, { recursive: true });
      const p = await post(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { name: "Single", path: filePath });
      await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
      const identifier = `${p.id}/main`;
      assert.deepEqual(instanceIdle(identifier), projectIdle(p.id));
      assert.equal(projectIdle(p.id).quiet, true);

      await send(ctx, ctx.chat.id, "HALT {MAINGATE:g2}");
      try {
        await ctx.gate.reached("g2");
        const l = projectIdle(p.id);
        assert.equal(l.quiet, false, JSON.stringify(l));
        assert.deepEqual(instanceIdle(identifier), l, "the main instance without a copy judges differently from the project");
        await inOps(fd, async () => {
          const s = projectLocks(p.id, { reason: "recreate" });
          assert.equal(s.ok, false, JSON.stringify(s));
          assert.deepEqual(s.open, l.open);
          assert.equal(projectLocked(p.id), null);
        });
      } finally { ctx.gate.open("g2"); } // also after a failure: otherwise the harness's quiet would wait for the turn
      await ctx.waitForQuiet();

      await inOps(fd, async () => {
        const s = projectLocks(p.id, { reason: "recreate" });
        assert.equal(s.ok, true, JSON.stringify(s));
        try {
          assert.equal(projectLocked(p.id)?.reason, "recreate", "the main instance's lock is named as before");
          assert.equal(projectLock(ctx.chat.id, "turn")?.kind, "wait");
        } finally { assert.equal(s.resolve(), true); }
        assert.equal(projectLocked(p.id), null);
      });
      for (const wrong of ["", "without-slash", `${p.id}/copy-K1`, `${p.id}/copy-`, "/main"]) {
        assert.throws(() => instanceIdle(wrong), TypeError, wrong);
      }
      assert.deepEqual(fd.calls(), [], "no docker");
    }));
  } finally { fd.cleanUp(); }
});

// ── (2) a copy's turn holds the copy ─────────────────────────────────────────────────────────────────────────────────────────

test("(2) a turn on the copy holds the copy, not the main instance: recreating the main instance locks (only A waits), recreating the copy and a relocation wait with B open; afterwards the copy locks too", async () => {
  const fd = await fakeDocker();
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const { p, a, b } = await twoChats(ctx, "Latch");
      setInstanceForChat(copyFor(b));
      await send(ctx, b, "COPY-TURN {MAINGATE:k}");
      try {
        await ctx.gate.reached("k");
        const copy = instanceIdle(`${p.id}/${COPY}`);
        assert.equal(copy.quiet, false);
        assert.ok(copy.open.every((o) => o.chatId === b) && copy.open.length, `open in the copy: ${JSON.stringify(copy.open)}`);
        assert.deepEqual(instanceIdle(`${p.id}/main`).open, [], "the copy's turn counts for the main instance");
        assert.equal(projectIdle(p.id).quiet, false, "the whole project is not quiet");

        await inOps(fd, async () => {
          const main = projectLocks(p.id, { reason: "recreate" });
          assert.equal(main.ok, true, `the main instance does not lock although only the copy works: ${JSON.stringify(main)}`);
          try {
            assert.equal(projectLock(a, "turn")?.kind, "wait", "A (main instance) does not wait");
            assert.equal(projectLock(b, "turn"), null, "B (copy) does not wait for the recreate of the main instance");
            const second = projectLocks(p.id, { reason: "recreate", instance: COPY });
            assert.equal(second.ok, false, "the copy locks in the middle of its turn");
            assert.ok(second.open.some((o) => o.chatId === b), JSON.stringify(second.open));
            const relocation = projectLocks(p.id, { reason: "relocation" });
            assert.equal(relocation.ok, false);
            assert.ok(relocation.open.some((o) => o.reason === "locked"), "a relocation beside an instance's lock");
          } finally { main.resolve(); }
          const relocation = projectLocks(p.id, { reason: "relocation" });
          assert.equal(relocation.ok, false, "a relocation in the middle of the copy's turn");
          assert.ok(relocation.open.some((o) => o.chatId === b), JSON.stringify(relocation.open));
        });
      } finally { ctx.gate.open("k"); } // also after a failure: otherwise the harness's quiet would wait for the turn
      await ctx.waitForQuiet();
      await inOps(fd, async () => {
        const s = projectLocks(p.id, { reason: "recreate", instance: COPY });
        assert.equal(s.ok, true, JSON.stringify(s));
        assert.equal(s.resolve(), true);
      });
      assert.deepEqual(fd.calls(), [], "no docker");
    }));
  } finally { fd.cleanUp(); }
});

// ── (3) composer and wakeup per instance ──────────────────────────────────────────────────────────────────────────────

test("(3) Composer: copy locked => B waits (queued, locked), A runs at once; resolving wakes B; project and instance lock exclude each other, two instances side by side", async () => {
  const fd = await fakeDocker();
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const { p, a, b } = await twoChats(ctx, "Composer");
      setInstanceForChat(copyFor(b));
      await inOps(fd, async () => {
        const s = projectLocks(p.id, { reason: "recreate", instance: COPY });
        assert.equal(s.ok, true, JSON.stringify(s));
        let free = false;
        try {
          assert.deepEqual(projectLocked(p.id), null, "the copy's lock applies to the main instance");
          assert.equal(projectLocked(p.id, COPY)?.reason, "recreate");
          const prior = turns(ctx.root).length;
          const wb = await send(ctx, b, "TO-B during the copy's lock");
          assert.equal(wb.locked, true, JSON.stringify(wb));
          const wa = await send(ctx, a, "TO-A during the copy's lock");
          assert.notEqual(wa.locked, true, `A waits for the copy's lock: ${JSON.stringify(wa)}`);
          await waitForTruthy(() => turns(ctx.root).some((t) => t.text.includes("TO-A")), "turn of A");
          // Not the server's quiet: B's message stays in the queue while the copy is locked.
          await waitForTruthy(async () => (await json(`${ctx.base}/api/runs/active`)).runs === 0, "turn of A finished");
          assert.ok(!turns(ctx.root).slice(prior).some((t) => t.text.includes("TO-B")), "B ran despite the lock");

          // Side by side: the main instance locks beside the copy; a relocation (the whole project) does not, and it takes no instance.
          const h = projectLocks(p.id, { reason: "recreate" });
          assert.equal(h.ok, true, JSON.stringify(h));
          assert.equal(projectLocks(p.id, { reason: "relocation" }).ok, false);
          assert.throws(() => projectLocks(p.id, { reason: "relocation", instance: COPY }), /whole project/);
          assert.equal(projectLocks(p.id, { reason: "recreate", instance: COPY }).ok, false, "the same instance twice");
          assert.equal(h.resolve(), true);

          free = s.resolve();
          assert.equal(free, true);
          await waitForTruthy(() => turns(ctx.root).some((t) => t.text.includes("TO-B")), "turn of B after resolving");
          await ctx.waitForQuiet();
        } finally { if (!free) s.resolve(); }
        // The other way round: a project lock excludes an instance lock.
        const u = projectLocks(p.id, { reason: "relocation" });
        assert.equal(u.ok, true, JSON.stringify(u));
        try {
          assert.equal(projectLocks(p.id, { reason: "recreate", instance: COPY }).ok, false);
          assert.equal(projectLock(b, "turn")?.kind, "wait", "the relocation does not halt the copy");
        } finally { u.resolve(); }
        await ctx.waitForQuiet();
      });
      assert.deepEqual(fd.calls(), [], "no docker");
    }));
  } finally { fd.cleanUp(); }
});

// ── (4) missing row and state of the copy ───────────────────────────────────────────────────────────────────────────────

test("(4) without the copy's row a turn/agent of B ends visibly (error), a oneshot runs; while the copy works, B waits and A does not", async () => {
  const fd = await fakeDocker();
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const { p, a, b } = await twoChats(ctx, "No-row", { copyRow: false });
      setInstanceForChat(copyFor(b));
      await inOps(fd, async () => {
        const turn = projectLock(b, "turn");
        assert.equal(turn?.kind, "error", `a copy without a row fell back to the main instance: ${JSON.stringify(turn)}`);
        assert.match(turn.text, /Kopie „copy-k1“/);
        assert.equal(projectLock(b, "agent")?.kind, "error");
        assert.equal(projectLock(b, "oneshot"), null, "a oneshot runs in B");
        assert.equal(projectLock(a, "turn"), null, "A is affected");

        for (const state of ["recreate", "clearAway"]) {
          if (store.projectInstance(p.id, COPY)) setInstanceState(p.id, COPY, state);
          else store.createProjectInstance({ projectId: p.id, instance: COPY, state, chatId: b, copyName: "k1" });
          assert.equal(projectLock(b, "turn")?.kind, "wait", state);
          assert.equal(projectLock(a, "turn"), null, `${state}: A waits for the copy`);
        }
        setInstanceState(p.id, COPY, "ready");
        assert.equal(projectLock(b, "turn"), null);
      });
      assert.deepEqual(fd.calls(), [], "no docker");
    }));
  } finally { fd.cleanUp(); }
});

// ── (5) "freeze" takes only the main instance ───────────────────────────────────────────────────

test("(5) \"freeze\" takes only the main instance - A waits (turn, agent, composer), B in the ready copy runs on; relocation and recreate of the main instance excluded; a copy (as template) freezes only itself; resolving wakes A", async () => {
  const fd = await fakeDocker();
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const { p, a, b } = await twoChats(ctx, "Freezing");
      setInstanceForChat(copyFor(b));
      await inOps(fd, async () => {
        // A copy can be frozen - as the TEMPLATE of a copy from a copy; its lock applies only to it.
        const sk = projectLocks(p.id, { reason: "freeze", instance: COPY });
        assert.equal(sk.ok, true, JSON.stringify(sk));
        try {
          assert.equal(projectLocked(p.id, COPY)?.reason, "freeze", "the template is frozen");
          assert.equal(projectLocked(p.id), null, "the template's pause applies to the main instance");
          assert.equal(projectLocks(p.id, { reason: "freeze", instance: COPY }).ok, false, "the template frozen twice");
        } finally { assert.equal(sk.resolve(), true); }
        assert.equal(projectLocked(p.id, COPY), null);
        const s = projectLocks(p.id, { reason: "freeze" });
        assert.equal(s.ok, true, JSON.stringify(s));
        let free = false;
        try {
          assert.equal(projectLocked(p.id)?.reason, "freeze", "the main instance's lock is named as before");
          assert.equal(projectLocked(p.id, COPY), null, "the main instance's pause applies to the copy");
          assert.equal(projectLock(a, "turn")?.reason, "freeze");
          assert.equal(projectLock(a, "agent")?.kind, "wait");
          assert.equal(projectLock(b, "turn"), null, "B waits for the main instance's pause (turn)");
          assert.equal(projectLock(b, "agent"), null, "B waits for the main instance's pause (agent)");
          assert.equal(projectLocks(p.id, { reason: "relocation" }).ok, false, "a relocation beside the freeze");
          assert.equal(projectLocks(p.id, { reason: "recreate" }).ok, false, "a recreate of the main instance beside the freeze");
          assert.equal(projectLocks(p.id, { reason: "freeze" }).ok, false, "frozen twice");

          const prior = turns(ctx.root).length;
          const wa = await send(ctx, a, "TO-A during the pause");
          assert.equal(wa.locked, true, JSON.stringify(wa));
          const wb = await send(ctx, b, "TO-B during the pause");
          assert.notEqual(wb.locked, true, `B waits for the main instance's pause: ${JSON.stringify(wb)}`);
          await waitForTruthy(() => turns(ctx.root).some((t) => t.text.includes("TO-B")), "turn of B during the pause");
          await waitForTruthy(async () => (await json(`${ctx.base}/api/runs/active`)).runs === 0, "turn of B finished");
          assert.ok(!turns(ctx.root).slice(prior).some((t) => t.text.includes("TO-A")), "A ran despite the pause");

          free = s.resolve();
          assert.equal(free, true);
          await waitForTruthy(() => turns(ctx.root).some((t) => t.text.includes("TO-A")), "turn of A after resolving");
          await ctx.waitForQuiet();
        } finally { if (!free) s.resolve(); }
        assert.equal(projectLocked(p.id), null);
      });
      assert.deepEqual(fd.calls(), [], "no docker");
    }));
  } finally { fd.cleanUp(); }
});

// ── (6) a core pinned to the main instance while its chat sits in the copy ──
// With "BACKGROUND" the main agent starts a subagent in the background; it holds at gate "f-1" and then calls cbase_agent
// itself (the grandchild - a start FROM its core, result under grandchild-result). Built like project-lock.test.js and
// inProject.test.js; here with a converted project so that the core carries an identifier. "WF[tag]:{json}" calls
// cbase_dynamic_workflow (result under wf-<tag>) - for (7).
const MAIN_AG = `
  fs.appendFileSync(path.join(LOCATION, "main.jsonl"), JSON.stringify({ turn, text }) + "\\n");
  if (text.includes("BACKGROUND")) {
    const args = { description: "pinned", prompt: "Read {TAG:f} {GATE:f} {ENKEL}", run_in_background: true };
    say({ type: "assistant", message: { id: "m-bg", content: [{ type: "tool_use", id: "toolu_bg", name: "mcp__cbase__cbase_agent", input: args }] } });
    const r = await mcpCall("cbase_agent", args);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: textOf(r) }] } });
  }
  const wf = text.indexOf("WF[");
  if (wf >= 0 && !text.includes("<task-notification>")) {
    const tag = text.slice(wf + 3, text.indexOf("]:", wf));
    const args = JSON.parse(text.slice(text.indexOf("]:", wf) + 2));
    const id = "toolu_wf_" + tag;
    say({ type: "assistant", message: { id: "a-" + tag, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_dynamic_workflow", input: args }] } });
    let t = "";
    try { const r = await mcpCall("cbase_dynamic_workflow", args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    { const z = path.join(LOCATION, "wf-" + tag); fs.writeFileSync(z + ".teil", t); fs.renameSync(z + ".teil", z); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  say({ type: "assistant", message: { id: "c-" + Date.now(), content: [{ type: "text", text: "Answer " + turn }] } });
  finished();
  say({ type: "result", result: "Answer " + turn, session_id: "main-session" });`;
const SUB_AG = `
    const ab = text.lastIndexOf("Here is the task:");
    const job = ab >= 0 ? text.slice(ab) : text;
    const tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : "x";
    fs.appendFileSync(path.join(LOCATION, "sub-start-" + tag), "x");
    const nr = fs.readFileSync(path.join(LOCATION, "sub-start-" + tag), "utf8").length;
    say({ type: "assistant", message: { id: "s-" + tag + nr, content: [{ type: "text", text: "working " + tag }] } });
    if (job.includes("{GATE:")) await gate(job.split("{GATE:")[1].split("}")[0] + "-" + nr);
    if (job.includes("{ENKEL}")) {
      const args = { description: "grandchild", prompt: "Help {TAG:grandchild}", run_in_background: false };
      say({ type: "assistant", message: { id: "s-grandchild", content: [{ type: "tool_use", id: "toolu_grandchild", name: "mcp__cbase__cbase_agent", input: args }] } });
      let t = "";
      try { const r = await mcpCall("cbase_agent", args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
      fs.writeFileSync(path.join(LOCATION, "grandchild-result"), t);
    }
    finished();
    say({ type: "result", result: "Finding " + tag, session_id: "sub-" + tag + "-s" });`;
const CLAUDE_AG = fakeClaude({ main: MAIN_AG, sub: SUB_AG });
const spawns = (root, tag) => { const f = path.join(root, `sub-start-${tag}`); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").length : 0; };

// Operation with a running project container (built like inProject.test.js): the CLIs' homes in B in the fake docker's
// throw-away folder, the escalation short.
const OPS_AG = ["CBASE_CONTAINER", "CBASE_DIND", "CBASE_DOCKER_BIN", "CBASE_IN_PROJECT_ESCALATION_MS", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];
async function inOpsWithContainer(fd, fn) {
  const saved = Object.fromEntries(OPS_AG.map((k) => [k, process.env[k]]));
  try {
    Object.assign(process.env, { CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200",
      CLAUDE_CONFIG_DIR: path.join(fd.dir, "b-home", ".claude"), CODEX_HOME: path.join(fd.dir, "b-home", ".codex") });
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("(6) a subagent pinned to the main instance holds the main instance's idle state although its chat sits in the copy; a start from its core judges the main instance", async () => {
  const fd = await fakeDocker();
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      await inOpsWithContainer(fd, async () => {
        const filePath = path.join(ctx.root, "workspace", "pinned");
        fs.mkdirSync(filePath, { recursive: true });
        const p = await ctx.projectWithoutInstance({ name: "Pinned", path: filePath });
        const name = `cbase-p-${p.id}`;
        execFileSync(fd.bin, ["run", "-d", "--name", name, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
        store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: name });
        store.createProjectInstance({ projectId: p.id, instance: COPY, state: "ready", convertedAt: Date.now(), chatId: ctx.chat.id, copyName: "k1" });
        await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
        const chat = ctx.chat.id;
        const main = `${p.id}/main`;
        const runningNothing = async () => (await json(`${ctx.base}/api/runs/active`)).runs === 0;
        const nothingAlive = async () => { const s = await json(`${ctx.base}/api/runs/active`); return s.runs === 0 && !(s.agents || []).length; };

        await send(ctx, chat, "BACKGROUND");
        // Gate OR end of the run including subagents (built like inProject.test.js): if its start fails, `reached` would hang.
        const marker = path.join(ctx.root, "gates", "f-1.waiting");
        await waitForTruthy(async () => fs.existsSync(marker) || (await nothingAlive()), "gate f-1 or end of run including subagents");
        assert.ok(fs.existsSync(marker), `the subagent did not reach its gate (history: ${JSON.stringify(await json(`${ctx.base}/api/chats/${chat}/log`)).slice(-600)})`);
        await waitForTruthy(runningNothing, "turn finished, the subagent lives");
        try {
          const [image] = store.subagentsOf(chat);
          assert.equal(image?.instance, main, `the core does not carry the main instance's identifier: ${JSON.stringify(image).slice(0, 300)}`);

          // The chat moves into the copy. Its core stays pinned to the main instance.
          setInstanceForChat(() => COPY);

          // The main instance's idle state sees the subagent - through its core's identifier, not through the chat.
          const l = instanceIdle(main);
          assert.equal(l.quiet, false, "the main instance counts as quiet although a subagent pinned in it lives");
          assert.ok(l.open.some((o) => o.reason === "agent" && o.chatId === chat && o.agentId), JSON.stringify(l.open));
          const s = projectLocks(p.id, { reason: "recreate" });
          assert.equal(s.ok, false, `recreating the main instance locked under the pinned subagent: ${JSON.stringify(s)}`);
          assert.ok(s.open.some((o) => o.reason === "agent"), JSON.stringify(s.open));

          // The main instance (re)starts - a start from the core judges the main instance, not the ready copy.
          setInstanceState(p.id, "main", "start");
          assert.equal(projectLock(chat, "agent", { projectId: p.id, identifier: main })?.kind, "wait", "the lock judged the chat's copy");
          assert.equal(projectLock(chat, "agent", { projectId: p.id }), null, "without an identifier the chat's instance counts (the copy is ready)");
          ctx.gate.open("f-1");
          await waitForTruthy(() => fs.existsSync(path.join(ctx.root, "grandchild-result")), "result of the grandchild call");
          const t = fs.readFileSync(path.join(ctx.root, "grandchild-result"), "utf8");
          assert.match(t, /Projekt-Container startet/, `the grandchild ran past the main instance's lock: ${t.slice(0, 300)}`);
          assert.equal(spawns(ctx.root, "grandchild"), 0, "no grandchild started");
        } finally {
          ctx.gate.open("f-1");
          if (store.projectInstance(p.id)?.state !== "ready") setInstanceState(p.id, "main", "ready");
        }
        await ctx.waitForQuiet();
        setInstanceForChat(null);
        assert.equal(instanceIdle(main).quiet, true, "after the subagent the main instance is quiet");
      });
    }, CLAUDE_AG));
  } finally { fd.cleanUp(); }
});

// ── (7) a dynamic workflow pinned to the main instance while its chat sits in the copy ──
// Built like project-lock.test.js: agent #1 holds at gate "wa-1"; then the chat moves into the copy, the main instance
// restarts - agent #2 (a start from the workflow's core) waits at the MAIN instance's lock, not at the ready copy.
test("(7) a dynamic workflow pinned to the main instance waits with its next agent at the main instance's lock although its chat sits in the ready copy", async () => {
  const fd = await fakeDocker();
  process.env.CBASE_DYNWF_STAGGER_MS = "0";
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      await inOpsWithContainer(fd, async () => {
        const filePath = path.join(ctx.root, "workspace", "fixedwf");
        fs.mkdirSync(filePath, { recursive: true });
        const p = await ctx.projectWithoutInstance({ name: "FixedWf", path: filePath });
        const name = `cbase-p-${p.id}`;
        execFileSync(fd.bin, ["run", "-d", "--name", name, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
        store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: name });
        store.createProjectInstance({ projectId: p.id, instance: COPY, state: "ready", convertedAt: Date.now(), chatId: ctx.chat.id, copyName: "k1" });
        const chat = ctx.chat.id;
        await json(`${ctx.base}/api/chats/${chat}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id, model: "claude-opus-5-5", ultracode: true }) });
        const script = [
          "export const meta = { name: 'fest', description: 'Fixed', phases: [{ title: 'One' }] }",
          "const a = await agent('A {TAG:wa} {GATE:wa}', { label: 'a' });",
          "const b = await agent('B {TAG:wb}', { label: 'b' });",
          "return { a, b };",
        ].join("\n");
        await send(ctx, chat, `WF[w]:${JSON.stringify({ script })}`);
        await waitForTruthy(() => fs.existsSync(path.join(ctx.root, "wf-w")), "tool result");
        const r = JSON.parse(fs.readFileSync(path.join(ctx.root, "wf-w"), "utf8"));
        assert.equal(r.status, "started", JSON.stringify(r));
        const entries = (n) => store.readDynJournal(r.runId).filter((e) => e.n === n);
        // Gate OR end of the workflow: if agent #1 fails, `reached` would hang.
        const marker = path.join(ctx.root, "gates", "wa-1.waiting");
        await waitForTruthy(() => fs.existsSync(marker) || store.readDynRun(r.runId)?.status !== "running", "gate wa-1 or end of run");
        assert.ok(fs.existsSync(marker), `agent #1 did not reach its gate: ${JSON.stringify(store.readDynRun(r.runId)).slice(0, 400)}`);
        await waitForTruthy(async () => (await json(`${ctx.base}/api/runs/active`)).runs === 0, "turn finished, the workflow runs");
        try {
          setInstanceForChat(() => COPY);
          const open = instanceIdle(`${p.id}/main`).open.map((o) => o.reason);
          assert.ok(open.includes("workflow"), `the workflow in the main instance dropped out of the main instance's idle state: ${open}`);
          setInstanceState(p.id, "main", "start");
          ctx.gate.open("wa-1");
          const b = await waitForTruthy(() => entries(2).find((e) => e.kind !== "launched") || null, "state of agent #2");
          assert.equal(b.kind, "waiting", `agent #2 does not wait at the main instance's lock: ${JSON.stringify(b)}`);
          assert.equal(b.reason, "project");
          assert.equal(spawns(ctx.root, "wb"), 0, "no spawn while the main instance starts");
          setInstanceState(p.id, "main", "ready");
          const run = await waitForTruthy(() => (store.readDynRun(r.runId)?.status !== "running" ? store.readDynRun(r.runId) : null), "run finished");
          assert.equal(run.status, "finished", JSON.stringify(run));
          assert.equal(spawns(ctx.root, "wb"), 1);
        } finally {
          ctx.gate.open("wa-1");
          if (store.projectInstance(p.id)?.state !== "ready") setInstanceState(p.id, "main", "ready");
        }
        await ctx.waitForQuiet();
        setInstanceForChat(null);
      });
    }, CLAUDE_AG));
  } finally {
    delete process.env.CBASE_DYNWF_STAGGER_MS;
    fd.cleanUp();
  }
});

// ── (8) terminals count as work ────────────────────────────────────────────────────────────────────────────────────────────
test("(8) countTerminals: an open project terminal is open work - the lock does not stand, the terminal stays; without the option the lock ends it with a notice", async () => {
  assert.ok(terminalAvailable(), "node-pty is missing - this guard needs a real shell");
  const fd = await fakeDocker();
  const shells = [];
  try {
    await withoutAccount(() => withServer(async (ctx) => {
      const filePath = path.join(ctx.root, "workspace", "with-terminal");
      fs.mkdirSync(filePath, { recursive: true });
      const projectId = `an8t${Date.now().toString(36)}`;
      store.addProject(ctx.ws.id, { id: projectId, name: "With terminal", path: filePath, createdAt: Date.now() });
      const tag = `proj:${projectId}`;
      shells.push(createTerminal({ cwd: ctx.root, command: "/bin/sleep", args: ["600"], tag }).id);
      assert.equal(projectIdle(projectId).terminals, 1);
      await inOps(fd, async () => {
        const z = projectLocks(projectId, { countTerminals: true });
        assert.equal(z.ok, false, JSON.stringify(z));
        assert.deepEqual(z.open.map((o) => o.reason), ["terminal"]);
        assert.equal(projectLocked(projectId), null, "the lock stayed");
        assert.equal(countTerminalsByTag(tag), 1, "countTerminals ended the terminal");
        const s = projectLocks(projectId);
        assert.equal(s.ok, true, JSON.stringify(s));
        try {
          assert.equal(s.terminalsEnded, 1);
          assert.equal(countTerminalsByTag(tag), 0, "without the option the terminal stays open");
        } finally { assert.equal(s.resolve(), true); }
      });
      assert.deepEqual(fd.calls(), [], "no docker");
    }));
  } finally {
    for (const id of shells) killTerminal(id);
    fd.cleanUp();
  }
});
