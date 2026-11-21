// Routes: the library of dynamic workflows and everything a chat does with a run. Every function takes ctx = { req,
// res, url, p, m } plus the fields of its family and returns NEXT when it is not responsible; any other return value
// means "answered".
// Functions: dynWorkflowChatRoutes (sub-table of chats/routes.js:chatRoutes — the paths of the MCP tools
// cbase_dynamic_workflow_list/_save, cbase_dynamic_workflow and _stop (run.js), the stop by the human, the ruling at
// the approval card /dyn-workflows/approval, the StructuredOutput messenger /dyn-workflows/structured-output, the
// progress tree /dyn-workflows/tree, the transcript per agent /dyn-workflows/runs/:runId/agents/:n, and skip and
// restart per workflow agent …/agents/:n/skip and …/restart) · dynWorkflowWorkspaceRoutes (sub-table of
// workspaces/routes.js — list, view, delete) · dynWorkflowProjectRoutes (sub-table of projects/routes.js:projectRoutes
// — the takeover per project).
//
// The script is stored BYTE-EQUAL; `meta` is read by script.js:checkScript with the same parser that reads a script
// before the run — a script stored here is one that also runs (and runs in Claude Code).

import crypto from "node:crypto";
import { T } from "../i18n.js";
import { NEXT, readBody, send } from "../runtime/http.js";
import {
  readDynAgentHistory, dynRunInChat,
  createDynWorkflow, deleteDynWorkflow, effectiveDynWorkflows, getChat, getDynWorkflow, getDynWorkflowByName, isUniqueViolation,
  listDynWorkflows, listEnabledDynWorkflowNames, setDynWorkflowEnabled, skillCarriesNames,
} from "../store.js";
import { dynTrees, decideApproval, restartDynAgent, startDynWorkflow, stopDynWorkflow, skipDynAgent, readAloudCopy } from "./run.js";
import { dynApprovalDecided } from "../workflows/gates.js";
import { channelAfterDelivery } from "../channels/delivery.js";
import { RESERVED_NAMES, nameForbidden } from "./names.js";
import { MetaError, ScriptError, checkScript } from "./script.js";
import { takeOutput } from "./structured.js";

// What a list shows: meta without the script. `meta` itself is the normalised literal (name, description, title,
// whenToUse, phases); the fields next to it are the same values, flat — for lists that do not want to reach into meta.
function entryShort(w) {
  const meta = w.meta || {};
  return {
    id: w.id, name: w.name, description: meta.description || "", title: meta.title ?? null,
    whenToUse: meta.whenToUse ?? null, phases: Array.isArray(meta.phases) ? meta.phases : [], createdAt: w.createdAt, updatedAt: w.updatedAt,
  };
}
const entryFull = (w) => ({ ...entryShort(w), meta: w.meta || {}, script: w.script });

function nameError(kind, name) {
  if (kind === "form") {
    return T`The name "${name}" does not work as /name: 1–64 characters from letters, digits, dot, hyphen and underscore, starting with a letter or digit.`;
  }
  return T`The name "${name}" is reserved — /${name.toLowerCase()} is a built-in command (${RESERVED_NAMES.join(", ")}). Give the workflow a different name in its meta.`;
}

/**
 * Put a script into the workspace's library; from a project chat it is taken over in that project at the same time.
 * @returns {{ status: number, body: Object }}
 */
function save({ workspaceId, projectId, script }) {
  if (typeof script !== "string" || !script.trim()) return { status: 400, body: { error: T("Field \"script\" is missing: the text of the workflow script.") } };
  let meta;
  try {
    ({ meta } = checkScript(script));
  } catch (e) {
    if (e instanceof MetaError || e instanceof ScriptError) return { status: 400, body: { error: e.message } };
    throw e;
  }
  const name = meta.name;
  const forbidden = nameForbidden(name);
  if (forbidden) return { status: 400, body: { error: nameError(forbidden, name), reason: forbidden } };
  if (skillCarriesNames(workspaceId, name)) {
    return { status: 400, body: { reason: "skill", error: T`A skill in this workspace is already called "${name}" — /${name} would be ambiguous. Give the workflow a different name in its meta.` } };
  }
  const duplicate = () => ({ status: 409, body: { reason: "existing", error: T`A saved workflow "${name}" already exists in this workspace — it is not overwritten. Give the new one a different name in its meta.` } });
  if (getDynWorkflowByName(workspaceId, name)) return duplicate();
  try {
    const w = createDynWorkflow({ id: crypto.randomUUID(), workspaceId, name, meta, script, projectId });
    return { status: 201, body: { ...entryShort(w), takenOverIn: projectId || null } };
  } catch (e) {
    if (isUniqueViolation(e)) return duplicate();
    throw e;
  }
}

export async function dynWorkflowChatRoutes(ctx) {
  const { req, res, url, p, m, id, sub, chat } = ctx;
      // Those effective in the chat: a workspace chat all of the workspace, a project chat only those taken over there.
      if (sub === "/dyn-workflows" && m === "GET") return send(res, 200, effectiveDynWorkflows(chat.workspaceId, chat.projectId || null).map(entryShort));
      if (sub === "/dyn-workflows" && m === "POST") {
        const b = await readBody(req);
        const r = save({ workspaceId: chat.workspaceId, projectId: chat.projectId || null, script: b.script });
        return send(res, r.status, r.body);
      }
      // The path of cbase_dynamic_workflow — the answer goes out, THEN the run starts (run.js los).
      if (sub === "/dyn-workflows/run" && m === "POST") {
        const b = await readBody(req);
        const r = startDynWorkflow(chat, b, { readAloud: await readAloudCopy(chat, b) }); // a copy's script is read by its container
        const response = send(res, r.status, r.body);
        r.go?.();
        return response;
      }
      // The human's ruling at the approval card — accepting starts the run (the answer goes out, THEN `los`), rejecting
      // reports it to the agent. Both fields required (400). Not on the archive allowlist: nothing starts in an archived
      // chat (409 of the chat routes, checked fresh in run.js decideApproval).
      if (sub === "/dyn-workflows/approval" && m === "POST") {
        const b = await readBody(req); // archive: decideApproval checks the chat fresh after the body (409, starts nothing)
        // If a graph step holds at this card, it runs again BEFORE the ruling starts or delivers (workflows/gates.js
        // dynApprovalDecided) — and channel messages that waited at it go afterwards as a turn of their own, as after
        // an answered question (runs/routes.js /ask-answer).
        let stepHeld = false;
        const r = decideApproval(chat.id, b, { beforeRuling: (requestId) => { stepHeld = dynApprovalDecided(chat, requestId); } });
        const response = send(res, r.status, r.body);
        r.go?.();
        if (stepHeld) channelAfterDelivery(getChat(chat.id));
        return response;
      }
      // The StructuredOutput messenger of a workflow agent with a schema (mcp/tools/dynworkflows.js) — validation
      // happens HERE (structured.js, ajv). `reference` and `object` are required (400), a reference not open is 404.
      if (sub === "/dyn-workflows/structured-output" && m === "POST") {
        const b = await readBody(req);
        const r = takeOutput({ chatId: chat.id, body: b });
        return send(res, r.status, r.body);
      }
      // cbase_dynamic_workflow_stop — task id or run id. The agent stops: no notice, no hint.
      if (sub === "/dyn-workflows/stop" && m === "POST") {
        const b = await readBody(req);
        const r = stopDynWorkflow(chat.id, b.taskId, { from: "agent" });
        return send(res, r.status, r.body);
      }
      // The progress tree — the chat's newest runs as a view (run.js dynTrees, tree.js), the same one the event
      // `dynwf_tree` carries live. And the transcript of ONE workflow agent (click on its row): the run must belong to
      // this chat (404), `n` is the number of its agent() call.
      if (sub === "/dyn-workflows/tree" && m === "GET") return send(res, 200, dynTrees(chat.id));
      const tr = sub.match(/^\/dyn-workflows\/runs\/([^/]+)\/agents\/(\d+)$/);
      if (tr && m === "GET") {
        let who;
        try { who = decodeURIComponent(tr[1]); } catch { return send(res, 400, { error: "bad id" }); }
        const run = dynRunInChat(chat.id, who);
        if (!run) return send(res, 404, { error: T`No dynamic workflow "${who}" in this chat.` });
        const n = Number(tr[2]);
        return send(res, 200, { runId: run.runId, n, rows: readDynAgentHistory(run.runId, n).map(({ n: _n, ...z }) => z) });
      }
      // "Stop workflow" for the human (the buttons at the tree's header) — a path of its OWN, not an extension of
      // /stop (that ends the turn, not the workflow). Run id or task id in the path, no body. The next turn learns of
      // the stop as a silent hint (run.js stopDynWorkflow). Allowed in the archive like POST /stop (chats/routes.js).
      const hs = sub.match(/^\/dyn-workflows\/runs\/([^/]+)\/stop$/);
      if (hs && m === "POST") {
        let who;
        try { who = decodeURIComponent(hs[1]); } catch { return send(res, 400, { error: "bad id" }); }
        const r = stopDynWorkflow(chat.id, who, { from: "human" });
        return send(res, r.status, r.body);
      }
      // The two actions on ONE row of the tree — skip (the stop of a workflow agent: null in the script, failed in the
      // journal) and restart (the same job anew, the script gets the new result). There is no "stop per agent" for
      // workflow agents; the stop of the workflow is the route above. Run id or task id in the path, `n` the number of
      // the agent() call, no body. Not allowed in the archive.
      const ei = sub.match(/^\/dyn-workflows\/runs\/([^/]+)\/agents\/(\d+)\/(skip|restart)$/);
      if (ei && m === "POST") {
        let who;
        try { who = decodeURIComponent(ei[1]); } catch { return send(res, 400, { error: "bad id" }); }
        const r = ei[3] === "skip" ? skipDynAgent(chat.id, who, Number(ei[2])) : restartDynAgent(chat.id, who, Number(ei[2]));
        return send(res, r.status, r.body);
      }
  return NEXT;
}

export async function dynWorkflowWorkspaceRoutes(ctx) {
  const { req, res, url, p, m, wid, sub, ws } = ctx;
      if (sub === "/dyn-workflows" && m === "GET") return send(res, 200, listDynWorkflows(wid).map(entryShort));
      const dw = sub.match(/^\/dyn-workflows\/([0-9a-f-]+)$/);
      if (dw) {
        const w = getDynWorkflow(dw[1]);
        if (!w || w.workspaceId !== wid) return send(res, 404, { error: "dynamic workflow not found" });
        if (m === "GET") return send(res, 200, entryFull(w));
        if (m === "DELETE") { deleteDynWorkflow(w.id); return send(res, 200, { ok: true }); }
      }
  return NEXT;
}

export async function dynWorkflowProjectRoutes(ctx) {
  const { req, res, url, p, m, pid, sub, proj } = ctx;
      // The workspace's workflows with this project's takeover state.
      if (sub === "/workspace-dyn-workflows" && m === "GET") {
        const on = listEnabledDynWorkflowNames(pid);
        return send(res, 200, listDynWorkflows(proj.workspaceId).map((w) => ({ ...entryShort(w), enabled: on.has(w.name) })));
      }
      const pde = sub.match(/^\/workspace-dyn-workflows\/([^/]+)\/enabled$/);
      if (pde && m === "PATCH") {
        const b = await readBody(req);
        // A missing field is not a statement: the neighbouring routes read `!!b.enabled` — a body without the field
        // would silently switch OFF there. Here it is required and a boolean.
        if (typeof b.enabled !== "boolean") return send(res, 400, { error: T("Field \"enabled\" is missing or not a boolean.") });
        let name;
        try { name = decodeURIComponent(pde[1]); } catch { return send(res, 400, { error: "bad name" }); }
        const w = getDynWorkflowByName(proj.workspaceId, name);
        if (!w) return send(res, 404, { error: "dynamic workflow not found" });
        setDynWorkflowEnabled(pid, w.name, b.enabled);
        return send(res, 200, { ok: true, name: w.name, enabled: b.enabled });
      }
  return NEXT;
}
