// The scenarios of the golden harness - ONE table, readable top to bottom. Every scenario gets a fresh server (shell
// web/test/streams/server.mjs) and plays its trigger against the real routes; the fake CLI (web/test/streams/fake-cli.cjs)
// knows its role through CBASE_STREAM_SCENARIO.
//
// Contract per scenario:
//   name       folder name of the fixtures (server/backend/test/fixtures/golden/<name>/)
//   role       what the fake CLI plays (default: name) - subagent_native has another name than the web subagent
//   purpose    one sentence: what the recording shows
//   env        environment variables BEFORE the server start (ticks that would otherwise interfere; see server.mjs)
//   seed(ctx)  creates what the trigger needs and returns { chats: [ids whose stream is opened],
//              known: { id -> placeholder } } - the placeholders make the recording readable (<chat-2>, <job-1>,
//              <channel-1>) instead of <id-N>. ctx: base, post, json, waitFor, waitForIdle, marker, waitForMarker,
//              wsPath, root (see withStreamServer)
//   run(ctx)   trigger -> wait until the scenario is over; ctx additionally `ws`, `chats` (streams per chat id),
//              `global` (the global stream), `seed` (the return of seed). May return { known } for ids that only
//              come into being during the run (the run of a workflow).
//   quiet(ctx) optional: what is still awaited after `run` and the idle state (bell, run end in the global stream)
//
// Every scenario takes its seed and the shape of the fake CLI from the green backend test that already drives the path:
// chat-stream-join (run), ask-card (question), auto-continue (limit), channel.test.js (channel), workflow-engine-e2e
// (workflow), native-agent-e2e (subagent), scheduled-run and scheduled-run-end (schedule, schedule-limit),
// autocompact.test.js second test (targetGate).
//
// Two decisions of the seed that shape EVERY recording (as in the web recorder): every chat the scenario knows is
// titled BEFORE its first turn (PATCH {title} => titled=1; the chat of a scheduled job is from creation) - otherwise the
// auto-title oneshot would run after the turn and its `title` event would stand before or after the run end depending on
// process start; and the tick of Scheduled is set to one hour - what a scenario needs it triggers itself ("run now"), so
// that no timer decides the recording. EXCEPTION on purpose: curate stays UNTITLED - there the auto-title oneshot is meant
// to run and show up in spawn.json; the order of the events is held by markers (the fake CLI answers only when the recorder
// has seen the previous event).
//
// The user texts, chat and job names posted below are recorded into the fixtures and stay German on purpose.

const MODEL = "claude-haiku-4-5-20251001";
const isHarness = (subtype) => (e) => e.type === "harness" && e.subtype === subtype;
const isRunEnd = (chatId) => (e) => e.type === "run" && e.chatId === chatId && e.running === false;
// Ticks that must not run on their own in ANY scenario (one hour; the scenarios last seconds). CBASE_SCHEDULE_TICK_MS is the
// tick of Scheduled.
const TICKS_FROM = { CBASE_SCHEDULE_TICK_MS: "3600000" };

const title = async (ctx, chatId, text) => {
  const r = await ctx.json(`/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ title: text }) });
  if (r.status >= 400) throw new Error(`PATCH title ${chatId} → ${r.status}: ${JSON.stringify(r.body)}`);
};
const newWorkspace = (ctx, name) => ctx.post("/api/workspaces", { name, path: ctx.wsPath });
const newChat = async (ctx, ws, name) => {
  const chat = await ctx.post("/api/chats", { workspaceId: ws.id, provider: "claude", model: MODEL, permissionMode: "bypassPermissions" });
  await title(ctx, chat.id, name);
  return chat;
};
const newProject = async (ctx, ws, name, subfolder) => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const filePath = path.join(ctx.wsPath, subfolder);
  fs.mkdirSync(filePath, { recursive: true });
  return ctx.post(`/api/workspaces/${ws.id}/projects`, { path: filePath, name });
};
// A scheduled job through the real route (geplant/routes.js POST .../scheduled): chat and job in ONE step, the chat is titled
// from creation (name "Tages-Briefing"). Workdays 08:00 in Berlin - the tick is parked (TICKS_FROM), only "run now" runs.
const scheduled = (ws) => `/api/workspaces/${ws.id}/scheduled`;
// `permissionMode` "default" (scheduled-approval): the run then carries --permission-prompt-tool.
const newJob = async (ctx, ws, { permissionMode = "bypassPermissions" } = {}) => {
  const r = await ctx.json(scheduled(ws), { method: "POST", body: JSON.stringify({
    name: "Tages-Briefing", instructions: "Berichte, was ansteht.", cadence: "workdays", plan: { clockTime: "08:00" }, timeZone: "Europe/Berlin",
    provider: "claude", model: MODEL, permissionMode,
  }) });
  if (r.status !== 201) throw new Error(`POST scheduled → ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const runOf = async (json, ws, jobId, matches) => (await json(`${scheduled(ws)}/${jobId}/runs`)).body?.items?.find(matches) || null;

// Wait for a chat stream run: the N-th run_done in this chat's stream.
const runDone = (chats, chatId, seq = 1, what = `run_done ${seq}`) => chats[chatId].waitFor(isHarness("run_done"), { seq, what, ms: 30_000 });

export const SCENARIOS = [
  {
    name: "run",
    purpose: "The base case: one message, one answer in deltas - user_message → run_started → CLI events → run_done; history, run meta, usage_events.",
    env: TICKS_FROM,
    async seed(ctx) {
      const ws = await newWorkspace(ctx, "Golden");
      const chat = await newChat(ctx, ws, "Golden lauf");
      return { ws, chats: [chat.id], known: {} };
    },
    async run({ post, chats, seed }) {
      const [chatId] = seed.chats;
      await post(`/api/chats/${chatId}/message`, { text: "Erklär mir den Ereignisstrom eines Chats." });
      await runDone(chats, chatId);
    },
    quiet: ({ global, seed }) => global.waitFor(isRunEnd(seed.chats[0]), { what: "run false" }),
  },
  {
    name: "question",
    purpose: "cbase_ask through the real route: ask_request → turn ends → POST /ask-answer → ask_resolved → second run with --resume.",
    env: TICKS_FROM,
    async seed(ctx) {
      const ws = await newWorkspace(ctx, "Golden");
      const chat = await newChat(ctx, ws, "Golden rueckfrage");
      // The fake CLI talks to the route itself (like the MCP server) - it needs base and chat id.
      ctx.setEnv("CBASE_STREAM_CHAT", chat.id);
      return { ws, chats: [chat.id], known: {} };
    },
    async run({ post, chats, global, seed }) {
      const [chatId] = seed.chats;
      const stream = chats[chatId];
      await post(`/api/chats/${chatId}/message`, { text: "Wir planen ein neues Repo-Layout." });
      const ask = await stream.waitFor(isHarness("ask_request"), { what: "ask_request" });
      await runDone(chats, chatId, 1);
      // Only when the first run has also ended in the global stream - otherwise its end would mix into the start of the
      // second (web recorder, measured).
      await global.waitFor(isRunEnd(chatId), { what: "run false (1)" });
      await post(`/api/chats/${chatId}/ask-answer`, { requestId: ask.requestId, answers: [{ selected: ["Getrennte Repos"], text: "wegen der Release-Zyklen" }] });
      await runDone(chats, chatId, 2);
    },
    quiet: ({ global, seed }) => global.waitFor(isRunEnd(seed.chats[0]), { seq: 2, what: "run false (2)" }),
  },
  {
    name: "limit",
    purpose: "Usage limit (afterLimit): the CLI dies with the wording → limit_line/limit_wait → after the booked reset run_started (without session) → answer; pending_resumes empty at the end, two bell notices.",
    env: TICKS_FROM,
    async seed(ctx) {
      const ws = await newWorkspace(ctx, "Golden");
      const chat = await newChat(ctx, ws, "Golden limit");
      return { ws, chats: [chat.id], known: {} };
    },
    async run({ post, chats, seed }) {
      const [chatId] = seed.chats;
      const stream = chats[chatId];
      await post(`/api/chats/${chatId}/message`, { text: "Bitte etwas tun, das am Limit scheitert." });
      await stream.waitFor((e) => e.type === "harness" && e.subtype === "limit_line" && e.line?.kind === "wait", { what: "limit_line wait" });
      // Reset 2 s + grace (CBASE_LIMIT_GRACE_MS 2000 from the runner) - without the gate deadlines 45 s.
      await stream.waitFor((e) => e.type === "harness" && e.subtype === "limit_line" && e.line?.kind === "resume", { ms: 60_000, what: "limit_line resume" });
      await runDone(chats, chatId);
    },
    quiet: ({ global, seed }) => global.waitFor((e) => e.type === "notice" && e.notice?.kind === "limit" && e.notice?.chatId === seed.chats[0], { seq: 2, what: "second limit notification" }),
  },
  {
    name: "channel",
    purpose: "Channel delivery coding↔coding (run end → hook \"ende\" → consumer \"channel-delivery\"): message #2 of the counterpart arrives WHILE the coding chat is working on message #1 - it is delivered only after that run ends (second turn); the coding chat's answer through cbase_agent_send (kanal:<id>) wakes the second coding chat (occasion channel).",
    env: TICKS_FROM,
    async seed(ctx) {
      const ws = await newWorkspace(ctx, "Golden");
      // Two ordinary coding chats (as channel.test.js `paar`).
      const opposite = await newChat(ctx, ws, "Auftrag Kasse");
      const coding = await newChat(ctx, ws, "Kasse umbauen");
      const channel = await ctx.post(`/api/workspaces/${ws.id}/channels`, { name: "Kasse-Umbau", participants: [opposite.id, coding.id] });
      return { ws, chats: [coding.id, opposite.id], known: { [opposite.id]: "<chat-2>", [channel.id]: "<channel-1>" }, channel, oppositeId: opposite.id, codingId: coding.id };
    },
    async run({ post, chats, global, seed, marker, waitForMarker }) {
      const { channel, oppositeId, codingId } = seed;
      const coding = chats[codingId];
      const opposite = chats[oppositeId];
      await post(`/api/channels/${channel.id}/messages`, { chatId: oppositeId, text: "Bitte zuerst den Zahlungsfluss prüfen, dann die Kasse." });
      await coding.waitFor(isHarness("run_started"), { what: "run_started (1) in the coding chat" });
      // The fake CLI holds turn 1 open - now message #2, which is NOT delivered in the open turn.
      await waitForMarker("channel-turn-1");
      await post(`/api/channels/${channel.id}/messages`, { chatId: oppositeId, text: "Und bitte den Stand melden, sobald der Zahlungsfluss geprüft ist." });
      marker("channel-free-1");
      await runDone(chats, codingId, 1, "run_done (1) in the coding chat");
      // After the run end the consumer "channel-delivery" delivers message #2 - the second turn. Without the "ende" hook
      // firing it would stay and the deadline would expire here (sabotage probe).
      await coding.waitFor(isHarness("run_started"), { seq: 2, what: "run_started (2) in the coding chat - the delivery after the run end" });
      // The coding chat answers through the channel, the counterpart is woken and runs to its end - ONLY then does the recorder
      // release the coding turn (fixed order of the two run ends).
      await opposite.waitFor(isHarness("run_started"), { what: "run_started in the counterpart" });
      await runDone(chats, oppositeId, 1, "run_done in the counterpart");
      await global.waitFor(isRunEnd(oppositeId), { what: "run false (counterpart)" });
      marker("opposite-finished");
      await runDone(chats, codingId, 2, "run_done (2) in the coding chat");
    },
    quiet: ({ global, seed }) => global.waitFor(isRunEnd(seed.codingId), { seq: 2, what: "run false (2, coding)" }),
  },
  {
    name: "workflow",
    purpose: "Workflow gate (afterRun → workflowGateAfterRun): Start → Arbeit (completion gate, verdict first \"not done\", then \"done\") → Danach → Ende; three turns, two gate oneshots, workflow_runs/workflow_run_steps.",
    env: TICKS_FROM,
    async seed(ctx) {
      const ws = await newWorkspace(ctx, "Golden");
      const flow = await ctx.post(`/api/workspaces/${ws.id}/workflows`, { name: "Mit Abschluss-Gate" });
      // `run: { doneAll: false }`: "check all work steps" is on by default - "Danach" would otherwise get a verdict of its own.
      // The scenario's point stays: ONE node with a completion gate (`doneCheck: true` => `doneMode: "on"`).
      const r = await ctx.json(`/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({ run: { doneAll: false }, graph: {
        nodes: [
          { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
          { id: "n1", type: "instruction", title: "Arbeit", text: "MACH DIE ARBEIT", doneCheck: true, x: 220, y: 0 },
          { id: "n2", type: "instruction", title: "Danach", text: "NACH DER ARBEIT", x: 440, y: 0 },
          { id: "e0", type: "end", title: "Ende", x: 660, y: 0 },
        ],
        edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "e0" }],
      } }) });
      if (r.status >= 400) throw new Error(`PUT workflow → ${r.status}: ${JSON.stringify(r.body)}`);
      const chat = await newChat(ctx, ws, "Gate-Chat");
      return { ws, chats: [chat.id], known: { [flow.id]: "<workflow-1>" }, flow };
    },
    async run({ post, json, waitFor, chats, seed }) {
      const [chatId] = seed.chats;
      const r = await post(`/api/chats/${chatId}/workflow`, { workflowId: seed.flow.id, input: "" });
      const finished = await waitFor(async () => {
        const d = await json(`/api/workflow-runs/${r.run.id}`);
        return ["done", "failed", "waiting"].includes(d.body?.run?.status) ? d.body : null;
      }, "the workflow run ends", 60_000);
      if (finished.run.status !== "done") throw new Error(`workflow ended as ${finished.run.status}: ${finished.run.note}`);
      // Work, continuation of the same node (gate), only then the follow-up step - three turns.
      await runDone(chats, chatId, 3, "run_done (3)");
      return { known: { [r.run.id]: "<workflow-run-1>" } };
    },
    quiet: ({ global, seed }) => global.waitFor(isRunEnd(seed.chats[0]), { seq: 3, what: "run false (3)" }),
  },
  {
    name: "graph-start",
    role: "graph_start",
    purpose: "Graph workflow through /workflow: the message route rewrites the mention for the model and gives the input its announcement; the start turn calls cbase_workflow_start (real MCP server, row \"vorgemerkt\") and answers \"Gestartet.\" - at the turn end the turn completion redeems it, the workflow begins, and its only step is a turn of its OWN; the start turn does not count as a step, its work end is omitted (no \"ende\" between the two). graph_starts stands at \"gestartet\" with run_id.",
    env: TICKS_FROM,
    async seed(ctx) {
      const ws = await newWorkspace(ctx, "Golden");
      const flow = await ctx.post(`/api/workspaces/${ws.id}/workflows`, { name: "Golden Graph" });
      // `run: { doneAll: false }`: without a completion gate - a verdict would be a second process here that adds nothing to the
      // point (that is in the scenario workflow).
      const r = await ctx.json(`/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({ run: { doneAll: false }, graph: {
        nodes: [
          { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
          { id: "n1", type: "instruction", title: "Schritt", text: "SCHRITT EINS", x: 220, y: 0 },
          { id: "e0", type: "end", title: "Ende", x: 440, y: 0 },
        ],
        edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "e0" }],
      } }) });
      if (r.status >= 400) throw new Error(`PUT workflow → ${r.status}: ${JSON.stringify(r.body)}`);
      const chat = await newChat(ctx, ws, "Graph-Chat");
      return { ws, chats: [chat.id], known: { [flow.id]: "<workflow-1>" }, flow };
    },
    async run({ post, json, waitFor, chats, seed }) {
      const [chatId] = seed.chats;
      await post(`/api/chats/${chatId}/message`, { text: "/workflow:golden-graph bitte los" });
      // The start turn, then the step as the second run.
      await runDone(chats, chatId, 1, "run_done (start turn)");
      const run = await waitFor(async () => {
        const w = (await json(`/api/chats/${chatId}/workflow`)).body?.run;
        return w && ["done", "failed", "waiting", "cancelled"].includes(w.status) ? w : null;
      }, "the graph workflow ends", 60_000);
      if (run.status !== "done") throw new Error(`workflow ended as ${run.status}: ${run.note}`);
      await runDone(chats, chatId, 2, "run_done (step)");
      const d = (await json(`/api/workflow-runs/${run.id}`)).body;
      const steps = (d.steps || []).filter((st) => st.kind === "step");
      const text = (st) => (typeof st.detail === "string" ? st.detail : JSON.stringify(st.detail || {}));
      if (steps.length !== 1 || (steps[0].nodeId ?? steps[0].node_id) !== "n1") throw new Error(`Steps: ${JSON.stringify(steps)}`);
      if (!/ERLEDIGT: .*SCHRITT EINS/.test(text(steps[0]))) throw new Error(`step n1 without its result: ${text(steps[0])}`);
      if ((d.steps || []).some((st) => text(st).includes("Gestartet."))) throw new Error("the start turn stands as a step in the log");
      return { known: { [run.id]: "<workflow-run-1>" } };
    },
    quiet: ({ global, seed }) => global.waitFor(isRunEnd(seed.chats[0]), { seq: 2, what: "run false (2)" }),
  },
  {
    name: "subagent",
    role: "subagent_native",
    purpose: "Native subagent (cbase_agent through the real MCP server): the server starts a second fake run with the subagent system prompt, mirrors its events under the call block and returns the report as the tool result; two processes in the spawn log.",
    env: TICKS_FROM,
    async seed(ctx) {
      const ws = await newWorkspace(ctx, "Golden");
      const chat = await newChat(ctx, ws, "Golden subagent");
      return { ws, chats: [chat.id], known: {} };
    },
    async run({ post, chats, seed }) {
      const [chatId] = seed.chats;
      await post(`/api/chats/${chatId}/message`, { text: "Lass einen Subagenten den Befund holen." });
      await runDone(chats, chatId);
    },
    quiet: ({ global, seed }) => global.waitFor(isRunEnd(seed.chats[0]), { what: "run false" }),
  },
  {
    name: "subagent-background",
    role: "subagent_background",
    purpose: "Background subagent: the main agent starts it without run_in_background and ends its turn (run_done while the subagent lives); its completion notice (<task-notification>, occasion \"agent\", system message) becomes a run of its own. Three processes; the subagent's usage is booked with its end.",
    env: TICKS_FROM,
    async seed(ctx) {
      const ws = await newWorkspace(ctx, "Golden");
      const chat = await newChat(ctx, ws, "Golden subagent-background");
      return { ws, chats: [chat.id], known: {} };
    },
    async run({ post, chats, global, seed, marker }) {
      const [chatId] = seed.chats;
      await post(`/api/chats/${chatId}/message`, { text: "Lass einen Subagenten nebenher den Befund holen." });
      await runDone(chats, chatId, 1, "run_done (1): the turn ends, the subagent lives");
      await global.waitFor(isRunEnd(chatId), { seq: 1, what: "run false (1)" });
      marker("sub-free"); // only now may the subagent finish - the notice surely becomes a run of its own
      await runDone(chats, chatId, 2, "run_done (2): the completion-notice run");
    },
    quiet: ({ global, seed }) => global.waitFor(isRunEnd(seed.chats[0]), { seq: 2, what: "run false (2)" }),
  },
  {
    name: "schedule",
    purpose: "Scheduled job started by hand (\"run now\", occasion hand): the slot is a message to the job's chat (occasion schedule) - hook turnStart/\"geplant\" sets the start, beforeRunBroadcast/\"scheduled-end\" the run end; job block in the system prompt, run row \"ok\" with teaser, notice of kind schedule.",
    env: TICKS_FROM,
    async seed(ctx) {
      const ws = await newWorkspace(ctx, "Golden");
      const { job, chat } = await newJob(ctx, ws);
      return { ws, chats: [chat.id], known: { [job.id]: "<job-1>" }, job };
    },
    async run({ json, waitFor, chats, global, seed }) {
      const [chatId] = seed.chats;
      const r = await json(`${scheduled(seed.ws)}/${seed.job.id}/run`, { method: "POST" });
      if (r.status !== 201) throw new Error(`run now → ${r.status}: ${JSON.stringify(r.body)}`);
      await runDone(chats, chatId, 1, "run_done of the slot");
      await waitFor(() => runOf(json, seed.ws, seed.job.id, (l) => l.status === "ok"), "the scheduled run ends with ok", 30_000);
      await global.waitFor(isRunEnd(chatId), { what: "run false (job chat)" });
    },
    quiet: ({ global, seed }) => global.waitFor((e) => e.type === "notice" && e.notice?.kind === "schedule" && e.notice?.chatId === seed.chats[0], { what: "notice of the scheduled run" }),
  },
  {
    name: "targetGate",
    purpose: "Autocompact → goal gate: the first turn fills 75 % of the window (threshold 60 %), after the run the server compacts, THEN the goal gate judges \"open\" and starts the continuation without resume with the summary; the second verdict \"reached\" clears the goal.",
    env: TICKS_FROM,
    async seed(ctx) {
      const ws = await newWorkspace(ctx, "Golden");
      const r = await ctx.json("/api/autocompact", { method: "PUT", body: JSON.stringify({ percent: 60 }) });
      if (r.status >= 400) throw new Error(`PUT autocompact → ${r.status}`);
      const chat = await newChat(ctx, ws, "Golden zielgate");
      const g = await ctx.json(`/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ goal: "Alles zu Ende bringen" }) });
      if (g.status >= 400) throw new Error(`PATCH goal → ${g.status}`);
      return { ws, chats: [chat.id], known: {} };
    },
    async run({ post, json, waitFor, chats, seed }) {
      const [chatId] = seed.chats;
      await post(`/api/chats/${chatId}/message`, { text: "Erste Frage" });
      await runDone(chats, chatId, 1);
      await chats[chatId].waitFor(isHarness("compacted"), { what: "compacted" });
      await runDone(chats, chatId, 2, "run_done (2) - the goal gate continuation");
      await waitFor(async () => { const c = (await json(`/api/chats/${chatId}`)).body; return c && c.goal === "" ? c : null; }, "the goal is cleared after the second verdict");
    },
    quiet: ({ global, seed }) => global.waitFor(isRunEnd(seed.chats[0]), { seq: 2, what: "run false (2)" }),
  },

  {
    name: "ingest",
    purpose: "Sorting in files (projects/coding-jobs.js, an ordinary coding chat): POST .../context/ingest creates the chat and returns the job, the client sends it with the file as the first message; the turn reads with Read and summarizes - without a run kind, the job stands in the history instead of the system prompt.",
    env: TICKS_FROM,
    async seed(ctx) {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const ws = await newWorkspace(ctx, "Golden");
      fs.writeFileSync(path.join(ctx.wsPath, "note.md"), "# Kasse\nDas Testsystem steht seit dem 1. September.\n");
      const r = await ctx.post(`/api/workspaces/${ws.id}/context/ingest`, { target: "workspace" });
      if (!r?.chatId || !r.job) throw new Error(`context/ingest → ${JSON.stringify(r)} (expected chatId and job)`);
      return { ws, chats: [r.chatId], known: {}, job: r.job };
    },
    async run({ post, chats, seed, wsPath }) {
      const [chatId] = seed.chats;
      await post(`/api/chats/${chatId}/message`, { text: `${seed.job}\n\nDatei: ${wsPath}/note.md` });
      await runDone(chats, chatId);
    },
    quiet: ({ global, seed }) => global.waitFor(isRunEnd(seed.chats[0]), { what: "run false" }),
  },
  {
    name: "curate",
    purpose: "Project chat with post-run curator (CURATOR_ENABLED=1 → curateAfterRun spawns the curator oneshot), UNTITLED and with a queued second message as the follow-up run (the only follow-up run in the golden). Measured: the title oneshot of a NORMAL chat starts at the message route (BEFORE the run, \"New chat\"), maybeAutoTitle after the run is a no-op there; the spawn list (spawn order) shows title → run → curator → follow-up run → curator; context_suggestions in the DB, curator_suggestions and title in the chat stream.",
    env: { ...TICKS_FROM, CURATOR_ENABLED: "1" },
    async seed(ctx) {
      const ws = await newWorkspace(ctx, "Golden");
      const till = await newProject(ctx, ws, "Kasse", "till");
      // Project chat, without a title PATCH: titled=0.
      const chat = await ctx.post("/api/chats", { workspaceId: ws.id, projectId: till.id, provider: "claude", model: MODEL, permissionMode: "bypassPermissions" });
      return { ws, chats: [chat.id], known: { [till.id]: "<project-1>" } };
    },
    async run({ post, chats, global, seed, marker, waitForMarker }) {
      const [chatId] = seed.chats;
      const stream = chats[chatId];
      await post(`/api/chats/${chatId}/message`, { text: "Prüfen wir zuerst das Testsystem der Kasse oder bauen wir gleich um?" });
      await stream.waitFor(isHarness("run_started"), { what: "run_started (1)" });
      // Message #2 in the window between stdin end and process end - follow-up run.
      await waitForMarker("stdin-closed");
      const q = await post(`/api/chats/${chatId}/message`, { text: "Und bitte kurz halten." });
      if (!q?.queued) throw new Error(`message #2 was not queued: ${JSON.stringify(q)}`);
      marker("exit-free");
      await runDone(chats, chatId, 1);
      // Order of the answers (not of the spawns): curator → title → follow-up turn. The title oneshot has been running since the
      // message route; the fake CLI holds its answer until "curator-finished".
      await stream.waitFor(isHarness("curator_suggestions"), { what: "curator_suggestions (the curator suggested)" });
      marker("curator-finished");
      // The second chat_title: the first is the truncated message start from the route.
      await global.waitFor((e) => e.type === "chat_title" && e.chatId === chatId, { seq: 2, what: "chat_title (2, the auto title)" });
      marker("title-finished");
      await runDone(chats, chatId, 2, "run_done (2) - the follow-up run of the queued message");
    },
    // The follow-up run is also a project turn: its curator oneshot must have answered before the dump.
    async quiet({ global, chats, seed }) {
      await global.waitFor(isRunEnd(seed.chats[0]), { seq: 2, what: "run false (2)" });
      await chats[seed.chats[0]].waitFor(isHarness("curator_suggestions"), { seq: 2, what: "curator_suggestions (2, after the follow-up run)" });
    },
  },
  // -- The limit side of the completion hooks: no other scenario fires `afterLimitCancel`. The order of its two consumers
  // (scheduled end BEFORE workflow end) was held only by one single test per consumer, not their order. Template:
  // scheduled-run-end test (3) - the consumer is called "geplant-ende", the human at the strip discards => "aborted" -
  // with the fake role `limit`.
  {
    name: "schedule-limit",
    role: "limit",
    purpose: "Scheduled run parked at the usage limit, wait row discarded (scheduled-run-end (3), the human at the strip): the CLI dies on the limit wording, the slot is parked (run row; the run line stays \"open\" - parked counts as running), DELETE /auto-continue discards the row => hook afterLimitCancel: scheduled end (\"aborted\", without notice - the human knows) BEFORE workflow end (no workflow); NO second process - hooks.jsonl carries the only afterLimitCancel firing of the golden.",
    env: TICKS_FROM,
    async seed(ctx) {
      const ws = await newWorkspace(ctx, "Golden");
      const { job, chat } = await newJob(ctx, ws);
      return { ws, chats: [chat.id], known: { [job.id]: "<job-1>" }, job };
    },
    async run({ json, waitFor, global, seed }) {
      const [chatId] = seed.chats;
      const r = await json(`${scheduled(seed.ws)}/${seed.job.id}/run`, { method: "POST" });
      if (r.status !== 201) throw new Error(`run now → ${r.status}: ${JSON.stringify(r.body)}`);
      const runId = r.body.run.id;
      // The run wait row appears after the process end and the usage fetch of the parking; its reset lies 2 s + grace (gate
      // deadlines) ahead - the discarding comes long before, a second process never starts.
      const wait = await waitFor(async () => (await json(`/api/chats/${chatId}/auto-continue`)).body?.wait || null, "the run wait row of the parked slot", 30_000);
      if (wait.kind !== "run") throw new Error(`wait row is "${wait.kind}", not run`);
      await global.waitFor(isRunEnd(chatId), { what: "run false (job chat, parked)" });
      const open = await runOf(json, seed.ws, seed.job.id, (l) => l.id === runId);
      if (open?.status !== "open") throw new Error(`parked counts as running - the run line stands at "${open?.status}"`);
      // Discard: DELETE /auto-continue → cancelAutoContinue (kind "cancel") → hook "afterLimitCancel" - the consumer
      // "geplant-ende" closes the run line (aborted), the workflow consumer finds no run.
      const del = await json(`/api/chats/${chatId}/auto-continue`, { method: "DELETE" });
      if (del.status !== 200 || del.body?.ok !== true) throw new Error(`DELETE auto-continue → ${del.status}: ${JSON.stringify(del.body)}`);
      await waitFor(() => runOf(json, seed.ws, seed.job.id, (l) => l.id === runId && l.status === "aborted"), "the run line stands at \"aborted\"", 30_000);
    },
    // No notice of the run: "aborted" reports nothing (the human discarded it themselves). The end is the `scheduled` broadcast
    // with status "aborted"; the limit bell of the parking stands before it.
    quiet: ({ global }) => global.waitFor((e) => e.type === "scheduled" && e.status === "aborted", { what: "scheduled \"aborted\" in the global stream" }),
  },
  // -- Two ways of the scheduled job that no other scenario takes: scheduled-approval carries the only chat spawn with
  // `--permission-mode default` and `--permission-prompt-tool` and the consumers beforePermission/afterPermission
  // "scheduled-approval"; scheduled-dismissed the kind inputDismissed with the consumer "geplant".
  {
    name: "scheduled-approval",
    role: "scheduled_approval",
    purpose: "Approval in the scheduled turn (template scheduled.test.js (4)): the job's chat runs in permission mode \"default\" - the spawn carries --permission-mode default and --permission-prompt-tool mcp__cbase__cbase_permission_prompt; the slot asks for an approval through the real MCP server, beforePermission/\"scheduled-approval\" reports the card as notice \"freigabe\" with chatId and requestId, the human approves it through POST .../permission-decision, afterPermission/\"scheduled-approval\" resolves the notice, the turn ends \"ok\".",
    env: TICKS_FROM,
    async seed(ctx) {
      const ws = await newWorkspace(ctx, "Golden");
      const { job, chat } = await newJob(ctx, ws, { permissionMode: "default" });
      return { ws, chats: [chat.id], known: { [job.id]: "<job-1>" }, job };
    },
    async run({ json, waitFor, chats, global, seed }) {
      const [chatId] = seed.chats;
      const r = await json(`${scheduled(seed.ws)}/${seed.job.id}/run`, { method: "POST" });
      if (r.status !== 201) throw new Error(`run now → ${r.status}: ${JSON.stringify(r.body)}`);
      // The card stands in the chat, its notice in the global stream - only then does the human decide (the fake waits in the long poll).
      const card = await chats[chatId].waitFor(isHarness("permission_request"), { what: "permission_request of the scheduled turn" });
      await global.waitFor((e) => e.type === "notice" && e.notice?.kind === "approval" && e.notice?.chatId === chatId, { what: "notice \"freigabe\" of the scheduled run (beforePermission/scheduled-approval)" });
      const d = await json(`/api/chats/${chatId}/permission-decision`, { method: "POST", body: JSON.stringify({ requestId: card.requestId, behavior: "allow" }) });
      if (d.status !== 200 || d.body?.ok !== true) throw new Error(`permission-decision → ${d.status}: ${JSON.stringify(d.body)}`);
      // afterPermission/"scheduled-approval" resolves the notice in the decision (synchronously, before the route answers). The bell
      // sends no event for it - it is read like the clients do through GET /api/services/events; if it stands open the scenario ends red.
      const note = (await json("/api/services/events")).body?.events?.find((n) => n.kind === "approval" && n.requestId === card.requestId);
      if (note?.resolved !== true) throw new Error(`the approval notice is not resolved after the decision: ${JSON.stringify(note)}`);
      await runDone(chats, chatId, 1, "run_done of the slot after the approval");
      await waitFor(() => runOf(json, seed.ws, seed.job.id, (l) => l.status === "ok"), "the scheduled run ends with ok", 30_000);
      await global.waitFor(isRunEnd(chatId), { what: "run false (job chat)" });
    },
    quiet: ({ global, seed }) => global.waitFor((e) => e.type === "notice" && e.notice?.kind === "schedule" && e.notice?.chatId === seed.chats[0], { what: "notice of the scheduled run" }),
  },
  {
    name: "scheduled-dismissed",
    role: "scheduled_dismissed",
    purpose: "Discarded slot (template scheduled-run.test.js (2)): the human keeps the job's chat busy with a turn of their own, \"run now\" queues the slot (global \"geplant ... eingereiht\"), the human discards the entry through DELETE .../message/queue/:id (runs/queue.js cancelRunInput) => hook inputDismissed/\"geplant\" => run \"verworfen\"; the human's turn ends afterwards, a slot turn never starts (one spawn).",
    env: TICKS_FROM,
    async seed(ctx) {
      const ws = await newWorkspace(ctx, "Golden");
      const { job, chat } = await newJob(ctx, ws);
      return { ws, chats: [chat.id], known: { [job.id]: "<job-1>" }, job };
    },
    async run({ post, json, waitFor, chats, seed, marker, waitForMarker }) {
      const [chatId] = seed.chats;
      const stream = chats[chatId];
      await post(`/api/chats/${chatId}/message`, { text: "Bitte bereite das Briefing vor." });
      await stream.waitFor(isHarness("run_started"), { what: "run_started (the human's turn)" });
      // The fake holds the human's turn open - now the slot, which can only be queued.
      await waitForMarker("human-turn");
      const r = await json(`${scheduled(seed.ws)}/${seed.job.id}/run`, { method: "POST" });
      if (r.status !== 201) throw new Error(`run now → ${r.status}: ${JSON.stringify(r.body)}`);
      const runId = r.body.run.id;
      const queue = await stream.waitFor((e) => e.type === "harness" && e.subtype === "message_queue" && e.queued?.length === 1, { what: "message_queue with the queued slot" });
      const dismiss = await json(`/api/chats/${chatId}/message/queue/${queue.queued[0].id}`, { method: "DELETE" });
      if (dismiss.status !== 200) throw new Error(`DELETE message/queue → ${dismiss.status}: ${JSON.stringify(dismiss.body)}`);
      await waitFor(() => runOf(json, seed.ws, seed.job.id, (l) => l.id === runId && l.status === "dismissed"), "the run stands at \"dismissed\"", 30_000);
      marker("dismissed-free");
      await runDone(chats, chatId, 1, "run_done (the human's turn)");
    },
    quiet: ({ global, seed }) => global.waitFor(isRunEnd(seed.chats[0]), { what: "run false (job chat)" }),
  },
];
