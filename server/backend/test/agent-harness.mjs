// The agent harness: ONE tool for the main seam of the dynamic workflows — real server, real cbase MCP server, real
// routes; only the providers are faked.
//
// WHAT IT PROVIDES
//   withAgentsServer(fn, opts)  a server on a FREE, REAL port (port 0 would break BASE_URL: the MCP config would say
//                               "…:0" and every MCP→server call would fail), a workspace, a Claude chat with a title
//                               (no title oneshot), and in `ctx`:
//     base, port, chat, ws, dataRoot, root
//     waitForTruthy(check, label)  wait for an EVENT (state, count) — WITHOUT a deadline. If it hangs, the ripcord of the
//                               fake CLI (ripcord.mjs) or the suite deadline takes over; there is no clock here that
//                               turns a test red.
//     waitForLog(chatId, p)    the same for the history of a chat
//     waitForIdle()            the same for `/api/runs/active` (busy:false, runs:0, no dynamic workflow)
//     waitForQuiet(opts)       (quiet.mjs) QUIET: the server does nothing on its own any more — `quiet` from /api/runs/active
//                               (runs, agents, workflows, verdicts, queue, compaction, goal gate, hooks, oneshots,
//                               archive); no deadline.
//     barrier(reader, target)  (quiet.mjs) the stream barrier: a marker into the stream `target` (default: the chat of the
//                               test; GLOBAL for /api/events), wait until `reader` (its events array or an object with
//                               `events`) has it — afterwards it has everything the server wrote until then. Returns the
//                               position behind the marker, the safe cut. With opts.childProcess the server process writes the
//                               marker itself (IPC channel of agent-server-child.mjs).
//     gate.reached(name)       waits until a fake stands at its gate (it holds there)
//     gate.open(name)          releases it — instead of waiting out a duration
//     restart({ withBackground, instancesReady })
//                              ends the server and restarts it on the SAME data folder and port (chats, history, third-party
//                              providers come from the database). TRAP (project containers): startServer sets every converted
//                              instance to `start` BEFORE listening, only the follow-up start (the recovery) brings it to
//                              `ready` — and the harness switches the follow-up timer off (CBASE_RESTART_GRACE_MS = 24 h). A turn
//                              in a converted project would then wait at the lock forever. Hence `instancesReady: true`:
//                              after the start every converted row in `start` goes to `ready` through the store — in-process
//                              only (with opts.childProcess it throws; there the test does not share the module state).
//                              `withBackground`: a parked or living background agent is open work (busy) — then it only waits until no
//                              turn runs any more, and the restart hits it.
//     crash()                  ONLY with opts.childProcess: SIGKILL to the server process with its group, all fakes ended hard, then a new
//                              server process on the SAME data folder and port — with CBASE_RESTART_GRACE_MS=0, so the follow-up
//                              start (orphans, resumption) runs at once.
//     signal(sig)              ONLY with opts.childProcess: a signal to the server process, `{ ended, alive() }`
//     wakeParked()             ONLY with opts.childProcess: wakeParkedNow in the server process (SIGUSR2)
//     db()                     ONLY with opts.childProcess: a read connection to the database of the server process (the test does not
//                              share its module state); `db().close()` belongs in the finally
//     token(projectId, instance)  ONLY with opts.childProcess: the fence token of an instance from the memory of the server process
//                              (IPC channel of agent-server-child.mjs; projectbox/token.js)
//     projectWithoutInstance({ name, path })  a project WITHOUT an instance row in the workspace of the test, directly through
//                              the store (folder created, no services scan). In operation `POST …/projects` creates a project
//                              WITH an instance row; whoever needs a project without one in operation takes this way, never
//                              the route. With opts.childProcess over IPC. Without ctx: `projectWithoutInstance({ workspaceId, name,
//                              path })` (exported, synchronous).
//     childPid                  ONLY with opts.childProcess: the pid of the server process (leader of its process group)
//     engine                   { id, model, requests, query } of the fake OpenRouter endpoint (opts.engine) — `id` is always
//                              "openrouter", `model` "openrouter::m1", `query` the GET requests (/models, /key, /generation?id=…)
//   fakeClaude({ main, sub, oneshot })  fake Claude (stream-json). It calls MCP tools through the REAL MCP configuration of its
//                              run (`mcpCall`) — so the cbase MCP server and with it the real agent core. `main`/`sub` are the
//                              bodies of the two roles (main agent / subagent, recognised by the subagent system prompt like a
//                              real model); in the body `say`, `mcpCall`, `mcpTools` (tools/list minus --disallowedTools),
//                              `textOf`, `gate`, `arg`, `argv`, `text`, `turn`, `finished()` are available. A name in
//                              --disallowedTools is no tool, as with the real CLI. A workflow agent (frame "WORKFLOW AGENT of
//                              cbase") also runs in the body `sub`; `isWorkflowAgent` says which one it is.
//                              `eingebauteTools()`: the built-in tools of the run — those of the CLI minus --disallowedTools,
//                              trimmed by --tools.
//                              `oneshot` (optional): body for one-time calls without --input-format (verdicts of the workflow
//                              gates, titles) — there `prompt` and `respond(text)` are available.
//                              Sessions like the real CLI: ONLY when CLAUDE_CONFIG_DIR lies in the throwaway folder, it writes
//                              <CCD>/projects/<slug(cwd)>/<sid>.jsonl per session_id, and a --resume without a file in this home
//                              ends like the real CLI ("No conversation found with session ID: …", exit 1, no result) —
//                              otherwise (all other tests) as before.
//                              Background tasks and control requests (CLI 2.1.296): in the body `backgroundBash(id, description)`
//                              starts a command without end; `control_request` `stop_task` is answered at once like the real
//                              CLI (<LOCATION>/control.jsonl), and if stdin closes with an open task, it runs a follow-up turn
//                              "FOLLOW-UP-TURN" like the CLI from 2.1.292 on (<LOCATION>/follow-up-turn.jsonl).
//                              `backgroundEnds(id)`: the command ends in the last model request — after the result it runs the
//                              notice turn "NOTICE-TURN" like the CLI (2.1.280 and 2.1.296) (<LOCATION>/notice-turn.jsonl),
//                              whether stdin is open or closed.
//   fakeCodex({ text })         fake Codex: `exec --json` and `exec … resume <id>` with the measured event vocabulary
//                              (thread.started, turn.started, item.completed/agent_message, turn.completed). With CODEX_HOME in
//                              the throwaway folder it writes the rollout to sessions/YYYY/MM/DD/, and a resume without a rollout
//                              ends with "no rollout found for thread id …", exit 1, without a JSON event.
//   opts.engine                 a fake OpenRouter endpoint (SSE) for the loop engine, as `({ text, round, tool })` — round/tool:
//                              tool calls or an HTTP error, see startPresetEndpoint; `round` may return a promise and `{ text }`
//                              instead of tool calls — or `{ thinking }`: the answer ONLY in the thinking channel
//                              (`reasoning_content`, `content` empty) — or `{ text, cutoff: true }`: the stream breaks off after
//                              the first chunk, without a usage chunk. There are no free providers any more: the endpoint starts
//                              BEFORE the server, `CBASE_OPENROUTER_BASE` points at it (the test seam of the built-in OpenRouter),
//                              it also answers `GET /models` (a small catalog: m1 with tools and images, `without-tools` without),
//                              `GET /key`, `GET /generation?id=` and `GET /models/<id>/endpoints`; the key comes through PUT
//                              /api/openrouter, and the harness waits until the catalog is loaded and stores m1 as the default
//                              model (without a stored one there is none). Model `openrouter::m1`.
//   All three run at the same time in one server.
//   opts.childProcess                   the server runs as its own PROCESS (agent-server-child.mjs) instead of in the test process — for a
//                              hard restart (crash). Everything else goes over HTTP there anyway.
//
// THE FINALLY (every line stems from a failure)
//   - open runs stopped — the run state is MODULE state, shared by all servers of the process; an open run would otherwise run
//     into the next test;
//   - an error in the body stays THE reported error: after a failure `tidyUp` (quiet.mjs) stops everything active and waits for
//     quiet without a deadline, without ever throwing (a throw there once overwrote the real error with "run did not finish");
//     the error is on stderr beforehand;
//   - our own children and grandchildren ended hard: all descendants of this process (ps), plus every fake that registered under
//     `pids/` and the process group of every MCP child that a fake starts (`detached`) — whoever kills only the child waits for a
//     grandchild;
//   - `closeAllConnections` BEFORE `server.close` — otherwise close waits for every open reader.
//
// Nothing here is macOS-bound (`ps -A -o pid=,ppid=` exists on Linux as on the Mac).
//
// USED BY: about 70 test files (count with `grep -l 'from "./agent-harness.mjs"' server/backend/test/*.test.js`) plus its own
// proof agent-harness.test.js. A `.test.js` NEVER imports another — hence `.mjs`.
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";
import { RIPCORD } from "./ripcord.mjs";
import { tidyUp, streamBarrier, waitRow, waitForQuiet } from "./quiet.mjs";

// Placeholder for the folder of the test — the fakes are standalone scripts and cannot import anything; the path is
// inserted when writing. Also exported for own fakes of the test files (`${JSON.stringify(LOCATION)}`).
export const LOCATION = "__CBASE_AGENT_HARNESS_LOCATION__";
// Inserts the throwaway folder into a fake script (exported so a connector test without a server can write the fake itself,
// background-end.test.js).
export const setLocation = (script, root) => script.split(JSON.stringify(LOCATION)).join(JSON.stringify(root));

// A project WITHOUT an instance row, directly through the store. In operation `POST /api/workspaces/:id/projects` creates the
// project WITH an instance row and starts its setup — a test that needs a project in operation in B (legacy, relocation,
// "without instance row") therefore creates it here, never through the route. The same fields as the route (folder created,
// `path.resolve`, name otherwise the folder name), but WITHOUT the services scan of the route — no test needs it. Returns the
// project row of the store (like the route answer: `id`, `name`, `path`, …). In the test process directly; with opts.childProcess
// through `ctx.projectWithoutInstance` (IPC, agent-server-child.mjs calls THIS function).
export function projectWithoutInstance({ workspaceId, name = "", path: filePath } = {}) {
  if (!workspaceId || !filePath) throw new Error("projectWithoutInstance: workspaceId and path are required");
  const target = path.resolve(String(filePath));
  fs.mkdirSync(target, { recursive: true });
  return store.addProject(String(workspaceId), { id: crypto.randomUUID(), name: String(name || "").trim() || path.basename(target), path: target, createdAt: Date.now() });
}

// `Connection: close`: no connection from the pool. After a restart the fetch pool still holds the socket to the OLD server
// (closeAllConnections tore it down), and the next request on it ends in ECONNRESET ("fetch failed").
export async function json(url, init) {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init?.headers || {}) } });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Wait for an event, without a deadline. `label` is the caption for the hang case: every 30 s it goes to stderr (quiet.mjs
// waitRow) — if the suite deadline breaks, the log shows what the test was waiting for.
export async function waitForTruthy(check, what = "") {
  const closed = what ? waitRow(what) : () => {};
  try {
    for (;;) {
      const got = await check();
      if (got) return got;
      await pause(25);
    }
  } finally { closed(); }
}

// ── Fake-Claude ─────────────────────────────────────────────────────────────────────────────────
export const fakeClaude = ({ main = "finished(); say({ type: \"result\", result: \"fertig\", session_id: \"main-session\" });", sub = "finished(); say({ type: \"result\", result: \"sub\", session_id: \"sub-session\" });", oneshot = "" } = {}) => `#!/usr/bin/env node
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const LOCATION = ${JSON.stringify(LOCATION)};
// Atomic: a test often waits only for the EXISTENCE of a file and then reads it — without the rename it read an empty one
// under load. pids/ and gates/ are enumerated and stay raw, as do calls with options.
{ const raw = fs.writeFileSync; fs.writeFileSync = (p, d, o) => { if (typeof p !== "string" || o !== undefined || p.split(path.sep).some((s) => s === "pids" || s === "gates")) return raw(p, d, o); const t = path.join(path.dirname(p), "." + path.basename(p) + ".teil-" + process.pid); raw(t, d); fs.renameSync(t, p); }; }
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "claude"); } catch {}
// Like the real CLI (2.1.280): every tools/call carries the tool_use id of its block in _meta. The blocks of a tool are
// executed in the order in which they stand in the stream.
const openCalls = {};
const say = (o) => {
  if (o && o.type === "assistant" && !o.parent_tool_use_id) {
    for (const b of (o.message && o.message.content) || []) {
      if (b && b.type === "tool_use" && String(b.name).startsWith("mcp__cbase__")) (openCalls[b.name] = openCalls[b.name] || []).push(b.id);
    }
  }
  if (o && o.session_id) { lastSession = String(o.session_id); writeSession(lastSession, o.type); }
  console.log(JSON.stringify(o));
};
let lastSession = "";
${RIPCORD}
const argv = process.argv.slice(2);
const joined = argv.join(" ");
const arg = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : "");
// Sessions like the real CLI (measured at 2.1.280) — ONLY if CLAUDE_CONFIG_DIR lies in the throwaway folder of the test
// (otherwise the fake would write into a real home, and the other tests would run without session files as before): every
// line with session_id lands in <CLAUDE_CONFIG_DIR>/projects/<slug(cwd)>/<sid>.jsonl, a --resume keeps writing in the found
// file (the one in the slug of the cwd wins), and a session that lies nowhere in this home ends like the real CLI: stderr
// and errors "No conversation found with session ID: <sid>", exit 1, no result, no init.
const CCD = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : "";
const withSessions = Boolean(CCD) && (CCD === LOCATION || CCD.startsWith(LOCATION + path.sep));
// Over 200 characters the CLI shortens and appends the Java hashCode of the path (2.1.280).
const ownSlug = ((c) => { const s = c.replace(/[^A-Za-z0-9]/g, "-"); if (s.length <= 200) return s; let h = 0; for (let i = 0; i < c.length; i++) h = ((h << 5) - h + c.charCodeAt(i)) | 0; return s.slice(0, 200) + "-" + Math.abs(h).toString(36); })(process.cwd());
function findSession(sid) {
  const root = path.join(CCD, "projects");
  let slugs = []; try { slugs = fs.readdirSync(root); } catch {}
  const hits = slugs.map((s) => path.join(root, s, sid + ".jsonl")).filter((p) => fs.existsSync(p));
  return hits.find((p) => path.basename(path.dirname(p)) === ownSlug) || hits[0] || null;
}
let sessionFile = null;
function writeSession(sid, kind) {
  if (!withSessions) return;
  const file = sessionFile && path.basename(sessionFile) === sid + ".jsonl" ? sessionFile : path.join(CCD, "projects", ownSlug, sid + ".jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ type: kind, sessionId: sid, cwd: process.cwd() }) + "\\n");
}
if (withSessions && arg("--resume")) {
  sessionFile = findSession(arg("--resume"));
  if (!sessionFile) {
    const word = "No conversation found with session ID: " + arg("--resume");
    process.stderr.write(word + "\\n");
    console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, errors: [word] }));
    process.exit(1);
  }
}
// A workflow agent carries its own frame — it runs in the body "sub", recognisable by isWorkflowAgent.
const isWorkflowAgent = joined.includes("WORKFLOW AGENT of cbase");
const isSub = joined.includes("SUBAGENT of cbase") || isWorkflowAgent;
const cfgPath = arg("--mcp-config");
let done = false;
// Like the real CLI (measured at 2.1.280): a line that arrives in the MIDDLE of the turn on stdin does not start a second turn
// alongside — it waits until the running one is done and then becomes its own turn; even if stdin has been closed meanwhile,
// it is not lost (the same after the LAST tool boundary, stdin open or closed; guard in agent-harness.test.js). A body that
// imitates a tool boundary fetches with \`anTheLimit()\` the texts that arrived until then — they belong to the SAME turn (as
// the real CLI does) and do not become their own.
let stdinTo = false, running = false;
const inlet = [];
const finished = () => { done = true; };
// A oneshot (title, verdict of a workflow gate) has no --input-format: the prompt arrives as plain text on stdin.
// Answered only with \`oneshot\` (body with \`prompt\`, \`respond(text)\`); without it it ends with exit 3 as before.
const isOneshot = ${oneshot ? "!argv.includes(\"--input-format\")" : "false"};
if (isOneshot) {
  let prompt = "";
  process.stdin.on("data", (c) => { prompt += c; });
  const respond = (t) => { process.stdout.write(JSON.stringify({ type: "result", result: t })); process.exit(0); };
  process.stdin.on("end", () => {
${oneshot}
  });
} else process.stdin.on("end", () => { stdinTo = true; if (!running && !inlet.length) end(); });

// Like the real CLI: a name in --disallowedTools is no tool — the call ends as an error without the MCP server seeing it.
const locked = (arg("--disallowedTools") || "").split(",").filter(Boolean);
// The built-in tools that this run sees: the set of the CLI (excerpt, including its Agent/Task and Workflow) minus
// --disallowedTools; a --tools trims it like the real CLI.
const BUILTIN = ["Agent", "Task", "Workflow", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "Monitor", "Skill", "ToolSearch"];
function eingebauteTools() {
  const white = argv.includes("--tools") ? arg("--tools").split(",").filter(Boolean) : null;
  return BUILTIN.filter((n) => !locked.includes(n) && (!white || white.includes(n)));
}
// A real MCP call: start the server named in the config of THIS run and speak tools/call. The child gets its own process group
// (detached) so that the harness can hit it together with its children. No deadline: if the server hangs, the ripcord takes over.
function mcpCall(name, args, meta) {
  if (meta === undefined) {
    const id = (openCalls["mcp__cbase__" + name] || []).shift();
    meta = id ? { "claudecode/toolUseId": id } : null;
  }
  if (locked.includes("mcp__cbase__" + name)) {
    return Promise.resolve({ result: { isError: true, content: [{ type: "text", text: "<tool_use_error>No such tool available: mcp__cbase__" + name + "</tool_use_error>" }] } });
  }
  return mcpRpc("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
}
// The tool list that this run sees: tools/list of its cbase server minus --disallowedTools.
async function mcpTools() {
  const m = await mcpRpc("tools/list", {});
  return ((m.result && m.result.tools) || []).map((t) => t.name).filter((n) => !locked.includes("mcp__cbase__" + n));
}
function mcpRpc(method, params) {
  return new Promise((resolve, reject) => {
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers.cbase; }
    catch (e) { return reject(new Error("MCP config unreadable: " + e.message)); }
    const child = spawn(cfg.command, cfg.args, { env: { ...process.env, ...(cfg.env || {}) }, stdio: ["pipe", "pipe", "inherit"], detached: true });
    try { fs.writeFileSync(path.join(LOCATION, "pids", "g" + child.pid), "mcp"); } catch {}
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 2) { try { child.stdin.end(); } catch {} resolve(m); }
      }
    });
    child.on("error", reject);
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    send({ jsonrpc: "2.0", id: 2, method, params });
  });
}
const textOf = (m) => (m && m.result && m.result.content && m.result.content[0] && m.result.content[0].text) || "";

// Background tasks and control requests like the real CLI (CLI 2.1.296 — measured at 2.1.280 and 2.1.296 against an API mock;
// sequence in the stream: background_tasks_changed, task_started; on stop_task task_updated "killed", task_notification
// "stopped", background_tasks_changed, control_response "success").
//   \`backgroundBash(id, description)\` in the body: a background command WITHOUT end (dev server) — tool_use Bash with
//   run_in_background, the actual list, task_started, the tool result.
//   A \`control_request\` line is answered AT ONCE, outside the order of the user lines (like the real CLI): \`stop_task\`
//   ends an open task and answers \`success\` — also for an unknown id (measured); every other kind \`error\`.
//   Every control request is in <LOCATION>/control.jsonl.
//   If stdin closes while a task is open, it does what the CLI does from 2.1.292: it waits for the task (here it counts as
//   ended at once) and then runs a FOLLOW-UP turn — text and result "FOLLOW-UP-TURN", entry in <LOCATION>/follow-up-turn.jsonl.
//   Until 2.1.291 the CLI ended the task silently. Without \`backgroundBash\` in the body everything stays as before.
const openTasks = new Map();
function backgroundBash(id, description) {
  const use = "toolu_bg_" + id;
  openTasks.set(id, description || "npm run dev");
  say({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: use,
    input: { command: openTasks.get(id), description: openTasks.get(id), run_in_background: true } }] } });
  say({ type: "system", subtype: "background_tasks_changed", tasks: [...openTasks.keys()].map((t) => ({ task_id: t })) });
  say({ type: "system", subtype: "task_started", task_id: id, tool_use_id: use, description: openTasks.get(id) });
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: use, content: "Command running in background with ID: " + id } ] } });
}
function control(line) {
  let msg; try { msg = JSON.parse(line); } catch { return false; }
  if (!msg || msg.type !== "control_request") return false;
  const req = msg.request || {};
  try { fs.appendFileSync(path.join(LOCATION, "control.jsonl"), JSON.stringify({ pid: process.pid, sub: isSub, request_id: msg.request_id, request: req, open: [...openTasks.keys()] }) + "\\n"); } catch {}
  if (req.subtype !== "stop_task") {
    say({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: "Unsupported control request: " + req.subtype } });
    return true;
  }
  const id = String(req.task_id || "");
  if (openTasks.delete(id)) {
    say({ type: "system", subtype: "task_updated", task_id: id, patch: { status: "killed" } });
    say({ type: "system", subtype: "task_notification", task_id: id, tool_use_id: "toolu_bg_" + id, status: "stopped" });
    say({ type: "system", subtype: "background_tasks_changed", tasks: [...openTasks.keys()].map((t) => ({ task_id: t })) });
  }
  say({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
  return true;
}
// A background command that ENDS while the LAST model request of the turn is running (measured at 2.1.280 and 2.1.296 against
// an API mock): the stream reports task_updated "completed", task_notification "completed" and the actual list without it;
// the notice to the MODEL is still pending, and right after the result the CLI runs it as its own turn (init, answer, second
// result) — whether stdin is open or already closed, 4 ms after the first result.
//   \`backgroundEnds(id)\` in the body reports the end and notes the notice; after the turn the fake runs the notice turn
//   "NOTICE-TURN" (entry in <LOCATION>/notice-turn.jsonl) — before any further line on stdin and before the end.
const ausstehendeNotices = [];
function backgroundEnds(id) {
  openTasks.delete(id);
  say({ type: "system", subtype: "task_updated", task_id: id, patch: { status: "completed" } });
  say({ type: "system", subtype: "task_notification", task_id: id, tool_use_id: "toolu_bg_" + id, status: "completed" });
  say({ type: "system", subtype: "background_tasks_changed", tasks: [...openTasks.keys()].map((t) => ({ task_id: t })) });
  ausstehendeNotices.push(id);
}
function noticeTurn() {
  const ids = ausstehendeNotices.splice(0);
  try { fs.appendFileSync(path.join(LOCATION, "notice-turn.jsonl"), JSON.stringify({ pid: process.pid, sub: isSub, tasks: ids }) + "\\n"); } catch {}
  say({ type: "system", subtype: "init", session_id: lastSession || "notice-session" });
  say({ type: "assistant", message: { content: [{ type: "text", text: "NOTICE-TURN" }] } });
  say({ type: "result", result: "NOTICE-TURN", session_id: lastSession || "notice-session" });
}
function end() {
  if (openTasks.size) {
    const ids = [...openTasks.keys()];
    try { fs.appendFileSync(path.join(LOCATION, "follow-up-turn.jsonl"), JSON.stringify({ pid: process.pid, sub: isSub, tasks: ids }) + "\\n"); } catch {}
    openTasks.clear();
    for (const id of ids) say({ type: "system", subtype: "task_updated", task_id: id, patch: { status: "completed" } });
    say({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    say({ type: "system", subtype: "init", session_id: lastSession || "follow-up-session" });
    say({ type: "assistant", message: { content: [{ type: "text", text: "FOLLOW-UP-TURN" }] } });
    say({ type: "result", result: "FOLLOW-UP-TURN", session_id: lastSession || "follow-up-session" });
  }
  process.exit(done ? 0 : 3);
}

// The gate: the fake reports that it stands in front of it and waits until the test opens it.
function gate(name) {
  const file = path.join(LOCATION, "gates", name);
  try { fs.writeFileSync(file + ".waiting", String(process.pid)); } catch {}
  return new Promise((resolve) => {
    const t = setInterval(() => { if (fs.existsSync(file)) { clearInterval(t); resolve(); } }, 20);
  });
}

let turn = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => { if (control(line)) return; inlet.push(line); pump(); });
async function pump() {
  if (running) return;
  running = true;
  while (inlet.length) {
    try { await row(inlet.shift()); } catch (e) { console.error(e); }
    if (ausstehendeNotices.length) noticeTurn();
  }
  running = false;
  if (stdinTo) end();
}
function anTheLimit() {
  return inlet.splice(0).map((l) => {
    try { const m = JSON.parse(l); return m.type === "user" ? String((m.message && m.message.content && m.message.content[0] && m.message.content[0].text) || "") : null; }
    catch { return null; }
  }).filter((t) => t !== null);
}
async function row(line) {
  // A chat run speaks JSON rows; a oneshot (title, classification) sends plain text — it
  // drops out here instead of being read as a chat run.
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  const text = (msg.message && msg.message.content && msg.message.content[0] && msg.message.content[0].text) || "";
  if (isSub) {
${sub}
    return;
  }
  turn += 1;
${main}
}
`;

// ── Fake-Codex ──────────────────────────────────────────────────────────────────────────────────
export const fakeCodex = ({ text = "Codex-Befund 42" } = {}) => `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const LOCATION = ${JSON.stringify(LOCATION)};
// Atomic: a test often waits only for the EXISTENCE of a file and then reads it — without the rename it read an empty one
// under load. pids/ and gates/ are enumerated and stay raw, as do calls with options.
{ const raw = fs.writeFileSync; fs.writeFileSync = (p, d, o) => { if (typeof p !== "string" || o !== undefined || p.split(path.sep).some((s) => s === "pids" || s === "gates")) return raw(p, d, o); const t = path.join(path.dirname(p), "." + path.basename(p) + ".teil-" + process.pid); raw(t, d); fs.renameSync(t, p); }; }
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
const say = (o) => console.log(JSON.stringify(o));
const argv = process.argv.slice(2);
const ri = argv.indexOf("resume");
const threadId = ri >= 0 ? argv[ri + 1] : "codex-thread";
// Rollouts like the real CLI (measured on 0.153.1) - ONLY with CODEX_HOME in the test's throwaway folder: the thread writes to
// <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, a resume looks for the file (under whichever day) and writes on
// there; if it is missing: "Error: thread/resume: thread/resume failed: no rollout found for thread id <id> (code -32600)",
// exit 1, not a single JSON event.
const CH = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : "";
const withRollouts = Boolean(CH) && (CH === LOCATION || CH.startsWith(LOCATION + path.sep));
function findRollout(id) {
  const hits = [];
  const go = (d, t) => {
    let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const x of e) {
      const p = path.join(d, x.name);
      if (x.isDirectory() && t < 4) go(p, t + 1);
      else if (x.isFile() && x.name.startsWith("rollout-") && x.name.endsWith("-" + id + ".jsonl")) hits.push(p);
    }
  };
  go(path.join(CH, "sessions"), 0);
  return hits[0] || null;
}
let rollout = null;
if (withRollouts) {
  if (ri >= 0) {
    rollout = findRollout(threadId);
    if (!rollout) {
      process.stderr.write("Error: thread/resume: thread/resume failed: no rollout found for thread id " + threadId + " (code -32600)\\n");
      process.exit(1);
    }
  } else {
    const now = new Date();
    const two = (n) => String(n).padStart(2, "0");
    const tag = [String(now.getFullYear()), two(now.getMonth() + 1), two(now.getDate())];
    rollout = path.join(CH, "sessions", ...tag, "rollout-" + tag.join("-") + "T00-00-00-" + threadId + ".jsonl");
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
  }
  fs.appendFileSync(rollout, JSON.stringify({ type: "turn_context", cwd: process.cwd() }) + "\\n");
  // The input like the real CLI (0.162.1): VERBATIM as a response_item message role user — that is how codex-prefix.js
  // recognises whether the thread already carries the defaults.
  fs.appendFileSync(rollout, JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: argv[argv.length - 1] }] } }) + "\\n");
  // A compaction by Codex in the middle of the turn, triggered by "VERDICHTE" in the input: the two lines that the real CLI
  // then writes into the rollout (replacement history and event); nothing of it is in the event stream of exec.
  if (argv[argv.length - 1].includes("VERDICHTE")) {
    fs.appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: "compacted", payload: { message: "", replacement_history: [] } }) + "\\n");
    fs.appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "context_compacted" } }) + "\\n");
  }
}
say({ type: "thread.started", thread_id: threadId });
say({ type: "turn.started" });
say({ type: "item.completed", item: { id: "answer-1", type: "agent_message", text: ${JSON.stringify(text)} + (ri >= 0 ? " (resume " + threadId + ")" : "") } });
say({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } });
`;

// ── Fake OpenRouter endpoint (OpenAI chat, SSE) for the loop engine ───────────────────────────────
// The built-in OpenRouter behind the test seam `CBASE_OPENROUTER_BASE`: besides `/chat/completions` the catalog (`GET /models`,
// the form of the real API: `supported_parameters`, `architecture.input_modalities`, `context_length`, `top_provider`, `pricing`
// as USD strings per token), `GET /key` (the live check), `GET /generation?id=` (the lookup of an amount) and
// `GET /models/<id>/endpoints` (the median of the context window). Every answer carries a generation id (`gen-harness-<n>`) and
// in the usage chunk an amount (`cost`, `is_byok: false`) like the real API.
// `round(request)` (optional) decides per streaming request: `{ toolCalls: [{ id, name, arguments }] }` answers with tool calls in
// ONE answer, everything else with the text.
// `tool` (optional, a function → { name, input }): the FIRST stream answer with a tool list is then a tool call instead of
// text — that is how the engine reads a file, and its result stands in the next request (`requests`, role "tool"). A function
// because the path is usually only known after the chat is created.
export const HARNESS_CATALOG = Object.freeze([
  { id: "m1", name: "M1", supported_parameters: ["tools", "reasoning"], architecture: { input_modalities: ["text", "image"] },
    context_length: 100_000, top_provider: { context_length: 100_000 },
    pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000001", input_cache_write: "0.00000125" } },
  { id: "m2", name: "M2", supported_parameters: ["tools"], architecture: { input_modalities: ["text"] },
    context_length: 100_000, top_provider: { context_length: 100_000 }, pricing: { prompt: "0.000001", completion: "0.000002" } },
  { id: "without-tools", name: "Without tools", supported_parameters: [], architecture: { input_modalities: ["text"] },
    context_length: 32_000, top_provider: { context_length: 32_000 }, pricing: { prompt: "0", completion: "0" } },
]);
// The amount per answer (USD) — the form of the real API (`cost`, `is_byok`).
const HARNESS_COST = 0.00042;
const harnessUsage = () => ({ prompt_tokens: 13, completion_tokens: 6, cost: HARNESS_COST, is_byok: false });
/** The credit that `/credits` reports (USD). */
export const HARNESS_CREDIT = Object.freeze({ total: 10, consumed: 2.5 });

async function startPresetEndpoint({ text = "Engine-Befund 42", round = null, tool = null } = {}) {
  const requests = [];
  const query = [];
  let generation = 0;
  const srv = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const json = (status, o) => { res.writeHead(status, { "Content-Type": "application/json" }); return res.end(JSON.stringify(o)); };
    if (req.method === "GET") {
      const u = new URL(req.url, "http://harness");
      query.push(`${u.pathname}${u.search}`);
      if (u.pathname.endsWith("/models")) return json(200, { data: HARNESS_CATALOG });
      if (u.pathname.endsWith("/key")) return json(200, { data: { label: "harness", usage: 0, limit: null } });
      // The credit of the account (GET /api/usage/openrouter-credit).
      if (u.pathname.endsWith("/credits")) return json(200, { data: { total_credits: HARNESS_CREDIT.total, total_usage: HARNESS_CREDIT.consumed } });
      if (u.pathname.endsWith("/generation")) {
        return json(200, { data: { id: u.searchParams.get("id") || "", total_cost: HARNESS_COST, tokens_prompt: 13, tokens_completion: 6,
          native_tokens_prompt: 13, native_tokens_completion: 6, provider_name: "Harness" } });
      }
      const ep = u.pathname.match(/\/models\/(.+)\/endpoints$/);
      if (ep) {
        const m = HARNESS_CATALOG.find((x) => x.id === decodeURIComponent(ep[1]));
        if (!m) return json(404, { error: { message: "No endpoints" } });
        return json(200, { data: { id: m.id, endpoints: [{ provider_name: "Harness", context_length: m.context_length, status: 0, pricing: m.pricing }] } });
      }
      res.writeHead(404); return res.end();
    }
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { res.writeHead(404); return res.end(); }
    let b = {};
    try { b = JSON.parse(raw); } catch {}
    requests.push(b);
    const genId = `gen-harness-${++generation}`;
    if (b.stream === false) {
      return json(200, { id: genId, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: harnessUsage() });
    }
    // `round` may wait (a promise — that is how a test holds a subagent at a point that IT opens) and deliver its own text
    // instead of tool calls (`{ text }`) — or an HTTP error (`{ status, body }`, e.g. a 429 at the usage limit).
    const choice = round ? await round(b) : null;
    if (choice?.status) {
      res.writeHead(choice.status, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(choice.body ?? {}));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const row = (o) => res.write(`data: ${JSON.stringify({ id: genId, ...o })}\n\n`);
    if (choice?.toolCalls?.length) {
      choice.toolCalls.forEach((c, index) => row({ choices: [{ index: 0, delta: { ...(index ? {} : { role: "assistant" }),
        tool_calls: [{ index, id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } }] } }] }));
      row({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      row({ choices: [], usage: harnessUsage() });
      return res.end("data: [DONE]\n\n");
    }
    if (tool && b.tools?.length && !(b.messages || []).some((m) => m.role === "tool")) {
      const w = tool();
      row({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_harness_1", type: "function",
        function: { name: w.name, arguments: JSON.stringify(w.input || {}) } }] } }] });
      row({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      row({ choices: [], usage: harnessUsage() });
      return res.end("data: [DONE]\n\n");
    }
    // `{ cutoff: true }`: the stream breaks off AFTER the first chunk (network) — the round has shown its generation id, but no
    // usage chunk. It is closed in the callback of write (the chunk is at the operating system), otherwise it would never arrive.
    if (choice?.cutoff) {
      return void res.write(`data: ${JSON.stringify({ id: genId, choices: [{ index: 0, delta: { role: "assistant", content: choice.text ?? text } }] })}\n\n`,
        () => res.socket?.destroy());
    }
    // `{ thinking }`: the word is in the thinking channel, the answer text stays empty (reasoning parser of a server whose model
    // did not close the thinking block — see connectors/openai-chat.js).
    if (typeof choice?.thinking === "string") row({ choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning_content: choice.thinking } }] });
    else row({ choices: [{ index: 0, delta: { role: "assistant", content: choice?.text ?? text } }] });
    row({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    row({ choices: [], usage: harnessUsage() });
    res.end("data: [DONE]\n\n");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    query,
    close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}

// ── Cleanup ─────────────────────────────────────────────────────────────────────────────────────
async function stopAllRuns(base) {
  try {
    const r = await json(`${base}/api/active-runs`);
    for (const it of r?.items || []) {
      if (it.chatId) await json(`${base}/api/chats/${it.chatId}/stop`, { method: "POST" }).catch(() => {});
    }
  } catch { /* the server may already be closed */ }
}

function descendants() {
  let raw = "";
  try { raw = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }); } catch { return []; }
  const children = new Map();
  for (const z of raw.split("\n")) {
    const [pid, ppid] = z.trim().split(/\s+/).map(Number);
    if (!pid || !ppid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const all = [];
  const open = [process.pid];
  while (open.length) {
    for (const k of children.get(open.pop()) || []) { all.push(k); open.push(k); }
  }
  return all;
}

// The members of the registered process groups: `ps -o pid=,pgid=` — a member that does not descend from the test process (the
// long runner of a CLI, detached) would not be found by descendants().
function groupsMembers(groups) {
  if (!groups.size) return [];
  let raw = "";
  try { raw = execFileSync("ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8" }); } catch { return []; }
  const out = [];
  for (const z of raw.split("\n")) {
    const [pid, pgid] = z.trim().split(/\s+/).map(Number);
    if (pid && groups.has(pgid)) out.push(pid);
  }
  return out;
}

// A process counts as gone if it no longer exists or only waits as a zombie to be reaped (it is then no longer running).
export const alive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^Z/.test(execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim()); }
  catch { return false; }
};

// End children and grandchildren hard — AT ONCE, without waiting; returns every pid that got a SIGKILL. First ALL targets are
// collected (registered pids, the members of the registered groups, the descendants of the test process), then killed. Never
// throws — a cleanup must not hide the error of the body.
export function endChildrenImmediately(root) {
  const kill = (target) => { try { process.kill(target, "SIGKILL"); } catch { /* already gone */ } };
  let entries = [];
  try { entries = fs.readdirSync(path.join(root, "pids")); } catch {}
  const pids = new Set();
  const groups = new Set();
  for (const e of entries) {
    const group = e.startsWith("g");
    const pid = Number(group ? e.slice(1) : e);
    if (!pid) continue;
    if (group) groups.add(pid);
    pids.add(pid);
  }
  for (const pid of groupsMembers(groups)) pids.add(pid);
  for (const pid of descendants()) pids.add(pid);
  for (const g of groups) kill(-g);
  for (const pid of pids) kill(pid);
  return [...pids];
}

// End AND wait until every target is gone or a zombie — without a deadline (a wait line every 30 s, as in quiet.mjs). Without
// the wait, the cleanup returned right after the SIGKILL, the folder `rmSync` hit children that were still writing (ENOTEMPTY),
// and a still living long runner was inherited by the next test. Seam `alive` for the test.
export async function endChildrenAndWait(root, { alive: aliveSeam = alive } = {}) {
  const targets = endChildrenImmediately(root);
  let open = targets;
  const closed = waitRow(() => `children of the test gone (${open.join(", ")})`);
  try {
    for (;;) {
      open = open.filter((pid) => { try { return aliveSeam(pid); } catch { return false; } });
      if (!open.length) return targets;
      await pause(25);
    }
  } finally { closed(); }
}
export const endChildren = endChildrenAndWait;

// ── Der Server ──────────────────────────────────────────────────────────────────────────────────
const CHILD_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "agent-server-child.mjs");

// End the fakes of a crashed server hard and deregister them — their pids belong to the old server run.
function killEntered(root) {
  let entries = [];
  try { entries = fs.readdirSync(path.join(root, "pids")); } catch {}
  for (const e of entries) {
    const group = e.startsWith("g");
    const pid = Number(group ? e.slice(1) : e);
    if (pid) {
      try { process.kill(group ? -pid : pid, "SIGKILL"); } catch { /* already gone */ }
      if (group) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
    try { fs.rmSync(path.join(root, "pids", e), { force: true }); } catch {}
  }
}

/**
 * Prepare OpenRouter for a test: the key through PUT /api/openrouter (the only way), then wait until the catalog is loaded —
 * it loads in the background at server start from the base (`CBASE_OPENROUTER_BASE`, set BEFORE the start); without it
 * OpenRouter would know no model (context window, images, bare ids). Observed at the catalog file
 * (`<data>/openrouter-catalog.json`, written AFTER the list is set) — not at GET /api/providers: the route asks
 * `claude auth status`, and the fake Claude does not know it (a 15 s deadline per look).
 */
export async function logInOpenRouter({ base, dataRoot }, { apiKey = "test", standard } = {}) {
  await json(`${base}/api/openrouter`, { method: "PUT", body: JSON.stringify({ apiKey, onlyWithoutSaving: false, noDataUsage: false }) });
  const catalog = path.join(dataRoot, "data", "openrouter-catalog.json");
  await waitForTruthy(() => fs.existsSync(catalog), "OpenRouter catalog");
  // The default model — OpenRouter has no fallback to the first catalog model (providers/index.js defaultModelFor): without a
  // stored default a run without a model ends with a message. The harness therefore stores what used to hold silently: the first
  // model WITH tools from the catalog that the server has just written (m1 at the fake endpoint of the harness, the first of
  // the test's own router otherwise); `standard: "<id>"` chooses, `""` leaves it out.
  let choice = standard;
  if (choice === undefined) {
    try { choice = (JSON.parse(fs.readFileSync(catalog, "utf8")).models || []).find((m) => m?.tools === true)?.id || ""; } catch { choice = ""; }
  }
  if (choice) await json(`${base}/api/default-model`, { method: "PUT", body: JSON.stringify({ provider: "openrouter", model: choice }) });
}

export async function withAgentsServer(fn, { claude = fakeClaude(), codex = null, engine = false, childProcess = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-agents-"));
  fs.mkdirSync(path.join(root, "pids"));
  fs.mkdirSync(path.join(root, "gates"));
  const dataRoot = path.join(root, "data-root");
  const webDir = path.join(root, "web");
  const prior = { CLAUDE_BIN: process.env.CLAUDE_BIN, CODEX_BIN: process.env.CODEX_BIN, CBASE_RESTART_GRACE_MS: process.env.CBASE_RESTART_GRACE_MS,
    CBASE_OPENROUTER_BASE: process.env.CBASE_OPENROUTER_BASE };
  let server = null;
  let base = "";
  let preset = null;
  let error = null;
  const write = (name, script) => {
    const f = path.join(root, name);
    fs.writeFileSync(f, setLocation(script, root));
    fs.chmodSync(f, 0o755);
    return f;
  };
  const idle = async () => {
    const s = await json(`${base}/api/runs/active`).catch(() => null);
    // Running dynamic workflows are NOT in `busy` (the deploy does not wait for them) — idle still means for a test: no
    // workflow running any more either.
    return !s || (!s.busy && (s.runs | 0) === 0 && !(Array.isArray(s.dynWorkflows) && s.dynWorkflows.length > 0));
  };
  const turnGo = async () => {
    const s = await json(`${base}/api/runs/active`).catch(() => null);
    return !s || (s.runs | 0) === 0;
  };
  const close = async () => {
    if (!server) return;
    if (server.serverProcess) {
      try { process.kill(server.serverProcess.pid, "SIGTERM"); } catch { /* already gone */ }
      await server.ended;
      server = null;
      return;
    }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    server = null;
  };
  // The server as a process (opts.childProcess): own process group (detached), output to server-<n>.log in the throwaway folder.
  // It is ready when it answers on HTTP - waited for without a deadline, but a dead process throws.
  let kindCounter = 0;
  let tokenCounter = 0;
  const startChild = async (port, extraEnv = {}) => {
    const log = fs.openSync(path.join(root, `server-${++kindCounter}.log`), "a");
    // The fourth channel is IPC: through it the server process writes the marker of the stream barrier (ctx.barrier) — a way
    // of this test entry only, in the product it opens nothing. `unref` so that an open channel does not keep the test
    // process alive.
    const child = spawn(process.execPath, [CHILD_SCRIPT, String(port), dataRoot, webDir], {
      env: { ...process.env, ...extraEnv }, stdio: ["ignore", log, log, "ipc"], detached: true,
    });
    child.channel?.unref?.();
    fs.closeSync(log);
    let tot = null;
    const ended = new Promise((resolve) => child.once("exit", (code, sig) => { tot = `Exit ${code ?? sig}`; resolve({ code, signal: sig }); }));
    try { fs.writeFileSync(path.join(root, "pids", `g${child.pid}`), "server"); } catch {}
    await waitForTruthy(async () => {
      if (tot) throw new Error(`server process died before the start (${tot}) — see server-${kindCounter}.log`);
      try { const r = await fetch(`http://127.0.0.1:${port}/api/runs/active`, { headers: { Connection: "close" } }); return r.ok; } catch { return false; }
    }, "server process ready");
    return { serverProcess: child, ended };
  };
  try {
    process.env.CLAUDE_BIN = write("fake-claude", claude);
    if (codex) process.env.CODEX_BIN = write("fake-codex", codex === true ? fakeCodex() : codex);
    // The follow-up start (interrupted runs, queue) is a start timer: a test switches it off instead of waiting out its 2.5 s.
    process.env.CBASE_RESTART_GRACE_MS = String(24 * 3_600_000);
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    const port = await freePort();
    // The fake OpenRouter endpoint runs BEFORE the server: the catalog loads at the start from the base (test seam).
    if (engine) {
      preset = await startPresetEndpoint(engine === true ? {} : engine);
      process.env.CBASE_OPENROUTER_BASE = preset.url;
    }
    server = childProcess ? await startChild(port) : await startServer({ port, dataRoot, webDir, pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Agent-E2E", path: wsPath }) });
    const chat = await json(`${base}/api/chats`, {
      method: "POST",
      body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
    });
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Agent-E2E" }) });
    let engineInfo = null;
    if (engine) {
      await logInOpenRouter({ base, dataRoot });
      engineInfo = { id: "openrouter", model: "openrouter::m1", requests: preset.requests, query: preset.query };
    }
    const gate = {
      reached: (name) => waitForTruthy(() => fs.existsSync(path.join(root, "gates", `${name}.waiting`)), `gate ${name}`),
      open: (name) => fs.writeFileSync(path.join(root, "gates", name), "open"),
    };
    // The writer of the stream barrier: in the test process the default from quiet.mjs, as its own process over IPC (the answer
    // comes AFTER the server process has written the marker into the stream — or with its error).
    const writeInChild = (target, marker) => new Promise((resolve, reject) => {
      const k = server?.serverProcess;
      if (!k?.connected) { reject(new Error("stream barrier: no IPC channel to the server process")); return; }
      // As long as the answer is pending, the channel keeps the test process awake (otherwise only a promise would be open).
      k.channel?.ref?.();
      const response = (m) => {
        if (m?.kind !== "barrier" || m.marker !== marker) return;
        k.off("message", response);
        k.channel?.unref?.();
        if (m.error) reject(new Error(m.error)); else resolve();
      };
      k.on("message", response);
      k.send({ kind: "barrier", target, marker });
    });
    const ctx = {
      base, port, chat, ws, dataRoot, root, gate, engine: engineInfo,
      waitForTruthy,
      waitForIdle: () => waitForTruthy(idle, "idle"),
      waitForQuiet: (opts) => waitForQuiet(base, opts),
      barrier: (reader, target = chat.id) => streamBarrier(reader, target, childProcess ? { write: writeInChild } : {}),
      waitForLog: (chatId, p) => waitForTruthy(async () => {
        const log = await json(`${base}/api/chats/${chatId}/log`);
        return p(log) ? log : null;
      }, `history ${chatId}`),
      // `withBackground`: a parked or living background agent is open work (busy) — then it only waits until no turn runs any
      // more, and the restart hits it (its record stays). `instancesReady`: see the header, "restart".
      async restart({ withBackground = false, instancesReady = false } = {}) {
        if (instancesReady && childProcess) throw new Error("restart({ instancesReady }) only in-process — with opts.childProcess the test does not share the store");
        await stopAllRuns(base);
        await waitForTruthy(withBackground ? turnGo : idle, "idle before the restart");
        await close();
        server = childProcess ? await startChild(port) : await startServer({ port, dataRoot, webDir, pickDirectory: null, notify: null });
        if (instancesReady) {
          for (const z of store.projectInstancesInState(["start"])) {
            if (z.convertedAt) store.changeProjectInstance(z.projectId, z.instance, { state: "ready" });
          }
        }
      },
      async crash() {
        if (!childProcess) throw new Error("crash() needs withAgentsServer(…, { childProcess: true })");
        try { process.kill(-server.serverProcess.pid, "SIGKILL"); } catch { /* already gone */ }
        await server.ended;
        killEntered(root);
        server = await startChild(port, { CBASE_RESTART_GRACE_MS: "0" });
      },
      // ONLY with opts.childProcess: a signal to the server process (not to the group) — SIGTERM runs the server end there as in the
      // user container. Returns: `ended` (promise on { code, signal }) and `alive()`. The server stays gone afterwards; the
      // finally of the harness copes with that (quiet and stop read a dead server as quiet).
      signal(sig = "SIGTERM") {
        if (!childProcess) throw new Error("signal() needs withAgentsServer(…, { childProcess: true })");
        const k = server.serverProcess;
        process.kill(k.pid, sig);
        return { ended: server.ended, alive: () => k.exitCode === null && k.signalCode === null };
      },
      // ONLY with opts.childProcess: `wakeParkedNow` in the server process (SIGUSR2, agent-server-child.mjs) — the reset is reached.
      // Without childProcess the test calls the seam itself (runs/agents.js).
      wakeParked() {
        if (!childProcess) throw new Error("wakeParked() needs withAgentsServer(…, { childProcess: true }) — in-process: wakeParkedNow()");
        process.kill(server.serverProcess.pid, "SIGUSR2");
      },
      // With a busy timeout: without it the reader gave up AT ONCE with "database is locked" as soon as the server process was
      // writing — red under load without a real fault. It waits for the lock to be released, without a practical deadline
      // (2^31−1 ms); the wait blocks only the test process, the server runs on as its own process and releases the lock.
      db() {
        if (!childProcess) throw new Error("db() needs withAgentsServer(…, { childProcess: true }) — in-process the test reads the store");
        return new DatabaseSync(path.join(dataRoot, "data", "automater.db"), { readOnly: true, timeout: 2_147_483_647 });
      },
      // ONLY with opts.childProcess: the token lives in the memory of the server process — over the IPC channel (agent-server-child.mjs).
      // As with the barrier, the open answer keeps the channel awake.
      token(projectId, instance = "main") {
        if (!childProcess) throw new Error("token() needs withAgentsServer(…, { childProcess: true }) — in-process: projectbox/token.js");
        const k = server?.serverProcess;
        if (!k?.connected) return Promise.reject(new Error("token(): no IPC channel to the server process"));
        const id = `t${++tokenCounter}`;
        return new Promise((resolve, reject) => {
          k.channel?.ref?.();
          const response = (m) => {
            if (m?.kind !== "token" || m.id !== id) return;
            k.off("message", response);
            k.channel?.unref?.();
            if (m.error || !m.token) reject(new Error(m.error || "token(): no token")); else resolve(m.token);
          };
          k.on("message", response);
          k.send({ kind: "token", id, projectId, instance });
        });
      },
      // A project WITHOUT an instance row in the workspace of the test (default) — see projectWithoutInstance above. With
      // opts.childProcess the server process creates it (its store is not the test's), over the IPC channel like `token`. Always a
      // promise, so the caller need not know where the server runs.
      projectWithoutInstance({ name, path: filePath, workspaceId = ws.id } = {}) {
        if (!childProcess) {
          try { return Promise.resolve(projectWithoutInstance({ workspaceId, name, path: filePath })); } catch (e) { return Promise.reject(e); }
        }
        const k = server?.serverProcess;
        if (!k?.connected) return Promise.reject(new Error("projectWithoutInstance(): no IPC channel to the server process"));
        const id = `p${++tokenCounter}`;
        return new Promise((resolve, reject) => {
          k.channel?.ref?.();
          const response = (m) => {
            if (m?.kind !== "project" || m.id !== id) return;
            k.off("message", response);
            k.channel?.unref?.();
            if (m.error || !m.project) reject(new Error(m.error || "projectWithoutInstance(): no project")); else resolve(m.project);
          };
          k.on("message", response);
          k.send({ kind: "project", id, workspaceId, name, path: filePath });
        });
      },
      get childPid() { return childProcess ? server?.serverProcess?.pid ?? null : null; },
    };
    await fn(ctx);
  } catch (e) {
    error = e;
    throw e;
  } finally {
    if (base && server) {
      // QUIET instead of idle: whatever keeps working after the run end (title, curator, verdicts, queue, oneshots) is done
      // before the next test inherits the module state.
      if (!error) await waitForQuiet(base);
      await stopAllRuns(base);
    }
    await endChildrenAndWait(root);
    if (error && base && server) {
      // After a failure: actively stop and let the killed runs write their end, until the server is QUIET — without a deadline
      // and without throwing (quiet.mjs tidyUp). Idle alone was not enough: under load a run went on afterwards and wrote into the
      // database of the next test of the file ("attempt to write a readonly database"). The fake preset endpoint closes
      // beforehand: an engine request that hangs on a never opened `round` promise ends as an error.
      if (preset) { await preset.close().catch(() => {}); preset = null; }
      await tidyUp(base, { error, who: "agent-harness", end: () => endChildrenAndWait(root) });
    }
    try { await close(); } catch (e) { console.warn(`[agent-harness] close: ${e?.message || e}`); }
    if (preset) await preset.close().catch(() => {});
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
}
