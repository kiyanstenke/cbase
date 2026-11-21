// Histories (seededHistory) and startFixtureRun (the run simulation) of the fixture gateway. German message texts below stay German on purpose: the UI tests match them.
import { S, approvalRows, clearRun, ASK_QUESTIONS_THREE, ASK_QUESTIONS, chatEvent, globalEvent, chatId, schedule, ASK_REQUEST_ID, publicQueue, channelRows } from "./state.mjs";
// An answer that DELIBERATELY uses the whole Markdown range. The UI test checks that nothing arrives as raw text (no hashes,
// dashes, pipes, brackets).
const MARKDOWN_SHOWCASE = [
  "## Zwischenbericht",
  "",
  "Der Dienst laeuft **stabil**, aber mit *einer* Einschraenkung: `retry_after` fehlt.",
  "",
  "### Offene Punkte",
  "",
  "- Erster Punkt mit `Code`",
  "  - Verschachtelter Unterpunkt",
  "- Zweiter Punkt",
  "",
  "1. Zuerst pruefen",
  "2. Dann ausrollen",
  "",
  "- [x] Migration geschrieben",
  "- [ ] Migration ausgefuehrt",
  "",
  "> Wichtig: die Warteschlange nicht leeren.",
  "",
  "| Dienst | Status | Antwort |",
  "| --- | :---: | ---: |",
  "| Gateway | gruen | 42 ms |",
  "| Datenbank | gelb | 310 ms |",
  "",
  // Deliberately wider than the screen: checks the sideways scrolling of the table.
  "| Column-01 | Column-02 | Column-03 | Column-04 | Column-05 | Column-06 | Column-07 | Column-08 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  "| Wert-01 | Wert-02 | Wert-03 | Wert-04 | Wert-05 | Wert-06 | Wert-07 | Wert-08 |",
  "",
  "---",
  "",
  "~~Alter Weg~~ ist ersetzt, siehe [Bericht](https://example.com/bericht).",
  "",
  "```sql",
  "select count(*) from auftraege;",
  "```",
].join("\n");

// Start and end marker of a dynamic workflow in the form the server writes (server/backend/electron/server/dynworkflows/run.js),
// between them the triggering turn, then the completion notice.
function workflowMarkersHistory() {
  const t = Date.now() - 60_000;
  const marker = (phase, extra = {}) => JSON.stringify({ phase, runId: "wf_fixture0001", taskId: "wfixture1", name: "findings-collect", ...extra, at: t });
  return [
    { role: "user", text: "Collect the findings with a workflow.", ts: t, attachments: [] },
    { role: "workflow_marker", text: marker("start"), ts: t + 1_000, attachments: [] },
    { role: "assistant", text: "The workflow runs in the background.", ts: t + 2_000, attachments: [] },
    { role: "workflow_marker", text: marker("end", { status: "failed" }), ts: t + 3_000, attachments: [] },
    {
      role: "user", ts: t + 4_000, attachments: [],
      text: "<task-notification>\n<task-id>wfixture1</task-id>\n<status>failed</status>\n<name>findings-collect</name>\n<summary>Workflow \"findings-collect\" failed: boom</summary>\n<result></result>\n</task-notification>",
    },
    { role: "assistant", text: "Workflow evaluated.", ts: t + 5_000, attachments: [] },
  ];
}

// Two open approval cards of a dynamic workflow in the form the server writes (server/backend/electron/server/dynworkflows/approval.js),
// followed by the decisions the fixture already received.
const APPROVAL_CARDS = [
  { requestId: "11111111-1111-4111-8111-111111111111", name: "findings-check", description: "Zwei Befunde gegenlesen", phases: [{ title: "Lesen" }, { title: "Urteilen", detail: "je Befund" }] },
  { requestId: "22222222-2222-4222-8222-222222222222", name: "tests-views", description: "Collect red tests", phases: [{ title: "Collect" }] },
];
function workflowApprovalHistory() {
  const t = Date.now() - 60_000;
  const rows = [{ role: "user", text: "Check the findings and review the tests.", ts: t, attachments: [] }];
  APPROVAL_CARDS.forEach((k, i) => {
    rows.push({ role: "workflow_approval", text: JSON.stringify({ ...k, at: t + 1_000 + i }), ts: t + 1_000 + i, attachments: [] });
  });
  rows.push({ role: "assistant", text: "Both workflows are waiting for your approval.", ts: t + 2_000, attachments: [] });
  for (const [requestId, decision] of Object.entries(S.workflowApproval?.decide || {})) {
    rows.push({ role: "workflow_approval_ruling", text: JSON.stringify({ requestId, decision, at: t + 3_000 }), ts: t + 3_000, attachments: [] });
  }
  return rows;
}

function seededHistory() {
  if (S.seededRawEntries) return S.seededRawEntries;
  if (S.workflowMarkers) return workflowMarkersHistory();
  if (S.workflowApproval) return workflowApprovalHistory();
  const entries = [];
  if (S.seededInvisible) {
    // The history must FILL the window, otherwise it sits at the top and the distance to the composer says nothing about the
    // last row (a short history deliberately starts at the top).
    for (let index = 1; index <= 22; index += 1) {
      entries.push({
        role: "user",
        text: `Filler question ${index}`,
        ts: Date.now() - (40 - index) * 1_000,
        attachments: [],
      });
      entries.push({
        role: "assistant",
        text: `Filler answer ${index}`,
        ts: Date.now() - (40 - index) * 1_000 + 500,
        attachments: [],
      });
    }
    // A divider row ("Context compacted") belongs in this history: it is the message that was unreadable in light mode.
    entries.push({ role: "meta", text: JSON.stringify({ compacted: true }), ts: Date.now() - 10_000, attachments: [] });
    // And the AUTOMATIC compaction (`auto: true`) as a second divider: its wording must differ from the manual one ("Context
    // compacted automatically"). The row WITHOUT `auto` stays — `testCompactionDividerIsPresentAndVisible` hangs on it.
    entries.push({ role: "meta", text: JSON.stringify({ compacted: true, auto: true, at: Date.now() - 9_500, chars: 8167, percent: 60 }), ts: Date.now() - 9_500, attachments: [] });
    // Turn 1: visible answer. Turn 2: ONLY a TaskCreate — the assistant turn renders nothing. Turn 3: visible again, so the
    // distance is measurable between two visible messages.
    entries.push({ role: "user", text: "Sichtbare Frage 1", ts: Date.now() - 9_000, attachments: [] });
    entries.push({ role: "assistant", text: "Sichtbare Antwort 1", ts: Date.now() - 8_000, attachments: [] });
    entries.push({ role: "user", text: "Unsichtbarer Turn folgt", ts: Date.now() - 7_000, attachments: [] });
    entries.push({
      role: "tool",
      text: JSON.stringify({
        id: "fixture-taskcreate-1",
        name: "TaskCreate",
        input: { tasks: [{ id: "1", subject: "Only in the bar", status: "pending" }] },
      }),
      ts: Date.now() - 6_000,
      attachments: [],
    });
    entries.push({ role: "user", text: "Sichtbare Frage 2", ts: Date.now() - 5_000, attachments: [] });
    entries.push({ role: "assistant", text: "Sichtbare Antwort 2", ts: Date.now() - 4_000, attachments: [] });
    // And the same case as the LAST row: the user row separates the turn (otherwise the call would go into the existing
    // assistant bubble), then only a TaskCreate. So the chat ends in a row without content — it must not inflate the distance
    // to the composer.
    entries.push({ role: "user", text: "Letzte sichtbare Frage", ts: Date.now() - 3_000, attachments: [] });
    entries.push({
      role: "tool",
      text: JSON.stringify({
        id: "fixture-taskcreate-2",
        name: "TaskCreate",
        input: { tasks: [{ id: "2", subject: "Also only in the bar", status: "pending" }] },
      }),
      ts: Date.now() - 2_000,
      attachments: [],
    });
    return entries;
  }
  if (S.seededMarkdown) {
    // `count` rounds with the same Markdown message. With 1 (the clamped default) that is exactly the former history; larger
    // numbers build the LONG chat on which scrolling performance is measured — a chat of short "answer N" rows says nothing
    // about it, because only Markdown blocks make the cells expensive.
    for (let index = 1; index <= S.seededHistoryCount; index += 1) {
      const base = Date.now() - (S.seededHistoryCount - index + 1) * 2_000;
      entries.push({ role: "user", text: `What is the status? (${index})`, ts: base, attachments: [] });
      entries.push({ role: "assistant", text: MARKDOWN_SHOWCASE, ts: base + 1_000, attachments: [] });
    }
    return entries;
  }
  for (let index = 1; index <= S.seededHistoryCount; index += 1) {
    const userText = S.seededHistoryStress && index === 1
      ? `Infrastruktur-Anfrage-${"x".repeat(2_150)}`
      : `Verlauf Frage ${index}`;
    entries.push({
      role: "user",
      text: userText,
      ts: Date.now() - (S.seededHistoryCount - index + 1) * 2_000,
      attachments: [],
    });
    if (S.seededHistoryStress) {
      for (let toolIndex = 1; toolIndex <= 18; toolIndex += 1) {
        const id = `fixture-tool-${index}-${toolIndex}`;
        entries.push({
          role: "tool",
          text: JSON.stringify({
            id,
            name: "Bash",
            input: { command: `printf '${"wide".repeat(180)}'` },
          }),
          ts: Date.now() - (S.seededHistoryCount - index + 1) * 2_000 + toolIndex * 20,
          attachments: [],
        });
        entries.push({
          role: "tool_result",
          text: JSON.stringify({
            id,
            result: `${"lange Infrastruktur-Ausgabe ".repeat(310)}\n${"y".repeat(760)}`,
            isError: false,
          }),
          ts: Date.now() - (S.seededHistoryCount - index + 1) * 2_000 + toolIndex * 20 + 10,
          attachments: [],
        });
      }
    }
    entries.push({
      role: "assistant",
      text: S.seededHistoryStress && index === S.seededHistoryCount
        ? `Infrastruktur Abschluss ${index}`
        : `Verlauf Antwort ${index}`,
      ts: Date.now() - (S.seededHistoryCount - index + 1) * 2_000 + 1_000,
      attachments: [],
    });
  }
  return entries;
}

// The real server numbers every history row (column `id`); the app derives the STABLE identity of the row from it. The
// fixture must imitate that — otherwise the test would run on the fallback path (position instead of id) and never hit the
// actual logic.
function numbered(entries) {
  return entries.map((e, i) => ({ id: i + 1, ...e }));
}

// The history of the main chat as `GET …/log` delivers it: seeded history, channel, approval card, then the rows saved AFTER the
// start (`S.addenda` — stream run, gap, hint). ONE computation for `/log`, `/log/delta`, `connected` (`lastId`/`total`) and the
// row event: the reconcile of the app compares exactly these numbers.
function mainHistory() {
  return numbered([...seededHistory(), ...channelRows(chatId), ...approvalRows(chatId), ...S.addenda]);
}

// `lastId`/`total` for a `connected`: highest id and number of rows — as `store.messageStats`.
function historyStatus(rows) {
  return { lastId: rows.length ? rows[rows.length - 1].id : 0, total: rows.length };
}

// A run that streams text IN PIECES like the server and carries the part not yet stored (`S.runStreamText` = `runStreamText` in
// runs/do-run.js; `connected` carries it as `streamText`). The user row at the start and the answer at the end are stored
// (`S.addenda`) — so the reload at the end of the run (`joinedMidRun`) finds the whole answer.
//
// Three additions (one test each in ChatReconcileUITests): `cap` — the buffer stops at as many characters as RUN_STREAM_MAX,
// `connected` then reports `streamTextTruncated`; `error` — the run ends with `run_error` instead of `run_done` (without a
// stored answer); `followUp { text, parts }` — right after the end a follow-up turn starts (graph workflow, goal, queue).
function startStreamRun(firstText) {
  const { parts, gapMs, cap = 0, error = "", followUp = null } = S.runStream;
  S.runStreamText = "";
  S.runStreamFull = "";
  S.runStreamCap = cap;
  S.chat.updatedAt = Date.now();
  S.addenda.push({ role: "user", text: firstText, ts: Date.now(), attachments: [] });
  chatEvent({ type: "harness", subtype: "user_message", text: firstText, attachments: [] });
  chatEvent({ type: "harness", subtype: "run_started", provider: "claude", resume: false });
  globalEvent({ type: "run", chatId, running: true });
  parts.forEach((part, i) => schedule(gapMs * (i + 1), () => {
    S.runStreamFull += part;
    if (!cap || S.runStreamText.length < cap) S.runStreamText += part;
    chatEvent({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: part } } });
  }));
  schedule(gapMs * (parts.length + 1), () => {
    if (error) {
      chatEvent({ type: "harness", subtype: "run_error", code: "1", stderr: error });
    } else {
      S.addenda.push({ role: "assistant", text: S.runStreamFull, ts: Date.now(), attachments: [] });
      chatEvent({ type: "harness", subtype: "run_done" });
    }
    S.chat.updatedAt = Date.now();
    globalEvent({ type: "run", chatId, running: false, answered: !error });
    clearRun();
    if (followUp) {
      S.runStream = { parts: followUp.parts, gapMs };
      schedule(gapMs, () => {
        S.running = true;
        startStreamRun(followUp.text);
      });
    }
  });
}

function startFixtureRun(firstText) {
  clearRun();
  S.running = true;
  if (S.runStream) return startStreamRun(firstText);
  // Read once at the start of the run: the subagent branch AND the run length hang on it. A run with a subagent stays open
  // long so a test can scroll and check in peace.
  const withSubagent = S.subagentOnce;
  S.subagentOnce = false;
  const withWaitingAgent = S.waitingAgentOnce;
  S.waitingAgentOnce = false;
  const withNativeTasks = S.nativeTasksOnce;
  S.nativeTasksOnce = false;
  const withBackgroundAgent = S.backgroundAgentOnce;
  S.backgroundAgentOnce = false;
  const withAsk = S.askOnce;
  S.askOnce = false;
  const askQuestions = S.askQuestions === 3 ? ASK_QUESTIONS_THREE : ASK_QUESTIONS;
  S.askQuestions = 1;
  const withOpenCall = S.openCallOnce;
  S.openCallOnce = false;
  const openCallError = S.openCallError;
  S.openCallError = false;
  const withGroupTools = S.groupToolsOnce;
  S.groupToolsOnce = false;
  // The run of a question ends QUICKLY: the real agent ends its turn as soon as the card stands and waits for the choice (which
  // arrives as a new message).
  const runMs = withAsk ? 1_600
    : withGroupTools && S.groupToolsFast ? 3_500
    : withSubagent || withWaitingAgent || withBackgroundAgent || withOpenCall ? 60_000 : 10_000;
  S.chat.updatedAt = Date.now();
  chatEvent({ type: "harness", subtype: "user_message", text: firstText, attachments: [] });
  chatEvent({ type: "harness", subtype: "run_started", provider: "codex", resume: false });
  globalEvent({ type: "run", chatId, running: true });

  schedule(450, () => {
    chatEvent({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { usage: { input_tokens: 1200, cache_read_input_tokens: 300 } },
      },
    });
    chatEvent({
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", id: "fixture-todo", name: "TodoWrite", input: {} },
      },
    });
    if (withSubagent) {
      chatEvent({
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: { type: "tool_use", id: "fixture-subagent", name: "Task", input: {} },
        },
      });
      chatEvent({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "fixture-subagent",
            name: "Task",
            input: { description: "Fixture-Subagent", prompt: "work" },
          }],
        },
      });
      // Work INSIDE the subagent: a child call carries the id of the subagent call as `parent_tool_use_id`. It NEVER appears in
      // the history — it belongs to the steps in the agents sheet, checked by `testSubagentMarkerLeadsIntoTheSheet`.
      chatEvent({
        type: "assistant",
        parent_tool_use_id: "fixture-subagent",
        message: {
          content: [{
            type: "tool_use",
            id: "fixture-subagent-kind",
            name: "Bash",
            input: { command: "echo child-call-in-subagents" },
          }],
        },
      });
      chatEvent({
        type: "user",
        parent_tool_use_id: "fixture-subagent",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "fixture-subagent-kind",
            content: "child-call-in-subagents",
          }],
        },
      });
      // Deliberately NO tool_result for the subagent itself: it stays open as long as the run runs.
    }
    chatEvent({
      type: "assistant",
      message: {
        usage: { input_tokens: 1200, cache_read_input_tokens: 300 },
        content: [
          {
            type: "tool_use",
            id: "fixture-todo",
            name: "TodoWrite",
            input: {
              todos: [
                {
                  content: "Check queue behavior",
                  activeForm: "Fixture arbeitet",
                  status: "in_progress",
                },
                { content: "Take over follow-up message", status: "pending" },
              ],
            },
          },
        ],
      },
    });
  });

  if (withNativeTasks) {
    // The task list of the real Claude CLI: TaskCreate creates ONE task each (the id comes only in the tool_result), TaskUpdate
    // changes ONE each. The client must derive the list state from it — which went nowhere for years because it still waited
    // for TodoWrite.
    const task = (id, name, input, result) => {
      chatEvent({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
      chatEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: result }] } });
    };
    schedule(820, () => {
      task("fx-tc-1", "TaskCreate",
        { subject: "Zusammenfassung kürzen", description: "raise max_tokens", activeForm: "Kürze die Zusammenfassung" },
        "Task #1 created successfully: Zusammenfassung kürzen");
      task("fx-tc-2", "TaskCreate",
        { subject: "Lint und Tests laufen lassen", description: "black, isort, pylint", activeForm: "Lasse Lint und Tests laufen" },
        "Task #2 created successfully: Lint und Tests laufen lassen");
      task("fx-tc-3", "TaskCreate",
        { subject: "MR aufmachen", description: "against develop", activeForm: "Mache den MR auf" },
        "Task #3 created successfully: MR aufmachen");
      // First one done, second running: so one can check that finished work disappears from the bar (and stays only as a
      // counter) and the running one stands in its progressive form.
      task("fx-tu-1", "TaskUpdate", { taskId: "1", status: "completed" }, "Updated task #1 status");
      task("fx-tu-2", "TaskUpdate", { taskId: "2", status: "in_progress" }, "Updated task #2 status");
    });
  }

  if (withBackgroundAgent) {
    // The situation of the agents sheet in ONE turn: one subagent is FINISHED (its report stands as a tool result in the
    // history — from that, and only that, the sheet builds its "Finished" group), one keeps RUNNING. The running one arrives
    // via the `background` event in the form of the contract: taskId, agentId, description, name, provider, model, status,
    // startedAt, tokens, tokenKind, toolUses.
    const agentsStart = Date.now();
    // `tokenKind: "only_output"` (Codex and the loop engine report only the output): the display must say so ("at least …"),
    // otherwise an understated number cannot be told from a complete one.
    const running = (step) => ({
      taskId: "fixture-bg-1",
      agentId: "fixture-bg-1",
      description: "Compose-Dienste prüfen",
      name: "agent-compose",
      provider: "codex",
      model: "gpt-5.4-mini",
      status: "running",
      startedAt: agentsStart,
      // GROWING: the sheet computes its pace from two measuring points. A value that stayed 0 until the end (rec.usage instead
      // of rec.tally) would show up here.
      tokens: 3200 + step * 1450,
      tokenKind: "only_output",
      toolUses: 2 + step,
      // A foreground agent carries the marker until the button sends it to the background.
      ...(S.backgroundAgentForeground ? { foreground: true } : {}),
    });
    const sendAgents = (step) => {
      chatEvent({ type: "harness", subtype: "background", monitors: [], tasks: [], wakeupAt: 0, agents: [running(step)] });
    };
    // The report of the FINISHED one: exactly the fields from which the sheet takes its numbers.
    const report = {
      status: "completed",
      agentId: "fixture-agent-finished",
      name: "agent-repos",
      description: "Repos durchsuchen",
      agentType: "general-purpose",
      provider: "claude",
      resolvedModel: "claude-haiku-4-5-20251001",
      report: "report-of-the-finished-subagents",
      totalTokens: 48200,
      totalToolUseCount: 7,
      totalDurationMs: 96_000,
    };
    schedule(500, () => {
      chatEvent({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "fixture-agent-finished", name: "mcp__cbase__cbase_agent", input: { description: "Repos durchsuchen", prompt: "search" } }] },
      });
      // Its steps carry `parent_tool_use_id` — they belong in the sheet, not in the history.
      chatEvent({
        type: "assistant",
        parent_tool_use_id: "fixture-agent-finished",
        message: { content: [{ type: "tool_use", id: "fixture-agent-finished-kind", name: "Bash", input: { command: "echo kind-of-the-finished" } }] },
      });
      chatEvent({
        type: "user",
        parent_tool_use_id: "fixture-agent-finished",
        message: { content: [{ type: "tool_result", tool_use_id: "fixture-agent-finished-kind", content: "kind-of-the-finished" }] },
      });
      chatEvent({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "fixture-agent-finished", content: JSON.stringify(report, null, 2), is_error: false }] },
      });
      // As the real CLI: the background call is acknowledged at once, the main agent keeps working — only the `background` event
      // reveals that one is still running.
      chatEvent({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "fixture-bg-1", name: "mcp__cbase__cbase_agent", input: { description: "Compose-Dienste prüfen", run_in_background: true } }] },
      });
      chatEvent({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "fixture-bg-1", content: "Async agent launched successfully.", is_error: false }] },
      });
      sendAgents(0);
    });
    // 20 steps = 30.5 s of growth: the test reads its start value right after opening the sheet and a series of checks; with
    // fewer steps the last update came close to the read time, and the promise "the tokens grow" hung on the clock. The longer
    // series is the reserve. `runMs` stays 60 s; no user of this seed waits for the end of the run.
    for (let i = 1; i <= 20; i++) schedule(500 + i * 1500, () => sendAgents(i));
  }

  if (withGroupTools) {
    // Two calls of the same kind in a row → the client shows a group row ("2 shell commands executed") that stays open during
    // the run. The results are long enough that collapsing at the end of the turn changes the row height clearly.
    const shell = (id, command, result) => {
      chatEvent({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
      chatEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: result, is_error: false }] } });
    };
    schedule(600, () => {
      shell("fx-sh-1", "docker compose ps",
        "NAME            STATUS\nweb             Up 3 hours\nworker          Up 3 hours\nredis           Up 3 hours");
      shell("fx-sh-2", "git status --short",
        " M server/app.py\n M web/src/page.tsx\n?? notes/draft.md");
    });
  }

  if (withAsk) {
    // As the real server: tool call, then the card, then the tool result (whose row comes AFTER the card — the call
    // otherwise stayed "running" forever).
    schedule(700, () => {
      chatEvent({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "fixture-ask-tool", name: "mcp__cbase__cbase_ask", input: { questions: askQuestions } }] },
      });
      chatEvent({ type: "harness", subtype: "ask_request", requestId: ASK_REQUEST_ID, questions: askQuestions });
      chatEvent({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "fixture-ask-tool", content: "{\"ok\":true}", is_error: false }] },
      });
    });
  }

  if (withOpenCall) {
    // Two Bash calls in a row (a group row); the second stays without a result as long as the run runs — so the spinner of
    // the row has a reason to turn.
    schedule(500, () => {
      chatEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "fx-open-1", name: "Bash", input: { command: "echo ready" } }] } });
      // With `error` the first one fails: the running row then carries the red counter.
      chatEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "fx-open-1", content: openCallError ? "Exit code 1" : "ready", is_error: openCallError }] } });
      chatEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "fx-open-2", name: "Bash", input: { command: "sleep 60" } }] } });
    });
  }

  if (withWaitingAgent) {
    // As the real server when the turn ends while something still runs in the background. Which of the four reasons is
    // reported is steered by /fixture/waiting-agent via `kind`. The FOUR counter-probe switches
    // (`/fixture/waiting-agent-counter-probe`: `empty`, `event`, `descriptionEmpty`, `mixed`) do NOT belong to the tests of the
    // waiting phase: `empty` reports it without content, `background` instead of `run_waiting` lets the turn keep running
    // (the app then does not set `waiting`, the run row stays), `descriptionEmpty` takes the description from the task,
    // `mixed` adds a subagent on top. All four STICK — `assertWaitingState` reads them beforehand and names a leftover.
    schedule(900, () => {
      const waiting = { type: "harness", subtype: S.waitingAgentEvent, monitors: [], agents: [], tasks: [], wakeupAt: 0 };
      if (S.waitingAgentEmpty) {
        // Counter-test: leave everything empty.
      } else if (S.waitingAgentKind === "task") {
        // `descriptionEmpty`: the same task without a description — the number in the chip still matches, the sheet says
        // "No description".
        waiting.tasks = [{ taskId: "fixture-bg-task", description: S.waitingAgentDescriptionEmpty ? "" : "Auf den E2E-Run warten" }];
      } else if (S.waitingAgentKind === "wakeup") {
        // Full minute, as the real CLI schedules it.
        waiting.wakeupAt = Math.ceil((Date.now() + 20 * 60_000) / 60_000) * 60_000;
      } else {
        waiting.agents = [{ taskId: "fixture-bg-agent", description: "Second review round" }];
      }
      // Counter-probe `mixed`: a subagent ON TOP — with `task`/`wakeup` the exclusion rows of the helper must trigger (the
      // dot of the header then stands).
      if (S.waitingAgentMixed && !waiting.agents.length) {
        waiting.agents = [{ taskId: "fixture-bg-agent", description: "Second review round" }];
      }
      chatEvent(waiting);
    });
  }

  schedule(750, () => {
    chatEvent({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "fixture-todo",
            content: "Fixture ready",
            is_error: false,
          },
        ],
      },
    });
    chatEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: "Erste Antwort.\n\n[cbase-Link](https://example.com)",
        },
      },
    });
    chatEvent({
      type: "stream_event",
      event: { type: "message_delta", usage: { output_tokens: 24 } },
    });
  });

  // XCUI text entry on the simulator is deliberately slow. The first turn stays open long enough for the test to type
  // realistically into the running run.
  schedule(runMs, () => {
    const next = S.queue.shift();
    if (!next) {
      chatEvent({ type: "harness", subtype: "run_done" });
      globalEvent({ type: "run", chatId, running: false, answered: true });
      clearRun();
      return;
    }
    chatEvent({
      type: "harness",
      subtype: "message_injected",
      id: next.id,
      text: next.text,
      attachments: [],
      queued: publicQueue(),
    });
    schedule(450, () => {
      chatEvent({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Zweite Antwort." },
        },
      });
      chatEvent({
        type: "stream_event",
        event: { type: "message_delta", usage: { output_tokens: 42 } },
      });
    });
    schedule(1_100, () => {
      S.chat.contextTokens = 1542;
      S.chat.updatedAt = Date.now();
      chatEvent({ type: "harness", subtype: "run_done" });
      globalEvent({ type: "run", chatId, running: false, answered: true });
      clearRun();
    });
  });
}
// The seed of the progress tree (see `S.dynTree`) in the form of the server's view (dynworkflows/tree.js treeView). "running": a
// running run with three phases and every state, plus a finished one (collapsed). "karg": a run of ONLY the mandatory fields
// (run id, agent list) — without log() lines, phases, tokens, model.
function dynTreeSeed(kind) {
  const agent = (n, label, phase, status, extra = {}) => ({ n, label, phase, status, provider: "claude", model: "claude-opus-5-5", effort: "high", agentId: `wa-${n}`, ...extra });
  if (kind === "karg") {
    return {
      runs: [{ runId: "wf_tree0003", name: "karg", status: "running", agents: [{ n: 1, label: "Mandatory only", status: "running" }, { n: 2, status: "waiting" }] }],
      transcripts: {}, stops: [], interventions: [],
    };
  }
  const running = {
    runId: "wf_tree0001", taskId: "wbaum1", name: "findings-check", status: "running", stoppedOf: "", error: "",
    startedAt: Date.now() - 60000, endedAt: null, phase: "Prüfen", phases: ["Lesen", "Prüfen", "Report"],
    agents: [
      agent(1, "Quellen lesen", "Lesen", "finished", { tokens: 18400, tokenKind: "full" }),
      agent(2, "Tests lesen", "Lesen", "skipped", { model: "claude-sonnet-5", tokens: 2100, tokenKind: "full" }),
      agent(3, "Befund A prüfen", "Prüfen", "running", { provider: "codex", model: "gpt-5.6-sol", tokens: 5300, tokenKind: "only_output" }),
      agent(4, "Befund B prüfen", "Prüfen", "waiting", { reason: "cap", cap: "run", agentId: "" }),
      agent(5, "Befund C prüfen", "Prüfen", "error", { tokens: 900, tokenKind: "full" }),
    ],
    logs: ["3 Quellen gefunden", "Tests übersprungen", "Prüfen beginnt", "Befund A läuft", "Befund B wartet"].map((text, i) => ({ text, phase: i < 2 ? "Lesen" : "Prüfen", at: Date.now() - 50000 + i })),
    logsTruncated: 0,
  };
  const finished = {
    runId: "wf_tree0002", taskId: "wbaum2", name: "daily-report", status: "finished", stoppedOf: "", error: "",
    startedAt: Date.now() - 3600000, endedAt: Date.now() - 3000000, phase: "Sammeln", phases: ["Sammeln"],
    agents: [agent(1, "Tag sammeln", "Sammeln", "finished", { tokens: 4000, tokenKind: "full" })], logs: [], logsTruncated: 0,
  };
  return {
    runs: [running, finished], additional: 0, stops: [], interventions: [],
    transcripts: {
      "wf_tree0001#1": [
        { kind: "job", text: "Read the sources under src/ and summarize them." },
        { kind: "thinking", text: "First the entry file." },
        { kind: "tool", id: "tu-dyn-1", name: "Read", input: { file_path: "src/app.ts" } },
        { kind: "tool-result", id: "tu-dyn-1", text: "export const app = 1;", error: false },
        { kind: "text", text: "Three sources read." },
      ],
    },
  };
}

export { MARKDOWN_SHOWCASE, dynTreeSeed, seededHistory, numbered, mainHistory, historyStatus, startFixtureRun };
