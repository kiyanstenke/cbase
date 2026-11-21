// The agent harness itself: what it promises, measured on a real server — three providers in one server, the gate,
// the restart on the same database and the finally (the error of the body stays THE error, children and grandchildren
// are gone afterwards). The harness lives in `agent-harness.mjs`.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { endChildren, fakeClaude, fakeCodex, json, alive, withAgentsServer } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { RIPCORD_MS } from "./ripcord.mjs";

const response = (set) => `
  say({ type: "assistant", message: { id: "main-" + turn, content: [{ type: "text", text: ${JSON.stringify(set)} + " " + turn }] } });
  finished();
  say({ type: "result", result: "done", session_id: "main-session" });`;

const send = (base, chatId, text) =>
  json(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });

// A main agent that starts two subagents at two FOREIGN providers one after the other.
const twoProvider = fakeClaude({
  sub: `
    finished();
    say({ type: "result", result: "claude-sub", session_id: "sub-session" });`,
  main: `
  const reports = [];
  for (const [id, model] of [["toolu_codex", "codex::gpt-5.1-codex"], ["toolu_engine", "openrouter::m1"]]) {
    say({ type: "assistant", message: { id: "main-" + id, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_agent",
      input: { description: "Finding " + id, prompt: "Report the finding.", model, run_in_background: false } }] } });
    let r = "";
    try { r = textOf(await mcpCall("cbase_agent", { description: "Finding " + id, prompt: "Report the finding.", model, run_in_background: false })); }
    catch (e) { r = "FEHLER " + e.message; }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: r }] } });
    reports.push(r);
  }
  say({ type: "assistant", message: { id: "main-end", content: [{ type: "text",
    text: "Codex: " + (reports[0].includes("Codex-Befund 42") ? "yes" : "no") + " | Engine: " + (reports[1].includes("Engine-Befund 42") ? "yes" : "no") }] } });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`,
});

test("A Claude chat starts a Codex and an engine subagent in ONE server", async () => {
  await withAgentsServer(async ({ base, chat, engine, waitForLog }) => {
    await send(base, chat.id, "Fetch both findings");
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));

    assert.deepEqual(log.filter((m) => m.role === "assistant").map((m) => m.text), ["Codex: yes | Engine: yes"]);
    const result = (id) => {
      const row = log.filter((m) => m.role === "tool_result").map((m) => JSON.parse(m.text)).find((r) => r.id === id);
      assert.ok(row, `no result for ${id}: ${JSON.stringify(log.map((m) => m.role))}`);
      return JSON.parse(row.result);
    };
    const codex = result("toolu_codex");
    assert.equal(codex.status, "completed", codex.error || "");
    assert.equal(codex.provider, "codex");
    assert.match(codex.report, /Codex-Befund 42/);
    const narrow = result("toolu_engine");
    assert.equal(narrow.status, "completed", narrow.error || "");
    assert.equal(narrow.provider, "openrouter");
    assert.match(narrow.report, /Engine-Befund 42/);
    // The engine subagent really asked the wrong endpoint — with the chosen model.
    assert.ok(engine.requests.length >= 1, "the preset endpoint was never called");
    assert.equal(engine.requests[0].model, "m1");
  }, { claude: twoProvider, codex: fakeCodex(), engine: true });
});

test("A gate keeps a fake agent open until the test opens it — the run is busy for that long", async () => {
  const atGate = fakeClaude({ main: `  await gate("main");\n${response("After the gate")}` });
  await withAgentsServer(async ({ base, chat, gate, waitForLog }) => {
    await send(base, chat.id, "Wait at the gate");
    await gate.reached("main");
    const open = await json(`${base}/api/runs/active`);
    assert.equal(open.busy, true, `the run must stand open at the gate: ${JSON.stringify(open)}`);
    assert.equal(open.runs, 1);
    const prior = await json(`${base}/api/chats/${chat.id}/log`);
    assert.equal(prior.filter((m) => m.role === "assistant").length, 0, "before the opening there is no answer");

    gate.open("main");
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));
    assert.deepEqual(log.filter((m) => m.role === "assistant").map((m) => m.text), ["After the gate 1"]);
  }, { claude: atGate });
});

test("Restart on the same database: chat and history are there afterwards, and the chat keeps running", async () => {
  await withAgentsServer(async ({ base, chat, restart, waitForLog }) => {
    await send(base, chat.id, "Before the restart");
    await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));

    await restart();

    const chats = await json(`${base}/api/chats`);
    const list = Array.isArray(chats) ? chats : chats.chats || [];
    assert.ok(list.some((c) => c.id === chat.id), `the chat is missing after the restart: ${JSON.stringify(list.map((c) => c.id))}`);
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    assert.deepEqual(log.filter((m) => m.role === "user").map((m) => m.text), ["Before the restart"]);
    assert.deepEqual(log.filter((m) => m.role === "assistant").map((m) => m.text), ["Response 1"]);

    // The new server is reachable at the same address and runs runs.
    await send(base, chat.id, "After the restart");
    const afterwards = await waitForLog(chat.id, (l) => l.filter((m) => m.role === "meta").length === 2);
    assert.equal(afterwards.filter((m) => m.role === "assistant").length, 2);
  }, { claude: fakeClaude({ main: response("Response") }) });
});

// `alive` (gone = no longer there or a zombie) lives in the harness (agent-harness.mjs).

test("finally: the error of the body stays THE error, and children with grandchildren are gone afterwards", async () => {
  // The main agent calls cbase_agent (its MCP child hangs as a grandchild on the call), the subagent waits at the gate.
  // In addition the main agent starts a long runner in its own process group that does not read stdin —
  // like a tool process of a real CLI. Stopping the chat does NOT reach it (it ends only the CLI); only the harness
  // reaches it through its group. Otherwise it ends by itself only after the ripcord number.
  const longRunner = `setTimeout(() => process.exit(0), ${RIPCORD_MS}); setInterval(() => {}, 1000);`;
  const hangs = fakeClaude({
    sub: `    await gate("sub");\n    finished();\n    say({ type: "result", result: "never", session_id: "sub-session" });`,
    main: `
  const duration = spawn(process.execPath, ["-e", ${JSON.stringify(longRunner)}], { stdio: "ignore", detached: true });
  fs.writeFileSync(path.join(LOCATION, "pids", "g" + duration.pid), "long_runner");
  say({ type: "assistant", message: { id: "main-1", content: [{ type: "tool_use", id: "toolu_h", name: "mcp__cbase__cbase_agent",
    input: { description: "Hangs", prompt: "Wait.", run_in_background: false } }] } });
  await mcpCall("cbase_agent", { description: "Hangs", prompt: "Wait.", run_in_background: false });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`,
  });
  let pids = [];
  let groups = [];
  await assert.rejects(
    withAgentsServer(async ({ base, chat, root, gate }) => {
      await send(base, chat.id, "Start and hang");
      await gate.reached("sub");
      const entries = fs.readdirSync(path.join(root, "pids"));
      pids = entries.filter((e) => !e.startsWith("g")).map(Number);
      groups = entries.filter((e) => e.startsWith("g")).map((e) => Number(e.slice(1)));
      assert.ok(pids.length >= 2, `main and subagent must be running: ${entries}`);
      assert.ok(groups.length >= 2, `the MCP child and the long runner of the main agent must be running: ${entries}`);
      throw new Error("on purpose: the body fails with an open run");
    }, { claude: hangs }),
    /on purpose: the body fails/,
  );
  const leftOver = [...pids, ...groups].filter(alive);
  assert.deepEqual(leftOver, [], "after the finally no fake and no MCP grandchild is running any more");
});

// The fake CLI does what the real Claude CLI 2.1.280 does (measured without a model call, against a capture): a line
// that arrives on stdin AFTER the last tool boundary, during the LAST model request of the turn, is not lost and no
// longer belongs to this turn. The CLI ends the turn (first `result`, num_turns 2) and runs the line afterwards as its
// own turn (second `result`, num_turns 1) — whether stdin closes at the first `result` (how the core closes a subagent
// that was steered via cbase_agent_send) or stays open (the main agent that was fed a completion notice). Without a
// server: the fake alone, spoken to like by the connector.
// Counter-test: in agent-harness.mjs the stdin-end handler without `!running && !inlet.length` (immediate end) turns
// "stdin closes at the first result" red (one result instead of two).
for (const close of ["at the first result", "only after the second result"]) {
  test(`Fake CLI like 2.1.280: a line during the last model request becomes its own turn — stdin closes ${close}`, async () => {
    const script = fakeClaude({ main: `
  if (turn === 1) {
    say({ type: "system", subtype: "last_request" });
    // The last model request runs until the line is on stdin — without anTheLimit(): after it there is no boundary any more.
    await new Promise((r) => { const iv = setInterval(() => { if (inlet.length) { clearInterval(iv); r(); } }, 20); });
  }
  // If stdin closes at the first result, the second turn runs only AFTER the closing — exactly the measured case.
  if (turn === 2 && ${close === "at the first result"}) await new Promise((r) => { const iv = setInterval(() => { if (stdinTo) { clearInterval(iv); r(); } }, 20); });
  finished();
  say({ type: "result", result: "Turn " + turn + ": " + text, session_id: "main-session" });` });
    const location = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-fake-last-"));
    const file = path.join(location, "claude.cjs");
    fs.writeFileSync(file, script);
    const subprocess = spawn(process.execPath, [file, "-p", "--input-format", "stream-json", "--output-format", "stream-json"], { stdio: ["pipe", "pipe", "pipe"] });
    const row = (t) => subprocess.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: t }] } }) + "\n");
    try {
      const results = [];
      const end = new Promise((resolve) => subprocess.on("close", (code) => resolve(code)));
      let buf = "";
      subprocess.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const l = buf.slice(0, i); buf = buf.slice(i + 1);
          let e; try { e = JSON.parse(l); } catch { continue; }
          if (e.type === "system" && e.subtype === "last_request") row("Handed in later");
          if (e.type === "result") {
            results.push(e.result);
            if (close === "at the first result" ? results.length === 1 : results.length === 2) subprocess.stdin.end();
          }
        }
      });
      row("Go");
      const code = await end;
      assert.deepEqual(results, ["Turn 1: Go", "Turn 2: Handed in later"], "the line is its own turn after the first result");
      assert.equal(code, 0);
    } finally {
      try { subprocess.kill("SIGKILL"); } catch { /* already ended */ }
      fs.rmSync(location, { recursive: true, force: true });
    }
  });
}

// ── endChildren: cleanup WAITS until the children are gone ────────────────────────────────────────────────────────────
// `endChildren(root, { alive })` first collects all targets — registered pids, the MEMBERS of the registered groups (also an
// orphaned one that no longer descends from the test process) and the descendants —, ends them and returns only when `alive`
// says "gone" for each (no deadline). The seam reports "alive" twice for the registered long runner: the function must ask
// three times. Counter-test: agent-harness.mjs with `endChildren = endChildrenImmediately` (kill without waiting, the old state)
// turns it red (0 questions instead of 3).
test("endChildren also collects orphaned group members and returns only when every target is gone", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-gc6-"));
  fs.mkdirSync(path.join(root, "pids"));
  const duration = `setTimeout(() => process.exit(0), ${RIPCORD_MS}); setInterval(() => {}, 1000);`;
  const subprocess = spawn(process.execPath, ["-e", duration], { stdio: "ignore", detached: true });
  fs.writeFileSync(path.join(root, "pids", String(subprocess.pid)), "long_runner");
  // A group leader that starts a child in ITS group and then ends: the child is orphaned (no longer a descendant of the
  // test process) but a member of the registered group.
  const waiseFile = path.join(root, "waise.pid");
  const leader = spawn(process.execPath, ["-e", `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(duration)}], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(waiseFile)}, String(c.pid)); process.exit(0);`], { stdio: "ignore", detached: true });
  fs.writeFileSync(path.join(root, "pids", `g${leader.pid}`), "group");
  await new Promise((r) => leader.once("exit", r));
  const waise = Number(fs.readFileSync(waiseFile, "utf8"));
  try {
    assert.ok(alive(waise), "the orphan is alive before the cleanup");
    let questions = 0;
    const aliveSeam = (pid) => {
      if (pid !== subprocess.pid) return alive(pid);
      questions += 1;
      return questions <= 2;
    };
    const targets = await endChildren(root, { alive: aliveSeam });
    assert.equal(questions, 3, "endChildren returned without waiting until the long runner is gone");
    assert.ok(Array.isArray(targets) && targets.includes(subprocess.pid) && targets.includes(waise), `targets: ${JSON.stringify(targets)} (child ${subprocess.pid}, orphan ${waise})`);
    assert.equal(alive(waise), false, "the orphaned group is alive after the cleanup");
  } finally {
    for (const p of [subprocess.pid, waise]) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── restart({ instancesReady }) ───────────────────────────────────────────────────────────────────────────────────────
// With an operating marker startServer sets every converted instance to `start` before listening; the follow-up that would
// bring it to `ready` is switched off in the harness. `instancesReady` brings it to `ready` itself after the start.
// Counter-test: agent-harness.mjs without the block `if (instancesReady)` after startServer turns it red (the state stays `start`).
test("restart({ instancesReady: true }): a converted instance is ready after the restart, not start", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const projectId = `nb16x${Date.now().toString(36)}`;
      const filePath = path.join(ctx.root, "workspace", "project-nb16");
      fs.mkdirSync(filePath, { recursive: true });
      store.addProject(ctx.ws.id, { id: projectId, name: "NB-16", path: filePath, createdAt: Date.now() });
      store.createProjectInstance({ projectId, state: "ready", convertedAt: Date.now(), containerId: "c".repeat(64) });
      const markers = { CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_PROJECT_DESIRED_MS: "0" };
      const saved = Object.fromEntries(Object.keys(markers).map((k) => [k, process.env[k]]));
      try {
        Object.assign(process.env, markers);
        await ctx.restart({ instancesReady: true });
        assert.equal(store.projectInstance(projectId).state, "ready", "instancesReady had no effect — the row is at start");
      } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        // A row in `start` is open work (busy) — the finally of the harness would otherwise wait forever for quiet.
        if (store.projectInstance(projectId)?.state !== "ready") store.changeProjectInstance(projectId, "main", { state: "error" });
      }
    });
  } finally {
    fd.cleanUp();
  }
});
