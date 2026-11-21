// Every provider gets the project memory (CLAUDE.md / AGENTS.md) from the server, Claude included: with
// `--setting-sources user` the Claude CLI does not read the files itself. Also covered: the removed block "long-term
// memory" with MEMORY.md and /api/memory, and the CLI's own auto memory (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 in cleanClaudeEnv).
//
// Main seam via `withAgentsServer`: the fake main agent writes system prompt, --add-dir and the variable per call to prompts.jsonl.
//
// Counter-tests: against the state before the change, all three first tests turn red — no "# Project memory" in the Claude
// prompt, "Long-term memory" is in it, the variable is missing, /api/memory answers 200.
//
// The fourth case: a chat of a CONVERTED project works in the project folder — the workspace's instructions (database)
// carry there what its CLAUDE.md carried before.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { readJsonl } from "./jsonl.mjs";
import { deliverUserPrompt } from "../electron/server/runs/queue.js";
import * as store from "../electron/server/store.js";

const MAIN = `
  const sp = arg("--append-system-prompt");
  const addDirs = argv.flatMap((a, i) => (a === "--add-dir" ? [argv[i + 1]] : []));
  fs.appendFileSync(path.join(LOCATION, "prompts.jsonl"), JSON.stringify({ text, sp, addDirs, autoMemoryOff: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY || "" }) + "\\n");
  finished();
  say({ type: "result", result: "ok", session_id: "s-main" });`;

const claude = fakeClaude({ main: MAIN });
const callsWith = (root, part) => readJsonl(path.join(root, "prompts.jsonl")).filter((p) => String(p.text).includes(part));
const deliver = (chatId, text) => deliverUserPrompt(store.getChat(chatId), { prompt: text, display: text, cause: "user" });

async function call(root, part) {
  const [a] = await waitForTruthy(() => { const z = callsWith(root, part); return z.length ? z : null; }, `call ${part}`);
  return a;
}

// Nobody reads the CLAUDE.md of the workspace FOLDER any more — what applies to all agents of the workspace is its instructions
// in the database. The cases below hold both: the file is absent, the section is present. Counter-test against the old state:
// "WS-KIWI-11" was in the prompt, the instructions were missing.
const instruction = (ws, text, projectId = null) => store.createAgentSection({ id: `aw-${text}`, workspaceId: ws.id, projectId, title: "Rule", text, scope: "all", enabled: true });

test("Claude chat in the workspace: the workspace's instructions are in the system prompt (rebuilt per turn), the workspace folder's CLAUDE.md is not; no long-term memory, auto memory off", async () => {
  await withAgentsServer(async ({ chat, ws, root, waitForQuiet }) => {
    fs.writeFileSync(path.join(ws.path, "CLAUDE.md"), "Rule of the workspace: WS-KIWI-11\n");
    const a0 = instruction(ws, "AW-WS-31");
    deliver(chat.id, "WS-RUN");
    const a = await call(root, "WS-RUN");
    assert.ok(!a.sp.includes("WS-KIWI-11") && !a.sp.includes("# Project memory"), "the file in the workspace folder is not in the prompt");
    assert.ok(a.sp.includes("# User instructions") && a.sp.includes("AW-WS-31"), a.sp.slice(0, 600));
    // The system prompt is built per turn — a change applies from the next turn, and likewise the block is back after every
    // compaction (no separate path).
    await waitForQuiet();
    store.changeAgentSection(a0.id, { title: "Rule", text: "AW-WS-32", scope: "all", enabled: true }, a0.version);
    deliver(chat.id, "WS-RUN-2");
    const b = await call(root, "WS-RUN-2");
    assert.ok(b.sp.includes("AW-WS-32") && !b.sp.includes("AW-WS-31"), "the next turn carries the new state");
    assert.ok(!a.sp.includes("Long-term memory"), "the MEMORY.md block is gone");
    assert.ok(!a.sp.includes("its skills are available to you"), "the wrong sentence about the skills in the workspace folder is gone");
    assert.equal(a.autoMemoryOff, "1", "the CLI runs without its auto memory");
    assert.ok(!a.addDirs.some((d) => d.endsWith(`${path.sep}memory`)), `no memory folder as --add-dir: ${a.addDirs}`);
    await waitForQuiet();
  }, { claude });
});

test("Claude chat with a project: instructions of the workspace and the project, plus the project's AGENTS.md — not the workspace CLAUDE.md", async () => {
  await withAgentsServer(async ({ base, ws, root, waitForQuiet }) => {
    fs.writeFileSync(path.join(ws.path, "CLAUDE.md"), "Rule of the workspace: WS-KIWI-11\n");
    instruction(ws, "AW-WS-41");
    const projPath = path.join(ws.path, "till");
    const project = await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Checkout", path: projPath }) });
    fs.mkdirSync(projPath, { recursive: true });
    fs.writeFileSync(path.join(projPath, "AGENTS.md"), "Rule of the project: PROJ-MANGO-44\n");
    const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({
      workspaceId: ws.id, projectId: project.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions",
    }) });
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Project Checkout" }) });
    instruction(ws, "AW-PROJ-42", project.id);
    deliver(chat.id, "PROJ-RUN");
    const a = await call(root, "PROJ-RUN");
    assert.ok(!a.sp.includes("WS-KIWI-11"), "not the workspace file");
    assert.ok(a.sp.includes("AW-WS-41") && a.sp.includes("AW-PROJ-42") && a.sp.indexOf("AW-WS-41") < a.sp.indexOf("AW-PROJ-42"), "both levels, workspace first");
    assert.ok(a.sp.includes("PROJ-MANGO-44"), "project level");
    assert.ok(a.sp.indexOf("# Project focus") >= 0 && a.sp.indexOf("# Project memory") > a.sp.indexOf("# Project focus"), "after the project focus");
    await waitForQuiet();
  }, { claude });
});

test("/api/memory no longer exists", async () => {
  await withAgentsServer(async ({ base }) => {
    const res = await fetch(`${base}/api/memory`, { headers: { Connection: "close" } });
    await res.text();
    assert.equal(res.status, 404);
  }, { claude });
});

test("chat of a converted project in the project container — the workspace's instructions are in the prompt, the file in the workspace folder is not", async () => {
  const fd = await fakeDocker();
  const environment = {
    CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200",
    CLAUDE_CONFIG_DIR: path.join(fd.dir, "b-home", ".claude"), CODEX_HOME: path.join(fd.dir, "b-home", ".codex"),
  };
  const saved = Object.fromEntries(Object.keys(environment).map((k) => [k, process.env[k]]));
  try {
    Object.assign(process.env, environment);
    await withAgentsServer(async ({ base, ws, root, waitForQuiet, projectWithoutInstance }) => {
      fs.writeFileSync(path.join(ws.path, "CLAUDE.md"), "Rule of the workspace: WS-KIWI-11\n");
      instruction(ws, "AW-WS-51");
      const projPath = path.join(ws.path, "till");
      fs.mkdirSync(projPath, { recursive: true });
      const project = await projectWithoutInstance({ name: "Checkout", path: projPath });
      const name = `cbase-p-${project.id}`;
      execFileSync(fd.bin, ["run", "-d", "--name", name, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
      store.createProjectInstance({ projectId: project.id, state: "ready", convertedAt: Date.now(), containerId: name });
      const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({
        workspaceId: ws.id, projectId: project.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions",
      }) });
      await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Project Checkout" }) });
      deliver(chat.id, "UMG-RUN");
      const a = await call(root, "UMG-RUN");
      assert.ok(fd.calls({ daemon: "host" }).some((x) => x.args[0] === "exec" && x.args.includes(name)), "the run ran in the project container");
      assert.ok(a.sp.includes("AW-WS-51"), "the workspace's instructions are in the prompt although cwd is the project folder");
      assert.ok(!a.sp.includes("WS-KIWI-11"), "not the file in the workspace folder");
      assert.ok(!a.addDirs.includes(ws.path), "the workspace is no --add-dir");
      await waitForQuiet();
    }, { claude });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fd.cleanUp();
  }
});
