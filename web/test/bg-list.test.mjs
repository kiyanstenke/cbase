// ALL kinds of background work in the ONE list "Background Tasks", and the count on the tab from the SAME list.
//
// What this guard holds:
//   (a) lib/bg-list.ts `bgList`: subagents, dynamic and graph workflows mixed, newest on top, split into
//       running/ended by the entry's `running`; each key once, data and order do not drift apart;
//   (b) lib/bg-rows.ts: the wakeup as a row of its own under "Running" behind the monitors, and `bgRunningCount` = the rows
//       under "Running" without the head (ended ones never count, a folded "Ended" changes nothing);
//   (e) the wiring: ONE hook computes the list (chat/chatBackgroundTasks.ts) in the right bar, the tab counts
//       `bg.running`, is called "Background Tasks" and no longer carries the person icon;
//   (f) the runs of the Outer Loop do NOT belong in it — neither as a source in the hook nor as a card, neither on web nor iOS.
//
// Counter-test (which sabotage turns which test red):
//   bg-rows.ts `bgRunningCount` without the `|| z.section === "running"` condition (counts ended) turns (b) red;
//   bg-rows.ts deleting the line `if (wakeup !== null) rows.push(…)` turns (b) red;
//   ChatRightSidebar.tsx `badge: bg.running` → `badge: 0` turns (e) red; chatBackgroundTasks.ts `graph: []` instead of
//   `graph: gr` turns (e) red;
//   bringing the Outer Loop row back (chatBackgroundTasks.ts `| { kind: "outerloop"; … }` or ChatViewModel+BackgroundTasks.swift
//   `case outerLoop(…)`) turns (f) red.
//
// Run:  ./check  (single file: node --test web/test/bg-list.test.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");
const src = path.join(webDir, "src");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (...parts) => fs.readFileSync(path.join(src, ...parts), "utf8");
const withoutComments = (q) => q.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-bg-list-"));
let L, Z;
try {
  execFileSync(process.execPath, [
    tsc, path.join(src, "lib", "bg-list.ts"), path.join(src, "lib", "bg-rows.ts"),
    "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler",
  ], { stdio: "pipe" });
  L = await import(pathToFileURL(path.join(out, "bg-list.js")).href);
  Z = await import(pathToFileURL(path.join(out, "bg-rows.js")).href);
} finally {
  try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ }
}

const e = (key, start, running) => ({ key, start, running, data: { key } });
const keys = (xs) => xs.map((x) => x.key);

test("(a) bgList: all kinds mixed, newest on top, running/ended by `running`, each key once", () => {
  const r = L.bgList({
    agents: [e("agent:done", null, false), e("agent:live", 900, true)],
    runs: [e("workflow:w2", 600, true), e("workflow:w", 500, false)],
    // newest first: graph 800 (open), graph 700 (open), graph 300 (ended), duplicate
    graph: [e("graph:a", 800, true), e("graph:o", 700, true), e("graph:b", 300, false), e("graph:a", 1, false)],
    followUp: ["agent:done"],
  });
  assert.deepEqual(keys(r.list), ["agent:live", "graph:o", "workflow:w2", "workflow:w", "graph:b", "graph:a", "agent:done"]);
  // Duplicate: the data is that of the entry the order kept (the LAST of the newest-first list, time 1) — not the other.
  assert.equal(r.list.find((x) => x.key === "graph:a").start, 1);
  assert.deepEqual(keys(r.active), ["agent:live", "graph:o", "workflow:w2"]);
  assert.deepEqual(keys(r.finished), ["workflow:w", "graph:b", "graph:a", "agent:done"]);
  assert.equal(r.list.length, new Set(keys(r.list)).size);
});

test("(b) wakeup as a row under \"Running\", the count on the tab from the same rows", () => {
  const t = (s) => ({ key: s });
  const rows = (x) => Z.bgRows({ active: [], finished: [], commands: [], monitors: [], endedClosed: false, key: (v) => v.key, ...x });
  const z = rows({ active: [t("agent:a")], finished: [t("workflow:w"), t("graph:o")], commands: [{ taskId: "b" }], monitors: [{ taskId: "m" }], wakeup: 1790000000000 });
  assert.deepEqual(z.map((r) => r.key), ["header:running", "agent:a", "command:b", "monitor:m", "wakeup", "header:ended", "workflow:w", "graph:o"]);
  assert.equal(z.find((r) => r.kind === "wakeup").at, 1790000000000);
  assert.equal(Z.bgRunningCount(z), 4, "subagent, command, monitor, wakeup — not the ended ones");
  // Folded does not change the count; without anything running it is 0, even if ended ones stand there.
  assert.equal(Z.bgRunningCount(rows({ active: [t("agent:a")], finished: [t("workflow:w")], wakeup: 5, endedClosed: true })), 2);
  assert.equal(Z.bgRunningCount(rows({ finished: [t("workflow:w"), t("graph:g")] })), 0);
  // A wakeup alone: "Running" stands, with it alone.
  assert.deepEqual(rows({ wakeup: 42 }).map((r) => r.key), ["header:running", "wakeup"]);
  // No time is no wakeup.
  for (const w of [0, -1, null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(rows({ wakeup: w }), [], `wakeup ${w}`);
  }
});

test("(e) wiring: ONE hook, the tab counts from it, is called \"Background Tasks\", own icon", () => {
  const page = withoutComments(read("components", "chat", "ChatRightSidebar.tsx"));
  assert.equal((page.match(/useBackgroundTasks\(/g) || []).length, 1, "the bar calls the hook exactly once");
  assert.match(page, /agents: \{ label: t\("Background tasks"\), icon: BackgroundTasksIcon, badge: bg\.running \}/);
  assert.doesNotMatch(page, /AgentsIcon|runningAgents|runningWorkflowAgents/, "the old hand count or the person icon");
  assert.match(page, /const BackgroundTasksIcon = svg\(/);
  const hook = withoutComments(read("components", "chat", "chatBackgroundTasks.ts"));
  assert.match(hook, /running = bgRunningCount\(bgRows\(\{ active, finished, commands, monitors, wakeup,/, "the count from the same rows");
  assert.match(hook, /bgList\(\{ agents: ag, runs: wf, graph: gr, followUp: taskSequence \}\)/, "the graph workflows go into the list");
  // The bar computes nothing itself and shows every kind.
  const bar = withoutComments(read("components", "AgentBar.tsx"));
  assert.doesNotMatch(bar, /backgroundTasks\(|backgroundRuns\(/);
  for (const marker of ["data-bg-wakeup", "data-bg-wakeup-stop"]) assert.ok(bar.includes(marker), marker);
  // New words have their German entry.
  const en = read("lib", "i18n-de.ts");
  for (const k of ["Git, agenda, artifacts, channels, background tasks, terminal and browser", "Background tasks"]) {
    assert.ok(en.includes(`\n  ${JSON.stringify(k)}:`), `i18n-de lacks "${k}"`);
  }
});

test("(f) Outer Loop does NOT belong in \"Background Tasks\" — neither source nor card, neither web nor iOS", () => {
  // Without comments: the origin of the decision is quoted there.
  const sources = {
    "lib/bg-list.ts": read("lib", "bg-list.ts"),
    "lib/background-tasks.ts": read("lib", "background-tasks.ts"),
    "components/chat/chatBackgroundTasks.ts": read("components", "chat", "chatBackgroundTasks.ts"),
    "components/AgentBar.tsx": read("components", "AgentBar.tsx"),
    "ChatViewModel+BackgroundTasks.swift": fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", "Chat", "ChatViewModel+BackgroundTasks.swift"), "utf8"),
    "BackgroundTasks.swift": fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", "Chat", "BackgroundTasks.swift"), "utf8"),
  };
  for (const [name, raw] of Object.entries(sources)) {
    const q = withoutComments(raw).replace(/^\s*\/\/\/.*$/gm, "");
    assert.doesNotMatch(q, /outer[-_ ]?loop/i, `${name}: the Outer Loop is back in the list`);
  }
  // The card of the agents sheet on iOS and the loading paths of the model.
  const sheet = withoutComments(fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", "Chat", "ChatDetailSheet.swift"), "utf8"));
  const sb = sheet.slice(sheet.indexOf("struct SubagentsSheet"));
  assert.doesNotMatch(sb, /outerLoopCard|chat-bg-outerloop|case \.outerLoop/, "iOS: an Outer Loop card in the agents sheet");
  for (const file of ["ChatViewModel.swift", "ChatViewModel+Stream.swift", "ChatView.swift"]) {
    const q = fs.readFileSync(path.join(repo, "mobile", "CbaseMobile", "Chat", file), "utf8");
    assert.doesNotMatch(q, /loadOuterLoopAgents|outerLoopAgents/, `${file}: loads the Outer Loop runs for the list`);
  }
});
