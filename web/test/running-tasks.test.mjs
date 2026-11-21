// The running tasks of a conversation (src/lib/running-tasks.ts) -- the "N running tasks" pill in the working row at the end of
// the timeline and its sheet. Here the RULES of the computation and the wiring in the source text; that iOS computes the same
// is held by running-tasks-binding.test.mjs.
//
// The rules, each from a question whose wrong answer is silent:
//   - What counts: background subagents, running dynamic workflows, background commands, monitors, the alarm. NOT the foreground
//     agent (a call of the turn waits for it -- the row already shows that work) and no finished agent from the history.
//   - Empty is not unknown: a tree that has not answered yet makes the list INCOMPLETE ("at least ..."); a conversation without
//     a workflow source passes `null` and is complete.
//   - The row: [six-sided mark] [time] [pill] [word]; without a run but with tasks only [mark] [pill]; with neither no row.
//   - Stop only where the server knows it (subagent, workflow) -- command, monitor, alarm get no invented one.
//
// COUNTER-TESTS (shown red, reverted): in running-tasks.ts `if (!a.live || a.foreground) return;` -> `if (!a.live) return;` =>
// "foreground does not count" red; `return { item, complete: e.workflowsLoaded }` -> `complete: true` => "unloaded is incomplete"
// red; in ChatStage.tsx `tasks={runningTasks}` removed => "wiring" red; in ChatRunStatus.swift the corner `(12, 2)` -> `(12, 2.5)`
// => "edge" red; in ChatTimelineRow.swift the metric row back to `HexagonMark()` => "edge" red.
//
// Run:  node --test web/test/running-tasks.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const src = path.join(webDir, "src");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

// Compile the real sources with the local tsc (as agents.test.mjs) -- the chain from the event to the pill.
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-running-tasks-"));
execFileSync(process.execPath, [
  tsc, path.join(src, "lib", "running-tasks.ts"), path.join(src, "lib", "agents.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
], { stdio: "pipe" });
const L = await import(pathToFileURL(path.join(out, "running-tasks.js")).href);
const A = await import(pathToFileURL(path.join(out, "agents.js")).href);
try { fs.rmSync(out, { recursive: true, force: true }); }
catch (e) { console.warn("[test] temp directory stayed behind:", String(e?.message || e).slice(0, 120)); }

const empty = { agents: [], workflows: [], workflowsLoaded: true, commands: [], monitors: [], wakeup: { at: 0, reason: "", prompt: "" } };
const agent = (o = {}) => ({ key: "tu-1", agentId: "a-1", name: "Update tests", live: true, foreground: false, startedAt: 1000, parkedUntil: null, ...o });
const read = (rel) => fs.readFileSync(path.join(src, rel), "utf8");

test("Nothing runs: no items, complete, no pill", () => {
  const t = L.runningTasks(empty);
  assert.deepEqual(t, { item: [], complete: true });
  assert.equal(L.pillsText(t), null, "without a task there is no pill -- it claims nothing");
});

test("Foreground does not count, neither does a finished agent -- only the background agent", () => {
  const t = L.runningTasks({ ...empty, agents: [
    agent({ key: "tu-v", agentId: "a-v", foreground: true }),
    agent({ key: "tu-f", agentId: "a-f", live: false }),
    agent(),
  ] });
  assert.deepEqual(t.item.map((p) => p.key), ["agent:a-1"]);
  const [p] = t.item;
  assert.equal(p.kind, "agent");
  assert.equal(p.name, "Update tests");
  assert.equal(p.since, 1000);
  assert.equal(p.until, null);
  assert.equal(p.reference, "a-1", "the stop works with the agentId");
  assert.equal(p.anchor, "tu-1", "Open selects the entry of the agent list (tool call id)");
});

test("A parked agent carries `until` (waits until ...); unusable times are unknown, not 0", () => {
  const t = L.runningTasks({ ...empty, agents: [
    agent({ parkedUntil: 5_000_000 }),
    agent({ key: "tu-2", agentId: "a-2", startedAt: 0, parkedUntil: -1 }),
    agent({ key: "tu-3", agentId: "a-3", startedAt: Number.NaN, parkedUntil: Number.POSITIVE_INFINITY }),
  ] });
  assert.deepEqual(t.item.map((p) => [p.since, p.until]), [[1000, 5_000_000], [null, null], [null, null]]);
});

test("Workflows: only \"running\" counts; an unloaded tree makes the list incomplete (\"at least\")", () => {
  const wf = [
    { runId: "r-1", name: "Job → Ship", status: "running", startedAt: 2000 },
    { runId: "r-2", name: "old", status: "finished", startedAt: 1 },
    { runId: "r-3", name: "stopped", status: "stopped", startedAt: 1 },
    { runId: "", name: "no id", status: "running", startedAt: 1 },
  ];
  const t = L.runningTasks({ ...empty, workflows: wf });
  assert.deepEqual(t.item.map((p) => [p.kind, p.key, p.reference, p.since]), [["workflow", "workflow:r-1", "r-1", 2000]]);
  assert.deepEqual(L.pillsText(t), { key: "1 running task", n: 1 });
  const unloaded = L.runningTasks({ ...empty, workflows: wf, workflowsLoaded: false });
  assert.equal(unloaded.complete, false);
  assert.deepEqual(L.pillsText(unloaded), { key: "at least 1 running task", n: 1 });
  const two = L.runningTasks({ ...empty, workflowsLoaded: false, commands: [{ taskId: "b1", description: "x" }, { taskId: "b2", description: "y" }] });
  assert.deepEqual(L.pillsText(two), { key: "at least {n} running tasks", n: 2 });
});

test("Commands, monitors, alarm: one item each, the alarm only with a wake time; description and alarm text are kept", () => {
  const t = L.runningTasks({
    ...empty,
    commands: [{ taskId: "bg_dev", description: "Dev server" }, { taskId: "", description: "" }],
    monitors: [{ taskId: "m1", description: "Watch the log" }],
    wakeup: { at: 9_000_000, reason: "The pipeline still needs time", prompt: "Check the pipeline" },
  });
  assert.deepEqual(t.item.map((p) => [p.kind, p.key, p.name]), [
    ["command", "command:bg_dev", "Dev server"],
    ["command", "command:1", ""],
    ["monitor", "monitor:m1", "Watch the log"],
    ["wakeup", "wakeup", ""],
  ]);
  const w = t.item.at(-1);
  assert.deepEqual([w.until, w.reason, w.prompt], [9_000_000, "The pipeline still needs time", "Check the pipeline"], "nothing of the old alarm card is lost");
  assert.equal(L.runningTasks({ ...empty, wakeup: { at: 0, reason: "g", prompt: "p" } }).item.length, 0, "wake time 0 = no alarm");
  assert.deepEqual(L.pillsText(t), { key: "{n} running tasks", n: 4 });
});

test("Order by kind, every item exactly once", () => {
  const t = L.runningTasks({
    agents: [agent(), agent({ key: "tu-1b" })], // the same agentId twice
    workflows: [{ runId: "r", name: "W", status: "running", startedAt: 1 }, { runId: "r", name: "W2", status: "running", startedAt: 1 }],
    workflowsLoaded: true,
    commands: [{ taskId: "b", description: "B" }],
    monitors: [{ taskId: "m", description: "M" }],
    wakeup: { at: 1, reason: "", prompt: "" },
  });
  assert.deepEqual(t.item.map((p) => p.kind), ["agent", "workflow", "command", "monitor", "wakeup"]);
  assert.equal(t.item[1].name, "W", "the first one wins");
});

// Graph workflows. COUNTER-TESTS (shown red, reverted): in running-tasks.ts `g.background !== true ||` removed => red (the
// foreground run counted); `&& e.graphLoaded !== false` removed => red.
test("Graph workflows: only in the BACKGROUND and only running or waiting; an unloaded state is incomplete; stop at the chat of the start", () => {
  const g = (startId, state, o = {}) => ({ startId, name: `G ${startId}`, shortName: `g-${startId}`, state, background: true, startedAt: 500, ...o });
  const graphRuns = [
    g("l", "running"), g("w", "waiting", { name: "" }), g("s", "waiting_lock"), g("p", "waiting_storage", { startedAt: null }),
    g("front", "running", { background: false }), g("v", "earmarked"), g("f", "finished"), g("x", "stopped"), g("", "running"),
  ];
  const t = L.runningTasks({ ...empty, graphRuns });
  assert.deepEqual(t.item.map((p) => [p.kind, p.key, p.name, p.since, p.reference, p.anchor]), [
    ["graph", "graph:l", "G l", 500, "l", "l"], ["graph", "graph:w", "g-w", 500, "w", "w"],
    ["graph", "graph:s", "G s", 500, "s", "s"], ["graph", "graph:p", "G p", null, "p", "p"],
  ], "foreground, earmarked, finished and without id do not count; without a name the short name");
  assert.equal(t.complete, true, "unspecified: known");
  assert.equal(L.runningTasks({ ...empty, graphRuns, graphLoaded: false }).complete, false, "unloaded => \"at least\"");
  assert.deepEqual(L.pillsText(L.runningTasks({ ...empty, graphRuns, graphLoaded: false })), { key: "at least {n} running tasks", n: 4 });
  // Order: after the dynamic workflows, before the commands.
  const mixed = L.runningTasks({ ...empty, workflows: [{ runId: "r", name: "W", status: "running", startedAt: 1 }], commands: [{ taskId: "b", description: "B" }], graphRuns: [g("l", "running")] });
  assert.deepEqual(mixed.item.map((p) => p.kind), ["workflow", "graph", "command"]);
  assert.equal(L.hasStop(t.item[0]), true);
  assert.deepEqual(L.stopWay("chat 1", { ...t.item[0], reference: "gs/1" }), { path: "/api/chats/chat%201/graph-workflows/gs%2F1/stop", body: { from: "human" } });
});

test("The row: [mark] [time] [pill] [word] -- without a run only [mark] [pill], without both nothing", () => {
  const f = (running, time, tasks) => L.rowsParts({ running, time, tasks });
  assert.deepEqual(f(true, true, 3), ["hex", "time", "pill", "word"]);
  assert.deepEqual(f(true, true, 0), ["hex", "time", "word"]);
  assert.deepEqual(f(true, false, 0), ["hex", "word"], "without a run start no time");
  assert.deepEqual(f(false, true, 2), ["hex", "pill"], "waiting phase: resting mark and pill");
  assert.deepEqual(f(false, false, 0), []);
});

test("Stop only where the server knows it -- path and body as in the agent bar and in the tree", () => {
  const t = L.runningTasks({
    ...empty,
    agents: [agent()],
    workflows: [{ runId: "r/1", name: "W", status: "running", startedAt: 1 }],
    commands: [{ taskId: "b", description: "B" }],
    monitors: [{ taskId: "m", description: "M" }],
    wakeup: { at: 1, reason: "", prompt: "" },
  });
  const ways = t.item.map((p) => L.stopWay("chat 1", p));
  assert.deepEqual(ways[0], { path: "/api/chats/chat%201/agent/stop", body: { agentId: "a-1", from: "human" } });
  assert.deepEqual(ways[1], { path: "/api/chats/chat%201/dyn-workflows/runs/r%2F1/stop", body: { from: "human" } });
  assert.deepEqual(ways[2], null, "a command has no stop");
  // The monitor belongs to the chat and has a stop.
  assert.deepEqual(ways[3], { path: "/api/chats/chat%201/monitor/stop", body: { taskId: "m", from: "human" } });
  // The alarm also belongs to the chat and has a stop.
  assert.deepEqual(ways[4], { path: "/api/chats/chat%201/wakeup/stop", body: { from: "human" } });
  assert.deepEqual(t.item.map(L.hasStop), [true, true, false, true, true]);
  assert.ok(read("components/AgentBar.tsx").includes("/wakeup/stop"), "the alarm card takes the same way");
  assert.ok(read("components/AgentBar.tsx").includes("/monitor/stop"), "the monitor card takes the same way");
  assert.equal(L.stopWay("", t.item[0]), null, "without a chat no stop");
  assert.equal(L.hasStop({ ...t.item[0], reference: "" }), false, "an agent without agentId cannot be stopped");
  // The same ways as the existing buttons -- no new server contract.
  assert.ok(read("components/AgentBar.tsx").includes("/agent/stop") && read("components/AgentBar.tsx").includes('from: "human"'));
  assert.ok(read("components/chat/DynWorkflowTree.tsx").includes("/dyn-workflows/runs/${encodeURIComponent(run.runId)}/stop"));
});

test("The chain from the event: one `background` with foreground and background agent, command and alarm => three tasks", () => {
  const s = A.backgroundAfter(A.BACKGROUND_EMPTY, {
    type: "harness", subtype: "background",
    agents: [
      { taskId: "t1", agentId: "a-bg", toolUseId: "tu-bg", description: "Update tests", status: "running", startedAt: 1000 },
      { taskId: "t2", agentId: "a-vg", toolUseId: "tu-vg", description: "Front", status: "running", startedAt: 1000, foreground: true },
    ],
    tasks: [{ taskId: "bg_dev", description: "Dev server" }],
    monitors: [],
    wakeupAt: 5000, wakeupReason: "Pipeline", wakeupPrompt: "Check",
  });
  const agents = A.agentsList(s.agents, [], new Set());
  // THE SAME mapping as useRunningTasks (components/chat/chatTasks.ts) -- the source text below pins it.
  const t = L.runningTasks({
    agents: agents.map((a) => ({ key: a.id, agentId: a.agentId, name: a.job, live: a.live, foreground: a.foreground === true, startedAt: a.startedAt ?? null, parkedUntil: a.parkedUntil ?? null })),
    workflows: [], workflowsLoaded: true,
    commands: s.tasks.map((p) => ({ taskId: p.taskId ?? "", description: p.description ?? "" })),
    monitors: s.monitors.map((p) => ({ taskId: p.taskId ?? "", description: p.description ?? "" })),
    wakeup: { at: s.wakeupAt, reason: s.wakeup.reason, prompt: s.wakeup.prompt },
  });
  assert.deepEqual(t.item.map((p) => p.key), ["agent:a-bg", "command:bg_dev", "wakeup"]);
  assert.equal(t.item[0].anchor, "tu-bg", "Open hits the entry of the bar (id = tool call)");
  const hook = read("components/chat/chatTasks.ts");
  for (const row of ["key: a.id,", "agentId: a.agentId,", "name: a.job,", "live: a.live,", "foreground: a.foreground === true,",
    "startedAt: a.startedAt ?? null,", "parkedUntil: a.parkedUntil ?? null,", "workflowsLoaded: dynTree.loaded,",
    "wakeup: { at: wakeupAt, reason: wakeup.reason, prompt: wakeup.prompt },"]) {
    assert.ok(hook.includes(row), `useRunningTasks no longer maps: ${row}`);
  }
});

test("Wiring: ONE building block for the coding chat, the chips above the input are gone", () => {
  const stage = read("components/chat/ChatStage.tsx");
  const row = read("components/chat/RunDisplay.tsx");
  const pill = read("components/chat/TasksPill.tsx");
  // The coding chat also passes the graph starts (`graphRuns`).
  for (const [who, q, tree] of [["Coding", stage, "dynTree, graphRuns }"]]) {
    assert.equal([...q.matchAll(/useRunningTasks\(/g)].length, 1, `${who}: exactly one call of useRunningTasks`);
    assert.ok(q.includes(`wakeup: waitWakeup, ${tree});`), `${who}: the workflow source is ${tree}`);
    const i = q.indexOf("<RunDisplay");
    const a = q.slice(i, q.indexOf("/>", i));
    assert.match(a, /tasks=\{runningTasks\}/, `${who}: the working row gets the tasks`);
    assert.match(a, /chatId=\{(activeId|chatId)\}/, `${who}: the working row knows the chat of the stop ways`);
    assert.ok(!q.includes("<RunStatusBar") && !q.includes("@/components/RunStatusBar") && !q.includes("runStatusDa("), `${who}: the chip row is still there`);
    assert.ok(!/\bchips=\{/.test(q), `${who}: the base still gets chips`);
  }
  assert.ok(!fs.existsSync(path.join(src, "components", "RunStatusBar.tsx")), "RunStatusBar.tsx is gone");
  assert.ok(!read("components/ComposerStrip.tsx").includes('id: "chips"'), "the base no longer knows a chip row");
  // The row computes its parts through the lib, the pill is one of them.
  assert.match(row, /const parts = rowsParts\(\{ running, time: p\.startedAt !== null, tasks: p\.tasks\?\.item\.length \?\? 0 \}\);/);
  assert.ok(row.includes("<TasksPill "), "RunDisplay renders the pill");
  assert.ok(stage.includes("onTaskOpen={onTaskOpen}") && stage.includes('p.kind === "agent" ? p.anchor : ""'), "Open leads to the agent bar");
  // Form system: portal on the body, kit sheet, click catcher via document mousedown + closest, no fixed inset-0.
  assert.ok(pill.includes("createPortal(") && pill.includes("document.body"), "the sheet hangs on the body via portal");
  assert.ok(pill.includes('document.addEventListener("mousedown"') && pill.includes('closest?.("[data-tasks-pop]")'), "click outside via mousedown + closest");
  assert.ok(!/className=\{?[`"][^`"]*\bfixed inset-0/.test(pill), "no click catcher as fixed inset-0");
  // `popSurface` (the kit surface without the inner padding of the menus, `popClass`): the sheet is no menu, the hairlines run to
  // the edge. Checked on the className, not anywhere in the file -- otherwise a comment would hold the guard.
  assert.ok(/className=\{`\$\{popSurface\} [^`]*cb-kit fixed/.test(pill) && pill.includes('role="dialog"'), "kit sheet (popSurface) with cb-kit and role=dialog (overlay mark of the agent browser)");
});

test("Translated: every key of the pill and the sheet is in i18n-de.ts", () => {
  const en = read("lib/i18n-de.ts");
  const key = [
    "1 running task", "{n} running tasks", "at least 1 running task", "at least {n} running tasks",
    ...Object.values(L.TASK_KIND_WORD),
    "Running tasks", "for {duration}", "at {time}", "in {time}", "Scheduled to continue", "Reason", "Then", "No description",
    "Open", "Stop", "Stopping…", "Close", "waiting until {time}",
    "This chat's workflows have not loaded yet — more may be running.",
    "Keeps running alongside while the chat stays responsive. As soon as it finishes, the agent evaluates the result on its own.",
    "The chat is woken at the given time by itself — until then you can keep writing.",
  ];
  const missing = key.filter((k) => !en.includes(`"${k}":`));
  assert.deepEqual(missing, [], "without translation");
  assert.deepEqual(L.TASK_KIND_WORD, { agent: "Subagent", workflow: "Workflow", graph: "Graph workflow", command: "Background command", monitor: "Monitor", wakeup: "Alarm" });
});

test("iOS: the DYNAMIC keys from RunningTasks.swift (pill, kind) are in the dictionary -- loc-audit sees only literals", () => {
  const repo = path.resolve(webDir, "..");
  const swift = fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", "Chat", "RunningTasks.swift"), "utf8");
  const words = ["LocDEBase.swift", "LocDEMobile.swift"].map((d) => fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", "Kit", d), "utf8")).join("\n");
  const pill = [...new Set([...swift.matchAll(/"((?:at least )?(?:1 running task|\{n\} running tasks))"/g)].map((m) => m[1]))];
  const kinds = [...swift.slice(swift.indexOf("static let kindWord")).matchAll(/\.\w+: "([^"]+)"/g)].slice(0, 6).map((m) => m[1]);
  assert.deepEqual(pill.sort(), ["1 running task", "at least 1 running task", "at least {n} running tasks", "{n} running tasks"].sort(), "the four pill texts in RunningTasks.swift");
  assert.deepEqual(kinds, Object.values(L.TASK_KIND_WORD), "the kind words in RunningTasks.swift");
  const stands = (k) => words.split("\n").some((z) => z.trim().startsWith(`"${k}":`));
  assert.deepEqual([...pill, ...kinds].filter((k) => !stands(k)), [], "without translation on iOS (showed English)");
});

// The left edge: web and iOS draw the SAME six-sided figure in the run and metric rows -- corners on the circumscribed circle of
// radius 10 in the 24 grid, stroke 2.2 -- so its ink starts where that of the first letter starts (numbers in the headers of
// RunDisplay.tsx and ChatRunStatus.swift). Two versions of the same figure -- bound here. Reads source only (also runs on Linux).
test("Edge: web path of RowsHexIcon and iOS corners of RowsHexagon are the same figure, both rows use it", () => {
  const repo = path.resolve(webDir, "..");
  const web = read("components/chat/RunDisplay.tsx");
  const ios = fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", "Chat", "ChatRunStatus.swift"), "utf8");
  const iosRow = fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", "Chat", "ChatTimelineRow.swift"), "utf8");
  // Web: the SVG path (M, L, l, V, v, H, h, z) into absolute corners.
  const beginning = web.indexOf("const RowsHexIcon");
  const icon = web.slice(beginning, web.indexOf(");", beginning));
  const d = icon.match(/<path d="([^"]+)"/)?.[1];
  assert.ok(d, "RowsHexIcon carries no path");
  const corners = [];
  let x = 0, y = 0;
  for (const [, cmd, counts] of d.matchAll(/([MLlVvHhz])([^MLlVvHhz]*)/g)) {
    const n = [...counts.matchAll(/-?(?:\d+\.?\d*|\.\d+)/g)].map((m) => Number(m[0])); // "-8.66-5" are two numbers
    if (cmd === "M" || cmd === "L") { x = n[0]; y = n[1]; }
    else if (cmd === "l") { x += n[0]; y += n[1]; }
    else if (cmd === "V") y = n[0];
    else if (cmd === "v") y += n[0];
    else if (cmd === "H") x = n[0];
    else if (cmd === "h") x += n[0];
    else continue;
    corners.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
  }
  if (corners.length > 1 && corners.at(-1).join() === corners[0].join()) corners.pop();
  const list = ios.match(/static let corners: \[\(CGFloat, CGFloat\)\] = \[([^\]]+)\]/)?.[1] ?? "";
  const swiftCorners = [...list.matchAll(/\(([\d.]+), ([\d.]+)\)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.equal(swiftCorners.length, 6, "RowsHexagon.corners not found");
  assert.deepEqual(swiftCorners, corners, "iOS corners differ from web path");
  for (const [ex, ey] of corners) assert.ok(Math.abs(Math.hypot(ex - 12, ey - 12) - 10) < 0.01, `corner (${ex}, ${ey}) is not on the circumscribed circle of radius 10`);
  assert.equal(icon.match(/strokeWidth="([\d.]+)"/)?.[1], ios.match(/static let stroke: CGFloat = ([\d.]+)/)?.[1], "stroke differs between web and iOS");
  assert.ok(icon.includes('strokeLinejoin="round"') && ios.includes("lineJoin: .round"), "round corners on both sides");
  // Both rows per side draw exactly this figure -- no second symbol next to it.
  assert.equal([...web.matchAll(/<RowsHexIcon \/>/g)].length, 2, "web: run and metric rows draw RowsHexIcon");
  const run = ios.slice(ios.indexOf("struct RunIndicator"), ios.indexOf("private func row("));
  assert.ok(run.includes("RowsHexagon()") && !run.includes("HexagonMark()"), "iOS: the run indicator draws RowsHexagon");
  const metric = iosRow.slice(iosRow.indexOf("if let summary = item.summary"), iosRow.indexOf('"chat-metric-hex"'));
  assert.ok(metric.includes("RowsHexagon()") && !metric.includes("HexagonMark()"), "iOS: the metric row draws RowsHexagon");
});
