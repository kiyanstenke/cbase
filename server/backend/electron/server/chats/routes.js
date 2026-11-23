// Routes: chats and chat folders. Every function takes ctx = { req, res, url, p, m } (sub-slices of a family additionally
// id/sub/chat, wid/sub/ws or pid/sub/proj) and returns NEXT if it is not responsible; any other return means "answered".
// Call order: ROUTES in server.js.
// Functions: chatFolderRoutes · chatListRoute · chatCreateRoute · chatRoutes (owner) · coreChatRoutes
// (GET/PATCH/DELETE, /log) · contextChatRoutes (log/delta, clear) · itemChatRoutes (workflows GET, skills) ·
// fileChatRoutes (captures, attachments, artifacts, folder-context, stream; helper captureKeyOf).
// chatRoutes is the owner of the family: preamble (regex, lookup, 404), then the sub-table of the sub-slices.
// Archive: between the 404 and the sub-table sits the write lock (`archiveAllowed`); `archiveChatRoutes` is the FIRST
// sub-slice (GET/PUT /archive); the folder branches `/archive` and `?permanently=1` are in chatFolderRoutes; the delete
// cascade is `./erase.js`.

import crypto from "node:crypto";
import { liveMonitors } from "../runs/monitors.js";
import { wakeupOf } from "../runs/wakeup.js";
import fs from "node:fs";
import path from "node:path";
import { isProviderId, providerForChat } from "../providers/index.js";
import { countTerminalsByTag, killTerminalsByTag } from "../terminal.js";
import { captureFile, listCaptures, startRecording, stopRecording, takeScreenshot } from "../captures.js";
import * as store from "../store.js";
import { imageDimensions, isImageName, withImageDimensions } from "../runtime/image-dimensions.js";
import * as artifactStore from "../artifacts.js";
import { T } from "../i18n.js";
import * as notifications from "../notify.js";
import * as autocompact from "../autocompact.js";
import { BROWSER_MODES } from "../toolchain/playwright.js";
import { attachmentLocation, attachmentPath } from "../runs/runtime-location.js";
import { openInRuntimeFolder } from "../runs/runtime-limit.js";
import { writeInRuntimeFolder } from "../runs/runtime-write.js";
import { PERMISSION_MODES } from "../toolchain/profiles.js";
import { effortSavable, ultracodeSavable } from "../workflows.js";
import { ultracodeFollowUp } from "./ultracode.js";
import { chatCreation } from "./creation.js";
import { WINDOW_PARAM, truncateRows, logWindow, willWindow } from "./log-window.js";
import { JOB_NOTIFICATIONS, chatJobField } from "../scheduled/chat-field.js";
import { NEXT, attachmentMime, dispositionHeader, supplyFile, readBody, readRawBody, safeFileName, send, serveRanged } from "../runtime/http.js";
import { servingHeader } from "../runtime/serving.js";
import { RUN_STREAM_MAX, compacting, runBackground, runContext, runStreamText, runWaiting, running } from "../runs/state.js";
import { liveRows } from "../runs/agents.js";
import { copyProjectSwitched, turnProjectSwitched } from "../runs/instance.js";
import { InstanceChoiceError, chatInstanceSet, instanceAfterProjectSwitch, instanceChoice, instanceSwitchWakeText } from "../runs/instance-switch.js";
import { TARGET_MAX, focusedProject } from "../runs/system-prompt.js";
import { artifactSiblings, artifactSource, folderContextChanged } from "./helpers.js";
import { autoContinueChatRoutes, messageChatRoutes, runChatRoutes } from "../runs/routes.js";
import { broadcast, sse, streams } from "../runtime/sse.js";
import { channelChatRoutes } from "../channels/routes.js";
import { communicationChatRoutes } from "../communication/routes.js";
import { outerLoopChatRoutes } from "../outerloop/routes.js";
import { AGENT_HINT, chatSkills, skillMeta, skillOfAgent } from "../toolchain/skill-catalog.js";
import { clearChatContext } from "../runs/post-run.js";
import { deliverUserPrompt, publicPendingInputs } from "../runs/queue.js";
import { workflowChatRoutes } from "../workflows/routes.js";
import { graphWorkflowChatRoutes } from "../workflows/graph-routes.js";
import { stopKindRuns } from "../workflows/graph-start.js";
import { workflowMeta } from "../workflows/definitions.js";
import { withShortNames } from "../workflows/shortName.js";
import { archivePage, archivePageError, reportArchive, openWork } from "../runs/archive.js";
import { deleteObstacles, deleteLock } from "../runs/archive.js"; // ONE truth about open work
import { onlyReadable, onlyReadableLock } from "../runs/only-readable.js";
import { managerAllowed, managerLocked, managerLock } from "../runs/manager-lock.js";
import { deleteChatPermanently } from "./erase.js";
import { archivable, chatKind, isChildChat } from "./genus.js";
import { chatArchive } from "./archive.js";
import { dynWorkflowChatRoutes } from "../dynworkflows/routes.js";
import { agendaChatRoutes } from "../agenda/routes.js";
import { skillWriteChatRoutes } from "../toolchain/skill-routes.js";
import { airlockChatRoutes } from "../toolchain/airlock-routes.js";
import { userBrowserChatRoutes, closeChatBrowser } from "../devtools/user-browser.js";
import { outputsChatRoutes } from "./outputs-routes.js";

export async function chatFolderRoutes(ctx) {
  const { req, res, url, p, m } = ctx;

      // ── Chat folders ─────────────────────────────────────────────────────
      // A purely logical grouping of the chat list (no file system folder). A folder belongs to a workspace and
      // optionally to ONE project; a chat may only go into folders of the same scope. Chats of a folder read each
      // other's artifacts.
      if (p === "/api/chat-folders" && m === "GET") {
        const wsId = url.searchParams.get("workspaceId") || "";
        if (!wsId) return send(res, 400, { error: T("workspaceId required") });
        // Only coding folders exist: without `kind` or with 'normal' the coding folders; `kind=manager` is a 400 (a silent
        // fallback to 'normal' would answer a different question).
        const kindParam = url.searchParams.get("kind");
        if (kindParam !== null && kindParam !== "normal") return send(res, 400, { error: T("kind is unknown — only coding folders (normal) remain") });
        const kind = "normal";
        // `archive`: the side of the folders AND of their count — `chatCount` counts the chats of the same archive side.
        // Unknown ⇒ 400, no silent fallback.
        const archive = archivePage(url);
        if (!archive) return send(res, 400, archivePageError());
        // `chatCount` counts only chats with at least one message — the same set the chat list below shows
        // (`onlyWithMessage`, store/chats.js).
        const counts = store.chatFolderCounts(wsId, kind, { archive, onlyWithMessage: true });
        return send(res, 200, store.listChatFolders(wsId, kind, { archive }).map((f) => ({ ...f, chatCount: counts[f.id] || 0 })));
      }
      if (p === "/api/chat-folders" && m === "POST") {
        const b = await readBody(req);
        const ws = b.workspaceId ? store.getWorkspace(b.workspaceId) : null;
        if (!ws) return send(res, 400, { error: T("workspaceId required") });
        const name = String(b.name || "").trim().slice(0, 120);
        if (!name) return send(res, 400, { error: T("Name required") });
        let projectId = null;
        if (b.projectId) {
          if (!(ws.projects || []).some((pr) => pr.id === b.projectId)) {
            return send(res, 400, { error: T("Project does not belong to this workspace") });
          }
          projectId = b.projectId;
        }
        const now = Date.now();
        // Only coding folders are created; a body with another `kind` (including "manager") is a 400 instead of silently
        // a coding folder.
        if (b.kind !== undefined && b.kind !== "normal") return send(res, 400, { error: T("kind is unknown — only coding folders (normal) remain") });
        const folder = store.createChatFolder({
          id: crypto.randomUUID(), workspaceId: ws.id, projectId,
          name, kind: "normal", createdAt: now, updatedAt: now,
        });
        return send(res, 201, { ...folder, chatCount: 0 });
      }
      const fm = p.match(/^\/api\/chat-folders\/([0-9a-f-]+)(\/.*)?$/);
      if (fm) {
        const folder = store.getChatFolder(fm[1]);
        if (!folder) return send(res, 404, { error: "folder not found" });
        const fsub = fm[2] || "";
        // Manager lock (runs/manager-lock.js): a folder of genus manager — and a folder that still holds a manager chat
        // (legacy mixed folders) — is not renamed, deleted, dissolved, archived or restored; each of these paths would
        // write a row of genus manager (folder, `folder_id`, `archived_at`). Reading stays.
        if (m !== "GET" && (folder.kind === "manager" || store.chatsInFolder(folder.id, { archive: "including" }).some(managerLocked))) {
          return send(res, 409, managerLock());
        }
        if (fsub === "" && m === "PATCH") {
          const b = await readBody(req);
          const name = String(b.name ?? "").trim().slice(0, 120);
          if (!name) return send(res, 400, { error: T("Name required") });
          return send(res, 200, store.updateChatFolder(folder.id, { name, updatedAt: Date.now() }));
        }
        if (fsub === "" && m === "DELETE") {
          // `?permanently=1`: ONLY on an archived folder — it goes with its archived chats (the whole delete cascade per
          // chat) and its context files. Any other value of the parameter is a 400: "permanently=yes" must not silently
          // become a dissolve.
          if (url.searchParams.has("permanently")) {
            if (url.searchParams.get("permanently") !== "1") {
              return send(res, 400, { error: T("permanently must be 1") });
            }
            if (!folder.archivedAt) {
              return send(res, 400, { error: T("Only an archived folder can be deleted permanently — archive it first") });
            }
            // The set AND the number in the confirmation come from `finalSet`: only chats of the folder's genus that are
            // archivable. A foreign chat in the folder (legacy mixed folder, a special chat) is not deleted —
            // `deleteChatFolder` only detaches it.
            const doomed = finalSet(folder);
            const contextFiles = contextFilesCount(folder.id);
            for (const c of doomed) deleteChatPermanently(c);
            store.deleteChatFolder(folder.id);
            try { artifactStore.removeFolderContext(folder.id); } catch { /* never created */ }
            return send(res, 200, { ok: true, chats: doomed.length, contextFiles });
          }
          // Deleting a folder ONLY dissolves the grouping — chats and their artifacts stay. The CONTEXT FILES, however,
          // belong to the folder itself: without it nobody could reach them, they would only take up space.
          const freed = store.listChatsInFolder(folder.id).map((c) => c.id);
          store.deleteChatFolder(folder.id);
          try { artifactStore.removeFolderContext(folder.id); } catch { /* never created */ }
          return send(res, 200, { ok: true, chats: freed.length });
        }
        // ── Archive of the folder ────────────────────────────────────────────────
        // Pre-check and toggle. The set is `chatsInFolder` — exactly the chats `archiveFolder` takes along (every
        // genus). If ONE active chat has open work or one is not archivable, NOTHING changes (409 with chat and
        // reasons); the check happens BEFORE the write, with no await in between.
        // The response names what the NEXT action on the folder affects:
        //   active folder   — `chats` = the active chats that PUT {archived:true} would take along;
        //   archived folder — `chats` = exactly the chats that DELETE ?permanently=1 deletes (`finalSet`);
        //   both            — `contextFiles` = the context files that go with the folder; `null` if counting failed
        //                     (unknown, never 0).
        // The clients take the numbers of the delete confirmation from HERE, not from their list.
        if (fsub === "/archive" && m === "GET") {
          const set = folder.archivedAt ? finalSet(folder) : store.chatsInFolder(folder.id);
          return send(res, 200, {
            archived: Boolean(folder.archivedAt), archivedAt: folder.archivedAt ?? null,
            chats: set.length, contextFiles: contextFilesCount(folder.id),
            open: folder.archivedAt ? [] : folderLocks(set),
            terminals: set.reduce((n, c) => n + countTerminalsByTag(`chat:${c.id}`), 0),
          });
        }
        if (fsub === "/archive" && m === "PUT") {
          const b = await readBody(req);
          if (typeof b.archived !== "boolean") return send(res, 400, archiveFieldError());
          const now = store.getChatFolder(folder.id); // fresh: the body was just read
          if (!now) return send(res, 404, { error: "folder not found" });
          if (b.archived === Boolean(now.archivedAt)) return send(res, 200, { ok: true, unchanged: true, chatIds: [], terminalsEnded: 0 });
          if (b.archived) {
            const locked = folderLocks(store.chatsInFolder(now.id));
            if (locked.length) {
              return send(res, 409, { error: folderLockSet(locked), chats: locked });
            }
            const chatIds = store.archiveFolder(now.id, Date.now());
            let terminalsEnded = 0;
            for (const cid of chatIds) { terminalsEnded += killTerminalsByTag(`chat:${cid}`); void closeChatBrowser(cid); }
            reportArchive({ workspaceId: now.workspaceId, kind: now.kind, chatIds, folderIds: [now.id], archived: true, reason: "user" });
            return send(res, 200, { ok: true, chatIds, terminalsEnded });
          }
          const chatIds = store.fetchFolderBack(now.id);
          reportArchive({ workspaceId: now.workspaceId, kind: now.kind, chatIds, folderIds: [now.id], archived: false, reason: "user" });
          return send(res, 200, { ok: true, chatIds, terminalsEnded: 0 });
        }
        // All artifacts of the chats of THIS folder in one list — the folder view shows context and work results side
        // by side without opening each chat.
        if (fsub === "/artifacts" && m === "GET") {
          try {
            const out = [];
            for (const c of store.listChatsInFolder(folder.id)) {
              for (const a of artifactStore.listArtifacts(c.id)) out.push({ ...a, chatId: c.id, chatTitle: c.title, own: false });
            }
            return send(res, 200, out);
          } catch (e) { return send(res, e?.status || 400, { error: String(e?.message || e) }); }
        }
        // Context files of the folder: material uploaded by a PERSON that all chats of the folder may read (see
        // folderContextPrompt + cbase_folder_context_*).
        if (fsub === "/context" && m === "GET") {
          try { return send(res, 200, artifactStore.listContextFiles(folder.id)); }
          catch (e) { return send(res, e?.status || 400, { error: String(e?.message || e) }); }
        }
        if (fsub === "/context/upload" && m === "POST") {
          const limit = artifactStore.MAX_ARTIFACT_BYTES;
          const mib = `${Math.round(limit / 1048576)} MiB`;
          const tooBig = { error: T`The file is larger than ${mib}` };
          if (Number(req.headers["content-length"] || 0) > limit) return send(res, 413, tooBig);
          let buf;
          try { buf = await readRawBody(req, limit + 1); }
          catch { return send(res, 413, tooBig); }
          if (!buf.length) return send(res, 400, { error: T("The file is empty") });
          let target;
          try { target = artifactStore.sanitizeArtifactPath(url.searchParams.get("path") || url.searchParams.get("name")); }
          catch (e) { return send(res, e?.status || 400, { error: String(e?.message || e) }); }
          try {
            if (url.searchParams.get("overwrite") !== "1" && artifactStore.contextFileExists(folder.id, target)) {
              return send(res, 409, {
                error: T`"${target}" already exists in this folder`,
                exists: true, path: target,
              });
            }
            const file = artifactStore.writeContextFile(folder.id, target, buf, { overwrite: true });
            folderContextChanged(folder.id, { op: "write", file });
            return send(res, 201, file);
          } catch (e) { return send(res, e?.status || 400, { error: String(e?.message || e) }); }
        }
        if (fsub === "/context/file" && m === "GET") {
          try {
            return send(res, 200, artifactStore.readContextFile(folder.id, url.searchParams.get("path"), {
              offset: url.searchParams.get("offset"), maxBytes: url.searchParams.get("maxBytes"),
            }));
          } catch (e) { return send(res, e?.status || 400, { error: String(e?.message || e) }); }
        }
        // Edit a context file BY HAND (Markdown editor in web/client/mobile). As with artifact writes via
        // expectedSha256: whoever saves has read the file before — if it changed in the meantime, a 409 instead of a
        // silent loss.
        if (fsub === "/context/file" && m === "PUT") {
          try {
            const b = await readBody(req);
            const file = artifactStore.writeContextFile(folder.id, b.path, b.content, {
              encoding: b.encoding, expectedSha256: b.expectedSha256,
            });
            folderContextChanged(folder.id, { op: "write", file });
            return send(res, 200, file);
          } catch (e) { return send(res, e?.status || 400, { error: String(e?.message || e) }); }
        }
        if (fsub === "/context/file" && m === "DELETE") {
          try {
            const file = artifactStore.deleteContextFile(folder.id, url.searchParams.get("path"), url.searchParams.get("expectedSha256"));
            folderContextChanged(folder.id, { op: "delete", file });
            return send(res, 200, file);
          } catch (e) { return send(res, e?.status || 400, { error: String(e?.message || e) }); }
        }
        if (fsub === "/context/download" && m === "GET") {
          try {
            const file = artifactStore.contextFileDownload(folder.id, url.searchParams.get("path"));
            const inline = url.searchParams.get("inline") === "1";
            // Open before the header, serve via pipeline (runtime/http.js supplyFile); the length from fstat.
            return supplyFile(res, { path: file.fullPath }, {
              "Content-Type": file.mime,
              "Content-Disposition": dispositionHeader(file.name, inline),
              "Cache-Control": "private, no-store",
              // nosniff and — for html/svg/xml/js — the sandbox, also with `inline=1`.
              ...servingHeader(file.mime),
            });
          } catch (e) { return send(res, e?.status || 400, { error: String(e?.message || e) }); }
        }
      }
  return NEXT;
}
export async function chatListRoute(ctx) {
  const { req, res, url, p, m } = ctx;

      // ── Chats ────────────────────────────────────────────────────────────
      if (p === "/api/chats" && m === "GET") {
        // `archive` (the archive side, runs/archive.js archivePage): default active only; unknown ⇒ 400.
        const archive = archivePage(url);
        // On EVERY side only chats with at least one message (any role). A created, never written chat is a draft — it
        // stays reachable via GET /api/chats/:id but appears in no list until the first row exists (the clients reload
        // after the first send). It is not deleted.
        if (!archive) return send(res, 400, archivePageError());
        const rows = store.listChats(url.searchParams.get("workspaceId") || undefined, { archive, onlyWithMessage: true });
        // ?stats=1: rows, user turns and last message per chat. Without the switch as usual.
        if (url.searchParams.get("stats")) {
          const st = store.chatStats(rows.map((c) => c.id));
          for (const c of rows) Object.assign(c, st.get(c.id) || { lines: 0, userTurns: 0, lastMessageAt: 0 });
        }
        // The copy the chat works IN (short info of the chat list): `chats.instance` and the state of its live row in the
        // chat's project — ONE query over all live copies instead of one per row. `null` means "works in main"; a binding
        // without a live row (only in races) carries `state: "removed"`. Not the copy the chat CREATED: a copy belongs to
        // no chat, a chat may have created several and work in none of them. The list does not carry the creator.
        const copies = new Map(store.stackCopiesInState(store.STACK_COPY_STATES.filter((z) => z !== "removed"))
          .map((k) => [`${k.projectId}/${k.name}`, k.state]));
        for (const c of rows) {
          const name = c.projectId && typeof c.instance === "string" && c.instance.startsWith("copy-") ? c.instance.slice("copy-".length) : "";
          c.copy = name ? { name, state: copies.get(`${c.projectId}/${name}`) ?? "removed" } : null;
          // The chat's scheduled job (scheduled/chat-field.js) — the clock in the chat list; `null` without a job.
          c.job = chatJobField(c);
        }
        return send(res, 200, rows);
      }
  return NEXT;
}

export async function chatCreateRoute(ctx) {
  const { req, res, url, p, m } = ctx;
      if (p === "/api/chats" && m === "POST") {
        const b = await readBody(req);
        // The normalisation lives in chats/creation.js — ONE computation for this path and the creation of scheduled jobs
        // (guard server/backend/test/chat-creation.test.js, golden).
        const creation = chatCreation(b);
        if (creation.error) return send(res, creation.error.status, creation.error.body);
        const now = Date.now();
        return send(res, 201, store.createChat(ultracodeFollowUp(null, { id: crypto.randomUUID(), ...creation.fields, createdAt: now, updatedAt: now })));
      }
  return NEXT;
}

export async function chatRoutes(ctx) {
  const { req, res, url, p, m } = ctx;
      const cm = p.match(/^\/api\/chats\/([0-9a-f-]+)(\/.*)?$/);
      if (cm) {
        const id = cm[1]; const sub = cm[2] || "";
        const chat = store.getChat(id);
        if (!chat) return send(res, 404, { error: "chat not found" });
        // Write lock of the archive: over HTTP an archived chat accepts only reading, restoring, permanent deletion and
        // stop. Everything else — including every future sub-route — is 409; that is the safe direction. Checked here
        // BEFORE the body; sub-slices that write without a run after a body await check a second time afterwards
        // (`archivedNow`).
        if (chat.archivedAt && !archiveAllowed(sub, m)) return send(res, 409, archiveLock());
        // Read-only (runs/only-readable.js): an old chat of the removed registration agent accepts the same allowlist —
        // read, delete permanently, stop; every message, answer to a question, steering, fork, "try now" and compaction
        // (and every future sub-route) is 409. A PUT /archive gets through and stays a 400.
        if (onlyReadable(chat) && !archiveAllowed(sub, m)) return send(res, 409, onlyReadableLock());
        // Manager lock (runs/manager-lock.js): a manager chat accepts only reading and the emergency valves — archiving,
        // restoring, deleting, PATCH and fork are 409 too (the archive allowlist would let PUT /archive and DELETE through).
        if (managerLocked(chat) && !managerAllowed(sub, m)) return send(res, 409, managerLock());
        const fctx = { ...ctx, id, sub, chat };
        for (const s of [
          archiveChatRoutes, // archive, before all others
          coreChatRoutes,
          instanceChatRoutes, // switch the instance (tool cbase_switch_instance)
          channelChatRoutes,
          contextChatRoutes,
          runChatRoutes,
          itemChatRoutes,
          autoContinueChatRoutes,
          workflowChatRoutes,
          graphWorkflowChatRoutes, // graph workflows: start, status, stop (tools cbase_workflow_*)
          messageChatRoutes,
          fileChatRoutes,
          dynWorkflowChatRoutes, // library of the dynamic workflows (tools _list/_save)
          communicationChatRoutes, // agent communication (cbase_agents_list)
          outerLoopChatRoutes, // /outer-loop… (analysis route behind the chat analysis tool, chat info)
          agendaChatRoutes, // agenda per coding chat: GET/PUT /agenda (tools cbase_agenda, cbase_agenda_write; the rail)
          skillWriteChatRoutes, // write skills (tool cbase_skill_write, only the main agent of a coding chat)
          airlockChatRoutes, // coding MCP airlock (the wrapper mcp/airlock.js)
          userBrowserChatRoutes, // the chat's browser: POST /browser/ensure (right chat rail, code tabs)
          outputsChatRoutes, // GET /outputs, GET /outputs/file, GET /outputs/folder (ZIP) — the output folder, read-only (chats/outputs-routes.js)
        ]) {
          const r = await s(fctx);
          if (r !== NEXT) return r;
        }
      }
  return NEXT;
}

// ── Archive of a chat ───────────────────────────────────────────────────────────────────────────────────
// The allowlist of the write lock in `chatRoutes` — pure, exported for the guard (archive.test.js runs the same request
// matrix against the function and against the server). Allowed are exactly: every GET (history, stream, artifacts,
// context, downloads, agents); `DELETE ""` (delete permanently); `PUT /archive` (the restore itself); `POST /stop` (the
// emergency valve — it writes no new work and starts nothing; if the invariant breaks after all, it is the only HTTP way
// to halt a run in the archive). That covers all write paths of the sub-table a person would need on an archived chat;
// the rest come from MCP tools with their OWN chat id — and a chat that runs is never archived.
// The same allowlist applies to a read-only chat (runs/only-readable.js) — one place for "what may a chat do in which
// nothing should run anymore", not two.
export function archiveAllowed(sub, m) {
  if (m === "GET") return true;
  if (sub === "" && m === "DELETE") return true;
  if (sub === "/archive" && m === "PUT") return true;
  if (sub === "/stop" && m === "POST") return true;
  // Stopping the dynamic workflow is an emergency valve like /stop (archiving is locked while it runs — if the invariant
  // breaks anyway, it must be stoppable).
  if (m === "POST" && /^\/dyn-workflows\/runs\/[^/]+\/stop$/.test(sub)) return true;
  // Likewise stopping the graph workflow of a start (the start itself stays locked).
  return m === "POST" && /^\/graph-workflows\/[^/]+\/stop$/.test(sub);
}
// The response of the write lock — ONE wording for both places (before and after the body).
function archiveLock() {
  return { error: T("The chat is archived — read only. Restore it first."), archived: true };
}
// The lock a SECOND time, after the body: `chatRoutes` checks BEFORE reading the body, with the chat of that moment. A
// PUT /archive arriving during a slow body (large upload, second device) runs through synchronously — without this line
// the request already in flight would then write into the archived chat (title, goal, pin, an attachment file). Fresh
// from the DB. Every sub-slice of this file that writes WITHOUT a run after `await readBody(`/`await readRawBody(` calls
// it; an exception carries the comment `// archive: <reason>` at the body await — archive.test.js counts both.
// Paths that start a run (message, steer, ask answer, channels, workflow) do not need it: doRun restores the chat.
function archivedNow(id) {
  return Boolean(store.getChat(id)?.archivedAt);
}
// `archivable`, `isChildChat` and `chatKind` live in `./genus.js` — the fork (`runs/routes.js`) reads the same rule.

// ── The folder side of the archive ──────────────────────────────────────────────────────────────────
// The pre-check of an ACTIVE folder (GET and PUT …/archive, the same function): per active chat the open work, and a
// non-archivable chat (special chat, app agent) is itself a reason — `not_archivable`, only here, not in ARCHIVE_REASONS
// (the chat PUT answers 400 for it). Why 409 and not "silently take along" or "silently detach": taking along would
// archive a chat that never comes back on its own; the folder cannot SKIP it, because the trigger
// `folder_archive_only_without_active` refuses a folder with an active chat — that is the invariant and it stays
// untouched; detaching would be a silent change nobody ordered. The 409 changes nothing and names the chat; it gets out
// with PATCH {folderId: null}. It can no longer get in (PATCH folderId ⇒ 400) — the rule here covers legacy data and any
// future path.
//
// Such a chat appears in NO list — "take it out of the folder first" would be a dead end. So the text names the KIND
// (manager conversation, app agent), says that it is in no list, and names the only way out; the 409 of the folder PUT
// adds title and kind in the sentence. Nothing is moved on its own. The kind in words: `./genus.js:chatKind`.
function folderLocks(active) {
  return active.map((c) => ({
    chatId: c.id, title: c.title || "",
    open: [
      ...(archivable(c) ? [] : [{ reason: "not_archivable", text: T`${chatKind(c)} — cannot be archived and is in no chat list; the folder stays active until the chat is taken out (PATCH /api/chats/${c.id} with {"folderId": null})` }]),
      ...openWork(c.id),
    ],
  })).filter((x) => x.open.length);
}
// The sentence of the 409 at the folder PUT: names the chats that are in no list, with title and kind — the other locked
// chats are in the list and carry their reasons per row (`chats[].open`).
function folderLockSet(locked) {
  const invisible = locked
    .filter((g) => g.open.some((o) => o.reason === "not_archivable"))
    .map((g) => { const c = store.getChat(g.chatId); return `„${g.title || T("Untitled")}“ (${c ? chatKind(c) : "?"})`; });
  const set = T("Work is still open in this folder — nothing archived");
  return invisible.length
    ? `${set}. ${T("In no list, but in the folder")}: ${invisible.join(", ")}`
    : set;
}
// What DELETE …?permanently=1 deletes — and thus what the confirmation names (GET …/archive on the archived folder). ONE
// function for both, otherwise the confirmation would say "1 chat" and the server delete 2. Only chats that are
// archivable: a manager conversation or special chat in the folder (legacy) is not deleted; `deleteChatFolder` detaches
// it. A manager folder itself never gets here (the lock in chatFolderRoutes lets only GET through, and the set is empty).
function finalSet(folder) {
  return store.chatsInFolder(folder.id, { archive: "only" }).filter((c) => archivable(c));
}
// The context files that go with the folder (on dissolve as on permanent deletion). If counting fails (a symlink in the
// folder, too many files, an I/O error) the number is UNKNOWN — `null`, never 0 (empty is not unknown): a guessed 0 would
// silence the confirmation while the DELETE deletes the files anyway (`removeFolderContext` clears the directory without
// counting). The clients then say "number unknown". A folder without a context directory is not an unknown: `listIn`
// returns [] there and the number is 0.
function contextFilesCount(folderId) {
  try { return artifactStore.listContextFiles(folderId).length; } catch { return null; }
}
// A missing field is not an instruction: `archived` is required and boolean, nothing is guessed.
const archiveFieldError = () => ({ error: T("archived (true/false) required") });

export async function archiveChatRoutes(ctx) {
  const { req, res, url, p, m, id, sub, chat } = ctx;
        if (sub === "/archive" && (m === "GET" || m === "PUT")) {
          if (isChildChat(chat)) {
            return send(res, 400, { error: T("A background run is not archived on its own — archive the chat that started it.") });
          }
          if (!archivable(chat)) {
            return send(res, 400, { error: T("Only coding chats can be archived") });
          }
          if (m === "GET") {
            return send(res, 200, {
              archived: Boolean(chat.archivedAt), archivedAt: chat.archivedAt ?? null,
              open: openWork(id), terminals: countTerminalsByTag(`chat:${id}`),
            });
          }
          // Read the body BEFORE any check; from here to the response no more await (no gap for a run start between
          // openWork, the write and ending the shells).
          const b = await readBody(req); // archive: the archive route itself — it reads the chat fresh afterwards
          if (typeof b.archived !== "boolean") return send(res, 400, archiveFieldError());
          if ("dismissQuestion" in b && typeof b.dismissQuestion !== "boolean") {
            return send(res, 400, { error: T("dismissQuestion must be true or false") });
          }
          const now = store.getChat(id); // fresh — `chat` is from before the await
          if (!now) return send(res, 404, { error: "chat not found" });
          const kind = "normal"; // the only archivable genus (`archivable` above)
          // Same state: write nothing, no event — the old timestamp stays.
          if (b.archived === Boolean(now.archivedAt)) return send(res, 200, { ok: true, unchanged: true, chat: now });
          if (!b.archived) {
            // Restore; if the chat is in an archived folder, the trigger restores the folder too — the other chats of
            // the folder stay in the archive.
            const r = store.fetchChatBack(id);
            const folderIds = r.folderBack ? [r.folderBack] : [];
            if (r.changed) reportArchive({ workspaceId: now.workspaceId, kind, chatIds: [id], folderIds, archived: false, reason: "user" });
            return send(res, 200, { ok: true, chat: store.getChat(id), folderIds, terminalsEnded: 0 });
          }
          // Archive through the ONE archive path (./archive.js — the same the auto-archive tick takes with
          // `reason: "auto"`): open work ⇒ 409 with all reasons. If the open question card is the ONLY reason, the PERSON
          // may dismiss it and archive in the same step — `dismissAsk` writes an empty answer, reports `ask_resolved` and
          // clears the bell, but starts NO run (unlike the ask answer). Any further reason ⇒ 409 as without the field,
          // and the card stays open. Synchronous up to the response (no await).
          const r = chatArchive(id, { reason: "user", dismissQuestion: b.dismissQuestion === true });
          if (r.open.length) {
            return send(res, 409, { error: T("Work is still open in this chat — not archived"), open: r.open });
          }
          return send(res, 200, { ok: true, chat: store.getChat(id), folderIds: [], terminalsEnded: r.terminalsEnded ?? 0 });
        }
  return NEXT;
}

export async function coreChatRoutes(ctx) {
  const { req, res, url, p, m, id, sub, chat } = ctx;
        // `parentChatId`: the orchestrator if this chat is the child chat of a background run — else null (the field is
        // always present).
        if (sub === "" && m === "GET") return send(res, 200, { ...chat, parentChatId: store.graphStartOfChild(id)?.chatId ?? null });
        if (sub === "" && m === "PATCH") {
          const b = await readBody(req);
          if (archivedNow(id)) return send(res, 409, archiveLock());
          // The row FRESH — `ctx.chat` is from before the await (as in instanceChatRoutes below). Two PATCHes at once
          // (`{projectId: P2}` and `{instance: "copy-k1"}`): the second would otherwise check its instance against the
          // project from BEFORE the first (P1, valid) and bind the chat in P2 to a copy of P1. Applies to the whole PATCH
          // (project, folder, provider, ultracode, switch hints).
          const chat = store.getChat(id);
          if (!chat) return send(res, 404, { error: "chat not found" });
          const fields = {};
          if (typeof b.title === "string" && b.title.trim()) { fields.title = b.title.trim(); fields.titled = 1; } // named by hand → no auto title anymore
          if (typeof b.profile === "string") fields.profile = b.profile;
          if (typeof b.model === "string") fields.model = b.model.trim();
          if (typeof b.permissionMode === "string") {
            fields.permissionMode = PERMISSION_MODES.includes(b.permissionMode) ? b.permissionMode : "";
          }
          // `effortChoice`: the EXPLICIT choice of the level — the client sends it only from paths on which the person
          // chooses the level (/effort, effort picker), never from a path that merely passes the level through. It only
          // applies TOGETHER with `effort` or `ultracode` (alone it would say "chosen" without anything chosen ⇒ 400), and
          // it is a boolean (else 400). Checked BEFORE any write.
          if (b.effortChoice !== undefined) {
            if (typeof b.effortChoice !== "boolean") return send(res, 400, { error: T("effortChoice is true or false.") });
            if (b.effort === undefined && b.ultracode === undefined) {
              return send(res, 400, { error: T(
                "effortChoice only applies together with effort or ultracode.") });
            }
          }
          // Level via the save verdict (workflows.js) — three statements, three answers: MISSING (`{}`) leaves it; EMPTY
          // is a 400, because every chat carries a level and "back to Auto" no longer exists; UNKNOWN (including null and
          // non-strings) is a 400 with wording — a typo must not silently become empty.
          if (b.effort !== undefined) {
            const u = effortSavable(b.effort);
            if (u.kind === "empty") return send(res, 400, { error: T("A chat needs an effort level — “Auto” no longer exists.") });
            if (u.kind === "unknown") return send(res, 400, { error: u.error });
            fields.effort = u.level;
          }
          if (typeof b.browserMode === "string") fields.browserMode = BROWSER_MODES.includes(b.browserMode) ? b.browserMode : "";
          // Provider switch of a chat: the session id is provider-specific → drop it on a switch (the next run starts a
          // fresh session with the new provider). An unknown identifier is a 400 (as on creation).
          if (b.provider !== undefined && b.provider !== null && b.provider !== "" && !isProviderId(b.provider)) {
            return send(res, 400, { error: T("Unknown provider") });
          }
          if (isProviderId(b.provider) && b.provider !== providerForChat(chat)) {
            fields.provider = b.provider;
            fields.claudeSessionId = null;
            fields.contextTokens = 0;
          }
          // Ultracode: a TOGGLE beside the level. Missing ⇒ unchanged, not a boolean ⇒ 400. Independent: enabling and
          // disabling leave the level, a new level, a model or provider switch leave the toggle — the ONE rule
          // (`ultracode.js`) the `updateChat` below passes through.
          const uc = ultracodeSavable(b.ultracode);
          if (uc.kind === "unknown") return send(res, 400, { error: uc.error });
          if (uc.kind === "value") fields.ultracode = uc.on ? 1 : 0;
          // Own choice of the level: a NEW level or a toggled ultracode mode from this client path is a choice of the
          // person. The marker has no reader anymore, but is still set (the fork inherits it, runs/routes.js): web and
          // iOS send `effortChoice`, and the column stays. The same value as before is NOT an instruction; with
          // `effortChoice: true` (see above) even the SAME value is one. Only this path sets the marker — no server writer.
          if (!chat.specialRole && (b.effortChoice === true
            || ("effort" in fields && fields.effort !== (chat.effort || ""))
            || ("ultracode" in fields && fields.ultracode !== (chat.ultracode ? 1 : 0)))) fields.effortOwn = 1;
          if (typeof b.goal === "string") fields.goal = b.goal.slice(0, TARGET_MAX);
          // Pause the goal: a boolean (else 400), and `true` only with a goal that is not empty AFTER this PATCH (the one
          // sent along counts, else the stored one) — a pause without a goal would halt nothing and silently survive until
          // the next /goal. Checked BEFORE any write. A `goal` without this field lifts the pause (updateChat, in ONE place
          // for every path); with both fields both apply. `false` starts no run — the goal takes effect again from the
          // next one.
          if (b.goalPaused !== undefined) {
            if (typeof b.goalPaused !== "boolean") return send(res, 400, { error: T("goalPaused is true or false.") });
            if (b.goalPaused && !String("goal" in fields ? fields.goal : chat.goal || "").trim()) {
              return send(res, 400, { error: T("There is no goal to pause.") });
            }
            fields.goalPaused = b.goalPaused ? 1 : 0;
          }
          if (typeof b.pinned === "boolean") fields.pinned = b.pinned ? 1 : 0;
          // Autocompact per chat: null = default, 0 = off, else a stage.
          if ("autocompact" in b) {
            if (b.autocompact === null) fields.autocompact = null;
            else {
              const st = autocompact.stage(b.autocompact);
              if (st === null) return send(res, 400, { error: T("Invalid auto-compaction level.") });
              fields.autocompact = st;
            }
          }
          // The cap in tokens, likewise per chat and likewise three-valued.
          if ("autocompactMax" in b) {
            if (b.autocompactMax === null) fields.autocompactMax = null;
            else {
              const mx = autocompact.maxStage(b.autocompactMax);
              if (mx === null) return send(res, 400, { error: T("Invalid auto-compaction cap.") });
              fields.autocompactMax = mx;
            }
          }
          // Notifications per kind. The WHOLE set is written, not a single key: "default" is the absence of an entry,
          // and a partial patch could never take a set value back to default.
          if ("notify" in b) {
            // A job chat carries the kinds of a chat AND of a schedule; a legacy schedule chat carries the inherited
            // choice of its schedule.
            const allowed = chat.jobId ? JOB_NOTIFICATIONS : chat.scheduleId ? notifications.SCHEDULE_KINDS : notifications.CHAT_KINDS;
            fields.notify = JSON.stringify(notifications.normalizeChoice(b.notify, allowed));
          }
          if ("projectId" in b) {
            if (b.projectId === null || b.projectId === "") {
              fields.projectId = null;
            } else {
              const ws = store.getWorkspace(chat.workspaceId);
              if (!(ws?.projects || []).some((pr) => pr.id === b.projectId)) {
                return send(res, 400, { error: T("Project does not belong to this workspace") });
              }
              fields.projectId = b.projectId;
            }
            // The switch applies from the next turn and is therefore ALSO allowed mid-turn and beside live background
            // work — no 409. The running turn, its subagents and dynamic workflows stay in the instance they started in:
            // they count toward the idle state of their old project, and the fence admits their calls from that instance
            // to the routes of THIS chat (projectbox/fence.js).
          }
          // Folder binding. It only applies within the same scope: a project chat belongs in folders of ITS project, a
          // workspace chat in workspace folders. If the chat switches project in the same request, the NEW project counts.
          // A project that no longer exists (deleted, the chat survived it — legacy) is NOT a scope: the chat counts as a
          // workspace chat and may go into a workspace folder.
          const scopeProject = "projectId" in fields ? fields.projectId : (chat.projectId && store.getProject(chat.projectId) ? chat.projectId : null);
          if ("folderId" in b) {
            if (b.folderId === null || b.folderId === "") {
              fields.folderId = null;
            } else {
              // A special chat or an app agent chat belongs in no folder — through the folder it would otherwise go to the
              // archive (and perish with ?permanently=1), past the 400 of the chat PUT. OUT (`folderId: null`) always
              // works: the path for legacy data.
              if (!archivable(chat)) {
                return send(res, 400, { error: T("This chat does not belong in a folder (special or app-agent chat)") });
              }
              const folder = store.getChatFolder(b.folderId);
              if (!folder || folder.workspaceId !== chat.workspaceId) {
                return send(res, 400, { error: T("Folder does not belong to this workspace") });
              }
              // The genus must match: without this line a coding chat could be moved into a manager folder (legacy) — it
              // would be visible in no list there.
              if ((folder.kind || "normal") !== "normal") {
                return send(res, 400, { error: T("Folder belongs to a different chat kind") });
              }
              if ((folder.projectId || null) !== (scopeProject || null)) {
                return send(res, 400, { error: T("Folder belongs to a different project") });
              }
              fields.folderId = folder.id;
            }
          } else if ("projectId" in fields && chat.folderId) {
            // Project switch without a folder: if the previous folder no longer fits, it is dropped (the chat would
            // otherwise hang in a folder its view no longer shows).
            const current = store.getChatFolder(chat.folderId);
            if ((current?.projectId || null) !== (scopeProject || null)) fields.folderId = null;
          }
          // The instance: if the field is MISSING it stays; `null` and the main name mean main; else a live instance of
          // the project the chat is in AFTER this PATCH (runs/instance-switch.js instanceChoice — 409 with a code). Checked
          // BEFORE the write: a no changes nothing, not even another field sent along. It takes effect from the next turn
          // (below). The child chat of a graph run never switches: 409 via `chatId`.
          const instanceAsked = b.instance !== undefined;
          let instanceNew = null;
          if (instanceAsked) {
            // A person is only who did not come through the fence (`ctx.fence` — an agent with a token from its project
            // network); a job chat does not switch otherwise (runs/instance-switch.js).
            try { instanceNew = instanceChoice("projectId" in fields ? fields.projectId : chat.projectId, b.instance, { chatId: id, ofHuman: !ctx.fence }); }
            catch (e) { if (e instanceof InstanceChoiceError) return send(res, e.status, { error: e.message, code: e.code }); throw e; }
          }
          // Metadata edits (title/profile/project/pin) do NOT bump updatedAt — the "recent" sort stays on the last real
          // message/activity.
          let updated = store.updateChat(id, ultracodeFollowUp(chat, fields));
          // If the project switched mid-turn, the turn carries the marker — the next turn learns where that one ran
          // (silent hint, runs/agents.js). Without a running turn this does nothing. updateChat set `chats.instance` to
          // NULL in the SAME UPDATE — if the chat worked in a copy, the silent hint to the next turn says so, and a
          // separator in the history (runs/instance-switch.js instanceAfterProjectSwitch).
          const projectSwitched = "projectId" in fields && (fields.projectId || null) !== (chat.projectId || null);
          if (projectSwitched) {
            turnProjectSwitched(id, { toProject: fields.projectId || null }); // the turn's instance comparison uses this
            void closeChatBrowser(id); // its browser restarts at the new project's location (logins from the old profile)
            // `toInstance` — if the same PATCH chooses a copy of the new project, the hint names it.
            copyProjectSwitched(id, { ofProject: chat.projectId || null, toProject: fields.projectId || null, ofInstance: chat.instance || null, toInstance: instanceAsked ? instanceNew : null });
          }
          // The instance switch — column, separator, event and the marker on the running turn (it stays pinned, the next
          // one starts in the new instance; the CLI session moves along via runs/session-location.js).
          if (instanceAsked && instanceNew) chatInstanceSet(id, instanceNew, { ofHuman: !ctx.fence });
          else if (projectSwitched) instanceAfterProjectSwitch(id, chat.instance);
          else if (instanceAsked) chatInstanceSet(id, null);
          if (instanceAsked || projectSwitched) updated = store.getChat(id);
          if ("title" in fields) {
            sse(id, { type: "harness", subtype: "title", chatId: id, title: updated.title });
            broadcast({ type: "chat_title", chatId: id, title: updated.title });
          }
          // Goal and pause to the OTHER devices (contract with web and iOS): if this PATCH actually changes `goal` or
          // `goalPaused` (a new goal, cleared, paused, resumed — including the pause a newly written goal lifts in
          // updateChat), both go FRESH from the row onto the chat's stream. The same value again and a PATCH without the
          // two fields send nothing. The sending device receives it too and sets the same state.
          if (("goal" in fields || "goalPaused" in fields)
            && (updated.goal !== chat.goal || updated.goalPaused !== chat.goalPaused)) {
            sse(id, { type: "harness", subtype: "target", goal: updated.goal, goalPaused: updated.goalPaused });
          }
          return send(res, 200, updated);
        }
        if (sub === "" && m === "DELETE") {
          // Do not delete while something would still write afterwards — a run, a compaction, a target verdict —,
          // otherwise orphaned rows remain. The same query as the archive (runs/archive.js deleteObstacles); what the
          // closing path ends itself (subagents, workflows, queue, question …) does not hold the delete back.
          let obstacles = deleteObstacles(id);
          if (obstacles.length) return send(res, 409, deleteLock(obstacles));
          // The background runs of this chat: first abort their workflows and let their turns end (at most 15 s), then
          // the child chats fall with it (closeChats, it first). If one is still stopping, nothing changes — 409, and
          // the person tries again in a moment.
          if (!(await stopKindRuns(id))) {
            return send(res, 409, { error: T("A background run of this chat is still stopping — try again in a moment.") });
          }
          // After waiting: if it has started running itself in the meantime, the first check applies again; if it is
          // already gone (a second DELETE was faster), nothing is left to do.
          if (!store.getChat(id)) return send(res, 200, { ok: true });
          obstacles = deleteObstacles(id);
          if (obstacles.length) return send(res, 409, deleteLock(obstacles));
          // The cascade (channels, history, shells, queue, scratch, attachments, artifacts, browser profile) is ONE
          // function — the second caller is the permanent deletion of an archived folder.
          deleteChatPermanently(chat);
          return send(res, 200, { ok: true });
        }
        // Without `window=1` the full history (old contract); with it the window with truncation — chats/log-window.js.
        if (sub === "/log" && m === "GET") return send(res, 200, willWindow(url.searchParams) ? logWindow(id, url.searchParams) : store.listMessages(id));
  return NEXT;
}

// ── Switch the instance ─────────────────────────────────────────────────────────────────────────────
// POST /api/chats/:id/instance { instance } — the route of the tool cbase_switch_instance: the same check as the PATCH
// (runs/instance-switch.js instanceChoice: `null`/main or a live instance of THIS project; 409/400 with a code), the same
// write path (chatInstanceSet: column, separator, event, marker on the running turn — it stays pinned) and AFTERWARDS the
// wake call (instanceSwitchWakeText: never into the running turn) — the chat wakes at the turn end in the new instance.
// Same instance: nothing, no wake call. The field is required (400 — a missing field is not an instruction), any other
// field is a 400. From a project network only for a chat of the token's instance (fence). A person switches via the
// PATCH (without a wake call).
// → 200 with the chat and whether it changed and woke. Guard: server/backend/test/copy-tools.test.js.
export async function instanceChatRoutes(ctx) {
  const { req, res, m, id, sub, chat } = ctx;
  if (sub === "/instance" && m === "POST") {
    const b = await readBody(req);
    if (archivedNow(id)) return send(res, 409, archiveLock());
    if (!b || typeof b !== "object" || Array.isArray(b)) return send(res, 400, { error: "The body is not a JSON object" });
    const unknown = Object.keys(b).filter((k) => k !== "instance");
    if (unknown.length) return send(res, 400, { error: `unknown fields: ${unknown.join(", ")} (allowed: instance)` });
    if (!("instance" in b)) return send(res, 400, { error: T("`instance` is missing — \"main\" or \"copy-<name>\".") });
    const now = store.getChat(id) || chat; // fresh — `chat` is from before the await
    let fresh;
    // The child chat of a graph run ⇒ 409 — no separator, no wake call. A person never speaks here (they switch via the
    // PATCH) — a job chat ⇒ 409 (the default of instanceChoice).
    try { fresh = instanceChoice(now.projectId, b.instance, { chatId: id }); }
    catch (e) { if (e instanceof InstanceChoiceError) return send(res, e.status, { error: e.message, code: e.code }); throw e; }
    const changed = chatInstanceSet(id, fresh);
    let woken = false;
    if (changed) {
      const t = instanceSwitchWakeText(fresh);
      const r = deliverUserPrompt(store.getChat(id), { prompt: t, display: t, cause: "event" });
      woken = r?.ok !== false;
    }
    return send(res, 200, { chat: store.getChat(id), instance: fresh || "main", changed, woken });
  }
  return NEXT;
}

export async function contextChatRoutes(ctx) {
  const { req, res, url, p, m, id, sub, chat } = ctx;
        // Delta history for cached clients: only the rows AFTER `since`, plus the total. The client checks — if `total`
        // does not match (own state + delivered rows), something was deleted (cleaned-up partial output of an aborted
        // run) and it reloads completely. That is the difference between waiting seconds on a chat switch and "instant".
        if (sub === "/log/delta" && m === "GET") {
          const since = Number(url.searchParams.get("since")) || 0;
          const stats = store.messageStats(id);
          // Cache up to date? Then read nothing at all — the most common case, and it costs one row.
          if (since >= stats.lastId && since > 0) return send(res, 200, { total: stats.total, lastId: stats.lastId, rows: [] });
          const fresh = store.listMessagesSince(id, since);
          return send(res, 200, { total: stats.total, lastId: stats.lastId, rows: url.searchParams.get(WINDOW_PARAM.truncate) === "1" ? truncateRows(fresh) : fresh });
        }
        // ONE row untruncated (chats/log-window.js): expanding a tool result truncated in the window.
        const rowHits = m === "GET" && /^\/log\/row\/(\d+)$/.exec(sub);
        if (rowHits) {
          const row = store.getMessageRow(id, rowHits[1]);
          return row ? send(res, 200, row) : send(res, 404, { error: T("Row not in this chat") });
        }
        // /clear: KEEP the visible history, but cut the provider session and with it the model context hard. The
        // dedicated role='clear' row is both the persistent UI marker and the transcript boundary for stateless providers.
        if (sub === "/clear" && m === "POST") {
          if (running.has(id)) {
            return send(res, 409, { error: T("Run active — please wait for the agent to finish.") });
          }
          // Clearing DURING compaction would mean: the summary lands in a chat that was just cleared — it would describe
          // a history that no longer exists.
          if (compacting.has(id)) {
            return send(res, 409, { error: T("The context is being compacted — please wait a moment.") });
          }
          const workflow = store.getWorkflowRun(id);
          if (store.workflowOpen(workflow)) {
            return send(res, 409, { error: T("A workflow is still active in this chat.") });
          }
          return send(res, 200, clearChatContext(chat));
        }
  return NEXT;
}

export async function itemChatRoutes(ctx) {
  const { req, res, url, p, m, id, sub, chat } = ctx;
        // Workflows of this chat: the effective selection (workspace + project, as with skills) for the picker in the
        // composer. Each entry carries the `shortName` (`/workflow:<shortName>`), computed ONCE here over the whole
        // effective set — the clients do not compute.
        if (sub === "/workflows" && m === "GET") {
          if (!chat.workspaceId) return send(res, 200, []);
          const list = store.effectiveWorkflows(chat.workspaceId, focusedProject(chat)?.id ?? null);
          return send(res, 200, withShortNames(list).map((w) => ({ ...workflowMeta(w), shortName: w.shortName })));
        }
        // Skills of this chat: the same effective set a run materialises (workspace + project) — for the slash picker
        // in the composer. Deliberately NOT the CLI's slash list: only Claude has one (in the `system/init` event), it
        // carries the CLI's own commands (/clear, /compact, /model — all handled CLIENT-SIDE in cbase) and Codex has
        // none. What is listed here is provider-neutral and belongs to cbase.
        if (sub === "/skills" && m === "GET") {
          const list = chatSkills(chat);
          // effectiveSkills sets `originProject` only in the workspace view — the picker uses it to say which project a
          // skill comes from instead of listing twenty identical-looking names.
          return send(res, 200, list.map((s) => ({ ...skillMeta(s), originProject: s.originProject || "" })));
        }
        // The GUIDE of a skill — what `cbase_skill` fetches. Deliberately the same computation as the list above: what
        // is not in this chat's catalog cannot be loaded here either, whatever name a model remembers or invents.
        const skn = sub.match(/^\/skills\/([a-z0-9][a-z0-9-]*)$/);
        if (skn && m === "GET") {
          const s = chatSkills(chat).find((x) => x.name === skn[1]);
          if (!s) return send(res, 404, { error: T`No skill "${skn[1]}" for this chat.` });
          // `id`, `version`, `level`: what cbase_skill_write needs — changing and deleting require the version that was
          // read. `ofAgent` + `hint`: the same marker as in the catalog (skill-catalog.js) — no person has read an
          // agent's guide.
          const ofAgent = skillOfAgent(s);
          return send(res, 200, {
            id: s.id, name: s.name, description: s.description, body: s.body, version: s.version, level: s.projectId ? "project" : "workspace",
            originProject: s.originProject || "", originProjectPath: s.originProjectPath || "",
            ...(ofAgent ? { ofAgent: true, hint: AGENT_HINT } : {}),
          });
        }
  return NEXT;
}

export async function fileChatRoutes(ctx) {
  const { req, res, url, p, m, id, sub, chat } = ctx;
        // Captures of the chat browser (screenshots/videos) — the caller is the cbase MCP server. profileKey tells main
        // (chatId) and subagent browsers (chatId-agent-<n>) apart; foreign keys are off limits, otherwise a chat could
        // capture other chats' browsers.
        const captureKeyOf = (b) => {
          const k = String(b?.profileKey || id);
          return k === id || k.startsWith(`${id}-agent-`) ? k : null;
        };
        if (sub === "/captures" && m === "POST") {
          const b = await readBody(req); // archive: MCP only (cbase_screenshot) from the running own chat — which is never archived
          const profileKey = captureKeyOf(b);
          if (!profileKey) return send(res, 403, { error: "profileKey does not belong to this chat." });
          try {
            const { capture, data } = await takeScreenshot({ chatId: id, profileKey, tab: b.tab, caption: b.caption, show: b.show });
            return send(res, 201, { capture, data });
          } catch (e) { return send(res, e.status || 500, { error: String(e.message || e) }); }
        }
        if (sub === "/captures" && m === "GET") return send(res, 200, { captures: listCaptures(id) });
        if (sub === "/captures/record" && m === "POST") {
          const b = await readBody(req); // archive: MCP only (cbase_recording_start/_stop) from the running own chat
          const profileKey = captureKeyOf(b);
          if (!profileKey) return send(res, 403, { error: "profileKey does not belong to this chat." });
          try {
            if (b.action === "start") {
              const recording = await startRecording({ chatId: id, profileKey, tab: b.tab, fps: b.fps, maxSeconds: b.maxSeconds });
              return send(res, 201, { recording });
            }
            if (b.action === "stop") return send(res, 200, await stopRecording({ profileKey, caption: b.caption, show: b.show }));
            return send(res, 400, { error: "action must be start or stop." });
          } catch (e) { return send(res, e.status || 500, { error: String(e.message || e) }); }
        }
        // Captures are shown at the turn end on their own (chats/captures-show.js).
        const capFile = sub.match(/^\/captures\/(c-[0-9a-f-]+)\/file\/([a-z0-9.]+)$/);
        if (capFile && m === "GET") {
          // In a project's runtime folder via the descriptor (captures.js captureFile): a symlink or FIFO in place of the
          // file is "not found"; the path is never served.
          const file = captureFile(id, capFile[1], capFile[2]);
          if (!file) return send(res, 404, { error: "capture file not found" });
          return serveRanged(req, res, file.path, capFile[2].endsWith(".mp4") ? "video/mp4" : "image/jpeg", { fd: file.fd });
        }
        if (sub === "/attachments" && m === "POST") {
          // Raw upload (body = file content), file name via ?name=…; timestamp prefix against collisions.
          const buf = await readRawBody(req);
          if (archivedNow(id)) return send(res, 409, archiveLock());
          if (!buf.length) return send(res, 400, { error: "empty file" });
          const file = `${Date.now().toString(36)}-${safeFileName(url.searchParams.get("name"))}`;
          const dir = attachmentLocation(id);
          // In a project's runtime folder via the descriptor (runs/runtime-write.js): a symlink `attachments/<chat> →
          // /somewhere` created by the project container would otherwise place the file in the backend. If the path
          // leads outside: 409, nothing written.
          try {
            if (!writeInRuntimeFolder(path.join(dir, file), buf)) {
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(path.join(dir, file), buf);
            }
          } catch (e) {
            if (e?.code !== "EOUTSIDE" && e?.code !== "ENOFILE") throw e;
            return send(res, 409, { error: T`The attachment folder leads outside the runtime folder — nothing saved (${e.message})` });
          }
          // An attachment is at first only an addition to ONE message. So that it does not get lost in the history, it
          // also goes into the chat's artifacts (folder "uploads/"): there it is permanent, visible in the file view,
          // downloadable and — if the chat is in a chat folder — readable for the sibling chats. An existing file is
          // NEVER overwritten (uniqueArtifactPath), and an error here must not fail the upload: the attachment itself is
          // already stored.
          // `artifact=0` excludes the copy. The composer sets it for PASTED TEXT: technically the same attachment, but
          // not a file someone uploaded — every long paste would otherwise end up in the artifacts permanently.
          let copied = null;
          if (url.searchParams.get("artifact") !== "0" && buf.length <= artifactStore.MAX_ARTIFACT_BYTES) {
            try {
              const wanted = artifactStore.sanitizeArtifactPath(`uploads/${safeFileName(url.searchParams.get("name"))}`);
              const artifact = artifactStore.writeArtifact(id, artifactStore.uniqueArtifactPath(id, wanted), buf, { overwrite: true });
              sse(id, { type: "harness", subtype: "artifact_changed", op: "write", artifact });
              copied = artifact.path;
            } catch (e) {
              console.error("[artifacts] attachment could not be saved as an artifact:", e?.message || e);
            }
          }
          // Width and height of an image from its header — the client reserves the space before loading.
          return send(res, 201, withImageDimensions({
            name: safeFileName(url.searchParams.get("name")), file,
            mime: attachmentMime(file), size: buf.length, artifactPath: copied,
          }, isImageName(file) ? imageDimensions(buf) : null));
        }
        const attachmentMatch = sub.match(/^\/attachments\/([^/]+)$/);
        if (attachmentMatch && m === "GET") {
          const file = safeFileName(decodeURIComponent(attachmentMatch[1]));
          const full = attachmentPath(id, file); // reader with fallback
          if (!fs.existsSync(full)) return send(res, 404, { error: "attachment not found" });
          // In the runtime folder of a converted project via the checked descriptor: an attachment the project container
          // replaced with a symlink to the outside is not served. Without an instance `null`.
          let fd;
          try { fd = openInRuntimeFolder(full); } catch (e) { return send(res, 403, { error: String(e?.message || e) }); }
          // `private` for the same reason as with the captures: Cloudflare caches image extensions at the edge by
          // default — without `private` chat attachments would be retrievable there without a login.
          // Open before the header (or take the checked descriptor), serve via pipeline (supplyFile).
          // The attachment folder lives in the runtime folder a project container writes rw — an `.svg` with a script
          // would be served inline as `image/svg+xml` under the cbase origin. Hence nosniff and sandbox.
          return supplyFile(res, fd === null ? { path: full } : { fd }, { "Content-Type": attachmentMime(file), "Cache-Control": "private, max-age=31536000", ...servingHeader(attachmentMime(file)) });
        }
        // Chat artifacts are arbitrary persistent files. Their semantics come solely from skills or the running
        // conversation; the server only enforces scope, limits and optimistic concurrency via SHA-256.
        // If the chat is in a chat folder, the artifacts of the sibling chats are INCLUDED (read-only) — every row
        // carries its origin chat and `own`.
        if (sub === "/artifacts" && m === "GET") {
          try {
            const own = artifactStore.listArtifacts(id).map((a) => ({ ...a, chatId: id, chatTitle: chat.title, own: true }));
            const shared = [];
            for (const sibling of artifactSiblings(chat)) {
              for (const a of artifactStore.listArtifacts(sibling.id)) {
                shared.push({ ...a, chatId: sibling.id, chatTitle: sibling.title, own: false });
              }
            }
            return send(res, 200, [...own, ...shared]);
          } catch (e) { return send(res, e?.status || 400, { error: String(e?.message || e) }); }
        }
        // Context files of the chat folder this chat is in — READ-ONLY. They belong to the folder, not the chat: the
        // person puts them there so that every chat of the folder has the same basis (briefing, specification,
        // minutes). If the chat is in no folder the list is empty — not an error, since the agent may ask for it.
        if (sub === "/folder-context" && m === "GET") {
          if (!chat.folderId) return send(res, 200, { folderId: null, folderName: "", files: [] });
          try {
            const folder = store.getChatFolder(chat.folderId);
            return send(res, 200, {
              folderId: chat.folderId,
              folderName: folder?.name || "",
              files: artifactStore.listContextFiles(chat.folderId),
            });
          } catch (e) { return send(res, e?.status || 400, { error: String(e?.message || e) }); }
        }
        if (sub === "/folder-context/file" && m === "GET") {
          if (!chat.folderId) return send(res, 404, { error: T("This chat is not in a folder") });
          try {
            return send(res, 200, artifactStore.readContextFile(chat.folderId, url.searchParams.get("path"), {
              offset: url.searchParams.get("offset"), maxBytes: url.searchParams.get("maxBytes"),
            }));
          } catch (e) { return send(res, e?.status || 400, { error: String(e?.message || e) }); }
        }
        if (sub === "/artifacts/file" && m === "GET") {
          const src = artifactSource(chat, url.searchParams.get("chatId"));
          if (!src) return send(res, 403, { error: T("Artifact belongs to a chat outside this folder") });
          try {
            const artifact = artifactStore.readArtifact(src.id, url.searchParams.get("path"), {
              offset: url.searchParams.get("offset"), maxBytes: url.searchParams.get("maxBytes"),
            });
            return send(res, 200, { ...artifact, chatId: src.id, chatTitle: src.title || chat.title, own: src.own });
          } catch (e) { return send(res, e?.status || 400, { error: String(e?.message || e) }); }
        }
        if (sub === "/artifacts/file" && m === "PUT") {
          try {
            const b = await readBody(req);
            if (archivedNow(id)) return send(res, 409, archiveLock());
            if (b.chatId && b.chatId !== id) {
              return send(res, 403, { error: T("Artifacts of other chats are read-only") });
            }
            const artifact = artifactStore.writeArtifact(id, b.path, b.content, {
              encoding: b.encoding, expectedSha256: b.expectedSha256,
            });
            sse(id, { type: "harness", subtype: "artifact_changed", op: "write", artifact });
            return send(res, 200, artifact);
          } catch (e) { return send(res, e?.status || 400, { error: String(e?.message || e) }); }
        }
        // Upload BY HAND (sidebar/mobile): body = raw file content, target as ?path=…, i.e. without the Base64 bloat of
        // the PUT path. A person has read no SHA here; instead the server answers an existing file with 409 + `exists`,
        // and the client asks and retries with ?overwrite=1.
        if (sub === "/artifacts/upload" && m === "POST") {
          const limit = artifactStore.MAX_ARTIFACT_BYTES;
          const mib = `${Math.round(limit / 1048576)} MiB`;
          const tooBig = { error: T`The file is larger than ${mib}` };
          if (Number(req.headers["content-length"] || 0) > limit) return send(res, 413, tooBig);
          let buf;
          try { buf = await readRawBody(req, limit + 1); }
          catch { return send(res, 413, tooBig); }
          if (archivedNow(id)) return send(res, 409, archiveLock());
          if (!buf.length) return send(res, 400, { error: T("The file is empty") });
          let target;
          try { target = artifactStore.sanitizeArtifactPath(url.searchParams.get("path") || url.searchParams.get("name")); }
          catch (e) { return send(res, e?.status || 400, { error: String(e?.message || e) }); }
          try {
            if (url.searchParams.get("overwrite") !== "1" && artifactStore.artifactExists(id, target)) {
              return send(res, 409, {
                error: T`"${target}" already exists in this chat`,
                exists: true, path: target,
              });
            }
            const artifact = artifactStore.writeArtifact(id, target, buf, { overwrite: true });
            sse(id, { type: "harness", subtype: "artifact_changed", op: "write", artifact });
            return send(res, 201, artifact);
          } catch (e) { return send(res, e?.status || 400, { error: String(e?.message || e) }); }
        }
        if (sub === "/artifacts/file" && m === "DELETE") {
          try {
            const wanted = url.searchParams.get("chatId");
            if (wanted && wanted !== id) {
              return send(res, 403, { error: T("Artifacts of other chats are read-only") });
            }
            const artifact = artifactStore.deleteArtifact(id, url.searchParams.get("path"), url.searchParams.get("expectedSha256"));
            sse(id, { type: "harness", subtype: "artifact_changed", op: "delete", artifact });
            return send(res, 200, artifact);
          } catch (e) { return send(res, e?.status || 400, { error: String(e?.message || e) }); }
        }
        if (sub === "/artifacts/download" && m === "GET") {
          const src = artifactSource(chat, url.searchParams.get("chatId"));
          if (!src) return send(res, 403, { error: T("Artifact belongs to a chat outside this folder") });
          try {
            const artifact = artifactStore.artifactDownload(src.id, url.searchParams.get("path"));
            const inline = url.searchParams.get("inline") === "1";
            // Open before the header, serve via pipeline (runtime/http.js supplyFile); the length from fstat.
            return supplyFile(res, { path: artifact.fullPath }, {
              "Content-Type": artifact.mime,
              "Content-Disposition": dispositionHeader(artifact.name, inline),
              "Cache-Control": "private, no-store",
              // An agent — also one in the project container — writes `report.html` and links it; without the sandbox
              // its script would run with the user's session (runtime/serving.js).
              ...servingHeader(artifact.mime),
            });
          } catch (e) { return send(res, e?.status || 400, { error: String(e?.message || e) }); }
        }
        if (sub === "/stream" && m === "GET") {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          // The client joins in the middle of a run here: waiting state, running background work AND the current context
          // size belong in this first event — otherwise a reload mid-run would show "0 / 1M" and know nothing of running
          // agents.
          // Without a running turn the agents come from the OWNER: a background agent outlives its turn, and after
          // `run_done` there is neither runBackground nor runWaiting — the reloading client would otherwise never see it.
          // Likewise the monitors (runs/monitors.js) and the wakeup (runs/wakeup.js): they belong to the chat and
          // outlive their turn — without a turn from the owner, the same three fields.
          const bg = runBackground.get(id) || {};
          const wakeup = wakeupOf(id);
          // The state of the history in DB numbers — highest row id and row count, counted like the cross-check of GET
          // …/log/delta (`messageStats`). A client compares them with its own state and fetches a gap as a delta.
          const state = store.messageStats(id);
          res.write(`data: ${JSON.stringify({ type: "harness", subtype: "connected", lastId: state.lastId, total: state.total, running: running.has(id), compacting: compacting.has(id), waiting: runWaiting.has(id), monitors: bg.monitors || runWaiting.get(id)?.monitors || liveMonitors(id), agents: bg.agents || runWaiting.get(id)?.agents || liveRows(id), tasks: bg.tasks || runWaiting.get(id)?.tasks || [], wakeupAt: bg.wakeupAt || runWaiting.get(id)?.wakeupAt || wakeup?.at || 0, wakeupReason: bg.wakeupReason || runWaiting.get(id)?.wakeupReason || wakeup?.reason || "", wakeupPrompt: bg.wakeupPrompt || runWaiting.get(id)?.wakeupPrompt || wakeup?.prompt?.slice(0, 600) || "", contextTokens: runContext.get(id) ?? chat.contextTokens ?? 0, streamText: runStreamText.get(id) || "", streamTextTruncated: (runStreamText.get(id) || "").length >= RUN_STREAM_MAX, queued: publicPendingInputs(id) })}\n\n`);
          if (!streams.has(id)) streams.set(id, new Set());
          streams.get(id).add(res);
          req.on("close", () => streams.get(id)?.delete(res));
          return;
        }
  return NEXT;
}
