// The working icon of the chat list with an open dynamic workflow: the pure computation src/lib/workflow-chats.ts EXECUTED, plus
// the bindings no type error reports:
//   (a) initial state: `dynWorkflows` of the global stream becomes a set of runIds per chat; rows without chatId/runId drop out;
//       a missing field (backend before this feature) means "none known", no throw;
//   (b) event `dyn_workflow`: two runs in one chat — the end of one leaves the other standing; an incomplete or repeated event
//       changes nothing (same reference, no re-render);
//   (c) server ↔ web: the event has the same name in dynworkflows/run.js (GLOBAL_EVENT) and carries chatId, runId, open; the
//       initial state in runtime/sse.js carries `dynWorkflows`;
//   (d) wiring: ChatPane sets the state from `init` and from the event and hands it to ChatListPane; every row and every folder of
//       the list asks `chatWorking` (never `runningChats.has` alone);
//   (e) iOS, read as TEXT: AppState reads `dynWorkflows` in init and `dyn_workflow` with chatId/runId/open, counts per runId, and
//       every row and folder of the coding chat list (Chat/ChatsOverviewPane.swift) asks `state.chatWorking`.
//
// Counter-tests (one sabotage each, shown red):
//   src/lib/workflow-chats.ts: `if (runs.size) next.set(…); else next.delete(chatId);` → always `next.delete(chatId)`    ⇒ (b) red
//   src/components/chat/ChatListPane.tsx: one row back to `running={runningChats.has(c.id)}`                              ⇒ (d) red
//   mobile/…/Chat/ChatsOverviewPane.swift: one row back to `state.runningChats.contains(chat.id)`                         ⇒ (e) red
//
// Run:  node --test --test-reporter=tap web/test/workflow-chats.test.mjs
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
const repo = path.resolve(webDir, "..");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");
const read = (rel) => fs.readFileSync(path.join(src, rel), "utf8");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-workflow-chats-"));
execFileSync(process.execPath, [
  tsc, path.join(src, "lib", "workflow-chats.ts"),
  "--outDir", out, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck", "--lib", "es2022,dom",
], { cwd: webDir, stdio: "pipe" });
const W = await import(pathToFileURL(path.join(out, "workflow-chats.js")).href);

const asObject = (status) => Object.fromEntries([...status].map(([k, v]) => [k, [...v].sort()]));

test("(a) initial state: the runIds per chat; broken rows drop out; a missing field means \"none known\"", () => {
  const status = W.workflowChatsFromInit([
    { chatId: "c1", runId: "r1" }, { chatId: "c1", runId: "r2" }, { chatId: "c2", runId: "r3" },
    { chatId: "", runId: "r4" }, { chatId: "c3" }, null, "c4", { chatId: 5, runId: "r5" },
  ]);
  assert.deepEqual(asObject(status), { c1: ["r1", "r2"], c2: ["r3"] });
  assert.equal(W.workflowChatsFromInit(undefined).size, 0);
  assert.equal(W.workflowChatsFromInit({ c1: "r1" }).size, 0);
  assert.equal(W.chatWorking("c2", new Set(), status), true, "a chat with an open workflow is working");
  assert.equal(W.chatWorking("c9", new Set(["c9"]), status), true, "a running turn is working as before");
  assert.equal(W.chatWorking("c9", new Set(), status), false);
});

test("(b) event: two runs in one chat — the end of one leaves the other standing; incomplete and repeated events change nothing", () => {
  let s = W.NO_WORKFLOW_CHATS;
  s = W.workflowChatsApply(s, { chatId: "c1", runId: "r1", open: true });
  s = W.workflowChatsApply(s, { chatId: "c1", runId: "r2", open: true });
  assert.deepEqual(asObject(s), { c1: ["r1", "r2"] });
  s = W.workflowChatsApply(s, { chatId: "c1", runId: "r1", open: false });
  assert.deepEqual(asObject(s), { c1: ["r2"] }, "the second run keeps the icon");
  s = W.workflowChatsApply(s, { chatId: "c1", runId: "r2", open: false });
  assert.deepEqual(asObject(s), {}, "after the last end the chat is no longer working");
  const prior = W.workflowChatsApply(W.NO_WORKFLOW_CHATS, { chatId: "c1", runId: "r1", open: true });
  for (const evt of [
    { chatId: "c1", runId: "r1", open: true }, // repeated start
    { chatId: "c1", runId: "rX", open: false }, // end of an unknown run
    { chatId: "c1", runId: "r1" }, { runId: "r1", open: false }, { chatId: "c1", open: false }, { chatId: "c1", runId: "r1", open: "no" },
  ]) assert.equal(W.workflowChatsApply(prior, evt), prior, JSON.stringify(evt));
  assert.equal(W.NO_WORKFLOW_CHATS.size, 0, "the empty state stays empty (events work on copies)");
});

test("(c) server ↔ web: event name and fields in dynworkflows/run.js, `dynWorkflows` in the initial state from runtime/sse.js", () => {
  const run = fs.readFileSync(path.join(repo, "server/backend/electron/server/dynworkflows/run.js"), "utf8");
  assert.match(run, new RegExp(`export const GLOBAL_EVENT = "${W.WORKFLOW_EVENT}";`));
  assert.match(run, /broadcast\(\{ type: GLOBAL_EVENT, chatId: run2\.chatId, runId: run2\.runId, open \}\)/);
  const sse = fs.readFileSync(path.join(repo, "server/backend/electron/server/runtime/sse.js"), "utf8");
  assert.match(sse, /type: "init", running: running, dynWorkflows: workflows,/);
});

test("(d) wiring: ChatPane holds the state from init and event, every row and folder of the list asks chatWorking", () => {
  const pane = read("components/chat/ChatPane.tsx");
  assert.match(pane, /setWorkflowChats\(workflowChatsFromInit\(\(msg as \{ dynWorkflows\?: unknown \}\)\.dynWorkflows\)\)/);
  assert.match(pane, /msg\.type === WORKFLOW_EVENT\) \{\s*setWorkflowChats\(\(prev\) => workflowChatsApply\(prev,/);
  assert.match(pane, /workflowChats=\{workflowChats\}/);
  const list = read("components/chat/ChatListPane.tsx");
  assert.doesNotMatch(list, /running=\{[^}]*runningChats\.has\(/, "a row or folder asks only runningChats");
  assert.equal((list.match(/running=\{[^}]*chatWorking\(c\.id, runningChats, workflowChats\)/g) || []).length, 3, "two rows and a folder");
});

test("(e) iOS: AppState reads init and event like the web, counted per runId; the coding chat list asks chatWorking", () => {
  const ios = (rel) => fs.readFileSync(path.join(repo, "mobile/CbaseMobile", rel), "utf8");
  const app = ios("Models/AppState.swift");
  assert.match(app, /@Published var workflowChats: \[String: Set<String>\] = \[:\]/);
  assert.match(app, /event\["dynWorkflows"\]\?\.arrayValue/);
  assert.match(app, new RegExp(`type == "${W.WORKFLOW_EVENT}", let id = event\\["chatId"\\]`));
  assert.match(app, /let open = event\["open"\]\?\.boolValue/);
  assert.match(app, /if open \{ runs\.insert\(runId\) \} else \{ runs\.remove\(runId\) \}/);
  assert.match(app, /func chatWorking\(_ id: String\) -> Bool \{ runningChats\.contains\(id\) \|\| workflowChats\[id\] != nil \}/);
  const list = ios("Chat/ChatsOverviewPane.swift");
  assert.doesNotMatch(list, /running: [^\n]*runningChats/, "a row or folder asks only runningChats");
  assert.equal((list.match(/running: [^\n]*state\.chatWorking\(/g) || []).length, 4, "two rows and two folders each (list and overview)");
});
