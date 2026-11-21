// The browser of a chat — human and main agent work in it. Every chat has its own browser, and the main agent ALWAYS
// works in it: no switch, no second browser. When the chat changes, the browser of the new chat is loaded.
//
// What is here — each exactly once:
//   userBrowserTarget      which own browser belongs to a workspace or project (including instance/copy) —
//                          `POST …/browser/ensure` of both levels; for a chat its profile is one of the login stocks.
//   chatBrowserTarget      the browser of a CHAT: scope `chat:<id>`, profile `chat-<id>` at the chat's location, the chat's
//                          instance, stocks.
//   userBrowserApplies     whether THIS turn works in it (only the main agent of an ordinary Coding chat, no workflow step).
//   CHAT_BROWSER_SENTENCE  the fixed sentence in the system prompt of such a turn (fixed per chat, so no cost for the cache).
//   userBrowserForRun      at turn start: ensure the browser (starts it if it is not running), hold it, deliver the
//                          address — or report the fallback.
//   userBrowserChatRoutes  POST /api/chats/:id/browser/ensure (the view of the right chat rail and the code tabs).
//   closeChatBrowser       archiving, deleting, project change of the chat.
//
// The address is `http://127.0.0.1:<debugPort>`: the Playwright MCP is a stdio child of the CLI, and CLI and chat browser
// both start via `inProject(<the chat's instance>, …)` — both in the backend or both in the same project container, so
// on the same loopback.
import path from "node:path";
import { CHAT_BROWSER_CAP_CODE, ensureUserBrowser, holdForAgent, closeUserBrowser } from "../browsers.js";
import { chatProfileDir } from "../browser-profiles.js";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { DIRS } from "../app-state.js";
import { recordNotice } from "../services.js";
import { chatBrowserProfile, chatBrowserProfileElsewhere, locationForChat, playwrightProfileRoot, projectBrowserProfile } from "../runs/runtime-location.js";
import { instanceIsCopy, instanceOfChat } from "../runs/instance.js";
import { depositHint } from "../runs/hints.js";
import { playwrightProfileDir } from "../toolchain/playwright.js";
import { NEXT, send } from "../runtime/http.js";

/**
 * The own browser of a scope — the arguments of `ensureUserBrowser`. Project: `proj:<id>` or in a copy
 * `proj:<id>@copy-<name>` with its own profile, started in the instance; workspace: `ws:<id>` in the backend.
 */
export function userBrowserTarget({ workspace = null, project = null, instance = null }) {
  if (project) {
    const copy = instanceIsCopy(instance) ? `@${instance.instance}` : "";
    return {
      scopeKey: `proj:${project.id}${copy}`, workspaceId: project.workspaceId, label: project.name,
      profileDir: `${projectBrowserProfile(project.id)}${copy}`, // in the project's runtime folder if it is converted
      instance, // in the project container if it is converted
    };
  }
  return {
    scopeKey: `ws:${workspace.id}`, workspaceId: workspace.id, label: workspace.name,
    profileDir: path.join(DIRS.data, "browser-profiles", `ws-${workspace.id}`),
    instance: null,
  };
}

/**
 * The browser of a chat — the arguments of `ensureUserBrowser`. Scope `chat:<id>`, profile `chat-<id>` under the browser
 * profiles of the chat's location (in the runtime folder of a converted project, runs/runtime-location.js
 * chatBrowserProfile), started in the chat's instance (project container or copy; without a project in the backend).
 * `stocks` — the profile of the own browser of its project (including copy) or workspace and the Playwright stock of the
 * workspace (subagents inherit from it); `initialFill` — the old Playwright profile of the main agent
 * (`playwright-profiles/chat-<id>` at the chat's location) and after a project change the profile at the old location,
 * read only into a new profile (browser-profiles.js).
 */
export function chatBrowserTarget(chat, { instance = null } = {}) {
  const project = chat.projectId ? store.getProject(chat.projectId) : null;
  const workspace = project ? null : store.getWorkspace(chat.workspaceId);
  if (!project && !workspace) throw new Error(T("neither the chat's project nor its workspace was found"));
  const scope = userBrowserTarget({ workspace, project, instance: project ? instance : null });
  return {
    scopeKey: `chat:${chat.id}`, workspaceId: chat.workspaceId, label: chat.title || scope.label,
    profileDir: chatBrowserProfile(chat), instance: scope.instance,
    stocks: [scope.profileDir, playwrightProfileDir(chat.workspaceId)],
    initialFill: [...chatBrowserProfileElsewhere(chat), chatProfileDir(playwrightProfileRoot(locationForChat(chat)), chat.id)],
  };
}

/**
 * Does this turn work in the chat's browser? Only an ordinary Coding chat (no special role, no app agent, no child chat
 * of a graph workflow), full toolset (a restricted one has no browser) and no open graph workflow (then the turn is a
 * workflow step). Subagents, workflow and outer loop agents never get here (runs/agents.js) — they keep their profile so
 * two agents never control the same tabs.
 */
export function userBrowserApplies(chat, { toolset = "" } = {}) {
  if (!chat?.id || toolset) return false;
  // Only the suites of the gate (tools/check/targets/check.mjs): no Chromium per test turn. Here and not at the start so
  // description (the sentence in the system prompt) and execution give the same answer.
  if (process.env.CBASE_CHAT_BROWSER_OFF === "1") return false;
  if ((chat.kind || "normal") !== "normal" || chat.specialRole) return false;
  try {
    if (store.graphStartOfChild(chat.id)) return false;
    if (store.workflowOpenFor(chat.id)) return false;
  } catch { return false; }
  return true;
}

/** The fixed sentence in the system prompt of a turn for which userBrowserApplies — fixed per chat, so no cost for the cache. */
export const CHAT_BROWSER_SENTENCE = "# Browser\nYour browser (mcp__playwright__*) is this chat's browser: the same one the human sees in the "
  + "right chat rail — they watch you and can work along, their open tabs and logins are in it. For your own work "
  + "you open a new tab (browser_tabs new). Tabs you did not open yourself you do not close without a reason — not with "
  + "browser_close or browser_tabs close either. You change cookies and storage only when the task requires it.";

// The fallback of the previous turn per chat — "back in the chat browser" comes only after a fallback (hints are "what
// changed since your last turn"). A server restart forgets it: then this one hint is missing.
const fallback = new Set(); // chatId
const HINT_AGAIN = "Your browser (mcp__playwright__*) is again this chat's browser, the one the human sees.";
const hintError = (reason) => `This chat's browser could not be started for this turn (${reason}). Your browser `
  + "(mcp__playwright__*) is therefore one of its own in this chat's profile — without the human's tabs, and they are not watching you. Tell "
  + "them if your task needs their browser.";

/**
 * At turn start (runs/do-run.js, before writeMcpConfig). `null` ⇒ this turn has nothing to do with it (own profile).
 * Otherwise `{ cdpEndpoint, scopeKey, approve }` (the turn calls `approve` in its finally) or `{ error }` — then the turn
 * runs with its Playwright profile, and both model (hint in THIS turn) and human (bell) learn of it.
 */
export async function userBrowserForRun(chat, { instance = null, toolset = "" } = {}) {
  if (!userBrowserApplies(chat, { toolset })) return null;
  let target = null;
  let hold = null;
  try {
    target = chatBrowserTarget(chat, { instance });
    const b = await ensureUserBrowser(target);
    if (b?.error) throw new Error(String(b.error));
    hold = holdForAgent(target.scopeKey, chat.id, { instance });
    if (!hold) throw new Error(T("the browser closed right after starting"));
    if (fallback.delete(chat.id)) depositHint(chat.id, HINT_AGAIN, { source: "chat-browser" });
    return { cdpEndpoint: `http://127.0.0.1:${hold.debugPort}`, scopeKey: target.scopeKey, approve: hold.approve };
  } catch (e) {
    hold?.approve(); // a throw AFTER holding (e.g. when depositing the hint) would otherwise hold the browser forever
    const reason = String(e?.message || e).slice(0, 300);
    console.error(`[chat-browser] ${chat.id}: the chat's browser is unavailable, turn runs with its own profile:`, reason);
    fallback.add(chat.id);
    try {
      depositHint(chat.id, hintError(reason), { source: "chat-browser" });
      recordNotice({
        kind: "info",
        title: T`Agent uses its own profile: ${chat.title || "Chat"}`,
        chatTitle: chat.title || "",
        body: T`This chat's browser could not be started (${reason}). The agent works in a browser of its own this turn.`,
        chatId: chat.id, workspaceId: chat.workspaceId || null, projectId: chat.projectId || null,
        collapseId: `${chat.id}-chat-browser`,
      });
    } catch { /* hint and notification must never hold up the turn */ }
    return { error: reason, scopeKey: target?.scopeKey || "" };
  }
}

/** Close the chat's browser and wait (logins back in the stocks); afterwards its profile may go. Never throws. */
export async function closeChatBrowser(chatId) {
  try { return await closeUserBrowser(`chat:${chatId}`); } catch { return false; }
}

/**
 * POST /api/chats/:id/browser/ensure — this chat's browser for the view (right chat rail, browser tab of the code tabs).
 * An archived chat never gets here (write lock in chats/routes.js). Neither does an agent with the token of an instance
 * (`ctx.fence`): its turn opens the browser itself (userBrowserForRun). At the cap 429 with the message. Sub-slice of
 * chats/routes.js.
 */
export async function userBrowserChatRoutes(ctx) {
  const { res, id, sub, m } = ctx;
  if (sub === "/browser/ensure" && m === "POST") {
    if (ctx.fence) return send(res, 403, { error: T("A chat's browser is opened by the UI and the turn.") });
    const chat = store.getChat(id);
    if (!chat) return send(res, 404, { error: "chat not found" });
    try {
      const instance = chat.projectId ? instanceOfChat(chat, locationForChat(chat)) : null;
      return send(res, 200, await ensureUserBrowser(chatBrowserTarget(chat, { instance })));
    } catch (e) {
      if (e?.code === CHAT_BROWSER_CAP_CODE) return send(res, 429, { error: String(e.message), cap: true });
      return send(res, 200, { error: String(e?.message || e) });
    }
  }
  return NEXT;
}
