// `worktree: true` gives a graph-workflow run its OWN git worktree (workflows/worktree.js) - without project lock, with the
// path rule in the prompt (runs/system-prompt.js worktreePrompt) and cleanup at the end (workflows/graph-background.js).
// In the background the worktree is the cwd of the child chat (resolveCwd), in the foreground the cwd stays and the worktree
// is added via --add-dir (do-run.js runAddDirs). Unchanged it is removed at the end, changed it stays (path in the view, in
// the completion notice or as a silent hint). Without a project 400 `project`, without a repo 400 `repo`; deleting the chat
// cleans up with force.
//
// Main seam via `withAgentsServer` with a project whose folder is a temp repo. The fake main agent stores per call text, cwd,
// --add-dir and system prompt under prompts.jsonl, calls `cbase_workflow_start` through the REAL cbase MCP server on every
// "GS[<tag>]:{json}§" (result under `gs-<tag>.jsonl`), writes a file into the worktree in a step with "CHANGE" (the path is
// named by the rule in the prompt), holds at the gate on "HALT:<x>" (in the step) or "GATE:<x>" (outside).
//
// The git configuration comes from the ENVIRONMENT (as in graph-worktree.test.js): a global ignore pattern of the machine
// would otherwise change what the leaf sees as its own entries.
//
// Counter-tests (which sabotage turns which test red):
//   - set `lockKey: z.worktree ? "" : undefined` in graph-start.js redeem to `undefined`  => "Background" red (the second
//     run waits for the project lock of the first);
//   - drop the exception in runs/system-prompt.js resolveCwd  => "Background" red (the step runs in the workspace);
//   - drop `removeWorktrees(chatId)` in graph-background.js graphChatClosed  => "Background" hangs at deleting (the changed
//     worktree stays).
// No deadline in the test itself (rule "no timers in tests"): a hang reports every 30 s what it waits for.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import * as store from "../electron/server/store.js";
import { deliverUserPrompt } from "../electron/server/runs/queue.js";
import { running } from "../electron/server/runs/state.js";

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "5",
  GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Test",
  GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "test@example.com",
  GIT_CONFIG_KEY_2: "core.excludesFile", GIT_CONFIG_VALUE_2: "/dev/null",
  GIT_CONFIG_KEY_3: "core.attributesFile", GIT_CONFIG_VALUE_3: "/dev/null",
  GIT_CONFIG_KEY_4: "init.defaultBranch", GIT_CONFIG_VALUE_4: "main",
};
Object.assign(process.env, GIT_ENV);

const git = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
};
function createRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".env*\n");
  git(["init", "-q"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "start"], dir);
  fs.writeFileSync(path.join(dir, ".env"), "SECRET=1\n");
}
const branches = (repo) => git(["branch", "--list", "--format=%(refname:short)"], repo).split("\n").filter(Boolean);
const real = (p) => fs.realpathSync(p);

const MAIN = `
  const sp = arg("--append-system-prompt");
  const addDirs = argv.flatMap((a, i) => (a === "--add-dir" ? [argv[i + 1]] : []));
  fs.appendFileSync(path.join(LOCATION, "prompts.jsonl"), JSON.stringify({ text, cwd: process.cwd(), addDirs, sp }) + "\\n");
  const step = String(text).includes("[cbase workflow");
  let g = step ? -1 : text.indexOf("GS[");
  while (g >= 0) {
    const gtag = text.slice(g + 3, text.indexOf("]:", g));
    const args = JSON.parse(text.slice(text.indexOf("]:", g) + 2, text.indexOf("§", g)));
    const id = "toolu_gs_" + gtag;
    say({ type: "assistant", message: { id: "a-" + gtag + "-" + turn, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_workflow_start", input: args }] } });
    let t = "";
    try { const r = await mcpCall("cbase_workflow_start", args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); }
    catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    fs.appendFileSync(path.join(LOCATION, "gs-" + gtag + ".jsonl"), JSON.stringify({ t }) + "\\n");
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
    g = text.indexOf("GS[", g + 3);
  }
  if (step && String(text).includes("CHANGE")) {
    const m = /its own Git worktree: (.+?) \\(branch/.exec(sp);
    fs.writeFileSync(path.join(m ? m[1] : process.cwd(), "fresh.txt"), "work\\n");
  }
  const hold = (String(text).match(/HALT:(\\w+)/) || [])[1];
  if (hold && step) await gate(hold);
  const wait = (String(text).match(/GATE:(\\w+)/) || [])[1];
  if (wait && !step) await gate(wait);
  finished();
  say({ type: "result", result: step ? "DONE" : "Started.", session_id: "s-main" });`;

const claude = fakeClaude({ main: MAIN });

async function raw(url, method = "GET", body = undefined) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json", Connection: "close" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const start = (base, chatId, body) => raw(`${base}/api/chats/${chatId}/graph-workflows/start`, "POST", body);

// A workflow `s → n1 → e` without a closing gate, with the lock "project" (the default - explicit here: without a
// worktree two runs on the same project would go one after the other).
function newWorkflow(ws, name, text, projectId = null) {
  const now = Date.now();
  const w = store.createWorkflow({ id: crypto.randomUUID(), workspaceId: ws.id, projectId, name, createdAt: now, updatedAt: now, graph: {
    nodes: [{ id: "s", type: "start", title: "Start" }, { id: "n1", type: "instruction", title: "Step", text }, { id: "e", type: "end", title: "End" }],
    edges: [{ from: "s", to: "n1" }, { from: "n1", to: "e" }],
  } });
  return store.updateWorkflow(w.id, { run: { doneAll: false }, lock: { scope: "project", template: "" } });
}
const entry = (w, shortName) => ({ workflowId: w.id, shortName, name: w.name });
const announcement = (id, workflows) => ({ id, workflows, attachments: [] });
const deliver = (chatId, text, a) => deliverUserPrompt(store.getChat(chatId), { prompt: text, display: text, cause: "user", ...(a ? { announcement: a } : {}) });

async function toolResult(root, tag) {
  const file = path.join(root, `gs-${tag}.jsonl`);
  const [{ t }] = await waitForTruthy(() => { const z = readJsonl(file); return z.length ? z : null; }, `tool result ${tag}`);
  assert.ok(!t.startsWith("ERROR "), t);
  return JSON.parse(t);
}
const runFinished = (runId) => waitForTruthy(() => { const r = store.getWorkflowRunById(runId); return r && !store.workflowOpen(r) ? r : null; }, `run ${runId} finished`);
// The calls of the fake whose text contains `part` (a step carries the text of its node).
const callsWith = (root, part) => readJsonl(path.join(root, "prompts.jsonl")).filter((p) => String(p.text).includes(part));

// A project in the workspace whose folder is a repo (created empty, then filled - a full folder would trigger the
// services scan), and a chat in it.
async function projectChat(base, ws, root, { name = "Checkout", repo = true } = {}) {
  const projPath = path.join(root, "workspace", name.toLowerCase());
  const project = await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name, path: projPath }) });
  if (repo) createRepo(projPath);
  else { fs.mkdirSync(projPath, { recursive: true }); fs.writeFileSync(path.join(projPath, "note.txt"), "no repo\n"); }
  const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({
    workspaceId: ws.id, projectId: project.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions",
  }) });
  await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: `Project ${name}` }) });
  return { project, projPath, chat };
}

// ── Background ──────────────────────────────────────────────────────────────────────────────────────────────────

test("background: two worktree runs under the project lock run at the same time, each in its own worktree as cwd with the rule; unchanged gone, changed stays with the completion notice; deleting cleans up", async () => {
  await withAgentsServer(async ({ base, ws, root, gate }) => {
    const { project, projPath, chat } = await projectChat(base, ws, root);
    const change = newWorkflow(ws, "Change", "CHANGE HALT:a", project.id);
    const read = newWorkflow(ws, "Read", "READ HALT:b", project.id);
    deliver(chat.id,
      `Both GS[a]:{"workflow":"change","input":"one","background":true,"worktree":true}§ GS[b]:{"workflow":"read","input":"two","background":true,"worktree":true}§`,
      announcement("ann-wt", [entry(change, "change"), entry(read, "read")]));
    const a = await toolResult(root, "a");
    const b = await toolResult(root, "b");
    // Both run - without a worktree the second would wait for the project lock of the first.
    assert.equal(a.start.state, "running", JSON.stringify(a.start));
    assert.equal(b.start.state, "running", JSON.stringify(b.start));
    assert.equal(a.start.worktree, true);
    await gate.reached("a");
    await gate.reached("b");
    const za = store.graphStart(a.start.startId);
    const zb = store.graphStart(b.start.startId);
    assert.ok(za.worktreePath && zb.worktreePath, "both carry their worktree");
    assert.notEqual(za.worktreePath, zb.worktreePath);
    assert.equal(a.start.worktreePath, za.worktreePath, "the path is in the view");
    const infoA = JSON.parse(za.worktreeInfo);
    assert.equal(infoA.branch, `cbase/graph-${za.id.slice(0, 8)}`);
    assert.equal(fs.readFileSync(path.join(za.worktreePath, ".env"), "utf8"), "SECRET=1\n", "the .env is copied");
    // The step ran IN the worktree, with the path rule.
    for (const [z, part] of [[za, "CHANGE"], [zb, "READ"]]) {
      const [step] = callsWith(root, part);
      assert.ok(step, `step ${part} called`);
      assert.equal(real(step.cwd), real(z.worktreePath), `${part}: cwd is the worktree`);
      assert.ok(step.sp.includes("# Own worktree"), `${part}: the rule is in the prompt`);
      assert.ok(step.sp.includes(`its own Git worktree: ${z.worktreePath} (branch cbase/graph-${z.id.slice(0, 8)}`), step.sp);
      assert.ok(step.sp.includes("Your working folder is this worktree."), `${part}: background sentence`);
      assert.ok(step.sp.includes(`The project folder ${projPath} is the main folder of other runs — read only.`), `${part}: main folder read only`);
      assert.ok(!step.sp.includes("Change files ONLY there."));
    }
    assert.ok(fs.existsSync(path.join(za.worktreePath, "fresh.txt")), "the CHANGE step wrote into its worktree");
    assert.ok(!fs.existsSync(path.join(projPath, "fresh.txt")), "not into the main folder");
    // The orchestrator itself has no rule (it drives no run).
    const [orch] = callsWith(root, "Both GS[a]");
    assert.ok(!orch.sp.includes("# Own worktree"));

    gate.open("a");
    gate.open("b");
    assert.equal((await runFinished(za.runId)).status, "done");
    assert.equal((await runFinished(zb.runId)).status, "done");
    // Unchanged: cleaned up, path empty, branch gone.
    await waitForTruthy(() => store.graphStart(zb.id).worktreePath === "" && !fs.existsSync(zb.worktreePath), "unchanged worktree cleaned up");
    assert.ok(!branches(projPath).includes(`cbase/graph-${zb.id.slice(0, 8)}`), "its branch is gone");
    // Changed: stays, the completion notice names it.
    const notice = await waitForTruthy(() => callsWith(root, `<task-id>${za.id}</task-id>`)[0] || null, "completion notice of the changed run");
    assert.match(notice.text, new RegExp(`Worktree with changes stays: ${za.worktreePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(branch cbase/graph-${za.id.slice(0, 8)}\\)`));
    assert.ok(fs.existsSync(za.worktreePath), "the changed worktree is still there");
    assert.equal(store.graphStart(za.id).worktreePath, za.worktreePath);
    const noticeB = await waitForTruthy(() => callsWith(root, `<task-id>${zb.id}</task-id>`)[0] || null, "completion notice of the unchanged run");
    assert.ok(!noticeB.text.includes("Worktree with changes"), "the cleaned-up one is not named");
    await waitForTruthy(() => !running.has(chat.id), "turn of the orchestrator finished");

    // Deleting cleans up with force - the changed one too.
    const way = await raw(`${base}/api/chats/${chat.id}`, "DELETE");
    assert.equal(way.status, 200, JSON.stringify(way.body));
    await waitForTruthy(() => !fs.existsSync(za.worktreePath) && !branches(projPath).includes(`cbase/graph-${za.id.slice(0, 8)}`), "worktree cleaned up on deleting");
  }, { claude });
});

// ── Foreground ──────────────────────────────────────────────────────────────────────────────────────────────────

test("foreground: cwd stays the workspace, --add-dir carries the worktree, the rule says \"ONLY there\"; unchanged gone, changed stays with a silent hint", async () => {
  await withAgentsServer(async ({ base, ws, root, gate }) => {
    const { project, projPath, chat } = await projectChat(base, ws, root);
    const front = newWorkflow(ws, "Front", "FRONT HALT:v", project.id);
    deliver(chat.id, `Go GS[v]:{"workflow":"front","input":"one","worktree":true}§`, announcement("ann-v", [entry(front, "front")]));
    const v = await toolResult(root, "v");
    assert.equal(v.start.state, "earmarked", "it is created only on redeeming");
    assert.equal(v.start.worktreePath, "");
    await gate.reached("v");
    const z = store.graphStart(v.start.startId);
    assert.equal(z.status, "started");
    assert.ok(z.worktreePath && fs.existsSync(z.worktreePath));
    const [step] = callsWith(root, "FRONT");
    assert.equal(real(step.cwd), real(path.join(root, "workspace")), "cwd stays the workspace");
    assert.ok(step.addDirs.includes(z.worktreePath), `--add-dir carries the worktree: ${JSON.stringify(step.addDirs)}`);
    assert.ok(step.sp.includes("Change files ONLY there."), step.sp);
    assert.ok(step.sp.includes(`The project folder ${projPath} is the main folder of other runs — read only.`));
    gate.open("v");
    assert.equal((await runFinished(z.runId)).status, "done");
    await waitForTruthy(() => store.graphStart(z.id).worktreePath === "" && !fs.existsSync(z.worktreePath), "unchanged worktree cleaned up");
    await waitForTruthy(() => !running.has(chat.id), "run chat free");
    // After the run: no rule, no --add-dir any more.
    deliver(chat.id, "Afterwards please", undefined);
    const afterwards = await waitForTruthy(() => callsWith(root, "Afterwards please")[0] || null, "turn afterwards");
    assert.ok(!afterwards.sp.includes("# Own worktree"));
    assert.ok(!afterwards.addDirs.includes(z.worktreePath));
    await waitForTruthy(() => !running.has(chat.id), "turn afterwards finished");

    // Second run that changes: the worktree stays, the chat gets a silent hint.
    const front2 = newWorkflow(ws, "Front Two", "FRONTTWO CHANGE", project.id);
    deliver(chat.id, `Another GS[w]:{"workflow":"front-two","input":"two","worktree":true}§`, announcement("ann-w", [entry(front2, "front-two")]));
    const w = await toolResult(root, "w");
    const z2 = await waitForTruthy(() => { const r = store.graphStart(w.start.startId); return r.runId ? r : null; }, "second run started");
    assert.equal((await runFinished(z2.runId)).status, "done");
    const hint = await waitForTruthy(() => store.openHints(chat.id).find((h) => h.text.includes("Der Worktree mit Änderungen bleibt:")) || null, "silent hint");
    assert.equal(hint.text, `Der Worktree mit Änderungen bleibt: ${z2.worktreePath} (Branch cbase/graph-${z2.id.slice(0, 8)}).`);
    assert.ok(fs.existsSync(path.join(z2.worktreePath, "fresh.txt")));
    assert.equal(store.graphStart(z2.id).worktreePath, z2.worktreePath, "the path stays in the view");
    await waitForTruthy(() => !running.has(chat.id), "run chat free");
  }, { claude });
});

// ── Refusals ──────────────────────────────────────────────────────────────────────────────────────────────────────

test("refusals: without a project 400 project, project without a repo 400 repo - nothing created", async () => {
  await withAgentsServer(async ({ base, ws, chat, root, gate }) => {
    const w = newWorkflow(ws, "Wt", "WT");
    deliver(chat.id, "Without GATE:o", announcement("ann-o", [entry(w, "wt")]));
    await gate.reached("o");
    const without = await start(base, chat.id, { workflow: "wt", worktree: true });
    assert.equal(without.status, 400, JSON.stringify(without.body));
    assert.equal(without.body.reason, "project");
    assert.equal(without.body.error, "Ein eigener Worktree braucht ein Projekt — dieser Chat hat keins. Starte ohne worktree.");
    gate.open("o");
    await waitForTruthy(() => !running.has(chat.id), "turn finished");

    const { project: withoutRepo, chat: pc } = await projectChat(base, ws, root, { name: "No Repo", repo: false });
    const wp = newWorkflow(ws, "Wt", "WT", withoutRepo.id);
    deliver(pc.id, "Repo GATE:r", announcement("ann-r", [entry(wp, "wt")]));
    await gate.reached("r");
    const no = await start(base, pc.id, { workflow: "wt", worktree: true, background: true });
    assert.equal(no.status, 400, JSON.stringify(no.body));
    assert.equal(no.body.reason, "repo");
    assert.equal(no.body.error, "Das Projekt „No Repo“ hat kein Git-Repository — ein eigener Worktree geht nur mit Repo.");
    assert.equal(store.graphStartsOf(chat.id).length + store.graphStartsOf(pc.id).length, 0, "no row, no child chat");
    gate.open("r");
    await waitForTruthy(() => !running.has(pc.id), "turn finished");
  }, { claude });
});
