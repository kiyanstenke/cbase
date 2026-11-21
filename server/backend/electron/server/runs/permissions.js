// A run's permissions: remembered rules, web search and requestPermission. The WAITING ROOM of open approvals
// (pendingPermissions, resolvePermission, clearChatPermissions) lives in the leaf ./approvals.js and is re-exported
// from here — that edge used to close the import cycle with runs/state.js.
// No domain is imported here. The two REPORTS are hooks: "beforePermission" (graph run, scheduled turn) and
// "afterPermission" (the ruling row — approvalRulingReport in runs/approval-ruling.js), registered in server.js.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { suggestRule } from "../providers/permission-gate.js";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { fireHooks } from "./hooks.js";
import { clearChatPermissions, pendingPermissions, resolvePermission } from "./approvals.js";
import { running } from "./state.js";
import { sse } from "../runtime/sse.js";



// Durable approvals ("don't ask again"). Spelled as in Claude Code's settings.json: "Bash(git status:*)",
// "Read(src/**)" or simply "WebFetch".
function loadPermissionRules() {
  try {
    const arr = JSON.parse(store.getSetting("permission_rules", "[]"));
    return Array.isArray(arr) ? arr.filter((r) => typeof r === "string" && r.trim()).map((r) => r.trim()) : [];
  } catch { return []; }
}
function savePermissionRules(rules) {
  const clean = [...new Set(rules.filter((r) => typeof r === "string" && r.trim()).map((r) => r.trim()))].slice(0, 500);
  store.setSetting("permission_rules", JSON.stringify(clean));
  return clean;
}
function rememberPermissionRule(rule) {
  const r = String(rule || "").trim();
  if (!r) return;
  savePermissionRules([...loadPermissionRules(), r]);
}

// Web search of our own harness. Without configuration it stays with keyless DuckDuckGo scraping — that works but
// breaks as soon as its HTML changes.
const WEB_SEARCH_PROVIDERS = ["duckduckgo", "brave", "tavily", "searxng"];
function loadWebSearchConfig() {
  try {
    const c = JSON.parse(store.getSetting("web_search", "{}"));
    const provider = WEB_SEARCH_PROVIDERS.includes(c?.provider) ? c.provider : "duckduckgo";
    return { provider, apiKey: String(c?.apiKey || ""), baseUrl: String(c?.baseUrl || "") };
  } catch { return { provider: "duckduckgo", apiKey: "", baseUrl: "" }; }
}


// From how many tools of a turn the Claude CLI gets its ToolSearch (do-run.js `toolSearchNeeded`). The same number
// as DEFER_ABOVE in providers/engine.js — same question, same answer. Read on EVERY call, not frozen at import: a
// `const` would silently measure against the production value.
const toolsearchThreshold = () => Number(process.env.CBASE_TOOLSEARCH_THRESHOLD || 45) || 45;
// Is `target` inside one of the roots? Literal, without resolving links — channels/messages.js needs it that way for the copy.
const insideRoots = (target, roots) => {
  const abs = path.resolve(target);
  return roots.some((r) => abs === r || abs.startsWith(r + path.sep));
};

// In-process permission request: reports an approval to the frontend (permission_request SSE) and stays open until
// the user decides. Used by (a) the /permission-request route (cbase MCP server for native CLIs) and (b) the loop
// engine (completion providers) directly — both land in the same pendingPermissions map, and the same
// /permission-decision route resolves them.
// No deadline: Claude Code waits indefinitely too; a timeout would silently deny a command the user was never asked
// about. An open request is resolved at the latest at the end of the run (clearChatPermissions) or at the end of its
// agent (clearAgentPermissions), so it cannot hang.
// `agent`: the requesting agent — if missing, it is the main run. It comes from the request itself (the subagent's
// MCP profile in runs/routes.js, engine context in runs/agents.js) and decides who denies the card when nobody
// decides it (approvals.js: end of turn/stop or the end of THIS agent).
// Without a running turn only a BACKGROUND agent may ask: a coding chat does not hold its turn, the agent keeps
// running afterwards — its request gets a card like any other and belongs to it (clearAgentPermissions at its end).
// Otherwise whether the agent got its approval would depend on timing, not on the request.
// `airlock` (coding MCP airlock): the card of a marked tool of a coding MCP server, raised by
// toolchain/airlock-routes.js — `{ server, tool, description, writing }`. It is a coding card but carries NO
// suggestedRule (no "remember": that decision is made under Coding → MCP), and its history row names server and tool.
// `signal`: if it aborts the request (wrapper closed, provider abort, deadline), the open card is denied —
// `signal.reason` is the text to the model, `origin` is "stop", or "deadline" if the reason says so.
function requestPermission(chatId, { toolName, input, toolUseId, agent = null, airlock = null, signal = null } = {}) {
  if (!running.has(chatId) && agent?.background !== true) return Promise.resolve({ behavior: "deny", message: "No running run" });
  const chat = store.getChat(chatId);
  // Every request is a coding card. `approval` stays in the entry and on the hook, always null.
  const requestId = crypto.randomUUID();
  const at = Date.now();
  return new Promise((resolve) => {
    pendingPermissions.set(requestId, { resolve, chatId, requestId, at, input: input ?? {}, timer: null, toolName: String(toolName || ""), approval: null, agent: agent && agent.id ? { id: String(agent.id), background: agent.background === true } : null, ...(airlock ? { airlock: true } : {}) });
    // Hook "beforePermission" (subscribers: graph run and scheduled turn): fired for EVERY request, after the entry in
    // pendingPermissions and BEFORE the event to the clients. The coding card is internal to runs and stays here.
    fireHooks("beforePermission", { chat, chatId, requestId, toolName: String(toolName || ""), input: input ?? {}, approval: null, at });
    // Coding card: persisted as a row so that after a reload it is still visible WHAT was approved or denied (no
    // marker, no bell, no broadcast — nothing new is waiting); the ruling row follows in approvalRulingReport.
    // `coding` tells the view that it only SHOWS the card while the live approval row at the composer decides.
    try {
      store.addMessage(chatId, "approval", JSON.stringify(airlock
        ? { requestId, toolName: String(toolName || ""), server: String(airlock.server || ""), tool: String(airlock.tool || ""), description: String(airlock.description || ""), writing: airlock.writing === true, input: input ?? {}, at, coding: true, airlock: true }
        : { requestId, toolName: String(toolName || ""), server: "", tool: String(toolName || ""), description: "", writing: false, input: input ?? {}, at, coding: true, suggestedRule: suggestRule(String(toolName || ""), input ?? {}) }), at);
    } catch (e) { console.error("[approval] coding card:", e?.message || e); }
    sse(chatId, {
      type: "harness", subtype: "permission_request", requestId,
      toolName: String(toolName || ""), input: input ?? {}, toolUseId: toolUseId || null,
      // Suggestion for "don't ask again" — the user should see WHAT they allow permanently. An airlock card carries
      // none: without suggestedRule no client shows "remember".
      ...(airlock ? {} : { suggestedRule: suggestRule(String(toolName || ""), input ?? {}) }),
    });
    if (signal) {
      const onAbort = () => {
        if (!pendingPermissions.has(requestId)) return;
        const text = String(signal.reason?.message || signal.reason || "aborted");
        resolvePermission(requestId, { behavior: "deny", message: text }, { origin: signal.reason?.deadline ? "deadline" : "stop", reason: text });
        sse(chatId, { type: "harness", subtype: "permission_resolved", requestId, behavior: "deny" });
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export { WEB_SEARCH_PROVIDERS, clearChatPermissions, insideRoots, loadPermissionRules, loadWebSearchConfig, pendingPermissions, rememberPermissionRule, requestPermission, resolvePermission, savePermissionRules, toolsearchThreshold };
