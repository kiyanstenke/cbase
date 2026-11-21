// The NATIVE subagent tool (cbase_agent): any model may start any other as a subagent. What is tested is the core
// (providers/agent-runtime.js) with a fake provider dispatch: no real CLIs run here, but exactly the contract that
// runs/do-run.js uses: build the spec, mirror events, report result/consumption.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as limits from "../electron/server/limits.js";
import {
  FOREGROUND_DEFAULT_MS, createAgentRuntime, toolList, foregroundDeadline, foregroundDeadlinesNow,
} from "../electron/server/providers/agent-runtime.js";
import { runOnceClaude } from "../electron/server/providers/connectors/claude.js";
import { ev } from "../electron/server/providers/contract.js";

// Provider table of the test: "prov::model" -> connector. resolveRef mimics what providers/index.js does
// (the prefix wins, an unknown prefix is reported, without a prefix it inherits).
const PROVS = {
  "claude": { native: true, models: ["claude-opus-5"] },
  "codex": { native: true, models: ["gpt-5.1-codex"] },
  "third": { native: false, models: ["mini", "pro"] },
};
function resolveRef(ref, fallback) {
  const raw = String(ref || "").trim();
  const i = raw.indexOf("::");
  const provider = i < 0 ? "" : raw.slice(0, i);
  const model = i < 0 ? raw : raw.slice(i + 2);
  if (provider && !PROVS[provider]) return { providerId: fallback, connector: {}, model: raw, unknownProvider: true };
  const id = provider || fallback;
  return { providerId: id, connector: { id }, model: provider ? model : raw, unknownProvider: false };
}

const hosts = () => Object.entries(PROVS).map(([id, p]) => ({ id, label: id, models: p.models.map((m) => ({ id: m, label: m })) }));

// A run of the fake dispatcher: writes text, calls a tool, reports result. The options let a test change the flow
// (e.g. wait at the gate or fail).
function fakeRunChat(calls, { fail = false, metered = true, report = "REPORT", gate = null } = {}) {
  return async ({ providerId, spec, onEvent, onSpawn }) => {
    calls.push({ providerId, spec });
    let ended = false;
    onSpawn?.({ kill: () => { ended = true; }, cbaseEndInput: () => { ended = true; } });
    if (fail) throw new Error("provider broken");
    if (gate) await gate(); // a gate instead of a duration: the test releases the subagent
    onEvent({ type: "system", subtype: "init", session_id: "inner" });               // gets filtered
    // message.id is part of it: the consumption counter deduplicates over it (see usage-tally.js) and
    // discards an input side without an id; every real CLI sends it.
    onEvent({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "thinking" }], usage: { input_tokens: 7, output_tokens: 3 } } });
    onEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } }] } });
    onEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file content" }] } });
    onEvent({ type: "result", result: report, session_id: "sess-1" });
    assert.equal(ended, true, "the core must close the subagent's input");
    return {
      code: 0, sessionId: "sess-1", resultText: report, stderr: "",
      ...(metered ? { usage: { input: 10, output: 4, cached: 1 } } : {}),
    };
  };
}

// The skill catalog of the commissioning chat, as runs/do-run.js gives it to the core: names -> body,
// unknown ones are reported, not swallowed.
const CATALOG = [
  { name: "checklist", description: "Checks step by step.", body: "1. Read.\n2. Check.\n3. Report." },
  { name: "style", description: "House style.", body: "Short sentences, no emojis." },
];
function resolveSkills(names) {
  const skills = [], missing = [];
  for (const n of names) { const s = CATALOG.find((k) => k.name === n); if (s) skills.push(s); else missing.push(n); }
  return { skills, missing, available: CATALOG.map((k) => k.name) };
}

function makeRuntime({ calls, events, finished = [], started = [], cwd, run, defs = [], parentProvider = "claude", skills = resolveSkills, onSwitch }) {
  return createAgentRuntime({
    chatId: "chat-1",
    cwd,
    parentProvider,
    agentDefs: () => defs,
    hosts,
    resolveRef,
    resolveSkills: skills,
    buildSpec: (o) => ({ ...o, marker: "spec" }),
    runChat: run || fakeRunChat(calls),
    onEvent: (evt) => events.push(evt),
    onStart: (rec) => started.push(rec),
    onFinish: (rec, info) => finished.push({ rec, info }),
    ...(onSwitch ? { onSwitch } : {}),
    worktreeRoot: path.join(cwd, ".wt"),
    forkTranscript: () => [{ role: "user", content: "earlier history" }],
  });
}

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `cbase-agent-${name}-`));
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

test("A Claude chat starts a subagent at ANOTHER provider", async () => {
  const cwd = tmp("cross");
  try {
    const calls = []; const events = []; const finished = [];
    const rt = makeRuntime({ calls, events, finished, cwd });
    const res = await rt.start({ run_in_background: false, description: "Have it checked", prompt: "Take a look", model: "third::pro" });

    assert.equal(res.status, "completed");
    assert.equal(res.report, "REPORT");
    assert.equal(res.provider, "third");
    assert.equal(res.resolvedModel, "pro");
    assert.equal(res.totalToolUseCount, 1);
    assert.ok(res.agentId, "the report must carry the agentId for follow-ups");
    assert.match(res.note, /cbase_agent_send/);

    // The run went to the FOREIGN provider, with its model, and as a subagent.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].providerId, "third");
    assert.equal(calls[0].spec.model, "pro");
    assert.equal(calls[0].spec.input, "Take a look");
    assert.match(calls[0].spec.systemPrompt, /SUBAGENT of cbase/);

    // All mirrored events carry the parent id (otherwise the parent run would count them as its
    // own context and persist the subagent's text as its answer) ...
    assert.ok(events.length >= 3);
    assert.ok(events.every((e) => typeof e.parent_tool_use_id === "string" && e.parent_tool_use_id));
    // ... and neither result nor system/init nor token events get through.
    assert.equal(events.some((e) => e.type === "result" || e.type === "system"), false);
    const withUsage = events.find((e) => e.type === "assistant" && e.message?.usage);
    assert.equal(withUsage, undefined, "tokens are reported ONCE, not through the stream");

    // Consumption goes to the server separately (provider + billing kind of the SUBAGENT). The totals of a metered agent carry the
    // reported cost (`cost`, null = not reported) and the provider behind the router (`upstream`), and next to the sum (`usage`)
    // goes the increase since the last booking (`increase`: THAT is what the server books).
    assert.equal(finished.length, 1);
    const state = { input: 10, output: 4, cached: 1, cost: null, upstream: "" };
    assert.deepEqual(
      { p: finished[0].info.provider, m: finished[0].info.model, b: finished[0].info.billing, u: finished[0].info.usage, z: finished[0].info.increase },
      { p: "third", m: "pro", b: "metered", u: state, z: state },
    );
    assert.equal(finished[0].info.delivered, true, "a waiting call already has the report");
  } finally { rm(cwd); }
});

test("Subscription provider as a subagent: consumption comes from the event stream", async () => {
  const cwd = tmp("native");
  try {
    const calls = []; const events = []; const finished = [];
    const rt = makeRuntime({ calls, events, finished, cwd, run: fakeRunChat(calls, { metered: false }) });
    await rt.start({ run_in_background: false, prompt: "do it", model: "codex::gpt-5.1-codex" });
    assert.equal(finished[0].info.billing, "subscription");
    // Counted from the assistant event (7 input / 3 output), not from res.usage.
    assert.deepEqual(finished[0].info.usage, { input: 7, output: 3, cached: 0, cacheRead: 0, cacheWrite: 0 });
  } finally { rm(cwd); }
});

test("Background subagent returns at once; its report is delivered later", async () => {
  const cwd = tmp("bg");
  try {
    const calls = []; const events = []; const finished = [];
    // A gate instead of 40 ms: the subagent only continues once the test has seen that the start returned at once.
    const t = gates();
    const rt = makeRuntime({ calls, events, finished, cwd, run: fakeRunChat(calls, { gate: t.gate }) });
    const res = await rt.start({ prompt: "long task", run_in_background: true, model: "third::mini" });
    assert.equal(res.status, "running");
    assert.equal(res.background, true);
    assert.match(res.note, /by itself as a system message/);
    assert.equal(finished.length, 0);
    t.open();

    const done = await rt.output({ agentId: res.agentId }); // ask blocking
    assert.equal(done.status, "completed");
    assert.equal(done.report, "REPORT");
    assert.equal(finished.length, 1);
    // The waiting output() call picked it up, so no second delivery as a new turn.
    assert.equal(finished[0].info.delivered, true);
  } finally { rm(cwd); }
});

// A gate for the fake dispatcher: every run waits until the test releases it (order of the runs).
function gates() {
  const open = [];
  let free = 0;
  return {
    gate: () => new Promise((r) => { if (free > 0) { free -= 1; r(); } else open.push(r); }),
    open: () => { const r = open.shift(); if (r) r(); else free += 1; },
  };
}
// Wait for an event, not for a time (one round of the event loop per look).
async function until(check) { while (!check()) await new Promise((r) => setImmediate(r)); }

// Foreground deadline: at most 240 s, below the ~300 s abort of a waiting MCP request. Counted instead of waited: the seam
// `foregroundDeadlinesNow()` lets every open deadline expire NOW.
// Counter-tests: the switch without `rec.background = true` => "ordinary background agent" red; `inForeground` replaced by the
// old waiting without a deadline => the seam finds no deadline, red.
test("Foreground deadline: the default is below the MCP edge, the knob is product configuration", (t) => {
  const prior = process.env.CBASE_AGENT_FOREGROUND_MS;
  try {
    delete process.env.CBASE_AGENT_FOREGROUND_MS;
    t.diagnostic(`measurement line: foreground deadline without the knob = ${foregroundDeadline()} ms (abort of a waiting MCP request ≈ 300000 ms)`);
    assert.equal(foregroundDeadline(), FOREGROUND_DEFAULT_MS);
    assert.equal(FOREGROUND_DEFAULT_MS, 240_000, "the default of the spec");
    for (const raw of ["", "0", "-5", "abc"]) {
      process.env.CBASE_AGENT_FOREGROUND_MS = raw;
      assert.equal(foregroundDeadline(), FOREGROUND_DEFAULT_MS, `knob "${raw}"`);
    }
    process.env.CBASE_AGENT_FOREGROUND_MS = "1500";
    assert.equal(foregroundDeadline(), 1500);
  } finally {
    if (prior === undefined) delete process.env.CBASE_AGENT_FOREGROUND_MS;
    else process.env.CBASE_AGENT_FOREGROUND_MS = prior;
  }
});

test("If the foreground agent runs past the deadline it switches to the background: \"continues in the background\", the end goes to the owner", async () => {
  const cwd = tmp("wait");
  try {
    const calls = []; const events = []; const finished = []; const changeover = [];
    const t = gates();
    const rt = makeRuntime({ calls, events, finished, cwd, run: fakeRunChat(calls, { gate: t.gate }), onSwitch: (a) => changeover.push(a) });
    // `wait_ms` of an existing call no longer has an effect, and is not rejected.
    const run = rt.start({ run_in_background: false, prompt: "lasts", model: "third::mini", wait_ms: 1 });
    assert.equal(foregroundDeadlinesNow(), 1, "exactly one open foreground deadline");
    const res = await run;
    assert.equal(res.status, "running");
    assert.equal(res.background, true);
    assert.equal(res.intoTheBackground, "deadline");
    assert.match(res.note, new RegExp(`^Continues in the background \\(agentId "${res.agentId}"\\)`));
    assert.match(res.note, /<task-notification>/);
    assert.equal(rt.get(res.agentId).background, true, "from now on an ordinary background agent");
    assert.deepEqual(changeover.map((a) => a.agentId), [res.agentId], "the owner learns of the switch");
    assert.equal(foregroundDeadlinesNow(), 0, "the deadline is used up");

    t.open();
    await until(() => finished.length === 1);
    // Nobody was waiting any more, so the owner delivers the report as a completion message.
    assert.equal(finished[0].info.delivered, false);
    assert.equal(finished[0].info.report.report, "REPORT");
    assert.equal((await rt.output({ agentId: res.agentId, block: false })).status, "completed");
  } finally { rm(cwd); }
});

test("The deadline also expires by itself (knob): the call returns before the agent is done", async () => {
  const cwd = tmp("deadline");
  const prior = process.env.CBASE_AGENT_FOREGROUND_MS;
  try {
    process.env.CBASE_AGENT_FOREGROUND_MS = "1";
    const calls = []; const events = []; const finished = [];
    const t = gates();
    const rt = makeRuntime({ calls, events, finished, cwd, run: fakeRunChat(calls, { gate: t.gate }) });
    // The deadline clock does not keep the process awake (unref, as in the server, where the waiting request holds it); here a
    // handle without effect holds it until the call is back. No time limit: it never comes due.
    const awake = setInterval(() => {}, 1 << 30);
    const res = await rt.start({ run_in_background: false, prompt: "lasts", model: "third::mini" }).finally(() => clearInterval(awake));
    assert.equal(res.intoTheBackground, "deadline");
    assert.equal(finished.length, 0, "the agent is still at its gate");
    t.open();
    await until(() => finished.length === 1);
    assert.equal(finished[0].info.delivered, false);
  } finally {
    if (prior === undefined) delete process.env.CBASE_AGENT_FOREGROUND_MS;
    else process.env.CBASE_AGENT_FOREGROUND_MS = prior;
    rm(cwd);
  }
});

test("The \"Into the background\" button in the core: at once, the waiting call returns; twice is no error, unknown is", async () => {
  const cwd = tmp("button");
  try {
    const calls = []; const events = []; const finished = [];
    const t = gates();
    const rt = makeRuntime({ calls, events, finished, cwd, run: fakeRunChat(calls, { gate: t.gate }) });
    const run = rt.start({ run_in_background: false, prompt: "lasts", model: "third::mini" });
    await until(() => calls.length === 1);
    const id = rt.list()[0].agentId;
    assert.equal(rt.get(id).background, false, "before the button a foreground agent");
    assert.deepEqual(rt.intoTheBackground(id), { ok: true, agentId: id, background: true });
    const res = await run;
    assert.equal(res.intoTheBackground, "human");
    assert.match(res.note, /the human has sent the subagent to the background/);
    assert.equal(foregroundDeadlinesNow(), 0, "with the button the deadline is gone");
    assert.equal(rt.intoTheBackground(id).already, true, "already in the background: the requested state, no error");
    assert.deepEqual(rt.intoTheBackground("exists-not"), { ok: false, reason: "unknown" });
    t.open();
    await until(() => finished.length === 1);
    assert.equal(rt.intoTheBackground(id).ok, false, "a finished agent no longer switches");
  } finally { rm(cwd); }
});

// The continuation of a finished agent ALWAYS runs in the background, as in Claude Code, even if it ran in the foreground and
// also with `run_in_background: false` (no longer has an effect). Counter-test: `rec.background = args.run_in_background === true`
// with `inForeground` back => red (the call waits, a deadline stands).
test("cbase_agent_send to a finished foreground agent returns at once; the answer comes under the same id", async () => {
  const cwd = tmp("send");
  try {
    const calls = []; const events = []; const finished = [];
    const t = gates();
    const rt = makeRuntime({ calls, events, finished, cwd, run: fakeRunChat(calls, { gate: t.gate }) });
    t.open(); // the first run reports at once
    const first = await rt.start({ run_in_background: false, prompt: "short", model: "third::mini" });
    assert.equal(first.status, "completed");
    const run = rt.send({ agentId: first.agentId, message: "further", run_in_background: false, wait_ms: 600000 });
    // Counted BEFORE waiting: if send waited (old rule), its deadline would stand here: red instead of a hang.
    await new Promise((r) => setImmediate(r));
    assert.equal(foregroundDeadlinesNow(), 0, "no foreground deadline: the call does not wait");
    const res = await run;
    assert.deepEqual([res.status, res.resumed, res.background, res.agentId], ["running", true, true, first.agentId]);
    assert.match(res.note, /under the same agentId/);
    assert.equal(rt.get(first.agentId).background, true);
    t.open();
    await until(() => finished.length === 2);
    assert.equal(finished[1].rec.agentId, first.agentId);
    assert.equal(finished[1].info.delivered, false, "nobody was waiting; the owner delivers it as a completion message");
  } finally { rm(cwd); }
});

test("Agent types: role, tools and model of the definition; the argument wins", async () => {
  const cwd = tmp("types");
  try {
    const calls = []; const events = [];
    const defs = [{ name: "checker", description: "Checks", body: "You check.", tools: "Read, Grep", model: "third::mini", originProject: "Alpha", originProjectPath: "/p/alpha" }];
    const rt = makeRuntime({ calls, events, cwd, defs });

    await rt.start({ run_in_background: false, prompt: "look", subagent_type: "checker" });
    assert.equal(calls[0].providerId, "third");
    assert.equal(calls[0].spec.model, "mini");
    assert.deepEqual(calls[0].spec.tools, ["Read", "Grep"]);
    assert.match(calls[0].spec.systemPrompt, /You check\./);
    assert.match(calls[0].spec.systemPrompt, /project "Alpha"/);

    // An explicit model and tools in the call override the definition.
    await rt.start({ run_in_background: false, prompt: "again", subagent_type: "checker", model: "third::pro", tools: ["Glob"] });
    assert.equal(calls[1].spec.model, "pro");
    assert.deepEqual(calls[1].spec.tools, ["Glob"]);

    // Without a value the subagent inherits provider AND model of the chat.
    await rt.start({ run_in_background: false, prompt: "inherit" });
    assert.equal(calls[2].providerId, "claude");
    assert.equal(calls[2].spec.model, "");

    // The selection can be queried (this feeds tool description, prompt and cbase_agents_list).
    const names = rt.types().map((t) => t.name);
    assert.deepEqual(names, ["general-purpose", "fork", "checker"]);
  } finally { rm(cwd); }
});

test("Skills: definition + call are loaded IN FULL into the system prompt; an unknown name is an error", async () => {
  const cwd = tmp("skills");
  try {
    const calls = []; const events = [];
    const defs = [{ name: "checker", description: "Checks", body: "You check.", skills: "checklist" }];
    const rt = makeRuntime({ calls, events, cwd, defs });

    // Definition alone: the body is in the system prompt, AFTER the role and BEFORE the frame.
    const r1 = await rt.start({ run_in_background: false, prompt: "check", subagent_type: "checker" });
    const sys1 = calls[0].spec.systemPrompt;
    assert.match(sys1, /# Loaded skills/);
    assert.match(sys1, /## Skill: checklist — Checks step by step\./);
    assert.match(sys1, /3\. Report\./, "the whole body, not only the catalog line");
    assert.ok(sys1.indexOf("You check.") < sys1.indexOf("# Loaded skills"), "role before skills");
    assert.ok(sys1.indexOf("# Loaded skills") < sys1.indexOf("SUBAGENT of cbase"), "skills before the frame");
    // The spec knows the loaded skills (runs/do-run.js removes them from the catalog), the report names them.
    assert.deepEqual(calls[0].spec.skills.map((s) => s.name), ["checklist"]);
    assert.deepEqual(r1.skills, ["checklist"]);

    // The call supplements the definition (adds, does not replace, unlike tools), without a duplicate.
    await rt.start({ run_in_background: false, prompt: "check in house style", subagent_type: "checker", skills: ["style", "checklist"] });
    assert.deepEqual(calls[1].spec.skills.map((s) => s.name), ["checklist", "style"]);
    assert.match(calls[1].spec.systemPrompt, /Short sentences, no emojis\./);

    // Also without an agent type: skills on the call suffice; a comma list works like an array.
    await rt.start({ run_in_background: false, prompt: "style only", skills: "style" });
    assert.deepEqual(calls[2].spec.skills.map((s) => s.name), ["style"]);

    // Without skills: no block; the catalog stays the server's business.
    await rt.start({ run_in_background: false, prompt: "bare" });
    assert.ok(!calls[3].spec.systemPrompt.includes("Loaded skills"));
    assert.deepEqual(calls[3].spec.skills, []);

    // Counter-test: a name the catalog does not know is an instructive error: no subagent without the
    // instructions the caller believes it is equipped with.
    await assert.rejects(rt.start({ run_in_background: false, prompt: "x", skills: ["nonexistent"] }), /Skill "nonexistent" not found\. Available in this chat: checklist, style\./);
    assert.equal(calls.length, 4, "no run started");
    // Also from the definition: a deleted skill breaks the start, not silently the role.
    const rt2 = makeRuntime({ calls, events, cwd, defs: [{ name: "old", description: "", body: "", skills: "way" }] });
    await assert.rejects(rt2.start({ run_in_background: false, prompt: "x", subagent_type: "old" }), /Skill "way" not found/);
    // And without a resolver (run without a catalog) a request is an error too, not silence.
    const rt3 = makeRuntime({ calls, events, cwd, skills: null });
    await assert.rejects(rt3.start({ run_in_background: false, prompt: "x", skills: ["style"] }), /not available/);
    await rt3.start({ run_in_background: false, prompt: "without" }); // without a request it runs
    // The type list names the skills of the definition (for prompt and cbase_agents_list).
    assert.deepEqual(rt.types().find((t) => t.name === "checker").skills, ["checklist"]);
  } finally { rm(cwd); }
});

test("fork inherits the chat history, general-purpose does not", async () => {
  const cwd = tmp("fork");
  try {
    const calls = []; const events = [];
    const rt = makeRuntime({ calls, events, cwd });
    await rt.start({ run_in_background: false, prompt: "with context", subagent_type: "fork", model: "third::mini" });
    assert.equal(calls[0].spec.inheritContext, true);
    assert.deepEqual(calls[0].spec.transcript, [{ role: "user", content: "earlier history" }]);

    await rt.start({ run_in_background: false, prompt: "without context", model: "third::mini" });
    assert.equal(calls[1].spec.inheritContext, false);
    assert.deepEqual(calls[1].spec.transcript, []);
  } finally { rm(cwd); }
});

test("cbase_agent_send continues the same subagent with its context", async () => {
  const cwd = tmp("send");
  try {
    const calls = []; const events = [];
    const rt = makeRuntime({ calls, events, cwd });
    const first = await rt.start({ run_in_background: false, prompt: "first task", model: "third::mini" });
    const again = await rt.send({ agentId: first.agentId, message: "and now X as well" });

    assert.equal(again.agentId, first.agentId, "the same agentId: it is the same agent");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].spec.sessionId, "sess-1", "keep using the resume id of the first turn");
    assert.equal(calls[1].spec.input, "and now X as well");
    // For providers without a real --resume the transcript carries the history: task, answer,
    // tool call AND tool result (otherwise the agent would no longer know what it read).
    const flat = JSON.stringify(calls[1].spec.transcript);
    assert.match(flat, /first task/);
    assert.match(flat, /thinking/);
    assert.match(flat, /file content/);
  } finally { rm(cwd); }
});

test("A wrong choice ends as an instructive error, not as a crash", async () => {
  const cwd = tmp("bad");
  try {
    const calls = []; const events = [];
    const rt = makeRuntime({ calls, events, cwd, defs: [{ name: "checker", description: "Checks", body: "" }] });

    await assert.rejects(() => rt.start({ run_in_background: false, prompt: "x", subagent_type: "nonexistent" }), /Selectable: general-purpose, fork, checker/);
    await assert.rejects(() => rt.start({ run_in_background: false, prompt: "x", model: "nonexistent::y" }), /Unknown provider/);
    await assert.rejects(() => rt.start({ run_in_background: false, prompt: "" }), /prompt is missing/);
    // isolation:"remote" does not exist in cbase: that must be said, instead of silently taking effect.
    await assert.rejects(() => rt.start({ run_in_background: false, prompt: "x", isolation: "remote" }), /does not exist in cbase/);
    assert.equal(calls.length, 0);

    // A failing provider becomes an error report, the core lives on.
    const rt2 = makeRuntime({ calls, events, cwd, run: fakeRunChat(calls, { fail: true }) });
    const res = await rt2.start({ run_in_background: false, prompt: "x", model: "third::mini" });
    assert.equal(res.status, "failed");
    assert.match(res.error, /provider broken/);
  } finally { rm(cwd); }
});

test("Abort and end of run terminate every subagent", async () => {
  const cwd = tmp("stop");
  try {
    const calls = []; const events = []; const finished = [];
    let killed = 0;
    // Ends only with the kill, instead of "500 ms, never ends in time": under load the clock ran out before stopping.
    const run = async ({ onSpawn }) => {
      let free;
      const end = new Promise((r) => { free = r; });
      onSpawn?.({ kill: () => { killed += 1; free(); }, cbaseEndInput: () => {} });
      await end;
      return { code: 0, sessionId: "", resultText: "late", stderr: "" };
    };
    const rt = makeRuntime({ calls, events, finished, cwd, run });
    const a = await rt.start({ prompt: "runs long", run_in_background: true, model: "third::mini" });
    assert.equal(rt.stop(a.agentId), true);
    assert.equal(killed, 1);
    assert.equal(rt.get(a.agentId).status, "stopped");

    const b = await rt.start({ prompt: "runs long too", run_in_background: true, model: "third::mini" });
    rt.close();
    assert.equal(rt.get(b.agentId).status, "stopped");
    assert.equal(killed, 2);
    // After the end of the run the core accepts nothing any more.
    await assert.rejects(() => rt.start({ run_in_background: false, prompt: "too late" }), /run has ended/);
  } finally { rm(cwd); }
});

test("isolation:'worktree' gives the subagent a checkout of its own", async () => {
  const cwd = tmp("wt");
  try {
    const { spawnSync } = await import("node:child_process");
    const git = (args, dir = cwd) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(cwd, "a.txt"), "one\n");
    git(["add", "-A"]); git(["commit", "-qm", "start"]);

    const calls = []; const events = [];
    const rt = makeRuntime({ calls, events, cwd });
    const res = await rt.start({ run_in_background: false, prompt: "change something", model: "third::mini", isolation: "worktree" });
    const usedCwd = calls[0].spec.cwd;
    assert.notEqual(usedCwd, cwd, "the subagent does NOT work in the chat's directory");
    assert.match(usedCwd, /agent-/);
    // An unchanged worktree is removed again after the run (no leftovers in the repo).
    assert.equal(fs.existsSync(usedCwd), false);
    assert.equal(res.worktree, "");
  } finally { rm(cwd); }
});

test("Tool lists: comma list and array give the same set", () => {
  assert.deepEqual(toolList("Read, Grep ,Read"), ["Read", "Grep"]);
  assert.deepEqual(toolList(["Read", "Bash"]), ["Read", "Bash"]);
  assert.deepEqual(toolList(null), []);
});

// The engine hands no NATIVE subagent to the core any more (the engine's `Task` with `claude::...` is gone): the engine starts
// subagents through cbase_agent and the route of the core, any model, any provider; see engine-task-core.test.js and
// agent-depth.test.js.

test("tokenKind: measured from the event stream, not from the provider name", async () => {
  const cwd = tmp("token-kind");
  try {
    // The Claude CLI reports its consumption on assistant events WITH message.id; the tally books
    // both sides from it, the number is complete.
    const calls = []; const events = []; const finished = []; const started = [];
    const rt = makeRuntime({ calls, events, finished, started, cwd });
    const res = await rt.start({ run_in_background: false, prompt: "do it", model: "codex::gpt-5.1-codex" });
    assert.equal(res.tokenKind, "full", "both sides counted (7 input / 3 output)");
    assert.equal(rt.get(res.agentId).tokenKind, "full");

    // Codex and the loop engine report the same consumption as message_start WITHOUT message.id
    // (contract.js, ev.usageStart): there the INPUT stays uncounted, and the sum is a lower bound.
    // The display must say exactly that ("at least 12k" instead of "12k").
    const onlyOutput = async ({ onEvent }) => {
      onEvent(ev.usageStart({ input: 4_000, cacheRead: 0, cacheCreate: 0, output: 0 }));
      onEvent(ev.usageDelta(120));
      onEvent(ev.assistantText("finished"));
      onEvent({ type: "result", result: "REPORT", session_id: "sess-2" });
      return { code: 0, sessionId: "sess-2", resultText: "REPORT", stderr: "" };
    };
    const rt2 = makeRuntime({ calls: [], events: [], finished: [], cwd, run: onlyOutput });
    const res2 = await rt2.start({ run_in_background: false, prompt: "do it", model: "codex::gpt-5.1-codex" });
    assert.equal(res2.tokenKind, "only_output");
    assert.equal(res2.totalTokens, 120, "only the output side is counted");
    assert.equal(rt2.get(res2.agentId).tokens, 120);
  } finally { rm(cwd); }
});

test("The model appears everywhere in ONE form: bare id or empty, provider separate", async () => {
  const cwd = tmp("model-form");
  try {
    const calls = []; const events = []; const started = [];
    const rt = makeRuntime({ calls, events, started, cwd });
    // With an explicit model: the bare id, never "provider::model".
    const including = await rt.start({ run_in_background: false, prompt: "do it", model: "third::pro" });
    assert.equal(including.resolvedModel, "pro");
    assert.equal(including.provider, "third");
    assert.equal(rt.get(including.agentId).model, "pro");
    assert.equal(started[0].model.includes("::"), false);

    // WITHOUT a model the subagent inherits the chat's provider, and `model` stays EMPTY instead of carrying
    // a placeholder text. A placeholder was a second spelling for the same fact and had to be caught at
    // every display separately.
    const without = await rt.start({ run_in_background: false, prompt: "do it" });
    assert.equal(without.resolvedModel, "");
    assert.equal(without.provider, "claude");
    assert.equal(rt.get(without.agentId).model, "");
  } finally { rm(cwd); }
});

test("Stopped by the human: the report says so, so the main agent can carry on", async () => {
  const cwd = tmp("stop");
  try {
    const calls = []; const events = []; const finished = [];
    // A gate that never opens (instead of 400 ms): the stopped subagent is one that demonstrably still works.
    const t = gates();
    const rt = makeRuntime({ calls, events, finished, cwd, run: fakeRunChat(calls, { gate: t.gate }) });
    const res = await rt.start({ prompt: "long task", run_in_background: true, model: "third::mini" });
    assert.equal(rt.stop(res.agentId, { ofHuman: true }), true);

    const report = await rt.output({ agentId: res.agentId, block: false });
    assert.equal(report.status, "stopped");
    assert.equal(report.report, "Stopped by the human. No result.");
    assert.equal(report.error, "Stopped by the human. No result.");
    // Nobody waited, so the server delivers this report as a new turn (see runs/do-run.js, agentReportPrompt).
    assert.equal(finished.length, 1);
    assert.equal(finished[0].info.delivered, false);
    assert.match(finished[0].info.report.report, /Stopped by the human/);

    // The main agent aborts differently, otherwise it could not be told who stopped it.
    const second = await rt.start({ prompt: "another one", run_in_background: true, model: "third::mini" });
    rt.stop(second.agentId);
    const b2 = await rt.output({ agentId: second.agentId, block: false });
    assert.match(b2.report, /Aborted by the main agent/);
  } finally { rm(cwd); }
});

// ── A subagent at the usage limit has FAILED, it is not done ─────────────
// All tests here used to stub runChat with {code: 0}; the path on which a run ends with exit != 0 was never entered, and
// exactly there the core settled a subagent that died at the limit as "completed" with "(no report)". The counter-test is
// the old state: without the exit check in drive() the first three tests are red.

test("Exit != 0: the subagent has failed, and the report carries the wording of the limit", async () => {
  const cwd = tmp("exit");
  try {
    // Exactly what runChatClaude returns when the CLI dies at the limit: no result event,
    // resultText null, the wording on stderr (with reset hint), exit 1.
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    const atLimit = async ({ onEvent, onSpawn }) => {
      onSpawn?.({ kill: () => {}, cbaseEndInput: () => {} });
      onEvent({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "starting" }], usage: { input_tokens: 5, output_tokens: 2 } } });
      return { code: 1, sessionId: null, resultText: null, stderr: `Claude usage limit reached · resets at ${resetAt}\n` };
    };
    const calls = []; const events = []; const finished = [];
    const rt = makeRuntime({ calls, events, finished, cwd, run: atLimit });
    const res = await rt.start({ run_in_background: false, prompt: "work", model: "claude::claude-opus-5" });

    assert.equal(res.status, "failed");
    assert.match(res.error, /usage limit reached/i);
    assert.equal(res.report, "", "an error message is no report, and \"(no report)\" exists only on success");
    // The wording must be readable as a LIMIT, with reset: the parking of the parent run depends on it.
    const hit = limits.detectLimitHit({ stderr: res.error });
    assert.equal(hit.hit, true);
    assert.equal(hit.resetAt, Date.parse(resetAt));
    // The server reports `is_error` to the parent run from info.report.status: the same report.
    assert.equal(finished.length, 1);
    assert.equal(finished[0].info.report.status, "failed");
    assert.match(finished[0].info.report.notes, /Error: .*usage limit reached/i);
    // The consumption is booked anyway: failed does not mean free.
    assert.equal(res.totalTokens, 7);
    assert.equal(rt.get(res.agentId).status, "failed");

    // Regression: code 0 with a report stays "completed", even if stderr carries warnings.
    const withWarning = async ({ onEvent, onSpawn }) => {
      onSpawn?.({ kill: () => {}, cbaseEndInput: () => {} });
      onEvent({ type: "result", result: "REPORT", session_id: "s" });
      return { code: 0, sessionId: "s", resultText: "REPORT", stderr: "[warn] something harmless\n" };
    };
    const rt2 = makeRuntime({ calls: [], events: [], finished: [], cwd, run: withWarning });
    const ok = await rt2.start({ run_in_background: false, prompt: "work", model: "claude::claude-opus-5" });
    assert.equal(ok.status, "completed");
    assert.equal(ok.report, "REPORT");
    assert.equal(ok.error, "");

    // Without stderr at least the exit code remains as the reason: an error without a word is none.
    const silent = async ({ onSpawn }) => { onSpawn?.({ kill: () => {}, cbaseEndInput: () => {} }); return { code: 2, sessionId: null, resultText: null, stderr: "" }; };
    const rt3 = makeRuntime({ calls: [], events: [], finished: [], cwd, run: silent });
    const empty = await rt3.start({ run_in_background: false, prompt: "work", model: "third::mini" });
    assert.equal(empty.status, "failed");
    assert.equal(empty.error, "Exit 2");
  } finally { rm(cwd); }
});

test("makeForward passes on the error marker of the result event, also with exit 0", async () => {
  const cwd = tmp("marker");
  try {
    // Form of the loop engine (contract.js): is_error + error.message, partial text in result.
    // Exit 0, because makeForward is measured here, not the exit check: the CLI survives a limit,
    // closes the turn and waits; the process ends cleanly afterwards.
    const partialText = "Interim result: ".padEnd(3_000, "x"); // longer than the server's evidence excerpt
    const engineForm = async ({ onEvent, onSpawn }) => {
      onSpawn?.({ kill: () => {}, cbaseEndInput: () => {} });
      onEvent(ev.result(partialText, "sess-e", "Claude usage limit reached · resets at 3pm"));
      return { code: 0, sessionId: "sess-e", resultText: partialText, stderr: "" };
    };
    const finished = [];
    const rt = makeRuntime({ calls: [], events: [], finished, cwd, run: engineForm });
    const res = await rt.start({ run_in_background: false, prompt: "work", model: "third::mini" });
    assert.equal(res.status, "failed");
    assert.match(res.error, /usage limit reached/i);
    assert.equal(res.report, partialText, "the partial text next to the error marker stays the report");
    assert.equal(limits.detectLimitHit({ stderr: res.error }).hit, true);
    // The parent run reads only the START of the report as limit evidence (runs/do-run.js, limitEvidence: 2000 characters).
    // A long partial report must not push the wording behind that limit.
    const header = JSON.stringify(finished[0].info.report, null, 2).slice(0, 2000);
    assert.match(header, /usage limit reached/i, "the reason is next to the status, before the report");

    // Form of the Claude CLI, error variant: is_error + errors[] and NO result.
    const cliError = async ({ onEvent, onSpawn }) => {
      onSpawn?.({ kill: () => {}, cbaseEndInput: () => {} });
      onEvent({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Claude usage limit reached · resets at 3pm"], session_id: "sess-c" });
      return { code: 0, sessionId: "sess-c", resultText: null, stderr: "" };
    };
    const rt2 = makeRuntime({ calls: [], events: [], finished: [], cwd, run: cliError });
    const res2 = await rt2.start({ run_in_background: false, prompt: "work", model: "claude::claude-opus-5" });
    assert.equal(res2.status, "failed");
    assert.match(res2.error, /usage limit reached/i);

    // Form of the Claude CLI, success variant with is_error: the wording is in `result` and
    // belongs in `error`, not into the history as a "report".
    const cliSuccess = async ({ onEvent, onSpawn }) => {
      onSpawn?.({ kill: () => {}, cbaseEndInput: () => {} });
      onEvent({ type: "result", subtype: "success", is_error: true, result: "Claude usage limit reached · resets at 3pm", session_id: "sess-d" });
      return { code: 0, sessionId: "sess-d", resultText: "Claude usage limit reached · resets at 3pm", stderr: "" };
    };
    const rt3 = makeRuntime({ calls: [], events: [], finished: [], cwd, run: cliSuccess });
    const res3 = await rt3.start({ run_in_background: false, prompt: "work", model: "claude::claude-opus-5" });
    assert.equal(res3.status, "failed");
    assert.match(res3.error, /usage limit reached/i);
    assert.equal(res3.report, "");
  } finally { rm(cwd); }
});

test("A deliberate stop stays \"stopped\": exit != 0 after SIGTERM is no limit error", async () => {
  const cwd = tmp("stopexit");
  try {
    // The process dies at the signal (exit 143) and even has a limit word on stderr: the human's
    // stop applies anyway, otherwise every abort would count as "failed".
    let release;
    let back = false;
    const untilToKill = async ({ onSpawn }) => {
      onSpawn?.({ kill: () => { release?.(); }, cbaseEndInput: () => {} });
      await new Promise((r) => { release = r; });
      back = true;
      return { code: 143, sessionId: null, resultText: null, stderr: "Claude usage limit reached\n" };
    };
    const finished = [];
    const rt = makeRuntime({ calls: [], events: [], finished, cwd, run: untilToKill });
    const a = await rt.start({ prompt: "long", run_in_background: true, model: "third::mini" });
    assert.equal(rt.stop(a.agentId, { ofHuman: true }), true);
    // drive() must not rewrite anything after the kill: wait until the run has returned, then one round of the event loop:
    // drive processes its result in microtasks without I/O, after which it has had every opportunity (instead of 20 ms).
    await until(() => back);
    await new Promise((r) => setImmediate(r));
    const report = await rt.output({ agentId: a.agentId, block: false });
    assert.equal(report.status, "stopped");
    assert.equal(report.error, "Stopped by the human. No result.");
    assert.equal(finished.length, 1, "exactly ONE completion: the exit after the stop does not settle a second time");
  } finally { rm(cwd); }
});

// runOnceClaude reads the CLI's result object: `is_error`/`subtype` turn a limit under exit 0 into a thrown error WITH the
// wording. Counter-test: old state => the call resolves with the limit sentence as the "answer", the test is red.
test("runOnceClaude: a limit in the result object is thrown, not returned as the answer", async () => {
  const root = tmp("oneshot");
  const bin = path.join(root, "fake-claude");
  const previous = process.env.CLAUDE_BIN;
  try {
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    // The fake CLI picks the variant from the prompt: success variant with is_error (wording in
    // result), error variant (errors[], no result), or an ordinary answer.
    fs.writeFileSync(bin, `#!/usr/bin/env node
let stdin = ""; process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  const limit = "Claude usage limit reached · resets at ${resetAt}";
  if (/SUCCESS_VARIANT/.test(stdin)) process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: limit, session_id: "s" }));
  else if (/ERROR_VARIANT/.test(stdin)) process.stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: [limit], session_id: "s" }));
  else process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Title", session_id: "s" }));
  process.exit(0);
});
`);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;

    await assert.rejects(
      () => runOnceClaude("SUCCESS_VARIANT", { cwd: root, timeoutMs: 10_000 }),
      (e) => {
        const hit = limits.detectLimitHit({ stderr: e.message });
        assert.equal(hit.hit, true, `limit not detected in: ${e.message}`);
        assert.equal(hit.resetAt, Date.parse(resetAt), "the reset time must be readable from the message");
        return true;
      },
    );
    await assert.rejects(
      () => runOnceClaude("ERROR_VARIANT", { cwd: root, timeoutMs: 10_000 }),
      (e) => { assert.match(e.message, /usage limit reached/i); return true; },
    );
    // Regression: an ordinary answer comes as text as before.
    assert.equal(await runOnceClaude("Give me a title", { cwd: root, timeoutMs: 10_000 }), "Title");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = previous;
    rm(root);
  }
});
