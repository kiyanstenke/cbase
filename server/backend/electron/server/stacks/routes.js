// Routes of the copies of a stack. A sub-slice of the owner `projectRoutes` (projects/routes.js, sub-table) — ctx carries
// `pid`, `sub`, `proj` there. Called by the web client and by the tools cbase_copy_stack* (mcp/tools/stacks.js) from the
// project container.
//
//   POST /api/projects/:pid/stack-copies          body `{ chatId?, name?, base?, baseInstance? }` (other fields: 400).
//                                                 WITHOUT `chatId` a human creates it — no inset, no wake call (the
//                                                 copy event suffices); WITH `chatId` (the tool cbase_copy_stack) this
//                                                 chat moves in at `ready` (`inset`). A chat creates any number.
//                                                 `baseInstance` (string, default "main"): also `copy-<name>` — a ready
//                                                 copy of the same project as template (400 BASE_INSTANCE_INVALID, 409
//                                                 TEMPLATE_UNKNOWN/TEMPLATE_NOT_READY/TEMPLATE_UNREADABLE). Checks via
//                                                 stacks/request.js submitCopyRequest, creates the row `waiting_queue`
//                                                 and wakes the queue — the procedure is started by the queue
//                                                 (stacks/queue.js), never by this route. Answer 202 `{ copy }`: the row
//                                                 as it stands after the queue's pass (it wakes in the next microtask,
//                                                 ONE synchronous step — started then means `build`/`clone1`). A no is
//                                                 `{ error, code }` with the status of the check.
//   GET  /api/projects/:pid/stack-copies          `{ copies, main }` — the live copies of the project; `?all=1` also
//                                                 the removed ones; `main` = `{ instance: "main", state }` (state of
//                                                 the instance row, null without one) — the tool list shows all
//                                                 instances
//   GET  /api/projects/:pid/stack-copies/:name/state  the delete preview (stacks/status.js copyStatus) — 200
//                                                 `{ loaded: true, repos: [{ rel, name, branch, detached, commits, open,
//                                                 openCount, fresh }], chats: [{ id, title, running }] }` or
//                                                 `{ loaded: false, error }`; read IN the copy. Only for a ready copy
//                                                 with a ready instance (otherwise 409 COPY_STATE with `state`); no live
//                                                 one: 404. Refused from a project network (the fence).
//   GET  /api/projects/:pid/stack-copies/:name    `{ copy }` — the live one of this name, otherwise the latest removed
//                                                 one; 404
//   POST /api/projects/:pid/stack-copies/:name/fetch  body `{ retrieve? }` (other fields: 400). Fetches the commits of
//                                                 the LIVE copy of this name into the main instance (stacks/fetch.js
//                                                 copyFetch) — idempotent; 200 `{ result }`, a no `{ error, code }` with
//                                                 the status of the error (404 no live copy, 409 not ready/OCCUPIED).
//                                                 `retrieve` on FETCH: only paths of NEW repos of the copy (their
//                                                 bundle is cloned back; every other path is listed as rejected) —
//                                                 ignored files of the upper layer are only retrieved by the clearing
//                                                 away, if its `retrieve` names them.
//   DELETE /api/projects/:pid/stack-copies/:name  body `{ retrieve?, chatId? }` (other fields: 400) — clear away the
//                                                 live copy of this name, via stacks/remove.js removeCopy. Answer 202
//                                                 `{ copy, job, neverBuilt, dismissed }` at once: a `ready` one is then
//                                                 `clearAway`/`earmarked` (only in stack_copies, the instance row stays
//                                                 `ready` and does not hold `busy`) or already being cleared away, a
//                                                 waiting one is `removed`. It is executed as soon as the copy is empty
//                                                 (instanceIdle; from the copy itself so only after the turn); the
//                                                 RESULT comes as a wake call into the chat. No live copy: 404. Trigger
//                                                 "rest"/"human"; through the fence (from a project container, the tool
//                                                 cbase_copy_stack_remove) "tool"/"agent". `neverBuilt`: the copy was in
//                                                 `error` and was never ready — its clearing away is only the
//                                                 dismantling, it fetches and backs up nothing (stacks/inset.js
//                                                 neverBuilt, the same condition as stacks/clearAway.js). `dismissed`:
//                                                 the request was still WAITING (stacks/inset.js waitingStill, the same
//                                                 condition as stacks/remove.js) — it is dismissed (`removed`, never
//                                                 built, nothing to fetch, NO wake call, only a silent notice);
//                                                 `neverBuilt` stays false there. If the server is just ending, the
//                                                 restart dismisses it — a waiting row with a job never begins.
//                                                 FIRST the lock (stacks/remove.js removeLock) — if another chat or
//                                                 something without a chat works in the copy, 409 INSTANCE_WORKING
//                                                 `{ error, code, chats, open }`, no job. `earmarked` exists only for
//                                                 the calling agent's own turn: `chatId` is sent by the tool, the route
//                                                 checks it against the fence token (`ctx.fence.chatReason`, 403) —
//                                                 without the fence `chatId` is 400, and a human via REST gets 409 for
//                                                 ANY work. The wake call then goes to the calling chat.
//   Every row WITHOUT `journal` (mechanics of the procedure), with `result` (stacks/result.js — never a value). Plus
//   `createdOf: { chatId, title } | null` (the creating chat; `title` null if it no longer exists), `baseInstance` and
//   `inset` (boolean); `chatId` stays next to it (tool cbase_copy_stack_list, older clients).
//
// Without projectboxOps() every route answers 404 before anything is read. From a project network the fence governs
// them (projectbox/fence-table.js): scope the OWN project, creating only with the token of the main instance and only
// for a chat of this instance (with the token of a copy 409), list, row, fetch and clearing away with both tokens;
// every other method or sub-route is 403 there. The tools are only seen by a run in a relocated project
// (mcp/visibility.js lockedForInstance). What the fence does NOT check and the route does itself: coding chat (403),
// archived/not relocated/occupied (409), name and base (form 400; a base that knows no repo in the main instance, 409
// COPY_BASE — the pre-check in stacks/request.js).
//
// Guards: server/backend/test/stacks-routes.test.js, server/backend/test/stacks-fetch.test.js (fetch), DELETE in
// server/backend/test/stacks-remove.test.js; the sub-slice in server/backend/test/dispatcher.test.js; the fence in
// server/backend/test/fence-stacks.test.js, the tools in server/backend/test/copy-tools.test.js.
import * as store from "../store.js";
import { T } from "../i18n.js";
import { NEXT, readBody, send } from "../runtime/http.js";
import { ONLY_IN_OPS, projectboxOps } from "../projectbox/ops.js";
import { submitCopyRequest } from "./request.js";
import { copyFetch } from "./fetch.js";
import { removeLock, removeCopy } from "./remove.js";
import { copyStatus } from "./status.js";
import { copyInstance } from "../projectbox/creation.js";
import { neverBuilt, waitingStill } from "./inset.js";
import { removeJob } from "./state.js";

const BODY_FIELDS = ["chatId", "name", "base", "baseInstance"];
const FETCH_FIELDS = ["retrieve"];
const withoutJournal = (k) => {
  if (!k) return null;
  const { journal: _journal, ...rest } = k;
  // The creating chat with its title (the UI names it in the tree) — null if a human created it.
  const chat = k.chatId ? store.getChat(k.chatId) : null;
  // The chats that work in it (`chats.instance`) — the tool cbase_copy_stack_list derives "this chat works here" from
  // it; a removed copy has none anymore (moving out reset them).
  const chatIds = k.state === "removed" ? [] : store.chatsInInstance(k.projectId, copyInstance(k.name));
  return { ...rest, createdOf: k.chatId ? { chatId: k.chatId, title: chat ? chat.title : null } : null, chatIds };
};

const DELETE_FIELDS = ["retrieve", "chatId"];

/** The body of a DELETE (empty is `{}`) → `{ retrieve, chatId }`; throws with a sentence. `chatId` (optional) is named
 *  by the caller through the fence — the tool cbase_copy_stack_remove sends the chat whose agent clears away. */
export function removeFromBody(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error(T("The body is not a JSON object"));
  const unknown = Object.keys(d).filter((k) => !DELETE_FIELDS.includes(k));
  if (unknown.length) throw new Error(T`unknown fields: ${unknown.join(", ")} (allowed: ${DELETE_FIELDS.join(", ")})`);
  const r = d.retrieve ?? [];
  if (!Array.isArray(r) || r.some((x) => typeof x !== "string" || !x)) throw new Error(T("`retrieve` is a list of paths (strings)"));
  if (d.chatId !== undefined && d.chatId !== null && (typeof d.chatId !== "string" || !d.chatId)) throw new Error(T("`chatId` is a string (the chat of the calling agent) or absent"));
  return { retrieve: r, chatId: d.chatId ?? null };
}

/** The body of a POST (readBody: empty is `{}`) → `{ chatId, name, base, baseInstance }`; throws with a sentence.
 *  `chatId` is optional (absent or null: a human creates it), but if given, a non-empty string. */
export function requestFromBody(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error(T("The body is not a JSON object"));
  const unknown = Object.keys(d).filter((k) => !BODY_FIELDS.includes(k));
  if (unknown.length) throw new Error(T`unknown fields: ${unknown.join(", ")} (allowed: ${BODY_FIELDS.join(", ")})`);
  if (d.chatId !== undefined && d.chatId !== null && (typeof d.chatId !== "string" || !d.chatId)) throw new Error(T("`chatId` is a string (or absent: then a human creates the copy)"));
  if (d.name !== undefined && d.name !== null && typeof d.name !== "string") throw new Error(T("`name` is a string"));
  if (d.baseInstance !== undefined && d.baseInstance !== null && (typeof d.baseInstance !== "string" || !d.baseInstance)) throw new Error(T("`baseInstance` is a string (default \"main\")"));
  return { chatId: d.chatId ?? null, name: d.name ?? null, base: d.base === undefined ? null : d.base, baseInstance: d.baseInstance ?? "main" };
}

/** The body of `…/fetch` (readBody: empty is `{}`) → `{ retrieve }`; throws with a sentence. */
export function fetchFromBody(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error(T("The body is not a JSON object"));
  const unknown = Object.keys(d).filter((k) => !FETCH_FIELDS.includes(k));
  if (unknown.length) throw new Error(T`unknown fields: ${unknown.join(", ")} (allowed: ${FETCH_FIELDS.join(", ")})`);
  if (d.retrieve !== undefined && (!Array.isArray(d.retrieve) || d.retrieve.some((r) => typeof r !== "string"))) throw new Error(T("`retrieve` is a list of paths"));
  return { retrieve: d.retrieve || [] };
}

const errorResponse = (res, e, where) => {
  const status = Number.isInteger(e?.status) && e.status >= 400 && e.status < 600 ? e.status : 500;
  if (status === 500) console.error(`[stacks] ${where}:`, e?.message || e);
  // The work lock carries `chats` and `open` (projectbox/idle.js) — they go out with the answer.
  const extra = e?.code === "INSTANCE_WORKING" ? { error: String(e?.message || e), chats: e.chats || [], open: e.open || [] } : {};
  return send(res, status, { error: String(e?.message || e), ...(e?.code ? { code: String(e.code) } : {}), ...extra });
};

export async function stackCopyProjectRoutes(ctx) {
  const { req, res, url, m, pid, sub } = ctx;
  const t = sub.match(/^\/stack-copies(?:\/([^/]+)(\/fetch|\/state)?)?$/);
  if (!t) return NEXT;
  if (!projectboxOps()) return send(res, 404, { error: ONLY_IN_OPS });
  let name = null;
  try { name = t[1] ? decodeURIComponent(t[1]) : null; } catch { return send(res, 400, { error: T("Name of the copy: broken encoding") }); }

  if (name === null && m === "POST") {
    let a;
    try { a = requestFromBody(await readBody(req)); } catch (e) { return send(res, 400, { error: String(e?.message || e) }); }
    try {
      const k = await submitCopyRequest({ projectId: pid, chatId: a.chatId, name: a.name, base: a.base, baseInstance: a.baseInstance });
      // The queue wakes in the next microtask; only afterwards is it settled whether it has started.
      await Promise.resolve();
      return send(res, 202, { copy: withoutJournal(store.stackCopy(k.id) || k) });
    } catch (e) { return errorResponse(res, e, `request ${pid}`); }
  }

  if (name === null && m === "GET") {
    const all = url.searchParams.get("all") === "1";
    // Plus the main instance (state of its instance row, null without one) — the tool list shows ALL instances of the project.
    const main = store.projectInstance(pid, "main");
    return send(res, 200, { copies: (all ? store.stackCopiesOf(pid) : store.liveStackCopies(pid)).map(withoutJournal), main: { instance: "main", state: main?.state ?? null } });
  }

  if (t[2] === "/state") {
    if (m !== "GET") return NEXT;
    const k = store.liveStackCopy(pid, name);
    if (!k) return send(res, 404, { error: T`no live copy "${name}" in project ${pid}` });
    const inst = store.projectInstance(pid, copyInstance(name));
    if (k.state !== "ready" || inst?.state !== "ready") {
      const state = k.state !== "ready" ? k.state : inst?.state ?? null;
      return send(res, 409, { error: T`the copy "${name}" is not ready (${state ?? T("without an instance row")}) — its status can only be read from a running copy`, code: "COPY_STATE", state });
    }
    return send(res, 200, await copyStatus(k));
  }

  if (t[2]) {
    if (m !== "POST") return NEXT;
    let a;
    try { a = fetchFromBody(await readBody(req)); } catch (e) { return send(res, 400, { error: String(e?.message || e) }); }
    const k = store.liveStackCopy(pid, name);
    if (!k) return send(res, 404, { error: T`no live copy "${name}" in project ${pid}` });
    try {
      return send(res, 200, { result: await copyFetch(k.id, { retrieve: a.retrieve }) });
    } catch (e) { return errorResponse(res, e, `fetch ${pid}/${name}`); }
  }

  if (name !== null && m === "GET") {
    const k = store.liveStackCopy(pid, name) || store.stackCopiesOf(pid).filter((x) => x.name === name).pop() || null;
    if (!k) return send(res, 404, { error: T`no copy "${name}" in project ${pid}` });
    return send(res, 200, { copy: withoutJournal(k) });
  }

  if (name !== null && m === "DELETE") {
    let a;
    try { a = removeFromBody(await readBody(req)); } catch (e) { return send(res, 400, { error: String(e?.message || e) }); }
    // A call through the fence (`ctx.fence`, from a project container) is the tool cbase_copy_stack_remove — its trigger
    // is "tool" and its caller "agent" (stacks/remove.js); otherwise a human calls via REST or the UI.
    const fromTool = Boolean(ctx.fence);
    // Only the tool names the caller's chat, and it must be a chat of its token's instance (the fence context's
    // chatReason, the same check as `:chat` of the fence rows) — a token claims no foreign chat. Without the fence there
    // is no agent chat. The wording "Fence: …" belongs to the fence family of messages and stays as it is.
    if (a.chatId && !fromTool) return send(res, 400, { error: T("`chatId` is only named by the tool from a project container — a human clears away without a chat") });
    if (a.chatId) {
      const reason = ctx.fence.chatReason(a.chatId);
      if (reason) return send(res, 403, { error: `Fence: \`chatId\` — ${reason}` });
    }
    const k = store.liveStackCopy(pid, name);
    if (!k) return send(res, 404, { error: T`no live copy "${name}" in project ${pid}` });
    // The lock BEFORE the job — if something other than the calling agent's own turn works in the copy, 409
    // INSTANCE_WORKING with the list; no job is written to the journal, nothing is touched.
    try { removeLock(k, { caller: a.chatId }); } catch (e) { return errorResponse(res, e, `remove ${pid}/${name}`); }
    try {
      // Do not await: the clearing away takes time (fetch, back up) or waits for idle — the result comes as a wake call.
      const never = neverBuilt(k); // read BEFORE the job: afterwards the row can already be `removed`
      const dismissed = waitingStill(k); // likewise: the request was waiting — the job dismisses it (head)
      const from = fromTool ? (a.chatId ? { who: "agent", chatId: a.chatId } : "agent") : "human";
      removeCopy(k.id, { reason: fromTool ? "tool" : "rest", retrieve: a.retrieve, from })
        .catch((e) => console.error(`[stacks] remove ${pid}/${name}:`, e?.message || e));
      await Promise.resolve();
      const now = store.stackCopy(k.id) || k;
      return send(res, 202, { copy: withoutJournal(now), job: removeJob(now), neverBuilt: never, dismissed });
    } catch (e) {
      const status = e instanceof TypeError ? 400 : 500;
      if (status === 500) console.error(`[stacks] remove ${pid}/${name}:`, e?.message || e);
      return send(res, status, { error: String(e?.message || e) });
    }
  }
  return NEXT;
}
