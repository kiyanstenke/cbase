// A project's terminal and debugger against the lock and idle state of ITS instance (devtools/code-route.js `/terminal` and
// `/debug/launch`, devtools/routes.js `sessionLock`/`sessionTag`, projectbox/idle.js `projectTerminalTag`, stacks/clearAway.js step 0).
//
// THE GAPS.
//   Finding 9: the chat bar's terminal (tag `chat:<id>`, no `?chat`) starts in the instance of ITS chat -- but the lock asked the
//     route's instance (without `?chat` the main one). A copy chat got a terminal INSIDE its copy during "recreate" (in the middle of
//     docker stop/rm), yet a 409 during "freeze" of the main one. And a tag contradicting the chosen `?instance=` silently overrode it.
//   Finding 10: the code tab's terminal arrives without a tag (web `{cols, rows}`, iOS without a tag) and runs in a copy with
//     `?instance=` -- idle state and lock counted only `proj:<id>` and `chat:<id>`: it held no recreate, ended without a notice, and
//     removing the copy left it standing until the container died. The debugger (`/debug/launch`) had no lock check and no tag at all.
//
// The promises, each with the path that breaks it:
//   (1) Finding 9: tag `chat:<copy chat>` without `?chat` -- copy "recreate" => 409 LOCKED, no terminal; main "freeze" => 201 and
//       a `docker exec -t` into the COPY's container; `?instance=<p>/main` with the tag => 400 INSTANCE_INVALID, `?instance=<p>/copy-k1` => 201.
//   (2) Finding 10: a terminal WITHOUT a tag carries its instance's tag (`proj:<p>@copy-k1` or `proj:<p>`), counts in that instance's
//       idle state (`terminals`) and ends with a notice under its lock; a debugger under the copy's lock => 409; a debugger in the main
//       one carries `proj:<p>`, counts and ends under the main one's lock.
//   (3) Finding 10: removing the copy ends its code-tab terminal in step 0 with a notice -- not only when the container dies.
//   (4) Likewise the chat bar's terminal of a chat of the copy (`chat:<id>`) -- it used to live until the move-out (`removed`, after
//       `docker stop`) and wrote through fetching and saving; from step 0 no new one opens either (409 LOCKED, the instance row is
//       at `clearAway`). Checked BEFORE step 1 (test seam setClearAwayObserverForTest).
//
// No clock: the copy is built through the real sequence (stacks-copy-harness.mjs); the test waits on states (waitForTruthy without a
// deadline). Routes run over a stub request and response (no network, like files-in-copy.test.js). Every PTY and debugger ends in finally.
//
// COUNTER-TESTS (one sabotage each on the repaired state, whole file run):
//   code-route.js  the terminal's lock asks the route's instance again (`opts.instance`)            => (1) red: 201 instead of 409
//   routes.js      withChoice lets every tag through                                                 => (1) red: 201 instead of 400
//   routes.js      sessionTag returns "" (no tag, the old state)                                     => (2) red (0 !== 1) and (3) red
//   code-route.js  the debugger's lock removed                                                       => (2) red: 201 instead of 409
//   code-route.js  the debugger without a tag                                                        => (2) red (0 !== 1)
//   clearAway.js   step 0 does not end the copy's sessions                                           => (3) red ("ended without a notice")
//   clearAway.js   step 0 calls endInstanceSessions without `{ chats: true }`                        => (4) red ("still alive in step 1")
//   routes.js      terminalLocked without the copy's row (writeLockCopy)                             => (4) red ("a new chat bar terminal during removal: 201")
// Run alone: CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
//   CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/project-terminal-copy.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { codeProjectRoutes } from "../electron/server/devtools/routes.js";
import { countDebugByTag, debugStop } from "../electron/server/debug.js";
import { instanceIdle, projectIdle, projectLocks } from "../electron/server/projectbox/idle.js";
import { instanceForProject, instanceIsCopy } from "../electron/server/runs/instance.js";
import { clearAwayCopy, setClearAwayObserverForTest } from "../electron/server/stacks/clearAway.js";
import { countTerminalsByTag, killTerminal, subscribeTerminal, terminalExists } from "../electron/server/terminal.js";
import { json, waitForTruthy } from "./agent-harness.mjs";
import { buildCopy, situationDefault, withCopy, withEnvironment } from "./stacks-copy-harness.mjs";

function stubResponse() {
  const r = { status: 0, parts: [], writeHead(c) { r.status = c; }, write(d) { r.parts.push(Buffer.from(d)); return true; }, end(d) { if (d) r.parts.push(Buffer.from(d)); } };
  Object.defineProperty(r, "json", { get: () => { try { return JSON.parse(Buffer.concat(r.parts).toString("utf8")); } catch { return null; } } });
  return r;
}
async function route(pid, { sub, query = "", body = {} }) {
  const req = new PassThrough();
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  req.end(JSON.stringify(body));
  const res = stubResponse();
  const url = new URL(`http://x/api/projects/${pid}${sub}${query}`);
  await codeProjectRoutes({ req, res, url, p: url.pathname, m: "POST", pid, sub, proj: store.getProject(pid) });
  return { status: res.status, body: res.json };
}
// A terminal's viewer: collects what the stream writes.
function viewer(id) {
  const parts = [];
  const res = { write(d) { parts.push(String(d)); return true; }, end() {}, on() {} };
  assert.ok(subscribeTerminal(id, res), "no terminal to watch");
  return () => parts.join("");
}
async function copyWithChat(ctx, b) {
  const pid = b.s.projectId;
  await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
  await buildCopy(b, { chatId: ctx.chat.id });
  assert.ok(instanceIsCopy(instanceForProject(pid, "copy-k1")), "the copy's instance must resolve");
}
// The `docker exec -t` calls (terminals) of the log -- the fake docker writes its line when the process starts, i.e. AFTER the route's
// answer: wait for the next line in ANY container, then check which one it ran in.
const terminalExecs = (b) => b.fd.calls().filter((a) => a.args[0] === "exec" && a.args.includes("-t"));

test("(1) finding 9: the chat bar terminal (tag chat:<copy chat>) asks the lock of ITS instance — copy recreate => 409, main freeze => 201 in the copy; a tag against ?instance => 400", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); }, async ({ ctx, b }) => {
    await copyWithChat(ctx, b);
    const pid = b.s.projectId;
    const tag = `chat:${ctx.chat.id}`;
    const open = [];
    try {
      await withEnvironment({ SHELL: "/bin/sh" }, async () => {
        // The copy is locked (recreate): no new terminal in it.
        const s = projectLocks(pid, { reason: "recreate", instance: "copy-k1" });
        assert.equal(s.ok, true, JSON.stringify(s));
        try {
          const r = await route(pid, { sub: "/terminal", body: { cols: 80, rows: 24, tag } });
          if (r.body?.id) open.push(r.body.id);
          assert.equal(r.status, 409, `a terminal under the copy's lock: ${JSON.stringify(r)}`);
          assert.deepEqual([r.body.code, r.body.reason], ["LOCKED", "recreate"]);
          assert.equal(countTerminalsByTag(tag), 0);
        } finally { s.resolve(); }

        // The main one is frozen (another copy is being built): the terminal runs in the ready copy — 201.
        const f = projectLocks(pid, { reason: "freeze" });
        assert.equal(f.ok, true, JSON.stringify(f));
        const prior = terminalExecs(b).length;
        try {
          const r = await route(pid, { sub: "/terminal", body: { cols: 80, rows: 24, tag } });
          if (r.body?.id) open.push(r.body.id);
          assert.equal(r.status, 201, `rejected during the main one's freeze: ${JSON.stringify(r)}`);
          assert.equal(r.body.available, true, JSON.stringify(r));
          const fresh = await waitForTruthy(() => { const e = terminalExecs(b); return e.length > prior ? e.slice(prior) : null; }, "the terminal's docker exec");
          assert.equal(fresh.length, 1);
          assert.ok(fresh[0].args.includes(b.copy) && !fresh[0].args.includes(b.main), `the terminal did not run in the copy: ${fresh[0].args.join(" ")}`);
        } finally { f.resolve(); }

        // The choice against the tag: ?instance=<p>/main with a copy chat's tag => 400; the same instance => 201.
        let r = await route(pid, { sub: "/terminal", query: `?instance=${encodeURIComponent(`${pid}/main`)}`, body: { cols: 80, rows: 24, tag } });
        if (r.body?.id) open.push(r.body.id);
        assert.equal(r.status, 400, `a tag overrode the choice: ${JSON.stringify(r)}`);
        assert.equal(r.body.code, "INSTANCE_INVALID");
        r = await route(pid, { sub: "/terminal", query: `?instance=${encodeURIComponent(`${pid}/copy-k1`)}`, body: { cols: 80, rows: 24, tag } });
        if (r.body?.id) open.push(r.body.id);
        assert.equal(r.status, 201, JSON.stringify(r));
      });
    } finally { for (const id of open) killTerminal(id); }
  });
});

test("(2) finding 10: a terminal without a tag and the debugger carry their instance's tag — idle counts them, the lock ends them with a notice; no debugger under a lock", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); }, async ({ ctx, b }) => {
    await copyWithChat(ctx, b);
    const pid = b.s.projectId;
    const K = `${pid}/copy-k1`;
    const open = [];
    const debugger_ = [];
    try {
      await withEnvironment({ SHELL: "/bin/sh" }, async () => {
        // The code tab's terminal in the copy (?instance=, no tag).
        const t = await route(pid, { sub: "/terminal", query: `?instance=${encodeURIComponent(K)}`, body: { cols: 80, rows: 24 } });
        if (t.body?.id) open.push(t.body.id);
        assert.equal(t.status, 201, JSON.stringify(t));
        assert.equal(countTerminalsByTag(`proj:${pid}@copy-k1`), 1, "the copy's terminal does not carry its instance's tag");
        assert.equal(countTerminalsByTag(`proj:${pid}`), 0, "the copy's terminal counts for the main one");
        assert.equal(instanceIdle(K).terminals, 1, "the copy's idle state does not see its terminal");
        assert.equal(instanceIdle(`${pid}/main`).terminals, 0);
        const looks = viewer(t.body.id);

        // Under the copy's lock: no debugger; the open terminal ends with a notice.
        const s = projectLocks(pid, { reason: "recreate", instance: "copy-k1" });
        assert.equal(s.ok, true, JSON.stringify(s));
        try {
          assert.equal(s.terminalsEnded, 1, JSON.stringify(s));
          assert.equal(terminalExists(t.body.id), false, "the copy's terminal survived the lock");
          assert.match(looks(), /neu angelegt — dieses Terminal wurde beendet/);
          const d = await route(pid, { sub: "/debug/launch", query: `?instance=${encodeURIComponent(K)}`, body: { file: "app/a.txt" } });
          if (d.body?.id) debugger_.push(d.body.id);
          assert.equal(d.status, 409, `a debugger under the copy's lock: ${JSON.stringify(d)}`);
          assert.deepEqual([d.body.code, d.body.reason], ["LOCKED", "recreate"]);
        } finally { s.resolve(); }

        // The main one: terminal without a tag => proj:<p>; a debugger there => proj:<p>. Both count, both end under the main one's lock.
        const h = await route(pid, { sub: "/terminal", body: { cols: 80, rows: 24 } });
        if (h.body?.id) open.push(h.body.id);
        assert.equal(h.status, 201, JSON.stringify(h));
        assert.equal(countTerminalsByTag(`proj:${pid}`), 1, "the main one's terminal does not carry proj:<id>");
        const prog = path.join(b.s.path, "prog.js");
        fs.writeFileSync(prog, "setInterval(() => {}, 1 << 30);\n");
        const d = await route(pid, { sub: "/debug/launch", body: { file: prog } });
        if (d.body?.id) debugger_.push(d.body.id);
        assert.equal(d.status, 201, JSON.stringify(d));
        assert.equal(countDebugByTag(`proj:${pid}`), 1, "the main one's debugger does not carry proj:<id>");
        assert.equal(projectIdle(pid).terminals, 2, "the project's idle state does not count terminal and debugger");
        const sh = projectLocks(pid, { reason: "recreate" });
        assert.equal(sh.ok, true, JSON.stringify(sh));
        try {
          assert.equal(sh.terminalsEnded, 2, JSON.stringify(sh));
          assert.equal(countTerminalsByTag(`proj:${pid}`), 0);
          assert.equal(countDebugByTag(`proj:${pid}`), 0, "the debugger survived the lock");
        } finally { sh.resolve(); }
      });
    } finally {
      for (const id of open) killTerminal(id);
      for (const id of debugger_) debugStop(id);
    }
  });
});

test("(3) finding 10: removing the copy ends its code-tab terminal in step 0 with a notice", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); }, async ({ b }) => {
    await buildCopy(b);
    const pid = b.s.projectId;
    let id = null;
    try {
      await withEnvironment({ SHELL: "/bin/sh" }, async () => {
        const t = await route(pid, { sub: "/terminal", query: `?instance=${encodeURIComponent(`${pid}/copy-k1`)}`, body: { cols: 80, rows: 24 } });
        id = t.body?.id || null;
        assert.equal(t.status, 201, JSON.stringify(t));
        const looks = viewer(id);
        const out = await clearAwayCopy(b.k.id, { reason: "test", ...b.opts });
        assert.equal(out.state, "removed", JSON.stringify(out.report).slice(0, 800));
        assert.match(looks(), /wird abgeräumt — dieses Terminal wurde beendet/, "the copy's terminal ended without a notice");
        await waitForTruthy(() => !terminalExists(id), "the copy's terminal has ended");
      });
    } finally { if (id) killTerminal(id); }
  });
});

test("(4) removing also ends the chat bar terminal of a copy chat in step 0 — with a notice; a new one does not open afterwards (409)", async () => {
  await withCopy(async (b, ctx) => { await situationDefault(b, ctx); }, async ({ ctx, b }) => {
    await copyWithChat(ctx, b);
    const pid = b.s.projectId;
    const tag = `chat:${ctx.chat.id}`;
    const open = [];
    const seen = [];
    try {
      await withEnvironment({ SHELL: "/bin/sh" }, async () => {
        const t = await route(pid, { sub: "/terminal", body: { cols: 80, rows: 24, tag } });
        if (t.body?.id) open.push(t.body.id);
        assert.equal(t.status, 201, JSON.stringify(t));
        assert.equal(countTerminalsByTag(tag), 1);
        const looks = viewer(t.body.id);
        // Before step 1 (after step 0): is the terminal still alive, and does a new one open?
        setClearAwayObserverForTest(async ({ step }) => {
          if (step !== "clear-fetch" || seen.length) return;
          const alive = terminalExists(t.body.id);
          const count = countTerminalsByTag(tag);
          const fresh = await route(pid, { sub: "/terminal", body: { cols: 80, rows: 24, tag } });
          if (fresh.body?.id) open.push(fresh.body.id);
          seen.push({ alive, count, notice: looks(), fresh });
        });
        let out;
        try { out = await clearAwayCopy(b.k.id, { reason: "test", ...b.opts }); } finally { setClearAwayObserverForTest(null); }
        assert.equal(out.state, "removed", JSON.stringify(out.report).slice(0, 800));
        assert.equal(seen.length, 1, "the observer did not run before step 1");
        const [g] = seen;
        assert.equal(g.alive, false, "the chat bar terminal was still alive in step 1 — it ended only with the move-out");
        assert.equal(g.count, 0);
        assert.match(g.notice, /wird abgeräumt — dieses Terminal wurde beendet/, "the chat bar terminal ended without a notice");
        assert.equal(g.fresh.status, 409, `a new chat bar terminal during removal: ${JSON.stringify(g.fresh)}`);
        assert.deepEqual([g.fresh.body.code, g.fresh.body.reason], ["LOCKED", "clearAway"]);
      });
    } finally { for (const id of open) killTerminal(id); }
  });
});
