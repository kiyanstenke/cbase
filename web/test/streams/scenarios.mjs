// The ten scenarios of the stream recorder — ONE table, readable top to bottom. Each scenario gets a fresh
// server (server.mjs) and plays its trigger against the real routes; the fake CLI (fake-cli.cjs) learns the
// name via CBASE_STREAM_SCENARIO and plays its role.
//
// Contract per scenario:
//   name         file name of the fixtures (web/test/fixtures/streams/<name>.*)
//   purpose      one sentence: what the stream should show
//   run(ctx)     seed → trigger → wait until quiet. ctx comes from withStreamServer (post/json/stream/…)
//                plus `chat`/`ws` (already created) and `chatStream`/`globalStream` (already open — except with
//                `streamLater`, where the scenario opens the chat stream itself via ctx.openChatStream()).
//   role         optional: the fake CLI's role if it is named differently from the scenario
//   rules        optional: opt-in rules of the normalisation (normalize.mjs `rules`)
//   quiet(ctx)   optional: what the runner still waits for after `run` (default: only idle of /api/runs/active)
//
// The runner (record.mjs) then waits for /api/runs/active = empty, allows a short linger time for the last
// events (bell, run end in the global stream) and fetches the history.
//
// The user texts posted below are recorded into the fixtures and stay German on purpose.

const isHarness = (subtype) => (e) => e.type === "harness" && e.subtype === subtype;
const isRunEnd = (chatId) => (e) => e.type === "run" && e.chatId === chatId && e.running === false;

export const SCENARIOS = [
  {
    name: "run",
    purpose: "A text answer with streaming deltas: user_message → run_started → system/init → stream_event (message_start, Deltas, message_delta) → assistant → result → run_done.",
    async run({ chat, chatStream, post }) {
      await post(`/api/chats/${chat.id}/message`, { text: "Erklär mir den Ereignisstrom eines Chats." });
      await chatStream.waitFor(isHarness("run_done"), { what: "run_done" });
    },
  },
  {
    name: "tool",
    purpose: "Tool call: assistant with tool_use (including input_json_delta) → user with tool_result → second API call with text.",
    async run({ chat, chatStream, post }) {
      await post(`/api/chats/${chat.id}/message`, { text: "Sieh nach, was im Testordner liegt." });
      await chatStream.waitFor(isHarness("run_done"), { what: "run_done" });
    },
  },
  {
    name: "subagent",
    purpose: "The built-in Agent tool: child events (tool_use, tool_result, deltas, assistant) carry parent_tool_use_id; in the history they become sub_text/tool with parent.",
    async run({ chat, chatStream, post }) {
      await post(`/api/chats/${chat.id}/message`, { text: "Lass einen Subagenten die Testdatei lesen." });
      await chatStream.waitFor(isHarness("run_done"), { what: "run_done" });
    },
  },
  {
    name: "question",
    purpose: "cbase_ask card: ask_request (route) → turn ends → answer via POST /ask-answer → ask_resolved → user_message → second run.",
    async run({ chat, chatStream, globalStream, post }) {
      await post(`/api/chats/${chat.id}/message`, { text: "Wir planen ein neues Repo-Layout." });
      const ask = await chatStream.waitFor(isHarness("ask_request"), { what: "ask_request" });
      await chatStream.waitFor(isHarness("run_done"), { what: "run_done (1)" });
      // Only once the first run has also ended in the global stream: otherwise its end would mix into
      // the start of the second (and the recording would flake in its order).
      await globalStream.waitFor(isRunEnd(chat.id), { what: "run false (1)" });
      await post(`/api/chats/${chat.id}/ask-answer`, {
        requestId: ask.requestId,
        answers: [{ selected: ["Getrennte Repos"], text: "wegen der Release-Zyklen" }],
      });
      await chatStream.waitFor(isHarness("run_done"), { seq: 2, what: "run_done (2)" });
    },
    quiet: ({ chat, globalStream }) => globalStream.waitFor(isRunEnd(chat.id), { seq: 2, what: "run false (2)" }),
  },
  {
    name: "limit",
    purpose: "Usage limit: the run dies with the CLI wording → limit_line (wait) + limit_wait (wait row) → after the measured reset run_started (resume) → limit_line (resume) → limit_wait null → run_done.",
    async run({ chat, chatStream, post }) {
      await post(`/api/chats/${chat.id}/message`, { text: "Bitte etwas tun, das am Limit scheitert." });
      await chatStream.waitFor((e) => e.type === "harness" && e.subtype === "limit_line" && e.line?.kind === "wait", { what: "limit_line wait" });
      // Reset 2 s + grace (CBASE_LIMIT_GRACE_MS) — the runner sets the gate deadlines, otherwise 45 s.
      await chatStream.waitFor((e) => e.type === "harness" && e.subtype === "limit_line" && e.line?.kind === "resume", { ms: 60_000, what: "limit_line resume" });
      await chatStream.waitFor(isHarness("run_done"), { ms: 30_000, what: "run_done" });
    },
    // The second bell notice (the run continues) comes after the run end — wait for it.
    quiet: ({ chat, globalStream }) => globalStream.waitFor((e) => e.type === "notice" && e.notice?.kind === "limit" && e.notice?.chatId === chat.id, { seq: 2, what: "second limit notification" }),
  },
  {
    name: "compaction",
    purpose: "POST /compact: compacting → (oneshot) → compacted; the history carries a meta row with compacted; the run afterwards starts without --resume.",
    async run({ chat, chatStream, globalStream, post }) {
      await post(`/api/chats/${chat.id}/message`, { text: "Erste Nachricht vor der Verdichtung." });
      await chatStream.waitFor(isHarness("run_done"), { what: "run_done (1)" });
      await globalStream.waitFor(isRunEnd(chat.id), { what: "run false (1)" });
      const r = await post(`/api/chats/${chat.id}/compact`);
      if (!r.ok) throw new Error(`compaction rejected: ${JSON.stringify(r)}`);
      await chatStream.waitFor(isHarness("compacted"), { what: "compacted" });
      await post(`/api/chats/${chat.id}/message`, { text: "Zweite Nachricht nach der Verdichtung." });
      await chatStream.waitFor(isHarness("run_done"), { seq: 2, what: "run_done (2)" });
    },
    quiet: ({ chat, globalStream }) => globalStream.waitFor(isRunEnd(chat.id), { seq: 2, what: "run false (2)" }),
  },
  {
    name: "join",
    purpose: "Stream join IN THE MIDDLE of a run: the chat stream opens only after two deltas are through and a second message is queued — the connected carries running, streamText and queued; then message_injected and the second turn in the same process.",
    streamLater: true,
    async run({ chat, openChatStream, post, waitForMarker, marker }) {
      await post(`/api/chats/${chat.id}/message`, { text: "Erzähl etwas Längeres." });
      await waitForMarker("deltas-out");
      // The fake CLI writes the marker AFTER writing the deltas to stdout; the server reads the pipe
      // asynchronously. The linger time is short, and the connected below is CHECKED — if it does not carry
      // both deltas, the scenario aborts instead of storing an incomplete recording.
      await new Promise((r) => setTimeout(r, 200));
      const second = await post(`/api/chats/${chat.id}/message`, { text: "Und noch etwas hinterher." });
      if (!second.queued) throw new Error(`the second message was not queued: ${JSON.stringify(second)}`);
      const chatStream = await openChatStream();
      const hello = await chatStream.waitFor(isHarness("connected"), { what: "connected" });
      if (hello.running !== true) throw new Error("connected: the run should still be running");
      if (hello.streamText !== "Ich fange an und schreibe weiter, ") throw new Error(`connected.streamText incomplete: ${JSON.stringify(hello.streamText)}`);
      if (!Array.isArray(hello.queued) || hello.queued.length !== 1) throw new Error(`connected.queued: ${JSON.stringify(hello.queued)}`);
      marker("approval");
      await chatStream.waitFor(isHarness("message_injected"), { what: "message_injected" });
      await chatStream.waitFor(isHarness("run_done"), { what: "run_done" });
    },
  },
  {
    name: "background",
    role: "subagent_background",
    // Opt-in rules of the normalisation (normalize.mjs; the scenarios before carry none): the id of the
    // subagent (`a<8 hex>-<seq>`, providers/agent-runtime.js) and its measured durations — as in the golden harness.
    rules: {
      msKey: ["totalDurationMs"],
      texts: [
        [/\ba[0-9a-f]{8}-(\d+)\b/g, "<agentrun-$1>"],
        [/"totalDurationMs": \d+/g, '"totalDurationMs": "<ms>"'],
        [/<duration_ms>\d+<\/duration_ms>/g, "<duration_ms><ms></duration_ms>"],
      ],
    },
    purpose: "Background subagent: the turn ends while the subagent lives (background after run_done carries it), its end comes without a turn (background without it) and its completion notice (<task-notification>, systemNotice) becomes its own run — a system row in the history, no user bubble.",
    async run({ chat, chatStream, globalStream, post, marker }) {
      await post(`/api/chats/${chat.id}/message`, { text: "Lass einen Subagenten nebenher den Befund holen." });
      await chatStream.waitFor(isHarness("run_done"), { what: "run_done (1): the turn ends, the subagent lives" });
      await globalStream.waitFor(isRunEnd(chat.id), { what: "run false (1)" });
      marker("sub-free"); // only now may the subagent finish — the notice reliably becomes its own run
      await chatStream.waitFor(isHarness("run_done"), { seq: 2, what: "run_done (2): the completion-notice run" });
    },
    quiet: ({ chat, globalStream }) => globalStream.waitFor(isRunEnd(chat.id), { seq: 2, what: "run false (2)" }),
  },
  {
    name: "dynworkflow",
    // The identifiers of a dynamic workflow (dynworkflows/journal.js): run id `wf_<12 hex>`, task id `w<8 hex>`.
    rules: {
      texts: [
        [/\bwf_[0-9a-f]{12}\b/g, "<wfrun>"],
        [/\bw[0-9a-f]{8}\b/g, "<wftask>"],
      ],
    },
    purpose: "Dynamic workflow: cbase_dynamic_workflow starts a run with two agent() — in the chat stream ONLY the start marker (workflow_marker, phase start), the turn ends, after the agents the end marker (phase end, status finished) and the completion notice as its own run; no row per workflow agent.",
    async run({ chat, chatStream, globalStream, post, json, marker }) {
      const r = await json(`/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
      if (r.status >= 400) throw new Error(`PATCH ultracode → ${r.status}`);
      await post(`/api/chats/${chat.id}/message`, { text: "Sammle die zwei Befunde mit einem Workflow." });
      await chatStream.waitFor(isHarness("run_done"), { what: "run_done (1): the turn ends, the workflow runs" });
      await globalStream.waitFor(isRunEnd(chat.id), { what: "run false (1)" });
      marker("sub-free"); // only now may the workflow agents finish — end marker and notice come without a turn
      await chatStream.waitFor((e) => e.type === "harness" && e.subtype === "workflow_marker" && e.marker?.phase === "end", { what: "end marker" });
      await chatStream.waitFor(isHarness("run_done"), { seq: 2, what: "run_done (2): the completion-notice run" });
    },
    quiet: ({ chat, globalStream }) => globalStream.waitFor(isRunEnd(chat.id), { seq: 2, what: "run false (2)" }),
  },
  {
    name: "approval",
    purpose: "Approval card of a dynamic workflow: without ultracode mode and without keyword cbase_dynamic_workflow answers \"awaiting_approval\" — the card in the stream (workflow_approval), the turn ends; the human rejects via POST /dyn-workflows/approval ⇒ workflow_approval_decided, the rejection arrives as a system notice (user_message with systemNotice) and becomes its own run.",
    async run({ chat, chatStream, globalStream, post }) {
      await post(`/api/chats/${chat.id}/message`, { text: "Prüf die zwei Befunde mit einem Workflow." });
      const card = await chatStream.waitFor(isHarness("workflow_approval"), { what: "workflow_approval" });
      await chatStream.waitFor(isHarness("run_done"), { what: "run_done (1): the card holds no turn" });
      await globalStream.waitFor(isRunEnd(chat.id), { what: "run false (1)" });
      await post(`/api/chats/${chat.id}/dyn-workflows/approval`, { requestId: card.card.requestId, decision: "reject" });
      await chatStream.waitFor(isHarness("run_done"), { seq: 2, what: "run_done (2): the run of the system notice" });
    },
    quiet: ({ chat, globalStream }) => globalStream.waitFor(isRunEnd(chat.id), { seq: 2, what: "run false (2)" }),
  },
];
