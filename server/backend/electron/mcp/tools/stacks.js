// MCP tools: create, list, fetch and clear a copy of a project — cbase_copy_stack (create), cbase_copy_stack_list,
// cbase_copy_stack_fetch (fetch without clearing) and cbase_copy_stack_remove. They call the REST routes of the copies
// (server/stacks/routes.js); the checks, the queue and the procedure live there — the tools pass through and explain what the
// agent does next.
//
// WHO SEES THEM (description side = execution side, mcp/visibility.js lockedForInstance): only a run in a RELOCATED project — the
// MCP server knows it by the instance identifier (`CBASE_INSTANCE`, toolchain/mcp-config.js); a chat without it sees none of the
// four (no copy of a project that was not relocated). In the chat of a COPY only `cbase_copy_stack` is missing (nothing is created
// from a copy — the fence answers 409 there, projectbox/fence-table.js `onlyFromMain`); fetch, list and clear stay, because the
// agent in the copy fetches and clears it itself. Every agent of a coding chat may, a subagent of any depth too (not in
// alwaysLocked); an agent of a dynamic workflow only `_list` (an inset in the middle of a workflow would split its agents across two
// instances). The group stands LAST in the catalog (the prefix before it stays the same, prompt cache). The descriptions are fixed
// and carry no runtime values.
//
// What the answers say: the request returns at once and may WAIT — `copy.state` is `waiting_queue` (another build in the project, a
// heavy disk operation in B) or `waiting_storage` (the save gate), `copy.reason` names why; `build` means it is running. In all
// three cases the agent ends its turn: on `ready` cbase wakes the chat with a follow-up turn that runs IN the copy.
//
// A copy belongs to no chat any more. `_list` shows ALL instances of the project (the main and every copy, with `createdOf` and
// `thisChatWorksHere`); `_fetch` and `_remove` work with ANY copy of the project. `_remove` sends the own chat along (`chatId`): if
// ANOTHER chat works in the copy, that is 409 INSTANCE_WORKING with a list — only the own turn waits (`earmarked`), and the wakeup
// with the result comes into THIS chat. Agents always fetch everything (no discarding). cbase_switch_instance sets the instance of
// the OWN chat (POST /api/chats/:id/instance); the running turn stays where it is, the chat wakes up in the new one at the turn
// end. Stopping and starting an instance stay with the human.
//
// cbase_copy_stack takes `baseInstance` — "main" (default) or "copy-<name>" of a READY copy of this project as the template; the
// same form as the REST body (stacks/routes.js BODY_FIELDS), checked in the route (stacks/request.js templateOf: 400
// BASE_INSTANCE_INVALID, 409 TEMPLATE_UNKNOWN / TEMPLATE_NOT_READY / TEMPLATE_UNREADABLE — the error reaches the agent with the
// route's sentence). An empty text or anything but a text does not go out: then the route's default (main) applies. Creation still
// happens only from the main; the template may be any ready copy.

import process from "node:process";
import { JOB_SENTENCE, api, enc, inJobChat, needChat, obj, pidFor, str } from "../lib.js";

// From the answer of GET …/stack-copies ALL instances — the main first, then the copies (createdOf, chatIds of the route).
// `thisChatWorksHere` follows the binding of the chat (`chats.instance`): a copy whose chatIds name it; otherwise the main.
export function instancesFrom(r, chat) {
  const copies = Array.isArray(r?.copies) ? r.copies : [];
  const inCopy = copies.some((k) => Array.isArray(k.chatIds) && k.chatIds.includes(chat));
  const main = { instance: "main", state: r?.main?.state ?? null, thisChatWorksHere: Boolean(chat) && !inCopy };
  return [main, ...copies.map(({ chatIds, ...k }) => ({
    instance: `copy-${k.name}`, ...k,
    thisChat: Boolean(chat) && k.chatId === chat,
    thisChatWorksHere: Boolean(chat) && Array.isArray(chatIds) && chatIds.includes(chat),
  }))];
}

// The route returns the row of the copy after ONE pass of the queue (stacks/routes.js): started then means `build`.
function creationHint(copy) {
  // A chat with a scheduled job does not move in (stacks/request.js) — no wakeup, no switch.
  if (copy && copy.inset === false && copy.chatId) return `The copy is created WITHOUT an inset: ${JOB_SENTENCE}. This chat keeps working where it is and is not woken on “ready”; fetching and clearing work like for any copy.`;
  const z = String(copy?.state || "");
  const reason = String(copy?.reason || "").trim();
  const front = z === "waiting_queue" || z === "waiting_storage"
    ? `The request is WAITING (${z}${reason ? `: ${reason}` : ""}) — it starts by itself as soon as the queue is free${z === "waiting_storage" ? " and there is enough storage" : ""}.`
    : z === "build"
      ? `The copy is being built${copy?.phase ? ` (phase ${copy.phase})` : ""}.`
      : `The copy is in the state ${z || "?"}.`;
  return `${front} End your turn now: on “ready” cbase wakes this chat with a follow-up turn that runs IN the copy — everything you start anew afterwards (Bash, file tools, subagents, terminal, browser, services) runs there, the main stays untouched. If the build fails, you learn it as a system message and keep working in the main.`;
}

// The hint on clearing hangs on the copy: a NEVER built one (`error`, never ready) is only rolled back — there is nothing in it to
// fetch or save, and the system message afterwards says “never built”. The route names it (`neverBuilt` from stacks/inset.js
// neverBuilt — the same condition by which stacks/clearAway.js only rolls back); here is no second copy of the condition, only the
// choice of the sentence.
// A request that was still WAITING is already dismissed with the call (`dismissed` from stacks/inset.js waitingStill: `removed`,
// never built, no wakeup — only a quiet hint to the chat of the copy). The general sentence would promise fetching, saving and a
// system message that never comes. The way to a new copy is named only if it was the request of THIS chat: then it works in the
// main, where cbase_copy_stack is offered; the request of another chat changes nothing about the caller's work.
function clearingHint(r, { chatId = "" } = {}) {
  if (r?.dismissed === true) {
    const own = Boolean(chatId) && r?.copy?.chatId === chatId;
    return `Done: the request was still waiting and is dismissed — the copy was never built, there is nothing to fetch or save, and no message will follow (do not wait for it).${own ? " This chat keeps working in the main; a new copy goes with cbase_copy_stack." : " Another chat (or a human) had requested it; nothing changes about your work."}`;
  }
  if (r?.neverBuilt === true) {
    return "The request is accepted: the copy was never built (its build failed) — only the remains of its build are removed, there is nothing in it to fetch or save. The result comes as a system message; after that a new attempt goes with cbase_copy_stack.";
  }
  return "The request is accepted: the copy is cleared as soon as it is empty (from the copy itself after the end of this turn). First it is fetched and saved, then removed; the result comes as a system message.";
}

const stackTools = [
  {
    name: "cbase_copy_stack",
    // Kept short because of the length guard (server/backend/test/mcp-description-length.test.js): the name rule stands at the field
    // `name`, the ref rules (no reflog entries, no stash, no pseudo refs; `@{u}`/`@{upstream}`/`@{push}` work) in the route's
    // error (stacks/request.js baseError/onlyInMain), which comes exactly when one of them applies; copy-tools.test.js checks them there.
    description: "Creates a COPY of this project: a second project container for safe experimenting, without touching the running main. Own network and Docker, clones of the volumes and of the code; creation happens only from the main (in a copy this tool is missing). The call returns at once; the request may wait (`waiting_queue` or `waiting_storage`); a failed copy stays until it is cleared. End your turn afterwards: on “ready” cbase wakes this chat, and from then on everything you start anew runs IN the copy — code state of the base instance at the time of freezing including open changes, what ran there is started. `baseInstance` (optional): \"main\" (default) or \"copy-<name>\" of a READY copy of this project — a copy from a copy takes over its whole state including index, reflogs and stashes (the template pauses briefly for that). `base` (optional): the code state as a ref — a text (branch, tag, commit; applies in every repo that knows it) or `{ \"<repo path relative to the project folder>\": \"<ref>\" }`; with `base` NO open changes come along. If the template is not ready or no repo knows the base, THIS call answers at once with an error, and no request is created (the error names the rule, also for refs that never exist in a copy). Only what changes until the freezing can fail at the build — also the place of a relative ref like `HEAD~2` in the project folder, which gets a commit of its own before the copy.",
    inputSchema: obj({
      name: str("Name of the copy (optional): a–z, 0–9 and “-” (not at the edge), 1–24 characters; without it k1, k2, …"),
      baseInstance: str("Instance the copy arises from (optional): “main” (default) or “copy-<name>” of a ready copy of this project"),
      base: {
        description: "Code state the copy starts from (optional): a ref as text or { \"<relPath>\": \"<ref>\" } per repo",
        anyOf: [{ type: "string" }, { type: "object", additionalProperties: { type: "string" } }],
      },
    }),
    handler: async (a) => {
      const pid = await pidFor({});
      const body = { chatId: needChat() };
      if (typeof a.name === "string" && a.name.trim()) body.name = a.name.trim();
      // The template — only a non-empty text goes out; otherwise the route's default (main) applies, never a guessed value.
      if (typeof a.baseInstance === "string" && a.baseInstance.trim()) body.baseInstance = a.baseInstance.trim();
      if (a.base !== undefined && a.base !== null) body.base = a.base;
      const r = await api("POST", `/api/projects/${enc(pid)}/stack-copies`, body);
      return { ...r, hint: creationHint(r?.copy) };
    },
  },
  {
    name: "cbase_copy_stack_list",
    description: "Lists ALL instances of this project — the main and every copy — with state, creator and the indication where THIS chat works. First the main (`instance: \"main\"`, `state`), then every copy (`instance: \"copy-<name>\"`, `name`, `state` — waiting_queue, waiting_storage, build, ready, clearAway, error; with `all` also removed —, `reason` or `error`, `createdOf` { chatId, title } or null if a human created it, `thisChat`: did this chat create it?) — and for a ready copy the `result` (what came along, what is missing, which targets stay real, address). For each instance `thisChatWorksHere` says where THIS chat works (its instance, not who created a copy); switching goes with cbase_switch_instance. Every copy of the project you can fetch (cbase_copy_stack_fetch) and clear (cbase_copy_stack_remove), a foreign one too. `all`: also show already removed copies (their backup lies under `copy/<name>/…` in the main).",
    inputSchema: obj({ all: { type: "boolean", description: "also removed copies (default: only living ones)" } }),
    handler: async (a) => {
      const pid = await pidFor({});
      const chat = process.env.CBASE_CHAT_ID || "";
      const r = await api("GET", `/api/projects/${enc(pid)}/stack-copies${a.all === true ? "?all=1" : ""}`);
      return { instances: instancesFrom(r, chat) };
    },
  },
  {
    name: "cbase_copy_stack_fetch",
    description: "Fetches the commits of a ready copy into the main without clearing the copy (it lives on; fetching again is safe and fetches only what is new). That works with any copy of this project, also one that another chat or a human created. Fetching is lossless into the branch space `copy/<name>/…` of the main — never into a checked-out branch —; new branches, moved branches, a detached HEAD, stashes, tags and new repos of the copy come along, plus a backup of the open changes. Merging then happens in the main with an ordinary git step (merge, cherry-pick). The answer names per repo what was fetched (`target`), and `trap`: files that are already openly changed in the main and collide when merging. Only for a copy in the state ready (otherwise an error with the reason). `name`: the copy (cbase_copy_stack_list shows the names).",
    inputSchema: obj({ name: str("Name of the copy (from cbase_copy_stack_list)") }, ["name"]),
    handler: async (a) => {
      const pid = await pidFor({});
      const r = await api("POST", `/api/projects/${enc(pid)}/stack-copies/${enc(String(a.name || ""))}/fetch`, {});
      return { ...r, hint: `Fetched to copy/${String(a.name)}/… in the main. Merging works there with an ordinary git step; the copy lives on (cbase_copy_stack_remove clears it).` };
    },
  },
  {
    name: "cbase_copy_stack_remove",
    description: "Clears a copy — any copy of this project, a foreign one too: first cbase fetches its commits into the main and saves everything open, then it is removed. Nothing git sees is lost in the process — there is no discarding; containers, network and volume clones are removed. If ANOTHER chat (turn, subagent, workflow, monitor) or something without a chat is working in the copy right now, the call refuses (error INSTANCE_WORKING with the list) — wait or talk to it. If only YOUR own turn runs in it, the clearing happens after the end of this turn (otherwise you would lose your own container) — end it then; the result comes as a system message into this chat. A request that is still WAITING (`waiting_queue`, `waiting_storage`) is dismissed at once instead: never built, nothing to fetch, and no system message comes. `retrieve` (optional): paths relative to the project folder that should come back into the main — new repos of the copy (brought back CLONED, otherwise only as a bundle in the backup) and files or folders ignored by git that the copy wrote itself (for instance `.env`, data folders, build outputs): such ones come back ONLY if you name them here, otherwise they appear only in the report and fall with the copy. What the copy deleted is never deleted in the main; an occupied or inadmissible path is rejected and named in the result.",
    inputSchema: obj({
      name: str("Name of the copy (from cbase_copy_stack_list)"),
      retrieve: { type: "array", items: { type: "string" }, description: "Paths relative to the project folder that should go back into the main (optional): new repos of the copy and files or folders ignored by git that the copy wrote" },
    }, ["name"]),
    handler: async (a) => {
      const pid = await pidFor({});
      // The own chat — the route checks it against the fence token and accepts only its own turn as a reason to wait.
      const body = { chatId: needChat() };
      if (Array.isArray(a.retrieve)) body.retrieve = a.retrieve.map(String);
      const r = await api("DELETE", `/api/projects/${enc(pid)}/stack-copies/${enc(String(a.name || ""))}`, body);
      return { ...r, hint: clearingHint(r, { chatId: process.env.CBASE_CHAT_ID || "" }) };
    },
  },
  {
    // The binding of the OWN chat — the same check as the PATCH of a human (runs/instance-switch.js instanceChoice), plus the wakeup
    // at the turn end (chats/routes.js instanceChatRoutes).
    name: "cbase_switch_instance",
    description: "Switches the instance in which THIS chat works: `main` or `copy-<name>` of a ready copy of this project (cbase_copy_stack_list shows the names). The running turn stays where it began — everything it has already started keeps running there. End your turn afterwards: cbase wakes this chat with a follow-up turn, and from then on everything you start ANEW (Bash, file tools, subagents, terminal, browser, services) runs in the new instance. If the chat already works there, nothing changes. A copy that is not ready or is being cleared is an error (UNKNOWN_INSTANCE).",
    inputSchema: obj({ instance: str("“main” or “copy-<name>”") }, ["instance"]),
    handler: async (a) => {
      const chatId = needChat();
      const instance = String(a.instance || "").trim();
      if (!instance) throw new Error("`instance` is missing — “main” or “copy-<name>”.");
      if (await inJobChat(chatId)) return { instance, changed: false, hint: JOB_SENTENCE }; // only the human may
      const r = await api("POST", `/api/chats/${enc(chatId)}/instance`, { instance });
      const hint = r?.changed
        ? `This chat works in ${r.instance} from the next turn on. End your turn now — cbase wakes it there.`
        : `This chat already works in ${r?.instance || instance} — nothing changed.`;
      return { instance: r?.instance || instance, changed: Boolean(r?.changed), hint };
    },
  },
];

export { stackTools };
