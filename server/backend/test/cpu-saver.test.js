// "Save CPU": the switch, nice for background work and the wait before its Bash under full load.
//
// The promises, each with the way that breaks it (built-in sabotage: the same check against the wrong state must be red):
//   (1) OFF is identical to today: Claude arguments without `saver` = with `saver: false`, hook line without `--cpu-wait`/`timeout`,
//       no `--include-hook-events`; `withNice` returns the same array; the spawned Claude process, the engine Bash and the
//       monitor run at the server's priority. Sabotage: the check against the arguments WITH `saver` ⇒ red.
//   (2) ON: the subagent starts under nice +10 with a wait hook (deadline 150 s) and hook events, the main agent of the same
//       chat does not — on the wire of a real server run (fake CLI writes argv and priority). Sabotage: the subagent's
//       expectation against the main agent ⇒ red.
//   (3) The hook waits under simulated load, reports the marker, lets go after the cap (and says so) or at once when the
//       load falls; without load no waiting; a denied command never waits. Sabotage: the same hook WITHOUT `--cpu-wait`
//       under load ⇒ the wait check red.
//   (4) The main agent never waits: the engine Bash without `saver` starts at once under load, without a notice; with `saver`
//       it waits and reports start and end (the same event as the hook, read by `cpuWaitFrom`).
//   (5) The route: GET returns `{ enabled }` (false by default), PUT without `enabled` or with a non-boolean ⇒ 400, nothing set.
//       Sabotage: the check against a 200 response ⇒ red.
//   (6) agent-runtime sets `waitingForCpu` on the row from `hook_progress` with the marker and clears it on `hook_response`;
//       never without the marker. Also the clients: web and iOS expose the same switch through the same route with the same
//       sentence.
//
// COUNTER-TESTS: in connectors/claude.js `withNice(…, false)` turns (1)+(2) and (2)+(5) red; `bashGuardSettings()` there instead of
// with `cpuWait` turns (1), (2)+(5) red; removing `...saverField(saverOn())` in runs/agents.js turns (2)+(5) red; `saverField(true)` in
// runs/do-run.js (main agent saves) turns (2)+(5) red; an unconditional `process.exit(0)` in bash-guard.js turns (3) red; removing
// `if (!saver) return foreground();` in tool-runtime.js turns (4) red; removing the type check in runs/saver.js turns (2)+(5) red; an
// `if (false)` on the switch in agent-runtime.js turns (6) red; `withNice(…, false)` in monitor-runtime.js turns the monitor test red;
// the cap sentence in cpu-saver.js without "cap" turns (3), (4) red.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LOCATION, fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { CPU_WAIT_MARKER, HOOK_DEADLINE_S, NICE_LEVEL, cpuWaitFrom, cpuWaitEvent, withNice } from "../electron/mcp/cpu-saver.js";
import { bashGuardSettings, buildClaudeChatArgs, runChatClaude } from "../electron/server/providers/connectors/claude.js";
import { runBuiltinTool } from "../electron/server/providers/tool-runtime.js";
import { createMonitorRuntime } from "../electron/server/providers/monitor-runtime.js";
import { createAgentRuntime } from "../electron/server/providers/agent-runtime.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..", "..");
const WATCH = path.join(HERE, "..", "electron", "mcp", "bash-guard.js");
const BASE = os.getPriority(); // the priority of this process — the server runs with it
const EXPECTED_NICE = Math.min(19, BASE + NICE_LEVEL);
const PRIO = `node -e "console.log('PRIO=' + require('os').getPriority())"`;
const priorityFrom = (text) => Number(/PRIO=(-?\d+)/.exec(String(text))?.[1]);

const disposable = () => fs.mkdtempSync(path.join(os.tmpdir(), "cbase-rs-"));
function lastFile(dir, avg10) {
  const f = path.join(dir, "pressure-cpu");
  fs.writeFileSync(f, `some avg10=${avg10.toFixed(2)} avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`);
  return f;
}
async function withEnv(values, fn) {
  const prior = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ── (1) Off is today ──────────────────────────────────────────────────────────────────────────────────────────────
const SPEC = { systemPrompt: "x", mcpConfigPath: "/tmp/m.json", permissionMode: "bypassPermissions", settingSources: "user", input: "hello" };
const TODAY_HOOK = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `"${process.execPath}" "${WATCH}"` }] }] } });
function deviationOfToday(args) {
  const f = [];
  const i = args.indexOf("--settings");
  if (args[i + 1] !== TODAY_HOOK) f.push("hook line is not today's");
  if (args.includes("--include-hook-events")) f.push("--include-hook-events in the run");
  if (args.some((a) => String(a).includes("--cpu-wait"))) f.push("--cpu-wait in the run");
  if (args[0] === "nice") f.push("nice before the CLI");
  return f;
}

test("(1) off ⇒ identical to today: arguments, hook line, withNice — sabotage: the same check against the arguments with saver", () => {
  const today = buildClaudeChatArgs(SPEC);
  assert.deepEqual(deviationOfToday(today), []);
  assert.deepEqual(buildClaudeChatArgs({ ...SPEC, saver: false }), today, "saver:false is the same as no field");
  assert.equal(bashGuardSettings(), TODAY_HOOK);
  const arr = ["-c", "x"];
  assert.equal(withNice("sh", arr, false)[1], arr, "off: the same array, no rebuild");
  assert.equal(withNice("sh", arr, undefined)[1], arr);
  assert.deepEqual(withNice("sh", arr, "yes"), ["sh", arr], "only true saves");
  // Sabotage
  const isOn = buildClaudeChatArgs({ ...SPEC, saver: true });
  assert.deepEqual(deviationOfToday(isOn), ["hook line is not today's", "--include-hook-events in the run", "--cpu-wait in the run"]);
  const hook = JSON.parse(isOn[isOn.indexOf("--settings") + 1]).hooks.PreToolUse[0].hooks[0];
  assert.equal(hook.timeout, HOOK_DEADLINE_S);
  assert.ok(HOOK_DEADLINE_S * 1000 > 120_000, "the hook deadline is above the cap of the waiting");
});

// A fake Claude CLI that only stores argv and its priority and writes a result.
function fakeCli(dir) {
  const f = path.join(dir, "fake-claude");
  fs.writeFileSync(f, `#!/usr/bin/env node
const fs = require("node:fs"); const os = require("node:os");
fs.writeFileSync(${JSON.stringify(path.join(dir, "run.json"))}, JSON.stringify({ argv: process.argv.slice(2), prio: os.getPriority() }));
console.log(JSON.stringify({ type: "result", result: "ok", session_id: "s" }));
process.stdin.on("data", () => {}); process.stdin.on("end", () => process.exit(0));
`);
  fs.chmodSync(f, 0o755);
  return f;
}

test("(1)+(2) the spawned Claude process: without saver at the server's priority, with saver under nice +10 and wait hook", async () => {
  const dir = disposable();
  try {
    await withEnv({ CLAUDE_BIN: fakeCli(dir) }, async () => {
      for (const saver of [undefined, true]) {
        let kind = null;
        const res = await runChatClaude({ spec: { ...SPEC, cwd: dir, ...(saver ? { saver } : {}) }, onEvent: (e) => { if (e.type === "result") kind?.cbaseEndInput(); }, onSpawn: (c) => { kind = c; } });
        assert.equal(res.code, 0, res.stderr);
        const run = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
        assert.equal(run.prio, saver ? EXPECTED_NICE : BASE, `priority (saver=${saver})`);
        assert.deepEqual(run.argv, buildClaudeChatArgs({ ...SPEC, ...(saver ? { saver } : {}) }), "argv of the CLI = the built arguments (nice replaces itself)");
      }
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("(1) Monitor: without saver the server's priority, with saver nice +10 — asked at each start", async () => {
  const dir = disposable();
  let saver = false;
  const outputs = new Map();
  const end = new Map();
  const rt = createMonitorRuntime({
    cwd: dir, saver: () => saver,
    onOutput: (t, text) => outputs.set(t.taskId, (outputs.get(t.taskId) || "") + text),
    onDone: (t) => end.set(t.taskId, true),
  });
  try {
    const a = rt.start({ command: PRIO, report: "end", description: "a" });
    saver = true;
    const b = rt.start({ command: PRIO, report: "end", description: "b" });
    const idA = a.taskId || a.task?.taskId, idB = b.taskId || b.task?.taskId;
    await waitForTruthy(() => end.get(idA) && end.get(idB), "both monitors done");
    assert.equal(priorityFrom(outputs.get(idA)), BASE, "off: like the server");
    assert.equal(priorityFrom(outputs.get(idB)), EXPECTED_NICE, "on: nice +10");
  } finally { rt.close?.(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── (3) The hook ───────────────────────────────────────────────────────────────────────────────────────────────────
function hook(args, env, input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } }) {
  return new Promise((resolve) => {
    const subprocess = spawn(process.execPath, [WATCH, ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const start = Date.now();
    subprocess.stdout.on("data", (d) => { out += d; });
    subprocess.stderr.on("data", (d) => { err += d; });
    subprocess.on("close", (code) => resolve({ code, out, err, ms: Date.now() - start }));
    subprocess.stdin.end(JSON.stringify(input));
  });
}
const hasWaited = (r) => r.err.includes(CPU_WAIT_MARKER) && r.code === 0 && r.out === "";

test("(3) the hook waits under load and lets go after the cap; without load at once — sabotage: without --cpu-wait it does not wait", async () => {
  const dir = disposable();
  try {
    const full = lastFile(dir, 92);
    const env = { CBASE_CPU_LAST_FILE: full, CBASE_CPU_WAIT_MAX_MS: "400", CBASE_CPU_WAIT_TICK_MS: "40" };
    const r = await hook(["--cpu-wait"], env);
    assert.ok(hasWaited(r), JSON.stringify(r));
    assert.match(r.err, /cap of \d+ s reached — the command starts despite the load/, "the cap says that it is one");
    assert.ok(r.ms >= 400, `only after the cap (${r.ms} ms)`);
    // without load: at once, silent
    const quiet = await hook(["--cpu-wait"], { ...env, CBASE_CPU_LAST_FILE: lastFile(disposable(), 3) });
    assert.equal(quiet.err, "");
    assert.equal(quiet.out, "");
    // denied: deny, without waiting
    const no = await hook(["--cpu-wait"], env, { tool_name: "Bash", tool_input: { command: "nohup x &" } });
    assert.equal(JSON.parse(no.out).hookSpecificOutput.permissionDecision, "deny");
    assert.ok(!no.err.includes(CPU_WAIT_MARKER), "a denied command never waits");
    // Sabotage: the same hook without the argument under the same load
    const without = await hook([], env);
    assert.equal(hasWaited(without), false, "without --cpu-wait the wait check must not trigger");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("(3) the hook lets go as soon as the load falls (before the cap)", async () => {
  const dir = disposable();
  try {
    const file = lastFile(dir, 95);
    const subprocess = spawn(process.execPath, [WATCH, "--cpu-wait"], {
      env: { ...process.env, CBASE_CPU_LAST_FILE: file, CBASE_CPU_WAIT_MAX_MS: "600000", CBASE_CPU_WAIT_TICK_MS: "30" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let err = "";
    const finished = new Promise((r) => subprocess.on("close", r));
    const waiting = new Promise((r) => subprocess.stderr.on("data", (d) => { err += d; if (err.includes(CPU_WAIT_MARKER)) r(); }));
    subprocess.stdin.end(JSON.stringify({ tool_name: "Bash", tool_input: { command: "make" } }));
    await Promise.race([waiting, finished]); // if it ends without waiting, that is the finding below — no hanging
    assert.ok(err.includes(CPU_WAIT_MARKER), `the hook waits under load: ${err}`);
    lastFile(dir, 10); // the load falls
    assert.equal(await finished, 0);
    assert.match(err, /free after \d+ s/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── (4) The main agent never waits ──────────────────────────────────────────────────────────────────────────────────
test("(4) Engine Bash: without saver under load at once and at the server's priority; with saver it waits, reports and runs under nice", async () => {
  const dir = disposable();
  try {
    await withEnv({ CBASE_CPU_LAST_FILE: lastFile(dir, 99), CBASE_CPU_WAIT_MAX_MS: "200", CBASE_CPU_WAIT_TICK_MS: "20" }, async () => {
      const notices = [];
      const main = await runBuiltinTool("Bash", { command: PRIO }, { cwd: dir, onCpuWait: (m) => notices.push(m) });
      assert.equal(priorityFrom(main.content), BASE, main.content);
      assert.deepEqual(notices, [], "the main agent never waits and reports nothing");
      const rear = await runBuiltinTool("Bash", { command: PRIO }, { cwd: dir, saver: true, onCpuWait: (m) => notices.push(m) });
      assert.equal(priorityFrom(rear.content), EXPECTED_NICE, rear.content);
      assert.deepEqual(notices.map((m) => m.enabled), [true, false], "start and end reported");
      // the same event as the CLI's hook, read in the same place
      assert.equal(cpuWaitFrom(cpuWaitEvent(true, notices[0].text)), true);
      assert.equal(cpuWaitFrom(cpuWaitEvent(false, notices[1].text)), false);
      assert.match(notices[1].text, /cap/);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── (6) agent-runtime: the row carries the waiting ─────────────────────────────────────────────────────────────────
test("(6) agent-runtime: hook_progress with the marker sets waitingForCpu, hook_response clears it — never without the marker", async () => {
  let send = null;
  let end = null;
  const status = [];
  const rt = createAgentRuntime({
    chatId: "c-rs", cwd: process.cwd(), parentProvider: "claude",
    resolveRef: () => ({ connector: {}, providerId: "claude", model: "" }),
    buildSpec: (o) => ({ input: o.input }),
    runChat: ({ onEvent, onSpawn }) => new Promise((resolve) => {
      onSpawn({ kill: () => resolve({ code: 143 }) });
      send = onEvent;
      end = () => { onEvent({ type: "result", result: "finished", session_id: "s" }); resolve({ code: 0, sessionId: "s" }); };
      onEvent({ type: "system", subtype: "init", session_id: "s" });
    }),
    onStatus: (z) => status.push(Boolean(z.waitingForCpu)),
  });
  try {
    const a = await rt.start({ prompt: "build", description: "Builder", run_in_background: true });
    await waitForTruthy(() => send, "process started");
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "make" } }] } });
    send({ type: "system", subtype: "hook_progress", hook_event: "PreToolUse", stderr: "something else" });
    assert.equal(rt.get(a.agentId).waitingForCpu, undefined, "without the marker: no waiting");
    send({ type: "system", subtype: "hook_progress", hook_event: "PreToolUse", hook_name: "PreToolUse:Bash", stderr: `${CPU_WAIT_MARKER} …` });
    assert.equal(rt.get(a.agentId).waitingForCpu, true);
    send({ type: "system", subtype: "hook_response", hook_event: "PreToolUse", stderr: `${CPU_WAIT_MARKER} …\nfrei` });
    assert.equal(rt.get(a.agentId).waitingForCpu, undefined, "after the end the field is gone again");
    assert.deepEqual(status.slice(-2), [true, false], "every change reported");
    end();
  } finally { rt.close(); }
});

// ── (2)+(5) On the wire of a server run: route, main agent and subagent ───────────────────────────────────────────
// The main agent stores its priority and arguments and starts ONE subagent; the subagent stores its own.
const MAIN = `
    if (!text.startsWith("<task-notification>")) {
      fs.writeFileSync(path.join(LOCATION, "main-" + text.trim() + ".json"), JSON.stringify({ argv, prio: require("node:os").getPriority() }));
      const input = { description: "Builder " + text.trim(), prompt: "RUNDE:" + text.trim(), run_in_background: true };
      say({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "toolu_a", name: "mcp__cbase__cbase_agent", input }] } });
      let t = ""; try { t = textOf(await mcpCall("cbase_agent", input)); } catch (e) { t = "ERROR " + e.message; }
      say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_a", content: t }] } });
    }
    finished();
    say({ type: "result", result: "ok", session_id: "main-session" });`;
const SUB = `
    const round = text.split("RUNDE:")[1].split(/\\s/)[0];
    fs.writeFileSync(path.join(LOCATION, "sub-" + round + ".json"), JSON.stringify({ argv, prio: require("node:os").getPriority() }));
    finished();
    say({ type: "result", result: "finished", session_id: "sub-" + round });`;

function finding({ argv, prio }) {
  const s = JSON.parse(argv[argv.indexOf("--settings") + 1]).hooks.PreToolUse[0].hooks[0];
  return { prio, waitHook: s.command.endsWith("--cpu-wait") && s.timeout === HOOK_DEADLINE_S, hookEvents: argv.includes("--include-hook-events") };
}
const SPARES = { prio: EXPECTED_NICE, waitHook: true, hookEvents: true };
const NORMAL = { prio: BASE, waitHook: false, hookEvents: false };

test("(2)+(5) The route requires its field; off ⇒ main agent and subagent normal; on ⇒ only the subagent under nice including wait hook", async () => {
  await withAgentsServer(async ({ base, chat, root, waitForIdle }) => {
    const route = async (method, body) => {
      const r = await fetch(`${base}/api/cpu-saver`, { method, headers: { "Content-Type": "application/json", Connection: "close" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: r.status, body: await r.json() };
    };
    const rejected = (r) => r.status === 400 && typeof r.body.error === "string";
    assert.deepEqual(await route("GET"), { status: 200, body: { enabled: false } }, "off by default");
    for (const b of [{}, { enabled: null }, { enabled: "yes" }, { enabled: 1 }, { enabled: "true" }]) assert.ok(rejected(await route("PUT", b)), JSON.stringify(b));
    assert.equal((await route("GET")).body.enabled, false, "none of these set anything");
    assert.equal(rejected({ status: 200, body: { enabled: true } }), false, "sabotage: a 200 is not a rejection");

    const round = async (word) => {
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: word }) });
      await waitForTruthy(() => fs.existsSync(path.join(root, `sub-${word}.json`)), `subagent ${word}`);
      await waitForIdle();
      const read = (n) => finding(JSON.parse(fs.readFileSync(path.join(root, `${n}-${word}.json`), "utf8")));
      return { main: read("main"), sub: read("sub") };
    };
    const output = await round("off");
    assert.deepEqual(output, { main: NORMAL, sub: NORMAL }, "off: both like today");

    assert.deepEqual(await route("PUT", { enabled: true }), { status: 200, body: { enabled: true } });
    assert.equal((await route("GET")).body.enabled, true);
    const turnedOn = await round("on");
    assert.deepEqual(turnedOn.main, NORMAL, "the main agent never saves");
    assert.deepEqual(turnedOn.sub, SPARES, "the subagent saves — without a restart");
    assert.notDeepEqual(turnedOn.main, SPARES, "sabotage: the subagent's expectation does not fit the main agent");
  }, { claude: fakeClaude({ main: MAIN, sub: SUB }) });
});

// ── The clients: the same switch in web and iOS ─────────────────────────────────────────────────────────────────
test("(6) Web and iOS: the same route, the same sentence, on the \"Workflows\" page; the addition \"waiting for CPU\" on the agent card", () => {
  const read = (...p) => fs.readFileSync(path.join(REPO, ...p), "utf8");
  const web = read("web", "src", "components", "settings", "WorkflowsSettings.tsx");
  const ios = read("mobile", "CbaseMobile", "Settings", "SaverSection.swift");
  const iosPage = read("mobile", "CbaseMobile", "Settings", "WorkflowsSettings.swift");
  const set = (t, re) => re.exec(t)?.[1];
  const webSet = set(web, /hint=\{t\("(Commands of subagents[^"]+)"\)\}/);
  const iosSet = set(ios, /hint: L\("(Commands of subagents[^"]+)"\)/);
  assert.ok(webSet, "anchor: the sentence in web");
  assert.equal(iosSet, webSet, "the same sentence in web and iOS");
  for (const [n, t] of [["Web", web], ["iOS", ios]]) assert.ok(t.includes('"/api/cpu-saver"'), `${n}: the route`);
  assert.match(web, /<SaverGroup \/>/);
  assert.match(iosPage, /SaverSection\(\)/);
  for (const t of [read("web", "src", "lib", "i18n-de.ts"), read("mobile", "CbaseMobile", "Kit", "LocDEBase.swift")]) {
    assert.ok(t.includes(`"${webSet}"`), "translation of the sentence");
    assert.ok(t.includes('"waiting for CPU"'), "translation of the card line");
  }
  assert.match(read("web", "src", "components", "AgentBar.tsx"), /agent\.waitingForCpu \? t\("waiting for CPU"\)/);
  assert.match(read("mobile", "CbaseMobile", "Chat", "ChatDetailSheet.swift"), /if entry\.waitingForCpu \{ return L\("waiting for CPU"\) \}/);
});
