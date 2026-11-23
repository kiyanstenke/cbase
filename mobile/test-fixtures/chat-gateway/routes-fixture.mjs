// Fixture routes: /fixture/state, seed switches, /api/workspaces, second workspace, code tab (files), one-shot switches, ask, artifacts getter, /fixture/reset-run, download getter.
import { S, json, body, framePng, dynWorkflowsDefault, dynLibrarySeed, channelSeed, channelId, APPROVAL_REQUEST_ID, APPROVAL_INPUT, workspace, workspace2, workspaceId2, workspaceId, projectId, fileTree, fileByPath, fixturePng, chatId, chatEvent, clearRun, defaultPagesSkills, extraChats, NOTIFY_KINDS, resetSettings, archiveEmpty, globalEvent, globalStreams, chatStreams, servicesProject2, NEXT } from "./state.mjs";
import { dynTreeSeed, mainHistory } from "./seeds.mjs";
import { resetAccountDelete, resetChatAutoArchive } from "./routes-settings.mjs";
import { resetAttachmentUploads, resetAgendaTree } from "./routes-chat.mjs";
import { resetMcpAirlock } from "./routes-workspace.mjs";
import { resetScheduled } from "./routes-scheduled.mjs";
import { resetGitView, resetGitSheet } from "./routes-git.mjs";

export async function routesFixture(ctx) {
  const { req, res, url, path, method } = ctx;
    if (path === "/fixture/state" && method === "GET") {
      return json(res, 200, { chatCreateCount: S.chatCreateCount, lastChatPatch: S.lastChatPatch, lastChatCreate: S.lastChatCreate });
    }
    if (path === "/fixture/channel" && method === "POST") {
      const request = await body(req);
      S.channelSeed = request.off !== true;
      S.channel = S.channelSeed ? channelSeed() : null;
      // Custom text for the NEWEST message (`text`). Needed where the card's content itself is
      // under test — the channel card renders Markdown in a font it chose explicitly, which is a
      // different render path than an ordinary reply. The LAST message is set because it sits
      // at the very bottom of the reversed history and is therefore in view without scrolling.
      if (S.channel && typeof request.text === "string" && request.text) {
        S.channel.messages[S.channel.messages.length - 1].text = request.text;
      }
      return json(res, 200, { channelId: S.channelSeed ? channelId : null });
    }
    if (path === "/fixture/approval" && method === "POST") {
      const request = await body(req);
      S.approvalSeed = request.off !== true;
      S.approvalDecision = null;
      return json(res, 200, { requestId: S.approvalSeed ? APPROVAL_REQUEST_ID : null, chatId });
    }
    // What was decided on the seeded approval card (`null` = nothing yet).
    if (path === "/fixture/approval" && method === "GET") {
      return json(res, 200, { seed: S.approvalSeed, requestId: S.approvalSeed ? APPROVAL_REQUEST_ID : null, decision: S.approvalDecision });
    }
    // Decision on an approval card — on the real server the same route as the ordinary approval;
    // the fixture only remembers what arrived.
    const fgMatch = path.match(/^\/api\/chats\/([0-9a-f-]+)\/permission-decision$/);
    if (fgMatch && method === "POST") {
      const b = await body(req);
      if (S.approvalSeed && b.requestId === APPROVAL_REQUEST_ID) {
        const allow = b.behavior === "allow";
        S.approvalDecision = {
          behavior: allow ? "allow" : "deny",
          reason: String(b.message || ""),
          updatedInput: allow ? { ...APPROVAL_INPUT, ...(b.updatedInput && typeof b.updatedInput === "object" ? b.updatedInput : {}) } : null,
        };
      }
      return json(res, 200, { ok: true });
    }
    // The remembered instructions and the last call of "Adjust". Both reset with `reset-run` (an instruction is never
    // seeded BEFORE the app starts).
    if (path === "/fixture/adjust" && method === "GET") {
      return json(res, 200, { prompts: S.adjustPrompts, last: S.adjustLast });
    }
    // Start and end marker of a dynamic workflow. `history: true` seeds the history (seeds.mjs
    // workflowMarkersHistory), `live: "start"|"end"` sends the marker of a SECOND run as a harness event
    // (nested under `marker`, like the server).
    if (path === "/fixture/workflow-markers" && method === "POST") {
      const request = (await body(req)) || {};
      if ("history" in request) S.workflowMarkers = request.history === true;
      if (request.live === "start" || request.live === "end") {
        chatEvent({
          type: "harness", subtype: "workflow_marker",
          marker: { phase: request.live, runId: "wf_fixture0002", taskId: "wfixture2", name: "live-run", ...(request.live === "end" ? { status: "finished" } : {}), at: Date.now() },
        });
      }
      return json(res, 200, { history: S.workflowMarkers });
    }
    // Approval cards of a dynamic workflow. `history: true` seeds two open cards (seeds.mjs
    // workflowApprovalHistory); GET returns the bodies that POST /api/chats/<id>/dyn-workflows/approval received.
    if (path === "/fixture/workflow-approval" && method === "POST") {
      const request = (await body(req)) || {};
      if ("history" in request) S.workflowApproval = request.history === true ? { decide: {}, requests: [] } : null;
      return json(res, 200, { history: Boolean(S.workflowApproval) });
    }
    // The progress tree (state.mjs `S.dynTree`, seeds.mjs `dynTreeSeed`). GET: the stop bodies, the per-agent
    // interventions and the state of the runs.
    if (path === "/fixture/dyn-tree" && method === "POST") {
      const request = (await body(req)) || {};
      S.dynTree = request.seed === "running" || request.seed === "karg" ? dynTreeSeed(request.seed) : null;
      return json(res, 200, { seed: S.dynTree ? request.seed : null });
    }
    if (path === "/fixture/dyn-tree" && method === "GET") {
      return json(res, 200, { stops: S.dynTree?.stops || [], interventions: S.dynTree?.interventions || [], runs: S.dynTree?.runs || [] });
    }
    // The fixture chat's graph-workflow starts (state.mjs `S.graphRuns`). `runs`: partial views, completed with the
    // contract's defaults (workflows/graph-start.js graphRunView) — a new one per entry without `startId`, "earmarked"
    // without `state`; they REPLACE the stock (same `startId`) or are added. `live: true` additionally sends each as
    // `graph_run` to the stream (the server's path after every change), `clear: true` clears first.
    // GET returns starts and stop bodies.
    if (path === "/fixture/graph-runs" && method === "POST") {
      const request = (await body(req)) || {};
      if (request.clear === true) S.graphRuns = { runs: [], stops: [] };
      const now = Date.now();
      for (const [n, part] of (Array.isArray(request.runs) ? request.runs : []).entries()) {
        const run = {
          startId: `gs-${now}-${n}`, background: false, worktree: false, worktreePath: "",
          workflowId: "", name: "Fixture-Workflow", shortName: "fixture-workflow", input: "",
          state: "earmarked", reason: "", chatId, run: null, wait: null, stoppedOf: "",
          startedAt: now + n, updatedAt: now + n, endedAt: null, ...part,
        };
        const i = S.graphRuns.runs.findIndex((l) => l.startId === run.startId);
        if (i >= 0) S.graphRuns.runs[i] = run; else S.graphRuns.runs.push(run);
        if (request.live === true) chatEvent({ type: "harness", subtype: "graph_run", run });
      }
      return json(res, 200, { runs: S.graphRuns.runs });
    }
    if (path === "/fixture/graph-runs" && method === "GET") {
      return json(res, 200, S.graphRuns);
    }
    // The coding category's library (state.mjs `S.dynWorkflows`). `seed` adds the three extra entries,
    // `error` makes the lists answer 500. GET: list with script, takeovers, calls.
    if (path === "/fixture/dyn-library" && method === "POST") {
      const request = (await body(req)) || {};
      S.dynWorkflows = request.seed === true ? dynLibrarySeed() : dynWorkflowsDefault();
      S.dynTakenOver = new Set();
      S.dynLibraryError = request.error === true;
      S.dynLibraryCalls = [];
      return json(res, 200, { count: S.dynWorkflows.length });
    }
    if (path === "/fixture/dyn-library" && method === "GET") {
      return json(res, 200, { workflows: S.dynWorkflows, takenOver: [...S.dynTakenOver], calls: S.dynLibraryCalls });
    }
    if (path === "/fixture/workflow-approval" && method === "GET") {
      return json(res, 200, { history: Boolean(S.workflowApproval), requests: S.workflowApproval?.requests || [], decide: S.workflowApproval?.decide || {} });
    }
    if (path === "/fixture/history" && method === "POST") {
      const request = await body(req);
      // Raw entries (e.g. a 1:1 replica of a real chat): they win over all preset
      // histories until the next POST without `entries` clears them.
      S.seededRawEntries = Array.isArray(request.entries) && request.entries.length > 0
        ? request.entries
        : null;
      S.seededHistoryCount = Math.max(0, Math.min(100, Number(request.count) || 0));
      S.seededHistoryStress = request.stress === true;
      S.seededMarkdown = request.markdown === true;
      S.seededInvisible = request.invisible === true;
      if (S.seededMarkdown) S.seededHistoryCount = Math.max(1, S.seededHistoryCount);
      if (S.seededInvisible) S.seededHistoryCount = Math.max(1, S.seededHistoryCount);
      S.seededHistoryDelayMs = Math.max(0, Math.min(5_000, Number(request.delayMs) || 0));
      S.chat.title = S.seededMarkdown
        ? "Markdown probe"
        : S.seededHistoryStress ? "Infrastructure issues status" : "Queue-Test";
      return json(res, 200, {
        count: S.seededHistoryCount,
        stress: S.seededHistoryStress,
        delayMs: S.seededHistoryDelayMs,
        markdown: S.seededMarkdown,
        invisible: S.seededInvisible,
      });
    }
    if (path === "/api/workspaces" && method === "GET") return json(res, 200, S.secondWorkspace ? [workspace, workspace2] : [workspace]);
    // The header's services: running services, resources, machine and an agent browser (seed in
    // state.mjs at `S.services`). `calculator`: "gateway" (default) · "backend" · "none";
    // `measurement`: "ja" (default) · "no" (no project reports containers); `resources`: "ok" (default) ·
    // "error" (`/api/project-resources` answers 500). Every POST sets ALL three — a missing field is
    // its default. `reset-run` resets everything — so the switch belongs BETWEEN `reset-run` and
    // the app start (`launchApp(preparation:)`) or into the running test.
    // GET additionally reports `query`: the recorded requests to `/api/project-resources`
    // (`{ disk, projectId, at }`, oldest first — see state.mjs); a POST does NOT clear them.
    if (path === "/fixture/services" && method === "POST") {
      const request = (await body(req)) || {};
      S.services = request.on === true;
      S.servicesMachine = ["gateway", "backend", "none"].includes(request.calculator) ? request.calculator : "gateway";
      S.servicesMeasurement = request.measurement === "no" ? "no" : "yes";
      S.serviceResources = request.resources === "error" ? "error" : "ok";
      return json(res, 200, { on: S.services, calculator: S.servicesMachine, measurement: S.servicesMeasurement, resources: S.serviceResources });
    }
    if (path === "/fixture/services" && method === "GET") {
      return json(res, 200, {
        on: S.services, calculator: S.servicesMachine, measurement: S.servicesMeasurement, resources: S.serviceResources,
        query: S.serviceResourceQueries,
      });
    }
    if (path === "/fixture/second-workspace" && method === "POST") {
      const request = (await body(req)) || {};
      S.secondWorkspace = request.on === true;
      return json(res, 200, { on: S.secondWorkspace });
    }
    // A PINNED chat from ANOTHER project (on the phone, inside a project you also see pinned chats from other projects):
    // `{ on: true }` pins "Zahlungs-Bug im Checkout" and attaches it to the second project (`servicesProject2`,
    // "Zweites Projekt" of the services seed). OFF by default — pinned, it would sit at the very top of every other test,
    // and `openFirstChat` would open it instead of the main chat. `reset-run` undoes both, so the switch belongs in
    // `launchApp(preparation:)`. Plus three empty folders: one in the fixture project, one in the second project, one
    // without a project — the folder half of the rule; `reset-run` clears `S.chatFolders` anyway.
    if (path === "/fixture/foreign-pinned" && method === "POST") {
      const request = (await body(req)) || {};
      const on = request.on === true;
      const entry = extraChats.find((c) => c.id === "20000000-0000-4000-8000-000000000003");
      entry.pinned = on;
      entry.projectId = on ? servicesProject2 : null;
      const folder = [
        ["70000000-0000-4000-8000-0000000000f1", projectId, "Projekt-Ordner"],
        ["70000000-0000-4000-8000-0000000000f2", servicesProject2, "Fremder Ordner"],
        ["70000000-0000-4000-8000-0000000000f3", null, "Workspace-Ordner"],
      ];
      S.chatFolders = S.chatFolders.filter((f) => !folder.some(([id]) => id === f.id));
      if (on) for (const [id, pid, name] of folder) {
        S.chatFolders.push({ id, workspaceId, projectId: pid, kind: "normal", name, chatCount: 0, createdAt: Date.now(), updatedAt: Date.now() });
      }
      return json(res, 200, { on, chatId: entry.id, projectId: entry.projectId, folder: on ? folder.map(([id]) => id) : [] });
    }
    // The second workspace carries only what entering it needs: the overview. Everything else
    // answers 404 — just like a freshly created workspace without content.
    if (S.secondWorkspace && path === `/api/workspaces/${workspaceId2}/overview` && method === "GET") {
      return json(res, 200, {
        id: workspaceId2, name: workspace2.name, path: workspace2.path, exists: true, hasClaudeMd: false,
        agents: [], projects: [], categories: [], contextCount: 0, varsCount: 0, mcpCount: 0, workflowCount: 0,
      });
    }

    // ── Code tab: file tree, read, download (file/image/folder ZIP) ──
    // Only as much as the UI needs: a text file, an image, a folder.
    if (path === `/api/workspaces/${workspaceId}/files/tree` && method === "GET") {
      const at = url.searchParams.get("path") || "";
      return json(res, 200, { path: at, entries: fileTree(at) });
    }
    if (path === `/api/workspaces/${workspaceId}/files/read` && method === "GET") {
      const at = url.searchParams.get("path") || "";
      const entry = fileByPath(at);
      if (!entry || entry.type === "dir") return json(res, 400, { error: "Not found" });
      if (entry.image) {
        return json(res, 200, { path: at, size: fixturePng.length, binary: true, image: true, mime: "image/png" });
      }
      return json(res, 200, { path: at, size: Buffer.byteLength(entry.content || ""), content: entry.content || "" });
    }
    if (path === `/api/workspaces/${workspaceId}/files/download` && method === "GET") {
      const at = url.searchParams.get("path") || "";
      const inline = url.searchParams.get("inline") === "1";
      const entry = fileByPath(at);
      if (!entry) return json(res, 400, { error: "Not found" });
      S.lastDownload = { path: at, inline, dir: entry.type === "dir" };
      const name = at.split("/").pop() || "download";
      if (entry.type === "dir") {
        // No real ZIP needed — what is checked is that the app requests and shares it as a ZIP.
        const zip = Buffer.from("PK" + "\0".repeat(18), "binary");
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-length": zip.length,
          "content-disposition": `attachment; filename="${name}.zip"; filename*=UTF-8''${encodeURIComponent(name)}.zip`,
        });
        return res.end(zip);
      }
      const payload = entry.image ? fixturePng : Buffer.from(entry.content || "", "utf8");
      res.writeHead(200, {
        "content-type": entry.image ? "image/png" : "application/octet-stream",
        "content-length": payload.length,
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      return res.end(payload);
    }
    // Upload: only record what arrived (target folder + file names) — the tree stays fixed.
    if (path === `/api/workspaces/${workspaceId}/upload` && method === "POST") {
      const request = await body(req);
      S.lastUpload = {
        dir: String(request.dir || ""),
        files: (Array.isArray(request.files) ? request.files : []).map((f) => String(f?.path || "")),
        bytes: (Array.isArray(request.files) ? request.files : [])
          .reduce((n, f) => n + Buffer.from(String(f?.dataB64 || ""), "base64").length, 0),
      };
      return json(res, 200, { written: S.lastUpload.files.length, dir: S.lastUpload.dir });
    }
    if (path === "/fixture/upload" && method === "GET") return json(res, 200, S.lastUpload || { empty: true });
    if (path === "/fixture/upload" && method === "POST") { S.lastUpload = null; return json(res, 200, { ok: true }); }
    if (path === "/fixture/subagent" && method === "POST") {
      const request = await body(req);
      S.subagentOnce = request.open === true;
      return json(res, 200, { open: S.subagentOnce });
    }
    if (path === "/fixture/background-agent" && method === "POST") {
      const request = await body(req);
      S.backgroundAgentOnce = request.open === true;
      S.backgroundAgentForeground = request.foreground === true;
      return json(res, 200, { open: S.backgroundAgentOnce, foreground: S.backgroundAgentForeground });
    }
    if (path === "/fixture/waiting-agent" && method === "POST") {
      const request = await body(req);
      S.waitingAgentOnce = request.open === true;
      S.waitingAgentKind = ["agent", "task", "wakeup"].includes(request.kind) ? request.kind : "agent";
      return json(res, 200, { open: S.waitingAgentOnce, kind: S.waitingAgentKind });
    }
    // Counter-probe switches of the waiting phase, set from OUTSIDE (curl), never by a test:
    // `empty: true` omits tasks/agents/wakeupAt (chip or dot missing), `event: "background"` sends the side work as
    // `background` instead of `run_waiting` (the turn keeps running, the run row stays), `descriptionEmpty: true` and
    // `mixed: true` send the background task with an EMPTY description or a subagent ON TOP (the "1 background task" chip
    // shows, its sheet says "No description" — the path `names("tasks")` would take with `[""]`). STICKY: `reset-run` and
    // `/fixture/waiting-agent` leave them alone — the test sets its own switch only AFTER `reset-run`
    // (`launchApp(preparation:)`), and the counter-probe must survive both. Back only through this route
    // (`{}` = all off) or a restart of the fixture. `GET` returns the state: `assertWaitingState` reads it
    // beforehand and names a standing switch instead of failing at the chip.
    if (path === "/fixture/waiting-agent-counter-probe" && method === "GET") {
      return json(res, 200, {
        empty: S.waitingAgentEmpty,
        event: S.waitingAgentEvent,
        descriptionEmpty: S.waitingAgentDescriptionEmpty,
        mixed: S.waitingAgentMixed,
      });
    }
    if (path === "/fixture/waiting-agent-counter-probe" && method === "POST") {
      const request = await body(req);
      S.waitingAgentEmpty = request.empty === true;
      S.waitingAgentEvent = request.event === "background" ? "background" : "run_waiting";
      S.waitingAgentDescriptionEmpty = request.descriptionEmpty === true;
      S.waitingAgentMixed = request.mixed === true;
      return json(res, 200, {
        empty: S.waitingAgentEmpty,
        event: S.waitingAgentEvent,
        descriptionEmpty: S.waitingAgentDescriptionEmpty,
        mixed: S.waitingAgentMixed,
      });
    }
    // Runs with a waiting phase or subagent stay open for 60 s and thus outlive the test.
    // The next test cleans up with this at app start, otherwise its message lands in the
    // queue of the PREVIOUS run and it never sees what it wants to check.
    if (path === "/fixture/group-tools" && method === "POST") {
      const request = await body(req);
      S.groupToolsOnce = request.open === true;
      S.groupToolsFast = request.fast === true;
      return json(res, 200, { open: S.groupToolsOnce, fast: S.groupToolsFast });
    }
    if (path === "/fixture/native-tasks" && method === "POST") {
      const request = await body(req);
      S.nativeTasksOnce = request.open === true;
      return json(res, 200, { open: S.nativeTasksOnce });
    }
    // Question card: switch for the next run, fetching the received selection.
    if (path === "/fixture/ask" && method === "POST") {
      const request = await body(req);
      S.askOnce = request.open === true;
      S.askQuestions = Number(request.questions) === 3 ? 3 : 1;
      S.lastAskAnswer = null;
      return json(res, 200, { open: S.askOnce, questions: S.askQuestions });
    }
    if (path === "/fixture/open-call" && method === "POST") {
      const request = await body(req);
      S.openCallOnce = request.open === true;
      S.openCallError = request.open === true && request.error === true;
      return json(res, 200, { open: S.openCallOnce, error: S.openCallError });
    }
    if (path === "/fixture/ask" && method === "GET") return json(res, 200, S.lastAskAnswer || { empty: true });
    if (path === `/api/chats/${chatId}/ask-answer` && method === "POST") {
      const request = await body(req);
      S.lastAskAnswer = { requestId: request.requestId, answers: request.answers || [] };
      chatEvent({ type: "harness", subtype: "ask_resolved", requestId: request.requestId, answers: request.answers || [] });
      const display = (request.answers || [])
        .map((a) => [(a.selected || []).join(", "), a.text].filter(Boolean).join(" — "))
        .join("\n");
      chatEvent({ type: "harness", subtype: "user_message", text: display, attachments: [] });
      return json(res, 202, { ok: true, requestId: request.requestId });
    }
    // Archive: the pre-check switches (`open`: "open" | "question" | null, `shells`), the 409 on delete (`delete409`),
    // the context files per folder (`contextFiles`), plus `archiveFolder`, `target` and `event` (sends `chat_archive`).
    // Only sent fields change; `reset-run` undoes EVERYTHING — so set between `reset-run` and the app start
    // (`launchApp(preparation:)`). GET reports the state: archived chats and folders, dismissed questions.
    if (path === "/fixture/archive" && method === "POST") {
      const request = (await body(req)) || {};
      if ("open" in request) S.archive.open = request.open === "open" || request.open === "question" ? request.open : null;
      if ("shells" in request) S.archive.shells = Math.max(0, Number(request.shells) || 0);
      if ("delete409" in request) S.archive.delete409 = request.delete409 === true;
      if (request.contextFiles && typeof request.contextFiles === "object") Object.assign(S.archive.contextFiles, request.contextFiles);
      // Seed for the folder tests: a coding folder with the named chats. Built through the app it would cost a context
      // menu per chat (unreliable long press), and `fixturePost` cannot do PATCH.
      let folderId = null;
      if (request.createFolder && typeof request.createFolder === "object") {
        S.chatFolderCounter += 1;
        folderId = `70000000-0000-4000-8000-00000000000${S.chatFolderCounter}`;
        S.chatFolders.push({
          id: folderId, workspaceId, projectId: null, kind: "normal",
          name: String(request.createFolder.name || "Folder"), chatCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
        });
        const ids = new Set(Array.isArray(request.createFolder.chatIds) ? request.createFolder.chatIds : []);
        for (const entry of [S.chat, ...extraChats]) if (ids.has(entry.id)) entry.folderId = folderId;
      }
      // Seed "already archived" (single, without folder) — the PUT is not reachable for `fixturePost`.
      if (Array.isArray(request.archive)) for (const id of request.archive) S.archive.chats.set(String(id), Date.now());
      // Seed "folder already archived": the folder WITH its active chats, like the PUT — but without an
      // event (the app start reads the state fresh anyway). Timestamps rise per chat so the order in the
      // archive (most recent first) does not depend on chance equal milliseconds.
      if (Array.isArray(request.archiveFolder)) {
        let t = Date.now();
        for (const fid of request.archiveFolder.map(String)) {
          const folder = S.chatFolders.find((f) => f.id === fid);
          if (!folder) continue;
          S.archive.folder.set(fid, t);
          for (const c of [S.chat, ...extraChats]) {
            if (c.folderId !== fid || S.archive.chats.has(c.id)) continue;
            t += 1;
            S.archive.chats.set(c.id, t);
            S.archive.withFolder.set(c.id, fid);
          }
        }
      }
      // A goal on a chat — main or extra chat; `reset-run` undoes it. With `paused` (boolean, missing = running):
      // the composer's goal row then shows "goal paused".
      if (request.target && typeof request.target === "object") {
        const target = [S.chat, ...extraChats].find((c) => c.id === String(request.target.chatId));
        if (target) {
          target.goal = String(request.target.text ?? "");
          target.goalPaused = request.target.paused === true;
        }
      }
      // The `chat_archive` event "from another client": the state changes HERE and the app learns of it ONLY
      // through the stream — no handle of its own. Like the server: first the state, then the event (the notify
      // function in runs/archive.js sends after writing); `reason: "work"` with `cause` is the retrieval by a run,
      // which an open iPhone can only reach this way.
      if (request.event && typeof request.event === "object") {
        const e = request.event;
        const ids = Array.isArray(e.chatIds) ? e.chatIds.map(String) : [];
        const on = e.archived === true;
        for (const id of ids) {
          if (on) S.archive.chats.set(id, Date.now());
          else { S.archive.chats.delete(id); S.archive.withFolder.delete(id); }
        }
        globalEvent({
          type: "chat_archive", workspaceId, kind: "normal",
          chatIds: ids, folderIds: [], archived: on, reason: e.reason === "work" ? "work" : "user",
          ...(e.cause ? { cause: String(e.cause) } : {}),
        });
      }
      return json(res, 200, { ok: true, folderId });
    }
    if (path === "/fixture/archive" && method === "GET") {
      // `streams`: how many event streams (`/api/events`) are open right now — the event test sends only once
      // the app listens; otherwise it would test the "stream not yet connected" race instead of the event path.
      return json(res, 200, {
        chats: [...S.archive.chats.keys()], folder: [...S.archive.folder.keys()],
        deleted: [...S.archive.deleted], dismissed: S.archive.dismissed, streams: globalStreams.size,
      });
    }
    if (path === "/fixture/artifacts" && method === "GET") {
      return json(res, 200, Object.fromEntries(S.artifacts));
    }
    // ── Reconciliation on open (mobile/CbaseMobile/Chat/ChatViewModel+Reconcile.swift) ──
    // `gap { text }`: a user row that is stored RIGHT AFTER the next `GET …/log` of the main chat.
    if (path === "/fixture/gap" && method === "POST") {
      const request = (await body(req)) || {};
      S.gapRow = typeof request.text === "string" && request.text ? { role: "user", text: request.text } : null;
      return json(res, 200, { on: Boolean(S.gapRow) });
    }
    // `row { text }`: a `hint` row is stored and goes to the open streams as `{ type: "row", row }` — like
    // `store.setRowsObserver` on the server. `{ retry: true }` sends the LAST stored row once more (the app
    // must skip a row below its state). Answer: the row in the shape of `GET …/log`.
    if (path === "/fixture/row" && method === "POST") {
      const request = (await body(req)) || {};
      if (request.retry !== true) {
        if (typeof request.text !== "string" || !request.text) return json(res, 400, { error: "text missing" });
        S.addenda.push({ role: "hint", text: request.text, ts: Date.now(), attachments: [] });
      }
      const rows = mainHistory();
      const row = rows[rows.length - 1];
      if (!row) return json(res, 409, { error: "no history" });
      chatEvent({ type: "row", row });
      return json(res, 200, { row });
    }
    // `run-stream { parts, gapMs }`: the next run streams piece by piece and carries `streamText` (seeds.mjs `startStreamRun`).
    // Plus: `cap` (characters of the buffer), `error` (text of the `run_error`), `followUp { text, parts }`.
    if (path === "/fixture/run-stream" && method === "POST") {
      const request = (await body(req)) || {};
      const list = (x) => (Array.isArray(x) ? x.map(String).filter(Boolean) : []);
      const parts = list(request.parts);
      const followUpParts = list(request.followUp?.parts);
      S.runStream = parts.length ? {
        parts, gapMs: Math.max(100, Math.min(5_000, Number(request.gapMs) || 1_000)),
        cap: Math.max(0, Number(request.cap) || 0),
        error: typeof request.error === "string" ? request.error : "",
        followUp: followUpParts.length ? { text: String(request.followUp.text || "Follow-up"), parts: followUpParts } : null,
      } : null;
      return json(res, 200, { on: Boolean(S.runStream) });
    }
    // The main chat's stream: `stream-silent { on }` — the open streams get nothing any more (dead, without the app noticing),
    // `{ close }` ends them cleanly (the app reconnects); `stream-abort { failedAttempts }` ends them, and the next
    // `failedAttempts` connections answer 503 (the app sees a stream error); `stream-flapping { on }` — every connection
    // ends again right away: 50 ms after `connected` or as 503, alternating.
    if (path === "/fixture/stream-silent" && method === "POST") {
      const request = (await body(req)) || {};
      if (request.on === true) for (const r of chatStreams) S.silentStreams.add(r);
      if (request.close === true) {
        for (const r of S.silentStreams) { chatStreams.delete(r); r.end(); }
        S.silentStreams.clear();
      }
      return json(res, 200, { silent: S.silentStreams.size, streams: chatStreams.size });
    }
    if (path === "/fixture/stream-abort" && method === "POST") {
      const request = (await body(req)) || {};
      S.streamFailedAttempts = Math.max(0, Math.min(5, Number(request.failedAttempts) || 0));
      const n = chatStreams.size;
      for (const r of [...chatStreams]) { chatStreams.delete(r); r.end(); }
      return json(res, 200, { ended: n, failedAttempts: S.streamFailedAttempts });
    }
    if (path === "/fixture/stream-flapping" && method === "POST") {
      const request = (await body(req)) || {};
      S.streamFlapping = request.on === true ? { times: [] } : null;
      return json(res, 200, { on: Boolean(S.streamFlapping) });
    }
    // `image { w, h, withDimensions, delayMs, text }`: a user row with an image attachment as the last message.
    // `framePng` builds the image at 1/16 of the size (the aspect ratio holds when w and h are multiples of 16).
    if (path === "/fixture/image" && method === "POST") {
      const request = (await body(req)) || {};
      const w = Math.max(256, Math.min(2_560, Number(request.w) || 640));
      const h = Math.max(256, Math.min(2_560, Number(request.h) || 960));
      const file = `bild-${Date.now()}.png`;
      S.imageAttachment = {
        file, w, h, retrieved: 0, supplied: 0,
        delayMs: Math.max(0, Math.min(10_000, Number(request.delayMs) || 0)),
      };
      const attachment = { name: "screen.png", file, mime: "image/png", size: framePng(w, h).length };
      if (request.withDimensions !== false) Object.assign(attachment, { w, h });
      S.addenda.push({
        role: "user", text: typeof request.text === "string" && request.text ? request.text : "Here is the screenshot",
        ts: Date.now(), attachments: [attachment],
      });
      return json(res, 200, { on: true, file });
    }
    if (path === "/fixture/image" && method === "GET") {
      return json(res, 200, S.imageAttachment ? { retrieved: S.imageAttachment.retrieved, supplied: S.imageAttachment.supplied } : { retrieved: 0, supplied: 0 });
    }
    if (path === "/fixture/reconcile" && method === "GET") {
      const rows = mainHistory();
      return json(res, 200, {
        addenda: S.addenda.length, lastId: rows.length ? rows[rows.length - 1].id : 0, total: rows.length,
        deltaRetrievals: S.deltaRetrievals, running: S.running, streamText: S.runStreamText, streamTextFull: S.runStreamFull,
        // Open streams of the main chat — a test sends `row` only once the app listens.
        streams: chatStreams.size, connections: S.streamConnections, failedResponses: S.streamFailedResponses,
        flapTimes: S.streamFlapping?.times ?? [],
      });
    }
    if (path === "/fixture/reset-run" && method === "POST") {
      clearRun();
      S.queue.length = 0;
      // Reconciliation on open: stored addenda, gap, stream run and counters belong to the test that set them.
      S.addenda = [];
      S.gapRow = null;
      S.runStream = null;
      S.deltaRetrievals = 0;
      S.imageAttachment = null;
      // Silent streams, connection counters, flapping and the usage switches.
      for (const r of S.silentStreams) r.end();
      S.silentStreams.clear();
      S.streamConnections = 0;
      S.streamFlapping = null;
      S.streamFailedAttempts = 0;
      S.streamFailedResponses = 0;
      S.usageDelayMs = 0;
      S.usageHistoryUnknown = false;
      // The one-shot switches reset too: otherwise the next test inherits the special run
      // of a predecessor that set it but never triggered it.
      S.groupToolsOnce = false;
      S.groupToolsFast = false;
      S.openCallOnce = false;
      S.openCallError = false;
      // The two subagent switches belong here: a test that sets them and then
      // fails skips its `defer`, and the next run would seed foreign agents.
      S.subagentOnce = false;
      S.agentStops = [];
      S.agentsBackground = [];
      S.backgroundAgentOnce = false;
      S.agentAfterRun = null;
      S.workflowMarkers = false;
      S.workflowApproval = null;
      S.dynTree = null;
      S.graphRuns = { runs: [], stops: [] };
      S.dynWorkflows = dynWorkflowsDefault();
      S.dynTakenOver = new Set();
      S.dynLibraryError = false;
      S.dynLibraryCalls = [];
      S.backgroundAgentForeground = false;
      S.waitingAgentOnce = false;
      // The second workspace and the skills seed (including hidden ones) reset as well: a test
      // that fails AFTER switching would otherwise let every following run start in a workspace
      // whose routes all answer 404 except `/overview` (`continueAfterFailure = false` skips every
      // `defer`). Whoever needs the switch sets it BETWEEN this route and the app start
      // (`launchApp(preparation:)`).
      S.secondWorkspace = false;
      // The header's services too: a test that turns them on and then fails would otherwise
      // let every following one start with three running services and a red machine —
      // the apps page would count foreign projects.
      S.services = false;
      S.servicesMachine = "gateway";
      S.servicesMeasurement = "yes";
      S.serviceResources = "ok";
      // The record of resource requests starts empty per test — otherwise the test would count
      // its predecessor's requests.
      S.serviceResourceQueries = [];
      // The project list's port conflicts: a test that sets the error switch and fails would otherwise let every
      // following one start without readable conflicts.
      S.portConflicts = false;
      S.portConflictsError = false;
      S.portConflictsRetrievals = 0;
      // The remembered "Adjust" instructions likewise.
      S.adjustPrompts = [];
      S.adjustLast = null;
      S.adjustCounter = 0;
      S.pagesSkills = defaultPagesSkills();
      S.skillsHidden = new Set();
      S.skillsCalls = [];
      S.skillsPatchError = 0;
      // Folders are state like the queue — a test must not inherit its predecessor's.
      S.chatFolders = [];
      S.chatFolderCounter = 0;
      // The archive likewise: archived and deleted chats, folders and all pre-check switches.
      S.archive = archiveEmpty();
      // Artifacts are state like the queue — a test must not inherit its predecessor's
      // changes.
      S.artifacts = new Map([["issues/01-login.md", "# Login-Fehler\n\nDie **Anmeldung** bricht ab.\n\n## Abschnitt 1\n\nRow 1 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 2\n\nRow 2 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 3\n\nRow 3 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 4\n\nRow 4 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 5\n\nRow 5 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 6\n\nRow 6 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 7\n\nRow 7 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 8\n\nRow 8 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 9\n\nRow 9 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 10\n\nRow 10 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 11\n\nRow 11 des Befundes mit genug Text, um umzubrechen.\n\n## Abschnitt 12\n\nRow 12 des Befundes mit genug Text, um umzubrechen.\n\n> Kundenmeldung vom 12.8.\n"]]);
      S.chat.folderId = null;
      for (const entry of extraChats) entry.folderId = null;
      // `/fixture/foreign-pinned` resets: both extra chats are workspace chats again, not pinned
      // — as they stand in the seed (`state.mjs`, `extraChats`).
      for (const entry of extraChats) { entry.pinned = false; entry.projectId = null; }
      // Ultracode and its level: a test that turns the mode on would otherwise pass it on together with "xhigh".
      S.chat.ultracode = false;
      S.chat.effort = "medium";
      S.lastChatPatch = null;
      S.lastChatCreate = null;
      // The goal from `/fixture/archive {target}` — a following test would otherwise see its predecessor's goal button.
      S.chat.goal = "";
      for (const entry of extraChats) delete entry.goal;
      // Likewise the goal's pause.
      S.chat.goalPaused = false;
      for (const entry of extraChats) entry.goalPaused = false;
      // Notifications are state like the queue: the global default and every per-chat deviation
      // reset — otherwise the next run checks the switches the previous one flipped.
      S.notifyGlobal = Object.fromEntries(NOTIFY_KINDS.map((a) => [a.key, a.preset]));
      S.chat.notify = {};
      for (const entry of extraChats) entry.notify = {};
      // For the same reason the settings: read aloud, web search, permanent approvals, auto-continue,
      // GitLab accounts, third-party providers, hooks. `launchApp` calls this route at the start of
      // EVERY test — so no run inherits the switched-off switch or the extra account of its
      // predecessor. `/fixture/settings` remains the explicit way for tests that do without `launchApp`.
      resetSettings();
      resetChatAutoArchive();
      resetAccountDelete();
      resetAttachmentUploads();
      resetAgendaTree();
      resetMcpAirlock();
      resetScheduled();
      // The git overview: switch, converted fixture project and the record of fetches.
      resetGitView();
      resetGitSheet();
      return json(res, 200, { reset: true });
    }
    if (path === "/fixture/download" && method === "GET") return json(res, 200, S.lastDownload || { empty: true });
    // Reset so a test does not see the previous test's download.
    if (path === "/fixture/download" && method === "POST") {
      S.lastDownload = null;
      return json(res, 200, { ok: true });
    }
    return NEXT;
}
