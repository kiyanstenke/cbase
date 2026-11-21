// Fixture routes: review-wait, limit-wait, auto-continue, workflow run, background agents, services/events, /fixture/notice, project-services/-resources, port conflicts.
import { S, body, chatEvent, json, limitWaitState, limitEvent, limitWaitFor, stepsOf, runOf, servicesSeed, serviceResources, SERVICES_HOST_BACKEND, projectId, NEXT } from "./state.mjs";

export async function routesRun(ctx) {
  const { req, res, url, path, method } = ctx;
    // ── A background agent outlives its turn ──
    // Three phases, each triggered by the test (no timer): `start` plays a whole turn that starts a background agent and
    // ends with `run_done` while the agent lives — then a `background` event reports the survivor (like runs/do-run.js).
    // `parking` reports it parked at the usage limit (until 23:59 local time), `end` its end without a turn (`background`
    // without it) and its completion message (`user_message` with a system notice).
    if (path === "/fixture/agent-after-run" && method === "POST") {
      const request = (await body(req)) || {};
      const phase = String(request.phase || "start");
      const agent = (status, extra = {}) => ({
        taskId: "fixture-after-run", agentId: "fixture-after-run", toolUseId: "fixture-after-run-call",
        description: "Nachlauf prüfen", name: "agent-after-run", provider: "claude", model: "claude-haiku-4-5-20251001",
        status, startedAt: Date.now() - 5_000, tokens: 1200, tokenKind: "full", toolUses: 1, ...extra,
      });
      const situation = (agents) => chatEvent({ type: "harness", subtype: "background", monitors: [], tasks: [], wakeupAt: 0, wakeupReason: "", wakeupPrompt: "", agents });
      if (phase === "start") {
        S.agentAfterRun = agent("running");
        chatEvent({ type: "harness", subtype: "run_started", provider: "claude", resume: false });
        chatEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "fixture-after-run-call", name: "mcp__cbase__cbase_agent", input: { description: "Nachlauf prüfen", prompt: "prüfe" } }] } });
        chatEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "fixture-after-run-call", content: JSON.stringify({ status: "running", agentId: "fixture-after-run", started: true }), is_error: false }] } });
        situation([S.agentAfterRun]);
        // Text arrives as `text_delta` like on the real wire — the app evaluates an `assistant` event only for `tool_use`.
        chatEvent({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Der Subagent läuft im Hintergrund." } } });
        chatEvent({ type: "harness", subtype: "run_done" });
        situation([S.agentAfterRun]);
      } else if (phase === "parking") {
        const until = new Date();
        until.setHours(23, 59, 0, 0);
        S.agentAfterRun = agent("parked", { parkedUntil: until.getTime(), resetsAt: until.getTime() });
        situation([S.agentAfterRun]);
      } else if (phase === "end") {
        S.agentAfterRun = null;
        // Like runs/agents.js without a turn: the report to the call block, then the situation without it, then the message.
        chatEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "fixture-after-run-call", content: JSON.stringify({ status: "completed", agentId: "fixture-after-run", description: "Nachlauf prüfen", provider: "claude", resolvedModel: "claude-haiku-4-5-20251001", report: "Befund 7", totalTokens: 1400, totalToolUseCount: 1, totalDurationMs: 9_000 }), is_error: false }] } });
        situation([]);
        chatEvent({
          type: "harness", subtype: "user_message", systemNotice: true, attachments: [],
          text: "<task-notification>\n<task-id>fixture-after-run</task-id>\n<tool-use-id>fixture-after-run-call</tool-use-id>\n<status>completed</status>\n<summary>Agent \"Nachlauf prüfen\" completed</summary>\n<result>Befund 7</result>\n</task-notification>",
        });
      } else {
        return json(res, 400, { error: `unknown phase ${phase}` });
      }
      return json(res, 200, { ok: true, phase });
    }
    // ── Human review: put the run into the waiting phase ──
    // The real server needs an agent turn for this; the state it leaves behind is enough here
    // (run `waiting` with pending "review" + the row in the history) — that is what the app shows.
    if (path === "/fixture/review-wait" && method === "POST") {
      const request = (await body(req)) || {};
      const question = String(request.question || [
        "REVIEW-REQUEST",
        "1. Created: checkout rework with discount logic.",
        "2. So testen: npm start, /kasse oeffnen, Artikel scannen.",
        "3. Achtung: Rundung ungeprueft.",
      ].join("\n"));
      const round = Number(request.round || 1);
      S.workflowRun = {
        ...(S.workflowRun || {
          id: "60000000-0000-4000-8000-000000000001", chatId: S.chat.id,
          workflowId: S.workflows[0]?.id || "wf-1", name: S.workflows[0]?.name || "Workflow",
          total: 3, approx: false, loop: null, startedAt: Date.now(),
        }),
        status: "waiting", step: 2, nodeId: "r1", nodeTitle: "Review anfragen",
        question: question, note: "", pending: "review", updatedAt: Date.now(),
      };
      // First the agent's message (the instructions), then the driver's row — the real server
      // delivers them in exactly this order.
      chatEvent({ type: "assistant", message: { content: [{ type: "text", text: question }] } });
      chatEvent({ type: "harness", subtype: "workflow_step", line: { kind: "review", step: 2, title: "Review anfragen", round: round, text: question } });
      chatEvent({ type: "harness", subtype: "workflow_run", run: S.workflowRun });
      return json(res, 200, { run: S.workflowRun });
    }
    // ── Auto-continue at the usage limit (per chat; helpers `limitWaitFor`/`limitEvent` above) ──
    if (path === "/fixture/limit-wait" && method === "POST") {
      const request = await body(req);
      S.limitWait = request && request.clear ? null : limitWaitState(request || {});
      limitEvent();
      if (S.limitWait && S.limitWait.chatId === S.chat.id) {
        // Like the real thing: the gate writes `gate` ("no new turn started"), a limit hit writes
        // `wait` ("usage limit reached") — two rows with opposite statements.
        chatEvent({ type: "harness", subtype: "limit_line", line: {
          kind: S.limitWait.gate ? "gate" : "wait", group: S.limitWait.group, limitText: S.limitWait.limitText,
          reason: S.limitWait.reason, text: S.limitWait.text, dueAt: S.limitWait.dueAt, ...(S.limitWait.gate ? { gate: true, waitFor: "run" } : {}),
        } });
      }
      return json(res, 200, { wait: S.limitWait });
    }
    const limitMatch = path.match(/^\/api\/chats\/([0-9a-f-]+)\/auto-continue(\/now)?$/);
    if (limitMatch && !limitMatch[2] && method === "GET") {
      // `enabled` is the SAME global switch as under `/api/auto-continue` — the real server calls
      // `autoContinueEnabled()` in both places. Hard-wired, the chat would say "will continue"
      // right after the settings turned waiting off.
      return json(res, 200, { wait: limitWaitFor(limitMatch[1]), enabled: S.autoContinueEnabled });
    }
    if (limitMatch && limitMatch[2] && method === "POST") {
      if (!limitWaitFor(limitMatch[1])) return json(res, 404, { error: "no run is waiting" });
      // READ the body like the real server (`b?.anyway === true`): only an explicit `true`
      // counts, anything else is a plain "try now" without the override. Remembered for
      // `/fixture/settings` so a test can check that the gate button sends it.
      const b = await body(req).catch(() => ({}));
      S.limitAttemptAnyway = b?.anyway === true;
      S.limitWait = { ...S.limitWait, attempts: S.limitWait.attempts + 1, updatedAt: Date.now() };
      if (limitMatch[1] === S.chat.id) {
        // Start kinds like on the real server: `retry` = "try now" (nothing was reset),
        // `gate-free` = "start anyway" with the override in the body (the server writes
        // "Trotzdem gestartet: … steht bei N % — …"). Only the reset itself writes `resume` —
        // there is none here. Otherwise the app would show "limit reset" above a window at 100 %.
        const line = S.limitAttemptAnyway
          ? { kind: "gate-free", group: S.limitWait.group, limitText: S.limitWait.limitText, percent: 99, gate: true,
              text: `Trotzdem gestartet: ${S.limitWait.limitText} steht bei 99 % — dieser Turn kann Guthaben kosten.` }
          : { kind: "retry", group: S.limitWait.group, limitText: S.limitWait.limitText, attempts: S.limitWait.attempts,
              text: "Retrying now." };
        chatEvent({ type: "harness", subtype: "limit_line", line });
      }
      limitEvent();
      return json(res, 200, { ok: true, wait: S.limitWait });
    }
    if (limitMatch && !limitMatch[2] && method === "DELETE") {
      const had = !!limitWaitFor(limitMatch[1]);
      if (had) S.limitWait = null;
      if (limitMatch[1] === S.chat.id) {
        chatEvent({ type: "harness", subtype: "limit_line", line: { kind: "cancel", text: "Waiting for the limit reset was cancelled." } });
      }
      limitEvent();
      return json(res, 200, { ok: had, wait: null });
    }
    if (path === `/api/chats/${S.chat.id}/workflow` && method === "GET") {
      return json(res, 200, { run: S.workflowRun });
    }
    if (path === `/api/chats/${S.chat.id}/workflow` && method === "POST") {
      const request = await body(req);
      const flow = [...S.workflows, ...S.projectWorkflows].find((w) => w.id === request.workflowId);
      if (!flow) return json(res, 404, { error: "workflow not found" });
      S.lastWorkflowStart = { workflowId: request.workflowId, input: String(request.input || "") };
      const steps = stepsOf(flow.graph);
      S.workflowRun = {
        id: "60000000-0000-4000-8000-000000000001",
        chatId: S.chat.id,
        workflowId: flow.id,
        name: flow.name,
        status: "running",
        step: 1,
        total: steps.total,
        approx: steps.approx,
        nodeId: "a",
        nodeTitle: (flow.graph.nodes.find((n) => n.type === "instruction") || {}).title || "",
        question: "",
        note: "",
        loop: null,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        // The workflow's OWN compaction values (`null` = default), like `workflowRunView`.
        compaction: { percent: runOf(flow.run).autocompact, max: runOf(flow.run).autocompactMax },
      };
      chatEvent({ type: "harness", subtype: "workflow_step", line: { kind: "start", name: flow.name, total: steps.total, approx: steps.approx } });
      chatEvent({ type: "harness", subtype: "workflow_run", run: S.workflowRun });
      return json(res, 202, { run: S.workflowRun });
    }
    if (path === `/api/chats/${S.chat.id}/workflow/skip` && method === "POST") {
      if (S.workflowRun) {
        S.workflowRun = { ...S.workflowRun, step: S.workflowRun.step + 1, nodeTitle: "Changelog schreiben" };
        chatEvent({ type: "harness", subtype: "workflow_step", line: { kind: "skip", title: "Tests laufen lassen" } });
        chatEvent({ type: "harness", subtype: "workflow_run", run: S.workflowRun });
      }
      return json(res, 200, { ok: true, run: S.workflowRun });
    }
    if (path === `/api/chats/${S.chat.id}/workflow/cancel` && method === "POST") {
      if (S.workflowRun) {
        // An ended run carries `endedAt` — the total runtime in the strip stops counting at it
        // (the real server does the same).
        S.workflowRun = { ...S.workflowRun, status: "cancelled", note: "Vom Nutzer abgebrochen.", updatedAt: Date.now(), endedAt: Date.now() };
        chatEvent({ type: "harness", subtype: "workflow_step", line: { kind: "end", status: "cancelled", note: "Vom Nutzer abgebrochen." } });
        chatEvent({ type: "harness", subtype: "workflow_run", run: S.workflowRun });
      }
      return json(res, 200, { ok: true, run: S.workflowRun });
    }
    // ── Stop per agent and "stop all background agents" ──
    // Like the server: the originator is required (400 without it or with a foreign value). Every call is recorded so the
    // test can check the BODY the button sends — only `from: "human"` leaves the hint for the next turn.
    if ((path === `/api/chats/${S.chat.id}/agents/stop` || path === `/api/chats/${S.chat.id}/agent/stop`) && method === "POST") {
      const request = (await body(req)) || {};
      if (request.from !== "human" && request.from !== "agent") return json(res, 400, { error: "from required" });
      const all = path.endsWith("/agents/stop");
      S.agentStops.push({ way: all ? "all" : "individual", ...request });
      return json(res, 200, all ? { ok: true, stopped: ["fixture-bg-agent"] } : { ok: true, agentId: String(request.agentId || "") });
    }
    if (path === "/fixture/agents-stops" && method === "GET") return json(res, 200, { stops: S.agentStops });
    // ── "Move to background" ── like the server: 400 without agentId; the switch removes the `foreground` mark from the
    // row (the seed's next tick reports it without). Every call is recorded.
    if (path === `/api/chats/${S.chat.id}/agent/background` && method === "POST") {
      const request = (await body(req)) || {};
      const agentId = typeof request.agentId === "string" ? request.agentId.trim() : "";
      if (!agentId) return json(res, 400, { error: "agentId required" });
      S.agentsBackground.push({ ...request });
      S.backgroundAgentForeground = false;
      return json(res, 200, { ok: true, agentId, background: true });
    }
    if (path === "/fixture/agents-background" && method === "GET") return json(res, 200, { calls: S.agentsBackground });
    if (path === "/api/services/events" && method === "GET") return json(res, 200, { events: S.notices });
    if (path === "/fixture/notice" && method === "POST") {
      const request = (await body(req)) || {};
      S.notices = request.clear ? [] : [...S.notices, {
        id: S.notices.length + 1, at: Date.now(), kind: String(request.kind || "review"),
        title: String(request.title || "Review angefragt: Kasse umbauen"),
        body: String(request.body || "REVIEW-REQUEST · 2. So testen: npm start"),
        chatId: request.chatId === null ? null : String(request.chatId || S.chat.id),
      }];
      return json(res, 200, { events: S.notices });
    }
    // The header's services: with `/fixture/services { on: true }` both routes answer like a workspace with running
    // services, otherwise empty. The resources follow the `projectId` filter like the real server; `host` is what the
    // backend itself measures.
    if (path === "/api/project-services" && method === "GET") return json(res, 200, S.services ? servicesSeed() : []);
    // Port conflicts (switch in state.mjs at `S.portConflicts`): the server's shape (projects/routes.js) —
    // per project id `{ items: [{ port, name, owner }] }`.
    if (path === "/api/ports/conflicts" && method === "GET") {
      S.portConflictsRetrievals += 1;
      if (S.portConflictsError) return json(res, 500, { error: "Conflicts not readable (fixture)" });
      return json(res, 200, S.portConflicts ? { [projectId]: { items: [
        { port: 3000, name: "web", owner: "Fixture-Projekt" },
        { port: 3000, name: "frontend", owner: "Anderes Projekt" },
      ] } } : {});
    }
    if (path === "/fixture/port-conflicts" && method === "GET") return json(res, 200, { on: S.portConflicts, error: S.portConflictsError, retrievals: S.portConflictsRetrievals });
    if (path === "/fixture/port-conflicts" && method === "POST") {
      const request = (await body(req)) || {};
      if ("on" in request) S.portConflicts = request.on === true;
      if ("error" in request) S.portConflictsError = request.error === true;
      return json(res, 200, { on: S.portConflicts, error: S.portConflictsError, retrievals: S.portConflictsRetrievals });
    }
    if (path === "/api/project-resources" && method === "GET") {
      // Every request is recorded (see `S.serviceResourceQueries` in state.mjs) — even without the
      // services switch, because the real backend pays the cost of `du` regardless.
      const disk = url.searchParams.get("disk");
      const onlyProject = url.searchParams.get("projectId");
      S.serviceResourceQueries = [...S.serviceResourceQueries, { disk, projectId: onlyProject, at: Date.now() }].slice(-50);
      if (!S.services) return json(res, 200, { resources: [] });
      if (S.serviceResources === "error") return json(res, 500, { error: "docker stats does not answer (fixture)" });
      // `disk=0` like the real server (projects/routes.js): no folder size, `diskBytes: null`.
      const resources = serviceResources()
        .filter((r) => !onlyProject || r.projectId === onlyProject)
        .map((r) => (disk === "0" ? { ...r, diskBytes: null } : r));
      return json(res, 200, S.servicesMachine === "none" ? { resources } : { resources, host: { ...SERVICES_HOST_BACKEND, at: Date.now() } });
    }
    return NEXT;
}
