// History types and the log → bubbles reconstruction, plus the streaming reducer (second part below). A LEAF MODULE without
// React: types via `@/…` (erased on compile), values relative with `.js` ending. `clockTime` lives in lib/chat-format.ts.
import { type Attachment, type LogEntry, type WorkflowRun } from "@/lib/api";
import { type Block } from "@/components/AssistantBlocks";
import { type LimitLine } from "@/components/LimitStrip";
import { type AskAnswer, type AskQuestion } from "@/components/AskCard";
import { type CaptureMessage } from "@/components/CaptureCard";
import { type ChannelCardData, type OverChannel } from "@/components/ChannelCard";
import { type ApprovalRuling, type ApprovalCardData } from "@/components/ApprovalCard";
import { applyToolInput, applyToolResult, mutateUnderParent } from "../../lib/tool-result.js";
import { missingBeginning } from "../../lib/stream.js";
import { withChannelCard } from "../../lib/channel-card.js";
import { finishedRow, completionNoticeDuplicate, isCompletionNotice } from "../../lib/completionNotice.js";
import { messageCard, type InboundAgentMessage } from "../../lib/agents-message.js";
import { hintSeparator, type SeparatorKind } from "../../lib/hint.js";
import { rememberRow } from "../../lib/bubbles-key.js";
import { rememberTime, passOnTimes } from "../../lib/day-separator.js";
import { appendRow } from "../../lib/history-reconcile.js";
import { MARKER_ROLE, markerSeparator, type WorkflowMarker } from "../../lib/workflow-marker.js";
import { RULING_ROLE, APPROVAL_ROLE, readWorkflowRuling, readWorkflowApproval, type WorkflowDecision, type WorkflowApproval } from "../../lib/workflow-approval.js";

interface RunSummary {
  secs: number;
  inTok: number;
  outTok: number;
  aborted?: boolean; // run was aborted by the user
  at?: number; // end of the run (ms): the clock time behind the metrics; from `ts` of the meta row, or live `ctx.now`
}
interface QueuedMessage {
  id: string;
  text: string;
  controllable?: boolean;
  systemNotice?: boolean; // the queued completion notice of a subagent (lib/completionNotice.ts)
}
// The usage-limit line (`LimitLine`) and its strip live in components/LimitStrip.tsx.

// One line of the workflow driver in the history (start, step, branch verdict, question, skipped, end), rendered live over
// SSE and identically from the persisted history.
interface WorkflowLine {
  kind: "trigger" | "start" | "step" | "decision" | "loop" | "ask" | "review" | "skip" | "cap" | "command" | "gate" | "end";
  name?: string;
  command?: string;  // only kind "command": the slash command run before the node
  native?: boolean;  // only kind "command": run by the harness itself (not handed to the agent)
  source?: string; // only kind "trigger": the external system (gitlab)
  event?: { kind: string; summary: string; url: string; project: string; author: string };
  title?: string;
  text?: string;
  note?: string;
  step?: number;
  total?: number;
  approx?: boolean;
  count?: number;
  yes?: boolean;
  status?: string;
  type?: string;
  rounds?: number;   // only kind "cap": rounds this step has run
  cap?: number;      // only kind "cap": allowed rounds
  granted?: number;  // only kind "cap": rounds granted afterwards ("continue")
  auto?: boolean;    // kind "cap"/"gate": checkmark "without asking": the run moved on
  done?: boolean;    // only kind "gate": verdict of the completion gate
  max?: number;      // only kind "gate": allowed rounds of the gate
  verdict?: "ok" | "issues"; // only kind "review": the user's verdict (without = the request itself)
  round?: number;    // kind "review": which review round; kind "gate": which gate round
  loop?: { index: number; total: number; item: string };
}
// A question from the agent with clickable answer options (tool cbase_ask). It stands as its own line in the history
// (persisted as role='ask'; the choice as role='ask_answer').
interface AskBubble {
  requestId: string;
  questions: AskQuestion[];
  answers?: AskAnswer[] | null; // set = answered
  answerable: boolean;          // still clickable (unanswered AND no later message)
  overChannel?: OverChannel | null; // answered over a channel
}
interface Bubble {
  role: "user" | "assistant" | "divider" | "clear" | "info" | "goal" | "monitor" | "workflow" | "limit" | "ask" | "capture" | "channel" | "approval" | "workflow_approval" | "message";
  blocks: Block[];
  ask?: AskBubble; // only role "ask"
  channel?: ChannelCardData; // only role "channel": a message from a channel between chats
  message?: InboundAgentMessage; // only role "message": a message from an agent (lib/agents-message.ts)
  approval?: ApprovalCardData; // only role "approval": tool approval with ruling, persisted
  wfApproval?: WorkflowApproval; // only role "workflow_approval": approval card of a dynamic workflow
  capture?: CaptureMessage; // only role "capture": capture by an agent, shown at turn end (server/chats/captures-show.js)
  wf?: WorkflowLine; // only role "workflow"
  limit?: LimitLine; // only role "limit"
  attachments?: Attachment[];
  streaming?: boolean;
  summary?: RunSummary; // duration + tokens of this run (persisted, attached to the reply)
  labelParams?: Record<string, string>; // parameters of the translatable divider text (completion notice: the agent's name)
  kind?: SeparatorKind; // only role "divider": completion notice, hint line or workflow marker; without = the compaction
  marker?: WorkflowMarker; // only kind "workflow-start"/"workflow-end": the marker of the dynamic workflow
  label?: string; // divider text, or title of an info block (/cost, /help), or judge note (goal), or monitor description
  achieved?: boolean; // only role "goal": verdict of the goal check
  turns?: number; // only role "goal" (achieved): how many runs the goal took
  continuing?: string; // only role "goal" (open): "1/3": the harness continues automatically
  event?: string; // only role "monitor": started | fired | done
  status?: string; // only role "monitor" (done/fired): task status (completed/failed/…)
  dimmed?: boolean; // everything before the last /clear stays visible but recedes visually
  clearedAt?: number; // dedupes the HTTP response and the parallel SSE event
  rowId?: number; // only from the event `row`: the log row, against duplicates and for the reconcile
  // Only on a stored reply that the stream reopened (`openResponse`): this many blocks were already there; what comes behind
  // came live. The reconcile (lib/history-reconcile.ts `withLiveTail`) folds only this part into the rows.
  liveFrom?: number;
}

// Reconstruct the history from the persisted log rows EXACTLY as the live stream builds it: user rows as their own blocks;
// assistant, thinking, tool and tool_result rows of a run into ONE assistant entry; tool results/diffs/thinking blocks are
// carried along, subagent calls (parent) nested. meta rows supply the duration/token summary of their reply.
//
// Deliberately at module level and pure: the chat cache rebuilds the history with it after fetching a delta, without
// knowing ChatPane's state.
function buildBubbles(log: LogEntry[]): Bubble[] {
  type ToolBlk = Extract<Block, { kind: "tool" }>;
  const bs: Bubble[] = [];
  const toolById = new Map<string, ToolBlk>(); // id → tool block (also nested) for result assignment
  const ensureAssistant = (): Bubble => {
    let cur = bs[bs.length - 1];
    if (!cur || cur.role !== "assistant") { cur = { role: "assistant", blocks: [] }; bs.push(cur); }
    return cur;
  };
  // A row that can carry a parent call (text, thinking, tool): without a parent into the reply, with a known parent under its
  // block, and with an UNKNOWN parent (e.g. because a compaction lost the call row) dropped, as in the live stream
  // (`mutateBlocks` below) and on iOS. Putting it "into the bubble rather than lost" would leak into a foreign reply, and a
  // reload would show something other than the stream. `true` means: filed.
  const underParent = (parent: string | null, block: Block): boolean => {
    if (!parent) { ensureAssistant().blocks.push(block); return true; }
    const p = toolById.get(parent);
    if (!p) return false;
    (p.children ??= []).push(block);
    return true;
  };
  // Question cards: the answer stands as its own row (role='ask_answer') AFTER the question, and a user message after it makes
  // the card inert (the same rule as on the server). EXCEPTION while a workflow runs (row kind='start' without 'end'): there
  // the card survives an INTERIM question by the user, because the server holds the step on it (openAskOf). Without this
  // exception the card would look dead although the run waits on exactly it.
  const askByRequest = new Map<string, AskBubble>();
  const closeAsks = () => { for (const a of askByRequest.values()) a.answerable = false; };
  // Approval cards: the coding chat persists its tool approvals — the card as row `approval`, the ruling as `approval_ruling`.
  // Otherwise the card would be ephemeral (only in the event stream), and after a reload nothing would show what had been
  // approved or denied.
  const approvalByRequest = new Map<string, ApprovalCardData>();
  // Approval cards of a dynamic workflow: card and ruling under their OWN roles, open until the ruling; no message closes it
  // (lib/workflow-approval.ts).
  const wfApprovalByRequest = new Map<string, WorkflowApproval>();
  let runOpen = false;
  // Every bubble reports the log row it came from (lib/bubbles-key.ts: the key of the height memory by content instead of
  // position). Reported at the head of the NEXT row (and after the loop), so every `push` of this row counts, also behind a
  // `continue`, without a branch having to do it. Likewise the TIME of the row (lib/day-separator.ts), at the same hook.
  let fromRow = 0;
  let ofTime: unknown = 0;
  let fromBubble = 0;
  const report = () => { for (let k = fromBubble; k < bs.length; k++) { rememberRow(bs[k], fromRow); rememberTime(bs[k], ofTime); } };
  for (const e of log) {
    report();
    fromRow = e.id;
    ofTime = e.ts;
    fromBubble = bs.length;
    const message = e.role === "user" ? messageCard(e.text) : null;
    if (message) {
      // The third kind under the role user: the message of an agent is a card, not a user bubble, and closes no question;
      // nobody wrote anything here.
      bs.push({ role: "message", blocks: [], message });
    } else if (e.role === "user" && isCompletionNotice(e.text)) {
      // Two kinds under one role: the completion notice of a subagent is a system message, a line, no user bubble, and it
      // closes no question (nobody wrote anything). Directly behind the end marker of its workflow it is dropped
      // (lib/completionNotice.ts, `completionNoticeDuplicate`).
      if (!completionNoticeDuplicate(bs[bs.length - 1], e.text)) bs.push(finishedBubble(e.text));
    } else if (e.role === "user") {
      if (!runOpen) closeAsks();
      bs.push({ role: "user", blocks: [{ kind: "text", text: e.text }], attachments: e.attachments ?? undefined });
    } else if (e.role === "ask") {
      try {
        const a = JSON.parse(e.text);
        const requestId = String(a.requestId || "");
        if (!requestId) continue;
        closeAsks();
        const ask: AskBubble = { requestId, questions: (a.questions ?? []) as AskQuestion[], answerable: true };
        askByRequest.set(requestId, ask);
        bs.push({ role: "ask", blocks: [], ask });
      } catch { /* skip broken row */ }
    } else if (e.role === "ask_answer") {
      try {
        const a = JSON.parse(e.text);
        const ask = askByRequest.get(String(a.requestId || ""));
        if (ask) { ask.answers = (a.answers ?? []) as AskAnswer[]; ask.answerable = false; ask.overChannel = a.overChannel ?? null; }
      } catch { /* skip broken row */ }
    } else if (e.role === "approval") {
      try {
        const f = JSON.parse(e.text);
        const requestId = String(f.requestId || "");
        if (!requestId) continue;
        const card: ApprovalCardData = {
          requestId, toolName: String(f.toolName || ""), server: String(f.server || ""), tool: String(f.tool || f.toolName || ""),
          description: String(f.description || ""), writing: typeof f.writing === "boolean" ? f.writing : null,
          input: (f.input ?? {}) as Record<string, unknown>, at: Number(f.at) || Number(e.ts) || Date.now(), ruling: null, open: true,
          coding: Boolean(f.coding),
        };
        approvalByRequest.set(requestId, card);
        bs.push({ role: "approval", blocks: [], approval: card });
      } catch { /* skip broken row */ }
    } else if (e.role === "approval_ruling") {
      try {
        const f = JSON.parse(e.text);
        const card = approvalByRequest.get(String(f.requestId || ""));
        if (card) {
          card.ruling = {
            behavior: f.behavior === "allow" ? "allow" : "deny", reason: String(f.reason || ""), origin: String(f.origin || "user"),
            updatedInput: (f.updatedInput ?? null) as Record<string, unknown> | null, at: Number(f.at) || Number(e.ts) || Date.now(),
            ...(typeof f.remember === "string" && f.remember ? { remember: f.remember } : {}),
          };
          card.open = false;
        }
      } catch { /* skip broken row */ }
    } else if (e.role === "channel") {
      // Channel card: a message from a channel between chats; not a user row, so it closes no open question (the delivery over
      // the channel answers it explicitly instead, see ask_answer with overChannel).
      try { bs.push({ role: "channel", blocks: [], channel: JSON.parse(e.text) as ChannelCardData }); }
      catch { /* skip broken row */ }
    } else if (e.role === "capture") {
      // Capture card: screenshot/video of an agent, shown at turn end.
      try { bs.push({ role: "capture", blocks: [], capture: JSON.parse(e.text) as CaptureMessage }); }
      catch { /* skip broken row */ }
    } else if (e.role === "clear") {
      closeAsks();
      let clearedAt = e.ts;
      try { clearedAt = Number(JSON.parse(e.text).at) || e.ts; } catch {}
      for (const bubble of bs) bubble.dimmed = true;
      bs.push({ role: "clear", blocks: [], label: "Chat cleared up to here", clearedAt });
    } else if (e.role === "hint") {
      // Hint line of the server, already written in the interface language, e.g. "Thinking level now medium (before: none)".
      // As a separator with its own kind (`kind: "hint"`), the same switch as elsewhere (lib/hint.ts).
      const h = hintSeparator(e.text);
      if (h) bs.push(h);
    } else if (e.role === APPROVAL_ROLE) {
      const k = readWorkflowApproval(e.text);
      if (k && !wfApprovalByRequest.has(k.requestId)) { wfApprovalByRequest.set(k.requestId, k); bs.push({ role: "workflow_approval", blocks: [], wfApproval: k }); }
    } else if (e.role === RULING_ROLE) {
      const d = readWorkflowRuling(e.text);
      const k = d ? wfApprovalByRequest.get(d.requestId) : undefined;
      if (d && k && !k.decision) k.decision = d.decision; // the FIRST ruling counts (as on the server)
    } else if (e.role === MARKER_ROLE) {
      // Start and end marker of a dynamic workflow: own role, as a separator with its own kind; hangs on no parent block,
      // closes no question, begins no reply. Live: `pushMarker` below.
      const m = markerSeparator(e.text);
      if (m) bs.push(m);
    } else if (e.role === "meta") {
      let parsed: RunSummary & { compacted?: boolean; auto?: boolean } = { secs: 0, inTok: 0, outTok: 0 };
      try { parsed = JSON.parse(e.text); } catch {}
      if (parsed.compacted) {
        // `auto`: cbase compacted by itself (level reached); without the word the separator would read like a click nobody made.
        bs.push({ role: "divider", blocks: [], label: parsed.auto ? "Context compacted automatically" : "Context compacted" });
      } else {
        const last = bs[bs.length - 1];
        if (last?.role === "assistant") last.summary = { ...parsed, at: Number(e.ts) || undefined };
      }
    } else if (e.role === "assistant") {
      ensureAssistant().blocks.push({ kind: "text", text: e.text });
    } else if (e.role === "thinking") {
      let text = "";
      let parent: string | null = null;
      try { const t = JSON.parse(e.text); text = String(t.text ?? ""); parent = t.parent ?? null; } catch { text = e.text; }
      if (!text.trim()) continue;
      underParent(parent, { kind: "thinking", text });
    } else if (e.role === "sub_text") {
      // Intermediate text of a subagent: belongs under its call block (shown behind the fold there), NOT in the main reply. If
      // the parent block is missing it drops (`underParent`).
      let text = "";
      let parent: string | null = null;
      try { const t = JSON.parse(e.text); text = String(t.text ?? ""); parent = t.parent ?? null; } catch { text = e.text; }
      if (!text.trim()) continue;
      underParent(parent, { kind: "text", text });
    } else if (e.role === "tool") {
      let name = "", detail = "", parent: string | null = null;
      let tid: string | undefined;
      let input: Record<string, unknown> | undefined;
      try {
        const t = JSON.parse(e.text);
        name = String(t.name ?? "");
        detail = String(t.detail ?? "");
        tid = t.id ? String(t.id) : undefined;
        parent = t.parent ?? null;
        if (t.input && typeof t.input === "object") input = t.input as Record<string, unknown>;
      } catch {}
      if (!name) continue;
      const block: ToolBlk = { kind: "tool", id: tid, name, detail, count: 1, input };
      // A dropped call is not registered: its children and its result find it as little as in the live stream (there
      // `mutateUnderParent` looks for a block that was never created).
      if (underParent(parent, block) && tid) toolById.set(tid, block);
    } else if (e.role === "tool_result") {
      try {
        const t = JSON.parse(e.text);
        const tb = t.id ? toolById.get(String(t.id)) : null;
        if (tb) { tb.result = String(t.result ?? ""); tb.resultIsError = Boolean(t.isError); tb.done = true; if (e.truncated) tb.truncated = e.id; }
      } catch {}
    } else if (e.role === "goal") {
      // Persisted verdict of the goal gate → a row at this place of the history.
      try {
        const g = JSON.parse(e.text);
        bs.push({
          role: "goal", blocks: [], achieved: g.achieved === true, label: String(g.note || ""),
          turns: typeof g.turns === "number" ? g.turns : undefined,
          continuing: g.continuing && g.attempt != null ? `${g.attempt}/${g.max}` : undefined,
        });
      } catch {}
    } else if (e.role === "monitor") {
      // Persisted monitor lifecycle (started/fired/ended) → a row in the history.
      try {
        const g = JSON.parse(e.text);
        bs.push({ role: "monitor", blocks: [], event: String(g.event || ""), label: String(g.description || ""), status: g.status ? String(g.status) : undefined });
      } catch {}
    } else if (e.role === "workflow") {
      // Persisted row of the workflow driver (step head, verdict, end …).
      try {
        const line = JSON.parse(e.text) as WorkflowLine;
        // Run window for the card exception above. When the run ends the normal rule applies again, and a card still open is done.
        if (line.kind === "start") runOpen = true;
        else if (line.kind === "end") { runOpen = false; closeAsks(); }
        bs.push({ role: "workflow", blocks: [], wf: line });
      } catch { /* skip broken row */ }
    } else if (e.role === "limit") {
      // Persisted usage-limit row (parked / resumed / aborted).
      try { bs.push({ role: "limit", blocks: [], limit: JSON.parse(e.text) as LimitLine }); } catch {}
    }
  }
  report();
  return bs;
}

// ── Streaming reducer ──
// The mutators of the live stream and the event switch `onEvent` as PURE functions: no setState, no ref, no fetch, no
// Date.now(). What the switch read from refs in ChatPane (streamRef, wfRunRef, runStartRef, inTokensRef, outTokensRef,
// joinedMidRunRef, activeIdRef) and from the clock comes in as the `ReducerCtx` snapshot, taken AT THE TIME OF THE EVENT,
// before any ref mutation of the same switch. The wrapper in ChatPane calls `setBubbles((prev) => reduceChatEvent(prev, evt,
// ctx))`, writes `streamRef.current = streamAfterEvent(evt, ctx)` and keeps the side effects per event kind (setBusy,
// setStreamingText, reload, cache).
//
// Two seams against the component code:
//  1. `setBubbles((prev) => …)` became `(bubbles, …): Bubble[]`: every mutator takes the list and returns the new one; in the
//     switch `bubbles = mutator(bubbles, …)` is passed on.
//  2. `streamRef.current` became `st`, the local copy of ctx.stream that `apply` creates: the same assignments
//     (`streamRef.current = X` → `Object.assign(st, X)`, `.open = false` → `st.open = false`) on the copy. The stream state
//     hangs on no bubble (every assignment is a constant or a function of `st` alone), so `streamAfterEvent` returns it without
//     the bubbles, and the wrapper writes it AT ONCE (not at render, which React batches and computes twice in StrictMode).
// Two timing seams: `mutateBlocks` read `streamRef.current.open` when the updater RAN (render time) and `closeAsksOnUserText`
// the workflow status likewise; now both at the time of the event. Between event and render only another event changes them,
// and its run closes a bubble created that way anyway (finish/push*). Measured on the DOM: a recording of the drawn
// bubbles in a real browser, compared before and after.
// Leaf module: values come relative with `.js` ending (lib/tool-result, lib/stream, lib/channel-card), types via `@/…`;
// web/test/reducer.test.mjs compiles the file with `tsc --noCheck --isolatedModules` without a tsconfig, and a type import
// without a value is dropped (like lib/api in global-events.test.mjs).

// State of the live stream.
interface StreamState {
  open: boolean;    // a reply bubble is open (streaming: true)
  gotText: boolean; // the main stream delivered text in this bubble (result fallback at turn end)
}
// An event of the chat stream (the `data:` body), unchanged as it arrives.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChatEvent = Record<string, any>;
// What the reducer must know besides bubbles and event: the wrapper's snapshot (see above).
interface ReducerCtx {
  stream: StreamState;                          // streamRef.current; not modified, `apply` copies
  now: number;                                  // Date.now(): run-time summary, approval fallback, /clear
  wfStatus: WorkflowRun["status"] | undefined;  // wfRunRef.current?.status: during a run the question card stays clickable
  activeId: string | null;                      // activeIdRef.current: with `joined` ⇒ history is reloaded, no summary
  joined: boolean;                              // joinedMidRunRef.current
  runStart: number | null;                      // runStartRef.current: null ⇒ no summary
  inTok: number;                                // inTokensRef.current
  outTok: number;                               // outTokensRef.current
  // Two language helpers from lib/i18n (which needs React; this module does not): the error text of run_error (useT) and the
  // text form of a tool_result (AssistantBlocks.resultToText, translates "[image]").
  t: (key: string, params?: Record<string, string | number>) => string;
  resultToText: (content: unknown) => string;
  // Highest row id the client knows (cache entry of the open chat): a `row` event below it already stands in the history. If
  // absent it counts as 0: every row that is not there yet is appended.
  lastId?: number;
}

function startAssistant(bubbles: Bubble[], st: StreamState): Bubble[] {
  Object.assign(st, { open: true, gotText: false });
  return [...bubbles, { role: "assistant", blocks: [], streaming: true }];
}

// Content WITHOUT a parent while the stream is CLOSED. The stream is closed mid-turn exactly when this client did not see
// `run_started` or the turn boundary: the chat was opened mid-run (open() resets the stream, `connected` opens it only with
// buffer text) or a reconcile rebuilt the bubbles from the rows. Then the last bubble is the STORED reply of this turn, and
// `startAssistant` would put a second one beside it, while the history (`buildBubbles`, `ensureAssistant`) appends the same rows
// to the last reply. Hence the same rule: if the last bubble is a reply, it becomes the open one again; only a pure error
// bubble (`addError`, in no row) stays closed. The stream state is the same as after `startAssistant` (`streamAfterEvent`
// computes without bubbles).
const onlyError = (b: Bubble): boolean => b.blocks.length > 0 && b.blocks.every((bl) => bl.kind === "error");
function openResponse(bubbles: Bubble[], st: StreamState): Bubble[] {
  const last = bubbles[bubbles.length - 1];
  if (last?.role !== "assistant" || onlyError(last)) return startAssistant(bubbles, st);
  Object.assign(st, { open: true, gotText: false });
  return last.streaming ? bubbles : [...bubbles.slice(0, -1), { ...last, streaming: true, liveFrom: last.blocks.length }];
}

// A prompt queued on the server was taken into the same logical run: close the previous reply and create the user→assistant
// boundary atomically before new provider events arrive, so follow-up turns land neither in the old assistant nor by mistake in
// the user bubble. (setStreamingText(false) → wrapper.)
// The system line of a completion notice: the same in the history and in the stream.
const finishedBubble = (text: string): Bubble => ({ role: "divider", blocks: [], kind: "completionNotice", ...finishedRow(text) });
// The card of an agent message (third kind, lib/agents-message.ts); `null` for any other text.
const messageBubble = (text: string): Bubble | null => {
  const message = messageCard(text);
  return message ? { role: "message", blocks: [], message } : null;
};

function startInjectedTurn(bubbles: Bubble[], st: StreamState, text: string, attachments: Attachment[], wfStatus: ReducerCtx["wfStatus"]): Bubble[] {
  // A completion notice (cause "agent") is no user row: the system line stands instead of the bubble, and it closes no
  // question. The same holds for an agent's message (cause "message"): its card instead of the bubble.
  const card = messageBubble(text);
  const system = card !== null || isCompletionNotice(text);
  Object.assign(st, { open: true, gotText: false });
  const copy = [...bubbles];
  const last = copy[copy.length - 1];
  if (last?.streaming) {
    if (!last.blocks.some((bl) => (bl.kind === "text" && bl.text.trim()) || bl.kind !== "text")) copy.pop();
    else copy[copy.length - 1] = { ...last, streaming: false };
  }
  const out = system ? copy : closeAsksOnUserText(copy, wfStatus);
  if (!system) out.push({ role: "user", blocks: [{ kind: "text", text }], attachments });
  else if (card) out.push(card);
  else if (!completionNoticeDuplicate(out[out.length - 1], text)) out.push(finishedBubble(text));
  out.push({ role: "assistant", blocks: [], streaming: true });
  return out;
}

// "Missing beginning": on connect the server sends along the text the RUNNING turn has streamed so far. Without it the bubble
// arose only with the next delta, and whoever joined mid-run never saw the start of the reply until the run ended. Only the
// HEAD the bubble lacks is added (`missingBeginning`), so the text then stands exactly once.
function seedStreamedText(bubbles: Bubble[], st: StreamState, server: string, truncated: boolean, t: ReducerCtx["t"]): Bubble[] {
  // The stream is open from here and has delivered text; otherwise the next delta would create a SECOND bubble.
  Object.assign(st, { open: true, gotText: true });
  // The server's buffer stopped at RUN_STREAM_MAX; what came after is missing between this text and the next delta. A cap must
  // say it is one; otherwise a truncated text cannot be told from a complete one, and the gap opens MID-sentence. Word for word
  // with iOS (ChatViewModel+Blocks.swift, takeOverStreamText).
  const withCap = truncated
    ? server + "\n\n" + t("… a piece is missing here: the running turn's buffer was full. The complete answer appears in the history once the run has finished.")
    : server;
  const copy = [...bubbles];
  const last = copy[copy.length - 1];
  if (!last || last.role !== "assistant" || onlyError(last)) {
    copy.push({ role: "assistant", blocks: [{ kind: "text", text: withCap }], streaming: true });
    return copy;
  }
  // The stored reply of this turn (chat opened mid-run, `openResponse`): the buffer is the text AFTER its last stored block; it
  // belongs in the same bubble, as after a reload, not in a second one beside it.
  if (!last.streaming) {
    copy[copy.length - 1] = { ...last, blocks: [...last.blocks, { kind: "text", text: withCap }], streaming: true, liveFrom: last.blocks.length };
    return copy;
  }
  const have = last.blocks.reduce((acc, bl) => (bl.kind === "text" ? acc + bl.text : acc), "");
  const header = missingBeginning(have, server);
  if (!header) return bubbles;
  const blocks = [...last.blocks];
  const i = blocks.findIndex((bl) => bl.kind === "text");
  if (i < 0) blocks.unshift({ kind: "text", text: header });
  else blocks[i] = { kind: "text", text: header + (blocks[i] as { kind: "text"; text: string }).text };
  copy[copy.length - 1] = { ...last, blocks };
  return copy;
}

function appendUserMessage(bubbles: Bubble[], text: string, attachments: Attachment[], wfStatus: ReducerCtx["wfStatus"]): Bubble[] {
  const card = messageBubble(text);
  if (card) return [...bubbles, card]; // card instead of bubble, closes no question (see startInjectedTurn)
  if (isCompletionNotice(text)) return completionNoticeDuplicate(bubbles[bubbles.length - 1], text) ? bubbles : [...bubbles, finishedBubble(text)]; // system line, see startInjectedTurn
  return [...closeAsksOnUserText(bubbles, wfStatus), { role: "user", blocks: [{ kind: "text", text }], attachments }];
}

// An open question card is clickable only as long as the user wrote nothing else; otherwise ignored cards would stay clickable
// for ever (and the server would reject the answer later). The server computes the same rule from the history (openAskOf).
const closeOpenAsks = (list: Bubble[]): Bubble[] =>
  list.some((b) => b.role === "ask" && b.ask?.answerable)
    ? list.map((b) => (b.role === "ask" && b.ask?.answerable ? { ...b, ask: { ...b.ask, answerable: false } } : b))
    : list;
// …EXCEPT during a workflow run: there the server holds the step on exactly this card, so an interim question by the user does
// not answer it. The card must stay clickable, otherwise the run waits for an answer nobody can give any more.
const closeAsksOnUserText = (list: Bubble[], status: ReducerCtx["wfStatus"]): Bubble[] => {
  return status === "running" || status === "waiting" ? list : closeOpenAsks(list);
};

// Push a question card into the history. The running assistant block is closed first so that following text (if any still
// comes) starts a new bubble and does not mutate into the card. (setStreamingText(false) → wrapper.)
function pushAsk(bubbles: Bubble[], st: StreamState, requestId: string, questions: AskQuestion[]): Bubble[] {
  Object.assign(st, { open: false, gotText: false });
  const copy = [...bubbles];
  const last = copy[copy.length - 1];
  if (last?.streaming) {
    if (!last.blocks.some((bl) => (bl.kind === "text" && bl.text.trim()) || bl.kind !== "text")) copy.pop();
    else copy[copy.length - 1] = { ...last, streaming: false };
  }
  // Avoid a duplicate card if the same question arrives by two routes (SSE + reload).
  if (copy.some((b) => b.role === "ask" && b.ask?.requestId === requestId)) return copy;
  return [...closeOpenAsks(copy), { role: "ask", blocks: [], ask: { requestId, questions, answerable: true } }];
}

// Push an approval card into the history: the same mechanics as pushAsk, so the live order matches the persisted one (the
// `approval` row stands between the assistant rows). While the card is OPEN and the ephemeral approval card stands above the
// input field (permReqs), the history card stays invisible; otherwise the same question would be on screen twice. With the
// ruling it becomes visible, in its place. (Without a requestId NOTHING happens, no setStreamingText(false) in the wrapper either.)
function pushApproval(bubbles: Bubble[], st: StreamState, card: ApprovalCardData): Bubble[] {
  if (!card.requestId) return bubbles;
  Object.assign(st, { open: false, gotText: false });
  const copy = [...bubbles];
  const last = copy[copy.length - 1];
  if (last?.streaming) {
    if (!last.blocks.some((bl) => (bl.kind === "text" && bl.text.trim()) || bl.kind !== "text")) copy.pop();
    else copy[copy.length - 1] = { ...last, streaming: false };
  }
  if (copy.some((b) => b.role === "approval" && b.approval?.requestId === card.requestId)) return copy;
  return [...copy, { role: "approval", blocks: [], approval: card }];
}
function markApprovalDecided(bubbles: Bubble[], requestId: string, ruling: ApprovalRuling | null): Bubble[] {
  return bubbles.map((b) => (
    b.role === "approval" && b.approval?.requestId === requestId ? { ...b, approval: { ...b.approval, ruling, open: ruling === null } } : b
  ));
}

// Push a capture card into the history: the same mechanics as pushAsk: the running assistant bubble is closed (following text
// starts a new one), so the live order matches the persisted one (capture row between the assistant rows).
function pushCapture(bubbles: Bubble[], st: StreamState, cap: CaptureMessage): Bubble[] {
  Object.assign(st, { open: false, gotText: false });
  const copy = [...bubbles];
  const last = copy[copy.length - 1];
  if (last?.streaming) {
    if (!last.blocks.some((bl) => (bl.kind === "text" && bl.text.trim()) || bl.kind !== "text")) copy.pop();
    else copy[copy.length - 1] = { ...last, streaming: false };
  }
  // Avoid a duplicate card (SSE + reload of the same event).
  if (copy.some((b) => b.role === "capture" && b.capture?.captureId === cap.captureId)) return copy;
  return [...copy, { role: "capture", blocks: [], capture: cap }];
}

const markAskAnswered = (bubbles: Bubble[], requestId: string, answers: AskAnswer[], overChannel: AskBubble["overChannel"] = null): Bubble[] =>
  bubbles.map((b) => (
    b.role === "ask" && b.ask?.requestId === requestId
      ? { ...b, ask: { ...b.ask, answers, answerable: false, overChannel } }
      : b
  ));
// A start or end marker of a dynamic workflow, live: like a capture card it closes the running bubble (text after it begins a
// new one; in the history the row stands in the same place between the replies), and the same marker twice (SSE + reload)
// stands once.
function pushMarker(bubbles: Bubble[], st: StreamState, marker: unknown): Bubble[] {
  const m = markerSeparator(marker);
  if (!m) return bubbles;
  Object.assign(st, { open: false, gotText: false });
  const copy = [...bubbles];
  const last = copy[copy.length - 1];
  if (last?.streaming) {
    if (!last.blocks.some((bl) => (bl.kind === "text" && bl.text.trim()) || bl.kind !== "text")) copy.pop();
    else copy[copy.length - 1] = { ...last, streaming: false };
  }
  if (copy.some((b) => b.kind === m.kind && b.marker?.runId === m.marker.runId)) return copy;
  return [...copy, m];
}

// Approval card of a dynamic workflow, live: the same mechanics as pushMarker: the running bubble closes, the same card twice
// (SSE + reload) stands once.
function pushWorkflowApproval(bubbles: Bubble[], st: StreamState, raw: unknown): Bubble[] {
  const k = readWorkflowApproval(raw);
  if (!k) return bubbles;
  Object.assign(st, { open: false, gotText: false });
  const copy = [...bubbles];
  const last = copy[copy.length - 1];
  if (last?.streaming) {
    if (!last.blocks.some((bl) => (bl.kind === "text" && bl.text.trim()) || bl.kind !== "text")) copy.pop();
    else copy[copy.length - 1] = { ...last, streaming: false };
  }
  if (copy.some((b) => b.role === "workflow_approval" && b.wfApproval?.requestId === k.requestId)) return copy;
  return [...copy, { role: "workflow_approval", blocks: [], wfApproval: k }];
}
// The ruling (from this or another client): the card follows; a second ruling changes nothing.
const markWorkflowApproval = (bubbles: Bubble[], requestId: string, decision: WorkflowDecision): Bubble[] =>
  bubbles.map((b) => (b.role === "workflow_approval" && b.wfApproval?.requestId === requestId && !b.wfApproval.decision
    ? { ...b, wfApproval: { ...b.wfApproval, decision } } : b));

// A channel card is pushed like a capture card; a duplicate (SSE + reload) is recognised by channel and number (`withChannelCard`).
function pushChannel(bubbles: Bubble[], st: StreamState, card: ChannelCardData): Bubble[] {
  Object.assign(st, { open: false, gotText: false });
  return withChannelCard(bubbles, card, () => ({ role: "channel", blocks: [], channel: card }));
}

// Apply a block transform to the last bubble: normally to the top-level blocks; with `parentId` set, to the children of the
// matching tool block (subagent activity). Content WITHOUT a parent belongs in the running bubble; content WITH a parent
// belongs to the subagent. Its call block is searched over ALL bubbles and all levels (`mutateUnderParent`, the same helper as
// for the results), and if it stands nowhere the content is DROPPED: "rather gone than in a foreign reply", since subagents
// have their own place.
function mutateBlocks(bubbles: Bubble[], st: StreamState, parentId: string | null | undefined, fn: (blocks: Block[]) => Block[]): Bubble[] {
  if (parentId) return mutateUnderParent(bubbles, parentId, fn);
  // Without a parent: into the running REPLY and only there. The last bubble can be a card (question, approval, channel,
  // separator, clear marker); it does not render `blocks` at all, and what was filed there would be invisible until a reload.
  // Better a fresh reply bubble: one bubble too many is seen, missing text is not.
  const i = bubbles.length - 1;
  if (i < 0 || bubbles[i].role !== "assistant") return [...bubbles, { role: "assistant", blocks: fn([]), streaming: st.open }];
  const copy = [...bubbles];
  copy[i] = { ...copy[i], blocks: fn(copy[i].blocks) };
  return copy;
}

function appendText(bubbles: Bubble[], st: StreamState, t: string, parentId?: string | null): Bubble[] {
  // Open an empty bubble ONLY for the main stream: a subagent's text must not begin a reply, and it is no "gotText" either;
  // otherwise the result fallback at turn end would swallow the main agent's closing text.
  if (!parentId) {
    if (!st.open) bubbles = openResponse(bubbles, st);
    st.gotText = true;
  }
  return mutateBlocks(bubbles, st, parentId, (blocks) => {
    const copy = [...blocks];
    const last = copy[copy.length - 1];
    if (last?.kind === "text") copy[copy.length - 1] = { kind: "text", text: last.text + t };
    else copy.push({ kind: "text", text: t });
    return copy;
  });
}

function appendThinking(bubbles: Bubble[], st: StreamState, t: string, parentId?: string | null): Bubble[] {
  if (!t) return bubbles;
  if (!parentId && !st.open) bubbles = openResponse(bubbles, st);
  return mutateBlocks(bubbles, st, parentId, (blocks) => {
    const copy = [...blocks];
    const last = copy[copy.length - 1];
    if (last?.kind === "thinking") copy[copy.length - 1] = { kind: "thinking", text: last.text + t };
    else copy.push({ kind: "thinking", text: t });
    return copy;
  });
}

function deriveDetail(input?: Record<string, unknown>) {
  if (!input) return "";
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.notebook_path ?? input.bash_id ?? input.shell_id ?? input.description ?? "";
  return v ? String(v).replace(/\s+/g, " ").slice(0, 100) : "";
}

// Create a tool call (every call its own row, needed to assign its result by tool_use_id). At streaming start usually still
// without input; upsertTool adds it.
function addTool(bubbles: Bubble[], st: StreamState, name: string, opts?: { id?: string; input?: Record<string, unknown>; parentId?: string | null }): Bubble[] {
  if (!opts?.parentId && !st.open) bubbles = openResponse(bubbles, st);
  return mutateBlocks(bubbles, st, opts?.parentId, (blocks) => [
    ...blocks,
    { kind: "tool" as const, id: opts?.id, name, detail: deriveDetail(opts?.input), count: 1, input: opts?.input },
  ]);
}

// Write the input into the tool block matching by id, or create the block if it is still missing (subagent tools appear only
// in the assistant event, without streaming start). Searched over ALL bubbles and levels (lib/tool-result.ts
// `applyToolInput`): between the start (content_block_start) and this event a bubble of its own can attach, which would
// create a second row.
function upsertTool(bubbles: Bubble[], st: StreamState, id: string | undefined, name: string, input: Record<string, unknown>, parentId?: string | null): Bubble[] {
  const detail = deriveDetail(input);
  if (id) {
    const appendedLater = applyToolInput(bubbles, id, input, detail);
    if (appendedLater !== bubbles) return appendedLater;
  }
  return mutateBlocks(bubbles, st, parentId, (blocks) => [...blocks, { kind: "tool" as const, id, name, detail, count: 1, input }]);
}

// Assign a result (tool_result) to the matching tool block: the helper searches backwards over all bubbles and all levels.
function setToolResult(bubbles: Bubble[], id: string, result: string, isError: boolean): Bubble[] {
  return applyToolResult(bubbles, id, result, isError);
}

// A row written OUTSIDE the own turn stream (event `row`): without it an open chat saw a `hint` row (subagent at the limit,
// dynamic workflow, graph background, instance switch …) only after the next load. Built like from the history
// (`buildBubbles`), so the same row as after a reload; appended only if it lies behind the own state and is not there yet
// (lib/history-reconcile.ts `appendRow`). If a reply is running, it stands BEFORE it: the stream keeps writing into the open
// bubble, and in the history the row also stands before what is stored afterwards.
function attachRow(bubbles: Bubble[], row: LogEntry | null | undefined, lastId: number): Bubble[] {
  if (!row || !appendRow(row, lastId, (id) => bubbles.some((b) => b.rowId === id))) return bubbles;
  const fresh = buildBubbles([row]).map((b) => { const k = { ...b, rowId: row.id }; rememberTime(k, row.ts); return k; });
  if (!fresh.length) return bubbles;
  const last = bubbles[bubbles.length - 1];
  if (last?.streaming) return [...bubbles.slice(0, -1), ...fresh, last];
  return [...bubbles, ...fresh];
}

// (setBusy(false) → wrapper, BEFORE the stream check as before.)
function finish(bubbles: Bubble[], st: StreamState): Bubble[] {
  if (!st.open) return bubbles;
  st.open = false;
  const copy = [...bubbles];
  const last = copy[copy.length - 1];
  if (last?.streaming) {
    if (!last.blocks.some((bl) => (bl.kind === "text" && bl.text.trim()) || bl.kind !== "text")) copy.pop();
    else copy[copy.length - 1] = { ...last, streaming: false };
  }
  return copy;
}

function addError(bubbles: Bubble[], text: string): Bubble[] {
  return [...bubbles, { role: "assistant", blocks: [{ kind: "error", text }] }];
}

// (setCtxTokens(0) → wrapper or ChatPane.applyClear.)
function applyClear(bubbles: Bubble[], at: number): Bubble[] {
  if (bubbles.some((b) => b.role === "clear" && b.clearedAt === at)) return bubbles;
  // An open question card closes too, as on reload (loader branch `clear`); during a workflow run the server rejects /clear
  // anyway, so the exception of closeAsksOnUserText never applies here.
  return [
    ...closeOpenAsks(bubbles).map((b) => ({ ...b, dimmed: true })),
    { role: "clear", blocks: [], label: "Chat cleared up to here", clearedAt: at },
  ];
}

// Attach the duration/token summary to the last finished reply (persisted and live the same).
function attachSummaryToLast(bubbles: Bubble[], summary: RunSummary): Bubble[] {
  if (!bubbles.length) return bubbles;
  const copy = [...bubbles];
  const last = copy[copy.length - 1];
  if (last.role === "assistant") copy[copy.length - 1] = { ...last, summary };
  return copy;
}

// The switch: `onEvent` without its side effects, in the same branch order; every branch that called setBubbles there stands
// here, the others are gone (their rest lives in the wrapper). Returns both because the stream state steers the bubbles
// (`streaming: st.open`); the two exports below each pull out one half.
function apply(bubbles: Bubble[], evt: ChatEvent, ctx: ReducerCtx): { bubbles: Bubble[]; stream: StreamState } {
  const st: StreamState = { ...ctx.stream };
  if (evt.type === "row") return { bubbles: attachRow(bubbles, evt.row, ctx.lastId ?? 0), stream: st };
  if (evt.type === "harness") {
    if (evt.subtype === "connected") {
      // The text the running turn has already streamed (see seedStreamedText). Only for a RUNNING turn: after the run end the
      // history stands complete in the DB anyway, and a supplement beside it would be a second place for the same answer. The
      // fields are `streamText` and `streamTextTruncated`, as the server sends them (chats/routes.js, "connected").
      if (evt.running && typeof evt.streamText === "string" && evt.streamText) {
        bubbles = seedStreamedText(bubbles, st, evt.streamText, evt.streamTextTruncated === true, ctx.t);
      }
    }
    else if (evt.subtype === "run_started") {
      bubbles = startAssistant(bubbles, st);
    } else if (evt.subtype === "run_done" || evt.subtype === "run_aborted") {
      const aborted = evt.subtype === "run_aborted";
      const summary: RunSummary | null = ctx.runStart
        ? { secs: Math.max(1, Math.round((ctx.now - ctx.runStart) / 1000)), inTok: ctx.inTok, outTok: ctx.outTok, aborted, at: ctx.now }
        : null;
      bubbles = finish(bubbles, st);
      const doneId = ctx.activeId;
      if (ctx.joined && doneId) {
        // Joined during the run: the live stream was incomplete; the wrapper reloads the history (reloadOpenChatLog, incl.
        // meta); so NO summary is attached here.
      } else {
        if (summary) bubbles = attachSummaryToLast(bubbles, summary);
      }
    } else if (evt.subtype === "run_error") {
      bubbles = addError(bubbles, ctx.t("Error (exit {code}):\n{stderr}", { code: evt.code ?? "?", stderr: String(evt.stderr) }));
      bubbles = finish(bubbles, st);
    } else if (evt.subtype === "compacted") {
      bubbles = [...bubbles, { role: "divider", blocks: [], label: evt.auto ? "Context compacted automatically" : "Context compacted" }];
    } else if (evt.subtype === "cleared") {
      bubbles = applyClear(bubbles, Number(evt.at) || ctx.now);
    } else if (evt.subtype === "permission_request") {
      // … and as a (still hidden) card into the history, in its place; with the ruling it becomes visible. So after a reload it
      // stands exactly where it is persisted.
      bubbles = pushApproval(bubbles, st, {
        requestId: String(evt.requestId || ""), toolName: String(evt.toolName || ""), server: "", tool: String(evt.toolName || ""),
        description: "", writing: null, input: (evt.input ?? {}) as Record<string, unknown>, at: Number(evt.at) || ctx.now,
        ruling: null, open: true, coding: true,
      });
    } else if (evt.subtype === "approval_ruling") {
      bubbles = markApprovalDecided(bubbles, String(evt.requestId || ""), {
        behavior: evt.behavior === "allow" ? "allow" : "deny", reason: String(evt.reason || ""), origin: String(evt.origin || "user"),
        updatedInput: (evt.updatedInput ?? null) as Record<string, unknown> | null, at: Number(evt.at) || ctx.now,
        ...(typeof evt.remember === "string" && evt.remember ? { remember: String(evt.remember) } : {}),
      });
    } else if (evt.subtype === "permission_resolved") {
      // Fallback: if no ruling with origin came, at least the outcome counts.
      bubbles = bubbles.map((b) => (
        b.role === "approval" && b.approval?.requestId === String(evt.requestId || "") && b.approval.open && !b.approval.ruling
          ? { ...b, approval: { ...b.approval, open: false, ruling: { behavior: evt.behavior === "allow" ? "allow" : "deny", reason: "", origin: "user", updatedInput: null, at: ctx.now } } }
          : b
      ));
    } else if (evt.subtype === "ask_request") {
      // Question with options → clickable card in the history.
      bubbles = pushAsk(bubbles, st, String(evt.requestId || ""), (evt.questions ?? []) as AskQuestion[]);
    } else if (evt.subtype === "ask_resolved") {
      // Also answered by ANOTHER client (phone): follow the card here at once.
      bubbles = markAskAnswered(bubbles, String(evt.requestId || ""), (evt.answers ?? []) as AskAnswer[], (evt.overChannel ?? null) as AskBubble["overChannel"]);
    } else if (evt.subtype === "channel_message") {
      // Message from a channel (sent or received) → card in the history.
      if (evt.card) bubbles = pushChannel(bubbles, st, evt.card as ChannelCardData);
    } else if (evt.subtype === "capture_message") {
      // Capture by an agent (shown at turn end) → card in the history.
      bubbles = pushCapture(bubbles, st, {
        captureId: String(evt.captureId || ""),
        kind: evt.kind === "recording" ? "recording" : "screenshot",
        caption: String(evt.caption || ""),
        poster: typeof evt.poster === "string" ? evt.poster : "poster.jpg",
        video: typeof evt.video === "string" ? evt.video : null,
        w: Number(evt.w) || 0, h: Number(evt.h) || 0,
        durationMs: Number(evt.durationMs) || 0,
        url: String(evt.url || ""), title: String(evt.title || ""),
        ...(evt.collapsed === true ? { collapsed: true } : {}),
      });
    } else if (evt.subtype === "message_injected") {
      // "Channel phantom": a delivery without a human utterance; the channel hands it into the running turn. A user bubble for
      // it would be an invented sentence in the history and would also cut the running reply into two bubbles. The server marks
      // such deliveries with `silent`.
      if (evt.silent !== true) bubbles = startInjectedTurn(bubbles, st, String(evt.text || ""), Array.isArray(evt.attachments) ? evt.attachments : [], ctx.wfStatus);
    } else if (evt.subtype === "user_message") {
      bubbles = appendUserMessage(bubbles, String(evt.text || ""), Array.isArray(evt.attachments) ? evt.attachments : [], ctx.wfStatus);
    } else if (evt.subtype === "goal_check") {
      // Verdict of the goal gate (arrives shortly after run_done) → row below the reply. Achieved = goal done (server cleared
      // it, indicator disappears); open with continuing = the harness continues the run automatically.
      bubbles = [...bubbles, {
        role: "goal", blocks: [], achieved: evt.achieved === true, label: String(evt.note || ""),
        turns: typeof evt.turns === "number" ? evt.turns : undefined,
        continuing: evt.continuing && evt.attempt != null ? `${evt.attempt}/${evt.max}` : undefined,
      }];
    } else if (evt.subtype === "monitor") {
      // Monitor lifecycle row (started/fired/ended), in the goal UI style.
      bubbles = [...bubbles, {
        role: "monitor", blocks: [], event: String(evt.event || ""),
        label: String(evt.description || ""), status: evt.status ? String(evt.status) : undefined,
      }];
    } else if (evt.subtype === "workflow_step") {
      // Row of the workflow driver (step head, branch verdict, question, end).
      bubbles = [...bubbles, { role: "workflow", blocks: [], wf: evt.line as WorkflowLine }];
    } else if (evt.subtype === "limit_line") {
      bubbles = [...bubbles, { role: "limit", blocks: [], limit: evt.line as LimitLine }];
    } else if (evt.subtype === "workflow_marker") {
      // Start or end marker of a dynamic workflow: the same row as from the history.
      bubbles = pushMarker(bubbles, st, evt.marker);
    } else if (evt.subtype === "workflow_approval") {
      // Approval card of a dynamic workflow: the same card as from the history.
      bubbles = pushWorkflowApproval(bubbles, st, evt.card);
    } else if (evt.subtype === "workflow_approval_decided") {
      const d = readWorkflowRuling(evt.ruling);
      if (d) bubbles = markWorkflowApproval(bubbles, d.requestId, d.decision);
    }
    return { bubbles, stream: st };
  }
  if (evt.type === "stream_event") {
    const ev = evt.event ?? {};
    // Subagent events carry the id of the parent task call; they are rendered indented there and NOT counted into the
    // context/token display.
    const parentId: string | null = evt.parent_tool_use_id ?? null;
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      bubbles = appendText(bubbles, st, ev.delta.text, parentId);
    } else if (ev.type === "content_block_delta" && ev.delta?.type === "thinking_delta") {
      bubbles = appendThinking(bubbles, st, ev.delta.thinking ?? "", parentId);
    } else if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
      bubbles = addTool(bubbles, st, ev.content_block.name, { id: ev.content_block.id, parentId });
    }
    return { bubbles, stream: st };
  }
  if (evt.type === "user") {
    // tool_result: assign the output to the matching tool call (by tool_use_id).
    for (const b of evt.message?.content ?? []) {
      if (b?.type === "tool_result" && b.tool_use_id) {
        bubbles = setToolResult(bubbles, b.tool_use_id, ctx.resultToText(b.content), Boolean(b.is_error));
      }
    }
    return { bubbles, stream: st };
  }
  if (evt.type === "assistant") {
    const parentId: string | null = evt.parent_tool_use_id ?? null;
    // Full assistant event: add tool input (or create subagent tools).
    for (const b of evt.message?.content ?? []) {
      if (b.type === "tool_use") bubbles = upsertTool(bubbles, st, b.id, b.name, (b.input ?? {}) as Record<string, unknown>, parentId);
    }
  }
  if (evt.type === "result" && st.open && !st.gotText && typeof evt.result === "string") {
    bubbles = appendText(bubbles, st, evt.result);
  }
  return { bubbles, stream: st };
}

// The bubbles after the event, pure: the same inputs, the same list (React may run the updater twice in StrictMode, the
// wrapper gives the same ctx for both runs). The time per bubble (lib/day-separator.ts) travels beside the bubbles in a WeakMap:
// new bubbles get the stream's clock, one replaced in the same place inherits its predecessor's; the bubbles themselves stay
// byte-identical (reducer anchor).
function reduceChatEvent(bubbles: Bubble[], evt: ChatEvent, ctx: ReducerCtx): Bubble[] {
  return passOnTimes(bubbles, apply(bubbles, evt, ctx).bubbles, ctx.now);
}
// The stream state after the event, independent of the bubbles (header comment, seam 2), so computed from the empty list;
// web/test/reducer.test.mjs holds that against `apply` at every event of the fixtures.
function streamAfterEvent(evt: ChatEvent, ctx: ReducerCtx): StreamState {
  return apply([], evt, ctx).stream;
}
// The mutators ChatPane calls OUTSIDE the stream pass the time per bubble on like `reduceChatEvent` (otherwise e.g. `/clear`,
// every bubble a dimmed copy, would lose all day separators until the next load). Without a clock (the module is pure): a NEW
// bubble from here (the error line) stays without a time and so belongs to its predecessor's day.
const withTime = <A extends unknown[]>(f: (b: Bubble[], ...a: A) => Bubble[]) => (b: Bubble[], ...a: A): Bubble[] => passOnTimes(b, f(b, ...a));
const addErrorZ = withTime(addError);
const applyClearZ = withTime(applyClear);
const markAskAnsweredZ = withTime(markAskAnswered);
const markApprovalDecidedZ = withTime(markApprovalDecided);
const markWorkflowApprovalZ = withTime(markWorkflowApproval);
export {
  addErrorZ as addError, applyClearZ as applyClear, buildBubbles, markAskAnsweredZ as markAskAnswered,
  markApprovalDecidedZ as markApprovalDecided, markWorkflowApprovalZ as markWorkflowApproval, reduceChatEvent, streamAfterEvent, apply,
};
export type { AskBubble, Bubble, ChatEvent, QueuedMessage, ReducerCtx, RunSummary, StreamState, WorkflowLine };
