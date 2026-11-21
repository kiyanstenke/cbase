// Guard: the Registration agent is gone, and with it all app agents including the orb dock (web `AgentDock`/`AgentChatView`, iOS
// `AgentChatsOverlay`). This is the web and iOS side of both removals. The server side has its guards in
// server/backend/test/registration-legacy-data.test.js (legacy `conflict` data, read-only) and
// server/backend/test/coding-jobs.test.js (jobs as coding chats, routes 404).
//
// Two promises, read from source:
//   (1) No client calls the dropped route of the Registration agent or reads the dropped conflict chat -- web (`web/src`), iOS
//       (`mobile/CbaseMobile`) and the client shell (`client/`). An old call would get 404 and show an error, an old
//       `conflictChatId` would silently always be empty. Comments do not count (they tell what was dropped).
//   (2) Likewise nothing of the app agents: no route `/api/agent-chats` or `/api/context/route`, no event `cbase-agent-chat`
//       (it opened the dock), no field `agentChatId` (the jump target of a notification into the dock), no reply
//       `target: "ask"`. A leftover would open into nothing.
//
// Counter-test: (1) against the state before the removal the guard is red with six hits of the route; (2) likewise against
// the state before the app-agent removal. The built-in sabotage below shows the patterns red on artificial sources.
//
// Run:  node --test web/test/registration-legacy-data.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repo = path.resolve(webDir, "..");

// ── (1) No client knows the dropped route or the dropped field ─────────────────────────────────
const ROUTE = /["'`]\/api\/apps\/registration-agent["'`]/;
const FIELD = /\bconflictChatId\b/;
const SUFFIXES = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".swift"]);

function files(root) {
  const output = [];
  const go = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "dist" || e.name === "out") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) go(p);
      else if (SUFFIXES.has(path.extname(e.name))) output.push(p);
    }
  };
  go(root);
  return output;
}
// Lines that are only a comment drop out -- a header telling what was dropped is not a call.
const withoutComments = (text) => text.split("\n").filter((z) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(z)).join("\n");
// (2) The app agents.
const APP_AGENTS = [
  [/["'`]\/api\/agent-chats\b/, "agent-chats"],
  [/["'`]\/api\/context\/route\b/, "context/route"],
  [/["'`]cbase-agent-chat["'`]/, "cbase-agent-chat"],
  [/\bagentChatId\b/, "agentChatId"],
  [/target\s*===?\s*["'`]ask["'`]|target\s*==\s*"ask"/, "target ask"],
];
function hits(text) {
  const t = withoutComments(text);
  return [ROUTE.test(t) && "Route", FIELD.test(t) && "conflictChatId", ...APP_AGENTS.map(([re, name]) => re.test(t) && name)].filter(Boolean);
}

test("(1)(2) no client calls the routes of the dropped agents, opens their dock or reads their fields (web, iOS, client shell)", () => {
  const roots = [path.join(webDir, "src"), path.join(repo, "mobile", "CbaseMobile"), path.join(repo, "client")];
  const all = roots.flatMap(files);
  assert.ok(all.length > 300, `too few sources read (${all.length}) -- paths moved?`);
  const findings = all.map((d) => [path.relative(repo, d), hits(fs.readFileSync(d, "utf8"))]).filter(([, t]) => t.length);
  assert.deepEqual(findings, [], "dropped route, event or field still in use");
});

test("(1) sabotage: the patterns bite on artificial sources", () => {
  assert.deepEqual(hits(`const r = await api("/api/apps/registration-agent", { method: "POST" });`), ["Route"]);
  assert.deepEqual(hits('let r: X = try await client.post("/api/apps/registration-agent")'), ["Route"]);
  assert.deepEqual(hits("if (data.conflictChatId) open(data.conflictChatId);"), ["conflictChatId"]);
  assert.deepEqual(hits("  // POST /api/apps/registration-agent was dropped; conflictChatId likewise"), [], "a comment does not count");
  assert.deepEqual(hits('const l = await api("/api/agent-chats");'), ["agent-chats"]);
  assert.deepEqual(hits('await api("/api/context/route", { method: "POST" });'), ["context/route"]);
  assert.deepEqual(hits('window.dispatchEvent(new CustomEvent("cbase-agent-chat", { detail: id }));'), ["cbase-agent-chat"]);
  assert.deepEqual(hits("if (e.agentChatId) open(e.agentChatId);"), ["agentChatId"]);
  assert.deepEqual(hits('if (r.target === "ask" && r.chatId) ask();'), ["target ask"]);
  assert.deepEqual(hits('if response.target == "ask", let id = response.chatId { open(id) }'), ["target ask"]);
  assert.deepEqual(hits("  // agentChatId and cbase-agent-chat were dropped"), [], "a comment does not count");
});
