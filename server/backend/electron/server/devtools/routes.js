// Routes: developer tools (terminal, browser, code, LSP, VS Code tunnel). Every function takes ctx = { req, res, url, p, m }
// (sub-slices of a family additionally id/sub/chat, wid/sub/ws or pid/sub/proj) and returns NEXT if it is not
// responsible; any other return means "answered". Order of the calls: ROUTES in server.js.
// Functions: devtoolRoutes (terminal, browsers, devtools proxy, lsp, debug, pick-folder) · codeProjectRoutes
// (browser/ensure itself, everything else via codeRoute: git/*, files/*, upload, debug/launch, terminal, lsp/*) ·
// vscodeTunnelRoutes.

import fs from "node:fs";
import path from "node:path";
import { languageOf } from "../lsp/actions.js";
import { agentAction } from "../lsp/agents.js";
import { responseFromError } from "../lsp/routes.js";
import { AGENT_CHANGE, AGENT_READ } from "../lsp/contract.js";
import { killTerminal, resizeTerminal, subscribeTerminal, terminalAvailable, terminalError, terminalExists, writeTerminal } from "../terminal.js";
import { act as browserAct, attachViewer as browserAttachViewer, closeBrowser, dispatchInput as browserInput, ensureUserBrowser, listBrowsers, proxyDevtools, resolveChromium } from "../browsers.js";
import { unregister as unregisterTunnel, startTunnel, stopTunnel, tunnelStatus } from "../vscode-tunnel.js";
import { debugAvailable, debugCommand, debugEvaluate, debugSetBreakpoints, debugStop, debugSubscribe } from "../debug.js";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { DIRS, pickDirectoryFn } from "../app-state.js";
import { appendMeasurement } from "../browser-measurement.js";
import { runtimeFolderOf } from "../runs/runtime-location.js";
import { instanceForProject, instanceIsCopy, instanceIdentifierOf, instanceNameFromIdentifier, instanceOfChat, projectFromIdentifier } from "../runs/instance.js";
import { ONLY_IN_OPS, projectboxOps } from "../projectbox/ops.js";
import { areaOfTheInstance, instanceOfTheRuntimeFolder } from "../runs/runtime-limit.js";
import { gitInstanceForWorkspace } from "../projectbox/git-assignment.js";
import { projectLocked, projectTerminalTag } from "../projectbox/idle.js";
import { containerName, copyNameOf } from "../projectbox/creation.js";
import { realPath, inArea } from "../runtime/real-path.js";
import { NEXT, readBody, readBodyOrEmpty, send } from "../runtime/http.js";
import { userBrowserTarget } from "./user-browser.js";
import { codeRoute, fileLimit, setupRunningResponse, copyNotReady, liesUnderCodeRoute } from "./code-route.js";
// Upload stamp, chunks with an operation and the write lock of the setup (see the header of code-route.js).
import { setupRunning, layoutWriteLock } from "../projectbox/setup/status.js";
import { writeChunks, chunkBegins } from "../projectbox/setup/operation.js";
import { uploadBegins } from "../runtime/upload-stamp.js";

export async function devtoolRoutes(ctx) {
  const { req, res, url, p, m } = ctx;

      // ── Integrated terminal (PTY sessions, global per termId) ──
      if (p === "/api/terminal/available" && m === "GET") return send(res, 200, { available: terminalAvailable(), error: terminalError() });
      const tm = p.match(/^\/api\/terminal\/([0-9a-f-]+)(\/stream|\/input|\/resize|\/exists)?$/);
      if (tm) {
        const tid = tm[1], op = tm[2] || "";
        if (op === "/exists" && m === "GET") return send(res, 200, { exists: terminalExists(tid) });
        if (op === "/stream" && m === "GET") {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          // Resume point (terminal.js): the browser's EventSource sets the header itself on reconnect, `?from=` is the
          // way of iOS. The header wins — it is the newer state, a query would be fixed in the URL. The gateway passes
          // all headers through and does not buffer.
          const from = req.headers["last-event-id"] ?? url.searchParams.get("from");
          if (!subscribeTerminal(tid, res, from)) { res.write("event: exit\ndata: {}\n\n"); res.end(); }
          return;
        }
        if (op === "/input" && m === "POST") { const b = await readBody(req); return send(res, 200, { ok: writeTerminal(tid, String(b.data ?? "")) }); }
        if (op === "/resize" && m === "POST") { const b = await readBody(req); return send(res, 200, { ok: resizeTerminal(tid, b.cols | 0, b.rows | 0) }); }
        if (op === "" && m === "DELETE") return send(res, 200, { ok: killTerminal(tid) });
      }

      // ── Streamed browsers (browser tab + agent browser viewers) ──
      // The same transport pattern as the terminal: frames via SSE, input via POST —
      // so it works unchanged through the gateway (client/server operation).
      if (p === "/api/browsers" && m === "GET") {
        const wsFilter = url.searchParams.get("workspaceId");
        const list = listBrowsers().filter((b) => !wsFilter || b.workspaceId === wsFilter);
        return send(res, 200, { browsers: list, available: !!resolveChromium() });
      }
      // Real Chrome DevTools: pass through frontend + resources from the Chromium debug port
      // (the matching WebSocket connection runs via attachBrowserDevtools on upgrade).
      const dtm = p.match(/^\/api\/browsers\/([0-9a-f-]+)\/devtools(\/.*)$/);
      if (dtm) return proxyDevtools(dtm[1], req, res, `/devtools${dtm[2]}${url.search || ""}`);
      // The live measurement of the browser stream (../browser-measurement.js): one summary per ≈ 10 s, appended with a cap.
      if (p === "/api/browsers/measurement" && m === "POST") {
        const b = await readBody(req);
        appendMeasurement(path.join(DIRS.data, "browser-measurement.jsonl"), b);
        return send(res, 200, { ok: true });
      }
      const bm = p.match(/^\/api\/browsers\/([0-9a-f-]+)(\/stream|\/input|\/act)?$/);
      if (bm) {
        const bid = bm[1], op = bm[2] || "";
        if (op === "/stream" && m === "GET") {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          await browserAttachViewer(bid, url.searchParams.get("tab") || "", res, { measure: url.searchParams.get("measure") === "1" });
          return;
        }
        if (op === "/input" && m === "POST") { const b = await readBody(req); return send(res, 200, await browserInput(bid, b.tab || "", b.events || [])); }
        if (op === "/act" && m === "POST") { const b = await readBody(req); return send(res, 200, await browserAct(bid, b)); }
        if (op === "" && m === "DELETE") return send(res, 200, { ok: closeBrowser(bid) });
      }

      // ── Language service for AGENTS ───────────────────────────────────────────────────────────────────────────────
      // An agent knows file, line and column (1-based), no buffer: the backend reads the file from disk and asks the
      // language server of the instance of its project (lsp/agents.js — the same computation as the editor). Reading
      // (AGENT_READ, MCP `cbase_lsp`) and writing (AGENT_CHANGE, MCP `cbase_lsp_edit`): writing to disk, all or nothing,
      // response `{ changed }`. Also with the token of a COPY: the same actions IN the copy — read and written through
      // its container (lsp/limit.js), never through the backend's disk (main lies there; not even "file not found" may
      // come from there). The token determines the instance, never the chat.
      if (p === "/api/lsp" && m === "POST") {
        const b = await readBody(req);
        const action = String(b.action || "diagnostics");
        if (!AGENT_READ.includes(action) && !AGENT_CHANGE.includes(action)) {
          return send(res, 400, { code: "UNKNOWN_ACTION", error: T`Unknown action "${action}" — reading: ${AGENT_READ.join(", ")}; writing: ${AGENT_CHANGE.join(", ")}` });
        }
        const file = path.resolve(String(b.file || ""));
        let target;
        if (ctx.fence && instanceIsCopy(ctx.fence.instance)) {
          target = lspCopyTarget(ctx, file);
          if (target?.error) return send(res, target.status, { error: target.error });
          if (!languageOf(file)) return send(res, 400, { error: noLanguageServer() });
        } else {
          if (!fs.existsSync(file)) return send(res, 404, { error: T("File not found") });
          if (!languageOf(file)) return send(res, 400, { error: noLanguageServer() });
          // A file of a CONVERTED project (lspTarget below — from its project container via ctx.fence, from the backend via
          // its location): read through the descriptor in the area of the instance (O_NONBLOCK, only a regular file: a FIFO
          // with `readFileSync` would stop the WHOLE backend), and `area` limits every write (lsp/limit.js: only if
          // EVERY location lies inside, otherwise nothing).
          const lz = lspTarget(ctx, file);
          if (lz?.error) return send(res, lz.status, { error: lz.error });
          target = lspAgentTarget(ctx, file, lz);
          if (target?.error) return send(res, target.status, { error: target.error });
        }
        if (target.reason) return send(res, 200, { supported: false, reason: target.reason, error: T("The file is not in any project — the language service runs per project.") });
        let r;
        try { r = await agentAction(action, target, b); }
        catch (e) {
          const a = responseFromError(e);
          // A location outside the instance is a no from the fence — nothing written.
          if (a.body?.code === "OUTSIDE") return send(res, 403, { ...a.body, error: `Fence (language-service): ${a.body.error}` });
          return send(res, a.status, a.body);
        }
        if (r?.locked) return send(res, 409, r.locked.code === "COPY_NOT_READY" ? copyNotReady(r.locked) : setupRunningResponse(r.locked));
        return send(res, 200, r);
      }

      // ── Debugger (Node V8 inspector, global per debugId) ──
      if (p === "/api/debug/available" && m === "GET") return send(res, 200, { available: debugAvailable() });
      const dm = p.match(/^\/api\/debug\/([0-9a-f-]+)(\/stream|\/command|\/breakpoints|\/evaluate)?$/);
      if (dm) {
        const did = dm[1], op = dm[2] || "";
        if (op === "/stream" && m === "GET") {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          if (!debugSubscribe(did, res)) { res.write("event: terminated\ndata: {}\n\n"); res.end(); }
          return;
        }
        if (op === "/command" && m === "POST") { const b = await readBody(req); return send(res, 200, debugCommand(did, String(b.cmd || ""))); }
        if (op === "/breakpoints" && m === "POST") { const b = await readBody(req); return send(res, 200, await debugSetBreakpoints(did, String(b.file || ""), b.lines || [])); }
        if (op === "/evaluate" && m === "POST") { const b = await readBody(req); try { return send(res, 200, await debugEvaluate(did, b.expr)); } catch (e) { return send(res, 200, { error: String(e.message || e) }); } }
        if (op === "" && m === "DELETE") return send(res, 200, debugStop(did));
      }

      // Native folder picker dialog (only available in the Electron app).
      if (p === "/api/pick-folder" && m === "POST") {
        if (!pickDirectoryFn) return send(res, 200, { canceled: true, unavailable: true });
        const b = await readBodyOrEmpty(req);
        const dir = await pickDirectoryFn(b.title || T("Choose folder"));
        return send(res, 200, dir ? { path: dir } : { canceled: true });
      }
  return NEXT;
}
// The instance a project route works in.
//   - From a project network (`ctx.fence`, set by the fence) the TOKEN decides, never the chat: the target instance is the
//     token's (`ctx.fence.instance`), and a `?chat=<id>` must lie in THIS instance (`ctx.fence.chatReason`, the fence's
//     check) — a copy token with a chat of main (and vice versa) is 403, never a write path into the other instance. If
//     the fence value lacks something (instance, check), that is 403 as well: closed, never main.
//   - Otherwise (UI, client, iOS — session instead of token) the chat's binding applies: `?chat=<id>` or the tag
//     `chat:<id>` of the chat rail at the terminal → the chat's copy if it carries one in the project (runs/instance.js
//     instanceOfChat: the copy of another project rests), else main. A copy that cannot be resolved throws (409). Without
//     a chat: main.
export function targetInstance(ctx, chatId) {
  const denial = (text) => Object.assign(new Error(text), { status: 403 });
  if (ctx.fence) {
    if (ctx.fence.projectId !== ctx.proj.id) throw denial("Fence: the token belongs to another project");
    if (!ctx.fence.instance) throw denial("Fence: the token carries no instance");
    if (chatId) {
      const reason = typeof ctx.fence.chatReason === "function" ? ctx.fence.chatReason(String(chatId)) : "the chat's instance cannot be determined";
      if (reason) throw denial(`Fence: ?chat — ${reason}`);
    }
    return ctx.fence.instance;
  }
  return chatId ? instanceOfChat(String(chatId), { projectId: ctx.proj.id }) : instanceForProject(ctx.proj.id);
}
// The reason why a new terminal of the project may not open right now — or null. The lock of the whole project or of the
// instance (projectbox/idle.js projectLocked), plus the relocation as in projects/routes.js.
// Plus a COPY whose instance row is not `ready` (writeLockCopy) — the reason is its state. Otherwise a new terminal would
// open during clearing away and live until `docker stop`: what it wrote after the backup would be nowhere. Checked for
// the instance in which the session STARTS (tag `chat:<id>` ⇒ that of its chat).
function terminalLocked(projectId, instance) {
  const s = projectLocked(projectId, instance || "main");
  if (s) return s.reason;
  if (store.openRelocation(projectId)) return "relocation";
  if (store.projectInstancesOf(projectId).some((i) => i.state === "relocation")) return "relocation";
  const copy = writeLockCopy(instance && instance !== "main" ? { projectId, instance } : null);
  if (copy) return copy.state || "missing";
  return null;
}

/**
 * Is nothing writing into this instance right now? → `{ identifier, state }` for a COPY whose instance row is not `ready`
 * (`state` null: it no longer exists), else null (main, no instance, a ready copy). The basis is the row in the database,
 * not a lock in memory: from step 0 of clearing away it is in the clear-away state, after a failure in `error` — both
 * survive a restart in the middle of clearing away. "Earmarked" stands only in the stack copies table, the row stays
 * `ready` there: earmarked stays open. The same rule as the start of a service in a copy (projects/routes.js, 409
 * COPY_NOT_READY). Read fresh, never from the request's object (it dates from the start of the route). If the row cannot
 * be read, that is a lock (closed).
 */
export function writeLockCopy(inst) {
  if (!instanceIsCopy(inst)) return null;
  const projectId = String(inst.projectId ?? "");
  const identifier = `${projectId}/${inst.instance}`;
  let state;
  try { state = store.projectInstance(projectId, String(inst.instance))?.state ?? null; } catch { return { identifier, state: "unreadable" }; }
  return state === "ready" ? null : { identifier, state };
}

// The INSTANCE CHOICE of the Code tab — `?instance=<projectId>/<instance>` (the identifier as `/api/projects` names it).
// The Code tab belongs to no chat; without this parameter it would never get into a copy. If it is missing or empty:
// `undefined` — no choice, everything as before. Otherwise:
//   - no identifier or that of ANOTHER project ⇒ 400 `INSTANCE_INVALID` (like the services, projects/routes.js);
//   - `<id>/main` ⇒ the instance of main (without relocation `null`);
//   - a copy ⇒ its instance; if it does not exist (cleared away, never created, without the ops marker) ⇒ 404
//     `UNKNOWN_INSTANCE` — never a fallback to main: the tab falls back VISIBLY (web/src/lib/code-instance.ts, iOS);
//   - from a project network (`ctx.fence`) the token decides: another identifier than the token's ⇒ 403.
// Together with `?chat=` both must name the same instance, else 400 — two answers to "where?" are none.
export function selectedInstance(ctx, raw) {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const error = (status, text, code) => Object.assign(new Error(text), { status, code, instanceChoice: true });
  const identifier = String(raw);
  const projectId = projectFromIdentifier(identifier);
  const name = instanceNameFromIdentifier(identifier);
  if (!projectId || !identifier.endsWith(`/${name}`)) throw error(400, T`not an instance identifier “<project>/<instance>”: ${identifier}`, "INSTANCE_INVALID");
  if (projectId !== String(ctx.proj.id)) throw error(400, T`instance ${identifier} does not belong to project ${ctx.proj.id}`, "INSTANCE_INVALID");
  if (ctx.fence) {
    const own = instanceIdentifierOf(ctx.fence.instance);
    if (identifier !== own) throw error(403, `Fence: ?instance=${identifier} is not the token's instance`, "INSTANCE_FOREIGN");
    return ctx.fence.instance;
  }
  if (name === "main") return instanceForProject(projectId);
  const inst = instanceForProject(projectId, name);
  if (!inst) throw error(404, projectboxOps() ? `unknown instance: ${identifier}` : ONLY_IN_OPS, "UNKNOWN_INSTANCE");
  return inst;
}
/** The instance of a chat (tag `chat:<id>` at the terminal) against the explicit choice — without a choice unchanged,
 *  otherwise only if both name the same instance (400 like withSelectedInstance). */
function withChoice(fromChat, choice, chatId) {
  if (choice === undefined || instanceIdentifierOf(fromChat) === instanceIdentifierOf(choice)) return fromChat;
  throw Object.assign(new Error(T`?instance=${instanceIdentifierOf(choice) || "main"} and chat ${chatId} name different instances`), { status: 400, code: "INSTANCE_INVALID", instanceChoice: true });
}
/** The target instance after the instance choice: without `?instance=` unchanged `target`; with it the chosen one — with
 *  `?chat=` only if both name the same instance (else 400). */
export function withSelectedInstance(ctx, url, target) {
  const choice = selectedInstance(ctx, url.searchParams.get("instance"));
  if (choice === undefined) return target;
  if (url.searchParams.get("chat") && instanceIdentifierOf(choice) !== instanceIdentifierOf(target)) {
    throw Object.assign(new Error(T`?instance=${url.searchParams.get("instance")} and ?chat=${url.searchParams.get("chat")} name different instances`), { status: 400, code: "INSTANCE_INVALID", instanceChoice: true });
  }
  return choice;
}
/** The write lock of a project while a server step of the setup runs or the layout writes → `{ projectId, name, code? }`
 *  or null. ONE rule for the git actions of the code view (codeRoute `opts.setupLock`) and the fetch of the Git overview
 *  (gitView/fetch.js); only asked in ops mode. */
export function setupLockOf(proj) {
  return setupRunning(proj.id) ? { projectId: proj.id, name: proj.name }
    : layoutWriteLock(proj.id) ? { projectId: proj.id, name: proj.name, code: "LAYOUT_RUNNING" } : null;
}
export async function codeProjectRoutes(ctx) {
  const { req, res, url, p, m, pid, sub, proj } = ctx;

        // Browser tab (project level): its own profile per project (separate logins/sessions).
        // Stays here and does NOT move into codeRoute: that only knows a folder, the profile depends on
        // the project (scopeKey, profileDir per proj.id).
        if (sub === "/browser/ensure" && m === "POST") {
          try {
            // With ?chat in the chat's copy — with its OWN scopeKey and profile (`proj:<id>@copy-<name>`): otherwise a
            // copy chat would get the browser of main, or a second Chromium would start on the same profile
            // (launchUserBrowser deletes SingletonLock). Main stays `proj:<id>`/`proj-<id>`.
            // Scope, profile and instance from THE SAME computation as the turn whose agent drives this browser
            // (devtools/user-browser.js userBrowserTarget) — so view and agent never see two different browsers.
            const inst = targetInstance(ctx, url.searchParams.get("chat"));
            const b = await ensureUserBrowser(userBrowserTarget({ project: proj, instance: inst }));
            return send(res, 200, b);
          } catch (e) { return send(res, e?.status === 403 ? 403 : 200, { error: String(e.message || e) }); }
        }

        // What codeRoute does not answer moves on BEFORE the target instance is computed (it reads the instance rows and
        // can throw — a later family like `/context/…` would otherwise answer 409). The prefixes are stated ONCE in code-route.js.
        if (!liesUnderCodeRoute(sub)) return NEXT;

        // The target instance of file, git, terminal and debug routes — with a token the token's, else the chat's
        // (`?chat=`), else main (see targetInstance). A rejection or a locked copy answers here before any route does
        // anything in any instance (never continue working in main).
        // A locked COPY names its name (`instance: "copy-<name>"`): the chat rail of a copy chat then says "copy k1" with
        // the reason instead of claiming "no git repository".
        // Plus the instance choice of the Code tab (`?instance=`, see selectedInstance) — without it `target` stays the
        // answer from above. Its errors carry `code` (UNKNOWN_INSTANCE, INSTANCE_INVALID, INSTANCE_FOREIGN) and the chosen
        // identifier as `identifier`: by that the tab visibly falls back to main instead of showing an error as an empty tree.
        let target;
        const deny = (e) => {
          const text = String(e?.message || e);
          const copy = e?.code === "COPY_LOCKED" && e.identifier ? { instance: instanceNameFromIdentifier(e.identifier) } : null;
          const choice = e?.instanceChoice ? { code: e.code, identifier: String(url.searchParams.get("instance") || "") } : null;
          return send(res, Number(e?.status) || 409, { error: text, ...copy, ...choice });
        };
        try { target = targetInstance(ctx, url.searchParams.get("chat")); }
        catch (e) { return deny(e); }
        try { target = withSelectedInstance(ctx, url, target); }
        catch (e) { return deny(e); }
        // The explicit choice (`?instance=`, not empty) — a terminal with the tag of a chat must lie in THE SAME instance
        // (like `?chat=` in withSelectedInstance), else 400: the tag would silently override the choice.
        const choice = url.searchParams.get("instance") ? target : undefined;

        // Code editor / git / terminal / debug / language service on the project level — root = project folder.
        // There is ONE implementation of these branches for both levels (guard: server/backend/test/code-scopes.test.js
        // compares the responses across both); the one real difference — the wording for a missing root — is a parameter.
        // codeRoute returns true|false; here that becomes the contract of the route function (`return` means
        // answered, `NEXT` means not responsible).
        if (await codeRoute(proj.path, sub, m, req, res, url, {
          notFound: T("Project path not found"),
          workspaceId: proj.workspaceId, // the git accesses of the workspace of THIS project, not of the first matching path
          projectId: proj.id, // the small view of the Git overview in GET /git knows its project (code-route.js)
          // Terminal and debugger of a converted project in the project container; else null.
          instance: target,
          instanceForChat: (chatId) => withChoice(targetInstance(ctx, chatId), choice, chatId), // the terminal of the chat rail (tag chat:<id>)
          // No NEW project terminal (and no new debugger) under a lock — locking a project ends its terminals, one opened
          // afterwards would run in the middle of relocation or recreation. Plus an open relocation journal and an
          // instance in the relocation state. Checked in the branches `/terminal` and `/debug/launch` of codeRoute for the
          // instance in which the session STARTS — for a terminal with the tag `chat:<id>` that of the chat. Workspace
          // terminals (ws:) run in the backend and stay exempt.
          sessionLock: (inst) => terminalLocked(proj.id, inst?.instance),
          // The tag of the session — `proj:<id>` in main, `proj:<id>@copy-<name>` in a copy (projectbox/idle.js).
          sessionTag: (inst) => projectTerminalTag(proj.id, inst?.instance),
          // The writing file and git routes of a COPY whose instance row is not `ready` answer 409 COPY_NOT_READY
          // (code-route.js) — the rule is here, code-route.js stays domain-free.
          writeLock: writeLockCopy,
          // Only in ops mode: the upload stamp at the start of every /upload request (with `?operation=` that of the
          // operation, without it "unresolved" until the body is read — the operation can be stated there), the chunks of
          // an operation only into its staging (an operation ONLY in the body is checked and stamped only here,
          // `fromBody`), and 409 SETUP_RUNNING for every write path while a server step of the setup of THIS project
          // runs — regardless of the path (everything lies in the project).
          ...(projectboxOps() ? {
            uploadBegins: (operation) => (operation ? chunkBegins(operation, proj.id) : uploadBegins(proj.id, "", { unresolved: true })),
            chunks: (operation, body, { fromBody = false, begin } = {}) => {
              const end = fromBody ? chunkBegins(operation, proj.id, { begin }) : null;
              try { return writeChunks(operation, proj.path, body); } finally { if (end) end(); }
            },
            // The same lock while the layout writes — 409 LAYOUT_RUNNING.
            setupLock: () => setupLockOf(proj),
          } : {}),
        })) return;
  return NEXT;
}
// The projects of the VS Code pill: per CONVERTED project the instances in the state `ready`, in creation order. The
// container name comes from the identifier (creation.js containerName — main `cbase-p-<pid>`, copy
// `cbase-k-<pid>-<name>`), never from the DNS name (the name in /etc/hosts) and never from the container id. A row without
// a project, an invalid instance and a project without a ready instance drop out — a link to a container that is not
// running or does not belong to this project would be a window into nothing. The path is the project's: main mounts it
// at the same path, a copy puts its overlays there.
// Plus a main instance that restore or recreation is currently bringing up, AS SOON AS the container exists: from the
// stage phase on (then services, names) it runs and its inner dockerd answers — for a VS Code window the container is
// enough, the inner stack may still be coming up (otherwise a stack waiting for a service that never gets healthy would
// hide the project although the container has long been running).
const CONTAINER_STANDS_PHASE = /^(stage \d+\/\d+|services|names)$/;
const vscodeSuitable = (inst) => inst.state === "ready"
  || (inst.instance === "main" && ["start", "recreate"].includes(inst.state) && CONTAINER_STANDS_PHASE.test(String(inst.phase || "")));
function vscodeProjects() {
  const perProject = new Map();
  for (const inst of store.projectInstances()) {
    if (!vscodeSuitable(inst)) continue;
    let name;
    try { name = copyNameOf(inst.instance); } catch { continue; }
    if (!perProject.has(inst.projectId)) perProject.set(inst.projectId, []);
    perProject.get(inst.projectId).push({
      identifier: inst.identifier, kind: name === null ? "main" : "copy", name, container: containerName(inst.projectId, inst.instance), state: inst.state,
    });
  }
  const out = [];
  for (const [pid, instances] of perProject) {
    if (!store.converted(pid)) continue;
    const proj = store.getProject(pid);
    if (!proj) continue;
    out.push({ id: proj.id, name: proj.name, path: proj.path, workspaceId: proj.workspaceId ?? null, instances });
  }
  return out;
}
// The projects whose main container is currently coming up. A field of its OWN next to `projects`: there stands what gets
// a link (ready, or the container already exists — vscodeSuitable); here what is still before that (container is being
// created or started) — without a container and without a link. A project that is already in `projects` (a ready copy)
// is not listed here.
const STARTING = new Set(["create", "start", "recreate"]);
function vscodeStarting(listed) {
  const already = new Set(listed.map((p) => p.id));
  const out = [];
  for (const inst of store.projectInstances()) {
    if (inst.instance !== "main" || !STARTING.has(inst.state) || vscodeSuitable(inst) || already.has(inst.projectId)) continue;
    if (!store.converted(inst.projectId)) continue;
    const proj = store.getProject(inst.projectId);
    if (!proj) continue;
    out.push({ id: proj.id, name: proj.name, workspaceId: proj.workspaceId ?? null, state: inst.state });
  }
  return out;
}
export async function vscodeTunnelRoutes(ctx) {
  const { req, res, url, p, m } = ctx;
      // ── VS Code Remote Tunnels: `code tunnel` in the container ─────────────
      // The state comes from the CLI's output lines (vscode-tunnel.js); the workspaces with their
      // path because the pill builds the links from it (vscode.dev/tunnel/<name><path> and
      // vscode://vscode-remote/tunnel+<name><path>).
      // ONE response shape for all four routes — if only the GET carried the workspaces, the pill
      // would break the page on the first click on Start.
      // ONLY in project box operation additionally `projects` — per converted project main and copies in `ready`, which
      // the pill opens as a Dev Containers window ("attach" behind the tunnel). Without the ops marker the field is
      // missing entirely.
      const tunnelResponse = async () => ({
        ...(await tunnelStatus(store)),
        workspaces: store.listWorkspaces().map((w) => ({ id: w.id, name: w.name, path: w.path })),
        ...(projectboxOps() ? (() => { const projects = vscodeProjects(); return { projects, starting: vscodeStarting(projects) }; })() : {}),
      });
      if (p === "/api/vscode-tunnel" && m === "GET") return send(res, 200, await tunnelResponse());
      if (p === "/api/vscode-tunnel/start" && m === "POST") {
        const b = await readBody(req);
        try { await startTunnel(store, { name: b.name, provider: b.provider, acceptLicense: b.acceptLicense === true }); }
        catch (e) { return send(res, Number(e?.status) || 500, { error: e?.message || String(e), ...(e?.code ? { code: e.code } : {}) }); }
        return send(res, 200, await tunnelResponse());
      }
      if (p === "/api/vscode-tunnel/stop" && m === "POST") { stopTunnel(store); return send(res, 200, await tunnelResponse()); }
      if (p === "/api/vscode-tunnel/logout" && m === "POST") { await unregisterTunnel(store); return send(res, 200, await tunnelResponse()); }
  return NEXT;
}

// The language service from a project container: project folder and file after realpath; the file lies below it. The
// fence's body check already saw that — here once more because between it and the reading the body was read, and from
// here on the route works with the real path, not with the path of the body.
function lspInProject(fence, file) {
  let limit, real;
  try { limit = fs.realpathSync(String(fence.projectPath || "")); real = fs.realpathSync(file); } catch {
    return { error: "Fence (language-service): project folder or file not readable" };
  }
  const rel = path.relative(limit, real);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return { error: "Fence (language-service): only files under the project folder (after realpath)" };
  return { limit, real };
}

// The area in which the language service reads and writes a file of a CONVERTED project — `{ real, area }`,
// `{ status, error }` or `null` (not a converted project).
//   - With a fence token (from the project container): the token's instance; after realpath the file lies under its
//     project folder (lspInProject). The route has rejected a copy before.
//   - Without a token (the backend itself: the cbase MCP of a chat without a project or of a run in the backend): if the
//     file literally lies in the runtime folder of a project, that project's instance; else the same assignment as the
//     file routes of the workspace level (code-route.js fileLimit, from "/" downwards — the first path part whose real
//     location lies in the area of an instance is the project's folder). In the runtime folder of a project WITHOUT an
//     instance the search does not continue (the assignment would otherwise read `.git` files a container once wrote).
//     An unreadable instance source is 409 — never unchecked in the backend.
// The area is that of the instance (runs/runtime-limit.js areaOfTheInstance: project folder and runtime folder).
function lspTarget(ctx, file) {
  if (ctx.fence) {
    const z = lspInProject(ctx.fence, file);
    if (z.error) return { status: 403, error: z.error };
    try { return { real: z.real, area: areaOfTheInstance(ctx.fence.instance) }; } catch (e) {
      return { status: 409, error: `Language service: the area of the instance cannot be determined (${e?.message || e})` };
    }
  }
  let area;
  try {
    const inst = instanceOfTheRuntimeFolder(file);
    if (inst) area = areaOfTheInstance(inst);
    else if (runtimeFolderOf(file)) return null;
    else area = fileLimit("/", { gitInstanceSource: gitInstanceForWorkspace })?.(file) || null;
  } catch (e) {
    return { status: 409, error: `Language service: the instance of the file cannot be determined (${e?.message || e})` };
  }
  if (!area) return null;
  let real = null;
  try { real = realPath(file); } catch { real = null; }
  if (!inArea(real, area)) return { status: 403, error: "Language service: the file leads out of the area of its project (after realpath)" };
  return { real, area };
}

// The target of a file of the agents' language service (see the header of lsp/limit.js): the project under whose folder
// the file lies (the longest path, literally or after realpath), with the fence token the token's instance, in the
// runtime folder of a project that project's instance; else `{ reason: "no_project" }`. `lz` is lspTarget (the area of a
// converted project or null). The setup lock applies as in the editor: a rename does not write into a project whose
// setup is running.
function lspAgentTarget(ctx, file, lz) {
  let inst = ctx.fence ? ctx.fence.instance : null;
  let proj = inst ? store.getProject(inst.projectId) : null;
  if (!proj) {
    try { inst = inst || instanceOfTheRuntimeFolder(file) || null; } catch { inst = null; }
    if (inst) proj = store.getProject(inst.projectId);
  }
  if (!proj) {
    const real = lz?.real || (() => { try { return fs.realpathSync(file); } catch { return file; } })();
    const under = (root, p) => Boolean(root) && (p === root || p.startsWith(`${root}${path.sep}`));
    const realOf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
    proj = store.listAllProjects().filter((p) => p?.path && (under(path.resolve(p.path), file) || under(realOf(p.path), real)))
      .sort((a, c) => c.path.length - a.path.length)[0] || null;
    if (!proj) return { reason: "no_project" };
    inst = instanceForProject(proj.id);
  }
  let area = lz?.area || null;
  if (!area && inst && !instanceIsCopy(inst)) {
    try { area = areaOfTheInstance(inst); } catch (e) { return { status: 409, error: `Language service: the area of the instance cannot be determined (${e?.message || e})` }; }
  }
  return {
    projectId: String(proj.id), instance: inst || null, root: path.resolve(proj.path), base: null, abs: file,
    ...(area ? { area } : {}),
    ...(projectboxOps() ? { beforeWrite: () => setupLockOf(proj) } : {}),
  };
}

const noLanguageServer = () => T("No language server for this file type (TypeScript/JavaScript, Python, YAML, JSON)");

// The target of a file of the agents' language service with the token of a COPY: the project and the instance of the
// token; the file LITERALLY lies under the project folder (like the fence — a realpath in the backend would see main, a
// file only of the copy would not exist there). No `area`: reading and writing go through the copy's container.
// Before writing (`beforeWrite`): a copy that is not ready (writeLockCopy, read fresh), else the setup lock of the
// project as in main.
function lspCopyTarget(ctx, file) {
  const inst = ctx.fence.instance;
  const proj = store.getProject(inst.projectId);
  if (!proj?.path) return { status: 403, error: "Fence (language-service): the project of this instance no longer exists" };
  const root = path.resolve(proj.path);
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return { status: 403, error: "Fence (language-service): only files under the project folder" };
  return {
    projectId: String(proj.id), instance: inst, root, base: null, abs: file,
    beforeWrite: () => {
      const k = writeLockCopy(inst);
      if (k) return { code: "COPY_NOT_READY", ...k };
      return projectboxOps() ? setupLockOf(proj) : null;
    },
  };
}
