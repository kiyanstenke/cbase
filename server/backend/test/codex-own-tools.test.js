// Codex' OWN goal and question tools are off in EVERY cbase Codex run (connectors/codex.js CODEX_WITHOUT_OWN_TOOLS).
// The two toggles used to apply only to runs without file access (outer loop without choice, sealed oneshots); a
// coding chat, its continuation, a subagent and a workflow agent still got `create_goal`/`get_goal`/`update_goal` and
// `request_user_input` offered (about 3,000 characters per request) - although cbase keeps goals itself (`/goal`
// locally, verdict as its own oneshot) and asks through `cbase_ask`, and `request_user_input` in `codex exec` only
// answers "unavailable in Default mode" anyway. Measured on 0.162.1 against the
// real CLI: `--disable goals` removes the goal tools, `-c tools.experimental_request_user_input.enabled=false`
// removes `request_user_input` from the whole request, also with `exec resume`. In the shape of a coding chat (shell
// on, every sandbox mode, `exec resume`, continuation of a thread with an active goal) re-measured on 0.162.1 and
// 0.153.1 (sp9-codex-chat-own-tools.cjs) - result in the head of CODEX_WITHOUT_OWN_TOOLS.
//
// Codex' own skill, plugin and app catalog belongs to it as well (`--disable plugins`, `--disable apps`,
// `-c skills.include_instructions=false`, measured against the real CLI), and the file
// holds two neighbors of the same check "what Codex really gets": images (`caps.vision`, `-i` on the oneshot, no
// CBASE_VISION at the cbase server; bv1-codex-mcp-image.cjs) and the tool list of a Codex subagent
// (providers/codex-builtins.js).
//
// This file holds:
//   (1) the two argument builders - chat (new, continuation before `resume`, fork, every mode, outer loop without
//       choice) and oneshot (ordinary and sealed): all toggles, EXACTLY once, before `resume`, nothing behind; plus
//       the steps of the tool list of a Codex subagent and the same steps in the description of cbase_agent `tools`;
//   (2) at the spawn through the real server, the real core and the real spec factory (only the CLIs are fake): a
//       Codex chat with continuation (without CBASE_VISION), Codex subagents of a Claude chat - without list,
//       [Read, Grep, Glob] (read-only), only a cbase tool (without shell), with Bash (like the client) - and a Codex
//       oneshot (`runOnceCodex`, with images as `-i`).
// The outer loop (with and without choice) stands at the spawn in outerloop-codex.test.js, a workflow agent goes
// through the same spec factory (runs/agents.js) and the same builder as the subagent here.
//
// The expectations stand LITERALLY, not via the constant: a test that reads the constant would stay green if someone
// emptied it.
//
// Counter-tests:
//   connectors/codex.js buildCodexChatArgs with the old line `if (spec.codexWithoutFileAccess) args.push(...CODEX_WITHOUT_FILE_ACCESS);`
//     => (1) red (chat, continuation, fork) and (2) red (chat, continuation, subagent)
//   buildCodexOnceArgs with the old line `if (withoutTools) args.push(...CODEX_WITHOUT_FILE_ACCESS);`  => (1) and (2) red (oneshot)
//   both builders with `args.push(...CODEX_WITHOUT_OWN_TOOLS)` AND the old `if (...) args.push(...CODEX_WITHOUT_FILE_ACCESS)`
//     => (1) red and (2) runOnceCodex red (sealed: the toggles stand twice)
//   CODEX_WITHOUT_OWN_TOOLS without the three skill/plugin/app toggles          => (1) chat and oneshot builder, (2) both red
//   providers/index.js Codex `vision: false` (the old state)                       => (2) chat ("no CBASE_VISION") and runOnceCodex red
//   runs/agents.js codexCut always `{ permissionMode }` (the old state)         => (2) "[Read, Grep, Glob]: ... read-only" red
//   runOnceCodex without `images` to buildCodexOnceArgs (images silently dropped)        => (2) runOnceCodex "the bytes of the images" red
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/codex-own-tools.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCodexChatArgs, buildCodexOnceArgs, runOnceCodex } from "../electron/server/providers/connectors/codex.js";
import { PROVIDERS, materialCapabilities } from "../electron/server/providers/index.js";
import { codexIntersectionOfTheBuiltins } from "../electron/server/providers/codex-builtins.js";
import { fakeClaude, fakeCodex, withAgentsServer } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";

const TARGETS = ["--disable", "goals"];
const QUESTION = ["-c", "tools.experimental_request_user_input.enabled=false"];
// Codex' own skill, plugin and app catalog (measured on 0.162.1).
const PLUGINS = ["--disable", "plugins"];
const APPS = ["--disable", "apps"];
const SKILLS = ["-c", "skills.include_instructions=false"];
const FILE = ["--disable", "shell_tool", "--disable", "unified_exec", "--disable", "view_image"];

const places = (argv, followUp) => argv.flatMap((_, i) => (followUp.every((x, j) => argv[i + j] === x) ? [i] : []));

/** All toggles exactly once, all before `resume` (exec flags), no toggle behind `resume <thread>`. */
function checkToggle(argv, what) {
  for (const [name, followUp] of [["--disable goals", TARGETS], ["request_user_input", QUESTION], ["--disable plugins", PLUGINS], ["--disable apps", APPS], ["skills.include_instructions", SKILLS]]) {
    const s = places(argv, followUp);
    assert.equal(s.length, 1, `${what}: ${name} stands ${s.length} times in argv - ${argv.slice(0, 40).join(" ")}`);
    const r = argv.indexOf("resume");
    if (r >= 0) assert.ok(s[0] < r, `${what}: ${name} stands behind resume (an exec flag belongs before it)`);
  }
  assert.equal(argv.filter((a) => a === "goals").length, 1, `${what}: "goals" twice`);
}

// ── (1) The builders ───────────────────────────────────────────────────────────────────────────────────────────────────────────
test("(1) chat builder: every Codex chat run switches off Codex' goal and question tools - new, continuation, fork, every mode, outer loop", () => {
  const cases = [
    ["Chat bypass", { permissionMode: "bypassPermissions", model: "gpt-5.6-sol", effort: "high" }],
    ["Chat acceptEdits", { permissionMode: "acceptEdits" }],
    ["Chat plan", { permissionMode: "plan" }],
    ["Chat default", { permissionMode: "default" }],
    ["Continuation", { permissionMode: "bypassPermissions", sessionId: "thread-1" }],
    ["Fork (fresh thread)", { permissionMode: "plan", sessionId: "thread-1", forkPending: true }],
    ["Outer loop without choice", { permissionMode: "acceptEdits", codexWithoutFileAccess: true }],
    ["Outer loop without choice, continuation", { permissionMode: "acceptEdits", codexWithoutFileAccess: true, sessionId: "thread-2" }],
  ];
  for (const [what, spec] of cases) checkToggle(buildCodexChatArgs({ cwd: "/tmp/x", ...spec }), what);
  // The continuation: `resume <thread>` is the end, no toggle behind it.
  const gone = buildCodexChatArgs({ cwd: "/tmp/x", permissionMode: "bypassPermissions", sessionId: "thread-1" });
  assert.deepEqual(gone.slice(gone.indexOf("resume")), ["resume", "thread-1"]);
  // A coding chat keeps its shell - only the outer loop without choice loses it (the full cut, see CODEX_WITHOUT_FILE_ACCESS).
  assert.equal(places(buildCodexChatArgs({ cwd: "/tmp/x", permissionMode: "default" }), FILE).length, 0, "a coding chat without the file toggles");
  assert.equal(places(buildCodexChatArgs({ cwd: "/tmp/x", permissionMode: "acceptEdits", codexWithoutFileAccess: true }), FILE).length, 1, "outer loop without choice: file toggles exactly once");
});

test("(1) oneshot builder: ordinary and sealed - both toggles exactly once, the prompt stays the last word", () => {
  for (const [what, form] of [
    ["Oneshot", { prompt: "Title please", outFile: "/tmp/o.txt" }],
    ["Oneshot with model and cwd", { prompt: "Title please", outFile: "/tmp/o.txt", model: "gpt-5.6-sol", cwd: "/tmp/x", effort: "low" }],
    ["Oneshot sealed", { prompt: "Title please", outFile: "/tmp/o.txt", withoutTools: true }],
  ]) {
    const argv = buildCodexOnceArgs(form);
    checkToggle(argv, what);
    assert.equal(argv.at(-1), "Title please", `${what}: the prompt is the last positional`);
    assert.equal(places(argv, FILE).length, form.withoutTools ? 1 : 0, `${what}: file toggles only when sealed`);
  }
});

test("(1) tool list of a Codex subagent: the steps - and the description of cbase_agent says the same", async () => {
  // Execution side (providers/codex-builtins.js).
  assert.deepEqual(codexIntersectionOfTheBuiltins(null, "bypassPermissions"), { permissionMode: "bypassPermissions" }, "without a list: nothing cut");
  assert.deepEqual(codexIntersectionOfTheBuiltins([], "bypassPermissions"), { codexWithoutFileAccess: true, permissionMode: "default" });
  assert.deepEqual(codexIntersectionOfTheBuiltins(["Read", "Grep", "Glob"], "acceptEdits"), { permissionMode: "default" });
  assert.deepEqual(codexIntersectionOfTheBuiltins(["Read"], "plan"), { permissionMode: "plan" }, "an already read-only mode stays");
  for (const n of ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]) {
    assert.deepEqual(codexIntersectionOfTheBuiltins(["Read", n], "acceptEdits"), { permissionMode: "acceptEdits" }, `${n}: like the client`);
  }
  // Description side (mcp/tools/agents.js, field `tools`): it names Codex' steps and the writing names.
  const { agentTools } = await import("../electron/mcp/tools/agents.js");
  const cbaseAgent = agentTools.find((t) => t.name === "cbase_agent");
  const schema = typeof cbaseAgent.inputSchema === "function" ? cbaseAgent.inputSchema() : cbaseAgent.inputSchema;
  const text = schema.properties.tools.description;
  assert.match(text, /Codex knows no individual built-in tools/);
  assert.match(text, /without built-in names in the list no shell and no file access/);
  assert.match(text, /read-only sandbox/);
  for (const n of ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]) assert.ok(text.includes(n), `the description names ${n}`);
});

// ── (2) At the spawn ────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

// The Claude main run starts Codex subagents through cbase_agent - one without a tool list and three with a list:
// only read-only built-ins, no built-ins, Bash - and waits for each report.
const MAIN = `
  if (text.includes("CX-START")) {
    const jobs = [
      { prompt: "SUB-CODEX" },
      { prompt: "SUB-READ", tools: ["Read", "Grep", "Glob"] },
      { prompt: "SUB-WITHOUT", tools: ["cbase_projects_list"] },
      { prompt: "SUB-BASH", tools: ["Read", "Bash"] },
    ];
    let k = 0;
    for (const job of jobs) {
      const a = { description: "codex", model: "codex::gpt-5.6-sol", run_in_background: false, ...job };
      const id = "toolu_cx_" + k++;
      say({ type: "assistant", message: { id: "cx-" + id, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_agent", input: a }] } });
      let r = "";
      try { r = textOf(await mcpCall("cbase_agent", a)); } catch (e) { r = "ERROR " + e.message; }
      fs.appendFileSync(path.join(LOCATION, "cx-reports"), JSON.stringify(r) + "\\n");
      say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: r }] } });
    }
    fs.writeFileSync(path.join(LOCATION, "cx-report"), "finished");
  }
  say({ type: "assistant", message: { id: "cx-end-" + Date.now(), content: [{ type: "text", text: "ok" }] } });
  finished();
  say({ type: "result", result: "ok", session_id: "cx-main" });`;
// The harness fake Codex, which appends every argv.
const CODEX = fakeCodex({ text: "Codex finding 42" })
  .replace("const say =", "fs.appendFileSync(path.join(LOCATION, \"cx-codex-argv.jsonl\"), JSON.stringify(process.argv.slice(2)) + \"\\n\");\nconst say =");

test("(2) at the spawn: Codex chat and its continuation, a Codex subagent and a Codex oneshot carry both toggles exactly once", async () => {
  // CODEX_HOME in a throwaway folder: the server reads rollouts (codex-prefix.js) never in the user's real home.
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-codex-own-home-"));
  try {
    await withEnvironment({ CODEX_HOME: codexHome }, () => withAgentsServer(async ({ base, ws, chat, root, waitForTruthy, waitForLog, waitForQuiet }) => {
      const json = async (url, opts = {}) => (await fetch(url, { ...opts, headers: { "Content-Type": "application/json", Connection: "close" } })).json();
      const argvs = () => (fs.existsSync(path.join(root, "cx-codex-argv.jsonl")) ? readJsonl(path.join(root, "cx-codex-argv.jsonl")) : []);
      const prompt = (argv) => String(argv[argv.length - 1]);

      // Codex chat: two turns - the second continues the thread of the first.
      const c = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "codex", model: "gpt-5.6-sol", permissionMode: "bypassPermissions" }) });
      await json(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ title: "Codex toggles" }) });
      for (const [n, text] of [[1, "CX-ONE"], [2, "CX-TWO"]]) {
        await json(`${base}/api/chats/${c.id}/message`, { method: "POST", body: JSON.stringify({ text }) });
        await waitForLog(c.id, (log) => log.filter((m) => m.role === "assistant").length >= n);
        await waitForQuiet();
      }
      const one = argvs().find((a) => prompt(a).includes("CX-ONE"));
      const two = argvs().find((a) => prompt(a).includes("CX-TWO"));
      assert.ok(one && two, `both turns of the Codex chat spawned (${argvs().length} Aufrufe)`);
      assert.equal(one.includes("resume"), false, "the first turn starts a thread");
      assert.ok(two.includes("resume"), "the second turn continues it");
      checkToggle(one, "Codex chat, first turn");
      checkToggle(two, "Codex chat, continuation");
      // Codex sees images (caps.vision): the cbase server of a Codex run NO longer answers "cannot see images".
      for (const [what, a] of [["Chat", one], ["Continuation", two]]) assert.ok(!a.some((x) => /CBASE_VISION/.test(x)), `${what}: no CBASE_VISION in argv (Codex sees images)`);

      // Codex subagents of a Claude chat (real core, real spec factory).
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "CX-START" }) });
      await waitForTruthy(() => fs.existsSync(path.join(root, "cx-report")), "Codex subagents report");
      await waitForQuiet();
      for (const r of readJsonl(path.join(root, "cx-reports"))) assert.doesNotMatch(String(r), /FEHLER|"status": ?"failed"/);
      const subOf = (marker) => { const a = argvs().find((x) => prompt(x).includes(marker)); assert.ok(a, `${marker} ran through the Codex CLI`); return a; };
      const sub = subOf("SUB-CODEX");
      checkToggle(sub, "Codex subagent");
      assert.equal(places(sub, FILE).length, 0, "a subagent keeps its shell");
      assert.ok(!sub.some((x) => /CBASE_VISION/.test(x)), "subagent: no CBASE_VISION");
      // The tool list of a Codex subagent (providers/codex-builtins.js): Codex cuts in steps.
      const sandbox = (a) => (a.includes("--dangerously-bypass-approvals-and-sandbox") ? "bypass" : a[a.indexOf("-s") + 1]);
      assert.equal(sandbox(sub), "bypass", "without a list: the mode of the client");
      const read = subOf("SUB-READ");
      checkToggle(read, "Codex subagent read-only");
      assert.deepEqual([sandbox(read), places(read, FILE).length], ["read-only", 0], "[Read, Grep, Glob]: shell stays, sandbox read-only");
      const without = subOf("SUB-WITHOUT");
      checkToggle(without, "Codex subagent without built-ins");
      assert.deepEqual([sandbox(without), places(without, FILE).length], ["read-only", 1], "only a cbase tool: without shell and view_image, read-only");
      const bash = subOf("SUB-BASH");
      checkToggle(bash, "Codex subagent with Bash");
      assert.deepEqual([sandbox(bash), places(bash, FILE).length], ["bypass", 0], "with Bash: like the client");
    }, { claude: fakeClaude({ main: MAIN }), codex: CODEX }));
  } finally { fs.rmSync(codexHome, { recursive: true, force: true }); }
});

test("(2) at the spawn: runOnceCodex - ordinary and sealed", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-codex-own-once-"));
  const log = path.join(dir, "argv.jsonl");
  const codexFake = path.join(dir, "codex");
  fs.writeFileSync(codexFake, `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
// The images behind \`-i\`: their content, read while the call runs (afterwards runOnceCodex clears the folder).
argv.forEach((a, i) => { if (a === "-i") fs.appendFileSync(${JSON.stringify(log)} + ".images", JSON.stringify({ path: argv[i + 1], b64: fs.readFileSync(argv[i + 1]).toString("base64") }) + "\\n"); });
const o = argv.indexOf("-o");
if (o >= 0) fs.writeFileSync(argv[o + 1], "ok");
`, { mode: 0o755 });
  const saved = { bin: process.env.CODEX_BIN, home: process.env.CODEX_HOME };
  process.env.CODEX_BIN = codexFake;
  process.env.CODEX_HOME = path.join(dir, "codex-home");
  t.after(() => {
    for (const [k, v] of [["CODEX_BIN", saved.bin], ["CODEX_HOME", saved.home]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.warn(`[test] cleanup: ${e.message}`); }
  });
  assert.equal(await runOnceCodex("Say ok.", { cwd: dir, model: "gpt-5.6-sol" }), "ok");
  assert.equal(await runOnceCodex("Say ok, sealed.", { cwd: dir, model: "gpt-5.6-sol", withoutTools: true }), "ok");
  // Images (caps.vision): per image `-i <file>` with exactly these bytes, before a flag (never before the prompt);
  // afterwards the folder is gone. The way through the registry passes them on only because Codex carries
  // `caps.vision` (providers/index.js runOnce).
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
  assert.equal(await runOnceCodex("What does the image show?", { cwd: dir, model: "gpt-5.6-sol", images: [{ mime: "image/png", dataB64: PNG }, { mime: "image/jpeg", dataB64: "/9j/AA==" }] }), "ok");
  const [ordinary, sandboxed, withImages] = readJsonl(log);
  checkToggle(ordinary, "Oneshot");
  checkToggle(sandboxed, "Oneshot sealed");
  checkToggle(withImages, "Oneshot with images");
  assert.equal(places(ordinary, FILE).length, 0);
  assert.equal(places(sandboxed, FILE).length, 1);
  assert.equal(ordinary.includes("-i"), false, "without images no -i");
  const images = readJsonl(`${log}.images`);
  assert.deepEqual(images.map((b) => b.b64), [PNG, "/9j/AA=="], "the bytes of the images, in order");
  assert.deepEqual(images.map((b) => path.extname(b.path)), [".png", ".jpg"]);
  for (const b of images) assert.match(withImages[withImages.indexOf(b.path) + 1], /^-/, "behind each image path a flag, not the prompt");
  assert.equal(withImages.at(-1), "What does the image show?");
  assert.ok(images.every((b) => !fs.existsSync(path.dirname(b.path))), "the image folder is gone after the call");
  assert.equal(PROVIDERS.codex.caps.vision, true, "Codex carries caps.vision");
  assert.equal(materialCapabilities("codex::gpt-5.6-sol").images, true);
  assert.equal(materialCapabilities("codex::gpt-5.6-sol").documents, false, "a PDF is not accepted by -i");
});
