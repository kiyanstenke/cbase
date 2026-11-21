// Routes: workflow runs. Each function takes ctx = { req, res, url, p, m } (sub-tables of a family add id/sub/chat,
// wid/sub/ws or pid/sub/proj) and returns NEXT when it is not responsible; any other return means "answered". Call
// order: ROUTES in server.js.
// Functions: workflowChatRoutes · workflowRunRoutes (workflow-runs, gitlab/accounts) · workflowWorkspaceRoutes.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as gitlab from "../gitlab.js";
import * as wf from "../workflows.js";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { attachmentFolderToRead } from "../runs/runtime-location.js";
import { NEXT, attachmentMime, readBody, safeFileName, send } from "../runtime/http.js";
import { imageDimensionsFromFile, withImageDimensions } from "../runtime/image-dimensions.js";
import { beginWorkflow } from "./driver.js";
import { broadcast, sse } from "../runtime/sse.js";
import { cancelWorkflow, skipWorkflowStep } from "./gates.js";
import { focusedProject } from "../runs/system-prompt.js";
import { lockSituation, withoutControlCharacters, runHistoryView, workflowRunView, countCalculator } from "./run-state.js";
import { withLosses, saveWorkflow, workflowFull, workflowMeta, workflowTriggerRoute } from "./definitions.js";
import { withShortNames } from "./shortName.js";
import { running } from "../runs/state.js";

export async function workflowChatRoutes(ctx) {
  const { req, res, url, p, m, id, sub, chat } = ctx;
        // The running (or last run) workflow — basis of the progress strip.
        if (sub === "/workflow" && m === "GET") return send(res, 200, { run: workflowRunView(store.getWorkflowRun(id)) });
        if (sub === "/workflow" && m === "POST") {
          const b = await readBody(req);
          const flow = store.getWorkflow(String(b.workflowId || ""));
          // Check visibility: only a workflow effective in this chat's scope may start.
          const visible = chat.workspaceId
            ? store.effectiveWorkflows(chat.workspaceId, focusedProject(chat)?.id ?? null).some((w) => w.id === flow?.id)
            : false;
          if (!flow || !visible) return send(res, 404, { error: T("workflow not found") });
          if (running.has(id)) return send(res, 409, { error: T("The chat is already running.") });
          const existing = store.getWorkflowRun(id);
          if (store.workflowOpen(existing)) {
            return send(res, 409, { error: T("A workflow is already running in this chat.") });
          }
          // Lock: if another run holds it, the manual start is REFUSED (no silent queueing — the user
          // sits in front of it and should know what they are waiting for). Triggered runs, in
          // contrast, wait by themselves, see fireTrigger.
          {
            // The input text only exists further down as `text` — here it is needed just for the
            // lock key ({{input}} in a custom template).
            const sit = lockSituation(flow, chat, {}, String(b.input ?? ""));
            if (sit.lock) {
              const holder = store.getChat(sit.lock.chatId)?.title || sit.lock.workflowName || "";
              return send(res, 409, {
                error: T`Another run currently holds the lock "${sit.key}"${holder ? T` — "${holder}" is still running` : ""}. Wait until it finishes, or change the workflow's concurrency setting.`,
                lockKey: sit.key,
                holderChatId: sit.lock.chatId || "",
              });
            }
          }
          // `?? ""` instead of `|| ""`: the inputs 0 and false are inputs, not empty fields.
          const text = withoutControlCharacters(b.input ?? "").trim();
          // Attachments as for /message: only previously uploaded files of this chat, appended to the
          // input as paths (the Read tool reads all types). With the same fallback to the old location
          // after a project switch (runs/runtime-location.js attachmentFolderToRead).
          let folder = null;
          const location = new Map(); // file → the folder it lives in
          const attachments = [];
          for (const a of Array.isArray(b.attachments) ? b.attachments : []) {
            const file = safeFileName(a?.file);
            if (!file) continue;
            folder ||= attachmentFolderToRead(id);
            const dir = folder.find((d) => fs.existsSync(path.join(d, file)));
            if (!dir) continue;
            location.set(file, dir);
            attachments.push(withImageDimensions({ name: String(a?.name || file).slice(0, 200), file, mime: attachmentMime(file), size: fs.statSync(path.join(dir, file)).size }, imageDimensionsFromFile(path.join(dir, file)))); // see runs/routes.js
          }
          const input = attachments.length
            ? [text, "", "[Attached files — read them first with the Read tool:]",
               ...attachments.map((a) => `- ${path.join(location.get(a.file), a.file)}`)].join("\n").trim()
            : text;
          if (chat.title === "New chat") {
            const title = flow.name.length > 40 ? flow.name.slice(0, 40) + "…" : flow.name;
            store.updateChat(id, { title });
            sse(id, { type: "harness", subtype: "title", chatId: id, title });
            broadcast({ type: "chat_title", chatId: id, title });
          }
          // The input text is stored as a user message in the history (the workflow header says what for).
          if (text || attachments.length) {
            store.addMessage(id, "user", text, Date.now(), attachments);
            sse(id, { type: "harness", subtype: "user_message", text, attachments });
          }
          const started = beginWorkflow(chat, flow, input);
          if (started.blocked) {
            return send(res, 409, {
              error: T`Another run currently holds the lock "${started.key}".`,
              lockKey: started.key,
            });
          }
          return send(res, 202, { run: workflowRunView(started.run) });
        }
        if (sub === "/workflow/skip" && m === "POST") return send(res, 200, { ok: await skipWorkflowStep(chat), run: workflowRunView(store.getWorkflowRun(id)) });
        if (sub === "/workflow/cancel" && m === "POST") return send(res, 200, { ok: await cancelWorkflow(chat), run: workflowRunView(store.getWorkflowRun(id)) });
  return NEXT;
}

export async function workflowRunRoutes(ctx) {
  const { req, res, url, p, m } = ctx;
      // ── Workflow runs: history and step log ──────────────────────────────────
      // The list is the "Runs" view, the detail the timeline of one run (with prompt, result
      // excerpt, verdict including raw output and errors — the debug material).
      if (p === "/api/workflow-runs" && m === "GET") {
        // An unknown status must not silently yield an empty list — indistinguishable from "no
        // runs". And an unreadable `limit` deserves an answer, not a guess.
        const status = url.searchParams.get("status") || "";
        const STATUS = ["running", "waiting", "done", "failed", "cancelled", "open"];
        if (status && !STATUS.includes(status)) {
          return send(res, 400, { error: T`Unknown status "${status}" (allowed: ${STATUS.join(", ")})` });
        }
        const rawLimit = url.searchParams.get("limit");
        if (rawLimit !== null && !/^\d+$/.test(rawLimit)) {
          return send(res, 400, { error: T("\"limit\" must be an integer.") });
        }
        const runs = store.listWorkflowRuns({
          workspaceId: url.searchParams.get("workspaceId") || "",
          projectId: url.searchParams.get("projectId") || "",
          workflowId: url.searchParams.get("workflowId") || "",
          chatId: url.searchParams.get("chatId") || "",
          status,
          limit: rawLimit === null ? 100 : Number(rawLimit),
        });
        const countsOf = countCalculator();
        return send(res, 200, { runs: runs.map((r) => runHistoryView(r, countsOf(r))) });
      }
      {
        const rm = p.match(/^\/api\/workflow-runs\/([0-9a-f-]+)$/);
        if (rm && m === "DELETE") {
          const run = store.getWorkflowRunById(rm[1]);
          if (!run) return send(res, 404, { error: T("Run not found") });
          // A RUNNING run is not deleted from the history — cancel it first.
          if (store.workflowOpen(run)) {
            return send(res, 409, { error: T("The run is still active — cancel it first.") });
          }
          return send(res, 200, { ok: store.deleteWorkflowRun(run.id) });
        }
        if (rm && m === "GET") {
          const run = store.getWorkflowRunById(rm[1]);
          if (!run) return send(res, 404, { error: T("Run not found") });
          const steps = store.listRunSteps(run.id);
          // The chat history remains the second source (agent turns, tokens) — the link to it is
          // in the response so the view can jump straight over.
          return send(res, 200, {
            run: runHistoryView(run, countCalculator()(run)),
            steps,
            chat: run.chatGone ? null : (() => { const c = store.getChat(run.chatId); return c ? { id: c.id, title: c.title, workspaceId: c.workspaceId } : null; })(),
          });
        }
      }
      // ── GitLab accounts (basis of the trigger nodes) ─────────────────────────
      // The token is a secret: it is stored and used, but NEVER returned (the list only shows
      // hasToken + the account name GitLab itself reported).
      if (p === "/api/gitlab/accounts" && m === "GET") return send(res, 200, { accounts: store.listGitlabAccounts() });
      if (p === "/api/gitlab/accounts" && m === "POST") {
        const b = await readBody(req);
        const host = gitlab.normalizeHost(b.host || "https://gitlab.com");
        const token = String(b.token || "").trim();
        if (!host) return send(res, 400, { error: T("Invalid host (e.g. https://gitlab.com).") });
        if (!token) return send(res, 400, { error: T("Access token required.") });
        // Verify first, then store — an account that does not work helps nobody.
        let who;
        try { who = await gitlab.verifyAccount({ host, token }); }
        catch (e) { return send(res, 400, { error: String(e?.message || e) }); }
        const now = Date.now();
        const acc = store.createGitlabAccount({
          id: crypto.randomUUID(), label: String(b.label || "").slice(0, 80) || new URL(host).host,
          host, token, userName: who.userName, userId: who.userId, createdAt: now, updatedAt: now,
        });
        return send(res, 201, acc);
      }
      {
        const gam = p.match(/^\/api\/gitlab\/accounts\/([0-9a-f-]+)$/);
        if (gam) {
          const acc = store.getGitlabAccount(gam[1]);
          if (!acc) return send(res, 404, { error: T("Account not found") });
          if (m === "PATCH") {
            const b = await readBody(req);
            const fields = { updatedAt: Date.now() };
            if (typeof b.label === "string") fields.label = b.label.slice(0, 80);
            if (typeof b.host === "string" && b.host.trim()) {
              const host = gitlab.normalizeHost(b.host);
              if (!host) return send(res, 400, { error: T("Invalid host.") });
              fields.host = host;
            }
            // Empty token field = keep the token (as with the provider keys).
            if (typeof b.token === "string" && b.token.trim()) fields.token = b.token.trim();
            if (fields.host || fields.token) {
              const probe = { host: fields.host || acc.host, token: fields.token || store.getGitlabAccountWithToken(acc.id).token };
              try {
                const who = await gitlab.verifyAccount(probe);
                fields.userName = who.userName; fields.userId = who.userId; fields.status = ""; fields.checkedAt = Date.now();
              } catch (e) { return send(res, 400, { error: String(e?.message || e) }); }
            }
            return send(res, 200, store.updateGitlabAccount(acc.id, fields));
          }
          if (m === "DELETE") {
            store.deleteGitlabAccount(acc.id);
            return send(res, 200, { ok: true });
          }
        }
        // Re-check the connection (button on the account card).
        const gtm = p.match(/^\/api\/gitlab\/accounts\/([0-9a-f-]+)\/test$/);
        if (gtm && m === "POST") {
          const acc = store.getGitlabAccountWithToken(gtm[1]);
          if (!acc) return send(res, 404, { error: T("Account not found") });
          try {
            const who = await gitlab.verifyAccount(acc);
            store.updateGitlabAccount(acc.id, { userName: who.userName, userId: who.userId, status: "", checkedAt: Date.now() });
            return send(res, 200, { ok: true, userName: who.userName, name: who.name, webUrl: who.webUrl });
          } catch (e) {
            const msg = String(e?.message || e);
            store.updateGitlabAccount(acc.id, { status: msg, checkedAt: Date.now() });
            return send(res, 200, { ok: false, error: msg });
          }
        }
        // Project/group search for the trigger settings.
        const gpm = p.match(/^\/api\/gitlab\/accounts\/([0-9a-f-]+)\/(projects|groups)$/);
        if (gpm && m === "GET") {
          const acc = store.getGitlabAccountWithToken(gpm[1]);
          if (!acc) return send(res, 404, { error: T("Account not found") });
          const q = url.searchParams.get("search") || "";
          try {
            const rows = gpm[2] === "projects" ? await gitlab.searchProjects(acc, q) : await gitlab.searchGroups(acc, q);
            return send(res, 200, { items: rows });
          } catch (e) { return send(res, 502, { error: String(e?.message || e) }); }
        }
      }
  return NEXT;
}
export async function workflowWorkspaceRoutes(ctx) {
  const { req, res, url, p, m, wid, sub, ws } = ctx;

        // Workflow CRUD (node/edge graph) — workspace level (project_id NULL).
        if (sub === "/workflows" && m === "GET") return send(res, 200, store.listWorkspaceWorkflows(wid).map(workflowMeta));
        // Effective selection for a chat that does not exist yet: the composer shows the workflow
        // choice in the empty chat, but the chat is only created on send. With `shortName` like
        // `/api/chats/:id/workflows` — the same set yields the same short names.
        if (sub === "/effective-workflows" && m === "GET") {
          const pid = url.searchParams.get("projectId") || null;
          return send(res, 200, withShortNames(store.effectiveWorkflows(wid, pid)).map((w) => ({ ...workflowMeta(w), shortName: w.shortName })));
        }
        if (sub === "/workflows" && m === "POST") {
          const b = await readBody(req);
          const name = String(b.name || "").trim().slice(0, 64);
          if (!name) return send(res, 400, { error: T("Name required") });
          if (store.getWorkflowByName(wid, null, name)) return send(res, 409, { error: T`A workflow "${name}" already exists in this workspace.` });
          const now = Date.now();
          return send(res, 201, workflowFull(store.createWorkflow({ id: crypto.randomUUID(), workspaceId: wid, projectId: null, name, description: String(b.description || "").slice(0, 400), graph: wf.normalizeGraph(b.graph), createdAt: now, updatedAt: now })));
        }
        const wfm = sub.match(/^\/workflows\/([0-9a-f-]+)$/);
        if (wfm) {
          const flow = store.getWorkflow(wfm[1]);
          if (!flow || flow.workspaceId !== wid || flow.projectId) return send(res, 404, { error: "workflow not found" });
          if (m === "GET") return send(res, 200, workflowFull(flow));
          if (m === "PUT") {
            const r = await saveWorkflow(req, flow, wid, null);
            return r.error ? send(res, r.status, { error: r.error }) : send(res, 200, withLosses(r));
          }
          if (m === "DELETE") return send(res, 200, { ok: store.deleteWorkflow(wfm[1]) });
        }
        // Trigger state/test (sub-routes of the same workflow).
        {
          const wtm = sub.match(/^\/workflows\/([0-9a-f-]+)\/trigger-(status|test)$/);
          if (wtm) {
            const flow = store.getWorkflow(wtm[1]);
            if (!flow || flow.workspaceId !== wid || flow.projectId) return send(res, 404, { error: "workflow not found" });
            if (await workflowTriggerRoute(req, res, m, sub, flow)) return;
          }
        }
  return NEXT;
}
